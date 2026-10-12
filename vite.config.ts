import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Keep JSZip and its browser shims behind the delivery workflow's
          // dynamic import instead of folding them into the eager React vendor chunk.
          if (/\/node_modules\/(jszip|pako|lie|immediate|readable-stream|core-util-is|inherits|isarray|process-nextick-args|safe-buffer|string_decoder|util-deprecate|setimmediate)\//.test(id)) {
            return 'jszip';
          }
          if (id.includes('/node_modules/')) return 'vendor';
          if (id.includes('/src/canvas/webgl-renderer.ts')) return 'webgl-renderer';
          // The always-used Canvas renderer is an independently cacheable
          // rendering boundary; keep editor orchestration below the 300 kB gate.
          if (id.includes('/src/canvas/renderer.ts')) return 'canvas-renderer';
          return undefined;
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/collaboration': {
        target: 'http://127.0.0.1:1234',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/collaboration': {
        target: 'http://127.0.0.1:1234',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
