import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'LamaniSync',
  version: '0.1.0',
  description: 'Secure bridge between authenticated cloud CMS tabs and LamaniHub',
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  action: {
    default_popup: 'popup.html',
    default_icon: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  permissions: ['storage', 'scripting', 'alarms', 'declarativeNetRequest'],
  // Backend Sync API endpoint for background service worker (Rule 13 / CHROMEWEBSTORE.md).
  // Runtime CMS permissions remain strictly dynamic via optional_host_permissions (Rule 3).
  host_permissions: ['https://app.lamanihub.com/*'],
  optional_host_permissions: [
    'https://app.lamanipulse.com/*',
    'https://vxnvdmepejjhvphqxopl.supabase.co/*',
    'https://*/*',
  ],
});
