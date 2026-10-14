'use strict';
/* ---------------- 儿童模式（服务端唯一真源） ----------------
   设计原则（2026-09-22 重做版，吸取旧版三大教训）：
   1. 状态存 DB（settings.kids_config），重启不丢，前端只是展示层；
      「启用/解除」必须经服务端 + PIN，杜绝旧版前端状态切换不可靠的问题。
   2. 过滤在服务端 API 层做：白名单目录（影视/音乐/照片/书各自 root_id 集合）
      之外的内容在列表/详情/流接口全部看不见，改前端绕不过去。
   3. 儿童模式下写接口只放行「观看/播放/进度」类，加目录/扫描/删除/设置等
      管理动作一律 403 —— 解决旧版「儿童可自行加目录入库」的问题。
   4. 退出儿童模式必须验 PIN，退出后服务端过滤立即消失，不会残留儿童内容。 */
const crypto = require('node:crypto');
const db = require('./db');

const KEY = 'kids_config';

function cfg() {
  try { return JSON.parse(db.getSetting(KEY, '') || '{}') || {}; } catch { return {}; }
}
function save(c) { db.setSetting(KEY, JSON.stringify(c)); }

function pinHash(pin, salt) {
  return crypto.createHash('sha256').update(String(salt) + ':' + String(pin)).digest('hex');
}

/* PIN 校验（常量时间比较，防时序试探） */
function checkPin(pin) {
  const c = cfg();
  if (!c.salt || !c.pinHash) return false;
  pin = String(pin == null ? '' : pin).trim();
  if (!/^\d{4,8}$/.test(pin)) return false;
  const h = pinHash(pin, c.salt);
  try { return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(c.pinHash)); } catch { return false; }
}

/* 首次设置 / 修改 PIN（已设过时需验旧 PIN） */
function setPin(pin, oldPin) {
  pin = String(pin == null ? '' : pin).trim();
  if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN 需为 4~8 位数字');
  const c = cfg();
  if (c.salt && !checkPin(oldPin)) throw new Error('原 PIN 不正确');
  c.salt = crypto.randomBytes(8).toString('hex');
  c.pinHash = pinHash(pin, c.salt);
  save(c);
  return true;
}

/* 家长白名单：允许儿童看到的内容（可混用两种粒度，存在同一数组里）
     · 数字   = 媒体库根目录 id → 该根目录全部内容
     · 字符串 = 目录路径（本地绝对路径 / 网盘远程路径）→ 只放开该目录及其子目录
   未传的键保持不变。 */
const KEYS = ['videoRoots', 'musicRoots', 'photoRoots', 'bookRoots'];

function setRoots(roots, pin) {
  if (!checkPin(pin)) throw new Error('PIN 不正确');
  const c = cfg();
  const pick = (v) => {
    if (!Array.isArray(v)) return null;
    const out = [];
    for (const x of v) {
      if (typeof x === 'number' || /^\d+$/.test(String(x).trim())) {
        const n = Number(x);
        if (n > 0) out.push(n);
      } else {
        const d = normDir(x);
        if (d) out.push(d);
      }
    }
    return [...new Set(out)];
  };
  for (const k of KEYS) {
    const v = pick(roots && roots[k]);
    if (v) c[k] = v;
  }
  save(c);
  return status();
}

/* 进入 / 退出儿童模式（都需 PIN；退出后过滤立即消失） */
function enter(pin) {
  const c = cfg();
  if (!c.salt) throw new Error('请先在设置页设置家长 PIN');
  if (!checkPin(pin)) throw new Error('PIN 不正确');
  c.active = true;
  save(c);
  return true;
}
function exit(pin) {
  if (!checkPin(pin)) throw new Error('PIN 不正确');
  const c = cfg();
  c.active = false;
  save(c);
  return true;
}

function isActive() { return !!cfg().active; }

/* 状态给前端：active + pinSet + 白名单（供设置页回显勾选） */
function status() {
  const c = cfg();
  return {
    active: !!c.active,
    pinSet: !!c.salt,
    config: {
      videoRoots: c.videoRoots || [],
      musicRoots: c.musicRoots || [],
      photoRoots: c.photoRoots || [],
      bookRoots: c.bookRoots || [],
    },
  };
}

/* ================= 服务端过滤辅助 =================
   白名单支持两种粒度（可混用，存同一数组）：
     · 数字   = 媒体库根目录 id → 该根目录全部内容
     · 字符串 = 目录路径（本地绝对路径 / 网盘远程路径）→ 该目录及其子目录
   儿童模式未开启时一律返回原数组（零开销）。 */

const IS_WIN = process.platform === 'win32';
const phList = (s) => [...s].map(() => '?').join(',');

/* 路径归一：统一斜杠、去尾斜杠（保留根 '/' 与盘符根） */
function normDir(p) {
  // 折叠重复斜杠：库里存在 '//share/电子书' 这类路径（音乐/电子书根目录带双斜杠），
  // 不做折叠就会和单斜杠写法比不中（2026-09-23 实测）
  let d = String(p == null ? '' : p).trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!d) return '';
  if (d === '/' || /^[A-Za-z]:\/$/.test(d)) return d;
  return d.replace(/\/+$/, '');
}
/* child 是否位于 parent 之下（含相等）；Windows 路径不区分大小写 */
function underDir(child, parent) {
  const c = normDir(child);
  const p = normDir(parent);
  if (!c || !p) return false;
  const cu = IS_WIN ? c.toLowerCase() : c;
  const pu = IS_WIN ? p.toLowerCase() : p;
  return cu === pu || cu.startsWith(pu === '/' ? '/' : pu + '/');
}

/* 解析白名单 → { nums:Set(根id), dirs:[路径], empty:bool } */
function sel(key) {
  const arr = Array.isArray(cfg()[key]) ? cfg()[key] : [];
  const nums = new Set();
  const dirs = [];
  for (const v of arr) {
    if (typeof v === 'number' || /^\d+$/.test(String(v).trim())) {
      const n = Number(v);
      if (n > 0) nums.add(n);
    } else {
      const d = normDir(v);
      if (d) dirs.push(d);
    }
  }
  return { nums, dirs, empty: !nums.size && !dirs.length };
}
/* 行对象 → 所在目录：优先 dir 列；列表卡片可能只带 path/file_path，退化为取其父目录 */
function rowDir(r) {
  if (!r || typeof r !== 'object') return '';
  if (r.dir) return String(r.dir);
  const f = r.file_path || r.file || r.path || '';
  if (!f) return '';
  const t = String(f).replace(/\\/g, '/');
  const i = t.lastIndexOf('/');
  return i > 0 ? t.slice(0, i) : '';
}
function matchSel(s, rootId, dir) {
  if (s.nums.has(Number(rootId))) return true;
  if (!s.dirs.length) return false;
  return s.dirs.some((p) => underDir(dir, p));
}
function matchRow(s, r) { return matchSel(s, r && r.root_id, rowDir(r)); }
/* SQL 侧路径归一（与 normDir 语义一致）：反斜杠→正斜杠、折叠重复斜杠 */
const NORM_SQL = (col) => `REPLACE(REPLACE(REPLACE(${col}, '\\', '/'), '//', '/'), '//', '/')`;

/* 白名单 → SQL WHERE 片段（数字走 root_id IN，路径走 dir 前缀） */
function selWhere(s) {
  const parts = [];
  const params = [];
  if (s.nums.size) {
    parts.push(`root_id IN (${phList(s.nums)})`);
    params.push(...s.nums);
  }
  for (const d of s.dirs) {
    const esc = d.replace(/[\\%_]/g, (m) => '\\' + m);
    // 兼容两种分隔符 + 重复斜杠：库里本地路径可能是反斜杠，白名单归一成了单斜杠正斜杠
    parts.push(`(${NORM_SQL('dir')} = ? OR ${NORM_SQL('dir')} LIKE ? ESCAPE '\\')`);
    params.push(d, esc + '/%');
  }
  return parts.length ? { sql: '(' + parts.join(' OR ') + ')', params } : null;
}

/* 白名单下的媒体库统计（首页头部的电影/剧集数字不能露出白名单外的量） */
function mediaStats() {
  if (!isActive()) return db.countByKind();
  const s = sel('videoRoots');
  const out = { movie: 0, episode: 0, unknown: 0, total: 0 };
  if (s.empty) return out;
  const w = selWhere(s);
  for (const r of db.all(`SELECT kind, COUNT(*) AS n FROM media_files WHERE ${w.sql} GROUP BY kind`, w.params)) {
    out[r.kind] = r.n;
    out.total += r.n;
  }
  return out;
}

/* 影视行级白名单判定（给 db.mediaHomeSections 在构造卡片前过滤用）；未开启返回 null */
function mediaKeep() {
  if (!isActive()) return null;
  const s = sel('videoRoots');
  if (s.empty) return () => false;
  return (r) => matchRow(s, r);
}

/* 设置页用：白名单里勾选的根 id / 目录路径 */
function selectedRootIds(key) { return [...sel(key).nums]; }
function selectedDirs(key) { return [...sel(key).dirs]; }

/* ---- 影视 ---- */
function filterMedia(rows) {
  if (!isActive()) return rows;
  const s = sel('videoRoots');
  return s.empty ? [] : rows.filter((r) => matchRow(s, r));
}
function checkMediaId(id) {
  if (!isActive()) return true;
  const s = sel('videoRoots');
  if (s.empty) return false;
  const r = db.get('SELECT root_id, dir FROM media_files WHERE id = ?', [Number(id)]);
  return !!(r && matchSel(s, r.root_id, r.dir));
}
function seriesSet() {
  if (!isActive()) return null;
  const s = sel('videoRoots');
  if (s.empty) return new Set();
  const w = selWhere(s);
  return new Set(db.all(
    `SELECT DISTINCT series_key FROM media_files WHERE series_key != '' AND ${w.sql}`, w.params
  ).map((r) => r.series_key).filter(Boolean));
}

/* ---- 音乐 ---- */
function filterMusicTracks(rows) {
  if (!isActive()) return rows;
  const s = sel('musicRoots');
  return s.empty ? [] : rows.filter((r) => matchRow(s, r));
}
function filterMusicAlbums(albums) {
  if (!isActive()) return albums;
  if (!albums || !albums.length) return [];
  const s = sel('musicRoots');
  if (s.empty) return [];
  const w = selWhere(s);
  const ok = new Set(db.all(
    `SELECT DISTINCT album FROM music_tracks WHERE ${w.sql}`, w.params
  ).map((r) => String(r.album).toLowerCase()));
  return albums.filter((a) => ok.has(String(a.album).toLowerCase()));
}
function checkMusicId(id) {
  if (!isActive()) return true;
  const s = sel('musicRoots');
  if (s.empty) return false;
  const r = db.get('SELECT root_id, dir FROM music_tracks WHERE id = ?', [Number(id)]);
  return !!(r && matchSel(s, r.root_id, r.dir));
}

/* ---- 照片 ---- */
function filterPhotoRows(rows) {
  if (!isActive()) return rows;
  const s = sel('photoRoots');
  return s.empty ? [] : rows.filter((r) => matchRow(s, r));
}
function filterPhotoAlbums(albums) {
  if (!isActive()) return albums;
  if (!albums || !albums.length) return [];
  const s = sel('photoRoots');
  if (s.empty) return [];
  const w = selWhere(s);
  const ok = new Set(db.all(
    `SELECT DISTINCT album FROM lib_photos WHERE ${w.sql}`, w.params
  ).map((r) => String(r.album).toLowerCase()));
  if (!ok.size) return [];
  return albums.filter((a) => ok.has(String(a.album).toLowerCase()));
}
function checkPhotoId(id) {
  if (!isActive()) return true;
  const s = sel('photoRoots');
  if (s.empty) return false;
  const r = db.get('SELECT root_id, dir FROM lib_photos WHERE id = ?', [Number(id)]);
  return !!(r && matchSel(s, r.root_id, r.dir));
}

/* ---- 电子书 ---- */
function filterBooks(rows) {
  if (!isActive()) return rows;
  const s = sel('bookRoots');
  return s.empty ? [] : rows.filter((r) => matchRow(s, r));
}
function checkBookId(id) {
  if (!isActive()) return true;
  const s = sel('bookRoots');
  if (s.empty) return false;
  const r = db.get('SELECT root_id, dir FROM ebooks WHERE id = ?', [Number(id)]);
  return !!(r && matchSel(s, r.root_id, r.dir));
}

module.exports = {
  checkPin, setPin, setRoots, enter, exit, isActive, status,
  filterMedia, checkMediaId, seriesSet, mediaStats, mediaKeep, selectedRootIds, selectedDirs,
  filterMusicTracks, filterMusicAlbums, checkMusicId,
  filterPhotoRows, filterPhotoAlbums, checkPhotoId,
  filterBooks, checkBookId,
};
