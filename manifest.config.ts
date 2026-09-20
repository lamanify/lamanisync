import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'LamaniSync Dev',
  version: '0.1.0',
  description: 'Secure bridge between authenticated cloud CMS tabs and LamaniHub',
  action: {
    default_popup: 'popup.html',
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  permissions: ['storage', 'scripting', 'alarms'],
  optional_host_permissions: ['http://localhost:4001/*', 'https://*/*'],
});
