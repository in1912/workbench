// 本地直连探测（全局共享一份）：无论用域名还是 IP 登录，App 启动即在后台探测
// 设置→本地直连配置的内网地址（fetch /api/health，2.5 秒超时，health 带 ACAO * 可跨源），
// 可达则学习页大文件（视频/音频/PDF/图片）自动改走该地址。探测是后台异步请求，不阻塞界面。
// 学习页与内外网徽标共用同一份缓存（wb_local_base，与设置页保存后清缓存的键一致，勿改名）
// 和同一事件（wb-local-base，探测完成广播），单飞去重避免重复发请求。
import { api } from '../api';
import { netZone } from './netZone';

const KEY = 'wb_local_base';
const OK_TTL = 10 * 60 * 1000;   // 可达：10 分钟内不重测
const FAIL_TTL = 60 * 1000;      // 不可达/未配置：1 分钟后允许重测（切回内网能较快恢复）

function readCache() {
  try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; }
}
function writeCache(base, ok) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ base, ok, at: Date.now() })); } catch { /* 私密模式等 */ }
}

// 当前生效的本地源前缀；已在内网地址上访问时无需直连（当前源本身就是局域网）
export function effectiveBase() {
  if (netZone() === 'lan') return '';
  const c = readCache();
  return c && c.ok && Date.now() - c.at < OK_TTL ? c.base : '';
}

// 通道全貌：lan=当前就在内网地址上；configured=设置里配了地址；ok=探测可达；base=生效的本地源前缀
export function localState() {
  if (netZone() === 'lan') return { lan: true, configured: false, ok: true, base: '' };
  const c = readCache();
  const fresh = c && Date.now() - c.at < (c.ok ? OK_TTL : FAIL_TTL);
  return { lan: false, configured: !!(fresh && c.base), ok: !!(fresh && c.ok), base: fresh && c.ok ? c.base : '' };
}

let probing = null;   // 单飞：App 启动 / 徽标 / 学习页同时触发也只发一次
export function probeLocalBase(force = false) {
  if (netZone() === 'lan') return Promise.resolve('');           // 已经在内网，同源即最快通道
  if (!localStorage.getItem('wb_token')) return Promise.resolve(''); // 未登录无从读设置
  const c = readCache();
  if (!force && c && Date.now() - c.at < (c.ok ? OK_TTL : FAIL_TTL)) return Promise.resolve(c.ok ? c.base : '');
  if (probing) return probing;
  probing = (async () => {
    let base = '';
    try {
      const d = await api.get('/settings/local-base');
      base = String((d && d.base) || '').trim().replace(/\/+$/, '');
    } catch { /* 设置读取失败视为未配置 */ }
    let ok = false;
    if (base && base !== location.origin) {
      try { ok = (await fetch(base + '/api/health', { signal: AbortSignal.timeout(2500), cache: 'no-store' })).ok; } catch { ok = false; }
    }
    writeCache(base, ok);
    window.dispatchEvent(new CustomEvent('wb-local-base'));   // 徽标/学习页即时更新
    return ok ? base : '';
  })().finally(() => { probing = null; });
  return probing;
}
