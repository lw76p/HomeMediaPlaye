'use strict';
/* 手机遥控器（E3）：配对码会话 + SSE 双向通道
 *
 * 角色：
 *   - tv    = 电视 / 电脑上的播放页，连上来收 cmd，并主动上报 state
 *   - phone = 手机遥控页，连上来收 state，发 cmd
 *
 * 设计约束：
 *   1) 纯内存、不落盘 —— 遥控是一次性临时会话，进程重启即失效，不留任何垃圾文件；
 *   2) 不进管理锁 / 儿童模式 —— 遥控只是控制本机播放，与"改设置"不是一个安全级别；
 *   3) 连接断开必须立刻清集合，否则 sweep 永远认为会话活着（SSE 长连接最容易漏这步）；
 *   4) 任何 push 都要吞异常 —— 对端半开连接上 res.write 会抛，不能让它冲垮路由。
 */

const MAX_SESSIONS = 32;        // 会话数上限（防恶意刷）
const IDLE_MS = 45 * 60 * 1000; // 有连接时的空闲上限
const DEAD_MS = 60 * 1000;      // 无连接的会话保留时间
// 去掉易混字符：I O S B Z 与 0 1 2 5 8 —— 用户要在手机上照着敲这 6 位
const CODE_CHARS = 'ACDEFGHJKLMNPQRTUVWXY34679';

const sessions = new Map(); // code -> session

function rndCode() {
  let s = '';
  for (let i = 0; i < 6; i += 1) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function closeAll(s, reason) {
  const b = { reason: reason || 'closed' };
  broadcast(s.phones, 'closed', b);
  broadcast(s.tv, 'closed', b);
  for (const r of s.phones) { try { r.end(); } catch { /* ignore */ } }
  for (const r of s.tv) { try { r.end(); } catch { /* ignore */ } }
  s.phones.clear();
  s.tv.clear();
}

function sweep(now) {
  const t = now || Date.now();
  for (const [code, s] of Array.from(sessions)) {
    const alive = s.tv.size > 0 || s.phones.size > 0;
    const idle = t - s.lastAt;
    if (idle > IDLE_MS || (!alive && idle > DEAD_MS)) {
      closeAll(s, 'expired');
      sessions.delete(code);
    }
  }
  if (sessions.size > MAX_SESSIONS) {
    const arr = Array.from(sessions.values()).sort((a, b) => a.lastAt - b.lastAt);
    while (sessions.size > MAX_SESSIONS) {
      const old = arr.shift();
      if (!old) break;
      closeAll(old, 'evicted');
      sessions.delete(old.code);
    }
  }
}

const sweeper = setInterval(() => { try { sweep(); } catch { /* ignore */ } }, 60000);
if (sweeper && typeof sweeper.unref === 'function') sweeper.unref();

function create() {
  sweep();
  let code = rndCode();
  let guard = 0;
  while (sessions.has(code) && guard < 50) { code = rndCode(); guard += 1; }
  const s = {
    code,
    createdAt: Date.now(),
    lastAt: Date.now(),
    tv: new Set(),
    phones: new Set(),
    state: null,
  };
  sessions.set(code, s);
  return s;
}

function get(code) {
  const s = sessions.get(String(code || '').trim().toUpperCase());
  if (!s) return null;
  s.lastAt = Date.now();
  return s;
}

function push(res, evt, data) {
  if (!res || res.writableEnded) return false;
  try {
    res.write(`event: ${evt}\n`);
    res.write(`data: ${JSON.stringify(data == null ? {} : data)}\n\n`);
    return true;
  } catch { return false; }
}

function broadcast(set, evt, data) {
  let n = 0;
  for (const r of Array.from(set)) { if (push(r, evt, data)) n += 1; }
  return n;
}

/* 挂 SSE 长连接。返回 true 表示已接管 res（调用方不要再 res.end）。 */
function attach(s, role, res) {
  s.lastAt = Date.now();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 反代（nginx）别缓冲，否则事件攒着不发
  });
  res.write(': ok\n\n'); // 立刻刷一次头，浏览器 EventSource 才会触发 onopen

  const isTv = role === 'tv';
  const set = isTv ? s.tv : s.phones;
  set.add(res);
  push(res, 'hello', { role, code: s.code, tv: s.tv.size > 0, phones: s.phones.size });

  if (isTv) {
    // 电视端上线：通知已经在等的手机，并把当前状态回灌给它（手机可能先连）
    broadcast(s.phones, 'tvup', { code: s.code });
    if (s.state) push(res, 'state', s.state);
  } else {
    if (s.tv.size === 0) push(res, 'waiting', { code: s.code });
    if (s.state) push(res, 'state', s.state);
  }

  // 25 秒心跳：撑住中间任何一层（路由器 / 反代 / 浏览器）的空闲连接回收
  const ping = setInterval(() => {
    if (!push(res, 'ping', { t: Date.now() })) { try { clearInterval(ping); } catch { /* ignore */ } }
  }, 25000);

  const bye = () => {
    try { clearInterval(ping); } catch { /* ignore */ }
    set.delete(res);
    s.lastAt = Date.now();
    if (isTv && s.tv.size === 0) broadcast(s.phones, 'closed', { reason: 'tv-offline' });
  };
  res.on('close', bye);
  res.on('error', bye);
  return true;
}

function cmd(s, body) {
  s.lastAt = Date.now();
  const action = String((body && body.action) || '').trim();
  if (!action) return { ok: false, error: '缺少 action' };
  const msg = {
    action,
    value: body && body.value !== undefined ? body.value : null,
    at: Date.now(),
  };
  const n = broadcast(s.tv, 'cmd', msg);
  return { ok: true, delivered: n };
}

function state(s, body) {
  s.lastAt = Date.now();
  const patch = body && typeof body === 'object' ? body : {};
  s.state = Object.assign({}, s.state || {}, patch, { at: Date.now() });
  const n = broadcast(s.phones, 'state', s.state);
  return { ok: true, delivered: n };
}

function info(s) {
  return {
    code: s.code,
    createdAt: s.createdAt,
    tv: s.tv.size,
    phones: s.phones.size,
    state: s.state,
  };
}

module.exports = { create, get, attach, cmd, state, info, sweep, sessions };
