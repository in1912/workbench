// 笔记导出（v1.9.41）——从 views/Notes.vue 原样搬出来的 MD / HTML 导出。
//
// 行为刻意保持一字不差（含「录音笔记每次下载都问一次要不要内嵌音频」那两个 confirm），
// 因为这是用户已经习惯的流程；只是把它从视图里挪出来，让新三栏外壳与新编辑器都能复用。
import { rawUrl } from '../api';
import { renderMarkdown, escapeHtml } from './markdown';

export const safeFileName = (n) => String(n?.title || '笔记').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '笔记';

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function blobToB64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1] || '');
    fr.onerror = () => rej(new Error('读取音频失败'));
    fr.readAsDataURL(blob);
  });
}

// 录音笔记：每次下载都问一次要不要把音频嵌进文件（内嵌为 data URI，文件可离线独立打开）
export async function buildAudioTag(note) {
  if (!note?.record_id) return '';
  if (!confirm('这条是录音笔记。\n\n「确定」= 文件内嵌入音频播放器\n「取消」= 只导出文字')) return '';
  try {
    const res = await fetch(rawUrl(`/api/vibe/audio/${note.record_id}?inline=1`));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    if (blob.size > 12 * 1024 * 1024) {
      if (!confirm(`音频约 ${(blob.size / 1048576).toFixed(1)} MB，内嵌后文件会明显变大，继续？`)) return '';
    }
    return `<audio controls preload="none" src="data:${blob.type || 'audio/mpeg'};base64,${await blobToB64(blob)}"></audio>`;
  } catch (e) { alert('读取音频失败：' + e.message); return ''; }
}

/** 导出 Markdown（概要 + 标签 + 正文 [+ 内嵌音频]） */
export async function downloadNoteMd(note) {
  const n = note || {};
  let text = `# ${n.title || '未命名'}\n\n`;
  if (n.summary) text += `> ${n.summary}\n\n`;
  if (n.tags) text += `标签：${Array.isArray(n.tags) ? n.tags.join(', ') : n.tags}\n\n`;
  text += String(n.content || '');
  const a = await buildAudioTag(n);
  if (a) text += `\n\n${a}\n`;
  saveBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }), `${safeFileName(n)}.md`);
}

const HTML_CSS = `
body{max-width:760px;margin:40px auto;padding:0 18px;font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1f2937;background:#fff}
h1{font-size:26px;line-height:1.35;margin:0 0 6px}
.meta{color:#6b7280;font-size:13px;margin-bottom:18px}
.summary{background:#f3f4f6;border-radius:8px;padding:12px 14px;color:#374151;font-size:14px;margin-bottom:20px}
audio{width:100%;margin:14px 0}
pre{background:#f6f8fa;padding:12px;border-radius:8px;overflow:auto}
code{background:#f6f8fa;padding:1px 5px;border-radius:4px;font-size:.92em}
pre code{background:none;padding:0}
img{max-width:100%}
blockquote{border-left:3px solid #d1d5db;margin:0;padding-left:14px;color:#4b5563}
table{border-collapse:collapse}td,th{border:1px solid #e5e7eb;padding:6px 10px}
.wl{color:#2563eb;border-bottom:1px dashed currentColor}
@media(prefers-color-scheme:dark){body{background:#111827;color:#e5e7eb}pre,code{background:#1f2937}.summary{background:#1f2937;color:#d1d5db}.meta{color:#9ca3af}}
`;

/**
 * 导出独立 HTML（样式内联，双击就能离线看）。
 * @param {object} note
 * @param {(name:string)=>string} [labelFn] 分类/文件夹显示名（'general' → '未分类' 之类）
 */
export async function downloadNoteHtml(note, labelFn = (x) => x) {
  const n = note || {};
  const a = await buildAudioTag(n);
  const tags = Array.isArray(n.tags) ? n.tags.join(', ') : (n.tags || '');
  const head = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(n.title || '笔记')}</title>
<style>${HTML_CSS}</style></head><body>
<h1>${escapeHtml(n.title || '未命名')}</h1>
<div class="meta">${escapeHtml(labelFn(n.folder_path || n.category) || '')} · ${escapeHtml(n.updated_at || '')}${tags ? ' · ' + escapeHtml(tags) : ''}</div>
${n.summary ? `<div class="summary">${escapeHtml(n.summary)}</div>` : ''}
${a}
`;
  // 导出的文件里双链点不动，渲染成普通文字而不是坏链接
  const html = head + renderMarkdown(n.content || '', { wikiStyle: 'plain' }) + '\n</body></html>';
  saveBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${safeFileName(n)}.html`);
}
