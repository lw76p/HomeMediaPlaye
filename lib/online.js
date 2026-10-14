'use strict';
// 在线观看：免费合法片源（公有领域 / CC 授权）目录 + 海报抽帧 + 中文字幕自动下载
// 设计约束：
//  - 仅收录免费且授权开放的内容（Blender 开放电影 CC-BY、公开测试流等），不做盗版源
//  - 目录支持远程 JSON 实时更新（settings: onlineCatalogUrl），12 小时自动刷新
//  - 海报优先 TMDB 官方图（走已配置接口地址），ffmpeg 抽帧兜底，均落本地、不依赖外链
//  - 中文字幕：目录自带 subtitleUrl 优先；其次 OpenSubtitles API（需用户配置 Key）
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const bins = require('./binaries');
const probe = require('./probe');
const { dirs } = require('./paths');
const tmdb = require('./tmdb');

/* ---------------- 内置目录（全部经本机网络实测可达） ---------------- */
const DEFAULT_CATALOG = [
  {
    id: 'bbb',
    title: '大雄兔 Big Buck Bunny',
    year: 2008,
    kind: 'movie',
    category: '动画电影',
    license: 'CC-BY · Blender 基金会',
    desc: 'Blender 基金会开源动画长片：一只心地善良的大兔子对三只捣蛋小啮齿动物的爆笑复仇。',
    stream: 'https://media.w3.org/2010/05/bunny/movie.mp4',
  },
  {
    id: 'bbb-trailer',
    title: '大雄兔 · 预告片',
    year: 2008,
    kind: 'short',
    category: '预告片',
    license: 'CC-BY · Blender 基金会',
    desc: 'Big Buck Bunny 官方预告。',
    stream: 'https://media.w3.org/2010/05/bunny/trailer.mp4',
  },
  {
    id: 'sintel-trailer',
    title: 'Sintel · 预告片',
    year: 2010,
    kind: 'short',
    category: '预告片',
    license: 'CC-BY · Blender 基金会',
    desc: 'Durian 开源电影项目《Sintel》官方预告：少女与小龙的冒险史诗。',
    stream: 'https://media.w3.org/2010/05/sintel/trailer.mp4',
  },
  {
    id: 'oceans',
    title: '海洋 Oceans',
    year: 2010,
    kind: 'short',
    category: '自然纪录',
    license: '公开样片 · Video.js',
    desc: '深海与洋流的自然影像片段。',
    stream: 'https://vjs.zencdn.net/v/oceans.mp4',
  },
  {
    id: 'html5-demo',
    title: '影像演示 · 星战 fan film',
    year: 2010,
    kind: 'short',
    category: '演示片',
    license: '公开样片 · W3C',
    desc: 'W3C HTML5 video 元素官方演示片。',
    stream: 'https://media.w3.org/2010/05/video/movie_300.mp4',
  },
  {
    id: 'bbb-720-clip',
    title: '大雄兔 · 720p 片段',
    year: 2008,
    kind: 'short',
    category: '短视频',
    license: 'CC-BY · test-videos.co.uk',
    desc: '720p H.264 测试片段（10 秒）。',
    stream: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_5MB.mp4',
  },
  {
    id: 'sintel-720-clip',
    title: 'Sintel · 720p 片段',
    year: 2010,
    kind: 'short',
    category: '短视频',
    license: 'CC-BY · test-videos.co.uk',
    desc: 'Sintel 720p H.264 测试片段（10 秒）。',
    stream: 'https://test-videos.co.uk/vids/sintel/mp4/h264/720/Sintel_720_10s_5MB.mp4',
  },
  {
    id: 'jellyfish',
    title: '水母 · 1080p 测试片',
    year: 2011,
    kind: 'short',
    category: '短视频',
    license: '公开测试片 · test-videos.co.uk',
    desc: '1080p 高码率测试片段，常用于检测解码与拖动性能。',
    stream: 'https://test-videos.co.uk/vids/jellyfish/mp4/h264/1080/Jellyfish_1080_10s_5MB.mp4',
  },
  {
    id: 'hls-bbb',
    title: '第 1 集 · 大雄兔多码率版',
    year: 2008,
    kind: 'episode',
    category: '测试剧集',
    license: 'CC-BY · Mux 公开测试流',
    desc: '多码率 HLS 自适应版本，适合测试弱网环境流畅播放。',
    stream: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    hls: true,
    seriesKey: 'hls-suite',
    seriesTitle: 'HLS 自适应测试流合集',
    episode: 1,
  },
  {
    id: 'hls-pts',
    title: '第 2 集 · PTS 时基偏移流',
    year: 2016,
    kind: 'episode',
    category: '测试剧集',
    license: '公开测试流 · Mux',
    desc: '时基偏移测试流，用于检验播放器音画同步容错。',
    stream: 'https://test-streams.mux.dev/pts_shift/master.m3u8',
    hls: true,
    seriesKey: 'hls-suite',
    seriesTitle: 'HLS 自适应测试流合集',
    episode: 2,
  },
  {
    id: 'bipbop',
    title: '第 3 集 · Apple BipBop',
    year: 2016,
    kind: 'episode',
    category: '测试剧集',
    license: '公开测试流 · Apple',
    desc: '苹果官方 HLS 自适应测试流（16:9 多变体）。',
    stream: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8',
    hls: true,
    seriesKey: 'hls-suite',
    seriesTitle: 'HLS 自适应测试流合集',
    episode: 3,
  },
  {
    id: 'tos',
    title: '钢铁之泪 Tears of Steel',
    year: 2012,
    kind: 'movie',
    category: '科幻电影',
    license: 'CC-BY · Blender 基金会',
    desc: 'Blender 开源科幻真人电影：阿姆斯特丹的未来战场，科学家试图逆转机器人 apocalypse。多音轨、多字幕轨。',
    stream: 'https://test-streams.mux.dev/tos_ismc/main.m3u8',
    hls: true,
  },
  {
    id: 'bbb-1080-clip',
    title: '大雄兔 · 1080p 短视频',
    year: 2008,
    kind: 'short',
    category: '短视频',
    license: 'CC-BY · test-videos.co.uk',
    desc: '1080p 高清片段（10 秒），适合快刷与画质测试。',
    stream: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_5MB.mp4',
  },
  {
    id: 'sintel-1080-clip',
    title: 'Sintel · 1080p 短视频',
    year: 2010,
    kind: 'short',
    category: '短视频',
    license: 'CC-BY · test-videos.co.uk',
    desc: 'Sintel 1080p 片段（10 秒）。',
    stream: 'https://test-videos.co.uk/vids/sintel/mp4/h264/1080/Sintel_1080_10s_5MB.mp4',
  },
  {
    id: 'jellyfish-720-clip',
    title: '水母 · 720p 短视频',
    year: 2011,
    kind: 'short',
    category: '短视频',
    license: '公开测试片 · test-videos.co.uk',
    desc: '720p 水母影像（10 秒），流畅环境下首推短视频。',
    stream: 'https://test-videos.co.uk/vids/jellyfish/mp4/h264/720/Jellyfish_720_10s_2MB.mp4',
  },
  {
    id: 'jellyfish-1080-hr',
    title: '水母 · 1080p 高码率短视频',
    year: 2011,
    kind: 'short',
    category: '短视频',
    license: '公开测试片 · test-videos.co.uk',
    desc: '1080p 10Mbps 高码率（10 秒），检验高码率播放性能。',
    stream: 'https://test-videos.co.uk/vids/jellyfish/mp4/h264/1080/Jellyfish_1080_10s_10MB.mp4',
  },
  {
    id: 'oceans-webm',
    title: '海洋 · WebM 短视频',
    year: 2010,
    kind: 'short',
    category: '短视频',
    license: '公开样片 · Video.js',
    desc: '深海影像 WebM 版本（VP8 编码）。',
    stream: 'https://vjs.zencdn.net/v/oceans.webm',
  },
  {
    id: 'w3c-webm-clip',
    title: '影像演示 · WebM 短视频',
    year: 2010,
    kind: 'short',
    category: '短视频',
    license: '公开样片 · W3C',
    desc: 'W3C 官方演示片 WebM 版本。',
    stream: 'https://media.w3.org/2010/05/video/movie_300.webm',
  },
  {
    id: 'hls-hevc',
    title: '第 4 集 · Apple HEVC 高级流',
    year: 2016,
    kind: 'episode',
    category: '测试剧集',
    license: '公开测试流 · Apple',
    desc: '苹果官方 HEVC/HLS 高级测试流（多字幕多音轨）。',
    stream: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_adv_example_hevc/master.m3u8',
    hls: true,
    seriesKey: 'hls-suite',
    seriesTitle: 'HLS 自适应测试流合集',
    episode: 4,
  },
  {
    id: 'hls-dai',
    title: '第 5 集 · 广告插入断点流',
    year: 2019,
    kind: 'episode',
    category: '测试剧集',
    license: '公开测试流 · Mux',
    desc: '含广告插入（DAI）不连续标记的测试流，检验播放器断点容错。',
    stream: 'https://test-streams.mux.dev/dai-discontinuity-deltatre/manifest.m3u8',
    hls: true,
    seriesKey: 'hls-suite',
    seriesTitle: 'HLS 自适应测试流合集',
    episode: 5,
  },
];

const REFRESH_TTL = 12 * 60 * 60 * 1000; // 12h
const KEY = 'onlineCatalog';

let memoryCatalog = null;

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

async function fetchJson(url, opts = {}) {
  // 兼容两种签名：fetchJson(url, timeoutMs) 与 fetchJson(url, { method, headers, body, timeoutMs })
  const o = typeof opts === 'number' ? { timeoutMs: opts } : opts || {};
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), o.timeoutMs || 10000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      method: o.method || 'GET',
      headers: o.headers,
      body: o.body,
    });
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

/* ---------------- 目录实时更新 ---------------- */

function normalizeItem(raw, i) {
  if (!raw || !raw.id || !raw.title || !raw.stream) return null;
  return {
    id: String(raw.id),
    title: String(raw.title),
    year: raw.year || null,
    kind: raw.kind === 'episode' ? 'episode' : raw.kind === 'movie' ? 'movie' : 'short',
    category: String(raw.category || '在线片源'),
    license: String(raw.license || ''),
    desc: String(raw.desc || ''),
    stream: String(raw.stream),
    hls: !!raw.hls,
    seriesKey: raw.seriesKey ? String(raw.seriesKey) : null,
    seriesTitle: raw.seriesTitle ? String(raw.seriesTitle) : null,
    episode: raw.episode || null,
    subtitleUrl: raw.subtitleUrl ? String(raw.subtitleUrl) : null,
    posterUrl: raw.posterUrl ? String(raw.posterUrl) : null,
    _i: i,
  };
}

/* 按剧集聚合（供「在线剧集」子页使用） */
function aggregateSeries(items) {
  const map = new Map();
  for (const it of items) {
    if (!it.seriesKey) continue;
    if (!map.has(it.seriesKey)) {
      map.set(it.seriesKey, {
        key: it.seriesKey,
        title: it.seriesTitle || it.seriesKey,
        category: it.category,
        license: it.license,
        posterFile: posterFileFor(it),
        episodes: [],
      });
    }
    map.get(it.seriesKey).episodes.push(it);
  }
  for (const s of map.values()) {
    s.episodes.sort((a, b) => (a.episode || 0) - (b.episode || 0));
    s.episodeCount = s.episodes.length;
  }
  return [...map.values()];
}

// 在线片单远程目录功能已下线（在线片源入口移除），固定使用内置片源
async function refreshCatalog() { return false; }


function catalog() {
  if (memoryCatalog) return memoryCatalog;
  memoryCatalog = DEFAULT_CATALOG;
  return memoryCatalog;
}

/* ---------------- 自动预热：检测到可用资源即后台拉取 ---------------- */
let warmed = new Set();
const warmFailedAt = new Map();
const WARM_RETRY_MS = 30 * 60 * 1000; // 失败后半小时才重试，避免反复打片源

function warmup(items) {
  const now = Date.now();
  for (const it of items) {
    if (warmed.has(it.id)) continue;
    const failedAt = warmFailedAt.get(it.id);
    if (failedAt && now - failedAt < WARM_RETRY_MS) continue;
    warmed.add(it.id);
    // 海报：TMDB 官方海报优先，抽帧本地图兜底，绝不依赖外链图片
    ensurePoster(it)
      .then((r) => { if (!r || !r.ok) warmFailedAt.set(it.id, Date.now()); })
      .catch(() => warmFailedAt.set(it.id, Date.now()));
    // 字幕：有 subtitleUrl 或已配置 OpenSubtitles Key 时自动下载
    if (it.subtitleUrl || settingGet('opensubtitlesApiKey', null) || process.env.HMP_OS_API_KEY) {
      ensureSubtitle(it).catch(() => {});
    }
  }
}

async function list() {
  let refreshed = false;
  let refreshError = null;
  try {
    refreshed = await refreshCatalog();
  } catch (e) {
    refreshError = e.message;
  }
  const items = catalog().map((it) => ({
    ...it,
    posterName: posterFileFor(it),
    hls: !!it.hls,
  }));
  warmup(items); // 后台自动补齐海报与可用字幕
  return {
    items,
    series: aggregateSeries(items),
    movies: items.filter((it) => !it.seriesKey),
    updatedAt: null,
    usingRemote: false,
    refreshed,
    refreshError,
  };
}

/* ---------------- 海报：ffmpeg 从片源抽帧 ---------------- */

function posterFileFor(item) {
  const h = crypto.createHash('sha1').update(item.id + '|' + item.stream).digest('hex').slice(0, 16);
  return `${h}-v1.jpg`;
}

async function ensurePoster(item) {
  const file = posterFileFor(item);
  const outPath = path.join(dirs.posters(), file);
  try {
    const st = await fsp.stat(outPath);
    if (st.size > 1024) return { ok: true, file, cached: true };
  } catch {
    /* 需要生成 */
  }
  // 1) TMDB 官方海报：NAS 直连片源常常抽不了帧（源站被墙/限速），走已配置的 TMDB 接口最稳
  if (tmdb.enabled()) {
    try {
      const isEp = item.kind === 'episode' || item.seriesKey;
      // 搜索词清洗：片单标题常是「中文名 English (注解)」混合串，直接搜匹配率极低；
      // 去掉括号注解与中日韩字符，只留拉丁字母部分去搜
      const q = String(item.title || '')
        .replace(/（[^）]*）|\([^)]*\)/g, ' ')
        .replace(/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g, ' ')
        .replace(/\b(19|20)\d{2}\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const name = await tmdb.searchPoster({ title: q || item.title, year: item.year, kind: isEp ? 'episode' : 'movie' });
      if (name) {
        await fsp.copyFile(path.join(dirs.posters(), name), outPath);
        return { ok: true, file, from: 'tmdb' };
      }
    } catch { /* 搜索/下载失败，落到抽帧兜底 */ }
  }

  // 2) ffmpeg 抽帧兜底
  const ffmpeg = bins.status().ffmpeg;
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg 未就绪' };
  const candidates = [8, 30, 3, 1];
  for (const ss of candidates) {
    await probe.run(
      ffmpeg,
      [
        '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-verify', '0', // 片源多为自签/链式证书，关闭严格校验
        '-ss', String(ss),
        '-i', item.stream,
        '-frames:v', '1',
        '-vf', 'scale=640:-2:flags=lanczos',
        '-q:v', '4',
        '-y', outPath,
      ],
      { timeout: 45000 }
    );
    try {
      const st = await fsp.stat(outPath);
      if (st.size > 1024) return { ok: true, file };
    } catch {
      /* 试下一个时间点 */
    }
  }
  return { ok: false, reason: '抽帧失败' };
}

/* ---------------- 中文字幕：目录自带 / OpenSubtitles ---------------- */

function subtitlePathFor(item) {
  return path.join(dirs.root(), 'cache', 'subtitles', `online-${item.id}.zh.srt`);
}

async function downloadSubtitle(url, outPath) {
  const text = await fetchText(url);
  if (!text || text.length < 20) throw new Error('字幕内容为空');
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, text.startsWith('﻿') ? text : '﻿' + text, 'utf8');
  return outPath;
}

async function ensureSubtitle(item) {
  const outPath = subtitlePathFor(item);
  if (fs.existsSync(outPath)) return { ok: true, path: outPath, cached: true };

  // 1) 目录自带字幕地址
  if (item.subtitleUrl) {
    try {
      await downloadSubtitle(item.subtitleUrl, outPath);
      return { ok: true, path: outPath, from: 'catalog' };
    } catch {
      /* 落到 OpenSubtitles */
    }
  }

  // 2) OpenSubtitles（需用户在设置中配置 API Key）
  const apiKey = settingGet('opensubtitlesApiKey', null) || process.env.HMP_OS_API_KEY || null;
  if (apiKey) {
    const osBase = (process.env.HMP_OS_API_BASE || 'https://api.opensubtitles.com/api/v1').replace(/\/+$/, '');
    try {
      const q = new URLSearchParams({
        query: item.title.replace(/[·（(].*$/, '').trim(),
        languages: 'zh-cn',
      });
      if (item.year) q.set('year', String(item.year));
      const res = await fetchJson(`${osBase}/subtitles?${q}`, {
        headers: { 'Api-Key': apiKey, 'User-Agent': 'home-media-player v0.5' },
      });
      const first = res && res.data && res.data[0];
      const fileId = first && first.attributes && first.attributes.files && first.attributes.files[0] && first.attributes.files[0].file_id;
      if (!fileId) return { ok: false, reason: 'OpenSubtitles 无中文字幕结果' };
      const dl = await fetchJson(`${osBase}/download`, {
        method: 'POST',
        headers: {
          'Api-Key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ file_id: fileId }),
      });
      if (!dl.link) return { ok: false, reason: 'OpenSubtitles 未返回下载链接（检查 Key/配额）' };
      await downloadSubtitle(dl.link, outPath);
      return { ok: true, path: outPath, from: 'opensubtitles' };
    } catch (e) {
      return { ok: false, reason: `字幕下载失败：${e.message}` };
    }
  }
  return { ok: false, reason: '未配置 OpenSubtitles API Key，且该片源未内置字幕地址' };
}

/* ---------------- 播放准备（桌面版：返回流地址 + 本地字幕路径） ---------------- */

async function preparePlay(id) {
  const item = catalog().find((x) => x.id === id);
  if (!item) return { ok: false, error: '在线片源不存在' };
  const sub = await ensureSubtitle(item); // 失败不阻塞播放
  return {
    ok: true,
    url: item.stream,
    title: item.title,
    subFile: sub && sub.ok ? sub.path : null,
    subNote: sub && !sub.ok ? sub.reason : null,
  };
}

module.exports = {
  DEFAULT_CATALOG,
  list, refreshCatalog, catalog,
  ensurePoster, posterFileFor, warmup,
  ensureSubtitle, preparePlay,
};
