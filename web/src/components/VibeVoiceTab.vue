<template>
  <div>
    <!-- ============ 录音 + 上传（同一个矩形框，左右分开） ============ -->
    <div class="card" style="margin-bottom:12px">
      <div class="ru-grid">
        <!-- 左：录音 -->
        <div>
          <h3>🎤 录音 <span class="muted" style="font-size:12px; font-weight:400">录完自动保存到下方列表</span></h3>
          <div class="row" style="flex-wrap:wrap; gap:12px; align-items:center">
            <button v-if="recState==='idle' && saveStage!=='done'" class="rec-btn" @click="startRec">🎤 开始录音</button>
            <div v-else-if="recState==='recording'" class="row" style="flex-wrap:wrap; gap:10px; align-items:center">
              <span class="rec-time">{{ fmtDur(recSecs) }}</span>
              <button class="rec-btn stop" @click="stopRec">⏹ 停止并保存</button>
              <span v-if="wakeOk" class="muted" style="font-size:12px">🔒 屏幕已保持常亮</span>
              <span v-else class="muted" style="font-size:12px; color:#d97706">⚠️ 请保持屏幕常亮、勿切后台</span>
            </div>
            <div v-else class="save-box">
              <div class="sp-steps">
                <template v-for="(s, si) in SAVE_STEPS" :key="s.k">
                  <span v-if="si > 0" class="sp-arrow">›</span>
                  <span class="sp-step" :class="stepCls(s.k)">{{ stepIcon(s.k) }} {{ s.label }}</span>
                </template>
              </div>
              <div class="pbar"><div class="pfill" :style="{ width: savePct + '%' }"></div></div>
              <div v-if="saveStage === 'done'" class="sp-note ok">
                ✅ 已保存 <b>{{ saveFile.name }}</b>（{{ fmtSize(saveFile.size) }} · 用时 {{ saveFile.took }} 秒）——已进入下方列表。<b>现在可以安全离开页面</b>；点列表行内「转写」可开始识别（转写在服务器跑，转写期间可以离开）。
              </div>
              <div v-else class="sp-note">{{ saveNote }} <b class="sp-warn">处理中请勿关闭或切换页面（离开会中断）</b></div>
            </div>
            <label class="field">格式
              <select v-model="recFmt" :disabled="recState!=='idle'" style="width:110px">
                <option value="wav">WAV（默认）</option>
                <option value="mp3">MP3（更小）</option>
              </select>
            </label>
            <template v-if="recFmt==='mp3'">
              <label class="field">采样率
                <select v-model.number="mp3Rate" :disabled="recState!=='idle'" style="width:110px">
                  <option :value="16000">16000 Hz</option>
                  <option :value="22050">22050 Hz</option>
                  <option :value="44100">44100 Hz</option>
                </select>
              </label>
              <label class="field">比特率
                <select v-model.number="mp3Kbps" :disabled="recState!=='idle'" style="width:110px">
                  <option :value="32">32 kbps</option>
                  <option :value="64">64 kbps</option>
                  <option :value="96">96 kbps</option>
                  <option :value="128">128 kbps</option>
                  <option :value="192">192 kbps</option>
                </select>
              </label>
            </template>
          </div>
          <div v-if="recFmt==='mp3' && recState==='idle'" class="muted" style="margin-top:8px; font-size:12px">
            MP3 单声道约 {{ (mp3Kbps/8).toFixed(0) }} KB/秒（采样率越低文件越小，语音识别 16000 Hz 足够）。
          </div>
          <div v-if="recWarn" style="margin-top:6px; font-size:12.5px; color:#d97706">⚠ {{ recWarn }}</div>
          <div v-if="recError" class="err">{{ recError }}</div>
        </div>
        <!-- 右：上传 -->
        <div class="ru-right">
          <h3>📁 上传录音文件</h3>
          <div class="row" style="flex-wrap:wrap; gap:10px; align-items:center">
            <input ref="fileInput" type="file" accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.webm,.aac" multiple style="max-width:420px" @change="onPickFiles" />
            <button v-if="uploading" class="small" disabled>{{ uploadMsg }}</button>
          </div>
          <div v-if="uploadMsg && !uploading" class="muted" style="margin-top:6px; font-size:12px">{{ uploadMsg }}</div>
          <div class="muted" style="margin-top:6px; font-size:12px">支持 WAV / MP3 / M4A / FLAC / OGG 等；时长以服务端读文件判定为准（WAV/MP3 精确，其余取浏览器解码值）。</div>
        </div>
      </div>
    </div>

    <!-- ============ 录音文件列表 ============ -->
    <div class="card" style="margin-bottom:12px">
      <h3>录音文件列表 <span class="muted" style="font-size:12px; font-weight:400">按保存时间倒序 · 点行查看转写详情</span></h3>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>序号</th><th>操作</th><th>用户中文姓名</th><th>开始录制/上传时间</th><th>结束时间</th><th>录音时长</th>
              <th>转写状态</th><th>是否生成文本</th><th>转写耗时</th><th>使用模型</th><th>容量</th><th>文件路径</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in rows" :key="r.id" :class="{ sel: r.id === selectedId }" class="row-click" @click="selectRow(r)">
              <td>{{ (page - 1) * pageSize + i + 1 }}</td>
              <td @click.stop>
                <button class="small primary" :disabled="r.status==='running'" @click="transcribe(r)">{{ r.status==='running' ? '转写中' : '转写' }}</button>
                <button class="small" @click="downloadAudio(r)">下载</button>
                <button class="small" @click="openPlayer(r)">播放</button>
                <button class="small danger" @click="delRow(r)">删除</button>
              </td>
              <td>{{ r.user_name || '—' }} <span class="src-b">{{ r.source === 'upload' ? '上传' : '录音' }}</span></td>
              <td>{{ r.started_at || '—' }}</td>
              <td>{{ r.ended_at || '—' }}</td>
              <td>{{ r.duration_sec ? fmtDur(r.duration_sec) : '—' }}</td>
              <td>
                <span class="badge" :class="statusCls(r)" :title="r.error || ''">{{ statusText(r) }}</span>
                <div v-if="r.status === 'running'" class="tp-wrap">
                  <div class="tp-bar"><div class="tp-fill" :class="{ indet: transPct(r) < 0 }" :style="transPct(r) >= 0 ? { width: transPct(r) + '%' } : {}"></div></div>
                  <span class="tp-note">{{ transPct(r) >= 0 ? transPct(r) + '% · 已用 ' + transElapsed(r) + ' 秒 · ' + transEta(r) : '已用 ' + transElapsed(r) + ' 秒（估速中…）' }}</span>
                </div>
              </td>
              <td>{{ r.has_text ? '是' : '否' }}</td>
              <td :title="elapsedTitle(r)">{{ fmtElapsed(r.elapsed_ms) }}</td>
              <td class="model-cell" :title="r.model || ''">{{ r.model || '—' }}</td>
              <td>{{ fmtSize(r.file_size) }}</td>
              <td class="path-cell" :title="r.file_path || ''">{{ shortPath(r.file_path) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!rows.length" class="empty">暂无录音，先在上方录制或上传一个文件</div>
      <div class="pager">
        <span class="muted">共 {{ total }} 条</span>
        <select v-model.number="pageSize" style="width:80px" @change="page = 1; load()">
          <option :value="5">5 行</option>
          <option :value="15">15 行</option>
          <option :value="30">30 行</option>
          <option :value="100">100 行</option>
        </select>
        <button class="small" :disabled="page <= 1" @click="page--; load()">上一页</button>
        <span>第 {{ page }} / {{ totalPages }} 页</span>
        <button class="small" :disabled="page >= totalPages" @click="page++; load()">下一页</button>
      </div>
    </div>

    <!-- ============ 转写详情 ============ -->
    <div v-if="selectedId" class="card" style="margin-bottom:12px">
      <h3>📝 转写详情 <span class="muted" style="font-size:12px; font-weight:400">#{{ selectedId }} · 点击其他行切换</span></h3>
      <template v-if="detailLoading"><div class="muted">加载中…</div></template>
      <template v-else-if="!detail || detail.status !== 'done'">
        <div v-if="detail && detail.status === 'running'">
          <div class="tp-bar big"><div class="tp-fill" :class="{ indet: transPct(detail) < 0 }" :style="transPct(detail) >= 0 ? { width: transPct(detail) + '%' } : {}"></div></div>
          <div class="muted">⏳ 转写中{{ transPct(detail) >= 0 ? ' ' + transPct(detail) + '%' : '' }} · 已用 {{ transElapsed(detail) }} 秒<template v-if="transEta(detail)"> · {{ transEta(detail) }}</template>。<b>转写在服务器进行，此期间可以离开页面</b>，完成后此列表自动刷新（长录音可能需要几分钟）。</div>
        </div>
        <div v-else-if="detail && detail.status === 'failed'" class="err">转写失败：{{ detail.error }}</div>
        <div v-else class="muted">尚未转写，点上方列表「转写」按钮开始</div>
      </template>
      <template v-else>
        <div class="detail-bar">
          <span>总字数 <b>{{ detail.transcript_chars ?? 0 }}</b></span>
          <span>总页数 <b>{{ totalPagesMd }}</b></span>
          <span>模型 <b>{{ detail.model || '—' }}</b></span>
          <span>完成时间 <b>{{ detail.transcribed_at || '—' }}</b></span>
          <span class="grow"></span>
          <button class="small" @click="dl('txt')">下载文本</button>
          <button class="small" @click="dl('word')">下载 Word</button>
        </div>
        <div class="markdown-body md-page" v-html="pageMd"></div>
        <div class="pager">
          <button class="small" :disabled="mdPage <= 1" @click="mdPage--">上一页</button>
          <span>第 {{ mdPage }} / {{ totalPagesMd }} 页</span>
          <button class="small" :disabled="mdPage >= totalPagesMd" @click="mdPage++">下一页</button>
          <span>跳至第</span>
          <input v-model.number="jumpPage" type="number" min="1" :max="totalPagesMd" style="width:64px" @keyup.enter="doJump" />
          <span>页</span>
          <button class="small" @click="doJump">跳转</button>
        </div>
      </template>
    </div>

    <!-- ============ 算力来源（录音文件列表下面，与列表同宽度） ============ -->
    <div class="card" style="margin-bottom:12px">
      <h3>🧠 算力来源 <span class="muted" style="font-size:12px; font-weight:400">转写在哪儿算</span></h3>
      <div class="mode-switch">
        <button :class="{ on: cfg.engine_mode==='server' }" @click="setMode('server')">🖥 服务器引擎</button>
        <button :class="{ on: cfg.engine_mode==='client' }" @click="setMode('client')">💻 客户端电脑</button>
        <button :class="{ on: cfg.engine_mode==='custom' }" @click="setMode('custom')">🔗 自定义服务</button>
      </div>

      <!-- 服务器引擎 -->
      <template v-if="cfg.engine_mode==='server'">
        <div class="mode-switch" style="margin-top:8px">
          <button :class="{ on: cfg.server_engine==='whisper' }" @click="setServerEngine('whisper')">Whisper large-v3-turbo（首选）</button>
          <button :class="{ on: cfg.server_engine==='vibeasr' }" @click="setServerEngine('vibeasr')">VibeVoice-ASR BitNet</button>
        </div>

        <template v-if="cfg.server_engine==='whisper'">
          <div class="muted" style="font-size:12.5px; line-height:1.8; margin-top:8px">
            OpenAI <b>whisper-large-v3-turbo</b>（whisper.cpp 引擎，纯 CPU 无需显卡）：转写自带<b>时间戳</b>，多语言能力强。
            说话人恒为 1（浏览器/手机录音是单声道，无法分离说话人，需分离请用 7B 版）；音频格式支持 <b>WAV / MP3 / FLAC / OGG</b>（M4A/AMR 请先转成 WAV/MP3）。
          </div>
          <div class="row" style="gap:10px; margin-top:8px; flex-wrap:wrap; align-items:flex-end">
            <label class="field">识别语言（保存后生效）
              <select v-model="cfg.whisper_lang" style="width:150px" @change="saveLang">
                <option value="auto">自动检测</option>
                <option value="zh">中文</option>
                <option value="en">英语</option>
                <option value="yue">粤语</option>
                <option value="ja">日语</option>
                <option value="ko">韩语</option>
                <option value="de">德语</option>
                <option value="fr">法语</option>
                <option value="es">西班牙语</option>
                <option value="ru">俄语</option>
              </select>
            </label>
            <span class="muted" style="font-size:12px; flex:1; min-width:200px; max-width:330px">安静/低质量手机录音建议固定「中文」：自动检测可能误判语言，产生幻觉文本。</span>
          </div>
        </template>
        <div v-else class="muted" style="font-size:12.5px; line-height:1.8; margin-top:8px">
          服务器本地运行 VibeVoice-ASR-BitNet（纯 CPU，无需显卡），输出<b>纯文本转写</b>（无说话人分离/时间戳，需分离请用 GPU 版 7B）。
        </div>
        <div v-if="!engine.installed && !engInstall.running" class="muted" style="font-size:12.5px; line-height:1.8; margin-top:6px">
          首次使用需下载约 <b>{{ cfg.server_engine==='whisper' ? '0.9GB' : '1.7GB' }}</b> 模型（hf-mirror 国内镜像，断点续传），装一次即可。
        </div>
        <div v-if="!engine.installed" class="row" style="gap:10px; margin-top:8px">
          <button class="primary" :disabled="engInstall.running" @click="installEngine">{{ engInstall.running ? '正在安装…' : '⬇ 一键安装引擎' }}</button>
        </div>
        <template v-if="engInstall.running || engInstall.error">
          <div class="progress-outer" style="margin-top:10px"><div class="progress-inner" :style="{ width: engInstall.progress + '%' }"></div></div>
          <div style="font-size:12px; color:var(--text3); margin-top:4px">{{ engInstall.progress }}% · {{ engInstallStep }}</div>
          <div v-if="engInstall.error" style="font-size:12.5px; color:#e5484d; margin-top:6px">✗ {{ engInstall.error }}</div>
          <pre class="eng-log">{{ engInstall.log.slice(-6).join('\n') }}</pre>
          <div v-if="engInstall.error && !engInstall.running" class="row" style="gap:10px; margin-top:8px">
            <button class="small" @click="resetInstall">✕ 取消安装（清除失败状态）</button>
          </div>
        </template>
        <div v-if="engine.installed" class="row" style="gap:10px; margin-top:8px; flex-wrap:wrap; align-items:center">
          <span class="badge" :class="engine.ready ? 'green' : engine.running ? 'blue' : 'amber'">
            {{ engine.ready ? '✓ 引擎就绪' : engine.running ? '引擎加载中…' : '服务未运行' }}
          </span>
          <span class="muted" style="font-size:12px">{{ engine.running ? `端口 ${engine.port} · ${engine.restarts} 次自愈` : '' }}</span>
          <span class="grow"></span>
          <button v-if="!engine.running" class="small" @click="engineAction('start')">启动服务</button>
          <button v-else class="small" @click="engineAction('stop')">停止</button>
          <button class="small" @click="removeModels">🗑 删除模型</button>
        </div>
        <div class="muted" style="font-size:12px; margin-top:4px">🗑 删除模型：服务器 CPU 带不动时卸载约 {{ cfg.server_engine==='whisper' ? '0.9GB' : '1.7GB' }} 模型文件（不影响另一套引擎/客户端/自定义模式），随时可重新一键安装。</div>
        <div v-if="cfg.server_engine==='vibeasr' && engine.installed && !engine.ready && engine.running" class="muted" style="font-size:12px; margin-top:6px">模型首次加载约 30~90 秒，就绪后自动转写。</div>
        <div v-else-if="cfg.server_engine==='whisper' && engine.installed" class="muted" style="font-size:12px; margin-top:6px">每次转写按需加载模型约 3~5 秒；长录音转写时间约等于录音时长的 3~6 倍（服务器 CPU 而定）。</div>
      </template>

      <!-- 客户端电脑 -->
      <template v-else-if="cfg.engine_mode==='client'">
        <div class="muted" style="font-size:12.5px; line-height:1.8; margin-top:6px">
          在一台算力足够的 Windows 电脑上运行部署包，装完<b>自动回连工作台</b>——客户端<b>主动回连领任务</b>（拉取模式），目标电脑在公司/外网等 NAS 连不到的网络也能用。
          先选客户端引擎，再下载对应部署包：
        </div>
        <div class="mode-switch" style="margin-top:8px">
          <button :class="{ on: cfg.client_engine==='vibeasr' }" @click="setClientEngine('vibeasr')">💻 VibeASR 1.5B（纯 CPU，任意电脑）</button>
          <button :class="{ on: cfg.client_engine==='vibe7b' }" @click="setClientEngine('vibe7b')">🎮 VibeVoice-ASR 7B（需 NVIDIA 显卡）</button>
        </div>

        <template v-if="cfg.client_engine==='vibe7b'">
          <div class="muted" style="font-size:12.5px; line-height:1.8; margin-top:6px">
            7B 完整版带<b>说话人分离 + 时间戳</b>（50+ 语言，单条最长约 60 分钟）；模型只有 Linux vLLM 能跑，
            脚本会自动在电脑的 WSL2 里装好一切（约 15GB 下载，全国内镜像断点续传）。
          </div>
          <ol class="guide-list">
            <li>点下方「下载部署包」，得到 <code>install-vibe7b.bat</code> 和 <code>vibe7b-setup.ps1</code>（两个文件放同一文件夹）</li>
            <li>拷到带 NVIDIA 显卡的电脑（8GB 显存可跑、12GB 稳）双击 <code>install-vibe7b.bat</code>（默认装到 <code>D:\LLM\vibe7b</code>）；没启用 WSL2 脚本会提示先 <code>wsl --install</code> 并重启再跑</li>
            <li>首次安装约 30~60 分钟（WSL 内自动装 Miniconda + vLLM 并下载 8.7GB 模型）；进度看 WSL 内 <code>/opt/vibevoice7b/setup.log</code></li>
            <li>装完自动注册回本工作台（下方显示显卡型号）；开机自启。卸载：下载 <code>uninstall-vibe7b.bat</code> 到目标电脑双击</li>
          </ol>
        </template>
        <template v-else>
          <div class="muted" style="font-size:12.5px; line-height:1.8; margin-top:6px">
            1.5B 量化版，普通 CPU 即可接近实时<b>纯文本转写</b>（支持热词；说话人分离/时间戳请选 7B 版）。
          </div>
          <ol class="guide-list">
            <li>点下方「下载部署包」，得到 <code>install-vibeasr.bat</code> 和 <code>vibeasr-setup.ps1</code>（两个文件放同一文件夹）</li>
            <li>拷到目标电脑，双击 <code>install-vibeasr.bat</code>（默认装到 <code>D:\LLM\vibeasr</code>，D 盘不可用自动改 C 盘）</li>
            <li>脚本自动下载 Node、引擎程序和 1.7GB 模型（国内镜像，可断点续传），装完自动注册回本工作台</li>
            <li>下方状态变「在线」即可转写；开机自启。卸载：下载 <code>uninstall-vibeasr.bat</code> 到目标电脑双击即可</li>
          </ol>
        </template>
        <div class="row" style="gap:10px; margin-top:8px; flex-wrap:wrap">
          <button class="primary" @click="dlClient('setup')">⬇ 下载部署脚本 (ps1)</button>
          <button class="primary" @click="dlClient('install')">⬇ 下载安装批处理 (bat)</button>
          <button class="primary" @click="dlClient('uninstall')">⬇ 下载卸载脚本 (bat)</button>
        </div>
        <!-- 两套客户端引擎各自的在线状态（可装在不同电脑同时在线，任务按上面选的引擎分发） -->
        <div class="cli-row" style="margin-top:12px">
          <span class="badge" :class="cliOn('vibeasr') ? 'green' : 'red'">{{ cliOn('vibeasr') ? '在线' : '离线' }}</span>
          <b style="font-size:12.5px">💻 VibeASR 1.5B</b>
          <span v-if="cfg.client_engine==='vibeasr'" class="src-b">当前使用</span>
          <span class="muted" style="font-size:12px">{{ cliDesc('vibeasr') }}</span>
        </div>
        <div class="cli-row">
          <span class="badge" :class="cliOn('vibe7b') ? 'green' : 'red'">{{ cliOn('vibe7b') ? '在线' : '离线' }}</span>
          <b style="font-size:12.5px">🎮 VibeVoice-ASR 7B</b>
          <span v-if="cfg.client_engine==='vibe7b'" class="src-b">当前使用</span>
          <span class="muted" style="font-size:12px">{{ cliDesc('vibe7b') }}</span>
        </div>
        <div class="muted" style="font-size:12px; margin-top:6px; line-height:1.7">
          任务由客户端主动领取并回传结果，<b>不需要 NAS 能访问到客户端的 IP</b>（回填的局域网地址仅作参考）；转写完成的耗时 = 排队 + 音频下载 + 客户端计算。
        </div>
      </template>

      <!-- 自定义服务 -->
      <template v-else>
        <div class="muted" style="font-size:12.5px; line-height:1.8; margin-top:6px">
          使用自建的 vLLM / OpenAI 兼容转写服务（如 GPU 服务器上自己部署的 VibeVoice-ASR 7B），地址和模型名填在这里：
        </div>
        <div class="row" style="flex-wrap:wrap; gap:10px; margin-top:8px; align-items:flex-end">
          <label class="field">服务地址
            <input v-model="cfg.base_url" placeholder="http://192.168.1.10:8000" style="width:230px" />
          </label>
          <label class="field">模型名
            <input v-model="cfg.model" placeholder="vibevoice" style="width:140px" />
          </label>
          <button class="primary" style="margin-top:18px" @click="testHealth">保存并测试</button>
        </div>
        <div v-if="cfgMsg" :class="cfgOk ? 'ok-text' : 'err'" style="margin-top:8px">{{ cfgMsg }}</div>
      </template>
    </div>

    <!-- ============ 转写参数设置（页面下方，全局共享） ============ -->
    <div class="card" style="margin-bottom:12px">
      <h3>⚙️ 转写参数设置 <span class="muted" style="font-size:12px; font-weight:400">全局共享配置</span></h3>
      <div class="row" style="align-items:flex-start; gap:10px; flex-wrap:wrap">
        <label class="field" style="flex:1; min-width:260px">热词（逗号分隔，人名/术语等，提高识别准确率）
          <input v-model="cfg.hotwords" placeholder="如：张伟, 李娜, 产品名或常用术语" style="width:100%" />
        </label>
        <label class="field">超时（分钟）
          <input v-model.number="cfg.timeout_min" type="number" min="1" max="120" style="width:80px" />
        </label>
        <button class="primary" style="margin-top:18px" @click="saveCfgUi">保存设置</button>
      </div>
      <div v-if="cfgMsg && cfg.engine_mode!=='custom'" :class="cfgOk ? 'ok-text' : 'err'" style="margin-top:8px">{{ cfgMsg }}</div>
      <div class="muted" style="margin-top:10px; font-size:12px; line-height:1.7">
        「服务器引擎」首选 Whisper large-v3-turbo（时间戳+多语言），可切 VibeVoice-ASR BitNet（纯 CPU、纯文本转写）；
        「客户端电脑」可选 1.5B 部署包（任意电脑）或 7B 部署包（带 NVIDIA 显卡的电脑，说话人分离 + 时间戳）；
        「自定义服务」对接自己部署的 VibeVoice-ASR 7B（开源 <a href="https://github.com/microsoft/VibeVoice" target="_blank" rel="noopener">github.com/microsoft/VibeVoice</a>，需 NVIDIA 显卡），
        用其 <code>vllm_plugin</code> 目录的 <code>scripts/start_server.py</code> 启动 vLLM 服务后，把服务地址填到上方算力来源卡里。
      </div>
    </div>

    <!-- ============ 模型下载说明（页面最底） ============ -->
    <div class="card" style="margin-top:12px">
      <h3>📦 模型下载说明 <span class="muted" style="font-size:12px; font-weight:400">不同类型语音识别模型 · 官方链接与下载方法</span></h3>
      <div class="model-row">
        <div class="model-tag cpu">首选 · 纯 CPU</div>
        <div class="grow">
          <div class="model-name">Whisper large-v3-turbo（OpenAI 开源，whisper.cpp 引擎，无需显卡）</div>
          <div class="model-desc">
            本系统实际安装的是 whisper.cpp 转换的量化版 <code>ggml-large-v3-turbo-q8_0.bin</code>（约 <b>834MB</b>，CPU 上比 q5_0 更快更准），
            「一键安装引擎」自动从国内镜像下载，无需手动操作。转写自带时间戳、多语言；说话人恒为 1（单声道录音无法分离）。
          </div>
          <div class="model-links">
            原始模型 <a href="https://huggingface.co/openai/whisper-large-v3-turbo" target="_blank" rel="noopener">huggingface.co/openai/whisper-large-v3-turbo</a>
            ｜ 国内镜像 <a href="https://hf-mirror.com/openai/whisper-large-v3-turbo" target="_blank" rel="noopener">hf-mirror.com/openai/whisper-large-v3-turbo</a>
            ｜ 引擎 <a href="https://github.com/ggml-org/whisper.cpp" target="_blank" rel="noopener">github.com/ggml-org/whisper.cpp</a>
            ｜ 量化版 <a href="https://hf-mirror.com/ggerganov/whisper.cpp" target="_blank" rel="noopener">hf-mirror.com/ggerganov/whisper.cpp</a>
          </div>
        </div>
      </div>
      <div class="model-row">
        <div class="model-tag cpu">备选 · 纯 CPU</div>
        <div class="grow">
          <div class="model-name">VibeVoice-ASR-BitNet（1.5B 量化版，无需显卡）</div>
          <div class="model-desc">
            微软 VibeASR.cpp 引擎专用格式：2 个 GGUF 文件共约 <b>1.7 GB</b>（VAE 编码器 703MB + 语言模型 993MB），异构量化压缩自 4.6GB，
            普通 CPU 即可接近实时<b>纯文本转写</b>（支持热词；说话人分离/时间戳是 7B 版能力）。适合 NAS / 普通办公电脑 / 一键部署包。
          </div>
          <div class="model-links">
            官方引擎 <a href="https://github.com/microsoft/VibeASR.cpp" target="_blank" rel="noopener">github.com/microsoft/VibeASR.cpp</a>
            ｜ 模型 <a href="https://huggingface.co/microsoft/VibeVoice-ASR-BitNet" target="_blank" rel="noopener">huggingface.co/microsoft/VibeVoice-ASR-BitNet</a>
            ｜ 国内镜像 <a href="https://hf-mirror.com/microsoft/VibeVoice-ASR-BitNet" target="_blank" rel="noopener">hf-mirror.com/microsoft/VibeVoice-ASR-BitNet</a>
          </div>
          <div class="model-cmd">下载方法（国内镜像，只需 GGUF）：<code>HF_ENDPOINT=https://hf-mirror.com huggingface-cli download microsoft/VibeVoice-ASR-BitNet --include "*.gguf" --local-dir models/vibeasr</code></div>
        </div>
      </div>
      <div class="model-row">
        <div class="model-tag gpu">高精度 · 需显卡</div>
        <div class="grow">
          <div class="model-name">VibeVoice-ASR（7B 完整版，需 NVIDIA 显卡：8GB 可跑、12GB 稳）</div>
          <div class="model-desc">
            官方完整模型（bf16 权重约 8.7GB，部署后占约 15GB 磁盘），经 vLLM 部署为 OpenAI 兼容服务；支持 50+ 语言、长音频（单次最长约 60 分钟）、
            Who/When/What 结构化输出（说话人 + 时间戳 + 内容）与热词上下文。精度高于 BitNet 版。
            带显卡的 Windows 电脑可直接在「算力来源 → 客户端电脑 → VibeVoice-ASR 7B」下载一键部署包（自动配好 WSL2 + vLLM，12GB 显存按 32768 上下文 / 4 并发调优，显存更大的机器可在部署脚本里调高）。
          </div>
          <div class="model-links">
            官方仓库 <a href="https://github.com/microsoft/VibeVoice" target="_blank" rel="noopener">github.com/microsoft/VibeVoice</a>
            ｜ 模型 <a href="https://huggingface.co/microsoft/VibeVoice-ASR" target="_blank" rel="noopener">huggingface.co/microsoft/VibeVoice-ASR</a>
            ｜ 国内镜像 <a href="https://hf-mirror.com/microsoft/VibeVoice-ASR" target="_blank" rel="noopener">hf-mirror.com/microsoft/VibeVoice-ASR</a>
          </div>
          <div class="model-cmd">下载方法：带显卡电脑直接用上方「7B 一键部署包」；或本地源码 <code>D:\CC\VibeVoice-main</code> 进 <code>vllm_plugin</code> 目录，运行 <code>python scripts/start_server.py</code> 自动下载并启动 vLLM 服务（默认端口 8000）。</div>
        </div>
      </div>
      <div class="model-row">
        <div class="model-tag exp">实验 · 流式</div>
        <div class="grow">
          <div class="model-name">VibeVoice-ASR-Streaming-7B（流式识别实验版）</div>
          <div class="model-desc">边说边出字的流式变体，适合实时字幕类场景；部署要求同 7B 版（GPU + vLLM 插件）。</div>
          <div class="model-links">
            模型 <a href="https://huggingface.co/microsoft/VibeVoice-ASR-Streaming-7B" target="_blank" rel="noopener">huggingface.co/microsoft/VibeVoice-ASR-Streaming-7B</a>
            ｜ 国内镜像 <a href="https://hf-mirror.com/microsoft/VibeVoice-ASR-Streaming-7B" target="_blank" rel="noopener">hf-mirror.com/microsoft/VibeVoice-ASR-Streaming-7B</a>
          </div>
        </div>
      </div>
      <div class="muted" style="margin-top:8px; font-size:12px">提示：国内访问 HuggingFace 官方站可能受限，优先点「国内镜像」链接，或在命令前加 <code>HF_ENDPOINT=https://hf-mirror.com</code> 环境变量。</div>
    </div>

    <!-- ============ 播放器弹窗 ============ -->
    <div v-if="playRow" class="player-mask" @click.self="closePlayer">
      <div class="player-box">
        <div class="player-head">
          <b>▶ 播放录音 #{{ playRow.id }}</b>
          <span class="muted grow" style="margin-left:12px">{{ pathBasename(playRow.file_path) }} · {{ fmtDur(playRow.duration_sec) }} · {{ fmtSize(playRow.file_size) }}</span>
          <button class="small" @click="closePlayer">关闭</button>
        </div>
        <audio ref="playAudio" :key="playRow.id" :src="playUrl" controls autoplay style="width:100%" @error="onPlayError" @canplay="playError = ''"></audio>
        <div v-if="playError" class="err" style="margin-top:8px">⚠ {{ playError }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue';
import { marked } from 'marked';
import { api } from '../api';
import { toWavBlob } from '../learning/audioWav';

const fmtDur = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
// 转写耗时：从点「转写」到出结果的全程用时（转写整个录音用的时长；含排队/引擎加载/推理；拉取模式含客户端回连等待）
const fmtElapsed = (ms) => {
  const n = Number(ms) || 0;
  if (!n) return '—';
  const s = Math.round(n / 1000);
  if (!s) return '<1 秒';
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 时 ${Math.floor((s % 3600) / 60)} 分`;
};
const elapsedTitle = (r) => (Number(r.elapsed_ms) > 0
  ? `从点「转写」到出结果的全程用时（含排队与引擎加载），完成于 ${r.transcribed_at || '—'}`
  : '转写完成后显示耗时（未转写/失败/老记录无数据）');
const fmtSize = (b) => {
  const n = Number(b) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
};
const nowStr = () => new Date().toLocaleString('sv').slice(0, 19);

// ---------- 录音 ----------
const recFmt = ref('wav');
const mp3Rate = ref(16000);
const mp3Kbps = ref(64);
const recState = ref('idle'); // idle | recording | converting | saving

// ---------- 保存进度（录音结束后：整理 → 编译生成 → 上传服务器 → 服务器确认） ----------
const SAVE_STEPS = [
  { k: 'decode', label: '① 整理录音' },
  { k: 'encode', label: '② 编译生成文件' },
  { k: 'upload', label: '③ 上传服务器' },
];
const saveStage = ref('');          // '' | decode | encode | upload | server | done
const savePct = ref(0);             // 0-100（decode 0-15 / encode 15-45 / upload 45-99 / done 100）
const saveNote = ref('');
const saveFile = ref({ name: '', size: 0, took: 0 });
let saveDoneTimer = null;
let decodeFakeTimer = null;         // 解码黑盒阶段的缓慢推进动画（decodeAudioData 无法分段）
const saveBusy = computed(() => ['decode', 'encode', 'upload', 'server'].includes(saveStage.value));
function setStage(s, pct, note) { saveStage.value = s; savePct.value = pct; saveNote.value = note || ''; }
function startDecodeStage() {
  setStage('decode', Math.max(1, savePct.value), '整理录音数据（汇总分片、解码、重采样）…');
  if (decodeFakeTimer) clearInterval(decodeFakeTimer);
  decodeFakeTimer = setInterval(() => {
    if (saveStage.value === 'decode') savePct.value = Math.min(14, savePct.value + 0.7);
  }, 300);
}
function stopDecodeStage() { if (decodeFakeTimer) { clearInterval(decodeFakeTimer); decodeFakeTimer = null; } }
function finishSave(name, size, tookSec) {
  setStage('done', 100, '');
  saveFile.value = { name, size, took: tookSec };
  if (saveDoneTimer) clearTimeout(saveDoneTimer);
  saveDoneTimer = setTimeout(() => { if (saveStage.value === 'done') { saveStage.value = ''; savePct.value = 0; } }, 9000);
}
const stepCls = (k) => {
  const order = ['decode', 'encode', 'upload', 'server', 'done'];
  const cur = order.indexOf(saveStage.value === 'done' ? 'upload' : saveStage.value);
  const mine = order.indexOf(k);
  if (saveStage.value === 'done' || mine < cur) return 'ok';
  if (mine === cur) return 'cur';
  return '';
};
const stepIcon = (k) => { const c = stepCls(k); return c === 'ok' ? '✓' : c === 'cur' ? '⟳' : '○'; };
const recSecs = ref(0);
const recError = ref('');
let mediaStream = null;
let recorder = null;
let recChunks = [];
let recTimer = null;
let recStartedAt = '';

// ---------- 手机防断续三件套：屏幕常亮（Wake Lock）+ 每秒分片 + 切后台检测 ----------
// 手机浏览器锁屏/切后台会冻结页面，MediaRecorder 跟着停 → 录音一段一段没有声音。
const wakeOk = ref(false);
const recWarn = ref('');
let wakeLock = null;
let recHidden = false;
async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
    wakeOk.value = !!wakeLock;
    wakeLock?.addEventListener?.('release', () => { wakeLock = null; wakeOk.value = false; });
  } catch { wakeOk.value = false; } // 老内核（部分钉钉/企微 webview）不支持 → 走「请保持常亮」提示
}
function releaseWake() {
  try { wakeLock?.release?.(); } catch { /* ignore */ }
  wakeLock = null; wakeOk.value = false;
}
function onVisChange() {
  if (recState.value !== 'recording') return;
  if (document.visibilityState === 'hidden') {
    recHidden = true;   // 部分浏览器后台仍录，但多数会暂停/丢弃这段
    releaseWake();      // 系统此时会强制释放锁，同步一下状态
  } else {
    keepAwake();        // 回前台重新申请
    if (recHidden) recWarn.value = '刚才页面进入后台/锁屏，这段录音可能断续——录音期间请保持屏幕亮着；长时间录音建议用手机录音 App 录完再上传';
  }
}

async function startRec() {
  recError.value = '';
  recWarn.value = '';
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    recError.value = '当前浏览器不支持录制，请使用 Chrome / Edge 浏览器'; return;
  }
  if (recFmt.value === 'mp3') { try { await ensureLame(); } catch (e) { recError.value = e.message; return; } }
  try { mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) {
    recError.value = e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError'
      ? '浏览器已拒绝麦克风权限：点击地址栏左侧 🔒 图标 → 网站设置 → 麦克风 → 允许，然后重新录制'
      : e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError'
        ? '找不到麦克风设备：检查 Windows 设置→隐私→麦克风 是否开启，声音设置→录制设备 是否被禁用'
        : e.name === 'NotReadableError'
          ? '麦克风被其他程序占用（微信/腾讯会议/别的网页标签）：关掉后再试'
          : '无法访问麦克风：' + e.message;
    return;
  }
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  recChunks = [];
  recorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : {});
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = saveRec;
  recStartedAt = nowStr();
  recorder.start(1000); // 每秒一片：边录边出数据，长录音不易在个别内核上丢整段
  recState.value = 'recording';
  recSecs.value = 0;
  recHidden = false;
  recTimer = setInterval(() => { recSecs.value += 1; }, 1000);
  document.addEventListener('visibilitychange', onVisChange);
  keepAwake();
}
function stopRec() {
  if (recorder && recorder.state !== 'inactive') recorder.stop(); // onstop → saveRec
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
}
async function saveRec() {
  const t0 = Date.now();
  recState.value = 'converting';
  setStage('decode', 1, '整理录音数据…');
  try {
    const webm = new Blob(recChunks, { type: ((recorder && recorder.mimeType) || 'audio/webm') });
    if (webm.size < 1000 || recSecs.value < 1) throw new Error('录制太短，已丢弃');
    let blob, name;
    if (recFmt.value === 'mp3') {
      startDecodeStage();
      blob = await webmToMp3(webm, mp3Rate.value, mp3Kbps.value, (p) => {
        // p 0~1 全程：0~0.4 解码重采样（黑盒，靠动画推进），0.4~1 编码（真实进度）
        if (p < 0.4) { if (saveStage.value === 'decode') savePct.value = Math.min(14, Math.max(savePct.value, p / 0.4 * 15)); }
        else { stopDecodeStage(); setStage('encode', 15 + Math.floor((p - 0.4) / 0.6 * 30), `MP3 编码中 ${Math.floor((p - 0.4) / 0.6 * 100)}%…`); }
      });
      stopDecodeStage();
      name = `vibe-${Date.now()}.mp3`;
    } else {
      startDecodeStage();
      blob = await toWavBlob(webm);
      stopDecodeStage();
      setStage('encode', 45, 'WAV 文件已生成');
      name = `vibe-${Date.now()}.wav`;
    }
    recState.value = 'saving';
    setStage('upload', 45, `开始上传（文件 ${fmtSize(blob.size)}）…`);
    await uploadBlob(blob, name, 'record', recStartedAt, nowStr(), recSecs.value, (p, loaded, total) => {
      if (p < 1) setStage('upload', 45 + Math.floor(p * 54), `已上传 ${fmtSize(loaded)} / ${fmtSize(total)}（${Math.floor(p * 100)}%）`);
      else setStage('server', 99, '上传完成，服务器接收确认中…');
    });
    finishSave(name, blob.size, Math.max(1, Math.round((Date.now() - t0) / 1000)));
    await load();
  } catch (e) {
    stopDecodeStage();
    setStage('', 0, '');
    alert('录制保存失败：' + e.message);
  }
  releaseMic();
  recState.value = 'idle';
}
function releaseMic() {
  if (mediaStream) { for (const t of mediaStream.getTracks()) t.stop(); mediaStream = null; }
  recorder = null;
  document.removeEventListener('visibilitychange', onVisChange);
  releaseWake();
}

// ---------- lamejs（MP3 编码，动态加载本地 vendor 避开 Vite 打包兼容问题） ----------
let lameLoading = null;
function ensureLame() {
  if (window.lamejs?.Mp3Encoder) return Promise.resolve(window.lamejs);
  if (lameLoading) return lameLoading;
  lameLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/lame.min.js';
    s.onload = () => (window.lamejs?.Mp3Encoder ? resolve(window.lamejs) : reject(new Error('MP3 编码器加载异常')));
    s.onerror = () => reject(new Error('MP3 编码器加载失败（/vendor/lame.min.js）'));
    document.head.appendChild(s);
  });
  return lameLoading;
}
async function webmToMp3(blob, rate, kbps, onProg) {
  const rep = (p) => { if (onProg) onProg(p); };
  const lame = await ensureLame();
  rep(0.05);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let buf;
  try { buf = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close().catch(() => {}); }
  rep(0.28);
  // 重采样到目标采样率并混为单声道（语音识别足够，文件最小）
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.length * rate / buf.sampleRate)), rate);
  const srcNode = off.createBufferSource();
  srcNode.buffer = buf;
  srcNode.connect(off.destination);
  srcNode.start();
  const rendered = await off.startRendering();
  rep(0.4);
  const ch = rendered.getChannelData(0);
  const pcm = new Int16Array(ch.length);
  for (let i = 0; i < ch.length; i++) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  rep(0.44);
  const enc = new lame.Mp3Encoder(1, rate, kbps);
  const out = [];
  const total = pcm.length;
  let lastYield = 0;
  for (let i = 0; i < total; i += 1152) {
    const d = enc.encodeBuffer(pcm.subarray(i, i + 1152));
    if (d.length) out.push(new Uint8Array(d));
    // 每约 4 秒音频让出一次主线程：进度条能刷新、页面不卡死
    if (i - lastYield >= 48000 * 4) {
      lastYield = i;
      rep(0.44 + 0.56 * (i / total));
      await new Promise((r) => setTimeout(r));
    }
  }
  const fin = enc.flush();
  if (fin.length) out.push(new Uint8Array(fin));
  rep(1);
  return new Blob(out, { type: 'audio/mpeg' });
}

// ---------- 上传 ----------
const fileInput = ref(null);
const uploading = ref(false);
// 保存/上传期间离开页面会中断——挂 beforeunload 守卫（浏览器原生确认框）；声明须在 uploading 之后（watch 注册即求值）
const anyBusy = computed(() => saveBusy.value || uploading.value);
function onBusyUnload(e) { e.preventDefault(); e.returnValue = ''; }
watch(anyBusy, (b) => { if (b) window.addEventListener('beforeunload', onBusyUnload); else window.removeEventListener('beforeunload', onBusyUnload); });
const uploadMsg = ref('');
async function onPickFiles(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  uploading.value = true;
  let ok = 0;
  for (const f of files) {
    const started = nowStr();
    let hint = 0;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      try { hint = (await ctx.decodeAudioData(await f.arrayBuffer())).duration; } catch { /* 解码不了时服务端兜底 */ }
      ctx.close().catch(() => {});
    } catch { /* 忽略 */ }
    uploadMsg.value = `正在上传 ${f.name}（${fmtSize(f.size)}）…`;
    try {
      await uploadBlob(f, f.name, 'upload', started, nowStr(), hint, (p, loaded, total) => {
        uploadMsg.value = p < 1
          ? `正在上传 ${f.name}：${Math.floor(p * 100)}%（${fmtSize(loaded)} / ${fmtSize(total)}），请勿关闭页面…`
          : `服务器接收确认中…`;
      });
      ok++;
    } catch (err) {
      alert(`上传 ${f.name} 失败：` + err.message);
    }
  }
  uploading.value = false;
  uploadMsg.value = `已上传 ${ok}/${files.length} 个文件`;
  await load();
}
// XHR 上传（fetch 拿不到上传字节进度）；onProg(p, loaded, total) 0~1
function uploadBlob(blob, name, source, startedAt, endedAt, hint, onProg) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('audio', blob, name);
    fd.append('source', source);
    fd.append('started_at', startedAt);
    fd.append('ended_at', endedAt);
    fd.append('duration_hint', String(Math.round((Number(hint) || 0) * 10) / 10));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/vibe/upload');
    xhr.setRequestHeader('Authorization', 'Bearer ' + (localStorage.getItem('wb_token') || ''));
    xhr.responseType = 'json';
    xhr.timeout = 10 * 60 * 1000; // 大文件/慢网络 10 分钟兜底
    if (onProg && xhr.upload) {
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total) onProg(e.loaded / e.total, e.loaded, e.total); };
      xhr.upload.onload = () => onProg(1, 0, 0);
    }
    xhr.onload = () => {
      const d = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) resolve(d);
      else reject(new Error(d.error || `上传失败 (${xhr.status})`));
    };
    xhr.ontimeout = () => reject(new Error('上传超时（10 分钟）'));
    xhr.onerror = () => reject(new Error('网络错误，上传中断'));
    xhr.send(fd);
  });
}

// ---------- 列表 ----------
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(5);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
async function load() {
  try {
    const d = await api.get(`/vibe/records?page=${page.value}&pageSize=${pageSize.value}`);
    rows.value = d.rows || [];
    total.value = d.total || 0;
    rtfEst.value = Number(d.rtf_est) || 0;
  } catch (e) {
    rows.value = [];
  }
}
// 转写中自动轮询（3 秒拉列表）+ 每秒本地推进进度条（无请求）
let pollTimer = null;
let progTimer = null;
const rtfEst = ref(0);
const nowTick = ref(Date.now());
function syncPoll() {
  const running = rows.value.some((r) => r.status === 'running');
  if (running && !pollTimer) pollTimer = setInterval(pollTick, 3000);
  if (!running && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (running && !progTimer) { nowTick.value = Date.now(); progTimer = setInterval(() => { nowTick.value = Date.now(); }, 1000); }
  if (!running && progTimer) { clearInterval(progTimer); progTimer = null; }
}
// 转写进度估算：已用时间 / (音频时长 × 历史 RTF + 引擎加载余量)；拿不到起点或时长时返回 -1（不定进度）
function transPct(r) {
  if (!r || !r.run_ms || !Number(r.duration_sec)) return -1;
  const elapsed = nowTick.value - Number(r.run_ms);
  if (elapsed < 0) return -1;
  const rtf = rtfEst.value || 4;
  const estTotal = Number(r.duration_sec) * rtf * 1000 + 6000;
  return Math.max(3, Math.min(95, Math.round(elapsed / estTotal * 100)));
}
function transElapsed(r) { return r && r.run_ms ? Math.max(0, Math.round((nowTick.value - Number(r.run_ms)) / 1000)) : 0; }
function transEta(r) {
  if (!rtfEst.value || !r || !r.duration_sec) return '';
  const left = Math.max(0, Math.round(Number(r.duration_sec) * rtfEst.value + 6 - transElapsed(r)));
  return left > 0 ? `预计还约 ${left} 秒` : '即将完成（长录音较慢，请稍候）';
}
async function pollTick() {
  await load();
  syncPoll();
  // 选中行的转写完成/失败时刷新详情
  if (selectedId.value && detail.value && detail.value.status === 'running' && rows.value.find((r) => r.id === selectedId.value && r.status !== 'running')) {
    await loadDetail();
  }
}
onMounted(async () => { await load(); syncPoll(); loadCfg().then(() => { loadEngine(); loadClient(); syncEngPoll(); }); });
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
  if (progTimer) clearInterval(progTimer);
  if (engTimer) clearInterval(engTimer);
  if (saveDoneTimer) clearTimeout(saveDoneTimer);
  stopDecodeStage();
  window.removeEventListener('beforeunload', onBusyUnload);
  if (recState.value === 'recording') stopRec();
  releaseMic();
});

const statusText = (r) => ({ pending: '待转写', running: '转写中', done: '已生成', failed: '失败' }[r.status] || r.status);
const statusCls = (r) => ({ pending: 'amber', running: 'blue', done: 'green', failed: 'red' }[r.status] || '');
async function transcribe(r) {
  try {
    await api.post(`/vibe/transcribe/${r.id}`);
    await load();
    syncPoll();
    selectedId.value = r.id;
    await loadDetail();
  } catch (e) { alert('转写启动失败：' + e.message); }
}
async function downloadAudio(r) {
  try { await api.download(`/vibe/audio/${r.id}`); }
  catch (e) { alert('下载失败：' + e.message); }
}

// ---------- 播放（<audio> 带不了 Authorization 头，走 ?token= 查询参数，同家庭图床/练琴录音） ----------
const playRow = ref(null);
const playAudio = ref(null);
const playError = ref('');
const playUrl = computed(() => playRow.value
  ? `/api/vibe/audio/${playRow.value.id}?inline=1&token=${encodeURIComponent(localStorage.getItem('wb_token') || '')}`
  : '');
function openPlayer(r) {
  playRow.value = r;
  playError.value = '';
  // 部分 webview 不认 autoplay 属性（只认 JS 调用）：主动补一次播放；被拦截时用户手动点 ▶ 即可
  nextTick(() => { try { playAudio.value?.play?.()?.catch?.(() => {}); } catch { /* 自动播放被拒，手动播放 */ } });
}
function onPlayError() { playError.value = '音频加载失败——文件可能已损坏，或该格式此浏览器不支持（可点「下载」后用本地播放器打开）'; }
function closePlayer() { playRow.value = null; }
const shortPath = (p) => {
  const s = String(p || '');
  if (!s) return '—';
  const parts = s.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return parts.join('\\');
  return '…\\' + parts.slice(-2).join('\\');
};
const pathBasename = (p) => String(p || '').split(/[\\/]/).pop() || '录音文件';
async function delRow(r) {
  if (!confirm(`确定删除 #${r.id}（${r.started_at || ''}，${fmtDur(r.duration_sec)}）的录音与转写？`)) return;
  try {
    await api.del(`/vibe/records/${r.id}`);
    if (selectedId.value === r.id) { selectedId.value = null; detail.value = null; }
    await load();
  } catch (e) { alert('删除失败：' + e.message); }
}

// ---------- 转写详情（markdown 分页） ----------
const selectedId = ref(null);
const detail = ref(null);
const detailLoading = ref(false);
const mdPage = ref(1);
const jumpPage = ref(1);
const PAGE_CHARS = 600;
async function selectRow(r) {
  if (selectedId.value === r.id) { selectedId.value = null; detail.value = null; return; } // 再点一次收起
  selectedId.value = r.id;
  await loadDetail();
}
async function loadDetail() {
  if (!selectedId.value) return;
  detailLoading.value = true;
  try {
    detail.value = await api.get(`/vibe/transcript/${selectedId.value}`);
    mdPage.value = 1;
    jumpPage.value = 1;
  } catch (e) { detail.value = null; }
  detailLoading.value = false;
}
// 按段落切块累计约 PAGE_CHARS 字一页（不打断段落）
const mdPages = computed(() => {
  const md = detail.value?.transcript_md || '';
  if (!md) return [''];
  const paras = md.split(/\n{2,}/);
  const pages = [];
  let cur = '';
  for (const p of paras) {
    if (cur && (cur + '\n\n' + p).length > PAGE_CHARS) { pages.push(cur); cur = p; }
    else cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) pages.push(cur);
  return pages;
});
const totalPagesMd = computed(() => mdPages.value.length);
const pageMd = computed(() => marked.parse(mdPages.value[Math.min(mdPage.value, totalPagesMd.value) - 1] || '', { async: false }));
watch(totalPagesMd, () => { if (mdPage.value > totalPagesMd.value) mdPage.value = totalPagesMd.value; });
function doJump() {
  const n = Math.max(1, Math.min(totalPagesMd.value, parseInt(jumpPage.value, 10) || 1));
  mdPage.value = n;
  jumpPage.value = n;
}
function dl(format) {
  api.download(`/vibe/export/${selectedId.value}?format=${format}`).catch((e) => alert('下载失败：' + e.message));
}

// ---------- 设置 ----------
// client_engine：客户端电脑模式下的引擎选择——vibeasr=1.5B BitNet 纯 CPU | vibe7b=VibeVoice-ASR 7B（需 NVIDIA 显卡，WSL2+vLLM）
const cfg = ref({ base_url: '', model: 'vibevoice', hotwords: '', timeout_min: 30, engine_mode: 'server', server_engine: 'whisper', client_engine: 'vibeasr', whisper_lang: 'auto', client_url: '' });
const cfgMsg = ref('');
const cfgOk = ref(false);
async function loadCfg() {
  try { cfg.value = await api.get('/vibe/settings'); } catch { /* 保持默认 */ }
}
async function saveCfg() {
  cfg.value = await api.put('/vibe/settings', cfg.value);
}
async function saveCfgUi() {
  try {
    await saveCfg();
    cfgOk.value = true;
    cfgMsg.value = '已保存';
  } catch (e) { cfgOk.value = false; cfgMsg.value = '保存失败：' + e.message; }
}
async function testHealth() {
  cfgMsg.value = '正在测试…';
  cfgOk.value = false;
  try {
    await saveCfg();
    const d = await api.get('/vibe/health');
    cfgOk.value = true;
    cfgMsg.value = '连接成功' + (d.models?.length ? `，可用模型：${d.models.join('、')}` : '');
  } catch (e) { cfgMsg.value = e.message; }
}

// ---------- 算力来源 / 服务器引擎（whisper 首选 | vibeasr 备选，状态接口一次带回两套） ----------
const engine = ref({ installed: false, running: false, ready: false, port: 9650, restarts: 0 });
const engInstall = ref({ running: false, progress: 0, error: '', log: [], steps: [] });
const clientInfo = ref({ online: false, url: '', host: '', engines: {}, client_engine: 'vibeasr' });
const engines = ref({}); // { whisper: {installed,service,install,port}, vibeasr: {...} }
const engKey = () => (cfg.value.server_engine === 'whisper' ? 'whisper' : 'vibeasr');
function applySelEngine() {
  const e = engines.value[engKey()] || {};
  engine.value = { ...(e.service || {}), installed: !!e.installed };
  engInstall.value = { ...(e.install || {}) };
}
const engInstallStep = computed(() => {
  const s = engInstall.value.steps.find((x) => x.state === 'active');
  return s ? s.label : (engInstall.value.error ? '失败' : '');
});
async function loadEngine() {
  try {
    const d = await api.get('/vibe/engine/status');
    engines.value = d.engines || {};
    if (d.server_engine && cfg.value.server_engine !== d.server_engine) cfg.value.server_engine = d.server_engine;
    applySelEngine();
  } catch { /* 静默 */ }
}
async function loadClient() {
  try {
    const d = await api.get('/vibe/client-status');
    clientInfo.value = { online: !!d.online, url: '', host: '', engines: d.engines || {}, client_engine: d.client_engine || 'vibeasr' };
    if (d.client_engine && cfg.value.client_engine !== d.client_engine) cfg.value.client_engine = d.client_engine;
  } catch { /* 静默 */ }
}
// 两套客户端引擎各自的登记信息（可同时在线）：15 分钟内有心跳/领取 = 在线（与服务端判定一致）
const cli = (e) => (clientInfo.value.engines || {})[e] || {};
const cliOn = (e) => Date.now() - (Number(cli(e).last_seen) || 0) < 15 * 60 * 1000;
const cliDesc = (e) => {
  const c = cli(e);
  if (!c.host) return '尚无客户端登记';
  return `${c.host}${c.gpu ? ' · ' + c.gpu : ''} · 拉取模式（主动回连，无需地址）`;
};
async function setServerEngine(m) {
  cfg.value.server_engine = m;
  applySelEngine(); // 先即时切换视图，保存成功后状态轮询接管
  try { await saveCfg(); } catch { /* 保存失败下次进页面会纠正 */ }
  loadEngine();
}
async function setClientEngine(m) {
  cfg.value.client_engine = m;
  try { await saveCfg(); } catch { /* 保存失败下次进页面会纠正 */ }
  loadClient();
}
async function saveLang() {
  try { await saveCfg(); } catch { /* 语言保存失败不弹窗，设置卡里还能再存 */ }
}
async function installEngine() {
  try {
    await api.post('/vibe/engine/install', { engine: engKey() });
    await loadEngine();
  } catch (e) { alert('启动安装失败：' + e.message); }
}
async function resetInstall() {
  try {
    await api.post('/vibe/engine/install-reset', { engine: engKey() });
    await loadEngine();
  } catch (e) { alert('清除失败：' + e.message); }
}
async function engineAction(a) {
  try { await api.post(`/vibe/engine/${a}`, { engine: engKey() }); setTimeout(loadEngine, 800); }
  catch (e) { alert('操作失败：' + e.message); }
}
async function removeModels() {
  const k = engKey();
  const size = k === 'whisper' ? '0.9GB' : '1.7GB';
  if (!confirm(`确定删除服务器上的 ${k === 'whisper' ? 'Whisper' : 'VibeASR'} 模型文件（约 ${size}）？\n\n用于服务器 CPU 带不动引擎（转写奇慢）的场景。\n删除后该引擎不可用（另一套引擎 / 客户端电脑 / 自定义服务不受影响），需要时可随时重新一键安装（只重新下载模型）。`)) return;
  try {
    const r = await api.post('/vibe/engine/remove-models', { engine: k });
    alert(`已删除模型文件，释放 ${(Number(r.freed || 0) / 1024 ** 3).toFixed(2)}GB`);
    loadEngine();
  } catch (e) { alert('删除失败：' + (e.message || e)); setTimeout(loadEngine, 800); }
}
async function setMode(m) {
  cfg.value.engine_mode = m;
  await saveCfgUi();
  loadEngine(); loadClient();
}
// 部署包按当前所选客户端引擎下发（vibeasr=1.5B | vibe7b=7B WSL2 版）
function dlClient(type) {
  const eng = cfg.value.client_engine === 'vibe7b' ? 'vibe7b' : 'vibeasr';
  api.download(`/vibe/client-files?type=${type}&engine=${eng}`).catch((e) => alert('下载失败：' + e.message));
}
// 引擎状态轮询：安装中 / 加载中 / 客户端模式在线状态
let engTimer = null;
function syncEngPoll() {
  const need = engInstall.value.running
    || (cfg.value.engine_mode === 'server' && engine.value.installed && !engine.value.ready)
    || cfg.value.engine_mode === 'client';
  const period = engInstall.value.running ? 2500 : 15000;
  if (need && !engTimer) engTimer = setInterval(async () => {
    await loadEngine();
    if (cfg.value.engine_mode === 'client') loadClient();
    syncEngPoll();
  }, period);
  if (!need && engTimer) { clearInterval(engTimer); engTimer = null; }
}
watch(() => [engInstall.value.running, cfg.value.engine_mode, cfg.value.server_engine, engine.value.ready, engine.value.installed], syncEngPoll);
</script>

<style scoped>
/* ---------- 录音保存进度（三节点 + 进度条） ---------- */
.save-box { margin-top: 10px; max-width: 620px; }
.sp-steps { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12.5px; margin-bottom: 2px; }
.sp-step { padding: 2px 10px; border-radius: 12px; background: rgba(128, 128, 128, .12); color: var(--muted, #8a8f98); }
.sp-step.cur { background: rgba(79, 124, 247, .16); color: var(--accent, #4f7cf7); font-weight: 600; }
.sp-step.ok { background: rgba(46, 158, 91, .13); color: var(--green, #2e9e5b); }
.sp-arrow { color: #9aa0a6; }
.pbar { height: 9px; border-radius: 6px; background: rgba(128, 128, 128, .16); overflow: hidden; margin: 8px 0 7px; }
.pfill { height: 100%; border-radius: 6px; background: var(--accent, #4f7cf7); transition: width .25s ease; }
.sp-note { font-size: 12.5px; color: var(--muted, #8a8f98); }
.sp-note.ok { color: var(--green, #2e9e5b); }
.sp-note.ok b { color: inherit; }
.sp-warn { color: #d97706; }
/* ---------- 转写进度（列表行内迷你条 + 详情大条） ---------- */
.tp-wrap { margin-top: 4px; max-width: 170px; }
.tp-bar { height: 6px; border-radius: 4px; background: rgba(128, 128, 128, .18); overflow: hidden; position: relative; }
.tp-fill { height: 100%; border-radius: 4px; background: var(--accent, #4f7cf7); transition: width .6s ease; }
.tp-fill.indet { width: 40%; animation: tp-slide 1.2s infinite linear; }
@keyframes tp-slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
.tp-note { font-size: 11px; color: #8a8f98; white-space: nowrap; }
.tp-bar.big { height: 10px; max-width: 460px; margin: 6px 0 8px; }
.rec-btn { font-size: 15px; padding: 10px 24px; border: none; border-radius: 10px; background: var(--accent); color: #fff; cursor: pointer; }
.rec-btn.stop { background: #e5484d; }
.rec-btn:disabled { opacity: .6; cursor: not-allowed; }
.rec-time { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; color: #e5484d; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text3); }
.err { color: #e5484d; margin-top: 8px; font-size: 13px; white-space: pre-wrap; }
.ok-text { color: var(--green, #2e9e5b); }
.tbl-wrap { overflow-x: auto; }
.tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.tbl th { text-align: left; font-weight: 500; color: var(--text3); padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.tbl td { padding: 7px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.row-click { cursor: pointer; }
.row-click:hover { background: rgba(79, 124, 247, .06); }
.row-click.sel { background: rgba(79, 124, 247, .12); }
.src-b { font-size: 10.5px; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--border); color: var(--text3); margin-left: 4px; }
.badge { border-radius: 10px; padding: 1px 8px; font-size: 11px; }
.badge.blue { background: rgba(79, 124, 247, .15); color: var(--accent, #4f7cf7); }
.badge.green { background: rgba(46, 158, 91, .15); color: var(--green, #2e9e5b); }
.badge.amber { background: rgba(227, 160, 8, .15); color: #c2870a; }
.badge.red { background: rgba(229, 72, 77, .15); color: #e5484d; }
button.danger { color: #e5484d; }
.pager { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-size: 13px; flex-wrap: wrap; }
.detail-bar { display: flex; gap: 16px; align-items: center; font-size: 13px; color: var(--text3); margin-bottom: 10px; flex-wrap: wrap; }
.md-page { border: 1px solid var(--border); border-radius: 10px; padding: 14px 18px; margin-bottom: 10px; }
input[type='number'] { width: 64px; }
/* 文件路径列：截断显示，悬停看全路径 */
.path-cell { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; font-size: 11.5px; color: var(--text3); }
/* 使用模型列：截断显示，悬停看全名（如 whisper-large-v3-turbo（服务器引擎）） */
.model-cell { max-width: 170px; overflow: hidden; text-overflow: ellipsis; font-size: 11.5px; color: var(--text3); }
/* 播放器弹窗 */
.player-mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 90; display: flex; align-items: center; justify-content: center; }
.player-box { background: var(--bg2, #fff); border-radius: 14px; padding: 18px 20px; width: min(560px, 92vw); box-shadow: 0 12px 48px rgba(0,0,0,.35); }
.player-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; font-size: 14px; flex-wrap: wrap; }
.player-box audio { display: block; }
/* 录音 + 上传 同一矩形框左右分开（窄屏折行为上下） */
.ru-grid { display: grid; grid-template-columns: 1fr 1fr; }
.ru-right { border-left: 1px dashed var(--border); padding-left: 24px; }
@media (max-width: 760px) {
  .ru-grid { grid-template-columns: 1fr; }
  .ru-right { border-left: none; padding-left: 0; border-top: 1px dashed var(--border); padding-top: 14px; margin-top: 14px; }
}
/* 算力来源切换 */
.mode-switch { display: flex; gap: 6px; }
.mode-switch button { flex: 1; padding: 7px 4px; font-size: 12.5px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text2, inherit); cursor: pointer; }
.mode-switch button.on { border-color: var(--accent, #4f7cf7); background: rgba(79, 124, 247, .12); color: var(--accent, #4f7cf7); font-weight: 600; }
.progress-outer { height: 8px; border-radius: 6px; background: var(--border); overflow: hidden; }
.progress-inner { height: 100%; border-radius: 6px; background: var(--accent, #4f7cf7); transition: width .4s; }
.eng-log { margin-top: 6px; font-size: 11px; line-height: 1.6; color: var(--text3); background: rgba(127,127,127,.07); border-radius: 8px; padding: 8px 10px; max-height: 120px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
.guide-list { margin: 6px 0 0 0; padding-left: 18px; font-size: 12.5px; color: var(--text3); line-height: 1.9; }
.guide-list code { font-size: 11px; }
/* 客户端引擎在线状态行（1.5B / 7B 各一行） */
.cli-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 6px; font-size: 12.5px; }
/* 模型下载说明卡 */
.model-row { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px dashed var(--border); }
.model-row:last-of-type { border-bottom: none; }
.model-tag { flex-shrink: 0; align-self: flex-start; font-size: 11px; padding: 2px 10px; border-radius: 10px; font-weight: 600; white-space: nowrap; }
.model-tag.cpu { background: rgba(46, 158, 91, .15); color: var(--green, #2e9e5b); }
.model-tag.gpu { background: rgba(79, 124, 247, .15); color: var(--accent, #4f7cf7); }
.model-tag.exp { background: rgba(227, 160, 8, .15); color: #c2870a; }
.model-name { font-weight: 600; font-size: 13.5px; margin-bottom: 4px; }
.model-desc { font-size: 12.5px; color: var(--text3); line-height: 1.7; margin-bottom: 4px; }
.model-links { font-size: 12px; line-height: 1.8; }
.model-links a { color: var(--accent, #4f7cf7); }
.model-cmd { font-size: 12px; color: var(--text3); margin-top: 4px; line-height: 1.7; word-break: break-all; }
.model-cmd code { font-size: 11px; }
</style>
