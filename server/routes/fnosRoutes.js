// 飞牛 fnOS 应用包下载（v1.9.9）：设置页「飞牛应用」tab 的文件来源。
// fpk 放在 server/fnos/（随 git 提交、随升级包分发；.gitattributes export-ignore
// 使其不进 fpk 自身的 git archive——避免 fpk 套 fpk 逐版翻倍）。
// 权限：归 settings 页 fnos tab（TAB_PATHS 前缀 /fnos），登录 + 有该 tab 权限即可下载。
const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const DIR = path.join(__dirname, '..', 'fnos');

// 目录下最新的 fpk（文件名含版本号；按数字段比较——字典序会把 1.9.10 排到 1.9.9 前面；无则返回 null）
function latestFpk() {
  try {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.fpk'));
    if (!files.length) return null;
    const ver = (f) => ((f.match(/([\d.]+)\.fpk$/) || [])[1] || '').split('.').filter((x) => x !== '').map(Number);
    files.sort((a, b) => {
      const va = ver(a), vb = ver(b);
      for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const d = (va[i] || 0) - (vb[i] || 0);
        if (d) return d;
      }
      return a.localeCompare(b);   // 版本号并列时按文件名定先后
    });
    return files[files.length - 1];
  } catch {
    return null;
  }
}

// 当前可下载的 fpk 信息（版本号/大小/时间），供前端展示
router.get('/fnos/info', (req, res) => {
  const f = latestFpk();
  if (!f) return res.json({ available: false });
  const st = fs.statSync(path.join(DIR, f));
  const m = f.match(/([\d.]+)\.fpk$/);
  res.json({
    available: true,
    file: f,
    version: m ? 'v' + m[1] : '',
    size: st.size,
    mtime: st.mtime.toISOString(),
  });
});

// 下载 fpk 安装包（文件名带中文，Content-Disposition 由 res.download 处理 RFC 5987）
router.get('/fnos/package', (req, res) => {
  const f = latestFpk();
  if (!f) return res.status(404).json({ error: '服务端未内置 fpk 安装包（server/fnos/ 为空）' });
  res.download(path.join(DIR, f));
});

module.exports = router;
