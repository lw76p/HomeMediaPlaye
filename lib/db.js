'use strict';
// 媒体库数据层：SQLite（node:sqlite 内置模块，零原生编译依赖）
const path = require('node:path');
const fs = require('node:fs');
const { files, dirs } = require('./paths');

let db = null;
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  DatabaseSync = null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS library_roots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  path          TEXT    NOT NULL UNIQUE,
  label         TEXT    NOT NULL DEFAULT '',
  type          TEXT    NOT NULL DEFAULT 'local',
  enabled       INTEGER NOT NULL DEFAULT 1,
  exclude       TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  last_scan_at  INTEGER
);

CREATE TABLE IF NOT EXISTS media_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id       INTEGER NOT NULL,
  path          TEXT    NOT NULL UNIQUE,
  dir           TEXT    NOT NULL,
  file_name     TEXT    NOT NULL,
  ext           TEXT    NOT NULL,
  size          INTEGER NOT NULL DEFAULT 0,
  mtime         INTEGER NOT NULL DEFAULT 0,
  duration      REAL,
  width         INTEGER,
  height        INTEGER,
  vcodec        TEXT,
  acodec        TEXT,
  title         TEXT    NOT NULL DEFAULT '',
  year          INTEGER,
  season        INTEGER,
  episode       INTEGER,
  kind          TEXT    NOT NULL DEFAULT 'unknown',
  kind_locked   INTEGER NOT NULL DEFAULT 0,
  series_key    TEXT,
  poster        TEXT,
  probed_at     INTEGER,
  last_seen_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_kind     ON media_files(kind);
CREATE INDEX IF NOT EXISTS idx_media_series   ON media_files(series_key, season, episode);
CREATE INDEX IF NOT EXISTS idx_media_root     ON media_files(root_id);

CREATE TABLE IF NOT EXISTS series (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  series_key    TEXT    NOT NULL UNIQUE,
  title         TEXT    NOT NULL,
  year          INTEGER,
  poster        TEXT,
  episode_count INTEGER NOT NULL DEFAULT 0,
  season_count  INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watch_progress (
  media_id      INTEGER PRIMARY KEY,
  position      REAL    NOT NULL DEFAULT 0,
  duration      REAL,
  finished      INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);
`;

function init() {
  if (db) return db;
  if (!DatabaseSync) {
    throw new Error('node:sqlite 不可用：当前 Electron 内置 Node 版本过低（需 Node 22.5+）');
  }
  dirs.root();
  const file = files.db();
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  migrateColumns();
  return db;
}

/* TMDB 元数据列（2026-09-18）：老库平滑迁移，列已存在则跳过 */
function migrateColumns() {
  const stmts = [
    'ALTER TABLE media_files ADD COLUMN tmdb_id INTEGER',
    'ALTER TABLE media_files ADD COLUMN tmdb_title TEXT',
    'ALTER TABLE media_files ADD COLUMN overview TEXT',
    'ALTER TABLE media_files ADD COLUMN rating REAL',
    'ALTER TABLE media_files ADD COLUMN official_poster TEXT',
    'ALTER TABLE media_files ADD COLUMN backdrop TEXT',
    'ALTER TABLE media_files ADD COLUMN tmdb_at INTEGER',
    'ALTER TABLE series ADD COLUMN tmdb_id INTEGER',
    'ALTER TABLE series ADD COLUMN tmdb_title TEXT',
    'ALTER TABLE series ADD COLUMN overview TEXT',
    'ALTER TABLE series ADD COLUMN rating REAL',
    'ALTER TABLE series ADD COLUMN official_poster TEXT',
    'ALTER TABLE series ADD COLUMN backdrop TEXT',
    'ALTER TABLE media_files ADD COLUMN genre TEXT',
    'ALTER TABLE series ADD COLUMN genre TEXT',
    // credits：演职员 JSON（{cast:[前4主演],dir:[导演/主创]}），P1+d 推荐用（2026-09-27）
    'ALTER TABLE media_files ADD COLUMN credits TEXT',
    'ALTER TABLE series ADD COLUMN credits TEXT',
  ];
  for (const sql of stmts) {
    try { db.exec(sql); } catch { /* 列已存在 */ }
  }
  // V25 一次性迁移：把剧级刮削的 tmdb_title 传导给全剧每一集（老库升级用，幂等——
  // 已有 tmdb_title 的不动；精选行「只上刮削成功内容」按 media_files.tmdb_title 判定，
  // 老库剧集行全空会导致升级后精选行缺剧）
  try {
    db.exec(`UPDATE media_files
             SET tmdb_title = COALESCE(tmdb_title, (SELECT s.tmdb_title FROM series s WHERE s.series_key = media_files.series_key))
             WHERE kind = 'episode' AND series_key IN (SELECT series_key FROM series WHERE IFNULL(tmdb_title,'') != '')`);
  } catch { /* series 表尚未建好等异常，下次启动重试 */ }
}

function raw() {
  return init();
}

function all(sql, params = []) {
  return init().prepare(sql).all(...params);
}
function get(sql, params = []) {
  return init().prepare(sql).get(...params);
}
function run(sql, params = []) {
  return init().prepare(sql).run(...params);
}

/* ---------------- library roots ---------------- */

function listRoots() {
  return all('SELECT * FROM library_roots ORDER BY id ASC');
}

function addRoot(rootPath, label = '', type = 'local') {
  const now = Date.now();
  // 本地目录做绝对路径归一化；网盘路径（webdav: /alist 类型，形如 /电影）保持原样
  const normalized = type === 'local' ? path.resolve(rootPath) : String(rootPath).replace(/\/+$/, '');
  const exists = get('SELECT id FROM library_roots WHERE path = ?', [normalized]);
  if (exists) return exists.id;
  run(
    'INSERT INTO library_roots (path, label, type, enabled, created_at) VALUES (?,?,?,1,?)',
    [normalized, label || path.basename(normalized) || label || '网盘目录', type, now]
  );
  const row = get('SELECT id FROM library_roots WHERE path = ?', [normalized]);
  return row.id;
}

function removeRoot(id) {
  run('DELETE FROM media_files WHERE root_id = ?', [id]);
  run('DELETE FROM library_roots WHERE id = ?', [id]);
}

function touchRoot(id) {
  run('UPDATE library_roots SET last_scan_at = ? WHERE id = ?', [Date.now(), id]);
}

/* ---------------- media files ---------------- */

function findByPath(p) {
  return get('SELECT * FROM media_files WHERE path = ?', [p]);
}

function upsertFile(f, stamp) {
  const existing = findByPath(f.path);
  if (existing) {
    run(
      `UPDATE media_files SET root_id=?, dir=?, file_name=?, ext=?, size=?, mtime=?,
       duration=COALESCE(?,duration), width=COALESCE(?,width), height=COALESCE(?,height),
       vcodec=COALESCE(?,vcodec), acodec=COALESCE(?,acodec),
       title=?, year=?, season=?, episode=?,
       kind = CASE WHEN kind_locked = 1 THEN kind ELSE ? END,
       series_key=?,
       probed_at=COALESCE(?,probed_at), last_seen_at=?
       WHERE id=?`,
      [
        f.rootId, f.dir, f.fileName, f.ext, f.size, f.mtime,
        f.duration ?? null, f.width ?? null, f.height ?? null,
        f.vcodec ?? null, f.acodec ?? null,
        f.title, f.year ?? null, f.season ?? null, f.episode ?? null,
        f.kind, f.seriesKey ?? null,
        f.probedAt ?? null, stamp, existing.id,
      ]
    );
    return existing.id;
  }
  run(
    `INSERT INTO media_files
     (root_id,path,dir,file_name,ext,size,mtime,duration,width,height,vcodec,acodec,
      title,year,season,episode,kind,series_key,probed_at,last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      f.rootId, f.path, f.dir, f.fileName, f.ext, f.size, f.mtime,
      f.duration ?? null, f.width ?? null, f.height ?? null,
      f.vcodec ?? null, f.acodec ?? null,
      f.title, f.year ?? null, f.season ?? null, f.episode ?? null,
      f.kind, f.seriesKey ?? null, f.probedAt ?? null, stamp,
    ]
  );
  return get('SELECT id FROM media_files WHERE path = ?', [f.path]).id;
}

function purgeStale(rootId, stamp) {
  const rows = all(
    'SELECT id, path FROM media_files WHERE root_id = ? AND last_seen_at <> ?',
    [rootId, stamp]
  );
  for (const r of rows) {
    if (!fs.existsSync(r.path)) {
      run('DELETE FROM watch_progress WHERE media_id = ?', [r.id]);
      run('DELETE FROM media_files WHERE id = ?', [r.id]);
    } else {
      run('UPDATE media_files SET last_seen_at = ? WHERE id = ?', [stamp, r.id]);
    }
  }
  return rows.length;
}

function setPoster(mediaId, posterFile) {
  run('UPDATE media_files SET poster = ? WHERE id = ?', [posterFile, mediaId]);
}

function setKind(mediaId, kind) {
  run('UPDATE media_files SET kind = ?, kind_locked = 1 WHERE id = ?', [kind, mediaId]);
}

function needsProbe(limit = 500) {
  return all(
    `SELECT * FROM media_files WHERE probed_at IS NULL ORDER BY size DESC LIMIT ?`,
    [limit]
  );
}

function countByKind() {
  const rows = all('SELECT kind, COUNT(*) AS n FROM media_files GROUP BY kind');
  const out = { movie: 0, episode: 0, unknown: 0, total: 0 };
  for (const r of rows) {
    out[r.kind] = r.n;
    out.total += r.n;
  }
  return out;
}

/* ---------------- series aggregation ---------------- */


/* 归一化剧名：去首尾空白、尾部年份、大小写与标点差异 */
function normSeriesTitle(t) {
  let s = String(t || '').trim();
  for (let i = 0; i < 2; i++) { // 循环剥尾部年份(如 'Cards 2013|2013'), 剥空保护
    const t2 = s.replace(/[^A-Za-z0-9\u3400-\u9fff]*(19|20)\d{2}[^A-Za-z0-9\u3400-\u9fff]*$/i, '');
    if (t2 === s || !t2.trim()) break;
    s = t2;
  }
  return s.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '');
}

/* 跨 key 合并同名剧：不同目录/年份生成的多个 series_key 归一后相同 → 合并到代表 key */
function mergeSeriesDuplicates() {
  const rows = all('SELECT * FROM series');
  const groups = new Map();
  for (const r of rows) {
    const norm = normSeriesTitle(r.title);
    if (!norm) continue;
    if (!groups.has(norm)) groups.set(norm, []);
    groups.get(norm).push(r);
  }
  let merged = 0;
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    // 代表：已刮到 TMDB 的优先，其次集数最多
    arr.sort((a, b) =>
      ((b.tmdb_id ? 1 : 0) - (a.tmdb_id ? 1 : 0)) ||
      ((b.episode_count || 0) - (a.episode_count || 0)) ||
      String(a.series_key).localeCompare(String(b.series_key)));
    const keep = arr[0];
    for (const d of arr.slice(1)) {
      // 刮削列并入代表（已有的不覆盖）
      run(`UPDATE series SET
             tmdb_id=COALESCE(tmdb_id,?),
             tmdb_title=COALESCE(tmdb_title,?),
             overview=COALESCE(overview,?),
             rating=COALESCE(rating,?),
             official_poster=COALESCE(official_poster,?),
             backdrop=COALESCE(backdrop,?)
           WHERE series_key=?`,
        [d.tmdb_id, d.tmdb_title, d.overview, d.rating, d.official_poster, d.backdrop, keep.series_key]);
      // 集数行归拢到代表 key
      run('UPDATE media_files SET series_key=? WHERE series_key=?', [keep.series_key, d.series_key]);
      run('DELETE FROM series WHERE series_key=?', [d.series_key]);
      merged += 1;
    }
  }
  if (merged) console.log(`剧集合并：${merged} 个重复 series_key 已归并`);
  return merged;
}

function rebuildSeries() {
  let rowCount = 0;
  const build = () => {
  const rows = all(
    `SELECT series_key, title, year, COUNT(*) AS n,
            COUNT(DISTINCT season) AS seasons_s,
            MIN(poster) AS poster,
            MIN(season) AS min_season
     FROM media_files
     WHERE kind = 'episode' AND series_key IS NOT NULL AND series_key <> ''
     GROUP BY series_key`
  );
  const now = Date.now();
  const seenKeys = new Set();
  for (const r of rows) {
    seenKeys.add(r.series_key);
    const distinct = get(
      'SELECT COUNT(DISTINCT season) AS c FROM media_files WHERE series_key = ? AND kind = ?',
      [r.series_key, 'episode']
    );
    const seasonCount = (distinct && distinct.c) || 1;
    const existing = get('SELECT id FROM series WHERE series_key = ?', [r.series_key]);
    if (existing) {
      run(
        `UPDATE series SET title=?, year=?, poster=COALESCE(?,poster), episode_count=?, season_count=?, updated_at=?
         WHERE id=?`,
        [r.title, r.year ?? null, r.poster ?? null, r.n, seasonCount, now, existing.id]
      );
    } else {
      run(
        `INSERT INTO series (series_key,title,year,poster,episode_count,season_count,updated_at)
         VALUES (?,?,?,?,?,?,?)`,
        [r.series_key, r.title, r.year ?? null, r.poster ?? null, r.n, seasonCount, now]
      );
    }
  }
  const stale = all('SELECT id, series_key FROM series');
  for (const s of stale) {
    if (!seenKeys.has(s.series_key)) run('DELETE FROM series WHERE id = ?', [s.id]);
  }
  rowCount = rows.length;
  };
  build();
  try {
    if (mergeSeriesDuplicates()) build(); // 合并后重跑聚合, 刷新代表 key 的集数/季数统计
  } catch (e) { console.error("剧集合并失败:", e.message); }
  return rowCount;
}

function listSeries({ q = '', limit = 500, offset = 0 } = {}) {
  let rows;
  if (q) {
    const s = searchClauses(q, SERIES_SEARCH_FIELDS);
    rows = all(
      `SELECT * FROM series WHERE ${s.clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...s.params, limit, offset]
    );
  } else {
    rows = all('SELECT * FROM series ORDER BY updated_at DESC LIMIT ? OFFSET ?', [limit, offset]);
  }
  // 同一 TMDB 条目（tmdb_id 相同）的多目录剧合并为一张卡：代表行累加集数，
  // merged_keys 供 getSeriesDetail 把整组副本的集一起查出（2026-09-21 涛哥反馈：电视菜单同海报重复刷屏）。
  // 未刮削（tmdb_id 为空）不动——标题规范化不可靠，宁可不合并也不能错合
  const byTmdb = new Map();
  const out = [];
  for (const s of rows) {
    if (!s.tmdb_id) { out.push(s); continue; }
    const rep = byTmdb.get(s.tmdb_id);
    if (!rep) { byTmdb.set(s.tmdb_id, s); out.push(s); continue; }
    rep.episode_count = (rep.episode_count || 0) + (s.episode_count || 0);
    rep.season_count = Math.max(rep.season_count || 0, s.season_count || 0);
    if (!rep.official_poster && s.official_poster) rep.official_poster = s.official_poster;
    (rep.merged_keys = rep.merged_keys || [rep.series_key]).push(s.series_key);
  }
  return out;
}

/* 未刮削同名聚合：去尾部集数标记得到聚合基数（MT谜探E1/MT谜探 2 → MT谜探）。
   只对未刮削（无 tmdb_id）的电影条目生效，刮削过的由 tmdb_id 归类负责。 */
const NAME_GROUP_STRIP = /(?:[\s\-_·]*(?:[Ss]\d{1,2}[Ee]\d{1,3}|[Ee][Pp]?\d{1,4}|第\s*\d+\s*[集期话]|[\s\-_·]\d{1,3}))+[\s\-_·]*$/;
function nameGroupBase(title) {
  let s = String(title || '').trim();
  if (!s) return null;
  for (let prev; ; ) {
    prev = s;
    s = s.replace(NAME_GROUP_STRIP, '').trim();
    if (!s || s === prev) break;
  }
  s = s.replace(/[\s\-_·]+$/, '').trim();
  if (!s || [...s].length < 2) return null;
  return s;
}

function getSeriesDetail(seriesKey) {
  const key = String(seriesKey || '');
  // 虚拟合集：未刮削同名电影聚合卡（namegroup:基数）点进来，列出该基数下全部文件
  if (key.startsWith('namegroup:')) {
    const base = key.slice('namegroup:'.length);
    const files = all(
      `SELECT m.*, p.position AS progress_position, p.duration AS progress_duration, p.finished AS progress_finished
       FROM media_files m
       LEFT JOIN watch_progress p ON p.media_id = m.id
       WHERE (m.tmdb_id IS NULL OR m.tmdb_id = 0)
         AND (m.series_key IS NULL OR m.series_key NOT IN (SELECT series_key FROM series WHERE tmdb_id IS NOT NULL))
       ORDER BY m.file_name ASC`
    ).filter((m) => nameGroupBase(m.title) === base);
    files.forEach((e, i) => { e.season = 1; e.episode = i + 1; });
    const best = files.find((x) => x.official_poster)
      || files.reduce((a, x) => ((x.size || 0) > (a.size || 0) ? x : a), files[0]);
    const pseudo = {
      series_key: key,
      title: base,
      tmdb_title: null,
      year: (files.find((x) => x.year) || {}).year || null,
      official_poster: best ? (best.official_poster || null) : null,
      poster: best ? best.poster : null,
      rating: null,
      episode_count: files.length,
      season_count: 1,
    };
    return {
      series: pseudo,
      seasons: files.length ? [{ season: 1, episodes: files }] : [],
      episodeTotal: files.length,
    };
  }
  const s = get('SELECT * FROM series WHERE series_key = ?', [seriesKey]);
  if (!s) return null;
  // 同一 TMDB 条目的多目录副本一起展示：listSeries 合并后的代表 key 点进来，
  // 也能看到整组副本的全部集（按季/集号排序 + dedupeFiles 去掉完全重复的同一集）
  let keys = [seriesKey];
  if (s.tmdb_id) {
    const grp = all('SELECT series_key FROM series WHERE tmdb_id = ?', [s.tmdb_id]);
    if (grp.length > 1) keys = grp.map((r) => r.series_key);
  }
  const ph = keys.map(() => '?').join(',');
  const eps = dedupeFiles(all(
    `SELECT m.*, p.position AS progress_position, p.duration AS progress_duration, p.finished AS progress_finished
     FROM media_files m
     LEFT JOIN watch_progress p ON p.media_id = m.id
     WHERE m.series_key IN (${ph}) AND m.kind = 'episode'
     ORDER BY m.season ASC, m.episode ASC, m.file_name ASC`,
    keys)
  );
  const seasons = new Map();
  for (const e of eps) {
    const sn = e.season == null ? 1 : e.season;
    if (!seasons.has(sn)) seasons.set(sn, []);
    seasons.get(sn).push(e);
  }
  return {
    series: s,
    seasons: [...seasons.entries()].map(([season, episodes]) => ({ season, episodes })),
    episodeTotal: eps.length,
  };
}

/* ---------------- 重复文件去重（副本识别） ----------------
   网盘同步/手工复制常产生 "xxx-复制(1).mp4"、"xxx (1).mp4" 之类副本。
   展示层按「目录 + 归一化文件名」去重，保留体积最大的一份；
   数据库记录不动，源文件删掉后下一页自然干净。 */

function normFileName(fn) {
  let s = String(fn);
  const m = s.match(/(\.[a-z0-9]+)$/i);
  const ext = m ? m[1] : '';
  let base = ext ? s.slice(0, s.length - ext.length) : s;
  base = base.replace(/[-\s_]*(?:-?\s*复制\s*\(\d+\)|-\s*副本\s*\(\d+\)|副本\s*\(\d+\)|-\s*copy\s*\(\d+\))\s*$/i, '');
  base = base.replace(/\s*\(\d+\)$/, '');
  return (base + ext).toLowerCase();
}

function dedupeFiles(rows) {
  // 第一层：同目录内去副本（-复制(N)/-copy(N) 后缀），保留体积最大的
  const best = new Map();
  for (const r of rows) {
    const key = r.dir + '|' + normFileName(r.file_name);
    const prev = best.get(key);
    if (!prev || (r.size || 0) > (prev.size || 0)) best.set(key, r);
  }
  const pass1 = rows.filter((r) => best.get(r.dir + '|' + normFileName(r.file_name)) === r);
  // 第二层：电影跨目录去重——归一化片名+年份相同视为同一部片
  //   （不同目录/不同来源的同名拷贝只展示一份）；优先保留有海报的，其次体积最大的。
  //   剧集/其他类目不参与（避免误伤多季同名集）。
  const tkey = (r) => {
    if (r.kind && r.kind !== 'movie') return null;
    const t = String(r.title || '')
      .toLowerCase()
      .replace(/[\s._\-—–\[\]()·:：,''""]+/g, '');
    if (!t || /^\d+$/.test(t)) return null; // 解析失败的垃圾标题（1080/05 等）不去重
    return t + '|' + (r.year || '');
  };
  const best2 = new Map();
  for (const r of pass1) {
    const k = tkey(r);
    if (!k) continue;
    const score = (r.official_poster ? 1e15 : 0) + (r.size || 0);
    const prev = best2.get(k);
    if (!prev || score > prev.__score) best2.set(k, { r, __score: score });
  }
  return pass1.filter((r) => {
    const k = tkey(r);
    return !k || best2.get(k).r === r;
  });
}

/* ---------------- 查询 ---------------- */

const SORTS = {
  added: 'm.last_seen_at DESC',
  title: 'm.title COLLATE NOCASE ASC',
  size: 'm.size DESC',
  duration: 'm.duration DESC',
  year: 'm.year DESC',
};

/* 搜索命中字段（media_files）：解析名 + 刮削名 + 文件名 + 简介 + 演职员 + 类型。
   credits 列存的是 TMDB 的主演/导演，因此搜演员、导演能直接命中。
   旧实现只匹配 title/file_name —— 刮削后的中文片名、简介、演职员一律搜不到。 */
const SEARCH_FIELDS = ['m.title', 'm.tmdb_title', 'm.file_name', 'm.overview', 'm.credits', 'm.genre'];
const SERIES_SEARCH_FIELDS = ['title', 'tmdb_title', 'overview', 'credits', 'genre'];

/* 多关键词 AND：「星际 穿越」「诺兰 蝙蝠侠」这类组合才找得准。
   每个词都要命中任一字段；词数上限 6，防超长输入拼出巨慢 SQL。 */
function searchClauses(q, fields) {
  const fs = fields || SEARCH_FIELDS;
  const words = String(q || '').split(/[\s,，、]+/).filter(Boolean).slice(0, 6);
  const clauses = [];
  const params = [];
  for (const w of words) {
    const like = `%${w}%`;
    clauses.push('(' + fs.map((f) => `${f} LIKE ?`).join(' OR ') + ')');
    for (let i = 0; i < fs.length; i += 1) params.push(like);
  }
  return { clauses, params, first: words[0] || '' };
}

function queryMedia({ kind = null, q = '', sort = 'added', limit = 200, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (kind) {
    where.push('m.kind = ?');
    params.push(kind);
  }
  let first = '';
  if (q) {
    const s = searchClauses(q);
    where.push(...s.clauses);
    params.push(...s.params);
    first = s.first;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let orderSql = SORTS[sort] || SORTS.added;
  // 片名/剧名命中优先于「简介里顺带提过」，搜片名时正确那部必须排最前
  const orderParams = [];
  if (first) {
    const like = `%${first}%`;
    orderSql = `CASE WHEN m.tmdb_title LIKE ? OR m.title LIKE ? THEN 0 ELSE 1 END, ${orderSql}`;
    orderParams.push(like, like);
  }
  const rows = dedupeFiles(
    all(
      `SELECT m.*, p.position AS progress_position, p.duration AS progress_duration, p.finished AS progress_finished
       FROM media_files m
       LEFT JOIN watch_progress p ON p.media_id = m.id
       ${whereSql}
       ORDER BY ${orderSql}`,
      params.concat(orderParams)
    )
  );
  return rows.slice(offset, offset + limit);
}

function getMedia(id) {
  return get(
    `SELECT m.*, p.position AS progress_position, p.duration AS progress_duration, p.finished AS progress_finished
     FROM media_files m LEFT JOIN watch_progress p ON p.media_id = m.id
     WHERE m.id = ?`,
    [id]
  );
}

function continueWatching(limit = 20) {
  return dedupeFiles(
    all(
      `SELECT m.*, p.position AS progress_position, p.duration AS progress_duration, p.finished AS progress_finished
       FROM watch_progress p JOIN media_files m ON m.id = p.media_id
       WHERE p.finished = 0 AND p.position > 30
       ORDER BY p.updated_at DESC`,
      []
    )
  ).slice(0, limit);
}

function recentlyAdded(limit = 20) {
  return dedupeFiles(
    all(`SELECT m.* FROM media_files m ORDER BY m.last_seen_at DESC, m.id DESC LIMIT ?`, [limit + 60])
  ).slice(0, limit);
}

/* ---------------- 播放进度 ---------------- */

function saveProgress(mediaId, position, duration) {
  const finished = duration && duration > 0 && position / duration > 0.95 ? 1 : 0;
  const existing = get('SELECT media_id FROM watch_progress WHERE media_id = ?', [mediaId]);
  if (existing) {
    run(
      'UPDATE watch_progress SET position=?, duration=?, finished=?, updated_at=? WHERE media_id=?',
      [position, duration ?? null, finished, Date.now(), mediaId]
    );
  } else {
    run(
      'INSERT INTO watch_progress (media_id,position,duration,finished,updated_at) VALUES (?,?,?,?,?)',
      [mediaId, position, duration ?? null, finished, Date.now()]
    );
  }
  return { finished };
}

function getProgress(mediaId) {
  return get('SELECT * FROM watch_progress WHERE media_id = ?', [mediaId]);
}

function clearProgress(mediaId) {
  run('DELETE FROM watch_progress WHERE media_id = ?', [mediaId]);
}

/* ---------------- TMDB 元数据 ---------------- */

function setTmdbMovie(mediaId, d) {
  run(
    `UPDATE media_files
     SET tmdb_id=?, tmdb_title=?, overview=?, rating=?, genre=?, official_poster=?, backdrop=?, credits=COALESCE(?, credits), tmdb_at=?
     WHERE id=?`,
    [d.tmdbId, d.title || null, d.overview || null, d.rating ?? null, d.genre || null, d.officialPoster || null, d.backdrop || null, d.credits || null, Date.now(), mediaId]
  );
}

/* 自定义海报：只换图不动 TMDB 元数据。电影写该文件；剧集整剧生效（series 行 + 传导每一集，与 setSeriesTmdb 同口径） */
function setMediaPoster(mediaId, posterName) {
  run('UPDATE media_files SET official_poster=? WHERE id=?', [posterName, mediaId]);
}

function setSeriesPoster(seriesKey, posterName) {
  run('UPDATE series SET official_poster=? WHERE series_key=?', [posterName, seriesKey]);
  run('UPDATE media_files SET official_poster=? WHERE series_key=?', [posterName, seriesKey]);
}

function getSeriesTmdb(seriesKey) {
  return get('SELECT * FROM series WHERE series_key = ?', [seriesKey]);
}

function setSeriesTmdb(seriesKey, d) {
  run(
    `UPDATE series
     SET tmdb_id=?, tmdb_title=?, overview=?, rating=?, genre=?, official_poster=?, backdrop=?, credits=COALESCE(?, credits)
     WHERE series_key=?`,
    [d.tmdbId, d.title || null, d.overview || null, d.rating ?? null, d.genre || null, d.officialPoster || null, d.backdrop || null, d.credits || null, seriesKey]
  );
  // 官方海报下发给整部剧的每一集（前端卡片优先用它）；
  // tmdb_title 同步下发——精选行的「只上刮削成功内容」过滤按 media_files.tmdb_title 判定，
  // 剧级刮削结果不传导的话整部剧在精选行永远不可见（2026-09-21 本机实测踩坑）
  run(`UPDATE media_files
       SET official_poster=?, backdrop=?, tmdb_title=COALESCE(tmdb_title,?),
           genre=COALESCE(NULLIF(genre,''), ?)
       WHERE series_key=?`, [
    d.officialPoster, d.backdrop || null, d.title || null, d.genre || null, seriesKey,
  ]);
}

function tmdbStats() {
  // 统计口径与刮削目标一致：电影按「标题+年份+目录」去重，剧集按 series_key 去重
  const movieTotal = get(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM media_files WHERE kind = 'movie' GROUP BY title, IFNULL(year, 0), dir)`);
  const movieDone = get(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM media_files WHERE kind = 'movie' AND tmdb_id IS NOT NULL GROUP BY title, IFNULL(year, 0), dir)`);
  const seriesTotal = get(`SELECT COUNT(*) AS n FROM series`);
  const seriesDone = get(`SELECT COUNT(*) AS n FROM series WHERE tmdb_id IS NOT NULL`);
  return {
    mediaTotal: movieTotal ? movieTotal.n : 0,
    mediaScraped: movieDone ? movieDone.n : 0,
    seriesTotal: seriesTotal ? seriesTotal.n : 0,
    seriesScraped: seriesDone ? seriesDone.n : 0,
  };
}

/* ---------------- 影视中心首页分区（2026-09-22） ----------------
   分类维度：TMDB 无「经典」类型，用「高分 + 老片」推断；
   其余按 TMDB 类型关键字命中（动作/悬疑/科幻/动漫） */
const META_CATS = [
  { key: '动作', kw: ['动作', '冒险', '武侠', '战争', '西部'] },
  { key: '悬疑', kw: ['悬疑', '惊悚', '犯罪', '恐怖', '推理'] },
  { key: '科幻', kw: ['科幻', '奇幻'] },
  { key: '动漫', kw: ['动画'] },
];

function genreList(g) {
  return String(g || '').split(/[,，、|/]/).map((x) => x.trim()).filter(Boolean);
}

/* 电影卡：同 TMDB 名+年份去重（多目录同一部片只出一张卡），按入库时间倒序 */
function movieCardRows(keep) {
  let rows = all(
    `SELECT id, title, tmdb_title, year, rating, genre, poster, official_poster, backdrop,
            duration, last_seen_at, root_id, dir
     FROM media_files WHERE kind = 'movie'
     ORDER BY last_seen_at DESC LIMIT 5000`
  );
  // 白名单过滤（儿童模式）：必须在构造卡片之前做，卡片对象不带目录信息
  if (typeof keep === 'function') rows = rows.filter(keep);
  const seen = new Map(); // key -> 在 out 中的下标
  const seenTitle = new Map(); // 规范化标题 -> 下标（未刮削副本连 tmdb_id/年份都缺时的兜底合并）
  const normT = (s) => String(s || '').toLowerCase().replace(/[\s:：·''"",。.\-()（）]+/g, '');
  const out = [];
  for (const r of rows) {
    // 已刮削的按 tmdb_id 去重：未刮削副本与已刮削副本标题写法不同时不再出两张卡（缩略图重复的根因）
    const key = r.tmdb_id ? `t${r.tmdb_id}`
      : `${String(r.tmdb_title || r.title || '').toLowerCase()}|${r.year || ''}`;
    if (!key.trim() || key === '|') continue;
    let hit = seen.has(key) ? seen.get(key) : null;
    // 兜底：规范化标题相同（如「求救信号」一个刮好带年份、一个裸标题）也视为同一部
    const nt = normT(r.tmdb_title || r.title);
    if (hit === null && nt && seenTitle.has(nt)) hit = seenTitle.get(nt);
    if (hit !== null) {
      // 副本更全就把海报/评分/类型/译名补给主卡（旧刮好的副本救新入库未刮的副本）
      const prev = out[hit];
      if (!prev.official_poster && r.official_poster) prev.official_poster = r.official_poster;
      if (!prev.backdrop && r.backdrop) prev.backdrop = r.backdrop;
      if (!prev.rating && r.rating) prev.rating = r.rating;
      if (!prev.genre && r.genre) prev.genre = r.genre;
      if (!prev.tmdb_title && r.tmdb_title) prev.tmdb_title = r.tmdb_title;
      if (!prev.year && r.year) prev.year = r.year;
      continue;
    }
    seen.set(key, out.length);
    if (nt) seenTitle.set(nt, out.length);
    out.push({
      id: r.id, kind: 'movie', title: r.title, tmdb_title: r.tmdb_title, year: r.year,
      rating: r.rating, genre: r.genre, poster: r.poster, official_poster: r.official_poster,
      backdrop: r.backdrop, duration: r.duration, _ts: r.last_seen_at || 0,
    });
  }
  return out;
}

/* 剧集卡：一部剧一张卡（listSeries 已按 tmdb_id 合多目录副本） */
function seriesCardRows(keepSeries) {
  const list = typeof keepSeries === 'function'
    ? listSeries({ limit: 800 }).filter((x) => keepSeries(x.series_key))
    : listSeries({ limit: 800 });
  return list.map((s) => ({
    id: null, kind: 'series', series_key: s.series_key,
    title: s.title, tmdb_title: s.tmdb_title, year: s.year, rating: s.rating, genre: s.genre,
    poster: s.poster, official_poster: s.official_poster, backdrop: s.backdrop,
    episode_count: s.episode_count, season_count: s.season_count, _ts: s.updated_at || 0,
  }));
}

function cardKey(c) { return c.kind === 'series' ? `s:${c.series_key}` : `m:${c.id}`; }

function watchedSet() {
  const rows = all(
    `SELECT m.id, m.series_key FROM watch_progress p JOIN media_files m ON m.id = p.media_id`
  );
  const ids = new Set(), keys = new Set();
  for (const r of rows) { ids.add(r.id); if (r.series_key) keys.add(r.series_key); }
  return { ids, keys };
}

function mediaHomeSections({ limit = 18, keepRow = null, keepSeries = null } = {}) {
  // 缩略图定时轮换：4 小时一个窗口的确定性洗牌（同窗口内容固定，跨窗口自动换血）
  const ROTATE_MS = 4 * 60 * 60 * 1000;
  const rotShuffle = (arr, salt = 0) =>
    arr
      .map((x, i) => ({ x, k: Math.sin((Math.floor(Date.now() / ROTATE_MS) * 131 + salt) * 9301 + (i + 1) * 49297) * 233280 }))
      .sort((a, b) => a.k - b.k)
      .map((o) => o.x);
  const movies = movieCardRows(keepRow);
  const series = seriesCardRows(keepSeries);
  const allCards = movies.concat(series);
  const w = watchedSet();
  const isWatched = (c) => (c.kind === 'series' ? w.keys.has(c.series_key) : w.ids.has(c.id));

  // 最新上架：电影按入库、剧集按更新时间混排；条数减半（12→6），
  // 有海报的排前（组内仍按时间序），未刮削没图的兜底补位——避免整列都是 🎬 占位
  const BOX = 6;
  const hasPic = (c) => !!(c.official_poster || c.poster);
  const byTs = allCards.slice().sort((a, b) => (b._ts || 0) - (a._ts || 0));
  const newest = rotShuffle(byTs.filter(hasPic).slice(0, 18), 11)
    .concat(byTs.filter((c) => !hasPic(c))).slice(0, BOX);
  // 最受好评：先剔掉最新上架已出现的，两列不重复；被剔的留作小库兜底回填
  const seenNew = new Set(newest.map(cardKey));
  const rated = allCards.filter((c) => c.rating);
  const ratedRest = rated.filter((c) => !seenNew.has(cardKey(c)));
  const topRated = rotShuffle(
    ratedRest.slice().sort((a, b) => b.rating - a.rating || (b._ts || 0) - (a._ts || 0)).slice(0, 24),
    12
  ).slice(0, BOX);
  if (!topRated.length) {
    topRated.push(...rotShuffle(rated.slice().sort((a, b) => b.rating - a.rating).slice(0, 24), 12).slice(0, BOX));
  }

  const seen = new Set(newest.map(cardKey).concat(topRated.map(cardKey)));

  // 最佳推荐：高分优先，未看过的加权；已在前两块出现的不重复
  const pickScore = (c) => (c.rating || 0) * 10 - (isWatched(c) ? 30 : 0);
  const byPick = (pool) => rotShuffle(pool.slice().sort((a, b) => pickScore(b) - pickScore(a)).slice(0, limit * 2 + 10), 13).slice(0, limit);
  let picks = byPick(allCards.filter((c) => c.rating && !seen.has(cardKey(c))));
  // 小媒体库兜底：前两块已经占满全库时不再躲重，宁可重复也不让推荐行空着
  if (!picks.length) picks = byPick(allCards.filter((c) => c.rating));
  for (const c of picks) seen.add(cardKey(c));

  // 您可能喜欢：按观看历史里的类型统计口味，再推同类型高分未看内容
  const history = all(
    `SELECT m.genre, m.tmdb_title, m.title
     FROM watch_progress p JOIN media_files m ON m.id = p.media_id
     ORDER BY p.updated_at DESC LIMIT 300`
  );
  const gCount = new Map();
  for (const h of history) for (const g of genreList(h.genre)) gCount.set(g, (gCount.get(g) || 0) + 1);
  const tasteGenres = [...gCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
  const because = history.length ? (history[0].tmdb_title || history[0].title || '') : '';
  let forYou = [];
  if (tasteGenres.length) {
    const match = (c) => genreList(c.genre).some((g) => tasteGenres.includes(g));
    const byRate = (pool) => rotShuffle(pool.slice().sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, limit * 2 + 10), 14).slice(0, limit);
    forYou = byRate(allCards.filter((c) => !isWatched(c) && !seen.has(cardKey(c)) && match(c)));
    // 小媒体库兜底：躲重后为空时放宽去重（仍排除已看过）
    if (!forYou.length) forYou = byRate(allCards.filter((c) => !isWatched(c) && match(c)));
    for (const c of forYou) seen.add(cardKey(c));
  }

  // 分类：经典（高分老片，不足时放宽门槛） + 4 个类型。
  // 跨分类去重：一部片常同时挂「动作+科幻」等多个类型，共享 catSeen 让它只出现在最靠前的分类行，
  // 避免动作片和科幻片两行放同一批海报。
  const normT2 = (c) => String(c.tmdb_title || c.title || '').toLowerCase().replace(/[\s:：·''"",。.\-()（）]+/g, '');
  const catSeen = new Set();
  const classicPool = (list) => {
    let r = list.filter((c) => c.rating >= 7.5 && c.year && c.year <= 2005);
    if (r.length < 4) r = list.filter((c) => c.rating >= 7 && c.year && c.year <= 2012);
    return rotShuffle(r.sort((a, b) => (b.rating || 0) - (a.rating || 0)), 15).slice(0, limit);
  };
  const takeFresh = (list) => {
    const out = [];
    for (const c of list) {
      const k = c.tmdb_id ? `t${c.tmdb_id}` : normT2(c);
      if (catSeen.has(k)) continue;
      catSeen.add(k);
      out.push(c);
      if (out.length >= limit) break;
    }
    return out;
  };
  const catsOf = (list) => {
    const out = { 经典: takeFresh(classicPool(list)) };
    for (const cat of META_CATS) {
      out[cat.key] = takeFresh(rotShuffle(
        list
          .filter((x) => genreList(x.genre).some((g) => cat.kw.some((k) => g.includes(k))))
          .sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b._ts || 0) - (a._ts || 0)),
        16
      ));
    }
    return out;
  };

  const epRow = get(`SELECT COUNT(*) AS n FROM media_files WHERE kind = 'episode'`) || { n: 0 };
  const withGenre = allCards.filter((c) => c.genre).length;
  const movieCats = catsOf(movies);
  const seriesCats = catsOf(series);
  // Hero 轮播池：新片优先（byTs 原序），其次最佳推荐/最受好评，再补动漫分类；最多取 12 个候选，
  // 由 server.js 的 enrichHero 过「质量闸」（假剧剔除）后再取前 6 —— 候选多留才有剔除后的替补
  // 按「新片 / 精选 / 未观看的 / 好评 / 经典」五类交错取候选（round-robin）：
  // 前端一次只显示一部、定时轮换，交错取源才能保证五个来源都轮得到上大屏
  const heroSeen = new Set();
  const hero = [];
  // 新片组：电影与剧集「交替」混排 —— 否则按时间把所有电影排完才轮到剧集，剧集永远上不了大屏
  const freshMix = [];
  {
    const mvs = byTs.filter((c) => !c.series_key && hasPic(c));
    // 剧集候选预筛「假剧」（只有一集的多为单文件误判）：否则它会占掉轮播席位、被质量闸剔除后席位变空
    const srs = byTs.filter((c) => c.series_key && hasPic(c) && (c.episode_count || 0) > 1);
    const mx = Math.max(mvs.length, srs.length);
    for (let i = 0; i < mx; i++) {
      if (mvs[i]) freshMix.push(mvs[i]);
      if (srs[i]) freshMix.push(srs[i]);
    }
  }
  const heroGroups = [
    freshMix.slice(0, 12),                  // 新片（电影 + 剧集交替，按入库时间）
    picks,                                  // 精选（最佳推荐）
    rotShuffle(allCards.filter((c) => !isWatched(c) && c.rating && !seen.has(cardKey(c))), 17).slice(0, 8), // 未观看的
    topRated,                               // 好评
    classicPool(allCards),                  // 经典（高分老片）
  ];
  for (let i = 0; hero.length < 12; i++) {
    let any = false;
    for (const g of heroGroups) {
      const c = g[i];
      if (!c) continue;
      any = true;
      const hk = cardKey(c);
      if (heroSeen.has(hk)) continue;
      heroSeen.add(hk);
      if (!(c.backdrop || c.official_poster || c.poster)) continue;
      hero.push(c);
      if (hero.length >= 12) break;
    }
    if (!any) break; // 各组都取完了
  }
  return {
    newest, topRated, picks, forYou, hero,
    taste: { genres: tasteGenres, because },
    movieCats,
    seriesCats,
    stats: {
      movies: movies.length,
      series: series.length,
      episodes: epRow.n || 0,
      genreCoverage: allCards.length ? Math.round((withGenre / allCards.length) * 100) : 0,
    },
  };
}

/* ---------------- settings ---------------- */

function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', [key]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

function setSetting(key, value) {
  const v = JSON.stringify(value);
  const existing = get('SELECT key FROM settings WHERE key = ?', [key]);
  if (existing) run('UPDATE settings SET value = ? WHERE key = ?', [v, key]);
  else run('INSERT INTO settings (key,value) VALUES (?,?)', [key, v]);
  return value;
}

function allSettings() {
  const rows = all('SELECT key, value FROM settings');
  const out = {};
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return out;
}

/* 事务包装：批量写入合并为单次提交。
   SQLite 默认每条语句 autocommit 各自落盘（fsync），扫描入库上万条语句时这是最大瓶颈。 */
function withTransaction(fn) {
  const d = init();
  d.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    d.exec('COMMIT');
    return r;
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* 忽略回滚失败 */ }
    throw e;
  }
}

module.exports = {
  withTransaction,
  init, raw, all, get, run,
  listRoots, addRoot, removeRoot, touchRoot,
  findByPath, upsertFile, purgeStale, setPoster, setKind, needsProbe,
  countByKind, rebuildSeries, listSeries, getSeriesDetail,
  dedupeFiles,
  queryMedia, getMedia, continueWatching, recentlyAdded,
  saveProgress, getProgress, clearProgress,
  setTmdbMovie, getSeriesTmdb, setSeriesTmdb, setMediaPoster, setSeriesPoster, tmdbStats, nameGroupBase,
  mediaHomeSections, META_CATS, genreList,
  getSetting, setSetting, allSettings,
  isAvailable: () => !!DatabaseSync,
};
