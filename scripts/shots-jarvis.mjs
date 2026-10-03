// 给 JARVIS 应用拍一组界面截图（写 README 用）
//
// 用一份**全新的空数据目录**起服务：截图里不会出现任何用户的米家设备、账号、聊天记录。
// 用法：node scripts/shots-jarvis.mjs [输出目录]        （默认 <仓库>/img/jarvis）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'img', 'jarvis'));
const DATA = path.join(ROOT, 'data', 'tmp-sh-app-shots');
const PORT = 3999;
const B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [文件名, 侧栏模块, 子页签或 null]
const SHOTS = [
  ['01-mijia-unbound', '米家', null],
  ['02-board-jarvis', '智能板', null],
  ['03-board-setup', '智能板', '装机向导'],
  ['04-board-voice', '智能板', '语音控米家'],
  ['05-cclight', 'Agent红绿灯', null],
  ['06-mijia-settings', '米家设置', null],
  ['07-mijia-terms', '米家参数翻译', null],
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

let srv, browser;
try {
  srv = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, WB_MODE: 'smarthome', PORT: String(PORT), DATA_DIR: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', () => {});
  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { await fetch(`${B}/api/system-info`); up = true; break; } catch { /* 未就绪 */ }
  }
  if (!up) throw new Error('服务 20 秒内没起来');

  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await p.goto(`${B}/`, { waitUntil: 'networkidle' });
  await sleep(1200);

  for (const [name, mod, sub] of SHOTS) {
    await p.getByRole('button', { name: mod, exact: true }).click();
    await sleep(900);
    if (sub) {
      const tab = p.locator('.xz-tabs button, .ccp-tabs button').filter({ hasText: sub }).first();
      if (await tab.count()) { await tab.click(); await sleep(900); }
      else console.log(`  跳过子页签「${sub}」：没找到`);
    }
    const file = path.join(OUT, `${name}.png`);
    await p.screenshot({ path: file, fullPage: true });
    console.log(`  ✓ ${name}.png  ${(fs.statSync(file).size / 1024).toFixed(0)}KB`);
  }
  console.log(`截图完成 → ${OUT}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (srv) srv.kill();
}
