/* 无头渲染验证：真实执行 index.html 里的脚本，检查关键交互是否可用 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const file = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(file, 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/scrollTo|Not implemented/.test(e.message)) errors.push('jsdomError: ' + e.message); });
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

// jsdom 不实现 localStorage 之外的存储 API；提供最小实现
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://localhost:8080/',
  virtualConsole: vc
});
const { window } = dom;
const doc = window.document;

function report(label, ok, extra) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + extra : ''));
  if (!ok) process.exitCode = 1;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await wait(120);

  // 1) 首屏渲染
  const view = doc.querySelector('#view');
  report('首页渲染出内容', view && view.innerHTML.length > 400, view ? view.innerHTML.length + ' chars' : 'no #view');
  report('顶部身份选择器已填充', doc.querySelectorAll('#whoami option').length === 3, doc.querySelectorAll('#whoami option').length + ' options');
  report('底部导航已渲染', doc.querySelectorAll('#tabs .tab').length === 5, doc.querySelectorAll('#tabs .tab').length + ' tabs');
  report('首页出现「待我处理」区块', /待我处理/.test(view.innerHTML));
  report('首页出现待确认账单（电费）', /电费 2026-09/.test(view.innerHTML));
  report('首页出现今日值日区块', /今日值日/.test(view.innerHTML));

  // 2) 切换 tab：账单
  doc.querySelector('[data-act="tab"][data-id="bills"]').click();
  await wait(40);
  report('账单页渲染', /新建账单/.test(view.innerHTML) && /电费 2026-09/.test(view.innerHTML));

  // 3) 打开账单详情弹层
  doc.querySelector('[data-act="bill"]').click();
  await wait(40);
  const sheet = doc.querySelector('#modalRoot .sheet');
  report('账单详情弹层打开', !!sheet, sheet ? '' : 'no sheet');
  report('弹层显示分摊明细', !!sheet && /分摊明细/.test(sheet.innerHTML) && /小陈/.test(sheet.innerHTML));

  // 4) 确认账单：默认身份是小陈（待确认），应能看到确认按钮
  report('待确认者能看到确认按钮', !!sheet && /确认这笔账/.test(sheet.innerHTML));
  doc.querySelector('#modalRoot .mask').click();
  await wait(30);
  report('点击遮罩可关闭弹层', !doc.querySelector('#modalRoot .sheet'));

  // 5) 切换到小林（已确认者）→ 应看不到确认按钮，但能看到等待他人确认
  const who = doc.querySelector('#whoami');
  who.value = 'm1';
  who.dispatchEvent(new window.Event('change'));
  await wait(40);
  doc.querySelector('[data-act="tab"][data-id="home"]').click();
  await wait(40);
  report('切换身份后首页刷新', /今日值日/.test(view.innerHTML) && /等待/.test(view.innerHTML));
  doc.querySelector('[data-act="tab"][data-id="bills"]').click();
  await wait(40);
  doc.querySelector('[data-act="bill"]').click();
  await wait(40);
  report('已确认者看不到确认按钮', !/确认这笔账/.test(doc.querySelector('#modalRoot .sheet').innerHTML));
  doc.querySelector('#modalRoot .mask').click();
  await wait(30);

  // 5b) 切回小陈，执行确认
  who.value = 'm3';
  who.dispatchEvent(new window.Event('change'));
  await wait(40);
  doc.querySelector('[data-act="tab"][data-id="bills"]').click();
  await wait(40);
  doc.querySelector('[data-act="bill"]').click();
  await wait(40);
  report('待确认者能看到确认按钮', /确认这笔账/.test(doc.querySelector('#modalRoot .sheet').innerHTML));

  // 6) 执行确认 → 账单应进入「待支付」
  doc.querySelector('[data-act="ok"]').click();
  await wait(50);
  report('确认后账单转为待支付', /待支付/.test(view.innerHTML));

  // 7) 结算中心：应生成最少转账方案
  doc.querySelector('[data-act="settle"]').click();
  await wait(50);
  const settle = view.innerHTML;
  report('结算中心渲染', /最少转账方案/.test(settle) || /没有待结清的债务/.test(settle));
  const planCount = (settle.match(/→/g) || []).length;
  report('生成了转账方案', planCount >= 1, planCount + ' 条');
  report('净额压缩说明存在', /净额结算/.test(settle));

  // 8) 值日页
  doc.querySelector('[data-act="tab"][data-id="shift"]').click();
  await wait(40);
  const shift = view.innerHTML;
  report('值日页渲染出 7 天任务', (shift.match(/负责人：/g) || []).length === 7, (shift.match(/负责人：/g) || []).length + ' 天');
  report('值日页显示检查清单内容', /地漏滤网|灶台油污|地面清扫|厨余垃圾/.test(shift));

  // 9) 物品页：快没了 → 触发采购
  doc.querySelector('[data-act="tab"][data-id="items"]').click();
  await wait(40);
  const items = view.innerHTML;
  report('物品页渲染', /公共物品/.test(items) && /抽纸/.test(items));
  report('抽纸显示为需采购', /需采购/.test(items));
  report('需采购项出现「我去买」', /我去买/.test(items));

  // 10) 认领采购 → 自动生成账单
  doc.querySelector('[data-act="buy"]').click();
  await wait(40);
  report('采购弹层打开', /认领采购/.test(doc.querySelector('#modalRoot .sheet').innerHTML));
  doc.querySelector('[data-act="doBuy"]').click();
  await wait(60);
  doc.querySelector('[data-act="tab"][data-id="bills"]').click();
  await wait(40);
  report('采购自动生成了账单', /公共采购 · 抽纸/.test(view.innerHTML));

  // 11) 公约页
  doc.querySelector('[data-act="tab"][data-id="pact"]').click();
  await wait(40);
  const pact = view.innerHTML;
  report('公约页渲染条款', /房租、水电、燃气按人头均摊/.test(pact));
  report('公约显示绑定标签', /已绑定/.test(pact));
  report('不可执行条款被标注', /仅靠自觉/.test(pact));
  report('提案投票存在', /夏天空调统一设定为 26℃/.test(pact));

  // 12) 校验：分摊尾差
  const who2 = doc.querySelector('#whoami');
  who2.value = 'm1';
  who2.dispatchEvent(new window.Event('change'));
  await wait(30);
  doc.querySelector('[data-act="tab"][data-id="bills"]').click();
  await wait(30);
  doc.querySelector('[data-act="newbill"]').click();
  await wait(40);
  doc.querySelector('#nbAmt').value = '100.00';
  doc.querySelector('#nbAmt').dispatchEvent(new window.Event('input'));
  await wait(40);
  const pv = doc.querySelector('#nbPreview').innerHTML;
  report('新建账单实时预览出现', /实时预览/.test(pv));
  report('预览合计等于总额', /合计 ¥100\.00/.test(pv), (pv.match(/合计 [^）]*/) || [''])[0]);

  // 13) 尾差归属：100 / 3 → 垫付人（小林）拿尾差，分项之和必须等于总额
  const amounts = (pv.match(/class="v">¥[\d.]+/g) || []).map(s => Number(s.slice(s.indexOf('¥') + 1)));
  const sum = Math.round(amounts.reduce((a, b) => a + b, 0) * 100) / 100;
  report('三人分项各有金额', amounts.length === 3, amounts.join(' / '));
  report('三人分项之和 = 总额', sum === 100, amounts.join(' + ') + ' = ' + sum);

  // 14) 运行时错误
  report('无运行时错误', errors.length === 0, errors.join(' | '));

  console.log('\n--- 运行期错误列表 ---');
  console.log(errors.length ? errors.join('\n') : '(无)');
})();
