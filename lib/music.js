'use strict';
// 扫描让步：每个批次让出事件循环，扫描期间 HTTP/页面不卡
const YIELD = () => new Promise((r) => setImmediate(r));

// 音乐中心：独立音乐目录扫描 + 零依赖元数据解析（ID3v2/v1、FLAC、m4a）+ 封面提取 + Range 音频流
// 甄选机制与相册同款：扩展名白名单 + 文件头魔数嗅探 + 噪音排除
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const db = require('./db');
const bins = require('./binaries');
const paths = require('./paths');

/* ---------------- 目录 ---------------- */
const coverRoot = () => path.join(paths.dirs.cache(), 'music-covers');
const artistRoot = () => path.join(paths.dirs.cache(), 'music-artists');
function ensureDirs() { fs.mkdirSync(coverRoot(), { recursive: true }); fs.mkdirSync(artistRoot(), { recursive: true }); }

/* ---------------- 甄选 ---------------- */
const EXT_OK = new Set(['.mp3', '.flac', '.m4a', '.wav', '.ogg', '.oga', '.aac', '.opus']);
const MIN_SIZE = 300 * 1024; // <300KB 的多半是铃声/试听片段，不入库

// 文件头嗅探：扩展名说自己是音频、内容不是的，拒收
function sniffAudio(buf, ext) {
  if (!buf || buf.length < 12) return false;
  if (buf.subarray(0, 3).toString('latin1') === 'ID3') return ext === '.mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true; // MPEG frame sync（mp3/aac）
  if (buf.subarray(0, 4).toString('latin1') === 'fLaC') return ext === '.flac';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return ext === '.m4a';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF') return ext === '.wav';
  if (buf.subarray(0, 4).toString('latin1') === 'OggS') return ext === '.ogg' || ext === '.oga' || ext === '.opus';
  // ADTS AAC: FF Fx
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return ext === '.aac';
  return false;
}

const NOISE_RE = /(^|[\\/])\.(?!well-known)|^(sample-|preview|demo|thumb|cover-?thumb|\.)/i;

/* ---------------- 文本解码（ID3 编码字节 → 字符串，中文 GBK 兜底） ---------------- */
function decodeText(bytes, enc) {
  try {
    if (enc === 1) return new TextDecoder('utf-16le').decode(bytes).replace(/\0+$/, '');
    if (enc === 2) return new TextDecoder('utf-16be').decode(bytes).replace(/\0+$/, '');
    if (enc === 3) return new TextDecoder('utf-8').decode(bytes).replace(/\0+$/, '');
    // enc=0 latin1：含高位字节时按 GBK 解（国产歌曲标签常见）
    let hasHigh = false;
    for (const b of bytes) { if (b > 0x7f) { hasHigh = true; break; } }
    if (hasHigh) return new TextDecoder('gbk').decode(bytes).replace(/\0+$/, '');
    return bytes.toString('latin1').replace(/\0+$/, '');
  } catch { return bytes.toString('latin1').replace(/\0+$/, ''); }
}

/* ---------------- ID3v2 解析（mp3） ---------------- */
function parseId3v2(buf) {
  const out = {};
  let cover = null;
  if (buf.subarray(0, 3).toString('latin1') !== 'ID3') return null;
  const ver = buf[3];
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const end = Math.min(10 + size, buf.length);
  let pos = 10;
  const unsync = !!(buf[5] & 0x80);
  if (buf[5] & 0x40) { // 扩展头，跳过
    const esz = ver === 4
      ? ((buf[10] & 0x7f) << 21) | ((buf[11] & 0x7f) << 14) | ((buf[12] & 0x7f) << 7) | (buf[13] & 0x7f)
      : buf.readUInt32BE(10);
    pos += esz;
  }
  while (pos + 10 <= end) {
    const id = buf.subarray(pos, pos + 4).toString('latin1');
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    let fsize;
    if (ver === 4) fsize = ((buf[pos + 4] & 0x7f) << 21) | ((buf[pos + 5] & 0x7f) << 14) | ((buf[pos + 6] & 0x7f) << 7) | (buf[pos + 7] & 0x7f);
    else fsize = buf.readUInt32BE(pos + 4);
    if (fsize <= 0 || pos + 10 + fsize > end) break;
    const body = buf.subarray(pos + 10, pos + 10 + fsize);
    pos += 10 + fsize;
    try {
      if (id === 'TIT2' || id === 'TT2') out.title = decodeText(body.subarray(1), body[0]);
      else if (id === 'TPE1' || id === 'TP1') out.artist = decodeText(body.subarray(1), body[0]);
      else if (id === 'TALB' || id === 'TAL') out.album = decodeText(body.subarray(1), body[0]);
      else if (id === 'TPE2' || id === 'TP2') out.albumartist = decodeText(body.subarray(1), body[0]);
      else if (id === 'TRCK' || id === 'TRK') out.track_no = parseInt(decodeText(body.subarray(1), body[0]), 10) || null;
      else if (id === 'TYER' || id === 'TDRC' || id === 'TYE') out.year = parseInt(decodeText(body.subarray(1), body[0]).slice(0, 4), 10) || null;
      else if (id === 'TCON' || id === 'TCO') out.genre = decodeText(body.subarray(1), body[0]);
      else if ((id === 'APIC' || id === 'PIC') && !cover) {
        if (id === 'APIC') {
          const enc = body[0];
          const mimeEnd = body.indexOf(0, 1);
          const mime = body.subarray(1, mimeEnd).toString('latin1').toLowerCase();
          let p = mimeEnd + 2; // 跳过 picture type + description 终止符（忽略描述）
          if (enc === 1 || enc === 2) { // 描述是 UTF-16，要找双零终止
            while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2;
            p += 2;
          } else {
            p = body.indexOf(0, mimeEnd + 2) + 1;
          }
          if (p > mimeEnd + 2 && p < body.length) cover = { mime, data: body.subarray(p) };
        } else { // v2.2 PIC：enc(1) format(3) type(1) desc(term) data
          const fmt = body.subarray(1, 4).toString('latin1').toLowerCase();
          const mime = fmt === 'jpg' ? 'image/jpeg' : 'image/png';
          const p = body.indexOf(0, 5) + 1;
          if (p > 5 && p < body.length) cover = { mime, data: body.subarray(p) };
        }
      }
    } catch { /* 单帧坏不致整体失败 */ }
  }
  if (unsync) { /* 罕见，封面可能坏，交给嗅探兜底 */ }
  out.cover = cover;
  return out;
}

function parseId3v1(buf) {
  if (buf.length < 128) return null;
  const tag = buf.subarray(buf.length - 128);
  if (tag.subarray(0, 3).toString('latin1') !== 'TAG') return null;
  // latin1；含高位字节时按 GBK 解（中文 ID3v1 标签常见）
  const s = (a, b) => {
    const bytes = tag.subarray(a, b);
    let hasHigh = false;
    for (const by of bytes) { if (by > 0x7f) { hasHigh = true; break; } }
    let txt;
    try { txt = hasHigh ? new TextDecoder('gbk').decode(bytes) : bytes.toString('latin1'); }
    catch { txt = bytes.toString('latin1'); }
    return txt.replace(/[\0 ]+$/g, '');
  };
  return {
    title: s(3, 33), artist: s(33, 63), album: s(63, 93), year: parseInt(s(93, 97), 10) || null,
    cover: null,
  };
}

/* ---------------- FLAC 解析 ---------------- */
function parseFlac(buf) {
  if (buf.subarray(0, 4).toString('latin1') !== 'fLaC') return null;
  const out = {}; let cover = null;
  let pos = 4;
  while (pos + 4 <= buf.length) {
    const head = buf[pos];
    const last = !!(head & 0x80);
    const type = head & 0x7f;
    const len = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    if (pos + 4 + len > buf.length) break;
    const body = buf.subarray(pos + 4, pos + 4 + len);
    if (type === 4) { // VORBIS_COMMENT
      try {
        let p = 0;
        const vlen = body.readUInt32LE(p); p += 4 + vlen;
        const count = body.readUInt32LE(p); p += 4;
        for (let i = 0; i < count && p + 4 <= body.length; i++) {
          const clen = body.readUInt32LE(p); p += 4;
          const kv = body.subarray(p, p + clen).toString('utf-8'); p += clen;
          const eq = kv.indexOf('=');
          if (eq <= 0) continue;
          const k = kv.slice(0, eq).toUpperCase(); const v = kv.slice(eq + 1);
          if (k === 'TITLE') out.title = v;
          else if (k === 'ARTIST') out.artist = out.artist || v;
          else if (k === 'ALBUM') out.album = v;
          else if (k === 'ALBUMARTIST') out.albumartist = v;
          else if (k === 'TRACKNUMBER') out.track_no = parseInt(v, 10) || null;
          else if (k === 'DATE' || k === 'YEAR') out.year = parseInt(v.slice(0, 4), 10) || null;
          else if (k === 'GENRE') out.genre = v;
        }
      } catch { /* ignore */ }
    } else if (type === 6 && !cover) { // PICTURE
      try {
        let p = 4;
        const mlen = body.readUInt32BE(p); p += 4;
        const mime = body.subarray(p, p + mlen).toString('latin1').toLowerCase(); p += mlen;
        const dlen = body.readUInt32BE(p); p += 4 + dlen + 16;
        const dlen2 = body.readUInt32BE(p); p += 4;
        if (dlen2 > 0 && p + dlen2 <= body.length) cover = { mime, data: body.subarray(p, p + dlen2) };
      } catch { /* ignore */ }
    }
    pos += 4 + len;
    if (last) break;
  }
  out.cover = cover;
  return out;
}

/* ---------------- m4a 解析（原子树遍历） ---------------- */
function parseM4a(buf) {
  if (buf.subarray(4, 8).toString('latin1') !== 'ftyp') return null;
  const out = {}; let cover = null;
  // 递归找 moov/udta/meta/ilst
  const wanted = ['moov', 'udta', 'meta', 'ilst'];
  let ilst = null;
  (function walk(start, end, depth, pathIds) {
    let pos = start;
    while (pos + 8 <= end && depth < 8) {
      let size = buf.readUInt32BE(pos);
      const type = buf.subarray(pos + 4, pos + 8).toString('latin1');
      let headSize = 8;
      if (size === 1) { size = Number(buf.readBigUInt64BE(pos + 8)); headSize = 16; }
      if (size < headSize || pos + size > end) break;
      const here = pathIds.concat(type);
      if (type === 'meta') { walk(pos + headSize + 4, pos + size, depth + 1, here); }
      else if (wanted.includes(type)) { walk(pos + headSize, pos + size, depth + 1, here); }
      else if (type === 'ilst') { ilst = [pos + headSize, pos + size]; return; }
      pos += size;
    }
  })(0, buf.length, 0, []);
  if (!ilst) { out.cover = null; return out; }
  let pos = ilst[0];
  while (pos + 8 <= ilst[1]) {
    const size = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('latin1');
    if (size < 8 || pos + size > ilst[1]) break;
    const body = buf.subarray(pos + 8, pos + size);
    try {
      // 子原子结构：[size(4)]['data'(4)][ver/flags(4)][locale(4)][payload]，
      // 有的还夹一层中间原子，所以直接找第一个 'data'
      const di = body.indexOf(Buffer.from('data', 'latin1'));
      if (di !== -1 && di + 16 <= body.length) {
        const payload = body.subarray(di + 8 + 8);
        if (type === '\u00a9nam') out.title = payload.toString('utf-8');
        else if (type === '\u00a9ART') out.artist = payload.toString('utf-8');
        else if (type === '\u00a9alb') out.album = payload.toString('utf-8');
        else if (type === 'aART') out.albumartist = payload.toString('utf-8');
        else if (type === '\u00a9day') out.year = parseInt(payload.toString('utf-8').slice(0, 4), 10) || null;
        else if (type === '\u00a9gen') out.genre = payload.toString('utf-8');
        else if (type === 'trkn') out.track_no = payload.length >= 4 ? payload.readUInt16BE(2) : null;
        else if (type === 'covr' && !cover) {
          const mime = payload[0] === 0x89 ? 'image/png' : 'image/jpeg';
          cover = { mime, data: payload };
        }
      }
    } catch { /* ignore */ }
    pos += size;
  }
  out.cover = cover;
  return out;
}

function parseMeta(buf, ext) {
  let m = null;
  if (ext === '.mp3') m = parseId3v2(buf) || parseId3v1(buf);
  else if (ext === '.flac') m = parseFlac(buf);
  else if (ext === '.m4a') m = parseM4a(buf);
  return m || {};
}

/* ---------------- 封面落盘 ---------------- */
function saveCover(trackPath, cover) {
  if (!cover || !cover.data || cover.data.length < 100) return null;
  const sniff = cover.data[0] === 0x89 ? 'png' : (cover.data[0] === 0xff && cover.data[1] === 0xd8) ? 'jpg' : null;
  if (!sniff) return null;
  const hash = crypto.createHash('sha1').update(trackPath).digest('hex').slice(0, 16);
  const file = path.join(coverRoot(), hash + '.' + sniff);
  try {
    fs.writeFileSync(file, cover.data);
    return file;
  } catch { return null; }
}

// 目录侧封面：cover.jpg / folder.jpg / album.jpg
function findDirCover(dir) {
  for (const n of ['cover.jpg', 'folder.jpg', 'album.jpg', 'front.jpg', 'cover.png']) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/* ---------------- ffprobe 时长（可选，失败不阻塞） ---------------- */
function probeDuration(abs) {
  return new Promise((resolve) => {
    const ff = bins.status().ffprobe;
    if (!ff) return resolve(null);
    execFile(ff, ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', abs], { timeout: 8000, windowsHide: true, maxBuffer: 1 << 20 },
      (err, so) => {
        const d = err ? NaN : parseFloat(String(so).trim());
        resolve(Number.isFinite(d) && d > 0 ? Math.round(d) : null);
      });
  });
}

/* ---------------- SQLite ---------------- */
function init() {
  ensureDirs();
  db.run(`CREATE TABLE IF NOT EXISTS music_roots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_scan_at INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS music_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id INTEGER NOT NULL,
    path TEXT NOT NULL UNIQUE,
    dir TEXT NOT NULL,
    file_name TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    mtime INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL DEFAULT '',
    album TEXT NOT NULL DEFAULT '',
    albumartist TEXT NOT NULL DEFAULT '',
    track_no INTEGER,
    year INTEGER,
    genre TEXT DEFAULT '',
    duration INTEGER,
    cover_file TEXT DEFAULT '',
    cover_dir TEXT DEFAULT '',
    last_seen_at INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_music_album ON music_tracks(album, track_no)`);
  // 重新识别标记：已用当前解析逻辑识别过且文件未变 → 跳过重读（NAS 磁盘随机读慢）
  try { db.run(`ALTER TABLE music_tracks ADD COLUMN reid_at INTEGER DEFAULT 0`); } catch { /* 列已存在 */ }
  db.run(`CREATE INDEX IF NOT EXISTS idx_music_root ON music_tracks(root_id)`);
  db.run(`CREATE TABLE IF NOT EXISTS music_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    track_id INTEGER, position REAL DEFAULT 0, updated_at INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS music_play_stats (
    track_id INTEGER PRIMARY KEY,
    plays INTEGER NOT NULL DEFAULT 0,
    last_played_at INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS music_likes (
    track_id INTEGER PRIMARY KEY,
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS music_playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS music_playlist_items (
    playlist_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id)
  )`);

  // 一次性回填：老库里「未知歌手」的行用文件名解析补歌手/标题（设置标记只跑一次）
  if (db.getSetting('music_artist_backfill', '') !== 'v3') {
    const rows = db.all(`SELECT id, file_name, title FROM music_tracks WHERE artist = '未知歌手'`);
    let n = 0;
    for (const t of rows) {
      const ext2 = path.extname(t.file_name).toLowerCase();
      const base = path.basename(t.file_name, ext2).replace(/^\d+[\s.\-_]+/, '');
      const p = parseNameArtist(base);
      if (!p.artist) continue;
      // 标题原本就是文件名兜底的才一并修正；标签带来的标题不动
      db.run(`UPDATE music_tracks SET artist = ?, title = CASE WHEN title = ? THEN ? ELSE title END WHERE id = ?`,
        [p.artist, base, p.title, t.id]);
      n++;
    }
    db.setSetting('music_artist_backfill', 'v3');
    if (n) console.log(`[music] 文件名解析回填歌手：${n}/${rows.length} 行`);
  }
}

/* ---------------- 文件名兜底解析 ---------------- */
// 「歌手-歌名」「歌手 - 歌名」（标签缺失时用；左侧纯数字视为序号，忽略）
function parseNameArtist(base) {
  const m = /^(.{1,60}?)\s+[-–—]\s+(.{1,120})$/.exec(base) || /^(.{1,60}?)[-–—](.{1,120})$/.exec(base);
  if (!m) return {};
  const artist = m[1].trim(), title = m[2].trim();
  if (!artist || !title || /^\d+$/.test(artist)) return {};
  return { artist, title };
}

/* ---------------- 扫描 ---------------- */
async function scanAll({ onEvent = () => {} } = {}) {
  const roots = db.all(`SELECT * FROM music_roots WHERE enabled = 1`);
  let added = 0, removed = 0, skipped = 0, updated = 0;
  let since = 0;
  const seen = new Set();
  for (const root of roots) {
    if (!fs.existsSync(root.path)) continue;
    onEvent(`扫描音乐目录：${root.path}`);
    const stack = [root.path];
    while (stack.length) {
      await YIELD();
      const dir = stack.pop();
      let items;
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const it of items) {
        if (it.name.startsWith('.')) continue;
        if (NOISE_RE.test(it.name)) continue;
        const full = path.join(dir, it.name);
        if (it.isDirectory()) {
          if (it.name === '@eaDir' || it.name === '#recycle' || it.name === '$RECYCLE.BIN') continue;
          stack.push(full);
          continue;
        }
        const ext = path.extname(it.name).toLowerCase();
        if (!EXT_OK.has(ext)) continue;
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.size < MIN_SIZE) { skipped++; continue; }
        if (++since >= 25) { since = 0; await YIELD(); }
        seen.add(full);
        const exist = db.get(`SELECT id, mtime, size, cover_file FROM music_tracks WHERE path = ?`, [full]);
        if (exist && exist.mtime === st.mtimeMs && exist.size === st.size) continue; // 未变，跳过
        // 读头 10MB 足够拿到标签与封面
        let head;
        try {
          const fd = fs.openSync(full, 'r');
          head = Buffer.alloc(Math.min(10 * 1024 * 1024, st.size));
          fs.readSync(fd, head, 0, head.length, 0);
          fs.closeSync(fd);
        } catch { continue; }
        if (!sniffAudio(head, ext)) { skipped++; onEvent(`[甄选拒收] 内容与音频格式不符：${it.name}`); continue; }
        const meta = parseMeta(head, ext);
        const cover_file = saveCover(full, meta.cover) || (exist && exist.cover_file) || '';
        const dirCover = cover_file ? '' : (findDirCover(dir) || '');
        const base = path.basename(it.name, ext).replace(/^\d+[\s.\-_]+/, '');
        const nameParsed = parseNameArtist(base); // 标签缺失时用文件名「歌手-歌名」兜底
        const rec = {
          title: meta.title || nameParsed.title || base,
          artist: meta.artist || meta.albumartist || nameParsed.artist || '未知歌手',
          album: meta.album || path.basename(dir) || '单曲',
          albumartist: meta.albumartist || '',
          track_no: meta.track_no || null,
          year: meta.year || null,
          genre: meta.genre || '',
          cover_file, cover_dir: dirCover,
        };
        if (exist) {
          db.run(`UPDATE music_tracks SET size=?, mtime=?, title=?, artist=?, album=?, albumartist=?, track_no=?, year=?, genre=?, cover_file=?, cover_dir=? WHERE id=?`,
            [st.size, st.mtimeMs, rec.title, rec.artist, rec.album, rec.albumartist, rec.track_no, rec.year, rec.genre, rec.cover_file, rec.cover_dir, exist.id]);
          updated++;
        } else {
          db.run(`INSERT INTO music_tracks (root_id, path, dir, file_name, ext, size, mtime, title, artist, album, albumartist, track_no, year, genre, duration, cover_file, cover_dir, last_seen_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`,
            [root.id, full, dir, it.name, ext, st.size, st.mtimeMs, rec.title, rec.artist, rec.album, rec.albumartist, rec.track_no, rec.year, rec.genre, rec.cover_file, rec.cover_dir, Date.now()]);
          added++;
          if (added % 20 === 0) onEvent(`已入库 ${added} 首…`);
        }
      }
    }
    db.run(`UPDATE music_roots SET last_scan_at = ? WHERE id = ?`, [Date.now(), root.id]);
  }
  // 清理已消失的
  for (const t of db.all(`SELECT id, path FROM music_tracks`)) {
    if (!seen.has(t.path) && !fs.existsSync(t.path)) {
      db.run(`DELETE FROM music_tracks WHERE id = ?`, [t.id]);
      removed++;
    }
  }
  return { added, updated, removed, skipped, total: db.get(`SELECT COUNT(*) c FROM music_tracks`).c };
}

/* ---------------- 查询 ---------------- */
const trackOut = (t) => ({
  id: t.id, root_id: t.root_id, title: t.title, artist: t.artist, album: t.album,
  trackNo: t.track_no, year: t.year, genre: t.genre, duration: t.duration,
  cover: t.cover_file || t.cover_dir ? 1 : 0, // 有真图与否（前端据此显示占位）
});

function listTracks() {
  return db.all(`SELECT * FROM music_tracks ORDER BY album COLLATE NOCASE, track_no, title COLLATE NOCASE`).map(trackOut);
}

function listAlbums() {
  const rows = db.all(`SELECT album,
      MIN(CASE WHEN cover_file != '' THEN cover_file WHEN cover_dir != '' THEN cover_dir ELSE '' END) cover,
      COUNT(*) cnt, MAX(year) year, MIN(id) first_id
    FROM music_tracks GROUP BY album COLLATE NOCASE ORDER BY album COLLATE NOCASE`);
  return rows.map((r) => ({ album: r.album, cnt: r.cnt, year: r.year, cover: r.cover || '', firstId: r.first_id }));
}

function albumTracks(album) {
  return db.all(`SELECT * FROM music_tracks WHERE album = ? COLLATE NOCASE ORDER BY track_no, title COLLATE NOCASE`, [album]).map(trackOut);
}

/* ---------------- 歌手/专辑改名（侧边栏 ✎） ----------------
   直接更新曲目表的 artist/album 字段：侧边栏分组、专辑页、歌手页全部自然跟随。
   注意：同名合并（大小写不敏感）；日后文件变动重扫时标签值会回来，再改一次即可。 */
function renameGroup(kind, from, to) {
  from = String(from || '').trim();
  to = String(to || '').trim().slice(0, 120);
  if (kind !== 'artist' && kind !== 'album') throw new Error('类型不支持');
  if (!from) throw new Error('原名称不能为空');
  if (!to) throw new Error('新名称不能为空');
  if (from.toLowerCase() === to.toLowerCase()) throw new Error('新名称与原名称相同');
  const col = kind === 'artist' ? 'artist' : 'album';
  const r = db.run(`UPDATE music_tracks SET ${col} = ? WHERE ${col} = ? COLLATE NOCASE`, [to, from]);
  return { changed: Number(r && r.changes) || 0 };
}

/* ---------------- 状态（续播） ---------------- */
function getState() {
  const s = db.get(`SELECT * FROM music_state WHERE id = 1`);
  if (!s) return null;
  const t = db.get(`SELECT * FROM music_tracks WHERE id = ?`, [s.track_id]);
  return t ? { track: trackOut(t), position: s.position, updatedAt: s.updated_at } : null;
}
function saveState(trackId, position) {
  db.run(`INSERT INTO music_state (id, track_id, position, updated_at) VALUES (1, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET track_id = ?, position = ?, updated_at = ?`,
    [trackId, position, Date.now(), trackId, position, Date.now()]);
}

/* ---------------- 目录管理 ---------------- */
function listRoots() {
  return db.all(`SELECT r.*, (SELECT COUNT(*) FROM music_tracks WHERE root_id = r.id) tracks FROM music_roots r ORDER BY id`).map((r) => ({
    id: r.id, path: r.path, label: r.label, tracks: r.tracks, lastScanAt: r.last_scan_at,
  }));
}
function addRoot(p, label) {
  p = String(p || '').trim();
  if (!p) throw new Error('目录不能为空');
  if (!fs.existsSync(p)) throw new Error('目录不存在：' + p);
  const st = fs.statSync(p);
  if (!st.isDirectory()) throw new Error('不是目录：' + p);
  db.run(`INSERT OR IGNORE INTO music_roots (path, label) VALUES (?, ?)`, [p, label || path.basename(p)]);
  db.run(`UPDATE music_roots SET label = ? WHERE path = ?`, [label || path.basename(p), p]);
  return db.get(`SELECT id FROM music_roots WHERE path = ?`, [p]).id;
}
function removeRoot(id) {
  db.run(`DELETE FROM music_tracks WHERE root_id = ?`, [id]);
  db.run(`DELETE FROM music_roots WHERE id = ?`, [id]);
}

function trackAbs(id) {
  const t = db.get(`SELECT path FROM music_tracks WHERE id = ?`, [id]);
  return t ? t.path : null;
}

/* ---------------- 占位封面黑名单（es） ----------------
   发行商/平台会把同一张默认图嵌进大量文件：博纳灰唱片（MP3 内嵌）、网易云默认歌手 img1v1。
   命中黑名单 = 「没有真图」，调用方跳过该层兜底继续往下走（最终落字牌）。 */
const PLACEHOLDER_MD5 = new Set([
  '4169ea48352006297ff46d3f0f16fece', // 博纳正版授权 灰唱片·原图（32 张内嵌/缓存命中）
  '89a823c2e3f9b43110af00ae7df645f0', // 博纳正版授权 灰唱片·200px 缩略
  'd7b7204fba0b9dc5d94b8c31e68ece75', // 网易云默认歌手 img1v1
]);
function isPlaceholderImg(fp) {
  try { return PLACEHOLDER_MD5.has(crypto.createHash('md5').update(fs.readFileSync(fp)).digest('hex')); }
  catch (e) { return false; }
}

/* ---------------- 歌手海报（本地缓存 + 网易云公开搜索） ---------------- */
function artistCachePath(name) {
  const safe = String(name).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 80) || 'na';
  return path.join(artistRoot(), safe + '.jpg');
}
function artistImgCached(name) {
  try {
    const p = artistCachePath(name);
    return fs.existsSync(p) && fs.statSync(p).size > 1000 ? p : null;
  } catch (e) { return null; }
}
function httpGetBuf(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? require('node:https') : require('node:http');
    const req = mod.get(url, { headers: Object.assign({ 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com' }, headers || {}), timeout: 6000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}
async function artistImgFetch(name) {
  const api = 'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(name) + '&type=100&offset=0&limit=1';
  const buf = await httpGetBuf(api);
  let j = null;
  try { j = JSON.parse(buf.toString('utf8')); } catch (e) { return null; }
  const a0 = j && j.result && j.result.artists && j.result.artists[0];
  const img = a0 && (a0.img1v1Url || a0.picUrl);
  if (!img) return null;
  const data = await httpGetBuf(String(img).replace(/^http:/, 'https:'));
  if (data.length < 1000) return null;
  // es：网易云对无头像歌手返回默认占位图——拒存，让上层 404 → 前端回退封面链
  try { if (PLACEHOLDER_MD5.has(crypto.createHash('md5').update(data).digest('hex'))) return null; } catch (e) {}
  fs.mkdirSync(artistRoot(), { recursive: true });
  const p = artistCachePath(name);
  fs.writeFileSync(p, data);
  return p;
}

/* ---------------- 播放统计 / 我喜欢 / 歌单 / 歌词 ---------------- */
function addPlay(id) {
  const now = Date.now();
  db.run(`INSERT INTO music_play_stats (track_id, plays, last_played_at) VALUES (?, 1, ?)
          ON CONFLICT(track_id) DO UPDATE SET plays = plays + 1, last_played_at = ?`, [id, now, now]);
}
function getStats() {
  const plays = {};
  for (const r of db.all(`SELECT track_id, plays FROM music_play_stats`)) plays[r.track_id] = r.plays;
  const likes = db.all(`SELECT track_id FROM music_likes ORDER BY created_at DESC`).map((r) => r.track_id);
  return { plays, likes };
}
function topTracks(limit) {
  return db.all(`SELECT t.* FROM music_play_stats s JOIN music_tracks t ON t.id = s.track_id
    ORDER BY s.plays DESC, s.last_played_at DESC LIMIT ?`, [limit || 10]).map(trackOut);
}
function likeTracks() {
  return db.all(`SELECT t.* FROM music_likes l JOIN music_tracks t ON t.id = l.track_id
    ORDER BY l.created_at DESC`).map(trackOut);
}
function setLike(id, on) {
  if (on) db.run(`INSERT OR IGNORE INTO music_likes (track_id, created_at) VALUES (?, ?)`, [id, Date.now()]);
  else db.run(`DELETE FROM music_likes WHERE track_id = ?`, [id]);
}
function listPlaylists() {
  return db.all(`SELECT p.id, p.name, COUNT(i.track_id) cnt
    FROM music_playlists p LEFT JOIN music_playlist_items i ON i.playlist_id = p.id
    GROUP BY p.id ORDER BY p.created_at DESC`);
}
function createPlaylist(name) {
  name = String(name || '').trim().slice(0, 60);
  if (!name) throw new Error('歌单名不能为空');
  const r = db.run(`INSERT INTO music_playlists (name, created_at) VALUES (?, ?)`, [name, Date.now()]);
  return { id: Number(r.lastInsertRowid), name };
}
function deletePlaylist(id) {
  db.run(`DELETE FROM music_playlist_items WHERE playlist_id = ?`, [id]);
  db.run(`DELETE FROM music_playlists WHERE id = ?`, [id]);
}
function playlistTracks(id) {
  return db.all(`SELECT t.* FROM music_playlist_items i JOIN music_tracks t ON t.id = i.track_id
    WHERE i.playlist_id = ? ORDER BY i.added_at DESC`, [id]).map(trackOut);
}
function playlistAdd(id, trackId) {
  db.run(`INSERT OR IGNORE INTO music_playlist_items (playlist_id, track_id, added_at) VALUES (?, ?, ?)`, [id, trackId, Date.now()]);
}
function playlistRemove(id, trackId) {
  db.run(`DELETE FROM music_playlist_items WHERE playlist_id = ? AND track_id = ?`, [id, trackId]);
}
function findLyric(id) {
  const p = trackAbs(id);
  if (!p || !fs.existsSync(p)) return null;
  const dir = path.dirname(p);
  const base = path.basename(p, path.extname(p));
  for (const cand of [path.join(dir, base + '.lrc'), path.join(dir, base + '.LRC')]) {
    try { if (fs.existsSync(cand)) return fs.readFileSync(cand, 'utf8'); } catch (e) {}
  }
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.toLowerCase().endsWith('.lrc') && f.slice(0, -4) === base) {
        return fs.readFileSync(path.join(dir, f), 'utf8');
      }
    }
  } catch (e) {}
  return null;
}

/* ---------------- 歌词/专辑封面（本地缓存 + 网易云公开接口自动补全） ---------------- */
const lyricRoot = () => path.join(paths.dirs.cache(), 'music-lyrics');
function lyricCachePath(id) { return path.join(lyricRoot(), 't' + id + '.lrc'); }
function albCachePath(album, artist) {
  const safe = String((artist || '') + '-' + (album || '')).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 90) || 'na';
  return path.join(coverRoot(), 'alb-' + safe + '.jpg');
}
const inflightLyric = new Map();
const inflightAlb = new Map();

async function neteaseSongLyric(title, artist) {
  const clean = (s) => String(s || '')
    .replace(/[（(][^）)]*[）)]/g, ' ')   // 去括号补充（如「(青春版《红楼梦》推广曲)」）
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/^\s*-\s*/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const t = clean(title), a = clean(artist);
  const tries = [];
  if (a && t) tries.push(a + ' ' + t);
  if (t) tries.push(t);
  if (!tries.length) return null;
  for (const q of tries) {
    try {
      const sApi = 'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(q) + '&type=1&offset=0&limit=1';
      const buf = await httpGetBuf(sApi);
      const j = JSON.parse(buf.toString('utf8'));
      const sid = j && j.result && j.result.songs && j.result.songs[0] && j.result.songs[0].id;
      if (!sid) continue;
      const lBuf = await httpGetBuf('https://music.163.com/api/song/lyric?id=' + sid + '&lv=1&kv=1&tv=-1');
      const lj = JSON.parse(lBuf.toString('utf8'));
      const lrc = lj && lj.lrc && lj.lrc.lyric;
      if (lrc && String(lrc).trim()) return String(lrc);
    } catch (e) { /* 下一个尝试 */ }
  }
  return null;
}

async function lyricFor(id) {
  const local = findLyric(id);
  if (local) return local;
  try {
    const cp = lyricCachePath(id);
    if (fs.existsSync(cp) && fs.statSync(cp).size > 10) return fs.readFileSync(cp, 'utf8');
  } catch (e) {}
  if (inflightLyric.has(id)) return inflightLyric.get(id);
  const t = db.get(`SELECT title, artist FROM music_tracks WHERE id = ?`, [id]);
  if (!t) return null;
  const job = neteaseSongLyric(t.title, t.artist)
    .then((lrc) => {
      if (lrc) { try { fs.mkdirSync(lyricRoot(), { recursive: true }); fs.writeFileSync(lyricCachePath(id), lrc); } catch (e) {} }
      inflightLyric.delete(id);
      return lrc;
    })
    .catch(() => { inflightLyric.delete(id); return null; });
  inflightLyric.set(id, job);
  return job;
}

async function albumCoverFetch(album, artist) {
  if (!album || album === '单曲') return null;
  const cp = albCachePath(album, artist);
  const miss = cp + '.miss'; // 失败记忆：7 天内不再重复请求（本地自抓合集类专辑名搜不到，避免每次浏览都打 API）
  try { if (fs.existsSync(cp) && fs.statSync(cp).size > 1000) return cp; } catch (e) {}
  try { if (fs.existsSync(miss) && Date.now() - (Number(fs.readFileSync(miss, 'utf8')) || 0) < 7 * 86400e3) return null; } catch (e) {}
  const ck = (artist || '') + '|' + album;
  if (inflightAlb.has(ck)) return inflightAlb.get(ck);
  const q = [album, artist].filter(Boolean).join(' ').trim();
  const job = (async () => {
    try {
      const api = 'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(q) + '&type=10&offset=0&limit=1';
      const buf = await httpGetBuf(api);
      const j = JSON.parse(buf.toString('utf8'));
      const pic = j && j.result && j.result.albums && j.result.albums[0] && j.result.albums[0].picUrl;
      if (!pic) throw new Error('no-match');
      const data = await httpGetBuf(String(pic).replace(/^http:/, 'https:'));
      if (data.length < 1000) throw new Error('bad-img');
      fs.mkdirSync(coverRoot(), { recursive: true });
      fs.writeFileSync(cp, data);
      try { fs.rmSync(miss, { force: true }); } catch (e) {}
      return cp;
    } catch (e) {
      try { fs.mkdirSync(coverRoot(), { recursive: true }); fs.writeFileSync(miss, String(Date.now())); } catch (e2) {}
      return null;
    }
  })().then((r) => { inflightAlb.delete(ck); return r; });
  inflightAlb.set(ck, job);
  return job;
}

/* eq：歌曲级封面兜底——合集单曲的「专辑名」多是歌手拼接串，网易云按专辑搜不到；
   改按「歌名 歌手」搜歌（type=1），取命中歌曲的专辑图。缓存/失败记忆复用专辑图目录。 */
async function songCoverFetch(title, artist) {
  if (!title) return null;
  const safe = String((artist || '') + '-song-' + title).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 90) || 'na';
  const cp = path.join(coverRoot(), 'alb-' + safe + '.jpg');
  const miss = cp + '.miss';
  try { if (fs.existsSync(cp) && fs.statSync(cp).size > 1000) return cp; } catch (e) {}
  try { if (fs.existsSync(miss) && Date.now() - (Number(fs.readFileSync(miss, 'utf8')) || 0) < 7 * 86400e3) return null; } catch (e) {}
  const ck = 'song|' + safe;
  if (inflightAlb.has(ck)) return inflightAlb.get(ck);
  const q = [title, artist].filter(Boolean).join(' ').trim();
  const job = (async () => {
    try {
      const api = 'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(q) + '&type=1&offset=0&limit=1';
      const buf = await httpGetBuf(api);
      const j = JSON.parse(buf.toString('utf8'));
      const s0 = j && j.result && j.result.songs && j.result.songs[0];
      const pic = s0 && s0.album && (s0.album.picUrl || s0.album.blurPicUrl);
      if (!pic) throw new Error('no-match');
      const data = await httpGetBuf(String(pic).replace(/^http:/, 'https:'));
      if (data.length < 1000) throw new Error('bad-img');
      fs.mkdirSync(coverRoot(), { recursive: true });
      fs.writeFileSync(cp, data);
      try { fs.rmSync(miss, { force: true }); } catch (e) {}
      return cp;
    } catch (e) {
      try { fs.mkdirSync(coverRoot(), { recursive: true }); fs.writeFileSync(miss, String(Date.now())); } catch (e2) {}
      return null;
    }
  })().then((r) => { inflightAlb.delete(ck); return r; });
  inflightAlb.set(ck, job);
  return job;
}

/* ---------------- 专辑封面批量预热 ----------------
   无内嵌封面、目录里也没有 cover.jpg 的专辑，启动后台逐个到网易云补图并落盘。
   并发 4 + 每张间隔 120ms 温和限速；已失败的专辑走 .miss 记忆跳过。 */
const warmState = { running: false, done: 0, total: 0, ok: 0, startedAt: 0, finishedAt: 0 };
function warmStatus() { return { ...warmState }; }
async function warmCovers({ onEvent = () => {} } = {}) {
  if (warmState.running) return { ...warmState };
  const rows = db.all(`SELECT DISTINCT album, artist FROM music_tracks
    WHERE (cover_file IS NULL OR cover_file='') AND (cover_dir IS NULL OR cover_dir='')
    AND album IS NOT NULL AND album<>'' AND album<>'单曲'`);
  warmState.running = true; warmState.done = 0; warmState.ok = 0;
  warmState.total = rows.length; warmState.startedAt = Date.now(); warmState.finishedAt = 0;
  onEvent(`封面预热开始：${rows.length} 个专辑`);
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const r = rows[next++];
      try { const fp = await albumCoverFetch(r.album, r.artist); if (fp) warmState.ok++; } catch (e) {}
      warmState.done++;
      if (warmState.done % 25 === 0) { onEvent(`封面预热 ${warmState.done}/${warmState.total}`); await YIELD(); }
      await new Promise((s) => setTimeout(s, 120));
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
  warmState.running = false; warmState.finishedAt = Date.now();
  onEvent(`封面预热完成：成功 ${warmState.ok}/${warmState.total}`);
  return { ...warmState };
}

/* ---------------- 重新识别（重读标签 + 文件名兜底重算） ----------------
   与扫描同一套取值口径：标签优先，文件名「歌手-歌名」兜底。
   用途：修复老版本扫描残留的错误歌手/专辑归类、未知歌手等。
   注意：①侧边栏手动改名的歌手/专辑会被打回标签值（与重扫同语义）；
        ②封面不在此重写（扫描时已提取），只更新文字元数据；
        ③三段式读头（64KB→2MB→10MB）：文本标签帧几乎总在文件最前部，
          NAS 磁盘随机读慢（实测 ~5.5MB/s），绝大多数曲目 64KB 即可命中；
        ④reid_at 标记：识别过且文件 mtime/size 未变 → 跳过，二次运行秒级。 */
async function reidentifyAll({ onEvent = () => {} } = {}) {
  const rows = db.all(`SELECT * FROM music_tracks`);
  let updated = 0, missing = 0, skipped = 0, done = 0;
  const readHead = (p, size, bytes) => {
    try {
      const fd = fs.openSync(p, 'r');
      const head = Buffer.alloc(Math.min(bytes, size));
      fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      return head;
    } catch { return null; }
  };
  for (const t of rows) {
    if (!fs.existsSync(t.path)) { missing++; continue; }
    let st; try { st = fs.statSync(t.path); } catch { missing++; continue; }
    // 已识别过且文件未变 → 无需重读（文件变了正常扫描本就会重读标签，这里也重算一遍）
    if (t.reid_at && t.mtime === st.mtimeMs && t.size === st.size) { skipped++; continue; }
    let meta = {};
    const head1 = readHead(t.path, st.size, 64 * 1024);
    if (!head1) { missing++; continue; }
    try { meta = parseMeta(head1, t.ext); } catch { meta = {}; }
    if (!(meta.title && meta.artist)) {
      // 部分命中（有任一标签）或 m4a（moov 可能在尾部）才升级大读；
      // 64KB 完全无标签 → 文件本身没标签，别浪费 NAS 磁盘的大读（实测 ~5.5MB/s）
      const partial = meta.title || meta.artist || meta.album;
      const stages = t.ext === '.m4a' ? [2 * 1024 * 1024, 10 * 1024 * 1024]
        : partial ? [2 * 1024 * 1024] : [];
      for (const bytes of stages) {
        if (st.size <= head1.length) break;
        const head = readHead(t.path, st.size, bytes);
        if (!head) { meta = {}; break; }
        try { meta = parseMeta(head, t.ext); } catch { meta = {}; }
        if (meta.title && meta.artist) break;
        if (st.size <= head.length) break;
      }
    }
    const dir = t.dir || path.dirname(t.path);
    const base = path.basename(t.file_name, t.ext).replace(/^\d+[\s.\-_]+/, '');
    const nameParsed = parseNameArtist(base);
    const rec = {
      title: meta.title || nameParsed.title || base,
      artist: meta.artist || meta.albumartist || nameParsed.artist || '未知歌手',
      album: meta.album || path.basename(dir) || '单曲',
      albumartist: meta.albumartist || '',
      track_no: meta.track_no || null,
      year: meta.year || null,
      genre: meta.genre || '',
    };
    const changed = rec.title !== t.title || rec.artist !== t.artist || rec.album !== t.album ||
      rec.albumartist !== (t.albumartist || '') || (rec.track_no ?? null) !== (t.track_no ?? null) ||
      (rec.year ?? null) !== (t.year ?? null) || rec.genre !== (t.genre || '');
    if (changed) {
      db.run(`UPDATE music_tracks SET title=?, artist=?, album=?, albumartist=?, track_no=?, year=?, genre=?, reid_at=? WHERE id=?`,
        [rec.title, rec.artist, rec.album, rec.albumartist, rec.track_no, rec.year, rec.genre, Date.now(), t.id]);
      updated++;
    } else {
      db.run(`UPDATE music_tracks SET reid_at=? WHERE id=?`, [Date.now(), t.id]);
    }
    if (++done % 50 === 0) { onEvent(`已重识别 ${done}/${rows.length} 首…`); await YIELD(); }
  }
  return { total: rows.length, updated, missing, skipped };
}

module.exports = {
  init, scanAll, listTracks, listAlbums, albumTracks, renameGroup, reidentifyAll,
  getState, saveState, listRoots, addRoot, removeRoot, trackAbs, lyricFor, albumCoverFetch, songCoverFetch,
  addPlay, getStats, topTracks, likeTracks, setLike,
  artistImgCached, artistImgFetch, isPlaceholderImg,
  warmCovers, warmStatus,
  listPlaylists, createPlaylist, deletePlaylist, playlistTracks, playlistAdd, playlistRemove,
  findLyric,
  EXT_OK,
};
