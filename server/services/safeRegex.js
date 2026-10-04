// 正则搜索的安全闸门（v1.9.41）——四层防护，缺一不可：
//   ① 校验：长度 ≤ 200、flags 只留 i/m/u、new RegExp 包 try/catch
//   ② 危险模式拒绝：嵌套量词 / 重复贪婪通配 / 反向引用 / 分支过多 —— 常见 ReDoS 构造，先给好话
//   ③ 硬上限：只扫最近 N 条、每条正文截断、结果条数封顶（调用方传进来）
//   ④ worker + 硬超时：真正的兜底。②只是提高门槛，绕过它的正则花样太多，唯一可靠的是随时能掐。
//
// 超时/引擎不可用时不抛错，返回 { ids: [], timed_out } / { degraded: true }，
// 让上层降级成纯文本搜索并如实告诉用户——比 500 或静默空结果都好。
const path = require('path');
const { Worker } = require('node:worker_threads');

const MAX_PATTERN = 200;
const MAX_ALTERNATION = 20;

// 危险构造（命中即拒，给的是人话原因）
const DANGEROUS = [
  [/\([^)]*[+*][^)]*\)\s*[+*?]/, '嵌套量词（如 (a+)+）会触发指数级回溯'],
  [/(\.\*){2,}/, '重复的 .* 会触发大量回溯'],
  [/(\.\+){2,}/, '重复的 .+ 会触发大量回溯'],
  [/\\[1-9]/, '反向引用会显著放大回溯'],
];

// 校验并编译。合法返回 { re }，不合法返回 { error }
function validateRegex(pattern, flags = '') {
  const p = String(pattern ?? '');
  if (!p) return { error: '正则表达式不能为空' };
  if (p.length > MAX_PATTERN) return { error: `正则过长（上限 ${MAX_PATTERN} 字符）` };
  const f = String(flags || '').replace(/[^imu]/g, ''); // 只留 i/m/u，尤其要剔除 g
  for (const [re, why] of DANGEROUS) {
    if (re.test(p)) return { error: `正则过于复杂：${why}` };
  }
  // 分支数 = | 的个数 + 1（a|b 是两个分支，不是两个竖线）
  const branches = (p.match(/\|/g) || []).length + 1;
  if (branches > MAX_ALTERNATION) {
    return { error: `分支过多（上限 ${MAX_ALTERNATION} 个）` };
  }
  try {
    // eslint-disable-next-line no-new
    new RegExp(p, f);
  } catch (e) {
    return { error: `正则表达式无效：${e.message}` };
  }
  return { pattern: p, flags: f };
}

// 在 worker 里扫，硬超时兜底。
// sql/params 由调用方给（带上文件夹/标签等筛选），worker 只多认 title/content 两列。
function regexScan({
  dbPath, sql, params = [], pattern, flags = '',
  slice = 8000, limit = 500, timeoutMs = 1500,
} = {}) {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(path.join(__dirname, 'regexWorker.js'), {
        workerData: { dbPath, sql, params, pattern, flags, slice, limit },
      });
    } catch (e) {
      return resolve({ ids: [], degraded: true, error: String(e.message) });
    }
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker.terminate(); } catch { /* 已经退了 */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish({ ids: [], timed_out: true }), timeoutMs);
    worker.on('message', (m) => finish(m));
    worker.on('error', (e) => finish({ ids: [], degraded: true, error: String(e.message) }));
    // 正常退出（含被 terminate）走这里；消息没来就说明是被掐的
    worker.on('exit', () => finish({ ids: [], timed_out: true }));
  });
}

module.exports = { validateRegex, regexScan, MAX_PATTERN };
