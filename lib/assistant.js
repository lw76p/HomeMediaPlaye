'use strict';
// AI 助理：把自然语言问题变成库内检索结果。
// 三档推理（自动降级，永不卡死）：
//   ① Ollama 本地（qwen2.5:1.5b，原生 /api/chat tools）—— 默认 127.0.0.1:11434
//   ② 云 API（OpenAI 兼容，HMP_AI_API_BASE/KEY/MODEL 配置）—— 可选
//   ③ 规则路由（关键词 → 工具）—— 没模型也能用，纯本地零依赖
// 工具全部后端直查（不走 HTTP），结果带前端 hash 路由，可直接点开。
// 危险操作（下载/删除/重扫）只生成「提议」，由前端确认卡二次确认后才执行。

const db = require('./db');
const kids = require('./kids');
const music = require('./music');
const ebooks = require('./ebooks');
const livetv = require('./livetv');
const photos = require('./photos');
const faces = require('./faces');
const ai = require('./ai');

const OLLAMA = process.env.HMP_OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.HMP_OLLAMA_MODEL || 'qwen2.5:1.5b';
const CLOUD_BASE = String(process.env.HMP_AI_API_BASE || '').replace(/\/+$/, '');
const CLOUD_KEY = process.env.HMP_AI_API_KEY || '';
const CLOUD_MODEL = process.env.HMP_AI_MODEL || 'gpt-4o-mini';
const LLM_TIMEOUT = 45000;

/* ---------------- 小工具 ---------------- */
const kw = (q, ...words) => words.some((w) => q.includes(w));
/* 规则模式下的停用词：把「有没有周星驰的电影啊」洗成「周星驰 电影」
 * 不洗的话整句当关键词去 LIKE，必然一条都搜不到。 */
const STOP = ['有没有', '我想', '我要', '帮我', '给我', '找找', '找一下', '找一找', '想看', '看看', '看一下', '推荐', '来一部', '来几部', '搜索', '查询', '一下', '一些', '一部', '那个', '这个', '的', '了', '吗', '呢', '啊', '呀', '吧', '是', '有', '和', '与', '或', '在', '我', '你', '请'];
function cleanQuery(q) {
  let s = String(q || '').replace(/[，,。.；;：:！!？?、'"「」『』()（）【】]/g, ' ');
  for (const w of STOP) s = s.split(w).join(' ');
  const toks = s.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 1 && t.length <= 30);
  return [...new Set(toks)].slice(0, 6).join(' ');
}
/* 多关键词 OR 匹配：任一词命中即算命中（词越多召回越宽） */
function orLike(cols, phrase) {
  const toks = String(phrase || '').split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  const parts = [];
  const args = [];
  for (const t of toks) {
    const like = '%' + escLike(t) + '%';
    parts.push('(' + cols.map((c) => c + ' LIKE ?').join(' OR ') + ')');
    for (let i = 0; i < cols.length; i++) args.push(like);
  }
  return { sql: parts.join(' OR '), args };
}
const escLike = (s) => String(s || '').replace(/[%_]/g, (m) => '\\' + m);
function yearFromQuery(q) {
  const m = String(q || '').match(/(19|20)\d{2}/);
  if (m) return Number(m[0]);
  const y = new Date().getFullYear();
  if (kw(q, '去年')) return y - 1;
  if (kw(q, '今年')) return y;
  if (kw(q, '前年')) return y - 2;
  return 0;
}

/* ---------------- 8 个工具 ---------------- */
const TOOLS = [
  {
    name: 'search_media',
    desc: '按片名/类型/演员/年份搜索影视库（电影与剧集）',
    params: { type: 'object', properties: { q: { type: 'string', description: '片名关键词或演员名' }, kind: { type: 'string', enum: ['movie', 'episode', ''] }, year: { type: 'integer' }, genre: { type: 'string' }, limit: { type: 'integer' } }, required: ['q'] },
    dangerous: false,
    async run(a) {
      const q = String(a.q || '').trim();
      const limit = Math.max(1, Math.min(30, Number(a.limit) || 12));
      let sql = `SELECT id, title, tmdb_title, year, kind, genre, rating, overview, official_poster, poster, duration, credits FROM media_files WHERE `;
      const or = orLike(['title', 'tmdb_title', 'file_name', 'credits', 'genre'], q);
      if (!or) throw new Error('缺少关键词');
      sql += '(' + or.sql + ')';
      const args = or.args;
      if (a.kind === 'movie' || a.kind === 'episode') { sql += ' AND kind = ?'; args.push(a.kind); }
      if (a.year) { sql += ' AND year = ?'; args.push(Number(a.year)); }
      if (a.genre) { sql += ' AND genre LIKE ?'; args.push('%' + escLike(a.genre) + '%'); }
      sql += ' ORDER BY (tmdb_title IS NOT NULL) DESC, rating DESC, year DESC LIMIT ?';
      args.push(limit * 3);
      const rows = db.all(sql, args).filter((r) => kids.checkMediaId(r.id)).slice(0, limit);
      return rows.map((r) => ({
        kind: 'media', id: r.id, title: r.tmdb_title || r.title || r.file_name,
        sub: [r.year, r.genre, r.kind === 'movie' ? '电影' : '剧集'].filter(Boolean).join(' · '),
        poster: r.official_poster || r.poster || '', url: '#/detail/' + r.id,
      }));
    },
  },
  {
    name: 'search_music',
    desc: '按歌名/歌手/专辑搜索音乐库',
    params: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer' } }, required: ['q'] },
    dangerous: false,
    async run(a) {
      const q = String(a.q || '').toLowerCase().trim();
      const limit = Math.max(1, Math.min(30, Number(a.limit) || 12));
      const all = kids.filterMusicTracks(music.listTracks());
      const hit = (t) => [t.title, t.artist, t.album, t.file_name].some((v) => String(v || '').toLowerCase().includes(q));
      return all.filter(hit).slice(0, limit).map((t) => ({
        kind: 'music', id: t.id, title: t.title || t.file_name,
        sub: [t.artist, t.album].filter(Boolean).join(' · '), poster: t.cover || '', url: '#/music',
      }));
    },
  },
  {
    name: 'search_books',
    desc: '按书名/作者搜索电子书库',
    params: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer' } }, required: ['q'] },
    dangerous: false,
    async run(a) {
      const q = String(a.q || '').toLowerCase().trim();
      const limit = Math.max(1, Math.min(30, Number(a.limit) || 12));
      const all = ebooks.listBooks();
      const hit = (b) => [b.title, b.author, b.file_name, b.dir].some((v) => String(v || '').toLowerCase().includes(q));
      return all.filter(hit).slice(0, limit).map((b) => ({
        kind: 'book', id: b.id, title: b.title || b.file_name, sub: b.author || '', poster: '', url: '#/books',
      }));
    },
  },
  {
    name: 'search_photos',
    desc: '自然语言找照片（AI 向量理解画面内容，如「海边的日落」「猫」），也可按人物名找',
    params: { type: 'object', properties: { q: { type: 'string', description: '画面描述或人物名' }, limit: { type: 'integer' } }, required: ['q'] },
    dangerous: false,
    async run(a) {
      const q = String(a.q || '').trim();
      const limit = Math.max(1, Math.min(40, Number(a.limit) || 24));
      const pr = kids.isActive() ? kids.status().config.photoRoots : null;
      const out = [];
      // ① 人物名优先：命中已命名人物就直接出该人物照片
      try {
        const persons = faces.listPersons(pr ? { rootIds: pr } : {}) || [];
        const hitP = persons.find((p) => p.name && q.includes(p.name));
        if (hitP) {
          for (const it of faces.personPhotos(hitP.id, { limit, rootIds: pr || [] })) {
            out.push({ kind: 'photo', id: it.photo_id, title: '👤 ' + hitP.name, sub: it.photo_name || '', poster: '/api/photos/libthumb/' + it.photo_id, url: '#/photos' });
          }
          if (out.length) return out.slice(0, limit);
        }
      } catch (e) {}
      // ② CLIP 向量检索（需文本模型；没装会抛 NO_TEXT_MODEL，走 ③）
      try {
        const r = await ai.searchByText(q, { limit, rootIds: pr });
        for (const it of (r.items || [])) {
          out.push({ kind: 'photo', id: it.id, title: it.name || ('照片 ' + it.id), sub: (it.score ? '相关度 ' + it.score.toFixed(2) : ''), poster: '/api/photos/libthumb/' + it.id, url: '#/photos' });
        }
        if (out.length) return out;
      } catch (e) {}
      // ③ 兜底：文件名 / 日期 / 目录 关键词
      const all = photos.libListAll({ offset: 0, limit: 3000, cat: '', dtype: '', date: '', fmt: '', rootIds: pr }) || {};
      const items = all.items || [];
      const lq = q.toLowerCase();
      return items.filter((p) => [p.name, p.dir, p.taken_at].some((v) => String(v || '').toLowerCase().includes(lq)))
        .slice(0, limit)
        .map((p) => ({ kind: 'photo', id: p.id, title: p.name || ('照片 ' + p.id), sub: p.taken_at || '', poster: '/api/photos/libthumb/' + p.id, url: '#/photos' }));
    },
  },
  {
    name: 'list_livetv',
    desc: '搜索电视直播频道（如 CCTV、卫视、体育、电影频道）',
    params: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer' } }, required: [] },
    dangerous: false,
    async run(a) {
      const q = String(a.q || '').toLowerCase().trim();
      const limit = Math.max(1, Math.min(40, Number(a.limit) || 20));
      const list = livetv.list() || [];
      const hit = (c) => !q || [c.name, c.group].some((v) => String(v || '').toLowerCase().includes(q));
      return list.filter(hit).slice(0, limit).map((c) => ({
        kind: 'channel', id: c.id || c.name, title: c.name, sub: c.group || '直播', poster: c.logo || '', url: '#/livetv',
      }));
    },
  },
  {
    name: 'continue_watching',
    desc: '列出没看完的影视（继续观看）',
    params: { type: 'object', properties: { limit: { type: 'integer' } } },
    dangerous: false,
    async run(a) {
      const limit = Math.max(1, Math.min(30, Number(a.limit) || 12));
      const rows = db.all(`SELECT m.*, p.position AS pos, p.duration AS pdur FROM media_files m
                           JOIN watch_progress p ON p.media_id = m.id
                           WHERE p.finished = 0 AND p.position > 30
                           ORDER BY p.updated_at DESC LIMIT ?`, [limit * 3]);
      return rows.filter((r) => kids.checkMediaId(r.id)).slice(0, limit).map((r) => ({
        kind: 'media', id: r.id, title: r.tmdb_title || r.title || r.file_name,
        sub: '看到 ' + Math.round((r.pos || 0) / 60) + ' 分钟', poster: r.official_poster || r.poster || '', url: '#/detail/' + r.id,
      }));
    },
  },
  {
    name: 'library_stats',
    desc: '库统计：影片/剧集/音乐/图书/照片各多少个、最近入库了什么',
    params: { type: 'object', properties: {} },
    dangerous: false,
    async run() {
      const one = (sql, arg) => { try { const r = db.get(sql, arg || []); return r ? Object.values(r)[0] : 0; } catch { return 0; } };
      const movie = one("SELECT COUNT(*) FROM media_files WHERE kind='movie'");
      const ep = one("SELECT COUNT(*) FROM media_files WHERE kind='episode'");
      const tracks = (music.listTracks() || []).length;
      const books = (ebooks.listBooks() || []).length;
      let photoN = 0;
      try { const ps = photos.libStats() || {}; photoN = Number(ps.lib || ps.total || 0) || 0; } catch (e) { photoN = one('SELECT COUNT(*) FROM lib_photos'); }
      const recent = db.all(`SELECT id, tmdb_title, title, file_name, kind FROM media_files ORDER BY last_seen_at DESC LIMIT 5`);
      return [{ kind: 'stat', id: 0, title: '影视库：电影 ' + movie + ' 部 · 剧集 ' + ep + ' 集', sub: '音乐 ' + tracks + ' 首 · 图书 ' + books + ' 本 · 照片 ' + photoN + ' 张', poster: '', url: '#/library',
        extra: { movie, episode: ep, tracks, books, photos: photoN, recent: recent.map((r) => r.tmdb_title || r.title || r.file_name) } }];
    },
  },
  {
    name: 'add_download',
    desc: '添加下载任务（磁力链/直链）—— 危险操作，只生成待确认的提议，用户确认后才会真正添加',
    params: { type: 'object', properties: { url: { type: 'string', description: '磁力链或 http 直链' } }, required: ['url'] },
    dangerous: true, // 写操作 → 只出提议
    confirmText: (a) => '要添加下载任务吗？\n' + String(a.url || '').slice(0, 120),
    async run(a) { return { added: false, needConfirm: true, url: String(a.url || '') }; },
  },
];
const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const DANGEROUS = new Set(TOOLS.filter((t) => t.dangerous).map((t) => t.name));

/* ---------------- 推理层：Ollama / 云 API / 规则 ---------------- */
function toolSchemas() {
  return TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.desc, parameters: t.params } }));
}

async function callOllama(messages) {
  const r = await fetch(OLLAMA + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, messages, tools: toolSchemas(), stream: false }),
    signal: AbortSignal.timeout(LLM_TIMEOUT),
  });
  if (!r.ok) throw new Error('Ollama HTTP ' + r.status);
  const j = await r.json();
  return { calls: (j.message && j.message.tool_calls) || [], text: (j.message && j.message.content) || '' };
}

async function callCloud(messages) {
  const r = await fetch(CLOUD_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CLOUD_KEY },
    body: JSON.stringify({ model: CLOUD_MODEL, messages, tools: toolSchemas(), tool_choice: 'auto' }),
    signal: AbortSignal.timeout(LLM_TIMEOUT),
  });
  if (!r.ok) throw new Error('云 API HTTP ' + r.status);
  const j = await r.json();
  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  return { calls: (msg.tool_calls || []).map((c) => ({ function: { name: c.function.name, arguments: parseArgs(c.function.arguments) } })), text: msg.content || '' };
}
function parseArgs(s) { try { return typeof s === 'string' ? JSON.parse(s) : (s || {}); } catch { return {}; } }

/* 规则路由：没 LLM 时的本地兜底（关键词 → 工具 + 参数） */
function ruleRoute(q) {
  const y = yearFromQuery(q);
  const out = [];
  const bare = cleanQuery(q);
  if (kw(q, '照片', '图片', '相册', '合影', '拍的', '旅游', '猫', '狗', '海边', '雪', '花', '宝宝', '孩子')) {
    out.push({ name: 'search_photos', arguments: { q: bare, limit: 24 } });
  }
  if (kw(q, '歌', '音乐', '听', '歌手', '专辑', '曲')) out.push({ name: 'search_music', arguments: { q: bare, limit: 12 } });
  if (kw(q, '书', '小说', '阅读', '作者', '漫画')) out.push({ name: 'search_books', arguments: { q: bare, limit: 12 } });
  if (kw(q, '直播', '频道', '电视', 'cctv', 'CCTV', '卫视', '体育频道')) out.push({ name: 'list_livetv', arguments: { q: bare, limit: 20 } });
  if (kw(q, '继续看', '没看完', '接着看', '看到一半', '在看')) out.push({ name: 'continue_watching', arguments: { limit: 12 } });
  if (kw(q, '多少', '几个', '统计', '多少个', '库里有多少', '总共有')) out.push({ name: 'library_stats', arguments: {} });
  const m = String(q || '').match(/(magnet:\?[^\s]+|https?:\/\/[^\s]+)/);
  if (m) out.push({ name: 'add_download', arguments: { url: m[1] } });
  if (!out.length) {
    out.push({ name: 'search_media', arguments: { q: bare, year: y || undefined, limit: 12 } });
    if (!kw(q, '电影', '剧', '影片', '片')) out.push({ name: 'search_photos', arguments: { q: bare, limit: 12 } });
  }
  return { calls: out.map((c) => ({ function: c })), text: '' };
}

/* 引擎可用性探测（启动时异步测一次，缓存 60 秒） */
let engineCache = { at: 0, mode: '' };
async function detectEngine() {
  if (Date.now() - engineCache.at < 60000 && engineCache.mode) return engineCache.mode;
  let mode = 'rule';
  try {
    const r = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(2500) });
    if (r.ok) mode = 'ollama';
  } catch (e) {}
  if (mode === 'rule' && CLOUD_BASE && CLOUD_KEY) mode = 'cloud';
  engineCache = { at: Date.now(), mode };
  return mode;
}

/* ---------------- 主入口 ---------------- */
async function ask(q, history) {
  const query = String(q || '').slice(0, 300);
  if (!query.trim()) throw new Error('问题为空');
  const msgs = [
    { role: 'system', content: '你是家庭影音库助手。用户用中文提问，你必须调用工具检索本地媒体库后再回答，不要凭空编造。找不到就如实说没找到，并说明搜了什么。回答用中文，简洁，2-3 句内。' },
    ...(Array.isArray(history) ? history.slice(-6).map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.text || '').slice(0, 500) })) : []),
    { role: 'user', content: query },
  ];
  const mode = await detectEngine();
  let plan;
  try {
    plan = mode === 'ollama' ? await callOllama(msgs) : mode === 'cloud' ? await callCloud(msgs) : ruleRoute(query);
  } catch (e) {
    plan = ruleRoute(query); // LLM 挂了就地降级，不让用户空手而归
  }
  const calls = (plan.calls || []).slice(0, 4);
  const results = [];
  const steps = [];
  const proposals = [];
  for (const c of calls) {
    const name = (c.function && c.function.name) || '';
    const t = TOOL_MAP[name];
    if (!t) continue;
    const args = parseArgs(c.function && c.function.arguments);
    try {
      const r = await t.run(args);
      if (DANGEROUS.has(name)) {
        proposals.push({ tool: name, args, text: t.confirmText ? t.confirmText(args) : '执行 ' + name + '？' });
        steps.push({ tool: name, args, count: 0, pending: true });
        continue;
      }
      const arr = Array.isArray(r) ? r : [];
      results.push(...arr);
      steps.push({ tool: name, args, count: arr.length });
    } catch (e) {
      steps.push({ tool: name, args, count: 0, error: e.message });
    }
  }
  // 去重（同 id 同 kind 只留一个）
  const seen = new Set();
  const uniq = results.filter((x) => { const k = x.kind + ':' + x.id; if (seen.has(k)) return false; seen.add(k); return true; });
  let reply = (plan.text || '').trim();
  if (!reply) {
    const n = uniq.length;
    reply = n ? `找到了 ${n} 条结果${steps.length > 1 ? '（搜了 ' + steps.map((s) => s.tool).join('、') + '）' : ''}。`
              : '没找到匹配的内容。' + (mode === 'rule' ? '（当前为本地规则模式，接上 Ollama 后可用自然语言精确查询）' : '');
  }
  return { ok: true, reply, mode, results: uniq.slice(0, 60), steps, proposals };
}

/* 确认后执行危险工具（前端二次确认） */
async function confirm(tool, args) {
  const t = TOOL_MAP[String(tool || '')];
  if (!t || !DANGEROUS.has(t.name)) throw new Error('该工具无需确认或不存在：' + tool);
  if (t.name === 'add_download') {
    const url = String((args && args.url) || '');
    if (!/^(magnet:|https?:\/\/)/i.test(url)) throw new Error('链接格式不对');
    const r = await fetch('http://127.0.0.1:' + (process.env.HMP_PORT || 8090) + '/api/dl/add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, detail: j };
  }
  throw new Error('未实现的确认动作');
}

module.exports = { ask, confirm, detectEngine, tools: TOOLS.map((t) => ({ name: t.name, desc: t.desc, dangerous: !!t.dangerous })) };
