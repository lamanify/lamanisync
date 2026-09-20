import fs from 'node:fs';
import path from 'node:path';
import { signManifest } from '../test-harness/fixtures/signing-keys.js';

const manifest = {
  adapterId: 'acme-cloud-v1',
  name: 'ACME Cloud CMS Adapter (Mock)',
  version: '1.0.0',
  minExtensionVersion: '0.1.0',
  targetOrigin: 'http://localhost:4001',
  capabilities: [
    'PATIENT_READ',
    'PATIENT_WRITE',
    'APPOINTMENT_READ',
    'APPOINTMENT_WRITE',
    'REFERENCE_DATA_READ',
  ],
  endpoints: {
    patients: {
      list: '/api/patients',
      get: '/api/patients/:id',
      create: '/api/patients',
      update: '/api/patients/:id',
    },
    appointments: {
      list: '/api/appointments',
      availability: '/api/appointments/availability',
      create: '/api/appointments',
      reschedule: '/api/appointments/:id',
      cancel: '/api/appointments/:id',
    },
    reference: {
      providers: '/api/reference/providers',
      services: '/api/reference/services',
      locations: '/api/reference/locations',
    },
  },
  recipes: {
    patients_list: {
      recipeId: 'patients_list',
      type: 'read',
      capability: 'PATIENT_READ',
      method: 'GET',
      path: '/api/patients',
      extractor: 'data',
    },
    patients_get: {
      recipeId: 'patients_get',
      type: 'read',
      capability: 'PATIENT_READ',
      method: 'GET',
      path: '/api/patients/:id',
      extractor: 'data',
    },
    appointments_list: {
      recipeId: 'appointments_list',
      type: 'read',
      capability: 'APPOINTMENT_READ',
      method: 'GET',
      path: '/api/appointments',
      extractor: 'data',
    },
    appointments_get: {
      recipeId: 'appointments_get',
      type: 'read',
      capability: 'APPOINTMENT_READ',
      method: 'GET',
      path: '/api/appointments/:id',
      extractor: 'data',
    },
    appointments_availability: {
      recipeId: 'appointments_availability',
      type: 'read',
      capability: 'APPOINTMENT_READ',
      method: 'GET',
      path: '/api/appointments/availability',
      extractor: 'slots',
    },
    reference_providers: {
      recipeId: 'reference_providers',
      type: 'read',
      capability: 'REFERENCE_DATA_READ',
      method: 'GET',
      path: '/api/reference/providers',
      extractor: 'data',
    },
    reference_services: {
      recipeId: 'reference_services',
      type: 'read',
      capability: 'REFERENCE_DATA_READ',
      method: 'GET',
      path: '/api/reference/services',
      extractor: 'data',
    },
    reference_locations: {
      recipeId: 'reference_locations',
      type: 'read',
      capability: 'REFERENCE_DATA_READ',
      method: 'GET',
      path: '/api/reference/locations',
      extractor: 'data',
    },
    patient_create: {
      recipeId: 'patient_create',
      type: 'write',
      capability: 'PATIENT_WRITE',
      method: 'POST',
      path: '/api/patients',
      headers: {
        'Content-Type': 'application/json',
      },
      transforms: [
        { field: 'phone', transform: 'phone_my' },
        { field: 'fullName', transform: 'trim' },
      ],
      bodyTemplate: {
        fullName: '$params.fullName',
        phone: '$params.phone',
        email: '$params.email',
        icOrPassport: '$params.icOrPassport',
      },
      verification: {
        path: '/api/patients/:id',
        method: 'GET',
        idParam: 'id',
        expectedFields: {
          fullName: '$params.fullName',
          phone: '$params.phone',
        },
      },
    },
    appointment_create: {
      recipeId: 'appointment_create',
      type: 'write',
      capability: 'APPOINTMENT_WRITE',
      method: 'POST',
      path: '/api/appointments',
      headers: {
        'Content-Type': 'application/json',
      },
      preconditions: [
        {
          type: 'slot_availability',
          endpoint: '/api/appointments/availability',
          providerIdParam: 'providerId',
          startTimeParam: 'startTime',
        },
      ],
      bodyTemplate: {
        patientId: '$params.patientId',
        providerId: '$params.providerId',
        serviceId: '$params.serviceId',
        locationId: '$params.locationId',
        startTime: '$params.startTime',
        endTime: '$params.endTime',
        notes: '$params.notes',
      },
      verification: {
        path: '/api/appointments/:id',
        method: 'GET',
        idParam: 'id',
        expectedFields: {
          patientId: '$params.patientId',
          providerId: '$params.providerId',
          status: 'booked',
        },
        revisionPath: 'rev',
      },
    },
    appointment_reschedule: {
      recipeId: 'appointment_reschedule',
      type: 'write',
      capability: 'APPOINTMENT_WRITE',
      method: 'PUT',
      path: '/api/appointments/:id',
      headers: {
        'Content-Type': 'application/json',
      },
      bodyTemplate: {
        startTime: '$params.startTime',
        endTime: '$params.endTime',
        expectedRev: '$params.expectedRev',
        notes: '$params.notes',
      },
      verification: {
        path: '/api/appointments/:id',
        method: 'GET',
        idParam: 'id',
        expectedFields: {
          startTime: '$params.startTime',
        },
        revisionPath: 'rev',
      },
    },
    appointment_cancel: {
      recipeId: 'appointment_cancel',
      type: 'write',
      capability: 'APPOINTMENT_WRITE',
      method: 'DELETE',
      path: '/api/appointments/:id',
      verification: {
        path: '/api/appointments/:id',
        method: 'GET',
        idParam: 'id',
        expectedFields: {
          status: 'cancelled',
        },
        revisionPath: 'rev',
      },
    },
  },
  hooks: ['acme-extract-csrf', 'acme-format-display-time'],
  polling: {
    intervalSeconds: 60,
    deltaField: 'updatedAt',
  },
};

const signature = signManifest(manifest);
manifest.signature = signature;

const manifestDir = path.resolve('src/adapters/manifests');
if (!fs.existsSync(manifestDir)) fs.mkdirSync(manifestDir, { recursive: true });

const manifestContent = JSON.stringify(manifest, null, 2);
fs.writeFileSync(path.join(manifestDir, 'acme-cloud.json'), manifestContent);
fs.writeFileSync(path.resolve('test-harness/fixtures/adapter-manifest.json'), manifestContent);
console.log('Manifests successfully built, canonically signed, and saved.');
