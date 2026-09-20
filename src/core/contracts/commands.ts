import { z } from 'zod';
import { IdSchema, RevisionSchema } from './primitives.js';

export const CommandStatusSchema = z.enum([
  'PENDING',
  'LEASED',
  'EXECUTING',
  'VERIFYING',
  'VERIFIED',
  'CONFLICT',
  'RETRYABLE',
  'TERMINAL_FAILURE',
]);
export type CommandStatus = z.infer<typeof CommandStatusSchema>;

export const CommandResultStatusSchema = z.enum([
  'VERIFIED',
  'CONFLICT',
  'RETRYABLE',
  'TERMINAL_FAILURE',
]);
export type CommandResultStatus = z.infer<typeof CommandResultStatusSchema>;

export const WriteReceiptSchema = z.object({
  externalId: IdSchema,
  revision: RevisionSchema,
  verifiedAt: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});
export type WriteReceipt = z.infer<typeof WriteReceiptSchema>;

export const SyncCommandSchema = z.preprocess((input) => {
  if (input && typeof input === 'object') {
    const raw = input as Record<string, unknown>;
    return {
      ...raw,
      action: raw.action ?? raw.actionId,
      parameters: raw.parameters ?? raw.payload ?? {},
    };
  }
  return input;
}, z.object({
  commandId: IdSchema,
  connectionId: z.string().optional(),
  action: z.string().min(1),
  parameters: z.record(z.unknown()).default({}),
  fencingToken: RevisionSchema.optional(),
  idempotencyKey: z.string().optional(),
  status: CommandStatusSchema.optional(),
  createdAt: z.string().optional(),
}));

export type SyncCommand = z.infer<typeof SyncCommandSchema>;

export const CommandResultSchema = z.object({
  status: CommandResultStatusSchema,
  commandId: z.string().optional(),
  writeReceipt: WriteReceiptSchema.optional(),
  error: z.unknown().optional(),
  acknowledged: z.boolean().optional(),
  occurredAt: z.string().optional(),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;
