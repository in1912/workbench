// 本地烧录工具包下载（v2.0.0）
//   GET /flashtool/info     固件/驱动的就绪情况 + 默认回连地址（面板显示与排障用）
//   GET /flashtool/package  打包下载（网页 + esptool-js + 两个设备的固件 + CH343 驱动）
// 权限：走全局认证中间件（登录 + smarthome 页授权）；智能家居独立应用里是内置管理员，全开。
const express = require('express');
const svc = require('../services/flashToolService');

const router = express.Router();

router.get('/flashtool/info', (req, res) => {
  const av = svc.availability();
  res.json({
    ...av,
    bridgeUrl: svc.bridgeUrlFor(req),
    ready: av.xiaozhi.ready && av.cclight.ready,
    // 提示语由服务端给，前端不拼字符串（缺什么说得清）
    missing: [
      ...av.xiaozhi.files.filter((f) => !f.ok).map((f) => `智能板 ${f.name}`),
      ...(!av.cclight.firmware.ok ? [`红绿灯 ${svc.CCLIGHT_BIN}`] : []),
      ...(!av.cclight.program.ok ? [`红绿灯 ${svc.CCLIGHT_MAINPY}`] : []),
      ...(!av.vendor.ok ? ['烧录引擎 esptool-js'] : []),
    ],
  });
});

router.get('/flashtool/package', (req, res) => {
  try {
    const { zip, patchInfo, entries } = svc.buildPackage(req);
    const name = svc.packageFileName();
    // RFC 5987：中文文件名同时给 ASCII 兜底 + UTF-8 编码名，各浏览器都能存对
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="smarthome-flasher.zip"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.set('X-Flash-Patch', patchInfo.patched ? `url=${patchInfo.urlFound},key=${patchInfo.keyFound}` : 'none');
    console.log(`[flashtool] 生成烧录包：${entries} 个条目，固件注入 ${patchInfo.patched ? '成功' : '未命中占位符（按原样打包）'}`);
    res.send(zip);
  } catch (e) {
    console.error('[flashtool] 打包失败:', e.message);
    res.status(500).json({ error: '烧录包生成失败：' + e.message });
  }
});

module.exports = router;
