/* ============================================================
   合租生活管家 · 业务逻辑回归与边界验证
   （针对 index.html —— 现在根路径就是带账号的客户端）
   每个实例会预置一个「已登录账号」，直接进入主壳后测试业务逻辑。

   场景 A 基础回归（保证功能不退化）
   场景 B 数据迁移  v1(元) → v2(分)
   场景 C 数据损坏  必须备份而非静默重置
   场景 D 状态机与边界（打卡/超时/重复确认）
   场景 E 结算      逐账单判定，互相抵消不得误标结清
   场景 F 无障碍    ESC 关闭 / 锁定背景滚动 / 焦点管理

   运行：node tools/verify.cjs
   依赖：npm install jsdom
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const KEY = 'roomies_data_t1';                 // 预置测试账号的数据键
const ACC_KEY = 'roomies_accounts';
const SESSION_KEY = 'roomies_session';
const TEST_ACC = { id: 't1', name: '测试员', salt: 's', hash: 'weak:probe', hue: 200, glyph: '★', createdAt: 0, lastLoginAt: 0, houseOwnerId: 't1', memberId: 'm3', claimDemo: true };
const URL_ = 'http://localhost:8080/';

const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

/* 场景 A 用的默认房屋：3 位成员 + 一笔待确认账单，用来验证业务逻辑本身。
   注意不能用演示种子（现在的空账号会得到空房屋），所以这里显式给一份。 */
function defaultHouse() {
  const ds = iso(new Date());
  return JSON.stringify({
    schemaVersion: 2,
    house: { name: '安心小屋', inviteCode: 'TEST01' },
    pactVersion: 'v1.2',
    me: 'm3',
    members: [
      { id: 'm1', name: '小林', room: '主卧', weight: 1.2, joinedAt: ds },
      { id: 'm2', name: '小周', room: '次卧', weight: 1.0, joinedAt: ds },
      { id: 'm3', name: '小陈', room: '小卧', weight: 0.8, joinedAt: ds }
    ],
    bills: [{
      id: 'b1', title: '电费 2026-09', category: '水电', amount: 28640, payerId: 'm1', rule: 'even',
      participants: ['m1', 'm2', 'm3'], weightSnapshot: { m1: 1.2, m2: 1.0, m3: 0.8 },
      shares: { m1: 9548, m2: 9546, m3: 9546 }, confirm: { m1: 'ok', m2: 'ok', m3: 'pending' },
      status: 'confirming', date: ds, period: ds.slice(0, 7), version: 1,
      dueAt: Date.now() + 3600000, createdAt: Date.now(), note: '抄表 1842 → 2214 kWh',
      meter: null, history: []
    }],
    transfers: [], tasks: [], swaps: [],
    items: [
      { id: 'i1', name: '抽纸', category: '消耗品', stock: 0, safety: 2, restockQty: 6, unit: '包', purchaserId: 'm2', scope: 'all' },
      { id: 'i2', name: '垃圾袋', category: '消耗品', stock: 36, safety: 10, restockQty: 60, unit: '只', purchaserId: 'm3', scope: 'all' }
    ],
    restocks: [], scoreLog: [], voucher: {},
    pacts: [
      { id: 'p1', text: '房租、水电、燃气按人头均摊', category: '费用与分摊', binding: 'M1 · 账单默认分摊方式', enforceable: true, rule: null },
      { id: 'p6', text: '马桶圈用完放下', category: '卫生与清洁', binding: '仅靠自觉，系统无法约束', enforceable: false, rule: null }
    ],
    votes: [{ id: 'v1', text: '夏天空调统一设定为 26℃', support: ['m1', 'm2'], against: [], deadline: '2 天后截止', deadlineAt: Date.now() + 172800000, threshold: 2, closed: false }]
  });
}

let pass = 0, fail = 0;
const fails = [];

function check(label, ok, extra) {
  if (ok) { pass++; console.log('PASS  ' + label + (extra ? '  → ' + extra : '')); }
  else { fail++; fails.push(label); console.log('FAIL  ' + label + (extra ? '  → ' + extra : '')); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

function makeDom(seedValue, opts) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/scrollTo|Not implemented/.test(e.message)) errors.push(e.message); });
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  const dom = new JSDOM(HTML, Object.assign({
    runScripts: 'dangerously', pretendToBeVisual: true, url: URL_, virtualConsole: vc,
    beforeParse(window) {
      try {
        /* 预置一个已登录账号，跳过登录流程直接进入主壳 */
        window.localStorage.setItem(ACC_KEY, JSON.stringify([TEST_ACC]));
        window.localStorage.setItem(SESSION_KEY, 't1');
        /* 未指定数据时给默认房屋；指定了就用指定的（用于迁移/损坏等场景） */
        window.localStorage.setItem(KEY, (seedValue !== undefined && seedValue !== null) ? seedValue : defaultHouse());
      } catch (e) { /* ignore */ }
    }
  }, opts || {}));
  return { dom, errors };
}
const q = (doc, s) => doc.querySelector(s);
const viewOf = doc => (q(doc, '#view') || { innerHTML: '' }).innerHTML;
const stored = dom => JSON.parse(dom.window.localStorage.getItem(KEY) || '{}');
const click = (doc, sel) => { const el = q(doc, sel); if (!el) throw new Error('找不到元素: ' + sel); el.click(); };
/* 点不到就记一条 FAIL，而不是让整个脚本崩掉 */
const tryClick = (doc, sel) => { const el = q(doc, sel); if (!el) { check('元素存在 ' + sel, false); return false; } el.click(); return true; };
const setVal = (doc, sel, v) => { const el = q(doc, sel); if (!el) { check('表单字段存在 ' + sel, false); return false; } el.value = v; return true; };

/* 切换当前身份：客户端把身份切换移进了账号菜单，这里走真实交互路径 */
async function switchTo(doc, id) {
  click(doc, '#btnAccount');
  await wait(70);
  const el = q(doc, '[data-act="switchMe"][data-id="' + id + '"]');
  if (el) el.click();
  else { const m = q(doc, '#modalRoot .mask'); if (m) m.click(); }
  await wait(70);
}

/* ============================================================ */
(async () => {

  /* ---------- 场景 A · 基础回归 ---------- */
  console.log('\n===== 场景 A · 基础回归 =====');
  {
    const { dom, errors } = makeDom();
    const doc = dom.window.document;
    await wait(150);
    const view = q(doc, '#view');
    check('首屏渲染出内容', view && view.innerHTML.length > 400, view ? view.innerHTML.length + ' chars' : 'no #view');
    check('底部导航 5 个 tab', doc.querySelectorAll('#tabbar .tab').length === 5);
    /* 客户端把身份切换放进了账号菜单（当前身份不显示切换按钮，故为 2 个） */
    click(doc, '#btnAccount'); await wait(70);
    const accSheet = q(doc, '#modalRoot .sheet');
    check('账号菜单可切换身份（列出其他成员）',
      !!accSheet && (accSheet.innerHTML.match(/data-act="switchMe"/g) || []).length === 2);
    check('账号菜单显示当前身份', !!accSheet && /当前身份/.test(accSheet.innerHTML));
    click(doc, '#modalRoot .mask'); await wait(50);
    check('首页有「待我处理」', /待我处理/.test(view.innerHTML));
    check('首页有待确认账单', /电费 2026-09/.test(view.innerHTML));
    check('首页有今日值日区块', /今日值日/.test(view.innerHTML));
    check('首页有概览卡', !!q(doc, '.hero'));

    click(doc, '[data-act="tab"][data-id="bills"]'); await wait(40);
    check('账单页渲染', /新建账单/.test(view.innerHTML) && /电费/.test(view.innerHTML));

    click(doc, '[data-act="bill"]'); await wait(40);
    const sheet = q(doc, '#modalRoot .sheet');
    check('账单详情弹层打开', !!sheet);
    check('显示分摊明细', !!sheet && /分摊明细/.test(sheet.innerHTML));
    check('待确认者能看到确认按钮', !!sheet && /确认这笔账/.test(sheet.innerHTML));
    click(doc, '#modalRoot .mask'); await wait(30);
    check('点击遮罩可关闭弹层', !q(doc, '#modalRoot .sheet'));

    await switchTo(doc, 'm1');
    click(doc, '[data-act="tab"][data-id="home"]'); await wait(40);
    check('切换身份后首页刷新', /今日值日/.test(view.innerHTML) && /等待/.test(view.innerHTML));
    click(doc, '[data-act="tab"][data-id="bills"]'); await wait(40);
    click(doc, '[data-act="bill"]'); await wait(40);
    check('已确认者看不到确认按钮', !/确认这笔账/.test(q(doc, '#modalRoot .sheet').innerHTML));
    click(doc, '#modalRoot .mask'); await wait(30);

    await switchTo(doc, 'm3');
    click(doc, '[data-act="tab"][data-id="bills"]'); await wait(40);
    click(doc, '[data-act="bill"]'); await wait(40);
    click(doc, '[data-act="ok"]'); await wait(50);
    check('确认后账单转为待支付', /待支付/.test(view.innerHTML));

    click(doc, '[data-act="settle"]'); await wait(50);
    const settle = view.innerHTML;
    check('结算中心渲染', /最少转账方案/.test(settle));
    check('生成转账方案', (settle.match(/→/g) || []).length >= 1);
    check('说明净额结算', /净额结算/.test(settle));

    click(doc, '[data-act="tab"][data-id="shift"]'); await wait(40);
    const shift = view.innerHTML;
    check('值日页 7 天任务', (shift.match(/负责人：/g) || []).length === 7, (shift.match(/负责人：/g) || []).length + ' 天');
    check('值日页有检查清单', /地漏滤网|灶台油污|地面清扫|厨余垃圾/.test(shift));
    check('值日页有贡献分卡片', /力账/.test(shift) && /我的贡献分/.test(shift));

    click(doc, '[data-act="tab"][data-id="items"]'); await wait(40);
    const items = view.innerHTML;
    check('物品页渲染', /公共物品/.test(items) && /抽纸/.test(items));
    check('抽纸显示需采购', /需采购/.test(items));
    check('需采购项有「我去买」', /我去买/.test(items));

    click(doc, '[data-act="buy"]'); await wait(40);
    check('采购弹层打开', /认领采购/.test(q(doc, '#modalRoot .sheet').innerHTML));
    click(doc, '[data-act="doBuy"]'); await wait(60);
    click(doc, '[data-act="tab"][data-id="bills"]'); await wait(40);
    check('采购自动生成账单', /公共采购 · 抽纸/.test(view.innerHTML));

    click(doc, '[data-act="tab"][data-id="pact"]'); await wait(40);
    const pact = view.innerHTML;
    check('公约页渲染条款', /房租、水电、燃气按人头均摊/.test(pact));
    check('公约显示绑定标签', /已绑定/.test(pact));
    check('不可执行条款被标注', /仅靠自觉/.test(pact));
    check('提案投票存在', /夏天空调统一设定为 26℃/.test(pact));
    check('公约页有数据管理区', /房屋数据/.test(pact) && /导出备份/.test(pact));

    click(doc, '[data-act="tab"][data-id="bills"]'); await wait(30);
    click(doc, '[data-act="newbill"]'); await wait(40);
    const amtSel = q(doc, '#nbAmt');
    amtSel.value = '100.00';
    amtSel.dispatchEvent(new dom.window.Event('input')); await wait(40);
    const pv = q(doc, '#nbPreview').innerHTML;
    check('新建账单实时预览', /实时预览/.test(pv));
    check('预览合计等于总额', /合计 ¥100\.00/.test(pv));
    const amounts = (pv.match(/class="v">¥[\d.]+/g) || []).map(s => Number(s.slice(s.indexOf('¥') + 1)));
    const sum = Math.round(amounts.reduce((a, b) => a + b, 0) * 100) / 100;
    check('三人分项之和 = 总额', amounts.length === 3 && sum === 100, amounts.join(' + ') + ' = ' + sum);

    check('场景 A 无运行时错误', errors.length === 0, errors.join(' | '));
  }

  /* ---------- 场景 B · 数据迁移 v1 → v2 ---------- */
  console.log('\n===== 场景 B · 旧数据迁移（元 → 分） =====');
  {
    const legacy = JSON.stringify({
      house: { name: '老房子' },
      members: [{ id: 'm1', name: '甲' }, { id: 'm2', name: '乙' }],
      bills: [{
        id: 'b1', title: '旧版水费', category: '水电', amount: 100.5, payerId: 'm1', rule: 'even',
        shares: { m1: 50.25, m2: 50.25 }, confirm: { m1: 'ok', m2: 'ok' },
        status: 'unpaid', date: '2026-09-01', version: 1, note: ''
      }],
      items: [], pacts: [], votes: [], me: 'm1'
    });
    const { dom, errors } = makeDom(legacy);
    const doc = dom.window.document;
    await wait(250);
    const view = viewOf(doc);
    check('旧数据能正常渲染（不白屏）', view.length > 200, view.length + ' chars');
    check('净额正确（100.50 − 50.25 = 50.25）', /\+¥50\.25/.test(view), (view.match(/\+\u00a5[\d.]+/) || [''])[0]);
    /* 账单明细在账单页，切过去再检查金额显示 */
    const btabB = q(doc, '[data-act="tab"][data-id="bills"]');
    if (btabB) { btabB.click(); await wait(60); }
    check('金额从「元」正确换算为「分」并显示', /¥100\.50/.test(viewOf(doc)), '期望出现 ¥100.50');
    const raw = stored(dom);
    check('缺失字段被补齐', Array.isArray(raw.transfers) && Array.isArray(raw.scoreLog) && Array.isArray(raw.restocks));
    check('schemaVersion 升到 2', raw.schemaVersion === 2, 'v' + raw.schemaVersion);
    check('账单补齐 participants 快照', Array.isArray(raw.bills[0].participants) && raw.bills[0].participants.length === 2);
    check('金额内部确为整数分', Number.isInteger(raw.bills[0].amount) && raw.bills[0].amount === 10050, String(raw.bills[0].amount));
    check('场景 B 无运行时错误', errors.length === 0, errors.join(' | '));
  }

  /* ---------- 场景 C · 数据损坏 ---------- */
  console.log('\n===== 场景 C · 数据损坏必须备份而非静默重置 =====');
  {
    const { dom, errors } = makeDom('{"broken": ');
    const doc = dom.window.document;
    await wait(800);
    check('损坏后页面仍可用（回落到演示数据）', /待我处理/.test(viewOf(doc)));
    const sheet = q(doc, '#modalRoot .sheet');
    check('弹出了数据异常提示', !!sheet && /本地数据异常/.test(sheet.innerHTML));
    const keys = Object.keys(dom.window.localStorage);
    check('原始数据已备份（未静默丢弃）', keys.some(k => k.indexOf('roomies_backup') === 0), keys.join(',') || '(无)');
    check('场景 C 无运行时错误', errors.length === 0, errors.join(' | '));
  }

  /* ---------- 场景 D · 状态机与边界 ---------- */
  console.log('\n===== 场景 D · 状态机与边界 =====');
  {
    const { dom, errors } = makeDom();
    const doc = dom.window.document;
    await wait(150);

    click(doc, '[data-act="tab"][data-id="shift"]'); await wait(40);
    const checkinBtn = q(doc, '[data-act="checkin"]');
    check('当前身份今天有可打卡任务', !!checkinBtn);
    if (checkinBtn) {
      const taskId = checkinBtn.dataset.id;
      checkinBtn.click(); await wait(40);
      click(doc, '[data-act="doCheckin"]'); await wait(80);
      check('打卡后该任务不再显示打卡按钮', !q(doc, '[data-act="checkin"][data-id="' + taskId + '"]'));
      const raw = stored(dom);
      const t = (raw.tasks || []).find(x => x.id === taskId);
      check('任务状态已持久化为 done', !!t && t.status === 'done', t ? t.status : 'missing');
      check('贡献分流水已记录 +10', (raw.scoreLog || []).some(s => s.delta === 10));
      check('打卡写入变更记录', !!t && Array.isArray(t.history) && t.history.length > 0);
      check('页面显示已完成', /已完成/.test(viewOf(doc)));
    }

    /* 重复确认账单 */
    click(doc, '[data-act="tab"][data-id="bills"]'); await wait(40);
    click(doc, '[data-act="bill"]'); await wait(40);
    click(doc, '[data-act="ok"]'); await wait(50);
    click(doc, '[data-act="bill"]'); await wait(40);
    check('已确认后不再提供确认按钮', !/确认这笔账/.test(q(doc, '#modalRoot .sheet').innerHTML));
    click(doc, '#modalRoot .mask'); await wait(30);

    /* 72 小时超时自动通过 */
    const expired = JSON.stringify({
      schemaVersion: 2, house: { name: '超时屋' }, pactVersion: 'v1.2', me: 'm1',
      members: [{ id: 'm1', name: '甲', weight: 1 }, { id: 'm2', name: '乙', weight: 1 }],
      bills: [{
        id: 'bx', title: '超时电费', category: '水电', amount: 10000, payerId: 'm1', rule: 'even',
        participants: ['m1', 'm2'], shares: { m1: 5000, m2: 5000 },
        confirm: { m1: 'pending', m2: 'pending' }, status: 'confirming',
        date: '2026-09-01', period: '2026-09', version: 1,
        dueAt: Date.now() - 60000, createdAt: Date.now() - 90000000, note: '', meter: null, history: []
      }],
      transfers: [], tasks: [], swaps: [], items: [], restocks: [], scoreLog: [], voucher: {}, pacts: [], votes: []
    });
    const d2 = makeDom(expired);
    await wait(250);
    const rawB = stored(d2.dom);
    check('超时账单自动通过（confirming → unpaid）', rawB.bills[0].status === 'unpaid', rawB.bills[0].status);
    check('超时通过写入变更记录', (rawB.bills[0].history || []).some(h => /超时/.test(h.what)));
    const d2doc = d2.dom.window.document;
    const btab = q(d2doc, '[data-act="tab"][data-id="bills"]');
    if (btab) { btab.click(); await wait(60); }
    check('超时账单出现在待支付分组', /待支付/.test(viewOf(d2doc)));
    check('场景 D 无运行时错误', errors.length === 0, errors.join(' | '));
  }

  /* ---------- 场景 E · 逐账单结清判定 ---------- */
  console.log('\n===== 场景 E · 互相抵消不得误标结清 =====');
  {
    const mk = (id, title, payer, cat) => ({
      id: id, title: title, category: cat, amount: 10000, payerId: payer, rule: 'even',
      participants: ['m1', 'm2'], shares: { m1: 5000, m2: 5000 }, confirm: { m1: 'ok', m2: 'ok' },
      status: 'unpaid', date: '2026-09-01', period: '2026-09', version: 1,
      dueAt: null, note: '', meter: null, history: []
    });
    const offset = JSON.stringify({
      schemaVersion: 2, house: { name: '抵消屋' }, pactVersion: 'v1.2', me: 'm1',
      members: [{ id: 'm1', name: '甲', weight: 1 }, { id: 'm2', name: '乙', weight: 1 }],
      bills: [mk('o1', '甲垫付的账', 'm1', '水电'), mk('o2', '乙垫付的账', 'm2', '网费')],
      transfers: [], tasks: [], swaps: [], items: [], restocks: [], scoreLog: [], voucher: {}, pacts: [], votes: []
    });
    const { dom, errors } = makeDom(offset);
    const doc = dom.window.document;
    await wait(250);
    const raw = stored(dom);
    check('两笔互相抵消的账单都未被误标结清',
      raw.bills.every(b => b.status === 'unpaid'),
      raw.bills.map(b => b.title + '=' + b.status).join(' / '));
    click(doc, '[data-act="tab"][data-id="bills"]'); await wait(50);
    check('页面上显示为待支付而非已结清', /待支付/.test(viewOf(doc)));
    check('场景 E 无运行时错误', errors.length === 0, errors.join(' | '));
  }

  /* ---------- 场景 F · 无障碍 ---------- */
  console.log('\n===== 场景 F · 无障碍 =====');
  {
    const { dom, errors } = makeDom();
    const doc = dom.window.document;
    const w = dom.window;
    await wait(150);
    click(doc, '[data-act="tab"][data-id="bills"]'); await wait(40);
    click(doc, '[data-act="newbill"]'); await wait(80);
    check('弹层带 role=dialog 与 aria-modal', (() => {
      const s = q(doc, '#modalRoot .sheet');
      return !!s && s.getAttribute('role') === 'dialog' && s.getAttribute('aria-modal') === 'true';
    })());
    check('弹层打开时锁定背景滚动', doc.body.style.overflow === 'hidden', 'overflow=' + (doc.body.style.overflow || '(空)'));
    check('表单 label 关联正确', !!q(doc, 'label[for="nbTitle"]'));
    doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(50);
    check('ESC 可关闭弹层', !q(doc, '#modalRoot .sheet'));
    check('关闭后恢复背景滚动', doc.body.style.overflow === '', 'overflow=' + (doc.body.style.overflow || '(空)'));
    check('场景 F 无运行时错误', errors.length === 0, errors.join(' | '));
  }

  /* ---------- G. 编辑能力：值日 / 物品 / 公约 / 提案 ---------- */
  console.log('\n===== G · 编辑能力（新增 / 查看 / 编辑 / 删除） =====');
  {
    const { dom, errors } = makeDom(null);
    const doc = dom.window.document;
    await wait(170);

    /* 一个两周后的日期，确保落在「本周」之外 */
    const dt = new Date(Date.now() + 14 * 86400000);
    const fds = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');

    /* --- 值日：新增 --- */
    click(doc, '[data-act="tab"][data-id="shift"]'); await wait(70);
    check('值日页有「新增排班」入口', !!q(doc, '[data-act="newTask"]'));
    tryClick(doc, '[data-act="newTask"]'); await wait(80);
    check('新增排班弹层已打开', !!q(doc, '#modalRoot .sheet') && !!q(doc, '#f_date'));
    setVal(doc, '#f_date', fds);
    setVal(doc, '#f_area', '卫生间');
    setVal(doc, '#f_assignee', 'm2');
    setVal(doc, '#f_checklist', '刷马桶、拖地');
    tryClick(doc, '[data-act="taskNew"]'); await wait(110);
    let st = stored(dom);
    let nt = (st.tasks || []).find(x => x.date === fds);
    check('新增排班写入数据', !!nt, nt ? nt.area + ' / ' + nt.assigneeId : '未找到');
    check('检查清单按「、」拆分', !!nt && nt.checklist.length === 2, nt ? nt.checklist.map(c => c.t).join('|') : '-');
    check('提交后弹层关闭', !q(doc, '#modalRoot .sheet'));
    check('本周之外的排班出现在「之后的排班」区块', /之后的排班/.test(viewOf(doc)));

    /* --- 值日：编辑 --- */
    tryClick(doc, '[data-act="editTask"][data-id="' + nt.id + '"]'); await wait(80);
    check('编辑排班弹层已打开', !!q(doc, '#modalRoot .sheet') && !!q(doc, '#f_assignee'));
    setVal(doc, '#f_assignee', 'm3');
    tryClick(doc, '[data-act="taskSave"]'); await wait(110);
    st = stored(dom); nt = (st.tasks || []).find(x => x.date === fds);
    check('编辑排班改了负责人', !!nt && nt.assigneeId === 'm3', nt ? nt.assigneeId : '-');
    check('编辑排班留下历史记录', !!nt && (nt.history || []).some(h => /修改排班/.test(h.what || '')));

    /* --- 值日：日期冲突被拒 --- */
    const other = (stored(dom).tasks || []).find(x => x.date !== fds);
    tryClick(doc, '[data-act="editTask"][data-id="' + nt.id + '"]'); await wait(80);
    setVal(doc, '#f_date', other.date);
    tryClick(doc, '[data-act="taskSave"]'); await wait(110);
    check('改成已被占用的日期会被拒绝', !!q(doc, '#modalRoot .sheet'), '弹层应保持打开并给出原因');
    click(doc, '#modalRoot .mask'); await wait(70);

    /* --- 值日：删除 --- */
    tryClick(doc, '[data-act="editTask"][data-id="' + nt.id + '"]'); await wait(80);
    tryClick(doc, '[data-act="taskDel"]'); await wait(80);
    check('删除排班需要二次确认', /删除这条排班/.test((q(doc, '#modalRoot .sheet') || {}).textContent || ''));
    tryClick(doc, '[data-act="taskDelDo"]'); await wait(110);
    check('删除排班生效', !(stored(dom).tasks || []).some(x => x.date === fds));

    /* --- 物品：新增 --- */
    click(doc, '[data-act="tab"][data-id="items"]'); await wait(70);
    check('物品页有「添加物品」入口', !!q(doc, '[data-act="newItem"]'));
    tryClick(doc, '[data-act="newItem"]'); await wait(80);
    setVal(doc, '#f_name', '洗洁精');
    setVal(doc, '#f_unit', '瓶');
    setVal(doc, '#f_stock', '3');
    setVal(doc, '#f_safety', '2');
    setVal(doc, '#f_restockQty', '4');
    tryClick(doc, '[data-act="itemNew"]'); await wait(110);
    st = stored(dom);
    let it = (st.items || []).find(x => x.name === '洗洁精');
    check('添加物品写入数据', !!it, it ? it.stock + ' ' + it.unit : '未找到');
    check('库存按数字保存（不是字符串）', !!it && it.stock === 3 && it.safety === 2, it ? it.stock + '/' + it.safety : '-');

    tryClick(doc, '[data-act="newItem"]'); await wait(80);
    setVal(doc, '#f_name', '洗洁精');
    tryClick(doc, '[data-act="itemNew"]'); await wait(110);
    check('重名物品会被拒绝', !!q(doc, '#modalRoot .sheet'));
    click(doc, '#modalRoot .mask'); await wait(70);

    /* --- 物品：编辑与删除 --- */
    tryClick(doc, '[data-act="editItem"][data-id="' + it.id + '"]'); await wait(80);
    setVal(doc, '#f_stock', '9');
    tryClick(doc, '[data-act="itemSave"]'); await wait(110);
    it = (stored(dom).items || []).find(x => x.name === '洗洁精');
    check('编辑物品改了库存', !!it && it.stock === 9, it ? String(it.stock) : '-');

    tryClick(doc, '[data-act="editItem"][data-id="' + it.id + '"]'); await wait(80);
    tryClick(doc, '[data-act="itemDel"]'); await wait(80);
    tryClick(doc, '[data-act="itemDelDo"]'); await wait(110);
    check('删除物品生效', !(stored(dom).items || []).some(x => x.name === '洗洁精'));

    /* --- 公约：新增条款 --- */
    click(doc, '[data-act="tab"][data-id="pact"]'); await wait(70);
    check('公约页有「新增条款」入口', !!q(doc, '[data-act="newPact"]'));
    const vBefore = stored(dom).pactVersion;
    tryClick(doc, '[data-act="newPact"]'); await wait(80);
    setVal(doc, '#f_text', '洗衣机用完要关水龙头');
    setVal(doc, '#f_category', '卫生与清洁');
    tryClick(doc, '[data-act="pactNew"]'); await wait(110);
    st = stored(dom);
    check('新增公约条款写入数据', (st.pacts || []).some(p => p.text === '洗衣机用完要关水龙头'));
    check('新增条款后公约版本自增', st.pactVersion !== vBefore, vBefore + ' → ' + st.pactVersion);

    /* --- 公约：查看与编辑 --- */
    const np = (stored(dom).pacts || []).find(p => p.text === '洗衣机用完要关水龙头');
    tryClick(doc, '[data-act="editPact"][data-id="' + np.id + '"]'); await wait(80);
    check('条款弹层能回填原文（可查看）', !!q(doc, '#f_text') && q(doc, '#f_text').value === '洗衣机用完要关水龙头');
    setVal(doc, '#f_text', '洗衣机用完要关水龙头并拔掉插头');
    tryClick(doc, '[data-act="pactSave"]'); await wait(110);
    check('编辑条款生效', (stored(dom).pacts || []).some(p => p.text === '洗衣机用完要关水龙头并拔掉插头'));

    /* --- 提案：发起 --- */
    check('公约页有「发起提案」入口', !!q(doc, '[data-act="newVote"]'));
    tryClick(doc, '[data-act="newVote"]'); await wait(80);
    setVal(doc, '#f_text', '每月一号统一收公共基金');
    setVal(doc, '#f_threshold', '2');
    setVal(doc, '#f_days', '3');
    tryClick(doc, '[data-act="voteNew"]'); await wait(110);
    st = stored(dom);
    let nv = (st.votes || []).find(v => v.text === '每月一号统一收公共基金');
    check('发起提案写入数据', !!nv);
    check('提案带上截止时间与阈值', !!nv && nv.threshold === 2 && /3 天后截止/.test(nv.deadline), nv ? nv.deadline : '-');

    /* --- 提案：编辑与删除 --- */
    tryClick(doc, '[data-act="editVote"][data-id="' + nv.id + '"]'); await wait(80);
    setVal(doc, '#f_threshold', '3');
    tryClick(doc, '[data-act="voteSave"]'); await wait(110);
    nv = (stored(dom).votes || []).find(v => v.text === '每月一号统一收公共基金');
    check('编辑提案改了阈值', !!nv && nv.threshold === 3, nv ? String(nv.threshold) : '-');

    tryClick(doc, '[data-act="editVote"][data-id="' + nv.id + '"]'); await wait(80);
    tryClick(doc, '[data-act="voteDel"]'); await wait(80);
    tryClick(doc, '[data-act="voteDelDo"]'); await wait(110);
    check('删除提案生效', !(stored(dom).votes || []).some(v => v.text === '每月一号统一收公共基金'));

    check('场景 G 无运行时错误', errors.length === 0, errors.join(' | '));
  }

  /* ---------- 汇总 ---------- */
  console.log('\n' + '='.repeat(56));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) console.log('失败清单：\n  · ' + fails.join('\n  · '));
  else console.log('全部通过 ✅');
  /* 页面里有 setInterval（主题定时检查），jsdom 会保持事件循环活跃，
     必须显式退出，否则进程挂住、stdout 被 SIGTERM 截断 */
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('验证脚本自身出错：', e);
  process.exit(2);
});
