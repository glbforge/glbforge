import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // In dev, the API lives on the `glbforge ui` server.
    proxy: { '/api': 'http://127.0.0.1:5177' },
  },
});
