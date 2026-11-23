'use strict';

/**
 * Chặn ghi vào một thư mục (dự án đang kiểm tra) trong tiến trình node hiện tại: cli/selftest.js hứa chỉ đọc nên
 * mọi lệnh ghi / xoá / đổi tên / mở file để ghi trong thư mục đó bị từ chối (ném lỗi, promise reject, callback lỗi)
 * và được ghi lại để báo. Đường dẫn ngoài thư mục (vd --work-dir) vẫn ghi được. Không dùng trong Editor.
 * Phải gọi trước khi require các lib (chúng giữ tham chiếu tới fs / fs/promises - cùng object nên vẫn bị chặn).
 */

const fs = require('fs');
const path = require('path');

/** Trả về { blocked: [mô tả lệnh bị chặn] } (mảng cập nhật dần). */
function guardWrites(root) {
  const blocked = [];
  const resolvedRoot = path.resolve(root).toLowerCase();
  const inside = (target) => {
    let value = target;
    if (value instanceof URL) {
      value = value.protocol === 'file:' ? decodeURIComponent(value.pathname.replace(/^\/([A-Za-z]:)/, '$1')) : '';
    } else if (Buffer.isBuffer(value)) {
      value = value.toString('utf8');
    }
    if (typeof value !== 'string' || !value) {
      return false;
    }
    const resolved = path.resolve(value).toLowerCase();
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  };
  const writeFlags = /[wa+]/;
  const wrap = (object, name, pathArgs, style, checkFlags) => {
    const original = object[name];
    if (typeof original !== 'function') {
      return;
    }
    object[name] = function guarded(...callArgs) {
      const flags = checkFlags ? callArgs[1] : undefined;
      const writing = !checkFlags || (typeof flags === 'string' ? writeFlags.test(flags)
        : typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND)) !== 0 : false);
      const hit = writing ? pathArgs.map((index) => callArgs[index]).find(inside) : undefined;
      if (hit !== undefined) {
        const description = `${name} ${hit}`;
        blocked.push(description);
        const error = Object.assign(new Error(`chỉ đọc: chặn ${description}`), { code: 'EPERM' });
        if (style === 'promise') {
          return Promise.reject(error);
        }
        if (style === 'callback' && typeof callArgs[callArgs.length - 1] === 'function') {
          const callback = callArgs[callArgs.length - 1];
          process.nextTick(() => callback(error));
          return undefined;
        }
        throw error;
      }
      return original.apply(this, callArgs);
    };
  };
  const methods = [
    ['writeFile', [0]], ['appendFile', [0]], ['mkdir', [0]], ['mkdtemp', [0]], ['rm', [0]], ['rmdir', [0]], ['unlink', [0]],
    ['rename', [0, 1]], ['copyFile', [1]], ['cp', [1]], ['symlink', [1]], ['link', [1]], ['truncate', [0]], ['utimes', [0]],
    ['chmod', [0]],
  ];
  for (const [name, pathArgs] of methods) {
    wrap(fs.promises, name, pathArgs, 'promise', false);
    wrap(fs, name, pathArgs, 'callback', false);
    wrap(fs, `${name}Sync`, pathArgs, 'sync', false);
  }
  wrap(fs.promises, 'open', [0], 'promise', true);
  wrap(fs, 'open', [0], 'callback', true);
  wrap(fs, 'openSync', [0], 'sync', true);
  wrap(fs, 'createWriteStream', [0], 'sync', false);
  return { blocked };
}

module.exports = {
  guardWrites,
};
