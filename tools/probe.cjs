/* ============================================================
   真实浏览器验收（可选的开发工具）

   为什么需要它：jsdom 没有布局引擎，测不出「文字被挤成竖排」
   「元素溢出容器」这类问题，也无法反映真实的渲染开销。
   这个脚本驱动本机 Edge（无需下载 Chromium），做三件事：

     1. 走一遍真实注册流程，截图各页面
     2. 量化布局：找出溢出父容器的文本节点
     3. 量化性能：生效的 backdrop-filter 数量、常驻动画元素数、
        连续切换导航时的长任务（>50ms 会明显阻塞交互）

   用法：
     npm install puppeteer-core jsdom
     python -m http.server 8090 --directory .
     node tools/probe.cjs

   环境变量：
     EDGE_PATH  浏览器可执行文件路径（默认自动探测 Edge）
     PROBE_URL  目标地址（默认 http://localhost:8090/）
   ============================================================ */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const EDGE = CANDIDATES.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
if (!EDGE) {
  console.error('找不到浏览器。请设置 EDGE_PATH 环境变量指向 Edge/Chrome 可执行文件。');
  process.exit(2);
}

const URL_ = process.env.PROBE_URL || 'http://localhost:8090/';
const OUT = path.join(__dirname, '..', '_shots');
fs.mkdirSync(OUT, { recursive: true });

const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));

  await page.goto(URL_, { waitUntil: 'networkidle0' });
  await wait(800);
  await page.screenshot({ path: path.join(OUT, '01-auth.png'), fullPage: true });

  /* 走真实注册流程 */
  await page.click('[data-act="authNew"]');
  await wait(500);
  await page.screenshot({ path: path.join(OUT, '02-register.png'), fullPage: true });

  await page.type('#rgName', '测试住户');
  await page.type('#rgPw', 'test1234');
  await page.type('#rgPw2', 'test1234');
  const claim = await page.$('#rgClaim');
  if (claim) await page.evaluate(el => { if (el.checked) el.click(); }, claim);
  await page.click('#rgForm button[type="submit"]');
  await wait(1600);
  await page.screenshot({ path: path.join(OUT, '03-home.png'), fullPage: true });

  /* 新账号数据是否真的为空 */
  const fresh = await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter(k => k.indexOf('roomies_data_') === 0);
    const st = JSON.parse(localStorage.getItem(keys[keys.length - 1]) || '{}');
    return {
      dataKey: keys[keys.length - 1],
      members: (st.members || []).map(m => m.name),
      bills: (st.bills || []).length,
      tasks: (st.tasks || []).length,
      items: (st.items || []).length,
      pacts: (st.pacts || []).length,
      pactVersion: st.pactVersion,
      votes: (st.votes || []).length,
      scoreLog: (st.scoreLog || []).length
    };
  });
  console.log('=== 新账号实际数据（应全部为空）===');
  console.log(JSON.stringify(fresh, null, 2));

  for (const [id, name] of [['shift', '04-shift'], ['bills', '05-bills'], ['items', '06-items'], ['pact', '07-pact']]) {
    const ok = await page.evaluate(k => {
      const el = document.querySelector('[data-act="tab"][data-id="' + k + '"]');
      if (el) { el.click(); return true; }
      return false;
    }, id);
    if (!ok) { console.log('缺少 tab: ' + id); continue; }
    await wait(600);
    await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
  }

  /* 夜空主题截图 */
  await page.click('#btnTheme');
  await wait(900);
  await page.screenshot({ path: path.join(OUT, '08-night.png'), fullPage: true });

  /* 流星参数：验证「位置随机 + 向右下 + 变小变淡」 */
  const meteorInfo = await page.evaluate(() => {
    const m = document.querySelector('.meteor');
    if (!m) return null;
    const cs = getComputedStyle(m);
    return {
      mx: cs.getPropertyValue('--mx').trim(), my: cs.getPropertyValue('--my').trim(),
      mdx: cs.getPropertyValue('--mdx').trim(), mdy: cs.getPropertyValue('--mdy').trim(),
      mrot: cs.getPropertyValue('--mrot').trim(),
      size: cs.width + ' × ' + cs.height,
      filter: cs.filter || 'none',
      anim: cs.animationName
    };
  });
  console.log('\n=== 流星参数（夜空主题）===');
  console.log(JSON.stringify(meteorInfo, null, 2));

  /* 流星只在动画的 5%~16% 时段可见，直接截图多半扑空 —— 定格到那一帧再看 */
  await page.evaluate(() => {
    const m = document.querySelector('.meteor');
    if (m) { m.style.animationDelay = '-1.3s'; m.style.animationPlayState = 'paused'; }
  });
  await wait(320);
  await page.screenshot({ path: path.join(OUT, '10-meteor.png') });
  await page.evaluate(() => {
    const m = document.querySelector('.meteor');
    if (m) { m.style.animationDelay = ''; m.style.animationPlayState = ''; }
  });

  await page.click('#btnTheme');
  await wait(400);

  /* 编辑弹层：入口可点、关闭后能移除（含退出动画的降级路径） */
  await page.evaluate(() => { const t = document.querySelector('[data-act="tab"][data-id="shift"]'); if (t) t.click(); });
  await wait(450);
  await page.evaluate(() => { const b = document.querySelector('[data-act="newTask"]'); if (b) b.click(); });
  await wait(550);
  await page.screenshot({ path: path.join(OUT, '09-edit-sheet.png'), fullPage: true });
  console.log('新增排班弹层可打开:', await page.evaluate(() => !!document.querySelector('#modalRoot .sheet')));
  await page.evaluate(() => { const b = document.querySelector('#modalRoot [data-act="close"]'); if (b) b.click(); });
  await wait(700);
  console.log('关闭后弹层已移除:', await page.evaluate(() => !document.querySelector('#modalRoot .sheet')));

  /* 连续切 tab 是否产生长任务 */
  const longTasks = await page.evaluate(() => new Promise(res => {
    const arr = [];
    let po = null;
    try {
      po = new PerformanceObserver(l => l.getEntries().forEach(e => arr.push(Math.round(e.duration))));
      po.observe({ entryTypes: ['longtask'] });
    } catch (e) { /* 不支持则跳过 */ }
    const ids = ['home', 'bills', 'shift', 'items', 'pact'];
    let i = 0;
    const t = setInterval(() => {
      const el = document.querySelector('[data-act="tab"][data-id="' + ids[i % 5] + '"]');
      if (el) el.click();
      i++;
      if (i >= 15) { clearInterval(t); setTimeout(() => { if (po) po.disconnect(); res(arr); }, 400); }
    }, 130);
  }));
  console.log('\n=== 连续切换导航 15 次的长任务（>50ms）===');
  console.log(longTasks.length ? longTasks : '无长任务');

  /* 布局诊断：找出溢出容器与错位的文本 */
  const diag = await page.evaluate(() => {
    const R = el => { const b = el.getBoundingClientRect(); return { l: +b.left.toFixed(1), r: +b.right.toFixed(1), t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
    const res = { overflowText: [], backdrop: 0, animated: 0, nodes: document.querySelectorAll('*').length, animList: {} };
    document.querySelectorAll('*').forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.backdropFilter && cs.backdropFilter !== 'none') res.backdrop++;
      if (cs.animationName && cs.animationName !== 'none') {
        res.animated++;
        res.animList[cs.animationName] = (res.animList[cs.animationName] || 0) + 1;
      }
    });
    document.querySelectorAll('.card, .hstat, .sheet, .tabbar, .topbar').forEach(c => {
      const cb = R(c);
      c.querySelectorAll('h3, p, span, b').forEach(n => {
        if (!n.textContent.trim()) return;
        const nb = R(n);
        if (nb.r > cb.r + 0.5 || nb.l < cb.l - 0.5 || nb.b > cb.b + 0.5) {
          res.overflowText.push({ text: n.textContent.trim().slice(0, 22), tag: n.tagName, box: R(c), node: nb });
        }
      });
    });
    return res;
  });
  console.log('\n=== 布局与性能诊断 ===');
  console.log(JSON.stringify(diag, null, 2));
  console.log('运行时错误:', errs.length ? errs.slice(0, 5) : '无');

  await browser.close();
  console.log('\n截图已输出到: ' + OUT);
})().catch(e => { console.error('探针脚本出错：', e); process.exit(1); });
