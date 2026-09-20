<template>
  <div>
    <h2 class="page-title">效率工具</h2>
    <div class="tabs">
      <!-- 三大测评中心排前（v1.3.0）：抑郁测试 / 心理测试 / 职业测试（v1.3.1「专业心理测试」改名） -->
      <button v-if="canTab('tools','dep')" :class="{active: tab==='dep'}" @click="switchTab('dep')">抑郁测试</button>
      <button v-if="canTab('tools','pro')" :class="{active: tab==='pro'}" @click="switchTab('pro')">心理测试</button>
      <button v-if="canTab('tools','mbti')" :class="{active: tab==='mbti'}" @click="switchTab('mbti')">职业测试</button>
      <button v-if="canTab('tools','clip')" :class="{active: tab==='clip'}" @click="switchTab('clip')">剪贴板</button>
      <button v-if="canTab('tools','links')" :class="{active: tab==='links'}" @click="switchTab('links')">快捷启动</button>
      <!-- 学习页移来的 3 个 tab（2026-09 v1.2.0） -->
      <button v-if="canTab('tools','plans')" :class="{active: tab==='plans'}" @click="switchTab('plans')">学习计划</button>
      <button v-if="canTab('tools','records')" :class="{active: tab==='records'}" @click="switchTab('records')">学习记录</button>
      <button v-if="canTab('tools','review')" :class="{active: tab==='review'}" @click="switchTab('review')">复盘</button>
      <button v-if="canTab('tools','monitor')" :class="{active: tab==='monitor'}" @click="switchTab('monitor')">电脑监控</button>
    </div>

    <template v-if="tab==='clip'">
      <div class="card" style="margin-bottom:12px">
        <div class="row">
          <input v-model="clipText" placeholder="粘贴内容，自动保存为剪贴板记录..." class="grow" @keyup.enter="addClip" />
          <button class="primary" @click="addClip">保存</button>
        </div>
        <div class="muted" style="margin-top:8px">
          本地自动采集：Windows 用户可运行 <code>scripts/clipboard-watcher.ps1</code> 脚本，自动把系统剪贴板推送到本工作台。
        </div>
      </div>
      <div class="card">
        <div v-for="c in clips" :key="c.id" class="list-item">
          <div class="grow">
            <div>{{ c.content }}</div>
            <div class="meta">{{ c.source }} · {{ c.created_at?.slice(0,16) }}</div>
          </div>
          <button class="small" @click="copy(c.content)">复制</button>
          <button class="icon-btn" @click="delClip(c)">✕</button>
        </div>
        <div v-if="!clips.length" class="empty">暂无剪贴板记录</div>
      </div>
    </template>

    <template v-else-if="tab==='links'">
      <div class="card" style="margin-bottom:12px">
        <div class="row">
          <input v-model="link.name" placeholder="名称" style="width:150px" />
          <input v-model="link.url" placeholder="URL（https://...）" class="grow" />
          <input v-model="link.icon" placeholder="图标(emoji)" style="width:110px" />
          <select v-model="link.category" style="width:110px">
            <option value="general">常用</option>
            <option value="work">工作</option>
            <option value="study">学习</option>
            <option value="life">生活</option>
          </select>
          <button class="primary" @click="addLink">添加</button>
        </div>
      </div>
      <div class="card">
        <div class="grid g3">
          <a v-for="l in links" :key="l.id" :href="l.url" target="_blank" rel="noopener"
             class="list-item" style="border:1px solid var(--border); border-radius:10px; padding:14px; text-decoration:none; color:var(--text)">
            <div style="font-size:26px; margin-bottom:6px">{{ l.icon || '🔗' }}</div>
            <div class="t">{{ l.name }}</div>
            <div class="meta">{{ l.category }} · {{ host(l.url) }}</div>
            <div style="margin-top:8px; display:flex; justify-content:flex-end">
              <button class="icon-btn" @click.prevent="delLink(l)">✕</button>
            </div>
          </a>
        </div>
        <div v-if="!links.length" class="empty">暂无快捷应用，添加常用网址即可一键打开</div>
      </div>
    </template>

    <!-- ============ 三大测评中心（v1.3.0，共用 TestCenterTab 组件） ============ -->
    <TestCenterTab v-else-if="tab==='dep'" center="dep" />
    <TestCenterTab v-else-if="tab==='pro'" center="pro" />
    <TestCenterTab v-else-if="tab==='mbti'" center="mbti" />

    <!-- ============ 学习计划（自学习页移来） ============ -->
    <template v-else-if="tab==='plans'">
      <div class="card" style="margin-bottom:12px">
        <div class="row">
          <input v-model="plan.skill" placeholder="技能 / 课程名称" class="grow" />
          <input v-model="plan.goal" placeholder="学习目标" class="grow" />
          <button class="primary" @click="addPlan">添加计划</button>
        </div>
      </div>
      <div class="card">
        <div v-for="p in data.plans" :key="p.id" class="list-item">
          <div class="grow">
            <div class="t"><span class="badge" :class="p.status==='active' ? 'blue' : 'green'">{{ p.status==='active' ? '进行中' : '已完成' }}</span> {{ p.skill }}</div>
            <div class="d" v-if="p.goal">{{ p.goal }}</div>
          </div>
          <button v-if="p.status==='active'" class="small" @click="finishPlan(p)">完成</button>
          <button class="icon-btn" @click="delPlan(p)">✕</button>
        </div>
        <div v-if="!data.plans.length" class="empty">暂无学习计划</div>
      </div>
    </template>

    <!-- ============ 学习记录（自学习页移来） ============ -->
    <template v-else-if="tab==='records'">
      <div class="card" style="margin-bottom:12px">
        <div class="row" style="margin-bottom:10px">
          <select v-model="rec.plan_id" style="width:180px">
            <option :value="null">未关联计划</option>
            <option v-for="p in data.plans" :key="p.id" :value="p.id">{{ p.skill }}</option>
          </select>
          <input v-model="rec.record_date" type="date" style="width:150px" />
        </div>
        <textarea v-model="rec.content" rows="2" placeholder="今天学了什么？"></textarea>
        <div class="row" style="margin-top:10px">
          <input v-model="rec.gains" placeholder="收获（可选）" class="grow" />
          <input v-model="rec.problems" placeholder="遇到的问题（可选）" class="grow" />
          <button class="primary" @click="addRecord">记录</button>
        </div>
      </div>
      <div class="card">
        <div v-for="r in data.records" :key="r.id" class="list-item">
          <div class="grow">
            <div class="t"><span class="badge blue">{{ r.record_date }}</span> <span v-if="r.skill" class="badge amber">{{ r.skill }}</span> {{ r.content }}</div>
            <div class="d" v-if="r.gains">收获：{{ r.gains }}</div>
            <div class="d" v-if="r.problems">问题：{{ r.problems }}</div>
          </div>
          <button class="icon-btn" @click="delRecord(r)">✕</button>
        </div>
        <div v-if="!data.records.length" class="empty">暂无学习记录，学完记得记一笔</div>
      </div>
    </template>

    <!-- ============ 电脑监控（v1.3.5） ============ -->
    <MonitorPanel v-else-if="tab==='monitor'" />

    <!-- ============ 复盘（自学习页移来） ============ -->
    <template v-else>
      <div class="row" style="margin-bottom:12px">
        <button class="primary" @click="aiReview" :disabled="aiLoading">{{ aiLoading ? '生成中...' : 'AI 一键生成复盘草稿' }}</button>
        <span class="muted">基于最近 20 条学习记录自动生成「进展 / 收获 / 问题 / 改进计划」</span>
      </div>
      <div v-if="aiLoading" class="card" style="margin-bottom:12px"><div class="muted">AI 正在分析你的学习记录...</div></div>
      <div v-if="reviewDraft" class="card" style="margin-bottom:14px; background:var(--bg3); border-color:var(--accent)">
        <div class="markdown-body" v-html="renderedDraft"></div>
        <div class="row" style="margin-top:12px">
          <input v-model="reviewPeriod" placeholder="复盘周期，如：2026 年第 33 周" class="grow" />
          <button class="primary" @click="saveReview">保存复盘</button>
        </div>
      </div>
      <div class="card">
        <h3>历史复盘</h3>
        <div v-for="rv in reviews" :key="rv.id" class="list-item">
          <div class="grow">
            <div class="t"><span class="badge blue">{{ rv.period || '未命名周期' }}</span> <span class="muted">{{ rv.created_at?.slice(0,16) }}</span></div>
            <div class="d">{{ rv.content.slice(0, 200) }}...</div>
          </div>
          <button class="icon-btn" @click="delReview(rv)">✕</button>
        </div>
        <div v-if="!reviews.length" class="empty">还没有复盘记录</div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { marked } from 'marked';
import { api } from '../api';
import { canTab, firstTab } from '../tabs';
import TestCenterTab from '../components/TestCenterTab.vue';
import MonitorPanel from '../components/MonitorPanel.vue';

const route = useRoute();
const router = useRouter();

const tab = ref(firstTab('tools', 'clip'));
// 支持 /tools?tab=xxx 直达；切 tab 时同步地址栏（学习页移来的 3 个 tab 旧链接 /learning?tab=plans 也自然回落到本页）
function switchTab(t) {
  tab.value = t;
  router.replace({ query: { ...route.query, tab: t } });
}
watch(() => route.query.tab, (t) => {
  if (t && t !== tab.value && canTab('tools', String(t))) tab.value = String(t);
});
if (route.query.tab && canTab('tools', String(route.query.tab))) tab.value = String(route.query.tab);

const clips = ref([]);
const clipText = ref('');
const links = ref([]);
const link = ref({ name: '', url: '', icon: '', category: 'general' });

// ---------- 学习计划 / 学习记录 / 复盘（自学习页移来） ----------
const data = ref({ plans: [], records: [] });
const reviews = ref([]);
const plan = ref({ skill: '', goal: '' });
const rec = ref({ plan_id: null, content: '', gains: '', problems: '', record_date: new Date().toISOString().slice(0, 10) });
const reviewDraft = ref('');
const reviewPeriod = ref('');
const aiLoading = ref(false);

const renderedDraft = computed(() => marked.parse(reviewDraft.value || ''));

async function load() {
  // 各数据源独立容错：无对应 tab 权限时接口 403，不能拖垮其他 tab
  // （三大测评中心的数据加载在 TestCenterTab 组件内自行完成）
  try { clips.value = await api.get('/clipboard'); } catch { clips.value = []; }
  try { links.value = await api.get('/links'); } catch { links.value = []; }
  try { data.value = await api.get('/learning'); } catch { data.value = { plans: [], records: [] }; }
  try { if (canTab('tools', 'review')) reviews.value = await api.get('/reviews'); } catch { reviews.value = []; }
}

async function addClip() {
  if (!clipText.value.trim()) return;
  await api.post('/clipboard', { content: clipText.value.trim(), source: 'manual' });
  clipText.value = '';
  await load();
}
async function delClip(c) { await api.del(`/clipboard/${c.id}`); await load(); }
function copy(text) {
  navigator.clipboard?.writeText(text).then(() => {});
}

async function addLink() {
  if (!link.value.name.trim() || !link.value.url.trim()) return;
  await api.post('/links', link.value);
  link.value = { name: '', url: '', icon: '', category: 'general' };
  await load();
}
async function delLink(l) { await api.del(`/links/${l.id}`); await load(); }
function host(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return url; }
}

async function addPlan() {
  if (!plan.value.skill.trim()) return;
  await api.post('/learning/plans', plan.value);
  plan.value = { skill: '', goal: '' };
  await load();
}
async function finishPlan(p) { await api.patch(`/learning/plans/${p.id}`, { status: 'done' }); await load(); }
async function delPlan(p) { await api.del(`/learning/plans/${p.id}`); await load(); }

async function addRecord() {
  if (!rec.value.content.trim()) return;
  await api.post('/learning/records', rec.value);
  rec.value = { plan_id: null, content: '', gains: '', problems: '', record_date: new Date().toISOString().slice(0, 10) };
  await load();
}
async function delRecord(r) { await api.del(`/learning/records/${r.id}`); await load(); }

async function aiReview() {
  aiLoading.value = true;
  reviewDraft.value = '';
  try {
    const r = await api.post('/ai/review');
    reviewDraft.value = r.content;
    reviewPeriod.value = '';
  } catch (e) {
    reviewDraft.value = '生成失败：' + e.message;
  } finally {
    aiLoading.value = false;
  }
}
async function saveReview() {
  await api.post('/reviews', { period: reviewPeriod.value || new Date().toISOString().slice(0, 10), content: reviewDraft.value });
  reviewDraft.value = '';
  reviewPeriod.value = '';
  await load();
  tab.value = 'review';
}
async function delReview(rv) { await api.del(`/reviews/${rv.id}`); await load(); }

onMounted(load);
</script>
