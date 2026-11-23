'use strict';

/**
 * Thao tác audio bằng ffmpeg (ffmpeg-static, không cần ffprobe):
 *   - probeAudio: đọc thông tin (thời lượng, bitrate, codec, sample rate, số kênh)
 *     bằng cách parse stderr của `ffmpeg -i`.
 *   - encodeAudio: encode sang MP3 (libmp3lame) với bitrate / mono / sample rate tuỳ chọn,
 *     có thể cắt bớt đầu / cuối kèm fade (normalizeTrim).
 *   - previewEncode: encode thử vào temp/ để nghe và xem dung lượng trước khi thay file thật.
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { resolveFfmpegPath } = require('./toolchain');
const { walkFiles, pathExists, toPosix } = require('./fs-utils');
const { assetsRoot, fsPathToUrl, toFsPath } = require('./asset-url');
const { workDir: toolWorkDir } = require('./compat');

const SOURCE_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma'];

/**
 * Đường dẫn MP3 đích của một audio nguồn. Đã là mp3 (kể cả đuôi viết hoa `.MP3`) thì ghi đè đúng file gốc, giữ nguyên
 * tên: đổi `.MP3` -> `.mp3` thì Windows coi là cùng file nhưng asset-db của Cocos coi là asset mới (uuid mới, xoá meta
 * cũ) và scene / prefab mất tham chiếu.
 */
function mp3TargetPath(sourcePath, extension) {
  return extension === '.mp3' ? sourcePath : `${sourcePath.slice(0, -extension.length)}.mp3`;
}

// Nguồn DUY NHẤT của các hằng số audio: panel (audio-tab, audio-player) và insights import từ đây,
// không giữ bản sao riêng. Module chỉ require node built-in + lib nên nạp được cả trong panel.
/** Các mức bitrate cho ô chọn trong panel. */
const BITRATE_OPTIONS_KBPS = [48, 64, 96, 128, 192];
/** Khớp với bitrate playable-ads-builder dùng khi export; cao hơn chỉ phình build. */
const DEFAULT_BITRATE_KBPS = 64;
const MIN_BITRATE_KBPS = 24;
const MAX_BITRATE_KBPS = 320;
const CHANNEL_LAYOUTS = { mono: 1, stereo: 2, quad: 4, '5.1': 6, '7.1': 8 };
/** Đoạn giữ lại ngắn nhất khi cắt (giây). */
const MIN_TRIM_SECONDS = 0.05;
/** Lệch nhỏ hơn mức này ở hai đầu thì coi như không cắt (giây). */
const TRIM_EPSILON = 0.0005;

function runFfmpeg(args, { cwd } = {}) {
  const ffmpegPath = resolveFfmpegPath();
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-hide_banner', ...args], {
      cwd: cwd || path.dirname(ffmpegPath),
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? Number(error.code) || 1 : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error,
      });
    });
  });
}

/** Parse các dòng `Duration:` và `Stream #0:0: Audio:` trong stderr của ffmpeg. */
function parseProbeOutput(stderr) {
  const info = {
    durationSeconds: 0,
    bitRateKbps: 0,
    codecName: '',
    sampleRate: 0,
    channels: 0,
    channelLayout: '',
  };

  const duration = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (duration) {
    info.durationSeconds = roundNumber(Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]), 3);
  }
  const containerBitrate = stderr.match(/Duration:[^\n]*bitrate:\s*(\d+)\s*kb\/s/);
  if (containerBitrate) {
    info.bitRateKbps = Number(containerBitrate[1]);
  }

  const stream = stderr.match(/Stream #\d+:\d+[^\n]*?:\s*Audio:\s*([^\n]+)/);
  if (stream) {
    const parts = stream[1].split(',').map((part) => part.trim());
    info.codecName = String(parts[0] || '').split(/[\s(]/)[0].toLowerCase();
    for (const part of parts.slice(1)) {
      const hz = part.match(/^(\d+)\s*Hz$/);
      if (hz) {
        info.sampleRate = Number(hz[1]);
        continue;
      }
      const kbps = part.match(/^(\d+)\s*kb\/s/);
      if (kbps) {
        info.bitRateKbps = Number(kbps[1]) || info.bitRateKbps;
        continue;
      }
      const layout = part.toLowerCase();
      if (CHANNEL_LAYOUTS[layout]) {
        info.channels = CHANNEL_LAYOUTS[layout];
        info.channelLayout = layout;
        continue;
      }
      const channels = layout.match(/^(\d+)\s*channels?$/);
      if (channels) {
        info.channels = Number(channels[1]);
        info.channelLayout = layout;
      }
    }
  }

  return info;
}

async function probeAudio(filePath) {
  const stat = await fs.stat(filePath);
  // `ffmpeg -i` không có output sẽ thoát mã 1 nhưng vẫn in thông tin stream ra stderr.
  const result = await runFfmpeg(['-i', filePath]);
  const info = parseProbeOutput(result.stderr);
  if (!info.codecName) {
    const reason = result.stderr.trim().split('\n').pop() || 'không đọc được thông tin audio';
    throw new Error(`ffmpeg không đọc được ${path.basename(filePath)}: ${reason}`);
  }
  return { ...info, bytes: stat.size, extension: path.extname(filePath).toLowerCase() };
}

function clampBitrate(value, fallback = DEFAULT_BITRATE_KBPS) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.max(MIN_BITRATE_KBPS, Math.min(MAX_BITRATE_KBPS, Math.round(numeric)));
}

function finiteOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * Chuẩn hoá yêu cầu cắt { start, end, fadeIn, fadeOut } (giây) theo thời lượng thật của file:
 * kẹp vào [0, duration], fade vào + fade ra không dài hơn đoạn giữ lại. Trả về null khi không
 * cắt và không fade gì (encode như cũ). Đoạn còn lại quá ngắn thì ném lỗi.
 */
function normalizeTrim(trim, durationSeconds) {
  if (!trim || typeof trim !== 'object') {
    return null;
  }
  const duration = Number(durationSeconds);
  if (!(duration > 0)) {
    throw new Error('Không đọc được thời lượng audio nên không cắt được.');
  }
  const start = Math.min(duration, Math.max(0, finiteOr(trim.start, 0)));
  const end = Math.min(duration, Math.max(0, finiteOr(trim.end, duration)));
  if (end - start < MIN_TRIM_SECONDS) {
    throw new Error(`Đoạn giữ lại quá ngắn (tối thiểu ${MIN_TRIM_SECONDS} s).`);
  }
  const length = end - start;
  let fadeIn = Math.max(0, finiteOr(trim.fadeIn, 0));
  let fadeOut = Math.max(0, finiteOr(trim.fadeOut, 0));
  if (fadeIn + fadeOut > length) {
    const scale = length / (fadeIn + fadeOut);
    fadeIn *= scale;
    fadeOut *= scale;
  }
  const cutStart = start > TRIM_EPSILON;
  const cutEnd = end < duration - TRIM_EPSILON;
  if (!cutStart && !cutEnd && !(fadeIn > 0) && !(fadeOut > 0)) {
    return null;
  }
  return {
    start: roundNumber(start, 4),
    end: roundNumber(end, 4),
    length: roundNumber(length, 4),
    fadeIn: roundNumber(fadeIn, 4),
    fadeOut: roundNumber(fadeOut, 4),
    cutStart,
    cutEnd,
    duration: roundNumber(duration, 4),
  };
}

/**
 * Bộ lọc ffmpeg cho một đoạn cắt (đã normalizeTrim): atrim cắt đúng từng mẫu (chính xác hơn
 * -ss / -to), afade tuyến tính giống hệt bản nghe thử trong panel.
 */
function trimFilters(trim) {
  if (!trim) {
    return [];
  }
  const num = (value) => String(roundNumber(value, 4));
  const filters = [];
  if (trim.cutStart || trim.cutEnd) {
    filters.push(`atrim=start=${num(trim.start)}${trim.cutEnd ? `:end=${num(trim.end)}` : ''}`, 'asetpts=PTS-STARTPTS');
  }
  if (trim.fadeIn > 0) {
    filters.push(`afade=t=in:st=0:d=${num(trim.fadeIn)}`);
  }
  if (trim.fadeOut > 0) {
    filters.push(`afade=t=out:st=${num(trim.length - trim.fadeOut)}:d=${num(trim.fadeOut)}`);
  }
  return filters;
}

/**
 * Encode `inputPath` sang MP3 tại `outputPath` (ghi đè nếu có). `trim` là kết quả của
 * normalizeTrim (null = giữ cả file).
 * Trả về { beforeBytes, afterBytes, bitrateKbps, mono, sampleRate, trim }.
 */
async function encodeAudio({ inputPath, outputPath, bitrateKbps, mono = false, sampleRate = 0, trim = null }) {
  const bitrate = clampBitrate(bitrateKbps);
  const beforeBytes = (await fs.stat(inputPath)).size;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const args = [
    '-y',
    '-loglevel', 'error',
    '-i', inputPath,
    '-vn',
    '-map_metadata', '-1',
  ];
  const filters = trimFilters(trim);
  if (filters.length) {
    args.push('-af', filters.join(','));
  }
  args.push('-c:a', 'libmp3lame', '-b:a', `${bitrate}k`);
  if (mono) {
    args.push('-ac', '1');
  }
  if (Number(sampleRate) > 0) {
    args.push('-ar', String(Math.round(Number(sampleRate))));
  }
  args.push(outputPath);

  const result = await runFfmpeg(args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || (result.error && result.error.message) || `ffmpeg thoát mã ${result.code}`);
  }

  const afterBytes = (await fs.stat(outputPath)).size;
  if (!afterBytes) {
    await fs.rm(outputPath, { force: true });
    throw new Error('ffmpeg tạo ra file MP3 rỗng.');
  }

  return { beforeBytes, afterBytes, bitrateKbps: bitrate, mono: !!mono, sampleRate: Number(sampleRate) || 0, trim: trim || null };
}

function roundNumber(value, digits) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// Cấu hình nén audio của build task (playable-ads-builder): lib/exports.js readBuilderAudio.

// ---------------------------------------------------------------- audio nguồn trong assets/

/**
 * Liệt kê mọi audio nguồn trong <project>/assets (gồm cả .mp3 để nén lại) kèm thông
 * tin probe. Probe chạy song song theo lô để không quá chậm với nhiều file.
 */
async function scanSourceAudio(projectRoot, { concurrency = 4 } = {}) {
  const root = assetsRoot(projectRoot);
  const files = (await walkFiles(root))
    .filter((file) => SOURCE_AUDIO_EXTENSIONS.includes(path.extname(file.name).toLowerCase()))
    .sort((left, right) => left.fullPath.localeCompare(right.fullPath));

  const rows = files.map((file) => {
    const extension = path.extname(file.name).toLowerCase();
    const targetPath = mp3TargetPath(file.fullPath, extension);
    return {
      url: fsPathToUrl(projectRoot, file.fullPath),
      relativePath: toPosix(path.relative(root, file.fullPath)),
      fullPath: file.fullPath,
      extension,
      bytes: file.size,
      isMp3: extension === '.mp3',
      targetRelativePath: toPosix(path.relative(root, targetPath)),
      targetExists: extension !== '.mp3' && fsSync.existsSync(targetPath),
      probe: null,
      probeError: '',
    };
  });

  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor];
      cursor += 1;
      try {
        row.probe = await probeAudio(row.fullPath);
      } catch (error) {
        row.probeError = error.message || String(error);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return rows;
}

/**
 * Thư mục tạm của extension. File nháp (nghe thử, giải mã, encode dở) đi qua compat.workDir (PSI_WORK_DIR đổi được
 * chỗ); bản dự phòng audio luôn trong project vì Lịch sử / hoàn tác trỏ tới nó.
 */
function tempDir(projectRoot, name) {
  return name === 'audio-backup'
    ? path.join(projectRoot, 'temp', 'playable-size-inspector', name)
    : toolWorkDir(projectRoot, name);
}

/**
 * Đường dẫn đúng chữ hoa / thường như trên đĩa (NTFS không phân biệt). Ref sai hoa / thường (url cũ trong library,
 * danh sách quét trước khi đổi tên) mà dùng nguyên thì lúc ghi đè Windows đổi luôn tên file -> asset-db coi là asset
 * mới (uuid mới). Chỉ chuẩn hoá phần nằm dưới `root`.
 */
async function canonicalPath(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return target;
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    const entries = await fs.readdir(current).catch(() => null);
    const hit = entries && (entries.includes(segment) ? segment : entries.find((name) => name.toLowerCase() === segment.toLowerCase()));
    current = path.join(current, hit || segment);
  }
  return current;
}

/** Một audio nguồn (db:// url hoặc đường dẫn fs) đã kiểm tra: nằm trong assets/, đuôi hỗ trợ, có thật, đúng tên trên đĩa. */
async function resolveSourceAudio(projectRoot, ref) {
  const root = path.resolve(assetsRoot(projectRoot));
  const requested = toFsPath(projectRoot, ref);
  if (!requested || !isInside(requested, root)) {
    throw new Error(`Đường dẫn nằm ngoài assets: ${ref}`);
  }
  await fs.access(requested);
  const sourcePath = await canonicalPath(root, requested);
  const extension = path.extname(sourcePath).toLowerCase();
  if (!SOURCE_AUDIO_EXTENSIONS.includes(extension)) {
    throw new Error(`Định dạng không hỗ trợ: ${ref}`);
  }
  return { sourcePath, extension, root, relativePath: toPosix(path.relative(root, sourcePath)) };
}

/** uuid trong .meta của file (rỗng nếu không đọc được). */
async function metaUuid(filePath) {
  try {
    return String(JSON.parse(await fs.readFile(`${filePath}.meta`, 'utf8')).uuid || '');
  } catch (_error) {
    return '';
  }
}

/** Ném lỗi rõ ràng nếu file đang read-only / bị khoá (VCS, antivirus), để dừng TRƯỚC khi đụng tới gì. */
async function assertWritable(filePath) {
  try {
    await fs.access(filePath, fsSync.constants.W_OK);
  } catch (_error) {
    throw new Error(`file đang read-only hoặc bị khoá: ${path.basename(filePath)} (bỏ read-only / check out rồi thử lại)`);
  }
}

function safeFileStem(filePath) {
  return path.basename(filePath, path.extname(filePath)).replace(/[^a-zA-Z0-9._-]/g, '_') || 'audio';
}

/**
 * Encode thử một audio nguồn với đúng thông số sẽ áp (cắt + bitrate / mono / Hz) vào
 * temp/playable-size-inspector/audio-preview/ để nghe và xem dung lượng trước khi thay file
 * thật. Mỗi lần gọi xoá các bản thử cũ. Kết quả trùng byte với lần áp thật (cùng ffmpeg,
 * cùng tham số).
 * options: { bitrateKbps, mono, sampleRate, trim: { start, end, fadeIn, fadeOut } | null }
 */
async function previewEncode(projectRoot, ref, options = {}) {
  const { sourcePath } = await resolveSourceAudio(projectRoot, ref);
  const sourceProbe = await probeAudio(sourcePath);
  const trim = normalizeTrim(options.trim, sourceProbe.durationSeconds);
  const workDir = options.workDir || tempDir(projectRoot, 'audio-preview');
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });
  const outputPath = path.join(workDir, `${safeFileStem(sourcePath)}-${Date.now()}.mp3`);
  const encoded = await encodeAudio({
    inputPath: sourcePath,
    outputPath,
    bitrateKbps: options.bitrateKbps,
    mono: !!options.mono,
    sampleRate: options.sampleRate,
    trim,
  });
  return {
    path: outputPath,
    beforeBytes: encoded.beforeBytes,
    afterBytes: encoded.afterBytes,
    bitrateKbps: encoded.bitrateKbps,
    probe: await probeAudio(outputPath),
    sourceProbe,
    trim,
  };
}

/**
 * Bản WAV tạm của một audio nguồn, cho định dạng mà trình duyệt của panel không giải mã
 * được (wma...). Dùng lại bản đã tạo khi file nguồn chưa đổi.
 */
async function previewWav(projectRoot, ref) {
  const { sourcePath } = await resolveSourceAudio(projectRoot, ref);
  const stat = await fs.stat(sourcePath);
  const workDir = tempDir(projectRoot, 'audio-decode');
  await fs.mkdir(workDir, { recursive: true });
  const outputPath = path.join(workDir, `${safeFileStem(sourcePath)}-${stat.size}-${Math.round(stat.mtimeMs)}.wav`);
  if (await pathExists(outputPath)) {
    return outputPath;
  }
  const result = await runFfmpeg(['-y', '-loglevel', 'error', '-i', sourcePath, '-vn', '-c:a', 'pcm_s16le', outputPath]);
  if (result.code !== 0) {
    await fs.rm(outputPath, { force: true });
    throw new Error(result.stderr.trim() || `ffmpeg thoát mã ${result.code}`);
  }
  return outputPath;
}

/** 20261002-081500: tên thư mục dự phòng cho một lần chuyển (main.js dùng chung, không giữ bản sao). */
function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Chép file (kèm .meta nếu có) vào thư mục dự phòng, giữ đường dẫn tương đối trong assets/. */
async function backupFile(filePath, relativePath, backupDir) {
  const target = path.join(backupDir, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(filePath, target);
  if (await pathExists(`${filePath}.meta`)) {
    await fs.copyFile(`${filePath}.meta`, `${target}.meta`);
  }
  return target;
}

/**
 * Chuyển / nén lại các audio nguồn sang MP3 và THAY THẾ file gốc (giữ uuid).
 * options: { refs: [db url | fs path], bitrateKbps, mono, sampleRate, overwriteExisting, workDir,
 *            trim: { start, end, fadeIn, fadeOut } (chỉ khi refs có đúng 1 file) }
 *   - Kết quả không nhỏ hơn file gốc (khi gốc đã là mp3) -> giữ gốc, báo skipped; trừ khi có
 *     cắt / fade (người dùng chủ động sửa nội dung).
 *   - Đổi đuôi (wav -> mp3): có `renameAsset` (trong editor) thì nhờ asset-db đổi tên (giữ uuid như đổi tên trong
 *     panel Assets) rồi ghi nội dung MP3 vào file đã đổi tên; không có thì rename .meta sang đuôi mới, sửa `files`,
 *     đặt imported=false.
 *   - renameAsset(fromPath, toPath) -> Promise<boolean>, deleteAsset(path) -> Promise<boolean>: tuỳ chọn, main.js
 *     truyền vào để đi qua asset-db; trả false / lỗi thì tự làm bằng file.
 *   - Đã có mp3 cùng tên (asset khác): chỉ ghi đè khi overwriteExisting = true.
 *   - File bị thay / bị xoá được chép dự phòng vào temp/playable-size-inspector/audio-backup/<thời điểm>/.
 * Trả về mảng kết quả theo từng file; không ném lỗi giữa chừng cho file lẻ.
 */
async function convertSourceAudio(projectRoot, options) {
  const settings = options || {};
  const refs = Array.isArray(settings.refs) ? [...new Set(settings.refs.map(String))] : [];
  if (!refs.length) {
    throw new Error('Chưa chọn file audio nào.');
  }
  if (settings.trim && refs.length !== 1) {
    throw new Error('Cắt đoạn chỉ áp cho từng file một.');
  }
  const root = path.resolve(assetsRoot(projectRoot));
  const workDir = settings.workDir || tempDir(projectRoot, 'audio');
  const backupDir = settings.backupDir || path.join(tempDir(projectRoot, 'audio-backup'), timestamp());
  await fs.mkdir(workDir, { recursive: true });

  const sources = [];
  for (const ref of refs) {
    const source = await resolveSourceAudio(projectRoot, ref);
    sources.push({
      sourcePath: source.sourcePath,
      extension: source.extension,
      relativePath: source.relativePath,
      targetPath: mp3TargetPath(source.sourcePath, source.extension),
    });
  }

  const owners = new Map();
  for (const source of sources) {
    const key = source.targetPath.toLowerCase();
    if (owners.has(key)) {
      throw new Error(`Hai file có cùng tên MP3 đích: ${source.relativePath} và ${owners.get(key)}.`);
    }
    owners.set(key, source.relativePath);
  }

  const results = [];
  for (const source of sources) {
    try {
      results.push(await convertOne(projectRoot, source, { ...settings, root, workDir, backupDir }));
    } catch (error) {
      results.push({ ok: false, relativePath: source.relativePath, error: error.message || String(error) });
    }
  }
  return results;
}

async function convertOne(projectRoot, source, settings) {
  const { sourcePath, extension, relativePath } = source;
  const changesExtension = extension !== '.mp3';
  const targetExists = changesExtension && await pathExists(source.targetPath);
  // MP3 trùng tên đang có: dùng đúng tên trên đĩa để delete-asset / backup trỏ đúng asset.
  const targetPath = targetExists ? await canonicalPath(settings.root, source.targetPath) : source.targetPath;
  const sourceMetaPath = `${sourcePath}.meta`;
  const targetMetaPath = `${targetPath}.meta`;
  if (targetExists && !settings.overwriteExisting) {
    return {
      ok: true,
      skipped: 'đã có MP3 trùng tên (tick "Ghi đè MP3 trùng tên" để thay)',
      relativePath,
      targetRelativePath: toPosix(path.relative(settings.root, targetPath)),
      beforeBytes: (await fs.stat(sourcePath)).size,
      afterBytes: (await fs.stat(sourcePath)).size,
    };
  }

  const temporaryPath = path.join(
    settings.workDir,
    `${path.basename(targetPath, '.mp3').replace(/[^a-zA-Z0-9._-]/g, '_')}-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`,
  );
  const trim = settings.trim ? normalizeTrim(settings.trim, (await probeAudio(sourcePath)).durationSeconds) : null;

  try {
    const encoded = await encodeAudio({
      inputPath: sourcePath,
      outputPath: temporaryPath,
      bitrateKbps: settings.bitrateKbps,
      mono: !!settings.mono,
      sampleRate: settings.sampleRate,
      trim,
    });

    if (!changesExtension && !trim && encoded.afterBytes >= encoded.beforeBytes) {
      return {
        ok: true,
        skipped: 'kết quả không nhỏ hơn file gốc, giữ nguyên',
        relativePath,
        targetRelativePath: relativePath,
        beforeBytes: encoded.beforeBytes,
        afterBytes: encoded.beforeBytes,
        attemptedBytes: encoded.afterBytes,
      };
    }

    // Kiểm tra trước khi đụng tới file: có file / .meta bị khoá thì dừng hẳn, không để dở dang.
    await assertWritable(sourcePath);
    if (await pathExists(sourceMetaPath)) await assertWritable(sourceMetaPath);
    if (targetExists) {
      await assertWritable(targetPath);
      if (await pathExists(targetMetaPath)) await assertWritable(targetMetaPath);
    }
    const uuidBefore = await metaUuid(sourcePath);

    // Dự phòng file gốc (và MP3 trùng tên sắp bị xoá) trước khi thay.
    const backupPath = await backupFile(sourcePath, relativePath, settings.backupDir);
    if (targetExists) {
      await backupFile(targetPath, toPosix(path.relative(settings.root, targetPath)), settings.backupDir);
    }
    const backupRelative = toPosix(path.relative(projectRoot, backupPath));

    // Thay thế file gốc. Cùng đuôi: ghi đè đúng file (giữ tên + meta). Đổi đuôi: giữ uuid bằng cách nhờ asset-db đổi
    // tên (renameAsset), không được thì đổi tên .meta theo file và ép import lại.
    let renamedByAssetDb = false;
    try {
      if (changesExtension) {
        if (targetExists) {
          const deleted = settings.deleteAsset ? await settings.deleteAsset(targetPath).catch(() => false) : false;
          if (!deleted || await pathExists(targetPath)) {
            await fs.rm(targetPath, { force: true });
            await fs.rm(targetMetaPath, { force: true });
          }
        }
        renamedByAssetDb = settings.renameAsset ? await settings.renameAsset(sourcePath, targetPath).catch(() => false) : false;
        // Chỉ tin asset-db khi file thật sự đã sang tên mới và tên cũ không còn.
        renamedByAssetDb = renamedByAssetDb && await pathExists(targetPath) && !await pathExists(sourcePath);
      }
      try {
        await moveFile(temporaryPath, targetPath);
      } catch (error) {
        // Ghi nội dung MP3 thất bại sau khi asset-db đã đổi tên: đổi tên về như cũ (vẫn giữ uuid).
        if (renamedByAssetDb && settings.renameAsset) {
          await settings.renameAsset(targetPath, sourcePath).catch(() => false);
        }
        throw error;
      }
      if (changesExtension && !renamedByAssetDb) {
        // Đổi tên .meta trước rồi mới xoá file cũ: lỗi giữa chừng thì uuid vẫn nằm cạnh một trong hai file.
        if (await pathExists(sourceMetaPath)) {
          await fs.rename(sourceMetaPath, targetMetaPath);
          await retargetMeta(targetMetaPath, extension);
        }
        await fs.rm(sourcePath, { force: true });
      }
    } catch (error) {
      throw new Error(`${error.message || error} — bản gốc còn ở ${backupRelative}${targetExists ? ' (cả MP3 trùng tên đã ghi đè)' : ''}`);
    }

    return {
      ok: true,
      relativePath,
      targetRelativePath: toPosix(path.relative(settings.root, targetPath)),
      beforeBytes: encoded.beforeBytes,
      afterBytes: encoded.afterBytes,
      replacedExistingMp3: targetExists,
      changedExtension: changesExtension,
      renamedByAssetDb,
      uuidBefore,
      trim,
      backupPath: backupRelative,
    };
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

/** Meta giữ nguyên uuid; chỉ đổi đuôi trong `files` và ép import lại để asset-db bỏ cache cũ. */
async function retargetMeta(metaPath, oldExtension) {
  const raw = await fs.readFile(metaPath, 'utf8');
  const meta = JSON.parse(raw);
  if (Array.isArray(meta.files)) {
    meta.files = meta.files.map((entry) => (String(entry).toLowerCase() === oldExtension ? '.mp3' : entry));
  }
  meta.imported = false;
  const eol = raw.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const trailing = /\r?\n$/.test(raw) ? eol : '';
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2).replace(/\n/g, eol) + trailing, 'utf8');
}

async function moveFile(from, to) {
  try {
    await fs.rename(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw error;
    }
    await fs.copyFile(from, to);
    await fs.rm(from, { force: true });
  }
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

module.exports = {
  SOURCE_AUDIO_EXTENSIONS,
  BITRATE_OPTIONS_KBPS,
  DEFAULT_BITRATE_KBPS,
  MIN_TRIM_SECONDS,
  TRIM_EPSILON,
  timestamp,
  probeAudio,
  encodeAudio,
  clampBitrate,
  parseProbeOutput,
  normalizeTrim,
  trimFilters,
  scanSourceAudio,
  resolveSourceAudio,
  canonicalPath,
  metaUuid,
  previewEncode,
  previewWav,
  convertSourceAudio,
};
