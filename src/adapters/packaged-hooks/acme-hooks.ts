/**
 * Packaged Hooks for ACME CMS (Phase 6)
 * Pre-compiled, statically bundled TypeScript functions for edge cases.
 * AGENTS.md Rule 2: Absolute ban on eval, new Function, or dynamic remote imports.
 */

export interface PackagedHookContext {
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  response?: unknown;
  document?: Document;
  cookieString?: string;
}

/**
 * Extracts CSRF token from page meta tag or document cookies if available.
 */
export function acmeExtractCsrf(context: PackagedHookContext): string | null {
  let token: string | null = null;

  // 1. Check document meta tag
  if (context.document) {
    const metaTag = context.document.querySelector('meta[name="csrf-token"]');
    if (metaTag) {
      const content = metaTag.getAttribute('content');
      if (content) token = content;
    }
  }

  // 2. Check cookie string
  if (!token) {
    const cookieStr = context.cookieString || (typeof document !== 'undefined' ? document.cookie : '');
    if (cookieStr) {
      const match = cookieStr.match(/(?:^|;\s*)cms_csrf=([^;]+)/);
      if (match) {
        token = decodeURIComponent(match[1]);
      }
    }
  }

  if (token && context.headers) {
    context.headers['X-CSRF-Token'] = token;
  }

  return token;
}

/**
 * Formats local display date-time for ACME appointments (DD/MM/YYYY hh:mm A).
 */
export function acmeFormatDisplayTime(context: PackagedHookContext): string {
  const startTime = context.params?.startTime;
  if (typeof startTime !== 'string') {
    return '';
  }

  try {
    const d = new Date(startTime);
    if (isNaN(d.getTime())) return '';
    // Format DD/MM/YYYY HH:mm
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours24 = d.getHours();
    const hours12 = hours24 % 12 || 12;
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const ampm = hours24 >= 12 ? 'PM' : 'AM';
    const formatted = `${day}/${month}/${year} ${String(hours12).padStart(2, '0')}:${minutes} ${ampm}`;

    if (context.params) {
      context.params.displayTime = formatted;
    }

    return formatted;
  } catch {
    return '';
  }
}
