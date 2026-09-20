// 电视/遥控器模式（v3.0）：D-pad 方向键在页面可聚焦元素间做几何最近移动，
// 确定键 = 激活当前焦点元素，返回键 = 转成 Escape（关闭弹窗）/ 由 APP 壳处理历史后退。
// 启用方式：① 安卓电视 APP（WebView UA 带 FamilyLearningTV 标识）自动启用；
// ② 浏览器/平板 localStorage wb_tv_mode=1 手动启用（「多平台 → 电视版」有预览开关）。
// 两种输入都归一到同一套 move()/enter()：浏览器走 window keydown，
// APP 壳里 Activity 拦截 DPAD 键后经 evaluateJavascript 调 window.__tvKey(dir)（避免双重派发）。
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
const UA_MARK = 'FamilyLearningTV';

let active = false;

function visible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none' && st.pointerEvents !== 'none';
}

function candidates(exclude) {
  const out = [];
  for (const el of document.querySelectorAll(FOCUSABLE)) {
    if (el === exclude || !visible(el)) continue;
    out.push(el);
  }
  return out;
}

// 从 from 出发往 dir 方向找几何上最近的候选：主轴分量必须为正、斜向不超过 ~65°，
// 评分 = 主轴距离 + 横向偏离 ×2.5（优先正对着的下一个元素）
function bestInDir(from, dir) {
  const fr = from ? from.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
  const fc = { x: fr.left + fr.width / 2, y: fr.top + fr.height / 2 };
  let best = null;
  let bestScore = Infinity;
  for (const el of candidates(from)) {
    const r = el.getBoundingClientRect();
    const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const dx = c.x - fc.x;
    const dy = c.y - fc.y;
    let primary;
    let secondary;
    if (dir === 'left') { if (dx > -4) continue; primary = -dx; secondary = Math.abs(dy); }
    else if (dir === 'right') { if (dx < 4) continue; primary = dx; secondary = Math.abs(dy); }
    else if (dir === 'up') { if (dy > -4) continue; primary = -dy; secondary = Math.abs(dx); }
    else if (dir === 'down') { if (dy < 4) continue; primary = dy; secondary = Math.abs(dx); }
    else continue;
    if (secondary > primary * 2.2) continue; // 大角度斜向不选（那是另一个方向的职责）
    const score = primary + secondary * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

function current() {
  const el = document.activeElement;
  return el && el !== document.body && el.isConnected ? el : null;
}

export function focusFirst() {
  if (!active) return;
  const list = candidates(null);
  if (list.length) list[0].focus({ preventScroll: false });
}

export function move(dir) {
  if (!active) return false;
  const from = current();
  const next = bestInDir(from, dir);
  if (!next) return false;
  next.focus();
  try { next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); } catch { /* 老内核 */ }
  return true;
}

export function enter() {
  if (!active) return false;
  const el = current();
  if (!el) return false;
  el.click();
  return true;
}

// 浏览器键盘输入（预览模式 / 平板外接键盘）：方向键 + Enter + Esc
function onKey(e) {
  const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  const dir = map[e.key];
  if (dir) {
    if (move(dir)) e.preventDefault();
    return;
  }
  if (e.key === 'Enter' && enter()) e.preventDefault();
}

// APP 壳桥接入口：window.__tvKey('up'|'down'|'left'|'right'|'enter'|'back')
// back 转成 Escape keydown —— 页面里所有 Esc 处理（关图片查看器/弹窗）免费复用；
// 弹窗没吃掉时由 APP 壳的 goBack() 兜底（壳层通过返回值无法同步判断，直接两层都做）。
export function installBridge() {
  window.__tvKey = (dir) => {
    if (dir === 'enter') return enter();
    if (dir === 'back') {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    }
    return move(dir);
  };
}

// 路由切换后重新落焦（新视图的元素完全换了一批）
function onRouteChange() {
  if (active) setTimeout(focusFirst, 120);
}

export function startTvNav() {
  if (active) return;
  active = true;
  document.body.classList.add('tv-mode');
  window.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', onRouteChange);
  focusFirst();
}

export function stopTvNav() {
  if (!active) return;
  active = false;
  document.body.classList.remove('tv-mode');
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('hashchange', onRouteChange);
  const el = current();
  if (el) try { el.blur(); } catch { /* 忽略 */ }
}

export function tvModeOn() {
  return document.body.classList.contains('tv-mode');
}

// 应用启动时调用：电视 APP（UA 标识）或手动开启过（localStorage）则自动进入电视模式
export function maybeStartTvNav() {
  installBridge();
  try {
    const ua = navigator.userAgent || '';
    const manual = localStorage.getItem('wb_tv_mode') === '1';
    if (ua.includes(UA_MARK) || manual) startTvNav();
  } catch { /* localStorage 不可用就算了 */ }
}
