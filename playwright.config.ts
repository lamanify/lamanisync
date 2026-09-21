import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const pathToExtension = path.resolve('dist');

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 30000,
  retries: 0,
  workers: 1,
  use: {
    headless: true,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium-with-extension',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            `--disable-extensions-except=${pathToExtension}`,
            `--load-extension=${pathToExtension}`,
            '--headless=new',
          ],
        },
      },
    },
  ],
});
