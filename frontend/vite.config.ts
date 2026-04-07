import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const backendPort = process.env.BACKEND_PORT || '8000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': `http://127.0.0.1:${backendPort}`,
      '/health': `http://127.0.0.1:${backendPort}`,
    },
  },
})
