import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import esbuild from 'esbuild';
import manifest from './manifest.config';

function dynamicScriptsBundler(): Plugin {
  return {
    name: 'dynamic-scripts-bundler',
    apply: 'build',
    async closeBundle() {
      await esbuild.build({
        entryPoints: ['src/content/content-script.ts'],
        outfile: 'dist/content-script.js',
        bundle: true,
        format: 'iife',
        target: 'chrome114',
      });
      await esbuild.build({
        entryPoints: ['src/page/page-world.ts'],
        outfile: 'dist/page-world.js',
        bundle: true,
        format: 'iife',
        target: 'chrome114',
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), crx({ manifest }), dynamicScriptsBundler()],
  test: {
    globals: true,
    environment: 'jsdom',
  },
});
