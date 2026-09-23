<template>
  <div class="perm-wrap">
    <div class="perm-state" :class="{ limited: isLimited }">
      <template v-if="!isLimited">
        <b>当前：全部页面开放</b>（未做限制）—— 勾选任意页面即进入受限模式，未勾选的页面该用户将无法访问
      </template>
      <template v-else>
        <b>受限模式：开放 {{ granted.length }} / {{ rows.length }} 个页面</b><span v-if="restrictedPages">，其中 {{ restrictedPages }} 个页做了页内功能细分</span>
        —— 保存后立即生效，无需对方重新登录
      </template>
    </div>
    <table class="perm-table">
      <thead>
        <tr>
          <th class="c-page">
            页面（{{ granted.length }}/{{ rows.length }}）
            <a class="mini-link" @click="toggleAllPages">{{ allPagesOn ? '全部清空' : '全部勾选' }}</a>
          </th>
          <th class="c-tabs">
            页内功能（先勾左侧页面才能细分；全不勾 = 只开放页面框架）
            <a v-if="anyTabsOn" class="mini-link" @click="clearAllTabs">清空全部功能勾选</a>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in rows" :key="p.key" :class="{ off: !pageOn(p.key) }">
          <td class="c-page">
            <label class="pl">
              <input type="checkbox" :value="p.key" v-model="user.allowed_pages" />
              <span class="picon material-icons" aria-hidden="true">{{ p.icon }}</span>{{ p.label }}
            </label>
          </td>
          <td class="c-tabs">
            <template v-if="p.tabs.length">
              <label v-for="t in p.tabs" :key="t.key" class="tl" :class="{ locked: t.restricted }" :title="t.restricted ? '受限功能：默认关闭，需单独勾选才开放' : ''">
                <input type="checkbox" :value="t.key" v-model="user.allowed_tabs[p.key]" :disabled="!pageOn(p.key)" />
                {{ t.label }}<span v-if="t.restricted" class="lock">🔒</span>
              </label>
              <a v-if="pageOn(p.key)" class="mini-link" @click="toggleAllTabs(p.key)">{{ allTabsOn(p.key) ? '全不选' : '全选' }}</a>
              <span v-else class="mini-note">未开放本页面</span>
            </template>
            <span v-else class="mini-note">— 整页控制，无页内功能</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
// 页面 + 页内功能两级授权表格（用户管理：新建用户 / 授权弹窗共用）。
// 语义与后端一致：allowed_pages 空数组 = 全部开放；allowed_tabs 缺键或未存 = 该页全部功能。
import { computed, watchEffect } from 'vue';
import { NAV_ITEMS } from '../nav';
import { TAB_DEFS } from '../tabs';

const props = defineProps({ user: { type: Object, required: true } });

// 可授权页面按侧边栏顺序（「用户管理」仅管理员可用，不在授权列表）
const rows = NAV_ITEMS
  .filter((n) => !n.adminOnly)
  .map((n) => ({ key: n.page, icon: n.icon, label: n.label, tabs: TAB_DEFS[n.page] || [] }));

// 补齐 tab 数组：checkbox 的数组 v-model 要求真数组；缺键（=全部功能）物化为全选。
// 🔒 受限 tab 例外：物化时不勾选（缺键对受限 tab 的语义也是「关」），必须显式勾选才开放。
// 取消页面勾选时保留功能选择（表格里灰显可见），重新勾上即按原细分恢复。
watchEffect(() => {
  const u = props.user;
  if (!Array.isArray(u.allowed_pages)) u.allowed_pages = [];
  if (!u.allowed_tabs || typeof u.allowed_tabs !== 'object') u.allowed_tabs = {};
  for (const r of rows) {
    if (r.tabs.length && !Array.isArray(u.allowed_tabs[r.key])) {
      u.allowed_tabs[r.key] = r.tabs.filter((t) => !t.restricted).map((t) => t.key);
    }
  }
});

const granted = computed(() => props.user.allowed_pages || []);
const isLimited = computed(() => granted.value.length > 0);
const allPagesOn = computed(() => granted.value.length === rows.length);
const anyTabsOn = computed(() => rows.some((r) => r.tabs.length && pageOn(r.key)));
const restrictedPages = computed(() => rows.filter((r) => pageOn(r.key) && r.tabs.length && tabArr(r.key).length < r.tabs.length).length);

function pageOn(key) { return granted.value.includes(key); }
function tabArr(page) { const a = props.user.allowed_tabs[page]; return Array.isArray(a) ? a : []; }
function allTabsOn(page) {
  const r = rows.find((x) => x.key === page);
  return !!r && tabArr(page).length === r.tabs.length;
}
function toggleAllPages() {
  props.user.allowed_pages = allPagesOn.value ? [] : rows.map((r) => r.key);
}
function toggleAllTabs(page) {
  const r = rows.find((x) => x.key === page);
  props.user.allowed_tabs[page] = allTabsOn(page) ? [] : r.tabs.map((t) => t.key);
}
function clearAllTabs() {
  for (const r of rows) if (r.tabs.length) props.user.allowed_tabs[r.key] = [];
}
</script>

<style scoped>
.perm-state {
  font-size: 12.5px; padding: 8px 12px; border-radius: 8px;
  background: var(--bg3); color: var(--text2); margin-bottom: 10px; line-height: 1.5;
}
.perm-state.limited { background: rgba(124, 58, 237, .08); color: var(--accent); }
.perm-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.perm-table th {
  text-align: left; font-size: 12px; font-weight: 500; color: var(--text3);
  padding: 6px 10px; border-bottom: 1.5px solid var(--border); white-space: nowrap;
}
.perm-table td { padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.perm-table tr:last-child td { border-bottom: none; }
.c-page { width: 158px; white-space: nowrap; }
.c-tabs { line-height: 2; }
.perm-table input[type="checkbox"] { width: auto; margin: 0; flex-shrink: 0; }
.pl { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; font-weight: 500; }
.picon { color: var(--accent); font-size: 15px; width: 18px; text-align: center; flex-shrink: 0; }
.tl {
  display: inline-flex; align-items: center; gap: 5px; cursor: pointer; white-space: nowrap;
  padding: 2px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg2);
  margin: 2px 8px 2px 0;
}
.perm-table tr.off .pl { color: var(--text3); }
.perm-table tr.off .tl { opacity: .5; border-style: dashed; }
.tl.locked { border-color: rgba(251, 191, 36, .45); }
.tl .lock { font-size: 11px; }
.mini-link { color: var(--accent); font-size: 12px; cursor: pointer; margin-left: 8px; text-decoration: underline; white-space: nowrap; }
.mini-note { font-size: 12px; color: var(--text3); }
</style>
