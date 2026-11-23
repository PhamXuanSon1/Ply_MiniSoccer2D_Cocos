#!/usr/bin/env node
'use strict';

/**
 * Tự kiểm tra trên một dự án (của mình hay của người khác, Cocos 3.6 – 3.8.x): chạy toàn bộ phần phân tích
 * (bản build, bản xuất theo mạng, ảnh, audio, model 3D, "Việc nên làm", lịch sử) và báo cái nào chạy được, cái nào
 * thiếu. Chỉ ĐỌC: mặc định chặn mọi lệnh ghi file vào dự án (có ghi là báo lỗi). Không cần mở Cocos, không cần
 * chép tool vào dự án đó.
 *
 *   node cli/selftest.js                       # dự án chứa extension (tool nằm ở <dự án>/extensions/)
 *   node cli/selftest.js D:/Cocos/X            # dự án khác
 *   node cli/selftest.js D:/Cocos/X --build build/web-mobile-001
 *
 * Tuỳ chọn:
 *   --build <thư mục>   bản build cần phân tích (mặc định: thư mục của build task web mới nhất, rồi bản mới nhất)
 *   --work-dir <dir>    thư mục tạm cho file nháp của tool (mặc định không dùng tới; đặt PSI_WORK_DIR)
 *   --allow-write       tắt chặn ghi vào dự án (chỉ để gỡ lỗi)
 *
 * Mã thoát: 0 = không có lỗi (có thể có cảnh báo), 1 = có lỗi.
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || '') : '';
}
const positional = args.filter((arg, index) => !arg.startsWith('--') && !['--build', '--work-dir'].includes(args[index - 1]));
const TOOL_ROOT = path.join(__dirname, '..');
const projectRoot = path.resolve(positional[0] || path.join(TOOL_ROOT, '..', '..'));
if (option('--work-dir')) {
  process.env.PSI_WORK_DIR = path.resolve(option('--work-dir'));
}

const counts = { ok: 0, warn: 0, error: 0 };
const ICONS = { ok: '✓', warn: '!', error: '✗', info: '·' };
function report(level, message) {
  if (counts[level] !== undefined) {
    counts[level] += 1;
  }
  console.log(`  ${ICONS[level]} ${message}`);
}

// Chặn mọi lệnh ghi vào dự án đang kiểm tra (selftest chỉ đọc); phải chạy trước khi nạp lib.
const { guardWrites } = require(path.join(TOOL_ROOT, 'lib', 'write-guard'));
const guard = args.includes('--allow-write') ? { blocked: [] } : guardWrites(projectRoot);
const blockedWrites = guard.blocked;

// Nạp lib sau khi chặn ghi (lib dùng fs/promises: cùng object với fs.promises).
const lib = path.join(TOOL_ROOT, 'lib');
const { scanBuild, formatBytes, buildSourceSizeIndex, readBuildDebug } = require(path.join(lib, 'build-scan'));
const { listBuildFolders, pickDefaultBuild } = require(path.join(lib, 'build-folders'));
const { findExportSets, readBuilderAudio } = require(path.join(lib, 'exports'));
const { scanAllTextures } = require(path.join(lib, 'texture-compress'));
const audio = require(path.join(lib, 'audio'));
const { buildInsights, readProjectEvidence } = require(path.join(lib, 'insights'));
const history = require(path.join(lib, 'history'));
const toolchain = require(path.join(lib, 'toolchain'));
const { checkSetup, describeExporterNote } = require(path.join(lib, 'setup-check'));
const engineModules = require(path.join(lib, 'engine-modules'));
const modelCompress = require(path.join(lib, 'model-compress'));
const { readExportBreakdown, mapToBuildRows } = require(path.join(lib, 'html-export'));
const { readJsonFile } = require(path.join(lib, 'fs-utils'));
const compat = require(path.join(lib, 'compat'));

toolchain.setProjectRoot(projectRoot);

/** Kiểu nút "Việc nên làm" mà panel xử lý được (panels/default/index.js runInsightAction). */
const ACTION_TYPES = new Set(['reveal', 'open-settings', 'texture', 'audio', 'audio-open', 'modules', 'model', 'open-build']);
const TOOL_PACKAGE = JSON.parse(fs.readFileSync(path.join(TOOL_ROOT, 'package.json'), 'utf8'));

async function step(title, run) {
  console.log(`\n${title}`);
  const start = Date.now();
  try {
    const value = await run();
    console.log(`    (${Date.now() - start} ms)`);
    return value;
  } catch (error) {
    report('error', `lỗi: ${error.message || error}`);
    return null;
  }
}

function fileHash(file) {
  try {
    return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex').slice(0, 8);
  } catch (_error) {
    return '';
  }
}

(async () => {
  console.log(`Playable Size Inspector ${TOOL_PACKAGE.version} - tự kiểm tra (chỉ đọc${args.includes('--allow-write') ? ', KHÔNG chặn ghi' : ''})`);
  console.log(`Dự án: ${projectRoot}`);
  console.log(`Tool: ${path.resolve(TOOL_ROOT)} · Node ${process.version} · ${process.platform}${process.env.PSI_WORK_DIR ? ` · thư mục tạm ${process.env.PSI_WORK_DIR}` : ''}`);

  const caps = compat.readCaps(projectRoot);
  let exporter = null;

  await step('Dự án', async () => {
    if (!fs.existsSync(path.join(projectRoot, 'package.json'))) {
      report('error', 'Không thấy package.json: đây không phải thư mục gốc của một dự án Cocos Creator');
      return;
    }
    const version = caps.version || '?';
    if (!caps.version) {
      report('warn', 'Không đọc được bản Cocos Creator (package.json thiếu creator.version)');
    } else if (!caps.supported) {
      report('error', `Cocos Creator ${version}: tool cần ${compat.MIN_VERSION} trở lên`);
    } else if (!caps.meshCompress) {
      report('warn', `Cocos Creator ${version}: phân tích được hết; Mesh Compress / Mesh Simplify / meshopt và bật tắt module trong tool cần 3.8 (bị ẩn trên bản này)`);
    } else {
      report('ok', `Cocos Creator ${version}`);
    }
    if (fs.existsSync(path.join(projectRoot, 'library', '.assets-data.json'))) {
      report('ok', 'Có library/ (Editor đã mở dự án ít nhất một lần)');
    } else {
      report('error', 'Chưa có library/.assets-data.json: mở dự án trong Cocos một lần rồi chạy lại');
    }
    // Bản tool chép trong dự án khác bản đang chạy: dev khác mở dự án sẽ thấy bản đó, không phải bản này.
    const local = path.join(projectRoot, 'extensions', 'playable-size-inspector');
    if (fs.existsSync(path.join(local, 'package.json')) && path.resolve(local).toLowerCase() !== path.resolve(TOOL_ROOT).toLowerCase()) {
      const pkg = compat.readExtensionPackage(local) || {};
      const same = fileHash(path.join(local, 'main.js')) === fileHash(path.join(TOOL_ROOT, 'main.js'))
        && fileHash(path.join(local, 'lib', 'insights.js')) === fileHash(path.join(TOOL_ROOT, 'lib', 'insights.js'));
      if (same) {
        report('ok', `Dự án có bản tool ${pkg.version || '?'} giống bản đang chạy`);
      } else {
        const older = compat.versionAtLeast(TOOL_PACKAGE.version, pkg.version || '0.0.0') && pkg.version !== TOOL_PACKAGE.version;
        report('warn', `Dự án có bản tool khác (${pkg.version || '?'}${older ? ', cũ hơn' : pkg.version === TOOL_PACKAGE.version ? ', cùng số phiên bản nhưng khác mã' : ''}) ở extensions/playable-size-inspector; bản đang chạy là ${TOOL_PACKAGE.version}. Chép đè thư mục tool (giữ node_modules nếu có) để mọi người dùng cùng bản.`);
      }
    }
    const tools = toolchain.describeToolchain();
    if (tools.ffmpeg) {
      report('ok', `ffmpeg: ${tools.ffmpeg}`);
    }
    report('info', tools.npm ? `Node.js / npm: ${tools.npm}` : 'Máy chưa có Node.js / npm (chỉ cần khi phải tải ffmpeg)');
    // Cùng bộ kiểm tra panel tự chạy khi mở (thẻ "Thiết lập còn thiếu").
    const setup = await checkSetup(projectRoot, { withChecks: true });
    exporter = setup.exporter;
    if (exporter.builder) {
      report('info', `Xuất playable bằng playable-ads-builder ${exporter.builder.version || ''}${exporter.builder.dir ? '' : ' (chỉ thấy cấu hình, không thấy extension)'}`.trim());
    }
    const note = describeExporterNote(exporter);
    if (note) {
      report('info', note);
    }
    for (const issue of setup.issues) {
      report('warn', `${issue.title}: ${issue.detail}`);
    }
    if (!setup.issues.length) {
      report('ok', `Thiết lập đủ: ${setup.checks.join(', ')}`);
    }
  });

  const build = await step('Bản build', async () => {
    const builds = await listBuildFolders(projectRoot);
    let target = null;
    if (option('--build')) {
      const fullPath = path.resolve(projectRoot, option('--build'));
      target = builds.find((item) => path.resolve(item.fullPath).toLowerCase() === fullPath.toLowerCase()) || { relative: option('--build'), fullPath };
    }
    if (!target && !builds.length) {
      report('warn', 'Chưa có bản build web nào: panel sẽ hướng dẫn Build web-mobile. Phần ảnh / audio bên dưới chỉ tính file scene / prefab / resources dùng tới.');
      return null;
    }
    report('info', `${builds.length} bản build: ${builds.map((item) => `${item.relative}${item.taskId ? ' (build task)' : ''}`).join(', ')}`);
    if (!target) {
      const pick = await pickDefaultBuild(projectRoot, builds);
      target = { relative: pick.relative, fullPath: pick.fullPath };
      report('info', `Phân tích ${pick.relative} (${pick.reason === 'task' ? 'thư mục của build task web mới nhất' : pick.reason === 'newest' ? 'bản build mới nhất' : 'mặc định'})`);
    }
    const result = await scanBuild({ projectRoot, buildRoot: target.fullPath });
    report('ok', `${target.relative}: ${result.buildFiles.length} file, ${formatBytes(result.totalBuildBytes)}`);
    if (await readBuildDebug(target.fullPath)) {
      report('info', 'Bản build này bật Debug (lớn hơn bản release): build lại không tick Debug để có số đúng với bản gửi mạng');
    }
    // File engine / cấu hình vốn không có asset nguồn và đã được gọi tên; chỉ "sinh ra lúc build" là chưa rõ.
    const unknown = result.assetRows.filter((row) => !row.source && /^Sinh ra lúc build/.test(row.sourceNote));
    report(unknown.length ? 'warn' : 'ok', unknown.length
      ? `${unknown.length} file chưa rõ nguồn (${formatBytes(unknown.reduce((sum, row) => sum + row.size, 0))}), vd ${unknown[0].relativePath}`
      : 'Mọi file đều biết nguồn (asset của dự án, asset dựng sẵn hoặc file của engine)');
    return { assetRows: result.assetRows, buildRoot: target.fullPath };
  });

  await step('Bản xuất theo mạng', async () => {
    const sets = await findExportSets(projectRoot);
    if (!sets.length) {
      report('info', 'Chưa thấy bản xuất nào (<Mạng>_<Tên>.html / .zip của playable-ads-builder, <Tên>_<Mạng>.html / single-file-3x.html của playable-ads-adapter). Bình thường nếu chưa xuất playable.');
      return;
    }
    for (const set of sets.slice(0, 3)) {
      const label = set.config ? `${set.label} (tên build "${set.config.name}", tick ${set.config.channels.length} mạng)` : `${set.label}${set.tool === 'adapter' ? ' (playable-ads-adapter)' : ''}`;
      if (!set.items.length) {
        report('warn', `${label}: chưa có file xuất`);
        continue;
      }
      report('ok', `${label}: ${set.items.map((item) => `${item.channel}${item.kind === 'folder' ? ' (thư mục)' : ''} ${item.zipEstimated ? '≈ ' : ''}${formatBytes(item.bytes)}`).join(', ')}`);
      if (set.missing.length) {
        report('warn', `${set.label}: đã tick nhưng thiếu file: ${set.missing.join(', ')}`);
      }
    }
    // Trang "HTML cuối": đọc thử một file đã xuất (ưu tiên bộ của bản build đang xét, không cũ hơn bản build).
    const ordered = [
      ...sets.filter((set) => build && set.config && path.resolve(set.config.buildDir).toLowerCase() === path.resolve(build.buildRoot).toLowerCase()),
      ...sets,
    ];
    const item = ordered.flatMap((set) => set.items).find((entry) => !entry.stale && (entry.kind === 'html' || entry.kind === 'zip'));
    if (!item) {
      return;
    }
    const breakdown = await readExportBreakdown(item.path);
    if (breakdown.unsupported) {
      report('warn', `Không đọc được ${item.name} cho trang HTML cuối: ${breakdown.reason}`);
      return;
    }
    const mapped = build ? mapToBuildRows(build.assetRows, breakdown) : null;
    const top = breakdown.files.slice().sort((left, right) => right.bytes - left.bytes).slice(0, 3)
      .map((file) => `${file.path.split('/').pop()} ${formatBytes(file.bytes)}`).join(', ');
    report('ok', `Đọc được ${item.name}${breakdown.tool === 'adapter' ? ' (playable-ads-adapter)' : ''}: ${breakdown.files.length} file${mapped ? ` (khớp ${mapped.rows.length} file của bản build)` : ''}, khung ${formatBytes(breakdown.frameBytes)}; nặng nhất: ${top}`);
    if (mapped && breakdown.files.length && mapped.rows.length < breakdown.files.length * 0.6) {
      report('info', `${item.name} chỉ khớp ${mapped.rows.length}/${breakdown.files.length} file của bản build đang xét: có thể xuất từ bản build khác (trang HTML cuối dồn phần không khớp vào "Khung playable")`);
    }
  });

  const textures = await step('Ảnh nguồn', async () => {
    const result = await scanAllTextures(projectRoot);
    report('ok', `${result.rows.length} ảnh, ${result.rows.filter((row) => row.enabled).length} đã bật nén`);
    if (result.presets.length) {
      report('info', `Preset nén: ${result.presets.map((preset) => preset.name).join(', ')}`);
    }
    return result.rows;
  });

  const audioFiles = await step('Âm thanh nguồn', async () => {
    const files = await audio.scanSourceAudio(projectRoot);
    const failed = files.filter((file) => file.probeError);
    report(failed.length ? 'warn' : 'ok', `${files.length} file audio${failed.length ? `, ${failed.length} không đọc được (${failed[0].probeError})` : ''}`);
    return files;
  });

  const models = await step('Model 3D', async () => {
    const list = await modelCompress.scanModels(projectRoot, { caps });
    const engine = await readJsonFile(path.join(projectRoot, 'settings', 'v2', 'packages', 'engine.json'));
    const meshopt = modelCompress.meshoptState((engine && engine.modules) || null);
    // Cùng luật với tab Model 3D và "Việc nên làm" (lib/model-compress.js).
    const inBuild = build ? list.filter((model) => modelCompress.modelBuildFiles(model, build.assetRows).length) : [];
    report('ok', `${list.length} model trong assets/${build ? `, ${inBuild.length} trong build` : ''}${caps.meshCompress ? `, ${list.filter((model) => model.compress.quantize).length} đã nén mesh` : ''}, ${list.reduce((sum, model) => sum + model.triangles, 0).toLocaleString('vi-VN')} tam giác`);
    if (!list.length) {
      return list;
    }
    if (!caps.meshCompress) {
      report('info', `Cocos ${caps.version}: chưa có Mesh Compress / Mesh Simplify nên tool không gợi ý nén / giảm tam giác (số tam giác đọc từ library/)`);
    }
    const todo = inBuild.filter((model) => modelCompress.modelTodos(model, true).length);
    if (todo.length) {
      report('info', `${todo.length} model trong build cần xử lý (chưa nén mesh / từ ${modelCompress.HEAVY_TRIANGLES} tam giác chưa giảm): ${todo.slice(0, 3).map((model) => model.name).join(', ')}`);
    }
    if (caps.meshopt) {
      report('info', `module meshopt: ${meshopt.known ? (meshopt.enabled ? 'đang bật' : 'đang tắt') : 'chưa lưu Feature Cropping'}`);
    }
    const failed = list.filter((model) => model.importFailed.length);
    if (failed.length) {
      report('error', `${failed.length} model Cocos import lỗi (mesh không vào build): ${failed.slice(0, 3).map((model) => `${model.name}${model.vertexColors && model.compress.quantize ? ' (màu đỉnh + Quantize)' : ''}`).join(', ')}`);
    }
    const colored = list.filter((model) => model.vertexColors && model.compress.quantize);
    if (colored.length) {
      report('warn', `${colored.length} model có màu đỉnh mà đang bật Quantize (Cocos import sập): ${colored.slice(0, 3).map((model) => model.name).join(', ')}`);
    }
    const encoded = list.filter((model) => model.compress.encode);
    if (encoded.length && meshopt.known && !meshopt.enabled) {
      report('error', `${encoded.length} model bật Encode nhưng meshopt đang tắt: build sẽ lỗi 16352`);
    }
    return list;
  });

  const diagnostics = [];
  const insights = await step('Việc nên làm', async () => {
    const list = await buildInsights({
      projectRoot,
      build,
      textures,
      audio: audioFiles,
      builderAudio: await readBuilderAudio(projectRoot, build ? build.buildRoot : '').catch(() => null),
      buildSizeBySource: build ? buildSourceSizeIndex(build.assetRows) : null,
      models,
      diagnostics,
    });
    report('ok', `${list.length} gợi ý (xếp theo dung lượng ước tính giảm được, sau zip)`);
    for (const insight of list.slice(0, 12)) {
      report('info', `${insight.title} <${insight.impact} · ${insight.basis}>`);
    }
    if (list.length > 12) {
      report('info', `... và ${list.length - 12} gợi ý khác`);
    }
    // Mọi gợi ý phải có saving để xếp hạng cùng một đơn vị, và đúng dạng panel vẽ được.
    const unranked = list.filter((insight) => !Number.isFinite(insight.saving));
    if (unranked.length) {
      report('error', `${unranked.length} gợi ý thiếu saving: ${unranked.map((insight) => insight.id).join(', ')}`);
    }
    const broken = list.filter((insight) => !insight.id || !insight.group || !insight.title || typeof insight.detail !== 'string' || typeof insight.impact !== 'string'
      || (insight.action && !ACTION_TYPES.has(insight.action.type)));
    if (broken.length) {
      report('error', `${broken.length} gợi ý sai dạng (thiếu trường / kiểu nút panel không xử lý): ${broken.map((insight) => insight.id).join(', ')}`);
    }
    return list;
  });

  // Các kiểm tra chung của lib/build-checks.js (đã chạy trong Việc nên làm): từng kiểm tra ra gợi ý gì, bỏ qua vì sao.
  await step('Kiểm tra dung lượng chung (lib/build-checks.js)', async () => {
    if (!diagnostics.length) {
      report('info', 'Không chạy (Việc nên làm lỗi ở trên)');
      return;
    }
    const byId = new Map((insights || []).map((insight) => [insight.id, insight]));
    for (const item of diagnostics) {
      if (item.error) {
        report('warn', `${item.label}: lỗi ${item.error}`);
        continue;
      }
      if (!item.insights) {
        report('info', `${item.label}: không có gợi ý${item.skipped ? ` (${item.skipped})` : ''} [${item.ms || 0} ms]`);
        continue;
      }
      report('ok', `${item.label}: ${item.insights} gợi ý${item.skipped ? ` (ghi chú: ${item.skipped})` : ''} [${item.ms || 0} ms]`);
      for (const id of item.ids || []) {
        const insight = byId.get(id);
        if (insight) {
          report('info', `  ${insight.title} <${insight.impact} · ${insight.basis}>`);
        }
      }
    }
  });

  await step('Module engine (Feature Cropping)', async () => {
    const settings = await readJsonFile(path.join(projectRoot, 'settings', 'v2', 'packages', 'engine.json'));
    const result = engineModules.describeModules((settings && settings.modules) || null, await readProjectEvidence(projectRoot), null, { version: caps.version });
    if (!result.ok) {
      report('info', caps.featureCroppingConfigs
        ? 'Dự án chưa lưu cấu hình Feature Cropping (dùng mặc định): phần bật / tắt module trong tool chưa dùng được.'
        : `Cocos ${caps.version}: chưa đọc được cấu hình Feature Cropping.`);
      return;
    }
    if (result.legacy) {
      report('info', `Cocos ${caps.version} lưu Feature Cropping theo định dạng cũ: tool chỉ đọc, bật / tắt trong Project Settings`);
    }
    const enabled = result.entries.filter((entry) => entry.enabled);
    report('ok', `${enabled.length} module tuỳ chọn đang bật: ${enabled.map((entry) => entry.label).join(', ') || '(không có)'}`);
    for (const entry of result.entries.filter((item) => item.enabled && !item.used)) {
      report('info', `không thấy dùng: ${entry.label}`);
    }
    for (const entry of result.entries.filter((item) => !item.enabled && item.used)) {
      // Component thật trong thứ vào build thì đáng cảnh báo; scene / prefab không vào build (asset thừa) hay chỉ chữ
      // trong script (có thể là code mẫu) thì chỉ ghi chú.
      report(entry.inScenes ? 'warn' : 'info', entry.inScenes
        ? `${entry.label} đang tắt nhưng scene / prefab dùng (${entry.usedBy[0]})`
        : entry.notShipped
          ? `${entry.label} đang tắt; chỉ asset không vào build dùng tới (${entry.usedBy[0]}): bật lại nếu đưa asset đó vào build`
          : `${entry.label} đang tắt, script có nhắc tới (${entry.usedBy[0]})`);
    }
  });

  await step('Lịch sử thay đổi', async () => {
    const entries = await history.readHistory(projectRoot);
    const backups = await history.listAudioBackups(projectRoot);
    report('ok', `${entries.length} mục lịch sử, ${backups.length} lần dự phòng audio (${formatBytes(backups.reduce((sum, item) => sum + item.bytes, 0))})`);
  });

  if (blockedWrites.length) {
    console.log('\nChặn ghi vào dự án');
    report('error', `${blockedWrites.length} lệnh ghi bị chặn (selftest phải chỉ đọc): ${blockedWrites.slice(0, 3).join('; ')}`);
  }

  console.log(`\nKết quả: ${counts.ok} ổn, ${counts.warn} cảnh báo, ${counts.error} lỗi.`);
  process.exitCode = counts.error ? 1 : 0;
})();
