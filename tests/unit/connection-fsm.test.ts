// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { ConnectionFSM } from '../../src/background/connection-fsm.js';
import { IllegalTransitionError } from '../../src/core/errors.js';

describe('Connection Finite State Machine (ConnectionFSM)', () => {
  it('starts in UNPAIRED state by default', () => {
    const fsm = new ConnectionFSM();
    expect(fsm.getState()).toBe('UNPAIRED');
    expect(fsm.getRecord().state).toBe('UNPAIRED');
    expect(fsm.getRecord().reason).toBeDefined();
    expect(fsm.getRecord().timestamp).toBeDefined();
  });

  it('completes the full legal forward lifecycle: UNPAIRED -> PAIRING -> PAIRED_NO_PERMISSION -> PROBING -> SHADOW -> ACTIVE', () => {
    const fsm = new ConnectionFSM();

    // 1. UNPAIRED -> PAIRING
    fsm.transition('PAIRING', {
      reason: 'User submitted pairing code',
      connectionId: 'conn_123',
    });
    expect(fsm.getState()).toBe('PAIRING');

    // 2. PAIRING -> PAIRED_NO_PERMISSION
    fsm.transition('PAIRED_NO_PERMISSION', {
      reason: 'Pairing handshake successful, awaiting host permission',
      targetOrigin: 'http://localhost:4001',
    });
    expect(fsm.getState()).toBe('PAIRED_NO_PERMISSION');
    expect(fsm.getRecord().targetOrigin).toBe('http://localhost:4001');

    // 3. PAIRED_NO_PERMISSION -> PROBING
    fsm.transition('PROBING', {
      reason: 'User granted host permissions, initiating probe',
    });
    expect(fsm.getState()).toBe('PROBING');

    // 4. PROBING -> SHADOW
    fsm.transition('SHADOW', {
      reason: 'Probe passed; running observation shadow mode',
    });
    expect(fsm.getState()).toBe('SHADOW');

    // 5. SHADOW -> ACTIVE
    fsm.transition('ACTIVE', {
      reason: 'Shadow mode verified; entering fully active sync mode',
    });
    expect(fsm.getState()).toBe('ACTIVE');
  });

  it('fails closed when attempting illegal transitions directly', () => {
    const fsm = new ConnectionFSM();

    // Direct jump from UNPAIRED to ACTIVE must throw IllegalTransitionError
    expect(() =>
      fsm.transition('ACTIVE', { reason: 'Unauthorized jump' })
    ).toThrow(IllegalTransitionError);

    // Direct jump from UNPAIRED to PROBING must throw
    expect(() =>
      fsm.transition('PROBING', { reason: 'Unauthorized jump' })
    ).toThrow(IllegalTransitionError);

    // Direct jump from UNPAIRED to SHADOW must throw
    expect(() =>
      fsm.transition('SHADOW', { reason: 'Unauthorized jump' })
    ).toThrow(IllegalTransitionError);

    // State remains intact as UNPAIRED
    expect(fsm.getState()).toBe('UNPAIRED');
  });

  it('handles auxiliary/interrupt transitions from ACTIVE state', () => {
    const fsm = new ConnectionFSM({ state: 'ACTIVE', reason: 'Active test start' });

    // ACTIVE -> REAUTH_REQUIRED (401 session expiry)
    fsm.transition('REAUTH_REQUIRED', { reason: 'CMS returned 401 Unauthorized' });
    expect(fsm.getState()).toBe('REAUTH_REQUIRED');

    // REAUTH_REQUIRED -> ACTIVE (Staff re-authenticated)
    fsm.transition('ACTIVE', { reason: 'Staff re-authenticated successfully' });
    expect(fsm.getState()).toBe('ACTIVE');

    // ACTIVE -> DEGRADED (403 forbidden / schema drift)
    fsm.transition('DEGRADED', { reason: 'CMS returned 403 Forbidden on writes' });
    expect(fsm.getState()).toBe('DEGRADED');

    // DEGRADED -> PROBING (Retry probe)
    fsm.transition('PROBING', { reason: 'Retrying CMS diagnostic probe' });
    expect(fsm.getState()).toBe('PROBING');

    // PROBING -> SHADOW -> ACTIVE
    fsm.transition('SHADOW', { reason: 'Probe recovered' });
    fsm.transition('ACTIVE', { reason: 'Fully recovered' });

    // ACTIVE -> PAUSED
    fsm.transition('PAUSED', { reason: 'User toggled pause sync switch' });
    expect(fsm.getState()).toBe('PAUSED');

    // PAUSED -> ACTIVE
    fsm.transition('ACTIVE', { reason: 'User resumed sync' });
    expect(fsm.getState()).toBe('ACTIVE');

    // ACTIVE -> REVOKED
    fsm.transition('REVOKED', { reason: 'Installation revoked server-side' });
    expect(fsm.getState()).toBe('REVOKED');

    // REVOKED cannot jump to ACTIVE
    expect(() =>
      fsm.transition('ACTIVE', { reason: 'Illegal reactivation' })
    ).toThrow(IllegalTransitionError);

    // REVOKED -> UNPAIRED
    fsm.transition('UNPAIRED', { reason: 'Resetting after revocation' });
    expect(fsm.getState()).toBe('UNPAIRED');
  });

  it('requires a non-empty reason for every transition', () => {
    const fsm = new ConnectionFSM();
    expect(() => fsm.transition('PAIRING', { reason: '' })).toThrow(
      /non-empty reason/
    );
    expect(() => fsm.transition('PAIRING', { reason: '   ' })).toThrow(
      /non-empty reason/
    );
  });

  it('notifies registered transition listeners', () => {
    const fsm = new ConnectionFSM();
    const listener = vi.fn();
    const unsubscribe = fsm.onTransition(listener);

    fsm.transition('PAIRING', { reason: 'Starting pairing' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'PAIRING', reason: 'Starting pairing' }),
      expect.objectContaining({ state: 'UNPAIRED' })
    );

    unsubscribe();
    fsm.transition('UNPAIRED', { reason: 'Cancelled pairing' });
    expect(listener).toHaveBeenCalledTimes(1); // Not called after unsubscribe
  });

  it('updates metadata and notifies listeners without state transition', () => {
    const fsm = new ConnectionFSM();
    const listener = vi.fn();
    fsm.onTransition(listener);

    const updated = fsm.updateMetadata({ lastReadAt: '2026-09-21T10:00:00.000Z' });
    expect(updated.metadata?.lastReadAt).toBe('2026-09-21T10:00:00.000Z');
    expect(fsm.getRecord().metadata?.lastReadAt).toBe('2026-09-21T10:00:00.000Z');
    expect(listener).toHaveBeenCalledWith(updated, updated);
  });

  it('serializes to JSON and restores from JSON correctly', () => {
    const original = new ConnectionFSM();
    original.transition('PAIRING', {
      reason: 'Pairing start',
      connectionId: 'conn_777',
      installationId: 'inst_888',
    });

    const serialized = original.toJSON();
    const restored = ConnectionFSM.fromJSON(serialized);

    expect(restored.getState()).toBe('PAIRING');
    expect(restored.getRecord().connectionId).toBe('conn_777');
    expect(restored.getRecord().installationId).toBe('inst_888');
  });

  it('handles runtime host permission revocation by transitioning from ACTIVE to PAIRED_NO_PERMISSION', () => {
    const fsm = new ConnectionFSM({
      state: 'ACTIVE',
      reason: 'Active session',
      targetOrigin: 'http://localhost:4001',
      connectionId: 'conn_active_1',
    });

    // User revokes origin in Chrome settings -> move to PAIRED_NO_PERMISSION
    fsm.transition('PAIRED_NO_PERMISSION', {
      reason: 'Host permission revoked at runtime in chrome://extensions',
    });

    expect(fsm.getState()).toBe('PAIRED_NO_PERMISSION');
    expect(fsm.getRecord().connectionId).toBe('conn_active_1');
    expect(fsm.getRecord().targetOrigin).toBe('http://localhost:4001');

    // Regranting permissions triggers PROBING again
    fsm.transition('PROBING', { reason: 'Host permission regranted by user' });
    expect(fsm.getState()).toBe('PROBING');
  });

  it('clears stale connection credentials and target origin upon unpairing reset', () => {
    const fsm = new ConnectionFSM({
      state: 'ACTIVE',
      reason: 'Active session',
      targetOrigin: 'http://localhost:4001',
      connectionId: 'conn_stale_1',
      installationId: 'inst_stale_1',
    });

    // Unpair device
    fsm.transition('UNPAIRED', { reason: 'User uncoupled device profile' });

    expect(fsm.getState()).toBe('UNPAIRED');
    expect(fsm.getRecord().connectionId).toBeUndefined();
    expect(fsm.getRecord().installationId).toBeUndefined();
    expect(fsm.getRecord().targetOrigin).toBeUndefined();
  });
});
