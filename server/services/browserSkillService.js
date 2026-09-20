// 浏览器自动化（Playwright）：登录业务系统、按配方取数、或探针 dump 页面结构
// 依赖：npm install playwright && playwright install chromium
let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { chromium = null; }
const skillService = require('./businessSkillService');

function ensureBrowser() {
  if (!chromium) throw new Error('Playwright 未安装：需 npm install playwright && playwright install chromium');
}

async function launch() {
  ensureBrowser();
  return chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
}

// 运行配方：登录→动作→抽取，返回抽取到的文本（HTML 或 纯文本），交给 DeepSeek 提炼字段
// recipe = { loginUrl, login:{userSelector,passSelector,submitSelector}, postLoginUrl, actions:[...], extract:{selector,type} }
// 支持金蝶云星空自定义流程（custom: 'kingdee_sale_list'）
async function runRecipe(sys, recipe) {
  // 金蝶云星空特殊流程
  if (recipe && recipe.custom === 'kingdee_sale_list') {
    return runKingdeeSaleList(sys, recipe);
  }
  const browser = await launch();
  let base = sys.url;
  try { base = new URL(sys.url).origin; } catch (e) {}
  const url = (s) => String(s || '').replace(/\{base\}/g, base);
  try {
    const page = await browser.newPage();
    await page.goto(url(recipe.loginUrl) || sys.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (recipe.login) {
      const { userSelector: u, passSelector: p, submitSelector: s } = recipe.login;
      if (u && p) {
        await page.fill(u, sys.username || '');
        await page.fill(p, skillService.decrypt(sys.password) || '');
      }
      if (s) await Promise.all([
        Promise.race([page.waitForNavigation({ timeout: 15000 }), page.waitForLoadState('networkidle', { timeout: 15000 })]).catch(() => {}),
        page.click(s).catch(() => {}),
      ]);
    }
    if (recipe.postLoginUrl) await page.goto(url(recipe.postLoginUrl), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    for (const step of recipe.actions || []) {
      if (step.wait) await page.waitForTimeout(step.wait);
      else if (step.waitFor) await page.waitForSelector(step.waitFor, { timeout: 30000 }).catch(() => {});
      else if (step.click) await page.click(step.click).catch(() => {});
      else if (step.fill) await page.fill(step.fill.selector, step.fill.value).catch(() => {});
      else if (step.goto) await page.goto(url(step.goto), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      else if (step.ensureSwitchOn) {
        // 找上下文含该文本的 el-switch，未开启则点开（如"按回款统计销售"）
        const clicked = await page.evaluate((lbl) => {
          const sw = [...document.querySelectorAll('.el-switch')].find((s) => (s.parentElement?.innerText || '').includes(lbl));
          if (!sw || sw.className.includes('is-checked')) return false;
          sw.click(); return true;
        }, step.ensureSwitchOn);
        if (clicked) await page.waitForTimeout(4000);
      }
    }
    if (recipe.extract && recipe.extract.type === 'tableFiltered') {
      // 抽取表格中"指定列为空"的行（如品牌汇总行）+ 可选底栏，返回 JSON {rows, footer}
      const cfg = recipe.extract;
      return await page.evaluate((c) => {
        const pick = (cells, idxs) => (idxs || cells.map((_, i) => i)).map((i) => (cells[i] || '').trim());
        const rows = [];
        for (const tr of document.querySelectorAll(c.rowSelector || '.el-table__body tbody tr')) {
          const cells = [...tr.querySelectorAll('td')].map((td) => (td.innerText || '').trim());
          if (cells.length && (cells[c.emptyCol] === '' || cells[c.emptyCol] == null)) rows.push(pick(cells, c.cols));
        }
        let footer = null;
        if (c.footerSelector) {
          const fc = [...document.querySelectorAll(c.footerSelector)].map((td) => (td.innerText || '').trim());
          footer = c.footerCols ? pick(fc, c.footerCols) : fc;
        }
        return JSON.stringify({ rows, footer });
      }, cfg);
    }
    if (recipe.extract && recipe.extract.type === 'tableRows') {
      // 抽取表格前 N 行的指定列，返回 JSON 数组（适合列表页，如 OA 已办事宜）
      const cfg = recipe.extract;
      return await page.evaluate((c) => {
        const pick = (cells, idxs) => (idxs || cells.map((_, i) => i)).map((i) => (cells[i] || '').trim());
        const rows = [];
        for (const tr of [...document.querySelectorAll(c.rowSelector || 'table tbody tr')].slice(0, c.maxRows || 50)) {
          const cells = [...tr.querySelectorAll('td')].map((td) => (td.innerText || '').trim().replace(/\n/g, ' '));
          if (cells.length) rows.push(pick(cells, c.cols));
        }
        return JSON.stringify(rows);
      }, cfg);
    }
    if (recipe.extract && recipe.extract.selector) {
      if (recipe.extract.type === 'html' || recipe.extract.type === 'table') {
        return await page.innerHTML(recipe.extract.selector).catch(() => '');
      }
      return await page.innerText(recipe.extract.selector).catch(() => '');
    }
    return await page.innerText('body').catch(() => '');
  } finally {
    await browser.close();
  }
}

// 探针：启发式登录 + dump 登录页/首页结构（输入框/按钮/表格/关键词元素）+ 截图
// 输出多行文本，供人工/AI 据此写出准确的 runRecipe 配方
async function probe(sys) {
  const browser = await launch();
  const out = [];
  const log = (s) => out.push(s);
  try {
    const page = await browser.newPage();
    await page.goto(sys.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log(`\n== 登录页 ==\nURL: ${page.url()}`);
    log(`标题: ${await page.title().catch(() => '?')}`);
    const inputs = await page.$$eval('input', (es) => es.map((e) => ({ id: e.id, name: e.name, type: e.type, ph: e.placeholder, cls: (e.className || '').toString().slice(0, 50) }))).catch(() => []);
    log(`输入框(${inputs.length}): ` + JSON.stringify(inputs));
    const btns = await page.$$eval('button, [type=submit], a', (es) => es.slice(0, 15).map((e) => ({ tag: e.tagName, id: e.id, cls: (e.className || '').toString().slice(0, 40), text: (e.innerText || '').trim().slice(0, 16) }))).catch(() => []);
    log(`按钮/链接(前15): ` + JSON.stringify(btns));
    await page.screenshot({ path: 'data/bi-probe-login.png', fullPage: true }).catch(() => {});
    log('登录页截图: data/bi-probe-login.png');

    // 启发式登录：找密码框，其前一个 input 当用户名，找提交按钮
    const pwd = await page.$('input[type=password]');
    if (pwd) {
      const all = await page.$$('input');
      let uIdx = -1;
      for (let i = 0; i < all.length; i++) if (all[i] === pwd) { uIdx = i - 1; break; }
      if (uIdx >= 0) await all[uIdx].fill(sys.username || '').catch(() => {});
      await pwd.fill(skillService.decrypt(sys.password) || '').catch(() => {});
      const submit = await page.$('button[type=submit], [type=submit]') || await page.$('button');
      if (submit) await Promise.all([page.waitForNavigation({ timeout: 30000 }).catch(() => {}), submit.click().catch(() => {})]);
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      log(`\n== 登录后 ==\nURL: ${page.url()}`);
      log(`标题: ${await page.title().catch(() => '?')}`);
      await page.screenshot({ path: 'data/bi-probe-home.png', fullPage: true }).catch(() => {});
      log('首页截图: data/bi-probe-home.png');
      const tables = await page.$$eval('table', (es) => es.slice(0, 8).map((e, i) => ({ i, rows: e.rows.length, html: e.outerHTML.replace(/\s+/g, ' ').slice(0, 600) }))).catch(() => []);
      log(`\n表格(${tables.length}): ` + JSON.stringify(tables));
      const kw = await page.$$eval('a, button, span, div, li, td, th', (es) => {
        const want = ['回款', '渠道', '完成度', '销售', '品牌', '目标', 'MTD', '占比', '差异', '已完'];
        const r = [];
        for (const e of es) {
          const t = (e.innerText || '').trim();
          if (t && t.length < 16 && want.some((w) => t.includes(w))) r.push({ tag: e.tagName, id: e.id, cls: (e.className || '').toString().slice(0, 30), text: t });
          if (r.length > 40) break;
        }
        return r;
      }).catch(() => []);
      log(`关键词元素(${kw.length}): ` + JSON.stringify(kw));
    } else {
      log('未找到密码输入框（可能已登录或非表单登录）');
    }
    return out.join('\n');
  } finally {
    await browser.close();
  }
}

// 金蝶云星空：销售出库单列表全流程
async function runKingdeeSaleList(sys, recipe) {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(sys.url, { waitUntil: 'networkidle', timeout: 60000 });

    // 1) 切到"金蝶云星空账号"选项卡
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        if ((el.innerText || '').trim() === '金蝶云星空账号' && !el.children.length) { el.click(); return; }
      }
    });
    await page.waitForTimeout(2000);

    // 2) 切数据中心到紫睿盛
    const dds = await page.$$('.k-widget.k-dropdown');
    if (dds.length >= 3) {
      await dds[2].click({ force: true });
      await page.waitForTimeout(1000);
      const items = await page.$$('.k-list-container .k-item, .k-list .k-item, .k-animation-container .k-item');
      for (const i of items) {
        if ((await i.evaluate(e => e.textContent.trim())).includes('紫睿盛')) { await i.click({ force: true }); break; }
      }
    }
    await page.waitForTimeout(3000);

    // 3) 填用户名密码
    const uf = await page.$('#user');
    if (uf) {
      await uf.click({ force: true }).catch(() => {});
      await page.keyboard.press('Control+a'); await page.keyboard.press('Delete');
      await uf.type(sys.username || '', { delay: 50 });
    }
    const pf = await page.$('#password');
    if (pf) {
      await pf.click({ force: true }).catch(() => {});
      await page.keyboard.press('Control+a'); await page.keyboard.press('Delete');
      await pf.type(skillService.decrypt(sys.password) || '', { delay: 50 });
    }

    // 4) 点登录
    await page.evaluate(() => document.querySelectorAll('.k-animation-container').forEach(e => e.remove())).catch(() => {});
    await page.click('#btnLogin', { force: true, noWaitAfter: true });
    await page.waitForTimeout(5000);

    // 5) 处理登录后的弹窗（对方下线确认 + 客户端地址变更确认，可能连续多个）
    for (let i = 0; i < 5; i++) {
      const kick = await page.evaluate(() => {
        // 找所有可见弹窗
        const dialogs = document.querySelectorAll('.k-window, .k-dialog, [class*=popup], [class*=tip]');
        for (const e of dialogs) {
          if (e.offsetParent === null) continue;
          const t = (e.innerText || '').trim();
          if (t.includes('下线') || t.includes('已登录') || t.includes('继续登录') || t.includes('地址发生改变') || t.includes('登录提示')) {
            return t.slice(0, 60);
          }
        }
        return '';
      }).catch(() => '');
      if (!kick) break;
      console.log(`[skill] 金蝶: 弹窗(${i + 1}): ${kick.slice(0, 40)}`);
      await page.evaluate(() => {
        // 点击弹窗中的确认/确定按钮
        const dialogs = document.querySelectorAll('.k-window, .k-dialog, [class*=popup], [class*=tip]');
        for (const d of dialogs) {
          if (d.offsetParent === null) continue;
          const t = (d.innerText || '').trim();
          if (t.includes('下线') || t.includes('已登录') || t.includes('继续') || t.includes('地址') || t.includes('登录提示')) {
            for (const b of d.querySelectorAll('button, .k-button, a')) {
              const bt = (b.innerText || '').trim();
              if (bt === '确认' || bt === '确定' || bt === '是' || bt === 'OK') { b.click(); return; }
            }
          }
        }
      }).catch(() => {});
      await page.waitForTimeout(5000);
    }

    // 6) 等主页加载完（菜单出现就算就绪）
    for (let i = 0; i < 10; i++) {
      const menuReady = await page.evaluate(() => {
        const t = document.body.innerText || '';
        return t.includes('销售出库单列表') || t.includes('常用功能');
      }).catch(() => false);
      if (menuReady) { console.log(`[skill] 金蝶: 主页菜单就绪`); break; }
      await page.waitForTimeout(3000);
    }

    // 7) 点"销售出库单列表"
    let menuClicked = false;
    for (let i = 0; i < 5 && !menuClicked; i++) {
      menuClicked = await page.evaluate(() => {
        for (const el of document.querySelectorAll('a, span, li, div')) {
          if ((el.innerText || '').trim() === '销售出库单列表' && !el.children.length) { el.click(); return true; }
        }
        return false;
      }).catch(() => false);
      if (!menuClicked) await page.waitForTimeout(3000);
    }
    console.log(`[skill] 金蝶: 点销售出库单列表 ${menuClicked ? '成功' : '失败'}`);
    await page.waitForTimeout(15000);

    // 8) 点"过滤"
    await page.evaluate(() => {
      const s = document.querySelector('span[id*="tbFilter"]');
      if (s) (s.closest('[class*=menuitem]') || s.parentElement)?.click();
    });
    await page.waitForTimeout(5000);

    // 9) 勾选"所有组织"
    await page.evaluate(() => {
      const w = document.querySelector('.k-window'); if (!w) return;
      for (const el of w.querySelectorAll('*')) {
        const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
        if (own === '所有组织') {
          let t = el;
          for (let i = 0; i < 5 && t; i++) {
            if (t.tagName === 'INPUT' || t.tagName === 'LABEL' || t.querySelector('input')) break;
            t = t.parentElement;
          }
          const cb = t?.querySelector('input[type=checkbox]');
          if (cb && !cb.checked) cb.click();
          else if (t?.click) t.click();
          return;
        }
      }
    });
    await page.waitForTimeout(2000);

    // 10) 点"确定"
    await page.evaluate(() => {
      const w = document.querySelector('.k-window'); if (!w) return;
      for (const b of w.querySelectorAll('button, .k-button, a')) {
        if ((b.innerText || '').trim() === '确定') { b.click(); return; }
      }
    });
    // 等数据加载（检查 k-grid-content 出现且有行，最多 60 秒）
    let rowCount = 0;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(3000);
      rowCount = await page.evaluate(() => {
        const c = document.querySelector('.k-grid-content');
        if (!c) return 0;
        const t = c.querySelector('table');
        if (!t) return 0;
        return Array.from(t.querySelectorAll('tr')).filter(tr => {
          const tds = tr.querySelectorAll('td');
          if (tds.length < 3) return false;
          for (const td of tds) { if ((td.innerText||'').trim()) return true; }
          return false;
        }).length;
      }).catch(() => 0);
      if (rowCount > 0) { console.log(`[skill] 金蝶: 数据就绪 ${rowCount} 行 (${(i+1)*3}秒)`); break; }
    }

    // 11) 抓数据（去掉第一列空序号列，从第2列开始取，与表头对齐）
    const maxCols = (recipe.extract && recipe.extract.colNames) ? recipe.extract.colNames.length : 20;
    const rows = await page.evaluate((cols) => {
      const content = document.querySelector('.k-grid-content');
      if (!content) return [];
      const table = content.querySelector('table');
      if (!table) return [];
      return Array.from(table.querySelectorAll('tr')).map(tr => {
        const tds = Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || '').trim().slice(0, 100));
        // 第一列是空序号列，跳过；取后面的列
        return tds.slice(1, 1 + cols);
      }).filter(r => r.some(c => c !== ''));
    }, maxCols).catch(() => []);

    console.log(`[skill] 金蝶云星空: 抓到 ${rows.length} 行销售出库单`);
    return JSON.stringify(rows);
  } finally {
    await browser.close();
  }
}

module.exports = { launch, runRecipe, probe };
