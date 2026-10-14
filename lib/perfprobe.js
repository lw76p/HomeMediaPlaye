'use strict';
/* 转码算力体检（perfprobe）
 * 背景：HMP 装在客户 NAS/电脑上，机器性能参差不齐——弱机被转码打满会「宕机」，
 *       8K/4K HEVC 这类极端源的软解负载完全未知。必须在安装后自动摸底，按档位调度。
 *
 * 做法：用自带 ffmpeg 跑一次 720p 10s 合成源转码（testsrc2，确定性强、与真机口径一致），
 *       测墙钟得「实时倍率」= 视频时长 / 墙钟，结合核数 / 内存 / SIMD 判档 S/A/B/C/D。
 * 结果存 settings 表（key=perfProbe），设置页可重测；30 天内有效自动复用。
 *
 * 档位语义（锚点：V1500B 四核 2.2G 影视源 720p veryfast = 8x → B 档。
 *   注意 probe 用 testsrc2 合成源，高频细节远比真实影视难压，同机同 preset 实测慢约一倍
 *   （V1500B testsrc2 仅 3.68x），故 minRatio 边界按影视口径整体除 2 校正）：
 *   S ≥10x 双路并发，preset fast
 *   A 5~10x 单路 veryfast
 *   B 2~5x 单路 veryfast（超高清降 ultrafast + 1080p）—— V1500B（3.68x）在这档
 *   C 1~2x 单路 ultrafast（超高清强制 720p）
 *   D <1x 禁用实时转码，只允许原片直连 / remux
 */
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const db = require('./db');
const bins = require('./binaries');

const KEY = 'perfProbe';
const VALID_MS = 30 * 24 * 3600 * 1000; // 体检结果 30 天有效

const TIERS = {
  S: { minRatio: 10, preset: 'fast',      presetBig: 'veryfast',  bigScaleW: 1920, maxConcurrent: 2, label: '强劲' },
  A: { minRatio: 5,  preset: 'veryfast',  presetBig: 'veryfast',  bigScaleW: 1920, maxConcurrent: 1, label: '良好' },
  B: { minRatio: 2,  preset: 'veryfast',  presetBig: 'ultrafast', bigScaleW: 1920, maxConcurrent: 1, label: '标准' },
  C: { minRatio: 1,  preset: 'ultrafast', presetBig: 'ultrafast', bigScaleW: 1280, maxConcurrent: 1, label: '偏弱' },
  D: { minRatio: 0,  preset: 'ultrafast', presetBig: 'ultrafast', bigScaleW: 1280, maxConcurrent: 1, label: '仅直连', transcodeDisabled: true },
};

function sysInfo() {
  const cpus = os.cpus() || [];
  let memAvailMB = null;
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)\s+kB/);
    if (m) memAvailMB = Math.round(parseInt(m[1], 10) / 1024);
  } catch { /* 非 Linux */ }
  let flags = '';
  try {
    flags = (fs.readFileSync('/proc/cpuinfo', 'utf8').match(/flags\s*:\s*([^\n]+)/) || [])[1] || '';
  } catch { /* ignore */ }
  return {
    cores: cpus.length,
    model: String((cpus[0] && cpus[0].model) || '').trim(),
    memAvailMB,
    simd: ['avx512f', 'avx2', 'fma', 'f16c', 'avx', 'sse4_2'].filter((f) => flags.includes(f)),
  };
}

function loadAvg() { // 1 分钟平均负载（非 Linux 返回 null）——高负载下体检会偏低判
  try { return Math.round(os.loadavg()[0] * 100) / 100; } catch { return null; }
}

function tierOf(ratio) {
  for (const [name, t] of Object.entries(TIERS)) if (ratio >= t.minRatio) return name;
  return 'D';
}

// 单次体检：720p 10s testsrc2 → libx264 veryfast，返回 {ok, wallSec, ratio}
function probeOnce(timeoutMs = 120000) {
  return new Promise((resolve) => {
    const ffmpeg = (bins.status() || {}).ffmpeg;
    if (!ffmpeg) return resolve({ ok: false, error: 'ffmpeg 不可用' });
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=10',
      '-c:v', 'libx264', '-preset', 'veryfast', '-an',
      '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1'];
    const t0 = Date.now();
    let settled = false;
    const child = spawn(ffmpeg, args, { windowsHide: true });
    child.stdout.resume(); // 必须消费输出，否则管道写满会卡死 ffmpeg
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ ok: false, error: '体检超时（机器过弱或 ffmpeg 异常）' });
    }, timeoutMs);
    child.on('error', (e) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ ok: false, error: '体检失败：' + e.message });
    });
    child.on('close', (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const wall = (Date.now() - t0) / 1000;
      if (code !== 0) return resolve({ ok: false, error: '体检失败：ffmpeg 退出码 ' + code });
      resolve({ ok: true, wallSec: Math.round(wall * 100) / 100, ratio: Math.round((10 / wall) * 100) / 100 });
    });
  });
}

function getCached() {
  try {
    const v = db.getSetting(KEY, null);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

/* force=false 时 30 天内直接复用缓存；安装后首次启动自动跑一次 */
async function probe({ force = false } = {}) {
  const cached = getCached();
  if (cached && !force && cached.testedAt && Date.now() - cached.testedAt < VALID_MS) {
    return { ok: true, cached: true, ...cached };
  }
  const r = await probeOnce();
  if (!r.ok) return r;
  const out = { tier: tierOf(r.ratio), ratio: r.ratio, wallSec: r.wallSec, ...sysInfo(), load1: loadAvg(), testedAt: Date.now() };
  try { db.setSetting(KEY, out); } catch { /* ignore */ }
  return { ok: true, cached: false, ...out };
}

let ensured = false;
function ensureProbed() { // 服务启动时调用（fire-and-forget，不阻塞）
  if (ensured) return;
  ensured = true;
  probe({}).catch(() => { /* 体检失败不影响服务 */ });
}

/* 转码调度取参：给 transcodeStream 用。无缓存时按保守默认（B 档） */
function transcodeProfile(srcWidth) {
  const c = getCached();
  const name = (c && c.tier) || 'B';
  const t = TIERS[name] || TIERS.B;
  const big = !!(srcWidth && srcWidth > 1920);
  return {
    tier: name,
    label: t.label,
    transcodeDisabled: !!t.transcodeDisabled,
    preset: big ? t.presetBig : t.preset,
    big,
    scaleW: big ? t.bigScaleW : 0,
    maxConcurrent: t.maxConcurrent,
  };
}

function status() {
  return { cached: getCached(), sys: sysInfo(), tiers: TIERS };
}

module.exports = { probe, ensureProbed, status, transcodeProfile, tierOf };
