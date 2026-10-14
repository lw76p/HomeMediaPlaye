'use strict';
// 外挂字幕工具：文件匹配 + srt/ass → vtt 转换（桌面版 src/main 与 Web 版 lib 同源逻辑）
// 匹配语义对齐 mpv sub-auto=fuzzy：同目录内「视频主名」与「字幕主名」前缀相似即候选，
// 集号冲突（S01E01 vs S01E02）硬排除，中文标记（chs/简/中…）优先排序。

const SUB_EXTS = ['.srt', '.ass', '.ssa', '.vtt', '.sup', '.sub', '.idx'];
// sup/idx/sub 是位图或歧义格式，浏览器 <track> 不支持（mpv 可放，Web 不列候选）
const BROWSER_UNSUPPORTED = ['.sup', '.idx', '.sub'];

const ZH_TOKENS = ['chs', 'cht', 'zh-', 'zh', 'chi', 'cn', 'gb', 'big5', '简', '繁', '中'];

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function isSubtitleFile(name) {
  return SUB_EXTS.includes(extOf(name));
}

// 浏览器（Web 版 <track>）能否消费该字幕格式
function isBrowserSupported(name) {
  return isSubtitleFile(name) && !BROWSER_UNSUPPORTED.includes(extOf(name));
}

// 去掉最后一个扩展名后的主名（Movie.S01E01.chs.srt → Movie.S01E01.chs）
function baseName(name) {
  return String(name || '').replace(/\.[^.]+$/, '');
}

// 集号规范串：s01e02 / e12 / 第02集 → 可比较标识；无集号返回 null
function episodeToken(s) {
  let m = s.match(/s(\d{1,2})e(\d{1,4})/i);
  if (m) return `s${m[1].padStart(2, '0')}e${m[2].padStart(4, '0')}`;
  m = s.match(/(?:^|[.\-_ ])e(\d{1,4})(?:[.\-_ ]|$)/i);
  if (m) return `e${m[1].padStart(4, '0')}`;
  m = s.match(/第\s*(\d{1,4})\s*[集话話]/);
  if (m) return `e${m[1].padStart(4, '0')}`;
  return null;
}

// 视频主名与字幕主名匹配度：100 精确 / 80 前缀+分隔符 / 60 宽松前缀 / -1 不匹配
function matchBase(videoBase, subBase) {
  const v = videoBase.toLowerCase();
  const s = subBase.toLowerCase();
  if (v === s) return 100;
  // 硬排除：两边都带集号且不同（避免 S01E01 匹配到 S01E02 的字幕）
  const ev = episodeToken(v);
  const es = episodeToken(s);
  if (ev && es && ev !== es) return -1;
  // 一方为另一方的前缀，且边界是分隔符（Movie.S01E01 ↔ Movie.S01E01.chs）
  const [sh, lo] = v.length <= s.length ? [v, s] : [s, v];
  if (lo.startsWith(sh) && /[.\-_ ]/.test(lo[sh.length] || '')) return 80;
  // 宽松：公共前缀足够长，剩余部分都是短标签（语言/年份，如 .2020 ↔ .chs）
  let i = 0;
  const minLen = Math.min(v.length, s.length);
  while (i < minLen && v[i] === s[i]) i += 1;
  if (i >= Math.ceil(minLen * 0.7) && i >= 6) {
    const likeTag = (t) => t.length === 0 || (t.length <= 5 && !/\d{2,}/.test(t)) || /^\d{4}$/.test(t);
    if (likeTag(v.slice(i)) && likeTag(s.slice(i))) return 60;
  }
  return -1;
}

function zhBoost(subBase) {
  const s = subBase.toLowerCase();
  // 30 分：确保「前缀+中文标记」（80+30）压过「精确但无标记」（100），
  // 中文环境下 Movie.2020.chs.srt 应优先于 Movie.2020.ass
  return ZH_TOKENS.some((t) => s.includes(t)) ? 30 : 0;
}

// candidates: [{ name, ...extra }]；返回排序后的新数组（附 score），只含匹配项
function matchSubtitles(videoFileName, candidates) {
  const videoBase = baseName(videoFileName);
  const scored = [];
  for (const c of candidates) {
    if (!c || !c.name) continue;
    const score = matchBase(videoBase, baseName(c.name));
    if (score > 0) scored.push({ ...c, score: score + zhBoost(baseName(c.name)) });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh'));
  return scored;
}

// 便捷取最优字幕名；无匹配返回 null
function pickBest(videoFileName, candidateNames) {
  const hit = matchSubtitles(videoFileName, (candidateNames || []).map((name) => ({ name })));
  return hit.length ? hit[0].name : null;
}

/* ---------------- 文本解码与格式转换（Web <track> 需要 vtt；桌面仅供同源） ---------------- */

const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

// GBK 双字节序列很多恰好是合法 UTF-8（utf-8 fatal 不报错），需要 CJK 启发式兜底：
// utf-8 解出但全无 CJK 且出现欧洲/中东区字符时，改用 gb18030 再解一次比对
function decodeBuf(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  let utf8 = null;
  try {
    utf8 = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch { /* 非 UTF-8 */ }
  const tryGbk = () => {
    try { return new TextDecoder('gb18030').decode(buf); } catch { return null; }
  };
  if (utf8 !== null) {
    if (CJK_RE.test(utf8)) return utf8; // 含中日韩文字 → 认定 UTF-8
    if (!/[\u0080-\u04ff\u2000-\u206f]/.test(utf8)) return utf8; // 纯 ASCII → 两种解码等价
    const g = tryGbk();
    if (g && CJK_RE.test(g)) return g; // GBK 误读为 UTF-8 的典型场景
    return utf8;
  }
  // 国内老字幕常见 GBK/GB18030 编码
  return tryGbk() || buf.toString('utf8');
}

// srt → vtt：换头 + 逗号毫秒改点
function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2');
}

// ass 时间 0:00:01.00（厘秒）→ vtt 00:00:01.000
function assTime(t) {
  const m = String(t || '').trim().match(/^(\d+):(\d{1,2}):(\d{1,2})\.(\d{1,3})$/);
  if (!m) return null;
  const pad = (x, n) => String(x).padStart(n, '0');
  return `${pad(Number(m[1]), 2)}:${pad(Number(m[2]), 2)}:${pad(Number(m[3]), 2)}.${pad(Number(m[4].padEnd(3, '0')), 3)}`;
}

// ass/ssa → vtt：抽 Dialogue 行，去 {...} 特效标签，\N 转换行
function assToVtt(ass) {
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  // Format 行以 [Events] 段内的为准（[V4+ Styles] 段也有自己的 Format）
  const evIdx = ass.toLowerCase().indexOf('[events]');
  const scope = evIdx >= 0 ? ass.slice(evIdx) : ass;
  const fmtMatch = scope.match(/^Format:\s*(.+)$/mi);
  if (fmtMatch) {
    const f = fmtMatch[1].split(',').map((x) => x.trim().toLowerCase());
    if (f.includes('start') && f.includes('end') && f.includes('text')) fields = f;
  }
  const startIdx = fields.indexOf('start');
  const endIdx = fields.indexOf('end');
  const textIdx = fields.indexOf('text');
  const cues = [];
  for (const line of ass.split(/\r?\n/)) {
    if (!/^Dialogue:/i.test(line)) continue;
    const parts = line.replace(/^Dialogue:\s*/i, '').split(',');
    if (parts.length < textIdx + 1) continue;
    const start = assTime(parts[startIdx]);
    const end = assTime(parts[endIdx]);
    if (!start || !end) continue;
    // Text 字段本身可含逗号，合并回来
    const text = parts.slice(textIdx).join(',')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N|\\n/g, '\n')
      .replace(/\\h/g, ' ')
      .trim();
    if (!text) continue;
    cues.push({ start, end, text });
  }
  const body = cues
    .map((c, i) => `${i + 1}\n${c.start} --> ${c.end}\n${c.text}`)
    .join('\n\n');
  return cues.length ? `WEBVTT\n\n${body}\n` : null;
}

// 把 vtt 全部时间戳整体前移 offSec 秒（≥0）。
// 转码/remux 流重挂 ?start=N 后 ffmpeg 输出时间戳从 0 重排（video.currentTime 变相对值），
// 字幕轴仍是绝对时间 → 台词整体滞后 N 秒（表现为「选了字幕却没字幕/字幕不对」）。
// 服务端按 offset=N 把轴减 N：内容第 N+0.1 秒的台词落到 ct=0.1 处，与画面重合。
// 已完全越过头部的 cue（end-off<=0）整块丢弃；起点被截断的钳到 0。
function shiftVtt(vtt, offSec) {
  const off = Math.max(0, Number(offSec) || 0);
  if (!off || !vtt) return vtt;
  const toSec = (s) => {
    const m = String(s).match(/(\d{2,}):(\d{2}):(\d{2})\.(\d{3})/);
    return m ? (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000) : null;
  };
  const fmt = (x) => {
    x = Math.max(0, x);
    const pad = (v, n) => String(v).padStart(n, '0');
    return `${pad(Math.floor(x / 3600), 2)}:${pad(Math.floor(x / 60) % 60, 2)}:${pad(Math.floor(x) % 60, 2)}.${pad(Math.round((x - Math.floor(x)) * 1000), 3)}`;
  };
  return vtt.replace(/(\d{2,}:\d{2}:\d{2}\.\d{3}) --> (\d{2,}:\d{2}:\d{2}\.\d{3})/g,
    (whole, a, b) => {
      const st = toSec(a), en = toSec(b);
      if (st == null || en == null) return whole;
      if (en - off <= 0) return '00:00:00.000 --> 00:00:00.000'; // 已播过的台词：零长 cue 浏览器不显示
      return `${fmt(st - off)} --> ${fmt(en - off)}`;
    });
}

// 原始字幕字节 → vtt 文本；浏览器不支持的格式返回 null；offsetSec 为轴平移秒数
function toVtt(buf, fileName, offsetSec) {
  const e = extOf(fileName || '');
  if (!isSubtitleFile(fileName)) return null;
  if (BROWSER_UNSUPPORTED.includes(e)) return null;
  const text = decodeBuf(buf);
  let v = null;
  if (e === '.vtt') v = text.startsWith('WEBVTT') ? text : `WEBVTT\n\n${text}`;
  else if (e === '.srt') v = srtToVtt(text);
  else if (e === '.ass' || e === '.ssa') v = assToVtt(text);
  return v == null ? null : shiftVtt(v, offsetSec);
}

module.exports = {
  SUB_EXTS, BROWSER_UNSUPPORTED,
  extOf, isSubtitleFile, isBrowserSupported, baseName, episodeToken,
  matchBase, matchSubtitles, pickBest,
  decodeBuf, srtToVtt, assToVtt, toVtt, shiftVtt,
};
