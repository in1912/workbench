"use strict";
// dsh-esp32-light — DeepSeek Harness (dsh) 进程内插件（预编译 JS, 免构建直接用）
// 链路: 事件回调 → UDP 127.0.0.1:7878 "MODE:灯效词" → daemon.py → BLE → ESP32-C3 板子
// 事件名已对照本机安装的 dsh 0.1.0-rc.7 源码核实(dsh-agent-loop / dsh-session 包):
//   顶层事件: session/created, session/disposed, agent/status(idle|running),
//             agent/request-error, session/event(万能总线, event.type 分发)
//   总线 type 词表: user/message, tool/call, tool/result, assistant/message,
//             assistant/chunk, step/start, step/end, turn/start, turn/end
// 规则: 发包即返回(绝不耗时等待); 任何异常静默——灯是装饰, 不能干扰 Agent;
//       常驻进程内, 严禁 process.exit; 不监听 waterfall 型事件(agent/pre-step、
//       agent/request), 天然不存在「忘调 next 卡死 Agent」的风险。
const dgram = require("node:dgram");

const HOST = "127.0.0.1";   // 本机守护进程
const PORT = 7878;

// 失败判定启发式(工具结果 JSON 文本匹配)
const FAIL_RE = /error|failed|denied|exit code\s*[1-9]|traceback|exception/i;

// 同一灯效 30 秒内不重发(流式 chunk 频率高, 防蓝牙刷包; 也顺带刷新看门狗计时)
let _last = "";
let _lastTs = 0;

function send(state) {
  try {
    const now = Date.now();
    if (state === _last && now - _lastTs < 30000) return;
    _last = state;
    _lastTs = now;
    const s = dgram.createSocket("udp4");
    s.send(Buffer.from("MODE:" + state + "\n"), PORT, HOST, () => {
      try { s.close(); } catch (e) {}
    });
  } catch (e) { /* 吞掉 */ }
}

// 万能总线: session/event 的 event.type 分发
const TYPES = {
  "user/message": "thinking",     // 用户提交提示词
  "tool/call": "busy",            // 即将执行工具
  "tool/result": null,            // 需启发式判定成败(下方特判)
  "assistant/message": "ai",      // AI 一条回复输出完成
  "turn/end": "success",          // 回合结束
};

exports.name = "esp32-light";

exports.apply = function apply(ctx) {
  ctx.on("session/created", function () { send("demo"); });
  ctx.on("session/disposed", function () { send("off"); });

  // agent 状态机: phase → "running" | "idle"(仅切换时发; idle 不发灯, 由 turn/end 发绿)
  ctx.on("agent/status", function (p) {
    if (p && p.status === "running") send("busy");
  });

  // 模型请求失败
  ctx.on("agent/request-error", function () { send("error"); });

  ctx.on("session/event", function (subject, ev) {
    try {
      if (!ev || !ev.type) return;
      if (ev.type === "tool/result") {
        send(FAIL_RE.test(JSON.stringify(ev.data == null ? "" : ev.data)) ? "error" : "ai");
        return;
      }
      const m = TYPES[ev.type];
      if (m) send(m);
    } catch (e) { /* 吞掉 */ }
  });
};
