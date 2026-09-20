// 像素宠物开发预览：校验网格等宽 + 以 ASCII 合成每个物种（node scripts/preview-pets.mjs [species]）
// 与渲染器同构的布局合成，便于在终端里检查像素画形状。
import { GRIDS, SPECIES_PARTS, SPRITES } from '../web/src/pets/pixelSprites.js';
import { buildParts, headGridOf, LAYOUT, HIT_AREAS } from '../web/src/pets/pixelPets.js';

let bad = 0;
const check = (name, grid) => {
  const w = grid[0].length;
  grid.forEach((row, i) => {
    if (row.length !== w) {
      console.error(`  ✗ ${name} 第 ${i} 行宽度 ${row.length} ≠ ${w}：「${row}」`);
      bad++;
    }
    if ([...row].some((c) => c === ' ')) {
      console.error(`  ✗ ${name} 第 ${i} 行含空格：「${row}」`);
      bad++;
    }
  });
};
console.log('== 网格宽度校验 ==');
for (const [k, v] of Object.entries(GRIDS)) check('GRIDS.' + k, v);
for (const [sp, parts] of Object.entries(SPECIES_PARTS)) {
  for (const [k, v] of Object.entries(parts)) {
    // 只校验「字符串行数组」形态的网格；bodyStripes（数字数组）/ headStripe（布尔）跳过
    if (Array.isArray(v) && v.every((r) => typeof r === 'string')) check(`${sp}.${k}`, v);
  }
}
for (const [k, v] of Object.entries(SPRITES)) check('SPRITES.' + k, v.grid);
console.log(bad ? `${bad} 行宽度异常` : '全部等宽 ✓');

// ---------- ASCII 合成 ----------
const W = 42, H = 34;
function render(species, { back = false } = {}) {
  const canvas = Array.from({ length: H }, () => Array.from({ length: W }, () => ' '));
  const put = (grid, ox, oy, ch) => {
    grid.forEach((row, y) => {
      [...row].forEach((c, x) => {
        if (c === '.') return;
        const cx = ox + x, cy = oy + y;
        if (cy >= 0 && cy < H && cx >= 0 && cx < W) canvas[cy][cx] = ch || c;
      });
    });
  };
  const parts = buildParts(species);
  for (const part of parts) {
    let grid = part.grid;
    if (part.name === 'head') {
      if (back) grid = GRIDS.headBack;
      else grid = headGridOf(species);
    }
    if (back && ['eyeL', 'eyeR', 'nose', 'mouth', 'muzzle', 'trunk'].includes(part.name)) continue;
    put(grid, part.x, part.y);
  }
  return canvas.map((r) => r.join('').replace(/\s+$/, '')).join('\n');
}

const want = process.argv[2];
for (const sp of Object.keys(SPECIES_PARTS)) {
  if (want && sp !== want) continue;
  console.log(`\n===== ${SPECIES_PARTS[sp].label}（${sp}）正面 =====`);
  console.log(render(sp));
  console.log(`----- ${sp} 背面（生病/转身） -----`);
  console.log(render(sp, { back: true }));
}
if (!want) {
  console.log('\n===== 精灵（食物/玩具/粪便/特效） =====');
  for (const [k, v] of Object.entries(SPRITES)) {
    console.log(`-- ${k} --`);
    console.log(v.grid.join('\n'));
  }
  console.log('\n命中区：', HIT_AREAS.map((h) => `${h.name}(${h.x0},${h.y0})-(${h.x1},${h.y1})`).join(' '));
  console.log('布局：', JSON.stringify(LAYOUT));
}
process.exit(bad ? 1 : 0);
