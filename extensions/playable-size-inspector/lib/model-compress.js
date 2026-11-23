'use strict';

/**
 * Bước Tối ưu → Model 3D: model nguồn (fbx / gltf / glb) trong assets/, số tam giác, đang bật nén /
 * giảm tam giác gì (userData.meshCompress / meshSimplify trong .meta, đúng các ô của Inspector → Model),
 * và tính userData mới khi đổi các ô đó. main.js ghi qua asset-db (editor tự import lại).
 *
 * Nén mesh của Cocos 3.8 (cocos/3d/assets/mesh.ts):
 *   quantize: lưu đỉnh bằng định dạng ít bit hơn (half float...), GPU đọc thẳng, không cần thêm gì;
 *   encode:   mã hoá bằng meshoptimizer, lúc load phải giải mã => cần module engine `meshopt`
 *             (ẩn trong Feature Cropping); thiếu nó thì mesh lỗi 16352 "decodeVertexBuffer is not a function";
 *   compress: nén zlib cả khối; playable vốn đã zip toàn bộ nên gần như không lợi, còn tốn thời gian load.
 * Mesh Simplify: giảm số tam giác (targetRatio = tỉ lệ giữ lại; autoErrorRate / errorRate / lockBoundary).
 *
 * Panel gửi `settings` theo từng ô giống Inspector: { meshCompress?: { enable?, quantize?, encode?, compress? },
 * meshSimplify?: { enable?, targetRatio?, autoErrorRate?, errorRate?, lockBoundary? } }; ô nào không gửi thì
 * giữ nguyên giá trị riêng của từng model (khi chọn nhiều model đang khác nhau ở ô đó).
 *
 * Hằng số (HEAVY_TRIANGLES, RECOMMENDED_COMPRESS, SIMPLIFY_DEFAULTS) và luật "trong build + cần xử lý"
 * (modelBuildFiles, modelTodos) dùng chung cho tab Model 3D, "Việc nên làm" và cli/selftest.js.
 * Chỉ phụ thuộc node thuần nên panel require thẳng được.
 */

const fs = require('fs/promises');
const path = require('path');
const { walkFiles } = require('./fs-utils');
const { fsPathToUrl } = require('./asset-url');
const { activeConfig } = require('./engine-modules');
const { readCaps } = require('./compat');

const MODEL_EXTENSIONS = new Set(['.fbx', '.gltf', '.glb']);

/** Các ô tool đổi được, đúng tên khoá Cocos ghi trong userData. */
const COMPRESS_KEYS = ['enable', 'quantize', 'encode', 'compress'];
/** Mặc định của Inspector khi một model chưa từng lưu Mesh Simplify. */
const SIMPLIFY_DEFAULTS = { enable: false, targetRatio: 1, autoErrorRate: true, errorRate: 1, lockBoundary: false };
/** "Recommended" cho playable: Quantize + Encode, tắt Compress (zlib thừa vì bản xuất đã zip). */
const RECOMMENDED_COMPRESS = { enable: true, quantize: true, encode: true, compress: false };

/** Tam giác từ mức này trở lên là "nặng" với một vật nhỏ trên màn hình playable. */
const HEAVY_TRIANGLES = 3000;

/** Gợi ý tỉ lệ giữ lại theo số tam giác (người dùng chỉnh lại sau khi xem preview). */
function suggestRatio(triangles) {
  if (triangles >= 8000) return 0.3;
  if (triangles >= 4500) return 0.5;
  if (triangles >= HEAVY_TRIANGLES) return 0.7;
  return 1;
}

/** Đang có hiệu lực (ô con chỉ tính khi Mesh Compress bật) + giá trị thô từng ô (để hiện trong form). */
function compressState(userData) {
  const value = (userData && userData.meshCompress) || {};
  const raw = { enable: !!value.enable, quantize: !!value.quantize, encode: !!value.encode, compress: !!value.compress };
  return {
    enable: raw.enable,
    quantize: raw.enable && raw.quantize,
    encode: raw.enable && raw.encode,
    compress: raw.enable && raw.compress,
    raw,
  };
}

function simplifyState(userData) {
  const value = (userData && userData.meshSimplify) || {};
  return {
    enable: !!value.enable,
    targetRatio: typeof value.targetRatio === 'number' ? value.targetRatio : SIMPLIFY_DEFAULTS.targetRatio,
    autoErrorRate: typeof value.autoErrorRate === 'boolean' ? value.autoErrorRate : SIMPLIFY_DEFAULTS.autoErrorRate,
    errorRate: typeof value.errorRate === 'number' ? value.errorRate : SIMPLIFY_DEFAULTS.errorRate,
    lockBoundary: typeof value.lockBoundary === 'boolean' ? value.lockBoundary : SIMPLIFY_DEFAULTS.lockBoundary,
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (_error) {
    return null;
  }
}

/** Một model nguồn: { uuid, url, assetPath, name, fileBytes, triangles, meshUuids, compress, simplify, suggestRatio } */
/** path -> { key: mtime|size, value } để không đọc lại file model mỗi lần quét. */
const vertexColorCache = new Map();

/**
 * Model có màu đỉnh (vertex color) không: FBX có khối LayerElementColor, glTF / glb có thuộc tính COLOR_0.
 * Cần biết vì Quantize của Cocos 3.8 (meshOptimizer.quantizeMesh) ghi tràn bộ nhớ với mesh có màu đỉnh:
 * import sập "Aborted(native code called abort())" và mesh không vào build.
 */
async function hasVertexColors(assetPath, stat) {
  const key = stat ? `${stat.mtimeMs}|${stat.size}` : '';
  const cached = vertexColorCache.get(assetPath);
  if (cached && key && cached.key === key) {
    return cached.value;
  }
  let value = false;
  try {
    const data = await fs.readFile(assetPath);
    value = path.extname(assetPath).toLowerCase() === '.fbx'
      ? data.indexOf('LayerElementColor') !== -1
      : data.indexOf('"COLOR_0"') !== -1;
  } catch (_error) {
    value = false;
  }
  vertexColorCache.set(assetPath, { key, value });
  return value;
}

/**
 * Số tam giác của một mesh đã import khi .meta không ghi triangleCount (Cocos 3.6): đọc
 * library/<xx>/<uuid>.json, mỗi primitive có indexView.count chỉ số (3 chỉ số một tam giác). 0 nếu không đọc được.
 */
async function libraryTriangleCount(projectRoot, meshUuid) {
  const json = await readJson(path.join(projectRoot, 'library', String(meshUuid).slice(0, 2), `${meshUuid}.json`));
  const primitives = json && json._struct && Array.isArray(json._struct.primitives) ? json._struct.primitives : [];
  return Math.round(primitives.reduce((sum, primitive) => sum + (Number(primitive && primitive.indexView && primitive.indexView.count) || 0), 0) / 3);
}

async function readModel(projectRoot, assetPath, fileBytes, caps) {
  const meta = await readJson(`${assetPath}.meta`);
  if (!meta || !meta.uuid) {
    return null;
  }
  const meshes = await Promise.all(Object.entries(meta.subMetas || {})
    .filter(([, sub]) => sub && sub.importer === 'gltf-mesh')
    .map(async ([key, sub]) => {
      const uuid = sub.uuid || `${meta.uuid}@${key}`;
      const counted = sub.userData && typeof sub.userData.triangleCount === 'number';
      return {
        uuid,
        triangles: counted ? sub.userData.triangleCount : await libraryTriangleCount(projectRoot, uuid),
        // Cocos import lỗi thì ghi imported: false, files: [] cho mesh đó (mesh không có trong library / build).
        failed: sub.imported === false && Array.isArray(sub.files) && sub.files.length === 0,
      };
    }));
  const triangles = meshes.reduce((sum, mesh) => sum + mesh.triangles, 0);
  const stat = await fs.stat(assetPath).catch(() => null);
  return {
    uuid: meta.uuid,
    url: fsPathToUrl(projectRoot, assetPath),
    assetPath,
    name: path.basename(assetPath),
    fileBytes,
    triangles,
    meshUuids: meshes.map((mesh) => mesh.uuid),
    compress: compressState(meta.userData),
    simplify: simplifyState(meta.userData),
    suggestRatio: suggestRatio(triangles),
    vertexColors: await hasVertexColors(assetPath, stat),
    /** uuid các mesh Cocos import lỗi (rỗng = ổn). */
    importFailed: meshes.filter((mesh) => mesh.failed).map((mesh) => mesh.uuid),
    /** Bản Creator này có ô Mesh Compress / Mesh Simplify không (3.8 trở lên): false thì không gợi ý nén / giảm tam giác. */
    canCompress: !caps || caps.meshCompress !== false,
  };
}

/**
 * Mọi model nguồn trong assets/ (không đọc nội dung model, chỉ .meta). `caps` (lib/compat.js readCaps): mặc định
 * đọc theo bản Creator của dự án.
 */
async function scanModels(projectRoot, { caps = readCaps(projectRoot) } = {}) {
  const files = await walkFiles(path.join(projectRoot, 'assets'));
  const models = await Promise.all(files
    .filter((file) => MODEL_EXTENSIONS.has(path.extname(file.name).toLowerCase()))
    .map((file) => readModel(projectRoot, file.fullPath, file.size, caps)));
  return models.filter(Boolean).sort((left, right) => right.triangles - left.triangles);
}

function clamp01(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

/** Chỉ giữ các ô hợp lệ của `settings` (kiểu đúng, ratio trong 0..1). Trả về null nếu không còn ô nào. */
function normalizeSettings(settings) {
  const out = {};
  const compress = settings && settings.meshCompress;
  if (compress && typeof compress === 'object') {
    const value = {};
    for (const key of COMPRESS_KEYS) {
      if (typeof compress[key] === 'boolean') value[key] = compress[key];
    }
    if (Object.keys(value).length) out.meshCompress = value;
  }
  const simplify = settings && settings.meshSimplify;
  if (simplify && typeof simplify === 'object') {
    const value = {};
    for (const key of ['enable', 'autoErrorRate', 'lockBoundary']) {
      if (typeof simplify[key] === 'boolean') value[key] = simplify[key];
    }
    if (simplify.targetRatio !== undefined && simplify.targetRatio !== null) value.targetRatio = Math.max(0.01, clamp01(simplify.targetRatio, 1));
    if (simplify.errorRate !== undefined && simplify.errorRate !== null) value.errorRate = clamp01(simplify.errorRate, 1);
    if (Object.keys(value).length) out.meshSimplify = value;
  }
  return Object.keys(out).length ? out : null;
}

/** userData sau khi áp `settings` (chỉ các ô được gửi; ô khác của model giữ nguyên). */
function patchUserData(userData, settings) {
  const next = { ...(userData || {}) };
  const clean = normalizeSettings(settings);
  if (!clean) {
    return next;
  }
  if (clean.meshCompress) {
    next.meshCompress = { enable: false, quantize: false, encode: false, compress: false, ...(next.meshCompress || {}), ...clean.meshCompress };
  }
  if (clean.meshSimplify) {
    next.meshSimplify = { ...SIMPLIFY_DEFAULTS, ...(next.meshSimplify || {}), ...clean.meshSimplify };
  }
  return next;
}

function onOff(value) {
  return value ? 'on' : 'off';
}

/** Mô tả ngắn các ô đổi, theo tên ô của Inspector (tiêu đề lịch sử). */
function describeSettings(settings) {
  const clean = normalizeSettings(settings) || {};
  const parts = [];
  const c = clean.meshCompress;
  if (c) {
    const subs = ['quantize', 'encode', 'compress'].filter((key) => key in c).map((key) => `${key[0].toUpperCase()}${key.slice(1)} ${onOff(c[key])}`);
    parts.push(c.enable === false ? 'Mesh Compress off' : `Mesh Compress${c.enable ? ' on' : ''}${subs.length ? ` (${subs.join(', ')})` : ''}`);
  }
  const s = clean.meshSimplify;
  if (s) {
    const subs = [
      s.targetRatio !== undefined ? `Target Ratio ${s.targetRatio}` : '',
      s.autoErrorRate !== undefined ? `Auto Error Rate ${onOff(s.autoErrorRate)}` : '',
      s.errorRate !== undefined ? `Error Rate ${s.errorRate}` : '',
      s.lockBoundary !== undefined ? `Lock Boundary ${onOff(s.lockBoundary)}` : '',
    ].filter(Boolean);
    parts.push(s.enable === false ? 'Mesh Simplify off' : `Mesh Simplify${s.enable ? ' on' : ''}${subs.length ? ` (${subs.join(', ')})` : ''}`);
  }
  return parts.join(' · ');
}

/** Phần userData tool có thể đổi, để ghi lịch sử / so xung đột. */
function snapshot(userData) {
  return {
    meshCompress: userData && userData.meshCompress ? { ...userData.meshCompress } : null,
    meshSimplify: userData && userData.meshSimplify ? { ...userData.meshSimplify } : null,
  };
}

/** userData này có mesh Encode (cần module meshopt lúc chạy). */
function usesEncode(userData) {
  return compressState(userData).encode;
}

// ---------------------------------------------------------------- model trong bản build

/**
 * File mesh của model trong bản build (`assetRows` của build-scan.scanBuild): tên file là
 * <uuid model>@<sub>.bin (MD5 Cache chèn thêm .<md5> trước đuôi) hoặc uuid của một mesh con.
 */
function modelBuildFiles(model, assetRows) {
  const uuid = String(model.uuid || '').toLowerCase();
  const subs = new Set((model.meshUuids || []).map((item) => String(item).toLowerCase()));
  return (assetRows || []).filter((row) => {
    if (row.extension !== '.bin') {
      return false;
    }
    const base = path.basename(row.relativePath).replace(/\.bin$/i, '').split('.')[0].toLowerCase();
    return base.split('@')[0] === uuid || subs.has(base);
  });
}

/** Mesh Simplify thật sự bỏ bớt tam giác (bật với Target Ratio 1 thì chưa giảm gì). */
function simplifies(model) {
  return !!model.simplify.enable && model.simplify.targetRatio < 1;
}

/**
 * Việc nên làm của một model, dạng khoá trung tính (panel / insights tự đặt chữ):
 *   'uncompressed': chưa nén mesh (Quantize chưa có hiệu lực);
 *   'heavy':        từ HEAVY_TRIANGLES tam giác mà Mesh Simplify chưa giảm gì.
 * Model không có trong bản build thì không cần làm gì: [].
 */
/** Mesh đã nén: có Quantize; model có màu đỉnh không Quantize được (Cocos lỗi) thì Encode là đủ. */
function isMeshCompressed(model) {
  return !!model.compress.quantize || (!!model.vertexColors && !!model.compress.encode);
}

function modelTodos(model, inBuild) {
  const todos = [];
  if (model.importFailed && model.importFailed.length) {
    todos.push('import-failed');
  }
  // Bản Creator chưa có Mesh Compress / Mesh Simplify (3.6): không có việc gì tool hay Inspector làm được.
  if (!inBuild || model.canCompress === false) {
    return todos;
  }
  if (!isMeshCompressed(model)) {
    todos.push('uncompressed');
  }
  if (model.triangles >= HEAVY_TRIANGLES && !simplifies(model)) {
    todos.push('heavy');
  }
  return todos;
}

// ---------------------------------------------------------------- module meshopt

/** meshopt có vào build không: { known, enabled }. known = false khi dự án chưa lưu Feature Cropping. */
function meshoptState(modules) {
  const config = activeConfig(modules);
  if (!config) {
    return { known: false, enabled: false };
  }
  const cached = config.cache && config.cache.meshopt ? !!config.cache.meshopt._value : false;
  const included = Array.isArray(config.includeModules) && config.includeModules.includes('meshopt');
  return { known: true, enabled: cached && included };
}

/** Bản sao `modules` đã bật meshopt (đúng hai chỗ Feature Cropping ghi). null nếu không sửa được. */
function enableMeshopt(modules) {
  const next = JSON.parse(JSON.stringify(modules || {}));
  const config = activeConfig(next);
  if (!config) {
    return null;
  }
  config.cache = config.cache || {};
  config.cache.meshopt = { ...(config.cache.meshopt || {}), _value: true };
  config.includeModules = Array.isArray(config.includeModules) ? config.includeModules : [];
  if (!config.includeModules.includes('meshopt')) {
    config.includeModules.push('meshopt');
    config.includeModules.sort();
  }
  return next;
}

/** Bản sao `modules` đã tắt meshopt (ngược enableMeshopt). null nếu không sửa được. */
function disableMeshopt(modules) {
  const next = JSON.parse(JSON.stringify(modules || {}));
  const config = activeConfig(next);
  if (!config) {
    return null;
  }
  config.cache = config.cache || {};
  config.cache.meshopt = { ...(config.cache.meshopt || {}), _value: false };
  config.includeModules = (Array.isArray(config.includeModules) ? config.includeModules : []).filter((name) => name !== 'meshopt');
  return next;
}

module.exports = {
  HEAVY_TRIANGLES,
  RECOMMENDED_COMPRESS,
  SIMPLIFY_DEFAULTS,
  suggestRatio,
  scanModels,
  normalizeSettings,
  patchUserData,
  describeSettings,
  snapshot,
  usesEncode,
  modelBuildFiles,
  simplifies,
  modelTodos,
  isMeshCompressed,
  hasVertexColors,
  meshoptState,
  enableMeshopt,
  disableMeshopt,
};
