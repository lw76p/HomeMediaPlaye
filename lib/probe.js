'use strict';
// 媒体探测（ffprobe）与本地封面生成（ffmpeg 抽帧）
// 对应 SRS F-LIB-003（识别媒体文件）与 F-META-005（海报墙）的本地实现
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const bins = require('./binaries');
const { dirs } = require('./paths');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { windowsHide: true, maxBuffer: 1024 * 1024 * 32, timeout: opts.timeout || 60000 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', error: err || null });
      }
    );
  });
}

async function probe(filePath) {
  const ffprobe = bins.status().ffprobe;
  if (!ffprobe) return { ok: false, reason: 'ffprobe 未就绪' };
  const res = await run(ffprobe, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  if (!res.ok || !res.stdout) {
    return { ok: false, reason: (res.stderr || 'ffprobe 执行失败').slice(0, 300) };
  }
  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    return { ok: false, reason: 'ffprobe 输出无法解析' };
  }
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition && s.disposition.attached_pic !== 1)
    || streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const fmt = data.format || {};
  let duration = parseFloat(fmt.duration);
  if (!Number.isFinite(duration) && v && v.duration) duration = parseFloat(v.duration);
  if (!Number.isFinite(duration)) duration = null;

  return {
    ok: true,
    duration,
    width: v ? v.width ?? null : null,
    height: v ? v.height ?? null : null,
    vcodec: v ? v.codec_name ?? null : null,
    acodec: a ? a.codec_name ?? null : null,
    audioTracks: streams.filter((s) => s.codec_type === 'audio').length,
    subtitleTracks: streams.filter((s) => s.codec_type === 'subtitle').length,
    container: fmt.format_name || null,
  };
}

// 封面规格：v2 = 800px 宽，兼顾卡片清晰度与首页 hero 大图
const POSTER_VERSION = 'v2';
const POSTER_WIDTH = 800;

function posterNameFor(filePath) {
  const h = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);
  return `${h}-${POSTER_VERSION}.jpg`;
}

// 抽帧生成封面；posRatio 默认取片长 30% 处（避开片头黑场）
async function makePoster(filePath, { duration = null, posRatio = 0.3, width = POSTER_WIDTH } = {}) {
  const ffmpeg = bins.status().ffmpeg;
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg 未就绪' };

  const name = posterNameFor(filePath);
  const outPath = path.join(dirs.posters(), name);
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
    return { ok: true, file: name, path: outPath, cached: true };
  }

  const candidates = [];
  if (duration && duration > 30) {
    candidates.push(Math.max(5, Math.min(duration * posRatio, duration - 5)));
  }
  candidates.push(30, 60, 10, 5, 1, 0);

  for (const ss of candidates) {
    const res = await run(
      ffmpeg,
      [
        '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-ss', String(ss),
        '-i', filePath,
        '-frames:v', '1',
        '-vf', `scale=${width}:-2:flags=lanczos`,
        '-q:v', '3',
        '-y', outPath,
      ],
      { timeout: 45000 }
    );
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
      return { ok: true, file: name, path: outPath, at: ss };
    }
    if (!res.ok && /Invalid data|does not contain/i.test(res.stderr) && ss === 0) break;
  }
  return { ok: false, reason: '抽帧失败（可能无视频轨或编码不受支持）' };
}

// Hero 大图：1600px 宽背景横图，独立版本号（规格变更自动重生成）
const BACKDROP_VERSION = 'bd1';
const BACKDROP_WIDTH = 1600;

function backdropNameFor(filePath) {
  const h = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);
  return `${h}-${BACKDROP_VERSION}.jpg`;
}

async function makeBackdrop(filePath, { duration = null } = {}) {
  const ffmpeg = bins.status().ffmpeg;
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg 未就绪' };
  const name = backdropNameFor(filePath);
  const outPath = path.join(dirs.posters(), name);
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 4096) {
    return { ok: true, file: name, path: outPath, cached: true };
  }
  // 大图取 35% 处（与卡片封面错开视角），候选时间点逐个回退
  const candidates = [];
  if (duration && duration > 60) {
    candidates.push(Math.max(5, Math.min(duration * 0.35, duration - 8)));
  }
  candidates.push(45, 90, 20, 8, 3, 0);
  for (const ss of candidates) {
    const res = await run(
      ffmpeg,
      [
        '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-ss', String(ss),
        '-i', filePath,
        '-frames:v', '1',
        '-vf', `scale=${BACKDROP_WIDTH}:-2:flags=lanczos`,
        '-q:v', '3',
        '-y', outPath,
      ],
      { timeout: 60000 }
    );
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 4096) {
      return { ok: true, file: name, path: outPath, at: ss };
    }
    if (!res.ok && /Invalid data|does not contain/i.test(res.stderr) && ss === 0) break;
  }
  return { ok: false, reason: '大图抽帧失败（可能无视频轨或编码不受支持）' };
}

module.exports = { probe, makePoster, posterNameFor, makeBackdrop, backdropNameFor, BACKDROP_WIDTH, run };
