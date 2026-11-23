'use strict';

/**
 * Lịch sử thay đổi tool đã ghi vào dự án để hoàn tác được: bật / tắt nén ảnh, nén / chuyển / cắt
 * audio, Mesh Compress / Mesh Simplify của model 3D, bật / tắt module engine (cả meshopt) trong
 * Feature Cropping. Lưu ở temp/playable-size-inspector/history.json (không vào git).
 *
 * Mỗi mục: { id, at, kind: 'texture' | 'audio' | 'model' | 'engine-modules', title, detail, items,
 *            undone, undoneAt }.
 *   texture item: { url, uuid, before, after }  (before / after: userData.compressSettings hoặc null)
 *   audio item:   { relativePath, targetRelativePath, changedExtension, replacedExistingMp3,
 *                   backupDir (tương đối project), afterBytes, afterMtimeMs }
 *   model item:   { url, uuid, before, after }  (before / after: model-compress.snapshot -
 *                   { meshCompress, meshSimplify } của userData)
 *   engine-modules: không có items; mục mang { before, after } là cả khối modules của
 *                   settings/v2/packages/engine.json (bật / tắt meshopt cũng ghi kiểu này).
 *
 * Phần audio hoàn tác bằng fs ngay ở đây; texture / model cần asset-db và engine-modules cần
 * Editor.Profile nên do main.js làm.
 */

const fs = require('fs/promises');
const path = require('path');
const { readJsonFile, pathExists, walkFiles } = require('./fs-utils');

const MAX_ENTRIES = 50;
/** Dọn bản dự phòng audio thì mặc định giữ lại chừng này lần gần nhất. */
const KEEP_BACKUPS = 5;

function historyPath(projectRoot) {
  return path.join(projectRoot, 'temp', 'playable-size-inspector', 'history.json');
}

async function readHistory(projectRoot) {
  const json = await readJsonFile(historyPath(projectRoot));
  return json && Array.isArray(json.entries) ? json.entries : [];
}

async function writeHistory(projectRoot, entries) {
  const target = historyPath(projectRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify({ entries: entries.slice(-MAX_ENTRIES) }, null, 1), 'utf8');
}

/** Thêm một mục, trả về mục đã có id. */
async function appendHistory(projectRoot, entry) {
  const entries = await readHistory(projectRoot);
  const full = {
    id: `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    undone: false,
    ...entry,
  };
  entries.push(full);
  await writeHistory(projectRoot, entries);
  return full;
}

async function markUndone(projectRoot, id) {
  const entries = await readHistory(projectRoot);
  const entry = entries.find((item) => item.id === id);
  if (entry) {
    entry.undone = true;
    entry.undoneAt = new Date().toISOString();
    await writeHistory(projectRoot, entries);
  }
  return entry || null;
}

async function statOrNull(target) {
  try {
    return await fs.stat(target);
  } catch (_error) {
    return null;
  }
}

/**
 * File audio tool đã ghi có bị sửa tiếp sau đó không (dung lượng / thời điểm khác lúc ghi).
 * Trả về danh sách mô tả xung đột; rỗng là an toàn để khôi phục.
 */
async function findAudioConflicts(projectRoot, entry) {
  const assets = path.join(projectRoot, 'assets');
  const conflicts = [];
  for (const item of entry.items) {
    const current = await statOrNull(path.join(assets, item.targetRelativePath));
    if (!current) {
      conflicts.push(`${item.targetRelativePath}: không còn file`);
    } else if (current.size !== item.afterBytes || Math.abs(current.mtimeMs - item.afterMtimeMs) > 2000) {
      conflicts.push(`${item.targetRelativePath}: đã bị sửa sau lần nén này`);
    }
    if (!await pathExists(path.join(projectRoot, item.backupDir, item.relativePath))) {
      conflicts.push(`${item.relativePath}: mất bản dự phòng trong ${item.backupDir}`);
    }
  }
  return conflicts;
}

/**
 * Tên đang có trên đĩa của `target` nếu chỉ khác chữ hoa / thường (vd tool cũ đã ghi .MP3 thành .mp3): ghi đè đúng
 * tên đó, không đổi hoa / thường, vì asset-db coi đổi hoa / thường là asset mới (uuid mới).
 */
async function existingCase(target) {
  const entries = await fs.readdir(path.dirname(target)).catch(() => []);
  const wanted = path.basename(target).toLowerCase();
  const hit = entries.find((name) => name.toLowerCase() === wanted);
  return hit ? path.join(path.dirname(target), hit) : target;
}

async function copyWithMeta(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  const file = await existingCase(to);
  await fs.copyFile(from, file);
  if (await pathExists(`${from}.meta`)) {
    await fs.copyFile(`${from}.meta`, await existingCase(`${file}.meta`));
  }
}

/**
 * Trả audio về như trước lần nén: chép file gốc + .meta từ bản dự phòng. Đổi đuôi (wav -> mp3)
 * thì xoá MP3 mới (meta của nó chính là meta gốc đã đổi tên) và trả lại MP3 trùng tên đã bị
 * ghi đè nếu có. Trả về { restored, errors, folders } (folders: thư mục cần refresh asset-db).
 */
async function undoAudio(projectRoot, entry, options = {}) {
  const assets = path.join(projectRoot, 'assets');
  const folders = new Set();
  const errors = [];
  /** { path, uuid }: file đã trả về + uuid đúng ra (theo .meta dự phòng) để main.js kiểm tra sau refresh. */
  const checks = [];
  let restored = 0;
  const backupUuid = async (file) => {
    try {
      return String(JSON.parse(await fs.readFile(`${file}.meta`, 'utf8')).uuid || '');
    } catch (_error) {
      return '';
    }
  };
  for (const item of entry.items) {
    try {
      const backupRoot = path.join(projectRoot, item.backupDir);
      const targetPath = path.join(assets, item.targetRelativePath);
      const sourcePath = path.join(assets, item.relativePath);
      const sourceBackup = path.join(backupRoot, item.relativePath);
      if (item.changedExtension) {
        // Ưu tiên nhờ asset-db đổi tên mp3 -> tên gốc (giữ uuid), rồi chép nội dung + meta gốc lên.
        const moved = options.renameAsset && await pathExists(targetPath)
          ? await options.renameAsset(targetPath, sourcePath).catch(() => false) && await pathExists(sourcePath) && !await pathExists(targetPath)
          : false;
        // Trả file gốc về TRƯỚC, chỉ xoá MP3 sau khi đã chép xong: lỗi giữa chừng không làm mất cả hai.
        await copyWithMeta(sourceBackup, sourcePath);
        if (!moved) {
          await fs.rm(targetPath, { force: true });
          await fs.rm(`${targetPath}.meta`, { force: true });
        }
        if (item.replacedExistingMp3) {
          const replacedBackup = path.join(backupRoot, item.targetRelativePath);
          await copyWithMeta(replacedBackup, targetPath);
          checks.push({ path: targetPath, uuid: await backupUuid(replacedBackup) });
        }
      } else {
        await copyWithMeta(sourceBackup, sourcePath);
      }
      checks.push({ path: await existingCase(sourcePath), uuid: await backupUuid(sourceBackup) });
      folders.add(path.dirname(sourcePath));
      restored += 1;
    } catch (error) {
      errors.push(`${item.relativePath}: ${error.message || error}`);
    }
  }
  return { restored, errors, folders: [...folders], checks: checks.filter((check) => check.uuid) };
}

// ---------------------------------------------------------------- bản dự phòng audio

function backupRoot(projectRoot) {
  return path.join(projectRoot, 'temp', 'playable-size-inspector', 'audio-backup');
}

/**
 * Các lần dự phòng audio (mỗi lần nén / chuyển / cắt một thư mục <thời điểm>), mới nhất trước:
 * [{ name, relative, files, bytes, usedBy: [id mục lịch sử còn hoàn tác được nhờ nó] }].
 */
async function listAudioBackups(projectRoot) {
  const root = backupRoot(projectRoot);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const history = await readHistory(projectRoot);
  const backups = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(root, entry.name);
    const relative = path.relative(projectRoot, dir).replace(/\\/g, '/');
    const files = await walkFiles(dir).catch(() => []);
    backups.push({
      name: entry.name,
      relative,
      files: files.filter((file) => !file.name.endsWith('.meta')).length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      usedBy: history
        .filter((item) => item.kind === 'audio' && !item.undone && item.items.some((audioItem) => audioItem.backupDir === relative))
        .map((item) => item.id),
    });
  }
  // Tên thư mục là thời điểm (20261009-105349) nên xếp theo tên là xếp theo thời gian.
  return backups.sort((left, right) => right.name.localeCompare(left.name));
}

/** Xoá các lần dự phòng cũ, giữ `keep` lần gần nhất. Lần bị xoá thì không hoàn tác được nữa. */
async function cleanAudioBackups(projectRoot, { keep = KEEP_BACKUPS } = {}) {
  const backups = await listAudioBackups(projectRoot);
  const removed = backups.slice(Math.max(0, keep));
  for (const backup of removed) {
    await fs.rm(path.join(projectRoot, backup.relative), { recursive: true, force: true });
  }
  return { removed: removed.length, bytes: removed.reduce((sum, backup) => sum + backup.bytes, 0) };
}

/** Mục audio chưa hoàn tác mà bản dự phòng không còn (đã dọn / bị xoá tay): không hoàn tác được. */
async function markMissingBackups(projectRoot, entries) {
  for (const entry of entries) {
    if (entry.kind !== 'audio' || entry.undone) {
      continue;
    }
    const first = entry.items[0];
    entry.backupMissing = !first || !await pathExists(path.join(projectRoot, first.backupDir, first.relativePath));
  }
  return entries;
}

module.exports = {
  KEEP_BACKUPS,
  readHistory,
  appendHistory,
  markUndone,
  findAudioConflicts,
  undoAudio,
  listAudioBackups,
  cleanAudioBackups,
  markMissingBackups,
};
