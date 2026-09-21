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
  if (!record || typeof record !== 'object') {
    return {} as T;
  }
  if (!mapping || typeof mapping !== 'object') {
    return { ...record } as T;
  }

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

/**
 * Maps an array of records based on a configuration mapping dictionary.
 */
export function mapTenantRecords<T = Record<string, unknown>>(
  records: Array<Record<string, unknown>>,
  mapping: Record<string, string>,
  direction: FieldMappingDirection = 'toCanonical'
): T[] {
  if (!Array.isArray(records)) return [];
  return records.map((r) => mapTenantRecord<T>(r, mapping, direction));
}

/**
 * Extracts and maps tenant-specific reference data domain (providers, services, locations).
 * Handles both flat arrays and objects containing arrays under a root property (e.g. { practitioners: [...] }).
 */
export function mapTenantReferenceDomain<T = Record<string, unknown>>(
  rawItems: Array<Record<string, unknown>> | Record<string, unknown>,
  domainMapping: Record<string, string>
): T[] {
  let list: Array<Record<string, unknown>> = [];
  if (Array.isArray(rawItems)) {
    list = rawItems;
  } else if (rawItems && typeof rawItems === 'object') {
    const rootKey = domainMapping.root;
    if (rootKey && Array.isArray((rawItems as Record<string, unknown>)[rootKey])) {
      list = (rawItems as Record<string, unknown>)[rootKey] as Array<Record<string, unknown>>;
    } else if (Array.isArray((rawItems as Record<string, unknown>).data)) {
      list = (rawItems as Record<string, unknown>).data as Array<Record<string, unknown>>;
    }
  }

  const fieldMapping: Record<string, string> = {};
  for (const [k, v] of Object.entries(domainMapping)) {
    if (k !== 'root' && typeof v === 'string') {
      fieldMapping[k] = v;
    }
  }
  return mapTenantRecords<T>(list, fieldMapping, 'toCanonical');
}

