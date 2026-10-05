// IM 连接器 API（v1.10.5，需求①~⑤）——**本模块独占 `/api/im/*`**。
//
// 权限：auth.js 的 pageForPath 把 `/im` 映射到 **notes 页**（记录最终落成笔记，界面入口也在笔记页），
// 少写一行就静默降级成「仅需登录」，所以这里和 auth.js 两处必须同时存在。
//
// 唯一一个免登录端点：`GET /im/callback`（飞书 OAuth 回跳）。那条请求是**浏览器从飞书那边跳回来的**，
// 非网关部署时工作台令牌只在 localStorage，压根不带 Authorization 头 —— 所以它进 index.js 的 EXEMPT，
// 靠一次性、10 分钟过期的 state 反查用户（见 imService.takeState）。回跳只写自己租户库的连接器记录。
const express = require('express');
const svc = require('../services/imService');

const router = express.Router();

function int(v, field = 'id') {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    const e = new Error(`${field} 必须是整数`);
    e.code = 400;
    throw e;
  }
  return n;
}

function ok(fn) {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((e) => {
        if (e && e.code === 400) return res.status(400).json({ error: e.message });
        if (e && e.code === 404) return res.status(404).json({ error: e.message });
        if (e && e.code === 502) return res.status(502).json({ error: e.message });
        console.error('[im]', req.method, req.originalUrl, e);
        res.status(500).json({ error: '服务端错误：' + (e && e.message ? e.message : '未知') });
      });
  };
}

// ---------- 平台清单（界面上「钉钉/企业微信为什么灰着」就靠这里说清楚） ----------
router.get('/im/providers', ok((req, res) => res.json(Object.values(svc.PROVIDERS))));

// ---------- 连接器 CRUD ----------
router.get('/im/connectors', ok((req, res) => res.json(svc.listConnectors(req.tdb))));
router.post('/im/connectors', ok((req, res) => res.json(svc.createConnector(req.tdb, req.body || {}))));
router.put('/im/connectors/:id', ok((req, res) => {
  const c = svc.updateConnector(req.tdb, int(req.params.id), req.body || {});
  if (!c) return res.status(404).json({ error: '连接器不存在' });
  res.json(c);
}));
router.delete('/im/connectors/:id', ok((req, res) => {
  const r = svc.deleteConnector(req.tdb, int(req.params.id));
  if (!r) return res.status(404).json({ error: '连接器不存在' });
  res.json({ ok: true, ...r });
}));
// 解除授权：只丢令牌，配置与已导出的笔记都留着
router.post('/im/connectors/:id/revoke', ok((req, res) => {
  const c = svc.revokeConnector(req.tdb, int(req.params.id));
  if (!c) return res.status(404).json({ error: '连接器不存在' });
  res.json(c);
}));

// ---------- 授权 / 同步 ----------
router.post('/im/connectors/:id/authorize', ok((req, res) =>
  res.json({ url: svc.authorizeUrl(req.tdb, req.user.id, int(req.params.id)) })));
router.get('/im/connectors/:id/chats', ok((req, res) =>
  res.json(svc.listChats(req.tdb, int(req.params.id)))));
router.post('/im/connectors/:id/chats', ok((req, res) =>
  res.json(svc.addChat(req.tdb, int(req.params.id), req.body || {}))));
router.delete('/im/chats/:id', ok((req, res) => res.json({ ok: true, deleted: svc.delChat(req.tdb, int(req.params.id)) })));
router.get('/im/connectors/:id/logs', ok((req, res) =>
  res.json(svc.listLogs(req.tdb, int(req.params.id), Number(req.query.limit) || 100))));
// 同步前的估算（只读）。前端点「同步」之前先拿这个，把「要发多少请求、大概多久、被限流会怎样」
// 摆给用户看，确认了才真发 POST。跟 POST 用同一套 since_days 口径，免得估算和实跑对不上。
router.get('/im/connectors/:id/sync-preview', ok((req, res) => {
  const days = Number(req.query.since_days);
  res.json(svc.syncPreview(req.tdb, int(req.params.id), {
    sinceDays: Number.isFinite(days) && days > 0 ? Math.min(days, 3650) : 30,
  }));
}));

// 同步：一次请求只干最多 ~45 秒的活（见 imService.syncConnector 顶部关于 Cloudflare 超时的注释）。
// 没干完就返回 done=false + remaining，前端带着返回的 round 再发一次，直到 done=true。
// 这样任何单次请求都远在网关的超时上限之内，长同步不会再被掐成一张错误页。
router.post('/im/connectors/:id/sync', ok(async (req, res) => {
  const b = req.body || {};
  const days = Number(b.since_days);
  const id = int(req.params.id);
  // 互斥（v1.10.14）：定时任务和手动点同步撞在一起，会把同一批消息各追加一遍
  // （每个会话的游标是拉完之后才写的）。抢不到锁就明确告诉用户是谁在跑，别让他干等。
  if (!svc.lockSync(id)) {
    return res.status(409).json({ error: '这条连接器正在同步中（多半是定时任务在跑），等它跑完再试' });
  }
  try {
    const stat = await svc.syncConnector(req.tdb, id, {
      sinceDays: Number.isFinite(days) && days > 0 ? Math.min(days, 3650) : 30,
      round: typeof b.round === 'string' ? b.round.slice(0, 32) : '',
    });
    res.json(stat);
  } finally {
    svc.unlockSync(id);
  }
}));

// ---------- OAuth 回跳（免登录） ----------
// 只认 state：它在主库里映射到 (uid, connector_id)，一次性、10 分钟过期。
// 返回一张极简 HTML（用户在手机飞书里看到的最后一屏），并且给一个回工作台的链接。
router.get('/im/callback', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  svc.handleCallback(req.query.code, req.query.state)
    .then((r) => {
      const back = r.uid ? `${base}/#/notes` : `${base}/`;
      res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IM 授权</title>
<style>body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#f6f7f9;margin:0;padding:48px 20px;color:#222}
.card{max-width:460px;margin:0 auto;background:#fff;border-radius:12px;padding:26px 24px;box-shadow:0 2px 14px rgba(0,0,0,.08)}
h1{font-size:18px;margin:0 0 10px}p{line-height:1.7;color:#444;margin:8px 0}
.ok{color:#0a7d33}.err{color:#c0392b}a.btn{display:inline-block;margin-top:14px;padding:9px 16px;background:#3370ff;color:#fff;border-radius:8px;text-decoration:none}</style>
</head><body><div class="card">
<h1 class="${r.ok ? 'ok' : 'err'}">${r.ok ? '✅ 授权成功' : '⚠️ 授权没完成'}</h1>
<p>${String(r.message || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>
${r.ok ? '<p>可以关掉这个页面，回工作台「笔记 → IM连接」点「同步」开始拉取。</p>' : '<p>请回到工作台重试。</p>'}
<a class="btn" href="${back}">回到工作台</a>
</div>
<script>setTimeout(function(){try{window.close()}catch(e){}},2500)</script>
</body></html>`);
    })
    .catch((e) => {
      console.error('[im] callback', e);
      res.status(500).set('Content-Type', 'text/html; charset=utf-8')
        .send('<!doctype html><meta charset="utf-8"><p>授权处理失败：' + String(e.message || e).replace(/[<>&]/g, '') + '</p>');
    });
});

module.exports = router;
