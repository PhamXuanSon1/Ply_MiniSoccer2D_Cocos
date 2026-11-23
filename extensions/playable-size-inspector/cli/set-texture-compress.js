#!/usr/bin/env node
'use strict';
/**
 * Bật / tắt Texture Compress hàng loạt từ terminal, KHÔNG cần mở Cocos Creator.
 * Dùng chung logic với panel (lib/texture-compress.js).
 *
 * Cách dùng:
 *   node extensions/playable-size-inspector/cli/set-texture-compress.js <thư mục> [tuỳ chọn]
 *
 * Tuỳ chọn:
 *   --preset <tên|id>   Preset trong settings/v2/packages/builder.json (mặc định: preset đầu tiên đã có định dạng nén)
 *   --atlas             Áp dụng thêm cho auto-atlas (*.pac)
 *   --off               Tắt nén (xoá compressSettings) thay vì bật
 *   --force             Ghi đè cả asset đang dùng preset khác
 *   --dry-run           Chỉ liệt kê, không ghi file
 *   --list-presets      In danh sách preset rồi thoát
 *   --project <thư mục> Dự án cần sửa (mặc định: dự án chứa extension, tức <tool>/../..; tool cài global hay
 *                       nằm chỗ khác thì phải truyền). Thư mục ảnh tính tương đối theo dự án này.
 *
 * Ví dụ:
 *   node extensions/playable-size-inspector/cli/set-texture-compress.js assets/3.Sprites --preset SingleHTML
 *   node extensions/playable-size-inspector/cli/set-texture-compress.js assets/8.Models --preset SingleHTML --force
 *   node extensions/playable-size-inspector/cli/set-texture-compress.js assets/3.Sprites --off
 *
 * Sau khi chạy: trong Cocos Creator, panel Assets -> chuột phải -> Refresh (Ctrl+R) để re-import meta.
 */

const fs = require('fs');
const path = require('path');
const textureCompress = require('../lib/texture-compress');

// Dự án: --project, không thì dự án chứa extension (<project>/extensions/playable-size-inspector/cli).
let PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

function printHelp() {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith('/**'));
  const end = lines.findIndex((line) => line.trim() === '*/');
  console.log(lines.slice(start + 1, end).map((line) => line.replace(/^ \* ?/, '')).join('\n'));
}

function parseArgs(argv) {
  const options = { folder: '', preset: '', atlas: false, off: false, force: false, dryRun: false, listPresets: false, project: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--preset': options.preset = argv[++index]; break;
      case '--atlas': options.atlas = true; break;
      case '--off': options.off = true; break;
      case '--force': options.force = true; break;
      case '--dry-run': options.dryRun = true; break;
      case '--list-presets': options.listPresets = true; break;
      case '--project': options.project = argv[++index] || ''; break;
      case '-h':
      case '--help': printHelp(); process.exit(0); break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Tuỳ chọn không hợp lệ: ${arg}`);
          printHelp();
          process.exit(1);
        }
        options.folder = arg;
    }
  }
  return options;
}

function describePreset(preset) {
  return `${preset.name}  (id: ${preset.id})  [${preset.unconfigured ? 'chưa cấu hình định dạng' : preset.formats.join(', ')}]`;
}

(async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.project) {
    PROJECT_ROOT = path.resolve(options.project);
  }
  if (!fs.existsSync(path.join(PROJECT_ROOT, 'assets')) || !fs.existsSync(path.join(PROJECT_ROOT, 'package.json'))) {
    console.error(`${PROJECT_ROOT} không phải thư mục gốc dự án Cocos (thiếu assets/ hoặc package.json). Truyền --project <thư mục dự án>.`);
    process.exit(1);
  }
  console.log(`Dự án: ${PROJECT_ROOT}`);
  const presets = await textureCompress.readPresets(PROJECT_ROOT);

  if (options.listPresets) {
    console.log('Preset trong builder.json:');
    for (const preset of presets) {
      console.log(`  ${describePreset(preset)}`);
    }
    return;
  }
  if (!options.folder) {
    printHelp();
    process.exit(1);
  }

  let presetId = '';
  if (!options.off) {
    if (!presets.length) {
      console.error('Chưa có preset nào trong builder.json. Tạo preset trong Project Settings -> Texture Compress trước.');
      process.exit(1);
    }
    // Mặc định bỏ qua preset chưa có định dạng; chỉ còn loại đó thì buildPlan báo lỗi rõ ràng.
    const preset = options.preset
      ? textureCompress.findPreset(presets, options.preset)
      : presets.find((item) => !item.unconfigured) || presets[0];
    if (!preset) {
      console.error(`Không tìm thấy preset "${options.preset}". Có sẵn:`);
      for (const item of presets) {
        console.error(`  ${describePreset(item)}`);
      }
      process.exit(1);
    }
    presetId = preset.id;
    console.log(`Preset: ${describePreset(preset)}`);
  }

  const plan = await textureCompress.buildPlan(PROJECT_ROOT, {
    folder: path.resolve(PROJECT_ROOT, options.folder),
    mode: options.off ? 'disable' : 'enable',
    presetId,
    includeAtlas: options.atlas,
    force: options.force,
  });

  const relative = (file) => path.relative(PROJECT_ROOT, file).split(path.sep).join('/');
  for (const row of plan.rows) {
    if (row.action === 'update') {
      console.log(`[${options.dryRun ? 'DRY ' : 'OK  '}] ${relative(row.metaPath)}`);
    } else if (row.action === 'error') {
      console.error(`[ERR ] ${relative(row.metaPath)}: ${row.reason}`);
    } else if (row.reason.includes('preset khác')) {
      console.log(`[SKIP] ${relative(row.metaPath)} ${row.reason}`);
    }
  }

  const counts = { update: 0, skip: 0, error: 0 };
  for (const row of plan.rows) {
    counts[row.action] = (counts[row.action] || 0) + 1;
  }

  if (!options.dryRun && counts.update) {
    const { updated, failed } = await textureCompress.applyPlan(plan, textureCompress.writeMetaFile);
    counts.update = updated;
    counts.error += failed.length;
    for (const message of failed) {
      console.error(`[ERR ] ${message}`);
    }
  }

  console.log(`\nXong. updated=${counts.update} skipped=${counts.skip} errors=${counts.error}${options.dryRun ? '  (dry-run, chưa ghi file)' : ''}`);
  if (!options.dryRun && counts.update > 0) {
    console.log('-> Mở Cocos Creator, panel Assets: chuột phải -> Refresh (Ctrl+R) để re-import.');
  }
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
