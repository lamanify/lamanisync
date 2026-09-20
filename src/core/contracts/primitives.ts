import { z } from 'zod';

export const CAPABILITIES = [
  // Coarse-grained capabilities (manifest & sync API contract)
  'PATIENT_READ',
  'PATIENT_WRITE',
  'APPOINTMENT_READ',
  'APPOINTMENT_WRITE',
  'REFERENCE_DATA_READ',
  // Granular action capabilities
  'patients.read',
  'patients.create',
  'patients.update',
  'appointments.read',
  'appointments.availability',
  'appointments.create',
  'appointments.reschedule',
  'appointments.cancel',
  'reference.read',
] as const;

export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof CapabilitySchema>;

export const IdSchema = z.string().min(1);

export const RevisionSchema = z.number().int().nonnegative();

export const ISOTimestampSchema = z.string().datetime({ offset: true });

// Strict origin: protocol + host (:port), no path, no query, no hash, no wildcards
export const TargetOriginSchema = z
  .string()
  .url()
  .refine(
    (val) => {
      try {
        const url = new URL(val);
        const validProtocol = url.protocol === 'http:' || url.protocol === 'https:';
        const validPath = url.pathname === '' || url.pathname === '/';
        const noQueryOrHash = !url.search && !url.hash;
        const noWildcard = !url.hostname.includes('*');
        const noCredentials = !url.username && !url.password;
        return validProtocol && validPath && noQueryOrHash && noWildcard && noCredentials;
      } catch {
        return false;
      }
    },
    { message: 'targetOrigin must be a valid exact http or https origin without wildcards, path, query, fragment, or credentials' }
  )
  .transform((val) => {
    const url = new URL(val);
    return `${url.protocol}//${url.host}`;
  });
