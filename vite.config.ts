import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client lives in client/ and is served by the API server in production.
// In development Vite proxies /api to the Fastify server on API_PORT.
const apiPort = process.env.API_PORT ?? '3001';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: { outDir: '../dist/client', emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 800 },
  server: {
    port: Number(process.env.PORT ?? 5173),
    proxy: { '/api': `http://127.0.0.1:${apiPort}`, '/healthz': `http://127.0.0.1:${apiPort}` },
  },
});
