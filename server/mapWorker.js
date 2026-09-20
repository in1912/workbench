// 地图渲染子进程（独立于主服务，渲染耗时/异常不影响服务进程）
// 用法: node mapWorker.js '<json配置>' <输出PNG路径>
// 配置: { home, work, key } —— 地址+高德Key
// 底图: Esri World Street Map（服务端可拉真图，WGS-84 Web Mercator）
// 坐标: 高德返回 GCJ-02 → 纠偏为 WGS-84 后再投影，与底图对齐
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');
const fs = require('fs');

const [cfgJson, outPath] = process.argv.slice(2);
const cfg = JSON.parse(cfgJson || '{}');
const log = (m) => console.log(`[mapWorker] ${m}`);

const TILE = 256;
const GRID = 4;

// ---------- 高德（GCJ-02） ----------
async function geocode(key, address) {
  const url = `https://restapi.amap.com/v3/geocode/geo?key=${encodeURIComponent(key)}&address=${encodeURIComponent(address)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const d = await r.json();
  if (d.status !== '1' || !d.geocodes?.length) throw new Error(`无法定位「${address}」: ${d.info || '未找到'}`);
  return d.geocodes[0].location;
}
async function route(key, origin, dest) {
  const url = `https://restapi.amap.com/v3/direction/driving?key=${encodeURIComponent(key)}&origin=${origin}&destination=${dest}&strategy=10`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const d = await r.json();
  if (d.status !== '1' || !d.route?.paths?.length) throw new Error('路线规划失败');
  const pts = [];
  for (const step of d.route.paths[0].steps || []) {
    if (step.polyline) for (const pair of String(step.polyline).split(';')) if (pair.includes(',')) pts.push(pair);
  }
  return pts.join(';');
}

// ---------- GCJ-02 → WGS-84（中国国测局坐标纠偏） ----------
function gcj02ToWgs84(lng, lat) {
  const a = 6378245.0, ee = 0.00669342162296594323;
  const tLat = (x, y) => {
    let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
    r += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
    return r;
  };
  const tLng = (x, y) => {
    let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
    r += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
    return r;
  };
  const dlat = tLat(lng - 105.0, lat - 35.0);
  const dlng = tLng(lng - 105.0, lat - 35.0);
  const radlat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radlat);
  magic = 1 - ee * magic * magic;
  const sqrtmagic = Math.sqrt(magic);
  const mglat = lat + (dlat * 180.0) / ((a * (1 - ee)) / (magic * sqrtmagic) * Math.PI);
  const mglng = lng + (dlng * 180.0) / (a / sqrtmagic * Math.cos(radlat) * Math.PI);
  return [lng * 2 - mglng, lat * 2 - mglat];
}

// ---------- 瓦片（Esri World Street Map，XYZ 顺序） ----------
const tileCache = new Map();
async function fetchTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`tile ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (tileCache.size > 300) tileCache.clear();
  tileCache.set(key, buf);
  return buf;
}

// ---------- 投影/绘制 ----------
function lngLatToWorld(lng, lat) {
  const x = (lng + 180) / 360;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  return [x, y];
}
function drawLine(buf, w, h, x0, y0, x1, y1, [r, g, b], width) {
  if (![x0, y0, x1, y1].every(Number.isFinite)) return; // 防 NaN
  // Bresenham 要求整数坐标：小数坐标会导致 x0===x1 永不成立 → 死循环
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const hw = Math.floor(width / 2);
  const set = (X, Y) => {
    for (let dy = -hw; dy <= hw; dy++) for (let dx = -hw; dx <= hw; dx++) {
      const px = Math.round(X + dx), py = Math.round(Y + dy);
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const i = (py * w + px) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  };
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, guard = 0;
  for (;;) {
    set(x0, y0);
    if ((x0 === x1 && y0 === y1) || ++guard > 200000) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
function drawCircle(buf, w, h, cx, cy, radius, fill, ring) {
  if (![cx, cy].every(Number.isFinite)) return;
  for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
    const d = Math.sqrt(x * x + y * y);
    if (d > radius) continue;
    const X = Math.round(cx + x), Y = Math.round(cy + y);
    if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
    const col = d > radius - 3 ? ring : fill;
    const i = (Y * w + X) * 4;
    buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = 255;
  }
}

(async () => {
  try {
    log(`开始: ${cfg.home} → ${cfg.work}`);
    // 1. 高德定位 + 路线（GCJ-02）
    const [home, work] = await Promise.all([geocode(cfg.key, cfg.home), geocode(cfg.key, cfg.work)]);
    const polyline = await route(cfg.key, home, work);
    const gcjPts = polyline.split(';').filter(Boolean).map((p) => p.split(',').map(Number));
    if (!gcjPts.length) throw new Error('路线为空');
    // 纠偏到 WGS-84（Esri 底图坐标系）
    const pts = gcjPts.map(([lng, lat]) => gcj02ToWgs84(lng, lat));
    const [homeW, workW] = [gcj02ToWgs84(...home.split(',').map(Number)), gcj02ToWgs84(...work.split(',').map(Number))];

    // 2. 包围盒 + zoom
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lng, lat] of pts) {
      minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    }
    const spanLng = Math.max(maxLng - minLng, 0.005);
    let zoom = 15;
    while (zoom > 10 && (spanLng / 360) * TILE * Math.pow(2, zoom) > 660) zoom--;
    const cLng = (minLng + maxLng) / 2, cLat = (minLat + maxLat) / 2;
    const [cw, ch] = lngLatToWorld(cLng, cLat);
    const scale = TILE * Math.pow(2, zoom);
    const cpx = cw * scale, cpy = ch * scale;
    const startX = Math.floor(cpx / TILE) - GRID / 2 + 1;
    const startY = Math.floor(cpy / TILE) - GRID / 2 + 1;

    // 3. 拉瓦片拼接（Esri 真图）
    const W = GRID * TILE, H = GRID * TILE;
    const img = Buffer.alloc(W * H * 4, 255);
    const jobs = [];
    for (let ty = 0; ty < GRID; ty++) for (let tx = 0; tx < GRID; tx++) {
      const wx = startX + tx, wy = startY + ty;
      jobs.push(fetchTile(zoom, wx, wy).then((buf) => {
        const j = jpeg.decode(buf, { useTArray: true });
        const w = Math.min(j.width, TILE), h = Math.min(j.height, TILE);
        for (let yy = 0; yy < h; yy++) {
          const rowDst = ((ty * TILE + yy) * W + tx * TILE) * 4;
          const rowSrc = yy * j.width * 4;
          for (let xx = 0; xx < w; xx++) {
            const d = rowDst + xx * 4, s = rowSrc + xx * 4;
            img[d] = j.data[s]; img[d + 1] = j.data[s + 1]; img[d + 2] = j.data[s + 2]; img[d + 3] = 255;
          }
        }
      }).catch((e) => log(`瓦片 ${wx}/${wy} 失败: ${e.message}`)));
    }
    await Promise.all(jobs);
    log(`瓦片拼接完成 zoom=${zoom} ${W}x${H}`);

    // 4. 画路线 + 标记（WGS-84 坐标投影）
    const toImg = (lng, lat) => {
      const [x, y] = lngLatToWorld(lng, lat);
      return [x * scale - startX * TILE, y * scale - startY * TILE];
    };
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = toImg(pts[i][0], pts[i][1]);
      const [bx, by] = toImg(pts[i + 1][0], pts[i + 1][1]);
      drawLine(img, W, H, ax, ay, bx, by, [79, 124, 247], 5);
    }
    const [hx, hy] = toImg(homeW[0], homeW[1]);
    const [wx2, wy2] = toImg(workW[0], workW[1]);
    drawCircle(img, W, H, hx, hy, 10, [45, 212, 191], [255, 255, 255]);
    drawCircle(img, W, H, wx2, wy2, 10, [79, 124, 247], [255, 255, 255]);

    // 5. 编码 PNG 输出
    const png = new PNG({ width: W, height: H });
    png.data = img;
    const out = PNG.sync.write(png);
    fs.writeFileSync(outPath, out);
    log(`完成 → ${outPath} (${out.length}B)`);
    process.exit(0);
  } catch (e) {
    log(`失败: ${e.message}`);
    process.exit(1);
  }
})();
