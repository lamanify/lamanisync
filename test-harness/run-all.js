#!/usr/bin/env node
import { MockCmsServer } from './mock-cms/server.js';
import { MockSyncApiServer } from './mock-sync-api/server.js';

const cmsPort = process.env.CMS_PORT ? parseInt(process.env.CMS_PORT, 10) : 4001;
const syncPort = process.env.SYNC_PORT ? parseInt(process.env.SYNC_PORT, 10) : 4002;

const cmsServer = new MockCmsServer(cmsPort);
const syncServer = new MockSyncApiServer(syncPort);

async function startAll() {
  await Promise.all([cmsServer.start(), syncServer.start()]);
  console.log('\n--- LamaniSync Local Test Harness Active ---');
  console.log(`Mock CMS:      http://localhost:${cmsPort}`);
  console.log(`Mock Sync API: http://localhost:${syncPort}`);
  console.log('Press Ctrl+C to terminate both servers.\n');
}

function shutdown() {
  console.log('\nShutting down test harness servers...');
  Promise.all([cmsServer.stop(), syncServer.stop()]).then(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startAll().catch((err) => {
  console.error('Error starting test harness:', err);
  process.exit(1);
});
