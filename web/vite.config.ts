import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 前端构建产物输出到 web/dist，由后端 Express 静态托管。
// 开发模式下把 /api 代理到后端 3000 端口，避免跨域。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // antd 单独拆包，首屏加载更快
        manualChunks: {
          react: ['react', 'react-dom'],
          antd: ['antd', '@ant-design/icons'],
        },
      },
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
