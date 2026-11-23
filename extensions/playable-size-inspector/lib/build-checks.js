'use strict';

/**
 * Các kiểm tra dung lượng CHUNG cho "Việc nên làm": chạy được trên mọi dự án Cocos 3.x (2D / 3D, có hoặc
 * không có playable-ads-builder, đã hoặc chưa xuất playable, có hoặc chưa có profiles/ của người dùng).
 * Mỗi kiểm tra tự tìm bằng chứng trong bản build (src/settings.json, file build, JSON import), trong
 * library/ và assets/ của dự án; thiếu dữ liệu thì bỏ qua và ghi lý do (diagnostics), không đoán.
 *
 * Kết quả cùng dạng với lib/insights.js: { id, group, bytes, saving, impact, basis, title, detail, action }.
 * `saving` = byte ước tính giảm được SAU ZIP (cùng đơn vị với mọi gợi ý khác). Có bản xuất của
 * playable-ads-builder thì lấy đúng phần từng file chiếm trong zip của bản xuất (đã đổi WebP / encode lại
 * audio); không có thì zip thử file trong build. Con số đo được ghi "đo" / "mô phỏng", con số suy ra từ
 * tỉ lệ thường gặp ghi "ước tính" kèm tỉ lệ đó trong `basis`.
 *
 * Chỉ ĐỌC (fs + zlib + crypto): không ghi gì vào dự án, không cần Editor, không cần sharp / ffmpeg.
 * action chỉ dùng các kiểu panel đã xử lý (reveal, open-settings, texture, audio, model) hoặc null.
 */

const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');
const { formatBytes, findBuildSettings, stableBuildPath } = require('./build-scan');
const { readJsonFile, isSameResolvedPath } = require('./fs-utils');
const { readPlayableTasks, readExportConfigs, findExportConfig, findExportSets, readBuilderFallback } = require('./exports');
const { readExportBreakdown, mapToBuildRows } = require('./html-export');
const { readPresets } = require('./texture-compress');

const deflateRaw = promisify(zlib.deflateRaw);
const deflateZlib = promisify(zlib.deflate);
const inflateZlib = promisify(zlib.inflate);

const KB = 1024;
/** Gợi ý giảm dưới mức này (sau zip) thì không nêu: không đáng công sửa. */
const MIN_SAVING = 2 * KB;
/** Bản xuất cũ hơn bản build quá mức này thì không dùng số của nó. */
const EXPORT_STALE_MS = 2 * 60 * 1000;

// Tỉ lệ dùng cho các con số "ước tính" (ghi rõ trong basis của từng gợi ý).
/** Bản build Debug: mã engine bản release nhỏ hơn khoảng chừng này sau zip (đo: 821 KB → 553 KB, −33%). */
const DEBUG_ENGINE_SAVING = 0.3;
/** Mangle Properties: mã engine nhỏ đi khoảng chừng này sau zip (đo trên 3.8.8: −12,4 KB / ≈ 512 KB). */
const MANGLE_ENGINE_SAVING = 0.024;
/** Chỉ có asm.js (không có wasm): bản wasm thường nhỏ hơn khoảng chừng này sau zip. */
const ASM_TO_WASM_SAVING = 0.25;
/** WebP lossy q80 → q75 (libwebp mặc định, effort 4): đo trên 85 ảnh của một dự án: −13,7%. */
const WEBP_Q80_TO_Q75 = 0.137;
/** Xuất ảnh không nén / lossless → WebP lossy q80: ảnh thường còn khoảng ½ / ⅔. */
const WEBP_FROM_NONE = 0.5;
const WEBP_FROM_LOSSLESS = 0.35;
/** Bản xuất chưa có: WebP của builder thường còn khoảng ½ ảnh PNG trong build. */
const WEBP_OF_BUILD_PNG = 0.5;
/** Tắt PNG palette (Texture Compress PNG) cho ảnh jpg / ảnh đục khi builder đổi sang WebP. */
const PALETTE_JPG_SAVING = 0.3;
const PALETTE_OPAQUE_SAVING = 0.1;
/** Skeleton Spine JSON: làm tròn số / .skel nhị phân thường giảm chừng này sau zip (đo: 14–21%). */
const SPINE_JSON_SAVING = 0.15;
/** Tangent trong mesh đã nén: phần giảm sau zip ≈ chừng này × tỉ lệ byte tangent / đỉnh (đo: 16% / 28%). */
const TANGENT_ZIP_FACTOR = 0.5;
/** Bitrate gợi ý cho audio của builder. */
const SUGGESTED_AUDIO_KBPS = 48;
/** Chất lượng WebP gợi ý. */
const SUGGESTED_WEBP_QUALITY = 75;

// ---------------------------------------------------------------- tiện ích

const memoCache = new Map();
/** Nhớ kết quả (promise) theo khoá: file đọc lại nhiều lần mỗi khi "Việc nên làm" tính lại. */
function memo(key, compute) {
  if (!memoCache.has(key)) {
    if (memoCache.size > 3000) {
      memoCache.clear();
    }
    const promise = Promise.resolve().then(compute);
    promise.catch(() => memoCache.delete(key));
    memoCache.set(key, promise);
  }
  return memoCache.get(key);
}

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function listNames(names, limit = 3) {
  const shown = names.slice(0, limit).join(', ');
  return names.length > limit ? `${shown} và ${names.length - limit} mục khác` : shown;
}

function baseName(value) {
  return String(value || '').split('/').pop();
}

function rootUrl(url) {
  return String(url || '').split('@')[0];
}

function savingLabel(saving) {
  return `≈ tiết kiệm ${formatBytes(saving)}`;
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

/** Byte header zip của một file (header cục bộ + bản ghi central directory), như builder ghi. */
function zipHeaderBytes(relativePath) {
  const nameBytes = Buffer.byteLength(String(relativePath || '').replace(/\\/g, '/'), 'utf8');
  return 30 + nameBytes + 46 + nameBytes;
}

async function deflatedLength(data) {
  return (await deflateRaw(data, { level: 9 })).length;
}

function readText(filePath) {
  return fs.readFile(filePath, 'utf8');
}

async function statKey(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  return stat ? `${filePath}|${stat.size}|${stat.mtimeMs}` : '';
}

/**
 * Như memo nhưng mỗi `slot` (vd một đường dẫn file) chỉ giữ kết quả của `stamp` mới nhất: file lớn đọc lại sau mỗi lần
 * đổi (library/.assets-data.json...) không bị giữ mãi các bản cũ trong bộ nhớ của panel.
 */
const latestStamps = new Map();
function memoLatest(slot, stamp, compute) {
  const previous = latestStamps.get(slot);
  if (previous !== undefined && previous !== stamp) {
    memoCache.delete(`${slot}|${previous}`);
  }
  latestStamps.set(slot, stamp);
  return memo(`${slot}|${stamp}`, compute);
}

async function readJsonMemo(filePath) {
  const key = await statKey(filePath);
  return key ? memoLatest(`json|${filePath}`, key, () => readJsonFile(filePath)) : null;
}

/** Nút "Mở Build" của các gợi ý tuỳ chọn build / cấu hình builder (panel: runInsightAction 'open-build'). */
const OPEN_BUILD = { type: 'open-build', label: 'Mở Build' };

function skipped(reason) {
  return { insights: [], skipped: reason };
}

// ---------------------------------------------------------------- bối cảnh: build task, bản xuất

/** Tuỳ chọn của build task ra đúng thư mục `buildRoot` (profiles/v2/packages/builder.json, theo người dùng): null nếu không có. */
async function readBuildTaskOptions(projectRoot, buildRoot) {
  const tasks = await readPlayableTasks(projectRoot).catch(() => []);
  const match = tasks.find((task) => {
    const buildPath = String(task.options.buildPath || 'project://build').replace(/^project:\/\//, `${projectRoot}/`);
    return isSameResolvedPath(path.resolve(projectRoot, buildPath, String(task.options.outputName || task.options.platform || '')), buildRoot);
  });
  return match ? match.options : null;
}

/**
 * Bản xuất mới nhất (không cũ hơn bản build) của playable-ads-builder ứng với bản build: ưu tiên .html.
 * { item, factor, zipByPath: Map<đường dẫn build, byte sau zip trong bản xuất>, files } hoặc null.
 */
async function readExportInfo(projectRoot, buildRoot, rows) {
  const settingsPath = await findBuildSettings(buildRoot);
  const built = settingsPath ? await fs.stat(settingsPath).catch(() => null) : null;
  const builtAt = built ? built.mtimeMs : 0;
  const sets = await findExportSets(projectRoot).catch(() => []);
  // Bộ có cấu hình build trỏ đúng thư mục này trước, rồi các bộ không gắn cấu hình (thư mục cũ / tự đặt).
  const ordered = [
    ...sets.filter((set) => set.config && isSameResolvedPath(set.config.buildDir, buildRoot)),
    ...sets.filter((set) => !set.config),
  ];
  for (const set of ordered) {
    const fresh = set.items.filter((item) => (item.kind === 'html' || item.kind === 'zip') && item.mtimeMs >= builtAt - EXPORT_STALE_MS);
    const item = fresh.find((entry) => entry.kind === 'html') || fresh[0];
    if (!item) {
      continue;
    }
    const breakdown = await memoLatest(`export|${item.path}`, `${item.mtimeMs}|${item.bytes}`, () => readExportBreakdown(item.path)).catch(() => null);
    // Chỉ bản xuất của playable-ads-builder mới có zip đo được từng file (adapter để thẳng một phần dữ liệu trong HTML).
    if (!breakdown || breakdown.unsupported || breakdown.estimated || (breakdown.tool && breakdown.tool !== 'builder')) {
      continue;
    }
    const factor = breakdown.factor > 0 ? breakdown.factor : 1;
    const mapped = mapToBuildRows(rows, breakdown);
    return {
      item,
      factor,
      zipByPath: new Map(mapped.rows.map((row) => [row.relativePath, row.size / factor])),
      files: breakdown.files.map((file) => ({ ...file, zipBytes: file.bytes / factor })),
    };
  }
  return null;
}


/**
 * Cấu hình nén lúc xuất của playable-ads-builder cho bản build: { compression, audio, assumed, name }. Build task có
 * Name thì đúng như exports.readExportConfigs; task chưa đặt Name thì cấu hình đã lưu của nó; dự án có extension
 * playable-ads-builder mà máy này chưa có profiles/ (không vào git) thì mặc định của builder (assumed: true).
 * null khi dự án không dùng playable-ads-builder.
 */
async function readBuilderConfig(projectRoot, buildRoot) {
  const config = findExportConfig(await readExportConfigs(projectRoot).catch(() => []), buildRoot);
  if (config) {
    return { compression: config.compression, audio: config.audio, assumed: false, name: config.name };
  }
  const task = (await readPlayableTasks(projectRoot).catch(() => [])).find((item) => item.pkg);
  if (task) {
    return {
      compression: {
        type: ['none', 'lossy', 'lossless'].includes(task.pkg.compressionType) ? task.pkg.compressionType : 'lossy',
        quality: typeof task.pkg.compressionQuality === 'number' ? task.pkg.compressionQuality : 80,
      },
      audio: { enabled: task.pkg.audioCompressionEnabled !== false, bitrate: typeof task.pkg.audioBitrate === 'number' ? task.pkg.audioBitrate : 64 },
      assumed: false,
      name: task.name,
    };
  }
  // Máy chưa có build task (profiles/ không vào git): cấu hình builder lưu trong dự án, không có thì mặc định của builder.
  const fallback = await readBuilderFallback(projectRoot).catch(() => null);
  return fallback ? { compression: fallback.compression, audio: fallback.audio, assumed: true, assumedFrom: fallback.source, name: '' } : null;
}

/** Tạo bối cảnh dùng chung cho mọi kiểm tra; phần đắt (bản xuất, cấu hình) chỉ đọc khi có kiểm tra cần. */
function createContext(options) {
  const lazy = (compute) => {
    let value = null;
    return () => {
      if (!value) {
        value = compute().catch(() => null);
      }
      return value;
    };
  };
  const ctx = {
    ...options,
    rows: options.build.assetRows || [],
    buildRoot: options.build.buildRoot,
  };
  ctx.taskOptions = lazy(() => readBuildTaskOptions(ctx.projectRoot, ctx.buildRoot));
  ctx.exportInfo = lazy(() => readExportInfo(ctx.projectRoot, ctx.buildRoot, ctx.rows));
  ctx.exportConfig = lazy(() => readBuilderConfig(ctx.projectRoot, ctx.buildRoot));
  /** Byte sau zip của một file build: phần nó chiếm trong bản xuất nếu có, không thì zip thử file trong build. */
  ctx.zipBytes = async (row) => {
    const info = await ctx.exportInfo();
    if (info && info.zipByPath.has(row.relativePath)) {
      return Math.round(info.zipByPath.get(row.relativePath));
    }
    return ctx.zippedSize(row);
  };
  /** Cột số liệu lấy từ đâu (cho basis): "trong bản xuất <tên>" hoặc "sau zip (trong build)". */
  ctx.sourceLabel = async () => {
    const info = await ctx.exportInfo();
    return info ? `trong zip của ${info.item.name}` : 'sau zip (file trong build)';
  };
  ctx.inBuildUrls = () => {
    if (!ctx.inBuildCache) {
      const urls = new Set();
      for (const row of ctx.rows) {
        if (row.source) {
          urls.add(row.source);
          urls.add(rootUrl(row.source));
        }
        for (const source of row.packedSources || []) {
          urls.add(source.url);
          urls.add(rootUrl(source.url));
        }
      }
      ctx.inBuildCache = urls;
    }
    return ctx.inBuildCache;
  };
  return ctx;
}

// ---------------------------------------------------------------- ảnh: PNG / JPEG

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function imageInfo(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { type: 'PNG', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: 'JPEG', width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
    return { type: 'JPEG', width: 0, height: 0 };
  }
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return { type: 'WebP', width: 0, height: 0 };
  }
  return { type: 'không rõ', width: 0, height: 0 };
}

function readPngChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    if (offset + 12 + length > buffer.length) {
      return null;
    }
    chunks.push({ type, data: buffer.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
    if (type === 'IEND') {
      break;
    }
  }
  return chunks;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 255] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Bỏ khi nén lại: chữ, thời điểm, EXIF (không đổi điểm ảnh hay màu hiển thị). */
const DROP_PNG_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'tIME', 'eXIf']);
/** Ảnh quá lớn thì không thử nén lại (giải nén ra RAM). */
const MAX_PNG_RAW_BYTES = 48 * 1024 * 1024;

/**
 * Nén lại PNG KHÔNG mất dữ liệu (giữ nguyên từng điểm ảnh và các chunk màu): lọc lại từng hàng (chọn filter
 * có tổng |byte| nhỏ nhất, như libpng) rồi deflate mức 9, lấy bản nhỏ hơn giữa lọc thích ứng và không lọc.
 * Trả về Buffer PNG mới, hoặc null (ảnh interlace / hỏng / quá lớn).
 */
async function recompressPngLossless(buffer) {
  const chunks = readPngChunks(buffer);
  const header = chunks && chunks[0] && chunks[0].type === 'IHDR' ? chunks[0].data : null;
  if (!header || header.length < 13) {
    return null;
  }
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bitDepth = header[8];
  const colorType = header[9];
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels || header[12] !== 0 || !width || !height) {
    return null;
  }
  const bpp = Math.max(1, Math.ceil(channels * bitDepth / 8));
  const rowBytes = Math.ceil(width * channels * bitDepth / 8);
  if ((rowBytes + 1) * height > MAX_PNG_RAW_BYTES) {
    return null;
  }
  const raw = await inflateZlib(Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data)));
  if (raw.length < (rowBytes + 1) * height) {
    return null;
  }
  const pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (rowBytes + 1)];
    const line = y * (rowBytes + 1) + 1;
    const out = y * rowBytes;
    const prev = out - rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const a = x >= bpp ? pixels[out + x - bpp] : 0;
      const b = y ? pixels[prev + x] : 0;
      const c = y && x >= bpp ? pixels[prev + x - bpp] : 0;
      let value = raw[line + x];
      if (filter === 1) {
        value += a;
      } else if (filter === 2) {
        value += b;
      } else if (filter === 3) {
        value += (a + b) >> 1;
      } else if (filter === 4) {
        value += paeth(a, b, c);
      } else if (filter !== 0) {
        return null;
      }
      pixels[out + x] = value & 255;
    }
  }
  // Ảnh palette / dưới 8 bit: không lọc (khuyến nghị của chuẩn PNG); còn lại thử cả lọc thích ứng lẫn không lọc.
  const adaptiveAllowed = colorType !== 3 && bitDepth >= 8;
  const plain = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    pixels.copy(plain, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const candidates = [plain];
  if (adaptiveAllowed) {
    const adaptive = Buffer.alloc((rowBytes + 1) * height);
    const trial = Buffer.alloc(rowBytes);
    const best = Buffer.alloc(rowBytes);
    for (let y = 0; y < height; y += 1) {
      const out = y * rowBytes;
      const prev = out - rowBytes;
      let bestFilter = 0;
      let bestScore = Infinity;
      for (let filter = 0; filter < 5; filter += 1) {
        let score = 0;
        for (let x = 0; x < rowBytes; x += 1) {
          const value = pixels[out + x];
          const a = x >= bpp ? pixels[out + x - bpp] : 0;
          const b = y ? pixels[prev + x] : 0;
          const c = y && x >= bpp ? pixels[prev + x - bpp] : 0;
          const predicted = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
          const filtered = (value - predicted) & 255;
          trial[x] = filtered;
          score += filtered < 128 ? filtered : 256 - filtered;
          if (score >= bestScore) {
            break;
          }
        }
        if (score < bestScore) {
          bestScore = score;
          bestFilter = filter;
          trial.copy(best);
        }
      }
      adaptive[y * (rowBytes + 1)] = bestFilter;
      best.copy(adaptive, y * (rowBytes + 1) + 1);
    }
    candidates.push(adaptive);
  }
  const compressed = await Promise.all(candidates.map((data) => deflateZlib(data, { level: 9, memLevel: 9 })));
  const idat = compressed.reduce((smallest, data) => (data.length < smallest.length ? data : smallest));
  const parts = [PNG_SIGNATURE];
  let wroteData = false;
  for (const chunk of chunks) {
    if (DROP_PNG_CHUNKS.has(chunk.type)) {
      continue;
    }
    if (chunk.type === 'IDAT') {
      if (!wroteData) {
        parts.push(pngChunk('IDAT', idat));
        wroteData = true;
      }
      continue;
    }
    parts.push(pngChunk(chunk.type, chunk.data));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- font TTF / OTF

/**
 * Đọc bảng của font sfnt (TTF / OTF): { tables, numGlyphs, mappedChars, glyphOf(code), glyphSize(g), components(g), cff }.
 * null nếu không phải sfnt (vd WOFF, TTC). Mọi chỉ số đều kiểm tra trong phạm vi file.
 */
function parseSfnt(buffer) {
  if (buffer.length < 12) {
    return null;
  }
  const version = buffer.readUInt32BE(0);
  if (version !== 0x00010000 && version !== 0x74727565 && version !== 0x4f54544f) {
    return null;
  }
  const numTables = buffer.readUInt16BE(4);
  const tables = new Map();
  for (let index = 0; index < numTables; index += 1) {
    const at = 12 + 16 * index;
    if (at + 16 > buffer.length) {
      return null;
    }
    const offset = buffer.readUInt32BE(at + 8);
    const length = buffer.readUInt32BE(at + 12);
    if (offset + length > buffer.length) {
      return null;
    }
    tables.set(buffer.toString('latin1', at, at + 4), { offset, length });
  }
  const maxp = tables.get('maxp');
  const numGlyphs = maxp && maxp.length >= 6 ? buffer.readUInt16BE(maxp.offset + 4) : 0;
  const cmap = parseCmap(buffer, tables.get('cmap'));
  const font = { tables, numGlyphs, cff: tables.has('CFF ') || tables.has('CFF2'), glyphOf: cmap.glyphOf, mappedChars: cmap.mappedChars, glyphSize: null, components: () => [] };
  const head = tables.get('head');
  const loca = tables.get('loca');
  const glyf = tables.get('glyf');
  if (head && loca && glyf && numGlyphs && head.length >= 54) {
    const longFormat = buffer.readInt16BE(head.offset + 50) === 1;
    const offsetOf = (glyph) => {
      const at = loca.offset + (longFormat ? 4 : 2) * glyph;
      if (at + (longFormat ? 4 : 2) > loca.offset + loca.length) {
        return -1;
      }
      return longFormat ? buffer.readUInt32BE(at) : buffer.readUInt16BE(at) * 2;
    };
    font.glyphSize = (glyph) => {
      const start = offsetOf(glyph);
      const end = offsetOf(glyph + 1);
      return start >= 0 && end >= start ? end - start : 0;
    };
    font.components = (glyph) => {
      const start = offsetOf(glyph);
      if (start < 0 || font.glyphSize(glyph) < 10) {
        return [];
      }
      let at = glyf.offset + start;
      const end = at + font.glyphSize(glyph);
      if (buffer.readInt16BE(at) >= 0) {
        return [];
      }
      at += 10;
      const parts = [];
      for (let guard = 0; guard < 64 && at + 4 <= end; guard += 1) {
        const flags = buffer.readUInt16BE(at);
        parts.push(buffer.readUInt16BE(at + 2));
        at += 4 + (flags & 0x0001 ? 4 : 2);
        at += flags & 0x0008 ? 2 : flags & 0x0040 ? 4 : flags & 0x0080 ? 8 : 0;
        if (!(flags & 0x0020)) {
          break;
        }
      }
      return parts;
    };
  }
  return font;
}

function parseCmap(buffer, table) {
  const none = { glyphOf: () => 0, mappedChars: 0 };
  if (!table || table.length < 4) {
    return none;
  }
  const base = table.offset;
  const end = base + table.length;
  const count = buffer.readUInt16BE(base + 2);
  const records = [];
  for (let index = 0; index < count && base + 4 + 8 * index + 8 <= end; index += 1) {
    const at = base + 4 + 8 * index;
    const offset = base + buffer.readUInt32BE(at + 4);
    if (offset + 4 <= end) {
      records.push({ platform: buffer.readUInt16BE(at), encoding: buffer.readUInt16BE(at + 2), offset, format: buffer.readUInt16BE(offset) });
    }
  }
  const pick = records.find((item) => item.format === 12 && (item.platform === 3 || item.platform === 0))
    || records.find((item) => item.format === 4 && item.platform === 3)
    || records.find((item) => item.format === 4 && item.platform === 0);
  if (!pick) {
    return none;
  }
  const at = pick.offset;
  if (pick.format === 12) {
    const groups = [];
    const total = buffer.readUInt32BE(at + 12);
    for (let index = 0; index < total && at + 16 + 12 * index + 12 <= end; index += 1) {
      const g = at + 16 + 12 * index;
      groups.push([buffer.readUInt32BE(g), buffer.readUInt32BE(g + 4), buffer.readUInt32BE(g + 8)]);
    }
    return {
      mappedChars: sum(groups.map(([start, stop]) => stop - start + 1)),
      glyphOf: (code) => {
        const group = groups.find(([start, stop]) => code >= start && code <= stop);
        return group ? group[2] + code - group[0] : 0;
      },
    };
  }
  const segments = buffer.readUInt16BE(at + 6) / 2;
  const endCodes = at + 14;
  const startCodes = endCodes + 2 * segments + 2;
  const deltas = startCodes + 2 * segments;
  const rangeOffsets = deltas + 2 * segments;
  if (rangeOffsets + 2 * segments > end) {
    return none;
  }
  let mapped = 0;
  for (let index = 0; index < segments; index += 1) {
    const stop = buffer.readUInt16BE(endCodes + 2 * index);
    const start = buffer.readUInt16BE(startCodes + 2 * index);
    if (stop !== 0xffff && stop >= start) {
      mapped += stop - start + 1;
    }
  }
  return {
    mappedChars: mapped,
    glyphOf: (code) => {
      if (code > 0xffff) {
        return 0;
      }
      for (let index = 0; index < segments; index += 1) {
        const stop = buffer.readUInt16BE(endCodes + 2 * index);
        if (code > stop) {
          continue;
        }
        const start = buffer.readUInt16BE(startCodes + 2 * index);
        if (code < start) {
          return 0;
        }
        const delta = buffer.readInt16BE(deltas + 2 * index);
        const rangeOffset = buffer.readUInt16BE(rangeOffsets + 2 * index);
        if (!rangeOffset) {
          return (code + delta) & 0xffff;
        }
        const address = rangeOffsets + 2 * index + rangeOffset + 2 * (code - start);
        if (address + 2 > end) {
          return 0;
        }
        const glyph = buffer.readUInt16BE(address);
        return glyph ? (glyph + delta) & 0xffff : 0;
      }
      return 0;
    },
  };
}

/** Bảng thay theo bộ glyph khi cắt font (phần còn lại giữ nguyên). */
const GLYPH_TABLES = new Set(['glyf', 'loca', 'hmtx', 'vmtx', 'cmap', 'post', 'hdmx', 'LTSH', 'VDMX', 'DSIG', 'GPOS', 'GSUB', 'GDEF', 'kern', 'CFF ', 'CFF2']);

/**
 * Ước tính dung lượng font sau khi chỉ giữ các ký tự `codes` (giống pyftsubset: đánh số lại glyph, giữ glyph ghép):
 * bảng cố định + dữ liệu glyph thật của bộ giữ lại + loca / hmtx / cmap mới + bảng layout tỉ lệ theo số glyph.
 * { bytes, glyphs, missing } (missing: ký tự font không có).
 */
function estimateSubset(font, codes) {
  const keep = new Set([0]);
  let missing = 0;
  for (const code of codes) {
    const glyph = font.glyphOf(code);
    if (glyph > 0 && glyph < font.numGlyphs) {
      keep.add(glyph);
    } else if (code > 32) {
      missing += 1;
    }
  }
  const queue = [...keep];
  while (queue.length) {
    for (const part of font.components(queue.pop())) {
      if (part < font.numGlyphs && !keep.has(part)) {
        keep.add(part);
        queue.push(part);
      }
    }
  }
  const share = font.numGlyphs ? keep.size / font.numGlyphs : 1;
  let bytes = 12 + 16 * font.tables.size;
  for (const [tag, table] of font.tables) {
    if (!GLYPH_TABLES.has(tag)) {
      bytes += table.length;
    }
  }
  const tableLength = (tag) => (font.tables.get(tag) ? font.tables.get(tag).length : 0);
  bytes += Math.round((tableLength('GPOS') + tableLength('GSUB') + tableLength('GDEF') + tableLength('kern')) * share);
  if (font.glyphSize) {
    bytes += sum([...keep].map((glyph) => font.glyphSize(glyph))) + 4 * (keep.size + 1) + 4 * keep.size;
  } else {
    bytes += Math.round((tableLength('CFF ') + tableLength('CFF2') + tableLength('hmtx')) * share);
  }
  bytes += 40 + 8 * codes.length + 32;
  return { bytes, glyphs: keep.size, missing };
}

/** Ký tự ASCII in được (dự phòng cho chữ gán từ script). */
const ASCII_PRINTABLE = Array.from({ length: 95 }, (_, index) => 32 + index);

// ---------------------------------------------------------------- scene / prefab

const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const HEX_DIGITS = '0123456789abcdef';

/** __type__ của component script (uuid nén 23 ký tự) → uuid của file script; '' nếu không phải dạng đó. */
function scriptUuidOfType(type) {
  const id = String(type || '');
  if (!/^[0-9a-f]{5}[A-Za-z0-9+/]{18}$/.test(id)) {
    return '';
  }
  let hex = id.slice(0, 5);
  for (let index = 5; index < 23; index += 2) {
    const left = BASE64_KEYS.indexOf(id[index]);
    const right = BASE64_KEYS.indexOf(id[index + 1]);
    hex += HEX_DIGITS[left >> 2] + HEX_DIGITS[((left & 3) << 2) | (right >> 4)] + HEX_DIGITS[right & 15];
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Tên dễ đọc của một __type__: class của engine giữ nguyên, script của game ra tên file (vd SCLibrary.ts). */
async function typeLabel(ctx, type) {
  const uuid = scriptUuidOfType(type);
  if (!uuid) {
    return type;
  }
  const assetsData = await readJsonMemo(path.join(ctx.projectRoot, 'library', '.assets-data.json'));
  const info = assetsData && assetsData[uuid];
  return info && info.url ? baseName(info.url) : 'script của game';
}

/** Scene / prefab có trong bản build (không xác định được thì mọi scene / prefab của dự án). */
function documentsInBuild(ctx) {
  const urls = ctx.inBuildUrls();
  const inBuild = (ctx.evidence.documents || []).filter((document) => urls.has(document.url));
  return inBuild.length ? inBuild : ctx.evidence.documents || [];
}

/** Các node đang tắt (_active = false) trên đường từ node `index` lên gốc: [] = node đang hiện. */
function inactiveChain(json, index) {
  const inactive = [];
  let current = index;
  for (let guard = 0; json[current] && guard < 128; guard += 1) {
    if (json[current]._active === false) {
      inactive.push(current);
    }
    const parent = json[current]._parent;
    current = parent && typeof parent.__id__ === 'number' ? parent.__id__ : -1;
  }
  return inactive;
}

/** Component của engine tự bật / tắt node mà nó tham chiếu (Toggle: checkMark; EditBox: textLabel / placeholderLabel). */
const NODE_TOGGLING_COMPONENTS = new Set(['cc.Toggle', 'cc.EditBox']);
/** Animation Graph: không đọc graph, coi như có thể đổi `active` của node con. */
const ANIMATION_GRAPH_COMPONENT = 'cc.animation.AnimationController';

/** uuid clip của một component cc.Animation (_clips + _defaultClip). */
function animationClipUuids(component) {
  const refs = [...(Array.isArray(component._clips) ? component._clips : []), component._defaultClip];
  return refs.map((ref) => (ref && typeof ref.__uuid__ === 'string' ? ref.__uuid__.toLowerCase() : '')).filter(Boolean);
}

/**
 * Component trên node có thể bật node con lúc chạy bằng clip không: Animation Graph thì có; cc.Animation thì khi một
 * clip của nó có track `active` (hoặc không đọc được clip: `toggled.clipActive` thiếu uuid đó).
 */
function componentAnimatesActive(component, toggled) {
  if (!component) {
    return false;
  }
  if (component.__type__ === ANIMATION_GRAPH_COMPONENT) {
    return true;
  }
  if (component.__type__ !== 'cc.Animation') {
    return false;
  }
  const clipActive = toggled && toggled.clipActive;
  return animationClipUuids(component).some((uuid) => !clipActive || !clipActive.has(uuid) || clipActive.get(uuid));
}

/**
 * Node / component mà component script của game (hoặc component engine tự bật / tắt node như Toggle, EditBox) tham
 * chiếu tới (thuộc tính kiểu Node / Label...): chúng có thể được bật / tắt lúc chạy. Trả về Set chỉ số trong
 * document, nhớ theo document.
 */
const scriptNodeCache = new WeakMap();
function scriptReferencedIds(document) {
  if (!scriptNodeCache.has(document)) {
    const found = new Set();
    const visit = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 4) {
        return;
      }
      if (typeof value.__id__ === 'number') {
        found.add(value.__id__);
        return;
      }
      for (const item of Object.values(value)) {
        visit(item, depth + 1);
      }
    };
    for (const object of document.json) {
      if (object && object.node && (scriptUuidOfType(object.__type__) || NODE_TOGGLING_COMPONENTS.has(object.__type__))) {
        for (const [key, value] of Object.entries(object)) {
          if (key !== 'node' && key !== '__prefab') {
            visit(value, 0);
          }
        }
      }
    }
    // Node script với tới được: node được tham chiếu (component được tham chiếu thì tính node của nó) và mọi
    // node tổ tiên của chúng (đi lên qua node.parent).
    const reachable = new Set();
    for (const id of found) {
      const object = document.json[id];
      const nodeId = object && object.__type__ === 'cc.Node' ? id : object && object.node && typeof object.node.__id__ === 'number' ? object.node.__id__ : -1;
      for (let current = nodeId, guard = 0; document.json[current] && guard < 128; guard += 1) {
        reachable.add(current);
        const parent = document.json[current]._parent;
        current = parent && typeof parent.__id__ === 'number' ? parent.__id__ : -1;
      }
    }
    scriptNodeCache.set(document, { ids: found, nodes: reachable });
  }
  return scriptNodeCache.get(document);
}

/**
 * Node `index` (đang tắt) có thể được bật lúc chạy không: script tham chiếu chính nó, một node con cháu của nó (đi lên
 * qua parent), hoặc node cha của nó (getChildByName / children); node đó hay node cha có Animation mà clip có track
 * `active` (hoặc Animation Graph); hoặc nó nằm trong prefab mà gốc prefab đang tắt (thường instantiate rồi bật bằng
 * script) hay có nơi đặt prefab này ghi đè `_active` (`toggled`: { all, urls, clipActive } từ prefabsWithActiveOverride).
 */
function scriptCanToggle(document, index, toggled = null) {
  const { ids, nodes } = scriptReferencedIds(document);
  if (ids.has(index) || nodes.has(index)) {
    return true;
  }
  const json = document.json;
  const parent = json[index] && json[index]._parent;
  if (parent && typeof parent.__id__ === 'number' && ids.has(parent.__id__)) {
    return true;
  }
  for (let current = index, guard = 0; json[current] && guard < 128; guard += 1) {
    const node = json[current];
    const components = Array.isArray(node._components) ? node._components : [];
    if (components.some((ref) => ref && typeof ref.__id__ === 'number' && componentAnimatesActive(json[ref.__id__], toggled))) {
      return true;
    }
    current = node._parent && typeof node._parent.__id__ === 'number' ? node._parent.__id__ : -1;
  }
  if (/\.prefab$/i.test(String(document.url || ''))) {
    if (json[index] && !json[index]._parent) {
      return true;
    }
    if (toggled && (toggled.all || toggled.urls.has(document.url))) {
      return true;
    }
  }
  return false;
}

/**
 * Prefab mà một scene / prefab đặt nó (PrefabInstance) có ghi đè `_active` của node bên trong: node tắt trong file
 * prefab có thể đang bật ở chỗ dùng. { all: true } khi không tra được uuid → url (coi như mọi prefab).
 * Kèm `clipActive`: Map uuid clip (của các cc.Animation trong `documents`) → clip có track `active` không; clip không
 * đọc được thì không có trong Map (scriptCanToggle coi như có).
 */
async function prefabsWithActiveOverride(ctx, documents = []) {
  const urls = new Set();
  const clipActive = new Map();
  let all = false;
  let assetsData;
  const clipUuids = new Set();
  for (const document of documents) {
    if (!document.text.includes('"cc.Animation"')) {
      continue;
    }
    for (const object of document.json) {
      if (object && object.__type__ === 'cc.Animation') {
        animationClipUuids(object).forEach((uuid) => clipUuids.add(uuid));
      }
    }
  }
  if (clipUuids.size) {
    assetsData = await readJsonMemo(path.join(ctx.projectRoot, 'library', '.assets-data.json'));
    for (const uuid of clipUuids) {
      const url = assetsData && assetsData[uuid] ? String(assetsData[uuid].url || '') : '';
      if (url.includes('@')) {
        // Clip trong model (FBX / glTF): chỉ có TRS / morph, không đổi active.
        clipActive.set(uuid, false);
      } else if (url.startsWith('db://assets/') && /\.anim$/i.test(url)) {
        const text = await memo(`clip|${url}`, () => readText(path.join(ctx.projectRoot, 'assets', url.slice('db://assets/'.length)))).catch(() => null);
        if (typeof text === 'string') {
          clipActive.set(uuid, text.includes('"active"'));
        }
      }
    }
  }
  for (const document of ctx.evidence.documents || []) {
    if (!document.text.includes('cc.PrefabInstance')) {
      continue;
    }
    const json = document.json;
    const infoByInstance = new Map();
    json.forEach((object) => {
      if (object && object.__type__ === 'cc.PrefabInfo' && object.instance && typeof object.instance.__id__ === 'number') {
        infoByInstance.set(object.instance.__id__, object);
      }
    });
    for (let index = 0; index < json.length; index += 1) {
      const object = json[index];
      if (!object || object.__type__ !== 'cc.PrefabInstance' || !Array.isArray(object.propertyOverrides)) {
        continue;
      }
      const overridesActive = object.propertyOverrides.some((ref) => {
        const override = ref && typeof ref.__id__ === 'number' ? json[ref.__id__] : null;
        return override && Array.isArray(override.propertyPath) && override.propertyPath.includes('_active');
      });
      if (!overridesActive) {
        continue;
      }
      const info = infoByInstance.get(index);
      const uuid = info && info.asset && info.asset.__uuid__ ? String(info.asset.__uuid__).split('@')[0] : '';
      if (assetsData === undefined) {
        assetsData = await readJsonMemo(path.join(ctx.projectRoot, 'library', '.assets-data.json'));
      }
      const url = uuid && assetsData && assetsData[uuid] ? String(assetsData[uuid].url || '') : '';
      if (url) {
        urls.add(url);
      } else {
        all = true;
      }
    }
  }
  return { all, urls, clipActive };
}

function nodePath(json, index) {
  const names = [];
  let node = json[index];
  for (let guard = 0; node && guard < 64; guard += 1) {
    names.unshift(node._name || '?');
    node = node._parent && typeof node._parent.__id__ === 'number' ? json[node._parent.__id__] : null;
  }
  return names.join('/');
}

function referencesUuid(value, uuid, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) {
    return false;
  }
  if (typeof value.__uuid__ === 'string') {
    return value.__uuid__.split('@')[0].toLowerCase() === uuid;
  }
  return Object.values(value).some((item) => referencesUuid(item, uuid, depth + 1));
}

/**
 * Mọi chỗ tham chiếu font `uuid` trong các document: [{ document, label, active, hidden, systemFont, string, path, type }].
 * label = cc.Label / cc.RichText (chữ biết trước), còn lại là component khác (thường là script gán font lúc chạy).
 * active: node và mọi node cha đang bật, component bật. hidden: chắc chắn không hiện - có node tắt trên đường lên gốc
 * mà không gì bật lại được (scriptCanToggle: script / Toggle / EditBox tham chiếu, Animation, gốc prefab, ghi đè
 * `_active` ở chỗ đặt prefab), hoặc component đang tắt.
 */
function findFontReferences(documents, uuid, toggled = null) {
  const found = [];
  for (const document of documents) {
    if (!document.text.toLowerCase().includes(uuid)) {
      continue;
    }
    document.json.forEach((object, objectIndex) => {
      if (!object || typeof object !== 'object' || !object.__type__ || object.__type__ === 'cc.TTFFont') {
        return;
      }
      if (!Object.entries(object).some(([key, value]) => key !== '__type__' && referencesUuid(value, uuid))) {
        return;
      }
      const nodeIndex = object.node && typeof object.node.__id__ === 'number' ? object.node.__id__ : -1;
      const label = object.__type__ === 'cc.Label' || object.__type__ === 'cc.RichText';
      const inactive = nodeIndex >= 0 ? inactiveChain(document.json, nodeIndex) : [];
      found.push({
        document,
        type: object.__type__,
        label,
        active: !inactive.length && object._enabled !== false,
        hidden: (object._enabled === false && !scriptReferencedIds(document).ids.has(objectIndex)) || inactive.some((index) => !scriptCanToggle(document, index, toggled)),
        systemFont: label && object._isSystemFontUsed === true,
        string: label ? String(object._string || '') : '',
        path: nodeIndex >= 0 ? nodePath(document.json, nodeIndex) : document.name,
      });
    });
  }
  return found;
}

// ---------------------------------------------------------------- 1. logo splash

async function splashLogoCheck(ctx) {
  const splash = ctx.settings && ctx.settings.splashScreen;
  if (!splash) {
    return skipped('settings.json của bản build không có splashScreen');
  }
  const typed = splash.logo && typeof splash.logo === 'object';
  const logoType = typed ? String(splash.logo.type || '') : '';
  const encoded = typed ? String(splash.logo.base64 || '') : String(splash.base64src || '');
  if (logoType === 'none' || encoded.length < 4 * KB) {
    return skipped(logoType === 'none' ? 'logo splash đã là None' : 'logo splash nhỏ (dưới 4 KB)');
  }
  const base64 = encoded.replace(/^data:[^,]*,/, '');
  const image = Buffer.from(base64, 'base64');
  const info = imageInfo(image);
  const text = ctx.settingsText;
  const result = await memo(`splash|${crypto.createHash('md5').update(text).digest('hex')}`, async () => {
    const current = await deflatedLength(text);
    const withoutLogo = await deflatedLength(text.split(encoded).join(''));
    let lossless = null;
    if (info.type === 'PNG') {
      const smaller = await recompressPngLossless(image).catch(() => null);
      if (smaller && smaller.length < image.length) {
        const prefix = encoded.slice(0, encoded.length - base64.length);
        lossless = {
          bytes: smaller.length,
          saving: current - await deflatedLength(text.split(encoded).join(prefix + smaller.toString('base64'))),
        };
      }
    }
    return { current, withoutLogo, lossless };
  });
  const noneSaving = Math.max(0, result.current - result.withoutLogo);
  const dims = info.width ? ` ${info.width}×${info.height}` : '';
  const settingsFile = path.relative(ctx.buildRoot, ctx.settingsPath).replace(/\\/g, '/');
  const options = [];
  if (typed) {
    options.push(`Logo: None (giữ màu nền trong ${Math.round(Number(splash.totalTime) || 0)} ms) → giảm ≈ ${formatBytes(noneSaving)}`);
  }
  if (result.lossless && result.lossless.saving >= MIN_SAVING) {
    options.push(`giữ logo nhưng nén lại PNG không mất điểm ảnh nào (${formatBytes(image.length)} → ${formatBytes(result.lossless.bytes)}) → giảm ≈ ${formatBytes(result.lossless.saving)}`);
  } else if (info.type === 'PNG') {
    options.push('giữ logo thì thay bằng PNG palette / ảnh nhỏ hơn (công cụ nén ảnh ngoài)');
  } else {
    options.push(`giữ logo thì thay bằng ảnh ${info.type} nhỏ hơn`);
  }
  // Cocos 3.8: Logo Default / None / Custom. Bản cũ (base64src) không có None: chỉ thay ảnh nhỏ hơn.
  const saving = typed ? noneSaving : (result.lossless ? result.lossless.saving : 0);
  return {
    insights: [{
      id: 'splash-logo',
      group: 'data',
      bytes: encoded.length,
      saving,
      impact: saving ? savingLabel(saving) : 'thay ảnh logo nhỏ hơn',
      basis: `đo: zip lại ${settingsFile} khi ${typed ? 'bỏ logo' : 'nén lại logo'} (logo ${info.type}${dims}, ${formatBytes(image.length)})`,
      title: `Logo splash nhúng base64 ${formatBytes(encoded.length)} trong ${settingsFile}`,
      detail: `Logo màn chờ (${logoType || 'base64src'}) nằm trong settings.json dạng base64 nên builder không đổi nó sang WebP. ${options.join('; ')}. Sửa ở Project Settings → Splash Setting${logoType === 'default' ? ' (logo mặc định của Cocos)' : ''}, rồi build lại.`,
      action: { type: 'open-settings', tab: 'builder', subTab: 'splash-setting', label: 'Mở Splash Setting' },
    }],
  };
}

// ---------------------------------------------------------------- 2. file trùng nhau từng byte

const DUPLICATE_CATEGORIES = new Set(['texture', 'audio', 'font']);

async function duplicateFilesCheck(ctx) {
  const files = ctx.rows.filter((row) => DUPLICATE_CATEGORIES.has(row.category) && row.size >= 512);
  if (files.length < 2) {
    return skipped('bản build không có đủ ảnh / audio / font để so');
  }
  const hashes = await Promise.all(files.map((row) => memo(`md5|${row.fullPath}|${row.size}`, async () => crypto.createHash('md5').update(await fs.readFile(row.fullPath)).digest('hex')).catch(() => '')));
  const groups = new Map();
  files.forEach((row, index) => {
    if (!hashes[index]) {
      return;
    }
    const key = `${row.size}|${hashes[index]}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(row);
  });
  const duplicates = [...groups.values()].filter((group) => group.length > 1 && new Set(group.map((row) => row.source || row.relativePath)).size > 1);
  if (!duplicates.length) {
    return skipped('không có file trùng nhau từng byte');
  }
  let saving = 0;
  const lines = [];
  const urls = [];
  for (const group of duplicates) {
    const extra = group.slice(1);
    const bytes = sum(await Promise.all(extra.map((row) => ctx.zipBytes(row))));
    saving += bytes;
    const names = group.map((row) => baseName(row.source || row.relativePath));
    lines.push(`${names.join(' = ')} (${formatBytes(bytes)} thừa)`);
    urls.push(...group.map((row) => rootUrl(row.source)).filter(Boolean));
  }
  if (saving < MIN_SAVING) {
    return skipped(`file trùng quá nhỏ (≈ ${formatBytes(saving)})`);
  }
  const imageUrls = [...new Set(urls)].filter((url) => /\.(png|jpe?g|webp|bmp)$/i.test(url));
  return {
    insights: [{
      id: 'duplicate-files',
      group: duplicates.every((group) => group[0].category === 'texture') ? 'texture' : 'other',
      bytes: sum(duplicates.flatMap((group) => group.slice(1).map((row) => row.size))),
      saving,
      impact: savingLabel(saving),
      basis: `đo: md5 trùng · phần thừa ${await ctx.sourceLabel()}`,
      title: `${sum(duplicates.map((group) => group.length - 1))} file trong build trùng nội dung với file khác`,
      detail: `${listNames(lines, 4)}. Cùng nội dung nhưng khác asset (khác uuid) nên vào build hai lần. Cho mọi chỗ dùng trỏ chung một asset rồi xoá bản thừa (hoặc để nó khỏi vào build), build lại.`,
      action: imageUrls.length
        ? { type: 'texture', urls: imageUrls, label: 'Chọn các ảnh này' }
        : (urls[0] ? { type: 'reveal', url: urls[0], label: 'Chọn file' } : null),
    }],
  };
}

// ---------------------------------------------------------------- 3. font

async function fontCheck(ctx) {
  const fonts = ctx.rows.filter((row) => row.category === 'font');
  if (!fonts.length) {
    return skipped('không có font trong bản build');
  }
  const documents = documentsInBuild(ctx);
  const toggled = await prefabsWithActiveOverride(ctx, documents).catch(() => ({ all: true, urls: new Set(), clipActive: null }));
  const insights = [];
  const notes = [];
  for (const row of fonts) {
    // Font dựng sẵn của engine (db://internal/default_fonts/...) không có asset nguồn trong assets/.
    const builtin = !row.source && row.builtinRefs && row.builtinRefs[0] ? row.builtinRefs[0] : null;
    const uuid = String(row.sourceUuid || (builtin ? builtin.uuid : '')).split('@')[0].toLowerCase();
    const name = baseName(row.source || (builtin ? builtin.url : row.relativePath));
    const key = row.source || (builtin ? builtin.url : row.relativePath);
    const zip = await ctx.zipBytes(row);
    const refs = uuid ? findFontReferences(documents, uuid, toggled) : [];
    const labels = refs.filter((ref) => ref.label);
    const others = refs.filter((ref) => !ref.label);
    // Nhãn chắc chắn không hiện (node tắt mà không script nào tham chiếu) hoặc đang dùng System Font.
    const unused = labels.filter((ref) => ref.hidden || ref.systemFont);
    if (refs.length && !others.length && unused.length === labels.length) {
      const hidden = unused.filter((ref) => ref.hidden);
      insights.push({
        id: `font-unused:${key}`,
        group: 'font',
        bytes: row.size,
        saving: zip,
        impact: savingLabel(zip),
        basis: `${formatBytes(zip)} ${await ctx.sourceLabel()} · bỏ được cả file nếu không nhãn nào cần`,
        title: `Font ${name} chỉ dùng cho nhãn ${hidden.length ? 'đang tắt' : 'dùng System Font'}`,
        detail: `${listNames(unused.map((ref) => `${ref.path}${ref.string ? ` "${ref.string.slice(0, 24)}"` : ''}${ref.hidden ? ' (tắt)' : ' (System Font)'}`))} trong ${listNames([...new Set(unused.map((ref) => ref.document.name))])}. Node / component tắt trên đường tới các nhãn này không được script, Toggle / EditBox hay clip Animation nào bật lại nên sẽ không hiện, trừ khi script tìm node theo tên từ chỗ khác (find) hoặc gán clip khác lúc chạy. Xoá nhãn hoặc đổi font của nó sang font khác đang dùng để font này rơi khỏi build.`,
        action: { type: 'reveal', url: unused[0].document.url, label: `Chọn ${unused[0].document.name}` },
      });
      continue;
    }
    if (builtin && !labels.length) {
      // Font dựng sẵn mà không nhãn nào chọn: do engine / asset khác kéo vào, không sửa được từ dự án.
      notes.push(`${name}: font dựng sẵn của engine, không thấy nhãn nào dùng`);
      continue;
    }
    const data = await memoLatest(`font|${row.fullPath}`, row.size, () => fs.readFile(row.fullPath)).catch(() => null);
    const font = data ? parseSfnt(data) : null;
    if (!font || !font.numGlyphs) {
      notes.push(`${name}: không đọc được bảng glyph (WOFF / font lạ)`);
      continue;
    }
    const used = new Set();
    for (const ref of labels) {
      for (const char of ref.string.replace(ref.type === 'cc.RichText' ? /<[^>]*>/g : /$^/g, '')) {
        const code = char.codePointAt(0);
        if (code >= 32) {
          used.add(code);
        }
      }
    }
    const keep = [...new Set([...used, ...ASCII_PRINTABLE])].sort((left, right) => left - right);
    const estimate = estimateSubset(font, keep);
    const ratio = Math.min(1, estimate.bytes / data.length);
    const saving = Math.round(zip * (1 - ratio));
    // Font gần như chỉ còn bộ ASCII (đã cắt sẵn) thì cắt nữa không đáng.
    if (saving < 2 * MIN_SAVING || ratio > 0.8) {
      notes.push(`${name}: cắt font chỉ giảm ≈ ${formatBytes(saving)} (${font.numGlyphs} glyph)`);
      continue;
    }
    const nonAscii = [...used].filter((code) => code > 126);
    const strings = [...new Set(labels.map((ref) => ref.string.replace(/\s+/g, ' ').trim()).filter(Boolean))];
    const sample = listNames(strings.map((text) => `"${text.length > 30 ? `${text.slice(0, 30)}…` : text}"`), 6);
    const otherTypes = [];
    for (const type of new Set(others.map((ref) => ref.type))) {
      otherTypes.push(await typeLabel(ctx, type));
    }
    const how = builtin
      ? `Đây là font dựng sẵn của engine (${builtin.url.replace(/^db:\/\/internal\//, '')}) nên không ghi đè được: muốn giữ kiểu chữ thì chép font ra assets/, cắt chỉ giữ các ký tự này + ASCII in được (${keep.length} ký tự) bằng pyftsubset (fontTools) rồi gán cho các nhãn; hoặc tick Use System Font ở các nhãn để bỏ hẳn font khỏi build (≈ ${formatBytes(zip)}).`
      : `Cắt font chỉ giữ các ký tự này + ASCII in được (${keep.length} ký tự${nonAscii.length ? `, kể cả ${nonAscii.length} ký tự ngoài ASCII` : ''}) bằng pyftsubset (fontTools), ghi đè đúng file để giữ .meta / uuid, rồi xem lại chữ trên trình duyệt.`;
    const firstLabel = labels[0];
    insights.push({
      id: `font-subset:${key}`,
      group: 'font',
      bytes: row.size,
      saving,
      impact: savingLabel(saving),
      basis: `${formatBytes(zip)} ${await ctx.sourceLabel()} · ước tính: giữ ${estimate.glyphs}/${font.numGlyphs} glyph còn ≈ ${percent(ratio)} file`,
      title: labels.length
        ? `${builtin ? 'Font dựng sẵn' : 'Font'} ${name}: ${font.numGlyphs} glyph nhưng nhãn chỉ dùng ${used.size} ký tự`
        : `Font ${name}: ${font.numGlyphs} glyph, không nhãn nào trong scene / prefab dùng trực tiếp`,
      detail: `${labels.length ? `${labels.length} nhãn dùng font này: ${sample || '(chữ trống)'}.` : 'Không thấy cc.Label / cc.RichText nào trong scene / prefab dùng font này.'}${others.length ? ` ${others.length} component khác (${listNames(otherTypes, 2)}) giữ font: chữ do script gán lúc chạy không biết trước.` : ' Chữ gán từ script lúc chạy không biết trước.'} ${how} Font cắt thiếu bảng cmap / name / OS/2 sẽ bị trình duyệt từ chối.`,
      action: row.source
        ? { type: 'reveal', url: rootUrl(row.source), label: 'Chọn font' }
        : (firstLabel ? { type: 'reveal', url: firstLabel.document.url, label: `Chọn ${firstLabel.document.name}` } : null),
    });
  }
  return { insights, skipped: insights.length ? '' : (notes.join('; ') || 'font đã gọn') };
}

// ---------------------------------------------------------------- 4. tuỳ chọn build

async function buildOptionChecks(ctx) {
  const insights = [];
  const notes = [];
  const options = await ctx.taskOptions();
  const engineRows = ctx.rows.filter((row) => row.category === 'engine-js');
  const engineZip = sum(await Promise.all(engineRows.map((row) => ctx.zipBytes(row))));

  // Debug: settings.json ghi engine.debug (3.8), hoặc build task bật debug.
  const debug = (ctx.settings && ctx.settings.engine && ctx.settings.engine.debug === true) || (options && options.debug === true);
  if (debug && engineZip) {
    const saving = Math.round(engineZip * DEBUG_ENGINE_SAVING);
    insights.push({
      id: 'build-debug',
      group: 'engine',
      bytes: sum(engineRows.map((row) => row.size)),
      saving,
      impact: savingLabel(saving),
      basis: `mã engine ${formatBytes(engineZip)} ${await ctx.sourceLabel()} · ước tính bản release nhỏ hơn ≈ ${percent(DEBUG_ENGINE_SAVING)} (đo một dự án: −33%)`,
      title: 'Bản build đang bật Debug',
      detail: 'Bản Debug giữ nguyên tên biến, log và kiểm tra lỗi của engine nên mã engine to hơn nhiều. Build panel → bỏ tick Debug rồi build lại (chỉ bật khi cần dò lỗi).',
      action: OPEN_BUILD,
    });
  }

  // Source map: file .map trong build (builder zip mọi file) hoặc source map nhúng trong file js.
  const mapRows = ctx.rows.filter((row) => row.extension === '.map');
  let inline = 0;
  for (const row of ctx.rows.filter((item) => item.extension === '.js' && item.size < 32 * 1024 * 1024)) {
    inline += await memo(`inline-map|${row.fullPath}|${row.size}`, async () => {
      const text = await readText(row.fullPath);
      const match = /sourceMappingURL=data:[^,]*,([A-Za-z0-9+/=]+)/.exec(text);
      return match ? deflatedLength(match[1]) : 0;
    }).catch(() => 0);
  }
  const mapZip = sum(await Promise.all(mapRows.map((row) => ctx.zipBytes(row)))) + inline;
  if (mapZip >= MIN_SAVING) {
    insights.push({
      id: 'build-sourcemaps',
      group: 'engine',
      bytes: sum(mapRows.map((row) => row.size)),
      saving: mapZip,
      impact: savingLabel(mapZip),
      basis: `đo: ${mapRows.length} file .map${inline ? ' + source map nhúng trong js' : ''} sau zip`,
      title: 'Bản build có Source Maps',
      detail: 'Source map chỉ để dò lỗi, người chơi không cần, mà builder vẫn đóng gói nó. Build panel → Source Maps: tắt, rồi build lại.',
      action: OPEN_BUILD,
    });
  }

  // asm.js: Native Code Bundle Mode = Both (wasm + asm.js dự phòng) hoặc chỉ asm.js. Ô này có từ Cocos 3.8.
  // Bản asm.js thật (chế độ Wasm vẫn để lại một file asm.js rỗng vài trăm byte cho mỗi module).
  const allAsmRows = engineRows.filter((row) => /\.asm[.-]/i.test(row.name) && row.size > 4 * KB);
  // Cùng module có cả .wasm (vd bullet.release.asm-*.js ↔ bullet.release.wasm-*.wasm, spine.asm-*.js ↔ spine-*.wasm).
  const hasWasmFor = (row) => {
    const prefix = row.name.toLowerCase().split('.asm')[0];
    return ctx.rows.some((other) => other.extension === '.wasm' && String(other.name || '').toLowerCase().startsWith(prefix));
  };
  const pairedAsmRows = allAsmRows.filter(hasWasmFor);
  const hasWasm = pairedAsmRows.length > 0;
  const asmRows = hasWasm ? pairedAsmRows : allAsmRows;
  if (asmRows.length) {
    const asmZip = sum(await Promise.all(asmRows.map((row) => ctx.zipBytes(row))));
    const version = String((ctx.settings && ctx.settings.CocosEngine) || '');
    const [major, minor] = version.split('.').map(Number);
    const hasOption = !version || major > 3 || (major === 3 && minor >= 8);
    const names = listNames(asmRows.map((row) => row.name), 2);
    let saving = 0;
    let basis = '';
    let detail = '';
    if (hasWasm) {
      saving = asmZip;
      basis = `đo: ${names} · ${formatBytes(asmZip)} ${await ctx.sourceLabel()}, bỏ được hẳn`;
      detail = `Native Code Bundle Mode = Both: build kèm bản asm.js (${names}) chỉ dành cho trình duyệt không có WebAssembly (rất cũ, gần như không còn). Build panel → Native Code Bundle Mode: Wasm, rồi build lại và thử một lần trên các mạng đang nộp.`;
    } else if (hasOption) {
      saving = Math.round(asmZip * ASM_TO_WASM_SAVING);
      basis = `${formatBytes(asmZip)} asm.js ${await ctx.sourceLabel()} · ước tính bản wasm nhỏ hơn ≈ ${percent(ASM_TO_WASM_SAVING)}`;
      detail = 'Build panel → Native Code Bundle Mode: Wasm (wasm nhỏ và chạy nhanh hơn asm.js), rồi build lại và thử một lần trên các mạng đang nộp.';
    } else {
      basis = `${formatBytes(asmZip)} asm.js ${await ctx.sourceLabel()} · Cocos ${version} chưa có ô Native Code Bundle Mode`;
      detail = `${names} là bản asm.js của module vật lý / Spine đang chọn. Cocos ${version} chưa cho chọn Wasm khi build; muốn nhỏ hơn thì xem module đó có backend nhẹ hơn không (Project Settings → Feature Cropping) hoặc nâng lên Cocos 3.8.`;
    }
    insights.push({
      id: 'build-asmjs',
      group: 'engine',
      bytes: sum(asmRows.map((row) => row.size)),
      saving,
      impact: saving ? savingLabel(saving) : 'thông tin',
      basis,
      title: hasWasm ? 'Mã vật lý / Spine bị đóng gói 2 bản: WebAssembly và asm.js dự phòng' : `Mã vật lý / Spine đang ở dạng asm.js (${formatBytes(asmZip)} sau zip)`,
      detail,
      action: OPEN_BUILD,
    });
  }

  // MD5 Cache: tên file dài thêm 6 ký tự (header zip của mỗi file) + bảng versions trong config.json.
  const hashed = ctx.rows.filter((row) => stableBuildPath(row.relativePath) !== row.relativePath.replace(/\\/g, '/'));
  if (hashed.length >= 5 || (options && options.md5Cache === true)) {
    let versions = 0;
    for (const row of ctx.rows.filter((item) => item.category === 'config')) {
      const json = await readJsonMemo(row.fullPath);
      if (json && json.versions) {
        versions += await deflatedLength(JSON.stringify(json.versions));
      }
    }
    const saving = hashed.length * 12 + versions;
    if (saving >= 512) {
      insights.push({
        id: 'build-md5cache',
        group: 'data',
        bytes: saving,
        saving,
        impact: savingLabel(saving),
        basis: `đo: ${hashed.length} file mang hậu tố md5 (+12 B header zip mỗi file) + bảng versions trong config.json`,
        title: 'Bản build bật MD5 Cache',
        detail: 'MD5 Cache đổi tên file để CDN không dùng bản cũ; playable gói thành một file nên không cần. Build panel → bỏ tick MD5 Cache, rồi build lại.',
        action: OPEN_BUILD,
      });
    }
  }

  // Main Bundle Compression Type: nhiều file JSON import riêng lẻ trong bundle main.
  const jsonRows = ctx.rows.filter((row) => row.buildArea === 'main bundle' && row.category === 'import-json');
  if (options && options.mainBundleCompressionType === 'merge_all_json') {
    notes.push('Main Bundle Compression Type đã là Merge All JSON');
  } else if (jsonRows.length >= 4) {
    const key = jsonRows.map((row) => `${row.relativePath}:${row.size}`).join('|');
    const simulated = await memo(`merge-json|${crypto.createHash('md5').update(key).digest('hex')}`, async () => {
      const texts = await Promise.all(jsonRows.map((row) => fs.readFile(row.fullPath)));
      const separate = sum(await Promise.all(texts.map((text) => deflatedLength(text)))) + sum(jsonRows.map((row) => zipHeaderBytes(row.relativePath)));
      const merged = await deflatedLength(Buffer.concat(texts)) + zipHeaderBytes('assets/main/import/00/merged.json');
      return { separate, merged };
    });
    const saving = Math.max(0, simulated.separate - simulated.merged);
    if (saving >= MIN_SAVING) {
      insights.push({
        id: 'build-merge-json',
        group: 'data',
        bytes: sum(jsonRows.map((row) => row.size)),
        saving,
        impact: savingLabel(saving),
        basis: `mô phỏng: gộp ${jsonRows.length} file JSON rồi zip lại (${formatBytes(simulated.separate)} → ${formatBytes(simulated.merged)}), chưa build thử`,
        title: `${jsonRows.length} file JSON import riêng lẻ trong bundle main`,
        detail: `Mỗi file trong zip tốn thêm header và nén riêng kém hơn nén chung${options ? ` (đang là ${options.mainBundleCompressionType || 'mặc định'})` : ''}. Build panel → Main Bundle Compression Type: Merge All JSON gộp chúng thành một file; playable vốn tải hết lúc mở nên không chậm hơn. Build lại rồi mở thử một bản HTML.`,
        action: OPEN_BUILD,
      });
    }
  }

  // Bin Group: gộp AnimationClip dạng .cconb nhỏ thành một file (builder 3.8).
  const binGroup = options && options.binGroupConfig;
  if (binGroup && binGroup.enable === false) {
    const threshold = (Number(binGroup.threshold) || 16) * KB;
    const small = ctx.rows.filter((row) => row.extension === '.cconb' && row.size < threshold);
    if (small.length >= 5) {
      const texts = await Promise.all(small.map((row) => fs.readFile(row.fullPath)));
      const separate = sum(await Promise.all(texts.map((text) => deflatedLength(text)))) + sum(small.map((row) => zipHeaderBytes(row.relativePath)));
      const merged = await deflatedLength(Buffer.concat(texts)) + zipHeaderBytes('assets/main/import/00/group.cconb');
      const saving = Math.max(0, separate - merged);
      if (saving >= MIN_SAVING) {
        insights.push({
          id: 'build-bin-group',
          group: 'data',
          bytes: sum(small.map((row) => row.size)),
          saving,
          impact: savingLabel(saving),
          basis: `mô phỏng: gộp ${small.length} file .cconb rồi zip lại, chưa build thử`,
          title: `${small.length} AnimationClip nhỏ (.cconb dưới ${formatBytes(threshold)}) nằm riêng lẻ`,
          detail: 'Build panel → BIN Group Configuration → bật Merge all AnimationClip files để gộp chúng thành một file, rồi build lại.',
          action: OPEN_BUILD,
        });
      }
    }
  }

  // Mangle Properties (builder 3.8 có ô này): chỉ biết khi có build task của người dùng.
  if (options && options.mangleProperties === false && engineZip && !debug) {
    const saving = Math.round(engineZip * MANGLE_ENGINE_SAVING);
    if (saving >= MIN_SAVING) {
      insights.push({
        id: 'build-mangle',
        group: 'engine',
        bytes: 0,
        saving,
        impact: savingLabel(saving),
        basis: `mã engine ${formatBytes(engineZip)} ${await ctx.sourceLabel()} · ước tính ≈ ${percent(MANGLE_ENGINE_SAVING)} (đo trên engine 3.8.8)`,
        title: 'Mangle Engine Internal Properties đang tắt',
        detail: 'Bật thì engine đổi tên ngắn các thuộc tính nội bộ. Script nào truy cập thuộc tính nội bộ của engine (tên bắt đầu bằng _ ) có thể hỏng: build xong phải chơi thử trọn luồng; tên nào hỏng thì thêm vào engine-mangle-config.json ở gốc dự án. Build panel → tick Mangle Engine Internal Properties.',
        action: OPEN_BUILD,
      });
    }
  }
  if (!options) {
    notes.push('chưa có build task trong profiles/v2/packages/builder.json (theo máy): bỏ qua Mangle Properties / BIN Group');
  }
  return { insights, skipped: notes.join('; ') };
}

// ---------------------------------------------------------------- 5. cấu hình xuất của playable-ads-builder

const IMAGE_FILE = /\.(webp|png|jpe?g)$/i;
const AUDIO_FILE = /\.(mp3|ogg|wav|m4a|aac|flac)$/i;

async function builderExportChecks(ctx) {
  const config = await ctx.exportConfig();
  if (!config) {
    return skipped('dự án không xuất qua playable-ads-builder (hoặc chưa có build task đặt Name)');
  }
  const exported = await ctx.exportInfo();
  const insights = [];
  const notes = [];
  const fromSettings = config.assumedFrom === 'settings';
  const assumedNote = !config.assumed ? ''
    : fromSettings
      ? ' · theo cấu hình builder lưu trong dự án (settings/v2/packages/playable-ads-builder.json; máy này chưa có build task)'
      : ' · theo cấu hình mặc định của builder (máy này chưa có build task, dự án chưa lưu cấu hình builder)';
  if (config.assumed) {
    notes.push(fromSettings
      ? `máy này chưa có build task: dùng cấu hình builder lưu trong dự án (${config.compression.type} q${config.compression.quality} / ${config.audio.enabled ? `${config.audio.bitrate} kbps` : 'giữ audio'})`
      : 'chưa có cấu hình playable-ads-builder trên máy này: dùng mặc định lossy q80 / 64 kbps');
  }

  // Ảnh: phần ảnh trong bản xuất (WebP của builder) hoặc ảnh trong build khi chưa xuất.
  const textureRows = ctx.rows.filter((row) => row.category === 'texture');
  const imageZip = exported
    ? sum(exported.files.filter((file) => IMAGE_FILE.test(file.path)).map((file) => file.zipBytes))
    : sum(await Promise.all(textureRows.map((row) => ctx.zippedSize(row))));
  const { type, quality } = config.compression;
  const imageBasis = exported ? `ảnh ${formatBytes(imageZip)} trong zip của ${exported.item.name}` : `ảnh ${formatBytes(imageZip)} trong build (chưa có bản xuất)`;
  let imageSaving = 0;
  let imageAdvice = '';
  let imageRatio = '';
  if (type === 'none') {
    imageSaving = Math.round(imageZip * WEBP_FROM_NONE);
    imageRatio = `ước tính WebP lossy còn ≈ ${percent(1 - WEBP_FROM_NONE)}`;
    imageAdvice = 'Builder đang xuất ảnh nguyên bản (không nén). Chọn Compression Type: Lossy (WebP), Quality 75–80.';
  } else if (type === 'lossless') {
    imageSaving = Math.round(imageZip * WEBP_FROM_LOSSLESS);
    imageRatio = `ước tính WebP lossy nhỏ hơn lossless ≈ ${percent(WEBP_FROM_LOSSLESS)}`;
    imageAdvice = 'Builder đang xuất WebP lossless. Chọn Compression Type: Lossy, Quality 75–80 (soát lại ảnh có chữ / nét mảnh).';
  } else if (quality > SUGGESTED_WEBP_QUALITY + 2) {
    const fraction = Math.min(0.35, WEBP_Q80_TO_Q75 * (quality - SUGGESTED_WEBP_QUALITY) / 5);
    imageSaving = Math.round(imageZip * fraction);
    imageRatio = `ước tính −${percent(fraction)} (đo một dự án: q80 → q75 giảm ${percent(WEBP_Q80_TO_Q75)})`;
    imageAdvice = `Builder đang xuất WebP lossy q${quality}. Hạ Compression Quality xuống ${SUGGESTED_WEBP_QUALITY}: ảnh mềm đi chút ít (soát nền lớn, ảnh có chữ trong bản Video / HTML trước khi gửi).`;
  } else {
    notes.push(`ảnh xuất WebP lossy q${quality}: đã đủ thấp`);
  }
  if (!exported && type !== 'none') {
    imageSaving = Math.round(imageSaving * WEBP_OF_BUILD_PNG);
    imageRatio += ` × ${percent(WEBP_OF_BUILD_PNG)} (WebP thường còn khoảng ½ PNG trong build)`;
  }
  if (imageSaving >= MIN_SAVING) {
    insights.push({
      id: 'builder-image-quality',
      group: 'texture',
      bytes: Math.round(imageZip),
      saving: imageSaving,
      impact: savingLabel(imageSaving),
      basis: `${imageBasis} · ${imageRatio}${assumedNote}`,
      title: `Ảnh của bản xuất: ${type === 'lossy' ? `WebP lossy q${quality}` : type === 'lossless' ? 'WebP lossless' : 'không nén'}`,
      detail: `${imageAdvice} Sửa ở Build panel → phần playable-ads-builder → Compression Type / Compression Quality, rồi build lại (áp cho mọi mạng).`,
      action: OPEN_BUILD,
    });
  }

  // Audio: builder encode lại mọi audio ở bitrate của nó (CBR) → phần audio tỉ lệ thẳng với bitrate.
  const audioRows = ctx.rows.filter((row) => row.category === 'audio');
  if (audioRows.length) {
    const durations = new Map((ctx.audio || []).map((file) => [file.url, file.probe ? Number(file.probe.durationSeconds) || 0 : 0]));
    const audioSeconds = sum(audioRows.map((row) => durations.get(rootUrl(row.source)) || 0));
    const measured = exported ? sum(exported.files.filter((file) => AUDIO_FILE.test(file.path)).map((file) => file.zipBytes)) : 0;
    if (!config.audio.enabled) {
      const current = measured || sum(await Promise.all(audioRows.map((row) => ctx.zippedSize(row))));
      const target = audioSeconds * 64 * 1000 / 8;
      const saving = audioSeconds ? Math.round(Math.max(0, current - target)) : 0;
      if (saving >= MIN_SAVING) {
        insights.push({
          id: 'builder-audio-bitrate',
          group: 'audio',
          bytes: Math.round(current),
          saving,
          impact: savingLabel(saving),
          basis: `audio ${formatBytes(current)} · ước tính theo thời lượng ${Math.round(audioSeconds)} s × 64 kbps${assumedNote}`,
          title: 'Builder đang tắt nén audio khi xuất',
          detail: 'Audio đi nguyên vào bản xuất. Build panel → phần playable-ads-builder → bật nén audio (Audio Bitrate 48–64 kbps), rồi build lại.',
          action: OPEN_BUILD,
        });
      }
    } else if (config.audio.bitrate > SUGGESTED_AUDIO_KBPS) {
      const current = measured || audioSeconds * config.audio.bitrate * 1000 / 8;
      const saving = Math.round(current * (1 - SUGGESTED_AUDIO_KBPS / config.audio.bitrate));
      if (current && saving >= MIN_SAVING) {
        insights.push({
          id: 'builder-audio-bitrate',
          group: 'audio',
          bytes: Math.round(current),
          saving,
          impact: savingLabel(saving),
          basis: `${measured ? `đo: audio ${formatBytes(measured)} trong zip của ${exported.item.name}` : `ước tính theo thời lượng ${Math.round(audioSeconds)} s`} · MP3 CBR tỉ lệ với bitrate (${config.audio.bitrate} → ${SUGGESTED_AUDIO_KBPS} kbps)${assumedNote}`,
          title: `Audio của bản xuất: ${config.audio.bitrate} kbps`,
          detail: `Builder encode lại MỌI audio ở Audio Bitrate của nó, nên chỉ ô này đổi được phần audio của file HTML (hạ bitrate từng file trong assets/ không có tác dụng). Hạ xuống ${SUGGESTED_AUDIO_KBPS} kbps: tiếng hơi đục hơn ở dải cao, khó nghe ra trên loa điện thoại. Không cộng thẳng với gợi ý cắt nhạc. Build panel → phần playable-ads-builder → Audio Bitrate.`,
          action: OPEN_BUILD,
        });
      }
    } else {
      notes.push(`audio xuất ${config.audio.bitrate} kbps: đã đủ thấp`);
    }
  }
  return { insights, skipped: notes.join('; ') };
}

// ---------------------------------------------------------------- 6. PNG palette trên ảnh đục khi builder đổi WebP

async function paletteOnOpaqueCheck(ctx) {
  const config = await ctx.exportConfig();
  if (!config || config.compression.type === 'none') {
    return skipped(config ? 'builder không đổi ảnh sang WebP' : 'không xuất qua playable-ads-builder');
  }
  if (!ctx.textures || !ctx.textures.length) {
    return skipped('chưa quét ảnh nguồn');
  }
  const presets = await readPresets(ctx.projectRoot).catch(() => []);
  const palette = new Set(presets
    .filter((preset) => Object.keys((preset.options && (preset.options.web || preset.options['web-mobile'])) || {}).includes('png'))
    .map((preset) => preset.id));
  if (!palette.size) {
    return skipped('không có preset Texture Compress PNG cho web');
  }
  const rowsBySource = new Map();
  for (const row of ctx.rows.filter((item) => item.category === 'texture' && item.source)) {
    const url = rootUrl(row.source);
    rowsBySource.set(url, (rowsBySource.get(url) || []).concat(row));
  }
  const candidates = [];
  for (const texture of ctx.textures) {
    if (!texture.enabled || !palette.has(texture.presetId) || !rowsBySource.has(texture.url)) {
      continue;
    }
    const jpg = /\.jpe?g$/i.test(texture.extension);
    const meta = jpg ? null : await readJsonMemo(`${texture.fullPath}.meta`);
    if (!jpg && !(meta && meta.userData && meta.userData.hasAlpha === false)) {
      continue;
    }
    // Cocos giữ ảnh gốc khi bản palette không nhỏ hơn: file trong build bằng đúng ảnh nguồn thì tắt nén chẳng đổi gì.
    const rows = rowsBySource.get(texture.url);
    if (!jpg && rows.every((row) => row.size === texture.bytes)) {
      continue;
    }
    candidates.push({ texture, jpg, rows });
  }
  if (!candidates.length) {
    return skipped('không có ảnh jpg / ảnh không alpha nào bật PNG palette');
  }
  const exported = await ctx.exportInfo();
  let saving = 0;
  let bytes = 0;
  for (const item of candidates) {
    const zip = sum(await Promise.all(item.rows.map((row) => ctx.zipBytes(row))));
    const inExport = exported ? zip : zip * WEBP_OF_BUILD_PNG;
    bytes += inExport;
    saving += inExport * (item.jpg ? PALETTE_JPG_SAVING : PALETTE_OPAQUE_SAVING);
  }
  saving = Math.round(saving);
  if (saving < MIN_SAVING) {
    return skipped(`ảnh đục bật PNG palette giảm được quá ít (≈ ${formatBytes(saving)})`);
  }
  const jpgCount = candidates.filter((item) => item.jpg).length;
  return {
    insights: [{
      id: 'texture-palette-opaque',
      group: 'texture',
      bytes: Math.round(bytes),
      saving,
      impact: savingLabel(saving),
      basis: `${formatBytes(bytes)} ảnh ${exported ? `trong zip của ${exported.item.name}` : 'ước tính sau WebP'} · ước tính −${percent(PALETTE_JPG_SAVING)} với jpg, −${percent(PALETTE_OPAQUE_SAVING)} với ảnh đục`,
      title: `${candidates.length} ảnh ${jpgCount ? `(${jpgCount} jpg) ` : ''}không có alpha mà vẫn bật PNG palette`,
      detail: `${listNames(candidates.map((item) => baseName(item.texture.url)))}. Builder đổi ảnh trong build sang WebP; với ảnh đục, PNG palette (Texture Compress PNG) thêm nốt dither làm WebP to hơn${jpgCount ? ', còn jpg bị đổi thành png to hơn hẳn' : ''}. Tắt Texture Compress cho các ảnh này để builder làm WebP thẳng từ ảnh gốc (ảnh có alpha mềm như hiệu ứng, nhân vật thì giữ).`,
      action: { type: 'texture', urls: candidates.map((item) => item.texture.url), label: 'Chọn các ảnh này' },
    }],
  };
}

// ---------------------------------------------------------------- 7. Spine lưu dạng JSON

/** Vị trí kết thúc (sau `}`) của object JSON bắt đầu ở `start`, bỏ qua ngoặc trong chuỗi. */
function matchObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (code === 92) {
        escaped = true;
      } else if (code === 34) {
        inString = false;
      }
      continue;
    }
    if (code === 34) {
      inString = true;
    } else if (code === 123) {
      depth += 1;
    } else if (code === 125) {
      depth -= 1;
      if (!depth) {
        return index + 1;
      }
    }
  }
  return -1;
}

const SKELETON_MARKER = '{"skeleton":{';

async function spineJsonCheck(ctx) {
  const jsonRows = ctx.rows.filter((row) => row.category === 'import-json');
  const skeletons = [];
  for (const row of jsonRows) {
    const found = await memo(`spine|${row.fullPath}|${row.size}`, async () => {
      const text = await readText(row.fullPath);
      const items = [];
      for (let start = text.indexOf(SKELETON_MARKER); start >= 0; start = text.indexOf(SKELETON_MARKER, start + 1)) {
        const end = matchObjectEnd(text, start);
        if (end < 0) {
          break;
        }
        const body = text.slice(start, end);
        let skins = 0;
        let animations = 0;
        let hash = '';
        let version = '';
        try {
          const json = JSON.parse(body);
          skins = Array.isArray(json.skins) ? json.skins.length : Object.keys(json.skins || {}).length;
          animations = Object.keys(json.animations || {}).length;
          hash = String(json.skeleton && json.skeleton.hash || '');
          version = String(json.skeleton && json.skeleton.spine || '');
        } catch (_error) {
          // Không parse được vẫn tính dung lượng.
        }
        items.push({ raw: Buffer.byteLength(body), zip: await deflatedLength(body), skins, animations, hash, version });
        start = end - 1;
      }
      return items;
    }).catch(() => []);
    skeletons.push(...found);
  }
  if (!skeletons.length) {
    return skipped('không có skeleton Spine dạng JSON trong build');
  }
  // Tên asset: so skeleton.hash với file .json nguồn nằm trong các pack của build.
  const names = new Map();
  for (const url of new Set(jsonRows.flatMap((row) => (row.packedSources || []).map((source) => rootUrl(source.url))).filter((url) => /\.json$/i.test(url)))) {
    const file = path.join(ctx.projectRoot, 'assets', url.replace(/^db:\/\/assets\//, ''));
    const head = await memo(`spine-head|${file}`, async () => {
      const handle = await fs.open(file, 'r');
      try {
        const buffer = Buffer.alloc(400);
        const { bytesRead } = await handle.read(buffer, 0, 400, 0);
        return buffer.toString('utf8', 0, bytesRead);
      } finally {
        await handle.close();
      }
    }).catch(() => '');
    const match = /"hash"\s*:\s*"([^"]+)"/.exec(head);
    if (match) {
      names.set(match[1], url);
    }
  }
  const zip = sum(skeletons.map((item) => item.zip));
  const saving = Math.round(zip * SPINE_JSON_SAVING);
  if (saving < MIN_SAVING) {
    return skipped(`skeleton Spine JSON nhỏ (${formatBytes(zip)} sau zip)`);
  }
  const sorted = skeletons.slice().sort((left, right) => right.zip - left.zip);
  const describe = (item) => `${names.has(item.hash) ? baseName(names.get(item.hash)) : 'skeleton'} (${formatBytes(item.zip)} sau zip, ${item.skins} skin, ${item.animations} animation)`;
  const top = sorted.find((item) => names.has(item.hash));
  return {
    insights: [{
      id: 'spine-json',
      group: 'data',
      bytes: sum(skeletons.map((item) => item.raw)),
      saving,
      impact: savingLabel(saving),
      basis: `đo: ${skeletons.length} skeleton JSON ${formatBytes(zip)} sau zip · ước tính −${percent(SPINE_JSON_SAVING)} (đo một dự án: làm tròn số −21%, .skel nhị phân −14%)`,
      title: `${skeletons.length} skeleton Spine lưu dạng JSON (${formatBytes(sum(skeletons.map((item) => item.raw)))})`,
      detail: `${listNames(sorted.map(describe))}. Cách giảm: xuất lại từ Spine dạng Binary (.skel, cùng phiên bản ${listNames([...new Set(skeletons.map((item) => item.version).filter(Boolean))], 2) || 'Spine'}) hoặc bỏ tick Nonessential data, bỏ skin / animation không dùng; mỗi skin bỏ được là bớt cả JSON lẫn ảnh atlas của nó.`,
      action: top ? { type: 'reveal', url: names.get(top.hash), label: 'Chọn skeleton' } : null,
    }],
  };
}

// ---------------------------------------------------------------- 8. tangent không shader nào đọc

/** Số byte của format đỉnh RGBA (gfx Format): RGBA8* = 4, RGBA16* = 8, RGBA32* = 16. */
const RGBA_FORMAT_BYTES = { 35: 4, 36: 4, 37: 4, 38: 4, 39: 4, 40: 4, 41: 8, 42: 8, 43: 8, 44: 16, 45: 16, 46: 16 };
const TANGENT_DECLARATION = /^\s*(?:layout\s*\([^)]*\)\s*)?(?:in|attribute)\s+(?:(?:highp|mediump|lowp)\s+)?\w+\s+a_tangent\s*;/;

function libraryJsonPath(projectRoot, uuid) {
  return path.join(projectRoot, 'library', uuid.slice(0, 2), `${uuid}.json`);
}

/** Effect có đọc a_tangent trong vertex shader không (ngoài dòng khai báo): true / false / null (không đọc được). */
async function effectReadsTangent(projectRoot, uuid) {
  const json = await readJsonMemo(libraryJsonPath(projectRoot, uuid));
  const shaders = json && Array.isArray(json.shaders) ? json.shaders : null;
  if (!shaders || !shaders.length) {
    return null;
  }
  for (const shader of shaders) {
    for (const key of ['glsl3', 'glsl1', 'glsl4']) {
      const source = shader[key] && shader[key].vert;
      if (typeof source === 'string' && source.split('\n').some((line) => /\ba_tangent\b/.test(line) && !TANGENT_DECLARATION.test(line))) {
        return true;
      }
    }
  }
  return false;
}

async function tangentCheck(ctx) {
  const meshRows = ctx.rows.filter((row) => row.category === 'model-bin' && row.source);
  if (!meshRows.length) {
    return skipped('không có mesh 3D trong build');
  }
  const assetsData = await readJsonMemo(path.join(ctx.projectRoot, 'library', '.assets-data.json'));
  if (!assetsData) {
    return skipped('chưa có library/.assets-data.json');
  }
  const internalData = (await readJsonMemo(path.join(ctx.projectRoot, 'library', '.internal-data.json'))) || {};
  const infoOf = (uuid) => assetsData[uuid] || internalData[uuid] || null;
  const dependsOf = (uuid) => {
    const info = infoOf(uuid);
    return info && info.value && Array.isArray(info.value.depends) ? info.value.depends.map(String) : [];
  };
  const dependents = await memoLatest(`dependents|${ctx.projectRoot}`, await statKey(path.join(ctx.projectRoot, 'library', '.assets-data.json')), () => {
    const map = new Map();
    for (const [uuid, info] of Object.entries(assetsData)) {
      for (const dependency of (info && info.value && info.value.depends) || []) {
        const key = String(dependency).toLowerCase();
        if (!map.has(key)) {
          map.set(key, []);
        }
        map.get(key).push(uuid);
      }
    }
    return map;
  });
  const typeOf = async (uuid) => {
    const url = String((infoOf(uuid) || {}).url || '');
    if (/\.mtl$/i.test(url)) {
      return 'material';
    }
    if (/\.effect$/i.test(url)) {
      return 'effect';
    }
    if (!url.includes('@')) {
      return '';
    }
    const json = await readJsonMemo(libraryJsonPath(ctx.projectRoot, uuid));
    return json && json.__type__ === 'cc.Material' ? 'material' : '';
  };
  const inBuild = ctx.inBuildUrls();
  const flagged = [];
  let unknown = 0;
  for (const row of meshRows) {
    const meshUuid = path.basename(row.relativePath, row.extension).split('.')[0];
    const mesh = meshUuid.includes('@') ? await readJsonMemo(libraryJsonPath(ctx.projectRoot, meshUuid)) : null;
    const bundles = mesh && mesh._struct && Array.isArray(mesh._struct.vertexBundles) ? mesh._struct.vertexBundles : null;
    if (!bundles) {
      unknown += 1;
      continue;
    }
    let tangentBytes = 0;
    let vertexBytes = 0;
    for (const bundle of bundles) {
      const view = bundle.view || {};
      const tangent = (bundle.attributes || []).find((attribute) => attribute.name === 'a_tangent');
      if (tangent && RGBA_FORMAT_BYTES[tangent.format] && view.stride) {
        tangentBytes += Number(view.length || 0) * RGBA_FORMAT_BYTES[tangent.format] / view.stride;
      }
      vertexBytes += Number(view.length || 0);
    }
    if (!tangentBytes) {
      continue;
    }
    const indexBytes = sum((mesh._struct.primitives || []).map((primitive) => (primitive.indexView ? primitive.indexView.length : 0)));
    // Ai dùng mesh này (prefab / scene / prefab của FBX) và có trong build; không xác định được thì mọi chỗ dùng.
    const users = dependents.get(meshUuid.toLowerCase()) || [];
    const usersInBuild = users.filter((uuid) => inBuild.has(String((infoOf(uuid) || {}).url || '')));
    const materials = [];
    for (const user of usersInBuild.length ? usersInBuild : users) {
      for (const dependency of dependsOf(user)) {
        if (await typeOf(dependency) === 'material') {
          materials.push(dependency);
        }
      }
    }
    const effects = [];
    for (const material of new Set(materials)) {
      for (const dependency of dependsOf(material)) {
        if (await typeOf(dependency) === 'effect') {
          effects.push(dependency);
        }
      }
    }
    if (!effects.length) {
      unknown += 1;
      continue;
    }
    const reads = await Promise.all([...new Set(effects)].map((uuid) => effectReadsTangent(ctx.projectRoot, uuid)));
    if (reads.some((value) => value !== false)) {
      continue;
    }
    const share = (tangentBytes / Math.max(1, vertexBytes + indexBytes)) * TANGENT_ZIP_FACTOR;
    flagged.push({
      row,
      share,
      effects: [...new Set(effects)].map((uuid) => baseName(String((infoOf(uuid) || {}).url || uuid)).replace(/\.effect$/, '')),
    });
  }
  if (!flagged.length) {
    return skipped(unknown ? `${unknown} mesh không tra được material / effect (library thiếu)` : 'mesh nào có tangent cũng có shader đọc tangent');
  }
  const byModel = new Map();
  for (const item of flagged) {
    const url = rootUrl(item.row.source);
    byModel.set(url, (byModel.get(url) || []).concat(item));
  }
  let saving = 0;
  let zipTotal = 0;
  for (const item of flagged) {
    const zip = await ctx.zipBytes(item.row);
    zipTotal += zip;
    saving += zip * item.share;
  }
  saving = Math.round(saving);
  if (saving < MIN_SAVING) {
    return skipped(`phần tangent quá nhỏ (≈ ${formatBytes(saving)})`);
  }
  const models = [...byModel.keys()];
  const effects = [...new Set(flagged.flatMap((item) => item.effects))];
  return {
    insights: [{
      id: 'model-tangents',
      group: 'model',
      bytes: sum(flagged.map((item) => item.row.size)),
      saving,
      impact: savingLabel(saving),
      basis: `mesh ${formatBytes(zipTotal)} ${await ctx.sourceLabel()} · ước tính: ½ tỉ lệ byte tangent trong mesh`,
      title: `${models.length} model lưu tangent mà shader không đọc`,
      detail: `${listNames(models.map(baseName))}: mesh có a_tangent nhưng material của chúng chỉ dùng ${listNames(effects, 4)}, vertex shader không đọc a_tangent. Chọn các FBX / glTF này → Inspector → tab Model → Tangents: Exclude → Apply (uuid mesh giữ nguyên), rồi build lại. Bật lại nếu sau này dùng normal map hoặc script đổi sang material có normal map.`,
      action: { type: 'reveal', url: models[0], label: 'Chọn model' },
    }],
    skipped: unknown ? `${unknown} mesh không tra được material / effect` : '',
  };
}

// ---------------------------------------------------------------- API

const CHECKS = [
  ['splash-logo', 'Logo splash', splashLogoCheck],
  ['duplicates', 'File trùng nhau', duplicateFilesCheck],
  ['fonts', 'Font', fontCheck],
  ['build-options', 'Tuỳ chọn build', buildOptionChecks],
  ['builder-export', 'Cấu hình xuất playable-ads-builder', builderExportChecks],
  ['palette', 'PNG palette trên ảnh đục', paletteOnOpaqueCheck],
  ['spine-json', 'Spine JSON', spineJsonCheck],
  ['tangents', 'Tangent của model', tangentCheck],
];

/**
 * Chạy mọi kiểm tra chung trên một bản build. options:
 *   { projectRoot, build: { assetRows, buildRoot }, evidence (insights.readProjectEvidence), settings, settingsText,
 *     settingsPath, textures, audio, zippedSize(row) → Promise<byte sau zip> }
 * Trả về { insights, diagnostics: [{ id, label, insights: số gợi ý, ids: [id gợi ý], skipped: lý do | '', error: '' }] }.
 * Một kiểm tra lỗi không làm hỏng các kiểm tra khác (ghi vào diagnostics).
 */
async function runBuildChecks(options) {
  const ctx = createContext(options);
  const insights = [];
  const diagnostics = [];
  for (const [id, label, check] of CHECKS) {
    const start = Date.now();
    try {
      const result = await check(ctx);
      insights.push(...result.insights);
      diagnostics.push({ id, label, insights: result.insights.length, ids: result.insights.map((item) => item.id), skipped: result.skipped || '', error: '', ms: Date.now() - start });
    } catch (error) {
      diagnostics.push({ id, label, insights: 0, ids: [], skipped: '', error: String((error && error.message) || error), ms: Date.now() - start });
    }
  }
  return { insights, diagnostics };
}

module.exports = {
  runBuildChecks,
  // Dùng lại / kiểm thử riêng.
  parseSfnt,
  estimateSubset,
  recompressPngLossless,
  imageInfo,
  effectReadsTangent,
  readExportInfo,
};
