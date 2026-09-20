// 静态地图生成：后端拉取腾讯瓦片 → 拼接底图 → 像素级绘制路线与标记 → 输出一张 PNG。
// 前端只需 <img src="/api/map-static">，同源单图请求，规避浏览器/预览面板对
// 逐块瓦片加载的一切限制（CSP、跨域、子域解析等）。
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');
const commuteService = require('./commuteService');

const TILE = 256;
const GRID = 4;          // 4x4 瓦片 = 1024x1024 输出图
const CACHE_TTL = 10 * 60 * 1000;

// ---------- 瓦片拉取（内存缓存） ----------
const tileCache = new Map();
async function fetchTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const sub = (x * 7 + y * 13) % 4; // rt0-rt3，注意腾讯无 rt4 域
  const url = `https://rt${sub}.map.gtimg.com/tile?z=${z}&x=${x}&y=${y}&styleid=1`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`tile ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (tileCache.size > 300) tileCache.clear();
  tileCache.set(key, buf);
  return buf;
}

// ---------- Web Mercator 投影（腾讯瓦片为 GCJ-02，直接投影即可对齐） ----------
function lngLatToWorld(lng, lat) {
  const x = (lng + 180) / 360;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  return [x, y];
}
function worldToPixel(wx, wy, zoom) {
  const scale = TILE * Math.pow(2, zoom);
  return [wx * scale, wy * scale];
}

// ---------- 像素绘制 ----------
function drawLine(buf, w, h, x0, y0, x1, y1, [r, g, b], width) {
  if (![x0, y0, x1, y1].every(Number.isFinite)) return; // 防 NaN
  // Bresenham 要求整数坐标：小数坐标会导致 x0===x1 永不成立 → 死循环
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const hw = Math.floor(width / 2);
  const set = (X, Y) => {
    for (let dy = -hw; dy <= hw; dy++) {
      for (let dx = -hw; dx <= hw; dx++) {
        const px = Math.round(X + dx), py = Math.round(Y + dy);
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const i = (py * w + px) * 4;
        buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
      }
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
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      const d = Math.sqrt(x * x + y * y);
      if (d > radius) continue;
      const X = Math.round(cx + x), Y = Math.round(cy + y);
      if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
      const col = d > radius - 3 ? ring : fill;
      const i = (Y * w + X) * 4;
      buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = 255;
    }
  }
}

// ---------- 主流程 ----------
const resultCache = new Map();
async function renderMapImage(force = false) {
  // 复用通勤服务的计算缓存（10 分钟），坐标/路线来自运行时结果
  const cfg = await commuteService.calcCommute(false);
  if (!cfg.ok) throw new Error(cfg.error || '通勤未配置');
  const home = cfg.home_loc;
  const work = cfg.work_loc;
  const polyline = (cfg.to_work && cfg.to_work.polyline) || '';
  if (!home || !work || !polyline) throw new Error('通勤未配置或缺少路线坐标');
  const pts = String(polyline).split(';').filter(Boolean).map((p) => p.split(',').map(Number));
  if (!pts.length) throw new Error('路线坐标为空');

  const cacheKey = `${home}|${work}|${polyline}`;
  const hit = resultCache.get(cacheKey);
  if (!force && hit && Date.now() - hit.t < CACHE_TTL) return hit.png;

  // 路线包围盒
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lng, lat] of pts) {
    minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
  }
  const spanLng = Math.max(maxLng - minLng, 0.005);

  // 选 zoom：使路线横向跨度 ≤ 图片宽度的 ~65%（约 660px）
  let zoom = 15;
  while (zoom > 10 && (spanLng / 360) * TILE * Math.pow(2, zoom) > 660) zoom--;

  // 以路线中心定位瓦片网格
  const cLng = (minLng + maxLng) / 2, cLat = (minLat + maxLat) / 2;
  const [cw, ch] = lngLatToWorld(cLng, cLat);
  const [cpx, cpy] = worldToPixel(cw, ch, zoom);
  const startX = Math.floor(cpx / TILE) - GRID / 2 + 1;
  const startY = Math.floor(cpy / TILE) - GRID / 2 + 1;

  const W = GRID * TILE, H = GRID * TILE;
  const img = Buffer.alloc(W * H * 4, 255); // 白色底（瓦片未覆盖区域）

  // 并发拉取瓦片并拼入
  const jobs = [];
  for (let ty = 0; ty < GRID; ty++) {
    for (let tx = 0; tx < GRID; tx++) {
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
      }).catch((e) => console.warn(`[map] 瓦片 ${zoom}/${wx}/${wy} 失败: ${e.message}`)));
    }
  }
  await Promise.all(jobs);

  const toImg = (lng, lat) => {
    const [wx, wy] = lngLatToWorld(lng, lat);
    const [px, py] = worldToPixel(wx, wy, zoom);
    return [px - startX * TILE, py - startY * TILE];
  };

  // 画路线（蓝色 #4f7cf7，宽 5px）
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = toImg(pts[i][0], pts[i][1]);
    const [bx, by] = toImg(pts[i + 1][0], pts[i + 1][1]);
    drawLine(img, W, H, ax, ay, bx, by, [79, 124, 247], 5);
  }
  // 画标记：家=青色 #2dd4bf，公司=蓝色 #4f7cf7，白边
  const [hx, hy] = toImg(...String(home).split(',').map(Number));
  const [wx2, wy2] = toImg(...String(work).split(',').map(Number));
  drawCircle(img, W, H, hx, hy, 10, [45, 212, 191], [255, 255, 255]);
  drawCircle(img, W, H, wx2, wy2, 10, [79, 124, 247], [255, 255, 255]);

  const png = new PNG({ width: W, height: H });
  png.data = img;
  const out = PNG.sync.write(png);
  resultCache.set(cacheKey, { t: Date.now(), png: out });
  return out;
}

module.exports = { renderMapImage };
