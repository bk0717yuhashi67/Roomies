/* ============================================================
   合租生活管家 · 应用逻辑
   阶段〇~四：数据层加固 / 状态机校验 / 无障碍 / 功能补全
   ------------------------------------------------------------
   设计约束（不可退让）：
   ① 最终产物是单文件 index.html，本文件只是可维护的源码形态
   ② 金额一律以「整数分」存储与计算，只在渲染时转元
   ③ 任何写操作必须先过状态校验，非法迁移一律拒绝并给出原因
   ④ 数据异常绝不静默重置：先备份、再提示、由用户决定
   ============================================================ */
(function () {
'use strict';

/* ============================================================
   0 · 常量与基础工具
   ============================================================ */
let KEY = 'roomies_data_guest';   // 每个账号一份数据空间，登录后由 UI 层重设为 roomies_data_<id>
const BAK = 'roomies_backup';      // 损坏数据原始副本的键前缀
const SCHEMA = 2;                  // 数据结构版本
const CONFIRM_HOURS = 72;          // 账单确认时限：超时视为默认通过
const GRACE_DAYS = 3;              // 补打窗口：只允许补打近 N 天的任务
const SNOOZE_H = 24;               // 同一事务 24 小时内不重复提醒

const AREAS = [
  { name: '卫生间', list: ['地漏滤网', '台面水渍', '马桶', '垃圾清运'] },
  { name: '厨房', list: ['灶台油污', '水槽滤网', '台面', '垃圾桶'] },
  { name: '客厅与地面', list: ['地面清扫', '茶几整理', '沙发缝隙'] },
  { name: '垃圾清运', list: ['厨余垃圾', '可回收物', '更换垃圾袋'] }
];

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = p => (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const dcn = ds => { const p = String(ds || '').split('-'); return p.length === 3 ? Number(p[1]) + '月' + Number(p[2]) + '日' : '待定'; };
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const nowHM = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const todayStr = () => ymd(new Date());
const timeTag = () => { const d = new Date(); return dcn(ymd(d)) + ' ' + nowHM(); };
const daysBetween = (a, b) => Math.round((new Date(b.replace(/-/g, '/')) - new Date(a.replace(/-/g, '/'))) / 86400000);

/* 业务异常：可被 UI 捕获并友好提示，而不是让页面崩掉 */
function BizError(msg) { const e = new Error(msg); e.name = 'BizError'; return e; }

/* ---- 金额：内部一律整数分，只有这两处允许换算 ---- */
const fen = y => { const n = Number(y); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const yuan = f => (Number(f) || 0) / 100;
const fmt = f => '¥' + yuan(f).toFixed(2);

/* ============================================================
   1 · 数据层：seed / 迁移 / 校验 / 持久化
   ============================================================ */
let S = null;
let REPAIRS = [];      // 本次加载自动修复的记录（用于告知用户，绝不静默）

function seed() {
  const ds = todayStr();
  const members = [
    { id: 'm1', name: '小林', room: '主卧', weight: 1.2, joinedAt: ds },
    { id: 'm2', name: '小周', room: '次卧', weight: 1.0, joinedAt: ds },
    { id: 'm3', name: '小陈', room: '小卧', weight: 0.8, joinedAt: ds }
  ];
  const ids = members.map(m => m.id);
  const b1shares = splitEven(fen(286.40), ids, 'm1');
  const b2shares = splitEven(fen(120.00), ids, 'm2');
  const now = Date.now();
  return {
    schemaVersion: SCHEMA,
    house: { name: '安心小屋' },
    pactVersion: 'v1.2',
    me: 'm3',
    members,
    bills: [
      {
        id: 'b1', title: '电费 2026-09', category: '水电', amount: fen(286.40), payerId: 'm1', rule: 'even',
        participants: ids.slice(), weightSnapshot: { m1: 1.2, m2: 1.0, m3: 0.8 },
        shares: b1shares, confirm: { m1: 'ok', m2: 'ok', m3: 'pending' },
        status: 'confirming', date: ds, period: ds.slice(0, 7), version: 1,
        dueAt: now + CONFIRM_HOURS * 3600000, note: '抄表 1842 → 2214 kWh',
        meter: { prev: 1842, curr: 2214, unit: 'kWh', price: fen(0.538) },
        history: [{ version: 1, at: now, by: 'm1', what: '创建账单' }]
      },
      {
        id: 'b2', title: '宽带 2026-09', category: '网费', amount: fen(120.00), payerId: 'm2', rule: 'even',
        participants: ids.slice(), weightSnapshot: { m1: 1.2, m2: 1.0, m3: 0.8 },
        shares: b2shares, confirm: { m1: 'ok', m2: 'ok', m3: 'ok' },
        status: 'settled', date: ds, period: ds.slice(0, 7), version: 1, dueAt: null,
        note: '9 月 12 日已结清', meter: null,
        history: [{ version: 1, at: now, by: 'm2', what: '创建账单' }, { version: 1, at: now, by: 'm1', what: '全部结清' }]
      }
    ],
    transfers: [],
    tasks: [],
    swaps: [],
    items: [
      { id: 'i1', name: '抽纸', category: '消耗品', stock: 0, safety: 2, restockQty: 6, unit: '包', days: 0, purchaserId: 'm2', scope: 'all', location: '客厅柜' },
      { id: 'i2', name: '垃圾袋', category: '消耗品', stock: 36, safety: 10, restockQty: 60, unit: '只', days: 24, purchaserId: 'm3', scope: 'all', location: '厨房柜' },
      { id: 'i3', name: '洗洁精', category: '消耗品', stock: 1, safety: 2, restockQty: 3, unit: '瓶', days: 5, purchaserId: 'm1', scope: 'all', location: '水槽下' },
      { id: 'i4', name: '吸尘器', category: '共享设备', stock: 1, safety: 0, restockQty: 1, unit: '台', days: 0, purchaserId: null, scope: 'all', location: '阳台',
        borrow: { by: 'm3', due: '今晚 20:00' } }
    ],
    restocks: [],
    scoreLog: [
      { id: 'sc1', memberId: 'm2', delta: 10, reason: '完成值日「厨房」', at: Date.now() - 86400000 },
      { id: 'sc2', memberId: 'm1', delta: 8, reason: '认领公共采购「洗洁精」', at: Date.now() - 172800000 }
    ],
    voucher: {},   // memberId -> 本季度已用豁免券数量
    pacts: [
      { id: 'p1', text: '房租、水电、燃气按人头均摊', category: '费用与分摊', binding: 'M1 · 账单默认分摊方式', enforceable: true, rule: { type: 'split', value: 'even' } },
      { id: 'p2', text: '垃圾每日 22:00 前清运', category: '卫生与清洁', binding: 'M2 · 自动生成日频任务', enforceable: true, rule: { type: 'shift', area: '垃圾清运' } },
      { id: 'p3', text: '公共消耗品保持 1 件安全库存', category: '公共物品', binding: 'M3 · 补货提醒阈值', enforceable: true, rule: { type: 'stock', value: 1 } },
      { id: 'p4', text: '账单确认时限 72 小时，超时视为通过', category: '费用与分摊', binding: 'M1 · 自动确认时限', enforceable: true, rule: { type: 'confirm', hours: CONFIRM_HOURS } },
      { id: 'p5', text: '安静时段 23:00–08:00，不弹横幅', category: '作息与噪音', binding: 'M5 · 该时段仅站内通知', enforceable: true, rule: { type: 'quiet', from: 23, to: 8 } },
      { id: 'p6', text: '马桶圈用完放下', category: '卫生与清洁', binding: '仅靠自觉，系统无法约束', enforceable: false, rule: null }
    ],
    votes: [
      { id: 'v1', text: '夏天空调统一设定为 26℃', support: ['m1', 'm2'], against: [], deadline: '2 天后截止', deadlineAt: Date.now() + 2 * 86400000, threshold: 2, closed: false, anonymous: false }
    ]
  };
}

/* ---- 迁移：从任意旧版本逐级升到 SCHEMA ---- */
/* v1 → v2：金额「元(浮点)」→「分(整数)」，并补齐缺失字段。
   原则：只加字段、只做无损换算，绝不改写语义。 */
const MIGRATIONS = {
  1: s => {
    const mid = (s.members || []).map(m => m.id);
    (s.bills || []).forEach(b => {
      b.amount = fen(b.amount);
      const sh = {};
      Object.keys(b.shares || {}).forEach(k => sh[k] = fen(b.shares[k]));
      b.shares = sh;
      b.participants = b.participants || mid.slice();
      b.period = b.period || String(b.date || '').slice(0, 7);
      b.dueAt = b.dueAt || null;
      b.history = b.history || [{ version: b.version || 1, at: Date.now(), by: b.payerId, what: '由旧版本数据迁移' }];
      b.meter = b.meter || null;
      b.weightSnapshot = b.weightSnapshot || (s.members || []).reduce((a, m) => (a[m.id] = m.weight, a), {});
    });
    (s.transfers || []).forEach(t => {
      t.amount = fen(t.amount);
      t.allocations = t.allocations || [];
      t.status = t.status || (t.receivedAt ? 'received' : 'pending');
    });
    (s.items || []).forEach(i => {
      i.restockQty = i.restockQty || (i.safety ? i.safety * 3 : 1);
      i.scope = i.scope || 'all';
    });
    s.restocks = s.restocks || [];
    s.scoreLog = s.scoreLog || [];
    s.voucher = s.voucher || {};
    (s.pacts || []).forEach(p => { if (p.rule === undefined) p.rule = null; });
    (s.votes || []).forEach(v => { v.closed = !!v.closed; v.deadlineAt = v.deadlineAt || Date.now(); });
    s.schemaVersion = 2;
    return s;
  }
};

function migrate(state) {
  let v = Number(state.schemaVersion) || 1;
  let guard = 0;
  while (v < SCHEMA) {
    const fn = MIGRATIONS[v];
    if (!fn) throw new Error('缺少 v' + v + ' 的迁移函数');
    state = fn(state);
    v = Number(state.schemaVersion);
    if (++guard > 20) throw new Error('迁移出现循环');
  }
  return state;
}

/* ---- 校验与修复：所有自动修复都记入 REPAIRS，绝不静默 ---- */
function validateState(s) {
  const fix = m => REPAIRS.push(m);
  if (!s || typeof s !== 'object') { fix('数据结构不是对象，已重建'); return null; }
  if (!Array.isArray(s.members)) { s.members = []; fix('成员列表损坏，已重置为空'); }
  if (!Array.isArray(s.bills)) { s.bills = []; fix('账单列表损坏，已重置为空'); }
  ['transfers', 'tasks', 'swaps', 'items', 'restocks', 'scoreLog', 'pacts', 'votes'].forEach(k => {
    if (!Array.isArray(s[k])) { s[k] = []; fix('「' + k + '」损坏，已重置为空'); }
  });
  if (!s.house || typeof s.house !== 'object') { s.house = { name: '我的合租屋' }; fix('房屋信息缺失，已补默认值'); }
  if (!s.voucher || typeof s.voucher !== 'object') s.voucher = {};
  if (!s.schemaVersion) s.schemaVersion = SCHEMA;

  const ids = s.members.map(m => m.id);
  if (ids.indexOf(s.me) < 0) { s.me = ids[0] || ''; }

  /* 金额：负值归零；份额与总额不一致时按总额重算，并记录 */
  s.bills.forEach(b => {
    if (!Number.isFinite(b.amount) || b.amount < 0) { b.amount = 0; fix('账单「' + b.title + '」金额非法，已归零'); }
    if (!b.shares || typeof b.shares !== 'object') b.shares = {};
    let sum = 0;
    (b.participants || ids).forEach(id => {
      let v = b.shares[id];
      if (!Number.isFinite(v) || v < 0) { v = 0; fix('账单「' + b.title + '」中某成员份额非法，已归零'); }
      b.shares[id] = v; sum += v;
    });
    if (sum !== b.amount && b.status !== 'settled') {
      b.shares = splitEven(b.amount, b.participants && b.participants.length ? b.participants : ids, b.payerId);
      fix('账单「' + b.title + '」份额之和不等于总额，已按总额重算');
    }
    if (!b.confirm || typeof b.confirm !== 'object') b.confirm = {};
    (b.participants || ids).forEach(id => { if (['pending', 'ok', 'dispute'].indexOf(b.confirm[id]) < 0) b.confirm[id] = 'pending'; });
  });

  /* 任务：日期格式与状态 */
  s.tasks.forEach(t => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date || '')) { t.date = todayStr(); fix('存在日期格式异常的值日任务，已改为今天'); }
    if (['pending', 'done', 'skipped', 'exempt'].indexOf(t.status) < 0) { t.status = 'pending'; fix('任务状态非法，已改为待办'); }
    if (!Array.isArray(t.checklist)) t.checklist = [];
  });

  /* 物品：库存为负归零 */
  s.items.forEach(i => {
    if (!Number.isFinite(i.stock) || i.stock < 0) { i.stock = 0; fix('物品「' + i.name + '」库存为负，已归零'); }
    if (!Number.isFinite(i.safety) || i.safety < 0) i.safety = 0;
    if (!Number.isFinite(i.restockQty) || i.restockQty <= 0) i.restockQty = Math.max(1, (i.safety || 1) * 3);
  });

  /* 转账：状态与分配 */
  s.transfers.forEach(t => {
    if (!Array.isArray(t.allocations)) t.allocations = [];
    if (!t.status) t.status = t.receivedAt ? 'received' : 'pending';
  });

  return s;
}

/* ---- 持久化 ---- */
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(S));
    return { ok: true };
  } catch (e) {
    const quota = /quota|exceed/i.test(String(e && e.name) + String(e && e.message));
    toast(quota ? '存储空间不足，请先导出备份并清理' : '本次改动未能保存（浏览器禁用了本地存储）');
    return { ok: false, err: e };
  }
}

function load() {
  REPAIRS = [];
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch (e) { STORAGE_OK = false; }
  if (!raw) { S = seed(); return { fresh: true }; }

  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }

  if (!parsed || typeof parsed !== 'object') {
    /* 数据损坏：备份原始串，交给用户决定，绝不静默重置 */
    try { localStorage.setItem(BAK + '_' + Date.now(), raw); } catch (e) { /* 备份失败也要继续 */ }
    STORAGE_BROKEN = raw;
    S = seed();
    return { broken: true };
  }

  try { parsed = migrate(parsed); }
  catch (e) {
    try { localStorage.setItem(BAK + '_' + Date.now(), raw); } catch (e2) { /* ignore */ }
    STORAGE_BROKEN = raw;
    S = seed();
    return { broken: true, reason: e.message };
  }

  const fromVersion = Number(parsed.schemaVersion);
  parsed = validateState(parsed) || seed();
  S = parsed;
  return { migrated: fromVersion < SCHEMA, fromVersion, repairs: REPAIRS.slice() };
}

let STORAGE_OK = true;
let STORAGE_BROKEN = null;

/* ---- 导出 / 导入 ---- */
function exportText() { return JSON.stringify(S, null, 2); }

function download(filename, text, mime) {
  try {
    const blob = new Blob([text], { type: mime || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    return true;
  } catch (e) { return false; }
}

function importText(text) {
  let obj = null;
  try { obj = JSON.parse(text); } catch (e) { throw BizError('内容不是合法的 JSON'); }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.members) || !Array.isArray(obj.bills)) {
    throw BizError('文件结构不对：缺少 members 或 bills');
  }
  const cur = Number(obj.schemaVersion) || 1;
  if (cur > SCHEMA) throw BizError('这份数据来自更新的版本（v' + cur + '），当前程序无法读取');
  let next = migrate(obj);
  REPAIRS = [];
  next = validateState(next) || seed();
  return next;
}

/* ============================================================
   2 · 计算层（全部以「分」为单位的整数运算）
   ============================================================ */
function splitEven(totalFen, ids, payerId) {
  const list = (ids || []).slice();
  if (!list.length) throw BizError('没有可参与分摊的成员');
  const total = Math.round(totalFen);
  const n = list.length;
  const base = Math.floor(total / n);
  const cents = {}; list.forEach(id => cents[id] = base);
  const rest = total - base * n;
  const holder = (payerId && list.indexOf(payerId) >= 0) ? payerId : list[0];
  cents[holder] += rest;                       // 尾差补给垫付人，保证之和严格等于总额
  const sum = list.reduce((a, id) => a + cents[id], 0);
  if (sum !== total) throw BizError('分摊结果未守恒，已阻止提交');
  return cents;
}

function splitWeight(totalFen, ids, payerId) {
  const list = (ids || []).slice();
  if (!list.length) throw BizError('没有可参与分摊的成员');
  const wsum = list.reduce((s, id) => s + (memberWeight(id) || 0), 0);
  if (wsum <= 0) throw BizError('所有成员的权重都为 0，无法按权重分摊');
  const total = Math.round(totalFen);
  const cents = {}; let used = 0;
  list.forEach((id, i) => {
    if (i === list.length - 1) { cents[id] = total - used; return; }
    const v = Math.round(total * (memberWeight(id) || 0) / wsum);
    cents[id] = v; used += v;
  });
  const sum = list.reduce((a, id) => a + cents[id], 0);
  if (sum !== total) throw BizError('分摊结果未守恒，已阻止提交');
  return cents;
}

function computeShares(amountFen, rule, payerId, participants) {
  const ids = participants && participants.length ? participants : S.members.map(m => m.id);
  return rule === 'weight' ? splitWeight(amountFen, ids, payerId) : splitEven(amountFen, ids, payerId);
}

const member = id => S.members.find(m => m.id === id) || { name: '?', id: id, weight: 1 };
const memberWeight = id => member(id).weight || 1;
const mName = id => member(id).name;
const mInit = id => mName(id).slice(-1);

function billStatusOf(b) {
  const ids = b.participants || S.members.map(m => m.id);
  const vals = ids.map(id => b.confirm[id]);
  if (vals.indexOf('dispute') >= 0) return 'disputed';
  if (vals.every(v => v === 'ok')) return 'unpaid';
  return 'confirming';
}

/* 净额（分）：正 = 别人欠我；负 = 我欠别人。
   只统计未结清账单的未清偿部分，并扣除「已转账但未确认收款」的部分。 */
function computeNet() {
  const net = {}; S.members.forEach(m => net[m.id] = 0);
  S.bills.filter(b => b.status === 'unpaid').forEach(b => {
    net[b.payerId] = (net[b.payerId] || 0) + (b.amount - (b.shares[b.payerId] || 0));
    S.members.forEach(m => { if (m.id !== b.payerId) net[m.id] = (net[m.id] || 0) - (b.shares[m.id] || 0); });
  });
  S.transfers.forEach(t => {
    if (t.status === 'void') return;
    net[t.from] = (net[t.from] || 0) + t.amount;
    net[t.to] = (net[t.to] || 0) - t.amount;
  });
  return net;
}

/* 最少转账方案：n 人最多 n-1 笔 */
function planTransfers(net) {
  const recv = [], pay = [];
  Object.keys(net).forEach(id => {
    if (net[id] > 0) recv.push({ id: id, v: net[id] });
    else if (net[id] < 0) pay.push({ id: id, v: -net[id] });
  });
  recv.sort((a, b) => b.v - a.v); pay.sort((a, b) => b.v - a.v);
  const out = []; let i = 0, j = 0;
  while (i < recv.length && j < pay.length) {
    const amt = Math.min(recv[i].v, pay[j].v);
    out.push({ from: pay[j].id, to: recv[i].id, amount: amt });
    recv[i].v -= amt; pay[j].v -= amt;
    if (recv[i].v === 0) i++;
    if (pay[j].v === 0) j++;
  }
  return out;
}

/* 逐账单判定结清：账单的每一份非垫付份额都必须有「已付款」的转账覆盖。
   取代原先「全屋净额为 0 就全部结清」的全局判定（那会误标互相抵消的账单）。 */
function billAllocated(billId, onlyReceived) {
  const got = {};
  S.transfers.forEach(t => {
    if (t.status === 'void') return;
    if (onlyReceived && t.status !== 'received') return;   // 未确认收款的不算真正清偿
    (t.allocations || []).forEach(a => {
      if (a.billId === billId) got[a.memberId] = (got[a.memberId] || 0) + a.amount;
    });
  });
  return got;
}

function checkSettled() {
  S.bills.forEach(b => {
    if (b.status !== 'unpaid') return;
    const ids = b.participants || S.members.map(m => m.id);
    const owe = ids.filter(id => id !== b.payerId);
    if (!owe.length) { b.status = 'settled'; return; }
    const got = billAllocated(b.id, true);
    const done = owe.every(id => (got[id] || 0) >= (b.shares[id] || 0));
    if (done) {
      b.status = 'settled';
      b.history = b.history || [];
      b.history.push({ version: b.version, at: Date.now(), by: null, what: '全部份额结清' });
    }
  });
}

/* 为「某笔转账」分配它到底清掉了哪些账单份额（贪心，先到先清） */
function allocateFor(from, to, amountFen) {
  const list = [];
  S.bills.forEach(b => {
    if (b.status !== 'unpaid') return;
    if (b.payerId !== to || from === b.payerId) return;
    const share = b.shares[from] || 0;
    if (share <= 0) return;
    const already = billAllocated(b.id, false)[from] || 0;
    const remain = share - already;
    if (remain > 0) list.push({ billId: b.id, memberId: from, amount: remain, title: b.title });
  });
  let left = amountFen;
  const out = [];
  for (let i = 0; i < list.length && left > 0; i++) {
    const take = Math.min(left, list[i].amount);
    out.push({ billId: list[i].billId, memberId: list[i].memberId, amount: take });
    left -= take;
  }
  return { allocations: out, leftover: left };
}

/* ============================================================
   3 · 时间与排班
   ============================================================ */
function startOfWeek(d) { const x = new Date(d); const off = (x.getDay() + 6) % 7; x.setDate(x.getDate() - off); x.setHours(0, 0, 0, 0); return x; }

function weekDates() {
  const mon = startOfWeek(new Date());
  const out = []; for (let i = 0; i < 7; i++) { const d = new Date(mon); d.setDate(mon.getDate() + i); out.push(ymd(d)); }
  return out;
}

/* 补齐本周任务；同时归档 90 天前的任务，避免数组无限增长 */
function ensureTasks() {
  /* 只有 1 名成员时不自动排班 —— 一个人给自己排值日表没有意义。
     新账号必须保持空白，等室友（邀请码加入后成员 ≥2）再生成。 */
  if (!S.members || S.members.length < 2) return;

  const week = weekDates();
  const today = todayStr();
  const exist = {}; S.tasks.forEach(t => { if (week.indexOf(t.date) >= 0) exist[t.date] = true; });
  week.forEach((ds, i) => {
    if (exist[ds]) return;
    const area = AREAS[i % AREAS.length];
    const who = S.members[i % S.members.length];
    S.tasks.push({
      id: uid('t'), area: area.name, date: ds, assigneeId: who.id, originalAssigneeId: who.id,
      status: ds < today ? 'done' : 'pending',
      checklist: area.list.map(x => ({ t: x, done: ds < today })),
      proofAt: ds < today ? '21:30' : null,
      isLateCheckin: false, verifiedBy: null, overdue: false,
      history: []
    });
  });
  /* 归档：超过 90 天且已完成的任务移出主数组（保留计数摘要） */
  const cut = ymd(new Date(Date.now() - 90 * 86400000));
  const old = S.tasks.filter(t => t.date < cut);
  if (old.length) {
    S.archived = S.archived || {};
    old.forEach(t => { if (t.status === 'done') S.archived[t.assigneeId] = (S.archived[t.assigneeId] || 0) + 1; });
    S.tasks = S.tasks.filter(t => t.date >= cut);
  }
  S.tasks.sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : 0));
}

/* 每次渲染前跑一次：处理「确认超时」与「任务逾期」
   不依赖定时器 —— 后台标签页会被浏览器节流，定时器不可靠 */
function tick() {
  const now = Date.now();
  const today = todayStr();
  let changed = false;

  /* 账单确认超时 → 视为默认通过 */
  S.bills.forEach(b => {
    if (b.status !== 'confirming' || !b.dueAt) return;
    if (now < b.dueAt) return;
    b.confirm = b.confirm || {};
    (b.participants || []).forEach(id => { if (b.confirm[id] === 'pending') b.confirm[id] = 'ok'; });
    if (b.confirm['__timeout__'] !== true) {
      b.confirm['__timeout__'] = true;     // 标记「本次通过来自超时」而非人工确认
      b.history = b.history || [];
      b.history.push({ version: b.version, at: now, by: null, what: '确认超时（' + CONFIRM_HOURS + ' 小时），系统默认通过' });
    }
    b.status = billStatusOf(b);
    if (b.status === 'unpaid') changed = true;
  });

  /* 值日逾期 24 小时 → 顺延给下一顺位（只处理昨天及更早的未完成任务） */
  S.tasks.slice().forEach(t => {
    if (t.status !== 'pending' || t.date >= today) return;
    if (daysBetween(t.date, today) < 1) return;
    const idx = S.members.findIndex(m => m.id === t.assigneeId);
    const nxt = S.members[(idx + 1) % S.members.length];
    t.status = 'skipped';
    t.overdue = true;
    t.history = t.history || [];
    t.history.push({ at: now, what: '逾期未完成，已顺延' });
    /* 顺延：在下一个可用日期新建一条任务 */
    const free = S.members.find(m => m.id !== t.assigneeId) || nxt;
    S.tasks.push({
      id: uid('t'), area: t.area, date: today, assigneeId: free.id, originalAssigneeId: free.id,
      status: 'pending', checklist: (t.checklist || []).map(c => ({ t: c.t, done: false })),
      proofAt: null, isLateCheckin: false, verifiedBy: null, overdue: false,
      history: [{ at: now, what: '由 ' + dcn(t.date) + ' 的逾期任务顺延而来' }]
    });
    changed = true;
  });

  if (changed) save();
  return changed;
}

/* ============================================================
   4 · 贡献分（力账）
   ============================================================ */
const SCORE_RULES = {
  shift: { v: 10, why: '完成值日' },
  verified: { v: 2, why: '值日被验收通过' },
  purchase: { v: 8, why: '认领公共采购' },
  report: { v: 5, why: '上报需要维修的问题' },
  streak: { v: 15, why: '连续四周按时完成' }
};
/* 豁免券：每人每季度 1 张，可跳过 1 次值日 */
const VOUCHER_PER_QUARTER = 2;   // 每季度最多豁免 2 次值日
const VOUCHER_COST = 60;         // 每次豁免消耗的贡献分
const OFFSET_CAP = fen(30);      // 单次可抵扣的零头上限（元 → 分）

const quarterKey = () => { const d = new Date(); return d.getFullYear() + 'Q' + (Math.floor(d.getMonth() / 3) + 1); };

function scoreOf(memberId) {
  return (S.scoreLog || []).filter(x => x.memberId === memberId).reduce((a, x) => a + x.delta, 0);
}

function avgScore() {
  if (!S.members.length) return 0;
  return Math.round(S.members.reduce((a, m) => a + scoreOf(m.id), 0) / S.members.length);
}

function addScore(memberId, kind, note) {
  const r = SCORE_RULES[kind];
  if (!r) return;
  S.scoreLog = S.scoreLog || [];
  S.scoreLog.push({ id: uid('sc'), memberId: memberId, delta: r.v, reason: (r.why + (note ? '「' + note + '」' : '')), at: Date.now(), q: quarterKey() });
}

function vouchersLeft(memberId) {
  const q = quarterKey();
  const used = (S.voucher && S.voucher[memberId]) || {};
  return Math.max(0, VOUCHER_PER_QUARTER - (used[q] || 0));
}

function useVoucher(memberId) {
  if (vouchersLeft(memberId) <= 0) throw BizError('本季度豁免次数已用完（最多 ' + VOUCHER_PER_QUARTER + ' 次）');
  const have = scoreOf(memberId);
  if (have < VOUCHER_COST) throw BizError('贡献分不足，还差 ' + (VOUCHER_COST - have) + ' 分');
  S.scoreLog.push({ id: uid('sc'), memberId: memberId, delta: -VOUCHER_COST, reason: '兑换排班豁免', at: Date.now() });
  S.voucher = S.voucher || {};
  S.voucher[memberId] = S.voucher[memberId] || {};
  const q = quarterKey();
  S.voucher[memberId][q] = (S.voucher[memberId][q] || 0) + 1;
}

/* ============================================================
   5 · 渲染层
   ============================================================ */
let TAB = 'home';
let BILLTAB = 'list';

const STATUS_TXT = { confirming: '待确认', unpaid: '待支付', settled: '已结清', disputed: '协商中', void: '已作废' };
const STATUS_CLS = { confirming: 'o', unpaid: 'b', settled: 'g', disputed: 'r', void: '' };

/* 视图切换的入场过渡。
   先移除 class 再强制重排，保证「连续快速切换」每次都能重放动画；
   动画本身只动 opacity / transform，不触发布局。 */
function viewIn() {
  const v = $('#view');
  if (!v) return;
  v.classList.remove('view-enter');
  void v.offsetWidth;
  v.classList.add('view-enter');
}

function render() {
  try { tick(); } catch (e) { /* tick 异常不能阻塞渲染 */ }
  if (!S.members.length) {
    $('#tabbar').innerHTML = '';
    $('#view').innerHTML = `<div class="empty"><div class="em-ico">∅</div><b>这个房屋还没有成员</b>邀请室友加入后才能记账与排班</div>`;
    return;
  }
  renderWho();
  renderTabs();
  const v = $('#view');
  if (TAB === 'home') v.innerHTML = viewHome();
  else if (TAB === 'bills') v.innerHTML = BILLTAB === 'settle' ? viewSettle() : viewBills();
  else if (TAB === 'shift') v.innerHTML = viewShift();
  else if (TAB === 'items') v.innerHTML = viewItems();
  else v.innerHTML = viewPact();
  const m = $('#modalRoot');
  if (m.dataset.for && m.dataset.for !== TAB) closeSheet();
}

function renderWho() {
  $('#whoami').innerHTML = S.members.map(m =>
    `<option value="${m.id}"${m.id === S.me ? ' selected' : ''}>${esc(m.name)} · ${esc(m.room)}${m.id === 'm1' ? '（房屋创建者）' : ''}</option>`
  ).join('');
}

function renderTabs() {
  const pend = S.bills.filter(b => b.status === 'confirming' && b.confirm[S.me] === 'pending').length;
  const ICO = {
    home: '<path d="M3 9.5 10 4l7 5.5V16a1 1 0 0 1-1 1h-3.5v-4.5h-5V17H4a1 1 0 0 1-1-1z"/>',
    bills: '<path d="M5 3h10v14l-2.5-1.6L10 17l-2.5-1.6L5 17z"/><path d="M8 7h4M8 10.5h4"/>',
    shift: '<path d="M4 6.5 5.6 8 8.5 5"/><path d="M4 12l1.6 1.5L8.5 10.5"/><path d="M11 7h5M11 13h5"/>',
    items: '<path d="M3 7.5 10 3.5l7 4V16l-7 4-7-4z"/><path d="M3 7.5l7 4 7-4M10 11.5V20"/>',
    pact: '<path d="M6 3h6l4 3.5V21H6z"/><path d="M9 8h5M9 12h5M9 16h3"/>'
  };
  const t = [
    { k: 'home', n: '首页' },
    { k: 'bills', n: '账单', c: pend },
    { k: 'shift', n: '值日' },
    { k: 'items', n: '物品' },
    { k: 'pact', n: '公约' }
  ];
  $('#tabbar').innerHTML = t.map(x =>
    `<button class="tab${TAB === x.k ? ' on' : ''}" data-act="tab" data-id="${x.k}" type="button">` +
    `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICO[x.k]}</svg>` +
    `<span>${x.n}</span>${x.c ? `<span class="cnt">${x.c}</span>` : ''}</button>`
  ).join('');
}

/* ---------- 首页 ---------- */
function viewHome() {
  const me = S.me;
  const today = todayStr();
  const net = computeNet();
  const myNet = net[me] || 0;
  const todoBills = S.bills.filter(b => b.status === 'confirming' && b.confirm[me] === 'pending');
  const overdue = S.bills.filter(b => b.status === 'confirming' && b.confirm[me] === 'ok' && b.dueAt && b.dueAt - Date.now() < 12 * 3600000);
  const todayTasks = S.tasks.filter(t => t.date === today && t.assigneeId === me && t.status === 'pending');
  const todayOthers = S.tasks.filter(t => t.date === today && t.assigneeId !== me);
  const waitOthers = S.bills.filter(b => b.status === 'confirming' && b.confirm[me] === 'ok');
  const needBuy = S.items.filter(i => i.category === '消耗品' && i.safety > 0 && i.stock <= i.safety);
  const toRecv = S.transfers.filter(t => t.to === me && t.status === 'pending');
  const mySwap = S.swaps.filter(s => s.to === me && s.status === 'pending');
  const total = todoBills.length + todayTasks.length + toRecv.length + mySwap.length;
  const monthBills = S.bills.filter(b => b.date.slice(0, 7) === today.slice(0, 7));
  const monthTotal = monthBills.reduce((s, b) => s + b.amount, 0);
  const perHead = S.members.length ? Math.round(monthTotal / S.members.length) : 0;
  const myScore = scoreOf(me);

  let h = '';

  const netTxt = myNet > 0 ? '+' + fmt(myNet) : (myNet < 0 ? '-' + fmt(-myNet) : fmt(0));
  const netNote = myNet > 0 ? '应收 · 别人欠你' : (myNet < 0 ? '应付 · 你欠别人' : '已全部结清');
  h += `<div class="hero">
    <div class="h-lbl">我的净额</div>
    <div class="h-num">${netTxt}</div>
    <div class="h-note">${netNote} · ${esc(S.house.name)} · ${S.members.length} 人</div>
    <div class="h-stats">
      <div class="h-stat"><b>${total}</b><span>待我处理</span></div>
      <div class="h-stat"><b>${fmt(perHead)}</b><span>本月人均</span></div>
      <div class="h-stat"><b>${myScore}</b><span>我的贡献分</span></div>
    </div>
    <div class="h-acts">
      <button class="btn on-hero" data-act="settle" type="button">前往结算中心</button>
      <button class="btn on-hero-ghost" data-act="newbill" type="button">新建账单</button>
    </div>
  </div>`;

  h += `<div class="sec">
    <div class="sec-h"><h2>待我处理</h2><span>${total ? total + ' 项' : '暂无待办'}</span></div>`;

  if (!total) {
    h += `<div class="empty"><div class="em-ico">✓</div><b>全部处理完了</b>当前没有需要你确认的事项</div>`;
  }
  todoBills.forEach(b => {
    h += card({
      cls: 'warn', act: 'bill', id: b.id, ico: '¥', icoCls: 'money',
      title: b.title + ' 待确认',
      sub: `${esc(mName(b.payerId))}垫付 ${fmt(b.amount)} · ${b.rule === 'even' ? '均摊' : '按权重'}${b.dueAt ? ' · 剩 ' + Math.max(0, Math.ceil((b.dueAt - Date.now()) / 3600000)) + ' 小时超时' : ''}`,
      pill: fmt(b.shares[me] || 0), pillCls: 'o'
    });
  });
  todayTasks.forEach(t => {
    h += `<div class="card tint">
      <div class="cr">
        <span class="tico shift">✓</span>
        <div class="cr-b"><h3>今日值日 · ${esc(t.area)}</h3><p>检查清单 ${t.checklist.length} 项 · 22:00 前完成</p></div>
        <span class="pill g">今天</span>
      </div>
      <div class="btnrow pri">
        <button class="btn sm" data-act="checkin" data-id="${t.id}" type="button">拍照打卡</button>
        <button class="btn ghost sm" data-act="swap" data-id="${t.id}" type="button">申请换班</button>
      </div></div>`;
  });
  todayOthers.forEach(t => {
    h += `<div class="card">
      <div class="cr">
        <span class="tico shift">✓</span>
        <div class="cr-b"><h3>今日值日 · ${esc(t.area)}</h3>
          <p>今天由 ${esc(mName(t.assigneeId))} 负责 · ${t.status === 'done' ? '已完成' : '22:00 前完成'}</p></div>
        ${t.status === 'done' ? '<span class="pill g">已完成</span>' : '<span class="pill">进行中</span>'}
      </div></div>`;
  });
  toRecv.forEach(t => {
    h += `<div class="card">
      <div class="cr">
        <span class="tico money">¥</span>
        <div class="cr-b"><h3>${esc(mName(t.from))} 已向你转账</h3><p>对方标记于 ${esc(t.paidAt)} · 确认后该笔债务关闭</p></div>
        <span class="amt">${fmt(t.amount)}</span>
      </div>
      <div class="btnrow"><button class="btn sm" data-act="recv" data-id="${t.id}" type="button">确认已收到</button></div></div>`;
  });
  mySwap.forEach(s => {
    const tk = S.tasks.find(x => x.id === s.taskId) || { area: '值日', date: '' };
    h += `<div class="card">
      <div class="cr">
        <span class="tico shift">⇄</span>
        <div class="cr-b"><h3>${esc(mName(s.from))} 申请与你换班</h3><p>${esc(dcn(tk.date))} ${esc(tk.area)} · 原因：${esc(s.reason || '未填写')}</p></div>
        <span class="pill o">待响应</span>
      </div>
      <div class="btnrow pri">
        <button class="btn sm" data-act="swapOk" data-id="${s.id}" type="button">同意</button>
        <button class="btn ghost sm" data-act="swapNo" data-id="${s.id}" type="button">拒绝</button>
      </div></div>`;
  });
  waitOthers.forEach(b => {
    const left = S.members.filter(m => b.confirm[m.id] === 'pending').map(m => m.name).join('、');
    h += `<div class="card">
      <div class="cr">
        <span class="tico money">¥</span>
        <div class="cr-b"><h3>${esc(b.title)}</h3>
          <p>你已确认 · 等待 ${esc(left || '—')} 确认</p></div>
        <span class="pill">等待中</span>
      </div></div>`;
  });
  h += `</div>`;

  h += `<div class="sec">
    <div class="sec-h"><h2>房屋动态</h2><span>${S.members.length} 位成员</span></div>
    <div class="card"><div class="rowlist">`;
  const feed = [];
  S.tasks.filter(t => t.status === 'done').slice(-2).forEach(t => feed.push({ i: '✓', c: 'shift', x: `${mName(t.assigneeId)} 完成「${t.area}」值日 · ${dcn(t.date)}` }));
  needBuy.forEach(i => feed.push({ i: '物', c: 'item', x: `${i.name} 已低于安全库存，采购负责人：${mName(i.purchaserId)}` }));
  S.bills.forEach(b => { if (b.status === 'settled') feed.push({ i: '¥', c: 'money', x: `${b.title} 已结清 · ${fmt(b.amount)}` }); });
  if (!feed.length) feed.push({ i: '·', c: '', x: '暂无动态' });
  h += feed.slice(-4).map(f => `<div class="rowitem"><span class="tico sm-tico ${f.c}">${f.i}</span><span class="nm">${esc(f.x)}</span></div>`).join('');
  h += `</div></div></div>`;

  return h;
}

function card(o) {
  const ico = o.ico ? `<span class="tico ${o.icoCls || ''}">${o.ico}</span>` : '';
  return `<div class="card ${o.cls || ''} ${o.act ? 'tap' : ''}" ${o.act ? `data-act="${o.act}" data-id="${o.id}"` : ''}>
    <div class="cr">
      ${ico}
      <div class="cr-b"><h3>${esc(o.title)}</h3>${o.sub ? `<p>${o.sub}</p>` : ''}</div>
      ${o.pill ? `<span class="amt" style="${o.pillCls === 'o' ? 'color:var(--accent)' : ''}">${esc(o.pill)}</span>` : ''}
    </div></div>`;
}

/* ---------- 账单 ---------- */
function viewBills() {
  const me = S.me;
  let h = `<div class="sec">
    <div class="sec-h"><h2>账单</h2>
      <span><button class="btn ghost sm" data-act="settle" type="button">结算中心</button></span>
    </div>`;

  const groups = [
    { k: 'confirming', n: '待确认' }, { k: 'disputed', n: '协商中' },
    { k: 'unpaid', n: '待支付' }, { k: 'settled', n: '已结清' }
  ];
  let any = false;
  groups.forEach(g => {
    const list = S.bills.filter(b => b.status === g.k);
    if (!list.length) return;
    any = true;
    h += `<p class="sub" style="margin:16px 0 8px;font-weight:800;color:var(--ink-2)">${g.n} · ${list.length}</p>`;
    list.slice(0, 30).forEach(b => {
      const mine = b.shares[me] || 0;
      const myState = b.confirm[me];
      const tag = b.status === 'confirming'
        ? (myState === 'pending' ? '<span class="pill o">待你确认</span>' : (myState === 'ok' ? '<span class="pill g">你已确认</span>' : '<span class="pill r">你已提出异议</span>'))
        : `<span class="pill ${STATUS_CLS[b.status]}">${STATUS_TXT[b.status]}</span>`;
      h += `<div class="card tap" data-act="bill" data-id="${b.id}">
        <div class="cr">
          <span class="tico money">¥</span>
          <div class="cr-b"><h3>${esc(b.title)}</h3>
            <p>${esc(mName(b.payerId))}垫付 ${fmt(b.amount)} · ${b.rule === 'even' ? '按人头均摊' : '按房间权重'}${b.version > 1 ? ' · v' + b.version : ''}</p>
          </div>
          <span class="amt">${fmt(mine)}</span>
        </div>
        <div class="kvmini">${tag}<span class="muted">我应付 ${fmt(mine)}</span></div>
      </div>`;
    });
    if (list.length > 30) h += `<p class="sub">仅显示最近 30 笔，共 ${list.length} 笔</p>`;
  });
  if (!any) h += `<div class="empty"><div class="em-ico">＋</div><b>还没有账单</b>点下面的按钮记下第一笔</div>`;
  h += `</div><button class="btn wide" data-act="newbill" type="button">＋ 新建账单</button>`;
  return h;
}

/* ---------- 结算中心 ---------- */
function viewSettle() {
  const me = S.me;
  const net = computeNet();
  const plan = planTransfers(net);
  const recv = S.transfers.filter(t => t.to === me && t.status === 'pending');
  const waitFor = S.transfers.filter(t => t.from === me && t.status === 'pending');

  let h = `<div class="sec">
    <div class="sec-h"><h2>结算中心</h2><span><button class="btn ghost sm" data-act="bills" type="button">返回账单</button></span></div>
    <div class="card tint">
      <p class="sub" style="margin:0">我的净额</p>
      <div class="big">${net[me] > 0 ? '+' + fmt(net[me]) : (net[me] < 0 ? '-' + fmt(-net[me]) : fmt(0))}</div>
      <p class="sub">逐笔债务已压缩为 ${plan.length} 笔转账（净额结算）</p>
    </div>

    <p class="sub" style="margin:16px 0 8px;font-weight:800;color:var(--ink-2)">最少转账方案 · ${plan.length} 笔</p>`;

  if (!plan.length) h += `<div class="card"><div class="cr"><span class="tico money">✓</span><div class="cr-b"><h3>当前没有待结清的债务</h3><p>所有账单均已结清</p></div></div></div>`;
  plan.forEach(p => {
    const mine = (p.from === me) ? 'from' : ((p.to === me) ? 'to' : '');
    const alloc = allocateFor(p.from, p.to, p.amount);
    const detail = alloc.allocations.map(a => {
      const b = S.bills.find(x => x.id === a.billId);
      return (b ? esc(b.title) : '已删除账单') + ' ' + fmt(a.amount);
    }).join('、');
    h += `<div class="card">
      <div class="cr">
        <span class="tico money">¥</span>
        <div class="cr-b"><h3>${esc(mName(p.from))} → ${esc(mName(p.to))}</h3>
        <p>${mine === 'from' ? '你需要转出' : (mine === 'to' ? '你将收到' : '与你无关的一笔')}${detail ? ' · 覆盖：' + detail : ''}</p></div>
        <span class="amt">${fmt(p.amount)}</span>
      </div>
      ${mine === 'from' ? `<div class="btnrow"><button class="btn sm" data-act="paid" data-from="${p.from}" data-to="${p.to}" data-amt="${p.amount}" type="button">我已转账</button></div>` : ''}
      ${mine === 'to' ? `<div class="btnrow"><button class="btn ghost sm" data-act="fakePaid" data-from="${p.from}" data-to="${p.to}" data-amt="${p.amount}" type="button">模拟对方已转账</button></div>` : ''}
    </div>`;
  });

  if (recv.length) {
    h += `<p class="sub" style="margin:16px 0 8px;font-weight:800;color:var(--ink-2)">待我确认收款 · ${recv.length}</p>`;
    recv.forEach(t => {
      h += `<div class="card"><div class="cr">
        <div><h3>${esc(mName(t.from))} 已转账给你</h3><p>标记时间 ${esc(t.paidAt)}</p></div>
        <span class="amt">${fmt(t.amount)}</span></div>
        <div class="btnrow">
          <button class="btn sm" data-act="recv" data-id="${t.id}" type="button">确认已收到</button>
          <button class="btn ghost sm" data-act="rejectTransfer" data-id="${t.id}" type="button">没收到</button>
        </div>
      </div>`;
    });
  }
  if (waitFor.length) {
    h += `<p class="sub" style="margin:16px 0 8px;font-weight:800;color:var(--ink-2)">我已转账，等待对方确认 · ${waitFor.length}</p>`;
    waitFor.forEach(t => {
      h += `<div class="card"><div class="cr">
        <div><h3>已转给 ${esc(mName(t.to))}</h3><p>等待对方确认收款</p></div>
        <span class="amt">${fmt(t.amount)}</span></div>
        <div class="btnrow"><button class="btn ghost sm" data-act="voidTransfer" data-id="${t.id}" type="button">撤回这笔转账</button></div></div>`;
    });
  }
  h += `</div>`;
  return h;
}

/* ---------- 值日 ---------- */
/* 值日卡片：本周表与「之后的排班」共用同一套渲染 */
function taskCardHtml(t, today) {
  const me = S.me;
  const isToday = t.date === today;
  const isMe = t.assigneeId === me;
  const overdueDay = t.status === 'pending' && t.date < today;
  const st = t.status === 'done' ? '<span class="pill g">已完成</span>'
    : (t.status === 'skipped' ? '<span class="pill r">已顺延</span>'
      : (overdueDay ? '<span class="pill r">已逾期</span>'
        : (isToday ? '<span class="pill o">今天 22:00 前</span>' : '<span class="pill">待办</span>')));
  const canCheck = isMe && t.status === 'pending' && t.date <= today && daysBetween(t.date, today) <= GRACE_DAYS;
  let h = `<div class="card ${isToday && isMe ? 'tint' : ''}">
    <div class="cr">
      <span class="tico shift">✓</span>
      <div class="cr-b"><h3>${esc(dcn(t.date))} ${esc(WD[new Date(t.date.replace(/-/g, '/')).getDay()])} · ${esc(t.area)}</h3>
        <p>负责人：${esc(mName(t.assigneeId))}${t.proofAt ? ' · ' + esc(t.proofAt) + ' 打卡' + (t.isLateCheckin ? '（补打）' : '') : ''}${isMe ? ' · 是你' : ''}</p></div>
      ${st}
    </div>
    <div class="btnrow${canCheck ? ' pri' : ''}">`;
  if (canCheck) {
    h += `<button class="btn sm" data-act="checkin" data-id="${t.id}" type="button">拍照打卡</button>
      <button class="btn ghost sm" data-act="swap" data-id="${t.id}" type="button">申请换班</button>`;
  }
  h += `<button class="btn link sm" data-act="editTask" data-id="${t.id}" type="button">编辑</button>`;
  h += `</div></div>`;
  return h;
}

function viewShift() {
  const me = S.me;
  const today = todayStr();
  const week = weekDates();
  const weekTasks = S.tasks.filter(t => week.indexOf(t.date) >= 0);
  const mine = weekTasks.filter(t => t.assigneeId === me);
  const doneN = weekTasks.filter(t => t.status === 'done').length;

  let h = `<div class="sec">
    <div class="sec-h"><h2>本周值日表</h2>
      <div class="sec-r"><span>共 ${weekTasks.length} 项 · 已完成 ${doneN} 项</span>
        <button class="mini-add" data-act="newTask" type="button" aria-label="新增排班" title="手动新增一条排班">＋</button></div>
    </div>`;

  week.forEach(ds => {
    const t = S.tasks.find(x => x.date === ds);
    if (t) h += taskCardHtml(t, today);
  });
  if (!weekTasks.length) {
    h += `<div class="card"><div class="cr">
      <span class="tico shift">✓</span>
      <div class="cr-b"><h3>本周还没有值日安排</h3>
        <p>${S.members.length < 2 ? '邀请室友加入房屋后，会自动生成本周值日表' : '点右上角的 ＋ 手动排一条'}</p></div>
    </div></div>`;
  }
  h += `</div>`;

  /* 本周之后的排班 —— 手动排了下周的任务必须能看到，否则会出现「加了却找不到」 */
  const future = S.tasks.filter(t => t.date > week[6]);
  if (future.length) {
    h += `<div class="sec">
      <div class="sec-h"><h2>之后的排班</h2>
        <div class="sec-r"><span>共 ${future.length} 项</span>
          <button class="mini-add" data-act="newTask" type="button" aria-label="新增排班" title="手动新增一条排班">＋</button></div>
      </div>`;
    future.forEach(t => { h += taskCardHtml(t, today); });
    h += `</div>`;
  }

  /* 力账：贡献分 */
  const myScore = scoreOf(me);
  const avg = avgScore();
  const diff = myScore - avg;
  h += `<div class="sec">
    <div class="sec-h"><h2>力账 · 贡献分</h2><span>本季度剩余豁免 ${vouchersLeft(me)} 次</span></div>
    <div class="card">
      <div class="cr">
        <span class="tico pact">分</span>
        <div class="cr-b"><h3>我的贡献分 ${myScore}</h3>
          <p>房屋平均 ${avg} 分 · ${diff > 0 ? '你比平均多做 ' + diff + ' 分' : (diff < 0 ? '比平均少 ' + (-diff) + ' 分' : '与平均持平')}</p></div>
      </div>
      <div class="btnrow">
        <button class="btn ghost sm" data-act="voucher" type="button">花费 ${VOUCHER_COST} 分豁免一次值日</button>
      </div>
      <p class="sub">豁免券用于跳过 1 次值日（每季度最多 ${VOUCHER_PER_QUARTER} 次）。分数不做公开排行，只对你自己可见</p>
    </div>
  </div>`;

  const swapIn = S.swaps.filter(s => s.to === me && s.status === 'pending');
  if (swapIn.length) {
    h += `<div class="sec"><div class="sec-h"><h2>待我响应的换班</h2></div>`;
    swapIn.forEach(s => {
      const tk = S.tasks.find(x => x.id === s.taskId) || { area: '', date: '' };
      h += `<div class="card"><div class="cr">
        <div><h3>${esc(mName(s.from))} 申请换班</h3><p>${esc(dcn(tk.date))} ${esc(tk.area)} · ${esc(s.reason || '未填写原因')}</p></div>
        <span class="pill o">待响应</span></div>
        <div class="btnrow pri">
          <button class="btn sm" data-act="swapOk" data-id="${s.id}" type="button">同意</button>
          <button class="btn ghost sm" data-act="swapNo" data-id="${s.id}" type="button">拒绝</button>
        </div></div>`;
    });
    h += `</div>`;
  }

  h += `<div class="sec"><div class="sec-h"><h2>本周我的任务</h2><span>${mine.length} 项</span></div>`;
  if (!mine.length) h += `<div class="empty"><div class="em-ico">☺</div><b>本周没有你的任务</b>${S.members.length < 2 ? '邀请室友加入后会自动排班' : '按轮值规则，下周会轮到你'}</div>`;
  mine.forEach(t => {
    h += `<div class="card"><div class="cr">
      <div><h3>${esc(dcn(t.date))} · ${esc(t.area)}</h3><p>${(t.checklist || []).map(c => esc(c.t)).join(' / ') || '未设置检查项'}</p></div>
      ${t.status === 'done' ? '<span class="pill g">已完成</span>' : (t.status === 'skipped' ? '<span class="pill r">已顺延</span>' : '<span class="pill o">待办</span>')}</div></div>`;
  });
  h += `</div>`;
  return h;
}
/* ---------- 物品 ---------- */
function activeRestock(itemId) {
  return S.restocks.find(r => r.itemId === itemId && (r.status === 'open' || r.status === 'claimed'));
}

function viewItems() {
  const me = S.me;
  const cats = ['消耗品', '共享设备'];
  const monthSpend = S.bills.filter(b => b.category === '日用品' && b.date.slice(0, 7) === todayStr().slice(0, 7))
    .reduce((s, b) => s + b.amount, 0);

  let h = `<div class="sec">
    <div class="sec-h"><h2>公共物品</h2>
      <div class="sec-r"><span>本月公共采购 ${fmt(monthSpend)}</span>
        <button class="mini-add" data-act="newItem" type="button" aria-label="添加物品" title="登记一件公共物品">＋</button></div>
    </div>`;

  if (!S.items.length) h += `<div class="empty"><div class="em-ico">□</div><b>还没有登记物品</b>把纸巾、洗洁精这类公用消耗品记进来
    <div class="btnrow" style="max-width:200px;margin:14px auto 0"><button class="btn sm" data-act="newItem" type="button">添加第一件</button></div></div>`;

  cats.forEach(c => {
    const list = S.items.filter(i => i.category === c);
    if (!list.length) return;
    h += `<p class="sub" style="margin:14px 0 8px;font-weight:800;color:var(--ink-2)">${c}</p>`;
    list.forEach(i => {
      const track = i.safety > 0;
      const need = track && i.stock <= i.safety;
      const low = track && !need && i.stock <= i.safety * 1.6;
      const pct = track ? Math.max(0, Math.min(100, Math.round(i.stock / (i.safety * 4) * 100))) : (i.stock > 0 ? 100 : 0);
      const badge = !track ? '<span class="pill">不追踪</span>'
        : (need ? '<span class="pill r">需采购</span>' : (low ? '<span class="pill o">偏低</span>' : '<span class="pill g">充足</span>'));
      const task = activeRestock(i.id);
      h += `<div class="card ${need && !task ? 'warn' : ''}">
        <div class="cr">
          <span class="tico ${c === '消耗品' ? 'item' : 'shift'}">${c === '消耗品' ? '物' : '器'}</span>
          <div class="cr-b"><h3>${esc(i.name)}</h3>
            <p>剩余 ${i.stock} ${esc(i.unit)} · 安全库存 ${i.safety} ${esc(i.unit)}${i.purchaserId ? ' · 采购负责人 ' + esc(mName(i.purchaserId)) : ''}</p>
          </div>${badge}
        </div>
        <div class="bar"><i class="${need ? 'r' : (low ? 'o' : '')}" style="width:${pct}%"></i></div>`;
      if (i.borrow) h += `<p class="sub">${esc(mName(i.borrow.by))} 借用中 · 预计 ${esc(i.borrow.due)} 归还</p>`;
      if (task) {
        h += `<p class="sub">${task.status === 'claimed' ? esc(mName(task.assigneeId)) + ' 已认领采购' : '待认领'}${
          me !== task.assigneeId && task.status === 'claimed' ? ' · <span class="linky" data-act="nudge" data-id="' + task.id + '">催一下</span>' : ''}</p>`;
      }
      h += `<div class="btnrow${(i.category === '消耗品' && (!task || task.status === 'open')) ? ' pri' : ''}">`;
      if (i.category === '消耗品') {
        h += `<button class="btn ghost sm" data-act="empty" data-id="${i.id}" type="button">快没了</button>`;
        if (!task || task.status === 'open') {
          h += `<button class="btn sm" data-act="buy" data-id="${i.id}" type="button">我去买</button>`;
        }
      }
      h += `<button class="btn link sm" data-act="editItem" data-id="${i.id}" type="button">编辑</button>`;
      h += `</div>`;
      h += `</div>`;
    });
  });
  h += `</div>`;
  return h;
}

/* ---------- 公约 + 房屋数据 ---------- */
function viewPact() {
  const me = S.me;
  const cats = [];
  S.pacts.forEach(p => { if (cats.indexOf(p.category) < 0) cats.push(p.category); });

  let h = '';
  if (!S.pacts.length) {
    /* 空房屋：不显示"公约已生效"这类并不存在的状态 */
    h += `<div class="sec">
      <div class="sec-h"><h2>室友公约</h2>
        <div class="sec-r"><span>尚未建立</span>
          <button class="mini-add" data-act="newPact" type="button" aria-label="新增条款" title="新增一条公约条款">＋</button></div>
      </div>
      <div class="card"><div class="cr">
        <span class="tico pact">约</span>
        <div class="cr-b"><h3>还没有公约</h3>
        <p>${S.members.length < 2 ? '邀请室友加入后，在这里一起定下房屋规则' : '把最容易起争执的事写成条款，绑定到系统规则上'}</p></div>
      </div>
        <div class="btnrow" style="max-width:200px"><button class="btn sm" data-act="newPact" type="button">新增第一条</button></div>
      </div>
    </div>`;
  } else {
    h += `<div class="sec">
      <div class="sec-h"><h2>室友公约</h2>
        <div class="sec-r"><span>当前生效 ${esc(S.pactVersion)}</span>
          <button class="mini-add" data-act="newPact" type="button" aria-label="新增条款" title="新增一条公约条款">＋</button></div>
      </div>
      <div class="card tint">
        <div class="cr"><div><h3>公约 ${esc(S.pactVersion)}</h3><p>全体成员已签署（${S.members.length}/${S.members.length}）</p></div><span class="pill g">生效中</span></div>
      </div>`;
    cats.forEach(c => {
      h += `<p class="sub" style="margin:14px 0 8px;font-weight:800;color:var(--ink-2)">${esc(c)}</p>`;
      S.pacts.filter(p => p.category === c).forEach(p => {
        h += `<div class="card">
          <div class="cr"><div><h3>${esc(p.text)}</h3><p>${esc(p.binding)}</p></div>
          ${p.enforceable ? '<span class="pill g">已绑定</span>' : '<span class="pill">仅靠自觉</span>'}</div>
          <div class="btnrow"><button class="btn link sm" data-act="editPact" data-id="${p.id}" type="button">查看与编辑</button></div>
        </div>`;
      });
    });
    h += `</div>`;
  }

  /* 提案与投票：区块常显 —— 否则没有提案时就找不到「发起」入口 */
  h += `<div class="sec"><div class="sec-h"><h2>提案与投票</h2>
    <div class="sec-r">${S.votes.length ? '<span>' + S.votes.length + ' 个进行中</span>' : ''}
      <button class="mini-add" data-act="newVote" type="button" aria-label="发起提案" title="发起一个提案让大家投票">＋</button></div></div>`;
  if (!S.votes.length) {
    h += `<div class="empty"><div class="em-ico">◇</div><b>还没有提案</b>拿不定主意的事，提出来让大家投个票</div>`;
  }
  S.votes.forEach(v => {
    const ok = v.support.indexOf(me) >= 0, no = v.against.indexOf(me) >= 0;
    const pass = v.support.length >= v.threshold;
    h += `<div class="card">
      <div class="cr"><div><h3>${esc(v.text)}</h3><p>${esc(v.deadline)} · 通过阈值 ${v.threshold} 票</p></div>
      <span class="pill ${pass ? 'g' : 'o'}">${v.support.length} 支持 / ${v.against.length} 反对</span></div>
      <div class="btnrow pri">
        <button class="btn ${ok ? '' : 'ghost'} sm" data-act="vote" data-id="${v.id}" data-v="1" type="button">${ok ? '已支持' : '支持'}</button>
        <button class="btn ${no ? 'danger' : 'ghost'} sm" data-act="vote" data-id="${v.id}" data-v="0" type="button">${no ? '已反对' : '反对'}</button>
        <button class="btn link sm" data-act="editVote" data-id="${v.id}" type="button">编辑</button>
      </div>
      ${pass ? '<p class="sub">已达到通过阈值，将在截止后自动生效</p>' : ''}
    </div>`;
  });
  h += `</div>`;

  /* 公约版本：只展示真实存在的版本，不再硬编码示例历史 */
  if (S.pacts.length) {
    h += `<div class="sec"><div class="sec-h"><h2>公约版本</h2></div>
      <div class="card"><div class="rowlist">
        <div class="rowitem"><span class="tico sm-tico pact">${esc(String(S.pactVersion).replace(/^v/, ''))}</span><span class="nm">当前版本 · 共 ${S.pacts.length} 条</span><span class="muted">生效中</span></div>
      </div></div></div>`;
  }
  /* 房屋数据：导出 / 导入 / 结算单 / 重置 —— 单机应用的唯一自救手段 */
  h += `<div class="sec">
    <div class="sec-h"><h2>房屋数据</h2><span>数据结构 v${S.schemaVersion}</span></div>
    <div class="card">
      <div class="cr">
        <span class="tico item">数</span>
        <div class="cr-b"><h3>账单 ${S.bills.length} 笔 · 任务 ${S.tasks.length} 条 · 物品 ${S.items.length} 项</h3></div>
      </div>
      <div class="btnrow pri">
        <button class="btn sm" data-act="exportData" type="button">导出备份</button>
        <button class="btn ghost sm" data-act="importData" type="button">导入备份</button>
      </div>
      <div class="btnrow">
        <button class="btn ghost sm" data-act="monthlyReport" type="button">生成月度结算单</button>
        <button class="btn ghost sm" data-act="exitReport" type="button">生成离场结算单</button>
      </div>
      <div class="btnrow">
        <button class="btn link sm" data-act="resetAsk" type="button">清空全部数据</button>
      </div>
    </div>
  </div>`;
  return h;
}

/* ============================================================
   6 · 弹层（含无障碍：ESC 关闭 / 焦点管理 / 锁定背景滚动）
   ============================================================ */
let LAST_FOCUS = null;

function openSheet(html, forTab) {
  LAST_FOCUS = document.activeElement;
  const r = $('#modalRoot');
  r.dataset.for = forTab || TAB;
  r.innerHTML = `<div class="mask"><div class="sheet" tabindex="-1" role="dialog" aria-modal="true">${html}</div></div>`;
  document.body.style.overflow = 'hidden';
  document.body.classList.add('sheet-open');
  const sheet = r.querySelector('.sheet');
  if (sheet) setTimeout(() => { try { sheet.focus(); } catch (e) { /* ignore */ } }, 20);
}

function closeSheet() {
  const r = $('#modalRoot');
  if (!r.innerHTML) return;
  if (r.dataset.closing === '1') return;          /* 连点关闭时不重复触发 */

  const finish = () => {
    r.innerHTML = '';
    r.removeAttribute('data-for');
    r.removeAttribute('data-closing');
    document.body.style.overflow = '';
    document.body.classList.remove('sheet-open');
    if (LAST_FOCUS && typeof LAST_FOCUS.focus === 'function') { try { LAST_FOCUS.focus(); } catch (e) { /* ignore */ } }
    LAST_FOCUS = null;
  };

  const mask = r.querySelector('.mask');
  const sheet = r.querySelector('.sheet');
  /* 退出动画比进入更快（进场可慢，退场必须干脆）。
     不支持 Web Animations 的环境（jsdom、老浏览器）直接关闭，避免弹层卡住。 */
  if (!mask || !sheet || typeof sheet.animate !== 'function') { finish(); return; }

  r.dataset.closing = '1';
  const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';
  let done = false;
  const once = () => { if (done) return; done = true; finish(); };
  try {
    mask.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 170, easing: EASE, fill: 'forwards' });
    sheet.animate(
      [{ transform: 'none', opacity: 1 }, { transform: 'translateY(18px)', opacity: 0 }],
      { duration: 190, easing: EASE, fill: 'forwards' }
    ).finished.then(once).catch(once);
  } catch (e) { once(); return; }
  setTimeout(once, 320);   /* 兜底：动画结束事件丢失时也要关掉 */
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('on'), 2400);
}

function fail(e) {
  const msg = (e && e.name === 'BizError') ? e.message : '操作失败：' + ((e && e.message) || e);
  if (e && e.name !== 'BizError') console.error(e);
  toast(msg);
}

/* 通用二次确认（危险操作必须走这里） */
function sheetConfirm(title, lines, okText, act, dataId, danger) {
  openSheet(`
    <h3>${esc(title)}</h3>
    <p class="sh-sub">这一步无法自动撤销，请确认</p>
    ${lines.map(x => `<div class="rowitem"><span class="nm">${esc(x)}</span></div>`).join('')}
    <div class="btnrow" style="margin-top:18px">
      <button class="btn link" data-act="close" type="button">取消</button>
      <button class="btn ${danger ? 'danger' : ''}" data-act="${act}" ${dataId ? `data-id="${dataId}"` : ''} type="button">${esc(okText)}</button>
    </div>
  `);
}

/* ---------- 新建账单 ---------- */
function sheetNewBill() {
  const opts = S.members.map(m => `<option value="${m.id}"${m.id === S.me ? ' selected' : ''}>${esc(m.name)} · ${esc(m.room)}</option>`).join('');
  openSheet(`
    <h3>新建账单</h3>
    <p class="sh-sub">分摊方式默认取自公约 ${esc(S.pactVersion)} 第 1 条「房租水电按人头均摊」</p>
    <div class="field"><label for="nbTitle">账单名称</label><input id="nbTitle" value="水费 2026-09" maxlength="40"></div>
    <div class="f2">
      <div class="field"><label for="nbCat">类别</label>
        <select id="nbCat"><option>水电</option><option>燃气</option><option>网费</option><option>房租</option><option>日用品</option><option>维修</option><option>其他</option></select>
      </div>
      <div class="field"><label for="nbAmt">总额（元）</label><input id="nbAmt" type="number" step="0.01" min="0" value="186.50"></div>
    </div>
    <div class="f2">
      <div class="field"><label for="nbPayer">垫付人</label><select id="nbPayer">${opts}</select></div>
      <div class="field"><label for="nbRule">分摊方式</label>
        <select id="nbRule"><option value="even">按人头均摊</option><option value="weight">按房间权重</option></select>
      </div>
    </div>
    <div class="field"><label for="nbNote">备注（可选）</label><input id="nbNote" placeholder="例如：抄表 1842 → 2214 kWh" maxlength="60"></div>
    <div class="preview" id="nbPreview"></div>
    <div class="btnrow">
      <button class="btn link" data-act="close" type="button">取消</button>
      <button class="btn" data-act="createBill" type="button">提交并推送确认</button>
    </div>
  `, 'bills');

  const upd = () => {
    const amtFen = fen($('#nbAmt').value);
    const rule = $('#nbRule').value;
    const payer = $('#nbPayer').value;
    let inner;
    try {
      const sh = computeShares(amtFen, rule, payer);
      const sum = Object.keys(sh).reduce((a, k) => a + sh[k], 0);
      inner = `<div class="ph">实时预览 · 每人应付（合计 ${fmt(sum)}）</div>` +
        S.members.map(m => `<div class="rowitem"><span class="nm">${esc(m.name)}${m.id === payer ? '（垫付人）' : ''}</span><span class="v">${fmt(sh[m.id])}</span></div>`).join('');
    } catch (e) {
      inner = `<div class="ph">实时预览</div><div class="rowitem"><span class="nm">${esc(e.message)}</span></div>`;
    }
    const raw = String($('#nbAmt').value || '');
    if (raw && Math.abs(Number(raw) * 100 - Math.round(Number(raw) * 100)) > 1e-6) {
      inner += `<div class="sub" style="margin-top:8px">提示：金额不足 1 分，已按分取整</div>`;
    }
    $('#nbPreview').innerHTML = inner;
  };
  ['nbAmt', 'nbRule', 'nbPayer'].forEach(id => {
    const el = $('#' + id);
    if (el) { el.addEventListener('input', upd); el.addEventListener('change', upd); }
  });
  upd();
}

/* ---------- 账单详情 ---------- */
function sheetBill(id) {
  const b = S.bills.find(x => x.id === id);
  if (!b) return;
  const me = S.me;
  const ids = b.participants || S.members.map(m => m.id);
  const rows = ids.map(mid => {
    const st = b.confirm[mid];
    const txt = st === 'ok' ? '<span class="pill g">已确认</span>' : (st === 'dispute' ? '<span class="pill r">有异议</span>' : '<span class="pill o">待确认</span>');
    return `<div class="rowitem">
      <span class="nm"><span class="av">${esc(mInit(mid))}</span>${esc(mName(mid))}${mid === b.payerId ? '（垫付）' : ''}</span>
      <span class="v">${fmt(b.shares[mid])}</span>${st && b.status === 'confirming' ? txt : ''}
    </div>`;
  }).join('');

  const mine = b.shares[me] || 0;
  const timeoutPassed = b.confirm && b.confirm['__timeout__'] === true;
  let actions = '';
  if (b.status === 'confirming' && b.confirm[me] === 'pending') {
    const left = b.dueAt ? Math.max(0, Math.ceil((b.dueAt - Date.now()) / 3600000)) : null;
    if (left !== null) actions += `<p class="sub">若 ${left} 小时内无人提出异议，将按公约自动通过</p>`;
    actions += `<div class="btnrow">
      <button class="btn ghost" data-act="dispute" data-id="${b.id}" type="button">有异议</button>
      <button class="btn" data-act="ok" data-id="${b.id}" type="button">确认这笔账</button>
    </div>`;
  } else if (b.status === 'confirming') {
    const left = ids.filter(mid => b.confirm[mid] === 'pending').map(mid => mName(mid)).join('、');
    actions = `<p class="sub">你已确认 · 等待 ${esc(left || '—')} 确认</p>`;
  } else if (b.status === 'disputed') {
    actions = `<p class="sub">账目存在异议，可修订后重新推送全员确认</p>
      <div class="btnrow"><button class="btn ghost" data-act="revise" data-id="${b.id}" type="button">修订并重新推送</button></div>`;
  } else if (b.status === 'unpaid') {
    actions = `<div class="btnrow"><button class="btn" data-act="settle" type="button">前往结算中心处理</button></div>`;
  } else if (b.status === 'settled') {
    const got = billAllocated(b.id, true);
    actions = `<p class="sub">已于 ${
      (b.history || []).filter(h => h.what === '全部份额结清').map(h => timeTag()).slice(-1)[0] || '此前'
    } 结清，各份额均由「已确认收款」的转账覆盖</p>`;
  }

  const hist = (b.history || []).map(h =>
    `<div class="rowitem"><span class="nm">v${h.version} · ${esc(h.what)}</span><span class="muted">${esc(h.by ? mName(h.by) : '系统')}</span></div>`
  ).join('');

  openSheet(`
    <h3>${esc(b.title)}</h3>
    <p class="sh-sub">${esc(STATUS_TXT[b.status])}${b.version > 1 ? ' · v' + b.version : ''} · ${b.rule === 'even' ? '按人头均摊' : '按房间权重'}${b.note ? ' · ' + esc(b.note) : ''}${timeoutPassed ? ' · 确认超时已自动通过' : ''}</p>
    <div class="card" style="text-align:center;box-shadow:none">
      <p class="sub" style="margin:0">账单总额</p>
      <div class="big">${fmt(b.amount)}</div>
      <p class="sub">垫付人：${esc(mName(b.payerId))} · 账期 ${esc(b.period || '—')}</p>
    </div>
    <p class="sub" style="font-weight:800;color:var(--ink-2);margin:14px 0 4px">分摊明细</p>
    <div class="rowlist">${rows}</div>
    <div class="divide"></div>
    <p class="sub">我的份额：<strong>${fmt(mine)}</strong>${me === b.payerId ? '（你是垫付人，应收 ' + fmt(b.amount - mine) + '）' : ''}</p>
    ${actions}
    ${hist ? `<p class="sub" style="font-weight:800;color:var(--ink-2);margin:14px 0 4px">变更记录</p><div class="rowlist">${hist}</div>` : ''}
    <div class="btnrow"><button class="btn link" data-act="close" type="button">关闭</button></div>
  `, 'bills');
}

/* ---------- 打卡 ---------- */
function sheetCheckin(id) {
  const t = S.tasks.find(x => x.id === id);
  if (!t) return;
  const list = (t.checklist || []).map((c, i) =>
    `<label class="chk"><input type="checkbox" data-chk="${i}" checked><span>${esc(c.t)}</span></label>`).join('')
    || `<p class="sub">这个区域还没有设置检查项</p>`;
  const late = t.date < todayStr();
  openSheet(`
    <h3>打卡 · ${esc(t.area)}</h3>
    <p class="sh-sub">${esc(dcn(t.date))} · ${esc(mName(t.assigneeId))} · 完成后贡献分 +${SCORE_RULES.shift.v}${late ? ' · <strong>补打</strong>' : ''}</p>
    <p class="sub" style="font-weight:800;color:var(--ink-2)">检查清单</p>
    ${list}
    <div class="field" style="margin-top:14px">
      <label>打卡照片</label>
      <div class="card" style="margin:0;text-align:center;color:var(--ink-3);font-size:13px;padding:18px">
        📷 点击模拟拍照上传（Demo 中以时间戳记录）
      </div>
    </div>
    <div class="btnrow">
      <button class="btn link" data-act="close" type="button">取消</button>
      <button class="btn" data-act="doCheckin" data-id="${t.id}" type="button">提交打卡</button>
    </div>
  `, 'shift');
}

/* ---------- 换班 ---------- */
function sheetSwap(id) {
  const t = S.tasks.find(x => x.id === id);
  if (!t) return;
  const opts = S.members.filter(m => m.id !== S.me).map(m => `<option value="${m.id}">${esc(m.name)} · ${esc(m.room)}</option>`).join('');
  openSheet(`
    <h3>申请换班</h3>
    <p class="sh-sub">${esc(dcn(t.date))} · ${esc(t.area)} · 需对方同意后生效，系统会留下变更记录</p>
    <div class="field"><label for="swTo">换给谁</label><select id="swTo">${opts}</select></div>
    <div class="field"><label for="swReason">原因（会显示给对方）</label><input id="swReason" value="当天出差，无法完成" maxlength="40"></div>
    <div class="btnrow">
      <button class="btn link" data-act="close" type="button">取消</button>
      <button class="btn" data-act="doSwap" data-id="${t.id}" type="button">发送换班申请</button>
    </div>
  `, 'shift');
}

/* ---------- 采购 ---------- */
function sheetBuy(id) {
  const i = S.items.find(x => x.id === id);
  if (!i) return;
  const per = S.members.length ? Math.round(fen(29.90) / S.members.length) : 0;
  openSheet(`
    <h3>认领采购 · ${esc(i.name)}</h3>
    <p class="sh-sub">买回后填入金额，系统会自动生成一张按人头分摊的账单</p>
    <div class="field"><label for="buyAmt">实际花费（元）</label><input id="buyAmt" type="number" step="0.01" min="0" value="29.90"></div>
    <div class="preview">
      <div class="ph">提交后会发生</div>
      <div class="rowitem"><span class="nm">生成一次性账单并自动分摊给 ${S.members.length} 人</span><span class="v">${fmt(per)}/人</span></div>
      <div class="rowitem"><span class="nm">${esc(i.name)} 库存回补</span><span class="v">${i.restockQty} ${esc(i.unit)}</span></div>
    </div>
    <div class="btnrow">
      <button class="btn link" data-act="close" type="button">取消</button>
      <button class="btn" data-act="doBuy" data-id="${i.id}" type="button">确认已购买</button>
    </div>
  `, 'items');
}

/* ============================================================
   9 · 通用编辑弹层（值日 / 物品 / 公约 / 提案 共用一套表单）
   ------------------------------------------------------------
   字段用数据描述，四个模块不必各写一遍结构，
   这样「编辑」入口的交互与视觉才完全一致。
   ============================================================ */
const CAT_PACT = ['费用与分摊', '卫生与清洁', '公共物品', '作息与噪音', '访客与安全', '其他'];

function fldHtml(f) {
  const id = 'f_' + f.k;
  const hint = f.hint ? `<p class="f-hint">${esc(f.hint)}</p>` : '';
  if (f.type === 'select') {
    return `<div class="field"><label for="${id}">${esc(f.label)}</label>
      <select id="${id}">${(f.options || []).map(x =>
      `<option value="${esc(x.v)}"${String(x.v) === String(f.value == null ? '' : f.value) ? ' selected' : ''}>${esc(x.t)}</option>`).join('')}</select>${hint}</div>`;
  }
  if (f.type === 'textarea') {
    return `<div class="field"><label for="${id}">${esc(f.label)}</label>
      <textarea id="${id}" rows="${f.rows || 2}" placeholder="${esc(f.ph || '')}">${esc(f.value == null ? '' : f.value)}</textarea>${hint}</div>`;
  }
  const attr = (f.min !== undefined ? ` min="${f.min}"` : '') + (f.max !== undefined ? ` max="${f.max}"` : '');
  return `<div class="field"><label for="${id}">${esc(f.label)}</label>
    <input id="${id}" type="${f.type || 'text'}"${attr} value="${esc(f.value == null ? '' : f.value)}" placeholder="${esc(f.ph || '')}">${hint}</div>`;
}

/* 读取表单值：keys 用空格分隔，省去每个模块各写一份取值代码 */
function readVals(keys) {
  const o = {};
  String(keys).split(/\s+/).forEach(k => {
    if (!k) return;
    const el = $('#f_' + k);
    o[k] = el ? String(el.value).trim() : '';
  });
  return o;
}

function formSheet(o) {
  openSheet(`
    <h3>${esc(o.title)}</h3>
    ${o.sub ? `<p class="sh-sub">${esc(o.sub)}</p>` : ''}
    ${(o.fields || []).map(fldHtml).join('')}
    <div class="btnrow" style="margin-top:20px">
      <button class="btn link" data-act="close" type="button">取消</button>
      <button class="btn" data-act="${o.act}" data-id="${o.id || ''}" type="button">${esc(o.okText || '保存')}</button>
    </div>
    ${o.footer || ''}
  `, o.tab || TAB);
}

/* 删除按钮：放在底部，视觉权重明显弱于「保存」 */
function delFooter(act, id, text) {
  return `<div class="btnrow" style="margin-top:10px">
    <button class="btn danger wide sm" data-act="${act}" data-id="${id}" type="button">${esc(text)}</button>
  </div>`;
}

/* 检查清单文本 ↔ 数组（同名的项保留原有完成状态） */
function parseList(str, area, prev) {
  const s = String(str || '').trim();
  if (!s) {
    if (prev && prev.length) return prev.map(c => ({ t: c.t, done: !!c.done }));
    const def = AREAS.find(a => a.name === area);
    return (def ? def.list : ['完成公共区域清洁']).map(x => ({ t: x, done: false }));
  }
  const done = {};
  (prev || []).forEach(c => { done[c.t] = !!c.done; });
  return s.split(/[、,，;；|]+/).map(x => x.trim()).filter(Boolean).map(x => ({ t: x, done: !!done[x] }));
}

/* 数值字段的解析与范围校验（避免把空字符串变成 NaN 写进数据） */
function num(v, name, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw BizError(name + '需要填数字');
  if (min !== undefined && n < min) throw BizError(name + '不能小于 ' + min);
  if (max !== undefined && n > max) throw BizError(name + '不能大于 ' + max);
  return n;
}

/* ---------- 值日 ---------- */
function taskForm(t) {
  const isNew = !t;
  const d = t || { date: todayStr(), area: AREAS[0].name, assigneeId: S.me, checklist: [] };
  const areaOpts = AREAS.map(a => ({ v: a.name, t: a.name }));
  if (!areaOpts.some(x => x.v === d.area)) areaOpts.push({ v: d.area, t: d.area });
  formSheet({
    title: isNew ? '新增排班' : '编辑排班',
    sub: isNew ? '手动插入一条值日安排' : dcn(d.date) + ' · ' + d.area,
    tab: 'shift',
    fields: [
      { k: 'date', label: '日期', type: 'date', value: d.date },
      { k: 'area', label: '区域', type: 'select', value: d.area, options: areaOpts },
      { k: 'assignee', label: '负责人', type: 'select', value: d.assigneeId, options: S.members.map(m => ({ v: m.id, t: m.name })) },
      {
        k: 'checklist', label: '检查清单', type: 'text', value: (d.checklist || []).map(c => c.t).join('、'),
        ph: '用「、」分隔', hint: '留空则使用该区域的默认清单'
      }
    ],
    okText: isNew ? '创建' : '保存修改',
    act: isNew ? 'taskNew' : 'taskSave',
    id: isNew ? '' : d.id,
    footer: isNew ? '' : delFooter('taskDel', d.id, '删除这条排班')
  });
}

/* ---------- 物品 ---------- */
function itemForm(i) {
  const isNew = !i;
  const d = i || { name: '', category: '消耗品', unit: '件', stock: 0, safety: 1, restockQty: 1, purchaserId: '', location: '' };
  const memberOpts = [{ v: '', t: '暂不指定' }].concat(S.members.map(m => ({ v: m.id, t: m.name })));
  formSheet({
    title: isNew ? '登记公共物品' : '编辑物品',
    sub: isNew ? '公用消耗品或共用的电器设备' : d.name,
    tab: 'items',
    fields: [
      { k: 'name', label: '名称', type: 'text', value: d.name, ph: '例如：垃圾袋' },
      {
        k: 'category', label: '类别', type: 'select', value: d.category,
        options: [{ v: '消耗品', t: '消耗品（会用完，需要补货）' }, { v: '共享设备', t: '共享设备（不消耗）' }]
      },
      { k: 'unit', label: '单位', type: 'text', value: d.unit, ph: '包 / 瓶 / 只 / 台' },
      { k: 'stock', label: '当前库存', type: 'number', value: d.stock, min: 0, hint: '改小库存等于登记一次消耗' },
      { k: 'safety', label: '安全库存', type: 'number', value: d.safety, min: 0, hint: '低于它就会提醒采购；填 0 表示不追踪' },
      { k: 'restockQty', label: '每次补货量', type: 'number', value: d.restockQty, min: 1 },
      { k: 'purchaserId', label: '采购负责人', type: 'select', value: d.purchaserId || '', options: memberOpts },
      { k: 'location', label: '存放位置', type: 'text', value: d.location, ph: '例如：厨房柜' }
    ],
    okText: isNew ? '添加' : '保存修改',
    act: isNew ? 'itemNew' : 'itemSave',
    id: isNew ? '' : d.id,
    footer: isNew ? '' : delFooter('itemDel', d.id, '删除这个物品')
  });
}

/* ---------- 公约 ---------- */
function pactForm(p) {
  const isNew = !p;
  const d = p || { text: '', category: '卫生与清洁', binding: '', enforceable: false };
  formSheet({
    title: isNew ? '新增公约条款' : '查看与编辑条款',
    sub: isNew ? '把容易起争执的事提前写成条款' : d.text,
    tab: 'pact',
    fields: [
      { k: 'text', label: '条款内容', type: 'textarea', value: d.text, ph: '例如：垃圾每日 22:00 前清运' },
      {
        k: 'category', label: '分类', type: 'select', value: CAT_PACT.indexOf(d.category) >= 0 ? d.category : '其他',
        options: CAT_PACT.map(c => ({ v: c, t: c }))
      },
      {
        k: 'enforceable', label: '能否被系统约束', type: 'select', value: d.enforceable ? '1' : '0',
        options: [{ v: '0', t: '仅靠自觉（系统无法约束）' }, { v: '1', t: '已绑定（由应用自动执行）' }]
      },
      {
        k: 'binding', label: '绑定说明', type: 'text', value: d.binding, ph: '例如：M1 · 账单默认分摊方式',
        hint: '会显示在条款下方；留空则不显示'
      }
    ],
    okText: isNew ? '添加条款' : '保存修改',
    act: isNew ? 'pactNew' : 'pactSave',
    id: isNew ? '' : d.id,
    footer: isNew ? '' : delFooter('pactDel', d.id, '删除这条条款')
  });
}

/* ---------- 提案 ---------- */
function voteForm(v) {
  const isNew = !v;
  const d = v || { text: '', threshold: Math.min(2, Math.max(1, S.members.length)), days: 2 };
  formSheet({
    title: isNew ? '发起提案' : '编辑提案',
    sub: isNew ? '拿不定主意的事，提出来让大家投个票' : d.text,
    tab: 'pact',
    fields: [
      { k: 'text', label: '提案内容', type: 'textarea', value: d.text, ph: '例如：夏天空调统一设定为 26℃' },
      {
        k: 'threshold', label: '通过票数', type: 'number', value: d.threshold, min: 1, max: Math.max(1, S.members.length),
        hint: '支持票达到这个数量即视为通过（当前房屋 ' + S.members.length + ' 人）'
      },
      { k: 'days', label: '截止（天后）', type: 'number', value: d.days || 2, min: 1, max: 30 }
    ],
    okText: isNew ? '发起' : '保存修改',
    act: isNew ? 'voteNew' : 'voteSave',
    id: isNew ? '' : d.id,
    footer: isNew ? '' : delFooter('voteDel', d.id, '删除这个提案')
  });
}

/* 公约改动后让版本号往前走一格 */
function bumpPactVersion() {
  const m = String(S.pactVersion || 'v1.0').match(/^v(\d+)\.(\d+)$/);
  S.pactVersion = m ? ('v' + m[1] + '.' + (Number(m[2]) + 1)) : 'v1.1';
}

/* 排班按日期排序（改了日期之后必须重排） */
function sortTasks() {
  S.tasks.sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)));
}

/* ---------- 结算单 ---------- */
function monthlyReport(period) {
  const bills = S.bills.filter(b => (b.period || String(b.date).slice(0, 7)) === period);
  const lines = [];
  lines.push('合租生活管家 · 月度结算单');
  lines.push('房屋：' + S.house.name + '    账期：' + period);
  lines.push('生成时间：' + timeTag());
  lines.push('');
  lines.push('一、本期账单（' + bills.length + ' 笔，合计 ' + fmt(bills.reduce((s, b) => s + b.amount, 0)) + '）');
  bills.forEach(b => {
    lines.push('  · ' + b.title + '  ' + fmt(b.amount) + '  垫付人：' + mName(b.payerId) + '  状态：' + STATUS_TXT[b.status]);
    (b.participants || []).forEach(id => {
      lines.push('      - ' + mName(id) + ' 应承担 ' + fmt(b.shares[id] || 0));
    });
  });
  const net = computeNet();
  lines.push('');
  lines.push('二、当前净额（正=应收，负=应付）');
  S.members.forEach(m => lines.push('  · ' + m.name + '：' + (net[m.id] > 0 ? '+' : '') + fmt(net[m.id])));
  const plan = planTransfers(net);
  lines.push('');
  lines.push('三、最少转账方案（' + plan.length + ' 笔）');
  if (!plan.length) lines.push('  已全部结清');
  plan.forEach(p => lines.push('  · ' + mName(p.from) + ' → ' + mName(p.to) + '  ' + fmt(p.amount)));
  return lines.join('\n');
}

function exitReport(memberId) {
  const net = computeNet();
  const n = net[memberId] || 0;
  const unpaid = S.bills.filter(b => b.status === 'unpaid' && (b.participants || []).indexOf(memberId) >= 0);
  const pending = S.tasks.filter(t => t.assigneeId === memberId && t.status === 'pending' && t.date >= todayStr());
  const mine = S.transfers.filter(t => t.from === memberId && t.status === 'pending');
  const lines = [];
  lines.push('合租生活管家 · 离场结算单');
  lines.push('房屋：' + S.house.name + '    成员：' + mName(memberId));
  lines.push('生成时间：' + timeTag());
  lines.push('');
  lines.push('一、资金');
  lines.push('  · 当前净额：' + (n > 0 ? '应收 ' + fmt(n) : (n < 0 ? '应付 ' + fmt(-n) : '已结清')));
  if (n < 0) lines.push('    建议：搬离前向垫付人支付 ' + fmt(-n) + '，或从押金中扣除');
  if (n > 0) lines.push('    建议：由其他成员补足 ' + fmt(n) + ' 后再办理离场');
  lines.push('  · 涉及未结清账单 ' + unpaid.length + ' 笔');
  mine.forEach(t => lines.push('  · 已标记转出但对方未确认：' + fmt(t.amount) + ' → ' + mName(t.to)));
  lines.push('');
  lines.push('二、未完成的值日（' + pending.length + ' 项）');
  if (!pending.length) lines.push('  无');
  pending.forEach(t => lines.push('  · ' + dcn(t.date) + ' ' + t.area));
  lines.push('');
  lines.push('三、确认');
  lines.push('  本单一经全体成员确认，该成员的所有债权债务即视为结清并归档。');
  return lines.join('\n');
}

let LAST_TEXT = '';

function sheetText(title, text) {
  LAST_TEXT = text;
  openSheet(`
    <h3>${esc(title)}</h3>
    <p class="sh-sub">可复制或下载保存</p>
    <textarea id="txtOut" readonly style="width:100%;height:250px;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.7;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--line-2);resize:vertical;color:var(--ink)">${esc(text)}</textarea>
    <div class="btnrow">
      <button class="btn ghost" data-act="copyText" type="button">复制全文</button>
      <button class="btn" data-act="downloadText" type="button">下载文件</button>
    </div>
    <div class="btnrow"><button class="btn link" data-act="close" type="button">关闭</button></div>
  `);
}

/* ============================================================
   7 · 动作（所有写操作先过状态校验，非法一律拒绝）
   ============================================================ */
const ACT = {
  tab(el, id) {
    if (TAB === id) return;                       /* 点当前 tab 不重放动画 */
    TAB = id; if (id === 'bills') BILLTAB = 'list';
    closeSheet(); render(); viewIn(); window.scrollTo(0, 0);
  },
  bills() { BILLTAB = 'list'; render(); viewIn(); },
  settle() { TAB = 'bills'; BILLTAB = 'settle'; closeSheet(); render(); viewIn(); window.scrollTo(0, 0); },
  close() { closeSheet(); },

  /* ============================================================
     值日排班：新增 / 编辑 / 删除
     ============================================================ */
  newTask() {
    if (!S.members.length) { toast('房屋里还没有成员'); return; }
    taskForm(null);
  },
  editTask(el, id) {
    const t = S.tasks.find(x => x.id === id);
    if (!t) { toast('这条排班已经不存在了'); return; }
    taskForm(t);
  },
  taskNew() {
    try {
      const v = readVals('date area assignee checklist');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) throw BizError('请选择日期');
      const who = S.members.find(m => m.id === v.assignee);
      if (!who) throw BizError('负责人必须是房屋成员');
      const area = v.area || '值日';
      if (S.tasks.some(t => t.date === v.date)) throw BizError(dcn(v.date) + ' 已经有一条排班，请直接编辑那一条');
      const today = todayStr();
      S.tasks.push({
        id: uid('t'), area, date: v.date, assigneeId: who.id, originalAssigneeId: who.id,
        status: v.date < today ? 'done' : 'pending',
        checklist: parseList(v.checklist, area, null),
        proofAt: v.date < today ? '—' : null,
        isLateCheckin: false, verifiedBy: null, overdue: false,
        history: [{ at: Date.now(), what: '由 ' + mName(S.me) + ' 手动新增' }]
      });
      sortTasks();
      save(); closeSheet(); render(); toast('已新增 ' + dcn(v.date) + ' 的排班');
    } catch (e) { fail(e); }
  },
  taskSave(el, id) {
    try {
      const t = S.tasks.find(x => x.id === id);
      if (!t) throw BizError('这条排班已经不存在了');
      const v = readVals('date area assignee checklist');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) throw BizError('请选择日期');
      const who = S.members.find(m => m.id === v.assignee);
      if (!who) throw BizError('负责人必须是房屋成员');
      if (S.tasks.some(x => x.id !== t.id && x.date === v.date)) throw BizError(dcn(v.date) + ' 已经有另一条排班了');
      t.date = v.date;
      t.area = v.area || t.area;
      t.assigneeId = who.id;
      t.originalAssigneeId = who.id;
      t.checklist = parseList(v.checklist, t.area, t.checklist);
      if (t.status === 'done') t.checklist.forEach(c => { c.done = true; });
      t.history = t.history || [];
      t.history.push({ at: Date.now(), what: '由 ' + mName(S.me) + ' 修改排班' });
      sortTasks();
      save(); closeSheet(); render(); toast('排班已更新');
    } catch (e) { fail(e); }
  },
  taskDel(el, id) {
    const t = S.tasks.find(x => x.id === id);
    if (!t) { toast('这条排班已经不存在了'); return; }
    sheetConfirm('删除这条排班？', [
      dcn(t.date) + ' · ' + t.area,
      '负责人：' + mName(t.assigneeId),
      '删除后不会自动补回'
    ], '确认删除', 'taskDelDo', id, true);
  },
  taskDelDo(el, id) {
    const i = S.tasks.findIndex(x => x.id === id);
    if (i < 0) { toast('这条排班已经不存在了'); closeSheet(); return; }
    S.tasks.splice(i, 1);
    save(); closeSheet(); render(); toast('已删除这条排班');
  },

  /* ============================================================
     公共物品：登记 / 编辑 / 删除
     ============================================================ */
  newItem() { itemForm(null); },
  editItem(el, id) {
    const i = S.items.find(x => x.id === id);
    if (!i) { toast('这个物品已经不存在了'); return; }
    itemForm(i);
  },
  itemNew() {
    try {
      const v = readVals('name category unit stock safety restockQty purchaserId location');
      const name = v.name;
      if (!name) throw BizError('请填写物品名称');
      if (name.length > 20) throw BizError('名称不要超过 20 个字');
      if (S.items.some(i => i.name === name)) throw BizError('已经有同名的物品了');
      S.items.push({
        id: uid('i'), name,
        category: v.category === '共享设备' ? '共享设备' : '消耗品',
        stock: Math.round(num(v.stock, '当前库存', 0, 99999)),
        safety: Math.round(num(v.safety, '安全库存', 0, 99999)),
        restockQty: Math.round(num(v.restockQty, '每次补货量', 1, 9999)),
        unit: v.unit || '件', days: 0,
        purchaserId: v.purchaserId || null,
        scope: 'all', location: v.location || '', borrow: null
      });
      save(); closeSheet(); render(); toast('已添加「' + name + '」');
    } catch (e) { fail(e); }
  },
  itemSave(el, id) {
    try {
      const it = S.items.find(x => x.id === id);
      if (!it) throw BizError('这个物品已经不存在了');
      const v = readVals('name category unit stock safety restockQty purchaserId location');
      const name = v.name;
      if (!name) throw BizError('请填写物品名称');
      if (name.length > 20) throw BizError('名称不要超过 20 个字');
      if (S.items.some(x => x.id !== it.id && x.name === name)) throw BizError('已经有同名的物品了');
      it.name = name;
      it.category = v.category === '共享设备' ? '共享设备' : '消耗品';
      it.unit = v.unit || '件';
      it.stock = Math.round(num(v.stock, '当前库存', 0, 99999));
      it.safety = Math.round(num(v.safety, '安全库存', 0, 99999));
      it.restockQty = Math.round(num(v.restockQty, '每次补货量', 1, 9999));
      it.purchaserId = v.purchaserId || null;
      it.location = v.location || '';
      save(); closeSheet(); render(); toast('物品已更新');
    } catch (e) { fail(e); }
  },
  itemDel(el, id) {
    const i = S.items.find(x => x.id === id);
    if (!i) { toast('这个物品已经不存在了'); return; }
    const task = activeRestock(id);
    sheetConfirm('删除「' + i.name + '」？', [
      task ? '它有进行中的采购任务，会一并取消' : '物品记录会被移除',
      '已经生成的账单不受影响',
      '删除后无法自动恢复'
    ], '确认删除', 'itemDelDo', id, true);
  },
  itemDelDo(el, id) {
    const i = S.items.find(x => x.id === id);
    if (!i) { toast('这个物品已经不存在了'); closeSheet(); return; }
    S.items = S.items.filter(x => x.id !== id);
    /* 关联的采购任务一并清掉，避免留下指向已删物品的孤儿记录 */
    S.restocks = (S.restocks || []).filter(r => r.itemId !== id);
    save(); closeSheet(); render(); toast('已删除「' + i.name + '」');
  },

  /* ============================================================
     室友公约：查看 / 新增 / 编辑 / 删除
     ============================================================ */
  newPact() { pactForm(null); },
  editPact(el, id) {
    const p = S.pacts.find(x => x.id === id);
    if (!p) { toast('这条条款已经不存在了'); return; }
    pactForm(p);
  },
  pactNew() {
    try {
      const v = readVals('text category enforceable binding');
      const text = v.text;
      if (text.length < 2) throw BizError('条款内容太短');
      if (text.length > 60) throw BizError('条款内容不要超过 60 个字');
      const enf = v.enforceable === '1';
      S.pacts.push({
        id: uid('p'), text, category: v.category,
        binding: v.binding || (enf ? '已绑定系统规则' : '仅靠自觉，系统无法约束'),
        enforceable: enf, rule: null
      });
      bumpPactVersion();
      save(); closeSheet(); render(); toast('已添加条款，公约更新为 ' + S.pactVersion);
    } catch (e) { fail(e); }
  },
  pactSave(el, id) {
    try {
      const p = S.pacts.find(x => x.id === id);
      if (!p) throw BizError('这条条款已经不存在了');
      const v = readVals('text category enforceable binding');
      const text = v.text;
      if (text.length < 2) throw BizError('条款内容太短');
      if (text.length > 60) throw BizError('条款内容不要超过 60 个字');
      const enf = v.enforceable === '1';
      p.text = text;
      p.category = v.category;
      p.enforceable = enf;
      p.binding = v.binding || (enf ? '已绑定系统规则' : '仅靠自觉，系统无法约束');
      bumpPactVersion();
      save(); closeSheet(); render(); toast('条款已更新，公约升为 ' + S.pactVersion);
    } catch (e) { fail(e); }
  },
  pactDel(el, id) {
    const p = S.pacts.find(x => x.id === id);
    if (!p) { toast('这条条款已经不存在了'); return; }
    sheetConfirm('删除这条条款？', [p.text, '删除后公约版本会向前走一格', '这个动作无法自动撤销'], '确认删除', 'pactDelDo', id, true);
  },
  pactDelDo(el, id) {
    const i = S.pacts.findIndex(x => x.id === id);
    if (i < 0) { toast('这条条款已经不存在了'); closeSheet(); return; }
    S.pacts.splice(i, 1);
    bumpPactVersion();
    save(); closeSheet(); render(); toast('条款已删除，公约更新为 ' + S.pactVersion);
  },

  /* ============================================================
     提案与投票：发起 / 编辑 / 删除
     ============================================================ */
  newVote() { voteForm(null); },
  editVote(el, id) {
    const v = S.votes.find(x => x.id === id);
    if (!v) { toast('这个提案已经不存在了'); return; }
    voteForm(v);
  },
  voteNew() {
    try {
      const v = readVals('text threshold days');
      const text = v.text;
      if (text.length < 2) throw BizError('提案内容太短');
      if (text.length > 60) throw BizError('提案内容不要超过 60 个字');
      const threshold = Math.round(num(v.threshold, '通过票数', 1, Math.max(1, S.members.length)));
      const days = Math.round(num(v.days, '截止天数', 1, 30));
      S.votes.push({
        id: uid('v'), text, support: [], against: [],
        deadline: days + ' 天后截止',
        deadlineAt: Date.now() + days * 86400000,
        threshold, closed: false, anonymous: false
      });
      save(); closeSheet(); render(); toast('提案已发起，等大家投票');
    } catch (e) { fail(e); }
  },
  voteSave(el, id) {
    try {
      const v0 = S.votes.find(x => x.id === id);
      if (!v0) throw BizError('这个提案已经不存在了');
      const v = readVals('text threshold days');
      const text = v.text;
      if (text.length < 2) throw BizError('提案内容太短');
      if (text.length > 60) throw BizError('提案内容不要超过 60 个字');
      v0.text = text;
      v0.threshold = Math.round(num(v.threshold, '通过票数', 1, Math.max(1, S.members.length)));
      const days = Math.round(num(v.days, '截止天数', 1, 30));
      v0.deadline = days + ' 天后截止';
      v0.deadlineAt = Date.now() + days * 86400000;
      save(); closeSheet(); render(); toast('提案已更新');
    } catch (e) { fail(e); }
  },
  voteDel(el, id) {
    const v = S.votes.find(x => x.id === id);
    if (!v) { toast('这个提案已经不存在了'); return; }
    sheetConfirm('删除这个提案？', [v.text, '已有的投票记录会一并消失', '这个动作无法自动撤销'], '确认删除', 'voteDelDo', id, true);
  },
  voteDelDo(el, id) {
    const i = S.votes.findIndex(x => x.id === id);
    if (i < 0) { toast('这个提案已经不存在了'); closeSheet(); return; }
    S.votes.splice(i, 1);
    save(); closeSheet(); render(); toast('提案已删除');
  },

  /* ---- 账单 ---- */
  newbill() {
    if (S.members.length < 2) { toast('房屋至少需要 2 名成员才能分摊'); return; }
    sheetNewBill();
  },
  bill(el, id) { sheetBill(id); },

  createBill() {
    try {
      const title = ($('#nbTitle').value || '').trim() || '未命名账单';
      const amtFen = fen($('#nbAmt').value);
      if (amtFen <= 0) throw BizError('金额需要大于 0');
      if (amtFen > fen(1000000)) throw BizError('金额超过 100 万，请先确认输入是否正确');
      const payer = $('#nbPayer').value;
      if (!S.members.some(m => m.id === payer)) throw BizError('垫付人不在成员名单中');
      const rule = $('#nbRule').value;
      const participants = S.members.map(m => m.id);
      if (participants.length < 2) throw BizError('至少需要 2 名成员才能分摊');

      /* 幂等：防止双击/重复提交 */
      const dup = S.bills.find(b => b.title === title && b.amount === amtFen && (Date.now() - (b.createdAt || 0) < 60000));
      if (dup) throw BizError('一分钟内已经创建过一笔相同的账单');

      const shares = computeShares(amtFen, rule, payer, participants);   // 内部含守恒断言
      const confirm = {}; participants.forEach(id => confirm[id] = id === S.me ? 'ok' : 'pending');
      const now = Date.now();
      S.bills.unshift({
        id: uid('b'), title, category: $('#nbCat').value, amount: amtFen,
        payerId: payer, rule, participants,
        weightSnapshot: S.members.reduce((a, m) => (a[m.id] = m.weight || 1, a), {}),
        shares, confirm, status: 'confirming',
        date: todayStr(), period: todayStr().slice(0, 7), version: 1,
        dueAt: now + CONFIRM_HOURS * 3600000, createdAt: now,
        note: ($('#nbNote').value || '').trim(), meter: null,
        history: [{ version: 1, at: now, by: S.me, what: '创建账单' }]
      });
      save(); closeSheet(); toast('已创建，等待其他室友确认');
      TAB = 'bills'; BILLTAB = 'list'; render();
    } catch (e) { fail(e); }
  },

  ok(el, id) {
    try {
      const b = S.bills.find(x => x.id === id);
      if (!b) throw BizError('账单不存在');
      if (b.status !== 'confirming') throw BizError('该账单已不在待确认状态');
      if (b.confirm[S.me] === 'ok') throw BizError('你已经确认过这笔账了');
      b.confirm[S.me] = 'ok';
      b.status = billStatusOf(b);
      b.history = b.history || [];
      b.history.push({ version: b.version, at: Date.now(), by: S.me, what: '确认账单' });
      save(); closeSheet();
      toast(b.status === 'unpaid' ? '全员已确认，该笔进入待支付' : '已确认');
      render();
    } catch (e) { fail(e); }
  },

  dispute(el, id) {
    try {
      const b = S.bills.find(x => x.id === id);
      if (!b) throw BizError('账单不存在');
      if (b.status !== 'confirming') throw BizError('该账单已不在待确认状态');
      b.confirm[S.me] = 'dispute';
      b.status = 'disputed';
      b.history = b.history || [];
      b.history.push({ version: b.version, at: Date.now(), by: S.me, what: '提出异议' });
      save(); closeSheet(); toast('已提交异议，账单进入协商'); render();
    } catch (e) { fail(e); }
  },

  revise(el, id) {
    try {
      const b = S.bills.find(x => x.id === id);
      if (!b) throw BizError('账单不存在');
      if (b.status === 'settled') throw BizError('已结清的账单不能再修订，请另行发起一笔修正账单');
      /* 关键：用创建时的参与人与权重快照重算，不用当前成员表 */
      const parts = b.participants && b.participants.length ? b.participants : S.members.map(m => m.id);
      const sh = computeShares(b.amount, b.rule, b.payerId, parts);
      b.version += 1;
      b.shares = sh;
      b.confirm = {}; parts.forEach(id => b.confirm[id] = 'pending');
      b.status = 'confirming';
      b.dueAt = Date.now() + CONFIRM_HOURS * 3600000;
      b.history = b.history || [];
      b.history.push({ version: b.version, at: Date.now(), by: S.me, what: '提交修订（v' + (b.version - 1) + ' → v' + b.version + '）' });
      save(); closeSheet(); toast('已生成 v' + b.version + '，重新推送全员确认'); render();
    } catch (e) { fail(e); }
  },

  /* ---- 结算 ---- */
  paid(el) {
    try {
      const from = el.dataset.from, to = el.dataset.to;
      const amount = Number(el.dataset.amt);
      if (!(amount > 0)) throw BizError('转账金额异常');
      const dup = S.transfers.find(t => t.from === from && t.to === to && t.amount === amount && t.status === 'pending');
      if (dup) throw BizError('这笔转账已经标记过了，正在等待对方确认');
      const alloc = allocateFor(from, to, amount);
      S.transfers.push({
        id: uid('tr'), from, to, amount, allocations: alloc.allocations,
        paidAt: nowHM(), paidAtMs: Date.now(), receivedAt: null, status: 'pending', voidReason: null
      });
      save(); toast('已标记转账，等待对方确认收款' + (alloc.leftover > 0 ? '（含未归属金额 ' + fmt(alloc.leftover) + '）' : ''));
      render();
    } catch (e) { fail(e); }
  },

  fakePaid(el) {
    try {
      const from = el.dataset.from, to = el.dataset.to;
      const amount = Number(el.dataset.amt);
      if (!(amount > 0)) throw BizError('转账金额异常');
      const alloc = allocateFor(from, to, amount);
      S.transfers.push({
        id: uid('tr'), from, to, amount, allocations: alloc.allocations,
        paidAt: nowHM(), paidAtMs: Date.now(), receivedAt: null, status: 'pending', voidReason: null
      });
      save(); toast('模拟：' + mName(from) + ' 已标记转账'); render();
    } catch (e) { fail(e); }
  },

  recv(el, id) {
    try {
      const t = S.transfers.find(x => x.id === id);
      if (!t) throw BizError('转账记录不存在');
      if (t.status !== 'pending') throw BizError('这笔转账已经处理过了');
      t.status = 'received'; t.receivedAt = nowHM();
      checkSettled(); save(); toast('已确认收款，相关账单份额随之结清'); render();
    } catch (e) { fail(e); }
  },

  rejectTransfer(el, id) {
    try {
      const t = S.transfers.find(x => x.id === id);
      if (!t) throw BizError('转账记录不存在');
      if (t.status !== 'pending') throw BizError('这笔转账已经处理过了');
      t.status = 'void'; t.voidReason = '收款方表示未收到';
      save(); toast('已标记「未收到」，该笔转账作废，债务回到原状'); render();
    } catch (e) { fail(e); }
  },

  voidTransfer(el, id) {
    try {
      const t = S.transfers.find(x => x.id === id);
      if (!t) throw BizError('转账记录不存在');
      if (t.status !== 'pending') throw BizError('只有等待确认的转账才能撤回');
      t.status = 'void'; t.voidReason = '发起方主动撤回';
      save(); toast('已撤回该笔转账'); render();
    } catch (e) { fail(e); }
  },

  /* ---- 值日 ---- */
  checkin(el, id) { sheetCheckin(id); },
  swap(el, id) {
    try {
      const t = S.tasks.find(x => x.id === id);
      if (!t) throw BizError('任务不存在');
      if (t.status !== 'pending') throw BizError('该任务已完成，不需要换班');
      if (t.assigneeId !== S.me) throw BizError('只能换自己的任务');
      if (S.members.length < 2) throw BizError('房屋只有你一人，无人可换');
      if (S.swaps.some(s => s.taskId === t.id && s.status === 'pending')) throw BizError('该任务已有正在等待响应的换班申请');
      sheetSwap(id);
    } catch (e) { fail(e); }
  },

  doCheckin(el, id) {
    try {
      const t = S.tasks.find(x => x.id === id);
      if (!t) throw BizError('任务不存在');
      if (t.status !== 'pending') throw BizError('该任务已完成，不能重复打卡');
      if (t.assigneeId !== S.me) throw BizError('这不是你的任务');
      const today = todayStr();
      if (t.date > today) throw BizError('任务还没到日期，不能提前打卡');
      const gap = daysBetween(t.date, today);
      if (gap > GRACE_DAYS) throw BizError('已超过 ' + GRACE_DAYS + ' 天的补打期限');

      document.querySelectorAll('[data-chk]').forEach((b, i) => { if (t.checklist[i]) t.checklist[i].done = b.checked; });
      t.status = 'done';
      t.proofAt = nowHM();
      t.proofAtMs = Date.now();
      t.isLateCheckin = gap > 0;
      t.history = t.history || [];
      t.history.push({ at: Date.now(), what: (gap > 0 ? '补打' : '打卡完成') + '（' + nowHM() + '）' });
      addScore(S.me, 'shift', t.area);
      save(); closeSheet();
      toast('打卡成功，贡献分 +' + SCORE_RULES.shift.v);
      render();
    } catch (e) { fail(e); }
  },

  doSwap(el, id) {
    try {
      const t = S.tasks.find(x => x.id === id);
      if (!t) throw BizError('任务不存在');
      if (t.status !== 'pending') throw BizError('该任务已完成，不需要换班');
      if (t.assigneeId !== S.me) throw BizError('只能换自己的任务');
      if (S.swaps.some(s => s.taskId === t.id && s.status === 'pending')) throw BizError('该任务已有等待响应的换班申请');
      const to = $('#swTo').value;
      if (to === S.me) throw BizError('不能换给自己');
      if (!S.members.some(m => m.id === to)) throw BizError('对方不在成员名单中');
      S.swaps.push({ id: uid('sw'), taskId: t.id, from: S.me, to, reason: ($('#swReason').value || '').trim(), status: 'pending', at: Date.now() });
      save(); closeSheet();
      toast('换班申请已发送给 ' + mName(to) + '，切换身份即可响应');
      render();
    } catch (e) { fail(e); }
  },

  swapOk(el, id) {
    try {
      const s = S.swaps.find(x => x.id === id);
      if (!s) throw BizError('申请不存在');
      if (s.status !== 'pending') throw BizError('该申请已经处理过了');
      const t = S.tasks.find(x => x.id === s.taskId);
      if (!t) { s.status = 'voided'; save(); throw BizError('任务已不存在，申请自动作废'); }
      if (t.status !== 'pending') {
        s.status = 'voided'; save(); render();
        throw BizError('该任务已经完成，换班申请自动作废');
      }
      t.originalAssigneeId = t.originalAssigneeId || t.assigneeId;
      t.assigneeId = s.to;
      t.history = t.history || [];
      t.history.push({ at: Date.now(), what: mName(s.from) + ' 换班给 ' + mName(s.to) + '（' + s.reason + '）' });
      s.status = 'accepted'; s.respondedAt = Date.now();
      /* 同一任务的其它待响应申请一并作废 */
      S.swaps.forEach(x => { if (x.taskId === t.id && x.id !== s.id && x.status === 'pending') x.status = 'voided'; });
      save(); toast('已同意换班，排班已更新并留痕'); render();
    } catch (e) { fail(e); }
  },

  swapNo(el, id) {
    try {
      const s = S.swaps.find(x => x.id === id);
      if (!s) throw BizError('申请不存在');
      if (s.status !== 'pending') throw BizError('该申请已经处理过了');
      s.status = 'rejected'; s.respondedAt = Date.now();
      save(); toast('已拒绝换班申请'); render();
    } catch (e) { fail(e); }
  },

  voucher() {
    try { useVoucher(S.me); save(); toast('已获得一次值日豁免（下一项任务可跳过）'); render(); }
    catch (e) { fail(e); }
  },

  /* ---- 物品 ---- */
  empty(el, id) {
    try {
      const i = S.items.find(x => x.id === id);
      if (!i) throw BizError('物品不存在');
      i.stock = 0; i.days = 0;
      /* 确保存在一条待认领的补货任务 */
      if (!activeRestock(i.id)) {
        S.restocks.push({ id: uid('rk'), itemId: i.id, assigneeId: null, status: 'open', amount: 0, billId: null, claimedAt: null, doneAt: null, createdAt: Date.now() });
      }
      save();
      toast('已标记「快没了」，采购负责人 ' + mName(i.purchaserId) + ' 已收到提醒');
      render();
    } catch (e) { fail(e); }
  },

  buy(el, id) {
    try {
      const i = S.items.find(x => x.id === id);
      if (!i) throw BizError('物品不存在');
      const task = activeRestock(i.id);
      if (task && task.status === 'claimed' && task.assigneeId !== S.me) throw BizError(mName(task.assigneeId) + ' 已经认领了这项采购');
      if (task && task.status === 'claimed' && task.assigneeId === S.me) { /* 自己认领过，继续购买 */ }
      else if (!task) {
        S.restocks.push({ id: uid('rk'), itemId: i.id, assigneeId: S.me, status: 'claimed', amount: 0, billId: null, claimedAt: Date.now(), doneAt: null, createdAt: Date.now() });
      } else {
        task.assigneeId = S.me; task.status = 'claimed'; task.claimedAt = Date.now();
      }
      save();
      sheetBuy(id);
    } catch (e) { fail(e); }
  },

  doBuy(el, id) {
    try {
      const i = S.items.find(x => x.id === id);
      if (!i) throw BizError('物品不存在');
      const amtFen = fen($('#buyAmt').value);
      if (amtFen <= 0) throw BizError('请填写实际花费');
      const participants = S.members.map(m => m.id);
      if (participants.length < 1) throw BizError('没有可分摊的成员');
      const shares = computeShares(amtFen, 'even', S.me, participants);
      const confirm = {}; participants.forEach(mid => confirm[mid] = mid === S.me ? 'ok' : 'pending');
      const now = Date.now();
      const billId = uid('b');
      S.bills.unshift({
        id: billId, title: '公共采购 · ' + i.name, category: '日用品', amount: amtFen,
        payerId: S.me, rule: 'even', participants,
        weightSnapshot: S.members.reduce((a, m) => (a[m.id] = m.weight || 1, a), {}),
        shares, confirm, status: 'confirming',
        date: todayStr(), period: todayStr().slice(0, 7), version: 1,
        dueAt: now + CONFIRM_HOURS * 3600000, createdAt: now,
        note: '由物品模块自动生成', meter: null,
        history: [{ version: 1, at: now, by: S.me, what: '由采购任务自动生成' }]
      });
      const task = activeRestock(i.id);
      if (task) { task.status = 'done'; task.assigneeId = S.me; task.amount = amtFen; task.billId = billId; task.doneAt = now; }
      i.stock = i.restockQty || Math.max(1, i.safety * 3);
      i.days = 30;
      addScore(S.me, 'purchase', i.name);
      save(); closeSheet();
      toast('已生成账单并回补库存到 ' + i.stock + ' ' + i.unit + '，贡献分 +' + SCORE_RULES.purchase.v);
      TAB = 'items'; render();
    } catch (e) { fail(e); }
  },

  nudge(el, id) {
    const r = S.restocks.find(x => x.id === id);
    toast(r ? '已提醒 ' + mName(r.assigneeId) : '已提醒');
  },

  vote(el, id) {
    try {
      const v = S.votes.find(x => x.id === id);
      if (!v) throw BizError('提案不存在');
      if (v.closed) throw BizError('该提案已结束投票');
      const yes = el.dataset.v === '1';
      const add = yes ? 'support' : 'against', del = yes ? 'against' : 'support';
      const at = v[add].indexOf(S.me);
      if (at >= 0) v[add].splice(at, 1);
      else { v[add].push(S.me); const d = v[del].indexOf(S.me); if (d >= 0) v[del].splice(d, 1); }
      save(); render();
    } catch (e) { fail(e); }
  },

  /* ---- 数据管理 ---- */
  exportData() {
    const text = exportText();
    const name = 'roomies-backup-' + todayStr() + '.json';
    if (download(name, text, 'application/json')) toast('已导出备份文件');
    else sheetText('导出备份（手动保存）', text);
  },

  importData() {
    try {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        const fr = new FileReader();
        fr.onload = () => {
          try {
            const cur = S;
            const next = importText(String(fr.result));
            next.me = next.members.some(m => m.id === cur.me) ? cur.me : (next.members[0] || {}).id;
            S = next;
            REPAIRS = [];
            checkSettled();
            const rs = save();
            if (!rs.ok) throw BizError('导入成功但未能写入本地存储');
            closeSheet(); render();
            toast('导入成功：' + S.bills.length + ' 笔账单、' + S.members.length + ' 名成员');
          } catch (e) { fail(e); }
        };
        fr.onerror = () => toast('读取文件失败');
        fr.readAsText(f);
      };
      inp.click();
    } catch (e) { fail(e); }
  },

  monthlyReport() {
    try { sheetText('月度结算单 · ' + todayStr().slice(0, 7), monthlyReport(todayStr().slice(0, 7))); }
    catch (e) { fail(e); }
  },

  exitReport() {
    const opts = S.members.map(m => `<option value="${m.id}">${esc(m.name)} · ${esc(m.room)}</option>`).join('');
    openSheet(`
      <h3>生成离场结算单</h3>
      <p class="sh-sub">用于成员搬离时结清债权债务，生成后请由其余成员共同确认</p>
      <div class="field"><label for="exitWho">要结算哪位成员</label><select id="exitWho">${opts}</select></div>
      <div class="btnrow">
        <button class="btn link" data-act="close" type="button">取消</button>
        <button class="btn" data-act="doExitReport" type="button">生成结算单</button>
      </div>
    `);
  },

  doExitReport() {
    try {
      const id = $('#exitWho').value;
      if (!S.members.some(m => m.id === id)) throw BizError('成员不存在');
      sheetText('离场结算单 · ' + mName(id), exitReport(id));
    } catch (e) { fail(e); }
  },

  copyText() {
    const ta = $('#txtOut');
    if (!ta) return;
    try { ta.select(); document.execCommand('copy'); toast('已复制到剪贴板'); }
    catch (e) { toast('复制失败，请手动选择文本后复制'); }
  },

  downloadText() {
    if (download('roomies-' + todayStr() + '.txt', LAST_TEXT, 'text/plain')) toast('已下载');
    else toast('当前环境不支持下载，请手动复制');
  },

  resetAsk() {
    sheetConfirm('清空这间房屋的全部数据？', [
      '账单、值日、物品、公约记录都会被删除',
      '房屋会回到刚创建时的空白状态',
      '这个动作无法自动撤销，建议先「导出备份」'
    ], '确认清空', 'resetDo', null, true);
  },

  resetDo() {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    /* 客户端语义：清空后回到空白房屋，而不是载入演示数据 */
    S = emptyState(CURRENT || { name: '我' });
    REPAIRS = [];
    save();
    TAB = 'home'; BILLTAB = 'list';
    closeSheet(); render();
    toast('已清空，房屋恢复空白');
  },

  brokenNotice() {
    closeSheet();
    const raw = STORAGE_BROKEN;
    if (!raw) return;
    sheetText('原始数据副本', raw);
  }
};

