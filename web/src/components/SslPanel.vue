<template>
  <div>
    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>

    <!-- ============ 当前签名状态 ============ -->
    <div class="card">
      <h3>📜 当前签名（HTTPS 证书）</h3>
      <template v-if="!st.configured">
        <div class="empty">尚未配置证书——当前服务以纯 HTTP 模式运行。在下方「生成新签名」后重启服务，即可启用同端口 HTTP/HTTPS 自适应。</div>
      </template>
      <template v-else-if="st.error">
        <div class="msg err">{{ st.error }}</div>
      </template>
      <template v-else>
        <!-- 到期提醒（生成日期口径：剩余 ≤30 天橙、≤7 天红） -->
        <div v-if="st.days_left < 0" class="msg err">⛔ 证书已过期 {{ -st.days_left }} 天（{{ fmt(st.valid_to) }}）——浏览器可能已拦截 https 访问，请立即在下方生成新证书并重启！</div>
        <div v-else-if="st.days_left <= 7" class="msg err">🔴 证书仅剩 {{ st.days_left }} 天（{{ fmt(st.valid_to) }} 到期），请尽快更换</div>
        <div v-else-if="st.days_left <= st.remind_days" class="msg" style="background:rgba(230,162,60,.15); color:var(--orange,#e6a23c); border:1px solid var(--orange,#e6a23c)">🟠 证书还有 {{ st.days_left }} 天到期（{{ fmt(st.valid_to) }}），建议尽快更换</div>
        <div v-else class="muted" style="font-size:12.5px; margin-bottom:10px">✅ 证书有效（剩余 {{ st.days_left }} 天）。到期前 {{ st.remind_days }} 天起，系统每天 09:23 会发站内消息+钉钉提醒管理员。</div>

        <div v-if="st.pending_restart" class="msg" style="background:rgba(79,124,247,.12); color:var(--accent,#4f7cf7)">⏳ 证书文件已替换，但服务还在用启动时加载的旧证书——点下方「重启服务」后生效。</div>
        <div v-if="st.key_matches === false" class="msg err">⚠ 证书与私钥不匹配！https 将无法启用，请重新生成或上传正确的一对文件。</div>

        <div class="kv"><span>签发对象</span><b>{{ st.subject || '—' }}</b></div>
        <div class="kv"><span>签发者</span><b>{{ st.issuer || '—' }}（自签名）</b></div>
        <div class="kv"><span>生效日期</span><b>{{ fmt(st.valid_from) }}</b></div>
        <div class="kv"><span>到期日期</span><b>{{ fmt(st.valid_to) }} <span class="badge" :class="daysClass">{{ st.days_left >= 0 ? '剩 ' + st.days_left + ' 天' : '已过期' }}</span></b></div>
        <div class="kv"><span>下次更换日期</span><b>{{ fmt(st.renew_after) }}（建议在此日期后、到期前完成更换）</b></div>
        <div class="kv"><span>覆盖域名/IP</span><b style="flex-wrap:wrap; gap:4px; display:flex"><span v-for="(s, i) in sanList" :key="i" class="badge blue" style="margin:0">{{ s }}</span><span v-if="!sanList.length" class="muted">（无 SAN，老证书）</span></b></div>
        <div class="kv"><span>密钥配对</span><b>{{ st.key_matches === null ? '—（缺 key.pem）' : st.key_matches ? '✓ 匹配' : '✗ 不匹配' }}</b></div>
        <div class="kv"><span>文件位置</span><b style="font-size:12px">{{ st.dir }}<br><span class="muted">cert.pem {{ fmtSize(st.cert_file.size) }} · {{ fmt(st.cert_file.mtime) }}　key.pem {{ st.key_file.exists ? fmtSize(st.key_file.size) + ' · ' + fmt(st.key_file.mtime) : '（不存在）' }}</span></b></div>
      </template>

      <div class="row" style="flex-wrap:wrap; gap:8px; margin-top:12px; padding-top:10px; border-top:1px dashed var(--border)">
        <button class="small" :disabled="!st.configured" @click="dl('/ssl/file/cert', 'cert.pem')">⬇ 下载证书 cert.pem</button>
        <button class="small" :disabled="!st.configured" @click="dl('/ssl/file/key', 'key.pem')">⬇ 下载私钥 key.pem</button>
        <button class="small danger" :disabled="!st.has_pair" @click="restart">🔁 重启服务（应用证书）</button>
      </div>
      <div class="muted" style="font-size:12px; margin-top:8px">下载的 cert.pem 可分发到手机/电脑做信任导入；key.pem 是私钥请妥善保管，不要发给任何人。重启服务：Docker 部署会自动拉起（数秒后刷新页面），本地直跑（start.bat）需手动重启。</div>
    </div>

    <!-- ============ 生成新签名 ============ -->
    <div class="card">
      <h3>🛠 生成新签名（自助签发）</h3>
      <div class="muted" style="font-size:12.5px; margin-bottom:10px">在这里生成即可，无需 openssl 命令行。生成会<b>立即替换</b>当前证书文件（旧的自动备份到 ssl/backup-时间戳/），重启服务后生效。有效期上限 {{ st.max_days || 825 }} 天（Chrome/苹果对自签名证书的信任上限）。</div>
      <div class="form-row"><label>通用名称 CN（主域名/主机名）</label><input v-model="gen.cn" placeholder="localhost" /></div>
      <div class="form-row"><label>附加域名 / IP（逗号分隔，自动分类进 SAN）</label><input v-model="gen.san" :placeholder="`192.168.110.105, nas.local`" /></div>
      <div class="row">
        <div class="form-row" style="flex:1"><label>有效天数（1-{{ st.max_days || 825 }}）</label><input v-model.number="gen.days" type="number" min="1" :max="st.max_days || 825" /></div>
        <div class="form-row" style="flex:1"><label>组织名（可选）</label><input v-model="gen.org" placeholder="Personal Workbench" /></div>
      </div>
      <div class="muted" style="font-size:12px; margin-bottom:10px">CN 会自动加入域名 SAN，并附赠 localhost / 127.0.0.1（本机 https 调试用）。局域网设备也要走 https 的话，把 NAS 的局域网 IP 填进附加列表。</div>
      <button class="primary" :disabled="generating" @click="doGenerate">{{ generating ? '生成中（约 2-5 秒）...' : '生成并替换证书' }}</button>
    </div>

    <!-- ============ 上传替换 ============ -->
    <div class="card">
      <h3>⬆ 上传替换（外部生成的证书）</h3>
      <div class="muted" style="font-size:12.5px; margin-bottom:10px">已在别处（如 openssl / 路由器）生成过证书的话，直接上传那一对 PEM 文件。必须成对且公钥匹配，旧文件同样自动备份。</div>
      <div class="row" style="flex-wrap:wrap; gap:10px">
        <div class="row" style="gap:6px"><span class="muted" style="font-size:12.5px">证书</span><input ref="upCert" type="file" accept=".pem,.crt,.cer" /></div>
        <div class="row" style="gap:6px"><span class="muted" style="font-size:12.5px">私钥</span><input ref="upKey" type="file" accept=".pem,.key" /></div>
      </div>
      <button class="primary" style="margin-top:10px" :disabled="uploading" @click="doUpload">{{ uploading ? '上传中...' : '校验并替换' }}</button>
    </div>

    <!-- ============ 说明 ============ -->
    <div class="card">
      <h3>📖 使用方法与原理说明</h3>
      <div class="doc">
        <b>为什么要用 HTTPS？</b>
        <p>① 传输加密：公网花生壳/内网 Wi-Fi 上的账号密码、邮件、家庭数据不裸奔；② 浏览器硬性要求：摄像头/麦克风（练琴录像、录音）、剪贴板等 API 只在 https（或 localhost）下可用；③ 钉钉工作台内嵌打开时更稳定。</p>
        <b>SSL 应用原理</b>
        <p>浏览器与服务器握手时，服务器出示证书（含公钥）证明身份，双方协商出会话密钥加密后续流量。证书需要被设备的「受信任根」背书——正规网站由 CA 机构签发；<b>自签名证书是服务器自己签自己</b>，不在系统信任链里，所以首次访问会看到「不安全」告警，需要在每台设备上手动信任一次。</p>
        <b>文件放什么路径？</b>
        <p>证书与私钥固定放在<b>数据目录的 ssl 子目录</b>：<code>{{ st.dir }}</code>（Docker 部署即容器内 <code>/data/ssl</code>，对应 NAS 上 compose 映射的 <code>./data/ssl/</code>）。服务启动时检测到这对文件就自动启用「同端口 HTTP/HTTPS 自适应」——同一个端口，浏览器用 http:// 和 https:// 都能访问，老书签不受影响。替换证书后必须重启服务才生效。</p>
        <b>怎么使用（生成 → 重启 → 信任）？</b>
        <p>① 在上方填 CN（一般填花生壳域名）和要覆盖的域名/IP，点「生成并替换」；② 点「重启服务」（Docker 自动拉起）；③ 用 https://你的域名 访问；④ 每台设备做一次信任：Windows 双击下载的 cert.pem → 安装证书 → 存储位置选「本地计算机」→「将所有的证书都放入下列存储」→ 浏览选「受信任的根证书颁发机构」；iPhone/Android 下载 cert.pem 后在设置里安装（iOS 装完还要到 设置→通用→关于本机→证书信任设置 打开完全信任）。</p>
        <b>适用什么场景？</b>
        <p>家庭/小团队自建系统：局域网 IP 直连（https://192.168.x.x:21716）、花生壳等内网穿透域名（http://localhost:3000）。注意：① 有效期不能超过 825 天；② 花生壳映射必须是 TCP 型（HTTP 型会拦截 TLS 握手）；③ 公网正式对外运营请改用 Let's Encrypt 等正规免费证书（需域名解析验证）。</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';

const st = ref({ configured: false, cert_file: {}, key_file: {} });
const msg = ref(''); const msgType = ref('ok');
const generating = ref(false); const uploading = ref(false);
const upCert = ref(null); const upKey = ref(null);
const gen = ref({ cn: '', san: '', days: 820, org: '' });

function flash(text, type = 'ok') { msg.value = text; msgType.value = type; setTimeout(() => (msg.value = ''), 6000); }

const daysClass = computed(() => {
  const d = st.value.days_left;
  if (d < 0 || d <= 7) return 'red';
  if (d <= (st.value.remind_days || 30)) return '';
  return 'blue';
});
const sanList = computed(() => String(st.value.san || '').split(',').map((s) => s.trim()).filter(Boolean));

async function load() {
  try { st.value = await api.get('/ssl/status'); }
  catch (e) { flash('读取证书状态失败：' + e.message, 'err'); }
}
onMounted(async () => {
  await load();
  // CN 预填当前访问的主机名（vicp 域名或局域网 IP），SAN 预填非回环 IP
  if (!gen.value.cn) {
    const h = location.hostname;
    gen.value.cn = h && h !== 'localhost' && h !== '127.0.0.1' ? h : '';
    if (h && /^\d+\.\d+\.\d+\.\d+$/.test(h)) gen.value.san = h;
  }
});

async function doGenerate() {
  if (!gen.value.cn.trim()) return flash('请填写通用名称（CN），一般填域名或主机名', 'err');
  if (!confirm(`生成新证书并替换当前文件？\nCN: ${gen.value.cn}\n有效期: ${gen.value.days} 天\n（旧证书自动备份；生成后需重启服务生效）`)) return;
  generating.value = true;
  try {
    const r = await api.post('/ssl/generate', {
      cn: gen.value.cn, org: gen.value.org, days: gen.value.days,
      san: gen.value.san.split(/[,，\s]+/).filter(Boolean),
    });
    st.value = r.status || st.value;
    flash(`新证书已生成（${r.days} 天，覆盖：${[...(r.dns || []), ...(r.ips || [])].join('、')}）。请点「重启服务」生效`);
  } catch (e) { flash('生成失败：' + e.message, 'err'); }
  finally { generating.value = false; }
}

async function doUpload() {
  const fc = upCert.value && upCert.value.files && upCert.value.files[0];
  const fk = upKey.value && upKey.value.files && upKey.value.files[0];
  if (!fc || !fk) return flash('请同时选择证书与私钥两个文件', 'err');
  if (!confirm('上传并替换当前证书？（服务端会校验证书与私钥配对；旧文件自动备份）')) return;
  uploading.value = true;
  try {
    const fd = new FormData();
    fd.append('cert', fc); fd.append('key', fk);
    const res = await fetch('/api/ssl/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('wb_token') || '') },
      body: fd,
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `上传失败 (${res.status})`);
    st.value = d.status || st.value;
    flash('证书已替换。请点「重启服务」生效');
  } catch (e) { flash('替换失败：' + e.message, 'err'); }
  finally { uploading.value = false; }
}

async function dl(p, name) {
  try { await api.download(p, name); }
  catch (e) { flash('下载失败：' + e.message, 'err'); }
}

async function restart() {
  if (!confirm('重启服务以应用证书？\nDocker 部署会自动拉起（几秒后刷新页面即可）；本地直跑需手动重启。')) return;
  try {
    await api.post('/ssl/restart', {});
    flash('服务正在重启——稍等几秒后刷新页面', 'ok');
    setTimeout(() => location.reload(), 5000);
  } catch (e) { flash('重启请求失败：' + e.message, 'err'); }
}

function fmt(iso) { return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function fmtSize(n) { return !n ? '' : n < 1024 ? n + 'B' : (n / 1024).toFixed(1) + 'KB'; }
</script>

<style scoped>
.kv { display: flex; gap: 10px; align-items: baseline; padding: 4px 0; border-bottom: 1px dashed var(--border); font-size: 13px; }
.kv > span:first-child { width: 96px; flex-shrink: 0; color: var(--muted, #888); }
.doc p { margin: 6px 0 12px; font-size: 13px; line-height: 1.7; }
.doc b { font-size: 13px; }
.doc code { background: var(--bg2, #f5f5f5); padding: 1px 6px; border-radius: 4px; font-size: 12px; word-break: break-all; }
</style>
