import type { SessionState, ServerMessage } from '@myteacher/shared';

type SendFn = (msg: ServerMessage) => void;

const VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
  idle: ['listening'],
  listening: ['processing', 'idle'],
  processing: ['speaking', 'idle'],
  speaking: ['listening', 'idle'],
};

export class SessionStateMachine {
  private state: SessionState = 'idle';
  private send: SendFn;

  constructor(send: SendFn) {
    this.send = send;
  }

  getState(): SessionState {
    return this.state;
  }

  transition(next: SessionState): boolean {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed.includes(next)) {
      console.warn(`[state] invalid transition: ${this.state} → ${next}`);
      return false;
    }
    console.log(`[state] ${this.state} → ${next}`);
    this.state = next;
    this.send({ type: 'state_change', state: this.state });
    return true;
  }

  /** Barge-in: from speaking → listening (cancels TTS/LLM) */
  bargeIn(): boolean {
    if (this.state !== 'speaking') {
      console.warn(`[state] barge-in ignored in state: ${this.state}`);
      return false;
    }
    return this.transition('listening');
  }

  reset(): void {
    this.state = 'idle';
    this.send({ type: 'state_change', state: 'idle' });
  }
}
