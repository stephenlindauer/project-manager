import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// PM_PORT moves the API the dev server proxies to, PM_WEB_PORT the dev server
// itself — so a second copy can run beside the installed service.
const api = `127.0.0.1:${process.env.PM_PORT || 5274}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'client',
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: Number(process.env.PM_WEB_PORT || 5273),
    proxy: {
      '/api': `http://${api}`,
      '/pty': { target: `ws://${api}`, ws: true },
      '/events': { target: `http://${api}`, ws: true },
    },
  },
})
