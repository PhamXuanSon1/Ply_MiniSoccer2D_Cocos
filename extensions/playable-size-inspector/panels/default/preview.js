'use strict';

/** Xem trước ảnh / audio trong khung Chi tiết, dùng chung cho bước Tìm chỗ nặng và Tối ưu → Ảnh. */

const fs = require('fs/promises');
const path = require('path');

const MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};

/** Giới hạn để không nuốt RAM khi ảnh nguồn quá lớn (data URL nằm trong DOM). */
const MAX_PREVIEW_BYTES = 24 * 1024 * 1024;

function getPreviewMimeType(extension) {
  return MIME_BY_EXTENSION[String(extension || '').toLowerCase()] || '';
}

function getPreviewKind(extension) {
  const mime = getPreviewMimeType(extension);
  if (mime.startsWith('image/')) {
    return 'image';
  }
  if (mime.startsWith('audio/')) {
    return 'audio';
  }
  return '';
}

async function readFileAsDataUrl(filePath, mimeType) {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_PREVIEW_BYTES) {
    throw new Error(`File quá lớn để xem trước (${Math.round(stat.size / (1024 * 1024))} MB).`);
  }
  const buffer = await fs.readFile(filePath);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

/** Khung xem trước rỗng; nội dung thật do loadPreview nạp sau. */
function renderStage({ id, filePath, title = 'Preview', escapeHtml }) {
  return `
    <div class="detail-block asset-preview-block">
      <div class="detail-title">${escapeHtml(title)}</div>
      <div id="${escapeHtml(id)}" class="asset-preview-stage" data-preview-path="${escapeHtml(filePath)}">
        <div class="detail-note">Đang tải xem trước...</div>
      </div>
    </div>
  `;
}

/**
 * Nạp nội dung xem trước vào khung `id` trong `root`. Bỏ qua nếu người dùng đã
 * chọn asset khác (data-preview-path đổi) trong lúc đọc file.
 */
async function loadPreview(root, { id, filePath, extension, escapeHtml }) {
  const ext = String(extension || path.extname(filePath || '')).toLowerCase();
  const kind = getPreviewKind(ext);
  let stage = root.querySelector(`#${id}`);
  if (!stage || stage.dataset.previewPath !== filePath) {
    return;
  }
  if (!kind) {
    stage.innerHTML = `<div class="asset-preview-unavailable">Không có xem trước cho ${escapeHtml(ext || 'file này')}</div>`;
    return;
  }

  try {
    const dataUrl = await readFileAsDataUrl(filePath, getPreviewMimeType(ext));
    stage = root.querySelector(`#${id}`);
    if (!stage || stage.dataset.previewPath !== filePath) {
      return;
    }
    stage.innerHTML = kind === 'audio'
      ? `<audio class="asset-preview-audio" controls src="${escapeHtml(dataUrl)}"></audio>`
      : `<img class="asset-preview-image" src="${escapeHtml(dataUrl)}" alt="Preview">`;
  } catch (error) {
    stage = root.querySelector(`#${id}`);
    if (stage && stage.dataset.previewPath === filePath) {
      stage.innerHTML = `<div class="asset-preview-unavailable">${escapeHtml(error.message || 'Không tải được xem trước.')}</div>`;
    }
  }
}

module.exports = {
  getPreviewKind,
  renderStage,
  loadPreview,
};
