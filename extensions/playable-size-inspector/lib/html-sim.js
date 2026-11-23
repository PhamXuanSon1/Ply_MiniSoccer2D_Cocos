'use strict';

/**
 * Ước tính bản HTML cuối khi chưa xuất: chạy html-sim-worker.js (mô phỏng đúng các bước của
 * playable-ads-builder) với cấu hình nén của build task. Dùng sharp của chính builder trước
 * (cùng phiên bản nên khớp từng byte), không có thì sharp của Editor (ảnh có thể lệch chút ít).
 */

const fs = require('fs');
const path = require('path');
const { runWorker, sharpAnchors } = require('./estimate');
const { resolveFfmpegPath } = require('./toolchain');
const { findExtensionDir, workDir } = require('./compat');

const WORKER_PATH = path.join(__dirname, 'html-sim-worker.js');
/** Cấu hình mặc định của playable-ads-builder (source/builder.ts). */
const DEFAULT_COMPRESSION = { type: 'lossy', quality: 80 };
const DEFAULT_AUDIO = { enabled: true, bitrate: 64 };

/**
 * { projectRoot, buildRoot, compression?, audio?, channel? } ->
 * { files, frameBytes, totalBytes, factor, warnings, sharpSource, estimated: true }
 * (+ file: '' và frameFiles: [] để cùng dạng với html-export.readExportBreakdown).
 */
async function simulateExport({ projectRoot, buildRoot, compression, audio, channel = 'AppLovin' }) {
  // playable-ads-builder trong dự án, hoặc bản cài global (~/.CocosCreator/extensions).
  const builderDir = findExtensionDir(projectRoot, 'playable-ads-builder') || path.join(projectRoot, 'extensions', 'playable-ads-builder');
  const engineDir = path.join(builderDir, 'playable-engine');
  const builderModules = path.join(builderDir, 'node_modules', 'anchor.js');
  let ffmpegPath = '';
  try {
    ffmpegPath = resolveFfmpegPath();
  } catch (_error) {
    ffmpegPath = '';
  }
  const result = await runWorker(WORKER_PATH, {
    buildRoot,
    compression: { ...DEFAULT_COMPRESSION, ...(compression || {}) },
    audio: { ...DEFAULT_AUDIO, ...(audio || {}) },
    ffmpegPath,
    sharpAnchors: [builderModules, ...sharpAnchors()],
    engineDir: fs.existsSync(engineDir) ? engineDir : '',
    channelSdk: path.join(engineDir, 'channels', `${channel}.js`),
    tempDir: workDir(projectRoot, 'html-sim'),
  }, { workDir: workDir(projectRoot, 'html-sim') });
  const fromBuild = result.files.reduce((sum, item) => sum + item.bytes, 0);
  return {
    ...result,
    file: '',
    totalBytes: fromBuild + result.frameBytes,
    frameFiles: [],
    estimated: true,
  };
}

module.exports = {
  DEFAULT_COMPRESSION,
  DEFAULT_AUDIO,
  simulateExport,
};
