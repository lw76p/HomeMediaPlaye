'use strict';
// 媒体库扫描：目录遍历 → 增量识别 → ffprobe 探测 → 分类 → 抽帧封面
// 对应 SRS F-LIB-001 ~ F-LIB-005
const fsp = require('node:fs/promises');
const path = require('node:path');
const db = require('./db');
const parse = require('./parse');
const probeMod = require('./probe');
const { dirs } = require('./paths');

const MAX_DEPTH = 14;

async function scanRoot(rootId, { onEvent = () => {} } = {}) {
  const root = db.listRoots().find((r) => r.id === rootId);
  if (!root) return { ok: false, error: '媒体库目录不存在' };
  // 网盘根目录：走 WebDAV 扫描（兼容历史 alist 类型）
  if (root.type === 'webdav' || root.type === 'alist') {
    const webdav = require('./webdav');
    return webdav.scanWebdavRoot(root, { onEvent });
  }
  return scanLocalRoot(rootId, { onEvent });
}

async function mapLimit(items, limit, worker, onEach) {
  const results = [];
  let index = 0;
  let done = 0;
  const runners = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { ok: false, error: String(err && err.message) };
      }
      done += 1;
      if (onEach) onEach(done, items.length);
    }
  });
  await Promise.all(runners);
  return results;
}

async function walk(dir, out, depth = 0, rootPath = null) {
  // BFS 分层并发遍历（串行递归在目录多时明显偏慢）
  const WALK_CONCURRENCY = 8;
  let layer = [{ dir, depth }];
  while (layer.length) {
    const next = [];
    await mapLimit(
      layer,
      WALK_CONCURRENCY,
      async (item) => {
        if (item.depth > MAX_DEPTH) return;
        let entries;
        try {
          entries = await fsp.readdir(item.dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of entries) {
          const full = path.join(item.dir, ent.name);
          if (ent.isSymbolicLink()) continue;
          if (ent.isDirectory()) {
            if (parse.shouldIgnoreDir(ent.name)) continue;
            if (ent.name.startsWith('.') && item.depth > 0) continue;
            next.push({ dir: full, depth: item.depth + 1 });
          } else if (ent.isFile()) {
            if (parse.isMedia(ent.name)) out.push(full);
          }
        }
      }
    );
    layer = next;
  }
}

function classify(fileName, duration, currentKind, locked) {
  if (locked) return currentKind;
  const p = parse.parseName(fileName, { duration });
  if (p.hasEpisodeMarker || p.hasSeasonMarker) return 'episode';
  if (duration && duration > 60 * 60) return 'movie';
  if (duration && duration > 0) return 'short';
  return currentKind || 'unknown';
}

// —— 兄弟集数启发式 ————————————————————————————————
// 「绝命辩护1.mkv … 绝命辩护13.mkv」这类文件名没有任何 S/E 标记，
// parseName 只能按时长判成 movie，一整季就以 N 部电影的身份挤进电影菜单。
// 判据：同目录下 ≥3 个视频文件去掉结尾数字后标题相同、且数字互不相同
// → 按第 1 季第 N 集处理（≥3 是防「教父1/教父2」这类纯续集电影被误折叠）。
function buildSiblingOverrides(rows) {
  const byDir = new Map();
  for (const r of rows) {
    if (r.kind_locked) continue;
    const ext = path.extname(r.file_name || '');
    if (!parse.isVideo(r.file_name || '')) continue;
    const base = ext ? r.file_name.slice(0, -ext.length) : r.file_name;
    const m = base.match(/^(.+?)[\s._-]*(\d{1,4})$/);
    if (!m) continue;
    const prefix = m[1].replace(/[._]/g, ' ').trim();
    if (prefix.length < 2) continue; // 「第1集」这类纯标记前缀交给 parseName 的目录名兜底
    if (!byDir.has(r.dir)) byDir.set(r.dir, new Map());
    const g = byDir.get(r.dir);
    if (!g.has(prefix)) g.set(prefix, []);
    g.get(prefix).push({ r, num: parseInt(m[2], 10) });
  }
  const ov = new Map();
  for (const g of byDir.values()) {
    for (const [prefix, list] of g) {
      if (list.length < 3) continue;
      if (new Set(list.map((x) => x.num)).size !== list.length) continue; // 出现同号 → 不是集号
      const title = parse.cleanTitle(prefix) || prefix;
      for (const { r, num } of list) {
        ov.set(r.id, { title, season: 1, episode: num, seriesKey: parse.seriesKeyOf(title, r.year) });
      }
    }
  }
  return ov;
}

// 全库重新识别：对已入库文件重跑解析规则，修正历史版本误分类
// （不动文件、不重新 ffprobe、不丢观看记录；kind_locked 的条目跳过）
function reclassifyAll() {
  const rows = db.all('SELECT id, file_name, dir, duration, kind, title, year, season, episode, series_key, kind_locked FROM media_files');
  const ov = buildSiblingOverrides(rows);
  let updated = 0;
  let locked = 0;
  const counts = {};
  // 批量 UPDATE 走单事务，大库重识别从分钟级降到秒级
  db.withTransaction(() => {
    for (const r of rows) {
      if (r.kind_locked) { locked += 1; counts[r.kind] = (counts[r.kind] || 0) + 1; continue; }
      const p = parse.parseName(r.file_name, { duration: r.duration || 0, dirName: path.basename(r.dir || '') });
      // 两类文件不折叠：
      // ① 已有 S/E 标记的——否则「绝命辩护S01E01」会被截成前缀「绝命辩护S01E」+集号1；
      // ② 当前不是 movie/short 的——unknown（多半是还没探到时长或命名带噪声）保持原状，
      //    避免给「24小时 1080P H265 SE02」这类目录硬造出垃圾剧名。
      const o = (p.hasEpisodeMarker || p.hasSeasonMarker || (r.kind !== 'movie' && r.kind !== 'short'))
        ? null : ov.get(r.id);
      let kind = o ? 'episode' : p.kind;
      // 时长充足但解析不出的，按电影处理（与 classify 的兜底口径一致）
      if (!o && kind === 'unknown' && r.duration && r.duration > 60 * 60) kind = 'movie';
      const isEp = kind === 'episode';
      const t2 = o ? o.title : p.title;
      const season2 = o ? o.season : p.season;
      const episode2 = o ? o.episode : p.episode;
      const newSeriesKey = isEp ? (o ? o.seriesKey : p.seriesKey) : null;
      const changed =
        kind !== r.kind ||
        t2 !== r.title ||
        (p.year ?? null) !== (r.year ?? null) ||
        (season2 ?? null) !== (r.season ?? null) ||
        (episode2 ?? null) !== (r.episode ?? null) ||
        (newSeriesKey ?? null) !== (r.series_key ?? null);
      counts[kind] = (counts[kind] || 0) + 1;
      if (!changed) continue;
      db.run(
        'UPDATE media_files SET title=?, year=?, season=?, episode=?, kind=?, series_key=? WHERE id=?',
        [t2, p.year ?? null, season2 ?? null, episode2 ?? null, kind, newSeriesKey, r.id]
      );
      updated += 1;
    }
  });
  db.rebuildSeries();
  return { total: rows.length, updated, locked, counts };
}

async function scanLocalRoot(rootId, { onEvent = () => {} } = {}) {
  const root = db.listRoots().find((r) => r.id === rootId);
  if (!root) return { ok: false, error: '媒体库目录不存在' };

  const started = Date.now();
  onEvent({ phase: 'walking', message: `正在遍历 ${root.path}` });

  const files = [];
  await walk(root.path, files, 0, root.path);
  onEvent({ phase: 'walked', message: `发现 ${files.length} 个媒体文件`, total: files.length });

  const stamp = Date.now();
  const needProbe = [];
  let added = 0;
  let unchanged = 0;

  // 并发 stat（数千文件时逐个 await 是明显瓶颈），随后单个事务内批量写库
  // （SQLite 每条语句 autocommit 都要 fsync，事务化是入库提速的最大头）
  const statResults = await mapLimit(
    files,
    16,
    async (filePath) => {
      try {
        return { filePath, st: await fsp.stat(filePath) };
      } catch {
        return null;
      }
    }
  );

  let removed = 0;
  db.withTransaction(() => {
    for (const item of statResults) {
      if (!item) continue;
      const { filePath, st } = item;
      const fileName = path.basename(filePath);
      const existing = db.findByPath(filePath);
      const parsed = parse.parseName(fileName, {
        duration: existing ? existing.duration : null,
        dirName: path.basename(path.dirname(filePath)),
      });

      if (existing && existing.size === st.size && existing.mtime === Math.floor(st.mtimeMs)) {
        unchanged += 1;
        db.run('UPDATE media_files SET last_seen_at = ? WHERE id = ?', [stamp, existing.id]);
        if (!existing.poster && (existing.kind === 'movie' || existing.kind === 'episode')) {
          needProbe.push({ id: existing.id, path: filePath, needMeta: false, needPoster: true, row: existing });
        }
        continue;
      }

      const id = db.upsertFile({
        rootId,
        path: filePath,
        dir: path.dirname(filePath),
        fileName,
        ext: parsed.ext,
        size: st.size,
        mtime: Math.floor(st.mtimeMs),
        title: parsed.title,
        year: parsed.year,
        season: parsed.season,
        episode: parsed.episode,
        kind: parsed.kind,
        seriesKey: parsed.seriesKey,
      }, stamp);

      if (!existing) added += 1;
      needProbe.push({
        id,
        path: filePath,
        needMeta: true,
        needPoster: true,
        row: db.getMedia(id),
      });
    }

    removed = db.purgeStale(rootId, stamp);
    db.touchRoot(rootId);
  });

  onEvent({
    phase: 'db',
    message: `入库完成：新增 ${added}，未变化 ${unchanged}，清理 ${removed}`,
    added, unchanged, removed, toProbe: needProbe.length,
  });

  // 探测元数据（时长/分辨率/编码）
  const metaTargets = needProbe.filter((t) => t.needMeta);
  if (metaTargets.length) {
    let n = 0;
    await mapLimit(
      metaTargets,
      6,
      async (t) => {
        const info = await probeMod.probe(t.path);
        if (!info.ok) return { ok: false };
        const kind = classify(path.basename(t.path), info.duration, t.row.kind, t.row.kind_locked);
        db.run(
          `UPDATE media_files SET duration=?, width=?, height=?, vcodec=?, acodec=?, kind=?, probed_at=?
           WHERE id=?`,
          [
            info.duration, info.width, info.height, info.vcodec, info.acodec,
            kind, Date.now(), t.id,
          ]
        );
        return { ok: true };
      },
      (d, total) => {
        n = d;
        if (d % 10 === 0 || d === total) {
          onEvent({ phase: 'probing', message: `解析媒体信息 ${d}/${total}`, done: d, total });
        }
      }
    );
  }

  // 修正此前 kind 为 unknown 但已有 duration 的记录
  const stale = db.all(
    `SELECT id, file_name, duration, kind FROM media_files WHERE probed_at IS NOT NULL AND (kind='unknown' OR kind='')`
  );
  for (const s of stale) {
    const kind = classify(s.file_name, s.duration, 'unknown', 0);
    if (kind !== s.kind) db.run('UPDATE media_files SET kind = ? WHERE id = ?', [kind, s.id]);
  }

  // 生成封面（本地抽帧）；封面规格变更（文件名版本不同）时自动重新生成
  const posterRows = db.all(
    `SELECT m.id, m.path, m.duration, m.kind, m.poster FROM media_files m
     WHERE m.kind IN ('movie','episode')
     ORDER BY m.kind ASC, m.id ASC`
  );
  const posterTargets = [];
  for (const t of posterRows) {
    const expected = probeMod.posterNameFor(t.path);
    if (t.poster === expected) {
      try {
        const st = await fsp.stat(path.join(dirs.posters(), expected));
        if (st.size > 1024) continue;
      } catch {
        /* 文件缺失，需要重新生成 */
      }
    }
    posterTargets.push(t);
  }
  if (posterTargets.length) {
    // 剧集每部只抽第一集，避免重复劳动
    const seenSeries = new Set();
    const picked = [];
    for (const t of posterTargets) {
      if (t.kind === 'episode') {
        const row = db.getMedia(t.id);
        const key = row.series_key || String(t.id);
        if (seenSeries.has(key)) continue;
        seenSeries.add(key);
      }
      picked.push(t);
    }
    let n = 0;
    await mapLimit(
      picked.slice(0, 400),
      3,
      async (t) => {
        const r = await probeMod.makePoster(t.path, { duration: t.duration });
        if (!r.ok) return { ok: false };
        db.setPoster(t.id, r.file);
        if (t.kind === 'episode') {
          const row = db.getMedia(t.id);
          if (row && row.series_key) {
            db.run('UPDATE media_files SET poster = ? WHERE series_key = ? AND poster IS NULL', [
              r.file, row.series_key,
            ]);
          }
        }
        return { ok: true };
      },
      (d, total) => {
        n = d;
        if (d % 5 === 0 || d === total) {
          onEvent({ phase: 'poster', message: `生成封面 ${d}/${total}`, done: d, total });
        }
      }
    );
  }

  db.rebuildSeries();

  const stats = db.countByKind();
  const result = {
    ok: true,
    rootId,
    elapsedMs: Date.now() - started,
    added, unchanged, removed,
    posterGenerated: posterTargets.length,
    stats,
  };
  onEvent({ phase: 'done', message: '扫描完成', result });
  return result;
}

async function scanAll({ onEvent = () => {} } = {}) {
  const roots = db.listRoots().filter((r) => r.enabled);
  const out = [];
  for (const r of roots) {
    out.push(await scanRoot(r.id, { onEvent }));
  }
  return out;
}

module.exports = { scanRoot, scanAll, walk, classify, mapLimit, reclassifyAll };
