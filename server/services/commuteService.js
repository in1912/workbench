const { getSetting, setSetting, getAmapKey, saveAmapKey } = require('../db');

// 多租户：通勤地址/时间归租户库 settings.commute；高德 Key 独立成 amap_key 键按共享开关路由。
// 缓存按 "home|work" 区分（不同租户地址不同天然隔离；地址相同共享结果无妨）
const caches = new Map();
const cacheOf = (k) => { if (!caches.has(k)) caches.set(k, { data: null, ts: 0 }); return caches.get(k); };
const cacheKeyOf = (home, work, mode) => `${home}|${work}|${normMode(mode)}`;

const DEFAULT_REFRESH_TIMES = ['07:00', '17:00'];
// 出行方式（v1.3.4）：首页通勤时间按此选路线类型。driving=v3驾车(带路况) / walking=v3步行 /
// bicycling=v3骑行 / electrobike=v5电动车（失败自动回落骑行）
const MODES = ['driving', 'walking', 'bicycling', 'electrobike'];
const MODE_LABELS = { driving: '驾车', walking: '步行', bicycling: '骑自行车', electrobike: '电动车' };
function normMode(m) { return MODES.includes(m) ? m : 'driving'; }

function getConfig(d) {
  const c = getSetting(d, 'commute', {
    home: '', work: '', work_start: '09:00', work_end: '18:00', refresh_times: DEFAULT_REFRESH_TIMES, mode: 'driving',
  });
  // key 从共享/独立的 amap_key 取（旧 commute.key 已在多租户迁移时拆出）
  return { ...c, key: getAmapKey(d) };
}

function saveConfig(d, cfg) {
  const times = Array.isArray(cfg.refresh_times) && cfg.refresh_times.length
    ? cfg.refresh_times.filter(Boolean).map((t) => String(t).slice(0, 5))
    : DEFAULT_REFRESH_TIMES;
  setSetting(d, 'commute', {
    home: (cfg.home || '').trim(),
    work: (cfg.work || '').trim(),
    work_start: cfg.work_start || '09:00',
    work_end: cfg.work_end || '18:00',
    refresh_times: times,
    mode: normMode(cfg.mode), // 出行方式：驾车/步行/骑自行车/电动车
  });
  if (cfg.key !== undefined && cfg.key !== null) saveAmapKey(d, cfg.key); // 共享开→写主库；关→写租户库
  const ck = cacheKeyOf((cfg.home || '').trim(), (cfg.work || '').trim());
  caches.set(ck, { data: null, ts: 0 });
}

async function geocode(key, address) {
  const url = `https://restapi.amap.com/v3/geocode/geo?key=${encodeURIComponent(key)}&address=${encodeURIComponent(address)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await res.json();
  if (data.status !== '1' || !data.geocodes?.length) {
    throw new Error(`无法定位地址「${address}」：${data.info || '未找到'}`);
  }
  const g = data.geocodes[0];
  return { location: g.location, adcode: g.adcode || '' }; // location: "lng,lat"
}

async function route(key, origin, destination, mode = 'driving') {
  mode = normMode(mode);
  // 各方式 API：驾车 v3（带策略）；步行/骑行 v3；电动车 v5（个别 Key 未开通时回落骑行）
  const base = 'https://restapi.amap.com';
  const qs = `?key=${encodeURIComponent(key)}&origin=${origin}&destination=${destination}`;
  const url =
    mode === 'walking' ? base + '/v3/direction/walking' + qs :
    mode === 'bicycling' ? base + '/v3/direction/bicycling' + qs :
    mode === 'electrobike' ? base + '/v5/direction/electrobike' + qs :
    base + '/v3/direction/driving' + qs + '&strategy=10';
  let res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  let data = await res.json();
  if ((data.status !== '1' && data.status !== 1) || !data.route?.paths?.length) {
    if (mode === 'electrobike') {
      // v5 电动车未开通/失败：回落 v3 骑行（时间略保守但不至于不可用）
      res = await fetch(base + '/v3/direction/bicycling' + qs, { signal: AbortSignal.timeout(15000) });
      data = await res.json();
    }
    if ((data.status !== '1' && data.status !== 1) || !data.route?.paths?.length) {
      throw new Error('路线规划失败：' + (data.info || data.msg || '未知错误'));
    }
  }
  // v3 与 v5 的 path 结构差异吸收：duration 可能在 path.duration（v3）或 path.cost.duration（v5）
  const p = data.route.paths[0];
  // 合并 steps 的 polyline 为完整坐标点串（"lng,lat;lng,lat;..."），
  // 同时保留每 step 的道路名与分段 polyline，供交通态势查询与前端分段着色
  const points = [];
  const steps = [];
  for (const step of p.steps || []) {
    if (step.polyline) {
      steps.push({ name: step.road || '', polyline: step.polyline });
      for (const pair of String(step.polyline).split(';')) {
        if (pair.includes(',')) points.push(pair);
      }
    }
  }
  return {
    duration_sec: Number(p.duration) || Number(p.cost?.duration) || 0,
    distance_m: Number(p.distance) || 0,
    polyline: points.join(';'),
    steps,
  };
}

// 交通态势查询（高德免费 API）：按道路名查实时拥堵等级
// status: 0畅通 1缓行 2拥堵 3严重拥堵
async function roadTraffic(key, adcode, names) {
  const map = {};
  const uniq = [...new Set(names.filter(Boolean))];
  if (!adcode || !uniq.length) return map;
  await Promise.all(uniq.map(async (name) => {
    try {
      const url =
        `https://restapi.amap.com/v3/traffic/status/road?key=${encodeURIComponent(key)}` +
        `&name=${encodeURIComponent(name)}&adcode=${encodeURIComponent(adcode)}&extensions=all`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      if (d.status === '1' && d.trafficinfo?.roads?.length) {
        map[name] = Number(d.trafficinfo.roads[0].status) || 0;
      }
    } catch (e) { /* 单条道路查询失败不影响整体 */ }
  }));
  return map;
}

function calcEta(now, durationSec) {
  const eta = new Date(now.getTime() + durationSec * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(eta.getHours())}:${pad(eta.getMinutes())}`;
}

// 按固定时刻（上下班时间）加减分钟，而非当前时间
function addMin(timeStr, minutes) {
  const [h, m] = String(timeStr || '0:0').split(':').map(Number);
  const total = (((h || 0) * 60 + (m || 0) + Math.round(minutes || 0)) % 1440 + 1440) % 1440;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

// 从地址提取市级名称（交通态势 API 需要市级 adcode，区级不返回数据）
function cityFromAddress(addr) {
  const m = String(addr || '').match(/([\u4e00-\u9fa5]+?市)/);
  return m ? m[1] : '';
}

async function calcCommute(d, force = false) {
  const now = Date.now();
  // 配额保护：非强制刷新（打开页面等）一律返回缓存，即使过期也不重算；
  // 只有定时任务（每天 07:00/17:00）和手动刷新（force=true）才重新调用高德接口
  const cfg = getConfig(d);
  const cache = cacheOf(cacheKeyOf(cfg.home, cfg.work, cfg.mode));
  if (!force && cache.data) return cache.data;
  if (!cfg.home || !cfg.work) return { ok: false, error: '尚未设置通勤地址（设置 → 通勤）' };
  if (!cfg.key) return { ok: false, error: '尚未配置地图 Key（设置 → 通勤，高德开放平台免费申请）' };
  try {
    const [homeGeo, workGeo] = await Promise.all([
      geocode(cfg.key, cfg.home),
      geocode(cfg.key, cfg.work),
    ]);
    const homeLoc = homeGeo.location;
    const workLoc = workGeo.location;
    // 交通态势查询用市级 adcode（geocode 详细地址返回区级，需按城市名重查）
    let adcode = homeGeo.adcode || workGeo.adcode;
    const city = cityFromAddress(cfg.home) || cityFromAddress(cfg.work);
    if (city) {
      try {
        const cityGeo = await geocode(cfg.key, city);
        if (cityGeo.adcode) adcode = cityGeo.adcode;
      } catch (e) { /* 城市 adcode 获取失败时退回区级 */ }
    }
    const mode = normMode(cfg.mode);
    const [toWork, toHome] = await Promise.all([
      route(cfg.key, homeLoc, workLoc, mode),
      route(cfg.key, workLoc, homeLoc, mode),
    ]);
    // 路线级实时路况：仅驾车有意义（步行/骑行不受机动车路况影响，还能省接口配额）——直接空表
    const trafficMap = mode === 'driving'
      ? await roadTraffic(cfg.key, adcode, [...toWork.steps.map((s) => s.name), ...toHome.steps.map((s) => s.name)])
      : {};
    // 查不到的道路（高架入口/立交/出口等非标准道路名）继承前一路段状态
    const attachTraffic = (r) => {
      let lastStatus = 0;
      const traffic = r.steps.map((s) => {
        if (trafficMap[s.name] !== undefined) lastStatus = trafficMap[s.name];
        return { name: s.name, status: lastStatus, polyline: s.polyline };
      });
      return { ...r, traffic };
    };
    const data = {
      ok: true,
      home: cfg.home,
      work: cfg.work,
      mode,
      mode_label: MODE_LABELS[mode],
      work_start: cfg.work_start,
      work_end: cfg.work_end,
      home_loc: homeLoc,
      work_loc: workLoc,
      updated: new Date().toLocaleString('zh-CN'),
      to_work: {
        minutes: Math.round(toWork.duration_sec / 60),
        distance_km: (toWork.distance_m / 1000).toFixed(1),
        // 按上班时间计算：最晚出发 = 上班时间 - 路程时长；预计到公司 = 上班时间
        depart_by: addMin(cfg.work_start, -toWork.duration_sec / 60),
        eta: cfg.work_start,
        polyline: toWork.polyline,
        ...attachTraffic(toWork),
      },
      to_home: {
        minutes: Math.round(toHome.duration_sec / 60),
        distance_km: (toHome.distance_m / 1000).toFixed(1),
        // 按下班时间计算：下班出发，预计到家 = 下班时间 + 路程时长
        eta: addMin(cfg.work_end, toHome.duration_sec / 60),
        polyline: toHome.polyline,
        ...attachTraffic(toHome),
      },
    };
    cache.data = data; cache.ts = now;
    return data;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { getConfig, saveConfig, calcCommute };
