// 笔记分享链接拼装 + 复制（v1.9.39）
// 分享链接 = 外网域名（管理员在「设置→多平台」配置；未配置时按当前访问源回落）
//            + fnOS 网关前缀 + 哈希路由 + token + 4 位访问码
import { api, prefixUrl } from '../api';
import { netZone } from './netZone';

let extCache = null;
// 外网域名：登录即可读（GET /settings/external-base）；读不到就回落当前源
export async function loadExternalBase() {
  if (extCache !== null) return extCache;
  try {
    const d = await api.get('/settings/external-base');
    extCache = String(d.external || '').replace(/\/+$/, '');
  } catch { extCache = ''; }
  return extCache;
}

export function baseOf(external) {
  const e = String(external || '').replace(/\/+$/, '');
  if (e) return e;
  const cur = (netZone() === 'wan' ? location.origin : '').replace(/\/+$/, '');
  return cur || location.origin;
}

// 分享页地址（给访客点，码已带上，打开即看）
export function shareLink(external, token, code) {
  return `${baseOf(external)}${prefixUrl('')}/#/s/${token}?c=${encodeURIComponent(code)}`;
}

// 外部写入地址（给外部 AI/系统当回调，只写）
export function intakeLink(external, token) {
  return `${baseOf(external)}${prefixUrl('/api')}/note-intake/${token}`;
}

// 复制：优先剪贴板 API（https/localhost 安全上下文），http 局域网回落 execCommand
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 落到兜底 */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}
