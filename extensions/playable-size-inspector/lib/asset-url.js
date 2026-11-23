'use strict';

/** Quy đổi db://assets/... <-> đường dẫn fs trong <project>/assets (không cần asset-db). */

const path = require('path');
const { toPosix } = require('./fs-utils');

function assetsRoot(projectRoot) {
  return path.join(projectRoot, 'assets');
}

/** db://assets/a/b.png -> <project>/assets/a/b.png ('' nếu không phải url trong assets) */
function urlToFsPath(projectRoot, url) {
  const value = String(url || '').trim();
  if (!value.startsWith('db://assets')) {
    return '';
  }
  const relative = value.slice('db://assets'.length).replace(/^\/+/, '');
  return path.join(assetsRoot(projectRoot), relative.replace(/\//g, path.sep));
}

/** <project>/assets/a/b.png -> db://assets/a/b.png ('' nếu nằm ngoài assets) */
function fsPathToUrl(projectRoot, fsPath) {
  const root = path.resolve(assetsRoot(projectRoot));
  const resolved = path.resolve(String(fsPath || ''));
  if (resolved.toLowerCase() === root.toLowerCase()) {
    return 'db://assets';
  }
  if (!resolved.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) {
    return '';
  }
  return `db://assets/${toPosix(path.relative(root, resolved))}`;
}

/** Nhận db:// url hoặc đường dẫn fs -> đường dẫn fs tuyệt đối ('' nếu không hợp lệ). */
function toFsPath(projectRoot, ref) {
  const value = String(ref || '').trim();
  if (!value) {
    return '';
  }
  return value.startsWith('db://') ? urlToFsPath(projectRoot, value) : path.resolve(value);
}

module.exports = {
  assetsRoot,
  urlToFsPath,
  fsPathToUrl,
  toFsPath,
};
