'use strict';
// OTA 在线升级（文件级增量）：manifest 列出每个代码文件的 sha256，
// 客户端 diff 本地 → 只下载变化文件 → vm 语法预检 → 备份旧版到 .ota-prev/ → 替换 → 自动重启。
// 零 npm 依赖；数据目录(data/)、运行时(vendor/)、网盘桥(openlist/) 永不触碰。
// manifest 缺省源：https://hmp.tsetch.com/ota/manifest.json（可用 HMP_OTA_MANIFEST 覆盖）。

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const APP_ROOT = path.join(__dirname, '..'); // .../app
const STAGING = path.join(APP_ROOT, '.ota-staging');
const PREV = path.join(APP_ROOT, '.ota-prev');
const VERSION_FILE = path.join(APP_ROOT, 'ota-version.json');
const DEFAULT_MANIFEST = process.env.HMP_OTA_MANIFEST || 'https://hmp.tsetch.com/ota/manifest.json';

// 只允许覆盖这些顶层路径（防止被篡改的 manifest 摸到 data/vendor）。
const ALLOW_TOP = new Set(['lib', 'public', 'tools']);
// 注意：绝不能含 ota-version.json —— 它由客户端自己写（带 updatedAt），
// 若允许 manifest 覆盖会造成「每次 check 都有差异」的永续 diff。
const ALLOW_FILES = new Set(['server.js', 'package.json']);

const state = {
  phase: 'idle',            // idle | checking | ready | downloading | applying | restarting | error
  error: '',
  manifestUrl: DEFAULT_MANIFEST,
  manifest: null,           // 最近一次拉到的 manifest
  diff: null,               // {download:[{path,size}], remove:[], unchanged:N, bytes:N}
  lastCheck: 0,
  progress: { file: '', done: 0, total: 0, bytes: 0, totalBytes: 0 },
  appliedVersion: 0,
  applying: false,
};

function safeJoin(rel) {
  // 归一化并拒绝越界 / 非白名单路径；返回绝对路径或 null
  const norm = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm || norm.includes('..') || norm.includes('\0')) return null;
  const top = norm.split('/')[0];
  if (!ALLOW_FILES.has(norm) && !ALLOW_TOP.has(top)) return null;
  if (/(^|\/)\.ota-/.test(norm)) return null;
  return path.join(APP_ROOT, ...norm.split('/'));
}

function localVersion() {
  try {
    const j = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
    return { version: Number(j.version) || 0, label: String(j.label || ''), builtAt: String(j.builtAt || '') };
  } catch { return { version: 0, label: '', builtAt: '' }; }
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (d) => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function yieldLoop() { return new Promise((r) => setImmediate(r)); }

async function fetchManifest() {
  const r = await fetch(state.manifestUrl, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`manifest HTTP ${r.status}`);
  const j = await r.json();
  if (!j || !Array.isArray(j.files) || !Number.isFinite(Number(j.version))) throw new Error('manifest 格式不对');
  return j;
}

// diff：对 manifest.files 逐个比对本地 sha256，产出需要下载/删除的清单
async function diffLocal(manifest) {
  const base = String(manifest.base || state.manifestUrl.replace(/[^/]*$/, ''));
  const download = []; let bytes = 0; let unchanged = 0;
  for (const f of manifest.files) {
    const abs = safeJoin(f.path);
    if (!abs) continue;
    const size = Number(f.size) || 0;
    let same = false;
    try { same = (await sha256File(abs)) === String(f.sha256 || '').toLowerCase(); } catch { same = false; }
    if (same) { unchanged++; } else { download.push({ path: f.path, size, url: base + f.path, sha256: String(f.sha256 || '').toLowerCase() }); bytes += size; }
    await yieldLoop();
  }
  const remove = [];
  for (const rp of (manifest.removed || [])) {
    const abs = safeJoin(rp);
    if (abs && fs.existsSync(abs)) remove.push({ path: rp, abs });
  }
  return { download, remove, unchanged, bytes };
}

async function downloadOne(item) {
  const dest = path.join(STAGING, ...item.path.split('/'));
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  const r = await fetch(item.url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`下载 ${item.path} HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (item.sha256 && crypto.createHash('sha256').update(buf).digest('hex') !== item.sha256) {
    throw new Error(`${item.path} sha256 不符`);
  }
  await fsp.writeFile(part, buf);
  await fsp.rename(part, dest);
}

async function copyTo(src, dst) { // 带目录创建的拷贝
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(src, dst);
}

// 语法预检：对 staging 里的 server.js + lib/*.js 用 vm.Script 编译（只编译不执行，零副作用）
async function precheckStaged() {
  const vm = require('node:vm');
  const targets = ['server.js'];
  const libDir = path.join(STAGING, 'lib');
  try { for (const f of await fsp.readdir(libDir)) if (f.endsWith('.js')) targets.push('lib/' + f); } catch {}
  for (const rel of targets) {
    const p = path.join(STAGING, ...rel.split('/'));
    if (!fs.existsSync(p)) continue;
    const code = await fsp.readFile(p, 'utf8');
    try { new vm.Script(code, { filename: rel }); } catch (e) { throw new Error(`预检失败 ${rel}: ${e.message}`); }
    await yieldLoop();
  }
}

// 应用升级：staging → 备份旧版 → 替换 → 删除清单 → 写版本号
async function applyStaged(manifest, diff) {
  await fsp.rm(PREV, { recursive: true, force: true });
  await fsp.mkdir(PREV, { recursive: true });
  // 1) 备份将被覆盖/删除的现有文件到 .ota-prev/（保留上一版，出问题可回滚）
  for (const item of diff.download) {
    const abs = safeJoin(item.path);
    if (abs && fs.existsSync(abs)) await copyTo(abs, path.join(PREV, ...item.path.split('/')));
  }
  for (const item of diff.remove) {
    const abs = safeJoin(item.path);
    if (abs && fs.existsSync(abs)) await copyTo(abs, path.join(PREV, ...item.path.split('/')));
  }
  await fsp.writeFile(path.join(PREV, 'ota-prev.json'), JSON.stringify({ from: localVersion().version, to: Number(manifest.version), at: Date.now(), files: diff.download.map((d) => d.path) }, null, 2));
  // 2) staging 逐文件 rename 到位（同盘 rename 原子且极快）
  for (const item of diff.download) {
    const abs = safeJoin(item.path);
    if (!abs) continue;
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.rename(path.join(STAGING, ...item.path.split('/')), abs);
    await yieldLoop();
  }
  // 3) 删除 manifest 声明移除的文件
  for (const item of diff.remove) { try { await fsp.unlink(item.abs); } catch {} }
  // 4) 写新版本号
  const ver = { version: Number(manifest.version), label: String(manifest.label || ''), builtAt: String(manifest.publishedAt || ''), updatedAt: new Date().toISOString() };
  await fsp.writeFile(VERSION_FILE, JSON.stringify(ver, null, 2));
  return ver;
}

// 自拉起重启：新进程 detached 独立存活，旧进程延迟退出（端口由 SO_REUSEADDR 快速交接）
function restartSelf() {
  const logFd = fs.openSync(path.join(APP_ROOT, '.ota-restart.log'), 'a');
  const child = spawn(process.execPath, [path.join(APP_ROOT, 'server.js')], {
    cwd: APP_ROOT, detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
  });
  child.unref();
  setTimeout(() => process.exit(0), 800);
}

/* ---- 对外 API ---- */

function progress() {
  let hasBackup = false;
  try { hasBackup = fs.existsSync(path.join(PREV, 'ota-prev.json')); } catch {}
  return {
    phase: state.phase, error: state.error, manifestUrl: state.manifestUrl,
    current: localVersion(), lastCheck: state.lastCheck, hasBackup,
    latest: state.manifest ? { version: Number(state.manifest.version), label: String(state.manifest.label || ''), notes: String(state.manifest.notes || ''), publishedAt: String(state.manifest.publishedAt || '') } : null,
    diff: state.diff, progress: state.progress, appliedVersion: state.appliedVersion,
  };
}

async function check() {
  if (state.applying) throw new Error('升级进行中');
  state.phase = 'checking'; state.error = '';
  try {
    const manifest = await fetchManifest();
    state.manifest = manifest;
    state.diff = await diffLocal(manifest);
    state.lastCheck = Date.now();
    state.phase = 'ready';
    return progress();
  } catch (e) {
    state.phase = 'error'; state.error = e.message;
    throw e;
  }
}

async function apply() {
  if (state.applying) throw new Error('升级已在进行中');
  if (!state.manifest || !state.diff) {
    await check(); // 未 check 过就先 check
    if (!state.diff || !state.diff.download.length) return progress();
  }
  state.applying = true;
  state.phase = 'downloading'; state.error = '';
  try {
    // 重新 diff（防止 check 后文件又变了），并复用 manifest
    const diff = await diffLocal(state.manifest);
    state.diff = diff;
    if (!diff.download.length && !diff.remove.length) {
      state.phase = 'idle'; state.applying = false;
      const ver = { version: Number(state.manifest.version), label: String(state.manifest.label || '') };
      await fsp.writeFile(VERSION_FILE, JSON.stringify({ ...ver, builtAt: String(state.manifest.publishedAt || ''), updatedAt: new Date().toISOString() }, null, 2)).catch(() => {});
      return progress();
    }
    state.progress = { file: '', done: 0, total: diff.download.length, bytes: 0, totalBytes: diff.bytes };
    await fsp.rm(STAGING, { recursive: true, force: true });
    await fsp.mkdir(STAGING, { recursive: true });
    for (const item of diff.download) {
      state.progress.file = item.path;
      await downloadOne(item);
      state.progress.done++; state.progress.bytes += item.size;
      await yieldLoop();
    }
    state.phase = 'applying';
    await precheckStaged();
    const ver = await applyStaged(state.manifest, diff);
    state.appliedVersion = ver.version;
    state.phase = 'restarting';
    restartSelf(); // 不返回 —— 800ms 后本进程退出
    return progress();
  } catch (e) {
    state.phase = 'error'; state.error = e.message; state.applying = false;
    await fsp.rm(STAGING, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

// 回滚：把 .ota-prev/ 恢复回去并重启（危险操作，调用方必须传 confirm=ROLLBACK）
async function rollback() {
  const metaPath = path.join(PREV, 'ota-prev.json');
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { throw new Error('没有可回滚的备份'); }
  for (const rel of (meta.files || [])) {
    const abs = safeJoin(rel);
    if (!abs) continue;
    const bak = path.join(PREV, ...rel.split('/'));
    if (fs.existsSync(bak)) await copyTo(bak, abs);
    else { try { await fsp.unlink(abs); } catch {} } // prev 里没有 = 上次升级新增的文件，删掉
    await yieldLoop();
  }
  // 版本号回写为备份时的来源版本
  await fsp.writeFile(VERSION_FILE, JSON.stringify({ version: Number(meta.from) || 0, label: 'rollback', updatedAt: new Date().toISOString() }, null, 2)).catch(() => {});
  await fsp.rm(PREV, { recursive: true, force: true }).catch(() => {});
  restartSelf();
  return { ok: true, restoredTo: Number(meta.from) || 0 };
}

module.exports = { progress, check, apply, rollback, safeJoin, localVersion };
