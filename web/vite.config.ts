import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const devToken = process.env.AGENTDESK_DEV_TOKEN ?? process.env.AGENT_HISTORY_DEV_TOKEN ?? 'dev-token';

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4782',
        headers: { Authorization: `Bearer ${devToken}` },
      },
    },
  },
});
