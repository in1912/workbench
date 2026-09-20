<template>
  <div>
    <h2 class="page-title">个人账务
      <span class="muted" style="font-size:12px; font-weight:400">支付宝账单导入 · 科目识别 · 预算管理</span>
    </h2>
    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>
    <div class="tabs">
      <button v-if="canTab('pay','dash')" :class="{active: tab==='dash'}" @click="tab='dash'">账务看板</button>
      <button v-if="canTab('pay','cats')" :class="{active: tab==='cats'}" @click="openCats">科目设置</button>
      <button v-if="canTab('pay','import')" :class="{active: tab==='import'}" @click="tab='import'">账单导入</button>
      <button v-if="canTab('pay','bills')" :class="{active: tab==='bills'}" @click="openBills">账单明细流水</button>
      <button v-if="canTab('pay','budget')" :class="{active: tab==='budget'}" @click="openBudget">月度年度预算</button>
    </div>

    <!-- ============ 账务看板 ============ -->
    <template v-if="tab==='dash'">
      <div class="row" style="margin-bottom:12px; align-items:center">
        <select v-model.number="dashYear" @change="loadDash" style="width:100px">
          <option v-for="y in yearOptions" :key="y" :value="y">{{ y }}年</option>
        </select>
        <select v-model.number="dashMonth" @change="loadDash" style="width:90px">
          <option v-for="m in 12" :key="m" :value="m">{{ m }}月</option>
        </select>
        <span class="muted" style="font-size:12px">已导入月份：{{ monthsImported.length ? monthsImported.join('、') : '无' }}</span>
      </div>
      <div class="masonry">
        <!-- 月度支出 -->
        <div class="card">
          <h3 class="fold-title" @click="fold.dash1 = !fold.dash1">月度支出 <span class="muted small">{{ natural.from }} ~ {{ natural.to }}</span><span class="fold-mark">{{ fold.dash1 ? '▸' : '▾' }}</span></h3>
          <template v-if="!fold.dash1">
            <div class="btotal">￥{{ fmt(sumOf(natural.rows)) }}</div>
            <div v-for="r in natural.rows.slice(0, 10)" :key="r.category" class="stat-row">
              <span class="stat-name">{{ r.category || '未分类' }}</span>
              <div class="stat-bar"><div class="stat-bar-in" :style="{ width: barW(r.total, natural.rows) }"></div></div>
              <span class="stat-val">{{ fmt(r.total) }}</span>
              <span class="muted" style="font-size:11px; width:44px; text-align:right">{{ r.cnt }}笔</span>
            </div>
            <div v-if="!natural.rows.length" class="empty">本月无支出数据</div>
          </template>
        </div>
        <!-- 核算月支出 -->
        <div class="card">
          <h3 class="fold-title" @click="fold.dash2 = !fold.dash2">核算月支出 <span class="muted small">{{ cycle.from }} ~ {{ cycle.to }}</span><span class="fold-mark">{{ fold.dash2 ? '▸' : '▾' }}</span></h3>
          <template v-if="!fold.dash2">
            <div class="btotal">￥{{ fmt(sumOf(cycle.rows)) }}</div>
            <div v-for="r in cycle.rows.slice(0, 10)" :key="r.category" class="stat-row">
              <span class="stat-name">{{ r.category || '未分类' }}</span>
              <div class="stat-bar"><div class="stat-bar-in" :style="{ width: barW(r.total, cycle.rows) }"></div></div>
              <span class="stat-val">{{ fmt(r.total) }}</span>
            </div>
            <div v-if="!cycle.rows.length" class="empty">无数据</div>
          </template>
        </div>
        <!-- 年度支出 -->
        <div class="card">
          <h3 class="fold-title" @click="fold.dash3 = !fold.dash3">{{ dashYear }}年度支出 <span class="badge blue">{{ yearStat.totalMonths }} 个月已导入</span><span class="fold-mark">{{ fold.dash3 ? '▸' : '▾' }}</span></h3>
          <template v-if="!fold.dash3">
            <div class="btotal">￥{{ fmt(sumOfYear()) }}</div>
            <div v-for="(v, c) in yearCats" :key="c" class="stat-row">
              <span class="stat-name">{{ c }}</span>
              <span class="stat-val">{{ fmt(v) }}</span>
            </div>
          </template>
        </div>
        <!-- 支出排行 -->
        <div class="card">
          <h3 class="fold-title" @click="fold.dash4 = !fold.dash4">支出排行<span class="fold-mark">{{ fold.dash4 ? '▸' : '▾' }}</span></h3>
          <template v-if="!fold.dash4">
            <div v-for="scope in ['month','quarter','year']" :key="scope" style="margin-bottom:10px">
              <b class="small">{{ { month: '本月', quarter: '本季度', year: '本年度' }[scope] }} TOP5</b>
              <div v-for="(r, i) in (rank[scope] || []).slice(0, 5)" :key="i" class="rank-row">
                <span class="muted">{{ i + 1 }}.</span>
                <span class="grow">{{ r.category || '未分类' }}</span>
                <span style="color:var(--red)">￥{{ fmt(r.total) }}</span>
              </div>
            </div>
          </template>
        </div>
        <!-- 支出曲线（年度逐月） -->
        <div class="card">
          <h3 class="fold-title" @click="fold.dash5 = !fold.dash5">年度支出曲线<span class="fold-mark">{{ fold.dash5 ? '▸' : '▾' }}</span></h3>
          <template v-if="!fold.dash5">
            <div class="chart">
              <div v-for="(m, i) in 12" :key="i" class="chart-col">
                <div class="chart-val small">{{ monthTotals[i] ? Math.round(monthTotals[i] / 100) / 10 + 'k' : '' }}</div>
                <div class="chart-bar" :style="{ height: barH(monthTotals[i]) }"></div>
                <div class="chart-lbl">{{ i + 1 }}月</div>
              </div>
            </div>
            <div class="muted small" style="margin-top:6px">全年合计 ￥{{ fmt(sumOfYear()) }}</div>
          </template>
        </div>
        <!-- 预算差异 -->
        <div class="card">
          <h3 class="fold-title" @click="fold.dash6 = !fold.dash6">预算差异（{{ dashMonth }}月）<span class="fold-mark">{{ fold.dash6 ? '▸' : '▾' }}</span></h3>
          <template v-if="!fold.dash6">
            <div v-for="r in budgetCmp" :key="r.category" class="stat-row">
              <span class="stat-name">{{ r.category }}</span>
              <span class="muted small">预算 {{ r.budget ? fmt(r.budget) : '—' }}</span>
              <span class="stat-val" :style="{ color: r.diff > 0 && r.budget ? 'var(--red)' : 'var(--green)' }">
                {{ r.diff > 0 ? '超 ' : '余 ' }}{{ fmt(Math.abs(r.budget ? r.diff : r.actual)) }}
              </span>
            </div>
            <div v-if="!budgetCmp.length" class="empty">本月无预算数据（到「月度年度预算」设置）</div>
          </template>
        </div>
        <!-- AI 分析 -->
        <div class="card">
          <h3 class="fold-title" @click="fold.dash7 = !fold.dash7">AI 智能分析<span class="fold-mark">{{ fold.dash7 ? '▸' : '▾' }}</span></h3>
          <template v-if="!fold.dash7">
            <div v-if="aiText" style="white-space:pre-wrap; font-size:13px; line-height:1.8">{{ aiText }}</div>
            <div v-else class="empty">分析本月支出结构与建议</div>
            <button class="primary small" style="margin-top:8px" :disabled="aiLoading" @click="runAi">{{ aiLoading ? '分析中...' : (aiText ? '重新分析' : '开始分析') }}</button>
          </template>
        </div>
      </div>
    </template>

    <!-- ============ 科目设置 ============ -->
    <template v-else-if="tab==='cats'">
      <div class="card" style="margin-bottom:12px">
        <h3>新增科目</h3>
        <div class="row" style="flex-wrap:wrap">
          <input v-model="newCat.name" placeholder="科目名（如 买菜）" style="width:140px" />
          <input v-model="newCat.keywords" placeholder="识别特征（交易对方/商品关键词，逗号分隔）" class="grow" style="min-width:240px" />
          <button class="primary" @click="addCat">添加</button>
        </div>
        <div class="muted" style="font-size:12px; margin-top:6px">导入账单时按关键词自动匹配交易对方/商品名；规则匹配不到的可在流水里用 AI 补分类。</div>
      </div>
      <!-- 固定支出 + 核算周期 -->
      <div class="grid" style="grid-template-columns:1fr 1fr; margin-bottom:12px">
        <div class="card">
          <h3>每月固定支出 <span class="muted small">修改名称/金额/启用后，点该行「存」生效</span></h3>
          <div v-for="c in fixedRows" :key="c.id" class="row" style="margin-bottom:6px; flex-wrap:wrap" :style="{ opacity: c.is_fixed ? 1 : .5 }">
            <input v-model="c.name" style="width:110px" placeholder="名称（房贷/车贷）" />
            <input v-model.number="c.fixed_amount" type="number" style="width:100px" placeholder="金额" />
            <label style="font-size:12px; display:flex; align-items:center; gap:3px; cursor:pointer">
              <input type="checkbox" v-model="c.is_fixed" style="width:auto" /> 启用
            </label>
            <span class="muted small grow">{{ (c.keywords || '').slice(0, 40) }}</span>
            <button class="small" :disabled="fixedSaving" @click="saveCat(c)">{{ fixedSaving ? '…' : '存' }}</button>
            <button class="icon-btn" @click="delCat(c)">✕</button>
          </div>
          <div v-if="!fixedRows.length" class="muted small" style="margin-bottom:6px">（尚无固定支出项）</div>
          <div class="row" style="flex-wrap:wrap; gap:8px; margin-top:8px; align-items:center">
            <button class="small" @click="addFixedRow">＋ 添加固定支出项</button>
            <span class="muted small">注入月份：</span>
            <select v-model.number="fixedInject.year" style="width:88px">
              <option v-for="y in yearOptions" :key="y" :value="y">{{ y }}年</option>
            </select>
            <select v-model.number="fixedInject.month" style="width:66px">
              <option v-for="m in 12" :key="m" :value="m">{{ m }}月</option>
            </select>
            <button class="primary small" :disabled="fixedInjecting" @click="injectFixed">{{ fixedInjecting ? '注入中...' : '注入该月流水' }}</button>
          </div>
        </div>
        <div class="card">
          <h3>核算月周期</h3>
          <div class="muted" style="font-size:12px; margin-bottom:8px">每月核算周期从几日开始（如 25 日 = 每月 25 日 ~ 次月 24 日）。默认 1 日（自然月）。</div>
          <div class="row">
            <span class="small">每月</span>
            <input v-model.number="cycleCfg.start_day" type="number" min="1" max="28" style="width:80px" />
            <span class="small">日起，至次月前一日</span>
            <button class="primary small" @click="saveCycle">保存</button>
          </div>
        </div>
      </div>
      <div class="card">
        <h3>科目列表 <span class="badge blue">{{ cats.length }}</span></h3>
        <div v-for="c in cats" :key="c.id" class="list-item">
          <div class="grow">
            <div class="t">{{ c.name }} <span v-if="c.is_fixed" class="badge amber" style="font-size:10px">固定{{ c.fixed_amount ? ' ￥' + c.fixed_amount : '' }}</span></div>
            <div class="d" style="word-break:break-all">{{ c.keywords || '（无特征词）' }}</div>
            <div class="meta">近12个月累计 ￥{{ fmt(c.total_12m || 0) }}</div>
          </div>
          <button class="icon-btn" title="编辑" @click="editCat(c)">✎</button>
          <button class="icon-btn" @click="delCat(c)">✕</button>
        </div>
      </div>
      <!-- 科目编辑弹窗 -->
      <div v-if="catEdit.show" class="modal-backdrop" @click.self="catEdit.show = false">
        <div class="modal" style="width:min(520px,92vw)">
          <h3>编辑科目</h3>
          <div class="form-row"><label>科目名</label><input v-model="catEdit.form.name" /></div>
          <div class="form-row"><label>识别特征关键词（逗号分隔，匹配交易对方/商品名）</label><textarea v-model="catEdit.form.keywords" rows="3"></textarea></div>
          <div class="form-row row">
            <label style="margin:0">每月固定支出</label>
            <input v-model="catEdit.form.is_fixed" type="checkbox" style="width:auto" />
            <input v-model.number="catEdit.form.fixed_amount" type="number" placeholder="金额" style="width:110px" />
          </div>
          <div class="row" style="justify-content:flex-end; gap:8px">
            <button class="small" @click="catEdit.show = false">取消</button>
            <button class="primary" @click="saveCatEdit">保存</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ============ 账单导入 ============ -->
    <template v-else-if="tab==='import'">
      <div class="card" style="margin-bottom:12px"
           @dragover.prevent="impDragging = true" @dragleave="impDragging = false" @drop.prevent="onImpDrop"
           :style="{ outline: impDragging ? '2px dashed var(--accent)' : '' }">
        <div style="text-align:center; padding:16px 0">
          <div style="font-size:26px">📥</div>
          <div>导入支付宝账单 CSV（原始导出格式，含单据头尾）</div>
          <div class="muted" style="font-size:12px; margin-top:4px">自动处理：跳过前 4 行单据头 · 截断 ----- 尾部 · 交易号去重 · 自动科目识别 · 只有"支出"参与统计</div>
          <button class="primary" style="margin-top:10px" @click="$refs.csvInput.click()">选择 CSV 文件</button>
          <input ref="csvInput" type="file" accept=".csv" style="display:none" multiple @change="onImpChange" />
        </div>
      </div>
      <div v-if="impResults.length" class="card">
        <h3>导入结果</h3>
        <div v-for="(r, i) in impResults" :key="i" class="list-item">
          <div class="grow">
            <div class="t">{{ r.file }}</div>
            <div class="d">解析 {{ r.parsed }} 行 · 新增 {{ r.inserted }}（支出 {{ r.expense }}）· 重复跳过 {{ r.dup }} · 待AI分类 {{ r.aiPending }}</div>
          </div>
          <span :class="['badge', r.inserted ? 'green' : '']">{{ r.inserted ? '成功' : '全部重复' }}</span>
        </div>
        <div class="row" style="margin-top:10px; flex-wrap:wrap; gap:8px">
          <button class="primary small" :disabled="aiBusy" @click="classifyAi">{{ aiBusy ? 'AI 分类中...' : '🤖 AI 补分类（未分类流水）' }}</button>
          <span class="muted small">规则识别不到的交给 AI 按科目库归类</span>
        </div>
      </div>
      <div class="card">
        <h3>训练：历史手动归类账单（xlsx）</h3>
        <div class="muted" style="font-size:12px; margin-bottom:8px">选择你在 Excel 里手动加过红字【类型】列的历史账单（sheet2 明细）。系统学习"交易对方→科目"规律，自动更新科目库的特征关键词。</div>
        <button class="primary small" @click="$refs.xlsxInput.click()">选择训练账单 xlsx（可多选）</button>
        <input ref="xlsxInput" type="file" accept=".xlsx" style="display:none" multiple @change="onTrainChange" />
        <div v-if="trainResults.length" style="margin-top:10px">
          <div v-for="(r, i) in trainResults" :key="i" class="list-item">
            <div class="grow">
              <div class="t">{{ r.file }}</div>
              <div class="d">科目 {{ r.types }} 类 · 新增科目 {{ r.catsAdded }} · 特征词 +{{ r.kwsAdded }}</div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ============ 账单明细流水 ============ -->
    <template v-else-if="tab==='bills'">
      <div class="card" style="margin-bottom:12px">
        <h3>手动补流水 <span class="muted small">金额+科目必填，商品名选填；并入主流水</span></h3>
        <div class="row" style="flex-wrap:wrap">
          <input v-model.number="manual.amount" type="number" placeholder="金额" style="width:100px" />
          <select v-model="manual.category" style="width:130px">
            <option value="">选科目</option>
            <option v-for="c in cats" :key="c.id" :value="c.name">{{ c.name }}</option>
          </select>
          <input v-model="manual.goods" placeholder="商品名称（选填）" class="grow" style="min-width:160px" />
          <input v-model="manual.date" type="date" style="width:150px" />
          <button class="primary" @click="addManual">添加</button>
        </div>
      </div>
      <div class="card" style="overflow-x:auto">
        <div class="row" style="flex-wrap:wrap; margin-bottom:10px">
          <input v-model="billQ" placeholder="搜索对方/商品/交易号..." class="grow" style="max-width:260px" @keyup.enter="loadBills(1)" />
          <select v-model="billCat" @change="loadBills(1)" style="width:120px">
            <option value="">全部科目</option>
            <option v-for="c in cats" :key="c.id" :value="c.name">{{ c.name }}</option>
            <option value="未分类">未分类</option>
          </select>
          <select v-model="billMonth" @change="loadBills(1)" style="width:120px">
            <option value="">全部月份</option>
            <option v-for="m in monthsImported" :key="m" :value="m">{{ m }}</option>
          </select>
          <select v-model="billInOut" @change="loadBills(1)" style="width:90px">
            <option value="">收+支</option>
            <option value="支出">仅支出</option>
            <option value="收入">仅收入</option>
          </select>
          <button class="small" @click="loadBills(1)">搜索</button>
          <button class="small" @click="exportCsv" title="按当前筛选导出全部字段 CSV">导出CSV</button>
        </div>
        <div v-if="!bills.length" class="empty">暂无流水（先到「账单导入」导入支付宝 CSV）</div>
        <!-- 完整字段表格：17 个原始字段 + 消费类型 -->
        <table v-if="bills.length" class="bill-table">
          <thead>
            <tr>
              <th v-for="h in BILL_COLS" :key="h.key" :title="h.title">{{ h.label }}</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in bills" :key="b.id" :style="{ opacity: b.inout === '支出' ? 1 : .62 }">
              <td v-for="h in BILL_COLS" :key="h.key" :class="h.cls || ''" :title="String(b[h.key] ?? '')">
                <template v-if="h.key === 'category'">
                  <span v-if="b.inout === '支出'" class="badge" :class="b.category === '未分类' || !b.category ? 'red' : 'blue'" style="font-size:10px; cursor:pointer" title="点击修改科目" @click="quickCat(b)">{{ b.category || '未分类' }}{{ b.category_src === 'ai' ? '·AI' : b.category_src === 'manual' ? '·手' : b.category_src === 'fixed' ? '·固' : '' }}</span>
                  <span v-else class="muted">—</span>
                </template>
                <template v-else-if="h.key === 'amount'">
                  <b :style="{ color: b.inout === '支出' ? 'var(--text)' : 'var(--green)' }">{{ b.inout === '支出' ? '' : '+' }}{{ fmt(b.amount) }}</b>
                </template>
                <template v-else>{{ b[h.key] ?? '' }}</template>
              </td>
              <td><button class="icon-btn" @click="delBill(b)">✕</button></td>
            </tr>
          </tbody>
        </table>
        <div class="row" style="justify-content:space-between; margin-top:10px">
          <span class="muted small">共 {{ billTotal }} 条 · 每页 {{ 50 }} 条 · 表格可横向滚动查看全部字段</span>
          <div class="row" style="gap:6px">
            <button class="small" :disabled="billPage <= 1" @click="loadBills(billPage - 1)">‹</button>
            <span class="small">{{ billPage }} / {{ Math.max(1, Math.ceil(billTotal / 50)) }}</span>
            <button class="small" :disabled="billPage >= Math.ceil(billTotal / 50)" @click="loadBills(billPage + 1)">›</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ============ 月度年度预算 ============ -->
    <template v-else-if="tab==='budget'">
      <div class="card" style="margin-bottom:12px">
        <h3>批量设置全年预算（{{ budgetYear }}年）</h3>
        <div class="muted small" style="margin-bottom:8px">设置一次同步所选年份 12 个月；之后可在下方单独修改某个月。</div>
        <div class="row" style="flex-wrap:wrap">
          <select v-model.number="budgetYear" @change="loadBudget" style="width:100px">
            <option v-for="y in yearOptions" :key="y" :value="y">{{ y }}年</option>
          </select>
          <select v-model="budgetForm.category" style="width:130px">
            <option value="">选科目</option>
            <option v-for="c in cats" :key="c.id" :value="c.name">{{ c.name }}</option>
          </select>
          <input v-model.number="budgetForm.amount" type="number" placeholder="每月金额" style="width:120px" />
          <button class="primary" @click="saveBudgetAll">同步全年 12 个月</button>
        </div>
      </div>
      <div class="card">
        <h3>{{ budgetYear }}年 预算明细（按月）</h3>
        <div v-for="m in 12" :key="m" style="margin-bottom:8px">
          <b class="small" style="display:inline-block; width:38px">{{ m }}月</b>
          <span v-for="b in budgetsOfMonth(m)" :key="b.id" class="badge blue" style="cursor:pointer; margin-right:4px" title="点击删除" @click="delBudget(b)">
            {{ b.category }} ￥{{ b.amount }} ✕
          </span>
          <span class="muted small">合计 ￥{{ fmt(sumBudget(m)) }}</span>
        </div>
        <div style="border-top:1px solid var(--border); margin-top:10px; padding-top:10px">
          <b class="small">单月修改：</b>
          <div class="row" style="flex-wrap:wrap; margin-top:6px">
            <select v-model.number="singleForm.month" style="width:80px">
              <option v-for="m in 12" :key="m" :value="m">{{ m }}月</option>
            </select>
            <select v-model="singleForm.category" style="width:130px">
              <option value="">选科目</option>
              <option v-for="c in cats" :key="c.id" :value="c.name">{{ c.name }}</option>
            </select>
            <input v-model.number="singleForm.amount" type="number" placeholder="金额" style="width:110px" />
            <button class="small" @click="saveBudgetSingle">保存该月</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { canTab, firstTab } from '../tabs';

const tab = ref(firstTab('pay', 'dash'));
const msg = ref('');
const msgType = ref('ok');
function flash(text, type = 'ok') { msg.value = text; msgType.value = type; setTimeout(() => (msg.value = ''), 4000); }
function fmt(n) { return (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
const yearOptions = [new Date().getFullYear() + 1, new Date().getFullYear(), new Date().getFullYear() - 1, new Date().getFullYear() - 2];

// ---------- 看板 ----------
const fold = ref({ dash1: false, dash2: false, dash3: false, dash4: false, dash5: false, dash6: false, dash7: false });
const dashYear = ref(new Date().getFullYear());
const dashMonth = ref(new Date().getMonth() + 1);
const natural = ref({ from: '', to: '', rows: [] });
const cycle = ref({ from: '', to: '', rows: [] });
const yearStat = ref({ months: {}, byCategory: {}, totalMonths: 0 });
const monthsImported = ref([]);
const rank = ref({});
const budgetCmp = ref([]);
const aiText = ref('');
const aiLoading = ref(false);

const yearCats = computed(() => Object.entries(yearStat.value.byCategory || {}).sort((a, b) => b[1] - a[1]).slice(0, 12));
const monthTotals = computed(() => {
  const arr = Array(12).fill(0);
  for (const [ym, list] of Object.entries(yearStat.value.months || {})) {
    const m = Number(ym.slice(5));
    if (m >= 1 && m <= 12) arr[m - 1] = list.reduce((s, r) => s + r.total, 0);
  }
  return arr;
});
function sumOf(rows) { return (rows || []).reduce((s, r) => s + r.total, 0); }
function sumOfYear() { return Object.values(yearStat.value.byCategory || {}).reduce((s, v) => s + v, 0); }
function barW(v, rows) {
  const max = Math.max(...(rows || []).map((r) => r.total), 1);
  return Math.min(100, (v / max) * 100) + '%';
}
function barH(v) {
  const max = Math.max(...monthTotals.value, 1);
  return Math.max(2, (v / max) * 90) + 'px';
}

async function loadDash() {
  try {
    const d = await api.get(`/pay/dashboard?year=${dashYear.value}&month=${dashMonth.value}`);
    natural.value = d.naturalMonth;
    cycle.value = d.cycleMonth;
    yearStat.value = d.year;
    monthsImported.value = d.monthsImported || [];
    const r = await api.get(`/pay/rank?year=${dashYear.value}`);
    rank.value = r;
    const b = await api.get(`/pay/budget-compare?year=${dashYear.value}&month=${dashMonth.value}`);
    budgetCmp.value = b.rows || [];
  } catch (e) { flash(e.message, 'err'); }
}
async function runAi() {
  aiLoading.value = true;
  try {
    const r = await api.post('/pay/ai-analysis', { year: dashYear.value, month: dashMonth.value });
    aiText.value = r.content;
  } catch (e) { flash('AI 分析失败：' + e.message, 'err'); }
  finally { aiLoading.value = false; }
}

// ---------- 科目 ----------
const cats = ref([]);
const newCat = ref({ name: '', keywords: '' });
const fixedRows = ref([]);
const cycleCfg = ref({ start_day: 1 });
const catEdit = ref({ show: false, id: 0, form: { name: '', keywords: '', is_fixed: 0, fixed_amount: 0 } });

async function openCats() {
  tab.value = 'cats';
  await loadCats();
}
async function loadCats() {
  try {
    cats.value = await api.get('/pay/categories');
    // 固定支出区：纯服务端数据（is_fixed 科目）。编辑中的未保存新行（id<0）只在"添加"时留在本地，
    // 保存成功后由 saveCat 从列表移除——避免"服务端回来的新科目 + 本地编辑行"重复显示
    fixedRows.value = cats.value.filter((c) => c.is_fixed);
    cycleCfg.value = await api.get('/pay/cycle');
  } catch (e) { flash(e.message, 'err'); }
}
async function addCat() {
  if (!newCat.value.name.trim()) return;
  try {
    await api.post('/pay/categories', newCat.value);
    newCat.value = { name: '', keywords: '' };
    await loadCats();
    flash('科目已添加');
  } catch (e) { flash(e.message, 'err'); }
}
function editCat(c) {
  catEdit.value = { show: true, id: c.id, form: { name: c.name, keywords: c.keywords || '', is_fixed: !!c.is_fixed, fixed_amount: c.fixed_amount || 0 } };
}
async function saveCatEdit() {
  try {
    await api.put(`/pay/categories/${catEdit.value.id}`, catEdit.value.form);
    catEdit.value.show = false;
    await loadCats();
    flash('科目已保存');
  } catch (e) { flash(e.message, 'err'); }
}
const fixedSaving = ref(false);
const fixedInjecting = ref(false);
const fixedInject = ref({ year: new Date().getFullYear(), month: new Date().getMonth() + 1 });
async function saveCat(c) {
  if (!String(c.name || '').trim()) { flash('名称不能为空', 'err'); return; }
  fixedSaving.value = true;
  try {
    if (c.id > 0) {
      // 已有科目：更新（含固定支出设置）
      await api.put(`/pay/categories/${c.id}`, { name: c.name, keywords: c.keywords, is_fixed: c.is_fixed ? 1 : 0, fixed_amount: c.fixed_amount || 0, note: c.note });
    } else {
      // 新增行：创建科目 → 写固定设置 → 从本地编辑列表移除（loadCats 会带回正式数据）
      const r = await api.post('/pay/categories', { name: c.name, keywords: c.keywords || '' });
      await api.put(`/pay/categories/${r.id}`, { is_fixed: c.is_fixed ? 1 : 0, fixed_amount: c.fixed_amount || 0 });
      const idx = fixedRows.value.findIndex((x) => x.id === c.id);
      if (idx >= 0 && !c.is_fixed && !c.fixed_amount) fixedRows.value.splice(idx, 1); // 没勾启用也没金额：不当固定项
    }
    flash('已保存');
    await loadCats();
  } catch (e) { flash('保存失败：' + e.message, 'err'); }
  finally { fixedSaving.value = false; }
}
async function delCat(c) {
  if (!confirm(`删除科目「${c.name}」？流水记录保留（科目名留在流水里）。`)) return;
  await api.del(`/pay/categories/${c.id}`);
  await loadCats();
}
function addFixedRow() {
  fixedRows.value.push({ id: -Date.now(), name: '', fixed_amount: 0, is_fixed: 1, keywords: '' });
}
async function injectFixed() {
  fixedInjecting.value = true;
  try {
    const r = await api.post('/pay/fixed/inject', { year: fixedInject.value.year, month: fixedInject.value.month });
    const ym = `${fixedInject.value.year}-${String(fixedInject.value.month).padStart(2, '0')}`;
    flash(r.added ? `已注入 ${r.added} 条固定支出到 ${ym}` : `${ym} 已有全部固定支出（或无启用的固定项）`);
  } catch (e) { flash(e.message, 'err'); }
  finally { fixedInjecting.value = false; }
}
async function saveCycle() {
  try {
    await api.post('/pay/cycle', cycleCfg.value);
    flash('核算周期已保存');
  } catch (e) { flash(e.message, 'err'); }
}

// ---------- 导入 ----------
const impDragging = ref(false);
const impResults = ref([]);
const trainResults = ref([]);
const aiBusy = ref(false);

async function uploadCsv(file) {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch('/api/pay/import', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + (localStorage.getItem('wb_token') || '') },
    body: fd,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `导入失败 (${r.status})`);
  return d;
}
async function onImpChange(e) {
  // 先把 FileList 快照成数组：它是绑定 input 的活对象，清空 value 会连带清空它，循环就一次都不执行
  const list = [...(e.target.files || [])];
  e.target.value = '';
  if (!list.length) return;
  for (const f of list) {
    try {
      const d = await uploadCsv(f);
      impResults.value.unshift({ file: f.name, ...d });
    } catch (err) {
      impResults.value.unshift({ file: f.name, parsed: 0, inserted: 0, dup: 0, expense: 0, aiPending: 0, error: err.message });
      flash(`「${f.name}」导入失败：${err.message}`, 'err');
    }
  }
  loadDash();
}
async function onImpDrop(e) {
  impDragging.value = false;
  const list = e.dataTransfer.files;
  if (!list) return;
  for (const f of list) {
    if (!/\.csv$/i.test(f.name)) continue;
    try {
      const d = await uploadCsv(f);
      impResults.value.unshift({ file: f.name, ...d });
    } catch (err) { flash(`「${f.name}」导入失败：${err.message}`, 'err'); }
  }
  loadDash();
}
async function classifyAi() {
  aiBusy.value = true;
  try {
    const r = await api.post('/pay/classify-ai', {});
    flash(`AI 已分类 ${r.classified} 条（共 ${r.groups} 组）`);
    loadDash();
  } catch (e) { flash('AI 分类失败：' + e.message, 'err'); }
  finally { aiBusy.value = false; }
}
// 训练 xlsx：前端解析 sheet2 明细（金额后一列是类型），POST /pay/train
async function onTrainChange(e) {
  const list = [...(e.target.files || [])]; // 同 onImpChange：先快照再清空
  e.target.value = '';
  if (!list.length) return;
  for (const f of list) {
    try {
      const rows = await parseXlsxDetail(f);
      const r = await api.post('/pay/train', { rows });
      trainResults.value.unshift({ file: f.name, ...r });
      flash(`「${f.name}」训练完成：${r.types} 类科目`);
    } catch (err) {
      flash(`「${f.name}」训练失败：${err.message}`, 'err');
    }
  }
  loadCats();
}
// 极简 xlsx 解析（浏览器端）：sheet2 明细行 [{type, counterparty, goods, amount}]
async function parseXlsxDetail(file) {
  const ZIP = await import('../lib/zipParser.js');
  const buf = new Uint8Array(await file.arrayBuffer());
  let files = await ZIP.unzipAsync(buf);
  // 在所有 sheet 里找明细表（首行含"交易号"）；有的文件明细在 sheet1（无透视表），有的在 sheet2
  const dec = new TextDecoder('utf-8');
  const sst = [];
  const sstXml = files.get('xl/sharedStrings.xml');
  if (sstXml) {
    const xml = dec.decode(sstXml);
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const ts = [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]);
      sst.push(ts.join(''));
    }
  }
  const readCells = (xml) => {
    const rows = [];
    for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cm of rm[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cm[1], inner = cm[2];
        const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
        const tm = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        let val = tm ? tm[1] : (vm ? vm[1] : '');
        if (/t="s"/.test(attrs) && vm) val = sst[Number(vm[1])] ?? '';
        cells.push(val);
      }
      rows.push(cells);
    }
    return rows;
  };
  let rows = null;
  for (const sheetName of [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()) {
    const r = readCells(dec.decode(files.get(sheetName)));
    const hi = r.findIndex((x) => x.some((c) => String(c).includes('交易号')));
    if (hi >= 0) { rows = r; break; }
  }
  if (!rows) throw new Error('xlsx 内未找到含"交易号"表头的工作表');
  // 表头行位置：金额列 idx9、类型列 idx10（金额后一列）、对方 idx7、商品 idx8、来源 idx5
  let hi = rows.findIndex((r) => r.some((c) => String(c).includes('交易号')));
  if (hi < 0) throw new Error('未找到表头（需为支付宝明细 sheet）');
  const out = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0] || !String(r[0]).trim().startsWith('2')) continue;
    out.push({
      type: String(r[10] || '').trim(),
      counterparty: String(r[7] || '').trim(),
      goods: String(r[8] || '').trim(),
      source: String(r[5] || '').trim(),
      amount: Number(r[9]) || 0,
    });
  }
  if (!out.length) throw new Error('未解析到明细行');
  return out;
}

// ---------- 流水 ----------
// 全部原始字段（与支付宝导出表头一一对应）+ 消费类型；供分析特征词与去重核对
const BILL_COLS = [
  { key: 'trade_no', label: '交易号', title: '唯一流水号（去重依据）', cls: 'mono' },
  { key: 'merchant_no', label: '商家订单号', cls: 'mono' },
  { key: 'create_time', label: '交易创建时间' },
  { key: 'pay_time', label: '付款时间' },
  { key: 'modify_time', label: '最近修改时间' },
  { key: 'source', label: '交易来源地' },
  { key: 'tx_type', label: '类型' },
  { key: 'counterparty', label: '交易对方' },
  { key: 'goods', label: '商品名称' },
  { key: 'amount', label: '金额（元）', cls: 'num' },
  { key: 'inout', label: '收/支' },
  { key: 'status', label: '交易状态' },
  { key: 'fee', label: '服务费（元）', cls: 'num' },
  { key: 'refund', label: '成功退款（元）', cls: 'num' },
  { key: 'remark', label: '备注' },
  { key: 'fund_status', label: '资金状态' },
  { key: 'category', label: '消费类型' },
];
const bills = ref([]);
const billQ = ref('');
const billCat = ref('');
const billMonth = ref('');
const billInOut = ref('');
const billPage = ref(1);
const billTotal = ref(0);
const manual = ref({ amount: null, category: '', goods: '', date: new Date().toISOString().slice(0, 10) });

async function openBills() {
  tab.value = 'bills';
  // 科目列表用于筛选下拉；无「科目设置」tab 权限时静默降级为空（403 不能变成未捕获异常）
  if (!cats.value.length) { try { cats.value = await api.get('/pay/categories'); } catch { cats.value = []; } }
  await loadBills(1);
}
async function loadBills(p = 1) {
  billPage.value = p;
  const qs = new URLSearchParams({ page: p, pageSize: 50 });
  if (billQ.value) qs.set('q', billQ.value);
  if (billCat.value) qs.set('category', billCat.value);
  if (billMonth.value) qs.set('month', billMonth.value);
  if (billInOut.value) qs.set('inout', billInOut.value);
  try {
    const d = await api.get('/pay/bills?' + qs.toString());
    bills.value = d.bills || [];
    billTotal.value = d.total || 0;
  } catch (e) { flash(e.message, 'err'); }
}
async function addManual() {
  if (!manual.value.amount || !manual.value.category) { flash('金额和科目必填', 'err'); return; }
  try {
    await api.post('/pay/bills', manual.value);
    manual.value = { amount: null, category: '', goods: '', date: new Date().toISOString().slice(0, 10) };
    flash('流水已添加');
    await loadBills(1);
  } catch (e) { flash(e.message, 'err'); }
}
async function delBill(b) {
  if (!confirm('删除该流水？')) return;
  await api.del(`/pay/bills/${b.id}`);
  await loadBills(billPage.value);
}
function quickCat(b) {
  const name = prompt(`修改「${(b.goods || b.counterparty || '').slice(0, 20)}」的科目：`, b.category || '');
  if (name === null) return;
  api.put(`/pay/bills/${b.id}/category`, { category: name.trim() }).then(() => { b.category = name.trim(); b.category_src = 'manual'; });
}
// 按当前筛选导出全部字段 CSV（含 17 原始字段+消费类型）
async function exportCsv() {
  const qs = new URLSearchParams();
  if (billQ.value) qs.set('q', billQ.value);
  if (billCat.value) qs.set('category', billCat.value);
  if (billMonth.value) qs.set('month', billMonth.value);
  if (billInOut.value) qs.set('inout', billInOut.value);
  qs.set('pageSize', '100000');
  try {
    const d = await api.get('/pay/bills?' + qs.toString());
    const cols = BILL_COLS;
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [cols.map((c) => esc(c.label)).join(',')];
    for (const b of d.bills || []) lines.push(cols.map((c) => esc(b[c.key])).join(','));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `账单流水_${billMonth.value || '全部'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    flash(`已导出 ${(d.bills || []).length} 条`);
  } catch (e) { flash('导出失败：' + e.message, 'err'); }
}

// ---------- 预算 ----------
const budgetYear = ref(new Date().getFullYear());
const budgets = ref([]);
const budgetForm = ref({ category: '', amount: null });
const singleForm = ref({ month: new Date().getMonth() + 1, category: '', amount: null });

async function openBudget() {
  tab.value = 'budget';
  // 同 openBills：无「科目设置」tab 权限时 403 静默降级（预算表单科目下拉为空即可）
  if (!cats.value.length) { try { cats.value = await api.get('/pay/categories'); } catch { cats.value = []; } }
  await loadBudget();
}
async function loadBudget() {
  try {
    const d = await api.get(`/pay/budgets?year=${budgetYear.value}`);
    budgets.value = d.budgets || [];
  } catch (e) { flash(e.message, 'err'); }
}
function budgetsOfMonth(m) { return budgets.value.filter((b) => b.month === m); }
function sumBudget(m) { return budgetsOfMonth(m).reduce((s, b) => s + b.amount, 0); }
async function saveBudgetAll() {
  if (!budgetForm.value.category || !budgetForm.value.amount) { flash('科目和金额必填', 'err'); return; }
  try {
    await api.post('/pay/budgets', { year: budgetYear.value, category: budgetForm.value.category, amount: budgetForm.value.amount, all: true });
    flash(`已同步 ${budgetYear.value} 年 12 个月的「${budgetForm.value.category}」预算`);
    await loadBudget();
  } catch (e) { flash(e.message, 'err'); }
}
async function saveBudgetSingle() {
  if (!singleForm.value.category) { flash('选科目', 'err'); return; }
  try {
    await api.post('/pay/budgets', { year: budgetYear.value, month: singleForm.value.month, category: singleForm.value.category, amount: singleForm.value.amount || 0 });
    flash(`已保存 ${singleForm.value.month} 月预算`);
    await loadBudget();
  } catch (e) { flash(e.message, 'err'); }
}
async function delBudget(b) {
  if (!confirm(`删除 ${b.month}月「${b.category}」预算？`)) return;
  await api.del(`/pay/budgets/${b.id}`);
  await loadBudget();
}

onMounted(() => {
  // 无账务看板 tab 权限时按初始 tab 加载对应数据（各 tab 按钮均隐藏，避免 403）
  if (tab.value === 'dash') loadDash();
  else if (tab.value === 'cats') openCats();
  else if (tab.value === 'bills') openBills();
  else if (tab.value === 'budget') openBudget();
});
</script>

<style scoped>
.fold-title { cursor: pointer; user-select: none; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.fold-title .grow, .fold-title span:first-child { flex: 1; }
.fold-mark { color: var(--text3); font-size: 11px; }
.btotal { font-size: 22px; font-weight: 700; margin-bottom: 10px; }
.stat-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 12.5px; }
.stat-name { width: 64px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stat-bar { flex: 1; height: 8px; background: var(--bg3); border-radius: 4px; overflow: hidden; }
.stat-bar-in { height: 100%; background: var(--accent); border-radius: 4px; }
.stat-val { width: 88px; text-align: right; flex-shrink: 0; }
.rank-row { display: flex; gap: 6px; font-size: 12.5px; padding: 3px 0; border-bottom: 1px dashed var(--border); }
.chart { display: flex; align-items: flex-end; gap: 4px; height: 120px; padding-top: 14px; }
.chart-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
.chart-bar { width: 70%; background: linear-gradient(180deg, var(--accent), rgba(79,124,247,.4)); border-radius: 3px 3px 0 0; }
.chart-lbl { font-size: 10px; color: var(--text3); margin-top: 3px; }
.chart-val { font-size: 9px; color: var(--text3); height: 12px; }
/* 完整字段流水表格 */
.bill-table { width: 100%; border-collapse: collapse; font-size: 11.5px; min-width: 2100px; }
.bill-table th { position: sticky; top: 0; background: var(--bg3); color: var(--text2); font-weight: 600; text-align: left; padding: 6px 8px; white-space: nowrap; border-bottom: 1px solid var(--border); }
.bill-table td { padding: 5px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; color: var(--text2); }
.bill-table tr:hover td { background: var(--bg3); }
.bill-table td.mono { font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; }
.bill-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
@media (max-width: 900px) { .grid[style] { grid-template-columns: 1fr !important; } }
</style>
