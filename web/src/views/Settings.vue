<template>
  <div>
    <h2 class="page-title">设置</h2>
    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>

    <!-- 选项卡：常规设置 / SSL 自签名（仅管理员） / 升级管理（仅管理员） -->
    <div class="tabs" style="margin-bottom:14px">
      <button :class="{ active: tab === 'general' }" @click="tab = 'general'">常规设置</button>
      <button v-if="isAdmin" :class="{ active: tab === 'ssl' }" @click="tab = 'ssl'">SSL 自签名</button>
      <button v-if="isAdmin" :class="{ active: tab === 'upgrade' }" @click="tab = 'upgrade'">升级管理</button>
      <button v-if="isAdmin" :class="{ active: tab === 'fnos' }" @click="tab = 'fnos'">飞牛应用</button>
      <button v-if="isAdmin" :class="{ active: tab === 'logs' }" @click="tab = 'logs'">登录日志</button>
      <button v-if="isAdmin" :class="{ active: tab === 'clienterr' }" @click="tab = 'clienterr'; loadClientErrors()">前端错误</button>
      <!-- 用户管理（原独立页并入，2026-09 v1.7.0）：仅管理员 -->
      <button v-if="isAdmin" :class="{ active: tab === 'users' }" @click="tab = 'users'">用户管理</button>
      <button :class="{ active: tab === 'multi' }" @click="tab = 'multi'">多平台</button>
    </div>

    <div v-show="tab === 'general'" class="masonry">
      <div v-if="isAdmin" class="card">
        <h3>页面列表排序</h3>
        <div class="muted" style="font-size:12.5px; margin-bottom:10px">调整左侧菜单的页面顺序，或点「改名」自定义菜单中文名（管理员统一设置，全员生效）。保存后立即生效。</div>
        <div v-for="(p, i) in orderList" :key="p.page" class="row" style="align-items:center; gap:6px; margin-bottom:4px">
          <span class="muted" style="width:22px; font-size:12px; text-align:right">{{ i + 1 }}</span>
          <template v-if="editing === p.page">
            <input v-model="editText" style="flex:1; min-width:0; font-size:13.5px" placeholder="输入菜单名" @keyup.enter="confirmRename(p)" />
            <button class="small" style="padding:2px 8px" @click="confirmRename(p)">保存</button>
            <button class="small" style="padding:2px 8px" @click="editing = null">取消</button>
          </template>
          <template v-else>
            <span class="material-icons" style="font-size:15px; width:20px; color:var(--text3); flex-shrink:0" aria-hidden="true">{{ p.icon }}</span>
            <span style="font-size:13.5px">{{ displayLabel(p) }}</span>
            <span class="grow"></span>
            <button class="small" style="padding:2px 8px" @click="startRename(p)">改名</button>
            <button class="small" style="padding:2px 8px" :disabled="i === 0" @click="moveOrder(i, -1)">↑</button>
            <button class="small" style="padding:2px 8px" :disabled="i === orderList.length - 1" @click="moveOrder(i, 1)">↓</button>
          </template>
        </div>
        <div class="row" style="flex-wrap:wrap; gap:8px; margin-top:10px">
          <button class="primary" @click="saveOrder">保存排序</button>
          <button class="small" @click="resetOrder">恢复默认</button>
        </div>
      </div>

      <div v-if="isAdmin" class="card">
        <h3>模块共享设置（多成员）</h3>
        <div class="muted" style="font-size:12.5px; margin-bottom:10px">控制哪些模块全员共用一份数据/配置（像 SaaS 的公共模块）。关闭后各成员独立配置自己的；<b>历史共享数据不迁移</b>，独立库初始为空需自配或等下次抓取。</div>
        <div v-for="m in shareModules" :key="m.key" class="row" style="align-items:center; gap:8px; margin-bottom:6px">
          <label style="cursor:pointer; display:flex; align-items:center; gap:6px; font-size:13.5px">
            <input v-model="share[m.key]" type="checkbox" style="width:auto" @change="saveShare(m.key)" />
            <b>{{ m.label }}</b>
          </label>
          <span class="muted" style="font-size:12px">{{ m.desc }}</span>
          <span v-if="!share[m.key]" class="muted" style="font-size:12px; color:var(--orange, #e6a23c)">（各成员独立）</span>
        </div>
      </div>

      <div v-if="isAdmin" class="card">
        <h3>首页看板模块（全局）</h3>
        <div class="muted" style="font-size:12.5px; margin-bottom:10px">控制首页看板提供哪些模块，对<b>所有成员</b>生效。取消勾选 = 全员移除该模块（各成员的拖拽顺序与个人显隐设置保留，重新启用后自动恢复）。成员还可在看板最下方的「看板模块设置」里做个人显隐。</div>
        <div class="row" style="flex-wrap:wrap; gap:6px 16px; margin-bottom:10px">
          <label v-for="c in dashCards" :key="c.key" style="cursor:pointer; display:flex; align-items:center; gap:6px; font-size:13.5px">
            <input type="checkbox" style="width:auto" :checked="dashCardOn(c.key)" @change="toggleDashCard(c.key)" />
            <b>{{ c.label }}</b>
          </label>
        </div>
        <button class="primary" @click="saveDashModules">保存看板模块配置</button>
      </div>

      <!-- 邮箱设置已移到「邮箱」页最后一个 tab「邮箱设置」（2026-09 v1.7.0 多邮箱改造）：
           收发件服务器、签名、附件目录、新邮件提醒、关键词标签都在那里按账号配置 -->

      <div class="card">
        <h3>文件存档</h3>
        <div class="muted" style="font-size:12px; margin-bottom:8px">上传的存档文件保存到此目录（建议 NAS 映射盘符，如 Z:\workbench-files）。留空则文件内容存数据库（默认）。修改后新文件存新目录，已存文件位置不变、仍可正常下载。Docker/NAS 部署：填容器内路径（先把 NAS 目录映射进容器）。</div>
        <div class="row">
          <input v-model="filesDir.dir" placeholder="Z:\workbench-files" class="grow" />
          <button class="primary" @click="saveFilesDir">保存路径</button>
        </div>
      </div>

      <div class="card" v-if="isAdmin">
        <h3>全局默认上传保存路径</h3>
        <div class="muted" style="font-size:12px; margin-bottom:8px">所有未单独指定目录的上传默认保存到这里，按子目录自动分类：family-images（家庭图床图片）、ai-attachments（AI 聊天附件）、imports（账单导入文件）、files / email-attachments（文件存档、邮件附件专属目录留空时的回落）。建议 NAS 映射盘符，如 Z:\workbench-uploads。留空 = 维持旧行为（图片存数据库、附件不留档）。Docker/NAS 部署：填容器内路径（先把 NAS 目录映射进容器，如 /vol2/1000/uploads 映射为 /uploads 后填 /uploads）。</div>
        <div class="row">
          <input v-model="uploadRoot.dir" placeholder="Z:\workbench-uploads" class="grow" />
          <button class="primary" @click="saveUploadRoot">保存路径</button>
        </div>
      </div>

      <div class="card" v-if="isAdmin">
        <h3>本地直连（视频/文档加速）</h3>
        <div class="muted" style="font-size:12.5px; margin-bottom:10px">填 NAS 在局域网的访问地址（如 http://192.168.1.50:21716）。保存后每台设备无论用域名还是 IP 登录，都会在后台自动探测该地址（页面标题旁的内外网标识即探测结果）：可达则视频/音频/PDF 自动从局域网直连读取（比公网隧道快得多），不可达自动回落当前地址，成员在外网使用不受影响。协议需与实际访问一致（http/https）。留空 = 不启用。</div>
        <div class="row">
          <input v-model="localBase.base" placeholder="http://192.168.1.50:21716" class="grow" />
          <button class="primary" @click="saveLocalBase">保存</button>
        </div>
        <div v-if="lanAddrs.length" class="muted" style="font-size:12px; margin-top:8px">
          服务网卡检测到的地址（Docker 部署时可能是容器内网地址，仅供参考， NAS 的局域网 IP 以 fnOS/路由器后台为准）：
          <button v-for="a in lanAddrs" :key="a" class="small" style="margin:0 4px 4px 0; padding:2px 10px" @click="localBase.base = a">{{ a }}</button>
        </div>
      </div>

      <!-- 智能家居视频路径（v1.9.26）：智能家居页「视频中心」tab 的根目录（与学习页视频教学的目录各自独立） -->
      <div class="card" v-if="isAdmin">
        <h3>智能家居视频路径</h3>
        <div class="muted" style="font-size:12px; margin-bottom:8px">「智能家居 → 视频中心」tab 浏览播放此目录里的视频/音频（mp4 · flv · mp3 等，支持 PotPlayer/VLC 外部播放器联动）。与「学习 → 视频教学」的学习目录互不影响。Docker/NAS 部署：填容器内路径（先把 NAS 目录映射进容器，如宿主机 /vol2/1000/家庭视频 映射为 /videos 后填 /videos）；Windows 直跑填本机目录（如 D:\家庭视频）。</div>
        <div class="row">
          <input v-model="vcRoot.dir" placeholder="D:\家庭视频（Docker 填容器内路径，如 /videos）" class="grow" />
          <button class="primary" @click="saveVcRoot">保存路径</button>
        </div>
        <div v-if="vcRoot.ok === false" class="muted" style="font-size:12px; margin-top:8px; color:var(--red)">当前路径在服务器上不可访问，请核对后再保存</div>
      </div>

      <div class="card">
        <h3>天气</h3>
        <div class="form-row"><label>城市</label><input v-model="cityInput" placeholder="如：宁波 / 上海" /></div>
        <button class="primary" @click="geocode" style="margin-bottom:10px">保存并定位城市</button>
        <div class="muted" style="margin:-4px 0 8px; font-size:12px">内置全国地级市坐标库，国内城市离线即可定位（无需服务器访问外网）；区县/境外城市走在线定位</div>
        <div class="muted" v-if="s.weather.lat">当前：{{ s.weather.city }}（{{ s.weather.lat }}, {{ s.weather.lon }}）</div>
        <div class="muted" style="margin-top:6px">也可直接填写经纬度后保存：</div>
        <div class="row" style="margin-top:6px">
          <input v-model.number="s.weather.lat" placeholder="纬度" style="width:120px" />
          <input v-model.number="s.weather.lon" placeholder="经度" style="width:120px" />
          <button class="small" @click="saveWeather">保存</button>
        </div>
      </div>

      <div class="card">
        <h3>AI 配置（OpenAI 兼容）</h3>
        <div v-if="locked('ai_config')" class="muted" style="font-size:12px; margin-bottom:8px; color:var(--orange, #e6a23c)">🔒 由管理员统一配置，全员共用同一份 AI 配置</div>
        <div class="form-row"><label>模型名称</label><input v-model="ai.model" :disabled="locked('ai_config')" placeholder="如：deepseek-chat / qwen-plus / gpt-4o" /></div>
        <div class="form-row"><label>API 地址</label><input v-model="ai.base_url" :disabled="locked('ai_config')" placeholder="如：https://api.deepseek.com/v1（只填域名/版本号，接口路径自动拼接）" /></div>
        <div class="form-row"><label>API Key</label><input v-model="ai.api_key" type="password" :disabled="locked('ai_config')" placeholder="sk-..." /></div>
        <div class="muted" style="margin-bottom:10px">配置后：新闻自动生成中文摘要、笔记 AI 总结、学习复盘、Skill 业务任务、AI 助手均可使用。</div>
        <div class="row" style="flex-wrap:wrap">
          <button class="primary" :disabled="locked('ai_config')" @click="saveAi">保存 AI 配置</button>
          <button class="small" :disabled="locked('ai_config')" @click="testAi">测试连接</button>
          <button class="small" @click="queryBalance" :disabled="balanceLoading || locked('ai_config')">{{ balanceLoading ? '查询中...' : '查询余额' }}</button>
        </div>

        <div v-if="balance" class="card" style="margin-top:12px; background:var(--bg3); border:none">
          <b>账户余额</b>
          <div style="font-size:22px; font-weight:600; color:var(--green); margin:4px 0">{{ balance.total ?? '未知' }} <span style="font-size:13px">{{ balance.currency || '' }}</span></div>
          <div class="muted" v-if="balance.granted !== undefined">其中赠送额度：{{ balance.granted }}</div>
          <div class="muted" v-if="balance.error">{{ balance.error }}</div>
        </div>
        <div class="form-row" style="margin-top:10px">
          <label>自定义余额接口（可选，覆盖默认探测）</label>
          <input v-model="balanceUrl" :disabled="locked('ai_config')" placeholder="如：https://api.deepseek.com/user/balance" />
          <button class="small" style="margin-top:4px" :disabled="locked('ai_config')" @click="saveBalanceUrl">保存余额接口</button>
        </div>
        <div style="margin-top:14px; padding-top:10px; border-top:1px solid var(--border)">
          <b style="font-size:13px">视觉模型（图片/扫描件识别，可选）</b>
          <div class="muted" style="font-size:12px; margin:4px 0 8px">用于文件存档「AI 识别」图片型 PDF 和 AI 助手识图。DeepSeek 官方 API 不支持图片，需填支持视觉的模型（如 qwen-vl-max / glm-4v-plus / gpt-4o）。留空则尝试用主模型。</div>
          <div class="form-row"><label>视觉模型名称</label><input v-model="ai.vision_model" :disabled="locked('ai_config')" placeholder="如：qwen-vl-max" /></div>
          <div class="form-row"><label>视觉模型 API 地址（留空用主模型地址）</label><input v-model="ai.vision_base_url" :disabled="locked('ai_config')" placeholder="如：https://dashscope.aliyuncs.com/compatible-mode/v1" /></div>
          <div class="form-row"><label>视觉模型 API Key（留空用主模型 Key）</label><input v-model="ai.vision_api_key" type="password" :disabled="locked('ai_config')" placeholder="sk-..." /></div>
        </div>
      </div>

      <div class="card">
        <h3>新闻搜索（Tavily AI）</h3>
        <div v-if="locked('news')" class="muted" style="font-size:12px; margin-bottom:8px; color:var(--orange, #e6a23c)">🔒 由管理员统一配置，全员共用新闻抓取</div>
        <div class="muted" style="margin-bottom:10px">配置后，<b>新闻主来源改为 AI 主动搜索</b>（真实链接、AI 只搜索不编造），RSS 自动降为补充来源。免费 key：在 <a href="https://app.tavily.com" target="_blank" rel="noopener">app.tavily.com</a> 注册（dev key 1000 次/月）。</div>
        <div class="form-row"><label>API 地址</label><input v-model="searchCfg.base_url" :disabled="locked('news')" placeholder="https://api.tavily.com" /></div>
        <div class="form-row"><label>路径</label><input v-model="searchCfg.path" :disabled="locked('news')" placeholder="/search" /></div>
        <div class="form-row"><label>API Key</label><input v-model="searchCfg.api_key" type="password" :disabled="locked('news')" placeholder="tvly-..." /></div>
        <button class="primary" :disabled="locked('news')" @click="saveSearchCfg">保存搜索配置</button>
      </div>

      <div class="card">
        <h3>新闻源（RSS · 补充）</h3>
        <div v-if="locked('news')" class="muted" style="font-size:12px; margin-bottom:8px; color:var(--orange, #e6a23c)">🔒 由管理员统一配置，全员共用新闻抓取</div>
        <p class="muted" style="margin-bottom:10px">RSS 为<b>补充</b>来源（AI 搜索为主）；「本地」按天气城市过滤。</p>
        <div v-for="cat in ['tech','life','local']" :key="cat" style="margin-bottom:12px">
          <div class="row" style="justify-content:space-between; margin-bottom:4px">
            <b style="font-size:13px">{{ catLabel(cat) }}</b>
            <button class="small" :disabled="locked('news')" @click="addSource(cat)">＋ 添加源</button>
          </div>
          <div v-for="(src,i) in s.news_sources[cat]" :key="i" class="row" style="margin-bottom:4px">
            <input v-model="src.name" :disabled="locked('news')" placeholder="名称" style="width:110px" />
            <input v-model="src.url" :disabled="locked('news')" placeholder="RSS 地址" class="grow" />
            <button class="icon-btn" :disabled="locked('news')" @click="s.news_sources[cat].splice(i,1)">✕</button>
          </div>
        </div>
        <button class="primary" :disabled="locked('news')" @click="saveSources">保存新闻源</button>
      </div>

      <div class="card">
        <h3>飞书推送</h3>
        <div class="muted" style="margin-bottom:10px; font-size:12.5px">配置后，业务系统 Skill 每次执行的结果会推送到下面所有会话。点「列出群」可把机器人所在群直接加入。</div>
        <div class="form-row"><label>App ID</label><input v-model="feishu.app_id" placeholder="cli_..." /></div>
        <div class="form-row"><label>App Secret</label><input v-model="feishu.app_secret" type="password" placeholder="App Secret" /></div>
        <div style="margin-top:10px"><b style="font-size:13px">推送会话（可多个）</b></div>
        <div v-for="(t, i) in feishu.targets" :key="i" class="row" style="flex-wrap:wrap; gap:6px; align-items:center; margin-top:6px">
          <input v-model="t.name" placeholder="备注（如 IT部群）" style="width:130px" />
          <select v-model="t.receive_id_type" style="width:110px">
            <option value="chat_id">群</option>
            <option value="open_id">人(open_id)</option>
            <option value="email">人(邮箱)</option>
            <option value="user_id">人(user_id)</option>
          </select>
          <input v-model="t.receive_id" class="grow" placeholder="会话ID（oc_... / open_id / 邮箱）" />
          <button class="icon-btn" title="删除" @click="feishu.targets.splice(i, 1)">✕</button>
        </div>
        <div v-if="feishuChats.length" class="row" style="flex-wrap:wrap; gap:6px; margin-top:8px">
          <span class="muted" style="font-size:12px; align-self:center">点选群加入 →</span>
          <button v-for="c in feishuChats" :key="c.chat_id" class="small" @click="addChat(c)">＋ {{ c.name }}</button>
        </div>
        <div class="row" style="flex-wrap:wrap; gap:8px; margin-top:10px">
          <button class="primary" @click="saveFeishu">保存</button>
          <button class="small" @click="feishu.targets.push({ receive_id_type: 'chat_id', receive_id: '', name: '' })">＋ 添加会话</button>
          <button class="small" @click="loadFeishuChats">列出群</button>
          <button class="small" @click="testFeishu">测试发送</button>
        </div>
      </div>

      <div class="card">
        <h3>钉钉推送</h3>
        <div class="muted" style="margin-bottom:10px; font-size:12.5px">
          绑定后，发给你的工作台消息（站内互发 / 家庭事项 / 子女学习通知，含写给自己的备忘）会同步推送到钉钉。
          前置：在钉钉开放平台创建企业内部应用；「机器人单聊」通道需给应用添加机器人能力（免费），「服务助手」通道需企业开通员工服务台旗舰版。文字消息走所选通道；<b>图片走「工作通知」通道</b>，需再填一次应用的 AgentId（机器人通道官方不支持图片消息）。
        </div>
        <div class="form-row">
          <label>绑定状态</label>
          <span v-if="dingtalk.userid" style="flex:1">
            ✅ 已绑定 <b>{{ dingtalk.bound_nick || '钉钉用户' }}</b>（userid：{{ dingtalk.userid }}）<span v-if="dingtalk.bound_at" class="muted">· {{ dingtalk.bound_at }}</span>
          </span>
          <span v-else class="muted" style="flex:1">未绑定</span>
          <router-link to="/dingtalk" style="white-space:nowrap">📲 扫码绑定</router-link>
        </div>
        <template v-if="isAdmin">
          <div class="muted" style="margin-bottom:8px; font-size:12px; padding:8px 10px; border-radius:6px; background:var(--bg3)">
            <b>应用凭证（全局共享）</b>：管理员配置一次，全体成员共用同一套 AppKey/AppSecret/AgentId，图片推送等能力对所有人一致生效。
          </div>
          <div class="form-row"><label>AppKey</label><input v-model="dingtalk.app_key" placeholder="ding..." /></div>
          <div class="form-row"><label>AppSecret</label><input v-model="dingtalk.app_secret" type="password" placeholder="AppSecret" /></div>
          <div class="form-row">
            <label>推送通道</label>
            <select v-model="dingtalk.mode" style="width:auto">
              <option value="robot">企业机器人单聊（免费）</option>
              <option value="smartbot">服务助手（需员工服务台旗舰版）</option>
            </select>
          </div>
          <div v-if="dingtalk.mode === 'robot'" class="form-row"><label>robotCode</label><input v-model="dingtalk.robot_code" placeholder="默认同 AppKey（企业内部应用）" /></div>
          <div class="form-row"><label>AgentId</label><input v-model="dingtalk.agent_id" placeholder="纯数字；发图片用（开发者后台 → 应用详情 → 凭证与基础信息）" /></div>
        </template>
        <div v-else class="muted" style="margin-bottom:10px; font-size:12.5px">
          🔒 应用凭证由管理员统一配置。{{ dingtalk.app_configured ? '✅ 已配置，你只需完成下方个人绑定即可接收推送。' : '⚠️ 管理员尚未配置应用凭证，请先联系管理员在「设置 → 钉钉推送」填入 AppKey/AppSecret/AgentId。' }}
        </div>
        <div class="muted" style="margin-bottom:8px; font-size:12px"><b>个人绑定</b>（各人绑定自己的钉钉账号）</div>
        <div class="form-row"><label>钉钉 userid</label><input v-model="dingtalk.userid" placeholder="扫码绑定自动填入；也可手动填成员UserID" /></div>
        <div class="form-row">
          <label>手机号解析</label>
          <input v-model="dingMobile" placeholder="填绑定手机号点右侧解析（应用需通讯录只读权限）" />
          <button class="small" @click="resolveDingUserid">解析</button>
        </div>
        <div class="form-row"><label>回调基础地址</label><input v-model="dingtalk.bind_base" placeholder="扫码绑定回调地址，留空自动探测本机局域网 IP" /></div>
        <label style="display:flex; align-items:center; gap:6px; margin-top:10px; cursor:pointer">
          <input v-model="dingtalk.enabled" type="checkbox" style="width:auto" /> 启用：新消息同步推送到钉钉
        </label>
        <div class="row" style="flex-wrap:wrap; gap:8px; margin-top:10px">
          <button class="primary" @click="saveDingtalk">保存</button>
          <button class="small" @click="testDingtalk">测试发送</button>
          <button class="small" @click="testDingImage" title="推送一张内置小图验证图片通道（走工作通知，需填 AgentId）">测试图片</button>
        </div>
      </div>

      <div class="card">
        <h3>钉钉免登</h3>
        <div v-if="ddBound.bound" style="margin-bottom:10px; padding:8px 10px; border-radius:6px; background:rgba(52,211,153,.12); border:1px solid rgba(52,211,153,.4); font-size:13px">
          ✅ 钉钉工作台登录已绑定 <span class="muted">（userid：{{ ddBound.userid }}）</span>
        </div>
        <div v-else class="muted" style="font-size:12px; margin-bottom:10px; padding:8px 10px; border-radius:6px; background:var(--bg3)">
          当前状态：<b>未绑定</b> —— 免登参数保存后，在钉钉里打开本系统并用账号密码登录一次，即自动绑定你的钉钉账号，之后免登直接进入。
        </div>
        <div class="muted" style="font-size:12px; margin-bottom:10px">
          管理员配置好参数后（当前{{ ddEnabled ? '✅ 已启用' : '⚠ 未启用——填齐 corpId / AppKey / AppSecret 并保存' }}），把本系统网址加到钉钉工作台（应用首页地址）即可免登。每人绑定的都是<b>自己的钉钉账号 ↔ 自己的工作台账号</b>（首次密码登录自动绑定，不是沿用管理员的）。「解除绑定」用于换绑或停用本人免登（不影响上面的消息推送绑定）。
        </div>
        <template v-if="isAdmin">
          <div class="form-row"><label>企业 corpId</label><input v-model="ddLogin.corp_id" placeholder="钉钉管理后台 → 企业信息 → 企业 corpId" /></div>
          <div class="form-row"><label>AppKey</label><input v-model="ddLogin.app_key" placeholder="与「钉钉推送」同一个企业内部应用即可" /></div>
          <div class="form-row"><label>AppSecret</label><input v-model="ddLogin.app_secret" type="password" placeholder="留空保持不变" /></div>
          <button class="primary" @click="saveDdLogin">保存</button>
        </template>
        <div v-else class="muted" style="font-size:12px; margin-bottom:8px; color:var(--orange, #e6a23c)">🔒 免登参数由管理员配置</div>
        <div style="margin-top:10px">
          <button class="small" @click="unbindDdLogin" :disabled="!ddBound.bound">解除我的钉钉免登绑定</button>
        </div>
      </div>

      <div class="card">
        <h3>信用卡账单/还款日</h3>
        <div class="muted" style="font-size:12px; margin-bottom:10px">按月重复的账单日/还款日。还款日可直接指定每月几号，或填"距账单日天数"自动推算（跨月自动顺延，如账单日 25 + 20 天）。开关控制是否在「待办与日程 → 日历」中显示。</div>
        <div v-for="(c, i) in creditCards" :key="i" class="row" style="flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:6px">
          <input v-model="c.name" placeholder="卡名（如 招行普卡）" style="width:130px" />
          <input v-model.number="c.bill_day" type="number" min="1" max="31" title="账单日（每月几号）" placeholder="账单日" style="width:75px" />
          <span class="muted" style="font-size:12px">还款：</span>
          <input v-model.number="c.repay_day" type="number" min="0" max="31" title="还款日（每月几号，与偏移二选一）" placeholder="每月几号" style="width:80px" />
          <span class="muted" style="font-size:11px">或 +</span>
          <input v-model.number="c.repay_offset" type="number" min="0" max="60" title="距账单日天数（填了优先）" placeholder="天数" style="width:65px" />
          <label style="cursor:pointer; font-size:12px; display:flex; align-items:center; gap:3px">
            <input v-model="c.show_in_calendar" type="checkbox" style="width:auto" /> 日历显示
          </label>
          <button class="icon-btn" title="删除" @click="creditCards.splice(i, 1)">✕</button>
        </div>
        <div class="row" style="flex-wrap:wrap; gap:8px">
          <button class="primary" @click="saveCreditCards">保存</button>
          <button class="small" @click="creditCards.push({ name: '', bill_day: 10, repay_day: 0, repay_offset: 20, show_in_calendar: 1 })">＋ 添加卡片</button>
        </div>
      </div>

      <div class="card">
        <h3>系统名称</h3>
        <p class="muted" style="margin-bottom:10px">登录页、侧边栏、浏览器标题同步使用</p>
        <div v-if="!isAdmin" class="muted" style="font-size:12px; margin-bottom:8px; color:var(--orange, #e6a23c)">🔒 系统名称由管理员设置</div>
        <div class="row" style="flex-wrap:wrap; margin-bottom:8px">
          <input v-model="sys.name" :disabled="!isAdmin" placeholder="中文名称（如：工作台）" style="width:200px" />
          <input v-model="sys.name_en" :disabled="!isAdmin" placeholder="英文名称（如：Workbench）" style="width:220px" />
        </div>
        <button class="primary" :disabled="!isAdmin" @click="saveSysName">保存系统名称</button>
      </div>

      <div class="card">
        <h3>外观</h3>
        <div class="muted" style="margin-bottom:10px">选择界面主题（按账号保存：任何设备登录同一账号都跟随）</div>
        <div class="row" style="flex-wrap:wrap">
          <button :class="{primary: theme==='dark'}" @click="setTheme('dark')">深色（夜晚）</button>
          <button :class="{primary: theme==='light'}" @click="setTheme('light')">浅色（白天）</button>
          <button :class="{primary: theme==='purple'}" @click="setTheme('purple')">紫色</button>
          <button :class="{primary: theme==='pink'}" @click="setTheme('pink')">粉色</button>
        </div>
        <div style="margin-top:12px; padding-top:10px; border-top:1px solid var(--border)">
          <b style="font-size:13px">日历设置</b>
          <div class="row" style="flex-wrap:wrap; gap:8px; margin-top:6px; align-items:center">
            <span class="muted" style="font-size:12.5px">每周第一天：</span>
            <button :class="{primary: calendarCfg.weekStart==='monday'}" @click="saveCalStart('monday')">周一</button>
            <button :class="{primary: calendarCfg.weekStart==='sunday'}" @click="saveCalStart('sunday')">周日</button>
          </div>
          <div class="row" style="flex-wrap:wrap; gap:8px; margin-top:10px; align-items:center">
            <span class="muted" style="font-size:12.5px">节假日数据源：</span>
            <button :class="{primary: holidayCfg.type==='timor'}" :disabled="locked('holiday')" @click="saveHolidayType('timor')">timor.tech</button>
            <button :class="{primary: holidayCfg.type==='apizero'}" :disabled="locked('holiday')" @click="saveHolidayType('apizero')">apizero.cn</button>
            <span v-if="locked('holiday')" class="muted" style="font-size:12px; color:var(--orange, #e6a23c)">🔒 管理员统一配置</span>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>通勤（地图预计时间）</h3>
        <div class="form-row"><label>家（出发地）</label><input v-model="cm.home" placeholder="如：XX市XX区XX路XX号" /></div>
        <div class="form-row"><label>公司（目的地）</label><input v-model="cm.work" placeholder="如：XX大厦" /></div>
        <div class="form-row"><label>出行方式</label>
          <select v-model="cm.mode" style="width:auto">
            <option value="driving">🚗 驾车</option>
            <option value="walking">🚶 步行</option>
            <option value="bicycling">🚲 骑自行车</option>
            <option value="electrobike">🛵 电动车</option>
          </select>
          <span class="muted" style="font-size:12px">首页通勤时间按此方式计算（仅驾车显示实时路况）</span>
        </div>
        <div class="form-row"><label>高德地图 Web 服务 Key</label><input v-model="cm.key" :disabled="locked('amap_key')" placeholder="申请：lbs.amap.com 个人开发者免费" />
          <div v-if="locked('amap_key')" class="muted" style="font-size:12px; color:var(--orange, #e6a23c)">🔒 Key 由管理员统一配置（地址与时间每人自己的）</div>
        </div>
        <div class="row" style="flex-wrap:wrap">
          <div class="form-row" style="flex:1; min-width:130px"><label>上班时间</label><input v-model="cm.work_start" type="time" /></div>
          <div class="form-row" style="flex:1; min-width:130px"><label>下班时间</label><input v-model="cm.work_end" type="time" /></div>
        </div>
        <div class="row" style="flex-wrap:wrap">
          <div class="form-row" style="flex:1; min-width:130px"><label>每日自动刷新①（路况）</label><input v-model="cm.refresh_times[0]" type="time" /></div>
          <div class="form-row" style="flex:1; min-width:130px"><label>每日自动刷新②（路况）</label><input v-model="cm.refresh_times[1]" type="time" /></div>
        </div>
        <div class="muted" style="font-size:12px; margin-bottom:10px">路况与通勤每天按以上时间自动刷新（保护高德接口配额）；其余时间打开首页使用缓存，地图旁可手动刷新。</div>
        <div class="row" style="flex-wrap:wrap">
          <button class="primary" @click="saveCommute">保存并计算</button>
          <button class="small" @click="calcCommute">重新计算</button>
        </div>
        <div v-if="cmResult.ok" class="card" style="margin-top:12px; background:var(--bg3); border:none">
          <div class="row" style="flex-wrap:wrap; gap:16px">
            <div><span class="muted">家 → 公司</span><div style="font-size:20px; font-weight:600">{{ cmResult.to_work.minutes }} 分钟</div>
              <div class="muted">约 {{ cmResult.to_work.eta }} 到 · {{ cmResult.to_work.distance_km }} km</div></div>
            <div><span class="muted">公司 → 家</span><div style="font-size:20px; font-weight:600">{{ cmResult.to_home.minutes }} 分钟</div>
              <div class="muted">约 {{ cmResult.to_home.eta }} 到 · {{ cmResult.to_home.distance_km }} km</div></div>
          </div>
          <div class="muted" style="margin-top:6px">更新于 {{ cmResult.updated }}</div>
        </div>
        <div v-else-if="cmResult.error" class="msg err" style="margin-top:10px">{{ cmResult.error }}</div>
      </div>

      <div class="card">
        <h3>每日默认待办</h3>
        <p class="muted" style="margin-bottom:10px">每天 06:00 自动把下面的清单生成为当日待办，看板直接展示。每行一条，可写优先级（高/中/低）前缀：</p>
        <textarea v-model="dtText" rows="6" placeholder="例如：&#10;高 · 晨间计划与复盘&#10;背单词 30 分钟&#10;整理今日工作清单"></textarea>
        <div class="row" style="margin-top:8px">
          <button class="primary" @click="saveDefaultTodos">保存模板</button>
          <button class="small" @click="previewTodos">立即生成为今日待办</button>
        </div>
        <div class="muted" style="margin-top:6px">{{ dtHint }}</div>
      </div>

      <div class="card">
        <h3>账号与安全</h3>
        <div class="form-row"><label>当前用户</label><div>{{ me.username }}（{{ me.role === 'admin' ? '管理员' : '成员' }}）</div></div>
        <div class="form-row"><label>原密码</label><input v-model="pw.old" type="password" /></div>
        <div class="form-row"><label>新密码（至少 6 位）</label><input v-model="pw.new1" type="password" /></div>
        <div class="form-row"><label>确认新密码</label><input v-model="pw.new2" type="password" /></div>
        <button class="primary" @click="changePassword">修改密码</button>
      </div>
    </div>

    <!-- 升级管理 tab（仅管理员；懒加载，切到才挂载） -->
    <Upgrade v-if="isAdmin && tab === 'upgrade'" />
    <!-- 飞牛应用 fpk 下载 + 安装说明 tab（仅管理员；v1.9.9） -->
    <FnosPanel v-if="isAdmin && tab === 'fnos'" />
    <SslPanel v-if="isAdmin && tab === 'ssl'" />
    <!-- 登录日志 + IP 黑名单 tab（仅管理员；v1.3.4） -->
    <LoginLogsPanel v-if="isAdmin && tab === 'logs'" />
    <!-- 前端错误上报 tab（仅管理员；v1.9.3 诊断——全局 errorHandler 自动上报的页面脚本异常） -->
    <div v-if="isAdmin && tab === 'clienterr'" class="card">
      <h3>前端错误上报</h3>
      <div class="muted" style="font-size:12.5px; margin-bottom:10px">页面脚本异常会自动上报到这里（内存环存最近 50 条、应用重启清零）。页面右下角弹红条时，来这里看具体出错位置；「清空」后可重新收集。</div>
      <div class="row" style="margin-bottom:10px">
        <button class="primary" @click="loadClientErrors">刷新</button>
        <button class="small" @click="clearClientErrors">清空</button>
      </div>
      <div v-if="!clientErrors.length" class="muted">暂无前端错误上报（页面一切正常）</div>
      <div v-for="(e, i) in clientErrors" :key="i" class="card" style="margin-bottom:8px; padding:10px 12px">
        <div class="row" style="gap:8px; flex-wrap:wrap">
          <span class="badge red">{{ e.at }}</span>
          <span class="badge">{{ e.user }}</span>
          <span class="badge blue">{{ e.page }}</span>
        </div>
        <div style="margin-top:6px; font-size:13.5px"><b>{{ e.msg }}</b></div>
        <div class="muted" style="margin-top:4px; font-size:12px; word-break:break-all; white-space:pre-line">{{ e.stack }}</div>
      </div>
    </div>
    <!-- 多平台 tab（分享访问/电视版；地址配置仅管理员可见，自 family-learning v3.0 移植） -->
    <MultiPanel v-if="tab === 'multi'" :is-admin="isAdmin" />
    <!-- 用户管理 tab（原独立页整页并入，2026-09 v1.7.0；组件内部按管理员角色拦截） -->
    <UsersPanel v-if="isAdmin && tab === 'users'" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import Upgrade from './Upgrade.vue';
import FnosPanel from '../components/FnosPanel.vue';
import SslPanel from '../components/SslPanel.vue';
import LoginLogsPanel from '../components/LoginLogsPanel.vue';
import MultiPanel from './MultiPanel.vue';
import UsersPanel from './Users.vue';
import { NAV_ITEMS, sortByOrder } from '../nav';
import { probeLocalBase } from '../utils/localBase';
import { setSysInfo } from '../sysname';

const tab = ref('general');

// 前端错误上报（v1.9.3 诊断）：全局 errorHandler sendBeacon 上来的客户端异常，仅管理员可看
const clientErrors = ref([]);
async function loadClientErrors() {
  try { clientErrors.value = (await api.get('/client-errors')).errors || []; }
  catch (e) { msg.value = '读取失败：' + e.message; msgType.value = 'err'; }
}
async function clearClientErrors() {
  try { await api.del('/client-errors'); clientErrors.value = []; msg.value = '已清空'; msgType.value = 'ok'; }
  catch (e) { msg.value = '清空失败：' + e.message; msgType.value = 'err'; }
}

const s = ref({ email: { refresh_minutes: 20, smtp_port: 465, smtp_tls: 1, trash_keep_days: 30 }, weather: {}, news_sources: { tech: [], life: [], local: [] }, share: { news: true, holiday: true, amap_key: true, ai_config: true } });
const ai = ref({ model: '', base_url: '', api_key: '', vision_model: '', vision_base_url: '', vision_api_key: '' });
const searchCfg = ref({ base_url: 'https://api.tavily.com', path: '/search', api_key: '' });
const feishu = ref({ app_id: '', app_secret: '', targets: [] });
const feishuChats = ref([]);
const dingtalk = ref({ app_key: '', app_secret: '', mode: 'robot', robot_code: '', agent_id: '', userid: '', enabled: false, bind_base: '', bound_nick: '', bound_at: '', app_configured: false });
const dingMobile = ref('');
const cityInput = ref('');
const msg = ref('');
const msgType = ref('ok');
const me = ref({ username: '', role: 'user' });
const balance = ref(null);
const balanceLoading = ref(false);
const balanceUrl = ref('');
const pw = ref({ old: '', new1: '', new2: '' });
const theme = ref(localStorage.getItem('wb_theme') || 'dark');
const cm = ref({ home: '', work: '', key: '', work_start: '09:00', work_end: '18:00', refresh_times: ['07:00', '17:00'] });
const cmResult = ref({});
const dtText = ref('');
const dtHint = ref('');
const sys = ref({ name: '工作台', name_en: 'Workbench' });

// ---------- 多成员共享模块 ----------
const share = ref({ news: true, holiday: true, amap_key: true, ai_config: true, family: true });
const shareModules = [
  { key: 'news', label: '新闻抓取', desc: '新闻源与抓取结果全员共用（本地新闻仍按各人城市过滤）' },
  { key: 'holiday', label: '节日信息', desc: '节假日数据源全员共用' },
  { key: 'amap_key', label: '高德地图 Key', desc: '通勤/地图共用一个高德 Key' },
  { key: 'ai_config', label: 'AI 配置', desc: '模型与 API Key 全员共用' },
  { key: 'family', label: '家庭与子女', desc: '家庭事项/子女任务/人员档案全员共用一份数据；关闭时数据自动归还管理员，其余成员回到各自数据' },
];
const isAdmin = computed(() => me.value.role === 'admin');
// 共享开关开启且非管理员 → 该模块锁定（输入禁用 + 提示）
function locked(flag) { return !!share.value[flag] && !isAdmin.value; }
async function saveShare(key) {
  try {
    const r = await api.put('/share-config', { [key]: !!share.value[key] });
    share.value = r; // 以服务端返回为准
    const m = shareModules.find((x) => x.key === key);
    flash(`「${m ? m.label : key}」已切换为${r[key] ? '全员共享' : '各成员独立'}`);
  } catch (e) { flash('保存失败：' + e.message, 'err'); }
}

// ---------- 首页看板模块（全局增减，仅管理员） ----------
const dashCards = ref([]);
const dashDisabled = ref([]);
function dashCardOn(key) { return !dashDisabled.value.includes(key); }
function toggleDashCard(key) {
  dashDisabled.value = dashCardOn(key) ? [...dashDisabled.value, key] : dashDisabled.value.filter((k) => k !== key);
}
async function loadDashModules() {
  try {
    const r = await api.get('/dashboard/modules');
    dashCards.value = r.cards || [];
    dashDisabled.value = r.disabled || [];
  } catch { /* 非管理员/接口异常时卡片隐藏 */ }
}
async function saveDashModules() {
  if (!dashCards.value.length || dashDisabled.value.length >= dashCards.value.length) { flash('至少保留一个看板模块', 'err'); return; }
  try {
    const r = await api.put('/dashboard/modules', { disabled: dashDisabled.value });
    dashDisabled.value = r.disabled || [];
    flash('看板模块配置已保存，全员生效（各成员刷新首页可见）');
  } catch (e) { flash('保存失败：' + e.message, 'err'); }
}

async function saveSysName() {
  if (!sys.value.name.trim()) { flash('中文名称不能为空', 'err'); return; }
  try {
    await api.post('/settings/system', { name: sys.value.name.trim(), name_en: sys.value.name_en.trim() });
    setSysInfo(sys.value.name, sys.value.name_en); // 共享来源：头部 logo / 标签页标题全站即时生效
    flash('系统名称已保存，全站即时生效');
  } catch (e) { flash(e.message, 'err'); }
}

function flash(text, type = 'ok') {
  msg.value = text;
  msgType.value = type;
  setTimeout(() => (msg.value = ''), 4000);
}

onMounted(async () => {
  // 角色信息最先加载：后面的 isAdmin 判断（免登配置回显等）依赖它——
  // 曾因放在末尾导致 isAdmin 恒 false，钉钉免登配置保存后重开页面不回显，被误以为没存上
  try {
    const m = await api.get('/auth/me');
    me.value = m.user;
    if (m.theme) theme.value = m.theme; // 服务端保存的主题为准
  } catch {}
  if (me.value.role === 'admin') loadDashModules(); // 全局看板模块卡（依赖上面的角色）
  try { const b = await api.get('/auth/dingtalk-bind-status'); ddBound.value = { bound: !!b.bound, userid: b.userid || '' }; } catch {}
  // 两个聚合接口单独兜住（v1.9.2）：任一失败抛到 onMounted 外会把整页内容卸掉——
  // 「设置闪一下就没了」的元凶。失败时用空对象继续，页面照常渲染。
  // v1.9.5：/settings 被网关拦截时 d={}，直接 s.value=d 会把默认子对象冲掉，
  // 模板读 s.weather.city 直接崩（真机捕获 reading 'city'/'lat'）——与初始默认值合并。
  let d = {};
  try { d = await api.get('/settings'); } catch {}
  s.value = { ...s.value, ...d, weather: (d && d.weather) || s.value.weather || {} };
  if (d.share) share.value = d.share;
  loadCalCfg();
  let a = {};
  try { a = await api.get('/ai/config'); } catch {}
  try {
    const info = await api.get('/system-info');
    if (info.name) sys.value.name = info.name;
    if (info.name_en) sys.value.name_en = info.name_en;
  } catch (e) { /* 默认 */ }
  ai.value = a;
  try { const sc = await api.get('/news/search-config'); searchCfg.value = { base_url: sc.base_url, path: sc.path, api_key: sc.api_key }; } catch {}
  try { const f = await api.get('/feishu/config'); feishu.value = { app_id: f.app_id || '', app_secret: f.app_secret || '', targets: Array.isArray(f.targets) ? f.targets : [] }; } catch {}
  try { const g = await api.get('/dingtalk/config'); dingtalk.value = { app_key: g.app_key || '', app_secret: g.app_secret || '', mode: g.mode || 'robot', robot_code: g.robot_code || '', agent_id: g.agent_id || '', userid: g.userid || '', enabled: !!g.enabled, bind_base: g.bind_base || '', bound_nick: g.bound_nick || '', bound_at: g.bound_at || '', app_configured: !!g.app_configured }; } catch {}
  try { const fd = await api.get('/settings/files-dir'); filesDir.value = { dir: fd.dir || '' }; } catch {}
  try { const ur = await api.get('/settings/upload-root'); uploadRoot.value = { dir: ur.dir || '' }; } catch {}
  try { const lb = await api.get('/settings/local-base'); localBase.value = { base: lb.base || '' }; } catch {}
  try { if (isAdmin.value) { const vc = await api.get('/vc/config'); vcRoot.value = { dir: vc.root || '', ok: !!vc.root_ok }; } } catch {}
  try { if (isAdmin.value) { const la = await api.get('/settings/lan-addrs'); lanAddrs.value = la.addrs || []; } } catch {}
  try { if (isAdmin.value) { const dl = await api.get('/dingtalk/login-config'); ddLogin.value = { corp_id: dl.corp_id || '', app_key: dl.app_key || '', app_secret: dl.app_secret || '' }; } } catch {}
  // 免登是否已启用（管理员参数齐=启用），状态行展示用
  try { const di = await api.get('/auth/dingtalk-info'); ddEnabled.value = !!di.enabled; } catch {}
  try { const cc = await api.get('/credit-cards'); creditCards.value = cc.cards || []; } catch {}
  cityInput.value = d.weather.city || '';
  // AI 已配置（api_key 掩码非空）时，自动查询一次余额
  if (a.api_key === '******') queryBalance();
  // 通勤配置与结果
  try {
    const c = await api.get('/commute');
    cm.value = c.config || { home: '', work: '', key: '', work_start: '09:00', work_end: '18:00', refresh_times: ['07:00','17:00'], mode: 'driving' };
    if (!cm.value.refresh_times || !cm.value.refresh_times.length) cm.value.refresh_times = ['07:00','17:00'];
    if (!cm.value.mode) cm.value.mode = 'driving'; // 旧配置无出行方式字段 → 默认驾车
    if (c.ok) cmResult.value = c; else if (c.error) cmResult.value = { error: c.error };
  } catch {}
  // 每日默认待办模板
  try {
    const t = await api.get('/todos/default');
    dtText.value = t.items.map((i) => `${['', '高 · ', '中 · ', '低 · '][i.priority] || ''}${i.title}`).join('\n');
    dtHint.value = t.items.length ? `当前模板 ${t.items.length} 条` : '模板为空';
  } catch {}
  await loadOrder();
});

// ---------- 页面列表排序（全局：管理员统一设置，全员共用） ----------
const orderList = ref([]);
const labelMap = ref({}); // page → 自定义中文名
const editing = ref(null); // 正在改名的 page（null = 无）
const editText = ref('');
// 当前用户可见的页面（与 App 侧边栏同一套过滤规则）
function myNavItems() {
  const u = me.value;
  if (!u || u.role === 'admin') return NAV_ITEMS;
  const allowed = u.allowed_pages || [];
  if (!allowed.length) return NAV_ITEMS;
  return NAV_ITEMS.filter((n) => !n.adminOnly && allowed.includes(n.page));
}
async function loadOrder() {
  let saved = [];
  let labels = {};
  try {
    const d = await api.get('/nav-order');
    saved = d.order || [];
    labels = d.labels || {};
  } catch {}
  orderList.value = sortByOrder(myNavItems(), saved);
  labelMap.value = labels;
}
// 菜单改名：显示名优先取自定义，否则用默认 label
function displayLabel(p) { return labelMap.value[p.page] || p.label; }
function startRename(p) { editing.value = p.page; editText.value = displayLabel(p); }
async function confirmRename(p) {
  const v = editText.value.trim();
  if (v && v !== p.label) labelMap.value[p.page] = v;
  else delete labelMap.value[p.page]; // 留空或改回默认名 = 恢复默认
  editing.value = null;
  try {
    await api.put('/nav-labels', { labels: labelMap.value });
    localStorage.setItem('wb_page_labels', JSON.stringify(labelMap.value));
    window.dispatchEvent(new CustomEvent('wb-nav-labels', { detail: labelMap.value })); // App 侧边栏即时改名
    flash('菜单名称已保存，左侧菜单已更新');
  } catch (e) { flash('保存失败: ' + e.message, 'err'); }
}
function moveOrder(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= orderList.value.length) return;
  const arr = orderList.value;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}
async function saveOrder() {
  const order = orderList.value.map((p) => p.page);
  try {
    await api.put('/nav-order', { order });
    localStorage.setItem('wb_page_order', JSON.stringify(order));
    window.dispatchEvent(new CustomEvent('wb-nav-order', { detail: order })); // App 侧边栏即时重排
    flash('页面排序已保存，左侧菜单已更新');
  } catch (e) { flash('保存失败: ' + e.message, 'err'); }
}
async function resetOrder() {
  try {
    await api.put('/nav-order', { order: [] });
    localStorage.removeItem('wb_page_order');
    window.dispatchEvent(new CustomEvent('wb-nav-order', { detail: [] }));
    orderList.value = myNavItems().slice();
    flash('已恢复默认排序');
  } catch (e) { flash('操作失败: ' + e.message, 'err'); }
}

const calendarCfg = ref({ weekStart: 'monday' });
const holidayCfg = ref({ type: 'timor' });
async function loadCalCfg() {
  try { calendarCfg.value = await api.get('/calendar/config'); } catch {}
  try { holidayCfg.value = await api.get('/holidays/config'); } catch {}
}
async function saveCalStart(v) { calendarCfg.value.weekStart = v; await api.post('/calendar/config', calendarCfg.value); flash('日历设置已保存'); }
async function saveHolidayType(v) { holidayCfg.value.type = v; await api.post('/holidays/config', holidayCfg.value); flash('节日数据源已保存'); }

function setTheme(t) {
  theme.value = t;
  document.documentElement.dataset.theme = t;
  localStorage.setItem('wb_theme', t);
  // 主题随账号保存到服务端（失败不影响本机生效）
  api.post('/settings/theme', { theme: t }).catch(() => {});
}

async function saveCommute() {
  // 高德 Key 共享且非管理员：不回传 key 字段（服务端只允许管理员改共享 Key；地址/时间人人可改）
  const { key, ...rest } = cm.value;
  await api.post('/commute', locked('amap_key') ? rest : cm.value);
  await calcCommute();
}
async function calcCommute() {
  cmResult.value = {};
  try {
    const c = await api.get('/commute?force=1');
    cm.value = c.config || { home: '', work: '', key: '', work_start: '09:00', work_end: '18:00', refresh_times: ['07:00','17:00'] };
    if (c.ok) cmResult.value = c; else cmResult.value = { error: c.error };
  } catch (e) { cmResult.value = { error: e.message }; }
}

// 解析模板文本：支持「高/中/低 · 标题」前缀
function parseDefaultTodos() {
  return dtText.value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const m = line.match(/^(高|中|低)\s*[··:：]\s*(.+)$/);
    if (m) return { title: m[2], priority: { 高: 1, 中: 2, 低: 3 }[m[1]] };
    return { title: line, priority: 2 };
  });
}
async function saveDefaultTodos() {
  const items = parseDefaultTodos();
  const r = await api.post('/todos/default', { items });
  dtHint.value = `已保存 ${r.count} 条模板，每天 06:00 自动生成当日待办`;
}
async function previewTodos() {
  const items = parseDefaultTodos();
  await api.post('/todos/default', { items });
  const today = new Date().toISOString().slice(0, 10);
  for (const t of items) {
    await api.post('/todos', { title: `每日 · ${t.title}`, desc: '每日默认待办', due_date: today, priority: t.priority });
  }
  dtHint.value = `模板已保存，并立即生成 ${items.length} 条今日待办`;
}

// 邮箱相关配置（IMAP/SMTP/签名/附件目录）已随 v1.7.0 多邮箱改造移到「邮箱」页的「邮箱设置」tab

// 文件存档存储目录（与邮件附件同法：留空=内容存库）
const filesDir = ref({ dir: '' });
async function saveFilesDir() {
  try {
    const r = await api.post('/settings/files-dir', filesDir.value);
    filesDir.value.dir = r.dir || filesDir.value.dir;
    flash(filesDir.value.dir ? '文件存档目录已保存：' + filesDir.value.dir : '已清空目录，新上传文件内容将存数据库');
  } catch (e) { flash('保存失败：' + e.message, 'err'); }
}

// 全局默认上传保存路径（主库全局设置，仅管理员；未配专属目录的上传都默认落这里）
const uploadRoot = ref({ dir: '' });
async function saveUploadRoot() {
  try {
    const r = await api.post('/settings/upload-root', uploadRoot.value);
    uploadRoot.value.dir = r.dir || uploadRoot.value.dir;
    flash(uploadRoot.value.dir ? '全局上传路径已保存：' + uploadRoot.value.dir : '已清空全局上传路径，恢复旧行为（图片存数据库、附件不留档）');
  } catch (e) { flash('保存失败：' + e.message, 'err'); }
}

// 本地直连地址（主库全局设置，仅管理员）：视频教学大文件在局域网内改走该地址
const localBase = ref({ base: '' });
const lanAddrs = ref([]);
async function saveLocalBase() {
  try {
    const r = await api.post('/settings/local-base', localBase.value);
    localBase.value.base = r.base || '';
    try { sessionStorage.removeItem('wb_local_base'); } catch { /* 换地址后重新探测 */ }
    probeLocalBase(true);   // 立即重测新地址：可达则徽标/学习页通道即时切换
    flash(localBase.value.base ? '本地直连已启用：' + localBase.value.base + '（不可达时自动回落公网）' : '已停用本地直连，全部走当前访问地址');
  } catch (e) { flash('保存失败：' + e.message, 'err'); }
}

// 智能家居视频路径（v1.9.26，仅管理员）：智能家居页「视频中心」tab 的根目录，与视频教学目录独立
const vcRoot = ref({ dir: '', ok: null });
async function saveVcRoot() {
  try {
    await api.post('/vc/settings', { root: vcRoot.value.dir.trim() });
    const c = await api.get('/vc/config');
    vcRoot.value.ok = c.root_ok;
    flash(c.root_ok ? '智能家居视频路径已保存：' + c.root : (vcRoot.value.dir ? '已保存，但该路径当前在服务器上不可访问（Docker 部署需填容器内路径）' : '已清空，「视频中心」tab 将提示未配置'));
  } catch (e) { flash('保存失败：' + e.message, 'err'); }
}

// 钉钉免登（全局参数仅管理员可配；解绑本人绑定人人可用）
const ddLogin = ref({ corp_id: '', app_key: '', app_secret: '' });
const ddBound = ref({ bound: false, userid: '' }); // 本人「钉钉账号↔工作台账号」绑定状态
const ddEnabled = ref(false); // 管理员参数是否齐（免登是否启用）
async function saveDdLogin() {
  try {
    const r = await api.post('/dingtalk/login-config', ddLogin.value);
    // 用服务端保存后的值回填：输入框始终显示库里真实内容，保存成功一目了然
    ddLogin.value = { corp_id: r.corp_id || '', app_key: r.app_key || '', app_secret: r.app_secret ? '******' : (ddLogin.value.app_secret ? '******' : '') };
    ddEnabled.value = !!r.configured;
    flash(r.configured
      ? '钉钉免登已启用：在钉钉工作台打开本系统自动登录（每人首次账号密码登录一次即绑定自己的账号）'
      : '已保存，但参数未填齐（corpId / AppKey / AppSecret），免登暂不生效');
  } catch (e) { flash('保存失败：' + e.message, 'err'); }
}
async function unbindDdLogin() {
  try {
    await api.post('/auth/dingtalk/unbind');
    ddBound.value = { bound: false, userid: '' };
    flash('已解除我的钉钉免登绑定，下次将回到账号密码登录');
  } catch (e) { flash('解绑失败：' + e.message, 'err'); }
}

// 信用卡账单/还款日
const creditCards = ref([]);
async function saveCreditCards() {
  try {
    const r = await api.post('/credit-cards', { cards: creditCards.value });
    flash(`已保存 ${r.count} 张卡的账单/还款配置`);
  } catch (e) { flash('保存失败：' + e.message, 'err'); }
}
async function saveWeather() { await api.post('/settings/weather', { city: s.value.weather.city || cityInput.value, lat: s.value.weather.lat, lon: s.value.weather.lon }); flash('天气配置已保存'); }

async function geocode() {
  if (!cityInput.value.trim()) return;
  try {
    const r = await api.post('/weather/geocode', { city: cityInput.value.trim() });
    s.value.weather = { city: r.city, lat: r.lat, lon: r.lon };
    await saveWeather();
    flash(`已定位城市：${r.city}，本地新闻将按此城市过滤`);
  } catch (e) { flash('定位失败：' + e.message, 'err'); }
}

async function saveAi() {
  await api.post('/ai/config', ai.value);
  flash('AI 配置已保存');
}
async function testAi() {
  try {
    const r = await api.post('/ai/chat', { messages: [{ role: 'user', content: '回复"连接成功"四个字' }] });
    flash('AI 连接成功：' + r.content.slice(0, 60));
  } catch (e) { flash('AI 连接失败：' + e.message, 'err'); }
}

async function queryBalance() {
  balanceLoading.value = true;
  try {
    balance.value = await api.get('/ai/balance');
  } catch (e) { balance.value = { error: e.message }; }
  finally { balanceLoading.value = false; }
}
async function saveBalanceUrl() {
  await api.post('/ai/balance-url', { url: balanceUrl.value });
  flash('余额接口已保存');
}

async function changePassword() {
  if (!pw.value.old || !pw.value.new1) { flash('请填写完整', 'err'); return; }
  if (pw.value.new1 !== pw.value.new2) { flash('两次新密码不一致', 'err'); return; }
  try {
    await api.post('/auth/password', { old_password: pw.value.old, new_password: pw.value.new1 });
    pw.value = { old: '', new1: '', new2: '' };
    flash('密码已修改');
  } catch (e) { flash(e.message, 'err'); }
}

function addSource(cat) { s.value.news_sources[cat].push({ name: '', url: '' }); }
function catLabel(c) { return { tech: '科技', life: '生活', local: '本地' }[c]; }
async function saveSources() { await api.post('/news/sources', { sources: s.value.news_sources }); flash('新闻源已保存'); }
async function saveSearchCfg() { await api.post('/news/search-config', searchCfg.value); flash('新闻搜索配置已保存'); }
async function saveFeishu() {
  try { await api.post('/feishu/config', feishu.value); flash('飞书配置已保存（' + (feishu.value.targets || []).filter((t) => t.receive_id).length + ' 个会话）'); }
  catch (e) { flash('保存失败：' + e.message, 'err'); }
}
async function loadFeishuChats() {
  try { const d = await api.get('/feishu/chats'); feishuChats.value = d.chats || []; if (!feishuChats.value.length) flash('机器人不在任何群里——先把它加到一个飞书群', 'err'); }
  catch (e) { flash('列出群失败：' + e.message, 'err'); }
}
function addChat(c) {
  if ((feishu.value.targets || []).some((t) => t.receive_id === c.chat_id)) { flash('该群已在列表中', 'err'); return; }
  feishu.value.targets.push({ receive_id_type: 'chat_id', receive_id: c.chat_id, name: c.name });
}
async function testFeishu() {
  try { await api.post('/feishu/test'); flash('测试消息已发送到全部会话，去飞书查看'); }
  catch (e) { flash('发送失败：' + e.message, 'err'); }
}
async function saveDingtalk() {
  try { await api.post('/dingtalk/config', dingtalk.value); flash('钉钉配置已保存' + (dingtalk.value.enabled ? '，新消息将同步推送' : '')); }
  catch (e) { flash('保存失败：' + e.message, 'err'); }
}
async function resolveDingUserid() {
  if (!dingMobile.value.trim()) { flash('先填手机号', 'err'); return; }
  try { const d = await api.post('/dingtalk/resolve-mobile', { mobile: dingMobile.value.trim() }); dingtalk.value.userid = d.userid; flash('已解析 userid：' + d.userid); }
  catch (e) { flash('解析失败：' + e.message, 'err'); }
}
async function testDingtalk() {
  try { await api.post('/dingtalk/test'); flash('测试消息已发送，去钉钉查看'); }
  catch (e) { flash('发送失败：' + e.message, 'err'); }
}
async function testDingImage() {
  try { await api.post('/dingtalk/test-image'); flash('测试图片已通过「工作通知」推送，去钉钉查看（收到蓝色小图说明图片通道正常）'); }
  catch (e) { flash('图片推送失败：' + e.message, 'err'); }
}
</script>

<style scoped>
/* 反馈条吸顶：设置页很长（masonry 多卡），在底部卡片点「测试发送/测试图片/保存」时，
   顶部反馈条会被滚出视口看不见（曾表现为"点测试图片没有任何反应"，实际 400 错误已返回） */
.msg { position: sticky; top: 8px; z-index: 60; box-shadow: 0 4px 18px rgba(0, 0, 0, 0.22); }
</style>
