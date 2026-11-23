'use strict';

/**
 * Chạy được trên dự án khác / máy khác / bản Cocos khác: phiên bản Creator, tính năng của bản đó (caps),
 * chỗ cài extension khác (trong dự án hoặc ~/.CocosCreator/extensions), thư mục tạm của tool.
 * Không phụ thuộc Editor (có thì dùng Editor.App.version), chạy được bằng node thuần.
 *
 * Bản Creator: Editor.App.version (đang chạy) nếu có, không thì creator.version trong package.json của dự án.
 * Tính năng theo bản (đã đối chiếu builtin package của 3.6.0 / 3.8.6 / 3.8.8):
 *   - meshCompress: ô Mesh Compress / Mesh Simplify trong Import Settings của model (MeshCompressOptions,
 *     MeshSimplifyOptions) và module meshopt: có từ 3.8, 3.6 không có.
 *   - triangleCount: 3.8 ghi userData.triangleCount cho mesh con; 3.6 không ghi (đọc từ library/).
 *   - featureCroppingConfigs: Feature Cropping lưu theo modules.configs (3.8); 3.6 / 3.7 lưu định dạng cũ
 *     (modules.cache + includeModules) - tool chỉ đọc, không ghi định dạng đó.
 */

const fs = require('fs');
const path = require('path');

/** Bản thấp nhất tool phân tích được (đọc build, bản xuất, ảnh, audio). Ghi meta / module cần thêm caps. */
const MIN_VERSION = '3.6.0';

function parseVersion(value) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(value || ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
}

/** version >= target (chuỗi "3.8.0"); version không đọc được thì coi như đủ (không chặn nhầm). */
function versionAtLeast(version, target) {
  const left = parseVersion(version);
  const right = parseVersion(target);
  if (!left || !right) {
    return true;
  }
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] > right[index];
    }
  }
  return true;
}

function editorGlobal() {
  try {
    // eslint-disable-next-line no-undef
    return typeof Editor !== 'undefined' ? Editor : null;
  } catch (_error) {
    return null;
  }
}

/** creator.version trong package.json của dự án ('' nếu không đọc được). */
function projectCreatorVersion(projectRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    return String((pkg.creator && pkg.creator.version) || pkg.version || '');
  } catch (_error) {
    return '';
  }
}

/** Bản Creator đang dùng: Editor đang chạy, không thì bản ghi trong dự án. '' nếu không biết. */
function creatorVersion(projectRoot) {
  const editor = editorGlobal();
  const running = editor && editor.App && editor.App.version ? String(editor.App.version) : '';
  return running || (projectRoot ? projectCreatorVersion(projectRoot) : '');
}

/** Tính năng của bản Creator `version` (xem đầu file). */
function capsForVersion(version) {
  const is38 = versionAtLeast(version, '3.8.0');
  return {
    version: version || '',
    supported: versionAtLeast(version, MIN_VERSION),
    meshCompress: is38,
    meshopt: is38,
    triangleCount: is38,
    featureCroppingConfigs: is38,
  };
}

function readCaps(projectRoot) {
  return capsForVersion(creatorVersion(projectRoot));
}

/** Nơi Cocos đọc extension cài cho mọi dự án ("Global" trong Extension Manager). */
function globalExtensionsRoot() {
  try {
    // Nạp os khi cần: lib này cũng được panel / harness thử nghiệm require.
    return path.join(require('os').homedir(), '.CocosCreator', 'extensions');
  } catch (_error) {
    return '';
  }
}

/** Thư mục extension `name`: trong dự án trước, rồi bản cài global. '' nếu không có. */
function findExtensionDir(projectRoot, name) {
  const candidates = [
    projectRoot ? path.join(projectRoot, 'extensions', name) : '',
    globalExtensionsRoot() ? path.join(globalExtensionsRoot(), name) : '',
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (fs.statSync(path.join(dir, 'package.json')).isFile()) {
        return dir;
      }
    } catch (_error) {
      // thử chỗ tiếp theo
    }
  }
  return '';
}

/** package.json của một extension (version, editor...) hoặc null. */
function readExtensionPackage(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (_error) {
    return null;
  }
}

/**
 * Thư mục tạm của tool cho file nháp (job của tiến trình con, nghe thử audio, xem trước model...). Mặc định
 * <project>/temp/playable-size-inspector; biến môi trường PSI_WORK_DIR (cli/selftest.js --work-dir) chuyển sang
 * chỗ khác để chạy thử trên dự án người khác mà không ghi gì vào đó. Lịch sử và bản dự phòng audio luôn ở
 * trong dự án (hoàn tác cần chúng), không đi qua đây.
 */
function workDir(projectRoot, ...parts) {
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  const override = String(env.PSI_WORK_DIR || '').trim();
  const base = override ? path.resolve(override) : path.join(projectRoot, 'temp', 'playable-size-inspector');
  return path.join(base, ...parts);
}

module.exports = {
  MIN_VERSION,
  parseVersion,
  versionAtLeast,
  projectCreatorVersion,
  creatorVersion,
  capsForVersion,
  readCaps,
  globalExtensionsRoot,
  findExtensionDir,
  readExtensionPackage,
  workDir,
};
