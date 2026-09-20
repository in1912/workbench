import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    // 宿主环境对"进程退出后文件"实施写保护（mv/覆盖被拒），每次构建输出到时间戳子目录，
    // 由服务端自动托管最新构建产物（见 server/index.js）
    outDir: `dist/${new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '').replace(' ', '-')}`,
    chunkSizeWarningLimit: 1024,
  },
});
