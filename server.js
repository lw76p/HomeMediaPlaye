'use strict';
// 家庭娱乐中心 Web 服务端
// 零 npm 依赖：node:http + node:sqlite + ffmpeg/ffprobe
// 启动：node server.js   （可选环境变量见 README）
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { Readable } = require('node:stream');
const net = require('node:net');

const db = require('./lib/db');
const scanner = require('./lib/scanner');
const bins = require('./lib/binaries');
const probe = require('./lib/probe');
const onlineMod = require('./lib/online');
const livetvMod = require('./lib/livetv');

// 界面模式：full   = 完整版（在线电影 / 在线剧集 + 电视直播）
//           livetv = 精简版，只保留电视直播（客户交付包用）
// 由环境变量 HMP_UI_MODE 控制；不设置即维持原样，自用不受影响。
const UI_MODE = String(process.env.HMP_UI_MODE || 'full').trim().toLowerCase();
const LIVETV_ONLY = UI_MODE === 'livetv';
const tmdbMod = require('./lib/tmdb');
const webdav = require('./lib/webdav');
const openlist = require('./lib/openlist');
const diag = require('./lib/diag');
const cidr = require('./lib/cidr');
const subtitles = require('./lib/subtitles');
const photos = require('./lib/photos');
const dl = require('./lib/downloader');
const qbit = require('./lib/qbit');
const steam = require('./lib/steam');
const music = require('./lib/music');
const musiconline = require('./lib/musiconline');
const imgthumb = require('./lib/imgthumb');
const ebooks = require('./lib/ebooks');
const kids = require('./lib/kids');
const recommend = require('./lib/recommend');
const adminlock = require('./lib/adminlock');
const ai = require('./lib/ai');
const faces = require('./lib/faces');
const ota = require('./lib/ota');
const assistant = require('./lib/assistant');
const aisim = require('./lib/aisim');
const cleanup = require('./lib/cleanup');
const asr = require('./lib/asr');
const subsearch = require('./lib/subsearch');
const perf = require('./lib/perfprobe');
const remote = require('./lib/remote');
let cleanupScanning = false; // gj：重复扫描并发锁（扫描虽已异步化，也避免重复跑）
let cleanupScanStart = 0;    // gm：本次扫描开始时间（僵尸锁 30 分钟兜底判定用）

/* gn: 网盘桥接（OpenList）守护 —— 本机装了桥接（同级 openlist/ 目录）就自动拉起、
 * 掉线自动带活。开机自启与保活全部搭影视库的便车，客户无需任何配置、无需 root。
 * 环境变量 HMP_NO_BRIDGE_GUARD=1 可关闭。 */
const BRIDGE_DIR = path.join(__dirname, '..', 'openlist');
let bridgeSpawning = false;
function bridgeSpawn() {
  if (bridgeSpawning) return;
  bridgeSpawning = true;
  try {
    const exeName = process.platform === 'win32' ? 'openlist.exe' : 'openlist';
    const exe = path.join(BRIDGE_DIR, exeName);
    const out = fs.openSync(path.join(BRIDGE_DIR, 'run.log'), 'a');
    const child = spawn(exe, ['server', '--data', path.join(BRIDGE_DIR, 'data')], {
      cwd: BRIDGE_DIR, detached: true, stdio: ['ignore', out, out], windowsHide: true,
    });
    child.unref();
    try { fs.closeSync(out); } catch { /* 忽略 */ }
    console.log('[bridge-guard] 网盘桥接已拉起 (pid ' + child.pid + ')');
  } catch (e) {
    console.log('[bridge-guard] 网盘桥接拉起失败: ' + e.message);
  }
  setTimeout(() => { bridgeSpawning = false; }, 15000);
}
function bridgeGuardTick() {
  try {
    if (process.env.HMP_NO_BRIDGE_GUARD) return;
    if (!fs.existsSync(path.join(BRIDGE_DIR, '.env'))) return;               // 没装网盘桥接
    const exeName = process.platform === 'win32' ? 'openlist.exe' : 'openlist';
    if (!fs.existsSync(path.join(BRIDGE_DIR, exeName))) return;              // 二进制不在位
    let port = 5244;
    try {
      fs.readFileSync(path.join(BRIDGE_DIR, '.env'), 'utf8').split(/\r?\n/).forEach((l) => {
        const m = /^\s*OPENLIST_PORT\s*=\s*(\d+)\s*$/.exec(l);
        if (m) port = Number(m[1]) || 5244;
      });
    } catch { /* 用默认端口 */ }
    const req = http.get({ host: '127.0.0.1', port, path: '/ping', timeout: 900 }, (res) => {
      res.resume();              // 有响应就认为在跑（不管是不是桥接，别去抢端口）
      req.destroy();
    });
    req.on('timeout', () => { req.destroy(); bridgeSpawn(); });
    req.on('error', () => bridgeSpawn());
  } catch { /* 守护绝不能影响主服务 */ }
}
setTimeout(bridgeGuardTick, 6000);
setInterval(bridgeGuardTick, 60 * 1000);
photos.init();
dl.init();
music.init();
musiconline.init();
// 启动 20 秒后后台预热专辑封面（无内嵌封面的专辑到网易云补图，浏览时秒显）
setTimeout(() => { music.warmCovers().catch(() => {}); }, 20000);
ebooks.init();

const PORT = parseInt(process.env.HMP_PORT || '8080', 10);
const HOST = process.env.HMP_HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const POSTER_RE = /^(?:[a-f0-9]{16}-(?:v\d+|bd\d+)|tmdb-(?:movie|tv)-\d+(?:-bd)?|custom-[a-f0-9]{16})\.(?:jpg|png|webp|gif)$/; // 封面文件名白名单（抽帧封面/Hero背景图/TMDB海报/自定义海报），防目录穿越

/* ---------------- 电视直播 HLS 同源代理 ---------------- */
// m3u8 内容逐行重写：普通行 = 段/子播放列表地址，# 行只替换 URI="..." 属性；
// 目标绝对地址做 base64url 塞进 /api/livetv/seg/:id/:b64，段落按原样转发字节流
function segProxied(id, targetUrl) {
  return '/api/livetv/seg/' + encodeURIComponent(id) + '/' + Buffer.from(targetUrl).toString('base64url');
}

function rewriteM3u8(text, baseUrl, id) {
  const prox = (u) => segProxied(id, new URL(u, baseUrl).href);
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (m0, u) => 'URI="' + prox(u) + '"');
    }
    return prox(t);
  }).join('\n');
}

/* 只从响应流里偷看前 2KB，不破坏后续字节（用于识别「声明类型不准」的 m3u8） */
async function peekHead(body, max = 2048) {
  const reader = body.getReader();
  const chunks = [];
  let bytes = 0;
  let text = '';
  let ended = false;
  while (bytes < max) {
    const { value, done } = await reader.read();
    if (done) { ended = true; break; }
    chunks.push(value);
    bytes += value.length;
    text += Buffer.from(value).toString('utf8');
  }
  return { reader, chunks, text, ended };
}

async function proxyHls(res, id, url, depth) {
  if (depth > 3) { res.writeHead(508); return res.end('redirect loop'); }
  let up;
  try {
    up = await fetch(url, { headers: { 'User-Agent': 'HomeMediaPlayer-LiveTV/1.0' }, redirect: 'follow' });
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('upstream error: ' + e.message);
  }
  if (!up.ok || !up.body) {
    res.writeHead(up.status || 502, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('upstream HTTP ' + up.status);
  }
  const finalUrl = up.url || url;
  const ct = up.headers.get('content-type') || '';
  const cors = { 'Access-Control-Allow-Origin': '*' };
  // 先看前 2KB 的实际内容：很多直播地址没有 .m3u8 后缀（靠 302 跳到真正的 HLS 列表，
  // 甚至 Content-Type 乱标），只认 URL/CT 会把它当普通字节流丢给 video 标签 → 黑屏
  const { reader, chunks, text, ended } = await peekHead(up.body);
  const looksPlaylist = /#EXTM3U|#EXT-X-VERSION|#EXT-X-STREAM-INF|#EXT-X-TARGETDURATION/i.test(text.slice(0, 2048));
  if (looksPlaylist) {
    if (!ended) { // 剩下的也读出来，拼成完整播放列表
      for (let rest = await reader.read(); !rest.done; rest = await reader.read()) chunks.push(rest.value);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store', ...cors });
    return res.end(rewriteM3u8(body, finalUrl, id));
  }
  res.writeHead(200, { 'Content-Type': ct || 'application/octet-stream', 'Cache-Control': 'no-store', ...cors });
  for (const c of chunks) res.write(c);
  if (ended) return res.end();
  const tail = (async function* () {
    for (let rest = await reader.read(); !rest.done; rest = await reader.read()) yield rest.value;
  })();
  Readable.from(tail).pipe(res);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.ts': 'video/mp2t',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
};

/* ---------------- 扫描状态 ---------------- */
const scanState = { running: false, startedAt: null, events: [], result: null };

// 网盘目录动辄上千集，单轮每根只探测一批；仍有待探测文件时自动接着跑下一轮，
// 连续无进展则停下，避免空转。
const autoRescan = { rounds: 0, lastLeft: Infinity, stalls: 0 };

function cloudPendingCount() {
  try {
    const rows = db.all(
      "SELECT COUNT(*) AS c FROM media_files WHERE (path LIKE 'webdav:%' OR path LIKE 'alist:%') AND probed_at IS NULL"
    );
    return (rows && rows[0] && Number(rows[0].c)) || 0;
  } catch {
    return 0;
  }
}

function onScanEvent(ev) {
  scanState.events.push({ at: Date.now(), ...ev });
  if (scanState.events.length > 200) scanState.events.shift();
  console.log('[scan]', ev.message || ev.phase);
}

function startScan(opts = {}) {
  const chained = !!(opts && opts.chain);
  if (scanState.running) return { ok: false, error: '扫描正在进行中' };
  if (!bins.status().ready) {
    return { ok: false, error: `ffprobe/ffmpeg 未就绪: ${bins.status().missing.join(', ')}` };
  }
  scanState.running = true;
  scanState.startedAt = Date.now();
  if (!chained) {
    scanState.events = [];
    scanState.result = null;
  }
  (async () => {
    try {
      scanState.result = await scanner.scanAll({ onEvent: onScanEvent });
      onScanEvent({ phase: 'all-done', message: '全部媒体库扫描完成' });
      // 扫描尾部重识别：网盘新入库的纯 SxxExx 文件立即按目录名归组，
      // 不用等下次启动的 30s 自愈（扫描往往比那 30s 长）
      try { scanner.reclassifyAll(); } catch (e) { console.error('[扫描尾] 重识别失败', e && e.message); }
      // 扫描完成后自动进行 TMDB 元数据刮削（已配置 Key 时才生效）
      if (tmdbMod.enabled() && !tmdbMod.scrapeState.running) {
        tmdbMod.scrapeAll({ onEvent: (e) => onScanEvent({ phase: 'tmdb', ...e }) }).catch(() => {});
      }
      // 扫描完成后自动提取人脸（模型就绪 + 有待处理才跑；断点续扫天然支持，
      // 中断后下次扫描从 face_state=-1 的行继续）。与 AI 分类共用缩略图通道，批量内部自动让出事件循环
      try {
        const fp = faces.progress();
        if (fp.installed && fp.pending > 0 && !(fp.batch && fp.batch.running)) {
          const fthumb = async (id) => {
            try {
              const r = await fetch(`http://127.0.0.1:${PORT}/api/photos/libthumb/${id}`);
              return r.ok ? await r.arrayBuffer() : null;
            } catch { return null; }
          };
          faces.startBatch({ thumb: fthumb }).catch((e) => console.error('[扫描尾] 人脸提取启动失败', e && e.message));
          onScanEvent({ phase: 'faces', message: `人脸提取已自动开始（待处理 ${fp.pending} 张）` });
        }
      } catch (e) { console.error('[扫描尾] 人脸提取检查失败', e && e.message); }
    } catch (e) {
      scanState.result = { ok: false, error: String(e && e.message) };
      onScanEvent({ phase: 'error', message: `扫描失败: ${e && e.message}` });
    } finally {
      scanState.running = false;
      // 网盘待探测文件自动续跑
      try {
        const left = cloudPendingCount();
        if (left > 0) {
          if (left < autoRescan.lastLeft) autoRescan.stalls = 0; else autoRescan.stalls += 1;
          autoRescan.lastLeft = left;
          if (autoRescan.stalls < 3 && autoRescan.rounds < 200) {
            autoRescan.rounds += 1;
            onScanEvent({ phase: 'auto-rescan', message: `网盘还有 ${left} 个文件待探测，3 秒后自动继续（第 ${autoRescan.rounds} 轮）` });
            setTimeout(() => { if (!scanState.running) startScan({ chain: true }); }, 3000);
          } else {
            onScanEvent({ phase: 'auto-rescan', message: `网盘仍有 ${left} 个文件未探测完，已停止自动续跑（可手动再点扫描）` });
          }
        } else {
          autoRescan.rounds = 0;
          autoRescan.stalls = 0;
          autoRescan.lastLeft = Infinity;
        }
      } catch { /* 忽略 */ }
    }
  })();
  return { ok: true };
}

/* 「全部影片」视图：剧集折叠为一部剧一张卡（电影/短片照旧按文件）。
   正常剧用 series 行渲染剧卡；降级（series 行缺失或剧名是纯集号）退到目录折叠。
   排序代理：剧卡入库时间取组内最新、体积/时长取全集合计，四种排序都可用。 */
const BARE_EP_RE = /^(s\d{1,2}e\d{1,4}|e\d{1,4}|\d{1,4})$/i;
function dirFallbackTitle(dir) {
  const base = String(dir || '').split(/[\\/]/).filter(Boolean).pop() || '';
  return base.replace(/[(（【\[]*\s*(19|20)\d{2}\s*[)）\]】]*\s*$/, '').trim() || base;
}
function collapseAllRows(files, seriesList, sort = 'added') {
  const byKey = new Map(seriesList.map((s) => [s.series_key, s]));
  const seriesOk = (m) => {
    if (!m.series_key) return false;
    const s = byKey.get(m.series_key);
    return !!s && !BARE_EP_RE.test(String(s.title || '').replace(/\s+/g, ''));
  };
  const groups = new Map();
  const passthrough = [];
  const nameGroups = new Map(); // 未刮削同名聚合（无 tmdb_id，按清洗片名跨目录归类）
  for (const m of files) {
    if (m.kind !== 'episode') {
      // 未刮削非剧集：按清洗片名跨目录聚合，无基数则原样透传
      if (!m.tmdb_id) {
        const base = db.nameGroupBase(m.title);
        if (base) {
          if (!nameGroups.has(base)) nameGroups.set(base, []);
          nameGroups.get(base).push(m);
          continue;
        }
      }
      passthrough.push(m);
      continue;
    }
    if (seriesOk(m) && byKey.get(m.series_key).tmdb_id) {
      const gk = `series:${m.series_key}`;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(m);
      continue;
    }
    // 未刮削剧集（含裸名 series 组）：跨目录同名聚合（多目录同一部剧合并成一张卡）
    if (!m.tmdb_id) {
      const base = db.nameGroupBase(m.title);
      if (base) {
        if (!nameGroups.has(base)) nameGroups.set(base, []);
        nameGroups.get(base).push(m);
        continue;
      }
    }
    const gk = `epdir:${m.dir || m.series_key || m.title}`;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(m);
  }
  const cards = [];
  for (const members of groups.values()) {
    const first = members[0];
    if (seriesOk(first)) {
      const s = byKey.get(first.series_key);
      cards.push({
        id: null,
        type: 'series',
        kind: 'series',
        series_key: s.series_key,
        title: s.tmdb_title || s.title,
        tmdb_title: s.tmdb_title || null,
        year: s.year,
        poster: s.official_poster || s.poster,
        official_poster: s.official_poster || null,
        rating: s.rating || null,
        episode_count: s.episode_count,
        season_count: s.season_count,
        last_seen_at: Math.max(...members.map((x) => x.last_seen_at || 0)),
        sort_size: members.reduce((a, x) => a + (x.size || 0), 0),
        sort_duration: members.reduce((a, x) => a + (x.duration || 0), 0),
      });
    } else {
      // 降级：同一目录的多集折叠为一张文件卡（代表 = 体积最大的一集，可点开播放）
      const rep = members.reduce((a, x) => ((x.size || 0) > (a.size || 0) ? x : a), first);
      const dn = dirFallbackTitle(rep.dir);
      cards.push(dn ? { ...rep, title: dn } : rep);
    }
  }
  // 未刮削同名聚合：≥2 个同名（去集数标记）电影折叠为一张虚拟合集卡
  for (const [base, members] of nameGroups) {
    if (members.length < 2) { passthrough.push(members[0]); continue; }
    const rep = members.find((x) => x.official_poster)
      || members.reduce((a, x) => ((x.size || 0) > (a.size || 0) ? x : a), members[0]);
    cards.push({
      id: null,
      type: 'series',
      kind: 'series',
      series_key: `namegroup:${base}`,
      title: base,
      tmdb_title: null,
      year: (members.find((x) => x.year) || {}).year || null,
      poster: rep.official_poster || rep.poster,
      official_poster: rep.official_poster || null,
      episode_count: members.length,
      season_count: 1,
      last_seen_at: Math.max(...members.map((x) => x.last_seen_at || 0)),
      sort_size: members.reduce((a, x) => a + (x.size || 0), 0),
      sort_duration: members.reduce((a, x) => a + (x.duration || 0), 0),
    });
  }
  const cmp = {
    added: (a, b) => (b.last_seen_at || 0) - (a.last_seen_at || 0),
    title: (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh'),
    size: (a, b) => (b.sort_size ?? b.size ?? 0) - (a.sort_size ?? a.size ?? 0),
    duration: (a, b) => (b.sort_duration ?? b.duration ?? 0) - (a.sort_duration ?? a.duration ?? 0),
  }[sort] || null;
  const rows = [...passthrough, ...cards];
  if (cmp) rows.sort(cmp);
  return rows;
}

/* 电影显示去重：同一 TMDB 条目（tmdb_id 相同）的多副本折叠为一张卡，
   代表 = 有官方海报者优先、体积大者优先；未刮削（无 tmdb_id）不动。
   菜单页此前是文件级列表，同一部电影多个分辨率副本各占一张卡同海报刷屏（2026-09-21 涛哥反馈） */
function dedupeMovies(items) {
  const byTmdb = new Map();
  const out = [];
  for (const m of items) {
    if (!m.tmdb_id) { out.push(m); continue; }
    const prev = byTmdb.get(m.tmdb_id);
    if (!prev) { byTmdb.set(m.tmdb_id, m); out.push(m); continue; }
    const better = ((m.official_poster ? 1 : 0) - (prev.official_poster ? 1 : 0))
      || ((m.size || 0) - (prev.size || 0));
    if (better > 0) { out.splice(out.indexOf(prev), 1, m); byTmdb.set(m.tmdb_id, m); }
  }
  return out;
}

/* ---------------- 启动引导 ---------------- */
function bootstrap() {
  db.init();
  // HMP_ROOTS=/media,/mnt/movies 逗号分隔；仅当媒体库为空时自动导入
  const rootsEnv = (process.env.HMP_ROOTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (rootsEnv.length && db.listRoots().length === 0) {
    for (const r of rootsEnv) {
      if (fs.existsSync(r)) {
        db.addRoot(r, path.basename(r) || r);
        console.log('[bootstrap] 已添加媒体库目录:', r);
      } else {
        console.warn('[bootstrap] 目录不存在，跳过:', r);
      }
    }
  }
}

/* ---------------- 工具 ---------------- */
// headers：可选附加响应头（管理密码解锁要用 Set-Cookie）。保持第三个参数不变，老调用点无需改。
function json(res, code, data, headers) {
  const body = JSON.stringify(data);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, headers || {}));
  res.end(body);
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > limit) req.destroy(); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); }
    });
  });
}

function serveFile(res, filePath, cache = false) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // cache=false → 每次打开都向服务器重验，保证页面/脚本始终最新
    'Cache-Control': cache ? 'public, max-age=604800' : 'no-cache, must-revalidate',
  });
  fs.createReadStream(filePath).pipe(res);
}

// 带_range 的视频流（浏览器 <video> 必需）
function streamFile(req, res, filePath) {
  let st;
  try { st = fs.statSync(filePath); } catch {
    return json(res, 404, { error: '文件不存在' });
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Content-Length': st.size,
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

// 转码流：浏览器不支持的编码（HEVC/RMVB 等）走 ffmpeg 实时转码为 H.264 mp4
/* 预览片段只认本地磁盘片源（Hero 大屏 / 悬停浮层 / 详情大窗都要用）。
   云盘（WebDAV）源要么容器浏览器不认、要么转码得现从远端拉；实测 ffmpeg 对远端输入 + seek
   40 秒零字节 —— 预览会一直空转，还拖着 NAS 的 CPU。云端条目干脆不派 preview，
   前端自然退回静态海报 / 封面：不播总比黑着转圈强。 */
function localOnly(id) {
  if (!id) return null;
  const r = db.get('SELECT id, path, duration FROM media_files WHERE id = ?', [id]);
  if (!r || !r.path || webdav.isCloudPath(r.path)) return null;
  return r;
}
let activeTranscodes = 0; // perfprobe：进行中的转码子进程数（按档位限并发）
function transcodeStream(res, filePath, startSec = 0, extraArgs = [], srcWidth = 0, vcopy = false, vcodec = '', previewSec = 0) {
  const ffmpeg = bins.status().ffmpeg;
  if (!ffmpeg) return json(res, 500, { error: 'ffmpeg 未就绪' });
  /* 算力自适应（perfprobe 体检档位）：
   * - D 档（<2x）禁止实时转码，只留 remux 通道（音轨兼容时零解码开销）
   * - preset 按档位选（弱机 ultrafast，强机 fast/veryfast）
   * - 超高清降采样宽度按档位（C 档 720p / 其余 1080p）
   * - 无体检缓存时按保守默认（B 档），不会比旧行为更差 */
  const prof = perf.transcodeProfile(srcWidth);
  if (prof.transcodeDisabled && !vcopy) {
    return json(res, 503, { error: '本机算力较弱（体检 ' + prof.label + '），已禁用实时转码；请直接播放原片或到设置页重新体检' });
  }
  if (!vcopy && prof.maxConcurrent > 0 && activeTranscodes >= prof.maxConcurrent) {
    return json(res, 503, { error: '转码并发已达本机上限（' + prof.label + '档 ' + prof.maxConcurrent + ' 路），请稍后再试或切换原画质播放' });
  }
  // vcopy=true：Remux 通道——视频流原样拷贝（画质零损失），只把不兼容的音轨转 AAC。
  // 视频浏览器本来解得动、死在音轨（DTS/EAC3/TrueHD）的片源走这条路，音频转码开销极小、几十倍实时。
  // 4K/超高清源（需整体重编码时）：HEVC 软解是硬瓶颈（实测 4K 全分辨率 only 0.65x < 实时），降到 1080p + ultrafast
  // 实测 1.45x 实时（指环王2 4K 原盘），≤1080p 源保持 veryfast 不降画质
  const big = prof.big;
  const scaleW = prof.scaleW || 1920;
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    ...extraArgs,
    '-ss', String(Math.max(0, startSec)),
    '-i', filePath,
    '-map', '0:v:0', '-map', '0:a:0?',
    ...(vcopy
      ? ['-c:v', 'copy', ...(vcodec === 'hevc' ? ['-tag:v', 'hvc1'] : [])] // hvc1 标签保证 HEVC 在 mp4 里被浏览器正确识别
      : [
          ...(big ? ['-vf', 'scale=' + scaleW + ':-2'] : []),
          '-c:v', 'libx264', '-preset', prof.preset, '-crf', '23',
        ]),
    '-c:a', 'aac', '-b:a', previewSec > 0 ? '96k' : '160k',
    // 预览片段（悬停浮层 / 大屏）只放十几秒：给 -t 让 ffmpeg 自己收尾。
    // 否则客户端一断开，ffmpeg 还在闷头转整部片，几个回合下来就把 NAS CPU 占满。
    ...(previewSec > 0 ? ['-t', String(previewSec)] : []),
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov',
    'pipe:1',
  ];
  const child = spawn(ffmpeg, args, { windowsHide: true });
  activeTranscodes += 1; // perfprobe 并发计数
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Transfer-Encoding': 'chunked',
  });
  child.stdout.pipe(res);
  child.stderr.on('data', (d) => console.error('[ffmpeg]', String(d).trim().slice(0, 300)));
  child.on('error', (e) => console.error('[ffmpeg] spawn failed:', e.message));
  let activeDec = false; // error 与 exit 可能都触发，只递减一次
  const decActive = () => { if (!activeDec) { activeDec = true; activeTranscodes = Math.max(0, activeTranscodes - 1); } };
  child.on('error', () => decActive());
  /* 硬超时：客户端异常断开（HTTP keep-alive 挂住、进程被强杀）时 res 的 close 未必及时触发，
     线上出现过几个 ffmpeg 一直转到把 CPU 占满。预览 90 秒够用，整片播放给 2 小时。 */
  const hardMs = previewSec > 0 ? 90000 : 7200000;
  const hardTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, hardMs);
  child.on('exit', () => { clearTimeout(hardTimer); decActive(); });
  /* 名额释放必须在 close 时立刻做，不能等 ffmpeg exit 事件：
     浏览器 seek 重挂 src 的时序是「断旧连接 + 立刻发新请求」，旧 ffmpeg 的 exit 事件
     晚于新请求到达 → 新请求撞 maxConcurrent 吃 503 → 前端 onerror 回退到 start=0
     → 表现为「快进/后退后回到片头」（实测 curl 断开 30ms 后新请求即 503）。
     decActive 有 activeDec 守卫，exit 里再调也只减一次。 */
  res.on('close', () => { clearTimeout(hardTimer); decActive(); try { child.kill('SIGKILL'); } catch { /* ignore */ } });
}

/* 「设置」范畴的写接口：这些路径上的非 GET 请求要求已解锁管理密码。
   只列设置类 —— 播放/进度/收藏/顶栏扫描/下载中心都不在其中，
   家里其他人照常看电影、听歌、翻相册，不会处处被要密码。 */
const ADMIN_LOCK_WRITE = [
  /^\/api\/roots(\/|$)/,     // 媒体库目录 增删改
  /^\/api\/webdav(\/|$)/,    // 网盘账号与目录
  /^\/api\/openlist(\/|$)/,  // 网盘快捷入口（加/删网盘存储，写账号凭据，必须上锁）
  /^\/api\/settings$/,        // TMDB Key 等
  /^\/api\/tmdb(\/|$)/,      // 刮削
  /^\/api\/livetv(\/|$)/,    // 直播片单
  /^\/api\/ai(\/|$)/,        // AI 分类 / 词表 / 模型下载
  /^\/api\/reclass/,          // 重新识别分类
  /^\/api\/fs(\/|$)/,        // 目录浏览（设置页选目录用）
  /^\/api\/qbit\/config$/,   // BT 下载器的连接配置（写 qBittorrent 账号密码）
  /^\/api\/qbit\/(rescue|install)$/,     // qBT 密码找回（读容器日志含临时密码）/ 一键装回本机（装 docker 容器）
  /^\/api\/kids(\/|$)/,      // 儿童模式配置
  /^\/api\/games\/(download|upload|scan)(\/|$)/,  // 游戏商店：下载/上传 ROM（写 ROM 目录）/ 触发入库扫描
  /^\/api\/games\/meta(\/|$)/,               // 游戏库元数据源密钥（写 RomM 的 .env）
  /^\/api\/games\/cred$/,                    // 游戏库免登录凭据（保存 RomM 账号密码）
  /^\/api\/games\/steam\/config$/,           // PC 游戏库位置（读本机磁盘上的 Steam 清单，必须上锁）
  /^\/api\/admin(\/|$)/,     // 管理密码自身
  /^\/api\/diag(\/|$)/,      // 网络与系统自诊断（探针会读本机 IP/路径/磁盘，外网可达信息敏感，必须上锁）
  /^\/api\/cleanup(\/|$)/,  // 重复文件清理（删文件，必须上锁）
  /^\/api\/asr(\/|$)/,      // AI 字幕生成（重 CPU 长任务 + 往影片目录写文件，必须上锁）
  /^\/api\/media\/\d+\/subtitle\/fetch$/,  // 网络字幕下载（外部请求 + 写影片目录文件，必须上锁）
  /^\/api\/media\/\d+\/embedded-sub$/,     // 内嵌字幕提取（ffmpeg 转出 + 写 cache/subcache 缓存文件，必须上锁）
  /^\/api\/perf(\/|$)/,     // 转码体检（POST 重测跑 10 秒 ffmpeg 基准，必须上锁）
];
/* 例外：解锁/上锁/查询本身必须能通；儿童模式的进入退出自带家长 PIN，不重复要密码 */
const ADMIN_LOCK_FREE = [
  /^\/api\/admin\/(unlock|lock|status)$/,
  /* artp39：观感类偏好（字幕微调/播放模式/隐藏入口）不该要管理密码——
     密码的语义是保护库与凭据，不是保护「我调一下字幕偏移」。 */
  /^\/api\/settings\/play-pref$/,
  /^\/api\/kids\/(enter|exit|check)$/,
  /^\/api\/backup(\/|$)/,    // 手机照片备份：家人配对/上传，不该要管理密码（gg 轮实修：8090 有锁时 backup.html 配对 403）
];

/* 探测本机某端口是否有人监听：游戏库 RomM 跑在 Docker 里（默认 8098）。
   只看 TCP 通不通，不发 HTTP 请求 —— 够快，也不会被对端登录态影响。 */
function tcpAlive(host, port, ms) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    sock.setTimeout(ms);
    sock.once('connect', () => fin(true));
    sock.once('timeout', () => fin(false));
    sock.once('error', () => fin(false));
    try { sock.connect(port, host); } catch { fin(false); }
  });
}

/* ---------------- 游戏商店：免费合法 ROM 目录与下载/上传 ----------------
   只收录作者授权自由分发的 homebrew 作品（retrobrews 社区合集等），不含商业游戏。
   下载/上传的文件自动放进 RomM ROM 目录的对应平台子目录（RomM 开了文件监听会自动扫描）。
   URL 白名单 + 扩展名/魔数识别，防止被当通用下载器/任意写接口滥用。 */
const GAMES_ROM_DIR = (() => {
  const env = String(process.env.HMP_ROM_DIR || '').trim();
  if (env) return env;
  for (const d of ['/share/游戏/ROM库', '/share/Multimediea/ROM库']) {
    try { if (fs.existsSync(d)) return d; } catch { /* ignore */ }
  }
  return '';
})();
const GAMES_CATALOG = [
  { id: 'nes-super-tilt-bro', name: '超级倾斜兄弟', desc: '对战足球 · 支持本机联机', platform: 'nes', file: 'super-tilt-bro.nes', url: 'https://raw.githubusercontent.com/retrobrews/nes-games/master/super-tilt-bro.nes' },
  { id: 'nes-madwizard', name: '疯狂法师', desc: '动作冒险 · 挥杖闯地牢', platform: 'nes', file: 'madwizard.nes', url: 'https://raw.githubusercontent.com/retrobrews/nes-games/master/madwizard.nes' },
  { id: 'nes-thwaite', name: '飞弹防城', desc: '纵向弹幕射击 · 守住城市', platform: 'nes', file: 'thwaite.nes', url: 'https://raw.githubusercontent.com/retrobrews/nes-games/master/thwaite.nes' },
  { id: 'nes-superuwol', name: '超级乌沃', desc: '平台跳跃 · 蛙拳出击', platform: 'nes', file: 'superuwol.nes', url: 'https://raw.githubusercontent.com/retrobrews/nes-games/master/superuwol.nes' },
  { id: 'nes-twindragons', name: '双龙传', desc: '双人合作动作过关', platform: 'nes', file: 'twindragons.nes', url: 'https://raw.githubusercontent.com/retrobrews/nes-games/master/twindragons.nes' },
  { id: 'nes-vigilanteninja', name: '义警忍者', desc: '忍者动作 · 营救同伴', platform: 'nes', file: 'vigilanteninja.nes', url: 'https://raw.githubusercontent.com/retrobrews/nes-games/master/vigilanteninja.nes' },
  { id: 'nes-jetpaco', name: '喷气帕科', desc: '飞行收集 · 太空冒险', platform: 'nes', file: 'jetpaco.nes', url: 'https://raw.githubusercontent.com/retrobrews/nes-games/master/jetpaco.nes' },
  { id: 'nes-lunarlimit', name: '月球极限', desc: '月球探索 · 解谜', platform: 'nes', file: 'lunarlimit.nes', url: 'https://raw.githubusercontent.com/retrobrews/nes-games/master/lunarlimit.nes' },
  { id: 'nes-babelblox', name: '巴别方块', desc: '益智消除', platform: 'nes', file: 'babelblox.nes', url: 'https://raw.githubusercontent.com/retrobrews/nes-games/master/babelblox.nes' },
  { id: 'nes-invaders', name: '入侵者必须死', desc: '固定屏射击', platform: 'nes', file: 'invaders.nes', url: 'https://raw.githubusercontent.com/retrobrews/nes-games/master/invaders.nes' },
  { id: 'gb-libbet', name: '利贝特与魔法地牢', desc: 'GB 经典 homebrew · 地牢探险', platform: 'gb', file: 'libbet.gb', url: 'https://github.com/pinobatch/libbet/releases/download/v0.08/libbet.gb' },
  { id: 'gbc-ucity', name: '微型城市', desc: '城市建造模拟', platform: 'gbc', file: 'ucity.gbc', url: 'https://raw.githubusercontent.com/retrobrews/gbc-games/master/ucity.gbc' },
  { id: 'gbc-geometrix', name: '几何方块', desc: '益智消除', platform: 'gbc', file: 'geometrix.gbc', url: 'https://raw.githubusercontent.com/retrobrews/gbc-games/master/geometrix.gbc' },
  { id: 'gbc-klondike', name: '空当接龙', desc: '纸牌 · 触屏友好', platform: 'gbc', file: 'klondike.gbc', url: 'https://raw.githubusercontent.com/retrobrews/gbc-games/master/klondike.gbc' },
  { id: 'gba-anguna', name: '安古纳', desc: '地牢冒险 · 探索打怪', platform: 'gba', file: 'anguna.gba', url: 'https://raw.githubusercontent.com/retrobrews/gba-games/master/anguna.gba' },
  { id: 'gba-battlepicross', name: '战斗绘图方块', desc: '数织益智 · 带剧情', platform: 'gba', file: 'battlepicross.gba', url: 'https://raw.githubusercontent.com/retrobrews/gba-games/master/battlepicross.gba' },
  { id: 'gba-blocktrap', name: '方块陷阱', desc: '推箱子式益智', platform: 'gba', file: 'blocktrap.gba', url: 'https://raw.githubusercontent.com/retrobrews/gba-games/master/blocktrap.gba' },
  { id: 'gba-bridgeracer', name: '桥梁竞速', desc: '跑酷竞速', platform: 'gba', file: 'bridgeracer.gba', url: 'https://raw.githubusercontent.com/retrobrews/gba-games/master/bridgeracer.gba' },
  { id: 'snes-superbossgaiden', name: '超级BOSS外传', desc: '短篇动作 · SNES 名作', platform: 'snes', file: 'superbossgaiden.sfc', url: 'https://raw.githubusercontent.com/retrobrews/snes-games/master/superbossgaiden.sfc' },
  { id: 'snes-nwarpdaisakusen', name: 'N-Warp大作战', desc: '高难平台动作', platform: 'snes', file: 'nwarpdaisakusen.smc', url: 'https://raw.githubusercontent.com/retrobrews/snes-games/master/nwarpdaisakusen.smc' },
  { id: 'snes-jetpilotrising', name: '喷气机师崛起', desc: '飞行射击', platform: 'snes', file: 'jetpilotrising.sfc', url: 'https://raw.githubusercontent.com/retrobrews/snes-games/master/jetpilotrising.sfc' },
  { id: 'snes-rockfall', name: '岩石坠落', desc: '物理解谜', platform: 'snes', file: 'rockfall.smc', url: 'https://raw.githubusercontent.com/retrobrews/snes-games/master/rockfall.smc' },
];
const GAMES_DL = {}; // id -> {id,name,platform,file,status,downloaded,total,speed,error}
const GAMES_URL_OK = [
  'https://raw.githubusercontent.com/retrobrews/',
  'https://github.com/pinobatch/libbet/releases/download/',
];
const GAMES_MAX_UPLOAD = 512 * 1024 * 1024;
/* 扩展名 -> RomM 平台目录名（与 RomM 平台 slug 一致） */
const GAME_EXT_PLAT = {
  nes: 'nes', unf: 'nes', fds: 'fds',
  gb: 'gb', gbc: 'gbc',
  gba: 'gba', agb: 'gba',
  nds: 'nds', ds: 'nds',
  smc: 'snes', sfc: 'snes', swc: 'snes', fig: 'snes',
  md: 'md', gen: 'md', smd: 'md', '32x': 'sega32x',
  z64: 'n64', n64: 'n64', v64: 'n64',
  iso: 'psx', pbp: 'psx', chd: 'psx', cue: 'psx', img: 'psx',
  pce: 'tg16', a26: 'atari2600', a78: 'atari7800',
  ws: 'wonderswan', wsc: 'wonderswan-color',
  ngp: 'neo-geo-pocket', ngc: 'neo-geo-pocket-color',
  lnx: 'lynx', zip: 'zip', '7z': 'zip',
};
function gamesCatalog() {
  const games = GAMES_CATALOG.map((g) => {
    let installed = false, installedSize = 0;
    try {
      const st = fs.statSync(path.join(GAMES_ROM_DIR, g.platform, g.file));
      installed = st.isFile() && st.size > 1024;
      installedSize = st.size;
    } catch { /* 未安装 */ }
    return Object.assign({}, g, { installed, installedSize });
  });
  return { ok: !!GAMES_ROM_DIR, romDir: GAMES_ROM_DIR, games, jobs: Object.values(GAMES_DL) };
}
function gameDownload(id) {
  if (!GAMES_ROM_DIR) return { ok: false, code: 400, error: '未找到 ROM 目录（HMP_ROM_DIR）' };
  const g = GAMES_CATALOG.find((x) => x.id === id);
  if (!g) return { ok: false, code: 404, error: '目录里没有这个游戏' };
  if (!GAMES_URL_OK.some((u) => g.url.startsWith(u))) return { ok: false, code: 400, error: '下载来源不在白名单' };
  if (!/^[\w.-]+$/.test(g.file) || g.file.includes('..')) return { ok: false, code: 400, error: '文件名不合法' };
  let job = GAMES_DL[id];
  if (job && (job.status === 'downloading' || job.status === 'pending')) return { ok: true, data: { ok: true, job } };
  if (job && job.status === 'done') return { ok: true, data: { ok: true, job, note: '已安装' } };
  job = GAMES_DL[id] = { id, name: g.name, platform: g.platform, file: g.file, status: 'pending', downloaded: 0, total: 0, speed: 0, error: '' };
  gamesDownloadStart(g, job);
  return { ok: true, data: { ok: true, job } };
}
function gamesDownloadStart(g, job) {
  job.status = 'downloading';
  const dir = path.join(GAMES_ROM_DIR, g.platform);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { job.status = 'error'; job.error = '目录创建失败'; return; }
  const tmp = path.join(dir, '.' + g.file + '.part');
  try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  const MAX_TRIES = 3; // GitHub raw 国内直连时快时慢：失败后整个重来，最多 3 次
  const fail = (msg) => {
    if (job.status === 'done') return;
    job._tries = (job._tries || 1) + 1;
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    if (job._tries <= MAX_TRIES) {
      job.error = msg + '，重试中 (' + (job._tries - 1) + '/' + (MAX_TRIES - 1) + ')';
      setTimeout(() => {
        if (job.status === 'done') return;
        job.status = 'downloading'; job.downloaded = 0;
        get(g.url, 0);
      }, 3000 * job._tries);
    } else {
      job.status = 'error'; job.error = msg;
    }
  };
  const get = (url, hops) => {
    if (hops > 4) { fail('重定向过多'); return; }
    const mod = url.startsWith('https:') ? require('node:https') : http;
    const rq = mod.get(url, { headers: { 'User-Agent': 'HomeMediaPlayer/1.0' }, timeout: 60000 }, (rs) => {
      if (rs.statusCode >= 300 && rs.statusCode < 400 && rs.headers.location) {
        rs.resume();
        return get(new URL(rs.headers.location, url).href, hops + 1);
      }
      if (rs.statusCode !== 200) {
        rs.resume();
        fail('HTTP ' + rs.statusCode);
        return;
      }
      job.total = Number(rs.headers['content-length']) || 0;
      const ws = fs.createWriteStream(tmp);
      let lastT = Date.now(); let lastB = 0;
      rs.on('data', (c) => {
        job.downloaded += c.length;
        const now = Date.now();
        if (now - lastT >= 500) { job.speed = Math.round(((job.downloaded - lastB) * 1000) / (now - lastT)); lastT = now; lastB = job.downloaded; }
        if (job.downloaded > 256 * 1024 * 1024) { try { rq.destroy(new Error('超过大小上限')); } catch { /* ignore */ } }
      });
      rs.pipe(ws);
      ws.on('finish', () => {
        if (job.status === 'error') return;
        try { fs.renameSync(tmp, path.join(dir, g.file)); job.status = 'done'; job.total = job.downloaded; job.speed = 0; job.error = ''; }
        catch (e) { fail('落盘失败'); return; }
        rommScanSoon(15000); // 落盘 15 秒后主动触发一次全库扫描，别只指望文件监听器
      });
      ws.on('error', () => { fail('写入失败'); });
    });
    rq.on('timeout', () => { try { rq.destroy(new Error('下载超时')); } catch { /* ignore */ } });
    rq.on('error', (e) => { fail(String((e && e.message) || '网络错误')); });
  };
  get(g.url, 0);
}
function gameMagicExt(h, size) {
  if (h.length >= 4 && h[0] === 0x4e && h[1] === 0x45 && h[2] === 0x53 && h[3] === 0x1a) return 'nes';
  if (size > 0x150 && h.length >= 0x150 && h.slice(0x104, 0x10e).toString('latin1') === 'Nintendo') {
    const cgb = h[0x143];
    return (cgb === 0x80 || cgb === 0xc0) ? 'gbc' : 'gb';
  }
  if (size > 0x200 && h.length >= 0x200 && h.slice(0x100, 0x104).toString('latin1') === 'SEGA') return 'md';
  if (h.length >= 4 && h[0] === 0x80 && h[1] === 0x37 && h[2] === 0x12 && h[3] === 0x40) return 'n64';
  return '';
}
function gameZipExt(buf) {
  /* zip：先扫 central directory（PK\x01\x02，文件名在 +46），退回扫 local header（PK\x03\x04，+30） */
  const cdsig = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let pos = buf.indexOf(cdsig); let seen = 0;
  while (pos !== -1 && seen < 128) {
    seen++;
    const nl = buf.readUInt16LE(pos + 28);
    if (pos + 46 + nl <= buf.length) {
      const name = buf.slice(pos + 46, pos + 46 + nl).toString('latin1');
      const ext = (name.split('.').pop() || '').toLowerCase();
      const plat = GAME_EXT_PLAT[ext];
      if (plat && plat !== 'zip') return plat;
    }
    pos = buf.indexOf(cdsig, pos + 4);
  }
  const lhsig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  pos = buf.indexOf(lhsig); seen = 0;
  while (pos !== -1 && seen < 128) {
    seen++;
    const nl = buf.readUInt16LE(pos + 26);
    if (pos + 30 + nl <= buf.length) {
      const name = buf.slice(pos + 30, pos + 30 + nl).toString('latin1');
      const ext = (name.split('.').pop() || '').toLowerCase();
      const plat = GAME_EXT_PLAT[ext];
      if (plat && plat !== 'zip') return plat;
    }
    pos = buf.indexOf(lhsig, pos + 4);
  }
  return '';
}
function gamePlace(tmpPath, baseName) {
  const ext = (baseName.split('.').pop() || '').toLowerCase();
  let plat = GAME_EXT_PLAT[ext] || '';
  const size = fs.statSync(tmpPath).size;
  let fd;
  try {
    fd = fs.openSync(tmpPath, 'r');
    if (plat === 'zip') {
      const tail = Buffer.alloc(Math.min(size, 1024 * 1024));
      fs.readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
      plat = gameZipExt(tail) || '';
    }
    if (!plat) {
      const head = Buffer.alloc(Math.min(size, 0x200));
      fs.readSync(fd, head, 0, head.length, 0);
      plat = gameMagicExt(head, size);
    }
  } finally { try { if (fd !== undefined) fs.closeSync(fd); } catch { /* ignore */ } }
  if (!plat) return { error: '无法识别游戏平台，请用标准扩展名（.nes .sfc .smc .gb .gbc .gba .nds .z64 .md .iso …）' };
  const dir = path.join(GAMES_ROM_DIR, plat);
  fs.mkdirSync(dir, { recursive: true });
  let name = baseName; let i = 2;
  const dot = baseName.lastIndexOf('.');
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const suffix = dot > 0 ? baseName.slice(dot) : '';
  while (fs.existsSync(path.join(dir, name))) { name = stem + ' (' + i + ')' + suffix; i++; }
  const dest = path.join(dir, name);
  fs.copyFileSync(tmpPath, dest);
  return { platform: plat, file: name, size };
}
function gameUpload(req, res) {
  return new Promise((resolve) => {
    const done = (code, obj) => { try { resolve(json(res, code, obj)); } catch (e) { resolve(); } };
    if (!GAMES_ROM_DIR) return done(400, { error: '未找到 ROM 目录（HMP_ROM_DIR）' });
    let rawName = '';
    try { rawName = decodeURIComponent(String(req.headers['x-game-filename'] || '')); } catch { rawName = ''; }
    const base = path.basename(rawName || '');
    if (!base || !/^[\w\-. ()\[\]]+$/.test(base)) return done(400, { error: '文件名不合法' });
    const clen = Number(req.headers['content-length']) || 0;
    if (!clen) return done(400, { error: '没有收到文件内容' });
    if (clen > GAMES_MAX_UPLOAD) return done(400, { error: '文件太大（上限 512MB）' });
    const tmp = path.join(GAMES_ROM_DIR, '.upload-' + Date.now() + '.part');
    const ws = fs.createWriteStream(tmp);
    let abort = false;
    req.on('data', (c) => { if (ws.bytesWritten + c.length > GAMES_MAX_UPLOAD) { abort = true; try { req.destroy(); } catch { /* ignore */ } } });
    req.on('error', () => { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } done(400, { error: '上传中断' }); });
    req.pipe(ws);
    ws.on('error', () => done(400, { error: '写入失败' }));
    ws.on('finish', () => {
      if (abort) { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } return done(400, { error: '文件太大（上限 512MB）' }); }
      let r;
      try { r = gamePlace(tmp, base); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } return done(400, { error: '无法识别游戏平台' }); }
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      if (r.error) return done(400, r);
      console.log('[游戏商店] 上传入库：' + r.platform + ' / ' + r.file + ' (' + Math.round(r.size / 1024) + 'KB)');
      rommScanSoon(15000);
      done(200, { ok: true, platform: r.platform, file: r.file, size: r.size });
    });
  });
}

/* ---------------- 游戏库 · 封面元数据源密钥（可选） ----------------
   RomM 自带免注册的 Hasheous，没填任何 Key 也能刮出基本封面；
   想要更准的封面与简介，去下面几家免费注册拿 Key，填进来写进 RomM 的 .env 即可。
   别人的机器安装目录名不固定 —— RomM 目录一律自动探测，不写死任何路径。 */
const ROMM_ENV_KEYS = [
  { key: 'SCREENSCRAPER_USER', label: 'ScreenScraper 用户名', hint: 'screenscraper.fr 免费注册（封面/简介最全，首选）' },
  { key: 'SCREENSCRAPER_PASSWORD', label: 'ScreenScraper 密码', hint: '同上，注册时填的密码', secret: true },
  { key: 'IGDB_CLIENT_ID', label: 'IGDB Client ID', hint: 'dev.twitch.tv 建一个 Application 即可拿到' },
  { key: 'IGDB_CLIENT_SECRET', label: 'IGDB Client Secret', hint: '同上，与 ID 成对使用', secret: true },
  { key: 'STEAMGRIDDB_API_KEY', label: 'SteamGridDB API Key', hint: 'steamgriddb.com 登录后个人资料页取', secret: true },
  { key: 'RETROACHIEVEMENTS_API_KEY', label: 'RetroAchievements Key', hint: 'retroachievements.org 设置里的 Web API Key', secret: true },
];
/* 自动定位 RomM 的 compose 目录：HMP_ROMM_DIR 覆盖 → 本程序同级/下级 romm → 兜底扫公共根目录 */
function rommFindDir() {
  const cands = [];
  const env = String(process.env.HMP_ROMM_DIR || '').trim();
  if (env) cands.push(env);
  const here = __dirname;
  cands.push(path.join(path.dirname(here), 'romm'), path.join(here, 'romm'));
  for (const d of cands) {
    try { if (fs.existsSync(path.join(d, 'docker-compose.yml'))) return path.resolve(d); } catch { /* ignore */ }
  }
  // 兜底：在常见共享根目录下找含 rommapp/romm 镜像的 compose（最多三层，限时 3 秒）
  const t0 = Date.now();
  let hit = '';
  const isRomM = (d) => {
    try {
      const cf = path.join(d, 'docker-compose.yml');
      if (!fs.existsSync(cf)) return false;
      return fs.readFileSync(cf, 'utf8').indexOf('rommapp/romm') >= 0;
    } catch { return false; }
  };
  const walk = (dir, depth) => {
    if (hit || depth > 3 || Date.now() - t0 > 3000) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (hit) return;
      if (!e.isDirectory()) continue;
      if (e.name.indexOf('@') === 0 || e.name === '.qpkg') continue; // 跳过回收站与系统目录
      const d = path.join(dir, e.name);
      if (isRomM(d)) { hit = d; return; }
      walk(d, depth + 1);
    }
  };
  for (const root of ['/share', '/volume1', '/mnt', '/data']) {
    try { if (fs.existsSync(root)) walk(root, 1); } catch { /* ignore */ }
    if (hit) break;
  }
  return hit ? path.resolve(hit) : '';
}
const ROMM_DIR = rommFindDir();
function rommMask(v) {
  const s = String(v || '');
  return s.length <= 4 ? '••••' : s.slice(0, 2) + '••••' + s.slice(-2);
}
function rommEnvRead() {
  const out = {};
  if (!ROMM_DIR) return out;
  try {
    const txt = fs.readFileSync(path.join(ROMM_DIR, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const mm = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (mm) out[mm[1]] = mm[2];
    }
  } catch { /* 还没装或 .env 不存在 */ }
  return out;
}
function rommEnvWrite(patch) {
  if (!ROMM_DIR) return { ok: false, error: '未找到 RomM 目录（可用 HMP_ROMM_DIR 指定）' };
  const f = path.join(ROMM_DIR, '.env');
  let lines = [];
  try { lines = fs.readFileSync(f, 'utf8').split(/\r?\n/); } catch { lines = []; }
  for (const k of Object.keys(patch)) {
    const v = String(patch[k] == null ? '' : patch[k]).replace(/[\r\n]/g, '');
    const i = lines.findIndex((l) => new RegExp('^\\s*' + k + '\\s*=').test(l));
    if (i >= 0) lines[i] = k + '=' + v; else lines.push(k + '=' + v);
  }
  const txt = lines.join('\n').replace(/\n{3,}$/, '\n');
  try {
    fs.writeFileSync(f, txt.endsWith('\n') ? txt : txt + '\n');
    fs.chmodSync(f, 0o600);
  } catch (e) { return { ok: false, error: '写 .env 失败：' + e.message }; }
  return { ok: true };
}
function rommMetaKeys() {
  const cur = rommEnvRead();
  return {
    ok: !!ROMM_DIR,
    dir: ROMM_DIR || '',
    keys: ROMM_ENV_KEYS.map((k) => Object.assign({}, k, {
      set: String(cur[k.key] || '').length > 0,
      preview: String(cur[k.key] || '') ? (k.secret ? rommMask(cur[k.key]) : String(cur[k.key])) : '',
    })),
  };
}
/* 重启 RomM 容器让新 Key 生效：优先用自带的 romm-ctl.sh（它会自己找 docker） */
function rommRestart() {
  return new Promise((resolve) => {
    if (!ROMM_DIR) return resolve({ ok: false, error: '未找到 RomM 目录' });
    const ctl = path.join(ROMM_DIR, 'romm-ctl.sh');
    const args = fs.existsSync(ctl) ? [ctl, 'restart'] : ['-c', 'docker compose restart'];
    execFile('sh', args, { cwd: ROMM_DIR, timeout: 150000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        out: String(stdout || '').slice(-300),
        error: err ? String((stderr || err.message || '')).slice(-300) : '',
      });
    });
  });
}
/* 保存后回读心跳，确认 RomM 真的把这些数据源打开了（比只看文件落地更可靠） */
async function rommHeartbeat(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/heartbeat`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return {};
    const j = await r.json();
    return {
      igdb: !!j.IGDB_API_ENABLED,
      steamgriddb: !!j.STEAMGRIDDB_API_ENABLED,
      hasheous: !!j.HASHEOUS_API_ENABLED,
      rommVersion: j.VERSION || '',
    };
  } catch { return {}; }
}

/* ---------------- 游戏库 · 免登录通道（服务端代持凭据） ----------------
   RomM 自带账号体系，浏览器直开会被挡在登录页；而把它内嵌进网页又会让标签页直接崩溃
   （实测 RomM 5.3.x 被 iframe 嵌入必崩，与代理、来源、沙箱都无关）。
   这里的做法是「凭据交给服务端代持一次，之后全家免登录」：
     ① 安装时或设置页把游戏库的管理员账号密码存进来；
     ② 服务端拿它换 RomM 的会话 Cookie（先取 CSRF，再 /api/login）；
     ③ 所有 /romm/ 请求由代理注入这个会话 —— 浏览器从头到尾不需要登录；
     ④ 游戏页只从 RomM 取封面和简介做成海报墙，点「打开游戏」在新窗口进 RomM 自己的播放页。
   凭据只落在本机（数据库 / romm/.env），接口对外只回掩码，不回明文。 */
const ROMM_SESS = { cookie: '', bearer: '', at: 0, err: '', user: '' };
const ROMM_SESS_TTL = 20 * 60 * 1000;

function rommCreds() {
  let user = String(db.getSetting('rommUser', '') || '').trim();
  let pass = String(db.getSetting('rommPass', '') || '').trim();
  if (!user || !pass) {
    // 设置页没配过时，用安装脚本写进 romm/.env 的初始账号
    try {
      const env = rommEnvRead();
      if (!user) user = String(env.HMP_ROMM_USER || '').trim();
      if (!pass) pass = String(env.HMP_ROMM_PASS || '').trim();
    } catch { /* 没找到 RomM 目录就只认设置页 */ }
  }
  return { user, pass };
}

function rommCookieJar(res) {
  const out = {};
  const list = (res.headers && res.headers.getSetCookie) ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const mm = /^([^=]+)=([^;]*)/.exec(String(c));
    if (mm) out[mm[1].trim()] = mm[2];
  }
  return out;
}

async function rommLogin(force) {
  const { user, pass } = rommCreds();
  if (!user || !pass) {
    ROMM_SESS.cookie = ''; ROMM_SESS.bearer = '';
    ROMM_SESS.err = '还没填游戏库的账号密码';
    return { ok: false, error: ROMM_SESS.err, needCred: true };
  }
  if (!force && ROMM_SESS.cookie && Date.now() - ROMM_SESS.at < ROMM_SESS_TTL) return { ok: true, cached: true };
  const base = rommOrigin();
  try {
    // ① RomM 的登录接口带 CSRF 校验：先随便请求一次拿 csrf cookie，缺令牌会 403
    const r0 = await fetch(base + '/api/heartbeat', { signal: AbortSignal.timeout(8000) });
    const csrf = rommCookieJar(r0).romm_csrftoken || '';
    // ② 换会话。★ RomM 的登录是 HTTP Basic（它的前端就是 axios 的 auth 选项），
    //    不是 JSON body —— 早年按 JSON 发会一直吃 401（表现：账号密码明明对却登不上）。
    const basic = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
    const baseHeaders = Object.assign(
      { Accept: 'application/json', 'X-CSRFToken': csrf },
      csrf ? { cookie: 'romm_csrftoken=' + csrf } : {},
    );
    let r1 = await fetch(base + '/api/login', {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
      headers: Object.assign({ Authorization: basic, 'Content-Type': 'application/json' }, baseHeaders),
      body: '{}',
    });
    if (r1.status === 400 || r1.status === 401 || r1.status === 422) {
      // 万一哪天改回表单/JSON，这里兜一次
      try { await r1.text(); } catch { /* 忽略 */ }
      r1 = await fetch(base + '/api/login', {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(12000),
        headers: Object.assign({ 'Content-Type': 'application/json' }, baseHeaders),
        body: JSON.stringify({ username: user, password: pass }),
      });
    }
    const jar = rommCookieJar(r1);
    let sess = jar.romm_session || jar.fastapiusersauth || jar.session || '';
    if (!sess) {
      // 兜底：登录响应里除 CSRF 之外只剩一个 cookie，那必然就是会话（不同版本名字可能变）
      const rest = Object.keys(jar).filter((k) => k !== 'romm_csrftoken');
      if (rest.length === 1) sess = jar[rest[0]];
    }
    let bearer = '';
    if (!sess) {
      try {
        const t = await r1.text();
        const mm = /"access_token"\s*:\s*"([^"]+)"/.exec(t);
        if (mm) bearer = mm[1];
      } catch { /* 204 无正文也正常 */ }
    }
    if (!sess && !bearer) {
      ROMM_SESS.cookie = ''; ROMM_SESS.bearer = '';
      ROMM_SESS.err = r1.status === 401 || r1.status === 400
        ? '登录失败：账号或密码不对'
        : '登录失败（HTTP ' + r1.status + '）';
      return { ok: false, error: ROMM_SESS.err, status: r1.status };
    }
    ROMM_SESS.cookie = sess; ROMM_SESS.bearer = bearer;
    ROMM_SESS.at = Date.now(); ROMM_SESS.err = ''; ROMM_SESS.user = user;
    return { ok: true };
  } catch (e) {
    ROMM_SESS.cookie = ''; ROMM_SESS.bearer = '';
    ROMM_SESS.err = '连不上游戏库：' + String((e && e.message) || e).slice(0, 120);
    return { ok: false, error: ROMM_SESS.err };
  }
}

/* 代理要带的认证头；会话过期会自动重登一次 */
async function rommAuthHeaders() {
  const r = await rommLogin(false);
  if (!r.ok) return null;
  const h = {};
  if (ROMM_SESS.cookie) h.cookie = 'romm_session=' + ROMM_SESS.cookie;
  if (ROMM_SESS.bearer) h.authorization = 'Bearer ' + ROMM_SESS.bearer;
  return h;
}

/* 用代持会话调 RomM 接口（401/403 自动重登重试一次） */
async function rommApi(pathname, params, retry) {
  const auth = await rommAuthHeaders();
  if (!auth) return { ok: false, error: ROMM_SESS.err || '游戏库未登录' };
  const qs = params && Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '';
  try {
    const r = await fetch(rommOrigin() + pathname + qs, { headers: auth, signal: AbortSignal.timeout(25000) });
    if ((r.status === 401 || r.status === 403) && !retry) {
      await rommLogin(true);
      return rommApi(pathname, params, true);
    }
    return { ok: r.ok, status: r.status, res: r };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) };
  }
}

/* 触发 RomM 全库扫描。RomM 5.x 把扫描挂在 socket.io 的 "scan" 事件上（/ws/socket.io），
   没有 REST 接口 —— 这里按引擎轮询协议裸握手：握手 GET 带上代持的会话 Cookie，
   服务端在 connect 时解析出用户身份，scan 事件才不会被判未授权。 */
let ROMM_SCAN_T = null;
async function rommScan() {
  const auth = await rommAuthHeaders();
  if (!auth || !auth.cookie) return { ok: false, error: ROMM_SESS.err || '游戏库未登录' };
  const base = rommOrigin();
  const t = () => Date.now() + '' + Math.floor(Math.random() * 1e6);
  const opt = (m, qs, body) => ({
    method: m,
    headers: Object.assign({ cookie: auth.cookie }, body ? { 'Content-Type': 'text/plain;charset=UTF-8' } : {}),
    body: body || undefined,
    signal: AbortSignal.timeout(9000),
  });
  try {
    const hs = await fetch(base + '/ws/socket.io/?EIO=4&transport=polling&t=' + t(), opt('GET'))
      .then((r) => r.text()).catch(() => '');
    const mm = /"sid":"([^"]+)"/.exec(String(hs || ''));
    if (!mm) return { ok: false, error: 'socket 握手失败' };
    const qs = 'EIO=4&transport=polling&sid=' + mm[1] + '&t=' + t();
    await fetch(base + '/ws/socket.io/?' + qs, opt('POST', null, '40')); // 连接默认命名空间
    await new Promise((r) => setTimeout(r, 700));
    await fetch(base + '/ws/socket.io/?' + qs, opt('POST', null, '42' + JSON.stringify(['scan', { platforms: [], type: 'quick' }])));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 120) };
  }
}
/* 下载/上传落盘后统一走这里：文件监听器在高并发写盘时会丢 inotify 事件（本轮 8 个 NES 全漏），
   扫描不能只指望它 —— 延迟一拍由 HMP 主动触发一次全库扫描兜底。 */
function rommScanSoon(ms) {
  clearTimeout(ROMM_SCAN_T);
  ROMM_SCAN_T = setTimeout(() => { rommScan().catch(() => {}); }, ms || 15000);
}

/* 封面地址统一成浏览器能取到的形式：RomM 本地资源（/assets/...）走同源代理，
   IGDB 那种外链（http 开头）保持原样 —— 加 /romm 前缀反而会 404。 */
function rommCoverUrl(r) {
  // RomM 给的资源路径尾部可能带 ?ts=2026-09-24 05:47:08 这种含空格的查询串，空格要编码掉
  const clean = (s) => String(s || '').replace(/ /g, '%20');
  const local = String(r.path_cover_large || r.path_cover_small || '');
  if (local && /^\//.test(local)) return clean('/romm' + local);
  const u = String(r.url_cover || '');
  if (/^https?:/i.test(u)) return u;
  if (u && /^\//.test(u)) return '/romm' + u;
  return '';
}

/* 在线校验：填错一个字符，刮削就是全线失败 —— 当场验证比事后排查省事得多。
   ScreenScraper 的 devid 用 RomM 镜像自带的开发账号（与 RomM 自己发请求时一致）。 */
async function rommMetaTest(o) {
  const out = [];
  const ssU = String(o.SCREENSCRAPER_USER || '').trim();
  const ssP = String(o.SCREENSCRAPER_PASSWORD || '');
  if (ssU && ssP) {
    const ssDevId = process.env.HMP_SS_DEVID || 'zurdi15';
    const ssDevPw = process.env.HMP_SS_DEVPASSWORD || 'gdDFD4GFg3Rm';
    const u = 'https://www.screenscraper.fr/api2/ssuserInfos.php?devid=' + encodeURIComponent(ssDevId) + '&devpassword=' + encodeURIComponent(ssDevPw)
      + '&softname=hmp&output=json&ssid=' + encodeURIComponent(ssU) + '&sspassword=' + encodeURIComponent(ssP);
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      const ok = !!(j && j.ssuser && j.ssuser.id);
      out.push({ key: 'SCREENSCRAPER_USER', ok, msg: ok ? '账号可用' + (j.ssuser.maxthreads ? '（并发 ' + j.ssuser.maxthreads + '）' : '') : '账号或密码不对' });
    } catch (e) { out.push({ key: 'SCREENSCRAPER_USER', ok: false, msg: '连不上 ScreenScraper：' + e.message }); }
  }
  const ig = String(o.IGDB_CLIENT_ID || '').trim();
  const igs = String(o.IGDB_CLIENT_SECRET || '');
  if (ig && igs) {
    try {
      const r = await fetch('https://id.twitch.tv/oauth2/token?client_id=' + encodeURIComponent(ig)
        + '&client_secret=' + encodeURIComponent(igs) + '&grant_type=client_credentials',
        { method: 'POST', signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      out.push({ key: 'IGDB_CLIENT_ID', ok: !!j.access_token, msg: j.access_token ? '可以取到令牌' : (j.message || 'ID 或 Secret 不对') });
    } catch (e) { out.push({ key: 'IGDB_CLIENT_ID', ok: false, msg: '连不上 Twitch：' + e.message }); }
  }
  const sg = String(o.STEAMGRIDDB_API_KEY || '').trim();
  if (sg) {
    try {
      const r = await fetch('https://www.steamgriddb.com/api/v2/profile', {
        headers: { Authorization: 'Bearer ' + sg }, signal: AbortSignal.timeout(15000),
      });
      const j = await r.json();
      out.push({ key: 'STEAMGRIDDB_API_KEY', ok: r.ok && !!j.success, msg: r.ok && j.success ? 'Key 有效' : 'Key 无效或无权限' });
    } catch (e) { out.push({ key: 'STEAMGRIDDB_API_KEY', ok: false, msg: '连不上 SteamGridDB：' + e.message }); }
  }
  const ra = String(o.RETROACHIEVEMENTS_API_KEY || '').trim();
  const raU = String(o.RETROACHIEVEMENTS_USER || '').trim();
  if (ra && raU) {
    try {
      const r = await fetch('https://retroachievements.org/API/API_GetUserSummary.php?z=' + encodeURIComponent(raU)
        + '&y=' + encodeURIComponent(ra) + '&g=1&a=0', { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      out.push({ key: 'RETROACHIEVEMENTS_API_KEY', ok: !!j.ID, msg: j.ID ? 'Key 有效' : 'Key 或用户名不对' });
    } catch (e) { out.push({ key: 'RETROACHIEVEMENTS_API_KEY', ok: false, msg: '连不上 RetroAchievements：' + e.message }); }
  } else if (ra) {
    out.push({ key: 'RETROACHIEVEMENTS_API_KEY', ok: false, msg: 'Key 已填，再填一次用户名才能校验' });
  }
  return { ok: true, results: out };
}

/* ---------------- 路由 ---------------- */
async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  const m = req.method;

  if (m === 'GET' && p === '/api/health') {
    const roots = db.listRoots();
    return json(res, 200, {
      ok: true,
      bins: { ready: bins.status().ready, missing: bins.status().missing },
      roots: roots.length,
      scanning: scanState.running,
      stats: db.countByKind(),
      version: '0.1.0-web',
    });
  }

  /* 网络与系统自诊断（A3）：GET 巡检（只读） / POST 修复（安全可逆动作），均走管理锁 */
  /* ---------------- C1 能力边界透明化：兼容矩阵（哪些片要转码、为什么） ----------------
   * 按 (视频编码, 音频编码) 分组统计本库片源，并给出「主流浏览器能否直连」的判定。
   * 判定口径与前端 renderPlayer 的 vDirect/aDirect 保持一致（服务端无法探测用户设备，
   * 故按 Chrome/Edge/Safari 的通用能力给出「通常可直连 / 需扩展或换浏览器 / 需转码」三档）。 */
  if (m === 'GET' && p === '/api/media/codecs') {
    try {
      const rows = db.all(
        `SELECT IFNULL(NULLIF(vcodec,''),'未知') AS vcodec,
                IFNULL(NULLIF(acodec,''),'未知') AS acodec,
                COUNT(*) AS n, IFNULL(SUM(size),0) AS bytes,
                MAX(IFNULL(width,0)) AS w, MAX(IFNULL(height,0)) AS h
         FROM media_files
         WHERE kind IN ('movie','episode')
         GROUP BY vcodec, acodec
         ORDER BY bytes DESC LIMIT 60`
      ) || [];
      const V_OK = /^(h264|avc|vp9|av1|mpeg4)$/i;
      const V_COND = /^(hevc|hvc1|h265)$/i;
      const A_OK = /^(aac|mp3|mpeg audio|opus|flac)$/i;
      const A_COND = /^ac-?3$/i;
      const classify = (r) => {
        const v = r.vcodec || '';
        const a = r.acodec || '';
        const vOk = V_OK.test(v);
        const vCond = V_COND.test(v);
        const aOk = A_OK.test(a);
        const aCond = A_COND.test(a) || /^(e-?ac-?3|truehd|dts-?hd?|dts)$/i.test(a);
        if (vOk && aOk) return { mode: 'direct', label: '直连零转码', tone: 'ok' };
        if ((vOk || vCond) && !aCond) return { mode: 'direct', label: '直连零转码', tone: 'ok' };
        if ((vOk || vCond) && aCond) return { mode: 'remux', label: '仅转音频（视频原样）', tone: 'warn' };
        if (vCond && !aCond) return { mode: 'remux', label: '仅转音频（视频原样）', tone: 'warn' };
        return { mode: 'transcode', label: '需整体转码', tone: 'bad' };
      };
      const out = rows.map((r) => {
        const c = classify(r);
        return {
          vcodec: r.vcodec || '未知', acodec: r.acodec || '未知',
          n: Number(r.n) || 0, bytes: Number(r.bytes) || 0,
          res: Number(r.h) ? `${r.w}×${r.h}` : '',
          mode: c.mode, modeLabel: c.label, tone: c.tone,
          hint: /^(hevc|hvc1|h265)$/i.test(r.vcodec || '')
            ? 'HEVC：Chrome 需装微软 HEVC 扩展，Edge/电视原生支持'
            : (/^(e-?ac-?3|truehd|dts-?hd?|dts)$/i.test(r.acodec || '') ? 'EAC3/TrueHD/DTS：浏览器基本不解，需服务端转音频' : ''),
        };
      });
      const tot = out.reduce((s, r) => {
        s.files += r.n; s.bytes += r.bytes;
        s[r.mode] += r.n;
        return s;
      }, { files: 0, bytes: 0, direct: 0, remux: 0, transcode: 0 });
      return json(res, 200, { rows: out, totals: tot, at: Date.now() });
    } catch (e) {
      return json(res, 200, { rows: [], totals: { files: 0, bytes: 0, direct: 0, remux: 0, transcode: 0 }, error: e.message, at: Date.now() });
    }
  }

  if (m === 'GET' && p === '/api/diag/run') {
    try {
      return json(res, 200, await diag.run());
    } catch (e) {
      return json(res, 200, { items: [], score: { ok: 0, warn: 0, bad: 1 }, error: e.message, at: Date.now() });
    }
  }
  if (m === 'POST' && p === '/api/diag/fix') {
    const body = await readBody(req).catch(() => ({}));
    const r = await diag.fix(String((body && body.action) || ''));
    return json(res, r.ok ? 200 : 400, r);
  }

  /* ---------------- 手机遥控器（E3） ----------------
     配对码会话 + SSE 双向通道：手机（role=phone）发指令、电视/电脑播放页（role=tv）收指令并上报状态。
     刻意放在管理锁与儿童模式守卫之前：遥控只是操控本机播放，不是"改设置"，
     让手机端还要先输管理密码是纯粹的自找麻烦。安全性靠 6 位一次性配对码 + 局域网友好。
     注意：/events 是长连接，接管 res 后必须 return，绝不能再走到后面的 json()。 */
  {
    const mc = p.match(/^\/api\/remote\/([A-Z0-9]{4,12})(\/(\w+))?$/);
    if (mc) {
      const code = mc[1];
      const sub = mc[3] || '';
      if (!sub && m === 'GET') {
        const s = remote.get(code);
        if (!s) return json(res, 404, { error: '配对码无效或已过期', expired: true });
        return json(res, 200, Object.assign({ ok: true }, remote.info(s)));
      }
      if (sub === 'events' && m === 'GET') {
        const s = remote.get(code);
        if (!s) return json(res, 404, { error: '配对码无效或已过期', expired: true });
        remote.attach(s, url.searchParams.get('role') === 'tv' ? 'tv' : 'phone', res);
        return; // 长连接已接管 res
      }
      if ((sub === 'cmd' || sub === 'state') && m === 'POST') {
        const s = remote.get(code);
        if (!s) return json(res, 404, { error: '配对码无效或已过期', expired: true });
        const body = await readBody(req).catch(() => ({}));
        if (!body || typeof body !== 'object') return json(res, 400, { error: '请求体格式不对' });
        const r = sub === 'cmd' ? remote.cmd(s, body) : remote.state(s, body);
        return json(res, r.ok ? 200 : 400, r);
      }
    }
  }
  if (m === 'POST' && p === '/api/remote/new') {
    let s;
    try { s = remote.create(); } catch (e) { return json(res, 500, { error: String((e && e.message) || e) }); }
    return json(res, 200, { ok: true, code: s.code, createdAt: s.createdAt });
  }

  /* ---------------- 游戏库（RomM，可选组件） ----------------     游戏库独立跑在 Docker 容器里（默认 8098），与本程序互不依赖：
     装了就把界面嵌进「游戏」页，没装就返回引导信息。
     这里只报「通不通 + 该用哪个地址」，不做代理转发（RomM 有自己的账号体系）。 */
  if (m === 'GET' && p === '/api/games/status') {
    const port = Math.max(1, Math.min(65535, Number(process.env.ROMM_PORT) || 8098));
    const host = String(req.headers.host || '').split(':')[0] || '127.0.0.1';
    const scheme = (req.socket && req.socket.encrypted) ? 'https' : 'http';
    const alive = await tcpAlive('127.0.0.1', port, 1500);
    return json(res, 200, { ok: true, alive, port, url: `${scheme}://${host}:${port}` });
  }

  /* ---------------- 管理密码守卫（服务端强制，前端绕不过） ----------------
     与前端弹窗是两道独立的门：绕过网页直接 POST /api/roots 一样会被拦在这里。
     未设密码时 isUnlocked 恒 true（=不拦），保证不会出现「谁也进不去设置」的死局。 */
  if (m !== 'GET' && m !== 'HEAD'
      && ADMIN_LOCK_WRITE.some((re) => re.test(p))
      && !ADMIN_LOCK_FREE.some((re) => re.test(p))
      && !adminlock.isUnlocked(req)) {
    return json(res, 403, { error: '需要管理密码才能修改设置', lock: true });
  }

  /* ---------------- 儿童模式守卫（服务端强制，前端绕不过） ---------------- */
  if (kids.isActive()) {
    if (m !== 'GET') {
      // 儿童模式只放行「观看/播放/进度」类写操作；加目录/扫描/删除/设置等管理动作一律拒绝
      const KID_OK = [
        /^\/api\/progress$/,
        /^\/api\/music\/state$/, /^\/api\/music\/played$/, /^\/api\/music\/like$/,
        /^\/api\/music\/duration(\/\d+)?$/,
        /^\/api\/music\/playlists(\/\d+\/(add|remove))?$/,
        /^\/api\/books\/progress$/,
        /^\/api\/kids\//,
      ];
      if (!KID_OK.some((re) => re.test(p))) {
        return json(res, 403, { error: '儿童模式已锁定，退出需家长 PIN', kids: true });
      }
    }
    // 在线热歌 / 网盘 / 局域网浏览 / 下载中心：儿童模式整段关闭
    if (/^\/api\/music\/online\//.test(p) || p.startsWith('/api/webdav') || p.startsWith('/api/fs/') || p.startsWith('/api/dl')) {
      return json(res, 403, { error: '儿童模式下不可用', kids: true });
    }
  }

  /* ---------------- 游戏库 · 免登录凭据 + 游戏列表 ----------------
     cred 是写操作（保存游戏库账号密码），已过上面的管理密码守卫；
     list / platforms 只是读，给游戏页做海报墙用（封面自动转成同源 /romm 地址）。 */
  if (m === 'GET' && p === '/api/games/cred') {
    const { user, pass } = rommCreds();
    let login = null;
    if (user && pass) {
      const r = await rommLogin(true);
      login = { ok: !!r.ok, error: r.error || '' };
    }
    return json(res, 200, {
      ok: true,
      configured: !!user,
      user,
      passMasked: pass ? '••••••' : '',
      login,
    });
  }
  if (m === 'POST' && p === '/api/games/cred') {
    const raw = await readBody(req);
    let o = {};
    try { o = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch { o = {}; }
    if (typeof o.user === 'string') db.setSetting('rommUser', o.user.trim());
    if (typeof o.pass === 'string') db.setSetting('rommPass', o.pass.trim());
    const r = await rommLogin(true);
    const c = rommCreds();
    return json(res, 200, { ok: !!r.ok, error: r.error || '', configured: !!c.user, user: c.user });
  }
  if (m === 'GET' && p === '/api/games/list') {
    const q = url.searchParams;
    const plat = String(q.get('platform') || '').trim();
    const kw = String(q.get('q') || '').trim().toLowerCase();
    const offset = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(q.get('limit') || '60', 10) || 60));
    const r = await rommApi('/api/roms', {
      limit: 500, offset: 0, order_by: 'name', order_dir: 'asc', with_total: 'true',
    });
    if (!r.ok) return json(res, 200, { ok: false, error: r.error || '取不到游戏列表', needCred: !rommCreds().user });
    let j = null;
    try { j = await r.res.json(); } catch { return json(res, 200, { ok: false, error: '游戏库返回的内容读不懂' }); }
    const arr = Array.isArray(j) ? j : (j.items || j.roms || []);
    let items = arr.map((x) => ({
      id: x.id,
      name: x.name || x.fs_name || '',
      fs: x.fs_name || '',
      // ★ RomM 的字段名是 platform_fs_slug / platform_display_name（不是 platform_name）
      platform: x.platform_fs_slug || x.platform_slug || '',
      platformName: x.platform_display_name || x.platform_custom_name || x.platform_name || '',
      cover: rommCoverUrl(x),
      summary: String(x.summary || '').slice(0, 400),
    }));
    if (plat) items = items.filter((x) => x.platform === plat);
    if (kw) items = items.filter((x) => (x.name + ' ' + x.fs + ' ' + x.platformName).toLowerCase().indexOf(kw) >= 0);
    return json(res, 200, { ok: true, total: items.length, items: items.slice(offset, offset + limit) });
  }
  if (m === 'GET' && p === '/api/games/platforms') {
    const r = await rommApi('/api/platforms', null);
    if (!r.ok) return json(res, 200, { ok: false, error: r.error || '取不到平台列表', items: [] });
    let j = null;
    try { j = await r.res.json(); } catch { return json(res, 200, { ok: false, error: '游戏库返回的内容读不懂', items: [] }); }
    const arr = Array.isArray(j) ? j : (j.items || []);
    return json(res, 200, {
      ok: true,
      // 只留真的有游戏的平台：RomM 会返回全量支持平台（400 多个），全塞给前端就是一堆空标签
      items: arr.map((x) => ({
        slug: x.fs_slug || x.slug || '',
        name: x.display_name || x.name || '',
        roms: x.rom_count || 0,
      })).filter((x) => x.slug && x.roms > 0)
        .sort((a, b) => b.roms - a.roms || String(a.name).localeCompare(String(b.name))),
    });
  }

  /* ---------------- 游戏商店：目录 / 下载 / 上传 ----------------
   下载/上传是写 ROM 目录的管理动作，已经过上面的管理密码与儿童模式两道守卫。 */
  if (m === 'GET' && p === '/api/games/catalog') {
    return json(res, 200, gamesCatalog());
  }
  if (m === 'GET' && p === '/api/games/download/status') {
    return json(res, 200, { ok: true, jobs: Object.values(GAMES_DL) });
  }
  if (m === 'POST' && p === '/api/games/download') {
    const raw = await readBody(req);
    // readBody 返回的可能是对象（已解析）或字符串，两者都兼容
    let gid = '';
    try {
      const o = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
      gid = String(o.id || '');
    } catch { gid = ''; }
    const r = gameDownload(gid);
    return json(res, r.ok ? 200 : (r.code || 400), r.data ? r.data : { ok: false, error: r.error });
  }
  if (m === 'POST' && p === '/api/games/upload') {
    return gameUpload(req, res);
  }
  // 手动触发 RomM 全库扫描（文件监听器丢事件 / 「下载完不显示」时兜底）
  if (m === 'POST' && p === '/api/games/scan') {
    const r = await rommScan();
    return json(res, 200, r);
  }

  /* ---------------- 游戏库 · 元数据源密钥（可选，写 RomM 的 .env） ----------------
     只写这六个白名单变量，值做字符集与长度校验，避免被当成任意文件写接口。 */
  if (m === 'GET' && p === '/api/games/meta/keys') {
    return json(res, 200, rommMetaKeys());
  }
  if (m === 'POST' && p === '/api/games/meta/test') {
    const raw = await readBody(req);
    let obj = {};
    try { obj = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch { obj = {}; }
    return json(res, 200, await rommMetaTest(obj));
  }
  if (m === 'POST' && p === '/api/games/meta/keys') {
    const raw = await readBody(req);
    let obj = {};
    try { obj = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch { obj = {}; }
    const patch = {};
    for (const k of ROMM_ENV_KEYS) {
      if (!(k.key in obj)) continue;
      const v = String(obj[k.key] == null ? '' : obj[k.key]).trim();
      if (v && !/^[\w.@+\-/:]{1,128}$/.test(v)) return json(res, 400, { error: k.label + ' 含非法字符' });
      patch[k.key] = v;
    }
    if (!Object.keys(patch).length) return json(res, 400, { error: '没有要保存的内容' });
    // 配对项：只填一半等于白填，直接提示
    if (!!patch.SCREENSCRAPER_USER !== !!patch.SCREENSCRAPER_PASSWORD) {
      const cur = rommEnvRead();
      if (!(patch.SCREENSCRAPER_USER && String(cur.SCREENSCRAPER_PASSWORD || '')) && !(patch.SCREENSCRAPER_PASSWORD && String(cur.SCREENSCRAPER_USER || ''))) {
        return json(res, 400, { error: 'ScreenScraper 的用户名和密码要一起填' });
      }
    }
    if (!!patch.IGDB_CLIENT_ID !== !!patch.IGDB_CLIENT_SECRET) {
      const cur = rommEnvRead();
      if (!(patch.IGDB_CLIENT_ID && String(cur.IGDB_CLIENT_SECRET || '')) && !(patch.IGDB_CLIENT_SECRET && String(cur.IGDB_CLIENT_ID || ''))) {
        return json(res, 400, { error: 'IGDB 的 Client ID 和 Secret 要一起填' });
      }
    }
    const w = rommEnvWrite(patch);
    if (!w.ok) return json(res, 400, { error: w.error });
    const port = Math.max(1, Math.min(65535, Number(process.env.ROMM_PORT) || 8098));
    const alive = await tcpAlive('127.0.0.1', port, 1500);
    let restart = { ok: false, skipped: true };
    if (alive) {
      restart = await rommRestart();
      await new Promise((r) => setTimeout(r, 8000)); // 等容器起来再回读心跳
      restart.heartbeat = await rommHeartbeat(port);
    }
    console.log('[游戏库] 元数据源密钥已更新：' + Object.keys(patch).join(', '));
    return json(res, 200, { ok: true, saved: Object.keys(patch), restart, tip: '已写入 ' + ROMM_DIR + '/.env' + (alive ? ' 并重启了游戏库' : '（游戏库未运行，下次启动生效）') });
  }

  /* ---------------- PC 游戏（Steam 本机库） ----------------
     读 Steam 自己的明文清单出海报墙，不需要 Key、不需要联网；
     封面由本服务代理并落盘缓存（含 7 天负缓存），避免每次翻页都回源 Steam CDN。 */
  if (m === 'GET' && p === '/api/games/steam/config') {
    let suggested = [];
    try { suggested = await steam.detect(); } catch { suggested = []; }
    return json(res, 200, { ok: true, roots: steam.roots(), suggested, platform: process.platform });
  }
  if (m === 'POST' && p === '/api/games/steam/config') {
    const raw = await readBody(req);
    let obj = {};
    try { obj = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch { obj = {}; }
    const list = Array.isArray(obj.roots) ? obj.roots : [];
    const roots = steam.setRoots(list);
    const r = await steam.scan(true);
    console.log('[PC游戏] Steam 库位置已更新：' + roots.length + ' 个，扫到 ' + ((r.stats && r.stats.total) || 0) + ' 个游戏');
    return json(res, 200, { ok: true, roots, scanned: r.stats || null, error: r.error || '' });
  }
  if (m === 'GET' && p === '/api/games/steam/list') {
    const q = url.searchParams;
    const kw = String(q.get('q') || '').trim().toLowerCase();
    const force = String(q.get('refresh') || '') === '1';
    const r = await steam.scan(force);
    let items = r.items || [];
    if (kw) items = items.filter((g) => (g.name + ' ' + g.appid + ' ' + g.dir).toLowerCase().indexOf(kw) >= 0);
    return json(res, 200, {
      ok: !r.error, error: r.error || '', items,
      stats: r.stats || { total: 0 }, roots: steam.roots(),
    });
  }
  if (m === 'GET' && p === '/api/games/steam/cover') {
    const r = await steam.cover(url.searchParams.get('appid'), String(url.searchParams.get('w') || '') === 'wide');
    if (r.error) return json(res, 404, { error: r.error }); // 没有封面：前端 onerror 兜占位图
    const head = { 'Content-Type': r.type || 'image/jpeg', 'Cache-Control': 'public, max-age=2592000' };
    if (r.buf) {
      head['Content-Length'] = r.buf.length;
      res.writeHead(200, head);
      return res.end(r.buf);
    }
    if (r.file) {
      // 已落盘缓存：交给 static-handler 同等逻辑（这里直接流式读出，避免重复实现 Range 语义）
      try {
        const st = await fsp.stat(r.file);
        head['Content-Length'] = st.size;
        res.writeHead(200, head);
        return fs.createReadStream(r.file).pipe(res);
      } catch { /* 缓存被清了，下次重新回源 */ }
    }
    return json(res, 404, { error: 'no-cover' });
  }

  /* ---------------- 相册 ---------------- */
  if (p === '/api/photos' && m === 'GET') {
    if (kids.isActive()) return json(res, 200, { stats: { lib: 0 }, items: [] });
    return json(res, 200, { stats: photos.stats(), items: photos.listPhotos('timeline') });
  }
  if (p === '/api/photos/renders' && m === 'GET') {
    return json(res, 200, { items: photos.listPhotos('render') });
  }
  if (p === '/api/photos/upload' && m === 'POST') {
    try {
      const { files } = await photos.parseMultipart(req);
      if (!files.length) return json(res, 400, { error: '没有收到文件' });
      const results = [];
      for (const f of files) results.push(await photos.saveUpload(f, 'timeline'));
      return json(res, 200, { ok: true, results });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/photos/render' && m === 'POST') {
    try {
      const { fields, files } = await photos.parseMultipart(req);
      const f = files.find((x) => x.field === 'blob') || files[0];
      if (!f) return json(res, 400, { error: '没有收到渲染结果' });
      f.filterName = String(fields.filter || '');
      f.srcId = parseInt(fields.srcId || '0', 10) || 0;
      const r = await photos.saveUpload(f, 'render');
      return json(res, 200, r.skipped ? { ok: false, reason: r.reason } : { ok: true, id: r.id });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  /* ---- NAS 相册库（目录扫描） ---- */
  if (p === '/api/photos/roots' && m === 'GET') {
    return json(res, 200, { roots: photos.libListRoots(), suggest: photos.libSuggestRoots() });
  }
  if (p === '/api/photos/roots' && m === 'POST') {
    const body = await readBody(req);
    try {
      if (body.auto) { // 自动发现：把所有建议目录一次挂上
        let n = 0;
        for (const s of photos.libSuggestRoots()) { photos.libAddRoot(s); n += 1; }
        return json(res, 200, { ok: true, added: n });
      }
      const id = photos.libAddRoot(body.path, body.label);
      return json(res, 200, { ok: true, id });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  let prm = p.match(/^\/api\/photos\/roots\/(\d+)$/);
  if (prm && m === 'DELETE') { photos.libRemoveRoot(parseInt(prm[1], 10)); return json(res, 200, { ok: true }); }
  if (p === '/api/photos/scan' && m === 'POST') {
    const out = await photos.libScanAll({ onEvent: (msg) => console.log('[相册扫描] ' + msg) });
    return json(res, 200, out);
  }
  if (p === '/api/photos/lib' && m === 'GET') {
    const album = url.searchParams.get('album');
    if (album) return json(res, 200, { album, items: kids.filterPhotoRows(photos.libList(String(album))) });
    return json(res, 200, { stats: photos.libStats(), albums: kids.filterPhotoAlbums(photos.libAlbums()) });
  }
  prm = p.match(/^\/api\/photos\/libimg\/(\d+)$/);
  if (prm && m === 'GET') {
    const id = parseInt(prm[1], 10);
    const row = photos.libGet(id);
    if (!row || !kids.checkPhotoId(id)) return json(res, 404, { error: '照片不存在' });
    if (!fs.existsSync(row.path)) return json(res, 404, { error: '文件丢失' });
    // 灯箱大图：优先 2400px 显示版（异步生成，绝不阻塞事件循环）；RAW 走内嵌预览
    const full = await photos.libFullServe(id);
    if (!full || !fs.existsSync(full.file)) return json(res, 404, { error: '无可用预览' });
    res.writeHead(200, { 'Content-Type': full.mime || 'application/octet-stream', 'Content-Length': fs.statSync(full.file).size, 'Cache-Control': 'private, max-age=86400' });
    fs.createReadStream(full.file).pipe(res);
    return;
  }
  prm = p.match(/^\/api\/photos\/libthumb\/(\d+)$/);
  if (prm && m === 'GET') {
    const row = photos.libGet(parseInt(prm[1], 10));
    if (!row || !kids.checkPhotoId(row.id)) return json(res, 404, { error: '照片不存在' });
    const t = await photos.libThumbServe(row.id); // 异步按需生成（限并发），不阻塞其它请求
    if (!t || !fs.existsSync(t.file)) return json(res, 404, { error: '文件丢失' });
    const hi = String(t.file).replace(/\\/g, '/').split('/').pop()[0] === 'H'; // eh：960 高清长缓存；过渡 480 短缓存（升级后浏览器很快换新）
    res.writeHead(200, { 'Content-Type': t.mime || 'application/octet-stream', 'Cache-Control': 'private, max-age=' + (hi ? 604800 : 300) });
    fs.createReadStream(t.file).pipe(res);
    return;
  }
  if (p === '/api/photos/lib/warm-thumbs' && m === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    photos.libWarmThumbs({ onEvent: (s) => console.log('[缩略图预热] ' + s), limit: (body && body.limit) | 0 });
    return json(res, 200, { ok: true, status: photos.libWarmStatus() });
  }
  if (p === '/api/photos/lib/warm-status' && m === 'GET') {
    return json(res, 200, photos.libWarmStatus());
  }

  let pm = p.match(/^\/api\/photos\/img\/(\d+)$/);
  if (pm && m === 'GET') {
    const row = photos.getPhoto(parseInt(pm[1], 10));
    if (!row) return json(res, 404, { error: '照片不存在' });
    const abs = photos.absOf(row);
    if (!fs.existsSync(abs)) return json(res, 404, { error: '文件丢失' });
    res.writeHead(200, { 'Content-Type': row.mime || 'application/octet-stream', 'Content-Length': fs.statSync(abs).size, 'Cache-Control': 'private, max-age=3600' });
    fs.createReadStream(abs).pipe(res);
    return;
  }
  pm = p.match(/^\/api\/photos\/thumb\/(\d+)$/);
  if (pm && m === 'GET') {
    const id = parseInt(pm[1], 10);
    const row = photos.getPhoto(id);
    if (!row) return json(res, 404, { error: '照片不存在' });
    const t = photos.thumbAbs(id);
    const hasThumb = fs.existsSync(t);
    const use = hasThumb ? t : photos.absOf(row);
    res.writeHead(200, { 'Content-Type': hasThumb ? 'image/jpeg' : (row.mime || 'application/octet-stream'), 'Cache-Control': 'private, max-age=86400' });
    fs.createReadStream(use).pipe(res);
    return;
  }
  pm = p.match(/^\/api\/photos\/(\d+)$/);
  if (pm && m === 'DELETE') {
    photos.removePhoto(parseInt(pm[1], 10));
    return json(res, 200, { ok: true });
  }
  prm = p.match(/^\/api\/photos\/lib\/(\d+)$/);
  if (prm && m === 'DELETE') {
    const row = photos.libGet(parseInt(prm[1], 10));
    photos.libRemovePhoto(parseInt(prm[1], 10));
    const dd = (row && row.dir) ? photos.libCleanEmptyDirs([row.dir]) : [];
    return json(res, 200, { ok: true, dirsRemoved: dd });
  }
  if (p === '/api/photos/lib/delete-many' && m === 'POST') {
    const body = await readBody(req);
    const r = photos.libRemovePhotos((body && body.ids) || []);
    return json(res, 200, { ok: true, removed: r.removed, dirsRemoved: r.dirsRemoved });
  }
  /* ---- Flickr 风格照片页：全部相片/相簿/分类 ---- */
  if (p === '/api/photos/lib/all' && m === 'GET') {
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
    const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '500', 10)));
    const cat = String(url.searchParams.get('cat') || '');
    const dtype = String(url.searchParams.get('dtype') || '');
    const date = String(url.searchParams.get('date') || '');
    const fmt = String(url.searchParams.get('fmt') || '');
    const pr = kids.isActive() ? kids.status().config.photoRoots : null;
    return json(res, 200, photos.libListAll({ offset, limit, cat, dtype, date, fmt, rootIds: pr }));
  }
  if (p === '/api/photos/lib/cats' && m === 'GET') {
    // 分类张数（「其他」= 未分类）：筛选条 chip 上直接显示，打标签后立刻可见
    const pr = kids.isActive() ? kids.status().config.photoRoots : null;
    return json(res, 200, { cats: photos.libCatCounts(pr) });
  }
  /* ---- AI 增强包：本地模型照片自动分类（儿童模式下写操作被守卫拦截，按设计） ---- */
  if (p === '/api/ai/info' && m === 'GET') {
    // 词表配置被外部改过（直接编辑 json）时自动补齐，避免界面显示与生效词表不一致
    if (!ai.labelsInSync()) { try { await ai.syncLabels(); } catch { /* 缺文本模型等，降级不阻塞 info */ } }
    return json(res, 200, ai.info());
  }
  if (p === '/api/ai/download' && m === 'POST') {
    const body = await readBody(req);
    return json(res, 200, ai.downloadModel(String((body && body.model) || '')));
  }
  if (p === '/api/ai/stop' && m === 'POST') return json(res, 200, { stopped: ai.stopBatch() });
  // 重试失败项：把 ai_conf=-2（试过但失败）的行放回待处理队列
  if (p === '/api/ai/retry' && m === 'POST') return json(res, 200, { requeued: ai.resetFailed() });

  /* ---- AI 词表可配置：改词表只重算「文字」向量（秒级），图片向量原样复用 ---- */
  if (p === '/api/ai/labels' && m === 'GET') {
    const cfg = ai.labelCfgRead();
    const s = ai.info();
    return json(res, 200, {
      labels: (cfg && cfg.labels) || [],   // 当前配置（可编辑）
      custom: !!(cfg && cfg.custom),       // false = 用的是内置默认词表
      active: s.labels,                    // 实际生效的类名
      source: s.labelSource,
      textModel: s.textModel,
      reclassable: s.reclassable,
    });
  }
  if (p === '/api/ai/labels' && m === 'POST') {
    const body = await readBody(req);
    try {
      ai.labelCfgSet((body && body.labels) || []);
      await ai.syncLabels(); // 立即用文本编码器算新向量（秒级）
      return json(res, 200, { ok: true, labels: ai.info().labels, custom: true });
    } catch (e) { return json(res, 409, { error: e.message }); }
  }
  if (p === '/api/ai/labels/reset' && m === 'POST') {
    try { return json(res, 200, { ok: true, labels: ai.labelCfgReset() }); }
    catch (e) { return json(res, 409, { error: e.message }); }
  }
  // 按当前词表重刷全库分类：只比向量，不重跑模型（2.5 万张约 1 分钟）
  if (p === '/api/ai/reclass' && m === 'POST') {
    try { return json(res, 200, await ai.reclassifyAll()); }
    catch (e) { return json(res, 409, { error: e.message }); }
  }
  if (p === '/api/ai/reclass/stop' && m === 'POST') return json(res, 200, { stopped: ai.stopReclass() });
  /* ---- 自然语言找图：中文查询 → 英文提示词 → 文本向量 → 与全库图片向量比余弦 ---- */
  if (p === '/api/ai/search' && m === 'POST') {
    const body = await readBody(req);
    const q = String((body && body.q) || '').slice(0, 120);
    const limit = Math.max(1, Math.min(500, Number((body && body.limit) || 120)));
    const pr = kids.isActive() ? kids.status().config.photoRoots : null;
    try {
      return json(res, 200, await ai.searchByText(q, { limit, rootIds: pr }));
    } catch (e) {
      return json(res, e.code === 'NO_TEXT_MODEL' ? 409 : 500, { error: e.message, code: e.code || '' });
    }
  }
  if (p === '/api/ai/search/info' && m === 'GET') return json(res, 200, ai.searchInfo());
  /* ---- 相似 / 重复照片查重：复用 ai_vec 余弦，只出候选清单，绝不自动删 ---- */
  if (p === '/api/ai/similar/info' && m === 'GET') return json(res, 200, aisim.similarInfo());
  if (p === '/api/ai/similar' && m === 'POST') {
    const body = await readBody(req);
    // 三档预设：严格（只留几乎完全相同的副本）/ 标准 / 宽松（连拍也算）
    const PRESET = { strict: [0.995, 0.985], normal: [0.99, 0.96], loose: [0.985, 0.935] };
    let dupThresh = Number((body && body.dupThresh) || 0);
    let simThresh = Number((body && body.simThresh) || 0);
    const preset = String((body && body.preset) || '');
    if (PRESET[preset]) { [dupThresh, simThresh] = PRESET[preset]; }
    if (!(dupThresh > 0)) dupThresh = aisim.DUP_THRESH;
    if (!(simThresh > 0)) simThresh = aisim.SIM_THRESH;
    dupThresh = Math.min(1, Math.max(-1, dupThresh));
    simThresh = Math.min(1, Math.max(-1, simThresh));
    if (simThresh > dupThresh) simThresh = dupThresh;   // 相似阈值不可能严于重复阈值
    const maxGroup = Math.max(2, Math.min(200, Number((body && body.maxGroup) || 0) || 60));
    try {
      return json(res, 200, aisim.findSimilar({ dupThresh, simThresh, maxGroup }));
    } catch (e) { return json(res, 500, { error: e.message }); }
  }
  /* ---- 查重结果的安全删除：进回收站（可还原），绝不直接 unlink ---- */
  if (p === '/api/ai/similar/trash' && m === 'POST') {
    const body = await readBody(req);
    const ids = Array.isArray(body && body.ids) ? body.ids : [];
    if (!ids.length) return json(res, 400, { error: '缺少 ids' });
    if (ids.length > 500) return json(res, 400, { error: '一次最多处理 500 张' });
    const pr = kids.isActive() ? kids.status().config.photoRoots : null;
    // 儿童模式生效时只允许动白名单内的照片
    if (pr) {
      const inScope = [];
      for (const id of ids) {
        const row = photos.libGet(Number(id));
        if (row && pr.includes(row.root_id)) inScope.push(id);
      }
      if (inScope.length !== ids.length) return json(res, 403, { error: '儿童模式下只能处理白名单内的照片' });
    }
    try {
      return json(res, 200, aisim.trashPhotos(ids, { batch: (body && body.batch) || '', photosMod: photos }));
    } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (p === '/api/ai/similar/trash' && m === 'GET') return json(res, 200, aisim.trashList());
  if (p === '/api/ai/similar/restore' && m === 'POST') {
    const body = await readBody(req);
    return json(res, 200, aisim.trashRestore((body && body.batch) || ''));
  }
  if (p === '/api/ai/similar/purge' && m === 'POST') {
    const body = await readBody(req);
    return json(res, 200, aisim.trashPurge((body && body.batch) || ''));
  }
  if (p === '/api/ai/scan' && m === 'POST') {
    const body = await readBody(req);
    // 缩略图走自身 HTTP（libthumb 会按需用 ffmpeg 生成，RAW 也能出图），与批量任务解耦
    const thumb = async (id) => {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/photos/libthumb/${id}`);
        return r.ok ? await r.arrayBuffer() : null;
      } catch { return null; }
    };
    try { return json(res, 200, await ai.startBatch({ limit: Number((body && body.limit) || 0), thumb })); }
    catch (e) { return json(res, 409, { error: e.message }); }
  }
  /* ---- 人脸识别：批量提取 / 人物墙 / 人工归组 ---- */
  if (p === '/api/faces/info' && m === 'GET') return json(res, 200, faces.progress());
  if (p === '/api/faces/scan' && m === 'POST') {
    const body = await readBody(req);
    // 缩略图走自身 HTTP（与 /api/ai/scan 同款）：libthumb 按需 ffmpeg 生成，RAW 也能出图
    const thumb = async (id) => {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/photos/libthumb/${id}`);
        return r.ok ? await r.arrayBuffer() : null;
      } catch { return null; }
    };
    try { return json(res, 200, await faces.startBatch({ limit: Number((body && body.limit) || 0), thumb })); }
    catch (e) { return json(res, 409, { error: e.message }); }
  }
  if (p === '/api/faces/stop' && m === 'POST') return json(res, 200, { stopped: faces.stopBatch() });
  if (p === '/api/faces/retry' && m === 'POST') return json(res, 200, { requeued: faces.resetFailed() });
  // 下载缺失模型（lite 包 / EXE 安装未内置时；顺序下检测+识别两个文件）
  if (p === '/api/faces/download' && m === 'POST') return json(res, 200, await faces.downloadModel());
  if (p === '/api/faces/persons' && m === 'GET') {
    const pr = kids.isActive() ? kids.status().config.photoRoots : null;
    return json(res, 200, { persons: faces.listPersons(pr ? { rootIds: pr } : {}) });
  }
  if (p === '/api/faces/person/photos' && m === 'GET') {
    const pr = kids.isActive() ? kids.status().config.photoRoots : null;
    return json(res, 200, { items: faces.personPhotos(Number(q.get('id') || 0), { limit: Number(q.get('limit') || 200), rootIds: pr }) });
  }
  if (p === '/api/faces/photo/faces' && m === 'GET') return json(res, 200, { items: faces.photoFaces(Number(q.get('id') || 0)) });
  if (p === '/api/faces/unassigned' && m === 'GET') {
    const pr = kids.isActive() ? kids.status().config.photoRoots : null;
    return json(res, 200, { items: faces.unassignedFaces({ limit: Number(q.get('limit') || 100), rootIds: pr }) });
  }
  if (p === '/api/faces/person/rename' && m === 'POST') {
    const body = await readBody(req);
    try { return json(res, 200, faces.renamePerson(Number(body && body.id) || 0, String((body && body.name) || ''))); }
    catch (e) { return json(res, 409, { error: e.message }); }
  }
  if (p === '/api/faces/person/delete' && m === 'POST') {
    const body = await readBody(req);
    return json(res, 200, faces.deletePerson(Number(body && body.id) || 0));
  }
  if (p === '/api/faces/person/merge' && m === 'POST') {
    const body = await readBody(req);
    try { return json(res, 200, faces.mergePersons(Number(body && body.from) || 0, Number(body && body.into) || 0)); }
    catch (e) { return json(res, 409, { error: e.message }); }
  }
  if (p === '/api/faces/crop/assign' && m === 'POST') {
    const body = await readBody(req);
    try { return json(res, 200, faces.assignCrop(Number(body && body.id) || 0, Number(body && body.person) || 0)); }
    catch (e) { return json(res, 409, { error: e.message }); }
  }
  // 整库重扫（危险）：清空全部人脸数据从头再来，前端必须二次确认
  if (p === '/api/faces/reprocess' && m === 'POST') {
    const body = await readBody(req);
    if (String((body && body.confirm) || '') !== 'RESET') return json(res, 400, { error: '缺少 confirm=RESET' });
    try { return json(res, 200, faces.reprocessAll()); }
    catch (e) { return json(res, 409, { error: e.message }); }
  }
  /* ---- OTA 在线升级（免费，全版本可用）：检查 / 应用 / 回滚 ---- */
  if (p === '/api/ota/status' && m === 'GET') return json(res, 200, ota.progress());
  if (p === '/api/ota/check' && m === 'POST') {
    try { return json(res, 200, await ota.check()); }
    catch (e) { return json(res, 502, { error: '检查更新失败: ' + e.message }); }
  }
  if (p === '/api/ota/apply' && m === 'POST') {
    try { return json(res, 200, await ota.apply()); }
    catch (e) { return json(res, 409, { error: e.message }); }
  }
  // 回滚上一版（危险）：恢复 .ota-prev/ 备份并重启，前端必须二次确认
  if (p === '/api/ota/rollback' && m === 'POST') {
    const body = await readBody(req);
    if (String((body && body.confirm) || '') !== 'ROLLBACK') return json(res, 400, { error: '缺少 confirm=ROLLBACK' });
    try { return json(res, 200, await ota.rollback()); }
    catch (e) { return json(res, 409, { error: e.message }); }
  }
  /* ---- AI 助理：自然语言问库 → 工具检索；写操作只出提议，确认后才执行 ---- */
  if (p === '/api/assistant/tools' && m === 'GET') return json(res, 200, { tools: assistant.tools, engine: await assistant.detectEngine() });
  if (p === '/api/assistant/ask' && m === 'POST') {
    const body = await readBody(req);
    try { return json(res, 200, await assistant.ask(String((body && body.q) || ''), (body && body.history) || [])); }
    catch (e) { return json(res, 409, { error: e.message }); }
  }
  // 执行助理提议的写操作（前端确认卡点「执行」后调用）
  if (p === '/api/assistant/confirm' && m === 'POST') {
    const body = await readBody(req);
    try { return json(res, 200, await assistant.confirm(String((body && body.tool) || ''), (body && body.args) || {})); }
    catch (e) { return json(res, 409, { error: e.message }); }
  }
  if (p === '/api/photos/lib/dates' && m === 'GET') {
    const pr = kids.isActive() ? kids.status().config.photoRoots : null;
    return json(res, 200, { shot: photos.libDates('shot', pr), added: photos.libDates('added', pr) });
  }
  if (p === '/api/photos/lib/category' && m === 'POST') {
    const body = await readBody(req);
    return json(res, 200, { ok: true, changed: photos.libSetCategory((body && body.ids) || [], String((body && body.cat) || '')) });
  }
  if (p === '/api/photos/lib/enrich-exif' && m === 'POST') {
    photos.libEnrichExif({ onEvent: () => {} }).then((r) => console.log('[photos] exif done', JSON.stringify(r))).catch(() => {});
    return json(res, 200, { ok: true, started: true });
  }
  // 重新探测 RAW 行（修历史尺寸/补 EXIF）+ 后台补 RAW 缩略图，日志进 server 输出
  if (p === '/api/photos/lib/reprobe-raw' && m === 'POST') {
    photos.libReprobeRaw({ onEvent: (msg) => console.log('[RAW 重探] ' + msg) })
      .then((r) => { console.log('[photos] raw reprobe done', JSON.stringify(r)); return photos.libRawThumbs({ onEvent: (m2) => console.log('[RAW 缩略图] ' + m2) }); })
      .then((r) => console.log('[photos] raw thumbs done', JSON.stringify(r)))
      .catch(() => {});
    return json(res, 200, { ok: true, started: true });
  }
  if (p === '/api/photos/lib/raw-thumbs' && m === 'POST') {
    photos.libRawThumbs({ onEvent: (msg) => console.log('[RAW 缩略图] ' + msg) }).then((r) => console.log('[photos] raw thumbs done', JSON.stringify(r))).catch(() => {});
    return json(res, 200, { ok: true, started: true });
  }
  let iprm = p.match(/^\/api\/photos\/lib\/info\/(\d+)$/);
  if (iprm && m === 'GET') {
    const info = photos.libInfo(parseInt(iprm[1], 10));
    if (!info || !kids.checkPhotoId(parseInt(iprm[1], 10))) return json(res, 404, { error: '照片不存在' });
    return json(res, 200, info);
  }
  iprm = p.match(/^\/api\/photos\/lib\/(\d+)\/place$/);
  if (iprm && m === 'GET') {
    const pid2 = parseInt(iprm[1], 10);
    if (!kids.checkPhotoId(pid2)) return json(res, 200, { has: false });
    const r = await photos.libPlace(pid2);
    return json(res, 200, r || { has: false });
  }
  if (p === '/api/photos/lib/enrich' && m === 'POST') {
    photos.libEnrich({ onEvent: () => {} }).then((r) => console.log('[photos] enrich done', JSON.stringify(r))).catch(() => {});
    return json(res, 200, { ok: true, started: true });
  }
  if (p === '/api/photos/albums' && m === 'GET') return json(res, 200, { albums: photos.albList() });
  if (p === '/api/photos/albums' && m === 'POST') {
    const body = await readBody(req);
    try { const id = photos.albCreate(body.name); return json(res, 200, { ok: true, id }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  prm = p.match(/^\/api\/photos\/albums\/(\d+)$/);
  if (prm && m === 'GET') {
    const a = photos.albGet(parseInt(prm[1], 10));
    if (!a) return json(res, 404, { error: '相簿不存在' });
    return json(res, 200, { album: a, items: kids.filterPhotoRows(photos.albItems(a.id)) });
  }
  if (prm && m === 'DELETE') {
    photos.albDelete(parseInt(prm[1], 10));
    return json(res, 200, { ok: true });
  }
  prm = p.match(/^\/api\/photos\/albums\/(\d+)\/items$/);
  if (prm && m === 'POST') {
    const body = await readBody(req);
    return json(res, 200, { ok: true, added: photos.albAdd(parseInt(prm[1], 10), (body && body.ids) || []) });
  }
  if (prm && m === 'DELETE') {
    const body = await readBody(req);
    return json(res, 200, { ok: true, removed: photos.albRemoveItems(parseInt(prm[1], 10), (body && body.ids) || []) });
  }

  /* ---- 音乐中心 ---- */
  if (p === '/api/music/roots' && m === 'GET') return json(res, 200, { roots: music.listRoots() });
  if (p === '/api/music/roots' && m === 'POST') {
    const body = await readBody(req);
    try { const id = music.addRoot(body.path, body.label); return json(res, 200, { ok: true, id }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  let mm2 = p.match(/^\/api\/music\/roots\/(\d+)$/);
  if (mm2 && m === 'DELETE') { music.removeRoot(parseInt(mm2[1], 10)); return json(res, 200, { ok: true }); }
  if (p === '/api/music/scan' && m === 'POST') {
    const out = await music.scanAll({ onEvent: (msg) => console.log('[音乐扫描] ' + msg) });
    return json(res, 200, out);
  }
  // 侧边栏歌手/专辑改名：kind = artist | album
  if (p === '/api/music/rename' && m === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, ...music.renameGroup(b.kind, b.from, b.to) }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/music/tracks' && m === 'GET') return json(res, 200, { tracks: kids.filterMusicTracks(music.listTracks()) });
  if (p === '/api/music/albums' && m === 'GET') return json(res, 200, { albums: kids.filterMusicAlbums(music.listAlbums()) });
  /* 音乐缩略图悬停预览取数（专辑 / 歌手）：一次给全浮层要用的信息 + 试听曲目。
     单开这个轻接口，是为了不让鼠标划过缩略图时去拉全量 /api/music/tracks。 */
  if (p === '/api/like' && m === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const t = String((body || {}).target || '');
    if (!/^(m:\d+|s:.{1,180})$/.test(t)) return json(res, 400, { error: 'bad target' });
    const d = Number((body || {}).delta) === -1 ? -1 : 1;
    const nv = Math.max(0, likeCount(t) + d);
    try { db.run('INSERT OR REPLACE INTO likes(target, n) VALUES(?, ?)', [t, nv]); } catch (e) { return json(res, 500, { error: '点赞失败' }); }
    return json(res, 200, { ok: true, target: t, likes: nv, rating: boostedRating(t) });
  }
  if (p === '/api/like' && m === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const t = (u.searchParams.get('target') || '').trim();
    if (!t) return json(res, 400, { error: 'bad target' });
    return json(res, 200, { ok: true, target: t, likes: likeCount(t) });
  }
  if (p === '/api/music/hover' && m === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const kind = u.searchParams.get('kind') === 'ar' ? 'ar' : 'al';
    const name = (u.searchParams.get('name') || '').trim();
    if (!name) return json(res, 200, { ok: false });
    const all = kids.filterMusicTracks(music.listTracks());
    const list = kind === 'ar'
      ? all.filter((t) => ((((t.artist || '').trim()) || '未知歌手') === name))
      : all.filter((t) => ((t.album || '单曲') === name));
    if (!list.length) return json(res, 200, { ok: false });
    const first = list[0];
    return json(res, 200, {
      ok: true, kind, name,
      artist: first.artist || '',
      album: first.album || '',
      count: list.length,
      albums: new Set(list.map((t) => t.album || '单曲')).size,
      year: first.year || null,
      duration: list.reduce((acc, t) => acc + (t.duration || 0), 0),
      durKnown: list.filter((t) => t.duration > 0).length, // 有长度的曲目数：太少说明数据缺失，别显示总时长
      coverId: first.id,
      firstId: first.id,
      tracks: list.slice(0, 8).map((t) => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration })),
    });
  }
  mm2 = p.match(/^\/api\/music\/album\/(.+)$/);
  if (mm2 && m === 'GET') return json(res, 200, { tracks: kids.filterMusicTracks(music.albumTracks(decodeURIComponent(mm2[1]))) });
  if (p === '/api/music/state' && m === 'GET') {
    const st = music.getState();
    if (st && st.track && !kids.checkMusicId(st.track.id)) return json(res, 200, { track: null });
    return json(res, 200, st || { track: null });
  }
  if (p === '/api/music/state' && m === 'POST') {
    const body = await readBody(req);
    if (body && body.trackId) music.saveState(parseInt(body.trackId, 10), Number(body.position) || 0);
    return json(res, 200, { ok: true });
  }
  mm2 = p.match(/^\/api\/music\/duration\/(\d+)$/);
  if (mm2 && m === 'POST') {
    const d = Math.round(Number((await readBody(req)).duration) || 0);
    if (d > 0) db.run('UPDATE music_tracks SET duration = ? WHERE id = ?', [d, parseInt(mm2[1], 10)]);
    return json(res, 200, { ok: true });
  }
  mm2 = p.match(/^\/api\/music\/stream\/(\d+)$/);
  if (mm2 && m === 'GET') {
    const sid2 = parseInt(mm2[1], 10);
    if (!kids.checkMusicId(sid2)) return json(res, 404, { error: '音频文件不存在' });
    const abs = music.trackAbs(sid2);
    if (!abs || !fs.existsSync(abs)) return json(res, 404, { error: '音频文件不存在' });
    return streamFile(req, res, abs);
  }
  // ---- 在线热歌（网易云公开榜单 + 免费直链试听，移植自「流行歌曲在线听」）----
  if (p === '/api/music/online/chart' && m === 'GET') {
    const region = q.get('region') === 'eu' ? 'eu' : 'cn';
    const genre = q.get('genre') || 'pop';
    const force = q.get('force') === '1';
    try { return json(res, 200, await musiconline.fetchChart(region, genre, force)); }
    catch (e) { return json(res, 200, { ok: false, region, genre, songs: [], error: e.message }); }
  }
  if (p === '/api/music/online/src' && m === 'GET') {
    const name = (q.get('name') || '').trim();
    const artist = (q.get('artist') || '').trim();
    if (!name) return json(res, 400, { error: '缺少歌曲名' });
    const r = await musiconline.resolveSource(name, artist);
    if (!r.ok) return json(res, 200, { ok: false });
    const token = musiconline.registerToken(r.url, r.referer);
    return json(res, 200, { ok: true, src: '/api/music/online/stream/' + token, srcLabel: r.srcLabel, duration: r.duration || 0, name: r.name || name, artist: r.artist || artist });
  }
  mm2 = p.match(/^\/api\/music\/online\/stream\/([a-f0-9]+)$/);
  if (mm2 && m === 'GET') {
    const tk = musiconline.getToken(mm2[1]);
    if (!tk) return json(res, 404, { error: '链接已过期，请重新点播' });
    const fwd = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0' };
    if (tk.referer) fwd.Referer = tk.referer;
    if (req.headers.range) fwd.Range = req.headers.range;
    let up;
    try { up = await fetch(tk.url, { headers: fwd, redirect: 'follow' }); }
    catch (e) { return json(res, 502, { error: '上游取流失败：' + e.message }); }
    if (!up.ok && up.status !== 206) return json(res, 502, { error: '上游 HTTP ' + up.status });
    const h = { 'Content-Type': up.headers.get('content-type') || 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    for (const k of ['content-length', 'content-range']) { const v = up.headers.get(k); if (v) h[k] = v; }
    res.writeHead(up.status === 206 ? 206 : 200, h);
    return Readable.fromWeb(up.body).pipe(res);
  }
  // 专辑封面批量预热：POST 启动（非阻塞），GET 查进度
  if (p === '/api/music/covers/warm' && m === 'POST') {
    const st = music.warmStatus();
    if (!st.running) music.warmCovers().catch(() => {});
    return json(res, 200, { ok: true, ...music.warmStatus() });
  }
  if (p === '/api/music/covers/warm' && m === 'GET') {
    return json(res, 200, { ok: true, ...music.warmStatus() });
  }
  // 专辑所在文件夹（📂 打开文件夹用）：返回该专辑全部曲目所在目录（去重）
  mm2 = p.match(/^\/api\/music\/album-folder\/(.+)$/);
  if (mm2 && m === 'GET') {
    const dirs = [...new Set(db.all('SELECT DISTINCT dir FROM music_tracks WHERE album = ?', [decodeURIComponent(mm2[1])]).map((r) => r.dir).filter(Boolean))];
    return json(res, 200, { dirs });
  }
  mm2 = p.match(/^\/api\/music\/cover\/(\d+)$/);
  if (mm2 && m === 'GET') {
    const id = parseInt(mm2[1], 10);
    const row = db.get('SELECT cover_file, cover_dir, album, artist, title FROM music_tracks WHERE id = ?', [id]);
    // ?s=320 生成/命中缩略缓存：封面原图常达 1~2MB，列表页几十张直接拖死主线程
    const ms = parseInt(q.get('s') || '0', 10);
    const sendImg = async (fp) => {
      const file = ms > 0 ? ((await imgthumb.ensure(fp, ms)) || fp) : fp;
      const type = file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=' + (ms > 0 ? 604800 : 86400) });
      return fs.createReadStream(file).pipe(res);
    };
    if (row) {
      const cf = row.cover_file || row.cover_dir;
      if (cf && fs.existsSync(cf) && !music.isPlaceholderImg(cf)) return sendImg(cf); // es：跳过占位图
    }
    // eq：同专辑其他曲目的内嵌封面兜底——首曲没抽到图、别首抽到时，专辑墙不再落到字牌占位
    if (row && row.album) {
      const sib = db.get(`SELECT cover_file, cover_dir FROM music_tracks WHERE album = ? COLLATE NOCASE AND (cover_file != '' OR cover_dir != '') LIMIT 1`, [row.album]);
      const cf2 = sib && (sib.cover_file || sib.cover_dir);
      if (cf2 && fs.existsSync(cf2) && !music.isPlaceholderImg(cf2)) return sendImg(cf2); // es
    }
    // 无内嵌封面：先在线拉专辑封面（网易云，落盘缓存），再退歌手海报，最后才字母占位
    const alb = (row && row.album) || '';
    const art = (row && row.artist) || '';
    if (alb && alb !== '单曲') {
      const fp = await music.albumCoverFetch(alb, art).catch(() => null);
      if (fp && !music.isPlaceholderImg(fp)) return sendImg(fp); // es
    }
    // er：歌曲级兜底——合集单曲的专辑名是歌手拼接串，按「歌名 歌手」搜歌取其专辑图
    const ttl = (row && row.title) || '';
    if (ttl) {
      const fp2 = await music.songCoverFetch(ttl, art).catch(() => null);
      if (fp2 && !music.isPlaceholderImg(fp2)) return sendImg(fp2); // es
    }
    if (art) {
      let af = music.artistImgCached(art);
      if (!af) { try { af = await music.artistImgFetch(art); } catch { af = null; } }
      if (af && !music.isPlaceholderImg(af)) return sendImg(af); // es
      af = null;
    }
    // 占位海报：专辑名首字 + 品牌红/暗底（按专辑名取色，同专辑同色）；es：&t= 覆盖取字（歌手页回退显示歌手首字）
    const album = q.get('t') || alb || '乐';
    const ch = album.trim().charAt(0).toUpperCase() || '♪';
    let h = 0; for (const c of album) h = (h * 31 + c.codePointAt(0)) >>> 0;
    const bgs = ['#e50914', '#8b1e24', '#1f1f2e', '#2d1f3e', '#16323f'];
    const bg = bgs[h % bgs.length];
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">' +
      `<rect width="300" height="300" fill="${bg}"/>` +
      '<circle cx="150" cy="150" r="86" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="10"/>' +
      `<text x="150" y="188" font-size="110" font-family="'Microsoft YaHei',sans-serif" font-weight="700" fill="#fff" text-anchor="middle">${ch}</text>` +
      '</svg>';
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=600' }); // eq：字牌只缓存 10 分钟，预热补到真图后刷新即可见
    return res.end(svg);
  }
  if (p === '/api/music/played' && m === 'POST') {
    const b = await readBody(req);
    if (b && b.id) music.addPlay(parseInt(b.id, 10));
    return json(res, 200, { ok: true });
  }
  if (p === '/api/music/stats' && m === 'GET') return json(res, 200, music.getStats());
  if (p === '/api/music/top' && m === 'GET') return json(res, 200, { tracks: kids.filterMusicTracks(music.topTracks(10)) });
  if (p === '/api/music/likes' && m === 'GET') return json(res, 200, { tracks: kids.filterMusicTracks(music.likeTracks()) });
  if (p === '/api/music/like' && m === 'POST') {
    const b = await readBody(req);
    if (b && b.id) music.setLike(parseInt(b.id, 10), !!b.on);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/music/playlists' && m === 'GET') return json(res, 200, { playlists: music.listPlaylists() });
  if (p === '/api/music/playlists' && m === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, playlist: music.createPlaylist(b.name) }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  mm2 = p.match(/^\/api\/music\/playlists\/(\d+)$/);
  if (mm2 && m === 'DELETE') { music.deletePlaylist(parseInt(mm2[1], 10)); return json(res, 200, { ok: true }); }
  mm2 = p.match(/^\/api\/music\/playlists\/(\d+)\/add$/);
  if (mm2 && m === 'POST') {
    const b = await readBody(req);
    if (b && b.id) music.playlistAdd(parseInt(mm2[1], 10), parseInt(b.id, 10));
    return json(res, 200, { ok: true });
  }
  mm2 = p.match(/^\/api\/music\/playlists\/(\d+)\/remove$/);
  if (mm2 && m === 'POST') {
    const b = await readBody(req);
    if (b && b.id) music.playlistRemove(parseInt(mm2[1], 10), parseInt(b.id, 10));
    return json(res, 200, { ok: true });
  }
  mm2 = p.match(/^\/api\/music\/playlists\/(\d+)\/tracks$/);
  if (mm2 && m === 'GET') return json(res, 200, { tracks: kids.filterMusicTracks(music.playlistTracks(parseInt(mm2[1], 10))) });
  mm2 = p.match(/^\/api\/music\/artist-img\/(.+)$/);
  if (mm2 && m === 'GET') {
    const name = decodeURIComponent(mm2[1]).trim();
    let fp = (name && music.artistImgCached(name)) || null;
    if (fp && music.isPlaceholderImg(fp)) fp = null; // es：缓存里已是默认占位图按未命中处理
    if (!fp) {
      try { fp = await music.artistImgFetch(name); } catch (e) { fp = null; }
    }
    if (!fp) return json(res, 404, { error: '未找到歌手图片' });
    const is = parseInt(q.get('s') || '0', 10); // 歌手图常 1~2MB，列表头像必须走缩略
    if (is > 0) fp = (await imgthumb.ensure(fp, is)) || fp;
    const type = fp.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800' });
    return fs.createReadStream(fp).pipe(res);
  }
  mm2 = p.match(/^\/api\/music\/lyric\/(\d+)$/);
  if (mm2 && m === 'GET') {
    const lrc = await music.lyricFor(parseInt(mm2[1], 10));
    return json(res, 200, { lrc: lrc || null });
  }
  mm2 = p.match(/^\/api\/music\/albcover\/(.+)$/);
  if (mm2 && m === 'GET') {
    const album = decodeURIComponent(mm2[1]).trim();
    const artist = new URLSearchParams(req.url.split('?')[1] || '').get('artist') || '';
    let fp = null;
    try { fp = await music.albumCoverFetch(album, artist); } catch (e) { fp = null; }
    if (!fp) return json(res, 404, { error: '未找到专辑封面' });
    const as = parseInt(q.get('s') || '0', 10);
    if (as > 0) fp = (await imgthumb.ensure(fp, as)) || fp;
    const type = fp.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800' });
    return fs.createReadStream(fp).pipe(res);
  }

  /* ---- 书架（电子书） ---- */
  if (p === '/api/books' && m === 'GET') return json(res, 200, { roots: ebooks.listRoots(), books: kids.filterBooks(ebooks.listBooks()) });
  if (p === '/api/books/progress' && m === 'GET') return json(res, 200, { items: ebooks.allProgress() });
  if (p === '/api/books/progress' && m === 'POST') {
    const body = await readBody(req);
    if (!body || !body.bookId) return json(res, 400, { error: '缺少 bookId' });
    ebooks.saveProgress(parseInt(body.bookId, 10), parseInt(body.chapterIdx, 10) || 0, Number(body.pos) || 0);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/books/roots' && m === 'GET') return json(res, 200, { roots: ebooks.listRoots() });
  if (p === '/api/books/roots' && m === 'POST') {
    const body = await readBody(req);
    try { const id = ebooks.addRoot(body.path, body.label); return json(res, 200, { ok: true, id }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  let mm3 = p.match(/^\/api\/books\/roots\/(\d+)$/);
  if (mm3 && m === 'DELETE') { ebooks.removeRoot(parseInt(mm3[1], 10)); return json(res, 200, { ok: true }); }
  /* ---- 下载中心 ---- */
  if (p === '/api/dl/tasks' && m === 'GET') {
    return json(res, 200, { tasks: dl.listTasks(), dir: dl.defaultDir(), dirs: dl.suggestDirs(), conc: dl.getConcurrency() });
  }
  if (p === '/api/dl/add' && m === 'POST') {
    const body = await readBody(req);
    try { const id = dl.addTask(body); return json(res, 200, { ok: true, id }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  // 导入本地文件续传（迅雷式）：本地已有半截文件 + 直链，校验可续传后接上
  if (p === '/api/dl/import' && m === 'POST') {
    const body = await readBody(req);
    try { const id = await dl.importTask(body); return json(res, 200, { ok: true, id }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/dl/conc' && m === 'POST') {
    const body = await readBody(req);
    return json(res, 200, { ok: true, conc: dl.setConcurrency(body.n) });
  }
  if (p === '/api/dl/dir' && m === 'POST') {
    const body = await readBody(req);
    try {
      const d = path.resolve(String(body.dir || ''));
      if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw new Error('目录不存在: ' + d);
      db.setSetting('dl_dir', d);
      return json(res, 200, { ok: true, dir: d });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  let dmm = p.match(/^\/api\/dl\/(pause|resume|retry)\/(\d+)$/);
  if (dmm && m === 'POST') {
    const id = parseInt(dmm[2], 10);
    const op = dmm[1];
    const ok = op === 'pause' ? dl.pauseTask(id) : op === 'resume' ? dl.resumeTask(id) : dl.retryTask(id);
    return json(res, 200, { ok });
  }
  dmm = p.match(/^\/api\/dl\/(\d+)$/);
  if (dmm && m === 'DELETE') {
    const delFile = url.searchParams.get('file') === '1';
    return json(res, 200, { ok: dl.removeTask(parseInt(dmm[1], 10), delFile) });
  }
  /* ---- 下载中心 · BT/磁力（qBittorrent Web API v2）----
     任务增删与直链下载同级：不上管理锁；只有改连接配置上锁。 */
  if (p === '/api/qbit/tasks' && m === 'GET') {
    const c = qbit.cfg();
    let tasks = []; let transfer = { dl: 0, up: 0 }; let err = '';
    if (qbit.configured()) {
      try { tasks = await qbit.list(); transfer = await qbit.transfer(); }
      catch (e) { err = e.message; }
    }
    return json(res, 200, { configured: qbit.configured(), url: c.url, user: c.user, dir: c.dir, tasks, transfer, error: err });
  }
  // 改连接配置（含账号密码）→ 已纳入 ADMIN_LOCK_WRITE，需先解锁管理密码
  if (p === '/api/qbit/config' && m === 'POST') {
    const body = await readBody(req) || {};
    // 只传 url（改端口/地址迁移）时不覆盖已存的账号密码 —— 前端传空串会把它抹掉
    try { return json(res, 200, await qbit.test({ url: body.url, user: body.user, pass: body.pass, dir: body.dir })); }
    catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }
  /* 局域网找 qBittorrent：给「早就自己装好了」的客户准备的免打听入口。
     deep=0 只扫本机（秒回）；默认连同网段常见端口一起扫（约 3~6 秒）。
     全程只有 TCP 探活 + 一次 /api/v2/app/version 只读请求，不改对方任何东西。 */
  if (p === '/api/qbit/discover' && m === 'GET') {
    const deep = String(url.searchParams.get('deep') || '1') !== '0';
    try { return json(res, 200, Object.assign({ ok: true }, await qbit.discover({ deep }))); }
    catch (e) { return json(res, 200, { ok: false, error: String(e.message || e), items: [] }); }
  }
  /* 密码找回：容器重装后 4.6+/5.x 首启会在日志里打一次临时密码，客户不可能知道 */
  if (p === '/api/qbit/rescue' && m === 'POST') {
    try { return json(res, 200, await qbit.rescue()); }
    catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }
  /* 一键装回本机 NAS：首拉镜像 1~3 分钟，前端要给足超时 */
  if (p === '/api/qbit/install' && m === 'POST') {
    try { return json(res, 200, await qbit.install()); }
    catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }
  if (p === '/api/qbit/add' && m === 'POST') {
    const body = await readBody(req);
    try { return json(res, 200, await qbit.add((body && body.urls) || '', { dir: body && body.dir })); }
    catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }
  let qm = p.match(/^\/api\/qbit\/(pause|resume|recheck)\/([A-Za-z0-9]+)$/);
  if (qm && m === 'POST') {
    try { return json(res, 200, await qbit[qm[1]](qm[2])); }
    catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }
  qm = p.match(/^\/api\/qbit\/([A-Za-z0-9]+)$/);
  if (qm && m === 'DELETE') {
    const delFile = url.searchParams.get('file') === '1';
    try { return json(res, 200, await qbit.remove(qm[1], delFile)); }
    catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }
  if (p === '/api/books/scan' && m === 'POST') {
    const out = await ebooks.scanAll({ onEvent: (msg) => console.log('[书架扫描] ' + msg) });
    return json(res, 200, out);
  }
  mm3 = p.match(/^\/api\/books\/toc\/(\d+)$/);
  if (mm3 && m === 'GET') {
    if (!kids.checkBookId(parseInt(mm3[1], 10))) return json(res, 404, { error: '书籍不存在' });
    const t = ebooks.toc(parseInt(mm3[1], 10));
    if (!t) return json(res, 404, { error: '书籍不存在' });
    return json(res, 200, t);
  }
  mm3 = p.match(/^\/api\/books\/chapter\/(\d+)\/(\d+)$/);
  if (mm3 && m === 'GET') {
    if (!kids.checkBookId(parseInt(mm3[1], 10))) return json(res, 404, { error: '章节不存在' });
    const c = ebooks.chapterText(parseInt(mm3[1], 10), parseInt(mm3[2], 10));
    if (!c) return json(res, 404, { error: '章节不存在' });
    return json(res, 200, c);
  }
  mm3 = p.match(/^\/api\/books\/cover\/(\d+)$/);
  if (mm3 && m === 'GET') {
    const id = parseInt(mm3[1], 10);
    if (!kids.checkBookId(id)) { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'); }
    const cf = ebooks.coverAbs(id);
    if (cf && fs.existsSync(cf)) {
      // ?s=320 走缩略缓存（列表页原图直出会一次拉上 MB，切页面即卡）
      const bs = parseInt(q.get('s') || '0', 10);
      const bfile = bs > 0 ? ((await imgthumb.ensure(cf, bs)) || cf) : cf;
      const type = bfile.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=' + (bs > 0 ? 604800 : 86400) });
      return fs.createReadStream(bfile).pipe(res);
    }
    // 占位封面：书名首字 + 品牌色系
    const row = db.get('SELECT title FROM ebooks WHERE id = ?', [id]);
    const title = (row && row.title) || '书';
    const ch = title.trim().charAt(0).toUpperCase() || '书';
    let h = 0; for (const c of title) h = (h * 31 + c.codePointAt(0)) >>> 0;
    const bgs = ['#e50914', '#8b1e24', '#1f3a2e', '#16323f', '#2d1f3e', '#3a3a1f'];
    const bg = bgs[h % bgs.length];
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 420">' +
      `<rect width="300" height="420" fill="${bg}"/>` +
      '<rect x="18" y="18" width="264" height="384" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="2" rx="6"/>' +
      `<text x="150" y="245" font-size="130" font-family="'Microsoft YaHei',sans-serif" font-weight="700" fill="#fff" text-anchor="middle">${ch}</text>` +
      '</svg>';
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=86400' });
    return res.end(svg);
  }
  mm3 = p.match(/^\/api\/books\/file\/(\d+)$/);
  if (mm3 && m === 'GET') {
    const id = parseInt(mm3[1], 10);
    if (!kids.checkBookId(id)) return json(res, 404, { error: 'not found' });
    const f = ebooks.fileAbs(id);
    if (!f) return json(res, 404, { error: '文件不存在' });
    res.writeHead(200, { 'Content-Type': f.mime, 'Cache-Control': 'private, max-age=86400' });
    return fs.createReadStream(f.abs).pipe(res);
  }
  mm3 = p.match(/^\/api\/books\/page\/(\d+)\/(\d+)$/);
  if (mm3 && m === 'GET') {
    const id = parseInt(mm3[1], 10);
    if (!kids.checkBookId(id)) return json(res, 404, { error: 'not found' });
    const img = ebooks.pageImage(id, parseInt(mm3[2], 10) || 0);
    if (!img) return json(res, 404, { error: '页不存在' });
    res.writeHead(200, { 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=86400' });
    return res.end(img.data);
  }
  mm3 = p.match(/^\/api\/books\/(\d+)$/);
  if (mm3 && m === 'DELETE') {
    const id = parseInt(mm3[1], 10);
    db.run('DELETE FROM ebook_chapters WHERE book_id = ?', [id]);
    db.run('DELETE FROM book_progress WHERE book_id = ?', [id]);
    db.run('DELETE FROM ebooks WHERE id = ?', [id]);
    return json(res, 200, { ok: true });
  }

  /* ---- 儿童模式 ---- */

  /* ---- 儿童模式 ---- */
  /* ---- 管理密码（设置页门锁） ---- */
  const lockIp = String((req.socket && req.socket.remoteAddress) || '');
  /* 演示站：密码入口整体关闭。不能只靠前端隐藏 —— 访客直接 curl 就能设密码把别人挡在外面，
     所以这一层拦截才是关键（前端隐藏只是不给人添堵）。 */
  if (adminlock.DEMO) {
    if (p === '/api/admin/lock' && m === 'GET') return json(res, 200, Object.assign({ unlocked: true }, adminlock.status()));
    if (p === '/api/admin/unlock' && m === 'POST') return json(res, 200, { ok: true });
    if (p === '/api/admin/lock' && m === 'POST') return json(res, 200, { ok: true });
    if (p === '/api/admin/pass' && m === 'POST') return json(res, 403, { error: '演示站已关闭管理密码功能' });
  }
  if (p === '/api/admin/lock' && m === 'GET') {
    return json(res, 200, Object.assign({ unlocked: adminlock.isUnlocked(req) }, adminlock.status()));
  }
  if (p === '/api/admin/unlock' && m === 'POST') {
    const left = adminlock.coolLeft(lockIp);
    if (left) return json(res, 429, { error: '密码错误次数过多，请 ' + Math.ceil(left / 1000) + ' 秒后再试' });
    const b = await readBody(req);
    if (!adminlock.isSet()) {
      // 还没设过密码：这次请求等于「初始化授权」，先发票据，前端随后引导设置密码
      return json(res, 200, { ok: true, needSet: true }, adminlock.setCookieHeader(adminlock.issueToken()));
    }
    if (!adminlock.verify(b && b.pin)) {
      adminlock.markFail(lockIp);
      const nl = adminlock.coolLeft(lockIp);
      const t = nl ? '密码错误，请 ' + Math.ceil(nl / 1000) + ' 秒后再试'
        : '密码不正确' + (adminlock.failsLeft(lockIp) ? '，还可尝试 ' + adminlock.failsLeft(lockIp) + ' 次' : '');
      return json(res, 400, { error: t });
    }
    adminlock.markOk(lockIp);
    return json(res, 200, { ok: true }, adminlock.setCookieHeader(adminlock.issueToken()));
  }
  if (p === '/api/admin/lock' && m === 'POST') {
    // 重签 secret：清 cookie 只管当前浏览器，票据本身也要作废，否则旧 token 仍能改设置
    adminlock.bumpSecret();
    return json(res, 200, { ok: true }, adminlock.clearCookieHeader());
  }
  if (p === '/api/admin/pass' && m === 'POST') {
    const b = await readBody(req);
    try { adminlock.setPwd(b && b.pin, b && b.oldPin); }
    catch (e) { return json(res, 400, { error: e.message }); }
    // 换密码会重签 secret、旧票据全部作废 → 立刻补发一张，免得用户刚改完就被踢出去
    return json(res, 200, { ok: true }, adminlock.setCookieHeader(adminlock.issueToken()));
  }

  if (p === '/api/kids/status' && m === 'GET') return json(res, 200, kids.status());
  /* 设置页白名单树：列出一个目录的子目录（本地路径或网盘远程路径都能用） */
  if (p === '/api/kids/subdirs' && m === 'GET') {
    const target = String(q.get('path') || '').trim();
    if (!target) return json(res, 400, { error: '缺少 path' });
    const clean = target.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    const ancPrefix = (clean === '/' ? '' : clean) + '/';   // 用于判断「本路径是某网盘目录的上级」
    const webRoot = db.listRoots().find((r) => {
      if (r.type !== 'webdav' && r.type !== 'alist') return false;
      const rp = String(r.path || '').replace(/[\\/]+$/, '') || '/';
      // 命中网盘目录本身、或其下级、或它的上级（上级按网盘展开，避免列出本机系统目录）
      return clean === rp || clean.startsWith(rp === '/' ? '/' : rp + '/') || rp.startsWith(ancPrefix);
    });
    try {
      if (webRoot) {
        const entries = await webdav.listDir(clean === '/' ? '/' : clean);
        const base = clean === '/' ? '' : clean;
        return json(res, 200, {
          path: clean, webdav: true,
          dirs: entries.filter((e) => e.isDir)
            .map((e) => ({ name: e.name, path: base + '/' + e.name }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh')),
        });
      }
      const st = await fsp.stat(clean);
      if (!st.isDirectory()) return json(res, 400, { error: '不是目录: ' + clean });
      const entries = await fsp.readdir(clean, { withFileTypes: true });
      return json(res, 200, {
        path: clean,
        dirs: entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => ({ name: e.name, path: clean.replace(/[\\/]+$/, '') + '/' + e.name }))
          .sort((a, b) => a.name.localeCompare(b.name, 'zh')),
      });
    } catch (e) {
      return json(res, 200, { path: clean, dirs: [], error: e.message });
    }
  }
  if (p === '/api/kids/pin' && m === 'POST') {
    const b = await readBody(req);
    try { kids.setPin(b && b.pin, b && b.oldPin); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/kids/config' && m === 'POST') {
    const b = await readBody(req);
    let st;
    try { st = kids.setRoots(b || {}, b && b.pin); }
    catch (e) { return json(res, 400, { error: e.message }); }
    // 勾选的网盘目录若一条记录都没有（从未扫描），自动扫描一次，孩子才看得到内容
    let scanStarted = false;
    try {
      const types = new Map(db.listRoots().map((r) => [Number(r.id), String(r.type || '')]));
      const need = kids.selectedRootIds('videoRoots').some((id) => {
        const t = types.get(Number(id));
        if (t !== 'webdav' && t !== 'alist') return false;
        const row = db.get('SELECT COUNT(*) AS n FROM media_files WHERE root_id = ?', [Number(id)]);
        return !row || !row.n;
      });
      if (need) { const r = startScan({ chain: true }); scanStarted = !!(r && r.ok); }
    } catch { /* 扫描失败不影响白名单保存 */ }
    return json(res, 200, { ok: true, scanStarted, ...st });
  }
  if (p === '/api/kids/enter' && m === 'POST') {
    const b = await readBody(req);
    try { kids.enter(b && b.pin); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/kids/exit' && m === 'POST') {
    const b = await readBody(req);
    try { kids.exit(b && b.pin); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/kids/check' && m === 'POST') {
    const b = await readBody(req);
    return json(res, 200, { ok: kids.checkPin(b && b.pin) });
  }

  /* ---- 手机照片备份（设备配对 + 一键增量） ---- */
  if (p === '/api/backup/devices' && m === 'GET') return json(res, 200, { devices: photos.backupDevices() });
  if (p === '/api/backup/pair' && m === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, { ok: true, device: photos.backupPair(b && b.name) }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/backup/manifest' && m === 'GET') {
    try { return json(res, 200, photos.backupManifest(parseInt(q.get('id') || '0', 10))); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/backup/photos' && m === 'POST') {
    try {
      const { fields, files } = await photos.parseMultipart(req, 200 * 1024 * 1024);
      const r = await photos.backupSave(fields.deviceId, files);
      const ing = await photos.backupIngest(fields.deviceId);
      return json(res, 200, { ok: true, saved: r.saved, skipped: r.skipped, added: ing.added });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  /* 媒体库目录 */
  if (p === '/api/roots' && m === 'GET') return json(res, 200, db.listRoots());
  if (p === '/api/roots' && m === 'POST') {
    const body = await readBody(req);
    if (!body || !body.path) return json(res, 400, { error: '缺少 path' });
    // 归一化：去首尾空白与 Windows「复制文件地址」带的成对引号
    const raw = String(body.path).trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
    if (!raw) return json(res, 400, { error: '路径为空' });
    if (!fs.existsSync(raw)) return json(res, 400, { error: '目录不存在: ' + raw });
    if (!fs.statSync(raw).isDirectory()) return json(res, 400, { error: '不是文件夹: ' + raw });
    const id = db.addRoot(raw, body.label || '');
    return json(res, 200, { ok: true, id });
  }
  let mm = p.match(/^\/api\/roots\/(\d+)$/);
  if (mm && m === 'DELETE') {
    db.removeRoot(parseInt(mm[1], 10));
    return json(res, 200, { ok: true });
  }

  /* 重复文件清理（同名不同格式 / 内容完全相同；删除先进内部回收站） */
  const cleanupRoots = () => {
    const out = [];
    try { for (const r of db.listRoots()) out.push({ path: r.path, src: 'media' }); } catch { /* ignore */ }
    try { for (const r of music.listRoots()) out.push({ path: r.path, src: 'music' }); } catch { /* ignore */ }
    try { for (const r of photos.libListRoots()) out.push({ path: r.path, src: 'photos' }); } catch { /* ignore */ }
    try { for (const r of ebooks.listRoots()) out.push({ path: r.path, src: 'books' }); } catch { /* ignore */ }
    return out;
  };
  if (p === '/api/cleanup/scan' && m === 'POST') {
    // gm：僵尸锁兜底——扫描异常挂起超过 30 分钟视为已死，放行重扫，避免永久 429
    if (cleanupScanning && Date.now() - cleanupScanStart < 30 * 60 * 1000) {
      return json(res, 429, { error: '上一次重复扫描还在后台进行中，请等它完成后再试（大库约需几分钟）' });
    }
    const body = await readBody(req).catch(() => ({}));
    cleanupScanning = true;
    cleanupScanStart = Date.now();
    try {
      const out = await cleanup.scan({
        roots: cleanupRoots(),
        probeMod: probe,
        kinds: body && Array.isArray(body.kinds) ? body.kinds : null,
      });
      return json(res, 200, out);
    } catch (e) { return json(res, 500, { error: e.message }); }
    finally { cleanupScanning = false; }
  }
  if (p === '/api/cleanup/run' && m === 'POST') {
    const body = await readBody(req, 3e7).catch(() => ({}));
    if (!body || !Array.isArray(body.paths) || !body.paths.length) return json(res, 400, { error: '缺少 paths' });
    try {
      const out = await cleanup.run({ paths: body.paths });
      let pruned = null;
      // go+：只清理「本次真正删掉的文件」所在目录链，绝不按库根全量扫空目录
      //（旧版传 cleanupRoots() 会误删用户库里的隐藏/系统空目录，如 .@__thumb/transcode）
      if (!out.aborted && out.dirs && out.dirs.length) {
        try { pruned = cleanup.pruneEmptyDirs(out.dirs, cleanupRoots()); } catch { /* ignore */ }
      }
      try { startScan(); } catch { /* ignore */ } // 清完自动重扫归类（后台跑，不阻塞响应）
      return json(res, 200, Object.assign(out, { pruned }));
    } catch (e) { return json(res, 500, { error: e.message }); }
  }
  // gj+：清理进度查询 + 中止（大库清理要能看见进度、随时终止）
  if (p === '/api/cleanup/run/status' && m === 'GET') return json(res, 200, cleanup.runStatus());
  if (p === '/api/cleanup/run/abort' && m === 'POST') return json(res, 200, cleanup.abortRun());
  if (p === '/api/cleanup/trash' && m === 'GET') return json(res, 200, await cleanup.trashList());
  if (p === '/api/cleanup/trash/purge' && m === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    return json(res, 200, await cleanup.purgeTrash((body && body.batch) || null));
  }
  // 回收站还原：按批次清单把文件搬回原路径（items 为空 = 整批还原）
  if (p === '/api/cleanup/trash/restore' && m === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    if (!body || !body.batch) return json(res, 400, { error: '缺少 batch' });
    try {
      const out = await cleanup.restoreTrash({
        batch: String(body.batch),
        items: Array.isArray(body.items) ? body.items : null,
        overwrite: !!body.overwrite,
      });
      // 文件回来了 → 后台重扫，让它们重新出现在库里（不阻塞响应）
      if (out && out.restored > 0) { try { startScan(); } catch { /* ignore */ } }
      return json(res, 200, out);
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  /* AI 字幕（whisper.cpp 本地生成：批量给缺字幕影片转写；运行时缺失时自动降级提示） */
  if (p === '/api/asr/status' && m === 'GET') return json(res, 200, asr.status());
  if (p === '/api/asr/missing' && m === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') || '500', 10) || 500;
    return json(res, 200, await asr.listMissing({ limit }));
  }
  if (p === '/api/asr/run' && m === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const r = await asr.run(body || {});
    return json(res, r.ok ? 200 : (r.code || 400), r);
  }

  /* 转码体检（perfprobe）：GET 读档位/倍率（读缓存不发 CPU）；POST 强制重测（跑 10 秒 ffmpeg 基准） */
  if (p === '/api/perf/status' && m === 'GET') return json(res, 200, perf.status());
  if (p === '/api/perf/probe' && m === 'POST') return json(res, 200, await perf.probe({ force: true }));
  if (p === '/api/asr/run/status' && m === 'GET') return json(res, 200, asr.runStatus());
  if (p === '/api/asr/run/abort' && m === 'POST') return json(res, 200, asr.abortRun());

  /* 准实时字幕（live 会话：按播放位置 120s 分段转写，首段约 1 分钟出字）。
     路由挂在 /api/asr/ 前缀下自动进管理锁；段 VTT 只读 cache 目录不写影片目录。 */
  mm = p.match(/^\/api\/asr\/live\/(\d+)$/);
  if (mm && m === 'POST') {
    const row = db.getMedia(parseInt(mm[1], 10));
    if (!row) return json(res, 404, { ok: false, error: '媒体不存在' });
    const body = await readBody(req).catch(() => ({}));
    const r = await asr.liveStart(row, { position: body.position, lang: body.lang, model: body.model });
    return json(res, r.ok ? 200 : (r.code || 400), r);
  }
  mm = p.match(/^\/api\/asr\/live\/(\d+)\/status$/);
  if (mm && m === 'GET') {
    const r = asr.liveStatus();
    if (r.mediaId !== parseInt(mm[1], 10)) return json(res, 200, { running: false, segs: [], mediaId: parseInt(mm[1], 10) });
    return json(res, 200, r);
  }
  mm = p.match(/^\/api\/asr\/live\/(\d+)\/seg$/);
  if (mm && m === 'GET') {
    /* 段 VTT 是「绝对内容时间轴」（生成时已按段起点平移）。
       转码/remux 流重挂 ?start=N 后 video.currentTime 是相对值 → 浏览器要用相对轴匹配，
       故按 offset=N 再整体回移（与 embedded-sub 同一套 shift 逻辑）。 */
    const off = Math.max(0, parseFloat(url.searchParams.get('offset') || '0') || 0);
    const userShift = Math.max(-600, Math.min(600, parseFloat(url.searchParams.get('shift') || '0') || 0));
    const buf = asr.liveSegVtt(parseInt(mm[1], 10), url.searchParams.get('n'));
    if (!buf) return json(res, 404, { error: '段落未就绪' });
    const vtt = (off || userShift) ? shiftVttTime(buf.toString('utf8'), off, userShift) : buf.toString('utf8');
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(vtt);
  }
  mm = p.match(/^\/api\/asr\/live\/(\d+)\/stop$/);
  if (mm && m === 'POST') return json(res, 200, asr.liveStop());

  /* ---- 字幕台词搜索(P1):FTS5 全文 + 时间戳跳播;读操作不锁,重索引才锁 ---- */
  if (p === '/api/subsearch' && m === 'GET') {
    const kw = (url.searchParams.get('q') || '').trim();
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '24', 10) || 24, 100);
    const perMedia = Math.min(parseInt(url.searchParams.get('perMedia') || '2', 10) || 2, 5);
    if (!kw) return json(res, 200, { ok: true, q: kw, hits: [] });
    const r = await subsearch.search(kw, { limit, perMedia });
    // 儿童模式过滤:逐条核 media 可见性
    if (r.hits && r.hits.length && kids.isActive && kids.isActive()) {
      r.hits = r.hits.filter((h) => kids.checkMediaId(h.media_id));
    }
    return json(res, 200, r);
  }
  if (p === '/api/subsearch/status' && m === 'GET') return json(res, 200, subsearch.status());
  if (p === '/api/subsearch/reindex' && m === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const r = await subsearch.indexPending({ force: !!(body && body.force) });
    return json(res, 200, { ok: true, indexed: r.indexed, lines: r.lines });
  }

  /* 扫描 */
  if (p === '/api/scan' && m === 'POST') return json(res, 200, startScan());
  if (p === '/api/reclassify' && m === 'POST') {
    try {
      const body = await readBody(req).catch(() => ({}));
      const scope = body && typeof body.scope === 'string' ? body.scope : 'video'; // 缺省保持旧行为：仅影视
      const want = (k) => scope === 'all' || scope === k;
      const out = { ok: true, scope };
      if (want('video')) {
        const r = scanner.reclassifyAll();
        out.video = r; out.total = r.total; out.updated = r.updated; out.counts = r.counts; out.locked = r.locked;
      }
      if (want('music')) out.music = await music.reidentifyAll();
      if (want('photos')) out.photos = await photos.libReidentify();
      if (want('ebooks')) out.ebooks = await ebooks.reidentifyAll();
      onScanEvent({ phase: 'reclassify', message: `重新识别完成（${scope}）` });
      return json(res, 200, out);
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === '/api/scan/status' && m === 'GET') {
    return json(res, 200, {
      running: scanState.running,
      startedAt: scanState.startedAt,
      events: scanState.events.slice(-20),
      result: scanState.result,
    });
  }

  /* 设置（TMDB Key / 在线片单地址） */
  if (p === '/api/settings' && m === 'GET') {
    const key = db.getSetting('tmdbApiKey', null);
    return json(res, 200, {
      tmdbApiKeyMasked: key ? (key.length > 8 ? key.slice(0, 4) + '****' + key.slice(-4) : '****') : '',
      tmdbEnabled: tmdbMod.enabled(),
      uiMode: UI_MODE,
      tmdbApiBaseUrl: db.getSetting('tmdbApiBaseUrl', '') || '',
      liveTvCatalogUrl: db.getSetting('liveTvCatalogUrl', '') || '',
      osApiKeyMasked: (() => { const k = db.getSetting('opensubtitlesApiKey', null); return k ? (k.length > 8 ? k.slice(0, 4) + '****' + k.slice(-4) : '****') : ''; })(),
      osApiBaseUrl: db.getSetting('opensubtitlesApiBaseUrl', '') || '',
      ipWhitelistEnabled: String(db.getSetting('ipWhitelistEnabled', '0')) === '1',
      ipWhitelist: db.getSetting('ipWhitelist', '') || '',
      playMode: db.getSetting('playMode', 'auto') || 'auto',
      subGlobalShift: Number(db.getSetting('subGlobalShift', '0')) || 0,
      clientIp: String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, ''),
      featuresHidden: (() => { try { return JSON.parse(db.getSetting('featuresHidden', '[]') || '[]'); } catch (e) { return []; } })(),
    });
  }
  if (p === '/api/settings' && m === 'POST') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: '缺少请求体' });
    if (typeof body.tmdbApiKey === 'string') {
      const k = body.tmdbApiKey.trim();
      if (k) db.setSetting('tmdbApiKey', k);
    }
    if (typeof body.tmdbApiBaseUrl === 'string') {
      const u = body.tmdbApiBaseUrl.trim().replace(/\/+$/, '');
      if (u) db.setSetting('tmdbApiBaseUrl', u);
      else db.setSetting('tmdbApiBaseUrl', ''); // 允许清空恢复默认
    }
    if (typeof body.opensubtitlesApiKey === 'string') {
      const k = body.opensubtitlesApiKey.trim();
      if (k) db.setSetting('opensubtitlesApiKey', k);
    }
    if (typeof body.opensubtitlesApiBaseUrl === 'string') {
      const u = body.opensubtitlesApiBaseUrl.trim().replace(/\/+$/, '');
      db.setSetting('opensubtitlesApiBaseUrl', u); // 允许清空恢复官方默认
    }
    if (Array.isArray(body.featuresHidden)) {
      db.setSetting('featuresHidden', JSON.stringify(body.featuresHidden.filter((k) => typeof k === 'string')));
    }
    if (typeof body.playMode === 'string' && ['auto', 'direct'].includes(body.playMode)) {
      db.setSetting('playMode', body.playMode);
    }
    /* 全局字幕微调（秒，正=字幕延后）：应对个别片源字幕整体偏早/偏晚 */
    if (body.subGlobalShift !== undefined && body.subGlobalShift !== null && body.subGlobalShift !== '') {
      const n = Number(body.subGlobalShift);
      if (Number.isFinite(n)) db.setSetting('subGlobalShift', String(Math.max(-10, Math.min(10, n))));
    }    if (typeof body.ipWhitelistEnabled === 'boolean') {
      db.setSetting('ipWhitelistEnabled', body.ipWhitelistEnabled ? '1' : '0');
    }
    if (typeof body.ipWhitelist === 'string') {
      const entries = cidr.parseList(body.ipWhitelist);
      db.setSetting('ipWhitelist', entries.map((e) => e.raw).join('\n'));
      body.__ipWhitelistKept = entries.length;
    }
    if (typeof body.liveTvCatalogUrl === 'string') {
      const u = body.liveTvCatalogUrl.trim();
      if (u) {
        db.setSetting('liveTvCatalogUrl', u);
        // 换了直播片单地址立即生效
        try { await livetvMod.refreshCatalog({ force: true }); } catch (e) {
          return json(res, 200, { ok: true, liveTvWarning: String(e && e.message) });
        }
      }
    }
    /* 白名单刚改过：让 ipGuard 立刻重新读设置，不必等 5 秒 TTL */
    ipGuardCache.at = 0;
    return json(res, 200, { ok: true, ipWhitelistKept: body.__ipWhitelistKept });
  }

  /* artp39：播放偏好（免管理密码）。字段白名单，绝不放凭据类进来。 */
  if (p === '/api/settings/play-pref' && m === 'POST') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: '缺少请求体' });
    const applied = [];
    if (body.subGlobalShift !== undefined && body.subGlobalShift !== null && body.subGlobalShift !== '') {
      const n = Number(body.subGlobalShift);
      if (Number.isFinite(n)) {
        db.setSetting('subGlobalShift', String(Math.max(-10, Math.min(10, n))));
        applied.push('subGlobalShift');
      }
    }
    if (typeof body.playMode === 'string' && ['auto', 'direct'].includes(body.playMode)) {
      db.setSetting('playMode', body.playMode);
      applied.push('playMode');
    }
    if (Array.isArray(body.featuresHidden)) {
      db.setSetting('featuresHidden', JSON.stringify(body.featuresHidden.filter((k) => typeof k === 'string')));
      applied.push('featuresHidden');
    }
    return json(res, 200, { ok: true, applied });
  }

  /* TMDB 元数据刮削 */
  if (p === '/api/tmdb/genres' && m === 'POST') {
    return json(res, 200, await tmdbMod.backfillGenres({ onEvent: onScanEvent }));
  }
  if (p === '/api/tmdb/genres' && m === 'GET') {
    return json(res, 200, { enabled: tmdbMod.enabled(), ...tmdbMod.genreState });
  }
  if (p === '/api/tmdb/scrape' && m === 'POST') {
    return json(res, 200, await tmdbMod.scrapeAll({ onEvent: onScanEvent }));
  }
  /* 单条刮削：详情页打开时前端自动触发（未刮削条目补全标题/简介/评分/类型/海报/背景图） */
  if (p === '/api/tmdb/scrape-one' && m === 'POST') {
    let body = {};
    try { body = (await readBody(req)) || {}; } catch { body = {}; }
    try {
      const r = await tmdbMod.scrapeOne({
        mediaId: body.mediaId ? parseInt(body.mediaId, 10) : null,
        seriesKey: body.seriesKey || null,
      });
      if (r && r.ok) {
        const media = body.mediaId ? db.getMedia(parseInt(body.mediaId, 10)) : null;
        return json(res, 200, { ...r, media: media || undefined });
      }
      return json(res, 200, r);
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e && e.message) });
    }
  }
  /* 手动识别：搜候选 / 应用选定（自动刮削救不回的条目兜底） */
  if (p === '/api/tmdb/search' && m === 'GET') {
    const kw = (q.get('q') || '').trim();
    if (!kw) return json(res, 200, { ok: false, error: '缺少关键词' });
    try {
      return json(res, 200, await tmdbMod.searchCandidates({ query: kw, kind: q.get('kind') || 'movie' }));
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e && e.message) });
    }
  }
  if (p === '/api/tmdb/match' && m === 'POST') {
    let body = {};
    try { body = (await readBody(req)) || {}; } catch { body = {}; }
    try {
      return json(res, 200, await tmdbMod.applyMatch({
        mediaId: body.mediaId || null,
        seriesKey: body.seriesKey || null,
        tmdbId: body.tmdbId,
        kind: body.kind || 'movie',
      }));
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e && e.message) });
    }
  }
  /* 自定义海报：TMDB 无图/图不理想时，贴图片链接或上传本地图片直接设为海报。
     纯本地能力不走 TMDB（无需 Key）；剧集整剧生效，电影写该文件 */
  if (p === '/api/tmdb/custom-poster' && m === 'POST') {
    let body = {};
    try { body = (await readBody(req, 21e6)) || {}; } catch { body = {}; }
    try {
      return json(res, 200, await tmdbMod.setCustomPoster({
        mediaId: body.mediaId || null,
        seriesKey: body.seriesKey || null,
        url: body.url || null,
        dataUrl: body.dataUrl || null,
      }));
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e && e.message) });
    }
  }
  if (p === '/api/tmdb/credits-backfill' && m === 'POST') {
    tmdbMod.backfillCredits({ onEvent: (e) => onScanEvent(e) }).catch((e) => console.error('[credits-backfill]', e.message));
    return json(res, 200, { ok: true, started: true });
  }
  if (p === '/api/tmdb/repair' && m === 'POST') {
    return json(res, 200, await tmdbMod.repairPosters());
  }
  if (p === '/api/tmdb/cancel' && m === 'POST') {
    tmdbMod.scrapeCancel();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/tmdb/status' && m === 'GET') {
    return json(res, 200, {
      enabled: tmdbMod.enabled(),
      running: tmdbMod.scrapeState.running,
      done: tmdbMod.scrapeState.done,
      total: tmdbMod.scrapeState.total,
      updated: tmdbMod.scrapeState.updated,
      failed: tmdbMod.scrapeState.failed,
      lastError: tmdbMod.scrapeState.lastError,
      finishedAt: tmdbMod.scrapeState.finishedAt,
      stats: db.tmdbStats(),
    });
  }

  /* 首页聚合 */
  /* 缩略图定时轮换：4 小时一个窗口的确定性洗牌（同窗口刷新内容一致，跨窗口自动换血） */
  const ROTATE_MS = 4 * 60 * 60 * 1000;
  const rotShuffle = (arr, salt = 0) =>
    arr
      .map((x, i) => ({ x, k: Math.sin((Math.floor(Date.now() / ROTATE_MS) * 131 + salt) * 9301 + (i + 1) * 49297) * 233280 }))
      .sort((a, b) => a.k - b.k)
      .map((o) => o.x);
  const { dirs } = require('./lib/paths');
  /* Hero 候选补「精彩片段」预览 + 1600px 横图（已存在直接复用，缺的现场生成一次后落盘） */
  const PREVIEW_LEN = 12; // 每段预览播放秒数（Netflix 式，不宜过长）
  const previewStart = (dur) => (!dur || dur < 120 ? 0 : Math.min(Math.floor(dur * 0.25), 900)); // 跳过片头：正片 1/4 处，最长 15 分钟
  /* Hero 质量闸的判据：series_key 本身就是集号（s02e21v3 / S01 / SE10 这类从文件名误判出来的「假剧」） */
  const HERO_JUNK_KEY = /^(?:s|se|season|ep|e)\s*\d{1,3}(?:\s*e\s*\d{1,3})?(?:\s*v\d+)?$/i;
  async function enrichHero(pool) {
    /* 质量闸（两个入口共用）：假剧不进大屏橱窗 —— 首页顶栏出现「只有一集、剧名就是集号」的条目
       比没有更糟（线上实测有 s02e21v3 占了一席）。只从 Hero 池里剔除，库里的正片不受影响 */
    for (let i = pool.length - 1; i >= 0; i--) {
      const h = pool[i];
      if (!(h.kind === 'series' || h.series_key)) continue;
      const key = String(h.series_key || '').trim();
      if (HERO_JUNK_KEY.test(key)) { pool.splice(i, 1); continue; }
      const n = db.get(
        `SELECT COUNT(*) AS n FROM media_files WHERE series_key = ? AND kind='episode'`,
        [h.series_key]
      );
      if (!n || (n.n || 0) <= 1) pool.splice(i, 1); // 只有一集的「剧」：多为单文件误判
    }
    for (const h of pool) {
      if (h.kind === 'series' || (!h.kind && h.series_key)) {
        h.kind = 'series'; // listSeries 行没有 kind 字段（id 是剧集表主键，不是媒体 id）：统一打标，前端据此走剧集分支
        const eps = db.all(
          `SELECT id, path, duration FROM media_files WHERE series_key = ? AND kind='episode' ORDER BY season ASC, episode ASC LIMIT 12`,
          [h.series_key]
        );
        // 有本地盘的那一集先挑它（云盘集不给预览，见 localOnly）
        const ep = eps.find((x) => x.path && !webdav.isCloudPath(x.path)) || eps[0];
        if (!ep) continue;
        const epLocal = localOnly(ep.id);
        if (epLocal) h.preview = { id: epLocal.id, start: previewStart(epLocal.duration || ep.duration), len: PREVIEW_LEN };
        if (h.backdrop) continue;
        if (!ep.path || webdav.isCloudPath(ep.path)) continue;
        try { await probe.makeBackdrop(ep.path, { duration: ep.duration }); } catch {}
        const bdName = probe.backdropNameFor(ep.path);
        if (fs.existsSync(path.join(dirs.posters(), bdName))) h.backdrop = bdName;
      } else if (h.id) {
        if (localOnly(h.id)) h.preview = { id: h.id, start: previewStart(h.duration), len: PREVIEW_LEN };
        if (h.backdrop) continue;
        const row = db.get('SELECT path, duration FROM media_files WHERE id = ?', [h.id]);
        if (!row || !row.path || webdav.isCloudPath(row.path)) continue;
        try { await probe.makeBackdrop(row.path, { duration: row.duration }); } catch {}
        const bdName = probe.backdropNameFor(row.path);
        if (fs.existsSync(path.join(dirs.posters(), bdName))) h.backdrop = bdName;
      }
    }
    /* dw：大屏尽量选有图可用的条目 —— 海报/横图一张都没有 = 开天窗，宁可空席也不上；
       探针补横图的步骤在上面已跑过，这里用最终形态判定（横图补出来了也算有图） */
    for (let i = pool.length - 1; i >= 0; i--) {
      const h = pool[i];
      if (!(h.backdrop || h.official_poster || h.poster)) pool.splice(i, 1);
    }
    /* 大屏是门面：把「有预览片段」的排前面。云盘源拿不到可播的片段（见 localOnly），
       实测 6 席里只有 2 席能动，一进首页最上面经常是静态图 —— Netflix 那种「轮播即动」的观感就没了。
       只调池内顺序，五类来源一个不少。 */
    const withPv = pool.filter((x) => x.preview);
    const rest = pool.filter((x) => !x.preview);
    pool.splice(0, pool.length, ...withPv, ...rest);
  }

  if (p === '/api/home' && m === 'GET') {
    // 大池取样：curated 要从全库筛刮削成功的内容（刮上的老电影可能不在最新 N 条里），直接放开到全库量级
    const all = kids.filterMedia(db.queryMedia({ limit: 4000 }));
    // 剧集索引：剧集文件在首页一律折叠为「一部剧一张卡」（用剧集海报），避免同一封面重复刷屏
    const seriesByKey = new Map(
      db.listSeries({ limit: 500 }).map((s) => [s.series_key, s])
    );
    const homeKey = (m) => (m.series_key ? `series:${m.series_key}` : `${m.title}|${m.year || ''}`);
    // 目录名 → 兜底剧名（去尾部年份），用于旧库未重识别剧集的降级展示
    const dirTitle = (dir) => {
      const base = String(dir || '').split(/[\\/]/).filter(Boolean).pop() || '';
      return base.replace(/[(（【\[]*\s*(19|20)\d{2}\s*[)）\]】]*\s*$/, '').trim() || base;
    };
    // 折叠分组键：剧集三重兜底——series 行存在且剧名正常时按剧折叠；
    // series 行缺失或剧名本身就是纯集号（S01E12，旧库未重识别的典型形态）时，
    // 退到 series_key / 目录分组，避免同一部剧的每集各占一张卡刷屏（2026-09-19 桌面实测踩坑）
    const BARE_EP_RE = /^(s\d{1,2}e\d{1,4}|e\d{1,4}|\d{1,4})$/i;
    const seriesOk = (m) => {
      if (!m.series_key) return false;
      const s = seriesByKey.get(m.series_key);
      if (!s) return false;
      return !BARE_EP_RE.test(String(s.title || '').replace(/\s+/g, ''));
    };
    const groupKeyOf = (m) =>
      m.kind === 'episode' && !seriesOk(m) ? `epdir:${m.dir || m.series_key || m.title}` : homeKey(m);
    const seriesCard = (key) => {
      const s = seriesByKey.get(key);
      return {
        id: null, title: s.tmdb_title || s.title, year: s.year, kind: 'series', poster: s.official_poster || s.poster,
        series_key: s.series_key, episode_count: s.episode_count, season_count: s.season_count,
      };
    };
    // seen 按首页行顺序（电影→电视→每日精选→未观看→最受好评）填充：同一部影视全页只出现一次
    // 注意顺序：先保证「电影」「电视」专行有内容，再让「每日精选」从剩余里随机抽，
    // 否则小媒体库会被每日精选整批抽走，电影行直接空掉（2026-09-18 NAS 实测踩坑）
    const seen = new Set();
    // 显示名去重兜底：同一部剧可能被多个目录分成多个 series_key、各自刮到同一个 TMDB 条目，
    // groupKey 去重拦不住这种「异 key 同卡」，按规范化显示名再挡一层（2026-09-21 本机实测：西部世界×2）
    const seenTitle = new Set();
    const titleKey = (t) => String(t || '').trim().toLowerCase();
    const collapse = (rows) => {
      const out = [];
      for (const m of rows) {
        const k = groupKeyOf(m);
        if (seen.has(k)) continue;
        const isSeriesCard = m.kind === 'episode' && seriesOk(m);
        const disp = isSeriesCard
          ? (seriesByKey.get(m.series_key).tmdb_title || seriesByKey.get(m.series_key).title)
          : (m.tmdb_title || m.title);
        const tk = titleKey(disp);
        if (tk && seenTitle.has(tk)) continue;
        seen.add(k);
        if (tk) seenTitle.add(tk);
        if (isSeriesCard) {
          out.push(seriesCard(m.series_key));
        } else if (m.kind === 'episode' && m.dir) {
          const dn = dirTitle(m.dir);
          out.push(dn ? { ...m, title: dn } : m);
        } else {
          out.push(m);
        }
      }
      return out;
    };
    // 电影行优先上已刮到海报的影片，新入库未刮削的排后面补位：
    // 否则最新 12 条全是未刮削文件时，电影行整行都是占位图（2026-09-22 用户实测踩坑）
    const moviePool = all.filter((m) => m.kind === 'movie');
    // 动漫匹配：genre 含「动画/animation」（2026-09-27 涛哥需求：动漫从电影/剧集行独立成专栏）
    const isAnime = (x) => /动画|animation/i.test(String(x.genre || ''));
    const animeMovies = moviePool.filter(isAnime);
    const nonAnimeMovies = moviePool.filter((m) => !isAnime(m));
    const movies = collapse([
      ...rotShuffle(nonAnimeMovies.filter((m) => m.official_poster || m.poster), 1),
      ...nonAnimeMovies.filter((m) => !(m.official_poster || m.poster)),
    ].slice(0, 12));
    // 电视行本身一部剧一张卡：排除前面行已出现过的剧集，并把它们的 key 计入去重
    const kss = kids.seriesSet();
    const allSeries = db.listSeries({ limit: 500 });
    // 动漫·番剧专栏（页面位于剧集与未观看之间）：番剧在前 + 动画电影在后；
    // 剧集行/电影行同步挖走动漫，避免同页重复；collapse 占坑后榜单行不再重复出现
    const animeSeries = allSeries
      .filter(isAnime)
      .filter((s) => !kss || kss.has(s.series_key));
    const series = rotShuffle(
      allSeries
        .filter((s) => !isAnime(s))
        .filter((s) => !seen.has(`series:${s.series_key}`))
        .filter((s) => !kss || kss.has(s.series_key)),
      2
    ).slice(0, 12);
    for (const s of series) seen.add(`series:${s.series_key}`);
    const anime = collapse([...animeSeries, ...animeMovies]).slice(0, 30);
    // 精选类行（每日精选/未观看/最受好评）只上刮削成功的内容：
    // tmdb_title 为空的 = 裸文件名/目录名兜底（如「5 1 影视分享屋」「电视剧」），不上精选
    const curated = all.filter((m) => m.tmdb_title);
    // 影视精选：4 小时轮换的确定性洗牌，同窗口内容固定、跨窗口自动换血（只从电影/电视行没用掉的内容里抽）
    const dailyPicks = collapse(
      rotShuffle(curated, 8)
        .slice(0, 40) // 40 条样本经 collapse 折叠剧集后仍剩一二十条，保证精选行像电影行一样可横向滚动
    );
    // 未观看：没有任何有意义的播放进度（先剔除前面行已占坑的，防去重吞没整行）
    const unwatched = collapse(
      rotShuffle(
        curated
          .filter((m) => !seen.has(groupKeyOf(m)))
          .filter((m) => m.kind !== 'unknown' && !m.progress_finished && (m.progress_position || 0) <= 30),
        3
      ).slice(0, 18)
    );
    // 最受好评：本地无评分源，用「分辨率 × 码率」作为画质口碑代理分
    const qualityScore = (m) =>
      (m.width || 0) * (m.height || 0) * (m.duration ? 1 + m.size / m.duration / 2e6 : 1);
    const topRated = collapse(
      rotShuffle(
        [...curated]
          .filter((m) => !seen.has(groupKeyOf(m)))
          .filter((m) => m.kind !== 'unknown')
          .sort((a, b) => qualityScore(b) - qualityScore(a))
          .slice(0, 60), // 先取画质 Top 60，再轮换展示其中 18 部：榜单属性保留、首屏面孔常换
        4
      ).slice(0, 18)
    );
    // 继续观看：同剧集多集只保留最新一集（含未重识别的目录兜底分组）
    const cwSeen = new Set();
    const continueWatching = kids.filterMedia(db.continueWatching(500)).filter((m) => { // 500=实际全量：未看完的全部进「继续观看」栏
      const k = groupKeyOf(m);
      if (cwSeen.has(k)) return false;
      cwSeen.add(k);
      return true;
    });
    /* Hero 轮播池：定时从「新片 / 精选 / 未观看的 / 好评 / 经典」五类里轮播，一次只显示一部。
       五类交错取候选（round-robin，每个来源都有机会上大屏）；enrichHero 补「精彩片段」预览与
       横图并过质量闸（假剧剔除），最后取前 6 —— 候选取到 12 才有剔除后的替补；不含「继续观看」 */
    const classicHome = collapse(
      rotShuffle(
        curated
          .filter((m) => m.kind !== 'unknown' && m.year && Number(m.year) <= 2010 && (m.rating || 0) >= 7)
          .sort((a, b) => (b.rating || 0) - (a.rating || 0)),
        5
      ).slice(0, 12)
    );
    /* 为你推荐（P1 内容特征推荐，2026-09-27）：画像=已看 genre 分布（剧集 genre 从 series
       级联）+ 点赞加权；打分=画像重叠×2+年代亲和+评分微调；理由可解释。放在所有行之后计算，
       候选先过滤前面行已占坑的（seen/seenTitle），保证全页同片只出现一次；
       画像样本 <3 返回空数组（前端不渲染行），无理由硬推不如不推 */
    let recommended = [];
    {
      const likes = db.all('SELECT target, n FROM likes');
      const profile = recommend.buildProfile(all, seriesByKey, likes);
      if (profile.sample >= 3) {
        const cands = [];
        const movieSeen = new Set();
        for (const m of moviePool) {
          if (!(m.official_poster || m.poster)) continue; // 推荐卡必须有海报
          const k = recommend.workKeyOf(m, seriesByKey);
          if (movieSeen.has(k)) continue; // 同片多版本只收一个
          movieSeen.add(k);
          if (seen.has(groupKeyOf(m)) || seenTitle.has(titleKey(m.tmdb_title || m.title))) continue;
          cands.push({ key: k, card: m, genres: recommend.normGenres(m.genre), people: recommend.parseCredits(m.credits), year: m.year, rating: m.rating });
        }
        for (const s of allSeries) {
          if (kss && !kss.has(s.series_key)) continue;
          if (seen.has(`series:${s.series_key}`)) continue;
          const st = titleKey(s.tmdb_title || s.title);
          if (st && seenTitle.has(st)) continue;
          cands.push({
            key: `series:${s.series_key}`,
            card: { id: null, title: s.tmdb_title || s.title, year: s.year, kind: 'series', poster: s.official_poster || s.poster, series_key: s.series_key, episode_count: s.episode_count, season_count: s.season_count },
            genres: recommend.normGenres(s.genre), people: recommend.parseCredits(s.credits), year: s.year, rating: s.rating,
          });
        }
        recommended = recommend.scoreCandidates(profile, cands, { topN: 18 })
          .map((r) => ({ ...r.card, reason: r.reason }));
      }
    }
    // 新片组：电影与剧集「交替」混排 —— 直接拼电影行 + 剧集行的话，电影吃完才轮到剧集，
    // 剧集永远挤不进前 6 个大屏席位（线上实测过）
    const freshMix = [];
    {
      const mvs = movies.filter((m) => m.id);
      // 剧集候选先做「假剧」预筛（集号当剧名 / 库里只有 1 集）：否则假剧会占掉一个轮播席位，
      // 随后被 enrichHero 的质量闸剔除，那个席位就永久空了 —— 线上实测剧集席位被 s02e21v3 顶掉
      const srs = series.filter((s) => (s.episode_count || 0) > 1
        && !HERO_JUNK_KEY.test(String(s.series_key || '').trim()));
      const mx = Math.max(mvs.length, srs.length);
      for (let i = 0; i < mx; i++) {
        if (mvs[i]) freshMix.push(mvs[i]);
        if (srs[i]) freshMix.push(srs[i]);
      }
    }
    const heroGroups = [
      freshMix,     // 新片（电影 + 剧集交替，按入库时间）
      dailyPicks,   // 精选
      unwatched,    // 未观看的
      topRated,     // 好评
      classicHome,  // 经典（高分老片；库里没有时是空组，自动跳过）
    ];
    const heroPool = [];
    const heroSeenKey = new Set();
    for (let i = 0; heroPool.length < 12; i++) {
      let any = false;
      for (const g of heroGroups) {
        const c = g[i];
        if (!c) continue;
        any = true;
        const k = c.series_key ? 's:' + c.series_key : 'm:' + c.id;
        if (heroSeenKey.has(k)) continue;
        heroSeenKey.add(k);
        heroPool.push(c);
        if (heroPool.length >= 12) break;
      }
      if (!any) break; // 各组都取完了
    }
    await enrichHero(heroPool);
    const hero = heroPool.slice(0, 6);

    return json(res, 200, {
      continueWatching,
      hero, // Hero 轮播池（新片优先，含精彩片段预览；前端一次显示一部、定时轮流）
      recent: collapse(kids.filterMedia(db.recentlyAdded(12))),
      dailyPicks,
      unwatched,
      topRated,
      uiMode: UI_MODE,
      // 精简版：首页首屏展示电视直播；完整版：保持在线片源
      live: LIVETV_ONLY ? livetvMod.channels().slice(0, 12).map((c) => ({
        id: c.id, name: c.name, group: c.group, logo: c.logo,
      })) : [],
      movies,
      series,
      anime, // 动漫·番剧专栏（番剧+动画电影）
      recommended, // 为你推荐（画像空时为空数组，前端不渲染行）
      stats: kids.mediaStats(),
      // 首页多媒体区块：音乐专辑 / 相册 / 书架（有内容才展示，前端判空）
      musicAlbums: kids.filterMusicAlbums(rotShuffle(music.listAlbums(), 5)).slice(0, 12).map((a) => ({ album: a.album, cnt: a.cnt, year: a.year, firstId: a.firstId })),
      photoAlbums: kids.filterPhotoAlbums(rotShuffle(photos.libAlbums(), 6)).slice(0, 12).map((a) => ({ album: a.album, count: a.count, coverId: a.cover_id })),
      books: kids.filterBooks(rotShuffle(ebooks.listBooks(), 7)).slice(0, 12).map((b) => ({ id: b.id, title: b.title, author: b.author, format: b.format })),
    });
  }

  /* 影视中心首页分区（最新上架/最受好评/最佳推荐/您可能喜欢/分类行） */
  if (p === '/api/media/home' && m === 'GET') {
    // 儿童模式：白名单在数据源处生效（构造卡片前过滤），分类行/统计随之收敛
    const kidSec = {};
    if (kids.isActive()) {
      const sk = kids.seriesSet();
      kidSec.keepRow = kids.mediaKeep();
      kidSec.keepSeries = (key) => sk.has(key);
    }
    let data = db.mediaHomeSections(kidSec);
    await enrichHero(data.hero || []); // 顶部大屏轮播：补「精彩片段」预览 + 横图，并剔掉假剧后取前 6
    if (Array.isArray(data.hero)) data.hero = data.hero.slice(0, 6);
    if (kids.isActive()) {
      const ks = kids.mediaStats();
      data.stats = { ...data.stats, movies: data.stats.movies, series: data.stats.series, episodes: ks.episode };
    }
    // 类型覆盖率偏低（老库刚升级还没补 genre）→ 后台静默补抓，不阻塞本次请求；
    // 10 分钟冷却避免每次进页面都触发
    const cooling = Date.now() - (tmdbMod.genreState.finishedAt || 0) > 10 * 60 * 1000;
    if (data.stats.genreCoverage < 60 && tmdbMod.enabled() && !tmdbMod.genreState.running && cooling) {
      tmdbMod.backfillGenres({}).catch(() => {});
    }
    return json(res, 200, data);
  }

  /* 媒体查询 */
  if (p === '/api/media' && m === 'GET') {
    const kind = q.get('kind') || null;
    const sort = q.get('sort') || 'added';
    // 「全部影片」（kind 为空）：剧集折叠为一部剧一张卡，避免同一封面整页重复
    if (!kind) {
      const files = kids.filterMedia(db.queryMedia({ kind: null, q: q.get('q') || '', sort, limit: 5000, offset: 0 }));
      const kss = kids.seriesSet();
      const sq = q.get('q') || '';
      let seriesList = db.listSeries({ limit: 5000, q: sq }).filter((s) => !kss || kss.has(s.series_key));
      /* 只按剧名过滤会漏掉「某集的简介/演职员命中关键词」的情况：搜到集却拼不出剧卡，
         结果里平白少一部剧。所以命中的集所属剧也要补齐（剧名本身不含关键词也没关系）。 */
      if (sq) {
        const keys = new Set(files.map((f) => f.series_key).filter(Boolean));
        const have = new Set(seriesList.map((x) => x.series_key));
        for (const s2 of db.listSeries({ limit: 5000 })) {
          if (keys.has(s2.series_key) && !have.has(s2.series_key) && (!kss || kss.has(s2.series_key))) {
            seriesList.push(s2);
            have.add(s2.series_key);
          }
        }
      }
      return json(res, 200, dedupeMovies(collapseAllRows(files, seriesList, sort)));
    }
    const rows = kids.filterMedia(db.queryMedia({
      kind,
      q: q.get('q') || '',
      sort,
      limit: Math.min(parseInt(q.get('limit') || '200', 10), 500),
      offset: parseInt(q.get('offset') || '0', 10),
    }));
    // 电影菜单：同一 TMDB 条目的多副本去重，避免同海报重复刷屏
    return json(res, 200, kind === 'movie' ? dedupeMovies(rows) : rows);
  }
  mm = p.match(/^\/api\/media\/(\d+)$/);
  if (mm && m === 'GET') {
    const row = db.getMedia(parseInt(mm[1], 10));
    if (!row || !kids.checkMediaId(row.id)) return json(res, 404, { error: '不存在' });
    return json(res, 200, row);
  }

  /* 下一集：同剧集按季/集取下一集（连播与手动切集用）；电影/最后一集返回 ok:false */
  mm = p.match(/^\/api\/media\/(\d+)\/next$/);
  if (mm && m === 'GET') {
    const row = db.getMedia(parseInt(mm[1], 10));
    if (!row || row.kind !== 'episode' || !row.series_key || !kids.checkMediaId(row.id)) return json(res, 200, { ok: false });
    const next = db.get(
      `SELECT * FROM media_files WHERE series_key = ? AND kind='episode'
       AND (COALESCE(season,1) > ? OR (COALESCE(season,1) = ? AND COALESCE(episode,0) > ?))
       ORDER BY COALESCE(season,1) ASC, COALESCE(episode,0) ASC, id ASC LIMIT 1`,
      [row.series_key, row.season ?? 1, row.season ?? 1, row.episode ?? 0]
    );
    if (next && !kids.checkMediaId(next.id)) return json(res, 200, { ok: false, error: '没有下一集' });
    return next ? json(res, 200, { ok: true, media: next }) : json(res, 200, { ok: false, error: '没有下一集' });
  }

  /* 上一集：同剧集按季/集取上一集（对称 next）；电影/第一集返回 ok:false */
  mm = p.match(/^\/api\/media\/(\d+)\/prev$/);
  if (mm && m === 'GET') {
    const row = db.getMedia(parseInt(mm[1], 10));
    if (!row || row.kind !== 'episode' || !row.series_key || !kids.checkMediaId(row.id)) return json(res, 200, { ok: false });
    const prev = db.get(
      `SELECT * FROM media_files WHERE series_key = ? AND kind='episode'
       AND (COALESCE(season,1) < ? OR (COALESCE(season,1) = ? AND COALESCE(episode,0) < ?))
       ORDER BY COALESCE(season,1) DESC, COALESCE(episode,0) DESC, id DESC LIMIT 1`,
      [row.series_key, row.season ?? 1, row.season ?? 1, row.episode ?? 0]
    );
    if (prev && !kids.checkMediaId(prev.id)) return json(res, 200, { ok: false, error: '没有上一集' });
    return prev ? json(res, 200, { ok: true, media: prev }) : json(res, 200, { ok: false, error: '没有上一集' });
  }

  /* 卡片悬停预览（Netflix 式，全菜单影视缩略图共用）：精彩片段起播信息 + 简介 */
  mm = p.match(/^\/api\/media\/(\d+)\/enrich$/);
  if (mm && m === 'GET') {
    const id = parseInt(mm[1], 10);
    const row = db.get('SELECT id, kind, tmdb_id, genre, series_key FROM media_files WHERE id = ?', [id]); /* ★ series_key 必须查出：漏了它剧集永远走电影分支 */
    if (!row || !kids.checkMediaId(row.id)) return json(res, 404, { error: '不存在' });
    const isSeries = row.kind !== 'movie';
    const sr = isSeries && row.series_key ? db.get('SELECT tmdb_id, genre, official_poster, poster FROM series WHERE series_key = ?', [row.series_key]) : null;
    const [cast, creators] = isSeries
      ? await Promise.all([castOf(sr ? sr.tmdb_id : null, 'tv'), creatorsOf(sr ? sr.tmdb_id : null, 'tv')])
      : await Promise.all([castOf(row.tmdb_id, 'movie'), creatorsOf(row.tmdb_id, 'movie')]);
    return json(res, 200, { ok: true, cast, creators, similar: sr
      ? similarSeries(row.series_key, row.genre || sr.genre, sr.official_poster || sr.poster)
      : similarMovies(row.id, row.genre) });
  }
  mm = p.match(/^\/api\/series\/(.+)\/enrich$/);
  if (mm && m === 'GET') {
    const key = decodeURIComponent(mm[1]);
    const s = db.get('SELECT tmdb_id, genre, official_poster, poster FROM series WHERE series_key = ?', [key]);
    if (!s) return json(res, 404, { error: '不存在' });
    const [cast, creators] = await Promise.all([castOf(s.tmdb_id, 'tv'), creatorsOf(s.tmdb_id, 'tv')]);
    return json(res, 200, { ok: true, cast, creators, similar: similarSeries(key, s.genre, s.official_poster || s.poster) });
  }
  /* 剧集大窗集列表：文件记录 + TMDB 每集标题/简介（按季拉取，24h 内存缓存） */
  mm = p.match(/^\/api\/series\/(.+)\/episodes$/);
  if (mm && m === 'GET') {
    const key = decodeURIComponent(mm[1]);
    const kss = kids.seriesSet();
    if (kss && !kss.has(key)) return json(res, 404, { error: '不存在' });
    const detail = db.getSeriesDetail(key);
    if (!detail) return json(res, 404, { error: '不存在' });
    const s = detail.series;
    let tmdbEps = null;
    if (s.tmdb_id && tmdbMod.enabled()) {
      try {
        tmdbEps = new Map();
        for (const sn of [...new Set(detail.seasons.map((x) => x.season))]) {
          const ck = 'eps:' + s.tmdb_id + ':' + sn;
          let v = ENRICH_CACHE.get(ck);
          if (!(v && Date.now() - v.at < 86400000)) {
            try {
              const d = await tmdbMod.tmdbGet('/tv/' + s.tmdb_id + '/season/' + sn);
              v = (((d || {}).episodes) || []).map((x) => ({ n: x.episode_number, name: x.name, ov: x.overview }));
            } catch { v = []; }
            ENRICH_CACHE.set(ck, { at: Date.now(), v });
          }
          for (const x of v || []) tmdbEps.set(sn + ':' + x.n, x);
        }
      } catch { tmdbEps = null; }
    }
    const eps = [];
    /* 同集多版本聚合：库里同 S/E 多份文件（REMUX/4K/1080p 并存、文件名一英一中）会让剧集列表
       同集出现两行像「重复」。每集只保留一条最佳版本（4K>1080p>720p，REMUX 加分，大文件微加分）。 */
    const verRank = (e) => {
      const fn = (e.file_name || '') + ' ' + (e.dir || '');
      let r = 0;
      if (/2160p|4k[\s.|\-－]|ultra.?hd/i.test(fn)) r += 1000;
      else if (/1080[pi]/i.test(fn)) r += 500;
      else if (/720p/i.test(fn)) r += 200;
      if (/remux/i.test(fn)) r += 300;
      if (/web-?dl|webrip|hdtv/i.test(fn)) r -= 50;
      r += Math.min((e.size || 0) / (1024 * 1024 * 1024), 20);
      return r;
    };
    for (const { season, episodes } of detail.seasons) {
      const byEp = new Map();
      for (const e of episodes) {
        const k = e.episode ?? '?';
        if (!byEp.has(k)) byEp.set(k, []);
        byEp.get(k).push(e);
      }
      for (const list of byEp.values()) {
        const e = list.length > 1 ? list.slice().sort((a, b) => verRank(b) - verRank(a))[0] : list[0];
        const t = tmdbEps ? tmdbEps.get(season + ':' + e.episode) : null;
        eps.push({
          id: e.id, season, episode: e.episode,
          name: (t && t.name) || e.tmdb_title || e.title || e.file_name || '',
          overview: (t && t.ov) || e.overview || '',
          duration: e.duration,
          still: e.backdrop || e.poster || null,
          progress_finished: e.progress_finished, progress_position: e.progress_position,
          versions: list.length, // 同集文件数（前端可显示「N 版」）
        });
      }
    }
    return json(res, 200, { ok: true, title: s.tmdb_title || s.title, episodes: eps });
  }
  mm = p.match(/^\/api\/media\/(\d+)\/hover$/);
  if (mm && m === 'GET') {
    const row = db.get(
      'SELECT id, kind, title, tmdb_title, year, duration, rating, genre, overview, season, episode, series_key, poster, official_poster, backdrop, width, height, ext, path FROM media_files WHERE id = ?',
      [parseInt(mm[1], 10)]
    );
    if (!row || !kids.checkMediaId(row.id)) return json(res, 404, { error: '不存在' });
    if (!row.overview && row.series_key) {
      const sr = db.get('SELECT overview, genre, rating FROM series WHERE series_key = ?', [row.series_key]);
      if (sr) { row.overview = sr.overview; row.genre = row.genre || sr.genre; row.rating = row.rating ?? sr.rating; }
    }
    const prog = db.getProgress(row.id);
    return json(res, 200, {
      id: row.id, kind: row.kind, title: row.tmdb_title || row.title,
      year: row.year, duration: row.duration,
      rating: row.rating == null ? null : Math.min(10, Math.round((row.rating + likeBoost('m:' + row.id)) * 10) / 10),
      likes: likeCount('m:' + row.id), genre: row.genre,
      overview: row.overview, season: row.season, episode: row.episode, series_key: row.series_key,
      poster: row.official_poster || row.poster, backdrop: row.backdrop,
      quality: row.width >= 3800 ? '4K' : row.width >= 1900 ? '1080P' : (row.width ? '720P' : ''),
      progress: prog && prog.position > 30 && !prog.finished
        ? { position: prog.position, duration: prog.duration } : null,
      preview: localOnly(row.id) ? { id: row.id, start: previewStart(row.duration), len: PREVIEW_LEN } : null,
      cloud: !!row.path && webdav.isCloudPath(row.path), // ☁ 云端条目：前端浮层标注（不预播是云端属性，非故障）
    });
  }
  mm = p.match(/^\/api\/series\/(.+)\/hover$/);
  if (mm && m === 'GET') {
    const key = decodeURIComponent(mm[1]);
    const kss = kids.seriesSet();
    if (kss && !kss.has(key)) return json(res, 404, { error: '不存在' });
    const s = db.get(
      'SELECT series_key, tmdb_title, title, year, rating, genre, overview, episode_count, season_count, poster, official_poster, backdrop FROM series WHERE series_key = ?',
      [key]
    );
    if (!s) return json(res, 404, { error: '不存在' });
    const ep = db.get(
      `SELECT id, duration, season, episode, path FROM media_files WHERE series_key = ? AND kind='episode' ORDER BY season ASC, episode ASC LIMIT 1`,
      [key]
    );
    if (!ep || !kids.checkMediaId(ep.id)) return json(res, 404, { error: '暂无可播放的集' });
    /* 续播优先：最近在看且未看完的一集——预览也从这一集切精彩片段，接着看的人不必跳回第一集 */
    const rp = db.get(
      `SELECT m.id, m.duration AS epDur, m.season, m.episode, p.position, p.duration
       FROM watch_progress p JOIN media_files m ON m.id = p.media_id
       WHERE m.series_key = ? AND m.kind='episode' AND p.finished = 0 AND p.position > 30
       ORDER BY p.updated_at DESC LIMIT 1`,
      [key]
    );
    const cur = rp && kids.checkMediaId(rp.id) ? rp : null;
    // 预览那一集同样优先本地盘（云盘集不给预览，见 localOnly）
    const pvPick = localOnly(cur ? cur.id : ep.id) || localOnly(ep.id);
    const pvId = pvPick ? pvPick.id : null;
    const pvDur = pvPick && pvPick.duration ? pvPick.duration : (cur ? (cur.epDur || cur.duration) : ep.duration);
    return json(res, 200, {
      id: ep.id, kind: 'series', series_key: key,
      title: s.tmdb_title || s.title, year: s.year,
      rating: s.rating == null ? null : Math.min(10, Math.round((s.rating + likeBoost('s:' + key)) * 10) / 10),
      likes: likeCount('s:' + key), genre: s.genre,
      overview: s.overview, episode_count: s.episode_count, season_count: s.season_count,
      poster: s.official_poster || s.poster, backdrop: s.backdrop,
      firstEp: { season: ep.season, episode: ep.episode },
      resumeEp: cur ? { id: cur.id, season: cur.season, episode: cur.episode } : null,
      progress: cur ? { position: cur.position, duration: cur.duration || cur.epDur } : null,
      preview: pvId ? { id: pvId, start: previewStart(pvDur), len: PREVIEW_LEN } : null,
      cloud: !pvId && webdav.isCloudPath((ep && ep.path) || ''), // ☁ 云端剧集角标
    });
  }

  /* 剧集直达播放：续播优先（最近在看且未看完的一集），否则第一集 */
  mm = p.match(/^\/api\/series\/(.+)\/play$/);
  if (mm && m === 'GET') {
    const key = decodeURIComponent(mm[1]);
    const kss = kids.seriesSet();
    if (kss && !kss.has(key)) return json(res, 404, { error: '不存在' });
    const resume = db.get(
      `SELECT m.id FROM watch_progress p JOIN media_files m ON m.id = p.media_id
       WHERE m.series_key = ? AND p.finished = 0 AND p.position > 30
       ORDER BY p.updated_at DESC LIMIT 1`,
      [key]
    );
    let id = resume ? resume.id : null;
    const resumed = !!id;
    if (!id) {
      const first = db.get(
        `SELECT id FROM media_files WHERE series_key = ? AND kind='episode' ORDER BY season ASC, episode ASC LIMIT 1`,
        [key]
      );
      id = first ? first.id : null;
    }
    if (!id || !kids.checkMediaId(id)) return json(res, 200, { ok: false });
    return json(res, 200, { ok: true, id, resumed });
  }

  /* 剧集 */
  if (p === '/api/series' && m === 'GET') {
    const kss = kids.seriesSet();
    return json(res, 200, db.listSeries({ q: q.get('q') || '' }).filter((s) => !kss || kss.has(s.series_key)));
  }
  mm = p.match(/^\/api\/series\/(.+)$/);
  if (mm && m === 'GET') {
    const kss = kids.seriesSet();
    if (kss && !kss.has(decodeURIComponent(mm[1]))) return json(res, 404, { error: '不存在' });
    const detail = db.getSeriesDetail(decodeURIComponent(mm[1]));
    return detail ? json(res, 200, detail) : json(res, 404, { error: '不存在' });
  }

  /* 播放进度 */
  if (p === '/api/progress' && m === 'POST') {
    const body = await readBody(req);
    if (!body || !body.mediaId) return json(res, 400, { error: '缺少 mediaId' });
    const r = db.saveProgress(
      parseInt(body.mediaId, 10),
      Number(body.position) || 0,
      Number(body.duration) || null
    );
    return json(res, 200, { ok: true, ...r });
  }
  mm = p.match(/^\/api\/progress\/(\d+)$/);
  if (mm && m === 'GET') return json(res, 200, db.getProgress(parseInt(mm[1], 10)) || null);
  if (mm && m === 'DELETE') {
    db.clearProgress(parseInt(mm[1], 10));
    return json(res, 200, { ok: true });
  }

  /* 在线观看（免费授权片源） */
  if (p === '/api/online/list' && m === 'GET') return json(res, 200, await onlineMod.list());
  if (p === '/api/online/refresh' && m === 'POST') {
    try {
      const updated = await onlineMod.refreshCatalog({ force: true });
      return json(res, 200, { ok: true, updated });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  mm = p.match(/^\/api\/online\/play\/(.+)$/);
  if (mm && m === 'GET') {
    return json(res, 200, await onlineMod.preparePlay(decodeURIComponent(mm[1])));
  }
  mm = p.match(/^\/api\/online\/stream\/(.+)$/);
  if (mm && m === 'GET') {
    const it = onlineMod.catalog().find((x) => x.id === decodeURIComponent(mm[1]));
    if (!it) return json(res, 404, { error: '片源不存在' });
    res.writeHead(302, { Location: it.stream });
    return res.end();
  }
  mm = p.match(/^\/api\/online\/subtitle\/(.+)$/);
  if (mm && m === 'GET') {
    const prep = await onlineMod.preparePlay(decodeURIComponent(mm[1]));
    if (!prep.ok || !prep.subFile || !fs.existsSync(prep.subFile)) {
      return json(res, 404, { error: '暂无可用字幕' });
    }
    // SRT → WebVTT（浏览器 <track> 只认 VTT）
    const srt = fs.readFileSync(prep.subFile, 'utf8').replace(/^\uFEFF/, '');
    const vtt = 'WEBVTT\n\n' + srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(vtt);
  }

  /* ---------------- 电视直播（JSON 频道片单，机制同在线片单） ---------------- */
  if (p === '/api/livetv/list' && m === 'GET') return json(res, 200, await livetvMod.list());
  if (p === '/api/livetv/refresh' && m === 'POST') {
    try {
      const updated = await livetvMod.refreshCatalog({ force: true });
      return json(res, 200, { ok: true, updated });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === '/api/livetv/admin' && m === 'GET') return json(res, 200, livetvMod.adminOverview());
  if (p === '/api/livetv/admin' && m === 'POST') {
    try {
      const b = await readBody(req);
      const obj = (typeof b === 'string') ? JSON.parse(b || '{}') : (b || {});
      const id = livetvMod.addSource(obj);
      // 立刻拉一次：订阅型源（m3u/JSON 片单）当场展开成频道，用户点保存就能看到
      const synced = await livetvMod.syncSources({ force: true, ids: [id] }).catch(() => ({}));
      const info = synced[id] || {};
      return json(res, 200, { ok: true, id, channels: info.count || 1, kind: info.kind || 'stream', error: info.error || '' });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/livetv/admin/import' && m === 'POST') {
    try {
      const b = await readBody(req);
      const obj = (typeof b === 'string') ? JSON.parse(b || '{}') : (b || {});
      const imp = livetvMod.importSources(String(obj.content || ''), obj.mode === 'replace' ? 'replace' : 'merge');
      await livetvMod.syncSources({ force: true }).catch(() => ({}));
      return json(res, 200, { ok: true, ...imp });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/livetv/admin/export' && m === 'GET') {
    const fmt = q.get('fmt') === 'json' ? 'json' : 'm3u';
    const text = livetvMod.exportSources(fmt);
    res.writeHead(200, {
      'Content-Type': fmt === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="livetv-sources.' + fmt + '"',
    });
    return res.end(text);
  }
  if (p === '/api/livetv/admin/speedtest' && m === 'POST') {
    try {
      const b = await readBody(req);
      const obj = (typeof b === 'string') ? JSON.parse(b || '{}') : (b || {});
      const urls = Array.isArray(obj.urls) ? obj.urls.slice(0, 200) : [];
      const out = {};
      const BATCH = 6;
      for (let i = 0; i < urls.length; i += BATCH) {
        await Promise.all(urls.slice(i, i + BATCH).map(async (u) => { out[u] = await livetvMod.speedtestUrl(u); }));
      }
      return json(res, 200, { ok: true, results: out });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/livetv/admin/apply' && m === 'POST') {
    try {
      const r = await livetvMod.applyCustom();
      return json(res, 200, { ok: true, channels: r.channels, detail: r.detail });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  /* 手动刷新：重新拉取所有启用源的订阅内容 */
  if (p === '/api/livetv/admin/sync' && m === 'POST') {
    try {
      const b = await readBody(req);
      const obj = (typeof b === 'string') ? JSON.parse(b || '{}') : (b || {});
      const detail = await livetvMod.syncSources({ force: true, ids: Array.isArray(obj.ids) ? obj.ids : null });
      const total = Object.values(detail).reduce((n, x) => n + (x.count || 0), 0);
      return json(res, 200, { ok: true, detail, channels: total });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  /* 「只用我的源」开关：on=频道表只显示自己添加的源；off=叠加在原有频道上 */
  if (p === '/api/livetv/admin/mode' && m === 'POST') {
    try {
      const b = await readBody(req);
      const obj = (typeof b === 'string') ? JSON.parse(b || '{}') : (b || {});
      return json(res, 200, { ok: true, customOnly: livetvMod.setCustomOnly(!!obj.customOnly), total: livetvMod.channels().length });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/livetv/admin/ads' && m === 'POST') {
    try {
      const b = await readBody(req);
      const obj = (typeof b === 'string') ? JSON.parse(b || '{}') : (b || {});
      if (typeof obj.keywords === 'string') db.setSetting('livetvAdKeywords', obj.keywords.trim());
      return json(res, 200, { ok: true, ...livetvMod.filterAdsSources() });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  mm = p.match(/^\/api\/livetv\/admin\/([^/]+)$/);
  if (mm && m === 'PUT') {
    try {
      const b = await readBody(req);
      const obj = (typeof b === 'string') ? JSON.parse(b || '{}') : (b || {});
      const src = livetvMod.updateSource(decodeURIComponent(mm[1]), obj);
      await livetvMod.syncSources({ force: true, ids: [src.id] }).catch(() => ({}));
      return json(res, 200, { ok: true, source: src });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (mm && m === 'DELETE') {
    try { return json(res, 200, { ok: true, removed: livetvMod.removeSource(decodeURIComponent(mm[1])) }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  mm = p.match(/^\/api\/livetv\/play\/(.+)$/);
  if (mm && m === 'GET') {
    return json(res, 200, livetvMod.prepare(decodeURIComponent(mm[1])));
  }
  mm = p.match(/^\/api\/livetv\/stream\/(.+)$/);
  if (mm && m === 'GET') {
    const ch = livetvMod.channels().find((x) => x.id === decodeURIComponent(mm[1]));
    if (!ch) return json(res, 404, { error: '频道不存在' });
    // 一律同源代理，不再 302 把源站地址甩给浏览器：
    // ① https 域名下播 http 源会被浏览器当混合内容拦掉；
    // ② 大部分直播地址没有 .m3u8 后缀（靠 302 跳到真正的 HLS 列表），直连必然黑屏。
    // 代理里会嗅探真实内容再决定「重写播放列表」还是「原样转发字节流」。
    return proxyHls(res, ch.id, ch.url, 0);
  }
  mm = p.match(/^\/api\/livetv\/seg\/([^/]+)\/([A-Za-z0-9_-]+)$/);
  if (mm && m === 'GET') {
    let target;
    try { target = Buffer.from(mm[2], 'base64url').toString('utf8'); } catch { target = ''; }
    if (!/^https?:\/\//i.test(target)) return json(res, 400, { error: 'bad segment url' });
    return proxyHls(res, mm[1], target, 0);
  }

  /* 外挂字幕（本地/网盘视频：同目录匹配 + srt/ass/ssa→vtt 转换） */
  async function subtitleCandidates(row) {
    if (webdav.isCloudPath(row.path)) {
      const remotePath = row.path.replace(/^(webdav|alist):/, '');
      const dir = path.posix.dirname(remotePath);
      const list = await webdav.listDir(dir);
      return (list || [])
        .filter((e) => e && !e.isDir && subtitles.isBrowserSupported(e.name))
        .map((e) => ({ name: e.name, remote: (dir === '/' ? '' : dir) + '/' + e.name }));
    }
    if (row.dir && fs.existsSync(row.dir)) {
      return fs.readdirSync(row.dir)
        .filter((n) => subtitles.isBrowserSupported(n))
        .map((n) => ({ name: n, file: path.join(row.dir, n) }));
    }
    return [];
  }

  mm = p.match(/^\/api\/media\/(\d+)\/subtitles$/);
  if (mm && m === 'GET') {
    const row = db.getMedia(parseInt(mm[1], 10));
    if (!row) return json(res, 404, { error: '不存在' });
    try {
      const candidates = await subtitleCandidates(row);
      const matched = subtitles.matchSubtitles(row.file_name || path.basename(row.path), candidates);
      return json(res, 200, matched.map((x, i) => ({ idx: i, name: x.name })));
    } catch (e) {
      return json(res, 200, []); // 字幕发现失败不阻塞播放
    }
  }
  mm = p.match(/^\/api\/media\/(\d+)\/subtitle$/);
  if (mm && m === 'GET') {
    const row = db.getMedia(parseInt(mm[1], 10));
    if (!row) return json(res, 404, { error: '不存在' });
    const idx = parseInt(url.searchParams.get('idx') || '0', 10) || 0;
    /* offset：转码/remux 流重挂 ?start=N 后时间戳从 0 重排 → 字幕轴减去 N（toVtt 内部已完成）；
       shift：用户手动校准（正=字幕延后、负=提前），artp14 新增。 */
    const off = Math.max(0, parseFloat(url.searchParams.get('offset') || '0') || 0);
    const userShift = Math.max(-600, Math.min(600, parseFloat(url.searchParams.get('shift') || '0') || 0));
    try {
      const candidates = await subtitleCandidates(row);
      const matched = subtitles.matchSubtitles(row.file_name || path.basename(row.path), candidates);
      const hit = matched[idx];
      if (!hit) return json(res, 404, { error: '字幕不存在' });
      const buf = hit.remote ? await webdav.fetchBuffer(hit.remote) : fs.readFileSync(hit.file);
      const vtt = subtitles.toVtt(buf, hit.name, off);
      if (vtt == null) return json(res, 415, { error: '该字幕格式暂不支持' });
      const out = userShift ? shiftVttTime(vtt, 0, userShift) : vtt;
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(out);
    } catch (e) {
      return json(res, 502, { error: '字幕读取失败：' + e.message });
    }
  }

  /* 内嵌字幕轨（MKV 等容器自带）：浏览器 textTracks 读不到，走 ffprobe 列轨 + ffmpeg 提取成 VTT。
     缓存键 = 媒体id-流号-文件大小（文件变了自动失效），落 data/cache/subcache。 */
  const EMB_TEXT_CODECS = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'subviewer', 'vtt'];
  /* 内嵌字幕提取：同轨并发去重（连点/多端只跑一次 ffmpeg）+ 进程句柄（便于统一杀） */
  const embeddedInFlight = new Map();
  const embeddedProcs = new Set();
  /* 字幕时间轴平移（artp14 修「字幕与画面不在一个位置」）
   * ------------------------------------------------------------------
   * minusSec = 转码/remux 流的对齐量：播放头从 ?start=N 起算（相对），
   *            而提取出的 VTT 是内容绝对轴 → 必须**减去** N（方向反了会整体延后 N 秒，
   *            续播位置越靠后偏得越明显，这就是之前不同步的真凶）。
   * plusSec  = 用户手动校准（正 = 字幕延后，负 = 提前）。
   * 兼容两种时间戳：ffmpeg 输出的 `MM:SS.mmm` 与 srt/浏览器常见的 `HH:MM:SS.mmm`。 */
  function shiftVttTime(vtt, minusSec, plusSec) {
    const minus = Number(minusSec) || 0;
    const plus = Number(plusSec) || 0;
    if (!minus && !plus) return vtt;
    const fmt = (x) => {
      x = Math.max(0, x);
      const pad = (v, n) => String(Math.floor(v)).padStart(n, '0');
      return pad(x / 3600, 2) + ':' + pad((x / 60) % 60, 2) + ':' + pad(x % 60, 2) + '.' + pad(Math.round((x - Math.floor(x)) * 1000), 3);
    };
    const toSec = (s) => {
      const m = String(s).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})$/);
      if (!m) return null;
      return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
    };
    /* artp24：按 cue 块处理，已播过的（结束时间 <= 0）整条丢弃。
       原来逐个时间戳 Math.max(0,·) → 一回退到流起点之前，前几十条全被压到 0:00:00.000，
       屏幕上一坨字幕同时显示。 */
    const kept = [];
    String(vtt).split(/\n{2,}/).forEach((blk) => {
      const lines = blk.split('\n');
      let ti = -1;
      for (let i = 0; i < lines.length; i++) { if (lines[i].indexOf('-->') >= 0) { ti = i; break; } }
      if (ti < 0) { kept.push(blk); return; }
      const seg = lines[ti].split('-->');
      const a = toSec(seg[0]);
      const b = toSec(seg[1]);
      if (a == null || b == null) { kept.push(blk); return; }
      const na = a - minus + plus;
      const nb = b - minus + plus;
      if (nb <= 0.05) return;
      lines[ti] = lines[ti].replace(/(\S+)\s*-->\s*(\S+)/, () => fmt(na) + ' --> ' + fmt(nb));
      kept.push(lines.join('\n'));
    });
    return kept.join('\n\n');
  }
  mm = p.match(/^\/api\/media\/(\d+)\/embedded-subs$/);
  if (mm && m === 'GET') {
    const row = db.getMedia(parseInt(mm[1], 10));
    if (!row) return json(res, 404, { error: '不存在' });
    const ffprobe = bins.status().ffprobe;
    if (!ffprobe) return json(res, 200, { tracks: [], note: 'ffprobe 未就绪' });
    /* artp33: 网盘片同样支持内嵌字幕 —— 解析 WebDAV 直链后 ffprobe 远端探测（只读文件头，秒级） */
    let probeInput = row.path;
    let remoteProbe = false;
    if (webdav.isCloudPath(row.path)) {
      try { probeInput = await webdav.resolveDirect(row.path); remoteProbe = true; }
      catch (e) { return json(res, 200, { tracks: [], note: '网盘直链解析失败：' + (e.message || '') }); }
    } else if (!fs.existsSync(row.path)) {
      return json(res, 200, { tracks: [], note: '文件不存在，无法探测内嵌字幕' });
    }
    const r = await probe.run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-select_streams', 's', probeInput], { timeout: remoteProbe ? 60000 : 30000 });
    let tracks = [];
    try { tracks = (JSON.parse(r.stdout).streams || []).filter((s) => s.codec_type === 'subtitle'); } catch { /* ignore */ }
    return json(res, 200, {
      tracks: tracks.map((s) => ({
        stream: s.index,
        codec: s.codec_name || '',
        lang: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || '',
        title: (s.tags && (s.tags.title || s.tags.TITLE)) || '',
        isText: EMB_TEXT_CODECS.includes(String(s.codec_name || '').toLowerCase()),
      })),
    });
  }
  mm = p.match(/^\/api\/media\/(\d+)\/embedded-sub$/);
  if (mm && m === 'GET') {
    const row = db.getMedia(parseInt(mm[1], 10));
    if (!row) return json(res, 404, { error: '不存在' });
    const st = parseInt(url.searchParams.get('stream') || '-1', 10);
    const off = Math.max(0, parseFloat(url.searchParams.get('offset') || '0') || 0);
    /* shift：用户手动校准（可正可负，正=字幕延后、负=字幕提前） */
    const userShift = Math.max(-600, Math.min(600, parseFloat(url.searchParams.get('shift') || '0') || 0));
    if (!(st >= 0)) return json(res, 400, { error: 'bad stream' });
    /* artp33: 网盘片解析直链后 ffmpeg 远端提取字幕流（缓存落盘，只慢一次） */
    let ffmpegInput = row.path;
    if (webdav.isCloudPath(row.path)) {
      try { ffmpegInput = await webdav.resolveDirect(row.path); }
      catch (e) { return json(res, 502, { error: '网盘直链解析失败：' + (e.message || '') }); }
    } else if (!fs.existsSync(row.path)) {
      return json(res, 404, { error: '文件不存在，无法提取内嵌字幕' });
    }
    try {
      const cacheDir = require('./lib/paths').ensureDir(path.join(require('./lib/paths').dirs.cache(), 'subcache'));
      const size = fs.statSync(row.path).size;
      const cacheFile = path.join(cacheDir, `${row.id}-s${st}-${size}.vtt`);
      const cacheTmp = cacheFile + '.part';
      /* offset：转码/remux 流重挂 ?start=N 后播放头从 0 起 → 字幕绝对轴要减去 N；
         shift：用户手动校准（正=延后）。两者作用同一份时间轴。 */
      const applyShift = (vtt) => shiftVttTime(vtt, off, userShift);
      /* 快路径：已提取过 → 直接读缓存（毫秒级） */
      if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 8) {
        const vtt = applyShift(fs.readFileSync(cacheFile, 'utf8'));
        res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(vtt);
      }
      /* 慢路径：ffmpeg 流式提取，边转边发 —— 12GB 影片顺序读完要 ~30s，
         流式让浏览器先拿到开头几句（VTT 渐进解析），第一句字幕几秒内就能显示，
         不再出现「等半天突然全出来」的 不同步 观感；同时 tee 落盘供下次秒开。 */
      const ffmpeg = bins.status().ffmpeg;
      if (!ffmpeg) return json(res, 503, { error: 'ffmpeg 未就绪' });
      const key = cacheFile;
      if (embeddedInFlight.has(key)) {           // 同轨并发去重：连点/多端只跑一次 ffmpeg
        embeddedInFlight.get(key).then((buf) => {
          if (!res.headersSent) {
            res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(applyShift(buf.toString('utf8')));
          }
        }).catch(() => { if (!res.headersSent) json(res, 500, { error: '内嵌字幕提取失败' }); });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store', 'X-Hmp-Stream': '1' });
      const proc = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', ffmpegInput, '-map', '0:' + st, '-f', 'webvtt', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
      embeddedProcs.add(proc);
      const chunks = [];
      const out = fs.createWriteStream(cacheTmp);
      let done = false;
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        embeddedProcs.delete(proc);
        embeddedInFlight.delete(key);
        try { out.end(); } catch { /* ignore */ }
        if (code === 0 && chunks.length) {
          const buf = Buffer.concat(chunks);
          embeddedInFlight.set(key, Promise.resolve(buf));
          try { fs.renameSync(cacheTmp, cacheFile); } catch { /* ignore */ }
        } else {
          try { fs.unlinkSync(cacheTmp); } catch { /* ignore */ }
          embeddedInFlight.set(key, Promise.reject(new Error('ffmpeg exit ' + code)));
        }
        try { res.end(); } catch { /* ignore */ }
      };
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } finish(-9); }, 1800000); // 30 分钟兜底（NAS 慢盘 + 超长片）
      proc.stdout.on('data', (d) => { chunks.push(d); try { res.write(d); } catch { /* ignore */ } try { out.write(d); } catch { /* ignore */ } });
      let errTail = '';
      proc.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-2000); });
      proc.on('error', (e) => { errTail = String(e.message || e); finish(-1); });
      proc.on('close', (code) => { if (code !== 0) console.warn(`[embedded-sub] ${row.id} stream=${st} ffmpeg 退出 ${code}: ${errTail.slice(-300)}`); finish(code); });
      return;
    } catch (e) {
      if (!res.headersSent) return json(res, 502, { error: '内嵌字幕提取失败：' + e.message });
      try { res.end(); } catch { /* ignore */ }
      return;
    }
  }

  /* gh: 网络字幕下载（OpenSubtitles：按标题+剧集集数搜中文 srt，落到视频同目录自动匹配）
     国内直连 OpenSubtitles 是 403（IP 限制），支持 opensubtitlesApiBaseUrl 设置 / HMP_OS_API_BASE 挂 CF Worker 代理 */
  /* artp34: 进度条缩略图（Netflix 式）——ffmpeg 按固定间隔抽帧拼成雪碧图，异步生成 + 落盘缓存。
     生成一次大概几十秒到几分钟（大片/网盘片更久），所以只后台跑，前端轮询；生成完下次点开即带缩略图。 */
  const stripInFlight = (global.__hmpStripInFlight || (global.__hmpStripInFlight = new Map()));
  /* artp37：缩略图单格尺寸与质量。384x216 对齐夸克/Netflix 那种"单帧大图"的观感，
     比原来的 200x112 像素量多 3.7 倍；q:v 4 换清晰度（体积仍只有几百 KB）。
     改尺寸必须同步进缓存键（见路由 base），否则会命中旧尺寸雪碧图。 */
  const THUMB_W = 384;
  const THUMB_Q = 4;
  async function genThumbStrip(row, base, n, col) {
    const P = require('./lib/paths');
    const cacheDir = P.ensureDir(path.join(P.dirs.cache(), 'thumbstrip'));
    const jpg = path.join(cacheDir, base + '.jpg');
    const tmp = jpg + '.part';
    let input = row.path;
    if (webdav.isCloudPath(row.path)) input = await webdav.resolveMediaPath(row.path);
    else if (!fs.existsSync(row.path)) throw new Error('文件不存在');
    let dur = Number(row.duration) || 0;
    if (!(dur > 1)) {
      const fp = bins.status().ffprobe;
      if (fp) {
        try {
          const r = await probe.run(fp, ['-v', 'error', '-print_format', 'json', '-show_format', input], { timeout: 60000 });
          dur = Number((JSON.parse(r.stdout).format || {}).duration) || 0;
        } catch { /* ignore */ }
      }
    }
    if (!(dur > 1)) throw new Error('无法确定片长');
    /* 网盘片每次 -ss 是一次 Range 请求，并发保守一点（3 路）；本地片 4 路。 */
    const isCloud = webdav.isCloudPath(row.path);
    const shots = n;
    const interval = Math.max(1, dur / shots);
    const rows = Math.ceil(shots / col);
    const vw = Number(row.width) || 16, vh = Number(row.height) || 9;
    const tw = THUMB_W;
    const th = Math.max(2, Math.round((tw * vh / vw) / 2) * 2);
    const ffmpeg = bins.status().ffmpeg;
    if (!ffmpeg) throw new Error('ffmpeg 未就绪');
    /* 抽帧策略：逐点 -ss 定位抽 1 帧，而不是全片解码。
       实测全片解码抽帧 200s 都没出图（20GB 蓝光原盘 IO 吃不消），而单次定位抽帧只要 1s。
       100 个点 4 路并发 ≈ 30s，再 tile 拼成一张雪碧图。 */
    const work = path.join(cacheDir, 'w-' + base);
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 老 Node 无 rmSync，下面兜底 */ }
    try { fs.mkdirSync(work, { recursive: true }); } catch (e) { throw new Error('无法创建临时目录'); }
    const run = (args, ms) => new Promise((resolve, reject) => {
      const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } reject(new Error('ffmpeg 超时')); }, ms || 120000);
      let err = '';
      proc.stderr.on('data', (d) => { err = (err + d.toString()).slice(-400); });
      proc.on('error', (e) => { clearTimeout(t); reject(e); });
      proc.on('close', (code) => { clearTimeout(t); if (code === 0) resolve(); else reject(new Error(err || ('ffmpeg exit ' + code))); });
    });
    const shot = (i) => path.join(work, String(i).padStart(4, '0') + '.jpg');
    let cursor = 0;
    const CONC = isCloud ? 3 : 4;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= shots) return;
        const t = Math.max(0, Math.min(dur - 0.5, (i + 0.5) * interval));
        try {
          /* 网盘片单帧实测 2~12s，45s 还不出就是废点（早砍掉，别让一个挂死请求拖住整批）；
             本地盘 1s 上下，保留 120s 兜底给冷缓存大文件。 */
          const shotMs = isCloud ? 45000 : 120000;
          await run(['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', input,
            '-frames:v', '1', '-vf', `scale=${tw}:${th}`, '-q:v', String(THUMB_Q), '-f', 'image2', '-y', shot(i)], shotMs);
        } catch { /* 该点失败先跳过，下面用邻近帧补齐 */ }
      }
    };
    await Promise.all(Array.from({ length: CONC }, () => worker()));
    /* 补齐缺失帧（seek 失败/片尾越界）：往前找最近一张，保证 tile 网格连续不错位 */
    let last = null;
    for (let i = 0; i < shots; i++) {
      const f = shot(i);
      let ok = false;
      try { ok = fs.existsSync(f) && fs.statSync(f).size > 200; } catch { ok = false; }
      if (ok) { last = f; continue; }
      if (!last) continue;
      try { fs.copyFileSync(last, f); } catch { /* ignore */ }
    }
    let have = 0;
    try { have = fs.readdirSync(work).filter((x) => x.endsWith('.jpg')).length; } catch { have = 0; }
    if (have < Math.max(4, Math.floor(shots / 4))) throw new Error('抽帧失败（片源读不动？）');
    await run(['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', path.join(work, '%04d.jpg'),
      '-vf', `tile=${col}x${rows}`, '-frames:v', '1', '-q:v', String(THUMB_Q), '-f', 'mjpeg', '-y', tmp], 180000);
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.renameSync(tmp, jpg); } catch (e) { throw new Error('写缓存失败'); }
    return { file: jpg, w: tw, h: th };
  }
  mm = p.match(/^\/api\/media\/(\d+)\/thumbstrip$/);
  if (mm && m === 'GET') {
    const id = parseInt(mm[1], 10);
    const row = db.getMedia(id);
    if (!row) return json(res, 404, { error: '不存在' });
    const n = Math.max(20, Math.min(200, parseInt(url.searchParams.get('n') || '100', 10) || 100));
    const col = 10;
    /* 网盘片同样支持：播放用的是 webdav.resolveMediaPath（OpenList dav 地址，带鉴权），
       ffmpeg 直接读它抽帧即可（实测单帧 0.3~0.9s）。注意别用 resolveDirect——那是 302 直链，已失效。 */
    /* 网盘片：每帧是一次 Range 请求，实测 2~12s/帧，100 帧要约 5 分钟 → 收敛到 40 帧（约 2 分钟）。
       number 必须回实际帧数：前端按 number 算雪碧图 background-position，回请求值会落到空白区。 */
    const realN = webdav.isCloudPath(row.path) ? Math.min(n, 40) : n;
    const P = require('./lib/paths');
    const cacheDir = P.ensureDir(path.join(P.dirs.cache(), 'thumbstrip'));
    let size = 0;
    try { size = fs.statSync(row.path).size; } catch { size = Number(row.size) || 0; }
    const base = `${id}-${size}-${realN}-w${THUMB_W}`;
    const jpg = path.join(cacheDir, base + '.jpg');
    const vw = Number(row.width) || 16, vh = Number(row.height) || 9;
    const dimOf = (w) => Math.max(2, Math.round((w * vh / vw) / 2) * 2);
    /* 注意别叫 url —— 同函数已有名为 url 的请求 URL 参数，const 同名会 TDZ 报错 */
    const stripUrl = (n2, w) => `/api/media/${id}/thumbstrip.jpg?n=${n2}` + (w ? `&w=${w}` : '');
    if (fs.existsSync(jpg) && fs.statSync(jpg).size > 1000) {
      return json(res, 200, {
        ready: true, url: stripUrl(realN, THUMB_W), number: realN, column: col,
        w: THUMB_W, h: dimOf(THUMB_W), upgrading: false,
      });
    }
    /* artp38：高清档还没生成好时，先用历史 200px 那版顶上（宁可小也别空窗），
       并回 upgrading:true 让前端继续轮询；新图生成完自动替换。 */
    const legacy = path.join(cacheDir, `${id}-${size}-${realN}.jpg`);
    let legacyOk = false;
    try { legacyOk = fs.existsSync(legacy) && fs.statSync(legacy).size > 1000; } catch (e) { legacyOk = false; }
    if (legacyOk) {
      const stripFail0 = (global.__hmpStripFail || (global.__hmpStripFail = new Map()));
      const f0 = stripFail0.get(base);
      if (!f0 && !stripInFlight.has(base)) {
        const t0 = genThumbStrip(row, base, realN, col).then(() => null).catch(() => null);
        stripInFlight.set(base, t0);
        t0.then(() => setTimeout(() => stripInFlight.delete(base), 3000)).catch(() => setTimeout(() => stripInFlight.delete(base), 3000));
      }
      return json(res, 200, {
        ready: true, url: stripUrl(realN), number: realN, column: col,
        w: 200, h: dimOf(200), upgrading: true,
      });
    }
    const stripFail = (global.__hmpStripFail || (global.__hmpStripFail = new Map()));
    const failed = stripFail.get(base);
    if (failed) return json(res, 200, { ready: false, status: 'failed', reason: failed });
    if (!stripInFlight.has(base)) {
      const task = genThumbStrip(row, base, realN, col).then(() => null).catch((e) => {
        const msg = String((e && e.message) || e || '未知错误');
        console.warn(`[thumbstrip] ${id} 生成失败：${msg}`);
        stripFail.set(base, msg);
        return msg;
      });
      stripInFlight.set(base, task);
      task.then(() => {
        /* 新档生成成功，删掉历史 200px 版本，避免同一片留两套缓存 */
        try {
          const lg = path.join(cacheDir, `${id}-${size}-${realN}.jpg`);
          if (fs.existsSync(lg) && fs.existsSync(jpg)) fs.unlinkSync(lg);
        } catch (e) { /* ignore */ }
        setTimeout(() => stripInFlight.delete(base), 3000);
      }).catch(() => setTimeout(() => stripInFlight.delete(base), 3000));
    }
    return json(res, 200, { ready: false, status: 'generating' });
  }
  mm = p.match(/^\/api\/media\/(\d+)\/thumbstrip\.jpg$/);
  if (mm && m === 'GET') {
    const id = parseInt(mm[1], 10);
    const n = Math.max(20, Math.min(200, parseInt(url.searchParams.get('n') || '100', 10) || 100));
    const row = db.getMedia(id);
    if (!row) return json(res, 404, { error: '不存在' });
    const P = require('./lib/paths');
    const cacheDir = P.ensureDir(path.join(P.dirs.cache(), 'thumbstrip'));
    let size = 0;
    try { size = fs.statSync(row.path).size; } catch { size = Number(row.size) || 0; }
    /* ?w=<档位宽> 取 `-w<w>.jpg`；不带 w 时先试默认高清档，再回落历史老文件（兼容旧链接） */
    const wq = parseInt(url.searchParams.get('w') || '', 10);
    const cands = [];
    if (Number.isFinite(wq) && wq > 0) cands.push(`${id}-${size}-${n}-w${wq}.jpg`);
    else { cands.push(`${id}-${size}-${n}-w${THUMB_W}.jpg`); cands.push(`${id}-${size}-${n}.jpg`); }
    let jpg = null;
    for (const c of cands) {
      const f = path.join(cacheDir, c);
      try { if (fs.existsSync(f) && fs.statSync(f).size > 1000) { jpg = f; break; } } catch (e) { /* ignore */ }
    }
    if (!jpg) return json(res, 404, { error: '缩略图尚未生成' });
    const buf = fs.readFileSync(jpg);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=864000', 'Content-Length': buf.length });
    return res.end(buf);
  }
  mm = p.match(/^\/api\/media\/(\d+)\/subtitle\/fetch$/);
  if (mm && m === 'POST') {
    const row = db.getMedia(parseInt(mm[1], 10));
    if (!row) return json(res, 404, { ok: false, error: '媒体不存在' });
    const osKey = db.getSetting('opensubtitlesApiKey', null) || process.env.HMP_OS_API_KEY || null;
    if (!osKey) return json(res, 412, { ok: false, error: '未配置 OpenSubtitles API Key（设置 → 元数据与在线片源）' });
    const osBase = (db.getSetting('opensubtitlesApiBaseUrl', '') || process.env.HMP_OS_API_BASE || 'https://api.opensubtitles.com/api/v1').replace(/\/+$/, '');
    const osHeaders = { 'Api-Key': osKey, 'User-Agent': 'home-media-player v0.5', Accept: 'application/json' };
    const osJson = async (u, opt = {}) => {
      const r = await fetch(u, { ...opt, headers: { ...osHeaders, ...(opt.headers || {}) }, signal: AbortSignal.timeout(30000) });
      const t = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} ${t.slice(0, 140)}`);
      try { return JSON.parse(t); } catch { throw new Error('响应非 JSON：' + t.slice(0, 80)); }
    };
    try {
      const queries = [];
      if (row.title) queries.push(String(row.title));
      if (row.tmdb_title && row.tmdb_title !== row.title) queries.push(String(row.tmdb_title));
      if (!queries.length) queries.push(String(row.file_name || path.basename(row.path)).replace(/\.[^.]+$/, ''));
      let first = null;
      for (const q0 of queries) {
        const qs = new URLSearchParams({ query: q0, languages: 'zh-cn' });
        if (row.kind === 'episode' && row.season != null) qs.set('season', String(row.season));
        if (row.kind === 'episode' && row.episode != null) qs.set('episode', String(row.episode));
        const sr = await osJson(`${osBase}/subtitles?${qs}`);
        first = sr && sr.data && sr.data[0];
        if (first) break;
      }
      const fileId = first && first.attributes && first.attributes.files && first.attributes.files[0] && first.attributes.files[0].file_id;
      if (!fileId) return json(res, 200, { ok: false, error: 'OpenSubtitles 没有中文字幕结果' });
      const dl = await osJson(`${osBase}/download`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fileId }) });
      if (!dl || !dl.link) return json(res, 200, { ok: false, error: 'OpenSubtitles 未返回下载链接（检查 Key 配额）' });
      const fr = await fetch(dl.link, { signal: AbortSignal.timeout(60000) });
      const srtText = fr.ok ? await fr.text() : '';
      if (!srtText || srtText.length < 20) return json(res, 200, { ok: false, error: '字幕文件下载失败' });
      const base = String(row.file_name || path.basename(row.path)).replace(/\.[^.]+$/, '');
      const content = '\ufeff' + srtText.replace(/^\ufeff/, '');
      /* 网盘片源：字幕必须写回网盘同目录——fsp.writeFile 对 webdav:/ 虚拟路径必然
         ENOENT；且 WebDAV 层（/dav）PUT 对普通用户/管理员均返回 403，故走 OpenList
         HTTP API /api/fs/put（openlist.fsPut，实测 200）写回影片同目录 */
      if (webdav.isCloudPath(row.path)) {
        const remoteDir = String(row.dir || row.path).replace(/^(webdav|alist):/, '').replace(/\/+$/, '');
        const remoteOut = (remoteDir || '') + '/' + base + '.chs.srt';
        await openlist.fsPut(remoteOut, Buffer.from(content, 'utf8'));
        return json(res, 200, { ok: true, name: base + '.chs.srt', remote: true, release: (first.attributes && first.attributes.release) || '' });
      }
      const outPath = path.join(row.dir || path.dirname(row.path), `${base}.chs.srt`);
      await fsp.writeFile(outPath, content, 'utf8');
      return json(res, 200, { ok: true, name: path.basename(outPath), release: (first.attributes && first.attributes.release) || '' });
    } catch (e) {
      return json(res, 200, { ok: false, error: '字幕搜索/下载失败：' + e.message });
    }
  }

  /* 网盘（标准 WebDAV：Alist /dav、坚果云、InfiniCloud 等） */
  if (p === '/api/webdav/config' && m === 'GET') return json(res, 200, webdav.getConfig());
  /* gn: 网盘桥接（OpenList）探测：挂载百度/阿里/夸克等网盘的引导 */
  if (p === '/api/webdav/bridge' && m === 'GET') return json(res, 200, await webdav.probeBridge());
  if (p === '/api/webdav/config' && m === 'POST') {
    const body = await readBody(req);
    try {
      const r = await webdav.saveConfig(body || {});
      return json(res, 200, r);
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === '/api/webdav/list' && m === 'GET') {
    try {
      const dir = q.get('path') || '/';
      const entries = await webdav.listDir(dir);
      return json(res, 200, {
        path: dir,
        dirs: entries.filter((e) => e.isDir).map((e) => ({ name: e.name, path: (dir === '/' ? '' : dir) + '/' + e.name })),
      });
    } catch (e) {
      return json(res, 200, { error: e.message });
    }
  }
  if (p === '/api/webdav/roots' && m === 'POST') {
    const body = await readBody(req);
    if (!body || !body.path) return json(res, 400, { error: '缺少远程目录 path' });
    try {
      await webdav.listDir(body.path); // 验证目录存在
    } catch (e) {
      return json(res, 400, { error: '目录不可访问: ' + e.message });
    }
    const id = db.addRoot(body.path, body.label || 'WebDAV 网盘', 'webdav');
    return json(res, 200, { ok: true, id });
  }

  /* go+++：网盘快捷入口 —— 一排带网盘名的按钮，点开就在影视库里授权挂载。
   * 全部走 127.0.0.1 的 OpenList 管理接口，凭据不出本机；写操作已纳入管理锁。 */
  if (p === '/api/openlist/drives' && m === 'GET') {
    let running = false; let port = null; let own = false; let storages = [];
    try {
      const b = await webdav.probeBridge();
      running = !!(b && b.running); port = b && b.port; own = !!(b && b.own);
      if (running && own) storages = await openlist.listStorages();
    } catch { /* 桥接没装/没起：只返回清单，前端显示引导 */ }
    return json(res, 200, { running, port, own, drives: openlist.catalog(), storages });
  }
  if (p === '/api/openlist/add' && m === 'POST') {
    const body = await readBody(req);
    try {
      if (!body || !body.drive) return json(res, 400, { error: '缺少 drive（网盘类型）' });
      const r = await openlist.addStorage(body.drive, body.values || {}, { mountPath: body.mountPath });
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 200, { ok: false, error: openlist.humanizeStorageError(e.message), code: e.code || '' });
    }
  }
  if (p === '/api/openlist/creds' && m === 'GET') {
    try {
      return json(res, 200, { ok: true, ...(await openlist.creds()) });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, code: e.code || '' });
    }
  }
  if (p === '/api/openlist/storages' && m === 'GET') {
    try {
      return json(res, 200, { ok: true, storages: await openlist.listStorages() });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, code: e.code || '' });
    }
  }
  if (p === '/api/openlist/enable' && m === 'POST') {
    const body = await readBody(req);
    try {
      return json(res, 200, { ok: true, ...(await openlist.setStorageEnabled(body.id, body.on !== false)) });
    } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }
  if (p === '/api/openlist/delete' && m === 'POST') {
    const body = await readBody(req);
    try {
      return json(res, 200, { ok: true, ...(await openlist.deleteStorage(body.id)) });
    } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }
  if (p === '/api/openlist/qrcode' && m === 'POST') {
    const body = await readBody(req);
    try {
      const r = body && body.token
        ? await openlist.qrcodePoll(body.drive, body.token)
        : await openlist.qrcodeStart(body.drive);
      return json(res, 200, { ok: !!r, data: r });
    } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }

  /* 目录浏览（媒体库「选择目录」用）：本机磁盘 + 局域网共享（UNC 路径） */
  if (p === '/api/fs/browse' && m === 'GET') {
    let target = (url.searchParams.get('path') || '').trim();
    if (!target) {
      // 未指定路径：列出本机盘符（Windows）或根目录（POSIX）
      if (process.platform === 'win32') {
        const drives = [];
        for (let i = 67; i <= 90; i++) {
          const letter = String.fromCharCode(i) + ':\\';
          try {
            fs.accessSync(letter);
            drives.push(letter);
          } catch {}
        }
        return json(res, 200, { path: '', parent: null, dirs: drives, drives: true });
      }
      // POSIX：不直接列系统根目录，先给「常用位置」（NAS 共享目录等）
      const quick = [];
      const pushq = (p) => { if (!quick.includes(p)) quick.push(p); };
      try {
        if (fs.existsSync('/share')) {
          for (const n of fs.readdirSync('/share')) {
            if (/^(NFSv|external)/.test(n) || n.startsWith('.') || n.startsWith('@')) continue;
            if (/(_DATA$|^Qrootfs$|^homes$)/i.test(n)) continue; // QNAP 卷挂载点/系统目录
            const p2 = '/share/' + n;
            let s2; try { s2 = fs.statSync(p2); } catch { continue; }
            if (s2.isDirectory()) pushq(p2);
          }
        }
      } catch { /* ignore */ }
      for (const c of ['/mnt', '/media', '/home']) {
        try { if (fs.statSync(c).isDirectory()) pushq(c); } catch { /* ignore */ }
      }
      if (quick.length) return json(res, 200, { path: '', parent: null, dirs: quick, quick: true });
      target = '/';
    }
    try {
      const st = fs.statSync(target);
      if (!st.isDirectory()) return json(res, 400, { error: '不是目录: ' + target });
      const entries = await fsp.readdir(target, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, 'zh'));
      // files=1 时附带文件列表（片单 JSON / m3u 选择用）
      const wantFiles = url.searchParams.get('files') === '1';
      let files = [];
      if (wantFiles) {
        const exts = (url.searchParams.get('exts') || '').trim();
        const allow = exts ? exts.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) : null;
        files = entries
          .filter((e) => e.isFile() && !e.name.startsWith('.'))
          .map((e) => e.name)
          .filter((n) => !allow || allow.includes(path.extname(n).toLowerCase()))
          .sort((a, b) => a.localeCompare(b, 'zh'));
      }
      const parent = path.dirname(target);
      return json(res, 200, {
        path: target,
        parent: parent === target ? null : parent,
        dirs,
        files,
      });
    } catch (e) {
      return json(res, 400, { error: '无法访问该目录（检查路径/权限/网络共享是否可达）: ' + e.message.slice(0, 120) });
    }
  }

  // 兜底：内嵌游戏库发起的接口请求（referer 落在 /romm/ 上），转给 RomM
  if (p.startsWith('/api/') && fromRomm(req)) return proxyRomm(req, res, p, url.search);

  return json(res, 404, { error: '未知 API: ' + p });
}

/* ---------------- 游戏库（RomM）同源反向代理 ----------------
   为什么必须有它：RomM 跑在 Docker 里、只认自己的 8098 端口。网页一旦在 https 域名下打开
   （内网穿透 / 套了反向代理），直接嵌 http://<主机>:8098 会被浏览器当「混合内容」拦掉 ——
   那就是「点游戏页面一片空白」的真因；而「↗ 在新窗口玩」开的 http://<域名>:8098 也走不通，
   穿透链路往往只放行了 443，8098 根本连不上。
   走同源 /romm/ 前缀代理之后：iframe 和新窗口都是同一个 https 源，既没有混合内容问题，
   也不用额外开端口。代理只做两件小事：①剥掉 /romm 前缀转发；②把 RomM 前端里唯一的绝对
   基址 baseURL:`/api` 改成 /romm/api（它的所有接口请求都从这一个基址拼出来）；资源文件
   用的都是 Vite 相对路径，主脚本落在 /romm/assets 下之后会自动跟着过来。 */
function rommOrigin() {
  const port = Math.max(1, Math.min(65535, Number(process.env.ROMM_PORT) || 8098));
  const host = String(process.env.ROMM_HOST || '127.0.0.1').trim();
  return `http://${host}:${port}`;
}

async function proxyRomm(req, res, upstreamPath, search) {
  const { Readable } = require('node:stream');
  const target = rommOrigin() + upstreamPath + (search || '');
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    // ★ cookie 丢掉：RomM 的会话由服务端代持注入（rommAuthHeaders），浏览器自己的 cookie
    //   既没必要带上去，也免得和服务端会话打架（否则会出现「明明配了账号还是跳登录」）。
    if (/^(host|connection|content-length|transfer-encoding|accept-encoding|cookie)$/i.test(k)) continue;
    headers[k] = v;
  }
  const auth = await rommAuthHeaders();
  if (auth) Object.assign(headers, auth);
  const init = { method: req.method, headers, redirect: 'manual' };
  const isGet = /^(GET|HEAD)$/i.test(req.method);
  if (!isGet) {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }
  let up;
  try {
    up = await fetch(target, init);
    // 会话过期或被顶掉：重登一次再取（只对幂等请求重试，POST 重放有风险）
    if (isGet && (up.status === 401 || up.status === 403)) {
      await rommLogin(true);
      const retry = await rommAuthHeaders();
      if (retry) { Object.assign(headers, retry); up = await fetch(target, init); }
    }
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('游戏库没有响应（容器没跑？）：' + String(e.message).slice(0, 200));
  }
  const out = {};
  up.headers.forEach((v, k) => {
    // ★ content-encoding / content-length 一律丢掉：undici 拿到 nginx 的 gzip 响应后
    //   已经透明解压过，up.text() 拿到的是明文；我们再改写正文却把 gzip 头原样带下去，
    //   浏览器会按 gzip 去解一段明文 —— 页面就永远卡在 loading（表现：游戏页一片空）。
    // ★ set-cookie 也丢掉：RomM 的登录态由服务端代持，不需要落到浏览器上，
    //   留着反而会覆盖本程序自己的 cookie。
    if (!/^(transfer-encoding|connection|content-length|content-encoding|set-cookie)$/i.test(k)) out[k] = v;
  });
  const ct = String(up.headers.get('content-type') || '');
  try {
    if (/text\/html/i.test(ct)) {
      // index.html 里的资源都是 /assets/... 绝对根路径，补上 /romm 前缀
      const html = (await up.text()).replace(/(src|href)="\/(?!\/)/g, '$1="/romm/');
      res.writeHead(up.status, { ...out, 'content-length': Buffer.byteLength(html) });
      return res.end(html);
    }
    if (/(application|text)\/(javascript|x-javascript|ecmascript)|text\/x-js/i.test(ct)) {
      // ① 接口基址 /api → /romm/api
      // ② ★ SPA 路由基准改成 /romm/：Vue Router 默认以站点根为基准，走 /romm/ 前缀后
      //    它会把 /romm/rom/3 当成一个不存在的路由 —— 表现是「已经免登录进去了，却遍地 404」。
      let js = (await up.text()).replace('baseURL:`/api`', 'baseURL:`/romm/api`');
      js = js.replace(/history:(\w+)\(\{\}\.BASE_URL\)/, 'history:$1("/romm/")');
      res.writeHead(up.status, { ...out, 'content-length': Buffer.byteLength(js) });
      return res.end(js);
    }
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('游戏库响应改写失败：' + String(e.message).slice(0, 200));
  }
  res.writeHead(up.status, out);
  if (up.body && req.method !== 'HEAD') Readable.fromWeb(up.body).pipe(res);
  else res.end();
}

/* qBittorrent WebUI 同源代理（20260927dlui）：/qbui/* 页面资源 + /api/v2/* Web API。
   登录态由服务端代持（qbit.webHeaders），浏览器 iframe 免登录直接进完整管理页。
   HMP 自己的 API 没有 /api/v2 前缀，qBT WebUI 的 JS 又全部用绝对路径调 /api/v2/...，
   两个前缀一接，整个 WebUI 无缝搬进本程序 —— 不用再输一次密码。 */
/* qBT 5.x WebUI 父窗口上下文垫片（20260928dlx4）：
   qBT 官方假定「WebUI 被嵌进 iframe 时，父窗口也是 qBT 页面」—— color-scheme.js 直接读
   window.parent.qBittorrent.ClientData，MochaUI 又调裸 parent.getCoordinates()。我们把整个
   qBT 塞进 HMP 的 iframe，父窗口是 HMP，两条都炸：client.js 的 DOMContentLoaded 初始化链
   在「给工具栏按钮绑事件」之前就断掉 —— 表现为一排图标全点不动。这里只把父窗口缺的上下文
   补上，qBT 一行代码不改，升级不受影响；只在被 iframe 嵌且路径是 /qbui 时才生效。 */
const QBT_FRAME_SHIM = `<script>(function(){try{if(window.parent===window)return;var p=location.pathname;while(p.length>1&&p.charAt(p.length-1)==='/')p=p.slice(0,-1);if(p!=='/qbui')return;if(typeof window.parent.getCoordinates!=='function'){window.parent.getCoordinates=function(){return{width:window.innerWidth,height:window.innerHeight,top:0,left:0,right:window.innerWidth,bottom:window.innerHeight};};}Object.defineProperty(window.parent,'qBittorrent',{configurable:true,get:function(){return window.qBittorrent;},set:function(){}});var MAP={'--hmp-bg':'--bg','--hmp-bg-card':'--bg-card','--hmp-bg-elev':'--bg-elev','--hmp-bg-hover':'--bg-hover','--hmp-border':'--border','--hmp-border-mid':'--border-mid','--hmp-border-strong':'--border-strong','--hmp-text':'--text','--hmp-text-mute':'--text-mute','--hmp-accent':'--accent','--hmp-sh-45':'--sh-45'};function btSync(){try{var cs=getComputedStyle(window.parent.document.documentElement),out=[];for(var k in MAP){var v=cs.getPropertyValue(MAP[k]);if(v){v=v.trim();if(v)out.push(k+':'+v);}}if(out.length)document.documentElement.style.cssText+=';'+out.join(';');}catch(e){}}btSync();setTimeout(btSync,900);setTimeout(btSync,3000);try{window.parent.addEventListener('hmp-theme-change',btSync);}catch(e){}try{new MutationObserver(function(){btSync();}).observe(window.parent.document.documentElement,{attributes:true,attributeFilter:['data-theme']});}catch(e){}}catch(e){}})();<\/script>`;
async function proxyQbit(req, res, upstreamPath, search) {
  const { Readable } = require('node:stream');
  const origin = qbit.cfg().url;
  if (!origin) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('还没连接 qBittorrent：回「下载中心 → BT / 磁力 → ⚙ 连接设置」配好地址再来。');
  }
  const target = origin + upstreamPath + (search || '');
  let wh;
  try { wh = await qbit.webHeaders(); }
  catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('qBittorrent 登录失败：' + String(e.message).slice(0, 200));
  }
  const headers = { Cookie: wh.Cookie || '', Origin: origin, Referer: origin + '/', Accept: req.headers.accept || '*/*' };
  const ct0 = String(req.headers['content-type'] || '');
  if (ct0) headers['Content-Type'] = ct0;
  const init = { method: req.method, headers, redirect: 'manual' };
  const isGet = /^(GET|HEAD)$/i.test(req.method);
  if (!isGet) {
    const chunks = []; let total = 0;
    for await (const c of req) { chunks.push(c); total += c.length; if (total > 67108864) { try { res.writeHead(413); res.end('payload too large'); } catch (e) {} return; } }
    const body = Buffer.concat(chunks);
    if (body.length) { init.body = body; headers['Content-Length'] = String(body.length); }
  }
  let up;
  try {
    up = await fetch(target, init);
    // 登录态失效：重登一次再取（只对幂等请求重试，POST 重放有风险）
    if (up.status === 403) {
      await qbit.relogin();
      wh = await qbit.webHeaders();
      headers.Cookie = wh.Cookie || '';
      up = await fetch(target, init);
    }
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('qBittorrent 没有响应（容器没跑？）：' + String(e.message).slice(0, 200));
  }
  const out = {};
  up.headers.forEach((v, k) => {
    // content-encoding/length 丢（同 RomM 代理的 gzip 坑）；set-cookie 丢（SID 服务端代持）
    if (!/^(transfer-encoding|connection|content-length|content-encoding|set-cookie)$/i.test(k)) out[k] = v;
  });
  const ct = String(up.headers.get('content-type') || '');
  try {
    if (/text\/html/i.test(ct)) {
      // 页面里的绝对根路径资源补 /qbui 前缀；相对路径由 iframe 的 /qbui/ 基准自然命中代理。
      // 再注入皮肤 CSS（</head> 前），把 qBT 原生界面拉成 HMP 的观感。
      let html = await up.text();
      html = html.replace(/(src|href|action)="\/(?!\/)/g, '$1="/qbui/');
      html = html.replace(/<\/head>/i, '<link rel="stylesheet" href="/qbui-skin.css">' + QBT_FRAME_SHIM + '<\/head>');
      // dlx6b：内嵌时 window.parent 是 HMP 顶层页，preferences 保存后的 reload 不能刷掉整个 HMP（独立打开时 parent===window，此改写等价无副作用）
      html = html.split('window.parent.location.reload()').join('window.location.reload()');
      res.writeHead(up.status, { ...out, 'content-length': Buffer.byteLength(html) });
      return res.end(html);
    }
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('qBittorrent 页面改写失败：' + String(e.message).slice(0, 200));
  }
  res.writeHead(up.status, out);
  if (up.body && req.method !== 'HEAD') Readable.fromWeb(up.body).pipe(res);
  else res.end();
}

/* 判断请求是不是来自内嵌的游戏库（referer 落在 /romm/ 上） */
function fromRomm(req) {
  return String(req.headers.referer || '').includes('/romm/');
}

/* ---------------- IP 白名单 / 访问限制 ----------------
 * 用户提的硬需求：「增加 IP 限制功能，非白名单 IP 直接拒绝访问」。
 * 设计上防三件事：
 *  1) 自锁：loopback（127.0.0.1 / ::1）永远放行，NAS 本机浏览器永远能进来改白名单；
 *  2) 假信任：默认只认 socket 对端地址，不采信 X-Forwarded-For（可被伪造）；
 *     只有显式 HMP_TRUST_PROXY=1 才采信反代传来的首段；
 *  3) 锁死：白名单为空 = 不启用（全放行），不会因为误清空导致全站打不开。
 */
let ipGuardCache = { at: 0, enabled: false, list: '' };
function ipRule() {
  if (Date.now() - ipGuardCache.at < 5000) return ipGuardCache;
  ipGuardCache = {
    at: Date.now(),
    enabled: String(db.getSetting('ipWhitelistEnabled', '0')) === '1',
    list: String(db.getSetting('ipWhitelist', '') || ''),
  };
  return ipGuardCache;
}
function ipGuard(req, res, p) {
  let enabled = false, list = '', remote = '';
  try {
    const rule = ipRule();
    enabled = rule.enabled;
    list = rule.list;
    const trustProxy = /^(1|true|yes|on)$/i.test(String(process.env.HMP_TRUST_PROXY || ''));
    const xff = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    remote = String((xff || (req.socket && req.socket.remoteAddress) || '')).replace(/^::ffff:/, '');
  } catch { /* 读设置失败按放行处理，绝不因守卫把站点锁死 */ }
  if (!enabled) return true;
  if (p === '/api/health') return true;
  if (cidr.isLoopback(remote)) return true;
  if (cidr.match(remote, list)) return true;
  /* 注意：server 端没有前端的 esc()，这里必须自己转义（remote 来自 socket，理论可控但仍转） */
  const escIp = String(remote || '未知').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>访问受限</title><style>body{background:#0f1115;color:#e8eaed;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;` +
    `display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.c{max-width:420px;padding:28px 30px;text-align:center;` +
    `background:#171a21;border:1px solid #262a33;border-radius:14px}h1{font-size:19px;margin:0 0 10px}p{font-size:13.5px;line-height:1.8;color:#9aa0a6;margin:0}` +
    `code{background:#0b0d11;border:1px solid #262a33;border-radius:6px;padding:2px 6px;font-size:12.5px;color:#e8eaed}</style></head>` +
    `<body><div class="c"><h1>🔒 访问受限</h1>` +
    `<p>当前 IP <code>${escIp}</code> 不在访问白名单内。<br>` +
    `如需放行，请把这台设备的 IP 加进「设置 → 🛡️ 访问白名单」。<br>` +
    `如果就是本机被拦住了，可用浏览器打开本机地址进入设置取消限制。</p></div></body></html>`;
  try {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  } catch { /* ignore */ }
  console.warn(`[ip-guard] 拒绝访问：${remote} ${p}（白名单：${String(list).replace(/\n/g, ' ').slice(0, 120) || '空'}）`);
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    /* IP 白名单 / 访问限制（防扫描器摸到管理接口）：
       设置页「🛡️ 访问白名单」启用后，仅白名单 IP 可访问，其余一律 403。
       loopback 永远放行（否则从 NAS 本机就把自己锁死了）；/api/health 放行供监控探活。 */
    if (!ipGuard(req, res, p)) return;
    // qBittorrent WebUI 代理（/api/v2 是 qBT 的 Web API 前缀，HMP 自己不用它；
    // 必须放在 handleApi 之前，否则 /api/v2/* 会被当成 HMP 的 API 404 掉）
    if (p === '/qbui') { res.writeHead(302, { Location: '/qbui/' }); return res.end(); }
    if (p.startsWith('/qbui/')) return proxyQbit(req, res, p.slice('/qbui'.length) || '/', url.search);
    if (p.startsWith('/api/v2/')) return proxyQbit(req, res, p, url.search);

    // API
    if (p.startsWith('/api/')) return await handleApi(req, res, url);

    // 封面（文件名白名单校验）
    let mm = p.match(/^\/poster\/([\w.-]+)$/);
    if (mm && req.method === 'GET') {
      const name = mm[1];
      if (!POSTER_RE.test(name)) return json(res, 400, { error: '非法文件名' });
      const file = path.join(require('./lib/paths').dirs.posters(), name);
      if (!fs.existsSync(file)) return res.writeHead(404).end();
      return serveFile(res, file, true);
    }

    // 直连播放流
    mm = p.match(/^\/stream\/(\d+)$/);
    if (mm && req.method === 'GET') {
      const row = db.getMedia(parseInt(mm[1], 10));
      if (!row) return json(res, 404, { error: '不存在' });
      if (webdav.isCloudPath(row.path)) {
        // 网盘文件：代理 WebDAV GET，透传 Range（支持拖动进度条）
        const target = await webdav.resolveMediaPath(row.path);
        const fwd = {};
        if (req.headers.range) fwd.Range = req.headers.range;
        const upstream = await webdav.authFetch(target, { headers: fwd });
        if (!upstream.ok && upstream.status !== 206) {
          return json(res, 502, { error: `网盘取流失败（HTTP ${upstream.status}）` });
        }
        const h = { 'Content-Type': upstream.headers.get('content-type') || 'video/mp4', 'Accept-Ranges': 'bytes' };
        for (const k of ['content-length', 'content-range']) {
          const v = upstream.headers.get(k);
          if (v) h[k] = v;
        }
        res.writeHead(upstream.status === 206 ? 206 : 200, h);
        const { Readable } = require('node:stream');
        return Readable.fromWeb(upstream.body).pipe(res);
      }
      if (!fs.existsSync(row.path)) return json(res, 404, { error: '文件已不在磁盘上' });
      return streamFile(req, res, row.path);
    }

    // 转码播放流（可选 start 参数，秒）
    mm = p.match(/^\/transcode\/(\d+)$/);
    if (mm && req.method === 'GET') {
      const row = db.getMedia(parseInt(mm[1], 10));
      if (!row) return json(res, 404, { error: '不存在' });
      let srcPath = row.path;
      let extraArgs = [];
      if (webdav.isCloudPath(row.path)) {
        srcPath = await webdav.resolveMediaPath(row.path);
        /* ★ 这里原来塞了 ['-verify','0']，但现代 ffmpeg 早已移除 -verify 选项，
           会直接 "Unrecognized option 'verify'" 秒退（0 字节）——网盘片源的转码（含预览回退）
           因此 100% 失败。去掉它。 */
        extraArgs = [];
      } else if (!fs.existsSync(row.path)) {
        return json(res, 404, { error: '文件已不在磁盘上' });
      }
      // pv=1：预览用短转码（默认 24 秒）
      const pvSec = url.searchParams.get('pv') === '1' ? 24 : 0;
      return transcodeStream(res, srcPath, parseFloat(url.searchParams.get('start') || '0'), extraArgs, row.width,
        url.searchParams.get('vcopy') === '1', (row.vcodec || '').toLowerCase(), pvSec);
    }

    /* 游戏库同源代理：/romm/xxx → http://127.0.0.1:8098/xxx
       （https 域名下访问也能用，不会被浏览器当混合内容拦） */
    if (p === '/romm') {
      res.writeHead(302, { Location: '/romm/' + (url.search || '') });
      return res.end();
    }
    if (p.startsWith('/romm/')) {
      return proxyRomm(req, res, '/' + p.slice('/romm/'.length), url.search);
    }

    // 静态资源：HTML/JS/CSS 每次打开强制向服务器重验（页面始终最新）；
    // 图片/字体等不可变资源保留长缓存
    if (req.method === 'GET') {
      const rel = p === '/' ? 'index.html' : p.slice(1);
      const file = path.join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR)) return res.writeHead(403).end();
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const immutable = /\.(png|jpe?g|webp|gif|svg|ico|woff2?|ttf|mp4|webm|mkv)$/i.test(rel);
        return serveFile(res, file, immutable);
      }
    }

    // 游戏库内嵌页面里发起的、没带 /romm 前缀的资源请求（SPA 路由 / 落地 Image Source 等）
    if (fromRomm(req)) return proxyRomm(req, res, p, url.search);

    /* 别在这个位置做「无后缀路径 → /romm 前缀」的兜底重定向：RomM 的 SPA 站内跳转
       （/login、/dashboard…）会先被跳到 /romm/login，前端又自己跳回 /login，iframe 里
       就成了无限重定向，页面永远 loading。带 referer 的请求上面已经按原路径代理了。 */
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) json(res, 500, { error: String(e && e.message) });
  }
});


bootstrap();
/* 点赞（全站级，无用户体系）：m:<媒体id> / s:<剧集key>；点赞推高好评（每10赞+0.1，封顶+1.0） */
try { db.run('CREATE TABLE IF NOT EXISTS likes (target TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)'); } catch (e) { console.error('[likes] 建表失败', e.message); }
function likeCount(t) { try { const r = db.get('SELECT n FROM likes WHERE target = ?', [t]); return r ? r.n : 0; } catch { return 0; } }
function likeBoost(t) { return Math.min(likeCount(t) * 0.1, 1); }
/* 目标的加成后评分（hover 同一算法）：点赞接口返回它，前端才能当场看到「点赞效果」 */
function boostedRating(t) {
  try {
    let base = null;
    if (t.startsWith('m:')) { const r = db.get('SELECT rating FROM media_files WHERE id = ?', [Number(t.slice(2))]); base = r ? r.rating : null; }
    else { const r = db.get('SELECT rating FROM series WHERE series_key = ?', [t.slice(2)]); base = r ? r.rating : null; }
    if (base == null) return null;
    return Math.min(10, Math.round((base + likeBoost(t)) * 10) / 10);
  } catch { return null; }
}
/* 详情大窗扩展：演职人员（TMDB credits，内存缓存 24h，刮不到了就空着不显示） */
const ENRICH_CACHE = new Map();
async function castOf(tmdbId, kind) {
  if (!tmdbId || !tmdbMod.enabled()) return [];
  const ck = 'c:' + tmdbId + ':' + kind;
  const hit = ENRICH_CACHE.get(ck);
  if (hit && Date.now() - hit.at < 86400000) return hit.v;
  try {
    const d = await tmdbMod.tmdbGet('/' + kind + '/' + tmdbId + '/credits');
    const v = (((d || {}).cast) || []).slice(0, 6).map((c) => c.name).filter(Boolean);
    ENRICH_CACHE.set(ck, { at: Date.now(), v });
    return v;
  } catch { return []; }
}
/* 「关于」区块：导演（电影 credits.crew）/ 原创人（剧集 detail.created_by），同走 24h 内存缓存 */
async function creatorsOf(tmdbId, kind) {
  if (!tmdbId || !tmdbMod.enabled()) return [];
  const ck = 'cr:' + tmdbId + ':' + kind;
  const hit = ENRICH_CACHE.get(ck);
  if (hit && Date.now() - hit.at < 86400000) return hit.v;
  try {
    let v = [];
    if (kind === 'tv') {
      const d = await tmdbMod.tmdbGet('/tv/' + tmdbId);
      v = (((d || {}).created_by) || []).map((c) => c.name).filter(Boolean).slice(0, 3);
    } else {
      const d = await tmdbMod.tmdbGet('/movie/' + tmdbId + '/credits');
      v = (((d || {}).crew) || []).filter((c) => c.job === 'Director').map((c) => c.name).filter(Boolean).slice(0, 3);
    }
    ENRICH_CACHE.set(ck, { at: Date.now(), v });
    return v;
  } catch { return []; }
}
function dedupeByTmdb(z) { /* 多目录同 TMDB 条目只占一个推荐位，别让「龙族」连占两格 */
  const k = z.x.tmdb_id ? 't' + z.x.tmdb_id : (z.x.official_poster || z.x.poster) ? 'p' + (z.x.official_poster || z.x.poster) : 'k' + (z.x.series_key || z.x.id); /* 繁简双条目同海报也去重 */
  if (dedupeByTmdb._s.has(k)) return false;
  dedupeByTmdb._s.add(k);
  return true;
}
function similarMovies(id, genre) {
  const gset = new Set(String(genre || '').split(/[,，、|/]/).map((g) => g.trim().toLowerCase()).filter(Boolean));
  if (!gset.size) return [];
  dedupeByTmdb._s = new Set();
  try {
    return db.all(
      `SELECT id, tmdb_id, tmdb_title, title, year, duration, rating, genre, overview, official_poster, poster, backdrop FROM media_files
       WHERE kind = 'movie' AND id != ? AND genre IS NOT NULL AND genre != ''`, [id])
      .map((x) => ({ x, n: String(x.genre || '').split(/[,，、|/]/).filter((g) => gset.has(g.trim().toLowerCase())).length }))
      .filter((z) => z.n > 0 && kids.checkMediaId(z.x.id))
      .sort((a, b) => b.n - a.n || (b.x.rating || 0) - (a.x.rating || 0))
      .filter(dedupeByTmdb)
      .slice(0, 30) /* 详情大窗：默认展示 9 部 + ⌄ 展开全部，后端放宽到 30 */
      .map(({ x }) => ({ kind: 'movie', id: x.id, title: x.tmdb_title || x.title, year: x.year, duration: x.duration, rating: x.rating, overview: x.overview, poster: x.official_poster || x.poster, backdrop: x.backdrop }));
  } catch { return []; }
}
function similarSeries(key, genre, selfPoster) { /* selfPoster：当前剧的海报 —— 繁简孪生条目同海报，不能推荐给正在看它的人 */
  const gset = new Set(String(genre || '').split(/[,，、|/]/).map((g) => g.trim().toLowerCase()).filter(Boolean));
  if (!gset.size) return [];
  dedupeByTmdb._s = new Set();
  try {
    return db.all(
      `SELECT series_key, tmdb_id, tmdb_title, title, year, rating, genre, overview, episode_count, official_poster, poster, backdrop FROM series
       WHERE series_key != ? AND genre IS NOT NULL AND genre != ''`, [key])
      .map((x) => ({ x, n: String(x.genre || '').split(/[,，、|/]/).filter((g) => gset.has(g.trim().toLowerCase())).length }))
      .filter((z) => z.n > 0 && (z.x.episode_count || 0) > 1 && !(selfPoster && (z.x.official_poster || z.x.poster) === selfPoster)) /* 质量闸：单集假剧不进推荐（同 Hero 的剔假剧逻辑） */
      .sort((a, b) => b.n - a.n || (b.x.rating || 0) - (a.x.rating || 0))
      .filter(dedupeByTmdb)
      .slice(0, 15) /* 详情大窗：剧集默认 3 部 + ⌄ 展开全部 */
      .map(({ x }) => ({ kind: 'series', series_key: x.series_key, title: x.tmdb_title || x.title, year: x.year, duration: null, episode_count: x.episode_count, rating: x.rating, overview: x.overview, poster: x.official_poster || x.poster, backdrop: x.backdrop }));
  } catch { return []; }
}
// OTA 重启交接：新进程先起、旧进程 800ms 后才退出，端口可能未释放 —— EADDRINUSE 时自动重试（最多 6 次 × 5 秒）
let listenRetries = 0;
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE' && listenRetries < 6) {
    listenRetries++;
    console.log(`[启动] 端口 ${PORT} 暂被占用（升级交接中？）5 秒后重试（${listenRetries}/6）`);
    setTimeout(() => { try { server.listen(PORT, HOST); } catch (e2) { console.error('[启动] 重试失败', e2.message); } }, 5000);
  } else {
    console.error('[启动] 服务监听失败:', e && e.message);
    process.exit(1);
  }
});
server.listen(PORT, HOST, () => {
  console.log(`家庭娱乐中心 Web 版已启动: http://localhost:${PORT}`);
  // 定时自动扫描：默认每 6 小时巡检一次新入库文件（HMP_SCAN_INTERVAL_HOURS=0 关闭），
  // 扫完 startScan 内已自动串增量刮削（含搜索名清洗重试），新片无需人工干预
  const scanHours = Number(process.env.HMP_SCAN_INTERVAL_HOURS === undefined ? 6 : process.env.HMP_SCAN_INTERVAL_HOURS);
  if (scanHours > 0 && Number.isFinite(scanHours)) {
    setInterval(() => {
      if (scanState.running) return;
      console.log(`[自动扫描] 定时巡检（每 ${scanHours} 小时）`);
      try { startScan(); } catch (e) { console.error('[自动扫描] 失败', e && e.message); }
    }, scanHours * 3600 * 1000);
    console.log(`定时自动扫描已启用：每 ${scanHours} 小时一次`);
  } else {
    console.log('定时自动扫描未启用（HMP_SCAN_INTERVAL_HOURS=0）');
  }

  // 启动后自动扫描一次（发现新入库文件），默认开启，HMP_SCAN_ON_START=0 关闭
  if (process.env.HMP_SCAN_ON_START !== '0') {
    setTimeout(() => {
      if (scanState.running) return;
      console.log('[自动扫描] 启动后巡检新入库文件');
      try { startScan(); } catch (e) { console.error('[自动扫描] 启动巡检失败', e && e.message); }
    }, 120 * 1000);
  }

  // 图库缩略图后台预热：缺图的相册首次浏览会逐张生成（限并发，不阻塞前台），
  // 启动 3 分钟后在后台按拍摄时间倒序补齐，避免用户翻到冷门相册时加载缓慢
  if (process.env.HMP_WARM_THUMBS !== '0') {
    setTimeout(() => {
      photos.libWarmThumbs({ onEvent: (s) => console.log('[缩略图预热] ' + s) })
        .catch((e) => console.error('[缩略图预热] 失败', e && e.message));
    }, 180 * 1000);
  }

  // 启动自愈：重跑解析规则（修正 S01E02.mp4 这类归组）→ 新剧集/缺海报自动刮削补齐
  setTimeout(() => {
    try {
      try {
        const rr = scanner.reclassifyAll();
        if (rr && rr.updated) console.log(`启动重识别：更新 ${rr.updated} 条`);
      } catch { /* 重识别失败不阻塞 */ }
      if (!tmdbMod.enabled() || tmdbMod.scrapeState.running) return;
      const missMovies = db.get(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM media_files
         WHERE tmdb_id IS NOT NULL AND (official_poster IS NULL OR official_poster = '')
         GROUP BY tmdb_id)`);
      const missSeries = db.get(
        `SELECT COUNT(*) AS n FROM series
         WHERE tmdb_id IS NOT NULL AND (official_poster IS NULL OR official_poster = '')`);
      const targets = tmdbMod.collectTargets();
      const total = (missMovies ? missMovies.n : 0) + (missSeries ? missSeries.n : 0)
        + targets.movies.length + targets.series.length;
      if (total > 0) {
        console.log(`启动自愈：${targets.movies.length} 部电影、${targets.series.length} 部剧集待刮，缺海报 ${total - targets.movies.length - targets.series.length} 组，后台自动处理…`);
        tmdbMod.scrapeAll({ onEvent: (e) => console.log(`[自愈刮削] ${e && e.message}`) })
          .catch(() => {});
      }
    } catch { /* 自愈失败不影响服务 */ }
  }, 30000);
  console.log(`数据目录: ${require('./lib/paths').dataRoot()}`);
  try { perf.ensureProbed(); } catch { /* 体检失败不影响服务 */ } // 启动后台转码体检（30 天缓存）
  console.log(`ffprobe: ${bins.status().ffprobe || '未找到'}`);
  console.log(`ffmpeg:  ${bins.status().ffmpeg || '未找到'}`);
});
