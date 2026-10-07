// 数字人共享状态（v1.12.0）：右下角全局按钮（App.vue）、手机模型浮层（DhPhone）、
// 智能家居数字人 tab（DhPanel）三处共用——设置页改了角色/默认人，悬浮按钮的标签
// 「AI男友/AI女友/AI萌宠」与浮层画面跟着变，靠的就是这份单例 reactive。
import { reactive } from 'vue';
import { api } from './api';

export const dhState = reactive({
  loaded: false,      // 首次 meta 拉取成功过（失败不反复自动重试，进 tab 时会再拉）
  loading: false,
  personas: [],       // 角色注册表（publicPersona DTO：api_key 已在服务端擦成 hasKey）
  phoneOpen: false,   // 右下角手机模型浮层
  histVer: 0,         // 对话历史版本号：悬浮窗/聊天记录页/实时会话任一方发过消息就 +1，其余入口监听重拉，记录保持一致
});

// 当前默认数字人（无默认标记时取第一个）
export function dhDefault() {
  return dhState.personas.find((p) => p.is_default) || dhState.personas[0] || null;
}

// 全局按钮标签：按默认数字人的类型显示（没配置过=空，按钮显示「数字人」占位）
export function dhLabel() {
  const p = dhDefault();
  if (!p) return '';
  return p.type === '男友' ? 'AI男友' : p.type === '宠物' ? 'AI萌宠' : 'AI女友';
}

export async function dhRefresh() {
  if (dhState.loading) return;
  dhState.loading = true;
  try {
    const m = await api.get('/dh/meta');
    dhState.personas = m.personas || [];
    dhState.loaded = true;
  } catch { /* 无权限/未登录：按钮由 canTab 兜底不显示 */ }
  finally { dhState.loading = false; }
}
