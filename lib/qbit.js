'use strict';
/* 下载中心 · BT/磁力：对接 qBittorrent Web API v2（零 npm 依赖，2026-09-27）
 * - 凭据存 settings 表（qbit_url / qbit_user / qbit_pass），改完即时生效，不重启
 * - SID cookie 内存持有；403（会话过期/未登录）自动重登一次再重试
 * - 只走 form-urlencoded，不碰 multipart（只有上传 .torrent 文件才需要）
 */
const http = require('node:http');
const https = require('node:https');
const db = require('./db');

const K = { url: 'qbit_url', user: 'qbit_user', pass: 'qbit_pass', dir: 'qbit_dir' };

/* qBittorrent 原始 state → 中文 + 归一化状态（与下载中心卡片可共用语义） */
const STATE_CN = {
  metaDL: '获取种子信息', downloading: '下载中', stalledDL: '等待连接',
  queuedDL: '排队中', pausedDL: '已暂停', checkingDL: '校验中',
  uploading: '做种中', stalledUP: '做种等待', queuedUP: '排队做种',
  pausedUP: '暂停做种', checkingUP: '校验中', error: '出错', missingFiles: '文件缺失',
  forcedDL: '强制下载', forcedUP: '强制做种', checkingResumeData: '校验中',
  moving: '移动中', unknown: '未知',
};
const STATE_NORM = {
  downloading: 'downloading', metaDL: 'downloading', stalledDL: 'pending',
  queuedDL: 'pending', forcedDL: 'downloading', checkingDL: 'downloading',
  uploading: 'done', stalledUP: 'done', queuedUP: 'done', pausedUP: 'done',
  checkingUP: 'done', forcedUP: 'done', pausedDL: 'paused',
  checkingResumeData: 'downloading', moving: 'downloading',
  error: 'error', missingFiles: 'error', unknown: 'pending',
};

function cfg() {
  return {
    url: String(db.getSetting(K.url, '') || '').replace(/\/+$/, ''),
    user: String(db.getSetting(K.user, '') || ''),
    pass: String(db.getSetting(K.pass, '') || ''),
    dir: String(db.getSetting(K.dir, '') || ''),
  };
}
function setCfg(o) {
  if (o.url != null) db.setSetting(K.url, String(o.url).trim().replace(/\/+$/, ''));
  if (o.user != null) db.setSetting(K.user, String(o.user));
  if (o.pass != null) db.setSetting(K.pass, String(o.pass));
  if (o.dir != null) db.setSetting(K.dir, String(o.dir).trim());
  cookie = ''; // 换配置即刻作废旧会话
  return cfg();
}
function configured() { const c = cfg(); return !!c.url; }

let cookie = '';

/* 底层请求：返回 {status, text, headers}；不抛网络异常以外的错 */
function raw(method, pathname, form) {
  return new Promise((resolve, reject) => {
    const c = cfg();
    if (!c.url) { reject(new Error('还没配置 qBittorrent 地址')); return; }
    let u;
    try { u = new URL(c.url + pathname); } catch { reject(new Error('qBittorrent 地址不合法：' + c.url)); return; }
    const mod = u.protocol === 'https:' ? https : http;
    let body = null;
    /* CSRF 防护：qBittorrent 要求 POST 带与地址同源的 Referer/Origin，
     * 否则静默不返回 SID（HTTP 204 但无 Set-Cookie，后续调用全 403） */
    const headers = { Accept: 'application/json', Referer: c.url + '/', Origin: c.url };
    if (form) {
      body = Buffer.from(new URLSearchParams(form).toString(), 'utf8');
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = body.length;
    }
    if (cookie) headers.Cookie = cookie;
    const req = mod.request({ method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers, timeout: 8000 }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode || 0, text: buf, headers: res.headers || {} }));
    });
    req.on('timeout', () => { req.destroy(new Error('连接 qBittorrent 超时')); });
    req.on('error', (e) => reject(e));
    if (body) req.write(body);
    req.end();
  });
}

async function login(force) {
  if (cookie && !force) return true;
  cookie = ''; // 重登前清空可能过期的旧会话，避免带失效 SID 去登录被 qBT 拒（401）
  const c = cfg();
  const r = await raw('POST', '/api/v2/auth/login', { username: c.user, password: c.pass });
  const sc = (r.headers['set-cookie'] || []).join('; ');
  /* 版本差异：4.x 是 SID=...，5.x 起是 QBT_SID_<WebUI端口>=...（cookie 名随端口变） */
  const m = sc.match(/(QBT_SID_\d+|SID)=([^;,\s]+)/);
  if (m) { cookie = m[1] + '=' + m[2]; return true; }
  // 新版可能只在 Ok. 文本里成功但 cookie 走 httpOnly——没拿到就当失败
  if (r.status === 200 && /^Ok\.?$/i.test(String(r.text || '').trim())) {
    // 无 cookie 也能用（部分版本允许 Basic 或免登录）
    return true;
  }
  cookie = '';
  const t = String(r.text || '').trim();
  if (/fails/i.test(t)) throw new Error('账号或密码不对');
  throw new Error(r.status === 403
    ? '账号或密码不对（连续失败会被临时锁定，等一会儿再试）'
    : '登录失败：HTTP ' + r.status + (t ? ' · ' + t.slice(0, 60) : ''));
}

/* 带 403 自动重登的通用调用 */
async function call(method, pathname, form, retry) {
  try {
    const r = await raw(method, pathname, form);
    if (r.status === 403 || r.status === 401) {
      if (!retry) { await login(true); return call(method, pathname, form, true); }
      throw new Error('登录状态失效且重登仍被拒（'+r.status+'）');
    }
    if (r.status >= 400) throw new Error('qBittorrent 返回 HTTP ' + r.status);
    return r;
  } catch (e) {
    if (!retry && /超时|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|socket/i.test(e.message)) {
      await login(true);
      return call(method, pathname, form, true);
    }
    throw e;
  }
}

/** 连通性探测：{ ok, version, configured } */
async function test(o) {
  if (o) setCfg(o);
  try {
    await login(true);
    const r = await call('GET', '/api/v2/app/version');
    const v = String(r.text || '').trim().replace(/^v/, '');
    return { ok: true, configured: true, version: v || '未知' };
  } catch (e) {
    return { ok: false, configured: configured(), version: '', error: e.message };
  }
}

/** 任务列表：统一成下载中心的卡片形态 */
async function list() {
  if (!configured()) return [];
  await login();
  const r = await call('GET', '/api/v2/torrents/info?filter=all&sort=added_on&reverse=true');
  let arr = [];
  try { arr = JSON.parse(r.text || '[]'); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map((t) => ({
    id: t.hash || '',
    name: t.name || '(无名任务)',
    size: Number(t.size || 0),
    downloaded: Math.round(Number(t.size || 0) * Number(t.progress || 0)),
    progress: Number(t.progress || 0),          // 0~1
    speed: Number(t.dlspeed || 0),
    upspeed: Number(t.upspeed || 0),
    eta: Number(t.eta || 0),
    state: t.state || 'unknown',
    stateCn: STATE_CN[t.state] || t.state || '',
    status: STATE_NORM[t.state] || 'pending',
    savePath: t.save_path || '',
    addedOn: Number(t.added_on || 0),
    category: t.category || '',
    bt: true,
  }));
}

/* 可靠 tracker 池：部分网络 DHT 被运营商/路由器劫持（引导节点返回 192.168.8.1 死端口），
 * 磁力只能靠 tracker 拿到真实 peer。添加磁力时自动补这一批，绕过 DHT 劫持。 */
const EXTRA_TRACKERS = [
  'udp://tracker.itzmx.com:2710/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'https://tracker.tamersunion.org:443/announce',
  'http://tracker.bitcomet.com:39160/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'http://www.gbitt.info:80/announce',
  'udp://tracker.leechers-paradise.org:6969/announce',
  'udp://tracker.uw0.xyz:6969/announce',
  'https://trackers.run:443/announce',
];

/* magnet xt=urn:btih: 可能是 40 位 hex 或 32 位 base32，qBittorrent 内部统一用 40 位小写 hex 作 hash */
function btihToHash(s) {
  s = String(s || '').trim();
  const m = s.match(/xt=urn:btih:([^&]+)/i);
  const v = m ? m[1] : s;
  if (/^[0-9a-fA-F]{40}$/.test(v)) return v.toLowerCase();
  try {
    const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const ch of v.toUpperCase()) {
      const i = alpha.indexOf(ch);
      if (i < 0) continue;
      bits += i.toString(2).padStart(5, '0');
    }
    let bytes = '';
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes += String.fromCharCode(parseInt(bits.substr(i, 8), 2));
    return Buffer.from(bytes, 'binary').toString('hex');
  } catch { return ''; }
}

/* 给指定 hash 的种子补 tracker（qBT 5.x 用 torrents/addTrackers） */
async function addTrackers(hash, urls) {
  await login();
  const r = await call('POST', '/api/v2/torrents/addTrackers', { hash, urls: Array.isArray(urls) ? urls.join('\n') : urls });
  return r.status < 400;
}

/** 添加：urls 支持 magnet / http(s) .torrent / 多个用换行分隔 */
async function add(urls, opt = {}) {
  const c = cfg();
  const list2 = String(urls || '').split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
  if (!list2.length) throw new Error('请先粘贴磁力链接或种子地址');
  await login();
  const form = { urls: list2.join('\n'), paused: 'false' };
  const dir = String(opt.dir || c.dir || '').trim();
  if (dir) form.savepath = dir;
  if (opt.category) form.category = String(opt.category);
  const r = await call('POST', '/api/v2/torrents/add', form);
  /* 版本差异：4.x 返回 "Ok."，5.x 返回 {"success_count":n,...}，个别版本空体 */
  const txt = String(r.text || '').trim();
  let ok = txt === '' || /^Ok\.?$/i.test(txt);
  if (!ok && txt.charAt(0) === '{') {
    try { ok = (JSON.parse(txt).success_count || 0) > 0; } catch { ok = false; }
  }
  if (!ok) throw new Error('添加失败：' + txt.slice(0, 120));
  /* 磁力链接补 tracker：绕过 DHT 劫持。qBT 注册种子需要一点时间，retry 兜底 */
  const mags = list2.filter((u) => /^magnet:/i.test(u)).map(btihToHash).filter(Boolean);
  if (mags.length) {
    for (const h of mags) {
      for (let attempt = 0; attempt < 5; attempt++) {
        let t = false;
        try { t = await addTrackers(h, EXTRA_TRACKERS); } catch { t = false; }
        if (t) break;
        await new Promise((r2) => setTimeout(r2, 700));
      }
    }
  }
  return { ok: true, n: list2.length };
}

async function op(kind, hash, deleteFiles) {
  await login();
  const form = { hashes: hash };
  if (kind === 'delete') form.deleteFiles = deleteFiles ? 'true' : 'false';
  await call('POST', '/api/v2/torrents/' + kind, form);
  return { ok: true };
}
function pause(hash) { return op('pause', hash); }
function resume(hash) { return op('resume', hash); }
function remove(hash, deleteFiles) { return op('delete', hash, deleteFiles); }
function recheck(hash) { return op('recheck', hash); }

/** 全局速度（用于页头汇总） */
async function transfer() {
  try {
    await login();
    const r = await call('GET', '/api/v2/transfer/info');
    const o = JSON.parse(r.text || '{}');
    return { dl: Number(o.dl_info_speed || 0), up: Number(o.up_info_speed || 0) };
  } catch { return { dl: 0, up: 0 }; }
}

/* ============================ 局域网自动发现 ============================
   绝大多数客户不是「为了用 HMP 才装 qBittorrent」，而是早就装好了：NAS 上的 Docker、
   天天开着的 Windows 下载机、软路由旁 SERVICE。让他们翻 qBittorrent 配置找端口号是
   件很劝退的事 —— 所以这里做一键扫描：
     ① 本机先全端口候选试一遍（最常见：跟 HMP 装在同一台 NAS 上）
     ② 再扫同网段的常见 WebUI 端口（并发 TCP 探活，不做任何写入）
     ③ 命中的地址用 /api/v2/app/version 做二次确认 —— 401/403/200 都是 qBittorrent
        （没登录会 403），其它服务（nginx/Transmission/Jackett）会被这一层筛掉
   全程只读 TCP 连接，不改任何东西，也不影响对方的下载任务。 */
const os = require('node:os');
const VIF = /^(docker|lxcbr|lxdbr|virbr|veth|br-|tailscale|zt|tun|tap|wg|utun|awdl|vmnet|vboxnet|ham)/i;
/* 常见 WebUI 端口：8080 是 qBittorrent 默认；8086/8085/8070 是各家教程爱改的；
   6880 是部分 Docker 镜像的默认；9117 不是 qBittorrent（留着只是为了不误报，这里不用）。 */
const QB_PORTS = [8080, 8086, 8085, 8070, 6880, 8096, 8181];
const LAN_PORTS = [8080, 8086, 8085, 8070, 6880];

function lanIp() {
  try {
    const nis = os.networkInterfaces();
    const cands = [];
    for (const name of Object.keys(nis)) {
      if (VIF.test(name)) continue;
      for (const a of nis[name] || []) if (a.family === 'IPv4' && !a.internal) cands.push(a.address);
    }
    if (!cands.length) return '';
    const rank = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
    cands.sort((a, b) => rank(a) - rank(b));
    return cands[0];
  } catch { return ''; }
}

function tcpProbe(host, port, ms) {
  return new Promise((resolve) => {
    let done = false;
    const s = new (require('node:net').Socket)();
    const t0 = Date.now();
    const fin = (ok) => { if (done) return; done = true; try { s.destroy(); } catch { /* noop */ } resolve({ ok, rtt: Date.now() - t0 }); };
    s.setTimeout(ms);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    try { s.connect(port, host); } catch { fin(false); }
  });
}

/* 二次确认：只看 HTTP 状态码与返回类型，不读密码相关任何内容 */
function isQbit(url, ms = 2500) {
  return new Promise((resolve) => {
    let req;
    const mod = /^https/.test(url) ? https : http;
    try {
      req = mod.get(url + '/api/v2/app/version', { timeout: ms }, (res) => {
        const ct = String(res.headers['content-type'] || '');
        const code = res.statusCode || 0;
        res.resume();
        // 200 开放 / 401 403 需要登录 —— 都是 qBittorrent；404 或 text/html 说明是别的服务
        resolve(code === 200 || code === 401 || code === 403 ? { yes: !(ct.indexOf('text/html') >= 0 && code === 200), code } : { yes: false, code });
      });
    } catch (e) { return resolve({ yes: false, code: 0 }); }
    req.on('timeout', () => { try { req.destroy(); } catch { /* noop */ } resolve({ yes: false, code: 0 }); });
    req.on('error', () => resolve({ yes: false, code: 0 }));
  });
}

async function discover(opts = {}) {
  const deep = opts.deep !== false;
  const out = [];
  const seen = new Set();
  const push = (url, how, rtt) => { if (!seen.has(url)) { seen.add(url); out.push({ url, how, rtt }); } };
  const curUrl = cfg().url;

  // ① 本机：localhost + 本机局域网 IP，全候选端口（本机扫描几乎零成本）
  const selfIps = ['127.0.0.1'];
  const self = lanIp();
  if (self) selfIps.push(self);
  const first = [];
  for (const ip of selfIps) {
    // 127.0.0.1 与本机局域网 IP 其实是同一台，标签要说清楚，别让「找到 N 台」看着虚高
    for (const port of QB_PORTS) first.push({ ip, port, how: ip === '127.0.0.1' ? '本机（推荐）' : '本机 · 局域网地址（同上面那台）' });
  }
  const OPEN = await Promise.all(first.map(async (t) => {
    const r = await tcpProbe(t.ip, t.port, 700);
    return r.ok ? t : null;
  }));
  for (const t of OPEN) { if (!t) continue; push('http://' + t.ip + ':' + t.port, t.how, 0); }
  if (curUrl && !seen.has(curUrl)) push(curUrl, '当前已配置', 0);

  // ② 同网段其它机器（用户没忍住点了深度扫描才做，避免每次都等几秒）
  if (deep && self) {
    const base = self.split('.').slice(0, 3).join('.');
    const jobs = [];
    for (let i = 1; i <= 254; i++) for (const port of LAN_PORTS) jobs.push({ ip: base + '.' + i, port });
    const step = 64; // 并发闸门：一次 64 个连接，扫完 /24×5 端口约 3~6 秒
    for (let i = 0; i < jobs.length; i += step) {
      const part = jobs.slice(i, i + step);
      const rs = await Promise.all(part.map(async (t) => {
        const r = await tcpProbe(t.ip, t.port, 700);
        return r.ok ? { ip: t.ip, port: t.port, rtt: r.rtt } : null;
      }));
      for (const r of rs) if (r) push('http://' + r.ip + ':' + r.port, '局域网 ' + r.ip, r.rtt);
      await new Promise((r) => setImmediate(r)); // 让出事件循环，别把服务卡住
    }
  }

  // ③ 二次确认是不是 qBittorrent（未登录会 403，仍然算命中）
  const checked = await Promise.all(out.map(async (x) => {
    const r = await isQbit(x.url);
    return r.yes ? Object.assign({}, x, { code: r.code }) : null;
  }));
  return {
    items: checked.filter(Boolean),
    scanned: { lanIp: self, subnet: self ? self.split('.').slice(0, 3).join('.') + '.0/24' : '', ports: deep ? LAN_PORTS : QB_PORTS, deep: !!deep },
  };
}

/* ============================ 服务端托管增强（20260927dlui） ============================
 * ① webHeaders：给透明代理用 —— 已登录的 SID Cookie + 过 CSRF 的 Origin/Referer
 * ② rescue：容器删了重装后密码不知道 → docker logs 里把 qBittorrent 打印的临时密码抓回来
 * ③ install：一键把 qBittorrent 装回本机 NAS（固定 WEBUI_PORT=8086，重装不再变端口）
 *   —— 此前设计取向是「只发现不安装」，但实测客户删容器重装后端口漂移 + 临时密码找不到，
 *      连不上就只能干瞪眼；而本程序本来就跑在 NAS 上，docker 命令触手可及。
 */
const cp = require('node:child_process');
const DOCKER_CANDS = [
  'docker',
  '/share/CE_CACHEDEV1_DATA/.qpkg/container-station/bin/docker',
  '/usr/local/bin/docker', '/usr/bin/docker', '/usr/local/sbin/docker',
];

function exec1(cmd, args, timeout) {
  return new Promise((resolve) => {
    cp.execFile(cmd, args, { timeout: timeout || 15000, maxBuffer: 8 << 20 }, (e, so, se) => {
      resolve({ ok: !e, out: String(so || ''), err: String(se || '') + (e ? ' ' + e.message : '') });
    });
  });
}

async function findDocker() {
  for (const d of DOCKER_CANDS) {
    const r = await exec1(d, ['--version'], 6000);
    if (r.ok && /Docker version/i.test(r.out)) return d;
  }
  return '';
}

function relogin() { return login(true).then(() => true); }

/* 给代理层用的请求头：SID Cookie（自动登录）+ Origin/Referer（qBT 的 CSRF 白名单） */
async function webHeaders() {
  const c = cfg();
  await login();
  const h = { Origin: c.url, Referer: c.url + '/' };
  if (cookie) h.Cookie = cookie;
  return h;
}

/* docker ps -a 里翻 qBittorrent 容器（运行/停止都算），再翻日志找临时密码。
   4.6.1+ 首启会在日志里打印一次「The WebUI administrator password was set to: xxx」；
   5.x 是「A temporary password is provided for this session: xxx」。 */
async function rescue() {
  const dk = await findDocker();
  if (!dk) return { ok: false, error: '这台 NAS 上没有可用的 docker 命令' };
  const ps = await exec1(dk, ['ps', '-a', '--format', '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}'], 15000);
  const rows = ps.out.split('\n').map((l) => l.trim()).filter(Boolean);
  const hit = rows.find((l) => /qbittorrent/i.test(l));
  if (!hit) return { ok: false, docker: dk, error: '没找到 qbittorrent 容器（可以点「一键装回本机 NAS」）' };
  const parts = hit.split('|');
  const name = (parts[0] || '').trim();
  const running = /Up/i.test(parts[2] || '');
  const log = await exec1(dk, ['logs', '--tail', '500', name], 20000);
  const all = log.out + '\n' + log.err;
  const m = all.match(/(?:temporary password(?:\s+is\s+provided\s+for\s+this\s+session)?|administrator password was set to)\s*[:：]?\s*(\S+)/i);
  const out = { ok: true, container: name, running };
  if (m) out.pass = m[1];
  const pm = (parts[3] || '').match(/0\.0\.0\.0:(\d+)->(\d+)\/tcp/);
  if (pm) out.portMap = { host: Number(pm[1]), container: Number(pm[2]) };
  return out;
}

/* 首装预写固定密码（admin/adminadmin）：qBittorrent 4.6+/5.x 没有密码配置时每次启动
   都会生成随机临时密码（只打印在容器日志里），客户不可能知道 → 「进不去程序」。
   装容器前先把 PBKDF2 哈希写进挂载卷里的 qBittorrent.conf，一劳永逸。
   已有密码配置（用户自己改过密码）则绝不动它。同时钉死 BT 监听端口 + 关 random_port，
   避免每次重启端口随机化导致 DHT 节点恒 0（部分网络 DHT 还被劫持，更得靠 tracker）。 */
function seedQbtConf() {
  const fs = require('node:fs');
  const crypto = require('node:crypto');
  const dir = '/share/Container/qbittorrent/config';
  const p = dir + '/qBittorrent.conf';
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 目录多半已存在 */ }
  let cur = '';
  try { cur = fs.readFileSync(p, 'utf8'); } catch { /* 首装没有 conf */ }
  if (cur && /Password_PBKDF2/i.test(cur)) return; // 已有密码（多半用户自设），别覆盖
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync('adminadmin', salt, 100000, 64, 'sha512');
  const line = 'WebUI\\Password_PBKDF2="@ByteArray(' + salt.toString('base64') + ':' + hash.toString('base64') + ')"';
  const bt = 'Bittorrent\\Port=6882\nBittorrent\\RandomPort=false\n';
  let out;
  if (cur && /^\[Preferences\]/m.test(cur)) {
    out = cur.replace(/\[Preferences\]\r?\n/, '[Preferences]\n' + line + '\n' + bt);
    if (out === cur) out = cur.replace(/\s*$/, '\n\n[Preferences]\n' + line + '\n' + bt);
  } else {
    out = (cur ? cur.replace(/\s*$/, '\n\n') : '') + '[Config]\nVersion=5.0.0\n\n[Preferences]\n' + line + '\nWebUI\\Port=8086\n' + bt + 'Session\\DefaultSavePath=/downloads\n';
  }
  fs.writeFileSync(p, out);
}

/* 选下载目录：优先挂在真实大容量数据卷上，绝不用 /share/Download 这个 16MB tmpfs 陷阱
   （QNAP 上 /share/Download 可能被误建为内存盘真目录，写满即 No space left on device）。
   按 df 可用空间挑最大的数据卷，建 Download/qbittorrent。 */
async function pickDownloadDir() {
  const fs = require('node:fs');
  const cands = [];
  try {
    for (const d of fs.readdirSync('/share')) {
      if (/^(CE_)?CACHEDEV\d+_DATA$/.test(d) || d === 'Public' || d === 'Container') cands.push('/share/' + d);
      if (d === 'Download') cands.push('/share/Download'); // tmpfs 陷阱会因为它可用空间极小在下面被淘汰
    }
  } catch { /* ignore */ }
  if (!cands.length) cands.push('/share/Container/qbittorrent');
  let best = cands[0], bestFree = -1;
  for (const b of cands) {
    let free = -1;
    try {
      const rr = await exec1('df', ['-k', b], 6000);
      const f = rr.out.split('\n').filter(Boolean).pop().split(/\s+/);
      if (f.length >= 4) free = parseInt(f[3], 10) * 1024;
    } catch { /* ignore */ }
    if (free > bestFree) { bestFree = free; best = b; }
  }
  const dir = best + '/Download/qbittorrent';
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 多半已存在 */ }
  try { await exec1('chown', ['-R', '1000:100', dir], 15000); } catch { /* 权限不够就让 docker 报错反馈 */ }
  return dir;
}

/* 一键装回本机：host 网络（避免 bridge 端口映射/端口随机化导致 DHT 恒 0）+ TORRENTING_PORT=6882
   钉死 BT 端口；镜像固定 libtorrentv1（兼容性最好）；下载目录落到真实大卷，不再踩 16MB tmpfs 陷阱。
   只清理本程序自己管理的容器（镜像为 linuxserver/qbittorrent），绝不动客户自建的 qBittorrent。 */
async function install() {
  const dk = await findDocker();
  if (!dk) return { ok: false, error: '这台 NAS 上没有 docker（Container Station 未安装？）' };
  const ps = await exec1(dk, ['ps', '-a', '--format', '{{.Names}}|{{.Image}}|{{.Status}}'], 15000);
  const mine = ps.out.split('\n').map((l) => l.trim()).filter(Boolean)
    .find((l) => /qbittorrent/i.test(l.split('|')[0] || '') && /linuxserver\/qbittorrent/i.test(l.split('|')[1] || ''));
  if (mine) await exec1(dk, ['rm', '-f', mine.split('|')[0].trim()], 20000); // 含半死状态，按最新参数重建才幂等
  // 预写固定密码 + 钉死 BT 端口（杜绝随机临时密码 + 随机端口导致 DHT 恒 0）
  try { seedQbtConf(); } catch { /* 预写失败不阻断：装完走默认密码/日志找回 */ }
  try { await exec1('chown', ['-R', '1000:100', '/share/Container/qbittorrent/config'], 15000); } catch { /* ignore */ }
  const dl = await pickDownloadDir();
  const runArgs = [
    'run', '-d', '--name', 'qbittorrent-hmp', '--restart', 'unless-stopped',
    '--network', 'host',
    '-e', 'PUID=1000', '-e', 'PGID=100', '-e', 'TZ=Asia/Shanghai',
    '-e', 'WEBUI_PORT=8086', '-e', 'TORRENTING_PORT=6882',
    '-v', '/share/Container/qbittorrent/config:/config',
    '-v', dl + ':/downloads',
    'docker.m.daocloud.io/linuxserver/qbittorrent:libtorrentv1',
  ];
  const r = await exec1(dk, runArgs, 280000);
  if (!r.ok) return { ok: false, error: ('安装失败：' + (r.err || r.out)).slice(0, 220) };
  // 等 WebUI 初始化（几秒），然后接管连接配置
  let t = { ok: false };
  for (let i = 0; i < 10; i++) {
    await new Promise((r2) => setTimeout(r2, 3000));
    setCfg({ url: 'http://127.0.0.1:8086' });
    t = await test({ user: 'admin', pass: 'adminadmin' });
    if (t.ok) break;
  }
  const out = { ok: true, container: 'qbittorrent-hmp', downloadDir: dl };
  if (t.ok) { out.version = t.version; out.defaultPass = true; return out; }
  const rc = await rescue();
  if (rc && rc.pass) {
    const t2 = await test({ user: 'admin', pass: rc.pass });
    if (t2.ok) { out.version = t2.version; out.pass = rc.pass; }
  }
  return out;
}

module.exports = {
  cfg, setCfg, configured, test, list, add, pause, resume, remove, recheck, transfer, discover, lanIp,
  webHeaders, relogin, rescue, install,
  STATE_CN,
};
