// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  downloadCandidateManifest,
  verifyAndStageCandidate,
  promoteToActive,
  getActiveManifest,
  syncAndActivateAdapter,
  InMemoryStorageAdapter,
} from '../../src/adapters/lifecycle.js';
import { signManifest } from '../../test-harness/fixtures/signing-keys.js';

describe('Manifest Lifecycle Manager (lifecycle.ts)', () => {
  const manifestPath = path.resolve('src/adapters/manifests/acme-cloud.json');
  const validManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  let storage: InMemoryStorageAdapter;

  const createMockFetch = (variantOverride?: string): typeof fetch => {
    return async (url: string | URL | Request) => {
      const urlStr = url.toString();

      // Probe endpoint check
      if (urlStr.includes('/api/reference/providers')) {
        return new Response(JSON.stringify({ data: [{ id: 'DOC-01' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (urlStr.includes('/api/non-existent-probe-endpoint')) {
        return new Response('Not Found', { status: 404 });
      }

      // Sync API adapter distribution
      if (urlStr.includes('/v1/sync/connections/') && urlStr.includes('/adapter')) {
        const urlObj = new URL(urlStr);
        const variant = variantOverride || urlObj.searchParams.get('variant') || 'valid';
        const manifest = JSON.parse(JSON.stringify(validManifest));

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
          // Valid signed
          manifest.signature = signManifest(manifest);
        }

        return new Response(JSON.stringify(manifest), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not Found', { status: 404 });
    };
  };

  beforeEach(() => {
    storage = new InMemoryStorageAdapter();
  });

  it('downloads valid candidate manifest and stages it successfully', async () => {
    const mockFetch = createMockFetch();
    const candidate = await downloadCandidateManifest('conn_mock_67890', {
      syncApiUrl: 'http://localhost:4002',
      fetchFn: mockFetch,
    });
    expect(candidate).toBeDefined();

    const staged = await verifyAndStageCandidate(candidate, {
      grantedOrigin: 'http://localhost:4001',
      probeEndpoint: '/api/reference/providers',
      fetchFn: mockFetch,
    });

    expect(staged.adapterId).toBe('acme-cloud-v1');
    expect(staged.targetOrigin).toBe('http://localhost:4001');

    await promoteToActive(staged, { storage });

    const active = await getActiveManifest('acme-cloud-v1', { storage });
    expect(active?.adapterId).toBe('acme-cloud-v1');
  });

  it('rejects tampered candidate manifest variant from Sync API', async () => {
    const mockFetch = createMockFetch('tampered');
    const tampered = await downloadCandidateManifest('conn_mock_67890', {
      syncApiUrl: 'http://localhost:4002',
      fetchFn: mockFetch,
    });

    await expect(
      verifyAndStageCandidate(tampered, {
        grantedOrigin: 'http://localhost:4001',
        fetchFn: mockFetch,
      })
    ).rejects.toMatchObject({ code: 'MANIFEST_SIGNATURE_INVALID' });
  });

  it('rejects unsigned candidate manifest variant from Sync API', async () => {
    const mockFetch = createMockFetch('unsigned');
    const unsigned = await downloadCandidateManifest('conn_mock_67890', {
      syncApiUrl: 'http://localhost:4002',
      fetchFn: mockFetch,
    });

    await expect(
      verifyAndStageCandidate(unsigned, {
        grantedOrigin: 'http://localhost:4001',
        fetchFn: mockFetch,
      })
    ).rejects.toMatchObject({ code: 'MANIFEST_UNSIGNED' });
  });

  it('rejects candidate manifest with unknown primitive/capability', async () => {
    const mockFetch = createMockFetch('unknown_primitive');
    const unknownPrimitive = await downloadCandidateManifest('conn_mock_67890', {
      syncApiUrl: 'http://localhost:4002',
      fetchFn: mockFetch,
    });

    await expect(
      verifyAndStageCandidate(unknownPrimitive, {
        grantedOrigin: 'http://localhost:4001',
        fetchFn: mockFetch,
      })
    ).rejects.toMatchObject({ code: 'MANIFEST_SCHEMA_INVALID' });
  });

  it('rejects candidate manifest with invalid schema', async () => {
    const mockFetch = createMockFetch('invalid_schema');
    const invalidSchema = await downloadCandidateManifest('conn_mock_67890', {
      syncApiUrl: 'http://localhost:4002',
      fetchFn: mockFetch,
    });

    await expect(
      verifyAndStageCandidate(invalidSchema, {
        grantedOrigin: 'http://localhost:4001',
        fetchFn: mockFetch,
      })
    ).rejects.toMatchObject({ code: 'MANIFEST_SCHEMA_INVALID' });
  });

  it('rejects candidate manifest specifying origin outside user-granted host (AGENTS.md Rule 3)', async () => {
    const mockFetch = createMockFetch('valid');
    const validCandidate = await downloadCandidateManifest('conn_mock_67890', {
      syncApiUrl: 'http://localhost:4002',
      fetchFn: mockFetch,
    });

    // Granted origin is a different host
    await expect(
      verifyAndStageCandidate(validCandidate, {
        grantedOrigin: 'https://other-clinic.com',
        fetchFn: mockFetch,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED_ORIGIN' });
  });

  it('rejects candidate when CMS probe test fails', async () => {
    const mockFetch = createMockFetch('valid');
    const validCandidate = await downloadCandidateManifest('conn_mock_67890', {
      syncApiUrl: 'http://localhost:4002',
      fetchFn: mockFetch,
    });

    // Probe to a non-existent endpoint
    await expect(
      verifyAndStageCandidate(validCandidate, {
        grantedOrigin: 'http://localhost:4001',
        probeEndpoint: '/api/non-existent-probe-endpoint',
        fetchFn: mockFetch,
      })
    ).rejects.toMatchObject({ code: 'CMS_PROBE_FAILED' });
  });

  it('gracefully rolls back to Last-Known-Good (LKG) version when update fails', async () => {
    const mockFetch = createMockFetch();

    // 1. Initial successful installation establishes LKG
    const initialSync = await syncAndActivateAdapter('conn_mock_67890', 'http://localhost:4001', {
      syncApiUrl: 'http://localhost:4002',
      storage,
      fetchFn: mockFetch,
    });
    expect(initialSync.isRollback).toBe(false);
    expect(initialSync.manifest.adapterId).toBe('acme-cloud-v1');

    // 2. Subsequent sync fails because server serves tampered manifest candidate
    const failedUpdateSync = await syncAndActivateAdapter('conn_mock_67890', 'http://localhost:4001', {
      syncApiUrl: 'http://localhost:4002',
      variant: 'tampered',
      storage,
      fetchFn: createMockFetch('tampered'),
    });

    // Should gracefully fallback to LKG
    expect(failedUpdateSync.isRollback).toBe(true);
    expect(failedUpdateSync.manifest.adapterId).toBe('acme-cloud-v1');

    // 3. Active manifest in storage is rolled-back LKG
    const active = await getActiveManifest('acme-cloud-v1', { storage });
    expect(active?.adapterId).toBe('acme-cloud-v1');
  });

  it('normalizes grantedOrigin with trailing slashes and uppercase host correctly', async () => {
    const mockFetch = createMockFetch('valid');
    const validCandidate = await downloadCandidateManifest('conn_mock_67890', {
      syncApiUrl: 'http://localhost:4002',
      fetchFn: mockFetch,
    });

    // Granted origin has uppercase host and trailing slash: HTTP://LOCALHOST:4001/
    const staged = await verifyAndStageCandidate(validCandidate, {
      grantedOrigin: 'HTTP://LOCALHOST:4001/',
      probeEndpoint: false,
      fetchFn: mockFetch,
    });

    expect(staged.targetOrigin).toBe('http://localhost:4001');
  });

  it('rolls back using specific adapterId when candidate download network request fails', async () => {
    const networkFailFetch: typeof fetch = async () => {
      throw new Error('Network unreachable');
    };

    // Pre-populate storage with LKG for custom adapter
    const lkgManifest = { ...validManifest, adapterId: 'custom-vendor-v2' };
    lkgManifest.signature = signManifest(lkgManifest);
    await promoteToActive(lkgManifest, { storage });

    const fallbackResult = await syncAndActivateAdapter('conn_custom_123', 'http://localhost:4001', {
      syncApiUrl: 'http://localhost:4002',
      adapterId: 'custom-vendor-v2',
      storage,
      fetchFn: networkFailFetch,
    });

    expect(fallbackResult.isRollback).toBe(true);
    expect(fallbackResult.manifest.adapterId).toBe('custom-vendor-v2');
  });
});
