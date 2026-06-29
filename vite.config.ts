import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'client'),
  build: {
    outDir: path.resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Allow any host. The Vite dev server is reached through exe.dev's hostname
    // (and whatever else you put in front), so we disable the host allow-list.
    // Dev-only — prod (`bun start`) is a plain Bun server, not Vite.
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
