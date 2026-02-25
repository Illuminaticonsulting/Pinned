import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    globals: true,
    environment: 'node',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3002',
        ws: true,
      },
      '/blofin-api': {
        target: 'https://openapi.blofin.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/blofin-api/, ''),
        secure: true,
      },
      '/tv-search': {
        target: 'https://symbol-search.tradingview.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tv-search/, ''),
        secure: true,
      },
      '/yahoo-api': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/yahoo-api/, ''),
        secure: true,
      },
    },
  },
});
