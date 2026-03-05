import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionStateMachine } from './state-machine.js';
import type { ServerMessage } from '@myteacher/shared';

describe('SessionStateMachine', () => {
  let send: ReturnType<typeof vi.fn<(msg: ServerMessage) => void>>;
  let sm: SessionStateMachine;

  beforeEach(() => {
    send = vi.fn();
    sm = new SessionStateMachine(send);
  });

  // ── Initial state ──

  it('starts in idle state', () => {
    expect(sm.getState()).toBe('idle');
  });

  // ── Valid transitions ──

  describe('valid transitions', () => {
    it('idle → listening', () => {
      expect(sm.transition('listening')).toBe(true);
      expect(sm.getState()).toBe('listening');
    });

    it('listening → processing', () => {
      sm.transition('listening');
      expect(sm.transition('processing')).toBe(true);
      expect(sm.getState()).toBe('processing');
    });

    it('processing → speaking', () => {
      sm.transition('listening');
      sm.transition('processing');
      expect(sm.transition('speaking')).toBe(true);
      expect(sm.getState()).toBe('speaking');
    });

    it('speaking → listening', () => {
      sm.transition('listening');
      sm.transition('processing');
      sm.transition('speaking');
      expect(sm.transition('listening')).toBe(true);
      expect(sm.getState()).toBe('listening');
    });

    it('any state → idle', () => {
      sm.transition('listening');
      expect(sm.transition('idle')).toBe(true);
      expect(sm.getState()).toBe('idle');

      sm.transition('listening');
      sm.transition('processing');
      expect(sm.transition('idle')).toBe(true);
      expect(sm.getState()).toBe('idle');

      sm.transition('listening');
      sm.transition('processing');
      sm.transition('speaking');
      expect(sm.transition('idle')).toBe(true);
      expect(sm.getState()).toBe('idle');
    });

    it('idle → processing (for generate_lesson)', () => {
      expect(sm.transition('processing')).toBe(true);
      expect(sm.getState()).toBe('processing');
    });

    it('sends state_change message on valid transition', () => {
      sm.transition('listening');
      expect(send).toHaveBeenCalledWith({
        type: 'state_change',
        state: 'listening',
      });
    });
  });

  // ── Invalid transitions ──

  describe('invalid transitions', () => {

    it('idle → speaking', () => {
      expect(sm.transition('speaking')).toBe(false);
      expect(sm.getState()).toBe('idle');
    });

    it('listening → speaking', () => {
      sm.transition('listening');
      send.mockClear();
      expect(sm.transition('speaking')).toBe(false);
      expect(sm.getState()).toBe('listening');
    });

    it('processing → listening', () => {
      sm.transition('listening');
      sm.transition('processing');
      send.mockClear();
      expect(sm.transition('listening')).toBe(false);
      expect(sm.getState()).toBe('processing');
    });

    it('speaking → processing', () => {
      sm.transition('listening');
      sm.transition('processing');
      sm.transition('speaking');
      send.mockClear();
      expect(sm.transition('processing')).toBe(false);
      expect(sm.getState()).toBe('speaking');
    });

    it('does not send state_change on invalid transition', () => {
      send.mockClear();
      sm.transition('speaking'); // invalid from idle
      expect(send).not.toHaveBeenCalled();
    });
  });

  // ── bargeIn() ──

  describe('bargeIn()', () => {
    it('returns true and transitions to listening from speaking', () => {
      sm.transition('listening');
      sm.transition('processing');
      sm.transition('speaking');
      send.mockClear();

      expect(sm.bargeIn()).toBe(true);
      expect(sm.getState()).toBe('listening');
      expect(send).toHaveBeenCalledWith({
        type: 'state_change',
        state: 'listening',
      });
    });

    it('returns false from idle', () => {
      expect(sm.bargeIn()).toBe(false);
      expect(sm.getState()).toBe('idle');
    });

    it('returns false from listening', () => {
      sm.transition('listening');
      expect(sm.bargeIn()).toBe(false);
      expect(sm.getState()).toBe('listening');
    });

    it('returns false from processing', () => {
      sm.transition('listening');
      sm.transition('processing');
      expect(sm.bargeIn()).toBe(false);
      expect(sm.getState()).toBe('processing');
    });
  });

  // ── reset() ──

  describe('reset()', () => {
    it('returns to idle from any state', () => {
      sm.transition('listening');
      sm.transition('processing');
      sm.transition('speaking');
      send.mockClear();

      sm.reset();
      expect(sm.getState()).toBe('idle');
    });

    it('sends state_change with idle', () => {
      sm.transition('listening');
      send.mockClear();

      sm.reset();
      expect(send).toHaveBeenCalledWith({
        type: 'state_change',
        state: 'idle',
      });
    });
  });
});
