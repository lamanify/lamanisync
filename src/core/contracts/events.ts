import { z } from 'zod';
import { IdSchema, RevisionSchema } from './primitives.js';

export const EntityTypeSchema = z.enum(['patient', 'appointment', 'reference']);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const SyncEventSchema = z.object({
  eventId: IdSchema,
  entityType: z.string().min(1),
  entityId: IdSchema,
  eventType: z.string().min(1),
  revision: RevisionSchema,
  occurredAt: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
});

export type SyncEvent = z.infer<typeof SyncEventSchema>;

export const BatchSyncEventsSchema = z.object({
  installationId: IdSchema,
  batchId: IdSchema,
  events: z.array(SyncEventSchema).min(1),
});

export type BatchSyncEvents = z.infer<typeof BatchSyncEventsSchema>;
