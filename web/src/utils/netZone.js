// 内外网判定：按当前访问地址的主机名判断（纯前端、无请求，加载时即定）。
// 内网 = 环回/私网 IPv4/IPv6 ULA/链路本地/*.local 等内网域名；其余（公网域名、公网 IP）= 外网。
export function netZone(host) {
  const h = String(host || (typeof location !== 'undefined' ? location.hostname : '')).toLowerCase();
  if (!h) return 'wan';
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return 'lan';
  // IPv4：127/8 环回、10/8、192.168/16、172.16-31、169.254 链路本地
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    if (a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) return 'lan';
    return 'wan';
  }
  // IPv6：::1 环回、fc/fd 唯一本地（ULA）、fe80 链路本地
  if (h.includes(':')) {
    if (h === '::1') return 'lan';
    if (/^f[cd]/.test(h) || h.startsWith('fe80')) return 'lan';
    return 'wan';
  }
  // 普通域名：公网域名（公网域名）→ 外网；域名解析到内网的场景让位于地址栏明确性
  return 'wan';
}
