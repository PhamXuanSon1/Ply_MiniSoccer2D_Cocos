'use strict';

const path = require('path');
const fsPromises = require('fs/promises');
const textureCompress = require('./lib/texture-compress');
const audio = require('./lib/audio');
const { fsPathToUrl, toFsPath } = require('./lib/asset-url');
const { isPathInside, isSameResolvedPath } = require('./lib/fs-utils');
const { describeToolchain, installDependencies } = require('./lib/toolchain');
const { estimateSizes, presetToEncodeOptions } = require('./lib/estimate');
const history = require('./lib/history');
const engineModules = require('./lib/engine-modules');
const modelCompress = require('./lib/model-compress');
const { readProjectEvidence } = require('./lib/insights');
const { simulateExport } = require('./lib/html-sim');
const { readExportConfigs, findExportConfig, readBuilderAudio } = require('./lib/exports');
const { listBuildFolders } = require('./lib/build-folders');
const { readCaps, workDir } = require('./lib/compat');

const PACKAGE_NAME = 'playable-size-inspector';

function log(...args) {
  console.log(`[${PACKAGE_NAME}]`, ...args);
}

exports.methods = {
  openPanel() {
    Editor.Panel.open(PACKAGE_NAME);
  },

  /** Chọn + nháy sáng asset nguồn trong panel Assets. Nhận { uuid } hoặc { url }. */
  async revealAsset(payload) {
    const uuid = String(payload && payload.uuid || '').trim();
    const url = String(payload && payload.url || '').trim();

    if (!uuid && !url) {
      return { ok: false, reason: 'missing-target' };
    }

    const targetUuid = uuid || await resolveUuidFromUrl(url);
    if (!targetUuid) {
      return { ok: false, reason: 'uuid-not-found' };
    }

    const selection = Editor.Selection;
    if (selection && typeof selection.select === 'function') {
      try {
        selection.select('asset', targetUuid);
      } catch (_error) {
        try {
          selection.select(targetUuid);
        } catch (_innerError) {
          // Vẫn thử nháy sáng bên dưới.
        }
      }
    }

    try {
      await Editor.Message.request('assets', 'twinkle', targetUuid);
      return { ok: true, mode: 'assets.twinkle', uuid: targetUuid };
    } catch (_error) {
      // twinkle là method của panel Assets (panel đóng thì lỗi): chỉ còn selection. Không dùng
      // asset-db 'open-asset': lệnh đó MỞ asset (scene / script / app ngoài) chứ không reveal.
    }

    return { ok: true, mode: 'selection-only', uuid: targetUuid };
  },

  // ---------------------------------------------------------------- texture compress (nguồn)

  async textureListPresets() {
    return { ok: true, presets: await textureCompress.readPresets(Editor.Project.path) };
  },

  /** Quét toàn bộ assets/ cho bước Tối ưu → Ảnh (lưới / cây thư mục). */
  async textureScanAll() {
    try {
      const result = await textureCompress.scanAllTextures(Editor.Project.path);
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  },

  /**
   * Nén thử các asset đã chọn với một preset để biết TRƯỚC dung lượng sau nén,
   * không cần Build. Dùng đúng sharp của Editor nên kết quả trùng byte với
   * Texture Compress thật.
   */
  async textureEstimate(payload) {
    const options = payload || {};
    const refs = Array.isArray(options.refs) ? options.refs : [];
    if (!refs.length) {
      return { ok: false, error: 'Chưa chọn asset nào.' };
    }

    const projectRoot = Editor.Project.path;
    const presets = await textureCompress.readPresets(projectRoot);
    const preset = textureCompress.findPreset(presets, options.presetId);
    if (!preset) {
      return { ok: false, error: `Không tìm thấy preset "${options.presetId || '(trống)'}".` };
    }
    const encodeOptions = presetToEncodeOptions(preset);
    if (!encodeOptions) {
      return { ok: false, error: `Preset "${preset.name}" chưa cấu hình định dạng nén nào.` };
    }

    const jobs = [];
    const sourceBytes = {};
    for (const ref of refs) {
      const state = await textureCompress.readAssetCompressState(projectRoot, ref);
      if (!state || !state.compressible) {
        continue;
      }
      const input = await textureCompress.resolveCompressInput(projectRoot, state.uuid, state.assetPath);
      const stat = await fsPromises.stat(input).catch(() => null);
      if (!stat) {
        continue;
      }
      sourceBytes[ref] = stat.size;
      jobs.push({ id: ref, input, format: encodeOptions.format, quality: encodeOptions.quality });
    }
    if (!jobs.length) {
      return { ok: false, error: 'Không có asset nào ước tính được (kiểu import không hỗ trợ hoặc thiếu file).' };
    }

    try {
      const result = await estimateSizes(jobs, { workDir: workDir(projectRoot, 'estimate') });
      const estimates = {};
      for (const [ref, value] of Object.entries(result.images || {})) {
        estimates[ref] = { ...value, sourceBytes: sourceBytes[ref] || 0 };
      }
      log(`ước tính ${jobs.length} ảnh với preset ${preset.name} (${encodeOptions.format}@${encodeOptions.quality})`);
      return {
        ok: true,
        estimates,
        preset: { id: preset.id, name: preset.name },
        encodeOptions,
        exact: String(result.sharpSource || '').includes('app.asar'),
      };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  },

  /**
   * Áp preset / tắt nén cho đúng danh sách asset (payload: { refs, mode: 'enable' | 'disable', presetId }):
   * các ảnh đang tick trong cây, hoặc một ảnh ở khung Chi tiết. Người dùng chọn tường minh nên luôn ghi đè.
   */
  async textureApplyAssets(payload) {
    const options = payload || {};
    const refs = Array.isArray(options.refs) ? options.refs : [];
    if (!refs.length) {
      return { ok: false, error: 'Chưa chọn asset nào.' };
    }
    let plan;
    try {
      plan = await textureCompress.buildPlanForAssets(Editor.Project.path, refs, {
        mode: options.mode === 'disable' ? 'disable' : 'enable',
        presetId: options.presetId,
        includeAtlas: true,
        force: true,
      });
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
    if (!plan.rows.length) {
      return { ok: false, error: 'Không có asset nào hỗ trợ Texture Compress trong lựa chọn.' };
    }
    return await applyTexturePlanInEditor(plan);
  },

  // ---------------------------------------------------------------- HTML cuối (ước tính khi chưa xuất)

  /**
   * Mô phỏng playable-ads-builder trên bản build (payload.buildRoot) để biết mỗi file chiếm bao nhiêu
   * trong HTML cuối, dùng đúng cấu hình nén của build task tương ứng.
   */
  async htmlSimulate(payload) {
    const projectRoot = Editor.Project.path;
    const buildRoot = path.resolve(String(payload && payload.buildRoot || ''));
    try {
      const configs = await readExportConfigs(projectRoot);
      // Trong project, hoặc đúng thư mục build của một build task / bản build tool đã liệt kê (Build Path ngoài dự án).
      const known = isPathInside(buildRoot, projectRoot)
        || configs.some((config) => isSameResolvedPath(config.buildDir, buildRoot))
        || (await listBuildFolders(projectRoot).catch(() => [])).some((build) => isSameResolvedPath(build.fullPath, buildRoot));
      if (!known) {
        return { ok: false, error: 'Thư mục build phải nằm trong project hoặc là thư mục của một build task.' };
      }
      const config = findExportConfig(configs, buildRoot);
      const result = await simulateExport({
        projectRoot,
        buildRoot,
        compression: config ? config.compression : undefined,
        audio: config ? config.audio : undefined,
        channel: config && config.channels[0] ? config.channels[0] : 'AppLovin',
      });
      return { ok: true, ...result, settings: config ? { compression: config.compression, audio: config.audio, name: config.name } : null };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  },

  // ---------------------------------------------------------------- module engine (Feature Cropping)

  /** Module tuỳ chọn của dự án: đang bật / tắt, có thấy dùng không (kèm bằng chứng). */
  async engineModulesScan() {
    try {
      const modules = await readEngineModules();
      const moduleConfig = await Editor.Message.request('engine', 'query-modules-config').catch(() => null);
      const evidence = await readProjectEvidence(Editor.Project.path);
      const caps = readCaps(Editor.Project.path);
      return { ok: true, caps, ...engineModules.describeModules(modules, evidence, moduleConfig, { version: caps.version }) };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  },

  /**
   * Bật / tắt module (payload.changes = [{ key, enable }]): ghi qua Editor.Profile giống hệt
   * Project Settings → Feature Cropping, ghi Lịch sử để hoàn tác.
   */
  async engineModulesApply(payload) {
    const changes = Array.isArray(payload && payload.changes) ? payload.changes : [];
    if (!changes.length) {
      return { ok: false, error: 'Chưa chọn module nào để đổi.' };
    }
    try {
      const before = await readEngineModules();
      const caps = readCaps(Editor.Project.path);
      if (!caps.featureCroppingConfigs && !engineModules.activeConfig(before)) {
        return { ok: false, error: `Cocos ${caps.version} lưu Feature Cropping theo định dạng cũ: tool không ghi định dạng này. Bật / tắt module trong Project Settings → Feature Cropping.` };
      }
      const moduleConfig = await Editor.Message.request('engine', 'query-modules-config').catch(() => null);
      const plan = engineModules.planModuleChange(before, changes, moduleConfig);
      if (!plan.ok) {
        return plan;
      }
      const after = await writeEngineModules(plan.modules);
      if (!after) {
        return { ok: false, error: 'Editor không nhận cấu hình module mới (Project Settings đang mở và ghi đè?). Đóng Project Settings rồi thử lại.' };
      }
      const entry = await history.appendHistory(Editor.Project.path, {
        kind: 'engine-modules',
        title: plan.labels.join(', '),
        detail: 'Module engine (Project Settings → Feature Cropping)',
        before,
        after,
      });
      log(`module engine: ${plan.labels.join(', ')}`);
      return { ok: true, labels: plan.labels, historyId: entry ? entry.id : '' };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  },

  // ---------------------------------------------------------------- model 3D (nén mesh / giảm tam giác)

  /** Model nguồn trong assets/ + trạng thái module meshopt. */
  async modelScan() {
    try {
      const caps = readCaps(Editor.Project.path);
      const models = await modelCompress.scanModels(Editor.Project.path, { caps });
      const meshopt = caps.meshopt ? modelCompress.meshoptState(await readEngineModules()) : { known: false, enabled: false, unsupported: true };
      return { ok: true, models, meshopt, caps };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  },

  /**
   * Đổi các ô Mesh Compress / Mesh Simplify (giống Inspector → Model) cho các model đã chọn.
   * payload: { uuids, settings, perModel?, title? }
   *   settings: ô chung, chỉ ô được gửi mới đổi (xem lib/model-compress.js normalizeSettings);
   *   perModel: { uuid: settings } đè lên ô chung cho riêng model đó (vd Recommended: Target Ratio theo số tam giác).
   * Có model sau khi đổi dùng Encode mà meshopt đang tắt thì bật meshopt trước (mục lịch sử riêng), để build
   * không lỗi 16352. Ghi qua asset-db: editor tự import lại các model.
   */
  async modelApply(payload) {
    const options = payload || {};
    const uuids = Array.isArray(options.uuids) ? options.uuids.filter(Boolean) : [];
    if (!uuids.length) {
      return { ok: false, error: 'Chưa chọn model nào.' };
    }
    const caps = readCaps(Editor.Project.path);
    if (!caps.meshCompress) {
      return { ok: false, error: `Cocos ${caps.version} chưa có Mesh Compress / Mesh Simplify trong Import Settings của model (có từ 3.8).` };
    }
    const common = options.settings || {};
    const perModel = options.perModel && typeof options.perModel === 'object' ? options.perModel : {};
    const settingsFor = (uuid) => {
      const own = perModel[uuid] || {};
      return {
        meshCompress: common.meshCompress || own.meshCompress ? { ...(common.meshCompress || {}), ...(own.meshCompress || {}) } : undefined,
        meshSimplify: common.meshSimplify || own.meshSimplify ? { ...(common.meshSimplify || {}), ...(own.meshSimplify || {}) } : undefined,
      };
    };
    if (!uuids.some((uuid) => modelCompress.normalizeSettings(settingsFor(uuid)))) {
      return { ok: false, error: 'Chưa đổi ô nào.' };
    }

    // Lượt 1: tính userData mới cho từng model (chưa ghi gì).
    const plans = [];
    const errors = [];
    for (const uuid of uuids) {
      try {
        const meta = await Editor.Message.request('asset-db', 'query-asset-meta', uuid);
        if (!meta) {
          errors.push(`${uuid}: không còn asset`);
          continue;
        }
        const before = modelCompress.snapshot(meta.userData);
        const userData = modelCompress.patchUserData(meta.userData, settingsFor(uuid));
        const after = modelCompress.snapshot(userData);
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          plans.push({ uuid, meta, userData, before, after });
        }
      } catch (error) {
        errors.push(`${uuid}: ${error.message || error}`);
      }
    }

    // Encode cần meshopt lúc chạy: bật trước khi ghi model nào.
    let meshoptHistoryId = '';
    if (plans.some((plan) => modelCompress.usesEncode(plan.userData))) {
      const enabled = await setMeshopt(true);
      if (!enabled.ok) {
        return enabled;
      }
      meshoptHistoryId = enabled.historyId || '';
    }

    // Lượt 2: ghi.
    const items = [];
    for (const plan of plans) {
      try {
        plan.meta.userData = plan.userData;
        await Editor.Message.request('asset-db', 'save-asset-meta', plan.uuid, JSON.stringify(plan.meta));
        const info = await Editor.Message.request('asset-db', 'query-asset-info', plan.uuid).catch(() => null);
        items.push({ uuid: plan.uuid, url: (info && info.url) || plan.uuid, before: plan.before, after: plan.after });
      } catch (error) {
        errors.push(`${plan.uuid}: ${error.message || error}`);
      }
    }
    const names = items.map((item) => path.posix.basename(item.url));
    const what = String(options.title || '') || modelCompress.describeSettings(common) || 'Model 3D';
    const title = `${what} · ${items.length} model`;
    const entry = items.length ? await history.appendHistory(Editor.Project.path, {
      kind: 'model',
      title,
      detail: listNames(names),
      items,
    }).catch(() => null) : null;
    log(`${title}${errors.length ? ` (${errors.length} lỗi)` : ''}`);
    return { ok: true, updated: items.length, errors, historyId: entry ? entry.id : '', meshoptHistoryId };
  },

  /**
   * Bật / tắt module meshopt (payload: { enabled }): ô "Meshopt Module" của form Model 3D, nút ở dải cảnh báo
   * và nút "Bật meshopt" của thẻ thiết lập ở Tổng quan.
   */
  async modelSetMeshopt(payload) {
    return await setMeshopt(!!(payload && payload.enabled));
  },

  // ---------------------------------------------------------------- lịch sử + hoàn tác

  async historyList() {
    const projectRoot = Editor.Project.path;
    const entries = await history.markMissingBackups(projectRoot, await history.readHistory(projectRoot));
    return { ok: true, entries, backups: await history.listAudioBackups(projectRoot), keep: history.KEEP_BACKUPS };
  },

  /** Dọn bản dự phòng audio cũ (payload.keep: số lần gần nhất giữ lại). */
  async historyCleanBackups(payload) {
    const keep = Math.max(0, Number(payload && payload.keep));
    try {
      const result = await history.cleanAudioBackups(Editor.Project.path, { keep: Number.isFinite(keep) ? keep : history.KEEP_BACKUPS });
      log(`dọn bản dự phòng audio: xoá ${result.removed} lần (${Math.round(result.bytes / 1024)} KB)`);
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  },

  /** Mở trang web trong trình duyệt; chỉ các trang tải công cụ tool cần (Node.js). */
  async openUrl(payload) {
    const url = String(payload && payload.url || '');
    if (!/^https:\/\/nodejs\.org(\/|$)/.test(url)) {
      return { ok: false, error: 'Chỉ mở được trang tải Node.js.' };
    }
    await require('electron').shell.openExternal(url);
    return { ok: true };
  },

  /** Mở thư mục / file (trong project) bằng trình quản lý file của hệ điều hành. */
  async openPath(payload) {
    const target = path.resolve(String(payload && payload.path || ''));
    if (!isPathInside(target, Editor.Project.path)) {
      return { ok: false, error: 'Chỉ mở được đường dẫn trong project.' };
    }
    const error = await require('electron').shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  },

  /**
   * Hoàn tác một mục lịch sử (payload: { id, force? }). Asset đã bị sửa tiếp sau đó thì trả về
   * needsForce + danh sách xung đột để panel hỏi lại; `force` để vẫn khôi phục. Chỉ đánh dấu
   * "đã hoàn tác" khi khôi phục trọn vẹn (ok); một phần thì { ok: false, partial, restored, errors, error }
   * và mục vẫn còn nút Hoàn tác để thử lại.
   */
  async historyUndo(payload) {
    const id = String(payload && payload.id || '');
    const force = !!(payload && payload.force);
    const projectRoot = Editor.Project.path;
    const entry = (await history.readHistory(projectRoot)).find((item) => item.id === id);
    if (!entry) {
      return { ok: false, error: 'Không tìm thấy mục lịch sử này.' };
    }
    if (entry.undone) {
      return { ok: false, error: 'Mục này đã được hoàn tác rồi.' };
    }
    try {
      const result = await undoEntry(projectRoot, entry, force);
      if (result.ok) {
        await history.markUndone(projectRoot, id);
        log(`hoàn tác: ${entry.title}`);
      }
      return result;
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  },

  /**
   * Trạng thái nén của một asset ảnh nguồn (cho khung "Tối ưu nguồn" ở detail pane). Áp cho một asset thì
   * panel gọi 'texture-apply-assets' với { refs: [url] } rồi gọi lại message này để lấy trạng thái mới.
   */
  async textureAssetState(payload) {
    const url = String(payload && payload.url || '').trim();
    if (!url) {
      return { ok: false, error: 'Thiếu url asset.' };
    }
    const state = await textureCompress.readAssetCompressState(Editor.Project.path, url);
    return state ? { ok: true, state } : { ok: false, error: `Không đọc được meta của ${url}` };
  },

  // ---------------------------------------------------------------- audio (nguồn)

  /**
   * Cài dependency cho phần audio (ffmpeg-static) ngay trong Editor. Người dùng phải
   * bấm nút trong panel mới chạy - đây là lệnh tải gói từ npm.
   */
  async audioInstallTools() {
    log('đang chạy npm install để cài ffmpeg-static...');
    const result = await installDependencies();
    const toolchain = describeToolchain();
    log(result.ok && toolchain.ffmpeg ? `cài xong, ffmpeg: ${toolchain.ffmpeg}` : `cài thất bại (mã ${result.code})`);
    return { ok: result.ok && !!toolchain.ffmpeg, needsNode: !!result.needsNode, output: result.output, toolchain };
  },

  /**
   * Liệt kê audio nguồn trong assets/ kèm thông tin probe. payload.buildRoot: bản build đang xem, để lấy
   * cấu hình audio của đúng build task (trống thì lấy task mới nhất).
   */
  async audioScan(payload) {
    try {
      const files = await audio.scanSourceAudio(Editor.Project.path);
      const builderAudio = await readBuilderAudio(Editor.Project.path, payload && payload.buildRoot);
      return { ok: true, files, toolchain: describeToolchain(), builderAudio };
    } catch (error) {
      return { ok: false, error: error.message || String(error), toolchain: describeToolchain() };
    }
  },

  /** Chuyển / nén lại các file đã chọn sang MP3, thay thế file gốc, rồi refresh thư mục liên quan. */
  async audioConvert(payload) {
    const options = payload || {};
    try {
      // Thư mục dự phòng đặt ở đây để ghi vào lịch sử (hoàn tác chép ngược từ đó).
      const backupDir = path.join(Editor.Project.path, 'temp', PACKAGE_NAME, 'audio-backup', audio.timestamp());
      const refs = Array.isArray(options.refs) ? options.refs : [];
      // uuid trước khi thay: sau khi xong phải còn nguyên, lệch là scene / prefab mất tham chiếu.
      const uuidsBefore = new Map();
      const assetsDir = path.join(Editor.Project.path, 'assets');
      for (const ref of refs) {
        const requested = toFsPath(Editor.Project.path, ref);
        const fsPath = requested ? await audio.canonicalPath(assetsDir, requested) : '';
        const url = fsPath ? fsPathToUrl(Editor.Project.path, fsPath) : '';
        const uuid = url ? await resolveUuidFromUrl(url) : '';
        if (fsPath && uuid) {
          uuidsBefore.set(path.relative(assetsDir, fsPath).replace(/\\/g, '/'), uuid);
        }
      }
      const results = await audio.convertSourceAudio(Editor.Project.path, {
        refs,
        bitrateKbps: options.bitrateKbps,
        mono: !!options.mono,
        sampleRate: Number(options.sampleRate) || 0,
        overwriteExisting: !!options.overwriteExisting,
        trim: options.trim || null,
        backupDir,
        // Đổi đuôi (wav -> mp3) đi qua asset-db như đổi tên trong panel Assets: giữ uuid.
        renameAsset: async (fromPath, toPath) => {
          const from = fsPathToUrl(Editor.Project.path, fromPath);
          const to = fsPathToUrl(Editor.Project.path, toPath);
          if (!from || !to) {
            return false;
          }
          const info = await Editor.Message.request('asset-db', 'move-asset', from, to);
          return !!info;
        },
        deleteAsset: async (filePath) => {
          const url = fsPathToUrl(Editor.Project.path, filePath);
          if (!url) {
            return false;
          }
          await Editor.Message.request('asset-db', 'delete-asset', url);
          return true;
        },
      });
      await refreshAudioFolders(results);
      await checkAudioUuids(results, uuidsBefore);
      const converted = results.filter((item) => item.ok && !item.skipped).length;
      log(`audio: ${converted}/${results.length} file đã chuyển sang MP3`);
      const entry = await recordAudioHistory(results, backupDir, options.trim).catch((error) => {
        console.warn(`[${PACKAGE_NAME}] không ghi được lịch sử:`, error);
        return null;
      });
      return { ok: true, results, historyId: entry ? entry.id : '' };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  },

  /** Thông tin file audio nguồn (cho khung "Tối ưu nguồn" ở detail pane). */
  async audioAssetState(payload) {
    const url = String(payload && payload.url || '').trim();
    const fsPath = toFsPath(Editor.Project.path, url);
    if (!fsPath) {
      return { ok: false, error: 'Thiếu url asset.' };
    }
    try {
      const probe = await audio.probeAudio(fsPath);
      return { ok: true, state: { url, fullPath: fsPath, probe } };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  },

  /**
   * Encode thử một audio nguồn (cắt + bitrate / mono / Hz) vào temp/ để nghe và xem dung lượng
   * trước khi áp. Không đụng tới assets/.
   */
  async audioPreviewEncode(payload) {
    const options = payload || {};
    const url = String(options.url || '').trim();
    if (!url) {
      return { ok: false, error: 'Thiếu url asset.' };
    }
    try {
      const result = await audio.previewEncode(Editor.Project.path, url, {
        bitrateKbps: options.bitrateKbps,
        mono: !!options.mono,
        sampleRate: Number(options.sampleRate) || 0,
        trim: options.trim || null,
      });
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  },

  /** Bản WAV tạm để panel nghe / vẽ waveform các định dạng nó không tự giải mã được (wma...). */
  async audioPreviewWav(payload) {
    const url = String(payload && payload.url || '').trim();
    if (!url) {
      return { ok: false, error: 'Thiếu url asset.' };
    }
    try {
      return { ok: true, path: await audio.previewWav(Editor.Project.path, url) };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  },

  /** Nén lại đúng một audio nguồn (từ detail pane), có thể kèm cắt đoạn { start, end, fadeIn, fadeOut }. */
  async audioConvertAsset(payload) {
    const url = String(payload && payload.url || '').trim();
    if (!url) {
      return { ok: false, error: 'Thiếu url asset.' };
    }
    const result = await exports.methods.audioConvert({
      refs: [url],
      bitrateKbps: payload.bitrateKbps,
      mono: payload.mono,
      sampleRate: payload.sampleRate,
      overwriteExisting: !!payload.overwriteExisting,
      trim: payload.trim || null,
    });
    if (!result.ok) {
      return result;
    }
    const item = result.results[0] || null;
    if (!item || !item.ok) {
      return { ok: false, error: (item && item.error) || 'Chuyển đổi thất bại.' };
    }
    const targetUrl = fsPathToUrl(Editor.Project.path, path.join(Editor.Project.path, 'assets', item.targetRelativePath));
    let probe = null;
    try {
      probe = await audio.probeAudio(toFsPath(Editor.Project.path, targetUrl));
    } catch (_error) {
      probe = null;
    }
    return { ok: true, result: item, state: { url: targetUrl, probe }, historyId: result.historyId };
  },
};

/**
 * Sau khi thay audio: uuid ở đường dẫn mới phải trùng uuid cũ. Lệch thì gắn `uuidChanged` vào kết quả để panel báo đỏ
 * (scene / prefab trỏ uuid cũ sẽ báo asset missing) thay vì im lặng.
 */
async function checkAudioUuids(results, uuidsBefore) {
  for (const item of results) {
    const before = uuidsBefore.get(item.relativePath) || item.uuidBefore || '';
    if (!item.ok || item.skipped || !before) {
      continue;
    }
    const url = fsPathToUrl(Editor.Project.path, path.join(Editor.Project.path, 'assets', item.targetRelativePath));
    let after = url ? await resolveUuidFromUrl(url) : '';
    // asset-db có thể cần một nhịp để import xong file vừa đổi.
    for (let attempt = 0; attempt < 10 && after !== before; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      after = url ? await resolveUuidFromUrl(url) : '';
    }
    if (after !== before) {
      item.uuidChanged = { before, after: after || '' };
      console.error(`[${PACKAGE_NAME}] ${item.targetRelativePath}: uuid đổi ${before} -> ${after || '(không thấy)'}; scene / prefab trỏ uuid cũ sẽ báo missing. Hoàn tác trong Lịch sử hoặc trả uuid cũ vào .meta (tắt editor trước).`);
    }
  }
}

/** Refresh từng thư mục có file thay đổi (thay vì cả db://assets). */
async function refreshAudioFolders(results) {
  const folders = new Set();
  for (const item of results) {
    if (!item.ok || item.skipped) {
      continue;
    }
    const folderPath = path.dirname(path.join(Editor.Project.path, 'assets', item.targetRelativePath));
    const url = fsPathToUrl(Editor.Project.path, folderPath);
    if (url) {
      folders.add(url);
    }
  }
  for (const url of folders) {
    await Editor.Message.request('asset-db', 'refresh-asset', url).catch((error) => {
      console.warn(`[${PACKAGE_NAME}] refresh-asset ${url} thất bại:`, error);
    });
  }
}

// ---------------------------------------------------------------- helpers

/**
 * Ghi meta ảnh qua asset-db để editor tự re-import. Cả lượt chọn một đường ngay từ đầu: chỉ khi asset-db
 * không có message query-asset-meta / save-asset-meta mới ghi thẳng file .meta + refresh. Lỗi riêng của
 * một asset (vd vừa bị xoá / đổi tên) chỉ đánh dấu dòng đó là lỗi (applyPlan), các dòng sau vẫn qua asset-db.
 */
async function applyTexturePlanInEditor(plan) {
  const viaAssetDb = assetDbHasMessage('query-asset-meta') && assetDbHasMessage('save-asset-meta');
  if (!viaAssetDb) {
    log('asset-db không có save-asset-meta: ghi thẳng file .meta rồi refresh');
  }
  const { updated, failed } = await textureCompress.applyPlan(plan, async (row, activePlan) => {
    if (viaAssetDb) {
      await writeMetaViaAssetDb(row, activePlan);
      return;
    }
    await textureCompress.writeMetaFile(row, activePlan);
    const url = fsPathToUrl(Editor.Project.path, row.assetPath);
    if (url) {
      await Editor.Message.request('asset-db', 'refresh-asset', url).catch(() => null);
    }
  });

  log(`${plan.mode === 'disable' ? 'đã tắt nén' : `đã bật ${plan.preset.name}`} cho ${updated} asset${failed.length ? ` (${failed.length} lỗi)` : ''}`);
  const entry = await recordTextureHistory(plan).catch((error) => {
    console.warn(`[${PACKAGE_NAME}] không ghi được lịch sử:`, error);
    return null;
  });
  return { ok: true, updated, failed, viaAssetDb, historyId: entry ? entry.id : '' };
}

/**
 * asset-db có nhận message `name` không (đọc contributions.messages của package asset-db). Không đọc được
 * thì coi như có: chỉ bỏ asset-db khi chắc chắn thiếu message.
 */
function assetDbHasMessage(name) {
  try {
    const packages = Editor.Package.getPackages({ name: 'asset-db' }) || [];
    const info = packages[0] && packages[0].info;
    const messages = info && info.contributions && info.contributions.messages;
    return !messages || Object.prototype.hasOwnProperty.call(messages, name);
  } catch (_error) {
    return true;
  }
}

// ---------------------------------------------------------------- lịch sử

function listNames(names, limit = 3) {
  const shown = names.slice(0, limit).join(', ');
  return names.length > limit ? `${shown} và ${names.length - limit} file khác` : shown;
}

/** Ghi lại compressSettings trước / sau của các ảnh vừa đổi để hoàn tác được. */
async function recordTextureHistory(plan) {
  const done = plan.rows.filter((row) => row.action === 'done');
  if (!done.length) {
    return null;
  }
  const after = plan.mode === 'disable' ? null : { useCompressTexture: true, presetId: plan.preset.id };
  return await history.appendHistory(Editor.Project.path, {
    kind: 'texture',
    title: plan.mode === 'disable' ? `Tắt nén ${done.length} ảnh` : `Bật nén "${plan.preset.name}" cho ${done.length} ảnh`,
    detail: listNames(done.map((row) => path.basename(row.assetPath))),
    items: done.map((row) => ({
      url: fsPathToUrl(Editor.Project.path, row.assetPath),
      uuid: row.uuid,
      before: row.current || null,
      after,
    })),
  });
}

/** Ghi lại các audio vừa thay (kèm thư mục dự phòng) để hoàn tác được. */
async function recordAudioHistory(results, backupDir, trim) {
  const done = results.filter((item) => item.ok && !item.skipped);
  if (!done.length) {
    return null;
  }
  const items = [];
  for (const item of done) {
    const stat = await fsPromises.stat(path.join(Editor.Project.path, 'assets', item.targetRelativePath)).catch(() => null);
    items.push({
      relativePath: item.relativePath,
      targetRelativePath: item.targetRelativePath,
      changedExtension: !!item.changedExtension,
      replacedExistingMp3: !!item.replacedExistingMp3,
      renamedByAssetDb: !!item.renamedByAssetDb,
      uuidChanged: item.uuidChanged || null,
      backupDir: path.relative(Editor.Project.path, backupDir).replace(/\\/g, '/'),
      afterBytes: stat ? stat.size : item.afterBytes,
      afterMtimeMs: stat ? stat.mtimeMs : 0,
    });
  }
  const before = done.reduce((sum, item) => sum + item.beforeBytes, 0);
  const after = done.reduce((sum, item) => sum + item.afterBytes, 0);
  const names = done.map((item) => path.posix.basename(item.relativePath));
  return await history.appendHistory(Editor.Project.path, {
    kind: 'audio',
    title: trim ? `Cắt + nén ${names[0]}` : `Nén ${done.length} audio`,
    detail: `${listNames(names)} · ${formatKb(before)} → ${formatKb(after)}`,
    items,
  });
}

function formatKb(bytes) {
  return `${Math.round((Number(bytes) || 0) / 102.4) / 10} KB`;
}

/** Hoàn tác theo loại mục; loại lạ thì báo lỗi rõ ràng (không coi như ảnh). */
async function undoEntry(projectRoot, entry, force) {
  switch (entry.kind) {
    case 'texture':
      return await undoMetaKeys(entry, ['compressSettings'], force);
    case 'model':
      return await undoMetaKeys(entry, ['meshCompress', 'meshSimplify'], force);
    case 'audio':
      return await undoAudioEntry(projectRoot, entry, force);
    case 'engine-modules':
      return await undoEngineModulesEntry(entry, force);
    default:
      return { ok: false, error: `Không biết cách hoàn tác loại thay đổi "${entry.kind || '(trống)'}".` };
  }
}

/** Tên hiện cho người dùng của các khoá userData tool ghi (trong danh sách xung đột khi hoàn tác). */
const META_KEY_LABELS = {
  compressSettings: 'preset nén',
  meshCompress: 'Mesh Compress',
  meshSimplify: 'Mesh Simplify',
};

/**
 * Hoàn tác mục texture / model: ghi lại đúng các khoá userData `keys` như trước lần đổi, qua asset-db
 * (editor tự import lại). item.before / item.after: texture lưu thẳng giá trị của khoá duy nhất
 * (compressSettings hoặc null), model lưu object theo khoá ({ meshCompress, meshSimplify }).
 * Asset đã bị đổi tiếp ở các khoá đó (hoặc không còn) thì trả needsForce + xung đột; `force` để vẫn ghi.
 * Asset đã ở đúng trạng thái cũ (lần hoàn tác trước xong một phần) thì tính là đã khôi phục, không ghi lại.
 * Chỉ ok khi mọi mục đã về như cũ; thiếu mục nào thì { ok: false, partial, restored, errors, error }.
 */
async function undoMetaKeys(entry, keys, force) {
  const byKey = (value) => (keys.length === 1 ? { [keys[0]]: value || null } : value || {});
  const pick = (userData) => Object.fromEntries(keys.map((key) => [key, (userData && userData[key]) || null]));
  const same = (left, right) => JSON.stringify(left || null) === JSON.stringify(right || null);
  const items = Array.isArray(entry.items) ? entry.items : [];
  const pending = [];
  const conflicts = [];
  const errors = [];
  /** Asset đã bị xoá: không còn gì để trả về; người dùng vẫn chọn hoàn tác thì bỏ qua mục đó. */
  const missing = [];
  let restored = 0;
  for (const item of items) {
    const label = item.url || item.uuid;
    const meta = await Editor.Message.request('asset-db', 'query-asset-meta', item.uuid).catch(() => null);
    if (!meta) {
      conflicts.push(`${label}: không còn asset`);
      missing.push(label);
      continue;
    }
    const current = pick(meta.userData);
    const before = byKey(item.before);
    const after = byKey(item.after);
    if (keys.every((key) => same(current[key], before[key]))) {
      restored += 1;
      continue;
    }
    const changed = keys.filter((key) => !same(current[key], after[key]));
    if (changed.length) {
      conflicts.push(`${label}: đã đổi ${changed.map((key) => META_KEY_LABELS[key] || key).join(' / ')} sau lần này`);
    }
    pending.push({ item, meta, before, label });
  }
  if (conflicts.length && !force) {
    return { ok: false, needsForce: true, conflicts };
  }
  for (const { item, meta, before, label } of pending) {
    try {
      meta.userData = meta.userData || {};
      for (const key of keys) {
        if (before[key]) {
          meta.userData[key] = before[key];
        } else {
          delete meta.userData[key];
        }
      }
      await Editor.Message.request('asset-db', 'save-asset-meta', item.uuid, JSON.stringify(meta));
      restored += 1;
    } catch (error) {
      errors.push(`${label}: ${error.message || error}`);
    }
  }
  if (errors.length) {
    // Chưa trả về trọn vẹn: không đánh dấu đã hoàn tác để còn thử lại (giống audio).
    return { ok: false, partial: restored > 0, restored, errors, error: `Hoàn tác chưa xong (${errors.length} lỗi): ${errors[0]}` };
  }
  // Tới đây chỉ khi đã force (có mục thiếu là có conflict): mục thiếu được bỏ qua, coi như xong.
  return { ok: true, restored, errors, skipped: missing.map((label) => `${label}: không còn asset, bỏ qua`) };
}

/**
 * Cấu hình module engine của dự án, đọc thẳng settings/v2/packages/engine.json. Không dùng
 * Editor.Profile.getProject('engine', 'modules'): nó trộn thêm mặc định của Cocos (khối
 * defaultConfig), ghi ngược lại sẽ chép cả khối đó vào file; đọc file cũng giữ đúng thứ tự khoá
 * nên lần ghi chỉ đổi đúng các dòng cần đổi.
 */
async function readEngineModules() {
  const file = path.join(Editor.Project.path, 'settings', 'v2', 'packages', 'engine.json');
  const json = JSON.parse(await fsPromises.readFile(file, 'utf8').catch(() => '{}'));
  if (json.modules) {
    return json.modules;
  }
  return await Editor.Profile.getProject('engine', 'modules', 'project').catch(() => null);
}

/** Phần quyết định module nào vào build: danh sách module + cờ Post Process của graphics. */
function modulesSignature(modules) {
  const config = engineModules.activeConfig(modules);
  return JSON.stringify([
    config ? config.includeModules.slice().sort() : null,
    modules && modules.graphics ? modules.graphics['custom-pipeline-post-process'] : null,
  ]);
}

/**
 * Ghi cấu hình module qua Editor.Profile (giống hệt Project Settings → Feature Cropping) rồi chờ tới khi
 * file có cấu hình mới: Editor ghi file không đồng bộ với promise (tối đa ~2 giây). `isApplied(modules)`
 * kiểm file đọc lại (mặc định: modulesSignature trùng `next`). Trả về cấu hình đọc lại, hoặc null khi
 * Editor không nhận (Project Settings đang mở và ghi đè?).
 */
async function writeEngineModules(next, isApplied = (modules) => modulesSignature(modules) === modulesSignature(next)) {
  await Editor.Profile.setProject('engine', 'modules', next);
  let after = await readEngineModules();
  for (let attempt = 0; attempt < 20 && !isApplied(after); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    after = await readEngineModules();
  }
  return isApplied(after) ? after : null;
}

/**
 * Trả cấu hình module về như trước lần đổi, chỉ ok khi file đã đúng cấu hình cũ. Hỏi lại (needsForce) khi
 * Feature Cropping đã bị đổi tiếp, hoặc khi hoàn tác sẽ tắt meshopt trong lúc còn model bật Encode
 * (build lỗi 16352; kèm `warning` để panel hiện đúng lời cảnh báo).
 */
async function undoEngineModulesEntry(entry, force) {
  if (!entry.before) {
    return { ok: false, error: 'Mục này không lưu cấu hình module cũ nên không hoàn tác được.' };
  }
  const current = await readEngineModules();
  const conflicts = [];
  if (modulesSignature(current) !== modulesSignature(entry.after)) {
    conflicts.push('Feature Cropping đã được đổi tiếp sau lần này: khôi phục sẽ ghi đè cả các thay đổi đó.');
  }
  let warning = '';
  if (modelCompress.meshoptState(current).enabled && !modelCompress.meshoptState(entry.before).enabled) {
    const models = await modelCompress.scanModels(Editor.Project.path).catch(() => []);
    const encoded = models.filter((model) => model.compress && model.compress.encode).length;
    if (encoded) {
      warning = `${encoded} model đang bật Encode: hoàn tác sẽ tắt meshopt, build lỗi 16352 và các model đó không hiện.`;
      conflicts.push(warning);
    }
  }
  if (conflicts.length && !force) {
    return { ok: false, needsForce: true, conflicts, ...(warning ? { warning } : {}) };
  }
  if (!await writeEngineModules(entry.before)) {
    return { ok: false, error: 'Editor không nhận cấu hình module cũ (Project Settings đang mở và ghi đè?). Đóng Project Settings rồi thử lại.' };
  }
  return { ok: true, restored: 1, errors: [] };
}

/**
 * Bật / tắt meshopt trong Feature Cropping (đúng hai chỗ Cocos ghi: cache + includeModules), có mục lịch sử
 * kiểu engine-modules để hoàn tác như module khác. Đã đúng trạng thái thì không làm gì.
 */
async function setMeshopt(enabled) {
  const caps = readCaps(Editor.Project.path);
  if (!caps.meshopt) {
    return { ok: false, error: `Cocos ${caps.version} không có module meshopt (có từ 3.8).` };
  }
  const before = await readEngineModules();
  const state = modelCompress.meshoptState(before);
  if (state.known && state.enabled === enabled) {
    return { ok: true, changed: false, enabled };
  }
  const next = enabled ? modelCompress.enableMeshopt(before) : modelCompress.disableMeshopt(before);
  if (!next || !state.known) {
    return { ok: false, error: `Dự án chưa lưu cấu hình Feature Cropping nên chưa ${enabled ? 'bật' : 'tắt'} được meshopt. Mở Project Settings → Feature Cropping, đổi một mục bất kỳ rồi đổi lại, sau đó thử lại.` };
  }
  const after = await writeEngineModules(next, (modules) => modelCompress.meshoptState(modules).enabled === enabled);
  if (!after) {
    return { ok: false, error: 'Editor không nhận cấu hình meshopt (Project Settings đang mở và ghi đè?). Đóng Project Settings rồi thử lại.' };
  }
  const entry = await history.appendHistory(Editor.Project.path, {
    kind: 'engine-modules',
    title: enabled ? 'Bật meshopt' : 'Tắt meshopt',
    detail: 'Giải mã mesh đã Encode (module ẩn trong Feature Cropping)',
    before,
    after,
  }).catch(() => null);
  log(`đã ${enabled ? 'bật' : 'tắt'} module meshopt`);
  return { ok: true, changed: true, enabled, historyId: entry ? entry.id : '' };
}

/** Chép bản dự phòng về assets/ rồi refresh đúng các thư mục liên quan. */
async function undoAudioEntry(projectRoot, entry, force) {
  const conflicts = await history.findAudioConflicts(projectRoot, entry);
  const missingBackup = conflicts.filter((text) => text.includes('mất bản dự phòng'));
  if (missingBackup.length) {
    return { ok: false, error: `Không hoàn tác được: ${missingBackup.join('; ')}` };
  }
  if (conflicts.length && !force) {
    return { ok: false, needsForce: true, conflicts };
  }
  const result = await history.undoAudio(projectRoot, entry, {
    // Đổi đuôi (mp3 -> wav khi hoàn tác) đi qua asset-db như đổi tên trong panel Assets: giữ uuid.
    renameAsset: async (fromPath, toPath) => {
      const from = fsPathToUrl(projectRoot, fromPath);
      const to = fsPathToUrl(projectRoot, toPath);
      if (!from || !to) {
        return false;
      }
      return !!await Editor.Message.request('asset-db', 'move-asset', from, to);
    },
  });
  for (const folder of result.folders) {
    const url = fsPathToUrl(projectRoot, folder);
    if (url) {
      await Editor.Message.request('asset-db', 'refresh-asset', url).catch((error) => {
        console.warn(`[${PACKAGE_NAME}] refresh-asset ${url} thất bại:`, error);
      });
    }
  }
  // Mỗi file đã trả về phải mang đúng uuid của bản dự phòng; lệch là scene / prefab sẽ báo missing.
  const errors = [...result.errors];
  for (const check of result.checks) {
    const url = fsPathToUrl(projectRoot, check.path);
    let uuid = url ? await resolveUuidFromUrl(url) : '';
    for (let attempt = 0; attempt < 10 && uuid !== check.uuid; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      uuid = url ? await resolveUuidFromUrl(url) : '';
    }
    if (uuid !== check.uuid) {
      errors.push(`${path.basename(check.path)}: uuid sau khi hoàn tác là ${uuid || '(không thấy)'}, đúng ra ${check.uuid} — tắt editor rồi trả uuid này vào .meta`);
    }
  }
  if (errors.length) {
    // Chưa trả về trọn vẹn: không đánh dấu đã hoàn tác để còn thử lại (và bản dự phòng không bị dọn).
    return { ok: false, partial: result.restored > 0, restored: result.restored, errors, error: `Hoàn tác chưa xong (${errors.length} lỗi): ${errors[0]}` };
  }
  return { ok: true, restored: result.restored, errors };
}

async function writeMetaViaAssetDb(row, plan) {
  const meta = await Editor.Message.request('asset-db', 'query-asset-meta', row.uuid);
  if (!meta) {
    throw new Error('query-asset-meta không trả về gì');
  }
  meta.userData = textureCompress.patchUserData(meta.userData, plan);
  await Editor.Message.request('asset-db', 'save-asset-meta', row.uuid, JSON.stringify(meta));
}

async function resolveUuidFromUrl(url) {
  if (!url) {
    return '';
  }

  try {
    const info = await Editor.Message.request('asset-db', 'query-asset-info', url);
    if (info && info.uuid) {
      return info.uuid;
    }
  } catch (_error) {
    // Một số version nhận payload dạng object.
  }

  try {
    const info = await Editor.Message.request('asset-db', 'query-asset-info', { url });
    if (info && info.uuid) {
      return info.uuid;
    }
  } catch (_error) {
    // Bỏ qua, trả về rỗng.
  }

  return '';
}

exports.load = function load() {
  log('loaded');
  // Lần đầu extension chạy trong một dự án (vừa chép sang): tự mở panel để nó phân tích ngay và
  // chỉ ra thiết lập còn thiếu, không cần ai nhớ mở hay chạy lệnh. Chỉ một lần cho mỗi dự án.
  const marker = path.join(Editor.Project.path, 'temp', PACKAGE_NAME, 'first-run.json');
  const fs = require('fs');
  if (fs.existsSync(marker)) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ openedAt: new Date().toISOString() }));
  } catch (error) {
    log('không ghi được first-run.json, bỏ qua tự mở panel:', error.message);
    return;
  }
  setTimeout(() => {
    Promise.resolve()
      .then(() => Editor.Panel.open(PACKAGE_NAME))
      .catch((error) => log('không tự mở được panel:', error.message));
  }, 4000);
};

exports.unload = function unload() {};
