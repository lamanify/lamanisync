// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { CommandFSM } from '../../src/core/command-fsm.js';
import { IllegalTransitionError, FencingTokenError } from '../../src/core/errors.js';

describe('Command Finite State Machine (CommandFSM)', () => {
  const baseCommand = {
    commandId: 'CMD-TEST-001',
    action: 'CREATE_APPOINTMENT',
    parameters: { patientId: 'P1', providerId: 'DOC-01' },
  };

  it('completes the full happy path lifecycle: PENDING -> LEASED -> EXECUTING -> VERIFYING -> VERIFIED', () => {
    const fsm = new CommandFSM(baseCommand);
    expect(fsm.getState()).toBe('PENDING');

    // 1. PENDING -> LEASED
    fsm.lease(1);
    expect(fsm.getState()).toBe('LEASED');
    expect(fsm.getFencingToken()).toBe(1);

    // 2. LEASED -> EXECUTING
    fsm.startExecuting();
    expect(fsm.getState()).toBe('EXECUTING');

    // 3. EXECUTING -> VERIFYING
    fsm.startVerifying();
    expect(fsm.getState()).toBe('VERIFYING');

    // 4. VERIFYING -> VERIFIED
    const result = fsm.markVerified({
      externalId: 'APT-001',
      revision: 1,
      verifiedAt: new Date().toISOString(),
    });

    expect(fsm.getState()).toBe('VERIFIED');
    expect(result.status).toBe('VERIFIED');
    expect(result.writeReceipt?.externalId).toBe('APT-001');

    // Terminal: no further transitions allowed
    expect(() => fsm.lease(2)).toThrow(IllegalTransitionError);
  });

  it('enforces strictly monotonic fencing tokens on lease operations', () => {
    const fsm = new CommandFSM(baseCommand, { fencingToken: 5 });

    // Re-leasing with higher token succeeds
    fsm.lease(6);
    expect(fsm.getFencingToken()).toBe(6);

    // Executing
    fsm.startExecuting();
    fsm.markRetryable('Temporary network drop');
    fsm.requeue();

    // Attempting lease with stale token (< 6) throws FencingTokenError
    expect(() => fsm.lease(4)).toThrow(FencingTokenError);

    // Attempting lease with equal token (= 6) ALSO throws FencingTokenError (fencing concurrency protection)
    expect(() => fsm.lease(6)).toThrow(FencingTokenError);

    // Leasing with strictly greater token succeeds
    fsm.lease(7);
    expect(fsm.getFencingToken()).toBe(7);
  });

  it('handles CONFLICT branch and enters terminal state', () => {
    const fsm = new CommandFSM(baseCommand);
    fsm.lease(1);
    fsm.startExecuting();

    const result = fsm.markConflict('Revision mismatch: expected 1, got 2');
    expect(fsm.getState()).toBe('CONFLICT');
    expect(result.status).toBe('CONFLICT');

    // CONFLICT is terminal
    expect(() => fsm.startVerifying()).toThrow(IllegalTransitionError);
  });

  it('handles retry limits and falls back to TERMINAL_FAILURE after maxRetries', () => {
    const fsm = new CommandFSM(baseCommand, { maxRetries: 2 });
    fsm.lease(1);
    fsm.startExecuting();

    // Retry 1
    const res1 = fsm.markRetryable('503 Service Unavailable');
    expect(res1.status).toBe('RETRYABLE');
    expect(fsm.getState()).toBe('RETRYABLE');
    expect(fsm.getRetryCount()).toBe(1);

    // Requeue & lease again
    fsm.requeue();
    expect(fsm.getState()).toBe('PENDING');
    fsm.lease(2);
    fsm.startExecuting();

    // Retry 2
    const res2 = fsm.markRetryable('503 Service Unavailable again');
    expect(res2.status).toBe('RETRYABLE');
    expect(fsm.getRetryCount()).toBe(2);

    fsm.requeue();
    fsm.lease(3);
    fsm.startExecuting();

    // Retry 3 (exceeds maxRetries = 2) -> automatically transitions to TERMINAL_FAILURE!
    const res3 = fsm.markRetryable('503 Service Unavailable third time');
    expect(res3.status).toBe('TERMINAL_FAILURE');
    expect(fsm.getState()).toBe('TERMINAL_FAILURE');
    expect(res3.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining('Max retries') })
    );

    // Terminal state cannot be requeued
    expect(() => fsm.requeue()).toThrow(IllegalTransitionError);
  });

  it('fails closed on illegal state skips', () => {
    const fsm = new CommandFSM(baseCommand);

    // Cannot jump from PENDING to VERIFIED
    expect(() =>
      fsm.markVerified({
        externalId: 'APT-001',
        revision: 1,
        verifiedAt: new Date().toISOString(),
      })
    ).toThrow(IllegalTransitionError);

    // Cannot jump from PENDING to EXECUTING without LEASED
    expect(() => fsm.startExecuting()).toThrow(IllegalTransitionError);
  });

  it('serializes to JSON and restores via fromJSON with preserved retry count and state', () => {
    const original = new CommandFSM(baseCommand, { maxRetries: 3 });
    original.lease(10);
    original.startExecuting();
    original.markRetryable('Server 502 bad gateway');

    const json = original.toJSON();
    expect(json.retryCount).toBe(1);
    expect(json.state).toBe('RETRYABLE');

    const restored = CommandFSM.fromJSON(json);
    expect(restored.getState()).toBe('RETRYABLE');
    expect(restored.getRetryCount()).toBe(1);
    expect(restored.getFencingToken()).toBe(10);
    expect(restored.getFailureReason()).toBe('Server 502 bad gateway');

    // Continuing with restored instance honors remaining retries
    restored.requeue();
    restored.lease(11);
    restored.startExecuting();
    restored.markRetryable('Server 502 again');
    expect(restored.getRetryCount()).toBe(2);
  });
});
