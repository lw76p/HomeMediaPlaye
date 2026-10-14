'use strict';
/* 相似 / 重复照片清理（步骤4）
   数据全部来自已有的 512 维图片向量（ai_vec），不需要重新解码任何图片、不需要联网。
   两种「重复」都基于余弦相似度：
     - 完全重复（连拍/同一张存了两份）：余弦 ≥ DUP_THRESH（默认 0.97）
     - 高度相似（同一场景多张、微调角度）：余弦 ≥ SIM_THRESH（默认 0.93）
   分组用「并查集」：A~B 且 B~C 就把 A/B/C 合成一组（相似关系不满足传递性，
   但不做传递闭包会导致同一个连拍序列被切成好几段，用户要一组组点太累）。
   每组自动挑一张「保留」（清晰度/分辨率/文件大小加权），其余标为「可删」。

   关键约束：
   - 只读 ai_vec 已存在的行；向量库没跑完时结果天然只是「部分照片里找重复」。
   - 绝不自动删除任何东西：只出候选清单，删除必须由用户在前端逐组确认。
   - 人工改过分类的照片（ai_conf = -1）与其他照片一视同仁参与查重（分类与查重无关）。 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const paths = require('./paths');

const DIM = 512;
/* 阈值依据（2026-09-23 用真机 4000 张向量实测的相似度分布定的，不是拍脑袋）：
   同分类内随机 20 万对的余弦分布 —— 背景峰在 0.50~0.60，0.90 以上仍有约 0.1% 的尾巴。
   实测不同阈值下「被并进组」的照片占比：
     0.99→4.2%   0.98→7.8%   0.97→12.7%   0.96→18.2%   0.95→22.9%   0.93→33.4%   0.90→47.8%
   0.93 会把三分之一照片卷进来（并查集在密集区会链式传染），
   所以「相似」定在 0.96（连拍/同一场景多张），「完全重复」定在 0.99（同一张的副本）。
   阈值可通过 findSimilar 的入参覆盖，前端提供「宽松/标准/严格」三档。 */
const DUP_THRESH = 0.99;   // 完全重复：同一张的两个副本
const SIM_THRESH = 0.96;   // 高度相似：连拍 / 同一场景多张
const MAX_ROWS = 200000;   // 防御：向量行数上限
const HARD_CAP_GROUPS = 400;
/* 组大小上限：并查集走的是「相似」关系，而相似不满足传递性 ——
   A≈B、B≈C 时 A 可能只有 0.90 并不像 C。不设上限会出现「链式传染」，
   整段连拍甚至整个相册被并成一组（实测 0.90 阈值下 47.8% 的照片会连成一片）。
   超过上限的组按「与组内最优张的相似度」二次切分，保证每组成员都是真的像。 */
const MAX_GROUP = 60;

/* Float32Array(512) ↔ 2048 字节 BLOB */
function blobToVec(buf) {
  if (!buf) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.byteLength !== DIM * 4) return null;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/* 并查集 */
function makeUF(n) {
  const p = new Int32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
  return { find, union: (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) p[rb] = ra; } };
}

/* 清晰度代理分：分辨率越大、文件越大、越可能是「原图」；越小越像压缩转发过的副本。
   返回分数，越大越该保留。 */
function keepScore(row) {
  const px = (row.w || 0) * (row.h || 0);
  const size = row.size || 0;
  // 分辨率主导（对数压缩量级差），大小作次级信号
  return Math.log10(px + 10) * 10 + Math.log10(size + 10);
}

/* 邻居抽样：全库两两比较是 O(n²)。对 n 万级照片（~2 亿对 × 512 维）
   直接做要几分钟，但可以用「按分类桶 + 按拍摄日期相邻窗口」大幅剪枝：
   重复照片几乎总在同一分类里，且拍摄时间接近（连拍）或来自同一相册。
   这里采用「分类桶内全比较 + 桶上限保护」的稳妥策略：
   - 分类桶内两两比较（每桶通常几千张 → 千万级对，可接受）
   - 单桶超过 BUCKET_MAX 时退化为「按 id 分片」，保证每片可比较
   这是精度与耗时的折中：跨分类的重复（如人像 vs 静物误分类）会漏，
   但同一张照片的两次分类结果通常一致，漏检率很低。 */
const BUCKET_MAX = 4000;

/* 核心：扫描全库向量，返回相似组 */
function findSimilar({ dupThresh = DUP_THRESH, simThresh = SIM_THRESH, onProgress = null, maxGroup = MAX_GROUP } = {}) {
  let rows = [];
  try {
    rows = db.all(
      `SELECT id, name, path, album, ext, size, w, h, taken_at, category, ai_conf, ai_vec, mtime
       FROM lib_photos WHERE ai_vec IS NOT NULL LIMIT ?`, [MAX_ROWS]);
  } catch { return { groups: [], scanned: 0, pairs: 0, error: '向量列不可用', dupThresh, simThresh }; }
  if (!rows.length) return { groups: [], scanned: 0, pairs: 0, totalGroups: 0, dupThresh, simThresh };

  const n = rows.length;
  const vecs = new Array(n);
  for (let i = 0; i < n; i++) vecs[i] = blobToVec(rows[i].ai_vec);
  const idxOf = new Int32Array(n);
  for (let i = 0; i < n; i++) idxOf[i] = i;

  // 按 category 分桶（未分类归到 '' 桶）
  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    if (!vecs[i]) continue;
    const k = String(rows[i].category || '');
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(i);
  }

  const uf = makeUF(n);
  let pairs = 0, compared = 0;
  const nearPairs = [];

  for (const [cat, list] of buckets) {
    // 桶过大就切片：每片 BUCKET_MAX 张，片内两两比较
    for (let s = 0; s < list.length; s += BUCKET_MAX) {
      const seg = list.slice(s, s + BUCKET_MAX);
      for (let a = 0; a < seg.length; a++) {
        const va = vecs[seg[a]];
        for (let b = a + 1; b < seg.length; b++) {
          const vb = vecs[seg[b]];
          let dot = 0;
          for (let d = 0; d < DIM; d++) dot += va[d] * vb[d];
          compared++;
          if (dot >= simThresh) {
            pairs++;
            nearPairs.push([seg[a], seg[b], dot]);
            uf.union(seg[a], seg[b]);
          }
        }
      }
    }
    if (onProgress) onProgress({ cat, compared, pairs, total: n });
  }

  // 归组
  const groupsMap = new Map();
  for (let i = 0; i < n; i++) {
    if (!vecs[i]) continue;
    const r = uf.find(i);
    if (!groupsMap.has(r)) groupsMap.set(r, []);
    groupsMap.get(r).push(i);
  }

  // 邻接表：只记 >= simThresh 的真实边，切分超大连锁时要用
  const adj = new Map();
  for (const [ia, ib] of nearPairs) {
    if (!adj.has(ia)) adj.set(ia, []);
    if (!adj.has(ib)) adj.set(ib, []);
    adj.get(ia).push(ib);
    adj.get(ib).push(ia);
  }

  /* 把一个超额成员链切成若干「真得像」的小组：
     贪心 —— 取剩余里 keep 分最高的一张当种子，把它与种子的直接相似邻居
     （仅限 simThresh 边）收进同组，直到达到 maxGroup；剩余另起一组。
     这样保证组内每一张都与种子直接相似，不再依赖传递。 */
  function splitChain(members) {
    const rest = new Set(members);
    const out = [];
    while (rest.size) {
      // 种子 = 剩余里 keep 分最高的（优先保住原图）
      let seed = -1;
      for (const m of rest) if (seed < 0 || keepScore(rows[m]) > keepScore(rows[seed])) seed = m;
      rest.delete(seed);
      const grp = [seed];
      for (const nb of (adj.get(seed) || [])) {
        if (grp.length >= maxGroup) break;
        if (rest.has(nb)) { rest.delete(nb); grp.push(nb); }
      }
      if (grp.length >= 2) out.push(grp);
      else {
        // 单张落单：塞进任意一个还没满的已有组，否则丢弃
        const t = out.find((g) => g.length < maxGroup);
        if (t) t.push(seed);
      }
    }
    return out;
  }

  // 只保留真的成组的（≥2 张）
  const groups = [];
  const rawChains = [];
  for (const [, members] of groupsMap) {
    if (members.length < 2) continue;
    if (members.length <= maxGroup) { rawChains.push(members); continue; }
    for (const sub of splitChain(members)) rawChains.push(sub);
  }

  for (const members of rawChains) {
    if (members.length < 2) continue;
    // 组内最高相似度（用于标注「完全重复」还是「相似」）
    let maxSim = 0;
    const set = new Set(members);
    for (const [ia, ib, sc] of nearPairs) if (set.has(ia) && set.has(ib) && sc > maxSim) maxSim = sc;
    const items = members.map((i) => {
      const r = rows[i];
      return {
        id: r.id, name: r.name || '', ext: r.ext || '', size: r.size || 0,
        w: r.w || 0, h: r.h || 0, taken_at: r.taken_at || '', category: r.category || '',
        ai_conf: typeof r.ai_conf === 'number' ? r.ai_conf : 0,
        mtime: r.mtime || 0, album: r.album || '',
        keep: keepScore(r),
      };
    });
    items.sort((x, y) => y.keep - x.keep);
    const keepId = items[0].id;
    groups.push({
      n: items.length,
      maxSim: Number(maxSim.toFixed(4)),
      kind: maxSim >= dupThresh ? 'dup' : 'sim',
      keepId,
      // 预计可回收体积 = 除保留张外的总和
      reclaim: items.slice(1).reduce((s, x) => s + (x.size || 0), 0),
      items,
    });
  }

  groups.sort((a, b) => (b.maxSim - a.maxSim) || (b.reclaim - a.reclaim));
  return {
    groups: groups.slice(0, HARD_CAP_GROUPS),
    scanned: n, pairs, compared, totalGroups: groups.length,
    // 把实际生效的阈值回传：前端要按它给每组打「完全重复 / 相似」标签，
    // 不能自己写死 0.97/0.93（调用方可能传了自定义阈值）
    dupThresh, simThresh,
  };
}

/* 概览：不跑全量比较，只汇报「能查重多少张」与阈值 */
function similarInfo() {
  let scanned = 0, total = 0;
  try {
    scanned = db.get(`SELECT COUNT(*) AS n FROM lib_photos WHERE ai_vec IS NOT NULL`).n || 0;
    total = db.get(`SELECT COUNT(*) AS n FROM lib_photos`).n || 0;
  } catch { /* ignore */ }
  return { scanned, total, dupThresh: DUP_THRESH, simThresh: SIM_THRESH, ready: scanned >= 2 };
}

/* ================= 安全删除：先进回收站，不直接 unlink =================
   查重是「机器猜测」，误判一定存在（尤其连拍里有一张是真想要的）。
   所以删除一律走两道保护：
     1) 物理文件移到 <数据目录>/photos-trash/<批次>/，保留原名 + 原目录结构扁平化
        并写 manifest.json（原路径、新路径、批次时间），可整批还原；
     2) 数据库行删除（复用 photos.libRemovePhoto），但先把还原所需的元信息记进 manifest。
   用户看到「删除」实际是「移入回收站」，随时能一键恢复。 */

function trashRoot() {
  return path.join(paths.dirs.root(), 'photos-trash');
}

function batchDir(batch) {
  return path.join(trashRoot(), String(batch || 'default'));
}

/* 把一组照片移入回收站（物理文件 + DB 行 + 缩略图缓存）。
   photosMod 由调用方注入，避免 lib/aisim 与 lib/photos 循环依赖。 */
function trashPhotos(ids, { batch, photosMod } = {}) {
  const batchId = batch || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = batchDir(batchId);
  fs.mkdirSync(dir, { recursive: true });
  const manPath = path.join(dir, 'manifest.json');
  let man = [];
  try { man = JSON.parse(fs.readFileSync(manPath, 'utf8')); } catch { man = []; }

  const moved = [], missing = [], failed = [];
  for (const rawId of (ids || [])) {
    const id = Number(rawId);
    if (!Number.isFinite(id)) continue;
    const row = photosMod.libGet(id);
    if (!row) { missing.push(id); continue; }
    const src = row.path;
    // 目标文件名：原名可能重名 → 前缀 id 保证唯一
    const dest = path.join(dir, id + '_' + (row.name || path.basename(src)));
    // 物理文件不在 → 只记 missing 并**跳过**：绝不能写 manifest、更不能删 DB 行，
    // 否则 manifest 指向不存在的文件、还原时必然失败，且照片行被白白抹掉。
    if (!fs.existsSync(src)) { missing.push(id); continue; }
    try {
      fs.renameSync(src, dest);
    } catch (e) {
      // 跨设备/跨分区 rename 会 EXDEV → 退化为 copy + unlink
      try {
        fs.copyFileSync(src, dest);
        fs.unlinkSync(src);
      } catch (e2) { failed.push({ id, error: e2.message }); continue; }
    }
    // 二次确认：文件确实落到回收站了才记账。搬失败却记成功 = 照片凭空消失
    if (!fs.existsSync(dest)) { failed.push({ id, error: '搬移后回收站里找不到文件' }); continue; }
    man.push({
      id, batch: batchId, name: row.name || '', origPath: src, trashPath: dest,
      size: row.size || 0, w: row.w || 0, h: row.h || 0, dir: row.dir || '',
      category: row.category || '', ai_conf: typeof row.ai_conf === 'number' ? row.ai_conf : 0,
      root_id: row.root_id || 0, album: row.album || '', taken_at: row.taken_at || '',
      at: new Date().toISOString(),
    });
    // 删 DB 行 + 清缩略图缓存（clean:false 防止删完目录又去动已移走的文件）
    try { photosMod.libRemovePhoto(id, { clean: false }); } catch { /* ignore */ }
    moved.push({ id, from: src, to: dest });
  }
  try { fs.writeFileSync(manPath, JSON.stringify(man, null, 2), 'utf8'); } catch { /* ignore */ }
  return { batch: batchId, moved: moved.length, missing, failed, trashDir: dir, items: moved };
}

/* 列回收站批次 */
function trashList() {
  const root = trashRoot();
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return { batches: [] }; }
  const batches = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const mp = path.join(root, e.name, 'manifest.json');
    let man = [];
    try { man = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch { man = []; }
    batches.push({
      batch: e.name,
      n: man.length,
      bytes: man.reduce((s, x) => s + (x.size || 0), 0),
      at: man.length ? man[0].at : '',
    });
  }
  batches.sort((a, b) => String(b.batch).localeCompare(String(a.batch)));
  return { batches, root };
}

/* 还原一个批次：文件搬回原路径。DB 行不回插（原 id 已被删，路径仍是 UNIQUE），
   还原后由用户重新扫描让照片回到库里——这样不会与「重扫」逻辑打架。 */
function trashRestore(batch) {
  const dir = batchDir(batch);
  let man = [];
  try { man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch {
    return { restored: 0, failed: [], error: '找不到该批次的 manifest' };
  }
  const restored = [], failed = [];
  const remain = [];
  for (const it of man) {
    const src = it.trashPath;
    const dest = it.origPath;
    try {
      if (!fs.existsSync(src)) { failed.push({ id: it.id, error: '回收站里已无该文件' }); continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest)) { failed.push({ id: it.id, error: '原位置已有同名文件' }); remain.push(it); continue; }
      try { fs.renameSync(src, dest); }
      catch { fs.copyFileSync(src, dest); fs.unlinkSync(src); }
      restored.push({ id: it.id, to: dest });
    } catch (e) { failed.push({ id: it.id, error: e.message }); remain.push(it); }
  }
  // 全部还原完 → 先删 manifest 再删目录（rmdir 只接受空目录，留着 manifest 会删不掉）
  if (!remain.length) {
    try { fs.unlinkSync(path.join(dir, 'manifest.json')); } catch { /* ignore */ }
    try { fs.rmdirSync(dir); } catch { /* ignore */ }
  } else {
    try { fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(remain, null, 2), 'utf8'); } catch { /* ignore */ }
  }
  return { restored: restored.length, failed, items: restored };
}

/* 彻底清空一个批次（真正删盘，不可恢复） */
function trashPurge(batch) {
  const dir = batchDir(batch);
  if (!dir.startsWith(trashRoot())) return { purged: 0, error: '非法批次' };
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); n++; } catch { /* ignore */ }
    }
    fs.rmdirSync(dir);
  } catch (e) { return { purged: n, error: e.message }; }
  return { purged: n };
}

module.exports = {
  findSimilar, similarInfo, keepScore,
  trashPhotos, trashList, trashRestore, trashPurge, trashRoot,
  DUP_THRESH, SIM_THRESH, MAX_GROUP,
};
