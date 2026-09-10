import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { fileURLToPath } from 'node:url';

export default defineConfig(async () => ({
  plugins: [
    react(),
    process.env.ANALYZE_BUNDLE === 'true' &&
      visualizer({
        filename: 'reports/bundle-stats.html',
        gzipSize: true,
        brotliSize: true,
      }),
  ],
  // Relative asset paths so the packaged Electron app can load dist/index.html
  // from file:// without resolving /assets against the filesystem root.
  base: './',
  resolve: {
    alias: [
      {
        find: /^@droidex\/icons$/,
        replacement: fileURLToPath(new URL('./packages/icons/src/index.ts', import.meta.url)),
      },
    ],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/electron/**'],
    },
  },
}));
