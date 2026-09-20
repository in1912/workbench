// 打字赚钱内容库：诗词（多类型库）+ 歌曲（爱国/儿歌/流行），均带汉字原文与逐字拼音。
// 拼音约定：无声调、无分隔符；ü 写作 v（与绿 lv 一致）；练习时逐字母匹配。

// 旋律辅助：空格分隔的频率串 → [{freq,dur}]，给 audio.startMelody 用
const mel = (s, dur = 0.3) => s.trim().split(/\s+/).map((x) => ({ freq: +x, dur }));

// ---------- 诗词库（多类型） ----------
export const POEM_LIBS = [
  {
    key: 'tang', label: '唐诗', poems: [
      { title: '静夜思', author: '李白', text: '床前明月光，疑是地上霜。举头望明月，低头思故乡。', pinyin: 'chuang qian ming yue guang ， yi shi di shang shuang 。 ju tou wang ming yue ， di tou si gu xiang 。' },
      { title: '春晓', author: '孟浩然', text: '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。', pinyin: 'chun mian bu jue xiao ， chu chu wen ti niao 。 ye lai feng yu sheng ， hua luo zhi duo shao 。' },
      { title: '登鹳雀楼', author: '王之涣', text: '白日依山尽，黄河入海流。欲穷千里目，更上一层楼。', pinyin: 'bai ri yi shan jin ， huang he ru hai liu 。 yu qiong qian li mu ， geng shang yi ceng lou 。' },
      { title: '望庐山瀑布', author: '李白', text: '日照香炉生紫烟，遥看瀑布挂前川。飞流直下三千尺，疑是银河落九天。', pinyin: 'ri zhao xiang lu sheng zi yan ， yao kan pu bu gua qian chuan 。 fei liu zhi xia san qian chi ， yi shi yin he luo jiu tian 。' },
      { title: '绝句', author: '杜甫', text: '两个黄鹂鸣翠柳，一行白鹭上青天。窗含西岭千秋雪，门泊东吴万里船。', pinyin: 'liang ge huang li ming cui liu ， yi xing bai lu shang qing tian 。 chuang han xi ling qian qiu xue ， men bo dong wu wan li chuan 。' },
      { title: '相思', author: '王维', text: '红豆生南国，春来发几枝。愿君多采撷，此物最相思。', pinyin: 'hong dou sheng nan guo ， chun lai fa ji zhi 。 yuan jun duo cai xie ， ci wu zui xiang si 。' },
      { title: '咏鹅', author: '骆宾王', text: '鹅鹅鹅，曲项向天歌。白毛浮绿水，红掌拨清波。', pinyin: 'e e e ， qu xiang xiang tian ge 。 bai mao fu lv shui ， hong zhang bo qing bo 。' },
      { title: '悯农', author: '李绅', text: '锄禾日当午，汗滴禾下土。谁知盘中餐，粒粒皆辛苦。', pinyin: 'chu he ri dang wu ， han di he xia tu 。 shei zhi pan zhong can ， li li jie xin ku 。' },
      { title: '游子吟', author: '孟郊', text: '慈母手中线，游子身上衣。临行密密缝，意恐迟迟归。谁言寸草心，报得三春晖。', pinyin: 'ci mu shou zhong xian ， you zi shen shang yi 。 lin xing mi mi feng ， yi kong chi chi gui 。 shei yan cun cao xin ， bao de san chun hui 。' },
      { title: '江雪', author: '柳宗元', text: '千山鸟飞绝，万径人踪灭。孤舟蓑笠翁，独钓寒江雪。', pinyin: 'qian shan niao fei jue ， wan jing ren zong mie 。 gu zhou suo li weng ， du diao han jiang xue 。' },
      { title: '鹿柴', author: '王维', text: '空山不见人，但闻人语响。返景入深林，复照青苔上。', pinyin: 'kong shan bu jian ren ， dan wen ren yu xiang 。 fan jing ru shen lin ， fu zhao qing tai shang 。' },
      { title: '早发白帝城', author: '李白', text: '朝辞白帝彩云间，千里江陵一日还。两岸猿声啼不住，轻舟已过万重山。', pinyin: 'zhao ci bai di cai yun jian ， qian li jiang ling yi ri huan 。 liang an yuan sheng ti bu zhu ， qing zhou yi guo wan chong shan 。' },
    ],
  },
  {
    key: 'song', label: '宋词', poems: [
      { title: '忆江南', author: '白居易', text: '江南好，风景旧曾谙。日出江花红胜火，春来江水绿如蓝。能不忆江南？', pinyin: 'jiang nan hao ， feng jing jiu zeng an 。 ri chu jiang hua hong sheng huo ， chun lai jiang shui lv ru lan 。 neng bu yi jiang nan ？' },
      { title: '渔歌子', author: '张志和', text: '西塞山前白鹭飞，桃花流水鳜鱼肥。青箬笠，绿蓑衣，斜风细雨不须归。', pinyin: 'xi sai shan qian bai lu fei ， tao hua liu shui gui yu fei 。 qing ruo li ， lv suo yi ， xie feng xi yu bu xu gui 。' },
      { title: '如梦令', author: '李清照', text: '常记溪亭日暮，沉醉不知归路。兴尽晚回舟，误入藕花深处。争渡，争渡，惊起一滩鸥鹭。', pinyin: 'chang ji xi ting ri mu ， chen zui bu zhi gui lu 。 xing jin wan hui zhou ， wu ru ou hua shen chu 。 zheng du ， zheng du ， jing qi yi tan ou lu 。' },
      { title: '清平乐·村居', author: '辛弃疾', text: '茅檐低小，溪上青青草。醉里吴音相媚好，白发谁家翁媪？大儿锄豆溪东，中儿正织鸡笼。最喜小儿亡赖，溪头卧剥莲蓬。', pinyin: 'mao yan di xiao ， xi shang qing qing cao 。 zui li wu yin xiang mei hao ， bai fa shui jia weng ao ？ da er chu dou xi dong ， zhong er zheng zhi ji long 。 zui xi xiao er wu lai ， xi tou wo bo lian peng 。' },
      { title: '长相思', author: '纳兰性德', text: '山一程，水一程，身向榆关那畔行，夜深千帐灯。风一更，雪一更，聒碎乡心梦不成，故园无此声。', pinyin: 'shan yi cheng ， shui yi cheng ， shen xiang yu guan na pan xing ， ye shen qian zhang deng 。 feng yi geng ， xue yi geng ， guo sui xiang xin meng bu cheng ， gu yuan wu ci sheng 。' },
    ],
  },
  {
    key: 'mengxue', label: '蒙学经典', poems: [
      { title: '三字经（节选）', author: '王应麟', text: '人之初，性本善。性相近，习相远。苟不教，性乃迁。教之道，贵以专。玉不琢，不成器。人不学，不知义。', pinyin: 'ren zhi chu ， xing ben shan 。 xing xiang jin ， xi xiang yuan 。 gou bu jiao ， xing nai qian 。 jiao zhi dao ， gui yi zhuan 。 yu bu zhuo ， bu cheng qi 。 ren bu xue ， bu zhi yi 。' },
      { title: '千字文（节选）', author: '周兴嗣', text: '天地玄黄，宇宙洪荒。日月盈昃，辰宿列张。寒来暑往，秋收冬藏。', pinyin: 'tian di xuan huang ， yu zhou hong huang 。 ri yue ying ze ， chen xiu lie zhang 。 han lai shu wang ， qiu shou dong cang 。' },
      { title: '声律启蒙（节选）', author: '车万育', text: '云对雨，雪对风，晚照对晴空。来鸿对去燕，宿鸟对鸣虫。', pinyin: 'yun dui yu ， xue dui feng ， wan zhao dui qing kong 。 lai hong dui qu yan ， su niao dui ming chong 。' },
    ],
  },
];

// ---------- 歌曲库（爱国/儿歌/流行） ----------
export const SONG_CATS = [
  {
    key: 'patriotic', label: '爱国歌曲', songs: [
      {
        name: '我爱北京天安门', lyrics: '我爱北京天安门，天安门上太阳升。伟大领袖毛主席，指引我们向前进。',
        pinyin: 'wo ai bei jing tian an men ， tian an men shang tai yang sheng 。 wei da ling xiu mao zhu xi ， zhi yin wo men xiang qian jin 。',
        melody: mel('784 784 784 523 784 880 784 523 440 392 880 784', 0.3),
      },
      {
        name: '义勇军进行曲', lyrics: '起来不愿做奴隶的人们，把我们的血肉筑成我们新的长城。中华民族到了最危险的时候，每个人被迫着发出最后的吼声。起来起来起来！',
        pinyin: 'qi lai bu yuan zuo nu li de ren men ， ba wo men de xue rou zhu cheng wo men xin de chang cheng 。 zhong hua min zu dao le zui wei xian de shi hou ， mei ge ren bei po zhe fa chu zui hou de hou sheng 。 qi lai qi lai qi lai ！',
        melody: mel('660 660 660 784 880 784 660 784 880 1047 880 784 660 523', 0.25),
      },
      {
        name: '我的祖国', lyrics: '一条大河波浪宽，风吹稻花香两岸。我家就在岸上住，听惯了艄公的号子，看惯了船上的白帆。',
        pinyin: 'yi tiao da he bo lang kuan ， feng chui dao hua xiang liang an 。 wo jia jiu zai an shang zhu ， ting guan le shao gong de hao zi ， kan guan le chuan shang de bai fan 。',
        melody: mel('392 440 523 440 392 330 294 330 392 523 392 330 294 262', 0.3),
      },
      {
        name: '歌唱祖国', lyrics: '五星红旗迎风飘扬，胜利歌声多么嘹亮。歌唱我们亲爱的祖国，从今走向繁荣富强。',
        pinyin: 'wu xing hong qi ying feng piao yang ， sheng li ge sheng duo me liao liang 。 ge chang wo men qin ai de zu guo ， cong jin zou xiang fan rong fu qiang 。',
        melody: mel('523 523 587 659 784 659 587 523 587 659 784 880 1047 880 784 659', 0.25),
      },
      {
        name: '没有共产党就没有新中国', lyrics: '没有共产党就没有新中国，没有共产党就没有新中国。共产党辛劳为民族，共产党他一心救中国。',
        pinyin: 'mei you gong chan dang jiu mei you xin zhong guo ， mei you gong chan dang jiu mei you xin zhong guo 。 gong chan dang xin lao wei min zu ， gong chan dang ta yi xin jiu zhong guo 。',
        melody: mel('392 440 523 587 523 440 392 440 523 587 659 784 587 523 440', 0.25),
      },
      {
        name: '团结就是力量', lyrics: '团结就是力量，团结就是力量。这力量是铁，这力量是钢。比铁还硬比钢还强。',
        pinyin: 'tuan jie jiu shi li liang ， tuan jie jiu shi li liang 。 zhe li liang shi tie ， zhe li liang shi gang 。 bi tie hai ying bi gang hai qiang 。',
        melody: mel('392 440 523 440 392 330 294 330 392 523 440 392 330 294', 0.25),
      },
    ],
  },
  {
    key: 'children', label: '儿歌', songs: [
      {
        name: '两只老虎', lyrics: '两只老虎，两只老虎，跑得快，跑得快。一只没有眼睛，一只没有尾巴，真奇怪，真奇怪。',
        pinyin: 'liang zhi lao hu ， liang zhi lao hu ， pao de kuai ， pao de kuai 。 yi zhi mei you yan jing ， yi zhi mei you wei ba ， zhen qi guai ， zhen qi guai 。',
        melody: mel('262 294 330 262 262 294 330 262 330 349 392 330 349 392 392 440 392 349 330 262 392 440 392 349 330 262 262 392 523 262 392 523', 0.28),
      },
      {
        name: '小星星', lyrics: '一闪一闪亮晶晶，满天都是小星星。挂在天上放光明，好像许多小眼睛。',
        pinyin: 'yi shan yi shan liang jing jing ， man tian dou shi xiao xing xing 。 gua zai tian shang fang guang ming ， hao xiang xu duo xiao yan jing 。',
        melody: mel('262 262 392 392 440 440 392 349 349 330 330 294 294 262', 0.35),
      },
      {
        name: '数鸭子', lyrics: '门前大桥下，游过一群鸭，快来快来数一数，二四六七八。嘎嘎嘎嘎，真呀真多鸭，数不清到底多少鸭。',
        pinyin: 'men qian da qiao xia ， you guo yi qun ya ， kuai lai kuai lai shu yi shu ， er si liu qi ba 。 ga ga ga ga ， zhen ya zhen duo ya ， shu bu qing dao di duo shao ya 。',
      },
      {
        name: '世上只有妈妈好', lyrics: '世上只有妈妈好，有妈的孩子像块宝。投进妈妈的怀抱，幸福享不了。',
        pinyin: 'shi shang zhi you ma ma hao ， you ma de hai zi xiang kuai bao 。 tou jin ma ma de huai bao ， xing fu xiang bu liao 。',
      },
      {
        name: '找朋友', lyrics: '找呀找呀找朋友，找到一个好朋友。敬个礼呀握握手，你是我的好朋友。',
        pinyin: 'zhao ya zhao ya zhao peng you ， zhao dao yi ge hao peng you 。 jing ge li ya wo wo shou ， ni shi wo de hao peng you 。',
      },
      {
        name: '春天在哪里', lyrics: '春天在哪里呀，春天在哪里。春天在那青翠的山林里。这里有红花呀，这里有绿草，还有那会唱歌的小黄鹂。',
        pinyin: 'chun tian zai na li ya ， chun tian zai na li 。 chun tian zai na qing cui de shan lin li 。 zhe li you hong hua ya ， zhe li you lv cao ， hai you na hui chang ge de xiao huang li 。',
      },
      {
        name: '虫儿飞', lyrics: '黑黑的天空低垂，亮亮的繁星相随。虫儿飞，虫儿飞，你在思念谁。',
        pinyin: 'hei hei de tian kong di chui ， liang liang de fan xing xiang sui 。 chong er fei ， chong er fei ， ni zai si nian shui 。',
      },
    ],
  },
  {
    key: 'pop', label: '流行歌曲', songs: [
      {
        name: '童年（节选）', lyrics: '池塘边的榕树上，知了在声声叫着夏天。操场边的秋千上，只有蝴蝶停在上面。',
        pinyin: 'chi tang bian de rong shu shang ， zhi liao zai sheng sheng jiao zhe xia tian 。 cao chang bian de qiu qian shang ， zhi you hu die ting zai shang mian 。',
      },
      {
        name: '隐形的翅膀（节选）', lyrics: '每一次都在徘徊孤单中坚强，每一次就算很受伤也不闪泪光。我知道我一直有双隐形的翅膀，带我飞飞过绝望。',
        pinyin: 'mei yi ci dou zai pai huai gu dan zhong jian qiang ， mei yi ci jiu suan hen shou shang ye bu shan lei guang 。 wo zhi dao wo yi zhi you shuang yin xing de chi bang ， dai wo fei fei guo jue wang 。',
      },
      {
        name: '阳光总在风雨后（节选）', lyrics: '阳光总在风雨后，请相信有彩虹。风风雨雨都接受，我一直会在你的左右。',
        pinyin: 'yang guang zong zai feng yu hou ， qing xiang xin you cai hong 。 feng feng yu yu dou jie shou ， wo yi zhi hui zai ni de zuo you 。',
      },
      {
        name: '明天会更好（节选）', lyrics: '轻轻敲醒沉睡的心灵，慢慢张开你的眼睛。看看忙碌的世界是否依然孤独地转个不停。',
        pinyin: 'qing qing qiao xing chen shui de xin ling ， man man zhang kai ni de yan jing 。 kan kan mang lu de shi jie shi fou yi ran gu du de zhuan ge bu ting 。',
      },
      {
        name: '我的未来不是梦（节选）', lyrics: '我知道我的未来不是梦，我认真地过每一分钟。我的未来不是梦，我的心跟着希望在动。',
        pinyin: 'wo zhi dao wo de wei lai bu shi meng ， wo ren zhen de guo mei yi fen zhong 。 wo de wei lai bu shi meng ， wo de xin gen zhe xi wang zai dong 。',
      },
      {
        name: '海阔天空（节选）', lyrics: '原谅我这一生不羁放纵爱自由，也会怕有一天会跌倒。背弃了理想谁人都可以，哪会怕有一天只你共我。',
        pinyin: 'yuan liang wo zhe yi sheng bu ji fang zong ai zi you ， ye hui pa you yi tian hui die dao 。 bei qi le li xiang shui ren dou ke yi ， na hui pa you yi tian zhi ni gong wo 。',
      },
      {
        name: '真心英雄（节选）', lyrics: '把握生命里的每一分钟，全力以赴我们心中的梦。不经历风雨怎么见彩虹，没有人能随随便便成功。',
        pinyin: 'ba wo sheng ming li de mei yi fen zhong ， quan li yi fu wo men xin zhong de meng 。 bu jing li feng yu zen me jian cai hong ， mei you ren neng sui sui bian bian cheng gong 。',
      },
      {
        name: '蜗牛与黄鹂鸟', lyrics: '阿门阿前一棵葡萄树，阿嫩阿嫩绿地刚发芽。蜗牛背着那重重的壳呀，一步一步地往上爬。',
        pinyin: 'a men a qian yi ke pu tao shu ， a nen a nen lv di gang fa ya 。 wo niu bei zhe na zhong zhong de ke ya ， yi bu yi bu di wang shang pa 。',
      },
    ],
  },
];

// 汉字 + 拼音串 → 练习单元数组：汉字单元带拼音（逐字母打），标点/空白单元自动跳过
export function parseUnits(hanzi, pinyin) {
  const tokens = String(pinyin || '').trim().split(/\s+/);
  let ti = 0;
  const next = () => {
    while (ti < tokens.length && !/[a-z]/i.test(tokens[ti])) ti++;
    return tokens[ti++] || '';
  };
  const units = [];
  for (const ch of String(hanzi || '')) {
    if (/[一-鿿]/.test(ch)) units.push({ h: ch, p: next().toLowerCase() });
    else if (/\s/.test(ch)) continue;
    else units.push({ h: ch, skip: true });
  }
  return units;
}

// 英文练习默认文本
export const GAME_DEFAULT_TEXT = 'hello world welcome to typing game practice makes perfect just do it keep going you are doing great';
export const PIANO_DEFAULT_TEXT = 'PLAYTHESONGOFTYPINGONTHEGOLDENPIANOKEYSOFHARMONYANDLIGHTMUSICFILLSTHEAIRWITHEVERYTOUCH';
