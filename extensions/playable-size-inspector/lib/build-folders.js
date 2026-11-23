'use strict';

/**
 * Tìm các bản build web của Cocos: thư mục con của <project>/build (mỗi mạng có thể build ra một thư mục riêng,
 * tên tuỳ ý) cộng thư mục build của các build task web (Build Path tuỳ chỉnh: thư mục lồng như build/web/x hoặc
 * nằm ngoài dự án). Bỏ thư mục xuất của playable-ads-adapter (bản sao web-mobile cho mạng nhận zip): đó là bản
 * xuất, đã có trong lib/exports.js. Dùng chung cho panel và cli/selftest.js. Chỉ đọc.
 */

const fs = require('fs/promises');
const path = require('path');
const { isDirectory, isSameResolvedPath, isPathInside } = require('./fs-utils');
const { findBuildSettings } = require('./build-scan');
const { FOLDER_PATTERN, isAdapterFolder, readPlayableTasks, taskBuildDir } = require('./exports');

/** Thư mục có phải một bản build web của Cocos không (settings.json, hoặc index.html + assets/). */
async function isBuildFolder(fullPath) {
  if (await findBuildSettings(fullPath)) {
    return true;
  }
  const index = await fs.stat(path.join(fullPath, 'index.html')).catch(() => null);
  return !!index && await isDirectory(path.join(fullPath, 'assets'));
}

/** Tên hiển thị / giá trị ô Thư mục build: đường dẫn tương đối dự án (posix), ngoài dự án thì đường dẫn tuyệt đối. */
function displayPath(projectRoot, fullPath) {
  return isPathInside(fullPath, projectRoot) ? path.relative(projectRoot, fullPath).replace(/\\/g, '/') : path.resolve(fullPath);
}

async function describeBuild(projectRoot, fullPath, extra = {}) {
  const settingsPath = await findBuildSettings(fullPath);
  const stat = await fs.stat(settingsPath || path.join(fullPath, 'index.html')).catch(() => null);
  return { relative: displayPath(projectRoot, fullPath), fullPath, builtAt: stat ? stat.mtimeMs : 0, ...extra };
}

/**
 * Các bản build, mới nhất trước: [{ relative, fullPath, builtAt, taskId? }]. `taskId`: thư mục của một build task web
 * (đọc profiles/ của máy này). Thư mục xuất của adapter (<tên>_<Kênh>/ kèm config.json / js/index*.js của adapter) bị bỏ,
 * trừ khi chính nó là thư mục của một build task.
 */
async function listBuildFolders(projectRoot) {
  const tasks = await readPlayableTasks(projectRoot).catch(() => []);
  const taskDirs = tasks.map((task) => ({ taskId: task.taskId, dir: taskBuildDir(projectRoot, task.options) }));
  const taskOf = (fullPath) => taskDirs.find((item) => isSameResolvedPath(item.dir, fullPath));
  const builds = [];
  const buildDir = path.join(projectRoot, 'build');
  const entries = await fs.readdir(buildDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const fullPath = path.join(buildDir, entry.name);
    if (!await isBuildFolder(fullPath)) {
      continue;
    }
    const task = taskOf(fullPath);
    if (!task && FOLDER_PATTERN.test(entry.name) && await isAdapterFolder(fullPath)) {
      continue;
    }
    builds.push(await describeBuild(projectRoot, fullPath, task ? { taskId: task.taskId } : {}));
  }
  // Build task ra thư mục khác (lồng sâu hơn, hoặc ngoài dự án).
  for (const task of taskDirs) {
    if (builds.some((build) => isSameResolvedPath(build.fullPath, task.dir)) || !await isBuildFolder(task.dir)) {
      continue;
    }
    builds.push(await describeBuild(projectRoot, task.dir, { taskId: task.taskId }));
  }
  return builds.sort((left, right) => right.builtAt - left.builtAt);
}

/**
 * Bản build nên phân tích mặc định: trong các thư mục của build task web, thư mục vừa build gần nhất (đúng thứ người
 * dùng vừa build), rồi bản build mới nhất theo thời gian, rồi build/web-mobile. `builds` = listBuildFolders (truyền vào để khỏi quét lại).
 * Trả về { relative, fullPath, reason: 'task' | 'newest' | 'default' }.
 */
async function pickDefaultBuild(projectRoot, builds) {
  const list = builds || await listBuildFolders(projectRoot);
  const tasks = await readPlayableTasks(projectRoot).catch(() => []);
  // Nhiều build task web: lấy thư mục vừa build gần nhất (build lại task cũ thì task đó mới là bản đang làm).
  const taskBuilds = tasks
    .map((task) => list.find((item) => isSameResolvedPath(item.fullPath, taskBuildDir(projectRoot, task.options))))
    .filter(Boolean)
    .sort((left, right) => (right.builtAt || 0) - (left.builtAt || 0));
  if (taskBuilds.length) {
    return { relative: taskBuilds[0].relative, fullPath: taskBuilds[0].fullPath, reason: 'task' };
  }
  if (list.length) {
    return { relative: list[0].relative, fullPath: list[0].fullPath, reason: 'newest' };
  }
  const fallback = path.join(projectRoot, 'build', 'web-mobile');
  return { relative: 'build/web-mobile', fullPath: fallback, reason: 'default' };
}

module.exports = {
  isBuildFolder,
  listBuildFolders,
  pickDefaultBuild,
  displayPath,
};
