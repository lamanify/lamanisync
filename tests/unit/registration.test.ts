// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerDynamicContentScripts,
  unregisterDynamicContentScripts,
  isDynamicContentScriptRegistered,
  CONTENT_SCRIPT_ISOLATED_ID,
  CONTENT_SCRIPT_MAIN_ID,
  type ChromeScriptingApi,
} from '../../src/content/registration.js';
import { LamaniError } from '../../src/core/errors.js';

describe('Dynamic Script Registration (Phase 5)', () => {
  let mockScripts: chrome.scripting.RegisteredContentScript[] = [];
  let mockScriptingApi: ChromeScriptingApi;

  beforeEach(() => {
    mockScripts = [];
    mockScriptingApi = {
      registerContentScripts: vi.fn(async (scripts: chrome.scripting.RegisteredContentScript[]) => {
        // Enforce uniqueness check
        for (const s of scripts) {
          if (mockScripts.some((existing) => existing.id === s.id)) {
            throw new Error(`Duplicate script ID '${s.id}'`);
          }
          mockScripts.push(s);
        }
      }),
      unregisterContentScripts: vi.fn(async (filter?: { ids?: string[] }) => {
        if (!filter?.ids) {
          mockScripts = [];
        } else {
          mockScripts = mockScripts.filter((s) => !filter.ids?.includes(s.id));
        }
      }),
      getRegisteredContentScripts: vi.fn(async (filter?: { ids?: string[] }) => {
        if (!filter?.ids) return [...mockScripts];
        return mockScripts.filter((s) => filter.ids?.includes(s.id));
      }),
    };
  });

  it('registers both ISOLATED and MAIN scripts strictly for exact CMS origin pattern', async () => {
    const origin = 'http://localhost:4001';
    await registerDynamicContentScripts(origin, { scriptingApi: mockScriptingApi });

    expect(mockScriptingApi.registerContentScripts).toHaveBeenCalledTimes(1);
    expect(mockScripts).toHaveLength(2);

    const isolatedScript = mockScripts.find((s) => s.id === CONTENT_SCRIPT_ISOLATED_ID);
    expect(isolatedScript).toBeDefined();
    expect(isolatedScript?.world).toBe('ISOLATED');
    expect(isolatedScript?.runAt).toBe('document_start');
    expect(isolatedScript?.matches).toEqual(['http://localhost:4001/*']);
    expect(isolatedScript?.js).toEqual(['content-script.js']);

    const mainScript = mockScripts.find((s) => s.id === CONTENT_SCRIPT_MAIN_ID);
    expect(mainScript).toBeDefined();
    expect(mainScript?.world).toBe('MAIN');
    expect(mainScript?.runAt).toBe('document_start');
    expect(mainScript?.matches).toEqual(['http://localhost:4001/*']);
    expect(mainScript?.js).toEqual(['page-world.js']);
  });

  it('strictly rejects wildcard origins (AGENTS.md Rule 3)', async () => {
    await expect(
      registerDynamicContentScripts('*://*/*', { scriptingApi: mockScriptingApi })
    ).rejects.toThrow(LamaniError);

    await expect(
      registerDynamicContentScripts('https://*/*', { scriptingApi: mockScriptingApi })
    ).rejects.toThrow(LamaniError);

    expect(mockScripts).toHaveLength(0);
  });

  it('cleans up existing registrations before registering to prevent duplicate ID collision', async () => {
    // Pre-populate with existing scripts
    mockScripts = [
      {
        id: CONTENT_SCRIPT_ISOLATED_ID,
        matches: ['http://localhost:4001/*'],
        js: ['old-content.js'],
      },
      {
        id: CONTENT_SCRIPT_MAIN_ID,
        matches: ['http://localhost:4001/*'],
        js: ['old-page.js'],
      },
    ];

    await registerDynamicContentScripts('http://localhost:4001', { scriptingApi: mockScriptingApi });

    expect(mockScriptingApi.unregisterContentScripts).toHaveBeenCalledWith({
      ids: [CONTENT_SCRIPT_ISOLATED_ID, CONTENT_SCRIPT_MAIN_ID],
    });
    expect(mockScripts).toHaveLength(2);
    expect(mockScripts[0].js).toEqual(['content-script.js']);
  });

  it('unregisters content scripts cleanly on unpair / permission drop', async () => {
    await registerDynamicContentScripts('http://localhost:4001', { scriptingApi: mockScriptingApi });
    expect(await isDynamicContentScriptRegistered(mockScriptingApi)).toBe(true);

    await unregisterDynamicContentScripts(mockScriptingApi);
    expect(mockScriptingApi.unregisterContentScripts).toHaveBeenCalledWith({
      ids: [CONTENT_SCRIPT_ISOLATED_ID, CONTENT_SCRIPT_MAIN_ID],
    });
    expect(await isDynamicContentScriptRegistered(mockScriptingApi)).toBe(false);
  });

  it('fails closed when chrome.scripting API is missing', async () => {
    await expect(
      registerDynamicContentScripts('http://localhost:4001', { scriptingApi: undefined })
    ).rejects.toThrow(LamaniError);
  });
});
