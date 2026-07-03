import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/ga-api': {
        target: 'https://ga-health.gongu.xyz',
        changeOrigin: true,
        rewrite: (requestPath) => requestPath.replace(/^\/ga-api/, ''),
      },
    },
  },
})
