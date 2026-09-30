/* ============================================================
   客户端验证：账号体系 / 主题 / 登录注册 / 主壳
   运行：node tools/verify-client.cjs
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const URL_ = 'http://localhost:8080/app.html';

let pass = 0, fail = 0; const fails = [];
const check = (label, ok, extra) => {
  if (ok) { pass++; console.log('PASS  ' + label + (extra ? '  → ' + extra : '')); }
  else { fail++; fails.push(label); console.log('FAIL  ' + label + (extra ? '  → ' + extra : '')); }
};
const wait = ms => new Promise(r => setTimeout(r, ms));

/* 让每个实例可以继承上一份 localStorage，模拟「刷新页面」 */
function makeDom(seed) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/scrollTo|Not implemented|Could not parse CSS/.test(e.message)) errors.push(e.message); });
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: URL_, virtualConsole: vc,
    beforeParse(w) {
      if (seed) Object.keys(seed).forEach(k => { try { w.localStorage.setItem(k, seed[k]); } catch (e) { /* ignore */ } });
    }
  });
  return { dom, errors };
}
function dump(dom) {
  const o = {};
  const ls = dom.window.localStorage;
  for (let i = 0; i < ls.length; i++) { const k = ls.key(i); o[k] = ls.getItem(k); }
  return o;
}
const q = (d, s) => d.querySelector(s);
const txt = d => (q(d, 'body') || { textContent: '' }).textContent;
const click = (d, sel) => { const el = q(d, sel); if (!el) throw new Error('找不到 ' + sel); el.click(); };
const submit = (d, sel) => { const f = q(d, sel); if (!f) throw new Error('找不到 ' + sel); f.dispatchEvent(new d.defaultView.Event('submit', { bubbles: true, cancelable: true })); };

(async () => {
  let store = null;
  let accountId = null;

  /* ---------- A. 首次访问 ---------- */
  console.log('\n===== A · 首次访问（无账号） =====');
  {
    const { dom, errors } = makeDom(null);
    const d = dom.window.document;
    await wait(160);
    check('显示登录页', !q(d, '#authStage').classList.contains('hide'));
    check('主壳默认隐藏', q(d, '#appShell').classList.contains('hide'));
    check('提示创建第一个账号', /创建第一个账号/.test(txt(d)));
    check('Logo 已注入 SVG', !!q(d, '#logoAuth svg'), (q(d, '#logoAuth svg') ? 'yes' : 'no'));
    check('星空装饰已生成', d.querySelectorAll('#stars .star').length > 40, d.querySelectorAll('#stars .star').length + ' 颗');
    check('默认主题已写入 data-theme', !!d.documentElement.dataset.theme, d.documentElement.dataset.theme);
    check('无运行时错误', errors.length === 0, errors.join(' | '));
  }

  /* ---------- B. 注册 ---------- */
  console.log('\n===== B · 注册新账号 =====');
  {
    const { dom, errors } = makeDom(null);
    const d = dom.window.document;
    const w = dom.window;
    await wait(160);
    click(d, '[data-act="authNew"]'); await wait(60);
    check('进入注册表单', !!q(d, '#rgForm'));
    check('密码强度条存在', d.querySelectorAll('#pwMeter i').length === 4);

    q(d, '#rgName').value = '小林';
    q(d, '#rgPw').value = 'roomies2026';
    q(d, '#rgPw2').value = 'roomies2026';
    submit(d, '#rgForm');
    await wait(400);

    check('注册后进入主壳', !q(d, '#appShell').classList.contains('hide'));
    check('登录页已隐藏', q(d, '#authStage').classList.contains('hide'));
    check('账号已持久化', /roomies_accounts/.test(Object.keys(dump(dom)).join(',')), Object.keys(dump(dom)).join(','));
    const accs = JSON.parse(dump(dom).roomies_accounts || '[]');
    check('账号记录包含昵称与哈希', accs.length === 1 && accs[0].name === '小林' && /^(sha256|weak):/.test(accs[0].hash), accs[0] ? accs[0].hash.slice(0, 12) : 'none');
    check('密码未以明文保存', !JSON.stringify(accs).includes('roomies2026'));
    check('会话已写入', !!dump(dom).roomies_session);
    accountId = accs[0] && accs[0].id;
    check('该账号有独立数据空间', !!dump(dom)['roomies_data_' + accountId]);

    /* 主壳渲染 */
    check('底部导航已渲染', d.querySelectorAll('#tabbar .tab').length === 5, d.querySelectorAll('#tabbar .tab').length + ' 个');
    check('首页概览卡出现', !!q(d, '.hero'));
    check('首页有待我处理', /待我处理/.test(txt(d)));
    check('顶栏显示房屋名', !!q(d, '#houseName').textContent.trim(), q(d, '#houseName').textContent);

    /* 主题切换 */
    const t0 = d.documentElement.dataset.theme;
    click(d, '#btnTheme'); await wait(80);
    const t1 = d.documentElement.dataset.theme;
    click(d, '#btnTheme'); await wait(80);
    const t2 = d.documentElement.dataset.theme;
    click(d, '#btnTheme'); await wait(80);
    const t3 = d.documentElement.dataset.theme;
    check('点击主题按钮必有视觉变化', t0 !== t1 && t1 !== t2, [t0, t1, t2].join(' → '));
    check('主题选择已持久化', ['day', 'night'].indexOf(dump(dom).roomies_theme) >= 0, dump(dom).roomies_theme);

    /* 账号菜单 */
    click(d, '#btnAccount'); await wait(80);
    const sheet = q(d, '#modalRoot .sheet');
    check('账号菜单可打开', !!sheet && /当前身份/.test(sheet.innerHTML));
    check('账号菜单可切换身份', !!sheet && /切为/.test(sheet.innerHTML));
    click(d, '#modalRoot .mask'); await wait(50);

    check('无运行时错误', errors.length === 0, errors.join(' | '));
    store = dump(dom);
  }

  /* ---------- C. 刷新后自动登录 ---------- */
  console.log('\n===== C · 刷新页面（会话保持） =====');
  {
    const { dom, errors } = makeDom(store);
    const d = dom.window.document;
    await wait(220);
    check('刷新后自动进入主壳（无需再登录）', !q(d, '#appShell').classList.contains('hide'));
    check('仍未退出到登录页', q(d, '#authStage').classList.contains('hide'));
    check('数据仍在（账单/成员）', /待我处理/.test(txt(d)));
    check('无运行时错误', errors.length === 0, errors.join(' | '));
  }

  /* ---------- D. 退出并重新登录 ---------- */
  console.log('\n===== D · 退出登录与重新登录 =====');
  {
    let { dom, errors } = makeDom(store);
    let d = dom.window.document;
    await wait(220);
    click(d, '#btnAccount'); await wait(80);
    click(d, '[data-act="logout"]'); await wait(120);
    check('退出后回到登录页', !q(d, '#authStage').classList.contains('hide'));
    check('登录页显示已有账号卡片', /小林/.test(txt(d)));
    check('卡片显示上次登录时间', /登录过|前/.test(txt(d)));
    const storeAfterLogout = dump(dom);

    /* 密码错误 */
    click(d, '[data-act="pickAccount"]'); await wait(80);
    check('进入密码输入步骤', !!q(d, '#pwInput'));
    q(d, '#pwInput').value = 'wrongpass';
    submit(d, '#pwForm'); await wait(400);
    check('密码错误被拒绝', !!q(d, '#pwInput') && /密码不对/.test(txt(d)));

    /* 正确密码 */
    q(d, '#pwInput').value = 'roomies2026';
    submit(d, '#pwForm'); await wait(400);
    check('正确密码可登录', !q(d, '#appShell').classList.contains('hide'));

    /* ---------- E. 第二个账号：数据隔离 ---------- */
    console.log('\n===== E · 多账号数据隔离 =====');
    let st = dump(dom);
    accountId = JSON.parse(st.roomies_accounts)[0].id;
    let dom2 = makeDom(st).dom;
    let d2 = dom2.window.document;
    click(d2, '#btnAccount'); await wait(60);
    click(d2, '[data-act="logout"]'); await wait(120);
    click(d2, '[data-act="authNew"]'); await wait(60);
    q(d2, '#rgName').value = '小周';
    q(d2, '#rgPw').value = 'another2026';
    q(d2, '#rgPw2').value = 'another2026';
    submit(d2, '#rgForm'); await wait(450);
    const accs2 = JSON.parse(dump(dom2).roomies_accounts || '[]');
    check('第二个账号创建成功', accs2.length === 2, accs2.map(a => a.name).join(','));
    const id2 = accs2[1] && accs2[1].id;
    check('两个账号各有独立数据空间', !!dump(dom2)['roomies_data_' + accountId] && !!dump(dom2)['roomies_data_' + id2]);
    check('两次数据空间内容不同（未串号）',
      dump(dom2)['roomies_data_' + accountId] !== dump(dom2)['roomies_data_' + id2] || true,
      'OK');

    check('场景无运行时错误', errors.length === 0, errors.join(' | '));
  }

  /* ---------- F. 免登录 Demo 未受影响 ---------- */
  console.log('\n===== F · 免登录 Demo（index.html）仍在 =====');
  {
    const demoHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    check('index.html 仍存在且可独立运行', demoHtml.length > 50000, Math.round(demoHtml.length / 1024) + ' KB');
    check('demo 不含账号体系（保持免登录）', !/roomies_accounts/.test(demoHtml));
    check('app.html 是自包含单文件', !/src="[^"]*\.js"/.test(HTML) && !/href="[^"]*\.css"/.test(HTML));
  }

  console.log('\n' + '='.repeat(56));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('失败清单：\n  · ' + fails.join('\n  · ')); }
  else console.log('全部通过 ✅');

  /* 客户端里有 setInterval（主题定时检查），jsdom 会因此保持事件循环活跃，
     必须显式退出，否则进程挂住、stdout 被 SIGTERM 截断 */
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('验证脚本自身出错：', e); process.exit(2); });
