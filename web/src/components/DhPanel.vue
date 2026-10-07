<template>
  <!-- 数字人面板（v1.12.1）：智能家居页第二个 tab。三个子页签（每次进入一律从「数字人界面」开始）：
       ①数字人界面——画面 + 实时对话（v1.12.1：服务端建 Vivix 会话，浏览器 WSS 控制 + TRTC 拉流，
         Key 配好即亮「开始实时对话」；打字/开麦都能聊，记录落「聊天记录」）+ 一键切换默认人物
       ②聊天记录——左：人物角色选择（头像+名称，同角色注册表样式）；右：大框聊天气泡窗口
       ③设置——自上而下：叠放卡片固定预览 → 参考图上传管理 → 基本信息+API（含公网访问地址） → 人设引导构建 -->
  <div>
    <!-- 子页签（不占外层 ?tab= 查询参数；v1.12.1 起不记忆上次子页签，进 tab 一律回到「数字人界面」） -->
    <div class="dh-subtabs">
      <button v-for="s in SUBS" :key="s.key" :class="{ active: sub === s.key }" @click="sub = s.key">{{ s.label }}</button>
    </div>

    <div v-if="err" class="msg err" style="margin-bottom:10px">{{ err }}</div>
    <div v-if="okMsg" class="msg ok" style="margin-bottom:10px">{{ okMsg }}</div>

    <!-- 没有任何数字人：引导去设置新建 -->
    <div v-if="loaded && !personas.length" class="card" style="text-align:center;padding:40px">
      <span class="material-icons" style="font-size:44px;color:var(--muted)">smart_toy</span>
      <h3 style="margin:12px 0 8px">还没有数字人</h3>
      <p style="color:var(--muted);margin:0 0 16px">先建一个角色：选类型（男友/女友/宠物）、上传参考图、调人设，就能在右下角和悬浮窗里见到 TA。</p>
      <button class="btn" @click="sub = 'settings'">去设置新建</button>
    </div>

    <template v-else>
      <!-- ==================== ① 数字人界面 ==================== -->
      <template v-if="sub === 'main'">
        <div class="card dh-main-card">
          <!-- 画面：静态预览与直播同一限尺寸公式（v1.12.3：高封顶 78vh 按比例缩宽、居中——不再撑满整卡）；
               直播时比例切到流的真实宽高（v1.12.2，见 stageStyle），视频 contain 不裁切 -->
          <div class="dh-stage" :style="stageStyle">
            <img v-if="frontImg && !live.on" class="dh-stage-img" :src="imgSrc(frontImg)" alt="" draggable="false" />
            <div v-if="!frontImg && !live.on" class="dh-stage-empty">当前数字人还没有参考图，去「设置」上传一张（建议胸像~腰像、面朝镜头、手全入画）</div>
            <!-- 实时画面容器（常驻 DOM，TRTC 往里塞 video；v-show 控制） -->
            <div v-show="live.on" class="dh-stage-video" id="dh-live-view"></div>
            <!-- 角标三态：未配 Key=待接入 · 配了未开=可开始 · 开启=实时中 -->
            <div v-if="!live.on" class="dh-stage-live" :class="{ ready: cur && cur.hasKey }">
              <i></i>{{ cur && cur.hasKey ? '实时画面 · 未开启' : '实时画面 · 待接入（设置页完成 API Key 连通测试后开启）' }}
            </div>
            <div v-else class="dh-stage-live onair"><i></i>实时{{ live.status && live.status !== '实时' ? ' · ' + live.status : '' }}</div>
            <!-- 浏览器自动播放策略拦截时一键恢复（TRTC AUTOPLAY_FAILED 的 resume 回调） -->
            <button v-if="live.needResume" class="dh-stage-resume" @click="resumePlay">▶ 点击开启画面与声音</button>
            <div v-if="cur && !live.on" class="dh-stage-caption">
              <b>{{ cur.name }}</b>：{{ cur.persona.opening }}
            </div>
          </div>
          <div v-if="live.err" class="dh-live-err">⚠ {{ live.err }}</div>

          <!-- 摘要 + 实时会话开关 -->
          <div class="dh-main-info" v-if="cur">
            <div class="dh-chips">
              <span class="dh-chip">{{ cur.type }}</span>
              <span class="dh-chip">{{ voiceLabel(cur.voice_id) }}</span>
              <span class="dh-chip">{{ cur.persona.aspect }} · {{ cur.persona.resolution }}</span>
              <span class="dh-chip">参考图 {{ cur.images.length }} 张</span>
            </div>
            <p class="dh-main-line">{{ cur.persona.personaLine }}<template v-if="cur.persona.callUser"> · 称呼你「{{ cur.persona.callUser }}」</template></p>
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <button v-if="!live.on" class="btn" :disabled="!cur.hasKey || live.busy"
                :title="cur.hasKey ? '' : '先在「设置 → API 接入」配置 Vivix API Key 并保存'" @click="startLive">
                {{ live.busy ? '正在建立…' : '▶ 开始实时对话' }}
              </button>
              <template v-else>
                <button class="btn danger ghost" :disabled="live.busy" @click="stopLive">{{ live.busy ? '正在结束…' : '■ 结束对话' }}</button>
                <button class="btn ghost" @click="toggleMic">{{ live.micOn ? '🎤 关麦' : '🎤 开麦说话' }}</button>
              </template>
              <button class="btn ghost" @click="openPhone"><span class="material-icons" style="font-size:14px;vertical-align:-2px">smartphone</span> 悬浮窗</button>
              <button class="btn ghost" @click="sub = 'chat'">聊天记录</button>
            </div>
          </div>
        </div>

        <!-- 实时对话文字通道（语音对方直接说出来；文字双方都落「聊天记录」） -->
        <div v-if="live.on" class="card dh-live-chat">
          <div class="dh-live-log" ref="liveLogEl">
            <div v-if="!liveItems.length" class="dh-live-empty">实时对话已开始，对方会先开口说开场白。打字或点「开麦」都能聊；这里的每一句都会存进「聊天记录」。</div>
            <div v-for="(m, i) in liveItems" :key="i" class="dh-lrow" :class="m.role">
              <div class="dh-lbubble">{{ m.text }}</div>
            </div>
          </div>
          <div class="dh-live-input">
            <input v-model="liveText" placeholder="打字对 TA 说…（回车发送，对方会开口念出来）" @keyup.enter="sendLive" />
            <button class="btn" :disabled="!liveText.trim()" @click="sendLive">发送</button>
          </div>
        </div>

        <!-- 默认人物切换（点卡片即切换；就是悬浮按钮/悬浮窗用的那个人） -->
        <div class="card">
          <h3 style="margin:0 0 10px;font-size:15px">切换默认人物</h3>
          <div class="dh-persona-grid">
            <div v-for="p in personas" :key="p.id" class="dh-persona-card" :class="{ on: p.is_default }" @click="setDefault(p)">
              <img v-if="p.images.length" :src="imgSrc(p.images[0])" alt="" />
              <span v-else class="material-icons dh-persona-none">smart_toy</span>
              <div class="dh-persona-name">
                <b>{{ p.name }}</b>
                <small>{{ p.type }}<template v-if="p.is_default"> · 默认</template></small>
              </div>
              <i v-if="p.is_default" class="dh-persona-check material-icons">check_circle</i>
            </div>
          </div>
        </div>
      </template>

      <!-- ==================== ② 设置 ==================== -->
      <template v-else-if="sub === 'settings'">
        <div class="dh-settings">
          <!-- 左：角色注册表 -->
          <div class="card dh-reg">
            <div class="dh-reg-head">
              <h3 style="margin:0;font-size:15px">角色注册表</h3>
              <button class="btn sm" @click="createPersona">＋ 新建</button>
            </div>
            <div v-for="p in personas" :key="p.id" class="dh-reg-item" :class="{ on: p.id === selId }" @click="select(p.id)">
              <img v-if="p.images.length" :src="imgSrc(p.images[0])" alt="" />
              <span v-else class="material-icons dh-persona-none">smart_toy</span>
              <div class="dh-persona-name">
                <b>{{ p.name }}<i v-if="p.is_default" class="dh-reg-def">默认</i></b>
                <small>{{ p.type }} · {{ p.hasKey ? 'Key 已配' : 'Key 未配' }}</small>
              </div>
            </div>
          </div>

          <!-- 右：编辑器（v1.12.1 自上而下：叠放卡片 → 参考图 → 基本信息 → 人设引导设置框） -->
          <div class="dh-editor" v-if="form">
            <!-- ① 固定预览：叠放卡片（最上面）+ 参考图上传与管理 -->
            <div class="card">
              <h3 class="dh-sec">固定预览（叠放卡片）</h3>
              <DhCardDeck :images="form.images" height="300px" />

              <div class="dh-reg-head" style="margin-top:16px">
                <h3 style="margin:0;font-size:15px">参考图（首图定格外观，最多 {{ meta.max_images }} 张）</h3>
                <div style="display:flex;gap:8px">
                  <label class="btn sm" :class="{ dis: uploading }">
                    {{ uploading ? '上传中…' : '＋ 上传' }}<input type="file" accept="image/png,image/jpeg,image/webp" hidden :disabled="uploading" @change="uploadImg" />
                  </label>
                </div>
              </div>
              <p class="dh-img-tip">官方规则：≥512×512、PNG/JPG/WEBP、单张 ≤10MB；推荐<b>胸像~腰像</b>、面朝镜头、<b>手全入画</b>、光线柔和背景简洁——服装/背景/构图全部定格在首图，运行时改不了。建会话取前 5 张，第一张=首图（开场白载体）。</p>

              <div v-if="form.images.length" class="dh-img-list">
                <div v-for="(im, i) in form.images" :key="im.id" class="dh-img-row">
                  <img :src="imgSrc(im)" alt="" loading="lazy" />
                  <div class="dh-img-meta">
                    <b>{{ i === 0 ? '首图 · ' : '' }}{{ im.orig_name }}<small>{{ (im.size / 1024).toFixed(0) }} KB</small></b>
                    <input v-model="im.description" placeholder="构图/姿势/服装/场景描述（帮模型理解可动范围）" @change="saveImgMeta(im)" />
                  </div>
                  <div class="dh-img-ops">
                    <button class="btn sm ghost" :disabled="i === 0" title="前移（越小越靠前）" @click="moveImg(i, -1)">↑</button>
                    <button class="btn sm ghost" :disabled="i === form.images.length - 1" title="后移" @click="moveImg(i, 1)">↓</button>
                    <button class="btn sm danger ghost" @click="removeImg(im)">删</button>
                  </div>
                </div>
              </div>
              <div v-else class="dh-img-empty">还没有参考图</div>
            </div>

            <!-- ② 基本信息 + API 接入 -->
            <div class="card">
              <h3 class="dh-sec">基本信息</h3>
              <div class="dh-grid2">
                <div class="dh-field"><label>名字</label><input v-model="form.name" placeholder="如：小星" /></div>
                <div class="dh-field"><label>类型</label>
                  <select v-model="form.type"><option v-for="t in meta.types" :key="t" :value="t">{{ t }}</option></select>
                </div>
              </div>
              <div class="dh-grid2">
                <div class="dh-field"><label>备注信息（一句话）</label><input v-model="form.remark" placeholder="如：默认示例：20 岁女友" /></div>
                <div class="dh-field"><label>备注说明（长文本）</label><input v-model="form.note" placeholder="用途/来历/注意事项" /></div>
              </div>

              <h3 class="dh-sec">API 接入（Vivix 实时数字人）</h3>
              <div class="dh-grid2">
                <div class="dh-field"><label>API Base</label><input v-model="form.api_base" placeholder="https://api.vivix.ai" /></div>
                <div class="dh-field"><label>模型</label><input v-model="form.model" placeholder="vivix-a1-stream" /></div>
              </div>
              <div class="dh-grid2">
                <div class="dh-field"><label>API Key<span class="dh-hint">{{ form.hasKey ? '（已保存，输入新值即替换）' : '（console.vivix.ai 生成）' }}</span></label>
                  <input v-model="newKey" type="password" autocomplete="new-password" placeholder="sk-…" />
                </div>
                <div class="dh-field"><label>声音（内置 Qwen Audio 九音色）</label>
                  <select v-model="form.voice_id">
                    <option v-for="v in meta.voices" :key="v.id" :value="v.id">{{ v.label }}</option>
                  </select>
                </div>
              </div>
              <div class="dh-field"><label>公网访问地址<span class="dh-hint">（Vivix 从公网取参考图用，实时对话必填）</span></label>
                <input v-model="form.public_base" placeholder="https://cc.in1912.cc（工作台的公网域名，须 https）" />
              </div>
              <p class="dh-img-tip" style="margin:-4px 0 10px">Vivix 服务器建会话时要<b>自己下载参考图</b>（不支持 base64）：这里填工作台的公网 HTTPS 地址（内网 IP 它取不到）。没填的话「开始实时对话」会明确提示。</p>
              <div class="dh-actions">
                <button class="btn sm" :disabled="testing" @click="testKey">{{ testing ? '测试中…' : '连通测试' }}</button>
                <button v-if="form.hasKey" class="btn sm ghost" :disabled="balBusy" @click="fetchBalance">{{ balBusy ? '查余额中…' : '💰 查余额' }}</button>
                <button v-if="form.hasKey" class="btn sm ghost" :disabled="testing" @click="clearKey">清除已存 Key</button>
                <span v-if="testResult" class="dh-test" :class="testResult.ok ? 'ok' : 'bad'">
                  {{ testResult.ok ? `✓ 连通 ${testResult.latency_ms}ms` : '✗ ' + testResult.error }}
                  <template v-if="testResult.ok && testResult.model_ok"> · {{ form.model }} 可用</template>
                  <template v-else-if="testResult.ok"> · ⚠ {{ form.model }} 不在可用列表</template>
                </span>
                <span v-if="balInfo" class="dh-test" :class="balInfo.ok ? 'ok' : 'bad'">{{ balText }}</span>
              </div>
            </div>

            <!-- ③ 人设引导构建（设置框） -->
            <div class="card">
              <h3 class="dh-sec">人设引导构建</h3>
              <div class="dh-field"><label>人设一句话</label><input v-model="form.persona.personaLine" placeholder="20 岁女友，性格温柔爱撒娇" /></div>
              <div class="dh-grid2">
                <div class="dh-field dh-inline">
                  <label><input type="checkbox" v-model="form.persona.shortSentences" /> 口语短句（单句 ≤ <input class="dh-num" type="number" v-model="form.persona.maxLen" min="6" max="60" /> 字）</label>
                </div>
                <div class="dh-field"><label>对用户的称呼</label><input v-model="form.persona.callUser" placeholder="宝宝" /></div>
              </div>
              <div class="dh-grid2">
                <div class="dh-field"><label>口语习惯（口头语）</label><input v-model="form.persona.habits" placeholder="好啦、真的假的、吼、欸你" /></div>
                <div class="dh-field"><label>场景（服装/光线/背景，定格在首图里）</label><input v-model="form.persona.scene" placeholder="居家、自然侧光、简洁背景、棉质背心" /></div>
              </div>

              <div class="dh-grid2">
                <div class="dh-field"><label>画面比例</label>
                  <select v-model="form.persona.aspect"><option v-for="a in meta.aspects" :key="a" :value="a">{{ a }}</option></select>
                </div>
                <div class="dh-field"><label>分辨率</label>
                  <select v-model="form.persona.resolution"><option v-for="r in meta.resolutions" :key="r" :value="r">{{ r }}{{ r === '720p' ? '（最高档）' : '' }}</option></select>
                </div>
              </div>
              <div class="dh-grid2">
                <div class="dh-field dh-inline">
                  <label><input type="checkbox" v-model="form.persona.cameraFixed" /> 固定平视机位</label>
                </div>
                <div class="dh-field dh-inline">
                  <label><input type="checkbox" v-model="form.persona.cameraLock" /> 镜头跟平移但构图锁定</label>
                </div>
              </div>
              <div class="dh-grid2">
                <div class="dh-field"><label>景别</label><input v-model="form.persona.shot" placeholder="中景（画面下缘胸口）" /></div>
                <div class="dh-field"><label>人物占比</label><input v-model="form.persona.ratio" placeholder="60%" /></div>
              </div>
              <div class="dh-field"><label>允许的动作</label><textarea v-model="form.persona.allowMove" rows="2" placeholder="眨眼、微笑、轻点头、小手势、自然呼吸；1 米内缓慢移动"></textarea></div>
              <div class="dh-field"><label>禁止的动作</label><textarea v-model="form.persona.forbidMove" rows="2" placeholder="快速大转头、手与头发遮脸、走出画面、剧烈运镜、改变距离"></textarea></div>
              <div class="dh-grid2">
                <div class="dh-field"><label>开场白（首图开口第一句）</label><input v-model="form.persona.opening" placeholder="我在呢，怎么啦" /></div>
                <div class="dh-field dh-inline"><label><input type="checkbox" v-model="form.persona.interrupt" /> 可打断（interrupt）</label></div>
              </div>
              <div class="dh-field"><label>其他引导设置（预留，直接写进人设）</label><textarea v-model="form.persona.extra" rows="2" placeholder="如：晚上十一点后要提醒我睡觉"></textarea></div>

              <div class="dh-actions" style="margin-top:14px">
                <button class="btn" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存设置' }}</button>
                <button v-if="!form.is_default" class="btn ghost" @click="setDefaultById(form.id)">设为默认人物</button>
                <button class="btn danger ghost" @click="removePersona(form)">删除该数字人</button>
                <button class="btn ghost" @click="showPreview">会话 JSON 预览</button>
              </div>
            </div>
          </div>
          <div v-else class="card dh-editor" style="color:var(--muted);text-align:center;padding:40px">选择左侧角色，或点「新建」</div>
        </div>
      </template>

      <!-- ==================== ② 聊天记录（左：人物角色选择 · 右：大框聊天气泡窗口） ==================== -->
      <template v-else-if="sub === 'chat'">
        <div class="dh-chat-layout">
          <!-- 左：人物角色选择（头像 + 角色名称，同设置页角色注册表样式） -->
          <div class="card dh-chat-side">
            <div class="dh-reg-head">
              <h3 style="margin:0;font-size:15px">人物角色</h3>
            </div>
            <div v-for="p in personas" :key="p.id" class="dh-reg-item" :class="{ on: p.id === chatId }" @click="chatId = p.id">
              <img v-if="p.images.length" :src="imgSrc(p.images[0])" alt="" />
              <span v-else class="material-icons dh-persona-none">smart_toy</span>
              <div class="dh-persona-name">
                <b>{{ p.name }}<i v-if="p.is_default" class="dh-reg-def">默认</i></b>
                <small>{{ p.type }}</small>
              </div>
            </div>
          </div>

          <!-- 右：大框聊天气泡窗口 -->
          <div class="card dh-chat-main">
            <div class="dh-chat-head">
              <img v-if="chatPersona && chatPersona.images.length" class="dh-chat-havatar" :src="imgSrc(chatPersona.images[0])" alt="" />
              <span v-else class="material-icons dh-persona-none" style="font-size:26px">smart_toy</span>
              <b style="font-size:14px">{{ chatPersona ? chatPersona.name + ' · ' + chatPersona.type : '选择左侧人物' }}</b>
              <span class="muted" style="font-size:12px">{{ items.length }} 条</span>
              <span style="flex:1"></span>
              <button class="btn sm danger ghost" @click="clearHistory">清空记录</button>
            </div>
            <p class="dh-img-tip">气泡对话；接入实时会话后，对方的语音会存成语音气泡（微信样式）。<b>文字试聊</b>走工作台已配置的 AI，人设由「设置 → 人设引导构建」组装。</p>

            <div class="dh-chat" ref="chatEl">
              <div v-if="!items.length" class="dh-chat-empty">还没有对话{{ chatPersona ? '，跟 ' + chatPersona.name + ' 说第一句吧' : '' }}</div>
              <div v-for="m in items" :key="m.id" class="dh-crow" :class="m.role">
                <template v-if="m.role === 'assistant'">
                  <img v-if="chatPersona && chatPersona.images.length" class="dh-cavatar" :src="imgSrc(chatPersona.images[0])" alt="" />
                  <div class="dh-cbubble" :class="{ voice: !!m.audio_file }" :title="m.audio_file ? '语音消息（播放待接入）' : ''">
                    <template v-if="m.audio_file"><span class="dh-cwave"><i v-for="n in 9" :key="n"></i></span><span>{{ Math.ceil((m.text || '').length / 3) }}"</span></template>
                    <template v-else>{{ m.text }}</template>
                  </div>
                  <small class="dh-ctime">{{ m.ts }}</small>
                </template>
                <template v-else>
                  <small class="dh-ctime">{{ m.ts }}</small>
                  <div class="dh-cbubble">{{ m.text }}</div>
                </template>
              </div>
              <div v-if="sending" class="dh-crow assistant"><div class="dh-cbubble dh-typing">正在输入…</div></div>
            </div>

            <div class="dh-chat-input">
              <input v-model="chatText" :disabled="!chatPersona || sending" placeholder="说点什么…（回车发送）" @keyup.enter="sendChat" />
              <button class="btn" :disabled="!chatPersona || sending || !chatText.trim()" @click="sendChat">发送</button>
            </div>
          </div>
        </div>
      </template>
    </template>

    <!-- 会话 JSON 预览弹窗 -->
    <div v-if="preview.open" class="dh-mask" @click.self="preview.open = false">
      <div class="dh-modal">
        <div class="dh-modal-head">
          <b>会话配置 JSON</b>
          <span style="flex:1"></span>
          <button class="btn sm ghost" @click="copyPreview">复制</button>
          <button class="sh-close" @click="preview.open = false">✕</button>
        </div>
        <div class="dh-modal-body">
          <p class="dh-img-tip">真实建会话时 POST 到 <code>{{ form ? form.api_base : '' }}/v1/realtime-avatar/sessions</code> 的载荷（服务端同一函数组装）。
          参考图 URL 在「公网访问地址」配置后由服务端自动替换为<b>公网直链 + 短时签名令牌</b>（本预览仍显示占位域名；Vivix 不支持 base64）。</p>
          <pre>{{ preview.json }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { api, rawUrl } from '../api';
import { dhState, dhRefresh } from '../dhState';
import { useDhLive } from '../dhLive';
import DhCardDeck from './DhCardDeck.vue';

const SUBS = [
  { key: 'main', label: '数字人界面' },
  { key: 'chat', label: '聊天记录' },
  { key: 'settings', label: '设置' },
];
// v1.12.1：进数字人 tab 一律从「数字人界面」开始。此前用 localStorage 记忆上次子页签——
// 上次停留在「设置」的话，之后每次进来都落在设置页；不再记忆，组件随页签切换重挂载天然归位。
const sub = ref('main');

// ---------- meta + 注册表 ----------
const meta = ref({ voices: [], types: ['男友', '女友', '宠物'], aspects: ['9:16', '16:9', '1:1'], resolutions: ['480p', '720p'], max_images: 8 });
const loaded = ref(false);
const personas = ref([]);
const selId = ref(0);
const form = ref(null);
const newKey = ref('');
const err = ref('');
const okMsg = ref('');
const saving = ref(false);
const testing = ref(false);
const uploading = ref(false);
const testResult = ref(null);
const preview = reactive({ open: false, json: '' });

const cur = computed(() => personas.value.find((p) => p.is_default) || personas.value[0] || null);
const frontImg = computed(() => (cur.value && cur.value.images.length ? cur.value.images[0] : null));
const aspectNum = computed(() => {
  const a = cur.value ? cur.value.persona.aspect : '9:16';
  const [w, h] = a.split(':').map(Number);
  return Number.isFinite(w) && Number.isFinite(h) && h ? w / h : 9 / 16;
});
// v1.12.2：直播时舞台盒用**流的真实比例**（TRTC 首帧后量出 vw/vh）；v1.12.3：静态预览同样
// 限尺寸——高封顶 78vh、按比例缩宽、居中，两条分支同一公式。旧版静态 width:100%，竖版 9:16
// 的预览图被撑到两千多像素高（生产反馈「主界面图片尺寸默认太大，要固定高宽」）
const stageStyle = computed(() => {
  const ar = live.on && live.vw && live.vh ? live.vw / live.vh : aspectNum.value;
  return { aspectRatio: String(ar), width: `min(100%, calc(78vh * ${ar.toFixed(4)}))`, margin: '0 auto' };
});
const voiceLabel = (id) => { const v = meta.value.voices.find((x) => x.id === id); return v ? v.label.split(' · ')[0] : id; };
const imgSrc = (im) => rawUrl(im.url);

function flashOk(m) { okMsg.value = m; setTimeout(() => (okMsg.value = ''), 3500); }
function flashErr(m) { err.value = m; setTimeout(() => (err.value = ''), 8000); }

async function loadMeta() {
  try {
    const m = await api.get('/dh/meta');
    meta.value = m;
    personas.value = m.personas || [];
    dhState.personas = personas.value; // 全局按钮标签同步
    loaded.value = true;
    if (!selId.value && personas.value.length) select(personas.value.find((p) => p.is_default)?.id || personas.value[0].id);
  } catch (e) { flashErr(e.message); }
}

function select(id) {
  const p = personas.value.find((x) => x.id === id);
  if (!p) { form.value = null; selId.value = 0; return; }
  selId.value = id;
  // 深拷贝编辑（persona 对象也拷，避免未保存的改动直接污染列表显示）
  form.value = JSON.parse(JSON.stringify(p));
  newKey.value = '';
  testResult.value = null;
  balInfo.value = null;
}

async function createPersona() {
  const r = await api.post('/dh/personas', { name: '新数字人', type: '女友', persona: meta.value.persona_defaults || {} });
  await loadMeta();
  select(r.id);
  flashOk('已创建，改完记得保存');
}

async function save() {
  if (!form.value || saving.value) return;
  saving.value = true;
  try {
    const body = {
      name: form.value.name, type: form.value.type,
      api_base: form.value.api_base, model: form.value.model, voice_id: form.value.voice_id,
      public_base: form.value.public_base,
      remark: form.value.remark, note: form.value.note, persona: form.value.persona,
    };
    if (newKey.value.trim()) body.api_key = newKey.value.trim();
    if (clearKeyFlag) { body.api_key = ''; clearKeyFlag = false; }
    await api.put('/dh/personas/' + form.value.id, body);
    newKey.value = '';
    await loadMeta();
    select(form.value.id);
    flashOk('已保存');
  } catch (e) { flashErr('保存失败：' + e.message); }
  finally { saving.value = false; }
}
let clearKeyFlag = false;
function clearKey() {
  if (!confirm('确定清除已保存的 API Key？')) return;
  clearKeyFlag = true;
  save();
}

async function setDefault(p) {
  try {
    await api.post(`/dh/personas/${p.id}/default`, {});
    await loadMeta();
    if (selId.value) select(selId.value);
    flashOk(`默认数字人已切为 ${p.name}`);
  } catch (e) { flashErr(e.message); }
}
const setDefaultById = (id) => setDefault(personas.value.find((x) => x.id === id));

async function removePersona(p) {
  if (!confirm(`确定删除「${p.name}」？参考图与历史对话一并删除，不可恢复。`)) return;
  try {
    await api.del('/dh/personas/' + p.id);
    selId.value = 0; form.value = null;
    await loadMeta();
    await dhRefresh(); // 悬浮按钮标签联动
    flashOk('已删除');
  } catch (e) { flashErr(e.message); }
}

async function testKey() {
  if (testing.value) return;
  // 先保存（含新 Key）再测——测的是服务端存的配置
  if (form.value && (newKey.value.trim() || clearKeyFlag)) await save();
  testing.value = true; testResult.value = null;
  try { testResult.value = await api.post(`/dh/personas/${form.value.id}/test`, {}); }
  catch (e) { testResult.value = { ok: false, error: e.message }; }
  finally { testing.value = false; }
}

// 余额查询（v1.12.3）：GET /v1/balance 经服务端带 Key 调用（端点存在但官方文档没写，
// 响应形状宽松解析；认不出时把原始返回亮出来，不改写不猜）
const balBusy = ref(false);
const balInfo = ref(null);
const balText = computed(() => {
  const b = balInfo.value;
  if (!b) return '';
  if (!b.ok) return '✗ ' + b.error;
  if (b.value == null) return '✓ 余额（原始）：' + String(b.raw || '').slice(0, 100);
  return `✓ 余额 ${b.value}${b.currency ? ' ' + b.currency : ''}`;
});
async function fetchBalance() {
  if (balBusy.value || !form.value) return;
  balBusy.value = true; balInfo.value = null;
  try { balInfo.value = await api.get(`/dh/personas/${form.value.id}/balance`); }
  catch (e) { balInfo.value = { ok: false, error: e.message }; }
  finally { balBusy.value = false; }
}

async function showPreview() {
  if (form.value && (newKey.value.trim() || clearKeyFlag)) await save();
  try {
    const r = await api.get(`/dh/personas/${form.value.id}/preview`);
    preview.json = JSON.stringify(r.session, null, 2);
    preview.open = true;
  } catch (e) { flashErr(e.message); }
}
async function copyPreview() {
  try { await navigator.clipboard.writeText(preview.json); flashOk('JSON 已复制'); } catch { flashErr('复制失败，请手动选择'); }
}

// ---------- 参考图 ----------
async function uploadImg(e) {
  const f = e.target.files && e.target.files[0];
  if (!f || !form.value || uploading.value) return;
  uploading.value = true;
  try {
    await api.upload(`/dh/personas/${form.value.id}/images`, {}, [{ name: 'file', file: f }]);
    await loadMeta();
    select(form.value.id);
    flashOk('参考图已上传');
  } catch (e2) { flashErr(e2.message); }
  finally { uploading.value = false; e.target.value = ''; }
}
async function saveImgMeta(im) {
  try { await api.put('/dh/images/' + im.id, { description: im.description, sort: im.sort }); flashOk('描述已保存'); }
  catch (e) { flashErr(e.message); }
}
async function moveImg(i, d) {
  const arr = form.value.images;
  const j = i + d;
  if (j < 0 || j >= arr.length) return;
  const a = arr[i]; arr[i] = arr[j]; arr[j] = a; // 交换显示
  // 排序值也交换并落库
  const si = arr[i].sort, sj = arr[j].sort;
  try {
    await api.put('/dh/images/' + arr[i].id, { description: arr[i].description, sort: sj });
    await api.put('/dh/images/' + arr[j].id, { description: arr[j].description, sort: si });
    await loadMeta();
    select(form.value.id);
  } catch (e) { flashErr(e.message); }
}
async function removeImg(im) {
  if (!confirm(`删除参考图 ${im.orig_name}？`)) return;
  try {
    await api.del('/dh/images/' + im.id);
    await loadMeta();
    select(form.value.id);
  } catch (e) { flashErr(e.message); }
}

// ---------- 历史对话 ----------
const chatId = ref(0);
const chatText = ref('');
const items = ref([]);
const sending = ref(false);
const chatEl = ref(null);
const chatPersona = computed(() => personas.value.find((p) => p.id === chatId.value) || null);

watch(chatId, loadHistory);
// 切到「聊天记录」页签时重拉历史（悬浮窗/上次会话可能已经写进库）；
// 悬浮窗那边发过消息（histVer 变化）也重拉——两处入口共用一张 dh_history 表，必须保持一致
watch(sub, (v) => { if (v === 'chat') loadHistory(); });
watch(() => dhState.histVer, () => { if (sub.value === 'chat') loadHistory(); });
async function loadHistory() {
  if (!chatId.value) return;
  try {
    const r = await api.get('/dh/history?persona_id=' + chatId.value + '&limit=300');
    items.value = r.items || [];
    scrollBottom();
  } catch { items.value = []; }
}
async function sendChat() {
  const t = chatText.value.trim();
  if (!t || !chatPersona.value || sending.value) return;
  sending.value = true;
  items.value.push({ id: 'u' + Date.now(), role: 'user', text: t });
  chatText.value = '';
  scrollBottom();
  try {
    const r = await api.post('/dh/chat', { persona_id: chatId.value, text: t });
    if (r.user) items.value.push(r.user);
    if (r.assistant) items.value.push(r.assistant);
    dhState.histVer++; // 通知悬浮窗等其他入口重拉历史
  } catch (e) {
    items.value.push({ id: 'e' + Date.now(), role: 'assistant', text: '（' + e.message + '）' });
  } finally {
    sending.value = false;
    scrollBottom();
  }
}
async function clearHistory() {
  if (!chatPersona.value || !confirm(`清空与 ${chatPersona.value.name} 的全部对话记录？`)) return;
  try {
    await api.del('/dh/history?persona_id=' + chatId.value);
    items.value = [];
    flashOk('已清空');
  } catch (e) { flashErr(e.message); }
}
function scrollBottom() {
  nextTick(() => { if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight; });
}

// ---------- 实时对话（v1.12.1）：逻辑收在 dhLive composable（与 DhPhone 悬浮窗共用同一链路） ----------
const { live, liveItems, liveText, startLive, stopLive, sendLive, resumePlay, toggleMic } = useDhLive({
  viewId: 'dh-live-view',            // TRTC 渲染容器（模板里 #dh-live-view）
  getPersona: () => cur.value,
});
// 切走页签/关掉组件：显式关服务端会话（烧额度的会话不挂机；断连 90 秒 auto_close 兜底）
onBeforeUnmount(() => { stopLive(); });

function openPhone() {
  dhState.phoneOpen = true;
  if (!dhState.loaded) dhRefresh();
}

onMounted(async () => {
  await loadMeta();
  if (!chatId.value && cur.value) chatId.value = cur.value.id;
});
</script>

<style scoped>
.dh-subtabs { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.dh-subtabs button { border: 1px solid var(--border, rgba(128,128,128,.3)); background: var(--bg2, transparent); color: var(--text);
  padding: 7px 16px; border-radius: 9px; cursor: pointer; font-size: 13.5px; }
.dh-subtabs button.active { background: rgba(236,100,150,.16); border-color: rgba(236,100,150,.55); font-weight: 600; }

/* ① 数字人界面 */
.dh-main-card { padding: 14px; }
.dh-stage { position: relative; width: 100%; border-radius: 14px; overflow: hidden; background: #000; }
.dh-stage-img { width: 100%; height: 100%; object-fit: contain; display: block; }
.dh-stage-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: #bbb; font-size: 13px; padding: 20px; text-align: center; }
.dh-stage-live { position: absolute; left: 10px; top: 10px; font-size: 11px; color: #fff; background: rgba(0,0,0,.5);
  border-radius: 8px; padding: 3px 9px; }
.dh-stage-live i { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #ec6496; margin-right: 5px; animation: dhPulse 1.6s infinite; }
.dh-stage-live.ready { background: rgba(30,158,104,.78); }   /* Key 已配：可开始 */
.dh-stage-live.onair { background: rgba(30,158,104,.9); }    /* 实时中 */
.dh-stage-live.onair i { background: #fff; }
@keyframes dhPulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }

/* 实时画面（v1.12.2）：TRTC 渲染容器铺满画面区；视频 contain 等比完整呈现（舞台盒已随流的真实
   比例切换，cover 在比例未知的头几秒会把竖流裁掉大半）。!important 必须：真 TRTC 给 video
   打内联 object-fit:cover，不带 important 压不住（2026-10-07 生产实测抓到，桩测不出） */
.dh-stage-video { position: absolute; inset: 0; background: #000; }
.dh-stage-video :deep(video) { width: 100%; height: 100%; object-fit: contain !important; display: block; }
.dh-stage-resume { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  border: none; background: rgba(236,100,150,.92); color: #fff; border-radius: 999px; padding: 9px 20px;
  font-size: 13.5px; cursor: pointer; box-shadow: 0 4px 18px rgba(0,0,0,.45); }
.dh-stage-resume:hover { background: rgba(236,100,150,1); }
.dh-live-err { margin: 10px 0 0; padding: 8px 12px; border-radius: 9px; background: rgba(224,108,117,.13);
  color: #e06c75; font-size: 12.5px; line-height: 1.65; }

/* 实时对话文字通道 */
.dh-live-chat { padding: 12px 14px; }
.dh-live-log { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 4px 2px; }
.dh-live-empty { color: var(--muted); font-size: 12.5px; text-align: center; padding: 12px; line-height: 1.8; }
.dh-lrow { display: flex; }
.dh-lrow.user { justify-content: flex-end; }
.dh-lbubble { max-width: 76%; padding: 7px 12px; border-radius: 12px; font-size: 13.5px; line-height: 1.55;
  word-break: break-word; white-space: pre-wrap; background: rgba(128,128,128,.16); border-top-left-radius: 4px; }
.dh-lrow.user .dh-lbubble { background: rgba(79,124,247,.85); color: #fff; border-top-left-radius: 12px; border-top-right-radius: 4px; }
.dh-live-input { display: flex; gap: 9px; padding-top: 10px; margin-top: 8px; border-top: 1px solid var(--border, rgba(128,128,128,.2)); }
.dh-live-input input { flex: 1; min-width: 0; padding: 8px 12px; border-radius: 9px; font-size: 13.5px;
  border: 1px solid var(--border, rgba(128,128,128,.35)); background: transparent; color: var(--text); outline: none; }
.dh-live-input input:focus { border-color: rgba(236,100,150,.6); }
.dh-stage-caption { position: absolute; left: 12px; bottom: 10px; right: 12px; color: #fff; font-size: 13.5px;
  background: rgba(0,0,0,.45); border-radius: 10px; padding: 6px 12px; backdrop-filter: blur(4px); }
.dh-main-info { padding: 12px 4px 2px; }
.dh-chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.dh-chip { font-size: 11.5px; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--border, rgba(128,128,128,.3));
  color: var(--muted); }
.dh-main-line { color: var(--muted); font-size: 13px; margin: 0 0 12px; }

.dh-persona-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 10px; }
.dh-persona-card { position: relative; border-radius: 12px; overflow: hidden; cursor: pointer;
  border: 2px solid var(--border, rgba(128,128,128,.25)); aspect-ratio: 3/4; background: var(--card-bg, rgba(128,128,128,.08));
  display: flex; align-items: center; justify-content: center; transition: border-color .15s, transform .1s; }
.dh-persona-card:hover { transform: translateY(-2px); }
.dh-persona-card.on { border-color: rgba(236,100,150,.75); }
.dh-persona-card img { width: 100%; height: 100%; object-fit: cover; }
.dh-persona-none { font-size: 34px; color: var(--muted); }
.dh-persona-name { position: absolute; left: 0; right: 0; bottom: 0; padding: 22px 9px 7px;
  background: linear-gradient(transparent, rgba(0,0,0,.72)); color: #fff; line-height: 1.35; }
.dh-persona-name b { display: block; font-size: 13.5px; }
.dh-persona-name small { font-size: 11px; opacity: .85; }
.dh-persona-check { position: absolute; right: 7px; top: 7px; color: #ec6496; font-size: 20px; background: #fff;
  border-radius: 50%; padding: 1px; }

/* ② 设置 */
.dh-settings { display: flex; gap: 12px; align-items: flex-start; }
.dh-reg { width: 230px; flex-shrink: 0; padding: 12px; }
.dh-reg-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.dh-reg-item { display: flex; align-items: center; gap: 9px; padding: 7px 8px; border-radius: 10px; cursor: pointer; }
.dh-reg-item:hover { background: rgba(128,128,128,.1); }
.dh-reg-item.on { background: rgba(236,100,150,.14); }
.dh-reg-item img { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; flex-shrink: 0; background: rgba(128,128,128,.2); }
.dh-reg-item .dh-persona-name { position: static; padding: 0; background: none; color: var(--text); flex: 1; min-width: 0; }
.dh-reg-item .dh-persona-name b { display: flex; align-items: center; gap: 6px; }
.dh-reg-def { font-style: normal; font-size: 10px; background: rgba(236,100,150,.85); color: #fff; border-radius: 6px; padding: 1px 6px; flex-shrink: 0; }
.dh-editor { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.dh-sec { margin: 18px 0 10px; font-size: 14.5px; }
.dh-sec:first-child { margin-top: 0; }
.dh-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.dh-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; min-width: 0; }
.dh-field label { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dh-field .dh-hint { font-weight: 400; opacity: .8; }
.dh-field input, .dh-field select, .dh-field textarea { padding: 7px 10px; border-radius: 8px; font-size: 13px;
  border: 1px solid var(--border, rgba(128,128,128,.35)); background: transparent; color: var(--text); outline: none;
  font-family: inherit; width: 100%; box-sizing: border-box; }
.dh-field input:focus, .dh-field select:focus, .dh-field textarea:focus { border-color: rgba(236,100,150,.6); }
.dh-field textarea { resize: vertical; }
.dh-inline label { cursor: pointer; font-size: 13px; color: var(--text); }
.dh-num { width: 52px !important; padding: 3px 6px !important; text-align: center; }
.dh-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dh-test { font-size: 12.5px; }
.dh-test.ok { color: var(--ok, #1e9e68); }
.dh-test.bad { color: #e06c75; }
.btn.dis { opacity: .55; pointer-events: none; }

.dh-img-tip { color: var(--muted); font-size: 12px; line-height: 1.8; margin: 0 0 10px; }
.dh-img-tip code { background: rgba(128,128,128,.14); border-radius: 5px; padding: 1px 5px; font-size: 11.5px; }
.dh-img-list { display: flex; flex-direction: column; gap: 8px; }
.dh-img-row { display: flex; gap: 10px; align-items: center; padding: 8px; border-radius: 10px;
  background: rgba(128,128,128,.07); }
.dh-img-row img { width: 74px; height: 56px; object-fit: cover; border-radius: 8px; flex-shrink: 0; background: rgba(0,0,0,.2); }
.dh-img-meta { flex: 1; min-width: 0; }
.dh-img-meta b { font-size: 12.5px; display: block; margin-bottom: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dh-img-meta small { color: var(--muted); font-weight: 400; margin-left: 7px; }
.dh-img-meta input { width: 100%; box-sizing: border-box; padding: 5px 8px; border-radius: 7px; font-size: 12px;
  border: 1px solid var(--border, rgba(128,128,128,.3)); background: transparent; color: var(--text); outline: none; }
.dh-img-ops { display: flex; gap: 5px; flex-shrink: 0; }
.dh-img-empty { color: var(--muted); font-size: 13px; text-align: center; padding: 18px; }

/* ② 聊天记录：左选人 + 右大聊天窗 */
.dh-chat-layout { display: flex; gap: 12px; align-items: stretch; }
.dh-chat-side { width: 230px; flex-shrink: 0; padding: 12px; }
.dh-chat-main { flex: 1; min-width: 0; padding: 14px; display: flex; flex-direction: column; }
.dh-chat-havatar { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
.dh-chat-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.dh-chat { flex: 1; min-height: 440px; max-height: 640px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 10px 4px;
  border-top: 1px solid var(--border, rgba(128,128,128,.2)); border-bottom: 1px solid var(--border, rgba(128,128,128,.2)); }
.dh-chat-empty { margin: auto; color: var(--muted); font-size: 13px; }
.dh-crow { display: flex; align-items: flex-end; gap: 7px; }
.dh-crow.user { justify-content: flex-end; }
.dh-crow.assistant { justify-content: flex-start; }
.dh-cavatar { width: 30px; height: 30px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
.dh-cbubble { max-width: 72%; padding: 8px 13px; border-radius: 13px; font-size: 13.5px; line-height: 1.55;
  word-break: break-word; white-space: pre-wrap; background: rgba(128,128,128,.16); border-top-left-radius: 4px; }
.dh-crow.user .dh-cbubble { background: rgba(79,124,247,.85); color: #fff; border-top-left-radius: 13px; border-top-right-radius: 4px; }
.dh-cbubble.voice { display: inline-flex; align-items: center; gap: 8px; min-width: 96px; cursor: pointer; }
.dh-cwave { display: inline-flex; align-items: center; gap: 2.5px; height: 16px; }
.dh-cwave i { width: 2.5px; border-radius: 2px; background: currentColor; opacity: .8; }
.dh-cwave i:nth-child(1) { height: 6px; } .dh-cwave i:nth-child(2) { height: 10px; } .dh-cwave i:nth-child(3) { height: 15px; }
.dh-cwave i:nth-child(4) { height: 9px; } .dh-cwave i:nth-child(5) { height: 14px; } .dh-cwave i:nth-child(6) { height: 7px; }
.dh-cwave i:nth-child(7) { height: 12px; } .dh-cwave i:nth-child(8) { height: 5px; } .dh-cwave i:nth-child(9) { height: 11px; }
.dh-ctime { font-size: 10.5px; color: var(--muted); flex-shrink: 0; margin-bottom: 2px; }
.dh-typing { color: var(--muted); }
.dh-chat-input { display: flex; gap: 9px; padding-top: 10px; }
.dh-chat-input input { flex: 1; padding: 9px 12px; border-radius: 9px; border: 1px solid var(--border, rgba(128,128,128,.35));
  background: transparent; color: var(--text); font-size: 13.5px; outline: none; }
.dh-chat-input input:focus { border-color: rgba(236,100,150,.6); }

/* JSON 预览弹窗 */
.dh-mask { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 1100; display: flex; align-items: center; justify-content: center; padding: 20px; }
.dh-modal { background: var(--bg2, #fff); color: var(--text); border-radius: 14px; width: min(680px, 100%);
  max-height: 84vh; display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,.3); }
.dh-modal-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border, rgba(128,128,128,.25)); }
.dh-modal-body { overflow: auto; padding: 12px 14px 16px; }
.dh-modal-body pre { background: rgba(128,128,128,.1); border-radius: 9px; padding: 12px; font-size: 12px;
  line-height: 1.6; overflow: auto; font-family: ui-monospace, Consolas, monospace; margin: 8px 0 0; }
.sh-close { border: none; background: transparent; font-size: 16px; cursor: pointer; color: var(--muted); padding: 4px 8px; }

/* 窄屏：注册表与编辑器、聊天左右栏上下排 */
@media (max-width: 860px) {
  .dh-settings { flex-direction: column; }
  .dh-reg { width: 100%; }
  .dh-chat-layout { flex-direction: column; }
  .dh-chat-side { width: 100%; }
  .dh-grid2 { grid-template-columns: 1fr; }
}
</style>
