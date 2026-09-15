import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { fileURLToPath } from 'node:url';

export default defineConfig(async () => ({
  plugins: [
    react(),
    {
      name: 'capture-development-csp',
      apply: 'serve',
      transformIndexHtml: {
        order: 'post',
        handler(html, context) {
          // React's development refresh preamble is inline. The packaged
          // capture entry keeps its strict, external-script-only policy.
          return context.path === '/capture.html'
            ? html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
            : html;
        },
      },
    },
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
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        capture: fileURLToPath(new URL('./capture.html', import.meta.url)),
      },
    },
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
