/**
 * Packaged Hooks for Vendor CMS #1 (Phase 12)
 * Pre-compiled, statically bundled TypeScript functions for vendor-specific edge cases.
 * AGENTS.md Rule 2: Absolute ban on eval, new Function, or dynamic remote imports.
 */

import { type PackagedHookContext } from './acme-hooks.js';

/**
 * Extracts CSRF token from page meta tag or ambient document cookies.
 * Sets X-CSRF-Token on request headers if present.
 */
export function vendorCms1ExtractCsrf(context: PackagedHookContext): string | null {
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
      const match = cookieStr.match(/(?:^|;\s*)(?:cms_csrf|_csrf)=([^;]+)/);
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
 * Formats local display date-time for appointments (DD/MM/YYYY hh:mm A).
 */
export function vendorCms1FormatDisplayTime(context: PackagedHookContext): string {
  const startTime = context.params?.startTime;
  if (typeof startTime !== 'string') {
    return '';
  }

  try {
    const d = new Date(startTime);
    if (isNaN(d.getTime())) return '';
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

/**
 * Adapts Tenant B custom field names (clientName, mobile_no, nric) into standardized parameters.
 */
export function vendorCms1TenantBTransform(context: PackagedHookContext): Record<string, unknown> {
  const p = context.params || {};
  const mapped: Record<string, unknown> = { ...p };

  if (p.clientName && !p.fullName) {
    mapped.fullName = p.clientName;
  }
  if (p.mobile_no && !p.phone) {
    mapped.phone = p.mobile_no;
  }
  if (p.nric && !p.icOrPassport) {
    mapped.icOrPassport = p.nric;
  }
  if (p.client_id && !p.patientId) {
    mapped.patientId = p.client_id;
  }
  if (p.doctor_id && !p.providerId) {
    mapped.providerId = p.doctor_id;
  }
  if (p.start_time && !p.startTime) {
    mapped.startTime = p.start_time;
  }
  if (p.end_time && !p.endTime) {
    mapped.endTime = p.end_time;
  }

  if (context.params) {
    Object.assign(context.params, mapped);
  }

  return mapped;
}
