'use strict';
// 通用图片缩略图（磁盘缓存 + 在途去重）
// 用途：音乐封面 / 电子书封面等原图直出场景（原图动辄 1~2MB，列表页几十张就拖垮主线程与带宽）
// 依赖 ffmpeg（lib/binaries 探测）；不可用时直接回落原图，不阻塞
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const bins = require('./binaries');
const paths = require('./paths');

let root = null;
const inflight = new Map(); // key -> Promise<path|null>

// ffmpeg 并发闸门：列表页首访会同时请求几十张图，若不限并发会瞬间拉起几十个 ffmpeg 进程
// 打满 NAS CPU，反而把整个服务拖成「切菜单卡死」。默认最多 3 个并行。
const MAX_JOBS = Math.max(1, parseInt(process.env.HMP_THUMB_CONC || '3', 10) || 3);
let running = 0;
const waiters = [];
function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      running++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          running--;
          const nx = waiters.shift();
          if (nx) nx();
        });
    };
    if (running < MAX_JOBS) run();
    else waiters.push(run);
  });
}

function rootDir() {
  if (!root) root = path.join(paths.dirs.cache(), 'img-thumbs');
  try { fs.mkdirSync(root, { recursive: true }); } catch { /* ignore */ }
  return root;
}

// 缓存键含源文件 mtime/size：源图变更自动失效，无需手动清理
function cacheKey(src, size) {
  let st;
  try { st = fs.statSync(src); } catch { return null; }
  if (!st.isFile()) return null;
  return crypto.createHash('sha1').update(src + '|' + st.mtimeMs + '|' + st.size + '|' + size)
    .digest('hex').slice(0, 20) + '-' + size + '.jpg';
}

function cached(src, size) {
  const k = cacheKey(src, size);
  if (!k) return null;
  const p = path.join(rootDir(), k);
  return fs.existsSync(p) ? p : null;
}

// 生成（或命中）缩略图；任何失败/无 ffmpeg 时返回 null，由调用方回落原图
function ensure(src, size) {
  const s = Math.max(32, Math.min(1600, Math.round(size) || 0));
  if (!s) return Promise.resolve(null);
  if (!src || !fs.existsSync(src)) return Promise.resolve(null);
  const hit = cached(src, s);
  if (hit) return Promise.resolve(hit);
  const k = cacheKey(src, s);
  if (!k) return Promise.resolve(null);
  if (inflight.has(k)) return inflight.get(k); // 并发同一张只跑一次 ffmpeg
  const ffmpeg = bins.status().ffmpeg;
  if (!ffmpeg) return Promise.resolve(null);
  const out = path.join(rootDir(), k);
  const p = withSlot(() => new Promise((resolve) => {
    execFile(ffmpeg, ['-y', '-i', src, '-vf', `scale='min(${s},iw)':-2`, '-frames:v', '1', '-q:v', '4', out],
      { windowsHide: true, timeout: 20000 }, (err) => {
        if (err || !fs.existsSync(out)) {
          try { fs.unlinkSync(out); } catch { /* ignore */ }
          return resolve(null);
        }
        resolve(out);
      });
  })).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

module.exports = { ensure, cached, rootDir };
