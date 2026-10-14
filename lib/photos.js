'use strict';
// 扫描让步：每个批次让出事件循环，扫描期间 HTTP/页面不卡
const YIELD = () => new Promise((r) => setImmediate(r));

// 相册模块：上传（multipart）+ 魔数甄选 + 缩略图（ffmpeg）+ 时间线 + 渲染出片相册
// 零 npm 依赖：node:sqlite（经 lib/db 的连接）、node:child_process(ffmpeg)
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const db = require('./db');
const bins = require('./binaries');
const paths = require('./paths');

/* ---------------- 目录 ---------------- */
const photoRoot = () => path.join(paths.dirs.root(), 'photos');
const renderRoot = () => path.join(paths.dirs.root(), 'photos-rendered');
const thumbRoot = () => path.join(paths.dirs.cache(), 'photo-thumbs');
function ensureDirs() {
  for (const d of [photoRoot(), renderRoot(), thumbRoot(), rawRoot()]) fs.mkdirSync(d, { recursive: true });
}

/* ---------------- 甄选：扩展名白名单 + 文件头魔数 ---------------- */
const rawjs = require('./raw');
const EXT_OK = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
// RAW 相机文件（NEF/ARW/CR2/CR3/DNG/RAF…）：不做去马赛克，取内嵌 JPEG 预览来显示
const isLibImage = (ext) => EXT_OK.has(ext) || rawjs.isRawExt(ext);
// RAW 行的 mime 直接记 image/jpeg：对外提供的始终是内嵌 JPEG 预览
const mimeOf = (ext) => MIME_BY_EXT[ext] || (rawjs.isRawExt(ext) ? 'image/jpeg' : 'application/octet-stream');
const rawRoot = () => path.join(paths.dirs.cache(), 'photo-raw');

// 文件头嗅探：扩展名说自己是图片、内容不是的，拒收
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

// 噪音文件名：样片/截图缓存/隐藏文件
const NOISE_RE = /(^|[\\/])\.(?!well-known)|^(sample-|thumb(s|nail)?[_.-]|\.)/i;

/* ---------------- SQLite ---------------- */
function init() {
  ensureDirs();
  libInit();
  db.run(`CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rel_path TEXT NOT NULL,        -- 相对 photoRoot/renderRoot 的路径
    album TEXT NOT NULL DEFAULT '',-- 'timeline' | 'render'
    filter TEXT DEFAULT '',        -- 渲染滤镜名（渲染照片才有）
    src_id INTEGER DEFAULT 0,      -- 渲染自哪张原图
    ext TEXT DEFAULT '', mime TEXT DEFAULT '',
    size INTEGER DEFAULT 0, taken_at TEXT DEFAULT '', created_at TEXT DEFAULT ''
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_photos_album ON photos(album, created_at)`);
}

/* ---------------- multipart 解析（零依赖，内存上限 80MB/请求） ---------------- */
function parseMultipart(req, maxBytes = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const mm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!/multipart\/form-data/i.test(ct) || !mm) return reject(new Error('需要 multipart/form-data'));
    const boundary = '--' + (mm[1] || mm[2]).trim();
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); return reject(new Error('文件太大')); }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks);
        const bBound = Buffer.from(boundary);
        const fields = {}; const files = [];
        let pos = body.indexOf(bBound);
        while (pos !== -1) {
          const next = body.indexOf(bBound, pos + bBound.length);
          if (next === -1) break;
          // 每段：boundary CRLF headers CRLF CRLF content CRLF
          let seg = body.subarray(pos + bBound.length, next);
          if (seg[0] === 0x0d && seg[1] === 0x0a) seg = seg.subarray(2);
          const headEnd = seg.indexOf('\r\n\r\n');
          if (headEnd !== -1) {
            const head = seg.subarray(0, headEnd).toString('utf8');
            let content = seg.subarray(headEnd + 4);
            if (content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a) content = content.subarray(0, content.length - 2);
            const disp = (head.match(/content-disposition:\s*form-data;([^\r\n]*)/i) || [])[1] || '';
            const nameM = disp.match(/name="([^"]*)"/i);
            const fileM = disp.match(/filename="([^"]*)"/i);
            const fieldName = nameM ? nameM[1] : '';
            if (fileM) files.push({ field: fieldName, filename: fileM[1], data: content });
            else fields[fieldName] = content.toString('utf8');
          }
          pos = next;
        }
        resolve({ fields, files });
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/* ---------------- 落盘 ---------------- */
function safeExt(filename, sniffed) {
  const ext = path.extname(filename || '').toLowerCase();
  if (sniffed === 'jpeg') return '.jpg';
  if (sniffed && ['png', 'webp', 'gif', 'bmp'].includes(sniffed)) return '.' + sniffed;
  return EXT_OK.has(ext) ? ext : (sniffed ? '.' + sniffed : null);
}
const monthOf = (d) => d.toISOString().slice(0, 7);

async function saveUpload(file, album) {
  const sniffed = sniffImage(file.data);
  const ext = safeExt(file.filename, sniffed);
  if (!sniffed || !ext) return { skipped: true, reason: '不是有效图片（文件头校验未过）: ' + file.filename };
  if (album !== 'render' && file.data.length < 20 * 1024 && sniffed !== 'gif') return { skipped: true, reason: '图片过小（疑似图标/缓存）: ' + file.filename };
  if (NOISE_RE.test(path.basename(file.filename))) return { skipped: true, reason: '噪音文件: ' + file.filename };

  const now = new Date();
  const dir = path.join(album === 'render' ? renderRoot() : photoRoot(), monthOf(now));
  fs.mkdirSync(dir, { recursive: true });
  const base = file.filename ? path.basename(file.filename, path.extname(file.filename)).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) : 'photo';
  const fname = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${base}${ext}`;
  const abs = path.join(dir, fname);
  await fsp.writeFile(abs, file.data);

  const rel = path.relative(album === 'render' ? renderRoot() : photoRoot(), abs).replace(/\\/g, '/');
  const created = now.toISOString();
  const info = db.run(
    `INSERT INTO photos(rel_path, album, filter, src_id, ext, mime, size, taken_at, created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [rel, album, album === 'render' ? String(file.filterName || '') : '', Number(file.srcId || 0),
     ext, MIME_BY_EXT[ext] || ('image/' + sniffed), file.data.length, created, created]
  );
  const id = Number(info.lastInsertRowid);
  makeThumb(id); // 异步，不阻塞上传响应
  return { ok: true, id, skipped: false };
}

/* ---------------- 缩略图（ffmpeg；不可用时原文件兜底） ---------------- */
function thumbAbs(id) { return path.join(thumbRoot(), id + '.jpg'); }

function makeThumb(id) {
  const row = db.get(`SELECT id, rel_path, album FROM photos WHERE id=?`, [id]);
  if (!row) return;
  const base = row.album === 'render' ? renderRoot() : photoRoot();
  const src = path.join(base, row.rel_path);
  const ffmpeg = bins.status().ffmpeg;
  if (!ffmpeg || !fs.existsSync(src)) return;
  execFile(ffmpeg, ['-y', '-i', src, '-vf', "scale='min(480,iw)':-2", '-frames:v', '1', '-q:v', '4', thumbAbs(id)],
    { windowsHide: true, timeout: 20000 }, (err) => {
      if (err) { try { fs.unlinkSync(thumbAbs(id)); } catch { /* ignore */ } }
    });
}

/* ---------------- 查询 ---------------- */
// 时间线：按月分组（渲染出片单独一个相册）
function listPhotos(album = 'timeline') {
  return db.all(
    `SELECT id, album, filter, src_id, ext, mime, size, taken_at, created_at,
            substr(created_at, 1, 7) AS month
     FROM photos WHERE album=? ORDER BY created_at DESC, id DESC`, [album]);
}
function getPhoto(id) {
  return db.get(`SELECT * FROM photos WHERE id=?`, [id]);
}
function absOf(row) {
  return path.join(row.album === 'render' ? renderRoot() : photoRoot(), row.rel_path);
}
function removePhoto(id) {
  const row = getPhoto(id);
  if (!row) return false;
  try { fs.unlinkSync(absOf(row)); } catch { /* ignore */ }
  try { fs.unlinkSync(thumbAbs(id)); } catch { /* ignore */ }
  db.run(`DELETE FROM photos WHERE id=?`, [id]);
  return true;
}
function stats() {
  const r = db.get(`SELECT COUNT(*) AS n FROM photos WHERE album='timeline'`);
  const d = db.get(`SELECT COUNT(*) AS n FROM photos WHERE album='render'`);
  return { photos: r ? r.n : 0, rendered: d ? d.n : 0 };
}

/* ================= NAS 相册库（目录扫描 + 自动发现） ================= */
// 独立于「上传相册」：把 NAS/本机的照片目录挂进来，按子文件夹归相册

function libInit() {
  db.run(`CREATE TABLE IF NOT EXISTS photo_roots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE, label TEXT DEFAULT '', added_at TEXT DEFAULT '')`);
  db.run(`CREATE TABLE IF NOT EXISTS lib_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id INTEGER NOT NULL, path TEXT NOT NULL UNIQUE,
    dir TEXT DEFAULT '', name TEXT DEFAULT '', album TEXT DEFAULT '',
    ext TEXT DEFAULT '', mime TEXT DEFAULT '', size INTEGER DEFAULT 0, mtime REAL DEFAULT 0)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_lib_photos_album ON lib_photos(album, id)`);
  // Flickr 风格改造：宽高（justified 满行布局）、EXIF 拍摄日期、内容分类
  for (const c of ['w INTEGER DEFAULT 0', 'h INTEGER DEFAULT 0', 'taken_at TEXT DEFAULT \'\'', 'category TEXT DEFAULT \'\'']) {
    try { db.run(`ALTER TABLE lib_photos ADD COLUMN ${c}`); } catch { /* 列已存在 */ }
  }
  // 照片详情：相机 / 镜头 / 拍摄参数 / GPS
  for (const c of [
    "make TEXT DEFAULT ''", "model TEXT DEFAULT ''", "lens TEXT DEFAULT ''", "software TEXT DEFAULT ''",
    'orient INTEGER DEFAULT 0', 'fnum REAL', "exposure TEXT DEFAULT ''", 'iso INTEGER DEFAULT 0',
    'focal REAL', 'focal35 INTEGER DEFAULT 0', 'exp_bias REAL', 'flash INTEGER',
    'gps_lat REAL', 'gps_lon REAL', 'gps_alt REAL', "place TEXT DEFAULT ''", 'exif_done INTEGER DEFAULT 0',
  ]) {
    try { db.run(`ALTER TABLE lib_photos ADD COLUMN ${c}`); } catch { /* 列已存在 */ }
  }
  // 用户自定义相簿（新建相簿）
  db.run(`CREATE TABLE IF NOT EXISTS photo_albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT '')`);
  db.run(`CREATE TABLE IF NOT EXISTS photo_album_items (
    album_id INTEGER NOT NULL, photo_id INTEGER NOT NULL,
    UNIQUE(album_id, photo_id))`);
  // 手机备份设备（设备目录建在照片墙根目录下，设备名=相册名）
  db.run(`CREATE TABLE IF NOT EXISTS backup_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE, dir TEXT NOT NULL, root_id INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT 0, last_backup_at INTEGER DEFAULT 0)`);
  // 历史遗留：早期版本把「其他」原样写进 category，与「空串=未分类」两套语义并存。
  // 启动时归一为空串，保证「其他」分类筛选不漏历史数据（幂等：第二次起匹配 0 行）
  try { db.run(`UPDATE lib_photos SET category = '' WHERE category = '其他'`); } catch { /* ignore */ }
  // AI 分类置信度语义：-1 未处理/人工干预、>=0 AI 标定、-2 处理失败。
  // AI 模块(ai.js)也会 ALTER 同一列，两处都幂等，谁先初始化都能建上
  try { db.run(`ALTER TABLE lib_photos ADD COLUMN ai_conf REAL DEFAULT -1`); } catch { /* 列已存在 */ }
  db.run(`CREATE INDEX IF NOT EXISTS idx_lib_photos_category ON lib_photos(category, id)`);
}

const SKIP_DIR_RE = /(^|[\\/])(@Recycle|@Recently-Snapshot|\.@__thumb|\.@upload_cache|#recycle|\.[^\\/]+)$/i;

function libListRoots() {
  return db.all(`SELECT * FROM photo_roots ORDER BY id`);
}
function libAddRoot(p, label) {
  const abs = path.resolve(String(p || '').trim());
  if (!abs) throw new Error('路径不能为空');
  const st = fs.statSync(abs);
  if (!st.isDirectory()) throw new Error('不是目录: ' + abs);
  const old = db.get(`SELECT id FROM photo_roots WHERE path = ?`, [abs]);
  if (old) return old.id; // 幂等
  const info = db.run(`INSERT INTO photo_roots (path, label, added_at) VALUES (?,?,?)`,
    [abs, label || path.basename(abs), new Date().toISOString()]);
  return Number(info.lastInsertRowid);
}
function libRemoveRoot(id) {
  db.run(`DELETE FROM lib_photos WHERE root_id = ?`, [id]);
  db.run(`DELETE FROM photo_roots WHERE id = ?`, [id]);
}

// 自动发现：固定候选 + /share 一级目录里含图片的（QNAP/群晖布局）
const FIXED_CANDIDATES = ['/share/照片', '/share/Multimedia', '/share/photo', '/share/Photo',
  '/volume1/photo', '/volume1/homes', '/mnt/photo', 'C:\\Users\\aa\\Pictures'];
function libSuggestRoots() {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    if (!p || seen.has(p)) return;
    if (/HMP-|[/\\]data([/\\]|$)|@Recycle|@Recently-Snapshot|\.@__thumb/i.test(p)) return; // 应用自身/缓存目录排除
    if (/\/(CACHEDEV|HD|MD)_?[A-Z0-9]*_?DATA|\/Qrootfs/i.test(p)) return; // QNAP 卷挂载点不作为相册根
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return;
    seen.add(p); out.push(p);
  };
  for (const c of FIXED_CANDIDATES) push(c);
  // /share/* 一级目录探测（限 40 个，每个抽样最多 80 次判断）
  try {
    const share = '/share';
    if (fs.existsSync(share)) {
      for (const name of fs.readdirSync(share)) {
        if (out.length >= 24) break;
        if (/^(NFSv|external|homes$)/.test(name) || name.startsWith('.') || name.startsWith('@')) continue;
        if (/^(CACHEDEV|HD|MD)_?[A-Z0-9]*_?DATA$/.test(name)) continue; // 卷挂载点
        if (/HMP-/.test(name)) continue;                                 // 本应用目录
        const p = path.join(share, name);
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (!st.isDirectory()) continue;
        if (dirHasImages(p, 0)) push(p);
      }
    }
  } catch { /* ignore */ }
  const have = new Set(libListRoots().map((r) => r.path));
  return out.filter((p) => !have.has(p));
}
function dirHasImages(dir, depth) {
  if (depth > 1) return false;
  let names; try { names = fs.readdirSync(dir); } catch { return false; }
  let checks = 0;
  for (const n of names) {
    if (SKIP_DIR_RE.test(n) || n.startsWith('.')) continue;
    const p = path.join(dir, n);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (dirHasImages(p, depth + 1)) return true; continue; }
    if (++checks > 80) return false;
    const ext = path.extname(n).toLowerCase();
    if (isLibImage(ext) && st.size > 20 * 1024) return true;
  }
  return false;
}

// 递归扫描一个根目录
function walkImages(rootId, rootPath, baseDir, out) {
  let names; try { names = fs.readdirSync(baseDir); } catch { return; }
  for (const name of names) {
    if (SKIP_DIR_RE.test(name)) continue;
    const full = path.join(baseDir, name);
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) { walkImages(rootId, rootPath, full, out); continue; }
    if (!st.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (!isLibImage(ext)) continue;
    if (st.size < 20 * 1024 && ext !== '.gif') continue;       // 过小疑似图标/缓存
    if (NOISE_RE.test(name)) continue;                          // 噪音文件
    out.push({ rootId, path: full, dir: path.dirname(full), name, ext, size: st.size, mtime: st.mtimeMs });
  }
}

async function libScanAll({ onEvent = () => {} } = {}) {
  const roots = libListRoots();
  let added = 0, skipped = 0, scanned = 0;
  for (const root of roots) {
    if (!fs.existsSync(root.path)) continue;
    const found = [];
    walkImages(root.id, root.path, root.path, found);
    onEvent(`${root.path} 发现 ${found.length} 张`);
    for (const f of found) {
      scanned += 1;
      if (scanned % 25 === 0) await YIELD();
      // 魔数校验：普通图片走 JPEG/PNG 头，RAW 走 TIFF/Fuji/CR3/X3F/IIQ 头
      let ok = false;
      try {
        const fd = fs.openSync(f.path, 'r');
        const b = Buffer.alloc(64);
        fs.readSync(fd, b, 0, 64, 0); fs.closeSync(fd);
        ok = rawjs.isRawExt(f.ext) ? !!rawjs.sniffRaw(b) : !!sniffImage(b);
      } catch { ok = false; }
      if (!ok) { skipped += 1; continue; }
      // 相册名：相对根的子目录；根下直接放图 → 根名
      const relDir = path.dirname(path.relative(root.path, f.path));
      const album = (relDir === '.' || relDir === '' || relDir.includes('..'))
        ? (root.label || path.basename(root.path)) : relDir.replace(/\\/g, '/');
      // 探测：宽高（Flickr 布局）、EXIF 拍摄日期、文件名启发分类
      const probe = probeImage(f.path, f.name, f.ext);
      const r = db.run(
        `INSERT OR IGNORE INTO lib_photos (root_id, path, dir, name, album, ext, mime, size, mtime, w, h, taken_at, category,
           make, model, lens, software, orient, fnum, exposure, iso, focal, focal35, exp_bias, flash, gps_lat, gps_lon, gps_alt, exif_done)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
        [f.rootId, f.path, f.dir, f.name, album, f.ext, mimeOf(f.ext), f.size, f.mtime,
         probe.w, probe.h, probe.taken_at, probe.category].concat(exifArgs(probe)));
      if (Number(r.changes) > 0) added += 1;
      if (added % 200 === 0 && added > 0) onEvent(`已入库 ${added} 张…`);
    }
  }
  // 已消失的文件清理
  const all = db.all(`SELECT id, path FROM lib_photos`);
  let gone = 0;
  for (const row of all) if (!fs.existsSync(row.path)) { db.run(`DELETE FROM lib_photos WHERE id=?`, [row.id]); gone += 1; }
  return { scanned, added, skipped, gone };
}

function libAlbums() {
  return db.all(`SELECT album, COUNT(*) AS count,
      MIN(id) AS cover_id, MAX(mtime) AS latest,
      GROUP_CONCAT(DISTINCT root_id) AS root_ids
    FROM lib_photos GROUP BY album ORDER BY latest DESC`).map((a) => ({ ...a, root_ids: String(a.root_ids || '').split(',').map(Number).filter(Boolean) }));
}
function libList(album) {
  return db.all(`SELECT id, root_id, album, name, ext, mime, size, mtime, w, h, taken_at FROM lib_photos WHERE album = ? ORDER BY mtime DESC`, [album]);
}
function libGet(id) { return db.get(`SELECT * FROM lib_photos WHERE id = ?`, [id]); }
function libRemovePhoto(id, opts) {
  const row = libGet(id);
  if (!row) return false;
  try { fs.unlinkSync(row.path); } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(thumbRoot(), 'L' + id + '.jpg')); } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(thumbRoot(), 'H' + id + '.jpg')); } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(thumbRoot(), 'F' + id + '.jpg')); } catch { /* ignore */ }
  if (rawjs.isRawExt(row.ext)) { // RAW 的预览缓存一并清掉
    try { for (const f of fs.readdirSync(rawRoot())) if (f.startsWith(`R${id}-`)) fs.unlinkSync(path.join(rawRoot(), f)); } catch { /* ignore */ }
  }
  db.run(`DELETE FROM lib_photos WHERE id = ?`, [id]);
  // 目录里已经没有任何照片了 → 顺手把这个空文件夹删掉（.workbuddy: 删到照片根目录为止）
  if (!opts || opts.clean !== false) {
    try { libCleanEmptyDirs([row.dir]); } catch { /* ignore */ }
  }
  return true;
}
function libRemovePhotos(ids) {
  let n = 0; const dirs = new Set();
  for (const id of (ids || [])) {
    const row = libGet(Number(id));
    if (!row) continue;
    if (libRemovePhoto(Number(id), { clean: false })) { n += 1; if (row.dir) dirs.add(row.dir); }
  }
  let dirsRemoved = [];
  try { dirsRemoved = libCleanEmptyDirs([...dirs]); } catch { dirsRemoved = []; }
  return { removed: n, dirsRemoved };
}

/* ---- 空文件夹清理：相册里照片删完后自动删目录，并向上递归清理 ----
   只删「照片根目录以内的、不含任何非忽略文件」的目录；系统缩略图缓存（@eaDir/.DS_Store 等）视为可清理 */
const IGNORE_DIR_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '@eadir', '.@__thumb', '#recycle',
  '@recycle', '.trash', '.trashes', '.spotlight-v100', '.fseventsd', '.thumbnails', '.apdisk']);
const isIgnoredEntry = (n) => IGNORE_DIR_FILES.has(String(n).toLowerCase()) || String(n).startsWith('._');

function scanDirEntries(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { ok: false, bad: [], junk: [] }; }
  const bad = [], junk = [];
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (isIgnoredEntry(e.name)) { junk.push(p); continue; }
    if (e.isDirectory()) {
      const sub = scanDirEntries(p);
      if (!sub.ok) { bad.push(p); continue; }               // 读不动 → 保守保留
      if (sub.bad.length) { bad.push(...sub.bad); continue; }
      junk.push(p, ...sub.junk);                             // 空子目录 → 可连带删除
      continue;
    }
    bad.push(p);                                             // 有真实文件（图片/视频/其他）→ 保留
  }
  return { ok: true, bad, junk };
}
function dropPath(p) {
  try {
    if (fs.lstatSync(p).isDirectory()) fs.rmdirSync(p); else fs.unlinkSync(p);
    return true;
  } catch { return false; }
}
function libCleanEmptyDirs(dirs) {
  const removed = [];
  const roots = db.all(`SELECT path FROM photo_roots`).map((r) => path.resolve(r.path));
  const inRoot = (d) => roots.some((rt) => {
    const rel = path.relative(rt, d);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  const seen = new Set();
  for (const start of dirs) {
    let cur = start ? path.resolve(String(start)) : '';
    while (cur && inRoot(cur) && !seen.has(cur)) {
      seen.add(cur);
      const n = db.get(`SELECT COUNT(*) AS n FROM lib_photos WHERE dir COLLATE NOCASE = ?`, [cur]);
      if (n && n.n > 0) break;                               // 库里还有照片 → 停
      const sc = scanDirEntries(cur);
      if (!sc.ok || sc.bad.length) break;                    // 还有别的文件 → 保留
      for (const j of sc.junk) dropPath(j);
      if (!dropPath(cur)) break;
      removed.push(cur);
      cur = path.dirname(cur);
    }
  }
  return removed;
}
function libAbs(row) { return row.path; }

// RAW 源的落盘预览（首次抽取后缓存，之后直接复用）
function libSourceFile(row) {
  if (!rawjs.isRawExt(row.ext)) return row.path;
  const p = rawjs.ensurePreview(row.path, rawRoot(), row.id);
  return p ? p.file : null;
}

/* ---------------- 缩略图生成闸门 ----------------
   必须异步 + 限并发：原先在请求里 execFileSync 逐张生成，每张阻塞事件循环约 0.5s，
   浏览未预热的相册时整站（含其它页面/接口）都会「卡死」。
   默认最多 4 个 ffmpeg 并行；无 ffmpeg 或失败时由调用方兜底。 */
const THUMB_CONC = Math.max(1, parseInt(process.env.HMP_THUMB_CONC || '4', 10) || 4);
let _jobs = 0;
const _waiters = [];
function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      _jobs++;
      Promise.resolve().then(fn).then(resolve, reject)
        .finally(() => { _jobs--; const nx = _waiters.shift(); if (nx) nx(); });
    };
    if (_jobs < THUMB_CONC) run(); else _waiters.push(run);
  });
}
function ffmpegScale(src, out, filter, timeout) {
  const ffmpeg = bins.status().ffmpeg;
  if (!ffmpeg) return Promise.resolve(false);
  return withSlot(() => new Promise((resolve) => {
    require('node:child_process').execFile(ffmpeg,
      ['-y', '-i', src, '-vf', filter, '-frames:v', '1', '-q:v', '3', out],
      { windowsHide: true, timeout: timeout || 30000, stdio: 'ignore' },
      () => resolve(fs.existsSync(out)));
  }));
}

// 视图版（同步、零生成）：只查缓存，绝不起 ffmpeg —— 专供需要同步返回路径的内部逻辑
function libThumb(id) {
  const row = libGet(id);
  if (!row) return null;
  const h = path.join(thumbRoot(), 'H' + id + '.jpg'); // eh：960px 高清优先（照片墙大格 / 浮层 1.5DPR 需 570-960 物理px）
  if (fs.existsSync(h)) return { file: h, mime: 'image/jpeg' };
  const t = path.join(thumbRoot(), 'L' + id + '.jpg');
  if (fs.existsSync(t)) return { file: t, mime: 'image/jpeg' };
  if (rawjs.isRawExt(row.ext)) {
    const src = libSourceFile(row); // RAW 内嵌预览（小图，无需生成）
    return src && fs.existsSync(src) ? { file: src, mime: 'image/jpeg' } : null;
  }
  return { file: row.path, mime: row.mime || 'image/jpeg' };
}

// 异步按需生成 480px 缩略图（带闸门）；返回是否可用
async function libThumbMake(id) {
  const row = libGet(id);
  if (!row) return false;
  const t = path.join(thumbRoot(), 'H' + id + '.jpg'); // eh：960px 高清版
  if (fs.existsSync(t)) return true;
  if (rawjs.isRawExt(row.ext)) return false; // RAW 用内嵌预览顶上，后台任务再补
  const src = libSourceFile(row);
  if (!src || !fs.existsSync(src)) return false;
  await ffmpegScale(src, t, "scale='min(960,iw)':-2", 30000);
  return fs.existsSync(t);
}

// 网格缩略图：缓存命中即秒回；未命中则异步生成（不阻塞其它请求）
async function libThumbServe(id) {
  const row = libGet(id);
  if (!row) return null;
  const h = path.join(thumbRoot(), 'H' + id + '.jpg'); // eh：960 高清
  const t = path.join(thumbRoot(), 'L' + id + '.jpg'); // 旧 480：过渡兜底
  if (fs.existsSync(h)) return { file: h, mime: 'image/jpeg' };
  if (rawjs.isRawExt(row.ext)) {
    const src = libSourceFile(row);
    return src && fs.existsSync(src) ? { file: src, mime: 'image/jpeg' } : null;
  }
  if (fs.existsSync(t)) { // 先回 480 保证速度，后台补 960（浏览过一次下次即高清）
    libThumbMake(id).catch(() => {});
    return { file: t, mime: 'image/jpeg' };
  }
  if (await libThumbMake(id)) return { file: h, mime: 'image/jpeg' };
  return { file: row.path, mime: row.mime || 'image/jpeg' }; // 兜底：生成失败才回原图
}

// 后台预热：把缺缩略图的图库照片按「拍摄时间倒序」逐张补齐（限并发，随时可中断）
let _warm = { running: false, done: 0, total: 0, skipped: 0 };
function libWarmStatus() { return { ..._warm }; }
async function libWarmThumbs({ onEvent = () => {}, limit = 0 } = {}) {
  if (_warm.running) return { ..._warm, already: true };
  const rows = db.all(`SELECT id, ext FROM lib_photos WHERE album <> 'render' ORDER BY COALESCE(NULLIF(taken_at,''), '') DESC, id DESC`);
  const todo = rows.filter((r) => !fs.existsSync(path.join(thumbRoot(), 'H' + r.id + '.jpg')));
  const list = limit > 0 ? todo.slice(0, limit) : todo;
  _warm = { running: true, done: 0, total: list.length, skipped: rows.length - todo.length };
  onEvent(`缩略图预热：待补 ${list.length} 张（已就绪 ${rows.length - todo.length}）`);
  const CONC = 2; // 预热限并发 2，避免与前台浏览抢 CPU
  let idx = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (idx < list.length) {
      const r = list[idx++];
      try {
        if (rawjs.isRawExt(r.ext)) {
          const row = libGet(r.id);
          const src = row && libSourceFile(row); // 先落盘 RAW 内嵌预览
          if (src && fs.existsSync(src)) await ffmpegScale(src, path.join(thumbRoot(), 'H' + r.id + '.jpg'), "scale='min(960,iw)':-2", 30000);
        } else {
          await libThumbMake(r.id);
        }
      } catch { /* 单张失败不影响整体 */ }
      _warm.done++;
      if (_warm.done % 20 === 0) {
        onEvent(`缩略图预热 ${_warm.done}/${_warm.total}`);
        await new Promise((res) => setImmediate(res)); // 让出事件循环
      }
    }
  }));
  _warm.running = false;
  onEvent(`缩略图预热完成：本次 ${_warm.done} 张`);
  return { ..._warm };
}


// 后台批量补 RAW 缩略图（480px，from 内嵌预览）
// 必须用异步 execFile：同步版每张阻塞事件循环 1-2 秒，整个服务都会卡死
async function libRawThumbs({ onEvent = () => {} } = {}) {
  const exts = [...rawjs.RAW_EXT];
  // 按「所有相片」页面同样的排序（拍摄时间倒序）生成：用户最先翻到的页最先热
  const rows = db.all(`SELECT id, path, ext FROM lib_photos WHERE ext IN (${exts.map(() => '?').join(',')})
    ORDER BY COALESCE(NULLIF(taken_at,''), '') DESC, id DESC`, exts);
  const ffmpeg = bins.status().ffmpeg;
  if (!ffmpeg) { onEvent('无 ffmpeg，跳过'); return { generated: 0, skipped: rows.length }; }
  onEvent(`RAW 缩略图待生成 ${rows.length} 张`);
  const runFfmpeg = (src, out, vf) => new Promise((resolve) => {
    execFile(ffmpeg, ['-y', '-i', src, '-vf', vf, '-frames:v', '1', '-q:v', '4', out],
      { windowsHide: true, timeout: 30000 }, () => resolve());
  });
  let done = 0, skip = 0;
  for (const r of rows) {
    const t = path.join(thumbRoot(), 'H' + r.id + '.jpg'); // eh：960px 高清
    const f = path.join(thumbRoot(), 'F' + r.id + '.jpg'); // 2400px 显示版（灯箱用）
    const needThumb = !fs.existsSync(t), needFull = !fs.existsSync(f);
    if (!needThumb && !needFull) { skip += 1; continue; }
    const src = libSourceFile(r);
    if (!src) { skip += 1; continue; }
    if (needThumb) await runFfmpeg(src, t, "scale='min(960,iw)':-2");
    if (needFull) await runFfmpeg(src, f, "scale='min(2400,iw)':-2");
    if (fs.existsSync(t)) done += 1; else skip += 1;
    if (done % 10 === 0) { onEvent(`RAW 缩略图已生成 ${done}（跳过 ${skip}）`); await YIELD(); }
  }
  return { generated: done, skipped: skip };
}

// 全图查看：RAW 优先用 2400px 显示版（后台生成，加载快），没有则退回内嵌预览
function libFull(id) {
  const row = libGet(id);
  if (!row) return null;
  if (rawjs.isRawExt(row.ext)) {
    const disp = path.join(thumbRoot(), 'F' + id + '.jpg');
    if (fs.existsSync(disp)) return { file: disp, mime: 'image/jpeg' };
    const src = libSourceFile(row);
    if (src && fs.existsSync(src)) return { file: src, mime: 'image/jpeg' };
    return null;
  }
  if (!fs.existsSync(row.path)) return null;
  return { file: row.path, mime: row.mime || 'application/octet-stream' };
}

// 灯箱大图：优先 2400px 显示版缓存（原图动辄 8~20MB，直出很慢）；缺则异步生成
async function libFullServe(id) {
  const row = libGet(id);
  if (!row) return null;
  const disp = path.join(thumbRoot(), 'F' + id + '.jpg');
  if (fs.existsSync(disp)) return { file: disp, mime: 'image/jpeg' };
  const src = libSourceFile(row);
  if (src && fs.existsSync(src)) {
    await ffmpegScale(src, disp, "scale='min(2400,iw)':-2", 60000);
    if (fs.existsSync(disp)) return { file: disp, mime: 'image/jpeg' };
    return { file: src, mime: rawjs.isRawExt(row.ext) ? 'image/jpeg' : (row.mime || 'image/jpeg') };
  }
  if (!rawjs.isRawExt(row.ext) && fs.existsSync(row.path)) {
    return { file: row.path, mime: row.mime || 'application/octet-stream' };
  }
  return null;
}

function libStats() { const r = db.get(`SELECT COUNT(*) AS n FROM lib_photos`); return { lib: r ? r.n : 0 }; }

/* ---------------- Flickr 风格改造：图片探测（尺寸/EXIF/启发分类） ---------------- */
/* 扫描时按文件名 / 路径关键词猜分类（AI 跑之前的初值兜底）。
   词表须与前端 catOrder() 的 9 类对齐 —— 「宠物」已从「静物」拆出，别再退回去。
   返回 '' 表示未分类（对外显示为「其他」）。 */
const CAT_HINTS = [
  ['人像', ['人像', '自拍', 'portrait', 'selfie', 'avatar', 'photo_']],
  ['风光', ['风光', '观光', '旅游', '旅行', '风景', '景区', '山水', '海边', 'landscape', 'scenery', 'travel', 'trip', 'tour', 'beach']],
  ['城市', ['城市', '街拍', '建筑', '夜景', 'city', 'street', 'building', 'skyline']],
  ['美食', ['美食', '早餐', '午餐', '晚餐', '火锅', '奶茶', '咖啡', '蛋糕', 'food', 'meal', 'cake', 'coffee']],
  ['宠物', ['宠物', '猫', '狗', 'pet', 'kitten', 'puppy', 'cat', 'dog']],
  ['静物', ['静物', '花', 'flower', 'still']],
  ['截图', ['截图', 'screenshot', 'screencap', 'screen_shot', 'capture']],
  ['文档', ['文档', '扫描', 'document', 'scan', 'receipt', 'invoice']],
];
function guessCategory(...texts) {
  const s = texts.join(' ').toLowerCase();
  // 纯字母的短词（≤3）按整词匹配：否则 vacation 会命中 cat、petrol 会命中 pet
  const words = s.split(/[^a-z0-9\u4e00-\u9fa5]+/);
  for (const [cat, kws] of CAT_HINTS) {
    for (const k of kws) {
      if (k.length <= 3 && /^[a-z]+$/.test(k)) {
        if (words.indexOf(k) >= 0) return cat;
      } else if (s.indexOf(k) >= 0) return cat;
    }
  }
  return '';
}

// JPEG SOF 尺寸 / PNG IHDR / GIF 头
function readSize(ext, buf) {
  try {
    if (ext === '.png' && buf.length > 24) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (ext === '.gif' && buf.length > 10) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (ext !== '.jpg' && ext !== '.jpeg') return null;
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return null;
      i += 2 + len;
    }
  } catch { /* ignore */ }
  return null;
}

/* ---------------- EXIF 全量解析（相机 / 镜头 / 拍摄参数 / GPS） ---------------- */
const fmtNum = (v, d = 1) => {
  if (v == null || !isFinite(v)) return '';
  return String(parseFloat(Number(v).toFixed(d)));
};
function fmtExposure(v) {
  if (v == null || !isFinite(v) || v <= 0) return '';
  if (v >= 1) return fmtNum(v, v < 10 ? 1 : 0) + 's';
  return '1/' + Math.round(1 / v) + 's';
}
function normExifDate(s) {
  const mm = String(s || '').match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  return mm ? `${mm[1]}-${mm[2]}-${mm[3]} ${mm[4]}` : '';
}

// 解析 TIFF/EXIF 块（APP1 载荷，自 II/MM 字节序标记起）
function parseExif(t) {
  const out = { taken_at: '', make: '', model: '', lens: '', software: '', orient: 0,
    fnum: null, exposure: '', iso: 0, focal: null, focal35: 0, exp_bias: null, flash: null,
    gps_lat: null, gps_lon: null, gps_alt: null };
  try {
    if (!t || t.length < 8) return out;
    const le = t.readUInt16LE(0) === 0x4949;
    const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
    const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
    const i32 = (o) => (le ? t.readInt32LE(o) : t.readInt32BE(o));
    const ascii = (e) => {
      const cnt = u32(e + 4);
      const off = cnt <= 4 ? e + 8 : u32(e + 8);
      const n = Math.min(cnt, 96);
      if (off < 0 || off + n > t.length) return '';
      return t.slice(off, off + n).toString('latin1').replace(/\u0000[\s\S]*$/, '').trim();
    };
    const rat = (e) => {
      const off = u32(e + 8);
      if (off + 8 > t.length) return null;
      const a = u32(off), b = u32(off + 4);
      return b ? a / b : null;
    };
    const srat = (e) => {
      const off = u32(e + 8);
      if (off + 8 > t.length) return null;
      const a = i32(off), b = i32(off + 4);
      return b ? a / b : null;
    };
    const sh = (e) => {
      const cnt = u32(e + 4);
      if (cnt <= 1) return u16(e + 8);
      const off = u32(e + 8);
      return off + 2 <= t.length ? u16(off) : 0;
    };
    const rats3 = (e) => {
      const off = u32(e + 8);
      if (off + 24 > t.length) return null;
      const v = [];
      for (let k = 0; k < 3; k += 1) {
        const a = u32(off + k * 8), b = u32(off + k * 8 + 4);
        v.push(b ? a / b : 0);
      }
      return v;
    };
    const walk = (off, fn) => {
      if (!off || off + 2 > t.length) return;
      const n = u16(off);
      if (n > 1024) return;
      for (let k = 0; k < n; k += 1) {
        const e = off + 2 + k * 12;
        if (e + 12 > t.length) return;
        fn(u16(e), e);
      }
    };
    let exifOff = 0, gpsOff = 0, dtAlt = '';
    walk(u32(4), (tag, e) => {
      if (tag === 0x010f) out.make = ascii(e);
      else if (tag === 0x0110) out.model = ascii(e);
      else if (tag === 0x0131) out.software = ascii(e);
      else if (tag === 0x0112) out.orient = sh(e);
      else if (tag === 0x0132) dtAlt = ascii(e);
      else if (tag === 0x9003) out.taken_at = normExifDate(ascii(e));
      else if (tag === 0x8769) exifOff = u32(e + 8);
      else if (tag === 0x8825) gpsOff = u32(e + 8);
    });
    walk(exifOff, (tag, e) => {
      if (tag === 0x829a) { const v = rat(e); if (v != null) out.exposure = fmtExposure(v); }
      else if (tag === 0x829d) out.fnum = rat(e);
      else if (tag === 0x8827) out.iso = sh(e);
      else if (tag === 0x9003) out.taken_at = normExifDate(ascii(e));
      else if (tag === 0x9204) out.exp_bias = srat(e);
      else if (tag === 0x9209) out.flash = sh(e);
      else if (tag === 0x920a) out.focal = rat(e);
      else if (tag === 0xa405) out.focal35 = sh(e);
      else if (tag === 0xa434) out.lens = ascii(e);
    });
    if (!out.taken_at && dtAlt) out.taken_at = normExifDate(dtAlt);
    let latRef = '', lonRef = '', lat = null, lon = null, alt = null, altRef = 0;
    walk(gpsOff, (tag, e) => {
      if (tag === 0x0001) latRef = ascii(e);
      else if (tag === 0x0002) lat = rats3(e);
      else if (tag === 0x0003) lonRef = ascii(e);
      else if (tag === 0x0004) lon = rats3(e);
      else if (tag === 0x0005) altRef = t[e + 8] || 0;
      else if (tag === 0x0006) alt = rat(e);
    });
    const dms = (a) => (a ? a[0] + a[1] / 60 + a[2] / 3600 : null);
    if (lat && lat[0] <= 90) out.gps_lat = /S/i.test(latRef) ? -dms(lat) : dms(lat);
    if (lon && lon[0] <= 180) out.gps_lon = /W/i.test(lonRef) ? -dms(lon) : dms(lon);
    if (alt != null) out.gps_alt = altRef ? -alt : alt;
  } catch { /* ignore */ }
  return out;
}

// 扫 JPEG APP1 段取 EXIF（HEIC/PNG/GIF 无 EXIF，直接返回空）
function readExifFull(buf) {
  try {
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return parseExif(null);
    let i = 2;
    while (i + 4 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return parseExif(null);
      if (marker === 0xe1 && buf.slice(i + 4, i + 10).toString('latin1') === 'Exif\u0000\u0000') {
        return parseExif(buf.subarray(i + 10, i + 2 + len));
      }
      i += 2 + len;
    }
  } catch { /* ignore */ }
  return parseExif(null);
}

// 读文件头部做探测（512KB 足够覆盖 EXIF）
const PROBE_KEYS = ['taken_at', 'make', 'model', 'lens', 'software', 'orient', 'fnum', 'exposure',
  'iso', 'focal', 'focal35', 'exp_bias', 'flash', 'gps_lat', 'gps_lon', 'gps_alt'];
// RAW：尺寸/EXIF 在 TIFF（NEF/ARW/CR2/DNG/ORF/RW2）或 CMT1（CR3）块里；
// Fuji RAF 则要从内嵌预览 JPEG 里读。deep=false 只读文件头（扫描时才快）
function probeRaw(p, out, deep) {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(512 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const b = buf.subarray(0, n);
    let tiff = null;
    if (rawjs.sniffRaw(b) === 'raw-tiff') tiff = b;
    else { const off = rawjs.findTiffOffset(b, 8); if (off > 0) tiff = b.subarray(off); }
    if (tiff) {
      const sz = rawjs.tiffSize(tiff);
      if (sz) { out.w = sz.w; out.h = sz.h; if (sz.orient) out.orient = sz.orient; }
      const ex = parseExif(tiff);
      for (const k of PROBE_KEYS) if (ex[k]) out[k] = ex[k];
    }
    // 廉价路径拿不到尺寸/EXIF（Fuji RAF、Canon CR3 常见）才去读内嵌预览头部
    if (deep || !out.w || !out.h || !out.make || !out.taken_at) {
      const pv = rawjs.exifSlice(p);
      if (pv) {
        if (!out.w) { out.w = pv.w; out.h = pv.h; }
        const ex2 = readExifFull(pv.buf);
        for (const k of PROBE_KEYS) if (!out[k] && ex2[k]) out[k] = ex2[k];
      }
    }
    return out;
  } catch { return out; }
}

function probeImage(p, name, ext, opts = {}) {
  const out = { w: 0, h: 0, taken_at: '', category: guessCategory(name, p) };
  if (rawjs.isRawExt(ext)) return probeRaw(p, out, !!opts.deep);
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(512 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const b = buf.subarray(0, n);
    const size = readSize(ext, b);
    if (size) { out.w = size.w; out.h = size.h; }
    const ex = readExifFull(b);
    for (const k of PROBE_KEYS) out[k] = ex[k];
  } catch { /* ignore */ }
  // 不再用文件 mtime 回填拍摄时间：截图/微信图无 EXIF 时保持为空，
  // 避免「拍摄日期」筛选被入库时间污染（拍摄/入库两个下拉互相串味）
  return out;
}

// EXIF 列取值（顺序与 EXIF_UPDATE_SQL 一一对应）
function exifArgs(pr) {
  return [pr.make || '', pr.model || '', pr.lens || '', pr.software || '', pr.orient || 0,
    pr.fnum == null ? null : pr.fnum, pr.exposure || '', pr.iso || 0,
    pr.focal == null ? null : pr.focal, pr.focal35 || 0,
    pr.exp_bias == null ? null : pr.exp_bias, pr.flash == null ? null : pr.flash,
    pr.gps_lat == null ? null : pr.gps_lat, pr.gps_lon == null ? null : pr.gps_lon,
    pr.gps_alt == null ? null : pr.gps_alt];
}
const EXIF_UPDATE_SQL = `UPDATE lib_photos SET make=?, model=?, lens=?, software=?, orient=?,
  fnum=?, exposure=?, iso=?, focal=?, focal35=?, exp_bias=?, flash=?,
  gps_lat=?, gps_lon=?, gps_alt=?, exif_done=1 WHERE id=?`;

// 后台补齐历史数据（w/h/taken_at/category 任一为空者），分批 YIELD
async function libEnrich({ onEvent = () => {} } = {}) {
  const rows = db.all(`SELECT id, path, name, ext FROM lib_photos WHERE w = 0 OR h = 0 OR taken_at = '' OR category = ''`);
  onEvent(`待补齐 ${rows.length} 张`);
  let done = 0;
  for (const r of rows) {
    if (!fs.existsSync(r.path)) continue;
    const info = probeImage(r.path, r.name, (r.ext || '').toLowerCase());
    db.run(`UPDATE lib_photos SET w=?, h=?, taken_at=?, category=? WHERE id=?`,
      [info.w, info.h, info.taken_at, info.category, r.id]);
    done += 1;
    if (done % 50 === 0) { onEvent(`已补齐 ${done}/${rows.length}`); await YIELD(); }
  }
  return { enriched: done, total: rows.length };
}

// 后台补 EXIF 明细（只写 EXIF 列，不动分类/拍摄时间）
async function libEnrichExif({ limit = 0, onEvent = () => {} } = {}) {
  const rows = db.all(`SELECT id, path, name, ext FROM lib_photos WHERE exif_done = 0 ORDER BY id DESC`
    + (limit ? ` LIMIT ${Number(limit)}` : ''));
  onEvent(`待补 EXIF ${rows.length} 张`);
  let done = 0;
  for (const r of rows) {
    if (!fs.existsSync(r.path)) { db.run(`UPDATE lib_photos SET exif_done=1 WHERE id=?`, [r.id]); continue; }
    const pr = probeImage(r.path, r.name, (r.ext || '').toLowerCase());
    try { db.run(EXIF_UPDATE_SQL, exifArgs(pr).concat([r.id])); } catch { /* ignore */ }
    done += 1;
    if (done % 40 === 0) { onEvent(`EXIF 已补 ${done}/${rows.length}`); await YIELD(); }
  }
  return { enriched: done, total: rows.length };
}

// 重新探测所有 RAW 行（修历史错误尺寸、补 EXIF 明细）；分批让出事件循环
// 注意：不强制 deep，只有廉价路径拿不到信息的文件（Fuji/CR3）才会去读内嵌预览头部
async function libReprobeRaw({ onEvent = () => {} } = {}) {
  const exts = [...rawjs.RAW_EXT];
  const rows = db.all(`SELECT id, path, name, ext FROM lib_photos WHERE ext IN (${exts.map(() => '?').join(',')})`, exts);
  onEvent(`RAW 待重探 ${rows.length} 张`);
  let done = 0;
  for (const r of rows) {
    if (!fs.existsSync(r.path)) continue;
    const pr = probeImage(r.path, r.name, String(r.ext || '').toLowerCase());
    try {
      db.run(EXIF_UPDATE_SQL, exifArgs(pr).concat([r.id]));
      db.run(`UPDATE lib_photos SET w=?, h=?, taken_at=?, category=? WHERE id=?`, [pr.w, pr.h, pr.taken_at, pr.category, r.id]);
    } catch { /* ignore */ }
    done += 1;
    if (done % 40 === 0) { onEvent(`RAW 已重探 ${done}/${rows.length}`); await YIELD(); }
  }
  return { reprobed: done, total: rows.length };
}

function fmtSize(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024 * 1024) return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}
function localTime(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 单张照片的完整信息（详情面板数据源）；未探测过则即时补探测
function libInfo(id) {
  const pid = Number(id);
  let row = libGet(pid);
  if (!row) return null;
  if (!row.exif_done) {
    try {
      const pr = probeImage(row.path, row.name, (row.ext || '').toLowerCase(), { deep: true });
      db.run(EXIF_UPDATE_SQL, exifArgs(pr).concat([pid]));
      row = libGet(pid);
    } catch { /* ignore */ }
  }
  const mp = row.w && row.h ? (row.w * row.h) / 1e6 : 0;
  const camera = [row.make, row.model].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const params = [];
  if (row.exposure) params.push(row.exposure);
  if (row.fnum) params.push('f/' + fmtNum(row.fnum, 1));
  if (row.iso) params.push('ISO ' + row.iso);
  if (row.focal) params.push(fmtNum(row.focal, 0) + 'mm' + (row.focal35 && Math.abs(row.focal35 - row.focal) > 1 ? `（等效 ${row.focal35}mm）` : ''));
  const hasGps = row.gps_lat != null && row.gps_lon != null;
  const la = Number(Number(row.gps_lat).toFixed(6)), lo = Number(Number(row.gps_lon).toFixed(6));
  return {
    id: row.id, name: row.name, album: row.album, path: row.path,
    ext: String(row.ext || '').replace('.', '').toUpperCase(),
    raw: rawjs.isRawExt(row.ext),
    w: row.w || 0, h: row.h || 0, mp: mp ? mp.toFixed(1) : '',
    size: row.size || 0, sizeText: fmtSize(row.size),
    taken_at: row.taken_at || '', added_at: localTime(row.mtime), added_ts: row.mtime || 0,
    category: row.category || '其他', mime: row.mime || '',
    camera: { make: row.make || '', model: row.model || '', lens: row.lens || '', name: camera },
    software: row.software || '',
    params, paramsLine: params.join(' · '),
    exp_bias: row.exp_bias == null ? null : Number(Number(row.exp_bias).toFixed(2)),
    flash: row.flash == null ? null : ((Number(row.flash) & 1) ? '已闪光' : '未闪光'),
    gps: hasGps ? {
      has: true, lat: la, lon: lo, alt: row.gps_alt == null ? null : Math.round(Number(row.gps_alt)),
      coord: `${Math.abs(la).toFixed(5)}°${la >= 0 ? 'N' : 'S'}, ${Math.abs(lo).toFixed(5)}°${lo >= 0 ? 'E' : 'W'}`,
      place: row.place || '',
      mapUrl: `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=16/${la}/${lo}`,
      embedUrl: 'https://www.openstreetmap.org/export/embed.html?bbox='
        + `${(lo - 0.004).toFixed(5)}%2C${(la - 0.0025).toFixed(5)}%2C${(lo + 0.004).toFixed(5)}%2C${(la + 0.0025).toFixed(5)}`
        + `&layer=mapnik&marker=${la}%2C${lo}`,
    } : { has: false },
  };
}

// 逆地理编码（BigDataCloud 免费接口，中文地名），进程内缓存 + 落库缓存
const GEO_CACHE = new Map();
async function reverseGeocode(lat, lon) {
  const k = Number(lat).toFixed(4) + ',' + Number(lon).toFixed(4);
  if (GEO_CACHE.has(k)) return GEO_CACHE.get(k);
  let place = '';
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=zh-Hans`;
    const r = await fetch(url, { headers: { 'User-Agent': 'HomeMediaPlayer/1.0' }, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const j = await r.json();
      const parts = [];
      const add = (s) => {
        s = String(s || '').trim();
        if (!s || parts.includes(s)) return;
        if (parts.some((p) => p.includes(s) || s.includes(p))) return;
        parts.push(s);
      };
      let country = String(j.countryName || '');
      if (/中华人民共和国|中華|中国|China/i.test(country)) country = '中国';
      // 只取 省/市 两级（locality 常是繁体，且与市重名），保证简体一致
      add(country); add(j.principalSubdivision); add(j.city); add(j.locality);
      place = parts.join(' · ');
    }
  } catch { /* 外网不可达时静默降级为坐标 */ }
  if (place) GEO_CACHE.set(k, place);
  return place;
}

// 地点（惰性反查 + 落库）
async function libPlace(id) {
  const row = libGet(Number(id));
  if (!row) return null;
  if (row.gps_lat == null || row.gps_lon == null) return { has: false };
  if (!row.place) {
    const p = await reverseGeocode(row.gps_lat, row.gps_lon);
    if (p) { try { db.run(`UPDATE lib_photos SET place=? WHERE id=?`, [p, row.id]); } catch { /* ignore */ } }
    row.place = p;
  }
  return { has: true, lat: Number(row.gps_lat), lon: Number(row.gps_lon), place: row.place || '' };
}

// 全部照片（分页 + 分类/日期筛选），Flickr 页数据源
function libListAll({ offset = 0, limit = 500, cat = '', dtype = '', date = '', fmt = '', rootIds = null } = {}) {
  const conds = []; const args = [];
  if (Array.isArray(rootIds) && !rootIds.length) return { items: [], total: 0 }; // 空白名单=全部隐藏
  if (rootIds && rootIds.length) { conds.push(`root_id IN (${rootIds.map(() => '?').join(',')})`); args.push(...rootIds.map(Number)); }
  // 「其他」= 未分类：库里用空串表示（历史版本可能写成字面量「其他」），两种都算
  if (cat === '其他') conds.push(`(category = '' OR category = '其他')`);
  else if (cat) { conds.push('category = ?'); args.push(cat); }
  if (fmt === 'raw') conds.push(`ext IN (${[...rawjs.RAW_EXT].map((e) => `'${e}'`).join(',')})`);
  if (date && dtype === 'shot') { conds.push(`substr(taken_at,1,10) = ?`); args.push(date); }
  if (date && dtype === 'added') { conds.push(`date(datetime(mtime/1000,'unixepoch','localtime')) = ?`); args.push(date); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const total = db.get(`SELECT COUNT(*) AS n FROM lib_photos ${where}`, args).n;
  const items = db.all(
    `SELECT id, root_id, album, name, ext, w, h, taken_at, category, mtime FROM lib_photos ${where}
     ORDER BY ${dtype === 'added' ? "mtime DESC" : "COALESCE(NULLIF(taken_at,''), datetime(mtime/1000,'unixepoch','localtime')) DESC"}, id DESC LIMIT ? OFFSET ?`,
    args.concat([limit, offset]));
  return { items, total };
}

// 日期选项（拍摄/入库两种），供筛选下拉
function libDates(type = 'shot', rootIds = null) {
  const col = type === 'added' ? `date(datetime(mtime/1000,'unixepoch','localtime'))` : `substr(taken_at,1,10)`;
  const conds = []; const args = [];
  if (Array.isArray(rootIds) && !rootIds.length) return []; // 空白名单=全部隐藏
  if (rootIds && rootIds.length) { conds.push(`root_id IN (${rootIds.map(() => '?').join(',')})`); args.push(...rootIds.map(Number)); }
  if (type === 'shot') conds.push(`taken_at != ''`);
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  return db.all(`SELECT ${col} AS d, COUNT(*) AS n FROM lib_photos ${where} GROUP BY d ORDER BY d DESC`, args);
}

// 各分类照片数（空串=未分类，对外统一按「其他」统计），供筛选条 chip 显示
function libCatCounts(rootIds = null) {
  const conds = []; const args = [];
  if (Array.isArray(rootIds) && !rootIds.length) return {};
  if (rootIds && rootIds.length) { conds.push(`root_id IN (${rootIds.map(() => '?').join(',')})`); args.push(...rootIds.map(Number)); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const out = {};
  for (const r of db.all(`SELECT category, COUNT(*) AS n FROM lib_photos ${where} GROUP BY category`, args)) {
    const k = (!r.category || r.category === '其他') ? '其他' : r.category;
    out[k] = (out[k] || 0) + Number(r.n);
  }
  return out;
}
function libSetCategory(ids, cat) {
  const list = (ids || []).map(Number).filter(Boolean);
  if (!list.length) return 0;
  const ph = list.map(() => '?').join(',');
  // 关键：同时把 ai_conf 归 -1（人工决策标记）。否则「AI 先标过(ai_conf>=0) → 人工改类」的照片
  // 一旦跑「按新词表重分类」会被 AI 覆盖回原类，用户的手动修改被静默吃掉。
  // 列不存在时（没装 AI 包）退回只改分类，保证旧环境仍可用
  let r;
  try {
    r = db.run(`UPDATE lib_photos SET category = ?, ai_conf = -1 WHERE id IN (${ph})`, [cat === '其他' ? '' : cat, ...list]);
  } catch {
    r = db.run(`UPDATE lib_photos SET category = ? WHERE id IN (${ph})`, [cat === '其他' ? '' : cat, ...list]);
  }
  return Number(r.changes);
}

/* ---------------- 手机照片备份（设备配对 + 增量落盘 + 单设备入库） ----------------
   设备目录建在照片墙已有根目录内（如 照片根/爸爸手机/）：
   - 网页一键备份经 HMP 写入此目录；
   - iPhone「文件」App / 安卓 FolderSync 经 NAS 的 WebDAV 直达同一目录；
   - 相册按设备名自动分组，多设备天然隔离。 */
function backupBase() {
  const roots = libListRoots();
  return (roots && roots.length) ? roots[0].path : path.join(paths.dirs.root(), 'phone-backups');
}
function backupDevices() {
  return db.all(`SELECT * FROM backup_devices ORDER BY id`);
}
function backupPair(name) {
  name = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 24);
  if (!name) throw new Error('设备名不能为空');
  const old = db.get(`SELECT * FROM backup_devices WHERE name = ?`, [name]);
  if (old) { try { fs.mkdirSync(old.dir, { recursive: true }); } catch { /* ignore */ } return old; }
  const base = backupBase();
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  // 基目录必须是照片墙根目录（数据目录兜底场景自动挂上）
  let rootId = 0;
  const rrow = db.get(`SELECT id FROM photo_roots WHERE path = ?`, [path.resolve(base)]);
  if (rrow) rootId = rrow.id;
  else { try { rootId = libAddRoot(base, '手机备份'); } catch { rootId = 0; } }
  const info = db.run(`INSERT INTO backup_devices (name, dir, root_id, created_at, last_backup_at) VALUES (?,?,?,?,0)`,
    [name, dir, rootId, Date.now()]);
  return db.get(`SELECT * FROM backup_devices WHERE id = ?`, [Number(info.lastInsertRowid)]);
}
function backupManifest(id) {
  const dev = db.get(`SELECT * FROM backup_devices WHERE id = ?`, [Number(id)]);
  if (!dev) throw new Error('设备未配对');
  const items = [];
  let names; try { names = fs.readdirSync(dev.dir); } catch { names = []; }
  for (const n of names) {
    let st; try { st = fs.statSync(path.join(dev.dir, n)); } catch { continue; }
    if (st.isFile()) items.push({ name: n, size: st.size });
  }
  return { device: { id: dev.id, name: dev.name, dir: dev.dir, last_backup_at: dev.last_backup_at }, items };
}
// 增量落盘：同名同大小=已备份跳过；同名不同大小加 (n) 序号；魔数甄选与上传一致
async function backupSave(deviceId, files) {
  const dev = db.get(`SELECT * FROM backup_devices WHERE id = ?`, [Number(deviceId)]);
  if (!dev) throw new Error('设备未配对');
  fs.mkdirSync(dev.dir, { recursive: true });
  let saved = 0, skipped = 0;
  for (const f of files) {
    const sniffed = sniffImage(f.data);
    const rawOk = rawjs.isRawExt(path.extname(f.filename || '').toLowerCase()) && rawjs.sniffRaw(f.data.subarray(0, 64));
    const ext = safeExt(f.filename, sniffed) || (rawOk ? path.extname(f.filename).toLowerCase() : null);
    if ((!sniffed && !rawOk) || !ext) { skipped += 1; continue; }
    if (f.data.length < 20 * 1024 && sniffed !== 'gif') { skipped += 1; continue; }
    if (NOISE_RE.test(path.basename(f.filename || ''))) { skipped += 1; continue; }
    const base = path.basename(f.filename || 'photo', path.extname(f.filename || '')).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'photo';
    let cand = path.join(dev.dir, base + ext);
    let hit = false;
    for (let i = 1; fs.existsSync(cand); i++) {
      try { if (fs.statSync(cand).size === f.data.length) { hit = true; break; } } catch { break; }
      cand = path.join(dev.dir, `${base}(${i})${ext}`);
    }
    if (hit) { skipped += 1; continue; }
    try { await fsp.writeFile(cand, f.data); saved += 1; } catch { skipped += 1; }
  }
  return { saved, skipped };
}
// 单设备目录入库（只扫设备目录，不动其它相册）；相册名=设备名
async function backupIngest(deviceId) {
  const dev = db.get(`SELECT * FROM backup_devices WHERE id = ?`, [Number(deviceId)]);
  if (!dev || !dev.root_id) throw new Error('设备未配对');
  const found = [];
  walkImages(dev.root_id, dev.dir, dev.dir, found);
  let added = 0, skipped = 0;
  for (const f of found) {
    let ok = false;
    try {
      const fd = fs.openSync(f.path, 'r');
      const b = Buffer.alloc(64);
      fs.readSync(fd, b, 0, 64, 0); fs.closeSync(fd);
      ok = rawjs.isRawExt(f.ext) ? !!rawjs.sniffRaw(b) : !!sniffImage(b);
    } catch { ok = false; }
    if (!ok) { skipped += 1; continue; }
    const probe = probeImage(f.path, f.name, f.ext);
    const r = db.run(
      `INSERT OR IGNORE INTO lib_photos (root_id, path, dir, name, album, ext, mime, size, mtime, w, h, taken_at, category,
         make, model, lens, software, orient, fnum, exposure, iso, focal, focal35, exp_bias, flash, gps_lat, gps_lon, gps_alt, exif_done)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
      [dev.root_id, f.path, f.dir, f.name, dev.name, f.ext, mimeOf(f.ext), f.size, f.mtime,
       probe.w, probe.h, probe.taken_at, probe.category].concat(exifArgs(probe)));
    if (Number(r.changes) > 0) added += 1;
    if (added % 25 === 0) await YIELD();
  }
  db.run(`UPDATE backup_devices SET last_backup_at = ? WHERE id = ?`, [Date.now(), dev.id]);
  return { added, skipped, total: found.length };
}

/* ---------------- 用户自定义相簿（新建相簿） ---------------- */
function albCreate(name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('相簿名不能为空');
  const old = db.get(`SELECT id FROM photo_albums WHERE name = ?`, [n]);
  if (old) throw new Error('已存在同名相簿');
  const info = db.run(`INSERT INTO photo_albums (name, created_at) VALUES (?,?)`, [n, new Date().toISOString()]);
  return Number(info.lastInsertRowid);
}
function albList() {
  return db.all(`SELECT a.id, a.name, a.created_at, COUNT(i.photo_id) AS count,
      (SELECT photo_id FROM photo_album_items WHERE album_id = a.id ORDER BY rowid DESC LIMIT 1) AS last_photo
    FROM photo_albums a LEFT JOIN photo_album_items i ON i.album_id = a.id
    GROUP BY a.id ORDER BY a.created_at DESC`).map((a) => ({ ...a, cover_id: a.last_photo || 0 }));
}
function albGet(id) { return db.get(`SELECT * FROM photo_albums WHERE id = ?`, [Number(id)]); }
function albItems(id) {
  return db.all(`SELECT p.id, p.root_id, p.album, p.name, p.w, p.h, p.taken_at, p.category, p.mtime
    FROM photo_album_items i JOIN lib_photos p ON p.id = i.photo_id
    WHERE i.album_id = ? ORDER BY i.rowid DESC`, [Number(id)]);
}
function albAdd(id, photoIds) {
  let n = 0;
  for (const pid of (photoIds || []).map(Number).filter(Boolean)) {
    try { db.run(`INSERT OR IGNORE INTO photo_album_items (album_id, photo_id) VALUES (?,?)`, [Number(id), pid]); n += 1; } catch { /* dup */ }
  }
  return n;
}
function albRemoveItems(id, photoIds) {
  let n = 0;
  for (const pid of (photoIds || []).map(Number).filter(Boolean)) {
    db.run(`DELETE FROM photo_album_items WHERE album_id = ? AND photo_id = ?`, [Number(id), pid]); n += 1;
  }
  return n;
}
function albDelete(id) {
  db.run(`DELETE FROM photo_album_items WHERE album_id = ?`, [Number(id)]);
  db.run(`DELETE FROM photo_albums WHERE id = ?`, [Number(id)]);
  return true;
}

/* ---------------- 重新识别（重算相册归属 + 按需重探宽高/拍摄时间/分类） ----------------
   相册 = 相对照片根的子目录（目录移动/改名后纠偏），这一步零成本必算；
   探测（EXIF 等）只在信息缺失或文件变动时才跑，重跑秒级。
   不动手工相册（photo_albums），不删任何文件。 */
async function libReidentify({ onEvent = () => {} } = {}) {
  const rows = db.all(`SELECT * FROM lib_photos`);
  const roots = new Map(libListRoots().map((r) => [r.id, r]));
  let updated = 0, missing = 0, done = 0;
  for (const r of rows) {
    const root = roots.get(r.root_id);
    if (!root || !fs.existsSync(r.path)) { missing++; continue; }
    let st; try { st = fs.statSync(r.path); } catch { missing++; continue; }
    const relDir = path.dirname(path.relative(root.path, r.path));
    const album = (relDir === '.' || relDir === '' || relDir.includes('..'))
      ? (root.label || path.basename(root.path)) : relDir.replace(/\\/g, '/');
    const metaMoved = st.size !== r.size || st.mtimeMs !== r.mtime;
    // exif_done=1 表示已完整探测过：无 EXIF 的图（截图/微信图）taken_at 恒为空，不算缺失
    const infoMissing = r.exif_done !== 1;
    const albumChanged = album !== r.album;
    if (!metaMoved && !infoMissing && !albumChanged) {
      if (++done % 200 === 0) await YIELD();
      continue; // 快路径：文件没动、信息齐全、相册没变
    }
    const probe = (metaMoved || infoMissing) ? probeImage(r.path, r.name, (r.ext || '').toLowerCase())
      : { w: r.w, h: r.h, taken_at: r.taken_at || '', category: r.category || '' };
    const probed = metaMoved || infoMissing;
    if (probed) {
      db.run(`UPDATE lib_photos SET album=?, size=?, mtime=?, w=?, h=?, taken_at=?, category=?,
        make=?, model=?, lens=?, software=?, orient=?, fnum=?, exposure=?, iso=?, focal=?, focal35=?,
        exp_bias=?, flash=?, gps_lat=?, gps_lon=?, gps_alt=?, exif_done=1 WHERE id=?`,
        [album, st.size, st.mtimeMs, probe.w, probe.h, probe.taken_at || '', probe.category || ''].concat(exifArgs(probe), [r.id]));
    } else {
      db.run(`UPDATE lib_photos SET album=?, size=?, mtime=? WHERE id=?`, [album, st.size, st.mtimeMs, r.id]);
    }
    updated++;
    if (++done % 25 === 0) { onEvent(`已重识别 ${done}/${rows.length} 张…`); await YIELD(); }
  }
  return { total: rows.length, updated, missing };
}

module.exports = { init, parseMultipart, saveUpload, sniffImage, listPhotos, getPhoto, absOf, thumbAbs, removePhoto, stats, makeThumb,
  libInit, libListRoots, libAddRoot, libRemoveRoot, libSuggestRoots, libScanAll, libAlbums, libList, libGet, libAbs, libThumb, libFull, libStats, libRemovePhoto, libRemovePhotos, libCleanEmptyDirs,
  libThumbServe, libFullServe, libWarmThumbs, libWarmStatus,
  backupDevices, backupPair, backupManifest, backupSave, backupIngest,
  libEnrich, libEnrichExif, libReprobeRaw, libRawThumbs, libInfo, libPlace, libListAll, libDates, libCatCounts, libSetCategory, albCreate, albList, albGet, albItems, albAdd, albRemoveItems, albDelete, libReidentify };
