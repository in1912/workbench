// 心理测试中心 H5 —— 路由与页面渲染（底部导航：首页 / 测试 / 我的）
// 四大主测：MBTI（28/93 题）/ 霍兰德 / DISC / 九型人格；100+ 趣味测试（fun/*.json 懒加载）
(function () {
  'use strict';

  const C = window.MBTI_CONTENT;
  const BANKS = { '28': window.MBTI_BANK_28, '93': window.MBTI_BANK_93 };
  const REPORTS = window.MBTI_TYPE_REPORTS;
  const S = window.MBTI_SCORING;
  const P = window.MBTI_PROFILE;
  const U = window.MBTI_USER;
  const AI = window.MBTI_AI;
  const BRIDGE = window.MBTI_BRIDGE;
  const SVR = window.MBTI_SERVER;
  const SITE = window.MBTI_SITE;
  const ADMIN = window.MBTI_ADMIN;
  const ENG = window.MBTI_ENGINES;
  // 工作台部署（/dep/）：管理功能与分享前缀配置都在工作台「效率工具 → 抑郁测试」页
  const MODE_WB = SVR && SVR.mode() === 'workbench';
  // 题库 ID（懒加载 fun/<id>.json）：趣味 f001…/抑郁 d01…/专业 p001… —— 单字母前缀+数字
  const FUN_ID = /^[a-z]+\d+$/;

  const app = document.getElementById('app');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // 档案时间展示：finishedAt 存的是 toISOString() 的 UTC 串（带 Z）→ 转本机时区，
  // 否则显示会比北京时间早 8 小时；非 ISO（已是本地格式）直接截取
  function fmtTime(iso) {
    if (!iso) return '';
    const s = String(iso);
    if (/Z$|[+-]\d{2}:?\d{2}$/.test(s)) {
      const d = new Date(s);
      if (!isNaN(d)) {
        const p = n => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
      }
    }
    return s.slice(0, 16).replace('T', ' ');
  }
  const dimOf = t => C.dimensions.find(d => d.key === t) || {};
  const typeMeta = t => Object.assign({ code: t }, C.typesOverview[t] || {}, REPORTS[t] || {});

  // 93 题版拍平（记录所属部分）
  const flat93 = [];
  window.MBTI_BANK_93.sections.forEach((sec, si) => {
    sec.questions.forEach(q => flat93.push(Object.assign({ section: si, sectionName: sec.name }, q)));
  });
  function bankOf(v) { return v === '93' ? { flat: flat93, meta: BANKS['93'] } : { flat: BANKS['28'].questions, meta: BANKS['28'] }; }

  // ============ 路由 ============
  const PAGES_WITH_TABBAR = new Set(['home', 'intro', 'testhub', 'settings', 'me', 'types', 'admin', 'users']);
  function go(hash, replace) {
    if (replace) location.replace(hash);
    else location.hash = hash;
  }
  function route() {
    const raw = location.hash || '#/home';
    const [pathPart, queryPart] = raw.split('?');
    const parts = pathPart.replace(/^#\//, '').split('/');
    window.scrollTo(0, 0);
    const page = parts[0] || 'home';
    try {
      if (page === 'home') renderHome();
      else if (page === 'intro') renderIntro(parts[1] || 'list', parts[2]);
      else if (page === 'testhub') renderTestHub();
      else if (page === 'start') renderStart(parts[1]);
      else if (page === 'test') renderTest(parts[1]);
      else if (page === 'result') renderResult(parts[1]);
      else if (page === 'settings') renderSettings();
      else if (page === 'me') renderMe();
      else if (page === 'match') renderMatch(new URLSearchParams(queryPart || ''));
      else if (page === 'matchType') renderMatchType();
      else if (page === 'types') renderTypes();
      else if (page === 'type') renderType(parts[1]);
      else if (page === 'admin') renderAdmin();
      else if (page === 'users') renderUsers();
      else renderHome();
    } catch (e) {
      console.error(e);
      app.innerHTML = '<div class="page"><div class="card"><h2>页面出错了</h2><p>' + esc(e.message) + '</p></div></div>';
    }
    // 底部导航显隐
    const tabbar = document.getElementById('tabbar');
    const showTabbar = PAGES_WITH_TABBAR.has(page);
    if (tabbar) tabbar.classList.toggle('hidden', !showTabbar);
    document.body.classList.toggle('has-tabbar', showTabbar);
    // 高亮 + 管理员专属 tab（系统用户）显隐
    const map = { home: 'home', intro: 'home', testhub: 'test', me: 'me', settings: 'me', types: 'home', users: 'users', admin: 'me' };
    const isAdminOn = MODE_WB ? false : ADMIN.loggedIn();
    document.querySelectorAll('#tabbar .tab-item').forEach(el => {
      el.classList.toggle('on', el.dataset.page === map[page]);
      if (el.classList.contains('admin-only')) el.hidden = !isAdminOn;
    });
  }
  window.addEventListener('hashchange', route);

  // ============ 公共组件 ============
  function backBar(title, backHref) {
    return `<div class="topbar"><a class="back" href="${backHref || '#/testhub'}">‹ 返回</a><span>${esc(title)}</span></div>`;
  }

  function dimBar(st) {
    const d = dimOf(st.key);
    const L = d.left || {}, R = d.right || {};
    const clarity = S.clarityLabel(st.ratio);
    return `<div class="dim-row">
      <div class="dim-names"><span class="dim-letter">${st.left}</span><span class="dim-name">${esc(L.name || '')}</span></div>
      <div class="dim-bar-wrap">
        <div class="dim-count ${st.winner === st.left ? 'win' : ''}">${st.leftCount}</div>
        <div class="dim-bar"><div class="dim-fill" style="width:${st.leftPct}%"></div></div>
        <div class="dim-count ${st.winner === st.right ? 'win' : ''}">${st.rightCount}</div>
      </div>
      <div class="dim-names right"><span class="dim-letter">${st.right}</span><span class="dim-name">${esc(R.name || '')}</span></div>
      <div class="dim-verdict">倾向：<b>${st.winner}</b> ${esc((st.winner === st.left ? L : R).name || '')} · ${esc(clarity.label)}${st.tie ? '（平局，按计分规则判定）' : ''}</div>
    </div>`;
  }

  // 四维度雷达图（纯 SVG，离线可用）：四个轴 = E/I, N/S, F/T, P/J（顺时针），顶点标获胜字母与强度
  function radarSvg(stats, size) {
    const sz = size || 300, cx = sz / 2, cy = sz / 2, R = sz * 0.36;
    const axes = [
      { key: 'EI', winLabel: st => st.winner, value: st => Math.max(st.leftPct, st.rightPct) },
      { key: 'SN', winLabel: st => st.winner, value: st => Math.max(st.leftPct, st.rightPct) },
      { key: 'TF', winLabel: st => st.winner, value: st => Math.max(st.leftPct, st.rightPct) },
      { key: 'JP', winLabel: st => st.winner, value: st => Math.max(st.leftPct, st.rightPct) },
    ];
    const angles = axes.map((_, i) => -Math.PI / 2 + (i * Math.PI) / 2); // 上右下左
    const rings = [0.33, 0.66, 1.0];
    const ringPoly = r => angles.map(a => `${(cx + Math.cos(a) * R * r).toFixed(1)},${(cy + Math.sin(a) * R * r).toFixed(1)}`).join(' ');
    const pts = stats.map((st, i) => {
      const v = Math.max(0.5, axes[i].value(st) / 100);
      return `${(cx + Math.cos(angles[i]) * R * v).toFixed(1)},${(cy + Math.sin(angles[i]) * R * v).toFixed(1)}`;
    }).join(' ');
    const labels = stats.map((st, i) => {
      const d = dimOf(st.key);
      const lx = cx + Math.cos(angles[i]) * (R + 26);
      const ly = cy + Math.sin(angles[i]) * (R + 22);
      const anchor = i === 0 || i === 2 ? 'middle' : (i === 1 ? 'start' : 'end');
      const dy = i === 0 ? -6 : (i === 2 ? 14 : 4);
      return `<text x="${lx.toFixed(1)}" y="${(ly + dy).toFixed(1)}" text-anchor="${anchor}" class="radar-letter">${st.winner}</text>
        <text x="${lx.toFixed(1)}" y="${(ly + dy + 14).toFixed(1)}" text-anchor="${anchor}" class="radar-name">${esc(st.winner === (d.left || {}).letter ? (d.left || {}).name : (d.right || {}).name || '')}</text>
        <text x="${lx.toFixed(1)}" y="${(ly + dy + 28).toFixed(1)}" text-anchor="${anchor}" class="radar-pct">${Math.max(st.leftPct, st.rightPct)}%</text>`;
    }).join('');
    return `<svg class="radar" viewBox="0 0 ${sz} ${sz}" role="img" aria-label="四维度倾向雷达图">
      ${rings.map(r => `<polygon points="${ringPoly(r)}" class="radar-ring"/>`).join('')}
      ${angles.map(a => `<line x1="${cx}" y1="${cy}" x2="${(cx + Math.cos(a) * R).toFixed(1)}" y2="${(cy + Math.sin(a) * R).toFixed(1)}" class="radar-axis"/>`).join('')}
      <polygon points="${pts}" class="radar-area"/>
      ${stats.map((st, i) => {
        const v = Math.max(0.5, axes[i].value(st) / 100);
        return `<circle cx="${(cx + Math.cos(angles[i]) * R * v).toFixed(1)}" cy="${(cy + Math.sin(angles[i]) * R * v).toFixed(1)}" r="4" class="radar-dot"/>`;
      }).join('')}
      ${labels}
    </svg>`;
  }

  function typeBadge(t, size) {
    const meta = typeMeta(t);
    return `<span class="type-badge t-${S.temperamentOf(t)} ${size || ''}"><b>${t}</b><i>${esc(meta.en || '')}</i></span>`;
  }

  // ============ 测试标识（主测 / 趣味统一） ============
  function testChip(p) {
    // 历史记录行的角标：MBTI 用类型徽章，其余显示测试图标 + 结果摘要
    if (p.type && REPORTS[p.type]) return typeBadge(p.type);
    const info = ENG ? ENG.testInfo(p.testId) : null;
    const icon = info ? info.icon : '🧩';
    return `<span class="test-chip"><b>${icon}</b><i>${esc(p.summary || p.testTitle || '已完成')}</i></span>`;
  }
  function testLabel(p) {
    const info = ENG && p.testId ? ENG.testInfo(p.testId) : null;
    if (info && info.title) return info.title;
    if (p.version === '93') return 'MBTI 93 题完整版';
    if (p.version) return 'MBTI 28 题速测版';
    return p.testTitle || '测评量表';
  }
  function startHrefOf(p) { return p.testId && p.testId !== 'mbti' ? '#/start/' + p.testId : '#/start/' + (p.version || '28'); }

  // 主测卡片（首页 / 测试中心共用）
  function mainCardHtml(m, idx) {
    const startHref = m.id === 'mbti' ? '#/start/28' : '#/start/' + m.id;
    return `<a class="test-card ${idx % 2 ? 'alt' : ''}" href="${startHref}">
      <div class="tc-badge">${idx + 1}</div>
      <h3>${m.icon} ${esc(m.title)}</h3>
      <p>${esc(m.tagline || '')} · ${esc(m.qc || (m.count + ' 题'))}</p>
      ${m.id === 'mbti' ? '<p class="muted2">另有 93 题完整版 · <span class="link">进入后可选</span></p>' : ''}
      <span class="tc-go">开始 ›</span>
    </a>`;
  }

  // 趣味测试条目
  function funItemHtml(f) {
    return `<a class="fun-item" href="#/start/${f.id}">
      <span class="fun-ico">🎲</span>
      <div class="fun-info"><b>${esc(f.title)}</b><span>${f.qc} 题 · ${esc(ENG.engineLabel(f.engine))}</span></div>
      <span class="fun-go">›</span>
    </a>`;
  }
  function funGridHtml(list) { return `<div class="fun-grid">${list.map(funItemHtml).join('')}</div>`; }

  // 结果页底部随机推荐 2-4 个趣味测试
  function funRecHtml(excludeId) {
    const pool = (ENG.funTests() || []).filter(f => f.id !== excludeId);
    if (!pool.length) return '';
    const n = Math.min(pool.length, 2 + Math.floor(Math.random() * 3)); // 2-4 个
    const picks = [];
    const used = new Set();
    while (picks.length < n) {
      const f = pool[Math.floor(Math.random() * pool.length)];
      if (!used.has(f.id)) { used.add(f.id); picks.push(f); }
    }
    return `<div class="card rec-card">
      <div class="row-between"><h2 style="margin:0">📋 再做两套量表</h2><a href="#/testhub" class="muted">全部 ›</a></div>
      ${funGridHtml(picks)}
    </div>`;
  }

  // 继续答题卡片（有未完成会话时）
  function resumeCardHtml() {
    const sess = P.loadSession();
    if (!sess || !Object.keys(sess.answers).length) return '';
    const info = sess.testId ? ENG.testInfo(sess.testId) : null;
    const title = info ? info.title : (sess.version === '93' ? 'MBTI 93 题完整版' : 'MBTI 28 题速测版');
    const href = sess.testId && sess.testId !== 'mbti' ? '#/test/' + sess.testId : '#/test/' + (sess.version || '28');
    return `<div class="card resume-card">
      <div><b>继续上次的测试</b><p class="muted">${esc(title)} · 已答 ${Object.keys(sess.answers).length} 题</p></div>
      <a class="btn primary" href="${href}">继续</a>
    </div>`;
  }

  // ============ 首页（底部导航「首页」） ============
  function renderHome() {
    const mains = ENG.mainTests();
    const funs = ENG.funTests();
    const history = U.myProfiles();
    app.innerHTML = `
    <header class="hero small">
      <div class="hero-inner">
        <div class="hero-logo">🌱</div>
        <h1>抑郁测试中心</h1>
        <p>专业量表 · 科学自评 · 温柔对待每一份情绪</p>
      </div>
    </header>
    <main class="page">
      ${resumeCardHtml()}
      ${mains.length ? `
      <div class="card section-head"><div class="row-between"><h2 style="margin:0">🎯 专业测评</h2><a href="#/intro" class="muted">测试介绍 ›</a></div></div>
      <div class="test-cards">
        ${mains.map((m, i) => mainCardHtml(m, i)).join('')}
      </div>` : ''}
      <div class="card section-head"><div class="row-between"><h2 style="margin:0">📋 测评量表（${funs.length}）</h2><a href="#/testhub" class="muted">全部 ›</a></div></div>
      ${funGridHtml(funs.slice(0, 6))}
      <div class="card">
        <div class="row-between"><h2 style="margin:0">我的历次测试</h2><a href="#/me" class="muted">全部 ›</a></div>
        ${history.length === 0 ? '<p class="muted">还没有测试记录，完成测试后自动存入「我的」。</p>' : `
        <div class="profile-list">${history.slice(0, 3).map(p => `
          <a class="profile-item" href="#/result/${p.id}">
            ${testChip(p)}
            <div class="profile-info"><b>${esc(p.name || '未命名')}</b>
            <span>${esc(testLabel(p))} · ${esc(fmtTime(p.finishedAt || p.createdAt))}</span></div>
          </a>`).join('')}</div>`}
      </div>
    </main>`;
  }

  // ============ 测试中心（底部导航「测试」：全部测试按序排列） ============
  function renderTestHub() {
    const mains = ENG.mainTests();
    const funs = ENG.funTests();
    app.innerHTML = `
    <header class="hero small">
      <div class="hero-inner">
        <div class="hero-logo">📝</div>
        <h1>全部测试</h1>
        <p>${mains.length ? mains.length + ' 个专业测评 · ' : ''}${funs.length} 套专业量表</p>
      </div>
    </header>
    <main class="page">
      ${resumeCardHtml()}
      ${mains.length ? `
      <div class="card section-head"><h2 style="margin:0">🎯 专业测评</h2></div>
      <div class="test-cards">
        ${mains.map((m, i) => mainCardHtml(m, i)).join('')}
      </div>` : ''}
      <div class="card section-head"><h2 style="margin:0">📋 测评量表（${funs.length}）</h2></div>
      <div class="card">
        <div class="field"><input id="fun-search" type="text" placeholder="搜索量表名称…" autocomplete="off"></div>
        <div id="fun-list">${funGridHtml(funs)}</div>
      </div>
    </main>`;
    const search = document.getElementById('fun-search');
    search.addEventListener('input', () => {
      const kw = search.value.trim().toLowerCase();
      const list = kw ? funs.filter(f => f.title.toLowerCase().includes(kw)) : funs;
      document.getElementById('fun-list').innerHTML = funGridHtml(list) || '<p class="muted">没有匹配的测试。</p>';
    });
  }

  // ============ 测试介绍（四大主测：列表 + 详情，MBTI 排第一） ============
  function renderIntro(sub, tab) {
    if (sub === 'mbti') return renderIntroMbti(tab || 'overview');
    if (sub === 'holland' || sub === 'disc' || sub === 'enneagram') return renderIntroMain(sub);

    // 四测列表
    const mains = ENG.mainTests();
    app.innerHTML = `
    <header class="hero small"><div class="hero-inner"><div class="hero-logo">📖</div><h1>测试介绍</h1><p>四大专业测评 · 点击查看详细介绍</p></div></header>
    <main class="page">
      ${mains.map(m => `
      <div class="card intro-box">
        <div class="intro-box-head">
          <span class="intro-ico">${m.icon}</span>
          <div><h2 style="margin:0">${esc(m.title)}</h2><p class="muted">${esc(m.tagline || '')} · ${esc(m.qc || '')}</p></div>
        </div>
        <p>${esc(m.brief || '')}</p>
        <div class="q-nav">
          <a class="btn" href="#/intro/${m.id}">详细介绍</a>
          <a class="btn primary" href="#/start/${m.id === 'mbti' ? '28' : m.id}">开始测试</a>
        </div>
      </div>`).join('')}
    </main>`;
  }

  // 主测详情（霍兰德 / DISC / 九型）
  function renderIntroMain(id) {
    const T = window.PSY_TESTS[id];
    const m = ENG.testInfo(id);
    const intro = (T.intro || {});
    let dimsHtml = '';
    if (id === 'holland') {
      dimsHtml = `<div class="card"><h2>六种类型</h2><div class="type-grid">${Object.values(T.dims).map(d => `
        <div class="type-cell"><b>${d.key}</b><span>${esc(d.name)}</span><i>${esc((d.traits || '').slice(0, 18))}…</i></div>`).join('')}</div></div>`;
    } else if (id === 'disc') {
      dimsHtml = `<div class="card"><h2>四种类型</h2>${Object.values(T.dims).map(d => `
        <div class="card dim-card"><h2>${d.key} · ${esc(d.name)} <small>${esc(d.en || '')}</small></h2>
        <p class="dim-q">${esc(d.headline || '')}</p><p>${esc(d.emotion || '')}</p></div>`).join('')}</div>`;
    } else if (id === 'enneagram') {
      dimsHtml = `<div class="card"><h2>九种类型</h2><div class="type-grid">${Object.values(T.types).map(t => `
        <div class="type-cell"><b>${t.key}</b><span>${esc(t.name)}</span><i>${esc(t.headline || '')}</i></div>`).join('')}</div></div>`;
    }
    app.innerHTML = `
    ${backBar(m.title, '#/intro')}
    <main class="page narrow">
      <div class="card"><h2>${m.icon} ${esc(m.title)}</h2><p class="muted">${esc(m.tagline || '')} · ${esc(m.qc || '')}</p></div>
      <div class="card"><h2>简介</h2><p>${esc(intro.brief || m.brief || '')}</p></div>
      ${(intro.paragraphs || []).map(p => `<div class="card"><p>${esc(p)}</p></div>`).join('')}
      ${dimsHtml}
      ${T.rule ? `<div class="card"><h2>计分规则</h2><p>${esc(T.rule)}</p></div>` : ''}
      <a class="btn primary big full" href="#/start/${id}">开始测试 · ${esc(m.qc || '')}</a>
    </main>`;
  }

  // MBTI 详情（保留原有介绍内容：概述 / 四个维度 / 四大气质 / 16 类型）
  function renderIntroMbti(tab) {
    const t = tab || 'overview';
    const tabs = [['overview', '概述'], ['dims', '四个维度'], ['temp', '四大气质'], ['types16', '16 类型']];
    let body = '';

    if (t === 'overview') {
      const w = C.intro.whatIs;
      body = `<div class="card"><h2>${esc(w.title)}</h2>${w.paragraphs.map(p => `<p>${esc(p)}</p>`).join('')}</div>
      <div class="card"><h2>MBTI 的应用领域</h2><div class="chips">${C.intro.applications.map(a => `<span class="chip">${esc(a)}</span>`).join('')}</div></div>` +
      C.intro.cautions.map(c => `<div class="card"><h2>${esc(c.title)}</h2><ul class="list">${c.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`).join('');
    } else if (t === 'dims') {
      body = C.dimensions.map((d, i) => `
        <div class="card dim-card">
          <h2>维度 ${i + 1}：${esc(d.name)} <small>${esc(d.en)}</small></h2>
          <p class="dim-q">${esc(d.question)}</p>
          <div class="vs-grid">
            <div class="vs-side left">
              <div class="vs-letter">${d.left.letter}</div>
              <div class="vs-name">${esc(d.left.name)} <small>${esc(d.left.en)}</small></div>
              <p>${esc(d.left.summary)}</p>
              <ul class="list">${d.left.traits.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
            </div>
            <div class="vs-divider">VS</div>
            <div class="vs-side right">
              <div class="vs-letter">${d.right.letter}</div>
              <div class="vs-name">${esc(d.right.name)} <small>${esc(d.right.en)}</small></div>
              <p>${esc(d.right.summary)}</p>
              <ul class="list">${d.right.traits.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
            </div>
          </div>
        </div>`).join('');
    } else if (t === 'temp') {
      body = Object.values(C.temperaments).map(tp => `
        <div class="card temp-card t-${tp.key}">
          <h2>${esc(tp.name)} <small>${esc(tp.en)}</small></h2>
          <p class="temp-line">${esc(tp.question)}　风格：${esc(tp.style)}　寻求：${esc(tp.seek)}　弱点：${esc(tp.weakness)}</p>
          <p>${esc(tp.description)}</p>
          <div class="chips">${tp.traits.map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div>
          <p class="temp-types">包含类型：${tp.types.map(x => typeBadge(x)).join('')}</p>
          ${tp.famous && tp.famous.length ? `<p class="muted">代表人物：${esc(tp.famous.join('、'))}</p>` : ''}
          <details><summary>压力与舒解</summary>
            <p><b>压力来源：</b>${esc(tp.stress.sources.join('；'))}</p>
            <p><b>压力反应：</b>${esc(tp.stress.reactions.join('；'))}</p>
            <p><b>舒解策略：</b>${esc(tp.stress.coping.join('；'))}</p>
          </details>
        </div>`).join('');
    } else {
      body = '<div class="card"><h2>16 种人格类型</h2><p>四个维度各取一个偏好字母，组合成 16 种类型。点击查看详细解读。</p></div>' +
        ['SJ', 'SP', 'NT', 'NF'].map(g => `
        <div class="card"><h2 class="t-${g}-text">${esc(C.temperaments[g].name)}</h2>
          <div class="type-grid">${C.temperaments[g].types.map(t => `
            <a class="type-cell t-${g}" href="#/type/${t}"><b>${t}</b><span>${esc(typeMeta(t).en || '')}</span></a>`).join('')}
          </div>
        </div>`).join('');
    }

    app.innerHTML = `
    ${backBar('MBTI 测试介绍', '#/intro')}
    <main class="page">
      <div class="tabbar-tabs">${tabs.map(([k, l]) => `<a class="tab${t === k ? ' on' : ''}" href="#/intro/dep/${k}">${l}</a>`).join('')}</div>
      ${body}
    </main>`;
  }

  // ============ 测试须知（通用：MBTI / 霍兰德 / DISC / 九型 / 趣味测试） ============
  const MBTI_NOTES = v => `
    <li>本问卷的所有问题都取自日常生活，您的回答只表明您通常如何看待和处理事物，<b>无对错好坏之分</b>。</li>
    <li>${v === '93' ? '全卷分四个部分（23+24+23+23 题），约需 15-20 分钟，建议在 20 分钟内完成，不要在任何一题上花太多时间。' : '共 28 题，约需 5 分钟，每道题都要作答。'}</li>
    <li>凭第一反应作答，选择"通常"的自己，而不是"希望成为"的自己。</li>
    <li>${v === '93' ? '' : '测验中设有测谎题目，如发现未诚实回答，整个问卷作废。'}</li>`;

  function renderStart(id) {
    if (id === '28' || id === '93') return renderStartMbti(id);
    if (id === 'holland' || id === 'disc' || id === 'enneagram') return renderStartMain(id);
    if (FUN_ID.test(id || '')) return renderStartFun(id);
    go('#/testhub', true);
  }

  function bindStart(title, testId, sessKey, notesHtml, extraHtml) {
    const user = U.load();
    app.innerHTML = `
    ${backBar(title, '#/testhub')}
    <main class="page narrow">
      <div class="card">
        <h2>${esc(title)} · 测试须知</h2>
        <ul class="list">${notesHtml}</ul>
        ${extraHtml || ''}
        <button class="btn primary big full" id="btn-begin">开始测试</button>
        <p class="muted center">档案编号 <b>${esc(user.uid)}</b> · 进度自动保存，中途退出可续答</p>
      </div>
    </main>`;
    document.getElementById('btn-begin').addEventListener('click', () => {
      const sess = P.loadSession();
      if (sess && sessKeyMatches(sess, sessKey) && Object.keys(sess.answers).length) {
        if (confirm('检测到上次未完成的「' + title + '」进度（已答 ' + Object.keys(sess.answers).length + ' 题），是否继续？')) {
          go('#/test/' + (sess.testId && sess.testId !== 'mbti' ? sess.testId : (sess.version || '28'))); return;
        }
      }
      P.clearSession();
      // 不再要求逐次录入昵称：未在「我的」填资料时仅以档案号标识
      const s = { testId: sessKey.testId, name: user.nickname || user.name || '', answers: {}, startedAt: Date.now() };
      if (sessKey.testId === 'mbti') s.version = sessKey.version;
      P.saveSession(s);
      go('#/test/' + (sessKey.testId === 'mbti' ? sessKey.version : sessKey.testId));
    });
  }
  function sessKeyMatches(sess, key) {
    if (!sess) return false;
    if (key.testId === 'mbti') return (!sess.testId || sess.testId === 'mbti') && (sess.version || '28') === key.version;
    return sess.testId === key.testId;
  }

  function renderStartMbti(version) {
    const v = version === '93' ? '93' : '28';
    const title = v === '93' ? 'MBTI 93 题完整版' : 'MBTI 28 题速测版';
    const extra = v === '28' ? '<p class="muted">需要更稳定的完整施测？<a href="#/start/93">进入 93 题完整版 ›</a></p>' : '<p class="muted">时间有限？<a href="#/start/28">进入 28 题速测版 ›</a></p>';
    bindStart(title, { testId: 'mbti', version: v }, { testId: 'mbti', version: v },
      MBTI_NOTES(v) + `<li>完成后自动存入「我的」档案（关联编号 <b>${esc(U.load().uid)}</b>），可随时查看与 AI 深度分析。</li>`, extra);
  }

  const MAIN_NOTES = {
    holland: t => `<li>共 ${t.questions.length} 条描述，逐条判断「是」或「否」，约需 8-10 分钟。</li>`,
    disc: t => `<li>共 ${t.groups.length} 组，每组 4 条描述，选出<b>最符合你</b>的一条，约需 10-15 分钟。</li>`,
    enneagram: t => `<li>共 ${t.questions.length} 条描述，逐条判断「是」或「否」，约需 20-30 分钟，请保持耐心。</li>`,
  };

  function renderStartMain(id) {
    const T = window.PSY_TESTS[id];
    const m = ENG.testInfo(id);
    const common = `
      <li>所有描述无对错好坏之分，凭第一反应作答，选"通常"的自己。</li>
      <li>结果自动存入「我的」档案（关联编号 <b>${esc(U.load().uid)}</b>），可随时查看与 AI 深度分析。</li>`;
    bindStart(m.title, { testId: id }, { testId: id }, MAIN_NOTES[id](T) + (T.rule ? `<li><b>计分规则：</b>${esc(T.rule)}</li>` : '') + common, '');
  }

  function renderStartFun(id) {
    app.innerHTML = backBar('加载中…', '#/testhub') + '<main class="page narrow"><div class="card"><p class="muted center">正在加载题库…</p></div></main>';
    ENG.loadFun(id).then(t => {
      // 须知页只放引导语（长 intro 截断）；题目与选项完整呈现在答题页，一页一题
      const intro = (t.intro || '').trim() || '凭第一印象快速作答即可。';
      const introShort = intro.length > 90 ? intro.slice(0, 90) + '…' : intro;
      const notes = `
        <li>${esc(introShort)}</li>
        <li>共 ${t.engine === 'single' || t.engine === 'order' ? 1 : t.questions.length} 题 · ${esc(ENG.engineLabel(t.engine))}，约需 1-3 分钟。${t.img || (t.questions && t.questions.some(q => q.img)) ? '本测试含测试图，答题页展示。' : ''}</li>
        <li>结果自动存入「我的」档案，完成后还有更多量表推荐。</li>`;
      bindStart(t.title, { testId: id }, { testId: id }, notes, '');
    }).catch(e => {
      app.innerHTML = backBar('加载失败', '#/testhub') + '<main class="page narrow"><div class="card"><h2>题库加载失败</h2><p>' + esc(e.message) + '</p><a class="btn" href="#/testhub">返回测试列表</a></div></main>';
    });
  }

  // ============ 答题（按测试类型分发） ============
  function renderTest(id) {
    if (id === '28' || id === '93') return renderMbtiTest(id);
    if (id === 'holland' || id === 'enneagram') return renderYesNoTest(id);
    if (id === 'disc') return renderDiscTest();
    if (FUN_ID.test(id || '')) return renderFunTest(id);
    go('#/testhub', true);
  }

  // ---- 通用：档案保存（趣味 / 主测非 MBTI） ----
  function saveGenericProfile(testId, testTitle, res, answers, startedAt) {
    const user = U.load();
    const profile = P.save({
      uid: user.uid,
      testId, testTitle, name: (P.loadSession() || {}).name || user.nickname || user.name || user.uid,
      summary: res.title || '', result: res, answers,
      startedAt: new Date(startedAt || Date.now()).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMin: Math.max(1, Math.round((Date.now() - (startedAt || Date.now())) / 60000)),
    });
    P.clearSession();
    BRIDGE.postResult(profile);
    SVR.syncProfile(profile, user);
    go('#/result/' + profile.id);
  }

  // ---- MBTI（28 / 93） ----
  function renderMbtiTest(version) {
    const v = version === '93' ? '93' : '28';
    const sess = P.loadSession() || { testId: 'mbti', version: v, name: '', answers: {}, startedAt: Date.now() };
    if (!sess.testId) sess.testId = 'mbti';
    const { flat } = bankOf(v);
    let cur = 0;
    let firstUn = flat.findIndex((q, i) => sess.answers[i + 1] == null);
    if (firstUn < 0) firstUn = flat.length - 1;
    cur = firstUn;

    const root = document.createElement('div');
    root.innerHTML = '<main class="page narrow" id="test-root"></main>';
    app.innerHTML = ''; app.appendChild(root);
    const box = document.getElementById('test-root');

    function draw() {
      const q = flat[cur];
      const answered = Object.keys(sess.answers).length;
      const pct = Math.round((answered / flat.length) * 100);
      const sec = v === '93' ? window.MBTI_BANK_93.sections[flat[cur].section] : null;
      const chosen = sess.answers[cur + 1];
      const stem = q.stem ? `<p class="q-stem">${esc(q.stem)}</p>` : '';
      box.innerHTML = `
        <div class="progress-row">
          <a class="link-quit" href="#/testhub">退出</a>
          <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
          <span class="progress-num">${answered}/${flat.length}</span>
        </div>
        ${sec ? `<div class="section-tag">第${['一', '二', '三', '四'][flat[cur].section]}部分 · ${esc(sec.name)}</div>` : ''}
        <div class="card q-card">
          <div class="q-idx">第 ${cur + 1} 题</div>
          ${stem}
          ${v === '93' && !q.stem ? `<p class="q-stem muted2" style="font-weight:400">下面两个词语，哪个更合你心意？</p>` : ''}
          <div class="q-choices">
            ${q.choices.map((c, i) => `
              <button class="choice${chosen === i ? ' chosen' : ''}" data-i="${i}">
                <span class="choice-tag">${'AB'[i]}</span><span class="choice-text">${esc(c.text)}</span>
              </button>`).join('')}
          </div>
        </div>
        <div class="q-nav">
          <button class="btn" id="btn-prev" ${cur === 0 ? 'disabled' : ''}>上一题</button>
          ${answered >= flat.length
            ? '<button class="btn primary" id="btn-finish">查看结果</button>'
            : `<button class="btn primary" id="btn-next" ${chosen == null ? 'disabled' : ''}>下一题</button>`}
        </div>`;
      document.getElementById('btn-prev').addEventListener('click', () => { if (cur > 0) { cur--; draw(); window.scrollTo(0, 0); } });
      const bn = document.getElementById('btn-next');
      if (bn) bn.addEventListener('click', () => { if (cur < flat.length - 1) { cur++; draw(); window.scrollTo(0, 0); } });
      const bf = document.getElementById('btn-finish');
      if (bf) bf.addEventListener('click', finish);
      box.querySelectorAll('.choice').forEach(el => {
        el.addEventListener('click', () => {
          sess.answers[cur + 1] = parseInt(el.dataset.i, 10);
          P.saveSession(sess);
          if (cur < flat.length - 1) { cur++; draw(); window.scrollTo({ top: 0 }); }
          else draw();
        });
      });
    }

    function finish() {
      const answered = Object.keys(sess.answers).length;
      if (answered < flat.length) {
        alert('还有 ' + (flat.length - answered) + ' 题未作答，请完成全部题目。');
        return;
      }
      const user = U.load();
      const result = S.computeResult(flat, sess.answers, {});
      const profile = P.save({
        uid: user.uid,
        testId: 'mbti', testTitle: 'MBTI 职业性格测试',
        version: v, name: sess.name || user.nickname || '未命名', type: result.type,
        summary: result.type, scores: result.scores, stats: result.stats, answers: sess.answers,
        startedAt: new Date(sess.startedAt || Date.now()).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMin: Math.max(1, Math.round((Date.now() - (sess.startedAt || Date.now())) / 60000)),
      });
      P.clearSession();
      BRIDGE.postResult(profile);
      SVR.syncProfile(profile, user); // 飞牛 CGI 模式下同步到 NAS 中央存储（本地模式自动跳过）
      go('#/result/' + profile.id);
    }

    draw();
  }

  // ---- 霍兰德 / 九型人格：逐条「是 / 否」 ----
  function renderYesNoTest(id) {
    const T = window.PSY_TESTS[id];
    const m = ENG.testInfo(id);
    const sess = P.loadSession() || {};
    if (sess.testId !== id || !sess.answers) { P.clearSession(); P.saveSession({ testId: id, name: sess.name || '', answers: {}, startedAt: Date.now(), startedAtOrig: Date.now() }); }
    const s = P.loadSession();
    if (!s.startedAt) s.startedAt = Date.now();
    const qs = T.questions;
    let cur = 0;
    const firstUn = qs.findIndex(q => s.answers[q.n] == null);
    cur = firstUn < 0 ? qs.length - 1 : firstUn;

    const root = document.createElement('div');
    root.innerHTML = '<main class="page narrow" id="test-root"></main>';
    app.innerHTML = ''; app.appendChild(root);
    const box = document.getElementById('test-root');

    function draw() {
      const q = qs[cur];
      const answered = Object.keys(s.answers).length;
      const pct = Math.round((answered / qs.length) * 100);
      const chosen = s.answers[q.n];
      box.innerHTML = `
        <div class="progress-row">
          <a class="link-quit" href="#/testhub">退出</a>
          <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
          <span class="progress-num">${answered}/${qs.length}</span>
        </div>
        <div class="card q-card">
          <div class="q-idx">第 ${cur + 1} 题 / 共 ${qs.length} 题</div>
          <p class="q-stem">${esc(q.text)}</p>
          <div class="q-choices yn">
            <button class="choice yn-yes${chosen === 1 ? ' chosen' : ''}" data-v="1"><span class="choice-tag">是</span></button>
            <button class="choice yn-no${chosen === 0 ? ' chosen' : ''}" data-v="0"><span class="choice-tag">否</span></button>
          </div>
        </div>
        <div class="q-nav">
          <button class="btn" id="btn-prev" ${cur === 0 ? 'disabled' : ''}>上一题</button>
          ${answered >= qs.length
            ? '<button class="btn primary" id="btn-finish">查看结果</button>'
            : `<button class="btn primary" id="btn-next" ${chosen == null ? 'disabled' : ''}>下一题</button>`}
        </div>`;
      document.getElementById('btn-prev').addEventListener('click', () => { if (cur > 0) { cur--; draw(); window.scrollTo(0, 0); } });
      const bn = document.getElementById('btn-next');
      if (bn) bn.addEventListener('click', () => { if (cur < qs.length - 1) { cur++; draw(); window.scrollTo(0, 0); } });
      const bf = document.getElementById('btn-finish');
      if (bf) bf.addEventListener('click', () => {
        const res = id === 'holland' ? ENG.runHolland(s.answers) : ENG.runEnneagram(s.answers);
        saveGenericProfile(id, m.title, res, s.answers, s.startedAt);
      });
      box.querySelectorAll('.choice').forEach(el => {
        el.addEventListener('click', () => {
          s.answers[q.n] = parseInt(el.dataset.v, 10);
          P.saveSession(s);
          if (cur < qs.length - 1) { cur++; draw(); window.scrollTo({ top: 0 }); }
          else draw();
        });
      });
    }
    draw();
  }

  // ---- DISC：40 组 × 4 条描述选最符合 ----
  function renderDiscTest() {
    const T = window.PSY_TESTS.disc;
    const m = ENG.testInfo('disc');
    let s = P.loadSession();
    if (!s || s.testId !== 'disc' || !s.answers) { s = { testId: 'disc', name: (s && s.name) || '', answers: {}, startedAt: Date.now() }; P.saveSession(s); }
    if (!s.startedAt) s.startedAt = Date.now();
    const groups = T.groups;
    let cur = 0;
    const firstUn = groups.findIndex((g, i) => s.answers[i + 1] == null);
    cur = firstUn < 0 ? groups.length - 1 : firstUn;

    const root = document.createElement('div');
    root.innerHTML = '<main class="page narrow" id="test-root"></main>';
    app.innerHTML = ''; app.appendChild(root);
    const box = document.getElementById('test-root');

    function draw() {
      const g = groups[cur];
      const answered = Object.keys(s.answers).length;
      const pct = Math.round((answered / groups.length) * 100);
      const chosen = s.answers[cur + 1];
      box.innerHTML = `
        <div class="progress-row">
          <a class="link-quit" href="#/testhub">退出</a>
          <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
          <span class="progress-num">${answered}/${groups.length}</span>
        </div>
        <div class="card q-card">
          <div class="q-idx">第 ${cur + 1} 组 / 共 ${groups.length} 组</div>
          <p class="q-stem muted2" style="font-weight:400">下列 4 条描述中，哪一条最符合你？</p>
          <div class="q-choices">
            ${g.map((st, i) => `
              <button class="choice${chosen === st.dim ? ' chosen' : ''}" data-dim="${st.dim}">
                <span class="choice-tag">${'ABCD'[i]}</span><span class="choice-text">${esc(st.t ? st.t + '：' : '')}${esc(st.d)}</span>
              </button>`).join('')}
          </div>
        </div>
        <div class="q-nav">
          <button class="btn" id="btn-prev" ${cur === 0 ? 'disabled' : ''}>上一题</button>
          ${answered >= groups.length
            ? '<button class="btn primary" id="btn-finish">查看结果</button>'
            : `<button class="btn primary" id="btn-next" ${chosen == null ? 'disabled' : ''}>下一题</button>`}
        </div>`;
      document.getElementById('btn-prev').addEventListener('click', () => { if (cur > 0) { cur--; draw(); window.scrollTo(0, 0); } });
      const bn = document.getElementById('btn-next');
      if (bn) bn.addEventListener('click', () => { if (cur < groups.length - 1) { cur++; draw(); window.scrollTo(0, 0); } });
      const bf = document.getElementById('btn-finish');
      if (bf) bf.addEventListener('click', () => {
        const res = ENG.runDisc(s.answers);
        saveGenericProfile('disc', m.title, res, s.answers, s.startedAt);
      });
      box.querySelectorAll('.choice').forEach(el => {
        el.addEventListener('click', () => {
          s.answers[cur + 1] = el.dataset.dim;
          P.saveSession(s);
          if (cur < groups.length - 1) { cur++; draw(); window.scrollTo({ top: 0 }); }
          else draw();
        });
      });
    }
    draw();
  }

  // ---- 趣味测试：按引擎分发 ----
  function renderFunTest(id) {
    app.innerHTML = backBar('加载中…', '#/testhub') + '<main class="page narrow"><div class="card"><p class="muted center">正在加载题库…</p></div></main>';
    ENG.loadFun(id).then(t => {
      let s = P.loadSession();
      if (!s || s.testId !== id || !s.answers) { s = { testId: id, name: (s && s.name) || '', answers: {}, startedAt: Date.now() }; P.saveSession(s); }
      if (!s.startedAt) s.startedAt = Date.now();

      if (t.engine === 'single') return drawFunSingle(t, s);
      if (t.engine === 'order') return drawFunOrder(t, s);
      if (t.engine === 'branch') return drawFunBranch(t, s);
      if (t.single) return drawFunSingle(t, s); // points-single
      drawFunLinear(t, s);
    }).catch(e => {
      app.innerHTML = backBar('加载失败', '#/testhub') + '<main class="page narrow"><div class="card"><h2>题库加载失败</h2><p>' + esc(e.message) + '</p><a class="btn" href="#/testhub">返回测试列表</a></div></main>';
    });
  }

  // 趣味测试公共骨架
  function funShell(t, inner) {
    return `
    <div class="progress-row">
      <a class="link-quit" href="#/testhub">退出</a>
      <span class="fun-title-tag">${esc(t.title)}</span>
    </div>
    <div class="card q-card">${inner}</div>`;
  }
  // 题图地址（workbench 模式在 /dep/ 下，本地模式相对当前目录）
  function funImg(name) {
    const base = (SVR.mode && SVR.mode() === 'workbench') ? '/dep/' : './';
    return base + 'fun/img/' + name;
  }
  function qImgHtml(name) {
    return name ? `<img class="q-img" src="${esc(funImg(name))}" alt="题图" loading="lazy">` : '';
  }
  function funFinish(t, s) {
    const res = ENG.runFun(t, s.answers);
    saveGenericProfile(t.id, t.title, res, s.answers, s.startedAt);
  }

  // 单题（single / points-single）：先选中（可改选），点「查看结果」再出解答
  function drawFunSingle(t, s) {
    const root = document.createElement('div');
    root.innerHTML = '<main class="page narrow" id="test-root"></main>';
    app.innerHTML = ''; app.appendChild(root);
    const box = document.getElementById('test-root');
    const opts = t.opts || (t.questions && t.questions[0] && t.questions[0].opts) || [];
    const qText = t.question || (t.questions && t.questions[0] && t.questions[0].text) || '凭第一印象选择';
    const img = t.img || (t.questions && t.questions[0] && t.questions[0].img);
    function draw() {
      const chosen = s.answers[1];
      box.innerHTML = funShell(t, `
        <div class="q-idx">${esc(ENG.engineLabel(t.engine))}</div>
        <p class="q-stem">${esc(qText)}</p>
        ${qImgHtml(img)}
        <div class="q-choices">
          ${opts.map(o => `
            <button class="choice${chosen === o.key ? ' chosen' : ''}" data-k="${esc(o.key)}">
              <span class="choice-tag">${esc(o.key)}</span><span class="choice-text">${esc(o.text)}</span>
            </button>`).join('')}
        </div>
        ${chosen
          ? '<button class="btn primary big full" id="btn-sfinish" style="margin-top:14px">查看结果</button><p class="muted center">选错可直接点其他选项改选</p>'
          : '<p class="muted center" style="margin-top:12px">选中一个选项后，点击「查看结果」查看解答</p>'}`);
      const bf = document.getElementById('btn-sfinish');
      if (bf) bf.addEventListener('click', () => funFinish(t, s));
      box.querySelectorAll('.choice').forEach(el => {
        el.addEventListener('click', () => {
          s.answers[1] = el.dataset.k;
          P.saveSession(s);
          draw();
        });
      });
    }
    draw();
  }

  // 排序（order）：按可能性依次点选 1/2/3
  function drawFunOrder(t, s) {
    const root = document.createElement('div');
    root.innerHTML = '<main class="page narrow" id="test-root"></main>';
    app.innerHTML = ''; app.appendChild(root);
    const box = document.getElementById('test-root');
    const slots = s.answers && Object.keys(s.answers).length ? s.answers : {};
    function draw() {
      const assigned = Object.keys(slots).length;
      box.innerHTML = funShell(t, `
        <div class="q-idx">排序测写</div>
        <p class="q-stem">${esc(t.question || '按可能性从高到低，依次点击三个选项')}</p>
        ${qImgHtml(t.img)}
        <p class="muted2">按可能性<b>从高到低</b>依次点击（第 1 最可能），点错可重来</p>
        <div class="q-choices">
          ${t.opts.map(o => {
            const slot = Object.keys(slots).find(k => slots[k] === o.key);
            return `<button class="choice${slot ? ' chosen' : ''}" data-k="${esc(o.key)}">
              <span class="choice-tag">${slot ? '第' + slot : '　'}</span><span class="choice-text">${esc(o.key)}、${esc(o.text)}</span>
            </button>`;
          }).join('')}
        </div>
        ${assigned === 3 ? '<button class="btn primary big full" id="btn-ofinish">查看结果</button>' : `<p class="muted center">已排 ${assigned}/3</p>`}
        ${assigned ? '<button class="btn small" id="btn-oreset" style="margin-top:8px">重新排序</button>' : ''}`);
      const of = document.getElementById('btn-ofinish');
      if (of) of.addEventListener('click', () => { s.answers = slots; P.saveSession(s); funFinish(t, s); });
      const rs = document.getElementById('btn-oreset');
      if (rs) rs.addEventListener('click', () => { Object.keys(slots).forEach(k => delete slots[k]); draw(); });
      box.querySelectorAll('.choice').forEach(el => {
        el.addEventListener('click', () => {
          const k = el.dataset.k;
          const at = Object.keys(slots).find(x => slots[x] === k);
          if (at) { delete slots[at]; } // 再点取消
          else { for (let i = 1; i <= 3; i++) { if (!slots[i]) { slots[i] = k; break; } } }
          s.answers = slots; P.saveSession(s); draw();
        });
      });
    }
    draw();
  }

  // 跳转（branch）：按 path 逐题跟随
  function drawFunBranch(t, s) {
    const qmap = {}; t.questions.forEach(q => (qmap[q.n] = q));
    if (!Array.isArray(s.path) || !s.path.length) s.path = [t.entry || 1];
    const root = document.createElement('div');
    root.innerHTML = '<main class="page narrow" id="test-root"></main>';
    app.innerHTML = ''; app.appendChild(root);
    const box = document.getElementById('test-root');
    let curN = s.path[s.path.length - 1];

    function draw() {
      const q = qmap[curN];
      if (!q) { funFinish(t, s); return; }
      const chosen = s.answers[q.n];
      const step = s.path.length;
      box.innerHTML = funShell(t, `
        <div class="q-idx">第 ${step} 步 · 情景跳转</div>
        <p class="q-stem">${esc(q.text)}</p>
        ${qImgHtml(q.img || (step === 1 ? t.img : null))}
        <div class="q-choices">
          ${(q.opts || []).map(o => `
            <button class="choice${chosen === o.key ? ' chosen' : ''}" data-k="${esc(o.key)}">
              <span class="choice-tag">${esc(o.key)}</span><span class="choice-text">${esc(o.text)}${o.next ? ' → 第' + o.next + '题' : ''}</span>
            </button>`).join('')}
        </div>
        ${step > 1 ? '<button class="btn small" id="btn-bprev" style="margin-top:8px">‹ 上一步</button>' : ''}`);
      const bp = document.getElementById('btn-bprev');
      if (bp) bp.addEventListener('click', () => { s.path.pop(); curN = s.path[s.path.length - 1]; draw(); });
      box.querySelectorAll('.choice').forEach(el => {
        el.addEventListener('click', () => {
          const key = el.dataset.k;
          const opt = (q.opts || []).find(o => o.key === key);
          if (!opt) return;
          s.answers[q.n] = key;
          if (opt.res) { P.saveSession(s); funFinish(t, s); return; }
          if (opt.next) { s.path.push(opt.next); P.saveSession(s); curN = opt.next; draw(); window.scrollTo({ top: 0 }); }
        });
      });
    }
    draw();
  }

  // 线性（tally / points / scale / perq）
  function drawFunLinear(t, s) {
    const qs = t.questions;
    const optsOf = q => (q.opts && q.opts.length ? q.opts : (t.globalOpts || t.options || []));
    let cur = 0;
    const firstUn = qs.findIndex(q => s.answers[q.n] == null);
    cur = firstUn < 0 ? qs.length - 1 : firstUn;

    const root = document.createElement('div');
    root.innerHTML = '<main class="page narrow" id="test-root"></main>';
    app.innerHTML = ''; app.appendChild(root);
    const box = document.getElementById('test-root');

    function draw() {
      const q = qs[cur];
      const answered = Object.keys(s.answers).length;
      const pct = Math.round((answered / qs.length) * 100);
      const chosen = s.answers[q.n];
      const opts = optsOf(q);
      box.innerHTML = `
        <div class="progress-row">
          <a class="link-quit" href="#/testhub">退出</a>
          <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
          <span class="progress-num">${answered}/${qs.length}</span>
        </div>
        ${funShell(t, `
          <div class="q-idx">第 ${cur + 1} 题 / 共 ${qs.length} 题</div>
          <p class="q-stem">${esc(q.text)}</p>
          ${qImgHtml(q.img || (cur === 0 ? t.img : null))}
          <div class="q-choices">
            ${opts.map(o => `
              <button class="choice${chosen === o.key ? ' chosen' : ''}" data-k="${esc(o.key)}">
                <span class="choice-tag">${esc(o.key)}</span><span class="choice-text">${esc(o.text)}</span>
              </button>`).join('')}
          </div>`)}
        <div class="q-nav">
          <button class="btn" id="btn-prev" ${cur === 0 ? 'disabled' : ''}>上一题</button>
          ${answered >= qs.length
            ? '<button class="btn primary" id="btn-finish">查看结果</button>'
            : `<button class="btn primary" id="btn-next" ${chosen == null ? 'disabled' : ''}>下一题</button>`}
        </div>`;
      document.getElementById('btn-prev').addEventListener('click', () => { if (cur > 0) { cur--; draw(); window.scrollTo(0, 0); } });
      const bn = document.getElementById('btn-next');
      if (bn) bn.addEventListener('click', () => { if (cur < qs.length - 1) { cur++; draw(); window.scrollTo(0, 0); } });
      const bf = document.getElementById('btn-finish');
      if (bf) bf.addEventListener('click', () => funFinish(t, s));
      box.querySelectorAll('.choice').forEach(el => {
        el.addEventListener('click', () => {
          s.answers[q.n] = el.dataset.k;
          P.saveSession(s);
          if (cur < qs.length - 1) { cur++; draw(); window.scrollTo({ top: 0 }); }
          else draw();
        });
      });
    }
    draw();
  }
  function reportSections(r) {
    const sec = [];
    sec.push(['个性特征描述', `<p>${esc(r.profile)}</p>`]);
    sec.push(['可能存在的盲点', `<p>${esc(r.blindSpots)}</p>`]);
    if (r.functions) sec.push(['功能运用', `<p>${esc(r.functions).replace(/\n/g, '</p><p>')}</p>`]);
    if (r.problemSolving) sec.push(['问题解决方式', `<p>${esc(r.problemSolving).replace(/\n/g, '</p><p>')}</p>`]);
    if (r.strengths && r.strengths.length) sec.push(['工作中的优势', `<ul class="list check">${r.strengths.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`]);
    if (r.weaknesses && r.weaknesses.length) sec.push(['工作中的劣势', `<ul class="list cross">${r.weaknesses.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`]);
    if (r.jobTraits) sec.push(['适合的岗位特质', `<p>${esc(r.jobTraits).replace(/\n/g, '</p><p>')}</p>`]);
    if (r.careers) sec.push(['适合的职业方向', `<p>${esc(r.careers).replace(/\n/g, '</p><p>')}</p>`]);
    if (r.contributions && r.contributions.length) sec.push(['对组织的贡献', `<ul class="list check">${r.contributions.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`]);
    if (r.leadership && r.leadership.length) sec.push(['领导风格', `<ul class="list">${r.leadership.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`]);
    if (r.pitfalls && r.pitfalls.length) sec.push(['潜在缺陷', `<ul class="list cross">${r.pitfalls.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`]);
    if (r.workEnv && r.workEnv.length) sec.push(['适合的工作环境', `<ul class="list">${r.workEnv.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`]);
    if (r.growth && r.growth.length) sec.push(['个人发展建议', `<ul class="list arrow">${r.growth.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`]);
    return sec;
  }

  function renderResult(profileId) {
    const p = P.get(profileId);
    if (p) { drawResultPage(p); return; }
    // 本地未命中：飞牛服务器模式下从 NAS 中央存储读取（分享链接 / 系统用户详情）
    if (SVR.available()) {
      app.innerHTML = backBar('测试结果', '#/testhub') + '<main class="page narrow"><div class="card"><p class="muted center">正在从服务器读取档案…</p></div></main>';
      SVR.fetchOne(profileId).then(sp => {
        if (sp) drawResultPage(sp);
        else app.innerHTML = backBar('档案', '#/testhub') + '<main class="page narrow"><div class="card"><h2>档案不存在</h2><p>该记录可能已被删除，或分享链接不完整。</p></div></main>';
      });
      return;
    }
    app.innerHTML = backBar('档案', '#/me') + '<main class="page narrow"><div class="card"><h2>档案不存在</h2><p><a href="#/me">返回我的档案</a></p></div></main>';
  }

  // 结果页分发：MBTI 档案走原有渲染，其余走通用结果页
  function drawResultPage(p) {
    if (p.type && REPORTS[p.type] && (!p.testId || p.testId === 'mbti')) {
      app.innerHTML = backBar('测试结果', '#/me') + '<main class="page narrow">' + resultHtml(p, true) + funRecHtml('mbti') + '</main>';
      bindResultActions(p);
      bindAiSection(p);
    } else {
      const ai = aiAvailable(p); // 主测才显示 AI 分析区，趣味测试无此功能
      app.innerHTML = backBar('测试结果', '#/me') + '<main class="page narrow">' + genericResultHtml(p) + (ai ? aiSectionHtml(p) : '') + funRecHtml(p.testId) + '</main>';
      bindResultActions(p);
      if (ai) bindAiSection(p);
    }
    // 来自「我的」页 🤖 按钮：进入结果页后自动开始 AI 分析
    let autoId = null;
    try { autoId = sessionStorage.getItem('mbti_auto_ai'); } catch (e) { /* 隐私模式 */ }
    if (autoId && autoId === p.id && aiAvailable(p)) {
      try { sessionStorage.removeItem('mbti_auto_ai'); } catch (e) {}
      if (!p.aiAnalysis && document.getElementById('btn-ai-run')) runAi(p);
    }
  }

  // ============ 通用结果页（霍兰德 / DISC / 九型 / 趣味测试） ============
  function genericResultHtml(p) {
    const r = p.result || {};
    const info = ENG.testInfo(p.testId) || { icon: '🧩', title: p.testTitle || '心理测试' };
    const paras = (r.text || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
    let body = '';

    // 主测专属区块
    if (p.testId === 'holland') {
      const H = window.PSY_TESTS.holland;
      body += (r.top3 || []).map(d => `
        <div class="card dim-card">
          <h2>${d.key} · ${esc(d.name)} <small>${esc(d.en || '')}</small></h2>
          <p>${esc(d.traits || '')}</p>
          ${d.careers ? `<p class="muted"><b>典型职业：</b>${esc(d.careers)}</p>` : ''}
        </div>`).join('');
      if (r.careers) body += `<div class="card"><h2>你的职业方向（${esc(r.code)}）</h2><p>${esc(r.careers)}</p></div>`;
      body += countsCard(r, H.dims ? Object.fromEntries(Object.entries(H.dims).map(([k, d]) => [k, d.name])) : {});
    } else if (p.testId === 'disc') {
      body += countsCard(r, {});
      body += (r.detail || []).map(d => `
        <div class="card dim-card">
          <h2>${d.key} · ${esc(d.name)} <small>${esc(d.en || '')}</small></h2>
          <p class="dim-q">${esc(d.headline || '')}</p>
          ${d.emotion ? `<p><b>情感方面：</b>${esc(d.emotion)}</p>` : ''}
          ${d.work ? `<p><b>工作方面：</b>${esc(d.work)}</p>` : ''}
          ${d.relations ? `<p><b>人际关系：</b>${esc(d.relations)}</p>` : ''}
          ${d.words ? `<p class="muted"><b>描述词：</b>${esc(d.words)}</p>` : ''}
        </div>`).join('');
      if (r.rule) body += `<p class="muted center">${esc(r.rule)}</p>`;
    } else if (p.testId === 'enneagram') {
      const ty = r.type || {};
      body += countsCard(r, {});
      if (ty.key) body += `
        <div class="card dim-card">
          <h2>第 ${ty.key} 型 · ${esc(ty.name || '')}</h2>
          <p class="muted">别名：${esc(ty.alias || '')}</p>
          ${(ty.paragraphs || []).map(x => `<p>${esc(x)}</p>`).join('')}
        </div>`;
      if (r.wing) body += `<p class="muted center">${esc(r.wing)}</p>`;
    } else {
      // 趣味测试
      if (r.score != null) body += `<div class="card"><h2>得分：${r.score}${esc(r.unit || '分')}${r.index != null ? `（标准分 ${r.index}）` : ''}</h2>${r.range && r.range.title ? `<p class="dim-q">${esc(r.range.title)}</p>` : ''}${r.positive != null ? `<p class="muted">阳性项目（单项 ≥2 分）：${r.positive} 项</p>` : ''}</div>`;
      if (r.counts) body += countsCard(r, {});
      if (r.dimRows && r.dimRows.length) body += `<div class="card"><h2>维度判读</h2>${r.dimRows.map(d => `
        <div class="perq-item"><b>${esc(d.name)} · 均分 ${d.mean}</b>
        <p><span class="badge blue">${esc(d.title)}</span></p>
        <p>${esc(d.text || '')}</p></div>`).join('')}</div>`;
      if (r.dims && r.dims.length) body += `<div class="card"><h2>维度得分</h2>${r.dims.map(d => `
        <div class="tally-row"><span class="tally-name">${esc(d.name || d.key)}</span>
        <div class="dim-bar"><div class="dim-fill" style="width:${Math.min(100, Math.round((d.score / Math.max(1, r.dims[0].score)) * 100))}%"></div></div>
        <b>${d.score}${r.positive != null && d.count ? `（均 ${d.mean}）` : ''}</b></div>`).join('')}
        <p class="muted">${r.positive != null ? '因子分 = 因子总分 ÷ 因子项目数，≥2 分提示该因子筛查阳性。' : '最高的三项是你最看重的维度。'}</p></div>`;
      if (r.extra && (r.extra.advantage || r.extra.disadvantage)) body += `
        ${r.extra.advantage ? `<div class="card"><h2>性格优势</h2><ul class="list check">${r.extra.advantage.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        ${r.extra.disadvantage ? `<div class="card"><h2>性格过当</h2><ul class="list cross">${r.extra.disadvantage.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}`;
      if (r.perq && r.perq.length) body += `<div class="card"><h2>逐题解读</h2>${r.perq.map(q => `
        <div class="perq-item">
          <b>${q.n}. ${esc(q.text)}</b>
          ${q.opt ? `<p class="muted">你选了：${esc(q.opt)}</p>` : ''}
          <p>${esc(q.interp)}</p>
        </div>`).join('')}</div>`;
      if (r.steps && r.steps.length && r.engine === 'branch') body += `
        <details class="card"><summary>你的作答路径（${r.steps.length} 步）</summary>
          ${r.steps.map(st => `<div class="perq-item"><b>${esc(st.text)}</b><p class="muted">→ ${esc(st.opt ? st.opt.text : '')}</p></div>`).join('')}
        </details>`;
    }

    return `
    <div class="result-head generic">
      <div class="result-type-code">${info.icon}</div>
      <div class="result-type-name">${esc(r.title || p.summary || '测试完成')}</div>
      <div class="result-meta">${esc(p.testTitle || info.title)} · ${esc(p.name || '未命名')} · ${esc(fmtTime(p.finishedAt || p.createdAt))}${p.durationMin ? ' · 用时约 ' + p.durationMin + ' 分钟' : ''}</div>
    </div>
    ${paras.length ? `<div class="card"><h2>结果解析</h2>${paras.map(x => `<p>${esc(x)}</p>`).join('')}</div>` : ''}
    ${body}
    <div class="result-actions">
      <button class="btn primary" id="btn-share">复制分享链接</button>
      <button class="btn" id="btn-summary">复制结果摘要</button>
      <button class="btn" id="btn-export">导出档案 JSON</button>
      <a class="btn" href="${startHrefOf(p)}">再测一次</a>
    </div>`;
  }

  // 计数条形卡片（tally / 主测 counts）
  function countsCard(r, nameMap) {
    const counts = r.counts;
    if (!counts) return '';
    const max = Math.max(1, ...Object.values(counts));
    const rows = (r.sorted || Object.keys(counts).map(k => ({ key: k, n: counts[k] })));
    return `<div class="card"><h2>各项得分</h2>
      ${rows.map(s => `<div class="tally-row"><span class="tally-name">${esc((nameMap && (nameMap[s.key] || nameMap[String(s.key)])) || s.name || s.key)}</span>
      <div class="dim-bar"><div class="dim-fill" style="width:${Math.round((s.n / max) * 100)}%"></div></div>
      <b>${s.n}</b></div>`).join('')}</div>`;
  }

  function renderType(t) {
    const code = (t || '').toUpperCase();
    const r = REPORTS[code];
    if (!r) { go('#/intro/types16', true); return; }
    const tempKey = S.temperamentOf(code);
    const fakeProfile = { type: code, stats: null, version: 'view', name: '', id: null };
    app.innerHTML = backBar(code + ' 类型详情', '#/types') + `
    <main class="page narrow">
      ${resultHtml(fakeProfile, false, r)}
      <div class="card"><h2>所属气质：${esc(C.temperaments[tempKey].name)}</h2><p>${esc(C.temperaments[tempKey].description)}</p></div>
    </main>`;
  }

  function resultHtml(p, isProfile, fixedReport) {
    const r = fixedReport || REPORTS[p.type];
    const meta = typeMeta(p.type);
    const tempKey = S.temperamentOf(p.type);
    const temp = C.temperaments[tempKey];
    const secs = reportSections(r);
    return `
    <div class="result-head t-${tempKey}">
      <div class="result-type-code">${p.type}</div>
      <div class="result-type-name">${esc(r.name || '')} · ${esc(meta.en || '')}</div>
      ${r.motto ? `<div class="result-motto">「${esc(r.motto)}」</div>` : ''}
      ${isProfile ? `<div class="result-meta">${esc(p.name || '未命名')} · ${p.version === '93' ? '93 题完整版' : '28 题速测版'} · ${esc(fmtTime(p.finishedAt || p.createdAt))}${p.durationMin ? ' · 用时约 ' + p.durationMin + ' 分钟' : ''}</div>` : ''}
    </div>
    ${isProfile && p.stats ? `
    <div class="card">
      <h2>四维度得分</h2>
      <div class="radar-wrap">${radarSvg(p.stats)}</div>
      ${p.stats.map(dimBar).join('')}
      <p class="muted">计分规则：每个维度比较两个字母的得分，得分高者入选；平局按原版规则取第二个字母（I/N/F/P）。</p>
    </div>` : ''}
    <div class="card t-${tempKey}-border">
      <h2>气质类型：${esc(temp.name)}</h2>
      <p>${esc(temp.question)}　${esc(temp.style)}</p>
      <p>${esc(temp.description)}</p>
    </div>
    ${isProfile ? aiSectionHtml(p) : ''}
    ${secs.map(([title, html]) => `<div class="card"><h2>${esc(title)}</h2>${html}</div>`).join('')}
    ${isProfile ? `
    <div class="result-actions">
      <button class="btn primary" id="btn-share">复制分享链接</button>
      <button class="btn" id="btn-summary">复制结果摘要</button>
      <button class="btn" id="btn-export">导出档案 JSON</button>
      <a class="btn" href="#/match?a=${encodeURIComponent(p.id)}">组合搭配分析</a>
      <button class="btn" id="btn-retest">再测一次</button>
    </div>` : ''}
    `;
  }

  // ---- AI 深度分析（仅 4 大主测：MBTI/霍兰德/DISC/九型；趣味测试不提供） ----
  function aiAvailable(p) {
    return true; // 本中心全部为专业量表，均可 AI 深度分析（授权按 uid 由管理员开通）
  }
  function aiSectionHtml(p) {
    if (!MODE_WB) return ''; // 本地 / CGI 模式不提供 AI（原浏览器直连配置已下线）
    return `
    <div class="card ai-card" id="ai-card">
      <h2>🤖 AI 深度分析</h2>
      ${p.aiAnalysis ? `
        <div class="ai-output">${AI.mdToHtml(p.aiAnalysis)}</div>
        <div class="row-between" style="margin-top:10px">
          <span class="muted">已生成 · ${esc(fmtTime(p.aiAnalysisAt || p.finishedAt))}</span>
          <button class="btn small" id="btn-ai-redo">重新分析</button>
        </div>` : `
        <p class="muted">把你的完整作答（每题选项）与测试结果交给 AI，生成个性化深度分析报告：画像、维度解析、优势盲点、发展建议与成长行动。</p>
        <button class="btn primary full" id="btn-ai-run">开始 AI 深度分析</button>
        <p class="muted center" id="ai-auth-hint" style="margin-top:8px"></p>`}
    </div>`;
  }

  function bindAiSection(p) {
    const run = document.getElementById('btn-ai-run');
    const redo = document.getElementById('btn-ai-redo');
    const handler = () => runAi(p);
    if (run) run.addEventListener('click', handler);
    if (redo) redo.addEventListener('click', handler);
    // 提前探测授权状态，未授权时给出提示
    if (run && SVR.aiAuth) {
      SVR.aiAuth().then(ok => {
        const hint = document.getElementById('ai-auth-hint');
        if (hint) hint.textContent = ok ? '' : '🔒 该功能需管理员在你的档案编号上开通授权后使用';
      }).catch(() => {});
    }
  }

  // 组装 AI 分析输入：问答明细 + 测试引导词（服务端调用工作台 ai_config）
  function buildAiPrompt(p) {
    const u = U.load();
    const who = [u.nickname || u.name, u.age && (u.age + '岁'), u.gender, u.job, u.hobbies && ('爱好：' + u.hobbies)].filter(Boolean).join(' · ');
    const head = `请以专业心理测评分析师的口吻，基于以下「${p.testTitle || testLabel(p)}」测试的作答明细与结果，输出一份完整、深入的分析报告（Markdown），包含：1) 总体画像 2) 各维度/选项解读 3) 优势与潜在盲点 4) 职业与发展建议 5) 人际与沟通建议 6) 可执行的成长行动清单。语气友善，避免绝对化判断。`
      + (who ? `\n\n【受测者资料】${who}` : '')
      + `\n\n【测试】${p.testTitle || testLabel(p)}`
      + `\n【结果】${(p.result && p.result.title) || p.summary || p.type || ''}`;
    const statsLine = p.stats && p.stats.length
      ? '\n【四维度得分】' + p.stats.map(s => `${s.left}${s.leftCount}:${s.rightCount}${s.right}（倾向${s.winner}）`).join('，')
      + `\n【人格类型】${p.type} ${typeMeta(p.type).name || ''}`
      : '';
    const guideLine = p.result && p.result.text ? '\n【官方结果解读（引导词）】\n' + String(p.result.text).slice(0, 1500) : '';

    return resolveQaLines(p).then(qa => head + statsLine + guideLine + '\n\n【答题明细（题 → 所选）】\n' + qa);
  }

  // 题库问答明细：MBTI 用本地题库；主测用 PSY_TESTS；趣味测试懒加载 fun json
  function resolveQaLines(p) {
    const ans = p.answers || {};
    if (p.testId === 'mbti' || (!p.testId && p.version)) {
      const { flat } = bankOf(p.version || '28');
      return Promise.resolve(flat.map((q, i) => {
        const a = ans[i + 1];
        if (a == null) return null;
        return `${i + 1}. ${q.choices ? (q.stem ? q.stem + '：' : '') + q.choices[a].text : ''}`;
      }).filter(Boolean).join('\n'));
    }
    if (p.testId === 'holland' || p.testId === 'enneagram') {
      const qs = window.PSY_TESTS[p.testId].questions;
      return Promise.resolve(qs.map(q => ans[q.n] == null ? null : `${q.n}. ${q.text} → ${ans[q.n] === 1 || ans[q.n] === '1' || ans[q.n] === '是' ? '是' : '否'}`).filter(Boolean).join('\n'));
    }
    if (p.testId === 'disc') {
      const groups = window.PSY_TESTS.disc.groups;
      return Promise.resolve(groups.map((g, gi) => {
        const d = ans[gi + 1];
        if (!d) return null;
        const st = g.find(x => x.dim === d) || {};
        return `${gi + 1}. ${st.t ? st.t + '：' : ''}${st.d || ''}（${d}）`;
      }).filter(Boolean).join('\n'));
    }
    if (FUN_ID.test(p.testId || '')) {
      return ENG.loadFun(p.testId).then(t => {
        if (t.engine === 'single' || t.single) {
          const opts = t.opts || (t.questions && t.questions[0] && t.questions[0].opts) || [];
          const o = opts.find(x => x.key === ans[1]);
          return `1. ${t.question || ''} → ${o ? o.text : ans[1]}`;
        }
        if (t.engine === 'order') {
          return `${t.question || ''} → 按可能性排序：${[1, 2, 3].map(i => { const k = ans[i]; const o = (t.opts || []).find(x => x.key === k); return o ? o.text : k; }).join(' > ')}`;
        }
        const qs = t.questions || [];
        return qs.map(q => {
          const key = ans[q.n];
          if (key == null) return null;
          const o = ((q.opts && q.opts.length ? q.opts : (t.globalOpts || t.options || [])).find(x => x.key === key)) || {};
          return `${q.n}. ${q.text} → ${o.text || key}`;
        }).filter(Boolean).join('\n');
      }).catch(() => '');
    }
    return Promise.resolve('');
  }

  function runAi(p) {
    if (!aiAvailable(p)) return; // 双保险：趣味测试不允许触发（正常入口已隐藏）
    const card = document.getElementById('ai-card');
    if (!card) return;
    card.innerHTML = `<h2>🤖 AI 深度分析</h2>
      <div class="ai-output ai-streaming"><span class="ai-cursor"></span>正在生成分析报告，通常需要 10-60 秒，请勿离开本页…</div>
      <p class="muted"><button class="btn small" id="btn-ai-cancel">取消</button></p>`;
    let cancelled = false;
    document.getElementById('btn-ai-cancel').addEventListener('click', () => { cancelled = true; drawResultPage(p); });

    Promise.all([SVR.aiAuth(), buildAiPrompt(p)]).then(([ok, prompt]) => {
      if (cancelled) return;
      if (!ok) {
        card.innerHTML = `<h2>🤖 AI 深度分析</h2><div class="warn-box">🔒 未开通 AI 分析授权。请联系管理员在工作台「系统用户列表」中为你的档案编号（${esc(p.uid || U.load().uid)}）开通。</div>`;
        return;
      }
      return SVR.aiAnalysis({ id: p.id, uid: p.uid || U.load().uid, prompt }).then(text => {
        if (cancelled) return;
        const updated = Object.assign({}, p, { aiAnalysis: text, aiAnalysisAt: new Date().toISOString() });
        P.save(updated);
        SVR.syncProfile(updated, U.load());
        drawResultPage(updated);
        const el = document.getElementById('ai-card');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }).catch(e => {
      if (cancelled) return;
      alert('AI 分析失败：' + (e && e.message ? e.message : '服务不可用'));
      drawResultPage(p);
    });
  }

  function summaryText(p) {
    if (p.type && REPORTS[p.type] && (!p.testId || p.testId === 'mbti')) {
      const r = REPORTS[p.type];
      return `【MBTI 测试结果】${p.name || '未命名'}：${p.type} ${r.name || ''}${r.motto ? '「' + r.motto + '」' : ''}\n` +
        (p.stats || []).map(s => `${s.left}${s.leftCount} : ${s.rightCount}${s.right}（倾向 ${s.winner}）`).join('\n') +
        `\n测试版本：${p.version === '93' ? '93 题完整版' : '28 题速测版'}`;
    }
    const res = p.result || {};
    let lines = `【${p.testTitle || '心理测试'}】${p.name || '未命名'}：${res.title || p.summary || '测试完成'}\n`;
    if (res.score != null) lines += `得分：${res.score}${res.unit || '分'}\n`;
    if (res.counts) lines += (res.sorted || Object.keys(res.counts).map(k => ({ key: k, n: res.counts[k] })))
      .map(s => `${(s.name || s.key)}：${s.n}`).join('，') + '\n';
    if (res.text) lines += String(res.text).split(/\n+/).slice(0, 6).join('\n');
    return lines;
  }

  function bindResultActions(p) {
    const share = document.getElementById('btn-share');
    if (share) share.addEventListener('click', () => {
      const link = SVR.buildShareLink(p.id);
      if (!link) {
        copyText(summaryText(p));
        alert('当前为本地模式（无访问域名），已复制文本摘要。\n部署到服务器（工作台 / 飞牛）后即可使用链接分享。');
        return;
      }
      // 服务器模式下先确保该档案已同步到服务器，接收方才能打开
      const proceed = () => showShareDialog(link, p);
      if (SVR.available()) SVR.syncProfile(p, U.load()).then(proceed, proceed);
      else proceed();
    });
    const summary = document.getElementById('btn-summary');
    if (summary) summary.addEventListener('click', () => copyText(summaryText(p)));
    const exp = document.getElementById('btn-export');
    if (exp) exp.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `档案_${(p.testTitle || 'MBTI')}_${(p.name || p.id)}_${p.type || p.testId || ''}.json`;
      a.click(); URL.revokeObjectURL(a.href);
    });
    const rt = document.getElementById('btn-retest');
    if (rt) rt.addEventListener('click', () => { go(startHrefOf(p)); });
  }

  function copyText(txt) {
    const done = () => alert('已复制到剪贴板');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, () => fallback());
    else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { alert(txt); }
      document.body.removeChild(ta);
    }
  }

  // ============ 设置（我的 → 设置入口） ============
  function renderSettings() {
    const site = SITE.load();
    app.innerHTML = `
    <main class="page narrow">
      ${MODE_WB ? `
      <div class="card">
        <h2>🔗 站点与分享</h2>
        <p class="muted">当前模式：<b>工作台模式</b> — 每次测试自动同步到工作台服务器；分享链接接收方<b>无需登录</b>即可打开。<b>AI 深度分析</b>由管理员按档案编号授权后开放，调用工作台统一配置的 AI 服务。管理员请在工作台「效率工具 → 抑郁测试」页查看系统用户列表与全部测试记录。</p>
      </div>` : `
      <div class="card">
        <h2>🔗 站点与分享</h2>
        <p class="muted">填写当前飞牛 NAS 的访问域名（含端口，例如 <b>https://nas.example.com:5666</b>），用于拼接测试结果的分享链接。仅飞牛 FPK 部署下有效。</p>
        <div class="field">
          <label>飞牛访问域名</label>
          <input id="site-domain" type="text" placeholder="https://nas.example.com:5666" value="${esc(site.domain)}">
        </div>
        <button class="btn primary" id="btn-site-save">保存域名</button>
        <p class="muted" id="site-preview" style="margin-top:10px"></p>
        <p class="muted">当前模式：<b>${SVR.available() ? '飞牛服务器模式' : '本地模式'}</b>${SVR.available()
          ? ' — 每次测试自动同步到 NAS，管理员可跨设备查看全部记录。'
          : ' — 数据仅保存在本浏览器；部署到飞牛后自动开启跨设备同步。'}</p>
      </div>`}
      <div class="card">
        <h2>🤖 关于 AI 深度分析</h2>
        <p class="muted">AI 分析已改为<b>按用户授权</b>：管理员在工作台「系统用户列表」为指定档案编号开通后，该用户即可在测试结果页与「我的」历次记录中使用 AI 深度分析。AI 服务地址与密钥由工作台统一配置（本页面不再保存任何 API Key）。</p>
      </div>
      <div class="card">
        <h2>数据与隐私</h2>
        <ul class="list">
          <li>测试答案与档案保存在本设备浏览器内，并在工作台模式下同步到服务器。</li>
          <li>AI 分析会把你的作答内容发送到工作台配置的 AI 服务。</li>
        </ul>
        <button class="btn danger full" id="btn-clear-all">清空全部本地数据（档案/资料）</button>
      </div>
      <div class="card">
        <h2>关于</h2>
        <p class="muted">抑郁测试中心 · SDS/SAS/BDI/PHQ-9 等专业抑郁与情绪量表<br>计分规则与解读内容整理自原版量表材料。<br>量表为自我报告筛查工具，不能替代临床诊断；如长期情绪低落，请及时寻求专业帮助。</p>
      </div>
      ${adminCardHtml()}
    </main>`;
    const previewSite = () => {
      const el = document.getElementById('site-preview');
      if (!el) return;
      const d = SITE.load().domain.trim();
      el.textContent = d ? '分享链接示例：' + d.replace(/\/+$/, '') + SVR.CGI_PATH + '#/result/P…' : '';
    };
    previewSite();
    const btnSite = document.getElementById('btn-site-save');
    if (btnSite) btnSite.addEventListener('click', () => {
      SITE.save({ domain: document.getElementById('site-domain').value.trim() });
      previewSite();
      alert('已保存飞牛域名');
    });
    bindAdminCard();
    document.getElementById('btn-clear-all').addEventListener('click', () => {
      if (confirm('确定清空全部本地数据？此操作不可恢复。')) {
        ADMIN.logout();
        // 只清本中心的键：同源还部署着其他测评中心（/dep/、/dep/、/pro/ 共享 localStorage），
        // localStorage.clear() 会把它们一并清掉
        [P.STORE_KEY, P.SESSION_KEY, U.USER_KEY, SITE.KEY, ADMIN.ADMIN_KEY, ADMIN.SESSION_KEY]
          .forEach(k => { try { localStorage.removeItem(k); } catch (e) { /* 忽略 */ } });
        U.reset();
        alert('已清空');
        go('#/testhub');
      }
    });
  }

  // ============ 我的（底部导航「我的」） ============
  // 历次记录行的 AI 按钮：授权后可直达深度分析（本地/CGI 模式不显示）
  function aiBtnHtml(p) {
    if (!MODE_WB || !SVR.aiAuth || !aiAvailable(p)) return ''; // 趣味测试不提供 AI 分析
    if (!p.aiAnalysis) return `<button class="icon-btn ai" data-ai="${p.id}" title="AI深度分析">🤖</button>`;
    return '';
  }

  function renderMe() {
    const user = U.load();
    const history = U.myProfiles();
    app.innerHTML = `
    <main class="page narrow">
      <div class="card me-card">
        <div class="me-avatar-wrap">
          <div class="me-avatar" id="me-avatar">${user.avatar ? `<img src="${user.avatar}" alt="头像">` : '👤'}</div>
          <input type="file" id="avatar-input" accept="image/*" hidden>
          <button class="me-avatar-btn" id="btn-avatar">更换头像</button>
        </div>
        <div class="me-head-info">
          <div class="me-uid">档案编号 <b>${esc(user.uid)}</b><button class="icon-btn" id="btn-copy-uid" title="复制编号">⧉</button></div>
          <p class="muted">此编号自动生成，用于关联你的历次测试记录</p>
        </div>
      </div>
      <div class="card">
        <h2>个人资料 <small>（全部选填）</small></h2>
        <div class="form-grid">
          <div class="field"><label>昵称</label><input id="u-nickname" maxlength="20" value="${esc(user.nickname)}" placeholder="展示用昵称"></div>
          <div class="field"><label>姓名</label><input id="u-name" maxlength="20" value="${esc(user.name)}" placeholder="真实姓名"></div>
          <div class="field"><label>年龄</label><input id="u-age" type="number" min="1" max="120" value="${esc(user.age)}" placeholder="岁"></div>
          <div class="field"><label>性别</label>
            <select id="u-gender">
              <option value="">不填</option>
              <option value="男" ${user.gender === '男' ? 'selected' : ''}>男</option>
              <option value="女" ${user.gender === '女' ? 'selected' : ''}>女</option>
            </select></div>
          <div class="field"><label>职业</label><input id="u-job" maxlength="30" value="${esc(user.job)}" placeholder="例如：产品经理"></div>
          <div class="field"><label>爱好</label><input id="u-hobbies" maxlength="50" value="${esc(user.hobbies)}" placeholder="例如：阅读、徒步、摄影"></div>
        </div>
        <button class="btn primary full" id="btn-save-me">保存资料</button>
      </div>
      <div class="card">
        <div class="row-between"><h2 style="margin:0">历次测试（${history.length}）</h2>
          ${history.length >= 2 ? '<a href="#/match" class="muted">MBTI组合搭配 ›</a>' : ''}</div>
        ${history.length === 0 ? '<p class="muted">还没有记录。完成任意测试后都会保留并显示结果与时间。</p><a class="btn primary" href="#/testhub">去开始第一个测试</a>' : `
        <div class="profile-list">
          ${history.map(p => `
          <div class="profile-item">
            <a href="#/result/${p.id}" class="profile-main">
              ${testChip(p)}
              <div class="profile-info">
                <b>${esc(p.name || '未命名')}</b>
                <span>${esc(testLabel(p))} · ${esc(fmtTime(p.finishedAt || p.createdAt))}${p.aiAnalysis ? ' · 🤖已AI分析' : ''}</span>
              </div>
            </a>
            <span style="display:flex;gap:4px;align-items:center">
              ${aiBtnHtml(p)}
              <button class="icon-btn del" data-id="${p.id}" title="删除">✕</button>
            </span>
          </div>`).join('')}
        </div>`}
      </div>
    </main>`;

    document.getElementById('btn-avatar').addEventListener('click', () => document.getElementById('avatar-input').click());
    document.getElementById('avatar-input').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { alert('头像请小于 2MB'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        U.save({ avatar: reader.result });
        renderMe();
      };
      reader.readAsDataURL(file);
    });
    document.getElementById('btn-copy-uid').addEventListener('click', () => copyText(user.uid));
    document.getElementById('btn-save-me').addEventListener('click', () => {
      const info = {
        nickname: document.getElementById('u-nickname').value.trim(),
        name: document.getElementById('u-name').value.trim(),
        age: document.getElementById('u-age').value,
        gender: document.getElementById('u-gender').value,
        job: document.getElementById('u-job').value.trim(),
        hobbies: document.getElementById('u-hobbies').value.trim(),
      };
      U.save(info);
      // 工作台模式下同步到服务器，管理员「系统用户列表」即可看到完整资料
      const syncing = (SVR.mode && SVR.mode() === 'workbench' && SVR.saveUserInfo)
        ? SVR.saveUserInfo(Object.assign({ uid: user.uid }, info)).catch(() => false)
        : Promise.resolve(null); // 非工作台模式（本地/file://）只存本机
      syncing.then(ok => {
        alert(ok === null ? '资料已保存（本机）' : (ok ? '资料已保存，并已同步到工作台' : '资料已保存（同步工作台失败，下次完成测试时会自动重试）'));
      });
    });
    app.querySelectorAll('.ai').forEach(b => b.addEventListener('click', () => {
      // 跳到结果页并自动触发 AI 分析
      try { sessionStorage.setItem('mbti_auto_ai', b.dataset.ai); } catch (e) {}
      location.hash = '#/result/' + b.dataset.ai;
    }));
    app.querySelectorAll('.del').forEach(b => b.addEventListener('click', () => {
      if (confirm('确定删除该条测试记录？')) { P.remove(b.dataset.id); SVR.remove(b.dataset.id); renderMe(); }
    }));
  }

  // ============ 16 类型图鉴 ============
  function renderTypes() {
    app.innerHTML = backBar('16 类型图鉴', '#/intro') + `
    <main class="page">
      <div class="card"><h2>16 种人格类型图鉴</h2><p>点击任意类型查看详细解读（特征、优劣势、职业、发展建议）。</p></div>
      ${['SJ', 'SP', 'NT', 'NF'].map(g => `
      <div class="card">
        <h2 class="t-${g}-text">${esc(C.temperaments[g].name)} <small>${esc(C.temperaments[g].en)}</small></h2>
        <div class="type-grid">
          ${C.temperaments[g].types.map(t => {
            const r = REPORTS[t];
            return `<a class="type-cell t-${g}" href="#/type/${t}">
              <b>${t}</b><span>${esc((r && r.name) || '')}</span>
              <i>${esc(r && r.motto ? r.motto : (C.typesOverview[t] ? C.typesOverview[t].en : ''))}</i>
            </a>`;
          }).join('')}
        </div>
      </div>`).join('')}
    </main>`;
  }

  // ============ 组合搭配（仅 MBTI 档案） ============
  function renderMatch(qs) {
    const list = U.myProfiles().filter(p => p.type && REPORTS[p.type]);
    const aId = qs.get('a'), bId = qs.get('b');
    if (aId && bId) {
      const pa = P.get(aId), pb = P.get(bId);
      if (pa && pb) { renderMatchResult(pa, pb); return; }
    }
    app.innerHTML = backBar('组合搭配分析', '#/me') + `
    <main class="page narrow">
      <div class="card">
        <h2>组合搭配分析</h2>
        <p>选择两份测试档案，分析两人的气质组合特点：可能的摩擦点、互补的成长点，以及相互沟通的技巧。适用于团队搭配、搭档协作、婚恋相处等场景。</p>
        ${list.length < 2 ? `<div class="warn-box">需要至少两份档案（当前 ${list.length} 份）。可先完成测试，或 <a href="#/matchType">按类型自由组合分析 →</a>。</div>` : `
        <div class="match-pick">
          <div class="field"><label>甲方</label>
            <select id="pick-a">${list.map((p, i) => `<option value="${p.id}" ${i === 0 ? 'selected' : ''}>${esc(p.name || '未命名')} · ${p.type}</option>`).join('')}</select></div>
          <div class="vs-badge">VS</div>
          <div class="field"><label>乙方</label>
            <select id="pick-b">${list.map((p, i) => `<option value="${p.id}" ${i === 1 ? 'selected' : ''}>${esc(p.name || '未命名')} · ${p.type}</option>`).join('')}</select></div>
        </div>
        <button class="btn primary full" id="btn-match">开始搭配分析</button>`}
        <p class="muted center" style="margin-top:12px"><a href="#/matchType">没有两份档案？按类型自由组合 →</a></p>
      </div>
    </main>`;
    const btn = document.getElementById('btn-match');
    if (btn) btn.addEventListener('click', () => {
      go('#/match?a=' + document.getElementById('pick-a').value + '&b=' + document.getElementById('pick-b').value);
    });
  }

  function renderMatchResult(pa, pb) {
    const ta = S.temperamentOf(pa.type), tb = S.temperamentOf(pb.type);
    const combo = C.combinations.find(c =>
      (c.a === ta && c.b === tb) || (c.a === tb && c.b === ta)) || null;

    const dimCompare = S.DIMENSIONS.map((d, i) => {
      const idx = { EI: 0, SN: 1, TF: 2, JP: 3 }[d.key];
      const la = pa.type[idx], lb = pb.type[idx];
      const same = la === lb;
      const dd = dimOf(d.key);
      const ga = pa.stats ? pa.stats.find(s => s.key === d.key) : null;
      const gb = pb.stats ? pb.stats.find(s => s.key === d.key) : null;
      return `<div class="mc-dim ${same ? 'same' : 'diff'}">
        <span class="mc-letter">${la}</span>
        <div class="mc-mid">
          <div class="mc-name">${esc(dd.name || d.key)}</div>
          <div class="mc-status">${same ? '同偏好' : '互补偏好'}</div>
          ${ga && gb ? `<div class="mc-pcts">${la} ${Math.max(ga.leftPct, ga.rightPct)}% ↔ ${lb} ${Math.max(gb.leftPct, gb.rightPct)}%</div>` : ''}
        </div>
        <span class="mc-letter">${lb}</span>
      </div>`;
    }).join('');

    function tipsFor(type) {
      return [type[0], type[1], type[2], type[3]].map(k => C.communication[k]).filter(Boolean);
    }
    const tipsB = tipsFor(pb.type), tipsA = tipsFor(pa.type);

    app.innerHTML = backBar('搭配分析结果', '#/match') + `
    <main class="page narrow">
      <div class="card match-head">
        <div class="match-side">
          ${typeBadge(pa.type)}
          <b>${esc(pa.name || '未命名')}</b>
          <span class="t-${ta}-text">${esc(C.temperaments[ta].name)}</span>
        </div>
        <div class="vs-badge big">×</div>
        <div class="match-side">
          ${typeBadge(pb.type)}
          <b>${esc(pb.name || '未命名')}</b>
          <span class="t-${tb}-text">${esc(C.temperaments[tb].name)}</span>
        </div>
      </div>

      <div class="card"><h2>维度组合一览</h2>${dimCompare}
        <p class="muted">同偏好便于相互理解；互补偏好带来视角互补，也需要更多沟通磨合。</p></div>

      ${combo ? `
      <div class="card"><h2>气质组合：${esc(combo.label)}</h2>
        <h3 class="sub warn">可能的摩擦点</h3>
        <ul class="list cross">${combo.conflicts.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        <h3 class="sub good">互补与成长点</h3>
        <ul class="list check">${combo.synergies.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      </div>` : ''}

      <div class="card"><h2>如何与 ${esc(pb.name || '乙方')}（${pb.type}）沟通</h2>
        ${tipsB.map(tp => `<details open><summary>${esc(tp.name)}</summary><ul class="list">${tp.tips.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>`).join('')}
      </div>
      <div class="card"><h2>如何与 ${esc(pa.name || '甲方')}（${pa.type}）沟通</h2>
        ${tipsA.map(tp => `<details open><summary>${esc(tp.name)}</summary><ul class="list">${tp.tips.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>`).join('')}
      </div>

      <div class="card"><h2>两人压力对照</h2>
        <div class="mc-stress">
          <div><b>${esc(pa.name || '甲方')}（${ta}）</b><p>压力源：${esc(C.temperaments[ta].stress.sources.join('；'))}</p><p>舒解：${esc(C.temperaments[ta].stress.coping.join('；'))}</p></div>
          <div><b>${esc(pb.name || '乙方')}（${tb}）</b><p>压力源：${esc(C.temperaments[tb].stress.sources.join('；'))}</p><p>舒解：${esc(C.temperaments[tb].stress.coping.join('；'))}</p></div>
        </div>
      </div>
      <a class="btn full" href="#/match">← 重新选择</a>
    </main>`;
  }

  function renderMatchType() {
    const types = Object.keys(C.typesOverview);
    app.innerHTML = backBar('按类型组合', '#/match') + `
    <main class="page narrow">
      <div class="card">
        <h2>按类型组合分析</h2>
        <p>任选两个 MBTI 类型，查看气质组合的摩擦点与互补点。</p>
        <div class="match-pick">
          <div class="field"><label>类型 A</label>
            <select id="mt-a">${types.map(t => `<option ${t === 'ISTJ' ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
          <div class="vs-badge">×</div>
          <div class="field"><label>类型 B</label>
            <select id="mt-b">${types.map(t => `<option ${t === 'ENFP' ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        </div>
        <button class="btn primary full" id="btn-mt">查看组合分析</button>
      </div>
    </main>`;
    document.getElementById('btn-mt').addEventListener('click', () => {
      const a = document.getElementById('mt-a').value, b = document.getElementById('mt-b').value;
      const fakeA = { id: 'type:' + a, type: a, name: a + ' 型', stats: null, version: 'view' };
      const fakeB = { id: 'type:' + b, type: b, name: b + ' 型', stats: null, version: 'view' };
      renderMatchResult(fakeA, fakeB);
    });
  }

  // ============ 管理员（设置页末尾 + 独立页 #/admin） ============
  function adminCardHtml() {
    if (MODE_WB) {
      return `<div class="card">
        <h2>🛡️ 管理员</h2>
        <p class="muted">本部署（工作台模式）的管理功能已迁移：请打开工作台的「效率工具 → 抑郁测试」页面，在那里查看系统用户列表、全部测试记录并配置分享域名前缀。</p>
      </div>`;
    }
    const initiated = ADMIN.isInit();
    const on = ADMIN.loggedIn();
    let body;
    if (!initiated) {
      body = `
        <p class="muted">首次使用请设置管理员用户名与密码（保存在本机，密码仅存 SHA-256 摘要）。登录后底部导航将出现「系统用户」，可查看全部用户做过的试题。</p>
        <div class="field"><label>用户名（2-20 字符）</label><input id="adm-user" maxlength="20" autocomplete="off" placeholder="admin"></div>
        <div class="field"><label>密码（至少 4 位）</label><input id="adm-pass" type="password" autocomplete="new-password" placeholder="••••"></div>
        <div class="field"><label>确认密码</label><input id="adm-pass2" type="password" autocomplete="new-password" placeholder="再次输入"></div>
        <button class="btn primary full" id="btn-admin-setup">首次设置并登录</button>`;
    } else if (!on) {
      body = `
        <p class="muted">管理员：<b>${esc(ADMIN.username())}</b> · 登录后底部导航将出现「系统用户」，可查看全部用户做过的试题与详情。</p>
        <div class="field"><label>用户名</label><input id="adm-user" maxlength="20" autocomplete="off" placeholder="admin"></div>
        <div class="field"><label>密码</label><input id="adm-pass" type="password" autocomplete="current-password" placeholder="••••"></div>
        <button class="btn primary full" id="btn-admin-login">登录</button>`;
    } else {
      body = `
        <div class="row-between"><span>已登录：<b>${esc(ADMIN.username())}</b> <span class="admin-tag">管理员</span></span></div>
        <div class="q-nav" style="margin-top:12px">
          <a class="btn primary" href="#/users">进入系统用户</a>
          <button class="btn" id="btn-admin-logout">退出登录</button>
        </div>`;
    }
    return `<div class="card" id="admin-card">
        <h2>🛡️ 管理员</h2>
        ${body}
        <p class="muted" id="adm-msg" style="margin-top:8px"></p>
      </div>`;
  }

  function refreshAdminCard() {
    const card = document.getElementById('admin-card');
    if (!card) return;
    const div = document.createElement('div');
    div.innerHTML = adminCardHtml();
    card.replaceWith(div.firstElementChild);
    bindAdminCard();
    document.querySelectorAll('#tabbar .admin-only').forEach(el => { el.hidden = !ADMIN.loggedIn(); });
  }

  function bindAdminCard() {
    if (!document.getElementById('admin-card')) return;
    const msg = m => {
      const el = document.getElementById('adm-msg');
      if (el) { el.textContent = m || ''; el.className = m ? 'err-text' : 'muted'; }
    };
    const setupBtn = document.getElementById('btn-admin-setup');
    if (setupBtn) setupBtn.addEventListener('click', () => {
      const u = document.getElementById('adm-user').value;
      const p1 = document.getElementById('adm-pass').value;
      const p2 = document.getElementById('adm-pass2').value;
      if (p1 !== p2) { msg('两次输入的密码不一致'); return; }
      const r = ADMIN.init(u, p1);
      if (!r.ok) { msg(r.message); return; }
      ADMIN.login(u.trim(), p1);
      refreshAdminCard();
    });
    const loginBtn = document.getElementById('btn-admin-login');
    if (loginBtn) loginBtn.addEventListener('click', () => {
      const u = document.getElementById('adm-user').value;
      const pw = document.getElementById('adm-pass').value;
      const r = ADMIN.login(u, pw);
      if (!r.ok) { msg(r.message); return; }
      if ((location.hash || '').indexOf('#/admin') === 0) go('#/users');
      else refreshAdminCard();
    });
    const logoutBtn = document.getElementById('btn-admin-logout');
    if (logoutBtn) logoutBtn.addEventListener('click', () => {
      ADMIN.logout();
      if ((location.hash || '').indexOf('#/users') === 0) go('#/settings');
      else refreshAdminCard();
    });
  }

  function renderAdmin() {
    app.innerHTML = backBar('管理员登录', '#/settings') + `
    <main class="page narrow">
      ${adminCardHtml()}
    </main>`;
    bindAdminCard();
  }

  // ============ 系统用户（管理员：全部用户的测试记录） ============
  function renderUsers() {
    if (!ADMIN.loggedIn()) { go('#/admin', true); return; }
    app.innerHTML = backBar('系统用户 · 全部测试记录', '#/settings') + `
    <main class="page narrow">
      <div class="card">
        <div class="row-between">
          <h2 style="margin:0">全部用户测试记录</h2>
          <span style="display:flex;gap:6px">
            <button class="btn small" id="btn-users-refresh">刷新</button>
            <button class="btn small" id="btn-users-logout">退出</button>
          </span>
        </div>
        <p class="muted" id="users-summary">加载中…</p>
        <div id="users-body"></div>
      </div>
    </main>`;
    document.getElementById('btn-users-refresh').addEventListener('click', loadUsers);
    document.getElementById('btn-users-logout').addEventListener('click', () => { ADMIN.logout(); go('#/settings'); });
    loadUsers();
  }

  function loadUsers() {
    const body = document.getElementById('users-body');
    if (!body) return;
    const finish = serverList => {
      // 本地 + 服务器合并（按 id 去重，服务器版本优先）
      const byId = new Map();
      P.list().forEach(p => byId.set(p.id, p));
      (serverList || []).forEach(sp => byId.set(sp.id, sp));
      renderUsersList(Array.from(byId.values()), serverList === null ? 'local' : 'server');
    };
    if (SVR.available()) SVR.fetchAll().then(finish, () => finish(null));
    else finish(null);
  }

  function renderUsersList(all, mode) {
    const body = document.getElementById('users-body');
    const summary = document.getElementById('users-summary');
    if (!body) return;
    if (!all.length) {
      summary.textContent = mode === 'server' ? '暂无任何记录，等用户完成测试后自动出现。' : '暂无记录（本地模式仅统计本浏览器数据；部署到飞牛 FPK 后可查看全部用户）。';
      body.innerHTML = '<p class="muted">还没有用户做过测试。</p>';
      return;
    }
    const groups = new Map();
    all.forEach(p => {
      const uid = p.uid || '未知';
      if (!groups.has(uid)) groups.set(uid, []);
      groups.get(uid).push(p);
    });
    const gArr = Array.from(groups.entries()).map(([uid, list]) => {
      list.sort((a, b) => String(b.finishedAt || b.createdAt || '').localeCompare(String(a.finishedAt || a.createdAt || '')));
      const info = list[0].userInfo || {};
      return { uid, list, info, disp: info.nickname || info.name || list[0].name || '未命名用户' };
    }).sort((a, b) => b.list.length - a.list.length);

    summary.innerHTML = `共 <b>${gArr.length}</b> 位用户 · <b>${all.length}</b> 份试卷 · 数据源：${mode === 'server' ? 'NAS 中央存储' : '本浏览器'}`;
    body.innerHTML = gArr.map(g => `
      <div class="user-group">
        <div class="user-group-head">
          <b>${esc(g.disp)}</b>
          <span class="muted">${esc(g.uid)}</span>
          <span class="muted">${g.list.length} 次测试</span>
          ${g.info.job ? `<span class="muted">${esc(g.info.job)}</span>` : ''}
        </div>
        <div class="profile-list">
          ${g.list.map(p => `
          <div class="profile-item">
            <a href="#/result/${p.id}" class="profile-main">
              ${testChip(p)}
              <div class="profile-info">
                <b>${esc(p.name || '未命名')}</b>
                <span>${esc(testLabel(p))} · ${esc(fmtTime(p.finishedAt || p.createdAt))}${p.aiAnalysis ? ' · 🤖已AI分析' : ''}</span>
              </div>
            </a>
            <button class="icon-btn del" data-id="${p.id}" title="删除">✕</button>
          </div>`).join('')}
        </div>
      </div>`).join('');
    body.querySelectorAll('.del').forEach(b => b.addEventListener('click', () => {
      if (confirm('确定删除该条测试记录？（将同时删除 NAS 与本地副本）')) {
        P.remove(b.dataset.id);
        SVR.remove(b.dataset.id);
        loadUsers();
      }
    }));
  }

  // ============ 分享链接对话框 ============
  function showShareDialog(link, p) {
    document.querySelectorAll('.share-mask').forEach(m => m.remove());
    const mask = document.createElement('div');
    mask.className = 'share-mask';
    mask.innerHTML = `<div class="share-dialog">
      <h3>🔗 分享测试结果</h3>
      <p class="muted">${MODE_WB
        ? '把下面的链接发给对方，接收方无需登录即可直接打开查看。'
        : '把下面的链接发给对方。接收方需先登录你的飞牛 NAS（未登录直接打开会提示 invalid token），登录后即可查看。'}</p>
      <div class="share-link-row">
        <input id="share-link-input" type="text" readonly value="${esc(link)}">
        <button class="btn primary" id="btn-share-copy">复制</button>
      </div>
      <p class="muted">分享内容：${esc(p.name || '未命名')} · ${esc(p.type || p.testTitle || testLabel(p))}${p.summary && p.summary !== p.type ? ' · ' + esc(p.summary) : ''}</p>
      ${SVR.available() ? '' : '<div class="warn-box">当前为本地模式：该记录未同步到服务器，接收方可能无法打开。请通过工作台或飞牛部署地址访问本应用后再分享。</div>'}
      <button class="btn full" id="btn-share-close">关闭</button>
    </div>`;
    document.body.appendChild(mask);
    mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
    document.getElementById('btn-share-copy').addEventListener('click', () => copyText(link));
    document.getElementById('btn-share-close').addEventListener('click', () => mask.remove());
  }

  // ============ 启动 ============
  function boot() {
    if (!BRIDGE.applyRouteCommands(go)) route();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
