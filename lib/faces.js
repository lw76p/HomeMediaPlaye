'use strict';
/* 照片人脸 AI 识别
   - 检测：SCRFD det_10g（640px，(x-127.5)/128；三 stride 解码距离必须 ×stride，每格 2 锚点）
   - 识别：ArcFace w600k_r50（112px；输入必须 v/255 —— immich 导出版特有，
     喂常规 (x-127.5)/128 会得到无意义向量，同脸自比 cos 只有 0.11）
   - 对齐：五点 → ArcFace 标准模板，2D 相似变换 Horn 闭式解（θ=atan2(S,C)，永不出反射矩阵；
     手搓 SVD 特征分解会出 det<0 的反射矩阵，重投影误差 45px）
   - 聚类：贪心增量 —— 新脸与各人物质心比余弦，≥0.45 归入并更新质心，否则建新人物；
     人工可改名/合并/重新归组，人工操作永不自动覆盖
   - 工程：仿 lib/ai.js —— 懒加载 session、keyset 分页 + setImmediate 让出、失败标 -2 防死循环
   - 模型：zip 内置 vendor/ai/models/（数据目录同名文件优先）；缺失时整体降级不碍其他功能 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('./db');
const paths = require('./paths');

const VENDOR = path.join(__dirname, '..', 'vendor', 'ai');
const DET_MODEL = 'face_det_10g.onnx';      // SCRFD-10GF 人脸检测（16.9MB）
const REC_MODEL = 'face_w600k_r50.onnx';    // ArcFace w600k_r50 识别（174MB）
const DET_SIZE = 640;
const REC_SIZE = 112;
const VEC_DIM = 512;
const DET_THRESH = 0.5;     // 检测置信度门槛（探针验证值）
const NMS_THRESH = 0.4;
const MAX_FACES = 20;       // 单张照片最多收录脸数（防极端图把任务拖死）
const MIN_FACE_PX = 48;     // 检测框宽小于此的脸太小，识别无意义，不入库
const MATCH_THRESH = 0.45;  // 贪心聚类归入阈值（保守：宁可开新人也不乱归）
/* 模型下载源：lite 包 / EXE 载荷不内置模型（体积），首次使用时下载。
   hf-mirror 是 HF 国内镜像（实测 2-3MB/s），immich 导出版与内置模型同源同文件。 */
const MODEL_URLS = {
  'face_det_10g.onnx': 'https://hf-mirror.com/immich-app/buffalo_l/resolve/main/detection/model.onnx',
  'face_w600k_r50.onnx': 'https://hf-mirror.com/immich-app/buffalo_l/resolve/main/recognition/model.onnx',
};
/* ArcFace 标准五点模板（112×112） */
const ARCFACE_DST = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

const state = {
  ort: null, detSession: null, recSession: null,
  loadErr: '', threadsFallback: '', batch: null, downloading: null,
};

/* ================= schema ================= */
function ensureSchema() {
  try { db.run(`ALTER TABLE lib_photos ADD COLUMN face_state INTEGER DEFAULT -1`); } catch { /* 列已存在 */ }
  // -1=未处理 -2=失败（不自动重试） >=1=已处理（含 0 脸的正常结果）
  db.run(`CREATE TABLE IF NOT EXISTS face_persons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    centroid BLOB,
    created_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS face_crops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    photo_id INTEGER NOT NULL,
    person_id INTEGER,
    score REAL,
    box TEXT,
    kps TEXT,
    vec BLOB,
    created_at TEXT
  )`);
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_face_crops_photo ON face_crops(photo_id)`); } catch { /* ignore */ }
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_face_crops_person ON face_crops(person_id)`); } catch { /* ignore */ }
  // 偏索引只覆盖待处理行，随推进自动变小
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_lib_photos_no_face ON lib_photos(id) WHERE face_state = -1`); } catch { /* ignore */ }
}
let schemaDone = false;
function ensureSchemaOnce() {
  if (schemaDone) return;
  ensureSchema();
  schemaDone = true;
}

/* ================= 模型文件定位 ================= */
function modelFile(name) {
  for (const p of [path.join(paths.dirs.root(), 'ai', name), path.join(VENDOR, 'models', name)]) {
    try { if (fs.existsSync(p) && fs.statSync(p).size > 1000000) return p; } catch { /* ignore */ }
  }
  return '';
}

/* 下载缺失模型（顺序队列：检测 16.9MB → 识别 174MB），落数据目录 ai/ 下。
   ai.js downloadModel 同款范式：.part 临时文件 + 长度校验 + setImmediate 让出 */
async function downloadModel() {
  const queue = ['face_det_10g.onnx', 'face_w600k_r50.onnx'].filter((n) => !modelFile(n));
  if (!queue.length) return { started: false, reason: '模型已安装' };
  if (state.downloading) return { started: false, reason: '已在下载中' };
  fs.mkdirSync(path.join(paths.dirs.root(), 'ai'), { recursive: true });
  (async () => {
    for (const name of queue) {
      const target = path.join(paths.dirs.root(), 'ai', name);
      const tmp = target + '.part';
      state.downloading = { kind: name, bytes: 0, total: 0, startedAt: Date.now() };
      try {
        const r = await fetch(MODEL_URLS[name]);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const total = Number(r.headers.get('content-length') || 0);
        state.downloading.total = total;
        const file = fs.createWriteStream(tmp);
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          file.write(Buffer.from(value));
          state.downloading.bytes += value.length;
          await new Promise((res) => setImmediate(res)); // 让出事件循环，进度接口才能被访问
        }
        await new Promise((res) => file.end(res));
        const got = fs.statSync(tmp).size;
        if (total && Math.abs(got - total) > 4096) throw new Error('下载不完整 ' + got + '/' + total);
        if (got < 1000000) throw new Error('文件过小（' + got + ' 字节），可能下载出错');
        fs.renameSync(tmp, target);
      } catch (e) {
        state.downloading = { error: String(e.message || e) + '（' + name + '）' };
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        return; // 出错停止队列，前端展示错误后可重试
      }
    }
    state.downloading = null;
  })();
  return { started: true, count: queue.length };
}

/* ================= onnxruntime（与 ai.js 同款加载/回退） ================= */
function defaultThreads() {
  let n = 1;
  try { n = (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1; } catch { /* 受限环境按 1 算 */ }
  return Math.max(1, Math.min(4, n));
}

function loadOrt() {
  if (state.ort) return state.ort;
  const ortDir = path.join(VENDOR, 'node_modules', 'onnxruntime-web');
  const ort = require(ortDir);
  const { pathToFileURL } = require('node:url');
  // Node 里 wasm 走动态 import()，必须用 file:// URL（Windows 裸路径会 ERR_UNSUPPORTED_ESM_URL_SCHEME）
  ort.env.wasm.wasmPaths = pathToFileURL(path.join(ortDir, 'dist') + path.sep).href;
  ort.env.wasm.numThreads = Math.max(1, Number(process.env.HMP_AI_THREADS || defaultThreads()) || 1);
  ort.env.wasm.simd = true;
  state.ort = ort;
  return ort;
}

async function ensureSessions() {
  if (state.detSession && state.recSession) return { det: state.detSession, rec: state.recSession };
  const detPath = modelFile(DET_MODEL);
  const recPath = modelFile(REC_MODEL);
  if (!detPath || !recPath) throw new Error('人脸模型未安装（需要 face_det_10g.onnx 与 face_w600k_r50.onnx）');
  const ort = loadOrt();
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  try {
    if (!state.detSession) state.detSession = await ort.InferenceSession.create(detPath, opts);
    if (!state.recSession) state.recSession = await ort.InferenceSession.create(recPath, opts);
  } catch (e) {
    // 多线程 WASM 在个别受限环境会建会话失败 → 退回单线程再试一次
    if (ort.env.wasm.numThreads > 1) {
      state.threadsFallback = String(e.message || e);
      ort.env.wasm.numThreads = 1;
      if (!state.detSession) state.detSession = await ort.InferenceSession.create(detPath, opts);
      if (!state.recSession) state.recSession = await ort.InferenceSession.create(recPath, opts);
    } else throw e;
  }
  return { det: state.detSession, rec: state.recSession };
}

/* ================= 向量工具 ================= */
function l2(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}
function cosSim(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function vecToBlob(v) { return Buffer.from(v.buffer, v.byteOffset, v.byteLength); }
function blobToVec(buf) {
  if (!buf) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // slice 出独立 ArrayBuffer，避免共享底层内存时字节偏移错位
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/* ================= 算法核心（全部来自探针验证版 face-probe6，勿凭记忆改写） ================= */
/* 2D 相似变换最小二乘闭式解（Horn 法）：永不出反射矩阵 */
function estimateSimilarity(src, dst) {
  const n = src.length;
  let px = 0, py = 0, qx = 0, qy = 0;
  for (let i = 0; i < n; i++) { px += src[i][0]; py += src[i][1]; qx += dst[i][0]; qy += dst[i][1]; }
  px /= n; py /= n; qx /= n; qy /= n;
  let C = 0, S = 0, norm2 = 0;
  for (let i = 0; i < n; i++) {
    const u = src[i][0] - px, v = src[i][1] - py, x = dst[i][0] - qx, y = dst[i][1] - qy;
    C += u * x + v * y;
    S += u * y - v * x;
    norm2 += u * u + v * v;
  }
  const theta = Math.atan2(S, C);
  const scale = Math.sqrt(C * C + S * S) / (norm2 || 1e-12);
  const c = Math.cos(theta), s = Math.sin(theta);
  const M = [[c, -s], [s, c]];
  return { scale, M, t: [qx - scale * (M[0][0] * px + M[0][1] * py), qy - scale * (M[1][0] * px + M[1][1] * py)] };
}

/* 逆映射双线性重采样：dst(x,y) ← src(M⁻¹(x,y))。边界外填黑 */
function warpBySim(img, w, h, tf, outSize) {
  const out = new Uint8ClampedArray(outSize * outSize * 4);
  for (let y = 0; y < outSize; y++) for (let x = 0; x < outSize; x++) {
    const dx = x - tf.t[0], dy = y - tf.t[1];
    const sx = (tf.M[0][0] * dx + tf.M[1][0] * dy) / tf.scale + 0.5;
    const sy = (tf.M[0][1] * dx + tf.M[1][1] * dy) / tf.scale + 0.5;
    const o = (y * outSize + x) * 4;
    if (sx >= 0 && sy >= 0 && sx < w - 1 && sy < h - 1) {
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      for (let c = 0; c < 3; c++) {
        const p00 = img[(y0 * w + x0) * 4 + c], p01 = img[(y0 * w + x0 + 1) * 4 + c];
        const p10 = img[((y0 + 1) * w + x0) * 4 + c], p11 = img[((y0 + 1) * w + x0 + 1) * 4 + c];
        out[o + c] = (p00 * (1 - fx) + p01 * fx) * (1 - fy) + (p10 * (1 - fx) + p11 * fx) * fy;
      }
    }
    out[o + 3] = 255;
  }
  return out;
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]), areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / ((areaA + areaB - inter) || 1e-12);
}

/* SCRFD 解码：9 路输出 = 3 stride(8/16/32) ×（分数/框×4/关键点×10）。
   三个铁坑：距离回归值 ×stride；anchor 中心=索引×stride（无 +0.5）；索引=(y*fw+x)*2+a */
function decodeDetections(dOut, names, scale) {
  const cands = [];
  const strides = [8, 16, 32];
  for (let si = 0; si < 3; si++) {
    const stride = strides[si];
    const scores = dOut[names[si]].data;
    const bboxes = dOut[names[3 + si]].data;
    const kpss = dOut[names[6 + si]].data;
    const fh = DET_SIZE / stride, fw = DET_SIZE / stride;
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
      const cx = x * stride, cy = y * stride;
      for (let a = 0; a < 2; a++) {
        const i = (y * fw + x) * 2 + a;
        if (scores[i] < DET_THRESH) continue;
        const o = i * 4;
        // bbox = 中心 + 距离×stride（distance2bbox），再除 scale 映回原图坐标
        const box = [
          (cx - bboxes[o] * stride) / scale, (cy - bboxes[o + 1] * stride) / scale,
          (cx + bboxes[o + 2] * stride) / scale, (cy + bboxes[o + 3] * stride) / scale,
        ];
        const kps = [];
        for (let k = 0; k < 5; k++) {
          kps.push((cx + kpss[i * 10 + k * 2] * stride) / scale, (cy + kpss[i * 10 + k * 2 + 1] * stride) / scale);
        }
        cands.push({ score: scores[i], box, kps });
      }
    }
  }
  // 按分数降序 + NMS 去重，截断到 MAX_FACES
  cands.sort((p, q) => q.score - p.score);
  const keep = [];
  for (const d of cands) {
    let ok = true;
    for (const k of keep) { if (iou(d.box, k.box) > NMS_THRESH) { ok = false; break; } }
    if (ok) keep.push(d);
    if (keep.length >= MAX_FACES) break;
  }
  return keep;
}

/* 单张脸：对齐 → 识别 → 512 维归一化向量 */
async function embedFace(rec, ort, img, kps10) {
  const src5 = [];
  for (let k = 0; k < 5; k++) src5.push([kps10[k * 2], kps10[k * 2 + 1]]);
  const tf = estimateSimilarity(src5, ARCFACE_DST);
  const aligned = warpBySim(img.data, img.width, img.height, tf, REC_SIZE);
  const rin = new Float32Array(3 * REC_SIZE * REC_SIZE);
  for (let y = 0; y < REC_SIZE; y++) for (let x = 0; x < REC_SIZE; x++) {
    const s = (y * REC_SIZE + x) * 4, d = y * REC_SIZE + x;
    // 识别模型输入格式（immich 导出版特有）：必须 v/255，别减均值
    for (let c = 0; c < 3; c++) rin[c * REC_SIZE * REC_SIZE + d] = aligned[s + c] / 255;
  }
  const feed = {};
  feed[rec.inputNames[0]] = new ort.Tensor('float32', rin, [1, 3, REC_SIZE, REC_SIZE]);
  const rOut = await rec.run(feed);
  return l2(Float32Array.from(rOut[rec.outputNames[0]].data));
}

/* 对外：单张 JPEG → [{ score, box, kps, vec }]。重扫入口 / 单张测试 / 批量共用 */
async function processJpeg(buf) {
  const { det, rec } = await ensureSessions();
  const ort = loadOrt(); // ensureSessions 只写 state.ort，本作用域必须显式取出
  const jpeg = require(path.join(VENDOR, 'node_modules', 'jpeg-js'));
  if (!(buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) {
    throw new Error('非 JPEG 图片');
  }
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  // 检测输入：等比缩到 640 内（右/下补 0），归一化 (x-127.5)/128
  const scale = DET_SIZE / Math.max(img.width, img.height);
  const nw = Math.round(img.width * scale), nh = Math.round(img.height * scale);
  const inp = new Float32Array(3 * DET_SIZE * DET_SIZE);
  const px = DET_SIZE * DET_SIZE;
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const sx0 = Math.min(img.width - 1, (x / scale) | 0), sy0 = Math.min(img.height - 1, (y / scale) | 0);
    const s = (sy0 * img.width + sx0) * 4, d = y * DET_SIZE + x;
    for (let c = 0; c < 3; c++) inp[c * px + d] = (img.data[s + c] - 127.5) / 128;
  }
  const dFeed = {};
  dFeed[det.inputNames[0]] = new ort.Tensor('float32', inp, [1, 3, DET_SIZE, DET_SIZE]);
  const dOut = await det.run(dFeed);
  const faces = decodeDetections(dOut, det.outputNames, scale);
  const out = [];
  for (const f of faces) {
    if (f.box[2] - f.box[0] < MIN_FACE_PX) continue; // 太小的脸识别无意义
    const vec = await embedFace(rec, ort, img, f.kps);
    out.push({ score: Number(f.score.toFixed(4)), box: f.box.map((v) => Math.round(v)), kps: f.kps.map((v) => Math.round(v)), vec });
  }
  return { faces: out, width: img.width, height: img.height };
}

/* ================= 贪心聚类 ================= */
function recomputeCentroid(personId) {
  const rows = db.all(`SELECT vec FROM face_crops WHERE person_id = ? AND vec IS NOT NULL`, [personId]);
  if (!rows.length) return;
  const acc = new Float32Array(VEC_DIM);
  for (const r of rows) {
    const v = blobToVec(r.vec);
    if (!v) continue;
    for (let i = 0; i < VEC_DIM; i++) acc[i] += v[i];
  }
  db.run(`UPDATE face_persons SET centroid = ? WHERE id = ?`, [vecToBlob(l2(acc)), personId]);
}

/* 归入最相似人物或建新人物。返回 person_id */
function matchOrCreatePerson(vec) {
  let bestId = 0, bestScore = -1;
  const persons = db.all(`SELECT id, centroid FROM face_persons WHERE centroid IS NOT NULL`);
  for (const p of persons) {
    const c = blobToVec(p.centroid);
    if (!c) continue;
    const s = cosSim(vec, c);
    if (s > bestScore) { bestScore = s; bestId = p.id; }
  }
  if (bestId && bestScore >= MATCH_THRESH) {
    // 增量更新质心：新质心 = l2(旧质心×n + 新向量)（旧质心已归一化 → ×n 即还原累加和）
    const p = db.get(`SELECT centroid FROM face_persons WHERE id = ?`, [bestId]);
    const c = blobToVec(p.centroid);
    const n = db.get(`SELECT COUNT(*) AS n FROM face_crops WHERE person_id = ?`, [bestId]).n || 1;
    const acc = new Float32Array(VEC_DIM);
    for (let i = 0; i < VEC_DIM; i++) acc[i] = c[i] * n + vec[i];
    db.run(`UPDATE face_persons SET centroid = ? WHERE id = ?`, [vecToBlob(l2(acc)), bestId]);
    return bestId;
  }
  const n = db.get(`SELECT COUNT(*) AS n FROM face_persons`).n;
  const r = db.run(`INSERT INTO face_persons (name, centroid, created_at) VALUES (?, ?, ?)`,
    [`未命名 ${n + 1}`, vecToBlob(vec), new Date().toISOString()]);
  return Number(r.lastInsertRowid || r.lastInsertROWID || r.changes);
}

/* ================= 批量提取（keyset 分页 + setImmediate 让出 + 失败标 -2） ================= */
function pendingCount() {
  try { return db.get(`SELECT COUNT(*) AS n FROM lib_photos WHERE face_state = -1`).n; } catch { return 0; }
}
function failedCount() {
  try { return db.get(`SELECT COUNT(*) AS n FROM lib_photos WHERE face_state = -2`).n; } catch { return 0; }
}
function doneCount() {
  try { return db.get(`SELECT COUNT(*) AS n FROM lib_photos WHERE face_state >= 1`).n; } catch { return 0; }
}
function resetFailed() {
  ensureSchemaOnce();
  try { return db.run(`UPDATE lib_photos SET face_state = -1 WHERE face_state = -2`).changes || 0; } catch { return 0; }
}

function progress() {
  ensureSchemaOnce();
  let persons = 0, crops = 0, named = 0;
  try {
    persons = db.get(`SELECT COUNT(*) AS n FROM face_persons`).n || 0;
    crops = db.get(`SELECT COUNT(*) AS n FROM face_crops`).n || 0;
    named = db.get(`SELECT COUNT(*) AS n FROM face_persons WHERE name NOT LIKE '未命名%'`).n || 0;
  } catch { /* ignore */ }
  const b = state.batch;
  return {
    model: 'SCRFD-10GF + ArcFace w600k_r50（本地）',
    installed: !!(modelFile(DET_MODEL) && modelFile(REC_MODEL)),
    loadErr: state.loadErr,
    threads: state.ort ? state.ort.env.wasm.numThreads : Math.max(1, Number(process.env.HMP_AI_THREADS || defaultThreads()) || 1),
    threadsFallback: state.threadsFallback,
    matchThresh: MATCH_THRESH,
    pending: pendingCount(), failed: failedCount(), done: doneCount(),
    persons, crops, named,
    batch: b ? { ...b } : null,
    downloading: state.downloading,
  };
}

function stopBatch() {
  if (state.batch && state.batch.running) state.batch.stop = true;
  return !!state.batch;
}

/* opts.thumb(id) → Promise<Buffer>：缩略图获取由 server 层注入（同 ai.js 用法） */
async function startBatch(opts = {}) {
  if (state.batch && state.batch.running) throw new Error('人脸提取已在进行中');
  if (typeof opts.thumb !== 'function') throw new Error('缺少缩略图回调');
  ensureSchema();
  if (!(modelFile(DET_MODEL) && modelFile(REC_MODEL))) throw new Error('人脸模型未安装');
  const thumb = opts.thumb;
  const limit = Math.max(0, Number(opts.limit || 0));
  const b = state.batch = {
    running: true, stop: false, done: 0, total: 0, ok: 0, fail: 0, noFace: 0, faces: 0,
    startedAt: Date.now(), finishedAt: 0, error: '', lastError: '', limit,
  };
  (async () => {
    try {
      b.total = Math.min(limit || Infinity, pendingCount());
      let lastId = 0, stalled = 0;
      for (;;) {
        if (b.stop) break;
        if (limit && b.done >= limit) break;
        // keyset 分页（id 单调前进）。处理完的行 face_state 变 1/-2 自动移出候选集，
        // 绝不用「同一条件反复取」——否则同一批被反复选中，任务永不结束（ai.js 踩过的坑）
        let rows = db.all(`SELECT id FROM lib_photos WHERE id > ? AND face_state = -1 ORDER BY id LIMIT 200`, [lastId]);
        if (!rows.length) break;
        if (limit) rows = rows.slice(0, limit - b.done);
        const okBefore = b.ok;
        for (const row of rows) {
          if (b.stop) break;
          lastId = row.id;
          try {
            const buf = await thumb(row.id);
            if (!buf) throw new Error('缩略图不可用');
            const r = await processJpeg(Buffer.from(buf));
            for (const f of r.faces) {
              const pid = matchOrCreatePerson(f.vec);
              db.run(`INSERT INTO face_crops (photo_id, person_id, score, box, kps, vec, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [row.id, pid, f.score, JSON.stringify(f.box), JSON.stringify(f.kps), vecToBlob(f.vec), new Date().toISOString()]);
              b.faces += 1;
            }
            if (!r.faces.length) b.noFace += 1;
            db.run(`UPDATE lib_photos SET face_state = 1 WHERE id = ?`, [row.id]);
            b.ok += 1;
          } catch (e) {
            b.fail += 1;
            if (!b.lastError) b.lastError = String((e && e.message) || e); // 首错留档
            try { db.run(`UPDATE lib_photos SET face_state = -2 WHERE id = ?`, [row.id]); } catch { /* ignore */ }
          }
          b.done += 1;
          if (b.done % 5 === 0) await new Promise((res) => setImmediate(res)); // 检测+识别较重，勤让出
        }
        // 兜底闸门：整批零成功说明候选行没能移出候选集，两轮即收手，绝不死循环
        if (b.ok === okBefore) {
          stalled += 1;
          if (stalled >= 2) { b.error = '人脸提取无进展，已中止：' + (b.lastError || '未知错误'); break; }
        } else stalled = 0;
      }
    } catch (e) { b.error = String(e.message || e); }
    b.running = false;
    b.finishedAt = Date.now();
    b.secs = Math.round((b.finishedAt - b.startedAt) / 1000);
  })();
  return { started: true };
}

/* ================= 人物管理 / 查询 ================= */
function listPersons(opts = {}) {
  ensureSchemaOnce();
  // rootIds（儿童模式白名单）：人物至少要有一张脸落在白名单内才出现，封面也只从白名单里选
  const hasScope = Array.isArray(opts.rootIds) && opts.rootIds.length > 0;
  const scope = hasScope ? ` AND ph.root_id IN (${opts.rootIds.map(() => '?').join(',')})` : '';
  const args = hasScope ? opts.rootIds.map(Number) : [];
  const persons = db.all(`SELECT * FROM (
      SELECT p.id, p.name, p.created_at,
        (SELECT COUNT(*) FROM face_crops c JOIN lib_photos ph ON ph.id = c.photo_id
          WHERE c.person_id = p.id${scope}) AS face_count
      FROM face_persons p
    ) WHERE face_count > 0 ORDER BY face_count DESC, id ASC`, args);
  for (const p of persons) {
    // 封面 = 该人物检测置信度最高的一张脸
    const cov = db.get(`SELECT c.photo_id, c.score FROM face_crops c JOIN lib_photos ph ON ph.id = c.photo_id
      WHERE c.person_id = ?${scope} ORDER BY c.score DESC LIMIT 1`, [p.id, ...args]);
    p.cover_photo_id = cov ? cov.photo_id : null;
    p.cover_score = cov ? cov.score : null;
  }
  return persons;
}

function personPhotos(personId, opts = {}) {
  ensureSchemaOnce();
  const limit = Math.max(1, Math.min(500, Number(opts.limit || 200)));
  const hasScope = Array.isArray(opts.rootIds) && opts.rootIds.length > 0;
  const scope = hasScope ? ` AND ph.root_id IN (${opts.rootIds.map(() => '?').join(',')})` : '';
  const args = [Number(personId) || 0, ...(hasScope ? opts.rootIds.map(Number) : []), limit];
  return db.all(`SELECT c.id, c.photo_id, c.score, c.box, ph.name AS photo_name, ph.album, ph.w, ph.h
    FROM face_crops c JOIN lib_photos ph ON ph.id = c.photo_id
    WHERE c.person_id = ?${scope} ORDER BY c.score DESC LIMIT ?`, args);
}

/* 某张照片的全部人脸（详情浮层画框用） */
function photoFaces(photoId) {
  ensureSchemaOnce();
  return db.all(`SELECT c.id, c.person_id, c.score, c.box, p.name AS person_name
    FROM face_crops c LEFT JOIN face_persons p ON p.id = c.person_id
    WHERE c.photo_id = ? ORDER BY c.score DESC`, [Number(photoId) || 0]);
}

function renamePerson(personId, name) {
  ensureSchemaOnce();
  const clean = String(name || '').trim().slice(0, 24);
  if (!clean) throw new Error('名字不能为空');
  db.run(`UPDATE face_persons SET name = ? WHERE id = ?`, [clean, Number(personId) || 0]);
  return { id: Number(personId) || 0, name: clean };
}

function deletePerson(personId) {
  ensureSchemaOnce();
  const id = Number(personId) || 0;
  // 脸记录保留（person_id 置 NULL），可再归组；不删向量
  db.run(`UPDATE face_crops SET person_id = NULL WHERE person_id = ?`, [id]);
  db.run(`DELETE FROM face_persons WHERE id = ?`, [id]);
  return { id };
}

/* 合并人物：from 并入 into，重算 into 质心 */
function mergePersons(fromId, intoId) {
  ensureSchemaOnce();
  const from = Number(fromId) || 0, into = Number(intoId) || 0;
  if (!from || !into || from === into) throw new Error('合并参数无效');
  if (!db.get(`SELECT id FROM face_persons WHERE id = ?`, [into])) throw new Error('目标人物不存在');
  db.run(`UPDATE face_crops SET person_id = ? WHERE person_id = ?`, [into, from]);
  db.run(`DELETE FROM face_persons WHERE id = ?`, [from]);
  recomputeCentroid(into);
  return { into };
}

/* 人工归组：单张脸改归属（personId 传 0/null = 移出为未分配） */
function assignCrop(cropId, personId) {
  ensureSchemaOnce();
  const cid = Number(cropId) || 0;
  const pid = Number(personId) || 0;
  const crop = db.get(`SELECT id, person_id FROM face_crops WHERE id = ?`, [cid]);
  if (!crop) throw new Error('人脸记录不存在');
  if (pid && !db.get(`SELECT id FROM face_persons WHERE id = ?`, [pid])) throw new Error('目标人物不存在');
  const oldPid = crop.person_id;
  db.run(`UPDATE face_crops SET person_id = ? WHERE id = ?`, [pid || null, cid]);
  if (oldPid) recomputeCentroid(oldPid);
  if (pid) recomputeCentroid(pid);
  return { id: cid, person_id: pid || null };
}

/* 未分配人脸列表（人工归组工作台数据源） */
function unassignedFaces(opts = {}) {
  ensureSchemaOnce();
  const limit = Math.max(1, Math.min(500, Number(opts.limit || 100)));
  const hasScope = Array.isArray(opts.rootIds) && opts.rootIds.length > 0;
  const scope = hasScope ? ` AND ph.root_id IN (${opts.rootIds.map(() => '?').join(',')})` : '';
  const args = [...(hasScope ? opts.rootIds.map(Number) : []), limit];
  return db.all(`SELECT c.id, c.photo_id, c.score, c.box, ph.name AS photo_name
    FROM face_crops c JOIN lib_photos ph ON ph.id = c.photo_id
    WHERE c.person_id IS NULL${scope} ORDER BY c.score DESC LIMIT ?`, args);
}

/* 整库重扫：全部照片放回待处理队列（先清空人脸数据），危险操作由路由层确认 */
function reprocessAll() {
  ensureSchemaOnce();
  if (state.batch && state.batch.running) throw new Error('人脸提取进行中，先停止再操作');
  const n = db.run(`UPDATE lib_photos SET face_state = -1 WHERE face_state <> -1`).changes || 0;
  db.run(`DELETE FROM face_crops`);
  db.run(`DELETE FROM face_persons`);
  return { reset: n };
}

module.exports = {
  ensureSchema, progress, startBatch, stopBatch, downloadModel,
  processJpeg, pendingCount, failedCount, doneCount, resetFailed, reprocessAll,
  listPersons, personPhotos, photoFaces, renamePerson, deletePerson, mergePersons, assignCrop, unassignedFaces,
  matchOrCreatePerson, recomputeCentroid, vecToBlob, blobToVec,
};
