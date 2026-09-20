<template>
  <!-- 富文本录入框：Ctrl+V 直接粘贴图片（即传即显、与文字混排），📎 可点击上传 -->
  <div class="richbox">
    <div ref="box" class="rb-edit" contenteditable="true" :data-ph="placeholder"
      @input="emitVal" @paste="onPaste" @keydown.enter.prevent="onEnter" @blur="onBlur"></div>
    <button type="button" class="rb-btn" :disabled="uploading > 0"
      :title="uploading > 0 ? '图片上传中…' : '上传图片'" @click="fileEl.click()">{{ uploading > 0 ? '⏳' : '📎' }}</button>
    <input ref="fileEl" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" multiple hidden @change="onFileChange" />
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue';
import { api } from '../api';

const props = defineProps({ modelValue: { type: String, default: '' }, placeholder: { type: String, default: '' } });
const emit = defineEmits(['update:modelValue', 'uploading']);
const box = ref(null);
const fileEl = ref(null);
const uploading = ref(0);
let inner = false; // 本次变化由编辑框自身 emit 引起，跳过回写

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// 外部值 → 可编辑 HTML：富文本原样，纯文本转义 + 换行
const toHtml = (s) => {
  const t = String(s || '');
  return /<(img|br)\b/i.test(t) ? t : esc(t).replace(/\n/g, '<br>');
};

onMounted(() => { box.value.innerHTML = toHtml(props.modelValue); });
watch(uploading, (n) => emit('uploading', n > 0), { immediate: true }); // 让外层能拦住"上传中就提交"

// 外部重置（提交后清空表单等）同步到编辑框
watch(() => props.modelValue, (v) => {
  if (inner) { inner = false; return; }
  if (box.value && toHtml(v) !== serialize()) box.value.innerHTML = toHtml(v);
});

// 序列化：占位提示剥掉、Chrome 换行容器 <div> 展开、临时 token 剥掉、除 img/br 外标签全部清除 → 安全 HTML 存库
function serialize() {
  return (box.value?.innerHTML || '')
    .replace(/<span class="rb-up"[^>]*>[^<]*<\/span>/gi, '')
    .replace(/<div[^>]*>/gi, '<br>').replace(/<\/div>/gi, '')
    .replace(/(<img\b[^>]*src="\/api\/family-images\/\d+)\?token=[^"]*(")/gi, '$1$2')
    .replace(/<(?!\/?(?:img|br)\b)[^>]*>/gi, '');
}
function emitVal() {
  inner = true;
  emit('update:modelValue', serialize());
}
// 换行统一插 <br>（避免浏览器插 <div> 造成结构混乱）
function onEnter() { document.execCommand('insertLineBreak'); emitVal(); }
// 空内容清干净，让 CSS placeholder 生效
function onBlur() {
  if (!box.value.querySelector('img, .rb-up') && !box.value.textContent.trim() && box.value.innerHTML) {
    box.value.innerHTML = '';
    emitVal();
  }
}

function onPaste(e) {
  const items = Array.from(e.clipboardData?.items || []);
  const imgs = items.filter((i) => i.kind === 'file' && /^image\//.test(i.type)).map((i) => i.getAsFile()).filter(Boolean);
  if (imgs.length) { e.preventDefault(); for (const f of imgs) uploadAndInsert(f); return; }
  // 非图片一律按纯文本插入，防止外部 HTML 带进标签
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain') || '';
  if (text) document.execCommand('insertText', false, text);
  emitVal();
}

async function uploadAndInsert(f) {
  if (f.size > 5 * 1024 * 1024) { alert('图片超过 5MB，请压缩后再粘贴'); return; }
  if (!box.value) return; // 组件已卸载（理论上粘贴/选文件时它还在，防御性兜底）
  uploading.value++;
  // 同步先插"上传中"占位：用户立刻看到反馈；后续原位替换成图片。
  // 不再依赖 focus()+execCommand（上传期间页面切走会拿 null.focus 报错、失焦后插入位置也会漂移）
  const ph = document.createElement('span');
  ph.className = 'rb-up';
  ph.textContent = '⏳图片上传中…';
  const sel = window.getSelection();
  if (document.activeElement === box.value && sel.rangeCount && box.value.contains(sel.anchorNode)) {
    const r = sel.getRangeAt(0);
    r.deleteContents();
    r.insertNode(ph);
    const after = document.createTextNode(''); // 光标落在占位之后，继续打字顺序正确
    ph.after(after);
    sel.removeAllRanges();
    const nr = document.createRange();
    nr.setStart(after, 0);
    sel.addRange(nr);
  } else {
    box.value.appendChild(ph); // 📎选完文件焦点已在框外：追加到末尾
  }
  emitVal();
  try {
    const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(f); });
    const r = await api.post('/family-images', { data });
    const el = box.value;
    if (!el || !ph.isConnected) return; // 等待期间切走页面/表单被重置：无处可插，静默放弃（finally 统一减计数）
    // 编辑框内联显示需要 token（<img> 带不了请求头）；serialize 时会剥掉，存库保持干净 URL
    const img = document.createElement('img');
    img.src = `/api/family-images/${r.id}?token=${encodeURIComponent(localStorage.getItem('wb_token') || '')}`;
    ph.replaceWith(img);
    emitVal();
  } catch (e) {
    if (ph.isConnected) ph.remove();
    emitVal();
    alert('图片上传失败：' + e.message);
  } finally {
    uploading.value--;
  }
}
function onFileChange(e) { for (const f of e.target.files || []) uploadAndInsert(f); e.target.value = ''; }
</script>

<style scoped>
.richbox { display: flex; gap: 6px; align-items: flex-start; border: 1px solid var(--border);
  border-radius: 8px; background: var(--bg2); padding: 4px 8px; min-height: 40px; }
.richbox:focus-within { border-color: rgba(79, 124, 247, 0.6); }
.rb-edit { flex: 1; min-height: 30px; max-height: 220px; overflow-y: auto; outline: none;
  font-size: 13.5px; line-height: 1.55; word-break: break-word; white-space: pre-wrap; padding-top: 5px; }
.rb-edit:empty::before { content: attr(data-ph); color: var(--text3); pointer-events: none; }
.rb-btn { background: none; border: none; cursor: pointer; font-size: 15px; padding: 6px 2px 2px; opacity: 0.75; flex-shrink: 0; }
.rb-btn:hover { opacity: 1; }
.rb-btn:disabled { opacity: 0.4; cursor: wait; }
</style>

<!-- 非 scoped：编辑框内运行时插入的元素（上传图片 img、"上传中"占位 span）没有 scoped 的 data-v 属性，
     scoped 选择器匹配不到它们（曾导致大图按原始尺寸显示、占位无样式），必须用全局规则 -->
<style>
.rb-edit img { max-width: 100%; max-height: 220px; border-radius: 6px; margin: 2px 0; vertical-align: bottom; height: auto; }
.rb-up { color: var(--text3); font-size: 12px; background: rgba(79, 124, 247, 0.12); border-radius: 6px; padding: 1px 8px; }
</style>
