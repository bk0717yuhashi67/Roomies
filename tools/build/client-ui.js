/* ============================================================
   客户端 UI 层
   —— 账号体系 / 晴天·夜空主题 / 登录注册 / 主壳启动
   业务核心（数据层·计算·状态机·渲染）复用 client-core.js，只有一份
   ============================================================ */

/* ============================================================
   0 · Logo 与天空装饰
   ============================================================ */
let logoSeq = 0;
function logoSVG() {
  const n = 'lg' + (++logoSeq);
  return `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
  <defs>
    <linearGradient id="${n}sun" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFE9A8"/><stop offset=".55" stop-color="#FFC24B"/><stop offset="1" stop-color="#F2921D"/>
    </linearGradient>
    <linearGradient id="${n}night" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#243257"/><stop offset="1" stop-color="#080D1E"/>
    </linearGradient>
    <clipPath id="${n}bot"><path d="M16 32a16 16 0 0 0 32 0z"/></clipPath>
  </defs>
  <circle cx="32" cy="32" r="29" stroke="currentColor" stroke-width="1.4" opacity=".2"/>
  <g class="halo" stroke="#FFC24B" stroke-width="2.2" stroke-linecap="round">
    <path d="M32 5.5v5M16.5 11.6l3.6 3.6M47.5 11.6 43.9 15.2M7 27h5M52 27h5"/>
  </g>
  <path d="M16 32a16 16 0 0 1 32 0z" fill="url(#${n}sun)"/>
  <path d="M16 32a16 16 0 0 0 32 0z" fill="url(#${n}night)"/>
  <g clip-path="url(#${n}bot)">
    <circle cx="40.5" cy="42" r="7.6" fill="#F5F0D8"/>
    <circle cx="34.6" cy="39.2" r="6.6" fill="#0E1730"/>
    <circle cx="22.5" cy="41.5" r="1.5" fill="#fff"/>
    <circle cx="27" cy="47" r="1.1" fill="#fff"/>
    <circle cx="20.5" cy="48.6" r="1" fill="#fff"/>
  </g>
  <path d="M13.5 32h37" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
</svg>`;
}

function makeStars(n) {
  let h = '';
  for (let i = 0; i < n; i++) {
    const x = (Math.random() * 100).toFixed(2);
    const y = (Math.random() * 58).toFixed(2);
    const d = (Math.random() * 4).toFixed(1);
    const big = Math.random() > 0.84;
    h += `<span class="star${big ? ' big' : ''}" style="left:${x}%;top:${y}%;animation-delay:${d}s"></span>`;
  }
  return h;
}

/* ============================================================
   1 · 主题：晴天 / 夜空（跟随时间 + 可手动覆盖）
   ============================================================ */
const THEME_KEY = 'roomies_theme';
const THEME_MODES = ['auto', 'day', 'night'];
let themeMode = 'auto';

function autoTheme() {
  const h = new Date().getHours();
  return (h >= 18 || h < 6) ? 'night' : 'day';
}
function currentTheme() { return themeMode === 'auto' ? autoTheme() : themeMode; }
function applyTheme() {
  const t = currentTheme();
  document.documentElement.dataset.theme = t;
  const btn = document.getElementById('btnTheme');
  if (btn) btn.title = themeMode === 'auto'
    ? '主题：跟随时间（现在' + (t === 'day' ? '晴天' : '夜空') + '）· 点击切换'
    : (themeMode === 'day' ? '主题：已锁定晴天 · 点击切换' : '主题：已锁定夜空 · 点击切换');
}
function cycleTheme() {
  /* 点一下必须看到变化：从「跟随时间」切到与当前相反的手动模式，其余情况直接翻转。
     否则在白天点按钮会毫无反应，用户会以为坏了。 */
  if (themeMode === 'auto') themeMode = currentTheme() === 'day' ? 'night' : 'day';
  else themeMode = themeMode === 'day' ? 'night' : 'day';
  try { localStorage.setItem(THEME_KEY, themeMode); } catch (e) { /* ignore */ }
  applyTheme();
  toast(themeMode === 'night' ? '夜空模式 ☾' : '晴天模式 ☀');
}
function setThemeMode(m) {
  themeMode = m;
  try { localStorage.setItem(THEME_KEY, m); } catch (e) { /* ignore */ }
  applyTheme();
}
function initTheme() {
  try { const v = localStorage.getItem(THEME_KEY); if (THEME_MODES.indexOf(v) >= 0) themeMode = v; } catch (e) { /* ignore */ }
  applyTheme();
  /* 跨过 18:00 / 6:00 时自动换装（不依赖渲染） */
  setInterval(() => { if (themeMode === 'auto') applyTheme(); }, 300000);
}

/* ============================================================
   2 · 账号体系
   ============================================================ */
const ACC_KEY = 'roomies_accounts';
const SESSION_KEY = 'roomies_session';
const DATA_PREFIX = 'roomies_data_';
const GLYPHS = ['☀', '☾', '★', '✦', '☁', '◐'];

let CURRENT = null;
let AUTH_STEP = 'pick';     // pick | pw | new
let AUTH_TARGET = null;     // 选中的账号

function getAccounts() {
  try { const a = JSON.parse(localStorage.getItem(ACC_KEY)); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
function setAccounts(list) {
  try { localStorage.setItem(ACC_KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
}
function getSession() { try { return localStorage.getItem(SESSION_KEY) || ''; } catch (e) { return ''; } }
function setSession(id) {
  try { if (id) localStorage.setItem(SESSION_KEY, id); else localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
}

/* 密码只保存加盐哈希；Web Crypto 不可用时（如 file:// 打开）降级并提示 */
async function hashPw(pw, salt) {
  const raw = salt + '::' + pw;
  if (window.crypto && window.crypto.subtle && window.TextEncoder) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
      return 'sha256:' + Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { /* 落到降级分支 */ }
  }
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h) ^ raw.charCodeAt(i);
  return 'weak:' + (h >>> 0).toString(16);
}

const avaBg = a => `background:linear-gradient(135deg, hsl(${a.hue} 76% 62%), hsl(${(a.hue + 42) % 360} 70% 48%))`;
const avaGlyph = a => a.glyph || '★';

function demoDataExists() {
  try { return !!localStorage.getItem('roomies_demo_v1'); } catch (e) { return false; }
}

/* ---- 邀请码 ---- */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉易混的 I / O / 0 / 1
function genCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
const keyOf = acc => DATA_PREFIX + ((acc && acc.houseOwnerId) || (acc && acc.id));

/* 在本机所有房屋里按邀请码找 */
function findHouseByCode(code) {
  code = String(code || '').trim().toUpperCase();
  if (code.length !== 6) return null;
  const accs = getAccounts();
  for (let i = 0; i < accs.length; i++) {
    const owner = accs[i].houseOwnerId || accs[i].id;
    let raw = null;
    try { raw = localStorage.getItem(DATA_PREFIX + owner); } catch (e) { continue; }
    if (!raw) continue;
    let st = null;
    try { st = JSON.parse(raw); } catch (e) { continue; }
    if (st && st.house && st.house.inviteCode === code) {
      return { owner: owner, state: st, ownerAcc: accs[i] };
    }
  }
  return null;
}

/* 把新成员写进目标房屋，返回其成员 id */
function addMemberToHouse(found, name) {
  const st = found.state;
  st.members = st.members || [];
  if (!st.house.inviteCode) st.house.inviteCode = genCode();
  const nid = 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
  st.members.push({ id: nid, name: name, room: '', weight: 1, joinedAt: todayStr() });
  try { localStorage.setItem(DATA_PREFIX + found.owner, JSON.stringify(st)); } catch (e) { /* ignore */ }
  return nid;
}

/* ---- 房屋初始化：认领旧数据 还是 开一间空屋 ---- */
function emptyState(acc) {
  const ds = todayStr();
  const s = seed();                      // 只沿用字段结构，业务数据一律清空
  s.house = { name: (acc.name || '我') + '的合租屋', inviteCode: genCode() };
  s.members = [{ id: 'm1', name: acc.name || '我', room: '主卧', weight: 1, joinedAt: ds }];
  s.me = 'm1';
  s.bills = []; s.transfers = []; s.tasks = []; s.swaps = [];
  s.items = []; s.restocks = []; s.scoreLog = []; s.votes = [];
  /* 公约与版本也必须清空：新房屋不该带着别人的条款进来 */
  s.pacts = [];
  s.pactVersion = 'v1.0';
  s.archived = {};
  s.voucher = {};
  return s;
}

/* 首次进入某账号的数据空间时决定装什么内容。
   注意：不勾选「载入本机数据」就必须是空房屋，不能再落到演示数据上。 */
function ensureAccountData(acc) {
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch (e) { /* ignore */ }
  if (raw) return 'existing';

  const canClaim = demoDataExists();
  let init = null, mode = 'blank';
  if (acc.claimDemo && canClaim) {
    try { init = localStorage.getItem('roomies_demo_v1'); } catch (e) { init = null; }
    if (init) mode = 'claimed';
  }
  if (!init) init = JSON.stringify(emptyState(acc));
  try { localStorage.setItem(KEY, init); } catch (e) { /* ignore */ }
  return mode;
}

/* 老房屋补邀请码（升级已有数据时用） */
function ensureInviteCode() {
  if (!S || !S.house) return;
  if (!S.house.inviteCode) { S.house.inviteCode = genCode(); save(); }
}

async function register(name, pw, pw2, claimDemo, inviteCode) {
  name = String(name || '').trim();
  if (name.length < 2) throw BizError('昵称至少 2 个字');
  if (name.length > 12) throw BizError('昵称不要超过 12 个字');
  if (pw.length < 6) throw BizError('密码至少 6 位');
  if (pw !== pw2) throw BizError('两次输入的密码不一致');
  const list = getAccounts();
  if (list.some(a => a.name === name)) throw BizError('这个昵称已经被使用了');

  const code = String(inviteCode || '').trim().toUpperCase();
  if (code && code.length !== 6) throw BizError('邀请码是 6 位');

  const salt = uid('s');
  const hash = await hashPw(pw, salt);
  const acc = {
    id: uid('a'), name: name, salt: salt, hash: hash,
    hue: Math.floor(Math.random() * 360),
    glyph: GLYPHS[Math.floor(Math.random() * GLYPHS.length)],
    createdAt: Date.now(), lastLoginAt: null,
    houseOwnerId: null, memberId: null, claimDemo: !!claimDemo
  };

  let joined = false;
  if (code) {
    const found = findHouseByCode(code);
    if (!found) throw BizError('邀请码无效，本机没有这个房屋');
    acc.houseOwnerId = found.owner;
    acc.memberId = addMemberToHouse(found, name);
    joined = true;
  } else {
    acc.houseOwnerId = acc.id;      // 自己开一间，数据空间就是自己的
    acc.memberId = 'm1';
  }

  list.push(acc);
  if (!setAccounts(list)) throw BizError('无法写入本地存储，请检查浏览器设置');
  return { acc: acc, joined: joined };
}

async function verify(acc, pw) {
  const h = await hashPw(pw, acc.salt);
  return h === acc.hash;
}

function removeAccount(id) {
  const list = getAccounts().filter(a => a.id !== id);
  setAccounts(list);
  try { localStorage.removeItem(DATA_PREFIX + id); } catch (e) { /* ignore */ }
  if (getSession() === id) setSession('');
}

function touchLogin(acc) {
  acc.lastLoginAt = Date.now();
  const list = getAccounts();
  const i = list.findIndex(a => a.id === acc.id);
  if (i >= 0) { list[i] = acc; setAccounts(list); }
}

function relTime(ts) {
  if (!ts) return '尚未登录过';
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60) return '刚刚登录过';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
  if (d < 86400 * 30) return Math.floor(d / 86400) + ' 天前';
  const dt = new Date(ts);
  return (dt.getMonth() + 1) + ' 月 ' + dt.getDate() + ' 日';
}

/* ============================================================
   3 · 登录 / 注册界面
   ============================================================ */
function renderAuth() {
  const box = $('#authBody');
  const tag = $('#authTag');
  if (!box) return;

  if (AUTH_STEP === 'pick') {
    const list = getAccounts();
    tag.textContent = list.length ? '选择你的账号继续' : '还没有账号，先创建一个';
    let h = '';
    if (list.length) {
      h += `<div class="acct-grid">` + list.map((a, i) =>
        `<button class="acct" data-act="pickAccount" data-id="${a.id}" type="button" style="animation-delay:${i * 55}ms">
          <span class="ava" style="${avaBg(a)}">${esc(avaGlyph(a))}<span class="badge">${a.lastLoginAt ? '☾' : '✦'}</span></span>
          <p class="nm">${esc(a.name)}</p>
          <p class="mt">${esc(relTime(a.lastLoginAt))}</p>
          <span class="del" data-act="askDelAccount" data-id="${a.id}" role="button" aria-label="删除账号" title="删除这个账号">×</span>
        </button>`).join('') +
        `<button class="acct new" data-act="authNew" type="button" style="animation-delay:${list.length * 55}ms">
          <span class="plus">＋</span><p class="nm">新建账号</p>
        </button></div>`;
    } else {
      h += `<div class="acct-grid"><button class="acct new" data-act="authNew" type="button" style="animation-delay:0ms">
          <span class="plus">＋</span><p class="nm">创建账号</p>
        </button></div>`;
    }
    box.innerHTML = h;
    return;
  }

  if (AUTH_STEP === 'pw' && AUTH_TARGET) {
    const a = AUTH_TARGET;
    tag.textContent = '输入密码继续';
    box.innerHTML = `
      <div class="glass" style="padding:26px 22px">
        <div style="text-align:center;margin-bottom:20px">
          <span class="ava" style="${avaBg(a)};width:64px;height:64px;font-size:25px;margin:0 auto 12px;display:flex;align-items:center;justify-content:center;border-radius:50%;color:#fff;font-weight:800;box-shadow:0 10px 26px -12px rgba(0,0,0,.5)">${esc(avaGlyph(a))}</span>
          <h3 style="margin:0;font-size:18px">${esc(a.name)}</h3>
          <p class="sub">${esc(relTime(a.lastLoginAt))}</p>
        </div>
        <form id="pwForm" autocomplete="off">
          <div class="field" id="pwField">
            <label for="pwInput">密码</label>
            <input id="pwInput" type="password" placeholder="••••••" autocomplete="current-password">
            <div class="err" id="pwErr">密码不对，再试一次</div>
          </div>
          <button class="btn primary wide lg" type="submit">进入房屋</button>
        </form>
        <div class="btnrow" style="margin-top:14px">
          <button class="btn link sm" data-act="authPick" type="button">换个账号</button>
        </div>
      </div>`;
    const inp = $('#pwInput');
    if (inp) setTimeout(() => { try { inp.focus(); } catch (e) { /* ignore */ } }, 80);
    const form = $('#pwForm');
    if (form) form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const v = $('#pwInput').value || '';
      if (!v) { $('#pwField').classList.add('bad'); $('#pwErr').textContent = '请输入密码'; return; }
      const ok = await verify(a, v);
      if (!ok) {
        $('#pwField').classList.add('bad');
        $('#pwErr').textContent = '密码不对，再试一次';
        $('#pwInput').value = '';
        return;
      }
      enterApp(a);
    });
    return;
  }

  /* 注册 */
  tag.textContent = '创建一个新账号';
  const canClaim = demoDataExists();
  box.innerHTML = `
    <div class="glass" style="padding:26px 22px">
      <h3 style="margin:0 0 18px;font-size:18px">创建账号</h3>
      <form id="rgForm" autocomplete="off">
        <div class="field" id="rgNameF">
          <label for="rgName">你的昵称</label>
          <input id="rgName" placeholder="例如：小林" maxlength="12">
          <div class="err"></div>
        </div>
        <div class="field" id="rgCodeF">
          <label for="rgCode">邀请码（有就填）</label>
          <input id="rgCode" placeholder="6 位邀请码" maxlength="6" autocapitalize="characters" style="letter-spacing:4px;text-transform:uppercase">
          <div class="err"></div>
        </div>
        <div class="f2">
          <div class="field" id="rgPwF">
            <label for="rgPw">密码</label>
            <input id="rgPw" type="password" placeholder="至少 6 位">
            <div class="err"></div>
          </div>
          <div class="field" id="rgPw2F">
            <label for="rgPw2">再输一次</label>
            <input id="rgPw2" type="password" placeholder="确认密码">
            <div class="err"></div>
          </div>
        </div>
        <div class="pw-meter" id="pwMeter"><i></i><i></i><i></i><i></i></div>
        ${canClaim ? `<label class="chk" style="margin-top:14px" id="rgClaimWrap">
          <input type="checkbox" id="rgClaim" checked>
          <span>载入本机已有的数据</span>
        </label>` : ''}
        <button class="btn primary wide lg" type="submit" style="margin-top:18px">创建并进入</button>
      </form>
      <div class="btnrow" style="margin-top:14px">
        <button class="btn link sm" data-act="authPick" type="button">返回账号列表</button>
      </div>
    </div>`;

  const meter = $('#pwMeter');
  const rgPw = $('#rgPw');
  if (rgPw && meter) rgPw.addEventListener('input', () => {
    const v = rgPw.value;
    let s = 0;
    if (v.length >= 6) s++;
    if (v.length >= 10) s++;
    if (/[A-Za-z]/.test(v) && /\d/.test(v)) s++;
    if (/[^A-Za-z0-9]/.test(v)) s++;
    [...meter.children].forEach((el, i) => {
      el.style.background = i < s
        ? (s <= 1 ? 'var(--bad)' : (s === 2 ? 'var(--warn)' : 'var(--good)'))
        : 'var(--line)';
    });
  });

  /* 填了邀请码就是加入别人房屋，此时不该再问「是否载入本机数据」 */
  const rgCodeEl = $('#rgCode'), claimWrap = $('#rgClaimWrap');
  if (rgCodeEl && claimWrap) {
    rgCodeEl.addEventListener('input', () => {
      claimWrap.classList.toggle('hide', !!rgCodeEl.value.trim());
    });
  }

  const rgForm = $('#rgForm');
  if (rgForm) rgForm.addEventListener('submit', async ev => {
    ev.preventDefault();
    ['rgNameF', 'rgCodeF', 'rgPwF', 'rgPw2F'].forEach(id => $('#' + id).classList.remove('bad'));
    const name = $('#rgName').value, pw = $('#rgPw').value, pw2 = $('#rgPw2').value;
    const claim = $('#rgClaim') ? $('#rgClaim').checked : false;
    const code = $('#rgCode') ? $('#rgCode').value : '';
    try {
      const r = await register(name, pw, pw2, claim, code);
      enterApp(r.acc);
    } catch (e) {
      const msg = e.message || '创建失败';
      let f = $('#rgPwF');
      if (/昵称/.test(msg)) f = $('#rgNameF');
      else if (/一致/.test(msg)) f = $('#rgPw2F');
      else if (/邀请码/.test(msg)) f = $('#rgCodeF');
      f.classList.add('bad');
      f.querySelector('.err').textContent = msg;
    }
  });
}

function showAuth() {
  const shell = $('#appShell'), stage = $('#authStage');
  if (shell) shell.classList.add('hide');
  if (stage) stage.classList.remove('hide');
  renderAuth();
}

/* ============================================================
   4 · 进入应用
   ============================================================ */
function enterApp(acc) {
  CURRENT = acc;
  touchLogin(acc);
  setSession(acc.id);
  KEY = keyOf(acc);                       // 加入别人房屋时，读写的是屋主的数据空间

  const shell = $('#appShell'), stage = $('#authStage');
  if (stage) stage.classList.add('hide');
  if (shell) shell.classList.remove('hide');

  const avaTop = $('#avaTop');
  if (avaTop) { avaTop.style.cssText += ';' + avaBg(acc); avaTop.textContent = avaGlyph(acc); }

  REPAIRS = [];
  const initMode = ensureAccountData(acc);  // 空屋 / 认领旧数据，二者只能取其一
  const boot = load();
  if (acc.memberId && S.members.some(m => m.id === acc.memberId)) S.me = acc.memberId;
  ensureTasks();
  ensureInviteCode();
  checkSettled();
  save();
  render();
  syncHouseHeader();
  window.scrollTo(0, 0);

  if (initMode === 'claimed') {
    setTimeout(() => toast('已载入本机原有数据'), 420);
  } else if (boot && boot.broken) {
    setTimeout(() => openSheet(`
      <h3>本地数据异常</h3>
      <p class="sh-sub">这个账号的数据无法读取，已保留原始副本，当前显示的是演示数据</p>
      <div class="btnrow" style="margin-top:16px">
        <button class="btn ghost" data-act="brokenNotice" type="button">查看原始副本</button>
        <button class="btn primary" data-act="close" type="button">知道了</button>
      </div>`), 420);
  } else if (boot && boot.repairs && boot.repairs.length) {
    setTimeout(() => toast('已自动修复 ' + boot.repairs.length + ' 处数据异常'), 480);
  }
}

function syncHouseHeader() {
  if (!S || !S.house) return;
  const n = document.getElementById('houseName');
  const s = document.getElementById('houseSub');
  if (n) n.textContent = S.house.name || '我的合租屋';
  if (s) {
    const my = S.members.filter(m => m.id === S.me)[0];
    s.textContent = S.members.length + ' 位室友' + (my ? ' · 当前身份 ' + my.name : '');
  }
}

function logout() {
  setSession('');
  CURRENT = null;
  S = null;
  closeSheet();
  AUTH_STEP = 'pick'; AUTH_TARGET = null;
  showAuth();
  toast('已退出登录');
}

/* 客户端不需要顶栏的身份下拉，身份切换放进账号菜单 */
renderWho = function () { /* 由账号菜单接管 */ };

/* 每次切换 tab 或渲染后，同步顶栏房屋信息 */
const _render = render;
render = function () {
  _render();
  syncHouseHeader();
};

/* ============================================================
   5 · 账号菜单
   ============================================================ */
function sheetAccount() {
  if (!CURRENT) return;
  const me = S && S.members.filter(m => m.id === S.me)[0];
  const modeTxt = themeMode === 'auto' ? '跟随时间' : (themeMode === 'day' ? '锁定晴天' : '锁定夜空');
  openSheet(`
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:6px">
      <span style="width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:#fff;flex:0 0 auto;${avaBg(CURRENT)}">${esc(avaGlyph(CURRENT))}</span>
      <div style="min-width:0">
        <h3 style="margin:0">${esc(CURRENT.name)}</h3>
        <p class="sh-sub" style="margin:2px 0 0">账号创建于 ${esc(relTime(CURRENT.createdAt).replace('登录过', '创建'))}</p>
      </div>
    </div>
    <div class="divide"></div>

    <p class="sub" style="font-weight:800;color:var(--ink-2);margin:0 0 8px">当前身份</p>
    <div class="rowlist">
      ${(S.members || []).map(m => `<div class="rowitem">
        <span class="nm"><span class="av">${esc(mInit(m.id))}</span>${esc(m.name)} · ${esc(m.room || '')}${m.id === S.me ? '<span class="pill b">当前</span>' : ''}</span>
        ${m.id === S.me ? '' : `<button class="btn ghost sm" data-act="switchMe" data-id="${m.id}" type="button">切为</button>`}
      </div>`).join('')}
    </div>

    <div class="divide"></div>
    <p class="sub" style="font-weight:800;color:var(--ink-2);margin:0 0 8px">房屋邀请码</p>
    <div style="display:flex;align-items:center;gap:12px">
      <span style="font-size:24px;font-weight:800;letter-spacing:6px;font-variant-numeric:tabular-nums">${esc((S.house && S.house.inviteCode) || '------')}</span>
      <button class="btn ghost sm" data-act="copyCode" type="button">复制</button>
    </div>

    <div class="divide"></div>
    <p class="sub" style="font-weight:800;color:var(--ink-2);margin:0 0 8px">外观</p>
    <div class="rowitem">
      <span class="nm"><span class="av">${themeMode === 'night' ? '☾' : (themeMode === 'day' ? '☀' : '◐')}</span>主题：${modeTxt}</span>
      <button class="btn ghost sm" data-act="cycleTheme" type="button">切换</button>
    </div>
    ${themeMode === 'auto' ? '' : `<div class="btnrow"><button class="btn ghost sm" data-act="themeAuto" type="button">恢复「跟随时间」</button></div>`}

    <div class="divide"></div>
    <div class="btnrow">
      <button class="btn ghost" data-act="logout" type="button">退出登录</button>
      <button class="btn danger" data-act="askDelAccount" data-id="${CURRENT.id}" type="button">删除账号</button>
    </div>
    <div class="btnrow"><button class="btn link" data-act="close" type="button">关闭</button></div>
  `);
}

/* ============================================================
   6 · 动作扩展
   ============================================================ */
Object.assign(ACT, {
  pickAccount(el, id) {
    const a = getAccounts().filter(x => x.id === id)[0];
    if (!a) { toast('账号不存在'); return; }
    AUTH_TARGET = a; AUTH_STEP = 'pw'; renderAuth();
  },
  authPick() { AUTH_STEP = 'pick'; AUTH_TARGET = null; renderAuth(); },
  authNew() { AUTH_STEP = 'new'; AUTH_TARGET = null; renderAuth(); },

  askDelAccount(el, id) {
    const a = getAccounts().filter(x => x.id === id)[0];
    if (!a) return;
    sheetConfirm('删除账号「' + a.name + '」？', [
      '这个账号的记录会被永久清除，无法恢复',
      '如果想保留，请先进入该账号并导出备份'
    ], '确认删除', 'delAccount', id, true);
  },
  delAccount(el, id) {
    removeAccount(id);
    closeSheet();
    if (CURRENT && CURRENT.id === id) { logout(); }
    else { AUTH_STEP = 'pick'; renderAuth(); toast('账号已删除'); }
  },

  cycleTheme() { cycleTheme(); closeSheet(); if (CURRENT) sheetAccount(); },
  themeAuto() { setThemeMode('auto'); closeSheet(); if (CURRENT) sheetAccount(); toast('已恢复跟随时间'); },
  switchMe(el, id) {
    S.me = id;
    save(); closeSheet(); render();
    toast('已切换为 ' + mName(id) + ' 的视角');
  },
  logout() { logout(); },
  accountMenu() { sheetAccount(); },
  copyCode() {
    const code = (S && S.house && S.house.inviteCode) || '';
    if (!code) { toast('还没有邀请码'); return; }
    const done = () => toast('邀请码已复制：' + code);
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = code;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      } catch (e) { toast('邀请码：' + code); }
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(done, fallback);
        return;
      }
    } catch (e) { /* 落到 fallback */ }
    fallback();
  }
});

/* ============================================================
   7 · 事件绑定与启动
   ============================================================ */
document.addEventListener('click', e => {
  const t = e.target;
  if (t && t.classList && t.classList.contains('mask')) { closeSheet(); return; }
  const el = t && t.closest ? t.closest('[data-act]') : null;
  if (!el) return;
  const fn = ACT[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, el.dataset.id, e); }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#modalRoot').innerHTML) { e.preventDefault(); closeSheet(); }
});

/* 多标签页同步（同一账号在另一标签页改动了数据） */
window.addEventListener('storage', e => {
  if (!CURRENT) return;
  if (e.key !== KEY || !e.newValue) return;
  try { load(); REPAIRS = []; checkSettled(); closeSheet(); render(); toast('数据已在其他标签页更新，已同步'); }
  catch (err) { /* 保持原状优于崩溃 */ }
});

const btnTheme = $('#btnTheme');
if (btnTheme) btnTheme.addEventListener('click', cycleTheme);
const btnAccount = $('#btnAccount');
if (btnAccount) btnAccount.addEventListener('click', sheetAccount);

/* ---- 启动 ---- */
initTheme();
const stars = $('#stars');
/* 28 颗足够铺满夜空 —— 原为 58 颗，每颗都是一个独立合成层，是掉帧的主要来源之一 */
if (stars) stars.innerHTML = makeStars(28);
const logoAuth = $('#logoAuth');
if (logoAuth) logoAuth.innerHTML = logoSVG();
const logoTop = $('#logoTop');
if (logoTop) logoTop.innerHTML = logoSVG();

(function boot() {
  const sid = getSession();
  const acc = getAccounts().filter(a => a.id === sid)[0];
  if (acc) enterApp(acc);
  else showAuth();
})();
