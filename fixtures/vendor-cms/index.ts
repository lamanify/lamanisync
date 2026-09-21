/**
 * Vendor CMS #1 Synthetic Fixtures Index
 * Strictly synthetic Malaysian healthcare fixtures for contract testing & certification.
 * AGENTS.md Rule 5: Zero production patient data.
 */

import tenantAPatients from './tenant-a-patients.json';
import tenantAAppointments from './tenant-a-appointments.json';
import tenantAReference from './tenant-a-reference.json';
import tenantAConfig from './tenant-a-config.json';

import tenantBPatients from './tenant-b-patients.json';
import tenantBAppointments from './tenant-b-appointments.json';
import tenantBReference from './tenant-b-reference.json';
import tenantBConfig from './tenant-b-config.json';

export {
  tenantAPatients,
  tenantAAppointments,
  tenantAReference,
  tenantAConfig,
  tenantBPatients,
  tenantBAppointments,
  tenantBReference,
  tenantBConfig,
};

export interface TenantConfig {
  tenantId: string;
  tenantName: string;
  environment: string;
  origin: string;
  fieldMappings: Record<string, unknown>;
  auth: {
    cookieName: string;
    csrfTokenHeader: string;
    csrfMetaSelector: string;
  };
}

export function getTenantFixture(tenant: 'A' | 'B') {
  if (tenant === 'A') {
    return {
      patients: tenantAPatients,
      appointments: tenantAAppointments,
      reference: tenantAReference,
      config: tenantAConfig as TenantConfig,
    };
  }
  return {
    patients: tenantBPatients,
    appointments: tenantBAppointments,
    reference: tenantBReference,
    config: tenantBConfig as TenantConfig,
  };
}
