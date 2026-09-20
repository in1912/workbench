<template>
  <div>
    <h2 class="page-title">我的宠物
      <span class="muted" style="font-size:12px; font-weight:400">像素萌宠 · 喂养互动 · 好感度成长</span>
      <a v-if="canTab('pets','adopt')" class="adopt-link" @click="tab='adopt'">＋ 领养新宠物</a>
    </h2>
    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>
    <div class="tabs">
      <button v-if="canTab('pets','pets')" :class="{active: tab==='pets'}" @click="tab='pets'">我的宠物</button>
      <button v-if="canTab('pets','adopt')" :class="{active: tab==='adopt'}" @click="tab='adopt'">领养宠物</button>
      <button v-if="canTab('pets','checkin')" :class="{active: tab==='checkin'}" @click="openCheckin">每日打卡</button>
      <button v-if="canTab('pets','records')" :class="{active: tab==='records'}" @click="openRecords">养育记录</button>
      <button v-if="canTab('pets','settings')" :class="{active: tab==='settings'}" @click="openSettings">设置与预览</button>
      <button v-if="canTab('pets','assign')" :class="{active: tab==='assign'}" @click="openAssign">宠物分配</button>
    </div>

    <!-- ============ 我的宠物 ============ -->
    <template v-if="tab==='pets'">
      <!-- 自适应方块网格：宽屏多卡并排，页面收缩时自动减列至单排 -->
      <div class="pet-grid">
        <div v-for="p in pets" :key="p.id" class="card pet-card">
          <div class="pc-head" @click="fold['p'+p.id] = !fold['p'+p.id]" :title="`${p.raise_mode === 'shared' ? '共同养育' : '个人养育'}${p.owner_name ? ' · 主人 ' + p.owner_name : ''}`">
            <b class="pc-name">{{ p.name }}</b>
            <span class="badge blue">{{ speciesLabel(p.species) }}</span>
            <span class="badge" :class="p.raise_mode === 'shared' ? 'green' : 'gray'">{{ p.raise_mode === 'shared' ? '共同' : '个人' }}</span>
            <span v-if="p.sick" class="badge red">生病</span>
            <span v-if="p.is_dead" class="badge dark">🕯 已去世</span>
            <span class="fold-mark">{{ fold['p'+p.id] ? '▸' : '▾' }}</span>
          </div>
          <template v-if="!fold['p'+p.id]">
            <!-- 已去世：像素十字架墓碑 + 死因/时间/悼词 -->
            <template v-if="p.is_dead">
              <div class="pet-show grave">
                <PixelCross :size="2.2" />
              </div>
              <div class="grave-info">
                <div class="grave-cause">{{ p.death_text }}</div>
                <div class="grave-date">🕯 {{ (p.dead_at || '').slice(0, 16) }}</div>
                <div class="grave-eulogy">「{{ p.death_eulogy }}」</div>
              </div>
              <div class="pc-acts" v-if="canManage(p)">
                <button class="small" style="color:#e87070" @click="removePet(p)">删除记录</button>
              </div>
            </template>
            <template v-else>
            <div class="pet-show">
              <PixelPet :ref="(el) => setPetRef(p.id, el)" :species="p.species" :variant="p.variant"
                        :sick="p.sick" :rings="p.rings" :gif="gifOf(p)" :size="2" />
            </div>
            <div v-if="p.sick" class="pc-sick">{{ config.sick_days }} 天没吃没喝生病了，快点吃药吧！</div>
            <div class="stat-row"><span class="stat-name">好感 ❤</span>
              <div class="stat-bar"><div class="stat-bar-in pink" :style="{ width: affBar(p.my.affection) }"></div></div>
              <span class="stat-val">{{ p.my.affection }}</span>
            </div>
            <div class="stat-row"><span class="stat-name">成长 ⭕</span>
              <div class="stat-bar"><div class="stat-bar-in" :style="{ width: (p.age_days % config.growth_days || 0) / config.growth_days * 100 + '%' }"></div></div>
              <span class="stat-val">{{ p.rings }}/{{ config.max_rings }}</span>
            </div>
            <div class="pc-meta">
              <span>年龄 <b>{{ p.age_days }}</b> 天</span>
              <span>粪便 <b :class="{ warn: p.poops.length > config.poop_penalty_threshold }">{{ p.poops.length }}</b> 块</span>
              <span>铲屎 <b>{{ p.my.scoop_credits }}</b></span>
              <span :class="{ 'sick-warn': p.sick_count >= p.sick_death_threshold * 0.8 }"
                    :title="`累计生病 ${p.sick_count} 个回合，到 ${p.sick_death_threshold} 个回合会离世`">
                病史 <b :class="{ warn: p.sick_count >= p.sick_death_threshold * 0.8 }">{{ p.sick_count }}</b>/{{ p.sick_death_threshold }}
              </span>
              <span>下次拉粑粑 {{ fmtIn(p.poop_next_in) }}</span>
              <span>今日 饭{{ p.my.today_food }}/{{ config.feed_daily_limit }} · 水{{ p.my.today_water }}/{{ config.water_daily_limit }} · 玩{{ p.my.today_play }}/{{ config.play_daily_limit }}</span>
            </div>
            <div class="pc-acts">
              <button v-if="p.sick" class="primary small" @click="pageAct(p, { type: 'medicine' }, 'medicine')">💊 吃药</button>
              <button class="small" @click="pageAct(p, { type: 'food', item: 'rice' }, 'feed', 'rice')">🍚 喂饭</button>
              <button class="small" @click="pageAct(p, { type: 'water' }, 'water')">💧 喂水</button>
              <button class="small" @click="pageAct(p, { type: 'food', item: 'snack' }, 'feed', 'snack')">🦴 零食</button>
              <button class="small" @click="pageAct(p, { type: 'play', item: 'yarn' }, 'playYarn')">🧶 玩耍</button>
              <button v-if="canManage(p)" class="small" @click="startEdit(p)" title="编辑">✎</button>
            </div>
            </template>
          </template>
        </div>
        <div v-if="!pets.length && !loading" class="card pet-card pet-empty">
          <div class="empty" style="margin-bottom:10px">还没有宠物</div>
          <button v-if="canTab('pets','adopt')" class="primary" @click="tab='adopt'">去领养一只 🐾</button>
        </div>
      </div>

      <!-- 编辑弹层 -->
      <div v-if="editing" class="modal-mask" @click.self="editing = null">
        <div class="modal card">
          <h3 style="margin-bottom:10px">编辑「{{ editing.name }}」</h3>
          <div class="fld" style="margin-bottom:10px">名字
            <input v-model="editing.name" maxlength="20" style="width:200px">
          </div>
          <div class="fld" style="margin-bottom:10px">养育方式
            <select v-model="editing.raise_mode" style="width:200px">
              <option value="shared">共同养育</option>
              <option value="personal">个人养育</option>
            </select>
          </div>
          <div class="fld" style="margin-bottom:14px">更换形象（GIF，可选）
            <input type="file" accept="image/gif" @change="editGif = $event.target.files[0] || null" style="max-width:240px; font-size:12px">
          </div>
          <div class="row" style="justify-content:flex-end; gap:8px">
            <button class="small" @click="removePet(editing)" style="color:#e87070">删除宠物</button>
            <button class="small" @click="editing = null">取消</button>
            <button class="primary small" :disabled="saving" @click="saveEdit">{{ saving ? '保存中…' : '保存' }}</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ============ 领养宠物 ============ -->
    <template v-else-if="tab==='adopt'">
      <AdoptPanel @adopted="onAdopted" />
    </template>

    <!-- ============ 每日打卡 ============ -->
    <template v-else-if="tab==='checkin'">
      <div class="masonry">
        <div class="card">
          <h3 class="fold-title">今日打卡<span class="fold-mark">▾</span></h3>
          <div class="ck-big" :class="{ done: checkin.today }" @click="doCheckin">
            <div class="ck-icon">{{ checkin.today ? '✅' : '🐾' }}</div>
            <div class="ck-txt">{{ checkin.today ? '今日已打卡' : '点我打卡' }}</div>
            <div class="muted small">打卡给你养育的每只宠物 +{{ config.affection && config.affection.checkin }} 好感度</div>
          </div>
          <div class="row" style="gap:18px; margin-top:12px; justify-content:center">
            <div class="ck-stat"><b>{{ checkin.streak }}</b><span class="muted small">连续天数</span></div>
            <div class="ck-stat"><b>{{ monthDays.length }}</b><span class="muted small">本月打卡</span></div>
            <div class="ck-stat"><b>{{ pets.length }}</b><span class="muted small">在养宠物</span></div>
          </div>
        </div>
        <div class="card">
          <h3 class="fold-title">打卡月历
            <span class="row" style="gap:6px; margin-left:auto">
              <button class="small" @click="shiftMonth(-1)">‹</button>
              <b>{{ ckMonth }}</b>
              <button class="small" @click="shiftMonth(1)">›</button>
            </span>
          </h3>
          <div class="cal">
            <div v-for="w in ['一','二','三','四','五','六','日']" :key="w" class="cal-h">{{ w }}</div>
            <div v-for="n in calOffset" :key="'e'+n" class="cal-d empty"></div>
            <div v-for="d in calDays" :key="d" class="cal-d" :class="{ on: ckDayNums.has(d), today: d === todayDayNum }">{{ d }}<span v-if="ckDayNums.has(d)" class="ck-mark" title="已打卡">✓</span></div>
          </div>
        </div>
      </div>
    </template>

    <!-- ============ 养育记录 ============ -->
    <template v-else-if="tab==='records'">
      <div class="row" style="margin-bottom:12px">
        <select v-model="recPetId" @change="loadRecords" style="width:220px">
          <option v-for="p in pets" :key="p.id" :value="p.id">{{ p.name }}（{{ speciesLabel(p.species) }}）</option>
        </select>
        <span class="muted small">按成员展示好感度与喂养统计（进度条为组内相对值）</span>
      </div>
      <template v-if="rec">
        <div class="card" style="margin-bottom:14px">
          <h3 class="fold-title">成员好感度<span class="fold-mark">▾</span></h3>
          <div v-for="s in rec.stats" :key="s.user_id" class="stat-row">
            <span class="stat-name">{{ uname(s) }}</span>
            <div class="stat-bar"><div class="stat-bar-in pink" :style="{ width: recBar(s.affection) }"></div></div>
            <span class="stat-val">{{ s.affection }}</span>
            <span class="muted small" style="width:110px">饭 {{ s.fed }} · 水 {{ s.waters }}</span>
            <span class="muted small" style="width:110px">零食 {{ s.snacks }} · 玩 {{ s.plays }}</span>
            <span class="muted small" style="width:90px">铲 {{ s.scooped }} · 药 {{ s.medicines }}</span>
          </div>
          <div v-if="!rec.stats.length" class="empty">还没有成员互动记录</div>
        </div>
        <div class="card">
          <h3 class="fold-title">最近动态（{{ rec.logs.length }} 条）<span class="fold-mark">▾</span></h3>
          <div v-for="l in logPageList" :key="l.id" class="log-row">
            <span class="muted" style="width:140px; flex-shrink:0">{{ l.created_at }}</span>
            <span class="badge blue" style="width:52px; justify-content:center">{{ ACTION_LABELS[l.action] || l.action }}</span>
            <span class="grow">{{ l.display_name || l.username }} {{ logText(l) }}</span>
            <span v-if="l.affection_delta" class="small" :style="{ color: l.affection_delta > 0 ? 'var(--green)' : '#e87070' }">
              {{ l.affection_delta > 0 ? '+' : '' }}{{ l.affection_delta }}
            </span>
          </div>
          <div v-if="!rec.logs.length" class="empty">暂无动态</div>
          <!-- 最近动态分页：默认 15 行，可切 15/30/50（服务端单次最多给 300 条，客户端切页） -->
          <div v-if="rec.logs.length" class="log-pager">
            <span class="muted small">共 {{ rec.logs.length }} 条</span>
            <span class="grow"></span>
            <button class="log-btn" :disabled="logPage <= 1" @click="logPage--">‹ 上一页</button>
            <span class="muted small">{{ logPage }} / {{ logTotalPages }}</span>
            <button class="log-btn" :disabled="logPage >= logTotalPages" @click="logPage++">下一页 ›</button>
            <select v-model.number="logSize" title="每页条数">
              <option :value="15">15 行</option><option :value="30">30 行</option><option :value="50">50 行</option>
            </select>
          </div>
        </div>
      </template>
      <div v-else class="card"><div class="empty">{{ pets.length ? '选择一只宠物查看记录' : '先去领养一只宠物吧' }}</div></div>
    </template>

    <!-- ============ 设置与预览 ============ -->
    <template v-else-if="tab==='settings'">
      <div class="masonry">
        <!-- 全局参数 -->
        <div class="card">
          <h3 class="fold-title" @click="fold.cfg = !fold.cfg">时间 / 频率参数
            <span v-if="!isAdmin" class="badge gray">仅管理员可改</span>
            <span class="fold-mark">{{ fold.cfg ? '▸' : '▾' }}</span>
          </h3>
          <template v-if="!fold.cfg">
            <div class="cfg-grid">
              <label v-for="f in CFG_FIELDS" :key="f.key" class="fld">{{ f.label }}（{{ f.unit }}）
                <input v-model.number="cfgForm[f.key]" type="number" :min="f.min" :step="f.step" :disabled="!isAdmin" style="width:90px">
              </label>
            </div>
            <b class="small" style="display:block; margin:10px 0 6px">好感度数值</b>
            <div class="cfg-grid">
              <label v-for="(lb, k) in AFF_LABELS" :key="k" class="fld">{{ lb }}
                <input v-model.number="cfgForm.affection[k]" type="number" step="0.01" :disabled="!isAdmin" style="width:90px">
              </label>
            </div>
            <button v-if="isAdmin" class="primary small" style="margin-top:10px" :disabled="saving" @click="saveConfig">{{ saving ? '保存中…' : '保存参数' }}</button>
          </template>
        </div>
        <!-- 动作预览 -->
        <div class="card" style="grid-column: 1 / -1">
          <h3 class="fold-title" @click="fold.prev = !fold.prev">动作预览（每只宠物的每个动作）
            <span class="muted small">点小画布可触发部位点击反应</span>
            <span class="fold-mark">{{ fold.prev ? '▸' : '▾' }}</span>
          </h3>
          <template v-if="!fold.prev">
            <div class="row" style="gap:10px; flex-wrap:wrap; align-items:flex-end; margin-bottom:10px">
              <label class="fld">物种
                <select v-model="prev.species" style="width:130px">
                  <option v-for="sp in SPECIES_LIST" :key="sp.key" :value="sp.key">{{ sp.label }}</option>
                </select>
              </label>
              <label class="fld">花色
                <select v-model.number="prev.variant" style="width:110px">
                  <option v-for="v in prevVariants" :key="v.index" :value="v.index">{{ v.name }}</option>
                </select>
              </label>
              <label class="fld">成长
                <select v-model.number="prev.rings" style="width:90px">
                  <option v-for="n in (config.max_rings || 6) + 1" :key="n - 1" :value="n - 1">{{ n - 1 }} 圈</option>
                </select>
              </label>
              <label class="row small" style="gap:5px"><input type="checkbox" v-model="prev.sick"> 生病（背面）</label>
              <button class="small" @click="stopPreview">⏹ 停止</button>
            </div>
            <div class="prev-stage">
              <div class="prev-canvas">
                <PixelPet ref="prevRef" :species="prev.species" :variant="prev.variant" :rings="prev.rings" :sick="prev.sick" :size="4" />
              </div>
              <div class="prev-groups">
                <div v-for="g in PREVIEW_GROUPS" :key="g.title" class="prev-group">
                  <b class="small">{{ g.title }}</b>
                  <div class="row" style="gap:5px; flex-wrap:wrap">
                    <button v-for="it in g.items" :key="it" class="small" @click="playPreview(it)">{{ animLabel(it) }}</button>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </div>
        <!-- 桌面宠物（Windows 桌面常驻小窗） -->
        <div class="card" style="grid-column: 1 / -1">
          <h3 class="fold-title" @click="fold.desk = !fold.desk">桌面宠物（Windows 桌面常驻）
            <span class="muted small">宠物显示在电脑桌面右下角（不是网页里），可拖动 / 双击玩耍 / 右键喂养</span>
            <span class="fold-mark">{{ fold.desk ? '▸' : '▾' }}</span>
          </h3>
          <template v-if="!fold.desk">
            <div class="row" style="gap:14px; flex-wrap:wrap; align-items:center">
              <label class="switch" title="开启后生成个人接入密钥，并可下载桌面安装包">
                <input type="checkbox" v-model="desk.on" @change="saveDesk">
                <span class="slider"></span>
                <b class="small" :style="{ color: desk.on ? '#2e9e5b' : 'var(--muted)' }">{{ desk.on ? '已开启' : '已关闭' }}</b>
              </label>
              <label class="fld">桌面显示的宠物
                <select v-model.number="desk.petId" style="width:150px" @change="saveDesk">
                  <option v-for="p in desk.pets" :key="p.id" :value="p.id">{{ p.name }}{{ p.has_gif ? '（GIF）' : '' }}</option>
                </select>
              </label>
              <label class="fld" title="100% 为默认基准尺寸；修改后桌面端约 1 分钟内自动生效（或右键宠物 → 刷新状态）">显示比例
                <select v-model.number="desk.scale" style="width:96px" @change="saveDesk">
                  <option v-for="s in [50, 75, 100, 125, 150, 175, 200]" :key="s" :value="s / 100">{{ s }}%</option>
                </select>
              </label>
              <button class="primary small" :disabled="deskBusy || !desk.petId" @click="genFrames">{{ deskBusy ? '生成中…' : '生成桌面形象' }}</button>
              <span class="muted small">{{ deskHint }}</span>
            </div>
            <template v-if="desk.on">
              <div class="desk-warn">下载下面 3 个文件放到同一文件夹，右键 install-desktop-pet.bat →「以管理员身份运行」即可安装（开机自启、单实例）。</div>
              <div class="row" style="flex-wrap:wrap; gap:8px; margin-top:8px">
                <a class="desk-dl" href="#" @click.prevent="dlDesk('petsetup', 'desktop-pet-setup.ps1')">⬇ desktop-pet-setup.ps1（桌面宠物程序）</a>
                <a class="desk-dl" href="#" @click.prevent="dlDesk('petinstall', 'install-desktop-pet.bat')">⬇ install-desktop-pet.bat（安装）</a>
                <a class="desk-dl" href="#" @click.prevent="dlDesk('petuninstall', 'uninstall-desktop-pet.bat')">⬇ uninstall-desktop-pet.bat（卸载）</a>
              </div>
            </template>
            <div class="muted small" style="margin-top:8px; line-height:1.8">
              内置像素宠物需先点「生成桌面形象」（按当前成长圈数截 4 帧：正常 / 眨眼 / 开心 / 生病）；GIF 宠物直接使用原动图，无需生成（不参与比例缩放）。宠物长大后重新生成一次即可换更大的形象。生病 / 去世状态与网页实时同步（每分钟刷新）。「显示比例」默认 100%，改后桌面端约 1 分钟内生效。
            </div>
          </template>
        </div>
      </div>
    </template>

    <!-- ============ 宠物分配 ============ -->
    <template v-else-if="tab==='assign'">
      <div class="card">
        <h3 class="fold-title">共同养育成员分配<span class="muted small">勾选的用户可以照顾该宠物；个人养育的宠物只有主人可见</span><span class="fold-mark">▾</span></h3>
        <div v-if="!assign.pets.length" class="empty">还没有宠物</div>
        <div v-for="p in assign.pets" :key="p.id" class="assign-row">
          <div class="assign-head">
            <b>{{ p.name }}</b>
            <span class="badge" :class="p.raise_mode === 'shared' ? 'green' : 'gray'">{{ p.raise_mode === 'shared' ? '共同' : '个人' }}</span>
            <span class="muted small">主人：{{ uname(assign.users.find((u) => u.id === p.owner_id) || p.owner_id) }}</span>
          </div>
          <div v-if="canEditAssign(p)" class="row" style="flex:1; min-width:260px">
            <UserPicker :users="assign.users" :model-value="membersOf(p.id)" multiple @update:model-value="(ids) => (draft['m' + p.id] = ids)" />
            <button class="primary small" :disabled="saving" @click="saveMembers(p)">保存</button>
          </div>
          <div v-else class="muted small" style="flex:1">{{ membersOf(p.id).length }} 位成员</div>
          <button v-if="canEditAssign(p)" class="small" style="color:#e87070" @click="removePet(p)" title="删除该宠物（成长与记录一并清除）">删除宠物</button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import { canTab, firstTab } from '../tabs';
import PixelPet from '../components/PixelPet.vue';
import PixelCross from '../components/PixelCross.vue';
import AdoptPanel from '../components/AdoptPanel.vue';
import UserPicker from '../components/UserPicker.vue';
import { SPECIES_LIST } from '../pets/pixelSprites.js';
import { ANIMS, PREVIEW_GROUPS } from '../pets/pixelPets.js';
import { renderDesktopFrames } from '../pets/desktopFrames.js';

const tab = ref(firstTab('pets', 'pets'));
const route = useRoute();
const me = computed(() => JSON.parse(localStorage.getItem('wb_user') || 'null'));
const isAdmin = computed(() => me.value?.role === 'admin');
const fold = reactive({ cfg: false, prev: false, desk: false });
const msg = ref(''), msgType = ref('ok');
const loading = ref(true), saving = ref(false);

function say(text, type = 'ok') { msg.value = text; msgType.value = type; setTimeout(() => { if (msg.value === text) msg.value = ''; }, 3000); }
function todayStr() { return new Date().toLocaleDateString('sv').slice(0, 10); }
function fmtIn(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${Math.ceil(sec)} 秒`;
  const m = Math.ceil(sec / 60); // 先整体向上取整到分钟再拆 时/分，避免出现「2 时 60 分」
  const h = Math.floor(m / 60);
  if (!h) return `${m} 分`;
  return m % 60 ? `${h} 时 ${m % 60} 分` : `${h} 时整`;
}

// ---------- 我的宠物 ----------
const pets = ref([]);
const config = ref({ affection: {}, max_rings: 6, growth_days: 14, feed_daily_limit: 3, water_daily_limit: 3, play_daily_limit: 5, poop_penalty_threshold: 3, sick_days: 3 });
const gifCache = new Map();
const petRefs = new Map();
function setPetRef(id, el) { if (el) petRefs.set(id, el); }
function gifOf(p) { return p.has_gif ? gifCache.get(p.id) || '' : ''; }
async function loadGif(petId) {
  if (gifCache.has(petId)) return;
  try {
    const res = await fetch(`/api/pets/${petId}/gif`, { headers: { Authorization: `Bearer ${localStorage.getItem('wb_token')}` } });
    if (res.ok) gifCache.set(petId, URL.createObjectURL(await res.blob()));
  } catch { /* 忽略 */ }
}

async function loadState() {
  try {
    const d = await api.get('/pets/state');
    pets.value = d.pets || [];
    config.value = d.config || config.value;
    for (const p of pets.value) if (p.has_gif) loadGif(p.id);
    if (!recPetId.value && pets.value.length) { recPetId.value = pets.value[0].id; if (tab.value === 'records') loadRecords(); }
  } catch (e) { say(e.message, 'err'); }
  loading.value = false;
}

function speciesLabel(key) { return SPECIES_LIST.find((s) => s.key === key)?.label || key; }
function affBar(v) { return Math.min(100, (v || 0) * 2) + '%'; } // 好感 50 封顶展示
function canManage(p) { return isAdmin.value || p.owner_id === me.value?.id; }

// 页内快捷操作（与悬浮窗同一接口）
const busy = ref(false);
async function pageAct(p, body, anim, arg) {
  if (busy.value) return;
  busy.value = true;
  try {
    const r = await api.post(`/pets/${p.id}/action`, body);
    if (r.pet) {
      const i = pets.value.findIndex((x) => x.id === r.pet.id);
      if (i >= 0) pets.value[i] = r.pet;
      if (r.pet.has_gif) loadGif(r.pet.id);
    }
    const ref = petRefs.get(p.id);
    if (ref && anim) {
      await ref.playAnim(anim, arg);
      if (anim === 'feed') await ref.playAnim('happyJump');
    }
    window.dispatchEvent(new Event('wb-pets-refresh'));
  } catch (e) { say(e.message, 'err'); }
  busy.value = false;
}

// 编辑 / 删除
const editing = ref(null), editGif = ref(null);
function startEdit(p) { editing.value = { id: p.id, name: p.name, raise_mode: p.raise_mode }; editGif.value = null; }
async function saveEdit() {
  saving.value = true;
  try {
    await api.put(`/pets/${editing.value.id}`, { name: editing.value.name, raise_mode: editing.value.raise_mode });
    if (editGif.value) {
      const fd = new FormData();
      fd.append('gif', editGif.value);
      const res = await fetch(`/api/pets/${editing.value.id}/gif`, { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('wb_token')}` }, body: fd });
      if (!res.ok) throw new Error('GIF 上传失败');
      gifCache.delete(editing.value.id);
    }
    editing.value = null;
    await loadState();
    window.dispatchEvent(new Event('wb-pets-refresh'));
    say('已保存');
  } catch (e) { say(e.message, 'err'); }
  saving.value = false;
}
async function removePet(p) {
  if (!confirm(`确定删除「${p.name}」吗？成长与记录都会消失，不可恢复。`)) return;
  try {
    await api.del(`/pets/${p.id}`);
    editing.value = null;
    await loadState();
    if (tab.value === 'assign') openAssign(); // 分配页删除后刷新分配列表
    window.dispatchEvent(new Event('wb-pets-refresh'));
    say('已删除');
  } catch (e) { say(e.message, 'err'); }
}

// 领养成功：刷新列表并切回「我的宠物」tab
async function onAdopted() {
  await loadState();
  tab.value = 'pets';
  say('领养成功，记得常来照顾它～');
}

// ---------- 打卡 ----------
const checkin = ref({ today: false, streak: 0 });
const ckMonth = ref(todayStr().slice(0, 7));
const monthDays = ref([]);
async function loadCheckin() {
  try {
    const d = await api.get(`/pets/checkins?month=${ckMonth.value}`);
    monthDays.value = d.days || [];
    checkin.value = { today: d.today, streak: d.streak };
  } catch (e) { say(e.message, 'err'); }
}
function openCheckin() { tab.value = 'checkin'; loadCheckin(); }
async function doCheckin() {
  if (checkin.value.today) return;
  try {
    const r = await api.post('/pets/checkin');
    say(`打卡成功！连续 ${r.streak} 天，${r.pets_gained} 只宠物好感度提升`);
    await loadCheckin();
    await loadState();
    window.dispatchEvent(new Event('wb-pets-refresh'));
  } catch (e) { say(e.message, 'err'); }
}
function shiftMonth(n) {
  const [y, m] = ckMonth.value.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  ckMonth.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  loadCheckin();
}
const calOffset = computed(() => { const d = new Date(ckMonth.value + '-01'); return (d.getDay() + 6) % 7; }); // 周一开头
const calDays = computed(() => {
  const [y, m] = ckMonth.value.split('-').map(Number);
  return new Date(y, m, 0).getDate();
});
// 月历匹配：月天数 v-for 出的是 1..31 数字，打卡记录是 "YYYY-MM-DD"，统一取「日」数字比对
const ckDayNums = computed(() => new Set(monthDays.value.map((s) => Number(s.slice(8, 10)))));
const todayDayNum = computed(() => (todayStr().startsWith(ckMonth.value) ? Number(todayStr().slice(8, 10)) : 0));

// ---------- 记录 ----------
const recPetId = ref(0), rec = ref(null);
const ACTION_LABELS = { food: '喂食', water: '喂水', play: '玩耍', medicine: '吃药', scoop: '铲屎', checkin: '打卡', sick: '生病', poop: '粪便', death: '离世' };
const FOOD_LABELS = { rice: '一顿饭', snack: '零食', banana: '香蕉', apple: '苹果' };
const PLAY_LABELS = { yarn: '毛线球', blocks: '积木', train: '电动火车', cooking: '做饭游戏' };
function logText(l) {
  let t = '';
  if (l.action === 'food') t = `喂了${FOOD_LABELS[l.detail] || l.detail}`;
  else if (l.action === 'play') t = `陪它玩${PLAY_LABELS[l.detail] || l.detail}`;
  else if (l.action === 'water') t = '喂了水';
  else if (l.action === 'medicine') t = '喂了药，恢复健康';
  else if (l.action === 'scoop') t = `铲掉了粪便 #${l.detail}`;
  else t = l.detail || '';
  return l.typed ? `${t}（打字口令）` : t;
}
function uname(u) {
  if (!u) return '—';
  if (typeof u === 'object') return (u.display_name || '').trim() || u.username;
  return `用户${u}`;
}
function recBar(v) {
  const max = Math.max(0.01, ...rec.value.stats.map((s) => s.affection || 0));
  return Math.min(100, ((v || 0) / max) * 100) + '%';
}
function openRecords() { tab.value = 'records'; if (!rec.value && recPetId.value) loadRecords(); }
async function loadRecords() {
  if (!recPetId.value) return;
  logPage.value = 1; // 换宠物回到第一页
  try { rec.value = await api.get(`/pets/records?pet_id=${recPetId.value}`); }
  catch (e) { say(e.message, 'err'); }
}

// ---------- 最近动态客户端分页（15/30/50 行 + 上下页） ----------
const logPage = ref(1);
const logSize = ref(15);
const logTotalPages = computed(() => Math.max(1, Math.ceil((rec.value?.logs.length || 0) / logSize.value)));
const logPageList = computed(() => {
  const logs = rec.value?.logs || [];
  const p = Math.min(logPage.value, logTotalPages.value);
  return logs.slice((p - 1) * logSize.value, p * logSize.value);
});
watch(logSize, () => { logPage.value = 1; });

// ---------- 设置与预览 ----------
const CFG_FIELDS = [
  { key: 'poop_interval_hours', label: '粪便生成间隔', unit: '小时', min: 0.05, step: 0.5 },
  { key: 'poop_penalty_threshold', label: '粪便扣好感阈值', unit: '块', min: 1, step: 1 },
  { key: 'feed_daily_limit', label: '每日喂食上限', unit: '次', min: 1, step: 1 },
  { key: 'feed_cooldown_hours', label: '喂食冷却', unit: '小时', min: 0.05, step: 0.5 },
  { key: 'water_daily_limit', label: '每日喂水上限', unit: '次', min: 1, step: 1 },
  { key: 'water_cooldown_hours', label: '喂水冷却', unit: '小时', min: 0.05, step: 0.5 },
  { key: 'play_daily_limit', label: '每日玩耍上限', unit: '次', min: 1, step: 1 },
  { key: 'typing_daily_limit', label: '打字互动上限', unit: '次/类/天', min: 1, step: 1 },
  { key: 'sick_days', label: '生病判定', unit: '天没吃没喝', min: 0.05, step: 0.5 },
  { key: 'sick_death_threshold', label: '病逝阈值', unit: '累计回合', min: 1, step: 1 },
  { key: 'starve_death_days', label: '饿死判定', unit: '天没喂饭', min: 1, step: 1 },
  { key: 'growth_days', label: '成长周期', unit: '天/圈', min: 1, step: 1 },
  { key: 'max_rings', label: '成长上限', unit: '圈', min: 1, step: 1 },
];
const AFF_LABELS = { rice: '喂饭', water: '喂水', snack: '零食', banana: '香蕉', apple: '苹果', play: '玩耍', checkin: '打卡', sick: '生病', poop_hour: '粪便超量/时' };
const cfgForm = reactive({});
const prev = reactive({ species: 'dog', variant: 0, rings: 0, sick: false });
const prevRef = ref(null);
const prevVariants = computed(() => SPECIES_LIST.find((s) => s.key === prev.species)?.variants || [{ index: 0, name: '默认' }]);
function openSettings() {
  tab.value = 'settings';
  const c = config.value;
  for (const f of CFG_FIELDS) cfgForm[f.key] = c[f.key];
  cfgForm.affection = { ...(c.affection || {}) };
}
async function saveConfig() {
  saving.value = true;
  try {
    const d = await api.put('/pets/config', cfgForm);
    config.value = d;
    say('参数已保存');
    window.dispatchEvent(new Event('wb-pets-refresh'));
  } catch (e) { say(e.message, 'err'); }
  saving.value = false;
}
function animLabel(item) {
  const [name, arg] = item.split(':');
  const base = ANIMS[name]?.label || name;
  return arg ? `${base}·${{ rice: '饭', snack: '零食', banana: '香蕉', apple: '苹果' }[arg] || arg}` : base;
}
async function playPreview(item) {
  const [name, arg] = item.split(':');
  await prevRef.value?.playAnim(name, arg);
}
function stopPreview() { prevRef.value?.stopAnim(); }

// ---------- 桌面宠物（Windows 桌面常驻小窗） ----------
const desk = reactive({ on: false, key: '', petId: null, scale: 1, pets: [], ready: false, loaded: false });
const deskBusy = ref(false);
const deskHint = computed(() => {
  const p = desk.pets.find((x) => x.id === desk.petId);
  if (!desk.pets.length) return '先去「领养宠物」养一只';
  if (!p) return '选择要在桌面显示的宠物';
  if (p.has_gif) return 'GIF 宠物无需生成，桌面端直接使用原动图';
  return desk.ready ? '桌面形象已生成' : '尚未生成桌面形象，安装前请先生成';
});
async function loadDesk() {
  try {
    const d = await api.get('/pets/desktop-config');
    desk.on = !!d.enabled; desk.key = d.key || ''; desk.petId = d.pet_id;
    desk.scale = Number(d.scale) || 1;
    desk.pets = d.pets || [];
    // 默认选中第一只宠物（显示名字）：否则不选宠物直接开开关会因 pet_id 空被拒
    if (!desk.petId && desk.pets.length) desk.petId = desk.pets[0].id;
    desk.ready = desk.pets.some((p) => p.has_gif) || !!d.frames_ready;
    desk.loaded = true;
  } catch (e) { say(e.message, 'err'); }
}
async function saveDesk() {
  saving.value = true;
  try {
    const d = await api.put('/pets/desktop-config', { enabled: desk.on ? 1 : 0, pet_id: desk.petId, scale: desk.scale });
    desk.on = !!d.enabled; desk.key = d.key || '';
    say('桌面宠物设置已保存');
  } catch (e) { say(e.message, 'err'); }
  saving.value = false;
}
async function genFrames() {
  const p = desk.pets.find((x) => x.id === desk.petId);
  if (!p) return;
  if (p.has_gif) { say('GIF 宠物无需生成，桌面端直接使用原动图'); return; }
  deskBusy.value = true;
  try {
    const frames = renderDesktopFrames(p.species, p.variant || 0, p.rings || 0);
    await api.post('/pets/desktop-frames', { pet_id: p.id, frames });
    desk.ready = true;
    say('桌面形象已生成（4 帧），下载安装包即可在桌面看到它');
  } catch (e) { say('生成失败：' + e.message, 'err'); }
  deskBusy.value = false;
}
function dlDeskFile(type) { return `/api/pets/agent-files?type=${type}&token=${encodeURIComponent(localStorage.getItem('wb_token') || '')}`; }
// 自签名 HTTPS 下 <a download> 直点会被浏览器下载管理器重新发起连接、按证书错误拦下
// （页面能打开、复制链接新窗口也能下，唯独直点报「请检查互联网连接」）。
// 改走页内 fetch（与页面 API 同通道，继承「继续访问」的证书豁免）拉 blob 再存盘。
async function dlDesk(type, name) {
  try {
    const r = await fetch(dlDeskFile(type));
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
    const u = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = u; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 30000);
  } catch (e) { say('下载失败：' + e.message, 'err'); }
}

// ---------- 分配 ----------
const assign = ref({ pets: [], users: [], members: [] });
const draft = reactive({});
function openAssign() {
  tab.value = 'assign';
  api.get('/pets/assign').then((d) => { assign.value = d; }).catch((e) => say(e.message, 'err'));
}
function membersOf(petId) {
  if ('m' + petId in draft) return draft['m' + petId];
  return assign.value.members.filter((m) => m.pet_id === petId).map((m) => m.user_id);
}
function canEditAssign(p) { return isAdmin.value || p.owner_id === me.value?.id; }
async function saveMembers(p) {
  saving.value = true;
  try {
    await api.put('/pets/members', { pet_id: p.id, user_ids: draft['m' + p.id] || membersOf(p.id) });
    delete draft['m' + p.id];
    await openAssign();
    await loadState();
    say('成员已更新');
  } catch (e) { say(e.message, 'err'); }
  saving.value = false;
}

onMounted(async () => {
  await loadState();
  if (tab.value === 'checkin') loadCheckin();
});

// 深链支持：/pets?tab=adopt（旧 /adopt 地址重定向过来）直开对应 tab。
// 同组件内 hash 跳转不会重挂载，用 watch 兜住两种进入方式。
watch(() => route.query.tab, (t) => {
  if (t && canTab('pets', String(t))) tab.value = String(t);
}, { immediate: true });

// 进设置 tab 时拉取桌面宠物配置（首次）
watch(tab, (t) => { if (t === 'settings' && !desk.loaded) loadDesk(); }, { immediate: true });
</script>

<style scoped>
.fld { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--text); }
/* 桌面宠物：滑块开关 + 安装提示/下载按钮 */
.switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; -webkit-user-select: none; }
.switch input { display: none; }
.switch .slider { width: 44px; height: 22px; border-radius: 11px; background: #c8ccd4; position: relative; transition: background .18s; flex: none; }
.switch .slider::before { content: ''; position: absolute; left: 3px; top: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .18s; }
.switch input:checked + .slider { background: #2e9e5b; }
.switch input:checked + .slider::before { left: 25px; }
.desk-warn { margin-top: 10px; padding: 8px 10px; border-radius: 8px; background: rgba(232, 112, 112, .09); color: #c05656; font-size: 12.5px; }
.desk-dl { display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px; border-radius: 8px; border: 1px solid var(--border, #d7dbe3); background: var(--card2, #f4f6fa); color: var(--text, #333); font-size: 12.5px; text-decoration: none; cursor: pointer; }
.desk-dl:hover { border-color: var(--accent, #4f7cf7); color: var(--accent, #4f7cf7); }
/* 标题行入口：切到「领养宠物」tab */
.adopt-link { margin-left: auto; font-size: 12px; color: var(--accent, #4f7cf7); cursor: pointer; text-decoration: none; }
.adopt-link:hover { text-decoration: underline; }

/* 自适应方块网格：卡片等宽正方形，auto-fill 按容器宽度自动并排/收缩减列（窄屏单排） */
.pet-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(235px, 1fr)); gap: 14px; }
.pet-grid > .card.pet-card { margin: 0; padding: 12px; aspect-ratio: 1 / 1; display: flex; flex-direction: column; }
.pc-head { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; cursor: pointer; }
.pc-head .pc-name { font-size: 14px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 去世墓碑卡 */
.badge.dark { background: rgba(120, 120, 130, 0.25); color: #b8bec6; }
.pet-show.grave { flex: 1; }
.grave-info { display: flex; flex-direction: column; gap: 4px; text-align: center; margin-top: 2px; }
.grave-cause { font-size: 12px; color: var(--text2, #aaa); }
.grave-date { font-size: 11px; color: var(--text3, #888); }
.grave-eulogy { font-size: 12px; font-style: italic; color: var(--text3, #999);
  background: rgba(127, 127, 127, 0.08); border-radius: 8px; padding: 7px 9px; line-height: 1.5; }
.pc-meta .sick-warn { color: #e0913c; }
.pc-sick { font-size: 11px; color: #e87070; text-align: center; margin: 2px 0; }
.pet-show { flex: 1; min-height: 72px; display: flex; align-items: center; justify-content: center; padding: 2px 0; }
.pc-meta { display: flex; flex-wrap: wrap; justify-content: center; gap: 2px 10px; font-size: 10.5px;
  color: var(--text3, #999); margin-top: 5px; }
.pc-meta b { color: var(--text); }
.pc-meta .warn { color: #e0913c; }
.pc-acts { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; margin-top: 6px; }
.pc-acts button { padding: 3px 8px; font-size: 11px; }
.pet-empty { align-items: center; justify-content: center; }
.stat-bar-in.pink { background: linear-gradient(90deg, #ef8a9a, #ef6a7a); }
/* 好感度/成长进度条（宠物卡片与养育记录共用；此前误用了 Pay 页的类名而无样式，竖排撑高卡片） */
.stat-row { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
.stat-name { font-size: 11px; color: var(--text3, #999); flex-shrink: 0; width: 46px; text-align: right; }
.stat-bar { flex: 1; height: 8px; border-radius: 5px; background: rgba(127, 127, 127, 0.15); overflow: hidden; border: 1px solid var(--border); }
.stat-bar-in { height: 100%; border-radius: 5px; background: var(--accent, #4f7cf7); transition: width 0.3s; }
.stat-val { font-size: 11px; min-width: 42px; color: var(--text); }
.modal-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 1300; display: flex; align-items: center; justify-content: center; }
.modal { width: 340px; max-width: 92vw; margin: 0; }
.ck-big { text-align: center; padding: 22px 10px; border: 2px dashed var(--border); border-radius: 12px; cursor: pointer; transition: border-color 0.2s; }
.ck-big:hover { border-color: rgba(79, 124, 247, 0.6); }
.ck-big.done { border-style: solid; border-color: var(--green, #5cb87a); cursor: default; }
.ck-icon { font-size: 42px; }
.ck-txt { font-size: 16px; font-weight: 700; margin: 6px 0 2px; }
.ck-stat { text-align: center; min-width: 80px; }
.ck-stat b { display: block; font-size: 20px; }
.cal { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.cal-h { text-align: center; font-size: 11px; color: var(--muted, #999); padding: 2px 0; }
.cal-d { position: relative; text-align: center; padding: 6px 0; border-radius: 7px; font-size: 12.5px; border: 1px solid transparent; }
.ck-mark { position: absolute; top: 2px; right: 4px; width: 13px; height: 13px; border-radius: 50%;
  background: #5cb87a; color: #fff; font-size: 9px; line-height: 13px; font-weight: 700; }
.cal-d.on { background: rgba(92, 184, 122, 0.18); border-color: rgba(92, 184, 122, 0.5); font-weight: 700; }
.cal-d.today { border-color: rgba(79, 124, 247, 0.7); }
.log-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12.5px; border-bottom: 1px dashed var(--border); }
.log-row:last-child { border-bottom: none; }
.log-pager { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.log-btn { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; }
.log-btn:disabled { opacity: .5; cursor: default; }
.log-pager select { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 4px 6px; }
.cfg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px 14px; }
.prev-stage { display: flex; gap: 20px; flex-wrap: wrap; align-items: flex-start; }
.prev-canvas { flex-shrink: 0; padding: 10px; border: 1px dashed var(--border); border-radius: 12px; }
.prev-groups { flex: 1; min-width: 260px; display: flex; flex-direction: column; gap: 10px; }
.prev-group { display: flex; flex-direction: column; gap: 5px; }
.assign-row { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; padding: 10px 0; border-bottom: 1px dashed var(--border); }
.assign-row:last-child { border-bottom: none; }
.assign-head { display: flex; align-items: center; gap: 8px; min-width: 200px; }
</style>
