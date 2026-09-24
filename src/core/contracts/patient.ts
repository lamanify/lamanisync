import { z } from 'zod';
import { IdSchema } from './primitives.js';

export const GenderSchema = z.enum(['male', 'female', 'other', 'unknown']);
export type Gender = z.infer<typeof GenderSchema>;

export const NormalizedPatientSchema = z.object({
  id: IdSchema,
  mrn: z.string().trim().nullable().optional(),
  fullName: z.string().trim().min(1),
  icOrPassport: z.string().trim().nullable().optional(),
  phone: z.string().trim().min(1),
  email: z.string().trim().email().nullable().optional().or(z.literal('')),
  dateOfBirth: z.string().trim().nullable().optional(),
  gender: GenderSchema.optional().default('unknown'),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).passthrough();

export type NormalizedPatient = z.infer<typeof NormalizedPatientSchema>;

export function normalizePatient(raw: unknown): NormalizedPatient {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid patient input: expected an object');
  }

  const r = raw as Record<string, unknown>;

  // Normalize phone (retain + and digits only)
  const rawPhone = String(r.phone ?? r.contact_number ?? r.mobile ?? '').trim();
  const cleanPhone = rawPhone.startsWith('+')
    ? '+' + rawPhone.slice(1).replace(/\D/g, '')
    : rawPhone.replace(/\D/g, '');

  let gender: Gender = 'unknown';
  if (typeof r.gender === 'string') {
    const lower = r.gender.toLowerCase().trim();
    if (lower === 'male' || lower === 'female' || lower === 'other') {
      gender = lower;
    }
  }

  let dateOfBirth: string | undefined = undefined;
  if (r.dateOfBirth || r.dob || r.date_of_birth) {
    const dobStr = String(r.dateOfBirth || r.dob || r.date_of_birth).trim();
    const dobMatch = dobStr.match(/^(\d{4}-\d{2}-\d{2})/);
    dateOfBirth = dobMatch ? dobMatch[1] : (dobStr || undefined);
  }

  const email = r.email && String(r.email).trim() ? String(r.email).trim() : undefined;

  const rawFullName = String(
    r.fullName ??
    r.full_name ??
    r.name ??
    (r.first_name ? `${r.first_name} ${r.last_name || ''}`.trim() : '')
  ).trim();

  const normalized = {
    id: String(r.id ?? '').trim(),
    mrn: r.mrn ? String(r.mrn).trim() : undefined,
    fullName: rawFullName,
    icOrPassport: (r.icOrPassport || r.nric || r.ic_number) ? String(r.icOrPassport || r.nric || r.ic_number).trim() : undefined,
    phone: cleanPhone,
    email,
    dateOfBirth,
    gender,
    createdAt: String(r.createdAt || r.created_at || new Date().toISOString()),
    updatedAt: String(r.updatedAt || r.updated_at || new Date().toISOString()),
  };

  return NormalizedPatientSchema.parse(normalized);
}
