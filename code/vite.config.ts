import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 前端源码在 code/web/，构建产物 code/web/dist（由 Node 服务直接托管）。
export default defineConfig({
  root: 'web',
  base: '/',
  plugins: [react()],
  server: {
    port: 4518,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4519', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
})
