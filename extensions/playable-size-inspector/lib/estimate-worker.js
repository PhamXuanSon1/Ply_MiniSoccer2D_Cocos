'use strict';

/**
 * Worker nén thử ảnh - CHẠY NHƯ TIẾN TRÌNH NODE THUẦN, tách khỏi process của Editor.
 *
 * Lý do: `sharp` là native addon, require thẳng trong process Editor sẽ lỗi
 * ERR_DLOPEN_FAILED (libvips xung đột DLL với Chromium). Cách chạy được là spawn
 * chính CocosCreator.exe với ELECTRON_RUN_AS_NODE=1 rồi require ở đây.
 *
 * Dùng đúng bản sharp của Editor (resources/app.asar/node_modules) nên kết quả
 * TRÙNG TỪNG BYTE với Texture Compress thật; nếu không có thì lùi về sharp cài
 * riêng cho extension (số liệu chỉ còn là ước tính).
 *
 * Cách gọi: node estimate-worker.js <jobFile.json> <resultFile.json>
 *   job:    { sharpAnchors: string[], images: [{ id, input, format, quality }] }
 *   result: { sharpSource, versions, images: { [id]: { bytes } | { error } } }
 */

const fs = require('fs');
const { createRequire } = require('module');

function loadSharp(anchors) {
  const errors = [];
  for (const anchor of anchors || []) {
    try {
      const sharp = createRequire(anchor)('sharp');
      // Chạm vào versions để chắc native addon nạp được, không chỉ resolve ra module.
      const versions = sharp.versions;
      return { sharp, source: anchor, versions };
    } catch (error) {
      errors.push(`${anchor}: ${error.message.split('\n')[0]}`);
    }
  }
  throw new Error(`Không nạp được sharp.\n${errors.join('\n')}`);
}

function encode(sharp, input, format, quality) {
  const image = sharp(input);
  switch (format) {
    case 'png':
      // Cocos dùng đúng tổ hợp này (đã đối chiếu trùng byte với bản build ra).
      return image.png({ palette: true, quality }).toBuffer();
    case 'webp':
      return image.webp({ quality }).toBuffer();
    case 'jpg':
    case 'jpeg':
      return image.jpeg({ quality }).toBuffer();
    default:
      return Promise.reject(new Error(`Chưa hỗ trợ ước tính định dạng "${format}"`));
  }
}

async function main() {
  const [jobFile, resultFile] = process.argv.slice(2);
  if (!jobFile || !resultFile) {
    throw new Error('Thiếu tham số jobFile/resultFile.');
  }

  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  const { sharp, source, versions } = loadSharp(job.sharpAnchors);
  const images = {};

  for (const image of job.images || []) {
    try {
      const buffer = await encode(sharp, image.input, String(image.format || '').toLowerCase(), Number(image.quality));
      images[image.id] = { bytes: buffer.length };
    } catch (error) {
      images[image.id] = { error: String((error && error.message) || error) };
    }
  }

  fs.writeFileSync(resultFile, JSON.stringify({ sharpSource: source, versions, images }), 'utf8');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error((error && error.stack) || error);
    process.exit(1);
  });
