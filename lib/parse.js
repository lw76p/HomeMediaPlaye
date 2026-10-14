'use strict';
// 文件名解析与分类：对应 SRS F-LIB-003 / F-LIB-004 / F-LIB-005

const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.rmvb', '.rm', '.ts', '.m2ts',
  '.webm', '.mpg', '.mpeg', '.m4v', '.3gp', '.vob', '.mts', '.asf', '.divx',
  '.f4v', '.ogv', '.mxf', '.wtv', '.dat',
]);

const AUDIO_EXTS = new Set([
  '.mp3', '.aac', '.flac', '.ape', '.wav', '.ogg', '.m4a', '.wma', '.dts',
  '.ac3', '.opus', '.aiff', '.alac', '.wv', '.tak',
]);

const SUBTITLE_EXTS = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx', '.sup']);

const IGNORE_DIRS = new Set([
  '$recycle.bin', 'system volume information', 'node_modules', '.git', '.svn',
  '@eadir', '.ds_store', 'lost+found', '#recycle', 'recycler', 'windows',
  'program files', 'program files (x86)', 'appdata', 'temp', 'tmp',
  // QNAP 回收站 / 快照目录 + Plex 缩略图缓存（扫描时整目录跳过，避免删掉的文件又出现在库里）
  '@recycle', '@recently-snapshot', '.@__thumb', '@recycle_bin',
]);

// 发布组/画质/编码等噪声token，用于清洗片名
const NOISE_TOKENS = [
  'bluray', 'blu-ray', 'bdrip', 'brrip', 'bdrip', 'webrip', 'web-dl', 'webdl',
  'web', 'hdtv', 'dvdrip', 'dvd', 'hdrip', 'remux', 'uhd', 'hdr', 'hdr10',
  'dolby', 'vision', 'dv', 'sdr', '10bit', '8bit', 'hi10p', 'x264', 'x265',
  'h264', 'h265', 'hevc', 'avc', 'av1', 'xvid', 'divx', 'aac', 'ac3', 'dts',
  'dtshd', 'truehd', 'atmos', 'flac', 'mp3', 'eac3', 'ddp', 'dd5', 'dd7',
  '5 1', '7 1', '2 0', 'ch', 'ma', 'hd', 'sd', 'fhd', 'qhd', 'uhd',
  '1080p', '720p', '2160p', '480p', '360p', '4k', '8k', '2k',
  'hq', 'hdrip', 'rip', 'repack', 'proper', 'internal', 'limited',
  'complete', 'remastered', 'extended', 'uncut', 'imax', 'directors', 'cut',
  'multi', 'dual', 'chs', 'cht', 'chinese', 'gb', 'big5', 'eng', 'jpn',
  '简体', '繁体', '简繁', '中字', '中英', '双语', '国语', '粤语', '英语',
  '日语', '韩语', '中文字幕', '内嵌', '外挂', '字幕', '收藏版', '导演剪辑',
  '国语版', '原声', '未删减', '高清', '超清', '蓝光', '修复版', '加长版',
  '合集', '全集', '完结', '更新至', '无删减', '纯净版', '重制版',
  'nf', 'amzn', 'dsnp', 'hulu', 'atvp', 'pcok', 'max', 'hmax', 'itunes',
  '10bit', 'hevc10', '60fps', '30fps', '25fps', '24fps', '50fps',
  // 网盘推广尾巴：常紧贴片名且不在括号里（「xxx.2024.2160P.HDR.DDP5.1.影视分享屋.mp4」），
  // 括号剥离吃不掉它，结果整部片顶着一个查不到的怪名字
  '影视分享屋', '影视分享', '资源分享', '电影分享', '高清分享', '追剧分享',
  '首发', '抢先', '抢先版', '独家', '网盘', '资源网', '电影网', '首发版',
];

const NOISE_SET = new Set(NOISE_TOKENS.map((t) => t.replace(/\s+/g, '')));

function splitExt(fileName) {
  const idx = fileName.lastIndexOf('.');
  if (idx <= 0) return { base: fileName, ext: '' };
  return { base: fileName.slice(0, idx), ext: fileName.slice(idx).toLowerCase() };
}

function isVideo(fileName) {
  return VIDEO_EXTS.has(splitExt(fileName).ext);
}
function isAudio(fileName) {
  return AUDIO_EXTS.has(splitExt(fileName).ext);
}
function isSubtitle(fileName) {
  return SUBTITLE_EXTS.has(splitExt(fileName).ext);
}
function isMedia(fileName) {
  const { ext } = splitExt(fileName);
  return VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext);
}

function shouldIgnoreDir(dirName) {
  return IGNORE_DIRS.has(dirName.toLowerCase());
}

// 提取季集信息
function extractSeasonEpisode(s) {
  let season = null;
  let episode = null;

  let m = s.match(/[Ss](\d{1,2})\s*[Ee](\d{1,4})/);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), cutAt: m.index };

  m = s.match(/(?:^|[^0-9])(\d{1,2})\s*[xX]\s*(\d{1,4})(?:[^0-9]|$)/);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), cutAt: m.index };

  // 中文：第N季 / 第N部
  const seasonCn = s.match(/第\s*([0-9一二三四五六七八九十]{1,3})\s*(?:季|部|辑)/);
  const epCn = s.match(/第\s*([0-9一二三四五六七八九十]{1,4})\s*(?:集|话|話|期|回|集全)/);

  if (seasonCn) season = cn2num(seasonCn[1]);
  if (epCn) episode = cn2num(epCn[1]);

  const seasonEn = s.match(/season\s*(\d{1,2})/i);
  if (seasonEn) season = parseInt(seasonEn[1], 10);
  const epEn = s.match(/\b(?:ep|episode|epsiode)\s*(\d{1,4})/i);
  if (epEn) episode = parseInt(epEn[1], 10);

  const cutCandidates = [seasonCn, epCn, seasonEn, epEn].filter(Boolean).map((x) => x.index);
  const cutAt = cutCandidates.length ? Math.min(...cutCandidates) : -1;

  if (season != null || episode != null) return { season, episode, cutAt };

  // 裸 E01 形式（前面需是分隔符或行首，避免误伤 "Season" 之类的单词）。
  // 尾部不要求分隔符：网盘资源常见 "E01[更多关注微信公众号：xxx].mp4" 这类广告后缀，
  // 旧正则要求尾部也是 [\s\-_.] 或行尾，导致这类文件名全部漏判（掉进 short/movie 兜底）。
  m = s.match(/(?:^|[\s\-_.])[Ee](\d{1,4})(?![0-9])/);
  if (m) return { season: null, episode: parseInt(m[1], 10), cutAt: m.index };

  return { season: null, episode: null, cutAt: -1 };
}

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cn2num(str) {
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  if (str === '十') return 10;
  if (str.length === 1) return CN_NUM[str] ?? null;
  if (str.startsWith('十')) return 10 + (CN_NUM[str[1]] ?? 0);
  if (str.endsWith('十')) return (CN_NUM[str[0]] ?? 0) * 10;
  if (str.includes('十')) {
    const [a, b] = str.split('十');
    return (CN_NUM[a] ?? 0) * 10 + (CN_NUM[b] ?? 0);
  }
  return null;
}

// 提取年份（避开季集数字）
function extractYear(s, protectIndex = -1) {
  const matches = [...s.matchAll(/(19\d{2}|20\d{2})/g)];
  if (!matches.length) return null;
  // 优先括号/方括号里的年份
  const bracketed = [...s.matchAll(/[([【（]\s*(19\d{2}|20\d{2})\s*[)\]】）]/g)];
  if (bracketed.length) return parseInt(bracketed[bracketed.length - 1][1], 10);
  // 否则取第一个不在季集位置的、且不紧跟 SxxExx 的
  for (const mm of matches) {
    const idx = mm.index;
    if (protectIndex >= 0 && idx <= protectIndex) continue;
    const before = s[idx - 1];
    const after = s[idx + mm[0].length];
    if (before === 'E' || before === 'e') continue;
    if (after === 'p' || after === 'P' || after === 'i' || after === 'I') continue;
    return parseInt(mm[1], 10);
  }
  return null;
}

function titleCaseIfLatin(s) {
  if (/[\u4e00-\u9fa5]/.test(s)) return s;
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return s;
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/* 推广尾巴：公众号、网址、资源站名。它们要么紧贴片名、要么压根没有分隔符，
   cleanTitle 的括号剥离与噪词切词都处理不了 —— 必须在最前面整段切掉。 */
const AD_RE = [
  /更多关注(?:微信)?公众号[:：]?\S*/gi,
  /微信公众号[:：]?\S*/gi,
  /(?:影视|电影|资源|高清|追剧|影音)(?:分享屋|分享网|分享|资源网|大全|之家|影院|天堂)\S*/g,
  /\b[a-z0-9][a-z0-9-]*\.(?:com|net|cn|org|top|xyz|cc|me|tv)\b(?:\/\S*)?/gi,
  /(?:QQ|qq)\s*群[:：]?\s*\d{5,}/g,
];

function cleanTitle(s) {
  let t = s;
  for (const re of AD_RE) t = String(t == null ? '' : t).replace(re, ' ');
  // 去掉方括号/花括号/圆括号整体（常为字幕组标记、年份、分辨率）
  t = t.replace(/[[{][^\]}]*[\]}]/g, ' ');
  t = t.replace(/[(（][^)）]*[)）]/g, ' ');
  t = t.replace(/【[^】]*】/g, ' ');

  const tokens = t.split(/[\s._\-–+]+/).filter(Boolean);

  // 影视发布命名习惯为「片名.年份.分辨率.来源.编码-发布组」，
  // 因此遇到第一个质量/年份标记即可判定片名已结束
  const isTerminator = (tok) => {
    const key = tok.toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, '');
    if (!key) return false;
    if (NOISE_SET.has(key)) return true;
    if (/^(19|20)\d{2}$/.test(tok)) return true;
    if (/^\d{3,4}[pi]$/i.test(tok)) return true;
    return false;
  };

  const kept = [];
  for (const tok of tokens) {
    if (isTerminator(tok)) break;
    const key = tok.toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, '');
    if (!key) continue;
    kept.push(tok);
  }

  let out = kept.join(' ');

  // 整串都是噪声标记时（如 "1080p" 单独成名），退回过滤式清洗
  if (!out) {
    out = tokens
      .filter((tok) => {
        const key = tok.toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, '');
        return key && !NOISE_SET.has(key) && !/^(19|20)\d{2}$/.test(tok);
      })
      .join(' ');
  }

  out = out.replace(/[\s._\-–+]+/g, ' ').trim();
  out = out.replace(/^[\s\-–_.]+|[\s\-–_.]+$/g, '');
  return out;
}

// 归一化为聚合键
function seriesKeyOf(title, year) {
  const base = (title || '')
    .toLowerCase()
    .replace(/[\s\-–_.:：·,，!！?？'"“”‘’()（）[\]【】]/g, '');
  return year ? `${base}|${year}` : base;
}

function parseName(fileName, opts = {}) {
  const { base, ext } = splitExt(fileName);
  const work = base.replace(/[._]/g, ' ');
  const se = extractSeasonEpisode(work);

  let titleSource = work;
  if (se.cutAt > 0) titleSource = work.slice(0, se.cutAt);

  let year = extractYear(titleSource) ?? extractYear(work, se.cutAt);

  let title = cleanTitle(titleSource);
  if (!title) title = cleanTitle(work);
  if (!title) title = base;

  // 文件名里没有剧名（纯 SxxExx / 纯集号 / 纯数字）时，用上级目录名当剧名
  // 常见于「剧名文件夹/文件名只有 S01E02.mp4」的网盘结构；否则整部剧无法聚合与刮削
  const flatTitle = String(title).replace(/\s+/g, '');
  const bareTitle = /^(s\d{1,2}e\d{1,4}|e\d{1,4}|\d{1,4})$/i.test(flatTitle);
  // 「剧名+纯数字」形式：绝命辩护1.mkv / 末日逼近2.mkv / 时光之轮 08.mp4
  // 这类文件名是剧集单集，但既没有 E/S 标记也不符合 bareTitle，旧逻辑会一路掉进
  // short/movie 兜底（实测导致 63 部剧集混进电影列表、350 条落进 short）。
  // 认定条件收紧：必须是「有非数字字符的主体 + 结尾 1~4 位数字」，
  // 且数字部分不超过 200（排除「流浪地球2」这种真实带数字的片名交给后续判断）。
  /* 「DDP.5.1」「DTS5.1」是声道标记，不是集号：
     实测「2024.2160P.HDR.DDP.5.1.影视分享屋.mp4」被判成第 51 集 —— 一部电影硬生生变成剧集。 */
  const audioChannelTail = /(?:ddp|dts|dd\+?|aac|truehd|atmos|flac|eac3|ac3)[ ._\-]*\d[ ._\-]*\d(?:[ ._\-]|$)/i.test(work);
  let trailingEp = null;
  if (!bareTitle && !audioChannelTail) {
    const te = flatTitle.match(/^(.+?)(\d{1,4})$/);
    if (te && /\D/.test(te[1]) && !/^(19|20)\d{2}$/.test(te[2])) {
      const n = parseInt(te[2], 10);
      if (n >= 1 && n <= 200) trailingEp = n;
    }
  }

  // 用目录名兜底（剧名文件、文件名只有集号）时，把集号一并回填。
  // 触发条件分两种：
  //   ① bareTitle：文件名就是裸集号（01.mp4 / E01.mp4）——集号已在 se 里，或取纯数字；
  //   ② trailingEp：文件名是「剧名+数字」——数字就是集号。
  // 安全闸（防真电影被误判）：目录名必须与「文件名的非数字主体」一致，
  // 且目录名自己不带那个数字。这样「绝命辩护1.mkv」@绝命辩护/ ✅，
  // 而「教父2.mkv」@教父2/ ❌（目录名自带 2，说明 2 是片名一部分）。
  let epFromDirFallback = null;
  if (opts.dirName && !/^\d+$/.test(String(opts.dirName).trim())) {
    const dnClean = cleanTitle(String(opts.dirName).replace(/[._]/g, ' ')).replace(/\s+/g, '');
    const dnBase = dnClean.replace(/\d{1,4}$/, '');
    if (dnBase) {
      const stemNoNum = String(title).replace(/\s+/g, '').replace(/^s\d{1,2}e\d{1,4}$/i, '').replace(/^e\d{1,4}$/i, '').replace(/\d{1,4}$/, '');
      // 主体一致：或文件名完全没主体（纯集号），或主体等于目录名（去尾数）
      const stemMatches = (bareTitle && !stemNoNum) || stemNoNum === dnBase;
      if (stemMatches) {
        const dnHasThatNum = trailingEp != null && new RegExp(String(trailingEp) + '$').test(dnClean);
        if (!dnHasThatNum) {
          // 集号来源：优先用已解析到的，其次用文件名尾部数字
          epFromDirFallback = (se.episode != null || audioChannelTail) ? null : (trailingEp != null ? trailingEp : (/^\d{1,4}$/.test(flatTitle) ? parseInt(flatTitle, 10) : null));
        }
      }
    }
  }
  // 「剧名+数字」时，title 要去掉尾部集号，否则「绝命辩护1」和「绝命辩护2」会分组成两部不同的剧
  if (trailingEp != null && epFromDirFallback === trailingEp) {
    const stripped = String(title).replace(new RegExp('\\s*' + trailingEp + '\\s*$'), '').trim();
    if (stripped) title = stripped;
  }

  // 「剧名+年份」结尾（怪奇物语2016/ 我们与恶的距离2019/）：年份是**整体名的一部分**，
  // 但目录名往往不带年份。此时若目录名（去数字）与「文件主体去年份」一致，
  // 就说明文件名 = 剧名+年份，应当剥掉年份并把年份记进 year 字段，
  // 否则 seriesKey 会带上年份，同一部剧的两个命名变体聚合不到一起。
  if (trailingEp == null && year != null && opts.dirName) {
    const stemNoYear = String(title).replace(/\s+/g, '').replace(/[（(]?(19|20)\d{2}[)）]?$/, '');
    const dnY = cleanTitle(String(opts.dirName).replace(/[._]/g, ' ')).replace(/\s+/g, '').replace(/[（(]?(19|20)\d{2}[)）]?$/, '');
    if (stemNoYear && dnY && stemNoYear === dnY && stemNoYear !== String(title).replace(/\s+/g, '')) {
      const stripped = String(title).replace(/\s*[（(]?(19|20)\d{2}[)）]?\s*$/, '').trim();
      if (stripped) title = stripped;
    }
  }

  // 先处理 bareTitle：文件名只有集号（01.mp4 / E01.mp4），或 S/E 标记出现在文件名开头
  // （「S06E01 HD1080P 官方中字.mp4」cutAt=0，切完剧名只剩噪声），都用目录名当剧名。
  // 必须放在「安全闸」之前，否则比较基准还是裸集号、拿不到剧名。
  if ((bareTitle || se.cutAt === 0) && opts.dirName) {
    const dnRaw = String(opts.dirName).replace(/[._]/g, ' ');
    const dnYear = extractYear(dnRaw);
    // 剥掉目录名尾部的年份与季号标记（「我们与恶的距离2019」→「我们与恶的距离」、「河谷镇S06」→「河谷镇」），
    // 年份记进 year、季号记进 season，否则 seriesKey 会带上这些尾巴、同一部剧聚合不到一起。
    const dnNoYear = dnRaw.replace(/\s*[（(]?(19|20)\d{2}[)）]?\s*$/, '');
    let dnSeason = null;
    const dnStripped = dnNoYear.replace(/\s*[Ss](\d{1,2})\s*$/, (m, n) => { dnSeason = parseInt(n, 10); return ''; });
    if (dnSeason != null && se.season == null) se.season = dnSeason;
    const dn = cleanTitle(dnStripped) || cleanTitle(dnNoYear);
    if (dn && !/^\d+$/.test(dn)) {
      // 目录名比文件名更可信（文件名可能只有集号）
      title = titleCaseIfLatin(dn);
      if (!year && dnYear) year = dnYear;
    }
  }

  /* 文件名里根本没有片名（网盘常见「2025.2160p.WEB-DL.H265.120fps.DTS5.1.mp4」）：
     清洗后只剩年份或一两个噪声字，这种条目既刮不到元数据也搜不到 —— 上级目录名是唯一来源。
     上面那道目录名兜底只覆盖「文件名是裸集号」的剧集，电影同样有这个问题，故再兜一次。 */
  {
    /* 「有效词」判定必须严格：清洗后残留的往往还是质量标记（DL / 120fps / DTS5 / 1），
       只看「有没有两个字母」会把这类垃圾当成片名，目录名兜底永远不触发。
       规则：噪词、纯数字、fps、分辨率、"字母+数字"（h265/dts5）都不算；
       剩下的要么含中文，要么是 ≥3 个字母的拉丁词。 */
    const isRealWord = (t2) => {
      const k = String(t2).toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, '');
      if (!k) return false;
      if (NOISE_SET.has(k)) return false;
      if (/^\d+$/.test(k)) return false;
      if (/^\d/.test(k)) return false;            // "1dts5" 这类粘连残留
      if (/^\d+fps$/.test(k)) return false;
      if (/^\d{3,4}[pi]$/.test(k)) return false;
      if (/^[a-z]{1,4}\d{1,2}$/.test(k)) return false; // h265 / x264 / dts5 / dd51
      return /[\u4e00-\u9fa5]/.test(k) || k.length >= 3;
    };
    const realWords = String(title || '').split(/[\s._\-–+]+/).filter(isRealWord);
    const weakTitle = realWords.length === 0;
    if (weakTitle && opts.dirName) {
      const dn2 = cleanTitle(String(opts.dirName).replace(/[._]/g, ' '));
      if (dn2 && !/^\d+$/.test(dn2) && dn2.replace(/[^\u4e00-\u9fa5A-Za-z]/g, '').length >= 2) {
        title = titleCaseIfLatin(dn2);
        if (!year) year = extractYear(String(opts.dirName).replace(/[._]/g, ' '));
      }
    }
  }

  // 「剧名+数字」：已经带剧名，title 不用换，只把尾部数字补成集号
  if (epFromDirFallback != null && se.episode == null) {
    se.episode = epFromDirFallback;
  }

  const hasEpisodeMarker = se.episode != null;
  const hasSeasonMarker = se.season != null;
  const isTvByName = hasEpisodeMarker || hasSeasonMarker;

  let kind = 'unknown';
  if (isTvByName) kind = 'episode';
  else if (opts.duration && opts.duration > 60 * 60) kind = 'movie';
  else if (opts.duration && opts.duration > 0) kind = 'short';

  return {
    ext,
    title: titleCaseIfLatin(title),
    year,
    season: se.season,
    episode: se.episode,
    hasEpisodeMarker,
    hasSeasonMarker,
    kind,
    seriesKey: seriesKeyOf(title, year), // 用（可能已换成目录名的）title 归组
  };
}

module.exports = {
  VIDEO_EXTS, AUDIO_EXTS, SUBTITLE_EXTS,
  splitExt, isVideo, isAudio, isSubtitle, isMedia, shouldIgnoreDir,
  parseName, cleanTitle, extractYear, extractSeasonEpisode, seriesKeyOf,
};
