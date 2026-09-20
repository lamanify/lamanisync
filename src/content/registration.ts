/**
 * Dynamic Content Script Registration (Phase 5)
 * Dynamically registers isolated and main-world scripts strictly for the exact paired CMS origin.
 * Strictly adheres to AGENTS.md:
 * Rule 1: Build Manifest V3 only.
 * Rule 2: Zero remote code, zero eval.
 * Rule 3: Never request a host permission or match pattern broader than the exact paired CMS origin.
 */

import { normalizeExactOrigin, toExactOriginPattern } from '../background/permissions.js';
import { LamaniError } from '../core/errors.js';

export const CONTENT_SCRIPT_ISOLATED_ID = 'lamanisync-isolated-content';
export const CONTENT_SCRIPT_MAIN_ID = 'lamanisync-main-runner';

export const DEFAULT_ISOLATED_SCRIPT_PATH = 'content-script.js';
export const DEFAULT_MAIN_SCRIPT_PATH = 'page-world.js';

export interface ChromeScriptingApi {
  registerContentScripts(scripts: chrome.scripting.RegisteredContentScript[]): Promise<void>;
  unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
  getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<chrome.scripting.RegisteredContentScript[]>;
}

function getScriptingApi(custom?: ChromeScriptingApi): ChromeScriptingApi {
  if (custom) return custom;
  if (typeof chrome !== 'undefined' && chrome.scripting) {
    return chrome.scripting as unknown as ChromeScriptingApi;
  }
  throw new LamaniError(
    'chrome.scripting API is not available in current context',
    'SCRIPTING_API_UNAVAILABLE'
  );
}

export interface RegisterScriptsOptions {
  scriptingApi?: ChromeScriptingApi;
  isolatedScriptPath?: string;
  mainScriptPath?: string;
  runAt?: 'document_start' | 'document_end' | 'document_idle';
  persistAcrossSessions?: boolean;
}

/**
 * Registers dynamic content scripts strictly matching the exact paired CMS origin.
 * Fails closed on wildcards, paths, or malformed origins.
 */
export async function registerDynamicContentScripts(
  targetOrigin: string,
  options: RegisterScriptsOptions = {}
): Promise<void> {
  const api = getScriptingApi(options.scriptingApi);

  // Strictly normalize exact origin and convert to pattern (rejects wildcards)
  const exactOrigin = normalizeExactOrigin(targetOrigin);
  const originPattern = toExactOriginPattern(exactOrigin);

  const isolatedPath = options.isolatedScriptPath || DEFAULT_ISOLATED_SCRIPT_PATH;
  const mainPath = options.mainScriptPath || DEFAULT_MAIN_SCRIPT_PATH;
  const runAt = options.runAt || 'document_start';
  const persistAcrossSessions = options.persistAcrossSessions ?? true;

  // Check and unregister existing scripts to prevent duplicate ID collision
  try {
    const existing = await api.getRegisteredContentScripts({
      ids: [CONTENT_SCRIPT_ISOLATED_ID, CONTENT_SCRIPT_MAIN_ID],
    });
    const existingIds = (existing || []).map((s) => s.id);
    if (existingIds.length > 0) {
      await api.unregisterContentScripts({ ids: existingIds });
    }
  } catch (err) {
    // If querying/unregistering fails, log non-fatal warning and attempt registration
    console.warn('[LamaniSync Scripting] Pre-registration cleanup notice:', err);
  }

  const scriptsToRegister: chrome.scripting.RegisteredContentScript[] = [
    {
      id: CONTENT_SCRIPT_ISOLATED_ID,
      matches: [originPattern],
      js: [isolatedPath],
      runAt,
      world: 'ISOLATED',
      allFrames: false,
      persistAcrossSessions,
    },
    {
      id: CONTENT_SCRIPT_MAIN_ID,
      matches: [originPattern],
      js: [mainPath],
      runAt,
      world: 'MAIN',
      allFrames: false,
      persistAcrossSessions,
    },
  ];

  try {
    await api.registerContentScripts(scriptsToRegister);
  } catch (err) {
    throw new LamaniError(
      `Failed to register dynamic content scripts for ${exactOrigin}`,
      'SCRIPT_REGISTRATION_FAILED',
      { cause: err, details: { targetOrigin: exactOrigin, originPattern } }
    );
  }
}

/**
 * Unregisters all dynamic content scripts registered for LamaniSync.
 */
export async function unregisterDynamicContentScripts(
  scriptingApi?: ChromeScriptingApi
): Promise<void> {
  const api = getScriptingApi(scriptingApi);

  try {
    await api.unregisterContentScripts({
      ids: [CONTENT_SCRIPT_ISOLATED_ID, CONTENT_SCRIPT_MAIN_ID],
    });
  } catch (err) {
    // Graceful unregister: ignore if already unregistered
    const msg = (err as Error)?.message || '';
    if (!msg.includes('Nonexistent') && !msg.includes('not found')) {
      throw new LamaniError(
        'Failed to unregister dynamic content scripts',
        'SCRIPT_UNREGISTRATION_FAILED',
        { cause: err }
      );
    }
  }
}

/**
 * Checks whether LamaniSync content scripts are currently registered.
 */
export async function isDynamicContentScriptRegistered(
  scriptingApi?: ChromeScriptingApi
): Promise<boolean> {
  const api = getScriptingApi(scriptingApi);

  try {
    const scripts = await api.getRegisteredContentScripts({
      ids: [CONTENT_SCRIPT_ISOLATED_ID, CONTENT_SCRIPT_MAIN_ID],
    });
    return (scripts || []).length > 0;
  } catch {
    return false;
  }
}
