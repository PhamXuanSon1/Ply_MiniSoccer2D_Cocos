'use strict';

/** Đọc kích thước / alpha của ảnh từ header, không giải mã cả file. */

const fs = require('fs/promises');
const path = require('path');
const { readFileHead } = require('./fs-utils');

const HEADER_BYTES = 64 * 1024;
const SUPPORTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.bmp', '.webp'];

/**
 * Trả về { width, height, hasAlpha, formatLabel } hoặc null.
 * JPEG có thể chứa EXIF/ICC dài trước SOF nên nếu chưa thấy header trong 64 KB
 * đầu thì đọc lại cả file.
 */
async function readImageMeta(filePath, extension = '') {
  const ext = String(extension || path.extname(filePath)).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return null;
  }

  try {
    const head = await readFileHead(filePath, HEADER_BYTES);
    const meta = parseImageMeta(head, ext);
    if (meta || head.length < HEADER_BYTES) {
      return meta;
    }
    return parseImageMeta(await fs.readFile(filePath), ext);
  } catch (_error) {
    return null;
  }
}

function parseImageMeta(buffer, extension) {
  switch (extension) {
    case '.png':
      return readPngMeta(buffer);
    case '.jpg':
    case '.jpeg':
      return readJpegMeta(buffer);
    case '.bmp':
      return readBmpMeta(buffer);
    case '.webp':
      return readWebpMeta(buffer);
    default:
      return null;
  }
}

function readPngMeta(buffer) {
  if (!buffer || buffer.length < 26) {
    return null;
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const colorType = buffer.readUInt8(25);
  const hasAlpha = colorType === 4 || colorType === 6;

  return {
    width,
    height,
    hasAlpha,
    formatLabel: `PNG color type ${colorType}`,
  };
}

function readJpegMeta(buffer) {
  if (!buffer || buffer.length < 4 || buffer.readUInt16BE(0) !== 0xFFD8) {
    return null;
  }

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xFF) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xC0 && marker <= 0xC3 && offset + 8 < buffer.length) {
      return {
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5),
        hasAlpha: false,
        formatLabel: 'JPEG baseline',
      };
    }

    if (length <= 0) {
      break;
    }
    offset += 2 + length;
  }

  return null;
}

function readBmpMeta(buffer) {
  if (!buffer || buffer.length < 30 || buffer.toString('ascii', 0, 2) !== 'BM') {
    return null;
  }

  const width = Math.abs(buffer.readInt32LE(18));
  const height = Math.abs(buffer.readInt32LE(22));
  const bitsPerPixel = buffer.readUInt16LE(28);

  return {
    width,
    height,
    hasAlpha: bitsPerPixel === 32,
    formatLabel: `BMP ${bitsPerPixel} bpp`,
  };
}

/** WebP: VP8 (lossy), VP8L (lossless), VP8X (extended, cờ alpha ở byte đầu chunk). */
function readWebpMeta(buffer) {
  if (!buffer || buffer.length < 30
    || buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }

  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return {
      width: (buffer.readUIntLE(24, 3) & 0xFFFFFF) + 1,
      height: (buffer.readUIntLE(27, 3) & 0xFFFFFF) + 1,
      hasAlpha: (buffer.readUInt8(20) & 0x10) !== 0,
      formatLabel: 'WebP extended',
    };
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3FFF) + 1,
      height: ((bits >> 14) & 0x3FFF) + 1,
      hasAlpha: ((bits >> 28) & 1) !== 0,
      formatLabel: 'WebP lossless',
    };
  }
  if (chunk === 'VP8 ') {
    return {
      width: buffer.readUInt16LE(26) & 0x3FFF,
      height: buffer.readUInt16LE(28) & 0x3FFF,
      hasAlpha: false,
      formatLabel: 'WebP lossy',
    };
  }
  return null;
}

module.exports = {
  SUPPORTED_EXTENSIONS,
  readImageMeta,
};
