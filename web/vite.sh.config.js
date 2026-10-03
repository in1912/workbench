import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
import { renameSync, existsSync } from 'node:fs';

// Vite 对 HTML 入口按「相对 root 的路径」产出文件，入口叫 sh.html 产物就叫 sh.html。
// 但服务端的静态托管（server/index.js）统一按 <outDir>/index.html 判定「这是一个可用的构建」，
// 两个应用走同一段代码更不容易出错 —— 所以在打包结束时把 sh.html 改名成 index.html。
// base 是 './'，产物里的资源引用本来就是相对路径（./assets/...），单改名即可，无需改写内容。
const renameToIndex = () => {
  let outDir = '';
  return {
    name: 'sh-rename-to-index',
    apply: 'build',
    configResolved(cfg) { outDir = cfg.build.outDir; }, // 解析后的绝对路径（含时间戳子目录）
    closeBundle() {
      const src = resolve(outDir, 'sh.html');
      if (existsSync(src)) renameSync(src, resolve(outDir, 'index.html'));
    },
  };
};

// 智能家居独立应用的前端构建（v2.0.0）——与主工作台的 vite.config.js **分开**跑：
//   主应用： npm run build:web       → web/dist/<时间戳>/      （入口 index.html）
//   独立应用：npm run build:web:sh   → web/dist-sh/<时间戳>/   （入口 sh.html）
//
// 为什么用同一个工程而不是 fork 一份前端：智能家居的 6 个页签里有米家/设置/参数翻译三段
// 巨型内联模板，还有 XiaozhiPanel(1345 行)/CcLightPanel/VideoCenterPanel —— 复制一份必然两边腐烂。
// 这里只是「再开一个入口」，业务组件全部共享。
export default defineConfig({
  plugins: [vue(), renameToIndex()],
  base: './',
  server: { port: 5174, proxy: { '/api': { target: 'http://localhost:7778', changeOrigin: true } } },
  build: {
    // 时间戳子目录：服务端每次请求解析最新的（server/index.js 的 latestDist()），重建前端不用重启服务
    outDir: `dist-sh/${new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '').replace(' ', '-')}`,
    emptyOutDir: true,
    chunkSizeWarningLimit: 1024,
    rollupOptions: {
      // 入口名必须叫 index：产物落成 <outDir>/index.html，服务端 latestDist() 才认得（与主应用同构）
      input: { index: resolve(import.meta.dirname, 'sh.html') },
    },
  },
});
