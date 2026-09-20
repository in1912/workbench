// 设置 → SSL 自签名：证书状态 / 生成 / 下载 / 上传替换 / 重启生效
// 无页面路径映射（auth.pageForPath 不含 /ssl）= 登录即可到达，写操作在路由内 adminOnly；
// 证书是全局资源（index.js 启动时读 data/ssl），与租户无关，全部走主库/文件系统。
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sslService = require('../services/sslService');
const { gracefulRestart } = require('../services/restartService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } }); // PEM 文本最多 1MB

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可管理 HTTPS 证书' });
  next();
}

// 当前证书状态（起止日期/剩余天数/SAN/密钥匹配/待重启标记）
router.get('/status', adminOnly, (req, res) => {
  try { res.json(sslService.status()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// 生成新证书并替换（旧证书自动备份到 ssl/backup-<时间戳>/），重启后生效
router.post('/generate', adminOnly, (req, res) => {
  try {
    const b = req.body || {};
    const r = sslService.generateCert({ cn: b.cn, org: b.org, san: b.san, days: b.days });
    sslService.writePair(r.certPem, r.keyPem);
    console.log(`[ssl] 管理员 ${req.user.username} 生成了新自签名证书（CN=${b.cn}，${r.days} 天，SAN: ${[...r.dnsList, ...r.ipList].join(', ')}），重启服务后生效`);
    res.json({ ok: true, days: r.days, dns: r.dnsList, ips: r.ipList, status: sslService.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 证书下载（可分发到各设备做信任导入）
router.get('/file/cert', adminOnly, (req, res) => {
  if (!fs.existsSync(sslService.CERT_PATH)) return res.status(404).json({ error: '证书文件不存在（尚未生成）' });
  res.setHeader('Content-Disposition', 'attachment; filename="cert.pem"');
  res.type('application/x-pem-file').send(fs.readFileSync(sslService.CERT_PATH, 'utf8'));
});
// 私钥下载（敏感：仅备份用途，切勿分发）
router.get('/file/key', adminOnly, (req, res) => {
  if (!fs.existsSync(sslService.KEY_PATH)) return res.status(404).json({ error: '私钥文件不存在（尚未生成）' });
  res.setHeader('Content-Disposition', 'attachment; filename="key.pem"');
  res.type('application/x-pem-file').send(fs.readFileSync(sslService.KEY_PATH, 'utf8'));
});

// 上传替换（外部工具生成的证书+私钥，需成对且公钥匹配）
router.post('/upload', adminOnly, upload.fields([{ name: 'cert', maxCount: 1 }, { name: 'key', maxCount: 1 }]), (req, res) => {
  const cert = req.files && req.files.cert && req.files.cert[0];
  const key = req.files && req.files.key && req.files.key[0];
  if (!cert || !key) return res.status(400).json({ error: '请同时上传 cert.pem 与 key.pem 两个文件' });
  try {
    const certPem = cert.buffer.toString('utf8');
    const keyPem = key.buffer.toString('utf8');
    const c = new crypto.X509Certificate(certPem); // 格式不对在此抛错
    if (!sslService.pubKeyMatch(c, keyPem)) return res.status(400).json({ error: '证书与私钥不匹配（两者公钥不一致）' });
    sslService.writePair(certPem, keyPem);
    console.log(`[ssl] 管理员 ${req.user.username} 上传替换了证书（CN=${(c.subject || '').slice(0, 60)}），重启服务后生效`);
    res.json({ ok: true, status: sslService.status() });
  } catch (e) { res.status(400).json({ error: '证书/私钥解析失败：' + e.message }); }
});

// 重启服务让新证书生效（Docker restart:always 自动拉起；本地直跑由接替进程接管——同升级应用语义）
router.post('/restart', adminOnly, (req, res) => {
  res.json({ ok: true });
  console.log(`[ssl] 管理员 ${req.user.username} 请求重启服务以应用新证书`);
  if (req.body && req.body.restart === false) return; // 测试探针：只验权限与响应不真退出
  gracefulRestart('SSL 证书重启');
});

module.exports = router;
