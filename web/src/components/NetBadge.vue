<template>
  <!-- 通道标识：内网=绿框绿字，外网=蓝框蓝字；title 悬停说明当前实际走哪条路 -->
  <span class="net-badge" :class="zone" :title="tip">{{ zone === 'lan' ? '内网' : '外网' }}</span>
</template>

<script setup>
// 内外网徽标：地址在内网 → 内网；公网域名访问时以后台探测的本地直连结果为准——
// 内网地址探测可达说明本机就在家庭局域网里（视频/文档已自动改走内网直连），同样显示内网。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { netZone } from '../utils/netZone';
import { localState, probeLocalBase } from '../utils/localBase';

const hostZone = netZone();                 // 地址栏主机名判定，同一次会话内不变
const directOk = ref(localState().ok);      // 本地直连探测结果（随 wb-local-base 事件更新）
const zone = computed(() => (hostZone === 'lan' || directOk.value ? 'lan' : 'wan'));
const tip = computed(() => {
  if (hostZone === 'lan') return '当前从局域网地址访问：视频/文档加载快，推荐家庭网络内使用';
  if (directOk.value) return '当前通过公网域名访问，但 NAS 内网地址可达：视频/文档已自动改走内网直连（⚡），速度与局域网相同';
  return '当前从公网域名访问：速度受上下行带宽限制；同一局域网内可在 设置 → 本地直连 配置 NAS 内网地址，配置后自动切换';
});
const refresh = () => { directOk.value = localState().ok; };
onMounted(() => {
  window.addEventListener('wb-local-base', refresh);
  probeLocalBase();   // App 启动也会触发；这里兜底（模块内单飞去重，不会重复发请求）
});
onBeforeUnmount(() => window.removeEventListener('wb-local-base', refresh));
</script>

<style scoped>
.net-badge {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.5;
  letter-spacing: 1px;
  white-space: nowrap;
  cursor: default;
}
.net-badge.lan { color: var(--green); border: 1px solid var(--green); }
.net-badge.wan { color: var(--accent); border: 1px solid var(--accent); }
</style>
