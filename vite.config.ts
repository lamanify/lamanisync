/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    rollupOptions: {
      input: {
        'content-script': 'src/content/content-script.ts',
        'page-world': 'src/page/page-world.ts',
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === 'content-script' || chunk.name === 'page-world') {
            return '[name].js';
          }
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
  },
});
