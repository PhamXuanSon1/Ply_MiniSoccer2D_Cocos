'use strict';

/**
 * Bật / tắt Texture Compress (Project Settings -> Texture Compress) hàng loạt cho
 * asset ảnh nguồn bằng cách ghi `userData.compressSettings` vào file .meta.
 *
 * Chỉ dùng fs nên chạy được cả trong Editor (main) và ngoài Editor (script terminal).
 * Việc ghi meta qua asset-db được inject từ ngoài (xem applyPlan -> writeMeta).
 */

const fs = require('fs/promises');
const path = require('path');
const { walkFiles, readJsonFile, toPosix } = require('./fs-utils');
const { assetsRoot, fsPathToUrl, toFsPath } = require('./asset-url');

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tga', '.psd'];
/** Các kiểu import ảnh mà Cocos cho phép gắn compressSettings. `raw` bị bỏ qua. */
const COMPRESSIBLE_IMAGE_TYPES = ['sprite-frame', 'texture', 'normal map'];

// ---------------------------------------------------------------- presets

function builderSettingsPath(projectRoot) {
  return path.join(projectRoot, 'settings', 'v2', 'packages', 'builder.json');
}

/** Preset do người dùng tạo trong Project Settings -> Texture Compress. */
async function readPresets(projectRoot) {
  return parsePresets(await readJsonFile(builderSettingsPath(projectRoot)));
}

/**
 * Trả về [{ id, name, formats, options, unconfigured }].
 * Preset đã xoá Cocos để lại thành `null` trong userPreset -> bỏ hẳn (không thì hiện thành preset "ma"
 * mang id thô, có lúc đứng đầu và bị chọn mặc định). Preset có tên nhưng chưa thêm định dạng nào thì
 * vẫn giữ (người dùng vừa tạo) và gắn `unconfigured: true` để panel ghi chú / chặn nút áp.
 */
function parsePresets(json) {
  const userPreset = (json && json.textureCompressConfig && json.textureCompressConfig.userPreset) || {};
  return Object.entries(userPreset)
    .filter(([, preset]) => preset && typeof preset === 'object')
    .map(([id, preset]) => {
      const options = preset.options || {};
      const formats = [];
      for (const platform of Object.keys(options)) {
        for (const format of Object.keys(options[platform] || {})) {
          const config = options[platform][format] || {};
          formats.push(`${platform}:${format}${config.quality !== undefined ? `@${config.quality}` : ''}`);
        }
      }
      return { id, name: preset.name || id, formats, options, unconfigured: !formats.length };
    });
}

/** Tìm preset theo id hoặc tên trong danh sách đã đọc (hàm thuần). */
function findPreset(presets, idOrName) {
  if (!idOrName) {
    return null;
  }
  return (presets || []).find((preset) => preset.id === idOrName || preset.name === idOrName) || null;
}

// ---------------------------------------------------------------- db:// <-> fs

/**
 * Nhận db:// url hoặc đường dẫn fs (file hoặc thư mục) và trả về { url, path } của
 * thư mục. File thì lấy thư mục cha. Trả về null nếu không nằm trong assets.
 */
async function resolveFolder(projectRoot, raw) {
  const value = String(raw || '').trim();
  if (!value) {
    return null;
  }

  let fsPath = toFsPath(projectRoot, value);
  if (!fsPath) {
    return null;
  }

  let stat;
  try {
    stat = await fs.stat(fsPath);
  } catch (_error) {
    return null;
  }
  if (stat.isFile()) {
    fsPath = path.dirname(fsPath);
  }

  const url = fsPathToUrl(projectRoot, fsPath);
  if (!url) {
    return null;
  }
  return { url, path: fsPath };
}

// ---------------------------------------------------------------- scan

function classifyMeta(metaPath, json) {
  if (!json || typeof json !== 'object') {
    return '';
  }
  if (json.importer === 'auto-atlas') {
    return 'auto-atlas';
  }
  if (json.importer !== 'image') {
    return '';
  }
  const assetExtension = path.extname(metaPath.slice(0, -'.meta'.length)).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(assetExtension)) {
    return '';
  }
  const type = String(json.userData && json.userData.type || '');
  return COMPRESSIBLE_IMAGE_TYPES.includes(type) ? type : '';
}

async function readMetaCandidate(metaPath, rootForName) {
  const json = await readJsonFile(metaPath);
  if (!json) {
    return { metaPath, name: path.basename(metaPath), kind: '?', action: 'error', reason: 'không đọc được .meta' };
  }
  const kind = classifyMeta(metaPath, json);
  if (!kind) {
    return null;
  }
  const assetPath = metaPath.slice(0, -'.meta'.length);
  return {
    metaPath,
    assetPath,
    uuid: json.uuid,
    name: rootForName ? toPosix(path.relative(rootForName, assetPath)) : path.basename(assetPath),
    kind,
    current: (json.userData && json.userData.compressSettings) || null,
    action: 'update',
    reason: '',
  };
}

/**
 * Duyệt thư mục, phân loại từng meta theo preset yêu cầu.
 * options: { folder, mode: 'enable'|'disable', presetId, includeAtlas, force }
 * Trả về { folder, mode, preset, includeAtlas, force, rows[] } với action = update | skip | error.
 */
async function buildPlan(projectRoot, options) {
  const settings = options || {};
  const folder = await resolveFolder(projectRoot, settings.folder);
  if (!folder) {
    throw new Error(`Không tìm thấy thư mục trong assets: ${settings.folder || '(trống)'}`);
  }

  const metaFiles = (await walkFiles(folder.path)).filter((file) => file.name.endsWith('.meta'));
  const candidates = [];
  for (const file of metaFiles) {
    const candidate = await readMetaCandidate(file.fullPath, folder.path);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return await planForCandidates(projectRoot, candidates, { ...settings, folder });
}

// ---------------------------------------------------------------- cache nén của Cocos

const COMPRESS_CACHE_DIR = path.join('temp', 'builder', 'CompressTexture');
const COMPRESS_CACHE_INFO = path.join(COMPRESS_CACHE_DIR, 'compress-info.json');

/**
 * Cocos lưu kết quả nén texture thật (lúc build / compress) vào
 * temp/builder/CompressTexture kèm compress-info.json mô tả từng uuid đã nén với
 * option nào. Đọc lại để biết dung lượng sau nén mà không cần build lại.
 *
 * Trả về Map uuid -> { bytes, sourceBytes, dest, extension, options, compressedAt }.
 * Không dùng `option.mtime` để xét cũ/mới: nó là mtime của bản trong library/, mà
 * Cocos ghi lại mỗi lần re-import nên luôn lệch. Nơi gọi so mtime của ảnh nguồn
 * trong assets/ với `compressedAt` thì chính xác hơn.
 */
async function readCompressCache(projectRoot) {
  const info = await readJsonFile(path.join(projectRoot, COMPRESS_CACHE_INFO));
  const cache = new Map();
  if (!info || typeof info !== 'object') {
    return cache;
  }

  for (const [uuid, entry] of Object.entries(info)) {
    const option = entry && entry.option;
    // Preset có cả định dạng native (astc, etc, pvrtc) thì dest liệt kê mọi bản nén: lấy bản web-mobile dùng.
    const dest = entry && Array.isArray(entry.dest) ? webDest(entry.dest) : '';
    if (!option || !dest) {
      continue;
    }
    const destStat = await statOrNull(dest);
    if (!destStat) {
      continue;
    }
    const sourceStat = await statOrNull(option.src);

    cache.set(String(uuid).toLowerCase(), {
      bytes: destStat.size,
      sourceBytes: sourceStat ? sourceStat.size : 0,
      dest,
      extension: path.extname(dest).toLowerCase(),
      options: webOptions(option.compressOptions || {}),
      compressedAt: destStat.mtimeMs,
    });
  }

  return cache;
}

/** Định dạng ảnh web-mobile tải được (khác astc / pkm / pvr của bản native). */
const WEB_FORMATS = ['png', 'jpg', 'jpeg', 'webp'];

/** File nén cho web trong `dest` của compress-info.json: png / jpg / webp đầu tiên, '' nếu không có. */
function webDest(dest) {
  return dest.find((file) => WEB_FORMATS.includes(path.extname(String(file || '')).slice(1).toLowerCase())) || '';
}

/** Phần option nén của định dạng web (bỏ astc_*, etc*, pvrtc_* của bản native). */
function webOptions(options) {
  return Object.fromEntries(Object.entries(options || {}).filter(([format]) => WEB_FORMATS.includes(String(format).toLowerCase())));
}

/**
 * File mà Cocos thực sự đưa vào bộ nén: bản đã import trong library/<xx>/<uuid>.<ext>.
 * Không có thì lùi về file trong assets/ (thường trùng byte).
 */
async function resolveCompressInput(projectRoot, uuid, assetPath) {
  const id = String(uuid || '');
  if (id.length >= 2) {
    const directory = path.join(projectRoot, 'library', id.slice(0, 2));
    const entries = await fs.readdir(directory).catch(() => []);
    const match = entries.find((name) => {
      const extension = path.extname(name).toLowerCase();
      return name.startsWith(id) && !name.includes('@') && IMAGE_EXTENSIONS.includes(extension);
    });
    if (match) {
      return path.join(directory, match);
    }
  }
  return assetPath;
}

async function statOrNull(target) {
  try {
    return target ? await fs.stat(target) : null;
  } catch (_error) {
    return null;
  }
}

/**
 * Cache có phải do đúng preset này sinh ra không. Preset lưu option theo platform
 * (`{ web: { png: { quality: 80 } } }`), còn cache lưu phần đã chọn (`{ png: {...} }`).
 */
function cacheMatchesPreset(cacheOptions, preset) {
  if (!preset || !preset.options) {
    return false;
  }
  // Chỉ so phần định dạng web: cache gộp option của mọi platform (web + android + ios) vào một chỗ.
  const cacheKey = JSON.stringify(webOptions(cacheOptions));
  return Object.values(preset.options).some((platformOptions) => {
    const web = webOptions(platformOptions);
    return Object.keys(web).length > 0 && JSON.stringify(web) === cacheKey;
  });
}

/** Mô tả option nén để hiển thị, ví dụ "png@80". */
function describeCompressOptions(options) {
  const parts = [];
  for (const [format, config] of Object.entries(options || {})) {
    const quality = config && config.quality;
    parts.push(quality === undefined ? format : `${format}@${quality}`);
  }
  return parts.join(', ');
}

/**
 * Tên hiển thị của preset đang gán. Ảnh trỏ tới presetId không còn trong builder.json
 * (preset đã xoá) thì ghi "(preset đã xoá)" thay vì id thô.
 */
function presetLabel(presetId, preset) {
  if (preset) {
    return preset.name;
  }
  return presetId ? '(preset đã xoá)' : '';
}

/**
 * Quét toàn bộ assets/: mọi ảnh có thể gắn Texture Compress + auto-atlas, kèm dung
 * lượng và preset đang dùng. Dùng cho cây thư mục trong panel.
 *
 * `compressed` (số liệu nén thật trong cache của Cocos) CHỈ gắn khi ảnh đang bật nén:
 * Cocos không xoá entry cache khi tắt nén / hoàn tác, nên ảnh đã tắt nén vẫn còn số cũ
 * trong khi build lúc đó chứa ảnh gốc. Ảnh tắt nén luôn có `compressed: null`.
 * `presetMissing`: đang bật nén nhưng preset đã bị xoá khỏi builder.json.
 */
async function scanAllTextures(projectRoot) {
  const root = assetsRoot(projectRoot);
  const files = await walkFiles(root);
  const sizeByPath = new Map(files.map((file) => [file.fullPath.toLowerCase(), file.size]));
  const presets = await readPresets(projectRoot);
  const presetById = new Map(presets.map((preset) => [preset.id, preset]));
  const compressCache = await readCompressCache(projectRoot);
  const rows = [];

  // Chỉ đọc .meta của ảnh / auto-atlas (bỏ qua meta của prefab, script...), đọc song song.
  const metaFiles = files.filter((file) => {
    if (!file.name.endsWith('.meta')) {
      return false;
    }
    const assetExtension = path.extname(file.name.slice(0, -'.meta'.length)).toLowerCase();
    return IMAGE_EXTENSIONS.includes(assetExtension) || assetExtension === '.pac';
  });
  const candidates = await Promise.all(metaFiles.map((file) => readMetaCandidate(file.fullPath, root)));

  for (const candidate of candidates) {
    if (!candidate || candidate.action === 'error') {
      continue;
    }
    const current = candidate.current;
    const enabled = !!(current && current.useCompressTexture);
    const preset = enabled ? presetById.get(current.presetId) || null : null;
    // Tắt nén thì bỏ qua cache (số cũ của lần bật trước), xem comment của hàm.
    const cached = enabled ? compressCache.get(String(candidate.uuid || '').toLowerCase()) || null : null;
    // Ảnh nguồn sửa sau lần nén -> số liệu cache không còn đúng.
    const assetStat = cached ? await statOrNull(candidate.assetPath) : null;
    const stale = !!(cached && assetStat && assetStat.mtimeMs > cached.compressedAt);
    rows.push({
      url: fsPathToUrl(projectRoot, candidate.assetPath),
      relativePath: candidate.name,
      fullPath: candidate.assetPath,
      uuid: candidate.uuid,
      kind: candidate.kind,
      extension: path.extname(candidate.assetPath).toLowerCase(),
      bytes: sizeByPath.get(candidate.assetPath.toLowerCase()) || 0,
      enabled,
      presetId: enabled ? current.presetId || '' : '',
      presetName: enabled ? presetLabel(current.presetId, preset) : '',
      presetMissing: enabled && !preset,
      // Kết quả nén thật Cocos đã tạo (nếu có) - biết được mà không cần build lại.
      compressed: cached ? {
        bytes: cached.bytes,
        sourceBytes: cached.sourceBytes,
        extension: cached.extension,
        optionsLabel: describeCompressOptions(cached.options),
        stale,
        matchesPreset: cacheMatchesPreset(cached.options, preset),
      } : null,
    });
  }

  rows.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { rows, presets };
}

/** Lập plan cho một danh sách asset cụ thể (đường dẫn fs hoặc db:// url). */
async function buildPlanForAssets(projectRoot, assetRefs, options) {
  const candidates = [];
  for (const ref of assetRefs) {
    const fsPath = toFsPath(projectRoot, ref);
    if (!fsPath) {
      continue;
    }
    const candidate = await readMetaCandidate(`${fsPath}.meta`, assetsRoot(projectRoot));
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return await planForCandidates(projectRoot, candidates, { ...(options || {}), folder: null });
}

async function planForCandidates(projectRoot, candidates, settings) {
  const mode = settings.mode === 'disable' ? 'disable' : 'enable';
  const includeAtlas = !!settings.includeAtlas;
  const force = !!settings.force;
  const presets = await readPresets(projectRoot);
  const presetById = new Map(presets.map((preset) => [preset.id, preset]));

  let preset = null;
  if (mode === 'enable') {
    preset = findPreset(presets, settings.presetId);
    if (!preset) {
      throw new Error(`Không tìm thấy preset "${settings.presetId || '(trống)'}". Tạo preset trong Project Settings -> Texture Compress trước.`);
    }
    // Gán preset chưa có định dạng nào thì Cocos không nén gì, nhưng ảnh lại hiện là "đang nén".
    if (preset.unconfigured) {
      throw new Error(`Preset "${preset.name}" chưa cấu hình định dạng nén nào. Thêm định dạng trong Project Settings -> Texture Compress trước.`);
    }
  }

  const rows = [];
  for (const row of candidates) {
    if (row.action === 'error') {
      rows.push(row);
      continue;
    }
    if (row.kind === 'auto-atlas' && !includeAtlas) {
      continue;
    }
    const current = row.current;
    const enabled = !!(current && current.useCompressTexture);
    if (mode === 'disable') {
      if (!enabled) {
        row.action = 'skip';
        row.reason = 'chưa bật nén';
      }
    } else if (enabled && current.presetId === preset.id) {
      row.action = 'skip';
      row.reason = `đã dùng ${preset.name}`;
    } else if (enabled && current.presetId !== preset.id && !force) {
      // Chỉ tới được từ CLI (Editor luôn force). Giữ cụm "preset khác": CLI lọc theo nó.
      const other = presetById.get(current.presetId);
      row.action = 'skip';
      row.reason = `đang dùng preset khác (${other ? other.name : `${current.presetId || '?'}, đã xoá`}) - chạy lại với --force để thay`;
    }
    rows.push(row);
  }
  rows.sort((left, right) => left.name.localeCompare(right.name));

  return { folder: settings.folder || null, mode, preset, includeAtlas, force, rows };
}

// ---------------------------------------------------------------- write

function patchUserData(userData, plan) {
  const data = userData || {};
  if (plan.mode === 'disable') {
    delete data.compressSettings;
  } else {
    data.compressSettings = { useCompressTexture: true, presetId: plan.preset.id };
  }
  return data;
}

/** Ghi thẳng file .meta, giữ nguyên CRLF/LF và newline cuối như Cocos đã ghi. */
async function writeMetaFile(row, plan) {
  const raw = await fs.readFile(row.metaPath, 'utf8');
  const json = JSON.parse(raw);
  json.userData = patchUserData(json.userData, plan);
  const eol = raw.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const trailing = /\r?\n$/.test(raw) ? eol : '';
  await fs.writeFile(row.metaPath, JSON.stringify(json, null, 2).replace(/\n/g, eol) + trailing, 'utf8');
}

/**
 * Áp dụng plan. `writeMeta(row, plan)` do nơi gọi cung cấp (trong Editor: qua asset-db,
 * ngoài Editor: writeMetaFile). Cập nhật row.action = done | error tại chỗ.
 */
async function applyPlan(plan, writeMeta = writeMetaFile) {
  let updated = 0;
  const failed = [];
  for (const row of plan.rows) {
    if (row.action !== 'update') {
      continue;
    }
    try {
      await writeMeta(row, plan);
      row.action = 'done';
      updated += 1;
    } catch (error) {
      row.action = 'error';
      row.reason = error.message || String(error);
      failed.push(`${row.name}: ${row.reason}`);
    }
  }
  return { updated, failed };
}

/** Trạng thái nén hiện tại của một asset ảnh nguồn (cho detail pane). */
async function readAssetCompressState(projectRoot, assetRef) {
  const fsPath = toFsPath(projectRoot, assetRef);
  if (!fsPath) {
    return null;
  }
  const json = await readJsonFile(`${fsPath}.meta`);
  if (!json) {
    return null;
  }
  const kind = classifyMeta(`${fsPath}.meta`, json);
  const current = (json.userData && json.userData.compressSettings) || null;
  const enabled = !!(current && current.useCompressTexture);
  const presets = await readPresets(projectRoot);
  // So đúng id (meta lưu id), không so tên như findPreset.
  const preset = current && current.presetId ? presets.find((item) => item.id === current.presetId) || null : null;
  return {
    assetPath: fsPath,
    metaPath: `${fsPath}.meta`,
    uuid: json.uuid,
    importer: json.importer,
    type: String(json.userData && json.userData.type || ''),
    compressible: !!kind,
    kind,
    enabled,
    presetId: current ? current.presetId || '' : '',
    presetName: presetLabel(current && current.presetId, preset),
    presetMissing: enabled && !preset,
    presets,
  };
}

module.exports = {
  IMAGE_EXTENSIONS,
  COMPRESSIBLE_IMAGE_TYPES,
  readPresets,
  findPreset,
  resolveFolder,
  buildPlan,
  buildPlanForAssets,
  scanAllTextures,
  readCompressCache,
  resolveCompressInput,
  describeCompressOptions,
  patchUserData,
  writeMetaFile,
  applyPlan,
  readAssetCompressState,
};
