// 农历/节气服务（零依赖，数据内置 1900-2100）
// 核心：LUNAR_INFO 表（每年 16 进制位图：闰月位置/大小月/农历年首日）
// 参考 lunar-calendar 公开算法整理。

// 1900-2100 每年农历信息
const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252, // 2090-2099
  0x0d520, // 2100
];

const LMONTH = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
const LDAY_PRE = ['初', '十', '廿', '三'];
const LDAY_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

// 24 节气（按小数年天数的通用近似表：20 世纪/21 世纪两套系数，1980 后用 [21世纪]）
const SOLAR_TERMS = ['小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满',
  '芒种', '夏至', '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至'];

function lYearDays(y) {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += (LUNAR_INFO[y - 1900] & i) ? 1 : 0;
  return sum + leapDays(y);
}
function leapMonth(y) { return LUNAR_INFO[y - 1900] & 0xf; }
function leapDays(y) {
  if (leapMonth(y)) return (LUNAR_INFO[y - 1900] & 0x10000) ? 30 : 29;
  return 0;
}
function monthDays(y, m) { return (LUNAR_INFO[y - 1900] & (0x10000 >> m)) ? 30 : 29; }

// 公历日期 → 农历 { year, month, day, isLeap, monthName, dayName, yearCyl, gzYear(干支) }
function solar2lunar(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const baseDate = new Date(1900, 0, 31);
  let offset = Math.floor((new Date(y, m - 1, d) - baseDate) / 86400000);
  let i;
  let temp = 0;
  for (i = 1900; i < 2101 && offset > 0; i++) {
    temp = lYearDays(i);
    offset -= temp;
  }
  if (offset < 0) { offset += temp; i--; }
  const lunarY = i;
  const leap = leapMonth(i);
  let isLeap = false;
  let j;
  for (j = 1; j < 13 && offset > 0; j++) {
    if (leap > 0 && j === leap + 1 && !isLeap) {
      j--; isLeap = true;
      temp = leapDays(lunarY);
    } else {
      temp = monthDays(lunarY, j);
    }
    if (isLeap && j === leap + 1) isLeap = false;
    offset -= temp;
  }
  if (offset === 0 && leap > 0 && j === leap + 1) {
    if (isLeap) { isLeap = false; }
    else { isLeap = true; j--; }
  }
  if (offset < 0) { offset += temp; j--; }
  const lunarM = j;
  const lunarD = offset + 1;
  return {
    year: lunarY, month: lunarM, day: lunarD, isLeap,
    monthName: (isLeap ? '闰' : '') + LMONTH[lunarM - 1] + '月',
    dayName: lunarDayName(lunarD),
    key: `${String(lunarM).padStart(2, '0')}-${String(lunarD).padStart(2, '0')}`,
  };
}
function lunarDayName(d) {
  if (d === 10) return '初十';
  if (d === 20) return '二十';
  if (d === 30) return '三十';
  return LDAY_PRE[Math.floor((d - 1) / 10)] + LDAY_NUM[(d - 1) % 10];
}

// 农历 → 公历（某年内）：农历生日映射当年公历日期。返回 'YYYY-MM-DD' 或 null（无效）
function lunar2solar(lunarYear, lunarM, lunarD, isLeap = false) {
  if (lunarYear < 1901 || lunarYear > 2100) return null;
  // 从公历 lunarYear-01-01 起逐日扫描该农历年，找到匹配的 (月, 闰, 日)。
  // 逐日扫描与 solar2lunar 完全同源，杜绝任何 off-by-one。
  const p = (n) => String(n).padStart(2, '0');
  const start = new Date(lunarYear, 0, 1);
  const end = new Date(lunarYear + 2, 0, 31); // 农历年可能跨到下一个公历年（腊月）
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const lu = solar2lunar(ds);
    if (lu.year === lunarYear && lu.month === lunarM && lu.day === lunarD && lu.isLeap === isLeap) return ds;
  }
  return null;
}

// 节气：某公历日期的节气名（无则 ''）
// 用通用 sDaemonGreGorianFormula（寿星通用公式）：D = Y*0.2422 + C - floor(Y/4)，21 世纪 C 值
const TERM_C21 = [5.4055, 20.12, 3.87, 18.73, 5.63, 20.646, 4.81, 20.1, 5.52, 21.04,
  5.678, 21.37, 7.108, 22.83, 7.5, 23.13, 7.646, 23.042, 8.318, 23.438, 7.438, 22.36, 7.18, 21.94];
const TERM_C20 = [6.11, 20.84, 4.6295, 19.4599, 6.3826, 21.4155, 5.59, 20.888, 6.318, 21.86,
  6.5, 22.2, 7.928, 23.65, 8.35, 23.95, 8.44, 23.822, 9.098, 24.218, 8.218, 23.08, 7.9, 22.6];
function solarTermOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (y < 1901 || y > 2099) return '';
  const C = y >= 2001 ? TERM_C21 : TERM_C20;
  const y2 = y % 100;
  // 每月两个节气：序号 (m-1)*2 和 (m-1)*2+1
  for (let k = 0; k < 2; k++) {
    const idx = (m - 1) * 2 + k;
    let day = Math.floor(y2 * 0.2422 + C[idx] - Math.floor(y2 / 4));
    // 闰年小修正极小，忽略；世纪年另算的年份极少，忽略
    if (d === day) return SOLAR_TERMS[idx];
  }
  return '';
}

// 某公历日期显示用的农历标签：初一显示月名，其余显示日名；有节气优先显示节气
function lunarLabelOf(dateStr) {
  const lu = solar2lunar(dateStr);
  const term = solarTermOf(dateStr);
  const dayLabel = lu.day === 1 ? lu.monthName : lu.dayName;
  return { lunar: dayLabel, term, full: lu.monthName + lu.dayName, key: lu.key, lunarDate: lu };
}

// 星座：按公历月日（交界日按标准分界）
const ZODIAC = [
  { name: '摩羯座', from: [12, 22] }, { name: '水瓶座', from: [1, 20] },
  { name: '双鱼座', from: [2, 19] }, { name: '白羊座', from: [3, 21] },
  { name: '金牛座', from: [4, 20] }, { name: '双子座', from: [5, 21] },
  { name: '巨蟹座', from: [6, 22] }, { name: '狮子座', from: [7, 23] },
  { name: '处女座', from: [8, 23] }, { name: '天秤座', from: [9, 23] },
  { name: '天蝎座', from: [10, 24] }, { name: '射手座', from: [11, 23] },
  { name: '摩羯座', from: [12, 22] }, // 环形收尾（12/22-12/31 摩羯）
];
function zodiacOf(dateStr) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(dateStr || '').trim());
  if (!m) return '';
  const month = Number(m[2]), day = Number(m[3]);
  let cur = ZODIAC[0].name;
  for (const z of ZODIAC) {
    const [zm, zd] = z.from;
    if (month === zm && day >= zd) cur = z.name;
    // 月内早于起始日的保持上一个；跨年环形由首尾摩羯座覆盖
  }
  // 按月份直接判定：找该月出生日起始的星座
  const inMonth = ZODIAC.filter((z) => z.from[0] === month);
  if (inMonth.length) {
    const hit = inMonth.find((z) => day >= z.from[1]);
    return hit ? hit.name : (month === 1 ? '摩羯座' : (ZODIAC.find((z) => z.from[0] === month - 1) || { name: '' }).name);
  }
  return cur;
}

// 生肖：按农历年判定（正月初一分界，非公历元旦）——solar2lunar 本身就以春节切年，
// 所以公历生日在春节前会落到上一个农历年，生肖随之正确（如 1990-01-25 属蛇不属马）。
const ANIMALS = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪']; // 1900 年为鼠年
function animalOf(dateStr) {
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(String(dateStr || '').trim())) return '';
  const lu = solar2lunar(String(dateStr).trim());
  return ANIMALS[((lu.year - 1900) % 12 + 12) % 12];
}

module.exports = { solar2lunar, lunar2solar, solarTermOf, lunarLabelOf, LMONTH, lunarDayName, zodiacOf, animalOf };
