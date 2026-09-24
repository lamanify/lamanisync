import { z } from 'zod';
import { IdSchema, RevisionSchema } from './primitives.js';

export const AppointmentStatusSchema = z.enum([
  'booked',
  'cancelled',
  'completed',
  'no_show',
]);
export type AppointmentStatus = z.infer<typeof AppointmentStatusSchema>;

export const NormalizedAppointmentSchema = z.object({
  id: IdSchema,
  patientId: IdSchema,
  providerId: IdSchema,
  serviceId: IdSchema,
  locationId: z.string().trim().nullable().optional(),
  startTime: z.string().min(1),
  endTime: z.string().min(1),
  slotDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'slotDate must be YYYY-MM-DD'),
  slotTimeNaive: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'slotTimeNaive must be HH:MM or HH:MM:SS'),
  displayTime: z.string().trim().nullable().optional(),
  status: AppointmentStatusSchema,
  notes: z.string().trim().nullable().optional(),
  revision: RevisionSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).passthrough();

export type NormalizedAppointment = z.infer<typeof NormalizedAppointmentSchema>;

export function normalizeAppointment(raw: unknown): NormalizedAppointment {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid appointment input: expected an object');
  }

  const r = raw as Record<string, unknown>;

  let startTime = String(r.startTime ?? r.start_time ?? '').trim();
  let endTime = String(r.endTime ?? r.end_time ?? '').trim();

  // Derive slotDate and slotTimeNaive from startTime or appointment_date/appointment_time
  let slotDate = typeof r.slotDate === 'string' ? r.slotDate.trim() : (typeof r.appointment_date === 'string' ? r.appointment_date.trim() : '');
  let slotTimeNaive = typeof r.slotTimeNaive === 'string' ? r.slotTimeNaive.trim() : (typeof r.appointment_time === 'string' ? r.appointment_time.trim() : '');

  if (slotDate) {
    const match = slotDate.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) slotDate = match[1];
  } else if (startTime) {
    const match = startTime.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) slotDate = match[1];
  }

  if (slotTimeNaive) {
    const match = slotTimeNaive.match(/^(\d{2}:\d{2}(?::\d{2})?)/);
    if (match) {
      slotTimeNaive = match[1].length === 5 ? `${match[1]}:00` : match[1];
    }
  } else if (startTime) {
    const match = startTime.match(/[T\s](\d{2}:\d{2}(?::\d{2})?)/i);
    if (match) {
      slotTimeNaive = match[1].length === 5 ? `${match[1]}:00` : match[1];
    }
  }

  // Format slotTimeNaive to HH:MM:SS if HH:MM
  if (slotTimeNaive && slotTimeNaive.length === 5) {
    slotTimeNaive = `${slotTimeNaive}:00`;
  }

  if (!startTime && slotDate && slotTimeNaive) {
    startTime = `${slotDate}T${slotTimeNaive}+08:00`;
  }

  if (!endTime && startTime) {
    const duration = Number(r.duration_minutes ?? r.duration ?? 30);
    const parsedStart = new Date(startTime);
    endTime = !isNaN(parsedStart.getTime())
      ? new Date(parsedStart.getTime() + duration * 60000).toISOString()
      : startTime;
  }

  const rawStatus = String(r.status ?? 'booked').toLowerCase().trim();
  const status: AppointmentStatus =
    rawStatus === 'cancelled' || rawStatus === 'canceled'
      ? 'cancelled'
      : rawStatus === 'completed'
        ? 'completed'
        : rawStatus === 'no_show' || rawStatus === 'noshow'
          ? 'no_show'
          : 'booked';

  const rawRev = r.revision ?? r.rev ?? 1;
  const revision = Number.isInteger(Number(rawRev)) ? Math.max(0, Number(rawRev)) : 0;

  const patientName =
    r.patient_name ||
    r.patientName ||
    (r.patients && typeof r.patients === 'object'
      ? `${String((r.patients as Record<string, unknown>).first_name || '')} ${String((r.patients as Record<string, unknown>).last_name || '')}`.trim()
      : undefined);

  const providerName =
    r.doctor_name ||
    r.providerName ||
    (r.profiles && typeof r.profiles === 'object'
      ? `Dr. ${String((r.profiles as Record<string, unknown>).first_name || '')} ${String((r.profiles as Record<string, unknown>).last_name || '')}`.trim()
      : undefined);

  const serviceName = r.service_name || r.serviceName || r.reason || undefined;

  const normalized = {
    id: String(r.id ?? '').trim(),
    patientId: String(r.patientId ?? r.patient_id ?? '').trim(),
    providerId: String(r.providerId ?? r.provider_id ?? r.doctor_id ?? '').trim(),
    serviceId: String(r.serviceId ?? r.service_id ?? (r.reason ? String(r.reason).slice(0, 32) : 'general')).trim(),
    locationId: r.locationId ? String(r.locationId).trim() : undefined,
    startTime,
    endTime,
    slotDate,
    slotTimeNaive,
    displayTime: r.displayTime ? String(r.displayTime).trim() : undefined,
    status,
    notes: r.notes ? String(r.notes).trim() : (r.reason ? String(r.reason).trim() : undefined),
    revision,
    patientName: patientName || undefined,
    providerName: providerName || undefined,
    serviceName: serviceName ? String(serviceName) : undefined,
    reason: r.reason ? String(r.reason) : undefined,
    createdAt: String(r.createdAt || r.created_at || new Date().toISOString()),
    updatedAt: String(r.updatedAt || r.updated_at || new Date().toISOString()),
  };

  return NormalizedAppointmentSchema.parse(normalized);
}
