import { z } from 'zod';
import { CapabilitySchema } from './primitives.js';

export const CompatibilityReportSchema = z.object({
  installationId: z.string().min(1),
  connectionId: z.string().optional(),
  capabilities: z.array(CapabilitySchema),
  cmsVersion: z.string().min(1),
  passed: z.boolean(),
  details: z.record(z.unknown()).default({}),
  recordedAt: z.string().optional(),
});
export type CompatibilityReport = z.infer<typeof CompatibilityReportSchema>;

export const RedactedDiagnosticSchema = z.object({
  id: z.string().optional(),
  installationId: z.string().optional(),
  correlationId: z.string().nullable().optional(),
  errorType: z.string().min(1),
  redactedDetails: z.record(z.unknown()).default({}),
  timestamp: z.string().optional(),
  receivedAt: z.string().optional(),
});
export type RedactedDiagnostic = z.infer<typeof RedactedDiagnosticSchema>;
