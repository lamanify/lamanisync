/**
 * Tenant Field Mapping Utilities (Phase 12)
 * Resolves tenant-specific schema variations using declarative configuration mappings.
 * Prevents hardcoding clinic-specific variants into core adapter recipes.
 */

export type FieldMappingDirection = 'toCanonical' | 'toTenant';

/**
 * Maps a record's fields based on a configuration mapping dictionary.
 * Mapping format: { [canonicalField]: tenantField }
 *
 * Example:
 * mapping = { fullName: "clientName", phone: "mobile_no" }
 * record = { clientName: "Alice", mobile_no: "+6012..." }
 * toCanonical -> { fullName: "Alice", phone: "+6012...", clientName: "Alice", mobile_no: "+6012..." }
 */
export function mapTenantRecord<T = Record<string, unknown>>(
  record: Record<string, unknown>,
  mapping: Record<string, string>,
  direction: FieldMappingDirection = 'toCanonical'
): T {
  const result: Record<string, unknown> = { ...record };

  if (direction === 'toCanonical') {
    for (const [canonicalKey, tenantKey] of Object.entries(mapping)) {
      if (record[tenantKey] !== undefined) {
        result[canonicalKey] = record[tenantKey];
      }
    }
  } else {
    for (const [canonicalKey, tenantKey] of Object.entries(mapping)) {
      if (record[canonicalKey] !== undefined) {
        result[tenantKey] = record[canonicalKey];
      }
    }
  }

  return result as T;
}
