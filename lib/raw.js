'use strict';
// RAW 相机文件（NEF/ARW/CR2/CR3/DNG/RAF/ORF/RW2/…）纯 JS 支持
// 思路：不做去马赛克解码，而是把 RAW 内部**内嵌的 JPEG 预览**抽出来当图片用
//   - TIFF 家族（NEF/ARW/CR2/DNG/ORF/RW2/PEF/SRW）：文件里带全尺寸 JPEG 预览
//   - Fuji RAF：文件头 84/88 字节直接给出 JPEG 偏移与长度
//   - Canon CR3（BMFF）、X3F、IIQ：扫出所有 SOI 候选，再逐个做结构走查定位真实结尾
// 零依赖，只读文件；预览落盘缓存由调用方负责
//
// 关键难点：底片数据是高位随机噪声，天然会随机出现 FFD8FF（假 SOI）。
// 因此不能"找到一个 SOI 就向后找第一个 EOI"——假 SOI 会把真预览一并吞掉。
// 做法是：收集所有 SOI 候选 → 对每个候选独立做 JPEG 段结构走查（噪声几乎必挂）
//          → 走查通过（拿到合法尺寸并抵达 SOS）后才在其后定位 EOI → 取最大者。

const fs = require('node:fs');
const path = require('node:path');

const RAW_EXT = new Set([
  '.nef', '.nrw', '.cr2', '.cr3', '.crw', '.arw', '.srf', '.sr2', '.dng',
  '.raf', '.orf', '.rw2', '.raw', '.pef', '.srw', '.x3f', '.3fr', '.fff',
  '.iiq', '.mrw', '.rwl', '.kdc', '.dcr', '.erf', '.mef', '.mos', '.pxn',
  '.qtk', '.cap', '.r3d',
]);

const isRawExt = (ext) => RAW_EXT.has(String(ext || '').toLowerCase());

// 头部魔数嗅探：区分 TIFF 家族 / Fuji / CR3 / X3F / IIQ
function sniffRaw(head) {
  if (!head || head.length < 12) return null;
  const b0 = head[0], b1 = head[1], b2 = head[2], b3 = head[3];
  if (b0 === 0x49 && b1 === 0x49) { // II*
    const m = (b2 << 8) | b3;
    if (m === 0x2a00 || m === 0x5500 || m === 0x5200 || m === 0x4f00 || m === 0x5300) return 'raw-tiff';
  }
  if (b0 === 0x4d && b1 === 0x4d) { // MM
    const m = (b2 << 8) | b3;
    if (m === 0x002a || m === 0x004f || m === 0x0052) return 'raw-tiff';
  }
  if (head.subarray(0, 15).toString('latin1') === 'FUJIFILMCCD-RAW') return 'raw-raf';
  if (head.subarray(0, 4).toString('latin1') === 'FOVb') return 'raw-x3f';
  if (head.subarray(0, 4).toString('latin1') === 'IIII') return 'raw-iiq';
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1').replace(/\0+$/, '');
    if (/^crx/i.test(brand)) return 'raw-cr3';
    return null; // 其它 BMFF（heic/mp4）不是 RAW
  }
  return null;
}

/* ---------------- JPEG 结构工具 ---------------- */

// 解析 JPEG 尺寸（找 SOF0-SOF15）
function jpegSize(buf) {
  if (!buf || buf.length < 6) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const mk = buf[i + 1];
    if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }
    if (mk === 0xda || mk === 0xd9) break;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) break;
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

// 严格结构走查：从 SOI 起逐段解析到 SOS。返回 { w, h, sosAt }；不是真 JPEG 则 null。
// 底片噪声里的假 SOI 几乎必然在第一步就因“marker 未按 FFxx 对齐”出局。
function jpegProbe(buf, { minDim = 16, maxDim = 30000 } = {}) {
  if (!buf || buf.length < 32) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2, dim = null;
  for (let guard = 0; guard < 512; guard += 1) {
    if (i + 2 > buf.length) return null;
    if (buf[i] !== 0xff) return null;
    let mk = buf[i + 1];
    let j = i;
    while (mk === 0xff && j + 2 < buf.length) { j += 1; mk = buf[j + 1]; }
    i = j + 2;
    if (mk === 0xd8) continue;
    if (mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) continue;
    if (mk === 0xd9) return null;                       // 没到 SOS 就 EOI：不是完整 JPEG
    if (i + 2 > buf.length) return null;
    const len = buf.readUInt16BE(i);
    if (len < 2) return null;
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
      if (i + 7 > buf.length) return null;
      const h = buf.readUInt16BE(i + 3), w = buf.readUInt16BE(i + 5);
      if (!(w >= minDim && h >= minDim && w <= maxDim && h <= maxDim)) return null;
      dim = { w, h };
    }
    if (mk === 0xda) return dim ? { ...dim, sosAt: i - 2 } : null; // 抵达扫描数据起点
    if (i + len > buf.length) return null;              // 段超出当前切片，无法走完
    i += len;
  }
  return null;
}

// 在头部缓存里找 TIFF 头（CR3 的 CMT1 元数据块、RAF 的内嵌 TIFF 都用得上）
function findTiffOffset(buf, from = 8) {
  for (let i = from; i + 4 < buf.length; i += 1) {
    if (buf[i] === 0x49 && buf[i + 1] === 0x49 && buf[i + 2] === 0x2a && buf[i + 3] === 0x00) return i;
    if (buf[i] === 0x4d && buf[i + 1] === 0x4d && buf[i + 2] === 0x00 && buf[i + 3] === 0x2a) return i;
  }
  return -1;
}

// 读一个 IFD：返回尺寸/方向 + 子 IFD 与 Exif IFD 的偏移
function readIfd(t, off) {
  const le = t.readUInt16LE(0) === 0x4949;
  const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const n = u16(off);
  if (n > 4096) return null;
  const r = { w: 0, h: 0, orient: 0, sub: [], exif: 0 };
  for (let k = 0; k < n; k += 1) {
    const e = off + 2 + k * 12;
    if (e + 12 > t.length) break;
    const tag = u16(e), typ = u16(e + 2), cnt = u32(e + 4);
    if (tag === 0x0100) r.w = typ === 3 ? u16(e + 8) : u32(e + 8);
    else if (tag === 0x0101) r.h = typ === 3 ? u16(e + 8) : u32(e + 8);
    else if (tag === 0x0112) r.orient = u16(e + 8);
    else if (tag === 0x8769) r.exif = u32(e + 8);
    else if (tag === 0x014a) { // SubIFDs：RAW 的真实图像尺寸往往挂在这里
      if (cnt <= 1) { const v = u32(e + 8); if (v) r.sub.push(v); }
      else {
        const base = u32(e + 8);
        for (let q = 0; q < Math.min(cnt, 8); q += 1) {
          const o = base + q * 4;
          if (o + 4 > t.length) break;
          const v = u32(o); if (v) r.sub.push(v);
        }
      }
    }
  }
  return r;
}

// TIFF 尺寸：NEF/ARW 的 IFD0 常是缩略图 IFD（160x120），必须沿 SubIFD/ExifIFD 找最大的那组
function tiffSize(t) {
  try {
    if (!t || t.length < 8) return null;
    const le = t.readUInt16LE(0) === 0x4949;
    const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
    const queue = [u32(4)];
    const seen = new Set();
    let best = null;
    while (queue.length && seen.size < 10) {
      const off = queue.shift();
      if (!off || seen.has(off) || off + 2 > t.length) continue;
      seen.add(off);
      const r = readIfd(t, off);
      if (!r) continue;
      if (r.w && r.h) {
        const area = r.w * r.h;
        if (!best || area > best.area) best = { w: r.w, h: r.h, area, orient: r.orient };
      }
      if (r.exif) queue.push(r.exif);
      for (const s of r.sub) queue.push(s);
    }
    return best ? { w: best.w, h: best.h, orient: best.orient || 0 } : null;
  } catch { return null; }
}

/* ---------------- 内嵌 JPEG 预览提取 ---------------- */

const SOI = Buffer.from([0xff, 0xd8, 0xff]);
const EOI = Buffer.from([0xff, 0xd9]);
const MAX_PREVIEW = 48 * 1024 * 1024; // 单张预览上限，防病态文件吃内存

function readAt(absPath, offset, length) {
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const n = fs.readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, n);
  } finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
}

// 收集文件里所有候选 SOI 偏移（一次顺序读，内存恒定）
function collectSoi(absPath, size, cap = 256) {
  const fd = fs.openSync(absPath, 'r');
  try {
    const CH = 4 * 1024 * 1024;
    const buf = Buffer.allocUnsafe(CH);
    const out = [];
    let pos = 0;
    while (pos < size && out.length < cap) {
      const n = fs.readSync(fd, buf, 0, CH, pos);
      if (n <= 3) break;
      const chunk = buf.subarray(0, n);
      let i = 0;
      while (out.length < cap) {
        const k = chunk.indexOf(SOI, i);
        if (k === -1 || k > n - 3) break;
        out.push(pos + k);
        i = k + 3;
      }
      if (n < CH) break;
      pos += n - 2; // 2 字节重叠，避免跨块 SOI 漏掉
    }
    return out;
  } finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
}

// 从 from 起向后找 EOI（扫描数据里 FF 后必跟 00 填充，FFD9 只可能是真结尾）
function findEoi(absPath, size, from) {
  const fd = fs.openSync(absPath, 'r');
  try {
    const CH = 1024 * 1024;
    const buf = Buffer.allocUnsafe(CH);
    let pos = from;
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, CH, pos);
      if (n <= 1) break;
      const k = buf.subarray(0, n).indexOf(EOI);
      if (k !== -1) return pos + k;
      if (n < CH) break;
      pos += n - 1;
    }
    return -1;
  } finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
}

// 尝试把 off 处的字节当成一张完整 JPEG 读出来：结构走查 + 定位 EOI + 读全量
function readJpegAt(absPath, size, off, opts) {
  const headLen = Math.min(512 * 1024, size - off);
  if (headLen < 1024) return null;
  const head = readAt(absPath, off, headLen);
  const pr = jpegProbe(head, opts);
  if (!pr) return null;
  let eoiAbs = head.indexOf(EOI, Math.max(pr.sosAt + 2, 2));
  if (eoiAbs === -1) eoiAbs = findEoi(absPath, size, off + headLen - 1);
  else eoiAbs += off;
  if (eoiAbs < 0) return null;
  const length = eoiAbs + 2 - off;
  if (length < 1024 || length > MAX_PREVIEW) return null;
  const buf = readAt(absPath, off, length);
  if (buf.length !== length) return null;
  if (buf[length - 2] !== 0xff || buf[length - 1] !== 0xd9) return null;
  return { buf, w: pr.w, h: pr.h, length };
}

// 主入口：返回内嵌的最大 JPEG 预览；没有可用预览则 null
function extractPreviewBuffer(absPath, { minDim = 400 } = {}) {
  let size = 0;
  try { size = fs.statSync(absPath).size; } catch { return null; }

  // Fuji RAF：文件头直接给出 JPEG 偏移/长度，先试这个最省事
  try {
    const head = readAt(absPath, 0, 96);
    if (head.subarray(0, 15).toString('latin1') === 'FUJIFILMCCD-RAW' && head.length >= 92) {
      const off = head.readUInt32BE(84), len = head.readUInt32BE(88);
      if (off > 0 && len > 1024 && off + len <= size) {
        const got = readJpegAt(absPath, size, off, { minDim });
        if (got) return got;
      }
    }
  } catch { /* ignore */ }

  const cands = collectSoi(absPath, size);
  if (!cands.length) return null;
  let best = null;
  for (const off of cands) {
    if (best && best.length >= 12 * 1024 * 1024) break; // 已经拿到大图，不再继续扫
    const got = readJpegAt(absPath, size, off, { minDim });
    if (got && (!best || got.length > best.length)) best = got;
  }
  return best;
}

// 只读内嵌预览的头部切片，用来取 EXIF（比抽整张预览便宜得多）
// 取扫描窗口内**面积最大**的那张：小缩略图常缺镜头/参数信息
function exifSlice(absPath, { scanBytes = 8 * 1024 * 1024, sliceBytes = 512 * 1024 } = {}) {
  let size = 0;
  try { size = fs.statSync(absPath).size; } catch { return null; }
  let best = null;
  for (const off of collectSoi(absPath, Math.min(size, scanBytes), 48)) {
    const slice = readAt(absPath, off, Math.min(sliceBytes, size - off));
    const pr = jpegProbe(slice, { minDim: 320 });
    if (!pr) continue;
    if (!best || pr.w * pr.h > best.w * best.h) best = { buf: slice, w: pr.w, h: pr.h };
  }
  return best;
}

/* ---------------- 预览缓存 ---------------- */

// 文件名带 size+mtime 指纹：源文件被替换后自动失效，不需要额外元数据
function previewCachePath(cacheDir, id, st) {
  return path.join(cacheDir, `R${id}-${st.size}-${Math.round(st.mtimeMs)}.jpg`);
}

function cleanStalePreview(cacheDir, id, keep) {
  try {
    const pre = `R${id}-`;
    for (const f of fs.readdirSync(cacheDir)) {
      if (f.startsWith(pre) && path.join(cacheDir, f) !== keep) fs.unlinkSync(path.join(cacheDir, f));
    }
  } catch { /* ignore */ }
}

// 取预览文件路径（不存在则抽取并落盘）；null 表示该 RAW 无可用预览
function ensurePreview(absPath, cacheDir, id) {
  let st;
  try { st = fs.statSync(absPath); } catch { return null; }
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = previewCachePath(cacheDir, id, st);
  if (fs.existsSync(out)) return { file: out, cached: true };
  const got = extractPreviewBuffer(absPath);
  if (!got) return null;
  const tmp = `${out}.tmp`;
  try {
    fs.writeFileSync(tmp, got.buf);
    fs.renameSync(tmp, out);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return null;
  }
  cleanStalePreview(cacheDir, id, out);
  return { file: out, w: got.w, h: got.h, cached: false };
}

module.exports = {
  RAW_EXT, isRawExt, sniffRaw, jpegSize, jpegProbe, findTiffOffset, tiffSize,
  extractPreviewBuffer, exifSlice, ensurePreview, previewCachePath,
};
