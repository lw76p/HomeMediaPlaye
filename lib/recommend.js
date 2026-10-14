/* 内容特征推荐引擎（P1，2026-09-27）
 * 路线：内容特征 + 规则加权，不做协同过滤（行为数据太薄：进度 ~64 条、点赞 ~10 条）
 * 画像 = 已看内容的 genre 分布（剧集 genre 从 series 表级联）+ 点赞加权（×3）
 * 打分 = 画像 genre 重叠 ×2 + 年代亲和 +0.5 + TMDB 评分 ×0.1 + 轻随机抖动
 * 理由可解释：「因为你看了《X》」/「你常看 A · B」
 * 画像样本 <3 返回空 —— 数据不足以构成「为你」时宁可不推荐
 */
'use strict';

/* TMDB 类目归一：genre 中英混存（电影多中文「剧情,犯罪」、剧集多英文复合类目
 * 「Sci-Fi & Fantasy,动作冒险」），画像与候选必须过同一映射才有交集（实测 8090 库） */
const GENRE_MAP = {
  'Sci-Fi & Fantasy': '科幻', 'Science Fiction': '科幻', 'Sci-Fi': '科幻',
  'Fantasy': '奇幻',
  'Action & Adventure': '动作冒险',
  'Adventure': '冒险',
  'War & Politics': '战争',
  'Documentary': '纪录',
  'Family': '家庭',
  'Kids': '少儿', 'Children': '少儿',
  'Drama': '剧情', 'Comedy': '喜剧', 'Crime': '犯罪', 'Mystery': '悬疑',
  'Thriller': '惊悚', 'Romance': '爱情', 'Animation': '动画', 'Western': '西部',
  'History': '历史', 'Music': '音乐', 'Musical': '音乐', 'Horror': '恐怖',
  'Reality': '综艺', 'Talk': '脱口秀', 'News': '新闻', 'TV Movie': '电视电影',
};

/* credits 列（JSON 字符串 {cast:[],dir:[]}）→ 人员数组（cast+dir 合并）；坏 JSON/空值返回空数组 */
function parseCredits(c) {
  try {
    const o = JSON.parse(c);
    if (!o) return [];
    return [...(o.cast || []), ...(o.dir || [])].map((s) => String(s || '').trim()).filter(Boolean);
  } catch { return []; }
}

function normGenres(g) {
  const out = [];
  for (let s of String(g || '').split(',')) {
    s = s.trim();
    if (!s) continue;
    const n = GENRE_MAP[s] || s;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/* 作品分组键：同片多版本/同剧多集归为一个「作品」（与首页 collapse 的 homeKey 同构） */
function workKeyOf(m, seriesByKey) {
  if (m.series_key) return 'series:' + m.series_key;
  const title = m.tmdb_title || m.title;
  return (String(title || '').trim().toLowerCase()) + '|' + (m.year || '');
}
function workKeyOfSeries(s) {
  return 'series:' + s.series_key;
}
function displayTitleOf(m, seriesByKey) {
  if (m.kind === 'episode' && m.series_key) {
    const s = seriesByKey.get(m.series_key);
    return (s && (s.tmdb_title || s.title)) || m.title;
  }
  return m.tmdb_title || m.title;
}

/* 画像构建
 * all          db.queryMedia 全量行（已带 progress_position/progress_finished，儿童模式过滤后）
 * seriesByKey  series_key → series 行（genre 级联来源）
 * likes        [{target, n}]（target: 'm:<mediaId>' | 's:<seriesKey>'，n>0 才是有效点赞）
 */
function buildProfile(all, seriesByKey, likes) {
  const genres = new Map();      // 归一化 genre → 权重（看过 +1 / 点过赞 +3）
  const people = new Map();      // 演员/导演 → 权重（看过 +1 / 点过赞 +3）
  const years = [];
  const seenWorks = [];          // { key, title, genres } —— 「因为你看了《X》」的代表作池
  const excludeKeys = new Set(); // 已看 / 在看 / 点赞 → 从推荐候选排除

  const creditsOf = (m) => {
    if (m.kind === 'episode' && m.series_key) {
      const s = seriesByKey.get(m.series_key);
      return parseCredits((s && s.credits) || m.credits);
    }
    return parseCredits(m.credits);
  };
  const genreOf = (m) => {
    if (m.kind === 'episode' && m.series_key) {
      const s = seriesByKey.get(m.series_key);
      return normGenres((s && s.genre) || m.genre);
    }
    return normGenres(m.genre);
  };

  for (const m of all) {
    const pos = m.progress_position || 0;
    const fin = !!m.progress_finished;
    if (!fin && pos <= 300) continue; // ≥5 分钟观看才算「看过」（几秒误点不算）
    const k = workKeyOf(m, seriesByKey);
    if (excludeKeys.has(k)) continue; // 同剧多集 / 同片多版本只计一次
    excludeKeys.add(k);
    const gs = genreOf(m);
    const ppl = creditsOf(m);
    if (!gs.length && !ppl.length) continue;
    for (const g of gs) genres.set(g, (genres.get(g) || 0) + 1);
    for (const p of ppl) people.set(p, (people.get(p) || 0) + 1);
    if (m.year) years.push(Number(m.year));
    if (seenWorks.length < 300) seenWorks.push({ key: k, title: displayTitleOf(m, seriesByKey), genres: gs, people: ppl });
  }

  for (const L of (likes || [])) {
    if (!(L.n > 0)) continue; // n=0 = 点过又取消
    let gs = [], title = null, k = null, ppl = [];
    if (L.target.startsWith('m:')) {
      const m = all.find((x) => String(x.id) === L.target.slice(2));
      if (!m) continue;
      gs = genreOf(m); title = displayTitleOf(m, seriesByKey); k = workKeyOf(m, seriesByKey);
      ppl = creditsOf(m);
    } else if (L.target.startsWith('s:')) {
      const s = seriesByKey.get(L.target.slice(2));
      if (!s) continue;
      gs = normGenres(s.genre); title = s.tmdb_title || s.title; k = workKeyOfSeries(s);
      ppl = parseCredits(s.credits);
    } else continue;
    /* 注意：m/s 是上面 if/else 块内的局部变量，块外不可见——
       原写法在块外引用 m/s 会 ReferenceError（用户点过赞首页就 500），必须把 ppl 算进各分支 */
    excludeKeys.add(k);
    for (const g of gs) genres.set(g, (genres.get(g) || 0) + 3);
    for (const p of ppl) people.set(p, (people.get(p) || 0) + 3);
    seenWorks.push({ key: k, title, genres: gs, people: ppl });
  }

  years.sort((a, b) => a - b);
  const yearCenter = years.length >= 3 ? years[Math.floor(years.length / 2)] : null;
  return { genres, people, yearCenter, seenWorks, excludeKeys, sample: seenWorks.length };
}

/* 打分：candidates = [{ card, genres }]（card 为最终输出形态，genres 已归一化）
 * 返回 [{ card, score, reason }]，按分排序截断 */
function scoreCandidates(profile, candidates, { topN = 18 } = {}) {
  if (!profile || profile.sample < 3) return [];
  const out = [];
  for (const c of candidates) {
    const k = c.key;
    if (profile.excludeKeys.has(k)) continue;
    const gs = c.genres || [];
    if (!gs.length) continue;
    let score = 0;
    const hit = [];
    for (const g of gs) {
      const w = profile.genres.get(g) || 0;
      if (w > 0) { score += w * 2; hit.push(g); }
    }
    if (!hit.length && !(c.people || []).length) continue; // genre 与人员全无重叠不上推荐
    // people 打分：候选演员/导演在画像里的权重 ×1.5（比 genre 略低）
    for (const p of (c.people || [])) {
      const w = profile.people.get(p) || 0;
      if (w > 0) { score += w * 1.5; hit.push(p); }
    }
    if (!hit.length) continue; // 零重叠不上推荐（纯随机没有「为你」的意义）
    if (c.year && profile.yearCenter && Math.abs(Number(c.year) - profile.yearCenter) <= 10) score += 0.5;
    score += (c.rating || 0) * 0.1;
    score += Math.random() * 0.2; // 轻抖动，同档内容轮换面孔
    // 理由：people 优先（演员/导演重叠的代表作）→ genre 重叠代表作 → 常看类型
    let reason = null, best = 0, pName = null;
    for (const w of profile.seenWorks) {
      if (w.key === k) continue;
      const common = (c.people || []).filter((p) => (w.people || []).includes(p));
      if (common.length > best) { best = common.length; reason = w.title; pName = common.sort((a, b) => (profile.people.get(b) || 0) - (profile.people.get(a) || 0))[0]; }
    }
    if (reason) {
      reason = '因为你看过 ' + pName + ' 的《' + reason + '》';
    } else {
      // genre 理由：与候选 genre 重叠最多的已看代表作
      for (const w of profile.seenWorks) {
        if (w.key === k) continue;
        let ov = 0;
        for (const g of w.genres) if (gs.includes(g)) ov++;
        if (ov > best) { best = ov; reason = w.title; }
      }
      if (reason) reason = '因为你看了《' + reason + '》';
      else {
        // 无单部代表作时，按画像权重取命中的前两类
        const hitTop = hit
          .map((g) => [g, profile.genres.get(g) || 0])
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map((x) => x[0]);
        reason = '你常看 ' + hitTop.join(' · ');
      }
    }
    out.push({ card: c.card, score, reason });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, topN);
}

module.exports = { normGenres, parseCredits, buildProfile, scoreCandidates, workKeyOf, displayTitleOf };
