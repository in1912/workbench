// 中国节日/假期服务：从可配置的 API 拉取，缓存当天结果
// 多租户：数据源配置（holiday_api）按共享开关路由——共享=主库统一配置，独立=各租户自配。
// 缓存按 数据源类型|URL|年|日 天然区分（不同租户配不同 API 时互不串）。
const { getSettingR, setSettingR } = require('../db');

const caches = new Map();

function getConfig(tdb) {
  return getSettingR(tdb, 'holiday_api', {
    url: 'https://timor.tech/api/holiday/year/$(year)',
    type: 'timor',  // timor | apizero
  });
}
function saveConfig(tdb, cfg) {
  setSettingR(tdb, 'holiday_api', {
    url: cfg.url || '',
    type: cfg.type || 'timor',
  });
}

// 获取指定年份的节假日数据，返回 { [MM-DD]: { name, holiday, isToday, desc } }
async function getHolidays(tdb, year) {
  const cfg = getConfig(tdb);
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = `${cfg.type}|${cfg.url || ''}|${year}|${today}`;
  if (caches.has(cacheKey)) return caches.get(cacheKey);
  try {
    let data = {};
    if (cfg.type === 'timor') {
      const url = `https://timor.tech/api/holiday/year/${year}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      if (j.code === 0 && j.holiday) {
        for (const [dateStr, info] of Object.entries(j.holiday)) {
          // timor 格式: "01-01": { holiday: true, name: "元旦" }（键就是 MM-DD）
          const key = dateStr.replace(/^-/, '');
          data[key] = {
            name: info.name || '',
            holiday: !!info.holiday,
            desc: info.desc || '',
          };
        }
      }
    } else if (cfg.type === 'apizero') {
      const url = `https://v1.apizero.cn/api/holiday?year=${year}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      if (j.code === 0 && j.data && Array.isArray(j.data)) {
        for (const info of j.data) {
          data[info.date.slice(5)] = {
            name: info.name || info.holidayName || '',
            holiday: !!info.holiday,
            desc: info.desc || '',
          };
        }
      }
    }
    caches.set(cacheKey, data);
    // 缓存上限保护（按天+按源的键量很小，正常不会触顶）
    if (caches.size > 60) {
      const first = caches.keys().next().value;
      caches.delete(first);
    }
    return data;
  } catch (e) {
    console.warn('[holiday] 拉取失败:', e.message);
    return {};
  }
}

module.exports = { getConfig, saveConfig, getHolidays };
