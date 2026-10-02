// 智能板语音工具的工具定义（v1.9.31）—— 单一来源
//
// 两条通道共用这一份：
//   · 通道 A（官方 MCP 接入点）：xiaozhiMcpBridge 直接拿它生成 tools/list
//   · 通道 B（设备侧固件工具）：workbench_bridge.cc 里的描述由它派生（人工同步）
//
// ⚠️ 两条通道的工具名相同，**不要同时启用**——云端 LLM 的工具表里会出现重名项。
//    预期是二选一：Phase 0 spike 通了走 A（不用烧固件），不通才走 B。
//
// ⚠️ 固件那边的描述**绝不能写死 agent 名字**（名字是用户可配的，写死会在改名后
//    造成「喊了新名字 → 被服务端拒」）。通道 A 的动态描述没有这个问题，这也是 A 优于 B 的地方。

// 名字归一化：与 xiaozhiService 里设备别名匹配同一套口径（去空格、小写）
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

function buildTools({ agent = {} } = {}) {
  const name = String(agent.name || '').trim() || '贾维斯';
  const aliases = (Array.isArray(agent.aliases) ? agent.aliases : []).map((a) => String(a || '').trim()).filter(Boolean);
  const callNames = [name, ...aliases].join('」或「');
  const enabled = !!agent.enabled;

  const tools = [
    {
      name: 'self.workbench.ask',
      description:
        '查询用户自己的个人数据库，覆盖：笔记、待办、家庭事项、子女任务、学习记录、剪贴板、新闻、邮件、AI 对话历史、文件存档。' +
        '凡是问「我的/家里的」这类私人内容都用这个工具，不要凭记忆编。' +
        '参数请传**简短关键词**（如「装修」「张三」「体检报告」），不要传整句话——底层是子串匹配，' +
        '传整句会一个字都搜不到。多个关键词用空格分隔。',
      inputSchema: {
        type: 'object',
        properties: {
          keywords: { type: 'string', description: '简短关键词，如「装修」或「张三 体检」' },
        },
        required: ['keywords'],
      },
    },
    {
      name: 'self.workbench.delegate',
      description:
        `把任务转交给用户家里 NAS 上的私人 agent「${name}」执行——它能读写文件、跑代码、用终端，能力远超本设备的本地工具。` +
        `**只在用户明确点名时调用**（叫「${callNames}」时）。` +
        '用户问自己的笔记/待办/邮件/文件时不要用这个，改用 self.workbench.ask。' +
        '转交后回答可能较慢，属正常。',
      inputSchema: {
        type: 'object',
        properties: {
          request: { type: 'string', description: '要交给它办的事，用用户的原话' },
        },
        required: ['request'],
      },
    },
  ];

  // 未启用时把 delegate 摘掉——工具表里不留一个必然被拒的入口
  // （留着的话云端 LLM 会去调它、然后拿到「没启用」的拒绝，白耗一轮对话）
  return enabled ? tools : tools.filter((t) => t.name !== 'self.workbench.delegate');
}

// 点名判定：文本里是否出现 agent 的名字或别名（归一化后子串包含）
function addressed(text, agent = {}) {
  const t = norm(text);
  if (!t) return false;
  const names = [String(agent.name || '').trim(), ...(Array.isArray(agent.aliases) ? agent.aliases : [])]
    .map(norm).filter(Boolean);
  return names.some((n) => t.includes(n));
}

module.exports = { buildTools, addressed, norm };
