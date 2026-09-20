import { z } from 'zod';
import { TargetOriginSchema } from './primitives.js';

export const CONNECTION_STATES = [
  'UNPAIRED',
  'PAIRING',
  'PAIRED_NO_PERMISSION',
  'PROBING',
  'SHADOW',
  'ACTIVE',
  'REAUTH_REQUIRED',
  'DEGRADED',
  'PAUSED',
  'REVOKED',
] as const;

export const ConnectionStateSchema = z.enum(CONNECTION_STATES);
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

export const ConnectionStateRecordSchema = z.object({
  state: ConnectionStateSchema,
  reason: z.string().min(1, 'Transition reason is required'),
  timestamp: z.string().min(1, 'Transition timestamp is required'),
  connectionId: z.string().optional(),
  installationId: z.string().optional(),
  targetOrigin: TargetOriginSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type ConnectionStateRecord = z.infer<typeof ConnectionStateRecordSchema>;
