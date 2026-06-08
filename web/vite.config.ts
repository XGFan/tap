import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/__gateway/app/',
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      '/__gateway/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        // Disable buffering for SSE streams
        configure: (proxy) => {
          proxy.on('proxyReq', (_proxyReq, _req, res) => {
            res.setHeader('X-Accel-Buffering', 'no')
          })
        },
      },
      '/__gateway/app': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
