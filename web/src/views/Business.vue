<template>
  <!-- 推送任务（原「业务系统」独立页，2026-09 v1.7.0 并入效率工具页 tab；标题栏由外层 Tools 页提供） -->
  <div>
    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>

    <div class="tabs">
      <button v-if="canTab('tools','sys')" :class="{active: tab==='sys'}" @click="tab='sys'">业务系统</button>
      <button v-if="canTab('tools','skill')" :class="{active: tab==='skill'}" @click="tab='skill'">Skill 任务</button>
      <button v-if="canTab('tools','push')" :class="{active: tab==='push'}" @click="tab='push'">推送记录</button>
      <button v-if="canTab('tools','config')" :class="{active: tab==='config'}" @click="tab='config'; loadSchedules()">定时配置</button>
    </div>

    <!-- ============ 业务系统 ============ -->
    <template v-if="tab==='sys'">
      <div class="card" style="margin-bottom:12px">
        <h3>连接公司业务系统</h3>
        <div class="row" style="flex-wrap:wrap; margin-bottom:8px">
          <input v-model="sys.name" placeholder="系统名称（如：ERP / OA）" class="grow" />
          <input v-model="sys.url" placeholder="系统地址（https://...）" class="grow" />
        </div>
        <div class="row" style="flex-wrap:wrap; margin-bottom:8px">
          <select v-model="sys.type" style="width:130px">
            <option value="web">网页系统</option>
            <option value="api">API 服务</option>
          </select>
          <input v-model="sys.token" placeholder="API Token（可选，Bearer 认证）" class="grow" />
        </div>
        <div class="row" style="flex-wrap:wrap; margin-bottom:8px">
          <input v-model="sys.username" placeholder="用户名（可选，Basic 认证）" class="grow" />
          <input v-model="sys.password" type="password" :placeholder="editingSys ? '留空保持不变' : '密码（加密存储）'" class="grow" />
        </div>
        <div class="row" style="flex-wrap:wrap">
          <input v-model="sys.description" placeholder="说明（可选）" class="grow" />
          <button class="primary" @click="saveSys">{{ editingSys ? '保存修改' : '添加系统' }}</button>
          <button v-if="editingSys" @click="cancelEdit">取消</button>
        </div>
        <div class="muted" style="margin-top:8px">API 类型系统支持凭据代理调用与 Skill 任务（自动携带 Token / Basic 认证）。</div>
      </div>

      <div class="grid g2">
        <div v-for="s in systems" :key="s.id" class="card">
          <h3>
            <span>{{ s.name }}</span>
            <span class="badge" :class="s.type==='web' ? 'blue' : 'amber'">{{ s.type==='web' ? '网页' : 'API' }}</span>
          </h3>
          <div class="muted" style="margin-bottom:10px; word-break:break-all">{{ s.url }}</div>
          <div class="d muted" style="margin-bottom:6px">
            {{ s.description }}
            <template v-if="s.username"> · 账号：{{ s.username }}（密码已加密存储）</template>
          </div>
          <div class="row" style="margin-top:12px; flex-wrap:wrap">
            <a v-if="s.url" :href="s.url" target="_blank" rel="noopener" class="primary" style="text-decoration:none; padding:6px 13px; border-radius:8px; font-size:13px">打开系统</a>
            <button class="small" @click="editSys(s)">编辑</button>
            <button v-if="s.type==='api'" class="small" @click="openProxy(s)">代理调用</button>
            <button class="danger small" @click="delSys(s)">删除</button>
          </div>
        </div>
        <div v-if="!systems.length" class="card empty">尚未添加业务系统</div>
      </div>
    </template>

    <!-- ============ Skill 任务 ============ -->
    <template v-else-if="tab==='skill'">
      <div class="card" style="margin-bottom:12px">
        <h3>新增 Skill（引导词任务）</h3>
        <div class="muted" style="margin-bottom:10px">
          在 AI 助手中输入「引导词」即执行该系统对应任务；配置 cron（如 <code>0 9 * * *</code>）可定时执行，结果自动写入「今日待办」。
        </div>
        <div class="row" style="flex-wrap:wrap; margin-bottom:8px">
          <select v-model="sk.system_id" style="width:170px">
            <option :value="null" disabled>选择业务系统</option>
            <option v-for="s in systems" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <input v-model="sk.name" placeholder="引导词 / 名称（如：今日订单汇总）" class="grow" />
        </div>
        <textarea v-model="sk.prompt" rows="3" placeholder="任务指令（写给 AI 的执行要求，如：汇总今日新增订单数量与金额，按客户分组）" style="margin-bottom:8px"></textarea>
        <div class="row" style="flex-wrap:wrap; margin-bottom:8px">
          <input v-model="sk.request_path" placeholder="数据接口路径（可选，如 /api/orders/today）" class="grow" />
          <input v-model="sk.cron" placeholder="定时 cron（可选，如 0 9 * * *）" style="width:180px" />
        </div>
        <label class="row" style="margin-bottom:8px; cursor:pointer; gap:6px; align-items:center">
          <input type="checkbox" v-model="sk.local_format" style="width:auto" />
          <span>本地整理（<b>不调用 AI</b>）：抓取/接口数据直接排成 Markdown 表格，零算力消耗、结果确定性；适合"取数列表"类任务</span>
        </label>
        <div class="row">
          <button class="primary" @click="saveSkill">{{ editingSkill ? '保存修改' : '保存 Skill' }}</button>
          <button v-if="editingSkill" @click="cancelSkillEdit">取消</button>
          <span class="muted">保存后定时任务自动生效；修改后会重建全部定时器</span>
        </div>
      </div>

      <div v-if="!systems.length" class="card empty">请先在上方添加业务系统</div>

      <div v-for="s in systems" :key="s.id" style="margin-bottom:16px">
        <h3 style="margin-bottom:8px; font-size:14px">{{ s.name }} <span class="badge blue">{{ skillsOf(s.id).length }} 个 Skill</span></h3>
        <div v-if="skillsOf(s.id).length">
          <div v-for="k in skillsOf(s.id)" :key="k.id" class="skill-item">
            <div class="bar">
              <b>{{ k.name }}</b>
              <span class="badge" :class="k.enabled ? 'green' : ''">{{ k.enabled ? '已启用' : '已停用' }}</span>
              <span class="badge" v-if="k.cron">定时：{{ k.cron }}</span>
              <span class="badge blue" v-if="k.request_path">接口：{{ k.request_path }}</span>
              <span class="badge" v-if="recipeOf(k)">浏览器抓取配方</span>
              <span class="badge green" v-if="k.local_format">本地整理（无 AI）</span>
              <span class="badge amber" v-if="k.last_ai_model">AI：{{ k.last_ai_model }} · {{ k.last_ai_tokens }} tokens</span>
              <span class="muted" v-if="k.last_run_at">上次执行 {{ k.last_run_at?.slice(0,16) }}</span>
            </div>
            <div class="d muted" style="margin-top:6px">指令：{{ k.prompt || '（无）' }}</div>
            <div v-if="k.last_result" class="email-body" style="max-height:24vh">{{ k.last_result }}</div>
            <!-- 抓取过程可视化：browser_recipe 全景（登录→步骤→提取）+ 执行链路说明 -->
            <div v-if="recipeOf(k)" style="margin-top:10px">
              <button class="small" @click="toggleRecipe(k.id)">{{ openRecipe === k.id ? '收起抓取配方 ▲' : '查看抓取配方 ▼' }}</button>
              <div v-if="openRecipe === k.id" class="recipe-box">
                <div class="muted small" style="margin-bottom:8px">
                  执行链路：<b>Playwright 无头浏览器</b>（server/services/browserSkillService.js）按下面配方操作页面抓取 →
                  结构化数据存本页「推送记录」+ 飞书表格卡片 → 勾选「本地整理」的 Skill 到此为止（数据直接本地排表，全程无 AI），
                  未勾选的才把数据交给 AI（指令栏的提示词）整理文字，结果尾部会标注<b>所用模型与 token 消耗</b>（列表上方黄色徽章同步显示）。抓取本身不依赖 AI。
                </div>
                <div v-if="recipeOf(k).custom" class="recipe-sec">
                  <b class="small">⚙ 自定义流程</b> <span class="badge amber">{{ recipeOf(k).custom }}</span>
                  <span class="muted small">（代码级流程：server/services/browserSkillService.js 内 runKingdeeSaleList 等函数）</span>
                  <ol v-if="recipeOf(k).steps" class="step-list">
                    <li v-for="(st, i) in recipeOf(k).steps" :key="i">{{ st }}</li>
                  </ol>
                </div>
                <div class="recipe-sec">
                  <b class="small">🔐 登录配方</b>
                  <div v-if="recipeOf(k).login && !recipeOf(k).login.skipStandard" class="kv">
                    <span>账号输入框</span><code>{{ recipeOf(k).login.userSelector }}</code>
                    <span>密码输入框</span><code>{{ recipeOf(k).login.passSelector }}</code>
                    <span>登录按钮</span><code>{{ recipeOf(k).login.submitSelector }}</code>
                    <span v-if="recipeOf(k).postLoginUrl">登录后跳转</span><code v-if="recipeOf(k).postLoginUrl">{{ recipeOf(k).postLoginUrl }}</code>
                  </div>
                  <div v-else class="muted small">（该流程登录由自定义代码处理）</div>
                </div>
                <div class="recipe-sec" v-if="(recipeOf(k).actions || []).length">
                  <b class="small">🧭 页面操作步骤</b>
                  <ol class="step-list">
                    <li v-for="(a, i) in recipeOf(k).actions" :key="i">
                      <template v-if="a.wait">等待 {{ a.wait }}ms（页面加载）</template>
                      <template v-else-if="a.ensureSwitchOn">确保开关「{{ a.ensureSwitchOn }}」打开</template>
                      <template v-else-if="a.click">点击 {{ a.click }}</template>
                      <template v-else-if="a.fill">填入 {{ JSON.stringify(a.fill) }}</template>
                      <template v-else>{{ JSON.stringify(a) }}</template>
                    </li>
                  </ol>
                </div>
                <div class="recipe-sec" v-if="recipeOf(k).extract">
                  <b class="small">📊 数据提取规则</b>
                  <div class="kv">
                    <span>提取方式</span><code>{{ recipeOf(k).extract.type }}</code>
                    <span>行选择器</span><code>{{ recipeOf(k).extract.rowSelector }}</code>
                    <span v-if="recipeOf(k).extract.emptyCol !== undefined">过滤条件</span>
                    <code v-if="recipeOf(k).extract.emptyCol !== undefined">第 {{ recipeOf(k).extract.emptyCol + 1 }} 列为空的行 = 品牌汇总行</code>
                    <span v-if="recipeOf(k).extract.maxRows">最多行数</span><code v-if="recipeOf(k).extract.maxRows">{{ recipeOf(k).extract.maxRows }}</code>
                  </div>
                  <div v-if="recipeOf(k).extract.colNames" class="small" style="margin-top:6px">
                    输出列：<span v-for="(c, i) in recipeOf(k).extract.colNames" :key="i" class="badge blue" style="margin:1px 2px">{{ c }}</span>
                  </div>
                </div>
                <details style="margin-top:8px">
                  <summary class="muted small" style="cursor:pointer">原始配方 JSON（可复制备份）</summary>
                  <pre class="recipe-json">{{ JSON.stringify(recipeOf(k), null, 2) }}</pre>
                </details>
              </div>
            </div>
            <div class="row" style="margin-top:8px">
              <button class="primary small" @click="runSkill(k)" :disabled="runningId===k.id">{{ runningId===k.id ? '执行中...' : '立即执行' }}</button>
              <button class="small" @click="toggleSkill(k)">{{ k.enabled ? '停用' : '启用' }}</button>
              <button class="small" @click="editSkill(k)">编辑</button>
              <button class="danger small" @click="delSkill(k)">删除</button>
            </div>
          </div>
        </div>
        <div v-else class="card muted" style="padding:10px">该系统还没有 Skill，在上方添加一个（引导词任务）</div>
      </div>
    </template>

    <!-- ============ 推送记录（原「AI 推送」页） ============ -->
    <template v-else-if="tab==='push'">
      <div class="row" style="margin-bottom:14px; gap:8px; flex-wrap:wrap">
        <span class="muted" style="font-size:13px; align-self:center">业务系统：</span>
        <button v-for="s in pushSystems" :key="s.id" :class="{ primary: s.id === curPushSys }" @click="selectPushSys(s.id)">
          {{ s.name }} <span class="muted" style="font-size:11px">({{ s.push_count }})</span>
        </button>
        <span v-if="!pushSystems.length" class="muted">暂无业务系统</span>
      </div>
      <div v-if="pushLoading" class="muted">加载中...</div>
      <div v-else-if="!pushes.length" class="card empty">该系统暂无推送记录。</div>
      <div v-for="p in pushes" :key="p.id" class="card" style="margin-bottom:14px">
        <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px">
          <b style="font-size:14px">{{ p.skill_name }}</b>
          <span class="muted" style="font-size:12px">{{ p.created_at }}</span>
        </div>
        <div style="overflow-x:auto">
          <table class="push-table">
            <thead><tr><th v-for="(c, i) in p.columns" :key="i">{{ c }}</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in p.rows" :key="i" :class="{ total: String(r[0]) === '合计' }">
                <td v-for="(cell, j) in r" :key="j">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ============ 定时配置（原「AI 推送」页） ============ -->
    <template v-else-if="tab==='config'">
      <!-- Skill 自带 cron 的定时（推送到全部已配置的飞书会话） -->
      <div class="card" style="margin-bottom:14px">
        <h3>Skill 自带定时</h3>
        <div class="muted" style="margin-bottom:10px; font-size:12.5px">这些是各 Skill 在本页「Skill 任务」tab 配置的 cron，到点自动执行并推送到<b>全部已配置的飞书会话</b>。新增 / 修改引导词请切换到 <a @click="tab='skill'" style="cursor:pointer">Skill 任务</a> tab。</div>
        <div v-if="!skillCrons.length" class="muted" style="font-size:12.5px">暂无 Skill 配置了自带定时。</div>
        <div v-for="sk in skillCrons" :key="'sk' + sk.id" style="padding:8px 0; border-top:1px solid var(--border)">
          <div class="row" style="justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px">
            <div>
              <b>{{ sk.system_name }} · {{ sk.name }}</b>
              <span class="badge blue" style="margin-left:8px; font-size:11px" :title="sk.cron">{{ cronLabel(sk.cron) }}</span>
              <span class="muted" style="margin-left:8px; font-size:11px">cron: {{ sk.cron }}</span>
              <span v-if="!sk.enabled" class="badge" style="margin-left:4px; font-size:11px">已停用</span>
            </div>
            <div class="row" style="gap:6px">
              <span class="muted" style="font-size:11px">{{ sk.last_run_at ? '上次: ' + sk.last_run_at : '未执行' }}</span>
              <button class="small" @click="toggleCronSkill(sk)">{{ sk.enabled ? '停用' : '启用' }}</button>
              <button class="small" @click="runSkillNow(sk)" :disabled="skillRunning === sk.id">{{ skillRunning === sk.id ? '执行中...' : '立即执行' }}</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <h3>新增定时推送（指定会话）</h3>
        <div class="muted" style="margin-bottom:10px; font-size:12.5px">配置哪个 Skill 在什么时间推送到哪个飞书会话（群或个人）。与 Skill 自身的 cron 独立。</div>
        <div class="row" style="flex-wrap:wrap; gap:8px; align-items:flex-end">
          <div class="form-row" style="flex:1; min-width:200px">
            <label>Skill</label>
            <select v-model="newSched.skill_id" style="width:100%">
              <option value="">选择 Skill</option>
              <option v-for="s in allSkills" :key="s.id" :value="s.id">{{ s.system_name }} · {{ s.name }}</option>
            </select>
          </div>
          <div class="form-row" style="flex:1; min-width:180px">
            <label>推送目标</label>
            <select v-model="newSched.feishu_target" style="width:100%">
              <option value="">选择飞书会话</option>
              <option v-for="t in feishuTargets" :key="t.value" :value="t.value">{{ t.label }}</option>
            </select>
          </div>
        </div>
        <div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--border)">
          <b style="font-size:13px">推送时间</b>
          <div class="row" style="flex-wrap:wrap; gap:8px; margin-top:6px; align-items:flex-end">
            <div class="form-row" style="flex:0 0 100px">
              <label>类型</label>
              <select v-model="timeType" style="width:100%">
                <option value="daily">每天</option>
                <option value="weekdays">周一至周五</option>
                <option value="weekly">每周（自选星期）</option>
                <option value="monthly">每月</option>
                <option value="custom">自定义cron</option>
              </select>
            </div>
            <!-- 每周：选星期几（多选按钮）——按国家工作日历时推送日由日历决定，隐藏手选 -->
            <div v-if="timeType === 'weekly' && holidayMode !== 'workday'" style="flex:1; min-width:300px">
              <div class="row" style="justify-content:space-between; margin-bottom:4px">
                <label style="font-size:12.5px; color:var(--text2)">星期（可多选）</label>
                <button class="small" @click="selectWeekdays" style="font-size:11px; padding:2px 6px">工作日</button>
              </div>
              <div class="row" style="flex-wrap:wrap; gap:4px">
                <button v-for="d in weekDays" :key="d.v" class="small" :class="{ primary: dowSel.includes(d.v) }" @click="toggleDow(d.v)">{{ d.t }}</button>
              </div>
            </div>
            <!-- 每月：选几号（多选按钮） -->
            <div v-if="timeType === 'monthly' && holidayMode !== 'workday'" style="flex:1; min-width:300px">
              <div class="row" style="justify-content:space-between; margin-bottom:4px">
                <label style="font-size:12.5px; color:var(--text2)">日期（可多选）</label>
                <div class="row" style="gap:4px">
                  <button class="small" @click="selectAllDays" style="font-size:11px; padding:2px 6px">全选</button>
                  <button class="small" @click="clearDom" style="font-size:11px; padding:2px 6px">清空</button>
                </div>
              </div>
              <div class="row" style="flex-wrap:wrap; gap:3px">
                <button v-for="d in 31" :key="d" class="small" :class="{ primary: domSel.includes(d) }" style="min-width:36px; padding:3px 6px" @click="toggleDom(d)">{{ d }}</button>
              </div>
            </div>
            <!-- 时间：几点几分 -->
            <div v-if="timeType !== 'custom'" class="row" style="gap:6px; align-items:flex-end">
              <div class="form-row" style="flex:0 0 80px">
                <label>时</label>
                <select v-model="timeHour" style="width:100%">
                  <option v-for="h in 24" :key="h-1" :value="String(h-1).padStart(2,'0')">{{ String(h-1).padStart(2,'0') }}</option>
                </select>
              </div>
              <span style="padding-bottom:8px">:</span>
              <div class="form-row" style="flex:0 0 80px">
                <label>分</label>
                <select v-model="timeMin" style="width:100%">
                  <option v-for="m in [0,5,10,15,20,25,30,35,40,45,50,55]" :key="m" :value="String(m).padStart(2,'0')">{{ String(m).padStart(2,'0') }}</option>
                </select>
              </div>
            </div>
            <!-- 自定义cron -->
            <div v-if="timeType === 'custom'" class="form-row grow">
              <label>cron 表达式</label>
              <input v-model="timeCron" placeholder="分 时 日 月 周 如 0 9 * * 1-5" style="width:100%" />
            </div>
            <button class="primary" @click="addSchedule">＋ 添加</button>
          </div>
          <!-- 节假日门控：到点后按日历判断当日是否推送（自定义 cron 同样生效） -->
          <div class="row" style="flex-wrap:wrap; gap:8px; margin-top:8px; align-items:flex-end">
            <div class="form-row" style="flex:0 0 200px">
              <label>节假日</label>
              <select v-model="holidayMode" style="width:100%">
                <option value="">不判断（照常推送）</option>
                <option value="skip">法定节假日不推送</option>
                <option value="workday">按国家工作日历</option>
              </select>
            </div>
            <div class="muted" style="font-size:11.5px; flex:1; min-width:240px; padding-bottom:6px">
              数据源跟随「系统设置 → 节假日」（timor.tech / apizero.cn）。<template v-if="holidayMode === 'workday'">按国家工作日历：法定节假日不推、周末调休补班日照常推（此时星期/日期选择不生效，推送日由日历决定）；</template>日历拉取失败时按无日历处理。
            </div>
          </div>
          <div class="muted" style="font-size:12px; margin-top:6px">
            预览：<b>{{ cronPreview }}</b>
          </div>
        </div>
        <div v-if="feishuChats.length" class="row" style="flex-wrap:wrap; gap:6px; margin-top:8px">
          <span class="muted" style="font-size:12px; align-self:center">点选群加入目标 →</span>
          <button v-for="c in feishuChats" :key="c.chat_id" class="small" @click="newSched.feishu_target = JSON.stringify({ receive_id_type: 'chat_id', receive_id: c.chat_id, name: c.name })">＋ {{ c.name }}</button>
          <button class="small" @click="loadFeishuChats">列出群</button>
        </div>
        <div class="muted" style="font-size:11.5px; margin-top:6px">cron 格式：分 时 日 月 周。常用：`0 9 * * 1-5` 工作日9点 | `0 9 * * *` 每天9点 | `30 8 * * *` 每天8:30</div>
      </div>

      <div v-if="schedules.length" class="muted" style="font-size:12.5px; margin:14px 0 8px">以下为独立推送配置（推送到指定会话，与上方 Skill 自带定时互不影响）：</div>
      <div v-if="!schedules.length" class="card empty">暂无独立推送配置（上方的「Skill 自带定时」不受影响，照常执行）</div>
      <div v-for="sc in schedules" :key="sc.id" class="card" style="margin-bottom:10px">
        <div class="row" style="justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px">
          <div>
            <b>{{ sc.system_name }} · {{ sc.skill_name }}</b>
            <span class="muted" style="font-size:12px; margin-left:8px">→ {{ sc.feishu_target_name || '已配置会话' }}</span>
            <span class="badge blue" style="margin-left:8px; font-size:11px" :title="sc.cron">{{ cronLabel(sc.cron) }}</span>
            <span v-if="sc.holiday_mode" class="badge" style="margin-left:4px; font-size:11px" :title="sc.holiday_mode === 'workday' ? '数据源跟随系统设置「节假日」：法定节假日不推、调休补班日照推' : '数据源跟随系统设置「节假日」：法定节假日不推送'">{{ sc.holiday_mode === 'workday' ? '按工作日历' : '节假日不推' }}</span>
            <span v-if="!sc.enabled" class="badge" style="margin-left:4px; font-size:11px">已停用</span>
          </div>
          <div class="row" style="gap:6px">
            <span class="muted" style="font-size:11px">{{ sc.last_run_at ? '上次: ' + sc.last_run_at : '未执行' }}</span>
            <button class="small" @click="toggleSched(sc)">{{ sc.enabled ? '停用' : '启用' }}</button>
            <button class="small" @click="runSchedNow(sc)" :disabled="schedRunning === sc.id">{{ schedRunning === sc.id ? '执行中...' : '立即执行' }}</button>
            <button class="icon-btn" @click="removeSched(sc)">✕</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import { api } from '../api';
import { canTab, firstTab } from '../tabs';

const tab = ref(firstTab('tools', 'sys'));
const msg = ref('');
const msgType = ref('ok');
function flash(text, type = 'ok') { msg.value = text; msgType.value = type; setTimeout(() => (msg.value = ''), 4000); }

// ---------- 业务系统 / Skill 任务 ----------
const systems = ref([]);
const skills = ref([]);
const sys = ref({ name: '', url: '', type: 'web', token: '', username: '', password: '', description: '' });
const editingSys = ref(null);
const sk = ref({ system_id: null, name: '', prompt: '', request_path: '', cron: '', enabled: 1, local_format: 0 });
const editingSkill = ref(null);
const runningId = ref(null);

function skillsOf(sid) { return skills.value.filter((k) => k.system_id === sid); }

// ---------- 抓取配方可视化 ----------
const openRecipe = ref(0);
function toggleRecipe(id) { openRecipe.value = openRecipe.value === id ? 0 : id; }
function recipeOf(k) {
  if (!k.browser_recipe) return null;
  try { return JSON.parse(k.browser_recipe); } catch { return null; }
}

async function load() {
  // 各数据源独立容错：无对应 tab 权限时接口 403，不能拖垮其他 tab
  try { systems.value = await api.get('/business'); } catch { systems.value = []; }
  try { skills.value = await api.get('/business/skills'); } catch { skills.value = []; }
}

async function saveSys() {
  if (!sys.value.name.trim()) return;
  if (editingSys.value) {
    await api.put(`/business/${editingSys.value.id}`, sys.value);
    editingSys.value = null;
  } else {
    await api.post('/business', sys.value);
  }
  sys.value = { name: '', url: '', type: 'web', token: '', username: '', password: '', description: '' };
  await load();
}
function editSys(s) {
  editingSys.value = s;
  sys.value = { ...s, password: '' };
}
function cancelEdit() {
  editingSys.value = null;
  sys.value = { name: '', url: '', type: 'web', token: '', username: '', password: '', description: '' };
}
async function delSys(s) {
  if (!confirm(`删除系统「${s.name}」及其全部 Skill？`)) return;
  await api.del(`/business/${s.id}`);
  await load();
}

async function openProxy(s) {
  const path = prompt(`向 ${s.name} 代理请求（输入接口路径，如 /api/data）`);
  if (!path) return;
  try {
    const r = await api.post(`/business/${s.id}/proxy`, { path, method: 'GET' });
    alert(`状态 ${r.status}\n\n${(r.body || '').slice(0, 2000)}`);
  } catch (e) { alert('代理失败：' + e.message); }
}

async function saveSkill() {
  if (!sk.value.system_id) { alert('请先选择业务系统'); return; }
  if (!sk.value.name.trim()) { alert('请填写引导词 / 名称'); return; }
  await api.post('/business/skills', { ...sk.value, id: editingSkill.value?.id, enabled: 1 });
  sk.value = { system_id: sk.value.system_id, name: '', prompt: '', request_path: '', cron: '', enabled: 1, local_format: 0 };
  editingSkill.value = null;
  await load();
  flash('Skill 已保存，定时任务已生效');
}
function editSkill(k) {
  editingSkill.value = k;
  sk.value = { system_id: k.system_id, name: k.name, prompt: k.prompt, request_path: k.request_path, cron: k.cron, enabled: k.enabled, local_format: k.local_format ? 1 : 0 };
}
function cancelSkillEdit() {
  editingSkill.value = null;
  sk.value = { system_id: null, name: '', prompt: '', request_path: '', cron: '', enabled: 1, local_format: 0 };
}
async function toggleSkill(k) {
  await api.put(`/business/skills/${k.id}`, { ...k, enabled: k.enabled ? 0 : 1 });
  await load();
}
async function delSkill(k) {
  if (!confirm(`删除 Skill「${k.name}」？`)) return;
  await api.del(`/business/skills/${k.id}`);
  await load();
}
async function runSkill(k) {
  runningId.value = k.id;
  try {
    const r = await api.post(`/business/skills/${k.id}/run`);
    alert(`「${k.name}」执行完成：\n\n` + r.result.slice(0, 300));
    await load();
  } catch (e) {
    alert('执行失败：' + e.message);
  } finally {
    runningId.value = null;
  }
}

// ---------- 推送记录（原「AI 推送」页） ----------
const pushSystems = ref([]);
const curPushSys = ref(0);
const pushes = ref([]);
const pushLoading = ref(false);

async function loadPushSystems() {
  try {
    const d = await api.get('/pushes/systems');
    pushSystems.value = d.systems || [];
    if (pushSystems.value.length) await selectPushSys(pushSystems.value[0].id);
  } catch (e) { /* 忽略 */ }
}
async function selectPushSys(id) {
  curPushSys.value = id;
  pushLoading.value = true;
  try { const d = await api.get(`/pushes?system_id=${id}`); pushes.value = d.pushes || []; }
  catch (e) { pushes.value = []; }
  finally { pushLoading.value = false; }
}

// ---------- 定时配置（原「AI 推送」页） ----------
const schedules = ref([]);
const allSkills = ref([]);
const feishuTargets = ref([]);
const feishuChats = ref([]);
const schedRunning = ref(0);
const newSched = ref({ skill_id: '', feishu_target: '', cron: '0 9 * * 1-5' });
// 时间选择器
const timeType = ref('daily');   // daily / weekdays / weekly / monthly / custom
const timeHour = ref('09');      // 时
const timeMin = ref('00');       // 分
const timeCron = ref('0 9 * * 1-5'); // 自定义
// 节假日门控：''=不判断 | 'skip'=法定节假日不推送 | 'workday'=按国家工作日历（补班日照推）
const holidayMode = ref('');

// 星期多选
const weekDays = [
  { v: '1', t: '周一' }, { v: '2', t: '周二' }, { v: '3', t: '周三' }, { v: '4', t: '周四' },
  { v: '5', t: '周五' }, { v: '6', t: '周六' }, { v: '0', t: '周日' },
];
const dowSel = ref(['1', '2', '3', '4', '5']); // 默认工作日
function toggleDow(v) {
  const i = dowSel.value.indexOf(v);
  if (i >= 0) dowSel.value.splice(i, 1);
  else dowSel.value.push(v);
}
// 日期多选
const domSel = ref([1]);
function toggleDom(d) {
  const i = domSel.value.indexOf(d);
  if (i >= 0) domSel.value.splice(i, 1);
  else domSel.value.push(d);
}
// 快捷按钮
function selectWeekdays() { dowSel.value = ['1','2','3','4','5']; }
function selectAllDays() { domSel.value = Array.from({length:31},(_,i)=>i+1); }
function clearDom() { domSel.value = []; }

// 根据选择生成 cron
function buildCron() {
  if (timeType.value === 'custom') return timeCron.value;
  const m = Number(timeMin.value);
  const h = Number(timeHour.value);
  // 按国家工作日历：推送日由日历在到点时判断（周一至五非节假日 ∪ 调休补班日），cron 按每天注册
  if (holidayMode.value === 'workday') return `${m} ${h} * * *`;
  if (timeType.value === 'daily') return `${m} ${h} * * *`;
  if (timeType.value === 'weekdays') return `${m} ${h} * * 1-5`;
  if (timeType.value === 'weekly') {
    if (!dowSel.value.length) return '';
    return `${m} ${h} * * ${dowSel.value.sort().join(',')}`;
  }
  if (timeType.value === 'monthly') {
    if (!domSel.value.length) return '';
    return `${m} ${h} ${domSel.value.sort((a,b)=>a-b).join(',')} * *`;
  }
  return `${m} ${h} * * *`;
}
// cron 转中文描述
function cronLabel(cronStr) {
  if (!cronStr) return '';
  const parts = cronStr.trim().split(/\s+/);
  if (parts.length !== 5) return cronStr;
  const [m, h, dom, , dow] = parts;
  const time = `${String(Number(h)).padStart(2,'0')}:${String(Number(m)).padStart(2,'0')}`;
  const dowNames = { '0': '日', '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六' };
  if (dom !== '*') {
    const days = dom.split(',').map(Number).sort((a,b)=>a-b).join('、');
    return `每月${days}号 ${time}`;
  }
  if (dow !== '*') {
    const dows = dow.split(',');
    if (dows.length === 7) return `每天 ${time}`;
    if (dow === '1-5') return `工作日 ${time}`;
    return `周${dows.map(d => dowNames[d] || d).join('、')} ${time}`;
  }
  return `每天 ${time}`;
}
const cronPreview = computed(() => {
  let s = cronLabel(buildCron());
  if (holidayMode.value === 'skip') s += ' · 法定节假日不推送';
  else if (holidayMode.value === 'workday') s += ' · 按国家工作日历（节假日不推、调休补班日照推）';
  return s;
});

// 各数据源独立容错：无 skill tab 权限时 /business/skills 403，定时列表仍要能显示
async function loadSchedules() {
  try {
    const sched = await api.get('/schedules');
    schedules.value = sched.schedules || [];
  } catch (e) { flash('加载定时配置失败: ' + e.message, 'err'); }
  try {
    const skills = await api.get('/business/skills');
    // /business/skills 返回裸数组（不是 {skills:[]}），兼容两种格式
    allSkills.value = Array.isArray(skills) ? skills : (skills.skills || []);
  } catch { allSkills.value = []; }
  try {
    const feishu = await api.get('/feishu/config');
    // 构建飞书目标选项列表（所有已配置会话）
    const targets = [];
    if (feishu.targets && Array.isArray(feishu.targets)) {
      for (const t of feishu.targets) {
        if (t.receive_id) {
          targets.push({
            value: JSON.stringify({ receive_id_type: t.receive_id_type || 'chat_id', receive_id: t.receive_id, name: t.name || '' }),
            label: t.name || t.receive_id.slice(0, 16) + '...'
          });
        }
      }
    }
    feishuTargets.value = targets;
  } catch { feishuTargets.value = []; }
}
async function loadFeishuChats() {
  try {
    const d = await api.get('/feishu/chats');
    feishuChats.value = d.chats || [];
    if (!feishuChats.value.length) flash('机器人不在任何群里', 'err');
  } catch (e) { flash('列出群失败: ' + e.message, 'err'); }
}
async function addSchedule() {
  const f = newSched.value;
  const cron = buildCron();
  if (!f.skill_id || !f.feishu_target || !cron) { flash('Skill、推送目标和时间为必填', 'err'); return; }
  f.cron = cron;
  try {
    const sk = allSkills.value.find(s => s.id === Number(f.skill_id));
    let targetName = '';
    try { targetName = JSON.parse(f.feishu_target).name || ''; } catch {}
    await api.post('/schedules', {
      skill_id: Number(f.skill_id),
      system_id: sk?.system_id || 0,
      skill_name: sk?.name || '',
      system_name: sk?.system_name || '',
      feishu_target: f.feishu_target,
      feishu_target_name: targetName,
      cron: f.cron,
      enabled: true,
      holiday_mode: holidayMode.value,
    });
    flash('定时推送配置已添加');
    newSched.value = { skill_id: '', feishu_target: '', cron: buildCron() };
    await loadSchedules();
  } catch (e) { flash('添加失败: ' + e.message, 'err'); }
}
async function toggleSched(sc) {
  try {
    await api.post('/schedules', { ...sc, enabled: !sc.enabled });
    await loadSchedules();
  } catch (e) { flash('操作失败: ' + e.message, 'err'); }
}
async function runSchedNow(sc) {
  schedRunning.value = sc.id;
  try {
    await api.post(`/schedules/${sc.id}/run`);
    flash('执行完成，去飞书查看');
    await loadSchedules();
  } catch (e) { flash('执行失败: ' + e.message, 'err'); }
  finally { schedRunning.value = 0; }
}
async function removeSched(sc) {
  if (!confirm(`删除「${sc.skill_name}」的定时推送配置？`)) return;
  try {
    await api.del(`/schedules/${sc.id}`);
    flash('已删除');
    await loadSchedules();
  } catch (e) { flash('删除失败: ' + e.message, 'err'); }
}

// Skill 自带 cron：筛选 + 启停 + 立即执行（写入走 /business/skills，会触发后端重注册定时任务）
const skillCrons = computed(() => allSkills.value.filter((s) => s.cron && String(s.cron).trim()));
const skillRunning = ref(0);
async function toggleCronSkill(sk) {
  try {
    await api.put(`/business/skills/${sk.id}`, { ...sk, enabled: sk.enabled ? 0 : 1 });
    flash(sk.enabled ? `已停用「${sk.name}」的定时` : `已启用「${sk.name}」的定时`);
    await loadSchedules();
  } catch (e) { flash('操作失败: ' + e.message, 'err'); }
}
async function runSkillNow(sk) {
  skillRunning.value = sk.id;
  try {
    await api.post(`/business/skills/${sk.id}/run`);
    flash('执行完成，去飞书查看');
    await loadSchedules();
  } catch (e) { flash('执行失败: ' + e.message, 'err'); }
  finally { skillRunning.value = 0; }
}

onMounted(() => {
  load();
  if (canTab('tools', 'push')) loadPushSystems();
  if (tab.value === 'config') loadSchedules(); // 无推送记录权限时初始落在定时配置
});
</script>

<style scoped>
.push-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.push-table th, .push-table td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; white-space: nowrap; }
.push-table th { background: var(--bg3); font-weight: 600; }
.push-table tr.total td { font-weight: 600; background: var(--bg3); }
.push-table tbody tr:hover td { background: rgba(79, 124, 247, 0.08); }
.recipe-box { border: 1px dashed var(--border); border-radius: 8px; padding: 12px; margin-top: 8px; background: var(--bg); }
.recipe-sec { margin-bottom: 10px; }
.step-list { margin: 4px 0 0 0; padding-left: 20px; font-size: 12.5px; color: var(--text2); }
.step-list li { margin-bottom: 2px; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; font-size: 12px; margin-top: 4px; align-items: center; }
.kv span { color: var(--text3); white-space: nowrap; }
.kv code { background: var(--bg3); padding: 1px 6px; border-radius: 4px; font-size: 11.5px; word-break: break-all; color: var(--text2); }
.recipe-json { background: var(--bg3); border-radius: 6px; padding: 10px; font-size: 11px; max-height: 240px; overflow: auto; white-space: pre-wrap; word-break: break-all; margin-top: 6px; }
</style>
