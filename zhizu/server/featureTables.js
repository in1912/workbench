// 功能表单元数据（服务端下发，前端动态渲染表单 + 选项常量同源）
const {
  MAIN_SCRIPTS, VIRAL_ELEMENTS, CONVERSION_REASONS,
  CONTENT_DIRECTIONS, OPENING_STYLES,
} = require('./features');

// 主脚本选项表（viral / conversion 共用）
function mainScriptOptions() {
  return Object.entries(MAIN_SCRIPTS).map(([name, v]) => ({
    value: name,
    desc: v.desc,
    subs: v.subs.map(([sname, sdesc]) => ({ value: sname, label: `${sname}：${sdesc}` })),
  }));
}

function featureTables() {
  const personaField = key => ({
    key, type: 'textarea', label: '第一步：请输入您的行业和人设',
    placeholder: '请输入您的行业和人设信息，越详细越好，例如：美妆博主，专注敏感肌护理，有5年经验...',
    persona: true, required: true,
  });

  return {
    mainScripts: mainScriptOptions(),
    viralElements: VIRAL_ELEMENTS.map(([v, d]) => ({ value: v, desc: d })),
    conversionReasons: CONVERSION_REASONS.map(([v, d]) => ({ value: v, desc: d })),
    contentDirections: CONTENT_DIRECTIONS,
    openingStyles: OPENING_STYLES,

    features: {
      viral: {
        label: '我要做爆款', icon: '🔥', accent: 'green',
        button: '生成爆款选题', resultLabel: '爆款选题',
        fields: [
          personaField('industryPersona'),
          { key: 'mainScript', type: 'mainscript', label: '第二步：主脚本选择', required: true },
          { key: 'viralElement', type: 'radio-cards', label: '第三步：爆款元素选择', options: VIRAL_ELEMENTS.map(([v, d]) => ({ value: v, desc: d })), required: true },
        ],
      },
      conversion: {
        label: '成交选题', icon: '📈', accent: 'green',
        button: '生成高变现选题',
        fields: [
          personaField('industryPersona'),
          { key: 'mainScript', type: 'mainscript', label: '第二步：主脚本选择', required: true },
          { key: 'conversionReason', type: 'check-cards', label: '第三步：进店/成交理由选择', options: CONVERSION_REASONS.map(([v, d]) => ({ value: v, desc: d })), required: true },
        ],
      },
      script: {
        label: '脚本创作', icon: '🎬', accent: 'green',
        button: '生成文案脚本',
        fields: [
          { key: 'topicDescription', type: 'textarea', label: '第一步：请输入您的选题及描述', placeholder: '请输入您的选题及描述，例如：如何选择适合敏感肌的护肤品...', required: true },
          { key: 'industryPersona', type: 'textarea', label: '第二步：行业描述及人设（选填）', placeholder: '请输入您的行业和人设信息，越详细越好，例如：美妆博主，专注敏感肌护理，有5年经验...', persona: true },
          { key: 'otherRequirements', type: 'textarea', label: '第三步：其他要求（选填）', placeholder: '请输入您的其他要求，例如文案字数、视频时长、整体风格等......' },
        ],
      },
      rewrite: {
        label: '文案二创', icon: '🔄', accent: 'green',
        button: '生成二创文案',
        fields: [
          { key: 'originalContent', type: 'textarea', label: '第一步：请输入原文案', placeholder: '请输入您需要二次创作的原文案...', required: true, rows: 8 },
        ],
      },
      analyze: {
        label: '爆款拆解', icon: '🔍', accent: 'green',
        button: '爆款拆解',
        fields: [
          { key: 'videoLink', type: 'textarea', label: '第一步：请粘贴短视频链接', placeholder: '请粘贴短视频链接，例如抖音、快手、小红书等平台的视频链接...', required: true, rows: 2 },
          { key: 'videoNotes', type: 'textarea', label: '补充：视频文案/文字内容（选填，纯文本模型建议提供）', placeholder: '可粘贴视频口播文案或文字描述，让拆解更准确...' },
        ],
      },
      wash: {
        label: '文案洗稿', icon: '✨', accent: 'green',
        button: '洗稿',
        fields: [
          { key: 'washOriginalContent', type: 'textarea', label: '第一步：请输入需要洗稿的原文案', placeholder: '请输入您需要洗稿的原文案...', required: true, rows: 8 },
        ],
      },
      painpoint: {
        label: '痛点选题', icon: '💡', accent: 'green',
        button: '挖出用户痛点',
        fields: [
          { key: 'industryBackground', type: 'textarea', label: '行业背景', placeholder: '比如我是干了7年的宠物医生，目前有一家宠物医院', required: true, rows: 2 },
          { key: 'targetCustomer', type: 'textarea', label: '目标客户', placeholder: '比如：想要养猫狗的家庭客户', required: true, rows: 2 },
        ],
      },
      copywrite: {
        label: '爆款仿写', icon: '📋', accent: 'green',
        button: '去重处理',
        fields: [
          { key: 'copywritingContent', type: 'textarea', label: '第一步：请输入需要去重处理的爆款文案', placeholder: '请输入需要去重处理的爆款文案...', required: true, rows: 8 },
          { key: 'copywritingPersona', type: 'textarea', label: '第二步：您的行业和人设', placeholder: '例如：我是做宠物行业的，有7年宠物医生经验...', persona: true, required: true, rows: 2 },
          { key: 'copywritingWordCount', type: 'input', label: '目标字数（选填）', placeholder: '请输入目标字数（如：200-300字）' },
        ],
      },
      customtopic: {
        label: '自选选题', icon: '✏️', accent: 'green',
        button: '生成选题方案',
        fields: [
          { key: 'topicDescription', type: 'textarea', label: '话题描述', placeholder: '描述你想做的内容方向，例如：想做面向宝妈的辅食制作内容...', required: true },
          { key: 'contentDirection', type: 'radio-tags', label: '内容方向', options: CONTENT_DIRECTIONS.map(v => ({ value: v })), required: true },
        ],
      },
      golden: {
        label: '黄金开头', icon: '⚡', accent: 'orange',
        button: '生成黄金开头',
        fields: [
          { key: 'topic', type: 'textarea', label: '视频主题', placeholder: '例如：如何用手机拍出电影感大片、新手健身必看的5个误区、月薪3000如何存下第一桶金...', required: true, rows: 3 },
          { key: 'styles', type: 'check-tags', label: '开头风格（可多选）', options: OPENING_STYLES.map(v => ({ value: v })), required: true },
          { key: 'count', type: 'radio-tags', label: '生成数量', options: [{ value: '3', label: '3个' }, { value: '5', label: '5个' }, { value: '8', label: '8个' }], required: true, def: '3' },
        ],
      },
    },
  };
}

module.exports = { featureTables };
