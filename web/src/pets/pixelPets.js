// 像素宠物布局与动画位姿库。
// 画布 36×30（逻辑像素），面朝左；地面 y≈27。
// 动画全部用「部件偏移关键帧 + 覆盖标志位」实现（无旋转，保持硬像素风）。
import { GRIDS, SPECIES_PARTS, PALETTES } from './pixelSprites.js';

// ---------- 基础布局：部件默认位置与 z 序 ----------
export const LAYOUT = {
  tail: { x: 26, y: 10, z: 0 },   // 身体右后
  legB2: { x: 25, y: 21, z: 1 },  // 远后腿
  legF2: { x: 15, y: 21, z: 1 },  // 远前腿
  body: { x: 13, y: 12, z: 2 },
  mane: { x: 0, y: 0, z: 2 },     // 狮鬃（头后方）
  earR: { x: 9, y: -1, z: 2 },    // 远耳（头后）
  head: { x: 3, y: 2, z: 3 },
  earL: { x: 1, y: -1, z: 4 },    // 近耳
  muzzle: { x: 1, y: 8, z: 4 },
  pouch: { x: 15, y: 16, z: 4 },  // 袋鼠育儿袋
  eyeL: { x: 6, y: 5, z: 5 },
  eyeR: { x: 11, y: 5, z: 5 },
  nose: { x: 2, y: 8, z: 5 },
  mouth: { x: 3, y: 11, z: 5 },
  trunk: { x: 0, y: 7, z: 5 },    // 象鼻
  legF: { x: 16, y: 22, z: 6 },
  legB: { x: 23, y: 22, z: 6 },
};
// 老虎条纹：相对身体的列偏移（stripeV 2×5，叠 z=3 于身体之上、头之下）
const TIGER_BODY_Y = 13;

// ---------- 点击命中区（画布坐标，按序匹配先者） ----------
export const HIT_AREAS = [
  { name: 'ear', label: '耳朵', x0: 0, y0: -3, x1: 10, y1: 4 },
  { name: 'head', label: '头', x0: 2, y0: 2, x1: 16, y1: 12 },
  { name: 'tail', label: '尾巴', x0: 24, y0: 8, x1: 35, y1: 20 },
  { name: 'body', label: '身体', x0: 14, y0: 11, x1: 30, y1: 21 },
  { name: 'paw', label: '爪子', x0: 14, y0: 20, x1: 28, y1: 27 },
];

// ---------- 组装某物种的部件清单（渲染器每帧遍历） ----------
// 返回 [{ name, grid, x, y, z, hide, kind }]，kind: fur(用调色板) / face
export function buildParts(species) {
  const sp = SPECIES_PARTS[species] || SPECIES_PARTS.dog;
  const P = [];
  const push = (name, grid, kind) => {
    const lay = LAYOUT[name];
    if (!lay || !grid) return;
    P.push({ name, grid, x: lay.x, y: lay.y, z: lay.z, kind: kind || 'fur' });
  };
  push('tail', sp.tail);
  push('legB2', sp.legB2 || GRIDS.legB2);
  push('legF2', GRIDS.legF2);
  push('body', sp.body || GRIDS.body);
  push('mane', sp.mane);
  push('earR', sp.earR || sp.earL);
  push('head', GRIDS.head, 'head');
  push('earL', sp.earL);
  push('muzzle', sp.muzzle);
  push('pouch', sp.pouch);
  push('trunk', sp.trunk);
  push('eyeL', GRIDS.eye, 'eyeL');
  push('eyeR', GRIDS.eye, 'eyeR');
  push('nose', sp.bigNose || GRIDS.nose, 'nose');
  push('mouth', GRIDS.mouth, 'mouth');
  push('legF', GRIDS.legF);
  push('legB', sp.legB || GRIDS.legB);
  // 老虎条纹覆盖件
  if (sp.bodyStripes) {
    for (const col of sp.bodyStripes) P.push({ name: 'stripe' + col, grid: GRIDS.stripeV, x: LAYOUT.body.x + col, y: TIGER_BODY_Y, z: 2.5, kind: 'fur' });
  }
  if (sp.headStripe) P.push({ name: 'stripeH', grid: GRIDS.stripeV.slice(0, 3), x: LAYOUT.head.x + 6, y: LAYOUT.head.y + 1, z: 4.5, kind: 'fur' });
  return P.sort((a, b) => a.z - b.z);
}

// 羊用专属头网格
export function headGridOf(species) {
  const sp = SPECIES_PARTS[species];
  return sp && sp.head ? sp.head : GRIDS.head;
}

export function paletteOf(species, variant) {
  const list = PALETTES[species] || PALETTES.dog;
  return list[Math.min(list.length - 1, Math.max(0, Number(variant) || 0))];
}

// ---------- 动画工具 ----------
const clamp01 = (p) => Math.max(0, Math.min(1, p));
const bounce = (p) => Math.abs(Math.sin(clamp01(p) * Math.PI));              // 0→1→0
const wig = (p, n) => Math.sin(clamp01(p) * Math.PI * 2 * n);                // -1..1 振荡
const R = Math.round;                                                        // 像素取整
// 分段：p 在 [a,b] 内映射到 0..1
const seg = (p, a, b) => clamp01((p - a) / (b - a));

// 空位姿（无动画时）
const NONE = () => ({ parts: {}, flags: {}, sprites: [], fx: [] });
const lift = (n) => ({ legF: { dy: -n }, legF2: { dy: -n }, legB: { dy: -n }, legB2: { dy: -n } });
const allDy = (n) => {
  const o = {};
  for (const k of ['head', 'body', 'earL', 'earR', 'tail', 'muzzle', 'eyeL', 'eyeR', 'nose', 'mouth', 'trunk', 'legF', 'legF2', 'legB', 'legB2', 'pouch']) o[k] = { dy: n };
  return o;
};

// ---------- 动画定义 ----------
// fn(p, t, arg) → { parts:{[名]:{dx,dy,hide}}, flags, sprites:[{key,x,y,alpha}], fx:[{key,x,y}] }
// flags: back / eyesHappy / eyesClosed / eyesShift(-1|1) / mouthOpen / blush / pale
export const ANIMS = {
  // 待机呼吸（常驻基线，t 为绝对毫秒）：身体 0/1 像素缓慢起伏
  idle: {
    label: '待机呼吸', dur: 0, loop: true,
    fn: (p, t) => ({
      parts: { body: { dy: Math.sin(t / 900) > 0 ? 0 : 1 } },
      flags: {}, sprites: [], fx: [],
    }),
  },
  // ---- 闲置小动作 ----
  earWiggle: {
    label: '动耳朵', dur: 1600,
    fn: (p) => ({ parts: { earL: { dy: -R(bounce(seg(p, 0, 0.5)) * 2) }, earR: { dy: -R(bounce(seg(p, 0.4, 0.9)) * 2) } }, flags: {}, sprites: [], fx: [] }),
  },
  scratch: {
    label: '挠痒痒', dur: 2400,
    fn: (p) => ({
      parts: { legB: { dx: -2 + R(wig(p, 6)), dy: -6 }, head: { dy: 1, dx: 1 } },
      flags: { eyesClosed: true }, sprites: [], fx: [{ key: 'note', x: 15, y: 0 }],
    }),
  },
  scratchHead: {
    label: '用脚挠头', dur: 2400,
    fn: (p) => ({
      parts: {
        legB: { dx: -7 + R(wig(p, 7)), dy: -14 },
        head: { dx: 1, dy: 1 },
        earL: { dy: -R(bounce(p) * 1) },
      },
      flags: { eyesClosed: true }, sprites: [], fx: [],
    }),
  },
  lickPaw: {
    label: '舔爪子', dur: 2600,
    fn: (p) => ({
      parts: { legF: { dx: -3, dy: -8 + R(wig(p, 5)) }, head: { dx: -1, dy: 1 } },
      flags: { mouthOpen: true }, sprites: [], fx: [],
    }),
  },
  wagTail: {
    label: '摇尾巴', dur: 2000,
    fn: (p) => ({ parts: { tail: { dx: -R(Math.abs(wig(p, 4))), dy: R(wig(p, 4) * 1.5) } }, flags: {}, sprites: [], fx: [] }),
  },
  turnAngry: {
    label: '转身生气', dur: 3000,
    fn: (p) => {
      const back = p > 0.12 && p < 0.85;
      return {
        parts: { tail: { dy: back ? R(wig(p, 3)) - 1 : 0 } },
        flags: { back, angry: back },
        sprites: [], fx: back ? [{ key: 'angry', x: 12, y: -3 }] : [],
      };
    },
  },
  lookAround: {
    label: '东张西望', dur: 2200,
    fn: (p) => ({ parts: {}, flags: { eyesShift: R(Math.sin(p * Math.PI * 3)) } , sprites: [], fx: [] }),
  },
  // ---- 点击部位反应 ----
  reactHead: {
    label: '摸头反应', dur: 1600,
    fn: (p) => ({
      parts: { head: { dy: -R(bounce(seg(p, 0, 0.6)) * 2) + R(bounce(seg(p, 0.5, 1)) * 1) } },
      flags: { eyesHappy: true, blush: true }, sprites: [], fx: [{ key: 'heart', x: 6, y: -3 }, { key: 'heart', x: 14, y: -1, alpha: 0.7 }],
    }),
  },
  reactEar: {
    label: '点耳朵反应', dur: 1400,
    fn: (p) => ({
      parts: { earL: { dy: -R(bounce(seg(p, 0, 0.45)) * 2) - R(bounce(seg(p, 0.5, 0.95)) * 2) }, head: { dx: R(wig(p, 3)) } },
      flags: {}, sprites: [], fx: [{ key: 'sweat', x: 15, y: 0 }],
    }),
  },
  reactBody: {
    label: '点身体反应', dur: 1800,
    fn: (p) => ({
      parts: { ...allDy(-R(bounce(p) * 3)), ...lift(R(bounce(p) * 3)) },
      flags: { eyesHappy: true }, sprites: [], fx: [{ key: 'note', x: 20, y: 0 }],
    }),
  },
  reactTail: {
    label: '点尾巴反应', dur: 1600,
    fn: (p) => ({
      parts: { tail: { dy: R(wig(p, 6) * 2), dx: -R(Math.abs(wig(p, 6))) } },
      flags: { eyesHappy: true }, sprites: [], fx: [{ key: 'heart', x: 28, y: 4 }],
    }),
  },
  reactPaw: {
    label: '点爪子反应', dur: 1600,
    fn: (p) => ({
      parts: { legF: { dy: -3 - R(bounce(p) * 2), dx: R(wig(p, 4)) } },
      flags: { eyesHappy: true }, sprites: [], fx: [{ key: 'sparkle', x: 15, y: 18 }],
    }),
  },
  // ---- 喂食（item: rice/snack/banana/apple）----
  feed: {
    label: '喂食', dur: 2800,
    fn: (p, t, item) => {
      const food = item || 'rice';
      const drop = seg(p, 0, 0.35);
      const chew = seg(p, 0.45, 0.75);
      const joy = seg(p, 0.75, 1);
      const sprites = p < 0.45 ? [{ key: food, x: 4, y: R(-6 + drop * 12) }] : [];
      return {
        parts: {
          head: { dy: p < 0.45 ? R(drop * 1) : R(Math.abs(Math.sin(chew * Math.PI * 4)) * 1) },
          ...lift(R(bounce(joy) * 4)),
          ...allDy(-R(bounce(joy) * 4)),
        },
        flags: { mouthOpen: p > 0.3 && p < 0.75, eyesHappy: joy > 0.2, blush: joy > 0.2 },
        sprites,
        fx: joy > 0.2 ? [{ key: 'heart', x: 8, y: -4 }, { key: 'heart', x: 16, y: -2, alpha: 0.8 }] : [],
      };
    },
  },
  water: {
    label: '喂水', dur: 2600,
    fn: (p) => {
      const drop = seg(p, 0, 0.3);
      const drink = seg(p, 0.35, 0.8);
      const joy = seg(p, 0.8, 1);
      return {
        parts: { head: { dy: R(drop * 2) + (drink > 0 && drink < 1 ? R(Math.abs(Math.sin(drink * Math.PI * 6))) : 0), dx: drink > 0 && drink < 1 ? -1 : 0 } },
        flags: { mouthOpen: drink > 0 && drink < 1, eyesHappy: joy > 0.3 },
        sprites: [p < 0.35 ? { key: 'water', x: 2, y: R(-4 + drop * 12) } : null].filter(Boolean),
        fx: joy > 0.3 ? [{ key: 'sparkle', x: 8, y: -4 }] : [],
      };
    },
  },
  medicine: {
    label: '吃药', dur: 2600,
    fn: (p) => {
      const drop = seg(p, 0, 0.3);
      const shake = seg(p, 0.35, 0.7);
      const heal = seg(p, 0.7, 1);
      return {
        parts: { ...allDy(R(wig(shake, 8)) * (shake > 0 && shake < 1 ? 1 : 0)) },
        flags: { eyesClosed: shake > 0 && shake < 1, eyesHappy: heal > 0.5 },
        sprites: [p < 0.3 ? { key: 'pill', x: 5, y: R(-6 + drop * 12) } : null].filter(Boolean),
        fx: heal > 0.5 ? [{ key: 'sparkle', x: 6, y: -4 }, { key: 'sparkle', x: 20, y: 2, alpha: 0.8 }, { key: 'heart', x: 13, y: -6 }] : [],
      };
    },
  },
  happyJump: {
    label: '开心蹦跳', dur: 1800,
    fn: (p) => {
      const j = Math.abs(Math.sin(p * Math.PI * 2));
      return {
        parts: { ...allDy(-R(j * 4)), ...lift(R(j * 4)) },
        flags: { eyesHappy: true, mouthOpen: true },
        sprites: [],
        fx: [{ key: 'heart', x: 5, y: -5 }, { key: 'note', x: 24, y: 0 }, { key: 'heart', x: 16, y: -8, alpha: 0.8 }],
      };
    },
  },
  // ---- 陪玩 ----
  playYarn: {
    label: '玩毛线球', dur: 4200,
    fn: (p) => {
      const inP = seg(p, 0, 0.35), bat = seg(p, 0.35, 0.55), out = seg(p, 0.55, 1);
      const ballX = p < 0.35 ? R(22 - inP * 12) : p < 0.55 ? R(10 - R(Math.abs(wig(bat, 2)) * 2)) : R(10 + out * 16);
      const ballY = R(19 - Math.abs(Math.sin(p * Math.PI * 3)) * 3);
      return {
        parts: { legF: { dx: p > 0.25 && p < 0.7 ? 1 : 0, dy: p > 0.25 && p < 0.7 ? -3 - R(bounce(bat) * 2) : 0 } },
        flags: { eyesHappy: true },
        sprites: [{ key: 'yarn', x: ballX, y: ballY }],
        fx: p > 0.7 ? [{ key: 'heart', x: 8, y: -4 }] : [],
      };
    },
  },
  playBlocks: {
    label: '玩积木', dur: 4400,
    fn: (p) => {
      const b1 = seg(p, 0.1, 0.3), b2 = seg(p, 0.3, 0.5), b3 = seg(p, 0.5, 0.7);
      const sprites = [];
      if (b1 > 0) sprites.push({ key: 'block', x: 24, y: R(24 - 4 + bounce(b1) * 8) });
      if (b2 > 0) sprites.push({ key: 'blockB', x: 24, y: R(20 - 4 + bounce(b2) * 8) });
      if (b3 > 0) sprites.push({ key: 'block', x: 24, y: R(16 - 4 + bounce(b3) * 8) });
      return {
        parts: { legF: { dx: 2, dy: -3 - R(Math.abs(wig(p, 6)) * 2) } },
        flags: { eyesHappy: true },
        sprites,
        fx: p > 0.8 ? [{ key: 'sparkle', x: 24, y: 8 }] : [],
      };
    },
  },
  playTrain: {
    label: '玩电动火车', dur: 4600,
    fn: (p) => {
      const x = R(38 - p * 58);
      return {
        parts: { head: { dy: R(Math.sin(p * Math.PI * 4) > 0 ? 0 : 1) } },
        flags: { eyesShift: x > 16 ? 1 : -1 },
        sprites: [{ key: 'train', x, y: 21 }],
        fx: p > 0.85 ? [{ key: 'note', x: 20, y: 0 }] : [],
      };
    },
  },
  playCooking: {
    label: '玩做饭游戏', dur: 4400,
    fn: (p, t) => ({
      parts: { legF: { dx: 3, dy: -4 + R(wig(p, 6)) } },
      flags: { eyesHappy: true },
      sprites: [
        { key: 'pot', x: 23, y: 15 },
        { key: 'bubble', x: 24, y: R(13 - ((t / 400) % 1) * 4), alpha: 0.9 },
        { key: 'bubble', x: 26, y: R(13 - ((t / 400 + 0.33) % 1) * 4), alpha: 0.7 },
        { key: 'bubble', x: 22, y: R(13 - ((t / 400 + 0.66) % 1) * 4), alpha: 0.5 },
      ],
      fx: p > 0.8 ? [{ key: 'heart', x: 27, y: 6 }] : [],
    }),
  },
  // ---- 生病（常驻状态，非一次性动画） ----
  sickIdle: {
    label: '生病（背面）', dur: 0, loop: true,
    fn: (p, t) => ({
      parts: { tail: { dy: R(Math.sin(t / 700) * 1.5) } },
      flags: { back: true, pale: true },
      sprites: [],
      fx: [{ key: 'zzz', x: 13, y: -4 }, { key: 'sweat', x: 17, y: 1, alpha: 0.8 }],
    }),
  },
};

// 闲置动画随机池（权重：常见小动作优先，转身生气低频）
export const IDLE_POOL = [
  ['earWiggle', 3], ['wagTail', 3], ['lookAround', 2], ['scratch', 2],
  ['lickPaw', 2], ['scratchHead', 1], ['turnAngry', 1],
];
export function pickIdle() {
  const total = IDLE_POOL.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [name, w] of IDLE_POOL) { r -= w; if (r <= 0) return name; }
  return 'earWiggle';
}

// 部位点击 → 反应动画名
export const HIT_REACTIONS = {
  head: 'reactHead', ear: 'reactEar', body: 'reactBody', tail: 'reactTail', paw: 'reactPaw',
};

// 设置页动作预览清单（每宠物各类动作统一查看）
export const PREVIEW_GROUPS = [
  { title: '闲置小动作', items: ['idle', 'earWiggle', 'scratch', 'scratchHead', 'lickPaw', 'wagTail', 'turnAngry', 'lookAround'] },
  { title: '部位点击反应', items: ['reactHead', 'reactEar', 'reactBody', 'reactTail', 'reactPaw'] },
  { title: '喂养与照顾', items: ['feed:rice', 'feed:snack', 'feed:banana', 'feed:apple', 'water', 'medicine', 'happyJump'] },
  { title: '陪它玩', items: ['playYarn', 'playBlocks', 'playTrain', 'playCooking'] },
  { title: '特殊状态', items: ['sickIdle'] },
];
