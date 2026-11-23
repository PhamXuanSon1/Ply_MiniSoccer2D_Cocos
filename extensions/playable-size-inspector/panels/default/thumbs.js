'use strict';

/**
 * Ảnh thu nhỏ dùng chung cho lưới ảnh (Tối ưu → Ảnh) và icon của danh sách (Tìm chỗ nặng).
 * Đọc file thành Blob URL (không phụ thuộc đường dẫn file://) và chỉ đọc khi ảnh lọt vào khung
 * nhìn, nên dự án nghìn ảnh vẫn nhẹ. Cache theo "đường dẫn|dung lượng": ảnh đổi là đọc lại.
 */

const fs = require('fs').promises;
const path = require('path');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp' };
/** File lớn hơn mức này thì không làm ảnh thu nhỏ (chỉ hiện biểu tượng). */
const MAX_BYTES = 8 * 1024 * 1024;

const cache = new Map();
/** Mỗi vùng cuộn một IntersectionObserver. */
const observers = new WeakMap();

function canThumb(filePath, bytes) {
  return !!MIME[path.extname(String(filePath || '')).toLowerCase()] && (!bytes || bytes <= MAX_BYTES);
}

/** Giá trị cho thuộc tính data-thumb của <img>. */
function key(filePath, bytes) {
  return `${filePath}|${bytes || 0}`;
}

function markLoaded(img) {
  const holder = img.closest('.has-thumb');
  if (holder) {
    holder.classList.add('thumb-loaded');
  }
}

async function load(img) {
  const thumbKey = img.dataset.thumb;
  if (!thumbKey) {
    return;
  }
  if (!cache.has(thumbKey)) {
    const filePath = thumbKey.slice(0, thumbKey.lastIndexOf('|'));
    try {
      const data = await fs.readFile(filePath);
      cache.set(thumbKey, URL.createObjectURL(new Blob([data], { type: MIME[path.extname(filePath).toLowerCase()] })));
    } catch (_error) {
      cache.set(thumbKey, '');
    }
  }
  if (cache.get(thumbKey)) {
    img.src = cache.get(thumbKey);
    markLoaded(img);
  }
}

/**
 * Gắn ảnh cho mọi img[data-thumb] trong `container`; `root` là phần tử cuộn chứa nó. Theo dõi
 * khung .has-thumb (nếu có) thay vì chính <img>: img còn ẩn (display: none) thì không bao giờ
 * được báo là lọt vào khung nhìn.
 */
function attach(root, container = root) {
  let observer = observers.get(root);
  if (!observer && typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          const img = entry.target.matches('img') ? entry.target : entry.target.querySelector('img[data-thumb]');
          if (img) {
            void load(img);
          }
        }
      }
    }, { root, rootMargin: '200px' });
    observers.set(root, observer);
  }
  for (const img of container.querySelectorAll('img[data-thumb]')) {
    const cached = cache.get(img.dataset.thumb);
    if (cached) {
      img.src = cached;
      markLoaded(img);
    } else if (observer) {
      observer.observe(img.closest('.has-thumb') || img);
    } else {
      void load(img);
    }
  }
}

module.exports = { canThumb, key, attach };
