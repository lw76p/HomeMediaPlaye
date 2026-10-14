'use strict';
/* AI 增强包：本地 CLIP 视觉模型照片自动分类
   - 推理走 onnxruntime-web 的 WASM 构建（纯 Node，无原生二进制）：
     Windows / macOS / Linux(含老 glibc 的 NAS) 同一套代码，跨平台零安装
   - 模型是普通数据文件，放数据目录 ai/ 下（vendor 里不含模型，可单独下载/更新）
   - 一次前向同时产出「分类 + 512 维图片向量」：向量入库后可支撑相似图/重复图/以文搜图
   - 只处理「未分类」照片（category='' 且 ai_conf<0），绝不覆盖手动标签
   - 运行时文件缺失时本模块整体降级：其余功能不受任何影响
   - 自然语言找图：中文查询 → 英文提示词（aisearch-wordmap）→ 文本向量 → 与全库图片向量比余弦 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('./db');
const paths = require('./paths');
const wordmap = require('./aisearch-wordmap');

const VENDOR = path.join(__dirname, '..', 'vendor', 'ai');
const MODEL_NAME = 'clip_visual.onnx';                       // 视觉编码器：看图 → 图片向量
const TEXT_MODEL_NAME = 'clip_text_model_vitb32.onnx';       // 文本编码器：读词表 → 文本向量
const LABELS_FILE = path.join(VENDOR, 'labels.json');        // 内置默认词表（自带预计算向量）
const TOKENIZER_DIR = path.join(VENDOR, 'tokenizer');        // CLIP 分词器（vocab.json + merges.txt）
const MODEL_BASE = 'https://www.modelscope.cn/models/cix/ai_model_hub_25_Q3/resolve/master/models/Generative_AI/Image_to_Text/onnx_clip/model/';
const MODEL_URL = MODEL_BASE + MODEL_NAME;
const TEXT_MODEL_URL = MODEL_BASE + TEXT_MODEL_NAME;
const SIZE = 224;
const TEXT_LEN = 77;   // CLIP 文本编码器固定 77 token（不足补 0）
const DIM = 512;       // 图文共享向量维度
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
const LOW_CONF = 0.6;

const modelDir = () => path.join(paths.dirs.root(), 'ai');
const modelPath = () => path.join(modelDir(), MODEL_NAME);
const textModelPath = () => path.join(modelDir(), TEXT_MODEL_NAME);
const labelCfgPath = () => path.join(modelDir(), 'labels.custom.json');    // 用户词表配置（持久，升级不覆盖）
const labelActivePath = () => path.join(modelDir(), 'labels.active.json'); // 自定义词表的向量缓存

const state = {
  ort: null, session: null, textSession: null,
  labels: null, labelVecs: null, catNames: null, labelSource: 'default',
  loadErr: '', downloading: null, batch: null, reclass: null, threadsFallback: '',
};

function ensureSchema() {
  try { db.run(`ALTER TABLE lib_photos ADD COLUMN ai_conf REAL DEFAULT -1`); } catch { /* 列已存在 */ }
  // 512 维 float32 图片向量（2048 字节/张）：一次算好永久复用，
  // 后面的「相似图 / 重复图 / 以文搜图」都只比向量，不必再跑模型
  try { db.run(`ALTER TABLE lib_photos ADD COLUMN ai_vec BLOB`); } catch { /* 列已存在 */ }
  // 偏索引只覆盖「还没算向量」的行，随处理推进自动变小（BLOB 本身不能建索引）
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_lib_photos_no_vec ON lib_photos(id) WHERE ai_vec IS NULL`); } catch { /* ignore */ }
}
let schemaDone = false;
function ensureSchemaOnce() {
  if (schemaDone) return;
  ensureSchema();
  schemaDone = true;
}

function modelFile() {
  for (const p of [modelPath(), path.join(VENDOR, 'models', MODEL_NAME)]) {
    try { if (fs.existsSync(p) && fs.statSync(p).size > 1000000) return p; } catch { /* ignore */ }
  }
  return '';
}

function textModelFile() {
  for (const p of [textModelPath(), path.join(VENDOR, 'models', TEXT_MODEL_NAME)]) {
    try { if (fs.existsSync(p) && fs.statSync(p).size > 1000000) return p; } catch { /* ignore */ }
  }
  return '';
}

/* ================= CLIP 分词器（零依赖；语义与 HF CLIPTokenizer 一致） =================
   模型只认 token id，词表/提示词必须先过这一层。SOT=49406 / EOT=49407，
   末字符带 </w>，预切分阶段丢弃空格（CLIP 的既有行为）。 */
function bytesToUnicode() {
  const bs = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n += 1; }
  const map = {};
  for (let i = 0; i < bs.length; i++) map[bs[i]] = String.fromCodePoint(cs[i]);
  return map;
}

const SOT = 49406;
const EOT = 49407;

class ClipTokenizer {
  constructor(vocabPath, mergesPath) {
    this.encoder = JSON.parse(fs.readFileSync(vocabPath, 'utf8'));
    this.byteEncoder = bytesToUnicode();
    const lines = fs.readFileSync(mergesPath, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
    this.bpeRanks = new Map();
    for (let i = 0; i < lines.length; i++) if (!this.bpeRanks.has(lines[i])) this.bpeRanks.set(lines[i], i);
    this.pat = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]+|[^\s\p{L}\p{N}]+/giu;
    this.cache = new Map();
  }

  static getPairs(word) {
    const pairs = new Set();
    for (let i = 0; i < word.length - 1; i++) pairs.add(word[i] + '\u0000' + word[i + 1]);
    return pairs;
  }

  bpe(token) {
    if (this.cache.has(token)) return this.cache.get(token);
    let word = token.slice(0, -1).split('').concat([token.slice(-1) + '</w>']);
    if (word.length === 1) { this.cache.set(token, token + '</w>'); return token + '</w>'; }
    let pairs = ClipTokenizer.getPairs(word);
    if (!pairs.size) { this.cache.set(token, token); return token; }
    for (;;) {
      let best = null, bestRank = Infinity;
      for (const p of pairs) {
        const r = this.bpeRanks.get(p.replace('\u0000', ' '));
        if (r !== undefined && r < bestRank) { bestRank = r; best = p; }
      }
      if (best === null) break;
      const first = best.split('\u0000')[0];
      const second = best.split('\u0000')[1];
      const next = [];
      let i = 0;
      while (i < word.length) {
        const j = word.indexOf(first, i);
        if (j === -1) { next.push(...word.slice(i)); break; }
        next.push(...word.slice(i, j));
        i = j;
        if (word[i] === first && i < word.length - 1 && word[i + 1] === second) { next.push(first + second); i += 2; }
        else { next.push(word[i]); i += 1; }
      }
      word = next;
      if (word.length === 1) break;
      pairs = ClipTokenizer.getPairs(word);
    }
    const out = word.join(' ');
    this.cache.set(token, out);
    return out;
  }

  encode(text, maxLen = TEXT_LEN) {
    const cleaned = String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const ids = [SOT];
    for (const chunk of (cleaned.match(this.pat) || [])) {
      let mapped = '';
      for (const byte of Buffer.from(chunk, 'utf8')) mapped += this.byteEncoder[byte];
      for (const p of this.bpe(mapped).split(' ')) {
        const id = this.encoder[p];
        if (id === undefined) throw new Error('词表缺失 token: ' + JSON.stringify(p));
        ids.push(id);
      }
    }
    ids.push(EOT);
    const trimmed = ids.slice(0, maxLen);
    if (trimmed[trimmed.length - 1] !== EOT) trimmed[trimmed.length - 1] = EOT;
    return trimmed;
  }

  pad(ids, len = TEXT_LEN) {
    const out = ids.slice(0, len);
    while (out.length < len) out.push(0);
    return out;
  }
}

let _tok = null;
function tokenizer() {
  if (_tok) return _tok;
  const vp = path.join(TOKENIZER_DIR, 'vocab.json');
  const mp = path.join(TOKENIZER_DIR, 'merges.txt');
  if (!fs.existsSync(vp) || !fs.existsSync(mp)) throw new Error('分词器文件缺失（vendor/ai/tokenizer）');
  _tok = new ClipTokenizer(vp, mp);
  return _tok;
}

/* ================= 词表：配置 → 文本向量 → 生效 ================= */
function normPrompts(v) {
  if (Array.isArray(v)) return v.map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
  // 字符串形式：一行一条。英文提示词里常带逗号（"a photo of food, on a table"），故不按逗号切
  return String(v == null ? '' : v).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function defaultLabelPrompts() {
  try {
    const j = JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8'));
    if (!j || !j.prompts) return null;
    return Object.keys(j.prompts).map((k) => ({ name: k, prompts: normPrompts(j.prompts[k]) })).filter((x) => x.prompts.length);
  } catch { return null; }
}

/* 读用户词表配置；无效或不存在时回落到内置默认 */
function labelCfgRead() {
  let custom = null;
  try {
    const j = JSON.parse(fs.readFileSync(labelCfgPath(), 'utf8'));
    const list = Array.isArray(j) ? j : (Array.isArray(j.labels) ? j.labels : null);
    if (list && list.length) {
      const clean = list
        .map((x) => ({ name: String((x && x.name) || '').trim(), prompts: normPrompts(x && x.prompts) }))
        .filter((x) => x.name && x.prompts.length);
      if (clean.length >= 2) custom = clean;
    }
  } catch { /* 无自定义配置 */ }
  if (custom) return { custom: true, labels: custom };
  const d = defaultLabelPrompts();
  return d ? { custom: false, labels: d } : null;
}

/* 配置指纹：内容没变就不重算向量、不加载文本模型 */
function cfgHash(labels) {
  const crypto = require('node:crypto');
  return crypto.createHash('md5').update(JSON.stringify(labels.map((l) => [l.name, l.prompts]))).digest('hex').slice(0, 12);
}

function applyActive(j, source) {
  state.labels = j;
  state.catNames = Object.keys(j.cats);
  state.labelVecs = state.catNames.map((c) => Float32Array.from(j.cats[c]));
  state.labelSource = source;
  return state.labels;
}

function readActive() {
  try {
    const j = JSON.parse(fs.readFileSync(labelActivePath(), 'utf8'));
    if (j && j.cats && Object.keys(j.cats).length) return j;
  } catch { /* 无缓存 */ }
  return null;
}

function resetLabels() { state.labels = null; state.labelVecs = null; state.catNames = null; }

function labelsInfo() {
  if (state.labels) return state.labels;
  const act = readActive();
  if (act) return applyActive(act, 'custom');
  try {
    const j = JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8'));
    if (j && j.cats && Object.keys(j.cats).length) return applyActive(j, 'default');
  } catch (e) { state.loadErr = '标签文件缺失: ' + e.message; }
  state.loadErr = state.loadErr || '标签文件缺失';
  return null;
}

/* 配置与当前生效词表是否已一致（轻量：只比 hash，不加载模型、不算向量） */
function labelsInSync() {
  const cfg = labelCfgRead();
  if (!cfg) return true;
  if (!cfg.custom) return state.labelSource === 'default' && !readActive();
  const act = readActive();
  return !!(act && act.cfgHash === cfgHash(cfg.labels) && state.labelSource === 'custom');
}

async function encodeTexts(texts) {
  const session = await ensureTextSession();
  const ort = loadOrt();
  const tok = tokenizer();
  const out = [];
  for (const t of texts) {
    const feed = {};
    feed[session.inputNames[0]] = new ort.Tensor('int32', Int32Array.from(tok.pad(tok.encode(t), TEXT_LEN)), [1, TEXT_LEN]);
    const o = await session.run(feed);
    out.push(l2(Float32Array.from(o[session.outputNames[0]].data)));
  }
  return out;
}

/* 每类多条提示词取平均 → 类向量（多说法能压住边界样本的抖动） */
async function encodeLabelSet(labels) {
  const cats = {};
  for (const item of labels) {
    const vs = await encodeTexts(item.prompts);
    const acc = new Float32Array(DIM);
    for (const v of vs) for (let i = 0; i < DIM; i++) acc[i] += v[i] / vs.length;
    cats[item.name] = Array.from(l2(acc));
  }
  return cats;
}

/* 让生效词表与用户配置一致：配置变了才重算（文本编码器秒级出向量），否则直接秒回 */
async function syncLabels() {
  const cfg = labelCfgRead();
  if (!cfg) { labelsInfo(); return state.labels; }
  const hash = cfgHash(cfg.labels);
  if (!cfg.custom) {
    // 回到内置默认：清掉自定义缓存，直接用预计算向量（零成本、无需文本模型）
    if (readActive()) { try { fs.unlinkSync(labelActivePath()); } catch { /* ignore */ } }
    if (state.labelSource === 'default' && state.labels) return state.labels;
    resetLabels();
    return labelsInfo();
  }
  const act = readActive();
  if (act && act.cfgHash === hash) {
    if (state.labelSource === 'custom' && state.labels) return state.labels;
    return applyActive(act, 'custom');
  }
  if (!textModelFile()) throw new Error('自定义词表需要文本编码器（请先下载文本模型）');
  const cats = await encodeLabelSet(cfg.labels);
  const out = {
    dim: DIM, cfgHash: hash, custom: true, cats,
    prompts: Object.fromEntries(cfg.labels.map((l) => [l.name, l.prompts])),
    madeAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(modelDir(), { recursive: true });
    fs.writeFileSync(labelActivePath(), JSON.stringify(out));
  } catch { /* 写缓存失败不影响本次内存生效 */ }
  return applyActive(out, 'custom');
}

/* 保存用户词表配置（写盘即可，向量由 syncLabels 重算） */
function labelCfgSet(labels) {
  const clean = (Array.isArray(labels) ? labels : [])
    .map((x) => ({ name: String((x && x.name) || '').trim().slice(0, 12), prompts: normPrompts(x && x.prompts) }))
    .filter((x) => x.name && x.prompts.length);
  if (clean.length < 2) throw new Error('至少需要 2 个分类，且每个分类都要有名称和提示词');
  if (clean.length > 24) throw new Error('分类最多 24 个');
  const seen = new Set();
  for (const c of clean) {
    if (seen.has(c.name)) throw new Error('分类名重复：' + c.name);
    seen.add(c.name);
  }
  fs.mkdirSync(modelDir(), { recursive: true });
  fs.writeFileSync(labelCfgPath(), JSON.stringify({ version: 1, labels: clean }, null, 2));
  return clean;
}

/* 恢复内置默认词表（删掉用户配置与缓存） */
function labelCfgReset() {
  for (const p of [labelCfgPath(), labelActivePath()]) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
  }
  resetLabels();
  return labelsInfo() ? state.catNames : [];
}

/* 默认线程数：按本机可用核数取，上限 4。
   QNAP V1500B（4c/8t）实测单张前向：1 线程 679ms、2 线程 398ms、4 线程 353ms、8 线程 381ms
   → 4 是拐点，再多反被调度拖慢；可用 HMP_AI_THREADS 覆盖 */
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

async function ensureSession() {
  if (state.session) return state.session;
  const mp = modelFile();
  if (!mp) throw new Error('模型未安装');
  const ort = loadOrt();
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  try {
    state.session = await ort.InferenceSession.create(mp, opts);
  } catch (e) {
    // 多线程 WASM 在个别受限环境（无 SharedArrayBuffer / worker 起不来）会建会话失败 → 退回单线程再试一次
    if (ort.env.wasm.numThreads > 1) {
      state.threadsFallback = String(e.message || e);
      ort.env.wasm.numThreads = 1;
      state.session = await ort.InferenceSession.create(mp, opts);
    } else throw e;
  }
  return state.session;
}

/* 文本编码器：与视觉编码器同一套加载/回退逻辑，只是模型文件不同。
   只有「自定义词表」需要它；平时不占内存、不加载。 */
async function ensureTextSession() {
  if (state.textSession) return state.textSession;
  const mp = textModelFile();
  if (!mp) throw new Error('文本模型未安装（设置页可下载）');
  const ort = loadOrt();
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  try {
    state.textSession = await ort.InferenceSession.create(mp, opts);
  } catch (e) {
    // 与视觉侧一致：多线程建会话失败时退回单线程再试一次
    if (ort.env.wasm.numThreads > 1) {
      state.threadsFallback = state.threadsFallback || String(e.message || e);
      ort.env.wasm.numThreads = 1;
      state.textSession = await ort.InferenceSession.create(mp, opts);
    } else throw e;
  }
  return state.textSession;
}

/* ---------------- 图像预处理（与训练侧一致的 CLIP 标准流程） ---------------- */
function bilinearResize(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xr = sw / dw, yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * yr - 0.5;
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(sh - 1, y0 + 1), wy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * xr - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(sw - 1, x0 + 1), wx = sx - x0;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 3; c++) {
        const p00 = src[(y0 * sw + x0) * 4 + c], p01 = src[(y0 * sw + x1) * 4 + c];
        const p10 = src[(y1 * sw + x0) * 4 + c], p11 = src[(y1 * sw + x1) * 4 + c];
        out[o + c] = (p00 * (1 - wx) + p01 * wx) * (1 - wy) + (p10 * (1 - wx) + p11 * wx) * wy;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

function preprocess(img) {
  const { width: w, height: h, data } = img;
  const scale = SIZE / Math.min(w, h);
  const nw = Math.max(SIZE, Math.round(w * scale));
  const nh = Math.max(SIZE, Math.round(h * scale));
  const resized = bilinearResize(data, w, h, nw, nh);
  const ox = Math.floor((nw - SIZE) / 2), oy = Math.floor((nh - SIZE) / 2);
  const out = new Float32Array(3 * SIZE * SIZE);
  const px = SIZE * SIZE;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const s = ((y + oy) * nw + (x + ox)) * 4;
      const d = y * SIZE + x;
      for (let c = 0; c < 3; c++) out[c * px + d] = (resized[s + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  return out;
}

const l2 = (v) => {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
};

/* 向量 ↔ BLOB：Float32Array(512) 存 2048 字节 */
function vecToBlob(v) { return Buffer.from(v.buffer, v.byteOffset, v.byteLength); }
function blobToVec(buf) {
  if (!buf) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // slice 出独立 ArrayBuffer，避免共享底层内存时字节偏移错位
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/* 解码 JPEG → 分类 + 图片向量。返回 { cat, prob, probs, vec } */
async function classifyJpeg(buf) {
  const session = await ensureSession();
  const ort = loadOrt(); // 必须显式取出：ensureSession() 只把 runtime 存进 state.ort，不会带进本作用域
  if (!labelsInfo()) throw new Error(state.loadErr || '标签缺失');
  const jpeg = require(path.join(VENDOR, 'node_modules', 'jpeg-js'));
  // 只认 JPEG：缩略图服务正常会给 JPEG（PNG/RAW 都由 ffmpeg 转好），
  // 极少数 ffmpeg 失败的会回退原图 → 这里给出明确原因，别让 jpeg-js 抛晦涩错误
  if (!(buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) {
    const isPng = buf.length > 7 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    throw new Error('非 JPEG 图片（' + (isPng ? 'PNG' : '未知格式') + '），无法分类');
  }
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  const feed = {};
  feed[session.inputNames[0]] = new ort.Tensor('float32', preprocess(img), [1, 3, SIZE, SIZE]);
  const out = await session.run(feed);
  const vec = l2(Float32Array.from(out[session.outputNames[0]].data));
  const cats = state.catNames; // 生效词表类名（可能来自用户自定义词表）
  const logits = state.labelVecs.map((lv) => {
    let s = 0;
    for (let i = 0; i < vec.length; i++) s += vec[i] * lv[i];
    return s;
  });
  const m = Math.max(...logits);
  const ex = logits.map((v) => Math.exp((v - m) * 100));
  const sum = ex.reduce((a, b) => a + b, 0) || 1;
  const probs = ex.map((v) => v / sum);
  let bi = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[bi]) bi = i;
  return { cat: cats[bi], prob: probs[bi], probs, vec };
}

/* ---------------- 批量自动分类（只碰未分类照片，可中断、可续跑） ---------------- */
function pendingCount() {
  // 「待处理」= 还没算过向量、且不是已失败的行。
  // ai_conf -2 = 试过但失败，不自动重选（否则同一批行被无限重选，实测空转 9119 次）
  try { return db.get(`SELECT COUNT(*) AS n FROM lib_photos WHERE ai_vec IS NULL AND ai_conf <> -2`).n; } catch { return 0; }
}

function failedCount() {
  // 只看处理状态：失败与「是否有人工标签」无关（人工标签的照片也要补向量）
  try { return db.get(`SELECT COUNT(*) AS n FROM lib_photos WHERE ai_conf = -2`).n; } catch { return 0; }
}

/* 向量库已建多少张（跑完后 = 图库总数），相似图/搜图的可用范围 */
function vecStoredCount() {
  try { return db.get(`SELECT COUNT(*) AS n FROM lib_photos WHERE ai_vec IS NOT NULL`).n; } catch { return 0; }
}

/* 可重分类规模：有向量、且属 AI 标定（人工标的 ai_conf=-1 不动） */
function reclassableCount() {
  try { return db.get(`SELECT COUNT(*) AS n FROM lib_photos WHERE ai_vec IS NOT NULL AND ai_conf >= 0`).n; } catch { return 0; }
}

/* 把「试过但失败」的行放回待处理队列（模型更新/缺陷修好后重跑用） */
function resetFailed() {
  ensureSchemaOnce();
  try { return db.run(`UPDATE lib_photos SET ai_conf = -1 WHERE ai_conf = -2`).changes || 0; } catch { return 0; }
}

function progress() {
  ensureSchemaOnce();
  const b = state.batch;
  return {
    runtime: 'wasm',
    model: 'CLIP ViT-B/32（本地）',
    installed: !!modelFile(),
    modelPath: modelFile() || modelPath(),
    modelMB: modelFile() ? Number((fs.statSync(modelFile()).size / 1048576).toFixed(1)) : 0,
    labels: labelsInfo() ? (state.catNames || []) : [],
    labelSource: state.labelSource,   // default=内置词表 / custom=用户自定义词表
    labelPrompts: (state.labelSource === 'custom' && state.labels && state.labels.prompts) ? state.labels.prompts : null,
    loadErr: state.loadErr,
    lowConf: LOW_CONF,
    threads: state.ort ? state.ort.env.wasm.numThreads : Math.max(1, Number(process.env.HMP_AI_THREADS || defaultThreads()) || 1),
    threadsFallback: state.threadsFallback,
    downloading: state.downloading,
    pending: pendingCount(),
    failed: failedCount(),
    vecStored: vecStoredCount(),
    reclassable: reclassableCount(),
    textModel: {
      installed: !!textModelFile(),
      path: textModelFile() || textModelPath(),
      mb: textModelFile() ? Number((fs.statSync(textModelFile()).size / 1048576).toFixed(1)) : 0,
    },
    batch: b ? { ...b } : null,
    reclass: state.reclass ? { ...state.reclass } : null,
  };
}

function stopBatch() {
  if (state.batch && state.batch.running) state.batch.stop = true;
  return !!state.batch;
}

/* 下载模型：kind = 'text'（文本编码器）| 'visual'（视觉编码器）
   两个模型都是普通数据文件，落在数据目录 ai/ 下，升级/覆盖安装不会动它们 */
/* ---------------- 按当前词表重分类：只重算分类、不重跑模型 ----------------
   图片向量已入库 → 只需与新的文本向量比距离（512 维 × 类数，毫秒级/张）。
   这是「词表随便改」的关键：改词表零成本重刷全库，不必重跑 2.5 万次前向。
   只动 AI 标定的照片（ai_conf>=0）；人工标的（ai_conf=-1）一律跳过。 */
function stopReclass() {
  if (state.reclass && state.reclass.running) state.reclass.stop = true;
  return !!(state.reclass && state.reclass.running);
}

async function reclassifyAll() {
  if (state.reclass && state.reclass.running) throw new Error('重分类已在进行中');
  if (state.batch && state.batch.running) throw new Error('分类任务进行中，请先等它结束或停止');
  ensureSchema();
  await syncLabels();
  if (!state.labelVecs || !state.catNames) throw new Error(state.loadErr || '标签缺失');
  const r = state.reclass = {
    running: true, stop: false, done: 0, total: reclassableCount(), changed: 0, unchanged: 0,
    perCat: {}, labels: state.catNames.slice(), error: '', startedAt: Date.now(), finishedAt: 0,
  };
  (async () => {
    try {
      let lastId = 0;
      for (;;) {
        if (r.stop) break;
        // keyset 分页（id 单调前进）。绝不用「同一条件反复取」——
        // 更新后条件依旧成立，同一批会被反复取，任务永不结束（这个坑在批量分类里踩过一次）
        const rows = db.all(`SELECT id, ai_vec, category FROM lib_photos WHERE id > ? AND ai_vec IS NOT NULL AND ai_conf >= 0 ORDER BY id LIMIT 400`, [lastId]);
        if (!rows.length) break;
        for (const row of rows) {
          lastId = row.id;
          if (r.stop) break;
          const vec = blobToVec(row.ai_vec);
          if (!vec) { r.done += 1; continue; }
          const logits = state.labelVecs.map((lv) => {
            let s = 0;
            for (let k = 0; k < vec.length; k++) s += vec[k] * lv[k];
            return s;
          });
          let bi = 0;
          for (let i = 1; i < logits.length; i++) if (logits[i] > logits[bi]) bi = i;
          const m = logits[bi];
          const ex = logits.map((v) => Math.exp((v - m) * 100)); // 与首次分类同一把尺子
          const sum = ex.reduce((a, b2) => a + b2, 0) || 1;
          const prob = ex[bi] / sum;
          const cat = state.catNames[bi];
          const nextCat = cat === '其他' ? '' : cat; // 「其他」在库中统一存空串
          if (nextCat !== row.category) {
            db.run(`UPDATE lib_photos SET category = ?, ai_conf = ? WHERE id = ?`, [nextCat, Number(prob.toFixed(4)), row.id]);
            r.changed += 1;
          } else {
            db.run(`UPDATE lib_photos SET ai_conf = ? WHERE id = ?`, [Number(prob.toFixed(4)), row.id]);
            r.unchanged += 1;
          }
          r.perCat[cat] = (r.perCat[cat] || 0) + 1;
          r.done += 1;
          if (r.done % 400 === 0) await new Promise((res) => setImmediate(res));
        }
        await new Promise((res) => setImmediate(res));
      }
    } catch (e) { r.error = String(e.message || e); }
    r.running = false;
    r.finishedAt = Date.now();
    r.secs = Math.round((r.finishedAt - r.startedAt) / 1000);
  })();
  return { started: true, total: r.total, labels: r.labels };
}

/* ================= 自然语言找图（以文搜图） =================
   原理：CLIP 的图文共享向量空间。文本向量与图片向量做余弦相似度即可排序。
   中文输入必须先转成英文提示词 —— CLIP 文本塔没见过中文，直接喂中文等于噪声。
   转换靠内置词表（aisearch-wordmap），不联网、不额外装模型。

   性能：25k 张 × 512 维点积 ≈ 1300 万次乘加，纯 JS 单次约 100~200ms。
   图片向量是 2048 字节定长 BLOB，一次查询全部载入内存即可。 */

/* 查询分词：中文按「词表里出现过的最长串」切，英文/数字按空白与标点切。
   不用通用分词器（中文分词要词典，装了也是几十 MB），
   反正下一步只认词表里的词 —— 词表外的东西切出来也会被丢掉。 */
function segmentQuery(q) {
  const s = String(q || '').trim();
  if (!s) return [];
  const out = [];
  // 先按空白/常见标点切成段
  const chunks = s.split(/[\s,，、。.；;：:!！?？/\\|()（）\[\]【】"']+/).filter(Boolean);
  const keys = Object.keys(wordmap.WORDS).concat(Object.keys(wordmap.MODIFIERS))
    .sort((a, b) => b.length - a.length); // 长词优先，保证「手机截图」不被切成「手机」+「截图」
  for (const ch of chunks) {
    // 段内先把 ASCII 连续片段摘出来：「zzz火星大象qqq」要能拆成 zzz / 火星 / 大象 / qqq，
    // 否则整个段会被当成一个中文串逐字切，英文残片根本进不了 unknown
    const parts = String(ch).match(/[A-Za-z0-9]['\-A-Za-z0-9]*|[^A-Za-z0-9]+/g) || [];
    for (const part of parts) {
      // 英文/数字原样保留（用户可能直接敲英文，也可能是该报「没认出」的残片）
      if (/^[A-Za-z0-9]/.test(part)) { out.push(part.toLowerCase()); continue; }
      let i = 0;
      while (i < part.length) {
        let hit = '';
        for (const k of keys) {
          if (k.length > 1 && part.startsWith(k, i)) { hit = k; break; }
        }
        if (hit) { out.push(hit); i += hit.length; continue; }
        // 单词表键：单字也试一次（「猫」「山」「海」这类高频单字）
        const one = part[i];
        if (wordmap.WORDS[one] || wordmap.MODIFIERS[one]) out.push(one);
        i += 1;
      }
    }
  }
  return out;
}

/* 中文查询 → 英文提示词数组。
   返回 { prompts, hits, unknown }：
     hits    = 命中的中文词（用于给用户反馈「我理解成了什么」）
     unknown = 没认出来的词（用于提示「这些词我没见过」）
   一条中文词带多个英文变体 → 全部收进来，之后取平均向量。 */
function queryTexts(q) {
  const toks = segmentQuery(q);
  const prompts = [];
  const hits = [];
  const unknown = [];
  const pendingMods = [];   // 还没有可修饰主体的修饰词（如单独查「夜景」）
  const seen = new Set();
  for (const t of toks) {
    if (wordmap.STOPWORDS.has(t)) continue;
    const mod = wordmap.MODIFIERS[t];
    if (mod) {
      // 修饰词：有主体就并进主体提示词；还没有主体就先攒着，等主体出现再补
      if (prompts.length) prompts[prompts.length - 1] += ' ' + mod;
      else pendingMods.push(mod);
      hits.push(t);
      continue;
    }
    const en = wordmap.WORDS[t];
    if (!en) { if (t.length > 1 || /[A-Za-z]/.test(t)) unknown.push(t); continue; }
    hits.push(t);
    for (const p of en) {
      const k = p.toLowerCase();
      if (!seen.has(k)) { seen.add(k); prompts.push(p); }
    }
  }
  // 修饰词没有修饰对象（用户就查「夜景」这类氛围词）→ 单独成句，别丢掉这次检索
  if (!prompts.length && pendingMods.length) {
    prompts.push('a photo taken ' + pendingMods.join(' '));
  }
  // 完全没命中，但用户敲的是英文 → 直接当提示词用（CLIP 本来就吃英文）
  if (!prompts.length) {
    const raw = String(q || '').trim();
    if (/^[A-Za-z0-9][A-Za-z0-9 '\-,.]*$/.test(raw)) {
      prompts.push(raw.toLowerCase().startsWith('a ') || raw.toLowerCase().startsWith('an ') ? raw : 'a photo of ' + raw);
    }
  }
  // 词表外的英文/数字残片也算「没认出」：用户敲了英文单词却查不到，得让他知道
  for (const t of toks) {
    if (wordmap.STOPWORDS.has(t)) continue;
    if (/[A-Za-z]/.test(t) && !wordmap.WORDS[t] && !wordmap.MODIFIERS[t]) unknown.push(t);
  }
  return { prompts: prompts.slice(0, 16), hits: [...new Set(hits)], unknown: [...new Set(unknown)] };
}

/* 文本 → 归一化向量（多提示词取平均后归一化，与类向量的做法一致） */
async function encodeQueryVec(q) {
  const { prompts, hits, unknown } = queryTexts(q);
  if (!prompts.length) {
    return { vec: null, prompts, hits, unknown, reason: 'empty' };
  }
  if (!textModelFile()) {
    // 没有文本模型时退而求其次：内置词表文件里带的是「分类」向量，不能拿来搜图，
    // 所以这里只能明确报错，不假装能搜
    return { vec: null, prompts, hits, unknown, reason: 'no-text-model' };
  }
  const vs = await encodeTexts(prompts);
  const acc = new Float32Array(DIM);
  for (const v of vs) for (let i = 0; i < DIM; i++) acc[i] += v[i] / vs.length;
  return { vec: l2(acc), prompts, hits, unknown, reason: '' };
}

/* 全库向量检索：返回按相似度降序的前 limit 条。
   rootIds 传 null = 不限；传空数组 = 全部隐藏（儿童模式白名单为空）。 */
function searchByVec(vec, { limit = 120, rootIds = null, minScore = 0 } = {}) {
  ensureSchemaOnce();
  if (!vec) return { items: [], scanned: 0 };
  if (Array.isArray(rootIds) && !rootIds.length) return { items: [], scanned: 0 };
  const conds = ['ai_vec IS NOT NULL'];
  const args = [];
  if (rootIds && rootIds.length) {
    conds.push(`root_id IN (${rootIds.map(() => '?').join(',')})`);
    args.push(...rootIds.map(Number));
  }
  const where = 'WHERE ' + conds.join(' AND ');
  const rows = db.all(
    `SELECT id, root_id, album, name, ext, w, h, taken_at, category, ai_conf, ai_vec, mtime
     FROM lib_photos ${where}`, args);
  const scored = [];
  for (const r of rows) {
    const v = blobToVec(r.ai_vec);
    if (!v) continue;
    let s = 0;
    for (let i = 0; i < DIM; i++) s += vec[i] * v[i]; // 两边都已 L2 归一化 → 点积即余弦
    if (s < minScore) continue;
    scored.push({ ...r, ai_vec: undefined, score: Number(s.toFixed(4)) });
  }
  scored.sort((a, b) => b.score - a.score);
  return { items: scored.slice(0, Math.max(1, Math.min(500, limit))), scanned: rows.length };
}

/* 对外：自然语言找图（一步到位：转换 + 编码 + 检索） */
async function searchByText(q, opts = {}) {
  const enc = await encodeQueryVec(q);
  if (enc.reason === 'no-text-model') {
    const e = new Error('搜图需要文本编码器，请先下载「词表模型」（约 243MB）');
    e.code = 'NO_TEXT_MODEL';
    throw e;
  }
  if (!enc.vec) {
    return {
      items: [], scanned: 0, query: String(q || ''), prompts: [], hits: [], unknown: enc.unknown,
      reason: 'empty', note: '没认出任何可检索的词，换个说法试试（如「海边的日落」「猫咪」「火锅」）',
    };
  }
  const r = searchByVec(enc.vec, opts);
  return {
    items: r.items, scanned: r.scanned, query: String(q || ''),
    prompts: enc.prompts, hits: enc.hits, unknown: enc.unknown, reason: '',
    note: r.items.length ? '' : '没有找到相似的照片（也可能是向量库还没跑完）',
  };
}

/* 搜图能力概览：向量库规模 + 支持的中文词量 */
function searchInfo() {
  ensureSchemaOnce();
  let total = 0;
  try { total = db.get(`SELECT COUNT(*) AS n FROM lib_photos`).n || 0; } catch { /* ignore */ }
  return {
    vocab: Object.keys(wordmap.WORDS).length,
    ready: vecStoredCount(),
    total,
    textModel: !!textModelFile(),
  };
}

/* ================= 下载模型 ================= */

async function downloadModel(kind) {
  // 无参时默认下「视觉编码器」：保持老前端/老调用的既有语义，
  // 绝不能因为「视觉已装」就自作主张去下 242MB 的文本模型
  const which = (kind === 'text' || kind === 'visual') ? kind : 'visual';
  const target = which === 'text' ? textModelPath() : modelPath();
  const url = which === 'text' ? TEXT_MODEL_URL : MODEL_URL;
  const exists = which === 'text' ? textModelFile() : modelFile();
  if (exists) return { started: false, reason: (which === 'text' ? '文本模型' : '视觉模型') + '已安装', kind: which };
  if (state.downloading) {
    return { started: false, reason: state.downloading.kind === which ? '已在下载中' : '另一模型正在下载中', kind: which };
  }
  fs.mkdirSync(modelDir(), { recursive: true });
  const tmp = target + '.part';
  state.downloading = { kind: which, bytes: 0, total: 0, startedAt: Date.now() };
  (async () => {
    try {
      const r = await fetch(url);
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
      // 长度校验：下载器若因故拿错地址，会得到「文件名对、内容错」的模型 ——
      // 必须在这里拦掉，否则推理时报的是看不懂的张量错误
      const got = fs.statSync(tmp).size;
      if (total && Math.abs(got - total) > 4096) throw new Error('下载不完整 ' + got + '/' + total);
      if (got < 1000000) throw new Error('文件过小（' + got + ' 字节），可能下载出错');
      fs.renameSync(tmp, target);
      if (which === 'text') { try { await syncLabels(); } catch { /* 词表重算失败不阻塞下载 */ } }
      state.downloading = null;
    } catch (e) {
      state.downloading = { error: String(e.message || e) };
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  })();
  return { started: true, kind: which };
}

async function startBatch(opts = {}) {
  if (state.batch && state.batch.running) throw new Error('AI 分类已在进行中');
  ensureSchema();
  if (!modelFile()) throw new Error('模型未安装（先下载模型）');
  await syncLabels(); // 词表若改过，先让生效向量与配置一致再开跑
  if (!labelsInfo()) throw new Error(state.loadErr || '标签缺失');
  const limit = Math.max(0, Number(opts.limit || 0)); // 0 = 全部未分类
  const thumb = opts.thumb;
  const b = state.batch = {
    running: true, stop: false, done: 0, total: 0, ok: 0, fail: 0, low: 0, human: 0,
    perCat: {}, lowList: [], startedAt: Date.now(), finishedAt: 0, error: '', lastError: '', limit,
  };
  (async () => {
    try {
      b.total = Math.min(limit || Infinity, pendingCount());
      let stalled = 0;
      for (;;) {
        if (b.stop) break;
        if (limit && b.done >= limit) break;
        // 候选集只含「还没算过向量」的行；失败行在下面立刻被置成 -2，同时被 ai_conf<>-2 排除。
        // 否则失败行恒满足条件 → 同一批 200 行被反复重选，任务永远跑不完（实测空转 9119 次）
        let rows = db.all(`SELECT id, name, category, ai_conf FROM lib_photos WHERE ai_vec IS NULL AND ai_conf <> -2 ORDER BY id LIMIT 200`);
        if (!rows.length) break;
        if (limit) rows = rows.slice(0, limit - b.done);
        const okBefore = b.ok;
        for (const row of rows) {
          if (b.stop) break;
          try {
            const buf = await thumb(row.id);
            if (!buf) throw new Error('缩略图不可用');
            const r = await classifyJpeg(Buffer.from(buf));
            const vecBuf = vecToBlob(r.vec);
            // 人工标的照片（category 非空且 ai_conf<0）：只补向量，绝不覆盖分类
            if (row.ai_conf < 0 && row.category !== '') {
              db.run(`UPDATE lib_photos SET ai_vec = ? WHERE id = ?`, [vecBuf, row.id]);
              b.human += 1;
            } else {
              db.run(`UPDATE lib_photos SET ai_vec = ?, category = ?, ai_conf = ? WHERE id = ?`,
                [vecBuf, r.cat === '其他' ? '' : r.cat, Number(r.prob.toFixed(4)), row.id]);
              b.perCat[r.cat] = (b.perCat[r.cat] || 0) + 1;
              if (r.prob < LOW_CONF) {
                b.low += 1;
                if (b.lowList.length < 500) b.lowList.push({ id: row.id, name: row.name, cat: r.cat, conf: Number(r.prob.toFixed(3)) });
              }
            }
            b.ok += 1;
          } catch (e) {
            b.fail += 1;
            if (!b.lastError) b.lastError = String((e && e.message) || e); // 首个错误留档：不再静默吞掉（上次就是因此查不出根因）
            try { db.run(`UPDATE lib_photos SET ai_conf = -2 WHERE id = ?`, [row.id]); } catch { /* ignore */ }
          }
          b.done += 1;
          if (b.done % 10 === 0) await new Promise((res) => setImmediate(res));
        }
        // 兜底闸门：整批零成功说明候选行没能移出候选集，两轮即收手，绝不死循环
        if (b.ok === okBefore) {
          stalled += 1;
          if (stalled >= 2) { b.error = '分类无进展，已中止：' + (b.lastError || '未知错误'); break; }
        } else stalled = 0;
      }
    } catch (e) { b.error = String(e.message || e); }
    b.running = false;
    b.finishedAt = Date.now();
    b.secs = Math.round((b.finishedAt - b.startedAt) / 1000);
  })();
  return { started: true };
}

module.exports = {
  info: progress, startBatch, stopBatch, downloadModel,
  classifyJpeg, ensureSchema, modelFile, pendingCount, failedCount, resetFailed,
  vecToBlob, blobToVec, vecStoredCount,
  // 词表可配置 / 按词表重分类
  textModelFile, syncLabels, labelsInSync, labelCfgRead, labelCfgSet, labelCfgReset,
  reclassifyAll, stopReclass, reclassableCount, cfgHash, tokenizer,
  // 自然语言找图
  queryTexts, segmentQuery, encodeQueryVec, searchByText, searchByVec, searchInfo,
};
