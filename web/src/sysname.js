// 系统名称唯一前端来源：响应式共享 ref（模块级单例），localStorage 仅作首屏缓存。
// 服务端 /system-info 与设置页保存为最终依据，任何页面改名后全站即时生效。
import { ref } from 'vue';

export const sysName = ref(localStorage.getItem('wb_sysname') || '泉哥工作台');
export const sysNameEn = ref(localStorage.getItem('wb_sysname_en') || 'QuanGe Workbench');

// 拿到服务端名称（登录页/App 拉取）或设置页保存后调用：更新共享状态并同步缓存
export function setSysInfo(name, nameEn) {
  const n = String(name || '').trim();
  const e = String(nameEn || '').trim();
  if (n) { sysName.value = n; localStorage.setItem('wb_sysname', n); }
  if (e) { sysNameEn.value = e; localStorage.setItem('wb_sysname_en', e); }
}
