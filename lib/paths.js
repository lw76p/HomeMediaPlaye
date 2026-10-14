'use strict';
// Web 版数据目录管理：与桌面版对齐的 5.2 数据存储结构
// 数据根目录由 HMP_DATA_DIR 环境变量决定（Docker 内默认 /data）
const path = require('node:path');
const fs = require('node:fs');

const dataRoot = () =>
  process.env.HMP_DATA_DIR || path.join(__dirname, '..', 'data');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const dirs = {
  root: () => ensureDir(dataRoot()),
  cache: () => ensureDir(path.join(dataRoot(), 'cache')),
  posters: () => ensureDir(path.join(dataRoot(), 'cache', 'posters')),
  config: () => ensureDir(path.join(dataRoot(), 'config')),
  logs: () => ensureDir(path.join(dataRoot(), 'logs')),
};

const files = {
  db: () => path.join(dirs.root(), 'media.db'),
};

module.exports = { dataRoot, ensureDir, dirs, files };
