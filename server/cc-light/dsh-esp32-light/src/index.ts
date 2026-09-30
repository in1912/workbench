import dgram from 'node:dgram'

// dsh-esp32-light — DeepSeek Harness (dsh) 插件源码
// 链路: 事件回调 → UDP 127.0.0.1:7878 "MODE:灯效词" → daemon.py → BLE → ESP32-C3 板子
// 事件名对照 dsh 0.1.0-rc.7 源码核实(dsh-agent-loop / dsh-session 包)。
// dist/index.js 是本文件的等价预编译版(免 tsc 直接 dsh plugin add);
// 改完本文件需要重新编译: npx tsc (或 pnpm build)。
const HOST = '127.0.0.1'   // 本机守护进程
const PORT = 7878

// 失败判定启发式(工具结果 JSON 文本匹配)
const FAIL_RE = /error|failed|denied|exit code\s*[1-9]|traceback|exception/i

// 同一灯效 30 秒内不重发(流式 chunk 频率高, 防蓝牙刷包; 也顺带刷新看门狗计时)
let _last = ''
let _lastTs = 0

function send(state: string) {
  try {
    const now = Date.now()
    if (state === _last && now - _lastTs < 30000) return
    _last = state
    _lastTs = now
    const s = dgram.createSocket('udp4')
    s.send(Buffer.from('MODE:' + state + '\n'), PORT, HOST, () => {
      try { s.close() } catch { /* 吞掉 */ }
    })
  } catch { /* 灯是装饰，任何异常都吞掉 */ }
}

// 万能总线: session/event 的 event.type 分发
const TYPES: Record<string, string | null> = {
  'user/message': 'thinking',     // 用户提交提示词
  'tool/call': 'busy',            // 即将执行工具
  'tool/result': null,            // 需启发式判定成败(下方特判)
  'assistant/message': 'ai',      // AI 一条回复输出完成
  'turn/end': 'success',          // 回合结束
}

export const name = 'esp32-light'

export function apply(ctx: any) {
  // 只监听 emit 型事件; waterfall 型(agent/pre-step、agent/request)一律不碰,
  // 天然不存在「忘调 next 卡死 Agent」的风险。
  ctx.on('session/created', () => send('demo'))
  ctx.on('session/disposed', () => send('off'))

  // agent 状态机: phase → "running" | "idle"(仅切换时发; idle 不发灯, 由 turn/end 发绿)
  ctx.on('agent/status', (p: any) => {
    if (p && p.status === 'running') send('busy')
  })

  // 模型请求失败
  ctx.on('agent/request-error', () => send('error'))

  ctx.on('session/event', (subject: any, ev: any) => {
    try {
      if (!ev || !ev.type) return
      if (ev.type === 'tool/result') {
        send(FAIL_RE.test(JSON.stringify(ev.data ?? '')) ? 'error' : 'ai')
        return
      }
      const m = TYPES[ev.type]
      if (m) send(m)
    } catch { /* 吞掉 */ }
  })
}
