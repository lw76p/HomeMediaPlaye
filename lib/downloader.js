'use strict';
// 下载中心：HTTP/HTTPS 直链下载队列（零 npm 依赖）
// - 顺序队列（并发 2）、断点续传（Range + .part 临时文件）、暂停/继续/重试/删除
// - 文件名：优先手动指定 > Content-Disposition > URL 文件名 > 自动命名
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const db = require('./db');
const paths = require('./paths');

// 并发路数可调（1-5），存设置即时生效，默认 3
const FLUSH_MS = 1000;
const running = new Map(); // id -> { abort:fn }

function getConcurrency() {
  const n = Number(db.getSetting('dl_concurrency', 3));
  return Number.isFinite(n) && n >= 1 ? Math.max(1, Math.min(5, Math.floor(n))) : 3;
}
function setConcurrency(n) {
  const v = Math.max(1, Math.min(5, Math.floor(Number(n) || 3)));
  db.setSetting('dl_concurrency', v);
  kick();
  return getConcurrency();
}

function defaultDir() {
  return db.getSetting('dl_dir', '') || path.join(paths.dirs.root(), 'downloads');
}

function init() {
  db.run(`CREATE TABLE IF NOT EXISTS dl_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    name TEXT DEFAULT '',
    dir TEXT NOT NULL,
    file TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    downloaded INTEGER DEFAULT 0,
    speed INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',   -- pending|downloading|paused|done|error
    error TEXT DEFAULT '',
    created_at TEXT DEFAULT '',
    finished_at TEXT DEFAULT ''
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_dl_status ON dl_tasks(status, id)`);
  // 重启后 downloading 一律回归 pending（.part 保留，可续传）
  db.run(`UPDATE dl_tasks SET status='pending', speed=0 WHERE status='downloading'`);
  kick();
}

/* ---------------- 工具 ---------------- */
function suggestDirs() {
  const out = [];
  const push = (p) => { if (p && fs.existsSync(p) && fs.statSync(p).isDirectory() && !out.includes(p)) out.push(p); };
  push(defaultDir());
  for (const c of ['/share/Downloads', '/share/download', '/share/Multimedia', '/share/Public',
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'Downloads'),
    process.env.HOME && path.join(process.env.HOME, 'Downloads')]) {
    try { push(c); } catch { /* ignore */ }
  }
  return out;
}

function sanitizeName(n) {
  return String(n || '').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120).trim();
}

function fileNameFromUrl(u) {
  try { const p = new URL(u); return sanitizeName(decodeURIComponent(path.basename(p.pathname))) || ''; }
  catch { return ''; }
}
function fileNameFromDisp(d) {
  if (!d) return '';
  let m = /filename\*=(?:UTF-8''|utf-8'')([^;]+)/i.exec(d);
  if (m) { try { return sanitizeName(decodeURIComponent(m[1].trim().replace(/^"|"$/g, ''))); } catch { /* ignore */ } }
  m = /filename="?([^";]+)"?/i.exec(d);
  return m ? sanitizeName(m[1].trim()) : '';
}

function uniquePath(dir, name) {
  let p = path.join(dir, name);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let i = 1; i < 999; i++) {
    p = path.join(dir, `${base}(${i})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

function getTask(id) { return db.get(`SELECT * FROM dl_tasks WHERE id=?`, [id]); }
function listTasks() {
  return db.all(`SELECT * FROM dl_tasks ORDER BY
    CASE status WHEN 'downloading' THEN 0 WHEN 'pending' THEN 1 WHEN 'paused' THEN 2 WHEN 'error' THEN 3 ELSE 4 END,
    id DESC LIMIT 200`);
}

/* ---------------- 添加任务 ---------------- */
function addTask({ url, dir, name }) {
  url = String(url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https 直链下载');
  const targetDir = path.resolve(String(dir || '').trim() || defaultDir());
  fs.mkdirSync(targetDir, { recursive: true });
  const nm = sanitizeName(name) || fileNameFromUrl(url) || `download-${Date.now()}`;
  const file = uniquePath(targetDir, nm);
  const info = db.run(
    `INSERT INTO dl_tasks (url, name, dir, file, status, created_at) VALUES (?,?,?,?,'pending',?)`,
    [url, path.basename(file), targetDir, file, new Date().toISOString()]);
  const id = Number(info.lastInsertRowid);
  kick();
  return id;
}

function pauseTask(id) {
  const t = getTask(id);
  if (!t || !['pending', 'downloading'].includes(t.status)) return false;
  const r = running.get(id);
  if (r) r.abort();
  db.run(`UPDATE dl_tasks SET status='paused', speed=0 WHERE id=?`, [id]);
  return true;
}
function resumeTask(id) {
  const t = getTask(id);
  if (!t || t.status !== 'paused') return false;
  db.run(`UPDATE dl_tasks SET status='pending', error='' WHERE id=?`, [id]);
  kick();
  return true;
}
function retryTask(id) {
  const t = getTask(id);
  if (!t || !['error', 'done'].includes(t.status)) return false;
  db.run(`UPDATE dl_tasks SET status='pending', error='', downloaded=0, speed=0, finished_at='' WHERE id=?`, [id]);
  try { fs.rmSync(t.file + '.part', { force: true }); } catch { /* ignore */ }
  kick();
  return true;
}
function removeTask(id, delFile) {
  const t = getTask(id);
  if (!t) return false;
  const r = running.get(id);
  if (r) r.abort();
  if (delFile) {
    try { fs.rmSync(t.file, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(t.file + '.part', { force: true }); } catch { /* ignore */ }
  }
  db.run(`DELETE FROM dl_tasks WHERE id=?`, [id]);
  return true;
}

/* ---------------- 下载引擎 ---------------- */
let pumping = false;
function kick() { setImmediate(pump); }

function pump() {
  if (pumping) return;
  pumping = true;
  try {
    let slots = getConcurrency() - running.size;
    while (slots > 0) {
      const next = db.get(`SELECT id FROM dl_tasks WHERE status='pending' AND id NOT IN (${[...running.keys()].map(() => '?').join(',') || '0'}) ORDER BY id LIMIT 1`,
        [...running.keys()]);
      if (!next) break;
      startTask(next.id);
      slots -= 1;
    }
  } finally { pumping = false; }
}

function openWithRedirects(url, headers, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('重定向次数过多'));
    let u;
    try { u = new URL(url); } catch { return reject(new Error('URL 无效')); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('仅支持 http/https'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { headers, timeout: 20000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, u).href;
        req.destroy();
        return resolve(openWithRedirects(next, headers, depth + 1));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      resolve({ res, req, finalUrl: u.href });
    });
    req.on('timeout', () => { req.destroy(new Error('连接超时')); });
    req.on('error', reject);
  });
}

function startTask(id) {
  const t = getTask(id);
  if (!t) return;
  const ctrl = { abort: null, paused: false };
  running.set(id, ctrl);
  db.run(`UPDATE dl_tasks SET status='downloading', error='' WHERE id=?`, [id]);
  let outStream = null;
  (async () => {
    fs.mkdirSync(t.dir, { recursive: true });
    const partFile = t.file + '.part';
    let resumeFrom = 0;
    try { if (fs.existsSync(partFile)) resumeFrom = fs.statSync(partFile).size; } catch { resumeFrom = 0; }
    // 目标文件已存在（非续传场景）：换名，避免覆盖
    if (!resumeFrom && fs.existsSync(t.file)) {
      const nf = uniquePath(t.dir, t.name || path.basename(t.file));
      db.run(`UPDATE dl_tasks SET file=?, name=? WHERE id=?`, [nf, path.basename(nf), id]);
      t.file = nf;
    }
    const { res, req } = await openWithRedirects(t.url, {
      'User-Agent': 'HomeMediaPlayer-DL/1.0',
      'Accept': '*/*',
      ...(resumeFrom ? { 'Range': `bytes=${resumeFrom}-` } : {}),
    });
    ctrl.abort = () => { ctrl.paused = true; try { req.destroy(); } catch { /* ignore */ } };
    if (resumeFrom && res.statusCode !== 206) { // 服务器不支持续传，从头来
      resumeFrom = 0;
      await fsp.rm(partFile, { force: true });
    }
    const total = res.headers['content-length']
      ? Number(res.headers['content-length']) + resumeFrom : 0;
    let done = resumeFrom;
    let lastFlush = 0, lastBytes = resumeFrom, lastT = Date.now();
    db.run(`UPDATE dl_tasks SET size=?, downloaded=? WHERE id=?`, [total, done, id]);
    outStream = fs.createWriteStream(partFile, { flags: resumeFrom ? 'a' : 'w' });
    const out = outStream;
    await new Promise((ok, bad) => {
      res.on('data', (c) => {
        done += c.length;
        const now = Date.now();
        if (now - lastFlush >= FLUSH_MS) {
          const dt = Math.max(1, now - lastT);
          const speed = Math.round(((done - lastBytes) * 1000) / dt);
          lastFlush = now; lastBytes = done; lastT = now;
          db.run(`UPDATE dl_tasks SET size=?, downloaded=?, speed=? WHERE id=?`, [total, done, speed, id]);
        }
      });
      res.on('error', bad);
      out.on('error', bad);
      out.on('finish', ok);
      res.pipe(out);
    });
    if (total && done !== total) throw new Error('下载不完整');
    fs.renameSync(partFile, t.file);
    db.run(`UPDATE dl_tasks SET size=?, downloaded=?, speed=0, status='done', finished_at=? WHERE id=?`,
      [done, done, new Date().toISOString(), id]);
  })().catch((e) => {
    // 暂停触发的中断：req.destroy() 后响应流报 aborted，用 ctrl.paused 判定
    const paused = ctrl.paused || /abort|paused/i.test(String(e && e.message || ''));
    try { if (outStream) outStream.destroy(); } catch { /* ignore */ }
    db.run(`UPDATE dl_tasks SET status=?, speed=0, error=? WHERE id=?`,
      [paused ? 'paused' : 'error', paused ? '' : String(e && e.message || e), id]);
  }).finally(() => {
    // 只清理自己这一轮的句柄，避免误删重试/继续后新一轮任务的句柄
    if (running.get(id) === ctrl) running.delete(id);
    kick();
  });
}

/* ---------------- 导入本地文件续传 ---------------- */
// 迅雷式导入: 本地已有半截文件 + 直链。先探测服务器 Range/206 支持与总大小,
// 校验通过后把本地文件改名为 .part 交给下载引擎续传; 校验失败抛错且不动本地文件。
async function importTask({ url, file }) {
  url = String(url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https 直链下载');
  const src = path.resolve(String(file || '').trim());
  let st;
  try { st = fs.statSync(src); } catch { throw new Error('本地文件不存在: ' + src); }
  if (!st.isFile()) throw new Error('不是文件: ' + src);
  const have = st.size;
  if (have <= 0) throw new Error('本地文件是空的，直接用「添加下载」即可');
  // 探测: 向服务器要 bytes=have- 之后的剩余数据
  let total = 0;
  {
    const { res, req } = await openWithRedirects(url, {
      'User-Agent': 'HomeMediaPlayer-DL/1.0',
      'Accept': '*/*',
      'Range': `bytes=${have}-`,
    });
    res.resume();
    try { req.destroy(); } catch { /* ignore */ }
    if (res.statusCode === 206) {
      const m = /\/(\d+)\s*$/.exec(String(res.headers['content-range'] || ''));
      total = m ? Number(m[1]) : 0;
      if (!total) throw new Error('服务器未返回总大小（Content-Range），无法校验续传');
      if (have >= total) throw new Error(`本地文件已完整（本地 ${have} ≥ 服务器总 ${total} 字节），无需下载`);
    } else if (res.statusCode === 416) {
      throw new Error('本地文件大小超出服务器文件范围（可能已完整或版本不符），无法续传');
    } else {
      throw new Error(`服务器不支持断点续传（HTTP ${res.statusCode}，需支持 Range），无法导入续传`);
    }
  }
  const dir = path.dirname(src);
  const name = path.basename(src);
  fs.renameSync(src, src + '.part'); // 失败直接抛错，不产生脏任务
  try {
    const info = db.run(
      `INSERT INTO dl_tasks (url, name, dir, file, size, downloaded, status, created_at) VALUES (?,?,?,?,?,?,'pending',?)`,
      [url, name, dir, src, total, have, new Date().toISOString()]);
    kick();
    return Number(info.lastInsertRowid);
  } catch (e) {
    try { fs.renameSync(src + '.part', src); } catch { /* ignore */ }
    throw e;
  }
}

module.exports = { init, listTasks, getTask, addTask, importTask, pauseTask, resumeTask, retryTask, removeTask, suggestDirs, defaultDir, getConcurrency, setConcurrency };
