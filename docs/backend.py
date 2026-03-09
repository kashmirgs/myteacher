from __future__ import annotations

import asyncio
import re
import time
import json
import os
import uuid
from dataclasses import dataclass, field

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
import anthropic
from cartesia import AsyncCartesia
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
CARTESIA_API_KEY = os.getenv("CARTESIA_API_KEY")
CARTESIA_VOICE_ID = os.getenv("CARTESIA_VOICE_ID", "f9836c6e-a0bd-460e-9d3c-f7299fa60f94")
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "")

SYSTEM_PROMPT = (
    "Türkçe matematik öğretmenisin. Kurallar: "
    "1) Markdown, başlık, madde işareti, kalın/italik, emoji KULLANMA. "
    "2) Sadece düz metin yaz. "
    "3) Her cümleyi nokta ile bitir. "
    "4) Hemen konuya gir, giriş cümlesi yapma."
)

BOARD_SYSTEM_PROMPT = (
    "Sen Türkçe matematik öğretmenisin. Kullanıcının sorusunu tahtaya yazarak anlat.\n"
    "Yanıtını SADECE aşağıdaki JSON formatında ver, başka hiçbir şey yazma:\n"
    "{\n"
    '  "items": [\n'
    '    {"type": "title", "text": "Başlık metni", "speech": "Sesli anlatım metni"},\n'
    '    {"type": "text", "text": "Tahta metni", "speech": "Sesli anlatım metni"},\n'
    '    {"type": "step", "text": "Adım metni", "speech": "Sesli anlatım metni"},\n'
    '    {"type": "formula", "text": "x = 5", "speech": "Sesli anlatım metni"},\n'
    '    {"type": "highlight", "text": "Önemli not", "speech": "Sesli anlatım metni"}\n'
    "  ]\n"
    "}\n\n"
    "Kurallar:\n"
    "- 5-10 arası item üret\n"
    "- type: title, text, step, formula, highlight olabilir\n"
    "- text: tahtaya yazılacak kısa metin\n"
    "- speech: o item için sesli anlatım (1-2 cümle, doğal konuşma dili)\n"
    "- İlk item her zaman title olsun\n"
    "- Formüller formula tipinde olsun\n"
    "- Önemli noktalar highlight tipinde olsun\n"
    "- JSON dışında hiçbir şey yazma, açıklama ekleme\n"
)

CLAUSE_BREAKS = re.compile(r'[,;:.]')
CLAUSE_MIN_LEN = 40

CARTESIA_OUTPUT_FORMAT = {
    "container": "raw",
    "encoding": "pcm_f32le",
    "sample_rate": 24000,
}

# Pre-warmed clients
claude_client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
cartesia_client = AsyncCartesia(api_key=CARTESIA_API_KEY)

# Pre-warmed Cartesia WebSocket
_cartesia_ws = None
_cartesia_ws_lock = asyncio.Lock()


async def get_cartesia_ws():
    global _cartesia_ws
    async with _cartesia_ws_lock:
        if _cartesia_ws is None:
            mgr = cartesia_client.tts.websocket_connect()
            _cartesia_ws = await mgr.__aenter__()
        return _cartesia_ws


async def reconnect_cartesia_ws():
    global _cartesia_ws
    async with _cartesia_ws_lock:
        try:
            if _cartesia_ws:
                await _cartesia_ws.close()
        except Exception:
            pass
        _cartesia_ws = None
        mgr = cartesia_client.tts.websocket_connect()
        _cartesia_ws = await mgr.__aenter__()
        return _cartesia_ws


@app.on_event("startup")
async def startup():
    try:
        await get_cartesia_ws()
        print("Cartesia WebSocket pre-warmed")
    except Exception as e:
        print(f"Cartesia WebSocket pre-warm failed (will retry lazily): {e}")


@app.on_event("shutdown")
async def shutdown():
    global _cartesia_ws
    if _cartesia_ws:
        await _cartesia_ws.close()
    await cartesia_client.close()


def extract_clause(buffer: str) -> tuple[str | None, str]:
    nl = buffer.find('\n')
    if nl != -1:
        clause = buffer[:nl].strip()
        rest = buffer[nl + 1:]
        return (clause, rest) if clause else (None, rest)

    m = CLAUSE_BREAKS.search(buffer)
    if m:
        idx = m.end()
        clause = buffer[:idx].strip()
        rest = buffer[idx:].lstrip()
        return (clause, rest) if clause else (None, rest)

    if len(buffer) >= CLAUSE_MIN_LEN:
        last_space = buffer.rfind(' ', 0, len(buffer))
        if last_space > 10:
            clause = buffer[:last_space].strip()
            rest = buffer[last_space + 1:]
            return (clause, rest) if clause else (None, rest)

    return None, buffer


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()

    try:
        while True:
            data = await ws.receive_text()
            msg = json.loads(data)
            user_text = msg.get("text", "").strip()
            if not user_text:
                continue

            t0 = time.perf_counter()

            t1_first_token = None
            t2_first_clause = None
            t3_first_audio = None

            clauses: list[str] = []
            buffer = ""

            clause_queue: asyncio.Queue[str | None] = asyncio.Queue()

            context_id = str(uuid.uuid4())
            cartesia_ws = await get_cartesia_ws()

            ctx = cartesia_ws.context(
                context_id=context_id,
                model_id="sonic-3",
                voice={"mode": "id", "id": CARTESIA_VOICE_ID},
                output_format=CARTESIA_OUTPUT_FORMAT,
                language="tr",
            )

            async def claude_stream():
                nonlocal t1_first_token, t2_first_clause, buffer

                async with claude_client.messages.stream(
                    model="claude-haiku-4-5-20251001",
                    max_tokens=1024,
                    system=SYSTEM_PROMPT,
                    messages=[{"role": "user", "content": user_text}],
                ) as stream:
                    async for text in stream.text_stream:
                        if t1_first_token is None:
                            t1_first_token = time.perf_counter()

                        buffer += text

                        while True:
                            clause, buffer = extract_clause(buffer)
                            if clause is None:
                                break
                            if t2_first_clause is None:
                                t2_first_clause = time.perf_counter()
                            clauses.append(clause)
                            await clause_queue.put(clause)

                remaining = buffer.strip()
                if remaining:
                    if t2_first_clause is None:
                        t2_first_clause = time.perf_counter()
                    clauses.append(remaining)
                    await clause_queue.put(remaining)

                await clause_queue.put(None)

            async def cartesia_sender():
                """Read clauses from queue and push to Cartesia via continuation."""
                while True:
                    clause = await clause_queue.get()
                    if clause is None:
                        await ctx.no_more_inputs()
                        break

                    await ws.send_text(
                        json.dumps({"type": "sentence", "text": clause})
                    )
                    await ctx.push(clause + " ", speed="slow")

            async def cartesia_receiver():
                """Receive audio from Cartesia and forward to browser."""
                nonlocal t3_first_audio

                async for event in ctx.receive():
                    if hasattr(event, 'audio') and event.audio:
                        if t3_first_audio is None:
                            t3_first_audio = time.perf_counter()
                        await ws.send_bytes(event.audio)

            try:
                await asyncio.gather(
                    claude_stream(),
                    cartesia_sender(),
                    cartesia_receiver(),
                )
            except Exception as e:
                await ws.send_text(
                    json.dumps({"type": "error", "text": f"Pipeline error: {str(e)}"})
                )
                try:
                    await reconnect_cartesia_ws()
                except Exception:
                    pass

            t_end = time.perf_counter()

            def ms(t):
                return round((t - t0) * 1000) if t else None

            metrics = {
                "type": "metrics",
                "t0": round(t0 * 1000),
                "t1_first_token_ms": ms(t1_first_token),
                "t2_first_sentence_ms": ms(t2_first_clause),
                "t3_first_audio_ms": ms(t3_first_audio),
                "t_total_ms": ms(t3_first_audio),
                "sentences_count": len(clauses),
                "total_duration_ms": round((t_end - t0) * 1000),
                "tts_provider": "cartesia_sonic3",
            }

            await ws.send_text(json.dumps(metrics))

    except WebSocketDisconnect:
        pass


SPEED_MAP = {"slow": "slow", "normal": "normal", "fast": "fast"}

# Sonic-3 generation_config.speed [0.6, 1.5] — %10 yavaşlatılmış
SPEED_CONFIG = {"slow": 0.7, "normal": 0.9, "fast": 1.1}


@app.websocket("/ws/test2")
async def websocket_test2(ws: WebSocket):
    await ws.accept()

    try:
        while True:
            data = await ws.receive_text()
            msg = json.loads(data)
            user_text = msg.get("text", "").strip()
            speed_param = SPEED_MAP.get(msg.get("speed", "normal"), "slow")
            if not user_text:
                continue

            t0 = time.perf_counter()

            # 1) Non-streaming LLM call for structured board plan
            try:
                response = await claude_client.messages.create(
                    model="claude-haiku-4-5-20251001",
                    max_tokens=2048,
                    system=BOARD_SYSTEM_PROMPT,
                    messages=[{"role": "user", "content": user_text}],
                )
                raw_text = response.content[0].text.strip()
                # Strip markdown code fences if present
                if raw_text.startswith("```"):
                    raw_text = re.sub(r"^```(?:json)?\s*", "", raw_text)
                    raw_text = re.sub(r"\s*```$", "", raw_text)
                board = json.loads(raw_text)
                items = board.get("items", [])
            except Exception as e:
                await ws.send_text(json.dumps({
                    "type": "error",
                    "text": f"LLM/parse error: {str(e)}",
                }))
                continue

            t_llm = time.perf_counter()
            t_llm_ms = round((t_llm - t0) * 1000)

            await ws.send_text(json.dumps({
                "type": "board_plan",
                "items_count": len(items),
                "t_llm_ms": t_llm_ms,
            }))

            # 2) Process board items with single TTS context for voice continuity
            total_audio_bytes = 0
            item_metrics = []

            context_id = str(uuid.uuid4())
            cartesia_ws = await get_cartesia_ws()

            try:
                ctx = cartesia_ws.context(
                    context_id=context_id,
                    model_id="sonic-3",
                    voice={"mode": "id", "id": CARTESIA_VOICE_ID},
                    output_format=CARTESIA_OUTPUT_FORMAT,
                    language="tr",
                )

                # Shared state between sender and receiver
                flush_event = asyncio.Event()
                flush_audio_bytes = 0
                receiver_done = asyncio.Event()

                async def tts_receiver():
                    nonlocal flush_audio_bytes
                    async for event in ctx.receive():
                        if event.type == "chunk" and event.audio:
                            await ws.send_bytes(event.audio)
                            flush_audio_bytes += len(event.audio)
                        elif event.type == "flush_done":
                            flush_event.set()
                        elif event.type == "done":
                            break
                    receiver_done.set()

                receiver_task = asyncio.create_task(tts_receiver())

                for i, item in enumerate(items):
                    # Send board item to frontend
                    await ws.send_text(json.dumps({
                        "type": "board_item",
                        "item": item,
                        "index": i,
                        "timestamp": round((time.perf_counter() - t0) * 1000),
                    }))

                    speech = item.get("speech", "")
                    if not speech:
                        item_metrics.append({
                            "index": i,
                            "type": item.get("type", "text"),
                            "audio_duration_ms": 0,
                        })
                        await ws.send_text(json.dumps({
                            "type": "item_complete",
                            "index": i,
                            "audio_duration_ms": 0,
                        }))
                        continue

                    # Reset flush state for this item
                    flush_event.clear()
                    flush_audio_bytes = 0

                    # Push speech, then flush to mark item boundary
                    await ctx.push(speech + " ", speed=speed_param)
                    await ctx.push("", flush=True)

                    # Wait for flush_done from receiver
                    await flush_event.wait()

                    # PCM f32le @ 24kHz → 4 bytes per sample, 24000 samples/sec
                    audio_duration_ms = round(flush_audio_bytes / 96000 * 1000)
                    total_audio_bytes += flush_audio_bytes

                    item_metrics.append({
                        "index": i,
                        "type": item.get("type", "text"),
                        "audio_duration_ms": audio_duration_ms,
                    })

                    await ws.send_text(json.dumps({
                        "type": "item_complete",
                        "index": i,
                        "audio_duration_ms": audio_duration_ms,
                    }))

                # Signal no more inputs and wait for receiver to finish
                await ctx.no_more_inputs()
                await receiver_done.wait()
                receiver_task.result()  # propagate any exception

            except Exception as e:
                await ws.send_text(json.dumps({
                    "type": "error",
                    "text": f"TTS error: {str(e)}",
                }))
                try:
                    await reconnect_cartesia_ws()
                except Exception:
                    pass

            # 3) Final metrics
            t_end = time.perf_counter()
            total_duration_ms = round((t_end - t0) * 1000)
            total_audio_duration_ms = round(total_audio_bytes / 96000 * 1000)

            await ws.send_text(json.dumps({
                "type": "metrics",
                "t0": round(t0 * 1000),
                "t_llm_ms": t_llm_ms,
                "total_items": len(items),
                "total_duration_ms": total_duration_ms,
                "total_audio_duration_ms": total_audio_duration_ms,
                "item_metrics": item_metrics,
            }))

    except WebSocketDisconnect:
        pass


# ─── Test 3: Barge-in ───

RESPOND_SYSTEM_PROMPT = (
    "Sen Türkçe matematik öğretmenisin. Tahtada ders anlatıyorsun.\n"
    "Öğrenci araya girip soru sordu. Tahtadaki bağlamı ve soruyu dikkate alarak kısa ve net yanıt ver.\n"
    "Kurallar:\n"
    "- Sadece düz metin yaz, markdown kullanma\n"
    "- 1-3 cümle ile yanıt ver\n"
    "- Konuşma dilinde ol\n"
)


@app.get("/api/deepgram-token")
async def deepgram_token():
    return {"key": DEEPGRAM_API_KEY}


@dataclass
class TeachingSession:
    ws: WebSocket
    state: str = "IDLE"  # IDLE, TEACHING, INTERRUPTING, LISTENING, RESPONDING
    items: list = field(default_factory=list)
    current_item_index: int = 0
    conversation_history: list = field(default_factory=list)
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    lesson_task: asyncio.Task | None = None
    responding_task: asyncio.Task | None = None
    current_context_id: str | None = None
    speed: float = 0.7
    t0: float = 0.0


async def set_state(session: TeachingSession, new_state: str):
    old = session.state
    session.state = new_state
    await session.ws.send_text(json.dumps({
        "type": "state_change",
        "old": old,
        "new": new_state,
        "timestamp": round((time.perf_counter() - session.t0) * 1000),
    }))


async def _tts_speak_inner(session: TeachingSession, text: str, msg_type: str = "audio"):
    """TTS with per-context cancellation support. Returns total audio bytes sent."""
    for attempt in range(2):  # max 1 retry
        try:
            cartesia_ws = await get_cartesia_ws()
            context_id = str(uuid.uuid4())
            session.current_context_id = context_id

            ctx = cartesia_ws.context(
                context_id=context_id,
                model_id="sonic-3",
                voice={"mode": "id", "id": CARTESIA_VOICE_ID},
                output_format=CARTESIA_OUTPUT_FORMAT,
                language="tr",
            )

            await ctx.push(text + " ", generation_config={"speed": session.speed})
            await ctx.no_more_inputs()

            total_bytes = 0
            async for event in ctx.receive():
                if session.cancel_event.is_set():
                    break
                if hasattr(event, 'audio') and event.audio:
                    await session.ws.send_bytes(event.audio)
                    total_bytes += len(event.audio)
                elif event.type == "done":
                    break

            session.current_context_id = None
            return total_bytes

        except asyncio.CancelledError:
            session.current_context_id = None
            try:
                await reconnect_cartesia_ws()
            except Exception:
                pass
            raise
        except Exception as e:
            session.current_context_id = None
            print(f"tts_speak error (attempt {attempt + 1}): {e}")
            if attempt == 0:
                try:
                    await reconnect_cartesia_ws()
                except Exception:
                    pass
                continue
            return 0  # 2nd attempt failed — no audio, lesson continues


TTS_TIMEOUT = 30


async def tts_speak(session: TeachingSession, text: str, msg_type: str = "audio"):
    """Timeout wrapper around _tts_speak_inner to prevent hangs."""
    try:
        return await asyncio.wait_for(
            _tts_speak_inner(session, text, msg_type), timeout=TTS_TIMEOUT
        )
    except asyncio.TimeoutError:
        print(f"tts_speak timed out after {TTS_TIMEOUT}s")
        session.current_context_id = None
        try:
            await reconnect_cartesia_ws()
        except Exception:
            pass
        return 0


async def run_lesson(session: TeachingSession):
    """Run the lesson from current_item_index, sending each item with TTS."""
    try:
        while session.current_item_index < len(session.items):
            if session.cancel_event.is_set():
                return

            i = session.current_item_index
            item = session.items[i]

            await session.ws.send_text(json.dumps({
                "type": "board_item_start",
                "item": item,
                "index": i,
                "timestamp": round((time.perf_counter() - session.t0) * 1000),
            }))

            speech = item.get("speech", "")
            audio_bytes = 0
            if speech and not session.cancel_event.is_set():
                audio_bytes = await tts_speak(session, speech)

            if session.cancel_event.is_set():
                return

            audio_duration_ms = round(audio_bytes / 96000 * 1000) if audio_bytes > 0 else 0

            await session.ws.send_text(json.dumps({
                "type": "board_item_complete",
                "index": i,
                "audio_duration_ms": audio_duration_ms,
                "timestamp": round((time.perf_counter() - session.t0) * 1000),
            }))

            session.current_item_index += 1

        # Lesson complete
        await set_state(session, "IDLE")
        await session.ws.send_text(json.dumps({
            "type": "lesson_complete",
            "timestamp": round((time.perf_counter() - session.t0) * 1000),
        }))

    except asyncio.CancelledError:
        return
    except Exception as e:
        print(f"run_lesson error: {e}")
        try:
            await session.ws.send_text(json.dumps({
                "type": "error",
                "text": f"Lesson error: {str(e)}",
            }))
        except Exception:
            pass


async def handle_interrupt(session: TeachingSession, rollback_to_index=None):
    """Cancel current lesson playback."""
    interrupted_at = session.current_item_index

    # Frontend reported undisplayed items — rollback so they get resent on resume
    if rollback_to_index is not None and 0 <= rollback_to_index <= session.current_item_index:
        session.current_item_index = rollback_to_index

    # Signal cancellation
    session.cancel_event.set()

    # Send ack IMMEDIATELY — don't wait for task cleanup
    await session.ws.send_text(json.dumps({
        "type": "interrupt_ack",
        "interrupted_at_index": interrupted_at,
        "timestamp": round((time.perf_counter() - session.t0) * 1000),
    }))
    await set_state(session, "LISTENING")

    # Now clean up tasks (no longer blocking ack)
    if session.lesson_task and not session.lesson_task.done():
        session.lesson_task.cancel()
        try:
            await session.lesson_task
        except (asyncio.CancelledError, Exception):
            pass
    session.lesson_task = None

    if session.responding_task and not session.responding_task.done():
        session.responding_task.cancel()
        try:
            await session.responding_task
        except (asyncio.CancelledError, Exception):
            pass
    session.responding_task = None
    session.current_context_id = None


async def handle_student_input(session: TeachingSession, transcript: str):
    """Process student question: LLM response + TTS, then resume lesson."""
    try:
        session.cancel_event.clear()
        await set_state(session, "RESPONDING")

        # Build context from board items so far
        board_context = ""
        for i, item in enumerate(session.items[:session.current_item_index + 1]):
            board_context += f"[{item.get('type', 'text')}] {item.get('text', '')}\n"

        session.conversation_history.append({"role": "user", "content": transcript})

        messages = [
            {"role": "user", "content": (
                f"Tahtadaki ders içeriği:\n{board_context}\n\n"
                f"Öğrenci sorusu: {transcript}"
            )}
        ]

        t_llm_start = time.perf_counter()

        try:
            response = await claude_client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=512,
                system=RESPOND_SYSTEM_PROMPT,
                messages=messages,
            )
            ai_text = response.content[0].text.strip()
        except Exception as e:
            ai_text = f"Bir hata oluştu: {str(e)}"

        t_llm_ms = round((time.perf_counter() - t_llm_start) * 1000)

        session.conversation_history.append({"role": "assistant", "content": ai_text})

        await session.ws.send_text(json.dumps({
            "type": "ai_response_start",
            "text": ai_text,
            "llm_ms": t_llm_ms,
            "timestamp": round((time.perf_counter() - session.t0) * 1000),
        }))

        # TTS the response (cancellable)
        audio_bytes = 0
        if not session.cancel_event.is_set():
            audio_bytes = await tts_speak(session, ai_text)

        if session.cancel_event.is_set():
            # Student interrupted the response too — go back to listening
            return

        if session.state != "RESPONDING":
            return

        audio_duration_ms = round(audio_bytes / 96000 * 1000) if audio_bytes > 0 else 0

        await session.ws.send_text(json.dumps({
            "type": "ai_response_complete",
            "audio_duration_ms": audio_duration_ms,
            "timestamp": round((time.perf_counter() - session.t0) * 1000),
        }))

        # Resume lesson from where we left off
        await resume_lesson(session)

    except asyncio.CancelledError:
        return
    finally:
        session.responding_task = None


async def resume_lesson(session: TeachingSession):
    """Resume the lesson from the next item."""
    session.cancel_event.clear()
    await set_state(session, "TEACHING")

    session.lesson_task = asyncio.create_task(run_lesson(session))


@app.websocket("/ws/test3")
async def websocket_test3(ws: WebSocket):
    await ws.accept()

    session = TeachingSession(ws=ws)

    try:
        while True:
            data = await ws.receive_text()
            msg = json.loads(data)
            msg_type = msg.get("type", "")

            if msg_type == "start_lesson":
                user_text = msg.get("text", "").strip()
                session.speed = SPEED_CONFIG.get(msg.get("speed", "normal"), 0.7)
                session.t0 = time.perf_counter()
                session.current_item_index = 0
                session.cancel_event.clear()
                session.conversation_history = []

                # LLM: generate board plan
                try:
                    response = await claude_client.messages.create(
                        model="claude-haiku-4-5-20251001",
                        max_tokens=2048,
                        system=BOARD_SYSTEM_PROMPT,
                        messages=[{"role": "user", "content": user_text}],
                    )
                    raw_text = response.content[0].text.strip()
                    if raw_text.startswith("```"):
                        raw_text = re.sub(r"^```(?:json)?\s*", "", raw_text)
                        raw_text = re.sub(r"\s*```$", "", raw_text)
                    board = json.loads(raw_text)
                    session.items = board.get("items", [])
                except Exception as e:
                    await ws.send_text(json.dumps({
                        "type": "error",
                        "text": f"LLM/parse error: {str(e)}",
                    }))
                    continue

                t_llm_ms = round((time.perf_counter() - session.t0) * 1000)

                await ws.send_text(json.dumps({
                    "type": "board_plan",
                    "items": session.items,
                    "items_count": len(session.items),
                    "t_llm_ms": t_llm_ms,
                }))

                await set_state(session, "TEACHING")
                session.lesson_task = asyncio.create_task(run_lesson(session))

            elif msg_type == "interrupt":
                print(f"[WS] interrupt received. session.state={session.state}")
                if session.state in ("TEACHING", "RESPONDING", "IDLE"):
                    rollback = msg.get("rollback_to_index")
                    print(f"[WS] calling handle_interrupt, rollback={rollback}")
                    await handle_interrupt(session, rollback_to_index=rollback)
                    print(f"[WS] handle_interrupt done. session.state={session.state}")
                else:
                    print(f"[WS] interrupt IGNORED — state not in accepted list")

            elif msg_type == "student_transcript":
                transcript = msg.get("text", "").strip()
                print(f"[WS] student_transcript received. state={session.state}, text={transcript!r}")
                if transcript and session.state in ("LISTENING", "IDLE"):
                    if session.responding_task and not session.responding_task.done():
                        print("Ignoring duplicate student_transcript")
                    else:
                        # If state is IDLE (interrupt ack missed), manually transition
                        if session.state == "IDLE":
                            await set_state(session, "LISTENING")
                        session.responding_task = asyncio.create_task(handle_student_input(session, transcript))

            elif msg_type == "set_speed":
                session.speed = SPEED_CONFIG.get(msg.get("speed", "normal"), 0.7)

            elif msg_type == "silence_timeout":
                print(f"[WS] silence_timeout received. state={session.state}")
                # Student was silent after interrupt — resume lesson
                if session.state in ("LISTENING", "IDLE"):
                    await resume_lesson(session)

    except WebSocketDisconnect:
        if session.lesson_task and not session.lesson_task.done():
            session.lesson_task.cancel()
    except Exception as e:
        print(f"websocket_test3 FATAL error: {e}")
        import traceback
        traceback.print_exc()
        if session.lesson_task and not session.lesson_task.done():
            session.lesson_task.cancel()


# ─── Test 4: LLM Structured Output helpers ───


async def _call_llm_for_board(topic: str) -> tuple[str, list | None, str | None]:
    """Call LLM for board plan JSON. Returns (raw_text, items_or_None, error_or_None)."""
    try:
        response = await claude_client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=2048,
            system=BOARD_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": topic}],
        )
        raw_text = response.content[0].text.strip()
        clean = raw_text
        if clean.startswith("```"):
            clean = re.sub(r"^```(?:json)?\s*", "", clean)
            clean = re.sub(r"\s*```$", "", clean)
        board = json.loads(clean)
        items = board.get("items", [])
        return raw_text, items, None
    except json.JSONDecodeError as e:
        return raw_text, None, f"JSON parse error: {e}"
    except Exception as e:
        return "", None, str(e)


@app.post("/api/test4/generate")
async def test4_generate(request: Request):
    body = await request.json()
    topic = body.get("topic", "").strip()
    if not topic:
        return JSONResponse({"success": False, "error": "topic is required"}, status_code=400)

    t0 = time.perf_counter()
    retried = False

    raw_text, items, error = await _call_llm_for_board(topic)

    # One retry on failure
    if error is not None:
        retried = True
        raw_text, items, error = await _call_llm_for_board(topic)

    llm_ms = round((time.perf_counter() - t0) * 1000)

    if error is not None:
        return JSONResponse({"success": False, "error": error, "llm_ms": llm_ms, "retried": retried})

    type_set = set(it.get("type", "") for it in items)

    return JSONResponse({
        "success": True,
        "items": items,
        "item_count": len(items),
        "type_diversity": len(type_set),
        "llm_ms": llm_ms,
        "retried": retried,
    })


# ─── Test 5: Annotation + Context helpers ───

ANNOTATE_SYSTEM_PROMPT = (
    "Sen Türkçe matematik öğretmenisin. Tahtada ders anlatıyorsun.\n"
    "Öğrenci tahtadaki bir elemana tıklayıp soru sordu.\n"
    "İşaretlenen elemanı dikkate alarak kısa ve net yanıt ver.\n"
    "Kurallar:\n"
    "- Sadece düz metin yaz, markdown kullanma\n"
    "- 1-3 cümle ile yanıt ver\n"
    "- Konuşma dilinde ol\n"
    "- İşaretlenen elemana odaklan, onu açıkla\n"
    "- Yanıtında tıklanan elemanın içindeki ifadeyi (formül, sayı, terim) aynen tekrarla\n"
    "- Sayıları rakamla yaz (beş değil 5, on iki değil 12)\n"
)


@app.post("/api/test5/ask")
async def test5_ask(request: Request):
    body = await request.json()
    items = body.get("items", [])
    clicked_index = body.get("clicked_index")
    question = (body.get("question") or "").strip() or "Bu ne demek?"

    if not items:
        return JSONResponse({"success": False, "error": "items is required"}, status_code=400)
    if clicked_index is None or not (0 <= clicked_index < len(items)):
        return JSONResponse({"success": False, "error": "clicked_index out of range"}, status_code=400)

    # Build context string
    TYPE_LABELS = {"title": "başlık", "text": "metin", "step": "adım", "formula": "formül", "highlight": "önemli"}
    lines = ["Tahtada şunlar yazıyor:"]
    for i, it in enumerate(items):
        label = TYPE_LABELS.get(it.get("type", ""), it.get("type", ""))
        marker = "  ← ÖĞRENCİ BUNU İŞARETLEDİ" if i == clicked_index else ""
        lines.append(f"[{i}] {it.get('text', '')} ({label}){marker}")
    lines.append("")
    lines.append(f"Öğrenci {clicked_index} numaralı elemana tıklayıp sordu: '{question}'")
    lines.append("Kısa ve net açıkla.")
    context = "\n".join(lines)

    t0 = time.perf_counter()
    try:
        response = await claude_client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=512,
            system=ANNOTATE_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": context}],
        )
        ai_text = response.content[0].text.strip()
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)})

    llm_ms = round((time.perf_counter() - t0) * 1000)

    return JSONResponse({
        "success": True,
        "response": ai_text,
        "clicked_index": clicked_index,
        "clicked_item": items[clicked_index],
        "llm_ms": llm_ms,
    })


os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    return FileResponse("static/index.html")
