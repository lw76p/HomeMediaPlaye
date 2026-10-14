'use strict';
// 扫描让步：每个批次让出事件循环，扫描期间 HTTP/页面不卡
const YIELD = () => new Promise((r) => setImmediate(r));

// 书架（电子书）：TXT/EPUB 扫描入库 + 零依赖解析
// - TXT：BOM/UTF-8/GBK 编码探测，按「第X章/卷/回/序章/楔子…」切章节（存字节偏移，按需解码）
// - EPUB：极简 ZIP 读取（stored/deflate）→ container.xml → OPF spine 顺序抽取正文，封面提取
// - 有声版：由前端 Web Speech Synthesis 朗读章节文本（服务端零依赖、离线可用）
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const db = require('./db');
const paths = require('./paths');

/* ---------------- 目录 ---------------- */
const coverRoot = () => path.join(paths.dirs.cache(), 'ebook-covers');
function ensureDirs() { fs.mkdirSync(coverRoot(), { recursive: true }); }

/* ---------------- 甄选 ---------------- */
// 文本类：txt / epub / fb2 / mobi / azw3 / azw；图像类：cbz（漫画包）；文档：pdf（浏览器内建阅读器整本打开）
// 有声书：书库目录下的音频文件一律作为有声书条目（m4b 是有声书专用格式，其余常见音频兼收）
const TXT_EXTS = new Set(['.txt', '.epub', '.fb2', '.mobi', '.azw3', '.azw']);
const AUDIO_EXTS = new Set(['.m4b', '.m4a', '.mp3', '.flac', '.ogg', '.opus', '.wav']);
const EXT_OK = new Set([...TXT_EXTS, ...AUDIO_EXTS, '.pdf', '.cbz']);
const MIN_SIZE = 2 * 1024; // <2KB 多半是说明/占位文件
const AUDIO_MIN = 512 * 1024; // 音频 <512KB 多半是提示音/音效，不进书架

const NOISE_RE = /(^|[\\/])\.(?!well-known)|^(sample-|preview|thumb|\.)/i;

/* ---------------- 分类（按书名/作者/所在目录特征归类，规则表随用随加） ---------------- */
const CAT_RULES = [
  ['技术', /编程|代码|计算机|程序|算法|数据结构|数据库|操作系统|linux|unix|windows|mac ?os|python|java|javascript|typescript|c\+\+|golang|rust|php|汇编|架构|开发|机器学习|深度学习|人工智能|神经网络|从入门到|实战|教程|手册|指南|黑客|网络安全|运维|嵌入式|单片机|电路|工程/i],
  ['纪实', /历史|史记|传记|纪实|回忆录|自传|人物|政治|经济|金融|投资|社科|哲学|心理|社会|战争|党史|游记|随笔|杂文/i],
  ['小说', /小说|武侠|玄幻|修仙|修真|仙侠|悬疑|推理|科幻|奇幻|言情|都市|穿越|重生|官场|职场|灵异|恐怖|盗墓|青春|校园|文学|名著/i],
];
function categorize(title, author, ext, dirPath) {
  if (AUDIO_EXTS.has(ext)) return '有声书';
  if (ext === '.cbz') return '漫画';
  if (ext === '.pdf') return '文档';
  const hay = `${title || ''} ${author || ''} ${dirPath || ''}`;
  for (const [cat, re] of CAT_RULES) { if (re.test(hay)) return cat; }
  return '其他';
}

/* ---------------- ZIP（EPUB 用）极简读取 ---------------- */
function zipEntries(buf) {
  // 找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count && pos + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const csize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const cmtLen = buf.readUInt16LE(pos + 32);
    const lho = buf.readUInt32LE(pos + 42);
    const rawName = buf.subarray(pos + 46, pos + 46 + nameLen);
    const name = (flags & 0x800)
      ? rawName.toString('utf-8')
      : safeDecodeName(rawName);
    entries.set(name, { method, csize, lho });
    pos += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

function safeDecodeName(b) {
  try {
    // cp437 高位区按 GBK 解，中文压缩包名更友好
    let hasHigh = false;
    for (const x of b) { if (x > 0x7f) { hasHigh = true; break; } }
    return hasHigh ? new TextDecoder('gbk').decode(b) : b.toString('latin1');
  } catch { return b.toString('latin1'); }
}

function zipRead(buf, e) {
  if (!e) return null;
  const off = e.lho;
  if (buf.readUInt32LE(off) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.csize);
  try {
    if (e.method === 0) return Buffer.from(data);
    if (e.method === 8) return zlib.inflateRawSync(data);
  } catch { return null; }
  return null;
}

/* ---------------- XML 文本工具 ---------------- */
function xmlText(s, tag) {
  const m = s.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
  return m ? m[1].trim() : '';
}
function xmlAttr(s, tag, attr) {
  const m = s.match(new RegExp('<' + tag + '[^>]*\\b' + attr + '\\s*=\\s*"([^"]*)"', 'i'))
    || s.match(new RegExp('<' + tag + '[^>]*\\b' + attr + "\\s*=\\s*'([^']*)'", 'i'));
  return m ? m[1] : '';
}
const decodeEntities = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#x?([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&amp;/g, '&');

/* ---------------- EPUB 解析 ---------------- */
function parseEpub(abs) {
  const buf = fs.readFileSync(abs);
  const zip = zipEntries(buf);
  if (!zip) return null;
  const container = zipRead(buf, zip.get('META-INF/container.xml'));
  if (!container) return null;
  const cstr = container.toString('utf-8');
  // <rootfile/> 通常是自闭合标签，直接按属性取 full-path
  const opfPath = (cstr.match(/full-path\s*=\s*"([^"]*)"/i) || [])[1];
  if (!opfPath || !zip.get(opfPath)) return null;
  const opf = zipRead(buf, zip.get(opfPath)).toString('utf-8');
  const baseDir = path.posix.dirname(opfPath);

  const meta = {};
  const title = xmlText(opf, 'dc:title');
  if (title) meta.title = decodeEntities(title);
  const creator = xmlText(opf, 'dc:creator');
  if (creator) meta.author = decodeEntities(creator);

  // manifest
  const items = new Map(); // id -> href
  const re = /<item\b[^>]*>/gi;
  let im;
  while ((im = re.exec(opf))) {
    const id = (im[0].match(/id\s*=\s*"([^"]*)"/i) || [])[1];
    const href = (im[0].match(/href\s*=\s*"([^"]*)"/i) || [])[1];
    const props = (im[0].match(/properties\s*=\s*"([^"]*)"/i) || [])[1] || '';
    if (id && href) items.set(id, { href, props });
  }
  // spine 顺序
  const spineHtml = xmlText(opf, 'spine');
  const order = [];
  const sr = /itemref\b[^>]*idref\s*=\s*"([^"]*)"/gi;
  let sm;
  while ((sm = sr.exec(spineHtml))) order.push(sm[1]);

  // 封面
  let coverItem = null;
  for (const [, it] of items) { if (it.props.includes('cover-image')) { coverItem = it; break; } }
  if (!coverItem) {
    const cm = opf.match(/<meta\b[^>]*name\s*=\s*"cover"[^>]*content\s*=\s*"([^"]*)"/i);
    if (cm && items.get(cm[1])) coverItem = items.get(cm[1]);
  }
  let cover = null;
  if (coverItem) {
    const p = path.posix.normalize(path.posix.join(baseDir, decodeURIComponent(coverItem.href)));
    const data = zipRead(buf, zip.get(p));
    if (data && data.length > 200) {
      const kind = data[0] === 0x89 ? 'png' : (data[0] === 0xff && data[1] === 0xd8) ? 'jpg' : null;
      if (kind) cover = { mime: 'image/' + (kind === 'png' ? 'png' : 'jpeg'), data };
    }
  }

  // 正文按 spine 顺序抽文本
  const chapters = [];
  for (const idref of order) {
    const it = items.get(idref);
    if (!it) continue;
    if (/\.(x?html?|htm)$/i.test(it.href) === false) continue;
    const p = path.posix.normalize(path.posix.join(baseDir, decodeURIComponent(it.href)));
    const doc = zipRead(buf, zip.get(p));
    if (!doc) continue;
    let html = doc.toString('utf-8');
    const tMatch = html.match(/<(h[1-3]|title)[^>]*>([\s\S]*?)<\/\1>/i);
    let chapTitle = tMatch ? decodeEntities(tMatch[2].replace(/<[^>]*>/g, '').trim()).slice(0, 80) : '';
    const bodyM = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyM) html = bodyM[1];
    let text = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
      .replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ');
    text = decodeEntities(text).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 10) continue; // 目录页/空白页跳过
    // 章节标题是文件名式拼音/英文（TXT 转制 EPUB 常见，如 dao_mu_bi_ji_…）→ 用正文首行代替
    if (/^[\w\- .]{4,80}$/.test(chapTitle)) {
      const first = text.split('\n').map((x) => x.trim()).find((x) => x.length >= 4 && /[\u4e00-\u9fff]/.test(x)) || '';
      if (first) chapTitle = first.slice(0, 60);
    }
    chapters.push({ title: chapTitle || '', text });
  }
  if (!chapters.length) return null;
  return { meta, chapters, cover };
}

/* ---------------- TXT 解析 ---------------- */
// 章节标记两档：严格档（行首即「第X章/序章…」，绝大多数正规 TXT）→ 宽松档（行首允许 ≤12 字书名前缀，
// 如「盗墓笔记8第1章」；要求整行无句读且短，避免把正文句子误判成章节）
const CHAP_CORE = '第\\s*[0-9零一二三四五六七八九十百千万两]+\\s*[章节卷回部集]';
const CHAP_STRICT = new RegExp('^[\\s\\uFEFF]*(?:' + CHAP_CORE + '|Chapter\\s+\\d+|CHAPTER\\s+\\d+|序章|序言|序|楔子|前言|引子|后记|尾声|终章|番外[\\s\\S]{0,20})[\\s\\S]{0,60}$');
const CHAP_LOOSE = new RegExp('^[^，。？！；：、“”‘’（）《》]{0,12}' + CHAP_CORE + '[^，。？！；：、“”‘’（）《》]{0,16}$');
const CHAP_CORE_RE = new RegExp(CHAP_CORE);

function cleanFileName(name) {
  return String(name || '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/* BOM / UTF-8 / UTF-16 / GBK 编码探测（沿用旧版行为） */
function detectText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { dec: new TextDecoder('utf-8'), skip: 3 };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { dec: new TextDecoder('utf-16le'), skip: 2 };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { dec: new TextDecoder('utf-16be'), skip: 2 };
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { dec: new TextDecoder('utf-8'), skip: 0 };
  } catch { return { dec: new TextDecoder('gbk'), skip: 0 }; }
}

function txtFindMarks(full) {
  const lines = full.split('\n');
  const scan = (re) => {
    const marks = [];
    let charOff = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (re.test(line.trim())) marks.push({ line: i, title: line.trim().slice(0, 80), charStart: charOff });
      charOff += line.length + 1;
    }
    return marks;
  };
  // 两档都扫、取命中更多的一档：正文里偶有「第二章的内容开始。」这类以章号开头的叙述行，
  // 严格档会零星误命中；带书名前缀的真章节行（盗墓笔记8第1章）只有宽松档能整批抓住
  const strict = scan(CHAP_STRICT);
  const loose = scan(CHAP_LOOSE);
  return loose.length > strict.length ? loose : strict;
  return marks;
}

/* TXT 书名推断：章节公共前缀（盗墓笔记8第1章…→盗墓笔记8）→ 正文《书名》→ 清洗后的文件名 */
function inferTxtTitle(full, marks, fileName) {
  if (marks.length >= 5 && CHAP_CORE_RE.test(marks[0].title)) {
    const pre = marks[0].title.replace(CHAP_CORE_RE, '').trim();
    if (pre.length >= 2 && pre.length <= 16 && marks.every((m) => m.title.startsWith(pre))) return pre;
  }
  const bm = full.slice(0, 2000).match(/《([^》]{1,40})》/);
  if (bm) return bm[1];
  return cleanFileName(fileName);
}

function parseTxt(abs) {
  const buf = fs.readFileSync(abs);
  // 文本嗅探：二进制比例高的拒收
  let bin = 0;
  const checkN = Math.min(buf.length, 8192);
  for (let i = 0; i < checkN; i++) { const b = buf[i]; if (b === 0 || (b < 9) || (b > 13 && b < 32)) bin++; }
  if (bin / checkN > 0.05) return null;
  const { dec, skip } = detectText(buf);
  const full = dec.decode(buf.subarray(skip));
  const marks = txtFindMarks(full);
  const fname = path.basename(abs, path.extname(abs));
  if (!marks.length) {
    // 无章节标记：整本一章（长文再按 12000 字切成卷）
    if (full.trim().length < 100) return null;
    const parts = [];
    for (let s = 0; s < full.length; s += 12000) {
      const seg = full.slice(s, s + 12000);
      parts.push({ title: parts.length ? `（续 ${parts.length + 1}）` : '', text: seg });
    }
    return { meta: { title: inferTxtTitle(full, marks, fname) }, chapters: parts, cover: null };
  }
  const chapters = marks.map((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].charStart : full.length;
    return { title: m.title, text: full.slice(m.charStart, end).trim() };
  });
  return { meta: { title: inferTxtTitle(full, marks, fname) }, chapters, cover: null };
}

/* ---------------- FB2 解析（单文件 XML） ---------------- */
function parseFb2(abs) {
  const buf = fs.readFileSync(abs);
  const xml = (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) ? buf.subarray(3).toString('utf-8') : buf.toString('utf-8');
  const meta = {};
  const ti = xml.match(/<title-info>[\s\S]*?<\/title-info>/i);
  if (ti) {
    const bt = xmlText(ti[0], 'book-title');
    if (bt) meta.title = decodeEntities(bt);
    const au = [decodeEntities(xmlText(ti[0], 'first-name')), decodeEntities(xmlText(ti[0], 'last-name'))].filter(Boolean).join(' ');
    if (au) meta.author = au;
  }
  let cover = null;
  const cp = xml.match(/<coverpage>[\s\S]*?<\/coverpage>/i);
  if (cp) {
    const hrefM = cp[0].match(/#([^\s"'>]+)/i);
    if (hrefM) {
      const bin = xml.match(new RegExp('<binary[^>]*id\\s*=\\s*"' + hrefM[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>([\\s\\S]*?)</binary>', 'i'));
      if (bin) {
        const data = Buffer.from(bin[1].replace(/\s+/g, ''), 'base64');
        const kind = data[0] === 0x89 ? 'png' : (data[0] === 0xff && data[1] === 0xd8) ? 'jpg' : null;
        if (kind) cover = { mime: 'image/' + (kind === 'png' ? 'png' : 'jpeg'), data };
      }
    }
  }
  const bodyM = xml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyM ? bodyM[1] : xml;
  const chapters = [];
  const secRe = /<section[^>]*>([\s\S]*?)<\/section>/gi;
  let sm, found = false;
  while ((sm = secRe.exec(body))) {
    const sec = sm[1];
    const tM = sec.match(/<title>([\s\S]*?)<\/title>/i);
    const title = tM ? decodeEntities(tM[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 80) : '';
    let text = sec.replace(/<title>[\s\S]*?<\/title>/i, '').replace(/<\/(p|div|h[1-6]|v)>/gi, '\n').replace(/<[^>]*>/g, '');
    text = decodeEntities(text).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 10) continue;
    found = true;
    chapters.push({ title, text });
  }
  if (!found) {
    let text = decodeEntities(body.replace(/<[^>]*>/g, '')).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 100) return null;
    chapters.push({ title: '', text });
  }
  return { meta, chapters, cover };
}

/* ---------------- MOBI / AZW3（KF8）解析：PalmDOC 解压 + EXTH 元数据，尽力而为 ---------------- */
function palmRecords(buf) {
  if (buf.length < 78 || buf.toString('latin1', 60, 64) !== 'BOOK') return null;
  const num = buf.readUInt16BE(76);
  const recs = [];
  for (let i = 0; i < num; i++) {
    const off = 78 + i * 8;
    if (off + 8 > buf.length) break;
    recs.push(buf.readUInt32BE(off));
  }
  return recs;
}

function palmdocDecompress(data) {
  const out = [];
  for (let i = 0; i < data.length;) {
    const b = data[i++];
    if (b === 0) { out.push(0); continue; }
    if (b <= 8) { for (let j = 0; j < b && i < data.length; j++) out.push(data[i++]); continue; }
    if (b <= 0x7f) { out.push(b); continue; }
    if (b <= 0xbf) {
      if (i >= data.length) break;
      const b2 = data[i++];
      const dist = (((b << 8) | b2) >> 3) & 0x7ff;
      const len = (b2 & 0x7) + 3;
      const start = out.length - dist;
      if (start < 0) return null;
      for (let j = 0; j < len; j++) out.push(out[start + j]);
      continue;
    }
    out.push(32); out.push(b ^ 0x80);
  }
  return Buffer.from(out);
}

function mobiTrimTrailing(data, flags) {
  if (!flags) return data;
  for (let bit = 15; bit >= 1; bit--) {
    if (!((flags >> bit) & 1)) continue;
    let v = 0, off = data.length;
    for (let k = 0; k < 4 && off > 0; k++) {
      const b = data[--off];
      v = (v << 7) | (b & 0x7f);
      if (b & 0x80) break;
    }
    if (v <= 0 || v >= data.length) return null;
    data = data.subarray(0, data.length - v);
  }
  if (flags & 1) {
    if (data.length < 2) return null;
    const n = data[data.length - 1] & 0x3;
    if (1 + n >= data.length) return null;
    data = data.subarray(0, data.length - 1 - n);
  }
  return data;
}

function htmlToChapters(html) {
  const chunks = String(html).split(/<mbp:pagebreak[^>]*>/i);
  const chapters = [];
  for (const ck of chunks) {
    const tM = ck.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    const title = tM ? decodeEntities(tM[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 80) : '';
    let text = ck.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li)>/gi, '\n').replace(/<[^>]*>/g, '');
    text = decodeEntities(text).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 10) continue;
    chapters.push({ title, text });
  }
  if (chapters.length === 1 && chapters[0].text.length > 12000) {
    const segs = [];
    for (let s = 0; s < chapters[0].text.length; s += 12000) {
      segs.push({ title: segs.length ? `（续 ${segs.length + 1}）` : chapters[0].title, text: chapters[0].text.slice(s, s + 12000) });
    }
    return segs;
  }
  return chapters;
}

function parseMobi(abs) {
  const buf = fs.readFileSync(abs);
  const recs = palmRecords(buf);
  if (!recs || recs.length < 2) return null;
  const r0 = buf.subarray(recs[0], recs[1]);
  if (r0.length < 232 || r0.toString('latin1', 16, 20) !== 'MOBI') return null;
  const compression = r0.readUInt16BE(0);
  if (compression !== 1 && compression !== 2) return null; // HUFF/CDIC 等不支持
  const textCount = r0.readUInt16BE(8);
  if (r0.readUInt16BE(12) !== 0) return null; // 加密书拒收
  const headerLen = r0.readUInt32BE(20);
  const encoding = r0.readUInt32BE(28);
  const extraFlags = headerLen >= 0xe4 ? r0.readUInt16BE(0xf2) : 0;
  const firstImage = r0.readUInt32BE(108);
  const meta = {};
  let coverIdx = -1;
  if (r0.readUInt32BE(0x80) & 0x40) { // EXTH 存在
    const exthOff = 16 + headerLen;
    if (exthOff + 12 <= r0.length && r0.toString('latin1', exthOff, exthOff + 4) === 'EXTH') {
      const exthLen = r0.readUInt32BE(exthOff + 4);
      const recCount = r0.readUInt32BE(exthOff + 8);
      let p = exthOff + 12;
      const end = Math.min(exthOff + exthLen, r0.length);
      for (let i = 0; i < recCount && p + 8 <= end; i++) {
        const type = r0.readUInt32BE(p);
        const len = r0.readUInt32BE(p + 4);
        if (len < 8 || p + len > end) break;
        const dec = (enc) => { try { return r0.toString(enc === 65001 ? 'utf-8' : 'latin1', p + 8, p + len).trim(); } catch { return ''; } };
        if (type === 100 && !meta.author) meta.author = dec(encoding);
        else if (type === 503 && !meta.title) meta.title = dec(encoding);
        else if (type === 201) coverIdx = r0.readUInt32BE(p + 8);
        p += len;
      }
    }
  }
  const parts = [];
  for (let i = 1; i <= textCount && i + 1 < recs.length; i++) {
    let seg = buf.subarray(recs[i], recs[i + 1]);
    seg = mobiTrimTrailing(seg, extraFlags);
    if (!seg) return null;
    if (compression === 2) {
      const d = palmdocDecompress(seg);
      if (!d) return null;
      parts.push(d);
    } else parts.push(Buffer.from(seg));
  }
  const raw = Buffer.concat(parts);
  let html;
  if (encoding === 65001) html = raw.toString('utf-8');
  else { try { html = new TextDecoder('gbk').decode(raw); } catch { html = raw.toString('latin1'); } }
  const chapters = htmlToChapters(html);
  if (!chapters.length) return null;
  if (!meta.title) meta.title = cleanFileName(path.basename(abs, path.extname(abs)));
  if (meta.author) meta.author = String(meta.author).replace(/^unknown$/i, '');
  let cover = null;
  if (coverIdx >= 0 && firstImage > 0 && firstImage + coverIdx < recs.length) {
    const start = recs[firstImage + coverIdx];
    const data = buf.subarray(start, (firstImage + coverIdx + 1 < recs.length) ? recs[firstImage + coverIdx + 1] : buf.length);
    const kind = data[0] === 0x89 ? 'png' : (data[0] === 0xff && data[1] === 0xd8) ? 'jpg' : null;
    if (kind) cover = { mime: 'image/' + (kind === 'png' ? 'png' : 'jpeg'), data };
  }
  return { meta, chapters, cover };
}

/* ---------------- CBZ（漫画包）：每张图一页 ---------------- */
function cbzImageNames(zip) {
  return [...zip.keys()]
    .filter((n) => /\.(jpe?g|png|gif|webp|bmp)$/i.test(n) && !/(^|[\\/])(__MACOSX|\.)/i.test(n))
    .sort(new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare);
}

function parseCbz(abs) {
  const buf = fs.readFileSync(abs);
  const zip = zipEntries(buf);
  if (!zip) return null;
  const imgs = cbzImageNames(zip);
  if (!imgs.length) return null;
  let cover = null;
  const first = zipRead(buf, zip.get(imgs[0]));
  if (first && first.length > 200) {
    const kind = first[0] === 0x89 ? 'png' : (first[0] === 0xff && first[1] === 0xd8) ? 'jpg' : null;
    if (kind) cover = { mime: 'image/' + (kind === 'png' ? 'png' : 'jpeg'), data: first };
  }
  const chapters = imgs.map((n, i) => ({ title: `第 ${i + 1} 页`, text: '' }));
  return { meta: { title: cleanFileName(path.basename(abs, path.extname(abs))), category: '漫画' }, chapters, cover };
}

/* ---------------- PDF：不抽正文（中文 CID 字体零依赖解不动），交给浏览器内建阅读器整本打开 ---------------- */
function parsePdfDoc(abs) {
  return {
    meta: { title: cleanFileName(path.basename(abs, path.extname(abs))), category: '文档' },
    chapters: [{ title: '全文', text: '' }],
    cover: null,
  };
}

/* ---------------- 有声书音频：整文件一条目，进度按播放比例 ---------------- */
function parseAudio(abs, fileName) {
  return {
    meta: { title: cleanFileName(path.basename(fileName || abs, path.extname(fileName || abs))), category: '有声书' },
    chapters: [{ title: '有声书', text: '' }],
    cover: null,
  };
}

/* ---------------- 封面落盘 ---------------- */
function saveCover(bookPath, cover) {
  if (!cover || !cover.data || cover.data.length < 200) return null;
  const sniff = cover.data[0] === 0x89 ? 'png' : (cover.data[0] === 0xff && cover.data[1] === 0xd8) ? 'jpg' : null;
  if (!sniff) return null;
  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha1').update(bookPath).digest('hex').slice(0, 16);
  const file = path.join(coverRoot(), hash + '.' + sniff);
  try { fs.writeFileSync(file, cover.data); return file; } catch { return null; }
}

function findDirCover(dir) {
  for (const n of ['cover.jpg', 'folder.jpg', 'cover.png', 'front.jpg']) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/* ---------------- SQLite ---------------- */
function init() {
  ensureDirs();
  db.run(`CREATE TABLE IF NOT EXISTS ebook_roots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_scan_at INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS ebooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id INTEGER NOT NULL,
    path TEXT NOT NULL UNIQUE,
    dir TEXT NOT NULL,
    file_name TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    mtime INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL DEFAULT 'txt',
    cover_file TEXT DEFAULT '',
    cover_dir TEXT DEFAULT '',
    last_seen_at INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ebook_root ON ebooks(root_id)`);
  try { db.run(`ALTER TABLE ebooks ADD COLUMN category TEXT NOT NULL DEFAULT ''`); } catch { /* 已有列 */ }
  db.run(`CREATE TABLE IF NOT EXISTS ebook_chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    text TEXT,
    UNIQUE(book_id, idx)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS book_progress (
    book_id INTEGER PRIMARY KEY,
    chapter_idx INTEGER NOT NULL DEFAULT 0,
    pos REAL NOT NULL DEFAULT 0,
    updated_at INTEGER
  )`);
}

/* ---------------- 扫描 ---------------- */
async function scanAll({ onEvent = () => {} } = {}) {
  const roots = db.all(`SELECT * FROM ebook_roots WHERE enabled = 1`);
  let added = 0, removed = 0, skipped = 0, updated = 0;
  const seen = new Set();
  for (const root of roots) {
    if (!fs.existsSync(root.path)) continue;
    onEvent(`扫描书架目录：${root.path}`);
    const stack = [root.path];
    while (stack.length) {
      await YIELD();
      const dir = stack.pop();
      let items;
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const it of items) {
        if (it.name.startsWith('.') || NOISE_RE.test(it.name)) continue;
        const full = path.join(dir, it.name);
        if (it.isDirectory()) {
          if (it.name === '@eaDir' || it.name === '#recycle' || it.name === '$RECYCLE.BIN') continue;
          stack.push(full);
          continue;
        }
        const ext = path.extname(it.name).toLowerCase();
        if (!EXT_OK.has(ext)) continue;
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.size < (AUDIO_EXTS.has(ext) ? AUDIO_MIN : MIN_SIZE)) { skipped++; continue; }
        seen.add(full);
        const exist = db.get(`SELECT id, mtime, size FROM ebooks WHERE path = ?`, [full]);
        if (exist && exist.mtime === st.mtimeMs && exist.size === st.size) continue;
        await YIELD(); // 解析重型文件前让步
        // 解析（epub/mobi 全量读；txt 全量读后存偏移/文本；pdf/音频不抽正文）
        let parsed;
        try {
          if (ext === '.epub') parsed = parseEpub(full);
          else if (ext === '.fb2') parsed = parseFb2(full);
          else if (ext === '.mobi' || ext === '.azw3' || ext === '.azw') parsed = parseMobi(full);
          else if (ext === '.cbz') parsed = parseCbz(full);
          else if (ext === '.pdf') parsed = parsePdfDoc(full);
          else if (AUDIO_EXTS.has(ext)) parsed = parseAudio(full, it.name);
          else parsed = parseTxt(full);
        } catch { parsed = null; }
        if (!parsed) { skipped++; onEvent(`[甄选拒收] 内容与电子书格式不符：${it.name}`); continue; }
        const cover_file = saveCover(full, parsed.cover) || (exist && db.get(`SELECT cover_file FROM ebooks WHERE id=?`, [exist.id]).cover_file) || '';
        const rec = {
          title: parsed.meta.title || path.basename(it.name, ext),
          author: String(parsed.meta.author || '').trim().replace(/^unknown$/i, ''),
          format: ext.slice(1),
          cover_file, cover_dir: cover_file ? '' : (findDirCover(dir) || ''),
          category: parsed.meta.category || categorize(parsed.meta.title || it.name, parsed.meta.author, ext, dir),
        };
        let bookId;
        if (exist) {
          bookId = exist.id;
          db.run(`UPDATE ebooks SET size=?, mtime=?, title=?, author=?, format=?, cover_file=?, cover_dir=?, category=? WHERE id=?`,
            [st.size, st.mtimeMs, rec.title, rec.author, rec.format, rec.cover_file, rec.cover_dir, rec.category, exist.id]);
          db.run(`DELETE FROM ebook_chapters WHERE book_id = ?`, [exist.id]); // 重新灌章节
          updated++;
        } else {
          bookId = db.run(`INSERT INTO ebooks (root_id, path, dir, file_name, ext, size, mtime, title, author, format, cover_file, cover_dir, category, last_seen_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [root.id, full, dir, it.name, ext, st.size, st.mtimeMs, rec.title, rec.author, rec.format, rec.cover_file, rec.cover_dir, rec.category, Date.now()]).lastInsertRowid;
          added++;
          if (added % 10 === 0) onEvent(`已入库 ${added} 本…`);
        }
        // 章节入库（一次性事务式插入）
        const ins = `INSERT OR IGNORE INTO ebook_chapters (book_id, idx, title, text) VALUES (?,?,?,?)`;
        for (let i = 0; i < parsed.chapters.length; i++) {
          const c = parsed.chapters[i];
          db.run(ins, [bookId, i, c.title || `第${i + 1}章`, c.text]);
        }
      }
    }
    db.run(`UPDATE ebook_roots SET last_scan_at = ? WHERE id = ?`, [Date.now(), root.id]);
  }
  for (const b of db.all(`SELECT id, path FROM ebooks`)) {
    if (!seen.has(b.path) && !fs.existsSync(b.path)) {
      db.run(`DELETE FROM ebook_chapters WHERE book_id = ?`, [b.id]);
      db.run(`DELETE FROM book_progress WHERE book_id = ?`, [b.id]);
      db.run(`DELETE FROM ebooks WHERE id = ?`, [b.id]);
      removed++;
    }
  }
  return { added, updated, removed, skipped, total: db.get(`SELECT COUNT(*) c FROM ebooks`).c };
}

/* ---------------- 查询 ---------------- */
const bookOut = (b) => ({
  id: b.id, root_id: b.root_id, title: b.title, author: b.author, format: b.format, category: b.category || '',
  size: b.size, cover: (b.cover_file || b.cover_dir) ? 1 : 0,
  maxCh: (b.max_ch != null ? b.max_ch + 1 : 0), // 章节总数（idx 从 0 起）
});

function listBooks() {
  return db.all(`SELECT b.*, (SELECT MAX(idx) FROM ebook_chapters c WHERE c.book_id = b.id) max_ch
                 FROM ebooks b ORDER BY b.title COLLATE NOCASE`).map(bookOut);
}

function toc(bookId) {
  const b = db.get(`SELECT * FROM ebooks WHERE id = ?`, [bookId]);
  if (!b) return null;
  const chapters = db.all(`SELECT idx, title FROM ebook_chapters WHERE book_id = ? ORDER BY idx`, [bookId]);
  return { book: bookOut(b), chapters };
}

function chapterText(bookId, idx) {
  const c = db.get(`SELECT title, text FROM ebook_chapters WHERE book_id = ? AND idx = ?`, [bookId, idx]);
  return c || null;
}

function getProgress(bookId) {
  const p = db.get(`SELECT * FROM book_progress WHERE book_id = ?`, [bookId]);
  return p ? { chapterIdx: p.chapter_idx, pos: p.pos, updatedAt: p.updated_at } : null;
}
function allProgress() {
  return db.all(`SELECT * FROM book_progress ORDER BY updated_at DESC`).map((p) => ({
    bookId: p.book_id, chapterIdx: p.chapter_idx, pos: p.pos, updatedAt: p.updated_at,
  }));
}
function saveProgress(bookId, chapterIdx, pos) {
  db.run(`INSERT INTO book_progress (book_id, chapter_idx, pos, updated_at) VALUES (?,?,?,?)
          ON CONFLICT(book_id) DO UPDATE SET chapter_idx=?, pos=?, updated_at=?`,
    [bookId, chapterIdx, pos, Date.now(), chapterIdx, pos, Date.now()]);
}

/* ---------------- 目录管理 ---------------- */
function listRoots() {
  return db.all(`SELECT r.*, (SELECT COUNT(*) FROM ebooks WHERE root_id = r.id) books FROM ebook_roots r ORDER BY id`).map((r) => ({
    id: r.id, path: r.path, label: r.label, books: r.books, lastScanAt: r.last_scan_at,
  }));
}
function addRoot(p, label) {
  p = String(p || '').trim();
  if (!p) throw new Error('目录不能为空');
  if (!fs.existsSync(p)) throw new Error('目录不存在：' + p);
  const st = fs.statSync(p);
  if (!st.isDirectory()) throw new Error('不是目录：' + p);
  db.run(`INSERT OR IGNORE INTO ebook_roots (path, label) VALUES (?, ?)`, [p, label || path.basename(p)]);
  db.run(`UPDATE ebook_roots SET label = ? WHERE path = ?`, [label || path.basename(p), p]);
  return db.get(`SELECT id FROM ebook_roots WHERE path = ?`, [p]).id;
}
function removeRoot(id) {
  for (const b of db.all(`SELECT id FROM ebooks WHERE root_id = ?`, [id])) {
    db.run(`DELETE FROM ebook_chapters WHERE book_id = ?`, [b.id]);
    db.run(`DELETE FROM book_progress WHERE book_id = ?`, [b.id]);
  }
  db.run(`DELETE FROM ebooks WHERE root_id = ?`, [id]);
  db.run(`DELETE FROM ebook_roots WHERE id = ?`, [id]);
}

function coverAbs(id) {
  const b = db.get(`SELECT cover_file, cover_dir FROM ebooks WHERE id = ?`, [id]);
  if (!b) return null;
  return b.cover_file || b.cover_dir || null;
}

/* ---------------- 重新识别（重读书名/作者/封面，元数据有变时重灌章节） ---------------- */
async function reidentifyAll({ onEvent = () => {} } = {}) {
  const rows = db.all(`SELECT * FROM ebooks`);
  let updated = 0, missing = 0, done = 0;
  for (const b of rows) {
    if (!fs.existsSync(b.path)) { missing++; continue; }
    let st; try { st = fs.statSync(b.path); } catch { missing++; continue; }
    await YIELD(); // 解析重型文件前让步
    const ext = path.extname(b.path).toLowerCase();
    let parsed;
    try {
      if (ext === '.epub') parsed = parseEpub(b.path);
      else if (ext === '.fb2') parsed = parseFb2(b.path);
      else if (ext === '.mobi' || ext === '.azw3' || ext === '.azw') parsed = parseMobi(b.path);
      else if (ext === '.cbz') parsed = parseCbz(b.path);
      else if (ext === '.pdf') parsed = parsePdfDoc(b.path);
      else if (AUDIO_EXTS.has(ext)) parsed = parseAudio(b.path, b.file_name);
      else parsed = parseTxt(b.path);
    } catch { parsed = null; }
    if (!parsed) { missing++; continue; }
    const cover_file = saveCover(b.path, parsed.cover) || b.cover_file || '';
    const rec = {
      title: parsed.meta.title || path.basename(b.file_name, ext),
      author: String(parsed.meta.author || '').trim().replace(/^unknown$/i, ''),
      cover_dir: cover_file ? '' : (findDirCover(path.dirname(b.path)) || ''),
      category: parsed.meta.category || categorize(parsed.meta.title || b.file_name, parsed.meta.author, ext, b.dir),
    };
    if (rec.title !== b.title || rec.author !== (b.author || '') || cover_file !== (b.cover_file || '') || rec.category !== (b.category || '')) {
      db.run(`UPDATE ebooks SET title=?, author=?, cover_file=?, cover_dir=?, category=?, size=?, mtime=? WHERE id=?`,
        [rec.title, rec.author, cover_file, rec.cover_dir, rec.category, st.size, st.mtimeMs, b.id]);
      db.run(`DELETE FROM ebook_chapters WHERE book_id = ?`, [b.id]); // 元数据变了，章节按新内容重灌
      const ins = `INSERT OR IGNORE INTO ebook_chapters (book_id, idx, title, text) VALUES (?,?,?,?)`;
      for (let i = 0; i < parsed.chapters.length; i++) {
        const c = parsed.chapters[i];
        db.run(ins, [b.id, i, c.title || `第${i + 1}章`, c.text]);
      }
      updated++;
    }
    if (++done % 10 === 0) { onEvent(`已重识别 ${done}/${rows.length} 本…`); await YIELD(); }
  }
  return { total: rows.length, updated, missing };
}

/* ---------------- 原始文件（PDF/有声书）与漫画页 ---------------- */
const FILE_MIME = {
  '.pdf': 'application/pdf', '.m4b': 'audio/mp4', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav',
  '.epub': 'application/epub+zip', '.txt': 'text/plain; charset=utf-8',
};

function fileAbs(id) {
  const b = db.get(`SELECT path, ext FROM ebooks WHERE id = ?`, [id]);
  if (!b || !fs.existsSync(b.path)) return null;
  return { abs: b.path, mime: FILE_MIME[b.ext] || 'application/octet-stream' };
}

function pageImage(id, idx) { // CBZ：第 idx 张图（0 起，按自然数字排序）
  const b = db.get(`SELECT path, ext FROM ebooks WHERE id = ?`, [id]);
  if (!b || b.ext !== '.cbz' || !fs.existsSync(b.path)) return null;
  const buf = fs.readFileSync(b.path);
  const zip = zipEntries(buf);
  if (!zip) return null;
  const imgs = cbzImageNames(zip);
  const name = imgs[idx];
  if (!name) return null;
  const data = zipRead(buf, zip.get(name));
  if (!data) return null;
  const lower = name.toLowerCase();
  const mime = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.gif') ? 'image/gif'
    : lower.endsWith('.webp') ? 'image/webp' : lower.endsWith('.bmp') ? 'image/bmp' : 'image/jpeg';
  return { data, mime };
}

module.exports = {
  init, scanAll, listBooks, toc, chapterText, reidentifyAll,
  getProgress, allProgress, saveProgress,
  listRoots, addRoot, removeRoot, coverAbs,
  fileAbs, pageImage,
  EXT_OK, AUDIO_EXTS,
};
