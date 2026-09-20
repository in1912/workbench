// 桌面宠物形象帧渲染：把内置像素宠物画成静态 PNG（洋红 #FF00FF 底——桌面端 WinForms
// TransparencyKey 同色键透明，硬边缘像素画天然适配颜色键）。
// 约定 4 帧：[正常, 眨眼, 开心, 生病背面]；桌面端正常循环 0-1-0-2，生病播 3，去世定格末帧。
// 地面阴影含 alpha 会与洋红混出杂边，桌面帧不画阴影。
import { GRIDS } from './pixelSprites.js';
import { buildParts, headGridOf, paletteOf } from './pixelPets.js';

const BASE_W = 42, BASE_H = 40, GROUND = 28, CX = 21;
const FACE_PARTS = ['eyeL', 'eyeR', 'nose', 'mouth', 'muzzle', 'trunk', 'pouch', 'stripeH'];

// flags: { eyesClosed, eyesHappy, mouthOpen, back }
export function renderPetFrame(species, variant, rings, flags = {}, size = 4) {
  const scale = 1 + (rings || 0) * 0.08;
  const W = Math.max(1, Math.ceil(BASE_W * scale)), H = Math.max(1, Math.ceil(BASE_H * scale));
  const cv = document.createElement('canvas');
  cv.width = W * size; cv.height = H * size;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#FF00FF'; // 洋红底 = 桌面端透明区
  ctx.fillRect(0, 0, cv.width, cv.height);

  const parts = buildParts(species);
  const P = paletteOf(species, variant || 0);
  const back = !!flags.back;
  const toX = (v) => Math.round((W / 2 + (v - CX) * scale) * size);
  const toY = (v) => Math.round((H - 6 + (v - GROUND) * scale) * size);
  const px = (x, y, w = 1, h = 1) =>
    ctx.fillRect(toX(x), toY(y), Math.max(1, toX(x + w) - toX(x)), Math.max(1, toY(y + h) - toY(y)));
  const drawGrid = (grid, x, y) => {
    for (let gy = 0; gy < grid.length; gy++) {
      for (let gx = 0; gx < grid[gy].length; gx++) {
        const c = grid[gy][gx];
        if (c === '.') continue;
        const col = P[c];
        if (!col) continue;
        ctx.fillStyle = col;
        px(x + gx, y + gy);
      }
    }
  };
  for (const part of parts) {
    if (back && FACE_PARTS.includes(part.name)) continue;
    let grid = part.grid;
    if (part.name === 'head') grid = back ? GRIDS.headBack : headGridOf(species);
    else if (part.name === 'eyeL' || part.name === 'eyeR') grid = flags.eyesHappy ? GRIDS.eyeHappy : flags.eyesClosed ? GRIDS.eyeClosed : GRIDS.eye;
    else if (part.name === 'mouth') grid = flags.mouthOpen ? GRIDS.mouthOpen : GRIDS.mouth;
    drawGrid(grid, part.x, part.y);
  }
  return cv.toDataURL('image/png');
}

// 一次生成完整 4 帧桌面形象（正常 / 眨眼 / 开心 / 生病背面）
export function renderDesktopFrames(species, variant, rings) {
  return [
    renderPetFrame(species, variant, rings, {}),
    renderPetFrame(species, variant, rings, { eyesClosed: true }),
    renderPetFrame(species, variant, rings, { eyesHappy: true, mouthOpen: true }),
    renderPetFrame(species, variant, rings, { back: true }),
  ];
}
