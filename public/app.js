'use strict';
/* 家庭娱乐中心 Web 前端（原生 JS，无框架无构建） */
window.HMP_BUILD = 'artp41'; // 构建标记：设置页底部会显示，便于确认浏览器加载的是不是最新版

const $app = document.getElementById('app');
const $search = document.getElementById('search');
const $scanBar = document.getElementById('scan-bar'); // 顶部扫描按钮已撤（ds 轮：手动全库扫描入口统一收进设置页）

/* ---------------- 工具 ---------------- */
async function api(path, opts) {
  const res = await fetch(path, opts && typeof opts === 'object' ? opts : undefined);
  if (!res.ok) {
    let msg = res.status, locked = false;
    try { const d = await res.json(); msg = d.error || msg; locked = !!d.lock; } catch { /* ignore */ }
    // 后端管理锁拦下的写操作（票据过期 / 绕过界面直接调接口）：同步锁定态
    if (locked) adminLockLost();
    throw new Error(msg);
  }
  return res.json();
}
/* ---------------- 管理密码（设置页门锁，前端一侧） ----------------
   服务端 lib/adminlock.js 才是真源，这里只管「挡住界面 + 索要密码」。
   两道门互相独立：绕过这个弹窗直接 fetch /api/roots 一样会被后端 403 拦下。 */
const AdminLock = { set: false, unlocked: false, loaded: false, prompted: false, demo: false };

/* ---------------- 演示站模式（gk） ----------------
   start-demo-server.sh 设 HMP_DEMO=1 → /api/admin/lock 返回 demo:true（AdminLock.demo）。
   演示站跑在 WorkBuddy 云端容器里，与用户 NAS/电脑不在同一网络——但「添加目录/扫描」
   这类本地运维入口摆在页面上会让访客误解「演示站能连我家 NAS」。
   故演示域下隐藏这些入口并拦截目录选择器；自装环境 HMP_DEMO 不设置、域名不匹配，完全不受影响。 */
const IS_DEMO_HOST = /(^|\.)app\.workbuddy\.host$/i.test(location.hostname);
const demoModeOn = () => document.documentElement.classList.contains('demo-host');
if (IS_DEMO_HOST) document.documentElement.classList.add('demo-host');
fetch('/api/admin/lock').then((r) => r.json()).then((s) => {
  if (s && s.demo) { AdminLock.demo = true; document.documentElement.classList.add('demo-host'); }
}).catch(() => { /* ignore */ });
if (IS_DEMO_HOST) {
  const demoStyle = document.createElement('style');
  demoStyle.textContent = `
/* 演示站：隐藏本地运维入口（目录添加/扫描/删除/外部存储连接/写库操作） */
.demo-host #bk-add, .demo-host #bk-scan, .demo-host #bk-reid,
.demo-host #mu-add, .demo-host #mu-scan,
.demo-host #pick-dir-btn, .demo-host #add-root-btn, .demo-host #root-path,
.demo-host #full-scan-btn,
.demo-host [data-rescan], .demo-host [data-delroot], .demo-host .root-actions .btn-danger,
.demo-host #webdav-url, .demo-host #webdav-user, .demo-host #webdav-pass,
.demo-host #webdav-save, .demo-host #webdav-add, .demo-host #webdav-browse,
.demo-host #cleanup-open, .demo-host #cleanup-trash-btn,
.demo-host #tmdb-save, .demo-host #tmdb-base-save, .demo-host #tmdb-scrape,
.demo-host #os-key, .demo-host #os-key-save, .demo-host #os-base-url, .demo-host #os-base-save,
.demo-host #reclassify, .demo-host #ltv-url-save, .demo-host #ltv-url-browse,
.demo-host #ai-scan, .demo-host #lock-panel button { display: none !important; }`;
  document.head.appendChild(demoStyle);
}

async function adminLockSync() {
  try {
    const s = await api('/api/admin/lock');
    AdminLock.demo = !!s.demo;           // 演示站：后端已关闭密码功能，前端也不显示入口
    AdminLock.set = AdminLock.demo ? false : !!s.set;
    AdminLock.unlocked = AdminLock.demo ? true : !!s.unlocked;   // 未设密码时后端恒 true（没密码可拦）
  } catch { /* 服务不可达时按未锁处理，别把用户永久挡在设置外 */ }
  AdminLock.loaded = true;
  return AdminLock;
}

/* 解锁票据失效（12 小时到期 / 改了密码）时同步状态。不自动重试 —— 由用户重新进设置页 */
function adminLockLost() {
  if (!AdminLock.unlocked) return;
  AdminLock.unlocked = false;
  toast('管理密码已失效，请重新进入设置页解锁', 4500);
}

/* 弹管理密码框：resolve(true)=已解锁，resolve(false)=用户取消 */
function adminAskUnlock() {
  return new Promise((resolve) => {
    kidPinModal('🔒 需要管理密码', async (pin) => {
      try {
        await api('/api/admin/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
        AdminLock.unlocked = true;
        resolve(true);
        return true;
      } catch (e) { kidPinErr(e.message); return false; }
    }, { placeholder: '管理密码（4~8 位数字）', onCancel: () => resolve(false) });
  });
}

/* 进设置页前的关卡：false = 用户放弃（调用方负责离开设置页） */
async function adminEnsureUnlocked() {
  if (!AdminLock.loaded) await adminLockSync();
  if (AdminLock.demo) return true;          // 演示站无密码，直接进
  if (!AdminLock.set) return true;          // 还没设密码：放行，进页面后自动引导设置
  if (AdminLock.unlocked) return true;
  return adminAskUnlock();
}

/* 首次进入设置页时的引导：把「设密码」这一步直接摆到用户面前，不指望他自己找入口 */
function adminAutoSetPrompt(afterSet) {
  if (AdminLock.demo) return;               // 演示站不引导设密码
  // dlx4：点过「暂不设置」就记 7 天 —— 原来每次进设置都弹一层全屏遮罩，正好盖住下载页里
  // 内嵌的 qBittorrent 界面（z-index 400，工具栏整排被挡得点不动）。
  try { const _sk = Number(localStorage.getItem('hmp.lockPromptSkipAt') || 0); if (_sk && (Date.now() - _sk) < 7 * 864e5) return; } catch (e) { /* 隐私模式忽略 */ }
  const mask = muModal('🔒 设置管理密码', `
    <div class="alist-status">设置后，进入「设置」页要先输入这个密码 —— 家里其他人就打不开设置、改不了媒体库目录和网盘账号了。密码为 4~8 位数字。</div>
    <div class="mpl-form" style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
      <input id="lock-ask1" type="password" inputmode="numeric" maxlength="8" placeholder="管理密码（4~8 位数字）" autocomplete="off" />
      <input id="lock-ask2" type="password" inputmode="numeric" maxlength="8" placeholder="再输一遍确认" autocomplete="off" />
    </div>
    <div class="alist-status" id="lock-ask-err" style="margin-top:8px"></div>
    <button id="lock-ask-ok" class="btn-accent" style="width:100%;margin-top:12px;padding:10px">设置密码</button>
    <button id="lock-ask-later" class="btn-small" style="width:100%;margin-top:8px">暂不设置（任何人都能进设置）</button>`);
  const q = (id) => { const el = mask.querySelector('#' + id); return el ? el.value.trim() : ''; };
  const err = (m) => { const el = mask.querySelector('#lock-ask-err'); if (el) el.textContent = m ? '⚠️ ' + m : ''; };
  mask.querySelector('#lock-ask-ok').onclick = async () => {
    const p1 = q('lock-ask1'), p2 = q('lock-ask2');
    if (!/^\d{4,8}$/.test(p1)) return err('管理密码需为 4~8 位数字');
    if (p1 !== p2) return err('两次输入的密码不一致');
    try {
      await api('/api/admin/pass', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: p1, oldPin: '' }) });
      AdminLock.set = true; AdminLock.unlocked = true;
      mask.remove();
      toast('管理密码已设置 —— 之后进入设置页需输入它');
      if (afterSet) afterSet();
    } catch (e) { err(e.message); }
  };
  mask.querySelector('#lock-ask-later').onclick = () => {
    try { localStorage.setItem('hmp.lockPromptSkipAt', String(Date.now())); } catch (e) { /* 忽略 */ }
    mask.remove();
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* 轻提示（字幕加载结果等反馈）；同页面复用一个节点 */
function toast(msg, ms = 3200) {
  let el = document.getElementById('hmp-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'hmp-toast';
    el.className = 'hmp-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el.__t);
  el.__t = setTimeout(() => el.classList.remove('show'), ms);
}

/* ---- 全屏（gi）：手机端统一入口 ----
   坑：原来三处播放页都只写 `pg.requestFullscreen()`。
   ① iPhone Safari（含微信 iOS）**根本没有 Element.requestFullscreen**（iPad 才有），
      iOS 只认 `video.webkitEnterFullscreen()` → 原来那段在 iPhone 上静默什么都不做；
   ② 缺 webkit 前缀（旧 Safari / iOS WebView 只有 webkitRequestFullscreen）；
   ③ `.catch(() => {})` 把失败吞掉，用户点了没反应也不知道为什么。
   修：按「容器 → video 原生 → 提示」三级兜底，且进入动作必须在用户手势同步栈里发起
   （iOS 过了手势栈再调 webkitEnterFullscreen 会被拒）。 */
function fsNowEl() {
  return document.fullscreenElement || document.webkitFullscreenElement
    || document.webkitCurrentFullScreenElement || null;
}
function fsExit() {
  const d = document;
  try {
    if (d.exitFullscreen) return d.exitFullscreen();
    if (d.webkitExitFullscreen) return d.webkitExitFullscreen();
    if (d.webkitCancelFullScreen) return d.webkitCancelFullScreen();
    if (d.msExitFullscreen) return d.msExitFullscreen();
  } catch (e) { /* 忽略：某些 WebView 会抛同步异常 */ }
  return Promise.resolve();
}
/* 返回 true 表示已发起全屏请求 */
function fsEnterVideo(v) {
  if (!v) return false;
  try {
    // iOS：video 元素原生全屏（唯一可用路径）
    if (v.webkitEnterFullscreen) { v.webkitEnterFullscreen(); return true; }
    if (v.webkitEnterFullScreen) { v.webkitEnterFullScreen(); return true; }
    // 安卓 WebView（微信 X5 等）：容器全屏常被拒，对 video 元素请求成功率更高
    const r = v.requestFullscreen || v.webkitRequestFullscreen || v.webkitRequestFullScreen;
    if (r) { const p = r.call(v); if (p && p.catch) p.catch(() => {}); return true; }
  } catch (e) { /* 落到 false */ }
  return false;
}
function fsToggle(pageEl) {
  const v = (pageEl && pageEl.querySelector('video')) || document.querySelector('#art-mount video') || document.getElementById('video');
  if (fsNowEl()) { fsExit(); return; }
  // iOS 原生全屏态：video.webkitDisplayingFullscreen 为 true，此时无法程序化退出
  if (v && v.webkitDisplayingFullscreen) {
    toast('请点视频左上角的「完成」退出全屏', 3600);
    return;
  }
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  // iPhone 上容器全屏 API 不存在 → 直接走 video 原生（同步，保住用户手势）
  const el = pageEl || document.querySelector('.player-page');
  const req = el && (el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen || el.msRequestFullscreen);
  if (req && !(isIOS && v && v.webkitEnterFullscreen)) {
    try {
      const p = req.call(el);
      if (p && p.catch) p.catch(() => { if (!fsEnterVideo(v)) toast('当前浏览器不支持网页全屏，可用播放器自带的全屏按钮', 4200); });
      else if (!p && !fsNowEl()) { /* 同步返回 undefined 的老 API，视为成功 */ }
      return;
    } catch (e) { /* 继续走 video 兜底 */ }
  }
  if (!fsEnterVideo(v)) {
    toast(navigator.userAgent.includes('MicroMessenger')
      ? '微信内置浏览器不支持网页全屏，请点右上角「···」→ 在浏览器打开'
      : '当前浏览器不支持网页全屏，可用播放器自带的全屏按钮', 4600);
  }
}

/* dq：版本自检 —— SPA 长驻标签页会一直跑旧代码（「下拉箭头无效」「展开后区块消失」
   两轮都是用户旧标签页里的 dg 时代假故障）。每 5 分钟 + 回到前台时拉一次首页 HTML，
   比对 app.js 的 ?v= 版本号；落后则弹「点击刷新」横幅。不自动 reload，避免打断播放/弹窗。 */
(function () {
  let myVer = null;
  try {
    const src = (document.querySelector('script[src*="app.js"]') || {}).src || '';
    myVer = (src.match(/[?&]v=([^&]+)/) || [])[1] || null;
  } catch { return; }
  if (!myVer || typeof fetch !== 'function') return; // 测试桩/老浏览器直接跳过
  let busy = false;
  let shown = false;
  const showBanner = () => {
    if (shown) return;
    shown = true;
    const b = document.createElement('div');
    b.id = 'ver-banner';
    b.innerHTML = '<span>🔄 有新版本</span><button type="button">刷新更新</button>';
    b.querySelector('button').onclick = () => { try { location.reload(); } catch { location.href = location.pathname; } };
    (document.body || document.documentElement).appendChild(b);
  };
  const check = async () => {
    if (busy || shown || document.hidden) return;
    busy = true;
    try {
      const html = await (await fetch('/?vchk=' + Date.now(), { cache: 'no-store' })).text();
      const m = html.match(/app\.js\?v=([^"&\s]+)/);
      if (m && m[1] && m[1] !== myVer) showBanner();
    } catch { /* 网络异常忽略，下轮再查 */ }
    busy = false;
  };
  try {
    setInterval(check, 5 * 60 * 1000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    setTimeout(check, 15000); // 载入后 15 秒先查一次
  } catch { /* ignore */ }
})();
const posterUrl = (m) => {
  const p = m.official_poster || m.poster;
  return p ? `/poster/${encodeURIComponent(p)}` : null;
};
/* 卡片缩略图源：Netflix 式 16:9 横图——优先剧照 backdrop，没有再用海报（由 CSS 居中裁剪） */
const thumbUrl = (m) => (m.backdrop ? `/poster/${encodeURIComponent(m.backdrop)}` : posterUrl(m));
/* 缩略图定时轮换：4 小时窗口确定性洗牌（与后端同款算法）；继续观看等时序行不套用 */
function rotShuffle(arr, salt = 0) {
  const seed = Math.floor(Date.now() / (4 * 60 * 60 * 1000)) * 131 + salt;
  return arr
    .map((x, i) => ({ x, k: Math.sin(seed * 9301 + (i + 1) * 49297) * 233280 }))
    .sort((a, b) => a.k - b.k)
    .map((o) => o.x);
}
const fmtDur = (s) => {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}小时${m}分` : `${m}分钟`;
};
const fmtSize = (b) => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB';

function cardHtml(m, opts = {}) {
  const poster = thumbUrl(m);
  const sub = opts.sub || [m.year, m.kind === 'episode' && `S${m.season ?? 1}E${m.episode ?? 1}`, fmtDur(m.duration)]
    .filter(Boolean).join(' · ');
  let progress = '';
  if (m.progress_position && m.progress_duration) {
    const pct = Math.min(100, (m.progress_position / m.progress_duration) * 100);
    progress = `<div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>`;
  }
  const badge = opts.badge || (m.kind === 'series' ? `${m.episode_count ?? 0}集`
    : (m.kind === 'episode' && m.season != null ? `第${m.season}季` : ''));
  const hash = opts.hash || (m.kind === 'series' && m.series_key
    ? `#/watch/${encodeURIComponent(m.series_key)}` : `#/play/${m.id}`);
  return `
  <div class="card" data-go="${hash}">
    <div class="thumb-wrap">
      ${badge ? `<span class="badge">${esc(badge)}</span>` : ''}
      ${m.rating ? `<span class="badge badge-rating">★ ${Number(m.rating).toFixed(1)}</span>` : ''}
      ${poster ? `<img class="thumb" loading="lazy" src="${poster}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'thumb placeholder',textContent:'🎬'}))">`
             : `<div class="thumb placeholder">🎬</div>`}
      ${progress}
    </div>
    <div class="card-title">${esc(m.tmdb_title || m.title || m.file_name)}</div>
    <div class="card-sub">${esc(sub)}</div>
  </div>`;
}

function rowHtml(title, items, opts = {}) {
  const { moreHash, sub, badge, hash } = opts;
  if (!items || !items.length) return '';
  const mk = opts.cardFn || ((m) => cardHtml(m, { sub, badge, hash }));
  const cards = items.map(mk).join('');
  const more = moreHash ? `<a class="row-more" data-go="${moreHash}">更多 ›</a>` : '';
  const head = `<div class="row-title">${esc(title)}${opts.headSub ? `<span class="row-sub">${esc(opts.headSub)}</span>` : ''}</div>`;
  return `<section class="row">
    <div class="row-head">${head}${more}</div>
    <button class="row-nav left" aria-label="向左滑动" data-rownav="-1">‹</button>
    <div class="row-scroller">${cards}</div>
    <button class="row-nav right" aria-label="向右滑动" data-rownav="1">›</button>
  </section>`;
}

/* 行左右箭头：点击横向滑动 */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-rownav]');
  if (!btn) return;
  const scroller = btn.parentElement && btn.parentElement.querySelector('.row-scroller');
  if (scroller) scroller.scrollBy({ left: Number(btn.dataset.rownav) * Math.max(560, scroller.clientWidth * 0.85), behavior: 'smooth' });
});

/* ---------------- 影视缩略图悬停预览（Netflix 式，全菜单共用） ----------------
   命中：data-go 为 #/play/<id> / #/detail/<id> / #/series/<key> 的卡片（即所有影视缩略图）；
   悬停 420ms 后在卡片位置弹出放大浮层：静音播放精彩片段 + 片名/属性/类型/简介 + 播放/详情。
   用 body 级固定定位浮层实现，不受横向滚动容器 overflow 裁剪影响。 */
const HP = { card: null, pending: null, timer: null, closeTimer: null, pvTimer: null, cache: new Map(), scroller: null };
function hpCan() { return window.matchMedia && window.matchMedia('(hover: hover)').matches; }
/* Netflix 式保持居中：浮层内容异步增减时，中线始终对齐原卡片中线（越出视口则贴边收进来） */
function hpCenterNow(f, r) {
  try {
    /* ★ 入场 FLIP 动画进行中禁止定位：此刻 getBoundingClientRect 是被 transform
       缩放过的假矩形（悬停图加载触发 RO 时正好撞上），按假值写入 left/top 后，
       动画结束(transform:none)瞬间浮层就会从卡片附近「斜跳」到真位置。
       改挂 onfinish，动画播完按真实矩形一次性定位。 */
    const running = (f.getAnimations || (() => [])).call(f).filter((a) => a.playState === 'running' && a.transitionProperty === undefined);
    if (running.length) {
      const a0 = running[0];
      if (!a0._hpSettle) {
        a0._hpSettle = true;
        a0.onfinish = () => { try { hpCenterNow(f, r); } catch { /* ignore */ } };
      }
      return;
    }
    const fr = f.getBoundingClientRect();
    if (!fr.height) return;
    /* 卡位实时取；卡片失联（被重画/摘除）时保持原地不动 —— 绝不按旧快照重定位：
       多套旧定时器各持各的快照会互相打架，浮层就在几个旧位置间来回瞬移（游戏中心实测乱跳）。 */
    if (!HP.card || !document.body.contains(HP.card)) return;
    const base = HP.card.getBoundingClientRect();
    if (!base.height) return;
    let top = base.top + base.height / 2 - fr.height / 2;
    top = Math.max(10, Math.min(top, window.innerHeight - fr.height - 8));
    f.style.top = Math.round(top) + 'px';
    /* 横向同样实时跟踪：行横向滚动动画中开的浮层，快照会偏（同排「有些正常有些不正常」的根源） */
    let left = base.left + base.width / 2 - fr.width / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - fr.width - 10));
    f.style.left = Math.round(left) + 'px';
  } catch { /* ignore */ }
}
function hpKeepCentered(f, r) {
  /* ★ 单例跟踪（20260927 游戏浮层乱跳修复）：同一条浮层只挂一份 RO + 轮询。
     此前每次浮层显示都新挂一套且从不清理（浮层元素常驻 body 不移除），
     悬停 N 张卡后 N 套定时器并存；卡片被重画摘除后 HP.card 失联，
     各套定时器按各自捕获的旧卡位重定位 → 浮层在多个旧位置间来回瞬移。
     浮层隐藏/移除时自动自清；重挂前先摘旧的。 */
  try { if (f._hpRo) { f._hpRo.disconnect(); f._hpRo = null; } } catch { /* noop */ }
  try { if (f._hpIv) { clearInterval(f._hpIv); f._hpIv = null; } } catch { /* noop */ }
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (!document.body.contains(f) || f.style.display === 'none') { try { ro.disconnect(); } catch { /* noop */ } return; }
      hpCenterNow(f, r);
    });
    ro.observe(f);
    f._hpRo = ro;
  }
  const iv = setInterval(() => {
    if (!document.body.contains(f) || f.style.display === 'none') { clearInterval(iv); f._hpIv = null; return; }
    hpCenterNow(f, r);
  }, 400);
  f._hpIv = iv;
}
/* ★ 入场时机（ec）：等内容就位（高度稳定）再播 FLIP。
   骨架高度 ≠ 填充后高度：若按骨架高度落点，悬停数据/图片填充后浮层变高，
   再居中就会肉眼可见地「斜跳」。等待期浮层透明（.on 未挂、不可见），
   hpCenterNow 已按真实内容把最终位置定准；高度稳定后才从卡片长出来，
   落点即最终位置，全程无跳。 */
function hpEntrance(f, r) {
  let started = false;
  const go = () => {
    if (!document.body.contains(f)) { started = true; try { ro.disconnect(); } catch (e) { /* ignore */ } return; }
    if (started) return;
    started = true;
    try { ro.disconnect(); } catch (e) { /* ignore */ }
    requestAnimationFrame(() => {
      /* 落点必须取悬停卡「实时」位置：首页/影视中心懒加载图会在悬停等待期撑开布局，
         卡片整体挪几像素 —— 用开浮层时的旧快照落点就会差一截，落地后再被
         hpCenterNow 拉回去，肉眼就是「下浮一点」。 */
      let base = r;
      try {
        if (HP.card && document.body.contains(HP.card)) {
          const cr = HP.card.getBoundingClientRect();
          if (cr.height) base = cr;
        }
      } catch (e) { /* ignore */ }
      f.style.transition = 'none'; // 落点一步到位：left/top 过渡会让 rect 读数停在半路
      hpCenterNow(f, base); // 与后续实时跟踪同一套居中逻辑 → 落点=稳态位置，落地不再动
      void f.offsetHeight; // 强制布局生效
      const fr = f.getBoundingClientRect();
      if (f.animate && fr.width) {
        const sx = Math.max(0.25, base.width / fr.width);
        const sy = Math.max(0.25, base.height / fr.height);
        const tx = (base.left + base.width / 2) - (fr.left + fr.width / 2);
        const ty = (base.top + base.height / 2) - (fr.top + fr.height / 2);
        f.animate([
          { transform: `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`, opacity: 0.35 },
          { transform: 'none', opacity: 1 },
        ], { duration: 320, easing: 'cubic-bezier(0, 0, 0.2, 1)' });
      }
      f.classList.add('on');
      requestAnimationFrame(() => { f.style.transition = ''; }); // 下一帧恢复过渡：后续跟踪平滑
    });
  };
  /* 高度每变一次就重挂 120ms 静默窗；稳定即入场。observe 首次必触发 → 最快 120ms 入场 */
  const ro = new ResizeObserver(() => {
    if (started) { try { ro.disconnect(); } catch (e) { /* ignore */ } return; }
    clearTimeout(ro._t);
    ro._t = setTimeout(go, 120);
  });
  try { ro.observe(f); } catch (e) { setTimeout(go, 60); }
  setTimeout(go, 560); // 兜底：取数/渲染再慢也最多等 560ms
}


/* 海报定帧：优先 hover 数据的横图/海报；都没有就退回卡片缩略图——海报期绝不露黑底 */
function hpPosterStill(f, card, still) {
  const media = f.querySelector('.hp-media');
  if (!media) return;
  const thumb = (card.querySelector('img.thumb') || {}).src || '';
  const src = still ? '/poster/' + encodeURIComponent(still) : thumb;
  if (!src) return;
  const im = document.createElement('img');
  im.className = 'hp-still';
  im.loading = 'lazy';
  im.alt = '';
  im.src = src;
  im.onerror = () => { // 未识别条目的 /poster 常是 404：退卡片缩略图，缩略图也挂才移除
    if (thumb && im.src !== thumb) im.src = thumb; else im.remove();
  };
  media.appendChild(im);
}
function hpTargetOf(el) {
  const hash = el.getAttribute('data-go') || '';
  let mm = /^#\/play\/(\d+)/.exec(hash) || /^#\/detail\/(\d+)/.exec(hash);
  if (mm) return 'm:' + mm[1];
  // 剧集卡现在走 #/watch/<key> 直达播放；旧 #/series/<key> 继续兼容
  mm = /^#\/series\/([^/?#]+)/.exec(hash) || /^#\/watch\/([^/?#]+)/.exec(hash);
  if (mm) return 's:' + decodeURIComponent(mm[1]);
  return null;
}
/* ★ 预览片段取流兜底（Hero / 悬停浮层 / 详情大窗三处共用）：
   先直连 /stream 原片；设备解不动时（Chrome 不支持 mkv 容器里的 H.264、或本机缺 HEVC 解码）
   自动回退 /transcode —— 与主播放器三档决策同源。不做这层，库里近半 .mkv 片源的预览就是一块黑屏。
   只在真失败时触发，正常路径零转码开销；转码也失败就保持原样（静态海报/定帧），不会更差。 */
/* ---- 照片相册卡悬停（Netflix 式）：大图铺满 + 相册名 + 打开按钮 ---- */
async function phOpen(card) {
  const t = phTargetOf(card);
  if (!t) return;
  HP.card = card;
  card.classList.add('hp-active');
  const r = card.getBoundingClientRect();
  const f = document.createElement('div');
  f.id = 'hp-float';
  f.className = 'hp-float';
  /* dv：与影视浮层同款两段卡——图在上（标题叠图），下方实底面板；主按钮「查看」 */
  f.innerHTML = `
    <div class="hp-media hp-media-ph">
      <div class="hp-ph">🖼️</div>
      <img class="hp-still" alt="">
      <div class="hp-img-grad"></div>
      <div class="hp-title"></div>
    </div>
    <div class="hp-panel">
      <div class="hp-btns"></div>
      <div class="hp-meta"></div>
      <div class="hp-genre"></div>
      <div class="hp-desc"></div>
    </div>`;
  document.body.appendChild(f);
  hpKeepCentered(f, r); // Netflix 式：内容变化时保持浮层中线对齐卡片中线
  const w = Math.min(Math.max(Math.round(r.width * 1.8), 380), 440); // 封顶 440：书架中心宽行卡上浮层不失控
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
  HP.scroller = card.closest('.row-scroller') || null;
  if (HP.scroller) HP.scroller.classList.add('hp-focus');
  f.style.width = w + 'px';
  f.style.left = left + 'px';
  f.style.top = Math.max(10, Math.round(r.top + r.height / 2 - 230)) + 'px'; // Netflix 式：先按卡片中线预估顶位，内容渲染后 rAF 再精确居中
  f.onmouseenter = () => { if (HP.closeTimer) { clearTimeout(HP.closeTimer); HP.closeTimer = null; } };
  f.onmouseleave = () => { HP.closeTimer = setTimeout(hpClose, 240); };
  const im = f.querySelector('.hp-still');
  /* eb：相簿页签的目录相册卡没有 coverId → 退卡片自己的封面图；两头都没有才移除留 emoji 占位 */
  const cardImg = card.querySelector('img');
  im.src = t.coverId ? '/api/photos/libthumb/' + t.coverId + '?v=2' : (cardImg ? cardImg.src : '');
  if (!im.src) im.remove();
  im.onerror = () => { if (cardImg && cardImg.src && im.src !== cardImg.src) im.src = cardImg.src; else im.remove(); };
  const tt = card.querySelector('.card-title');
  f.querySelector('.hp-title').textContent = tt ? tt.textContent.trim() : t.album;
  const sub = card.querySelector('.card-sub');
  f.querySelector('.hp-meta').textContent = ['相册', sub ? sub.textContent.trim() : ''].filter(Boolean).join(' · ');
  const go = card.getAttribute('data-go');
  f.querySelector('.hp-btns').innerHTML = `
    <button class="hp-play hp-play-txt" data-go="${go}" title="查看">▶ 查看</button>
    <button class="hp-more" data-go="${go}" title="详细信息">⌄<span class="hp-tip">详情</span></button>`;
  /* ew：同步内容就位、高度已定 → 此时才入场（后续异步统计到达只瞬移居中，不再滑） */
  hpEntrance(f, r);
  /* 面板补详情（对齐影视浮层的竖版面积）：张数 + 最近更新；全相册统计一次取回并缓存复用 */
  try {
    let albs = HP.cache.get('ph-albums');
    if (!albs) { const r = await api('/api/photos/lib'); albs = (r && r.albums) || []; HP.cache.set('ph-albums', albs); }
    if (HP.card !== card) return; // 取数期间已移到别的卡片
    const a = albs.find((x) => x.album === t.album);
    const gEl = f.querySelector('.hp-genre');
    const dEl = f.querySelector('.hp-desc');
    if (a) {
      if (gEl) gEl.textContent = `共 ${a.count} 张照片`;
      if (dEl) dEl.textContent = `最近更新于 ${new Date(a.latest).toLocaleDateString('zh-CN')}，点「查看」进入相册翻看全部`;
    } else {
      if (gEl) gEl.remove();
      if (dEl) dEl.remove();
    }
    hpCenterNow(f, r); // 信息填充后高度已定，立即居中（RO 在部分场景不触发，显式调兜底）
  } catch { /* 统计拿不到不影响浮层 */ }
}

/* ---- 照片格悬停（照片墙 .fk-cell / 相册内页 .ph-cell，eb 新增）：大图按原片比例放大 ----
   与相册卡浮层（phOpen）的本质区别：媒体区比例跟随照片真实宽高——横图扁、竖图长、方图正方，
   「放大比例和相片比例成正比」；主按钮「🔍 查看」直接在本页打开灯箱（点回原格子），不做 hash 跳转。 */
function pcTargetOf(el) {
  return el && el.dataset && el.dataset.phv ? { id: el.dataset.phv } : null;
}
function pcOpen(cell) {
  if (!cell.dataset.phv) return;
  HP.card = cell;
  cell.classList.add('hp-active');
  const r = cell.getBoundingClientRect();
  const f = document.createElement('div');
  f.id = 'hp-float';
  f.className = 'hp-float';
  f.innerHTML = `
    <div class="hp-media hp-media-pc">
      <div class="hp-ph">🖼️</div>
      <img class="hp-still" alt="">
      <div class="hp-img-grad"></div>
      <div class="hp-title"></div>
    </div>
    <div class="hp-panel">
      <div class="hp-btns"></div>
      <div class="hp-meta"></div>
    </div>`;
  document.body.appendChild(f);
  hpKeepCentered(f, r); // Netflix 式：内容变化时保持浮层中线对齐卡片中线
  const w = Math.min(Math.max(Math.round(r.width * 1.9), 380), 540); // 照片墙横图居多：放宽到 540 让横图看得清
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
  f.style.width = w + 'px';
  f.style.left = left + 'px';
  f.style.top = Math.max(10, Math.round(r.top + r.height / 2 - 200)) + 'px';
  f.onmouseenter = () => { if (HP.closeTimer) { clearTimeout(HP.closeTimer); HP.closeTimer = null; } };
  f.onmouseleave = () => { HP.closeTimer = setTimeout(hpClose, 240); };
  /* 媒体区比例：先按入库宽高（data-phv-ar = 宽/高）铺底，图片加载后用真实尺寸精调 */
  const setAr = (whRatio) => { // whRatio = 高/宽（以图片真实渲染比例为准：DB 的 w/h 对 EXIF 旋转照片不可信）
    const m = f.querySelector('.hp-media-pc');
    if (m && whRatio > 0) m.style.paddingTop = Math.round(Math.min(1.5, Math.max(0.55, whRatio)) * 100) + '%';
    /* ef：宽度跟着真实比例走 —— 横图加宽（380 宽和格子差不多大，看着「像没放大」；
       目标媒体区高约 400px，越扁越宽，封顶 640），竖/方图回基准宽（EXIF 误判时自动收回） */
    if (whRatio > 0) {
      const w2 = whRatio < 0.9 ? Math.min(640, Math.max(w, Math.round(400 / whRatio))) : w;
      if (Math.abs((f.clientWidth || 0) - w2) > 4) {
        f.style.width = w2 + 'px';
        hpCenterNow(f, r); // 宽度变了立即重新对中（入场动画中会自动推迟到 onfinish）
      }
    }
  };
  const arv = parseFloat(cell.dataset.phvAr || '0');
  const im = f.querySelector('.hp-still');
  const cim = cell.querySelector('img');
  /* eg：格子缩略图九成已加载完（同一 URL，浏览器缓存）→ 真实渲染比例同步铺底。
     DB 的 w/h 对 EXIF 旋转照片是转置的：拿它铺底再被 onload 纠正 = 浮层「向上飘一段才稳」 */
  if (cim && cim.complete && cim.naturalWidth) setAr(cim.naturalHeight / cim.naturalWidth);
  else if (arv > 0) setAr(1 / arv);
  if (cim && cim.src) {
    im.src = cim.src;
    im.onload = () => { try { if (im.naturalWidth) { setAr(im.naturalHeight / im.naturalWidth); hpCenterNow(f, r); } } catch { /* ignore */ } };
  } else im.remove();
  f.querySelector('.hp-title').textContent = cell.dataset.phvName || '照片';
  f.querySelector('.hp-meta').textContent = '点「查看」在本页放大细看';
  const view = document.createElement('button');
  view.type = 'button';
  view.className = 'hp-play hp-play-txt';
  view.textContent = '🔍 查看';
  view.onclick = (ev) => { ev.stopPropagation(); const c = HP.card; hpClose(); if (c) c.click(); };
  f.querySelector('.hp-btns').appendChild(view);
  /* ew：同步内容就位 → 入场（图片 onload 的比例精调只瞬移居中，不再向上飘） */
  hpEntrance(f, r);
}

/* ---- 书籍卡悬停（Netflix 式）：完整封面 + 书名/作者 + 阅读按钮 ---- */
async function bkOpen(card) {
  const t = bkTargetOf(card);
  if (!t) return;
  HP.card = card;
  card.classList.add('hp-active');
  const r = card.getBoundingClientRect();
  const f = document.createElement('div');
  f.id = 'hp-float';
  f.className = 'hp-float';
  /* dv：两段卡 + 书籍封面竖版整显（.hp-media-bk 拉高媒体区） */
  f.innerHTML = `
    <div class="hp-media hp-media-bk">
      <div class="hp-ph">📖</div>
      <img class="hp-still bk-cover" alt="">
      <div class="hp-img-grad"></div>
      <div class="hp-title"></div>
    </div>
    <div class="hp-panel">
      <div class="hp-btns"></div>
      <div class="hp-meta"></div>
    </div>`;
  document.body.appendChild(f);
  hpKeepCentered(f, r); // Netflix 式：内容变化时保持浮层中线对齐卡片中线
  const w = Math.min(Math.max(Math.round(r.width * 1.8), 380), 440); // 封顶 440：书架中心宽行卡上浮层不失控
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
  HP.scroller = card.closest('.row-scroller') || null;
  if (HP.scroller) HP.scroller.classList.add('hp-focus');
  f.style.width = w + 'px';
  f.style.left = left + 'px';
  f.style.top = Math.max(10, Math.round(r.top + r.height / 2 - 230)) + 'px'; // Netflix 式：先按卡片中线预估顶位，内容渲染后 rAF 再精确居中
  f.onmouseenter = () => { if (HP.closeTimer) { clearTimeout(HP.closeTimer); HP.closeTimer = null; } };
  f.onmouseleave = () => { HP.closeTimer = setTimeout(hpClose, 240); };
  const im = f.querySelector('.bk-cover');
  im.src = '/api/books/cover/' + t.id + '?s=800';
  im.onerror = () => im.remove();
  const tt = card.querySelector('.card-title');
  f.querySelector('.hp-title').textContent = tt ? tt.textContent.trim() : '书籍';
  const sub = card.querySelector('.card-sub');
  f.querySelector('.hp-meta').textContent = ['图书', sub ? sub.textContent.trim() : ''].filter(Boolean).join(' · ');
  const go = card.getAttribute('data-go');
  f.querySelector('.hp-btns').innerHTML = `
    <button class="hp-play hp-play-txt" data-go="${go}" title="阅读">▶ 阅读</button>
    <button class="hp-more" data-go="#/bookinfo/${t.id}" title="详细信息">⌄<span class="hp-tip">详情</span></button>`;
  /* ew：内容就位、高度已定 → 此时才入场（封面图加载只瞬移居中） */
  hpEntrance(f, r);
}

function pvGuard(v, id, begin) {
  if (!v || !id || v.dataset.pvGuard) return;
  v.dataset.pvGuard = '1';
  v.addEventListener('error', () => {
    if (v.dataset.pvSwap) return;
    v.dataset.pvSwap = '1';
    const at = Math.max(0, Number(v.dataset.start) || 0);
    const q = [];
    if (at) q.push('start=' + Math.floor(at));
    q.push('pv=1'); // 预览专用短转码：转够 24 秒就收工，不给 NAS 攒僵尸进程
    v.src = '/transcode/' + id + '?' + q.join('&');
    if (v.readyState >= 1) begin();
    else { v.addEventListener('loadedmetadata', begin, { once: true }); try { v.load(); } catch { /* ignore */ } }
  });
}
/* ---------------- 音乐缩略图悬停预览（参照影视版实施） ----------------
   命中：专辑卡 #/music/album/<名>、歌手卡 #/music/artist/<名>（首页音乐行 / 发现页 / 专辑总览 / 歌手总览通用）。
   Netflix 式：停留 0.7s 后浮层从卡片原位长出 + 邻卡变暗，浮层内试听精彩片段（15 秒）+ 播放按钮 + 属性简介。
   试听会暂停正在播放的音乐以免叠音，浮层关闭后自动接着放。 */
const MH = { cache: new Map(), timer: null, resume: false };
/* ep：发现页歌曲行悬停浮层（影视中心同款）——曲目注册表 + 双卡列表提升到模块级 */
const MU_SONGS = new Map(); // tid → track（仅发现页每日推荐/热歌榜登记，别处行不受影响）
let muDiscoverDaily = [], muDiscoverHot = []; // 发现页双卡列表（模块级：悬停浮层「播放」要按同一队列播）
function mhTargetOf(el) {
  const hash = el.getAttribute('data-go') || '';
  let mm = /^#\/music\/album\/(.+)$/.exec(hash);
  if (mm) return { k: 'al', name: decodeURIComponent(mm[1]) };
  mm = /^#\/music\/artist\/(.+)$/.exec(hash);
  if (mm) return { k: 'ar', name: decodeURIComponent(mm[1]) };
  return null;
}
function mhStop() {
  if (MH.timer) { clearTimeout(MH.timer); MH.timer = null; }
  const f = document.getElementById('hp-float');
  const a = f && f.querySelector('.mh-audio');
  if (a) { try { a.pause(); a.removeAttribute('src'); } catch { /* ignore */ } }
  /* 修复：悬停试听不再暂停主播放器，故收摊时无需恢复正在放的歌（曾经会打断用户正在听的歌） */
  MH.resume = false;
}
function phTargetOf(el) {
  const h = el.getAttribute('data-go') || '';
  /* eb：?ph 变为可选 —— 照片页「相簿」页签的目录相册卡只有 #/photos/lib/<名>，也要能悬停出浮层 */
  const m = /^#\/photos\/lib\/([^?#]+)(?:\?ph=(\d+))?$/.exec(h);
  return m ? { album: decodeURIComponent(m[1]), coverId: m[2] || '' } : null;
}
function bkTargetOf(el) {
  const h = el.getAttribute('data-go') || '';
  const m = /^#\/book\/(\d+)$/.exec(h);
  return m ? { id: m[1] } : null;
}

async function mhOpen(card) {
  const t = mhTargetOf(card);
  if (!t) return;
  HP.card = card;
  card.classList.add('hp-active');
  const r = card.getBoundingClientRect();
  const f = document.createElement('div');
  f.id = 'hp-float';
  f.className = 'hp-float'; // 挂类选择器：position:fixed / FLIP / 阴影全在这条规则上
  f.innerHTML = `
    <div class="hp-media hp-media-mu">
      <div class="hp-ph">🎵</div>
      <img class="mh-cover" alt="">
      <audio class="mh-audio" preload="none"></audio>
      <div class="hp-img-grad"></div>
      <div class="hp-title"></div>
    </div>
    <div class="hp-panel">
      <div class="hp-btns"></div>
      <div class="hp-meta"></div>
      <div class="hp-genre"></div>
      <div class="hp-desc"></div>
    </div>`;
  document.body.appendChild(f);
  hpKeepCentered(f, r); // Netflix 式：内容变化时保持浮层中线对齐卡片中线
  const w = Math.min(Math.max(Math.round(r.width * 1.8), 380), 440); // 封顶 440：书架中心宽行卡上浮层不失控
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
  HP.scroller = card.closest('.row-scroller') || card.closest('.mu-albums') || card.closest('.mu-artists') || null;
  if (HP.scroller) HP.scroller.classList.add('hp-focus');
  f.style.width = w + 'px';
  f.style.left = left + 'px';
  f.style.top = Math.max(10, Math.round(r.top + r.height / 2 - 230)) + 'px'; // Netflix 式：先按卡片中线预估顶位，内容渲染后 rAF 再精确居中
  f.onmouseenter = () => { if (HP.closeTimer) { clearTimeout(HP.closeTimer); HP.closeTimer = null; } };
  f.onmouseleave = () => { HP.closeTimer = setTimeout(hpClose, 240); };
  const key = t.k + ':' + t.name;
  let d = MH.cache.get(key);
  if (!d) {
    try { d = await api('/api/music/hover?kind=' + t.k + '&name=' + encodeURIComponent(t.name)); } catch { d = null; }
    if (d && d.ok) MH.cache.set(key, d);
  }
  if (HP.card !== card) return; // 取数期间已移到别的卡片
  if (!d || !d.ok) { hpClose(); return; }
  f.querySelector('.hp-title').textContent = d.name;
  const cov = f.querySelector('.mh-cover');
  cov.src = '/api/music/cover/' + d.coverId + '?s=640';
  cov.onerror = () => cov.remove();
  const durOK = d.durKnown && d.count && d.durKnown >= d.count * 0.6 && d.duration > 0;
  f.querySelector('.hp-meta').textContent = (t.k === 'ar'
      ? [`歌手 · ${d.albums} 张专辑`, `${d.count} 首`, durOK ? fmtTime(d.duration) : '']
      : [`专辑 · ${d.count} 首`, d.artist || '', d.year || '', durOK ? fmtTime(d.duration) : '']
    ).filter(Boolean).join(' · ');
  const sub = (d.tracks || []).slice(0, 4).map((x) => x.title).filter(Boolean);
  const gEl = f.querySelector('.hp-genre');
  if (sub.length) gEl.textContent = sub.join(' · '); else gEl.remove();
  f.querySelector('.hp-desc').textContent = t.k === 'ar'
    ? `共 ${d.albums} 张专辑、${d.count} 首曲目，点播放全部`
    : `${d.count} 首曲目，点播放整张专辑`;
  hpCenterNow(f, r); // 信息填充后高度已定，立即居中
  const go = (t.k === 'ar' ? '#/music/artist/' : '#/music/album/') + encodeURIComponent(d.name);
  f.querySelector('.hp-btns').innerHTML = `
    <button class="hp-play" data-go="${go}" title="播放">▶</button>
    <button class="hp-more" data-go="${go}" title="详细信息">⌄<span class="hp-tip">详情</span></button>`;
  /* ew：hover 数据 + 按钮都就位、高度已定 → 此时才从卡片长出来（落点=最终位置） */
  hpEntrance(f, r);
  const a = f.querySelector('.mh-audio');
  if (d.firstId) { // 试听精彩片段
    heroPreviewStop(); // 悬停试听优先：停掉 Hero 大图的预播和声音
    /* 修复：悬停试听完全独立于主播放器，绝不暂停正在播放的歌（用户正在听歌时不打断）。
       若主播放器正在播，则不出自动试听，避免两路叠音 —— 仅提供手动「试听」按钮。 */
    MH.resume = false;
    const mainPlaying = (() => { try { const m = Music.audio; return !!(m && !m.paused); } catch { return false; } })();
    a.src = '/api/music/stream/' + d.firstId;
    a.volume = 0.85;
    const startPreview = () => {
      if (MH.timer) { clearTimeout(MH.timer); MH.timer = null; }
      a.play().catch(() => {
        if (f.querySelector('.mh-try')) return;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hp-ghost mh-try';
        b.textContent = '🔊 试听';
        b.onclick = (ev) => { ev.stopPropagation(); a.play().catch(() => {}); b.remove(); };
        const host = f.querySelector('.hp-btns');
        if (host) host.appendChild(b); else f.querySelector('.hp-panel').appendChild(b);
      });
      MH.timer = setTimeout(() => { try { a.pause(); } catch { /* ignore */ } }, 15000);
    };
    if (mainPlaying) { // 正在听歌：只给手动试听按钮，不自动出声，避免打断
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hp-ghost mh-try';
      b.textContent = '🔊 试听';
      b.onclick = (ev) => { ev.stopPropagation(); startPreview(); b.remove(); };
      const host = f.querySelector('.hp-btns');
      if (host) host.appendChild(b); else f.querySelector('.hp-panel').appendChild(b);
    } else if (a.readyState >= 1) startPreview();
    else { a.addEventListener('loadedmetadata', startPreview, { once: true }); try { a.load(); } catch { /* ignore */ } }
  }
  requestAnimationFrame(() => { // 内容就位后再垂直居中一次，越出视口则收进来
    const fr = f.getBoundingClientRect();
    if (fr.height) {
      let top = r.top + r.height / 2 - fr.height / 2;
      top = Math.max(10, Math.min(top, window.innerHeight - fr.height - 8));
      f.style.top = Math.round(top) + 'px';
    }
  });
}
/* ep：发现页歌曲行悬停目标——只认 mu-dual 内且已登记的行 */
function msTargetOf(el) {
  if (!el.matches || !el.matches('.mu-dual .mu-row[data-tid]')) return null;
  return MU_SONGS.get(el.dataset.tid) || null;
}
/* 歌曲悬停浮层：影视中心同款竖式小浮层（固定 380，封面 + 15s 试听 + 播放/喜欢/专辑） */
async function msOpen(card) {
  const t = msTargetOf(card);
  if (!t) return;
  HP.card = card;
  card.classList.add('hp-active');
  const r = card.getBoundingClientRect();
  const f = document.createElement('div');
  f.id = 'hp-float';
  f.className = 'hp-float'; // 挂类选择器：position:fixed / FLIP / 阴影全在这条规则上
  f.innerHTML = `
    <div class="hp-media hp-media-mu">
      <div class="hp-ph">🎵</div>
      <img class="mh-cover" alt="">
      <audio class="mh-audio" preload="none"></audio>
      <div class="hp-img-grad"></div>
      <div class="hp-title"></div>
    </div>
    <div class="hp-panel">
      <div class="hp-btns"></div>
      <div class="hp-meta"></div>
      <div class="hp-genre"></div>
      <div class="hp-desc"></div>
    </div>`;
  document.body.appendChild(f);
  hpKeepCentered(f, r);
  const w = 380; // 影视中心同款：固定竖式，不按宽行放大（ej 同款约束）
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
  f.style.width = w + 'px';
  f.style.left = left + 'px';
  f.style.top = Math.max(10, Math.round(r.top + r.height / 2 - 230)) + 'px';
  f.onmouseenter = () => { if (HP.closeTimer) { clearTimeout(HP.closeTimer); HP.closeTimer = null; } };
  f.onmouseleave = () => { HP.closeTimer = setTimeout(hpClose, 240); };
  f.querySelector('.hp-title').textContent = t.title || '未知曲目';
  const cov = f.querySelector('.mh-cover');
  cov.src = musicCoverUrl(t, 640);
  cov.onerror = () => cov.remove();
  f.querySelector('.hp-meta').textContent = [t.artist || '未知歌手', t.album || '', t.duration ? fmtTime(t.duration) : ''].filter(Boolean).join(' · ');
  f.querySelector('.hp-desc').textContent = '试听中 · 点 ▶ 播放';
  const liked = () => Music.likes.has(t.id);
  const syncHearts = () => { document.querySelectorAll('.mu-like[data-like="' + t.id + '"]').forEach((b) => { b.classList.toggle('on', liked()); b.textContent = liked() ? '❤' : '♡'; }); };
  f.querySelector('.hp-btns').innerHTML = `
    <button class="hp-play" data-ms-play="1" title="播放">▶</button>
    <button class="hp-like" data-ms-like="1" title="喜欢">${liked() ? '❤' : '♡'}</button>
    ${t.album ? `<button class="hp-more" data-go="#/music/album/${encodeURIComponent(t.album)}" title="专辑详情">⌄<span class="hp-tip">专辑</span></button>` : ''}`;
  f.querySelector('[data-ms-play]').onclick = () => {
    const list = muDiscoverDaily.concat(muDiscoverHot);
    const idx = list.findIndex((x) => x.id === t.id);
    hpClose();
    musicPlayQueue(list, idx >= 0 ? idx : 0);
  };
  const lb = f.querySelector('[data-ms-like]');
  lb.onclick = async () => {
    const on = !liked();
    Music.likes[on ? 'add' : 'delete'](t.id);
    lb.textContent = on ? '❤' : '♡'; lb.classList.toggle('on', on);
    syncHearts(); // 行内的 ♡ 同步点亮
    await api('/api/music/like', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.id, on }) }).catch(() => {});
  };
  // 试听 15s（修复：独立于主播放器，正在听歌时不出自动试听，避免打断）
  heroPreviewStop();
  MH.resume = false;
  const mainPlaying = (() => { try { const m = Music.audio; return !!(m && !m.paused); } catch { return false; } })();
  const a = f.querySelector('.mh-audio');
  a.src = '/api/music/stream/' + t.id;
  a.volume = 0.85;
  const begin = () => {
    if (MH.timer) { clearTimeout(MH.timer); MH.timer = null; }
    a.play().catch(() => {
      if (f.querySelector('.mh-try')) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hp-ghost mh-try';
      b.textContent = '🔊 试听';
      b.onclick = (ev) => { ev.stopPropagation(); a.play().catch(() => {}); b.remove(); };
      const host = f.querySelector('.hp-btns');
      if (host) host.appendChild(b); else f.querySelector('.hp-panel').appendChild(b);
    });
    MH.timer = setTimeout(() => { try { a.pause(); } catch { /* ignore */ } }, 15000);
  };
  if (mainPlaying) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hp-ghost mh-try';
    b.textContent = '🔊 试听';
    b.onclick = (ev) => { ev.stopPropagation(); begin(); b.remove(); };
    const host = f.querySelector('.hp-btns');
    if (host) host.appendChild(b); else f.querySelector('.hp-panel').appendChild(b);
  } else if (a.readyState >= 1) begin();
  else { a.addEventListener('loadedmetadata', begin, { once: true }); try { a.load(); } catch { /* ignore */ } }
  hpCenterNow(f, r); // 信息填充后高度已定，立即居中
  /* ew：内容就位、高度已定 → 此时才入场（落点=最终位置） */
  hpEntrance(f, r);
}
function hpClose() {
  mhStop(); // 音乐试听收尾（停音频 + 需要时恢复主播放器）
  if (HP.timer) { clearTimeout(HP.timer); HP.timer = null; }
  if (HP.pvTimer) { clearTimeout(HP.pvTimer); HP.pvTimer = null; } // 2.5s 预播延迟没到点就关浮层 → 作废
  if (HP.closeTimer) { clearTimeout(HP.closeTimer); HP.closeTimer = null; }
  HP.pending = null;
  const f = document.getElementById('hp-float');
  if (f) { f.classList.remove('on'); setTimeout(() => f.remove(), 180); }
  if (HP.scroller) { HP.scroller.classList.remove('hp-focus'); HP.scroller = null; }
  if (HP.card) { HP.card.classList.remove('hp-active'); HP.card = null; }
  const hv = document.querySelector('.hero-slide.on video.hero-video');
  if (hv && USER_ACTIVE && !hv.paused && !hmpQuietAfterPlay()) hv.muted = false; // 浮层收摊后 Hero 预播声回归（还预着且有过交互才出声；artp35b：刚看完片回来的静默窗口内不回归）
}
function hpChips(bits) {
  return bits.filter(Boolean).map((b) => `<span class="hp-chip">${esc(String(b))}</span>`).join('');
}
async function hpOpen(card) {
  const target = hpTargetOf(card);
  if (!target) return;
  HP.card = card;
  card.classList.add('hp-active');
  const r = card.getBoundingClientRect();
  const f = document.createElement('div');
  f.id = 'hp-float';
  f.className = 'hp-float'; // 挂类选择器：position:fixed / FLIP / 阴影全在这条规则上
  /* Netflix 式：点浮层任意空白处（预播画面/文字区，非按钮）= 打开详情大窗 */
  f.addEventListener('click', (ev) => {
    if (ev.target.closest('button, a')) return;
    openCardModal(target, HP.card);
  });
  /* dr：Netflix 式两段卡——横向剧照在上（片名叠图），下方实底面板纵向排
     按钮/信息/类型/简介：卡片比行缩略图高出一大截，「竖向」才有地方放更多内容 */
  f.innerHTML = `
    <div class="hp-media">
      <div class="hp-ph">🎬</div>
      <video class="hp-video" muted playsinline preload="none"></video>
      <div class="hp-img-grad"></div>
      <div class="hp-title"></div>
    </div>
    <div class="hp-panel">
      <div class="hp-btns"></div>
      <div class="hp-meta"></div>
      <div class="hp-genre"></div>
      <div class="hp-desc"></div>
    </div>`;
  document.body.appendChild(f);
  hpKeepCentered(f, r); // Netflix 式：内容变化时保持浮层中线对齐卡片中线
  /* ej：影视中心双列榜单行是半屏宽的宽行，按行宽 ×1.8 放大浮层会变成 ~800px 巨图；
     榜单行固定 380 = 首页卡片同款竖式小悬浮（16:9 画面在上 + 信息面板在下） */
  const w = card.closest('.mv-dual') ? 380 : Math.max(Math.round(r.width * 1.8), 380);
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
  HP.scroller = card.closest('.row-scroller') || null;
  if (HP.scroller) HP.scroller.classList.add('hp-focus'); // Netflix 式焦点拉焦：邻卡后退变暗
  f.style.width = w + 'px';
  f.style.left = left + 'px';
  f.style.top = Math.max(10, Math.round(r.top + r.height / 2 - 230)) + 'px'; // Netflix 式：先按卡片中线预估顶位，内容渲染后 rAF 再精确居中
  /* Netflix 式展开：浮层从卡片原位「长出来」（FLIP），而不是凭空弹出。
     ew：入场时机挪到 hover 数据填充完成后（下方 hpEntrance）—— 数据到达前浮层是
     空壳（矮半截），先入场再等数据填充居中，浮层就会肉眼可见地「从下往上爬」。 */
  // 悬停期间保持：移入浮层不关闭；移出卡片与浮层才延迟关闭
  f.onmouseenter = () => { if (HP.closeTimer) { clearTimeout(HP.closeTimer); HP.closeTimer = null; } };
  f.onmouseleave = () => { HP.closeTimer = setTimeout(hpClose, 240); };
  let d = HP.cache.get(target);
  if (!d) {
    try {
      d = target.startsWith('s:')
        ? await api('/api/series/' + encodeURIComponent(target.slice(2)) + '/hover')
        : await api('/api/media/' + target.slice(2) + '/hover');
      HP.cache.set(target, d);
    } catch { hpClose(); return; }
  }
  if (HP.card !== card) return; // 拉取期间已移到别的卡片
  f.querySelector('.hp-title').textContent = d.title || '未命名';
  f.querySelector('.hp-meta').textContent = [
    d.kind === 'series' ? `剧集 · ${d.episode_count || 0}集` : (d.kind === 'episode' ? `第${d.season ?? 1}季 第${d.episode ?? 1}集` : '电影'),
    d.year || '', d.duration ? fmtDur(d.duration) : '', d.rating ? '★ ' + Number(d.rating).toFixed(1) : '',
  ].filter(Boolean).join(' · ');
  const gEl = f.querySelector('.hp-genre');
  const genres = String(d.genre || '').split(/[,，、|/]/).map((x) => x.trim()).filter(Boolean).slice(0, 4);
  if (genres.length) gEl.textContent = genres.join(' · '); else gEl.remove();
  const dEl = f.querySelector('.hp-desc');
  if (d.overview) dEl.textContent = d.overview; else dEl.remove();
  const infoHash = d.kind === 'series' ? '#/series/' + encodeURIComponent(d.series_key) : '#/detail/' + d.id;
  /* ek：云盘源 preview=null（dc 轮起不派预览）——这里无条件读 d.preview.id 会 TypeError，
     hpOpen 中断在按钮/静帧渲染之前 → 浮层黑屏无按钮。回退用影片自身 id（从头播放） */
  const playHash = d.kind === 'series' ? '#/watch/' + encodeURIComponent(d.series_key) : '#/play/' + ((d.preview && d.preview.id) || d.id);
  f.querySelector('.hp-btns').innerHTML = `
    <button class="hp-play" data-go="${playHash}" title="播放">▶</button>
    <button class="hp-like" data-like="${d.kind === 'series' ? 's:' + d.series_key : 'm:' + d.id}" title="赞">👍</button>
    <button class="hp-mute" title="声音">🔇</button>
    <button class="hp-more" data-cm="${d.kind === 'series' ? 's:' + d.series_key : 'm:' + d.id}" title="详细信息">⌄<span class="hp-tip">${d.kind === 'series' ? '剧集和信息' : '详情'}</span></button>`;
  const moreBtn = f.querySelector('.hp-more');
  if (moreBtn) moreBtn.onclick = (ev) => { ev.stopPropagation(); hpClose(); openCardModal(moreBtn.dataset.cm, HP.card); }; // ⌄ = 详情大窗
  const likeBtn = f.querySelector('.hp-like');
  if (likeBtn) {
    if (LIKE_MINE.has(likeBtn.dataset.like)) { likeBtn.textContent = '❤'; likeBtn.classList.add('on'); }
    likeBtn.onclick = (ev) => { ev.stopPropagation(); likeToggle(likeBtn); };
  }
  /* ew：数据与按钮都就位、高度已定 —— 此刻才从卡片原位长出来（落点=最终位置） */
  hpEntrance(f, r);
  // Netflix 式预播节奏：浮层先展示海报定帧，悬停满 2.5 秒才起有声预播（len 秒后暂停定帧）
  const v = f.querySelector('.hp-video');
  if (d.preview && d.preview.id) {
    hpPosterStill(f, card, d.backdrop || d.poster); // 海报先行：盖住黑底视频，预播真正起播那一刻再摘掉
    heroPreviewStop(); // 悬停缩略图预播优先：停掉 Hero 大图的预播和声音，别两路一起响
    v.muted = false; // 预播默认有声；被 autoplay 策略拦下时自动转静音（🔇 按钮随时切回）
    const muteBtn = f.querySelector('.hp-mute');
    const syncMute = () => { if (muteBtn) muteBtn.textContent = v.muted ? '🔇' : '🔊'; };
    if (muteBtn) muteBtn.onclick = (ev) => { ev.stopPropagation(); v.muted = !v.muted; syncMute(); };
    let stopTimer = null;
    const begin = () => {
      if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
      const st = f.querySelector('.hp-still');
      if (st) st.remove(); // 预播起播，海报定帧退场
      hpCenterNow(f, r); // 起播时浮层高度已定，此刻居中最准
      try { v.currentTime = d.preview.start || 0; } catch {}
      v.play().catch(() => { v.muted = true; syncMute(); v.play().catch(() => {}); });
      /* 音轨探测：DTS/TrueHD 等音轨 Chrome 解不了——画面在走就是没声。起播 1.6s 后
         音频解码字节仍为 0 → 自动换 /transcode（音频转 aac），把声音救回来。 */
      setTimeout(() => {
        if (HP.card !== card || !document.body.contains(f) || v.paused || v.dataset.pvSwap) return;
        const decoded = v.webkitAudioDecodedByteCount;
        if (typeof decoded === 'number' && decoded > 0) return;
        v.dataset.pvSwap = '1'; // 与 pvGuard 的换源互斥：只剩这一次机会
        const at = Math.max(0, Number(v.dataset.start) || 0);
        const q = [];
        if (at) q.push('start=' + Math.floor(at));
        q.push('pv=1');
        v.src = '/transcode/' + d.preview.id + '?' + q.join('&');
        const b2 = () => { try { v.currentTime = at; } catch { /* ignore */ } v.play().catch(() => {}); };
        if (v.readyState >= 1) b2();
        else { v.addEventListener('loadedmetadata', b2, { once: true }); try { v.load(); } catch { /* ignore */ } }
      }, 1600);
      stopTimer = setTimeout(() => { try { v.pause(); } catch {} }, (d.preview.len || 12) * 1000);
    };
    const startNow = () => {
      v.dataset.start = String(d.preview.start || 0);
      v.src = '/stream/' + d.preview.id;
      pvGuard(v, d.preview.id, begin); // 同 Hero：解不动就换转码
      /* ★ 同 Hero：显式 load() 才真正拉流（详见 heroPreview 处说明） */
      if (v.readyState >= 1) begin();
      else { v.addEventListener('loadedmetadata', begin, { once: true }); try { v.load(); } catch { /* ignore */ } }
    };
    if (HP.pvTimer) clearTimeout(HP.pvTimer);
    HP.pvTimer = setTimeout(() => { // 悬停 2.5s 才真正起播；期间移开/关浮层则作废
      HP.pvTimer = null;
      if (HP.card !== card || !document.body.contains(f)) return;
      startNow();
    }, 2500);
  } else {
    // 没有预览片段（云盘源等）→ 用横图/海报当静帧，都没有就退卡片缩略图，别露出灰底占位
    hpPosterStill(f, card, d.backdrop || d.poster);
    if (d.cloud) { // ☁ 角标：明示不预播是云端内容属性（远端 seek 卡死，服务端不派 preview），不是功能坏了
      const chip = document.createElement('div');
      chip.className = 'hp-cloud-chip';
      chip.textContent = '☁ 云端内容 · 点 ▶ 播放';
      const media = f.querySelector('.hp-media');
      if (media) media.appendChild(chip);
    }
  }
  // 内容就位后再垂直居中一次，越出视口底部则收进来
  requestAnimationFrame(() => {
    const fr = f.getBoundingClientRect();
    if (fr.height) {
      let top = r.top + r.height / 2 - fr.height / 2;
      top = Math.max(10, Math.min(top, window.innerHeight - fr.height - 8));
      f.style.top = Math.round(top) + 'px';
    }
  });
}
/* 点赞（全站级）：同设备可赞/取消（localStorage 记录自己的点赞），点赞推高影片好评 */
const LIKE_MINE = new Set((() => { try { return JSON.parse(localStorage.getItem('hmp_likes') || '[]'); } catch { return []; } })());
function likeMineSave() { try { localStorage.setItem('hmp_likes', JSON.stringify([...LIKE_MINE])); } catch { /* ignore */ } }
async function likeToggle(btn) {
  const t = btn.dataset.like;
  if (!t || btn.dataset.busy) return;
  btn.dataset.busy = '1';
  const mine = LIKE_MINE.has(t);
  try {
    const r = await api('/api/like', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: t, delta: mine ? -1 : 1 }) });
    if (mine) LIKE_MINE.delete(t); else LIKE_MINE.add(t);
    likeMineSave();
    if (HP.cache) HP.cache.delete(t); // 失效悬停缓存：下次 hover 拉到加成后的新评分
    const n = r && r.likes;
    /* 同步屏幕上同一目标的所有赞按钮（浮层 + 弹窗），并当场刷新 ★ 评分 = 可见的点赞效果 */
    document.querySelectorAll('[data-like="' + CSS.escape(t) + '"]').forEach((b) => {
      if (b.classList.contains('cm-like')) b.textContent = LIKE_MINE.has(t) ? `❤ 已赞${n != null ? ' · ' + n : ''}` : `👍 赞${n ? ' · ' + n : ''}`;
      else { b.textContent = LIKE_MINE.has(t) ? '❤' : '👍'; b.classList.toggle('on', LIKE_MINE.has(t)); }
    });
    if (r && r.rating != null) {
      document.querySelectorAll('#hp-float .hp-meta, #card-modal .cm-meta').forEach((box) => {
        const star = [...box.querySelectorAll('.hp-chip')].find((c) => c.textContent.startsWith('★'));
        if (star) star.textContent = '★ ' + Number(r.rating).toFixed(1);
      });
    }
    toast(mine ? '已取消赞' : `❤ 已赞 · 好评 +0.1${n != null ? '（共 ' + n + ' 赞）' : ''}`, 1800);
  } catch { toast('点赞失败，请重试', 1800); }
  delete btn.dataset.busy;
}
function hpBind() {
  if (!hpCan()) return;
  document.addEventListener('mouseover', (e) => {
    const card = e.target.closest('[data-go],[data-phv],.mu-row[data-tid]');
    if (!card || card.closest('#hp-float')) return;
    /* fb：剧集详情页不弹悬停浮层——集行（.episode）是整行宽的列表项，不是海报卡，
       在上面展开浮层会巨大到遮住整屏；同页 Hero 的 ▶播放 按钮同理。该页保持点击直达即可 */
    if (card.classList.contains('episode') || card.closest('.detail-hero')) return;
    /* 影视缩略图走 hpOpen（试看片段），音乐缩略图走 mhOpen（试听片段），同一套 dwell / 关闭时序；
       eb：照片格（data-phv）走 pcOpen —— 按照片真实比例放大 */
    let hkind = hpTargetOf(card) ? 'v' : mhTargetOf(card) ? 'm' : phTargetOf(card) ? 'p' : bkTargetOf(card) ? 'b' : pcTargetOf(card) ? 'c' : msTargetOf(card) ? 's' : null;
    if (hkind === 's' && e.target.closest('.mu-like,.mu-addpl,.mu-sec-play')) return; // 行内功能按钮不弹浮层
    if (!hkind) return;
    if (HP.card === card || HP.pending === card) { // 同一张卡内部移动：只续命不重开
      if (HP.closeTimer) { clearTimeout(HP.closeTimer); HP.closeTimer = null; }
      return;
    }
    hpClose();
    HP.pending = card;
    /* Netflix 式：卡片停留 0.7s 确认意图后才展开预览（掠过不会乱闪） */
    /* Netflix 式：卡片停留 0.7s 确认意图后才展开预览（掠过不会乱闪）。
       遥控器模式下没有「划过去」这种误触，等太久手感发黏 —— 缩到 0.35s。 */
    const dwell = window.__tvActive ? 350 : 700;
    HP.timer = setTimeout(() => { HP.pending = null; (hkind === 'v' ? hpOpen : hkind === 'm' ? mhOpen : hkind === 'p' ? phOpen : hkind === 'c' ? pcOpen : hkind === 's' ? msOpen : bkOpen)(card); }, dwell);
  });
  document.addEventListener('mouseout', (e) => {
    const card = e.target.closest('[data-go],[data-phv],.mu-row[data-tid]');
    if (!card || card.closest('#hp-float')) return;
    if (HP.pending === card) { clearTimeout(HP.timer); HP.timer = null; HP.pending = null; }
    else if (HP.card === card) HP.closeTimer = setTimeout(hpClose, 260);
  });
  window.addEventListener('scroll', hpClose, { passive: true });
  window.addEventListener('hashchange', hpClose);
}
hpBind();

/* ---------------- 电视遥控器支持 ----------------
   电视浏览器里没有鼠标，只有方向键 / OK / 返回。而界面原本是「鼠标悬停 0.7 秒出浮层」，
   电视遥控器（含带滚轮的空鼠）往往只移动光标、不派发 hover —— 表现就是「能挪动，但悬浮图不出来」。
   这里的做法是「焦点即悬停」：
     ① 方向键按几何位置在卡片之间移动焦点（顺便把目标滚到屏幕中间）；
     ② 焦点落稳后给卡片派发一个合成 mouseover —— 直接复用上面那套悬停委托，
        影视 / 音乐 / 照片 / 书籍 / 朗读 / 游戏六套浮层一次性都支持遥控器；
     ③ OK（Enter）在没有原生点击的 div 卡片上补一次 click；
     ④ 返回键逐层退：浮层 → 详情大窗 → 弹层 → 回首页。 */
const TV = { cur: null, peekT: null };
function tvSkipKeys() {
  // 播放页 / 阅读器等自带键盘快捷键（←→ 快进退），遥控器导航不抢。
  // book：文字/漫画/PDF 阅读页 hash 前缀 #/book/（旧版曾是 #/read，改版后白名单没跟上，
  // 导致阅读页按 ←→ 翻页时 TV 导航同时移焦点——按钮光圈乱跳、焦点被滚到顶栏，2026-09-27 用户实测）
  const h = location.hash || '';
  return /^#\/(play|watch|read|book|player|tvplay|ltvplay)/.test(h) || !!document.getElementById('nav-player');
}
function tvVisible(el) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) return false;
  return true;
}
/* ★ 分两级：先只在「海报表」之间移动（这才是遥控器要看的），
   只有当焦点已经在工具栏上、或整页没有卡片时，才把按钮/链接纳入 ——
   否则方向键会在一堆小按钮里打转，浮层永远出不来（首版实测的坑）。 */
const TV_CARD_SEL = '[data-go],[data-phv],.mu-row[data-tid],.gm-card';
const TV_EXTRA_SEL = '.gm-chip,button,a[href]';
/* 顶部固定导航栏：电视遥控器必须能靠方向键到达（用户实测痛点）。
   影视中心是下拉触发 #nav-media（带 data-go，非 data-nav），一并纳入。 */
const TV_NAV_SEL = '[data-nav],#nav-media';
/* 只看一眼尺寸就能把「主卡片」和「页面内小按钮 / 迷你 tab」区分开：
   ① 纵向或方形大卡片（海报 / 封面）；
   ② 足够宽且足够高的扁链接（影视中心等「菜单页」整页都是 w683h35 这种链接，
      若只认海报就会 cards 全空 → 首焦点退化为顶栏并卡死）。
   导航小按钮（w64h32 等）、迷你「更多」（w34h17）因尺寸不够被排除，不会抢焦点。 */
function tvIsPoster(el) {
  const r = el.getBoundingClientRect();
  return (r.width >= 90 && r.height >= 110 && r.height >= r.width * 0.6)
      || (r.width >= 260 && r.height >= 30);
}
function tvItems(sel, postersOnly) {
  const out = [];
  document.querySelectorAll(sel).forEach((el) => {
    if (el.closest('#hp-float') || el.closest('.gdl-mask') || el.closest('#card-modal')) return;
    if (!tvVisible(el)) return;
    if (postersOnly && !tvIsPoster(el)) return;
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0'); // div 卡也能吃焦点
    if (!el.classList.contains('tv-focusable')) el.classList.add('tv-focusable');
    out.push(el);
  });
  return out;
}
function tvClear() { document.querySelectorAll('.tv-focus').forEach((e) => e.classList.remove('tv-focus')); }
function tvPeek(el) {
  clearTimeout(TV.peekT);
  // 等滚动停稳再派发：滚动会把刚开的浮层关掉（hpBind 里 scroll → hpClose）
  TV.peekT = setTimeout(() => {
    try { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window })); } catch { /* ignore */ }
  }, 260);
}
function tvFocus(el) {
  if (!el) return;
  tvClear();
  TV.cur = el;
  try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  el.classList.add('tv-focus');
  document.body.classList.add('tv-mode');
    window.__tvActive = true; // 交给 dweller：遥控器模式下浮层等待减半
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    tvPeek(el);
}
/* 按几何位置找某个方向上最合适的下一张：横移优先同行，纵移优先同列 */
function tvNext(dir) {
  const cards = tvItems(TV_CARD_SEL, true);
  const nav = tvItems(TV_NAV_SEL, false);
  // 其它散落小按钮（gm-chip / 普通 button / 非导航 a[href]）：排除导航栏本身，
  // 避免方向键在海报之间乱跳（首版实测的坑）。只在焦点已在工具栏上时再放开。
  const extras = tvItems(TV_EXTRA_SEL, false).filter((el) => !el.matches(TV_NAV_SEL));
  const lenient = cards.length ? cards : tvItems(TV_CARD_SEL, false); // 整页没有一张海报时才放宽
  let cur = TV.cur;
  if (cur && (!cur.isConnected || !tvVisible(cur))) cur = null;

  // 候选集分层：海报表是主体；顶部导航栏始终可达（首行海报按 ↑ 即进导航）；
  // 其余工具栏小按钮只在焦点已在工具栏上时纳入，防止海报间方向键被小按钮抢走。
  /* 顶栏（fixed）只在「向上」方向才作为候选：从首屏内容 ↑ 进导航栏（fp 修复的需求）；
     向下 / 左右绝不把 fixed 顶栏当「下方/同行」候选，否则末行 ↓ 会把顶栏误选（实测反复出现）。 */
  const wantNav = dir === 'ArrowUp';
  let list;
  if (cur && cur.matches && cur.matches(TV_NAV_SEL)) {
    /* dw：设置页这类「整页一张海报都没有」的页面，↓ 必须能落到页面内的按钮上，
       否则焦点死死钉在顶栏下不来（遥控器实测：进设置后按 ↓ 完全没反应）。 */
    list = nav.concat(cards.length ? cards : extras); // 导航内：←→ 切导航项、↓ 回内容
  } else if (cur && cur.matches && !cur.matches(TV_CARD_SEL)) {
    list = nav.concat(extras).concat(cards);          // 在其它小按钮上：全放开
  } else {
    // dw：无海报页（设置页等）把「零散卡片 + 页面控件」一起纳入，否则候选只剩顶栏菜单项
    const base = cards.length ? cards : (lenient.length ? lenient.concat(extras) : extras);
    list = base.concat(wantNav ? nav : []); // 海报上 / 空：海报 +（仅↑时）导航
  }
  if (!list.length) return null;
  if (!cur) {
    /* 第一次按方向键：从页面内容里的第一个可操作项开始（顶栏不做起跳点）。
       dw：过滤后为空也绝不回退到未过滤的 list[0] —— 那正是顶栏菜单（实测会钉在「影视中心」）。 */
    const startList = list.filter((el) => !el.matches(TV_NAV_SEL) && !(el.closest && el.closest('.topnav')));
    const inView = startList.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 24 && r.height > 24 && r.top >= 0 && r.bottom <= window.innerHeight;
    });
    return inView.length ? inView[0] : (startList[0] || null);
  }
  const b = cur.getBoundingClientRect();
  let best = null, bestScore = Infinity;
  for (const el of list) {
    if (el === cur) continue;
    const r = el.getBoundingClientRect();
    const dx = r.left + r.width / 2 - (b.left + b.width / 2);
    const dy = r.top + r.height / 2 - (b.top + b.height / 2);
    let score = Infinity;
    if (dir === 'ArrowLeft' && dx < -4) score = Math.abs(dx) + Math.abs(dy) * 3;
    else if (dir === 'ArrowRight' && dx > 4) score = Math.abs(dx) + Math.abs(dy) * 3;
    else if (dir === 'ArrowUp' && dy < -4) score = Math.abs(dy) + Math.abs(dx) * 1.2;
    else if (dir === 'ArrowDown' && dy > 4) score = Math.abs(dy) + Math.abs(dx) * 1.2;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}
/* 某方向无候选（走到行尾 / 页尾 / 视口外还有内容但还没滚进来）：自动朝该方向滚动一段，
   再重试选焦点 —— 纯方向键也能「翻屏续接」，不必靠滚轮（用户实测痛点）。
   关键：滚动前后比较位移，若已到底/到头（位移≈0）则保持原焦点，绝不跳到 fixed 顶栏；
   重试选到的元素也必须不是顶栏、且确实不同于当前焦点，避免「末行 ↔ 顶栏」来回跳。 */
function tvEdgeScroll(dir) {
  if (dir === 'ArrowLeft' || dir === 'ArrowRight') {
    const sc = TV.cur && TV.cur.closest && TV.cur.closest('.row-scroller');
    if (!sc) return;
    const l0 = sc.scrollLeft;
    sc.scrollBy({ left: dir === 'ArrowRight' ? sc.clientWidth * 0.9 : -sc.clientWidth * 0.9, behavior: 'auto' });
    if (Math.abs(sc.scrollLeft - l0) < 3) return;
    setTimeout(() => { const n = tvNext(dir); if (n && n !== TV.cur && !n.closest('.topnav')) tvFocus(n); }, 160);
    return;
  }
  const y0 = window.scrollY;
  window.scrollBy({ top: dir === 'ArrowDown' ? Math.round(window.innerHeight * 0.9) : -Math.round(window.innerHeight * 0.9), behavior: 'auto' });
  if (Math.abs(window.scrollY - y0) < 5) { if (TV.cur && TV.cur.scrollIntoView) TV.cur.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); return; }
  setTimeout(() => { const n = tvNext(dir); if (n && n !== TV.cur && !n.closest('.topnav')) tvFocus(n); else if (TV.cur && TV.cur.scrollIntoView) TV.cur.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); }, 180);
}
function tvBack() {
  if (document.getElementById('hp-float')) { hpClose(); gmFloatHide(); return true; }
  if (document.getElementById('card-modal')) { cardModalClose(); return true; }
  const pop = document.querySelector('.gdl-mask, .cm-mask, .ltv-mask, .mask');
  if (pop) { pop.remove(); return true; }
  if ((location.hash || '') !== '#/home') { location.hash = '#/home'; return true; }
  return false;
}
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tg = e.target || null;
  const tag = tg && tg.tagName ? tg.tagName : '';
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (tg && tg.isContentEditable);
  if (tvSkipKeys()) return;
  const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
  if (ARROWS.indexOf(e.key) >= 0) {
    if (typing) return;
    e.preventDefault();
    const n = tvNext(e.key);
    if (n) tvFocus(n);
    else tvEdgeScroll(e.key);
    return;
  }
  if (e.key === 'Enter' || e.key === 'OK' || e.key === ' ') {
    if (typing) return;
    const el = (TV.cur && TV.cur.isConnected) ? TV.cur : document.activeElement;
    if (el && el !== document.body
        && (el.hasAttribute('data-go') || el.hasAttribute('data-phv') || el.classList.contains('gm-card')
          || el.classList.contains('mu-row'))) {
      e.preventDefault();
      el.click();
    }
    return;
  }
  if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'BrowserBack' || e.key === 'Back') {
    if (typing) return;
    if (tvBack()) e.preventDefault();
  }
});
/* 换页后清焦点；遥控器用户（之前按过方向键）自动落第一张海报 —— 进页面就能用，
   不用先摸索着按一下；纯鼠标用户完全感知不到（tv-mode 没打开就不做这件事）。 */
window.addEventListener('hashchange', () => {
  TV.cur = null;
  tvClear();
  if (!document.body.classList.contains('tv-mode')) return;
  /* dw：设置页等是异步渲染的（要等好几个接口回来才有内容），单次 900ms 经常扑空，
     焦点就一直停在顶栏 → 改成多轮重试直到落到内容；起跳点排除顶栏，别再钉在导航栏上。 */
  let _tvTries = 0;
  const tryFocus = () => {
    _tvTries++;
    const list = tvItems(TV_CARD_SEL, true);
    const raw = list.length ? list.concat(tvItems(TV_CARD_SEL, false)) : tvItems(TV_EXTRA_SEL, false);
    const all = raw.filter((el) => !(el.closest && el.closest('.topnav')));
    const inView = all.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 50 && r.top < window.innerHeight - 80;
    });
    const el = inView[0] || all[0];
    if (!el) { if (_tvTries < 6) setTimeout(tryFocus, 600); return; }
    tvClear();
    TV.cur = el;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    el.classList.add('tv-focus');
    tvPeek(el);
  };
  setTimeout(tryFocus, 500);
});

/* el：沉浸顶栏同步——只在「带 Hero 的页面 + 未滚动」时透明；滚动 32px 内回落实底（纯背景切换，无布局跳动）
   ★ 流畅度：滚动事件里读 scrollY 后又写 classList 属读写交替，每触发一次就一次样式重算。
     电视端/触控板上滚动事件能到每帧数次，这里用 rAF 收敛成「每帧最多一次」，行为完全一致。 */
let _hnTick = false;
function heroNavSync() {
  if (_hnTick) return;
  _hnTick = true;
  requestAnimationFrame(() => {
    _hnTick = false;
    document.body.classList.toggle('nav-over-hero',
      document.body.classList.contains('has-hero') && (window.scrollY || 0) < 32);
  });
}
window.addEventListener('scroll', heroNavSync, { passive: true });

/* ---- 影视详情大窗（Netflix 式）：未悬停预览时点击缩略图弹出 ----
   电影窗：横图 + 进度/续播 + 属性/类型/简介 + 更多同类型；
   剧集窗：横图 + 播放（续播/首集）+ 季分组集列表，点哪集播哪集。 */
let CM_HIST = false; // 弹窗是否压过一条历史（用于「返回键关闭」）
/* 关闭弹窗（✕ / 点遮罩 / Esc）：从卡片点开时压过一条历史，顺手 return 一次，与返回键行为一致 */
function cardModalClose() {
  /* ★ 弹窗已不在 DOM 就绝不能再 history.back()——CM_HIST 残留 true 时（如返回键关窗后），
     back 会把 playNav 刚设的新 hash 弹回空，症状「点播放/点卡直接无法打开」 */
  if (!document.getElementById('card-modal')) { CM_HIST = false; return; }
  if (CM_HIST) { CM_HIST = false; try { history.back(); } catch { /* ignore */ } }
  cardModalCloseNow();
}
/* 直接拆除、不碰历史：弹窗内点「播放」要立刻改 hash 跳走时用，避免与 history.back 抢时序 */
function cardModalCloseNow() {
  const m = document.getElementById('card-modal');
  if (m) { m.classList.remove('on'); setTimeout(() => m.remove(), 200); }
  document.body.classList.remove('modal-open');
}
/* Netflix 式：弹窗路由驱动 —— 返回键即可关闭，浏览页滚动位置原样保留 */
window.addEventListener('popstate', () => {
  CM_HIST = false; // 返回键已消费那条压栈历史：不复位的话，之后每次 hashchange 都会被多弹一次 back
  if (document.getElementById('card-modal')) cardModalCloseNow();
});
/* 详情大窗取数：m:<id> / s:<key> 统一走 hover 接口（字段最全：简介/属性/续播进度/精彩片段起播点）。
   剧集窗额外补一次剧集详情（季分组集列表 + 续播到第几集），失败就只留主信息。 */
async function cardModalData(t) {
  if (t.startsWith('s:')) {
    const key = t.slice(2);
    const d = await api('/api/series/' + encodeURIComponent(key) + '/hover');
    return { ...d, kind: 'series', series_key: d.series_key || key };
  }
  const d = await api('/api/media/' + t.slice(2) + '/hover');
  return d;
}
async function openCardModal(t, srcEl) {
  cardModalCloseNow();
  const ov = document.createElement('div');
  ov.id = 'card-modal';
  ov.innerHTML = `<div class="cm-panel"><button class="cm-close" title="关闭">✕</button><div class="cm-body"><div class="empty-hint">加载中…</div></div></div>`;
  document.body.appendChild(ov);
  document.body.classList.add('modal-open');
  /* Netflix 式：弹窗路由驱动挂载 —— 压一条历史，返回键即可关闭，浏览页滚动位置保留 */
  if (!CM_HIST) { CM_HIST = true; try { history.pushState({ cm: 1 }, '', location.href); } catch { CM_HIST = false; } }
  const panel = ov.querySelector('.cm-panel');
  const from = srcEl && srcEl.getBoundingClientRect ? srcEl.getBoundingClientRect() : null;
  requestAnimationFrame(() => {
    ov.classList.add('on');
    /* 从被点击的卡片「长成」弹窗（FLIP），呼应 Netflix 的 poster → detail 过渡 */
    if (from && from.width && panel && panel.animate && panel.getBoundingClientRect) {
      const pr = panel.getBoundingClientRect();
      if (pr.width) {
        const sx = Math.max(0.2, from.width / pr.width);
        const sy = Math.max(0.2, from.height / pr.height);
        const tx = (from.left + from.width / 2) - (pr.left + pr.width / 2);
        const ty = (from.top + from.height / 2) - (pr.top + pr.height / 2);
        panel.animate([
          { transform: `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`, opacity: 0.4 },
          { transform: 'none', opacity: 1 },
        ], { duration: 300, easing: 'cubic-bezier(0, 0, 0.2, 1)' });
      }
    }
  });
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) cardModalClose(); });
  hpClose(); // 关掉可能开着的悬停浮层，别挡弹窗
  ov.addEventListener('scroll', hpClose, true); // 弹窗内滚动时收起浮层（capture 捕获子容器滚动）
  ov.querySelector('.cm-close').onclick = cardModalClose;
  /* ⌄ 展开钮（剧集/类似影片）走 ov 级事件委托：异步区块插入顺序不定，逐按钮绑 onclick 会被
     「取错节点/覆盖」坑过（dg 版事故）；委托按 data-exp 分发，插入顺序与绑定时机再也无关 */
  ov.addEventListener('click', (e) => {
    const b = e.target.closest('.cm-expand');
    if (!b || !ov.contains(b)) return;
    const fn = b.dataset.exp === 'sim' ? ov._expSim : ov._expEps;
    if (fn) fn();
  });
  /* 右侧半透明「回到顶部」：长剧集/长列表页滚动超过一屏才浮现，点击平滑回顶 */
  const topBtn = document.createElement('button');
  topBtn.className = 'cm-top-btn';
  topBtn.title = '回到顶部';
  topBtn.setAttribute('aria-label', '回到顶部');
  topBtn.innerHTML = '↑';
  topBtn.onclick = () => { try { ov.scrollTo({ top: 0, behavior: 'smooth' }); } catch { ov.scrollTop = 0; } };
  ov.appendChild(topBtn);
  ov.addEventListener('scroll', () => { topBtn.classList.toggle('on', ov.scrollTop > 480); }, { passive: true });
  let d;
  try { d = await cardModalData(t); } catch { ov.querySelector('.cm-body').innerHTML = '<div class="empty-hint">加载失败，请重试</div>'; return; }
  if (!document.getElementById('card-modal')) return; // 等待期间已被关闭
  const isSeries = d.kind === 'series' || d.kind === 'episode';
  const playHash = d.kind === 'series' ? '#/watch/' + encodeURIComponent(d.series_key) : '#/play/' + d.id;
  const img = (d.backdrop || d.poster) ? `/poster/${encodeURIComponent(d.backdrop || d.poster)}` : null;
  const prog = d.progress || null;
  const progHtml = prog ? `
      <div class="cm-prog">
        <div class="cm-prog-track"><div class="cm-prog-fill" style="width:${Math.min(100, (prog.position / (prog.duration || 1)) * 100)}%"></div></div>
        <div class="cm-prog-text">已播 ${Math.floor(prog.position / 60)} 分钟${prog.duration ? ` / 共 ${Math.round(prog.duration / 60)} 分钟` : ''}</div>
      </div>` : '';
  const genres = String(d.genre || '').split(/[,，、|/]/).map((x) => x.trim()).filter(Boolean);
  const infoHash = isSeries
    ? (d.series_key ? '#/series/' + encodeURIComponent(d.series_key) : '')
    : '#/detail/' + d.id;
  ov.querySelector('.cm-body').innerHTML = `
    <div class="cm-hero"${img ? ` style="background-image:url('${img}')"` : ''}>
      <div class="cm-hero-grad"></div>
      ${d.preview && d.preview.id ? `<video class="cm-video" muted playsinline preload="none" data-id="${d.preview.id}" data-src="/stream/${d.preview.id}" data-start="${d.preview.start || 0}" data-len="${d.preview.len || 12}"></video>` : ''}
      ${progHtml}
      <div class="cm-hero-title">${esc(d.title || '未命名')}</div>
      <div class="cm-hero-actions">
        <button class="btn-play cm-play">${prog ? '▶ 续播' : '▶ 播放'}</button>
        <button class="cm-like" data-like="${d.kind === 'series' ? 's:' + d.series_key : 'm:' + d.id}" title="赞">👍 赞</button>
      </div>
      ${d.preview && d.preview.id ? '<button class="cm-mute" title="声音">🔇</button>' : ''}
    </div>
    <div class="cm-info">
      <div class="cm-col-main">
        <div class="cm-meta">${hpChips([
        d.kind === 'series' ? `剧集 · ${d.episode_count || 0}集` : (d.kind === 'episode' ? `第${d.season ?? 1}季 第${d.episode ?? 1}集` : '电影'),
        d.year || '', d.duration ? fmtDur(d.duration) : '', d.quality || '', d.rating ? '★ ' + Number(d.rating).toFixed(1) : '',
      ])}</div>
        ${genres.length ? `<div class="cm-genre">${hpChips(genres.slice(0, 5))}</div>` : ''}
        ${d.overview ? `<div class="cm-overview">${esc(d.overview)}</div>` : ''}
        ${infoHash ? `<div class="cm-more"><button class="hp-ghost" data-go="${infoHash}">查看完整详情页 ›</button></div>` : ''}
      </div>
      <div class="cm-side"></div>
    </div>
    <div class="cm-extra"></div>`;
  ov.querySelector('.cm-play').onclick = () => {
    const hero = ov.querySelector('.cm-hero');
    cardModalCloseNow(); // 不碰历史：紧接着就要改 hash 跳播放页
    playNav(playHash, hero); // 从弹窗横图放大到全屏
  };
  const cmLike = ov.querySelector('.cm-like');
  if (cmLike) {
    if (LIKE_MINE.has(cmLike.dataset.like)) cmLike.textContent = '❤ 已赞';
    cmLike.onclick = () => likeToggle(cmLike); // 点赞/取消赞（同设备防重复计数）
  }
  /* 大窗内也预播精彩片段：静音自动播 12 秒后停回横图；标题/按钮始终在视频之上 */
  const cv = ov.querySelector('.cm-video');
  if (cv) {
    let cmTimer = null;
    const beginCm = () => {
      if (cmTimer) { clearTimeout(cmTimer); cmTimer = null; }
      try { cv.currentTime = d.preview.start || 0; } catch {}
      cv.classList.add('on');
      cv.play().catch(() => {});
      cmTimer = setTimeout(() => { try { cv.pause(); cv.classList.remove('on'); } catch {} }, (d.preview.len || 12) * 1000);
    };
    cv.src = cv.dataset.src;
    pvGuard(cv, d.preview.id, beginCm); // 同 Hero：解不动就换转码
    /* ★ 同 Hero：显式 load() 才真正拉流（详见 heroPreview 处说明） */
    if (cv.readyState >= 1) beginCm();
    else { cv.addEventListener('loadedmetadata', beginCm, { once: true }); try { cv.load(); } catch { /* ignore */ } }
  }
  const cmMute = ov.querySelector('.cm-mute');
  if (cmMute && cv) cmMute.onclick = () => { cv.muted = !cv.muted; cmMute.textContent = cv.muted ? '🔇' : '🔊'; }; // 预播默认静音自动播（浏览器策略），用户手势后可开声
  else if (cmMute) cmMute.remove();
  const extra = ov.querySelector('.cm-extra');
  if (isSeries && d.series_key) {
    /* 剧集：Netflix 式集列表（默认 10 集 + ⌄ 展开全部，点哪集播哪集）——不同人接着看可在这里重选 */
    try {
      const det = await api('/api/series/' + encodeURIComponent(d.series_key) + '/episodes'); // TMDB 每集标题/简介（服务端 24h 缓存）
      const eps = det.episodes || [];
      const epRow = (e, i) => `
        <div class="cm-ep2" data-ep="${e.id}">
          <span class="ep2-no">${i + 1}</span>
          <div class="ep2-thumb">${(e.still || d.backdrop) ? `<img loading="lazy" src="/poster/${encodeURIComponent(e.still || d.backdrop)}" alt="" onerror="this.remove()">` : ''}<span class="ep2-play">▶</span></div>
          <div class="ep2-main">
            <div class="ep2-head"><span class="ep2-name">${esc(e.name || '')}</span><span class="ep2-dim">${[e.progress_finished ? '✅ 已看完' : (e.progress_position ? `看到 ${Math.floor(e.progress_position / 60)} 分钟` : ''), e.duration ? fmtDur(e.duration) : ''].filter(Boolean).join(' · ')}</span></div>
            ${e.overview ? `<div class="ep2-ov">${esc(e.overview)}</div>` : ''}
          </div>
        </div>`;
      const EP_INIT = 10;
      const secEl = document.createElement('div');
      secEl.innerHTML = `
        <div class="cm-eps-head"><span>剧集</span><span class="cm-eps-title">${esc(d.title || '')}</span></div>
        <div class="cm-eps-list">${eps.slice(0, EP_INIT).map(epRow).join('')}</div>
        ${eps.length > EP_INIT ? '<div class="cm-expand-wrap"><button class="cm-expand" data-exp="eps" title="显示全部剧集">⌄</button></div>' : ''}`; // 没有更多集就不渲染箭头
      extra.insertBefore(secEl, extra.firstChild); // 剧集区恒在最上（类似影片/「关于」异步追加在后）
      const bindEps = () => secEl.querySelectorAll('.cm-ep2').forEach((el) => {
        el.onclick = () => { cardModalClose(); playNav('#/play/' + el.dataset.ep); };
      });
      bindEps();
      if (eps.length > EP_INIT) ov._expEps = () => { // 展开逻辑挂 ov，点击由 ov 级委托分发
        secEl.querySelector('.cm-eps-list').innerHTML = eps.map(epRow).join('');
        const w = secEl.querySelector('.cm-expand-wrap'); if (w) w.remove();
        bindEps();
      };
    } catch { /* 选集加载失败就不显示 */ }
  }
  /* 演职人员 + 更多类似影片：enrich 接口一次拿齐（cast 走 TMDB credits 24h 缓存；类似按类型重叠 + 评分，电影/剧集通用），异步填充不阻塞弹窗打开 */
  (async () => {
    let en = null;
    try {
      en = await api(d.kind === 'series' && d.series_key
        ? '/api/series/' + encodeURIComponent(d.series_key) + '/enrich'
        : '/api/media/' + d.id + '/enrich');
    } catch { /* 失败就少两块内容 */ }
    if (!en || !document.getElementById('card-modal')) return; // 等待期间已被关闭
    const side = ov.querySelector('.cm-side');
    if (side) {
      const gts = String(d.genre || '').split(/[,，、|/]/).map((x) => x.trim()).filter(Boolean);
      const cast = en.cast || [];
      side.innerHTML = `
        ${cast.length ? `<div class="cm-side-h">演职人员</div><div class="cm-side-v"><span class="cm-cast-short">${esc(cast.slice(0, 3).join('，'))}</span><span class="cm-cast-full hidden">${esc(cast.join('，'))}</span>${cast.length > 3 ? '<button class="hp-ghost cm-side-more" type="button">更多</button>' : ''}</div>` : ''}
        ${gts.length ? `<div class="cm-side-h">类型</div><div class="cm-side-v">${esc(gts.join('，'))}</div>` : ''}
        ${gts.length ? `<div class="cm-side-h">此${d.kind === 'series' ? '剧' : '电影'}</div><div class="cm-side-v">${hpChips(gts.slice(0, 4))}</div>` : ''}`;
      const moreBtn = side.querySelector('.cm-side-more');
      if (moreBtn) moreBtn.onclick = () => { // 「更多」展开全部演职人员
        const sh = side.querySelector('.cm-cast-short'); if (sh) sh.classList.add('hidden');
        const fu = side.querySelector('.cm-cast-full'); if (fu) fu.classList.remove('hidden');
        moreBtn.remove();
      };
    }
    const sims = en.similar || [];
    const ex = ov.querySelector('.cm-extra');
    const cast = en.cast || [];
    const creators = en.creators || [];
    const gtsAll = String(d.genre || '').split(/[,，、|/]/).map((x) => x.trim()).filter(Boolean);
    if (sims.length && ex) {
      const INIT = d.kind === 'series' ? 3 : 9; // 剧集默认一排 3 部；电影默认三排 9 部
      const simCard = (x) => `
        <div class="card cm-sim-card" data-cmsim="${x.kind === 'series' ? 's:' + x.series_key : 'm:' + x.id}" data-go="${x.kind === 'series' ? '#/series/' + encodeURIComponent(x.series_key) : '#/detail/' + x.id}">
          <div class="thumb-wrap">${(x.backdrop || x.poster) ? `<img class="thumb" loading="lazy" src="/poster/${encodeURIComponent(x.backdrop || x.poster)}" alt="" onerror="this.remove()">` : '<div class="thumb placeholder">🎬</div>'}<span class="cm-sim-dur">${x.duration ? fmtDur(x.duration) : (x.episode_count ? x.episode_count + ' 集' : '')}</span></div>
          <div class="sim-meta"><span class="sim-rate">${x.rating ? '★ ' + Number(x.rating).toFixed(1) : ''}</span>${x.year || ''}</div>
          <div class="sim-desc">${esc(x.overview || x.title || '')}</div>
        </div>`;
      ex.insertAdjacentHTML('beforeend', `<div class="cm-sec-head">更多类似影片</div><div class="cm-sim-grid">${sims.slice(0, INIT).map(simCard).join('')}</div>`
        + (sims.length > INIT ? '<div class="cm-expand-wrap"><button class="cm-expand" data-exp="sim" title="显示全部">⌄</button></div>' : '')); // 没有更多类似影片就不渲染箭头
      if (sims.length > INIT) ov._expSim = () => { // 展开逻辑挂 ov，点击由 ov 级委托分发
        ex.querySelector('.cm-sim-grid').innerHTML = sims.map(simCard).join('');
        const b = ex.querySelector('.cm-expand[data-exp="sim"]'); if (b) b.closest('.cm-expand-wrap').remove();
      };
      /* 类似卡带 data-go：悬停出浮层（放大+预播+播放）；点击换窗由全局 data-go 委托走 openCardModal */
    }
    if (ex) { /* Netflix 式「关于」区块：导演/原创人 + 演职人员 + 类型 + 此电影/此节目 */
      const rows = [
        creators.length ? [d.kind === 'series' ? '原创人' : '导演', creators.join('，')] : null,
        cast.length ? ['演职人员', cast.join('，')] : null,
        gtsAll.length ? ['类型', gtsAll.join('，')] : null,
        gtsAll.length ? [d.kind === 'series' ? '此节目' : '此电影', gtsAll.slice(0, 4).join('，')] : null,
      ].filter(Boolean);
      if (rows.length) ex.insertAdjacentHTML('beforeend', `
        <div class="cm-about"><div class="cm-about-h">关于《${esc(d.title || '')}》</div>
        ${rows.map(([k, v]) => `<div class="cm-about-row"><span class="cm-about-k">${k}：</span>${esc(v)}</div>`).join('')}</div>`);
    }
  })();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cardModalClose(); });
window.addEventListener('hashchange', cardModalClose);


/* 事件委托：data-go 跳转；data-back 返回上一页（无历史时回音乐中心） */
document.addEventListener('click', (e) => {
  const back = e.target.closest('[data-back]');
  if (back) {
    if (history.length > 1) history.back();
    else location.hash = '#/music';
    closeAllSubmenus();
    return;
  }
  const el = e.target.closest('[data-go]');
  if (el) {
    const go = el.dataset.go;
    // 悬停浮层内的按钮维持原语义；点原卡（HP.card）也走详情大窗——
    // ★ 直达播放对云盘源/未刮削条目可能黑屏「无法打开」，详情窗一定能打开，想播点窗里 ▶
    if (el.closest('#hp-float')) {
      /* 只有播放目标走渐黑放大过渡（渐黑层由播放页摘掉）；详细信息/相册/书籍直接跳转，否则渐黑层盖屏 */
      if (/^#\/play\/\d+/.test(go) || go.startsWith('#/watch/')) {
        playNav(go, (HP.card && HP.card.classList.contains('hp-active') ? HP.card : el.closest('#hp-float')) || el);
      } else if (/^#\/book\/\d+$/.test(go) || /^#\/music\/(album|artist)\//.test(go) || /^#\/photos\/lib\//.test(go)) {
        fadeNav(go, el); // eb：浮层主按钮（试听去专辑 / 阅读 / 查看相册）与影视播放同款渐变过渡
      } else {
        hpClose();
        location.hash = go;
      }
      return;
    }
    // 未悬停直接点击影视缩略图 → 详情大窗（按钮与剧集详情页的集行除外，保持直达）
    const t = hpTargetOf(el);
    if (t && el.tagName !== 'BUTTON' && el.tagName !== 'A' && !el.classList.contains('episode')) {
      openCardModal(t, el); // 传来源元素：弹窗从卡片「长出来」
      return;
    }
    if (/^#\/play\/\d+/.test(go) || go.startsWith('#/watch/')) { playNav(go, el); return; }
    if (el.closest('#card-modal')) {
      /* 弹窗内跳完整详情页：拆窗并放弃弹窗压的那条历史（CM_HIST=false）。
         ★ 不能只 cardModalCloseNow 就设 hash——hashchange 绑着 cardModalClose，会 history.back()
         把刚设的新 hash 弹回空，页面原地不动 = 「点击无效」。CM_HIST=false 后那次 close 变无害。 */
      cardModalCloseNow();
      CM_HIST = false;
      location.hash = go;
      return;
    }
    /* eb：发现页「去聆听 / 继续阅读 / 去回忆」主按钮（btn-play）也走渐变过渡，与浮层主按钮一致 */
    if (el.classList.contains('btn-play') && (/^#\/book\/\d+$/.test(go) || /^#\/music\/(album|artist)\//.test(go) || /^#\/photos\/lib\//.test(go))) {
      fadeNav(go, el);
      return;
    }
    location.hash = go;
    closeAllSubmenus();
  }
});

/* 顶部下拉菜单（影视中心）。
   开合统一用 .nav-drop-wrap.open 表达、由 CSS 决定呈现 —— 不再用 .hidden：
   .hidden 是 display:none !important，:hover 规则压不过它，历史上导致这个子菜单从来没打开过。
   文字本身照旧跳影视中心主页（#/media），旁边的 ▾ 是独立热区负责展开：
   手机没有 hover，只能靠点；拆成两个按钮也避免了「点开抽屉」和「跳转」抢同一个点击。 */
function closeAllSubmenus(except) {
  document.querySelectorAll('.nav-drop-wrap').forEach((w) => {
    if (w === except) return;
    w.classList.remove('open');
    const c = w.querySelector('.nav-caret');
    if (c) c.setAttribute('aria-expanded', 'false');
  });
}
document.querySelectorAll('.nav-drop-trigger').forEach(($trig) => {
  $trig.addEventListener('click', () => {
    closeAllSubmenus();
    location.hash = $trig.dataset.go || '#/media';
  });
});
document.addEventListener('click', (e) => {
  const caret = e.target.closest('.nav-caret');
  if (caret) {
    e.preventDefault();
    e.stopPropagation();
    const wrap = caret.closest('.nav-drop-wrap');
    const willOpen = !wrap.classList.contains('open');
    closeAllSubmenus(wrap);
    wrap.classList.toggle('open', willOpen);
    caret.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    return;
  }
  if (!e.target.closest('.nav-drop-wrap')) closeAllSubmenus();
});


/* ---------------- 主题（皮肤）切换 ----------------
   3 套（gy）：经典暗黑(默认，不设属性) / light 白色 / deepblue 蓝色。
   只切 html[data-theme]，style.css 里 :root 默认值 = 改造前硬编码色，所以默认主题零变化。
   持久化 localStorage 'hmp-theme'；入口在设置页「🎨 皮肤」（document 级委托，动态渲染可用）。 */
const THEME_KEY = 'hmp-theme';
const THEME_VALID = ['dark', 'light', 'deepblue'];
function themeCurrent() {
  try { const t = localStorage.getItem(THEME_KEY); if (THEME_VALID.indexOf(t) >= 0) return t; } catch (e) {}
  return 'dark';
}
function themeApply(t) {
  if (THEME_VALID.indexOf(t) < 0) t = 'dark';
  if (t === 'dark') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  document.querySelectorAll('[data-theme-set]').forEach((b) => {
    b.classList.toggle('on', b.getAttribute('data-theme-set') === t);
  });
  try { window.dispatchEvent(new CustomEvent('hmp-theme-change')); } catch (e) {}
}
themeApply(themeCurrent());
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-set]');
  if (!b) return;
  const t = b.getAttribute('data-theme-set');
  try { localStorage.setItem(THEME_KEY, t); } catch (err) {}
  themeApply(t);
});

/* ---------------- 首页（Infuse 式分区：主屏幕/每日精选/电影/电视/未观看的/最受好评） ---------------- */
let HERO = { timer: null, idx: 0 };
function heroStop() { if (HERO.timer) { clearInterval(HERO.timer); HERO.timer = null; } heroPreviewStop(); }

/* dw：Hero 换图周期最少半小时；换的只是头部大图（含预览），下面各行内容不动 ——
   行内容由 HOME_CACHE 管理，到 HOME_REFRESH_MS 后才在用户操作间隙后台静默换新 */
const HERO_ROTATE_MS = 30 * 60 * 1000;

function heroGo(box, i) {
  const all = box.querySelectorAll('.hero-slide');
  if (!all.length) return;
  const n = ((i % all.length) + all.length) % all.length;
  HERO.idx = n;
  all.forEach((el, k) => el.classList.toggle('on', k === n));
  box.querySelectorAll('.hero-dot').forEach((el, k) => el.classList.toggle('on', k === n));
  heroPreview(box, all[n]);
}

/* ---- Hero 预览播放（Netflix 式）：激活的 slide 静音自动播放精彩片段，播完淡出停回海报；
        片名等信息(.hero-content)全程置顶不隐藏 ---- */
/* 用户手势标记：浏览器只放行「有过交互」页面的有声自动播放 —— 点过页面/按过键后，Hero 预播才出声 */
let USER_ACTIVE = false;
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => { USER_ACTIVE = true; LAST_ACT = Date.now(); }, { capture: true, passive: true }));
let HERO_PREVIEW_TIMER = null;
let HERO_DELAY_TIMER = null; // dw：原「延迟 3 秒再起预播」按需求取消（打开程序立刻起播），变量仅留作旧定时器收尾
/* gz++：被浏览器 autoplay 策略静音兜底后，用户一旦有任何交互（遥控器按键 / 鼠标点击 / 触摸）
   就立刻给当前正在播的 Hero 预播解除静音恢复声音 —— 用户不需要任何额外操作。 */
let HERO_UNMUTE_ARMED = false;
function heroArmUnmute() {
  if (HERO_UNMUTE_ARMED) return;
  HERO_UNMUTE_ARMED = true;
  const on = () => {
    HERO_UNMUTE_ARMED = false;
    ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.removeEventListener(ev, on, true));
    /* Chrome 对「无用户激活的静音自动播放」解除静音后会**异步**强制暂停、且已播媒体的 play()
       promise 可能 resolve 但随后仍被停 → 单次补救赶不上时序。改为 5 秒内每 250ms 轮询：
       发现暂停就立即续播；unmuted play 被策略拒就回退静音续播 —— 画面绝不停住，
       真实遥控器/点击（带用户激活）则解除静音后直接有声续播。 */
    const resume = (x) => {
      const p = x.play();
      if (p && p.catch) p.catch(() => { x.muted = true; x.play().catch(() => {}); });
    };
    /* artp35b：静默窗口内不解除静音（刚看完片回来，别把上一部的声音接着放出来） */
    if (!hmpQuietAfterPlay()) {
      document.querySelectorAll('video.hero-video.on').forEach((x) => { x.muted = false; x.volume = 1; resume(x); });
    }
    let n = 0;
    const iv = setInterval(() => {
      n++;
      let alive = false;
      document.querySelectorAll('video.hero-video.on').forEach((x) => {
        alive = true;
        if (x.paused) resume(x);
      });
      if (n >= 20 || !alive) clearInterval(iv);
    }, 250);
  };
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, on, { capture: true, passive: true }));
}
function heroPreviewStop(box) {
  if (HERO_PREVIEW_TIMER) { clearTimeout(HERO_PREVIEW_TIMER); HERO_PREVIEW_TIMER = null; }
  if (HERO_DELAY_TIMER) { clearTimeout(HERO_DELAY_TIMER); HERO_DELAY_TIMER = null; }
  (box || document).querySelectorAll('video.hero-video').forEach((v) => {
    v.onended = null;
    v.pause();
    v.classList.remove('on');
  });
}
function heroPreview(box, slide) {
  heroPreviewStop(box);
  if (!slide) return;
  const v = slide.querySelector('video.hero-video');
  if (!v) return;
  const start = Number(v.dataset.start) || 0;
  const len = (Number(v.dataset.len) || 12) * 1000;
  if (!v.getAttribute('src')) v.setAttribute('src', v.dataset.src); // 惰性拉流：轮到这部才加载
  /* dw：打开程序就出声 —— 不再等用户先交互（USER_ACTIVE）；被浏览器 autoplay 策略拦下时，
     下面 play().catch 会自动转静音续播，大屏不会开天窗。悬停浮层预播开着时让位静音，避免两路叠音。 */
  v.muted = !!document.getElementById('hp-float') || hmpQuietAfterPlay(); // artp35b：刚看完片回来先静音预播，不串上一部的声音
  const begin = () => {
    if (HERO_PREVIEW_TIMER) { clearTimeout(HERO_PREVIEW_TIMER); HERO_PREVIEW_TIMER = null; }
    try { v.currentTime = start; } catch {}
    v.classList.add('on');
    v.play().catch((e) => { // 只有浏览器 autoplay 策略拦下才转静音续播；
      // 换转码源打断播放等其它错误（AbortError）交给 pvGuard 的 begin 重试，绝不白白掐掉声音
      if (e && e.name === 'NotAllowedError' && !v.muted) { v.muted = true; v.play().catch(() => {}); heroArmUnmute(); }
    });
    HERO_PREVIEW_TIMER = setTimeout(() => { v.pause(); v.classList.remove('on'); }, len);
  };
  v.onended = () => v.classList.remove('on');
  pvGuard(v, v.dataset.id, begin); // 解不动的片源换服务器转码，别让大屏开天窗
  /* ★ 修复：preload="none" 下只设 src 不触发资源选择，永远等不到 loadedmetadata
       → play() 被锁在回调里成了死锁，预览恒不播放。必须显式 load()。
     dw：打开程序不停留 —— 海报一到位就立刻起播 + 出声（原 3 秒延迟已取消）；
         仍核对这张 slide 还是不是当前大图，切换中已作废的就不放。 */
  const kick = () => {
    if (!slide.classList.contains('on')) return;
    begin();
  };
  if (v.readyState >= 1) kick();
  else { v.addEventListener('loadedmetadata', kick, { once: true }); try { v.load(); } catch { /* ignore */ } }
}

/* 由后端 hero 池构造 Hero 卡片（Netflix 式：一次一部、定时轮流、含精彩片段预览） */
function heroSlidesFromHero(hero) {
  return (hero || []).map((h) => {
    if (h.kind === 'series') {
      const p = h.backdrop || h.official_poster || h.poster;
      if (!p || !h.series_key) return null;
      return {
        img: `/poster/${encodeURIComponent(p)}`,
        eyebrow: '剧集精选',
        title: h.tmdb_title || h.title,
        meta: [h.year || '', `${h.episode_count || 0}集`],
        desc: '整季已就绪，随时开追',
        preview: h.preview,
        actions: `<button class="btn-play" data-go="#/watch/${encodeURIComponent(h.series_key)}">▶ 去追剧</button>
                  <button class="btn-ghost" data-go="#/series/${encodeURIComponent(h.series_key)}">详细信息</button>`,
      };
    }
    if (!h.id) return null;
    return {
      img: h.backdrop ? `/poster/${encodeURIComponent(h.backdrop)}` : posterUrl(h),
      eyebrow: '电影精选',
      title: h.tmdb_title || h.title || h.file_name,
      meta: [h.year || '', fmtDur(h.duration), '电影'],
      desc: h.rating ? `评分 ${h.rating}，值得一看` : '从媒体库精选，开始观看',
      preview: h.preview,
      actions: `<button class="btn-play" data-go="#/play/${h.id}">▶ 播放</button>
                <button class="btn-ghost" data-go="#/detail/${h.id}">详细信息</button>`,
    };
  }).filter(Boolean);
}

function heroHtml(slides, start = 0) {
  if (!slides.length) return '';
  const st = ((start % slides.length) + slides.length) % slides.length;
  const carousel = slides.length > 1;
  return `
    <section class="hero hero-carousel" id="hero-carousel">
      ${slides.map((sl, i) => `
      <div class="hero-slide${i === st ? ' on' : ''}${sl.square ? ' fit-contain' : ''}"${sl.img ? ` style="background-image:url('${sl.img}')"` : ''}>
        ${sl.square && sl.img ? `<img class="hero-fit-img" src="${sl.img}" alt="">` : ''}
        ${sl.preview ? `<video class="hero-video" muted playsinline preload="none" data-id="${sl.preview.id}" data-src="/stream/${sl.preview.id}" data-start="${sl.preview.start || 0}" data-len="${sl.preview.len || 12}"></video>` : ''}
        <div class="hero-content">
          <div class="hero-eyebrow">${esc(sl.eyebrow)}</div>
          <div class="hero-title">${esc(sl.title)}</div>
          <div class="hero-meta">${sl.meta.filter(Boolean).map((m) => `<span>${esc(String(m))}</span>`).join('')}</div>
          <div class="hero-desc">${esc(sl.desc)}</div>
          <div class="hero-actions">${sl.actions}</div>
        </div>
      </div>`).join('')}
      <!-- 用户明确不要轮播控件（圆点/箭头）：就是一张图定时换另一张（dw：最少半小时，只换大图） -->
    </section>`;
}

/* Hero 渲染后初始化：绑定圆点/箭头、启动轮播与首张预览 */
function heroInit(carousel) {
  const box = document.getElementById('hero-carousel');
  if (!box) return;
  if (carousel) heroRestart();
  box_dots_bind();
  heroPreview(box, box.querySelector('.hero-slide.on'));
}
function heroRestart() {
  if (HERO.timer) { clearInterval(HERO.timer); HERO.timer = null; }
  HERO.timer = setInterval(() => {
    const box = document.getElementById('hero-carousel');
    if (!box) { heroStop(); return; }
    const cur = [...box.querySelectorAll('.hero-slide')].findIndex((el) => el.classList.contains('on'));
    heroGo(box, cur + 1);
  }, HERO_ROTATE_MS); // dw：最少半小时才换下一张（Netflix 节奏）；只换大图，下面内容不动
}
function box_dots_bind() {
  const box = document.getElementById('hero-carousel');
  if (!box) return;
  box.querySelectorAll('.hero-dot').forEach((dt) => {
    dt.onclick = () => { heroGo(box, Number(dt.dataset.slide)); heroRestart(); };
  });
  const prev = box.querySelector('.hero-nav.prev');
  const next = box.querySelector('.hero-nav.next');
  if (prev) prev.onclick = () => {
    const cur = [...box.querySelectorAll('.hero-slide')].findIndex((el) => el.classList.contains('on'));
    heroGo(box, cur - 1); heroRestart();
  };
  if (next) next.onclick = () => {
    const cur = [...box.querySelectorAll('.hero-slide')].findIndex((el) => el.classList.contains('on'));
    heroGo(box, cur + 1); heroRestart();
  };
}

// 影视中心主页：音乐中心风格（左侧栏 + 内容横排），导航「影视中心」点进来
async function mediaHomeFetchData() {
  const [d, home] = await Promise.all([api('/api/home').catch(() => ({})), api('/api/media/home')]);
  return { d, home };
}
async function renderMediaHome() {
  const key = 'mediahome', hash = '#/media';
  const c = PAGE_CACHE[key];
  if (c) { // eu：30 分钟内回来缓存秒出，不闪加载；行内容轮换由服务端 4h rotShuffle 提供
    drawMediaHome(c.data);
    pageRefreshBackground(key, mediaHomeFetchData, (b) => { if (location.hash === hash) drawMediaHome(b); });
    window.scrollTo(0, 0);
    return;
  }
  $app.innerHTML = '<div class="empty-hint">加载中…</div>';
  let b;
  try { b = await mediaHomeFetchData(); }
  catch (e) { $app.innerHTML = `<div class="empty-hint">影视中心加载失败：${esc(e.message)}</div>`; return; }
  PAGE_CACHE[key] = { data: b, ts: Date.now() };
  drawMediaHome(b);
  window.scrollTo(0, 0); // 只有导航进入才回顶部；后台静默换新不动滚动位置
}
function drawMediaHome(b) {
  const d = b.d || {}, home = b.home || {};
  const cw = d.continueWatching || [];
  const hs = home.stats || {};
  const newest = (home.newest || []).slice(0, 6);
  const topRated = (home.topRated || []).slice(0, 6);
  const picks = home.picks || [], forYou = home.forYou || [];
  const taste = home.taste || {};
  const cardHash = (c) => (c.kind === 'series' && c.series_key)
    ? `#/watch/${encodeURIComponent(c.series_key)}` : `#/detail/${c.id}`;
  const cardTitle = (c) => c.tmdb_title || c.title || c.file_name || '未命名';
  const rowMeta = (c) => (c.kind === 'series'
    ? [`${c.episode_count || 0} 集`, c.year || '', c.rating ? '★' + Number(c.rating).toFixed(1) : '']
    : [c.year || '', '电影', c.rating ? '★' + Number(c.rating).toFixed(1) : '']
  ).filter(Boolean).join(' · ');
  // 双列卡片（最新上架 / 最受好评）：一行一部，序号红色细体，斑马纹由 .mu-dual-card 统一提供
  const dualCard = (title, sub, items) => `
    <div class="mu-dual-card">
      <h3 class="mu-sec">${esc(title)}<span class="mv-sec-sub">${esc(sub)}</span></h3>
      ${items.length ? `<div class="mu-list">${items.map((c, i) => {
        const p = posterUrl(c);
        return `<div class="mu-row mv-row" data-go="${cardHash(c)}" title="${esc(cardTitle(c))}">
          <span class="t-idx">${i + 1}</span>
          <span class="mv-thumb">🎬${p ? `<img loading="lazy" src="${p}" alt="" onerror="this.remove()">` : ''}</span>
          <span class="t-title">${esc(cardTitle(c))}</span>
          <span class="t-dim mv-meta">${esc(rowMeta(c))}</span>
        </div>`;
      }).join('')}</div>` : '<div class="empty-hint">暂无内容</div>'}
    </div>`;
  // 分类行：经典 + 动作/悬疑/科幻/动漫，空分类自动隐藏
  const CAT_KEYS = ['经典', '动作', '悬疑', '科幻', '动漫'];
  const catRows = (cats, suffix) => {
    const rows = CAT_KEYS.filter((k) => (cats[k] || []).length)
      .map((k) => rowHtml(`${k}${suffix}`, cats[k])).join('');
    if (!rows) return '';
    return `<h3 class="mv-group">${suffix === '影片' ? '🎬 影片分类' : '📺 剧集分类'}</h3>${rows}`;
  };
  const forYouSub = (taste.genres && taste.genres.length)
    ? `根据你的观影偏好：${taste.genres.join(' / ')}` : '';
  const side = `
    <aside class="mu-side">
      <div class="mu-side-title">影视中心</div>
      <a class="mu-side-item" data-go="#/movies">🎬 电影</a>
      <a class="mu-side-item" data-go="#/series-list">📺 剧集</a>
      <a class="mu-side-item" data-go="#/online/live">📡 电视直播</a>
    </aside>`;
  const empty = !newest.length && !topRated.length && !picks.length && !cw.length;
  /* ej：影视中心不放 Hero 大图（Hero 只留首页）；榜单/推荐行直接顶上去 */
  const main = `
    <section class="mu-main">
      <a class="back-link" data-go="#/home">‹ 返回首页</a>
      <div class="mu-head"><h2>影视中心</h2></div>
      ${(newest.length || topRated.length) ? `<div class="mu-dual mv-dual">
        ${dualCard('最新上架', '最近入库', newest)}
        ${dualCard('最受好评', '按评分排序', topRated)}
      </div>` : ''}
      ${rowHtml('最佳推荐', picks, { moreHash: '#/movies' })}
      ${cw.length ? rowHtml('继续观看', cw) : ''}
      ${forYou.length ? rowHtml('您可能喜欢', forYou, { headSub: forYouSub }) : ''}
      ${catRows(home.movieCats || {}, '影片')}
      ${catRows(home.seriesCats || {}, '剧集')}
      ${empty ? `<div class="empty-hint">${Kids.active ? '儿童模式下只显示家长勾选的目录内容，当前白名单里还没有影视；可请家长到「设置 → 儿童模式」勾选目录（网盘目录首次勾选会自动扫描）。' : '媒体库还是空的，先到设置里添加媒体目录并扫描入库。'}</div>` : ''}
    </section>`;
  $app.innerHTML = `<div class="mu-page">${side}${main}</div>`;
}

/* dw：首页内容刷新策略（Netflix 式低感知）——
   半小时内回主页：整页用缓存原样重现（下面内容不变），Hero 大图从下一张继续；
   距上次数据 ≥ 半小时：后台静默取新数据，若用户正在操作则等 4 秒间隙再换上 */
const HOME_REFRESH_MS = 30 * 60 * 1000;
let HOME_CACHE = null; // { data, ts }
let LAST_ACT = 0;      // 最近一次用户动作时刻（配合 USER_ACTIVE 判断是否正在操作）

async function renderHome() {
  if (HOME_CACHE) {
    renderHomeFrom(HOME_CACHE.data, (HERO.idx || 0) + 1); // 缓存秒出，不闪加载页
    homeRefreshBackground();
    return;
  }
  $app.innerHTML = '<div class="empty-hint">加载中…</div>';
  try { HOME_CACHE = { data: await api('/api/home'), ts: Date.now() }; }
  catch (e) { $app.innerHTML = `<div class="empty-hint">首页加载失败：${esc(e.message)}</div>`; return; }
  renderHomeFrom(HOME_CACHE.data, 0);
}
/* ei：菜单页（影视中心/音乐/书架）与首页同款低感知刷新——缓存秒出 + 30 分钟后台静默取新 + 操作间隙换上 */
const PAGE_CACHE = {}; // key -> { data, ts }
function pageRefreshBackground(key, fetchFn, applyFn) {
  const c = PAGE_CACHE[key];
  if (!c || Date.now() - c.ts < HOME_REFRESH_MS) return; // 未到 30 分钟：内容保持不变
  Promise.resolve().then(fetchFn).then((d) => {
    PAGE_CACHE[key] = { data: d, ts: Date.now() };
    const apply = () => { try { applyFn(d); } catch (e) { /* 静默：渲染失败不影响当前页面 */ } };
    if (Date.now() - LAST_ACT < 4000) setTimeout(apply, 4000); // 正在操作：等动作间隙再换
    else apply();
  }).catch(() => { /* 静默失败：下次进页再试 */ });
}

function homeRefreshBackground() {
  if (Date.now() - HOME_CACHE.ts < HOME_REFRESH_MS) return; // 未到规定时间：下面内容保持不变
  api('/api/home').then((d) => {
    HOME_CACHE = { data: d, ts: Date.now() };
    const apply = () => {
      const h = location.hash || '#/home';
      if (h === '#/home' || h === '#' || h === '#/' || h === '') renderHomeFrom(d, 0);
    };
    if (Date.now() - LAST_ACT < 4000) setTimeout(apply, 4000); // 正在操作：等动作间隙再换
    else apply();
  }).catch(() => { /* 静默失败：下次回主页再试 */ });
}

function renderHomeFrom(d, heroStart = 0) {
  const pool = d.dailyPicks && d.dailyPicks.length ? d.dailyPicks : (d.recent || []);
  // 空库判定用：Hero 不再放「继续观看」（继续观看只保留下方独立一栏）
  const first = (d.hero || []).find((x) => x.id) || (d.hero || [])[0] || pool.find((x) => x.id);
  /* ---- Hero 轮播：Netflix 式，一次只放一部、定时轮流换（后端已按新片优先排好池子）；
          音乐/书籍/相册没有可播的视频，只在无影视库时兜底 ---- */
  let slides = heroSlidesFromHero(d.hero);
  if (FEATURE_HIDDEN.has('media')) slides = []; // 影视隐藏：首页不放影视 Hero（走音乐/书/相册兜底）
  // 媒体库没有影视时退回静态精选，Hero 不开天窗
  if (!slides.length) {
  // 音乐专辑 ×2
  (d.musicAlbums || []).slice(0, 2).forEach((alb) => {
    slides.push({
      img: '/api/music/cover/' + alb.firstId + '?s=360', square: true,
      eyebrow: '音乐', title: alb.album,
      meta: [alb.year || '', `${alb.cnt} 首`],
      desc: '戴上耳机，进入你的音乐世界',
      actions: `<button class="btn-play" data-go="#/music/album/${encodeURIComponent(alb.album)}">▶ 去聆听</button>`,
    });
  });
  // 电子书 ×2
  (d.books || []).slice(0, 2).forEach((bk) => {
    slides.push({
      img: '/api/books/cover/' + bk.id + '?s=360', square: true,
      eyebrow: '书架', title: bk.title,
      meta: [bkAuthorDisp(bk), (bk.format || '').toUpperCase()].filter(Boolean),
      desc: '静下心来，读上几章',
      actions: `<button class="btn-play" data-go="#/book/${bk.id}">▶ 继续阅读</button>`,
    });
  });
  // 相册 ×1
  (d.photoAlbums || []).slice(0, 1).forEach((ph) => {
    slides.push({
      img: '/api/photos/libthumb/' + ph.coverId + '?v=2', square: true,
      eyebrow: '相册', title: ph.album,
      meta: [`${ph.count} 张照片`],
      desc: '重温那些美好瞬间',
      actions: `<button class="btn-play" data-go="#/photos/lib/${encodeURIComponent(ph.album)}">▶ 去回忆</button>`,
    });
  });
  }
  const hero = heroHtml(slides, heroStart);
  const seriesMk = (s) => cardHtml(
    { ...s, title: s.tmdb_title || s.title, year: s.year, kind: 'series', poster: s.official_poster || s.poster },
    { hash: `#/watch/${encodeURIComponent(s.series_key)}`, badge: `${s.episode_count}集`, sub: `${s.season_count}季` }
  );
  // 动漫专栏卡片：剧走 seriesMk（#/watch/:key + N集徽标），电影走默认卡（#/play/:id）
  const animeMk = (c) => (c.series_key ? seriesMk(c) : cardHtml(c));
    // 为你推荐卡片：sub 位置显示推荐理由（因为你看了《X》/ 你常看 A · B）；剧卡/电影卡由 cardHtml 按 kind 自动分流
    const recMk = (c) => cardHtml(c, { sub: c.reason });
  const musicMk = (a) => `
        <div class="card" data-go="#/music/album/${encodeURIComponent(a.album)}">
          <div class="thumb-wrap"><img class="thumb" loading="lazy" decoding="async" src="/api/music/cover/${a.firstId}?s=320" alt="" onerror="this.style.visibility='hidden'"></div>
          <div class="card-title">${esc(a.album)}</div>
          <div class="card-sub">${a.cnt} 首${a.year ? ' · ' + a.year : ''}</div>
        </div>`;
  const photoMk = (a) => `
        <div class="card" data-go="#/photos/lib/${encodeURIComponent(a.album)}?ph=${a.coverId}">
          <div class="thumb-wrap"><img class="thumb" loading="lazy" src="/api/photos/libthumb/${a.coverId}?v=2" alt="" onerror="this.style.visibility='hidden'"></div>
          <div class="card-title">${esc(a.album)}</div>
          <div class="card-sub">${a.count} 张</div>
        </div>`;
  const bookMk = (b) => `
        <div class="card" data-go="#/book/${b.id}">
          <div class="thumb-wrap"><img class="thumb" loading="lazy" decoding="async" src="/api/books/cover/${b.id}?s=320" alt="" onerror="this.style.visibility='hidden'"></div>
          <div class="card-title">${esc(b.title)}</div>
          <div class="card-sub">${esc(bkAuthorDisp(b))}${(b.format || '').toUpperCase() ? ' · ' + (b.format || '').toUpperCase() : ''}</div>
        </div>`;
  const hrow = (i, inner) => `<div data-hrow="${i}">${inner}</div>`;
  $app.innerHTML = `
    ${hero}
    ${hrow(0, rowHtml('影视精选', d.dailyPicks))}
    ${(d.continueWatching || []).length ? rowHtml('继续观看', d.continueWatching, { moreHash: '#/continue' }) : ''}
    ${hrow(1, rowHtml('电影', d.movies, { moreHash: '#/movies' }))}
    ${(d.series || []).length ? hrow(2, `<section class="row">
      <div class="row-head"><div class="row-title">剧集</div><a class="row-more" data-go="#/series-list">更多 ›</a></div>
      <button class="row-nav left" aria-label="向左滑动" data-rownav="-1">‹</button>
      <div class="row-scroller">${(d.series || []).map(seriesMk).join('')}</div>
      <button class="row-nav right" aria-label="向右滑动" data-rownav="1">›</button>
    </section>`) : ''}
    ${(d.anime || []).length ? hrow(3, rowHtml('动漫 · 番剧', d.anime, { cardFn: animeMk })) : ''}
    ${hrow(4, rowHtml('未观看的', d.unwatched))}
    ${(d.recommended || []).length ? hrow(5, rowHtml('为你推荐', d.recommended, { cardFn: recMk })) : ''}
    ${hrow(6, rowHtml('最受好评', d.topRated))}
    ${(d.musicAlbums || []).length ? hrow(7, `<section class="row">
      <div class="row-head"><div class="row-title">音乐专辑</div><a class="row-more" data-go="#/music">更多 ›</a></div>
      <button class="row-nav left" aria-label="向左滑动" data-rownav="-1">‹</button>
      <div class="row-scroller">${(d.musicAlbums || []).map(musicMk).join('')}</div>
      <button class="row-nav right" aria-label="向右滑动" data-rownav="1">›</button>
    </section>`) : ''}
    ${(d.photoAlbums || []).length ? hrow(8, `<section class="row">
      <div class="row-head"><div class="row-title">相册</div><a class="row-more" data-go="#/photos">更多 ›</a></div>
      <button class="row-nav left" aria-label="向左滑动" data-rownav="-1">‹</button>
      <div class="row-scroller">${(d.photoAlbums || []).map(photoMk).join('')}</div>
      <button class="row-nav right" aria-label="向右滑动" data-rownav="1">›</button>
    </section>`) : ''}
    ${(d.books || []).length ? hrow(9, `<section class="row">
      <div class="row-head"><div class="row-title">书架</div><a class="row-more" data-go="#/books">更多 ›</a></div>
      <button class="row-nav left" aria-label="向左滑动" data-rownav="-1">‹</button>
      <div class="row-scroller">${(d.books || []).map(bookMk).join('')}</div>
      <button class="row-nav right" aria-label="向右滑动" data-rownav="1">›</button>
    </section>`) : ''}
    ${(d.live || []).length ? hrow(10, `<section class="row">
      <div class="row-head"><div class="row-title">电视直播</div><a class="row-more" data-go="#/online/live">全部频道 ›</a></div>
      <button class="row-nav left" aria-label="向左滑动" data-rownav="-1">‹</button>
      <div class="row-scroller">${(d.live || []).map((c) => liveCard(c)).join('')}</div>
      <button class="row-nav right" aria-label="向右滑动" data-rownav="1">›</button>
    </section>`) : ''}
    ${(!first) ? `<div class="empty-hint">媒体库还是空的。<br>去「设置」添加影片目录，然后点右上角「扫描」。</div>` : ''}
  `;
  heroInit(slides.length > 1); // 绑定圆点/箭头，启动轮播与首张预览
  /* el：Netflix 式沉浸顶栏——首页有 Hero 时标记 has-hero（顶栏浮图），未滚动时透明 */
  document.body.classList.add('has-hero');
  heroNavSync();
  applyFeatureVisibility(); // 隐藏被关功能对应的首页分区行（data-hrow）
}

/* ---------------- 电视直播（首页频道卡） ---------------- */
function liveCard(c) {
  const logo = c.logo
    ? `<img class="thumb" loading="lazy" src="${esc(c.logo)}" alt="" onerror="this.style.visibility='hidden'">`
    : `<div class="thumb placeholder">📺</div>`;
  return `
  <div class="card" data-go="#/ltvplay/${encodeURIComponent(c.id)}">
    <div class="thumb-wrap">
      <span class="badge">● 直播</span>
      ${logo}
    </div>
    <div class="card-title">${esc(c.name)}</div>
    <div class="card-sub">${esc(c.group || '直播频道')}</div>
  </div>`;
}

/* ---------------- 在线观看（免费授权片源：在线电影 / 在线剧集） ---------------- */
function onlineCard(o) {
  return cardHtml(
    { title: o.title, year: o.year, poster: o.poster || o.posterFile },
    { hash: `#/oplay/${o.id}`, badge: o.category, sub: o.license || '' }
  );
}

async function renderOnline(mode = 'movies') {
  $app.innerHTML = `<div class="page"><div class="page-head"><div class="page-title">${mode === 'series' ? '在线剧集' : '在线电影'}</div></div><div class="grid"></div></div>`;
  let d;
  try { d = await api('/api/online/list'); } catch (e) {
    const g = $app.querySelector('.grid');
    if (g) g.innerHTML = `<div class="empty-hint" style="grid-column:1/-1">加载失败：${esc(e.message)}</div>`;
    return;
  }
  const head = $app.querySelector('.page-head');
  if (!head) return; // 页面已被更新的路由替换（并发导航保护）
  head.innerHTML = `
    <div class="page-title">${mode === 'series' ? '在线剧集' : '在线电影'}</div>
    <span class="page-sub">${(mode === 'series' ? d.series.length : d.movies.length)} 项 · ${d.usingRemote ? '远程片单' : '内置片单'}${d.updatedAt ? ' · 更新于 ' + new Date(d.updatedAt).toLocaleString() : ''} · 仅免费授权内容</span>
    <div class="grow"></div>
    <button class="btn-small" id="online-refresh">更新片单</button>`;
  const grid = $app.querySelector('.grid');
  if (mode === 'series') {
    const series = rotShuffle(d.series || [], 52); // 4 小时轮换
    grid.innerHTML = series.length ? series.map((s) => `
      <div>
        ${cardHtml({ title: s.title, poster: s.posterFile }, { hash: 'javascript:void(0)', badge: `${s.episodeCount} 集`, sub: s.category || '' })}
        <div class="online-eps hidden" data-series="${esc(s.key)}">
          ${s.episodes.map((ep) => `<div class="online-ep" data-go="#/oplay/${ep.id}">▶ ${esc(ep.title)}</div>`).join('')}
        </div>
      </div>`).join('')
      : '<div class="empty-hint" style="grid-column:1/-1">暂无在线剧集，内容会随远程片单更新加入</div>';
    // 点击剧集卡片展开/收起集列表
    grid.querySelectorAll('.card').forEach((card) => {
      card.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const eps = card.parentElement.querySelector('.online-eps');
        if (eps) eps.classList.toggle('hidden');
      });
    });
  } else {
    const mv = rotShuffle(d.movies || [], 53); // 4 小时轮换
    grid.innerHTML = mv.length ? mv.map(onlineCard).join('')
      : '<div class="empty-hint" style="grid-column:1/-1">片单为空</div>';
  }
  document.getElementById('online-refresh').onclick = async () => {
    const btn = document.getElementById('online-refresh');
    btn.disabled = true; btn.textContent = '更新中…';
    const r = await api('/api/online/refresh', { method: 'POST' });
    alert(r.ok ? (r.updated ? '片单已更新' : '未配置远程片单地址，仍为内置片单') : r.error);
    renderOnline(mode);
  };
}

/* 本地字幕文件 → vtt blob URL（2026-09-19 V19）：浏览器 <track> 只认 WebVTT，
   srt 要换头并把逗号毫秒改点、ass/ssa 要抽 Dialogue 去特效标签、GBK 老字幕要转码 */
async function localFileToVttUrl(file, shiftSec) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { try { text = new TextDecoder('gbk').decode(buf); } catch { text = new TextDecoder('utf-8').decode(buf); } }
  const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  let vtt = null;
  if (ext === '.vtt') {
    vtt = text.replace(/^\uFEFF/, '');
    if (!vtt.startsWith('WEBVTT')) vtt = 'WEBVTT\n\n' + vtt;
  } else if (ext === '.srt') {
    vtt = 'WEBVTT\n\n' + text.replace(/^\uFEFF/, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2');
  } else if (ext === '.ass' || ext === '.ssa') {
    let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const evIdx = text.toLowerCase().indexOf('[events]');
    const scope = evIdx >= 0 ? text.slice(evIdx) : text;
    const fmt = scope.match(/^Format:\s*(.+)$/mi);
    if (fmt) {
      const f = fmt[1].split(',').map((x) => x.trim().toLowerCase());
      if (f.includes('start') && f.includes('end') && f.includes('text')) fields = f;
    }
    const si = fields.indexOf('start');
    const ei = fields.indexOf('end');
    const ti = fields.indexOf('text');
    const pad = (x, n) => String(x).padStart(n, '0');
    const aTime = (t) => {
      const m = String(t || '').trim().match(/^(\d+):(\d{1,2}):(\d{1,2})\.(\d{1,3})$/);
      return m ? `${pad(Number(m[1]), 2)}:${pad(Number(m[2]), 2)}:${pad(Number(m[3]), 2)}.${pad(m[4].padEnd(3, '0'), 3)}` : null;
    };
    const cues = [];
    for (const line of text.split(/\r?\n/)) {
      if (!/^Dialogue:/i.test(line)) continue;
      const parts = line.replace(/^Dialogue:\s*/i, '').split(',');
      if (parts.length < ti + 1) continue;
      const s = aTime(parts[si]);
      const en = aTime(parts[ei]);
      if (!s || !en) continue;
      const tx = parts.slice(ti).join(',')
        .replace(/\{[^}]*\}/g, '')
        .replace(/\\N|\\n/g, '\n')
        .replace(/\\h/g, ' ')
        .trim();
      if (tx) cues.push(`${s} --> ${en}\n${tx}`);
    }
    if (cues.length) vtt = 'WEBVTT\n\n' + cues.map((c, i) => `${i + 1}\n${c}`).join('\n\n') + '\n';
  }
  if (!vtt) vtt = 'WEBVTT\n\n' + text; // 未知格式兜底：当纯文本 vtt 试一把
  /* artp23：本地字幕（blob URL）无法通过 query 参数加偏移，必须在生成时平移时间轴。
     同时保存原文（未平移），后续拖动/重挂时可按新偏移重建。 */
  window.__hmpLocalVttRaw = vtt;
  return URL.createObjectURL(new Blob([shiftVttClient(vtt, Number(shiftSec) || 0)], { type: 'text/vtt' }));
}
/* 客户端 WebVTT 时间轴平移（正=字幕延后）。兼容 MM:SS.mmm 与 HH:MM:SS.mmm，统一输出 HH:MM:SS.mmm。
   artp24 关键修复：**已经播过的台词（平移后结束时间 <= 0）必须整条丢弃**。
   原来用 Math.max(0, x) 把负值压成 0:00:00.000 → 一回退到流起点之前，
   前面几十条字幕全被压到同一时刻，于是屏幕上一坨字幕同时显示。 */
function vttTimeToSec(t) {
  const m = String(t).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})$/);
  if (!m) return null;
  return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}
function secToVttTime(x) {
  x = Math.max(0, x);
  const p = (v, n) => String(Math.floor(v)).padStart(n, '0');
  return p(x / 3600, 2) + ':' + p((x / 60) % 60, 2) + ':' + p(x % 60, 2) + '.' + p(Math.round((x - Math.floor(x)) * 1000), 3);
}
function shiftVttClient(vtt, deltaSec) {
  const d = Number(deltaSec) || 0;
  if (!d || !vtt) return vtt;
  const kept = [];
  String(vtt).split(/\n{2,}/).forEach((blk) => {
    const lines = blk.split('\n');
    let ti = -1;
    for (let i = 0; i < lines.length; i++) { if (lines[i].indexOf('-->') >= 0) { ti = i; break; } }
    if (ti < 0) { kept.push(blk); return; }                 // WEBVTT 头 / 无时间行
    const seg = lines[ti].split('-->');
    const a = vttTimeToSec(seg[0]);
    const b = vttTimeToSec(seg[1]);
    if (a == null || b == null) { kept.push(blk); return; }
    const na = a - d, nb = b - d;
    if (nb <= 0.05) return;                                  // ★ 已播过 → 丢弃（不是压成 0）
    lines[ti] = lines[ti].replace(/(\S+)\s*-->\s*(\S+)/, () => secToVttTime(na) + ' --> ' + secToVttTime(nb));
    kept.push(lines.join('\n'));
  });
  return kept.join('\n\n');
}
let currentArtPlayer = null; // 当前播放器实例（ArtPlayer 或兜底对象）统一登记，供切歌/离开时彻底销毁（暂停+移除 DOM video），杜绝旧 audio 残留
/* HMP 统一播放器外壳：用 ArtPlayer 包住 <video>，替换原来浏览器原生控制条。
   保留了 HMP 的全部媒体决策逻辑——直连/转码/remux 判定、字幕偏移重挂、断点续播、
   转码流 seek 都继续在底层 video 元素上操作（art.video）。
   注意：ArtPlayer 自带 HLS 检测只认 .m3u8 后缀；HMP 的直播/在线是「不带后缀的同源 HLS 代理」
   （靠 Content-Type 让 Safari 原生播，Chrome 靠 hls.js），所以 HLS 源由各 render 函数把 hls.js
   手动挂到 art.video，这里只负责建壳 + 通用配置（主题红/画中画/airplay/关自带热键与全屏）。 */
function hmpArtPlayer(container, opts) {
  /* artp35：建新播放器前无条件先清掉旧媒体。
     过去只依赖 hashchange 派清理，漏一次（异步竞态 / ArtPlayer 内部重建 video / 画中画独立存活）
     上一部就会变成游离元素继续出声；这里再兜一道，与巡检互为双保险。 */
  try { killAllPlayerMedia(); } catch (e) {}
  const o = Object.assign({
    container: container,
    theme: '#e50914',        // 与 HMP 主题红一致
    autoplay: true,
    playsInline: true,
    airplay: true,
    pip: true,               // 画中画：主流播放器标配
    fastForward: true,
    hotkey: false,           // HMP 自己管键盘（←→/空格），避免与 ArtPlayer 双触发
  }, opts || {});
  if (!window.Artplayer) {
    // 兜底：ArtPlayer 没加载到（极端情况），退化成裸 video，保证出画面
    const el = (typeof container === 'string') ? document.querySelector(container) : container;
    const v = document.createElement('video');
    v.controls = true; v.autoplay = true; v.playsInline = true;
    v.style.cssText = 'width:100%;height:100%;background:#000;';
    if (el) el.appendChild(v);
    const fb = {
      video: v, _fallback: true, url: '', fullscreen: false, on() {}, destroy() {
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
        try { v.remove(); } catch (e) {}
      },
    };
    currentArtPlayer = fb;
    return fb;
  }
  currentArtPlayer = new Artplayer(o);
  return currentArtPlayer;
}

/* artp34：进度条缩略图（Netflix 式悬停预览）。
   雪碧图由服务端 ffmpeg 抽帧生成并缓存；没生成完就不显示（后台生成中，下次点开自动带上）。
   自己画浮层而不依赖 ArtPlayer 内部 thumbnail 实现——它的缩略图配置必须在初始化时传入，
   而生成是异步的，等它生成完再起播会拖慢打开速度。 */
function setupThumbStrip(art, m, video) {
  try {
    const host = (art && art.template && art.template.$player) || document.querySelector('.art-video-player');
    if (!host) return;
    const tip = document.createElement('div');
    tip.className = 'hmp-thumb-tip';
    tip.style.display = 'none';
    host.appendChild(tip);
    let cfg = null;
    let upgradeTries = 0;
    /* 自证：控制台敲 __hmpThumbDiag() 可看到缩略图为什么没出来 */
    const diag = { id: m && m.id, ready: false, status: '', reason: '', url: '', bound: false, bindTries: 0, lastPg: '', moves: 0 };
    window.__hmpThumbDiag = () => diag;
    const hide = () => { tip.style.display = 'none'; };
    const durOf = () => {
      try { const d = Number(video && video.duration); if (Number.isFinite(d) && d > 1) return d; } catch (e) { /* ignore */ }
      return Number(m && m.duration) || 0;
    };
    /* 事件委托到整个播放器：进度条什么时候挂载都不影响，不用卡绑定时机 */
    const hitProgress = (e) => {
      const t = e.target;
      if (t && t.closest) {
        const pg = t.closest('.art-control-progress') || t.closest('.art-progress');
        if (pg) return pg;
      }
      const hr = host.getBoundingClientRect();
      if (hr.height && e.clientY >= hr.bottom - 120) {
        return host.querySelector('.art-control-progress') || host.querySelector('.art-progress');
      }
      return null;
    };
    const onMove = (e) => {
      if (!cfg) return;
      const pg = hitProgress(e);
      if (!pg) { hide(); return; }
      diag.lastPg = String(pg.className || '').slice(0, 60);
      diag.moves++;
      const r = pg.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1)));
      const d = durOf();
      if (!(d > 1)) return;
      const number = cfg.number || 100;
      const idx = Math.min(number - 1, Math.max(0, Math.floor(ratio * number)));
      const col = cfg.column || 10, w = cfg.w || 200, h = cfg.h || 112;
      tip.style.backgroundImage = 'url(' + cfg.url + ')';
      tip.style.backgroundSize = (w * col) + 'px auto';
      tip.style.backgroundPosition = '-' + ((idx % col) * w) + 'px -' + (Math.floor(idx / col) * h) + 'px';
      tip.style.width = w + 'px';
      tip.style.height = h + 'px';
      const hr2 = host.getBoundingClientRect();
      tip.style.left = Math.max(0, Math.min(e.clientX - hr2.left - w / 2, (hr2.width || 0) - w)) + 'px';
      tip.style.display = 'block';
      let tt = tip.querySelector('.hmp-thumb-t');
      if (!tt) { tt = document.createElement('span'); tt.className = 'hmp-thumb-t'; tip.appendChild(tt); }
      const sec = Math.max(0, Math.round(ratio * d));
      tt.textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    };
    host.addEventListener('mousemove', onMove);
    host.addEventListener('mouseleave', hide);
    diag.bound = true;
    const load = (retry) => {
      diag.bindTries++;
      api('/api/media/' + m.id + '/thumbstrip?n=100').then((d) => {
        if (d && d.ready) {
          const wasKey = cfg && cfg.url;
          cfg = d; diag.ready = true; diag.status = d.upgrading ? 'upgrading' : 'ready'; diag.url = d.url;
          try { const pre = new Image(); pre.src = d.url; } catch (e) { /* ignore */ }
          /* artp38：正在从旧尺寸升级到高清尺寸——先用小的顶着，继续轮询，
             高清版好了自动换（换 URL 后用户继续移动鼠标即可看到新图）。 */
          if (d.upgrading && upgradeTries < 90) {
            upgradeTries++;
            setTimeout(() => load(retry), 8000);
          }
          return;
        }
        diag.status = (d && d.status) || 'unknown';
        diag.reason = (d && d.reason) || '';
        if (retry > 0 && d && d.status === 'generating') setTimeout(() => load(retry - 1), 5000);
      }).catch(() => { diag.status = 'request-failed'; });
    };
    load(96); /* 生成中的片最多轮询 8 分钟：网盘片 40 帧实测要 2~8 分钟，轮询够久就自动出现，不用刷新 */
  } catch (e) { /* ignore */ }
}

/* 在线播放：ArtPlayer + 自动中文字幕 + HLS 自适应 */
async function renderOnlinePlayer(id) {
  destroyCurrentPlayer();
  let prep;
  try { prep = await api(`/api/online/play/${encodeURIComponent(id)}`); }
  catch (e) { return location.hash = '#/online'; }
  if (!prep.ok) {
    $app.innerHTML = `<div class="empty-hint">在线播放失败：${esc(prep.error || '未知错误')}</div>`;
    return;
  }
  $app.innerHTML = `
    <div class="player-page">
      <div class="player-top">
        <button class="player-back" id="player-back">‹ 返回</button>
        <div class="player-title">${esc(prep.title)}<span style="color:#9a9aa8;font-size:13px;margin-left:10px">在线片源</span></div>
      </div>
      <div id="art-mount" class="hp-art"></div>
      <div class="player-tools" id="player-tools">
        <button class="tool-btn" id="ext-sub-btn" title="选择外挂字幕文件">📂 外挂字幕</button>
        <button class="tool-btn" id="rmt-btn" title="手机扫码当遥控器">📱 遥控</button>
      </div>
      <div class="cc-menu hidden" id="cc-menu"></div>
    </div>`;
  const mount = document.getElementById('art-mount');
  const src = `/api/online/stream/${encodeURIComponent(id)}`;
  const isHls = /\.m3u8($|\?)/.test(prep.url || '');
  const nativeHls = (() => { const t = document.createElement('video'); return !!t.canPlayType('application/vnd.apple.mpegurl'); })();
  let art, video;
  if (isHls && !nativeHls && window.Hls && Hls.isSupported()) {
    // Chrome 等不支持原生 HLS：手动把 hls.js 挂到 ArtPlayer 的 video 上（代理地址不带 .m3u8 后缀）
    art = hmpArtPlayer(mount, { url: '' });
    video = art.video;
    video._hls = new Hls({ lowLatencyMode: true, backBufferLength: 30 });
    video._hls.loadSource(src);
    video._hls.attachMedia(video);
  } else {
    art = hmpArtPlayer(mount, { url: src });
    video = art.video;
  }
  video.onerror = () => {
    if (!video.dataset.fallback) {
      video.dataset.fallback = '1';
      const u = isHls ? prep.url : src; // 直连源站重试一次
      if (video._hls) { try { video._hls.destroy(); } catch (e) {} video._hls = null; }
      if (art._fallback) video.src = u; else art.url = u;
      video.play().catch(() => {});
    }
  };
  if (prep.subFile) {
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = '中文字幕';
    track.srclang = 'zh-CN';
    track.default = true;
    track.src = `/api/online/subtitle/${encodeURIComponent(id)}`;
    video.appendChild(track);
    video.addEventListener('loadedmetadata', () => {
      if (video.textTracks[0]) video.textTracks[0].mode = 'showing';
    }, { once: true });
  }
  /* 在线播放字幕菜单：自动中文字幕切换 + 本地字幕加载（2026-09-19 V18） */
  const ccMenu = document.getElementById('cc-menu');
  const ccCtl = document.querySelector('.art-control-hmp-cc');
  let autoSubOn = !!prep.subFile;
  function applyOnlineSub() {
    for (const tr of video.textTracks) tr.mode = 'disabled';
    if (autoSubOn && video.textTracks[0]) video.textTracks[0].mode = 'showing';
  }
  function renderOnlineCcMenu() {
    ccMenu.innerHTML = (prep.subFile ? '<button class="cc-item" id="cc-auto"><span class="cc-name">中文字幕（自动匹配）</span>' + (autoSubOn ? '<b class="cc-check">✓</b>' : '') + '</button>' : '<div class="cc-empty">本片无内置字幕</div>')
      + '<div class="cc-sep"></div>'
      + '<button class="cc-item" id="cc-off"><span class="cc-name">关闭字幕</span></button>'
      + '<input type="file" id="cc-file" accept=".srt,.ass,.ssa,.vtt" hidden>';
  }
  if (ccMenu) {
    if (!prep.subFile && ccCtl) ccCtl.classList.add('dim');
    ccMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = e.target.closest('.cc-item');
      if (!item) return;
      if (item.id === 'cc-auto') { autoSubOn = !autoSubOn; applyOnlineSub(); renderOnlineCcMenu(); ccMenu.classList.add('hidden'); }
      else if (item.id === 'cc-off') { autoSubOn = false; applyOnlineSub(); renderOnlineCcMenu(); ccMenu.classList.add('hidden'); }
      else if (item.id === 'cc-local') {
        const picker = ccMenu.querySelector('#cc-file');
        if (picker) picker.click();
      }
    });
    ccMenu.addEventListener('change', async (e) => {
      if (e.target.id !== 'cc-file' || !e.target.files || !e.target.files[0]) return;
      const f = e.target.files[0];
      autoSubOn = false;
      for (const tr of video.textTracks) tr.mode = 'disabled';
      // 移除之前的本地(blob)字幕轨，保留自动匹配的在线字幕轨
      video.querySelectorAll('track').forEach((t) => { if (t.src && t.src.startsWith('blob:')) t.remove(); });
      const t = document.createElement('track');
      t.kind = 'subtitles';
      t.label = f.name.replace(/\.[^.]+$/, '');
      t.srclang = 'zh-CN';
      t.src = await localFileToVttUrl(f);
      video.appendChild(t);
      t.track.mode = 'showing';
      if (ccCtl) ccCtl.classList.remove('dim');
    });
    const hideCc2 = (e) => {
      if (!ccMenu.classList.contains('hidden') && !e.target.closest('.cc-menu') && !e.target.closest('.art-control-hmp-cc')) ccMenu.classList.add('hidden');
    };
    document.addEventListener('click', hideCc2);
    window.addEventListener('hashchange', () => document.removeEventListener('click', hideCc2), { once: true });
  }
  /* 把 transport 注入 ArtPlayer 原生控制条（进度条上方那一行，不挡进度条） */
  const seekBy = (dt) => {
    try { video.currentTime = Math.min(Math.max(0, video.currentTime + dt), video.duration || Infinity); } catch { /* ignore */ }
  };
  addHmpControl(art, { name: 'hmp-home', position: 'left', index: 5, html: '⌂', tooltip: '返回在线片单', click: () => { location.hash = '#/online'; } });
  addHmpControl(art, { name: 'hmp-rw', position: 'right', index: 10, html: '⏪', tooltip: '快退 10 秒', click: () => seekBy(-10) });
  addHmpControl(art, { name: 'hmp-ff', position: 'right', index: 11, html: '⏩', tooltip: '快进 10 秒', click: () => seekBy(10) });
  addHmpControl(art, { name: 'hmp-cc', position: 'right', index: 30, html: '字幕', tooltip: '选择字幕轨', click: () => { renderOnlineCcMenu(); ccMenu.classList.toggle('hidden'); } });
  addHmpControl(art, { name: 'hmp-fs', position: 'right', index: 40, html: '⛶', tooltip: '全屏', click: () => fsToggle(document.querySelector('.player-page')) });
  const onPlayKey2 = (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') { seekBy(-10); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { seekBy(10); e.preventDefault(); }
    else if (e.key === ' ') { const ae = document.activeElement; if (ae && (ae.tagName === 'BUTTON' || ae === video)) ae.blur(); if (video.paused) video.play().catch(() => {}); else video.pause(); e.preventDefault(); }
  };
  document.addEventListener('keydown', onPlayKey2);
  window.addEventListener('hashchange', () => document.removeEventListener('keydown', onPlayKey2), { once: true });
  window.addEventListener('hashchange', () => { try { if (video._hls) video._hls.destroy(); } catch (e) {} try { art.destroy(); } catch (e) {} }, { once: true });
  /* 右上角高级工具：外挂字幕（不挡进度条） */
  const extBtn = document.getElementById('ext-sub-btn');
  if (extBtn) extBtn.onclick = () => { try { renderOnlineCcMenu(); const el = document.getElementById('cc-file'); if (el) el.click(); } catch (e) {} };
  const rmBtn2 = document.getElementById('rmt-btn');
  if (rmBtn2) rmBtn2.onclick = () => openRemotePanel();

  document.getElementById('player-back').onclick = () => history.back();
}

/* ---------------- 电视直播（JSON/M3U 频道片单，机制同在线片单） ---------------- */
async function renderLiveTv() {
  $app.innerHTML = '<div class="page"><div class="page-head"><div class="ph-l"><a class="head-back" data-back="1">返回</a><div class="page-title"></div></div></div><div class="ltv-wrap"><div class="empty-hint">加载中…</div></div></div>';
  $app.querySelector('.page-title').textContent = '电视直播';
  let d;
  try { d = await api('/api/livetv/list'); } catch (e) {
    const w = $app.querySelector('.ltv-wrap');
    if (w) w.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
    return;
  }
  const head = $app.querySelector('.page-head');
  if (!head) return; // 并发导航保护
  head.innerHTML = `
    <div class="ph-l"><a class="head-back" data-back="1">返回</a><div class="page-title">电视直播</div></div>
    <span class="page-sub">${d.total} 个频道${d.customCount ? `（含我的源 ${d.customCount} 个）` : ''}${d.customOnly ? ' · 仅我的源' : ''}${d.usingRemote ? ' · 含自定义片单' : ''}${d.updatedAt ? ' · 更新于 ' + new Date(d.updatedAt).toLocaleString() : ''}</span>
    <div class="grow"></div>`;
  const wrap = $app.querySelector('.ltv-wrap');
  if (!wrap) return;
  wrap.innerHTML = d.groups.length ? d.groups.map((g) => `
    <section class="ltv-group">
      <div class="ltv-group-title">${esc(g.name)}<span class="ltv-count">${g.channels.length}</span></div>
      <div class="ltv-channels">${g.channels.map((c) => `
        <button class="ltv-ch" data-go="#/ltvplay/${encodeURIComponent(c.id)}" title="${esc(c.note || c.name)}">
          ${c.logo ? `<img class="ltv-logo" src="${esc(c.logo)}" onerror="this.style.display='none'" alt="" />` : `<span class="ltv-logo ltv-logo-txt">${esc(c.name.slice(0, 2))}</span>`}
          <span class="ltv-name">${esc(c.name)}</span>
          <span class="ltv-live-dot">●</span>
        </button>`).join('')}</div>
    </section>`).join('')
    : '<div class="empty-hint">片单为空。到「设置」页填直播片单地址（JSON 或 m3u）。</div>';
  // 源管理与更新频道已移到「设置 → 📡 电视直播」，电视直播页只负责观看
}

async function renderLiveTvPlayer(id) {
  destroyCurrentPlayer();
  let prep;
  try { prep = await api(`/api/livetv/play/${encodeURIComponent(id)}`); }
  catch (e) { return location.hash = '#/online/live'; }
  if (!prep.ok) {
    $app.innerHTML = `<div class="empty-hint">直播打开失败：${esc(prep.error || '未知错误')}</div>`;
    return;
  }
  $app.innerHTML = `
    <div class="player-page">
      <div class="player-top">
        <button class="player-back" id="player-back">‹ 返回</button>
        <div class="player-title">${esc(prep.title)}<span class="ltv-live-badge">● 直播</span></div>
      </div>
      <div id="art-mount" class="hp-art"></div>
    </div>`;
  const mount = document.getElementById('art-mount');
  const src = `/api/livetv/stream/${encodeURIComponent(id)}`;
  // 服务端已嗅探真实类型并代理成同源地址（HLS 清单不带 .m3u8 后缀，靠 Content-Type 让 Safari 原生播）。
  // 所以：原生能放 HLS（Safari）→ 直接交给 ArtPlayer；Chrome 等不支持原生 HLS → 手动挂 hls.js 到 art.video。
  const nativeHls = (() => { const t = document.createElement('video'); return !!t.canPlayType('application/vnd.apple.mpegurl'); })();
  let art, video;
  if (prep.hls && !nativeHls && window.Hls && Hls.isSupported()) {
    art = hmpArtPlayer(mount, { url: '' });
    video = art.video;
    video._hls = new Hls({ lowLatencyMode: true, backBufferLength: 30 });
    video._hls.loadSource(src);
    video._hls.attachMedia(video);
    video._hls.on(Hls.Events.ERROR, (evt, data) => {
      if (data && data.fatal) { try { video._hls.destroy(); } catch (e) {} video._hls = null; if (art._fallback) video.src = src; else art.url = src; }
    });
  } else {
    art = hmpArtPlayer(mount, { url: src, isLive: true });
    video = art.video;
  }
  // 上/下一个频道（跨组顺序换台）注入原生控制条（进度条上方那一行，不挡进度条）
  let flat = [id];
  try {
    const d = await api('/api/livetv/list');
    flat = d.groups.flatMap((g) => g.channels.map((c) => c.id));
  } catch { /* 保持单频道兜底 */ }
  const jump = (dir) => {
    const i = flat.indexOf(id);
    if (i < 0) return;
    const n = flat[(i + dir + flat.length) % flat.length];
    if (n && n !== id) location.hash = '#/ltvplay/' + encodeURIComponent(n);
  };
  addHmpControl(art, { name: 'hmp-prev', position: 'right', index: 10, html: '⏮', tooltip: '上一个频道', click: () => jump(-1) });
  addHmpControl(art, { name: 'hmp-next', position: 'right', index: 11, html: '⏭', tooltip: '下一个频道', click: () => jump(1) });
  addHmpControl(art, { name: 'hmp-fs', position: 'right', index: 40, html: '⛶', tooltip: '全屏', click: () => fsToggle(document.querySelector('.player-page')) });
  window.addEventListener('hashchange', () => { try { if (video._hls) video._hls.destroy(); } catch (e) {} try { art.destroy(); } catch (e) {} }, { once: true });

  document.getElementById('player-back').onclick = () => location.hash = '#/online/live';
}

/* ---------------- 网格页 ---------------- */
async function renderGrid({ title, kind }) {
  const noCache = title === '继续观看'; // 时序数据不缓存（看了新片要马上出现）
  const key = noCache ? null : 'grid:' + (kind || 'all');
  const hash = kind === 'movie' ? '#/movies' : '#/all';
  const fetchRows = () => api(`/api/media?limit=500${kind ? `&kind=${kind}` : ''}`);
  const skeleton = () => { // 骨架先行：点菜单立即切页，数据后到
    $app.innerHTML = '<div class="page"><div class="page-head"><div class="ph-l"><a class="head-back" data-back="1">返回</a><div class="page-title"></div></div><span class="page-sub"></span></div><div class="grid"></div></div>';
    $app.querySelector('.page-title').textContent = title;
    $app.querySelector('.page-sub').textContent = kind ? '' : '剧集已按剧聚合';
  };
  const fill = (rows) => {
    const grid = $app.querySelector('.grid');
    if (!grid) return; // 页面已被更新的路由替换（并发导航保护）
    // 菜单页缩略图 4 小时轮换一次（否则每次进来顺序一模一样）；「继续观看」是时序数据，保持原序
    const list = title === '继续观看' ? rows : rotShuffle(rows, 41);
    grid.innerHTML = list.length
      ? list.map((m) => cardHtml(m)).join('')
      : '<div class="empty-hint" style="grid-column:1/-1">暂无内容</div>';
  };
  const c = key && PAGE_CACHE[key];
  if (c) { // ei：30 分钟内回来缓存秒出，不闪加载
    skeleton();
    fill(c.data);
    pageRefreshBackground(key, fetchRows, (d) => { if (location.hash === hash) { skeleton(); fill(d); } });
    return;
  }
  skeleton();
  const rows = await fetchRows();
  if (key) PAGE_CACHE[key] = { data: rows, ts: Date.now() };
  fill(rows);
}

/* ---------------- 剧集列表 / 详情 ---------------- */
async function renderSeriesList() {
  // 直接按剧渲染，不要再拉一遍全部影片（服务端 kind=null 已是折叠视图）
  // gj：标题原本误写成「电视」，导致点「剧集」进来以为走错了页
  $app.innerHTML = '<div class="page"><div class="page-head"><div class="ph-l"><a class="head-back" data-back="1">返回</a><div class="page-title">剧集</div></div><span class="page-sub">按剧集聚合</span></div><div class="grid"><div class="empty-hint" style="grid-column:1/-1">加载中…</div></div></div>';
  const series = await api('/api/series');
  const grid = $app.querySelector('.grid');
  if (!grid) return; // 页面已被更新的路由替换（并发导航保护）
  const rot = rotShuffle(series, 42); // 4 小时轮换：剧集页每次进来顺序不同
  grid.innerHTML = rot.length ? rot.map((s) => cardHtml(
    { title: s.tmdb_title || s.title, year: s.year, poster: s.official_poster || s.poster },
    { hash: `#/watch/${encodeURIComponent(s.series_key)}`, badge: `${s.episode_count}集`, sub: `${s.season_count}季` }
  )).join('') : '<div class="empty-hint" style="grid-column:1/-1">暂无剧集</div>';
}

/* 整页右侧半透明「回到顶部」（影片完整详情页用；详情大窗的挂在窗自身，互不影响） */
function pageTopBtnShow() {
  pageTopBtnHide();
  const b = document.createElement('button');
  b.id = 'page-top-btn';
  b.className = 'cm-top-btn';
  b.title = '回到顶部';
  b.setAttribute('aria-label', '回到顶部');
  b.innerHTML = '↑';
  b.onclick = () => { try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { window.scrollTo(0, 0); } };
  const onScroll = () => { b.classList.toggle('on', window.scrollY > 480); };
  window.__pageTopScroll = onScroll;
  window.addEventListener('scroll', onScroll, { passive: true });
  document.body.appendChild(b);
  onScroll();
}
function pageTopBtnHide() {
  const old = document.getElementById('page-top-btn');
  if (old) old.remove();
  if (window.__pageTopScroll) { window.removeEventListener('scroll', window.__pageTopScroll); window.__pageTopScroll = null; }
}

async function renderSeriesDetail(key, opts = {}) {
  $app.innerHTML = '<div class="empty-hint">加载中…</div>';
  let d;
  try { d = await api(`/api/series/${encodeURIComponent(key)}`); }
  catch { return renderSeriesList(); }
  const s = d.series;
  const poster = (s.official_poster || s.poster) ? `/poster/${encodeURIComponent(s.official_poster || s.poster)}` : null;
  const heroBg = s.backdrop ? `/poster/${encodeURIComponent(s.backdrop)}` : poster;
  const genreBadges = String(s.genre || '').split(',').filter(Boolean)
    .map((g) => `<span class="badge-genre">${esc(g.trim())}</span>`).join('');
  const seasonsHtml = d.seasons.map(({ season, episodes }) => `
    <section class="season-block">
      <div class="season-title">第 ${season} 季 · ${episodes.length} 集</div>
      ${episodes.map((e) => `
        <div class="episode" data-go="#/play/${e.id}">
          ${e.poster ? `<img class="thumb" loading="lazy" src="/poster/${encodeURIComponent(e.poster)}" alt="">` : '<div class="thumb placeholder">🎬</div>'}
          <div>
            <div class="ep-title">第 ${e.episode ?? '?'} 集 · ${esc(e.title || e.file_name)}</div>
            <div class="ep-sub">${fmtDur(e.duration)} · ${fmtSize(e.size)} · ${esc(e.ext.toUpperCase().slice(1))}${e.progress_finished ? ' · ✅ 已看完' : e.progress_position ? ` · 看到第 ${Math.floor(e.progress_position / 60)} 分钟` : ''}</div>
          </div>
        </div>`).join('')}
    </section>`).join('');
  $app.innerHTML = `
    <a class="back-link" data-go="#/series-list">‹ 返回剧集</a>
    <section class="detail-hero"${heroBg ? ` style="background-image:url('${heroBg}')"` : ''}>
      <div class="detail-info">
        <div class="detail-title">${esc(s.tmdb_title || s.title)}</div>
        <div class="detail-meta">
          ${s.year ? `<span>${s.year}</span>` : ''}
          <span>${s.season_count} 季 ${d.episodeTotal} 集</span>
          ${s.rating ? `<span>★ ${Number(s.rating).toFixed(1)}</span>` : ''}
          ${genreBadges}
        </div>
        ${s.overview ? `<div class="detail-overview">${esc(s.overview)}</div>` : ''}
        <div class="detail-actions">
          <button class="btn-play" data-go="#/watch/${encodeURIComponent(s.series_key || key)}">▶ 播放</button>
          <button class="btn-ghost" id="series-identify" title="手动识别：搜 TMDB 选定正确剧集，整剧所有集一起生效">⌕ 手动识别</button>
        </div>
        ${!s.tmdb_id || !s.overview ? '<div class="detail-fetching" id="detail-fetching"></div>' : ''}
      </div>
    </section>
    ${seasonsHtml}
  `;
  // 未刮削或缺简介 → 自动整剧抓一次详细内容，成功后原地重渲染（只重试一次防循环）
  if ((!s.tmdb_id || !s.overview) && !opts.retried) {
    autoScrapeDetail({ seriesKey: s.series_key || key, rerender: () => renderSeriesDetail(key, { retried: true }) });
  }
  // 剧集详情页手动识别入口：按 series_key 匹配，一次修正整剧（含所有季所有集）
  const idfBtn2 = document.getElementById('series-identify');
  if (idfBtn2) {
    idfBtn2.onclick = () => openIdentify({
      kind: 'episode',
      series_key: s.series_key || key,
      tmdb_title: s.tmdb_title,
      title: s.title,
    });
  }
  pageTopBtnShow(); // 长详情页右侧半透明回顶按钮
}

/* ---------------- 播放器 ---------------- */
let progressTimer = null;
let pendingSkipIntro = false; // 手动切下一集时置 true；新集无续看进度则跳过前情介绍（落 90 秒）
function saveProgress(mediaId, video) {
  if (!video || !mediaId) return;
  // playerAbsTime：转码重挂后 currentTime 是相对值，必须加回 ?start= 偏移才是内容位置
  navigator.sendBeacon
    ? navigator.sendBeacon('/api/progress', new Blob([JSON.stringify({ mediaId, position: playerAbsTime(video), duration: video.duration || 0 })], { type: 'application/json' }))
    : fetch('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaId, position: playerAbsTime(video), duration: video.duration || 0 }), keepalive: true });
}

/* 手动识别：自动刮削救不回的条目（脏文件名等），搜 TMDB 手动选定；
   剧集按 series_key 匹配 → 整剧所有集一起生效 */
function openIdentify(m) {
  const isTv = m.kind === 'episode';
  const preset = m.tmdb_title || m.title || m.file_name || '';
  const old = document.getElementById('idf-mask');
  if (old) old.remove();
  const mask = document.createElement('div');
  mask.className = 'picker-overlay';
  mask.id = 'idf-mask';
  mask.innerHTML = `
    <div class="picker idf">
      <div class="picker-head">
        <span>识别：${esc(preset)}${isTv ? '（按剧匹配，整剧生效）' : '（按电影匹配）'}</span>
        <button class="picker-x" id="idf-x">✕</button>
      </div>
      <div class="picker-jump">
        <input id="idf-q" placeholder="片名或英文原名，回车搜索" value="${esc(preset)}">
        <button id="idf-go">搜索</button>
      </div>
      <div class="picker-body" id="idf-list"><div class="picker-hint">点「搜索」从 TMDB 结果里选正确条目</div></div>
      <div class="idf-custom">
        <input id="idf-url" placeholder="没有理想海报？粘贴图片链接自行设置">
        <button id="idf-urlgo" title="下载该链接的图片并设为本条目海报">用链接设置海报</button>
        <button id="idf-filebtn" title="从本机选一张图片设为海报">上传本地图片</button>
        <input type="file" id="idf-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.onclick = (e) => { if (e.target === mask) close(); };
  document.getElementById('idf-x').onclick = close;
  const list = document.getElementById('idf-list');
  const input = document.getElementById('idf-q');
  const doSearch = async () => {
    const kw = input.value.trim();
    if (!kw) return;
    list.innerHTML = '<div class="picker-hint">搜索中…</div>';
    try {
      const r = await api(`/api/tmdb/search?kind=${isTv ? 'tv' : 'movie'}&q=${encodeURIComponent(kw)}`);
      if (!r.ok) throw new Error(r.error || '搜索失败');
      if (!r.list || !r.list.length) {
        list.innerHTML = '<div class="picker-hint">没有结果，换个名字（试试英文原名）</div>';
        return;
      }
      list.innerHTML = r.list.map((x) => `
        <div class="idf-row" data-id="${x.id}">
          ${x.poster ? `<img class="idf-poster" src="${esc(x.poster)}" alt="">` : '<div class="idf-poster idf-noimg">无图</div>'}
          <div class="idf-meta">
            <div class="idf-title">${esc(x.title)}${x.year ? ` <span class="idf-year">(${x.year})</span>` : ''}${x.rating ? ` <span class="idf-rate">★ ${x.rating}</span>` : ''}</div>
            ${x.original && x.original !== x.title ? `<div class="idf-orig">${esc(x.original)}</div>` : ''}
            <div class="idf-ov">${esc(x.overview || '')}</div>
          </div>
        </div>`).join('');
      list.querySelectorAll('.idf-row').forEach((row) => {
        row.onclick = async () => {
          const tmdbId = Number(row.dataset.id);
          list.querySelectorAll('.idf-row').forEach((r2) => { r2.style.pointerEvents = 'none'; });
          row.style.outline = '2px solid #7fd1a0';
          try {
            const res = await idfWrite('/api/tmdb/match', {
              tmdbId,
              kind: isTv ? 'tv' : 'movie',
              seriesKey: isTv ? m.series_key : null,
              mediaId: isTv ? null : m.id,
            });
            if (!res.ok) throw new Error(res.error || '应用失败');
            toast(`已识别：${res.title || ''}，正在刷新…`);
            setTimeout(() => location.reload(), 900);
          } catch (e) {
            toast(`识别失败：${e.message}`);
            list.querySelectorAll('.idf-row').forEach((r2) => { r2.style.pointerEvents = ''; });
            row.style.outline = '';
          }
        };
      });
    } catch (e) {
      list.innerHTML = `<div class="picker-hint">${esc(e.message)}</div>`;
    }
  };
  document.getElementById('idf-go').onclick = doSearch;
  input.onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
  setTimeout(() => input.select(), 60);
  if (preset) doSearch(); // 打开即按当前片名先搜一次，不满意可改词重搜

  /* 识别弹窗内的写操作（应用识别 / 设海报）：被管理密码 403 拦下时不干等报错，
     就地弹解锁框，解锁成功自动重试一次；用户取消则报「已取消」 */
  const idfWrite = async (path, body) => {
    const once = () => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      return await once();
    } catch (e) {
      if (!AdminLock.loaded) await adminLockSync();
      if (!(AdminLock.set && !AdminLock.unlocked)) throw e;   // 不是管理锁拦的，原样抛
      const ok = await adminAskUnlock();
      if (!ok) throw new Error('未输入管理密码，已取消');
      return once();
    }
  };

  /* 自定义海报：TMDB 无图/图不理想时贴链接或上传本地图，直接设为该条目海报 */
  const applyPoster = async (payload) => {
    try {
      const res = await idfWrite('/api/tmdb/custom-poster', {
        seriesKey: isTv ? m.series_key : null,
        mediaId: isTv ? null : m.id,
        ...payload,
      });
      if (!res.ok) throw new Error(res.error || '设置失败');
      toast('海报已更新，正在刷新…');
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      toast(`设置海报失败：${e.message}`);
    }
  };
  const urlIn = document.getElementById('idf-url');
  document.getElementById('idf-urlgo').onclick = () => {
    const u = urlIn.value.trim();
    if (u) applyPoster({ url: u });
  };
  const fileIn = document.getElementById('idf-file');
  document.getElementById('idf-filebtn').onclick = () => fileIn.click();
  fileIn.onchange = () => {
    const f = fileIn.files && fileIn.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => applyPoster({ dataUrl: String(rd.result) });
    rd.readAsDataURL(f);
  };
}

/* ---- 播放过渡：点击播放先渐黑（~330ms）再切入播放页，播放页就绪后揭开 ---- */
function playFadeEl() {
  let f = document.getElementById('play-fade');
  if (!f) {
    f = document.createElement('div');
    f.id = 'play-fade';
    document.body.appendChild(f);
  }
  return f;
}
function playNav(hash, src) {
  const f = playFadeEl();
  pfExpandPoster(f, src); // 过渡来源的海报放大层（卡片 <img> / 容器背景图，有才放）
  f.classList.add('on'); // 渐黑
  setTimeout(() => {
    location.hash = hash;
    setTimeout(() => {
      const el = document.getElementById('play-fade');
      if (el) el.querySelectorAll('.pf-poster').forEach((e) => e.remove());
    }, 60);
  }, 380);
}
/* playNav/fadeNav 共用：把来源卡片的海报从原位放大到全屏（Netflix 式），没有可用的图就不放 */
function pfExpandPoster(f, src) {
  let r = null;
  try { r = src && src.getBoundingClientRect ? src.getBoundingClientRect() : null; } catch { r = null; }
  let url = '';
  try {
    const img = src && src.querySelector ? (src.querySelector('.thumb') || src.querySelector('img')) : null;
    if (img) url = img.currentSrc || img.getAttribute('src') || '';
    if (!url && src && src.nodeType === 1 && typeof getComputedStyle === 'function') {
      const m = /url\(["']?(.+?)["']?\)/.exec(getComputedStyle(src).backgroundImage || '');
      if (m) url = m[1];
    }
  } catch { url = ''; }
  if (!(r && r.width > 0 && url)) return;
  const p = document.createElement('div');
  p.className = 'pf-poster';
  p.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`
    + `background-image:url('${url}')`;
  f.appendChild(p);
  requestAnimationFrame(() => {
    if (p.animate) {
      p.animate([
        { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' },
        { left: '0px', top: '0px', width: window.innerWidth + 'px', height: window.innerHeight + 'px' },
      ], { duration: 380, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' });
    }
  });
}
/* eb：渐变跳转（音乐专辑/歌手页、书籍阅读器、相册页）——与影视播放同款「渐黑 + 海报放大」过渡。
   与 playNav 的差别：目标不是播放器，所以揭开时机不靠 renderPlayer，
   由各目标 render 函数渲染完成后调 playFadeOut()；这里再兜一个 900ms 定时器防忘调卡黑屏。 */
function fadeNav(hash, src) {
  const f = playFadeEl();
  pfExpandPoster(f, src);
  f.classList.add('on');
  hpClose(); // 渐变起步时顺手收掉悬停浮层
  setTimeout(() => {
    location.hash = hash;
    setTimeout(() => {
      const el = document.getElementById('play-fade');
      if (el) el.querySelectorAll('.pf-poster').forEach((e) => e.remove());
      playFadeOut(); // 兜底揭开：render 函数里的显式 playFadeOut 先到就无感
    }, 900);
  }, 380);
}
function playFadeOut() {
  const f = document.getElementById('play-fade');
  if (!f) return;
  f.classList.remove('on');
  setTimeout(() => f.remove(), 420);
}
/* 剧集直达播放：有续播进度先续最近在看的一集，否则从第一集开始；失败退回剧集详情页 */
async function routeWatch(h) {
  const key = decodeURIComponent(h.replace('#/watch/', ''));
  try {
    const r = await api('/api/series/' + encodeURIComponent(key) + '/play');
    if (r && r.ok && r.id) { location.replace('#/play/' + r.id); return; }
  } catch { /* ignore */ }
  playFadeOut();
  return renderSeriesDetail(key);
}

/* 转码重挂后 ffmpeg 输出时间戳从 0 重排，video.currentTime 变成相对 ?start= 的相对时间。
   播放器里一切「内容位置」都必须用绝对时间 = currentTime + 当前 src 的 start 偏移：
   快进快退、进度保存（续播）、跳过片头窗口判定都靠它，否则 seek 会错位甚至不动。 */
function playerAbsTime(video) {
  if (!video) return 0;
  /* 虚拟时长补丁（renderPlayer 挂 _hmpAbsTime）：video.currentTime 已是内容绝对时间，直接返回 */
  if (video._hmpAbsTime) return video.currentTime || 0;
  const src = video.currentSrc || video.src || '';
  const mt = src.match(/[?&]start=(\d+(?:\.\d+)?)/);
  const off = (/\/transcode\//.test(src) && mt) ? (parseFloat(mt[1]) || 0) : 0;
  return (video.currentTime || 0) + off;
}

/* 台词跳播:直连流直接 seek;转码流不支持随机 seek,重挂 src 用 ?start= 从目标秒起转 */
function playerSeek(video, t) {
  if (!Number.isFinite(t) || t <= 0) return;
  try {
    const src = video.currentSrc || video.src || '';
    if (/\/transcode\//.test(src)) {
      const u = new URL(src, location.origin);
      u.searchParams.set('start', String(Math.floor(t)));
      /* artp22：重挂转码流前先清掉「旁路媒体」（旧转码连接/残留预览）。
         拖动进度条时旧连接可能仍在出声 → 表现为「一个视频两个声音」。只清旁路，不动当前 video。 */
      try { if (typeof silenceOtherMedia === 'function') silenceOtherMedia(); } catch (e) { /* ignore */ }
      // 记录目标位置：若重挂请求失败（503/转码异常）触发 onerror 回退，
      // 回退必须落回这个位置而非 currentTime（src 已变、currentTime 归 0 → 会从头播）
      video.dataset.seekT = String(Math.floor(t));
      /* artp18：把本次转码起点记在元素上，作为字幕 offset 的**可靠来源**。
         之前 addVttTrack 靠解析 video.src 的 ?start= 拿偏移，续播/拖动后若读取时机不对
         （源刚换、属性未更新）就加不上 → 字幕退回绝对轴 → 「续播后字幕从头开始显示」。 */
      video._hmpStart = Math.floor(t);
      // 重挂成功开播后立即清除登记，避免陈旧目标污染后续无关错误的回退位置
      video.addEventListener('playing', () => { delete video.dataset.seekT; }, { once: true });
      // ArtPlayer 包壳后用 art.url 重载（video.src 直设 ArtPlayer 不感知）；无 art 时退回裸 src
      if (video._art && !video._art._fallback) video._art.url = u.pathname + '?' + u.searchParams.toString();
      else video.src = u.pathname + '?' + u.searchParams.toString();
      video.play().catch(() => { /* 保持就绪 */ });
      return;
    }
  } catch { /* fallthrough:按直连处理 */ }
  try { video.currentTime = t; } catch { /* ignore */ }
}

async function renderPlayer(id, params) {
  destroyCurrentPlayer(); // 进入新播放页前彻底销毁上一个播放器（含旧 audio），避免叠放串音
  let m;
  try { m = await api(`/api/media/${id}`); } catch { return location.hash = '#/home'; }
  const isSeries = m.kind === 'episode';
  const sub = isSeries ? `S${m.season ?? 1}E${m.episode ?? 1}` : (m.year || '');
  $app.innerHTML = `
    <div class="player-page">
      <div class="player-top">
        <button class="player-back" id="player-back">‹ 返回</button>
        <div class="player-title">${esc(m.tmdb_title || m.title || m.file_name)}<span style="color:#9a9aa8;font-size:13px;margin-left:10px">${esc(sub)}${m.rating ? ` · ★ ${Number(m.rating).toFixed(1)}` : ''}</span></div>
      </div>
      <div id="art-mount" class="hp-art"></div>
      <div class="player-tools" id="player-tools">
        <button class="tool-btn" id="identify-btn" title="识别：搜 TMDB 补全海报与信息">⌕ 识别</button>
        <button class="tool-btn" id="rmt-btn" title="手机扫码当遥控器">📱 遥控</button>
        <!-- artp9：AI字幕/网络字幕/外挂字幕三个按钮已移除 —— 字幕功能统一收进原生控制条的「字幕」菜单，避免两处重复 -->
      </div>
      <div class="cc-menu hidden" id="cc-menu"></div>
    </div>`;
  playFadeOut(); // 渐黑过渡：播放页就绪，揭开
  // 直连判定：按浏览器真实解码能力探测（能解就直连原片零转码，解不动自动回退转码）
  // 4K 蓝光多为 HEVC+AC3/EAC3：NAS 软转码跟不上实时会卡顿，设备能硬解就务必直连
  const ct = (type, codec) => { const t = document.createElement('video'); return /probably|maybe/.test(t.canPlayType(type + '; codecs="' + codec + '"')); };
  const v = m.vcodec || '', a = m.acodec || '';
  const vDirect = /h264|avc|vp9|av1/.test(v)
    || (/hevc|hvc1|h265/.test(v) && (ct('video/mp4', 'hvc1.1.6.L93.B0') || ct('video/mp4', 'hev1.1.6.L93.B0')));
  const aDirect = /aac|mp3|opus|flac/.test(a)
    || (a === 'ac3' && ct('audio/mp4', 'ac-3'))
    || (/eac3|e-ac3/.test(a) && ct('audio/mp4', 'ec-3'));
  // 三档播放决策：
  // ① 视频+音频设备都解得动 → /stream 直连原片（零转码）
  // ② 视频解得动、音轨解不动（DTS/EAC3/TrueHD 常见）→ Remux：视频原样拷贝画质零损失，服务端只转音频
  // ③ 视频都解不动 → 整体转码（4K 源降 1080p 保实时）
  const supports = vDirect && aDirect;
  const vcopy = vDirect && !aDirect;
  /* artp25：强制直连模式（设置页可开）——浏览器能解就零转码直连，最流畅；
     解不了会黑屏/卡住，所以配一条自动回退：报错或 12 秒无播放头推进就切回转码。
     artp26：读 window.__hmpPlayMode，不能直接引用 settings（那是设置页函数的局部变量）。 */
  const forceDirect = String((typeof window !== 'undefined' && window.__hmpPlayMode) || 'auto') === 'direct';
  const playUrl = forceDirect ? `/stream/${m.id}` : `/transcode/${m.id}${vcopy ? '?vcopy=1' : ''}`;
  // 用 ArtPlayer 包住 video：原生控制条换成主流 UI（倍速/画中画/进度条/快捷键面板等）
  const mount = document.getElementById('art-mount');
  /* artp27：字幕改由**浏览器原生渲染**（::cue），不使用 ArtPlayer 的自绘字幕层。
     ArtPlayer 自绘层在 <track> 重载（我们的字幕轴自愈、拖动重挂都会触发）时不回收旧节点，
     必然残留出「上一句台词卡在画面上」的重影；原生渲染由浏览器管理 track 生命周期，不会残留。 */
  try { if (mount) mount.classList.add('hmp-native-subs'); } catch (e) { /* ignore */ }
  const art = hmpArtPlayer(mount, { url: playUrl });
  try { if (art && art.config) { art.config.subtitleShow = false; art.config.subtitle = false; } } catch (e) { /* 旧版本无此配置，交给 CSS 兜底 */ }
  setupThumbStrip(art, m, art.video); // artp34：进度条悬停缩略图（雪碧图后台生成好就自动生效）
  const video = art.video;
  video._art = art; // 供 playerSeek 在转码流重挂时用 art.url（而非裸 video.src）重载
  if (forceDirect) {
    let fellBack = false;
    const toTranscode = (why) => {
      if (fellBack) return;
      fellBack = true;
      const u = `/transcode/${m.id}${vcopy ? '?vcopy=1' : ''}`;
      try { if (art && !art._fallback) art.url = u; else video.src = u; } catch (e) { video.src = u; }
      toast('浏览器无法直接解码该片（' + why + '），已自动切回转码。想直连请安装 HEVC 扩展或改用 Edge', 6000);
    };
    video.addEventListener('error', () => toTranscode('解码报错'), { once: true });
    setTimeout(() => {
      if (fellBack) return;
      const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      const pos = d && d.get ? Number(d.get.call(video)) : Number(video.currentTime);
      if (video.readyState >= 1 && (!pos || pos < 0.1)) toTranscode('长时间无画面');
    }, 12000);
  }
  /* 进度条虚拟时长（修「进度条总在快到头位置跳动」）：
     转码/remux 流的 video.duration 是「已转出时长」（动态增长，起步仅 1~2s），
     ArtPlayer 进度条拿它当分母 → played 恒近 100% 且随缓冲增长乱跳。
     给 video 元素挂「绝对时间语义」的自有属性（遮蔽原型，ArtPlayer 的
     currentTime/duration/played/seek 全读 $video，vendor 无需改动）：
     duration = 全片总长(DB 探测值)；currentTime = 内容绝对时间（相对值+?start=偏移）；
     赋值 = 绝对位置 seek（转码流经 playerSeek 重挂 ?start=）。 */
  const hmpRealDur = (m && m.duration) || 0;
  if (!supports && hmpRealDur > 0) {
    try {
      const ctDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      const startOff = () => {
        const s = video.currentSrc || video.src || '';
        const mt = s.match(/[?&]start=(\d+(?:\.\d+)?)/);
        return mt ? (parseFloat(mt[1]) || 0) : 0;
      };
      const isTrans = () => /\/transcode\//.test(video.currentSrc || video.src || '');
      Object.defineProperty(video, 'duration', { configurable: true, get() { return hmpRealDur; } });
      Object.defineProperty(video, 'currentTime', {
        configurable: true,
        get() { const base = ctDesc.get.call(video) || 0; return isTrans() ? base + startOff() : base; },
        set(t) {
          t = Number(t);
          if (!Number.isFinite(t) || t < 0) return;
          /* artp16：转码流必须走 seekRemount（它会按新 start 重挂字幕）；
             走 playerSeek 会让进度条拖动后字幕仍按旧偏移顺序显示。 */
          if (isTrans()) seekRemount(t);
          else { try { ctDesc.set.call(video, t); } catch { /* ignore */ } }
        },
      });
      video._hmpAbsTime = true; // playerAbsTime 短路标记：currentTime 已是绝对时间
    } catch (e) { /* 补丁失败（极端环境）退回原生行为，仅进度条观感受影响 */ }
  }
  /* 活动字幕登记：转码流重挂 ?start=N 后时间戳从 0 重排，字幕轴需按新 start 平移重挂。
     声明必须在前（断点续播路径会先于字幕块调用 seekRemount，let 有 TDZ） */
  let activeSubSrc = null, activeSubLabel = '';
  /* seekRemount：转码流重挂后带 offset 重挂活动字幕（addVttTrack 读 video.src 的 start 算 offset）；
     直连流不重挂，原样 playerSeek。function 声明在作用域内提升，resume/seekBy 均可调用 */
  function seekRemount(t) {
    playerSeek(video, t);
    const isTrans = /\/transcode\//.test(video.currentSrc || video.src || '');
    /* artp16 修「拖动进度条后字幕不跟随」：转码流换 src 是异步的，
       此刻立即读 video.src 拿到的还是**旧**的 ?start= → 字幕带着旧偏移继续按顺序显示。
       必须等新源的 loadedmetadata，再按新的 start 重挂（偏移重算）。
       另加 120ms 防抖：按住拖动时ArtPlayer 会连续触发 seek，逐次重挂字幕会闪。 */
    let seekSubTimer = null;
    const remountSubs = () => {
      seekSubTimer = null;
      try {
        if (activeSubSrc) {
          const as = activeSubSrc.replace(/([?&])offset=-?[\d.]+/g, '$1').replace(/([?&])$/, '');
          clearSubTracks(true);
          addVttTrack(as, activeSubLabel, true);
        }
        if (typeof remountLiveSegs === 'function') remountLiveSegs();
      } catch (e) { /* 保底：至少别抛 */ }
    };
    if (isTrans) {
      clearTimeout(seekSubTimer);
      seekSubTimer = setTimeout(() => {
        if (video.readyState >= 1) remountSubs();
        else video.addEventListener('loadedmetadata', remountSubs, { once: true });
      }, 120);
    } else {
      remountSubs(); // 直连流：浏览器直接 seek，字幕轴不变，仅刷新 live 段偏移
    }
  }
  // 设备不支持 HEVC 时给一条安装引导（deep link 直跳 Windows 商店扩展页），装完刷新即直连
  /* artp10：安装引导只在「本浏览器首次」提示一次 —— 每次播 HEVC 片都弹一遍等于噪声 */
  let hevcHinted = false;
  try { hevcHinted = localStorage.getItem('hmp-hevc-hint-seen') === '1'; } catch { /* ignore */ }
  if (!vDirect && /hevc|hvc1|h265/.test(v) && !hevcHinted) {
    try { localStorage.setItem('hmp-hevc-hint-seen', '1'); } catch { /* ignore */ }
    const hint = document.createElement('div');
    hint.className = 'hevc-hint';
    hint.innerHTML = `⚙ 本设备缺少 HEVC 解码，正在用服务器转码（4K 大片可能卡顿）。
      <a href="ms-windows-store://PDP?productid=9n4wgh0z6vhq" target="_blank" rel="noopener">安装 HEVC 扩展</a> 后刷新即可直连播放
      <span class="hh-x" title="关闭">✕</span>`;
    hint.querySelector('.hh-x').onclick = () => hint.remove();
    mount.before(hint); // 插在播放器容器前（顶栏之下、画面之上）
  }
  video.onerror = () => {
    if (!video.dataset.fallback) {
      video.dataset.fallback = '1';
      // 回退位置优先取 playerSeek 登记的目标（dataset.seekT）：转码 seek 重挂失败时
      // currentTime 已归 0，直接用它会退回片头（用户看到的「快进后从头播放」）
      const st = Math.max(0, Math.floor(parseFloat(video.dataset.seekT) || video.currentTime || 0));
      if (art._fallback) video.src = `/transcode/${m.id}?start=${st}`; else art.url = `/transcode/${m.id}?start=${st}`;
      video.play().catch(() => {});
    }
  };

  // 断点续播；台词跳播（?t=）优先级最高；手动切下一集且该集没看过时，跳过前情介绍（落到 90 秒）
  const seekT = params ? parseFloat(params.get('t') || '') : NaN;
  try {
    const p = await api(`/api/progress/${m.id}`);
    if (Number.isFinite(seekT) && seekT > 0) {
      seekRemount(seekT);
    } else if (p && p.position > 30 && !(p.finished)) {
      // 转码流不能直接设 currentTime（断开重连、服务端从头重转），统一走 seekRemount 重挂 ?start=
      seekRemount(p.position);
    } else if (pendingSkipIntro) {
      seekRemount(90);
    }
  } catch {
    if (Number.isFinite(seekT) && seekT > 0) seekRemount(seekT);
    else if (pendingSkipIntro) seekRemount(90);
  }
  pendingSkipIntro = false;

  /* 快进/快退（键盘 ←→ + 下方注入原生控制条）与空格暂停：焦点不必在 video 上也生效 */
  const seekBy = (dt) => {
    // 转码流（/transcode/）是 ffmpeg 流式 fMP4，不支持 Range 随机 seek——直接设 currentTime
    // 会让浏览器断开重连、服务端从头重转（表现为「快进后退后回到片头」）。必须走 playerSeek：
    // 转码流重挂 ?start=N 从目标秒起转，直连流才直接 currentTime。
    // 目标按绝对内容位置算（playerAbsTime 加回 ?start= 偏移）——重挂后 currentTime 是相对值，
    // 直接拿它加减会错位（快退 10s 实际算出负数被钳到 0 → 看似「无效」）。
    // 钳位时长：转码/remux 流的 video.duration 是「已转码时长」（动态增长，起步仅 1~2s），
    // 拿它钳位会把快进目标钳回片头（实测 ff 后 start 从 90 被钳成 1）——转码流必须用 DB 时长；
    // 直连流 video.duration 是容器真实值，优先于 DB。
    const isTrans = /\/transcode\//.test(video.currentSrc || video.src || '');
    const dur = isTrans ? ((m && m.duration) || Infinity) : (video.duration || (m && m.duration) || Infinity);
    const t = Math.min(Math.max(0, playerAbsTime(video) + dt), dur);
    seekRemount(t); // 转码流重挂后字幕轴同步平移（addVttTrack 按 video.src 的 start 附加 offset 重挂活动字幕）
  };
  /* 把 transport 注入 ArtPlayer 原生控制条（进度条上方那一行，不挡进度条） */
  addHmpControl(art, { name: 'hmp-home', position: 'left', index: 5, html: '⌂', tooltip: '返回首页', click: () => { location.hash = '#/home'; } });
  addHmpControl(art, { name: 'hmp-rw', position: 'right', index: 10, html: '⏪', tooltip: '快退 10 秒', click: () => seekBy(-10) });
  addHmpControl(art, { name: 'hmp-ff', position: 'right', index: 11, html: '⏩', tooltip: '快进 10 秒', click: () => seekBy(10) });
  addHmpControl(art, { name: 'hmp-skip', position: 'right', index: 12, html: '跳过前情 ▸', tooltip: '跳过片头 / 前情回顾', click: () => { seekRemount(90); const sc = document.querySelector('.art-control-hmp-skip'); if (sc) sc.style.display = 'none'; } });
  addHmpControl(art, { name: 'hmp-cc', position: 'right', index: 30, html: '字幕', tooltip: '选择字幕轨（内嵌/外挂）', click: () => { ccMenuMode = 'track'; renderCcTrackMenu(); ccMenu.classList.toggle('hidden'); loadEmbTracks(); } });
  addHmpControl(art, { name: 'hmp-fs', position: 'right', index: 40, html: '⛶', tooltip: '全屏', click: () => fsToggle(document.querySelector('.player-page')) });
  /* artp34：倍速面板（Netflix/夸克标配）——0.5x~3x 常驻可调，选完记住，下一部片沿用 */
  const rateLabel = () => {
    const r = video.playbackRate || 1;
    return (Math.abs(r % 1) < 0.001 ? r.toFixed(0) : r.toFixed(2).replace(/0$/, '')) + 'x';
  };
  try { const saved = parseFloat(localStorage.getItem('hmp-rate') || '0'); if (saved >= 0.5 && saved <= 3) video.playbackRate = saved; } catch { /* ignore */ }
  const openRatePanel = () => {
    const old = document.getElementById('rate-panel');
    if (old) { old.remove(); return; }
    const host = document.querySelector('.player-page');
    if (!host) return;
    const panel = document.createElement('div');
    panel.id = 'rate-panel';
    panel.className = 'ep-panel hmp-rate-panel';
    const rates = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
    panel.innerHTML = '<div class="ep-panel-title">播放速度</div><div class="ep-panel-body">'
      + rates.map((r) => '<button class="ep-item" data-rate="' + r + '">' + r + 'x' + (Math.abs(r - (video.playbackRate || 1)) < 0.01 ? ' ✓' : '') + '</button>').join('')
      + '</div>';
    panel.querySelectorAll('[data-rate]').forEach((b) => {
      b.onclick = () => {
        const r = parseFloat(b.dataset.rate);
        try { video.playbackRate = r; } catch { /* ignore */ }
        try { localStorage.setItem('hmp-rate', String(r)); } catch { /* ignore */ }
        const el = document.querySelector('.art-control-hmp-rate');
        if (el) el.innerHTML = rateLabel();
        panel.remove();
        toast('播放速度 ' + r + 'x', 1600);
      };
    });
    host.appendChild(panel);
  };
  addHmpControl(art, { name: 'hmp-rate', position: 'right', index: 18, html: rateLabel(), tooltip: '播放速度', click: openRatePanel });
  const skipCtlEl = document.querySelector('.art-control-hmp-skip'); if (skipCtlEl) skipCtlEl.style.display = 'none'; // 跳过按钮默认隐藏，仅片头窗口期显示
  const onPlayKey = (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') { seekBy(-10); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { seekBy(10); e.preventDefault(); }
    else if (e.key === ' ') { const ae = document.activeElement; if (ae && (ae.tagName === 'BUTTON' || ae === video)) ae.blur(); if (video.paused) video.play().catch(() => {}); else video.pause(); e.preventDefault(); }
  };
  document.addEventListener('keydown', onPlayKey);
  window.addEventListener('hashchange', () => document.removeEventListener('keydown', onPlayKey), { once: true });
  window.addEventListener('hashchange', () => { try { if (video._hls) video._hls.destroy(); } catch (e) {} try { art.destroy(); } catch (e) {} }, { once: true });

  /* 连播三件套：下一集 / 跳过前情介绍 / 播完自动连播（上一集在下方） */
  const skipCtl = document.querySelector('.art-control-hmp-skip'); // 原生控制条上的「跳过前情」控件
  // 片头窗口期（时长 >= 10 分钟且进度 < 90 秒）显示跳过按钮
  // 时长用 DB 值兜底（转码 fMP4 流无 duration=NaN，否则转码播放时按钮永不出现）；
  // 位置用绝对时间（重挂后 currentTime 是相对 ?start= 的值）
  /* artp34：跳过片头做成 Netflix 式右下角浮层卡片（控制栏那个小按钮太小太难点，两个都留着） */
  let skipCard = null;
  const ensureSkipCard = () => {
    if (skipCard) return skipCard;
    const host = document.querySelector('.player-page');
    if (!host) return null;
    skipCard = document.createElement('div');
    skipCard.className = 'hmp-skip-card hidden';
    skipCard.innerHTML = '<button class="hmp-skip-btn">跳过片头 ▸</button>';
    skipCard.querySelector('.hmp-skip-btn').onclick = () => {
      seekRemount(90);
      try { skipCard.classList.add('hidden'); } catch { /* ignore */ }
      if (skipCtl) skipCtl.style.display = 'none';
    };
    host.appendChild(skipCard);
    return skipCard;
  };
  video.addEventListener('timeupdate', () => {
    const at = playerAbsTime(video);
    const show = (video.duration || m.duration || 0) >= 600 && at > 0.5 && at < 90;
    if (skipCtl) skipCtl.style.display = show ? '' : 'none';
    const card = ensureSkipCard();
    if (card) card.classList.toggle('hidden', !show);
  });
  if (isSeries) {
    let nextEp = null;
    try { const n = await api(`/api/media/${m.id}/next`); if (n && n.ok && n.media) nextEp = n.media; } catch { /* ignore */ }
    if (nextEp) {
      addHmpControl(art, { name: 'hmp-next', position: 'right', index: 14, html: '下一集 ▸', tooltip: '播放下一集（跳过前情介绍）', click: () => {
        saveProgress(m.id, video);
        pendingSkipIntro = true; // 手动切集：新集无续看进度时自动跳过前情介绍
        location.replace('#/play/' + nextEp.id); // replace 不留历史：连点几集后点「返回」直接回首页，不会倒回上一集
      } });
    }
    // 播完自动连播：切集前先落最后一次进度（服务端按 >95% 标记看完）；
    // 没有下一集停在结束画面，用户随时返回/关闭即终止连播
  /* artp34：播完倒计时连播（Netflix 式）——给 5 秒反悔窗口，可立即播放/取消 */
  const showNextCountdown = (ep) => {
    const go = () => { clearNextCd(); location.replace('#/play/' + ep.id); };
    try {
      const host = document.querySelector('.player-page');
      if (!host) { go(); return; }
      let card = document.getElementById('next-card');
      if (!card) {
        card = document.createElement('div');
        card.id = 'next-card';
        card.className = 'hmp-next-card';
        host.appendChild(card);
      }
      let left = 5;
      const title = ep.tmdb_title || ep.title || ('第 ' + (ep.episode ?? '?') + ' 集');
      const render = () => {
        card.innerHTML = '<div class="hmp-next-in">'
          + '<div class="hmp-next-t">即将播放 · 第 ' + esc(String(ep.episode ?? '?')) + ' 集</div>'
          + '<div class="hmp-next-n">' + esc(String(title)) + '</div>'
          + '<div class="hmp-next-btns"><button class="hmp-next-go">立即播放（' + left + '）</button>'
          + '<button class="hmp-next-cancel">取消</button></div></div>';
        card.querySelector('.hmp-next-go').onclick = go;
        card.querySelector('.hmp-next-cancel').onclick = () => { clearNextCd(); try { card.remove(); } catch { /* ignore */ } };
      };
      clearNextCd();
      render();
      window.__hmpNextCd = setInterval(() => {
        left -= 1;
        if (left <= 0) { go(); return; }
        try { render(); } catch { /* ignore */ }
      }, 1000);
    } catch (e) { go(); }
  };
  function clearNextCd() { try { if (window.__hmpNextCd) { clearInterval(window.__hmpNextCd); window.__hmpNextCd = null; } } catch { /* ignore */ } }
    video.addEventListener('ended', () => {
      saveProgress(m.id, video);
      if (!nextEp) return;
      pendingSkipIntro = false; // 自动连播从下一集开头正常播，想跳片头手动点跳过按钮
      showNextCountdown(nextEp); // artp34：5 秒倒计时，可立即播放 / 取消
    });
  }


  /* artp33: 长按 2x 快进（夸克/YouTube 特色）。按住播放画面 0.5s 临时 2 倍速，松开/拖进度/暂停即恢复。
     绑定在播放器容器上并排除控制栏/菜单区域，避免与点按暂停、菜单操作冲突 */
  (() => {
    let pressTimer = null, active = false, prevRate = 1;
    const host = document.querySelector('.art-video-player') || video;
    const badge = () => host.querySelector('.hmp-2x-badge');
    const showBadge = (on) => {
      try {
        let b = badge();
        if (on && !b) {
          b = document.createElement('div');
          b.className = 'hmp-2x-badge';
          b.textContent = '▶▶ 2 倍快进中';
          host.appendChild(b);
        } else if (!on && b) { b.remove(); }
      } catch { /* ignore */ }
    };
    const cancel = () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (active) {
        active = false;
        try { video.playbackRate = prevRate || 1; } catch { /* ignore */ }
        showBadge(false);
      }
    };
    host.addEventListener('pointerdown', (e) => {
      if (e.button && e.button !== 0) return;
      if (e.target.closest('.art-bottom, .art-control, .art-layer, #cc-menu, #ep-panel, .art-settings, .art-mask, .hmp-2x-badge')) return;
      if (video.seeking || video.ended) return;
      cancel();
      pressTimer = setTimeout(() => {
        pressTimer = null;
        if (video.paused || video.seeking || video.ended) return;
        try { prevRate = video.playbackRate || 1; video.playbackRate = 2; active = true; showBadge(true); } catch { /* ignore */ }
      }, 500);
    }, true);
    host.addEventListener('pointerup', cancel, true);
    host.addEventListener('pointercancel', cancel, true);
    host.addEventListener('pointerleave', cancel, true);
    video.addEventListener('ended', cancel);
    video.addEventListener('pause', cancel);
    host.addEventListener('contextmenu', (e) => { if (e.target === video) e.preventDefault(); });
  })();

  /* artp34：移动端手势 —— 左半屏上下滑调亮度、右半屏上下滑调音量（Netflix/夸克都是这套） */
  (() => {
    const gHost = document.querySelector('.art-video-player') || video;
    if (!gHost) return;
    let gs = null;
    const hintEl = () => {
      let h = gHost.querySelector('.hmp-gest-hint');
      if (!h) {
        h = document.createElement('div');
        h.className = 'hmp-gest-hint';
        gHost.appendChild(h);
      }
      return h;
    };
    const showHint = (txt) => {
      try {
        const h = hintEl();
        h.textContent = txt;
        h.classList.add('on');
        clearTimeout(h._t);
        h._t = setTimeout(() => h.classList.remove('on'), 900);
      } catch { /* ignore */ }
    };
    gHost.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { gs = null; return; }
      const x = e.touches[0].clientX, y = e.touches[0].clientY;
      const w = gHost.clientWidth || 1;
      const mode = x < w * 0.4 ? 'bright' : 'volume';
      let base = 0;
      if (mode === 'volume') { try { base = video.volume; } catch { base = 1; } } else { base = gHost._hmpBright || 1; }
      gs = { y, mode, base };
      if (mode === 'volume') { try { video.muted = false; } catch { /* ignore */ } }
    }, { passive: true });
    gHost.addEventListener('touchmove', (e) => {
      if (!gs || e.touches.length !== 1) return;
      const dy = gs.y - e.touches[0].clientY;                 // 上滑为正
      const delta = dy / (gHost.clientHeight || 300);
      if (gs.mode === 'volume') {
        const v = Math.min(1, Math.max(0, gs.base + delta));
        try { video.volume = v; } catch { /* ignore */ }
        showHint('🔊 ' + Math.round(v * 100) + '%');
      } else {
        const b = Math.min(2, Math.max(0.3, gs.base + delta));
        gHost._hmpBright = b;
        try { video.style.filter = 'brightness(' + b.toFixed(2) + ')'; } catch { /* ignore */ }
        showHint('☀ ' + Math.round((b / 2) * 100) + '%');
      }
    }, { passive: true });
    gHost.addEventListener('touchend', () => { gs = null; }, { passive: true });
    gHost.addEventListener('touchcancel', () => { gs = null; }, { passive: true });
  })();


  /* 上一集：切前落进度；回看已看过的集不跳前情（断点续播自然接管） */
  if (isSeries) {
    let prevEp = null;
    try { const pv = await api(`/api/media/${m.id}/prev`); if (pv && pv.ok && pv.media) prevEp = pv.media; } catch { /* ignore */ }
    if (prevEp) {
      addHmpControl(art, { name: 'hmp-prev', position: 'right', index: 13, html: '◂ 上一集', tooltip: '播放上一集', click: () => {
        saveProgress(m.id, video);
        location.replace('#/play/' + prevEp.id);
      } });
    }
  }

  /* 选集面板：同一个播放器里鼠标点选换集（不同人接着看可随时重选） */
  if (isSeries && m.series_key) {
    const openEpPanel = async () => {
      const old = document.getElementById('ep-panel');
      if (old) { old.remove(); return; }
      const panel = document.createElement('div');
      panel.id = 'ep-panel';
      panel.innerHTML = '<div class="ep-panel-title">选集</div><div class="ep-panel-body">加载中…</div>';
      const host = document.querySelector('.player-page');
      if (host) host.appendChild(panel);
      try {
        const det = await api('/api/series/' + encodeURIComponent(m.series_key));
        /* 同集多版本聚合：库里同 S/E 可能有多份文件（REMUX/4K/1080p 并存，如和平使者 S01 1080p REMUX + S01/1080p），
           文件名一英一中 → 选集里同集出现两条像「重复」。每集只显示一条（最佳版本），右上角标「N 版」 */
        const verRank = (e) => {
          const fn = (e.file_name || '') + ' ' + (e.dir || '');
          let r = 0;
          if (/2160p|4k[\s.|\-－]|ultra.?hd/i.test(fn)) r += 1000;
          else if (/1080[pi]/i.test(fn)) r += 500;
          else if (/720p/i.test(fn)) r += 200;
          if (/remux/i.test(fn)) r += 300;            // 原盘 remux 优先于普通压制
          if (/web-?dl|webrip|hdtv|hd\.tv/i.test(fn)) r -= 50;
          r += Math.min((e.size || 0) / (1024 * 1024 * 1024), 20); // 大文件微加分
          return r;
        };
        const rows = (det.seasons || []).map(({ season, episodes }) => {
          const byKey = new Map();
          episodes.forEach((e) => {
            const k = (e.episode ?? '?');
            if (!byKey.has(k)) byKey.set(k, []);
            byKey.get(k).push(e);
          });
          return [...byKey.entries()].sort((a, b) => (a[0] === '?' ? 1 : b[0] === '?' ? -1 : a[0] - b[0]))
            .map(([, list]) => {
              const best = list.slice().sort((a, b) => verRank(b) - verRank(a))[0];
              const ver = list.length > 1
                ? `<span style="flex:none;font-size:11px;color:#8fd3a8;background:rgba(52,199,123,.12);border:1px solid rgba(52,199,123,.3);border-radius:6px;padding:1px 6px;margin-left:auto">${list.length} 版</span>` : '';
              return `
          <div class="ep-item${best.id === m.id ? ' cur' : ''}" data-ep="${best.id}">
            <span class="ep-no">S${season ?? 1}E${best.episode ?? '?'}</span>
            <span class="ep-name">${esc(best.title || best.file_name || '')}</span>${ver}
          </div>`;
            }).join('');
        }).join('');
        panel.querySelector('.ep-panel-body').innerHTML = rows || '<div class="empty-hint">没有集</div>';
        panel.querySelectorAll('.ep-item').forEach((el) => {
          el.onclick = () => {
            const epId = el.dataset.ep;
            panel.remove();
            if (!epId || Number(epId) === m.id) return;
            saveProgress(m.id, video);
            pendingSkipIntro = true; // 手动换集：新集无续看进度时自动跳过前情介绍
            location.replace('#/play/' + epId);
          };
        });
      } catch { panel.querySelector('.ep-panel-body').textContent = '加载失败'; }
    };
    addHmpControl(art, { name: 'hmp-ep', position: 'right', index: 15, html: '☰ 选集', tooltip: '选集：在同一次播放里换集', click: openEpPanel });
  }

  /* 外挂字幕：打开自动挂载 + 字幕菜单（切换/关闭/选择文件） */
  let subList = [];
  try { subList = await api(`/api/media/${m.id}/subtitles`) || []; } catch { subList = []; }
  /* 内嵌字幕轨（服务端 ffprobe 探测）：浏览器 textTracks 读不到 MKV 内置轨（如英文/PGS），
     菜单打开时才惰性探测一次，避免拖慢起播；探测完成若菜单仍开着则原位刷新 */
  let embList = [];
  let embNote = '';
  let embFetching = false;
  async function loadEmbTracks() {
    if (embFetching) return;
    embFetching = true;
    if (ccMenu && !ccMenu.classList.contains('hidden') && ccMenuMode === 'track') renderCcTrackMenu();
    try { const d = await api(`/api/media/${m.id}/embedded-subs`); embList = (d && d.tracks) || []; embNote = (d && d.note) || ''; }
    catch { embList = []; embNote = '内嵌字幕探测请求失败'; }
    embFetching = false;
    if (ccMenu && !ccMenu.classList.contains('hidden') && ccMenuMode === 'track') renderCcTrackMenu();
    if (embList.some((t) => t.isText) && ccCtl) ccCtl.classList.remove('dim');
  }
  /* 字幕菜单当前形态：'track'=底部「字幕」按钮（字幕轨选择器：内嵌+外挂+本地文件）
     'full'=右上角高级组（网络/AI/本地文件）。共用同一容器，靠它决定点完动作后重渲染哪种 */
  let ccMenuMode = 'track';
  const ccCtl = document.querySelector('.art-control-hmp-cc');
  const ccMenu = document.getElementById('cc-menu');
  let curSubIdx = -1;
  let subFetching = false;   /* 网络字幕下载进行中（防重入） */
  let subAsrPolling = false; /* （保留兼容）旧整集转写轮询标记；实时字幕走 liveStarted */
  /* 记住上次选择：-1 = 用户关过字幕，-2 = 用户载过本地文件，其余 = 指定候选 idx */
  const subPrefKey = 'hmp-sub-pref-' + m.id;
  let subPref = null;
  try { const raw = localStorage.getItem(subPrefKey); if (raw != null && raw !== '') subPref = parseInt(raw, 10); } catch { /* ignore */ }
  const saveSubPref = (v) => { try { localStorage.setItem(subPrefKey, String(v)); } catch { /* ignore */ } };

  /* keepLive=true 时保留实时字幕段轨（seekRemount 重挂外挂字幕的场景） */
  function clearSubTracks(keepLive) {
    video.querySelectorAll('track').forEach((t) => t.remove());
    for (const tr of video.textTracks) tr.mode = 'disabled';
    try { clearStaleSubtitleDom(); } catch (e) { /* ignore */ } // artp25：连带清掉渲染层残留
    if (!keepLive) { try { liveUnmountAll(); } catch { /* live 块尚未初始化时忽略 */ } }
  }
  /* 外挂轨唯一标记：避免与视频内嵌轨混淆，便于精确开关 */
  const HMP_EXT_LABEL = 'hmp-ext-' + Math.random().toString(36).slice(2);
  let curSubSource = null;   // 'ext' | 'int' | 'emb' | null
  let curSubInt = -1;
  let curSubEmb = -1;        // 服务端提取的内嵌字幕流号（ffprobe stream index）
  let subsVisible = true;    // 「显示字幕」开关：只切换可见性，不清除当前选择
  function activeSubTrack() {
    if (curSubSource === 'ext' || curSubSource === 'emb') {
      return Array.from(video.textTracks).find((t) => t.label === HMP_EXT_LABEL && t.mode !== 'disabled') || null;
    }
    if (curSubSource === 'int' && curSubInt >= 0) return video.textTracks[curSubInt] || null;
    return null;
  }
  function applySubVisibility() {
    try {
      /* HMP 只保留一条激活轨（其余全 disabled），开关只需在 showing/hidden 间切换 */
      for (const tr of video.textTracks) {
        if (tr.mode === 'disabled') continue;
        tr.mode = subsVisible ? 'showing' : 'hidden';
      }
    } catch { /* ignore */ }
  }
  /* ---- ✨ AI 实时字幕（准实时：服务端按播放位置 120s 分段转写，前端轮询挂载并随播放切段） ---- */
  /* artp15：用户手动选过任何字幕轨后，实时字幕段轨必须让位 —— 否则 timeupdate 里
     switchLiveSeg 会把 live 轨反复设成 showing，与用户选的轨叠出「字幕重影」。 */
  let userPickedSub = false;
  function takeSubControl() {
    userPickedSub = true;
    /* artp15：必须连后台会话一起停 —— 否则 pollLive 每 3 秒还会挂新段轨，
       用户选的轨与 AI 转写段同时显示，就是「字幕重影」（英文片更明显：转写结果也是英文）。*/
    try { stopLiveClient(false); } catch (e) { /* live 未启动 */ }
    try { liveUnmountAll(); } catch (e) { /* live 未启动 */ }
  }
  let livePoll = null;
  let liveStarted = false;
  const liveSegs = [];    // { n, from, to, ready }
  const liveTracks = [];  // { n, el }（track 元素）
  const LIVE_PREFIX = 'hmp-live-';
  let liveLastHint = 0;
  function liveFmt(t) {
    t = Math.max(0, Math.floor(t || 0));
    const m = Math.floor(t / 60), s = t % 60;
    return m + ':' + String(s).padStart(2, '0');
  }
  function liveUnmountAll() {
    liveTracks.forEach(({ el }) => { try { el.remove(); } catch { /* ignore */ } });
    liveTracks.length = 0;
  }
  /* ---- 字幕轴实测自愈（artp21，终极方案） --------------------------------
   * 之前一直靠「预测播放模式 + 猜偏移量」，在直连/转码/续播/拖动各种组合下总会漏。
   * 这里换思路：**不问模式，只看事实** ——
   *   浏览器渲染字幕用的是「原生播放头」（转码流里从 0 起，直连流里是绝对时间）；
   *   字幕 VTT 是内容绝对轴。找到离播放头最近的那条 cue，它领先多少秒，
   *   字幕轴就该整体移动多少（服务端 offset 是「减去」，所以 next = cur + delta）。
   * 直连流时 delta≈0 → 不动；转码流时 delta≈start → 自动补上正确的 offset。
   * 与播放模式判断、时序、src 属性都无关，因此不会再漏。 */
  function relPlayhead() {
    try {
      const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      return d && d.get ? Number(d.get.call(video)) || 0 : Number(video.currentTime) || 0;
    } catch (e) { return Number(video.currentTime) || 0; }
  }
  function alignSubTrack(t, src) {
    try {
      const tr = t.track;
      const cues = tr && tr.cues;
      if (!cues || !cues.length) return false;
      const at = relPlayhead();
      if (at < 3) return false;
      const s = String(src || '');
      const isBlob = /^blob:/i.test(s);
      /* artp23 修正判据：之前拿「cue.startTime − 相对播放头」当偏差，
         但绝对轴字幕 + 转码流时这两者天然都落在同一处（delta≈0 → 判定"已对齐"），
         于是永远不校正 —— 这正是本地 blob 字幕「从头显示」的根因。
         正确基准是**流起点**：字幕是内容绝对轴，而浏览器用相对播放头匹配，
         所以字幕轴必须整体减去 start（=转码/续播的起点秒数）。 */
      const sm = (video.currentSrc || video.src || '').match(/[?&]start=(\d+(?:\.\d+)?)/);
      const startOff = sm ? Math.round(Number(sm[1])) : Math.round(Number(video._hmpStart || 0));
      if (startOff > 3) {
        /* artp25 幂等：blob URL 里没有 offset 参数，从 URL 解析永远是 0，
           旧逻辑每次检查都判定「需要校正」→ 无限重建字幕 → ArtPlayer 字幕层残留旧文本
           （表现为字幕卡死 + 新字幕叠在上面）。改用元素上记录的「已应用偏移」判断。 */
        const applied = Number(t.dataset.appliedOffset || 0);
        /* artp25：叠加全局微调（正=字幕延后）。用户觉得字幕滞后于声音就填负值。 */
        const gs = Number(window.__hmpSubGlobalShift || 0);
        const want = startOff - gs;
        if (Math.abs(applied - want) < 4) return false;    // 已对齐
        if (isBlob) {
          const raw = window.__hmpLocalVttRaw;
          if (!raw) return false;
          try { URL.revokeObjectURL(s); } catch (e) { /* ignore */ }
          clearStaleSubtitleDom();
          const fixed = URL.createObjectURL(new Blob([shiftVttClient(raw, want)], { type: 'text/vtt' }));
          t.setAttribute('src', fixed);
          activeSubSrc = fixed;
        } else {
          const base = s.replace(/([?&])offset=-?[\d.]+/g, '$1').replace(/([?&])$/, '');
          const fixed = base + (base.includes('?') ? '&' : '?') + 'offset=' + want;
          clearStaleSubtitleDom();
          t.setAttribute('src', fixed);
          activeSubSrc = fixed;
        }
        t.dataset.appliedOffset = String(want);
        setTimeout(() => { clearStaleSubtitleDom(); if (t.isConnected) showActiveSubTrack(t); }, 60);
        setTimeout(() => { clearStaleSubtitleDom(); if (t.isConnected) showActiveSubTrack(t); }, 400);
        try { console.info('[HMP] 字幕轴自愈(按流起点): ' + applied + ' → ' + startOff + 's, blob=' + isBlob); } catch (e) { /* ignore */ }
        return true;
      }
      /* 无流起点（直连流）→ 退回 cue 实测判据 */
      let near = null, best = Infinity;
      for (let i = 0; i < cues.length; i++) {
        const c = cues[i];
        if (!c) continue;
        const d = Math.abs(c.startTime - at);
        if (d < best) { best = d; near = c; }
      }
      if (!near) return false;
      const delta = Math.round(near.startTime - at);
      if (Math.abs(delta) < 12) return false;
      if (isBlob) {
        const raw = window.__hmpLocalVttRaw;
        if (!raw) return false;
        try { URL.revokeObjectURL(s); } catch (e) { /* ignore */ }
        const cur = 0;
        const fixed = URL.createObjectURL(new Blob([shiftVttClient(raw, -delta)], { type: 'text/vtt' }));
        t.setAttribute('src', fixed);
        activeSubSrc = fixed;
      } else {
        const cur = Number((s.match(/[?&]offset=(-?[\d.]+)/) || [])[1] || 0);
        const next = Math.max(-3600, Math.min(3600, cur + delta));
        const base = s.replace(/([?&])offset=-?[\d.]+/g, '$1').replace(/([?&])$/, '');
        const fixed = base + (base.includes('?') ? '&' : '?') + 'offset=' + next;
        t.setAttribute('src', fixed);
        activeSubSrc = fixed;
      }
      setTimeout(() => { if (t.isConnected) showActiveSubTrack(t); }, 60);
      setTimeout(() => { if (t.isConnected) showActiveSubTrack(t); }, 400);
      try { console.info('[HMP] 字幕轴自愈(按 cue 实测): delta=' + delta + 's, blob=' + isBlob); } catch (e) { /* ignore */ }
      return true;
    } catch (e) { return false; }
  }
  /* 挂载后自愈：load 事件 + 几次兜底轮询（流式提取的 cues 是陆续到的） */
  function scheduleAlign(t, src) {
    let done = false;
    const tryAlign = () => {
      if (done) return true;
      done = alignSubTrack(t, src);
      return done;
    };
    t.addEventListener('load', tryAlign, { once: true });
    /* 兜底轮询：流式内嵌提取的 cues 会陆续到达（整轨读完可能十几秒） */
    [800, 2500, 6000, 12000, 20000, 30000].forEach((ms) => setTimeout(tryAlign, ms));
  }
  /* 秒 → mm:ss（诊断面板用） */
  function fmtS(t) {
    t = Math.max(0, Number(t) || 0);
    const h = Math.floor(t / 3600), m2 = Math.floor((t % 3600) / 60), s2 = Math.floor(t % 60);
    return (h ? h + ':' + String(m2).padStart(2, '0') : m2) + ':' + String(s2).padStart(2, '0');
  }
  /* artp27：彻底清掉 ArtPlayer 自绘字幕层的残留行。
     ArtPlayer 把每条 cue 渲染成一个 `.art-subtitle-line` div，并用 `art-subtitle-show`
     控制显隐；<track> 重新加载时它不会回收旧节点 → 上一次的台词永久卡在画面上，
     与新 cue 叠成重影。这里直接移除所有行节点（比 innerHTML='' 更彻底）。 */
  function clearStaleSubtitleDom() {
    try {
      const box = document.querySelector('.art-video') || document.querySelector('.art-player');
      if (!box) return;
      box.querySelectorAll('.art-subtitle-line').forEach((el) => el.remove());
      box.querySelectorAll('.art-subtitle, .art-subtitle-layer, [class*="art-subtitle"]').forEach((el) => {
        if (el.closest('.cc-menu')) return;
        if (el.querySelector('.art-subtitle-line')) return; // 已清空行，保留容器
        el.innerHTML = '';
      });
    } catch (e) { /* ignore */ }
  }
  /* artp22：保证「同一时刻只有一条字幕轨在显示」这一不变量。
     可重复调用 —— 字幕自愈重挂 src 后浏览器会把 track.mode 重置为 disabled，
     之前 show() 只在挂载时跑一次（loadedmetadata 还是 once），于是要么不显示、要么残留成两层。 */
  function showActiveSubTrack(prefer) {
    try {
      let tr = (prefer && prefer.track) || null;
      if (!tr) {
        const all = Array.from(video.textTracks);
        tr = all.find((x) => x.label === HMP_EXT_LABEL) || null;
      }
      if (!tr) return;
      for (const x of video.textTracks) { if (x !== tr) x.mode = 'disabled'; }
      tr.mode = subsVisible ? 'showing' : 'hidden';
    } catch (e) { /* ignore */ }
  }
  /* artp22：转码流重挂前，先把「除当前播放器 video 之外的其它媒体」彻底静音并移除。
     拖动进度条时旧转码连接可能仍在出声（表现为两个声音）；这段只清旁路，不动当前 video。 */
  function silenceOtherMedia() {
    try {
      const curVid = (currentArtPlayer && currentArtPlayer.video) || null;
      document.querySelectorAll('video, audio').forEach((v) => {
        if (v === curVid || v === video) return;
        try { if (!v.paused) v.pause(); } catch (e) {}
        try { if (v._hls) { v._hls.destroy(); v._hls = null; } } catch (e) {}
        try { v.removeAttribute('src'); v.src = ''; v.load(); } catch (e) {}
        try { if (v.parentNode) v.parentNode.removeChild(v); } catch (e) {}
      });
    } catch (e) { /* ignore */ }
  }
  function switchLiveSeg() {
    if (userPickedSub) return; // 用户已选定别的字幕 → 实时字幕让位，不参与显示
    if (!liveTracks.length) return;
    const at = playerAbsTime(video);
    const cur = liveSegs.filter((s) => s.ready && at >= s.from && at < s.to).sort((a, b) => b.from - a.from)[0];
    for (const { n, el } of liveTracks) {
      try { const tr = el.track; if (tr) tr.mode = (cur && cur.n === n && subsVisible) ? 'showing' : 'disabled'; } catch { /* ignore */ }
    }
    /* 播放位置还没转到（或已跳过）未完成的段 → 一次性提示，别让用户以为功能坏了 */
    if (!cur && liveSegs.length && Date.now() - liveLastHint > 30000) {
      const last = liveSegs[liveSegs.length - 1];
      const ahead = Math.max(0, Math.round(at - (last.to || 0)));
      liveLastHint = Date.now();
      toast(at > last.to
        ? '实时字幕还没转到这个位置（' + liveFmt(at) + '）—— 进度条附近的位置会先出字'
        : '这一段还在转写中，稍等十几秒就会出现', 3800);
    }
  }
  function mountLiveSeg(s) {
    /* artp28：用户已手动选轨时，实时字幕段不再挂轨（避免与用户所选轨叠成重影）；
       同时遵守单轨不变量——挂实时段前清掉既有字幕轨（原生渲染下双轨必叠字）。 */
    if (userPickedSub) return;
    try { clearStaleSubtitleDom(); } catch (e) { /* ignore */ }
    const t = document.createElement('track');
    t.kind = 'subtitles';
    t.label = LIVE_PREFIX + s.n; // 唯一标记：不进「内嵌轨」菜单，切段时精确控制
    t.srclang = 'zh-CN';
    t.src = liveSegUrl(s.n);
    video.appendChild(t);
    liveTracks.push({ n: s.n, el: t });
    if (ccCtl) ccCtl.classList.remove('dim');
    /* 转码/remux 流的 currentTime 是相对 ?start= 的值，而段 VTT 是绝对轴：
       必须按当前 start 追加 offset，浏览器才能用相对轴匹配到 cue（外挂字幕走 addVttTrack 自动处理，
       live 轨自己拼 URL 所以要显式做）。*/
    t.addEventListener('load', () => {
      try {
        if (t.track) t.track.mode = (subsVisible && !userPickedSub) ? 'showing' : 'disabled';
        /* 兜底：同一时刻只允许一条字幕轨 showing —— 任何漏网路径都不该出现两层字幕 */
        if (t.track && t.track.mode === 'showing') {
          for (const x of video.textTracks) if (x !== t.track && x.mode === 'showing') x.mode = 'disabled';
        }
      } catch (e) { /* ignore */ }
      switchLiveSeg();
    }, { once: true });
  }
  function liveSegUrl(n) {
    let u = `/api/asr/live/${m.id}/seg?n=${n}`;
    const mo = (video.currentSrc || video.src || '').match(/[?&]start=(\d+(?:\.\d+)?)/);
    if (mo && Number(mo[1]) > 0) u += '&offset=' + Math.floor(Number(mo[1]));
    return u;
  }
  /* 转码流重挂（seekRemount/续播）后 start 变了 → 段轨要按新 offset 重挂，否则又错位 */
  function remountLiveSegs() {
    liveTracks.forEach(({ n, el }) => {
      try {
        if (!video.contains(el)) video.appendChild(el); // 被 clearSubTracks 移除过 → 放回 DOM
        const want = liveSegUrl(n);
        if (el.getAttribute('src') !== want) el.setAttribute('src', want);
      } catch { /* ignore */ }
    });
    switchLiveSeg();
  }
  function stopLiveClient(silent) {
    if (livePoll) { clearInterval(livePoll); livePoll = null; }
    if (liveStarted) {
      liveStarted = false;
      if (!silent) api(`/api/asr/live/${m.id}/stop`, { method: 'POST' }).catch(() => {});
    }
  }
  async function pollLive() {
    let d = null;
    try { d = await api(`/api/asr/live/${m.id}/status`); } catch { return; }
    const lbl = document.getElementById('cc-asr-label');
    if (lbl) {
      lbl.textContent = d.running
        ? ('✨ 转写中 ' + liveFmt(d.currentFrom) + '…（已出 ' + (d.segs || []).filter((s) => s.ready).length + ' 段）')
        : '✨ AI 实时字幕';
    }
    for (const s of (d.segs || [])) {
      let known = liveSegs.find((x) => x.n === s.n);
      if (!known) { known = { n: s.n, from: s.from, to: s.to, ready: false }; liveSegs.push(known); }
      /* artp12 修：段先以 ready=false 入表，转写完成后这次轮询才变 ready。
         旧逻辑只在「首次入表」时挂载 → 段永远不挂轨（计数在涨但画面无字幕）。 */
      if (s.ready && !known.ready) { known.ready = true; mountLiveSeg(known); }
    }
    switchLiveSeg();
    if (!d.running && liveStarted) {
      stopLiveClient(true);
      const okN = (d.segs || []).filter((s) => s.ready).length;
      if (okN > 0) toast('AI 实时字幕转写完成（' + okN + ' 段）', 3200);
      else toast('AI 实时字幕已结束：' + (d.error || '没有转写出内容'), 5200);
      const lbl2 = document.getElementById('cc-asr-label');
      if (lbl2) lbl2.textContent = '✨ AI 实时字幕';
    }
  }
  async function startLiveSub() {
    if (!(await adminEnsureUnlocked())) return;
    if (liveStarted) { // 已在转写 → 再次点击 = 停止
      stopLiveClient(false);
      liveUnmountAll();
      rerenderCc();
      toast('AI 实时字幕已停止', 2600);
      return;
    }
    try {
      const r = await api(`/api/asr/live/${m.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: Math.floor(playerAbsTime(video)) }) });
      if (!r.ok) { toast(r.error || '实时字幕启动失败', 5200); return; }
      liveStarted = true;
      liveSegs.length = 0;
      userPickedSub = false; // 实时字幕接管显示权（用户手动选轨会让位，见 takeSubControl）
      /* 实时字幕要独占显示：先摘掉当前已激活的其它字幕轨（外挂/内嵌/续播自动挂载的），
         否则第一条 live 段挂上来就会与它们叠成重影 */
      if (curSubSource) { clearSubTracks(); curSubSource = null; curSubIdx = -1; curSubInt = -1; curSubEmb = -1; }
      rerenderCc();
      toast('AI 实时字幕已启动：正在转写当前位置字幕，首段约需 1 分钟（转写完会自动出现）', 5200);
      if (livePoll) clearInterval(livePoll);
      livePoll = setInterval(pollLive, 3000);
      pollLive();
    } catch (e) { toast('实时字幕启动失败：' + e.message, 5200); }
  }
  window.addEventListener('hashchange', () => { stopLiveClient(false); }, { once: true }); // 离开播放页停会话
  video.addEventListener('timeupdate', switchLiveSeg);
  function getInternalTracks() {
    return Array.from(video.textTracks)
      .map((tr, i) => ({ i, tr }))
      .filter((o) => o.tr.label !== HMP_EXT_LABEL && o.tr.kind === 'subtitles' && !/^hmp-live-/.test(o.tr.label || ''));
  }
  /* activeSubSrc/activeSubLabel 声明在 renderPlayer 顶部（resume 路径早于本块执行，避免 TDZ） */
  function addVttTrack(src, label, quiet) {
    /* artp28 单轨不变量守卫：挂任何新轨之前，先移除页面上**所有**已存在的字幕轨。
       此前有两条互相竞争的挂载路径（续播自动挂载 autoMountSubs 与拖动重挂 seekRemount），
       谁后到谁挂上，两条轨会同时 showing → 浏览器原生渲染把两条都画出来 →
       表现为「旧位置的台词永久卡在画面底部，新的又叠上去」。 */
    try {
      Array.from(video.querySelectorAll('track')).forEach((x) => {
        try { if (x.track) x.track.mode = 'disabled'; } catch (e) { /* ignore */ }
        try { x.remove(); } catch (e) { /* ignore */ }
      });
      for (const tr of video.textTracks) { try { tr.mode = 'disabled'; } catch (e) { /* ignore */ } }
    } catch (e) { /* ignore */ }
    try { clearStaleSubtitleDom(); } catch (e) { /* ignore */ }
    let s = String(src || '');
    /* 转码流当前 src 带 ?start=N（ffmpeg 时间戳从 0 重排）→ 字幕轴加 offset=N 才对得上画面 */
    const mo = (video.src || video.currentSrc || '').match(/[?&]start=(\d+)/);
    /* artp18：转码流起点取「src 解析」或「playerSeek 记下的 _hmpStart」——
       续播/拖动后 src 可能还没更新完，此时只有 _hmpStart 是可靠的。
       两者都没有且不是转码流 → 不加偏移（直连流浏览器直接 seek，绝对轴本来就对）。 */
    const isTransSrc = /\/transcode\//.test(video.currentSrc || video.src || '');
    const startSec = (mo && Number(mo[1]) > 0) ? Number(mo[1])
      : (isTransSrc ? Number(video._hmpStart || 0) : 0);
    if (startSec > 0 && !/[?&]offset=/.test(s) && /^(https?:|\/)/.test(s)) {
      s += (s.includes('?') ? '&' : '?') + 'offset=' + startSec;
    }
    activeSubSrc = s; activeSubLabel = label || '字幕';
    const t = document.createElement('track');
    t.kind = 'subtitles';
    t.label = HMP_EXT_LABEL;   // 唯一标记，便于精确识别外挂轨
    t.srclang = 'zh-CN';
    t.src = s;
    video.appendChild(t);
    const show = () => showActiveSubTrack(t);
    /* 立即设一次 + loadedmetadata 再设一次：重挂 src 时 readyState 归零，
       浏览器重新加载资源时也会把已有 track 的 mode 重置，两次兜底保证显示 */
    if (video.readyState >= 1) show();
    video.addEventListener('loadedmetadata', show, { once: true });
    /* artp18 最后一道保险：转码流挂载后若 cues 全部早于当前播放头（说明 offset 没加上），
       用 playerSeek 记下的 _hmpStart 强制补一次 offset 重挂，根治「续播后字幕从头显示」。 */
    if (/^\/api\//.test(s) && /\/transcode\//.test(video.currentSrc || video.src || '')) {
      t.addEventListener('load', () => { /* artp21：自愈已由 scheduleAlign 统一接管 */ }, { once: true });
    }
    /* artp21：挂载后启动实测自愈（直连/转码通用，不预测模式） */
    scheduleAlign(t, s);
    function ctDescTime() {
      /* 播放头（相对 ?start= 的值）——走原型 getter，绕开 artp8 的绝对时间补丁 */
      try {
        const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
        return d && d.get ? d.get.call(video) : video.currentTime;
      } catch (e) { return video.currentTime; }
    }
    /* 把加载结果明确告诉用户：0 条台词最常见的原因是图形字幕(.sup/.sub)或格式不兼容 */
    if (!quiet) {
      const isEmb = /\/embedded-sub(\?|$)/.test(s);
      const cueN = () => (t.track && t.track.cues ? t.track.cues.length : 0);
      let done = false;
      const report = () => {
        if (done) return;
        done = true;
        const n = cueN();
        toast(n ? `已加载字幕「${label}」（${n} 条台词）`
                : `「${label}」没有解析出台词：可能是图形字幕(.sup/.sub)或格式不兼容`, n ? 2600 : 5200);
      };
      t.addEventListener('load', report);
      t.addEventListener('error', () => { done = true; toast(`字幕加载失败：「${label}」`, 4200); });
      if (isEmb) {
        /* 服务端流式提取内嵌轨：整轨读完要读完整部影片（大片几十秒），
           但 VTT 渐进解析 → 首句字幕几秒内就显示。所以这里绝不能 2.5 秒就判「没有台词」 */
        setTimeout(() => {
          if (done) return;
          if (cueN()) { report(); return; }
          done = true;
          toast(`正在从影片中提取「${label}」…字幕会在提取过程中陆续出现`, 4200);
        }, 12000);
        setTimeout(() => {
          if (done) return;
          done = true;
          const n = cueN();
          toast(n ? `字幕「${label}」已就绪（${n} 条台词）` : `「${label}」仍在提取中，字幕稍后会自行出现`, 3600);
        }, 45000);
      } else {
        setTimeout(report, 2500);
      }
    }
    return t;
  }
  /* 启用视频自带内嵌字幕轨（与外挂互斥，杜绝双层） */
  function enableInternalTrack(i, label) {
    clearSubTracks();                 // 移除外挂轨 + 关掉所有内嵌轨
    const tr = video.textTracks[i];
    if (tr) tr.mode = subsVisible ? 'showing' : 'hidden';  // 仅开这一条内嵌轨（尊重显示开关）
    curSubSource = 'int'; curSubInt = i; activeSubSrc = ''; activeSubLabel = label || '内嵌字幕';
  }
  /* artp21：字幕诊断面板（artp20 版本整块包在 try 里，任一变量抛异常就整行消失，
     且只挂在 track 菜单 → 用户实际打开的可能是 full 菜单，看不到。改为：
     抽成独立函数 + 每段独立容错 + 两个菜单都渲染。 */
  function subDiagHtml() {
    const cells = [];
    const add = (label, fn) => {
      let v = '—';
      try { v = fn(); } catch (e) { v = '读取失败'; }
      cells.push(label + ' ' + v);
    };
    add('模式', () => (/\/transcode\//.test(video.currentSrc || video.src || '') ? '转码流' : '直连流'));
    add('播放头', () => fmtS(relPlayhead()));
    add('流起点', () => {
      const m = (video.currentSrc || video.src || '').match(/[?&]start=(\d+(?:\.\d+)?)/);
      return m ? fmtS(Number(m[1])) : '无';
    });
    add('字幕轴', () => {
      const shown = Array.from(video.textTracks).find((x) => x.mode === 'showing');
      if (!shown) return '无显示轨';
      if (!shown.cues || !shown.cues.length) return (shown.label || '轨') + ' 暂无 cues';
      const f = shown.cues[0], l = shown.cues[shown.cues.length - 1];
      return fmtS(f.startTime) + '~' + fmtS(l.endTime);
    });
    add('偏移', () => {
      const m = String(activeSubSrc || '').match(/[?&]offset=(-?[\d.]+)/);
      return m ? (Number(m[1]) >= 0 ? '+' : '') + m[1] + 's' : '0s';
    });
    add('轨道数', () => {
      const all = Array.from(video.querySelectorAll('track'));
      const on = Array.from(video.textTracks).filter((x) => x.mode === 'showing').length;
      return all.length + '（显示中 ' + on + '）';
    });
    return '<div class="cc-diag">🔧 ' + cells.join('｜')
      + '<br>字幕源：' + (/^blob:/i.test(String(activeSubSrc || '')) ? '本地文件（浏览器内转换，偏移靠生成时平移）' : '服务端（可用 offset 参数）')
      + '<br>请求：' + esc(String(activeSubSrc || '（未加载）').slice(0, 110)) + '</div>';
  }
  function renderCcMenu() {
    const extRows = subList.map((s) =>
      `<button class="cc-item" data-idx="${s.idx}"><span class="cc-name">${esc(s.name)}</span>${(curSubSource === 'ext' && s.idx === curSubIdx) ? '<b class="cc-check">✓</b>' : ''}</button>`
    ).join('');
    const intTracks = getInternalTracks();
    const intRows = intTracks.length
      ? '<div class="cc-sep"></div><div class="cc-group">内嵌字幕（视频自带）</div>' + intTracks.map((o) =>
          `<button class="cc-item" data-int="${o.i}"><span class="cc-name">${esc(o.tr.label || ('内嵌轨 ' + (o.i + 1)))}</span>${(curSubSource === 'int' && o.i === curSubInt) ? '<b class="cc-check">✓</b>' : ''}</button>`
        ).join('')
      : '';
    ccMenu.innerHTML = subDiagHtml() + extRows + intRows
      + '<button class="cc-item" id="cc-web"><span class="cc-name">🌐 网络搜索字幕</span></button>'
      + '<button class="cc-item" id="cc-asr"><span class="cc-name" id="cc-asr-label">✨ AI 实时字幕</span></button>'
      + '<div class="cc-foot">'
      + '<button class="cc-item" id="cc-local"><span class="cc-name">选择字幕文件…</span></button>'
      + '<button class="cc-item" id="cc-off"><span class="cc-name">关闭字幕</span></button>'
      + '<input type="file" id="cc-file" accept=".srt,.ass,.ssa,.vtt" hidden>'
      + '</div>';
  }
  /* 底部「字幕」按钮专用：影片字幕轨选择器（内嵌 + 服务端提取外挂 + 关闭）。
     不包含 🌐网络/🤖AI/选择文件——那三项在右上角高级工具组，避免与上方按钮重复，
     让底部「字幕」回归「影片内置字幕功能」的本意 */
  /* 语言代码 → 中文名（字幕轨标签要人话；不在表里的原样显示代码） */
  const LANG_CN = {
    zho: '中文', chi: '中文', cmn: '中文', yue: '粤语', han: '中文',
    eng: '英文', jpn: '日文', kor: '韩文', fra: '法文', fre: '法文', deu: '德文', ger: '德文',
    spa: '西班牙文', ita: '意大利文', rus: '俄文', por: '葡萄牙文', tha: '泰文', vie: '越南文',
    ind: '印尼文', tur: '土耳其文', ara: '阿拉伯文', heb: '希伯来文', pol: '波兰文', nld: '荷兰文',
    swe: '瑞典文', nor: '挪威文', dan: '丹麦文', fin: '芬兰文', ces: '捷克文', cze: '捷克文',
    hun: '匈牙利文', ron: '罗马尼亚文', ell: '希腊文', gre: '希腊文', bul: '保加利亚文',
    hrv: '克罗地亚文', slk: '斯洛伐克文', slv: '斯洛文尼亚文', ukr: '乌克兰文', srp: '塞尔维亚文',
    cat: '加泰罗尼亚文', may: '马来文', ice: '冰岛文', lit: '立陶宛文', lav: '拉脱维亚文',
    est: '爱沙尼亚文', glg: '加利西亚文', slk2: '', eus: '巴斯克文',
  };
  /* 轨道显示名：中文名 · 标题（去掉标题里冗余的括号语言名）；「服务端提取」用小徽标另行标注 */
  function embTrackName(t, i) {
    const lang = String(t.lang || '').toLowerCase();
    const cn = LANG_CN[lang] || '';
    const title = String(t.title || '').trim();
    const parts = [];
    if (cn) parts.push(cn);
    if (title && !/^\(?[a-z]{2,3}\)?$/i.test(title)) {
      /* 标题里若已含中文名（如 "Simplified Chinese" 对应 chi）就不重复加 */
      const hasName = parts.some((p) => title.toLowerCase().includes(p));
      if (!hasName) parts.push(title);
    }
    if (!parts.length) parts.push(t.lang ? String(t.lang).toUpperCase() : ('轨道 ' + (i + 1)));
    return parts.join(' · ');
  }
  const isZhTrack = (t) => /^(chi|zho|zh|cmn|han|yue)/i.test(String(t.lang || '')) || /中文|国语|普通话|简体|繁體|繁体|Chinese/i.test(String(t.title || ''));
  let embShowAll = false; /* 中文轨默认展开，其他语言折叠（37 轨片源不炸菜单） */
  /* ---- 字幕时间校准（artp14）：不同压制组的字幕早晚差几秒很常见，给手动微调 ---- */
  const subShiftStore = (() => {
    try { return JSON.parse(localStorage.getItem('hmp-sub-shift-' + m.id) || '{}') || {}; } catch (e) { return {}; }
  })();
  const subShift = subShiftStore;
  const saveSubShift = () => { try { localStorage.setItem('hmp-sub-shift-' + m.id, JSON.stringify(subShift)); } catch (e) { /* ignore */ } };
  const activeShiftKey = () => (curSubSource === 'emb' && curSubEmb >= 0) ? 'emb:' + curSubEmb
    : (curSubSource === 'ext' && curSubIdx >= 0 ? 'ext:' + curSubIdx : null);
  function embTrackUrl(n) {
    const sh = Number(subShift['emb:' + n] || 0);
    return `/api/media/${m.id}/embedded-sub?stream=${n}` + (sh ? `&shift=${sh}` : '');
  }
  /* 重新挂载当前激活的外挂/内嵌轨（校准后立即生效） */
  function reloadActiveSub() {
    const key = activeShiftKey();
    if (!key) return;
    const sh = Number(subShift[key] || 0);
    const wasSrc = curSubSource, wasEmb = curSubEmb, wasIdx = curSubIdx;
    clearSubTracks();
    if (wasSrc === 'emb' && wasEmb >= 0) {
      const t = embList.find((x) => x.stream === wasEmb);
      addVttTrack(embTrackUrl(wasEmb), '内嵌 ' + (t ? embTrackName(t, embText.indexOf(t)) : ('轨 ' + (wasEmb + 1))), true);
    } else if (wasSrc === 'ext' && wasIdx >= 0 && subList[wasIdx]) {
      addVttTrack(`/api/media/${m.id}/subtitle?idx=${wasIdx}` + (sh ? `&shift=${sh}` : ''), subList[wasIdx].name, true);
    }
    switchLiveSeg();
    rerenderCc();
  }

  function renderCcTrackMenu() {
    const intTracks = getInternalTracks();
    const embText = embList.filter((t) => t.isText);
    const embPicN = embList.filter((t) => !t.isText).length;
    /* ① 顶部固定操作区：开关字幕 / AI 实时字幕 / 选文件 / 关闭 —— 不必滚到底才找得到 */
    const ops =
      '<div class="cc-ops">'
      + '<button class="cc-item" id="cc-vis"><span class="cc-name">显示字幕</span><b class="cc-toggle' + (subsVisible ? ' on' : '') + '"><i></i></b></button>'
      + '<button class="cc-item" id="cc-asr"><span class="cc-name" id="cc-asr-label">✨ AI 实时字幕</span></button>'
      + '<button class="cc-item" id="cc-local"><span class="cc-name">📂 选择字幕文件…</span></button>'
      + '<button class="cc-item" id="cc-off"><span class="cc-name">关闭字幕</span></button>'
      + '</div>';
    const cur = (a, b) => ((curSubSource === a && b) ? '<b class="cc-check">✓</b>' : '');
    /* ② 轨道区（独立滚动，中文轨置顶） */
    const intRows = intTracks.map((o) =>
      `<button class="cc-item" data-int="${o.i}"><span class="cc-name">${esc(o.tr.label || ('内嵌轨 ' + (o.i + 1)))}</span>${cur('int', o.i === curSubInt)}</button>`
    ).join('');
    const zhEmb = embText.filter(isZhTrack);
    const otherEmb = embText.filter((t) => !isZhTrack(t));
    const embRow = (t) => {
      const i = embText.indexOf(t);
      const nm = embTrackName(t, i);
      return `<button class="cc-item" data-emb="${t.stream}"><span class="cc-name">${esc(nm)}<i class="cc-badge">提取</i></span>${cur('emb', curSubEmb === t.stream)}</button>`;
    };
    const zhRows = zhEmb.map(embRow).join('');
    const shownOther = embShowAll ? otherEmb.map(embRow).join('') : '';
    const moreBtn = otherEmb.length
      ? `<button class="cc-item cc-more" id="cc-more-emb">${embShowAll ? '收起其他语言' : '显示其他 ' + otherEmb.length + ' 种语言'}</button>`
      : '';
    const extRows = subList.map((s) =>
      `<button class="cc-item" data-idx="${s.idx}"><span class="cc-name">${esc(s.name)}</span>${cur('ext', s.idx === curSubIdx)}</button>`
    ).join('');
    const blocks = [];
    blocks.push(subDiagHtml()); // artp21：诊断行（对外挂/内嵌/实时字幕一律显示）
    /* artp17：实时字幕内部状态（排障用）——服务端出几段 / 前端挂了几段 / 当前在播哪段，
       一眼能看出是「服务端没产出」还是「产出但没挂上」还是「挂上了但没匹配到位置」。 */
    if (liveStarted || liveSegs.length) {
      const readyN = liveSegs.filter((s) => s.ready).length;
      const at = playerAbsTime(video);
      const curSeg = liveSegs.filter((s) => s.ready && at >= s.from && at < s.to).pop();
      blocks.push('<div class="cc-diag">实时字幕：服务端 ' + readyN + ' 段 / 已挂载 ' + liveTracks.length + ' 段'
        + (curSeg ? ' / 正在显示第 ' + (curSeg.n + 1) + ' 段' : ' / 当前位置无段（未转写或已跳过）')
        + (userPickedSub ? ' · 已被手动选轨接管' : '') + '</div>');
    }
    /* 时间校准行：只有已选中可校准的轨（内嵌提取 / 外挂）时才出现 */
    const shKey = activeShiftKey();
    if (shKey) {
      const sh = Number(subShift[shKey] || 0);
      blocks.push('<div class="cc-calib"><span class="cc-calib-t">时间校准</span>'
        + '<button class="cc-cal-btn" data-cal="-0.5">−0.5s</button>'
        + '<b class="cc-cal-val">' + (sh >= 0 ? '+' : '') + sh.toFixed(1) + 's</b>'
        + '<button class="cc-cal-btn" data-cal="0.5">+0.5s</button>'
        + (sh ? '<button class="cc-cal-btn" data-cal="reset">重置</button>' : '')
        + '</div>');
    }
    if (intRows || zhRows) blocks.push('<div class="cc-group">内嵌字幕（视频自带）</div>' + intRows + zhRows);
    if (embFetching) blocks.push('<div class="cc-group">内嵌字幕（视频自带）</div><div class="cc-empty">探测内嵌轨中…</div>');
    if (extRows) blocks.push('<div class="cc-group">外挂字幕（同目录）</div>' + extRows);
    if (embPicN) blocks.push('<div class="cc-empty">另有 ' + embPicN + ' 条图形字幕（PGS/VobSub），暂不支持提取</div>');
    if (embNote && !embList.length) blocks.push('<div class="cc-empty">' + esc(embNote) + '</div>');
    if (!blocks.length) {
      blocks.push('<div class="cc-empty">' + (embFetching ? '正在探测内嵌字幕轨…' : '本片暂无可识别的中文字幕') + '</div>');
    }
    ccMenu.innerHTML = ops + '<div class="cc-sep"></div>'
      + '<div class="cc-scroll">' + blocks.join('<div class="cc-sep"></div>') + shownOther + moreBtn + '</div>'
      + '<input type="file" id="cc-file" accept=".srt,.ass,.ssa,.vtt" hidden>';
  }
  /* 按当前菜单形态重渲染（底部字幕按钮=track，右上角高级组=full），
     修掉「在字幕轨菜单里点关闭/选轨，却把网络/AI/选择文件那套完整菜单重新弹出来」的串味 bug */
  function rerenderCc() {
    if (ccMenuMode === 'full') renderCcMenu();
    else renderCcTrackMenu();
  }
  if (ccMenu) {
    if (!subList.length && !getInternalTracks().length && ccCtl) ccCtl.classList.add('dim');
    ccMenu.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = e.target.closest('.cc-item');
      if (!item) return;
      if (item.dataset.idx != null) {
        const idx = parseInt(item.dataset.idx, 10);
        takeSubControl();
        clearSubTracks();
        addVttTrack(`/api/media/${m.id}/subtitle?idx=${idx}`, subList[idx] ? subList[idx].name : '字幕');
        curSubIdx = idx; curSubSource = 'ext';
        saveSubPref(idx);
        rerenderCc();
        ccMenu.classList.add('hidden');
      } else if (item.dataset.int != null) {
        const i = parseInt(item.dataset.int, 10);
        takeSubControl();
        enableInternalTrack(i, video.textTracks[i] ? video.textTracks[i].label : '内嵌字幕');
        saveSubPref(-3);
        rerenderCc();
        ccMenu.classList.add('hidden');
      } else if (item.dataset.emb != null) {
        const sn = parseInt(item.dataset.emb, 10);
        const t = embList.find((x) => x.stream === sn);
        const nm = [t && t.lang ? '[' + t.lang + ']' : '', t && t.title ? t.title : ''].filter(Boolean).join(' ') || ('内嵌轨 ' + (sn + 1));
        takeSubControl();
        clearSubTracks();
        addVttTrack(embTrackUrl(sn), '内嵌 ' + nm);
        curSubIdx = -1; curSubSource = 'emb'; curSubEmb = sn;
        saveSubPref(-4);
        rerenderCc();
        ccMenu.classList.add('hidden');
      } else if (item.dataset.cal != null) {
        const key = activeShiftKey();
        if (!key) return;
        const v = item.dataset.cal;
        if (v === 'reset') delete subShift[key];
        else subShift[key] = Math.max(-30, Math.min(30, (Number(subShift[key] || 0) + parseFloat(v)) * 10) / 10);
        saveSubShift();
        reloadActiveSub();
      } else if (item.id === 'cc-off') {
        takeSubControl();
        clearSubTracks();
        curSubIdx = -1; curSubSource = null; curSubInt = -1;
        saveSubPref(-1);
        rerenderCc();
        ccMenu.classList.add('hidden');
      } else if (item.id === 'cc-more-emb') {
        embShowAll = !embShowAll;
        rerenderCc();
      } else if (item.id === 'cc-vis') {
        subsVisible = !subsVisible;
        applySubVisibility();
        rerenderCc();
      } else if (item.id === 'cc-local') {
        const picker = ccMenu.querySelector('#cc-file');
        if (picker) picker.click();
      } else if (item.id === 'cc-web') {
        if (subFetching) return;
        if (!(await adminEnsureUnlocked())) return;
        subFetching = true;
        const nm = item.querySelector('.cc-name');
        if (nm) nm.textContent = '⏳ 搜索中…';
        try {
          const r = await api('/api/media/' + m.id + '/subtitle/fetch', { method: 'POST' });
          if (r && r.ok) {
            toast('已下载字幕「' + (r.name || '网络字幕') + '」并自动挂载', 3200);
            subList = await api('/api/media/' + m.id + '/subtitles') || [];
            if (ccCtl) ccCtl.classList.remove('dim');
            takeSubControl();
            clearSubTracks();
            const best = subList[0];
            if (best) { curSubIdx = best.idx; curSubSource = 'ext'; saveSubPref(best.idx); addVttTrack('/api/media/' + m.id + '/subtitle?idx=' + best.idx, best.name); }
          } else {
            toast((r && r.error) || '网络字幕搜索失败', 5600);
          }
        } catch (e) { toast('网络字幕搜索失败：' + e.message, 5600); }
        subFetching = false;
        rerenderCc();
        ccMenu.classList.add('hidden');
      } else if (item.id === 'cc-asr') {
        /* ✨ AI 实时字幕：从当前播放位置分段转写（120s/段，首段约 1 分钟出字）。
           再点一次 = 停止。整集离线生成仍可从右上角「🤖 AI字幕」/媒体管理发起。 */
        await startLiveSub();
      }
    });
    ccMenu.addEventListener('change', async (e) => {
      if (e.target.id !== 'cc-file' || !e.target.files || !e.target.files[0]) return;
      const f = e.target.files[0];
      takeSubControl();
      clearSubTracks();
      /* artp23：本地字幕是 blob，加不上 offset 参数 → 生成时就按当前流起点平移时间轴 */
      const sm0 = (video.currentSrc || video.src || '').match(/[?&]start=(\d+(?:\.\d+)?)/);
      const preShift = sm0 ? Math.round(Number(sm0[1])) : Math.round(Number(video._hmpStart || 0));
      const url = await localFileToVttUrl(f, preShift);
      addVttTrack(url, f.name.replace(/\.[^.]+$/, ''));
      curSubIdx = -1; curSubSource = 'ext';
      saveSubPref(-2);
      rerenderCc();
      ccMenu.classList.add('hidden');
    });
    // 点击菜单外收起
    const hideCc = (e) => {
      if (!ccMenu.classList.contains('hidden') && !e.target.closest('.cc-menu') && !e.target.closest('.art-control-hmp-cc')) {
        ccMenu.classList.add('hidden');
      }
    };
    document.addEventListener('click', hideCc);
    window.addEventListener('hashchange', () => document.removeEventListener('click', hideCc), { once: true });
  }

  /* 打开即自动挂载（含视频内嵌字幕）：
     - 有外挂候选且上次没关过 → 挂外挂
     - 无外挂但视频自带内嵌轨 → 自动开第一条内嵌轨
     - 都无 → 提示可联网/AI 生成 */
  function autoMountSubs() {
    if (subList.length && subPref !== -1 && subPref !== -2 && subPref !== -3 && subPref !== -4) {
      const pick = subList.find((s) => s.idx === subPref) || subList[0];
      curSubIdx = pick.idx; curSubSource = 'ext';
      addVttTrack(`/api/media/${m.id}/subtitle?idx=${pick.idx}`, pick.name);
      return;
    }
    if (!subList.length && subPref !== -1 && subPref !== -2 && subPref !== -3 && subPref !== -4) {
      const ints = getInternalTracks();
      if (ints.length) { enableInternalTrack(ints[0].i, ints[0].tr.label); saveSubPref(-3); return; }
    }
    if (!subList.length && !getInternalTracks().length) {
      /* artp10：不再弹「本片没有可用字幕」—— 字幕功能在控制条「字幕」菜单里，
         用户自己会用；每次播放都弹一段文字纯属噪声。AI 实时字幕也从那里一键启动。 */
    }
  }
  /* artp18：续播挂字幕必须等「真正就绪」——转码流重挂后 readyState 会先掉到 0 再回来，
     若在 src 还没带上 ?start= 的窗口里挂载，offset 加不上 → 字幕从头显示。
     这里统一走 loadedmetadata + 一帧延迟，确保 src 已定。 */
  const mountSubsWhenReady = () => { setTimeout(() => { try { autoMountSubs(); } catch (e) { /* ignore */ } }, 0); };
  if (video.readyState >= 1) mountSubsWhenReady();
  else video.addEventListener('loadedmetadata', mountSubsWhenReady, { once: true });
  /* 元数据就绪后刷新菜单（内嵌轨此时才枚举得到）+ 按需取消 dim */
  video.addEventListener('loadedmetadata', () => {
    const ints = getInternalTracks();
    if (ccCtl && (subList.length || ints.length)) ccCtl.classList.remove('dim');
    if (ccMenu && !ccMenu.classList.contains('hidden')) rerenderCc();
  }, { once: true });

  /* 全屏由原生控制条 hmp-fs 处理（对整个播放页容器含顶栏与原生控制条） */


  // 每 5 秒保存进度
  progressTimer = setInterval(() => saveProgress(m.id, video), 5000);
  window.addEventListener('hashchange', cleanupPlayer, { once: true });

  document.getElementById('player-back').onclick = () => {
    history.back();
  };
  // 右上角工具：只留「识别」（字幕相关已全部收进控制条「字幕」菜单）
  const idfBtn = document.getElementById('identify-btn');
  if (idfBtn) idfBtn.onclick = () => openIdentify(m);
  const rmBtn = document.getElementById('rmt-btn');
  if (rmBtn) rmBtn.onclick = () => openRemotePanel();
}
/* 把自定义按钮注入 ArtPlayer 原生控制条（坐在控制条上、进度条上方那一行，不挡进度条）。
   返回该控件 DOM（便于条件显隐），不支持时（兜底裸 video）返回 null，调用方自行降级 */
function addHmpControl(art, c) {
  if (!art || art._fallback || !art.controls || !art.controls.add) return null;
  try {
    art.controls.add({
      name: c.name,
      position: c.position || 'right',
      index: (c.index != null ? c.index : 50),
      html: c.html,
      tooltip: c.tooltip || '',
      click: function () { try { if (c.click) c.click(); } catch (e) {} },
    });
    return document.querySelector('.art-control-' + c.name);
  } catch (e) { return null; }
}
/* 根治旧播放音频残留：扫掉 $app 内所有媒体元素（video/audio），无论是否登记过实例。
   配合 capture 阶段 hashchange 监听，在路由重写 $app.innerHTML 之前先 pause 掉旧媒体，
   杜绝「切走后上一部声音还在播」——分离的视频元素在部分浏览器里会续播到被 GC */
/* artp35 兜底巡检：不管哪条路径漏掉，1.2 秒内一定把「不该响的 video」掐掉。
   原因：浏览器不会自动暂停已从 DOM 摘除的 media 元素，它会一直播到被 GC；
   而清理过去只挂在 hashchange 一条路径上，漏一次就会「上一部还在响」。
   只针对 <video>——音乐/有声书用的是 <audio>，不误伤；data-hmp-keep 的元素跳过。 */
let __hmpSeenVideos = [];
let __hmpOrphanRecords = [];
function sweepOrphanVideos() {
  let list = [];
  try { list = Array.prototype.slice.call(document.querySelectorAll('video')); } catch (e) { list = []; }
  // 上轮见过但已脱离 DOM 的（游离元素照样出声），继续盯着直到它真停
  for (const v of __hmpSeenVideos) { if (list.indexOf(v) < 0) list.push(v); }
  const cur = (currentArtPlayer && currentArtPlayer.video) || null;
  const HOST = '#art-mount, .art-video-player, .player-page, .hp-art';
  const keep = [];
  for (const v of list) {
    if (cur && v === cur) { keep.push(v); continue; }
    /* 静音的一律不碰：卡片悬停预览 / 首页 HERO 预览都是 muted，本来就不出声，
       管了只会把预览弄没（artp19 的教训是"离开页面一律停"，那是显式切页，与巡检不同） */
    try { if (v.muted) continue; } catch (e) {}
    /* currentArtPlayer 为空（非播放页渲染中）时，播放容器里的那个就是正主，别误杀 */
    if (!cur && v.isConnected && v.closest && v.closest(HOST)) { keep.push(v); continue; }
    let playing = false;
    try { playing = !v.paused; } catch (e) {}
    if (playing) {
      try {
        __hmpOrphanRecords.unshift({
          t: Date.now(), why: v.isConnected ? 'multi-player' : 'detached',
          src: String(v.currentSrc || v.src || '').slice(0, 120), ct: v.currentTime,
        });
        if (__hmpOrphanRecords.length > 20) __hmpOrphanRecords.length = 20;
        console.warn('[hmp] 掐掉残留播放：' + (v.isConnected ? '多余播放器' : '游离播放器'),
          String(v.currentSrc || v.src || '').slice(0, 120));
      } catch (e) {}
      try { v.pause(); } catch (e) {}
    }
    try { if (v._hls) { v._hls.destroy(); v._hls = null; } } catch (e) {}
    const hasSrc = !!(v.currentSrc || v.src) || v.srcObject != null;
    if (v.isConnected || playing || hasSrc) keep.push(v);
    else { try { v.removeAttribute('src'); v.load(); } catch (e) {} }
  }
  __hmpSeenVideos = keep.slice(0, 40);
}
setInterval(() => { try { sweepOrphanVideos(); } catch (e) {} }, 1200);
/* 自证入口：控制台敲 __hmpOrphanLog() 可看最近被掐掉的残留播放（含 src 与发生时间） */
window.__hmpOrphanLog = function () { return __hmpOrphanRecords; };
function killAllPlayerMedia() {
  /* artp13：先 pause 再 destroy —— destroy 过程有耗时，先掐音才不会出现「退出了还在响」 */
  try { if (currentArtPlayer) { try { currentArtPlayer.pause(); } catch (e) {} } } catch (e) {}
  try { if (currentArtPlayer) { try { currentArtPlayer.destroy(); } catch (e) {} currentArtPlayer = null; } } catch (e) {}
  /* artp35：画中画窗口是独立于页面的播放容器，页面切走它照样出声，退出时必须一并关掉 */
  try { if (document.pictureInPictureElement) document.exitPictureInPicture(); } catch (e) {}
  const _hmpKillOne = (v) => {
    try { if (v._hls) { v._hls.destroy(); v._hls = null; } } catch (e) {}
    try { v.pause(); } catch (e) {}
    try { v.removeAttribute('src'); } catch (e) {}
    /* artp35：不再赋 v.src = ''——空串等于让 video 去加载当前页面 HTML，属于帮倒忙；
       摘掉 src 属性后 load() 就足够中止下载与解码 */
    try { v.load(); } catch (e) {}
  };
  /* artp19 修「切到播放页后首页 HERO 预览还在预播」：
     artp13 的兜底扫描带了 `if (v.muted) return` 的判据（当时为不误伤卡片预览），
     而首页 HERO / 卡片预览**恰恰都是 muted 的** → 永远漏掉，切页后继续播。
     正确口径：**离开页面时一律停**。被 innerHTML 移除的 media 元素浏览器不会自动暂停，
     会一直播到被 GC，所以这里要无条件 pause，并对非当前播放器的元素彻底清源。 */
  try {
    $app.querySelectorAll('video, audio').forEach((v) => {
      _hmpKillOne(v);
      try { v.remove(); } catch (e) {}
    });
  } catch (e) {}
  try {
    document.querySelectorAll('video, audio').forEach((v) => {
      _hmpKillOne(v);
      try { if (v.parentNode) v.parentNode.removeChild(v); } catch (e) {}
    });
  } catch (e) {}
  /* 上面两步只能捞到还在 DOM 里的；历史遗留的游离元素交给巡检兜底 */
  try { sweepOrphanVideos(); } catch (e) {}
}
function destroyCurrentPlayer() {
  // 进入新播放页前彻底销毁上一个播放器（含旧 audio），避免叠放串音
  killAllPlayerMedia();
}
/* 捕获阶段监听：比路由器(route, 冒泡阶段)更早触发，在 $app.innerHTML 被重写前先停旧媒体 */
window.addEventListener('hashchange', killAllPlayerMedia, true);
/* artp13：点「返回」若是 history.back() 退到站外/上一页，hashchange 不触发，只有 pagehide；
   浏览器移动端「切后台再回来」也可能保留声音 —— 两种都补上，退出去必须静音。 */
window.addEventListener('pagehide', killAllPlayerMedia);
window.addEventListener('beforeunload', killAllPlayerMedia);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  /* artp19：切后台时播放器与首页/卡片预览一起停（预览虽静音，但后台仍在解码，电视端会串音） */
  try { if (currentArtPlayer) currentArtPlayer.pause(); } catch (e) {}
  try { document.querySelectorAll('video, audio').forEach((v) => { try { if (!v.paused) v.pause(); } catch (e) {} }); } catch (e) {}
});
/* ---------------- 手机遥控器（E3，artp30） ----------------
   播放页建会话 → 手机扫码（或手输 6 位配对码）打开 #/remote?code=XXXXXX 当遥控器。
   通道是两条单向 SSE：手机 --(POST cmd)--> 服务端 --(SSE)--> 播放端；
                      播放端 --(POST state)--> 服务端 --(SSE)--> 手机。
   选 SSE 不选 WebSocket：server.js 是裸 node:http 零依赖，且 EventSource 自带断线重连。 */
let rmtEs = null;        // 播放端（被控）SSE
let rmtPhoneEs = null;   // 手机端（遥控）SSE
let rmtCode = '';
let rmtTimer = null;

function rmtPost(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json()).catch(() => ({}));
}
function rmtVideo() {
  return document.querySelector('#art-mount video') || document.querySelector('video');
}
function rmtFmt(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h > 0 ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(ss).padStart(2, '0');
}

/* 播放端：点「📱 遥控」→ 建会话 + 弹二维码配对卡 */
async function openRemotePanel() {
  if (rmtEs && rmtCode) { toast('已在遥控中，配对码 ' + rmtCode, 3600); return; }
  let d = {};
  try { d = await rmtPost('/api/remote/new', {}); } catch (e) { d = {}; }
  if (!d || !d.ok || !d.code) { toast('创建遥控会话失败：' + String(((d && d.error) || '服务不可用'))); return; }
  const code = String(d.code);
  const url = location.origin + '/#/remote?code=' + encodeURIComponent(code);
  const ov = document.createElement('div');
  ov.className = 'picker-overlay';
  ov.innerHTML = `
    <div class="rmt-pair">
      <div class="rmt-pair-h">📱 手机遥控</div>
      <div class="rmt-qr" id="rmt-qr"></div>
      <div class="rmt-code-big">${esc(code)}</div>
      <div class="rmt-pair-tip">手机与本机连同一个局域网，扫上面的码即可遥控播放；扫不了就在手机浏览器打开下面地址，手输配对码。</div>
      <div class="rmt-url" id="rmt-url">${esc(url)}</div>
      <div class="rmt-pair-btns">
        <button class="rmt-btn" id="rmt-copy">复制地址</button>
        <button class="rmt-btn" id="rmt-stop">停止遥控</button>
        <button class="rmt-btn rmt-main" id="rmt-close">知道了</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const box = ov.querySelector('#rmt-qr');
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 1 });
  } catch (e) { box.innerHTML = '<div class="rmt-qr-fail">二维码生成失败，请手输下方地址</div>'; }
  const close = () => ov.remove();
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  ov.querySelector('#rmt-close').onclick = close;
  ov.querySelector('#rmt-copy').onclick = () => {
    try { navigator.clipboard.writeText(url); toast('已复制遥控地址'); } catch (e) { toast('复制失败，请手动记下地址'); }
  };
  ov.querySelector('#rmt-stop').onclick = () => { remoteTvStop(); close(); toast('已停止遥控'); };
  remoteTvStart(code);
}

function remoteTvStart(code) {
  remoteTvStop();
  rmtCode = String(code || '').toUpperCase();
  if (!rmtCode) return;
  try {
    rmtEs = new EventSource('/api/remote/' + encodeURIComponent(rmtCode) + '/events?role=tv');
  } catch (e) { toast('遥控连接失败：' + String((e && e.message) || e)); rmtCode = ''; return; }
  rmtEs.addEventListener('cmd', (ev) => {
    let d = null;
    try { d = JSON.parse(ev.data || '{}'); } catch (e) { return; }
    remoteApplyCmd(d);
  });
  rmtEs.addEventListener('hello', () => remoteTvReport());
  if (rmtTimer) clearInterval(rmtTimer);
  rmtTimer = setInterval(remoteTvReport, 2000); // 2 秒一报：够跟手，也不至于刷屏
  toast('📱 遥控已开启 · 配对码 ' + rmtCode, 4000);
}

function remoteTvStop() {
  try { if (rmtEs) rmtEs.close(); } catch (e) { /* ignore */ }
  rmtEs = null;
  if (rmtTimer) { clearInterval(rmtTimer); rmtTimer = null; }
  rmtCode = '';
}

function remoteTvReport() {
  if (!rmtCode) return;
  const v = rmtVideo();
  if (!v) return;
  const t = document.querySelector('.player-title');
  rmtPost('/api/remote/' + encodeURIComponent(rmtCode) + '/state', {
    title: String((t && t.textContent) || '').trim().slice(0, 80),
    position: playerAbsTime(v),      // 绝对时间：转码流 currentTime 是相对值，必须换算
    duration: Number(v.duration) || 0,
    playing: !v.paused,
    volume: Math.round((v.volume || 0) * 100),
    muted: !!v.muted,
  });
}

/* 手机指令落到当前播放器上。
   seek 必须走 playerSeek（转码流会重挂 ?start=），直接赋 currentTime 在转码片上是无效的。 */
function remoteApplyCmd(c) {
  const act = String((c && c.action) || '');
  const val = c && c.value;
  if (!act) return;
  if (act === 'back') { try { history.back(); } catch (e) { /* ignore */ } return; }
  const v = rmtVideo();
  if (!v) return;
  const press = (sel) => { const b = document.querySelector(sel); if (b) b.click(); };
  try {
    if (act === 'toggle') { if (v.paused) v.play().catch(() => {}); else v.pause(); }
    else if (act === 'play') v.play().catch(() => {});
    else if (act === 'pause') v.pause();
    else if (act === 'seek') playerSeek(v, Number(val) || 0);
    else if (act === 'seekBy') playerSeek(v, Math.max(0, playerAbsTime(v) + (Number(val) || 0)));
    else if (act === 'volume') { v.muted = false; v.volume = Math.min(1, Math.max(0, (Number(val) || 0) / 100)); }
    else if (act === 'volBy') { v.muted = false; v.volume = Math.min(1, Math.max(0, (v.volume || 0) + (Number(val) || 0) / 100)); }
    else if (act === 'mute') v.muted = !v.muted;
    else if (act === 'prev') press('.art-control-hmp-prev');
    else if (act === 'next') press('.art-control-hmp-next');
    else if (act === 'fullscreen') fsToggle(document.querySelector('.player-page'));
  } catch (e) { /* ignore */ }
  remoteTvReport();
}

function remotePhoneStop() {
  try { if (rmtPhoneEs) rmtPhoneEs.close(); } catch (e) { /* ignore */ }
  rmtPhoneEs = null;
}

/* 手机端遥控页（#/remote?code=XXXXXX） */
function renderRemotePage(code) {
  remoteTvStop();   // 这个页面自己是遥控器，不是被控端
  remotePhoneStop();
  const c = String(code || '').trim().toUpperCase();
  $app.innerHTML = `
    <div class="rmt-wrap">
      <div class="rmt-card">
        <div class="rmt-head"><span class="rmt-h1">📱 遥控器</span><span class="rmt-code">${esc(c || '缺少配对码')}</span></div>
        <div class="rmt-title" id="rmt-title">—</div>
        <div class="rmt-status" id="rmt-status">${c ? '正在连接…' : '地址里没有配对码，请回到播放页重新扫码'}</div>
        <div class="rmt-time"><span id="rmt-pos">0:00</span><span id="rmt-dur">0:00</span></div>
        <input class="rmt-seek" id="rmt-seek" type="range" min="0" max="1000" value="0" step="1" />
        <div class="rmt-grid">
          <button class="rmt-btn" data-act="seekBy" data-val="-10">« 10s</button>
          <button class="rmt-btn rmt-main" data-act="toggle">▶ ❚❚</button>
          <button class="rmt-btn" data-act="seekBy" data-val="10">10s »</button>
          <button class="rmt-btn" data-act="prev">⏮ 上一集</button>
          <button class="rmt-btn" data-act="mute">🔇 静音</button>
          <button class="rmt-btn" data-act="next">下一集 ⏭</button>
          <button class="rmt-btn" data-act="volBy" data-val="-10">音量 −</button>
          <button class="rmt-btn" data-act="fullscreen">⛶ 全屏</button>
          <button class="rmt-btn" data-act="volBy" data-val="10">音量 ＋</button>
        </div>
        <button class="rmt-btn rmt-exit" data-act="back">退出播放</button>
        <div class="rmt-tip">手机与播放器需连同一个局域网。这个页面只是遥控器，本身不播放内容。</div>
      </div>
    </div>`;
  if (!c) return;
  const send = (act, val) => rmtPost('/api/remote/' + encodeURIComponent(c) + '/cmd', { action: act, value: val });
  $app.querySelectorAll('.rmt-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const raw = b.getAttribute('data-val');
      send(b.getAttribute('data-act'), raw == null ? null : Number(raw));
    });
  });
  const $st = document.getElementById('rmt-status');
  const $tt = document.getElementById('rmt-title');
  const $pos = document.getElementById('rmt-pos');
  const $dur = document.getElementById('rmt-dur');
  const $sk = document.getElementById('rmt-seek');
  let dur = 0, dragging = false;
  const paint = (d) => {
    if (!d || typeof d !== 'object') return;
    $tt.textContent = d.title || '—';
    dur = Number(d.duration) || 0;
    $dur.textContent = rmtFmt(dur);
    $pos.textContent = rmtFmt(d.position);
    if (!dragging && dur > 0) $sk.value = String(Math.min(1000, Math.round((Number(d.position) || 0) / dur * 1000)));
    $st.textContent = d.playing ? '▶ 正在播放' : '❚❚ 已暂停';
  };
  $sk.addEventListener('input', () => {
    dragging = true;
    if (dur > 0) $pos.textContent = rmtFmt(dur * (Number($sk.value) || 0) / 1000);
  });
  $sk.addEventListener('change', () => {
    const t = dur > 0 ? Math.floor(dur * (Number($sk.value) || 0) / 1000) : 0;
    dragging = false;
    send('seek', t);
  });
  try {
    rmtPhoneEs = new EventSource('/api/remote/' + encodeURIComponent(c) + '/events?role=phone');
  } catch (e) { $st.textContent = '连接失败，请回播放页重新扫码'; return; }
  rmtPhoneEs.addEventListener('state', (ev) => { try { paint(JSON.parse(ev.data || '{}')); } catch (e) { /* ignore */ } });
  rmtPhoneEs.addEventListener('waiting', () => { $st.textContent = '等待播放器连上…（先在本机播放页点「📱 遥控」）'; });
  rmtPhoneEs.addEventListener('closed', () => { $st.textContent = '播放端已断开，遥控结束'; });
  rmtPhoneEs.onerror = () => { $st.textContent = '连接中断，正在重试…'; };
  window.addEventListener('hashchange', remotePhoneStop, { once: true });
}

/* artp35b：刚退出播放页的静默窗口。
   看完一部回首页，HERO 预播会立刻接着播（还带着声音），听感就是「上一部没停」；
   这里记个时间戳，60 秒内的首页预播一律静音（画面照常），窗口过后自动恢复有声。 */
const HMP_QUIET_AFTER_PLAY_MS = 60000;
function hmpQuietAfterPlay() {
  return (Date.now() - (window.__hmpLeftPlayerAt || 0)) < HMP_QUIET_AFTER_PLAY_MS;
}
function cleanupPlayer() {
  window.__hmpLeftPlayerAt = Date.now(); // 记下离开播放页的时刻，供首页预播静音窗口判断
  remoteTvStop(); // 离开播放页即结束遥控会话（手机端会收到 closed，不会傻等）
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  destroyCurrentPlayer(); // 统一销毁：暂停+移除底层 video，杜绝切歌后旧声音残留
  if (typeof bookStopTts === 'function') bookStopTts(); // 离开书页停掉朗读
}

/* ---------------- 媒体库管理 ---------------- */
/* ---------------- 目录选择器（浏览服务端本机磁盘 / 局域网共享） ---------------- */
async function openDirPicker(onPick, title = '选择目录') {
  if (AdminLock.demo || demoModeOn()) { toast('演示站不开放目录添加与扫描（自装版可用）'); return; }
  let cur = '';
  let sel = ''; // 单击选中的目录（完整路径）；双击才进入下一级
  let elSel = null;
  const overlay = document.createElement('div');
  overlay.className = 'picker-overlay';
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  async function load(p) {
    const body = overlay.querySelector('.picker-body');
    const up = overlay.querySelector('.picker-up');
    body.innerHTML = '<div class="picker-hint">加载中…</div>';
    let d;
    try {
      d = await api('/api/fs/browse?path=' + encodeURIComponent(p || ''));
    } catch (e) {
      body.innerHTML = `<div class="picker-hint" style="color:#ff6b76">${esc(e.message)}</div>`;
      return;
    }
    cur = d.path || '';
    overlay.querySelector('.picker-cur').textContent = d.quick ? '常用位置（可点「跳转」输入任意路径）' : (cur || '此电脑（选择磁盘）');
    up.style.visibility = d.parent == null ? 'hidden' : 'visible';
    up.onclick = () => { sel = ''; elSel = null; load(d.parent); };
    body.innerHTML = d.dirs.length
      ? d.dirs.map((n) => `<div class="picker-item" data-n="${esc(n)}">📁 ${esc(n)}</div>`).join('')
      : '<div class="picker-hint">此目录下没有子目录</div>';
    const go = (name) => {
      // 盘符（C:\）直接作为根；子目录拼接到当前路径
      if (/^[A-Za-z]:\\?$/.test(name)) load(name.endsWith('\\') ? name : name + '\\');
      else load(cur.endsWith('\\') || cur.endsWith('/') ? cur + name : cur + '/' + name);
    };
    const go_ = (el) => {
      const name = el.dataset.n;
      if (/^[A-Za-z]:\\?$/.test(name)) return name.endsWith('\\') ? name : name + '\\';
      return cur.endsWith('\\') || cur.endsWith('/') ? cur + name : cur + '/' + name;
    };
    elSel = null;
    const markSel = () => {
      body.querySelectorAll('.picker-item').forEach((x) => x.classList.toggle('picked', !!sel && x === elSel));
      const ok = overlay.querySelector('.picker-ok');
      if (ok) ok.textContent = sel ? ('选择：' + (sel.split(/[\\/]/).filter(Boolean).pop() || sel)) : '选择当前目录';
    };
    body.querySelectorAll('.picker-item').forEach((el) => {
      el.onclick = () => { sel = go_(el); elSel = el; markSel(); };       // 单击=选中
      el.ondblclick = () => { sel = ''; elSel = null; go(el.dataset.n); }; // 双击=进入
    });
    markSel();
  }

  overlay.innerHTML = `
    <div class="picker">
      <div class="picker-head"><span>${esc(title)}</span><button class="picker-x">✕</button></div>
      <div class="picker-bar"><button class="picker-up">⬆ 上一级</button><span class="picker-cur"></span></div>
      <div class="picker-jump">
        <input type="text" placeholder="输入路径跳转（Windows 可用 \\\\NAS\\\\共享；NAS/Linux 输入 /share/xxx）" />
        <button>跳转</button>
      </div>
      <div class="picker-body"></div>
      <div class="picker-foot">
        <button class="picker-cancel">取消</button>
        <button class="btn-accent picker-ok">选择当前目录</button>
      </div>
    </div>`;
  overlay.querySelector('.picker-x').onclick = close;
  overlay.querySelector('.picker-cancel').onclick = close;
  const jumpGo = () => { const v = overlay.querySelector('.picker-jump input').value.trim(); if (v) { sel = ''; elSel = null; load(v); } };
  overlay.querySelector('.picker-jump button').onclick = jumpGo;
  overlay.querySelector('.picker-jump input').addEventListener('keydown', (e) => { if (e.key === 'Enter') jumpGo(); });
  overlay.querySelector('.picker-ok').onclick = () => {
    const target = sel || cur;
    if (!target) { alert('请先单击选中一个目录（双击可进入下一级）'); return; }
    close();
    onPick(target);
  };
  await load('');
}

/* ---------------- 通用文件选择器（浏览服务端本机磁盘，选任意文件） ---------------- */
async function openFilePicker(onPick, title = '选择文件') {
  let cur = '';
  const overlay = document.createElement('div');
  overlay.className = 'picker-overlay';
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  async function load(p) {
    const body = overlay.querySelector('.picker-body');
    const up = overlay.querySelector('.picker-up');
    body.innerHTML = '<div class="picker-hint">加载中…</div>';
    let d;
    try {
      d = await api('/api/fs/browse?files=1&path=' + encodeURIComponent(p || ''));
    } catch (e) {
      body.innerHTML = `<div class="picker-hint" style="color:#ff6b76">${esc(e.message)}</div>`;
      return;
    }
    cur = d.path || '';
    overlay.querySelector('.picker-cur').textContent = cur || '此电脑（选择磁盘）';
    up.style.visibility = d.parent == null ? 'hidden' : 'visible';
    up.onclick = () => load(d.parent);
    const dirHtml = (d.dirs || []).map((n) => `<div class="picker-item" data-dir="1" data-n="${esc(n)}">📁 ${esc(n)}</div>`).join('');
    const fileHtml = (d.files || []).map((n) => `<div class="picker-item picker-file" data-dir="0" data-n="${esc(n)}">📄 ${esc(n)}</div>`).join('');
    body.innerHTML = (dirHtml + fileHtml) || '<div class="picker-hint">此目录下没有子目录或文件</div>';
    body.querySelectorAll('.picker-item').forEach((el) => {
      el.onclick = () => {
        const name = el.dataset.n;
        const isDir = el.dataset.dir === '1';
        const full = cur.endsWith('\\') || cur.endsWith('/') ? cur + name : cur + '/' + name;
        if (isDir) {
          if (/^[A-Za-z]:\\?$/.test(name)) load(name.endsWith('\\') ? name : name + '\\');
          else load(full);
        } else {
          close();
          onPick(full);
        }
      };
    });
  }

  overlay.innerHTML = `
    <div class="picker">
      <div class="picker-head"><span>${esc(title)}</span><button class="picker-x">✕</button></div>
      <div class="picker-bar"><button class="picker-up">⬆ 上一级</button><span class="picker-cur"></span></div>
      <div class="picker-jump">
        <input type="text" placeholder="输入路径跳转（Windows 可用 \\\\NAS\\\\共享；NAS/Linux 输入 /share/xxx）" />
        <button>跳转</button>
      </div>
      <div class="picker-body"></div>
      <div class="picker-foot">
        <button class="picker-cancel">取消</button>
      </div>
    </div>`;
  overlay.querySelector('.picker-x').onclick = close;
  overlay.querySelector('.picker-cancel').onclick = close;
  const jumpGo = () => { const v = overlay.querySelector('.picker-jump input').value.trim(); if (v) load(v); };
  overlay.querySelector('.picker-jump button').onclick = jumpGo;
  overlay.querySelector('.picker-jump input').addEventListener('keydown', (e) => { if (e.key === 'Enter') jumpGo(); });
  await load('');
}

/* ---------------- 片单文件选择器（浏览服务端本机磁盘，只选 JSON / m3u） ---------------- */
async function openLtvPicker() {
  const st = document.getElementById('ltv-url-status');
  const listBox = document.getElementById('ltv-pick-list');
  let cur = '';
  const overlay = document.createElement('div');
  overlay.className = 'picker-overlay';
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  async function load(p) {
    const body = overlay.querySelector('.picker-body');
    const up = overlay.querySelector('.picker-up');
    body.innerHTML = '<div class="picker-hint">加载中…</div>';
    let d;
    try {
      d = await api('/api/fs/browse?files=1&exts=.json,.m3u,.m3u8,.txt&path=' + encodeURIComponent(p || ''));
    } catch (e) {
      body.innerHTML = `<div class="picker-hint" style="color:#ff6b76">${esc(e.message)}</div>`;
      return;
    }
    cur = d.path || '';
    overlay.querySelector('.picker-cur').textContent = cur || '此电脑（选择磁盘）';
    up.style.visibility = d.parent == null ? 'hidden' : 'visible';
    up.onclick = () => load(d.parent);
    const dirHtml = (d.dirs || []).map((n) => `<div class="picker-item" data-dir="1" data-n="${esc(n)}">📁 ${esc(n)}</div>`).join('');
    const fileHtml = (d.files || []).map((n) => `<div class="picker-item picker-file" data-dir="0" data-n="${esc(n)}">📄 ${esc(n)}</div>`).join('');
    body.innerHTML = (dirHtml + fileHtml) || '<div class="picker-hint">此目录下没有子目录或片单文件</div>';
    body.querySelectorAll('.picker-item').forEach((el) => {
      el.onclick = () => {
        const name = el.dataset.n;
        const isDir = el.dataset.dir === '1';
        const full = cur.endsWith('\\') || cur.endsWith('/') ? cur + name : cur + '/' + name;
        if (isDir) {
          if (/^[A-Za-z]:\\?$/.test(name)) load(name.endsWith('\\') ? name : name + '\\');
          else load(full);
        } else {
          if (st) st.textContent = '已选择：' + full + '，正在保存…';
          if (listBox) listBox.style.display = 'none';
          close();
          const input = document.getElementById('ltv-url');
          if (input) input.value = full;
          const save = document.getElementById('ltv-url-save');
          if (save) save.onclick();
        }
      };
    });
  }

  overlay.innerHTML = `
    <div class="picker">
      <div class="picker-head"><span>选择直播片单文件（.json / .m3u）</span><button class="picker-x">✕</button></div>
      <div class="picker-bar"><button class="picker-up">⬆ 上一级</button><span class="picker-cur"></span></div>
      <div class="picker-jump">
        <input type="text" placeholder="输入路径跳转（Windows 可用 \\\\NAS\\\\共享；NAS/Linux 输入 /share/xxx）" />
        <button>跳转</button>
      </div>
      <div class="picker-body"></div>
      <div class="picker-foot">
        <button class="picker-cancel">取消</button>
      </div>
    </div>`;
  overlay.querySelector('.picker-x').onclick = close;
  overlay.querySelector('.picker-cancel').onclick = close;
  const jumpGo2 = () => { const v = overlay.querySelector('.picker-jump input').value.trim(); if (v) load(v); };
  overlay.querySelector('.picker-jump button').onclick = jumpGo2;
  overlay.querySelector('.picker-jump input').addEventListener('keydown', (e) => { if (e.key === 'Enter') jumpGo2(); });
  await load('');
}

/* ---------------- 网盘目录选择器（WebDAV 云端，可多选） ---------------- */
async function openCloudPicker(initial, onPick) {
  let cur = initial && initial.startsWith('/') ? initial : '/';
  const picked = new Set();
  const overlay = document.createElement('div');
  overlay.className = 'picker-overlay';
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  overlay.innerHTML = `
    <div class="picker">
      <div class="picker-head"><span>选择网盘目录（可多选）</span><button class="picker-x">✕</button></div>
      <div class="picker-bar">
        <button class="picker-up">⬆ 上一级</button>
        <button class="picker-root">根目录</button>
        <span class="picker-cur"></span>
      </div>
      <div class="picker-body"></div>
      <div class="picker-picked"></div>
      <div class="picker-foot">
        <button class="picker-cancel">取消</button>
        <button class="picker-all">全选本层</button>
        <button class="btn-accent picker-ok">添加选中目录</button>
      </div>
    </div>`;

  const $cur = () => overlay.querySelector('.picker-cur');
  const $body = () => overlay.querySelector('.picker-body');

  function parentDir(p) {
    const t = (p || '/').replace(/\/+$/, '');
    if (!t || t === '/') return '/';
    const i = t.lastIndexOf('/');
    return i <= 0 ? '/' : t.slice(0, i);
  }

  function renderPicked() {
    const box = overlay.querySelector('.picker-picked');
    box.innerHTML = picked.size
      ? Array.from(picked).map((p) => `<span class="picker-chip">${esc(p)}<button data-un="${esc(p)}" title="取消选择">×</button></span>`).join('')
      : '<span class="picker-hint" style="padding:0">勾选左侧方框可多选几个目录；点目录名可进入下一级继续勾选</span>';
    box.querySelectorAll('[data-un]').forEach((b) => {
      b.onclick = () => { picked.delete(b.dataset.un); renderPicked(); markRows(); };
    });
    overlay.querySelector('.picker-ok').textContent = picked.size ? `添加选中 ${picked.size} 个目录` : '添加选中目录';
  }
  function markRows() {
    $body().querySelectorAll('.picker-row').forEach((row) => {
      const p = row.dataset.p;
      row.classList.toggle('on', picked.has(p));
      row.querySelector('.picker-check').textContent = picked.has(p) ? '☑' : '☐';
    });
  }

  async function load(p) {
    $body().innerHTML = '<div class="picker-hint">加载中…</div>';
    let d;
    try {
      d = await api('/api/webdav/list?path=' + encodeURIComponent(p || '/'));
      if (d && d.error) throw new Error(d.error);
    } catch (e) {
      $body().innerHTML = `<div class="picker-hint" style="color:#ff6b76">${esc(e.message)}</div>`;
      return;
    }
    cur = d.path || '/';
    $cur().textContent = cur;
    $body().innerHTML = d.dirs && d.dirs.length
      ? d.dirs.map((x) => `
        <div class="picker-row${picked.has(x.path) ? ' on' : ''}" data-p="${esc(x.path)}">
          <button class="picker-check" title="选择 / 取消">${picked.has(x.path) ? '☑' : '☐'}</button>
          <div class="picker-item" data-d="${esc(x.path)}">📁 ${esc(x.name)}</div>
        </div>`).join('')
      : '<div class="picker-hint">此目录下没有子文件夹</div>';
    $body().querySelectorAll('.picker-check').forEach((el) => {
      el.onclick = () => {
        const p = el.closest('.picker-row').dataset.p;
        if (picked.has(p)) picked.delete(p); else picked.add(p);
        markRows();
        renderPicked();
      };
    });
    $body().querySelectorAll('.picker-item').forEach((el) => {
      el.onclick = () => load(el.dataset.d);
    });
    overlay.querySelector('.picker-up').onclick = () => load(parentDir(cur));
  }

  overlay.querySelector('.picker-x').onclick = close;
  overlay.querySelector('.picker-cancel').onclick = close;
  overlay.querySelector('.picker-root').onclick = () => load('/');
  overlay.querySelector('.picker-all').onclick = () => {
    $body().querySelectorAll('.picker-row').forEach((row) => picked.add(row.dataset.p));
    markRows();
    renderPicked();
  };
  overlay.querySelector('.picker-ok').onclick = () => {
    if (!picked.size) { alert('请先勾选至少一个目录'); return; }
    close();
    onPick(Array.from(picked));
  };
  renderPicked();
  await load(cur);
}

/* 网盘目录批量入库（复用单个添加接口，逐个提交，最后统一触发一次扫描） */
async function addWebdavDirs(list) {
  const norm = (p) => String(p || '').trim().replace(/\/+$/, '');
  let existing = new Set();
  try {
    const roots = await api('/api/roots');
    existing = new Set((roots || []).map((r) => norm(r.path)));
  } catch {}
  const added = [], skipped = [], failed = [];
  for (const raw of list) {
    const p = String(raw || '').trim();
    if (!p) continue;
    if (existing.has(norm(p))) { skipped.push(p); continue; }
    try {
      await api('/api/webdav/roots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
      added.push(p);
    } catch (e) {
      failed.push(p + '（' + String(e.message || '') + '）');
    }
  }
  return { added, skipped, failed };
}

/* gn: 网盘桥接（OpenList）引导条 —— 检测本机桥接，给「打开管理页 / 一键填入」 */
async function loadBridgeBanner() {
  const el = document.getElementById('bridge-banner');
  if (!el) return;
  try {
    const b = await api('/api/webdav/bridge');
    if (!b || !b.running) {
      el.classList.add('bridge-off');
      el.innerHTML = '💡 想挂 <b>百度网盘 / 阿里云盘 / 夸克 / 天翼 / 115</b>？这些网盘官方不开放 WebDAV——'
        + '在 NAS 上执行 <code>sh openlist/install-openlist.sh</code> 即可一键开启「网盘桥接」（离线安装，支持 30+ 网盘）。'
        + '装好后刷新本页，这里会出现一键引导。';
      return;
    }
    const base = (location.hostname ? 'http://' + location.hostname : 'http://127.0.0.1') + ':' + b.port;
    /* 管理页根地址（不含 /dav）：优先用后端给的 NAS 局域网 IP —— 用 location.hostname
       在走域名/反代时是域名，而 OpenList 端口是直连的，域名解析不到该端口。 */
    const adminBase = (b.url && /^https?:\/\//.test(b.url)) ? b.url.replace(/\/+$/, '') : base;
    const hasCred = !!(b.user && b.pass);
    el.classList.add('bridge-on');
    el.innerHTML = hasCred
      ? `<div class="bridge-title">✅ 网盘桥接已在运行（OpenList · 端口 ${esc(String(b.port))}）—— 支持百度网盘 / 阿里云盘 / 夸克 / 天翼 / 115 等 30+ 网盘</div>`
        + `<div class="bridge-steps">① 点「打开网盘管理页」登录 → 「添加存储」选你的网盘并授权；② 添加成功后点「⚡ 一键填入」，再「浏览」勾选网盘目录入库。</div>`
        + `<div class="bridge-actions">`
        + `<a class="btn-small" href="${esc(adminBase)}/" target="_blank" rel="noopener">🌐 打开网盘管理页</a>`
        + `<button class="btn-small" id="bridge-creds" type="button" title="管理页登录用的账号密码（安装时随机生成）">🔑 查看账号密码</button>`
        + `<button class="btn-small" id="bridge-fill" type="button">⚡ 一键填入 WebDAV</button></div>`
        + `<div id="bridge-cred-box" class="bridge-creds hidden"></div>`
      : `<div class="bridge-title">✅ 检测到网盘桥接正在运行（OpenList · 端口 ${esc(String(b.port))}，非本安装包所装）</div>`
        + `<div class="bridge-steps">填入它的 WebDAV 地址 <code>${esc(adminBase)}/dav</code> 与对应账号密码即可挂载网盘。</div>`;
    const fill = document.getElementById('bridge-fill');
    if (fill) {
      fill.onclick = () => {
        const u = document.getElementById('webdav-url');
        const wu = document.getElementById('webdav-user');
        const wp = document.getElementById('webdav-pass');
        if (u) u.value = adminBase + '/dav';
        if (wu) wu.value = b.user || 'admin';
        if (wp) wp.value = b.pass || '';
        const st = document.getElementById('webdav-status');
        if (st) st.textContent = '已填入网盘桥接地址，点「连接」保存后即可「浏览」网盘目录。';
        const sv = document.getElementById('webdav-save');
        if (sv) sv.click();
      };
    }
    /* 「查看账号密码」：管理页是独立登录页，密码在安装时随机生成、不再显示，
       用户直接点「打开网盘管理页」会卡在登录框 —— 这里给出来，并支持一键复制。 */
    const cb = document.getElementById('bridge-creds');
    const cbox = document.getElementById('bridge-cred-box');
    if (cb && cbox) {
      cb.onclick = async () => {
        if (!cbox.classList.contains('hidden')) { cbox.classList.add('hidden'); return; }
        cbox.classList.remove('hidden');
        cbox.innerHTML = '<div class="bridge-cred-row">读取中…</div>';
        let c = null;
        try { c = await api('/api/openlist/creds'); } catch { /* 下面统一处理 */ }
        if (!c || !c.ok || !c.own) {
          cbox.innerHTML = '<div class="bridge-cred-row">拿不到账号密码：'
            + (c && c.error ? esc(c.error) : '桥接不在本安装包目录下运行')
            + '。可在 NAS 上执行 <code>sh openlist/openlist-ctl.sh pass</code> 查看。</div>';
          return;
        }
        const u = c.user || 'admin';
        const pw = c.pass || '';
        const addr = c.url || (adminBase + '/');
        cbox.innerHTML =
          '<div class="bridge-cred-row"><span class="bridge-cred-k">管理页</span>'
          + '<a class="bridge-cred-v link" href="' + esc(addr) + '" target="_blank" rel="noopener">' + esc(addr) + '</a>'
          + '<button class="btn-small" type="button" data-copy="' + esc(addr) + '">复制</button></div>'
          + '<div class="bridge-cred-row"><span class="bridge-cred-k">账号</span>'
          + '<code class="bridge-cred-v">' + esc(u) + '</code>'
          + '<button class="btn-small" type="button" data-copy="' + esc(u) + '">复制</button></div>'
          + '<div class="bridge-cred-row"><span class="bridge-cred-k">密码</span>'
          + '<code class="bridge-cred-v" id="bridge-cred-pw" data-pw="' + esc(pw) + '">••••••••••••</code>'
          + '<button class="btn-small" type="button" id="bridge-cred-eye">显示</button>'
          + '<button class="btn-small" type="button" data-copy="' + esc(pw) + '">复制</button></div>'
          + '<div class="bridge-cred-tip">这是安装时随机生成的管理密码，登进去后建议在 OpenList 里自行改一次。'
          + '只用来管网盘挂载，和你的 HMP 管理密码无关。</div>';
        const eye = document.getElementById('bridge-cred-eye');
        const pwEl = document.getElementById('bridge-cred-pw');
        if (eye && pwEl) {
          eye.onclick = () => {
            const showing = eye.textContent === '隐藏';
            pwEl.textContent = showing ? '••••••••••••' : (pwEl.getAttribute('data-pw') || '');
            eye.textContent = showing ? '显示' : '隐藏';
          };
        }
        cbox.querySelectorAll('[data-copy]').forEach((btn) => {
          btn.onclick = async () => {
            const t = btn.getAttribute('data-copy') || '';
            try {
              if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(t);
              else {
                const ta = document.createElement('textarea');
                ta.value = t; document.body.appendChild(ta); ta.select();
                document.execCommand('copy'); ta.remove();
              }
              const old = btn.textContent; btn.textContent = '已复制';
              setTimeout(() => { btn.textContent = old; }, 1200);
            } catch { toast('复制失败，请手动选中复制'); }
          };
        });
      };
    }
  } catch { el.innerHTML = ''; }
}

/* ============================================================
 * go+++：网盘快捷入口
 * ------------------------------------------------------------
 * 设置页「挂载网盘」顶部一排带网盘名的按钮（阿里/百度/115/夸克/
 * 天翼/迅雷/123/移动/联通）。点一下弹授权窗：
 *   form   直接填几项 → 提交
 *   oauth  给授权链接 → 粘 token
 *   cookie 图文引导用户从浏览器复制 Cookie
 *   qrcode 取二维码 → 轮询
 *   guide  通用 WebDAV 变通（联通云盘）
 * 授权成功 → 添加 OpenList 存储 → 自动回填 WebDAV 地址并连接 →
 * 提示用户去勾选要入库的目录。
 * ============================================================ */
const NL_AUTH_TIP = {
  form: '直接填',
  oauth: '授权令牌',
  qrcode: '手机扫码',
  cookie: '需复制 Cookie',
  guide: 'WebDAV 变通',
};

async function loadNetdiskEntry() {
  const box = document.getElementById('nl-drives');
  const mine = document.getElementById('nl-mine');
  if (!box) return;
  let d;
  try { d = await api('/api/openlist/drives'); } catch (e) {
    box.innerHTML = '<span class="alist-status">网盘清单读取失败：' + esc(e.message) + '</span>';
    return;
  }
  const drives = (d && d.drives) || [];
  const storages = (d && d.storages) || [];
  const ready = !!(d && d.running && d.own);

  /* 一排带网盘名的按钮（disabled 条目置灰 + 点击给 toast 说明，不弹授权层） */
  box.innerHTML = drives.map((x) => {
    const on = storages.some((s) => s.mountPath && s.mountPath.indexOf('/' + x.name) === 0);
    const tag = on ? '已挂载' : (x.disabled ? '维护中' : esc(NL_AUTH_TIP[x.auth] || ''));
    return `<button class="nl-drive${on ? ' on' : ''}${x.disabled ? ' off' : ''}" data-nl-drive="${esc(x.id)}" type="button"`
      + ` style="--nl-c:${esc(x.color || '#888')}"`
      + (x.disabled ? ` title="${esc(x.disabledReason || '该网盘一键挂载维护中')}"` : '')
      + `>`
      + `<span class="nl-drive-icon">${x.icon || '☁️'}</span>`
      + `<span class="nl-drive-name">${esc(x.name)}</span>`
      + `<span class="nl-drive-tag">${tag}</span>`
      + `</button>`;
  }).join('');

  /* 已挂载的网盘列表（可停用/删除） */
  mine.innerHTML = storages.length
    ? '<div class="nl-mine-title">已挂载（' + storages.length + '）</div>' + storages.map((s) => `
      <div class="nl-mine-row">
        <span class="nl-mine-path">${esc(s.mountPath)}</span>
        <span class="nl-mine-drv">${esc(s.driver)}</span>
        <span class="nl-mine-act">
          <button class="btn-small" data-nl-toggle="${s.id}" data-nl-on="${s.disabled ? '1' : '0'}">${s.disabled ? '启用' : '停用'}</button>
          <button class="btn-small btn-danger" data-nl-del="${s.id}">删除</button>
        </span>
      </div>`).join('')
    : '';

  if (!ready) {
    box.insertAdjacentHTML('beforeend',
      '<div class="nl-offline">⚠️ 网盘桥接还没在跑 —— 在 NAS 上执行 <code>sh openlist/install-openlist.sh</code> 开启后，'
      + '这一排按钮就能直接用了（离线安装，支持 90+ 网盘）。</div>');
  }

  if (box.__nlBound) return;
  box.__nlBound = true;
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-nl-drive]');
    if (!b) return;
    const drv = drives.find((x) => x.id === b.dataset.nlDrive);
    if (!drv) return;
    if (drv.disabled) {
      toast(drv.disabledReason || '该网盘一键挂载维护中，请走「WebDAV 连接」配置', 4500);
      return;
    }
    openNetdiskAuth(drv, ready);
  });
  if (mine && !mine.__nlBound) {
    mine.__nlBound = true;
    mine.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-nl-toggle]');
      const del = e.target.closest('[data-nl-del]');
      try {
        if (t) {
          await api('/api/openlist/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: Number(t.dataset.nlToggle), on: t.dataset.nlOn === '1' }) });
          toast('已更新'); loadNetdiskEntry();
        } else if (del) {
          if (!confirm('删除这个网盘挂载？网盘里的文件不受影响，只是影视库不再读它。')) return;
          await api('/api/openlist/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: Number(del.dataset.nlDel) }) });
          toast('已删除'); loadNetdiskEntry();
        }
      } catch (err) { toast('操作失败：' + err.message); }
    });
  }
}

/* 授权弹窗 —— 按网盘的授权方式分别渲染 */
function openNetdiskAuth(drv, bridgeReady) {
  const fieldHtml = (f) => {
    const id = 'nl-f-' + f.key;
    let ctl;
    if (f.type === 'select' && f.options) {
      ctl = `<select id="${id}" class="nl-input">${f.options.map(([v, t]) =>
        `<option value="${esc(v)}"${(f.def === v) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
    } else if (f.type === 'password') {
      ctl = `<input id="${id}" class="nl-input" type="password" autocomplete="new-password"
        placeholder="${esc(f.placeholder || '')}" data-nl-f="${esc(f.key)}" />`;
    } else {
      ctl = `<input id="${id}" class="nl-input" type="text"
        placeholder="${esc(f.placeholder || '')}" data-nl-f="${esc(f.key)}" />`;
    }
    return `<label class="nl-field"><span class="nl-label">${esc(f.label)}${f.required ? ' <b>*</b>' : ''}</span>
      ${ctl}${f.help ? `<span class="nl-help">${esc(f.help)}</span>` : ''}</label>`;
  };

  let extra = '';
  if (drv.oauth) {
    extra = `<div class="nl-oauth"><a class="btn-small" href="${esc(drv.oauth.url)}" target="_blank" rel="noopener">🔗 打开授权页</a>
      <span class="nl-help">${esc(drv.oauth.tip || '')}</span></div>`;
  } else if (drv.auth === 'qrcode') {
    extra = `<div class="nl-oauth"><button class="btn-small" id="nl-qr" type="button">📱 获取二维码</button>
      <span class="nl-help">手机 App 扫码后会自动填入令牌；也可以手动粘贴。</span></div>
      <div id="nl-qr-box" class="nl-qr-box"></div>`;
  } else if (drv.auth === 'cookie') {
    extra = `<div class="nl-cookie-tip">
      <b>怎么拿 Cookie：</b>
      <ol><li>浏览器打开并登录该网盘网页版</li>
      <li>按 <code>F12</code> → 切到 <code>Network</code> 标签 → 刷新页面</li>
      <li>点任意一条请求 → <code>Request Headers</code> 里找到 <code>Cookie:</code> 整行，复制冒号后面的全部内容</li>
      <li>粘贴到下面的输入框</li></ol>
      <span class="nl-help">Cookie 等于账号凭据，只保存在你自己的 NAS 上。</span></div>`;
  }

  const mask = muModal(drv.icon + ' 挂载「' + drv.name + '」', `
    <div class="alist-status">${esc(drv.help || '')}</div>
    ${extra}
    <div class="nl-form">${(drv.fields || []).map(fieldHtml).join('')}</div>
    <label class="nl-field"><span class="nl-label">挂载到（影视库里的目录名）</span>
      <input id="nl-mount" class="nl-input" type="text" value="${esc(drv.name)}" /></label>
    <div class="alist-status" id="nl-err"></div>
    <button id="nl-submit" class="btn-accent" style="width:100%;margin-top:10px;padding:10px">挂载这个网盘</button>`);

  const q = (id) => { const el = mask.querySelector('#' + id); return el ? el.value.trim() : ''; };
  const err = (m) => { const el = mask.querySelector('#nl-err'); if (el) el.textContent = m ? '⚠️ ' + m : ''; };
  const submitBtn = mask.querySelector('#nl-submit');
  if (!bridgeReady) { submitBtn.disabled = true; err('网盘桥接未运行，请先在 NAS 上执行 sh openlist/install-openlist.sh'); }

  /* 扫码：取码 → 轮询（接口不可用时退化为手动粘贴，不白屏） */
  const qrBtn = mask.querySelector('#nl-qr');
  if (qrBtn) {
    let timer = null;
    qrBtn.onclick = async () => {
      qrBtn.disabled = true; qrBtn.textContent = '获取中…';
      try {
        const r = await api('/api/openlist/qrcode', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ drive: drv.id }) });
        const data = (r && r.data) || null;
        const src = data && (data.qrcode || data.qr || data.code);
        if (!src) {
          mask.querySelector('#nl-qr-box').innerHTML =
            '<div class="nl-help">这个版本的网盘桥接不支持自动取码，请用手机 App 登录后手动把令牌粘到下面。</div>';
          qrBtn.textContent = '📱 获取二维码'; qrBtn.disabled = false;
          return;
        }
        const img = /^data:|^https?:/.test(src) ? `<img src="${esc(src)}" alt="二维码" />`
          : `<div class="nl-qr-raw">${esc(src)}</div>`;
        mask.querySelector('#nl-qr-box').innerHTML = img + '<div class="nl-help">用手机 App 扫码并确认登录…</div>';
        qrBtn.textContent = '等待确认…';
        const token = data.token || data.qrcode_token || data.ticket || '';
        timer = setInterval(async () => {
          try {
            const p = await api('/api/openlist/qrcode', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ drive: drv.id, token }) });
            const pd = (p && p.data) || {};
            const got = pd.qrcode_token || pd.token || pd.refresh_token || pd.cookie;
            if (pd.status === 'confirmed' || pd.success || got) {
              clearInterval(timer);
              const el = mask.querySelector('#nl-f-qrcode_token');
              if (el && got) el.value = got;
              qrBtn.textContent = '✅ 已扫码'; mask.querySelector('#nl-qr-box').innerHTML = '';
            }
          } catch { /* 继续轮询 */ }
        }, 2500);
      } catch (e) {
        qrBtn.textContent = '📱 获取二维码'; qrBtn.disabled = false;
        err('取二维码失败：' + e.message + '（可手动粘贴令牌）');
      }
    };
    mask.__nlCleanup = () => { if (timer) clearInterval(timer); };
  }

  submitBtn.onclick = async () => {
    const values = {};
    (drv.fields || []).forEach((f) => { values[f.key] = q('nl-f-' + f.key); });
    const missing = (drv.fields || []).find((f) => f.required && !values[f.key]);
    if (missing) return err('请填写「' + missing.label + '」');
    if (mask.__nlCleanup) mask.__nlCleanup();
    submitBtn.disabled = true; submitBtn.textContent = '正在挂载…';
    try {
      const r = await api('/api/openlist/add', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drive: drv.id, values, mountPath: q('nl-mount') || drv.name }) });
      if (!r.ok) {
        submitBtn.disabled = false; submitBtn.textContent = '挂载这个网盘';
        return err(r.error || '挂载失败');
      }
      mask.remove();
      await nlAutoConnect();
      toast('「' + drv.name + '」已挂载到 ' + r.mountPath + ' —— 接着勾选要入库的目录即可');
      const dv = document.getElementById('webdav-dir');
      if (dv) dv.value = r.mountPath;
      loadNetdiskEntry();
    } catch (e) {
      submitBtn.disabled = false; submitBtn.textContent = '挂载这个网盘';
      err(e.message);
    }
  };
}

/* 挂载成功后：把桥接的 WebDAV 地址回填并连接（用户不用自己填地址） */
async function nlAutoConnect() {
  const b = await api('/api/webdav/bridge').catch(() => null);
  if (!b || !b.running || !b.own) return false;
  /* 用后端给的 NAS 局域网 IP。用户可能通过域名/tmdb 反代访问 HMP，
     此时 location.hostname 是域名 —— 而 OpenList 端口是直连的，域名解析不到。 */
  const base = (b.url && /^https?:\/\//.test(b.url))
    ? b.url.replace(/\/+$/, '')
    : (location.hostname ? 'http://' + location.hostname : 'http://127.0.0.1') + ':' + b.port;
  const cfg = await api('/api/webdav/config').catch(() => null);
  if (cfg && cfg.configured && String(cfg.url || '').indexOf(':' + b.port) >= 0) return true;  // 已连上就用
  return await api('/api/webdav/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: base + '/dav', username: b.user || 'admin', password: b.pass || '' }) })
    .then((r) => !!(r && r.ok)).catch(() => false);
}

/* gj：重复文件清理弹层（同名不同格式 / 内容完全相同；删除先进服务端回收站） */
function clEsc(t) { return esc(String(t == null ? '' : t)); }
const CL_KINDS = [ ['', '全部'], ['video', '影视'], ['audio', '音乐'], ['photo', '照片'], ['book', '书籍'] ];
function clGroupCard(g) {
  /* go++：unsafe = 程序无法可靠判定该留哪个（探测失败 / 全部同分）。
   * 这类组**一个都不默认勾选**，并显著提示——宁可漏清，也不能替用户猜着删。
   * sp6：confirm = 「疑似重复但程序不敢断言」（同名不同格式 / B类未能复核）。
   * 同样默认全不勾，但允许用户核对后手动勾选（unsafe 是禁勾）。 */
  const rows = g.members.map((m, i) => {
    const checked = (!m.keep && !g.unsafe && !g.confirm) ? 'checked' : '';
    const disabled = (m.keep || g.unsafe) ? 'disabled' : '';
    const tag = g.unsafe ? '<span style="color:#e06c5f">⚠ 需人工确认</span>'
      : (g.confirm ? '<span style="color:#e8a13d">需人工核对</span>'
      : (m.keep ? '建议保留' : '建议清理'));
    return `
    <label class="cl-row${m.keep ? ' cl-keep' : ''}" style="display:flex;align-items:flex-start;gap:8px;padding:7px 10px;border-radius:8px;${m.keep ? 'background:rgba(64,158,255,.10);' : ''}">
      <input type="checkbox" class="cl-chk" data-path="${clEsc(m.path)}" ${checked} ${disabled} style="margin-top:3px" />
      <span style="flex:1;min-width:0">
        <span style="display:block;font-size:13px;word-break:break-all">${clEsc(m.name)}</span>
        <span style="display:block;font-size:12px;color:var(--text-dim)">${clEsc(m.quality)} · ${fmtSize(m.size)}${m.broken ? ' · ⚠️ 疑似损坏' : ''}</span>
      </span>
      <span style="flex:none;font-size:12px;color:${(m.keep || g.unsafe || g.confirm) ? 'var(--text-dim)' : '#e8a13d'}">${tag}</span>
    </label>`;
  }).join('');
  return `
  <div class="cl-group" data-kind="${g.kind}" style="border:1px solid ${g.unsafe ? 'rgba(224,108,95,.55)' : g.confirm ? 'rgba(232,161,61,.55)' : 'rgba(128,128,128,.22)'};border-radius:10px;padding:10px 12px;margin-bottom:10px">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
      <span style="font-size:12px;padding:2px 8px;border-radius:99px;background:rgba(128,128,128,.18)">${clEsc(g.kindLabel)}</span>
      <span style="font-size:12px;padding:2px 8px;border-radius:99px;background:rgba(128,128,128,.18)">${clEsc(g.typeLabel)}</span>
      ${g.brokenCount ? `<span style="font-size:12px;color:#e06c5f">含 ${g.brokenCount} 个损坏文件</span>` : ''}
      <span style="flex:1"></span>
      <span style="font-size:12px;color:var(--text-dim)">可释放 ${fmtSize(g.saveable)}</span>
    </div>
    <div style="font-size:12px;color:var(--text-dim);word-break:break-all;margin-bottom:6px">${clEsc(g.dir)}</div>
    ${g.unsafe ? '<div style="font-size:12px;color:#e06c5f;margin-bottom:6px">⚠ 无法判断哪一个更好（读不出分辨率/时长，可能 ffprobe 未就绪或文件是空壳）。已全部取消勾选，请你自己核对后再决定。</div>' : ''}
    ${g.confirm ? '<div style="font-size:12px;color:#e8a13d;margin-bottom:6px">⚠ 名字或体积相同 ≠ 内容相同（如实况照片 .mov+.heic、无损+有损双版本）。默认全不勾选，请逐个核对后自己勾。</div>' : ''}
    ${rows}
  </div>`;
}
function clBindCommon(ov, groups) {
  const body = ov.querySelector('#cl-body');
  const CL_PAGE = 200; // gj：大库重复组可能上万个，分页渲染防浏览器卡死
  let clShown = CL_PAGE;
  const draw = (kind, more) => {
    if (!more) clShown = CL_PAGE;
    const list = kind ? groups.filter((g) => g.kind === kind) : groups;
    if (!list.length) { body.innerHTML = '<div class="empty-hint">没有发现重复文件 🎉</div>'; return; }
    const head = list.slice(0, clShown).map(clGroupCard).join('');
    const rest = list.length - clShown;
    body.innerHTML = head + (rest > 0
      ? `<div style="text-align:center;padding:10px"><button class="btn-small" id="cl-more">显示更多（还有 ${rest} 组）</button></div>`
      : '');
    const moreBtn = body.querySelector('#cl-more');
    if (moreBtn) moreBtn.onclick = () => { clShown += CL_PAGE; draw(kind, true); };
  };
  draw('', false);
  ov.querySelectorAll('.cl-tab').forEach((b) => {
    b.onclick = () => {
      ov.querySelectorAll('.cl-tab').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      draw(b.dataset.k, false);
    };
  });
  const updCount = () => {
    const n = ov.querySelectorAll('.cl-chk:checked').length;
    const el = ov.querySelector('#cl-count');
    if (el) el.textContent = `已选 ${n} 个文件`;
  };
  body.addEventListener('change', updCount); updCount();
  ov.querySelector('#cl-run').onclick = async () => {
    const paths = Array.from(body.querySelectorAll('.cl-chk:checked')).map((c) => c.dataset.path);
    if (!paths.length) return toast('先勾选要清理的文件');
    if (!confirm(`确定清理选中的 ${paths.length} 个文件吗？\n文件会先移入回收站（可在「清理回收站」里彻底删除或后悔）。`)) return;
    const runBtn0 = ov.querySelector('#cl-run');
    if (runBtn0) runBtn0.disabled = true;
    const countEl = ov.querySelector('#cl-count');
    /* go++：终止按钮已常驻在弹层里（默认置灰），清理期间才启用——
     * 之前是「点清理时才动态插入」，小库 0.8 秒跑完按钮一闪而过，用户根本看不到。 */
    const stopBtn = ov.querySelector('#cl-stop');
    let stopping = false;
    if (stopBtn) { stopBtn.disabled = false; stopBtn.textContent = '⏹ 终止清理'; }
    const renderProg = (d) => {
      if (!countEl) return;
      countEl.textContent = `清理中 ${d.done}/${d.total} · 已完成 ${d.moved} 个`
        + (d.failed ? ` · 失败 ${d.failed}` : '')
        + ` · 释放 ${fmtSize(d.freed)}`;
    };
    const poll = setInterval(async () => {
      try { renderProg(await api('/api/cleanup/run/status')); } catch { /* ignore */ }
    }, 800);
    if (stopBtn) stopBtn.onclick = async () => {
      if (stopping) return;
      stopping = true;
      stopBtn.disabled = true;
      stopBtn.textContent = '正在终止…';
      if (countEl) countEl.textContent = '正在终止清理，请稍候（已移动的文件会保留在回收站）…';
      try { await api('/api/cleanup/run/abort', { method: 'POST' }); } catch { /* ignore */ }
    };
    try {
      const r = await api('/api/cleanup/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
      clearInterval(poll);
      const pruned = r.pruned && r.pruned.count ? `，删除空文件夹 ${r.pruned.count} 个` : '';
      /* go++：服务端拒绝闸拦下的文件（属「无法可靠判定」组）要如实告诉用户，别让 toast 报「成功」而实际没删 */
      const refused = (r.refused && r.refused.length) ? `，${r.refused.length} 个因无法判断优劣被安全拦下（未删）` : '';
      const tail = r.aborted ? `已终止（处理了 ${r.moved}/${r.total} 个）` : `已清理 ${r.moved} 个文件，释放 ${fmtSize(r.freed)}${pruned}${refused}，正在后台重扫归类`;
      toast(r.aborted ? `清理已终止：${r.moved} 个文件已移入回收站` : `已清理 ${r.moved} 个文件，释放 ${fmtSize(r.freed)}${pruned}${refused}，正在后台重扫归类`);
      if (countEl) countEl.textContent = `完成：${tail}`;
      const donePaths = new Set(paths);
      groups = groups.map((g) => ({ ...g, members: g.members.filter((m) => !donePaths.has(m.path)) }))
        .filter((g) => g.members.length > 1);
      const kind = (ov.querySelector('.cl-tab.on') || {}).dataset ? ov.querySelector('.cl-tab.on').dataset.k : '';
      draw(kind || '', false);
      if (!groups.filter((g) => !kind || g.kind === kind).length) {
        body.innerHTML = '<div class="empty-hint">清理完成，没有更多重复文件 🎉</div>';
      }
    } catch (e) {
      clearInterval(poll);
      toast('清理失败：' + e.message);
      if (countEl) countEl.textContent = '失败：' + e.message;
    } finally {
      clearInterval(poll);
      const btn = ov.querySelector('#cl-run'); if (btn) btn.disabled = false;
      /* go++：终止按钮常驻，结束后复位为置灰（而不是删掉） */
      const sb2 = ov.querySelector('#cl-stop');
      if (sb2) { sb2.disabled = true; sb2.textContent = '⏹ 终止清理'; }
    }
  };
}
async function openCleanupDialog() {
  if (document.getElementById('cleanup-ov')) return;
  const ov = document.createElement('div');
  ov.id = 'cleanup-ov';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
  ov.innerHTML = `<div style="background:var(--panel,#191c22);color:var(--text,#e8eaed);border-radius:14px;max-width:940px;width:100%;max-height:88vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,.5)">
    <div style="padding:14px 18px;border-bottom:1px solid rgba(128,128,128,.2);display:flex;align-items:center;gap:10px">
      <div style="font-size:17px;font-weight:700">🧹 重复文件清理</div>
      <span id="cl-count" style="color:var(--text-dim);font-size:13px"></span>
      <div style="flex:1"></div>
      <button class="btn-small" id="cl-close">✕ 关闭</button>
    </div>
    <div style="padding:10px 18px 0;display:flex;gap:8px;flex-wrap:wrap" id="cl-tabs">
      ${CL_KINDS.map(([k, label], i) => `<button class="btn-small cl-tab${i === 0 ? ' on' : ''}" data-k="${k}">${label}</button>`).join('')}
      <span style="flex:1"></span>
      <button class="btn-small btn-danger" id="cl-stop" disabled title="清理进行中才可用">⏹ 终止清理</button>
      <button class="btn-accent" id="cl-run">🗑 清理勾选项</button>
    </div>
    <div id="cl-body" style="padding:14px 18px;overflow:auto;flex:1">正在扫描重复文件（影视/音乐/照片/书籍），会检查文件完整性与画质；库大时可能要几分钟，请不要关闭本页…</div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#cl-close').onclick = () => ov.remove();
  /* gm：扫描期间动态计时——大库要几分钟，静默等待会让用户以为卡死而反复开关，撞并发锁 */
  const body0 = ov.querySelector('#cl-body');
  const t0 = Date.now();
  const scanTimer = setInterval(() => {
    const el = ov.querySelector('#cl-elapsed');
    if (!el) { clearInterval(scanTimer); return; }
    const sec = Math.round((Date.now() - t0) / 1000);
    el.textContent = sec >= 60 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`;
  }, 1000);
  body0.innerHTML = `<div class="empty-hint">正在扫描重复文件（影视/音乐/照片/书籍），会检查文件完整性与画质；<br>库大时可能要几分钟，已等待 <span id="cl-elapsed" style="color:var(--accent);font-weight:600">0 秒</span>。期间可随时关闭本窗口，扫描不受影响。</div>`;
  let groups;
  try {
    const r = await api('/api/cleanup/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    clearInterval(scanTimer);
    groups = r.groups || [];
    const el = ov.querySelector('#cl-count');
    if (el) el.textContent = `共 ${r.totalGroups} 组重复，可释放约 ${fmtSize(r.saveable)}`;
    /* go++：有「无法可靠判定」的组时，在列表最前面挂一条醒目横幅，防止用户
     * 以为「默认勾上的都能放心删」而一路点下去。 */
    if (r.unsafeGroups) {
      const banner = document.createElement('div');
      banner.style.cssText = 'border:1px solid rgba(224,108,95,.55);background:rgba(224,108,95,.10);color:#e06c5f;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13px;line-height:1.6';
      banner.innerHTML = `⚠️ 有 <b>${r.unsafeGroups}</b> 组文件的画质信息读不出来（可能是 ffprobe 未就绪，或文件本身是空壳/残片）。<br>这些组<b>已全部取消勾选</b>，程序不会替你决定删哪个——请自己核对文件名和大小后再操作。<br>其余组仍按正常规则给出了「建议保留 / 建议清理」。`;
      ov.querySelector('#cl-body').appendChild(banner);
    }
  } catch (e) {
    clearInterval(scanTimer);
    /* gm：并发锁 429 不是故障——上次扫描还在后台跑，给引导文案而不是吓人的「扫描失败」 */
    const busy = /重复扫描(在进行|还在后台)/.test(e.message || '');
    if (busy) {
      body0.innerHTML = '<div class="empty-hint">上一次重复扫描还在后台进行中（大库约需几分钟）。<br>不用一直开着本窗口——过几分钟重新点「一键清理」，扫描结果会直接显示。</div>';
      const c = ov.querySelector('#cl-count');
      if (c) c.textContent = '后台扫描进行中…';
    } else {
      body0.innerHTML = `<div class="empty-hint">扫描失败：${clEsc(e.message)}</div>`;
    }
    return;
  }
  clBindCommon(ov, groups);
}
async function openCleanupTrash() {
  if (document.getElementById('cleanup-ov')) return;
  const ov = document.createElement('div');
  ov.id = 'cleanup-ov';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
  ov.innerHTML = `<div style="background:var(--panel,#191c22);color:var(--text,#e8eaed);border-radius:14px;max-width:680px;width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,.5)">
    <div style="padding:14px 18px;border-bottom:1px solid rgba(128,128,128,.2);display:flex;align-items:center;gap:10px">
      <div style="font-size:17px;font-weight:700">♻️ 清理回收站</div>
      <div style="flex:1"></div>
      <button class="btn-small" id="cl-close">✕ 关闭</button>
    </div>
    <div id="cl-body" style="padding:14px 18px;overflow:auto;flex:1">加载中…</div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#cl-close').onclick = () => ov.remove();
  const body = ov.querySelector('#cl-body');
  const draw = async () => {
    let d;
    try { d = await api('/api/cleanup/trash'); } catch (e) { body.innerHTML = `<div class="empty-hint">读取失败：${clEsc(e.message)}</div>`; return; }
    if (!d.batches || !d.batches.length) { body.innerHTML = '<div class="empty-hint">回收站是空的 🎉</div>'; return; }
    /* 还原：文件搬回原路径（服务端按批次清单执行）。整批 items=null；单个传 [{rel}] */
    const doRestore = async (batch, items) => {
      const r = await api('/api/cleanup/trash/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch, items: items || null }),
      });
      if (r && r.ok === false) { toast('还原失败：' + (r.error || '未知原因')); }
      else if (r && r.failed && r.failed.length) toast(`已还原 ${r.restored} 个，${r.failed.length} 个没还原成：${clEsc((r.failed[0] && r.failed[0].error) || '')}`);
      else toast(`已还原 ${r.restored} 个文件，正在后台重扫归类`);
    };
    body.innerHTML = `<div class="empty-hint" style="margin-bottom:10px">共占用 ${fmtSize(d.total)}。被清理的文件都保存在这里，可一键还原回原来的位置；彻底删除后不可恢复。</div>` +
      d.batches.map((b) => `
      <div style="border:1px solid rgba(128,128,128,.22);border-radius:10px;padding:10px 12px;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="font-size:13px">批次 ${clEsc(b.batch)}</span>
          <span style="font-size:12px;color:var(--text-dim)">${b.count} 个文件 · ${fmtSize(b.size)}</span>
          ${b.restorable ? `<span style="font-size:12px;color:#5ac37f">可还原 ${b.restorable}</span>` : `<span style="font-size:12px;color:var(--text-dim)">无还原记录</span>`}
          <span style="flex:1"></span>
          <button class="btn-small" data-toggle="${clEsc(b.batch)}">查看文件</button>
          <button class="btn-small" data-restore-batch="${clEsc(b.batch)}"${b.restorable ? '' : ' disabled style="opacity:.45;cursor:not-allowed"'}>↩ 还原本批次</button>
          <button class="btn-small btn-danger" data-batch="${clEsc(b.batch)}">彻底删除</button>
        </div>
        <div data-files="${clEsc(b.batch)}" hidden style="margin-top:8px;border-top:1px dashed rgba(128,128,128,.25);padding-top:8px">
          ${b.restorable ? '' : '<div style="font-size:12px;color:var(--text-dim);padding:4px 0">该批次是在「还原」功能上线之前清理的，没记录原路径，无法自动还原；可按下面显示的存放位置手动取回。</div>'}
          ${(b.files || []).map((f) => `
            <div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px">
              <span style="flex:1;min-width:0;word-break:break-all">${clEsc(f.name)}${f.orig ? `<div style="font-size:11px;color:var(--text-dim);word-break:break-all">原位置：${clEsc(f.orig)}</div>` : ''}</span>
              <span style="flex:none;color:var(--text-dim)">${fmtSize(f.size)}</span>
              ${f.restorable ? `<button class="btn-small" data-restore-one="${clEsc(b.batch)}" data-rel="${clEsc(f.rel)}">还原</button>` : ''}
            </div>`).join('')}
          ${b.filesMore ? `<div style="font-size:12px;color:var(--text-dim);padding:4px 0">…还有 ${b.filesMore} 个文件（点「还原本批次」可一次性全部还原）</div>` : ''}
          <div style="font-size:11px;color:var(--text-dim);margin-top:6px;word-break:break-all">存放位置：${clEsc(d.root || '')}/${clEsc(b.batch)}</div>
        </div>
      </div>`).join('') +
      `<div style="text-align:right;margin-top:10px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
        <button class="btn-small" id="cl-restore-all">↩ 全部还原</button>
        <button class="btn-accent" id="cl-purge-all">全部彻底删除</button>
      </div>`;
    body.querySelectorAll('[data-toggle]').forEach((btn) => {
      btn.onclick = () => {
        const box = body.querySelector(`[data-files="${btn.dataset.toggle}"]`);
        if (!box) return;
        box.hidden = !box.hidden;
        btn.textContent = box.hidden ? '查看文件' : '收起';
      };
    });
    body.querySelectorAll('[data-restore-batch]').forEach((btn) => {
      btn.onclick = async () => {
        const bt = btn.dataset.restoreBatch;
        const b = (d.batches || []).find((x) => x.batch === bt);
        if (!confirm(`确定把「批次 ${bt}」的 ${(b && b.restorable) || 0} 个文件还原回原来所在的目录吗？\n\n如果原位置已经有同名文件，那些文件会跳过不覆盖。`)) return;
        btn.disabled = true; const old = btn.textContent; btn.textContent = '还原中…';
        try { await doRestore(bt, null); draw(); } catch (e) { toast('还原失败：' + e.message); btn.disabled = false; btn.textContent = old; }
      };
    });
    body.querySelectorAll('[data-restore-one]').forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true; const old = btn.textContent; btn.textContent = '还原中…';
        try { await doRestore(btn.dataset.restoreOne, [{ rel: btn.dataset.rel }]); draw(); }
        catch (e) { toast('还原失败：' + e.message); btn.disabled = false; btn.textContent = old; }
      };
    });
    body.querySelectorAll('[data-batch]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('彻底删除该批次？不可恢复。')) return;
        try { await api('/api/cleanup/trash/purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch: btn.dataset.batch }) }); toast('已彻底删除'); draw(); } catch (e) { toast('失败：' + e.message); }
      };
    });
    const allR = body.querySelector('#cl-restore-all');
    if (allR) allR.onclick = async () => {
      const can = (d.batches || []).filter((b) => b.restorable);
      if (!can.length) return toast('没有可还原的批次（旧批次没有记录原路径）');
      const n = can.reduce((s, b) => s + (b.restorable || 0), 0);
      if (!confirm(`确定把回收站里 ${can.length} 个批次共 ${n} 个文件全部还原回原位置吗？`)) return;
      allR.disabled = true; const old = allR.textContent; allR.textContent = '还原中…';
      let ok = 0; let bad = 0;
      for (const b of can) {
        try {
          const r = await api('/api/cleanup/trash/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch: b.batch }) });
          if (r && r.restored) ok += r.restored;
          if (r && r.failed && r.failed.length) bad += r.failed.length;
        } catch { bad += 1; }
      }
      toast(`全部还原完成：成功 ${ok} 个${bad ? `，失败 ${bad} 个` : ''}`);
      allR.disabled = false; allR.textContent = old;
      draw();
    };
    const all = body.querySelector('#cl-purge-all');
    if (all) all.onclick = async () => {
      if (!confirm('清空回收站全部内容？不可恢复。')) return;
      try { await api('/api/cleanup/trash/purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast('回收站已清空'); draw(); } catch (e) { toast('失败：' + e.message); }
    };
  };
  draw();
}
const LIB_INPUT_KEEP = {}; // 设置页输入跨渲染/跨页保留（innerHTML 重建与切页都会清掉正在填的输入框）
const LIB_INPUT_IDS = new Set(['webdav-url', 'webdav-dir', 'root-path', 'tmdb-key', 'tmdb-base-url', 'ltv-url']);
if (!window.__libKeepBound) {
  window.__libKeepBound = true;
  document.addEventListener('input', (e) => {
    const id = e.target && e.target.id;
    if (id && LIB_INPUT_IDS.has(id)) LIB_INPUT_KEEP[id] = e.target.value;
  });
}
async function renderLibrary() {
  for (const id of ['webdav-url', 'webdav-dir', 'root-path', 'tmdb-key', 'tmdb-base-url', 'ltv-url']) {
    const el = document.getElementById(id);
    if (el) LIB_INPUT_KEEP[id] = el.value;
  }
  const health = await api('/api/health');
  const roots = await api('/api/roots');
  const scanStatus = await api('/api/scan/status');
  const webdavCfg = await api('/api/webdav/config');
  /* gl：书库/音乐目录管理自书架/音乐页侧栏迁入（业务页不再留管理入口） */
  const bookRoots = await api('/api/books/roots').then((r) => r.roots || []).catch(() => []);
  const musicRoots = await api('/api/music/roots').then((r) => r.roots || []).catch(() => []);
  let settings;
  try { settings = await api('/api/settings'); } catch { settings = { tmdbApiKeyMasked: '', tmdbEnabled: false }; }
  /* artp25：把全局字幕微调挂到 window，供播放页的 alignSubTrack 使用（渲染顺序早于播放页）
     artp26 修：播放模式也必须走 window —— settings 是本函数的局部变量，
     renderPlayer（顶层函数）直接引用会在 'use strict' 下抛 ReferenceError → 整页「加载失败」。 */
  try {
    window.__hmpSubGlobalShift = Number(settings.subGlobalShift) || 0;
    window.__hmpPlayMode = settings.playMode || 'auto';
  } catch (e) { /* ignore */ }
  /* gk：设置页左右分栏——左侧分组按钮、右侧内容区；主页默认只显示「挂载网盘 + 本地目录」，
     其余分组（皮肤/管理密码/重复清理/元数据/儿童模式）点左侧按钮按需切换。
     分组内容 DOM 一次性全渲染（只做显示/隐藏切换），原有的各种 getElementById 事件绑定不受影响；
     TV 遥控器：lib-tab 是 button 天然被 TV_EXTRA_SEL 捕获，隐藏 pane 内控件被 tvVisible 自动排除。 */
  const paneTitle = (t) => `<div class="panel-title">${t}</div>`;
  $app.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div class="page-title">设置</div>
        <span style="color:var(--text-dim);font-size:13px">
          影片 ${health.stats.total} · 电影 ${health.stats.movie} · 剧集 ${health.stats.episode}
          ${health.bins.ready ? '' : ` · ⚠️ 缺少 ${health.bins.missing.join('/')}`}
          · <span title="若功能行为异常，先按 Ctrl+F5 强刷并核对此版本号">构建 ${(window.HMP_BUILD || '?')}</span>
        </span>
      </div>
      <div class="lib-layout">
        <aside class="lib-side" id="lib-side">
          <button class="lib-tab active" data-lib-tab="media" type="button">📂 网盘与本地目录</button>
          <button class="lib-tab" data-lib-tab="livetv" type="button">📡 电视直播</button>
          <button class="lib-tab" data-lib-tab="games" type="button">🎮 游戏（Steam / RomM）</button>
          <button class="lib-tab" data-lib-tab="dl" type="button">⬇️ 下载</button>
          <button class="lib-tab" data-lib-tab="theme" type="button">🎨 皮肤</button>
          <button class="lib-tab" data-lib-tab="lock" type="button">🔒 管理密码</button>
          <button class="lib-tab" data-lib-tab="access" type="button">🛡️ 访问白名单</button>
          <button class="lib-tab" data-lib-tab="cleanup" type="button">🧹 重复文件清理</button>
          <button class="lib-tab" data-lib-tab="asr" type="button">💬 AI 字幕</button>
          <button class="lib-tab" data-lib-tab="perf" type="button">🚀 转码体检</button>
          <button class="lib-tab" data-lib-tab="netdiag" type="button">🩺 网络诊断</button>
          <button class="lib-tab" data-lib-tab="meta" type="button">⚙️ 元数据与在线片源</button>
          <button class="lib-tab" data-lib-tab="kids" type="button">🧸 儿童模式</button>
          <button class="lib-tab" data-lib-tab="feat" type="button">🚫 功能开关</button>
          <button class="lib-tab" data-lib-tab="guide" type="button">📖 使用教程</button>
          <button class="lib-tab" data-lib-tab="ota" type="button">🔄 软件更新</button>
        </aside>
        <div class="lib-content">
          <section class="lib-pane" data-lib-pane="media">
            ${paneTitle('☁️ 挂载网盘（WebDAV：Alist / 阿里云盘 / 坚果云等）')}
            <!-- go+++：网盘快捷入口 —— 一排带网盘名的按钮，点一下就地授权挂载 -->
            <div class="alist-panel nl-panel">
              <div class="nl-head">
                <span class="nl-head-title">一键挂载常见网盘</span>
                <span class="nl-head-sub">点网盘名 → 授权 → 自动挂好，不用再去后台填 Cookie</span>
              </div>
              <div id="nl-drives" class="nl-drives"><span class="alist-status">正在检测网盘桥接…</span></div>
              <div id="nl-mine" class="nl-mine"></div>
            </div>
            <div id="bridge-banner" class="alist-status bridge-banner"><span style="opacity:.6">正在检测网盘桥接…</span></div>
            <div class="alist-panel">
              <div class="add-root">
                <input id="webdav-url" type="text" placeholder="WebDAV 地址，如 http://192.168.1.10:5244/dav" value="${webdavCfg.url || ''}" />
                <input id="webdav-user" type="text" placeholder="用户名" value="" />
                <input id="webdav-pass" type="password" placeholder="密码（游客访问可留空）" />
                <button class="btn-accent" id="webdav-save">${webdavCfg.configured ? '重新连接' : '连接'}</button>
              </div>
              <div id="webdav-status" class="alist-status">${webdavCfg.configured ? '✅ 已连接 ' + esc(webdavCfg.url) : '未连接。填入 WebDAV 地址与账号密码；Alist 用户填 http://主机:5244/dav，账号即 Alist 登录账号。'}</div>
              ${webdavCfg.configured ? `
              <div class="add-root">
                <input id="webdav-dir" type="text" placeholder="网盘内目录，如 /电影、/音乐（视频进影视库，音乐自动进音乐中心；可点右侧「浏览」多选）" />
                <button class="btn-small" id="webdav-browse">🔍 浏览 / 多选</button>
                <button class="btn-accent" id="webdav-add">添加网盘目录</button>
              </div>` : ''}
            </div>
            ${paneTitle('📁 本地目录')}
            <div class="alist-panel">
              <div class="add-root">
                <button class="btn-accent" id="pick-dir-btn">📂 选择目录</button>
                <input id="root-path" type="text" placeholder="或手动输入路径（支持 \\\\NAS\\共享 网络目录）" />
                <button class="btn-small" id="add-root-btn">添加</button>
              </div>
              <div id="root-err" class="root-err hidden"></div>
              <div id="roots-list">
                ${roots.length ? roots.map((r) => `
                  <div class="root-item">
                    <div>
                      <div class="root-path">${esc(r.path)}</div>
                      <div class="root-meta">${esc(r.label || '')}${(r.type === 'webdav' || r.type === 'alist') ? ' · ☁️ 网盘' : ''} · ${r.last_scan_at ? '上次扫描 ' + new Date(r.last_scan_at).toLocaleString() : '从未扫描'}</div>
                    </div>
                    <div class="root-actions">
                      <button class="btn-small" data-rescan="${r.id}">重新扫描</button>
                      <button class="btn-small btn-danger" data-delroot="${r.id}">删除</button>
                    </div>
                  </div>`).join('')
                : '<div class="empty-hint">还没有添加任何影片目录</div>'}
              </div>
              <div class="add-root" style="margin-top:12px">
                <button class="btn-accent" id="full-scan-btn">🔄 一键全系统扫描</button>
                <span class="alist-status" style="margin-left:10px">服务端默认每 6 小时自动巡检新文件；刚往 NAS 拷了新片/新书/新照片可在这里立即手动扫</span>
              </div>
            </div>
            ${paneTitle('📚 书库目录（电子书架）')}
            <div class="alist-status">支持 TXT / EPUB / PDF / FB2 / MOBI / AZW3 / CBZ 漫画 / 有声书音频（m4b·mp3 等），自动识别章节；朗读功能在阅读页开启</div>
            <div class="alist-panel">
              <div class="add-root">
                <button class="btn-accent" id="bk-add">📂 选择书目目录</button>
                <button class="btn-small" id="bk-scan">⟳ 扫描入库</button>
                <button class="btn-small" id="bk-reid">🧹 重新识别（新格式/书名）</button>
              </div>
              <div id="bk-roots-list">
                ${bookRoots.length ? bookRoots.map((r) => `
                  <div class="root-item">
                    <div>
                      <div class="root-path">${esc(r.path)}</div>
                      <div class="root-meta">${esc(r.label || '')} · ${r.books || 0} 本</div>
                    </div>
                    <div class="root-actions"><button class="btn-small btn-danger" data-del-root="${r.id}">删除</button></div>
                  </div>`).join('')
                : '<div class="empty-hint">还没有添加书目目录</div>'}
              </div>
            </div>
            ${paneTitle('🎵 音乐目录（音乐中心）')}
            <div class="alist-panel">
              <div class="add-root">
                <button class="btn-accent" id="mu-add">📂 选择音乐目录</button>
                <button class="btn-small" id="mu-scan">⟳ 扫描入库</button>
              </div>
              <div id="mu-roots-list">
                ${musicRoots.length ? musicRoots.map((r) => `
                  <div class="root-item">
                    <div>
                      <div class="root-path">${esc(r.path)}</div>
                      <div class="root-meta">${esc(r.label || '')} · ${r.tracks || 0} 首</div>
                    </div>
                    <div class="root-actions"><button class="btn-small btn-danger" data-mu-delroot="${r.id}">删除</button></div>
                  </div>`).join('')
                : '<div class="empty-hint">还没有添加音乐目录</div>'}
              </div>
            </div>
            ${scanStatus.running || scanStatus.result ? `
              <div class="root-item" style="margin-top:20px">
                <div>
                  <div class="root-path">最近扫描</div>
                  <div class="root-meta">${scanStatus.running ? '扫描进行中…'
                    : scanStatus.result && scanStatus.result[0]
                      ? `新增 ${scanStatus.result.reduce((a, r) => a + (r.added || 0), 0)} · 封面 ${scanStatus.result.reduce((a, r) => a + (r.posterGenerated || 0), 0)} · 用时 ${(scanStatus.result.reduce((a, r) => a + (r.elapsedMs || 0), 0) / 1000).toFixed(1)}s`
                      : '—'}</div>
                </div>
              </div>` : ''}
          </section>
          <section class="lib-pane hidden" data-lib-pane="games">
            ${paneTitle('🎮 PC 游戏（Steam 库位置）')}
            <div class="alist-panel">
              <div id="st-cfgbox"><div class="alist-status">正在读取 Steam 库配置…</div></div>
              <div class="add-root" style="margin-top:12px">
                <button class="btn-accent" id="st-set-rescan">↻ 重新扫描 Steam 库</button>
                <span class="alist-status" style="margin-left:10px" id="st-set-st">Steam 里新装了游戏后点这里扫一下；海报墙在「游戏 › 🎮 PC 游戏」页看。</span>
              </div>
            </div>
            ${paneTitle('🕹 复古游戏库（RomM）')}
            <div class="alist-panel">
              <div class="add-root">
                <button class="btn-ghost" id="gm-set-meta">🔑 封面数据源</button>
                <button class="btn-ghost" id="gm-set-cred">🔐 免登录账号</button>
                <span class="alist-status" style="margin-left:10px">安装、扫描、游戏商店在「游戏」页操作；这里只放账号与数据源配置</span>
              </div>
              <div id="gm-credbox" style="display:none"></div>
            </div>
          </section>
          <section class="lib-pane hidden" data-lib-pane="theme">
            ${paneTitle('🎨 皮肤')}
            <div class="alist-panel set-theme-row">
              <button class="set-theme-item${themeCurrent() === 'dark' ? ' on' : ''}" data-theme-set="dark" type="button"><span class="sw sw-dark"></span>经典暗黑（默认）</button>
              <button class="set-theme-item${themeCurrent() === 'light' ? ' on' : ''}" data-theme-set="light" type="button"><span class="sw sw-light"></span>白色</button>
              <button class="set-theme-item${themeCurrent() === 'deepblue' ? ' on' : ''}" data-theme-set="deepblue" type="button"><span class="sw sw-deepblue"></span>蓝色</button>
            </div>
          </section>
          <section class="lib-pane hidden" data-lib-pane="lock">
            ${paneTitle('🔒 管理密码（保护本页设置）')}
            <div class="alist-panel" id="lock-panel"><div class="alist-status">加载中…</div></div>
          </section>
          <section class="lib-pane hidden" data-lib-pane="access">
            ${paneTitle('🛡️ 访问白名单（限制谁能打开这个网页）')}
            <div class="alist-status">启用后，<b>只有名单里的 IP</b>能打开本页面，其余一律拒绝（返回 403 提示页）。支持单个 IP（<code>192.168.1.20</code>）、网段（<code>192.168.1.0/24</code>）、IPv6，逗号或换行分隔。<br>
              防自锁：<b>NAS 本机 127.0.0.1 永远放行</b> —— 万一名单写错把自己挡在外面，用 NAS 本机浏览器打开就能改回来。白名单留空 = 不启用限制。</div>
            <div class="alist-panel">
              <label class="feat-row"><span>启用 IP 限制（关掉 = 任何人可访问）</span><input type="checkbox" id="ipw-enable" ${settings.ipWhitelistEnabled ? 'checked' : ''}></label>
              <div class="add-root" style="margin-top:12px">
                <input id="ipw-list" type="text" style="flex:1" placeholder="例如：192.168.1.20, 192.168.1.0/24" value="${esc(String(settings.ipWhitelist || '').replace(/\n/g, ', '))}" />
                <button class="btn-accent" id="ipw-save">保存</button>
              </div>
              <div class="alist-status" id="ipw-st">你当前的访问 IP：<b>${esc(settings.clientIp || '未知')}</b>（若它不在名单里，保存后本机也会被拒）</div>
            </div>
          </section>
          <section class="lib-pane hidden" data-lib-pane="cleanup">
            ${paneTitle('🧹 重复文件清理')}
            <div class="alist-panel">
              <div class="add-root">
                <button class="btn-accent" id="cleanup-open">🧹 一键清理</button>
                <span class="alist-status" style="margin-left:10px">自动找出「同名不同格式」（如同一部片的 .mkv / .mp4）和「内容完全相同」的重复文件，覆盖影视 / 音乐 / 照片 / 书籍。可以先看清单手动挑着删，也可以直接按质量智能清理（自动保留画质最好、文件最完整的那份）；清理后自动重扫归类并删除空文件夹。</span>
              </div>
              <div class="add-root" style="margin-top:10px">
                <button class="btn-small" id="cleanup-trash-btn">♻️ 清理回收站</button>
                <span class="alist-status" style="margin-left:10px">删掉的文件先移到这里，确认没问题再彻底删除，误删可找回。</span>
              </div>
            </div>
          </section>
          <section class="lib-pane hidden" data-lib-pane="asr">
            ${paneTitle('💬 AI 字幕（whisper 本地生成，不上传任何数据）')}
            <div class="alist-panel">
              <div class="add-root">
                <button class="btn-accent" id="asr-scan">🔍 扫描缺字幕影片</button>
                <select id="asr-model" title="tiny：最快最小，中文准确率弱；base：速度与准确度平衡（日常推荐）；small：更准但耗时约 2 倍"></select>
                <label style="display:inline-flex;align-items:center;gap:6px;margin-left:10px;font-size:13px;white-space:nowrap;cursor:pointer"><input type="checkbox" id="asr-auto" checked> 连续模式（跑完自动下一批）</label>
                <button class="btn-accent" id="asr-run" disabled>▶ 开始生成</button>
                <button class="btn-small" id="asr-abort" disabled>⏹ 中止</button>
              </div>
              <div class="alist-status" id="asr-status">加载中…</div>
              <div id="asr-list"></div>
            </div>
          </section>
          <section class="lib-pane hidden" data-lib-pane="perf">
            <div class="alist-panel">
              <div style="font-size:14px;font-weight:600;margin-bottom:6px">🎬 播放与字幕</div>
              <div class="alist-status" style="margin-bottom:10px">
                <b>字幕微调</b>：字幕整体比声音晚 → 填<b>负数</b>（字幕提前）；字幕比声音早 → 填<b>正数</b>。单位秒，可填 0.5。
              </div>
              <div class="add-root" style="margin-bottom:12px">
                <input id="sub-gshift" type="number" step="0.5" min="-10" max="10" value="${Number(settings.subGlobalShift || 0)}" style="width:110px" />
                <span style="color:var(--text-dim);font-size:13px">秒</span>
                <button class="btn-accent" id="sub-gshift-save">保存微调</button>
                <button class="btn-ghost" id="sub-gshift-reset">恢复 0</button>
              </div>
              <div class="alist-status" style="margin-bottom:10px">
                <b>播放模式</b>：默认「自动」按浏览器解码能力决定直连或转码。若你已安装 HEVC 扩展 / 用 Edge，可选「强制直连」获得最流畅体验（解不了会自动回退转码）。
              </div>
              <div class="add-root">
                <select id="play-mode" style="width:180px">
                  <option value="auto"${(settings.playMode || 'auto') === 'auto' ? ' selected' : ''}>自动（推荐）</option>
                  <option value="direct"${settings.playMode === 'direct' ? ' selected' : ''}>强制直连（不解就回退）</option>
                </select>
                <button class="btn-accent" id="play-mode-save">保存</button>
              </div>
            </div>
            ${paneTitle('🚀 转码体检（按本机算力自动分配转码参数，弱机不强转）')}
            <div class="alist-panel">
              <div class="add-root">
                <button class="btn-accent" id="perf-reprobe">🧪 重新体检</button>
                <span class="alist-status" style="margin-left:10px">用 HMP 自带 ffmpeg 跑一次 10 秒基准，按结果分 S/A/B/C/D 五档：强机放开并发与画质，弱机自动降档甚至禁用转码，保证不会把机器拖死。</span>
              </div>
              <div class="alist-status" id="perf-status">加载中…</div>
            </div>
          </section>
          <section class="lib-pane hidden" data-lib-pane="diag">
            ${paneTitle('🩺 网络与系统自诊断（体检 + 一键修复）')}
            <div class="alist-status">逐项检查：运行环境、媒体库、数据盘剩余、局域网地址、字幕源代理、网盘桥接、直播源、游戏库、缓存占用。带「可自动修复」的问题点一次按钮全部修好；需要你动手的会写清步骤。</div>
            <div class="alist-panel">
              <div class="add-root">
                <button class="btn-accent" id="diag-run">🩺 开始体检</button>
                <button class="btn-small hidden" id="diag-fix">🔧 一键修复可修项</button>
                <span id="diag-sum" style="color:var(--text-dim);font-size:13px"></span>
              </div>
              <div id="diag-list"><div class="alist-status">尚未体检。点「开始体检」把当前这台 NAS 的状态全查一遍（不改动任何数据）。</div></div>
            </div>
          </section>
          <section class="lib-pane hidden" data-lib-pane="caps">
            ${paneTitle('📘 能力边界与成本（先把话说清楚）')}
            <style>
              .caps-h{font-size:14.5px;font-weight:700;margin:0 0 8px}
              .caps-note{font-size:12.5px;color:var(--text-dim);line-height:1.7}
              .caps-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
              .caps-tbl th,.caps-tbl td{border:1px solid var(--hi-12);padding:7px 9px;text-align:left;vertical-align:top}
              .caps-tbl th{background:var(--hi-08);font-weight:600;white-space:nowrap}
              .caps-yes{color:#4ade80;font-weight:600;white-space:nowrap}
              .caps-no{color:#f87171;font-weight:600;white-space:nowrap}
              .caps-part{color:#fbbf24;font-weight:600;white-space:nowrap}
              .tco-in{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:10px 0}
              .tco-in label{display:block;font-size:12px;color:var(--text-dim)}
              .tco-in input{width:100%;margin-top:4px}
              .tco-card{border:1px solid var(--hi-12);border-radius:10px;padding:10px 12px;margin-top:8px;font-size:13px}
            </style>

            <div class="alist-panel">
              <div class="caps-h">一、HMP 能做什么、不能做什么（能力边界，先说清楚）</div>
              <div class="caps-note">下面每一行都是软件的真实能力，不夸大。<b>「本机实测」</b>列是这台设备/这个浏览器的实际解码能力（浏览器不允许解码时会走服务器转码）。</div>
              <div id="caps-matrix" style="margin-top:10px"><div class="alist-status">正在读取本机解码能力…</div></div>
            </div>

            <div class="alist-panel">
              <div class="caps-h">二、TCO：NAS 和那台旧电脑，五年到底差多少钱</div>
              <div class="caps-note">只算电费（硬件两台都是已经有的，摊进去没意义）。填你家的电价和实际功耗，看看「全天候待机的 NAS」是否真的比「偶尔开机的旧电脑」省。</div>
              <div class="tco-in">
                <label>电价（元/度）<input id="tco-price" type="number" step="0.01" value="0.56"></label>
                <label>NAS 整机功耗（W，含硬盘）<input id="tco-nas" type="number" value="22"></label>
                <label>旧电脑功耗（W）<input id="tco-pc" type="number" value="90"></label>
                <label>旧电脑每天开机（小时）<input id="tco-h" type="number" step="0.5" value="4"></label>
                <label>年使用天数<input id="tco-days" type="number" value="365"></label>
              </div>
              <button class="btn-accent" id="tco-calc">🧮 计算五年电费</button>
              <div id="tco-out"></div>
            </div>

            <div class="alist-panel">
              <div class="caps-h">三、UPS 与断电保护（NAS 最怕的不是坏盘，是突然断电）</div>
              <div class="caps-note">
                机械硬盘在写入中被断电，最坏的结果不是丢一个文件，而是<b>文件系统损坏 +  RAID 阵列需要长时间重建</b>。三项低成本保护，建议按顺序做：<br>
                ① <b>接一台 UPS</b>（600~1000VA 足够，几十到一百多元），配合 NAS 的「断电后自动重启」选项，停电瞬间还能安全关机；<br>
                ② <b>开启定期快照</b>（群晖/威联通的快照功能是增量写、几乎不占空间），把「误删文件」这个最大风险从备份里解耦出来；<br>
                ③ <b>重要盘冗余</b>：数据盘用 RAID1/RAID5 或至少做一份异地/云端副本 —— 快照不是备份，NAS 坏了快照一起没。
              </div>
              <div class="add-root" style="margin-top:10px">
                <button class="btn-small" id="caps-goto-cleanup">🧹 去清理重复文件（腾空间给快照）</button>
                <button class="btn-small" id="caps-goto-diag">🩺 先做一次体检</button>
              </div>
            </div>

            <div class="alist-panel">
              <div class="caps-h">四、碟片数字化：你把「一柜子光盘」变成了可检索的资产</div>
              <div class="caps-note">
                实体碟的优势是「拿起来就能看」，代价是<b>占地方、不能搜、不能多设备、还会氧化发霉</b>。数字化之后：一部剧刮削完就有海报、简介、评分，进同一个海报墙，手机电视随手点开；<br>
                做的时候建议：<b>保留原碟</b>（做备份与二次校验）→ 码流较高的原盘直接 <code class="gd-path">mkv</code> 保留或转封装（不重编码，画质无损、体积小）→ 只有老编码才转码；<br>
                合规提醒：请只数字化<b>自己拥有合法版权</b>的作品，或已获授权的内容；本机功能与任何片源站无关，HMP 不提供、不索引盗版内容。
              </div>
            </div>

            <div class="alist-panel">
              <div class="caps-h">五、NAS 与旧电脑：诚实的对比</div>
              <div id="caps-cmp" style="margin-top:6px"></div>
            </div>
          </section>
          <section class="lib-pane hidden" data-lib-pane="netdiag">
            ${paneTitle('🩺 网络与运行体检（一次跑完，带修复建议）')}
            <div class="alist-panel">
              <div class="alist-status" style="margin-bottom:10px">
                体检会检查：运行环境与负载、数据盘空间、目录挂载、服务端口、局域网地址、字幕源可达性、直播源、游戏库、时间等。
                <b>发现问题会给「一键修复」按钮</b>（能自动改配置的就自动改，需要你操作的会写清楚步骤）。
              </div>
              <div class="add-root" style="margin-bottom:10px">
                <button class="btn-accent" id="nd-run">🩺 开始体检</button>
                <button class="btn-ghost" id="nd-reload">↻ 刷新结果</button>
              </div>
              <div id="nd-score"></div>
              <div id="nd-list" style="margin-top:10px"><div class="alist-status">还没有跑过体检，点上面「开始体检」。</div></div>
            </div>
          </section>
          <section class="lib-pane hidden" data-lib-pane="meta">
            ${paneTitle('⚙️ 元数据与在线片源')}
            <div class="alist-panel">
              <div class="add-root">
                <input id="tmdb-key" type="password" placeholder="TMDB API Key（themoviedb.org 免费申请，填写后自动刮削海报/简介/评分）" value="" />
                <button class="btn-accent" id="tmdb-save">${settings.tmdbEnabled ? '更新 Key' : '保存 Key'}</button>
              </div>
              <div class="alist-status" id="tmdb-status">${settings.tmdbEnabled ? `✅ 已配置 Key（${esc(settings.tmdbApiKeyMasked)}）` : '未配置。到 themoviedb.org 注册后在设置里拿 API Key（v3），保存后点「立即刮削」即可为影片补上海报、简介、评分。'}</div>
              <div class="add-root" style="margin-top:10px">
                <input id="tmdb-base-url" type="text" placeholder="TMDB 接口地址（国内直连不通时填代理地址，格式 https://你的代理/3，留空用官方默认）" value="${esc(settings.tmdbApiBaseUrl || '')}" />
                <button class="btn-accent" id="tmdb-base-save">保存接口地址</button>
              </div>
              <div class="add-root">
                <button class="btn-small" id="tmdb-scrape">✨ 立即刮削</button>
                <span class="alist-status" id="tmdb-progress" style="margin-left:10px"></span>
              </div>
              <div class="add-root" style="margin-top:14px">
                <select id="reclassify-scope">
                  <option value="all">全部内容（影视/音乐/照片/书）</option>
                  <option value="video">仅影视</option>
                  <option value="music">仅音乐</option>
                  <option value="photos">仅照片墙</option>
                  <option value="ebooks">仅电子书</option>
                </select>
                <button class="btn-small" id="reclassify">🔁 重新识别分类</button>
                <span class="alist-status" id="reclassify-status" style="margin-left:10px">影视修电影/剧集错乱；音乐重读标签修歌手/专辑；照片重算相册与拍摄时间；书重读书名/作者。不动文件、不丢记录。</span>
              </div>
              <div class="add-root" style="margin-top:14px">
                <input id="os-key" type="password" placeholder="OpenSubtitles API Key（opensubtitles.com 免费注册获取，供播放页「🌐 网络搜索字幕」下载中文 srt）" value="" />
                <button class="btn-small" id="os-key-save">保存 Key</button>
              </div>
              <div class="add-root">
                <input id="os-base-url" type="text" placeholder="OpenSubtitles 接口地址（国内直连会 403：填 CF Worker 代理，如 https://xxx.workers.dev/api/v1，留空用官方）" value="${esc(settings.osApiBaseUrl || '')}" />
                <button class="btn-small" id="os-base-save">保存接口地址</button>
              </div>
              <div class="alist-status" id="os-status">${settings.osApiKeyMasked ? `✅ 已配置 Key（${esc(settings.osApiKeyMasked)}）` : '未配置 Key。注意：国内网络直连 OpenSubtitles 是 403（IP 限制），需用 Cloudflare Worker 代理（交付包附现成代码）并把代理地址填到上方。'}</div>
              <!-- 直播片单地址 / 更新频道 / 源管理入口 已迁到「📡 电视直播」分组 -->
              <div class="add-root" style="margin-top:14px">
                <button class="btn-accent" id="ai-scan">🤖 AI 自动分类未标注照片</button>
                <button class="btn-small" id="ai-download" style="display:none">⬇️ 下载 AI 模型（约 335MB，一次即可）</button>
                <button class="btn-small" id="ai-text-download" style="display:none">⬇️ 下载词表模型（约 243MB）</button>
                <button class="btn-small" id="ai-stop" style="display:none">⏹ 停止</button>
                <button class="btn-small" id="ai-retry" style="display:none">↻ 重试失败项</button>
              </div>
              <div class="alist-status" id="ai-status">加载中…</div>
              <div id="ai-labels" style="display:none;margin-top:12px;padding:12px;border:1px solid var(--line,#2a2a2a);border-radius:8px">
                <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
                  <b>🏷 分类词表</b><span class="alist-status" style="margin:0" id="ai-lbl-src"></span>
                </div>
                <div id="ai-lbl-list"></div>
                <div class="add-root" style="margin-top:10px">
                  <button class="btn-small" id="ai-lbl-add">＋ 添加分类</button>
                  <button class="btn-accent" id="ai-lbl-save">保存并应用</button>
                  <button class="btn-small" id="ai-lbl-reclass">↻ 按词表重新分类</button>
                  <button class="btn-small" id="ai-lbl-reset">恢复默认</button>
                </div>
                <div class="alist-status" id="ai-lbl-hint"></div>
              </div>
            </div>
          </section>
          <section class="lib-pane hidden" data-lib-pane="livetv">
            ${paneTitle('📡 电视直播（直播源管理与更新频道）')}
            <div class="alist-panel">
              <div class="add-root">
                <input id="ltv-url" type="text" placeholder="直播频道片单地址：JSON 或 m3u 网址，或 NAS 上的文件路径" value="${esc(settings.liveTvCatalogUrl || '')}" />
                <button class="btn-small" id="ltv-url-browse">📂 选择本地文件</button>
                <button class="btn-accent" id="ltv-url-save">保存直播片单</button>
                <button class="btn-small" id="ltv-refresh">更新频道</button>
              </div>
              <div class="alist-status" id="ltv-url-status">留空则使用内置官方公开频道。支持 JSON（items: name/group/url/logo）或标准 m3u（#EXTINF group-title 分组）。换台用播放页 ⏮⏭。</div>
              <div id="ltv-pick-list" class="ltv-pick-list" style="display:none"></div>
            </div>
            <div class="alist-panel">
              <div class="alist-status">频道源管理（添加 / 编辑 / 删除 / 订阅同步 / 测速 / 去广告 / 应用生效）已收进独立管理页，点下方按钮打开：</div>
              <button class="btn-accent" id="ltv-open-admin">⚙ 打开直播源管理</button>
            </div>
          </section>
          <section class="lib-pane hidden" data-lib-pane="kids">
            ${paneTitle('🧸 儿童模式（家庭用户）')}
            <div class="alist-panel" id="kids-panel"><div class="alist-status">加载中…</div></div>
          </section>
          <section class="lib-pane hidden" data-lib-pane="ota">
            ${paneTitle('🔄 软件更新')}
            <div class="alist-panel" id="ota-panel"><div class="alist-status">加载中…</div></div>
          </section>
          <section class="lib-pane hidden" data-lib-pane="guide">
            ${paneTitle('📖 使用教程（功能入口 · 一步一步照着做）')}
            <div class="alist-panel" style="line-height:1.75;font-size:13.5px">
              <style>
                .gd-h{font-size:15px;font-weight:700;margin:18px 0 6px}
                .gd-h:first-child{margin-top:0}
                .gd-path{display:inline-block;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:2px 8px;margin:2px 2px 2px 0;font-size:12.5px}
                .gd-li{margin:4px 0 4px 0;padding-left:20px;position:relative}
                .gd-li::before{content:'•';position:absolute;left:6px;color:var(--muted,#9aa0a6)}
                .gd-tip{margin-top:14px;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,.04);border:1px dashed rgba(255,255,255,.15);font-size:12.5px;color:var(--muted,#9aa0a6)}
                .gd-k{color:var(--text,#e8eaed);font-weight:600}
              </style>

              <div class="gd-h">☁️ 一、网盘挂载（把网盘变成影视库）</div>
              <div class="gd-li">入口：<span class="gd-path">设置 ☁️ 挂载网盘</span>，点「一键挂载常见网盘」里的网盘名</div>
              <div class="gd-li">支持：阿里云盘 / 百度网盘 / 115 / 夸克 / 移动云盘 / 天翼云盘 / 联通云盘 等 9 家 + 任意 WebDAV</div>
              <div class="gd-li">按提示扫码或登录授权 → 挂好后网盘内容自动出现在对应媒体库，海报墙照常刮削</div>

              <div class="gd-h">✨ 二、AI 助理（大白话找片找照片）</div>
              <div class="gd-li">入口：顶部搜索框旁的 <span class="gd-k">✨ 按钮</span>（点亮 = AI 模式），输入问题直接回车</div>
              <div class="gd-li">例句：「有没有周星驰的电影」「找去年夏天的照片」「库里多少部剧」</div>
              <div class="gd-li">AI 自动理解并搜索全库，查完直接给结果卡片；涉及下载等操作会先跟你确认</div>

              <div class="gd-h">🧑 三、AI 人脸识别（照片按人整理）</div>
              <div class="gd-li">入口：<span class="gd-path">照片库 → 人物</span> 页签</div>
              <div class="gd-li">首次使用：点「⬇ 下载模型」（约 15MB，一次性）→ 点「▶ 立即提取」</div>
              <div class="gd-li">后台自动识别（页面每 8 秒刷新进度，可停止/重试）；完成后每个 persona 一张卡片</div>
              <div class="gd-li">管理：卡片上可改名（如「涛哥」）、合并同一个人、删除；点进卡片看 TA 的全部照片</div>
              <div class="gd-li">新增照片后：再点一次「立即提取」，只处理没跑过的，很快</div>

              <div class="gd-h">💬 四、AI 字幕（给视频自动配字幕）</div>
              <div class="gd-li">入口：播放视频 → 字幕菜单（CC 图标）→ <span class="gd-k">🤖 AI 生成字幕</span></div>
              <div class="gd-li">本地识别无需联网，一集 45 分钟约 10-20 分钟；生成完自动挂载，也可导出 .srt</div>

              <div class="gd-h">🏷 五、AI 智能分类 / 重新识别分类（自动整理）</div>
              <div class="gd-li">入口：<span class="gd-path">设置 → 📂 网盘与本地目录</span>（页签往下翻，TMDB 刮削下方）</div>
              <div class="gd-li">AI 智能分类：点下载模型（约 243MB，一次性）→ 开始扫描，照片自动按场景/主体归类（风景、美食、人物…）</div>
              <div class="gd-li">🔁 重新识别分类：选范围（影视/音乐/照片/书）后点按钮，修正电影剧集错乱、音乐标签、相册归档——不动文件、不丢记录</div>

              <div class="gd-h">🔄 六、软件更新（永久免费升级）</div>
              <div class="gd-li">入口：<span class="gd-path">设置 → 🔄 软件更新</span>，一键检查 + 升级</div>
              <div class="gd-li">所有功能更新免费推送</div>

              <div class="gd-tip">💡 小提示：页面显示异常或新功能没出现时，按 <b>Ctrl+F5</b> 强制刷新一次即可。</div>
            </div>
          </section>
<section class="lib-pane hidden" data-lib-pane="feat">
            ${paneTitle('🚫 功能开关（隐藏菜单与页面）')}
            <div class="alist-status">连外网时若不想让外人看到相册、私密影片等，把对应功能关掉 —— 前台菜单和页面都会消失（数据仍在，重新打开即可恢复）。「设置」本身永远可见。</div>
            <div class="alist-panel" id="feat-panel">
              ${FEAT_ITEMS.map((it) => '<label class="feat-row"><span>' + it.label + '</span><input type="checkbox" data-feat="' + it.key + '" ' + (FEATURE_HIDDEN.has(it.key) ? '' : 'checked') + '></label>').join('')}
              <button class="btn-accent" id="feat-save">保存</button>
              <div class="alist-status" id="feat-st"></div>
            </div>
          </section>
          <section class="lib-pane hidden" data-lib-pane="dl">
            <style>
.dlx{display:flex;gap:18px;align-items:stretch}
.dlx-side{flex:0 0 300px;max-width:300px;display:flex;flex-direction:column;gap:10px}
.dlx-side textarea{width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px 12px;color:var(--text,#e8eaed);font-size:13.5px;resize:vertical;min-height:96px;font-family:inherit}
.dlx-side textarea:focus{outline:none;border-color:#ff7a45}
.dlx-stat{font-size:12.5px;color:var(--muted,#9aa0a6);line-height:1.6}
.dlx-cfgbox{display:none;flex-direction:column;gap:8px;padding:12px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(255,255,255,.03)}
.dlx-cfgbox input{width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 10px;color:var(--text,#e8eaed);font-size:13px}
.dlx-main{flex:1;min-width:0;display:flex}
.dlx-frame{flex:1;display:none;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.08);background:#15171e}
.dlx-frame iframe{width:100%;height:min(74vh,820px);border:0;display:block}
.dlx-empty{flex:1;display:flex;flex-direction:column;gap:12px;justify-content:center;align-items:flex-start;padding:26px;border:1px dashed rgba(255,255,255,.14);border-radius:12px;background:rgba(255,255,255,.02)}
.dlx-empty-t{font-size:16px;font-weight:700}
.dlx-empty-p{font-size:13px;color:var(--muted,#9aa0a6);line-height:1.7;margin:0}
@media(max-width:900px){.dlx{flex-direction:column}.dlx-side{flex:auto;max-width:none}}
            </style>
            <div class="dlx">
              <aside class="dlx-side">
                <div class="panel-title">⬇️ 下载</div>
                <textarea id="dlx-url" placeholder="粘贴链接（http/https 直链、magnet: 磁力、.torrent 种子均可），多个链接用换行分隔"></textarea>
                <button class="btn-accent" id="dlx-go">⬇️ 添加下载</button>
                <div class="dlx-stat" id="dlx-stat">…</div>
                <div class="dlx-acts" style="display:flex;gap:8px;flex-wrap:wrap">
                  <button class="btn-ghost" id="dlx-dir">📁 保存目录</button>
                  <button class="btn-ghost" id="dlx-cfg">⚙ 连接设置</button>
                </div>
                <div id="dlx-cfgbox" class="dlx-cfgbox">
                  <input id="bt-url-cfg" type="text" placeholder="qBittorrent 地址，如 http://192.168.8.62:8086" />
                  <input id="bt-user" type="text" placeholder="用户名（默认 admin）" />
                  <input id="bt-pass" type="password" placeholder="WebUI 密码（本机默认 adminadmin）" />
                  <input id="bt-dir" type="text" placeholder="保存目录（留空用 qBittorrent 默认）" />
                  <button class="btn-accent" id="bt-save">测试并保存</button>
                </div>
              </aside>
              <div class="dlx-main">
                <div id="dlx-frame" class="dlx-frame"><iframe id="bt-ui-frame" title="qBittorrent 下载管理"></iframe></div>
                <div id="dlx-empty" class="dlx-empty"><div class="alist-status">加载中…</div></div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>`;

  /* gk：左侧分组切换（事件挂在新渲染的 lib-side 上，随 innerHTML 替换自动回收，无重复绑定） */
  const libSide = document.getElementById('lib-side');
  libSide.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lib-tab]');
    if (!btn) return;
    libSide.querySelectorAll('.lib-tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.lib-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.libPane !== btn.dataset.libTab));
    if (btn.dataset.libTab === 'perf' && typeof perfLoad === 'function') perfLoad(); // 自动体检可能在页面打开后才跑完，切回来时重读
    if (typeof dlPaneEnter === 'function') { if (btn.dataset.libTab === 'dl') dlPaneEnter(); else dlPaneLeave(); } // dlx：进出下载面板启停轮询
  });

  /* dlx：下载面板事件绑定 + 深链自动展开 */
  if (typeof dlPaneInit === 'function') dlPaneInit();
  if (LIB_OPEN_TAB) {
    const _lt = libSide.querySelector('[data-lib-tab="' + LIB_OPEN_TAB + '"]');
    LIB_OPEN_TAB = '';
    if (_lt) _lt.click();
  }

  /* gm：游戏配置分组 —— Steam 库配置面板 + RomM 凭据/数据源入口（业务页只留使用功能） */
  (async () => {
    if (document.getElementById('st-cfgbox')) {
      try { await stCfg(true); } catch { /* 读不到配置就显示空列表 */ }
      if (document.getElementById('st-cfgbox')) stCfgDraw();
    }
    const ssr = document.getElementById('st-set-rescan');
    if (ssr) ssr.onclick = async () => {
      const stx = document.getElementById('st-set-st');
      if (stx) stx.textContent = '正在扫描 Steam 库…';
      try {
        const r = await api('/api/games/steam/list?refresh=1');
        ST.items = r.items || []; ST.stats = r.stats || {};
        if (stx) stx.textContent = '扫描完成，共 ' + ((r.items || []).length) + ' 个游戏。';
      } catch (e) { if (stx) stx.textContent = '❌ ' + String(e.message || e); }
    };
    const gsm = document.getElementById('gm-set-meta');
    if (gsm) gsm.onclick = () => gamesMetaOpen();
    const gsc = document.getElementById('gm-set-cred');
    if (gsc) gsc.onclick = () => gmShowCred();
  })();

  /* 🎬 字幕全局微调 / 播放模式（artp25）
     artp39：走免锁接口 /api/settings/play-pref；万一还是 403（票据过期等）就弹密码框重试，
     不再只弹一句「保存失败」让用户一头雾水。 */
  const savePref = async (payload) => {
    const once = () => api('/api/settings/play-pref', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    try {
      return await once();
    } catch (e) {
      if (!AdminLock.loaded) await adminLockSync();
      if (!(AdminLock.set && !AdminLock.unlocked)) throw e;
      const ok = await adminAskUnlock();
      if (!ok) throw new Error('未输入管理密码，已取消');
      return once();
    }
  };
  const gsInput = document.getElementById('sub-gshift');
  const gsSave = document.getElementById('sub-gshift-save');
  if (gsInput && gsSave) gsSave.onclick = async () => {
    const v = Math.max(-10, Math.min(10, Number(gsInput.value) || 0));
    try {
      await savePref({ subGlobalShift: v });
      window.__hmpSubGlobalShift = v;
      settings.subGlobalShift = v;
      /* 让当前字幕立刻按新偏移重建（artp40：设置页作用域没有 video 变量，
         必须先确认当前页面真的存在播放器，否则整段跳过——此前在此处必抛
         "video is not defined"，导致保存成功却被误报为失败。 */
      try {
        const vid = document.querySelector('video');
        const el = vid ? Array.from(vid.querySelectorAll('track')).find((x) => x.label === HMP_EXT_LABEL) : null;
        if (el) { delete el.dataset.appliedOffset; clearSubTracks(true); reloadActiveSub(); }
      } catch (_) { /* 无播放器上下文，忽略 */ }
      toast('字幕微调已保存为 ' + v + ' 秒（下次加载字幕立即生效）', 3400);
    } catch (e) { toast('保存失败：' + (e.message || e), 3600); }
  };
  const gsReset = document.getElementById('sub-gshift-reset');
  if (gsReset && gsInput) gsReset.onclick = () => { gsInput.value = '0'; if (gsSave) gsSave.click(); };
  const pmSel = document.getElementById('play-mode');
  const pmSave = document.getElementById('play-mode-save');
  if (pmSel && pmSave) pmSave.onclick = async () => {
    try {
      await savePref({ playMode: pmSel.value });
      settings.playMode = pmSel.value;
      toast('播放模式已保存：' + (pmSel.value === 'direct' ? '强制直连' : '自动') + '（重新打开影片后生效）', 3600);
    } catch (e) { toast('保存失败：' + (e.message || e), 3600); }
  };

  /* ============ 🩺 网络与运行体检（A3，artp29） ============ */
  const ndList = document.getElementById('nd-list');
  const ndScore = document.getElementById('nd-score');
  const ndRun = document.getElementById('nd-run');
  const ndReload = document.getElementById('nd-reload');
  if (ndRun) ndRun.onclick = () => runNetDiag(true);
  if (ndReload) ndReload.onclick = () => runNetDiag(false);
  if (ndList) runNetDiag(false); // 打开页自动跑一次（结果缓存，不做修复）

  async function runNetDiag(showLoading) {
    if (!ndList) return;
    if (showLoading) ndList.innerHTML = '<div class="alist-status">正在体检…（含外网探测，约 10~20 秒）</div>';
    else if (ndList.querySelector('.alist-status') && !ndList.querySelector('.nd-item')) {
      ndList.innerHTML = '<div class="alist-status">正在读取上次体检结果…</div>';
    }
    let r;
    try { r = await api('/api/diag/run'); }
    catch (e) { if (ndList) ndList.innerHTML = '<div class="alist-status" style="color:#f87171">体检失败：' + esc(e.message || e) + '</div>'; return; }
    const s = r.score || { ok: 0, warn: 0, bad: 0 };
    if (ndScore) {
      const total = (s.ok || 0) + (s.warn || 0) + (s.bad || 0);
      const color = s.bad ? '#f87171' : s.warn ? '#fbbf24' : '#4ade80';
      ndScore.innerHTML = '<div class="tco-card" style="border-color:' + color + '">'
        + '<b style="color:' + color + '">共 ' + total + ' 项：正常 ' + (s.ok || 0) + ' · 提醒 ' + (s.warn || 0) + ' · 异常 ' + (s.bad || 0) + '</b>'
        + '<div style="color:var(--text-dim);font-size:12px;margin-top:4px">检查时间：' + (r.at ? new Date(r.at).toLocaleString('zh-CN') : '—')
        + (r.host ? '　主机：' + esc(r.host) : '') + '</div></div>';
    }
    const items = r.items || [];
    if (ndList) {
      if (!items.length) { ndList.innerHTML = '<div class="alist-status">体检没有返回项目' + (r.error ? '：' + esc(r.error) : '') + '</div>'; return; }
      const icon = { ok: '✅', warn: '⚠️', bad: '❌' };
      const color = { ok: 'var(--text)', warn: '#fbbf24', bad: '#f87171' };
      ndList.innerHTML = items.map((it, i) => {
        const lv = it.level || 'ok';
        return '<div class="tco-card nd-item" style="border-left:3px solid ' + (lv === 'bad' ? '#f87171' : lv === 'warn' ? '#fbbf24' : '#4ade80') + '">'
          + '<div style="font-size:13.5px;font-weight:600">' + (icon[lv] || '•') + ' ' + esc(it.label || it.key || '') + '</div>'
          + '<div style="color:' + color[lv] + ';font-size:12.5px;margin-top:3px;line-height:1.65">' + esc(it.detail || '') + '</div>'
          + (it.fix ? '<div class="add-root" style="margin-top:8px"><button class="btn-small nd-fix" data-i="' + i + '">🔧 一键修复</button></div>' : '')
          + '</div>';
      }).join('');
      ndList.querySelectorAll('.nd-fix').forEach((b) => {
        b.onclick = async () => {
          const it = items[Number(b.dataset.i)];
          if (!it || !it.fix) return;
          const act = String(it.fix);
          if (!confirm('将执行自动修复：' + act + '\n\n具体：' + (it.label || '') + '\n\n继续？')) return;
          b.disabled = true; b.textContent = '修复中…';
          try {
            const res = await api('/api/diag/fix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: act }) });
            toast((res && (res.message || res.detail)) || '已执行', 4200);
          } catch (e) { toast('修复未完成：' + (e.message || e), 4600); }
          b.disabled = false; b.textContent = '🔧 一键修复';
          runNetDiag(true);
        };
      });
    }
  }

  /* ============ 📘 能力与成本（artp29：C1 兼容矩阵 / D1 TCO / E2 诚实对比） ============ */
  const capM = document.getElementById('caps-matrix');
  if (capM) loadCapMatrix();
  async function loadCapMatrix() {
    const fmtB = (b) => {
      b = Number(b) || 0;
      if (b >= 1099511627776) return (b / 1099511627776).toFixed(2) + ' TB';
      if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
      return (b / 1048576).toFixed(0) + ' MB';
    };
    try {
      const r = await api('/api/media/codecs');
      const t = r.totals || {};
      const rows = r.rows || [];
      if (!t.files) { capM.innerHTML = '<div class="alist-status">库里还没有影片，先去扫描。</div>'; return; }
      const pct = (n) => (t.files ? (n * 100 / t.files).toFixed(1) : '0.0') + '%';
      const cell = (label, n, b, cls) =>
        '<div style="flex:1;min-width:150px;border:1px solid var(--hi-12);border-radius:10px;padding:9px 11px">'
        + '<div style="font-size:19px;font-weight:700" class="' + cls + '">' + n + ' 部</div>'
        + '<div style="font-size:12px;color:var(--text-dim)">' + label + ' · ' + fmtB(b) + ' · 占 ' + pct(n) + '</div></div>';
      let directB = 0, remuxB = 0, transB = 0, unknownB = 0;
      rows.forEach((x) => {
        if (x.mode === 'direct') directB += x.bytes;
        else if (x.mode === 'remux') remuxB += x.bytes;
        else if (x.vcodec === '未知') unknownB += x.bytes;
        else transB += x.bytes;
      });
      const head = '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-bottom:12px">'
        + cell('可直连零转码', t.direct || 0, directB, 'caps-yes')
        + cell('仅转音频（画质无损）', t.remux || 0, remuxB, 'caps-part')
        + cell('需整体转码', t.transcode || 0, transB, 'caps-no')
        + (unknownB ? cell('编码未知（建议重扫）', t.direct + t.remux + t.transcode, unknownB, '') : '')
        + '</div>';
      const body = rows.map((x) => '<tr>'
        + '<td>' + esc(x.vcodec) + (x.res ? ' <span style="color:var(--text-dim);font-size:11px">' + esc(x.res) + '</span>' : '') + '</td>'
        + '<td>' + esc(x.acodec) + '</td>'
        + '<td style="text-align:right">' + x.n + '</td>'
        + '<td style="text-align:right">' + fmtB(x.bytes) + '</td>'
        + '<td class="' + (x.tone === 'ok' ? 'caps-yes' : x.tone === 'warn' ? 'caps-part' : 'caps-no') + '">' + esc(x.modeLabel) + '</td>'
        + '<td style="color:var(--text-dim);font-size:11.5px">' + esc(x.hint || '') + '</td>'
        + '</tr>').join('');
      capM.innerHTML = head
        + '<table class="caps-tbl"><thead><tr><th>视频编码</th><th>音频编码</th><th style="text-align:right">部数</th>'
        + '<th style="text-align:right">体积</th><th>播放方式</th><th>说明</th></tr></thead><tbody>' + body + '</tbody></table>'
        + '<div class="caps-note" style="margin-top:8px">「需整体转码」的片子会把视频也重新编码，画质有损、且拖动进度条要等重开；'
        + '「仅转音频」的视频原样拷贝，画质无损，只是音轨转成 AAC。把 NAS 升级到能硬解 HEVC 的设备（Edge 浏览器 / 智能电视）就能把第一类也变直连。</div>';
    } catch (e) {
      capM.innerHTML = '<div class="alist-status">读取失败：' + esc(e.message || e) + '</div>';
    }
  }

  /* D1：TCO 五年电费对比（诚实算，只算电费） */
  const tcoCalc = document.getElementById('tco-calc');
  if (tcoCalc) tcoCalc.onclick = () => {
    const n = (id) => Number((document.getElementById(id) || {}).value) || 0;
    const price = n('tco-price'), nasW = n('tco-nas'), pcW = n('tco-pc'), hh = n('tco-h'), days = n('tco-days');
    const YEARS = 5;
    if (!(price > 0) || !(nasW > 0) || !(pcW > 0) || !(days > 0)) { toast('请把电价、功耗、使用天数填完整', 3200); return; }
    const nasKwh = (nasW / 1000) * 24 * days * YEARS;
    const pcKwh = (pcW / 1000) * hh * days * YEARS;
    const nasMoney = nasKwh * price, pcMoney = pcKwh * price;
    const diff = pcMoney - nasMoney;
    const out = document.getElementById('tco-out');
    if (out) {
      out.innerHTML = '<div class="tco-card">'
        + '<div>NAS 全天候待机：' + nasKwh.toFixed(0) + ' 度 × ' + price + ' 元 = <b>' + nasMoney.toFixed(0) + ' 元</b> / 五年</div>'
        + '<div>旧电脑每天开 ' + hh + ' 小时：' + pcKwh.toFixed(0) + ' 度 × ' + price + ' 元 = <b>' + pcMoney.toFixed(0) + ' 元</b> / 五年</div>'
        + '<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--hi-12)">'
        + (diff > 0
          ? 'NAS 五年少花 <b class="caps-yes">' + diff.toFixed(0) + ' 元</b>，约合每年 ' + (diff / YEARS).toFixed(0) + ' 元。'
          : '这台设定下 NAS 反而更费电 —— 把「旧电脑每天开机小时数」按实际填，通常 2~4 小时更贴近多数人。')
        + '</div></div>';
    }
  };
  const gotoCleanup = document.getElementById('caps-goto-cleanup');
  if (gotoCleanup) gotoCleanup.onclick = () => { const t = document.querySelector('[data-lib-tab="cleanup"]'); if (t) t.click(); };
  const gotoDiag = document.getElementById('caps-goto-diag');
  if (gotoDiag) gotoDiag.onclick = () => { const t = document.querySelector('[data-lib-tab="netdiag"]'); if (t) t.click(); };

  /* 🛡️ 访问白名单：保存前自检当前 IP 是否在名单内，避免把自己关在门外 */
  const ipwSave = document.getElementById('ipw-save');
  if (ipwSave) ipwSave.onclick = async () => {
    const listRaw = (document.getElementById('ipw-list') || {}).value || '';
    const enable = !!(document.getElementById('ipw-enable') || {}).checked;
    const st = document.getElementById('ipw-st');
    const myIp = String((settings && settings.clientIp) || '').trim();
    /* 极简自检：精确相等或同网段（前三段相同）即视为「在名单内」 */
    const seg = (ip) => String(ip || '').split('.').slice(0, 3).join('.');
    const inList = listRaw.split(/[\s,;，、]+/).filter(Boolean).some((e) => {
      const ipPart = e.split('/')[0];
      return ipPart === myIp || (e.includes('/') && seg(ipPart) === seg(myIp));
    });
    if (enable && myIp && !inList) {
      const okGo = confirm(`你当前的 IP（${myIp}）不在白名单里。\n\n保存后将无法从这台设备访问（NAS 本机 127.0.0.1 仍可访问，可用来改回来）。\n\n确定要保存吗？`);
      if (!okGo) { if (st) st.innerHTML = '<span style="color:#f87171">已取消：当前 IP 不在名单中，未保存</span>'; return; }
    }
    try {
      const r = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ipWhitelistEnabled: enable, ipWhitelist: listRaw }) });
      if (st) st.innerHTML = r && r.ipWhitelistKept != null
        ? `<span style="color:#4ade80">✅ 已保存：${enable ? '已启用限制' : '未启用限制'}，有效条目 ${r.ipWhitelistKept} 条</span>`
        : '<span style="color:#4ade80">✅ 已保存</span>';
      toast('访问白名单已保存', 3000);
    } catch (e) { if (st) st.innerHTML = '<span style="color:#f87171">❌ ' + esc(e.message || '保存失败') + '</span>'; }
  };

  /* feat：功能开关保存（隐藏菜单+页面） */
  const featSave = document.getElementById('feat-save');
  if (featSave) featSave.onclick = async () => {
    const hidden = FEAT_ITEMS.filter((it) => !document.querySelector('[data-feat="' + it.key + '"]').checked).map((it) => it.key);
    const st = document.getElementById('feat-st');
    try {
      await savePref({ featuresHidden: hidden });
      await loadFeatures(); route();
      if (st) st.textContent = '✅ 已保存，前台菜单已更新';
    } catch (e) { if (st) st.textContent = '❌ ' + String(e.message || e); }
  };

  /* ---- 🔒 管理密码面板：设置 / 修改 / 立即上锁 ---- */
  const lockPanel = document.getElementById('lock-panel');
  const lockMsg = (m) => {
    const el = lockPanel && lockPanel.querySelector('#lock-err');
    if (el) el.textContent = m ? '⚠️ ' + m : '';
  };
  const lockVal = (id) => { const el = lockPanel && lockPanel.querySelector('#' + id); return el ? el.value.trim() : ''; };
  const lockSave = async (isFirst) => {
    const p1 = lockVal('lock-new'), p2 = lockVal('lock-new2');
    if (!/^\d{4,8}$/.test(p1)) return lockMsg('管理密码需为 4~8 位数字');
    if (p1 !== p2) return lockMsg('两次输入的新密码不一致');
    try {
      await api('/api/admin/pass', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: p1, oldPin: isFirst ? '' : lockVal('lock-old') }) });
      AdminLock.set = true; AdminLock.unlocked = true;
      toast(isFirst ? '管理密码已设置 —— 之后进入设置页需输入它' : '管理密码已修改');
      renderLockPanel();
    } catch (e) { lockMsg(e.message); }
  };
  const renderLockPanel = () => {
    if (!lockPanel) return;
    if (AdminLock.demo) {
      lockPanel.innerHTML = `
        <div class="alist-status">演示站已关闭管理密码功能 —— 任何人都可以直接浏览和体验本页设置，无需也无法设置密码。</div>`;
      return;
    }
    if (AdminLock.set) {
      lockPanel.innerHTML = `
        <div class="alist-status">✅ <b>已开启</b> —— 进入本页需输入管理密码；解锁后 12 小时内免重复输入（重启服务或改密码即时失效）。孩子或访客打不开这一页。</div>
        <div class="add-root" style="margin-top:10px">
          <input id="lock-old" type="password" inputmode="numeric" maxlength="8" placeholder="原密码" autocomplete="off" />
          <input id="lock-new" type="password" inputmode="numeric" maxlength="8" placeholder="新密码（4~8 位数字）" autocomplete="off" />
          <input id="lock-new2" type="password" inputmode="numeric" maxlength="8" placeholder="再输一遍新密码" autocomplete="off" />
          <button class="btn-accent" id="lock-save">修改密码</button>
        </div>
        <div class="add-root" style="margin-top:10px">
          <button class="btn-small" id="lock-out">🔒 立即上锁并离开设置</button>
          <span class="alist-status" style="margin-left:10px" id="lock-err"></span>
        </div>`;
      lockPanel.querySelector('#lock-save').onclick = () => lockSave(false);
      lockPanel.querySelector('#lock-out').onclick = async () => {
        try { await api('/api/admin/lock', { method: 'POST' }); } catch { /* ignore */ }
        AdminLock.unlocked = false;
        toast('已上锁 —— 下次进设置需重新输入管理密码');
        location.hash = '#/home';
      };
    } else {
      lockPanel.innerHTML = `
        <div class="alist-status">⚠️ <b>未开启</b> —— 任何能打开这一页的人都能增删媒体库目录、改网盘账号与 TMDB Key。建议现在设置一个管理密码。</div>
        <div class="add-root" style="margin-top:10px">
          <input id="lock-new" type="password" inputmode="numeric" maxlength="8" placeholder="管理密码（4~8 位数字）" autocomplete="off" />
          <input id="lock-new2" type="password" inputmode="numeric" maxlength="8" placeholder="再输一遍确认" autocomplete="off" />
          <button class="btn-accent" id="lock-save">设置管理密码</button>
          <span class="alist-status" id="lock-err"></span>
        </div>
        <div class="alist-status">忘记密码不能从网页重置（否则这道锁等于没有）：在 NAS 上跑一次 <code>app/tools/reset-admin-pwd.js</code> 即可清空密码。</div>`;
      lockPanel.querySelector('#lock-save').onclick = () => lockSave(true);
    }
  };
  renderLockPanel();
  // 未设密码：本会话首次进设置页自动弹设置框（取消后仍留上面的提示条，下次进页面还会弹）
  if (!AdminLock.demo && !AdminLock.set && !AdminLock.prompted) {
    AdminLock.prompted = true;
    setTimeout(() => adminAutoSetPrompt(renderLockPanel), 300);
  }

  for (const [id, v] of Object.entries(LIB_INPUT_KEEP)) { const el = document.getElementById(id); if (el && v) el.value = v; }
  const $err = () => document.getElementById('root-err');
  const showErr = (msg) => {
    const el = $err();
    if (!el) return;
    el.textContent = msg ? '⚠️ ' + msg : '';
    el.classList.toggle('hidden', !msg);
  };
  const addRoot = async () => {
    const input = document.getElementById('root-path');
    const p = input.value.trim();
    if (!p) return;
    showErr('');
    try {
      await api('/api/roots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
      input.value = '';
      renderLibrary();
    } catch (e) { showErr('添加失败：' + e.message + '。请确认是本机/NAS 上真实存在的文件夹绝对路径'); }
  };
  document.getElementById('add-root-btn').onclick = addRoot;
  document.getElementById('root-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addRoot();
  });
  document.getElementById('pick-dir-btn').onclick = () => openDirPicker((dir) => {
    document.getElementById('root-path').value = dir;
    addRoot();
  });
  const cleanupOpenBtn = document.getElementById('cleanup-open');
  if (cleanupOpenBtn) cleanupOpenBtn.onclick = () => openCleanupDialog();
  const cleanupTrashBtn = document.getElementById('cleanup-trash-btn');
  if (cleanupTrashBtn) cleanupTrashBtn.onclick = () => openCleanupTrash();
  /* ---- 🚀 转码体检：显示档位/实测倍率，支持手动重测（POST 跑 10 秒基准） ---- */
  const perfStatusEl = document.getElementById('perf-status');
  const PERF_TIER_C = { S: '#22a559', A: '#2f7fd1', B: '#c98a12', C: '#d16a2f', D: '#c0392b' };
  const perfRender = (d) => {
    if (!perfStatusEl) return;
    const c = d && d.cached;
    if (!c || !c.testedAt) {
      perfStatusEl.innerHTML = d && d.error ? '上次体检失败：' + esc(d.error) : '尚未体检：服务启动后会自动体检（结果缓存 30 天），也可点上方按钮立即测。';
      return;
    }
    const color = PERF_TIER_C[c.tier] || '#888';
    const when = new Date(c.testedAt).toLocaleString();
    const warn = c.tier === 'D'
      ? '<div style="margin-top:6px;color:#c0392b">⚠️ 本机算力不适合实时转码：播放时只提供「原画质直连 / Remux」通道，HMP 不会强行转码拖垮机器。</div>'
      : (c.tier === 'C' ? '<div style="margin-top:6px;opacity:.75">提示：超高清（4K/8K）播放时会自动降到 720p 并用最快编码档，优先保证不卡不死机。</div>' : '');
    const busyTip = (c.load1 != null && c.cores && c.load1 > c.cores * 0.5)
      ? '<div style="margin-top:6px;color:#c98a12">⚠️ 体检时系统负载偏高（1 分钟负载 ' + c.load1 + ' / ' + c.cores + ' 核），测得性能可能偏低；建议空闲时点「重新体检」。</div>'
      : '';
    perfStatusEl.innerHTML =
      '<div style="font-size:15px">转码档位：<b style="color:' + color + ';font-size:19px">' + esc(c.tier) + '</b>（' + esc(c.label || '') + '）' +
      '　·　720p 实测 <b>' + (c.ratio != null ? c.ratio.toFixed(1) : '?') + 'x</b> 实时　·　CPU ' + (c.cores || '?') + ' 核</div>' +
      '<div style="margin-top:4px;opacity:.65;font-size:12px">' + esc(c.model || '') + '<br>体检时间：' + esc(when) + '（缓存 30 天，期间自动复用）</div>' + warn + busyTip;
  };
  const perfLoad = async () => {
    if (!perfStatusEl) return;
    try { perfRender(await api('/api/perf/status')); } catch { perfStatusEl.textContent = '读取体检结果失败'; }
  };
  perfLoad();
  const perfBtn = document.getElementById('perf-reprobe');
  if (perfBtn) perfBtn.onclick = async () => {
    if (!(await adminEnsureUnlocked())) return;
    const oldTxt = perfBtn.textContent;
    perfBtn.disabled = true; perfBtn.textContent = '⏳ 体检中（约 15 秒，CPU 短暂占满）…';
    try {
      /* POST /probe 成功时返回扁平结构（tier/testedAt 在顶层），perfRender 只认
         {cached:{...}} 形状——直接渲染会显示「尚未体检」，体检等于白跑。
         所以成功后改读 GET /status 的标准形状；失败（{ok:false,error}）照旧走错误分支。 */
      const r = await api('/api/perf/probe', { method: 'POST' });
      if (r && r.ok) { perfRender(await api('/api/perf/status')); toast('转码体检完成'); }
      else perfRender(r);
    }
    catch (e) { perfStatusEl.textContent = '体检失败：' + e.message; }
    perfBtn.disabled = false; perfBtn.textContent = oldTxt;
  };
  /* AI 字幕（whisper 本地转写）：扫描缺字幕影片 → 后台批量生成 → 进度轮询（1.5s） */
  const asrStatusEl = document.getElementById('asr-status');
  const asrListEl = document.getElementById('asr-list');
  const asrScanBtn = document.getElementById('asr-scan');
  const asrRunBtn = document.getElementById('asr-run');
  const asrAbortBtn = document.getElementById('asr-abort');
  const asrModelSel = document.getElementById('asr-model');
  let asrItems = [];
  const asrFmtDur = (s) => (s >= 3600 ? (s / 3600).toFixed(1) + ' 小时' : Math.max(1, Math.round(s / 60)) + ' 分钟');
  const asrRenderProg = (d) => {
    if (!asrStatusEl) return;
    const eta = d.etaSec != null ? ` · 预计还需 ${asrFmtDur(d.etaSec)}` : '';
    const autoTag = (d.batch > 1 || (d.remainAll || 0) > d.total) ? `（连续模式·第${d.batch || 1}批·全库剩余约 ${d.remainAll || '?'} 部）` : '';
    asrStatusEl.textContent = `生成中${autoTag} ${d.done}/${d.total} · 当前：${d.currentTitle || '…'}${d.pct ? `（${d.pct}%）` : ''}${eta} · 成功 ${d.ok} / 失败 ${d.failed} / 跳过 ${d.skipped}`;
  };
  const asrStartPoll = () => {
    if (window.__asrPoll) clearInterval(window.__asrPoll);
    if (asrRunBtn) asrRunBtn.disabled = true;
    if (asrScanBtn) asrScanBtn.disabled = true;
    if (asrAbortBtn) { asrAbortBtn.disabled = false; asrAbortBtn.textContent = '⏹ 中止'; }
    window.__asrPoll = setInterval(async () => {
      try {
        const d = await api('/api/asr/run/status');
        if (d.running) { asrRenderProg(d); return; }
        clearInterval(window.__asrPoll); window.__asrPoll = null;
        if (asrScanBtn) asrScanBtn.disabled = false;
        if (asrAbortBtn) asrAbortBtn.disabled = true;
        const tail = d.aborted ? '已中止' : (d.autoDone ? '全部完成' : '批次完成');
        toast(`AI 字幕${tail}：成功 ${d.ok} / 失败 ${d.failed} / 跳过 ${d.skipped}`);
        const remainTip = (d.remainAll && !d.autoDone) ? `，全库剩余约 ${d.remainAll} 部` : '';
        if (asrStatusEl) asrStatusEl.textContent = `${tail}：成功 ${d.ok} / 失败 ${d.failed} / 跳过 ${d.skipped}${remainTip}（可点「扫描缺字幕影片」查看剩余）`;
        if (asrListEl && d.recent && d.recent.length) {
          asrListEl.innerHTML = '<div style="margin-top:10px;font-size:12px;color:var(--text-dim)">' + d.recent.map((r) =>
            `${r.ok ? '✅' : (r.skipped ? '⏭' : '❌')} ${esc(r.title)}${r.ok ? ` · ${Math.round(r.sec)}s · ${r.cues} 条` : ` · ${esc(r.error || '失败')}`}`).join('<br>') + '</div>';
        }
      } catch { /* ignore */ }
    }, 1500);
  };
  if (asrScanBtn) asrScanBtn.onclick = async () => {
    asrScanBtn.disabled = true;
    try {
      const r = await api('/api/asr/missing?limit=500');
      asrItems = r.items || [];
      if (asrListEl) asrListEl.innerHTML = asrItems.length
        ? asrItems.slice(0, 30).map((m) => `<div style="font-size:12px;word-break:break-all">· ${esc(m.title || m.file_name)} <span style="color:var(--text-dim)">${asrFmtDur(m.duration || 0)}</span></div>`).join('')
          + (asrItems.length > 30 ? `<div style="font-size:12px;color:var(--text-dim)">…共 ${asrItems.length} 部</div>` : '')
        : '<div class="empty-hint">全部影片都有字幕（或 AI 字幕），无需生成 🎉</div>';
      const totalMiss = r.count || asrItems.length;
      if (asrStatusEl) asrStatusEl.textContent = asrItems.length ? `全库共 ${totalMiss} 部缺字幕，本批先跑最短的前 ${asrItems.length} 部（每部约 10~30 分钟，随时可中止；勾选「连续模式」跑完自动下一批）` : '无需生成';
      if (asrRunBtn) asrRunBtn.disabled = !asrItems.length;
    } catch (e) { if (asrStatusEl) asrStatusEl.textContent = '扫描失败：' + e.message; }
    asrScanBtn.disabled = false;
  };
  if (asrRunBtn) asrRunBtn.onclick = async () => {
    if (!asrItems.length) { toast('先点「扫描缺字幕影片」'); return; }
    if (!(await adminEnsureUnlocked())) return;
    asrRunBtn.disabled = true;
    try {
      const asrAutoChk = document.getElementById('asr-auto');
      const r = await api('/api/asr/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: asrItems.map((m) => m.id), model: asrModelSel ? asrModelSel.value : null, auto: !!(asrAutoChk && asrAutoChk.checked) }) });
      if (!r.ok) { toast(r.error || '启动失败'); asrRunBtn.disabled = false; return; }
      toast(`已开始生成 ${r.total} 部影片的字幕（模型 ${r.model}），进度见下方`);
      asrStartPoll();
    } catch (e) { toast('启动失败：' + e.message); asrRunBtn.disabled = false; }
  };
  if (asrAbortBtn) asrAbortBtn.onclick = async () => {
    asrAbortBtn.disabled = true;
    asrAbortBtn.textContent = '正在终止…';
    try { await api('/api/asr/run/abort', { method: 'POST' }); } catch { /* ignore */ }
    if (asrStatusEl) asrStatusEl.textContent = '正在终止当前转写（已完成的字幕会保留）…';
  };
  (async () => { // 就绪状态 + 模型列表
    try {
      const s = await api('/api/asr/status');
      if (!s.ready) {
        if (asrStatusEl) asrStatusEl.textContent = s.whisper
          ? '⚠️ whisper 运行时已就绪但没有模型文件（runtime/whisper/models/ggml-*.bin），功能暂不可用'
          : '⚠️ 本机未装配 whisper 运行时（runtime/whisper/whisper-cli），AI 字幕功能暂不可用；其余功能不受影响';
        if (asrScanBtn) asrScanBtn.disabled = true;
        if (asrRunBtn) asrRunBtn.disabled = true;
        return;
      }
      if (asrModelSel) {
        asrModelSel.innerHTML = s.models.map((m) => `<option value="${esc(m.name)}" ${m.name === s.model ? 'selected' : ''}>${esc(m.name)}（${fmtSize(m.size)}）</option>`).join('');
      }
      if (asrStatusEl) asrStatusEl.textContent = `✅ 就绪：模型 ${s.model} · 全库已有 ${s.tracks} 条 AI 字幕${s.run && s.run.running ? ' · 正在生成中…' : ''}`;
      if (s.run && s.run.running) asrStartPoll();
    } catch (e) { if (asrStatusEl) asrStatusEl.textContent = '状态获取失败：' + e.message; }
  })();
  const scanFullBtn = document.getElementById('full-scan-btn'); // 一键全系统扫描（原顶部按钮迁入）
  if (scanFullBtn) scanFullBtn.onclick = async () => {
    scanFullBtn.disabled = true;
    try {
      const r = await api('/api/scan', { method: 'POST' });
      if (!r.ok) alert(r.error);
      else watchScan();
    } catch (e) { alert('扫描失败: ' + e.message); }
    scanFullBtn.disabled = false;
  };
  /* gl：书库/音乐目录管理（自书架/音乐页侧栏迁入；id 与原按钮同名，doBookScan/doMusicScan 的
     querySelectorAll('#bk-scan'/'#mu-scan') 自动覆盖到这里；删除按钮用 data-del-root /
     data-mu-delroot 与影视 data-delroot 区分，避免被上方影视删除绑定误捕） */
  const bkAdd = document.getElementById('bk-add');
  if (bkAdd) bkAdd.onclick = () => openDirPicker(async (p) => {
    try {
      await api('/api/books/roots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
      toast('目录已添加，开始扫描入库…');
      await doBookScan();
    } catch (e) { toast('添加失败：' + e.message); }
  }, '选择书目目录');
  const bkScan = document.getElementById('bk-scan');
  if (bkScan) bkScan.onclick = () => doBookScan();
  const bkReid = document.getElementById('bk-reid');
  if (bkReid) bkReid.onclick = async () => {
    if (!(await adminEnsureUnlocked())) return;
    bkReid.disabled = true; bkReid.textContent = '识别中…';
    try {
      const r = await api('/api/reclassify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'ebooks' }) });
      toast(`重新识别完成：更新 ${(r.ebooks && r.ebooks.updated) || 0} 本`);
    } catch (e) { toast('识别失败：' + e.message); }
    bkReid.disabled = false; bkReid.textContent = '🧹 重新识别（新格式/书名）';
    delete PAGE_CACHE.books;
    renderLibrary();
  };
  $app.querySelectorAll('[data-del-root]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('移除该书库目录？其中已入库的图书记录会一并清除（磁盘文件不受影响）。')) return;
      try { await api('/api/books/roots/' + btn.dataset.delRoot, { method: 'DELETE' }); } catch { /* ignore */ }
      delete PAGE_CACHE.books;
      renderLibrary();
    };
  });
  const muAdd = document.getElementById('mu-add');
  if (muAdd) muAdd.onclick = () => openDirPicker(async (p) => {
    try {
      await api('/api/music/roots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
      delete PAGE_CACHE.music; // eu：新增目录要扫描入库，音乐中心缓存作废
      toast('目录已添加，开始扫描入库…');
      await doMusicScan();
    } catch (e) { toast('添加失败：' + e.message); }
  }, '选择音乐目录');
  const muScan = document.getElementById('mu-scan');
  if (muScan) muScan.onclick = () => doMusicScan();
  $app.querySelectorAll('[data-mu-delroot]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('移除该音乐目录？其中已入库的歌曲记录会一并清除（磁盘文件不受影响）。')) return;
      try { await api('/api/music/roots/' + btn.dataset.muDelroot, { method: 'DELETE' }); } catch { /* ignore */ }
      delete PAGE_CACHE.music;
      renderLibrary();
    };
  });
  kidsRenderSettings().catch(() => {});
  $app.querySelectorAll('[data-delroot]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('删除该媒体库目录及其索引记录？')) return;
      await api(`/api/roots/${btn.dataset.delroot}`, { method: 'DELETE' });
      renderLibrary();
    };
  });
  $app.querySelectorAll('[data-rescan]').forEach((btn) => {
    btn.onclick = async () => {
      await api('/api/scan', { method: 'POST' });
      watchScan();
      location.hash = '#/home';
    };
  });

  const webdavSave = document.getElementById('webdav-save');
  if (webdavSave) {
    webdavSave.onclick = async () => {
      const st = document.getElementById('webdav-status');
      st.textContent = '连接中…';
      const r = await api('/api/webdav/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        url: document.getElementById('webdav-url').value.trim(),
        username: document.getElementById('webdav-user').value.trim(),
        password: document.getElementById('webdav-pass').value,
      }) });
      if (r.ok) { st.textContent = '✅ 已连接 ' + (r.server || ''); renderLibrary(); }
      else st.textContent = '❌ 连接失败：' + r.error;
    };
    const webdavAdd = document.getElementById('webdav-add');
    if (webdavAdd) {
      webdavAdd.onclick = async () => {
        showErr('');
        try {
          const dv = (document.getElementById('webdav-dir') || { value: '' }).value.trim();
          if (!dv) { showErr('请先输入网盘内目录路径（如 /音乐），或点「浏览」勾选目录'); return; }
          await api('/api/webdav/roots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dv }) });
          delete LIB_INPUT_KEEP['webdav-dir'];
          await api('/api/scan', { method: 'POST' });
          watchScan();
          location.hash = '#/home';
        } catch (e) { showErr('网盘目录添加失败：' + e.message); }
      };
      const webdavBrowse = document.getElementById('webdav-browse');
      if (webdavBrowse) {
        webdavBrowse.onclick = () => openCloudPicker('', async (dirs) => {
          showErr('');
          const r = await addWebdavDirs(dirs);
          if (!r.added.length) {
            showErr('没有新增目录'
              + (r.skipped.length ? `（${r.skipped.length} 个已存在，已跳过）` : '')
              + (r.failed.length ? `；不可访问：${r.failed.join('、')}` : ''));
            return;
          }
          delete LIB_INPUT_KEEP['webdav-dir'];
          await api('/api/scan', { method: 'POST' });
          watchScan();
          location.hash = '#/home';
        });
      }
    }
  }

  /* gn: 网盘桥接（OpenList）引导条 */
  loadBridgeBanner();
  /* go+++：网盘快捷入口（一排带网盘名的按钮 + 就地授权） */
  loadNetdiskEntry();

  /* ---- 设置：TMDB Key / 手动刮削 ---- */
  const tmdbSave = document.getElementById('tmdb-save');
  if (tmdbSave) {
    tmdbSave.onclick = async () => {
      const input = document.getElementById('tmdb-key');
      const k = input.value.trim();
      if (!k) return;
      const st = document.getElementById('tmdb-status');
      st.textContent = '保存中…';
      try {
        await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tmdbApiKey: k }) });
        st.textContent = '✅ Key 已保存，点「立即刮削」开始补全元数据';
        tmdbSave.textContent = '更新 Key';
        input.value = '';
      } catch (e) { st.textContent = '⚠️ 保存失败：' + e.message; }
    };
    const tmdbBaseSave = document.getElementById('tmdb-base-save');
    if (tmdbBaseSave) {
      tmdbBaseSave.onclick = async () => {
        const input = document.getElementById('tmdb-base-url');
        const st = document.getElementById('tmdb-status');
        st.textContent = '保存中…';
        try {
          await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tmdbApiBaseUrl: input.value.trim() }) });
          st.textContent = '✅ 接口地址已保存，点「立即刮削」重新执行即可';
        } catch (e) { st.textContent = '⚠️ 保存失败：' + e.message; }
      };
    }
    const osKeySave = document.getElementById('os-key-save');
    if (osKeySave) {
      osKeySave.onclick = async () => {
        const input = document.getElementById('os-key');
        const k = input.value.trim();
        const st = document.getElementById('os-status');
        if (!k) { st.textContent = '⚠️ 先粘贴 OpenSubtitles API Key'; return; }
        st.textContent = '保存中…';
        try {
          await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opensubtitlesApiKey: k }) });
          st.textContent = '✅ Key 已保存。播放页「字幕 → 🌐 网络搜索字幕」即可下载中文 srt';
          input.value = '';
        } catch (e) { st.textContent = '⚠️ 保存失败：' + e.message; }
      };
    }
    const osBaseSave = document.getElementById('os-base-save');
    if (osBaseSave) {
      osBaseSave.onclick = async () => {
        const input = document.getElementById('os-base-url');
        const st = document.getElementById('os-status');
        st.textContent = '保存中…';
        try {
          await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opensubtitlesApiBaseUrl: input.value.trim() }) });
          st.textContent = '✅ 接口地址已保存（留空即恢复官方默认）';
        } catch (e) { st.textContent = '⚠️ 保存失败：' + e.message; }
      };
    }
    const scrapeBtn = document.getElementById('tmdb-scrape');
    const prog = document.getElementById('tmdb-progress');
    let scrapePoll = null;
    const pollScrape = async () => {
      try {
        const s = await api('/api/tmdb/status');
        const failHint = s.failed && s.lastError ? `（最近失败原因：${s.lastError}）` : '';
        prog.textContent = s.enabled
          ? (s.running ? `刮削中 ${s.done}/${s.total}（成功 ${s.updated}，失败 ${s.failed}）`
            : s.done ? `上次刮削：成功 ${s.updated}，失败 ${s.failed}；已刮削 ${s.stats.mediaScraped}/${s.stats.mediaTotal} 部影片、${s.stats.seriesScraped}/${s.stats.seriesTotal} 部剧集${failHint}`
            : `已刮削 ${s.stats.mediaScraped}/${s.stats.mediaTotal} 部影片、${s.stats.seriesScraped}/${s.stats.seriesTotal} 部剧集`)
          : '未配置 TMDB API Key';
        if (!s.running && scrapePoll) { clearInterval(scrapePoll); scrapePoll = null; scrapeBtn.disabled = false; }
      } catch { /* ignore */ }
    };
    scrapeBtn.onclick = async () => {
      try {
        const r = await api('/api/tmdb/scrape', { method: 'POST' });
        if (!r.ok) { prog.textContent = '⚠️ ' + r.error; return; }
        scrapeBtn.disabled = true;
        if (!scrapePoll) scrapePoll = setInterval(pollScrape, 2000);
      } catch (e) { prog.textContent = '⚠️ ' + e.message; }
    };
    pollScrape();
    const ltvSave = document.getElementById('ltv-url-save');
    ltvSave.onclick = async () => {
      const input = document.getElementById('ltv-url');
      const st = document.getElementById('ltv-url-status');
      st.textContent = '保存中…';
      try {
        const r = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ liveTvCatalogUrl: input.value.trim() }) });
        st.textContent = r.liveTvWarning ? '⚠️ 直播片单已保存，但拉取失败：' + r.liveTvWarning + '（保留旧片单，稍后自动重试）'
          : '✅ 直播片单已保存并拉取成功，「电视直播」已更新';
      } catch (e) { st.textContent = '⚠️ 保存失败：' + e.message; }
    };

    // 电视直播：设置页「📡 电视直播」分组的源管理入口与更新频道
    const ltvOpenAdmin = document.getElementById('ltv-open-admin');
    if (ltvOpenAdmin) ltvOpenAdmin.onclick = () => { location.hash = '#/livetv/admin'; };
    const ltvRefresh = document.getElementById('ltv-refresh');
    if (ltvRefresh) ltvRefresh.onclick = async () => {
      ltvRefresh.disabled = true; ltvRefresh.textContent = '更新中…';
      try { await api('/api/livetv/refresh', { method: 'POST' }); toast('✅ 频道已更新，回到「电视直播」即可观看'); }
      catch (e) { toast('⚠️ 更新失败：' + e.message); }
      ltvRefresh.disabled = false; ltvRefresh.textContent = '更新频道';
    };

    // 「选择本地文件」：优先原生目录选择器（桌面版），否则用服务端文件浏览浮层（Web 版）
    const ltvBrowse = document.getElementById('ltv-url-browse');
    if (ltvBrowse) ltvBrowse.onclick = async () => {
      const st = document.getElementById('ltv-url-status');
      if (window.hmpNative && window.hmpNative.pickCatalogFile) {
        st.textContent = '请在弹出的窗口中选择片单文件…';
        try {
          const r = await window.hmpNative.pickCatalogFile();
          if (r && r.canceled) { st.textContent = '已取消选择'; return; }
          const p = r && (r.path || r.filePath);
          if (!p) { st.textContent = '⚠️ 未取得文件路径'; return; }
          document.getElementById('ltv-url').value = p;
          st.textContent = '已选择：' + p + '，正在保存…';
          ltvSave.onclick();
        } catch (e) { st.textContent = '⚠️ 选择失败：' + e.message; }
        return;
      }
      openLtvPicker();
    };

    const recBtn = document.getElementById('reclassify');
    recBtn.onclick = async () => {
      const st = document.getElementById('reclassify-status');
      const scope = document.getElementById('reclassify-scope').value;
      recBtn.disabled = true;
      st.textContent = '识别中…（文件多时约需十几秒到几分钟，请勿关闭页面）';
      try {
        const r = await api('/api/reclassify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope }) });
        if (!r.ok) {
          st.textContent = '⚠️ 失败：' + (r.error || '未知错误');
        } else {
          const parts = [];
          if (r.video) parts.push(`影视 ${r.video.total} 个修正 ${r.video.updated} 条（电影 ${r.video.counts.movie || 0} / 剧集 ${r.video.counts.episode || 0} / 短片 ${r.video.counts.short || 0}${r.video.locked ? `，跳过锁定 ${r.video.locked}` : ''}）`);
          if (r.music) parts.push(`音乐 ${r.music.total} 首修正 ${r.music.updated} 首${r.music.skipped ? `（未变跳过 ${r.music.skipped}）` : ''}`);
          if (r.photos) parts.push(`照片 ${r.photos.total} 张修正 ${r.photos.updated} 张`);
          if (r.ebooks) parts.push(`图书 ${r.ebooks.total} 本修正 ${r.ebooks.updated} 本`);
          st.textContent = '✅ 完成：' + parts.join('；') + '。刷新对应页面生效。';
        }
      } catch (e) { st.textContent = '⚠️ 失败：' + e.message; }
      recBtn.disabled = false;
    };

    /* AI 智能分类：状态展示 + 模型下载 + 批量任务（轮询到任务结束为止） */
    const aiSt = document.getElementById('ai-status');
    let aiTimer = null;
    const aiAlive = () => aiSt && document.getElementById('ai-status') === aiSt;
    // 分类张数的显示串：类名取自「生效词表」——词表可自定义，不能写死 5 类
    const aiCatLine = (s, p) => ((s && s.labels) || []).filter((c) => (p || {})[c]).map((c) => `${c} ${p[c]}`).join(' · ') || '—';
    const aiRender = (s) => {
      if (!aiAlive()) { if (aiTimer) { clearInterval(aiTimer); aiTimer = null; } return; }
      if (s.downloading && !s.downloading.error) {
        const pct = s.downloading.total ? Math.round(s.downloading.bytes / s.downloading.total * 100) : 0;
        const what = s.downloading.kind === 'text' ? '词表模型' : 'AI 模型';
        aiSt.textContent = `⬇️ 正在下载${what} ${pct}%（${(s.downloading.bytes / 1048576).toFixed(0)}/${((s.downloading.total || 0) / 1048576).toFixed(0)} MB），下载一次后完全离线运行`;
      } else if (s.batch && s.batch.running) {
        aiSt.textContent = `🤖 AI 分类中 ${s.batch.done}/${s.batch.total} 张（失败 ${s.batch.fail}）· ${aiCatLine(s, s.batch.perCat)}`
          + (s.batch.lastError ? ` · 首个错误：${s.batch.lastError}` : '');
      } else if (s.reclass && s.reclass.running) {
        aiSt.textContent = `🔄 正在按当前词表重新分类 ${s.reclass.done}/${s.reclass.total} 张（已变更 ${s.reclass.changed}）…`;
      } else if (s.reclass && s.reclass.error) {
        aiSt.textContent = `⚠️ 重分类失败：${s.reclass.error}`;
      } else if (s.reclass && s.reclass.done) {
        aiSt.textContent = `✅ 已按词表重新分类 ${s.reclass.done} 张（变更 ${s.reclass.changed}，用时 ${s.reclass.secs}s）· ${aiCatLine(s, s.reclass.perCat)}`;
      } else if (s.batch && s.batch.done) {
        aiSt.textContent = `✅ 上次分类 ${s.batch.done} 张（用时 ${s.batch.secs}s，失败 ${s.batch.fail}，低置信度 ${s.batch.low} 张）。还剩 ${s.pending} 张未分类。`
          + (s.batch.error ? ` ⚠️ ${s.batch.error}` : '')
          + (s.failed ? ` 有 ${s.failed} 张处理失败，可用「重试失败项」再跑。` : '');
      } else if (!s.installed) {
        aiSt.textContent = `本地 AI 模型未安装。点「下载 AI 模型」获取（约 335MB，下载一次永久离线可用），可自动分类 ${s.pending} 张未标注照片，不会覆盖你手动打的标签。`;
      } else {
        aiSt.textContent = `✅ 本地 AI 就绪（${s.model}，${s.modelMB}MB，${s.threads || 1} 线程，纯本地推理不联网）。当前 ${s.pending} 张未标注照片，已建图片向量 ${s.vecStored || 0} 张；点上面按钮开始自动分类。`
          + (s.threadsFallback ? '（多线程不可用，已退回单线程）' : '')
          + (s.failed ? ` 有 ${s.failed} 张处理失败，可用「重试失败项」再跑。` : '');
      }
      const dl = document.getElementById('ai-download');
      const stop = document.getElementById('ai-stop');
      const retry = document.getElementById('ai-retry');
      const tdl = document.getElementById('ai-text-download');
      const lbl = document.getElementById('ai-labels');
      if (dl) dl.style.display = s.installed ? 'none' : '';
      // 词表模型：视觉模型就绪、但词表模型未下载时露出（改词表要用它算文字向量）
      if (tdl) tdl.style.display = (s.installed && s.textModel && !s.textModel.installed) ? '' : 'none';
      if (lbl) lbl.style.display = s.installed ? '' : 'none';
      const busyAll = (s.batch && s.batch.running) || (s.reclass && s.reclass.running);
      if (stop) stop.style.display = busyAll ? '' : 'none';
      // 仅当存在「试过但失败」的照片、模型就绪、且当前无任务在跑时才露出重试入口
      if (retry) retry.style.display = (s.installed && s.failed > 0 && !busyAll) ? '' : 'none';
    };
    const aiPoll = async () => {
      try {
        const s = await api('/api/ai/info');
        aiRender(s);
        const busy = (s.batch && s.batch.running) || (s.reclass && s.reclass.running)
          || (s.downloading && !s.downloading.error);
        if (!busy && aiTimer) { clearInterval(aiTimer); aiTimer = null; }
      } catch { /* AI 包未随此实例部署时静默 */ }
    };
    aiPoll();
    const aiScanBtn = document.getElementById('ai-scan');
    if (aiScanBtn) aiScanBtn.onclick = async () => {
      aiScanBtn.disabled = true;
      try {
        const r = await api('/api/ai/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        if (r.error) toast(r.error);
        else { toast('AI 自动分类已启动', 3000); if (!aiTimer) aiTimer = setInterval(aiPoll, 2000); }
      } catch (e) { toast('启动失败：' + e.message); }
      aiScanBtn.disabled = false;
    };
    const aiDlBtn = document.getElementById('ai-download');
    if (aiDlBtn) aiDlBtn.onclick = async () => {
      try {
        const r = await api('/api/ai/download', { method: 'POST' });
        if (r.error) toast(r.error); else { toast('模型下载已开始', 3000); if (!aiTimer) aiTimer = setInterval(aiPoll, 1500); }
      } catch (e) { toast('下载启动失败：' + e.message); }
    };
    const aiStopBtn = document.getElementById('ai-stop');
    if (aiStopBtn) aiStopBtn.onclick = async () => { await api('/api/ai/stop', { method: 'POST' }); toast('已请求停止', 2500); };
    const aiRetryBtn = document.getElementById('ai-retry');
    if (aiRetryBtn) aiRetryBtn.onclick = async () => {
      aiRetryBtn.disabled = true;
      try {
        const r = await api('/api/ai/retry', { method: 'POST' });
        toast(`已将 ${r.requeued || 0} 张失败照片放回队列，点「AI 自动分类」重跑`, 4000);
        aiPoll();
      } catch (e) { toast('重排失败：' + e.message); }
      aiRetryBtn.disabled = false;
    };
    const aiTextDlBtn = document.getElementById('ai-text-download');
    if (aiTextDlBtn) aiTextDlBtn.onclick = async () => {
      try {
        const r = await api('/api/ai/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'text' }) });
        if (r.error) toast(r.error); else { toast('词表模型下载已开始', 3000); if (!aiTimer) aiTimer = setInterval(aiPoll, 1500); }
      } catch (e) { toast('下载启动失败：' + e.message); }
    };

    /* 分类词表编辑：改词表只重算「文字」向量（秒级），图片向量原样复用，不必重跑模型。
       这也是零样本模型最便宜的地方——想按什么维度归类，改词就行。 */
    const aiLblRow = (name, prompts) => {
      const row = document.createElement('div');
      row.className = 'ai-lbl-row';
      row.style.cssText = 'display:flex;gap:6px;align-items:flex-start;margin-bottom:6px';
      const n = document.createElement('input');
      n.className = 'ai-lbl-name';
      n.value = name || '';
      n.placeholder = '分类名';
      n.style.cssText = 'width:88px;flex:none';
      const p = document.createElement('textarea');
      p.className = 'ai-lbl-prompts';
      p.rows = 2;
      p.placeholder = '每行一条英文提示词';
      p.value = (prompts || []).join('\n');
      p.style.cssText = 'flex:1;min-height:44px;resize:vertical';
      const del = document.createElement('button');
      del.className = 'btn-small ai-lbl-del';
      del.textContent = '✕';
      del.style.flex = 'none';
      del.onclick = () => row.remove();
      row.appendChild(n); row.appendChild(p); row.appendChild(del);
      return row;
    };
    const aiLblRender = (d) => {
      if (!aiAlive()) return;
      const list = document.getElementById('ai-lbl-list');
      if (!list) return;
      list.textContent = '';
      for (const l of (d.labels || [])) list.appendChild(aiLblRow(l.name, l.prompts));
      const srcEl = document.getElementById('ai-lbl-src');
      if (srcEl) {
        srcEl.textContent = (d.custom ? '自定义词表' : '内置默认词表') + `（生效 ${(d.active || []).length} 类）`
          + ((d.textModel && !d.textModel.installed) ? ' · 改词表需先下载词表模型' : '');
      }
      const hint = document.getElementById('ai-lbl-hint');
      if (hint) {
        hint.textContent = `提示词用英文（模型只认英文）。改动后点「保存并应用」→ 文字向量秒级重算；再点「按词表重新分类」把已建向量的 ${d.reclassable || 0} 张刷成新分类，不用重跑图片模型。人工打过的标签不会被改动。`;
      }
    };
    const aiLblLoad = async () => {
      try { aiLblRender(await api('/api/ai/labels')); } catch { /* 未部署时静默 */ }
    };
    aiLblLoad();
    const aiLblAdd = document.getElementById('ai-lbl-add');
    if (aiLblAdd) aiLblAdd.onclick = () => {
      const list = document.getElementById('ai-lbl-list');
      if (list) list.appendChild(aiLblRow('', []));
    };
    const aiLblSave = document.getElementById('ai-lbl-save');
    if (aiLblSave) aiLblSave.onclick = async () => {
      const labels = [...document.querySelectorAll('.ai-lbl-row')].map((r) => ({
        name: (r.querySelector('.ai-lbl-name').value || '').trim(),
        prompts: r.querySelector('.ai-lbl-prompts').value.split('\n').map((x) => x.trim()).filter(Boolean),
      })).filter((l) => l.name && l.prompts.length);
      if (labels.length < 2) { toast('至少要有 2 个分类，且每类都要填名称和提示词'); return; }
      aiLblSave.disabled = true;
      try {
        const r = await api('/api/ai/labels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ labels }) });
        if (r.error) toast(r.error);
        else {
          toast('词表已生效（' + (r.labels || []).join('/') + '）。点「按词表重新分类」刷新已有照片', 6000);
          aiLblLoad(); aiPoll();
        }
      } catch (e) { toast('保存失败：' + e.message); }
      aiLblSave.disabled = false;
    };
    const aiLblReset = document.getElementById('ai-lbl-reset');
    if (aiLblReset) aiLblReset.onclick = async () => {
      try {
        const r = await api('/api/ai/labels/reset', { method: 'POST' });
        if (r.error) toast(r.error);
        else { toast('已恢复内置默认词表（点「按词表重新分类」生效到已有照片）', 5000); aiLblLoad(); aiPoll(); }
      } catch (e) { toast('恢复失败：' + e.message); }
    };
    const aiLblReclass = document.getElementById('ai-lbl-reclass');
    if (aiLblReclass) aiLblReclass.onclick = async () => {
      aiLblReclass.disabled = true;
      try {
        const r = await api('/api/ai/reclass', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (r.error) toast(r.error);
        else { toast('开始按当前词表重新分类 ' + (r.total || 0) + ' 张', 4000); if (!aiTimer) aiTimer = setInterval(aiPoll, 1000); }
      } catch (e) { toast('启动失败：' + e.message); }
      aiLblReclass.disabled = false;
    };
  }
}

/* ---------------- 扫描轮询 ---------------- */
let scanPoll = null;
function watchScan() {
  $scanBar.classList.remove('hidden');
  if (scanPoll) return;
  scanPoll = setInterval(async () => {
    let st;
    try { st = await api('/api/scan/status'); } catch { return; }
    const last = st.events[st.events.length - 1];
    $scanBar.textContent = last ? (last.message || last.phase) : '扫描中…';
    if (!st.running) {
      clearInterval(scanPoll); scanPoll = null;
      setTimeout(() => $scanBar.classList.add('hidden'), 2500);
      // eu：扫描可能新增/变更内容，页面缓存全部作废，route() 全量重拉（避免新片 30 分钟内不出现）
      HOME_CACHE = null;
      Object.keys(PAGE_CACHE).forEach((k) => delete PAGE_CACHE[k]);
      const h = location.hash;
      if (h.startsWith('#/home') || h.startsWith('#/movies') || h === '#/series' || h === '#/all') route();
    }
  }, 1500);
}
/* 手动全库扫描入口已统一收进设置页「一键全系统扫描」（scanFullBtn），顶部不再放按钮 */

/* ---------------- AI 助理（搜索框 ✨ 模式） ---------------- */
const AI_HISTORY = []; // 会话内多轮上下文
async function renderAi(q0) {
  $app.innerHTML = `<div class="page"><div class="page-head"><div class="page-title">✨ AI 助理</div><span style="color:var(--text-dim);font-size:13px">用大白话问库里的内容</span></div>
    <div class="alist-panel" id="ai-panel"><div class="alist-status">AI 正在库里找…</div></div>
    <div class="fk-alb-grid" id="ai-grid" style="margin-top:14px"></div></div>`;
  const panel = document.getElementById('ai-panel');
  const grid = document.getElementById('ai-grid');

  function askAndRender(q) {
    panel.innerHTML = '<div class="alist-status">AI 正在库里找…</div>';
    grid.innerHTML = '';
    api('/api/assistant/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q, history: AI_HISTORY }) })
      .then((r) => { AI_HISTORY.push({ role: 'user', text: q }, { role: 'assistant', text: r.reply || '' }); draw(r); })
      .catch(async (e) => {
        panel.innerHTML = '<div class="alist-status">❌ ' + esc(e.message || 'AI 助理不可用') + '</div>';
      });
  }

  function draw(r) {
    let html = '<div class="alist-status"><b>' + esc(r.reply || '') + '</b></div>';
    // 危险操作确认卡
    for (const p of (r.proposals || [])) {
      html += '<div class="alist-panel" style="margin-top:10px;border-color:var(--accent,#e5484d)"><div class="alist-status">⚠️ 需要你确认：' + esc(p.text || '') + '</div>' +
        '<div class="add-root" style="margin-top:8px"><button class="btn-accent" data-ai-confirm="' + esc(p.tool) + '" data-ai-args="' + esc(JSON.stringify(p.args || {})) + '">确认执行</button></div></div>';
    }
    panel.innerHTML = html;
    panel.querySelectorAll('[data-ai-confirm]').forEach((b) => {
      b.onclick = async () => {
        const tool = b.getAttribute('data-ai-confirm');
        let args = {}; try { args = JSON.parse(b.getAttribute('data-ai-args') || '{}'); } catch {}
        b.disabled = true; b.textContent = '执行中…';
        try {
          const r2 = await api('/api/assistant/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, args }) });
          toast(r2 && r2.ok ? '✅ 已执行' : '执行完成', 3000);
          b.textContent = '✅ 已执行';
        } catch (e) { toast('执行失败：' + e.message, 4000); b.disabled = false; b.textContent = '重试'; }
      };
    });
    const items = r.results || [];
    grid.innerHTML = items.length ? items.map((x) => aiCardHtml(x)).join('')
      : '<div class="empty-hint" style="grid-column:1/-1">没有匹配结果 —— 换个说法试试，比如「找海边的照片」「周星驰的电影」「库里有多少部电影」</div>';
  }

  // 追问框
  const follow = document.createElement('div');
  follow.className = 'add-root';
  follow.style.marginTop = '14px';
  follow.innerHTML = '<input id="ai-follow" type="text" placeholder="继续问（比如「只要 2020 年以后的」「换周星驰的」）" style="flex:1;min-width:220px">' +
    '<button class="btn-accent" id="ai-follow-go">追问</button>';
  grid.parentNode.appendChild(follow);
  const go = () => {
    const v = (document.getElementById('ai-follow').value || '').trim();
    if (v) { document.getElementById('ai-follow').value = ''; askAndRender(v); }
  };
  document.getElementById('ai-follow-go').onclick = go;
  document.getElementById('ai-follow').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

  askAndRender(q0);
}
function aiCardHtml(x) {
  const poster = x.poster ? '<img src="' + esc(x.poster) + '" alt="" loading="lazy">' : '<div style="height:100%;display:flex;align-items:center;justify-content:center;font-size:28px;opacity:.5">' + (x.kind === 'music' ? '🎵' : x.kind === 'book' ? '📖' : x.kind === 'channel' ? '📺' : x.kind === 'stat' ? '📊' : '🖼️') + '</div>';
  return '<a class="fk-alb" href="' + esc(x.url || '#') + '" style="text-decoration:none;color:var(--text,#e8eaed)">' +
    '<div style="aspect-ratio:1;overflow:hidden;background:var(--card,#1a1a1a);border-radius:10px">' + poster + '</div>' +
    '<div style="margin-top:6px;font-size:13px;line-height:1.35">' + esc(x.title || '') + '</div>' +
    (x.sub ? '<div style="font-size:12px;opacity:.6;margin-top:2px">' + esc(x.sub) + '</div>' : '') + '</a>';
}

/* ---------------- 搜索 ---------------- */
/* AI 模式：胶囊搜索框内「Ai搜索」开关；回车 / 红色按钮按 AI_MODE 路由到 #/ai/ 或 #/search/ */
let AI_MODE = true; // 默认开启 AI 搜索；点开关可切回普通搜索
(function aiToggle() {
  const capsule = document.getElementById('search-capsule');
  if (!$search || !capsule) return;
  const btn = document.createElement('button');
  btn.id = 'ai-mode-btn';
  btn.type = 'button';
  btn.className = 'ai-switch';
  btn.textContent = 'Ai搜索';
  const go = document.getElementById('search-go');
  capsule.insertBefore(btn, go);
  const AI_PH = '问 AI：找去年海边的照片 / 周星驰的喜剧 / 库里有多少电影';
  const sync = () => {
    btn.classList.toggle('on', AI_MODE);
    btn.title = AI_MODE ? 'AI 模式已开 — 再点一次回到普通搜索' : '切换到 AI 搜索';
    $search.placeholder = AI_MODE ? AI_PH : '搜索全部内容：影片 / 音乐 / 图书';
  };
  btn.onclick = () => {
    AI_MODE = !AI_MODE;
    sync();
    if (AI_MODE) $search.focus();
    else { updateSearchCtx(location.hash); if ($search.value.trim()) location.hash = '#/search/' + encodeURIComponent($search.value.trim()); }
  };
  if (go) go.onclick = () => {
    const q = $search.value.trim();
    if (q) location.hash = AI_MODE ? `#/ai/${encodeURIComponent(q)}` : `#/search/${encodeURIComponent(q)}`;
    else $search.focus();
  };
  sync();
})();
let searchTimer = null;
$search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = $search.value.trim();
    if (q) location.hash = AI_MODE ? `#/ai/${encodeURIComponent(q)}` : `#/search/${encodeURIComponent(q)}`;
    else route();
  }, 350);
});
$search.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = $search.value.trim();
  if (q) { clearTimeout(searchTimer); location.hash = AI_MODE ? `#/ai/${encodeURIComponent(q)}` : `#/search/${encodeURIComponent(q)}`; }
});

// 搜索上下文：跟着当前页面走——音乐中心页只搜音乐、书架页只搜图书、
// 影视相关页只搜影片，首页/其他页面搜全部内容
let SEARCH_CTX = 'all';
function updateSearchCtx(h) {
  // 搜索结果页内继续改关键词：保持进入搜索前的上下文不变
  if (h.startsWith('#/search/')) return;
  SEARCH_CTX =
    h.startsWith('#/music') ? 'music'
    : (h.startsWith('#/books') || h.startsWith('#/book')) ? 'books'
    : (h.startsWith('#/movies') || h.startsWith('#/series') || h.startsWith('#/media')
      || h.startsWith('#/all') || h.startsWith('#/online') || h.startsWith('#/detail')
      || h.startsWith('#/continue') || h.startsWith('#/ltvplay')) ? 'media'
    : 'all';
  $search.placeholder =
    SEARCH_CTX === 'music' ? '搜索音乐：歌曲 / 歌手 / 专辑'
    : SEARCH_CTX === 'books' ? '搜索图书：书名 / 作者'
    : SEARCH_CTX === 'media' ? '搜索影片'
    : '搜索全部内容：影片 / 音乐 / 图书';
}

const _kwHit = (kw, ...vals) => vals.some((v) => String(v || '').toLowerCase().includes(kw));

/* ---- 台词搜索分区(P1 字幕全文检索)+ 时间戳跳播 helpers ---- */
const fmtSubClock = (s) => {
  s = Math.max(0, Math.round(Number(s) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
           : `${m}:${String(sec).padStart(2, '0')}`;
};
/* 命中词高亮:所有查询词一次组合替换(先 esc 原句再高亮,避免二次包裹) */
function subHitHighlight(text, q) {
  const toks = String(q || '').trim().split(/[\s,，、。.；;：:!！?？/\\|()（）\[\]【】"'「」『』]+/).filter(Boolean).slice(0, 4);
  const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const safe = esc(String(text || ''));
  if (!toks.length) return safe;
  try {
    return safe.replace(new RegExp('(' + toks.map(escRe).join('|') + ')', 'gi'), '<mark>$1</mark>');
  } catch { return safe; }
}
/* 台词命中 section(hits 空返回 '');sub = /api/subsearch 响应 */
function subHitsSectionHtml(q, sub) {
  const hits = (sub && sub.hits) || [];
  if (!hits.length) return '';
  return `<section class="row"><div class="row-head"><div class="row-title">🎤 台词命中</div><span class="row-more">来自字幕全文索引</span></div>
    <div class="sub-hits">${hits.map((h) => `
      <div class="sub-hit" data-mid="${h.media_id}" data-t="${h.start_s}">
        ${h.poster ? `<img class="sh-poster" loading="lazy" src="/poster/${encodeURIComponent(h.poster)}" alt="" onerror="this.style.visibility='hidden'">` : '<div class="sh-poster sh-noimg">🎬</div>'}
        <div class="sh-main">
          <div class="sh-line">${subHitHighlight(h.text, q)}</div>
          <div class="sh-meta"><span class="sh-title">${esc(h.title || '')}${h.sub ? ' <b>' + esc(h.sub) + '</b>' : ''}</span>
            <span class="sh-jump">▶ ${fmtSubClock(h.start_s)} 跳播</span></div>
        </div>
      </div>`).join('')}</div></section>`;
}
function bindSubHits(root) {
  if (!root) return;
  root.querySelectorAll('.sub-hit').forEach((el) => {
    el.onclick = () => playNav(`#/play/${el.dataset.mid}?t=${el.dataset.t}`);
  });
}

async function renderSearch(q) {
  if (SEARCH_CTX === 'music') return renderSearchMusic(q);
  if (SEARCH_CTX === 'books') return renderSearchBooks(q);
  if (SEARCH_CTX === 'media') return renderSearchMedia(q);
  return renderSearchAll(q);
}

// 影片搜索：标题匹配 + 台词命中（字幕全文索引，带时间戳跳播）
async function renderSearchMedia(q) {
  $app.innerHTML = '<div class="page"><div class="page-head"><div class="page-title"></div></div><div class="grid"></div><div id="srch-sub"></div></div>';
  $app.querySelector('.page-title').textContent = `搜索「${q}」`;
  const [rows, sub] = await Promise.all([
    api(`/api/media?q=${encodeURIComponent(q)}&limit=200`),
    api(`/api/subsearch?q=${encodeURIComponent(q)}&limit=24`).catch(() => null),
  ]);
  const grid = $app.querySelector('.grid');
  if (!grid) return; // 页面已被更新的路由替换（并发导航保护）
  grid.innerHTML = rows.length ? rows.map((m) => cardHtml(m)).join('')
    : '<div class="empty-hint" style="grid-column:1/-1">没有找到匹配的影片</div>';
  const box = document.getElementById('srch-sub');
  if (!box) return;
  box.innerHTML = subHitsSectionHtml(q, sub);
  bindSubHits(box);
}

// 音乐搜索：歌名/歌手/专辑，结果可直接点播
async function renderSearchMusic(q) {
  musicRestore();
  const res = await api('/api/music/tracks').catch(() => ({ tracks: [] }));
  const pool = res.tracks || [];
  const kw = q.toLowerCase();
  const tracks = pool.filter((t) => _kwHit(kw, t.title, t.artist, t.album));
  const nav = await musicNavData();
  const side = musicSideHtml(nav, '#/music');
  $app.innerHTML = `
    <div class="mu-page">${side}<section class="mu-main">
      <a class="back-link" data-back="1">‹ 返回</a>
      <div class="page-head"><div class="page-title">搜索「${esc(q)}」· 音乐</div></div>
      ${tracks.length ? `<div style="margin-bottom:14px"><button id="mu-play-all" class="btn-accent" style="padding:9px 22px;font-size:14px">▶ 播放全部 ${tracks.length} 首</button></div>
      <div class="mu-list">
        <div class="mu-row mu-row-head"><span class="t-idx">#</span><span>歌曲</span><span>歌手</span><span>专辑</span><span>时长</span></div>
        ${tracks.map((t, i) => musicRowHtml(t, i)).join('')}
      </div>` : '<div class="empty-hint">没有找到匹配的歌曲</div>'}
    </section></div>`;
  const pa = document.getElementById('mu-play-all');
  if (pa) pa.onclick = () => musicPlayQueue(tracks, 0);
  bindMusicRows(document.getElementById('app'), () => tracks);
  bindMusicManage(document.getElementById('app'));
}

// 图书搜索：书名/作者
async function renderSearchBooks(q) {
  let data;
  try { data = await api('/api/books'); }
  catch (e) { $app.innerHTML = `<div class="empty-hint">书架加载失败：${esc(e.message)}</div>`; return; }
  const pool = data.books || [];
  const kw = q.toLowerCase();
  const books = pool.filter((b) => _kwHit(kw, b.title, bkAuthor(b)));
  $app.innerHTML = `
    <div class="mu-page"><section class="mu-main">
      <a class="back-link" data-go="#/books">‹ 返回书架</a>
      <div class="page-head"><div class="page-title">搜索「${esc(q)}」· 图书</div></div>
      ${books.length ? `<div class="mu-albums">${books.map((b) => `
        <div class="bk-book" data-go="#/book/${b.id}" title="${esc(b.title)}">
          <div class="bk-cover-wrap"><img class="bk-cover" src="${bkCover(b)}" alt="" loading="lazy" /></div>
          <div class="bk-name">${esc(b.title)}</div>
          <div class="bk-sub">${esc(bkAuthorDisp(b))} · ${(b.format || '').toUpperCase()}</div>
        </div>`).join('')}</div>` : '<div class="empty-hint">没有找到匹配的图书</div>'}
    </section></div>`;
}

// 全部内容搜索：影片 + 音乐 + 图书三个区块
async function renderSearchAll(q) {
  $app.innerHTML = '<div class="page"><div class="page-head"><div class="page-title"></div></div><div class="grid" id="srch-media"></div><div id="srch-rest"></div></div>';
  $app.querySelector('.page-title').textContent = `搜索「${q}」`;
  const grid = $app.querySelector('#srch-media');
  const rest = $app.querySelector('#srch-rest');
  const kw = q.toLowerCase();
  const rows = await api(`/api/media?q=${encodeURIComponent(q)}&limit=200`).catch(() => []);
  if (!grid || !rest) return; // 页面已被更新的路由替换
  grid.innerHTML = rows.map((m) => cardHtml(m)).join('');
  const [mRes, bRes, sub] = await Promise.all([
    api('/api/music/tracks').catch(() => ({ tracks: [] })),
    api('/api/books').catch(() => ({ books: [] })),
    api(`/api/subsearch?q=${encodeURIComponent(q)}&limit=18`).catch(() => null),
  ]);
  if (!rest) return;
  const tracks = (mRes.tracks || []).filter((t) => _kwHit(kw, t.title, t.artist, t.album)).slice(0, 8);
  const books = (bRes.books || []).filter((b) => _kwHit(kw, b.title, bkAuthor(b))).slice(0, 12);
  const subHitsN = ((sub && sub.hits) || []).length;
  rest.innerHTML = `
    ${!rows.length && !tracks.length && !books.length && !subHitsN ? '<div class="empty-hint" style="grid-column:1/-1">没有找到匹配的内容</div>' : ''}
    ${subHitsSectionHtml(q, sub)}
    ${tracks.length ? `<section class="row"><div class="row-head"><div class="row-title">🎵 音乐</div><a class="row-more" data-go="#/music">音乐中心 ›</a></div>
      <div class="mu-list">${tracks.map((t, i) => musicRowHtml(t, i)).join('')}</div></section>` : ''}
    ${books.length ? `<section class="row"><div class="row-head"><div class="row-title">📚 图书</div><a class="row-more" data-go="#/books">书架 ›</a></div>
      <div class="mu-albums">${books.map((b) => `
        <div class="bk-book" data-go="#/book/${b.id}" title="${esc(b.title)}">
          <div class="bk-cover-wrap"><img class="bk-cover" src="${bkCover(b)}" alt="" loading="lazy" /></div>
          <div class="bk-name">${esc(b.title)}</div>
          <div class="bk-sub">${esc(bkAuthorDisp(b))} · ${(b.format || '').toUpperCase()}</div>
        </div>`).join('')}</div></section>` : ''}`;
  if (tracks.length) bindMusicRows(rest, () => tracks);
  bindSubHits(rest);
}

/* ---------------- 界面模式 ---------------- */
// full   = 完整版：在线观看（在线电影 / 在线剧集）+ 电视直播
// livetv = 精简版：只保留电视直播（客户交付包用，由服务端 HMP_UI_MODE 决定）
let UI_MODE = 'full';
async function initUiMode() {
  try {
    const s = await api('/api/settings');
    UI_MODE = (s && s.uiMode) || 'full';
  } catch { /* 读不到就按完整版渲染，不影响可用性 */ }
  if (UI_MODE !== 'livetv') return;
  // 「影视中心 ▾」下拉 → 直链「电视直播」；其余下拉（在线观看）在精简版里隐藏
  const wraps = document.querySelectorAll('.nav-drop-wrap');
  if (wraps.length) wraps[0].innerHTML = '<a href="#/online/live" data-nav>电视直播</a>';
  for (let i = 1; i < wraps.length; i++) wraps[i].remove();
}

/* ---------------- 相册 ---------------- */
const FILM_FILTERS = [
  { name: '原图', css: '' },
  { name: '鲜活标准', css: 'saturate(1.15) contrast(1.05) brightness(1.02)' },
  { name: '浓郁风光', css: 'saturate(1.5) contrast(1.15) hue-rotate(-5deg)' },
  { name: '细腻人像', css: 'saturate(1.08) contrast(0.98) brightness(1.05) sepia(0.08)' },
  { name: '经典负片', css: 'sepia(0.25) saturate(1.1) contrast(1.12) hue-rotate(-8deg) brightness(0.98)' },
  { name: '纪实标准', css: 'sepia(0.15) saturate(0.85) contrast(1.1)' },
  { name: '电影感', css: 'saturate(0.82) contrast(1.05) sepia(0.12) brightness(1.02)' },
  { name: '黑白胶片', css: 'grayscale(1) contrast(1.12) brightness(1.03)' },
  { name: '黑白红滤', css: 'grayscale(1) contrast(1.2) brightness(1.06) sepia(0.06)' },
  { name: '复古棕', css: 'sepia(0.6) saturate(1.2) contrast(1.02)' },
];
const photoThumb = (it) => `/api/photos/thumb/${it.id}`;
const photoFull = (it) => `/api/photos/img/${it.id}`;
const libThumb = (it) => `/api/photos/libthumb/${it.id}?v=2`; // v2=960px 高清（eh）
const libFull = (it) => `/api/photos/libimg/${it.id}`;
// RAW 相机文件（NEF/ARW/CR2/CR3/DNG/RAF…）：显示走相机内嵌 JPEG 预览
const RAW_EXTS = new Set(['nef', 'nrw', 'cr2', 'cr3', 'crw', 'arw', 'srf', 'sr2', 'dng',
  'raf', 'orf', 'rw2', 'raw', 'pef', 'srw', 'x3f', '3fr', 'fff', 'iiq', 'mrw', 'rwl', 'kdc', 'dcr', 'erf', 'mef']);
const isRawExt = (ext) => RAW_EXTS.has(String(ext || '').replace(/^\./, '').toLowerCase());

// NAS 相册内页（目录扫描来的照片）
async function renderLibAlbum(album, openId) {
  let items;
  try {
    const r = await api('/api/photos/lib?album=' + encodeURIComponent(album));
    items = r.items || [];
  } catch (e) { $app.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`; return; }

  let selMode = false;
  const sel = new Set();
  $app.innerHTML = `
  <div class="ph-head">
    <div class="row-title">📁 ${esc(album)} <span class="ph-count">${items.length} 张</span></div>
    <div class="ph-actions">
      ${items.length ? '<button class="btn-ghost" id="ph-sel-toggle">选择照片</button>' : ''}
      <button class="btn-ghost" id="ph-lib-back">‹ 返回相册</button>
    </div>
  </div>
  ${items.length ? `<div class="ph-sel-bar hidden" id="ph-sel-bar">
    <button class="btn-accent" id="ph-sel-del">删除选中（0）</button>
    <button class="btn-ghost" id="ph-sel-all">全选</button>
    <button class="btn-ghost" id="ph-sel-cancel">取消选择</button>
  </div>` : ''}
  ${items.length ? `<div class="ph-grid">${items.map((it, i) => `
    <div class="ph-cell" data-i="${i}" data-id="${it.id}" data-phv="${it.id}" data-phv-ar="${it.w && it.h ? (it.w / it.h).toFixed(3) : ''}" data-phv-name="${esc(it.taken_at || it.name || '')}"><img loading="lazy" src="${libThumb(it)}" alt=""><span class="ph-check"></span>${isRawExt(it.ext) ? '<span class="fk-raw">RAW</span>' : ''}</div>`).join('')}</div>`
    : `<div class="empty-hint">这个相册还没有照片。往相册目录里加入新照片后，服务端会自动巡检入库；也可到 <a class="mu-side-link" data-go="#/library">设置</a> 立即扫描。</div>`}`;

  playFadeOut(); // eb：fadeNav 渐变进来，骨架已画好就揭开（无渐变层时是无害 no-op）

  document.getElementById('ph-lib-back').onclick = () => { location.hash = '#/photos'; };

  const grid = $app.querySelector('.ph-grid');
  const updSel = () => {
    const sb = document.getElementById('ph-sel-bar');
    if (sb) sb.classList.toggle('hidden', !selMode);
    // 与照片墙主 tab 一致：选择模式下操作条固定钉在顶栏下方
    document.body.classList.toggle('ph-selmode', selMode);
    if (selMode && sb) requestAnimationFrame(() => { $app.style.paddingTop = Math.ceil(sb.getBoundingClientRect().height + 8) + 'px'; });
    else $app.style.paddingTop = '';
    const delBtn = document.getElementById('ph-sel-del');
    if (delBtn) delBtn.textContent = `删除选中（${sel.size}）`;
    const tg = document.getElementById('ph-sel-toggle');
    if (tg) tg.textContent = selMode ? '退出选择' : '选择照片';
    if (grid) grid.classList.toggle('ph-sel-mode', selMode);
    $app.querySelectorAll('.ph-cell').forEach((c) => c.classList.toggle('sel-on', selMode && sel.has(Number(c.dataset.i))));
  };
  // 灯箱里删除单张后：同步摘掉列表格子并重排 data-i（否则返回列表仍看到已删照片、点击索引错位）
  const removeCell = (it) => {
    const cell = $app.querySelector(`.ph-cell[data-id="${it.id}"]`);
    if (cell) cell.remove();
    selMode = false; sel.clear();
    const g = $app.querySelector('.ph-grid');
    if (g) g.querySelectorAll('.ph-cell').forEach((c, k) => { c.dataset.i = k; c.classList.remove('sel-on'); });
    updSel();
    const cnt = $app.querySelector('.ph-count');
    if (cnt) cnt.textContent = `${items.length} 张`;
  };
  const selToggle = document.getElementById('ph-sel-toggle');
  if (selToggle) selToggle.onclick = () => { selMode = !selMode; sel.clear(); updSel(); };
  const selAll = document.getElementById('ph-sel-all');
  if (selAll) selAll.onclick = () => { items.forEach((_, i) => sel.add(i)); updSel(); };
  const selCancel = document.getElementById('ph-sel-cancel');
  if (selCancel) selCancel.onclick = () => { selMode = false; sel.clear(); updSel(); };
  const selDel = document.getElementById('ph-sel-del');
  if (selDel) selDel.onclick = async () => {
    if (!sel.size) return toast('先勾选要删除的照片');
    if (!confirm(`⚠️ 确定删除选中的 ${sel.size} 张照片？\nNAS 里的原文件会一并删除，不可恢复！`)) return;
    const ids = [...sel].map((i) => items[i].id);
    try {
      const r = await api('/api/photos/lib/delete-many', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      const nd = (r.dirsRemoved || []).length;
      toast(nd ? `已删除 ${r.removed} 张照片，并自动清理了 ${nd} 个空文件夹` : `已删除 ${r.removed} 张照片`);
      if (nd) return renderPhotos(true);      // 相册已不存在 → 回相册列表（数据已变，绕过缓存）
      renderLibAlbum(album);
    } catch (e) { toast('删除失败：' + e.message); }
  };

  // 灯箱：复用通用查看器（胶片滤镜 + 微调 + 保存到「渲染出片」）；选择模式下点格子=勾选
  $app.querySelectorAll('.ph-cell').forEach((cell) => {
    cell.onclick = () => {
      const i = parseInt(cell.dataset.i, 10);
      if (selMode) {
        if (sel.has(i)) sel.delete(i); else sel.add(i);
        updSel();
        return;
      }
      openViewer(items, i, { thumb: libThumb, full: libFull, info: true, del: true, delApi: (it) => '/api/photos/lib/' + it.id, onDeleted: removeCell, onAllDeleted: () => renderLibAlbum(album) });
    };
  });

  // 首页缩略图直达：带 ?ph=<照片id> 时自动定位并打开那张照片
  // 关闭（✕/Esc/点空白）后直接回照片主页 —— 相册内页没有「渲染出片/上传照片」工具条，
  // 停在这里会让用户觉得顶部工具按钮丢了；exitTo 由 openViewer 的 close() 负责跳转
  if (openId) {
    const oi = items.findIndex((x) => x.id === Number(openId));
    if (oi >= 0) {
      openViewer(items, oi, { thumb: libThumb, full: libFull, info: true, del: true, delApi: (it) => '/api/photos/lib/' + it.id, onDeleted: removeCell, onAllDeleted: () => renderLibAlbum(album), exitTo: '#/photos' });
      const cell = $app.querySelector(`.ph-cell[data-id="${openId}"]`);
      if (cell) cell.scrollIntoView({ block: 'center' });
    }
  }
}

/* ---------- 灯箱 + 胶片条 + 滤镜（通用：上传相册 / 渲染出片 / NAS 相册库共用） ---------- */
function openViewer(items, idx, opts = {}) {
    const thumbOf = opts.thumb || photoThumb;
    const fullOf = opts.full || photoFull;
    const canDel = opts.del !== false;
    let cur = idx;
    const adj = { b: 100, c: 100, s: 100 }; // 亮度/对比/饱和
    let preset = FILM_FILTERS[0];
    const rots = new Map(); // 每张照片的旋转角（看图会话内记忆）
    let rot = 0;

    const ov = document.createElement('div');
    ov.className = 'ph-viewer';
    ov.innerHTML = `
      <div class="ph-vb-top">
        <span class="ph-vb-left">
          <button class="btn-ghost" id="ph-bk-all" title="返回全部相片（Esc 也可关闭）">‹ 全部相片</button>
          <span class="ph-vb-name"></span>
        </span>
        <span class="ph-vb-actions">
          <span class="ph-vb-zoom">
            <button class="btn-ghost" id="ph-zoom-out" title="缩小（点击照片还原 / 滚轮 / 减号）">−</button>
            <button class="btn-ghost" id="ph-zoom-n" title="点击恢复适应窗口">100%</button>
            <button class="btn-ghost" id="ph-zoom-in" title="放大（点击照片 / 滚轮 / 加号）">＋</button>
          </span>
          <button class="btn-ghost" id="ph-rot-l" title="向左旋转 90°">⟲</button>
          <button class="btn-ghost" id="ph-rot-r" title="向右旋转 90°">⟳</button>
          ${opts.info ? '<button class="btn-ghost" id="ph-tag-btn" title="给这张照片打分类标签，系统按标签自动归类显示">🏷 标签</button>' : ''}
          ${opts.info ? '<button class="btn-ghost" id="ph-info-btn" title="查看照片详情（i）">ⓘ 详情</button>' : ''}
          <button class="btn-ghost" id="ph-save">保存到「渲染出片」</button>
          ${canDel ? '<button class="btn-ghost" id="ph-del" title="删除这张照片">删除</button>' : ''}
          <button class="btn-ghost" id="ph-close">✕ 关闭</button>
        </span>
      </div>
      <div class="ph-vb-stage"><img id="ph-vb-img" alt="" draggable="false"></div>
      ${items.length > 1 ? `<button class="ph-nav ph-nav-l" id="ph-nav-l" title="上一张（←）">‹</button><button class="ph-nav ph-nav-r" id="ph-nav-r" title="下一张（→）">›</button>` : ''}
      <div class="ph-vb-side">
        <div class="ph-vb-side-title">胶片模拟</div>
        <div class="ph-films">${FILM_FILTERS.map((f, i) => `
          <button class="ph-film${i === 0 ? ' on' : ''}" data-fi="${i}">${esc(f.name)}</button>`).join('')}
        </div>
        <div class="ph-vb-side-title">微调</div>
        <label>亮度 <input type="range" id="adj-b" min="60" max="140" value="100"></label>
        <label>对比 <input type="range" id="adj-c" min="60" max="140" value="100"></label>
        <label>饱和 <input type="range" id="adj-s" min="0" max="200" value="100"></label>
      </div>
      <div class="ph-info hidden" id="ph-info-panel">
        <div class="ph-info-head"><span>照片详情</span><button class="btn-ghost" id="ph-info-close">✕</button></div>
        <div id="ph-info-body"><div class="empty-hint">读取中…</div></div>
      </div>
      <div class="ph-filmstrip"><div class="ph-strip-row">
        ${items.map((it, i) => `<img class="ph-strip${i === idx ? ' on' : ''}" data-i="${i}" loading="lazy" src="${thumbOf(it)}" alt="">`).join('')}
      </div></div>`;
    document.body.appendChild(ov);
    document.body.style.overflow = 'hidden';

    const img = ov.querySelector('#ph-vb-img');
    const strip = Array.from(ov.querySelectorAll('.ph-strip'));
    const stage = ov.querySelector('.ph-vb-stage');
    const zLabel = ov.querySelector('#ph-zoom-n');

    /* ---- 缩放 / 平移（每张独立记忆） ---- */
    const zooms = new Map();
    const ZMIN = 1, ZMAX = 8;
    let zs = 1, zx = 0, zy = 0, drag = null, dragMoved = false, lastDbl = 0;

    function cssFilter() {
      const extra = `brightness(${adj.b / 100}) contrast(${adj.c / 100}) saturate(${adj.s / 100})`;
      return (preset.css ? preset.css + ' ' : '') + extra;
    }
    function applyRot() {
      // translate 在屏幕坐标系、rotate/scale 绕元素中心，书写顺序不可调换
      img.style.transform = `translate(${zx}px, ${zy}px) scale(${zs}) rotate(${rot}deg)`;
      // 旋转 90°/270° 时把横竖占位互换，避免图溢出舞台
      img.style.maxWidth = ((rot % 180 !== 0) ? '72vh' : '');
      img.style.maxHeight = ((rot % 180 !== 0) ? '72vw' : '');
      if (zLabel) zLabel.textContent = Math.round(zs * 100) + '%';
      stage.style.cursor = zs > 1.01 ? (drag ? 'grabbing' : 'grab') : 'zoom-in';
    }
    function clampPan() {
      if (zs <= 1.01) { zx = 0; zy = 0; return; }
      const r = stage.getBoundingClientRect();
      const iw = img.clientWidth || 1, ih = img.clientHeight || 1;
      const mx = Math.max(0, (iw * zs - r.width) / 2);
      const my = Math.max(0, (ih * zs - r.height) / 2);
      zx = Math.max(-mx, Math.min(mx, zx));
      zy = Math.max(-my, Math.min(my, zy));
    }
    function saveZoom() { if (zs > 1.01) zooms.set(cur, { s: zs, x: zx, y: zy }); else zooms.delete(cur); }
    function setZoom(target, cx, cy) {
      const to = Math.max(ZMIN, Math.min(ZMAX, target));
      if (Math.abs(to - zs) < 1e-4) return;
      const r = stage.getBoundingClientRect();
      const px = (cx == null ? r.left + r.width / 2 : cx) - r.left - r.width / 2;
      const py = (cy == null ? r.top + r.height / 2 : cy) - r.top - r.height / 2;
      const f = to / zs;
      zx = px - f * (px - zx);
      zy = py - f * (py - zy);
      zs = to;
      clampPan(); applyRot(); saveZoom();
    }
    function resetZoom() { zs = 1; zx = 0; zy = 0; zooms.delete(cur); applyRot(); }
    function show(i) {
      cur = (i + items.length) % items.length;
      rot = rots.get(cur) || 0;
      const z = zooms.get(cur);
      zs = z ? z.s : 1; zx = z ? z.x : 0; zy = z ? z.y : 0;
      img.src = fullOf(items[cur]);
      img.style.filter = cssFilter();
      applyRot();
      const it = items[cur];
      ov.querySelector('.ph-vb-name').textContent = it.filter
        ? `${it.filter} · 渲染出片`
        : `${cur + 1} / ${items.length}${it.name ? ' · ' + it.name : ''}`;
      strip.forEach((s, k) => s.classList.toggle('on', k === cur));
      strip[cur] && strip[cur].scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
      const ip = ov.querySelector('#ph-info-panel');   // 直接查 DOM：infoEl 的 const 在后面才初始化
      if (ip && !ip.classList.contains('hidden')) loadInfo();
      const tb = ov.querySelector('#ph-tag-bar');       // 标签条必须跟随当前照片：不重建则按钮仍指着上一张
      if (tb && typeof renderTagBar === 'function') renderTagBar(tb);
    }
    function refresh() { img.style.filter = cssFilter(); applyRot(); }

    show(cur);
    ov.querySelector('#ph-close').onclick = close;
    ov.querySelector('#ph-bk-all').onclick = () => {
      close(true);
      if (location.hash === '#/photos') {          // 已在照片主页：重置到「所有相片」并刷新
        PH.tab = 'all'; PH.view = null; PH.cat = ''; PH.dtype = ''; PH.date = '';
        PH.sel.clear(); PH.selMode = false;
        renderPhotos(true); // 会话里可能删过照片：绕过缓存重取
      } else { location.hash = '#/photos'; }       // 相册内页/回忆等：跳回照片主页（路由会重置为所有相片）
    };
    ov.querySelector('#ph-rot-l').onclick = () => { rot -= 90; rots.set(cur, rot); applyRot(); };
    ov.querySelector('#ph-rot-r').onclick = () => { rot += 90; rots.set(cur, rot); applyRot(); };
    const navL = ov.querySelector('#ph-nav-l'), navR = ov.querySelector('#ph-nav-r');
    if (navL) navL.onclick = () => show(cur - 1);
    if (navR) navR.onclick = () => show(cur + 1);
    ov.addEventListener('click', (e) => {
      if (dragMoved) { dragMoved = false; return; }          // 拖动平移后的残留 click 不算点击
      if (Date.now() - lastDbl < 450) return;                 // 双击后的残留 click 忽略
      // 单击照片本身：未放大 → 以点击点为中心放大；已放大 → 还原
      if (e.target === img) {
        if (zs > 1.01) resetZoom(); else setZoom(2.5, e.clientX, e.clientY);
        return;
      }
      if (e.target !== stage) return;
      if (zs > 1.01) { resetZoom(); return; }                 // 放大状态点空白=还原
      close();                                                // 未放大点空白=关闭
    });
    // noNav===true：调用方（如「‹ 全部相片」）自己负责导航。注意不能用真值判断——
    // onclick 直接挂 close 时第一个参数是 event 对象，会被误当成 noNav
    function close(noNav) {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', onRouteChange);
      ov.remove();
      document.body.style.overflow = '';
      // 改过分类 → 交回列表页按当前筛选就地摘除（重拉列表会丢滚动位置）
      if (catTouched.size && typeof opts.onCatTouched === 'function') {
        try { opts.onCatTouched(catTouched); } catch (e) { /* 摘除失败不该拦住关闭 */ }
      }
      // 首页直达打开（opts.exitTo）：关闭后回照片主页 —— 相册内页没有「渲染出片/上传照片」工具条
      if (opts.exitTo && noNav !== true && location.hash !== opts.exitTo) location.hash = opts.exitTo;
    }
    /* eb：路由变了（浏览器返回键 / 侧栏跳转）→ 收灯箱。不收的话遮罩跨页残留，
       盖住新页面且吃掉所有鼠标事件（本轮 CDP 实测踩中）。once + close 里摘除，双向都不漏挂 */
    const onRouteChange = () => close(true); // noNav=true：hash 已被别人改了，别再触发 exitTo 跳转
    window.addEventListener('hashchange', onRouteChange, { once: true });
    function onKey(e) {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') show(cur + 1);
      if (e.key === 'ArrowLeft') show(cur - 1);
      if (e.key === '+' || e.key === '=') setZoom(zs * 1.25);
      if (e.key === '-' || e.key === '_') setZoom(zs / 1.25);
      if (e.key === '0') resetZoom();
      if (e.key === 'i' || e.key === 'I') toggleInfo();
    }
    document.addEventListener('keydown', onKey);

    strip.forEach((s) => { s.onclick = () => show(parseInt(s.dataset.i, 10)); });

    /* ---- 缩放交互：滚轮 / 双击 / 拖动 / 双指 ---- */
    const zIn = ov.querySelector('#ph-zoom-in'), zOut = ov.querySelector('#ph-zoom-out');
    if (zIn) zIn.onclick = () => setZoom(zs * 1.4);
    if (zOut) zOut.onclick = () => setZoom(zs / 1.4);
    if (zLabel) zLabel.onclick = () => resetZoom();
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      setZoom(zs * (e.deltaY < 0 ? 1.18 : 1 / 1.18), e.clientX, e.clientY);
    }, { passive: false });
    img.addEventListener('dragstart', (e) => e.preventDefault());   // 禁掉浏览器原生图片拖拽，否则 pointermove 会被中断、放大后拖不动
    stage.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || e.button !== 0 || zs <= 1.01) return;
      e.preventDefault();                                            // 阻止原生拖拽/文本选择，保证后续 pointermove 持续送达
      drag = { x: e.clientX, y: e.clientY, ox: zx, oy: zy };
      dragMoved = false;
      try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      applyRot();
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      zx = drag.ox + (e.clientX - drag.x);
      zy = drag.oy + (e.clientY - drag.y);
      if (Math.abs(zx - drag.ox) + Math.abs(zy - drag.oy) > 5) dragMoved = true;
      clampPan(); applyRot();
    });
    const endDrag = () => { if (!drag) return; drag = null; saveZoom(); applyRot(); };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    // 触摸：单指（未缩放）左右滑动切图；单指（已缩放）平移；双指捏合缩放
    const tdist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    let tx = null, pinch = null, wasPinch = false;
    stage.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        wasPinch = true;
        pinch = { d: tdist(e.touches) || 1, s: zs,
          cx: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          cy: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
        return;
      }
      if (e.touches.length === 1) {
        wasPinch = false;
        tx = { x: e.touches[0].clientX, y: e.touches[0].clientY, ox: zx, oy: zy };
      }
    }, { passive: true });
    stage.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinch) {
        e.preventDefault();
        setZoom(pinch.s * (tdist(e.touches) / pinch.d), pinch.cx, pinch.cy);
        return;
      }
      if (e.touches.length === 1 && tx && zs > 1.01) {
        e.preventDefault();
        zx = tx.ox + (e.touches[0].clientX - tx.x);
        zy = tx.oy + (e.touches[0].clientY - tx.y);
        clampPan(); applyRot();
      }
    }, { passive: false });
    stage.addEventListener('touchend', (e) => {
      if (pinch && e.touches.length < 2) { pinch = null; saveZoom(); }
      if (!e.touches.length) {
        if (!wasPinch && tx && zs <= 1.01) {
          const dx = (e.changedTouches[0] ? e.changedTouches[0].clientX : tx.x) - tx.x;
          if (Math.abs(dx) > 50) show(cur + (dx < 0 ? 1 : -1));
        }
        tx = null;
      }
    }, { passive: true });

    ov.querySelectorAll('.ph-film').forEach((b) => {
      b.onclick = () => {
        preset = FILM_FILTERS[parseInt(b.dataset.fi, 10)];
        ov.querySelectorAll('.ph-film').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        refresh();
      };
    });
    for (const [id, key] of [['adj-b', 'b'], ['adj-c', 'c'], ['adj-s', 's']]) {
      ov.querySelector('#' + id).oninput = (e) => { adj[key] = parseInt(e.target.value, 10); refresh(); };
    }

    // 删除（上传相册删 photos 表；NAS 相册库经 delApi 删原文件+记录）
    const delApi = opts.delApi || ((it) => '/api/photos/' + it.id);
    const delBtn = ov.querySelector('#ph-del');
    if (delBtn) delBtn.onclick = async () => {
      const it = items[cur];
      if (!confirm(opts.delText || '删除这张照片？NAS 里的原文件会一并删除，不可恢复！')) return;
      try { await api(delApi(it), { method: 'DELETE' }); } catch (e) { return toast('删除失败：' + e.message); }
      items.splice(cur, 1);
      if (!items.length) { close(); (opts.onAllDeleted || renderPhotos)(); return; }
      // 通知上层把列表里的格子同步摘掉（否则返回列表还能看到已删照片，且索引错位）
      if (opts.onDeleted) opts.onDeleted(it, cur);
      strip[cur]?.remove(); strip.splice(cur, 1);
      ov.querySelectorAll('.ph-strip').forEach((s, k) => { s.dataset.i = k; s.onclick = () => show(parseInt(s.dataset.i, 10)); });
      show(Math.min(cur, items.length - 1));
      toast('已删除');
    };

    /* ---- 照片详情面板（拍摄地点/机型镜头/参数/时间/规格） ---- */
    const infoEl = ov.querySelector('#ph-info-panel');
    let infoId = 0;
    // 本次看图会话里改过分类的照片 id：关掉大图时交回列表页，按当前筛选就地摘除。
    // 少了这一步，改完标签关掉大图，那张照片还赖在原分类网格里 —— 得切标签页重拉才消失。
    const catTouched = new Set();
    function toggleInfo() {
      if (!opts.info) return;
      const shown = !infoEl.classList.contains('hidden');
      if (shown) { infoEl.classList.add('hidden'); ov.classList.remove('ph-info-on'); }
      else { infoEl.classList.remove('hidden'); ov.classList.add('ph-info-on'); loadInfo(); }
    }
    const infoBtn = ov.querySelector('#ph-info-btn');
    if (infoBtn) infoBtn.onclick = toggleInfo;
    // 标签条渲染：按「当前照片」重建。翻页后不重建的话，按钮闭包仍指着上一张 ——
    // 用户给第二张点「人像」其实又标了一遍第一张，看起来就是「点了没反应」。
    function renderTagBar(bar) {
      const it = items[cur];
      if (!bar || !it) return;
      const CUR = it.category || '其他';
      bar.innerHTML = `<span style="color:#aab;font-size:12px;align-self:center;margin-right:2px;white-space:nowrap">给第 ${cur + 1} 张打标签</span>`
        + [...catOrder(), '其他'].map((c) =>
          `<button class="fk-chip${CUR === c ? ' active' : ''}" data-tcat="${c}">${c}</button>`).join('');
      bar.querySelectorAll('[data-tcat]').forEach((b) => {
        b.onclick = async () => {
          const t = items[cur];          // 实时取当前照片：即便标签条是旧的，也绝不会标错到别人身上
          if (!t) return;
          const cat = b.dataset.tcat;
          try {
            await api('/api/photos/lib/category', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [t.id], cat }) });
            t.category = cat === '其他' ? '' : cat;
            catTouched.add(t.id);
            const rec = (typeof PH !== 'undefined') && PH.items && PH.items.find((x) => x.id === t.id);
            if (rec) rec.category = t.category;
            syncCellBadge(t);
            if (typeof PH !== 'undefined') { PH.cats = null; refreshCatCounts(); }
            bar.querySelectorAll('[data-tcat]').forEach((x) => x.classList.toggle('active', x === b));
            toast(catToastText(cat), 4500);
          } catch (e) { toast('标注失败：' + e.message); }
        };
      });
    }
    // 列表格子上的标签角标：设「其他」= 空分类 = 角标要摘掉（否则残留一个「其他」）
    function syncCellBadge(it) {
      const cell = document.querySelector(`.fk-cell[data-pid="${it.id}"]`);
      if (!cell) return;
      let badge = cell.querySelector('.fk-cat');
      if (!it.category) { if (badge) badge.remove(); return; }
      if (!badge) { badge = document.createElement('span'); badge.className = 'fk-cat'; cell.appendChild(badge); }
      badge.textContent = it.category;
    }
    const tagBtn = ov.querySelector('#ph-tag-btn');
    if (tagBtn) tagBtn.onclick = () => {
      const existed = ov.querySelector('#ph-tag-bar');
      if (existed) { existed.remove(); return; }   // 再点一次收起
      const bar = document.createElement('div');
      bar.id = 'ph-tag-bar';
      bar.style.cssText = 'position:absolute;top:50px;left:50%;transform:translateX(-50%);z-index:70;background:rgba(22,22,26,.95);border-radius:10px;padding:8px 12px;display:flex;gap:6px;box-shadow:0 6px 22px rgba(0,0,0,.45)';
      ov.appendChild(bar);
      renderTagBar(bar);
    };
    ov.querySelector('#ph-info-close').onclick = toggleInfo;
    function infoItem(k, v) {
      return v ? `<div class="ph-info-row"><span class="k">${esc(k)}</span><span class="v">${esc(String(v))}</span></div>` : '';
    }
    function renderInfo(d) {
      const sec = (t) => `<div class="ph-info-sec">${esc(t)}</div>`;
      const out = [sec('时间')];
      out.push(infoItem('拍摄时间', d.taken_at));
      out.push(infoItem('入库时间', d.added_at));
      if (d.gps && d.gps.has) {
        out.push(sec('拍摄地点'));
        out.push(`<div class="ph-info-row"><span class="k">地点</span><span class="v" id="ph-info-place">${esc(d.gps.place || '解析中…')}</span></div>`);
        out.push(infoItem('坐标', d.gps.coord));
        if (d.gps.alt != null) out.push(infoItem('海拔', d.gps.alt + ' m'));
        out.push('<div class="ph-info-map" id="ph-info-map"></div>');
        out.push(`<span class="ph-info-maplinks"><a href="https://www.openstreetmap.org/?mlat=${d.gps.lat}&mlon=${d.gps.lon}#map=16/${d.gps.lat}/${d.gps.lon}" target="_blank" rel="noopener">OpenStreetMap ›</a>`
          + `<a href="https://uri.amap.com/marker?position=${d.gps.lon},${d.gps.lat}&name=${encodeURIComponent(d.gps.coord)}" target="_blank" rel="noopener">高德地图 ›</a></span>`);
      }
      out.push(sec('相机与镜头'));
      out.push(infoItem('机型', d.camera.model || d.camera.name));
      out.push(infoItem('品牌', d.camera.make));
      out.push(infoItem('镜头', d.camera.lens));
      if (!d.camera.name && !d.camera.model) out.push(infoItem('设备', '无 EXIF 相机信息（截图或已压缩图片）'));
      out.push(sec('拍摄参数'));
      out.push(infoItem('参数', d.paramsLine));
      if (d.exp_bias != null && d.exp_bias !== 0) out.push(infoItem('曝光补偿', (d.exp_bias > 0 ? '+' : '') + d.exp_bias + ' EV'));
      if (d.flash) out.push(infoItem('闪光灯', d.flash));
      if (d.software) out.push(infoItem('处理软件', d.software));
      out.push(sec('照片规格'));
      if (d.w && d.h) out.push(infoItem('分辨率', d.w + ' × ' + d.h + (d.mp ? `（${d.mp} MP）` : '')));
      out.push(infoItem('格式', d.raw ? `${d.ext} · RAW 原始文件` : d.ext));
      if (d.raw) out.push(infoItem('查看方式', '使用相机内嵌 JPEG 预览显示；调色/导出原片请用专业软件'));
      out.push(infoItem('文件大小', d.sizeText));
      out.push(infoItem('相册', d.album));
      out.push(infoItem('文件名', d.name));
      out.push(sec('分类'));
      out.push(`<div class="ph-info-chips">${[...catOrder(), '其他'].map((c) =>
        `<button class="fk-chip${(d.category || '其他') === c ? ' active' : ''}" data-icat="${c}">${c}</button>`).join('')}</div>`);
      out.push(infoItem('路径', d.path));
      return out.join('');
    }
    async function loadInfo() {
      if (!opts.info) return;
      const tb = ov.querySelector('#ph-tag-bar'); if (tb) tb.remove(); // 翻页后关闭过期标签条
      const it = items[cur];
      const body = ov.querySelector('#ph-info-body');
      if (!it) return;
      infoId = it.id;
      body.innerHTML = '<div class="empty-hint">读取中…</div>';
      let d = null;
      // 网络抖动/服务重启瞬间会 Failed to fetch：自动重试 2 次，仍失败给出「重试」按钮
      for (let attempt = 0; attempt < 3; attempt++) {
        try { d = await api('/api/photos/lib/info/' + it.id); break; }
        catch (e) {
          if (infoId !== it.id) return;   // 已翻到别的照片，丢弃过期结果
          if (attempt < 2) { await new Promise((r) => setTimeout(r, 400)); continue; }
          body.innerHTML = `<div class="empty-hint">读取失败：${esc(e.message)}
            <button class="btn-ghost" id="ph-info-retry" style="margin-top:8px">↻ 重试</button></div>`;
          const rb = body.querySelector('#ph-info-retry');
          if (rb) rb.onclick = loadInfo;
          return;
        }
      }
      if (!d || infoId !== it.id) return;
      body.innerHTML = renderInfo(d);
      // 人脸标签（fr 无 items 静默跳过）
      api('/api/faces/photo/faces?id=' + it.id).then((fr) => {
        if (infoId !== it.id || !fr || !Array.isArray(fr.items) || !fr.items.length) return;
        const names = [...new Set(fr.items.map((f) => f.person_name).filter(Boolean))];
        const chips = names.length
          ? names.map((n) => `<span class="fk-chip active">👤 ${esc(n)}</span>`).join('')
          : `<span class="fk-chip">检出 ${fr.items.length} 张脸（未归类）</span>`;
        body.insertAdjacentHTML('afterbegin', `<div class="ph-info-sec">人物</div><div class="ph-info-chips">${chips}</div>`);
      }).catch(() => {});
      body.querySelectorAll('[data-icat]').forEach((b) => {
        b.onclick = async () => {
          await api('/api/photos/lib/category', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: [it.id], cat: b.dataset.icat }) }).catch(() => {});
          body.querySelectorAll('[data-icat]').forEach((x) => x.classList.toggle('active', x === b));
          const catV = b.dataset.icat === '其他' ? '' : b.dataset.icat;
          catTouched.add(it.id);
          const rec = PH.items && PH.items.find((x) => x.id === it.id);
          if (rec) rec.category = catV;
          it.category = catV;
          syncCellBadge(it);
          PH.cats = null; refreshCatCounts();
          toast(catToastText(b.dataset.icat));
        };
      });
      if (d.gps && d.gps.has) {
        const mapBox = body.querySelector('#ph-info-map');
        if (mapBox) buildMiniMap(mapBox, d.gps.lat, d.gps.lon);
        if (!d.gps.place) {
          api('/api/photos/lib/' + it.id + '/place').then((p) => {
            if (infoId !== it.id) return;
            const el = body.querySelector('#ph-info-place');
            if (el) el.textContent = (p && p.has && p.place) ? p.place : '未能解析地名（仅坐标）';
          }).catch(() => {});
        }
      }
    }

    // 迷你地图：2×2+ 瓦片拼图，OSM 失败自动换 Esri 源，中心红点=拍摄点
    function buildMiniMap(box, lat, lon) {
      const z = 14, S = 256;
      const W = box.clientWidth || 320, H = box.clientHeight || 172;
      const n = Math.pow(2, z);
      const cx = (lon + 180) / 360 * n;
      const cy = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n;
      const x0 = Math.floor(cx), y0 = Math.floor(cy);
      const ox = W / 2 - (cx - x0) * S, oy = H / 2 - (cy - y0) * S;
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#0d1420;';
      for (let i = -1; i <= Math.ceil(W / S) + 1; i += 1) {
        for (let j = -1; j <= Math.ceil(H / S) + 1; j += 1) {
          const a = ((x0 + i) % n + n) % n, b = y0 + j;
          if (b < 0 || b >= n) continue;
          const img = document.createElement('img');
          img.style.cssText = `position:absolute;left:${ox + i * S}px;top:${oy + j * S}px;width:${S}px;height:${S}px;`;
          img.referrerPolicy = 'no-referrer';
          // 主源 Esri 卫星影像：全球含中国覆盖、无 key 无政策封锁（OSM 403 封图、CARTO 要 key、Esri 街道图中国无数据，均弃用）
          img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${b}/${a}`;
          img.onerror = () => { img.onerror = null; img.style.visibility = 'hidden'; };
          wrap.appendChild(img);
        }
      }
      const dot = document.createElement('div');
      dot.style.cssText = 'position:absolute;left:50%;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;'
        + 'background:#e50914;border:2px solid #fff;box-shadow:0 0 0 3px rgba(229,9,20,.35);';
      wrap.appendChild(dot);
      box.style.position = 'relative';
      box.appendChild(wrap);
    }

    // 保存渲染结果（Canvas 合成，服务端另存「渲染出片」）
    ov.querySelector('#ph-save').onclick = async () => {
      const it = items[cur];
      const btn = ov.querySelector('#ph-save');
      btn.disabled = true; btn.textContent = '正在合成…';
      try {
        const full = new Image();
        full.crossOrigin = 'anonymous';
        await new Promise((ok, bad) => { full.onload = ok; full.onerror = () => bad(new Error('图片加载失败')); full.src = fullOf(it); });
        // 超大图降采样（iOS 画布面积上限 ~16.7MP），保证合成成功
        const MAXDIM = 6000;
        const sc = Math.min(1, MAXDIM / Math.max(full.naturalWidth, full.naturalHeight));
        const dw = Math.round(full.naturalWidth * sc), dh = Math.round(full.naturalHeight * sc);
        const swap = ((rot % 180) + 180) % 180 === 90; // 旋转 90°/270° 时画布横竖互换
        const cv = document.createElement('canvas');
        cv.width = swap ? dh : dw; cv.height = swap ? dw : dh;
        const ctx = cv.getContext('2d');
        ctx.filter = cssFilter();
        ctx.translate(cv.width / 2, cv.height / 2);
        ctx.rotate(rot * Math.PI / 180);
        ctx.drawImage(full, -dw / 2, -dh / 2, dw, dh);
        const blob = await new Promise((ok) => cv.toBlob(ok, 'image/jpeg', 0.92));
        if (!blob) throw new Error('合成失败');
        const fd = new FormData();
        fd.append('filter', preset.name + (adj.b !== 100 || adj.c !== 100 || adj.s !== 100 ? '(微调)' : ''));
        fd.append('srcId', String(it.id));
        fd.append('blob', blob, `rendered-${it.id}.jpg`);
        const r = await api('/api/photos/render', { method: 'POST', body: fd });
        if (!r.ok) throw new Error(r.reason || '保存失败');
        toast(`已保存到「渲染出片」（${preset.name}）· 回照片页点筛选条「🎨 渲染出片」查看`, 5000);
      } catch (e) { toast('保存失败：' + e.message); }
      btn.disabled = false; btn.textContent = '保存到「渲染出片」';
    };
  }

/* ---------------- 照片页（Flickr 风格：justified 满行布局 + 类型筛选 + 自定义相簿） ---------------- */
const PH = { tab: 'all', cat: '', dtype: '', date: '', rawOnly: false, wantAlbums: false, items: [], total: 0, offset: 0, loading: false, done: false, gen: 0, cats: null, labels: null, faceView: null,
  sel: new Set(), selMode: false, view: null, dates: null, tl: [], search: null };

/* 分类 chip 顺序 —— 动态生成，绝不写死。
   优先级：AI 生效词表（/api/ai/labels 的 active）→ 库里实际存在且有张数的分类兜底 → 内置默认。
   为什么要有「兜底」这一层：词表换名/删类后，库里可能还留着旧分类的照片（如旧「观光」），
   它们必须仍有 chip 可点，否则那些照片在界面上就彻底找不回来了。
   为什么不能写死：曾写死成 ['人像','观光','静物','美食']，导致词表加了「宠物」后
   照片已归类、界面却没有这一格 —— 数据在、入口不在，等于没生效。 */
function catOrder() {
  const CN = PH.cats || {};
  const out = [];
  const push = (n) => { const s = String(n == null ? '' : n).trim(); if (s && s !== '其他' && out.indexOf(s) < 0) out.push(s); };
  (Array.isArray(PH.labels) ? PH.labels : []).forEach(push);
  Object.keys(CN).forEach((k) => { if (Number(CN[k] || 0) > 0) push(k); });
  if (!out.length) ['人像', '观光', '静物', '美食'].forEach(push);
  return out;
}

/* 分类是否匹配某筛选值 —— 与后端 libListAll 同语义：「其他」= 空串（历史脏数据 '其他' 也算）。
   改标签后就地摘除、提示文案两处都靠它，口径必须和后端一致。 */
function catMatch(it, cat) {
  const c = (it && it.category) || '';
  return cat === '其他' ? (!c || c === '其他') : c === cat;
}

/* 改标签的提示文案。原来一律提示「照片页筛选条点该分类即自动归类显示」，
   但用户就停在这个分类里看着照片没动 —— 提示必须先说清「关掉大图后会移出」。 */
function catToastText(cat) {
  const p = (typeof PH !== 'undefined') ? PH : null;
  const mismatch = !!p && !!p.cat && p.tab === 'all' && !p.view
    && !catMatch({ category: cat === '其他' ? '' : cat }, p.cat);
  return mismatch ? `已标记「${cat}」——关掉大图后将从上方的「${p.cat}」里移出` : `已标记「${cat}」`;
}

/* 就地摘除：这些照片的新分类已不匹配当前筛选 → 从列表里拿掉，返回摘掉的张数。
   为什么不直接 renderView() 重拉：那会把 PH.offset 归零、滚动位置顶回顶部；
   照片只是少了一张，列表没必要整体重来。 */
function dropCatMismatch(ids) {
  if (!PH.cat || PH.tab !== 'all' || PH.view || !ids || !ids.size) return 0;
  const before = PH.items.length;
  PH.items = PH.items.filter((x) => !(ids.has(x.id) && !catMatch(x, PH.cat)));
  const gone = before - PH.items.length;
  if (gone && typeof PH.total === 'number') PH.total = Math.max(0, PH.total - gone);
  return gone;
}

// 分类张数刷新：打标签后让筛选条上的数字立刻变，用户不用猜「到底标进去了没有」
async function refreshCatCounts() {
  try {
    const r = await api('/api/photos/lib/cats');
    PH.cats = (r && r.cats) || {};
  } catch { /* 保留旧值 */ }
  const bar = document.getElementById('ph-filter-bar');
  if (!bar || !PH.cats) return;
  const cnAll = Object.keys(PH.cats).reduce((a, k) => a + Number(PH.cats[k] || 0), 0);
  bar.querySelectorAll('[data-cat]').forEach((b) => {
    const c = b.dataset.cat;
    const em = b.querySelector('em');
    if (em) em.textContent = String(c === '' ? cnAll : (PH.cats[c] || 0));
  });
}

async function photosFetchData() {
  const [data, lib, albRes, dateRes, rdRes, bkRes, catRes, lblRes] = await Promise.all([
    api('/api/photos'), api('/api/photos/lib'), api('/api/photos/albums'), api('/api/photos/lib/dates'), api('/api/photos/renders').catch(() => ({ items: [] })), api('/api/backup/devices').catch(() => ({ devices: [] })), api('/api/photos/lib/cats').catch(() => ({ cats: {} })), api('/api/ai/labels').catch(() => ({}))]);
  return { data, lib, albRes, dateRes, rdRes, bkRes, catRes, lblRes };
}
async function renderPhotos(force) {
  const key = 'photos', hash = '#/photos';
  const c = force ? null : PAGE_CACHE[key];
  if (c) { // eu：30 分钟内回来缓存秒出，不闪加载
    drawPhotosPage(c.data);
    pageRefreshBackground(key, photosFetchData, (b) => {
      if (location.hash !== hash) return;
      if (document.querySelector('.ph-viewer')) return; // 正开着大图：本轮不打扰，下次进页用新数据
      drawPhotosPage(b);
    });
    return;
  }
  let b;
  try { b = await photosFetchData(); }
  catch (e) { $app.innerHTML = `<div class="empty-hint">相册加载失败：${esc(e.message)}</div>`; return; }
  PAGE_CACHE[key] = { data: b, ts: Date.now() };
  drawPhotosPage(b);
}
function drawPhotosPage(b) {
  const { data, lib, albRes, dateRes, rdRes, bkRes, catRes, lblRes } = b;
  // 生效词表：active 是真正在用的类名（含「其他」）；没有 AI 增强包时为空 → catOrder() 自动降级
  PH.labels = (lblRes && Array.isArray(lblRes.active) && lblRes.active.length) ? lblRes.active
    : (lblRes && Array.isArray(lblRes.labels) && lblRes.labels.length ? lblRes.labels : null);
  const renderCount = (rdRes.items || []).length;

  // 浏览渲染保存的照片（筛选条「🎨 渲染出片」与右上角按钮共用）；每次点击取最新列表
  async function openRenders() {
    const rd = await api('/api/photos/renders').catch(() => ({ items: [] }));
    const its = rd.items || [];
    if (!its.length) return toast('还没有渲染出片。打开一张照片，调好胶片滤镜后点「保存到渲染出片」。', 5000);
    openViewer(its, 0, { del: true, delText: '删除这张渲染出片？（只删除渲染副本，原图不受影响）' });
  }
  Object.assign(PH, { tab: 'all', cat: '', dtype: '', date: '', rawOnly: false, items: [], total: 0, offset: 0, loading: false, done: false, gen: (PH.gen || 0) + 1, cats: (catRes && catRes.cats) || {}, sel: new Set(), selMode: false, view: null, faceView: null, dates: dateRes, tl: data.items || [], search: null });

  $app.innerHTML = `
  <div class="ph-head">
    <div class="row-title">照片 <span class="ph-count">NAS 相册 ${lib.albums.reduce((s, a) => s + a.count, 0)} 张 · 设备上传 ${data.stats.photos} 张</span></div>
    <div class="ph-actions">
      <button class="btn-ghost" id="ph-album-render">渲染出片</button>
      <button class="btn-accent" id="ph-upload-btn">上传照片</button>
      <input type="file" id="ph-file" accept="image/*" multiple class="hidden">
    </div>
  </div>
  <div class="fk-tabs">
    <button class="fk-tab active" data-phtab="all">所有相片</button>
    <button class="fk-tab" data-phtab="albums">相簿</button>
    <button class="fk-tab" data-phtab="faces">人物</button>
    <button class="fk-tab fk-new" id="ph-new-album">＋ 新建相簿</button>
    <span class="fk-spacer"></span>
    <button class="btn-ghost" id="ph-ai-search-btn" title="用中文描述找照片（本地 AI 语义检索，不联网）">🔍 找照片</button>
    <button class="btn-ghost" id="ph-ai-dup-btn" title="找出重复/连拍的照片（本地 AI 视觉比对，不联网）">🧹 找重复</button>
    <button class="btn-ghost" id="ph-sel-btn">选择照片</button>
  </div>
  <div id="ph-dup-box" class="ph-search hidden">
    <div class="ph-dup-row">
      <span class="ph-dup-lb">查重强度</span>
      <div class="ph-dup-seg" id="ph-dup-preset">
        <button data-preset="strict" title="只找几乎完全相同的副本，最保守">严格</button>
        <button data-preset="normal" class="on" title="找同一张的副本 + 同一场景多张，推荐">标准</button>
        <button data-preset="loose" title="连拍、微调角度都算进来，最激进">宽松</button>
      </div>
      <button class="btn-accent" id="ph-dup-run">开始查找</button>
      <button class="btn-ghost" id="ph-dup-close">✕</button>
    </div>
    <div class="ph-search-hint" id="ph-dup-hint"></div>
  </div>
  <div id="ph-search-box" class="ph-search hidden">
    <input type="text" id="ph-search-input" placeholder="用一句话描述要找的照片，如：海边的日落 / 猫咪 / 火锅 / 手机截图">
    <button class="btn-accent" id="ph-search-go">搜索</button>
    <button class="btn-ghost" id="ph-search-close">✕</button>
    <div class="ph-search-hint" id="ph-search-hint"></div>
  </div>
  <div id="ph-filter-bar"></div>
  <div id="ph-sel-bar" class="fk-selbar hidden">
    <span class="fk-sel-n">已选 0 张</span>
    <button class="btn-ghost" id="ph-sel-addalb">＋ 加入相簿</button>
    <div class="fk-cat-set" id="ph-sel-cat">
      <button class="btn-ghost" disabled>设为分类：</button>
      ${[...catOrder(), '其他'].map((c) => `<button class="btn-ghost" data-setcat="${c}">${c}</button>`).join('')}
    </div>
    <button class="btn-ghost fk-danger" id="ph-sel-del">🗑 删除选中</button>
    <button class="btn-ghost" id="ph-sel-cancel">取消选择</button>
  </div>
  <div id="ph-body"></div>
  <div id="ph-tl-box" class="fk-tl"></div>
  <a class="back-link" data-go="#/home">‹ 返回首页</a>`;

  // 上传（沿用原逻辑）
  const fileInput = document.getElementById('ph-file');
  document.getElementById('ph-upload-btn').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    if (!fileInput.files.length) return;
    const fd = new FormData();
    for (const f of fileInput.files) fd.append('files', f, f.name);
    toast(`正在上传 ${fileInput.files.length} 个文件…`, 60000);
    try {
      const r = await api('/api/photos/upload', { method: 'POST', body: fd });
      const bad = r.results.filter((x) => x.skipped);
      toast(`上传完成：${r.results.length - bad.length} 张入库${bad.length ? `，${bad.length} 个被拒收` : ''}`);
      renderPhotos(true); // 数据已变：绕过页面缓存
    } catch (e) { toast('上传失败：' + e.message); }
    fileInput.value = '';
  };
  document.getElementById('ph-album-render').onclick = openRenders;
  // 设备上传照片（时间线）折叠入口
  const tlBox = document.getElementById('ph-tl-box');
  if (PH.tl.length) {
    tlBox.innerHTML = `<button class="btn-ghost fk-tl-btn" id="ph-tl-open">📷 设备上传的照片（${PH.tl.length} 张）›</button>`;
    tlBox.querySelector('#ph-tl-open').onclick = () => openViewer(PH.tl, 0, { onDeleted: () => renderPhotos(true) });
  }

  // Tab 切换
  $app.querySelectorAll('[data-phtab]').forEach((b) => {
    b.onclick = () => {
      PH.tab = b.dataset.phtab; PH.view = null; PH.faceView = null; PH.sel.clear(); PH.selMode = false;
      PH.search = null;                                  // 换页签=退出搜索结果
      const sb = document.getElementById('ph-search-box'); if (sb) sb.classList.add('hidden');
      $app.querySelectorAll('[data-phtab]').forEach((x) => x.classList.toggle('active', x === b));
      renderView();
    };
  });

  // 新建相簿（同新建歌单的弹窗风格）
  document.getElementById('ph-new-album').onclick = () => openAlbumCreate();

  /* ---------- 自然语言找图（本地 CLIP 语义检索） ----------
     走的是「中文 → 英文提示词 → 文本向量 → 与全库图片向量比余弦」。
     结果是一次性返回的排序列表（不走分页），所以单独用 PH.search 存，
     避免和 PH.items 的分页逻辑互相污染。 */
  const searchBox = document.getElementById('ph-search-box');
  const searchInput = document.getElementById('ph-search-input');
  const searchHint = document.getElementById('ph-search-hint');
  document.getElementById('ph-ai-search-btn').onclick = async () => {
    searchBox.classList.toggle('hidden');
    if (searchBox.classList.contains('hidden')) return;
    searchInput.focus();
    // 首次打开时提示能搜什么、以及向量库是否就绪
    try {
      const s = await api('/api/ai/search/info');
      searchHint.textContent = s.textModel
        ? `已支持 ${s.vocab} 个中文词；全库 ${s.total} 张，已建向量 ${s.ready} 张${s.ready < s.total ? '（扫描进行中，未建向量的照片暂时搜不到）' : ''}`
        : '⚠️ 需要先在「设置 → AI 智能分类」下载词表模型（约 243MB），才能用中文搜图';
    } catch { searchHint.textContent = ''; }
  };
  document.getElementById('ph-search-close').onclick = () => {
    searchBox.classList.add('hidden');
    PH.search = null;
    renderView();
  };
  const doSearch = async () => {
    const q = (searchInput.value || '').trim();
    if (!q) { toast('说点什么再搜，比如「海边的日落」'); return; }
    searchHint.textContent = '正在检索…';
    try {
      const r = await api('/api/ai/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, limit: 200 }),
      });
      PH.search = { q, items: r.items || [], prompts: r.prompts || [], hits: r.hits || [], unknown: r.unknown || [], scanned: r.scanned || 0 };
      if (!r.items || !r.items.length) {
        searchHint.textContent = r.note || '没有找到相似的照片';
      } else {
        const und = (r.unknown && r.unknown.length) ? `；没认出的词：${r.unknown.join('、')}` : '';
        searchHint.textContent = `「${q}」→ 理解成 ${(r.hits || []).join(' + ') || '英文描述'}，在 ${r.scanned} 张已建向量的照片里找到 ${r.items.length} 张${und}`;
      }
    } catch (e) {
      PH.search = null;
      searchHint.textContent = '⚠️ ' + e.message;
    }
    renderView();
  };
  document.getElementById('ph-search-go').onclick = doSearch;
  searchInput.onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };

  /* ---------- 重复 / 相似照片清理 ----------
     与「找照片」的区别：这里不搜内容，而是拿全库已建向量两两比余弦，成组的列出来。
     删除一律走回收站（服务端 /api/ai/similar/trash），原始文件只是搬走、可整批还原。 */
  const dupBox = document.getElementById('ph-dup-box');
  const dupHint = document.getElementById('ph-dup-hint');
  PH.dup = { preset: 'normal', groups: [], loading: false, checked: new Set() };
  document.getElementById('ph-ai-dup-btn').onclick = async () => {
    dupBox.classList.toggle('hidden');
    if (dupBox.classList.contains('hidden')) return;
    try {
      const s = await api('/api/ai/similar/info');
      dupHint.textContent = s.ready
        ? `全库 ${s.total} 张，其中 ${s.scanned} 张已建向量可比对${s.scanned < s.total ? '（扫描进行中，未建向量的照片暂时查不到重复）' : ''}`
        : '⚠️ 还没有可比的向量。请先在「设置 → AI 智能分类」里跑一次扫描。';
    } catch { dupHint.textContent = ''; }
  };
  document.getElementById('ph-dup-close').onclick = () => {
    dupBox.classList.add('hidden');
    PH.dup.groups = []; PH.dup.checked = new Set(); PH.dupView = false;
    renderView();
  };
  document.querySelectorAll('#ph-dup-preset [data-preset]').forEach((b) => {
    b.onclick = () => {
      PH.dup.preset = b.dataset.preset;
      document.querySelectorAll('#ph-dup-preset [data-preset]').forEach((x) => x.classList.toggle('on', x === b));
    };
  });
  document.getElementById('ph-dup-run').onclick = async () => {
    dupHint.textContent = '正在比对全库向量，照片多时需要几十秒…';
    PH.dup.loading = true;
    try {
      const r = await api('/api/ai/similar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset: PH.dup.preset }),
      });
      PH.dup.groups = r.groups || [];
      PH.dup.checked = new Set();
      // 默认勾上「建议删除」的（每组除保留张以外的全部）
      for (const g of PH.dup.groups) for (const it of g.items) if (it.id !== g.keepId) PH.dup.checked.add(it.id);
      const rec = PH.dup.groups.reduce((s, g) => s + (g.reclaim || 0), 0);
      dupHint.textContent = PH.dup.groups.length
        ? `在 ${r.scanned} 张里找到 ${r.totalGroups} 组重复/相似（当前展示 ${PH.dup.groups.length} 组），已默认勾选 ${PH.dup.checked.size} 张建议清理，约 ${(rec / 1048576).toFixed(1)}MB`
        : `在 ${r.scanned} 张里没找到重复照片 🎉`;
    } catch (e) {
      PH.dup.groups = [];
      dupHint.textContent = '⚠️ ' + e.message;
    }
    PH.dup.loading = false;
    PH.dupView = true;
    renderView();
  };

  // 选择模式
  document.getElementById('ph-sel-btn').onclick = () => { PH.selMode = !PH.selMode; PH.sel.clear(); syncSelBar(); drawGrid(); };
  document.getElementById('ph-sel-cancel').onclick = () => { PH.selMode = false; PH.sel.clear(); syncSelBar(); drawGrid(); };
  document.getElementById('ph-sel-del').onclick = async () => {
    if (!PH.sel.size) return toast('先勾选照片');
    if (PH.view) { // 相簿详情：仅移出相簿，不删文件
      await api(`/api/photos/albums/${PH.view.id}/items`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...PH.sel] }) });
      toast(`已移出 ${PH.sel.size} 张`);
      PH.sel.clear(); PH.selMode = false; syncSelBar(); renderView();
      return;
    }
    if (!confirm(`确定删除选中的 ${PH.sel.size} 张照片？（原文件一并删除）`)) return;
    const r = await api('/api/photos/lib/delete-many', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...PH.sel] }) });
    const nd = (r.dirsRemoved || []).length;
    toast(nd ? `已删除 ${r.removed} 张，并自动清理了 ${nd} 个空文件夹` : `已删除 ${r.removed} 张`);
    PH.sel.clear(); PH.selMode = false; syncSelBar(); renderView();
  };
  document.getElementById('ph-sel-addalb').onclick = () => openAlbumPick([...PH.sel]);
  document.querySelectorAll('#ph-sel-cat [data-setcat]').forEach((b) => {
    b.onclick = async () => {
      if (!PH.sel.size) return toast('先勾选照片');
      const ids = [...PH.sel], cat = b.dataset.setcat;
      await api('/api/photos/lib/category', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, cat }) });
      // 先把本地分类同步成新值，再就地摘除已不匹配当前筛选的（renderView 重拉会把滚动位置顶回顶部）
      for (const id of ids) { const x = PH.items.find((y) => y.id === id); if (x) x.category = cat === '其他' ? '' : cat; }
      const gone = dropCatMismatch(new Set(ids));
      toast(gone ? `已把 ${ids.length} 张标为「${cat}」——其中 ${gone} 张已移出当前分类` : `已把 ${ids.length} 张标为「${cat}」`);
      PH.cats = null; await refreshCatCounts();
      PH.sel.clear(); syncSelBar(); drawGrid(document.getElementById('ph-grid'));
    };
  });

  // 触发一次历史数据补齐（后台，幂等）
  api('/api/photos/lib/enrich', { method: 'POST' }).catch(() => {});
  // 后台补齐相机/镜头/参数/GPS（幂等，只补未探测过的）
  api('/api/photos/lib/enrich-exif', { method: 'POST' }).catch(() => {});

  if (PH.wantAlbums) { // 备份完成后自动落到「相簿」页签，让新备份目录直接可见
    PH.wantAlbums = false; PH.tab = 'albums'; PH.view = null;
    $app.querySelectorAll('[data-phtab]').forEach((x) => x.classList.toggle('active', x.dataset.phtab === 'albums'));
  }
  renderView();

  /* ---------- 视图渲染 ---------- */
  async function renderView() {
    const bar = document.getElementById('ph-filter-bar');
    const body = document.getElementById('ph-body');
    const selBtn = document.getElementById('ph-sel-btn');
    selBtn.style.display = (PH.tab === 'albums' && !PH.view) || (PH.tab === 'faces' && !PH.faceView) ? 'none' : '';
    if (PH.tab === 'faces' && !PH.faceView) { bar.innerHTML = ''; drawPersons(body); return; }
    if (PH.tab === 'faces' && PH.faceView) { bar.innerHTML = ''; drawPersonPhotos(body, PH.faceView); return; }
    if (PH.tab === 'albums' && !PH.view) { // 相簿总览
      bar.innerHTML = '';
      drawAlbums(body, albRes.albums || [], lib.albums || [], ((bkRes && bkRes.devices) || []).map((d) => d.name));
      return;
    }
    // 语义搜索结果视图：与分页列表完全分开，结果一次给全，按相似度排序
    if (PH.search) {
      bar.innerHTML = '';
      PH.items = PH.search.items.slice();
      PH.total = PH.items.length; PH.done = true;
      body.innerHTML = `<div class="row-head"><div class="row-title">🔍 「${esc(PH.search.q)}」 <span class="ph-count">${PH.items.length} 张 · 按相似度排序</span></div>
        <button class="btn-ghost" id="ph-search-clear">← 返回全部照片</button></div>
        <div class="fk-grid" id="ph-grid"></div>`;
      document.getElementById('ph-search-clear').onclick = () => { PH.search = null; renderView(); };
      drawGrid(document.getElementById('ph-grid'));
      return;
    }
    // 查重视图：按组列出，每组一行缩略图 + 勾选；删除走回收站
    if (PH.dupView) {
      bar.innerHTML = '';
      const gs = PH.dup.groups || [];
      if (!gs.length) {
        body.innerHTML = `<div class="row-head"><div class="row-title">🧹 重复照片 <span class="ph-count">没有找到</span></div>
          <button class="btn-ghost" id="ph-dup-back">← 返回全部照片</button></div>
          <div class="ph-empty">没有发现重复或高度相似的照片。</div>`;
        document.getElementById('ph-dup-back').onclick = () => { PH.dupView = false; renderView(); };
        return;
      }
      const recAll = gs.reduce((s, g) => s + (g.reclaim || 0), 0);
      body.innerHTML = `<div class="row-head"><div class="row-title">🧹 重复照片 <span class="ph-count">${gs.length} 组 · 已勾选 ${PH.dup.checked.size} 张 · 约 ${(recAll / 1048576).toFixed(1)}MB</span></div>
        <button class="btn-ghost" id="ph-dup-back">← 返回全部照片</button></div>
        <div class="ph-dup-tip">每组把最大最清晰的一张标为「保留」，其余默认勾选。点「清理选中」不会真删，只是移入回收站，随时可以还原。</div>
        <div class="ph-dup-actions">
          <button class="btn-ghost" id="ph-dup-all">全选建议项</button>
          <button class="btn-ghost" id="ph-dup-none">全不选</button>
          <button class="btn-ghost fk-danger" id="ph-dup-clean">🧹 清理选中（${PH.dup.checked.size} 张）</button>
          <button class="btn-ghost" id="ph-dup-trash">回收站</button>
        </div>
        <div id="ph-dup-groups"></div>`;
      document.getElementById('ph-dup-back').onclick = () => { PH.dupView = false; renderView(); };
      document.getElementById('ph-dup-all').onclick = () => {
        for (const g of gs) for (const it of g.items) if (it.id !== g.keepId) PH.dup.checked.add(it.id);
        renderView();
      };
      document.getElementById('ph-dup-none').onclick = () => { PH.dup.checked.clear(); renderView(); };
      document.getElementById('ph-dup-clean').onclick = async () => {
        const ids = [...PH.dup.checked];
        if (!ids.length) return toast('先勾选要清理的照片');
        if (!confirm(`确定清理选中的 ${ids.length} 张照片？\n\n原始文件会移入回收站（不会真的删除），随时可以还原。`)) return;
        try {
          const r = await api('/api/ai/similar/trash', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
          });
          toast(`已移入回收站 ${r.moved} 张（批次 ${r.batch}）${r.failed && r.failed.length ? `，${r.failed.length} 张失败` : ''}`);
          // 本地把已处理项摘掉，不必重跑全量比对
          const done = new Set(r.items.map((x) => x.id));
          for (const g of PH.dup.groups) g.items = g.items.filter((x) => !done.has(x.id));
          PH.dup.groups = PH.dup.groups.filter((g) => g.items.length >= 2);
          PH.dup.checked = new Set();
          PH.cats = null; await refreshCatCounts();
        } catch (e) { toast('清理失败：' + e.message); }
        renderView();
      };
      document.getElementById('ph-dup-trash').onclick = openTrash;
      const box = document.getElementById('ph-dup-groups');
      box.innerHTML = gs.map((g, gi) => {
        const keep = g.items.find((x) => x.id === g.keepId) || g.items[0];
        const kindTxt = g.kind === 'dup' ? '完全重复' : '高度相似';
        return `<div class="ph-dup-g" data-g="${gi}">
          <div class="ph-dup-gh"><b>第 ${gi + 1} 组</b> · ${g.n} 张 · <span class="ph-dup-kind ${g.kind}">${kindTxt}</span> · 相似度 ${(g.maxSim * 100).toFixed(1)}% · 可省 ${(g.reclaim / 1048576).toFixed(1)}MB</div>
          <div class="ph-dup-items">${g.items.map((it) => {
            const isKeep = it.id === g.keepId;
            const on = PH.dup.checked.has(it.id);
            return `<label class="ph-dup-it${isKeep ? ' keep' : ''}${on ? ' on' : ''}" data-id="${it.id}">
              <img loading="lazy" src="/api/photos/libthumb/${it.id}?v=2" onerror="this.style.visibility='hidden'">
              <span class="ph-dup-tag">${isKeep ? '✅ 保留' : (on ? '🗑 待清理' : '保留')}</span>
              <span class="ph-dup-nm" title="${esc(it.name)}">${esc(it.name)}</span>
              <span class="ph-dup-meta">${it.w}×${it.h} · ${(it.size / 1048576).toFixed(1)}MB${it.taken_at ? ' · ' + esc(String(it.taken_at).slice(0, 10)) : ''}</span>
              ${isKeep ? '<input type="checkbox" disabled checked>' : `<input type="checkbox" data-pick="${it.id}"${on ? ' checked' : ''}>`}
            </label>`;
          }).join('')}</div></div>`;
      }).join('');
      box.querySelectorAll('[data-pick]').forEach((cb) => {
        cb.onchange = () => {
          const id = Number(cb.dataset.pick);
          if (cb.checked) PH.dup.checked.add(id); else PH.dup.checked.delete(id);
          renderView();
        };
      });
      // 点缩略图看大图（点勾选框不触发）
      box.querySelectorAll('.ph-dup-it img').forEach((im) => {
        im.onclick = (ev) => {
          ev.preventDefault();
          const gi = Number(im.closest('.ph-dup-g').dataset.g);
          const g = gs[gi];
          const items = g.items.map((x) => ({ id: x.id, name: x.name, w: x.w, h: x.h }));
          openViewer(items, g.items.findIndex((x) => String(x.id) === im.closest('.ph-dup-it').dataset.id));
        };
      });
      return;
    }
    // 筛选条（所有相片 / 相簿详情共用）
    // 每个分类带张数：打标签后数字立刻变，「标了却找不到」一眼可辨
    const CN = PH.cats || {};
    const hasCN = Object.keys(CN).length > 0;
    const cnAll = Object.keys(CN).reduce((a, k) => a + Number(CN[k] || 0), 0);
    const cnOf = (c) => (hasCN ? `<em>${c === '' ? cnAll : (CN[c] || 0)}</em>` : '');
    const chips = ['', ...catOrder()].map((c) =>
      `<button class="fk-chip${PH.cat === c ? ' active' : ''}" data-cat="${c}">${c === '' ? '全部' : c}${cnOf(c)}</button>`).join('')
      + `<button class="fk-chip${PH.cat === '其他' ? ' active' : ''}" data-cat="其他">其他${cnOf('其他')}</button>`
      + `<button class="fk-chip${PH.rawOnly ? ' active' : ''}" data-raw="1">RAW 原片</button>`;
    const dd = (type, label) => {
      const list = (PH.dates && PH.dates[type]) || [];
      const on = PH.dtype === type && PH.date;
      return `<span class="fk-dd"><button class="fk-chip${on ? ' active' : ''}" data-dd="${type}">${label}${on ? ' · ' + PH.date : ''} ▾</button>
        <span class="fk-dd-menu hidden" data-menu="${type}"><span class="fk-dd-it${!PH.date ? ' active' : ''}" data-date="">全部日期</span>${list.length ? list.map((d) =>
          `<span class="fk-dd-it${(PH.dtype === type && PH.date === d.d) ? ' active' : ''}" data-date="${d.d}">${d.d} <em>${d.n}</em></span>`).join('') : '<span class="fk-dd-it dim">暂无日期</span>'}</span></span>`;
    };
    bar.innerHTML = PH.view ? '' : `<div class="fk-filter">${chips}
      <span class="fk-dd-sep"></span>${dd('shot', '拍摄日期')}${dd('added', '入库日期')}
      <span class="fk-dd-sep"></span><button class="fk-chip fk-render-chip${renderCount ? '' : ' dim'}" data-renders="1" title="浏览已保存的胶片滤镜渲染照片">🎨 渲染出片${renderCount ? ` <em>${renderCount}</em>` : ''}</button>
      <button class="fk-chip fk-bk-chip" data-backup="1" title="把这台手机的新照片增量备份到照片库（已备份过的自动跳过）">⬆️ 备份手机照片</button>
      <a class="fk-chip fk-guide-chip" href="/guide-backup.html" target="_blank" title="手机全自动备份配置指引（安卓 FolderSync / iPhone 文件App，各品牌 NAS 通用）">📖 备份指引</a>
      <span class="fk-dd-note">提示：分类可在选择模式下批量标注，未标注的归入「其他」</span></div>`;
    const renderChip = bar.querySelector('[data-renders]');
    if (renderChip) renderChip.onclick = openRenders;
    const bkChip = bar.querySelector('[data-backup]');
    if (bkChip) bkChip.onclick = openPhoneBackup;
    // 切筛选条件必须作废在途请求：否则旧请求返回时会把上一条件的结果画进当前分类；
    // 更糟的是 loading 未复位会让新查询根本不发起——格子空着，看着就像「标进去了却找不到」
    const resetPaging = () => { PH.gen = (PH.gen || 0) + 1; PH.loading = false; PH.offset = 0; PH.items = []; PH.done = false; };
    bar.querySelectorAll('[data-cat]').forEach((b) => {
      b.onclick = () => {
        PH.cat = b.dataset.cat;
        if (b.dataset.cat === '') { PH.dtype = ''; PH.date = ''; }  // 「全部」= 清空分类+日期，回到完整列表
        resetPaging(); renderView();
      };
    });
    const rawBtn = bar.querySelector('[data-raw]');
    if (rawBtn) rawBtn.onclick = () => { PH.rawOnly = !PH.rawOnly; resetPaging(); renderView(); };
    bar.querySelectorAll('[data-dd]').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); bar.querySelectorAll('.fk-dd-menu').forEach((m) => m.classList.toggle('hidden', m === b.parentElement.querySelector('.fk-dd-menu'))); };
    });
    bar.querySelectorAll('[data-date]').forEach((el) => {
      el.onclick = () => {
        if (el.classList.contains('dim')) return;
        if (el.dataset.date === '') { PH.dtype = ''; PH.date = ''; }  // 「全部日期」= 清除日期筛选
        else {
          const same = PH.dtype === el.closest('[data-menu]').dataset.menu && PH.date === el.dataset.date;
          PH.dtype = same ? '' : el.closest('[data-menu]').dataset.menu;
          PH.date = same ? '' : el.dataset.date;
        }
        resetPaging(); renderView();
      };
    });
    document.addEventListener('click', () => bar.querySelectorAll('.fk-dd-menu').forEach((m) => m.classList.add('hidden')), { once: true });

    if (PH.view) { // 相簿详情
      const d = await api('/api/photos/albums/' + PH.view.id).catch(() => null);
      PH.items = (d && d.items) || []; PH.total = PH.items.length; PH.done = true;
      body.innerHTML = `<div class="row-head"><div class="row-title">📕 ${esc(PH.view.name)} <span class="ph-count">${PH.items.length} 张</span></div>
        <span><button class="btn-ghost" id="ph-alb-add">＋ 添加照片</button>
        <button class="btn-ghost fk-danger" id="ph-alb-del">🗑 删除相簿</button></span></div><div class="fk-grid" id="ph-grid"></div>`;
      document.getElementById('ph-alb-add').onclick = () => openAlbumFill(PH.view);
      document.getElementById('ph-alb-del').onclick = async () => {
        if (!confirm(`删除相簿「${PH.view.name}」？（不会删除照片本身）`)) return;
        await api('/api/photos/albums/' + PH.view.id, { method: 'DELETE' });
        toast('相簿已删除'); PH.view = null; albRes.albums = await (api('/api/photos/albums').then((r) => r.albums).catch(() => [])); renderView();
      };
      drawGrid(body.querySelector('#ph-grid'));
      return;
    }
    // 所有相片：分页加载
    resetPaging();
    body.innerHTML = `<div class="fk-grid" id="ph-grid"></div><div class="empty-hint fk-more-hint hidden" id="ph-more">正在加载…</div>`;
    await loadMore();
  }

  async function loadMore() {
    if (PH.loading || PH.done) return;
    PH.loading = true;
    const gen = PH.gen;                       // 本次请求对应的筛选条件代数
    const hint = document.getElementById('ph-more');
    if (hint) hint.classList.remove('hidden');
    try {
      const q = new URLSearchParams({ offset: PH.offset, limit: 400, cat: PH.cat, dtype: PH.dtype, date: PH.date, fmt: PH.rawOnly ? 'raw' : '' });
      const r = await api('/api/photos/lib/all?' + q);
      if (gen !== PH.gen) return;             // 条件已变：丢弃过期结果，别把上一分类的照片画进来
      PH.items = PH.items.concat(r.items); PH.total = r.total; PH.offset += r.items.length;
      PH.done = PH.items.length >= r.total || !r.items.length;
      drawGrid(document.getElementById('ph-grid'));
      if (hint) { hint.classList.toggle('hidden', PH.done); hint.textContent = PH.done ? '' : '下滑加载更多…'; }
    } catch (e) {
      if (gen === PH.gen) { toast('加载失败：' + e.message); PH.done = true; }
    } finally {
      if (gen === PH.gen) PH.loading = false;  // 过期请求不许复位：新的请求正持有这个锁
    }
  }

  // Flickr justified：按宽高比满行铺排
  function drawGrid(grid) {    if (!grid) return;
    if (PH.tab === 'all' && !PH.view) grid.onclick = onScrollCheck;
    const W = grid.clientWidth || 1200;
    const GAP = 4, TARGET = Math.round(Math.min(360, Math.max(280, W / 4.5)));
    const rows = []; let row = [], wSum = 0;
    // 行高在 0.85x~1.18x 间周期变化：同比例照片为主的分类视图也有首页那种错落感
    const CYCLE = [1.18, 0.85, 1]; let ci = 0, tgt = TARGET * CYCLE[0];
    for (const it of PH.items) {
      const ar = it.w && it.h ? it.w / it.h : 4 / 3;
      row.push({ it, ar }); wSum += ar;
      const h = (W - GAP * (row.length - 1)) / wSum;
      if (h <= tgt) { rows.push({ row, h }); row = []; wSum = 0; ci = (ci + 1) % CYCLE.length; tgt = TARGET * CYCLE[ci]; }
    }
    if (row.length) rows.push({ row, h: Math.min(TARGET, (W - GAP * (row.length - 1)) / wSum) });
    grid.innerHTML = rows.map(({ row, h }) => `<div class="fk-row" style="height:${Math.round(h)}px">${row.map(({ it, ar }) =>
      `<div class="fk-cell${PH.sel.has(it.id) ? ' sel' : ''}${PH.selMode ? ' selmode' : ''}" data-pid="${it.id}" data-phv="${it.id}" data-phv-ar="${it.w && it.h ? (it.w / it.h).toFixed(3) : ''}" data-phv-name="${esc(it.taken_at || it.name || '')}" style="flex:${ar} 1 0%;min-width:0">
        <img loading="lazy" src="${libThumb(it)}" alt="" onerror="this.style.visibility='hidden'" title="${esc(it.name || '')}${it.taken_at ? ' · ' + esc(it.taken_at) : ''}">
        ${it.category ? `<span class="fk-cat">${esc(it.category)}</span>` : ''}
        ${isRawExt(it.ext) ? '<span class="fk-raw">RAW</span>' : ''}
        ${PH.sel.has(it.id) ? '<span class="fk-check">✓</span>' : ''}
      </div>`).join('')}</div>`).join('') || '<div class="empty-hint">没有符合条件的照片</div>';
    grid.querySelectorAll('.fk-cell').forEach((cell) => {
      cell.onclick = () => {
        const id = Number(cell.dataset.pid);
        if (PH.selMode) {
          if (PH.sel.has(id)) PH.sel.delete(id); else PH.sel.add(id);
          syncSelBar(); drawGrid(grid);
          return;
        }
        const idx = PH.items.findIndex((x) => x.id === id);
        const opts = { thumb: libThumb, full: libFull, info: true };
        if (!PH.view) { opts.del = true; opts.delApi = (it) => '/api/photos/lib/' + it.id; opts.onDeleted = (it) => { PH.items = PH.items.filter((x) => x.id !== it.id); drawGrid(grid); }; }
        // 关掉大图时把「已不匹配当前筛选」的照片从网格里摘掉并重画
        opts.onCatTouched = (ids) => {
          const gone = dropCatMismatch(ids);
          drawGrid(document.getElementById('ph-grid') || grid);
          if (gone) toast(`已移出「${PH.cat}」${gone} 张`);
        };
        openViewer(PH.items, idx, opts);
      };
    });
  }

  /* ★ 流畅度（fl）：原实现每来一个滚动事件就同步读 document.body.offsetHeight —— 那是一次强制重排，
     照片网格动辄几千张图时会明显掉帧；监听也没标 passive，浏览器还得等回调跑完才敢滚。
     改成 rAF 收敛（每帧至多算一次）+ passive（滚动不再等回调）。判定逻辑一字未改，行为等价。 */
  let _scTick = false;
  function onScrollCheck() {
    if (PH.tab !== 'all' || PH.view || PH.done || PH.loading) return;
    if (_scTick) return;
    _scTick = true;
    requestAnimationFrame(() => {
      _scTick = false;
      if (PH.tab !== 'all' || PH.view || PH.done || PH.loading) return;
      if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 600) loadMore();
    });
  }
  window.addEventListener('scroll', onScrollCheck, { passive: true });

  // 浏览器缩放 / 窗口尺寸变化：防抖重排照片网格（行高按新宽度重算，不溢出边框）
  let _fkRzT = 0, _fkRzW = window.innerWidth;
  window.addEventListener('resize', () => {
    if (Math.abs(window.innerWidth - _fkRzW) < 2) return;
    _fkRzW = window.innerWidth;
    clearTimeout(_fkRzT);
    _fkRzT = setTimeout(() => {
      const g = document.getElementById('ph-grid');
      if (g && PH.items && PH.items.length) drawGrid(g);
    }, 200);
  });

  function syncSelBar() {
    const bar = document.getElementById('ph-sel-bar');
    bar.classList.toggle('hidden', !PH.selMode);
    // 选择模式状态类：操作条固定钉在顶栏下方（CSS 端 body.ph-selmode），滚动到哪都能删
    document.body.classList.toggle('ph-selmode', PH.selMode);
    if (PH.selMode) requestAnimationFrame(() => { $app.style.paddingTop = Math.ceil(bar.getBoundingClientRect().height + 8) + 'px'; });
    else $app.style.paddingTop = '';
    bar.querySelector('.fk-sel-n').textContent = `已选 ${PH.sel.size} 张`;
    document.getElementById('ph-sel-btn').textContent = PH.selMode ? '退出选择' : '选择照片';
  }

  function drawAlbums(body, userAlbs, dirAlbs, bkNames) {
    /* eb：目录相册卡带 data-go → 悬停出浮层（phTargetOf 已兼容无 ?ph 的形式）；「我的相簿」点击是视图内切换（不走 hash），不参与悬停 */
    const card = (a, cls) => `<div class="fk-alb ${cls}" data-albid="${a.id}" data-albdir="${esc(a.album || '')}"${String(cls).includes('dir') ? ` data-go="#/photos/lib/${encodeURIComponent(a.album || '')}"` : ''}>
      <img loading="lazy" src="${libThumb({ id: a.cover_id || a.coverId })}" alt="" onerror="this.style.visibility='hidden'">
      <div class="fk-alb-name">${esc(a.name || a.album)}</div><div class="fk-alb-n">${a.count} 张</div></div>`;
    const bkSet = new Set(bkNames || []);
    const bkAlbs = dirAlbs.filter((a) => bkSet.has(a.album));
    // 4 小时轮换：相簿区顺序也换一换（「我的相簿」「NAS 目录相册」各自轮换）
    const otherDirs = rotShuffle(dirAlbs.filter((a) => !bkSet.has(a.album)), 50);
    userAlbs = rotShuffle(userAlbs.slice(), 51);
    body.innerHTML = `${bkAlbs.length ? `<h3 class="mv-group">📱 手机备份相册（本机备份目录，点开即看）</h3><div class="fk-alb-grid">${bkAlbs.map((a) => card({ ...a, id: a.album }, 'dir bk')).join('')}</div>` : ''}
      ${userAlbs.length ? `<h3 class="mv-group">📕 我的相簿</h3><div class="fk-alb-grid">${userAlbs.map((a) => card(a, 'user')).join('')}</div>` : ''}
      ${otherDirs.length ? `<h3 class="mv-group">📁 NAS 目录相册</h3><div class="fk-alb-grid">${otherDirs.map((a) => card({ ...a, id: a.album }, 'dir')).join('')}</div>` : ''}
      ${!userAlbs.length && !dirAlbs.length ? '<div class="empty-hint">还没有相簿。点右上「＋ 新建相簿」创建，然后在所有相片里勾选照片加入。</div>' : ''}`;
    body.querySelectorAll('.fk-alb.user').forEach((el) => {
      el.onclick = () => { PH.view = { id: Number(el.dataset.albid), name: el.querySelector('.fk-alb-name').textContent }; renderView(); };
    });
    body.querySelectorAll('.fk-alb.dir').forEach((el) => {
      el.onclick = () => { location.hash = '#/photos/lib/' + encodeURIComponent(el.dataset.albdir); };
    });
  }

  /* ---------- 人物（人脸识别） ---------- */
  async function startFaceModelDownload(body) {
    try { await api('/api/faces/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast('模型下载已开始'); }
    catch (e) { toast('启动下载失败：' + e.message); }
    drawPersons(body);
  }
  async function drawPersons(body) {
    body.innerHTML = '<div class="empty-hint">加载中…</div>';
    let info = null, persons = [];
    try {
      info = await api('/api/faces/info');
      const pr = await api('/api/faces/persons');
      persons = (pr && pr.persons) || [];
    } catch (e) {
      body.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
      return;
    }
    if (info && !info.installed) {
      const dl = info.downloading;
      if (dl && dl.error) {
        body.innerHTML = `<div class="empty-hint">模型下载失败：${esc(dl.error)} <button class="btn-ghost" id="ph-face-dl-retry" style="margin-left:10px">重试</button></div>`;
        const rb = body.querySelector('#ph-face-dl-retry');
        if (rb) rb.onclick = () => startFaceModelDownload(body);
        return;
      }
      if (dl) {
        const kindTxt = /det/.test(dl.kind) ? '检测模型' : '识别模型';
        body.innerHTML = `<div class="empty-hint" id="ph-face-dl">⬇️ 正在下载${kindTxt} ${(dl.bytes / 1048576).toFixed(0)}MB…</div>`;
        const tmr = setInterval(async () => {
          if (!document.getElementById('ph-face-dl') || PH.tab !== 'faces') { clearInterval(tmr); return; }
          try {
            const ni = await api('/api/faces/info');
            if (ni.installed) { clearInterval(tmr); drawPersons(body); return; }
            if (!ni.downloading) { clearInterval(tmr); drawPersons(body); return; }
            if (ni.downloading.error) { clearInterval(tmr); drawPersons(body); return; }
            const el = document.getElementById('ph-face-dl');
            if (el) el.textContent = `⬇️ 正在下载${/det/.test(ni.downloading.kind) ? '检测模型' : '识别模型'} ${(ni.downloading.bytes / 1048576).toFixed(0)}MB…`;
          } catch { clearInterval(tmr); }
        }, 3000);
        return;
      }
      body.innerHTML = `<div class="empty-hint">人脸模型未内置（精简安装包）。<button class="btn-accent" id="ph-face-dl-go" style="margin-left:10px">⬇️ 下载模型（约 191MB，一次即可）</button></div>`;
      const go = body.querySelector('#ph-face-dl-go');
      if (go) go.onclick = () => startFaceModelDownload(body);
      return;
    }
    const b = (info && info.batch) || {};
    let task = '';
    if (b.running) {
      task = `<div class="ph-dup-tip" id="ph-face-task"><span id="ph-face-prog">🔄 正在提取人脸 ${b.done || 0}/${b.total || '?'} 张…</span> <button class="btn-ghost" id="ph-face-stop">停止</button></div>`;
    } else if (info && info.pending > 0) {
      task = `<div class="ph-dup-tip" id="ph-face-task">📷 还有 ${info.pending} 张照片待提取人脸（扫描完成后也会自动开始） <button class="btn-accent" id="ph-face-run">立即提取</button>${info.failed ? ` <button class="btn-ghost" id="ph-face-retry">重试失败 ${info.failed}</button>` : ''}</div>`;
    } else if (info && info.failed > 0) {
      task = `<div class="ph-dup-tip" id="ph-face-task">⚠️ 有 ${info.failed} 张照片提取失败 <button class="btn-ghost" id="ph-face-retry">重试</button></div>`;
    }
    body.innerHTML = `${task}
      ${persons.length ? `<h3 class="mv-group">👤 人物（${persons.length}）</h3><div class="fk-alb-grid" id="ph-face-grid">${persons.map((p) => `
        <div class="fk-alb user" data-faceid="${p.id}"><img loading="lazy" src="/api/photos/libthumb/${p.cover_photo_id}?v=2" alt="" onerror="this.style.visibility='hidden'">
        <div class="fk-alb-name">${esc(p.name)}</div><div class="fk-alb-n">${p.face_count} 张</div></div>`).join('')}</div>`
      : `<div class="empty-hint">${info && info.done > 0 ? '还没有识别出人物。' : '还没有提取过人脸。' + (info && info.pending ? '点上方「立即提取」开始。' : '')}</div>`}`;
    body.querySelectorAll('.fk-alb[data-faceid]').forEach((el) => {
      el.onclick = () => {
        const p = persons.find((x) => x.id === Number(el.dataset.faceid));
        if (p) { PH.faceView = { id: p.id, name: p.name }; renderView(); }
      };
    });
    const run = body.querySelector('#ph-face-run');
    if (run) run.onclick = async () => {
      try { await api('/api/faces/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast('人脸提取已开始，可离开本页'); } catch (e) { toast('启动失败：' + e.message); }
      drawPersons(body);
    };
    const stop = body.querySelector('#ph-face-stop');
    if (stop) stop.onclick = async () => { await api('/api/faces/stop', { method: 'POST' }).catch(() => {}); toast('已请求停止'); drawPersons(body); };
    const retry = body.querySelector('#ph-face-retry');
    if (retry) retry.onclick = async () => { await api('/api/faces/retry', { method: 'POST' }).catch(() => {}); toast('已放回队列'); drawPersons(body); };
    // 进行中：8 秒轻轮询刷进度（只在人物总览在屏时轮，离开即停）
    if (b.running) {
      const tmr = setInterval(async () => {
        if (PH.tab !== 'faces' || PH.faceView || !document.getElementById('ph-face-task')) { clearInterval(tmr); return; }
        try {
          const ni = await api('/api/faces/info');
          if (!ni.batch || !ni.batch.running) { clearInterval(tmr); drawPersons(body); return; }
          const el = document.getElementById('ph-face-prog');
          if (el) el.textContent = `🔄 正在提取人脸 ${ni.batch.done || 0}/${ni.batch.total || '?'} 张…`;
        } catch { clearInterval(tmr); }
      }, 8000);
    }
  }

  async function drawPersonPhotos(body, fv) {
    body.innerHTML = '<div class="empty-hint">加载中…</div>';
    let items = [];
    try { items = (await api('/api/faces/person/photos?id=' + fv.id + '&limit=500')).items || []; }
    catch (e) { body.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`; return; }
    PH.items = items.map((x) => ({ id: x.photo_id, w: x.w, h: x.h, name: x.photo_name, taken_at: '', ext: '' }));
    PH.total = PH.items.length; PH.done = true;
    body.innerHTML = `<div class="row-head"><div class="row-title">👤 ${esc(fv.name)} <span class="ph-count">${PH.items.length} 张</span></div>
      <button class="btn-ghost" id="ph-face-back">← 返回人物</button>
      <button class="btn-ghost" id="ph-face-rename">✏️ 重命名</button>
      <button class="btn-ghost" id="ph-face-merge">🔀 合并到…</button>
      <button class="btn-ghost fk-danger" id="ph-face-del">🗑 删除人物</button></div>
      <div class="fk-grid" id="ph-grid"></div>`;
    document.getElementById('ph-face-back').onclick = () => { PH.faceView = null; renderView(); };
    document.getElementById('ph-face-rename').onclick = () => {
      const mask = muModal('重命名人物', `<div class="mpl-form"><input id="ph-face-name" type="text" placeholder="人物名字" maxlength="24" value="${esc(fv.name)}" /></div>
        <button id="ph-face-ok" class="btn-accent" style="width:100%;margin-top:14px;padding:10px">保存</button>`);
      const inp = mask.querySelector('#ph-face-name'); inp.focus();
      mask.querySelector('#ph-face-ok').onclick = async () => {
        const v = (inp.value || '').trim(); if (!v) return toast('请输入名字');
        try { await api('/api/faces/person/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: fv.id, name: v }) }); mask.remove(); fv.name = v; toast('已重命名'); renderView(); }
        catch (e) { toast('失败：' + e.message); }
      };
    };
    document.getElementById('ph-face-merge').onclick = async () => {
      let others = [];
      try { others = ((await api('/api/faces/persons')).persons || []).filter((p) => p.id !== fv.id); } catch { /* ignore */ }
      if (!others.length) return toast('没有其他人物可合并');
      const mask = muModal('合并人物', `<div class="mpl-form">把「${esc(fv.name)}」的全部脸并入：</div>
        <div class="mpl-form"><select id="ph-face-target" style="width:100%">${others.map((p) => `<option value="${p.id}">${esc(p.name)}（${p.face_count} 张）</option>`).join('')}</select></div>
        <button id="ph-face-ok" class="btn-accent" style="width:100%;margin-top:14px;padding:10px">合并</button>`);
      mask.querySelector('#ph-face-ok').onclick = async () => {
        const to = Number(mask.querySelector('#ph-face-target').value) || 0;
        if (!to) return;
        try { await api('/api/faces/person/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: fv.id, into: to }) }); mask.remove(); toast('已合并'); PH.faceView = null; renderView(); }
        catch (e) { toast('失败：' + e.message); }
      };
    };
    document.getElementById('ph-face-del').onclick = async () => {
      if (!confirm(`删除人物「${fv.name}」？

只删除这个人物分组，照片和识别数据都保留，之后可重新归组。`)) return;
      try { await api('/api/faces/person/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: fv.id }) }); toast('已删除'); PH.faceView = null; renderView(); }
      catch (e) { toast('失败：' + e.message); }
    };
    drawGrid(document.getElementById('ph-grid'));
  }

  // 新建相簿弹窗
  function openAlbumCreate() {
    const mask = muModal('新建相簿', `
      <div class="mpl-form"><input id="ph-alb-name" type="text" placeholder="相簿名称" maxlength="50" /></div>
      <button id="ph-alb-ok" class="btn-accent" style="width:100%;margin-top:14px;padding:10px">创建</button>`);
    const input = mask.querySelector('#ph-alb-name');
    input.focus();
    const doCreate = async () => {
      const name = (input.value || '').trim();
      if (!name) return toast('请输入相簿名称');
      try {
        const r = await api('/api/photos/albums', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        mask.remove();
        toast(`相簿「${name}」已创建`);
        albRes.albums = await api('/api/photos/albums').then((x) => x.albums).catch(() => albRes.albums);
        if (PH.tab === 'albums') { PH.view = null; renderView(); }
        else { PH.view = { id: r.id, name }; PH.tab = 'albums'; $app.querySelectorAll('[data-phtab]').forEach((x) => x.classList.toggle('active', x.dataset.phtab === 'albums')); renderView(); }
      } catch (e) { toast('创建失败：' + e.message); }
    };
    mask.querySelector('#ph-alb-ok').onclick = doCreate;
    input.onkeydown = (e) => { if (e.key === 'Enter') doCreate(); };
  }

  // 把选中照片加入相簿
  async function openAlbumPick(ids) {
    if (!ids.length) return toast('先勾选照片');
    const pls = albRes.albums || [];
    const mask = muModal(`加入相簿（${ids.length} 张）`, `
      <button id="ph-ap-new" class="mpl-new">＋ 新建相簿</button>
      <div class="mpl-list">${pls.length ? pls.map((p) => `
        <div class="mpl-item" data-alb="${p.id}"><span class="mpl-cover">📕</span>
          <span class="mpl-name">${esc(p.name)}</span><span class="mpl-count">${p.count} 张</span></div>`).join('')
        : '<div class="empty-hint">还没有相簿，先新建一个。</div>'}</div>`);
    mask.querySelector('#ph-ap-new').onclick = () => { mask.remove(); openAlbumCreate(); };
    mask.querySelectorAll('[data-alb]').forEach((el) => {
      el.onclick = async () => {
        const r = await api(`/api/photos/albums/${el.dataset.alb}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
        toast(`已把 ${r.added} 张加入相簿`);
        mask.remove(); PH.sel.clear(); PH.selMode = false; syncSelBar();
        albRes.albums = await api('/api/photos/albums').then((x) => x.albums).catch(() => albRes.albums);
      };
    });
  }

  // 查重回收站：列出批次，可整批还原或彻底清空
  async function openTrash() {
    let r;
    try { r = await api('/api/ai/similar/trash'); } catch (e) { return toast('打不开回收站：' + e.message); }
    const bs = r.batches || [];
    const mask = muModal('查重回收站', `
      <div class="ph-tr-tip">这里放的是「找重复」清理掉的照片。原件没有被删除，还原后会回到原来的文件夹与文件名。</div>
      <div class="mpl-list">${bs.length ? bs.map((b) => `
        <div class="mpl-item" data-b="${esc(b.batch)}"><span class="mpl-cover">♻️</span>
          <span class="mpl-name">${esc(b.batch)}</span>
          <span class="mpl-count">${b.n} 张 · ${(b.bytes / 1048576).toFixed(1)}MB</span></div>`).join('')
        : '<div class="empty-hint">回收站是空的。</div>'}</div>
      ${bs.length ? '<button class="btn-ghost fk-danger" id="ph-tr-purge" style="margin-top:10px">彻底清空全部（不可恢复）</button>' : ''}`);
    mask.querySelectorAll('[data-b]').forEach((el) => {
      el.onclick = async () => {
        const b = el.dataset.b;
        if (!confirm(`把批次「${b}」里的照片还原回原位置？`)) return;
        try {
          const rr = await api('/api/ai/similar/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch: b }) });
          const bad = (rr.failed || []).length;
          toast(`已还原 ${rr.restored} 张${bad ? `，${bad} 张失败（原位置已有同名文件）` : ''}。重新扫描后即可在照片库里看到。`);
        } catch (e) { toast('还原失败：' + e.message); }
        mask.remove(); openTrash();
      };
    });
    const pur = mask.querySelector('#ph-tr-purge');
    if (pur) pur.onclick = async () => {
      if (!confirm('彻底清空回收站？照片将被真正删除，无法恢复！')) return;
      for (const b of bs) { try { await api('/api/ai/similar/purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch: b.batch }) }); } catch { /* ignore */ } }
      toast('回收站已清空');
      mask.remove(); openTrash();
    };
  }

  // 相簿详情里「＋ 添加照片」：弹窗网格点选
  function openAlbumFill(view) {
    api('/api/photos/lib/all?limit=300').then((r) => {
      const inAlb = new Set(PH.items.map((x) => x.id));
      const cand = r.items.filter((x) => !inAlb.has(x.id));
      const mask = muModal(`添加照片到「${view.name}」`, `
        <div class="fk-fill-grid">${cand.map((it) => `<div class="fk-fill-cell" data-pid="${it.id}">
          <img loading="lazy" src="${libThumb(it)}" alt=""></div>`).join('') || '<div class="empty-hint">所有照片都已在相簿里</div>'}</div>`);
      const picked = new Set();
      mask.querySelectorAll('.fk-fill-cell').forEach((c) => {
        c.onclick = () => {
          const id = Number(c.dataset.pid);
          if (picked.has(id)) { picked.delete(id); c.classList.remove('sel'); }
          else { picked.add(id); c.classList.add('sel'); }
        };
      });
      const foot = document.createElement('div');
      foot.className = 'fk-fill-foot';
      foot.innerHTML = `<span id="ph-fill-n">已选 0 张</span><button class="btn-accent" id="ph-fill-ok">加入相簿</button>`;
      mask.querySelector('.mu-modal-body').appendChild(foot);
      foot.querySelector('#ph-fill-ok').onclick = async () => {
        if (!picked.size) return toast('先点选照片');
        await api(`/api/photos/albums/${view.id}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...picked] }) });
        mask.remove(); toast(`已加入 ${picked.size} 张`); renderView();
      };
    });
  }
}

/* ---------------- 路由 ---------------- */
/* ---------------- 音乐中心（网易云版式：左栏 + 封面墙/曲目表 + 底部播放条） ---------------- */
const Music = { audio: null, bar: null, queue: [], qIdx: -1, mode: 'order', shOrder: [], shPos: -1, errStreak: 0, lastSaveAt: 0, plays: {}, likes: new Set(), lyr: { id: 0, lines: [], on: false } };
// 播放模式偏好记忆：order 顺序播放 / shuffle 随机播放
Music.mode = localStorage.getItem('hmp-play-mode') === 'shuffle' ? 'shuffle' : 'order';
const fmtTime = (s) => {
  if (s == null || !isFinite(s) || s <= 0) return '--:--';
  s = Math.round(s);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
// 封面按显示尺寸取缩略图：原图常 1~2MB，列表页几十张会拖死主线程（切菜单卡死主因之一）
const musicCoverUrl = (t, s) => '/api/music/cover/' + t.id + '?s=' + (s || 360) + '&v=3'; // es：v=3 冲掉历史缓存的博纳灰唱片占位
const albCoverFallback = (album, artist) => '/api/music/albcover/' + encodeURIComponent(album || '单曲') + '?artist=' + encodeURIComponent(artist || '') + '&s=360';

function musicAudio() {
  if (Music.audio) return Music.audio;
  const a = new Audio();
  a.volume = 0.9;
  a.addEventListener('ended', () => musicNext(1));
  a.addEventListener('loadedmetadata', () => {
    const t = Music.queue[Music.qIdx];
    if (t && !t.online && isFinite(a.duration) && a.duration > 0) {
      api(`/api/music/duration/${t.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ duration: Math.round(a.duration) }) }).catch(() => {});
    }
  });
  a.addEventListener('timeupdate', () => {
    musicUpdateBar();
    const now = Date.now();
    const t = Music.queue[Music.qIdx];
    if (t && !t.online && now - Music.lastSaveAt > 5000) { // 每 5 秒存续播进度（在线曲目不存）
      Music.lastSaveAt = now;
      api('/api/music/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackId: t.id, position: a.currentTime }) }).catch(() => {});
    }
  });
  a.addEventListener('error', () => {
    // 解码失败自动切下一首；整轮队列都失败就停下，避免死循环
    if (Music.errStreak++ >= Music.queue.length) { Music.errStreak = 0; return; }
    toast('该音频浏览器无法解码，已切下一首');
    musicNext(1);
  });
  a.addEventListener('playing', () => { Music.errStreak = 0; musicUpdateBar(); });
  a.addEventListener('play', musicUpdateBar);
  a.addEventListener('pause', musicUpdateBar);
  Music.audio = a;
  return a;
}

function ensureMusicBar() {
  if (Music.bar) return;
  const bar = document.createElement('div');
  bar.id = 'music-bar';
  bar.className = 'music-bar hidden';
  bar.innerHTML = `
    <img class="mb-cover" alt="" />
    <div class="mb-info"><div class="mb-title">—</div><div class="mb-artist"></div></div>
    <div class="mb-ctrl">
      <div class="mb-btns">
        <button class="mb-mode mb-mode-order" title="顺序播放">↻ 顺序</button>
        <button class="mb-mode mb-mode-shuffle" title="随机播放">🔀 随机</button>
        <button class="mb-prev" title="上一首">⏮</button>
        <button class="mb-play" title="播放 / 暂停">▶</button>
        <button class="mb-next" title="下一首">⏭</button>
      </div>
      <div class="mb-progress">
        <span class="mb-cur">0:00</span>
        <div class="mb-track"><div class="mb-fill"></div></div>
        <span class="mb-dur">--:--</span>
      </div>
    </div>
    <div class="mb-lyric hidden"></div>
    <div class="mb-right">
      <button class="mb-lyr" title="歌词">词</button>
      <span class="mb-vol-ico">🔊</span>
      <input class="mb-vol" type="range" min="0" max="1" step="0.01" value="0.9" title="音量" />
      <button class="mb-close" title="关闭播放条（停止播放）">✕</button>
    </div>`;
  document.body.appendChild(bar);
  Music.bar = bar;
  const q = (s) => bar.querySelector(s);
  q('.mb-play').onclick = () => {
    if (!Music.queue.length) return;
    const a = musicAudio();
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  };
  q('.mb-prev').onclick = () => musicNext(-1);
  q('.mb-next').onclick = () => musicNext(1);
  q('.mb-mode-order').onclick = () => musicSetMode('order');
  q('.mb-mode-shuffle').onclick = () => musicSetMode('shuffle');
  musicUpdateMode();
  q('.mb-track').onclick = (e) => {
    const a = musicAudio();
    if (!isFinite(a.duration) || !a.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * a.duration;
    musicUpdateBar();
  };
  q('.mb-vol').oninput = (e) => { musicAudio().volume = Number(e.target.value); };
  q('.mb-close').onclick = () => {
    const a = musicAudio();
    a.pause();
    a.removeAttribute('src');
    Music.queue = []; Music.qIdx = -1; Music.errStreak = 0;
    Music.lyr.on = false; Music.lyr.lines = [];
    bar.querySelector('.mb-lyric').classList.add('hidden');
    q('.mb-lyr').classList.remove('on');
    bar.classList.add('hidden');
    document.body.classList.remove('music-bar-on');
  };
  q('.mb-lyr').onclick = () => {
    Music.lyr.on = !Music.lyr.on;
    localStorage.setItem('hmp-lyr-auto', Music.lyr.on ? '1' : '0'); // 记住手动开/关偏好
    bar.querySelector('.mb-lyric').classList.toggle('hidden', !Music.lyr.on);
    q('.mb-lyr').classList.toggle('on', Music.lyr.on);
    if (Music.lyr.on) { renderLyricPanel(); updateLyric(Music.audio ? Music.audio.currentTime : 0); }
  };
}

function musicShowBar() {
  ensureMusicBar();
  Music.bar.classList.remove('hidden');
  document.body.classList.add('music-bar-on');
}

async function musicPlayQueue(tracks, startIdx) {
  if (!tracks || !tracks.length) return;
  Music.queue = tracks.slice();
  Music.qIdx = Math.max(0, Math.min(tracks.length - 1, startIdx || 0));
  Music.errStreak = 0;
  if (Music.mode === 'shuffle') musicBuildShuffle(); // 随机模式：以所选曲目为起点重排一轮
  await musicPlayCurrent();
}

async function musicPlayCurrent() {
  const t = Music.queue[Music.qIdx];
  if (!t) return;
  const a = musicAudio();
  musicShowBar();
  if (t.online) {
    // 在线热歌：先解析免费直链再播；解析失败自动切下一首（已切歌则丢弃过期结果）
    const cover = Music.bar.querySelector('.mb-cover');
    cover.onerror = () => { cover.onerror = null; cover.removeAttribute('src'); };
    if (t.pic) cover.src = t.pic;
    Music.bar.querySelector('.mb-title').textContent = '正在解析音源：' + (t.title || '');
    Music.bar.querySelector('.mb-artist').textContent = [t.artist, t.album].filter(Boolean).join(' · ');
    musicUpdateBar();
    const myIdx = Music.qIdx, myQueue = Music.queue;
    const r = await api('/api/music/online/src?name=' + encodeURIComponent(t.title || '') + '&artist=' + encodeURIComponent(t.artist || '')).catch(() => null);
    if (Music.queue !== myQueue || Music.qIdx !== myIdx) return;
    if (!r || !r.ok) {
      toast(`「${t.title}」暂无免费音源（VIP 或已下架），已切下一首`);
      return musicNext(1);
    }
    t.srcLabel = r.srcLabel; t.duration = r.duration || 0;
    Music.bar.querySelector('.mb-title').textContent = (t.title || '') + ' · 音源: ' + (r.srcLabel || '免费');
    Music.bar.querySelector('.mb-artist').textContent = [r.artist || t.artist, t.album].filter(Boolean).join(' · ');
    a.src = r.src;
    try { await a.play(); } catch { /* 自动播放策略拦截：保持就绪 */ }
    musicUpdateBar();
    musicMarkPlaying();
    return;
  }
  const cover = Music.bar.querySelector('.mb-cover');
  cover.onerror = (e) => { e.target.onerror = null; e.target.src = albCoverFallback(t.album, t.artist); };
  cover.src = musicCoverUrl(t, 128);
  Music.bar.querySelector('.mb-title').textContent = t.title || '未知曲目';
  Music.bar.querySelector('.mb-artist').textContent = [t.artist, t.album].filter(Boolean).join(' · ');
  // 播放统计（热歌榜数据源）
  Music.plays[t.id] = (Music.plays[t.id] || 0) + 1;
  api('/api/music/played', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.id }) }).catch(() => {});
  // 歌词：同目录 .lrc 异步拉取
  Music.lyr.id = t.id; Music.lyr.lines = [];
  renderLyricPanel();
  api('/api/music/lyric/' + t.id).then((r) => {
    if (Music.queue[Music.qIdx] && Music.queue[Music.qIdx].id === t.id) {
      Music.lyr.lines = lyricParse(r.lrc);
      renderLyricPanel();
      updateLyric(Music.audio ? Music.audio.currentTime : 0);
      // 歌词就绪且未打开面板时自动展开（用户手动关闭过则不再自动弹）
      if (Music.lyr.lines.length && !Music.lyr.on && localStorage.getItem('hmp-lyr-auto') !== '0') {
        Music.lyr.on = true;
        Music.bar.querySelector('.mb-lyric').classList.remove('hidden');
        Music.bar.querySelector('.mb-lyr').classList.add('on');
      }
    }
  }).catch(() => {});
  a.src = '/api/music/stream/' + t.id;
  try { await a.play(); } catch { /* 自动播放策略拦截：保持就绪，等用户点播放 */ }
  musicUpdateBar();
  musicMarkPlaying();
}

/* ---- 播放模式：顺序播放 / 随机播放 ----
   随机模式用「乱序索引表」实现：一轮内每首歌只播一次，上一首/下一首在表内前后移动，
   一轮播完自动重新洗牌（并把刚播完的那首排到队尾，避免紧接着重复）。 */
function musicBuildShuffle() {
  const n = Music.queue.length;
  const idx = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) { // Fisher-Yates
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const k = idx.indexOf(Music.qIdx); // 当前曲目置于表首，作为本轮起点
  if (k > 0) { idx.splice(k, 1); idx.unshift(Music.qIdx); }
  Music.shOrder = idx;
  Music.shPos = 0;
}
function musicUpdateMode() {
  if (!Music.bar) return;
  const o = Music.bar.querySelector('.mb-mode-order');
  const s = Music.bar.querySelector('.mb-mode-shuffle');
  if (o) o.classList.toggle('on', Music.mode === 'order');
  if (s) s.classList.toggle('on', Music.mode === 'shuffle');
}
function musicSetMode(mode) {
  const next = mode === 'shuffle' ? 'shuffle' : 'order';
  if (next === Music.mode) return;
  Music.mode = next;
  localStorage.setItem('hmp-play-mode', next); // 记住偏好，下次打开沿用
  if (next === 'shuffle') musicBuildShuffle();
  musicUpdateMode();
  toast(next === 'shuffle' ? '已切换到随机播放' : '已切换到顺序播放');
}

function musicNext(dir) {
  const n = Music.queue.length;
  if (!n) return;
  if (Music.mode === 'shuffle' && n > 1) {
    if (!Music.shOrder.length) musicBuildShuffle();
    Music.shPos += dir;
    if (Music.shPos >= Music.shOrder.length) {
      // 一轮播完：重新洗牌，并保证新一轮首曲不是刚播完的这首
      const last = Music.qIdx;
      musicBuildShuffle();
      if (Music.shOrder.length > 1 && Music.shOrder[0] === last) {
        const t0 = Music.shOrder[0];
        Music.shOrder[0] = Music.shOrder[1];
        Music.shOrder[1] = t0;
      }
      Music.shPos = 0;
    } else if (Music.shPos < 0) {
      Music.shPos = Music.shOrder.length - 1;
    }
    Music.qIdx = Music.shOrder[Music.shPos];
  } else {
    Music.qIdx = (Music.qIdx + dir + n) % n;
  }
  musicPlayCurrent();
}

function lyricParse(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g)];
    const txt = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!stamps.length) continue;
    for (const m of stamps) out.push({ t: Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0), text: txt });
  }
  return out.filter((l) => l.text).sort((a, b) => a.t - b.t);
}
function renderLyricPanel() {
  if (!Music.bar) return;
  const box = Music.bar.querySelector('.mb-lyric');
  if (!box) return;
  box.innerHTML = Music.lyr.lines.length
    ? Music.lyr.lines.map((l, i) => `<div class="mb-lline" data-i="${i}">${esc(l.text)}</div>`).join('')
    : '<div class="mb-lline dim">暂无歌词（可在歌曲同目录放同名 .lrc）</div>';
}
function updateLyric(cur) {
  if (!Music.bar || !Music.lyr.on || !Music.lyr.lines.length) return;
  const lines = Music.lyr.lines;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].t <= cur + 0.2) idx = i; else break; }
  const box = Music.bar.querySelector('.mb-lyric');
  if (!box) return;
  const prev = box.querySelector('.mb-lline.on');
  const now = box.querySelector(`.mb-lline[data-i="${idx}"]`);
  if (prev === now) return;
  if (prev) prev.classList.remove('on');
  if (now) {
    now.classList.add('on');
    const top = now.offsetTop - box.clientHeight / 2 + now.clientHeight / 2;
    box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
}

function musicUpdateBar() {
  if (!Music.bar || !Music.audio) return;
  const a = Music.audio;
  const q = (s) => Music.bar.querySelector(s);
  q('.mb-play').textContent = a.paused ? '▶' : '⏸';
  const cur = isFinite(a.currentTime) ? a.currentTime : 0;
  const dur = isFinite(a.duration) && a.duration ? a.duration : 0;
  q('.mb-cur').textContent = fmtTime(cur);
  q('.mb-dur').textContent = dur ? fmtTime(dur) : '--:--';
  q('.mb-fill').style.width = (dur ? (cur / dur) * 100 : 0) + '%';
  updateLyric(cur);
}

function musicMarkPlaying() {
  const cur = Music.queue[Music.qIdx];
  document.querySelectorAll('.mu-row[data-tid]').forEach((r) => {
    r.classList.toggle('playing', !!cur && Number(r.dataset.tid) === cur.id);
  });
  // 曲目在多个区块出现（全部歌曲 / 专辑），统一刷新
}

async function musicRestore() { // 上次会话的续播：只装填不自动播（浏览器策略不允许自动出声）；顺带拉播放统计/喜欢列表
  api('/api/music/stats').then((st) => { Music.plays = st.plays || {}; Music.likes = new Set(st.likes || []); }).catch(() => {});
  if (Music.queue.length) return;
  try {
    const st = await api('/api/music/state');
    if (!st || !st.track) return;
    Music.queue = [st.track];
    Music.qIdx = 0;
    musicShowBar();
    const a = musicAudio();
    Music.bar.querySelector('.mb-cover').src = musicCoverUrl(st.track, 128);
    Music.bar.querySelector('.mb-cover').onerror = (e) => { e.target.onerror = null; e.target.src = albCoverFallback(st.track.album, st.track.artist); };
    Music.bar.querySelector('.mb-title').textContent = st.track.title || '未知曲目';
    Music.bar.querySelector('.mb-artist').textContent = [st.track.artist, st.track.album].filter(Boolean).join(' · ');
    a.src = '/api/music/stream/' + st.track.id;
    if (st.position > 0) {
      a.addEventListener('loadedmetadata', () => { try { a.currentTime = Math.min(st.position, a.duration || st.position); } catch { /* ignore */ } }, { once: true });
    }
    musicUpdateBar();
  } catch { /* ignore */ }
}

const musicRowHtml = (t, idx, showAlbum = true) => `
  <div class="mu-row${Music.queue[Music.qIdx] && Music.queue[Music.qIdx].id === t.id ? ' playing' : ''}" data-tid="${t.id}">
    <span class="t-idx">${Music.queue[Music.qIdx] && Music.queue[Music.qIdx].id === t.id ? '♪' : (idx + 1)}</span>
    <span class="t-title"><img class="t-cov" loading="lazy" decoding="async" src="${musicCoverUrl(t, 96)}" onerror="this.remove()" alt="" /><span class="tt">${esc(t.title || '未知曲目')}</span></span>
    <span class="t-dim">${esc(t.artist || '')}</span>
    ${showAlbum ? `<span class="t-dim t-album">${esc(t.album || '')}</span>` : ''}
    <span class="t-dim t-dur">${fmtTime(t.duration)}</span>
    <button class="mu-like${Music.likes.has(t.id) ? ' on' : ''}" data-like="${t.id}" title="喜欢">${Music.likes.has(t.id) ? '❤' : '♡'}</button>
    <button class="mu-addpl" data-addpl="${t.id}" title="添加到歌单">＋</button>
  </div>`;

function bindMusicRows(scope, getQueue) {
  scope.querySelectorAll('.mu-like[data-like]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const id = Number(b.dataset.like);
      const on = !Music.likes.has(id);
      Music.likes[on ? 'add' : 'delete'](id);
      b.classList.toggle('on', on);
      b.textContent = on ? '❤' : '♡';
      await api('/api/music/like', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, on }) }).catch(() => {});
    };
  });
  scope.querySelectorAll('.mu-addpl[data-addpl]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      openPlaylistPick(Number(b.dataset.addpl));
    };
  });
  scope.querySelectorAll('.mu-row[data-tid]').forEach((row) => {
    row.onclick = () => {
      const id = Number(row.dataset.tid);
      const list = getQueue();
      const idx = list.findIndex((t) => t.id === id);
      musicPlayQueue(list, idx >= 0 ? idx : 0);
    };
  });
}

/* ---- 歌单弹窗：加入歌单 / 挑选歌曲 ---- */
function muModal(title, bodyHtml) {
  // 弹窗内滚动会串链到背后页面（歌库长列表尤其明显），关闭时把页面滚动还原到打开前位置
  const keepY = window.scrollY;
  const mask = document.createElement('div');
  mask.className = 'mu-modal-mask';
  mask.innerHTML = `<div class="mu-modal"><div class="mu-modal-head"><span>${esc(title)}</span><button class="mu-modal-x" title="关闭">✕</button></div><div class="mu-modal-body">${bodyHtml}</div></div>`;
  const close = () => { mask.remove(); window.scrollTo(0, keepY); };
  mask.onclick = (e) => { if (e.target === mask) close(); };
  mask.querySelector('.mu-modal-x').onclick = close;
  document.body.appendChild(mask);
  return mask;
}

// 歌曲行「＋」：选择加入哪个歌单（可就地新建）
async function openPlaylistPick(trackId) {
  const plRes = await api('/api/music/playlists').catch(() => ({ playlists: [] }));
  const pls = plRes.playlists || [];
  const mask = muModal('添加到歌单', `
    <button id="mpl-new" class="mpl-new">＋ 新建歌单</button>
    <div class="mpl-list">${pls.length ? pls.map((p) => `
      <div class="mpl-item" data-pid="${p.id}">
        <span class="mpl-cover">♪</span>
        <span class="mpl-name">${esc(p.name)}</span>
        <span class="mpl-count">${p.cnt || 0} 首</span>
      </div>`).join('') : '<div class="empty-hint">还没有歌单，先新建一个吧。</div>'}</div>`);
  mask.querySelector('#mpl-new').onclick = async () => {
    const name = prompt('歌单名称');
    if (!name || !name.trim()) return;
    const r = await api('/api/music/playlists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) }).catch(() => null);
    const pid = r && r.playlist ? r.playlist.id : null;
    if (pid) {
      await api('/api/music/playlists/' + pid + '/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: trackId }) }).catch(() => {});
      delete PAGE_CACHE.music; // eu：歌单已变，音乐中心缓存作废
      mask.remove();
      toast(`已创建歌单「${name.trim()}」并加入 1 首`);
    } else { mask.remove(); openPlaylistPick(trackId); }
  };
  mask.querySelectorAll('.mpl-item').forEach((it) => {
    it.onclick = async () => {
      await api('/api/music/playlists/' + it.dataset.pid + '/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: trackId }) }).catch(() => {});
      delete PAGE_CACHE.music; // eu：歌单内容已变，音乐中心缓存作废
      const name = it.querySelector('.mpl-name').textContent;
      mask.remove();
      toast('已添加到歌单「' + name + '」');
    };
  });
}

// 歌单详情页「＋ 添加歌曲」：搜索并批量点选加入
async function openTrackPicker(pid, existingIds) {
  const tRes = await api('/api/music/tracks').catch(() => ({ tracks: [] }));
  const all = tRes.tracks || [];
  const mask = muModal('添加歌曲到歌单', `
    <input id="mtp-q" class="mtp-q" type="text" placeholder="🔍 搜索歌名 / 歌手 / 专辑" />
    <div class="mtp-list" id="mtp-list"></div>`);
  // 关闭弹窗后 resolve，方便调用方刷新歌单页
  const closed = new Promise((resolve) => {
    mask.querySelector('.mu-modal-x').addEventListener('click', () => resolve());
    mask.addEventListener('click', (e) => { if (e.target === mask) resolve(); });
  });
  const render = () => {
    const q = mask.querySelector('#mtp-q').value.trim().toLowerCase();
    const list = all.filter((t) => !q || ((t.title || '') + ' ' + (t.artist || '') + ' ' + (t.album || '')).toLowerCase().includes(q));
    mask.querySelector('#mtp-list').innerHTML = list.length ? list.map((t) => `
      <div class="mtp-item${existingIds.has(t.id) ? ' added' : ''}" data-tid="${t.id}">
        <span class="mtp-title">${esc(t.title || '未知曲目')}</span>
        <span class="mtp-dim">${esc(t.artist || '')}</span>
        <span class="mtp-act">${existingIds.has(t.id) ? '已添加 ✓' : '＋ 添加'}</span>
      </div>`).join('') : '<div class="empty-hint">没有匹配的歌曲。</div>';
    mask.querySelectorAll('.mtp-item:not(.added)').forEach((it) => {
      it.onclick = async () => {
        await api('/api/music/playlists/' + pid + '/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: Number(it.dataset.tid) }) }).catch(() => {});
        delete PAGE_CACHE.music; // eu：歌单内容已变，音乐中心缓存作废
        existingIds.add(Number(it.dataset.tid));
        it.classList.add('added');
        it.querySelector('.mtp-act').textContent = '已添加 ✓';
      };
    });
  };
  mask.querySelector('#mtp-q').oninput = render;
  render();
  await closed;
}

async function doMusicScan() {
  const btns = document.querySelectorAll('#mu-scan');
  btns.forEach((b) => { b.disabled = true; b.textContent = '扫描中…'; });
  try {
    const r = await api('/api/music/scan', { method: 'POST' });
    toast(`扫描完成：新增 ${r.added} · 更新 ${r.updated} · 拒收 ${r.skipped} · 共 ${r.total} 首`);
  } catch (e) { toast('扫描失败：' + e.message); }
  btns.forEach((b) => { b.disabled = false; b.textContent = '扫描入库'; });
  route();
}

function bindMusicManage(scope) {
  scope.querySelectorAll('#mu-pl-new').forEach((pl) => { pl.onclick = async () => {
    const name = prompt('歌单名称');
    if (!name || !name.trim()) return;
    await api('/api/music/playlists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) }).catch(() => {});
    delete PAGE_CACHE.music; // eu：歌单已变，音乐中心缓存作废
    route();
  };
  });
  // 侧边栏歌手/专辑改名（✎ 按钮，避免触发条目跳转）；目录添加/扫描/删除已迁至设置页（gl）
  scope.querySelectorAll('[data-mu-rename]').forEach((b) => {
    b.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const kind = b.dataset.muRename, oldName = b.dataset.old;
      const label = kind === 'artist' ? '歌手' : '专辑';
      const name = prompt(`将${label}「${oldName}」重命名为：`, oldName);
      if (!name || !name.trim() || name.trim() === oldName) return;
      try {
        const r = await api('/api/music/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, from: oldName, to: name.trim() }) });
        toast(`已重命名${label}「${oldName}」→「${name.trim()}」（${r.changed || 0} 首歌曲更新）`);
        route();
      } catch (err) { toast('重命名失败：' + err.message); }
    };
  });
}

// ---- 音乐中心共享侧栏：发现页与子页（专辑/歌手/我喜欢/歌单）复用 ----
async function musicNavData() {
  const [tracksRes, rootsRes, plRes] = await Promise.all([
    api('/api/music/tracks').catch(() => ({ tracks: [] })),
    api('/api/music/roots').catch(() => ({ roots: [] })),
    api('/api/music/playlists').catch(() => ({ playlists: [] })),
  ]);
  const tracks = tracksRes.tracks || [];
  const albums = [];
  const byAlb = new Map();
  const artists = [];
  const byArt = new Map();
  for (const t of tracks) {
    const ak = t.album || '单曲';
    if (!byAlb.has(ak)) { const a = { name: ak, tracks: [] }; byAlb.set(ak, a); albums.push(a); }
    byAlb.get(ak).tracks.push(t);
    const gk = (t.artist || '').trim() || '未知歌手';
    if (!byArt.has(gk)) { const g = { name: gk, tracks: [], albums: new Set() }; byArt.set(gk, g); artists.push(g); }
    byArt.get(gk).tracks.push(t);
    byArt.get(gk).albums.add(ak);
  }
  /* gk：侧栏专辑/歌手按「从新到旧」排——组内最近入库的曲目 id 越大代表越新 */
  const maxId = (arr) => arr.reduce((m, t) => Math.max(m, t.id || 0), 0);
  albums.sort((a, b) => maxId(b.tracks) - maxId(a.tracks));
  artists.sort((a, b) => maxId(b.tracks) - maxId(a.tracks));
  return { tracks, albums, artists, roots: rootsRes.roots || [], playlists: plRes.playlists || [] };
}

function musicSideHtml(nav, active) {
  const on = (h) => (h === active ? ' active' : '');
  /* gk：每组最多露 10 个（新到旧），超出部分默认收起，靠右「更多>>」展开/收起；
     DOM 全量渲染、CSS nth-child 截断，展开只切状态类，不重渲染 */
  const moreBtn = (kind, total) => total > 10
    ? `<div class="mu-side-more-row"><button type="button" class="mu-side-more" data-mu-more="${kind}">更多 &gt;&gt;</button></div>` : '';
  return `
      <aside class="mu-side">
        <div class="mu-side-title">音乐中心</div>
        <a class="mu-side-item${on('#/music')}" data-go="#/music">🎧 发现音乐</a>
        <a class="mu-side-item${on('#/music/all')}" data-go="#/music/all">☰ 全部歌曲</a>
        <a class="mu-side-item${on('#/music/likes')}" data-go="#/music/likes">♥ 我喜欢的音乐${Music.likes.size ? `（${Music.likes.size}）` : ''}</a>
        <div class="mu-side-sub">在线热歌</div>
        <a class="mu-side-item${on('#/music/online/cn')}" data-go="#/music/online/cn">🔥 华语热歌榜</a>
        <a class="mu-side-item${on('#/music/online/eu')}" data-go="#/music/online/eu">🌍 欧美热歌榜</a>
        ${nav.albums.length ? `<div class="mu-side-sub">专辑（${nav.albums.length}）</div>
        <div class="mu-side-albums" data-mu-group="albums">${nav.albums.map((a) => `<a class="mu-side-item mu-alb${on('#/music/album/' + encodeURIComponent(a.name))}" data-go="#/music/album/${encodeURIComponent(a.name)}" title="${esc(a.name)}"><span class="mu-side-txt">${esc(a.name)}</span><button class="mu-rename" data-mu-rename="album" data-old="${esc(a.name)}" title="重命名专辑">✎</button></a>`).join('')}</div>
        ${moreBtn('albums', nav.albums.length)}` : ''}
        ${nav.artists.length > 1 ? `<div class="mu-side-sub">歌手（${nav.artists.length}）</div>
        <div class="mu-side-albums" data-mu-group="artists">${nav.artists.map((g) => `<a class="mu-side-item mu-alb${on('#/music/artist/' + encodeURIComponent(g.name))}" data-go="#/music/artist/${encodeURIComponent(g.name)}" title="${esc(g.name)}"><span class="mu-side-txt">${esc(g.name)}</span><button class="mu-rename" data-mu-rename="artist" data-old="${esc(g.name)}" title="重命名歌手">✎</button></a>`).join('')}</div>
        ${moreBtn('artists', nav.artists.length)}` : ''}
        ${nav.playlists.length ? `<div class="mu-side-sub">歌单（${nav.playlists.length}）</div>
        <div class="mu-side-albums" data-mu-group="playlists">${nav.playlists.map((p) => `<a class="mu-side-item mu-alb${on('#/music/playlist/' + p.id)}" data-go="#/music/playlist/${p.id}" title="${esc(p.name)}">♪ ${esc(p.name)}</a>`).join('')}</div>
        ${moreBtn('playlists', nav.playlists.length)}` : ''}
        <button id="mu-pl-new" class="btn-ghost mu-btn" style="margin-top:10px">＋ 新建歌单</button>
      </aside>`;
}

/* gk：侧栏「更多>>」展开/收起——document 级委托只绑一次 */
if (!window.__muMoreBound) {
  window.__muMoreBound = true;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mu-more]');
    if (!btn) return;
    const row = btn.closest('.mu-side-more-row');
    const group = row && row.previousElementSibling;
    if (!group || !group.classList.contains('mu-side-albums')) return;
    const expanded = group.classList.toggle('mu-expanded');
    btn.innerHTML = expanded ? '收起 &lt;&lt;' : '更多 &gt;&gt;';
  });
}

async function renderMusic(showAll) {
  musicRestore();
  const key = 'music' + (showAll ? ':all' : '');
  const hash = showAll ? '#/music/all' : '#/music';
  const c = PAGE_CACHE[key];
  if (c) { // ei：30 分钟内回来缓存秒出，不闪加载
    drawMusicPage(c.data, showAll);
    pageRefreshBackground(key, musicFetchData, (d) => { if (location.hash === hash) drawMusicPage(d, showAll); });
    return;
  }
  const d = await musicFetchData();
  PAGE_CACHE[key] = { data: d, ts: Date.now() };
  drawMusicPage(d, showAll);
}
async function musicFetchData() {
  const [tracksRes, rootsRes, plRes] = await Promise.all([
    api('/api/music/tracks').catch(() => ({ tracks: [] })),
    api('/api/music/roots').catch(() => ({ roots: [] })),
    api('/api/music/playlists').catch(() => ({ playlists: [] })),
  ]);
  return { tracksRes, rootsRes, plRes };
}
function drawMusicPage(d, showAll) {
  const playlists = d.plRes.playlists || [];
  const roots = d.rootsRes.roots || [];
  const tracks = d.tracksRes.tracks || [];

  // 前端按专辑分组（接口已按 专辑→曲号 排序，保持顺序）
  const albums = [];
  const byName = new Map();
  for (const t of tracks) {
    const key = t.album || '单曲';
    if (!byName.has(key)) { const a = { name: key, tracks: [] }; byName.set(key, a); albums.push(a); }
    const a = byName.get(key);
    a.tracks.push(t);
    if (!a.first) a.first = t;
    if (!a.maxId || t.id > a.maxId) a.maxId = t.id;
    if (t.year && (!a.year || t.year < a.year)) a.year = t.year;
  }

  // 歌手维度（网易云网页版同款导航）：按歌手聚合歌曲与专辑
  const artists = [];
  const byArtist = new Map();
  for (const t of tracks) {
    const key = (t.artist || '').trim() || '未知歌手';
    if (!byArtist.has(key)) { const g = { name: key, tracks: [], albums: new Set() }; byArtist.set(key, g); artists.push(g); }
    const g = byArtist.get(key);
    g.tracks.push(t);
    g.albums.add(t.album || '单曲');
  }
  artists.sort((a, b) => b.tracks.length - a.tracks.length);
  /* gk：侧栏专辑/歌手按「从新到旧」（组内最近入库曲目 id 降序）。
     主内容区专辑墙/歌手墙都是 rotShuffle 乱序或自带 maxId 排序，不受数组顺序影响 */
  albums.sort((a, b) => (b.maxId || 0) - (a.maxId || 0));
  const artMaxId = (g) => g.tracks.reduce((m, t) => Math.max(m, t.id || 0), 0);
  artists.sort((a, b) => artMaxId(b) - artMaxId(a));

  muDiscoverDaily = []; muDiscoverHot = []; // 发现页双卡列表（模块级，见顶部 MU_SONGS 注释）
  let muAllOrder = tracks; // 全部歌曲页展示顺序（4 小时轮换，「播放全部」按同一顺序）
  let main;
  if (!roots.length) {
    main = `
      <div class="mu-empty">
        <div style="font-size:44px;margin-bottom:14px">🎵</div>
        <div style="font-size:17px;font-weight:600;margin-bottom:8px">还没有音乐目录</div>
        <div style="margin-bottom:18px">把 NAS 或本机的音乐文件夹加进来，自动甄选 mp3 / flac / m4a / wav 等音频入库。<br>添加目录 / 扫描入库请到 <a class="mu-side-link" data-go="#/library">设置 › 网盘与本地目录</a></div>
      </div>`;
  } else if (!tracks.length) {
    main = `
      <div class="mu-empty">
        <div style="font-size:44px;margin-bottom:14px">📂</div>
        <div style="font-size:17px;font-weight:600;margin-bottom:8px">目录已添加，还没有入库歌曲</div>
        <div style="margin-bottom:18px">扫描入库请到 <a class="mu-side-link" data-go="#/library">设置 › 网盘与本地目录 › 音乐目录</a>（服务端默认每 6 小时也会自动巡检新文件）。</div>
      </div>`;
  } else if (!showAll) {
    // 发现页（网易云风格）：只露专辑，全部歌曲收进入口按钮
    main = `
      <div class="mu-head"><h2>发现音乐</h2>
        <a class="btn-accent mu-allbtn" data-go="#/music/all" style="margin-left:auto;text-decoration:none;padding:8px 18px">☰ 全部歌曲（${tracks.length}）</a>
      </div>
      ${(() => {
        const daily = rotShuffle(tracks, 31).slice(0, 10); // 4 小时轮换一次，不再按天固定
        const hot = [...tracks].filter((t) => (Music.plays[t.id] || 0) > 0).sort((a, b) => (Music.plays[b.id] || 0) - (Music.plays[a.id] || 0)).slice(0, 10);
        muDiscoverDaily = daily; muDiscoverHot = hot;
        daily.concat(hot).forEach((x) => MU_SONGS.set(String(x.id), x));
        return `
        ${(daily.length || hot.length) ? `<div class="mu-dual">
        ${daily.length ? `<div class="mu-dual-card"><div class="mu-sec-head"><h3 class="mu-sec">每日推荐</h3><button class="mu-sec-play" data-mu-playall="daily" title="一键播放全部">▶ 播放全部</button></div><div class="mu-list">${daily.map((t, i) => musicRowHtml(t, i)).join('')}</div></div>` : ''}
        ${hot.length ? `<div class="mu-dual-card"><div class="mu-sec-head"><h3 class="mu-sec">热歌榜</h3><button class="mu-sec-play" data-mu-playall="hot" title="一键播放全部">▶ 播放全部</button></div><div class="mu-list">${hot.map((t, i) => `
          <div class="mu-row" data-tid="${t.id}">
            <span class="t-idx hot-idx">${i + 1}</span>
            <span class="t-title"><img class="t-cov" loading="lazy" decoding="async" src="${musicCoverUrl(t, 96)}" onerror="this.remove()" alt="" /><span class="tt">${esc(t.title || '未知曲目')}</span></span>
            <span class="t-dim">${esc(t.artist || '')}</span>
            <span class="t-dim">▶ ${Music.plays[t.id]} 次</span>
            <span class="t-dim t-dur">${fmtTime(t.duration)}</span>
            <button class="mu-like${Music.likes.has(t.id) ? ' on' : ''}" data-like="${t.id}">${Music.likes.has(t.id) ? '❤' : '♡'}</button>
          </div>`).join('')}</div></div>` : ''}
        </div>` : ''}`;
      })()}
      <section class="mu-block mu-block-alb">
        <div class="mu-sec-head"><h3 class="mu-sec">专辑</h3>${albums.length > 12 ? `<a class="mu-more" data-go="#/music/albums">更多专辑 ›</a>` : ''}</div>
        <div class="mu-albums">
          ${rotShuffle(albums, 45).slice(0, 12).map((a) => `
            <div class="mu-album" data-go="#/music/album/${encodeURIComponent(a.name)}">
              <div class="mu-cover-wrap">
                <img class="mu-cover" loading="lazy" src="${musicCoverUrl(a.first)}" onerror="this.onerror=null;this.src='${albCoverFallback(a.name, a.tracks[0] && a.tracks[0].artist)}'" alt="" />
                <button class="mu-play-fab" data-playalb="${esc(a.name)}" title="播放专辑">▶</button>
              </div>
              <div class="mu-album-name" title="${esc(a.name)}">${esc(a.name)}</div>
              <div class="mu-album-sub">${esc(a.tracks[0].artist || '')} · ${a.tracks.length} 首${a.year ? ' · ' + a.year : ''}</div>
            </div>`).join('')}
        </div>
      </section>
      ${(() => {
        // 保留「新」的语义：先按入库取最近 24 张，再从中轮换出 12 张（4 小时换一批）
        const fresh = [...albums].sort((a, b) => (b.maxId || 0) - (a.maxId || 0)).slice(0, 24);
        const show = rotShuffle(fresh, 47).slice(0, 12); // 固定 6 列 × 2 整行
        return show.length > 4 ? `<section class="mu-block mu-block-new">
        <div class="mu-sec-head"><h3 class="mu-sec">新碟上架</h3>${albums.length > 12 ? `<a class="mu-more" data-go="#/music/albums">更多 ›</a>` : ''}</div>
        <div class="mu-albums">${show.map((a) => `
          <div class="mu-album" data-go="#/music/album/${encodeURIComponent(a.name)}">
            <div class="mu-cover-wrap">
              <img class="mu-cover" loading="lazy" src="${musicCoverUrl(a.first)}" onerror="this.onerror=null;this.src='${albCoverFallback(a.name, a.tracks[0] && a.tracks[0].artist)}'" alt="" />
              <button class="mu-play-fab" data-playalb="${esc(a.name)}" title="播放专辑">▶</button>
            </div>
            <div class="mu-album-name" title="${esc(a.name)}">${esc(a.name)}</div>
            <div class="mu-album-sub">${a.year ? a.year + ' · ' : ''}${a.tracks.length} 首</div>
          </div>`).join('')}</div>
        </section>` : '';
      })()}
      ${artists.length > 1 ? `<section class="mu-block mu-block-artist">
      <div class="mu-sec-head"><h3 class="mu-sec">歌手</h3>${artists.length > 12 ? `<a class="mu-more" data-go="#/music/artists">更多 ›</a>` : ''}</div>
      <div class="mu-artists">
        ${rotShuffle(artists, 46).slice(0, 12).map((g) => `
          <div class="mu-artist" data-go="#/music/artist/${encodeURIComponent(g.name)}">
            <img class="mu-avatar" loading="lazy" decoding="async" src="/api/music/artist-img/${encodeURIComponent(g.name)}?s=200&v=2" onerror="this.onerror=null;this.src='${musicCoverUrl(g.tracks[0], 200) + '&t=' + encodeURIComponent(g.name)}'" alt="" />
            <div class="mu-artist-name" title="${esc(g.name)}">${esc(g.name)}</div>
            <div class="mu-artist-sub">${g.tracks.length} 首 · ${g.albums.size} 张专辑</div>
          </div>`).join('')}
      </div>
      </section>` : ''}`;
  } else {
    // 全部歌曲列表页（网易云风格工具栏：红色「播放全部」）
    muAllOrder = rotShuffle(tracks, 48); // 4 小时轮换
    main = `
      <div class="mu-head"><h2>全部歌曲</h2><span class="mu-stat">${tracks.length} 首歌曲 · ${albums.length} 张专辑</span>
      </div>
      <div class="mu-toolbar">
        <button id="mu-playall" class="btn-accent">▶ 播放全部</button>
      </div>
      <div class="mu-list">
        <div class="mu-row mu-row-head"><span class="t-idx">#</span><span>歌曲</span><span>歌手</span><span class="t-album">专辑</span><span>时长</span></div>
        ${muAllOrder.map((t, i) => musicRowHtml(t, i)).join('')}
      </div>`;
  }

  $app.innerHTML = `
    <div class="mu-page">
      ${musicSideHtml({ albums, artists, playlists, roots }, showAll ? '#/music/all' : '#/music')}
      <section class="mu-main">${main}</section>
    </div>`;

  const fabPlay = (list) => { if (list.length) musicPlayQueue(list, 0); };
  document.querySelectorAll('.mu-play-fab').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); const a = byName.get(b.dataset.playalb || '单曲'); fabPlay(a ? a.tracks : []); };
  });
  const pa = document.getElementById('mu-playall');
  if (pa) pa.onclick = () => fabPlay(muAllOrder);
  // 每日推荐 / 热歌榜 一键播放全部
  const secPlay = (kind, list) => {
    const b = document.querySelector(`[data-mu-playall="${kind}"]`);
    if (b) b.onclick = (e) => { e.stopPropagation(); fabPlay(list); };
  };
  secPlay('daily', muDiscoverDaily);
  secPlay('hot', muDiscoverHot);
  bindMusicRows(document.getElementById('app'), () => Music.queue.length > 1 ? Music.queue : tracks);
  bindMusicManage(document.getElementById('app'));
}

// 专辑总览页：发现页「更多专辑」入口
async function renderMusicAlbums() {
  musicRestore();
  const nav = await musicNavData();
  const side = musicSideHtml(nav, '#/music/albums');
  // 4 小时轮换：全部专辑页每次进来顺序不同
  const albums = rotShuffle(nav.albums.slice(), 43);
  $app.innerHTML = `
    <div class="mu-page">${side}<section class="mu-main">
      <a class="back-link" data-back="1">‹ 返回</a>
      <div class="mu-head"><h2>全部专辑</h2><span class="mu-stat">${albums.length} 张专辑</span></div>
      <div class="mu-albums">
        ${albums.map((a) => `
          <div class="mu-album" data-go="#/music/album/${encodeURIComponent(a.name)}">
            <div class="mu-cover-wrap">
              <img class="mu-cover" loading="lazy" src="${musicCoverUrl(a.tracks[0])}" onerror="this.onerror=null;this.src='${albCoverFallback(a.name, a.tracks[0] && a.tracks[0].artist)}'" alt="" />
              <button class="mu-play-fab" data-playalb="${esc(a.name)}" title="播放专辑">▶</button>
            </div>
            <div class="mu-album-name" title="${esc(a.name)}">${esc(a.name)}</div>
            <div class="mu-album-sub">${esc(a.tracks[0].artist || '')} · ${a.tracks.length} 首</div>
          </div>`).join('')}
      </div>
    </section></div>`;
  document.querySelectorAll('.mu-play-fab').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const a = albums.find((x) => x.name === (b.dataset.playalb || '单曲'));
      if (a && a.tracks.length) musicPlayQueue(a.tracks, 0);
    };
  });
  bindMusicManage(document.getElementById('app'));
}

async function renderMusicAlbum(name) {
  musicRestore();
  const res = await api('/api/music/album/' + encodeURIComponent(name)).catch(() => ({ tracks: [] }));
  const tracks = res.tracks || [];
  const first = tracks[0];
  if (!first) return void ($app.innerHTML = `<div class="empty-hint">专辑不存在或已空。<a class="back-link" data-back="1">‹ 返回</a></div>`);
  const totalDur = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const nav = await musicNavData();
  const side = musicSideHtml(nav, '#/music/album/' + encodeURIComponent(name));
  $app.innerHTML = `
    <div class="mu-page">${side}<section class="mu-main">
      <a class="back-link" data-back="1">‹ 返回</a>
      <div class="mu-hero">
        <img class="mu-cover" src="${musicCoverUrl(first)}" onerror="this.onerror=null;this.src='${albCoverFallback(name, first.artist)}'" alt="" />
        <div class="mu-hero-info">
          <h2 title="${esc(name)}">${esc(name)}</h2>
          <div class="mu-album-sub">${esc(first.artist || '')} · ${tracks.length} 首${first.year ? ' · ' + first.year : ''}${totalDur ? ' · 共 ' + fmtTime(totalDur) : ''}</div>
          <div style="margin-top:16px;display:flex;gap:10px;align-items:center">
            <button id="mu-play-all" class="btn-play" style="padding:9px 22px;font-size:14px">▶ 播放全部</button>
            <button id="mu-open-folder" class="btn-ghost" style="padding:9px 16px;font-size:15px" title="打开文件夹：查看专辑在 NAS 上的目录">📂</button>
          </div>
        </div>
      </div>
      <div class="mu-list">
        <div class="mu-row mu-row-head"><span class="t-idx">#</span><span>歌曲</span><span>歌手</span><span>时长</span></div>
        ${tracks.map((t, i) => musicRowHtml(t, i, false)).join('')}
      </div>
    </section></div>`;
  playFadeOut(); // eb：fadeNav 渐变进来，专辑/歌手页已渲染就揭开
  document.getElementById('mu-play-all').onclick = () => musicPlayQueue(tracks, 0);
  // 📂 打开文件夹：展示专辑在 NAS 上的目录路径（可复制），浏览器无法直接唤起 NAS 文件管理器
  document.getElementById('mu-open-folder').onclick = async () => {
    const r = await api('/api/music/album-folder/' + encodeURIComponent(name)).catch(() => ({ dirs: [] }));
    const dirs = r.dirs || [];
    const mask = muModal('专辑所在文件夹', dirs.length ? `
      ${dirs.map((d) => `
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <code style="flex:1;word-break:break-all;background:var(--bg-hover,#1c1c26);padding:8px 10px;border-radius:6px;font-size:13px">📂 ${esc(d)}</code>
          <button class="btn-ghost" data-copy="${esc(d)}">复制路径</button>
        </div>`).join('')}
      <div style="color:var(--text-dim);font-size:12px;margin-top:8px">文件夹在 NAS 上，复制路径后可在 SMB 共享或 File Station 中打开。</div>`
      : '<div class="empty-hint">没有找到该专辑的源文件夹</div>');
    mask.querySelectorAll('[data-copy]').forEach((b) => {
      b.onclick = () => {
        navigator.clipboard.writeText(b.dataset.copy).then(() => toast('路径已复制'), () => toast('复制失败，请手动选择路径'));
      };
    });
  };
  bindMusicRows(document.getElementById('app'), () => tracks);
  bindMusicManage(document.getElementById('app'));
}

// 歌手总览页：发现页「更多歌手」入口
async function renderMusicArtists() {
  musicRestore();
  const nav = await musicNavData();
  const side = musicSideHtml(nav, '#/music/artists');
  // 4 小时轮换：全部歌手页每次进来顺序不同（原来固定按曲数排序，每次进页面都一模一样）
  const artists = rotShuffle(nav.artists.slice(), 44);
  $app.innerHTML = `
    <div class="mu-page">${side}<section class="mu-main">
      <a class="back-link" data-back="1">‹ 返回</a>
      <div class="mu-head"><h2>全部歌手</h2><span class="mu-stat">${artists.length} 位歌手</span></div>
      <div class="mu-artists">
        ${artists.map((g) => `
          <div class="mu-artist" data-go="#/music/artist/${encodeURIComponent(g.name)}">
            <img class="mu-avatar" loading="lazy" decoding="async" src="/api/music/artist-img/${encodeURIComponent(g.name)}?s=200&v=2" onerror="this.onerror=null;this.src='${musicCoverUrl(g.tracks[0], 200) + '&t=' + encodeURIComponent(g.name)}'" alt="" />
            <div class="mu-artist-name" title="${esc(g.name)}">${esc(g.name)}</div>
            <div class="mu-artist-sub">${g.tracks.length} 首 · ${g.albums.size} 张专辑</div>
          </div>`).join('')}
      </div>
    </section></div>`;
  bindMusicManage(document.getElementById('app'));
}

// 歌手页（网易云风格）：封面头像 + 热门歌曲 + 专辑网格
async function renderMusicArtist(name) {
  musicRestore();
  const res = await api('/api/music/tracks').catch(() => ({ tracks: [] }));
  const all = res.tracks || [];
  const tracks = all.filter((t) => ((t.artist || '').trim() || '未知歌手') === name);
  if (!tracks.length) return void ($app.innerHTML = `<div class="empty-hint">没有找到该歌手的歌曲。<a class="back-link" data-back="1">‹ 返回</a></div>`);
  const albums = [];
  const byAlb = new Map();
  for (const t of tracks) {
    const key = t.album || '单曲';
    if (!byAlb.has(key)) { const a = { name: key, tracks: [] }; byAlb.set(key, a); albums.push(a); }
    byAlb.get(key).tracks.push(t);
  }
  const nav = await musicNavData();
  const side = musicSideHtml(nav, '#/music/artist/' + encodeURIComponent(name));
  $app.innerHTML = `
    <div class="mu-page">${side}<section class="mu-main">
      <a class="back-link" data-back="1">‹ 返回</a>
      <div class="mu-hero">
        <img class="mu-cover mu-avatar-lg" src="/api/music/artist-img/${encodeURIComponent(name)}?s=420&v=2" onerror="this.onerror=null;this.src='${musicCoverUrl(tracks[0], 420) + '&t=' + encodeURIComponent(name)}'" alt="" />
        <div class="mu-hero-info">
          <h2 title="${esc(name)}">${esc(name)}</h2>
          <div class="mu-album-sub">${tracks.length} 首歌曲 · ${albums.length} 张专辑</div>
          <div style="margin-top:16px"><button id="mu-play-all" class="btn-accent" style="padding:9px 22px;font-size:14px">▶ 播放全部歌曲</button></div>
        </div>
      </div>
      <h3 class="mu-sec">热门歌曲</h3>
      <div class="mu-list">
        <div class="mu-row mu-row-head"><span class="t-idx">#</span><span>歌曲</span><span>专辑</span><span>时长</span></div>
        ${tracks.map((t, i) => `<div class="mu-row${Music.queue[Music.qIdx] && Music.queue[Music.qIdx].id === t.id ? ' playing' : ''}" data-tid="${t.id}">
          <span class="t-idx">${Music.queue[Music.qIdx] && Music.queue[Music.qIdx].id === t.id ? '♪' : (i + 1)}</span>
          <span class="t-title">${esc(t.title || '未知曲目')}</span>
          <span class="t-dim t-album">${esc(t.album || '')}</span>
          <span class="t-dim t-dur">${fmtTime(t.duration)}</span></div>`).join('')}
      </div>
      ${albums.length ? `<h3 class="mu-sec">专辑</h3>
      <div class="mu-albums">
        ${albums.map((a) => `
          <div class="mu-album" data-go="#/music/album/${encodeURIComponent(a.name)}">
            <div class="mu-cover-wrap">
              <img class="mu-cover" loading="lazy" src="${musicCoverUrl(a.tracks[0])}" onerror="this.onerror=null;this.src='${albCoverFallback(a.name, a.tracks[0] && a.tracks[0].artist)}'" alt="" />
              <button class="mu-play-fab" data-playalb="${esc(a.name)}" title="播放专辑">▶</button>
            </div>
            <div class="mu-album-name" title="${esc(a.name)}">${esc(a.name)}</div>
            <div class="mu-album-sub">${a.tracks.length} 首</div>
          </div>`).join('')}
      </div>` : ''}
    </section></div>`;
  playFadeOut(); // eb：fadeNav 渐变进来，专辑/歌手页已渲染就揭开
  document.getElementById('mu-play-all').onclick = () => musicPlayQueue(tracks, 0);
  document.querySelectorAll('.mu-play-fab').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); const a = byAlb.get(b.dataset.playalb || '单曲'); if (a && a.tracks.length) musicPlayQueue(a.tracks, 0); };
  });
  bindMusicRows(document.getElementById('app'), () => tracks);
  bindMusicManage(document.getElementById('app'));
}

// 我喜欢的音乐（网易云红心歌单）
/* ---------------- 在线热歌（网易云榜单 + 免费直链试听，移植自「流行歌曲在线听」） ---------------- */
const MU_ONLINE_GENRES = {
  cn: [['pop', '流行'], ['qing', '抒情'], ['folk', '民谣'], ['rock', '摇滚']],
  eu: [['pop', '流行'], ['jazz', '爵士'], ['blues', '蓝调'], ['rock', '摇滚']],
};
const MU_ONLINE_LABELS = { cn: '华语热歌榜', eu: '欧美热歌榜' };
const muOnlineCache = {};   // 'cn|pop' -> chart 数据，切换流派不重复请求
const muOnlineCur = { cn: 'pop', eu: 'pop' };

function onlineQueueOf(songs) {
  // 在线曲目 → 播放队列对象（服务端按需解析直链后播放）
  return (songs || []).map((s, i) => ({
    online: true, id: 'on-' + i + '-' + (s.name || '').slice(0, 20),
    title: s.name || '未知曲目', artist: s.artist || '', album: s.from || '',
    pic: s.pic || '', duration: (s.duration || 0) / 1000,
  }));
}

async function renderMusicOnline(region) {
  if (region !== 'eu') region = 'cn';
  musicRestore();
  const nav = await musicNavData();
  const side = musicSideHtml(nav, '#/music/online/' + region);
  const genre = muOnlineCur[region] || 'pop';
  const genres = MU_ONLINE_GENRES[region];
  const label = MU_ONLINE_LABELS[region];
  $app.innerHTML = `
    <div class="mu-page">${side}<section class="mu-main">
      <a class="back-link" data-back="1">‹ 返回</a>
      <div class="mu-hero">
        <div class="mu-cover mu-avatar-lg" style="display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,${region === 'cn' ? '#e5504d,#8b1e24' : '#3d6fd6,#1c2f6b'});font-size:64px;color:#fff">${region === 'cn' ? '🔥' : '🌍'}</div>
        <div class="mu-hero-info">
          <h2>${label} <span class="mu-stat" id="mu-on-date"></span></h2>
          <div class="mu-album-sub" id="mu-on-stat">加载中…</div>
          <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            ${genres.map(([g, gl]) => `<button class="btn-ghost mu-on-genre${g === genre ? ' btn-accent' : ''}" data-on-genre="${g}" style="width:auto;padding:6px 14px;font-size:13px">${gl}</button>`).join('')}
            <button id="mu-on-playall" class="btn-accent" style="margin-left:14px;padding:9px 20px;font-size:14px">▶ 播放全部</button>
            <button id="mu-on-shuffle" class="btn-ghost" style="width:auto;padding:9px 16px;font-size:14px">🔀 随机播放</button>
          </div>
        </div>
      </div>
      <div class="mu-list" id="mu-on-list"><div class="empty-hint">榜单加载中…</div></div>
    </section></div>`;
  bindMusicManage(document.getElementById('app'));
  $app.querySelectorAll('.mu-on-genre').forEach((b) => {
    b.onclick = () => {
      muOnlineCur[region] = b.dataset.onGenre;
      renderMusicOnline(region);   // 数据有 muOnlineCache，切换秒开
    };
  });
  const ckey = region + '|' + genre;
  let data = muOnlineCache[ckey];
  if (!data) {
    document.getElementById('mu-on-list').innerHTML = '<div class="empty-hint">⏬ 榜单抓取中（首次约需 10~30 秒，之后当天秒开）…</div>';
    data = await api('/api/music/online/chart?region=' + region + '&genre=' + genre).catch(() => null);
    if (location.hash !== '#/music/online/' + region) return;   // 用户已离开
    if (data && data.ok && data.songs?.length) muOnlineCache[ckey] = data;
  }
  const songs = (data && data.songs) || [];
  const listEl = document.getElementById('mu-on-list');
  if (!songs.length) {
    listEl.innerHTML = '<div class="empty-hint">榜单加载失败，请检查 NAS 网络后 <button class="btn-ghost" id="mu-on-retry" style="width:auto;padding:4px 12px">↻ 重试</button></div>';
    document.getElementById('mu-on-stat').textContent = '加载失败';
    const rt = document.getElementById('mu-on-retry');
    if (rt) rt.onclick = () => renderMusicOnline(region);
    return;
  }
  document.getElementById('mu-on-date').textContent = data.date ? '（更新 ' + data.date + '）' : '';
  let stat = `共 ${songs.length} 首 · 来源：${esc(data.source || '网易云')}`;
  if (data.blocked) stat += ` · 已屏蔽 ${data.blocked} 首付费/VIP`;
  if (data.removed) stat += ` · 已剔除 ${data.removed} 首无版权`;
  if (data.from_cache) stat += ' · 今日缓存';
  document.getElementById('mu-on-stat').innerHTML = stat;
  listEl.innerHTML = `
    <div class="mu-row mu-row-head"><span class="t-idx">#</span><span>歌曲</span><span>歌手</span><span>来源</span><span>时长</span></div>
    ${songs.map((s, i) => `
      <div class="mu-row" data-on-idx="${i}">
        <span class="t-idx ${i < 3 ? 'hot-idx' : ''}">${i + 1}</span>
        <span class="t-title"><img class="t-cov" loading="lazy" decoding="async" src="${esc(s.pic || '')}" onerror="this.remove()" alt="" /><span class="tt">${esc(s.name || '')}</span></span>
        <span class="t-dim">${esc(s.artist || '')}</span>
        <span class="t-dim">${esc(s.from || '')}</span>
        <span class="t-dim t-dur">${s.duration ? fmtTime(Math.round(s.duration / 1000)) : '--:--'}</span>
        <button class="mu-play-fab-inline" title="播放">▶</button>
      </div>`).join('')}`;
  const queue = onlineQueueOf(songs);
  const playAt = (i) => musicPlayQueue(queue, i);
  listEl.querySelectorAll('.mu-row[data-on-idx]').forEach((row) => {
    row.onclick = () => playAt(parseInt(row.dataset.onIdx, 10));
  });
  document.getElementById('mu-on-playall').onclick = () => playAt(0);
  document.getElementById('mu-on-shuffle').onclick = () => {
    musicSetMode('shuffle');
    playAt(Math.floor(Math.random() * queue.length));
  };
}

async function renderMusicLikes() {
  musicRestore();
  const res = await api('/api/music/likes').catch(() => ({ tracks: [] }));
  const tracks = res.tracks || [];
  const nav = await musicNavData();
  const side = musicSideHtml(nav, '#/music/likes');
  $app.innerHTML = `
    <div class="mu-page">${side}<section class="mu-main">
      <a class="back-link" data-back="1">‹ 返回</a>
      <div class="mu-hero">
        <div class="mu-cover mu-avatar-lg" style="display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#ec4141,#8b1e24);font-size:64px;color:#fff">♥</div>
        <div class="mu-hero-info">
          <h2>我喜欢的音乐</h2>
          <div class="mu-album-sub">${tracks.length} 首歌曲</div>
          ${tracks.length ? `<div style="margin-top:16px"><button id="mu-play-all" class="btn-accent" style="padding:9px 22px;font-size:14px">▶ 播放全部</button></div>` : ''}
        </div>
      </div>
      ${tracks.length ? `<div class="mu-list">
        <div class="mu-row mu-row-head"><span class="t-idx">#</span><span>歌曲</span><span>歌手</span><span>专辑</span><span>时长</span></div>
        ${tracks.map((t, i) => musicRowHtml(t, i)).join('')}
      </div>` : '<div class="empty-hint">还没有喜欢的歌曲，在歌曲行点 ♡ 收藏吧。</div>'}
    </section></div>`;
  const pa = document.getElementById('mu-play-all');
  if (pa) pa.onclick = () => musicPlayQueue(tracks, 0);
  bindMusicRows(document.getElementById('app'), () => tracks);
  bindMusicManage(document.getElementById('app'));
}

// 歌单详情页
async function renderMusicPlaylist(idText) {
  musicRestore();
  const pid = parseInt(idText, 10);
  const [plRes, trRes] = await Promise.all([
    api('/api/music/playlists').catch(() => ({ playlists: [] })),
    api('/api/music/playlists/' + pid + '/tracks').catch(() => ({ tracks: [] })),
  ]);
  const meta = (plRes.playlists || []).find((p) => p.id === pid);
  if (!meta) return void ($app.innerHTML = `<div class="empty-hint">歌单不存在。<a class="back-link" data-back="1">‹ 返回</a></div>`);
  let tracks = trRes.tracks || [];
  if (kfM) {
    const all = await api('/api/music/tracks').catch(() => ({ tracks: [] }));
    const byId = new Map((all.tracks || []).map((t) => [t.id, t]));
    tracks = tracks.filter((t) => { const full = byId.get(t.id) || t; return kfM.has(full.root_id); });
  }
  const nav = await musicNavData();
  const side = musicSideHtml(nav, '#/music/playlist/' + pid);
  $app.innerHTML = `
    <div class="mu-page">${side}<section class="mu-main">
      <a class="back-link" data-back="1">‹ 返回</a>
      <div class="mu-hero">
        <div class="mu-cover mu-avatar-lg" style="display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#2d1f3e,#16323f);font-size:64px;color:#fff">♪</div>
        <div class="mu-hero-info">
          <h2 title="${esc(meta.name)}">${esc(meta.name)}</h2>
          <div class="mu-album-sub">歌单 · ${tracks.length} 首歌曲</div>
          <div style="margin-top:16px;display:flex;gap:10px">
            <button id="mu-pl-add" class="btn-accent" style="padding:9px 22px;font-size:14px">＋ 添加歌曲</button>
            ${tracks.length ? `<button id="mu-play-all" class="btn-ghost" style="padding:9px 18px;font-size:14px">▶ 播放全部</button>
            <button id="mu-pl-del" class="btn-ghost" style="padding:9px 18px;font-size:14px">删除歌单</button>` : ''}
          </div>
        </div>
      </div>
      ${tracks.length ? `<div class="mu-list">
        <div class="mu-row mu-row-head"><span class="t-idx">#</span><span>歌曲</span><span>歌手</span><span>专辑</span><span>时长</span></div>
        ${tracks.map((t, i) => `
          <div class="mu-row" data-tid="${t.id}">
            <span class="t-idx">${i + 1}</span>
            <span class="t-title">${esc(t.title || '未知曲目')}</span>
            <span class="t-dim">${esc(t.artist || '')}</span>
            <span class="t-dim t-album">${esc(t.album || '')}</span>
            <span class="t-dim t-dur">${fmtTime(t.duration)}</span>
            <span></span>
            <button class="mu-plrm" data-plrm="${t.id}" title="从歌单移除">✕</button>
          </div>`).join('')}
      </div>` : '<div class="empty-hint">歌单还是空的，点上方「＋ 添加歌曲」把喜欢的歌加进来吧。</div>'}
    </section></div>`;
  const pa = document.getElementById('mu-play-all');
  if (pa) pa.onclick = () => musicPlayQueue(tracks, 0);
  const pdel = document.getElementById('mu-pl-del');
  if (pdel) pdel.onclick = async () => {
    if (!confirm('删除歌单「' + meta.name + '」？')) return;
    await api('/api/music/playlists/' + pid, { method: 'DELETE' }).catch(() => {});
    delete PAGE_CACHE.music; // eu：歌单已删，音乐中心缓存作废（否则 30 分钟内回来会「复活」）
    location.hash = '#/music';
  };
  document.querySelectorAll('.mu-plrm').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      await api('/api/music/playlists/' + pid + '/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: Number(b.dataset.plrm) }) }).catch(() => {});
      delete PAGE_CACHE.music; // eu：歌单内容已变，音乐中心缓存作废
      renderMusicPlaylist(String(pid));
    };
  });
  const padd = document.getElementById('mu-pl-add');
  if (padd) padd.onclick = async () => {
    await openTrackPicker(pid, new Set(tracks.map((t) => t.id)));
    renderMusicPlaylist(String(pid));
  };
  bindMusicRows(document.getElementById('app'), () => tracks);
  bindMusicManage(document.getElementById('app'));
}

/* ---------------- 书架（电子书） ---------------- */
const bkCover = (b, s) => '/api/books/cover/' + b.id + '?s=' + (s || 360);
// 作者归一化：空 / Unknown → 统一按「未知作者」展示
const bkAuthor = (b) => { const a = String(b.author || '').trim(); return /^unknown$/i.test(a) ? '' : a; };
const bkAuthorDisp = (b) => bkAuthor(b) || '未知作者';
const bkFontKey = 'bk-fontsize';

const Books = { tts: { on: false, paused: false } };
let bkTtsSeq = 0; // 朗读会话代币：翻页重开朗读时旧 speakNext 闭包链必须自灭，否则旧页内容继续进队列

/* ---- 有声朗读（Web Speech Synthesis，浏览器离线 TTS） ---- */
function bkTtsSupported() { return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined'; }
function bkChunkText(text) {
  // 长文本按句切成 ≤180 字的小段（部分引擎对长 utterance 会截断）
  const parts = text.replace(/\n+/g, '\n').split(/(?<=[。！？；\n])/);
  const out = [];
  let cur = '';
  for (let p of parts) {
    p = p.trim();
    if (!p) continue;
    if (p.length > 180) { // 超长段硬切
      if (cur) { out.push(cur); cur = ''; }
      for (let i = 0; i < p.length; i += 180) out.push(p.slice(i, i + 180));
      continue;
    }
    if ((cur + p).length > 180) { out.push(cur); cur = p; }
    else cur += p;
  }
  if (cur) out.push(cur);
  return out;
}
function bookStopTts() {
  Books.tts.on = false; Books.tts.paused = false;
  bkTtsSeq++; // 递增代币：在途的旧 onend→speakNext 链全部失效
  if (bkTtsSupported()) {
    // Chrome 怪癖：暂停态下直接 cancel() 可能不清空朗读队列，先 resume 再 cancel
    try { speechSynthesis.resume(); } catch { /* ignore */ }
    try { speechSynthesis.cancel(); } catch { /* ignore */ }
  }
  bkTtsButtons();
}

/* 当前页实际可见文本（翻页模式取本页，滚动模式取整章）——朗读内容与页面绑定 */
function bkCurPageText() {
  const el = document.getElementById('bk-content');
  if (!el) return '';
  if (!el.classList.contains('paged')) return el.textContent || '';
  const elRect = el.getBoundingClientRect();
  const left = el.scrollLeft + 2, right = el.scrollLeft + el.clientWidth - 2;
  const out = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.textContent.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = range.getClientRects();
    for (const r of rects) {
      const nl = r.left - elRect.left + el.scrollLeft;
      const nr = nl + r.width;
      if (nr > left && nl < right) { out.push(node.textContent.trim()); break; }
    }
  }
  return out.join(' ');
}
function bookSpeak(text) {
  if (!bkTtsSupported()) { toast('当前浏览器不支持语音朗读'); return; }
  bookStopTts();
  const seq = ++bkTtsSeq; // 本会话代币
  const rate = Number(localStorage.getItem('bk-rate') || '1') || 1;
  const chunks = bkChunkText(text);
  if (!chunks.length) { bkTtsButtons(); return; }
  Books.tts.on = true;
  const pickVoice = () => speechSynthesis.getVoices().find((v) => /zh[-_]CN/i.test(v.lang)) || speechSynthesis.getVoices().find((v) => /zh/i.test(v.lang)) || null;
  let idx = 0;
  const speakNext = () => {
    if (seq !== bkTtsSeq) return; // 旧会话：翻页/停止后不再续播，防止读上一页内容
    if (!Books.tts.on || idx >= chunks.length) { bookStopTts(); return; }
    const u = new SpeechSynthesisUtterance(chunks[idx++]);
    u.lang = 'zh-CN'; u.rate = rate; u.volume = 1;
    const v = pickVoice(); if (v) u.voice = v;
    u.onend = () => speakNext();
    u.onerror = () => speakNext();
    speechSynthesis.speak(u);
  };
  speechSynthesis.onvoiceschanged = () => {}; // 触发一次语音列表加载
  // Chrome：cancel() 是异步生效的，紧跟着 speak() 的新utterance会被吞或与旧队列交叠——
  // 延迟起播让 cancel 先落地（代币校验保证期间再翻页也不会双重开播）
  setTimeout(speakNext, 80);
  bkTtsButtons();
}
function bookTtsToggle() {
  if (!Books.tts.on) {
    const text = bkCurPageText();
    if (!text.trim()) return;
    bookSpeak(text);
  } else if (Books.tts.paused) {
    Books.tts.paused = false; try { speechSynthesis.resume(); } catch { /* ignore */ }
  } else {
    Books.tts.paused = true; try { speechSynthesis.pause(); } catch { /* ignore */ }
  }
  bkTtsButtons();
}
function bkTtsButtons() {
  const b = document.querySelector('#bk-tts');
  if (!b) return;
  b.textContent = Books.tts.on ? (Books.tts.paused ? '▶ 继续朗读' : '⏸ 暂停朗读') : '🔊 朗读本章';
  const s = document.querySelector('#bk-tts-stop');
  if (s) s.classList.toggle('hidden', !Books.tts.on);
}

/* ---- 书架中心（发现页 + 最近阅读/全部/作者子页，与音乐/影视同版式） ---- */
async function renderBooks() {
  const h = location.hash;
  if (h.startsWith('#/books/reading')) return renderBooksCenter('reading');
  if (h.startsWith('#/books/all')) return renderBooksCenter('all');
  const cm = h.match(/^#\/books\/cat\/(.+)$/);
  if (cm) return renderBooksCenter('cat', decodeURIComponent(cm[1]));
  const am = h.match(/^#\/books\/author\/(.+)$/);
  if (am) return renderBooksCenter('author', decodeURIComponent(am[1]));
  return renderBooksCenter('landing');
}

async function renderBooksCenter(view, author) {
  const key = 'books';
  const hash = location.hash;
  const c = PAGE_CACHE[key];
  if (c) { // ei：30 分钟内回来缓存秒出，不闪加载（书架/最近阅读/全部图书/作者页共享数据）
    drawBooksPage(c.data.data, c.data.pr, view, author);
    pageRefreshBackground(key, booksFetchData, (d) => { if (location.hash === hash) drawBooksPage(d[0], d[1], view, author); });
    return;
  }
  let data, pr;
  try { [data, pr] = await booksFetchData(); }
  catch (e) { $app.innerHTML = `<div class="empty-hint">书架加载失败：${esc(e.message)}</div>`; return; }
  PAGE_CACHE[key] = { data: { data, pr }, ts: Date.now() };
  drawBooksPage(data, pr, view, author);
}
async function booksFetchData() {
  return Promise.all([api('/api/books'), api('/api/books/progress')]);
}
function drawBooksPage(data, pr, view, author) {
  const all = data.books || [];
  const progMap = new Map((pr.items || []).map((x) => [x.bookId, x]));
  const pctOf = (b) => {
    const p = progMap.get(b.id);
    return p && b.max_ch > 0 ? Math.round(((p.chapterIdx + p.pos) / (b.max_ch + 1)) * 100) : 0;
  };

  const card = (b) => {
    const pct = pctOf(b);
    return `
    <div class="bk-book" data-bid="${b.id}" data-go="#/book/${b.id}" title="${esc(b.title)}">
      <div class="bk-cover-wrap">
        <img class="bk-cover" src="${bkCover(b)}" alt="" loading="lazy" />
        ${pct > 0 ? `<span class="bk-pct">${pct}%</span>` : ''}
      </div>
      <div class="bk-name">${esc(b.title)}</div>
      <div class="bk-sub">${esc(bkAuthorDisp(b))} · ${(b.format || '').toUpperCase()}</div>
    </div>`;
  };
  const reading = all.filter((b) => progMap.has(b.id))
    .sort((a, b) => (progMap.get(b.id).updatedAt || 0) - (progMap.get(a.id).updatedAt || 0));
  const newest = all.slice().sort((a, b) => (b.last_seen_at || 0) - (a.last_seen_at || 0));

  // 双列卡片（与音乐/影视「最新上架/最受好评」同款：红细边框 + 斑马纹 + 红色细体序号）
  const bkDualCard = (title, sub, items, emptyText) => `
    <div class="mu-dual-card">
      <h3 class="mu-sec">${esc(title)}<span class="mv-sec-sub">${esc(sub)}</span></h3>
      ${items.length ? `<div class="mu-list">${items.slice(0, 6).map((b, i) => {
        const pct = pctOf(b);
        const meta = [bkAuthorDisp(b), (b.format || '').toUpperCase(), pct ? '读到 ' + pct + '%' : ''].filter(Boolean).join(' · ');
        return `<div class="mu-row mv-row" data-go="#/book/${b.id}" title="${esc(b.title)}">
          <span class="t-idx">${i + 1}</span>
          <span class="mv-thumb">📚<img loading="lazy" src="${bkCover(b)}" alt="" onerror="this.remove()"></span>
          <span class="t-title">${esc(b.title)}</span>
          <span class="t-dim mv-meta">${esc(meta)}</span>
        </div>`;
      }).join('')}</div>` : `<div class="empty-hint">${esc(emptyText)}</div>`}
    </div>`;

  // 作者分组（≥2 本才进侧栏/成行，最多 6 位）；空/Unknown 作者归入「未知作者」且固定排最后
  const authorMap = new Map();
  const unknownBooks = [];
  for (const b of all) {
    const a = bkAuthor(b);
    if (a) { if (!authorMap.has(a)) authorMap.set(a, []); authorMap.get(a).push(b); }
    else unknownBooks.push(b);
  }
  const topAuthors = [...authorMap.entries()].filter(([, bs]) => bs.length >= 2)
    .sort((x, y) => y[1].length - x[1].length).slice(0, 6);
  if (unknownBooks.length) topAuthors.push(['未知作者', unknownBooks]);
  const CAT_ORDER = ['小说', '纪实', '技术', '漫画', '文档', '有声书', '其他'];
  const cats = CAT_ORDER.map((c) => [c, all.filter((b) => (b.category || '其他') === c).length]).filter(([, n]) => n > 0);

  const sideItem = (hash, label, active) =>
    `<a class="mu-side-item${active ? ' active' : ''}" data-go="${hash}">${esc(label)}</a>`;
  const side = `
    <aside class="mu-side">
      <div class="mu-side-title">书架中心</div>
      ${sideItem('#/books', '📖 发现书架', view === 'landing')}
      ${sideItem('#/books/reading', '🕐 最近阅读', view === 'reading')}
      ${sideItem('#/books/all', '📚 全部图书', view === 'all')}
      ${topAuthors.length ? `<div class="mu-side-sub">作者</div>${topAuthors.map(([a]) => sideItem('#/books/author/' + encodeURIComponent(a), '✍️ ' + a, view === 'author' && author === a)).join('')}` : ''}
      ${cats.length ? `<div class="mu-side-sub">分类</div>${cats.map(([c, n]) => sideItem('#/books/cat/' + encodeURIComponent(c), '🏷️ ' + c + '（' + n + '）', view === 'cat' && author === c)).join('')}` : ''}
    </aside>`;

  const fmtRows = ['epub', 'txt', 'fb2', 'mobi', 'azw3', 'pdf', 'cbz']
    .map((f) => ({ f, list: all.filter((b) => (b.format || '').toLowerCase() === f) }))
    .filter((x) => x.list.length >= 2)
    .map((x) => rowHtml(`${x.f.toUpperCase()} 图书`, rotShuffle(x.list, 21).slice(0, 18), { cardFn: card })).join('');
  const authorRows = topAuthors
    .map(([a, bs]) => rowHtml(`✍️ ${a}`, rotShuffle(bs, 22).slice(0, 18), { cardFn: card })).join('');

  let main = '';
  if (view === 'reading') {
    main = `<section class="mu-main">
      <a class="back-link" data-go="#/books">‹ 发现书架</a>
      <div class="mu-head"><h2>最近阅读</h2><span class="mu-stat">${reading.length} 本在读</span></div>
      ${reading.length ? `<div class="bk-grid">${reading.map(card).join('')}</div>` : '<div class="empty-hint">还没有阅读记录，去发现书架挑一本开始吧。</div>'}
    </section>`;
  } else if (view === 'all') {
    main = `<section class="mu-main">
      <a class="back-link" data-go="#/books">‹ 发现书架</a>
      <div class="mu-head"><h2>全部图书</h2><span class="mu-stat">${all.length} 本</span></div>
      ${all.length ? `<div class="bk-grid">${rotShuffle(all, 49).map(card).join('')}</div>` : '<div class="mu-empty">书架空空如也<br><br>添加一个目录并扫描，TXT / EPUB 自动归类入库</div>'}
    </section>`;
  } else if (view === 'cat') {
    const list = all.filter((b) => (b.category || '其他') === author)
      .sort((a, b) => (b.last_seen_at || 0) - (a.last_seen_at || 0));
    main = `<section class="mu-main">
      <a class="back-link" data-go="#/books">‹ 发现书架</a>
      <div class="mu-head"><h2>🏷️ ${esc(author)}</h2><span class="mu-stat">${list.length} 本</span></div>
      ${list.length ? `<div class="bk-grid">${list.map(card).join('')}</div>` : '<div class="empty-hint">该分类暂无图书。</div>'}
    </section>`;
  } else if (view === 'author') {
    const list = (author === '未知作者' ? unknownBooks : (authorMap.get(author) || []))
      .sort((a, b) => (b.last_seen_at || 0) - (a.last_seen_at || 0));
    main = `<section class="mu-main">
      <a class="back-link" data-go="#/books">‹ 发现书架</a>
      <div class="mu-head"><h2>✍️ ${esc(author)}</h2><span class="mu-stat">${list.length} 本</span></div>
      ${list.length ? `<div class="bk-grid">${list.map(card).join('')}</div>` : '<div class="empty-hint">没有找到该作者的书。</div>'}
    </section>`;
  } else {
    main = `<section class="mu-main">
      <a class="back-link" data-go="#/home">‹ 返回首页</a>
      <div class="mu-head"><h2>书架中心</h2><span class="mu-stat">${all.length} 本 · ${reading.length} 本在读</span></div>
      <div class="mu-dual mv-dual bk-dual">
        ${bkDualCard('最近加入', '新入库图书', newest, '还没有图书')}
        ${bkDualCard('精选书籍', '为你推荐', (reading.length ? reading : newest).slice(0, 6), '还没有图书')}
      </div>
      ${rowHtml('继续阅读', reading.slice(0, 18), { cardFn: card })}
      ${fmtRows}
      ${authorRows}
      ${all.length ? `<div class="row-head"><h3 class="mv-group" style="margin:0">📚 书架</h3><a class="row-more" data-go="#/books/all">更多 ›</a></div><div class="bk-grid bk-grid-home">${rotShuffle(all, 23).slice(0, 32).map(card).join('')}</div>` : '<div class="mu-empty">书架空空如也<br><br>添加一个目录并扫描，TXT / EPUB 自动归类入库</div>'}
    </section>`;
  }
  $app.innerHTML = `<div class="mu-page">${side}${main}</div>`;

  $app.querySelectorAll('.bk-book').forEach((el) => { el.onclick = () => { fadeNav('#/book/' + el.dataset.bid, el); }; }); // eb：进阅读器走渐变（全局 data-go 委托随后设同一 hash，无冲突）
}

async function doBookScan() {
  const btns = document.querySelectorAll('#bk-scan');
  btns.forEach((b) => { b.disabled = true; b.textContent = '扫描中…'; });
  try {
    const r = await api('/api/books/scan', { method: 'POST' });
    toast(`扫描完成：新增 ${r.added} · 更新 ${r.updated} · 拒收 ${r.skipped} · 共 ${r.total} 本`);
  } catch (e) { toast('扫描失败：' + e.message); }
  btns.forEach((b) => { b.disabled = false; b.textContent = '⟳ 扫描入库'; });
  route();
}

/* ---- 书籍详情页（悬浮图「详情」进入：书信息 + 完整目录） ---- */
async function renderBookInfo(idStr) {
  const id = parseInt(idStr, 10);
  let t;
  try { t = await api(`/api/books/toc/${id}`); }
  catch (e) { $app.innerHTML = `<div class="empty-hint">书籍加载失败：${esc(e.message)}</div>`; return; }
  const b = t.book;
  const prog = await api('/api/books/progress').then((r) => (r.items || []).find((x) => x.bookId === id) || null).catch(() => null);
  const pct = prog && b.max_ch > 0 ? Math.min(100, Math.round(((prog.chapterIdx + prog.pos) / (b.max_ch + 1)) * 100)) : 0;
  const fmt = (b.format || '').toUpperCase();
  const sizeTxt = b.size > 1048576 ? (b.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b.size / 1024)) + ' KB';
  $app.innerHTML = `
  <div class="mu-page">
    <main class="mu-main">
      <a class="back-link" data-go="#/books">‹ 书架</a>
      <div class="bkinfo">
        <img class="bkinfo-cover" src="${bkCover(b)}" alt="" />
        <div class="bkinfo-info">
          <h2 class="bkinfo-title">${esc(b.title)}</h2>
          <div class="bkinfo-meta">
            <span>✍️ ${esc(bkAuthor(b) || '佚名')}</span>
            <span>📄 ${esc(fmt)}</span>
            <span>💾 ${sizeTxt}</span>
            <span>🏷️ ${esc(b.category || '其他')}</span>
            <span>📑 ${t.chapters.length} 章</span>
            ${pct ? `<span>📍 已读 ${pct}%</span>` : ''}
          </div>
          <div class="bkinfo-btns"><button class="btn-accent" id="bkinfo-read">▶ ${pct ? '继续阅读' : '开始阅读'}</button></div>
        </div>
      </div>
      <h3 class="mu-sec">目录<span class="mv-sec-sub">共 ${t.chapters.length} 章</span></h3>
      <div class="bkinfo-toc">${t.chapters.map((c) => `<a class="bkinfo-ch" data-ch="${c.idx}">${esc(c.title || '第' + (c.idx + 1) + '章')}</a>`).join('')}</div>
    </main>
  </div>`;
  document.getElementById('bkinfo-read').onclick = () => fadeNav('#/book/' + id, document.querySelector('.bkinfo-cover'));
  $app.querySelectorAll('.bkinfo-ch').forEach((a) => {
    a.onclick = () => fadeNav('#/book/' + id + '?ch=' + a.dataset.ch, a);
  });
}

/* ---- PDF：浏览器内建阅读器整本打开 ---- */
function renderBookPdf(id) {
  $app.innerHTML = `
  <div class="bk-reader-doc">
    <main class="bk-main">
      <div class="bk-toolbar">
        <a class="back-link" data-go="#/bookinfo/${id}">‹ 详情</a>
        <div class="bk-tools"><a class="btn-ghost" href="/api/books/file/${id}" target="_blank" rel="noopener">↗ 新窗口打开</a></div>
      </div>
      <iframe class="bk-pdf" src="/api/books/file/${id}" title="PDF 阅读"></iframe>
    </main>
  </div>`;
  api('/api/books/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookId: id, chapterIdx: 0, pos: 0 }) }).catch(() => {});
}

/* ---- CBZ 漫画：逐页看图 ---- */
async function renderBookComic(id, t) {
  const pages = t.chapters.length;
  const prog = await api('/api/books/progress').then((r) => (r.items || []).find((x) => x.bookId === id) || null).catch(() => null);
  let cur = prog ? Math.min(pages - 1, Math.max(0, prog.chapterIdx)) : 0;
  $app.innerHTML = `
  <div class="bk-reader-doc">
    <main class="bk-main">
      <div class="bk-toolbar">
        <a class="back-link" data-go="#/bookinfo/${id}">‹ 详情</a>
        <div class="bk-tools">
          <button class="btn-ghost" id="bc-prev">‹ 上一页</button>
          <span class="bk-chlabel" id="bc-label"></span>
          <button class="btn-ghost" id="bc-next">下一页 ›</button>
        </div>
      </div>
      <div class="bk-comic"><img id="bc-img" alt=""></div>
    </main>
  </div>`;
  const img = document.getElementById('bc-img');
  let saveT = 0;
  const save = () => {
    const now = Date.now();
    if (now - saveT < 2000) return;
    saveT = now;
    api('/api/books/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: id, chapterIdx: cur, pos: 0 }) }).catch(() => {});
    delete PAGE_CACHE.books;
  };
  const show = (i) => {
    cur = Math.max(0, Math.min(pages - 1, i));
    img.src = `/api/books/page/${id}/${cur}`;
    document.getElementById('bc-label').textContent = `${cur + 1} / ${pages} 页`;
    save();
  };
  document.getElementById('bc-prev').onclick = () => show(cur - 1);
  document.getElementById('bc-next').onclick = () => show(cur + 1);
  const key = (e) => {
    if (!document.querySelector('.bk-comic')) { document.removeEventListener('keydown', key); return; }
    if (e.key === 'ArrowLeft') show(cur - 1);
    if (e.key === 'ArrowRight') show(cur + 1);
  };
  document.addEventListener('keydown', key);
  show(cur);
}

/* ---- 有声书：音频播放，进度按播放比例保存 ---- */
async function renderBookAudio(id, t) {
  const prog = await api('/api/books/progress').then((r) => (r.items || []).find((x) => x.bookId === id) || null).catch(() => null);
  $app.innerHTML = `
  <div class="bk-reader-doc">
    <main class="bk-main">
      <div class="bk-toolbar"><a class="back-link" data-go="#/bookinfo/${id}">‹ 详情</a></div>
      <div class="bk-audio">
        <img class="bk-audio-cover" src="${bkCover(t.book)}" alt="" onerror="this.style.visibility='hidden'">
        <div class="bk-audio-title">${esc(t.book.title)}</div>
        <div class="bk-audio-sub">${esc(bkAuthor(t.book) || '有声书')} · ${(t.book.format || '').toUpperCase()}</div>
        <audio id="ba-audio" controls preload="metadata" src="/api/books/file/${id}"></audio>
      </div>
    </main>
  </div>`;
  const au = document.getElementById('ba-audio');
  let saveT = 0;
  au.addEventListener('loadedmetadata', () => {
    if (prog && prog.pos > 0 && au.duration > 0) au.currentTime = Math.min(au.duration - 1, prog.pos * au.duration);
  });
  au.addEventListener('timeupdate', () => {
    const now = Date.now();
    if (now - saveT < 5000 || !au.duration) return;
    saveT = now;
    api('/api/books/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: id, chapterIdx: 0, pos: au.currentTime / au.duration }) }).catch(() => {});
    delete PAGE_CACHE.books;
  });
}

/* ---- 直播源管理后台：添加 / 编辑 / 删除 / 启停 / 测速 / 导入导出 / 去广告 / 应用生效 ---- */
const LTV_ADMIN = { q: '', status: 'all', results: {}, data: null };

async function renderLiveTvAdmin() {
  if (!(await adminEnsureUnlocked())) { location.hash = '#/library'; return; }
  try { LTV_ADMIN.data = await api('/api/livetv/admin'); }
  catch (e) { $app.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`; return; }
  const d = LTV_ADMIN.data;
  $app.innerHTML = `
  <div class="page">
    <div class="page-head">
      <a class="back-link" data-go="#/library">‹ 设置</a>
      <div class="page-title">直播源管理</div>
      <span class="page-sub" id="la-sub"></span>
      <div class="grow"></div>
    </div>
    <div class="ltvadm-wrap">
      <div class="ltvadm-bar">
        <input id="la-q" type="text" placeholder="搜索名称 / 地址 / 分组" value="${esc(LTV_ADMIN.q)}" />
        <select id="la-status">
          <option value="all">全部状态</option>
          <option value="on">已启用</option>
          <option value="off">已禁用</option>
        </select>
        <label class="la-only" title="关 = 我的源叠加在原有频道之上；开 = 频道表只显示我添加的源">
          <input type="checkbox" id="la-only" ${d.customOnly ? 'checked' : ''} /> 只用我的源
        </label>
        <button class="btn-accent" id="la-add">＋ 添加源</button>
        <button class="btn-ghost" id="la-sync">🔄 刷新订阅</button>
        <button class="btn-ghost" id="la-import">📥 导入</button>
        <button class="btn-ghost" id="la-exp-m3u">📤 导出 m3u</button>
        <button class="btn-ghost" id="la-exp-json">📤 导出 JSON</button>
        <button class="btn-ghost" id="la-speed">⚡ 批量测速</button>
        <button class="btn-ghost" id="la-ads">🧹 去广告</button>
        <button class="btn-accent" id="la-apply">✅ 应用生效</button>
        <button class="btn-ghost" id="la-deloff">🗑 清除禁用</button>
      </div>
      <div class="ltvadm-form hidden" id="la-form">
        <input id="lf-name" type="text" placeholder="频道名称 *" />
        <input id="lf-url" type="text" placeholder="播放地址 http(s)://… *" />
        <input id="lf-group" type="text" placeholder="分组（如 央视/卫视）" />
        <input id="lf-priority" type="number" min="0" max="99" placeholder="优先级" />
        <input id="lf-note" type="text" placeholder="备注" />
        <button class="btn-accent" id="lf-save">保存</button>
        <button class="btn-ghost" id="lf-cancel">取消</button>
      </div>
      <div class="ltvadm-form hidden" id="la-impform">
        <input id="li-file" type="file" accept=".m3u,.m3u8,.json,.txt" />
        <textarea id="li-text" rows="5" placeholder="或直接粘贴 m3u / JSON 片单内容"></textarea>
        <label><input type="radio" name="li-mode" value="merge" checked> 合并（按地址去重）</label>
        <label><input type="radio" name="li-mode" value="replace"> 替换现有</label>
        <button class="btn-accent" id="li-go">导入</button>
        <button class="btn-ghost" id="li-cancel">取消</button>
      </div>
      <div class="ltvadm-tip">订阅型源（地址打开是一份 #EXTM3U 列表）会自动展开成多条频道，和原有频道合并显示；单频道的直链也照常支持。</div>
      <table class="ltvadm-table">
        <thead><tr><th>状态</th><th>名称</th><th>地址</th><th>分组</th><th>频道</th><th>优先级</th><th>备注</th><th>测速</th><th>操作</th></tr></thead>
        <tbody id="la-body"></tbody>
      </table>
      <div class="ltvadm-foot">源数据保存在 <code>${esc(d.file)}</code>。订阅内容每 6 小时自动复查一次，点「🔄 刷新订阅」立即重拉 —— 无需重启。去广告关键词：${esc(d.adKeywords)}（可在设置页追加自定义关键词）</div>
    </div>
  </div>`;
  const st = document.getElementById('la-status');
  st.value = LTV_ADMIN.status;
  st.onchange = () => { LTV_ADMIN.status = st.value; drawLiveAdminRows(); };
  const onlyBox = document.getElementById('la-only');
  if (onlyBox) onlyBox.onchange = async () => {
    try {
      const r = await api('/api/livetv/admin/mode', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customOnly: onlyBox.checked }),
      });
      toast(onlyBox.checked ? `已切换：只显示我的源（${r.total} 个频道）` : `已切回：我的源叠加在原有频道上（共 ${r.total} 个频道）`);
      await laReload();
    } catch (e) { toast('切换失败：' + e.message); }
  };
  const syncBtn = document.getElementById('la-sync');
  if (syncBtn) syncBtn.onclick = async () => {
    syncBtn.disabled = true; syncBtn.textContent = '刷新中…';
    try {
      const r = await api('/api/livetv/admin/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const bad = Object.entries(r.detail || {}).filter(([, x]) => x.kind === 'error');
      toast(`已展开 ${r.channels} 个频道${bad.length ? `（${bad.length} 个源拉取失败）` : ''}`);
      await laReload();
    } catch (e) { toast('刷新失败：' + e.message); }
    syncBtn.disabled = false; syncBtn.textContent = '🔄 刷新订阅';
  };
  const q = document.getElementById('la-q');
  q.oninput = () => { LTV_ADMIN.q = q.value; drawLiveAdminRows(); };
  document.getElementById('la-add').onclick = () => {
    const f = document.getElementById('la-form');
    f.classList.remove('hidden');
    delete f.dataset.edit;
    document.getElementById('lf-name').value = '';
    document.getElementById('lf-url').value = '';
    document.getElementById('lf-group').value = '';
    document.getElementById('lf-priority').value = '';
    document.getElementById('lf-note').value = '';
    document.getElementById('lf-name').focus();
  };
  document.getElementById('lf-cancel').onclick = () => document.getElementById('la-form').classList.add('hidden');
  document.getElementById('lf-save').onclick = async () => {
    const f = document.getElementById('la-form');
    const body = {
      name: document.getElementById('lf-name').value.trim(),
      url: document.getElementById('lf-url').value.trim(),
      group: document.getElementById('lf-group').value.trim(),
      priority: parseInt(document.getElementById('lf-priority').value, 10) || 0,
      note: document.getElementById('lf-note').value.trim(),
    };
    if (!body.name || !body.url) { toast('名称与地址必填'); return; }
    try {
      if (f.dataset.edit) {
        await api('/api/livetv/admin/' + encodeURIComponent(f.dataset.edit), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const nowData = await api('/api/livetv/admin');
        const row = (nowData.sources || []).find((x) => x.id === f.dataset.edit) || {};
        toast(row.syncError ? `已保存，但拉取失败：${row.syncError}` : row.count ? `已保存：展开 ${row.count} 个频道` : '已保存');
      } else {
        const r = await api('/api/livetv/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        toast(r.error ? `源已添加，但拉取失败：${r.error}` : r.channels > 1 ? `源已添加：展开出 ${r.channels} 个频道` : (r.channels === 1 ? '源已添加（单条直播流）' : '源已添加'));
      }
      f.classList.add('hidden');
      await laReload();
    } catch (e) { toast('保存失败：' + e.message); }
  };
  document.getElementById('la-import').onclick = () => {
    document.getElementById('la-impform').classList.remove('hidden');
    document.getElementById('li-text').value = '';
  };
  document.getElementById('li-cancel').onclick = () => document.getElementById('la-impform').classList.add('hidden');
  document.getElementById('li-file').onchange = (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const rd = new FileReader();
    rd.onload = () => { document.getElementById('li-text').value = String(rd.result || ''); };
    rd.readAsText(file);
  };
  document.getElementById('li-go').onclick = async () => {
    const content = document.getElementById('li-text').value;
    if (!content.trim()) { toast('请先选择文件或粘贴内容'); return; }
    const mode = (document.querySelector('input[name="li-mode"]:checked') || {}).value || 'merge';
    try {
      const r = await api('/api/livetv/admin/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, mode }) });
      toast(`导入完成：新增 ${r.added}，共 ${r.total} 个源`);
      document.getElementById('la-impform').classList.add('hidden');
      await laReload();
    } catch (e) { toast('导入失败：' + e.message); }
  };
  document.getElementById('la-exp-m3u').onclick = () => { location.href = '/api/livetv/admin/export?fmt=m3u'; };
  document.getElementById('la-exp-json').onclick = () => { location.href = '/api/livetv/admin/export?fmt=json'; };
  document.getElementById('la-speed').onclick = async () => {
    const rows = LTV_ADMIN.data.sources.filter((s) => laFilter(s));
    if (!rows.length) { toast('没有可测速的源'); return; }
    await laSpeedtest(rows.map((s) => s.url));
  };
  document.getElementById('la-ads').onclick = async () => {
    if (!confirm('按内置关键词（' + LTV_ADMIN.data.adKeywords + '）清理广告频道？会直接从源文件删除。')) return;
    try {
      const r = await api('/api/livetv/admin/ads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      toast(`去广告完成：移除 ${r.removed} 条，剩 ${r.kept} 条`);
      await laReload();
    } catch (e) { toast('失败：' + e.message); }
  };
  document.getElementById('la-apply').onclick = async () => {
    try {
      const r = await api('/api/livetv/admin/apply', { method: 'POST' });
      toast(`${r.channels} 个频道已生效，回「电视直播」即可观看`);
      await laReload();
    } catch (e) { toast('应用失败：' + e.message); }
  };
  document.getElementById('la-deloff').onclick = async () => {
    const offs = LTV_ADMIN.data.sources.filter((s) => !s.enabled);
    if (!offs.length) { toast('没有禁用状态的源'); return; }
    if (!confirm(`删除全部 ${offs.length} 个禁用状态的源？`)) return;
    let ok = 0;
    for (let i = 0; i < offs.length; i += 8) {
      await Promise.all(offs.slice(i, i + 8).map((s) =>
        api('/api/livetv/admin/' + encodeURIComponent(s.id), { method: 'DELETE' }).then(() => ok++).catch(() => {})));
    }
    toast(`已删除 ${ok} 个禁用源`);
    await laReload();
  };
  drawLiveAdminRows();
}

function laFilter(s) {
  if (LTV_ADMIN.status === 'on' && !s.enabled) return false;
  if (LTV_ADMIN.status === 'off' && s.enabled) return false;
  const q = LTV_ADMIN.q.trim().toLowerCase();
  if (!q) return true;
  return (s.name + ' ' + s.url + ' ' + s.group + ' ' + (s.note || '')).toLowerCase().includes(q);
}

function drawLiveAdminRows() {
  const body = document.getElementById('la-body');
  if (!body || !LTV_ADMIN.data) return;
  const d = LTV_ADMIN.data;
  const rows = d.sources.filter(laFilter);
  const sub = document.getElementById('la-sub');
  if (sub) {
    const on = d.sources.filter((s) => s.enabled).length;
    const chans = d.sources.filter((s) => s.enabled).reduce((n, x) => n + (x.count || 0), 0);
    const errs = d.sources.filter((s) => s.enabled && s.syncError).length;
    sub.textContent = `${d.sources.length} 个源（${on} 启用 / ${d.sources.length - on} 禁用） · 展开 ${chans} 个频道${errs ? ` · ${errs} 个源拉取失败` : ''} · ${d.customOnly ? '仅我的源' : '与原有频道合并'}`;
  }
  body.innerHTML = rows.length ? rows.map((s) => {
    const r = LTV_ADMIN.results[s.url];
    const speed = r ? (r.ok ? `⏱ ${r.ms}ms` : '✕ ' + (r.error || '不可达')) : '';
    const spCls = r ? (r.ok ? 'ok' : 'bad') : '';
    let cnt = '<span class="la-dim">—</span>';
    if (s.enabled && s.count) cnt = `<span class="la-cnt">${s.count} 频道</span>`;
    else if (s.enabled && s.syncError) cnt = `<span class="la-cnt bad" title="${esc(s.syncError)}">⚠ 拉取失败</span>`;
    else if (s.enabled) cnt = '<span class="la-dim">待同步</span>';
    return `<tr data-id="${s.id}">
      <td><button class="la-toggle ${s.enabled ? 'on' : ''}" title="${s.enabled ? '点击禁用' : '点击启用'}">${s.enabled ? '●' : '○'}</button></td>
      <td class="la-name" title="${esc(s.name)}">${esc(s.name)}</td>
      <td class="la-url" title="${esc(s.url)}">${esc(s.url)}</td>
      <td>${esc(s.group)}</td>
      <td>${cnt}</td>
      <td>${s.priority}</td>
      <td class="la-note" title="${esc(s.note || '')}">${esc(s.note || '')}</td>
      <td><span class="la-speed ${spCls}">${speed}</span></td>
      <td class="la-ops">
        <button class="la-act" data-act="sync">同步</button>
        <button class="la-act" data-act="speed">测速</button>
        <button class="la-act" data-act="edit">编辑</button>
        <button class="la-act bad" data-act="del">删除</button>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="9" class="empty-hint">没有匹配的源。点「＋ 添加源」或「📥 导入」。</td></tr>';
  body.querySelectorAll('.la-toggle').forEach((b) => { b.onclick = () => laToggle(b.closest('tr').dataset.id); });
  body.querySelectorAll('.la-act').forEach((b) => { b.onclick = () => laAct(b.dataset.act, b.closest('tr').dataset.id); });
}

async function laReload() {
  LTV_ADMIN.data = await api('/api/livetv/admin');
  drawLiveAdminRows();
}

async function laToggle(id) {
  const s = (LTV_ADMIN.data.sources || []).find((x) => x.id === id);
  if (!s) return;
  try {
    await api('/api/livetv/admin/' + encodeURIComponent(id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !s.enabled }) });
    await laReload();
  } catch (e) { toast('操作失败：' + e.message); }
}

async function laSpeedtest(urls) {
  const btn = document.getElementById('la-speed');
  if (btn) { btn.disabled = true; btn.textContent = '测速中…'; }
  try {
    const r = await api('/api/livetv/admin/speedtest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls }) });
    LTV_ADMIN.results = { ...LTV_ADMIN.results, ...r.results };
    drawLiveAdminRows();
    const okN = Object.values(r.results).filter((x) => x.ok).length;
    toast(`测速完成：${okN}/${urls.length} 可用`);
  } catch (e) { toast('测速失败：' + e.message); }
  if (btn) { btn.disabled = false; btn.textContent = '⚡ 批量测速'; }
}

async function laAct(act, id) {
  const s = (LTV_ADMIN.data.sources || []).find((x) => x.id === id);
  if (!s) return;
  if (act === 'speed') return void laSpeedtest([s.url]);
  if (act === 'sync') {
    try {
      const r = await api('/api/livetv/admin/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
      const info = (r.detail || {})[id] || {};
      toast(info.error ? `拉取失败：${info.error}` : `已同步：${info.count} 个频道`);
      await laReload();
    } catch (e) { toast('同步失败：' + e.message); }
    return;
  }
  if (act === 'del') {
    if (!confirm(`删除「${s.name}」？`)) return;
    try {
      await api('/api/livetv/admin/' + encodeURIComponent(id), { method: 'DELETE' });
      toast('已删除');
      await laReload();
    } catch (e) { toast('删除失败：' + e.message); }
    return;
  }
  if (act === 'edit') {
    const f = document.getElementById('la-form');
    f.classList.remove('hidden');
    f.dataset.edit = id;
    document.getElementById('lf-name').value = s.name;
    document.getElementById('lf-url').value = s.url;
    document.getElementById('lf-group').value = s.group;
    document.getElementById('lf-priority').value = s.priority;
    document.getElementById('lf-note').value = s.note || '';
    f.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/* ---- 阅读器 ---- */
const BookR = { id: 0, chIdx: 0, toc: null, lastSave: 0, mode: localStorage.getItem('bk-mode') || 'page' };
const AUDIO_FMTS = ['m4b', 'm4a', 'mp3', 'flac', 'ogg', 'opus', 'wav'];

async function renderBookReader(idStr) {
  const id = parseInt(idStr, 10);
  const chQ = idStr.includes('?ch=') ? parseInt(idStr.split('?ch=')[1], 10) : NaN;
  let t;
  try { t = await api(`/api/books/toc/${id}`); }
  catch (e) { $app.innerHTML = `<div class="empty-hint">书籍加载失败：${esc(e.message)}</div>`; return; }
  BookR.id = id; BookR.toc = t;
  const bfmt = String(t.book.format || '').toLowerCase();
  if (bfmt === 'pdf') return renderBookPdf(id);
  if (bfmt === 'cbz') return renderBookComic(id, t);
  if (AUDIO_FMTS.includes(bfmt)) return renderBookAudio(id, t);
  const prog = await api('/api/books/progress').then((r) => (r.items || []).find((x) => x.bookId === id) || null).catch(() => null);
  BookR.chIdx = !Number.isNaN(chQ) ? chQ : (prog ? prog.chapterIdx : 0);
  const rate = Number(localStorage.getItem('bk-rate') || '1') || 1;
  const fontSize = Number(localStorage.getItem(bkFontKey) || '18') || 18;

  $app.innerHTML = `
  <div class="bk-reader">
    <aside class="bk-side" id="bk-side">
      <div class="bk-side-head">
        <div class="bk-side-title">${esc(t.book.title)}</div>
        <div class="bk-side-sub">${esc(bkAuthor(t.book) || '佚名')} · ${t.chapters.length} 章</div>
      </div>
      <div class="bk-chapters">${t.chapters.map((c) => `<a class="bk-ch" data-ch="${c.idx}">${esc(c.title || '第' + (c.idx + 1) + '章')}</a>`).join('')}</div>
    </aside>
    <main class="bk-main">
      <div class="bk-toolbar">
        <a class="back-link" data-go="#/books">‹ 书架</a>
        <div class="bk-tools">
          <button class="btn-ghost" id="bk-font-minus" title="缩小字号">A−</button>
          <button class="btn-ghost" id="bk-font-plus" title="放大字号">A＋</button>
          <button class="btn-ghost" id="bk-mode" title="切换翻页 / 滚动阅读模式">📃 翻页模式</button>
          <button class="btn-ghost" id="bk-theme" title="切换日间 / 夜间阅读背景">☀️ 日间</button>
          <select class="bk-rate" id="bk-rate" title="朗读语速">
            <option value="0.8">慢速</option><option value="1" selected>正常</option>
            <option value="1.25">较快</option><option value="1.6">快速</option>
          </select>
          <button class="btn-ghost" id="bk-tts">🔊 朗读本章</button>
          <button class="btn-ghost hidden" id="bk-tts-stop" title="停止朗读">⏹</button>
        </div>
      </div>
      <article class="bk-content" id="bk-content" style="font-size:${fontSize}px"></article>
      <div class="bk-nav">
        <button class="btn-ghost" id="bk-prev">‹ 上一章</button>
        <button class="btn-ghost hidden" id="bk-page-prev">‹ 上一页</button>
        <span class="bk-chlabel" id="bk-chlabel"></span>
        <button class="btn-accent hidden" id="bk-page-next">下一页 ›</button>
        <button class="btn-accent" id="bk-next">下一章 ›</button>
      </div>
    </main>
  </div>`;

  playFadeOut(); // eb：fadeNav 渐变进来，阅读器骨架已画好就揭开

  const rateSel = document.getElementById('bk-rate');
  rateSel.value = String(rate);
  rateSel.onchange = () => { localStorage.setItem('bk-rate', rateSel.value); if (Books.tts.on) bookSpeak(document.getElementById('bk-content').textContent); };
  document.getElementById('bk-font-minus').onclick = () => bkAdjustFont(-2);
  document.getElementById('bk-font-plus').onclick = () => bkAdjustFont(2);
  document.getElementById('bk-tts').onclick = bookTtsToggle;
  document.getElementById('bk-tts-stop').onclick = bookStopTts;
  document.getElementById('bk-prev').onclick = () => bkGoChapter(BookR.chIdx - 1);
  document.getElementById('bk-next').onclick = () => bkGoChapter(BookR.chIdx + 1);
  document.getElementById('bk-page-prev').onclick = () => bkGoPage(-1);
  document.getElementById('bk-page-next').onclick = () => bkGoPage(1);
  // 键盘 ←/→ 翻页（翻页模式跨章自动衔接；滚动模式上下滚动）。先解旧再挂新，防路由往返重复挂载
  document.removeEventListener('keydown', bkReaderKey);
  document.addEventListener('keydown', bkReaderKey);
  document.getElementById('bk-mode').onclick = () => {
    BookR.mode = BookR.mode === 'page' ? 'scroll' : 'page';
    localStorage.setItem('bk-mode', BookR.mode);
    bkApplyMode(true);
  };
  // 日间/夜间阅读背景：只作用于书籍区域，浅色时正文黑字
  const applyBkTheme = () => {
    const light = localStorage.getItem('bk-theme') === 'light';
    const rd = document.querySelector('.bk-reader');
    if (rd) rd.classList.toggle('bk-light', light);
    const tb = document.getElementById('bk-theme');
    if (tb) tb.textContent = light ? '🌙 夜间' : '☀️ 日间';
  };
  document.getElementById('bk-theme').onclick = () => {
    localStorage.setItem('bk-theme', localStorage.getItem('bk-theme') === 'light' ? 'dark' : 'light');
    applyBkTheme();
  };
  applyBkTheme();
  $app.querySelectorAll('.bk-ch').forEach((a) => {
    a.onclick = () => bkGoChapter(Number(a.dataset.ch));
  });

  bkApplyMode(false);
  await bkLoadChapter(BookR.chIdx, prog ? prog.pos : 0);
}

function bkAdjustFont(d) {
  const el = document.querySelector('.bk-content');
  if (!el) return;
  const size = Math.max(14, Math.min(30, parseInt(getComputedStyle(el).fontSize, 10) + d));
  el.style.fontSize = size + 'px';
  localStorage.setItem(bkFontKey, String(size));
}

/* ---- 翻页模式：正文固定在视口内，多列分页横向滚动 ---- */
function bkApplyMode(rerender) {
  const el = document.getElementById('bk-content');
  if (!el) return;
  const paged = BookR.mode === 'page';
  el.classList.toggle('paged', paged);
  document.body.classList.toggle('bk-page-on', paged);
  const show = (id, on) => { const b = document.getElementById(id); if (b) b.classList.toggle('hidden', !on); };
  show('bk-page-prev', paged);
  show('bk-page-next', paged);
  const mb = document.getElementById('bk-mode');
  if (mb) mb.textContent = paged ? '📃 翻页模式' : '📜 滚动模式';
  if (paged) {
    if (!window.__bkResize) {
      window.__bkResize = () => bkLayoutPaged();
      window.addEventListener('resize', window.__bkResize);
    }
    if (rerender) bkGoChapter(BookR.chIdx);
    else bkLayoutPaged();
  } else {
    el.style.height = ''; el.style.columnWidth = ''; el.style.columnGap = '';
    if (window.__bkResize) { window.removeEventListener('resize', window.__bkResize); window.__bkResize = null; }
  }
}
function bkLayoutPaged() {
  const el = document.getElementById('bk-content');
  if (!el || !el.classList.contains('paged')) return;
  const nav = document.querySelector('.bk-nav');
  const navH = (nav ? nav.offsetHeight : 60) + 18;
  const top = el.getBoundingClientRect().top;
  el.style.height = Math.max(260, window.innerHeight - top - navH) + 'px';
  el.style.columnWidth = Math.max(280, el.clientWidth) + 'px';
  el.style.columnGap = '36px';
}
function bkPageStep(el) { return Math.max(1, el.clientWidth + 36); }
function bkPageCount(el) { return Math.max(1, Math.round((el.scrollWidth + 36) / bkPageStep(el))); }
function bkCurPage(el) { return Math.min(bkPageCount(el) - 1, Math.max(0, Math.round(el.scrollLeft / bkPageStep(el)))); }
function bkUpdatePageLabel() {
  const el = document.getElementById('bk-content');
  const label = document.getElementById('bk-chlabel');
  if (!el || !label || !el.classList.contains('paged') || !BookR.toc) return;
  label.textContent = `${BookR.chIdx + 1} / ${BookR.toc.chapters.length} 章 · 第 ${bkCurPage(el) + 1} / ${bkPageCount(el)} 页`;
}
function bkSaveProgressPaged(el) {
  const pages = bkPageCount(el);
  const pos = pages > 0 ? Math.min(1, (bkCurPage(el) + 1) / pages) : 0;
  api('/api/books/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookId: BookR.id, chapterIdx: BookR.chIdx, pos }) }).catch(() => {});
  delete PAGE_CACHE.books; // eu：阅读进度已变，书架「最近阅读」缓存作废（翻页模式）
}
/* 键盘方向键翻页：阅读器在挂时 ←/→ 生效；离开阅读页自动解绑 */
function bkReaderKey(e) {
  if (!document.querySelector('.bk-reader')) { document.removeEventListener('keydown', bkReaderKey); return; }
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const el = document.getElementById('bk-content');
  if (!el) return;
  e.preventDefault();
  if (el.classList.contains('paged')) return void bkGoPage(e.key === 'ArrowRight' ? 1 : -1);
  const step = Math.max(240, window.innerHeight * 0.85);
  window.scrollBy({ top: e.key === 'ArrowRight' ? step : -step, behavior: 'smooth' });
}
function bkGoPage(dir) {
  const el = document.getElementById('bk-content');
  if (!el) return;
  const p = bkCurPage(el) + dir;
  if (p < 0) return void bkGoChapter(BookR.chIdx - 1, 'last');
  if (p >= bkPageCount(el)) return void bkGoChapter(BookR.chIdx + 1, 'first');
  el.scrollLeft = p * bkPageStep(el);
  bkUpdatePageLabel();
  const now = Date.now();
  if (now - BookR.lastSave > 2000) { BookR.lastSave = now; bkSaveProgressPaged(el); }
  // 朗读跟页走：朗读中翻页自动改读当前页；暂停态翻页视为放弃旧内容，直接停
  if (Books.tts.on) bookSpeak(bkCurPageText());
  else if (Books.tts.paused) bookStopTts();
}

async function bkLoadChapter(idx, restorePos = 0) {
  const t = BookR.toc;
  if (!t) return;
  if (idx < 0) idx = 0;
  if (idx > t.chapters.length - 1) idx = t.chapters.length - 1;
  BookR.chIdx = idx;
  let ch;
  try { ch = await api(`/api/books/chapter/${BookR.id}/${idx}`); }
  catch (e) { toast('章节加载失败：' + e.message); return; }
  const el = document.getElementById('bk-content');
  if (!el) return;
  bookStopTts();
  const paras = String(ch.text || '').split(/\n+/).filter((p) => p.trim()).map((p) => `<p>${esc(p.trim())}</p>`).join('');
  el.innerHTML = `<h2 class="bk-h2">${esc(ch.title || '第' + (idx + 1) + '章')}</h2>${paras}`;
  const label = document.getElementById('bk-chlabel');
  if (label) label.textContent = `${idx + 1} / ${t.chapters.length} · ${ch.title || ''}`;
  $app.querySelectorAll('.bk-ch').forEach((a) => a.classList.toggle('active', Number(a.dataset.ch) === idx));
  // 恢复位置：翻页模式跳到对应页；滚动模式按比例恢复滚动条
  window.scrollTo(0, 0);
  if (el.classList.contains('paged')) {
    requestAnimationFrame(() => {
      bkLayoutPaged();
      if (restorePos > 0) el.scrollLeft = restorePos * el.scrollWidth * 0.999;
      bkUpdatePageLabel();
    });
  } else if (restorePos > 0) {
    requestAnimationFrame(() => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, Math.round(restorePos * max));
    });
  }
  bkBindSave();
}

function bkBindSave() {
  // 卸掉旧的滚动监听（标记式）
  if (window.__bkScroll) window.removeEventListener('scroll', window.__bkScroll);
  window.__bkScroll = () => {
    const now = Date.now();
    if (now - BookR.lastSave < 3000) return;
    BookR.lastSave = now;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const pos = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    api('/api/books/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: BookR.id, chapterIdx: BookR.chIdx, pos }) }).catch(() => {});
    delete PAGE_CACHE.books; // eu：阅读进度已变，书架「最近阅读」缓存作废（滚动模式）
  };
  window.addEventListener('scroll', window.__bkScroll, { passive: true });
}

async function bkGoChapter(idx, where) {
  await bkLoadChapter(idx, 0);
  if (BookR.mode !== 'page') return;
  const el = document.getElementById('bk-content');
  if (!el) return;
  requestAnimationFrame(() => {
    el.scrollLeft = where === 'last' ? el.scrollWidth : 0;
    bkUpdatePageLabel();
  });
}

let routeSeq = 0;
let LIB_OPEN_TAB = ''; // dlx：深链/旧入口进设置时自动展开的分组（如下载）
/* 功能可见性开关：后台「🚫 功能开关」可隐藏某些菜单 + 对应页面
   （连外网时不想给外人看相册/私密影片等；数据仍在，重新打开即恢复可见） */
const FEAT_ITEMS = [
  { key: 'media', label: '🎬 影视中心' },
  { key: 'music', label: '🎵 音乐中心' },
  { key: 'photos', label: '🖼️ 家庭相册' },
  { key: 'books', label: '📚 电子书架' },
  { key: 'games', label: '🎮 游戏中心' },
  { key: 'dl', label: '⬇️ 下载中心' },
];
const FEATURE_HIDDEN = new Set();
const HROW_FEAT = { 0: 'media', 1: 'media', 2: 'media', 3: 'media', 4: 'media', 5: 'media', 6: 'media', 7: 'music', 8: 'photos', 9: 'books' };
function featOfNavHref(href) {
  if (!href) return null;
  if (href === '#/media') return 'media';
  if (href.startsWith('#/music')) return 'music';
  if (href.startsWith('#/photos')) return 'photos';
  if (href.startsWith('#/books') || href.startsWith('#/book')) return 'books';
  if (href.startsWith('#/games')) return 'games';
  if (href.startsWith('#/dl')) return 'dl';
  return null;
}
function featOfHash(h) {
  if (h.startsWith('#/media') || h.startsWith('#/movies') || h.startsWith('#/series') || h.startsWith('#/all') || h.startsWith('#/continue') || h.startsWith('#/online') || h.startsWith('#/detail') || h.startsWith('#/watch') || h.startsWith('#/play') || h.startsWith('#/oplay') || h.startsWith('#/ltvplay') || h.startsWith('#/livetv')) return 'media';
  if (h.startsWith('#/music')) return 'music';
  if (h.startsWith('#/photos')) return 'photos';
  if (h.startsWith('#/books') || h.startsWith('#/book') || h.startsWith('#/bookinfo')) return 'books';
  if (h.startsWith('#/games')) return 'games';
  if (h.startsWith('#/dl')) return 'dl';
  return null;
}
function applyFeatureVisibility() {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const f = featOfNavHref(a.getAttribute('href'));
    a.style.display = (f && FEATURE_HIDDEN.has(f)) ? 'none' : '';
  });
  document.querySelectorAll('[data-hrow]').forEach((row) => {
    const f = HROW_FEAT[row.getAttribute('data-hrow')];
    row.style.display = (f && FEATURE_HIDDEN.has(f)) ? 'none' : '';
  });
}
async function loadFeatures() {
  try {
    const s = await api('/api/settings');
    FEATURE_HIDDEN.clear();
    (Array.isArray(s.featuresHidden) ? s.featuresHidden : []).forEach((k) => FEATURE_HIDDEN.add(k));
  } catch (e) { /* 接口失败则用空（全部可见） */ }
  applyFeatureVisibility();
}
async function route() {
  const seq = ++routeSeq; // 路由序号：过期路由的收尾不再覆盖新页面
  cleanupPlayer();
  dlStop();
  heroStop();
  // 清理照片选择模式残留（固定操作条状态类 + 让位内边距）
  document.body.classList.remove('ph-selmode');
  document.body.classList.remove('has-hero', 'nav-over-hero'); // el：换页先摘沉浸顶栏，首页渲染时再加回
  $app.style.paddingTop = '';
  // 儿童模式外观（顶栏徽标/隐藏管理入口）跟随服务端状态
  document.body.classList.toggle('kids-on', Kids.active === true);
  kidsBadgeSync();
  const h = location.hash || '#/home';
  // 功能可见性：被关闭的菜单对应页面直接重定向回首页（前台看不到也进不去）
  const _fh = featOfHash(h);
  if (_fh && FEATURE_HIDDEN.has(_fh)) { location.hash = '#/home'; return; }
  updateSearchCtx(h); // 搜索框上下文/提示文字跟随当前页面
  // 精简版：在线电影 / 在线剧集入口已移除，旧书签与旧链接统一转到电视直播
  if (UI_MODE === 'livetv' && (h === '#/online' || h.startsWith('#/online/movies') || h.startsWith('#/online/series'))) {
    return void (location.hash = '#/online/live');
  }
  const nav = document.querySelectorAll('[data-nav]');
  nav.forEach((a) => a.classList.toggle('active', h.startsWith(a.getAttribute('href'))));
  applyFeatureVisibility();
  // 「影视中心」父菜单：电影/电视剧/直播(含直播播放页)路由时点亮
  const $nm = document.getElementById('nav-media');
  if ($nm) {
    const inMedia = h === '#/media' || h.startsWith('#/movies') || h.startsWith('#/series')
      || h.startsWith('#/online/live') || h.startsWith('#/ltvplay') || h.startsWith('#/livetv') || h.startsWith('#/all');
    $nm.classList.toggle('active', inMedia);
  }
  window.scrollTo(0, 0); // 每次路由切换回到页面顶部（阅读器等页面随后自行恢复进度位置）
  pageTopBtnHide(); // 离开带回顶按钮的详情页时一并移除
  try {
    if (h.startsWith('#/remote')) {
      const qi = h.indexOf('?');
      const q = qi >= 0 ? new URLSearchParams(h.slice(qi + 1)) : new URLSearchParams();
      return renderRemotePage(q.get('code') || '');
    }
    if (h.startsWith('#/watch/')) return await routeWatch(h);
    if (h.startsWith('#/play/')) {
      const pseg = h.slice('#/play/'.length);
      const qm = pseg.indexOf('?');
      const pqs = qm >= 0 ? new URLSearchParams(pseg.slice(qm + 1)) : null;
      return await renderPlayer(qm >= 0 ? pseg.slice(0, qm) : pseg, pqs);
    }
    if (h.startsWith('#/oplay/')) return await renderOnlinePlayer(h.split('/')[2]);
    if (h.startsWith('#/detail/')) return await renderDetailById(h.split('/')[2]);
    if (h.startsWith('#/series/') ) return await renderSeriesDetail(decodeURIComponent(h.replace('#/series/', '')));
    if (h.startsWith('#/series-list') || h === '#/series') return await renderSeriesList();
    if (h.startsWith('#/online/live')) return await renderLiveTv();
    if (h.startsWith('#/ltvplay/')) return await renderLiveTvPlayer(decodeURIComponent(h.split('/')[2]));
    if (h.startsWith('#/online/movies')) return await renderOnline('movies');
    if (h.startsWith('#/online/series')) return await renderOnline('series');
    if (h.startsWith('#/online')) return await renderOnline('movies');
    if (h === '#/media') return await renderMediaHome();
    if (h.startsWith('#/movies')) return await renderGrid({ title: '电影', kind: 'movie' });
    if (h.startsWith('#/all')) return await renderGrid({ title: '全部影片', kind: null });
    if (h.startsWith('#/continue')) return await renderGrid({ title: '继续观看', kind: null });
    if (h.startsWith('#/library')) {
      // 设置页有管理密码门：未解锁先索要密码；用户取消就不渲染任何设置内容，退回首页
      if (!(await adminEnsureUnlocked())) {
        if (location.hash === h) location.hash = '#/home';
        return;
      }
      return await renderLibrary();
    }
    if (h.startsWith('#/music/online/')) return await renderMusicOnline(h.replace('#/music/online/', ''));
    if (h.startsWith('#/music/likes')) return await renderMusicLikes();
    if (h.startsWith('#/music/playlist/')) return await renderMusicPlaylist(decodeURIComponent(h.replace('#/music/playlist/', '')));
    if (h.startsWith('#/music/artist/')) return await renderMusicArtist(decodeURIComponent(h.replace('#/music/artist/', '')));
    if (h.startsWith('#/music/artists')) return await renderMusicArtists();
    if (h.startsWith('#/music/albums')) return await renderMusicAlbums();
    if (h.startsWith('#/music/album/')) return await renderMusicAlbum(decodeURIComponent(h.replace('#/music/album/', '')));
    if (h.startsWith('#/music/all')) return await renderMusic(true);
    if (h.startsWith('#/music')) return await renderMusic();
    if (h.startsWith('#/photos/lib/')) {
      const rest = h.replace('#/photos/lib/', '');
      const qm = rest.indexOf('?');
      const alb = decodeURIComponent(qm >= 0 ? rest.slice(0, qm) : rest);
      const ph = qm >= 0 ? new URLSearchParams(rest.slice(qm + 1)).get('ph') : null;
      return await renderLibAlbum(alb, ph);
    }
    if (h.startsWith('#/photos')) return await renderPhotos();
    if (h.startsWith('#/bookinfo/')) return await renderBookInfo(h.replace('#/bookinfo/', ''));
    if (h.startsWith('#/book/')) return await renderBookReader(h.replace('#/book/', ''));
    if (h.startsWith('#/books')) return await renderBooks();
    if (h.startsWith('#/livetv/admin')) return await renderLiveTvAdmin();
    if (h.startsWith('#/games')) return await renderGames();
    // dlx：下载中心收进设置页（前台不再显示），旧入口重定向过去并自动展开下载分组
    if (h.startsWith('#/dl')) { LIB_OPEN_TAB = 'dl'; location.hash = '#/library'; return; }
    if (h.startsWith('#/ai/')) return await renderAi(decodeURIComponent(h.replace('#/ai/', '')));
    if (h.startsWith('#/search/')) return await renderSearch(decodeURIComponent(h.replace('#/search/', '')));
    return await renderHome();
  } catch (e) {
    if (seq !== routeSeq) return; // 已被更新的路由接管，别覆盖新页面
    $app.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}
// #/detail/:id：剧集带 series_key 走剧详情；电影没有 series 行（rebuildSeries 只建剧集），
// 直接渲染文件详情。绝不做「改 hash + 继续渲染」的双导航——会触发并发 route 竞态（null.innerHTML）
async function renderDetailById(id) {
  const m = await api(`/api/media/${id}`);
  if (m.series_key) return renderSeriesDetail(m.series_key);
  pageTopBtnShow(); // 电影整页详情同样带右侧回顶按钮
  return renderFileDetail(m);
}

/* 详情页自动获取详细内容：未刮削条目打开时后台请求 TMDB 单条刮削，成功后原地刷新 */
async function autoScrapeDetail({ mediaId = null, seriesKey = null, rerender }) {
  const el = document.getElementById('detail-fetching');
  if (el) el.textContent = '正在从 TMDB 自动获取详细信息…';
  try {
    const r = await api('/api/tmdb/scrape-one', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaId, seriesKey }),
    });
    if (r && r.ok) {
      // 还停在当前详情页才刷新，避免覆盖用户已导航走的新页面
      if (rerender) await rerender();
      return;
    }
    const el2 = document.getElementById('detail-fetching');
    if (el2) el2.textContent = r && r.error ? `自动获取未成功：${r.error}，可点「手动识别」搜索` : '自动获取未成功，可点「手动识别」搜索';
  } catch (e) {
    const el2 = document.getElementById('detail-fetching');
    if (el2) el2.textContent = `自动获取失败：${esc(e.message)}，可点「手动识别」搜索`;
  }
}

function renderFileDetail(m, opts = {}) {
  const poster = posterUrl(m);
  const heroBg = m.backdrop ? `/poster/${encodeURIComponent(m.backdrop)}` : poster;
  const meta = [m.year, fmtDur(m.duration), m.size ? fmtSize(m.size) : '', (m.ext || '').toUpperCase().slice(1)]
    .filter(Boolean).join(' · ');
  const genreBadges = String(m.genre || '').split(',').filter(Boolean)
    .map((g) => `<span class="badge-genre">${esc(g.trim())}</span>`).join('');
  $app.innerHTML = `
    <a class="back-link" data-go="#/home">‹ 返回首页</a>
    <section class="detail-hero"${heroBg ? ` style="background-image:url('${heroBg}')"` : ''}>
      <div class="detail-info">
        <div class="detail-title">${esc(m.tmdb_title || m.title || m.file_name)}</div>
        <div class="detail-meta">
          <span>${esc(meta)}</span>
          ${m.rating ? `<span>★ ${Number(m.rating).toFixed(1)}</span>` : ''}
          ${genreBadges}
        </div>
        ${m.overview ? `<div class="detail-overview">${esc(m.overview)}</div>` : ''}
        <div class="detail-actions">
          <button class="btn-play" data-go="#/play/${m.id}">▶ 播放</button>
          <button class="btn-ghost" id="file-identify" title="手动识别：搜 TMDB 选定正确条目，补全海报与信息">⌕ 手动识别</button>
        </div>
        ${!m.tmdb_id || !m.overview ? '<div class="detail-fetching" id="detail-fetching"></div>' : ''}
      </div>
    </section>`;
  const idfBtn3 = document.getElementById('file-identify');
  if (idfBtn3) idfBtn3.onclick = () => openIdentify(m);
  // 未刮削或缺简介 → 自动抓一次详细内容，成功后原地重渲染（只重试一次防循环）
  if ((!m.tmdb_id || !m.overview) && !opts.retried) {
    autoScrapeDetail({ mediaId: m.id, rerender: async () => {
      const m2 = await api(`/api/media/${m.id}`);
      if (m2.series_key) renderSeriesDetail(m2.series_key);
      else renderFileDetail(m2, { retried: true });
    } });
  }
}
window.addEventListener('hashchange', route);
// 先确定界面模式 + 拉取儿童模式状态，再渲染首屏（精简版要先把导航改造好）
initUiMode().then(async () => { await kidsRefresh(); await loadFeatures(); route(); }, async () => { await loadFeatures(); route(); });

/* ---------------- 游戏库（RomM，可选组件） ----------------
   游戏库独立跑在 Docker 里（默认 8098），自带账号体系。这里不再内嵌它的整页 ——
   实测 RomM 5.3.x 被 iframe 嵌入会把浏览器标签页直接搞崩（顶层打开完全正常）。
   现在的做法：
     ① 装的时候（或设置页）把游戏库的管理员账号密码交给本程序代持一次；
     ② 服务端拿它换会话，/romm/ 的所有请求由代理注入 —— 用户全程免登录；
     ③ 游戏页只取封面和简介做成海报墙，鼠标悬停出大图浮层；
     ④ 点「打开游戏」在新窗口进 RomM 自己的播放页（同源 /romm/，https 域名下也不会被拦）。 */
const GM = { items: [], plats: [], tab: 'retro', plat: '', q: '', offset: 0, limit: 60, total: 0, hoverT: null, closeT: null, docBound: false, last: null, bound: false };
/* 少数平台不走 EmulatorJS：DOS/PC 用 js-dos，PICO-8 和 Flash 各自有专用播放器 */
const GM_KIND = { dos: 'jsdos', pc: 'jsdos', windows: 'jsdos', pico8: 'pico8', flash: 'ruffle' };
function gmPlayUrl(g) {
  const p = String((g && g.platform) || '').toLowerCase();
  return '/romm/rom/' + encodeURIComponent(g.id) + '/' + (GM_KIND[p] || 'ejs');
}
function gmInfoUrl(g) { return '/romm/rom/' + encodeURIComponent(g.id); }
function gmOpen(u) {
  const w = window.open(u, '_blank', 'noopener');
  if (!w && typeof toast === 'function') toast('浏览器拦住了新窗口，请允许本站点弹窗');
}
function gmCardHtml(g) {
  const cover = String(g.cover || '');
  const img = cover
    ? `<img class="gm-cover" src="${esc(cover)}" loading="lazy" alt="" onerror="this.classList.add('gm-nocover')" />`
    : `<div class="gm-cover gm-nocover"><span>🎮</span></div>`;
  return `<div class="gm-card" data-gm="${esc(g.id)}">
    ${img}
    <div class="gm-cname">${esc(g.name)}</div>
    <div class="gm-cplat">${esc(g.platformName || g.platform || '')}</div>
  </div>`;
}
function gmFloatHide() {
  if (GM.hoverT) { clearTimeout(GM.hoverT); GM.hoverT = null; }
  const f = document.getElementById('gm-float');
  if (f) f.style.display = 'none';
  // 浮层是游戏页的（不存在影视页的 hp-float）时，清掉 hpCenterNow 依赖的 HP.card 跟踪目标
  if (HP.card && !document.getElementById('hp-float')) HP.card = null;
}
function gmFloatShow(card) {
  const g = GM.items.find((x) => String(x.id) === String(card.dataset.gm));
  if (!g) return;
  let f = document.getElementById('gm-float');
  if (!f) {
    f = document.createElement('div');
    f.id = 'gm-float';
    f.className = 'gm-float';
    document.body.appendChild(f);
  }
  const cover = String(g.cover || '');
  f.innerHTML = `
    <div class="gm-fimg${cover ? '' : ' gm-nocover'}"${cover ? ' style="background-image:url(' + esc(cover) + ')"' : ''}>${cover ? '' : '<span>🎮</span>'}</div>
    <div class="gm-fbody">
      <div class="gm-fname">${esc(g.name)}</div>
      <div class="gm-fmeta">${esc(g.platformName || g.platform || '')}</div>
      <div class="gm-fsum">${esc(g.summary || '暂无简介')}</div>
      <div class="gm-facts">
        <button class="btn-accent" data-gact="play" data-gm="${esc(g.id)}">▶ 打开游戏</button>
        <button class="btn-ghost" data-gact="info" data-gm="${esc(g.id)}">详情</button>
      </div>
    </div>`;
  f.style.display = 'block';
  const r = card.getBoundingClientRect();
  /* 与影视/音乐等页同一套 Netflix 式定位：浮层中线对齐卡片中线（水平+垂直），
     内容（简介/图片）加载引起高度变化时也保持居中。 */
  HP.card = card;
  hpCenterNow(f, r);
  hpKeepCentered(f, r);
}
/* 点击与悬停都挂在最外层：游戏页是模板字符串整块重画的，绑在具体元素上换页就丢了 */
function gmBindGlobal() {
  if (GM.bound) return;
  GM.bound = true;
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-gact]');
    if (b) {
      const g = GM.items.find((x) => String(x.id) === String(b.dataset.gm));
      if (g) gmOpen(b.dataset.gact === 'info' ? gmInfoUrl(g) : gmPlayUrl(g));
      gmFloatHide();
      return;
    }
    const c = e.target.closest('.gm-card');
    if (c) {
      const g = GM.items.find((x) => String(x.id) === String(c.dataset.gm));
      if (g) gmOpen(gmPlayUrl(g));
    }
  });
  window.addEventListener('scroll', () => gmFloatHide(), true);
}
function gmBindGrid(grid) {
  /* 悬停委托必须挂 document（fm+fn 两轮实测）：浮层居中后会盖住光标，
     Chrome 因布局/DOM 变化给静止光标补发边界事件时 relatedTarget 可能为 null，
     grid 的 mouseleave 守卫拦不住 → 显示→立即隐藏→再显示，最终停在隐藏态。
     改用标准 tooltip 语义：进卡片 300ms 出浮层；mouseover 落在卡片/浮层上就续命；
     mouseout 后 260ms 内没回到卡片/浮层才关。浮层按钮（▶打开游戏/详情）照常可点。 */
  if (GM.docBound) return;
  GM.docBound = true;
  document.addEventListener('mouseover', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const inFloat = t.closest('#gm-float');
    const c = inFloat ? null : t.closest('.gm-card');
    if ((c || inFloat) && GM.closeT) { clearTimeout(GM.closeT); GM.closeT = null; } // 回到卡/浮层：取消关闭
    if (!c || GM.last === c) return;
    GM.last = c;
    if (GM.hoverT) clearTimeout(GM.hoverT);
    GM.hoverT = setTimeout(() => gmFloatShow(c), 300);
  });
  document.addEventListener('mouseout', (e) => {
    const to = e.relatedTarget;
    if (to && to.closest && (to.closest('#gm-float') || to.closest('.gm-card'))) return; // 仍在卡/浮层体系内
    if (!GM.last && !document.getElementById('gm-float')) return; // 非悬停态（别的页面/空闲），别空转
    if (GM.closeT) clearTimeout(GM.closeT);
    GM.closeT = setTimeout(() => { GM.last = null; gmFloatHide(); }, 260);
  });
}
function gmDrawChips() {
  const box = document.getElementById('gm-chips');
  if (!box) return;
  const one = (slug, name, on) => `<button class="gm-chip${on ? ' on' : ''}" data-gp="${esc(slug)}">${esc(name)}</button>`;
  box.innerHTML = one('', '全部', !GM.plat)
    + GM.plats.map((p) => one(p.slug, (p.name || p.slug) + (p.roms ? '（' + p.roms + '）' : ''), GM.plat === p.slug)).join('');
}
async function gmLoadPlats() {
  try {
    const r = await api('/api/games/platforms');
    GM.plats = (r && r.items) || [];
  } catch { GM.plats = []; }
  gmDrawChips();
}
async function gmLoadList(reset) {
  const grid = document.getElementById('gm-grid');
  if (!grid) return;
  if (reset) { GM.offset = 0; GM.items = []; }
  GM.loading = true;
  let r = { ok: false, items: [], total: 0 };
  const qs = 'limit=' + GM.limit + '&offset=' + GM.offset
    + (GM.plat ? '&platform=' + encodeURIComponent(GM.plat) : '')
    + (GM.q ? '&q=' + encodeURIComponent(GM.q) : '');
  try { r = await api('/api/games/list?' + qs); } catch (e) { r = { ok: false, error: String(e.message || e) }; }
  GM.loading = false;
  const cnt = document.getElementById('gm-count');
  if (cnt) cnt.textContent = r && r.total ? '（' + r.total + '）' : '';
  if (!r || !r.ok) {
    if (reset) {
      grid.innerHTML = '<div class="gm-empty">取不到游戏列表：' + esc((r && r.error) || '未知错误')
        + '<br><button class="btn-ghost" id="gm-recred">重新填一次账号</button></div>';
      const rb = document.getElementById('gm-recred');
      if (rb) rb.onclick = () => gmShowCred();
    }
    const mb = document.getElementById('gm-more');
    if (mb) mb.style.display = 'none';
    return;
  }
  GM.total = r.total || 0;
  GM.items = reset ? (r.items || []) : GM.items.concat(r.items || []);
  if (!GM.items.length) {
    // 空库不丢一句冷冰冰的「还没有游戏」：直接给能走通的两条路（装现成的 / 传自己的）
    let romDir = '';
    try { const c = await api('/api/games/catalog'); romDir = (c && c.romDir) || ''; } catch { /* 拿不到目录就不显示 */ }
    GDL.onRefresh = () => gmLoadList(true);
    grid.innerHTML = `
      <div class="gm-blank">
        <div class="gm-blank-ico">🕹️</div>
        <div class="gm-blank-t">游戏库还是空的</div>
        <div class="gm-blank-p">两条路，挑一条就行：装几个现成的免费游戏，或者把你自己的 ROM 放进来 —— 放好约 1 分钟，封面和游戏就自己出现了。</div>
        <div class="gm-blank-acts">
          <button class="btn-accent" id="gm-blank-store" style="font-size:15px;padding:10px 22px">⬇ 一键装游戏（免费）</button>
          <button class="btn-ghost" id="gm-blank-up">⬆ 上传我自己的 ROM</button>
          <button class="btn-ghost" id="gm-blank-refresh">↻ 刷新</button>
        </div>
        <div class="gm-blank-dir">${romDir
          ? 'ROM 目录：' + esc(romDir) + '<br>把 ROM 按平台放进子目录（nes / snes / gba …），游戏库会自动扫描入库。'
          : '把 ROM 按平台放进 NAS 的 ROM 目录子目录（nes / snes / gba …），游戏库会自动扫描入库。'}</div>
      </div>`;
    const bs = document.getElementById('gm-blank-store');
    if (bs) bs.onclick = () => gamesStoreOpen();
    const bu = document.getElementById('gm-blank-up');
    if (bu) bu.onclick = () => gamesStoreOpen();
    const br = document.getElementById('gm-blank-refresh');
    if (br) br.onclick = () => gmLoadList(true);
    const mb = document.getElementById('gm-more');
    if (mb) mb.style.display = 'none';
    return;
  }
  grid.innerHTML = GM.items.map(gmCardHtml).join('');
  gmBindGrid(grid);
  const mb = document.getElementById('gm-more');
  if (mb) mb.style.display = GM.items.length < GM.total ? 'inline-block' : 'none';
}
function gmCredHtml(cred) {
  const err = cred && cred.login && cred.login.error ? cred.login.error : '';
  const has = !!(cred && cred.configured);
  return `
    <div class="gm-cred">
      <div class="gm-cred-t">${has ? '游戏库登录不上' : '先连一次游戏库，之后全家都不用登录'}</div>
      <div class="gm-cred-p">
        把游戏库（RomM）的管理员账号密码交给本程序代持一次：之后电视、手机、平板打开游戏页都不再要账号，点封面直接开玩。<br>
        凭据只存在这台 NAS 上（影视库自己的设置里），不会传给任何外部。
      </div>
      ${err ? '<div class="gm-cred-err">❌ ' + esc(err) + '</div>' : ''}
      <div class="gm-cred-row">
        <label>游戏库账号</label>
        <input id="gm-cu" type="text" autocomplete="off" value="${esc((cred && cred.user) || '')}" placeholder="RomM 的管理员用户名" />
      </div>
      <div class="gm-cred-row">
        <label>密码</label>
        <input id="gm-cp" type="password" autocomplete="off" placeholder="${has ? '已保存，留空表示不改' : 'RomM 的登录密码'}" />
      </div>
      <div class="gm-cred-acts">
        <button class="btn-accent" id="gm-csave">保存并连接</button>
        <a class="gm-cred-link" href="/romm/" target="_blank" rel="noopener">还没建账号？先去建一个 ›</a>
      </div>
      <div class="gm-cred-st" id="gm-cst"></div>
    </div>`;
}
async function gmShowCred() {
  const box = document.getElementById('gm-credbox');
  if (!box) return;
  let cred = { configured: false, login: null, user: '' };
  try { cred = await api('/api/games/cred'); } catch { /* 接口不通也照样给表单 */ }
  box.innerHTML = gmCredHtml(cred);
  box.style.display = 'block';
  const sb = document.getElementById('gm-csave');
  if (sb) sb.onclick = async () => {
    if (!(await adminEnsureUnlocked())) return;
    const u = (document.getElementById('gm-cu') || {}).value || '';
    const p = (document.getElementById('gm-cp') || {}).value || '';
    const stx = document.getElementById('gm-cst');
    sb.disabled = true;
    if (stx) stx.textContent = '正在连接游戏库…';
    try {
      const r = await api('/api/games/cred', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: u, pass: p }),
      });
      if (r && r.ok) {
        if (document.getElementById('gm-main')) { await renderGames(); return; } // 游戏页：整页重绘
        toast('游戏库账号已保存 —— 回「游戏」页即可免登录开玩'); // 设置页：留在原地
        box.style.display = 'none';
        return;
      }
      if (stx) stx.textContent = '❌ ' + ((r && r.error) || '连接失败');
    } catch (e) { if (stx) stx.textContent = '❌ ' + String(e.message || e); }
    sb.disabled = false;
  };
}
/* 游戏中心总入口：两页签 —— 复古游戏库（RomM）｜PC 游戏（Steam）
   分工刻意做成「互不依赖」：RomM 没装也能看 PC 游戏。 */
async function renderGames() {
  $app.innerHTML = `
    <a class="back-link" data-go="#/home">‹ 返回首页</a>
    <div class="gm-tabs" id="gm-tabs">
      <button class="gm-tab${GM.tab === 'retro' ? ' on' : ''}" data-gt="retro">🕹 复古游戏库</button>
      <button class="gm-tab${GM.tab === 'steam' ? ' on' : ''}" data-gt="steam">🎮 PC 游戏</button>
    </div>
    <div id="gm-pane"></div>`;
  const tb = document.getElementById('gm-tabs');
  if (tb) tb.onclick = (e) => {
    const b = e.target.closest('[data-gt]');
    if (!b) return;
    const want = String(b.dataset.gt || '');
    if (!want || want === GM.tab) return;
    GM.tab = want;
    renderGames();
  };
  gmFloatHide(); stFloatHide();
  if (GM.tab === 'steam') return stRenderLibrary();
  if (GM.tab === 'stream') { GM.tab = 'retro'; }
  return gmRenderRom();
}

async function gmRenderRom() {
  const pane = document.getElementById('gm-pane') || $app;
  let st = { alive: false, url: '', port: 8098 };
  try { st = Object.assign(st, await api('/api/games/status')); } catch { /* 探测失败按未安装处理 */ }

  if (!st.alive) {
    pane.innerHTML = `
      <div class="games-setup">
        <div class="games-setup-ico">🎮</div>
        <div class="games-setup-t">复古游戏库还没装好</div>
        <div class="games-setup-p">这部分是可选组件，需要 NAS 支持 Docker 才能安装。<br>装好后可以在网页里整理、刮削封面，并直接在浏览器里玩 FC/GBA/PS 等复古游戏。</div>
        <div class="games-setup-cmd">sh romm/install-romm.sh</div>
        <div class="games-setup-p">游戏 ROM 需要自己准备：放进 NAS 的 ROM 目录后，<br>在游戏库网页里点「扫描」即可入库。</div>
        <div class="games-setup-alt">现阶段可以先用旁边的「🎮 PC 游戏」—— 它不依赖 Docker。</div>
        <button class="btn-accent" id="games-recheck">重新检测</button>
      </div>`;
    const rb = document.getElementById('games-recheck');
    if (rb) rb.onclick = () => renderGames();
    return;
  }

  let cred = { configured: false, login: null, user: '' };
  try { cred = await api('/api/games/cred'); } catch { /* 接口不通按未配置处理 */ }
  const ready = !!(cred.configured && cred.login && cred.login.ok);

  pane.innerHTML = `
    <a class="back-link" data-go="#/home">‹ 返回首页</a>
    <div class="gm-head">
      <div class="gm-head-t">🎮 游戏库<span class="gm-head-n" id="gm-count"></span></div>
      <div class="gm-head-acts">
        <button class="btn-ghost" id="gm-all">🗂 完整游戏库</button>
        <button class="btn-ghost" id="gm-store">⬇ 游戏商店</button>
        <button class="btn-ghost" id="gm-refresh">↻ 刷新</button>
      </div>
    </div>
    <div id="gm-credbox" style="display:${ready ? 'none' : 'block'}">${ready ? '' : gmCredHtml(cred)}</div>
    <div id="gm-main" style="display:${ready ? 'block' : 'none'}">
      <div class="gm-bar">
        <div class="gm-chips" id="gm-chips"></div>
        <input class="gm-search" id="gm-q" type="text" placeholder="搜索游戏…" value="${esc(GM.q)}" />
      </div>
      <div class="gm-grid" id="gm-grid"><div class="gm-empty">载入中…</div></div>
      <div class="gm-morebox"><button class="btn-ghost" id="gm-more" style="display:none">加载更多</button></div>
    </div>`;

  gmBindGlobal();
  const allb = document.getElementById('gm-all');
  if (allb) allb.onclick = () => gmOpen('/romm/');
  const stb = document.getElementById('gm-store');
  if (stb) stb.onclick = () => gamesStoreOpen();
  const rf = document.getElementById('gm-refresh');
  if (rf) rf.onclick = () => { GM.plat = ''; GM.q = ''; renderGames(); };
  const qb = document.getElementById('gm-q');
  if (qb) {
    let t = null;
    qb.oninput = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { GM.q = String(qb.value || '').trim(); gmLoadList(true); }, 400);
    };
  }
  const ch = document.getElementById('gm-chips');
  if (ch) ch.onclick = (e) => {
    const b = e.target.closest('[data-gp]');
    if (!b) return;
    GM.plat = String(b.dataset.gp || '');
    gmDrawChips();
    gmLoadList(true);
  };
  const mb = document.getElementById('gm-more');
  if (mb) mb.onclick = () => { GM.offset += GM.limit; gmLoadList(false); };

  if (ready) {
    await gmLoadPlats();
    await gmLoadList(true);
  }
}


/* ---------------- 游戏中心 · PC 游戏（Steam 本机库） ----------------
   原理：Steam 把自己的库存写成两份明文文件 ——
     steamapps/libraryfolders.vdf   库存位置清单
     steamapps/appmanifest_<id>.acf 单个已装游戏的明细（名字/安装目录/体积/更新时间）
   读这两份就能出完整的海报墙：不用 Steam API Key，不用联网，Steam 客户端开着开着也能看。
   封面走本服务代理回 Steam 公开 CDN（失败自动从竖版兜底到横版），并对「确实没封面」做 7 天负缓存。 */
const ST = { cfg: null, items: [], stats: {}, q: '', hosts: [], hoverT: null, closeT: null, last: null, docBound: false };

function stFmtDate(sec) {
  const t = Number(sec) || 0;
  if (!t) return '';
  const d = new Date(t * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

async function stCfg(force) {
  if (!ST.cfg || force) {
    try { ST.cfg = await api('/api/games/steam/config'); }
    catch { ST.cfg = { roots: [], suggested: [], platform: '' }; }
  }
  return ST.cfg;
}

function stCardHtml(g) {
  const cover = String(g.cover || '');
  const img = cover
    ? `<img class="gm-cover" src="${esc(cover)}" loading="lazy" alt="" onerror="this.classList.add('gm-nocover')" />`
    : `<div class="gm-cover gm-nocover"><span>🎮</span></div>`;
  return `<div class="st-card" data-sid="${esc(g.appid)}">
    ${img}
    <div class="gm-cname">${esc(g.name)}</div>
    <div class="gm-cplat">${esc(g.size ? fmtSize(g.size) : 'Steam')}</div>
  </div>`;
}

async function stLoadList(force) {
  const grid = document.getElementById('st-grid');
  if (!grid) return;
  const cnt = document.getElementById('st-count');
  if (force) grid.innerHTML = '<div class="gm-empty">正在扫描 Steam 库…</div>';
  const qs = new URLSearchParams();
  if (ST.q) qs.set('q', ST.q);
  if (force) qs.set('refresh', '1');
  const s = qs.toString();
  let r = { ok: false, items: [], stats: {}, roots: [] };
  try { r = await api('/api/games/steam/list' + (s ? '?' + s : '')); }
  catch (e) { r = { ok: false, error: String(e.message || e), items: [] }; }
  ST.items = r.items || [];
  ST.stats = r.stats || {};
  if (cnt) cnt.textContent = ST.items.length ? '（' + ST.items.length + '）' : '';
  if (!ST.items.length) {
    const hid = ST.stats && ST.stats.hidden ? '（另有 ' + ST.stats.hidden + ' 个 Steam 运行环境已被自动折叠）' : '';
    grid.innerHTML = `
      <div class="gm-blank">
        <div class="gm-blank-ico">🎮</div>
        <div class="gm-blank-t">${esc((r.error || ST.q) ? '没找到匹配的游戏' : '这个 Steam 库里还没有已装的游戏')}</div>
        <div class="gm-blank-p">${esc(r.error || '')}${ST.q ? '换个关键词试试。' : 'Steam 安装过游戏之后，这里会自动出现海报墙（含封面和体积）。' + hid}</div>
        <div class="gm-blank-acts">
          <button class="btn-accent" id="st-blank-go">去设置 › 🎮 PC 游戏 填库位置</button>
        </div>
        <div class="gm-blank-dir">扫的是 Steam 目录里的 appmanifest_*.acf 清单文件 —— 不联网、不用 Key，Steam 客户端不开也能读。</div>
      </div>`;
    const bg = document.getElementById('st-blank-go');
    if (bg) bg.onclick = () => { location.hash = '#/library'; };
    return;
  }
  grid.innerHTML = ST.items.map(stCardHtml).join('');
  stBindGrid();
}

function stFloatHide() {
  if (ST.hoverT) { clearTimeout(ST.hoverT); ST.hoverT = null; }
  const f = document.getElementById('st-float');
  if (f) f.style.display = 'none';
  if (HP.card && !document.getElementById('hp-float')) HP.card = null;
}
function stFloatShow(card) {
  const g = ST.items.find((x) => String(x.appid) === String(card.dataset.sid));
  if (!g) return;
  let f = document.getElementById('st-float');
  if (!f) {
    f = document.createElement('div');
    f.id = 'st-float';
    f.className = 'gm-float';
    document.body.appendChild(f);
  }
  const meta = [g.size ? fmtSize(g.size) : '', g.updated ? '更新于 ' + stFmtDate(g.updated) : ''].filter(Boolean).join(' · ') || 'Steam 已安装';
  f.innerHTML = `
    <div class="gm-fimg"${g.cover ? ' style="background-image:url(' + esc(g.cover) + ')"' : ''}>${g.cover ? '' : '<span>🎮</span>'}</div>
    <div class="gm-fbody">
      <div class="gm-fname">${esc(g.name)}</div>
      <div class="gm-fmeta">${esc(meta)}</div>
      <div class="gm-facts">
        <button class="btn-accent" data-sact="run" data-sid="${esc(g.appid)}">▶ 本机启动</button>
        <a class="btn-ghost" href="${esc(g.storeUrl)}" target="_blank" rel="noopener">商店页</a>
      </div>
      <div class="st-tip" id="st-tip"></div>
    </div>`;
  f.style.display = 'block';
  const r = card.getBoundingClientRect();
  HP.card = card;
  hpCenterNow(f, r);
  hpKeepCentered(f, r);
}

/* 本机启动：steam://rungameid/<id> 是 Steam 官方协议，点链接就等于「在这个终端上玩」。
   用隐藏 <a> 点击而不是 location.href —— 后者在协议没表时可能把页面导航走。 */
function steamLaunch(appid, tipBox) {
  const u = 'steam://rungameid/' + String(appid).replace(/[^\d]/g, '');
  try {
    const a = document.createElement('a');
    a.href = u;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { a.remove(); } catch { /* noop */ } }, 3000);
  } catch { /* 浏览器拦了协议唤起，下面文案照常给出 */ }
  if (tipBox) {
    tipBox.textContent = '已经向 Steam 发出启动请求。'
      + '如果本机没装 Steam，点了不会有任何反应。';
  }
}

async function stRenderLibrary() {
  const pane = document.getElementById('gm-pane') || $app;
  const cfg = await stCfg(true);
  pane.innerHTML = `
    <div class="gm-head">
      <div class="gm-head-t">🎮 PC 游戏<span class="gm-head-n" id="st-count"></span></div>
      <div class="gm-head-acts"></div>
    </div>
    <div class="gm-bar">
      <div class="gm-chips" id="st-chips"></div>
      <input class="gm-search" id="st-q" type="text" placeholder="搜索 PC 游戏…" value="${esc(ST.q)}" />
    </div>
    <div class="gm-grid" id="st-grid"><div class="gm-empty">载入中…</div></div>`;
  const qb = document.getElementById('st-q');
  if (qb) {
    let t = null;
    qb.oninput = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { ST.q = String(qb.value || '').trim(); stLoadList(true); }, 400);
    };
  }
  await stLoadList(true);
}

function stCfgToggle(forceOpen) {
  const box = document.getElementById('st-cfgbox');
  if (!box) return;
  const open = forceOpen || box.style.display === 'none';
  box.style.display = open ? 'block' : 'none';
  if (open) { stCfgDraw(); }
}
async function stCfgDraw() {
  const box = document.getElementById('st-cfgbox');
  if (!box) return;
  const cfg = await stCfg();
  const cur = cfg.roots || [];
  const sug = (cfg.suggested || []).filter((s) => !cur.includes(s));
  box.innerHTML = `
    <div class="gm-cred-t">Steam 库位置</div>
    <div class="gm-cred-p">
      填 Steam 的安装目录（里面要有 steamapps 文件夹）。程序会去读它的 appmanifest_*.acf 清单，
      把装了的游戏、体积、更新时间原样列出来 —— 不联网、不用 Steam 账号，Steam 客户端开着也能读。<br>
      如果 HMP 跑在别的设备（如 NAS），需要把装 Steam 的那台电脑的游戏目录共享出来、挂到 HMP 所在设备，再填挂载后的路径。
    </div>
    <details class="gm-tut" style="margin:10px 0 4px;border:1px solid var(--line,#333);border-radius:10px;padding:0;background:var(--card,#1c1c22);overflow:hidden">
      <summary style="cursor:pointer;padding:10px 12px;font-weight:600;color:var(--text,#eee);user-select:none">📖 怎么把 Steam 游戏目录挂过来？（点开看教程）</summary>
      <div style="padding:10px 14px 14px;line-height:1.7;font-size:13px;color:var(--text2,#bbb)">
        <p style="margin:0 0 8px"><b style="color:var(--text,#eee)">先判断：HMP 跑在哪？</b></p>
        <p style="margin:0 0 6px"><b style="color:var(--text,#eee)">情况 A｜HMP 和 Steam 在同一台 Windows 电脑</b><br>
        不用共享，直接填 Steam 库的本机路径：主库 <code>C:\\Program Files (x86)\\Steam</code>，或自定义库（Steam → 设置 → 下载 → 内容库看到的路径，如 <code>D:\\SteamLibrary</code>）。填进去点「保存并扫描」即可。</p>
        <p style="margin:0 0 6px"><b style="color:var(--text,#eee)">情况 B｜HMP 在 NAS / 另一台设备，Steam 在另一台 Windows</b><br>
        两步：先把 Windows 上的 Steam 库共享出去，再在 HMP 运行的设备上把它挂成本地目录。</p>
        <p style="margin:4px 0"><b style="color:var(--text,#eee)">① Windows 电脑共享 Steam 库</b>（选含 steamapps 的库根目录）<br>
        1) 右键文件夹 → 属性 → 共享 → 高级共享 → 勾「共享此文件夹」，共享名填 <code>steamlib</code><br>
        2) 权限给 Everyone（或你的账户）<b>读取</b>权限<br>
        3) 网络和共享中心：开「网络发现」+「文件和打印机共享」，网络设为<b>专用</b><br>
        4) 记下：Windows 局域网 IP（如 192.168.1.50）、共享名、登录账号密码<br>
        <span style="color:var(--warn,#e0a)">注</span>：Windows 家庭版禁用来宾，挂载要用带密码账户；Microsoft 账户登录就填邮箱+密码。</p>
        <p style="margin:4px 0"><b style="color:var(--text,#eee)">② 在「运行 HMP 的设备」上挂载这个共享</b><br>
        核心：用 HMP 所在系统支持的方式把 SMB 共享挂成<b>本地目录</b>，然后填那个本地目录（不是 Windows 的 <code>F:\\steam</code>）。<br>
        • <b>NAS（群晖/威联通/Unraid/TrueNAS/飞牛等）</b>：文件管理器里「挂载远程文件夹 / 网络磁盘 / CIFS」填 Windows IP + 共享名 + 凭据，得到如 <code>/volume1/steamlib</code><br>
        • <b>Linux（命令行）</b>：<code>sudo mount -t cifs //192.168.1.50/steamlib /mnt/steamlib -o username=账户,password=密码,vers=3.0</code><br>
        • <b>macOS</b>：访达 → 前往 → 连接服务器 → <code>smb://192.168.1.50/steamlib</code><br>
        • <b>Windows（HMP 也跑在 Win）</b>：此电脑 → 映射网络驱动器 → <code>\\\\192.168.1.50\\steamlib</code></p>
        <p style="margin:4px 0"><b style="color:var(--text,#eee)">③ 回 HMP 填挂载后的路径</b>：如 <code>/volume1/steamlib</code> 或 <code>/mnt/steamlib</code>，点「保存并扫描」。</p>
        <p style="margin:6px 0 0"><b style="color:var(--text,#eee)">排错</b><br>
        • 填了 <code>F:\\steam</code> 读不到：那是 Windows 侧路径，其他设备服务端读不到，必须填 HMP 本地的挂载路径<br>
        • 挂载后目录为空：查 Windows 防火墙放行「文件和打印机共享(SMB)」、共享权限是否给读取<br>
        • HMP 报无权访问：给挂载目录开读取权限（Everyone 可读最省事）</p>
      </div>
    </details>
    <div class="st-cfg-list" id="st-cfg-list">${cur.length
      ? cur.map((p) => `<span class="st-path">📁 ${esc(p)}<button class="st-path-x" data-sp="${esc(p)}" title="移除">✕</button></span>`).join('')
      : '<span class="st-path st-path-none">还没填任何位置</span>'}</div>
    ${sug.length ? `<div class="gm-k" style="margin:12px 0 6px">自动探测到的位置（点一下即可加入）</div>
      <div class="gm-chips">${sug.map((p) => `<button class="gm-chip" data-sug="${esc(p)}">＋ ${esc(p)}</button>`).join('')}</div>` : ''}
    <div class="gm-cred-row" style="margin-top:14px">
      <label>手动添加</label>
      <input id="st-newpath" type="text" placeholder="例：C:\\Program Files (x86)\\Steam  或  /mnt/pc/SteamLibrary" />
    </div>
    <div class="gm-cred-acts">
      <button class="btn-accent" id="st-cfg-save">保存并扫描</button>
      <span class="gm-cred-st" id="st-cfg-st"></span>
    </div>`;
  const list = document.getElementById('st-cfg-list');
  if (list) list.onclick = async (e) => {
    const x = e.target.closest('[data-sp]');
    if (!x) return;
    const cfg2 = await stCfg();
    await stSaveRoots((cfg2.roots || []).filter((p) => p !== x.dataset.sp));
  };
  const chips = document.querySelector('#st-cfgbox .gm-chips');
  if (chips) chips.onclick = async (e) => {
    const b = e.target.closest('[data-sug]');
    if (!b) return;
    const cfg2 = await stCfg();
    await stSaveRoots((cfg2.roots || []).concat([b.dataset.sug]));
  };
  const sb = document.getElementById('st-cfg-save');
  if (sb) sb.onclick = async () => {
    const v = String((document.getElementById('st-newpath') || {}).value || '').trim();
    if (!v) { const t = document.getElementById('st-cfg-st'); if (t) t.textContent = '先填个路径，或者点上面的自动探测'; return; }
    const cfg2 = await stCfg();
    await stSaveRoots((cfg2.roots || []).concat([v]));
  };
}
async function stSaveRoots(list) {
  const stx = document.getElementById('st-cfg-st');
  if (stx) stx.textContent = '正在保存…';
  if (!(await adminEnsureUnlocked())) { if (stx) stx.textContent = '需要管理密码'; return; }
  try {
    const r = await api('/api/games/steam/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roots: list }),
    });
    if (!r || !r.ok) throw new Error((r && r.error) || '保存失败');
    ST.cfg = null;
    await stCfg(true);
    stCfgDraw();
    await stLoadList(true);
    const n = (ST.stats && ST.stats.total) || ST.items.length;
    toast(list.length ? ('已保存，扫到 ' + n + ' 个游戏') : '已清空 Steam 库位置');
  } catch (e) {
    if (stx) stx.textContent = '❌ ' + String(e.message || e);
  }
}

function stBindGrid() {
  if (ST.docBound) return;
  ST.docBound = true;
  document.addEventListener('mouseover', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const inFloat = t.closest('#st-float');
    const c = inFloat ? null : t.closest('.st-card');
    if ((c || inFloat) && ST.closeT) { clearTimeout(ST.closeT); ST.closeT = null; }
    if (!c || ST.last === c) return;
    ST.last = c;
    if (ST.hoverT) clearTimeout(ST.hoverT);
    ST.hoverT = setTimeout(() => stFloatShow(c), 300);
  });
  document.addEventListener('mouseout', (e) => {
    const to = e.relatedTarget;
    if (to && to.closest && (to.closest('#st-float') || to.closest('.st-card'))) return;
    if (!ST.last && !document.getElementById('st-float')) return;
    if (ST.closeT) clearTimeout(ST.closeT);
    ST.closeT = setTimeout(() => { ST.last = null; stFloatHide(); }, 260);
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sact]');
    if (b) {
      const id = String(b.dataset.sid || '');
      if (b.dataset.sact === 'run') steamLaunch(id, document.getElementById('st-tip'));
      return;
    }
    const c = e.target.closest('.st-card');
    if (c) { stFloatShow(c); }
  });
  window.addEventListener('scroll', () => stFloatHide(), true);
}

/* ---------------- 游戏库 · 封面数据源（可选 Key） ----------------
   不填也能用：游戏库自带免注册的数据源，能刮出基本封面。
   填了这几家（都是免费注册）之后，封面/简介/发行信息会明显更准。
   Key 写进游戏库自己的配置文件里，本程序只负责「填进去 + 校验 + 让它生效」。 */
async function gamesMetaOpen() {
  const mask = document.createElement('div');
  mask.className = 'gdl-mask';
  mask.id = 'gm-mask';
  let cur = { ok: false, dir: '', keys: [] };
  try { cur = await api('/api/games/meta/keys'); } catch { /* 探测失败按未安装处理 */ }
  const rows = (cur.keys || []).map((k) => `
    <div class="gm-row">
      <div class="gm-k">${esc(k.label)}</div>
      <input class="gm-in" data-mk="${esc(k.key)}" type="${k.secret ? 'password' : 'text'}" autocomplete="off"
             placeholder="${k.set ? '已保存 ' + esc(k.preview || '') + '（清空后保存＝删除）' : esc(k.hint)}" />
      <div class="gm-hint">${esc(k.hint)}</div>
    </div>`).join('');
  mask.innerHTML = `
    <div class="gdl-panel">
      <div class="gdl-head">
        <span class="gdl-head-t">封面数据源（可选）</span>
        <span class="gdl-sub">不填也能用 —— 游戏库自带免注册的数据源。填了之后封面、简介会更准：这几家都是免费注册，拿到后粘进来保存即可（自动重启游戏库生效）。</span>
        <button class="gdl-x" title="关闭">✕</button>
      </div>
      <div class="gdl-body">
        ${cur.ok ? rows : '<div class="gdl-desc" style="padding:20px 0">没找到游戏库的配置目录（游戏库与影视库装在同一层时会自动识别）。</div>'}
        <div class="gm-row">
          <div class="gm-k">RetroAchievements 用户名</div>
          <input class="gm-in" data-mk="RETROACHIEVEMENTS_USER" type="text" autocomplete="off" placeholder="只用于校验 Key，不保存" />
          <div class="gm-hint">选填 · 填了才能在线校验 RetroAchievements 的 Key</div>
        </div>
        <div class="gm-status" id="gm-status"></div>
        <div class="gm-acts">
          <button class="btn-accent" id="gm-save">💾 保存并应用</button>
          <button class="btn-ghost" id="gm-test">✓ 在线校验</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  const xb = mask.querySelector('.gdl-x');
  if (xb) xb.onclick = close;
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  const vals = () => {
    const o = {};
    mask.querySelectorAll('.gm-in').forEach((i) => { o[i.dataset.mk] = String(i.value || '').trim(); });
    return o;
  };
  const status = (m) => { const el = mask.querySelector('#gm-status'); if (el) el.textContent = m; };
  const sb = mask.querySelector('#gm-save');
  if (sb) sb.onclick = async () => {
    if (!(await adminEnsureUnlocked())) return;
    sb.disabled = true;
    status('保存中…（会重启游戏库，约 20 秒）');
    try {
      const r = await api('/api/games/meta/keys', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(vals()),
      });
      const hb = r && r.restart && r.restart.heartbeat ? r.restart.heartbeat : null;
      let msg = '✅ 已保存' + (r && r.restart && r.restart.ok ? '并重启了游戏库' : '（游戏库没在运行，下次启动生效）');
      if (hb) {
        const on = [];
        if (hb.igdb) on.push('IGDB');
        if (hb.steamgriddb) on.push('SteamGridDB');
        if (hb.hasheous) on.push('免注册源');
        msg += ' · 当前生效：' + (on.length ? on.join(' / ') : '仅免注册源');
      }
      status(msg);
    } catch (e) { status('保存失败：' + e.message); }
    sb.disabled = false;
  };
  const tb = mask.querySelector('#gm-test');
  if (tb) tb.onclick = async () => {
    tb.disabled = true;
    status('校验中…');
    try {
      const r = await api('/api/games/meta/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(vals()),
      });
      const rs = (r && r.results) || [];
      status(rs.length ? rs.map((x) => (x.ok ? '✅ ' : '❌ ') + x.key + '：' + x.msg).join(String.fromCharCode(10))
        : '没有填任何 Key，无需校验');
    } catch (e) { status('校验失败：' + e.message); }
    tb.disabled = false;
  };
}
/* ---------------- 游戏商店 ----------------
   免费合法 ROM 一键下载；本机 ROM 上传（自动识别平台目录）。
   文件落到 RomM 的 ROM 目录后，RomM 的文件监听约 1 分钟内自动扫描入库。 */
const GAME_PLAT_LABEL = {
  nes: 'FC / NES', fds: 'FDS', snes: 'SFC / SNES', n64: 'N64', gb: 'Game Boy',
  gbc: 'GBC', gba: 'GBA', nds: 'NDS', psx: 'PS1', md: '世嘉 MD', sega32x: 'MD 32X',
  tg16: 'PCE', atari2600: 'Atari 2600', atari7800: 'Atari 7800',
  wonderswan: 'WS', 'wonderswan-color': 'WSC', 'neo-geo-pocket': 'NGP',
  'neo-geo-pocket-color': 'NGPC', lynx: 'Lynx',
};
const GDL = { timer: null, cat: null, ups: {}, needRefetch: false };
function gdlStop() { if (GDL.timer) { clearInterval(GDL.timer); GDL.timer = null; } }
function gdlPlatName(p) { return GAME_PLAT_LABEL[p] || p; }
function gdlRowHtml(g) {
  const jobs = (GDL.cat && GDL.cat.jobs) || [];
  const job = jobs.find((j) => j.id === g.id);
  let act = '';
  if (job && (job.status === 'downloading' || job.status === 'pending')) {
    const pct = job.total ? Math.min(100, Math.round((job.downloaded * 100) / job.total)) : 0;
    act = `<div class="gdl-bar"><div class="gdl-bar-in" style="width:${pct}%"></div></div><span class="gdl-pct">${pct}%</span>`;
  } else if (job && job.status === 'error') {
    act = `<span class="gdl-err">失败：${esc(job.error || '')}</span><button class="btn-ghost" data-gdl="${esc(g.id)}">重试</button>`;
  } else if (g.installed) {
    act = `<span class="gdl-ok">✓ 已入库</span>`;
  } else {
    act = `<button class="btn-accent" data-gdl="${esc(g.id)}">下载</button>`;
  }
  return `<div class="gdl-row">
    <span class="gdl-tag">${esc(gdlPlatName(g.platform))}</span>
    <div class="gdl-info">
      <div class="gdl-name">${esc(g.name)}</div>
      <div class="gdl-desc">${esc(g.desc || '')}</div>
    </div>
    <div class="gdl-act">${act}</div>
  </div>`;
}
function gdlDrawList() {
  const box = document.getElementById('gdl-list');
  if (!box || !GDL.cat) return;
  const games = GDL.cat.games || [];
  const order = ['nes', 'snes', 'n64', 'gb', 'gbc', 'gba', 'nds', 'psx', 'psp', 'md'];
  const plats = Array.from(new Set(games.map((g) => g.platform)))
    .sort((a, b) => (order.indexOf(a) + 99 || 99) - (order.indexOf(b) + 99 || 99));
  box.innerHTML = plats.map((p) => {
    const rows = games.filter((g) => g.platform === p).map(gdlRowHtml).join('');
    return `<div class="gdl-group">${esc(gdlPlatName(p))}</div>${rows}`;
  }).join('');
}
function gdlDrawUps() {
  const box = document.getElementById('gdl-ups');
  if (!box) return;
  const ids = Object.keys(GDL.ups);
  box.innerHTML = ids.length ? '<div class="gdl-group">本次上传</div>' + ids.map((uid) => {
    const u = GDL.ups[uid];
    let right = '';
    if (u.status === 'uploading') {
      right = `<div class="gdl-bar"><div class="gdl-bar-in" style="width:${u.pct}%"></div></div><span class="gdl-pct">${u.pct}%</span>`;
    } else if (u.status === 'done') {
      right = `<span class="gdl-ok">✓ ${esc(u.msg || '已入库')}</span>`;
    } else {
      right = `<span class="gdl-err">${esc(u.msg || '失败')}</span>`;
    }
    return `<div class="gdl-row">
      <span class="gdl-tag">上传</span>
      <div class="gdl-info"><div class="gdl-name">${esc(u.name)}</div></div>
      <div class="gdl-act">${right}</div>
    </div>`;
  }).join('') : '';
}
async function gdlRefreshCat() {
  try {
    const c = await api('/api/games/catalog');
    if (GDL.cat) GDL.cat = Object.assign(GDL.cat, c);
    gdlDrawList();
  } catch { /* ignore */ }
}
function gdlSend(f) {
  const uid = 'up-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  GDL.ups[uid] = { name: f.name, pct: 0, status: 'uploading', msg: '' };
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/games/upload');
  xhr.setRequestHeader('x-game-filename', encodeURIComponent(f.name));
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) { GDL.ups[uid].pct = Math.round((e.loaded * 100) / e.total); gdlDrawUps(); } };
  xhr.onload = () => {
    let r = {};
    try { r = JSON.parse(xhr.responseText || '{}'); } catch { /* ignore */ }
    if (xhr.status === 200 && r.ok) {
      GDL.ups[uid].status = 'done';
      GDL.ups[uid].msg = '已入库 → ' + gdlPlatName(r.platform);
      GDL.needRefetch = true;
      gdlRefreshCat();
    } else {
      GDL.ups[uid].status = 'error';
      GDL.ups[uid].msg = r.error || ('上传失败(' + xhr.status + ')');
    }
    gdlDrawUps();
  };
  xhr.onerror = () => { GDL.ups[uid].status = 'error'; GDL.ups[uid].msg = '网络错误'; gdlDrawUps(); };
  xhr.send(f);
  gdlDrawUps();
}
async function gamesStoreOpen() {
  gdlStop();
  GDL.ups = {};
  GDL.needRefetch = false;
  let cat = { ok: false, games: [], jobs: [], romDir: '' };
  try { cat = Object.assign(cat, await api('/api/games/catalog')); } catch { /* 异常按空目录 */ }
  GDL.cat = cat;
  const mask = document.createElement('div');
  mask.className = 'gdl-mask';
  mask.innerHTML = `
    <div class="gdl-panel">
      <div class="gdl-head">
        <span class="gdl-head-t">游戏商店</span>
        <span class="gdl-sub">免费合法 homebrew 游戏 · 下载/上传自动放进对应平台目录，游戏库约 1 分钟内自动扫描入库</span>
        <button class="gdl-x" title="关闭">✕</button>
      </div>
      <div class="gdl-body">
        ${cat.ok ? `
        <div class="gdl-up" id="gdl-up">
          <div>⬆ 点击选择或把 ROM 文件拖到这里上传（.nes .sfc .smc .gb .gbc .gba .nds .z64 .md .iso .zip …，自动识别平台）</div>
          <input class="gdl-up-in" id="gdl-up-in" type="file" multiple
            accept=".nes,.unf,.fds,.gb,.gbc,.gba,.nds,.smc,.sfc,.swc,.fig,.z64,.n64,.v64,.md,.gen,.smd,.32x,.iso,.pbp,.chd,.cue,.img,.pce,.a26,.a78,.zip,.7z">
          <div class="gdl-upprog" id="gdl-upprog"></div>
        </div>
        <div id="gdl-ups"></div>
        <div id="gdl-list"></div>` : `<div class="gdl-desc" style="padding:24px 0">未找到 ROM 目录（HMP_ROM_DIR），无法使用游戏商店。</div>`}
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => {
    gdlStop(); mask.remove();
    // 下过/传过东西：关掉面板顺手刷一遍游戏墙（RomM 的文件监听约 1 分钟入库）
    if (GDL.needRefetch && typeof GDL.onRefresh === 'function') {
      GDL.needRefetch = false;
      GDL.onRefresh();
    }
  };
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  const xb = mask.querySelector('.gdl-x');
  if (xb) xb.onclick = close;
  gdlDrawList();
  gdlDrawUps();
  mask.addEventListener('click', async (e) => {
    const b = e.target.closest ? e.target.closest('[data-gdl]') : null;
    if (!b) return;
    const gid = b.getAttribute('data-gdl');
    try {
      await api('/api/games/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: gid }) });
      GDL.needRefetch = true;
      gdlDrawList();
    } catch (er) { toast(er.message || '下载请求失败'); }
  });
  const up = document.getElementById('gdl-up');
  const upIn = document.getElementById('gdl-up-in');
  if (up && upIn) {
    up.addEventListener('click', (e) => { if (e.target === upIn) return; upIn.click(); });
    upIn.addEventListener('change', () => { Array.from(upIn.files || []).forEach(gdlSend); upIn.value = ''; });
    up.addEventListener('dragover', (e) => { e.preventDefault(); up.classList.add('drag'); });
    up.addEventListener('dragleave', () => up.classList.remove('drag'));
    up.addEventListener('drop', (e) => {
      e.preventDefault(); up.classList.remove('drag');
      Array.from(e.dataTransfer.files || []).forEach(gdlSend);
    });
  }
  GDL.timer = setInterval(async () => {
    if (!document.body.contains(mask)) { gdlStop(); return; }
    try {
      const st = await api('/api/games/download/status');
      const before = JSON.stringify((GDL.cat && GDL.cat.jobs) || []);
      const after = st.jobs || [];
      const active = after.some((j) => j.status === 'downloading' || j.status === 'pending');
      if (GDL.cat) GDL.cat.jobs = after;
      if (before !== JSON.stringify(after)) gdlDrawList();
      if (!active && GDL.needRefetch) { GDL.needRefetch = false; await gdlRefreshCat(); }
    } catch { /* ignore */ }
  }, 1200);
}


/* ---------------- 下载中心 ---------------- */
const DL = { timer: null };
function dlStop() { if (DL.timer) { clearInterval(DL.timer); DL.timer = null; } }
const fmtSize2 = (b) => !b || b < 1024 ? (b || 0) + ' B'
  : b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB'
  : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB'
  : Math.round(b / 1024) + ' KB';
const DL_ST = { pending: '等待中', downloading: '下载中', paused: '已暂停', done: '已完成', error: '失败' };

function dlCard(t) {
  const pct = t.size ? Math.min(100, Math.round((t.downloaded * 100) / t.size)) : (t.status === 'done' ? 100 : 0);
  return `<div class="dl-card" data-id="${t.id}">
    <div class="dl-name" title="${esc(t.file)}">${esc(t.name)}<span class="dl-dir2">→ ${esc(t.dir)}</span></div>
    <div class="dl-bar"><div class="dl-bar-in${t.status === 'error' ? ' err' : ''}" style="width:${pct}%"></div></div>
    <div class="dl-meta">
      <span class="dl-st dl-st-${t.status}">${DL_ST[t.status] || t.status}${t.error ? '：' + esc(t.error) : ''}</span>
      <span>${fmtSize2(t.downloaded)}${t.size ? ' / ' + fmtSize2(t.size) : ''}${t.status === 'downloading' && t.speed ? ' · ' + fmtSize2(t.speed) + '/s' : ''} · ${pct}%</span>
    </div>
    <div class="dl-ops">
      ${(t.status === 'downloading' || t.status === 'pending') ? `<button class="btn-ghost" data-op="pause">暂停</button>` : ''}
      ${t.status === 'paused' ? `<button class="btn-ghost" data-op="resume">继续</button>` : ''}
      ${(t.status === 'error' || t.status === 'done') ? `<button class="btn-ghost" data-op="retry">重新下载</button>` : ''}
      <button class="btn-ghost" data-op="del">删除任务</button>
      <button class="btn-ghost" data-op="delfile">删除并删文件</button>
    </div>
  </div>`;
}

/* BT/磁力任务卡（qBittorrent）：复用下载中心卡片样式，进度条语义一致 */
function btCard(t) {
  const pct = Math.min(100, Math.round((t.progress || 0) * 100));
  const spd = t.status === 'downloading' && t.speed ? ' · ' + fmtSize2(t.speed) + '/s'
    : (t.status === 'done' && t.upspeed ? ' · ↑' + fmtSize2(t.upspeed) + '/s' : '');
  const etaTxt = t.eta > 0 && t.eta < 8640000 ? ' · 剩 ' + Math.ceil(t.eta / 60) + ' 分钟' : '';
  return `<div class="dl-card bt" data-hash="${esc(t.id)}">
    <div class="dl-name" title="${esc(t.savePath || '')}">${esc(t.name)}<span class="dl-dir2">→ ${esc(t.savePath || t.category || 'BT')}</span></div>
    <div class="dl-bar"><div class="dl-bar-in${t.status === 'error' ? ' err' : ''}" style="width:${pct}%"></div></div>
    <div class="dl-meta">
      <span class="dl-st dl-st-${esc(t.status)}">${esc(t.stateCn || t.state || '')}</span>
      <span>${fmtSize2(t.downloaded)}${t.size ? ' / ' + fmtSize2(t.size) : ''}${spd} · ${pct}%${etaTxt}</span>
    </div>
    <div class="dl-ops">
      ${(t.status === 'downloading' || t.status === 'pending') ? `<button class="btn-ghost" data-bt="pause">暂停</button>` : ''}
      ${t.status === 'paused' ? `<button class="btn-ghost" data-bt="resume">继续</button>` : ''}
      <button class="btn-ghost" data-bt="del">删除任务</button>
      <button class="btn-ghost" data-bt="delfile">删除并删文件</button>
    </div>
  </div>`;
}

/* ---------------- 下载（设置 › ⬇️ 下载，20260927dlx 重做版）----------------
   入口收进设置页（前台首页不再显示下载中心）；左侧控制、右侧直接内嵌完整 qBittorrent 主页面。
   登录态由服务端代理写死持有（SID 代持 + 403 自动重登），密码固定 admin/adminadmin
   （安装时预写 qBittorrent.conf，不再出现「随机临时密码只在日志里」的坑）。
   任务全部在后台跑：HMP 侧不再渲染任务列表，进度直接看右边 qBT 界面。 */
const DLX = { bd: null, dd: null, diagHtml: '', diagAt: 0, busy: false };

function dlPanePaint() {
  const frame = document.getElementById('dlx-frame');
  const empty = document.getElementById('dlx-empty');
  const stat = document.getElementById('dlx-stat');
  const ifr = document.getElementById('bt-ui-frame');
  if (!frame || !empty) return;
  const bd = DLX.bd || { configured: false };
  const on = !!bd.configured && !bd.error;
  if (on) {
    frame.style.display = 'block';
    empty.style.display = 'none';
    if (ifr && !ifr.getAttribute('data-loaded')) { ifr.src = '/qbui/'; ifr.setAttribute('data-loaded', '1');
    ifr.addEventListener('load', () => { const w2 = ifr.contentWindow; if (!w2) return; [400, 1500].forEach(ms => setTimeout(() => { try { w2.dispatchEvent(new Event('resize')); } catch {} }, ms)); }); }
    const tasks = bd.tasks || [];
    const act = tasks.filter((t) => t.status === 'downloading' || t.status === 'pending').length;
    const spd = tasks.reduce((a, t) => a + (t.status === 'downloading' ? (t.speed || 0) : 0), 0);
    const dd = DLX.dd || { tasks: [] };
    const dact = (dd.tasks || []).filter((t) => t.status === 'downloading' || t.status === 'pending').length;
    const dspd = (dd.tasks || []).reduce((a, t) => a + (t.status === 'downloading' ? (t.speed || 0) : 0), 0);
    if (stat) stat.textContent = '✅ qBittorrent 已连接 · BT 任务 ' + tasks.length + '（进行中 ' + act + '）'
      + (spd ? ' · ' + fmtSize2(spd) + '/s' : '')
      + ' ｜ 直链任务 ' + (dd.tasks || []).length + '（进行中 ' + dact + '）' + (dspd ? ' · ' + fmtSize2(dspd) + '/s' : '');
  } else {
    frame.style.display = 'none';
    empty.style.display = '';
    if (stat) stat.textContent = '⏳ qBittorrent 未连接 —— BT/磁力需要先连接或一键安装（左边的直链下载不受影响）';
    if (!DLX.busy) { if (bd.error) dlxDiag(bd.error, bd.url || ''); else dlxOff(); }
  }
}

function dlxOff() {
  const empty = document.getElementById('dlx-empty');
  if (!empty) return;
  empty.innerHTML = '<div class="dlx-empty-t">🧲 连接后这里就是完整的 qBittorrent 下载器</div>'
    + '<div class="dlx-empty-p">原版管理页面：添加种子 / 磁力、实时进度、做种管理全都在这里，下载在后台持续进行，关掉页面也照常下。</div>'
    + '<div class="dlx-empty-p">直链下载（http/https）不用等连接，在左边粘链接点「添加下载」即可。</div>'
    + '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px">'
    + '<button class="btn-accent" id="dlx-install">🚀 一键装到本机 NAS</button>'
    + '<button class="btn-ghost" id="dlx-find">🔍 自动查找</button>'
    + '<button class="btn-ghost" id="dlx-manual">⚙ 手动填地址</button>'
    + '<button class="btn-ghost" id="dlx-rescue">🔑 找回密码</button>'
    + '</div>'
    + (DLX.diagHtml || '');
  const ib = document.getElementById('dlx-install');
  if (ib) ib.onclick = () => qbInstallFlow();
  const fb = document.getElementById('dlx-find');
  if (fb) fb.onclick = () => qbFindOpen();
  const mb = document.getElementById('dlx-manual');
  if (mb) mb.onclick = () => qbCfgOpen();
  const cb = document.getElementById('dlx-rescue');
  if (cb) cb.onclick = () => qbRescueFlow();
}

/* 连不上：本机快扫（deep=0 秒回）→ 扫到给一键迁移；扫不到给一键安装 */
function dlxDiag(err, oldUrl) {
  const empty = document.getElementById('dlx-empty');
  if (!empty) return;
  empty.innerHTML = '<div class="dlx-empty-t">🔌 qBittorrent 连不上了</div>'
    + '<div class="dlx-empty-p">' + esc(err) + (oldUrl ? '（配置的地址：' + esc(oldUrl) + '）' : '')
    + '<br>最常见原因：<b>容器删除重装后端口变了</b>。正在本机快扫新地址…</div>'
    + '<div id="dlx-diag"><div class="alist-status">正在扫描本机常见端口…</div></div>'
    + '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">'
    + '<button class="btn-ghost" id="dlx-retry">↻ 重新诊断</button>'
    + '<button class="btn-ghost" id="dlx-rescue">🔑 找回密码</button>'
    + '<button class="btn-ghost" id="dlx-manual">⚙ 手动填地址</button>'
    + '</div>';
  const rb = document.getElementById('dlx-retry');
  if (rb) rb.onclick = () => { DLX.diagAt = 0; dlxScan(); };
  const cb = document.getElementById('dlx-rescue');
  if (cb) cb.onclick = () => qbRescueFlow();
  const mb = document.getElementById('dlx-manual');
  if (mb) mb.onclick = () => qbCfgOpen();
  const now = Date.now();
  if (!DLX.busy && now - DLX.diagAt > 20000) { DLX.diagAt = now; dlxScan(); }
  else if (DLX.diagHtml) {
    const d = document.getElementById('dlx-diag');
    if (d) { d.innerHTML = DLX.diagHtml; dlxDiagBind(d); }
  }
}

async function dlxScan() {
  DLX.busy = true;
  let d = { items: [] };
  try { d = await api('/api/qbit/discover?deep=0'); } catch { /* 下面兜底渲染 */ }
  DLX.busy = false;
  const box = document.getElementById('dlx-diag');
  if (!box || !document.getElementById('dlx-empty')) return; // 页面已切走
  const items = (d && d.items) || [];
  if (items.length) {
    DLX.diagHtml = '<div class="alist-status">检测到本机在跑的 qBittorrent：<b>' + items.map((x) => esc(x.url)).join('、')
      + '</b><br>账号密码沿用已保存的，点一下即迁移：</div>'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px">'
      + items.map((x) => '<button class="btn-accent" data-mig="' + esc(x.url) + '">迁移到 ' + esc(x.url) + '</button>').join('')
      + '</div>';
  } else {
    DLX.diagHtml = '<div class="alist-status">本机没扫到正在运行的 qBittorrent（可能容器没起来或已删除）。</div>'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px"><button class="btn-accent" id="dlx-install">🚀 一键装回本机 NAS</button></div>';
  }
  box.innerHTML = DLX.diagHtml;
  dlxDiagBind(box);
}

function dlxDiagBind(box) {
  box.querySelectorAll('[data-mig]').forEach((b) => {
    b.onclick = async () => {
      const nu = b.dataset.mig;
      b.disabled = true;
      b.textContent = '迁移中…';
      try {
        // 只传 url：服务端保留已存账号密码（qbit.test 只写提供的字段）
        const r2 = await api('/api/qbit/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: nu }) });
        if (r2.ok) { toast('已迁移到 ' + nu); DLX.diagHtml = ''; DLX.diagAt = 0; dlxRefresh(); return; }
        toast('地址迁了但登录失败：' + (r2.error || '未知') + ' —— 密码多半也重置了，正在找回…');
        qbRescueFlow();
      } catch (e3) { toast('迁移失败：' + e3.message); b.disabled = false; b.textContent = '迁移到 ' + nu; }
    };
  });
  const ib = document.getElementById('dlx-install');
  if (ib) ib.onclick = () => qbInstallFlow();
}

function qbCfgOpen() {
  const box = document.getElementById('dlx-cfgbox');
  if (!box) return;
  box.style.display = 'flex';
  const bd = DLX.bd || {};
  const u = document.getElementById('bt-url-cfg');
  const un = document.getElementById('bt-user');
  const dr = document.getElementById('bt-dir');
  if (u && !u.value) u.value = bd.url || 'http://127.0.0.1:8086';
  if (un && !un.value) un.value = bd.user || 'admin';
  if (dr && !dr.value) dr.value = bd.dir || '';
}

/* 密码找回：qBT 4.6+/5.x 首启会在容器日志里打一次临时密码（现在固定密码后基本用不上，兜底保留） */
async function qbRescueFlow() {
  toast('正在翻 qBittorrent 容器日志找临时密码…');
  let rc;
  try { rc = await api('/api/qbit/rescue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
  catch (e) { return toast('找回失败：' + e.message); }
  if (!(rc && rc.ok)) {
    stModal('🔑 找回密码', '<div class="st-modal-p">' + esc((rc && rc.error) || '没能自动找回')
      + '<br><br>可以 SSH 登录 NAS 自己翻：<br><span class="sh-cmd-in sh-cmd">docker logs qbittorrent 2>&1 | grep -i password</span></div>');
    return;
  }
  qbCfgOpen();
  const pw = document.getElementById('bt-pass');
  if (pw) pw.value = rc.pass;
  toast('已在日志里找到密码，正在保存连通…');
  const save = document.getElementById('bt-save');
  if (save) save.click();
}

/* 一键装回本机：服务端 docker run（首拉镜像 1~3 分钟），装完自动接管连接配置 */
async function qbInstallFlow() {
  const box = stModal('🚀 一键装到本机 NAS', '<div class="st-modal-p" id="qb-inst-st">正在拉取 qBittorrent 镜像并启动容器…<br>首次安装要下载 100MB 左右镜像，约 1~3 分钟，别关这个窗口。</div>');
  let r;
  try {
    r = await api('/api/qbit/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } catch (e) {
    const st2 = document.getElementById('qb-inst-st');
    if (st2) st2.innerHTML = '安装请求失败：' + esc(e.message) + '<br>（等待超时也可能其实装完了，稍后回本页看看状态）';
    return;
  }
  const st3 = document.getElementById('qb-inst-st');
  if (!st3) return;
  if (!(r && r.ok)) { st3.innerHTML = '❌ ' + esc((r && r.error) || '安装失败'); return; }
  st3.innerHTML = '✅ 已装好并连通（qBittorrent ' + esc(r.version || '') + '）。<br><br>'
    + '账号 <b>admin</b> / 密码 <b>adminadmin</b>（已写死进配置，重启、重装都不会再变，也不会出现随机密码）。<br>'
    + '地址固定 http://本机IP:8086，以后删除重装端口也不变。'
    + '<div style="margin-top:12px"><button class="btn-accent" id="qb-inst-done">好了，去用</button></div>';
  const d = document.getElementById('qb-inst-done');
  if (d) d.onclick = () => { box.close(); DLX.diagHtml = ''; DLX.diagAt = 0; dlxRefresh(); };
}

async function qbFindOpen() {
  const box = stModal('🔍 查找家里的 qBittorrent', '<div class="st-modal-p" id="qb-find-st">正在扫描本机与局域网常见端口，几秒钟…</div><div id="qb-find-list"></div>');
  let r = { ok: false, items: [] };
  try { r = await api('/api/qbit/discover?deep=1'); }
  catch (e) { r = { ok: false, error: String(e.message || e), items: [] }; }
  const st = document.getElementById('qb-find-st');
  const list = document.getElementById('qb-find-list');
  const items = r.items || [];
  if (!st || !list) return;
  const sub = (r.scanned && r.scanned.subnet) ? r.scanned.subnet : '';
  if (!items.length) {
    st.innerHTML = '没扫到（已扫：本机 + ' + esc(sub) + ' 的常见端口 8080/8085/8070/6880/8086）。<br>可能还没装 —— 点下方「一键装到本机 NAS」最省事。';
    list.innerHTML = '<div style="margin-top:14px"><button class="btn-accent" id="qb-find-install">🚀 一键装到本机 NAS</button></div>';
    const g = document.getElementById('qb-find-install');
    if (g) g.onclick = () => { box.close(); qbInstallFlow(); };
    return;
  }
  st.innerHTML = '找到 <b>' + items.length + '</b> 台，点一下即填入（账号密码沿用已保存的，缺省 admin/adminadmin）：';
  list.innerHTML = items.map((h, i) => '<div class="qb-hit"><div class="qb-hit-i">🖥️</div><div class="qb-hit-b"><div class="qb-hit-u">'
    + esc(h.url) + '</div><div class="qb-hit-h">' + esc(h.how || '') + '</div></div><button class="btn-accent" data-qbh="' + i + '">用这个</button></div>').join('');
  list.onclick = (e) => {
    const b = e.target.closest('[data-qbh]');
    if (!b) return;
    const h = items[Number(b.dataset.qbh)];
    box.close();
    qbCfgOpen();
    const u = document.getElementById('bt-url-cfg');
    if (u) u.value = h.url;
    toast('地址已填好，点「测试并保存」即可连通');
  };
}

/* ============ 面板生命周期 ============ */
async function dlxRefresh() {
  try { DLX.dd = await api('/api/dl/tasks'); } catch { DLX.dd = null; }
  try { DLX.bd = await api('/api/qbit/tasks'); } catch { DLX.bd = { configured: false, tasks: [] }; }
  dlPanePaint();
}

function dlPaneEnter() {
  dlxRefresh();
  dlStop();
  DL.timer = setInterval(dlxRefresh, 4000); // route() 换页时会 dlStop() 兜底清理
}
function dlPaneLeave() { dlStop(); }

function dlPaneInit() {
  const go = document.getElementById('dlx-go');
  if (!go) return;
  const ta = document.getElementById('dlx-url');
  go.onclick = async () => {
    const raw = String((ta && ta.value) || '').trim();
    if (!raw) return toast('请先粘贴下载链接');
    const lines = raw.split(/[\s]+/).filter(Boolean);
    const bts = lines.filter((u) => /^magnet:/i.test(u) || /\.torrent$/i.test(u));
    const dls = lines.filter((u) => /^https?:\/\//i.test(u) && !/\.torrent$/i.test(u));
    const bad = lines.length - bts.length - dls.length;
    let okN = 0;
    const errs = [];
    for (const u of bts) {
      try { const r = await api('/api/qbit/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: u }) }); if (r.ok) okN += 1; else errs.push(r.error || 'BT 添加失败'); }
      catch (e) { errs.push(e.message); }
    }
    for (const u of dls) {
      try { await api('/api/dl/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u, dir: null }) }); okN += 1; }
      catch (e) { errs.push(e.message); }
    }
    if (okN && ta) ta.value = '';
    toast((okN ? '已加入 ' + okN + ' 个下载任务' : '添加失败') + (errs.length ? '：' + errs[0] : '') + (bad ? '（' + bad + ' 行无法识别已跳过）' : ''));
    dlxRefresh();
  };
  if (ta) ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) go.click(); });
  const dirb = document.getElementById('dlx-dir');
  if (dirb) dirb.onclick = () => openDirPicker(async (dir) => {
    try {
      const r = await api('/api/dl/dir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir }) });
      toast('保存目录已更新：' + r.dir);
      const d2 = document.getElementById('bt-dir');
      if (d2) d2.value = r.dir;
    } catch (e) { toast('设置失败：' + e.message); }
  }, '选择下载保存目录');
  const cfgb = document.getElementById('dlx-cfg');
  if (cfgb) cfgb.onclick = () => qbCfgOpen();
  const save = document.getElementById('bt-save');
  if (save) save.onclick = async () => {
    try {
      const r = await api('/api/qbit/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify((() => {
          // 只改地址/端口时别把已存密码抹掉：空字段不传，服务端保留原值
          const o = { url: document.getElementById('bt-url-cfg').value.trim() };
          const u = document.getElementById('bt-user').value.trim();
          const pv = document.getElementById('bt-pass').value;
          const dv = document.getElementById('bt-dir').value.trim();
          if (u) o.user = u;
          if (pv) o.pass = pv;
          o.dir = dv; // 目录清空是合法操作（回退 qBittorrent 默认）
          return o;
        })()),
      });
      toast(r.ok ? ('已连上 qBittorrent' + (r.version ? ' ' + r.version : '')) : ('连接失败：' + (r.error || '未知')));
      DLX.diagHtml = '';
      DLX.diagAt = 0;
      dlxRefresh();
    } catch (e) { toast('保存失败：' + e.message); }
  };
  dlxRefresh();
}
/* ================= 儿童模式 + 手机备份（20260922bv 重做版） =================
   儿童模式：服务端为唯一真源（过滤/锁定都在后端），前端只做外观与 PIN 弹窗。
   手机备份：设备配对 → 照片库同名目录 → 增量对比（名字+大小）→ 批量上传。 */
const Kids = { active: false, pinSet: false, config: null };

async function kidsRefresh() {
  try {
    const s = await api('/api/kids/status');
    Kids.active = !!s.active; Kids.pinSet = !!s.pinSet; Kids.config = s.config || null;
  } catch { /* 服务端暂不可用时保持现状 */ }
  document.body.classList.toggle('kids-on', Kids.active === true);
  kidsBadgeSync();
}

function kidsBadgeSync() {
  let badge = document.getElementById('kids-badge');
  if (Kids.active && !badge) {
    badge = document.createElement('div');
    badge.id = 'kids-badge';
    badge.className = 'kids-badge';
    badge.innerHTML = `<span>🧸 儿童模式</span><button id="kids-exit-btn" title="退出儿童模式（需家长 PIN）">退出</button>`;
    document.body.appendChild(badge);
    document.getElementById('kids-exit-btn').onclick = () => kidPinModal('退出儿童模式', async (pin) => {
      try {
        await api('/api/kids/exit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
        await kidsRefresh(); toast('已退出儿童模式'); route();
        return true;
      } catch (e) { kidPinErr(e.message); return false; }
    });
  } else if (!Kids.active && badge) badge.remove();
}

/* PIN 弹窗：onSubmit(pin) 返回 true 关闭；失败调 kidPinErr 提示后继续输入 */
function kidPinModal(title, onSubmit, opt) {
  const o = opt || {};
  const mask = document.createElement('div');
  mask.className = 'kids-pin-mask';
  mask.innerHTML = `<div class="kids-pin-box">
    <div class="kids-pin-title">${esc(title)}</div>
    <input id="kids-pin-input" type="password" inputmode="numeric" maxlength="8" placeholder="${esc(o.placeholder || '家长 PIN（4~8 位数字）')}" autocomplete="off" />
    <div class="kids-pin-err" id="kids-pin-err"></div>
    <div class="kids-pin-btns"><button class="btn-small" id="kids-pin-cancel">取消</button>
    <button class="btn-accent" id="kids-pin-ok">确定</button></div>
  </div>`;
  document.body.appendChild(mask);
  const inp = mask.querySelector('#kids-pin-input');
  const err = (m) => { mask.querySelector('#kids-pin-err').textContent = m ? '⚠️ ' + m : ''; };
  window.__kidPinErr = err;
  // viaOk 区分「成功关闭」与「用户取消」：取消要回调，成功不能当成取消
  const close = (viaOk) => { mask.remove(); window.__kidPinErr = null; if (!viaOk && o.onCancel) o.onCancel(); };
  const go = async () => {
    const pin = inp.value.trim();
    if (!/^\d{4,8}$/.test(pin)) return err('密码需为 4~8 位数字');
    if (await onSubmit(pin) === true) close(true);
  };
  mask.querySelector('#kids-pin-cancel').onclick = () => close(false);
  mask.querySelector('#kids-pin-ok').onclick = go;
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  setTimeout(() => inp.focus(), 50);
}
function kidPinErr(m) { if (window.__kidPinErr) window.__kidPinErr(m); }

/* 设置页儿童模式面板 */
/* 儿童模式白名单：除媒体库 root 外，还允许家长浏览 NAS 任意文件夹勾选（存路径） */
const kidsExtraSel = { videoRoots: [], musicRoots: [], photoRoots: [], bookRoots: [] };
function kidsNormP(p) { return String(p || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/'; }
/* 面板事件只在元素上绑一次：kidsRenderSettings() 会反复重绘 innerHTML，
   若每次都 addEventListener，监听器会越积越多 —— 点一下被触发偶数次，看起来完全没反应 */
const KIDS_UI = { onExpand: null, onBrowse: null, onRemove: null };
function kidsBindPanel(panel) {
  if (!panel || panel.dataset.kidsBound === '1') return;
  panel.dataset.kidsBound = '1';
  panel.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;
    const exp = t.closest('.kids-exp');
    if (exp) { ev.preventDefault(); if (KIDS_UI.onExpand) KIDS_UI.onExpand(exp); return; }
    const bb = t.closest('.kids-browse');
    if (bb) { ev.preventDefault(); if (KIDS_UI.onBrowse) KIDS_UI.onBrowse(bb.getAttribute('data-kbrowse')); return; }
    const xx = t.closest('.kids-xextra');
    if (xx && xx.getAttribute('data-kdelid') != null) { ev.preventDefault(); if (KIDS_UI.onDelRoot) KIDS_UI.onDelRoot(xx.getAttribute('data-kdelkey'), xx.getAttribute('data-kdelid'), xx.getAttribute('data-kdelpath')); return; }
    if (xx) { ev.preventDefault(); if (KIDS_UI.onRemove) KIDS_UI.onRemove(xx.getAttribute('data-kxkey'), xx.getAttribute('data-kxpath')); }
  });
}

async function kidsRenderSettings() {
  const panel = document.getElementById('kids-panel');
  if (!panel) return;
  await kidsRefresh();
  const st = Kids;
  const vRoots = await api('/api/roots').then((r) => (Array.isArray(r) ? r : (r.roots || []))).catch(() => []);
  const mRoots = await api('/api/music/roots').then((r) => r.roots || []).catch(() => []);
  const pRoots = await api('/api/photos/roots').then((r) => r.roots || []).catch(() => []);
  const bRoots = await api('/api/books/roots').then((r) => r.roots || []).catch(() => []);
  const selArr = (key) => ((st.config && st.config[key]) || []);
  const isOn = (key, val) => selArr(key).some((x) => String(x) === String(val));
  /* 已保存的「按路径勾选」项必须恢复出来：否则重进设置页它们不渲染，
     一点「保存白名单」就会被只读 DOM 的 cfgSel 悄悄丢掉（路径白名单静默丢失） */
  for (const k of ['videoRoots', 'musicRoots', 'photoRoots', 'bookRoots']) {
    for (const pth of selArr(k).filter((x) => typeof x === 'string')) {
      const n = kidsNormP(pth);
      if (!(kidsExtraSel[k] || []).some((x) => kidsNormP(x) === n)) (kidsExtraSel[k] = kidsExtraSel[k] || []).push(n);
    }
  }
  const group = (title, emoji, list, key) => `
    <div class="kids-root-group"><div class="kids-root-title">${emoji} ${title}${list.length ? '' : ' <span class="dim">（暂无目录，先到对应页面添加）</span>'}<button type="button" class="kids-browse" data-kbrowse="${key}" data-kbtitle="${title}">📂 浏览 NAS 文件夹</button></div>
    ${list.map((r) => `
      <div class="kids-node">
        <div class="kids-row">
          <button type="button" class="kids-exp" data-kexp="${esc(r.path)}" title="展开子目录">▸</button>
          <label class="kids-root-item"><input type="checkbox" data-kroot="${key}" data-kval="${r.id}" ${isOn(key, r.id) ? 'checked' : ''} />
            <span class="kids-root-name">${esc(r.label || r.path)}</span><span class="kids-root-path">${esc(r.path)}</span></label>
          <button type="button" class="kids-xextra" data-kdelkey="${key}" data-kdelid="${r.id}" data-kdelpath="${esc(r.path)}" title="从媒体库删除此目录（不动磁盘文件）">✕</button>
        </div>
        <div class="kids-sub"></div>
      </div>`).join('')}
    ${(kidsExtraSel[key] || []).map((d) => `
      <div class="kids-node"><div class="kids-row">
        <label class="kids-root-item"><input type="checkbox" data-kroot="${key}" data-kval="p:${esc(d)}" checked />
          <span class="kids-root-name">📂 ${esc(d.split('/').filter(Boolean).pop() || d)}</span><span class="kids-root-path">${esc(d)}</span></label>
        <button type="button" class="kids-xextra" data-kxkey="${key}" data-kxpath="${esc(d)}" title="移除此目录">✕</button>
      </div></div>`).join('')}
    </div>`;
  if (!st.pinSet) {
    panel.innerHTML = `
      <div class="alist-status">首次使用：设置一个家长 PIN（4~8 位数字）。之后儿童只能看白名单目录里的内容，进入/退出儿童模式都需要这个 PIN。</div>
      <div class="add-root" style="margin-top:10px">
        <input id="kids-pin-new" type="password" inputmode="numeric" maxlength="8" placeholder="设置家长 PIN" />
        <input id="kids-pin-new2" type="password" inputmode="numeric" maxlength="8" placeholder="再输一遍确认" />
        <button class="btn-accent" id="kids-pin-set">设置 PIN</button>
      </div>`;
    panel.querySelector('#kids-pin-set').onclick = async () => {
      const p1 = panel.querySelector('#kids-pin-new').value.trim();
      const p2 = panel.querySelector('#kids-pin-new2').value.trim();
      if (p1 !== p2) return toast('两次输入的 PIN 不一致');
      try {
        await api('/api/kids/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: p1 }) });
        toast('家长 PIN 已设置，请勾选儿童可见目录'); kidsRenderSettings();
      } catch (e) { toast('设置失败：' + e.message); }
    };
    return;
  }
  kidsBindPanel(panel);
  const cfgSel = (key) => {
    const out = [];
    panel.querySelectorAll(`[data-kroot="${key}"]:checked`).forEach((c) => {
      const v = String(c.getAttribute('data-kval') || '');
      const val = v.startsWith('p:') ? v.slice(2) : Number(v);
      if (val === '' || (typeof val === 'number' && !val)) return;
      if (!out.some((x) => String(x) === String(val))) out.push(val);
    });
    return out;
  };

  /* 白名单树：点「▸」按需展开子目录（本地路径 / 网盘路径都支持） */
  const onExpand = async (btn) => {
    const node = btn.closest('.kids-node');
    const box = node.querySelector('.kids-sub');
    const keyInput = node.querySelector('input[data-kroot]');
    const key = keyInput ? keyInput.getAttribute('data-kroot') : 'videoRoots';
    if (box.dataset.loaded === '1') {
      const willHide = box.style.display !== 'none';
      box.style.display = willHide ? 'none' : '';
      btn.textContent = willHide ? '▸' : '▾';
      return;
    }
    btn.textContent = '…';
    try {
      const r = await api('/api/kids/subdirs?path=' + encodeURIComponent(btn.getAttribute('data-kexp')));
      const dirs = (r && r.dirs) || [];
      if (r && r.error && !dirs.length) throw new Error(r.error);
      box.innerHTML = dirs.length
        ? dirs.map((d) => `
          <div class="kids-node">
            <div class="kids-row">
              <button type="button" class="kids-exp" data-kexp="${esc(d.path)}" title="展开子目录">▸</button>
              <label class="kids-root-item"><input type="checkbox" data-kroot="${key}" data-kval="p:${esc(d.path)}" ${isOn(key, 'p:' + d.path) ? 'checked' : ''} />
                <span class="kids-root-name">${esc(d.name)}</span></label>
            </div>
            <div class="kids-sub"></div>
          </div>`).join('')
        : '<div class="kids-node" style="padding-left:26px"><span class="dim">（没有子目录）</span></div>';
      box.dataset.loaded = '1';
      box.style.display = '';
      btn.textContent = '▾';
    } catch (e) {
      btn.textContent = '▸';
      toast('展开失败：' + e.message);
    }
  };
  KIDS_UI.onExpand = onExpand;
  panel.innerHTML = `
    <div class="alist-status">${st.active
      ? '🧢 <b>儿童模式已开启</b> —— 屏幕右上角有「🧸 儿童模式」悬浮标，退出需家长 PIN。'
      : '儿童模式未开启。勾选儿童可见的目录后点「进入儿童模式」；之后孩子只能看到勾选目录里的内容，解除需家长 PIN。'}</div>
    ${group('影视目录', '🎬', vRoots, 'videoRoots')}
    ${group('音乐目录', '🎵', mRoots, 'musicRoots')}
    ${group('相册目录', '🖼️', pRoots, 'photoRoots')}
    ${group('书架目录', '📚', bRoots, 'bookRoots')}
    <div class="add-root" style="margin-top:12px">
      <button class="btn-accent" id="kids-save-config">💾 保存白名单</button>
      ${st.active
        ? '<button class="btn-small" id="kids-exit2">🔓 退出儿童模式</button>'
        : '<button class="btn-accent" id="kids-enter">🧸 进入儿童模式</button>'}
      <button class="btn-small" id="kids-chg-pin">🔑 修改 PIN</button>
    </div>
    <div class="alist-status">开启期间服务端锁定：加目录 / 扫描 / 删除 / 设置 / 在线热歌 / 下载中心 / 网盘浏览全部不可用，孩子绕不过去。勾选某个目录 = 放开它下面的全部内容；点目录前的「▸」可展开子目录，只放开其中几个（例如 「影视」下只放开「动漫」）。网盘目录首次勾选会自动扫描入库，稍后内容出现。</div>`;
  const askPin = (title, fn) => kidPinModal(title, async (pin) => {
    try { await fn(pin); return true; } catch (e) { kidPinErr(e.message); return false; }
  });
  const KID_ADD_MAP = { videoRoots: '/api/roots', musicRoots: '/api/music/roots', photoRoots: '/api/photos/roots', bookRoots: '/api/books/roots' };
  const KID_SCAN_MAP = { videoRoots: '/api/scan', musicRoots: '/api/music/scan', photoRoots: '/api/photos/scan', bookRoots: '/api/books/scan' };
  const KID_GNAME = { videoRoots: '影视目录', musicRoots: '音乐目录', photoRoots: '相册目录', bookRoots: '书架目录' };
  const rootsOf = (key) => ({ videoRoots: vRoots, musicRoots: mRoots, photoRoots: pRoots, bookRoots: bRoots }[key] || []);
  function kidsBrowseModal(key) {
    if (st.active) { toast('儿童模式已开启：请先「退出儿童模式」（需家长 PIN）再加目录'); return; }
    const mask = muModal(`浏览 NAS 文件夹 — 选${KID_GNAME[key]}`, `
      <div class="mpl-form">
        <div id="kb-crumb" style="font-size:13px;margin-bottom:6px;word-break:break-all;color:#9aa"></div>
        <div id="kb-quick" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"></div>
        <div id="kb-list" style="max-height:320px;overflow:auto;border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:6px;min-height:120px"></div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn-ghost" id="kb-up" style="flex:1">⬆ 上一级</button>
          <button class="btn-accent" id="kb-pick" style="flex:2">✓ 选定当前目录</button>
        </div>
        <div class="dim" style="font-size:12px;margin-top:8px">目录还没加入媒体库时，选定后会自动添加并后台扫描，内容稍后出现。</div>
      </div>`);
    let cur = '/share';
    const paint = async () => {
      mask.querySelector('#kb-crumb').textContent = cur;
      const qk = mask.querySelector('#kb-quick');
      if (qk) {
        const qs = rootsOf(key);
        qk.innerHTML = qs.length ? qs.map((r) => `<button type="button" class="btn-ghost" data-q="${esc(r.path)}" style="font-size:12px;padding:2px 8px">↪ ${esc(r.label || r.path)}</button>`).join('') : '';
        qk.querySelectorAll('[data-q]').forEach((el) => { el.onclick = () => { cur = kidsNormP(el.getAttribute('data-q')); paint(); }; });
      }
      const list = mask.querySelector('#kb-list');
      list.innerHTML = '<div class="empty-hint">读取中…</div>';
      try {
        const d = await api('/api/kids/subdirs?path=' + encodeURIComponent(cur));
        const dirs = d.dirs || [];
        // 服务端把「目录不存在」也包在 200 里（dirs 空 + error 字段）→ 必须当失败处理，
        // 否则 Windows/mac 上打开弹窗只显示「（没有子目录）」，不会退回根目录
        if (d.error && !dirs.length) throw new Error(d.error);
        list.innerHTML = dirs.length ? dirs.map((x) => `<div class="kb-it" data-p="${esc(x.path)}" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05)">📁 ${esc(x.name)}</div>`).join('') : '<div class="empty-hint">（没有子目录）</div>';
        list.querySelectorAll('.kb-it').forEach((el) => { el.onclick = () => { cur = el.getAttribute('data-p'); paint(); }; });
      } catch (e) {
        list.innerHTML = `<div class="empty-hint">读取失败：${esc(e.message)}</div>`;
        // 起点目录在非 NAS 设备上可能不存在（Windows/mac 没有 /share）→ 自动退回根目录重画，别卡死
        if (kidsNormP(cur) !== '/') { cur = '/'; setTimeout(() => paint(), 30); }
      }
    };
    mask.querySelector('#kb-up').onclick = () => {
      const t = cur.replace(/\/+$/, '');
      const i = t.lastIndexOf('/');
      cur = i <= 0 ? '/' : t.slice(0, i);
      paint();
    };
    mask.querySelector('#kb-pick').onclick = async () => {
      const dir = kidsNormP(cur);
      if (dir === '/') return toast('请先进入具体的子目录，再点「选定当前目录」');
      const rootsHere = rootsOf(key);
      const hit = rootsHere.some((r) => { const rp = kidsNormP(r.path); return rp === dir || dir.startsWith(rp + '/'); });
      if (!hit) {
        if (!confirm(`「${dir}」还没有加入${KID_GNAME[key]}。要现在添加并扫描入库吗？（扫描在后台进行，完成后孩子即可看到）`)) return;
        try {
          await api(KID_ADD_MAP[key], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir, label: dir.split('/').filter(Boolean).pop() || dir }) });
          api(KID_SCAN_MAP[key], { method: 'POST' }).catch(() => {});
          toast(`已添加到${KID_GNAME[key]}，后台扫描中…`);
        } catch (e) { return toast('添加失败：' + e.message); }
      }
      if (!(kidsExtraSel[key] || []).some((x) => kidsNormP(x) === dir)) (kidsExtraSel[key] = kidsExtraSel[key] || []).push(dir);
      mask.remove();
      kidsRenderSettings();
    };
    paint();
  }
  KIDS_UI.onBrowse = (key) => kidsBrowseModal(key);
  KIDS_UI.onRemove = (k, rawD) => {
    const d = kidsNormP(rawD);
    kidsExtraSel[k] = (kidsExtraSel[k] || []).filter((x) => kidsNormP(x) !== d);
    kidsRenderSettings();
  };
  /* 删除媒体库根目录（设置页里每一行的 ✕）：走各库已有 DELETE 接口，只删库内记录不动磁盘文件 */
  const KID_DEL_MAP = { videoRoots: '/api/roots', musicRoots: '/api/music/roots', photoRoots: '/api/photos/roots', bookRoots: '/api/books/roots' };
  KIDS_UI.onDelRoot = async (key, id, rawPath) => {
    const url = KID_DEL_MAP[key];
    if (!url || !id) return;
    if (st.active) { toast('儿童模式已开启：请先「退出儿童模式」再删除目录'); return; }
    const row = rootsOf(key).find((r) => String(r.id) === String(id));
    const label = (row && (row.label || row.path)) || rawPath || '目录';
    if (!confirm('将「' + label + '」从媒体库删除？\n\n只删除库内记录，不会删除磁盘上的文件；之后可在对应页面重新添加并扫描。')) return;
    try {
      await api(url + '/' + id, { method: 'DELETE' });
      const rp = kidsNormP(rawPath);
      kidsExtraSel[key] = (kidsExtraSel[key] || []).filter((x) => { const n = kidsNormP(x); return n !== rp && !n.startsWith(rp + '/'); });
      toast('已删除目录：' + label);
      kidsRenderSettings();
    } catch (e) { toast('删除失败：' + e.message); }
  };
  panel.querySelector('#kids-save-config').onclick = () => askPin('保存儿童可见目录（需家长 PIN）', async (pin) => {
    const r = await api('/api/kids/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      pin,
      videoRoots: cfgSel('videoRoots'), musicRoots: cfgSel('musicRoots'),
      photoRoots: cfgSel('photoRoots'), bookRoots: cfgSel('bookRoots'),
    }) });
    if (r && r.scanStarted) toast('白名单已保存，正在后台扫描网盘目录，内容稍后自动出现');
    else toast('白名单已保存');
    return true;
  });
  const enterBtn = panel.querySelector('#kids-enter');
  if (enterBtn) enterBtn.onclick = () => askPin('进入儿童模式（需家长 PIN）', async (pin) => {
    await api('/api/kids/enter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    await kidsRefresh(); toast('已进入儿童模式');
    // 必须离开设置页：设置页的目录选择器等接口在儿童模式下被拦截，停留会整页报错
    if (location.hash === '#/' || location.hash === '#/home' || location.hash === '') route(); else location.hash = '#/';
  });
  const exitBtn = panel.querySelector('#kids-exit2');
  if (exitBtn) exitBtn.onclick = () => askPin('退出儿童模式（需家长 PIN）', async (pin) => {
    await api('/api/kids/exit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    await kidsRefresh(); toast('已退出儿童模式');
    if (location.hash === '#/' || location.hash === '#/home' || location.hash === '') route(); else location.hash = '#/';
  });
  panel.querySelector('#kids-chg-pin').onclick = () => kidPinModal('修改家长 PIN（先输旧 PIN）', async (pin) => {
    const np = prompt('请输入新 PIN（4~8 位数字）');
    if (!np || !/^\d{4,8}$/.test(np.trim())) { kidPinErr('新 PIN 需为 4~8 位数字'); return false; }
    try {
      await api('/api/kids/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: np.trim(), oldPin: pin }) });
      toast('PIN 已修改');
      return true;
    } catch (e) { kidPinErr(e.message); return false; }
  });
}

/* ---- 手机照片备份：配对 + 增量上传 ---- */
const BK = { dev: null };
async function bkDeviceInfo() {
  try { BK.dev = JSON.parse(localStorage.getItem('hmp-bk-dev') || 'null'); } catch { BK.dev = null; }
  if (BK.dev && BK.dev.id) {
    try {
      const r = await api('/api/backup/manifest?id=' + BK.dev.id);
      BK.dev.dir = r.device && r.device.dir;
      return BK.dev;
    } catch { BK.dev = null; }
  }
  return null;
}
function bkPromptName(defaultName) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'kids-pin-mask';
    mask.innerHTML = `<div class="kids-pin-box"><div class="kids-pin-title">绑定这台手机</div>
      <input id="bk-name" type="text" maxlength="24" placeholder="设备名，如：爸爸手机 / 妈妈手机" value="${esc(defaultName || '')}" />
      <div class="alist-status" style="text-align:left;margin-top:8px">照片将存入照片库的「${esc(defaultName || '设备名')}」目录，自动成为独立相册；多台手机各用各的目录，互不混淆。想全自动备份请看「📖 备份指引」。</div>
      <div class="kids-pin-btns"><button class="btn-small" id="bk-cancel">取消</button><button class="btn-accent" id="bk-ok">绑定并备份</button></div></div>`;
    document.body.appendChild(mask);
    const inp = mask.querySelector('#bk-name');
    const close = (v) => { mask.remove(); resolve(v); };
    mask.querySelector('#bk-cancel').onclick = () => close(null);
    mask.querySelector('#bk-ok').onclick = () => {
      const name = inp.value.trim();
      if (name) close(name);
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.value.trim()) close(inp.value.trim()); });
    setTimeout(() => inp.focus(), 50);
  });
}
async function openPhoneBackup() {
  if (Kids.active) return toast('儿童模式下不能备份照片');
  let dev = await bkDeviceInfo();
  if (!dev) {
    let name = '';
    try { name = localStorage.getItem('hmp-bk-name') || ''; } catch { /* ignore */ }
    const nm = await bkPromptName(name);
    if (!nm) return;
    try {
      const r = await api('/api/backup/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nm }) });
      dev = { id: r.device.id, name: r.device.name, dir: r.device.dir };
      localStorage.setItem('hmp-bk-dev', JSON.stringify(dev));
      localStorage.setItem('hmp-bk-name', dev.name);
    } catch (e) { return toast('绑定失败：' + e.message); }
  }
  // 选照片：安卓 Chrome 走目录授权（一次选相册文件夹，后续增量全自动对比）；其余走系统相册选择器
  let files = null;
  if (window.showDirectoryPicker) {
    let dh = null;
    try { dh = await window.showDirectoryPicker({ mode: 'read' }); } catch (e) {
      if (e && e.name === 'AbortError') return; // 用户取消
      dh = null;
    }
    if (dh) {
      files = [];
      const walk = async (handle, depth) => {
        if (depth > 4) return;
        for await (const entry of handle.values()) {
          if (entry.kind === 'directory') {
            if (!entry.name.startsWith('.') && entry.name !== '@eaDir') await walk(entry, depth + 1);
            continue;
          }
          if (!/\.(jpe?g|png|webp|gif|bmp|heic|heif|dng|nef|arw|raf|cr2|cr3)$/i.test(entry.name)) continue;
          try {
            const f = await (await dh.getFileHandle ? (await handle.getFileHandle(entry.name)).getFile() : entry.getFile());
            if (f.size >= 20 * 1024) files.push(f);
          } catch { /* 跳过读不到的 */ }
        }
      };
      try { await walk(dh, 0); } catch { files = null; }
    }
  }
  if (!files) {
    files = await new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
      inp.onchange = () => resolve([...(inp.files || [])]);
      inp.click();
    });
  }
  if (!files || !files.length) return;
  // 增量对比：名字+大小 已在服务端设备目录里的跳过
  let have = new Set();
  try {
    const mf = await api('/api/backup/manifest?id=' + dev.id);
    have = new Set(mf.items.map((x) => x.name + ':' + x.size));
  } catch { /* ignore */ }
  const fresh = files.filter((f) => !have.has(f.name + ':' + f.size));
  const dup = files.length - fresh.length;
  if (!fresh.length) return toast(`没有新照片需要备份（${dup} 张已备份过，自动跳过）`);
  toast(`发现 ${fresh.length} 张新照片，开始备份${dup ? `（${dup} 张已备份过自动跳过）` : ''}…`, 4000);
  // 分批上传（HEIC/HEIF 等浏览器读不出的格式由服务端甄选拒收并计数）
  const BATCH = 8;
  let ok = 0, skip = 0, fail = 0;
  for (let i = 0; i < fresh.length; i += BATCH) {
    const fd = new FormData();
    fd.append('deviceId', String(dev.id));
    for (const f of fresh.slice(i, i + BATCH)) fd.append('file', f, f.name);
    try {
      const r = await api('/api/backup/photos', { method: 'POST', body: fd });
      ok += r.saved || 0; skip += r.skipped || 0;
    } catch { fail += Math.min(BATCH, fresh.length - i); }
  }
  if (ok > 0) toast(`✅ 备份完成：新入库 ${ok} 张${skip ? `，跳过 ${skip} 张` : ''}${fail ? `，失败 ${fail} 张` : ''}。已为你打开「相簿」，看「📱 手机备份相册」里的「${dev.name}」`, 7000);
  else if (fail > 0) toast(`备份失败 ${fail} 张（请检查网络后重试）`);
  else toast('没有新照片需要备份');
  if (ok > 0) { PH.wantAlbums = true; route(); }
}



/* ---------------- 🔄 软件更新（OTA，免费功能） ---------------- */
(function () {
  let busy = false;

  async function getStatus() { try { const r = await fetch('/api/ota/status'); return r.ok ? await r.json() : null; } catch { return null; } }
  function fmtSize(n) { n = Number(n) || 0; return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB'; }

  let pollTimer = null;
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  /* 升级后的重启等待：服务消失 → 重新出现 → 新版本核对 → 整页刷新（前端文件也换了，必须 cache-bust 整页重载） */
  function waitRestart(targetVer) {
    stopPoll();
    let seen = false, tries = 0;
    pollTimer = setInterval(async () => {
      tries++;
      let st = null;
      try { const r = await fetch('/api/ota/status?cb=' + Date.now()); if (r.ok) st = await r.json(); } catch (e) {}
      if (!st) { seen = true; return; } // 服务重启中（连接失败是预期环节）
      if (!seen) return;               // 服务还在（旧进程尚未退出），继续等
      stopPoll();
      const cur = st.current || {};
      if (targetVer && cur.version && Number(cur.version) >= Number(targetVer)) toast('✅ 已升级到 ' + (cur.label || cur.version), 5000);
      else toast('✅ 升级完成，服务已重启', 4000);
      setTimeout(() => { location.href = location.pathname + '?cb=' + Date.now() + '#/library'; }, 1200);
      if (tries > 180) stopPoll(); // 3 分钟兜底
    }, 1000);
  }

  function render(st) {
    const panel = document.getElementById('ota-panel');
    if (!panel) return;
    if (!st) { panel.innerHTML = '<div class="alist-status">无法获取更新状态（服务未响应？）</div>'; return; }
    const cur = st.current || {};
    let html = '<div class="alist-status">当前版本：<b>' + esc(cur.label || '未知') + '</b>' + (cur.version ? '（' + cur.version + '）' : '') +
      (st.hasBackup ? ' · <span style="opacity:.7">已保留上一版备份，可回滚</span>' : '') + '</div>';
    const checkBtn = ' <button class="btn-small" id="ota-check">🔄 检查更新</button>';
    if (st.phase === 'restarting') {
      html += '<div class="alist-status">✅ 新版本已就位，<b>正在重启服务…</b> 页面将自动刷新，请勿关闭。</div>';
    } else if (st.phase === 'downloading' || st.phase === 'applying') {
      const p = st.progress || {};
      html += '<div class="alist-status">⏳ ' + (st.phase === 'applying' ? '正在应用更新…' : '正在下载更新：') + '<br>' +
        esc(p.file || '') + '<br>' + (p.done || 0) + ' / ' + (p.total || 0) + ' 个文件 · ' + fmtSize(p.bytes) + ' / ' + fmtSize(p.totalBytes) + '</div>' +
        '<div class="alist-status" style="opacity:.7">升级完成后服务会自动重启，页面自动刷新。</div>';
    } else {
      if (st.phase === 'error') html += '<div class="alist-status" style="color:var(--danger,#e5484d)">❌ ' + esc(st.error || '更新出错') + '</div>';
      const d = st.diff, lt = st.latest;
      if (lt && d && (d.download.length || d.remove.length)) {
        html += '<div class="alist-status">🆕 发现新版本 <b>' + esc(lt.label || '') + '</b>（' + lt.version + '）<br>' +
          esc(lt.notes || '') + '<br>需下载 ' + d.download.length + ' 个文件（' + fmtSize(d.bytes) + '）' +
          (d.remove.length ? '，并删除 ' + d.remove.length + ' 个废弃文件' : '') + '</div>' +
          '<div class="add-root" style="margin-top:10px"><button class="btn-accent" id="ota-apply">⬆️ 立即升级</button>' + checkBtn + '</div>';
      } else if (lt) {
        html += '<div class="alist-status">✅ 已是最新（服务器版本：' + esc(lt.label || '') + ' ' + lt.version + '）</div>' +
          '<div class="add-root" style="margin-top:10px">' + checkBtn + '</div>';
      } else {
        html += '<div class="alist-status">在线升级：点「检查更新」获取最新版本。升级只替换程序文件，' +
          '<b>影视库、照片、配置、授权全部保留不动</b>；升级失败可用「回滚上一版」还原。</div>' +
          '<div class="add-root" style="margin-top:10px">' + checkBtn + '</div>';
      }
      if (st.hasBackup) html += '<div style="margin-top:10px"><button class="btn-small" id="ota-rollback">⏪ 回滚上一版</button></div>';
    }
    panel.innerHTML = html;
    const bc = panel.querySelector('#ota-check');
    if (bc) bc.onclick = async () => {
      if (busy) return; busy = true; bc.disabled = true; bc.textContent = '检查中…';
      try {
        const r = await fetch('/api/ota/check', { method: 'POST' });
        const j = await r.json();
        render(j);
        if (j.diff && (j.diff.download.length || j.diff.remove.length)) toast('发现新版本 ' + (j.latest && j.latest.label || ''), 4000);
        else if (j.latest) toast('已是最新版本', 3000);
      } catch (e) { toast('检查更新失败：' + (e.message || e), 4000); render(await getStatus()); }
      busy = false;
    };
    const ba = panel.querySelector('#ota-apply');
    if (ba) ba.onclick = async () => {
      if (busy) return; busy = true; ba.disabled = true; ba.textContent = '升级中…';
      let r = null;
      try {
        r = await fetch('/api/ota/apply', { method: 'POST' });
        const j = await r.json();
        render(j);
        if (j.phase === 'restarting') waitRestart(j.latest && j.latest.version);
        else if (j.phase === 'idle') { toast('无需更新，已是最新', 3000); busy = false; }
        else startProgressPoll(); // downloading/applying：轮询进度
      } catch (e) {
        let j = null;
        try { if (r) j = await r.json(); } catch (e2) {}
        toast('升级失败：' + ((j && j.error) || e.message || e), 5000);
        render(await getStatus()); busy = false;
      }
    };
    const br = panel.querySelector('#ota-rollback');
    if (br) br.onclick = () => {
      const mask = muModal('⏪ 回滚上一版', `<div class="mpl-form">将恢复升级前的程序备份并自动重启服务。<br><b>确定要回滚吗？</b></div>
        <button id="ota-rb-go" class="btn-accent" style="width:100%;margin-top:14px;padding:10px">回滚并重启</button>
        <button id="ota-rb-no" class="btn-ghost" style="width:100%;margin-top:8px;padding:10px">取消</button>`);
      mask.querySelector('#ota-rb-no').onclick = () => mask.remove();
      mask.querySelector('#ota-rb-go').onclick = async () => {
        mask.remove();
        try {
          const r = await fetch('/api/ota/rollback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'ROLLBACK' }) });
          const j = await r.json();
          if (j && j.error) { toast('回滚失败：' + j.error, 5000); return; }
          toast('正在回滚并重启…', 4000);
          waitRestart(null);
        } catch (e) { toast('回滚失败：' + (e.message || e), 5000); }
      };
    };
  }

  /* 下载/应用阶段进度轮询 */
  function startProgressPoll() {
    stopPoll();
    pollTimer = setInterval(async () => {
      const st = await getStatus();
      if (!st) return;
      render(st);
      if (st.phase === 'restarting') waitRestart(st.latest && st.latest.version);
      else if (st.phase !== 'downloading' && st.phase !== 'applying') { stopPoll(); busy = false; }
    }, 1000);
  }

  /* 切到「软件更新」页签时刷新 */
  document.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('[data-lib-tab="ota"]')) getStatus().then(render);
  });
})();
/* ---------------- 🔄 软件更新（OTA） 结束 ---------------- */
