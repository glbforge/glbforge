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
  },
  optimizeDeps: { exclude: ['sharp'] },
  server: {
    // In dev, the API lives on the `glbforge ui` server.
    proxy: { '/api': 'http://127.0.0.1:5177' },
  },
});
