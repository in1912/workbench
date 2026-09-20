// 像素宠物精灵库：网格 + 调色板 + 摆放位置。
// 网格字符约定：. 透明 / o 轮廓 / f 主毛色 / l 浅毛色 / d 深毛色 / p 粉色 /
//               k 黑(瞳) / w 白(高光) / r 红(舌) / b 蓝 / y 黄 / g 绿
// 所有网格每行必须等宽（scripts/preview-pets.mjs 会校验并打印 ASCII 预览）。

// ---------- 通用四足身体（面朝左，画布 36×30，地面 y≈27） ----------
export const GRIDS = {
  // 头：14×11 大圆头（脸由覆盖件叠加：eyeL/eyeR/nose/mouth）
  head: [
    '....oooooo....',
    '..ooffffffoo..',
    '.offffffffffo.',
    '.offffffffffo.',
    'offffffffffffo',
    'offffffffffffo',
    'offffffffffffo',
    '.offffffffffo.',
    '.offffffffffo.',
    '..ooffffffoo..',
    '....oooooo....',
  ],
  // 头背面（转身生气 / 生病）：无脸纯毛
  headBack: [
    '....oooooo....',
    '..ooddddddoo..',
    '.oddddddddddo.',
    '.oddddddddddo.',
    'oddddddddddddo',
    'oddddddddddddo',
    'oddddddddddddo',
    '.oddddddddddo.',
    '.oddddddddddo.',
    '..ooddddddoo..',
    '....oooooo....',
  ],
  // 身体：16×10 圆润躯干，肚子浅色
  body: [
    '.....oooooo.....',
    '...ooffffffoo...',
    '..offffffffffo..',
    '.offllllllllffo.',
    '.offllllllllffo.',
    '.offllllllllffo.',
    '.offllllllllffo.',
    '..offffffffffo..',
    '...ooffffffoo...',
    '.....oooooo.....',
  ],
  // 前后腿（近腿 f 色 / 远腿 d 色；袋鼠可覆盖大后腿）
  legF: ['ofo', 'ofo', 'ofo', 'ofo', 'opo', '.oo'],
  legF2: ['odo', 'odo', 'odo', 'odo', 'odo', '.oo'],
  legB: ['offo', 'offo', 'offo', 'offo', 'oppo', '.oo.'],
  legB2: ['oddo', 'oddo', 'oddo', 'oddo', 'oddo', '.oo.'],
  // 口鼻 5×4（浅色，突出在头左下；熊用大版覆盖）
  muzzle: ['.ooo.', 'olllo', 'olllo', '.ooo.'],
  nose: ['pp', 'pp'],
  mouth: ['.o.'],
  mouthOpen: ['.ooo.', 'ororo'],
  eye: ['kw', 'kk'],
  eyeHappy: ['o.o', '.o.'],
  eyeClosed: ['.o.'],
  // 老虎条纹覆盖件（叠在身体/额头上，d 色）
  stripeV: ['dd', 'dd', 'dd', 'dd', 'dd'],
};

// ---------- 物种差异部件 ----------
export const SPECIES_PARTS = {
  dog: {
    label: '小狗',
    earL: [ // 垂耳 8×9
      '.oo.....',
      'offo....',
      'offfo...',
      '.offfo..',
      '..offfo.',
      '..offfo.',
      '...offo.',
      '....ofo.',
      '.....o..',
    ],
    earR: [
      '.oo...',
      'oddo..',
      '.oddo.',
      '..oddo',
      '..oddo',
      '...odo',
      '....o.',
    ],
    tail: [ // 上翘尾 8×6
      '......oo',
      '.....ofo',
      '....offo',
      '...offo.',
      '..offo..',
      '.oolo...',
    ],
  },
  cat: {
    label: '小猫',
    earL: ['..oo..', '.offo.', '.offfo', 'offffo', 'opffpo', 'offffo'],
    earR: ['..oo..', '.oddo.', '.oddo.', 'oddddo', 'oddpdo', 'oddddo'],
    tail: [ // 长弯尾 11×9
      '.........oo',
      '........ofo',
      '.......offo',
      '......offo.',
      '.o...offo..',
      '.o..offo...',
      '.o.offo....',
      '.oollo.....',
      '.ooo.......',
    ],
  },
  elephant: {
    label: '小象',
    earL: [ // 大扇耳 10×9
      '....ooo...',
      '..oofffo..',
      '.offffffo.',
      'offffffffo',
      'offfpffffo',
      'offffffffo',
      '.offffffo.',
      '..oofffo..',
      '....ooo...',
    ],
    earR: [
      '...ooo..',
      '.ooddo..',
      'odddddo.',
      'oddddddo',
      'oddpdddo',
      'oddddddo',
      '.oddddo.',
      '..ooo...',
    ],
    tail: ['...oo.', '..oofo', '.oo.fo', 'oo..fo', '.....o'],
    trunk: [ // 象鼻（替代口鼻，从头左下垂）4×8
      '.oo.',
      'offo',
      'offo',
      'offo',
      'offo',
      'offo',
      'ollo',
      '.oo.',
    ],
  },
  kangaroo: {
    label: '袋鼠',
    earL: ['..oo.', '.ofo.', '.offo', 'ooffo', 'offfo', 'offfo', 'offfo', '.offo', '..oo.'],
    earR: ['..oo.', '.odo.', '.oddo', 'ooddo', 'odddo', 'odddo', 'odddo', '.oddo', '..oo.'],
    tail: [ // 粗壮支撑尾 13×7
      '.........ooo.',
      '......oooffo.',
      '...ooofffffo.',
      '.ooffffffffo.',
      'offffffffffo.',
      'offffffffoo..',
      '.oooooooo....',
    ],
    pouch: [ // 育儿袋（叠在身体中下）6×5
      '.oooo.',
      'opllpo',
      'opllpo',
      'opllpo',
      '.oooo.',
    ],
    legB: ['offfo', 'offfo', 'offfo', 'offfo', 'offfo', 'offfo', 'opppo', '.ooo.'],
    legB2: ['odddo', 'odddo', 'odddo', 'odddo', 'odddo', 'odddo', 'odddo', '.ooo.'],
  },
  tiger: {
    label: '老虎',
    earL: ['..oo..', '.offo.', '.offfo', 'offffo', 'opffpo', 'offffo'],
    earR: ['..oo..', '.oddo.', '.oddo.', 'oddddo', 'oddpdo', 'oddddo'],
    tail: [ // 虎尾带环纹 11×9
      '.........oo',
      '........ofo',
      '.......odfo',
      '......offo.',
      '.o...odfo..',
      '.o..offo...',
      '.o.odfo....',
      '.oollo.....',
      '.ooo.......',
    ],
    // 身体条纹：stripeV 覆盖件相对身体的列偏移（行从身体顶 +1）
    bodyStripes: [2, 5, 8, 11],
    headStripe: true, // 额头一条
  },
  lion: {
    label: '狮子',
    earL: ['..oo..', '.offo.', '.offfo', 'offffo', 'opffpo', 'offffo'],
    earR: ['..oo..', '.oddo.', '.oddo.', 'oddddo', 'oddpdo', 'oddddo'],
    tail: [ // 尾尖毛球 11×8
      '.........oo',
      '........ofo',
      '.......offo',
      '......offo.',
      '.o...offo..',
      '.o..offo...',
      '.o.offdll..',
      '.ooolllo...',
    ],
    mane: [ // 鬃毛（实心大圆，头叠上层）18×14
      '......oooooo......',
      '...oooddddddooo...',
      '..oodddddddddddoo.',
      '.oodddddddddddddo.',
      'oodddddddddddddddo',
      'oodddddddddddddddo',
      'oddddddddddddddddo',
      'oddddddddddddddddo',
      'oddddddddddddddddo',
      'oodddddddddddddddo',
      'ooddddddddddddddo.',
      '.ooddddddddddddoo.',
      '..ooddddddddddo...',
      '...oooddddddoo....',
    ],
  },
  pig: {
    label: '小猪',
    earL: ['.oo..', 'offo.', 'offfo', 'offfo', '.ooo.'],
    earR: ['.oo..', 'oddo.', '.oddo', '.oddo', '.odo.'],
    tail: [ // 卷尾 6×5
      '.oo...',
      'offoo.',
      '.offo.',
      '.offoo',
      '...oo.',
    ],
    bigNose: [ // 猪鼻盘（大，替代小鼻子）5×4
      '.ooo.',
      'opopo',
      'opopo',
      '.ooo.',
    ],
  },
  sheep: {
    label: '小羊',
    earL: ['..oo.', 'ooffo', '.offo', '..oo.'],
    earR: ['..oo.', 'ooddo', '.oddo', '..oo.'],
    tail: ['.oo.', 'ollo', 'ollo', '.oo.'],
    body: [ // 云朵绒毛身 18×12（椭圆生成）
      '.oooolllllllloooo.',
      'ooollllllllllllooo',
      'oolllllllllllllloo',
      'ollllllllllllllllo',
      'llllllllllllllllll',
      'llllllllllllllllll',
      'llllllllllllllllll',
      'llllllllllllllllll',
      'ollllllllllllllllo',
      'oolllllllllllllloo',
      'ooollllllllllllooo',
      '.oooolllllllloooo.',
    ],
    head: [ // 卷毛围脸（脸居中）14×11（椭圆生成）
      '.ooollllllooo.',
      'oolllllllllloo',
      'ollffffffffllo',
      'lllfffffffflll',
      'lllfffffffflll',
      'lllfffffffflll',
      'lllfffffffflll',
      'lllfffffffflll',
      'ollffffffffllo',
      'oolllllllllloo',
      '.ooollllllooo.',
    ],
  },
  bear: {
    label: '小熊',
    earL: ['.ooo..', 'offfo.', 'offffo', 'offffo', '.offfo', '..oo..'],
    earR: ['.ooo..', 'oddo..', 'odddo.', 'odddo.', '.oddo.', '..oo..'],
    tail: ['oo..', 'ofoo', '.oo.'],
    muzzle: [ // 熊大口鼻 6×5
      '.ooo..',
      'ollllo',
      'ollllo',
      'ollllo',
      '.ooo..',
    ],
  },
};

// ---------- 物种配色（每物种多个备选） ----------
export const PALETTES = {
  dog: [
    { name: '金毛', o: '#463222', f: '#e2a95c', l: '#f8e3bb', d: '#b97f3a', p: '#e8a2a2', k: '#2a2118', w: '#ffffff', r: '#e06c6c' },
    { name: '柴犬', o: '#4a3626', f: '#dd8f45', l: '#fdf3e0', d: '#96602c', p: '#e8a2a2', k: '#2a2118', w: '#ffffff', r: '#e06c6c' },
    { name: '奶白', o: '#8a7a62', f: '#f2e9d8', l: '#fbf6ec', d: '#cbb894', p: '#e8a2a2', k: '#3a3026', w: '#ffffff', r: '#e06c6c' },
  ],
  cat: [
    { name: '橘猫', o: '#5a3a20', f: '#eda55b', l: '#fbe8cc', d: '#c97a35', p: '#e8a2a2', k: '#2a2118', w: '#ffffff', r: '#e06c6c' },
    { name: '蓝灰', o: '#3a3f4d', f: '#9aa7bd', l: '#e6ecf5', d: '#6f7d96', p: '#e8a2a2', k: '#22262e', w: '#ffffff', r: '#e06c6c' },
  ],
  elephant: [
    { name: '小灰', o: '#41465a', f: '#98a2bd', l: '#ccd3e4', d: '#6f7a99', p: '#d9a0b0', k: '#262a36', w: '#ffffff', r: '#e06c6c' },
    { name: '粉灰', o: '#4d3f4e', f: '#b9a3bd', l: '#e8d8e8', d: '#928099', p: '#e8a2b8', k: '#2a222c', w: '#ffffff', r: '#e06c6c' },
  ],
  kangaroo: [
    { name: '棕袋鼠', o: '#4c3524', f: '#c99a67', l: '#efd9b4', d: '#9d7244', p: '#e8a2a2', k: '#2a2118', w: '#ffffff', r: '#e06c6c' },
    { name: '沙色', o: '#54432e', f: '#dcc294', l: '#f6ecd7', d: '#b09468', p: '#e8a2a2', k: '#2a2118', w: '#ffffff', r: '#e06c6c' },
  ],
  tiger: [
    { name: '经典橙', o: '#3d2717', f: '#ef9f3e', l: '#fbe2b8', d: '#3d2717', p: '#e8a2a2', k: '#241a10', w: '#ffffff', r: '#e06c6c' },
    { name: '雪虎', o: '#3c4656', f: '#e9edf2', l: '#ffffff', d: '#8f9bad', p: '#e8a2a2', k: '#22262e', w: '#ffffff', r: '#e06c6c' },
  ],
  lion: [
    { name: '金狮', o: '#4d3517', f: '#e8bb63', l: '#f9e8c0', d: '#a8752c', p: '#e8a2a2', k: '#2a2118', w: '#ffffff', r: '#e06c6c' },
    { name: '棕狮', o: '#41291a', f: '#c99a5e', l: '#efd9ae', d: '#8c5f2c', p: '#e8a2a2', k: '#2a2118', w: '#ffffff', r: '#e06c6c' },
  ],
  pig: [
    { name: '粉猪', o: '#5e3a44', f: '#f0a7b0', l: '#fadce0', d: '#cf7f8c', p: '#e2708a', k: '#3a2429', w: '#ffffff', r: '#e06c6c' },
    { name: '黑花', o: '#33262a', f: '#5c5158', l: '#f0a7b0', d: '#463c43', p: '#e2708a', k: '#1c1518', w: '#ffffff', r: '#e06c6c' },
  ],
  sheep: [
    { name: '白羊', o: '#5b5245', f: '#8d7b64', l: '#f4efe2', d: '#6e5f4c', p: '#e8a2a2', k: '#2a241c', w: '#ffffff', r: '#e06c6c' },
    { name: '棕羊', o: '#4d3c2c', f: '#a08363', l: '#e8d9bf', d: '#7c6247', p: '#e8a2a2', k: '#2a2118', w: '#ffffff', r: '#e06c6c' },
  ],
  bear: [
    { name: '棕熊', o: '#3f2c1c', f: '#a9744a', l: '#e2c398', d: '#7f5432', p: '#e8a2a2', k: '#241a10', w: '#ffffff', r: '#e06c6c' },
    { name: '白熊', o: '#6b7280', f: '#eef1f4', l: '#ffffff', d: '#c3cad3', p: '#e8a2a2', k: '#2c3138', w: '#ffffff', r: '#e06c6c' },
  ],
};

// ---------- 独立调色的精灵（食物/玩具/粪便/特效），自带 palette ----------
export const SPRITES = {
  rice: { // 饭碗
    grid: ['.lwwl..', 'wwwwww.', '.oooo..', '.oyyyo.', '.oyyyo.', '..oo...'],
    palette: { o: '#7a4a2a', w: '#ffffff', l: '#f2ecdd', y: '#e8b84f' },
  },
  water: { // 水碗
    grid: ['.bbbb..', 'bbbbbb.', '.oooo..', '.oyyyo.', '.oyyyo.', '..oo...'],
    palette: { o: '#7a4a2a', b: '#5fa8e8', y: '#e8b84f' },
  },
  snack: { // 骨头饼干
    grid: ['.o...o..', 'owwwwo..', 'owwwwwoo', '.owwwwo.', '.o...o..'],
    palette: { o: '#8a6a4a', w: '#f6ead2' },
  },
  banana: {
    grid: ['....od..', '...oyyo.', '..oyyoo.', '.oyyoo..', 'oyyoo...', 'oyyo....', '.oo.....'],
    palette: { o: '#7a6a2a', y: '#f5d94f', d: '#6b5a2a' },
  },
  apple: {
    grid: ['..od..', '.orro.', 'orrrro', 'orrrro', 'orrrro', '.ooo..'],
    palette: { o: '#6e2a2a', r: '#e85d5d', d: '#4a7a3a' },
  },
  pill: {
    grid: ['.oooo..', 'orwwwo.', 'orwwwo.', '.oooo..'],
    palette: { o: '#5a4a6a', r: '#e87a9a', w: '#f5f0fa' },
  },
  yarn: { // 毛线球 7×7
    grid: ['..ooo..', '.orrro.', 'orrprro', 'orprpro', 'orrprro', '.orrro.', '..ooo..'],
    palette: { o: '#7a3a3a', r: '#e87a7a', p: '#c95c5c' },
  },
  block: {
    grid: ['.ooooo.', 'oyyyyyo', 'oyyyyyo', '.ooooo.'],
    palette: { o: '#6a5a2a', y: '#f2c94c' },
  },
  blockB: {
    grid: ['.ooooo.', 'obbbbbo', 'obbbbbo', '.ooooo.'],
    palette: { o: '#2a4a6a', b: '#5fa8e8' },
  },
  train: { // 电动小火车 17×8
    grid: [
      '..........ooooo..',
      '.........oyyyyo..',
      'oooooo...oyyyyo..',
      'orrrro.ooooooooo.',
      'orrrrooyyyyyyyyо.'.replace('о', 'o'),
      'orrrroooooooooo..',
      '.okko......okko..',
      '..oo........oo...',
    ],
    palette: { o: '#3a3a4a', r: '#e8705a', y: '#f2c94c', k: '#22222a' },
  },
  pot: {
    grid: ['.oooooo.', 'ollllllo', 'ollllllo', 'oooooooo', '.o....o.'],
    palette: { o: '#4a4a5a', l: '#9aa2bd' },
  },
  bubble: {
    grid: ['oo.', 'olo', '.o.'],
    palette: { o: '#7ab8e8', l: '#d8efff' },
  },
  poop: { // 粪便 7×6
    grid: ['..oo...', '.oddo..', 'oddddo.', 'odddddo', 'odddddo', '.ooooo.'],
    palette: { o: '#3f2a1a', d: '#8a5c33' },
  },
  poopFly: {
    grid: ['o.o', '.o.'],
    palette: { o: '#3a3a3a' },
  },
  heart: {
    grid: ['.o.o.', 'ooooo', 'ooooo', '.ooo.'],
    palette: { o: '#ef6a6a' },
  },
  angry: {
    grid: ['o.o.', '.o..', 'o.o.'],
    palette: { o: '#e85d5d' },
  },
  zzz: {
    grid: ['ooo.', '..o.', '.o..', 'oooo'],
    palette: { o: '#8ab4f8' },
  },
  sparkle: {
    grid: ['..o..', '..o..', 'ooooo', '..o..', '..o..'],
    palette: { o: '#ffe58a' },
  },
  sweat: {
    grid: ['.o.', 'olo', 'olo', '.o.'],
    palette: { o: '#5fa8e8', l: '#bfe0fa' },
  },
  note: {
    grid: ['..oo', '..o.', '..o.', '.oo.', 'ooo.', '.o..'],
    palette: { o: '#b89af8' },
  },
};

// ---------- 物种元信息 ----------
export const SPECIES_LIST = Object.entries(SPECIES_PARTS).map(([key, v]) => ({
  key,
  label: v.label,
  variants: (PALETTES[key] || []).map((p, i) => ({ index: i, name: p.name })),
}));
