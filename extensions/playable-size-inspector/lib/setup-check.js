'use strict';

/**
 * "Thiết lập còn thiếu": những thứ dự án cần để mọi phần của tool chạy đủ (ffmpeg, preset Texture
 * Compress, Name + mạng của build task, module meshopt cho model bật Encode). Panel tự chạy khi mở
 * rồi kiểm tra lại định kỳ (khoảng 10 giây), chỉ hiện khi có việc phải làm; cli/selftest.js dùng lại.
 * Mỗi mục: { id, title, detail, action: { type, label, ... } | null }.
 * action.type: install-ffmpeg | open-url (url) | open-settings (tab, subTab) | open-build | enable-meshopt.
 * Kiểm tra nào không áp dụng cho dự án / bản Creator này thì bỏ qua (vd không dùng playable-ads-builder,
 * Cocos 3.6 không có meshopt); checkSetup(root, { withChecks: true }) trả kèm danh sách kiểm tra đã chạy.
 */

const path = require('path');
const { readJsonFile } = require('./fs-utils');
const { readPresets } = require('./texture-compress');
const { describeToolchain, NODE_HINT } = require('./toolchain');
const { scanModels, meshoptState } = require('./model-compress');
const { readPlayableTasks, detectExporter } = require('./exports');
const { readCaps } = require('./compat');

/**
 * Trả về mảng mục còn thiếu; `withChecks: true` thì { issues, checks: [tên kiểm tra đã chạy], exporter, caps }.
 */
async function checkSetup(projectRoot, { withChecks = false } = {}) {
  const issues = [];
  const checks = [];
  const caps = readCaps(projectRoot);
  const exporter = await detectExporter(projectRoot).catch(() => ({ builder: null, adapter: null }));

  checks.push('ffmpeg');
  const toolchain = describeToolchain();
  if (!toolchain.ffmpeg) {
    issues.push(toolchain.npm
      ? {
        id: 'ffmpeg',
        title: 'Chưa có ffmpeg cho phần Âm thanh',
        detail: 'Đọc thông tin, nghe thử, nén và cắt audio đều cần ffmpeg. Cài một lần cho extension (tải ffmpeg-static từ npm, khoảng 80 MB, cần mạng). Các phần khác của tool vẫn dùng bình thường.',
        action: { type: 'install-ffmpeg', label: 'Cài ffmpeg' },
      }
      : {
        id: 'ffmpeg',
        title: 'Chưa có ffmpeg cho phần Âm thanh (máy chưa có Node.js)',
        detail: `Đọc thông tin, nghe thử, nén và cắt audio đều cần ffmpeg. ${NODE_HINT} Các phần khác của tool vẫn dùng bình thường.`,
        action: { type: 'open-url', url: 'https://nodejs.org/', label: 'Tải Node.js' },
      });
  }

  checks.push('preset Texture Compress');
  const presets = await readPresets(projectRoot);
  if (!presets.length || presets.every((preset) => preset.unconfigured)) {
    issues.push({
      id: 'presets',
      title: presets.length ? 'Preset Texture Compress chưa có định dạng nén' : 'Chưa có preset Texture Compress',
      detail: presets.length
        ? 'Các preset hiện có chưa chọn định dạng nào (vd PNG chất lượng 80 cho web) nên chưa bật nén ảnh được. Thêm định dạng trong Project Settings → Texture Compression, rồi quay lại đây.'
        : 'Cần ít nhất một preset mới bật nén ảnh được. Tạo trong Project Settings → Texture Compression (vd preset cho web: PNG chất lượng 80), rồi quay lại đây.',
      action: { type: 'open-settings', tab: 'builder', subTab: 'compress-texture', label: 'Mở Texture Compression' },
    });
  }

  // Build task web mới nhất, kể cả khi chưa đặt Name (chính là điều cần báo). Chỉ khi xuất qua playable-ads-builder.
  if (exporter.builder) {
    checks.push('tên build', 'mạng quảng cáo');
    const tasks = await readPlayableTasks(projectRoot);
    const task = tasks[0] || null;
    if (!tasks.length) {
      issues.push({
        id: 'build-task',
        title: 'Máy này chưa có build task web',
        detail: 'Build task (Name, mạng đã tick) lưu trong profiles/ của từng máy và không vào git, nên máy vừa clone dự án chưa có. Mở Build, chọn Web Mobile, đặt Name và tick mạng trong phần playable-ads-builder (mạng / nén đã lưu trong dự án được điền sẵn), rồi Build.',
        action: { type: 'open-build', label: 'Mở Build' },
      });
    } else if (task && !task.name) {
      issues.push({
        id: 'build-name',
        title: 'Build chưa đặt Name',
        detail: 'playable-ads-builder lấy ô Name trong panel Build làm tên thư mục và tên file xuất; để trống thì nó bỏ qua bước xuất cho các mạng.',
        action: { type: 'open-build', label: 'Mở Build' },
      });
    } else if (task && task.pkg && !Object.keys(task.pkg).some((key) => key.startsWith('channel_') && task.pkg[key] === true)) {
      issues.push({
        id: 'no-channels',
        title: 'Chưa tick mạng quảng cáo nào',
        detail: `Build "${task.name}" chưa chọn mạng nào trong phần playable-ads-builder của panel Build, nên sẽ không có file xuất cho mạng nào.`,
        action: { type: 'open-build', label: 'Mở Build' },
      });
    }
  }

  // Model bật Encode mà module meshopt (ẩn trong Feature Cropping) đang tắt: build lỗi 16352, model không hiện.
  // Cocos dưới 3.8 không có meshopt / Mesh Compress: không có gì để kiểm.
  if (caps.meshopt) {
    checks.push('module meshopt');
    const engine = await readJsonFile(path.join(projectRoot, 'settings', 'v2', 'packages', 'engine.json'));
    const meshopt = meshoptState(engine && engine.modules);
    if (meshopt.known && !meshopt.enabled) {
      const encoded = (await scanModels(projectRoot, { caps })).filter((model) => model.compress.encode);
      if (encoded.length) {
        issues.push({
          id: 'meshopt',
          title: `${encoded.length} model bật Encode nhưng module meshopt đang tắt`,
          detail: 'Build sẽ lỗi 16352 (decodeVertexBuffer is not a function) và các model đó không hiện. meshopt bị ẩn trong Feature Cropping nên phải bật ở đây (~5 KB).',
          action: { type: 'enable-meshopt', label: 'Bật meshopt' },
        });
      }
    }
  }

  return withChecks ? { issues, checks, exporter, caps } : issues;
}

/**
 * Một câu về công cụ xuất playable của dự án (Tổng quan, trang HTML cuối, selftest): tool đọc được gì, thiếu gì.
 * '' khi dự án dùng playable-ads-builder (mọi phần chạy đủ).
 */
function describeExporterNote(exporter) {
  if (!exporter || exporter.builder) {
    return '';
  }
  if (exporter.adapter) {
    return `Dự án xuất bằng playable-ads-adapter${exporter.adapter.version ? ` ${exporter.adapter.version}` : ''}: tool đọc được file nó xuất (<tên>_<Mạng>.html, single-file-3x.html, thư mục <tên>_<Mạng>/ tính theo zip ước tính) nhưng không đọc cấu hình nén của adapter và không mô phỏng được bản xuất khi chưa xuất (mô phỏng chỉ có cho playable-ads-builder).`;
  }
  return 'Dự án chưa có playable-ads-builder hay playable-ads-adapter: tool chỉ phân tích thư mục build web-mobile (file HTML cuối do công cụ khác tạo thì chưa đọc được).';
}

module.exports = {
  checkSetup,
  describeExporterNote,
};
