const { getSetting } = require('../db');

// 多租户：天气城市归各租户库；缓存按经纬度区分（同城市共享结果，不同城市各自缓存）
const caches = new Map();
const cacheOf = (k) => { if (!caches.has(k)) caches.set(k, { data: null, ts: 0 }); return caches.get(k); };

// Open-Meteo 免费接口：无 key、按经纬度返回 7 天预报
async function fetchWeather(d) {
  const cfg = getSetting(d, 'weather', {});
  if (!cfg.lat || !cfg.lon) {
    return { ok: false, error: '尚未配置城市（请在设置中填写城市或经纬度）' };
  }
  const url =
    'https://api.open-meteo.com/v1/forecast?' +
    `latitude=${cfg.lat}&longitude=${cfg.lon}` +
    '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset' +
    '&timezone=auto&forecast_days=7';
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('天气接口错误 ' + res.status);
  return await res.json();
}


const WMO = {
  0: '晴', 1: '大部晴朗', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨',
  71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '强阵雨', 82: '暴雨',
  95: '雷暴', 96: '雷暴伴冰雹', 99: '强雷暴',
};
function codeText(c) { return WMO[c] || '未知'; }

async function getWeather(d, force = false) {
  const now = Date.now();
  // 未配置城市：直接返回，不进缓存——否则空结果会被缓存 30 分钟，
  // 配好城市后看板仍显示"未配置城市"（迁移部署后先开看板再配置时必现）
  const cfg = getSetting(d, 'weather', {});
  if (!cfg.lat || !cfg.lon) {
    return { ok: false, error: '尚未配置城市（请在设置中填写城市或经纬度）' };
  }
  const cache = cacheOf(`${cfg.lat},${cfg.lon}`);
  if (!force && cache.data && now - cache.ts < 30 * 60 * 1000) return cache.data;
  try {
    const raw = await fetchWeather(d);
    const daily = (raw.daily?.time || []).map((d, i) => ({
      date: d,
      code: raw.daily.weather_code[i],
      text: codeText(raw.daily.weather_code[i]),
      tmax: raw.daily.temperature_2m_max[i],
      tmin: raw.daily.temperature_2m_min[i],
      rain: raw.daily.precipitation_probability_max[i] ?? 0,
      sunrise: raw.daily.sunrise?.[i]?.slice(11) || '',
      sunset: raw.daily.sunset?.[i]?.slice(11) || '',
    }));
    if (!daily.length) return { ok: false, error: '天气接口未返回数据' }; // 异常响应同样不缓存
    const data = {
      ok: true,
      city: cfg.city || '',
      current: {
        temp: raw.current?.temperature_2m,
        humidity: raw.current?.relative_humidity_2m,
        wind: raw.current?.wind_speed_10m,
        text: codeText(raw.current?.weather_code),
      },
      daily,
      updated: new Date().toLocaleString('zh-CN'),
    };
    cache.data = data; cache.ts = now;
    return data;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 城市名 → 经纬度（Open-Meteo geocoding，中国大陆城市需加 country=CN 提升命中）
async function geocode(city) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await res.json();
  const hit = data.results?.[0];
  if (!hit) throw new Error('未找到城市：' + city);
  return { lat: hit.latitude, lon: hit.longitude, city: hit.name || city };
}

module.exports = { getWeather, geocode, codeText };
