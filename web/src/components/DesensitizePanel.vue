<template>
  <div>
    <!-- ============ 一、说明与原理 ============ -->
    <div class="card" style="margin-bottom:14px">
      <h3 class="foldhead">
        <span class="ft" @click="docOpen = !docOpen">
          <span class="caret">{{ docOpen ? '▾' : '▸' }}</span>说明与原理
        </span>
        <span class="muted" style="font-weight:400;font-size:12.5px">脱敏在本机服务器上完成，不经过 AI</span>
      </h3>
      <div v-show="docOpen">
        <p class="muted" style="line-height:1.85;margin:0 0 10px">
          工作台调用的 AI 是「设置 → AI 模型」里那个第三方网关，原文一旦发出去就出了本机。本功能在
          <b>把语料交给 AI 之前</b>，用<b>纯本机规则</b>（不调用 AI、不联网）把专有名词换成一组随机代码，
          AI 只看到 <code>PER-7K2M9</code> 这样的代号；AI 返回后再按对照表把代码<b>拼回原词</b>。
          于是「AI 照常干活」与「专有名词不出门」可以同时成立。
        </p>
        <ol class="steps">
          <li><b>抽取</b>：按下面的规则扫一遍文本，找出公司名 / 人名 / 部门 / 群名 / 账号 / 密码 / API KEY 等。</li>
          <li><b>生成本轮随机代码</b>：同一名词在<b>同一轮里固定同一个代码</b>（否则 AI 会把同一个人当成两个人），跨轮重新随机。</li>
          <li><b>替换</b>：按词长从长到短替换（先替「张三丰」再替「张三」，不会把它截成半个）。</li>
          <li><b>发送</b>：把替换后的文本发给 AI。</li>
          <li><b>复原</b>：AI 返回后按对照表把代码拼回原词，页面上看到的仍是原话。</li>
        </ol>
        <p class="muted" style="line-height:1.85;margin:10px 0 0">
          <b>能做什么</b>：账号 / 密码 / API KEY / 邮箱 / 手机号 / 身份证是正则，准；公司名靠后缀词锚定，也稳。<br>
          <b>做不到什么</b>：<b>人名与部门是启发式</b>——靠姓氏字典 + 称谓词（张总 / 李经理）+ 引号 + 调用方给的名字提示
          （IM 复盘会拿聊天里的说话人与群名当提示），<b>必然有漏网和误伤</b>。这两类请用下面的
          <b>固定关键词表</b>打补丁：写进去的词一律被替换。
        </p>
        <p class="muted" style="line-height:1.85;margin:10px 0 0">
          <b>代码只在本轮有效</b>，「名词 → 代码」的对照历史只落在本机租户库里，不出本机。
        </p>
      </div>
    </div>

    <!-- ============ 二、规则配置 ============ -->
    <div class="card" style="margin-bottom:14px">
      <h3>规则配置
        <span class="muted" style="font-weight:400;font-size:12.5px">所有接入的页面共用这一套</span>
      </h3>
      <label class="row" style="gap:8px;cursor:pointer;margin-bottom:10px">
        <input type="checkbox" :checked="cfg.enabled" @change="cfg.enabled = $event.target.checked" style="width:auto" />
        <span>启用数据脱敏<span class="muted">（各页面还有自己的「本次是否脱敏」开关，这里是总开关）</span></span>
      </label>

      <label class="fl">识别类型（缺省全开；取消勾选即不识别该类）</label>
      <div class="types">
        <label v-for="t in types" :key="t.key" class="titem" :title="t.hint">
          <input type="checkbox" :checked="on(t.key)" @change="toggleType(t.key, $event.target.checked)" style="width:auto" />
          <span>{{ t.label }}</span>
          <span class="muted s">{{ t.hint }}</span>
        </label>
      </div>

      <label class="row" style="gap:8px;cursor:pointer;margin-top:14px">
        <input type="checkbox" :checked="cfg.mask_numbers" @change="cfg.mask_numbers = $event.target.checked" style="width:auto" />
        <span>数值也做脱敏（金额 / 数量 / 编号 等数字换成代码）</span>
      </label>
      <div class="warn">
        ⚠️ <b>勾选后 AI 将无法对数字做加减与比较</b>（它看到的是 <code>NUM-8K3P2</code> 而不是 1280 与 960），
        涉及金额合计、数量核对、时间推算的问答可能因此算错。不确定就别勾。
      </div>

      <label class="fl">固定关键词对照表<span class="muted">（一行一个；人名/部门这类启发式识别不了的词写这里。也支持「原词=自定义代码」）</span></label>
      <textarea v-model="fixedText" rows="5" style="width:100%" placeholder="例：&#10;张三&#10;杭州未来科技&#10;内部项目代号=X-001"></textarea>

      <div class="row" style="margin-top:12px">
        <button class="primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存配置' }}</button>
        <span v-if="saveMsg" class="small" :class="saveErr ? 'err-text' : 'ok-text'">{{ saveMsg }}</span>
      </div>
    </div>

    <!-- ============ 三、试运行 ============ -->
    <div class="card" style="margin-bottom:14px">
      <h3>试运行
        <span class="muted" style="font-weight:400;font-size:12.5px">粘一段文字，立刻看脱敏结果与对照表（只脱敏，不调用 AI）</span>
      </h3>
      <textarea v-model="sample" rows="6" style="width:100%" placeholder="粘贴一段包含人名 / 公司 / 账号的文本，看看会被替换成什么…"></textarea>
      <div class="row" style="margin-top:10px">
        <button class="primary" :disabled="trying || !sample.trim()" @click="tryRun">{{ trying ? '处理中…' : '试运行' }}</button>
        <span v-if="tryErr" class="small err-text">{{ tryErr }}</span>
      </div>
      <template v-if="tried">
        <label class="fl">脱敏后（发给 AI 的样子）</label>
        <pre class="out">{{ tried.masked }}</pre>
        <label class="fl">对照表<span class="muted">{{ tried.mapping.length }} 项</span></label>
        <div v-if="!tried.mapping.length" class="muted">没有识别到需要替换的内容。</div>
        <table v-else class="tb">
          <thead><tr><th>类型</th><th>原名</th><th>随机代码</th></tr></thead>
          <tbody>
            <tr v-for="(m, i) in tried.mapping" :key="i">
              <td><span class="badge blue">{{ typeLabel(m.type) }}</span></td>
              <td>{{ m.term }}</td>
              <td><code>{{ m.code }}</code></td>
            </tr>
          </tbody>
        </table>
      </template>
    </div>

    <!-- ============ 四、脱敏历史 ============ -->
    <div class="card">
      <h3>脱敏历史
        <span class="row" style="gap:6px">
          <select v-model="hScope" class="small" @change="loadHistory">
            <option value="">全部来源</option>
            <option value="llm_chat">LLM在线模型</option>
            <option value="im_review">AI复盘IM</option>
            <option value="note_ai">笔记AI</option>
            <option value="manual">试运行</option>
          </select>
          <button class="small" @click="loadHistory">刷新</button>
          <button class="small danger" :disabled="!history.length" @click="clearAll">清空</button>
        </span>
      </h3>
      <div v-if="!history.length" class="muted">还没有脱敏记录。用上面的试运行，或在 IM 复盘 / 笔记 AI 里勾选脱敏后，这里会留下对照历史。</div>
      <table v-else class="tb">
        <thead><tr><th>时间</th><th>来源</th><th>项数</th><th>状态</th><th></th></tr></thead>
        <tbody>
          <template v-for="h in history" :key="h.id">
            <tr>
              <td class="mono">{{ h.created_at }}</td>
              <td>{{ scopeLabel(h.scope) }}</td>
              <td>{{ h.item_count }}</td>
              <td><span class="badge" :class="h.status === 'sent' ? 'green' : h.status === 'failed' ? 'red' : 'amber'">{{ statusLabel(h.status) }}</span></td>
              <td class="row" style="gap:4px;justify-content:flex-end">
                <button class="small" @click="toggleExpand(h.id)">{{ expanded.has(h.id) ? '收起' : '看对照' }}</button>
                <button class="small danger" @click="delOne(h.id)">删</button>
              </td>
            </tr>
            <tr v-if="expanded.has(h.id)">
              <td colspan="5">
                <div v-if="!h.mapping.length" class="muted">这一轮没有替换任何词。</div>
                <table v-else class="tb inner">
                  <tbody>
                    <tr v-for="(m, i) in h.mapping" :key="i">
                      <td><span class="badge blue">{{ typeLabel(m.type) }}</span></td>
                      <td>{{ m.term }}</td>
                      <td><code>{{ m.code }}</code></td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
// AI 脱敏（v1.13.0）——效率工具页「AI脱敏」tab：给其他页面调用的脱敏能力中心。
// 规则配置 / 原理说明 / 试运行 / 对照历史。真正的引擎在服务端 desensitizeService.js，
// 本组件只是它的控制台（IM复盘、笔记AI 直接在后端调引擎，不经过这里）。
import { ref, onMounted } from 'vue';
import { api } from '../api';

const types = ref([]);
const cfg = ref({ enabled: false, mask_numbers: false, types: {}, fixed_terms: [] });
const fixedText = ref('');
const saving = ref(false);
const saveMsg = ref('');
const saveErr = ref(false);
const docOpen = ref(true);

const sample = ref('');
const trying = ref(false);
const tryErr = ref('');
const tried = ref(null);

const history = ref([]);
const hScope = ref('');
const expanded = ref(new Set());

// 类型缺省视为开启（与后端 optionsFrom 同口径）：只有显式 false 才算关
const on = (k) => cfg.value.types[k] !== false;
function toggleType(k, v) { cfg.value.types = { ...cfg.value.types, [k]: v }; }

function typeLabel(k) { return (types.value.find((t) => t.key === k) || {}).label || k; }
function scopeLabel(s) { return { llm_chat: 'LLM在线模型', im_review: 'AI复盘IM', note_ai: '笔记AI', manual: '试运行' }[s] || s; }
function statusLabel(s) { return { sent: '已发送', done: '已完成', empty: '无命中', preview: '待确认', failed: '失败' }[s] || s; }

// 固定关键词表在界面里就是一个 textarea（一行一个，支持「原词=代码」），保存时解析成数组
function parseFixed(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { const i = l.indexOf('='); return i > 0 ? { term: l.slice(0, i).trim(), code: l.slice(i + 1).trim() } : { term: l, code: '' }; });
}
function fixedToText(list) {
  return (Array.isArray(list) ? list : []).map((it) => (it && it.code ? `${it.term}=${it.code}` : (it && it.term) || it)).join('\n');
}

async function save() {
  saving.value = true; saveMsg.value = ''; saveErr.value = false;
  try {
    cfg.value = await api.put('/desensitize/config', {
      enabled: cfg.value.enabled, mask_numbers: cfg.value.mask_numbers,
      types: cfg.value.types, fixed_terms: parseFixed(fixedText.value),
    });
    fixedText.value = fixedToText(cfg.value.fixed_terms);
    saveMsg.value = '已保存';
  } catch (e) { saveMsg.value = e.message; saveErr.value = true; }
  finally { saving.value = false; setTimeout(() => { saveMsg.value = ''; }, 2500); }
}

async function tryRun() {
  trying.value = true; tryErr.value = '';
  try {
    const r = await api.post('/desensitize/preview', { text: sample.value });
    tried.value = { masked: r.masked, mapping: r.mapping || [] };
    loadHistory();
  } catch (e) { tryErr.value = e.message; }
  finally { trying.value = false; }
}

async function loadHistory() {
  try {
    const r = await api.get('/desensitize/history' + (hScope.value ? `?scope=${hScope.value}` : ''));
    history.value = r.items || [];
    expanded.value = new Set();
  } catch { history.value = []; }
}
function toggleExpand(id) { const s = new Set(expanded.value); s.has(id) ? s.delete(id) : s.add(id); expanded.value = s; }
async function delOne(id) { try { await api.del(`/desensitize/history/${id}`); loadHistory(); } catch (e) { alert(e.message); } }
async function clearAll() {
  if (!confirm('清空脱敏历史（对照表）？此操作不可撤销。')) return;
  try { await api.del('/desensitize/history' + (hScope.value ? `?scope=${hScope.value}` : '')); loadHistory(); } catch (e) { alert(e.message); }
}

onMounted(async () => {
  try {
    const m = await api.get('/desensitize/meta');
    types.value = m.types || [];
    cfg.value = m.config || cfg.value;
    fixedText.value = fixedToText(cfg.value.fixed_terms);
  } catch (e) { saveMsg.value = e.message; saveErr.value = true; }
  loadHistory();
});
</script>

<style scoped>
.foldhead { cursor: pointer; }
.foldhead .ft { display: inline-flex; align-items: center; gap: 2px; user-select: none; }
.foldhead .ft:hover { color: var(--accent, #4a7dff); }
.caret { display: inline-block; width: 14px; color: var(--text2); font-size: 12px; }
.fl { display: block; font-size: 12.5px; color: var(--text2); margin: 12px 0 5px; }
.steps { margin: 0; padding-left: 20px; line-height: 1.9; font-size: 13px; color: var(--text2); }
.steps code, .out code { background: var(--bg3); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
.types { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 6px 14px; }
.titem { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
.titem .s { font-size: 11.5px; }
.warn { margin-top: 8px; padding: 8px 11px; border-radius: 8px; font-size: 12.5px; line-height: 1.75;
  background: rgba(251,191,36,.12); color: var(--amber, #b26a00); border: 1px solid rgba(251,191,36,.35); }
.warn code { background: rgba(0,0,0,.12); border-radius: 4px; padding: 1px 5px; }
.out { white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto;
  border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; background: var(--bg3);
  font-size: 12.5px; line-height: 1.7; margin: 0; }
.tb { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
.tb th, .tb td { border-bottom: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
.tb th { color: var(--text2); font-weight: 600; font-size: 12px; }
.tb.inner td { padding: 4px 10px; border-bottom: 1px dashed var(--border); }
.tb code { background: var(--bg3); border-radius: 4px; padding: 1px 6px; font-size: 12px; }
.mono { font-variant-numeric: tabular-nums; white-space: nowrap; }
.err-text { color: var(--red, #d93025); }
.ok-text { color: var(--green, #34d399); }
</style>
