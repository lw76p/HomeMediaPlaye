'use strict';
/* 游戏中心 · PC 游戏：Steam 本地库解析（零 npm 依赖）
 *
 * ① Steam 库：读 Steam 自己的明文清单，不用 API Key、不用联网就能出海报墙
 *    - steamapps/libraryfolders.vdf：库位置清单（含每个库的已装 appid）
 *    - steamapps/appmanifest_<appid>.acf：单个已装游戏的明细（名称/安装目录/体积/更新时间）
 *    封面走 Steam 公开 CDN（library_600x900.jpg → header.jpg 兜底），由本服务代理并落盘缓存，
 *    避免浏览器直连外域失败 / 反复回源。
 *
 *    - 所以这里只管：TCP 探在线（47990 主端口 / 47989 兜底）、WoL 远程唤醒、生成唤起链接与命令
 *
 * 路径安全：只读写用户显式登记的 Steam 库目录，不做任意路径穿越。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const https = require('node:https');
const db = require('./db');
const paths = require('./paths');

/* ============================ 配置读写 ============================ */
const K = { roots: 'steam_roots', hosts: 'steam_hosts', dolphin: 'steam_show_runtime' };

function roots() {
  const v = db.getSetting(K.roots, []);
  const arr = Array.isArray(v) ? v : [];
  return arr.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20);
}
function setRoots(arr) {
  const list = (Array.isArray(arr) ? arr : []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20);
  db.setSetting(K.roots, list);
  cache.at = 0; // 换即刻失效
  return roots();
}

function hosts() {
  const v = db.getSetting(K.hosts, []);
  const arr = Array.isArray(v) ? v : [];
  return arr.slice(0, 16).map((h) => ({
    id: String(h.id || ''),
    name: String(h.name || '').trim() || '未命名主机',
    ip: String(h.ip || '').trim(),
    port: Math.min(65535, Math.max(1, Number(h.port) || 47990)),
    mac: String(h.mac || '').trim(),
  })).filter((h) => h.ip);
}
function setHosts(arr) {
  const list = (Array.isArray(arr) ? arr : []).slice(0, 16).map((h, i) => ({
    id: String((h && h.id) || '') || ('h' + Date.now() + i),
    name: String((h && h.name) || '').trim() || '未命名主机',
    ip: String((h && h.ip) || '').trim(),
    port: Math.min(65535, Math.max(1, Number((h && h.port) || 47990))),
    mac: String((h && h.mac) || '').trim(),
  })).filter((h) => h.ip);
  db.setSetting(K.hosts, list);
  return hosts();
}

/* ============================ VDF 明文解析器 ============================
   Valve 的 VDF 形如：  "key"  { "k"  "v"  "obj" { ... } }
   一律用双引号包住 key/value，空白用 tab/空格。这里做容错扫描：
   遇到坏字符就跳过，绝不让一个畸形文件把整个扫描拖死。 */
function parseVdf(text, maxDepth = 12) {
  const n = text.length;
  let i = 0;
  function ws() {
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
      if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
      break;
    }
  }
  function str() {
    ws();
    if (text[i] !== '"') return null;
    i++;
    let out = '';
    while (i < n) {
      const c = text[i];
      if (c === '\\') {
        const nx = text[i + 1];
        if (nx === 'n') { out += '\n'; i += 2; continue; }
        if (nx === 't') { out += '\t'; i += 2; continue; }
        if (nx === 'r') { out += '\r'; i += 2; continue; }
        out += nx || ''; i += 2; continue;
      }
      if (c === '"') { i++; return out; }
      out += c; i++;
    }
    return out;
  }
  function obj(depth) {
    const o = {};
    ws();
    if (text[i] !== '{') return o;
    i++;
    if (depth > maxDepth) { // 超深就直接吞到匹配的右括号，防止栈爆
      let level = 1;
      while (i < n && level > 0) {
        const c = text[i];
        if (c === '{') level++;
        else if (c === '}') level--;
        i++;
      }
      return o;
    }
    for (;;) {
      ws();
      if (i >= n) break;
      if (text[i] === '}') { i++; break; }
      const key = str();
      if (key == null) { i++; continue; } // 不是字符串开头：跳过一个字符继续找结构
      ws();
      if (text[i] === '{') { o[key] = obj(depth + 1); continue; }
      const val = str();
      o[key] = val == null ? '' : val;
    }
    return o;
  }
  ws();
  const root = {};
  const topKey = str();
  if (topKey != null) { ws(); root[topKey] = obj(1); }
  return root;
}

/* ============================ Steam 库探测 ============================ */
async function isDir(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}
async function readFileSafe(p, limitBytes = 2 * 1024 * 1024) {
  try {
    const st = await fsp.stat(p);
    if (st.size > limitBytes) return null; // 异常大的清单不读（防呆）
    return await fsp.readFile(p, 'utf8');
  } catch { return null; }
}

/* 常见安装位置：Windows 两处 + 本机用户名目录 + Linux/macOS 常规位置。
   只有 steamapps 真实存在的才算命中。 */
function candidates() {
  const out = [];
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const pf86 = process.env['ProgramFiles(x86)'] || '';
  const pf = process.env.ProgramFiles || '';
  if (pf86) out.push(path.join(pf86, 'Steam'));
  if (pf) out.push(path.join(pf, 'Steam'));
  if (process.env.HMP_STEAM_PATH) out.push(process.env.HMP_STEAM_PATH);
  if (process.platform === 'win32') {
    // 装载 D/E/F 盘是很常见的做法，逐一试一遍（不存在立刻跳过，代价极低）
    for (const d of ['C', 'D', 'E', 'F', 'G']) out.push(d + ':\\SteamLibrary', d + ':\\Steam', d + ':\\Games\\Steam');
  } else {
    if (home) {
      out.push(path.join(home, '.steam', 'steam'));
      out.push(path.join(home, '.local', 'share', 'Steam'));
      out.push(path.join(home, 'Library', 'Application Support', 'Steam'));
    }
    out.push('/home/deck/.local/share/Steam');
  }
  return Array.from(new Set(out.filter(Boolean)));
}

async function detect() {
  const cur = roots();
  const seen = new Set(cur);
  const found = [];
  for (const p of candidates()) {
    if (seen.has(p)) continue;
    if (await isDir(path.join(p, 'steamapps'))) { found.push(p); seen.add(p); }
  }
  return [...cur, ...found];
}

/* 由一个根推出所有 steamapps 目录：根目录自身的 + libraryfolders.vdf 登记的其它库。
   ★ 关键取舍：vdf 里记的是「那台机器当时」的绝对路径（Windows 上长这样 D:\SteamLibrary），
     搬到 Linux/NAS 上这些路径必然不存在 —— 所以只用 vdf 做「参考」，真正的清单来自落到磁盘上的
     appmanifest_*.acf。路径能用就用，不能用就跳过，不硬来。 */
async function steamappsDirs(root) {
  const dirs = [];
  const self = path.join(root, 'steamapps');
  if (await isDir(self)) dirs.push(self);
  const lf = path.join(self, 'libraryfolders.vdf');
  const txt = await readFileSafe(lf);
  if (txt) {
    const o = parseVdf(txt);
    const node = (o && o.libraryfolders) || (o && o.LibraryFolders) || {};
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (!v || typeof v !== 'object') continue; // contentstatsid 之类标量键
      const p = v.path;
      if (!p || typeof p !== 'string') continue;
      if (await isDir(p)) {
        const d = path.join(p, 'steamapps');
        if (await isDir(d) && !dirs.includes(d)) dirs.push(d);
      }
      // 相对写法 / 挂载后落在子目录：把最后一段当子目录名试一次（D:\SteamLibrary → root/SteamLibrary）
      const tail = p.split(/[\\/]+/).filter(Boolean).pop();
      if (tail && tail !== '.' && tail !== 'steamapps') {
        const cand = path.join(root, tail, 'steamapps');
        if (await isDir(cand) && !dirs.includes(cand)) dirs.push(cand);
      }
    }
  }
  // 兜底：根目录下直接挂了别的库（一层就够了，不做全盘递归）
  try {
    const ent = await fsp.readdir(root, { withFileTypes: true });
    for (const e of ent) {
      if (!e.isDirectory()) continue;
      const d = path.join(root, e.name, 'steamapps');
      if (await isDir(d) && !dirs.includes(d)) dirs.push(d);
    }
  } catch { /* 读不了就算了 */ }
  return dirs;
}

/* 运行库/中间件不算游戏：Steamworks Common Redistributables、各种 Proton / Runtime 层。
   它们在库里数量不少但不该占海报墙；想看可以开关打开。 */
const RUNTIME_RE = /^(steamworks|steam linux runtime|proton|steamvr|osu!|steam controller|Microsoft Visual C\+\+|DirectX|Steam Audio|Steam Screenshots|Steam Client Bootstrapper|！|Steam Overlay)/i;
const RUNTIME_IDS = new Set(['228980', '1070560', '1391110', '1628350', '1883720', '2940030', '1826330', '2183900']);

function toNum(v) { const n = Number(String(v || '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; }

async function parseAcf(file) {
  const txt = await readFileSafe(file, 512 * 1024);
  if (!txt) return null;
  const o = parseVdf(txt);
  const a = (o && (o.AppState || o.appstate)) || null;
  if (!a) return null;
  const appid = String(a.appid || '').trim();
  if (!/^\d+$/.test(appid)) return null;
  const size = toNum(a.SizeOnDisk || a.StagingSize);
  const flags = toNum(a.StateFlags);
  // StateFlags=4 已完整安装；2 是「下载中/已卸载残留」。体积为 0 的一律不当已装。
  if (flags === 2 || (!size && flags !== 4 && flags !== 6)) {
    if (!(flags === 4 && size === 0)) return null;
  }
  return {
    appid,
    name: String(a.name || '').trim() || ('App ' + appid),
    dir: String(a.installdir || '').trim(),
    size,
    updated: toNum(a.LastUpdated),
    build: String(a.buildid || '').trim(),
    // 非 latin1 的家目录在 Windows 上常被 Steam 写成 \\?\ 前缀，去掉只为展示
    lib: file,
  };
}

const cache = { at: 0, items: [], ms: 5 * 60 * 1000, err: '' };
let scanning = false;

async function scan(force) {
  const now = Date.now();
  if (!force && cache.at && now - cache.at < cache.ms) return { cached: true, items: cache.items };
  if (scanning) return { busy: true, items: cache.items };
  scanning = true;
  const t0 = Date.now();
  try {
    const rootsIn = roots();
    const map = new Map();
    let seenFiles = 0, badDirs = 0;
    for (const root of rootsIn) {
      const dirs = await steamappsDirs(root);
      if (!dirs.length) badDirs++;
      for (const d of dirs) {
        let names = [];
        try { names = await fsp.readdir(d); } catch { continue; }
        const acfs = names.filter((x) => /^appmanifest_\d+\.acf$/i.test(x));
        for (let i = 0; i < acfs.length; i++) {
          const g = await parseAcf(path.join(d, acfs[i]));
          seenFiles++;
          if (!g) continue;
          const prev = map.get(g.appid);
          // 同一游戏可能落在多个库里，留体积大的那份（另一个通常是残留）
          if (!prev || g.size > prev.size) map.set(g.appid, g);
          // ★ 铁律：大目录必须分片让出事件循环，否则整个服务卡死
          if (((i + 1) % 100) === 0) await new Promise((r) => setImmediate(r));
        }
      }
    }
    const showRuntime = db.getSetting(K.dolphin, false) === true;
    let all = Array.from(map.values());
    const hidden = all.filter((g) => RUNTIME_IDS.has(g.appid) || RUNTIME_RE.test(g.name));
    if (!showRuntime) all = all.filter((g) => !hidden.includes(g));
    all.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
    cache.at = Date.now();
    cache.items = all;
    cache.err = '';
    // 封面后台补齐：只补没落盘的，第二次以后几乎瞬间返回
    prefetchCovers(all.map((g) => ({ appid: g.appid }))).catch(() => {});
    return {
      items: all.map((g) => ({
        appid: g.appid,
        name: g.name,
        dir: g.dir,
        size: g.size,
        updated: g.updated,
        cover: '/api/games/steam/cover?appid=' + g.appid,
        wide: '/api/games/steam/cover?appid=' + g.appid + '&w=wide',
        steamUri: 'steam://rungameid/' + g.appid,
        storeUrl: 'https://store.steampowered.com/app/' + g.appid,
      })),
      stats: { total: all.length, hidden: hidden.length, roots: rootsIn.length, badDirs, ms: Date.now() - t0, files: seenFiles },
      roots: rootsIn,
    };
  } catch (e) {
    cache.err = String((e && e.message) || e);
    return { error: cache.err, items: [], stats: { total: 0, hidden: 0, roots: roots().length, ms: Date.now() - t0 } };
  } finally {
    scanning = false;
  }
}

/* 单个游戏的 Steam 可执行文件路径（在本机能读到的前提下）。
   用途：展示 Steam 库所在盘符等环境信息；读不到就老实返回空，绝不编造。 */
function exeOf(appid) {
  const g = (cache.items || []).find((x) => x.appid === String(appid));
  if (!g || !g.dir) return '';
  try {
    const appsRoot = path.dirname(path.dirname(g.lib)); // steamapps/common
    return path.join(appsRoot, 'common', g.dir);
  } catch { return ''; }
}

/* ============================ 封面代理与缓存 ============================ */
const COVER_HOSTS = ['https://cdn.cloudflare.steamstatic.com', 'https://steamcdn-a.akamaihd.net'];
function coverDir() { return paths.ensureDir(path.join(paths.dirs.cache(), 'steam')); }
function coverType(wide) { return wide ? 'header' : 'library_600x900'; }

function fetchBuf(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0 HMP' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return fetchBuf(res.headers.location, timeoutMs).then(resolve, reject);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const chunks = [];
        res.on('data', (c) => { chunks.push(c); if (chunks.length > 512) { res.destroy(); reject(new Error('image too big')); } });
        res.on('end', () => resolve({ buf: Buffer.concat(chunks), type: res.headers['content-type'] || 'image/jpeg' }));
        res.on('error', reject);
      });
    } catch (e) { return reject(e); }
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/* 取封面：先找磁盘缓存（含「没有封面」的负缓存），再逐级回线上 CDN。
   负缓存 7 天 —— 老游戏确实没有竖版图，不然每次翻页都要白等 3 次超时。 */
async function cover(appid, wide) {
  const id = String(appid || '').replace(/[^\d]/g, '');
  if (!id) return { error: 'appid 不合法' };
  const kind = coverType(wide);
  const file = path.join(coverDir(), id + '-' + kind + '.jpg');
  const miss = path.join(coverDir(), id + '-' + kind + '.miss');
  try {
    const st = await fsp.stat(file);
    if (st.size > 0) return { file, type: 'image/jpeg' };
  } catch { /* 没有缓存，往下走 */ }
  try {
    const ms = await fsp.stat(miss);
    if (Date.now() - ms.mtimeMs < 7 * 24 * 3600 * 1000) return { error: 'no-cover' };
  } catch { /* 没负缓存 */ }

  const tries = kind === 'header'
    ? ['header.jpg']
    : ['library_600x900.jpg', 'library_600x900_2x.jpg', 'library.jpg', 'header.jpg'];
  for (const host of COVER_HOSTS) {
    for (const t of tries) {
      try {
        const r = await fetchBuf(host + '/steam/apps/' + id + '/' + t);
        if (r && r.buf && r.buf.length > 512) {
          try { await fsp.writeFile(file, r.buf); } catch { /* 写不了缓存就本次直给 */ }
          return { buf: r.buf, type: r.type || 'image/jpeg' };
        }
      } catch { /* 换下一个候选 */ }
    }
  }
  try { await fsp.writeFile(miss, String(Date.now())); } catch { /* 负缓存写不了也无所谓 */ }
  return { error: 'no-cover' };
}

/* 封面后台补齐：扫描完把没缓存的竖版封面排队预热（并发受控、失败静默、负缓存防重复）。
   2026-09-29 复原：剔除「一键串流」段时误删了本函数，但 scan/exports 仍在引用
   —— ReferenceError 会导致 steam.js 加载失败、服务启动报错。 */
let prefetchBusy = false;
async function prefetchCovers(list) {
  if (prefetchBusy || !Array.isArray(list) || !list.length) return;
  prefetchBusy = true;
  try {
    for (let i = 0; i < list.length; i++) {
      try { await cover(list[i].appid, false); } catch { /* 单个失败不管 */ }
      // ★ 铁律：长任务必须分片让出事件循环，否则整个服务卡死
      if (((i + 1) % 5) === 0) await new Promise((r) => setImmediate(r));
    }
  } finally { prefetchBusy = false; }
}

module.exports = {
  parseVdf, detect, roots, setRoots, scan, exeOf, cover, prefetchCovers,
  K,
};
