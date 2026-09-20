import { z } from 'zod';
import { CapabilitySchema, TargetOriginSchema } from '../core/contracts/primitives.js';
import { ALLOWLISTED_TRANSFORM_NAMES } from './primitives/transforms.js';
import { isPackagedHookRegistered } from './packaged-hooks/index.js';
import { LamaniError } from '../core/errors.js';

// Complexity limits
export const MAX_MANIFEST_SIZE_BYTES = 512 * 1024; // 512 KB
export const MAX_RECIPES_COUNT = 50;
export const MAX_TRANSFORMS_PER_RECIPE = 20;
export const MAX_PRECONDITIONS_PER_RECIPE = 5;

// Safe relative API path starting with /
export const SafeRelativePathSchema = z
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

// --- Declarative Recipe Schemas (Phase 6) ---

export const RecipeTransformSchema = z
  .object({
    field: z.string().min(1),
    transform: z.enum(ALLOWLISTED_TRANSFORM_NAMES as unknown as [string, ...string[]]),
  })
  .strict();

export const SlotAvailabilityPreconditionSchema = z
  .object({
    type: z.literal('slot_availability'),
    endpoint: SafeRelativePathSchema,
    providerIdParam: z.string().optional(),
    dateParam: z.string().optional(),
    startTimeParam: z.string().optional(),
  })
  .strict();

export const FieldEqualsPreconditionSchema = z
  .object({
    type: z.literal('field_equals'),
    path: z.string().min(1),
    expected: z.unknown(),
  })
  .strict();

export const PreconditionSchema = z.discriminatedUnion('type', [
  SlotAvailabilityPreconditionSchema,
  FieldEqualsPreconditionSchema,
]);

export const VerificationRecipeSchema = z
  .object({
    path: SafeRelativePathSchema,
    method: z.literal('GET').optional(),
    idParam: z.string().optional(),
    expectedFields: z.record(z.string()).optional(),
    revisionPath: z.string().optional(),
  })
  .strict();

export const RecipeSchema = z
  .object({
    recipeId: z.string().min(1),
    type: z.enum(['read', 'write']),
    capability: CapabilitySchema,
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
    path: SafeRelativePathSchema,
    headers: z.record(z.string()).optional(),
    bodyTemplate: z.record(z.unknown()).optional(),
    transforms: z.array(RecipeTransformSchema).max(MAX_TRANSFORMS_PER_RECIPE).optional(),
    extractor: z.string().optional(),
    preconditions: z.array(PreconditionSchema).max(MAX_PRECONDITIONS_PER_RECIPE).optional(),
    verification: VerificationRecipeSchema.optional(),
    hook: z
      .string()
      .refine((hookName) => isPackagedHookRegistered(hookName), {
        message: 'Hook must be registered in packaged hooks allowlist',
      })
      .optional(),
  })
  .strict();

export type DeclarativeRecipe = z.infer<typeof RecipeSchema>;

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
    recipes: z.record(RecipeSchema).optional(),
    hooks: z
      .array(
        z.string().refine((h) => isPackagedHookRegistered(h), {
          message: 'Hook must be registered in packaged hooks allowlist',
        })
      )
      .optional(),
    polling: PollingConfigSchema.optional(),
  })
  .strict();

export type AdapterManifest = z.infer<typeof AdapterManifestSchema>;

export function validateComplexityLimits(manifest: AdapterManifest, rawByteLength?: number): void {
  const byteLength = rawByteLength !== undefined ? rawByteLength : JSON.stringify(manifest).length;
  if (byteLength > MAX_MANIFEST_SIZE_BYTES) {
    throw new LamaniError(
      `Manifest size (${byteLength} bytes) exceeds maximum limit of ${MAX_MANIFEST_SIZE_BYTES} bytes`,
      'COMPLEXITY_LIMIT_EXCEEDED'
    );
  }

  if (manifest.recipes) {
    const recipeCount = Object.keys(manifest.recipes).length;
    if (recipeCount > MAX_RECIPES_COUNT) {
      throw new LamaniError(
        `Manifest recipe count (${recipeCount}) exceeds maximum limit of ${MAX_RECIPES_COUNT}`,
        'COMPLEXITY_LIMIT_EXCEEDED'
      );
    }
  }
}

export function validateAdapterManifest(manifest: unknown, rawByteLength?: number): AdapterManifest {
  const parsed = AdapterManifestSchema.parse(manifest);
  validateComplexityLimits(parsed, rawByteLength);
  return parsed;
}

