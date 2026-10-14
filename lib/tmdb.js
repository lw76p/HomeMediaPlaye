'use strict';
// TMDB 元数据刮削：按文件名解析出的标题/年份搜索匹配，
// 下载官方海报与背景图，存储中文简介、评分。
// 设计约束：
//  - 无 API Key 时全部功能静默跳过（不影响原有抽帧封面流程）
//  - API 与图片域名可用环境变量覆盖（自动化测试用 mock 服务器）
//  - 匹配失败不写任何字段，下次扫描/手动刮削可重试
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const { dirs } = require('./paths');

const LANG = 'zh-CN';

function apiKey() {
  return db.getSetting('tmdbApiKey', null) || process.env.HMP_TMDB_API_KEY || null;
}

function baseUrl() {
  // 优先级：设置面板填的接口地址 > 环境变量 > 官方默认
  let u = (db.getSetting('tmdbApiBaseUrl', null) || process.env.HMP_TMDB_BASE_URL || 'https://api.themoviedb.org/3').replace(/\/+$/, '');
  // 只填了域名（如 https://xxx.workers.dev）时自动补 /3 版本前缀
  try {
    const p = new URL(u);
    if (!p.pathname || p.pathname === '/') u += '/3';
  } catch { /* 非法地址原样返回，请求时会报错并显示原因 */ }
  return u;
}

function imageBaseUrl() {
  // 优先级：设置面板图片地址 > 环境变量 > 自定义接口同域 /img（Worker 反代，国内稳定）> 官方默认
  const explicit = db.getSetting('tmdbImgBaseUrl', null) || process.env.HMP_TMDB_IMG_BASE_URL || null;
  if (explicit) return String(explicit).replace(/\/+$/, '');
  try {
    const api = new URL(baseUrl());
    if (api.hostname !== 'api.themoviedb.org') {
      return api.origin + '/img/t/p';
    }
  } catch { /* baseUrl 非法时按官方默认处理 */ }
  return 'https://image.tmdb.org/t/p';
}

function enabled() {
  return !!apiKey();
}

async function tmdbGet(urlPath, params = {}) {
  const key = apiKey();
  if (!key) throw new Error('未配置 TMDB API Key');
  // 默认请求中文数据：标题/简介返回国内通用译名（个别调用可显式覆盖）
  params = { language: 'zh-CN', ...params };
  const q = new URLSearchParams({ language: LANG, api_key: key, ...params });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${baseUrl()}${urlPath}?${q}`, { signal: ctrl.signal });
    if (res.status === 401) throw new Error('TMDB API Key 无效（401）');
    if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/* 在候选中挑选年份最接近的（允许 ±1 年），否则取第一个 */
function pickBest(results, year) {
  if (!Array.isArray(results) || !results.length) return null;
  if (year) {
    for (const r of results.slice(0, 5)) {
      const d = r.release_date || r.first_air_date || '';
      const y = parseInt(d.slice(0, 4), 10);
      if (y && Math.abs(y - year) <= 1) return r;
    }
  }
  return results[0] || null;
}

async function downloadImage(imagePath, outName) {
  if (!imagePath) return null;
  const url = `${imageBaseUrl()}/w780${imagePath}`;
  const outPath = path.join(dirs.posters(), outName);
  try {
    const st = await fsp.stat(outPath);
    if (st.size > 1024) return outName; // 已存在直接复用
  } catch {
    /* 需要下载 */
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) throw new Error('图片内容过小');
    await fsp.writeFile(outPath, buf);
    return outName;
  } finally {
    clearTimeout(t);
  }
}

/* —— 搜索名智能清洗：脏文件名（「基地S01E」「[XX] 特别小组 1080p」）直接搜必败，
   先按原名搜，失败后依次用清洗名重试，把能自动救回的救回来 —— */
// 注意：中文字与 ASCII 紧邻时（「基地S01E」）JS 的 \b 判定不可靠，统一用 lookaround
const NB_L = '(?<![A-Za-z0-9])';
const NB_R = '(?![A-Za-z0-9])';
const NOISE_RES = [
  /\[[^\]]*\]/g,                 // [影视分享屋] [高清] 等站点标签
  /【[^】]*】/g,
  new RegExp(`${NB_L}S\\d{1,2}(?:E\\d{0,3})?${NB_R}`, 'gi'),   // S01E01 / S01E / S01
  new RegExp(`${NB_L}E\\d{1,3}${NB_R}`, 'gi'),                 // E01
  new RegExp(`${NB_L}EP\\d{1,3}${NB_R}`, 'gi'),                // EP01
  /第\s*\d+\s*[季集部]/g,                                        // 第一季 / 第3集
  new RegExp(`${NB_L}Seasons?\\s*\\d+${NB_R}`, 'gi'),          // Season 2
  new RegExp(`${NB_L}(?:2160p|1080p|720p|576p|480p|4k|8k|uhd|hdr10?|dovi|dv|web-?dl|webrip|bluray|blu-?ray|remux|hdtv|hdrip|bdrip|x26[45]|h26[45]|hevc|avc|aac|ac3|dts|ddp?5[.\\s]?1|10bit|8bit|repack|proper)${NB_R}`, 'gi'),
  /(?:国语|粤语|双语|中字|中英双字|简体|繁体|内嵌字幕|外挂字幕|无删减|未删减|完整版|高清版|蓝光版|影视分享屋|电影天堂|人人影视|迅雷下载|BT下载)/g,
];

function cleanTitle(title) {
  let t = String(title || '');
  for (const re of NOISE_RES) t = t.replace(re, ' ');
  return t
    .replace(/[._\-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—·:：!！?？]+|[\s\-–—·:：!！?？]+$/g, '')
    .trim();
}

/* 生成候选搜索名（不含原名本身，按「最接近原名」优先） */
function nameVariants(title) {
  const raw = String(title || '').trim();
  const out = [];
  const add = (s) => {
    const v = String(s || '').replace(/\s+/g, ' ').trim();
    // 必须含字母或汉字：'2026' 这类纯数字名搜不出正经结果，只会乱配
    if (v.length >= 2 && v !== raw && /[\u4e00-\u9fa5A-Za-z]/.test(v) && !out.includes(v)) out.push(v);
  };
  const cleaned = cleanTitle(raw)
    .replace(/[（(][^）)]*[)）]\s*$/g, '')            // 去掉结尾补充说明
    .replace(/\s+[A-Za-z][A-Za-z0-9]{2,9}$/, '');   // 去掉尾部发布组标签（VINEnc / RARBG）

  add(cleaned);

  // 开头的清单序号先剥掉（「01 盗梦空间」→「盗梦空间」、「1.禁闭岛」→「禁闭岛」）
  // 实测：网盘分享的片单常以序号开头，带序号去搜 TMDB 是 raw=0（一条都搜不到），
  // 剥掉后与 TMDB 译名精确同名，属于「同名匹配」而非猜测——15 条片单由此可正确命中
  const noidx = cleaned
    .replace(/^\s*\d{1,3}\s*[.\-_、)）]\s*/, '')
    .replace(/^\s*\d{1,3}\s+(?=[\u4e00-\u9fa5A-Za-z])/, '')
    .trim();
  if (noidx && noidx !== cleaned) add(noidx);

  // 中英混排名（「碟中谍4鬼影行动 Mission Impossible…」）分层切中文部分
  const cjkRun = (cleaned.match(/^[\u4e00-\u9fa50-9]+/) || [''])[0];
  if (cjkRun) {
    add(cjkRun);                                       // 碟中谍4鬼影行动
    add((cjkRun.match(/^[\u4e00-\u9fa5]+\d+/) || [''])[0]); // 碟中谍4
    add((cjkRun.match(/^[\u4e00-\u9fa5]+/) || [''])[0]);    // 碟中谍
  }

  // 英文名：逐级去掉尾部 token（残留技术串 / 副标题）
  const toks = cleaned.split(' ');
  if (toks.length >= 2) add(toks.slice(0, -1).join(' '));

  // 中文名剥掉尾部序号（「冬日之死2025」→「冬日之死」）
  if (/[\u4e00-\u9fa5]/.test(cleaned)) add(cleaned.replace(/\s*\d{1,4}$/, '').trim());

  return out.filter((v) => v.length >= 2).slice(0, 5);
}

/* 可信度校验：清洗后（非原名）的命中必须与候选的标题/原名有实质重合，
   否则宁可判失败——错误的海报与片名比「没有海报」更糟（如垃圾名「iT DL H 265」乱配） */
function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
}
/* 两个名字里是否有连续 2 个汉字重合
   （繁简差异救回：河谷鎮/河谷镇、黑暗榮耀/黑暗荣耀 —— 差異字不影響「河谷」「黑暗」重合） */
function sharesTwoCJK(a, b) {
  const x = String(a || ''), y = String(b || '');
  for (let i = 0; i + 2 <= x.length; i++) {
    const seg = x.slice(i, i + 2);
    if (/^[\u4e00-\u9fa5]{2}$/.test(seg) && y.includes(seg)) return true;
  }
  return false;
}

function plausibleMatch(query, cand) {
  if (!/[\u4e00-\u9fa5A-Za-z]/.test(String(query))) return false; // 纯数字不算名字
  const q = normName(query);
  if (!q) return false;
  const qWords = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  for (const t of [cand.title, cand.name, cand.original_title, cand.original_name]) {
    const c = normName(t);
    if (!c) continue;
    // 长度悬殊时不认「包含」：否则「基地」会被「月球基地8号」抢走、
    // 「龙之家族」会被「龙之家族：幕后特辑」抢走（实测踩过，TMDB 上正片压根不叫这个名）
    const ratio = Math.max(c.length, q.length) / Math.min(c.length, q.length);
    if (ratio <= 1.3 && (c.includes(q) || q.includes(c))) return true;
    // 英文实词的词集必须完全一致：认「House of the Dragon」这种原名搜索，
    // 拒绝「The Glory」→「The Glory of Global Chinese」、「Arcane」→「Arcane Afterglow」这类长尾
    if (qWords.length) {
      const cw = String(t).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
      if (cw.length > 0 && cw.length === qWords.length && qWords.every((w) => cw.includes(w))) return true;
    }
    if (ratio <= 1.3 && sharesTwoCJK(query, t)) return true;
  }
  return false;
}

/* 查询质量闸：纯季号/集号/技术串当查询名，搜出来必然是噪声。
   实测教训——「S01」配到「如果古建筑会说话S01」、「SE10」配到印度剧、
   「S02E04v3」配到假面骑士V3；这类错误海报比「没有海报」更糟，直接判失败交给手工识别 */
function isJunkQuery(q) {
  const s = String(q || '').trim();
  if (!s) return true;
  // 纯季/集号：S01 / SE10 / S02E04 / S02E04v3 / 1x05 / 第一季 / 第3集
  if (/^(?:s|se|season|ep|e)\s*\d{1,3}(?:\s*e\s*\d{1,3})?(?:\s*v\d)?$/i.test(s)) return true;
  if (/^第\s*[0-9０-９一二三四五六七八九十百]+\s*[季集部]$/.test(s)) return true;
  if (/^\d{1,2}\s*x\s*\d{1,3}$/i.test(s)) return true;
  // 不含中文也不含字母（纯数字、纯符号）
  if (!/[\u4e00-\u9fa5A-Za-z]/.test(s)) return true;
  // 剥掉技术词后什么都不剩（「4k内嵌特效中英字幕」「1080p 中字」）
  const stripped = s
    .replace(/(?:2160p|1080p|720p|576p|480p|4k|8k|uhd|hdr10?|dovi|web-?dl|webrip|bluray|blu-?ray|remux|hdtv|hdrip|bdrip|x26[45]|h26[45]|hevc|avc|aac|ac3|dts|10bit|8bit|repack|proper)/gi, '')
    .replace(/(?:内嵌|外挂|字幕|中英|中字|简体|繁体|国语|粤语|双语|特效|无删减|未删减|完整版|高清版|蓝光版)/g, '')
    .replace(/[\s\-_.\[\]()（）【】·:：!！?？]+/g, '');
  if (stripped.length < 2) return true;
  // 泛目录名不是剧名（「电视剧」「电影」「动漫」…）——文件夹命名不规范，搜什么都可能巧合命中
  if (/^(?:电视剧|连续剧|美剧|日剧|韩剧|港剧|台剧|国产剧|剧集|电影|影片|动漫|动画|综艺|纪录片|合集|其他|未分类|新建文件夹|下载|待整理)$/i.test(s)) return true;
  return false;
}

/* 候选重排：完全同名的排最前，避免「龙之家族：幕后特辑」这类附属条目抢先命中正片 */
function rankPool(pool, query) {
  if (!Array.isArray(pool) || pool.length < 2) return pool;
  const q = normName(query);
  if (!q) return pool;
  const score = (x) => {
    const names = [x.title, x.name, x.original_title, x.original_name].map(normName).filter(Boolean);
    if (names.some((n) => n === q)) return 3;                             // 完全同名
    if (names.some((n) => n.startsWith(q) || q.startsWith(n))) return 2;  // 前缀关系
    if (names.some((n) => n.includes(q))) return 1;                       // 包含关系
    return 0;
  };
  return pool
    .map((x, i) => ({ x, i, s: score(x) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((o) => o.x);
}

/* 带年份优先、无年份兜底，逐候选重试；返回命中的候选与 query */
async function searchWithVariants(kindPath, row) {
  const original = String(row.title || '').trim();
  const variants = nameVariants(original);
  const attempts = [];
  // 带年份优先（最多 4 个候选名），再不带年份重试（最多 3 个）——年份只是加权，不是硬条件
  if (row.year) for (const q of [original, ...variants.slice(0, 3)]) attempts.push({ q, year: row.year });
  for (const q of [original, ...variants.slice(0, 2)]) attempts.push({ q, year: undefined });
  let lastErr = null;
  let tried = 0, skipped = 0;
  for (const a of attempts) {
    if (!a.q) continue;
    if (isJunkQuery(a.q)) { skipped++; continue; } // 质量闸：垃圾查询名不发请求，白跑一趟不如直接判失败
    tried++;
    try {
      const r = await tmdbGet(kindPath, { query: a.q, year: a.year || undefined });
      // 所有命中都必须过可信度校验——「原名命中」并不代表匹配正确：
      // 本地「基地」搜出动画喜剧「战地好基友」、「暗黑 dark」搜出 1966 老剧「黑暗阴影」
      const pool = rankPool((r.results || []).filter((x) => plausibleMatch(a.q, x)), a.q);
      const best = pickBest(pool, a.year);
      if (best) return { best, query: a.q };
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return { best: null, query: original, junk: tried === 0 && skipped > 0 };
}

/* TMDB 类型名（zh-CN）：多类型逗号拼接，如「动作,科幻」 */
function genresOf(detail) {
  return (detail && Array.isArray(detail.genres) ? detail.genres : [])
    .map((g) => (g && g.name ? String(g.name).trim() : ''))
    .filter(Boolean)
    .join(',');
}

/* 从详情（append_to_response=credits）提取演职员：前 4 主演 + 导演/主创（TV 用 created_by）。
   无任何人员时返回 null（列保持旧值）。 */
function creditsOf(detail) {
  const cr = detail && detail.credits;
  const cast = (cr && Array.isArray(cr.cast) ? cr.cast : []).slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .slice(0, 4).map((c) => String(c.name || '').trim()).filter(Boolean);
  let dir = (cr && Array.isArray(cr.crew) ? cr.crew : [])
    .filter((c) => c && c.job === 'Director').map((c) => String(c.name || '').trim()).filter(Boolean);
  if (Array.isArray(detail && detail.created_by)) dir = dir.concat(detail.created_by.map((c) => String(c.name || '').trim()));
  dir = [...new Set(dir)].slice(0, 2);
  if (!cast.length && !dir.length) return null;
  return JSON.stringify({ cast, dir });
}

/* 刮一部电影：搜索 → 详情 → 下载图 → 写库 */
async function scrapeMovieRow(row) {
  // 原名搜不到 → 用清洗名重试（如「基地S01E」→「基地」）
  const { best, query, junk } = await searchWithVariants('/search/movie', row);
  if (!best) return { ok: false, reason: junk ? '跳过：文件名里没有可识别的片名（纯季号/技术串），请手工识别' : '未匹配到电影' };
  const detail = await tmdbGet(`/movie/${best.id}`, { append_to_response: 'credits' });
  const posterName = await downloadImage(detail.poster_path, `tmdb-movie-${detail.id}.jpg`).catch(() => null);
  const backdropName = await downloadImage(detail.backdrop_path, `tmdb-movie-${detail.id}-bd.jpg`).catch(() => null);
  db.setTmdbMovie(row.id, {
    tmdbId: detail.id,
    title: detail.title || best.title || row.title,
    overview: detail.overview || '',
    rating: detail.vote_average || null,
    genre: genresOf(detail),
    credits: creditsOf(detail),
    officialPoster: posterName,
    backdrop: backdropName,
  });
  return { ok: true, matchedQuery: query };
}

/* 刮一部剧（按 series_key 聚合，一次搜索整部剧） */
async function scrapeSeries(key, sample) {
  // 同电影：原名失败后用清洗名重试
  const { best, query, junk } = await searchWithVariants('/search/tv', sample);
  if (!best) return { ok: false, reason: junk ? '跳过：文件名里没有可识别的剧名（纯季号/技术串），请手工识别' : '未匹配到剧集' };
  const detail = await tmdbGet(`/tv/${best.id}`, { append_to_response: 'credits' });
  const posterName = await downloadImage(detail.poster_path, `tmdb-tv-${detail.id}.jpg`).catch(() => null);
  const backdropName = await downloadImage(detail.backdrop_path, `tmdb-tv-${detail.id}-bd.jpg`).catch(() => null);
  db.setSeriesTmdb(key, {
    tmdbId: detail.id,
    title: detail.name || best.name || sample.title,
    overview: detail.overview || '',
    rating: detail.vote_average || null,
    genre: genresOf(detail),
    credits: creditsOf(detail),
    officialPoster: posterName,
    backdrop: backdropName,
  });
  return { ok: true, matchedQuery: query };
}

/* 单条刮削（详情页打开时自动触发）：
   电影按该文件刮；剧集按 series_key 整剧刮（sample 取该剧第一集的标题/年份）。
   只处理「未刮削」的场景；已识别但内容错的仍走手动识别 */
async function scrapeOne({ mediaId = null, seriesKey = null } = {}) {
  if (!enabled()) return { ok: false, error: '未配置 TMDB API Key' };
  if (seriesKey) {
    const sample = db.get(
      `SELECT id, title, year FROM media_files WHERE series_key = ?
       ORDER BY season ASC, episode ASC LIMIT 1`, [seriesKey]);
    if (!sample) return { ok: false, error: '剧集中没有文件' };
    return scrapeSeries(seriesKey, sample);
  }
  const row = db.getMedia(mediaId);
  if (!row) return { ok: false, error: '条目不存在' };
  if (row.series_key) return scrapeSeries(row.series_key, row);
  return scrapeMovieRow({ id: row.id, title: row.title, year: row.year });
}

/* 找出所有待刮削对象：电影逐部、剧集逐剧（series_key 分组） */
function collectTargets() {
  const movies = db.all(
    `SELECT id, title, year FROM media_files
     WHERE kind = 'movie' AND tmdb_id IS NULL AND tmdb_at IS NULL
       AND title != ''
     GROUP BY title, IFNULL(year, 0), dir
     ORDER BY last_seen_at DESC`
  );
  const seriesRows = db.all(
    `SELECT series_key, MIN(title) AS title, MIN(year) AS year
     FROM media_files
     WHERE kind = 'episode' AND series_key IS NOT NULL AND series_key != ''
     GROUP BY series_key`
  );
  const series = seriesRows.filter((s) => {
    const cur = db.getSeriesTmdb(s.series_key);
    return cur && cur.tmdb_id ? false : true;
  });
  return { movies, series };
}

/* 刷新译名 + 补齐缺失海报：
   对所有已刮到 tmdb_id 的条目重取详情（zh-CN），tmdb_title/overview 换成中文译名与简介；
   海报/背景图已有的不重复下载，缺的才重新下载（COALESCE 保证不覆盖已有图） */
async function repairPosters({ onEvent = () => {} } = {}) {
  if (!enabled()) return { ok: false, error: '未配置 TMDB API Key' };
  let updated = 0, posters = 0, tried = 0;
  const movies = db.all(
    `SELECT tmdb_id, MIN(id) AS id FROM media_files
     WHERE kind = 'movie' AND tmdb_id IS NOT NULL
     GROUP BY tmdb_id`);
  for (const row of movies) {
    tried += 1;
    try {
      const detail = await tmdbGet(`/movie/${row.tmdb_id}`);
      const cur = db.get(
        `SELECT official_poster, backdrop FROM media_files
         WHERE tmdb_id=? AND ((official_poster IS NOT NULL AND official_poster != '') OR (backdrop IS NOT NULL AND backdrop != ''))
         LIMIT 1`, [row.tmdb_id]) || {};
      let posterName = cur.official_poster || null;
      let backdropName = cur.backdrop || null;
      if (!posterName && detail.poster_path) posterName = await downloadImage(detail.poster_path, `tmdb-movie-${detail.id}.jpg`).catch(() => null);
      if (!backdropName && detail.backdrop_path) backdropName = await downloadImage(detail.backdrop_path, `tmdb-movie-${detail.id}-bd.jpg`).catch(() => null);
      db.run(
        `UPDATE media_files SET tmdb_title=?, overview=?, rating=?, genre=COALESCE(?, genre), official_poster=COALESCE(?, official_poster), backdrop=COALESCE(?, backdrop), tmdb_at=?
         WHERE tmdb_id=?`,
        [detail.title || null, detail.overview || null, detail.vote_average ?? null, genresOf(detail) || null, posterName, backdropName, Date.now(), row.tmdb_id]
      );
      updated += 1;
      if (posterName) posters += 1;
    } catch { /* 单条失败继续 */ }
  }
  const seriesRows = db.all(
    `SELECT series_key, tmdb_id FROM series WHERE tmdb_id IS NOT NULL`);
  for (const row of seriesRows) {
    tried += 1;
    try {
      const detail = await tmdbGet(`/tv/${row.tmdb_id}`);
      const cur = db.getSeriesTmdb(row.series_key) || {};
      let posterName = cur.official_poster || null;
      let backdropName = cur.backdrop || null;
      if (!posterName && detail.poster_path) posterName = await downloadImage(detail.poster_path, `tmdb-tv-${detail.id}.jpg`).catch(() => null);
      if (!backdropName && detail.backdrop_path) backdropName = await downloadImage(detail.backdrop_path, `tmdb-tv-${detail.id}-bd.jpg`).catch(() => null);
      db.run(
        `UPDATE series SET tmdb_title=?, overview=?, rating=?, genre=COALESCE(?, genre), official_poster=COALESCE(?, official_poster), backdrop=COALESCE(?, backdrop)
         WHERE tmdb_id=?`,
        [detail.name || null, detail.overview || null, detail.vote_average ?? null, genresOf(detail) || null, posterName, backdropName, row.tmdb_id]
      );
      updated += 1;
      if (posterName) posters += 1;
    } catch { /* 单条失败继续 */ }
  }
  onEvent({ message: `译名刷新 ${updated} 组，补下海报 ${posters} 张` });
  return { ok: true, fixed: posters, tried, updated };
}
/* 类型补抓：只对「已刮到 tmdb_id 但缺 genre」的条目重取详情（不重复下海报），
   轻节流避免打爆自建代理；老库升级后分类行能自动填满 */
const genreState = { running: false, done: 0, total: 0, updated: 0, failed: 0, lastError: null, finishedAt: null };

async function backfillGenres({ onEvent = () => {}, limit = 0 } = {}) {
  if (genreState.running) return { ok: false, error: '类型补抓进行中' };
  if (!enabled()) return { ok: false, error: '未配置 TMDB API Key' };
  const movies = db.all(
    `SELECT tmdb_id FROM media_files
     WHERE kind='movie' AND tmdb_id IS NOT NULL AND IFNULL(genre,'')=''
     GROUP BY tmdb_id`);
  const seriesRows = db.all(
    `SELECT series_key, tmdb_id FROM series
     WHERE tmdb_id IS NOT NULL AND IFNULL(genre,'')=''`);
  let targets = movies.map((r) => ({ type: 'movie', id: r.tmdb_id }))
    .concat(seriesRows.map((r) => ({ type: 'tv', id: r.tmdb_id, key: r.series_key })));
  if (limit) targets = targets.slice(0, limit);
  genreState.running = true;
  genreState.done = 0; genreState.updated = 0; genreState.failed = 0; genreState.lastError = null;
  genreState.total = targets.length;
  try {
    for (const t of targets) {
      try {
        const detail = await tmdbGet(`/${t.type}/${t.id}`);
        const g = genresOf(detail);
        if (g) {
          if (t.type === 'movie') {
            db.run('UPDATE media_files SET genre=? WHERE tmdb_id=?', [g, t.id]);
          } else {
            db.run('UPDATE series SET genre=? WHERE series_key=?', [g, t.key]);
            db.run(`UPDATE media_files SET genre=COALESCE(NULLIF(genre,''), ?) WHERE series_key=?`, [g, t.key]);
          }
          genreState.updated += 1;
        }
      } catch (e) {
        genreState.failed += 1;
        genreState.lastError = String((e && e.message) || e);
      }
      genreState.done += 1;
      await new Promise((r) => setTimeout(r, 60));
    }
  } finally {
    genreState.running = false;
    genreState.finishedAt = Date.now();
  }
  onEvent({ message: `类型补抓完成：${genreState.updated}/${genreState.total}` });
  return { ok: true, ...genreState };
}

/* 后台全量刮削 */
/* 已刮削条目补抓演职员（P1+d 推荐深化，2026-09-27）：对 tmdb_id 非空的电影（按 tmdb_id 去重）
   与剧集逐个重取详情（append credits）写 credits 列。幂等：已有 credits 的默认跳过。
   独立于 scrapeAll（不抢 scrapeState），路由 POST /api/tmdb/credits-backfill 触发 */
let creditsRunning = false;
async function backfillCredits({ onEvent = () => {}, force = false } = {}) {
  if (!enabled()) return { ok: false, error: '未配置 TMDB API Key' };
  if (creditsRunning) return { ok: false, error: '演职员补抓正在进行中' };
  creditsRunning = true;
  const done0 = () => { creditsRunning = false; };
  try {
    let done = 0, failed = 0;
    const movies = db.all(`SELECT tmdb_id, MIN(id) AS id FROM media_files WHERE kind='movie' AND tmdb_id IS NOT NULL GROUP BY tmdb_id`);
    const seriesRows = db.all(`SELECT series_key, tmdb_id FROM series WHERE tmdb_id IS NOT NULL`);
    const hasMov = new Set(db.all(`SELECT DISTINCT tmdb_id AS x FROM media_files WHERE kind='movie' AND credits IS NOT NULL AND TRIM(credits) != ''`).map((r) => r.x));
    const hasSer = new Set(db.all(`SELECT series_key AS x FROM series WHERE credits IS NOT NULL AND TRIM(credits) != ''`).map((r) => r.x));
    const jobs = [];
    for (const mv of movies) if (force || !hasMov.has(mv.tmdb_id)) jobs.push({ type: 'movie', id: mv.tmdb_id });
    for (const s of seriesRows) if (force || !hasSer.has(s.series_key)) jobs.push({ type: 'series', id: s.tmdb_id, key: s.series_key });
    const total = jobs.length;
    for (const j of jobs) {
      try {
        const detail = j.type === 'movie'
          ? await tmdbGet(`/movie/${j.id}`, { append_to_response: 'credits' })
          : await tmdbGet(`/tv/${j.id}`, { append_to_response: 'credits' });
        const cr = creditsOf(detail);
        if (cr && j.type === 'movie') db.run(`UPDATE media_files SET credits=? WHERE tmdb_id=? AND kind='movie'`, [cr, j.id]);
        else if (cr) db.run(`UPDATE series SET credits=? WHERE series_key=?`, [cr, j.key]);
        done += 1;
      } catch { failed += 1; }
      if (done % 20 === 0) onEvent({ phase: 'credits', message: `演职员补抓 ${done}/${total}`, done, total });
      await new Promise((r) => setTimeout(r, 120)); // 限速
    }
    onEvent({ phase: 'credits', message: `演职员补抓完成：${done}/${total}${failed ? '（失败 ' + failed + '）' : ''}`, done, total });
    return { ok: true, done, total, failed };
  } finally { done0(); }
}

const scrapeState = { running: false, done: 0, total: 0, updated: 0, failed: 0, lastError: null, finishedAt: null };

async function scrapeAll({ onEvent = () => {} } = {}) {
  if (scrapeState.running) return { ok: false, error: '刮削正在进行中' };
  if (!enabled()) return { ok: false, error: '未配置 TMDB API Key' };
  const { movies, series } = collectTargets();
  scrapeState.running = true;
  scrapeState.done = 0;
  scrapeState.updated = 0;
  scrapeState.failed = 0;
  scrapeState.lastError = null;
  scrapeState.total = movies.length + series.length;
  onEvent({ message: `开始刮削：${movies.length} 部电影、${series.length} 部剧集` });
  const step = async (fn) => {
    try {
      const r = await fn();
      if (r && r.ok) scrapeState.updated += 1;
      else {
        scrapeState.failed += 1;
        scrapeState.lastError = (r && r.reason) || '未知原因';
      }
    } catch (e) {
      scrapeState.failed += 1;
      scrapeState.lastError = String(e && e.message);
    } finally {
      scrapeState.done += 1;
    }
  };
  for (const row of movies) {
    if (!scrapeState.running) break; // 允许中途取消
    await step(() => scrapeMovieRow(row));
  }
  for (const s of series) {
    if (!scrapeState.running) break;
    await step(() => scrapeSeries(s.series_key, s));
  }
  // 海报补齐：之前刮到评分但图片下载失败的，这轮重新下载
  let repaired = null;
  try {
    repaired = await repairPosters({ onEvent });
    if (repaired && repaired.fixed) {
      onEvent({ message: `补齐缺失海报 ${repaired.fixed} 张` });
    }
  } catch { /* 补齐失败不影响刮削结果 */ }
  scrapeState.running = false;
  scrapeState.finishedAt = Date.now();
  onEvent({ message: `刮削结束：成功 ${scrapeState.updated}，失败 ${scrapeState.failed}` + (repaired && repaired.fixed ? `，补齐海报 ${repaired.fixed}` : '') });
  return { ok: true, updated: scrapeState.updated, failed: scrapeState.failed };
}

function scrapeCancel() {
  scrapeState.running = false;
}

/* —— 手动识别：自动刮削救不回的条目，用户在界面上搜索并手动选定 —— */
async function searchCandidates({ query, kind = 'movie' }) {
  if (!enabled()) return { ok: false, error: '未配置 TMDB API Key' };
  const tv = kind === 'tv' || kind === 'episode' || kind === 'series';
  const r = await tmdbGet(tv ? '/search/tv' : '/search/movie', { query: String(query || '').trim() });
  const list = (r.results || []).slice(0, 12).map((x) => ({
    id: x.id,
    title: x.title || x.name || x.original_title || x.original_name || '',
    original: x.original_title || x.original_name || '',
    year: parseInt(String(x.release_date || x.first_air_date || '').slice(0, 4), 10) || null,
    rating: x.vote_average ? Number(Number(x.vote_average).toFixed(1)) : null,
    overview: String(x.overview || '').slice(0, 160),
    poster: x.poster_path ? `${imageBaseUrl()}/w200${x.poster_path}` : null,
  }));
  return { ok: true, list };
}

/* 应用手动选定：电影写该文件；剧集写 series_key（自动传导给全剧每一集） */
async function applyMatch({ mediaId = null, seriesKey = null, tmdbId, kind = 'movie' }) {
  if (!enabled()) return { ok: false, error: '未配置 TMDB API Key' };
  if (!tmdbId) return { ok: false, error: '缺少 tmdbId' };
  const tv = kind === 'tv' || kind === 'episode' || kind === 'series' || !!seriesKey;
  if (tv) {
    if (!seriesKey) return { ok: false, error: '缺少 seriesKey' };
    const detail = await tmdbGet(`/tv/${tmdbId}`);
    const posterName = await downloadImage(detail.poster_path, `tmdb-tv-${detail.id}.jpg`).catch(() => null);
    const backdropName = await downloadImage(detail.backdrop_path, `tmdb-tv-${detail.id}-bd.jpg`).catch(() => null);
    db.setSeriesTmdb(seriesKey, {
      tmdbId: detail.id,
      title: detail.name || '',
      overview: detail.overview || '',
      rating: detail.vote_average || null,
      officialPoster: posterName,
      backdrop: backdropName,
    });
    return { ok: true, kind: 'tv', title: detail.name || '', seriesKey };
  }
  if (!mediaId) return { ok: false, error: '缺少 mediaId' };
  const detail = await tmdbGet(`/movie/${tmdbId}`);
  const posterName = await downloadImage(detail.poster_path, `tmdb-movie-${detail.id}.jpg`).catch(() => null);
  const backdropName = await downloadImage(detail.backdrop_path, `tmdb-movie-${detail.id}-bd.jpg`).catch(() => null);
  db.setTmdbMovie(mediaId, {
    tmdbId: detail.id,
    title: detail.title || '',
    overview: detail.overview || '',
    rating: detail.vote_average || null,
    officialPoster: posterName,
    backdrop: backdropName,
  });
  return { ok: true, kind: 'movie', title: detail.title || '', mediaId };
}

/* 给任意标题搜一张官方海报（在线片源兜底用）：
   搜索 → 选年份最匹配的候选 → 下载 w780 海报到 posters 目录，返回文件名或 null */
async function searchPoster({ title, year, kind = 'movie' }) {
  const search = await tmdbGet(kind === 'episode' ? '/search/tv' : '/search/movie', {
    query: title, year: year || undefined,
  });
  const best = pickBest(search.results, year);
  if (!best || !best.poster_path) return null;
  return downloadImage(best.poster_path, `tmdb-${kind === 'episode' ? 'tv' : 'movie'}-${best.id}.jpg`);
}

/* 下载海报图（自定义海报用）。三级兜底：
   ① 直接下载；② 响应是网页（text/html）→ 提取 og:image 再下（覆盖「贴豆瓣/TMDB 条目页」）；
   ③ 403/429 防盗链 → 带 Referer 重试。错误信息说人话（DNS/超时/拒绝连接/防盗链） */
const POSTER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
async function fetchPosterImage(u) {
  const download = async (target, referer) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const headers = { 'User-Agent': POSTER_UA };
      if (referer) headers.Referer = referer;
      const res = await fetch(target, { signal: ctrl.signal, headers, redirect: 'follow' });
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      const raw = Buffer.from(await res.arrayBuffer());
      // 网页嗅探：content-type 明示 text/html，或内容开头像 HTML（豆瓣等反爬页不带 content-type）
      const head = raw.slice(0, 512).toString('utf8').toLowerCase();
      const isHtml = ct.includes('text/html') || head.includes('<!doctype') || head.includes('<html');
      if (isHtml) {
        const html = raw.toString('utf8');
        // 抓 og:image（TMDB 条目页等有）；豆瓣反爬页没有 → 引导用户复制图片直链
        const m = /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i.exec(html)
          || /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url)?["']/i.exec(html);
        if (!m) {
          if (!res.ok) throw new Error(`站点拒绝访问（HTTP ${res.status}）：请在图片上右键「复制图片地址」后重贴，或直接上传本地图片`);
          throw new Error('该链接是网页且没找到海报图，请在网页上右键海报→「复制图片地址」后再贴');
        }
        const imgUrl = new URL(m[1], target).href;
        const r2 = await fetch(imgUrl, { signal: ctrl.signal, headers: { 'User-Agent': POSTER_UA, Referer: new URL(target).origin } });
        if (!r2.ok) throw new Error(`海报图下载失败 HTTP ${r2.status}，建议直接上传本地图片`);
        return Buffer.from(await r2.arrayBuffer());
      }
      if (!res.ok) {
        if ((res.status === 403 || res.status === 429) && !referer) {
          const r2 = await fetch(target, { signal: ctrl.signal, headers: { 'User-Agent': POSTER_UA, Referer: new URL(target).origin } });
          if (r2.ok) return Buffer.from(await r2.arrayBuffer());
          throw new Error(`图床拒绝外链（HTTP ${res.status}），建议把图片存到本机后用「上传本地图片」`);
        }
        throw new Error(`图片下载失败 HTTP ${res.status}`);
      }
      return raw;
    } catch (e) {
      if (e instanceof TypeError && e.message === 'fetch failed' && e.cause) {
        const code = e.cause.code || '';
        if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') throw new Error('域名解析失败：NAS 的 DNS 可能没配好（建议 223.5.5.5）');
        if (code === 'ECONNREFUSED') throw new Error('连接被拒绝：地址或端口不对');
        if (code === 'ECONNRESET') throw new Error('连接被重置：该站点可能不可达');
        if (code && code.startsWith('CERT')) throw new Error('HTTPS 证书异常：换个 http 链接或上传本地图片');
      }
      if (e.name === 'AbortError') throw new Error('下载超时（30 秒）：站点太慢或不可达');
      throw e;
    } finally {
      clearTimeout(t);
    }
  };
  return download(u, null);
}

/* 自定义海报：TMDB 上没有海报（冷门剧）或图不理想时，用户贴图片 URL 或上传本地图片。
   不走 TMDB、无需 Key；剧集整剧生效（series 行 + 传导每一集），电影写该文件。
   图片做魔数嗅探防「把网页当图片」，随机文件名过 /poster 白名单 */
async function setCustomPoster({ mediaId = null, seriesKey = null, url = null, dataUrl = null }) {
  let buf = null;
  if (dataUrl) {
    const dm = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl));
    if (!dm) return { ok: false, error: '上传数据不是有效的 base64 图片' };
    try { buf = Buffer.from(dm[1], 'base64'); } catch { return { ok: false, error: '图片解码失败' }; }
  } else if (url) {
    let u;
    try { u = new URL(String(url)); } catch { return { ok: false, error: '图片链接格式不对' }; }
    if (!/^https?:$/.test(u.protocol)) return { ok: false, error: '只支持 http/https 图片链接' };
    try {
      buf = await fetchPosterImage(u);
    } catch (e) {
      return { ok: false, error: e && e.message ? String(e.message) : '图片下载失败' };
    }
  } else {
    return { ok: false, error: '请提供图片链接或选择本地图片' };
  }
  if (!buf || buf.length < 1024) return { ok: false, error: '图片内容过小' };
  if (buf.length > 15 * 1024 * 1024) return { ok: false, error: '图片超过 15MB，请压缩后再试' };
  let ext = null;
  if (buf[0] === 0xff && buf[1] === 0xd8) ext = 'jpg';
  else if (buf[0] === 0x89 && buf[1] === 0x50) ext = 'png';
  else if (buf.slice(0, 3).toString('ascii').toUpperCase() === 'GIF') ext = 'gif';
  else if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') ext = 'webp';
  if (!ext) return { ok: false, error: '不是有效的图片（支持 jpg/png/webp/gif）' };
  const name = `custom-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  try {
    await fsp.writeFile(path.join(dirs.posters(), name), buf);
  } catch (e) {
    return { ok: false, error: `海报保存失败：${e && e.message}` };
  }
  try {
    if (seriesKey) { db.setSeriesPoster(seriesKey, name); return { ok: true, kind: 'tv', poster: name }; }
    if (mediaId) { db.setMediaPoster(mediaId, name); return { ok: true, kind: 'movie', poster: name }; }
    return { ok: false, error: '缺少目标条目（mediaId/seriesKey）' };
  } catch (e) {
    return { ok: false, error: `写库失败：${e && e.message}` };
  }
}

module.exports = { backfillCredits,
  enabled, apiKey, baseUrl, imageBaseUrl, searchPoster, repairPosters, tmdbGet,
  scrapeAll, scrapeCancel, scrapeState,
  backfillGenres, genreState, genresOf,
  collectTargets, pickBest, scrapeMovieRow, scrapeSeries, scrapeOne, downloadImage,
  cleanTitle, nameVariants, plausibleMatch, searchCandidates, applyMatch, setCustomPoster,
};
