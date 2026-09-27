import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://backend:4000',
        changeOrigin: true,
      },
      '/yjs': {
        target: 'ws://backend:4000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
