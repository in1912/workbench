// 11 个创作功能注册表：字段校验 + prompt 模板 + 输出解析方式
// prompt 模板（buildPrompt 1-8 / customTopic / goldenOpening）

// 主脚本体系（爆款选题/成交选题共用）
const MAIN_SCRIPTS = {
  '教知识': {
    desc: '推荐型、解题型、案例型、揭秘型',
    subs: [
      ['推荐型', '美好愿景、圈定人群、引发好奇'],
      ['解题型', '场景难题、低行动成本、具体操作过程'],
      ['案例型', '案例描述、知识点总结、用户应用方法'],
      ['揭秘型', '提出揭秘事件、讲述内情、避免方法'],
    ],
  },
  '晒过程': {
    desc: '过程展示、测评产品、任务挑战、事件体验',
    subs: [
      ['过程展示', '进货筹备、咨询成交、技术服务、售后服务'],
      ['测评产品', '对比测评、极限测评、化验测评'],
      ['任务挑战', '高/低成本、限时间/地点'],
      ['事件体验', '新奇体验、奇葩规则、角色互换'],
    ],
  },
  '聊观点': {
    desc: '人群观点、行业观点',
    subs: [
      ['人群观点', '写作对象、人物关系、冲突事件'],
      ['行业观点', '核心对象、观点方向（误解、批判、支持、建议）'],
    ],
  },
  '讲故事': {
    desc: '小有成就、成功案例、平凡英雄、苦难经历、重走成功路',
    subs: [
      ['小有成就', '个人成就、困境转机、结尾感悟'],
      ['成功案例', '他人成就、困境转机、感悟'],
      ['平凡英雄', '冲突事件、英雄时刻、事件总结'],
      ['苦难经历', '缺陷描述、产生原因、困苦释怀'],
      ['重走成功路', '成功标的、艰辛憧憬、结尾感悟'],
    ],
  },
};

const VIRAL_ELEMENTS = [
  ['成本类', '便宜又有面子、十分之一时间金钱、花大钱干的'],
  ['人群类', '身价十个亿的、第一次体验的、不懂装懂爱挑刺的'],
  ['奇葩类', '外行人不知道的、脑回路有病的、黑心内幕操作'],
  ['头牌类', '电视剧里出现的、生意最好的、最贵的、明星名人'],
  ['怀旧类', '古代的、20年前的、如果能重来一次、前男友前女友'],
  ['反差类', '反向操作、身份反差、古今中外男女南北品牌穷富'],
  ['最差类', '最难吃最难用的、最没面子的、拼多多9块9的、差评最多'],
  ['荷尔蒙类', '好找对象的、魅力变弱的'],
];

const CONVERSION_REASONS = [
  ['效果好', '实际效果、前后对比'],
  ['好评多', '用户口碑、真实评价'],
  ['性价比', '价格实惠、配置高'],
  ['老板好', '人设靠谱、亲和力强'],
  ['便利性', '使用方便、距离近 省时、省力'],
  ['专业强', '从业时间长，获得奖项，熟练'],
  ['服务好', '服务态度、售后保障'],
  ['有特色', '环境、菜品、服务和同行有区别'],
  ['选择多', '产品种类多、好搭配、一站式服务'],
  ['有面子', '档次高、拿得出手'],
  ['质量好', '品质过硬、经久耐用'],
  ['生意好', '顾客多、订单多、断货、排队'],
  ['规模大', '门店多、覆盖广、实力强'],
  ['案例多', '成功案例多、说服力高、增强信任度'],
  ['颜值高', '外观漂亮、设计感强'],
];

const CONTENT_DIRECTIONS = ['痛点解决', '知识科普', '情感共鸣', '干货分享'];
const OPENING_STYLES = ['悬念型', '反差型', '痛点型', '数据型', '故事型', '提问型', '利益型', '权威型'];

const s = (v, cap = 6000) => String(v == null ? '' : v).trim().slice(0, cap);

// ---- 每个功能：validate(返回清洗后 inputs 或 throw) + build(inputs) 返回 prompt ----
const FEATURES = {
  viral: {
    label: '我要做爆款',
    recordTitle: i => `选题·${s(i.industryPersona, 20)}`,
    validate(b) {
      const industryPersona = s(b.industryPersona, 2000);
      if (!industryPersona) throw Object.assign(new Error('请输入行业和人设'), { status: 400 });
      const mainScript = s(b.mainScript, 50);
      if (!MAIN_SCRIPTS[mainScript]) throw Object.assign(new Error('主脚本不合法'), { status: 400 });
      const subScript = s(b.subScript, 50);
      if (subScript && !(MAIN_SCRIPTS[mainScript].subs.find(x => x[0] === subScript))) throw Object.assign(new Error('分脚本不合法'), { status: 400 });
      const viralElement = s(b.viralElement, 50);
      if (!VIRAL_ELEMENTS.find(x => x[0] === viralElement)) throw Object.assign(new Error('请选择爆款元素'), { status: 400 });
      return { industryPersona, mainScript, subScript, viralElement };
    },
    build(i) {
      const subScriptText = i.subScript ? `选择的分脚本：${i.subScript}` : '分脚本：随机选择';
      return `你是一个专业的短视频爆款选题专家。请根据以下信息，为用户生成10个适配短视频平台的爆款选题。

用户信息：
- 行业和人设：${i.industryPersona}
- 选择的主脚本：${i.mainScript}
- ${subScriptText}
- 选择的爆款元素：${i.viralElement}

请按照以下要求生成选题：
1. 每个选题都要有吸引人的标题
2. 结合用户的人设特点和选择的脚本类型
3. 重点结合分脚本类型和爆款元素，让内容更具传播性
4. 选题要符合短视频平台的特点，简洁有力
5. 每个选题提供一个简要的内容说明（50字以内）
6. 输出格式为JSON数组，每个元素包含title和description字段

输出格式示例：
[
  {"title": "标题1", "description": "内容说明1"},
  {"title": "标题2", "description": "内容说明2"}
]

请直接输出JSON格式的结果，不要包含其他说明文字。`;
    },
    parse: 'jsonArray',
  },

  conversion: {
    label: '成交选题',
    recordTitle: i => `变现·${s(i.industryPersona, 20)}`,
    validate(b) {
      const industryPersona = s(b.industryPersona, 2000);
      if (!industryPersona) throw Object.assign(new Error('请输入行业和人设'), { status: 400 });
      const mainScript = s(b.mainScript, 50);
      if (!MAIN_SCRIPTS[mainScript]) throw Object.assign(new Error('主脚本不合法'), { status: 400 });
      const subScript = s(b.subScript, 50);
      if (subScript && !(MAIN_SCRIPTS[mainScript].subs.find(x => x[0] === subScript))) throw Object.assign(new Error('分脚本不合法'), { status: 400 });
      const reasons = Array.isArray(b.conversionReason) ? b.conversionReason.map(r => s(r, 50)).filter(r => CONVERSION_REASONS.find(x => x[0] === r)) : [];
      if (!reasons.length) throw Object.assign(new Error('请至少选择一个进店/成交理由'), { status: 400 });
      return { industryPersona, mainScript, subScript, conversionReason: reasons };
    },
    build(i) {
      const subScriptText = i.subScript ? `选择的分脚本：${i.subScript}` : '分脚本：随机选择';
      const reasonsText = i.conversionReason.join('、');
      return `你是一个专业的短视频高变现选题专家。请根据以下信息，为用户生成10个适配短视频平台的高变现选题。

用户信息：
- 行业和人设：${i.industryPersona}
- 选择的主脚本：${i.mainScript}
- ${subScriptText}
- 选择的进店/成交理由：${reasonsText}

请按照以下要求生成选题：
1. 每个选题都要有吸引人的标题
2. 结合用户的人设特点和选择的脚本类型
3. 重点结合分脚本类型和所有选择的进店/成交理由（${reasonsText}），让内容更具转化性
4. 选题要符合短视频平台的特点，简洁有力
5. 每个选题提供一个简要的内容说明（50字以内）
6. 输出格式为JSON数组，每个元素包含title和description字段

输出格式示例：
[
  {"title": "标题1", "description": "内容说明1"},
  {"title": "标题2", "description": "内容说明2"}
]

请直接输出JSON格式的结果，不要包含其他说明文字。`;
    },
    parse: 'jsonArray',
  },

  script: {
    label: '脚本创作',
    recordTitle: i => `脚本·${s(i.topicDescription, 20)}`,
    validate(b) {
      const topicDescription = s(b.topicDescription, 3000);
      if (!topicDescription) throw Object.assign(new Error('请输入选题及描述'), { status: 400 });
      return {
        topicDescription,
        industryPersona: s(b.industryPersona, 2000),
        otherRequirements: s(b.otherRequirements, 2000),
      };
    },
    build(i) {
      let promptInfo = `- 选题及描述：${i.topicDescription}`;
      if (i.industryPersona) promptInfo += `\n- 行业描述及人设：${i.industryPersona}`;
      promptInfo += `\n- 其他要求：${i.otherRequirements || '无'}`;
      return `你是一个专业的短视频脚本创作专家。请根据以下信息，为用户生成一篇符合短视频传播逻辑的文案逐字稿和详细的拍摄分镜头脚本。

用户信息：
${promptInfo}

请按照以下要求生成脚本：

1. 生成一篇短视频文案逐字稿，必须包含以下结构：
   - 爆款开头：吸引观众注意力的开场白
   - 核心内容：主体内容部分，逻辑清晰
   - 结尾金句：有力量的结尾，便于传播

2. 生成一篇详细的拍摄分镜头描述及对应文案，每个镜头包含：
   - 镜头序号
   - 景别（如：全景、中景、近景、特写等）
   - 画面内容描述
   - 对应文案/台词
   - 时长建议

3. 脚本要求：
   - 符合短视频平台特点，节奏明快
   - 语言生动有趣，易于理解
   - 如果用户提供了人设信息，请体现用户的人设特点
   - 考虑用户的其他要求

输出格式为JSON对象，包含以下字段：
{
  "script": {
    "opening": "爆款开头内容",
    "mainContent": "核心内容",
    "ending": "结尾金句"
  },
  "shots": [
    {
      "number": 1,
      "shotType": "景别",
      "description": "画面内容描述",
      "dialogue": "对应文案/台词",
      "duration": "时长建议"
    }
  ]
}

请直接输出JSON格式的结果，不要包含其他说明文字。`;
    },
    parse: 'jsonObject',
  },

  rewrite: {
    label: '文案二创',
    recordTitle: () => '文案二创',
    validate(b) {
      const originalContent = s(b.originalContent, 8000);
      if (!originalContent) throw Object.assign(new Error('请输入需要二创的原文案'), { status: 400 });
      return { originalContent };
    },
    build(i) {
      return `你是一个专业的短视频文案二创专家。请将以下原文案重新创作成一篇全新的、可以通过原创审核的文案。

原文案：
${i.originalContent}

请按照以下要求进行二创：

1. 内容替换：将原文案的内容完全重新表述，使用不同的词汇、句式和表达方式，确保能通过原创审核
2. 保持长度：生成的文案长度要与原文案基本保持一致，不要做内容删减
3. 传播逻辑：符合爆款短视频的传播逻辑，开头有吸引人的钩子，中间内容充实，结尾有力
4. 连贯性：文案要连贯流畅，不要使用分段标题、小标题或表情符号
5. 原汁原味：保持原文案的核心主旨和情感色彩不变
6. 语言风格：使用生动有趣、易于理解的语言

请直接输出二创后的文案内容，不要添加任何说明文字或分段标记。`;
    },
    parse: 'text',
  },

  analyze: {
    label: '爆款拆解',
    recordTitle: i => `拆解·${s(i.videoLink, 24)}`,
    validate(b) {
      const videoLink = s(b.videoLink, 500);
      if (!videoLink) throw Object.assign(new Error('请粘贴短视频链接'), { status: 400 });
      return { videoLink, videoNotes: s(b.videoNotes, 5000) };
    },
    build(i) {
      const extra = i.videoNotes ? `\n补充的视频文案/文字内容（若提供，优先依据此内容分析）：\n${i.videoNotes}\n` : '';
      return `你是一个专业的短视频爆款拆解分析专家。请根据用户提供的短视频链接，对这个爆款视频进行深度拆解分析。

视频链接：${i.videoLink}
${extra}
请按照以下结构进行分析，输出JSON格式的结果：

{
  "contentType": "内容类型（讲故事、教知识、晒过程、聊观点、产品介绍、其他）",
  "viralElements": "运用了哪些爆款元素（详细分析）",
  "targetAudience": "文案写作时面向的意向人群是哪些（详细描述）",
  "presentationStyle": "视频运用的哪种置景和呈现方式（详细说明）"
}

分析要求：
1. 内容类型：准确判断视频的核心内容类型
2. 爆款元素：分析视频中运用的具体爆款元素，如开头钩子、情绪调动、节奏把控等
3. 人群分析：明确视频的目标受众特征，包括年龄、性别、兴趣、需求等
4. 置景呈现：分析视频的场景设置、拍摄手法、视觉呈现等

请直接输出JSON格式的结果，不要包含其他说明文字。`;
    },
    parse: 'jsonObject',
  },

  wash: {
    label: '文案洗稿',
    recordTitle: () => '文案洗稿',
    validate(b) {
      const washOriginalContent = s(b.washOriginalContent, 8000);
      if (!washOriginalContent) throw Object.assign(new Error('请输入需要洗稿的原文案'), { status: 400 });
      return { washOriginalContent };
    },
    build(i) {
      return `你是一个专业的短视频文案洗稿专家。请将以下原文案改写成全新的文案，要求如下：

原文案：
${i.washOriginalContent}

洗稿要求：
1. 把原文改话术，不要与原文的文案一样
2. 改成同一个意思，保持核心主旨不变
3. 要求大白话和朋友聊天一样，通俗易懂
4. 形容词改成动词，让文案更生动
5. 避开专业术语，用口语化表达
6. 避开抖音最新的违规词敏感词
7. 改的话不要太官方，要接地气
8. 祛除Ai味，避免生硬的表达
9. 记得把原文的完全改了，但意思不要改
10. 改完生成后一定要可复制

请直接输出洗稿后的文案内容，不要添加任何说明文字或分段标记。`;
    },
    parse: 'text',
  },

  painpoint: {
    label: '痛点选题',
    recordTitle: i => `痛点·${s(i.industryBackground, 20)}`,
    validate(b) {
      const industryBackground = s(b.industryBackground, 2000);
      const targetCustomer = s(b.targetCustomer, 2000);
      if (!industryBackground) throw Object.assign(new Error('请输入行业背景'), { status: 400 });
      if (!targetCustomer) throw Object.assign(new Error('请输入目标客户'), { status: 400 });
      return { industryBackground, targetCustomer };
    },
    build(i) {
      return `你是一个专业的短视频内容策划专家。请根据以下信息，为用户生成50条口语化问句形式的痛点问题，用于抖音内容选题。

行业背景：${i.industryBackground}
目标客户：${i.targetCustomer}

请按照以下要求生成痛点问题：
1. 生成50条口语化问句形式的痛点问题
2. 每条问题都要用问号结尾
3. 问题要口语化，像朋友聊天一样自然
4. 问题要基于行业背景和目标客户的真实需求
5. 问题要能够引起目标客户的共鸣和思考
6. 每条问题都要简洁明了，不超过20个字
7. 问题要能够激发用户的好奇心和参与欲
8. 问题要符合抖音短视频的内容特点
9. 每条问题占一行，不要添加编号
10. 问题要真实可信，能够反映目标客户的实际困扰

请直接输出50条痛点问题，每行一条，不要添加任何说明文字或编号。`;
    },
    parse: 'lines',
  },

  copywrite: {
    label: '爆款仿写',
    recordTitle: () => '爆款仿写去重',
    validate(b) {
      const copywritingContent = s(b.copywritingContent, 8000);
      const copywritingPersona = s(b.copywritingPersona, 2000);
      if (!copywritingContent) throw Object.assign(new Error('请输入需要去重处理的爆款文案'), { status: 400 });
      if (!copywritingPersona) throw Object.assign(new Error('请输入您的行业和人设'), { status: 400 });
      return {
        copywritingContent,
        copywritingPersona,
        copywritingWordCount: s(b.copywritingWordCount, 50),
      };
    },
    build(i) {
      let wordCountRequirement = '';
      let wordCountEmphasis = '';
      if (i.copywritingWordCount) {
        const wordCount = parseInt(i.copywritingWordCount);
        if (wordCount >= 50 && wordCount <= 4000) {
          wordCountRequirement = `\n8. 【字数控制】每个版本的去重文案必须严格控制在${wordCount}字左右，尽量接近目标字数，不要超出太多，也不要太少`;
          wordCountEmphasis = `\n\n【重要提醒】用户要求的字数是${wordCount}字，每个版本必须尽量接近这个字数。如果原文较长，请在保留核心内容的前提下适当扩展；如果原文较短，请在保留原意的基础上适当丰富内容。绝对不要默认生成800字左右的文案，必须严格按照用户指定的${wordCount}字来生成。`;
        }
      }
      return `你是一个专业的短视频文案创作专家。请对用户提供的爆款文案进行去重处理，保持原汁原味。${wordCountEmphasis}

爆款文案：
${i.copywritingContent}

用户的行业和人设：
${i.copywritingPersona}

请按照以下要求进行处理：
1. 【保留开头钩子】必须完整保留原文的开头钩子（如"你绝对想不到"、"今天我要揭秘"、"很多人问我"等吸引眼球的开场白），一个字都不能改
2. 【保持原有结构】严格按照原文的结构框架：开头钩子→痛点/问题→解决方案→价值升华→结尾引导，不要增减环节
3. 【内容去重处理】识别并合并原文中重复表达的内容，删除冗余的句子和词语，让表达更精炼
4. 【核心内容不变】保留原文的核心观点、数据和关键信息，只做语言精简，不改变原意
5. 【行业适配】在保持上述要求的前提下，可适当调整专业术语以符合用户的行业人设
6. 保持口语化，适合短视频表达
7. 生成3-5个不同版本的去重文案，每个版本在去重力度上有所区别${wordCountRequirement}

请直接输出去重后的文案，每个版本之间用"---"分隔。`;
    },
    parse: 'text',
  },

  customtopic: {
    label: '自选选题',
    recordTitle: i => `自选·${s(i.topicDescription, 20)}`,
    validate(b) {
      const topicDescription = s(b.topicDescription, 2000);
      const contentDirection = s(b.contentDirection, 50);
      if (!topicDescription) throw Object.assign(new Error('请填写话题描述'), { status: 400 });
      if (!CONTENT_DIRECTIONS.includes(contentDirection)) throw Object.assign(new Error('请选择内容方向'), { status: 400 });
      return { topicDescription, contentDirection };
    },
    build(i) {
      return `你是一位专业的短视频选题策划专家，精通薛辉（薛辉小清新）的选题方法论。

请根据以下用户需求，运用薛辉选题方法论生成6个优质选题方案。

【用户需求】
话题描述：${i.topicDescription}
内容方向：${i.contentDirection}

【薛辉选题方法论核心框架】

一、八大爆款情绪元素（万能词根，所有选题的基础）
- 成本：金钱、时间成本，省钱/费时/低成本挑战
- 人群：锁定特定圈层，打造"自己人"归属感
- 猎奇：揭秘内幕、普通人接触不到的信息、行业秘密
- 反差：打破固有认知、预期冲突（最容易出爆款）
- 最差（负面避雷）：踩坑、翻车、行业套路，激发"避坑需求"
- 头牌：头部案例、名人、顶级方案、最贵/标杆案例
- 怀旧：唤醒集体记忆，情感共鸣
- 荷尔蒙：美感、形象、两性、吸引力相关

二、8套选题模板
1. 痛点直击选题：大众普遍烦恼 + 解决方案（戳痛→讲危害→给方法）
2. 结果前置选题：最终效果放在开头 + 实现路径
3. 正反反差/认知差选题：大众普遍认知 + 颠覆结论
4. 数字清单选题：数字 + 干货/避坑/步骤
5. 人群细分选题：精准人群 + 专属问题
6. 场景绑定选题：场景 + 当下难题
7. 避雷避坑选题：XX千万别做、90%的人踩过的坑
8. 悬念反问选题：用提问勾起好奇

三、4大内容体裁
- 教科普（教知识）：输出方法论、干货、避坑
- 聊观点：输出个人立场、评判争议话题
- 晒过程：实拍实操、挑战、案例全过程
- 讲故事：个人经历、客户案例、成败故事

【生成要求】
1. 为每个选题标注使用的情绪元素和选题模板
2. 为每个选题推荐最适合的内容体裁
3. 确保选题具有情绪调动性（焦虑、好奇、共鸣、恍然大悟）
4. 选题标题要吸引人，符合短视频平台调性
5. 结合用户选择的内容方向"${i.contentDirection}"进行侧重

【输出格式】
请按以下JSON格式输出，不要输出其他内容：
{
  "topics": [
    {
      "title": "选题标题",
      "element": "使用的情绪元素",
      "template": "使用的选题模板",
      "format": "推荐内容体裁",
      "reason": "选题亮点说明（50字以内）"
    }
  ]
}

请生成6个选题方案。`;
    },
    parse: 'jsonObject',
  },

  golden: {
    label: '黄金开头',
    recordTitle: i => `开头·${s(i.topic, 20)}`,
    validate(b) {
      const topic = s(b.topic, 2000);
      if (!topic) throw Object.assign(new Error('请输入视频主题'), { status: 400 });
      const styles = Array.isArray(b.styles) ? b.styles.filter(x => OPENING_STYLES.includes(x)) : [];
      if (!styles.length) throw Object.assign(new Error('请至少选择一种开头风格'), { status: 400 });
      const count = [3, 5, 8].includes(Number(b.count)) ? Number(b.count) : 3;
      return { topic, styles, count };
    },
    build(i) {
      const selectedStyleNames = i.styles.join('、');
      return `你是一位专业的短视频文案创作专家，精通薛辉的短视频创作方法论。请根据以下要求生成${i.count}个黄金开头文案：

视频主题：${i.topic}
开头风格：${selectedStyleNames}
生成数量：${i.count}个

薛辉黄金开头创作要点：
1. 前3秒必须抓住用户注意力，制造强烈的停留动机
2. 悬念型：用未完成的疑问或神秘感引发好奇
3. 反差型：用前后对比制造认知冲击
4. 痛点型：直接戳中用户焦虑或需求
5. 数据型：用具体数字增强可信度和冲击力
6. 故事型：用场景带入引发情感共鸣
7. 提问型：用问题引发思考和互动欲望
8. 利益型：明确告诉用户能得到什么好处
9. 权威型：借助背书增加可信度

请为每个开头生成：
1. 开头文案（15-30字，适合口语表达）
2. 使用的风格元素
3. 为什么有效的简要说明

请以JSON数组格式返回结果，格式如下：
[
  {
    "content": "开头文案内容",
    "style": "使用的风格",
    "reason": "为什么有效的说明"
  }
]

只返回JSON数组，不要有其他文字。`;
    },
    parse: 'jsonArray',
  },
};

module.exports = {
  FEATURES,
  MAIN_SCRIPTS, VIRAL_ELEMENTS, CONVERSION_REASONS,
  CONTENT_DIRECTIONS, OPENING_STYLES,
};
