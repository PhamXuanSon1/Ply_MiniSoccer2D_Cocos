'use strict';

/**
 * Nén thử ảnh để biết trước dung lượng sau khi Texture Compress, không cần build.
 * Việc nén chạy trong tiến trình con (xem estimate-worker.js).
 */

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { EXTENSION_ROOT, resolveModuleDir } = require('./toolchain');

const WORKER_PATH = path.join(__dirname, 'estimate-worker.js');

/**
 * Nơi có thể chứa `sharp`, ưu tiên bản của Editor vì nó cho ra kết quả trùng byte
 * với Texture Compress thật. `anchor.js` không cần tồn tại - createRequire chỉ dùng
 * nó làm mốc để dò node_modules.
 */
function sharpAnchors() {
  const anchors = [];
  // process.resourcesPath (Electron) đúng trên mọi hệ điều hành: Windows <Editor>/resources,
  // macOS CocosCreator.app/Contents/Resources. Chạy ngoài Editor (node thuần) thì không có.
  if (process.resourcesPath) {
    anchors.push(path.join(process.resourcesPath, 'app.asar', 'node_modules', 'anchor.js'));
    anchors.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'anchor.js'));
  }
  const editorRoot = path.dirname(process.execPath);
  anchors.push(path.join(editorRoot, 'resources', 'app.asar', 'node_modules', 'anchor.js'));
  anchors.push(path.join(editorRoot, 'resources', 'app.asar.unpacked', 'node_modules', 'anchor.js'));
  // macOS: CocosCreator.app/Contents/MacOS/<exe> -> Contents/Resources.
  anchors.push(path.join(editorRoot, '..', 'Resources', 'app.asar', 'node_modules', 'anchor.js'));
  anchors.push(path.join(EXTENSION_ROOT, 'node_modules', 'anchor.js'));
  // sharp trong node_modules của extension khác (playable-ads-builder của dự án / cài global...).
  const sharpDir = resolveModuleDir('sharp');
  if (sharpDir) {
    anchors.push(path.join(path.dirname(sharpDir), 'anchor.js'));
  }
  anchors.push(path.join(EXTENSION_ROOT, '..', 'playable-ads-builder', 'node_modules', 'anchor.js'));
  return [...new Set(anchors.map((anchor) => path.resolve(anchor)))];
}

/** Preset Cocos -> { format, quality } cho platform (web-mobile dùng khoá 'web'). */
function presetToEncodeOptions(preset, platform = 'web') {
  const options = preset && preset.options ? preset.options : {};
  const platformOptions = options[platform] || Object.values(options)[0] || {};
  const [format, config] = Object.entries(platformOptions)[0] || [];
  if (!format) {
    return null;
  }
  return { format: String(format).toLowerCase(), quality: Number(config && config.quality) || 80 };
}

/**
 * Nén thử danh sách ảnh: [{ id, input, format, quality }]; options: { workDir (bắt buộc), timeoutMs }.
 * Trả về { sharpSource, images: { id: { bytes } | { error } } }.
 */
async function estimateSizes(jobs, { workDir, timeoutMs = 10 * 60 * 1000 } = {}) {
  const images = Array.isArray(jobs) ? jobs.filter((job) => job && job.input && job.format) : [];
  if (!images.length) {
    return { sharpSource: '', images: {} };
  }

  return await runWorker(WORKER_PATH, { sharpAnchors: sharpAnchors(), images }, { workDir, timeoutMs });
}

/**
 * Chạy một worker Node (vd estimate-worker.js, html-sim-worker.js) trong tiến trình con bằng chính
 * file chạy của Editor với ELECTRON_RUN_AS_NODE=1 (không cần cài Node riêng). Job / kết quả đi qua
 * file JSON tạm trong `workDir` (bắt buộc, thường là temp/ của project để không ghi vào thư mục tool).
 * Trả về kết quả worker ghi ra.
 */
async function runWorker(workerPath, job, { workDir, timeoutMs = 10 * 60 * 1000 } = {}) {
  if (!workDir) {
    throw new Error('runWorker cần workDir (thư mục tạm cho file job / kết quả).');
  }
  await fs.mkdir(workDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const jobFile = path.join(workDir, `job-${stamp}.json`);
  const resultFile = path.join(workDir, `result-${stamp}.json`);

  try {
    await fs.writeFile(jobFile, JSON.stringify(job), 'utf8');

    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [workerPath, jobFile, resultFile], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
      });
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Tiến trình con chạy quá lâu, đã dừng.'));
      }, timeoutMs);

      child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Tiến trình con thoát với mã ${code}.${stderr ? `\n${stderr.trim()}` : ''}`));
        }
      });
    });

    return JSON.parse(await fs.readFile(resultFile, 'utf8'));
  } finally {
    await fs.rm(jobFile, { force: true }).catch(() => {});
    await fs.rm(resultFile, { force: true }).catch(() => {});
  }
}

module.exports = {
  runWorker,
  sharpAnchors,
  presetToEncodeOptions,
  estimateSizes,
};
