import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { TEST_PUBLIC_KEY, signManifest } from '../fixtures/signing-keys.js';

function createInitialSyncState() {
  return {
    installations: new Map(),
    leases: new Map(),
    fencingCounter: 0,
    events: [],
    probeResults: new Map(),
    diagnostics: [],
    outbox: [
      {
        commandId: 'CMD-TEST-001',
        connectionId: 'conn_mock_67890',
        actionId: 'CREATE_APPOINTMENT',
        payload: {
          patientId: 'ZZTEST-P01',
          providerId: 'DOC-01',
          serviceId: 'SRV-01',
          locationId: 'LOC-01',
          startTime: '2026-10-02T14:00:00+08:00',
          endTime: '2026-10-02T14:15:00+08:00',
          notes: 'Sync API dispatched booking',
        },
        status: 'PENDING',
        createdAt: '2026-09-20T12:00:00Z',
      },
    ],
    /** @type {any[]} */
    receipts: [],
    seenNonces: new Map(),
    killSwitch: {
      global: { paused: false, reason: '' },
      adapters: new Map(),
      connections: new Map(),
    },
    batches: new Map(),
    receiptsByCommand: new Map(),
  };
}

export class MockSyncApiServer {
  /**
   * @param {number} [port]
   * @param {string|null} [targetCmsOrigin]
   */
  constructor(port = 4002, targetCmsOrigin = null) {
    this.port = port;
    this.targetCmsOrigin = targetCmsOrigin;
    this.server = null;
    this.state = createInitialSyncState();
    const manifestPath = path.resolve('test-harness/fixtures/adapter-manifest.json');
    this.adapterManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const pulsePath = path.resolve('src/adapters/manifests/lamanipulse.json');
    this.pulseManifest = fs.existsSync(pulsePath)
      ? JSON.parse(fs.readFileSync(pulsePath, 'utf-8'))
      : null;
    this.publicKey = TEST_PUBLIC_KEY;
  }

  reset() {
    this.state = createInitialSyncState();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.on('error', reject);
      this.server.listen(this.port, () => {
        console.log(`[Mock Sync API] Running at http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  async handleRequest(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-device-signature, x-correlation-id, x-device-timestamp, x-device-nonce'
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const host = req.headers.host || `localhost:${this.port}`;
    const parsedUrl = new URL(req.url, `http://${host}`);
    const pathname = parsedUrl.pathname;

    try {
      const body = await this.readJsonBody(req);

      // --- Admin Endpoints ---
      if (pathname === '/__admin/reset' && req.method === 'POST') {
        this.reset();
        return this.sendJson(res, 200, { status: 'ok', message: 'Sync API state reset' });
      }

      if (pathname === '/__admin/outbox' && req.method === 'POST') {
        const cmd = {
          commandId: `CMD-TEST-${Date.now()}`,
          connectionId: body.connectionId || 'conn_mock_67890',
          actionId: body.actionId || 'CREATE_APPOINTMENT',
          payload: body.payload || {},
          status: 'PENDING',
          createdAt: new Date().toISOString(),
        };
        this.state.outbox.push(cmd);
        return this.sendJson(res, 201, { status: 'ok', command: cmd });
      }

      if (pathname === '/__admin/health' && req.method === 'GET') {
        return this.sendJson(res, 200, { status: 'ok', service: 'mock-sync-api', port: this.port });
      }

      if (pathname === '/__admin/kill-switch' && req.method === 'POST') {
        const { level, paused, targetId, reason } = body;
        if (level === 'global') {
          this.state.killSwitch.global.paused = Boolean(paused);
          this.state.killSwitch.global.reason = reason || '';
        } else if (level === 'adapter' && targetId) {
          if (paused) {
            this.state.killSwitch.adapters.set(targetId, reason || '');
          } else {
            this.state.killSwitch.adapters.delete(targetId);
          }
        } else if (level === 'connection' && targetId) {
          if (paused) {
            this.state.killSwitch.connections.set(targetId, reason || '');
          } else {
            this.state.killSwitch.connections.delete(targetId);
          }
        }
        return this.sendJson(res, 200, {
          status: 'ok',
          level,
          paused: Boolean(paused),
          targetId,
        });
      }

      // --- Replay Protection & Drift Verification ---
      if (pathname.startsWith('/v1/sync/') && pathname !== '/v1/sync/public-key') {
        const timestampHeader = req.headers['x-device-timestamp'];
        const nonceHeader = req.headers['x-device-nonce'];

        if (timestampHeader) {
          const timestampMs = new Date(timestampHeader).getTime();
          if (!Number.isNaN(timestampMs)) {
            const driftMs = Math.abs(Date.now() - timestampMs);
            if (driftMs > 60_000) {
              return this.sendJson(res, 401, {
                error: 'CLOCK_DRIFT_EXCEEDED',
                message: `Request timestamp drift exceeds 60 seconds tolerance (${Math.round(driftMs / 1000)}s)`,
              });
            }
          }
        }

        if (nonceHeader) {
          const nowMs = Date.now();
          if (this.state.seenNonces.has(nonceHeader)) {
            return this.sendJson(res, 401, {
              error: 'NONCE_REPLAY_DETECTED',
              message: `Nonce '${nonceHeader}' has already been processed (replay attack detected)`,
            });
          }
          // Prune nonces older than 120 seconds
          const cutoff = nowMs - 120_000;
          for (const [key, seenAt] of this.state.seenNonces.entries()) {
            if (seenAt < cutoff) {
              this.state.seenNonces.delete(key);
            }
          }
          this.state.seenNonces.set(nonceHeader, nowMs);
        }
      }

      // --- Remote Kill-Switch Enforcer ---
      if (pathname.startsWith('/v1/sync/') && pathname !== '/v1/sync/public-key') {
        // 1. Global Kill-Switch
        if (this.state.killSwitch.global.paused) {
          return this.sendJson(res, 403, {
            error: 'PAUSED',
            status: 'PAUSED',
            killSwitchLevel: 'global',
            message: this.state.killSwitch.global.reason || 'Service globally paused remotely',
          });
        }

        // 2. Connection Kill-Switch
        const connIdMatch = pathname.match(/\/connections\/([^/]+)/);
        const queryConnId = parsedUrl.searchParams.get('connectionId');
        const connId = (connIdMatch ? connIdMatch[1] : null) || queryConnId || body.connectionId;
        if (connId && this.state.killSwitch.connections.has(connId)) {
          return this.sendJson(res, 403, {
            error: 'PAUSED',
            status: 'PAUSED',
            killSwitchLevel: 'connection',
            targetId: connId,
            message: this.state.killSwitch.connections.get(connId) || `Connection '${connId}' paused remotely`,
          });
        }

        // 3. Adapter Kill-Switch
        const adapterId = req.headers['x-adapter-id'] || body.adapterId;
        if (adapterId && this.state.killSwitch.adapters.has(adapterId)) {
          return this.sendJson(res, 403, {
            error: 'PAUSED',
            status: 'PAUSED',
            killSwitchLevel: 'adapter',
            targetId: adapterId,
            message: this.state.killSwitch.adapters.get(adapterId) || `Adapter '${adapterId}' paused remotely`,
          });
        }
      }

      // --- Installations & Pairing ---
      if (pathname === '/v1/sync/installations/pair' && req.method === 'POST') {
        if (!body.pairingCode || !body.clientPublicKey) {
          return this.sendJson(res, 400, {
            error: 'BAD_REQUEST',
            message: 'pairingCode and clientPublicKey are required',
          });
        }

        if (body.pairingCode === 'EXPIRED') {
          return this.sendJson(res, 400, {
            error: 'PAIRING_CODE_EXPIRED',
            message: 'The pairing code has expired',
          });
        }

        const installationId = `inst_mock_${Date.now()}`;
        const connectionId = 'conn_mock_67890';
        const sessionToken = `stk_mock_${Date.now()}`;
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

        const isPulse =
          (body.pairingCode && (body.pairingCode.toUpperCase().includes('PULSE') || body.pairingCode.toUpperCase().startsWith('SYNC-'))) ||
          process.env.CMS_ORIGIN === 'https://app.lamanipulse.com';

        const targetOrigin = this.targetCmsOrigin
          ? this.targetCmsOrigin
          : isPulse
            ? 'https://app.lamanipulse.com'
            : 'http://localhost:4001';

        const installation = {
          installationId,
          connectionId,
          clinicId: 'CLN-001',
          clientPublicKey: body.clientPublicKey,
          deviceName: body.deviceName || 'Chrome Dev Profile',
          sessionToken,
          expiresAt,
          targetOrigin,
          pairedAt: new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(),
        };

        this.state.installations.set(installationId, installation);
        console.log(`[Mock Sync API] Paired code='${body.pairingCode}' -> targetOrigin='${targetOrigin}'`);

        return this.sendJson(res, 200, {
          installationId,
          connectionId,
          clinicId: 'CLN-001',
          sessionToken,
          expiresAt,
          targetOrigin,
        });
      }

      if (pathname === '/v1/sync/installations/heartbeat' && req.method === 'POST') {
        const { installationId } = body;
        if (!installationId || !this.state.installations.has(installationId)) {
          return this.sendJson(res, 401, {
            error: 'UNAUTHORIZED',
            message: 'Unknown or unauthenticated installation',
          });
        }

        const inst = this.state.installations.get(installationId);
        inst.lastHeartbeat = new Date().toISOString();
        inst.extensionVersion = body.version || inst.extensionVersion;

        return this.sendJson(res, 200, {
          status: 'ok',
          serverTime: new Date().toISOString(),
        });
      }

      if (pathname === '/v1/sync/installations/revoke' && req.method === 'POST') {
        const { installationId } = body;
        if (installationId) {
          this.state.installations.delete(installationId);
        }
        return this.sendJson(res, 200, { status: 'revoked' });
      }

      // --- Session Token Renewal (Phase 10) ---
      if ((pathname === '/v1/sync/tokens/renew' || pathname === '/v1/sync/session/renew') && req.method === 'POST') {
        const { installationId } = body;
        if (!installationId || !this.state.installations.has(installationId)) {
          return this.sendJson(res, 401, {
            error: 'UNAUTHORIZED',
            message: 'Unknown or unauthenticated installation',
          });
        }

        const inst = this.state.installations.get(installationId);
        const sessionToken = `stk_mock_${Date.now()}`;
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        inst.sessionToken = sessionToken;
        inst.expiresAt = expiresAt;

        return this.sendJson(res, 200, {
          status: 'ok',
          sessionToken,
          expiresAt,
        });
      }

      // --- Public Key Endpoint ---
      if (pathname === '/v1/sync/public-key' && req.method === 'GET') {
        return this.sendJson(res, 200, { publicKey: this.publicKey });
      }

      // --- Adapter Manifest Distribution (Variants Supported) ---
      if (pathname.startsWith('/v1/sync/connections/') && pathname.endsWith('/adapter') && req.method === 'GET') {
        const variant = parsedUrl.searchParams.get('variant') || req.headers['x-adapter-variant'] || 'valid';
        const targetOriginParam = parsedUrl.searchParams.get('targetOrigin');
        const parts = pathname.split('/');
        const connectionId = parts[parts.length - 2];
        const isPulse =
          targetOriginParam === 'https://app.lamanipulse.com' ||
          Array.from(this.state.installations.values()).some(
            (inst) => inst.connectionId === connectionId && inst.targetOrigin === 'https://app.lamanipulse.com'
          );

        const baseManifest = isPulse && this.pulseManifest ? this.pulseManifest : this.adapterManifest;
        const manifest = JSON.parse(JSON.stringify(baseManifest));
        if (targetOriginParam) {
          manifest.targetOrigin = targetOriginParam;
        }

        if (variant === 'tampered') {
          manifest.signature = 'corrupted_ed25519_signature_tampered';
        } else if (variant === 'unsigned') {
          delete manifest.signature;
        } else if (variant === 'unknown_primitive') {
          manifest.capabilities.push('__UNKNOWN_DANGEROUS_EVAL__');
          manifest.signature = signManifest(manifest);
        } else if (variant === 'invalid_schema') {
          delete manifest.adapterId;
          delete manifest.targetOrigin;
          manifest.signature = signManifest(manifest);
        } else {
          // Default: valid Ed25519 signature
          manifest.signature = signManifest(manifest);
        }

        return this.sendJson(res, 200, manifest);
      }

      // --- Probe Result Recording ---
      if (pathname.startsWith('/v1/sync/connections/') && pathname.endsWith('/probe-result') && req.method === 'POST') {
        const parts = pathname.split('/');
        const connectionId = parts[parts.length - 2];
        const probeRecord = {
          connectionId,
          installationId: body.installationId,
          capabilities: body.capabilities || [],
          cmsVersion: body.cmsVersion || 'unknown',
          passed: Boolean(body.passed),
          details: body.details || {},
          recordedAt: new Date().toISOString(),
        };
        this.state.probeResults.set(connectionId, probeRecord);
        return this.sendJson(res, 200, {
          status: 'ok',
          connectionId,
          recordedAt: probeRecord.recordedAt,
        });
      }

      // --- Diagnostics Logging ---
      if (pathname === '/v1/sync/diagnostics' && req.method === 'POST') {
        const diagnostic = {
          id: `diag_${Date.now()}`,
          installationId: body.installationId || 'anonymous',
          correlationId: body.correlationId || null,
          errorType: body.errorType || 'UNSPECIFIED',
          redactedDetails: body.redactedDetails || {},
          receivedAt: new Date().toISOString(),
        };
        this.state.diagnostics.push(diagnostic);
        return this.sendJson(res, 200, {
          status: 'recorded',
          diagnosticId: diagnostic.id,
          receivedAt: diagnostic.receivedAt,
        });
      }

      // --- Event Batch Ingestion ---
      if (pathname === '/v1/sync/events/batch' && req.method === 'POST') {
        const batchId = body.batchId || `batch_${Date.now()}`;
        if (this.state.batches.has(batchId)) {
          return this.sendJson(res, 200, this.state.batches.get(batchId));
        }

        const events = body.events || [];
        this.state.events.push(...events);

        const responsePayload = {
          acknowledged: true,
          batchId,
          processedCount: events.length,
          checkpoint: `chk_${Date.now()}`,
        };
        this.state.batches.set(batchId, responsePayload);

        return this.sendJson(res, 200, responsePayload);
      }

      // --- Reconciliation Summary Endpoint (Phase 7) ---
      if (pathname.startsWith('/v1/sync/connections/') && pathname.endsWith('/reconcile-summary') && req.method === 'GET') {
        const parts = pathname.split('/');
        const connectionId = parts[parts.length - 2];
        const patientEvents = this.state.events.filter((e) => e.entityType === 'patient');
        const appointmentEvents = this.state.events.filter((e) => e.entityType === 'appointment');
        const entityRevisions = {};
        for (const e of this.state.events) {
          if (e.entityId) {
            entityRevisions[e.entityId] = Math.max(entityRevisions[e.entityId] || 0, e.revision || 1);
          }
        }

        return this.sendJson(res, 200, {
          connectionId,
          totalEvents: this.state.events.length,
          entityCounts: {
            patient: new Set(patientEvents.map((e) => e.entityId)).size,
            appointment: new Set(appointmentEvents.map((e) => e.entityId)).size,
          },
          knownEntityIds: {
            patient: Array.from(new Set(patientEvents.map((e) => e.entityId))),
            appointment: Array.from(new Set(appointmentEvents.map((e) => e.entityId))),
          },
          entityRevisions,
        });
      }

      // --- Leader Lease Coordination with Fencing Token ---
      if (pathname === '/v1/sync/leases/acquire' && req.method === 'POST') {
        const { connectionId, installationId, durationSeconds = 30 } = body;
        if (!connectionId || !installationId) {
          return this.sendJson(res, 400, {
            error: 'BAD_REQUEST',
            message: 'connectionId and installationId are required',
          });
        }

        const currentLease = this.state.leases.get(connectionId);
        const now = Date.now();

        if (currentLease && currentLease.expiresAtMs > now && currentLease.installationId !== installationId) {
          return this.sendJson(res, 409, {
            status: 'DENIED',
            error: 'LEASE_CONFLICT',
            message: 'Another installation holds the active leader lease',
            currentHolder: currentLease.installationId,
            expiresAt: new Date(currentLease.expiresAtMs).toISOString(),
          });
        }

        this.state.fencingCounter += 1;
        const fencingToken = this.state.fencingCounter;
        const leaseId = `lease_${connectionId}_${fencingToken}`;
        const expiresAtMs = now + durationSeconds * 1000;

        const newLease = {
          leaseId,
          fencingToken,
          installationId,
          connectionId,
          expiresAtMs,
        };

        this.state.leases.set(connectionId, newLease);

        return this.sendJson(res, 200, {
          status: 'GRANTED',
          leaseId,
          fencingToken,
          expiresAt: new Date(expiresAtMs).toISOString(),
        });
      }

      if (pathname === '/v1/sync/leases/renew' && req.method === 'POST') {
        const { connectionId, leaseId, fencingToken, installationId, durationSeconds = 30 } = body;
        const currentLease = this.state.leases.get(connectionId);

        if (
          !currentLease ||
          currentLease.leaseId !== leaseId ||
          currentLease.fencingToken !== fencingToken ||
          currentLease.installationId !== installationId
        ) {
          return this.sendJson(res, 409, {
            status: 'EXPIRED',
            error: 'LEASE_LOST',
            message: 'Lease expired or token invalid',
          });
        }

        currentLease.expiresAtMs = Date.now() + durationSeconds * 1000;

        return this.sendJson(res, 200, {
          status: 'RENEWED',
          leaseId,
          fencingToken,
          expiresAt: new Date(currentLease.expiresAtMs).toISOString(),
        });
      }

      if (pathname === '/v1/sync/leases/release' && req.method === 'POST') {
        const { connectionId, leaseId } = body;
        const currentLease = this.state.leases.get(connectionId);
        if (currentLease && currentLease.leaseId === leaseId) {
          this.state.leases.delete(connectionId);
        }
        return this.sendJson(res, 200, { status: 'RELEASED' });
      }

      // --- Outbox & Command Verification ---
      if (pathname === '/v1/sync/outbox/next' && req.method === 'GET') {
        const connectionId = parsedUrl.searchParams.get('connectionId') || 'conn_mock_67890';
        const pending = this.state.outbox.find(
          (cmd) => cmd.connectionId === connectionId && cmd.status === 'PENDING',
        );

        if (!pending) {
          return this.sendJson(res, 200, { command: null });
        }

        pending.status = 'LEASED';
        return this.sendJson(res, 200, { command: pending });
      }

      if (pathname.startsWith('/v1/sync/outbox/') && pathname.endsWith('/result') && req.method === 'POST') {
        const parts = pathname.split('/');
        const commandId = parts[parts.length - 2];
        const cmd = this.state.outbox.find((c) => c.commandId === commandId);

        const normalizedStatus = (body.status === 'SUCCESS' || body.status === 'VERIFIED') ? 'VERIFIED' : (body.status || 'FAILED');

        const receipt = {
          commandId,
          status: normalizedStatus,
          writeReceipt: body.writeReceipt || null,
          error: body.error || null,
          recordedAt: new Date().toISOString(),
        };

        if (cmd) {
          cmd.status = normalizedStatus;
          cmd.result = receipt;
        }

        this.state.receiptsByCommand.set(commandId, receipt);
        const existingIdx = this.state.receipts.findIndex((r) => r.commandId === commandId);
        if (existingIdx >= 0) {
          this.state.receipts[existingIdx] = receipt;
        } else {
          this.state.receipts.push(receipt);
        }

        return this.sendJson(res, 200, {
          acknowledged: true,
          commandId,
          status: receipt.status,
        });
      }

      // Fallthrough: 404
      return this.sendJson(res, 404, { error: 'NOT_FOUND', message: `Endpoint ${req.method} ${pathname} not found` });
    } catch (err) {
      console.error('[Mock Sync API Error]', err);
      return this.sendJson(res, 500, { error: 'INTERNAL_ERROR', message: err.message });
    }
  }

  sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
  }

  readJsonBody(req) {
    return new Promise((resolve, reject) => {
      if (req.method === 'GET' || req.method === 'DELETE') {
        return resolve({});
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        if (!body) return resolve({});
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Invalid JSON payload'));
        }
      });
      req.on('error', reject);
    });
  }
}

// Standalone execution support
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4002;
  const server = new MockSyncApiServer(port);
  server.start().catch((err) => {
    console.error('Failed to start Mock Sync API:', err);
    process.exit(1);
  });
}
