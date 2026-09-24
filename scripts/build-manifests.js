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

const vendorCms1Manifest = {
  adapterId: 'vendor-cms-1',
  name: 'Vendor CMS #1 Certified Adapter',
  version: '1.0.0',
  minExtensionVersion: '0.1.0',
  targetOrigin: 'http://localhost:4001',
  capabilities: [
    'PATIENT_READ',
    'PATIENT_WRITE',
    'APPOINTMENT_READ',
    'APPOINTMENT_WRITE',
    'REFERENCE_DATA_READ',
    'patients.read',
    'patients.create',
    'patients.update',
    'appointments.read',
    'appointments.availability',
    'appointments.create',
    'appointments.reschedule',
    'appointments.cancel',
    'reference.read',
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
    'patients.read': {
      recipeId: 'patients.read',
      type: 'read',
      capability: 'patients.read',
      method: 'GET',
      path: '/api/patients',
      extractor: 'data',
    },
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
    'patients.create': {
      recipeId: 'patients.create',
      type: 'write',
      capability: 'patients.create',
      method: 'POST',
      path: '/api/patients',
      headers: {
        'Content-Type': 'application/json',
      },
      hook: 'vendor-cms-1-extract-csrf',
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
    patient_create: {
      recipeId: 'patient_create',
      type: 'write',
      capability: 'PATIENT_WRITE',
      method: 'POST',
      path: '/api/patients',
      headers: {
        'Content-Type': 'application/json',
      },
      hook: 'vendor-cms-1-extract-csrf',
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
    'patients.update': {
      recipeId: 'patients.update',
      type: 'write',
      capability: 'patients.update',
      method: 'PUT',
      path: '/api/patients/:id',
      headers: {
        'Content-Type': 'application/json',
      },
      hook: 'vendor-cms-1-extract-csrf',
      transforms: [
        { field: 'phone', transform: 'phone_my' },
        { field: 'fullName', transform: 'trim' },
      ],
      bodyTemplate: {
        fullName: '$params.fullName',
        phone: '$params.phone',
        email: '$params.email',
      },
      verification: {
        path: '/api/patients/:id',
        method: 'GET',
        idParam: 'id',
        expectedFields: {
          fullName: '$params.fullName',
        },
      },
    },
    patient_update: {
      recipeId: 'patient_update',
      type: 'write',
      capability: 'PATIENT_WRITE',
      method: 'PUT',
      path: '/api/patients/:id',
      headers: {
        'Content-Type': 'application/json',
      },
      hook: 'vendor-cms-1-extract-csrf',
      transforms: [
        { field: 'phone', transform: 'phone_my' },
        { field: 'fullName', transform: 'trim' },
      ],
      bodyTemplate: {
        fullName: '$params.fullName',
        phone: '$params.phone',
        email: '$params.email',
      },
      verification: {
        path: '/api/patients/:id',
        method: 'GET',
        idParam: 'id',
        expectedFields: {
          fullName: '$params.fullName',
        },
      },
    },
    'appointments.read': {
      recipeId: 'appointments.read',
      type: 'read',
      capability: 'appointments.read',
      method: 'GET',
      path: '/api/appointments',
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
    'appointments.availability': {
      recipeId: 'appointments.availability',
      type: 'read',
      capability: 'appointments.availability',
      method: 'GET',
      path: '/api/appointments/availability',
      extractor: 'slots',
    },
    appointments_availability: {
      recipeId: 'appointments_availability',
      type: 'read',
      capability: 'APPOINTMENT_READ',
      method: 'GET',
      path: '/api/appointments/availability',
      extractor: 'slots',
    },
    'appointments.create': {
      recipeId: 'appointments.create',
      type: 'write',
      capability: 'appointments.create',
      method: 'POST',
      path: '/api/appointments',
      headers: {
        'Content-Type': 'application/json',
      },
      hook: 'vendor-cms-1-extract-csrf',
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
    appointment_create: {
      recipeId: 'appointment_create',
      type: 'write',
      capability: 'APPOINTMENT_WRITE',
      method: 'POST',
      path: '/api/appointments',
      headers: {
        'Content-Type': 'application/json',
      },
      hook: 'vendor-cms-1-extract-csrf',
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
    'appointments.reschedule': {
      recipeId: 'appointments.reschedule',
      type: 'write',
      capability: 'appointments.reschedule',
      method: 'PUT',
      path: '/api/appointments/:id',
      headers: {
        'Content-Type': 'application/json',
      },
      hook: 'vendor-cms-1-extract-csrf',
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
    appointment_reschedule: {
      recipeId: 'appointment_reschedule',
      type: 'write',
      capability: 'APPOINTMENT_WRITE',
      method: 'PUT',
      path: '/api/appointments/:id',
      headers: {
        'Content-Type': 'application/json',
      },
      hook: 'vendor-cms-1-extract-csrf',
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
    'appointments.cancel': {
      recipeId: 'appointments.cancel',
      type: 'write',
      capability: 'appointments.cancel',
      method: 'DELETE',
      path: '/api/appointments/:id',
      hook: 'vendor-cms-1-extract-csrf',
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
    appointment_cancel: {
      recipeId: 'appointment_cancel',
      type: 'write',
      capability: 'APPOINTMENT_WRITE',
      method: 'DELETE',
      path: '/api/appointments/:id',
      hook: 'vendor-cms-1-extract-csrf',
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
    'reference.read': {
      recipeId: 'reference.read',
      type: 'read',
      capability: 'reference.read',
      method: 'GET',
      path: '/api/reference/providers',
      extractor: 'data',
    },
  },
  hooks: ['vendor-cms-1-extract-csrf', 'vendor-cms-1-format-display-time', 'vendor-cms-1-tenant-b-transform'],
  polling: {
    intervalSeconds: 60,
    deltaField: 'updatedAt',
  },
};

export const lamanipulseManifest = {
  adapterId: 'lamanipulse-v1',
  name: 'LamaniPulse Cloud CMS Certified Adapter',
  version: '1.0.0',
  minExtensionVersion: '0.1.0',
  targetOrigin: 'https://app.lamanipulse.com',
  capabilities: [
    'PATIENT_READ',
    'PATIENT_WRITE',
    'APPOINTMENT_READ',
    'APPOINTMENT_WRITE',
    'REFERENCE_DATA_READ',
    'patients.read',
    'patients.create',
    'patients.update',
    'appointments.read',
    'appointments.create',
    'appointments.reschedule',
    'appointments.cancel',
    'reference.read',
  ],
  endpoints: {
    patients: {
      list: '/rest/v1/patients',
      get: '/rest/v1/patients?id=eq.:id',
      create: '/rest/v1/patients',
      update: '/rest/v1/patients?id=eq.:id',
    },
    appointments: {
      list: '/rest/v1/appointments',
      create: '/rest/v1/appointments',
      reschedule: '/rest/v1/appointments?id=eq.:id',
      cancel: '/rest/v1/appointments?id=eq.:id',
    },
    reference: {
      providers: '/rest/v1/profiles',
      services: '/rest/v1/medical_services',
      locations: '/rest/v1/clinic_settings',
    },
  },
  recipes: {
    patients_list: {
      recipeId: 'patients_list',
      type: 'read',
      capability: 'PATIENT_READ',
      method: 'GET',
      path: '/rest/v1/patients?select=*',
    },
    'patients.read': {
      recipeId: 'patients.read',
      type: 'read',
      capability: 'patients.read',
      method: 'GET',
      path: '/rest/v1/patients?select=*',
    },
    patients_get: {
      recipeId: 'patients_get',
      type: 'read',
      capability: 'PATIENT_READ',
      method: 'GET',
      path: '/rest/v1/patients?id=eq.:id&select=*',
    },
    'patients.create': {
      recipeId: 'patients.create',
      type: 'write',
      capability: 'patients.create',
      method: 'POST',
      path: '/rest/v1/patients',
      verification: {
        path: '/rest/v1/patients?id=eq.:id',
      },
    },
    patients_create: {
      recipeId: 'patients_create',
      type: 'write',
      capability: 'PATIENT_WRITE',
      method: 'POST',
      path: '/rest/v1/patients',
      verification: {
        path: '/rest/v1/patients?id=eq.:id',
      },
    },
    'patients.update': {
      recipeId: 'patients.update',
      type: 'write',
      capability: 'patients.update',
      method: 'PUT',
      path: '/rest/v1/patients?id=eq.:id',
      verification: {
        path: '/rest/v1/patients?id=eq.:id',
      },
    },
    patients_update: {
      recipeId: 'patients_update',
      type: 'write',
      capability: 'PATIENT_WRITE',
      method: 'PUT',
      path: '/rest/v1/patients?id=eq.:id',
      verification: {
        path: '/rest/v1/patients?id=eq.:id',
      },
    },
    appointments_list: {
      recipeId: 'appointments_list',
      type: 'read',
      capability: 'APPOINTMENT_READ',
      method: 'GET',
      path: '/rest/v1/appointments?select=*',
    },
    'appointments.read': {
      recipeId: 'appointments.read',
      type: 'read',
      capability: 'appointments.read',
      method: 'GET',
      path: '/rest/v1/appointments?select=*',
    },
    'appointments.create': {
      recipeId: 'appointments.create',
      type: 'write',
      capability: 'appointments.create',
      method: 'POST',
      path: '/rest/v1/appointments',
      verification: {
        path: '/rest/v1/appointments?id=eq.:id',
      },
    },
    appointments_create: {
      recipeId: 'appointments_create',
      type: 'write',
      capability: 'APPOINTMENT_WRITE',
      method: 'POST',
      path: '/rest/v1/appointments',
      verification: {
        path: '/rest/v1/appointments?id=eq.:id',
      },
    },
    'appointments.reschedule': {
      recipeId: 'appointments.reschedule',
      type: 'write',
      capability: 'appointments.reschedule',
      method: 'PUT',
      path: '/rest/v1/appointments?id=eq.:id',
      verification: {
        path: '/rest/v1/appointments?id=eq.:id',
      },
    },
    appointments_reschedule: {
      recipeId: 'appointments_reschedule',
      type: 'write',
      capability: 'APPOINTMENT_WRITE',
      method: 'PUT',
      path: '/rest/v1/appointments?id=eq.:id',
      verification: {
        path: '/rest/v1/appointments?id=eq.:id',
      },
    },
    'appointments.cancel': {
      recipeId: 'appointments.cancel',
      type: 'write',
      capability: 'appointments.cancel',
      method: 'PUT',
      path: '/rest/v1/appointments?id=eq.:id',
      verification: {
        path: '/rest/v1/appointments?id=eq.:id',
      },
    },
    appointments_cancel: {
      recipeId: 'appointments_cancel',
      type: 'write',
      capability: 'APPOINTMENT_WRITE',
      method: 'PUT',
      path: '/rest/v1/appointments?id=eq.:id',
      verification: {
        path: '/rest/v1/appointments?id=eq.:id',
      },
    },
    reference_providers: {
      recipeId: 'reference_providers',
      type: 'read',
      capability: 'REFERENCE_DATA_READ',
      method: 'GET',
      path: '/rest/v1/profiles?select=*',
    },
    reference_services: {
      recipeId: 'reference_services',
      type: 'read',
      capability: 'REFERENCE_DATA_READ',
      method: 'GET',
      path: '/rest/v1/medical_services?select=*',
    },
    reference_locations: {
      recipeId: 'reference_locations',
      type: 'read',
      capability: 'REFERENCE_DATA_READ',
      method: 'GET',
      path: '/rest/v1/clinic_settings?select=*',
    },
    'reference.read': {
      recipeId: 'reference.read',
      type: 'read',
      capability: 'reference.read',
      method: 'GET',
      path: '/rest/v1/profiles?select=*',
    },
  },
  polling: {
    intervalSeconds: 60,
    deltaField: 'updated_at',
  },
};

const signature = signManifest(manifest);
manifest.signature = signature;

const vendorSignature = signManifest(vendorCms1Manifest);
vendorCms1Manifest.signature = vendorSignature;

const lamanipulseSignature = signManifest(lamanipulseManifest);
lamanipulseManifest.signature = lamanipulseSignature;

const manifestDir = path.resolve('src/adapters/manifests');
if (!fs.existsSync(manifestDir)) fs.mkdirSync(manifestDir, { recursive: true });

const manifestContent = JSON.stringify(manifest, null, 2);
fs.writeFileSync(path.join(manifestDir, 'acme-cloud.json'), manifestContent);
fs.writeFileSync(path.resolve('test-harness/fixtures/adapter-manifest.json'), manifestContent);

const vendorManifestContent = JSON.stringify(vendorCms1Manifest, null, 2);
fs.writeFileSync(path.join(manifestDir, 'vendor-cms-1.json'), vendorManifestContent);

const lamanipulseManifestContent = JSON.stringify(lamanipulseManifest, null, 2);
fs.writeFileSync(path.join(manifestDir, 'lamanipulse.json'), lamanipulseManifestContent);

console.log('Manifests successfully built, canonically signed, and saved.');

