<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal" style="width:min(880px,94vw); max-height:88vh; overflow-y:auto">
      <h3>IM连接</h3>
      <div class="muted" style="font-size:12.5px; margin-bottom:12px">
        以<b>你本人的身份</b>授权（不是群机器人），把你自己在 IM 里的聊天记录归档成笔记，
        落到笔记树的<b>「IM连接 / 平台 / 连接器备注名」</b>里（每条连接器各占一个自己的子目录，
        互不混在一起）。<b>只走各平台官方通道</b>（飞书=开放平台 OAuth，钉钉=官方 CLI 设备流）——
        不抓包、不模拟客户端、不爬取。随时可以在这里解除授权。
        <br>同一个平台可以授权多次（比如两家不同企业的飞书，就建两条连接器）。
        每条连接器都能单独设一个<b>定时同步</b>（每天/每周、几点、拉多大范围）。
        <br>归档笔记里<b>新消息排在最上面</b>（越往下越早，不用翻到最底下去看新的），
        并且自动带上所在平台的标签（飞书 → <code>#飞书</code>、钉钉 → <code>#钉钉</code>、
        企业微信 → <code>#企业微信</code>）。排序方向下面每条连接器都能单独关掉。
      </div>
      <div v-if="err" class="msg err">{{ err }}</div>
      <div v-if="msg" class="msg ok">{{ msg }}</div>

      <!-- 新建（钉钉走官方 CLI 设备流，没有应用凭证三件套 —— 表单按平台分叉） -->
      <div class="card" style="background:var(--bg3); border:none; margin-bottom:12px">
        <div class="row" style="gap:6px; flex-wrap:wrap; align-items:center">
          <select v-model="form.provider" style="width:130px">
            <option v-for="p in providers" :key="p.key" :value="p.key" :disabled="!p.ready">
              {{ p.name }}{{ p.ready ? '' : '（暂未实现）' }}
            </option>
          </select>
          <input v-model="form.label" :placeholder="isDeviceAuth ? '备注名，如「公司钉钉」' : '备注名，如「公司飞书」'" style="width:180px" />
          <template v-if="!isDeviceAuth">
            <input v-model="form.app_id" placeholder="App ID（cli_ 开头）" style="width:210px" />
            <input v-model="form.app_secret" type="password" placeholder="App Secret" style="width:200px" />
          </template>
          <button class="primary" @click="create">＋ 添加连接器</button>
        </div>
        <div v-if="!isDeviceAuth" class="row" style="gap:6px; margin-top:8px; align-items:center">
          <span class="muted" style="font-size:12px; white-space:nowrap">回调地址</span>
          <input v-model="form.redirect_uri" style="flex:1; font-size:12px" />
          <button class="small" @click="form.redirect_uri = defaultRedirect">用默认</button>
        </div>
        <div v-if="curProvider && !curProvider.ready" class="muted" style="font-size:12px; margin-top:8px">
          {{ curProvider.hint }}
        </div>
        <div v-else-if="isDeviceAuth" class="muted" style="font-size:12px; margin-top:8px">
          {{ curProvider && curProvider.hint }}
        </div>
      </div>

      <!-- 已有连接器 -->
      <div v-for="c in connectors" :key="c.id" class="card" style="background:var(--bg3); border:none; margin-bottom:10px">
        <div class="row" style="gap:6px; flex-wrap:wrap; align-items:center">
          <b>{{ c.provider_name }}</b>
          <input :value="c.label" placeholder="备注名" style="width:140px" @change="save(c, { label: $event.target.value })" />
          <span class="tag" :class="c.authorized ? 'ok' : 'gray'">
            {{ c.authorized ? '已授权' : (c.status === 'expired' ? '授权已过期' : (c.status === 'error' ? '出错' : '未授权')) }}
          </span>
          <span v-if="c.tenant_key" class="muted" style="font-size:12px">企业 {{ c.tenant_key }}</span>
          <span v-if="c.user_name" class="muted" style="font-size:12px">· {{ c.user_name }}</span>
          <span v-if="c.last_sync_at" class="muted" style="font-size:12px; margin-left:auto">上次同步 {{ c.last_sync_at }}</span>
        </div>
        <div v-if="c.last_error" class="msg err" style="margin:6px 0 0; font-size:12px">{{ c.last_error }}</div>

        <div class="row" style="gap:6px; margin-top:8px; flex-wrap:wrap; align-items:center">
          <!-- 授权入口按平台分叉：飞书开浏览器走 OAuth 授权码；钉钉在本面板里走设备流扫码 -->
          <button v-if="c.provider === 'dingtalk'" class="small primary" @click="startLogin(c)">
            {{ c.authorized ? '重新扫码登录' : '扫码登录钉钉' }}
          </button>
          <button v-else class="small primary" @click="authorize(c)">{{ c.authorized ? '重新授权' : '去授权' }}</button>
          <select v-model.number="sinceDays" style="width:120px" title="首次同步拉多久以内的历史">
            <option v-for="d in DAY_RANGES" :key="d.v" :value="d.v">{{ d.label }}</option>
          </select>
          <button class="small" :disabled="!c.authorized || busy === c.id" @click="askSync(c)">
            {{ busy === c.id ? '同步中…' : '同步' }}
          </button>
          <button class="small" @click="toggle(c, 'chats')">会话（{{ chatCount[c.id] ?? '…' }}）</button>
          <button class="small" @click="toggle(c, 'logs')">日志</button>
          <button class="small" @click="refresh(c)">刷新状态</button>
          <button class="small" @click="revoke(c)">解除授权</button>
          <button class="small danger" @click="del(c)">删除</button>
        </div>
        <div class="muted" style="font-size:11.5px; margin-top:6px">
          <template v-if="c.provider === 'dingtalk'">
            官方 dws CLI 通道（设备流扫码，令牌由 CLI 加密保存，不进本系统数据库）
            <span v-if="c.status === 'authorized'"> · 已登录</span>
          </template>
          <template v-else>
            App ID {{ c.app_id }} · 回调 {{ c.redirect_uri }}
            <span v-if="c.expires_at_ms"> · 令牌有效到 {{ fmtMs(c.expires_at_ms) }}</span>
          </template>
        </div>

        <!-- 钉钉设备流登录面板：官方验证链接 + 授权码直接摆出来（链接点开就是钉钉的确认页），
             后端每 2 秒被轮询一次，登录成功的瞬间自动收起并刷新卡片状态。 -->
        <div v-if="loginPanel[c.id]" class="loginbox">
          <template v-if="loginPanel[c.id].running">
            <div style="font-size:13px">在浏览器打开下面的链接、用钉钉确认授权（授权码 <b>{{ loginPanel[c.id].code || '…' }}</b>，15 分钟内有效）：</div>
            <a v-if="loginPanel[c.id].url" :href="loginPanel[c.id].url" target="_blank" rel="noopener"
               style="font-size:12px; word-break:break-all">{{ loginPanel[c.id].url }}</a>
            <div v-else class="muted" style="font-size:12px">正在向钉钉申请授权码…</div>
            <pre class="loginlog">{{ loginPanel[c.id].output }}</pre>
            <div class="row" style="justify-content:flex-end">
              <button class="small" @click="cancelLogin(c)">取消登录</button>
            </div>
          </template>
          <template v-else>
            <!-- 失败分两档：CLI 给了原因的（如「组织未开启允许成员通过 CLI 访问个人数据」）红底亮出来，
                 没给原因的（超时/被取消）才落到原来那句猜测式文案 —— 别让能照着办的事埋在原始日志里。 -->
            <div v-if="loginPanel[c.id].authenticated" class="muted" style="font-size:12.5px">✅ 登录成功，身份已记住。</div>
            <div v-else-if="loginPanel[c.id].errorText" class="loginerr">❌ 登录没有完成：{{ loginPanel[c.id].errorText }}</div>
            <div v-else class="muted" style="font-size:12.5px">登录没有完成（超时或被取消），可以重新点「扫码登录钉钉」。</div>
          </template>
        </div>

        <!-- 归档正文的排版方向（v1.10.18）：IM 笔记是「一会话一篇、越同步越长」，
             默认让新消息排在最上面，打开笔记第一眼就是最新的，不用滚到底。
             改一下立刻把这批笔记重排一遍（服务端 updateConnector 里直接调 normalizeImNotes），
             不用等下一次同步。 -->
        <div class="ord">
          <label class="chk">
            <input type="checkbox" style="width:auto" :checked="c.note_order !== 'asc'"
                   @change="save(c, { note_order: $event.target.checked ? 'desc' : 'asc' })" />
            <span>笔记里新消息排在最上面（倒序；关掉就还是追加在下面）</span>
          </label>
        </div>

        <!-- 定时同步（v1.10.14，需求③）：**每条连接器各设各的** —— 两家飞书的时点、
             频率、范围互不影响（一家每天凌晨、另一家每周一上午，都行）。 -->
        <div class="sched" :class="{ off: !c.auto_sync }">
          <label class="chk">
            <input type="checkbox" style="width:auto" :checked="!!c.auto_sync"
                   @change="save(c, { auto_sync: $event.target.checked ? 1 : 0 })" />
            <span>定时同步</span>
          </label>
          <!-- 时点/频率/范围**始终可见**（关着也能先设好）—— 原来这几项挂在 `v-if="c.auto_sync"` 上，
               于是「想先看看有哪些选项」就得先把开关打开，而一打开就是「已到点」（auto_last_at 为空 =
               立刻补跑一次），下一分钟真跑起来了。先设好、再开开关，就不会有这个意外。 -->
          <select :value="c.auto_freq || 'daily'" style="width:88px"
                  @change="save(c, { auto_freq: $event.target.value })">
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
          </select>
          <select v-if="(c.auto_freq || 'daily') === 'weekly'" :value="String(c.auto_weekday || 1)"
                  style="width:80px" @change="save(c, { auto_weekday: Number($event.target.value) })">
            <option v-for="(n, i) in WEEKDAYS" :key="n" :value="String(i + 1)">{{ n }}</option>
          </select>
          <input type="time" style="width:120px" :value="c.auto_time || '08:00'"
                 @change="save(c, { auto_time: $event.target.value })" />
          <span class="muted" style="font-size:12px; white-space:nowrap">范围</span>
          <select :value="String(c.auto_days || 30)" style="width:118px"
                  @change="save(c, { auto_days: Number($event.target.value) })">
            <option v-for="d in DAY_RANGES" :key="d.v" :value="String(d.v)">{{ d.label }}</option>
          </select>
        </div>
        <div class="muted" style="font-size:11.5px; margin-top:4px">
          {{ autoHint(c) }}
          <span v-if="c.auto_sync && c.auto_last_at">· 上次自动跑 {{ c.auto_last_at }}{{ c.auto_last_result ? `：${c.auto_last_result}` : '' }}</span>
        </div>

        <!-- 会话列表 -->
        <div v-if="open[c.id] === 'chats'" style="margin-top:10px">
          <div class="row" style="gap:6px; align-items:center">
            <input v-model="chatAdd[c.id]" :placeholder="c.provider === 'dingtalk' ? '手动添加会话 ID（cid 开头；单聊列不出来时可从这里补）' : '手动添加会话 ID（oc_ 开头；单聊列不出来时可从这里补）'" style="flex:1; font-size:12px" />
            <button class="small" @click="addChat(c)">添加</button>
          </div>
          <div v-if="!(chatList[c.id] || []).length" class="muted" style="font-size:12px; margin-top:6px">
            还没有会话。点「同步」会先拉会话列表；若某个单聊没被列出来，手动填它的会话 ID。
          </div>
          <div v-for="ch in chatList[c.id] || []" :key="ch.id" class="row" style="gap:6px; align-items:center; margin-top:6px">
            <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
              {{ ch.chat_mode === 'p2p' ? '💬' : '👥' }} {{ ch.chat_name || ch.chat_id }}
            </span>
            <span class="muted" style="font-size:11.5px">{{ ch.msg_count }} 条</span>
            <a v-if="ch.note_id" href="javascript:;" style="font-size:12px" @click="$emit('open-note', ch.note_id)">打开笔记</a>
            <span v-if="ch.last_error" class="muted" style="font-size:11.5px; color:var(--red)">{{ ch.last_error.slice(0, 40) }}…</span>
            <button class="small" @click="removeChat(c, ch)">移除</button>
          </div>
        </div>

        <!-- 日志 -->
        <div v-if="open[c.id] === 'logs'" style="margin-top:10px">
          <div v-for="l in logs[c.id] || []" :key="l.id" class="muted" style="font-size:11.5px">
            <span :style="{ color: l.level === 'error' ? 'var(--red)' : (l.level === 'warn' ? 'var(--amber)' : 'inherit') }">
              [{{ l.created_at }}] {{ l.message }}
            </span>
          </div>
          <div v-if="!(logs[c.id] || []).length" class="muted" style="font-size:12px">还没有日志。</div>
        </div>
      </div>

      <div v-if="!connectors.length" class="muted" style="font-size:12.5px; margin-bottom:10px">
        还没有连接器。飞书填自建应用的 App ID / App Secret；钉钉选「钉钉」、起个备注名就行（下一步扫码）。
      </div>

      <details style="margin-bottom:10px">
        <summary style="cursor:pointer; font-size:13px">飞书怎么准备？（第一次做的话看这里）</summary>
        <ol class="muted" style="font-size:12.5px; line-height:1.9; padding-left:20px">
          <li>去 <b>open.feishu.cn</b> 开放平台 → 开发者后台 → 创建<b>企业自建应用</b>（需要企业管理员）。</li>
          <li>「凭证与基础信息」里抄下 <b>App ID</b> 和 <b>App Secret</b>，填到上面。</li>
          <li>「安全设置 → 重定向 URL」里把上面的<b>回调地址原样加进去</b>（一个字都不能差）。</li>
          <li>「权限管理」里勾这五个权限（<b>最后一个别漏</b>）：
            <code>im:chat:readonly</code>、<code>im:message:readonly</code>、
            <code>im:message.p2p_msg:get_as_user</code>、<code>im:message.group_msg:get_as_user</code>、
            <code>offline_access</code>。
            <br><span class="muted">（<code>offline_access</code> 用来拿刷新令牌。漏了它的后果是：授权当场成功，
            但两小时后令牌过期、同步全部失败，只能重新授权一次。）</span></li>
          <li><b>「添加应用能力」里勾上「机器人」，然后发布版本</b>（这一步和上面的权限一样是<b>必须的</b>）：
            飞书开放平台后台 → 你的应用 → 「添加应用能力」→ 勾上<b>「机器人」</b>。
            <br><span class="muted">读会话列表、读历史消息这整组 <code>im/v1/*</code> 接口挂在「机器人」这个应用能力下，
            所以<b>光授权不够</b>——授权给的是用户身份和权限范围，能力没开的话一样调不通。
            漏了它的典型症状：连接器显示「已授权」、用户名也对，一点「同步」就报
            <code>232025：Bot ability is not activated</code>。</span></li>
          <li>「版本管理与发布」创建版本并<b>发布</b>（自己审自己即可）。
            <span class="muted">上面勾的权限和刚加的「机器人」能力，都要<b>随版本发布出去</b>才在线上生效；
            加完能力没发版本，等于没加。</span></li>
          <li>回到这里点「去授权」，浏览器里同意授权 —— 完成后状态变成「已授权」。</li>
        </ol>
        <div class="muted" style="font-size:12px; line-height:1.8">
          已知边界：官方列会话接口默认<b>不含单聊</b>，本工具会按官方 CLI 的做法多带一个参数试着把单聊也列出来，
          列不到时可以在下面的「会话」里<b>手动填会话 ID</b>补上；开了保密模式的群读不到（231203）；
          读群消息<b>不要求</b>把机器人拉进群（那是应用身份那条路的旧限制）；
          报 <code>232025</code> 就是「机器人」能力没开或加了没发版本。<br>
          归档出来的笔记标题是 <b>对方名称-日期时间-连接器备注名</b>（会话 ID 记在笔记抬头里）。
        </div>
      </details>

      <details style="margin-bottom:10px">
        <summary style="cursor:pointer; font-size:13px">钉钉怎么准备？（第一次做的话看这里）</summary>
        <ol class="muted" style="font-size:12.5px; line-height:1.9; padding-left:20px">
          <li><b>企业管理员</b>去钉钉管理后台（oa.dingtalk.com）→ 安全管理 / 权限相关设置里，
            开启<b>「允许成员通过钉钉 CLI 访问个人数据」</b>（不开的话成员扫码也会被拒）。</li>
          <li>同一个后台里还要看一眼<b>「使用范围管理」</b>：点编辑、把范围选成<b>「全员可用」</b>
            （默认范围往往不包含你，开关开了、人不在范围内，照样登录不上 ——
            实测表现为 OAuth 扫码后 CLI 被组织拒掉）。</li>
          <li>服务器上要有钉钉官方 <b>dws CLI</b>（npm 包 <code>dingtalk-workspace-cli</code>，或从官方
            GitHub Releases 下载对应平台的二进制）。本应用升级包已随附 linux 版，放在数据目录
            <code>dws/bin/</code> 也可以；没有 CLI 时点「扫码登录钉钉」会明确提示。</li>
          <li>这里选「钉钉」→ 起个备注名 → 添加连接器 → 点<b>「扫码登录钉钉」</b>，
            打开面板里给的官方链接、用钉钉 App 确认授权（授权码 15 分钟内有效）。</li>
          <li>授权范围是<b>你自己的会话</b>（单聊 + 你所在的群），由钉钉官方 OAuth 设备流发放、
            令牌存在服务器上 CLI 自己的加密目录里；解除授权会删掉它。</li>
        </ol>
        <div class="muted" style="font-size:12px; line-height:1.8">
          已知边界：单聊的历史消息走钉钉官方「消息搜索」通道，个别组织没开通该权限时<b>单聊</b>会同步失败
          （群聊不受影响），失败原因会写在「会话」列表里那一条上；CLI 处于共创阶段，命令口径可能随版本变化
          （本应用锁定随包版本）。
          <br>归档出来的笔记标题同样是 <b>对方名称-日期时间-连接器备注名</b>（会话 ID 记在笔记抬头里）。
        </div>
      </details>

      <div class="row" style="justify-content:flex-end"><button @click="$emit('close')">关闭</button></div>
    </div>

    <!-- 同步前预检（v1.10.8）：按下去之前先把「要替用户发多少次请求、大概跑多久」摊开给他看。
         这些请求是拿用户的令牌、以用户本人的身份发出去的，他有权利在点下去之前知道量级 ——
         尤其是首次同步几十个会话时，那是一次上百个请求的批量操作。 -->
    <div v-if="confirming" class="modal-backdrop" style="z-index:60" @click.self="confirming = null">
      <div class="modal" style="width:min(560px,94vw)">
        <h3>同步前预检</h3>
        <div class="row" style="gap:8px; align-items:center; margin-bottom:10px">
          <b>{{ confirming.c.label || confirming.c.provider_name }}</b>
          <!-- ⚠️ 这里必须兜住 p 为 null：预估还在飞（loading）或预估失败（error）时 p 都是 null，
               而这一行在 v-if="confirming.loading" **之外**，直接读 p.since_days 会在渲染期抛
               「Cannot read properties of null (reading 'since_days')」。
               症状很迷惑：报错一闪而过，一秒后预检面板又正常出现（那时 p 已经有了）。 -->
          <span class="muted" style="font-size:12px">范围：最近 {{ confirming.p ? confirming.p.since_days : sinceDays }} 天</span>
        </div>

        <div v-if="confirming.loading" class="muted" style="font-size:13px">{{ confirming.progress || '正在估算…' }}</div>
        <div v-else-if="confirming.error" class="msg err">{{ confirming.error }}</div>

        <template v-else>
          <div class="muted" style="font-size:13px; line-height:1.9">
            <div>
              <b>{{ confirming.p.chats }}</b> 个会话：
              {{ confirming.p.incremental }} 个已有进度（只取新消息）、
              {{ confirming.p.initial }} 个首次同步（按最近 {{ confirming.p.since_days }} 天拉历史）。
            </div>
            <div>
              预计请求 <b>{{ confirming.p.est_requests_min }} ~ {{ confirming.p.est_requests_max }}</b> 次
              <span class="muted">（会话列表 1 次 + 每个会话至少 1 次；首次同步的会话最多每个翻 60 页 × 50 条）</span>
            </div>
            <div>
              预计耗时 <b>{{ fmtSec(confirming.p.est_seconds_min) }} ~ {{ fmtSec(confirming.p.est_seconds_max) }}</b>
              <span class="muted">（本工具每页之间固定等 {{ confirming.p.pace_ms }}ms）</span>
            </div>
          </div>

          <div v-if="confirming.c.provider === 'dingtalk'" class="muted" style="font-size:12px; line-height:1.8; margin-top:10px; border-top:1px solid var(--border); padding-top:10px">
            钉钉这条走官方 dws CLI 的 MCP 网关（共创阶段，官方未公布频控数字）。
            本工具是<b>串行</b>拉的、每页之间固定等 {{ confirming.p.pace_ms }}ms，尽量不碰上限；
            真被限流时该会话会带着「稍后再试」的提示落进失败列表，不会丢数据。
            <br><b>进度是按会话逐个记的</b>，被限流或中途关掉都不会丢，
            已经拉完的下次直接跳过、没拉完的从上次的位置接着拉，既不会重头再来，也不会重复落库。
          </div>
          <div v-else class="muted" style="font-size:12px; line-height:1.8; margin-top:10px; border-top:1px solid var(--border); padding-top:10px">
            飞书官方给这几个接口的上限是 <b>1000 次/分钟 且 50 次/秒</b>（读会话列表、读会话历史消息、
            换令牌都是这个数），维度是<b>每个接口 × 每个应用 × 每个租户</b>。
            本工具是<b>串行</b>拉的、每页之间固定等 {{ confirming.p.pace_ms }}ms，也就是约 <b>4.5 次/秒</b>，
            只有上限的十分之一左右。
            <br><b>超限不会封号</b> —— 官方文档里对超频的处置只有「拒绝这一轮请求」，回的是
            HTTP 429（旧接口 400）+ 业务码 99991400（消息类接口是 230020），等一会儿就能继续；
            封号/下架那套是「安全违规」规范，跟调用频率没关系。真撞上了，日志里会直接写出
            <b>官方建议等多少秒</b>（读响应头的 x-ogw-ratelimit-reset）。
            <br>更关键的是：<b>进度是按会话逐个记的</b>，被限流或中途关掉都不会丢，
            已经拉完的下次直接跳过、没拉完的从上次的位置接着拉，既不会重头再来，也不会重复落库。
          </div>
          <div v-if="!confirming.p.chats" class="msg err" style="margin-top:10px">
            这个连接器还没有登记任何会话。点「确定」会先拉一次会话列表（首次同步常见的一步），
            如果之前授权过但列表是空的，多半是官方接口没把单聊列出来 —— 那就在「会话」里手动填 ID。
          </div>
        </template>

        <div class="row" style="justify-content:flex-end; gap:8px; margin-top:14px">
          <button @click="confirming = null">取消</button>
          <button class="primary" :disabled="busy === confirming.c.id" @click="doSync()">
            {{ busy === confirming.c.id ? '同步中…' : '开始同步' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
// IM 连接器设置页（v1.10.5，需求③）：从笔记页右上角「IM连接」按钮打开。
// 这里只管「配置 + 触发授权 + 触发同步 + 看会话/日志」，真正的活儿全在服务端 imService.js。
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api, prefixUrl } from '../../api';

const emit = defineEmits(['close', 'open-note']); // eslint-disable-line no-unused-vars

const providers = ref([]);
const connectors = ref([]);
const err = ref('');
const msg = ref('');
const busy = ref(0);
const sinceDays = ref(30);
const open = ref({});        // id → 'chats' | 'logs'
const chatList = ref({});
const chatCount = ref({});
const chatAdd = ref({});
const logs = ref({});
const confirming = ref(null); // { c, loading, error, p } —— 同步前预检面板

const defaultRedirect = location.origin + prefixUrl('/api/im/callback');
const form = ref({ provider: 'feishu', label: '', app_id: '', app_secret: '', redirect_uri: defaultRedirect });
const curProvider = computed(() => providers.value.find((p) => p.key === form.value.provider));
// 钉钉走官方 CLI 设备流（扫码），新建表单里不出现应用凭证三件套
const isDeviceAuth = computed(() => (curProvider.value || {}).auth === 'device');

// ---------- 钉钉设备流登录（v1.10.22） ----------
// 面板状态 loginPanel[id] = { running, url, code, output, authenticated, errorText }；timer 每 2 秒打一次
// GET dingtalk-login（后端在「登录成功被看见」的那一刻把身份落库并回传最新连接器）。
const loginPanel = ref({});
const loginTimers = {};
function stopLoginTimer(id) {
  if (loginTimers[id]) { clearInterval(loginTimers[id]); delete loginTimers[id]; }
}
async function startLogin(c) {
  err.value = ''; msg.value = '';
  try {
    const r = await api.post(`/im/connectors/${c.id}/dingtalk-login`, {});
    if (!r.started && !r.already) { err.value = '登录没发起成功'; return; }
    loginPanel.value = { ...loginPanel.value, [c.id]: { running: true, url: '', code: '', output: '', authenticated: false } };
    stopLoginTimer(c.id);
    loginTimers[c.id] = setInterval(() => pollLogin(c), 2000);
    pollLogin(c);   // 立刻打一次，别让面板空转两秒才出链接
  } catch (e) { fail(e); }
}
async function pollLogin(c) {
  try {
    const p = await api.get(`/im/connectors/${c.id}/dingtalk-login`);
    loginPanel.value = { ...loginPanel.value, [c.id]: {
      running: p.running,
      url: p.url || (loginPanel.value[c.id] || {}).url || '',
      code: p.code || (loginPanel.value[c.id] || {}).code || '',
      output: p.output || '',
      authenticated: !!p.authenticated,
      errorText: p.errorText || '',
    } };
    if (!p.running) {
      stopLoginTimer(c.id);
      // 登录进程结束（成功/超时/取消）：面板停在结果态；成功则刷新整张卡。
      // 带原因的失败多停一会儿（15 秒）让人读完再收起，其余照旧 3 秒。
      if (p.authenticated) {
        msg.value = '钉钉登录成功，可以点「同步」开始归档了';
        await load();
      }
      setTimeout(() => {
        const cur = loginPanel.value[c.id];
        if (cur && !cur.running) loginPanel.value = { ...loginPanel.value, [c.id]: null };
      }, (!p.authenticated && p.errorText) ? 15000 : 3000);
    }
  } catch (e) {
    stopLoginTimer(c.id);
    loginPanel.value = { ...loginPanel.value, [c.id]: { running: false, url: '', code: '', output: '', authenticated: false } };
    fail(e);
  }
}
async function cancelLogin(c) {
  stopLoginTimer(c.id);
  try { await api.post(`/im/connectors/${c.id}/dingtalk-login/cancel`, {}); } catch { /* 进程可能已退 */ }
  loginPanel.value = { ...loginPanel.value, [c.id]: null };
}
onUnmounted(() => { for (const k of Object.keys(loginTimers)) stopLoginTimer(k); });

// 定时同步（v1.10.14）用到的两张表：周几的中文名 + 可选的拉取范围。
// 范围的口径要说清楚：**只对还没有游标的会话生效**（首次同步按这个天数回溯），
// 有游标的会话永远只取比游标新的 —— 所以「范围」不是每次重拉这么久，别让用户误以为会重拉。
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const DAY_RANGES = [
  { v: 7, label: '最近 7 天' }, { v: 30, label: '最近 30 天' }, { v: 90, label: '最近 90 天' },
  { v: 180, label: '最近半年' }, { v: 365, label: '最近一年' }, { v: 3650, label: '全部（尽量）' },
];

const fmtMs = (ms) => new Date(Number(ms)).toLocaleString('zh-CN', { hour12: false });
// 秒数说人话：不到 60 秒就报秒，超过就报「N 分 M 秒」——「约 720 秒」没人能一眼换算。
const fmtSec = (s) => {
  const n = Math.max(0, Math.round(Number(s) || 0));
  if (n < 1) return '不到 1 秒';
  if (n < 60) return `约 ${n} 秒`;
  const m = Math.floor(n / 60);
  return `约 ${m} 分 ${n % 60} 秒`;
};
/** 定时同步那一行的人话说明（把「哪天、几点、跑多大范围」连起来说一句）。 */
const autoHint = (c) => {
  const freq = (c.auto_freq || 'daily') === 'weekly'
    ? `每周${WEEKDAYS[Math.min(7, Math.max(1, Number(c.auto_weekday) || 1)) - 1]}`
    : '每天';
  const days = (DAY_RANGES.find((d) => d.v === Number(c.auto_days)) || {}).label || `最近 ${c.auto_days || 30} 天`;
  const body = `${freq} ${c.auto_time || '08:00'}（北京时间）自动跑一次；还没有进度的会话按「${days}」拉历史，已有进度的只取新消息。`;
  // 关着的时候说清两件事：①这些选项现在就能设好；②打开开关那一刻若今天这个点已经过去，
  // 会先补跑一次（这就是调度器的补跑语义，提前讲清楚，用户才不会以为「刚开就乱跑」）。
  return c.auto_sync ? body
    : `（还没开）打开开关后就按上面这套跑：${body}开关打开时若今天这个点已过，会先补跑一次。`;
};

const fail = (e) => { err.value = e.message || String(e); msg.value = ''; };

async function load() {
  try {
    providers.value = await api.get('/im/providers');
    connectors.value = await api.get('/im/connectors');
    for (const c of connectors.value) {
      try { chatCount.value[c.id] = (await api.get(`/im/connectors/${c.id}/chats`)).length; } catch { /* 忽略 */ }
    }
    if (!providers.value.length) providers.value = [{ key: 'feishu', name: '飞书', ready: true, hint: '' }];
  } catch (e) { fail(e); }
}
onMounted(load);

async function create() {
  err.value = ''; msg.value = '';
  const f = form.value;
  // 钉钉：设备流扫码，不需要应用凭证；飞书：三件套齐了才让建
  if ((curProvider.value || {}).auth === 'device') {
    if (!f.label.trim()) { err.value = '给这条钉钉连接器起个备注名（也是归档目录名）'; return; }
  } else if (!f.app_id || !f.app_secret) {
    err.value = 'App ID 和 App Secret 都要填';
    return;
  }
  try {
    await api.post('/im/connectors', { ...f });
    form.value = { ...form.value, label: '', app_id: '', app_secret: '' };
    msg.value = (curProvider.value || {}).auth === 'device'
      ? '连接器已添加，点「扫码登录钉钉」完成授权'
      : '连接器已添加，点「去授权」完成授权';
    await load();
  } catch (e) { fail(e); }
}

async function save(c, patch) {
  try { await api.put(`/im/connectors/${c.id}`, patch); await load(); } catch (e) { fail(e); }
}

async function authorize(c) {
  err.value = '';
  try {
    const r = await api.post(`/im/connectors/${c.id}/authorize`, {});
    window.open(r.url, '_blank', 'noopener');
    msg.value = '已在新窗口打开飞书授权页；同意之后回到这里点「刷新状态」';
  } catch (e) { fail(e); }
}

async function askSync(c) {
  err.value = ''; msg.value = '';
  confirming.value = { c, loading: true, error: '', p: null };
  try {
    const p = await api.get(`/im/connectors/${c.id}/sync-preview?since_days=${sinceDays.value}`);
    if (confirming.value && confirming.value.c.id === c.id) confirming.value = { c, loading: false, error: '', p };
  } catch (e) {
    if (confirming.value && confirming.value.c.id === c.id) confirming.value = { c, loading: false, error: e.message || String(e), p: null };
  }
}

// 同步：服务端一次只干 ~45 秒的活（生产站前面是 Cloudflare，回源请求约 100 秒就被掐成一张
// HTML 错误页 —— 首次同步几十个会话很容易超）。所以这里要**连着发多次**，每次都带上服务端
// 上一轮返回的 round，直到 done=true。累加各轮的数字，最后一次性报给用户。
async function doSync() {
  const c = confirming.value && confirming.value.c;
  if (!c) return;
  err.value = ''; msg.value = ''; busy.value = c.id;
  const acc = { chats: 0, messages: 0, notes: 0, errors: [], rounds: 0 };
  let round = '';
  try {
    for (let i = 0; i < 200; i++) {   // 上限 200 轮只是防死循环；正常一轮几十秒就结束
      const st = await api.postSlow(`/im/connectors/${c.id}/sync`, { since_days: sinceDays.value, round });
      acc.rounds++;
      acc.chats += st.chats || 0;
      acc.messages += st.messages || 0;
      acc.notes += st.notes || 0;
      if (st.errors && st.errors.length) acc.errors.push(...st.errors);
      round = st.round || round;
      if (st.done) break;
      confirming.value = {
        c, loading: true, error: '', p: (confirming.value && confirming.value.p) || null,
        progress: `已处理 ${acc.chats} 个会话，还剩 ${st.remaining} 个…`,
      };
    }
    confirming.value = null;
    msg.value = `同步完成：${acc.chats} 个会话，新增 ${acc.messages} 条消息${acc.notes ? `，新建 ${acc.notes} 篇笔记` : ''}`
      + (acc.errors.length ? `；${acc.errors.length} 个会话失败（看日志）` : '');
    await load();
    if (open.value[c.id] === 'chats') await loadChats(c);
  } catch (e) { fail(e); } finally { busy.value = 0; }
}

async function loadChats(c) {
  try { chatList.value[c.id] = await api.get(`/im/connectors/${c.id}/chats`); chatCount.value[c.id] = chatList.value[c.id].length; } catch (e) { fail(e); }
}
async function loadLogs(c) {
  try { logs.value[c.id] = await api.get(`/im/connectors/${c.id}/logs`); } catch (e) { fail(e); }
}
async function toggle(c, what) {
  if (open.value[c.id] === what) { open.value = { ...open.value, [c.id]: '' }; return; }
  open.value = { ...open.value, [c.id]: what };
  if (what === 'chats') await loadChats(c); else await loadLogs(c);
}

async function addChat(c) {
  const id = (chatAdd.value[c.id] || '').trim();
  if (!id) return;
  try {
    chatList.value[c.id] = await api.post(`/im/connectors/${c.id}/chats`, { chat_id: id });
    chatCount.value[c.id] = chatList.value[c.id].length;
    chatAdd.value[c.id] = '';
  } catch (e) { fail(e); }
}

async function removeChat(c, ch) {
  if (!confirm(`从连接器里移除会话「${ch.chat_name || ch.chat_id}」？\n（已导出的笔记不会删）`)) return;
  try {
    await api.del(`/im/chats/${ch.id}`);
    await loadChats(c);
  } catch (e) { fail(e); }
}

async function refresh(c) { msg.value = ''; err.value = ''; try { await api.get(`/im/connectors/${c.id}/logs`); } catch { /* 只为了触发一次服务端状态读取 */ } await load(); }

async function revoke(c) {
  if (!confirm(`解除「${c.label || c.provider_name}」的授权？\n令牌会被删掉，已经导出的笔记不受影响；想继续同步重新授权即可。`)) return;
  try { await api.post(`/im/connectors/${c.id}/revoke`, {}); await load(); } catch (e) { fail(e); }
}

async function del(c) {
  if (!confirm(`删除连接器「${c.label || c.provider_name}」？\n令牌与会话游标一起删掉；已经导出的笔记保留。`)) return;
  try { await api.del(`/im/connectors/${c.id}`); await load(); } catch (e) { fail(e); }
}
</script>

<style scoped>
/* 定时同步那一行。⚠️ 全局 style.css 里有一条 `input, textarea, select { width: 100% }`，
   它连 checkbox 一起管 —— 不给 checkbox 写死 width:auto，勾选框会被撑成整行、
   把标签顶到下面去（这是 v1.10.0 踩过的同一个坑）。所以这里每条都给了明确宽度。 */
.sched {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border);
}
.sched .chk {
  display: flex; align-items: center; gap: 5px; font-size: 12.5px;
  white-space: nowrap; cursor: pointer;
}
.sched .chk input { width: auto; padding: 0; }
/* 关着的时候只把控件稍微压暗，**不是藏起来** —— 用户要先看得见才能设 */
.sched.off select, .sched.off input[type="time"] { opacity: .62; }
/* 「新消息排在最上面」那一行（v1.10.18）。跟上面同一个坑：checkbox 必须写死 width:auto */
.ord { margin-top: 8px; }
.ord .chk {
  display: flex; align-items: center; gap: 5px; font-size: 12.5px;
  cursor: pointer;
}
.ord .chk input { width: auto; padding: 0; }
/* 钉钉设备流登录面板：浅底一块，CLI 的进度原文用等宽小字滚着看 */
.loginbox {
  margin-top: 8px; padding: 10px; border-radius: 8px;
  background: var(--bg2, rgba(0,0,0,.04)); border: 1px dashed var(--border);
  display: flex; flex-direction: column; gap: 6px;
}
.loginbox a { color: var(--blue, #3370ff); }
.loginlog {
  margin: 0; max-height: 110px; overflow-y: auto; font-size: 11px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-all; color: var(--muted, #888);
  font-family: ui-monospace, Consolas, monospace;
}
/* 登录失败原因：红底亮出来（从 CLI 输出里挖的可执行原因，如「组织未开 CLI 访问权限」） */
.loginerr {
  font-size: 12.5px; line-height: 1.55; color: var(--red, #d93025);
  background: rgba(217, 48, 37, .07); border: 1px solid rgba(217, 48, 37, .28);
  border-radius: 6px; padding: 8px 10px; word-break: break-all; white-space: pre-wrap;
}
</style>
