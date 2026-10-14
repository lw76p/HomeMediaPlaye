'use strict';
// 网盘接入：标准 WebDAV 协议（Alist 的 /dav、坚果云、InfiniCloud、Nextcloud 等通用）
// 配置：WebDAV 地址（如 http://192.168.1.10:5244/dav）+ 用户名 + 密码（Basic Auth）
// 能力：配置测试 / 远程目录浏览 / 递归扫描入库 / 探测与封面 / 直链播放
// 约定：媒体文件 path 以 `webdav:` 前缀存储；兼容历史 `alist:` 前缀（远端路径语义一致）
const db = require('./db');
const parse = require('./parse');
const probe = require('./probe');
const bins = require('./binaries');
const { dirs } = require('./paths');
const fs = require('node:fs');
const path = require('node:path');

const CFG_KEY = 'webdavConfig';
const PREFIX = 'webdav:';

function cfg() {
  let c = db.getSetting(CFG_KEY, null);
  if (!c && process.env.HMP_WEBDAV_URL) {
    c = {
      url: process.env.HMP_WEBDAV_URL,
      username: process.env.HMP_WEBDAV_USER || '',
      password: process.env.HMP_WEBDAV_PASS || '',
    };
  }
  return c;
}

function encodePath(remotePath) {
  const p = remotePath || '/';
  return ('/' + p.split('/').filter(Boolean).map(encodeURIComponent).join('/')).replace(/\/+$/, '') || '/';
}

function authHeader() {
  const c = cfg();
  if (!c || !c.username) return null;
  return 'Basic ' + Buffer.from(c.username + ':' + (c.password || ''), 'utf8').toString('base64');
}

async function davRequest(remotePath, { method = 'PROPFIND', depth = '1', body, timeoutMs = 20000, extraHeaders = {} } = {}) {
  const c = cfg();
  if (!c || !c.url) throw new Error('未配置 WebDAV 服务器地址');
  const base = c.url.replace(/\/+$/, '');
  const target = base + encodePath(remotePath);
  const headers = { ...extraHeaders };
  const auth = authHeader();
  if (auth) headers.Authorization = auth;
  if (depth != null) headers.Depth = depth;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(target, { method, headers, body, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- 207 Multi-Status 解析（零依赖，兼容任意命名空间前缀） ---------------- */

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagRe(name) {
  return new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_.-]+:)?${name}>`, 'i');
}

function parseMultistatus(xml) {
  const out = [];
  const re = /<(?:[A-Za-z0-9_.-]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?response>/gi;
  for (const block of xml.match(re) || []) {
    const hm = block.match(tagRe('href'));
    if (!hm) continue;
    let href = decodeEntities(hm[1].trim());
    try { href = decodeURIComponent(href); } catch { /* 保留原样 */ }
    const isDir =
      /<(?:[A-Za-z0-9_.-]+:)?collection\b[^>]*\/?>/i.test(block) ||
      tagRe('collection').test(block);
    const sm = block.match(tagRe('getcontentlength'));
    const size = sm ? parseInt(String(sm[1]).trim(), 10) || 0 : 0;
    const mm = block.match(tagRe('getlastmodified'));
    const mtime = mm ? (Date.parse(String(mm[1]).trim()) || 0) : 0;
    const name = decodeURIComponent((href.replace(/\/+$/, '').split('/').pop() || ''));
    out.push({ href, name, isDir, is_dir: isDir, size, modified: mtime ? new Date(mtime).toISOString() : null });
  }
  return out;
}

/* ---------------- 配置 ---------------- */

async function saveConfig({ url, username, password } = {}) {
  if (!url) throw new Error('缺少 WebDAV 服务器地址');
  const normalized = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(normalized)) throw new Error('地址需以 http:// 或 https:// 开头');
  db.setSetting(CFG_KEY, { url: normalized, username: (username || '').trim(), password: password || '' });
  try {
    const res = await davRequest('/', { method: 'PROPFIND', depth: '0', timeoutMs: 12000 });
    if (res.status === 207 || res.status === 200) {
      return { ok: true, server: normalized };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: '用户名或密码错误（HTTP 401）' };
    }
    return { ok: false, error: `服务器响应异常（HTTP ${res.status}），请确认地址是 WebDAV 入口（Alist 通常为 http://主机:5244/dav）` };
  } catch (e) {
    return { ok: false, error: '连接失败：' + e.message };
  }
}

function getConfig() {
  const c = cfg();
  return {
    configured: !!c,
    url: c ? c.url : null,
    hasAuth: !!(c && c.username),
  };
}

/* ---------------- 目录浏览 / 递归遍历 ---------------- */

async function listDir(remotePath = '/') {
  const c = cfg();
  if (!c || !c.url) throw new Error('未配置 WebDAV 服务器地址');
  const res = await davRequest(remotePath, { method: 'PROPFIND', depth: '1' });
  if (res.status === 401 || res.status === 403) throw new Error('认证失败（HTTP 401），请检查用户名/密码');
  if (res.status !== 207 && res.status !== 200) throw new Error(`目录不存在或服务器错误（HTTP ${res.status}）`);
  const xml = await res.text();
  // 服务器返回的 href 是含 base 路径的全路径（如 /dav/电影/xx.mp4），过滤 self 时需对齐
  const basePath = new URL(c.url.replace(/\/+$/, '')).pathname.replace(/\/+$/, '');
  const self = (basePath + encodePath(remotePath)).replace(/\/+$/, '');
  // href 形态因服务器而异（有的已解码、有的保持编码）——self 过滤两侧都按解码后比对，
  // 否则目录自身没被滤掉会被 walk 当子目录递归，同层文件重复计入直到 MAX_DEPTH（ge 轮实测踩坑）
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const selfDec = dec(self);
  const entries = parseMultistatus(xml).filter((e) => {
    const h = (e.href || '').replace(/\/+$/, '');
    return h !== self && dec(h) !== selfDec;
  });
  return entries;
}

const MAX_DEPTH = 8;

async function mapLimit(items, limit, worker) {
  const results = [];
  let index = 0;
  const runners = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch {
        results[i] = null;
      }
    }
  });
  await Promise.all(runners);
  return results;
}

async function walk(remoteDir, out, audios, depth = 0) {
  // BFS 分层并发遍历：每个目录一次 PROPFIND 网络往返，串行是网盘扫描最慢的一环
  const MAX_D = MAX_DEPTH;
  const LIMIT = 4;
  let layer = [{ dir: remoteDir, depth }];
  while (layer.length) {
    const next = [];
    const runners = new Array(Math.min(LIMIT, layer.length)).fill(0).map(async () => {
      while (layer.length) {
        const item = layer.shift();
        if (item.depth > MAX_D) continue;
        let entries;
        try {
          entries = await listDir(item.dir);
        } catch {
          continue;
        }
        for (const ent of entries || []) {
          const p = (item.dir === '/' ? '' : item.dir) + '/' + ent.name;
          if (ent.isDir) {
            if (parse.shouldIgnoreDir(ent.name)) continue;
            next.push({ dir: p, depth: item.depth + 1 });
          } else if (parse.isVideo(ent.name)) {
            out.push({ remotePath: p, size: ent.size || 0, mtime: ent.modified ? Date.parse(ent.modified) || 0 : 0 });
          } else if (audios && parse.isAudio(ent.name)) {
            audios.push({ remotePath: p, size: ent.size || 0 });
          }
        }
      }
    });
    await Promise.all(runners);
    layer = next;
  }
}

/* ---------------- 播放直链（凭据内嵌 URL，mpv / ffmpeg / fetch 均可直接打开） ---------------- */

function directUrl(remotePath) {
  const c = cfg();
  if (!c || !c.url) throw new Error('未配置 WebDAV 服务器地址');
  const u = new URL(c.url.replace(/\/+$/, '') + encodePath(remotePath));
  let s = u.toString();
  if (c.username) {
    s = `${u.protocol}//${encodeURIComponent(c.username)}:${encodeURIComponent(c.password || '')}@${u.host}${u.pathname}${u.search}`;
  }
  return s;
}

// 把 WebDAV 地址解析为「可直接拉流」的真实直链。
// 阿里云盘等服务对 GET 会返回 302 跳转到预签名的 CDN 地址；ffmpeg/mpv 对
// 带凭据 URL 的跳转处理不稳定（表现为 EOF），因此统一先解析出直链再交给它们。
async function resolveDirect(remotePathOrUrl) {
  const url = /^https?:\/\//i.test(remotePathOrUrl)
    ? remotePathOrUrl
    : directUrl(remotePathOrUrl);
  try {
    const res = await authFetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      redirect: 'manual',
    });
    try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch { /* ignore */ }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc) return new URL(loc, url).toString();
    }
  } catch { /* 解析失败则退回原地址 */ }
  return url;
}

async function resolveMediaPath(localPathField) {
  // 形如 webdav:/media/xxx.mp4（兼容历史 alist:/media/xxx.mp4）→ WebDAV 直链
  const remotePath = localPathField.replace(/^(webdav|alist):/, '');
  return resolveDirect(remotePath);
}

// Node fetch（undici）不接受带凭据的 URL；此辅助把凭据转为 Authorization 头
function authFetch(url, init = {}) {
  const headers = { ...(init.headers || {}) };
  const auth = authHeader();
  if (auth) headers.Authorization = auth;
  const u = new URL(url);
  u.username = '';
  u.password = '';
  return fetch(u.toString(), { ...init, headers });
}

function isCloudPath(p) {
  return typeof p === 'string' && (p.startsWith(PREFIX) || p.startsWith('alist:'));
}

// 拉取远程文件内容（字幕等小文件；先解析 302 直链再 GET）
async function fetchBuffer(remotePath) {
  const direct = await resolveDirect(remotePath);
  const res = await authFetch(direct);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// 拉取远程文件并落盘（返回是否成功且非空）
async function fetchToFile(remotePath, outPath) {
  try {
    const buf = await fetchBuffer(remotePath);
    if (!buf || !buf.length) return false;
    fs.writeFileSync(outPath, buf);
    return true;
  } catch {
    return false;
  }
}

// 上传小文件（网络搜到的字幕写回影片同目录用）。注意：PUT 不走 302 直链解析——
// 上传必须落在 OpenList 本体（由它转存网盘），跳去 CDN 直链反而会 405/403。
async function putFile(remotePath, buf) {
  const url = directUrl(remotePath);
  const headers = { 'Content-Type': 'application/octet-stream' };
  const auth = authHeader();
  if (auth) headers.Authorization = auth;
  const res = await fetch(url, { method: 'PUT', headers, body: buf, signal: AbortSignal.timeout(120000) });
  try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch { /* ignore */ }
  if (!res.ok && res.status !== 201) throw new Error(`WebDAV 上传失败（HTTP ${res.status}）`);
  return true;
}

/* ---------------- 远程探测 / 封面（URL 直连，跳过严格 TLS 校验） ---------------- */

async function probeRemote(remotePathOrUrl, directUrlPre = null) {
  const ffprobe = bins.status().ffprobe;
  if (!ffprobe) return { ok: false, reason: 'ffprobe 未就绪' };
  const rawUrl = directUrlPre || (await resolveDirect(remotePathOrUrl));
  const res = await probe.run(ffprobe, [
    '-v', 'error',
    '-print_format', 'json', '-show_format', '-show_streams',
    rawUrl,
  ], { timeout: 90000 });
  if (!res.ok || !res.stdout) return { ok: false, reason: (res.stderr || 'ffprobe 失败').slice(0, 200) };
  let data;
  try { data = JSON.parse(res.stdout); } catch { return { ok: false, reason: 'ffprobe 输出无法解析' }; }
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic === 1))
    || streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const fmt = data.format || {};
  let duration = parseFloat(fmt.duration);
  if (!Number.isFinite(duration) && v && v.duration) duration = parseFloat(v.duration);
  return {
    ok: true,
    duration: Number.isFinite(duration) ? duration : null,
    width: v ? v.width ?? null : null,
    height: v ? v.height ?? null : null,
    vcodec: v ? v.codec_name ?? null : null,
    acodec: a ? a.codec_name ?? null : null,
  };
}

async function posterRemote(remotePathOrUrl, fileKey, directUrlPre = null) {
  const ffmpeg = bins.status().ffmpeg;
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg 未就绪' };
  const rawUrl = directUrlPre || (await resolveDirect(remotePathOrUrl));
  const name = posterNameFor(fileKey);
  const outPath = require('node:path').join(dirs.posters(), name);
  for (const ss of [8, 30, 3, 1]) {
    await probe.run(
      ffmpeg,
      ['-nostdin', '-hide_banner', '-loglevel', 'error', '-verify', '0',
        '-ss', String(ss), '-i', rawUrl,
        '-frames:v', '1', '-vf', 'scale=640:-2:flags=lanczos,format=yuv420p', '-q:v', '4', '-y', outPath],
      { timeout: 45000 }
    );
    try {
      const st = require('node:fs').statSync(outPath);
      if (st.size > 1024) return { ok: true, file: name };
    } catch { /* 下一个时间点 */ }
  }
  return { ok: false, reason: '抽帧失败' };
}

// 与桌面/本地封面命名规则保持一致（POSTER 版本 v1，正则白名单可命中）
const crypto = require('node:crypto');
function posterNameFor(key) {
  const h = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  return `${h}-v1.jpg`;
}

/* ---------------- 网盘媒体库扫描 ---------------- */

async function scanWebdavRoot(root, { onEvent = () => {} } = {}) {
  const started = Date.now();
  onEvent({ phase: 'walking', message: `正在遍历网盘 ${root.path}` });
  const files = [];
  const audios = [];
  await walk(root.path, files, audios);
  onEvent({ phase: 'walked', message: `网盘发现 ${files.length} 个视频文件${audios.length ? '、' + audios.length + ' 个音频文件' : ''}` });

  // 网盘音乐镜像：音频下载到本地缓存并入音乐库（音乐中心自动显示，播放/封面/标签全走本地链路）
  try {
    const mm = await mirrorMusic(audios, onEvent);
    if (mm.fresh) onEvent({ phase: 'music', message: `网盘音乐镜像完成：新增 ${mm.fresh} / 共 ${mm.mirrored}，失败 ${mm.failed}` });
  } catch (e) {
    onEvent({ phase: 'music-err', message: '网盘音乐镜像失败：' + e.message });
  }

  // 保护：walk 成功但 0 个文件（网络抖动/授权过期/网盘服务不可达）时，
  // 绝不清空该 root 已有记录——否则一次瞬时故障就把整盘内容清光（2026-09-23 实测踩坑）
  if (!files.length) {
    const have = db.get('SELECT COUNT(*) AS n FROM media_files WHERE root_id = ?', [root.id]);
    if (have && have.n > 0) {
      onEvent({ phase: 'kept', message: `网盘本次未发现任何文件（疑似网络或授权异常），保留已有 ${have.n} 条记录，跳过清理` });
      return { added: 0, kept: have.n, elapsedMs: Date.now() - started };
    }
  }
  const stamp = Date.now();
  let added = 0;
  let stale = [];
  // 入库 + 清理走单事务：网络扫描本身慢，别再让逐条落盘雪上加霜
  db.withTransaction(() => {
    for (const f of files) {
      // 兼容历史 alist: 前缀：已存在的记录沿用原键，避免重复入库/丢失进度
      const existing = db.findByPath(PREFIX + f.remotePath) || db.findByPath('alist:' + f.remotePath);
      const key = existing ? existing.path : PREFIX + f.remotePath;
      // dirName 必传：纯 SxxExx 文件名（如 S01E02.mp4）要用上级目录名当剧名，
      // 否则每集各自成"剧"，首页/全部影片整页重复（2026-09-19 网盘实测踩坑）
      const parsed = parse.parseName(require('node:path').basename(f.remotePath), {
        dirName: require('node:path').basename(require('node:path').dirname(f.remotePath)),
      });
      if (existing && existing.size === f.size && existing.mtime === f.mtime) {
        db.run('UPDATE media_files SET last_seen_at = ? WHERE id = ?', [stamp, existing.id]);
        continue;
      }
      db.upsertFile({
        rootId: root.id,
        path: key,
        dir: require('node:path').dirname(f.remotePath),
        fileName: require('node:path').basename(f.remotePath),
        ext: parsed.ext,
        size: f.size,
        mtime: Math.floor(f.mtime / 1000),
        title: parsed.title,
        year: parsed.year,
        season: parsed.season,
        episode: parsed.episode,
        kind: parsed.kind,
        seriesKey: parsed.seriesKey,
      }, stamp);
      if (!existing) added += 1;
    }
    // 清理远端已删除的
    stale = db.all('SELECT id FROM media_files WHERE root_id = ? AND last_seen_at <> ?', [root.id, stamp]);
    for (const s of stale) db.run('DELETE FROM watch_progress WHERE media_id = ?', [s.id]);
    db.run('DELETE FROM media_files WHERE root_id = ? AND last_seen_at <> ?', [root.id, stamp]);
    db.touchRoot(root.id);
  });

  // 探测 + 封面：小并发（2）+ 每个文件只解析一次直链，探测与封面共用（省一半 302 往返）
  // 待处理 = 未探测元数据 或 已探测但缺封面（两者都要在这轮补齐）
  const rows = db.all(
    `SELECT id, path, duration, kind, probed_at, poster FROM media_files
     WHERE root_id = ? AND (probed_at IS NULL OR poster IS NULL) LIMIT 500`,
    [root.id]
  );
  let probed = 0;
  let painted = 0;
  const tasks = rows.map((row) => ({ row, remotePath: row.path.replace(/^(webdav|alist):/, '') }));
  await mapLimit(
    tasks,
    2,
    async ({ row, remotePath }) => {
      try {
        const direct = await resolveDirect(remotePath).catch(() => null);
        if (!row.probed_at) {
          const info = await probeRemote(remotePath, direct);
          if (info.ok) {
            const kind = info.duration && info.duration > 3600 ? 'movie'
              : (parse.parseName(require('node:path').basename(remotePath), {
                  dirName: require('node:path').basename(require('node:path').dirname(remotePath)),
                }).kind === 'episode' ? 'episode' : (info.duration ? 'short' : row.kind));
            db.run(
              `UPDATE media_files SET duration=?, width=?, height=?, vcodec=?, acodec=?, kind=?, probed_at=? WHERE id=?`,
              [info.duration, info.width, info.height, info.vcodec, info.acodec, kind, Date.now(), row.id]
            );
            probed += 1;
          }
        }
        if (!row.poster) {
          const poster = await posterRemote(remotePath, row.path, direct);
          if (poster.ok) {
            db.setPoster(row.id, poster.file);
            painted += 1;
          }
        }
      } catch {
        /* 单文件失败不影响整体 */
      }
      onEvent({ phase: 'probing', message: `网盘处理 ${probed + painted}/${rows.length}（已探测 ${probed}，已出封面 ${painted}）` });
    }
  );
  db.rebuildSeries();

  return {
    ok: true,
    rootId: root.id,
    elapsedMs: Date.now() - started,
    added,
    removed: stale.length,
    probed,
    stats: db.countByKind(),
  };
}

/* ---------------- 网盘音乐镜像（自动进音乐中心） ----------------
   网盘里的音频文件下载到本地缓存目录（按 WebDAV 主机分桶、保留远程相对路径结构），
   缓存目录挂进音乐库 roots —— 播放/封面/标签/歌单全部走现有本地链路，音乐中心直接显示。
   跳过：已存在且同大小（视为已镜像）、超大 >100MB、过小 <100KB、下载失败。 */
const MUSIC_MAX_BYTES = 100 * 1024 * 1024;
const MUSIC_MIN_BYTES = 100 * 1024;
function musicMirrorDir() {
  const c = cfg();
  const host = c && c.url ? String(c.url).replace(/^https?:\/\//i, '').split('/')[0] : 'webdav';
  const key = crypto.createHash('md5').update(host).digest('hex').slice(0, 10);
  const dir = path.join(dirs.root(), 'webdav-music', key);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
async function mirrorMusic(audios, onEvent = () => {}) {
  const list = audios || [];
  const ok = { mirrored: 0, fresh: 0, skipped: 0, failed: 0 };
  if (!list.length) return ok;
  const music = require('./music'); // 延迟加载避免循环依赖
  const base = musicMirrorDir();
  for (const a of list) {
    const rel = String(a.remotePath || '').replace(/^\/+/, '');
    if (!rel) continue;
    if (a.size && (a.size > MUSIC_MAX_BYTES || a.size < MUSIC_MIN_BYTES)) { ok.skipped++; continue; }
    const dest = path.join(base, rel);
    try {
      if (fs.existsSync(dest) && a.size && fs.statSync(dest).size === a.size) { ok.mirrored++; continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const done = await fetchToFile(a.remotePath, dest);
      if (!done) { ok.failed++; try { fs.unlinkSync(dest); } catch {} continue; }
      ok.mirrored++; ok.fresh++;
      if (ok.fresh % 20 === 0) onEvent({ phase: 'music', message: `网盘音乐镜像中：已下载 ${ok.fresh} 首…` });
    } catch (e) { ok.failed++; }
  }
  if (ok.fresh) {
    try {
      music.addRoot(base, '☁️ 网盘音乐');
      await music.scanAll({ onEvent: (m) => onEvent({ phase: 'music', message: String(m) }) });
    } catch (e) { onEvent({ phase: 'music-err', message: '音乐库刷新失败：' + e.message }); }
  }
  return ok;
}

/* ---------------- gn: 网盘桥接（OpenList）探测 ----------------
 * 同级 openlist/ 目录由 install-openlist.sh / install-windows.js 装出来：
 *   openlist/.env 里有 OPENLIST_PORT / OPENLIST_ADMIN_USER / OPENLIST_ADMIN_PASS
 * 探测方式：对候选端口 GET /ping，HTTP 200 且 body 含 pong → 桥接在跑。
 * 密码只认「本机安装」（.env 与端口都对得上）才返回；否则只报端口。
 *
 * go+++：同机可能装两套（生产 HMP-APP/openlist 用 5245、测试 HMP-TEST/openlist
 * 用 5244）。本函数只认**自己目录**的 .env —— 端口对上了才叫「本机桥接」；
 * 探到的是别目录的实例时报 source:'other'，前端只提示、不给账号密码，
 * 更不能拿它的一键填入去覆盖用户真实配置。
 */
async function probeBridge() {
  const out = {
    running: false, port: null, user: '', pass: '', source: '',
    /* 便于前端展示：是否本目录实例 / 是否已初始化出存储 */
    own: false,
    /* 管理页根地址（不含 /dav）。**必须无条件存在**，否则前端 b.url 是 undefined。
       用 NAS 局域网 IP —— 前端若拿 location.hostname 拼，走域名/反代访问时会得到
       域名，而 OpenList 端口是直连的，域名解析不到该端口。 */
    url: '',
  };
  let envKv = null;
  try {
    const txt = fs.readFileSync(path.join(__dirname, '..', '..', 'openlist', '.env'), 'utf8');
    const kv = {};
    String(txt).split(/\r?\n/).forEach((l) => {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l);
      if (m) kv[m[1]] = m[2].replace(/^"+|"+$/g, '').trim();
    });
    if (kv.OPENLIST_PORT) envKv = kv;
  } catch { /* 没装网盘桥接，正常 */ }

  const ports = [];
  if (envKv && envKv.OPENLIST_PORT) ports.push(Number(envKv.OPENLIST_PORT));
  for (const p of [5244, 5245, 5246, 5247, 5248, 5249, 5250, 5251, 5252, 5253, 5254, 5255]) {
    if (!ports.includes(p)) ports.push(p);
  }
  for (const port of ports) {
    const hit = await new Promise((resolve) => {
      let done = false;
      let req;
      try {
        req = require('node:http').get(
          { host: '127.0.0.1', port, path: '/ping', timeout: 700 },
          (res) => {
            let b = '';
            res.on('data', (c) => { b += c; if (b.length > 4096) res.destroy(); });
            res.on('end', () => { if (!done) { done = true; resolve(/pong/.test(b) ? port : 0); } });
            res.on('error', () => { if (!done) { done = true; resolve(0); } });
          }
        );
      } catch { if (!done) { done = true; resolve(0); } return; }
      req.on('timeout', () => { req.destroy(); if (!done) { done = true; resolve(0); } });
      req.on('error', () => { if (!done) { done = true; resolve(0); } });
    });
    if (hit) {
      out.running = true;
      out.port = hit;
      if (envKv && Number(envKv.OPENLIST_PORT) === hit) {
        out.user = envKv.OPENLIST_ADMIN_USER || 'admin';
        out.pass = envKv.OPENLIST_ADMIN_PASS || '';
        out.source = 'env';
        out.own = true;
      } else {
        // 端口上确实有 OpenList，但不是本目录装的（同机另一套）——只报端口
        out.source = 'other';
      }
      break;
    }
  }
  if (out.running && out.port) out.url = bridgeBaseUrl(out.port);
  return out;
}

/* 网盘管理页根地址（不含 /dav）。与 openlist.js 的 lanIp() 同样的优选规则：
   排除 docker0 等虚拟网卡，私网段 192.168 > 10. > 172.16-31。 */
const VIF = /^(docker|lxcbr|lxdbr|virbr|veth|br-|tailscale|zt|tun|tap|wg|utun|awdl|vmnet|vboxnet|ham)/i;
function bridgeBaseUrl(port) {
  let ip = '';
  try {
    const nis = require('node:os').networkInterfaces();
    const cands = [];
    for (const name of Object.keys(nis)) {
      if (VIF.test(name)) continue;
      for (const a of nis[name] || []) {
        if (a.family === 'IPv4' && !a.internal) cands.push(a.address);
      }
    }
    const rank = (x) => (/^192\.168\./.test(x) ? 0 : /^10\./.test(x) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(x) ? 2 : 3);
    cands.sort((a, b) => rank(a) - rank(b));
    ip = cands[0] || '';
  } catch { /* 拿不到就用回环 */ }
  return 'http://' + (ip || '127.0.0.1') + ':' + port;
}
module.exports = {
  saveConfig, getConfig, listDir, walk, mirrorMusic,
  directUrl, resolveDirect, resolveMediaPath, isCloudPath, authFetch,
  fetchBuffer, fetchToFile, putFile,
  encodePath, parseMultistatus,
  probeRemote, posterRemote, posterNameFor,
  scanWebdavRoot, probeBridge,
};
