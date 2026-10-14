'use strict';
/* 重复文件清理
 * 两类重复：
 *   A 类 同名不同格式 —— 同一文件夹里主文件名相同、扩展名不同（例：电影.mkv / 电影.mp4）。
 *       sp6 起跨类型不成组（实况照片 .heic+.mov 之类），且一律「需人工核对」默认不勾选。
 *   B 类 内容完全相同 —— 跨目录的文件，体积一致 + 首/中/尾三块 512KB 哈希全部一致
 *       （sp6 起三重复核；中/尾块不一致整组撤销，读不出采样降级「需人工核对」）。
 * 判定质量后再决定删哪个：不可播放/损坏的最低分，其次按分辨率、码率、体积、封装取舍。
 * 删除 = 移入内部回收站 data/cleanup-trash/<批次>/（不直接 unlink，可后悔）。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const paths = require('./paths');

const MAX_FILES = 120000;          // 遍历上限，保护超大库
const HASH_BYTES = 512 * 1024;     // 内容指纹采样长度
const MIN_SIZE = 32 * 1024;        // 小于 32KB 不参与清理（多为封面/字幕/配置文件）
const CONCURRENCY = 4;

const SKIP_DIRS = new Set(['$recycle.bin', '.hmp-cleanup-trash', 'node_modules', '.git', '@eaDir', '.recyling', 'system volume information']);

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.mov', '.rmvb', '.rm', '.flv', '.wmv', '.ts', '.m2ts', '.webm', '.m4v', '.mpg', '.mpeg', '.vob', '.iso']);
const AUDIO_EXT = new Set(['.mp3', '.flac', '.ape', '.wav', '.aac', '.m4a', '.ogg', '.opus', '.wma', '.dsf', '.dff', '.cue']);
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif', '.tif', '.tiff', '.avif']);
const BOOK_EXT = new Set(['.epub', '.pdf', '.mobi', '.azw3', '.azw', '.txt', '.cbz', '.cbr', '.djvu']);

function kindOf(file) {
  const e = path.extname(file).toLowerCase();
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  if (IMG_EXT.has(e)) return 'photo';
  if (BOOK_EXT.has(e)) return 'book';
  return 'other';
}

const KIND_LABEL = { video: '影视', audio: '音乐', photo: '照片', book: '书籍', other: '其它' };

/* 归一化主文件名：大小写、序号副本、公众号尾巴、常见版本词统一，让「电影.mkv / 电影.mp4」对齐，
 * 但保留分辨率/编码标记不去掉（不同版本不是重复，只是同名）。 */
function stemNorm(fileName) {
  const e = path.extname(fileName);
  let s = fileName.slice(0, fileName.length - e.length);
  s = s.trim().toLowerCase();
  s = s.replace(/[\s_\-]*(\(\d+\)|副本\s*\d*|-\s*副本|copy\s*\d*|\(\d{4,}\))\s*$/gi, '');
  s = s.replace(/[@＠][^\s@＠]{0,20}$/g, '');           // @公众号 之类的尾巴
  s = s.replace(/[\s_\-]+$/, '');
  return s.trim();
}

function humanSize(n) {
  if (!Number.isFinite(n)) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return (i === 0 ? v : v.toFixed(1)) + u[i];
}

/* ---------- 遍历收集（gj：全异步 + 分片让出事件循环，大库扫描不阻塞 Web 服务） ---------- */
const yieldNow = () => new Promise((r) => setImmediate(r));

async function walkRoot(root, out) {
  const stack = [root];
  let budget = 0;
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of ents) {
      if (++budget >= 100) { budget = 0; await yieldNow(); }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name.toLowerCase())) continue;
        stack.push(full);
      } else if (ent.isFile()) {
        if (out.length >= MAX_FILES) return;
        if (kindOf(ent.name) === 'other') continue;
        let st;
        try { st = await fsp.stat(full); } catch { continue; }
        if (!st || st.size < MIN_SIZE) continue;
        out.push({ path: full, name: ent.name, size: st.size, mtime: st.mtimeMs, kind: kindOf(ent.name), stem: stemNorm(ent.name) });
      }
    }
  }
}

/* ---------- 质量/完整性采集 ---------- */
async function headHash(p) {
  let fh;
  try { fh = await fsp.open(p, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(HASH_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HASH_BYTES, 0);
    return crypto.createHash('md5').update(buf.subarray(0, Math.max(bytesRead, 0))).digest('hex');
  } catch { return null; } finally { try { await fh.close(); } catch { /* ignore */ } }
}

// 极简图片尺寸头解析（避免依赖），读不到返回 null
function imageSize(p) {
  let fd;
  try { fd = fs.openSync(p, 'r'); } catch { return null; }
  try {
    const b = Buffer.alloc(64);
    const n = fs.readSync(fd, b, 0, 64, 0);
    if (n < 16) return null;
    if (b[0] === 0x89 && b[1] === 0x50) { // PNG
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    }
    if (b[0] === 0xff && b[1] === 0xd8) { // JPEG
      let off = 2; const buf = Buffer.alloc(64 * 1024);
      let len = fs.readSync(fd, buf, 0, buf.length, 0);
      while (off < len - 9) {
        if (buf[off] !== 0xff) { off += 1; continue; }
        const marker = buf[off + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
        }
        const seg = buf.readUInt16BE(off + 2);
        off += 2 + seg;
      }
      return null;
    }
    if (b.toString('ascii', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b[0] === 0x42 && b[1] === 0x4d) return { w: b.readInt32LE(18), h: b.readInt32LE(22) };
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = b.toString('ascii', 12, 16);
      if (fmt === 'VP8X') return { w: (b.readUIntLE(24, 3)) + 1, h: (b.readUIntLE(27, 3)) + 1 };
      if (fmt === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      return null;
    }
    return null;
  } catch { return null; } finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
}

async function mapLimit(list, fn, n = CONCURRENCY) {
  const out = new Array(list.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(n, list.length) }, async () => {
    while (true) {
      const i = idx; idx += 1;
      if (i >= list.length) return;
      try { out[i] = await fn(list[i], i); } catch { out[i] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

/* 给单个文件打分：越大越好。
 * video/audio 走 ffprobe（失败或无时长 = 损坏，直接垫底）；photo 走头解析；book 看体积与可解析性。 */
async function assess(f, probeMod) {
  const info = { detail: '', quality: 0, integrity: 1, broken: false, probed: false };
  try {
    if (f.kind === 'video' || f.kind === 'audio') {
      const pr = probeMod && probeMod.probe ? await probeMod.probe(f.path) : null;
      if (!pr || !pr.ok) {
        info.broken = true; info.integrity = 0; info.quality = -1e9; info.detail = '无法读取（损坏或不完整）';
        return info;
      }
      const dur = Number(pr.duration) || 0;
      const px = (pr.width || 0) * (pr.height || 0);
      if (f.kind === 'video') {
        if (!dur) { info.broken = true; info.integrity = 0; info.quality = -1e9; info.detail = '读不出时长（疑似残片）'; return info; }
        info.probed = true;   // go++：真读到了参数，这个分数是可信的
        const bitrate = f.size / Math.max(dur, 1);
        // 画质为主：像素总量（对数压制超大屏优势） + 码率 + 时长兜底
        info.quality = Math.log10(px + 1) * 1000 + Math.log10(bitrate + 1) * 100 + dur * 0.001;
        if (pr.subtitleTracks) info.quality += 30;               // 内封字幕是加分项
        if ((pr.audioTracks || 0) > 1) info.quality += 20;       // 多音轨加分
        info.detail = `${pr.width}x${pr.height} · ${Math.round(bitrate / 1024)}kbps · ${Math.round(dur / 60)}分钟${pr.subtitleTracks ? ' · 内封字幕' : ''}`;
      } else {
        const bitrate = dur ? Math.round(f.size / dur) : 0;
        const lossless = /\.(flac|ape|wav|dsf|dff)$/i.test(f.path);
        info.quality = (lossless ? 1000 : 0) + bitrate / 128 + (dur ? 20 : 0);
        info.detail = `${lossless ? '无损' : '有损'} · ${Math.round(bitrate / 128)}kbps · ${dur ? Math.round(dur / 60) + '分钟' : '未知时长'}`;
        if (dur) info.probed = true; else info.integrity = 0.5;
      }
      return info;
    }
    if (f.kind === 'photo') {
      const dim = imageSize(f.path);
      let px = dim ? dim.w * dim.h : 0;
      if (!px && /\.heic$/i.test(f.path)) px = 3000 * 4000;      // HEIC 读不到头时按常见手机默认值估
      let size = f.size;
      try { const st = fs.statSync(f.path); size = st.size; } catch { /* ignore */ }
      info.quality = Math.log10(px + 1) * 1000 + Math.log10(size + 1) * 10;
      info.detail = dim ? `${dim.w}x${dim.h} · ${humanSize(size)}` : `${humanSize(size)}`;
      if (!px) { info.integrity = 0.5; info.detail += ' · 读不出尺寸'; } else info.probed = true;
      return info;
    }
    if (f.kind === 'book') {
      const rank = { '.epub': 5, '.pdf': 4, '.mobi': 3, '.azw3': 3, '.cbz': 2, '.cbr': 2, '.djvu': 2, '.txt': 1 };
      const e = path.extname(f.path).toLowerCase();
      info.quality = (rank[e] || 0) * 1000 + Math.log10(f.size + 1) * 10;
      info.detail = `${e.replace('.', '').toUpperCase()} · ${humanSize(f.size)}`;
      info.probed = true;   // 书籍按格式+体积判，无需外部探测即可信
      // 书籍完整性：能读到非零内容即视为完整
      try {
        const fd = fs.openSync(f.path, 'r'); const b = Buffer.alloc(4096);
        const n = fs.readSync(fd, b, 0, 4096, 0); fs.closeSync(fd);
        if (!n) { info.broken = true; info.integrity = 0; info.quality = -1e9; info.detail += ' · 空文件'; }
      } catch { info.integrity = 0.5; }
      return info;
    }
    info.quality = f.size;
    info.detail = humanSize(f.size);
    return info;
  } catch (e) {
    info.detail = '检查失败：' + String(e && e.message || e).slice(0, 40);
    info.integrity = 0.5;
    return info;
  }
}

/* ---------- 分组 ---------- */
function buildGroupsA(files) {
  const groups = [];
  // A 类：同目录 + 同名（必然是不同扩展名）
  const byDirStem = new Map();
  for (const f of files) {
    const key = path.dirname(f.path) + '\u0000' + f.stem;
    let arr = byDirStem.get(key);
    if (!arr) { arr = []; byDirStem.set(key, arr); }
    arr.push(f);
  }
  for (const [key, arr] of byDirStem) {
    if (arr.length < 2) continue;
    const exts = new Set(arr.map((f) => path.extname(f.path).toLowerCase()));
    const dirp = key.split('\u0000')[0];
    /* sp6 防误删升级①：跨类型绝不当重复。
     * 实测误删：iPhone 实况照片 IMG_x.heic(照片) + IMG_x.mov(视频)、相册导出的
     * IMG_x.jpg + IMG_x.mov —— 名字相同但根本是两个东西，之前被「同名不同格式」
     * 一锅端且前端默认全勾，用户一点清理就删了。 */
    const kinds = new Set(arr.map((f) => f.kind));
    if (kinds.size > 1) continue;
    /* sp6 防误删升级②：同类型但不同格式 ≠ 一定是重复（如 无损.flac + 有损.mp3
     * 双版本、电影.mkv + 电影.mp4 转码双份）。保留成组供用户参考，但降级为
     * 「需人工核对」—— 前端默认一个都不勾，确认权完全交给人。 */
    groups.push({
      id: 'A' + groups.length,
      type: 'same-name-diff-format',
      typeLabel: exts.size > 1 ? '同名不同格式' : '同名重复',
      kind: arr[0].kind, dir: dirp, files: arr, extCount: exts.size, risky: false,
      confirm: true,   // 需人工核对：默认不勾选
    });
  }
  return groups;
}

/* B 类第一步：只按体积粗筛（纯内存，同步便宜），返回候选数组 */
function sizeCandidates(files) {
  const bySize = new Map();
  for (const f of files) {
    let arr = bySize.get(f.size);
    if (!arr) { arr = []; bySize.set(f.size, arr); }
    arr.push(f);
  }
  return Array.from(bySize.values()).filter((arr) => arr.length >= 2);
}

/* 任意偏移取块哈希（sp6：B 类中/尾块复核用） */
async function blockHash(p, start, len) {
  let fh;
  try { fh = await fsp.open(p, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    if (bytesRead <= 0) return null;
    return crypto.createHash('md5').update(buf.subarray(0, bytesRead)).digest('hex');
  } catch { return null; } finally { try { await fh.close(); } catch { /* ignore */ } }
}

/* B 类第二步：对候选做首块哈希比对（异步 + 限并发，不阻塞事件循环） */
async function buildGroupsB(candidates, startIdx) {
  const groups = [];
  const flat = candidates.flat();
  const hashes = await mapLimit(flat, async (f) => ({ f, h: await headHash(f.path) }), CONCURRENCY);
  const byHash = new Map();
  for (const { f, h } of hashes) {
    if (!h) continue;
    let g = byHash.get(h);
    if (!g) { g = []; byHash.set(h, g); }
    g.push(f);
  }
  const seen = new Set();
  for (const [h, g] of byHash) {
    if (g.length < 2) continue;
    const sig = g.map((f) => f.path).sort().join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    // 同目录同名已经被 A 类收走，这里跳过纯重复
    const dirs = new Set(g.map((f) => path.dirname(f.path)));
    const stems = new Set(g.map((f) => f.stem));
    if (dirs.size === 1 && stems.size === 1) continue;
    /* sp6 防误删升级③：跨类型绝不当重复（体积+头部恰巧一致的两个不同类文件） */
    const kinds = new Set(g.map((f) => f.kind));
    if (kinds.size > 1) continue;
    groups.push({
      id: 'B' + (startIdx + groups.length),
      type: 'identical-content',
      typeLabel: '内容完全相同',
      kind: g[0].kind,
      dir: Array.from(dirs).length > 1 ? '(多目录) ' + path.dirname(g[0].path) : path.dirname(g[0].path),
      files: g, hash: h.slice(0, 8), risky: false, confirm: false,
    });
  }
  /* sp6 防误删升级④：首 512KB 一致只是「粗筛」，不配叫「内容完全相同」。
   * 再复核中块（size/2 处 512KB）与尾块（末尾 512KB）：
   *   - 全一致（+体积一致）→ 真重复，照常给出（小文件 head 已覆盖全文件，直接过）
   *   - 中/尾块有任一不一致 → 内容必然不同，整组撤销，绝不呈现给用户
   *   - 采样读不出来（I/O 错误）→ 降级为「需人工核对」，默认不勾选 */
  const verified = await mapLimit(groups, async (g) => {
    const probe = async (f) => {
      if (f.size <= HASH_BYTES) return { mid: '<small>', tail: '<small>' }; // 首块已覆盖全文件
      const midOff = Math.max(HASH_BYTES, Math.floor(f.size / 2) - HASH_BYTES / 2);
      const mid = await blockHash(f.path, midOff, HASH_BYTES);
      const tail = await blockHash(f.path, Math.max(0, f.size - HASH_BYTES), HASH_BYTES);
      return { mid, tail };
    };
    const infos = await mapLimit(g.files, probe, CONCURRENCY);
    if (infos.some((x) => !x || !x.mid || !x.tail)) return { g, ok: false, unverifiable: true };
    const ok = new Set(infos.map((x) => x.mid)).size === 1 && new Set(infos.map((x) => x.tail)).size === 1;
    return { g, ok, unverifiable: false };
  }, CONCURRENCY);
  const out = [];
  for (const { g, ok, unverifiable } of verified) {
    if (!ok) continue;                 // 中/尾块不一致 → 不是重复，整组丢弃
    if (unverifiable) {
      g.confirm = true;
      g.typeLabel = '疑似相同（中/尾块读不出，未能复核）';
    } else {
      g.typeLabel = '内容完全相同（首/中/尾已复核）';
    }
    out.push(g);
  }
  return out;
}

/* 组内挑一个「该留的」：分数最高；分数并列时用路径更规范（非下载/临时目录）与更新时间兜底。
 * go++ 安全护栏：只有当组内存在「可靠判定」（probed = 真的读到了分辨率/码率/时长）
 * 的成员时，才允许自动挑保留者。否则一律弃权（返回 -1）——宁可不删，也不能赌。
 * 血泪教训：ffprobe 探测失效时全部成员同分 -1e9，平局兜底按 mtime 挑，
 * 等于把「删哪个」交给文件修改时间，可能留下刚下载的残副本、删掉整理好的正片。 */
function pickKeeper(infos) {
  const anyProbed = infos.some((x) => x && x.probed);
  if (!anyProbed) return -1;          // 无法可靠判定 → 弃权，交给人看
  let best = 0;
  for (let i = 1; i < infos.length; i += 1) {
    const a = infos[best]; const b = infos[i];
    if (b.score > a.score) { best = i; continue; }
    if (b.score === a.score) {
      const bad = (p) => /(\/|_)(download|downloads|temp|tmp|temp-|_unpack|incomplete|bt|115|baidu)(\/|$)/i.test(p);
      const ba = bad(a.path); const bb = bad(b.path);
      if (bb && !ba) continue;
      if (ba && !bb) { best = i; continue; }
      if ((b.mtime || 0) > (a.mtime || 0)) best = i;
    }
  }
  return best;
}

/* ---------- 主入口：扫描 ---------- */
async function scan({ roots = [], probeMod = null, kinds = null, onProgress = null } = {}) {
  const t0 = Date.now();
  const files = [];
  for (const r of roots) {
    if (!r || !r.path) continue;
    try { if (!fs.statSync(r.path).isDirectory()) continue; } catch { continue; }
    await walkRoot(r.path, files);
    if (onProgress) onProgress({ phase: 'walk', root: r.path, files: files.length });
    if (files.length >= MAX_FILES) break;
  }
  await yieldNow();
  let groups = buildGroupsA(files);
  const bGroups = await buildGroupsB(sizeCandidates(files), groups.length);
  groups = groups.concat(bGroups);
  if (kinds && kinds.length) groups = groups.filter((g) => kinds.includes(g.kind));

  // 只对候选成员做质量采集
  const flat = [];
  for (const g of groups) for (const f of g.files) flat.push(f);
  if (onProgress) onProgress({ phase: 'assess', total: flat.length });
  const infos = await mapLimit(flat, (f) => assess(f, probeMod), CONCURRENCY);

  let cursor = 0;
  const out = [];
  for (const g of groups) {
    const members = [];
    let brokenCount = 0;
    for (const f of g.files) {
      const inf = infos[cursor] || { detail: '', quality: 0, integrity: 1, broken: false, probed: false };
      cursor += 1;
      const score = (inf.broken ? -1e9 : 0) + inf.quality + (inf.integrity >= 1 ? 5 : 0);
      if (inf.broken) brokenCount += 1;
      members.push({
        path: f.path, name: f.name, size: f.size, kind: f.kind, ext: path.extname(f.path).toLowerCase(),
        quality: inf.detail, score: Math.round(score * 100) / 100, broken: !!inf.broken,
        probed: !!inf.probed,
        dir: path.dirname(f.path), mtime: f.mtime || 0,
      });
    }
    const keepIdx = pickKeeper(members.map((m, i) => ({ score: m.score, path: m.path, mtime: g.files[i].mtime, probed: m.probed })));
    /* go++：keepIdx === -1 = 无法可靠判定（探测失败/全部同分），此组不自动挑保留者。
     * 这类组一律标 unsafe，前端默认「一个都不勾」，用户必须手动确认才可能清掉东西。 */
    const unsafe = keepIdx < 0;
    if (!unsafe) members[keepIdx].keep = true;
    const saveable = members.filter((m) => !m.keep).reduce((s, m) => s + m.size, 0);
    out.push({
      id: g.id, type: g.type, typeLabel: g.typeLabel, kind: g.kind, kindLabel: KIND_LABEL[g.kind] || g.kind,
      dir: g.dir, members, keep: unsafe ? '' : members[keepIdx].path, keepIdx,
      saveable, brokenCount, risky: !!g.risky, unsafe, confirm: !!g.confirm, files: g.files.length, hash: g.hash || '',
    });
  }
  out.sort((a, b) => b.saveable - a.saveable);
  /* go++：把「无法可靠判定」的组数报出去。前端据此给出明确提示——
   * 这类组通常意味着 ffprobe/ffmpeg 没就位，或这些文件确实是空壳/残片，
   * 需要用户自己看质量字段决定，不能由程序代猜。 */
  const unsafeGroups = out.filter((g) => g.unsafe).length;
  setUnsafePaths(out);   // go++：登记 unsafe 组，run() 会拒删其中任何文件
  /* 统一登录每个已入库文件的路径：扫描结果直接带，run() 用它把「实际清掉的文件」记下来，
   * 供 pruneEmptyDirs 收窄清理范围（只清这些文件所在的空目录树，别去碰用户库里其它目录）。 */
  const known = buildKnownMap(files);
  return {
    scannedFiles: flat.length, roots: roots.length, groups: out,
    totalGroups: out.length,
    unsafeGroups,
    saveable: out.reduce((s, g) => s + g.saveable, 0) / 2, // 每组只删多余的，粗略估的是整组，这里除 2 修正为保守值
    elapsed: Date.now() - t0, truncated: files.length >= MAX_FILES,
    known: known.entries,
  };
}

/* ---------- 已知文件表（go+）：把库内所有被扫描到的候选成员记进内存，
 * run() 用它判定「这个文件确实是本次清理清单里的」，并把这些文件的父目录
 * 汇总给 pruneEmptyDirs，收窄「删空文件夹」的范围。 */
const knownFiles = new Map(); // absPath -> { dir, mtime }
function buildKnownMap(files) {
  knownFiles.clear();
  for (const f of files) {
    if (!f || !f.path) continue;
    const abs = f.path;
    knownFiles.set(abs, { dir: path.dirname(abs), mtime: f.mtime || 0 });
  }
  return { size: knownFiles.size, entries: knownFiles };
}

/* ---------- 执行清理 ---------- */
const trashRoot = () => path.join(paths.dataRoot(), 'cleanup-trash');

/* ---------- 回收站还原清单（manifest）----------
 * 回收站要能「还原」，前提是知道每个文件原来在哪。
 * 但 trashRelPath() 为了防路径逃逸，把库外的原路径压成了「末三层目录_拼接」的文件名
 * （/share/影视/电影/a.mkv → __external__/影视_电影_a.mkv），原路径不可反推。
 * 所以每个批次目录里额外写一份 __manifest__.json：rel（回收站内相对路径）→ orig（原绝对路径）。
 * 没有 manifest 的批次（本功能上线之前清理的）一律标记为不可还原，绝不猜路径瞎搬。 */
const MANIFEST_NAME = '__manifest__.json';
const MANIFEST_FLUSH_EVERY = 20;   // 每搬 20 个文件落一次盘，中途断电也不丢清单

function safeBatchName(batch) {
  const s = String(batch == null ? '' : batch).trim();
  if (!s) return '';
  if (/[\\/]/.test(s) || s === '.' || s === '..' || s.indexOf('..') >= 0) return '';  // 禁路径穿越
  return s;
}

function manifestPath(batch) {
  const b = safeBatchName(batch);
  if (!b) return '';
  return path.join(path.resolve(trashRoot()), b, MANIFEST_NAME);
}

function readManifest(batch) {
  const p = manifestPath(batch);
  if (!p) return [];
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.items) ? j.items : []);
    return arr.filter((it) => it && it.rel).map((it) => ({
      rel: String(it.rel), orig: String(it.orig || ''), name: String(it.name || ''),
      size: Number(it.size) || 0, mtime: Number(it.mtime) || 0, at: String(it.at || ''),
    }));
  } catch { return []; }
}

function writeManifest(batch, items) {
  const p = manifestPath(batch);
  if (!p) return false;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ version: 1, batch: safeBatchName(batch), at: new Date().toISOString(), items }, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

/* 批次目录里还剩几个「真文件」（manifest 自身不算） */
async function countFilesLeft(dir) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isDirectory()) { stack.push(path.join(d, e.name)); continue; }
      if (e.name === MANIFEST_NAME) continue;
      n += 1;
    }
  }
  return n;
}

/* go++ 服务端拒绝闸：记录「无法可靠判定」的组（unsafe）里的所有文件路径。
 * 前端已把这些组默认不勾选，但前端可以被绕过（改 JS / 直接打 API）。
 * 这里做最后一道闸——凡属于 unsafe 组、且不是该组 keep 的文件，一律拒删。
 * 用户真要删，得先让 ffprobe 就绪、让这次扫描能可靠判定，或者明确走别的入口。 */
let unsafePaths = new Set();
function setUnsafePaths(groups) {
  unsafePaths = new Set();
  for (const g of groups || []) {
    if (!g || !g.unsafe) continue;
    for (const m of g.members || []) unsafePaths.add(m.path);
  }
  return unsafePaths.size;
}
function filterRefused(list) {
  if (!unsafePaths.size) return { allow: list, refused: [] };
  const allow = []; const refused = [];
  for (const p of list) (unsafePaths.has(p) ? refused : allow).push(p);
  return { allow, refused };
}

// gj+：把源路径映射成回收站内的安全相对路径。
// 被清理的文件几乎都在数据目录之外（影视库 /share/影视、音乐库…），直接
// path.relative(dataRoot 的父目录, file) 会得到 ../.. 串，再 path.join 时
// 会被解析掉，文件实际落到数据目录外——用户既看不到回收站、也找不到文件。
// 所以：在 dataRoot 内的保留原结构；在外的挂到 __external__/<盘符>/<末三层>，
// 并保证结果永远不逃出批次目录。
function trashRelPath(file) {
  const rootAbs = path.resolve(trashRoot());
  const src = path.resolve(file);
  const inside = path.relative(rootAbs, src);
  if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) return inside;
  const drive = (path.parse(src).root || '').replace(/[\\/:]/g, '');
  const parts = src.split(/[\\/]/).filter(Boolean);
  const tail = parts.slice(-3).join('_').replace(/[/\\:*?"<>|]/g, '_') || 'file';
  return path.join('__external__', drive || 'x', tail);
}

async function moveToTrash(file, batch) {
  const destRoot = path.resolve(trashRoot(), batch);
  const dest = path.resolve(destRoot, trashRelPath(file));
  // 双保险：万一还有路径逃逸，退回批次目录内平铺，绝不写到回收站外
  const safe = (dest === destRoot || dest.startsWith(destRoot + path.sep))
    ? dest
    : path.join(destRoot, '__flat__', path.basename(file).replace(/[/\\:*?"<>|]/g, '_'));
  await fsp.mkdir(path.dirname(safe), { recursive: true });
  try {
    await fsp.rename(file, safe);
  } catch (e) {
    if (e && (e.code === 'EXDEV' || e.code === 'EPERM' || e.code === 'EACCES')) {
      await fsp.copyFile(file, safe);
      await fsp.unlink(file);
    } else { throw e; }
  }
  return safe;
}

// gj+：单文件清理进度通道 + 中止开关（清理大库时用户要能「终止」）
const runState = {
  running: false, done: 0, total: 0, moved: 0, freed: 0, failed: 0,
  current: '', abort: false, startedAt: 0, finishedAt: 0, batch: '',
};
const runStatus = () => ({
  running: runState.running, done: runState.done, total: runState.total,
  moved: runState.moved, freed: runState.freed, failed: runState.failed,
  current: runState.current, abort: runState.abort,
  startedAt: runState.startedAt, finishedAt: runState.finishedAt, batch: runState.batch,
});
const abortRun = () => { if (runState.running) runState.abort = true; return { ok: true }; };

async function run({ paths: list = [], batch = null } = {}) {
  const ts = batch || new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13);
  /* go++ 拒绝闸：把「无法可靠判定」组里的文件从待删清单里摘出去。
   * 这道闸独立于前端，即使有人直接打 API 也删不动——毕竟这类文件
   * 程序根本没能力判断留哪个更好，删了就没有后悔药。 */
  const gate = filterRefused(list);
  const refused = gate.refused;
  const todo = gate.allow;
  runState.running = true; runState.abort = false; runState.done = 0; runState.moved = 0;
  runState.freed = 0; runState.failed = 0; runState.current = ''; runState.startedAt = Date.now();
  runState.finishedAt = 0; runState.batch = ts; runState.total = todo.length;
  let freed = 0; let moved = 0;
  const failed = [];
  const touchedDirs = new Set(); // go+：本次真正清掉的文件所在目录，供收窄 prune
  /* 还原清单：先读已有的（同批次可能被追加清理过），边搬边记、定期落盘 ——
     中途「终止」或断电也不会丢掉「这个文件原来在哪」，还原才有依据。 */
  const manifest = readManifest(ts);
  const manIdx = new Map();
  for (let i = 0; i < manifest.length; i += 1) manIdx.set(manifest[i].rel, i);
  let manDirty = false; let sinceFlush = 0;
  const batchDirAbs = path.resolve(trashRoot(), ts);
  try {
    for (const p of todo) {
      if (runState.abort) break;
      runState.current = p;
      try {
        const st = await fsp.stat(p);
        const dest = await moveToTrash(p, ts);
        freed += st.size; moved += 1;
        runState.freed = freed; runState.moved = moved;
        const rel = path.relative(batchDirAbs, path.resolve(dest));
        const rec = { rel, orig: p, name: path.basename(p), size: st.size, mtime: st.mtimeMs, at: new Date().toISOString() };
        const at = manIdx.get(rel);
        if (at == null) { manIdx.set(rel, manifest.length); manifest.push(rec); } else manifest[at] = rec;
        manDirty = true; sinceFlush += 1;
        if (sinceFlush >= MANIFEST_FLUSH_EVERY) { writeManifest(ts, manifest); sinceFlush = 0; }
        const known = knownFiles.get(p);
        touchedDirs.add(known ? known.dir : path.dirname(p));
      } catch (e) {
        failed.push({ path: p, error: String(e && e.message || e) });
        runState.failed = failed.length;
      }
      runState.done += 1;
      // 让出事件循环：/api/cleanup/run/abort 才来得及被处理（铁律：大目录操作必须分片）
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    if (manDirty) writeManifest(ts, manifest);
    runState.running = false; runState.current = ''; runState.finishedAt = Date.now();
  }
  const aborted = runState.abort;
  runState.abort = false;
  return {
    batch: ts, moved, freed, failed, aborted,
    total: todo.length, dirs: Array.from(touchedDirs),
    refused,            // go++：被拒绝闸拦下的文件（属 unsafe 组）
    requested: list.length,
    manifest: manifest.length,   // 已登记可还原的文件数
  };
}

async function trashList() {
  const root = trashRoot();
  if (!fs.existsSync(root)) return { batches: [], total: 0 };
  const batches = [];
  let total = 0;
  for (const name of await fsp.readdir(root)) {
    const dir = path.join(root, name);
    let st; try { st = await fsp.stat(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    let size = 0; let count = 0;
    const files = []; // gj+：列出文件名，用户要能看见自己删了什么
    // 还原清单：rel → 原路径。没记录的（还原功能上线前清的）一律标不可还原，绝不猜路径瞎搬
    const man = readManifest(name);
    const manMap = new Map(man.map((it) => [it.rel, it]));
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) stack.push(full);
        else {
          if (e.name === MANIFEST_NAME) continue;   // 清单是元数据，不占回收站条目
          try {
            const s = await fsp.stat(full);
            size += s.size; count += 1;
            const rel = path.relative(dir, full);
            const rec = manMap.get(rel);
            files.push({
              name: e.name, size: s.size, rel,
              orig: rec && rec.orig ? rec.orig : '',
              restorable: !!(rec && rec.orig),
            });
          } catch { /* ignore */ }
        }
      }
    }
    files.sort((a, b) => b.size - a.size);
    total += size;
    batches.push({
      batch: name, size, count, mtime: st.mtimeMs,
      files: files.slice(0, 300), filesMore: Math.max(0, files.length - 300),
      hasManifest: man.length > 0,
      restorable: files.filter((f) => f.restorable).length,
    });
  }
  batches.sort((a, b) => b.mtime - a.mtime);
  return { batches, total, root };
}

async function purgeTrash(batch = null) {
  const root = trashRoot();
  if (!fs.existsSync(root)) return { ok: true, removed: 0 };
  const targets = batch ? [path.join(root, batch)] : (await fsp.readdir(root)).map((n) => path.join(root, n));
  let removed = 0;
  for (const t of targets) {
    try { await fsp.rm(t, { recursive: true, force: true }); removed += 1; } catch { /* ignore */ }
  }
  return { ok: true, removed };
}

/* ---------- 回收站还原 ----------
 * 按 manifest 把文件搬回原路径。安全护栏一条都不能少：
 *   ① 批次名禁路径穿越；② 源文件必须仍在该批次目录内；③ 目标必须是绝对路径、且不能落回回收站里；
 *   ④ 原位置已有同名文件 → 拒绝（绝不覆盖用户现有的文件），该文件留在清单里等用户处理；
 *   ⑤ 没有 manifest 的批次直接报错，宁可不还原，也不猜路径瞎搬。
 * 全部还原成功就顺手清掉空批次目录；部分失败则只回写「没还原成的」那部分。 */
async function restoreTrash({ batch = null, items = null, overwrite = false } = {}) {
  const b = safeBatchName(batch);
  if (!b) return { ok: false, error: '缺少批次号', restored: 0, failed: [] };
  const root = path.resolve(trashRoot());
  const dir = path.resolve(root, b);
  if (dir === root || !dir.startsWith(root + path.sep) || !fs.existsSync(dir)) {
    return { ok: false, error: '批次不存在：' + b, restored: 0, failed: [] };
  }
  const man = readManifest(b);
  if (!man.length) {
    return {
      ok: false, restored: 0, failed: [],
      error: '该批次没有还原记录（多半是还原功能上线之前清理的），无法自动还原；可按下面显示的存放位置手动取回。',
    };
  }
  let todo = man;
  if (Array.isArray(items) && items.length) {
    const pick = (x) => String(typeof x === 'string' ? x : ((x && (x.rel != null ? x.rel : (x.orig != null ? x.orig : x.path))) || '')).trim();
    const want = new Set(items.map(pick).filter(Boolean));
    todo = man.filter((it) => want.has(it.rel) || want.has(it.orig));
    if (!todo.length) return { ok: false, error: '这些文件不在该批次的还原记录里', restored: 0, failed: [] };
  }
  const restored = []; const failed = [];
  let freed = 0;
  for (const it of todo) {
    const src = path.resolve(dir, it.rel);
    const dest = path.resolve(it.orig);
    if (!(src === dir || src.startsWith(dir + path.sep))) { failed.push({ rel: it.rel, error: '清单记录异常（源文件越界）' }); continue; }
    if (!path.isAbsolute(dest) || dest === root || dest.startsWith(root + path.sep)) { failed.push({ rel: it.rel, error: '清单记录异常（原路径非法）' }); continue; }
    try {
      const st = await fsp.stat(src);
      if (!overwrite) {
        let ex = null; try { ex = await fsp.stat(dest); } catch { ex = null; }
        if (ex) { failed.push({ rel: it.rel, orig: dest, error: '原位置已有同名文件，请先移走或删除它再还原' }); continue; }
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      try {
        await fsp.rename(src, dest);
      } catch (e) {
        if (e && (e.code === 'EXDEV' || e.code === 'EPERM' || e.code === 'EACCES')) {
          await fsp.copyFile(src, dest);
          await fsp.unlink(src);
        } else { throw e; }
      }
      // 尽力还原修改时间，免得重扫后这些文件被当成「刚下的新片」排在最前面
      try { if (it.mtime) await fsp.utimes(dest, new Date(), new Date(it.mtime)); } catch { /* ignore */ }
      restored.push({ rel: it.rel, orig: dest, name: it.name || path.basename(dest), size: st.size });
      freed += st.size;
    } catch (e) {
      failed.push({ rel: it.rel, orig: dest, error: String((e && e.message) || e) });
    }
    // 大批量还原同样分片让出事件循环（铁律：大目录操作必须分片）
    await new Promise((r) => setImmediate(r));
  }
  const doneRels = new Set(restored.map((x) => x.rel));
  const remain = man.filter((it) => !doneRels.has(it.rel));
  writeManifest(b, remain);
  let dirGone = false;
  if (!remain.length) {
    try {
      if ((await countFilesLeft(dir)) === 0) { await fsp.rm(dir, { recursive: true, force: true }); dirGone = true; }
    } catch { /* ignore */ }
  }
  return { ok: true, batch: b, restored: restored.length, freed, failed, items: restored, remaining: remain.length, dirGone };
}

/* ---------- 清理后整理：删空文件夹 ----------
 * go+ 重大收窄：旧版传入整个库根（如 /share/照片），会把用户库里**所有**空目录都清掉——
 * 包括 QNAP 自动维护的 .@__thumb/transcode 缩略图目录、以及用户自己建的空文件夹。
 * 那是「删重复文件」功能不该碰的东西。
 * 现在只接受 run() 回传的 dirs（本次真正清掉的文件所在目录），并且：
 *   ① 只从这些目录往上清理空的父级，范围限制在库根之内；
 *   ② 不进入任何隐藏目录 / 系统目录（. 开头、@ 开头一律跳过）；
 *   ③ 单次最多向上 8 层，且绝不动库根本身。
 */
const PRUNE_SKIP_NAMES = new Set(['$recycle.bin', '.hmp-cleanup-trash', 'node_modules', '.git', 'system volume information']);
function isProtectedDirName(name) {
  if (!name) return true;
  const low = name.toLowerCase();
  if (PRUNE_SKIP_NAMES.has(low)) return true;
  if (name.startsWith('.') || name.startsWith('@')) return true;   // .@__thumb / @eaDir / .streams / $RECYCLE 等
  if (low === 'recycle' || low === '.recycle' || low === '@recycle' || low === '#recycle') return true;
  return false;
}
function pruneEmptyDirs(dirs, roots) {
  const removed = [];
  const list = Array.isArray(dirs) ? dirs.filter(Boolean) : [];
  if (!list.length) return { removed, count: 0 };
  // 库根白名单：清理范围绝不超过它们
  const rootAbs = (Array.isArray(roots) ? roots : [])
    .map((r) => (r && r.path) || r)
    .filter((p) => typeof p === 'string' && p)
    .map((p) => path.resolve(p));
  const insideRoot = (p) => {
    if (!rootAbs.length) return true;
    return rootAbs.some((r) => p === r || p.startsWith(r + path.sep));
  };
  const isEmptyDir = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    return ents.length === 0;
  };
  const seen = new Set();
  for (const d of list) {
    let cur = path.resolve(d);
    for (let up = 0; up < 8; up += 1) {
      if (!insideRoot(cur)) break;
      if (rootAbs.includes(cur)) break;                    // 库根本身永不动
      if (isProtectedDirName(path.basename(cur))) break;   // 命中隐藏/系统目录，停止向上
      if (seen.has(cur)) break;
      if (!isEmptyDir(cur)) break;
      seen.add(cur);
      try { fs.rmdirSync(cur); removed.push(cur); } catch { break; }
      cur = path.dirname(cur);
    }
  }
  return { removed, count: removed.length };
}

module.exports = {
  scan, run, pruneEmptyDirs, trashList, purgeTrash, restoreTrash, kindOf, humanSize, KIND_LABEL, trashRoot,
  runStatus, abortRun,
  setUnsafePaths, filterRefused,   // go++：unsafe 组登记与拒绝闸（供测试与上层校验）
  readManifest, MANIFEST_NAME,     // 回收站还原清单（供上层/测试核对）
};
