// 计分引擎 —— 逻辑复刻自两份《自动生成结果版》Excel：
// 28题版：每题 A=+1 / B=-1；EI 段 E=A数 I=B数；NS 段 N=A数 S=B数；FT 段 F=A数 T=B数；JP 段 J=A数 P=B数
// 93题版：每个选项直接计入其归属字母（阴影格所在列），共 8 个字母计数
// 判定（两版一致）：E>I?E:I；S>N?S:N；T>F?T:F；J>P?J:P —— 平局取第二个字母（93版原表："两边分数相同，勾选右边那一个"）
(function () {
  'use strict';

  const DIMENSIONS = [
    { key: 'EI', left: 'E', right: 'I' },
    { key: 'SN', left: 'S', right: 'N' },
    { key: 'TF', left: 'T', right: 'F' },
    { key: 'JP', left: 'J', right: 'P' },
  ];

  function newScores() {
    return { E: 0, I: 0, S: 0, N: 0, T: 0, F: 0, J: 0, P: 0 };
  }

  // 统计：answers 为题号(1-based)→选项下标(0/1) 映射；questions 为扁平题数组（带 choices[].letter）
  function tally(questions, answers) {
    const scores = newScores();
    questions.forEach((q, i) => {
      const choice = answers[i + 1];
      if (choice == null) return;
      const c = q.choices[choice];
      if (c && c.letter) scores[c.letter]++;
    });
    return scores;
  }

  function decide(scores) {
    return DIMENSIONS.map(d => (scores[d.left] > scores[d.right] ? d.left : d.right)).join('');
  }

  function dimensionStats(scores) {
    return DIMENSIONS.map(d => {
      const left = scores[d.left], right = scores[d.right];
      const total = left + right;
      const winner = left > right ? d.left : d.right;
      const winCount = Math.max(left, right);
      const ratio = total > 0 ? winCount / total : 0.5;
      return {
        key: d.key, left: d.left, right: d.right,
        leftCount: left, rightCount: right, total,
        winner, winCount, ratio,
        // 展示用：获胜字母得分与对方得分（平局时按判定规则取 right，展示为 50/50）
        leftPct: total > 0 ? Math.round((left / total) * 100) : 50,
        rightPct: total > 0 ? Math.round((right / total) * 100) : 50,
        tie: left === right,
      };
    });
  }

  function clarityLabel(ratio) {
    const levels = (window.MBTI_CONTENT && window.MBTI_CONTENT.clarityLevels) || [];
    const lv = levels.find(l => ratio >= l.min && ratio < l.max);
    return lv || { label: '—', desc: '' };
  }

  // 顶层：对一份作答计算完整结果
  // flat93() 由 app 提供（把 4 个部分拍平成 93 题数组）
  function computeResult(questions, answers, extra) {
    const scores = tally(questions, answers);
    const type = decide(scores);
    const stats = dimensionStats(scores);
    const answered = Object.keys(answers).length;
    return Object.assign({
      type, scores, stats, answered, total: questions.length,
    }, extra || {});
  }

  // 由类型代码得到气质分组：xSxJ→SJ, xSxP→SP, xNTx→NT, xNFx→NF
  function temperamentOf(type) {
    const [e, sn, tf, jp] = type.split('');
    if (sn === 'N') return tf === 'T' ? 'NT' : 'NF';
    return jp === 'J' ? 'SJ' : 'SP';
  }

  window.MBTI_SCORING = { DIMENSIONS, newScores, tally, decide, dimensionStats, clarityLabel, computeResult, temperamentOf };
})();
