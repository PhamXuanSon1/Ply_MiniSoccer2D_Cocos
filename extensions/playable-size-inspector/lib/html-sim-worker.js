'use strict';

/**
 * Worker mô phỏng playable-ads-builder khi chưa có bản xuất: làm lại đúng các bước của builder
 * (ảnh -> WebP bằng sharp, audio -> MP3 bằng ffmpeg, deflate từng file, base122) để biết mỗi file
 * build chiếm bao nhiêu trong HTML. CHẠY NHƯ NODE THUẦN (ELECTRON_RUN_AS_NODE=1) vì sharp là native
 * addon không nạp được trong process Editor (xem estimate-worker.js).
 *
 * Cách gọi: node html-sim-worker.js <jobFile.json> <resultFile.json>
 *   job:    { buildRoot, compression: { type, quality }, audio: { enabled, bitrate }, ffmpegPath,
 *             sharpAnchors: string[], engineDir, channelSdk, tempDir }
 *   result: { sharpSource, files: [{ path, size, compressedBytes, bytes }], frameBytes, factor, warnings }
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { createRequire } = require('module');
const { base122Length } = require('./html-export');

const EXCLUDE = ['.html', '.css'];
const IMAGE = ['.png', '.jpg', '.jpeg'];
const AUDIO = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];

function loadSharp(anchors) {
  for (const anchor of anchors || []) {
    try {
      const sharp = createRequire(anchor)('sharp');
      // Chạm vào versions để chắc native addon nạp được.
      if (sharp.versions) {
        return { sharp, source: anchor };
      }
    } catch (_error) {
      // thử nơi tiếp theo
    }
  }
  return { sharp: null, source: '' };
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function headerBytes(name) {
  // Header cục bộ (30 + tên) + bản ghi central directory (46 + tên), như adm-zip ghi.
  return 76 + 2 * Buffer.byteLength(name, 'utf8');
}

async function main() {
  const [jobFile, resultFile] = process.argv.slice(2);
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  const warnings = [];
  const { sharp, source } = job.compression.type === 'none' ? { sharp: null, source: '' } : loadSharp(job.sharpAnchors);
  if (job.compression.type !== 'none' && !sharp) {
    warnings.push('Không nạp được sharp: ảnh tính như builder không nén được (số liệu ảnh sẽ to hơn thật).');
  }
  if (job.audio.enabled && !job.ffmpegPath) {
    warnings.push('Không có ffmpeg: audio tính như chưa encode lại.');
  }
  fs.mkdirSync(job.tempDir, { recursive: true });

  const entries = [];
  for (const full of walk(job.buildRoot)) {
    const extension = path.extname(full).toLowerCase();
    if (EXCLUDE.includes(extension)) {
      continue;
    }
    let name = path.relative(job.buildRoot, full).replace(/\\/g, '/');
    let data = fs.readFileSync(full);
    if (IMAGE.includes(extension) && sharp) {
      try {
        const webp = await sharp(data).webp(job.compression.type === 'lossless' ? { lossless: true } : { quality: job.compression.quality }).toBuffer();
        if (webp.length < data.length) {
          data = webp;
        }
      } catch (_error) {
        // builder cũng giữ ảnh gốc khi nén lỗi
      }
    } else if (AUDIO.includes(extension) && job.audio.enabled && job.ffmpegPath) {
      const out = path.join(job.tempDir, `${entries.length}.mp3`);
      try {
        execFileSync(job.ffmpegPath, ['-y', '-v', 'error', '-i', full, '-b:a', `${job.audio.bitrate}k`, '-f', 'mp3', out], { windowsHide: true });
        data = fs.readFileSync(out);
        name = `${name.slice(0, -extension.length)}.mp3`;
      } catch (_error) {
        // builder cũng giữ file gốc khi encode lỗi
      } finally {
        fs.rmSync(out, { force: true });
      }
    }
    entries.push({ path: name, size: data.length, compressed: zlib.deflateRawSync(data) });
  }

  // Phần builder thêm vào zip (khung): BingoEngine.js + SDK của mạng.
  const frameEntries = [];
  for (const [name, file] of [['BingoEngine.js', job.engineDir && path.join(job.engineDir, 'BingoEngine.js')], ['PlayableSDK.js', job.channelSdk]]) {
    if (file && fs.existsSync(file)) {
      frameEntries.push({ path: name, compressed: zlib.deflateRawSync(fs.readFileSync(file)) });
    }
  }
  const all = [...entries, ...frameEntries];
  const factor = base122Length(all.map((entry) => entry.compressed)) / Math.max(1, all.reduce((sum, entry) => sum + entry.compressed.length, 0));
  const files = entries.map((entry) => ({
    path: entry.path,
    size: entry.size,
    compressedBytes: entry.compressed.length,
    bytes: Math.round((entry.compressed.length + headerBytes(entry.path)) * factor),
  }));
  // Khung HTML: index.html + style.css của bản build, thư viện giải nén, launcher (nhúng nguyên văn).
  let frameBytes = Math.round(frameEntries.reduce((sum, entry) => sum + entry.compressed.length + headerBytes(entry.path), 0) * factor);
  for (const file of [
    path.join(job.buildRoot, 'index.html'),
    path.join(job.buildRoot, 'style.css'),
    job.engineDir && path.join(job.engineDir, 'jszip.min.js'),
    job.engineDir && path.join(job.engineDir, 'base122-decode.min.js'),
    job.engineDir && path.join(job.engineDir, 'launcher.js'),
  ]) {
    if (file && fs.existsSync(file)) {
      frameBytes += fs.statSync(file).size;
    }
  }
  fs.writeFileSync(resultFile, JSON.stringify({ sharpSource: source, files, frameBytes, factor, warnings }));
}

main().catch((error) => {
  console.error(error && error.stack || String(error));
  process.exit(1);
});
