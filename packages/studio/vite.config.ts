import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // @glbforge/core lazily imports sharp + node builtins in Node-only code
    // paths the browser never executes; stub them out of the bundle.
    alias: { sharp: '/src/stubs/empty.ts' },
  },
  build: {
    rollupOptions: { external: [/^node:/] },
    // Rollup's CommonJS interop picks between inlining a CJS module and
    // wrapping it in a lazy require() shim, and with the default 'auto' that
    // choice races: identical source builds React's `scheduler` one way or the
    // other, shifting the chunk content and every content hash with it. The
    // committed build then churns ~380 lines for no source change. Always
    // wrapping costs ~4.6KB across the bundle and makes the output reproducible.
    commonjsOptions: { strictRequires: true },
  },
  optimizeDeps: { exclude: ['sharp'] },
  server: {
    // In dev, the API lives on the `glbforge ui` server.
    proxy: { '/api': 'http://127.0.0.1:5177' },
  },
});
