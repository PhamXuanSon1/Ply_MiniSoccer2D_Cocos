'use strict';

const fs = require('fs/promises');
const path = require('path');

/**
 * Duyệt đệ quy, trả về mọi file thường bên dưới `root`. `root` không tồn tại (dự án chưa có assets/, thư mục
 * vừa bị xoá) thì trả về []; lỗi khác vẫn ném ra.
 */
async function walkFiles(root) {
  const files = [];
  try {
    if (!(await fs.stat(root)).isDirectory()) {
      return files;
    }
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return files;
    }
    throw error;
  }

  // Stat song song trong từng thư mục: dự án vài nghìn file lần đầu (đĩa chưa cache) nhanh hơn nhiều.
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        return;
      }
      if (!entry.isFile()) {
        return;
      }
      const stat = await fs.stat(fullPath);
      files.push({ fullPath, name: entry.name, size: stat.size });
    }));
  }

  await walk(root);
  return files;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (_error) {
    return false;
  }
}

async function isDirectory(targetPath) {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch (_error) {
    return false;
  }
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

/** Đọc tối đa `maxBytes` byte đầu file (đủ cho header ảnh, không nạp cả file vào RAM). */
async function readFileHead(filePath, maxBytes) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isPathInside(candidatePath, parentPath) {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function isSameResolvedPath(leftPath, rightPath) {
  return path.resolve(leftPath).toLowerCase() === path.resolve(rightPath).toLowerCase();
}

function toRelative(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

module.exports = {
  walkFiles,
  pathExists,
  isDirectory,
  readJsonFile,
  readFileHead,
  isPathInside,
  isSameResolvedPath,
  toRelative,
  toPosix,
};
