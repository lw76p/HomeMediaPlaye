'use strict';
// 在线热歌（网易云公开榜单 + 免费直链试听）
// 逻辑移植自用户的桌面程序「流行歌曲在线听 v3.30」：
//  - 榜单：华语=热歌/新歌/飙升三榜合并，欧美=欧美热歌/新歌两榜合并；流派子榜=歌单搜索 top3 合并
//  - 屏蔽 VIP/付费（fee 1/4）与下架/试听片段（v3/song/detail privileges）
//  - 试听直链：网易云免费 outer URL → 酷我 → 酷狗 三级解析，Range 探测验证
//  - 每日缓存：region|genre 各一份 JSON，当天直接复用
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const paths = require('./paths');

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const GENRE_TARGET = 300;          // 流派子榜合并目标数
const CHART_V = 1;                 // 榜单缓存结构版本

// 官方榜单 id（网易云公开歌单）
const HOT_LISTS = [[3778678, '热歌榜'], [3779629, '新歌榜'], [19723756, '飙升榜']];
const EU_LISTS = [[2809513713, '欧美热歌榜'], [2809577409, '欧美新歌榜']];

const GENRES = {
  cn: {
    pop:  { label: '流行', official: HOT_LISTS },
    qing: { label: '抒情', kws: ['华语抒情 流行', '抒情歌曲 经典', '伤感抒情歌单'] },
    folk: { label: '民谣', kws: ['华语民谣', '民谣精选', '原创民谣'] },
    rock: { label: '摇滚', kws: ['华语摇滚', '摇滚经典', '乐队摇滚'] },
  },
  eu: {
    pop:   { label: '流行', official: EU_LISTS },
    jazz:  { label: '爵士', kws: ['经典爵士', '爵士乐 精选', 'Jazz'] },
    blues: { label: '蓝调', kws: ['蓝调经典', 'Blues 精选', '布鲁斯'] },
    rock:  { label: '摇滚', kws: ['欧美摇滚', '经典摇滚', '摇滚史诗'] },
  },
};

const cacheDir = () => path.join(paths.dirs.cache(), 'online-charts');
const chartCachePath = (region, genre) => path.join(cacheDir(), `chart-${region}-${genre}.json`);

function init() {
  try { fs.mkdirSync(cacheDir(), { recursive: true }); } catch {}
  // 启动 90s 后预热全部榜单（缺当日缓存的才抓，串行抓避免打满出口带宽）
  setTimeout(async () => {
    for (const region of Object.keys(GENRES)) {
      for (const genre of Object.keys(GENRES[region])) {
        try {
          const today = new Date().toISOString().slice(0, 10);
          const cp = chartCachePath(region, genre);
          const fresh = fs.existsSync(cp) && (() => { try { const d = JSON.parse(fs.readFileSync(cp, 'utf8')); return d.date === today && d.songs?.length; } catch { return false; } })();
          if (!fresh) await fetchChart(region, genre, false);
        } catch {}
      }
    }
  }, 90 * 1000).unref();
}

async function httpJson(url, referer, timeout = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': UA_DESKTOP, Referer: referer || 'https://music.163.com/' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

// 试听不完整判定：官方试听片段 / 下架无版权 / 无任何可播码率
function privBad(p) {
  if (!p) return false;
  if (p.freeTrialInfo) return true;
  if ((p.st ?? 0) < 0) return true;
  if (!p.pl) return true;
  return false;
}

// 批量 v3/song/detail：返回 {songs, privs:{id:privilege}}（分批并行，并发 4）
async function songDetailBatch(ids) {
  const out = { songs: [], privs: {} };
  const list = [...ids];
  const chunks = [];
  for (let i = 0; i < list.length; i += 50) chunks.push(list.slice(i, i + 50));
  let done = 0;
  const pull = async (chunk) => {
    try {
      const cval = encodeURIComponent(JSON.stringify(chunk.map((x) => ({ id: x }))));
      const js = await httpJson('https://music.163.com/api/v3/song/detail?c=' + cval + '&ids=' + cval);
      for (const t of js.songs || []) {
        if (!('artists' in t)) { t.artists = t.ar || []; t.album = t.al || {}; t.duration = t.dt || 0; }
        out.songs.push(t);
      }
      for (const pr of js.privileges || []) if (pr.id != null) out.privs[pr.id] = pr;
    } catch {}
    done++;
  };
  // 简单并发池：每次取一批，完成再补
  let next = 0;
  const worker = async () => { while (next < chunks.length) { const c = chunks[next++]; await pull(c); } };
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker));
  return out;
}

// 歌单搜索合并：每个关键词取播放量最高的歌单，凑满 3 张（关键词并行搜索）
async function genrePool(kws) {
  const seen = new Set(); const pools = [];
  const results = await Promise.all(kws.map((kw) =>
    httpJson('https://music.163.com/api/search/get?' + new URLSearchParams({ s: kw, type: 1000, limit: 3 })).catch(() => null)));
  for (const js of results) {
    for (const pl of (js && js.result?.playlists) || []) {
      if (pl.id && !seen.has(pl.id)) { seen.add(pl.id); pools.push([pl.id, (pl.name || '').slice(0, 24), pl.playCount || 0]); }
    }
    if (pools.length >= 3) break;
  }
  pools.sort((a, b) => b[2] - a[2]);
  return pools.slice(0, 3);
}

// 歌单全量曲目 ID（v6 接口的 trackIds 全量保留）
async function playlistTrackIds(pid) {
  const js = await httpJson(`https://music.163.com/api/v6/playlist/detail?id=${pid}&n=1000`);
  const out = [];
  for (const t of js.playlist?.trackIds || []) out.push(typeof t === 'object' ? t.id : t);
  return out.filter(Boolean);
}

async function fetchChart(region, genre, force) {
  region = region === 'eu' ? 'eu' : 'cn';
  const gkey = GENRES[region][genre] ? genre : 'pop';
  const spec = GENRES[region][gkey];
  const today = new Date().toISOString().slice(0, 10);
  const cpath = chartCachePath(region, gkey);
  // 1) 当日缓存直接返回
  if (!force && fs.existsSync(cpath)) {
    try {
      const data = JSON.parse(fs.readFileSync(cpath, 'utf8'));
      if (data.v === CHART_V && data.date === today && data.songs?.length) return { ...data, from_cache: true };
    } catch {}
  }
  // 2) 联网抓取
  const merged = []; const seen = new Set(); const sources = [];
  let blocked = 0; let removedDead = 0;
  const pushSong = (name, artist, from, pic, dur) => {
    if (!name) return;
    const key = name + '|' + artist;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push({ name, artist, from, pic: pic || '', duration: dur || 0 });
  };
  if (spec.official) {
    // 官方榜路径（playlist/detail 带 tracks 与 id，三榜并行抓，抓完统一过 privileges 剔除坏源）
    const withIds = [];
    const lists = await Promise.all(spec.official.map(([pid]) =>
      httpJson(`https://music.163.com/api/playlist/detail?id=${pid}`).catch(() => null)));
    spec.official.forEach(([pid, name], i) => {
      const js = lists[i];
      if (!js) return;
      let kept = 0;
      for (const t of js.result?.tracks || []) {
        if (!t.name) continue;
        if (t.fee === 1 || t.fee === 4) { blocked++; continue; }
        const artist = (t.artists || []).map((a) => a.name).join('/');
        const key = t.name + '|' + artist;
        if (seen.has(key)) continue;
        seen.add(key);
        withIds.push({ name: t.name, artist, from: name, pic: t.album?.picUrl || '', duration: t.duration || 0, _id: t.id });
        kept++;
      }
      sources.push(`${name}${kept}首`);
    });
    const det = await songDetailBatch(withIds.map((s) => s._id));
    for (const s of withIds) {
      if (privBad(det.privs[s._id])) { removedDead++; continue; }
      const { _id, ...rest } = s;
      merged.push(rest);
    }
  } else {
    // 流派子榜路径：搜索播放量最高的 3 张歌单，并行拉曲目，合并一次校验
    const pools = await genrePool(spec.kws);
    const idLists = await Promise.all(pools.map(([pid]) => playlistTrackIds(pid).catch(() => [])));
    const allIds = [];
    const idSource = [];   // id -> 歌单名（保持来源标注）
    for (let i = 0; i < pools.length; i++) {
      for (const id of (idLists[i] || []).slice(0, 400)) { allIds.push(id); idSource.push(pools[i][1]); }
    }
    if (allIds.length) {
      const det = await songDetailBatch(allIds);
      const byId = new Map(det.songs.map((t) => [t.id, t]));
      for (let i = 0; i < allIds.length && merged.length < GENRE_TARGET; i++) {
        const t = byId.get(allIds[i]);
        if (!t || !t.name) continue;
        if (t.fee === 1 || t.fee === 4) { blocked++; continue; }
        if (privBad(det.privs[t.id])) { removedDead++; continue; }
        pushSong(t.name, (t.artists || []).map((a) => a.name).join('/'), idSource[i], t.album?.picUrl || '', t.duration || 0);
      }
      sources.push(pools.map((p) => p[1]).join('、'));
    }
  }
  if (merged.length) {
    const result = { ok: true, v: CHART_V, region, genre: gkey, date: today, songs: merged, blocked, removed: removedDead, source: sources.join('、') };
    try { fs.mkdirSync(cacheDir(), { recursive: true }); fs.writeFileSync(cpath, JSON.stringify(result)); } catch {}
    return result;
  }
  // 3) 网络失败用旧缓存兜底
  if (fs.existsSync(cpath)) {
    try {
      const data = JSON.parse(fs.readFileSync(cpath, 'utf8'));
      return { ...data, from_cache: true, stale: true };
    } catch {}
  }
  return { ok: false, region, genre: gkey, date: today, songs: [] };
}

/* ---------------- 试听直链解析：网易云免费 → 酷我 → 酷狗 ---------------- */
const srcCache = new Map();     // 'name|artist' -> {ok,result,exp}
const breaker = new Map();      // src -> {fails, until}
const SRC_TTL = 60 * 60 * 1000;
const BREAK_SKIP = 10 * 60 * 1000;

function breakerOpen(k) { const b = breaker.get(k); return b && b.until > Date.now(); }
function breakerRecord(k, ok) {
  const b = breaker.get(k) || { fails: 0, until: 0 };
  if (ok) { b.fails = 0; b.until = 0; } else { b.fails++; if (b.fails >= 3) b.until = Date.now() + BREAK_SKIP; }
  breaker.set(k, b);
}

// Range 探测：Content-Type 为音频且总量 >100KB 视为完整可播直链
async function checkAudioUrl(url, referer) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA_DESKTOP, Referer: referer || 'https://music.163.com/', Range: 'bytes=0-1' }, redirect: 'follow' });
    clearTimeout(timer);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    let total = null;
    const cr = r.headers.get('content-range') || '';
    const m = cr.match(/bytes \d+-\d+\/(\d+|\*)/);
    if (m && m[1] !== '*') total = parseInt(m[1], 10);
    else if (r.headers.get('content-length')) total = parseInt(r.headers.get('content-length'), 10);
    const okType = /audio|mpeg|octet|mp4/.test(ct);
    return okType && (total == null || total > 100000);
  } catch { return false; }
}

async function neteaseResolve(name, artist) {
  const kw = (name + ' ' + artist).trim();
  const js = await httpJson('https://music.163.com/api/search/get?' + new URLSearchParams({ s: kw, type: 1, limit: 3 }));
  const s = (js.result?.songs || [])[0];
  if (!s) return null;
  if (s.fee !== 0 && s.fee !== 8) return null;   // VIP：网易云源无免费完整版
  const outer = `https://music.163.com/song/media/outer/url?id=${s.id}.mp3`;
  if (!(await checkAudioUrl(outer))) return null;
  return { url: outer, referer: 'https://music.163.com/', srcLabel: '网易云免费', name: s.name, artist: (s.artists || []).map((a) => a.name).join('/'), duration: s.duration || 0 };
}

async function kuwoResolve(name, artist) {
  const kw = (name + ' ' + artist).trim();
  const js = await httpJson('http://search.kuwo.cn/r.s?' + new URLSearchParams({ all: kw, ft: 'music', itemset: 'web_2013', client: 'mp', pn: 0, rn: 3, rformat: 'json', encoding: 'utf8', vipver: 'MUSIC_8.0.3.0' }));
  const top = (js.abslist || [])[0];
  if (!top) return null;
  const rid = String(top.MUSICRID || '').replace('MUSIC_', '');
  if (!/^\d+$/.test(rid)) return null;
  const pjs = await httpJson('https://www.kuwo.cn/api/v1/www/music/playUrl?' + new URLSearchParams({ mid: rid, type: 'music', httpsStatus: 1, reqId: String(Date.now()) }), 'https://www.kuwo.cn/', 6000);
  const purl = pjs.data?.url || '';
  if (pjs.code !== 200 || !purl) return null;
  if (!(await checkAudioUrl(purl, 'https://www.kuwo.cn/'))) return null;
  return { url: purl, referer: 'https://www.kuwo.cn/', srcLabel: '酷我免费', name: String(top.SONGNAME || name), artist: String(top.ARTIST || artist), duration: (parseInt(top.DURATION, 10) || 0) * 1000 };
}

async function kugouResolve(name, artist) {
  const kw = (name + ' ' + artist).trim();
  const js = await httpJson('http://mobilecdn.kugou.com/api/v3/search/song?' + new URLSearchParams({ format: 'json', keyword: kw, page: 1, pagesize: 3 }), null, 6000);
  const top = (js.data?.info || [])[0];
  if (!top) return null;
  const pjs = await httpJson('http://m.kugou.com/app/i/getSongInfo.php?' + new URLSearchParams({ cmd: 'playInfo', hash: top.hash || '', album_id: top.album_id || '', mid: crypto.randomBytes(8).toString('hex') }), null, 6000);
  const purl = pjs.url || '';
  if (pjs.status !== 1 || !purl) return null;
  if (!(await checkAudioUrl(purl))) return null;
  return { url: purl, referer: '', srcLabel: '酷狗免费', name: top.songname || name, artist: top.singername || artist, duration: (parseInt(top.duration, 10) || 0) * 1000 };
}

const SOURCERS = [['netease', neteaseResolve], ['kuwo', kuwoResolve], ['kugou', kugouResolve]];

// 解析一首歌的可播直链；带内存缓存 + 熔断
async function resolveSource(name, artist) {
  name = (name || '').trim(); artist = (artist || '').trim();
  if (!name) return { ok: false, msg: '缺少歌曲名' };
  const key = name + '|' + artist;
  const c = srcCache.get(key);
  if (c && c.exp > Date.now()) return c.result;
  let result = null;
  for (const [k, fn] of SOURCERS) {
    if (breakerOpen(k)) continue;
    try { result = await fn(name, artist); } catch { result = null; }
    breakerRecord(k, !!result);
    if (result) break;
  }
  const ret = result ? { ok: true, ...result } : { ok: false };
  srcCache.set(key, { result: ret, exp: Date.now() + (ret.ok ? SRC_TTL : 5 * 60 * 1000) });
  if (srcCache.size > 500) {   // 防膨胀：清最早一半
    const ks = [...srcCache.keys()].slice(0, 250);
    for (const k of ks) srcCache.delete(k);
  }
  return ret;
}

/* ---------------- 直链 token 注册表（流代理用） ---------------- */
const tokens = new Map();   // token -> {url, referer, exp}
const TOKEN_TTL = 6 * 60 * 60 * 1000;

function registerToken(url, referer) {
  const token = crypto.randomBytes(12).toString('hex');
  tokens.set(token, { url, referer: referer || '', exp: Date.now() + TOKEN_TTL });
  if (tokens.size > 200) {
    for (const [k, v] of tokens) { if (v.exp < Date.now()) tokens.delete(k); }
    const ks = [...tokens.keys()].slice(0, 100);
    for (const k of ks) tokens.delete(k);
  }
  return token;
}
function getToken(token) {
  const t = tokens.get(token);
  if (!t || t.exp < Date.now()) return null;
  return t;
}

// 在途去重：同一榜单并发请求合并为一次抓取（避免连点流派触发多份重复慢抓）
const chartInflight = new Map();
function fetchChartDedup(region, genre, force) {
  const k = (region === 'eu' ? 'eu' : 'cn') + '|' + (GENRES[region === 'eu' ? 'eu' : 'cn'][genre] ? genre : 'pop') + '|' + (force ? 'f' : 'c');
  if (chartInflight.has(k)) return chartInflight.get(k);
  const p = fetchChart(region, genre, force).finally(() => chartInflight.delete(k));
  chartInflight.set(k, p);
  return p;
}

module.exports = { init, fetchChart: fetchChartDedup, resolveSource, registerToken, getToken, GENRES };
