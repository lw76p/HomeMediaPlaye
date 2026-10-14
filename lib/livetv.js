'use strict';
// 电视直播：JSON 频道片单（机制与在线观看片单一致）
// 设计约束：
//  - 频道片单 settings: liveTvCatalogUrl，http(s) 地址或本地/NAS 文件路径均可，12h 自动刷新，失败保旧缓存
//  - 内置频道仅收录官方公开直播与公开测试直播流；自配片单完全替换内置
//  - Web 端 m3u8 经同源代理重写（hls.js 免 CORS）；桌面端 mpv 直接播 URL
const fs = require('node:fs');
const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const db = require('./db');
const pathsMod = require('./paths');

/* ---------------- 内置频道（官方公开 / 公开测试直播流，自配片单后完全替换） ---------------- */
const DEFAULT_CHANNELS = [
  {
    id: 'akamai-live-test',
    name: '公开测试直播流 · Akamai',
    group: '测试直播',
    url: 'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8',
    note: 'Akamai 公开测试直播',
  },
  {
    id: 'us-live-scte35',
    name: '公开测试直播流 · SCTE-35',
    group: '测试直播',
    url: 'https://demo.unified-streaming.com/k8s/live/stable/scte35.isml/.m3u8',
    note: 'Unified Streaming 公开测试直播',
  },
  {
    id: 'mux-bbb-hls',
    name: '公开测试流 · 大雄兔多码率',
    group: '测试直播',
    url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    note: 'Mux 公开测试流',
  },
  {
    id: 'dw-en',
    name: 'DW 德国之声 · 英语新闻',
    group: '国际新闻',
    url: 'https://dwamdstream102.akamaized.net/hls/live/2015525/dwstream102/index.m3u8',
    note: 'DW 官方公开直播',
  },
  {
    id: 'france24-en',
    name: 'France 24 · 英语新闻',
    group: '国际新闻',
    url: 'https://static.france24.com/live/F24_EN_LO_HLS/live_web.m3u8',
    note: 'France 24 官方公开直播',
  },
  {
    id: 'cgtn-doc',
    name: 'CGTN 纪录频道',
    group: '纪实',
    url: 'https://livedoc.cgtn.com/500d/prog_index.m3u8',
    note: 'CGTN 官方公开直播',
  },
  {
    id: 'nasa-tv',
    name: 'NASA TV',
    group: '科学',
    url: 'https://ntv1.akamaized.net/hls/live/2014075/NASA-NTV1-HLS/master.m3u8',
    note: 'NASA 官方公开直播（如失效以自配片单为准）',
  },
  {
    id: 'redbull-tv',
    name: 'Red Bull TV',
    group: '体育',
    url: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8',
    note: 'Red Bull TV 官方免费直播',
  },
];

const REFRESH_TTL = 12 * 60 * 60 * 1000; // 12h
const KEY = 'liveTvCatalog';

let memoryChannels = null;

function settingGet(key, fallback) {
  try {
    return db.getSetting(key, fallback);
  } catch {
    return fallback;
  }
}

function settingSet(key, value) {
  try {
    db.setSetting(key, value);
  } catch {
    /* ignore */
  }
}

async function fetchJson(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/* M3U/M3U8 播放列表 → 频道数组：#EXTINF 行取 tvg-logo / group-title 属性，逗号后为频道名 */
function parseM3U(text) {
  const out = [];
  let pending = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.toUpperCase().startsWith('#EXTINF')) {
      const meta = line.slice(line.indexOf(':') + 1);
      const commaIdx = meta.lastIndexOf(',');
      const attrs = commaIdx >= 0 ? meta.slice(0, commaIdx) : meta;
      const name = commaIdx >= 0 ? meta.slice(commaIdx + 1).trim() : '';
      const attr = (k) => {
        const m = attrs.match(new RegExp(k + '="([^"]*)"', 'i'));
        return m ? m[1] : '';
      };
      pending = {
        name,
        group: attr('group-title') || '全部频道',
        logo: attr('tvg-logo') || '',
      };
    } else if (line.startsWith('#')) {
      continue; // 其他注释行忽略
    } else if (pending) {
      pending.url = line;
      out.push(pending);
      pending = null;
    } else {
      out.push({ name: line, url: line, group: '全部频道' }); // 裸地址行
    }
  }
  return out;
}

/* ---------------- 自定义直播源（管理后台维护，持久化到 data/livetv-sources.json） ---------------- */
const SOURCES_FILE = () => pathsMod.dirs.root().replace(/\\/g, '/') + '/livetv-sources.json';
// 内置去广告关键词：频道名或地址命中即从片单剔除；可再叠加设置页自定义关键词（逗号分隔）
const AD_KEYWORDS_DEFAULT = ['广告', '购物', '推广', '挂机', '招租', '测试卡', '色情', '彩票'];

function readSourcesFile() {
  try { return JSON.parse(fs.readFileSync(SOURCES_FILE(), 'utf8')); } catch { return null; }
}

function writeSourcesFile(data) {
  const file = SOURCES_FILE();
  pathsMod.ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  memoryChannels = null;
}

function getAdKeywords() {
  const extra = String(settingGet('livetvAdKeywords', '') || '');
  return [...new Set([...AD_KEYWORDS_DEFAULT, ...extra.split(/[,，\s]+/).filter(Boolean)])];
}

function normalizeSource(raw, i) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  const url = String(raw.url || '').trim();
  if (!name || !url) return null;
  if (!/^(https?|rtmp|rtsp):\/\//i.test(url)) return null;
  return {
    id: raw.id ? String(raw.id) : 'src-' + crypto.createHash('md5').update(url).digest('hex').slice(0, 10),
    name,
    url,
    group: String(raw.group || '').trim() || '全部频道',
    tags: Array.isArray(raw.tags) ? raw.tags.map(String).filter(Boolean).slice(0, 6) : [],
    priority: Number.isFinite(Number(raw.priority)) ? Math.max(0, Math.min(99, parseInt(raw.priority, 10) || 0)) : 0,
    note: String(raw.note || '').trim(),
    enabled: raw.enabled !== false,
    addedAt: raw.addedAt || Date.now(),
    _i: i,
  };
}

function listSources() {
  const data = readSourcesFile();
  const sources = data && Array.isArray(data.sources) ? data.sources : [];
  return sources
    .map((x, i) => normalizeSource(x, i))
    .filter(Boolean)
    .sort((a, b) => b.priority - a.priority || a._i - b._i);
}

function hasEnabledCustom() {
  return listSources().some((s) => s.enabled);
}

function adminOverview() {
  const cache = readSubCache();
  return {
    sources: listSources().map(({ _i, ...rest }) => {
      const hit = cache[rest.id];
      return {
        ...rest,
        kind: hit ? hit.kind : 'new',
        count: hit && Array.isArray(hit.items) ? hit.items.length : 0,
        syncedAt: hit ? hit.ts : 0,
        syncError: hit && hit.kind === 'error' ? (hit.error || '') : '',
      };
    }),
    usingCustom: hasEnabledCustom(),
    customOnly: customOnlyMode(),
    file: SOURCES_FILE(),
    adKeywords: getAdKeywords().join('，'),
  };
}

function addSource(rec) {
  const data = readSourcesFile() || { updated_at: 0, sources: [] };
  if (!Array.isArray(data.sources)) data.sources = [];
  const norm = normalizeSource({ ...rec, id: '' }, data.sources.length);
  if (!norm) throw new Error('名称与 http(s)/rtmp 地址都要填');
  if (data.sources.some((x) => x.url === norm.url)) throw new Error('该地址已存在：' + norm.url);
  data.sources.push(norm);
  data.updated_at = Date.now();
  writeSourcesFile(data);
  return norm.id;
}

function updateSource(id, patch) {
  const data = readSourcesFile() || { updated_at: 0, sources: [] };
  const it = (data.sources || []).find((x) => x.id === id);
  if (!it) throw new Error('源不存在');
  const merged = normalizeSource({ ...it, ...patch }, 0);
  if (!merged) throw new Error('名称与 http(s)/rtmp 地址都要填');
  const urlChanged = String(it.url || '').trim() !== String(merged.url || '').trim();
  Object.assign(it, merged, { id }); // id 保持不变
  data.updated_at = Date.now();
  writeSourcesFile(data);
  if (urlChanged) {
    // 地址换了 → 旧展开结果立刻作废，否则改完仍按旧内容显示，看起来像「编辑无效」
    const cache = readSubCache();
    delete cache[id];
    writeSubCache(cache);
  }
  return it;
}

function removeSource(id) {
  const data = readSourcesFile() || { updated_at: 0, sources: [] };
  const before = (data.sources || []).length;
  data.sources = (data.sources || []).filter((x) => x.id !== id);
  data.updated_at = Date.now();
  writeSourcesFile(data);
  const cache = readSubCache();
  if (cache[id]) { delete cache[id]; writeSubCache(cache); }
  return before - data.sources.length;
}

/* 导入：m3u / JSON（数组或 {items|channels}），合并按地址去重，替换清空再导 */
function importSources(text, mode) {
  const t = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!t) throw new Error('内容为空');
  let items;
  if (t.startsWith('#EXTM3U') || t.includes('#EXTINF')) items = parseM3U(t);
  else {
    const data = JSON.parse(t);
    items = Array.isArray(data) ? data : data.items || data.channels || [];
    if (Array.isArray(items) && items.length && typeof items[0] === 'string') {
      items = items.map((u) => ({ name: u.split('/').pop() || u, url: u }));
    }
  }
  const norm = items.map((x) => normalizeSource({ ...x, enabled: true }, 0)).filter(Boolean);
  if (!norm.length) throw new Error('没有可识别的频道（每条需名称 + http(s) 地址）');
  const data = mode === 'replace' ? { updated_at: 0, sources: [] } : (readSourcesFile() || { updated_at: 0, sources: [] });
  if (!Array.isArray(data.sources)) data.sources = [];
  const seen = new Set(data.sources.map((x) => x.url));
  let added = 0;
  for (const x of norm) {
    if (seen.has(x.url)) continue;
    seen.add(x.url);
    data.sources.push(x);
    added++;
  }
  data.updated_at = Date.now();
  writeSourcesFile(data);
  return { added, total: data.sources.length };
}

function exportSources(fmt) {
  const sources = listSources();
  if (fmt === 'json') return JSON.stringify({ updated_at: Date.now(), sources }, null, 2);
  const lines = ['#EXTM3U'];
  for (const s of sources) {
    lines.push(`#EXTINF:-1 tvg-name="${s.name}" group-title="${s.group}",${s.name}`);
    lines.push(s.url);
  }
  return lines.join('\n') + '\n';
}

/* 去广告：频道名/地址命中关键词的直接从源文件剔除 */
function filterAdsSources(customKeywords) {
  const data = readSourcesFile() || { updated_at: 0, sources: [] };
  if (!Array.isArray(data.sources)) data.sources = [];
  const kws = [...new Set([...AD_KEYWORDS_DEFAULT, ...(Array.isArray(customKeywords) ? customKeywords : [])])];
  const before = data.sources.length;
  const hit = (s) => kws.some((k) => (s.name || '').toLowerCase().includes(k.toLowerCase()) || (s.url || '').toLowerCase().includes(k.toLowerCase()));
  data.sources = data.sources.filter((x) => !hit(x));
  data.updated_at = Date.now();
  writeSourcesFile(data);
  const keep = new Set(data.sources.map((x) => x.id)); // 顺手清掉被删源的展开缓存
  const cache = readSubCache();
  let dirty = false;
  for (const k of Object.keys(cache)) if (!keep.has(k)) { delete cache[k]; dirty = true; }
  if (dirty) writeSubCache(cache);
  return { removed: before - data.sources.length, kept: data.sources.length };
}

/* 应用生效：立刻拉取所有启用源（订阅型展开成多条频道）并刷新频道缓存。
   不再往 KEY 里写『custom』假片单 —— 那样会把用户自己配的远程片单整个挤掉。 */
async function applyCustom() {
  const on = listSources().filter((s) => s.enabled);
  if (!on.length) throw new Error('没有启用的源，先启用至少一个');
  const detail = await syncSources({ force: true });
  const cached = settingGet(KEY, null);
  if (cached && cached.from === 'custom') settingSet(KEY, null); // 清掉旧写法塞进去的自定义片单
  memoryChannels = null;
  return { channels: channels().length, detail };
}

/* 「只用我的源」开关：关=我的源叠加在原有频道上，开=只显示我添加的源 */
function customOnlyMode() {
  return String(settingGet('livetvCustomOnly', '0')) === '1';
}

function setCustomOnly(on) {
  settingSet('livetvCustomOnly', on ? '1' : '0');
  memoryChannels = null;
  return customOnlyMode();
}

/* 测速：HEAD 探测响应耗时；HEAD 不行就拉前 1KB */
async function speedtestUrl(url, timeoutMs = 6000) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, redirect: 'follow' });
    return { ok: res.ok || res.status < 500, status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    try {
      const res2 = await fetch(url, { headers: { Range: 'bytes=0-1023' }, signal: ctrl.signal, redirect: 'follow' });
      return { ok: res2.ok, status: res2.status, ms: Date.now() - t0 };
    } catch (e2) {
      return { ok: false, status: 0, ms: Date.now() - t0, error: /abort/i.test(String(e2.message)) ? '超时' : '不可达' };
    }
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- 片单刷新（与在线片单同机制） ---------------- */

function normalizeChannel(raw, i) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || raw.title || '').trim();
  const url = String(raw.url || raw.stream || '').trim();
  if (!name || !url) return null;
  const group = String(raw.group || raw.category || '').trim() || '全部频道';
  const id = raw.id
    ? String(raw.id)
    : 'ch-' + crypto.createHash('md5').update(name + '|' + url).digest('hex').slice(0, 10);
  return {
    id,
    name,
    group,
    url,
    logo: String(raw.logo || raw.posterUrl || '').trim() || null,
    hls: /\.m3u8($|\?)/i.test(url) || !!raw.hls,
    note: String(raw.note || raw.license || '').trim(),
    _i: i,
  };
}

async function refreshCatalog({ force = false } = {}) {
  // 自定义源是「叠加」而不是「替换」：有自定义源时远程片单照旧刷新，两边合并后一起展示。
  // （此前只要有自定义源就跳过刷新，等于把原来配好的远程片单整个雪藏掉）
  const cached = settingGet(KEY, null);
  const remoteUrl = settingGet('liveTvCatalogUrl', null) || process.env.HMP_LIVETV_CATALOG_URL || null;
  if (
    !force &&
    cached && remoteUrl && cached.from === remoteUrl &&
    Date.now() - cached.fetchedAt < REFRESH_TTL
  ) {
    return false; // 缓存仍然新鲜
  }
  if (!remoteUrl) return false; // 未配置片单地址，用内置频道
  try {
    // 片单地址兼容：http(s) 远程地址 / 本地或 NAS 挂载盘上的文件路径；格式自动识别 JSON / M3U
    let text;
    if (/^https?:\/\//i.test(remoteUrl)) {
      text = await fetchText(remoteUrl);
    } else {
      text = await fsp.readFile(remoteUrl, 'utf8');
    }
    const trimmed = String(text).replace(/^\uFEFF/, '').trimStart();
    const data = trimmed.startsWith('#EXTM3U')
      ? { items: parseM3U(trimmed) }
      : JSON.parse(text);
    const items = Array.isArray(data) ? data : data.items || data.channels;
    if (!Array.isArray(items) || !items.length) throw new Error('直播片单格式不正确');
    const normalized = items.map(normalizeChannel).filter(Boolean);
    if (!normalized.length) throw new Error('直播片单无有效频道（每条需 name/title + url/stream）');
    settingSet(KEY, { from: remoteUrl, fetchedAt: Date.now(), items: normalized });
    memoryChannels = null;
    return true;
  } catch (e) {
    // 拉取失败：保留旧缓存，稍后重试
    if (cached) settingSet(KEY, { ...cached, fetchedAt: Date.now() - REFRESH_TTL + 10 * 60 * 1000 });
    throw new Error(`直播片单更新失败：${e.message}`);
  }
}

/* ---------------- 订阅型源：m3u / JSON 片单地址展开成多条频道 ----------------
   很多人往「源管理」里填的是一整个直播订阅地址（打开是一份 #EXTM3U 列表），
   而不是单个频道直链。以前一律当成一条频道：列表里只剩孤零零一条、原来的
   频道全被顶掉，点开还把整份列表文本塞给播放器（服务端测速当然 200，画面必然黑）。
   现在按内容自动判定：能解析出 ≥1 条频道就是订阅型，否则当单条直播流。 */
const SUB_TTL = 6 * 60 * 60 * 1000; // 订阅内容 6 小时复查一次
const SUB_CACHE_FILE = () => pathsMod.dirs.root().replace(/\\/g, '/') + '/livetv-subcache.json';

function readSubCache() {
  try {
    const d = JSON.parse(fs.readFileSync(SUB_CACHE_FILE(), 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch { return {}; }
}

function writeSubCache(d) {
  const f = SUB_CACHE_FILE();
  pathsMod.ensureDir(path.dirname(f));
  fs.writeFileSync(f, JSON.stringify(d, null, 2));
  memoryChannels = null;
}

function absoluteUrl(u, base) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^(https?|rtmp|rtsp):\/\//i.test(s)) return s;
  try { return new URL(s, base).href; } catch { return ''; }
}

async function fetchPlaylistChannels(src, timeoutMs = 20000) {
  const text = String((await fetchText(src.url, timeoutMs)) || '').replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('源返回内容为空');
  let items = null;
  if (text.toUpperCase().startsWith('#EXTM3U') || text.includes('#EXTINF')) items = parseM3U(text);
  else if (text.startsWith('{') || text.startsWith('[')) {
    const data = JSON.parse(text);
    items = Array.isArray(data) ? data : data.items || data.channels || [];
  }
  if (!items || !items.length) return null; // 不是片单 → 按单条直播流处理
  const out = [];
  items.forEach((it) => {
    if (typeof it === 'string') it = { name: '', url: it };
    const url = absoluteUrl(it.url || it.stream || '', src.url);
    if (!url) return;
    out.push({
      id: src.id + '-' + out.length,
      name: String(it.name || it.title || '').trim() || ('频道' + (out.length + 1)),
      group: String(it.group || '').trim() || src.group || '全部频道',
      url,
      logo: String(it.logo || '').trim() || null,
      hls: /\.m3u8($|\?)/i.test(url) || !!it.hls,
      note: src.name,
    });
  });
  return out.length ? out : null;
}

/* 拉取全部启用源（默认只拉到期的），结果落 data/livetv-subcache.json —— 重启后不必重拉 */
let syncing = null;
async function syncSources({ force = false, ids = null } = {}) {
  const srcs = listSources().filter((s) => s.enabled && (!ids || ids.includes(s.id)));
  const cache = readSubCache();
  const out = {};
  for (const s of srcs) {
    const hit = cache[s.id];
    if (!force && hit && Array.isArray(hit.items) && hit.items.length && Date.now() - hit.ts < SUB_TTL) {
      out[s.id] = { kind: hit.kind, count: hit.items.length, ts: hit.ts, cached: true };
      continue;
    }
    try {
      const items = await fetchPlaylistChannels(s);
      cache[s.id] = {
        ts: Date.now(),
        kind: items ? 'playlist' : 'stream',
        sourceUrl: s.url,
        items: items || [{
          id: s.id, name: s.name, group: s.group, url: s.url, logo: null,
          hls: /\.m3u8($|\?)/i.test(s.url), note: s.note || s.name,
        }],
      };
      out[s.id] = { kind: items ? 'playlist' : 'stream', count: cache[s.id].items.length, ts: Date.now() };
    } catch (e) {
      out[s.id] = { kind: 'error', count: hit && hit.items ? hit.items.length : 0, error: e.message, ts: hit ? hit.ts : 0 };
      if (hit) cache[s.id] = hit; // 拉取失败：保留上一份，别让频道凭空消失
      else cache[s.id] = { ts: 0, kind: 'new', sourceUrl: s.url, items: [] };
    }
  }
  writeSubCache(cache);
  memoryChannels = null;
  return out;
}

/* 后台补拉：进列表页时顺手更新过期订阅（防雷重入，不阻塞返回） */
function ensureFresh(force) {
  const cache = readSubCache();
  const stale = listSources().some((s) => s.enabled && (!cache[s.id] || Date.now() - cache[s.id].ts > SUB_TTL));
  if (!force && !stale) return;
  if (syncing) return;
  syncing = syncSources().catch(() => ({})).then((r) => { syncing = null; return r; });
}

function customChannels() {
  const cache = readSubCache();
  const out = [];
  for (const s of listSources()) {
    if (!s.enabled) continue;
    const hit = cache[s.id];
    const raws = hit && Array.isArray(hit.items) && hit.items.length
      ? hit.items
      : [{ id: s.id, name: s.name, group: s.group, url: s.url, hls: /\.m3u8($|\?)/i.test(s.url), note: s.note || s.name }];
    for (const r of raws) {
      const ch = normalizeChannel(r, out.length);
      if (ch) out.push(ch);
    }
  }
  return out;
}

/* 按播放地址去重：只合并「地址完全一样」的条目（去协议大小写与末尾斜杠）。
   ★ 查询串必须参与比对 —— 同一份订阅里不少频道只靠地址后面的鉴权参数区分，
     只看 host+path 会把它们误合成一条，用户会发现频道凭空少一个。 */
function dedupeChannels(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const ch of list) {
      let key = String(ch.url || '');
      try {
        const u = new URL(ch.url);
        key = u.host.toLowerCase() + u.pathname.replace(/\/+$/, '') + u.search;
      } catch { /* 地址不规范时按原串去重 */ }
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ch);
    }
  }
  return out;
}

function channels() {
  if (memoryChannels) return memoryChannels;
  const custom = customChannels();
  const cached = settingGet(KEY, null);
  // 老版 applyCustom 往 KEY 里写过 from:'custom' 的假片单，那不是远程片单，忽略它
  const remoteOk = cached && cached.from !== 'custom' && Array.isArray(cached.items) && cached.items.length;
  const base = remoteOk ? cached.items : DEFAULT_CHANNELS;
  let items;
  if (!custom.length) items = base;
  else if (customOnlyMode()) items = custom; // 「只用我的源」开关：彻底替换
  else items = dedupeChannels(custom, base); // 默认：我的源叠加在原有频道之上
  memoryChannels = items;
  return items;
}

function groupChannels(items) {
  const order = [];
  const map = new Map();
  for (const ch of items) {
    if (!map.has(ch.group)) {
      map.set(ch.group, []);
      order.push(ch.group);
    }
    map.get(ch.group).push(ch);
  }
  return order.map((name) => ({ name, channels: map.get(name) }));
}

async function list() {
  let refreshed = false;
  let refreshError = null;
  try {
    refreshed = await refreshCatalog();
  } catch (e) {
    refreshError = e.message;
  }
  ensureFresh(); // 订阅内容过期就后台补拉一次，下一眼就新
  const items = channels();
  const cachedMeta = settingGet(KEY, null) || {};
  const customCount = customChannels().length;
  return {
    usingRemote: !!cachedMeta.from && cachedMeta.from !== 'custom',
    updatedAt: cachedMeta.fetchedAt || null,
    refreshed,
    refreshError,
    customCount,
    customOnly: customOnlyMode(),
    total: items.length,
    groups: groupChannels(items),
  };
}

function prepare(id) {
  const ch = channels().find((x) => x.id === id);
  if (!ch) return { ok: false, error: '频道不存在' };
  return { ok: true, id: ch.id, title: ch.name, group: ch.group, url: ch.url, hls: ch.hls, note: ch.note };
}

module.exports = {
  DEFAULT_CHANNELS,
  REFRESH_TTL,
  normalizeChannel,
  refreshCatalog,
  channels,
  groupChannels,
  list,
  prepare,
  adminOverview, addSource, updateSource, removeSource,
  importSources, exportSources, filterAdsSources, applyCustom, speedtestUrl,
  syncSources, ensureFresh, customChannels, setCustomOnly, customOnlyMode,
  SOURCES_FILE, SUB_CACHE_FILE,
};
