import { bench, describe, vi } from 'vitest';
import { SessionStateMachine } from './state-machine.js';

describe('SessionStateMachine', () => {
  bench('single transition (idle → listening)', () => {
    const sm = new SessionStateMachine(vi.fn());
    sm.transition('listening');
  });

  bench('full cycle (idle → listening → processing → speaking → listening)', () => {
    const sm = new SessionStateMachine(vi.fn());
    sm.transition('listening');
    sm.transition('processing');
    sm.transition('speaking');
    sm.transition('listening');
  });

  bench('bargeIn() from speaking', () => {
    const sm = new SessionStateMachine(vi.fn());
    sm.transition('listening');
    sm.transition('processing');
    sm.transition('speaking');
    sm.bargeIn();
  });

  bench('reset() from speaking', () => {
    const sm = new SessionStateMachine(vi.fn());
    sm.transition('listening');
    sm.transition('processing');
    sm.transition('speaking');
    sm.reset();
  });

  bench('invalid transition rejection', () => {
    const sm = new SessionStateMachine(vi.fn());
    sm.transition('processing'); // idle → processing is invalid
  });
});
