// 飞书自建应用推送：支持多个会话（群/人），tenant_access_token + IM 卡片消息
// 多租户：配置（feishu_push）与轮询游标（feishu_last_poll）归各租户库；
// token 缓存按 app_id 区分（各租户自建应用不同，token 互不串）。
const { getSetting, setSetting } = require('../db');

const tokenCaches = new Map();

function getConfig(d) {
  const c = getSetting(d, 'feishu_push', null) || {};
  let targets = Array.isArray(c.targets) ? c.targets : [];
  if (!targets.length && c.receive_id) {
    targets = [{ receive_id_type: c.receive_id_type || 'chat_id', receive_id: c.receive_id, name: '默认' }];
  }
  return { app_id: c.app_id || '', app_secret: c.app_secret || '', targets };
}
function saveConfig(d, cfg) {
  const cur = getConfig(d);
  const targets = (cfg && Array.isArray(cfg.targets))
    ? cfg.targets.filter((t) => t && t.receive_id).map((t) => ({
        receive_id_type: t.receive_id_type || 'chat_id',
        receive_id: String(t.receive_id).trim(),
        name: t.name || '',
      }))
    : cur.targets;
  setSetting(d, 'feishu_push', {
    app_id: (cfg && cfg.app_id) || cur.app_id,
    app_secret: (cfg && cfg.app_secret && cfg.app_secret !== '******') ? cfg.app_secret : cur.app_secret,
    targets,
  });
}

async function getToken(d) {
  const now = Date.now();
  const cfg = getConfig(d);
  if (!cfg.app_id || !cfg.app_secret) throw new Error('飞书应用 App ID / App Secret 未配置');
  const cached = tokenCaches.get(cfg.app_id);
  if (cached && cached.token && cached.expire > now + 60000) return cached.token;
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.app_id, app_secret: cfg.app_secret }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('飞书 token 获取失败: ' + j.msg);
  tokenCaches.set(cfg.app_id, { token: j.tenant_access_token, expire: now + (j.expire || 7200) * 1000 });
  if (tokenCaches.size > 30) tokenCaches.delete(tokenCaches.keys().next().value); // 上限保护
  return j.tenant_access_token;
}

async function listChats(d) {
  const token = await getToken(d);
  const r = await fetch('https://open.feishu.cn/open-apis/im/v1/chats?page_size=50', {
    headers: { Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('列出群失败: ' + j.msg);
  return (j.data && j.data.items) || [];
}

// 发 markdown 卡片到单个会话
async function sendToTarget(d, target, title, markdown) {
  const token = await getToken(d);
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: String(title).slice(0, 100) }, template: 'violet' },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: String(markdown).slice(0, 2800) } }],
  };
  const r = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=' + target.receive_id_type, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ receive_id: target.receive_id, msg_type: 'interactive', content: JSON.stringify(card) }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`${target.name || target.receive_id}: ${j.msg}`);
  return true;
}

// 发 markdown 卡片到所有会话
async function sendMarkdown(d, title, markdown) {
  const cfg = getConfig(d);
  if (!cfg.targets || !cfg.targets.length) throw new Error('未配置任何推送会话（会话ID）');
  const errors = [];
  for (const t of cfg.targets) {
    try { await sendToTarget(d, t, title, markdown); } catch (e) { errors.push(e.message); }
  }
  if (errors.length) throw new Error('部分会话发送失败 → ' + errors.join('；'));
  return cfg.targets.length;
}

// 发表格卡片到单个会话
// 完整对应 Java 参考实现 buildTableCard：
//   card = { schema:"2.0", config:{update_multi}, header:{title,template:purple,padding}, body:{direction,padding,elements:[table]} }
//   table = { tag:"table", page_size, row_height:"low", header_style:{grey底/加粗/left}, columns:[{name,display_name,data_type}], rows }
//   表头由 header_style 渲染（灰底加粗）——不再把表头拼进 rows，数据行 key 与列 name 对应
async function sendTableToTarget(d, target, title, columns, rows) {
  const token = await getToken(d);
  // 列定义（name=行数据 key；display_name=表头显示；text 类型纯文本安全）
  const tableColumns = columns.map((c) => ({
    name: String(c),
    display_name: String(c),
    data_type: 'text',
  }));
  // 表头样式：灰底 + 加粗 + 左对齐 + 单行
  const headerStyle = {
    text_align: 'left',
    text_size: 'normal',
    background_style: 'grey',
    bold: true,
    lines: 1,
  };
  // 表格组件：rows 为行数据（key 与列 name 对应），不再包含表头行
  const table = {
    tag: 'table',
    page_size: 5,
    row_height: 'low',
    header_style: headerStyle,
    columns: tableColumns,
    rows: rows.map((r) => {
      const obj = {};
      columns.forEach((c, i) => { obj[String(c)] = String(r[i] == null ? '' : r[i]).slice(0, 500); });
      return obj;
    }),
  };
  const body = {
    direction: 'vertical',
    padding: '12px 12px 12px 12px',
    elements: [table],
  };
  const header = {
    title: { tag: 'plain_text', content: String(title).slice(0, 100) },
    template: 'purple',
    padding: '12px 12px 12px 12px',
  };
  const config = { update_multi: true };
  const card = { schema: '2.0', config, header, body };
  const r = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=' + target.receive_id_type, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ receive_id: target.receive_id, msg_type: 'interactive', content: JSON.stringify(card) }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`${target.name || target.receive_id}: ${j.msg}`);
  return true;
}

// 发表格卡片到所有会话
async function sendTableAll(d, title, columns, rows) {
  const cfg = getConfig(d);
  if (!cfg.targets || !cfg.targets.length) throw new Error('未配置推送会话');
  const errors = [];
  for (const t of cfg.targets) {
    try { await sendTableToTarget(d, t, title, columns, rows); } catch (e) { errors.push(e.message); }
  }
  if (errors.length) throw new Error('部分失败: ' + errors.join('；'));
  return cfg.targets.length;
}

// 结构化数据 → markdown 表格
function rowsToMd(columns, rows) {
  const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  let md = '| ' + columns.map(esc).join(' | ') + ' |\n';
  md += '|' + columns.map(() => '---').join('|') + '|\n';
  for (const r of rows) md += '| ' + r.map(esc).join(' | ') + ' |\n';
  return md;
}

// 表格元素（旧版，保留兼容）
function tableElement(columns, rows) {
  return {
    tag: 'table',
    page_size: Math.min(rows.length, 20),
    row_height: 'low',
    columns: columns.map((c) => ({ name: String(c), data_type: 'text', horizontal_align: 'left' })),
    rows: rows.map((r) => {
      const obj = {};
      columns.forEach((c, i) => { obj[String(c)] = String(r[i] == null ? '' : r[i]).slice(0, 500); });
      return obj;
    }),
  };
}

// 群触发词轮询（按租户库：游标 feishu_last_poll 与 skill 匹配都是租户维度）
async function pollTriggers(d) {
  const cfg = getConfig(d);
  if (!cfg.targets || !cfg.targets.length) return;
  const skillSvc = require('./businessSkillService');
  const last = getSetting(d, 'feishu_last_poll', {}) || {};
  const newLast = { ...last };
  for (const t of cfg.targets) {
    if (t.receive_id_type !== 'chat_id') continue;
    try {
      const token = await getToken(d);
      const r = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=' + t.receive_id + '&page_size=20&sort_type=ByCreateTimeDesc', {
        headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000),
      });
      const j = await r.json();
      const items = (j.code === 0 && j.data && j.data.items) ? j.data.items : [];
      const latest = items.length ? Number(items[0].create_time) : 0;
      const since = Number(last[t.receive_id] || 0);
      const toProcess = since === 0 ? (items[0] ? [items[0]] : []) : items.filter((m) => Number(m.create_time) > since).reverse();
      for (const m of toProcess) {
        if (m.msg_type !== 'text') continue;
        let txt = ''; try { txt = (JSON.parse(m.body.content || '{}').text || '').trim(); } catch {}
        const hit = skillSvc.matchSkill(d, txt);
        if (hit) {
          console.log('[feishu] 群触发词命中「' + txt + '」→ skill ' + hit.name);
          skillSvc.runSkillById(d, hit.id, { onlyTarget: { receive_id: t.receive_id, receive_id_type: t.receive_id_type } }).catch((e) => console.warn('[feishu] skill 执行失败:', e.message));
        }
      }
      newLast[t.receive_id] = latest;
    } catch (e) { console.warn('[feishu poll] 群读取失败:', e.message); }
  }
  setSetting(d, 'feishu_last_poll', newLast);
}

module.exports = { getConfig, saveConfig, getToken, listChats, sendMarkdown, sendToTarget, sendTableToTarget, sendTableAll, rowsToMd, tableElement, pollTriggers };
