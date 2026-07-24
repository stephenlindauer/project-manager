import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'client',
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5273,
    proxy: {
      '/api': 'http://127.0.0.1:5274',
      '/pty': { target: 'ws://127.0.0.1:5274', ws: true },
      '/events': { target: 'http://127.0.0.1:5274', ws: true },
    },
  },
})
