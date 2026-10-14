'use strict';
/* 字幕全文搜索(P1 三部曲之二·层面A):FTS5 台词检索 + 时间戳跳播
 *
 * 实证约束(本地 node:sqlite 实测):
 * - node:sqlite 内置 FTS5,零依赖;但 unicode61 对连续汉字整句成一个 token,
 *   「雪景」直接查 0 命中 → 入索引前必须 CJK 逐字切分(实测切分后全命中)
 * - ai.js 的 CLIP 文本塔只吃英文(中文靠词表映射,词表只覆盖找图词汇),
 *   台词语义编不成向量 → 语义增强降级为「词表同义词扩展」:
 *   同一英文概念的中文词互为同义词 OR 进查询(如 查「下雪」连带「雪/雪景/暴雪」),
 *   真 embedding(多语言句向量模型)后置到 P3 与画面搜索一起上
 * - 数据源:asr_tracks.seg_json = [{s,e,t}](asr.js 落库),懒索引:
 *   搜索前自动补索引新增字幕,不用改 asr.js 一行
 */
const db = require('./db');
const wordmap = require('./aisearch-wordmap');

let schemaReady = false;
let fts5Ok = null; // null=未探测;实测:本机/NAS node:sqlite 带 FTS5,WorkBuddy 沙箱不带 → LIKE 降级
function ensureSchema() {
  if (schemaReady) return;
  try {
    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS sub_fts USING fts5(
      media_id UNINDEXED, start_s UNINDEXED, text, tokenize='unicode61'
    )`);
    fts5Ok = true;
  } catch {
    fts5Ok = false; // no such module: fts5 → 降级为 asr_tracks.seg_json 的 LIKE 子串检索
  }
  db.run(`CREATE TABLE IF NOT EXISTS sub_idx (
    track_id   INTEGER PRIMARY KEY,
    media_id   INTEGER,
    lines      INTEGER DEFAULT 0,
    indexed_at INTEGER DEFAULT 0
  )`);
  schemaReady = true;
}

/* ---------------- 文本处理 ---------------- */

/* CJK 逐字切分:连续汉字每字后插空格(unicode61 按空格分词),非 CJK 保持原样 */
function cjkSplit(s) {
  return String(s || '')
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff]/g, (ch) => ch + ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* 切分还原:cjkSplit 只在汉字后插空格,逆操作 = 去掉汉字后的空格。
   「看 这 雪 景 ,太 美 了」→「看这雪景,太美了」;英文空格不受影响 */
function unCjkSplit(s) {
  return String(s || '').replace(/([\u3400-\u4dbf\u4e00-\u9fff])\s+/g, '$1');
}

const hasCJK = (s) => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(s);

/* 单个词 → FTS 查询片段:中文逐字 phrase,英文前缀通配 */
function tokenToPhrase(tok) {
  const chars = cjkSplit(tok).split(' ').filter(Boolean);
  return '"' + chars.join(' ') + '"';
}

/* 词表同义词:同概念(共享任一英文变体)的其他中文词。
   反查表懒构建:eng 变体 → [中文键] */
let synIndex = null;
function synonymIndex() {
  if (synIndex) return synIndex;
  const m = new Map();
  const words = (wordmap && wordmap.WORDS) || {};
  for (const [zh, ens] of Object.entries(words)) {
    for (const en of Array.isArray(ens) ? ens : [ens]) {
      const k = String(en).toLowerCase();
      if (!m.has(k)) m.set(k, new Set());
      m.get(k).add(zh);
    }
  }
  synIndex = m;
  return m;
}

function synonymsOf(zhWord) {
  const ens = (wordmap.WORDS || {})[zhWord];
  if (!ens) return [];
  const idx = synonymIndex();
  const out = new Set();
  for (const en of Array.isArray(ens) ? ens : [ens]) {
    for (const zh of idx.get(String(en).toLowerCase()) || []) {
      if (zh !== zhWord) out.add(zh);
    }
  }
  return [...out];
}

function asrTrackCount() {
  try {
    const r = db.get("SELECT COUNT(*) AS c FROM asr_tracks WHERE status = 'done'");
    return (r && r.c) || 0;
  } catch { return 0; } // asr_tracks 还没建表（从未跑过 AI 字幕）
}

/* 查询构造:token 间 AND;中文 token 逐字 phrase + 同义词 OR 组 */
function buildMatchQuery(q, { expand = true } = {}) {
  const toks = String(q || '').trim().split(/[\s,，、。.；;：:!！?？/\\|()（）\[\]【】"'」『「】]+/).filter(Boolean);
  const groups = [];
  for (const raw of toks) {
    const tok = raw.toLowerCase();
    const alts = new Set();
    if (hasCJK(tok)) {
      alts.add(tokenToPhrase(tok));
      if (expand) {
        for (const syn of synonymsOf(tok)) alts.add(tokenToPhrase(syn));
      }
    } else if (/^[a-z0-9]/.test(tok)) {
      alts.add(tok + '*'); // 英文/数字前缀匹配
    } else {
      alts.add(tokenToPhrase(tok));
    }
    if (alts.size) groups.push('(' + [...alts].join(' OR ') + ')');
  }
  return groups.join(' AND ');
}

/* ---------------- 索引 ---------------- */

let indexing = null; // 并发去重:懒索引进行中时复用同一 Promise

function pendingTracks() {
  return db.all(
    `SELECT id, media_id, seg_json FROM asr_tracks
      WHERE status = 'done' AND media_id IS NOT NULL
        AND id NOT IN (SELECT track_id FROM sub_idx)
      ORDER BY id ASC`
  );
}

function indexOneTrack(row) {
  let cues = null;
  try { cues = JSON.parse(row.seg_json || '[]'); } catch { cues = null; }
  if (!Array.isArray(cues)) cues = null;
  if (!cues || !cues.length) return 0;
  const ins = db.raw().prepare('INSERT INTO sub_fts (media_id, start_s, text) VALUES (?,?,?)');
  let n = 0;
  for (const c of cues) {
    const text = String(c.t || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const s = Number(c.s);
    ins.run(row.media_id, Number.isFinite(s) ? s : 0, cjkSplit(text));
    n += 1;
  }
  db.run('INSERT OR REPLACE INTO sub_idx (track_id, media_id, lines, indexed_at) VALUES (?,?,?,?)',
    [row.id, row.media_id, n, Date.now()]);
  return n;
}

/* 懒索引:把 asr_tracks 里还没入 FTS 的字幕补进来(幂等) */
async function indexPending({ force = false } = {}) {
  ensureSchema();
  if (!fts5Ok) return { indexed: 0, lines: 0, mode: 'like' };
  if (force) { db.run('DELETE FROM sub_fts'); db.run('DELETE FROM sub_idx'); }
  const rows = pendingTracks();
  if (!rows.length) return { indexed: 0, lines: 0 };
  let lines = 0, n = 0;
  for (const r of rows) {
    try { lines += indexOneTrack(r); n += 1; } catch { /* 单条损坏不影响整批 */ }
    if ((n & 7) === 0) await new Promise((r2) => setImmediate(r2)); // 让出事件循环
  }
  return { indexed: n, lines };
}

function lazyIndex() {
  if (indexing) return indexing;
  indexing = indexPending().catch(() => ({ indexed: 0, lines: 0 })).finally(() => { indexing = null; });
  return indexing;
}

/* ---------------- 搜索 ---------------- */

const fmtSub = (m) => (m.kind === 'episode' ? `S${m.season ?? 1}E${m.episode ?? 1}` : '');

/* LIKE 降级检索(fts5 缺失环境):asr_tracks.seg_json 子串匹配 → 解析 JSON 取命中句与时间戳 */
function searchLike(q, { limit = 24, perMedia = 2 } = {}) {
  const toks = String(q || '').trim().split(/[\s,，、。.；;：:!！?？/\\|()（）\[\]【】"'「」『』]+/).filter(Boolean).slice(0, 6);
  if (!toks.length) return [];
  let where = "status = 'done' AND media_id IS NOT NULL";
  const params = [];
  for (const tk of toks) { where += ' AND seg_json LIKE ?'; params.push('%' + tk + '%'); }
  let tracks;
  try {
    tracks = db.all(`SELECT id, media_id, seg_json FROM asr_tracks WHERE ${where} LIMIT 40`, params);
  } catch { return []; }
  const lq = toks.map((t) => t.toLowerCase());
  const out = [];
  for (const tr of tracks) {
    let cues = null;
    try { cues = JSON.parse(tr.seg_json || '[]'); } catch { cues = null; }
    if (!Array.isArray(cues)) continue;
    const mrow = db.get(
      'SELECT title, tmdb_title, file_name, kind, season, episode, series_key, poster, year FROM media_files WHERE id = ?',
      [tr.media_id]);
    if (!mrow) continue;
    let taken = 0;
    for (const c of cues) {
      const text = String(c.t || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const low = text.toLowerCase();
      if (!lq.every((tk) => low.includes(tk))) continue;
      out.push({
        media_id: tr.media_id,
        title: mrow.tmdb_title || mrow.title || mrow.file_name,
        sub: fmtSub(mrow),
        kind: mrow.kind,
        poster: mrow.poster || '',
        year: mrow.year || '',
        start_s: Number(c.s) || 0,
        text,
        score: 0,
      });
      if (++taken >= (parseInt(perMedia, 10) || 2)) break;
    }
    if (out.length >= (parseInt(limit, 10) || 24) * 2) break;
  }
  return out.slice(0, Math.min(parseInt(limit, 10) || 24, 100));
}

async function search(q, { limit = 24, perMedia = 2, expand = true } = {}) {
  const t0 = Date.now();
  ensureSchema();
  if (!fts5Ok) {
    const hits = searchLike(q, { limit, perMedia });
    return { ok: true, q, mode: 'like', took: Date.now() - t0, hits };
  }
  const idx = await lazyIndex();
  const match = buildMatchQuery(q, { expand });
  if (!match) return { ok: true, q, mode: 'fts', took: 0, hits: [], match, indexed: idx };

  let rows;
  try {
    rows = db.all(
      `SELECT f.media_id, f.start_s, f.text, bm25(sub_fts) AS score,
              m.title, m.tmdb_title, m.file_name, m.kind, m.season, m.episode, m.series_key, m.poster, m.year
         FROM sub_fts f
         JOIN media_files m ON m.id = f.media_id
        WHERE sub_fts MATCH ?
        ORDER BY score ASC
        LIMIT ?`,
      [match, Math.min(parseInt(limit, 10) || 24, 100) * 4]
    );
  } catch (e) {
    return { ok: true, q, mode: 'fts', took: Date.now() - t0, hits: [], match, error: e.message, indexed: idx };
  }

  // 每部影片留 top N 句(不同时间戳),按最佳相关度整片排序
  const perMediaMap = new Map();
  const order = [];
  for (const r of rows) {
    if (!perMediaMap.has(r.media_id)) { perMediaMap.set(r.media_id, []); order.push(r.media_id); }
    const arr = perMediaMap.get(r.media_id);
    if (arr.length < (parseInt(perMedia, 10) || 2)) arr.push(r);
  }
  const best = new Map(); // media_id → 最佳 score
  for (const [mid, arr] of perMediaMap) best.set(mid, Math.min(...arr.map((x) => x.score)));
  const mids = order.sort((a, b) => best.get(a) - best.get(b)).slice(0, Math.min(parseInt(limit, 10) || 24, 100));

  const hits = [];
  for (const mid of mids) {
    for (const r of perMediaMap.get(mid)) {
      hits.push({
        media_id: r.media_id,
        title: r.tmdb_title || r.title || r.file_name,
        sub: fmtSub(r),
        kind: r.kind,
        poster: r.poster || '',
        year: r.year || '',
        start_s: r.start_s,
        text: unCjkSplit(r.text),
        score: Math.round(r.score * 1000) / 1000,
      });
    }
  }
  return { ok: true, q, mode: 'fts', took: Date.now() - t0, match, hits, indexed: idx };
}

function status() {
  ensureSchema();
  const tracks = db.get('SELECT COUNT(*) AS c FROM sub_idx');
  const lines = db.get('SELECT COALESCE(SUM(lines),0) AS c FROM sub_idx');
  const media = db.get('SELECT COUNT(DISTINCT media_id) AS c FROM sub_idx');
  const total = asrTrackCount();
  return {
    ready: true,
    fts5: !!fts5Ok,
    tracks: (tracks && tracks.c) || 0,
    lines: (lines && lines.c) || 0,
    media: (media && media.c) || 0,
    pending: Math.max(0, total - ((tracks && tracks.c) || 0)),
    asrTracks: total,
  };
}

module.exports = { search, status, indexPending, ensureSchema, cjkSplit, unCjkSplit, buildMatchQuery };
