'use strict';

/**
 * Bản HTML cuối của playable-ads-builder: mỗi file của bản build chiếm bao nhiêu trong file
 * <Mạng>_<Tên>.html / .zip nộp cho mạng quảng cáo.
 *
 * Builder làm 4 bước (extensions/playable-ads-builder/source/build-engine.ts):
 *   1. ảnh .png/.jpg/.jpeg -> WebP (sharp, lossy quality / lossless; giữ ảnh cũ nếu không nhỏ hơn)
 *   2. audio -> MP3 ở bitrate của builder (ffmpeg), nếu bật nén audio
 *   3. mọi file (trừ .html/.css) + BingoEngine.js + PlayableSDK.js -> một zip (deflate)
 *   4. zip -> base122 nhúng thẳng vào HTML; mạng nộp .zip thì base64 trong zip.js / HTML rồi zip lại
 *
 * readExportBreakdown đọc thẳng zip nhúng trong file đã xuất nên ra đúng từng byte;
 * simulateExport (chưa xuất) làm lại đúng các bước trên trong tiến trình con (cần sharp).
 * Cũng đọc bản xuất của playable-ads-adapter (window.__adapter_zip__ / __adapter_resource__, file
 * <tên>_<Mạng>.html, single-file-3x.html, thư mục <tên>_<Mạng>/ có js/index*.js) và thư mục xuất bất kỳ
 * (zip ước tính). Định dạng lạ thì trả { unsupported: true } thay vì ném lỗi.
 * Chỉ dùng fs + zlib, không phụ thuộc Editor.
 */

const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const deflateRaw = promisify(zlib.deflateRaw);

const BASE122_ILLEGAL = [0, 10, 13, 34, 38, 92, 60];
/** File do builder thêm vào zip (không đến từ bản build). */
const FRAME_ENTRIES = new Set(['BingoEngine.js', 'PlayableSDK.js']);
/** Builder encode lại audio có các đuôi này (FILE_EXTENSIONS trong build-engine.ts). */
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];

function base122Decode(text) {
  // Ký tự 2 byte mang tới 14 bit: cấp đủ cho trường hợp xấu nhất.
  const out = Buffer.allocUnsafe(Math.ceil(text.length * 14 / 8) + 8);
  let length = 0;
  let current = 0;
  let bit = 0;
  const push7 = (value) => {
    value <<= 1;
    current |= value >>> bit;
    bit += 7;
    if (bit >= 8) {
      out[length] = current & 255;
      length += 1;
      bit -= 8;
      current = (value << (7 - bit)) & 255;
    }
  };
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 127) {
      const illegal = (code >>> 8) & 7;
      if (illegal !== 7) {
        push7(BASE122_ILLEGAL[illegal]);
      }
      push7(code & 127);
    } else {
      push7(code);
    }
  }
  return out.subarray(0, length);
}

/** Độ dài base122 (byte UTF-8) của chuỗi byte ghép từ các buffer, đúng như builder mã hoá. */
function base122Length(buffers) {
  const total = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const septets = new Uint8Array(Math.ceil(total * 8 / 7) + 1);
  let count = 0;
  let pending = 0;
  let pendingBits = 0;
  for (const buffer of buffers) {
    for (let index = 0; index < buffer.length; index += 1) {
      pending = ((pending << 8) | buffer[index]) & 0x7fff;
      pendingBits += 8;
      while (pendingBits >= 7) {
        pendingBits -= 7;
        septets[count] = (pending >>> pendingBits) & 127;
        count += 1;
      }
    }
  }
  if (pendingBits) {
    septets[count] = (pending << (7 - pendingBits)) & 127;
    count += 1;
  }
  // Septet "cấm" gộp với septet kế tiếp thành 2 byte; còn lại mỗi septet 1 byte.
  let length = 0;
  for (let index = 0; index < count; index += 1) {
    if (BASE122_ILLEGAL.includes(septets[index])) {
      length += 2;
      index += 1;
    } else {
      length += 1;
    }
  }
  return length;
}

// ---------------------------------------------------------------- zip

/** Central directory: [{ name, method, compressedSize, size, localOffset, headerBytes }]. */
function readZipEntries(buffer) {
  let end = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65557); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      end = index;
      break;
    }
  }
  if (end < 0) {
    throw new Error('Không đọc được zip (thiếu End of central directory).');
  }
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Zip hỏng (central directory sai định dạng).');
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({
      name,
      method: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      size: buffer.readUInt32LE(offset + 24),
      localOffset: buffer.readUInt32LE(offset + 42),
      // Header cục bộ (30 + tên) + bản ghi central directory (46 + tên + extra + comment).
      headerBytes: 30 + nameLength + 46 + nameLength + extraLength + commentLength,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntryData(buffer, entry) {
  const local = entry.localOffset;
  if (buffer.readUInt32LE(local) !== 0x04034b50) {
    throw new Error(`Zip hỏng (${entry.name}).`);
  }
  const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
  const data = buffer.subarray(start, start + entry.compressedSize);
  return entry.method === 0 ? data : zlib.inflateRawSync(data);
}

/** Zip playable nhúng trong HTML / zip.js: { zip, encoding, encodedBytes } hoặc null. */
function embeddedZip(text) {
  if (/window\.__zipEncoding\s*=\s*"base64"/.test(text)) {
    const match = /window\.__zip\s*=\s*("(?:[^"\\]|\\.)*")/.exec(text);
    if (!match) {
      return null;
    }
    const base64 = JSON.parse(match[1]);
    return { zip: Buffer.from(base64, 'base64'), encoding: 'base64', encodedBytes: base64.length };
  }
  const marker = 'window.__zip="';
  const start = text.indexOf(marker);
  if (start < 0) {
    return null;
  }
  const end = text.indexOf('"', start + marker.length);
  const encoded = text.slice(start + marker.length, end < 0 ? undefined : end);
  return { zip: base122Decode(encoded), encoding: 'base122', encodedBytes: Buffer.byteLength(encoded, 'utf8') };
}

// ---------------------------------------------------------------- playable-ads-adapter

/**
 * Chuỗi JS ("..." hoặc '...') bắt đầu ở text[start] (dấu nháy mở): { value, end, rawBytes }. Base64 không có
 * ký tự thoát nên đi đường nhanh; có \ thì giải như JSON (nháy kép) hoặc giữ nguyên (nháy đơn, hiếm).
 */
function readJsString(text, start) {
  const quote = text[start];
  let index = start + 1;
  let escaped = false;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 92) {
      escaped = true;
      index += 2;
      continue;
    }
    if (text[index] === quote) {
      break;
    }
    index += 1;
  }
  const raw = text.slice(start, index + 1);
  let value = raw.slice(1, -1);
  if (escaped && quote === '"') {
    try {
      value = JSON.parse(raw);
    } catch (_error) {
      // giữ chuỗi thô
    }
  }
  return { value, end: index + 1, rawBytes: Buffer.byteLength(raw, 'utf8') };
}

/** Object JSON bắt đầu ở text[start] ('{'): vị trí sau '}' khớp (bỏ qua ngoặc trong chuỗi), -1 nếu không khớp. */
function matchJsonObject(text, start) {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (code === 92) {
        index += 1;
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

/** Dung lượng gốc của một giá trị trong JSON của adapter: data: URL base64 thì giải ra số byte, chữ thì UTF-8. */
function adapterValueSize(value) {
  const text = String(value || '');
  const comma = text.startsWith('data:') ? text.indexOf(',') : -1;
  if (comma > 0 && text.slice(0, comma).endsWith(';base64')) {
    return Math.floor((text.length - comma - 1) * 3 / 4);
  }
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Dữ liệu playable-ads-adapter nhúng trong HTML / các file js của thư mục xuất (cộng dồn cả `+=`):
 *   window.__adapter_zip__      base64 của zip (adapter 1.3.3) hoặc base64 của zlib(JSON { đường dẫn: nội dung }) (1.3.10)
 *   window.__adapter_resource__ JSON { đường dẫn: nội dung } để thẳng (chữ, hoặc data: URL base64)
 * Trả về { encoding, files: [{ path, size, compressedBytes, bytes }], packedBytes } hoặc null khi không có.
 * `bytes`: phần mỗi file chiếm trong `text` (chia theo tỉ lệ dung lượng nén của nó).
 */
function adapterPayload(text) {
  let zipText = '';
  let zipBytes = 0;
  const zipPattern = /window\.__adapter_zip__\s*\+?=\s*(["'])/g;
  for (let match = zipPattern.exec(text); match; match = zipPattern.exec(text)) {
    const literal = readJsString(text, match.index + match[0].length - 1);
    zipText += literal.value;
    zipBytes += literal.rawBytes;
    zipPattern.lastIndex = literal.end;
  }
  const byPath = new Map();
  const add = (item) => {
    const current = byPath.get(item.path);
    if (current) {
      current.size += item.size;
      current.compressedBytes += item.compressedBytes;
      current.bytes += item.bytes;
    } else {
      byPath.set(item.path, { ...item });
    }
  };
  let encoding = '';
  if (zipText) {
    const data = Buffer.from(zipText, 'base64');
    if (data.length >= 4 && data.readUInt32LE(0) === 0x04034b50) {
      encoding = 'adapter-zip';
      const entries = readZipEntries(data).filter((entry) => !entry.name.endsWith('/'));
      const raw = entries.reduce((total, entry) => total + entry.compressedSize + entry.headerBytes, 0);
      const factor = zipBytes / Math.max(1, raw);
      for (const entry of entries) {
        add({ path: entry.name, size: entry.size, compressedBytes: entry.compressedSize, bytes: Math.round((entry.compressedSize + entry.headerBytes) * factor) });
      }
    } else {
      // zlib(JSON): không có bảng dung lượng từng file; chia theo dung lượng nén riêng của từng mục (ước lượng).
      const json = JSON.parse(zlib.inflateSync(data).toString('utf8'));
      encoding = 'adapter-zlib-json';
      const items = Object.entries(json || {}).map(([key, value]) => ({
        path: key,
        size: adapterValueSize(value),
        compressedBytes: zlib.deflateRawSync(Buffer.from(`${JSON.stringify(key)}:${JSON.stringify(value)},`, 'utf8')).length,
      }));
      const deflated = items.reduce((total, item) => total + item.compressedBytes, 0);
      const factor = zipBytes / Math.max(1, deflated);
      for (const item of items) {
        add({ ...item, bytes: Math.round(item.compressedBytes * factor) });
      }
    }
  }
  const resourcePattern = /window\.__adapter_resource__\s*=\s*\{/g;
  let resourceFound = false;
  for (let match = resourcePattern.exec(text); match; match = resourcePattern.exec(text)) {
    const start = match.index + match[0].length - 1;
    const end = matchJsonObject(text, start);
    if (end < 0) {
      break;
    }
    let json = null;
    try {
      json = JSON.parse(text.slice(start, end));
    } catch (_error) {
      json = null;
    }
    resourcePattern.lastIndex = end;
    if (!json) {
      continue;
    }
    resourceFound = true;
    encoding = encoding ? `${encoding}+resource` : 'adapter-resource';
    // Để thẳng trong HTML: phần chiếm đúng bằng độ dài của mục trong JSON.
    for (const [key, value] of Object.entries(json)) {
      const bytes = Buffer.byteLength(`${JSON.stringify(key)}:${JSON.stringify(value)},`, 'utf8');
      add({ path: key, size: adapterValueSize(value), compressedBytes: bytes, bytes });
    }
  }
  if (!zipText && !resourceFound) {
    return null;
  }
  const files = [...byPath.values()];
  return { encoding, files, packedBytes: files.reduce((total, item) => total + item.bytes, 0) };
}

/** Kết quả "không đọc được định dạng này" (không ném lỗi: nơi gọi tự chuyển sang số ước tính / số build). */
function unsupportedBreakdown(filePath, totalBytes, reason) {
  return { file: filePath, totalBytes, encoding: '', factor: 1, files: [], frameFiles: [], frameBytes: totalBytes, estimated: false, unsupported: true, reason };
}

/** Header zip ước tính của một file (local header + central directory, tên UTF-8). */
function zipHeaderBytes(name) {
  return 30 + 46 + 2 * Buffer.byteLength(name, 'utf8');
}

/** Mọi file thường trong thư mục (đệ quy): [{ fullPath, relative, size }]. */
async function listFolder(root) {
  const out = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath).catch(() => null);
        if (stat) {
          out.push({ fullPath, relative: path.relative(root, fullPath).replace(/\\/g, '/'), size: stat.size });
        }
      }
    }
  }
  await walk(root);
  return out.sort((left, right) => left.relative.localeCompare(right.relative));
}

/**
 * Thư mục xuất (mạng nhận zip của cả thư mục: adapter cho TikTok / Facebook / Mintegral...). Dung lượng cuối là zip
 * thư mục, ước tính bằng deflate từng file (mức mặc định như công cụ nén thông dụng). Có dữ liệu adapter trong
 * index.html / js thì chia theo từng file của bản build như file HTML; không có (bản sao web-mobile) thì mỗi file
 * của thư mục là một dòng. Trả về cùng dạng readExportBreakdown, `estimated: true`.
 */
async function readExportFolder(dir) {
  const files = await listFolder(dir);
  if (!files.length) {
    return unsupportedBreakdown(dir, 0, 'Thư mục xuất trống.');
  }
  const zipped = [];
  for (const file of files) {
    const data = await fs.readFile(file.fullPath);
    const compressed = Math.min(data.length, (await deflateRaw(data)).length);
    zipped.push({ ...file, data: /\.(html?|js)$/i.test(file.relative) ? data : null, compressed, zipBytes: compressed + zipHeaderBytes(file.relative) });
  }
  const totalBytes = zipped.reduce((total, file) => total + file.zipBytes, 0) + 22;
  const rawBytes = files.reduce((total, file) => total + file.size, 0);
  const text = zipped.filter((file) => file.data).map((file) => file.data.toString('utf8')).join('\n');
  const payload = text.includes('__adapter_') ? adapterPayload(text) : null;
  if (payload) {
    // Phần trong text thô -> phần trong zip của thư mục, theo tỉ lệ nén chung của các file chứa dữ liệu.
    const carriers = zipped.filter((file) => file.data);
    const ratio = carriers.reduce((total, file) => total + file.zipBytes, 0) / Math.max(1, carriers.reduce((total, file) => total + file.size, 0));
    const items = payload.files.map((item) => ({ ...item, bytes: Math.round(item.bytes * ratio) }));
    const fromBuild = items.reduce((total, item) => total + item.bytes, 0);
    return {
      file: dir, totalBytes, rawBytes, encoding: payload.encoding, factor: 1, files: items, frameFiles: [],
      frameBytes: Math.max(0, totalBytes - fromBuild), estimated: true, tool: 'adapter', folder: true,
    };
  }
  const items = zipped.map((file) => ({ path: file.relative, size: file.size, compressedBytes: file.compressed, bytes: file.zipBytes }));
  return {
    file: dir, totalBytes, rawBytes, encoding: 'folder-zip', factor: 1, files: items, frameFiles: [],
    frameBytes: 22, estimated: true, tool: 'folder', folder: true,
  };
}

/** Phân tích dữ liệu adapter của một chuỗi (HTML hoặc file trong .zip) thành cùng dạng readExportBreakdown. */
function adapterBreakdown(filePath, totalBytes, text, scale = 1) {
  const payload = adapterPayload(text);
  if (!payload) {
    return null;
  }
  const files = payload.files.map((item) => ({ ...item, bytes: Math.round(item.bytes * scale) }));
  const fromBuild = files.reduce((total, item) => total + item.bytes, 0);
  return {
    file: filePath, totalBytes, encoding: payload.encoding, factor: 1, files, frameFiles: [],
    frameBytes: Math.max(0, totalBytes - fromBuild), estimated: false, tool: 'adapter',
  };
}

/**
 * Đọc một bản xuất: file .html / .zip của playable-ads-builder hoặc playable-ads-adapter, hoặc thư mục xuất (truyền
 * thư mục, hoặc index.html trong thư mục mà bản thân nó không chứa dữ liệu). Trả về
 * { file, totalBytes, encoding, files: [{ path, size, compressedBytes, bytes }], frameBytes, frameFiles, tool, estimated }.
 * `bytes`: phần file đó chiếm trong file cuối (đã tính nén zip + mã hoá, chia theo tỉ lệ).
 * `frameBytes`: phần cố định không đến từ bản build (thư viện giải nén, launcher, SDK của mạng...).
 * Định dạng không nhận ra: { unsupported: true, reason, totalBytes, files: [] } (không ném lỗi).
 */
async function readExportBreakdown(filePath) {
  const stat = await fs.stat(filePath);
  if (stat.isDirectory()) {
    return await readExportFolder(filePath);
  }
  const data = await fs.readFile(filePath);
  let found = null;
  let packedBytes = 0;
  if (/\.zip$/i.test(filePath)) {
    let outer;
    try {
      outer = readZipEntries(data);
    } catch (error) {
      return unsupportedBreakdown(filePath, data.length, error.message);
    }
    const carrier = outer.find((entry) => /(^|\/)zip\.js$/.test(entry.name)) || outer.find((entry) => /\.html$/i.test(entry.name));
    if (!carrier) {
      return unsupportedBreakdown(filePath, data.length, 'Không thấy index.html / zip.js trong file .zip.');
    }
    found = embeddedZip(readZipEntryData(data, carrier).toString('utf8'));
    // Bản .zip được nén lại lần nữa: phần dữ liệu chiếm trong file cuối = dung lượng nén của file chứa nó.
    packedBytes = carrier.compressedSize;
    if (!found) {
      // playable-ads-adapter: dữ liệu nằm rải trong index.html + js/*.js của gói.
      const carriers = outer.filter((entry) => /\.(html?|js)$/i.test(entry.name));
      const text = carriers.map((entry) => readZipEntryData(data, entry).toString('utf8')).join('\n');
      const raw = carriers.reduce((total, entry) => total + entry.size, 0);
      const packed = carriers.reduce((total, entry) => total + entry.compressedSize, 0);
      return adapterBreakdown(filePath, data.length, text, packed / Math.max(1, raw))
        || unsupportedBreakdown(filePath, data.length, 'Không thấy dữ liệu playable (window.__zip / window.__adapter_zip__) trong file .zip.');
    }
  } else {
    const text = data.toString('utf8');
    found = embeddedZip(text);
    packedBytes = found ? found.encodedBytes : 0;
    if (!found) {
      const adapter = adapterBreakdown(filePath, data.length, text);
      if (adapter) {
        return adapter;
      }
      // index.html của thư mục xuất: dữ liệu ở các file js bên cạnh.
      if (/^index\.html?$/i.test(path.basename(filePath))) {
        const folder = await readExportFolder(path.dirname(filePath));
        if (!folder.unsupported) {
          return folder;
        }
      }
      return unsupportedBreakdown(filePath, data.length, 'Không thấy dữ liệu playable (window.__zip của playable-ads-builder hay window.__adapter_zip__ của playable-ads-adapter) trong file.');
    }
  }
  const entries = readZipEntries(found.zip);
  const raw = entries.reduce((sum, entry) => sum + entry.compressedSize + entry.headerBytes, 0);
  const factor = packedBytes / Math.max(1, raw);
  const files = [];
  const frameFiles = [];
  for (const entry of entries) {
    if (entry.name.endsWith('/')) {
      continue;
    }
    const item = {
      path: entry.name,
      size: entry.size,
      compressedBytes: entry.compressedSize,
      bytes: Math.round((entry.compressedSize + entry.headerBytes) * factor),
    };
    (FRAME_ENTRIES.has(entry.name) ? frameFiles : files).push(item);
  }
  const fromBuild = files.reduce((sum, item) => sum + item.bytes, 0);
  return {
    file: filePath,
    totalBytes: data.length,
    encoding: found.encoding,
    factor,
    files,
    frameFiles,
    frameBytes: Math.max(0, data.length - fromBuild),
    estimated: false,
    tool: 'builder',
  };
}

/**
 * Ghép số liệu HTML vào các dòng của bản build (cùng đường dẫn tương đối; audio đổi đuôi sang .mp3
 * thì khớp theo tên không đuôi). Trả về { rows, frameBytes, unmatched } với rows = bản sao của
 * buildRows, `size` = phần trong HTML, `buildSize` = dung lượng trong build.
 */
function mapToBuildRows(buildRows, breakdown) {
  const byPath = new Map(breakdown.files.map((item) => [item.path, item]));
  const byStem = new Map(breakdown.files.map((item) => [item.path.replace(/\.[^./]+$/, ''), item]));
  const used = new Set();
  const rows = [];
  for (const row of buildRows) {
    // Chỉ audio bị đổi đuôi (wav/ogg -> mp3) mới khớp theo tên không đuôi; file khác phải trùng đường dẫn.
    const isAudio = AUDIO_EXTENSIONS.includes(path.extname(row.relativePath).toLowerCase());
    const item = byPath.get(row.relativePath) || (isAudio ? byStem.get(row.relativePath.replace(/\.[^./]+$/, '')) : null);
    if (!item) {
      // .html / .css của bản build: builder đọc riêng vào khung HTML, không vào zip.
      continue;
    }
    used.add(item.path);
    rows.push({ ...row, buildSize: row.size, size: item.bytes, htmlUncompressed: item.size });
  }
  const unmatched = breakdown.files.filter((item) => !used.has(item.path));
  return { rows, frameBytes: breakdown.frameBytes + unmatched.reduce((sum, item) => sum + item.bytes, 0), unmatched };
}

module.exports = {
  FRAME_ENTRIES,
  base122Decode,
  base122Length,
  readZipEntries,
  readZipEntryData,
  embeddedZip,
  adapterPayload,
  readExportBreakdown,
  mapToBuildRows,
};
