'use strict';
// Web 版二进制定位：ffprobe / ffmpeg（mpv 仅桌面版播放需要，Web 版不需要）
// 解析顺序：环境变量 HMP_FFMPEG / HMP_FFPROBE → 项目 resources/bin/<os>/ → 系统 PATH
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function findOnPath(name) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [name], { encoding: 'utf8', windowsHide: true });
    const first = String(out || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

// go++：名字必须按平台加后缀。旧版写死 'ffprobe.exe'，Linux/NAS 上文件叫
// 'ffprobe'（无 .exe），导致 which 找不到 → status() 返回 null → 视频全部被判
// 「损坏」→ 质量分并列 → 保留判定退化成按 mtime 猜。见 verify 日志。
const IS_WIN = process.platform === 'win32';
const binName = (base) => (IS_WIN ? base + '.exe' : base);

function fromProjectBin(base) {
  const osDir = IS_WIN ? 'win' : process.platform;
  const name = binName(base);
  const p = path.join(__dirname, '..', '..', 'resources', 'bin', osDir, name);
  return fs.existsSync(p) ? p : null;
}

// 项目携带的 runtime/ 目录兜底（NAS 安装器把 ffmpeg/ffprobe 放这里，但
// start.sh 未必导出环境变量；少一道依赖就少一次「探测静默失败」）
function fromRuntimeDir(base) {
  const name = binName(base);
  const cands = [
    path.join(__dirname, '..', 'runtime', name),
    path.join(__dirname, '..', '..', 'runtime', name),
  ];
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch { /* ignore */ } }
  return null;
}

function resolveBin(base, envKey) {
  const env = process.env[envKey];
  if (env && fs.existsSync(env)) return env;
  return fromProjectBin(base) || fromRuntimeDir(base) || findOnPath(binName(base));
}

let cached = null;

function status() {
  if (cached) return cached;
  const ffprobe = resolveBin('ffprobe', 'HMP_FFPROBE');
  const ffmpeg = resolveBin('ffmpeg', 'HMP_FFMPEG');
  cached = {
    ffprobe,
    ffmpeg,
    ready: !!(ffprobe && ffmpeg),
    missing: [
      !ffprobe && 'ffprobe',
      !ffmpeg && 'ffmpeg',
    ].filter(Boolean),
  };
  return cached;
}

module.exports = { status, resetCache: () => { cached = null; }, binName };
