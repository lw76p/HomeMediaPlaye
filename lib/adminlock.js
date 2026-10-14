'use strict';
/* ---------------- 管理密码（设置页门锁，服务端唯一真源） ----------------
   设计目标：让「设置」页不再是任何人都能改的 —— 媒体库目录、网盘账号、
   TMDB Key、AI 词表、儿童模式配置都在这一页。

   三层防护：
   1. 界面门：前端路由拦截 #/library，未解锁先弹密码框（`AdminLock`）。
   2. 后端门：设置类写接口（见 server.js 的 ADMIN_LOCK_WRITE）非 GET 一律校验
      解锁票据 —— 绕过网页直接 curl 也改不动。**这是与纯前端门的本质区别**。
   3. 票据：HMAC 签名的无状态 token 放 HttpOnly Cookie，有效期 12 小时；
      服务重启不失效（secret 存 DB），改了密码则旧票据自动作废（secret 重签）。

   三个刻意的设计选择：
   - **未设密码 = 不拦**（`isUnlocked` 恒 true）。总得有人先设密码；而且在用户
     明确设置之前把门锁死，会出现「谁也进不去设置」的死局。
   - **只拦设置类写操作，不拦读**。家里人正常看电影、听歌、翻相册、
     点顶栏「扫描」都不受影响，避免一个家庭应用处处要密码。
   - **PIN 用 scrypt 而非 sha256**。4~8 位数字的搜索空间只有 1e4~1e8，
     离线爆破 sha256 是秒级；scrypt 把每次尝试的成本抬到几十毫秒量级。
     代价是解锁时多等 ~70ms，可接受。 */
const crypto = require('node:crypto');
const db = require('./db');

const KEY = 'admin_lock';
const COOKIE = 'hmp_admin';
/* 演示站（HMP_DEMO=1）：管理密码功能整体关闭。
   演示站是给访客随便看的，任何一个人设了密码，后面来的人就进不去设置页了 ——
   而演示站本来也没有需要保护的东西。这里让模块整体「透明化」：isSet 恒 false
   （等价于从未设过密码 → isUnlocked 恒 true → 写接口不再拦）、setPwd 直接拒绝。
   即使库里残留了旧密码配置，也不会把演示站锁死。 */
const DEMO = /^(1|true|yes|on)$/i.test(String(process.env.HMP_DEMO || ''));
const TTL_MS = 12 * 3600 * 1000;   // 解锁有效期（小时）
const MAX_FAIL = 5;                // 连续失败次数
const COOL_MS = 60 * 1000;         // 达到上限后的冷却基数（每次超限翻倍）

function cfg() {
  const v = db.getSetting(KEY, null);
  if (!v) return {};
  if (typeof v === 'object') return v;                 // setSetting 已 stringify，getSetting 会 parse 回对象
  try { return JSON.parse(v) || {}; } catch { return {}; }
}
function save(c) { db.setSetting(KEY, c); return c; }

const norm = (p) => String(p == null ? '' : p).trim();
const isPinShape = (p) => /^\d{4,8}$/.test(p);

/* scrypt：N=16384/r=8 需 128*N*r = 16MB（默认 maxmem 32MB 够用） */
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), String(salt), 32, { N: 16384, r: 8, p: 1 }).toString('hex');
}

function isSet() {
  if (DEMO) return false;
  const c = cfg();
  return !!(c.salt && c.hash);
}

function verify(pin) {
  const c = cfg();
  if (!c.salt || !c.hash) return false;
  const p = norm(pin);
  if (!isPinShape(p)) return false;
  let h;
  try { h = hashPin(p, c.salt); } catch { return false; }
  try { return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(c.hash)); } catch { return false; }
}

/* 首次设置 / 修改（已设过时必须验旧密码） */
function setPwd(pin, oldPin) {
  if (DEMO) throw new Error('演示站已关闭管理密码功能，无需也无法设置');
  const p = norm(pin);
  if (!isPinShape(p)) throw new Error('管理密码需为 4~8 位数字');
  const c = cfg();
  if (c.salt && c.hash && !verify(oldPin)) throw new Error('原密码不正确');
  c.salt = crypto.randomBytes(8).toString('hex');
  c.hash = hashPin(p, c.salt);
  // 换密码即换 secret：所有已发出的解锁票据立刻作废（改密码后重登一次才生效，符合预期）
  c.secret = crypto.randomBytes(32).toString('hex');
  c.setAt = Date.now();
  save(c);
  return true;
}

function secret() {
  const c = cfg();
  if (!c.secret) { c.secret = crypto.randomBytes(32).toString('hex'); save(c); }
  return c.secret;
}

const sign = (exp) => crypto.createHmac('sha256', secret()).update('admin|' + exp).digest('hex');

function issueToken() {
  const exp = Date.now() + TTL_MS;
  return exp + '.' + sign(exp);
}

function checkToken(tok) {
  if (!tok) return false;
  const s = String(tok);
  const i = s.indexOf('.');
  if (i <= 0) return false;
  const exp = Number(s.slice(0, i));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const want = sign(exp);
  const got = s.slice(i + 1);
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch { return false; }
}

function cookieToken(req) {
  const raw = String((req && req.headers && req.headers.cookie) || '');
  const m = raw.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

/* 是否已解锁。**未设密码时恒 true**（没密码可拦，等同于不锁） */
function isUnlocked(req) {
  if (DEMO || !isSet()) return true;   // 演示站无门可锁
  return checkToken(cookieToken(req));
}

function setCookieHeader(token) {
  return { 'Set-Cookie': COOKIE + '=' + encodeURIComponent(token) + '; Path=/; Max-Age='
    + Math.floor(TTL_MS / 1000) + '; SameSite=Lax; HttpOnly' };
}
function clearCookieHeader() {
  return { 'Set-Cookie': COOKIE + '=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly' };
}

/* ---- 失败节流（内存态，重启即清；防的是脚本爆破，不是持久封禁） ---- */
const fails = new Map();
function coolLeft(ip) {
  const f = fails.get(ip);
  if (!f || !f.until) return 0;
  const left = f.until - Date.now();
  if (left <= 0) { fails.delete(ip); return 0; }
  return left;
}
function markFail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= MAX_FAIL) f.until = Date.now() + COOL_MS * (f.n - MAX_FAIL + 1);
  fails.set(ip, f);
  return f;
}
function markOk(ip) { fails.delete(ip); }
function failsLeft(ip) {
  const f = fails.get(ip);
  return Math.max(0, MAX_FAIL - ((f && f.n) || 0));
}

function status() {
  return { set: isSet(), demo: DEMO, ttlHours: Math.round(TTL_MS / 3600000), maxFail: MAX_FAIL };
}

/* 「立即上锁」用：重签 secret 让**已发出的所有票据当场作废**。
   只清浏览器 cookie 是不够的 —— token 是无状态的，拿着旧 token 手工请求照样能改设置。
   代价是所有设备（含自己的手机）都要重新解锁，这正是「上锁」应有的语义。 */
function bumpSecret() {
  const c = cfg();
  c.secret = crypto.randomBytes(32).toString('hex');
  save(c);
  return true;
}

/* 忘记密码时的重置入口（NAS 侧脚本调用；网页端不提供，否则锁形同虚设） */
function reset() {
  db.setSetting(KEY, {});
  fails.clear();
  return true;
}

module.exports = {
  isSet, setPwd, verify, isUnlocked, issueToken, checkToken,
  setCookieHeader, clearCookieHeader, bumpSecret, coolLeft, markFail, markOk, failsLeft,
  status, reset, COOKIE, TTL_MS, DEMO,
};
