import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const collaborationPort = process.env.COLLABORATION_PORT ?? '1234';
const allowedHosts = ['.e2b.app', ...(process.env.VITE_ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim()).filter(Boolean)];

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
          // rendering boundary, separate from editor orchestration.
          if (id.includes('/src/canvas/renderer.ts')) return 'canvas-renderer';
          return undefined;
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    allowedHosts,
    proxy: {
      '/collaboration': {
        target: `http://127.0.0.1:${collaborationPort}`,
        ws: true,
        xfwd: true,
        changeOrigin: true,
        configure(proxy) {
          // http-proxy does not set x-forwarded-host for WebSocket upgrades.
          // Overwrite client-supplied values with the actual accepted app host.
          proxy.on('proxyReqWs', (proxyRequest, request) => {
            proxyRequest.setHeader('x-forwarded-host', request.headers.host ?? '');
          });
        },
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts,
    proxy: {
      '/collaboration': {
        target: `http://127.0.0.1:${collaborationPort}`,
        ws: true,
        xfwd: true,
        changeOrigin: true,
        configure(proxy) {
          // http-proxy does not set x-forwarded-host for WebSocket upgrades.
          // Overwrite client-supplied values with the actual accepted app host.
          proxy.on('proxyReqWs', (proxyRequest, request) => {
            proxyRequest.setHeader('x-forwarded-host', request.headers.host ?? '');
          });
        },
      },
    },
  },
});
