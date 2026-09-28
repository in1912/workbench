// MIoT-Spec 参数中英对照词典（2026-09 v1.6.15）
// 数据来源：miot-spec.org 通用规范命名惯例 + 用户实有设备（开关/插座/窗帘/摄像头/门锁/音箱/
// 扫地机/传感器/浴霸/空调/净化器/风扇/灯/遥控/香薰/中控面板等）的 spec 实测。
// 用途：① 设备详情页服务/属性/动作/枚举值的中文名；② 「参数翻译」tab 分组展示（可搜索）。
export const TERM_GROUPS = [
  {
    title: '服务 Services（设备的功能模块，siid）',
    pairs: [
      ['switch', '开关'], ['light', '灯光'], ['indicator', '指示灯'], ['power', '电源'],
      ['battery', '电池'], ['device-information', '设备信息'], ['maintenance', '维护'], ['fault', '故障'],
      ['time', '时间'], ['schedule', '定时'], ['cycle-timing', '循环定时'], ['countdown', '倒计时'],
      ['countdown-timer', '倒计时'], ['do-not-disturb', '免打扰'], ['physical-controls-locked', '物理按键锁定'],
      ['alarm', '报警'], ['scene', '场景'], ['group-control', '分组控制'], ['sensor', '传感器'],
      ['temperature-humidity-sensor', '温湿度传感器'], ['temperature-sensor', '温度传感器'],
      ['humidity-sensor', '湿度传感器'], ['occupancy-sensor', '人体传感器'], ['motion-sensor', '人体传感器'],
      ['illumination-sensor', '光照传感器'], ['illuminance-sensor', '光照度传感器'],
      ['door-sensor', '门磁传感器'], ['magnet-sensor', '门窗磁传感器'], ['contact-sensor', '门磁传感器'],
      ['smoke-sensor', '烟雾传感器'], ['gas-sensor', '燃气传感器'], ['water-sensor', '水浸传感器'],
      ['lock', '门锁'], ['camera', '摄像头'], ['video-doorbell', '可视门铃'], ['curtain', '窗帘'],
      ['blind', '百叶帘'], ['air-conditioner', '空调'], ['air-purifier', '空气净化器'],
      ['air-freshener', '新风机'], ['heater', '取暖器'], ['bath-heater', '浴霸'], ['fan', '风扇'],
      ['humidifier', '加湿器'], ['dehumidifier', '除湿机'], ['kettle', '电水壶'], ['cooker', '电饭煲'],
      ['rice-cooker', '电饭煲'], ['pressure-cooker', '电压力锅'], ['induction-cooker', '电磁炉'],
      ['microwave-oven', '微波炉'], ['oven', '烤箱'], ['refrigerator', '冰箱'], ['washer', '洗衣机'],
      ['dishwasher', '洗碗机'], ['vacuum-cleaner', '扫地机器人'], ['robot-cleaner', '扫地机器人'],
      ['robot-vacuum', '扫地机器人'], ['mopping-robot', '拖地机器人'], ['speaker', '音箱'],
      ['play-control', '播放控制'], ['volume', '音量'], ['tts', '语音播报'], ['voice', '语音助手'],
      ['infrared-controller', '红外遥控'], ['remote-control', '遥控器'], ['button', '按钮'],
      ['button-controller', '按键控制器'], ['gateway', '网关'], ['subdevice', '子设备'],
      ['electric-blanket', '电热毯'], ['mosquito-repeller', '驱蚊器'], ['aromatherapy', '香薰机'],
      ['diffuser', '香薰机'], ['pet-feeder', '宠物喂食器'], ['pet-water-feeder', '宠物饮水机'],
      ['clothes-rack', '晾衣架'], ['airer', '晾衣架'], ['water-purifier', '净水器'],
      ['plant-monitor', '植物监护'], ['clean', '清洁'], ['brush-clean', '滚刷清洁'],
      ['filter-core', '滤芯'], ['screen', '屏幕'], ['screen-lock', '屏幕锁'], ['match', '匹配'],
      ['pair', '配对'], ['adjust-brightness', '亮度调节'], ['adjust-color', '色彩调节'],
      ['environment', '环境'], ['air-monitor', '空气监测'], ['pm25-sensor', 'PM2.5 传感器'],
      ['carbon-dioxide-sensor', '二氧化碳传感器'], ['formaldehyde-sensor', '甲醛传感器'],
      ['custom', '自定义'], ['other', '其他'], ['settings', '设置'], ['notification', '通知提醒'],
    ],
  },
  {
    title: '属性 Properties（可读/可写的状态项，piid）',
    pairs: [
      ['on', '开/关'], ['status', '状态'], ['mode', '模式'], ['fault', '故障'], ['battery-level', '电量'],
      ['charging-state', '充电状态'], ['voltage', '电压'], ['electric-current', '电流'], ['current', '电流'],
      ['power-consumption', '用电量'], ['electric-power', '功率'], ['brightness', '亮度'],
      ['brightness-level', '亮度档位'], ['color', '色彩'], ['color-temperature', '色温'],
      ['color-temperature-level', '色温档位'], ['speed-level', '风速档位'], ['fan-level', '风速档位'],
      ['gear-level', '档位'], ['wind-level', '风力档位'], ['swing', '摆风'], ['oscillating', '摇头'],
      ['horizontal-swing', '左右摆风'], ['vertical-swing', '上下摆风'], ['angle', '角度'],
      ['horizontal-angle', '水平角度'], ['vertical-angle', '垂直角度'], ['temperature', '温度'],
      ['target-temperature', '目标温度'], ['current-temperature', '当前温度'],
      ['indoor-temperature', '室内温度'], ['outdoor-temperature', '室外温度'],
      ['temperature-level', '温度档位'], ['humidity', '湿度'], ['target-humidity', '目标湿度'],
      ['current-humidity', '当前湿度'], ['relative-humidity', '相对湿度'], ['co2-density', '二氧化碳浓度'],
      ['pm2.5-density', 'PM2.5 浓度'], ['pm25-density', 'PM2.5 浓度'], ['tvoc-density', 'TVOC 浓度'],
      ['hcho-density', '甲醛浓度'], ['illumination', '光照度'], ['light-intensity', '光照强度'],
      ['motion-state', '人体感应状态'], ['is-someone-detected', '是否检测到人'],
      ['no-one-duration', '无人时长'], ['someone-duration', '有人时长'], ['open', '开启/开门'],
      ['open-state', '开合状态'], ['door-state', '门窗状态'], ['latch-state', '锁舌状态'],
      ['lock-state', '上锁状态'], ['abnormal-state', '异常状态'], ['armed-mode', '布防模式'],
      ['alarm-volume', '报警音量'], ['melody', '铃声'], ['ring-tone', '铃声'], ['volume', '音量'],
      ['mute', '静音'], ['backlight', '背光'], ['indicator-light', '指示灯'], ['on-duration', '开启时长'],
      ['off-duration', '关闭时长'], ['delay', '延时'], ['remaining-time', '剩余时间'],
      ['keep-warm', '保温'], ['keep-warm-time', '保温时长'], ['cook-mode', '烹饪模式'],
      ['taste', '口感'], ['rice', '米量'], ['water-level', '水位'],
      ['water-shortage-fault', '缺水提醒'], ['dry', '烘干'], ['drying-level', '烘干档位'],
      ['anion', '负离子'], ['uv', 'UV 杀菌'], ['sterilize', '杀菌'], ['ess-oil-level', '精油余量'],
      ['spray-level', '喷雾档位'], ['spray-amount', '喷雾量'], ['motor-control', '电机控制'],
      ['motor-mode', '电机模式'], ['current-position', '当前位置'], ['target-position', '目标位置'],
      ['position', '位置'], ['calibration', '校准'], ['direction', '方向'], ['left-position', '左侧位置'],
      ['right-position', '右侧位置'], ['tilt-angle', '俯仰角'], ['weight', '重量'],
      ['pet-food', '宠物粮'], ['feed-record', '喂食记录'], ['screen-lock', '屏幕锁定'],
      ['child-lock', '童锁'], ['sleep-mode', '睡眠模式'], ['eco-mode', '节能模式'],
      ['heat-level', '取暖档位'], ['ventilation-level', '换气档位'], ['blow', '吹风'],
      ['light', '照明'], ['display', '显示屏'], ['work-mode', '工作模式'], ['clean-mode', '清扫模式'],
      ['suction-level', '吸力档位'], ['water-level-adjust', '水量调节'], ['mop', '拖布'],
      ['battery', '电池电量'], ['map', '地图'], ['volume-level', '音量档位'], ['loop-mode', '循环模式'],
      ['play-mode', '播放模式'], ['channel', '频道'], ['signal-strength', '信号强度'], ['rssi', '信号强度'],
      ['mac-address', 'MAC 地址'], ['device-name', '设备名称'], ['manufacturer', '制造商'],
      ['serial-number', '序列号'], ['firmware-revision', '固件版本'], ['hardware-revision', '硬件版本'],
      ['model', '型号'], ['ip-address', 'IP 地址'], ['life', '使用寿命'], ['left-time', '剩余时间'],
      ['filter-life-level', '滤芯寿命'], ['filter-left-time', '滤芯剩余时间'], ['language', '语言'],
      ['time', '时间'], ['work-status', '工作状态'], ['brush-left-time', '滚刷剩余时间'],
      ['side-brush-left-time', '边刷剩余时间'], ['sensor-dirty', '传感器脏污'], ['dust-full', '尘盒已满'],
      ['mop-life-level', '拖布寿命'], ['clean-area', '清扫面积'], ['clean-time', '清扫时长'],
      ['total-clean-area', '累计清扫面积'], ['total-clean-time', '累计清扫时长'], ['clean-count', '清扫次数'],
    ],
  },
  {
    title: '动作 Actions（可执行的指令，aiid）',
    pairs: [
      ['toggle', '切换开关'], ['turn-on', '打开'], ['turn-off', '关闭'], ['start', '启动'],
      ['stop', '停止'], ['pause', '暂停'], ['play', '播放'], ['play-pause', '播放/暂停'],
      ['next', '下一曲/下一个'], ['previous', '上一曲/上一个'], ['volume-up', '音量+'], ['volume-down', '音量−'],
      ['mute', '静音'], ['reset', '重置'], ['identify', '寻找设备'], ['ring', '响铃'],
      ['toggle-swing', '切换摆风'], ['calibration', '校准'], ['feed', '喂食'], ['feed-now', '立即喂食'],
      ['manual-feed', '手动喂食'], ['clean', '开始清扫'], ['stop-cleaning', '停止清扫'],
      ['return-to-dock', '回充'], ['return', '回充'], ['find-robot', '寻找扫地机'],
      ['start-clean', '开始清扫'], ['pause-clean', '暂停清扫'], ['set-position', '设置位置'],
      ['play-sound', '播放提示音'], ['speak', '语音播报'], ['scan', '扫描'], ['pair', '配对'],
      ['unpair', '取消配对'], ['add', '添加'], ['remove', '移除'], ['upgrade', '升级'],
    ],
  },
  {
    title: '枚举值 Values（下拉选项的常见取值）',
    pairs: [
      ['idle', '空闲'], ['busy', '忙碌'], ['off', '关闭'], ['on', '开启'], ['none', '无'],
      ['low', '低'], ['middle', '中'], ['high', '高'], ['auto', '自动'], ['manual', '手动'],
      ['sleep', '睡眠'], ['eco', '节能'], ['standard', '标准'], ['strong', '强力'], ['turbo', '强力'],
      ['max', '最大'], ['min', '最小'], ['silent', '静音'], ['heat', '制热'], ['cool', '制冷'],
      ['fan', '送风'], ['dry', '除湿'], ['ventilation', '换气'], ['heat-ventilation', '暖风换气'],
      ['blow', '吹风'], ['dryout', '干燥'], ['left', '左'], ['right', '右'], ['up', '上升'],
      ['down', '下降'], ['stop', '停止'], ['pause', '暂停'], ['normal', '正常'], ['abnormal', '异常'],
      ['charging', '充电中'], ['not-charging', '未充电'], ['charged', '已充满'], ['yes', '是'], ['no', '否'],
      ['open', '开'], ['close', '关'], ['opening', '正在开'], ['closing', '正在关'], ['opened', '已开'],
      ['closed', '已关'], ['locked', '已上锁'], ['unlocked', '已开锁'], ['someone', '有人'],
      ['no-one', '无人'], ['day', '白天'], ['night', '夜晚'], ['home', '在家'], ['away', '离家'],
      ['sweep', '扫地'], ['mop', '拖地'], ['sweep-mop', '扫拖'],
      ['whole', '全屋'], ['room', '房间'], ['spot', '定点'], ['edge', '沿边'], ['zone', '区域'],
      ['level1', '1 档'], ['level2', '2 档'], ['level3', '3 档'], ['level4', '4 档'], ['level5', '5 档'],
      ['mute', '静音'], ['medium', '中等'], ['small', '小'], ['large', '大'], ['warm', '暖光'],
      ['cold', '冷光'], ['nature', '自然'], ['quick', '快速'], ['slow', '慢速'], ['continuous', '连续'],
    ],
  },
  {
    title: '规格术语 Spec（详情页里的字段）',
    pairs: [
      ['siid', '服务编号'], ['piid', '属性编号'], ['eiid', '事件编号'], ['aiid', '动作编号'],
      ['urn', '设备规格标识'], ['format', '数据类型'], ['access', '读写权限'], ['unit', '单位'],
      ['bool', '布尔（开/关）'], ['uint8', '8 位无符号整数'], ['uint16', '16 位无符号整数'],
      ['uint32', '32 位无符号整数'], ['int8', '8 位整数'], ['int16', '16 位整数'], ['int32', '32 位整数'],
      ['float', '浮点数'], ['string', '字符串'], ['read', '可读'], ['write', '可写'], ['notify', '可上报'],
    ],
  },
];

// 展平查询表（key 统一小写）
export const ZH = (() => {
  const m = new Map();
  for (const g of TERM_GROUPS) for (const [en, zh] of g.pairs) if (en && zh && !m.has(en.toLowerCase())) m.set(en.toLowerCase(), zh);
  return m;
})();

// 查中文：命中返回中文，未命中返回 ''（调用方回退显示原文）
export function zh(name) {
  if (!name) return '';
  const k = String(name).trim().toLowerCase();
  return ZH.get(k) || '';
}
