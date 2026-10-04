// 全局快捷键注册表（v1.9.41）。
//
// 设计要点：
// ① **只挂一个 window keydown**，所有快捷键进同一张表 —— 笔记壳里有编辑器、弹窗、切换器，
//    各挂各的监听器必然会互相抢 preventDefault，最后谁也说不清谁生效；
// ② 匹配是**严格**的：声明了 ctrl 就要求按下 ctrl（macOS 上 Ctrl 与 Cmd 等价处理），
//    没声明就要求没按 —— 否则 Ctrl+S 会被裸 s 抢走；
// ③ 「在输入框里一律不触发」是默认行为：笔记页大部分时间光标在 textarea 里，
//    Ctrl+P/S/O 这类必须显式 allowInField 才在编辑区生效（且由调用方自己想清楚会不会干扰打字）。
import { onBeforeUnmount } from 'vue';

const registry = new Set();
let bound = false;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

function normKey(e) {
  const k = String(e.key || '');
  if (k === ' ') return 'space';
  if (k === 'Esc') return 'escape';
  return k.toLowerCase();
}

function inField(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

// spec.ctrl / spec.alt / spec.shift：true = 必须按，false/缺省 = 必须不按
function matches(spec, e) {
  if (normKey(e) !== String(spec.key).toLowerCase()) return false;
  const wantCtrl = !!spec.ctrl;
  const hasCtrl = !!(e.ctrlKey || e.metaKey);
  if (wantCtrl !== hasCtrl) return false;
  if (!!spec.alt !== !!e.altKey) return false;
  if (!!spec.shift !== !!e.shiftKey) return false;
  return true;
}

function onKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return; // 中文输入法组字中，别抢键
  const field = inField(e.target);
  // 倒序 = 后注册的优先：同一个组合键被内外两层都注册时，内层（后挂载的）说了算
  for (const s of Array.from(registry).reverse()) {
    if (!s.enabled()) continue;
    if (field && !s.allowInField) continue;
    if (!matches(s, e)) continue;
    if (s.preventDefault !== false) e.preventDefault();
    s.handler(e);
    return;
  }
}

function ensureBound() {
  if (bound || typeof window === 'undefined') return;
  window.addEventListener('keydown', onKeydown);
  bound = true;
}

/**
 * 注册一个快捷键，返回注销函数。
 * @param {{key:string, ctrl?:boolean, alt?:boolean, shift?:boolean, handler:Function,
 *          enabled?:()=>boolean, allowInField?:boolean, preventDefault?:boolean, description?:string}} spec
 */
export function registerShortcut(spec) {
  if (!spec || !spec.key || typeof spec.handler !== 'function') return () => {};
  const entry = {
    key: String(spec.key),
    ctrl: !!spec.ctrl,
    alt: !!spec.alt,
    shift: !!spec.shift,
    handler: spec.handler,
    enabled: typeof spec.enabled === 'function' ? spec.enabled : () => true,
    allowInField: !!spec.allowInField,
    preventDefault: spec.preventDefault,
    description: spec.description || '',
  };
  registry.add(entry);
  ensureBound();
  return () => registry.delete(entry);
}

// 组件里用：随组件卸载自动注销
export function useShortcut(spec) {
  const off = registerShortcut(spec);
  onBeforeUnmount(off);
  return off;
}

// 使用说明页 / 命令面板要列「当前生效的快捷键」
export function listShortcuts() {
  return Array.from(registry).map((s) => ({
    key: s.key, ctrl: s.ctrl, alt: s.alt, shift: s.shift, description: s.description,
  }));
}

// Ctrl / Cmd 的显示名（Windows 上写 Ctrl，Mac 上写 ⌘）
export function prettyShortcut(s) {
  const parts = [];
  if (s.ctrl) parts.push(isMac ? '⌘' : 'Ctrl');
  if (s.alt) parts.push(isMac ? '⌥' : 'Alt');
  if (s.shift) parts.push(isMac ? '⇧' : 'Shift');
  const k = String(s.key);
  const named = { escape: 'Esc', space: 'Space', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', enter: 'Enter', backspace: '⌫', delete: 'Del' };
  parts.push(named[k.toLowerCase()] || k.toUpperCase());
  return parts.join(isMac ? '' : '+');
}

export const IS_MAC = isMac;
