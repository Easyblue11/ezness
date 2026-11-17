import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

export default defineConfig({
  plugins: [react()],
  // One source of truth for the version shown in the title bar / About page.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // Relative base so the built index.html loads correctly from file:// inside Electron.
  base: './',
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
