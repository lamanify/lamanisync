import { z } from 'zod';
import { CapabilitySchema, TargetOriginSchema } from '../core/contracts/primitives.js';

// Safe relative API path starting with /
const SafeRelativePathSchema = z
  .string()
  .min(1)
  .regex(/^\/[a-zA-Z0-9_\-/:?&=%.]*$/, 'Must be a safe relative URL path starting with /')
  .refine(
    (path) => {
      const lower = path.toLowerCase();
      const noScheme = !lower.includes('javascript:') && !lower.includes('data:') && !lower.includes('vbscript:');
      const noProtocolRelative = !path.startsWith('//');
      const noTraversal = !path.includes('..');
      const noBackslash = !path.includes('\\');
      return noScheme && noProtocolRelative && noTraversal && noBackslash;
    },
    { message: 'Path cannot contain unsafe schemes, protocol-relative prefixes, backslashes, or path traversals' }
  );

export const PatientsEndpointsSchema = z
  .object({
    list: SafeRelativePathSchema.optional(),
    get: SafeRelativePathSchema.optional(),
    create: SafeRelativePathSchema.optional(),
    update: SafeRelativePathSchema.optional(),
  })
  .strict();

export const AppointmentsEndpointsSchema = z
  .object({
    list: SafeRelativePathSchema.optional(),
    availability: SafeRelativePathSchema.optional(),
    create: SafeRelativePathSchema.optional(),
    reschedule: SafeRelativePathSchema.optional(),
    cancel: SafeRelativePathSchema.optional(),
  })
  .strict();

export const ReferenceEndpointsSchema = z
  .object({
    providers: SafeRelativePathSchema.optional(),
    services: SafeRelativePathSchema.optional(),
    locations: SafeRelativePathSchema.optional(),
  })
  .catchall(SafeRelativePathSchema)
  .optional();

export const EndpointsMapSchema = z
  .object({
    patients: PatientsEndpointsSchema.optional(),
    appointments: AppointmentsEndpointsSchema.optional(),
    reference: ReferenceEndpointsSchema,
  })
  .catchall(z.record(SafeRelativePathSchema))
  .optional();

export const PollingConfigSchema = z
  .object({
    intervalSeconds: z.number().int().min(5).max(3600),
    deltaField: z.string().regex(/^[a-zA-Z0-9_.]+$/).optional(),
  })
  .strict();

export const AdapterManifestSchema = z
  .object({
    adapterId: z.string().min(1).regex(/^[a-zA-Z0-9_\-.]+$/, 'adapterId must be alphanumeric with dashes or dots'),
    name: z.string().min(1),
    version: z.string().min(1),
    minExtensionVersion: z.string().optional(),
    targetOrigin: TargetOriginSchema,
    signature: z.string().optional(),
    capabilities: z.array(CapabilitySchema).min(1, 'At least one capability required'),
    endpoints: EndpointsMapSchema,
    polling: PollingConfigSchema.optional(),
  })
  .strict();

export type AdapterManifest = z.infer<typeof AdapterManifestSchema>;

export function validateAdapterManifest(manifest: unknown): AdapterManifest {
  return AdapterManifestSchema.parse(manifest);
}
