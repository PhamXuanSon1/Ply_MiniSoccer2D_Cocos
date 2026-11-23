'use strict';

/**
 * Bước Tối ưu → Model 3D: model nguồn (fbx / gltf / glb), số tam giác, chiếm bao nhiêu trong bản build
 * (cả sau khi zip, vì dữ liệu mesh float gần như không nén được), và form giống Inspector → Model ở khung
 * Chi tiết: Mesh Compress (Quantize / Encode / Compress) · Mesh Simplify (Target Ratio / Auto Error Rate /
 * Error Rate / Lock Boundary). Form là DOM sống (#mdl-settings), renderDetail gắn nó vào khung Chi tiết.
 * Form áp cho các model đang tick (không tick thì cho model đang chọn); ô nào các model đang khác nhau thì hiện
 * gạch ngang (checkbox mờ, ô số "—") và chỉ đổi khi người dùng sửa ô đó. Apply → main.js ghi .meta qua asset-db (editor tự import lại),
 * hoàn tác được trong Lịch sử; Encode cần module meshopt nên tool tự bật (ô Meshopt Module bật / tắt tay).
 * Khung Chi tiết có xem trước 3D trước / sau Mesh Simplify (lib/mesh-preview.js + mesh-viewer.js), chạy đúng
 * meshoptimizer của editor trên dữ liệu gốc của model, cập nhật ngay khi kéo Target Ratio.
 * Ngôn ngữ: chỉ tên ô của Inspector (Mesh Compress, Quantize, Target Ratio..., Apply / Revert, Import Settings,
 * Original / Wireframe / Texture) và tên preset (Recommended / Compress only / Quantize only) giữ tiếng Anh;
 * chip, nhãn, ghi chú, trạng thái đều tiếng Việt như các tab khác.
 * Hằng số và luật "trong build / nên xử lý" lấy từ lib/model-compress.js (dùng chung với Việc nên làm, selftest).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { formatBytes } = require('../../lib/build-scan');
const {
  HEAVY_TRIANGLES,
  RECOMMENDED_COMPRESS,
  SIMPLIFY_DEFAULTS,
  modelBuildFiles,
  modelTodos,
  isMeshCompressed,
  simplifies,
} = require('../../lib/model-compress');
const meshPreview = require('../../lib/mesh-preview');
const { workDir } = require('../../lib/compat');
const { createMeshViewer } = require('./mesh-viewer');

const PACKAGE_NAME = 'playable-size-inspector';

/** Số đếm (tam giác...) theo kiểu Việt, giống "Việc nên làm": 48.625. */
const formatCount = (value) => Number(value || 0).toLocaleString('vi-VN');
const HEAVY_TEXT = formatCount(HEAVY_TRIANGLES);

/** Chữ cho khoá việc nên làm của modelTodos (lib/model-compress). */
const TODO_LABELS = {
  'import-failed': 'Cocos import lỗi',
  uncompressed: 'chưa nén mesh',
  heavy: `từ ${HEAVY_TEXT} tam giác mà Mesh Simplify chưa giảm`,
};
const todoText = (todos) => todos.map((key) => TODO_LABELS[key] || key).join(' · ');

/** Ô số đang khác nhau giữa các model: để trống, gạch ngang như checkbox mixed. */
const MIXED_PLACEHOLDER = '—';
const MIXED_TITLE = 'Các model đang khác nhau ở ô này: không sửa thì mỗi model giữ giá trị riêng';

const SELECTORS = {
  panelModel: '#panel-model',
  mdlSettings: '#mdl-settings',
  mdlList: '#mdl-list',
  mdlSummary: '#mdl-summary',
  mdlIssues: '#mdl-issues',
  mdlFilters: '#mdl-filters',
  mdlSelectAll: '#mdl-select-all',
  mdlSelectNone: '#mdl-select-none',
  mdlPresets: '#mdl-presets',
  mdlBulkApply: '#mdl-bulk-apply',
  mdlBulkHint: '#mdl-bulk-hint',
  mdlApply: '#mdl-apply',
  mdlRevert: '#mdl-revert',
  mdlTarget: '#mdl-target',
  mdlCEnable: '#mdl-c-enable',
  mdlCQuantize: '#mdl-c-quantize',
  mdlCEncode: '#mdl-c-encode',
  mdlCCompress: '#mdl-c-compress',
  mdlMeshopt: '#mdl-meshopt',
  mdlMeshoptNote: '#mdl-meshopt-note',
  mdlSEnable: '#mdl-s-enable',
  mdlSRatio: '#mdl-s-ratio',
  mdlSRatioNum: '#mdl-s-ratio-num',
  mdlSAuto: '#mdl-s-auto',
  mdlSError: '#mdl-s-error',
  mdlSLock: '#mdl-s-lock',
  mdlCFields: '#mdl-c-fields',
  mdlSFields: '#mdl-s-fields',
  mdlFormNote: '#mdl-form-note',
  mdlHelp: '#mdl-help',
  mdlHelpToggle: '#mdl-help-toggle',
};

const fieldKey = (section, key) => `${section}.${key}`;

/** Giá trị đang lưu của một ô (thô, như Inspector hiện). */
function storedValue(model, section, key) {
  if (section === 'meshCompress') {
    return !!(model.compress.raw || model.compress)[key];
  }
  const value = model.simplify[key];
  return value === undefined ? SIMPLIFY_DEFAULTS[key] : value;
}

/**
 * Con số chính của tab Model 3D là dung lượng mesh SAU ZIP (gần với byte trong file gửi mạng nhất: mesh chưa nén
 * thì zip gần như không giảm, mesh Encode thì giảm nhiều), luôn ghi "≈ X sau zip"; số trong build (chưa zip, cùng
 * đơn vị với tab Ảnh / Tổng quan) để ở tooltip và mục Số liệu.
 */
const ZIP_TITLE = 'Ước tính dung lượng trong file zip / HTML gửi mạng: nén deflate từng file của model trong bản build web-mobile';
const zipTitle = (info) => `${ZIP_TITLE}.\nTrong build (chưa zip): ${formatBytes(info.raw)} · sau zip ≈ ${formatBytes(info.zipped)}`;

/** Dung lượng sau zip của một file build (cache theo đường dẫn + kích thước). */
const zipCache = new Map();
function zippedSize(fullPath, size) {
  const key = `${fullPath}|${size}`;
  if (!zipCache.has(key)) {
    try {
      zipCache.set(key, zlib.deflateRawSync(fs.readFileSync(fullPath), { level: 9 }).length);
    } catch (_error) {
      zipCache.set(key, size);
    }
  }
  return zipCache.get(key);
}

function buildInfo(panel, model) {
  const rows = modelBuildFiles(model, panel.state.assetRows);
  const raw = rows.reduce((sum, row) => sum + row.size, 0);
  const zipped = rows.reduce((sum, row) => sum + zippedSize(row.fullPath, row.size), 0);
  const includedBy = Array.from(new Set(rows.flatMap((row) => row.includedBy || [])));
  return { rows, raw, zipped, includedBy, inBuild: rows.length > 0 };
}

function badgesOf(model) {
  const badges = [];
  const c = model.compress;
  if (c.quantize || c.encode || c.compress) {
    const parts = [c.quantize ? 'Quantize' : '', c.encode ? 'Encode' : '', c.compress ? 'Compress' : ''].filter(Boolean);
    badges.push({ text: parts.join(' + '), className: c.compress ? 'warn' : 'ok', title: c.compress ? 'Compress (zlib) thừa với playable vì bản xuất đã zip toàn bộ' : 'Mesh Compress đang bật' });
  } else if (model.canCompress !== false) {
    badges.push({ text: 'Chưa nén', className: 'warn', title: 'Mesh Compress đang tắt: mesh lưu số thực 32-bit, zip gần như không nén được' });
  }
  if (model.simplify.enable) {
    const percent = Math.round(model.simplify.targetRatio * 100);
    badges.push({ text: `Giảm còn ${percent}%`, className: 'info', title: `Mesh Simplify đang bật: giữ lại ${percent}% tam giác (Target Ratio ${model.simplify.targetRatio})` });
  }
  if (model.vertexColors) {
    badges.push({ text: 'Màu đỉnh', className: model.compress.quantize ? 'warn' : 'info', title: VERTEX_COLOR_TITLE });
  }
  if (model.importFailed && model.importFailed.length) {
    badges.unshift({ text: 'Import lỗi', className: 'warn', title: 'Cocos import mesh của model này bị lỗi (xem Console): mesh không có trong build. Thường do Quantize / Mesh Simplify, tắt bớt rồi Apply lại, hoặc hoàn tác trong Lịch sử.' });
  }
  return badges;
}

const VERTEX_COLOR_TITLE = 'Model có màu đỉnh (vertex color). Quantize của Cocos 3.8 lỗi với loại mesh này (import sập "Aborted(native code called abort())"), nên tool tự bỏ Quantize cho nó khi Apply; Encode và Mesh Simplify vẫn dùng được.';

/** Chip lọc danh sách (như tab Ảnh / Âm thanh). Trong build đứng đầu và là mặc định. */
const MODEL_FILTERS = [
  { id: 'build', label: 'Trong build', title: 'Model có trong bản build hiện tại', test: (model, info) => info.inBuild },
  { id: 'todo', label: 'Nên xử lý', title: `Trong build mà chưa nén mesh, hoặc từ ${HEAVY_TEXT} tam giác mà chưa giảm (đúng các model Tổng quan → Việc nên làm nhắc tới)`, todo: true, test: (model, info) => modelTodos(model, info.inBuild).length > 0 },
  { id: 'uncompressed', label: 'Chưa nén', title: 'Trong build, Mesh Compress chưa bật Quantize (model có màu đỉnh: chưa bật Encode)', test: (model, info) => modelTodos(model, info.inBuild).includes('uncompressed') },
  { id: 'heavy', label: `≥ ${HEAVY_TEXT} tam giác`, title: 'Trong build, nhiều tam giác', test: (model, info) => info.inBuild && model.triangles >= HEAVY_TRIANGLES },
  { id: 'all', label: 'Tất cả', title: 'Mọi model trong assets/', test: () => true },
];

/**
 * Preset áp hàng loạt cho model đang tick (như preset nén của tab Âm thanh). Chọn thẻ là điền sẵn form ở khung Chi tiết
 * (xem trước thấy ngay), Apply là ghi. Sửa tay form thì thành thẻ "Tùy chỉnh".
 */
const MODEL_PRESETS = [
  { id: 'recommended', label: 'Recommended', note: 'Quantize + Encode, giảm tam giác model nặng', title: `Mesh Compress: Quantize + Encode, tắt Compress. Mesh Simplify: model từ ${HEAVY_TEXT} tam giác giữ 0.7 / 0.5 / 0.3 theo số tam giác, model nhẹ giữ nguyên. Encode cần meshopt (tự bật).`, compress: RECOMMENDED_COMPRESS, simplifyByTris: true },
  { id: 'compress', label: 'Compress only', note: 'Quantize + Encode, giữ số tam giác', title: 'Mesh Compress: Quantize + Encode, tắt Compress. Không đụng Mesh Simplify.', compress: RECOMMENDED_COMPRESS },
  { id: 'quantize', label: 'Quantize only', note: 'không cần meshopt, mesh nhỏ ~½', title: 'Mesh Compress: chỉ Quantize (GPU đọc thẳng, không cần module meshopt). Không đụng Mesh Simplify.', compress: { enable: true, quantize: true, encode: false, compress: false } },
];

/** Tên ô (như Inspector) và giá trị cho hộp xác nhận Apply. */
const FIELD_LABELS = {
  quantize: 'Quantize',
  encode: 'Encode',
  compress: 'Compress',
  targetRatio: 'Target Ratio',
  autoErrorRate: 'Auto Error Rate',
  errorRate: 'Error Rate',
  lockBoundary: 'Lock Boundary',
};
const describeValue = (value) => (typeof value === 'boolean' ? (value ? 'bật' : 'tắt') : String(value));
function describeSection(section, values) {
  const name = section === 'meshCompress' ? 'Mesh Compress' : 'Mesh Simplify';
  const parts = Object.entries(values)
    .filter(([key]) => key !== 'enable')
    .map(([key, value]) => `${FIELD_LABELS[key] || key} ${describeValue(value)}`);
  const head = 'enable' in values ? `${name} ${describeValue(values.enable)}` : name;
  return parts.length ? `${head}: ${parts.join(', ')}` : head;
}

function setup(panel, helpers) {
  const $ = panel.$;
  const { escapeHtml, setStatus, onAction } = helpers;
  const state = {
    scanned: false,
    ok: true,
    /** Lý do model-scan lỗi (hiện ở dải cảnh báo qua showIssues, không bị render() xoá). */
    error: '',
    models: [],
    meshopt: { known: false, enabled: false },
    /** Tính năng của bản Creator (lib/compat.js): meshCompress = false (Cocos 3.6 / 3.7) thì không có form Import Settings. */
    caps: null,
    /** uuid đang tick. */
    selection: new Set(),
    selectedUuid: '',
    /** id trong MODEL_FILTERS; mặc định Trong build. */
    filter: 'build',
    /** Thẻ preset đang chọn (id trong MODEL_PRESETS) hoặc 'custom' (thẻ Tùy chỉnh) khi đã sửa tay form. */
    preset: '',
    busy: false,
    /** Ô người dùng đã sửa trong form: key -> giá trị. Ô chưa sửa giữ giá trị riêng của từng model. */
    edits: new Map(),
    /** Recommended: Target Ratio riêng theo số tam giác (cho model nhiều tam giác), tới khi sửa tay Mesh Simplify. */
    recommendedRatios: false,
    /** Model tool tự tick khi sửa form lúc chưa tick gì (để thay đổi chưa ghi không đi theo dòng đang xem). */
    autoTicked: '',
    /** Đang ghi ô Meshopt Module. */
    meshoptBusy: false,
  };
  panel.state.model = state;

  const infoCache = new Map();
  const infoOf = (model) => {
    const key = `${model.uuid}|${(panel.state.assetRows || []).length}|${panel.state.totalBuildBytes}`;
    if (!infoCache.has(key)) {
      infoCache.set(key, buildInfo(panel, model));
    }
    return infoCache.get(key);
  };
  state.infoOf = infoOf;
  state.todoModels = () => state.models.filter((model) => modelTodos(model, infoOf(model).inBuild).length);

  /** Model form đang áp: các model tick, không tick thì model đang chọn. */
  const targets = () => {
    const ticked = state.models.filter((model) => state.selection.has(model.uuid));
    if (ticked.length) return ticked;
    const focused = state.models.find((model) => model.uuid === state.selectedUuid);
    return focused ? [focused] : [];
  };
  const isTarget = (model) => (state.selection.size ? state.selection.has(model.uuid) : model.uuid === state.selectedUuid);
  /** Bản Creator này đổi được Mesh Compress / Mesh Simplify không (scan chưa xong thì coi như được). */
  const canEdit = () => !state.caps || state.caps.meshCompress !== false;
  state.canEdit = canEdit;

  /** Giá trị form của một ô cho tập model: { value, mixed }. */
  const formValue = (section, key, models = targets()) => {
    const id = fieldKey(section, key);
    if (state.edits.has(id)) return { value: state.edits.get(id), mixed: false };
    if (!models.length) return { value: section === 'meshSimplify' ? SIMPLIFY_DEFAULTS[key] : false, mixed: false };
    const values = models.map((model) => storedValue(model, section, key));
    const mixed = values.some((value) => value !== values[0]);
    return { value: values[0], mixed };
  };

  /** Mesh Simplify sẽ có hiệu lực cho MỘT model nếu bấm Apply (dùng cho preview). */
  const effectiveFor = (model) => {
    const target = isTarget(model);
    const simplify = {};
    for (const key of ['enable', 'targetRatio', 'autoErrorRate', 'errorRate', 'lockBoundary']) {
      const id = fieldKey('meshSimplify', key);
      simplify[key] = target && state.edits.has(id) ? state.edits.get(id) : storedValue(model, 'meshSimplify', key);
    }
    if (state.recommendedRatios && target && !state.edits.has(fieldKey('meshSimplify', 'targetRatio')) && model.triangles >= HEAVY_TRIANGLES) {
      simplify.enable = true;
      simplify.targetRatio = model.suggestRatio;
    }
    return simplify;
  };

  const filterDef = () => MODEL_FILTERS.find((filter) => filter.id === state.filter) || MODEL_FILTERS[0];

  const renderFilters = () => {
    $.mdlFilters.innerHTML = MODEL_FILTERS.map((filter) => {
      const total = state.models.filter((model) => filter.test(model, infoOf(model))).length;
      if (!total && filter.id !== 'build' && filter.id !== 'all' && state.filter !== filter.id) return '';
      return `<button class="filter-chip ${filter.todo ? 'chip-todo' : ''} ${state.filter === filter.id ? 'active' : ''}" data-filter="${filter.id}" title="${escapeHtml(filter.title)}">${escapeHtml(filter.label)} <span>${total}</span></button>`;
    }).join('');
    for (const chip of $.mdlFilters.querySelectorAll('.filter-chip')) {
      chip.addEventListener('click', () => {
        state.filter = chip.dataset.filter;
        render();
        panel.renderDetail();
      });
    }
  };

  const visibleModels = () => {
    const list = state.models.filter((model) => {
      const info = infoOf(model);
      // Model đang tick luôn hiện (form đang áp cho nó), kể cả khi Apply xong nó không còn "Nên xử lý".
      if (state.selection.has(model.uuid)) return true;
      return filterDef().test(model, info);
    });
    return list.sort((left, right) => (infoOf(right).zipped - infoOf(left).zipped) || (right.triangles - left.triangles));
  };

  const showIssues = () => {
    const issues = [];
    if (!state.ok && state.error) {
      issues.push({ level: 'error', message: `Không đọc được model: ${state.error}` });
    }
    if (state.caps && state.caps.meshCompress === false) {
      issues.push({ level: 'info', message: `Cocos ${state.caps.version || 'bản này'} chưa có Mesh Compress / Mesh Simplify trong Import Settings của model (có từ 3.8): tab này chỉ liệt kê model, số tam giác và dung lượng trong build. Giảm tam giác thì làm trong phần mềm 3D rồi import lại.` });
    }
    const failed = state.models.filter((model) => model.importFailed && model.importFailed.length);
    if (failed.length) {
      issues.push({
        level: 'error',
        message: `${failed.length} model Cocos import lỗi: ${failed.slice(0, 5).map((model) => model.name).join(', ')}${failed.length > 5 ? '...' : ''}. Mesh lỗi không có trong build. Tick model đó, tắt Quantize${failed.some((model) => model.vertexColors) ? ' (model có màu đỉnh)' : ' hoặc Mesh Simplify'} rồi Apply lại, hoặc hoàn tác trong Lịch sử.`,
      });
    }
    const encoded = state.models.filter((model) => model.compress.encode);
    if (state.meshopt.known && !state.meshopt.enabled && encoded.length) {
      issues.push({
        level: 'error',
        message: `${encoded.length} model bật Encode nhưng module meshopt đang tắt: build sẽ lỗi 16352 (decodeVertexBuffer is not a function) và các model đó không hiện.`,
        action: 'enable-meshopt',
      });
    }
    $.mdlIssues.classList.toggle('hidden', !issues.length);
    $.mdlIssues.innerHTML = issues.map((issue) => `<div class="issue ${issue.level}">${escapeHtml(issue.message)}${issue.action ? ' <button class="chip-button mdl-issue-action">Bật meshopt</button>' : ''}</div>`).join('');
    for (const button of $.mdlIssues.querySelectorAll('.mdl-issue-action')) {
      onAction(button, () => { void enableMeshopt(); });
    }
  };

  // ------------------------------------------------------------ form (giống Inspector → Model)

  const setCheck = (input, { value, mixed }) => {
    input.indeterminate = !!mixed;
    input.checked = !mixed && !!value;
  };
  const setNumber = (input, { value, mixed }, mixedText = MIXED_PLACEHOLDER, mixedTitle = MIXED_TITLE) => {
    input.value = mixed ? '' : String(Math.round(Number(value) * 100) / 100);
    input.placeholder = mixed ? mixedText : '';
    input.title = mixed ? mixedTitle : '';
  };

  const renderForm = () => {
    const list = targets();
    const none = !list.length;
    setCheck($.mdlCEnable, formValue('meshCompress', 'enable', list));
    setCheck($.mdlCQuantize, formValue('meshCompress', 'quantize', list));
    setCheck($.mdlCEncode, formValue('meshCompress', 'encode', list));
    setCheck($.mdlCCompress, formValue('meshCompress', 'compress', list));
    const perModel = state.recommendedRatios && list.some((model) => model.triangles >= HEAVY_TRIANGLES);
    // Cùng nguồn với xem trước và Apply (effectiveFor), kể cả Target Ratio riêng của Recommended.
    const enables = list.map((model) => effectiveFor(model).enable);
    const simplifyOn = { value: !!enables[0], mixed: enables.some((value) => value !== enables[0]) };
    setCheck($.mdlSEnable, simplifyOn);
    const ratio = formValue('meshSimplify', 'targetRatio', list);
    if (perModel) {
      setNumber($.mdlSRatioNum, { value: '', mixed: true }, 'tự động', 'Recommended: Target Ratio riêng theo số tam giác của từng model nặng');
    } else {
      setNumber($.mdlSRatioNum, ratio);
    }
    $.mdlSRatio.value = String(perModel || ratio.mixed ? 0.5 : ratio.value);
    const autoOn = formValue('meshSimplify', 'autoErrorRate', list);
    setCheck($.mdlSAuto, autoOn);
    setNumber($.mdlSError, formValue('meshSimplify', 'errorRate', list));
    setCheck($.mdlSLock, formValue('meshSimplify', 'lockBoundary', list));
    const compressOn = formValue('meshCompress', 'enable', list);
    $.mdlCFields.classList.toggle('off', !compressOn.value && !compressOn.mixed);
    $.mdlSFields.classList.toggle('off', !simplifyOn.value && !simplifyOn.mixed);
    for (const input of [$.mdlCEnable, $.mdlCQuantize, $.mdlCEncode, $.mdlCCompress, $.mdlSEnable, $.mdlSRatio, $.mdlSRatioNum, $.mdlSAuto, $.mdlSLock, $.mdlSError]) {
      input.disabled = none || state.busy;
    }
    if (autoOn.value && !autoOn.mixed) $.mdlSError.disabled = true;
    // Model có màu đỉnh không dùng được Quantize (Cocos lỗi): chọn toàn model loại này thì ô Quantize tắt hẳn, rê chuột thấy lý do.
    const coloredOnly = !none && list.every((model) => model.vertexColors);
    const quantizeLabel = $.mdlCQuantize.closest('label');
    if (coloredOnly) {
      $.mdlCQuantize.indeterminate = false;
      $.mdlCQuantize.checked = false;
      $.mdlCQuantize.disabled = true;
    }
    if (quantizeLabel) {
      if (quantizeLabel.dataset.title === undefined) quantizeLabel.dataset.title = quantizeLabel.title || '';
      quantizeLabel.title = coloredOnly ? VERTEX_COLOR_TITLE : quantizeLabel.dataset.title;
      quantizeLabel.classList.toggle('mdl-locked', coloredOnly);
    }
    renderMeshopt();
    const dirty = state.edits.size > 0 || state.recommendedRatios;
    $.mdlApply.disabled = none || state.busy || !dirty;
    $.mdlRevert.disabled = !dirty;
    $.mdlTarget.textContent = none ? 'Chọn hoặc tick model để chỉnh' : list.length === 1 ? list[0].name : `${list.length} model`;
    $.mdlApply.textContent = list.length > 1 ? `Apply (${list.length})` : 'Apply';
    const notes = [];
    const compressEnabled = formValue('meshCompress', 'enable', list).value;
    if (compressEnabled && formValue('meshCompress', 'compress', list).value) {
      notes.push('Compress (zlib) thừa với playable: bản xuất đã zip toàn bộ, còn tốn thời gian load.');
    }
    const colored = list.filter((model) => model.vertexColors);
    if (colored.length) {
      const names = `${colored.slice(0, 3).map((model) => model.name).join(', ')}${colored.length > 3 ? '...' : ''}`;
      notes.push(colored.length === list.length
        ? `${names} có màu đỉnh: không dùng Quantize (Quantize của Cocos lỗi với vertex color), chỉ Encode + Mesh Simplify.`
        : state.edits.get(fieldKey('meshCompress', 'quantize')) === true
          ? `Có màu đỉnh, Apply sẽ bỏ Quantize riêng cho: ${names} (Quantize của Cocos lỗi với vertex color); các model khác vẫn Quantize.`
          : `${names} có màu đỉnh: không dùng Quantize (Quantize của Cocos lỗi với vertex color).`);
    }
    if (state.recommendedRatios) {
      const heavy = list.filter((model) => model.triangles >= HEAVY_TRIANGLES);
      notes.push(heavy.length
        ? `Target Ratio theo số tam giác cho ${heavy.length} model nặng (${heavy.slice(0, 3).map((model) => `${model.name} ${model.suggestRatio}`).join(', ')}${heavy.length > 3 ? '...' : ''}); model nhẹ giữ nguyên Mesh Simplify.`
        : `Không có model nào từ ${HEAVY_TEXT} tam giác: Mesh Simplify giữ nguyên.`);
    }
    if (dirty) notes.push('Chưa ghi: bấm Apply.');
    $.mdlFormNote.textContent = notes.join(' ');
    renderBulk();
  };

  /** Thẻ preset + nút Apply hàng loạt (thanh trên danh sách). */
  const renderPresets = () => {
    $.mdlPresets.innerHTML = MODEL_PRESETS.map((preset) => `
      <button class="preset-card ${state.preset === preset.id ? 'active' : ''}" data-preset="${preset.id}" title="${escapeHtml(preset.title)}">
        <b>${escapeHtml(preset.label)}</b><small>${escapeHtml(preset.note)}</small>
      </button>
    `).join('') + (state.preset === 'custom' ? '<span class="preset-card active" title="Các ô đã sửa tay trong form Import Settings (khung Chi tiết)"><b>Tùy chỉnh</b><small>theo form bên phải</small></span>' : '');
    for (const card of $.mdlPresets.querySelectorAll('button.preset-card')) {
      card.addEventListener('click', () => choosePreset(card.dataset.preset));
    }
  };

  const renderBulk = () => {
    const ticked = state.selection.size;
    const preset = MODEL_PRESETS.find((item) => item.id === state.preset);
    const drafted = state.edits.size > 0 || state.recommendedRatios;
    $.mdlBulkApply.disabled = !ticked || state.busy || !drafted;
    $.mdlBulkApply.textContent = ticked ? `Apply (${ticked})` : 'Apply';
    $.mdlBulkApply.title = preset ? `Áp ${preset.label} cho các model đang tick` : 'Áp các ô đã sửa trong form cho các model đang tick';
    if ((state.scanned && !state.ok) || !canEdit()) {
      // Quét lỗi (lý do ở dải cảnh báo), hoặc bản Creator không có Mesh Compress: không có gì để Apply hàng loạt.
      $.mdlBulkHint.textContent = '';
      return;
    }
    $.mdlBulkHint.textContent = !ticked
      ? 'Tick model (hoặc Tick hết) rồi chọn preset và Apply để áp hàng loạt; chỉnh riêng từng model ở khung Chi tiết.'
      : !drafted
        ? `Đã tick ${ticked} model: chọn một thẻ preset (form bên phải được điền sẵn để xem trước) hoặc sửa form, rồi Apply.`
        : preset
          ? `Apply sẽ áp ${preset.label} (${preset.note}) cho ${ticked} model đang tick.`
          : `Apply sẽ áp các ô đã sửa trong form cho ${ticked} model đang tick.`;
  };

  /** Sửa form lúc chưa tick gì: tick luôn model đang chọn, để thay đổi chưa ghi gắn với nó chứ không đi theo dòng đang xem. */
  const bindEditTarget = () => {
    if (state.selection.size || !state.selectedUuid) return;
    state.selection.add(state.selectedUuid);
    state.autoTicked = state.selectedUuid;
    for (const tick of $.mdlList.querySelectorAll('.mdl-tick')) {
      if (tick.dataset.uuid === state.selectedUuid) tick.checked = true;
    }
    renderSummary();
  };

  /**
   * Bỏ thay đổi chưa ghi khi tập model đang chỉnh bị thay (Việc nên làm tick model khác, Tick hết, Bỏ tick):
   * thay đổi làm cho model này không được áp sang model khác.
   */
  const discardEdits = (reason) => {
    const dirty = state.edits.size > 0 || state.recommendedRatios;
    state.edits.clear();
    state.recommendedRatios = false;
    state.autoTicked = '';
    if (dirty) setStatus(`Đã bỏ các ô chưa Apply: ${reason}.`);
    return dirty;
  };

  /** Sau Revert / Apply: bỏ tick tool tự thêm (nếu người dùng chưa tick thêm gì). */
  const releaseAutoTick = () => {
    if (state.autoTicked && state.selection.size === 1 && state.selection.has(state.autoTicked)) {
      state.selection.clear();
    }
    state.autoTicked = '';
  };

  /** Ô Meshopt Module: trạng thái thật trong Feature Cropping + vì sao cần. */
  const renderMeshopt = () => {
    const encoded = state.models.filter((model) => model.compress.encode).length;
    const list = targets();
    const encodePending = !!formValue('meshCompress', 'enable', list).value && !!formValue('meshCompress', 'encode', list).value;
    $.mdlMeshopt.indeterminate = false;
    $.mdlMeshopt.checked = !!state.meshopt.enabled;
    $.mdlMeshopt.disabled = state.busy || state.meshoptBusy || !state.scanned;
    let note = '';
    let warn = false;
    if (!state.meshopt.known) {
      note = 'chưa đọc được Feature Cropping';
      warn = encoded > 0 || encodePending;
    } else if (state.meshopt.enabled) {
      note = encoded ? `đang bật · giải mã ${encoded} model Encode` : 'đang bật · chưa model nào Encode';
    } else if (encoded) {
      note = `đang tắt · ${encoded} model Encode sẽ lỗi 16352`;
      warn = true;
    } else if (encodePending) {
      note = 'đang tắt · Apply sẽ tự bật cho Encode';
    } else {
      note = 'đang tắt · chỉ cần khi có Encode';
    }
    $.mdlMeshoptNote.textContent = note;
    $.mdlMeshoptNote.classList.toggle('warn', warn);
  };

  const setEdit = (section, key, value, delay) => {
    bindEditTarget();
    const enableKey = fieldKey(section, 'enable');
    if (section === 'meshSimplify' && key === 'targetRatio') {
      // Đổi Target Ratio là muốn giảm tam giác: Mesh Simplify đang tắt (hoặc đang theo Recommended) thì bật luôn.
      const enable = formValue('meshSimplify', 'enable');
      if (state.recommendedRatios || (!enable.mixed && !enable.value)) state.edits.set(enableKey, true);
      state.recommendedRatios = false;
    } else if (section === 'meshSimplify' && key === 'enable') {
      // Tick / bỏ tick tay là thôi Target Ratio riêng của Recommended. Bật mà Target Ratio đang 1 (chưa giảm gì) thì đặt mức gợi ý.
      state.recommendedRatios = false;
      const ratio = formValue('meshSimplify', 'targetRatio');
      if (value && !ratio.mixed && ratio.value >= 1) {
        const list = targets();
        state.edits.set(fieldKey('meshSimplify', 'targetRatio'), list.length === 1 && list[0].suggestRatio < 1 ? list[0].suggestRatio : 0.5);
      }
    } else if (section === 'meshCompress' && key !== 'enable' && value) {
      // Ô con chỉ có tác dụng khi Mesh Compress bật: bật luôn nếu đang tắt hẳn.
      const enable = formValue('meshCompress', 'enable');
      if (!enable.mixed && !enable.value) state.edits.set(enableKey, true);
    }
    state.edits.set(fieldKey(section, key), value);
    state.preset = 'custom';
    renderPresets();
    renderForm();
    schedulePreview(delay);
  };

  const resetForm = () => {
    state.edits.clear();
    state.recommendedRatios = false;
    state.preset = '';
    releaseAutoTick();
    renderPresets();
    render();
    schedulePreview();
  };

  /** Chọn thẻ preset: điền sẵn form (bản nháp) cho các model đang tick để xem trước thấy kết quả; Apply mới ghi. */
  const choosePreset = (id, { silent = false } = {}) => {
    const preset = MODEL_PRESETS.find((item) => item.id === id) || MODEL_PRESETS[0];
    bindEditTarget();
    state.edits.clear();
    for (const [key, value] of Object.entries(preset.compress)) {
      state.edits.set(fieldKey('meshCompress', key), value);
    }
    state.recommendedRatios = !!preset.simplifyByTris;
    state.preset = preset.id;
    renderPresets();
    renderForm();
    schedulePreview();
    if (!silent) setStatus(`Đã chọn ${preset.label}: ${preset.note}. Xem trước ở khung Chi tiết rồi bấm Apply.`);
  };

  /** Thay tập model đang tick: bản nháp của preset thì điền lại cho tập mới, sửa tay (Tùy chỉnh) thì bỏ. */
  const replaceSelection = (uuids, reason) => {
    const dirty = state.edits.size > 0 || state.recommendedRatios;
    const keepPreset = dirty && state.preset !== 'custom';
    const discarded = keepPreset ? false : discardEdits(reason);
    if (!keepPreset) state.preset = '';
    state.selection = new Set(uuids);
    state.autoTicked = '';
    render();
    if (keepPreset && state.selection.size) choosePreset(state.preset, { silent: true });
    else if (keepPreset) { state.edits.clear(); state.recommendedRatios = false; renderForm(); }
    renderPresets();
    schedulePreview();
    return discarded;
  };

  /** Nút Apply hàng loạt: chưa điền preset thì điền rồi ghi cho các model đang tick. */
  const bulkApply = () => {
    if (!state.selection.size || state.busy) return;
    // Bản nháp của thẻ: điền lại cho đúng tập đang tick trước khi ghi. Tùy chỉnh: ghi đúng các ô đã sửa.
    if (state.preset && state.preset !== 'custom') choosePreset(state.preset, { silent: true });
    void apply();
  };

  // ------------------------------------------------------------ danh sách

  const renderSummary = () => {
    if (!state.scanned) {
      $.mdlSummary.textContent = 'Đang đọc model...';
      return;
    }
    if (!state.ok) {
      $.mdlSummary.textContent = 'Chưa đọc được model của dự án.';
      return;
    }
    const inBuild = state.models.filter((model) => infoOf(model).inBuild);
    const zipped = inBuild.reduce((sum, model) => sum + infoOf(model).zipped, 0);
    const raw = inBuild.reduce((sum, model) => sum + infoOf(model).raw, 0);
    const todo = state.todoModels().length;
    const selected = state.selection.size ? ` · <b>đã tick ${state.selection.size}</b>` : '';
    $.mdlSummary.innerHTML = panel.state.buildMissing || !panel.state.buildFileCount
      ? `<b>${state.models.length} model</b> trong assets/ · chưa có bản build để biết model nào vào build${selected}`
      : `<b>${inBuild.length} model trong build</b>, <span title="${escapeHtml(zipTitle({ raw, zipped }))}">mesh ≈ ${escapeHtml(formatBytes(zipped))} sau zip</span>`
        + (todo ? ` · <span class="warn">${todo} cần xử lý</span>` : ' · <span class="muted">đã tối ưu hết</span>') + selected;
  };

  const render = () => {
    renderSummary();
    showIssues();
    // Không có Mesh Compress (Cocos dưới 3.8): ẩn thẻ preset + Apply hàng loạt, chỉ còn danh sách.
    const editable = canEdit();
    $.mdlPresets.classList.toggle('hidden', !editable);
    $.mdlBulkApply.classList.toggle('hidden', !editable);
    if (!state.scanned || !state.ok) {
      // Chưa đọc / đọc lỗi: không để chip đếm của lần quét trước (lý do lỗi ở dải cảnh báo).
      $.mdlList.innerHTML = '';
      $.mdlFilters.innerHTML = '';
      renderForm();
      return;
    }
    if (state.filter === 'build' && (panel.state.buildMissing || !panel.state.buildFileCount)) state.filter = 'all';
    renderFilters();
    const models = visibleModels();
    const previousUuid = state.selectedUuid;
    if (!state.selectedUuid || !models.some((model) => model.uuid === state.selectedUuid)) {
      state.selectedUuid = models[0] ? models[0].uuid : '';
    }
    // Model đang chọn bị bộ lọc ẩn nên chuyển dòng: khung Chi tiết (form, preview) phải theo model mới.
    const focusMoved = state.selectedUuid !== previousUuid && panel.state.step === 'optimize' && panel.state.optimizeKind === 'model';
    $.mdlList.innerHTML = models.length ? models.map((model) => {
      const info = infoOf(model);
      // Số tam giác chỉ hiện một lần (dòng phụ), tô vàng khi là việc nên làm; "chưa nén" đã có badge ở cột phải.
      const todos = modelTodos(model, info.inBuild);
      const heavy = todos.includes('heavy');
      const where = info.inBuild
        ? (info.includedBy[0] ? `dùng ở ${path.posix.basename(info.includedBy[0])}${info.includedBy.length > 1 ? ` (+${info.includedBy.length - 1})` : ''}` : 'trong build')
        : 'không vào build';
      const tris = `<span class="${heavy ? 'warn' : ''}"${heavy ? ` title="${escapeHtml(`Nên xử lý: ${TODO_LABELS.heavy}`)}"` : ''}>${escapeHtml(formatCount(model.triangles))} tam giác</span>`;
      return `
        <div class="eng-row mdl-row ${model.uuid === state.selectedUuid ? 'selected' : ''}" data-uuid="${escapeHtml(model.uuid)}">
          <label class="check mdl-check"><input type="checkbox" class="mdl-tick" data-uuid="${escapeHtml(model.uuid)}" ${state.selection.has(model.uuid) ? 'checked' : ''}></label>
          <div class="eng-main">
            <div class="eng-name"${todos.length ? ` title="${escapeHtml(`Nên xử lý: ${todoText(todos)}`)}"` : ''}>${escapeHtml(model.name)}</div>
            <div class="eng-sub" title="${escapeHtml(model.url)}">${tris} · ${escapeHtml(where)}</div>
          </div>
          <span class="eng-size" title="${info.inBuild ? escapeHtml(zipTitle(info)) : ''}">${info.inBuild ? `≈ ${escapeHtml(formatBytes(info.zipped))}<small>sau zip</small>` : ''}</span>
          <span class="eng-state">${badgesOf(model).map((badge) => `<span class="img-badge ${badge.className}" title="${escapeHtml(badge.title)}">${escapeHtml(badge.text)}</span>`).join('')}</span>
        </div>
      `;
    }).join('') : `<div class="detail-note tree-empty">${state.filter === 'build' ? 'Chưa có bản build (hoặc build không có model). Build web-mobile rồi phân tích lại, hoặc chọn "Tất cả".' : state.filter === 'todo' ? 'Không còn model nào cần xử lý trong bản build.' : 'Không có model nào.'}</div>`;

    for (const tick of $.mdlList.querySelectorAll('.mdl-tick')) {
      tick.addEventListener('click', (event) => event.stopPropagation());
      tick.addEventListener('change', () => {
        if (tick.checked) state.selection.add(tick.dataset.uuid); else state.selection.delete(tick.dataset.uuid);
        if (tick.dataset.uuid === state.autoTicked) state.autoTicked = '';
        if (!state.selection.size) discardEdits('không còn model nào được tick');
        renderSummary();
        renderForm();
        schedulePreview();
      });
    }
    for (const row of $.mdlList.querySelectorAll('.mdl-row')) {
      row.addEventListener('click', () => {
        select(row.dataset.uuid);
        $.mdlList.focus({ preventScroll: true });
      });
      row.addEventListener('dblclick', () => {
        const model = state.models.find((item) => item.uuid === row.dataset.uuid);
        if (model) void helpers.revealAsset({ url: model.url });
      });
    }
    renderForm();
    if (focusMoved) panel.renderDetail();
  };
  state.refresh = () => { infoCache.clear(); render(); };

  /** Cuộn tới model đang chọn: chỉ khi người dùng đổi lựa chọn (phím, Việc nên làm), không khi vẽ lại nền. */
  const scrollToSelected = () => {
    const row = $.mdlList.querySelector('.mdl-row.selected');
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  };

  const select = (uuid) => {
    state.selectedUuid = uuid;
    for (const row of $.mdlList.querySelectorAll('.mdl-row')) {
      row.classList.toggle('selected', row.dataset.uuid === uuid);
    }
    renderForm();
    panel.renderDetail();
  };

  const scan = async ({ silent = false } = {}) => {
    if (!silent) setStatus('Đang đọc model 3D...');
    const result = await Editor.Message.request(PACKAGE_NAME, 'model-scan').catch((error) => ({ ok: false, error: error.message }));
    state.scanned = true;
    infoCache.clear();
    if (!result || !result.ok) {
      // Lỗi để trong state: render() -> showIssues() vẽ lại dải cảnh báo từ state nên không bị xoá mất.
      state.ok = false;
      state.error = (result && result.error) || 'không rõ lỗi';
      state.models = [];
      // Không còn model nào: bỏ tick và bản nháp form, để thanh Apply không nói "N model đang tick".
      state.selection.clear();
      state.selectedUuid = '';
      discardEdits('không đọc được model');
      state.preset = '';
      renderPresets();
    } else {
      state.ok = true;
      state.error = '';
      state.models = result.models || [];
      state.meshopt = result.meshopt || state.meshopt;
      state.caps = result.caps || null;
      const known = new Set(state.models.map((model) => model.uuid));
      for (const uuid of [...state.selection]) {
        if (!known.has(uuid)) state.selection.delete(uuid);
      }
    }
    render();
    if (panel.state.step === 'optimize' && panel.state.optimizeKind === 'model') panel.renderDetail();
    if (panel.onSourcesScanned) panel.onSourcesScanned();
  };
  state.scan = scan;

  /** Từ "Việc nên làm": tick đúng các model này (theo url), chưa ghi gì. */
  state.selectOnly = (urls) => {
    const wanted = new Set((urls || []).map((url) => String(url).split('@')[0].toLowerCase()));
    state.filter = 'build';
    const uuids = state.models.filter((model) => wanted.has(model.url.toLowerCase())).map((model) => model.uuid);
    if (uuids[0]) state.selectedUuid = uuids[0];
    const discarded = replaceSelection(uuids, 'đã tick nhóm model khác từ Việc nên làm');
    scrollToSelected();
    panel.renderDetail();
    setStatus(`Đã tick ${state.selection.size} model${discarded ? ' (đã bỏ các ô chưa Apply của lần chỉnh trước)' : ''}. Chọn preset (Recommended...) rồi Apply.`);
  };

  /** Bật / tắt module meshopt (ô Meshopt Module, nút Bật meshopt ở dải cảnh báo). Ghi ngay vào Project Settings, có Lịch sử. */
  const setMeshopt = async (enabled) => {
    const encoded = state.models.filter((model) => model.compress.encode).length;
    if (!enabled && encoded && !window.confirm(`${encoded} model đang bật Encode: tắt meshopt thì build lỗi 16352 và các model đó không hiện. Vẫn tắt?`)) {
      renderMeshopt();
      return;
    }
    state.meshoptBusy = true;
    renderMeshopt();
    const result = await Editor.Message.request(PACKAGE_NAME, 'model-set-meshopt', { enabled }).catch((error) => ({ ok: false, error: error.message }));
    state.meshoptBusy = false;
    if (!result || !result.ok) {
      setStatus((result && result.error) || `Không ${enabled ? 'bật' : 'tắt'} được meshopt.`);
      renderMeshopt();
      return;
    }
    state.meshopt = { known: true, enabled };
    const message = enabled ? 'Đã bật meshopt (Project Settings → Feature Cropping). Build lại là các model Encode chạy được.' : 'Đã tắt meshopt.';
    if (result.historyId) helpers.offerUndo(result.historyId, message); else setStatus(message);
    await scan({ silent: true });
  };
  const enableMeshopt = () => setMeshopt(true);

  const apply = async () => {
    const list = targets();
    if (!list.length || state.busy || (!state.edits.size && !state.recommendedRatios)) return;
    const settings = {};
    for (const [id, value] of state.edits) {
      const [section, key] = id.split('.');
      settings[section] = settings[section] || {};
      settings[section][key] = value;
    }
    const perModel = {};
    const byTris = [];
    if (state.recommendedRatios && !state.edits.has(fieldKey('meshSimplify', 'targetRatio'))) {
      for (const model of list.filter((item) => item.triangles >= HEAVY_TRIANGLES)) {
        perModel[model.uuid] = { meshSimplify: { enable: true, targetRatio: model.suggestRatio } };
        byTris.push(model);
      }
    }
    // Quantize của Cocos sập với mesh có màu đỉnh: bỏ Quantize riêng cho các model đó (Encode / Simplify giữ nguyên).
    const colored = [];
    const quantizeOn = (model) => {
      const own = perModel[model.uuid] && perModel[model.uuid].meshCompress;
      const pick = (key) => (own && key in own ? own[key] : settings.meshCompress && key in settings.meshCompress ? settings.meshCompress[key] : storedValue(model, 'meshCompress', key));
      return !!pick('enable') && !!pick('quantize');
    };
    for (const model of list.filter((item) => item.vertexColors && quantizeOn(item))) {
      perModel[model.uuid] = { ...(perModel[model.uuid] || {}), meshCompress: { quantize: false } };
      colored.push(model);
    }
    const lines = [
      `${list.length === 1 ? list[0].name : `${list.length} model`}:`,
      ...Object.entries(settings).map(([section, values]) => `• ${describeSection(section, values)}`),
      ...(byTris.length ? [`• Mesh Simplify (Target Ratio theo số tam giác): ${byTris.map((model) => `${model.name} ${model.suggestRatio}`).join(', ')}`] : []),
      ...(colored.length ? [`• Bỏ Quantize (model có màu đỉnh, Quantize của Cocos lỗi): ${colored.map((model) => model.name).join(', ')}`] : []),
      '',
      'Ghi vào .meta của model (editor tự import lại, hoàn tác được trong Lịch sử). Build lại để thấy giảm bao nhiêu. Tiếp tục?',
    ];
    if (!window.confirm(lines.join('\n'))) return;
    state.busy = true;
    renderForm();
    setStatus('Đang ghi thiết lập model, editor sẽ import lại...');
    const result = await Editor.Message.request(PACKAGE_NAME, 'model-apply', {
      uuids: list.map((model) => model.uuid),
      settings,
      perModel,
      title: (MODEL_PRESETS.find((item) => item.id === state.preset) || {}).label || '',
    }).catch((error) => ({ ok: false, error: error.message }));
    state.busy = false;
    if (!result || !result.ok) {
      setStatus(`Không ghi được: ${(result && result.error) || 'không rõ lỗi'}`);
      renderForm();
      return;
    }
    const errors = result.errors || [];
    if (!result.updated && errors.length) {
      // Không ghi được model nào: giữ nguyên form để sửa / thử lại. meshopt có thể đã bật trước lượt ghi.
      const message = `Không ghi được ${errors.length} model: ${errors[0]}${result.meshoptHistoryId ? ' (meshopt đã được bật)' : ''}`;
      if (result.meshoptHistoryId) {
        state.meshopt = { known: true, enabled: true };
        helpers.offerUndo(result.meshoptHistoryId, message);
        showIssues();
      } else {
        setStatus(message);
      }
      renderForm();
      return;
    }
    state.edits.clear();
    state.recommendedRatios = false;
    state.preset = '';
    releaseAutoTick();
    renderPresets();
    render();
    const message = result.updated
      ? `Đã cập nhật ${result.updated} model${errors.length ? ` (${errors.length} lỗi: ${errors[0]})` : ''}${result.meshoptHistoryId ? ', đã bật meshopt' : ''}. Chờ editor import xong rồi build lại.`
      : 'Các model đã chọn sẵn đúng thiết lập này, không có gì thay đổi.';
    if (result.historyId) helpers.offerUndo(result.historyId, message); else setStatus(message);
    // Asset-db cần một nhịp để nhận meta vừa ghi.
    setTimeout(() => { void scan({ silent: true }); }, 800);
  };

  // ------------------------------------------------------------ xem trước (khung Chi tiết)

  const preview = {
    root: null,
    canvas: null,
    viewer: null,
    labels: null,
    status: null,
    wireframe: true,
    texture: true,
    geometry: new Map(), // uuid|mtime -> Promise<geometry>
    /** geometry -> object "Original" đưa viewer (cùng object thì viewer không đưa lại lên GPU khi kéo Target Ratio). */
    originals: new WeakMap(),
    encoder: null,
    token: 0,
    timer: null,
    lastKey: '',
    /** uuid model đang vẽ trên canvas; ảnh texture đã đưa viewer (chỉ gọi setTexture khi đổi, tránh nạp lại khi kéo slider). */
    shownUuid: '',
    shownTexture: null,
    /** Lỗi tạo viewer (không có WebGL...): giữ hiện thay vì bị dòng trạng thái đè. */
    viewerError: '',
    /** Dòng trạng thái chính (số tam giác...) và lỗi nạp texture của ảnh đang dán (viewer đã về màu đất sét). */
    statusText: '',
    textureError: '',
  };
  state.preview = preview;

  /** Ghi dòng trạng thái dưới preview, kèm lỗi texture nếu có (để không bị dòng mới đè mất). */
  const setPreviewStatus = (text) => {
    preview.statusText = text;
    if (preview.status) preview.status.textContent = preview.textureError ? `${text} · ${preview.textureError}` : text;
  };

  const appPath = () => {
    try {
      return (Editor.App && Editor.App.path) || path.join(process.resourcesPath, 'app.asar');
    } catch (_error) {
      return path.join(process.resourcesPath || '', 'app.asar');
    }
  };

  const renderLabels = () => {
    if (!preview.viewer || !preview.labels || typeof preview.viewer.getOverlayInfo !== 'function') return;
    const info = preview.viewer.getOverlayInfo() || [];
    preview.labels.innerHTML = info.map((item) => `<div class="mdl-preview-label" style="left:${item.x}px;width:${item.width}px"><b>${escapeHtml(item.label)}</b><span>${escapeHtml(formatCount(item.triangles))} tam giác</span></div>`).join('');
  };

  const ensurePreviewElement = () => {
    if (preview.root) return preview.root;
    const root = document.createElement('div');
    root.className = 'mdl-preview';
    root.innerHTML = `
      <div class="mdl-preview-bar">
        <span class="detail-title">Xem trước · Mesh Simplify</span>
        <label class="check"><input type="checkbox" class="mdl-pv-wire" checked> Wireframe</label>
        <label class="check"><input type="checkbox" class="mdl-pv-tex" checked> Texture</label>
      </div>
      <div class="mdl-preview-stage">
        <canvas class="mdl-preview-canvas"></canvas>
        <div class="mdl-preview-labels"></div>
      </div>
      <div class="mdl-preview-status detail-note small"></div>
    `;
    preview.root = root;
    preview.canvas = root.querySelector('.mdl-preview-canvas');
    preview.labels = root.querySelector('.mdl-preview-labels');
    preview.status = root.querySelector('.mdl-preview-status');
    const wire = root.querySelector('.mdl-pv-wire');
    const tex = root.querySelector('.mdl-pv-tex');
    wire.addEventListener('change', () => {
      preview.wireframe = wire.checked;
      if (preview.viewer) preview.viewer.setWireframe(preview.wireframe);
    });
    tex.addEventListener('change', () => {
      preview.texture = tex.checked;
      preview.lastKey = '';
      schedulePreview(0);
    });
    try {
      preview.viewer = createMeshViewer(preview.canvas, {
        onError: (message) => {
          preview.viewerError = message;
          preview.status.textContent = message;
        },
        // Ảnh dán lên không nạp được: viewer đã về màu đất sét, nói rõ thay vì im lặng.
        onTextureError: (message) => {
          const name = preview.shownTexture ? path.basename(preview.shownTexture) : '';
          preview.textureError = name && !message.includes(name) ? `${message} (${name})` : message;
          if (!preview.viewerError) setPreviewStatus(preview.statusText);
        },
        onRender: () => renderLabels(),
      });
      preview.viewer.setWireframe(preview.wireframe);
    } catch (error) {
      preview.viewerError = `Không tạo được khung xem trước: ${error.message || error}`;
      preview.status.textContent = preview.viewerError;
    }
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        if (preview.viewer) preview.viewer.resize();
        renderLabels();
      }).observe(root.querySelector('.mdl-preview-stage'));
    }
    return root;
  };
  state.ensurePreviewElement = ensurePreviewElement;

  /**
   * Ảnh cùng tên với model (vd ING_061.png cho ING_061.fbx) để dán lên preview, nếu có. Trùng tên nhiều ảnh
   * (texture + icon UI) thì lấy ảnh có thư mục chung dài nhất với model (8.Models/Textures hơn 3.Sprites/Icons).
   */
  const findTexture = (model) => {
    if (!preview.texture) return null;
    const base = model.name.replace(/\.[^.]+$/, '').toLowerCase();
    const modelDir = path.dirname(model.assetPath).replace(/\\/g, '/').toLowerCase();
    const shared = (fullPath) => {
      const dir = path.dirname(fullPath).replace(/\\/g, '/').toLowerCase();
      let length = 0;
      while (length < dir.length && length < modelDir.length && dir[length] === modelDir[length]) length += 1;
      return length;
    };
    const rows = ((panel.state.texture && panel.state.texture.rows) || [])
      .filter((row) => row.fullPath && path.basename(row.fullPath).replace(/\.[^.]+$/, '').toLowerCase() === base)
      .sort((left, right) => shared(right.fullPath) - shared(left.fullPath));
    return rows.length ? rows[0].fullPath : null;
  };

  const loadGeometry = (model) => {
    let mtime = 0;
    try { mtime = fs.statSync(model.assetPath).mtimeMs; } catch (_error) { /* thiếu file: lib báo lỗi */ }
    const key = `${model.uuid}|${mtime}`;
    if (!preview.geometry.has(key)) {
      const app = appPath();
      preview.geometry.set(key, meshPreview.loadSourceGeometry({
        projectRoot: Editor.Project.path,
        model: { uuid: model.uuid, assetPath: model.assetPath },
        converterPath: meshPreview.findConverter(app),
        cacheDir: workDir(Editor.Project.path, 'mesh-preview'),
      }).catch((error) => {
        preview.geometry.delete(key);
        throw error;
      }));
    }
    return preview.geometry.get(key);
  };

  const setPreviewTexture = (file) => {
    if (file === preview.shownTexture) return;
    preview.shownTexture = file;
    // Lỗi texture chỉ đúng cho ảnh cũ (viewer báo qua onTextureError).
    preview.textureError = '';
    void preview.viewer.setTexture(file);
  };

  /** meshoptimizer của editor (có từ Cocos 3.8); null khi bản này không kèm: preview chỉ hiện model gốc. */
  const loadEncoder = async () => {
    if (!preview.encoder) {
      const app = appPath();
      const roots = app.endsWith('.asar') ? [app, `${app}.unpacked`] : [app];
      preview.encoder = (async () => {
        for (const root of roots) {
          const encoder = await meshPreview.loadMeshopt(path.join(root, 'node_modules', 'meshopt_encoder')).catch(() => null);
          if (encoder) return encoder;
        }
        return null;
      })();
    }
    const encoder = await preview.encoder.catch(() => null);
    if (!encoder) {
      // Nhớ là không có (khỏi thử lại mỗi lần đổi model); mở lại panel thì thử lại.
      preview.encoder = Promise.resolve(null);
    }
    return encoder;
  };

  const updatePreview = async () => {
    const model = state.models.find((item) => item.uuid === state.selectedUuid);
    if (!model || !preview.root || !preview.root.isConnected || !preview.viewer) return;
    if (preview.viewerError) {
      preview.status.textContent = preview.viewerError;
      return;
    }
    const params = effectiveFor(model);
    const target = isTarget(model);
    // Simplify đang tắt: vẫn xem theo Target Ratio nếu đã đặt (< 1), không thì theo mức gợi ý.
    const ratio = params.enable || params.targetRatio < 1 ? params.targetRatio : model.suggestRatio < 1 ? model.suggestRatio : 0.5;
    const key = JSON.stringify([model.uuid, target, params.enable, ratio, params.autoErrorRate, params.errorRate, params.lockBoundary, preview.texture]);
    if (key === preview.lastKey) return;
    const token = ++preview.token;
    if (model.uuid !== preview.shownUuid) {
      // Model khác: xoá hình cũ ngay, không để hình + số tam giác của model trước dưới tên model mới lúc đang đọc.
      preview.shownUuid = '';
      preview.viewer.setModels(null, null);
      setPreviewTexture(null);
      renderLabels();
    }
    setPreviewStatus(model.name.toLowerCase().endsWith('.fbx') ? 'Đang đọc model (FBX → glTF lần đầu mất vài giây)...' : 'Đang đọc model...');
    preview.status.title = '';
    try {
      const geometry = await loadGeometry(model);
      const encoder = await loadEncoder();
      if (token !== preview.token) return;
      if (!encoder) {
        // Cocos dưới 3.8 không kèm meshoptimizer: vẫn xem được model gốc, chỉ không xem trước Mesh Simplify.
        preview.lastKey = key;
        if (!preview.originals.has(geometry)) {
          preview.originals.set(geometry, { label: 'Original', primitives: geometry.primitives, bounds: geometry.bounds, triangles: geometry.triangles });
        }
        preview.viewer.setModels(preview.originals.get(geometry), null);
        preview.shownUuid = model.uuid;
        setPreviewTexture(findTexture(model));
        renderLabels();
        setPreviewStatus(`${formatCount(geometry.triangles)} tam giác · bản Cocos này không kèm meshoptimizer (có từ 3.8) nên không xem trước được Mesh Simplify.`);
        return;
      }
      const simplified = meshPreview.simplifyGeometry(encoder, geometry, {
        targetRatio: ratio,
        autoErrorRate: params.autoErrorRate,
        errorRate: params.errorRate,
        lockBoundary: params.lockBoundary,
      });
      if (token !== preview.token) return;
      preview.lastKey = key;
      const rightLabel = params.enable ? `Mesh Simplify ${ratio}` : `Mesh Simplify ${ratio} (đang tắt)`;
      if (!preview.originals.has(geometry)) {
        preview.originals.set(geometry, { label: 'Original', primitives: geometry.primitives, bounds: geometry.bounds, triangles: geometry.triangles });
      }
      preview.viewer.setModels(
        preview.originals.get(geometry),
        { label: rightLabel, primitives: simplified.primitives, bounds: geometry.bounds, triangles: simplified.triangles },
      );
      preview.shownUuid = model.uuid;
      setPreviewTexture(findTexture(model));
      renderLabels();
      const sourceText = { 'cocos-cache': 'glTF Cocos đã chuyển', converted: 'FBX vừa chuyển sang glTF', gltf: 'file glTF', glb: 'file GLB' }[geometry.source] || geometry.source;
      const notTarget = target ? '' : 'Model này không tick nên form không áp cho nó: xem trước theo thiết lập đang lưu. ';
      // Một dòng ngắn để form ngay dưới preview; phần giải thích để ở tooltip.
      setPreviewStatus(`${notTarget}${formatCount(geometry.triangles)} → ${formatCount(simplified.triangles)} tam giác (${Math.round(simplified.triangles / Math.max(1, geometry.triangles) * 100)}%) · ${simplified.ms} ms`);
      preview.status.title = `Dữ liệu: ${sourceText}. Kéo để xoay, chuột phải / Shift + kéo để dời, lăn để zoom, nháy đúp để đặt lại. Xem trước chạy cùng meshoptimizer của editor; kết quả import thật có thể lệch chút ít.`;
    } catch (error) {
      if (token !== preview.token) return;
      preview.lastKey = '';
      preview.shownUuid = '';
      preview.viewer.setModels(null, null);
      setPreviewTexture(null);
      renderLabels();
      setPreviewStatus(`Không xem trước được: ${error.message || error}`);
    }
  };

  const schedulePreview = (delay = 120) => {
    clearTimeout(preview.timer);
    preview.timer = setTimeout(() => { void updatePreview(); }, delay);
  };
  state.schedulePreview = schedulePreview;
  /** Đóng panel: trả WebGL context (Chromium chỉ cho ~16 context, gồm cả Scene view của editor). */
  state.dispose = () => {
    clearTimeout(preview.timer);
    preview.token += 1;
    if (preview.viewer) preview.viewer.dispose();
    preview.viewer = null;
    preview.shownUuid = '';
    preview.shownTexture = null;
    preview.textureError = '';
  };

  // ------------------------------------------------------------ wire

  $.mdlList.tabIndex = 0;
  $.mdlList.addEventListener('keydown', (event) => {
    // Đang focus ô tick của một dòng: để checkbox tự đổi (change handler), không đổi dòng đang chọn.
    const onTick = event.target && event.target.classList && event.target.classList.contains('mdl-tick');
    if (onTick && (event.key === ' ' || event.key === 'Spacebar' || event.key === 'Enter')) return;
    const uuids = [...$.mdlList.querySelectorAll('.mdl-row')].map((row) => row.dataset.uuid);
    const index = uuids.indexOf(state.selectedUuid);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = uuids[Math.max(0, Math.min(uuids.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        select(next);
        scrollToSelected();
        if (onTick) $.mdlList.focus({ preventScroll: true });
      }
      return;
    }
    if ((event.key === ' ' || event.key === 'Spacebar') && state.selectedUuid) {
      event.preventDefault();
      if (state.selection.has(state.selectedUuid)) state.selection.delete(state.selectedUuid); else state.selection.add(state.selectedUuid);
      if (state.selectedUuid === state.autoTicked) state.autoTicked = '';
      if (!state.selection.size) discardEdits('không còn model nào được tick');
      render();
      $.mdlList.focus({ preventScroll: true });
      schedulePreview();
    }
  });
  onAction($.mdlSelectAll, () => {
    const uuids = visibleModels().map((model) => model.uuid);
    const discarded = replaceSelection(uuids, 'đã tick nhóm model khác');
    setStatus(`Đã tick ${state.selection.size} model đang hiện.${discarded ? ' Đã bỏ các ô chưa Apply của lần chỉnh trước.' : ''}`);
  });
  onAction($.mdlSelectNone, () => {
    replaceSelection([], 'đã bỏ tick hết');
  });
  onAction($.mdlBulkApply, bulkApply);
  const bindCheck = (input, section, key) => {
    input.addEventListener('change', () => setEdit(section, key, !!input.checked));
  };
  bindCheck($.mdlCEnable, 'meshCompress', 'enable');
  bindCheck($.mdlCQuantize, 'meshCompress', 'quantize');
  bindCheck($.mdlCEncode, 'meshCompress', 'encode');
  bindCheck($.mdlCCompress, 'meshCompress', 'compress');
  $.mdlMeshopt.addEventListener('change', () => { void setMeshopt(!!$.mdlMeshopt.checked); });
  bindCheck($.mdlSEnable, 'meshSimplify', 'enable');
  bindCheck($.mdlSAuto, 'meshSimplify', 'autoErrorRate');
  bindCheck($.mdlSLock, 'meshSimplify', 'lockBoundary');
  const ratioValue = (raw) => Math.max(0.01, Math.min(1, Number(raw) || 0.01));
  $.mdlSRatio.addEventListener('input', () => {
    setEdit('meshSimplify', 'targetRatio', ratioValue($.mdlSRatio.value), 60);
  });
  $.mdlSRatioNum.addEventListener('change', () => {
    if ($.mdlSRatioNum.value === '') return;
    setEdit('meshSimplify', 'targetRatio', ratioValue($.mdlSRatioNum.value));
  });
  $.mdlSError.addEventListener('change', () => {
    if ($.mdlSError.value === '') return;
    setEdit('meshSimplify', 'errorRate', Math.max(0, Math.min(1, Number($.mdlSError.value) || 0)));
  });
  onAction($.mdlRevert, resetForm);
  onAction($.mdlApply, () => { void apply(); });
  onAction($.mdlHelpToggle, () => {
    const open = $.mdlHelp.classList.contains('hidden');
    $.mdlHelp.classList.toggle('hidden', !open);
    $.mdlHelpToggle.classList.toggle('active', open);
  });
  renderPresets();
  render();
}

// ---------------------------------------------------------------- khung chi tiết

function renderDetail(panel, helpers) {
  const { escapeHtml, onAction } = helpers;
  const state = panel.state.model;
  const detail = panel.$.detail;
  if (!state) return;
  const model = state.models.find((item) => item.uuid === state.selectedUuid);
  // Bố cục như Inspector → Model: model đang chọn + preview ở trên, form Import Settings ngay dưới preview.
  detail.className = 'detail';
  if (!model) {
    detail.innerHTML = `
      <div class="detail-body mdl-detail">
        <div class="mdl-settings-slot"></div>
        <div class="detail-note">${state.scanned ? 'Chọn một model để xem trước và xem số liệu.' : 'Đang đọc model...'}</div>
      </div>
    `;
    if (!state.canEdit || state.canEdit()) detail.querySelector('.mdl-settings-slot').appendChild(panel.$.mdlSettings);
    return;
  }
  const info = state.infoOf(model);
  const editable = !state.canEdit || state.canEdit();
  const advice = [];
  if (model.importFailed && model.importFailed.length) {
    advice.push(`<b>Cocos import lỗi</b> mesh của model này (xem Console), nên mesh không có trong build. ${model.vertexColors && model.compress.quantize ? 'Model có màu đỉnh: tắt <b>Quantize</b> rồi Apply là import lại được.' : 'Tắt bớt <b>Quantize</b> / <b>Mesh Simplify</b> rồi Apply lại, hoặc hoàn tác trong Lịch sử.'}`);
  }
  if (model.vertexColors) {
    advice.push('Model có <b>màu đỉnh</b>: Quantize của Cocos lỗi với loại mesh này nên tool bỏ Quantize khi Apply, chỉ dùng <b>Encode</b> (vẫn nhỏ đi nhiều sau zip) và Mesh Simplify.');
  }
  if (!editable) {
    advice.push(`Cocos ${escapeHtml((state.caps && state.caps.version) || 'bản này')} chưa có <b>Mesh Compress</b> / <b>Mesh Simplify</b> trong Import Settings (có từ 3.8). Mesh lưu số thực 32-bit nên zip gần như không nén được; giảm tam giác trong phần mềm 3D rồi import lại nếu model nặng.`);
  }
  if (editable && info.inBuild && !isMeshCompressed(model)) {
    advice.push(model.vertexColors
      ? 'Bật <b>Mesh Compress</b> với <b>Encode</b> (thẻ <b>Recommended</b> tự bỏ Quantize cho model có màu đỉnh).'
      : 'Bật <b>Mesh Compress</b> với <b>Quantize</b> + <b>Encode</b> (thẻ <b>Recommended</b>): mesh thường nhỏ đi 3–5 lần sau zip. Không muốn phụ thuộc meshopt thì chỉ <b>Quantize</b> (khoảng một nửa).');
  }
  if (editable && model.compress.compress) {
    advice.push('<b>Compress</b> (zlib) đang bật: thừa với playable vì bản xuất đã zip toàn bộ, còn tốn thời gian load. Nên tắt.');
  }
  if (editable && info.inBuild && model.triangles >= HEAVY_TRIANGLES && !simplifies(model)) {
    advice.push(`${escapeHtml(formatCount(model.triangles))} tam giác là nhiều cho một vật nhỏ trên màn hình playable. Thử <b>Mesh Simplify</b> với <b>Target Ratio</b> khoảng ${model.suggestRatio}, so sánh ở khung xem trước phía trên.`);
  }
  // Ưu tiên xem trước: tên model -> xem trước -> form Import Settings -> gợi ý / số liệu.
  detail.innerHTML = `
    <div class="detail-body mdl-detail">
      <div class="d-head mdl-model-head">
        <div class="d-title">${escapeHtml(model.name)}</div>
        <div class="d-chips">
          ${badgesOf(model).map((badge) => `<span class="img-badge ${badge.className}" title="${escapeHtml(badge.title)}">${escapeHtml(badge.text)}</span>`).join('')}
          <span class="chip">${info.inBuild ? 'trong build' : 'không vào build'}</span>
          <span class="chip">${escapeHtml(formatCount(model.triangles))} tam giác</span>
          ${info.inBuild ? `<span class="chip" title="${escapeHtml(zipTitle(info))}">≈ ${escapeHtml(formatBytes(info.zipped))} sau zip</span>` : ''}
        </div>
        <div class="muted small mono">${escapeHtml(model.url)}</div>
      </div>
      <div class="mdl-preview-slot"></div>
      <div class="mdl-settings-slot"></div>
      ${advice.length ? `<div class="d-section"><div class="detail-title">Gợi ý</div>${advice.map((text) => `<div class="detail-note">${text}</div>`).join('')}</div>` : (info.inBuild && editable ? '<div class="detail-note">Model này đã tối ưu.</div>' : '')}
      <div class="d-section">
        <div class="detail-title">Số liệu</div>
        <ul class="d-files plain">
          <li>${escapeHtml(formatCount(model.triangles))} tam giác · ${model.meshUuids.length} mesh</li>
          <li>Nguồn ${escapeHtml(formatBytes(model.fileBytes))}</li>
          ${info.inBuild ? `<li>Trong build (chưa zip) ${escapeHtml(formatBytes(info.raw))}</li><li title="${escapeHtml(ZIP_TITLE)}"><b>Sau zip ≈ ${escapeHtml(formatBytes(info.zipped))}</b></li>` : ''}
        </ul>
      </div>
      ${info.includedBy.length ? `<div class="d-section"><div class="detail-title">Được kéo vào build bởi</div><ul class="d-files plain">${info.includedBy.map((url) => `<li>${escapeHtml(url)}</li>`).join('')}</ul></div>` : ''}
      ${info.rows.length ? `<div class="d-section"><div class="detail-title">File trong build (${info.rows.length})</div><ul class="d-files">${info.rows.map((row) => `<li title="${escapeHtml(row.relativePath)}"><span class="d-file-name">${escapeHtml(path.basename(row.relativePath))}</span><span class="d-file-size">${escapeHtml(formatBytes(row.size))}</span></li>`).join('')}</ul></div>` : ''}
      <div class="d-section"><button class="chip-button mdl-reveal">Chọn trong Assets</button></div>
    </div>
  `;
  if (editable) detail.querySelector('.mdl-settings-slot').appendChild(panel.$.mdlSettings);
  const slot = detail.querySelector('.mdl-preview-slot');
  if (slot && state.ensurePreviewElement) {
    slot.appendChild(state.ensurePreviewElement());
    if (state.preview.viewer) state.preview.viewer.resize();
    state.preview.lastKey = '';
    // Hơi trễ: giữ phím ↑ ↓ lướt danh sách thì chỉ model cuối cùng được đọc / chuyển FBX.
    state.schedulePreview(80);
  }
  const reveal = detail.querySelector('.mdl-reveal');
  if (reveal) {
    onAction(reveal, () => { void helpers.revealAsset({ url: model.url }); });
  }
}

module.exports = {
  SELECTORS,
  setup,
  renderDetail,
};
