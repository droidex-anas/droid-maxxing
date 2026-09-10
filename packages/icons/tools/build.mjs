import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// Vite preserves JSX purity annotations so unused glyphs can be tree-shaken.
await build({
  configFile: false,
  root: fileURLToPath(new URL('..', import.meta.url)),
  logLevel: 'warn',
  build: {
    outDir: 'dist',
    emptyOutDir: false, // Keep the declarations emitted by tsc.
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('../src/index.ts', import.meta.url)),
      formats: ['es'],
    },
    rollupOptions: {
      external: [/^react(?:\/|$)/],
      output: { preserveModules: true, entryFileNames: '[name].js' },
    },
  },
});
