import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev-only convenience: the built app is served by Fastify itself later.
    proxy: {
      '/v1': { target: 'http://127.0.0.1:7777', changeOrigin: true },
      '/plugins': { target: 'http://127.0.0.1:7777', changeOrigin: true },
    },
  },
});
