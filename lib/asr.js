'use strict';
/* AI 字幕生成（whisper.cpp 本地推理，全程不联网、不上传任何数据）
 *
 * 流水线：runtime/ffmpeg 抽 16kHz 单声道 wav（数据目录临时文件）
 *   → runtime/whisper/whisper-cli 生成 srt
 *   → 与视频同目录落盘 <视频主名>.asr.srt
 *   → 写 asr_tracks 表（text/seg_json 留给 P1 字幕搜索与时间戳跳播）
 *
 * 设计约定：
 * - 探测失败整模块降级（ready=false），不影响其他功能（同 ai.js 范式）
 * - 命名 .asr.srt：subtitles.js 前缀匹配可直接吃掉；「asr」不在中文标记表里，
 *   加分永远低于人工字幕（人工 100/110 > AI 80），装了人工字幕自动让位
 * - 长任务复用 cleanup.js 范式：串行队列 + runStatus/abortRun + 分片让出事件循环
 * - 只对本地路径生成（webdav:/alist: 网盘文件不落 .asr.srt，属后续课题）
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const db = require('./db');
const paths = require('./paths');
const bins = require('./binaries');
const subtitles = require('./subtitles');

const yieldNow = () => new Promise((r) => setImmediate(r));

/* ---------------- 运行时探测 ---------------- */

const EXE = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';

function resolveWhisper() {
  // 1) 显式环境变量优先（多实例 / 非标准布局时手动指定，避免「明明装了却报未安装」）
  const env = process.env.HMP_WHISPER;
  if (env && fs.existsSync(env)) return env;

  // 2) 已知固定候选
  const cands = [
    path.join(__dirname, '..', 'runtime', 'whisper', EXE),                    // NAS 安装布局（app/runtime）
    path.join(__dirname, '..', '..', 'runtime', 'whisper', EXE),              // 项目根布局（root/runtime）
    path.join(__dirname, '..', '..', 'resources', 'bin', process.platform, 'whisper', EXE), // 桌面版
  ];
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch { /* ignore */ } }

  // 3) 向上回溯：从脚本目录与进程目录逐层查找 runtime/whisper/<EXE>
  //    兼容 HMP-TEST(app 在 HMP-TEST/app，运行时在 HMP-APP/runtime) 等任意嵌套布局
  const roots = new Set([__dirname, process.cwd()]);
  for (const root of roots) {
    let cur = root;
    for (let i = 0; i < 8 && cur && cur !== path.dirname(cur); i++) {
      const p = path.join(cur, 'runtime', 'whisper', EXE);
      try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
      cur = path.dirname(cur);
    }
  }
  return null;
}

function modelsDir() {
  const w = resolveWhisper();
  return path.join(w ? path.dirname(w) : path.join(__dirname, '..', 'runtime', 'whisper'), 'models');
}

// 模型优先级：base 速度/质量平衡（方案 §6.3 默认档），small 准度更好但慢 2 倍
const MODEL_PREF = ['base', 'small', 'tiny', 'medium', 'large-v3-turbo', 'large-v3', 'large'];

function listModels() {
  const dir = modelsDir();
  const out = [];
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!/^ggml-.+\.bin$/i.test(n)) continue;
      let size = 0;
      try { size = fs.statSync(path.join(dir, n)).size; } catch { /* ignore */ }
      out.push({ name: n.replace(/^ggml-/, '').replace(/\.bin$/i, ''), file: path.join(dir, n), size });
    }
  } catch { /* ignore */ }
  return out;
}

function pickModel(want) {
  const models = listModels();
  if (!models.length) return null;
  if (want) {
    const hit = models.find((m) => m.name === want);
    if (hit) return hit;
  }
  for (const pref of MODEL_PREF) {
    const hit = models.find((m) => m.name === pref || m.name.startsWith(pref));
    if (hit) return hit;
  }
  return models[0];
}

/* ---------------- 库表（asr_tracks） ---------------- */

let schemaReady = false;
function ensureSchema() {
  if (schemaReady) return;
  db.run(`CREATE TABLE IF NOT EXISTS asr_tracks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id   INTEGER,
    path       TEXT    NOT NULL,
    dir        TEXT    DEFAULT '',
    file_name  TEXT    DEFAULT '',
    srt_path   TEXT    DEFAULT '',
    lang       TEXT    DEFAULT '',
    model      TEXT    DEFAULT '',
    duration   REAL,
    text       TEXT    DEFAULT '',
    seg_json   TEXT    DEFAULT '',
    status     TEXT    NOT NULL DEFAULT 'done',
    error      TEXT    DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT 0
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_asr_media ON asr_tracks(media_id)');
  schemaReady = true;
}

function trackCount() {
  try { ensureSchema(); const r = db.get('SELECT COUNT(*) AS c FROM asr_tracks WHERE status = ?', ['done']); return r ? r.c : 0; }
  catch { return 0; }
}

/* ---------------- 候选：缺字幕的影片 ---------------- */

const isCloudPath = (p) => /^(webdav|alist):/i.test(String(p || ''));

// AI 字幕落盘名：<视频主名>.asr.srt（同目录）
function srtPathFor(row) {
  const base = String(row.file_name || path.basename(row.path)).replace(/\.[^.]+$/, '');
  return path.join(row.dir || path.dirname(row.path), `${base}.asr.srt`);
}

async function listMissing({ limit = 500 } = {}) {
  ensureSchema();
  const rows = db.all(
    `SELECT id, path, dir, file_name, duration, kind, title, season, episode
       FROM media_files
      WHERE kind IN ('movie','episode')
        AND duration >= 120
        AND path NOT LIKE 'webdav:%' AND path NOT LIKE 'alist:%'
        AND id NOT IN (SELECT media_id FROM asr_tracks WHERE status = 'done')
      ORDER BY (duration IS NULL), duration ASC`
  );
  const items = [];
  for (const r of rows) {
    if (items.length >= limit) break;
    let exists = false;
    try { exists = fs.existsSync(srtPathFor(r)); } catch { /* ignore */ }
    if (exists) continue; // 磁盘上已有 AI 字幕（如重装后库表丢失）→ 视为已处理
    items.push(r);
    if ((items.length & 63) === 0) await yieldNow();
  }
  return { count: rows.length, limit, items };
}

/* ---------------- 长任务状态（cleanup.js 范式） ---------------- */

const runState = {
  running: false, abort: false,
  total: 0, done: 0, ok: 0, failed: 0, skipped: 0,
  current: '', currentTitle: '', pct: 0,
  model: '', startedAt: 0, finishedAt: 0,
  proc: null,           // 当前 whisper 子进程（中止时硬杀）
  recent: [],           // 最近完成项 [{title, ok, sec, lang, error}]
  batch: 1,             // 连续模式当前批次号（从 1 起）
  autoDone: false,      // 连续模式跑完全库后置 true
  remainAll: 0,         // 全库剩余缺字幕候选数（供前端展示）
};

function runStatus() {
  const done = runState.done;
  let etaSec = null;
  if (runState.running && done > 0 && runState.ok + runState.failed > 0) {
    const elapsed = (Date.now() - runState.startedAt) / 1000;
    const avg = elapsed / (runState.ok + runState.failed);
    etaSec = Math.round(avg * Math.max(0, runState.total - done));
  }
  return {
    running: runState.running, total: runState.total, done,
    ok: runState.ok, failed: runState.failed, skipped: runState.skipped,
    current: runState.running ? runState.current : '',
    currentTitle: runState.running ? runState.currentTitle : '',
    pct: runState.pct, model: runState.model,
    startedAt: runState.startedAt, finishedAt: runState.finishedAt,
    batch: runState.batch || 1, autoDone: !!runState.autoDone, remainAll: runState.remainAll || 0,
    etaSec, recent: runState.recent.slice(-8).reverse(),
  };
}

const abortRun = () => {
  if (runState.running) {
    runState.abort = true;
    try { if (runState.proc) runState.proc.kill('SIGKILL'); } catch { /* ignore */ }
  }
  return { ok: true };
};

const pushRecent = (item) => {
  runState.recent.push(item);
  if (runState.recent.length > 32) runState.recent.splice(0, runState.recent.length - 32);
};

/* ---------------- 子进程（带超时与进度回调） ---------------- */

function runProc(cmd, args, timeoutMs, onData, onSpawn) {
  return new Promise((resolve) => {
    let stderr = '';
    let killed = false;
    let p;
    try {
      p = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, stderr: e.message, killed: false });
    }
    if (onSpawn) { try { onSpawn(p); } catch { /* ignore */ } }
    const timer = setTimeout(() => {
      killed = true;
      try { p.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    p.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 60000) stderr = stderr.slice(-30000);
      if (onData) onData(d.toString());
    });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stderr: stderr.slice(-4000) + e.message, killed }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr: stderr.slice(-4000), killed }); });
    return p;
  });
}

/* ---------------- srt 解析（存库供 P1 搜索/跳播） ---------------- */

function srtCues(srt) {
  const cues = [];
  const tc = (t) => {
    const m = String(t).trim().match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/);
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
  };
  for (const block of String(srt || '').replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n').filter((x) => x.trim() !== '');
    if (lines.length < 2) continue;
    const tm = lines[1].match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/);
    if (!tm) continue;
    const text = lines.slice(2).join('\n').trim();
    if (!text) continue;
    cues.push({ s: Math.round(tc(tm[1]) * 100) / 100, e: Math.round(tc(tm[2]) * 100) / 100, t: text });
  }
  return cues;
}

/* ---------------- 单文件生成 ---------------- */

async function generateOne(row, ctx) {
  const title = row.title || row.file_name || path.basename(row.path);
  runState.current = row.path;
  runState.currentTitle = title;
  runState.pct = 0;
  const t0 = Date.now();

  // 文件已消失 / 网盘路径 → 跳过
  if (isCloudPath(row.path)) { runState.skipped += 1; pushRecent({ title, ok: false, skipped: true, error: '网盘路径暂不支持' }); return; }
  let st = null;
  try { st = await fsp.stat(row.path); } catch { /* ignore */ }
  if (!st || !st.isFile()) { runState.skipped += 1; pushRecent({ title, ok: false, skipped: true, error: '文件不存在' }); return; }
  const srtOut = srtPathFor(row);
  if (!ctx.force) {
    try { if (fs.existsSync(srtOut)) { runState.skipped += 1; pushRecent({ title, ok: false, skipped: true, error: '已有 AI 字幕' }); return; } } catch { /* ignore */ }
  }

  // 1) ffmpeg 抽 16kHz 单声道 wav
  const ffmpeg = (bins.status() || {}).ffmpeg;
  if (!ffmpeg) { runState.failed += 1; pushRecent({ title, ok: false, sec: 0, error: 'ffmpeg 不可用' }); return; }
  const wav = path.join(paths.dirs.cache(), `asr-${row.id}.wav`);
  try { await fsp.unlink(wav); } catch { /* ignore */ }
  runState.pct = 1;
  const ext = await runProc(ffmpeg, ['-nostdin', '-y', '-i', row.path, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav],
    Math.max(120000, (row.duration || 0) * 2 * 1000), null, (p) => { runState.proc = p; });
  if (ext.code !== 0) {
    try { await fsp.unlink(wav); } catch { /* ignore */ }
    runState.failed += 1;
    pushRecent({ title, ok: false, sec: (Date.now() - t0) / 1000, error: '音频抽取失败' + (ext.killed ? '（超时）' : '') });
    return;
  }

  // 2) whisper-cli 转写（-of 前缀 → 产出 <前缀>.srt）
  const threads = Math.max(2, Math.min(8, os.cpus().length));
  const args = ['-m', ctx.modelPath, '-f', wav, '-t', String(threads), '-pp', '-osrt', '-of', srtOut.slice(0, -4)];
  const lang = String(ctx.lang || 'auto');
  if (lang && lang !== 'auto') args.push('-l', lang);
  const t1 = Date.now();
  const r = await runProc(ctx.whisper, args, Math.max(900000, (row.duration || 0) * 2 * 1000), (chunk) => {
    const m = chunk.match(/progress\s*=\s*(\d{1,3})%/);
    if (m) runState.pct = Math.min(99, parseInt(m[1], 10));
  }, (p) => { runState.proc = p; });
  const langDetected = (r.stderr.match(/auto-detected language:\s*(\S+)/i) || [])[1] || lang;
  try { await fsp.unlink(wav); } catch { /* ignore */ }

  let srtBuf = null;
  try { srtBuf = await fsp.readFile(srtOut); } catch { /* ignore */ }
  if (r.code !== 0 || !srtBuf || !srtBuf.length) {
    try { if (srtBuf == null) await fsp.unlink(srtOut); } catch { /* ignore */ }
    runState.failed += 1;
    pushRecent({ title, ok: false, sec: (Date.now() - t0) / 1000, error: 'whisper 转写失败' + (r.killed ? '（超时/中止）' : '') });
    return;
  }

  // 3) 写库
  const cues = srtCues(srtBuf.toString('utf8'));
  const text = cues.map((c) => c.t).join('\n');
  try {
    db.run(
      `INSERT INTO asr_tracks (media_id, path, dir, file_name, srt_path, lang, model, duration, text, seg_json, status, error, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'done', '', ?)`,
      [row.id, row.path, row.dir || '', row.file_name || path.basename(row.path), srtOut,
        langDetected, ctx.modelName, row.duration || null, text, JSON.stringify(cues).slice(0, 4 * 1024 * 1024), Date.now()]
    );
  } catch { /* 表写入失败不影响字幕文件本身 */ }

  runState.ok += 1;
  runState.pct = 100;
  pushRecent({ title, ok: true, sec: Math.round((Date.now() - t1) / 1000), lang: langDetected, cues: cues.length });
}

async function processQueue(items, ctx) {
  for (const row of items) {
    if (runState.abort) break;
    try { await generateOne(row, ctx); } catch (e) {
      runState.failed += 1;
      pushRecent({ title: row.title || row.file_name, ok: false, error: e.message });
    }
    runState.done += 1;
    runState.pct = 0;
    await yieldNow();
  }
}

/* 连续模式：一批跑完自动扫下一批（时长最短的先来），直到全库无候选或用户中止。
 * running 在整个循环期间保持 true（批间不清），前端轮询不会在批间误判完成。 */
async function autoLoop(items, ctx) {
  runState.batch = 1;
  runState.autoDone = false;
  const tried = new Set(items.map((r) => r.id)); // 防饿死：失败/跳过的影片本 run 内不重试
  try {
    while (true) {
      await processQueue(items, ctx);
      if (runState.abort || !ctx.auto) break;
      const next = await listMissing({ limit: 500 });
      const fresh = next.items.filter((r) => !tried.has(r.id));
      if (!fresh.length) { runState.autoDone = true; break; }
      for (const r of fresh) tried.add(r.id);
      items = fresh;
      runState.batch += 1;
      runState.total = items.length;
      runState.done = 0; runState.ok = 0; runState.failed = 0; runState.skipped = 0;
      runState.current = ''; runState.currentTitle = ''; runState.pct = 0;
      runState.recent = [];
      runState.remainAll = next.count;
      await yieldNow();
    }
  } finally {
    runState.running = false;
    runState.proc = null;
    runState.current = '';
    runState.currentTitle = '';
    runState.pct = 0;
    runState.finishedAt = Date.now();
    runState.abort = false;
  }
}

/* ---------------- 对外入口 ---------------- */

async function run({ ids = null, model = null, lang = '', force = false, limit = 0, auto = false } = {}) {
  ensureSchema();
  const whisper = resolveWhisper();
  if (!whisper) return { ok: false, code: 412, error: 'whisper 运行时未安装（runtime/whisper/whisper-cli 缺失）' };
  const chosen = pickModel(model);
  if (!chosen) return { ok: false, code: 412, error: '未找到可用模型（runtime/whisper/models/ggml-*.bin）' };
  if (runState.running) return { ok: false, code: 429, error: '字幕生成已在进行中，请等当前批次完成或先中止' };

  let items;
  if (Array.isArray(ids) && ids.length) {
    items = [];
    for (const id of ids) {
      const n = parseInt(id, 10);
      if (!Number.isFinite(n)) continue;
      const r = db.get('SELECT id, path, dir, file_name, duration, kind, title FROM media_files WHERE id = ?', [n]);
      if (r) items.push(r);
    }
  } else {
    items = (await listMissing({ limit: limit || 100000 })).items;
  }
  if (!items.length) return { ok: true, started: false, total: 0, message: '没有需要生成字幕的影片' };

  runState.running = true;
  runState.abort = false;
  runState.total = items.length;
  runState.done = 0; runState.ok = 0; runState.failed = 0; runState.skipped = 0;
  runState.current = ''; runState.currentTitle = ''; runState.pct = 0;
  runState.model = chosen.name;
  runState.startedAt = Date.now();
  runState.finishedAt = 0;
  runState.recent = [];
  runState.batch = 1;
  runState.autoDone = false;

  try { runState.remainAll = (await listMissing({ limit: 1 })).count; } catch { /* ignore */ }
  const ctx = { whisper, modelPath: chosen.file, modelName: chosen.name, lang, force: !!force, auto: !!auto };
  autoLoop(items, ctx).catch(() => {
    runState.running = false;
    runState.finishedAt = Date.now();
  }); // 后台串行执行，接口立刻返回
  return { ok: true, started: true, total: items.length, model: chosen.name };
}

function status() {
  const whisper = resolveWhisper();
  const models = listModels();
  const chosen = pickModel(null);
  return {
    ready: !!(whisper && models.length),
    whisper,
    models,
    model: chosen ? chosen.name : null,
    ffmpeg: (bins.status() || {}).ffmpeg || null,
    tracks: trackCount(),
    run: runStatus(),
  };
}

module.exports = { status, listMissing, run, runStatus, abortRun, ensureSchema, srtPathFor, liveStart, liveStatus, liveStop, liveSegVtt };

/* ---------------- 准实时字幕（live 会话：按播放位置分段转写，播到哪跟到哪） ----------------
 * 与整集转写（run）的区别：不抽全片 wav、不写库、不落影片目录——只按 120s 段落
 * 从播放位置起顺序「ffmpeg 抽段音频 → whisper 转写 → srt 平移成绝对轴 VTT」，
 * 每段完成即刻可被前端拉取挂载（首段约 1 分钟内出字，整集 10~20 分钟的问题就此解决）。
 * 互斥：全局同一时刻只有一个 live 会话；整集 run 进行中拒绝 live（CPU 独占）。
 * 落盘：data/cache/asrlive/<mediaId>/seg<k>.vtt（会话重启时整目录重建）。 */
const liveSegSec = 60;   // artp17：120s→60s。实测 NAS 上 whisper base 转 120s 音频要 ~160s，
                         // 缩到 60s 后首段约 1 分钟出字（段数变多但每段更快，且追进度更跟手）。
const live = {
  mediaId: 0, title: '', srcPath: '', from: 0, duration: 0, segs: [],
  running: false, busy: false, stopFlag: false, proc: null, err: '',
  whisper: '', modelPath: '', modelName: '', lang: 'auto',
};

function liveStatus() {
  return {
    running: live.running,
    mediaId: live.mediaId,
    title: live.title,
    segSec: liveSegSec,
    currentFrom: live.running ? live.from : 0,
    duration: live.duration,
    segs: live.segs.map((s) => ({ n: s.n, from: s.from, to: s.to, ready: !!s.ready, error: s.error || '' })),
    error: live.err || '',
  };
}

function liveStop() {
  if (!live.running && !live.busy) return { ok: true, stopped: false };
  live.stopFlag = true;
  try { if (live.proc) live.proc.kill('SIGKILL'); } catch { /* ignore */ }
  return { ok: true, stopped: true };
}

function liveSegVtt(mediaId, n) {
  if (!live.running && !live.busy) { /* 会话已结束也允许读尾段 */ }
  if (Number(live.mediaId) !== Number(mediaId)) return null;
  const nInt = parseInt(n, 10);
  if (!(nInt >= 0) || !live.segs[nInt] || !live.segs[nInt].ready) return null;
  const f = path.join(paths.dirs.cache(), 'asrlive', String(live.mediaId), `seg${nInt}.vtt`);
  try { if (!fs.existsSync(f)) return null; return fs.readFileSync(f); } catch { return null; }
}

/* 单段：抽音频 → whisper → 绝对轴 VTT */
async function liveSegOne(n, from) {
  const to = Math.min(from + liveSegSec, live.duration || from + liveSegSec);
  const dir = path.join(paths.dirs.cache(), 'asrlive', String(live.mediaId));
  fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, `seg${n}.wav`);
  const srtPrefix = path.join(dir, `seg${n}`);
  const srtOut = srtPrefix + '.srt';
  const vttOut = path.join(dir, `seg${n}.vtt`);
  const ffmpeg = (bins.status() || {}).ffmpeg;
  if (!ffmpeg) throw new Error('ffmpeg 不可用');
  const ex = await runProc(ffmpeg,
    ['-nostdin', '-y', '-ss', String(from), '-i', live.srcPath, '-t', String(liveSegSec), '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav],
    240000, null, (p) => { live.proc = p; });
  if (ex.code !== 0) throw new Error('段落音频抽取失败');
  const args = ['-m', live.modelPath, '-f', wav, '-t', '4', '-pp', '-osrt', '-of', srtPrefix];
  if (live.lang && live.lang !== 'auto') args.push('-l', live.lang);
  const r = await runProc(live.whisper, args, 900000, null, (p) => { live.proc = p; });
  try { await fsp.unlink(wav); } catch { /* ignore */ }
  if (r.code !== 0) throw new Error('whisper 转写失败' + (r.killed ? '（中止）' : ''));
  const srtBuf = await fsp.readFile(srtOut).catch(() => null);
  try { await fsp.unlink(srtOut); } catch { /* ignore */ }
  if (!srtBuf || !srtBuf.length) throw new Error('whisper 无输出');
  const vtt = subtitles.toVtt(srtBuf, `seg${n}.srt`, from); // 时间轴平移到绝对内容位置
  if (vtt == null) throw new Error('srt→vtt 转换失败');
  await fsp.writeFile(vttOut, vtt, 'utf8');
  return true;
}

async function liveLoop() {
  try {
    let n = 0;
    while (!live.stopFlag) {
      const from = live.from;
      if (live.duration && from >= live.duration - 5) break;
      const s = { n, from, to: Math.min(from + liveSegSec, live.duration || from + liveSegSec), ready: false, error: '' };
      live.segs.push(s);
      try {
        await liveSegOne(n, from);
        s.ready = true;
      } catch (e) {
        if (live.stopFlag) break;
        s.error = e.message; // 单段失败跳过继续，不卡死整条链路
      }
      n += 1;
      live.from = s.to;
      await yieldNow();
    }
  } catch (e) {
    live.err = e.message;
  } finally {
    live.running = false;
    live.busy = false;
    live.proc = null;
  }
}

async function liveStart(row, { position = 0, lang = '', model = null } = {}) {
  if (live.running || live.busy) {
    if (Number(live.mediaId) === Number(row.id)) return { ok: true, already: true, ...liveStatus() };
    return { ok: false, code: 409, error: '已有实时字幕会话在跑，请先停止' };
  }
  if (runState.running) return { ok: false, code: 409, error: '整集 AI 字幕转写进行中，暂不能开实时字幕' };
  const whisper = resolveWhisper();
  if (!whisper) return { ok: false, code: 412, error: 'whisper 运行时未安装（runtime/whisper/whisper-cli 缺失）' };
  const chosen = pickModel(model);
  if (!chosen) return { ok: false, code: 412, error: '未找到可用模型（runtime/whisper/models/ggml-*.bin）' };
  if (isCloudPath(row.path)) return { ok: false, code: 412, error: '网盘片源暂不支持实时字幕' };
  let st = null;
  try { st = await fsp.stat(row.path); } catch { /* ignore */ }
  if (!st || !st.isFile()) return { ok: false, code: 412, error: '文件不存在' };
  const dir = path.join(paths.dirs.cache(), 'asrlive', String(row.id));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  live.mediaId = row.id;
  live.title = row.title || row.file_name || path.basename(row.path);
  live.srcPath = row.path;
  live.from = Math.max(0, Math.floor(position || 0));
  live.duration = row.duration || 0;
  live.segs = [];
  live.stopFlag = false;
  live.err = '';
  live.whisper = whisper;
  live.modelPath = chosen.file;
  live.modelName = chosen.name;
  live.lang = lang || 'auto';
  live.running = true;
  live.busy = true;
  liveLoop().catch(() => { live.running = false; live.busy = false; });
  return { ok: true, segSec: liveSegSec, from: live.from, model: chosen.name };
}
