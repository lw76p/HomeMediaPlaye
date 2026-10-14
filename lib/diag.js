'use strict';
/* 网络与系统自诊断 + 一键修复（A3）
 * ---------------------------------------------------------------
 * 设计原则：纯本机探针、零外部依赖、不写业务数据。
 *  - run()  只读巡检，返回逐项 {key,label,level,detail,fix?}；level: ok / warn / bad
 *  - fix()  只做「安全可逆」动作（刷新运行时探测 / 重探网盘桥接 / 清临时缓存）
 *           绝不删媒体文件、绝不改用户配置。
 * 口径与既有模块一致：
 *  - 局域网 IP 排除 docker / br- / veth / tailscale / utun / lo 等虚拟网卡，私网 192.168 优先（同 qbit/openlist）
 *  - ffmpeg 必须用 HMP 自带 runtime（系统 /usr/bin/ffmpeg 是 QNAP 残废版）
 *  - 组播/运营商 IPTV 需外部网关：HMP 不自带，如实告知而不是假装支持
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');

const db = require('./db');
const bins = require('./binaries');
const asr = require('./asr');
const webdav = require('./webdav');
const livetv = require('./livetv');
const { dataRoot } = require('./paths');

const ok = (key, label, detail) => ({ key, label, level: 'ok', detail: String(detail || '') });
const warn = (key, label, detail, fix) => ({ key, label, level: 'warn', detail: String(detail || ''), fix: fix || null });
const bad = (key, label, detail, fix) => ({ key, label, level: 'bad', detail: String(detail || ''), fix: fix || null });

/* ---------------- 小工具 ---------------- */

function lanIps() {
  const out = [];
  const nis = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nis || {})) {
    if (!addrs) continue;
    if (/^(docker|br-|veth|tailscale|lo$|utun|vmnet|vboxnet|zerotier)/i.test(name)) continue;
    for (const a of addrs) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      out.push({ name, addr: a.address });
    }
  }
  /* 私网 192.168 排最前（家里网络），其次 10./172. */
  const rank = (x) => (/^192\.168\./.test(x.addr) ? 0 : /^10\./.test(x.addr) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(x.addr) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

function tcpAlive(port, host = '127.0.0.1', ms = 1200) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch { /* ignore */ } resolve(v); } };
    const timer = setTimeout(() => fin(false), ms);
    s.once('connect', () => { clearTimeout(timer); fin(true); });
    s.once('error', () => { clearTimeout(timer); fin(false); });
    try { s.connect(port, host); } catch { clearTimeout(timer); fin(false); }
  });
}

async function httpProbe(url, ms = 7000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'home-media-player diag', Accept: 'application/json' } });
    return { reach: true, status: r.status };
  } catch (e) {
    return { reach: false, error: String((e && e.message) || e).slice(0, 140) };
  }
}

function diskOf(p) {
  try {
    const st = fs.statfsSync(p);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    const usedPct = st.blocks ? Math.round((1 - st.bavail / st.blocks) * 100) : null;
    return { total, free, usedPct };
  } catch { return null; }
}

/* 缓存目录体积（限深 3 层 + 4000 文件上限，避免大目录把体检卡住） */
async function dirSize(dir, depth = 3) {
  let total = 0;
  let files = 0;
  const walk = async (d, lv) => {
    if (lv > depth || files > 4000) return;
    let ents = [];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (files > 4000) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (/^(posters|backdrops)$/i.test(e.name)) continue; await walk(p, lv + 1); }
      else {
        try { const st = await fsp.stat(p); total += st.size; files++; } catch { /* ignore */ }
      }
    }
  };
  await walk(dir, 0);
  return total;
}

/* ---------------- 巡检 ---------------- */

async function run() {
  const items = [];
  const host = { platform: os.platform(), arch: os.arch(), node: process.version, uptime: Math.round(process.uptime()) };

  /* —— 运行时 —— */
  const b = bins.status();
  items.push(b.ready
    ? ok('bins', '媒体运行时（转码/抽帧/字幕转换）', 'ffmpeg + ffprobe 就绪')
    : bad('bins', '媒体运行时（转码/抽帧/字幕转换）', `缺少 ${(b.missing || []).join(' / ')} —— 播放、封面、AI 字幕都依赖它`, 'reset-bins'));
  const asrSt = asr.status();
  items.push(asrSt.ready
    ? ok('asr', 'AI 字幕引擎（whisper）', `就绪，当前模型 ${asrSt.model || '默认'}`)
    : bad('asr', 'AI 字幕引擎（whisper）', 'whisper 运行时或模型缺失 —— AI 字幕、AI 助理不可用'));
  const mem = (os.totalmem() / 1073741824).toFixed(1);
  const load = (os.loadavg()[0] || 0).toFixed(2);
  items.push(ok('runtime', '运行环境', `Node ${process.version} · ${os.platform()} ${os.arch()} · 内存 ${mem}GB · 负载 ${load} · 已运行 ${Math.round(host.uptime / 60)} 分钟`));

  /* —— 媒体库与磁盘 —— */
  const stats = db.countByKind();
  const roots = db.listRoots();
  items.push(roots.length
    ? ok('roots', '媒体目录', `${roots.length} 个目录 · 电影 ${stats.movie} / 剧集 ${stats.episode} / 合计 ${stats.total}`)
    : bad('roots', '媒体目录', '还没添加任何媒体目录 —— 去「📂 网盘与本地目录」加一个（本地路径或网盘）'));
  const dd = diskOf(dataRoot());
  if (dd && dd.usedPct != null) {
    const line = `数据盘已用 ${dd.usedPct}%（剩余 ${(dd.free / 1073741824).toFixed(1)}GB / 共 ${(dd.total / 1073741824).toFixed(0)}GB）`;
    items.push(dd.usedPct >= 92 ? bad('disk', '数据盘剩余空间', line + ' —— 空间不足会导致转码失败/字幕写不进去') : (dd.usedPct >= 80 ? warn('disk', '数据盘剩余空间', line + ' —— 建议清理：重复文件清理 / 回收站') : ok('disk', '数据盘剩余空间', line)));
  }

  /* —— 网络 —— */
  const ips = lanIps();
  items.push(ips.length
    ? ok('ip', '局域网地址（电视/手机访问用）', ips.map((i) => `${i.addr}`).join(' / '))
    : bad('ip', '局域网地址（电视/手机访问用）', '没找到可用的局域网 IPv4 —— 这是「电视打不开网页版」最常见的原因'));
  const port = Number(process.env.PORT || process.env.HMP_PORT || 8090);
  items.push(ok('port', '服务端口', `监听中：${port}`));
  items.push(warn('multicast', '组播 / 运营商 IPTV', 'HMP 不自带组播网关：运营商 IPTV 的 UDP 组播流需要外部网关转成 HTTP 才能播（这是网络协议限制，不是软件缺陷）', null));
  items.push(warn('cast', '电视投屏（DLNA/Cast）', 'HMP 目前不提供 DLNA/Cast 服务端：电视端需用浏览器访问本页，或用系统自带的投屏协议', null));

  /* —— 外部服务（可配置项的真实探活） —— */
  const tmdbBase = String(db.getSetting('tmdbApiBaseUrl', '') || '').replace(/\/+$/, '') || 'https://api.themoviedb.org/3';
  const tmdbKey = String(db.getSetting('tmdbApiKey', '') || '');
  if (!tmdbKey) items.push(warn('tmdb', 'TMDB 元数据（海报/评分/简介）', '未配置 API Key —— 影片没有海报、评分和简介（不影响播放）', null));
  else {
    const t = await httpProbe(`${tmdbBase}/configuration?api_key=${encodeURIComponent(tmdbKey)}`);
    items.push(!t.reach
      ? bad('tmdb', 'TMDB 元数据（海报/评分/简介）', `接口不可达：${t.error} —— 国内直连通常被挡，需要在「⚙️ 元数据与在线片源」填代理地址`, null)
      : (t.status === 401 ? bad('tmdb', 'TMDB 元数据（海报/评分/简介）', 'API Key 被拒（HTTP 401）—— Key 填错或已失效', null)
        : ok('tmdb', 'TMDB 元数据（海报/评分/简介）', `接口可达（HTTP ${t.status}，地址 ${tmdbBase}）`)));
  }
  const osKey = String(db.getSetting('opensubtitlesApiKey', '') || '');
  const osBase = String(db.getSetting('opensubtitlesApiBaseUrl', '') || '').replace(/\/+$/, '') || 'https://api.opensubtitles.com/api/v1';
  const t2 = await httpProbe(`${osBase}/subtitles?query=hmp`, 9000);
  if (!t2.reach) {
    items.push(bad('net-sub', '网络字幕源（OpenSubtitles 代理）',
      `代理地址不可达：${t2.error} —— 国内直连 OpenSubtitles 会被 403，必须用 Cloudflare Worker 代理；请检查代理域名是否已解析（可在「⚙️ 元数据与在线片源」改地址）`, null));
  } else if (!osKey) {
    items.push(warn('net-sub', '网络字幕源（OpenSubtitles 代理）', `代理可达（HTTP ${t2.status}）但未配置 API Key`, null));
  } else {
    items.push(t2.status === 401 || t2.status === 403
      ? warn('net-sub', '网络字幕源（OpenSubtitles 代理）', `代理在线，但 Key 被拒（HTTP ${t2.status}）—— 换 Key 或检查代理是否透传了 Api-Key 头`, null)
      : ok('net-sub', '网络字幕源（OpenSubtitles 代理）', `在线（HTTP ${t2.status}，地址 ${osBase}）`));
  }

  /* —— 网盘 / 直播 / 游戏库 —— */
  let bridge = null;
  try { bridge = await webdav.probeBridge(); } catch { /* ignore */ }
  items.push(bridge && bridge.running
    ? ok('openlist', '网盘桥接（一键挂载 9 家网盘）', `运行中（端口 ${bridge.port}）`)
    : warn('openlist', '网盘桥接（一键挂载 9 家网盘）', '未发现运行中的桥接 —— 「一键挂载网盘」会失败（已挂好的 WebDAV 不受影响）', 'reload-bridge'));
  const wcfg = webdav.getConfig() || {};
  items.push(wcfg.configured
    ? ok('webdav', 'WebDAV（Alist / 坚果云等）', `已连接 ${wcfg.url || ''}`)
    : warn('webdav', 'WebDAV（Alist / 坚果云等）', '未配置 —— 需要网盘时可到「📂 网盘与本地目录」填地址与账号', null));
  try {
    const lv = await livetv.list();
    const groups = (lv && lv.groups) || [];
    const n = groups.reduce((a, g) => a + ((g.channels || []).length), 0);
    items.push(n ? ok('livetv', '直播源', `${groups.length} 个分组 / ${n} 个频道`) : warn('livetv', '直播源', '未配置直播片单 —— 去「📡 电视直播」添加 m3u/JSON 片单', null));
  } catch { /* ignore */ }
  const rommPort = Math.max(1, Math.min(65535, Number(process.env.ROMM_PORT) || 8098));
  items.push(await tcpAlive(rommPort)
    ? ok('romm', '游戏库 RomM（复古主机）', `在线（:${rommPort}）`)
    : warn('romm', '游戏库 RomM（复古主机）', `未运行（:${rommPort}）—— 只有玩 Retro 游戏时才需要`, null));

  /* —— 缓存与时间 —— */
  const cacheDir = path.join(dataRoot(), 'cache');
  const csize = await dirSize(cacheDir);
  items.push(csize > 2 * 1073741824
    ? warn('cache', '临时缓存占用', `${(csize / 1073741824).toFixed(1)}GB（转码分段/内嵌字幕提取产物等）—— 可一键清理`, 'purge-cache')
    : ok('cache', '临时缓存占用', `${(csize / 1048576).toFixed(0)}MB`));
  items.push(ok('clock', '服务器时间', `${new Date().toLocaleString('zh-CN')}（时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone}）`));

  const score = { ok: items.filter((i) => i.level === 'ok').length, warn: items.filter((i) => i.level === 'warn').length, bad: items.filter((i) => i.level === 'bad').length };
  return { items, score, host, at: Date.now() };
}

/* ---------------- 一键修复（只做安全可逆动作） ---------------- */

const PURGE_TMP = /^asr-.*\.wav$/;
const PURGE_DIRS = new Set(['asrlive', 'subcache', 'tmp', 'thumbs']);

async function fix(action) {
  try {
    if (action === 'reset-bins') {
      bins.resetCache();
      const b = bins.status();
      return { ok: !!b.ready, detail: b.ready ? '运行时探测已刷新：ffmpeg / ffprobe 就绪' : `刷新后仍缺少 ${(b.missing || []).join(' / ')} —— 请确认 runtime/ffmpeg 目录完整` };
    }
    if (action === 'reload-bridge') {
      const r = await webdav.probeBridge().catch(() => null);
      return { ok: !!(r && r.running), detail: r && r.running ? `网盘桥接重新探测成功（端口 ${r.port}）` : '重新探测后仍未发现运行中的网盘桥接' };
    }
    if (action === 'purge-cache') {
      const dir = path.join(dataRoot(), 'cache');
      let freed = 0, n = 0;
      let ents = [];
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { /* ignore */ }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!PURGE_DIRS.has(e.name)) continue;
          try {
            const s = await dirSize(p, 5);
            await fsp.rm(p, { recursive: true, force: true });
            freed += s; n++;
          } catch { /* ignore */ }
        } else if (PURGE_TMP.test(e.name)) {
          try { const st = await fsp.stat(p); await fsp.unlink(p); freed += st.size; n++; } catch { /* ignore */ }
        }
      }
      return { ok: true, detail: `已清理 ${n} 项临时文件，释放 ${(freed / 1048576).toFixed(0)}MB（海报与已生成字幕未动）` };
    }
    return { ok: false, detail: '未知的修复动作' };
  } catch (e) {
    return { ok: false, detail: '修复失败：' + e.message };
  }
}

module.exports = { run, fix, lanIps, tcpAlive, diskOf };
