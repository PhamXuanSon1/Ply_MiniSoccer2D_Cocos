'use strict';

/**
 * Bước Tối ưu → Ảnh: cây thư mục mọi ảnh trong assets/ (lọc nhanh: chưa nén, nặng, không vào
 * build...), tick theo thư mục hoặc từng file, tự nén thử để biết trước dung lượng, rồi bật /
 * tắt Texture Compress. Chọn một file sẽ xem trước + thao tác riêng ở khung Chi tiết.
 * Mọi thao tác ghi đi qua main.js (message texture-*).
 */

const { formatBytes } = require('../../lib/build-scan');
const { readImageMeta } = require('../../lib/image-meta');
const preview = require('./preview');
const thumbs = require('./thumbs');

const PACKAGE_NAME = 'playable-size-inspector';
const PREFS_KEY = `${PACKAGE_NAME}.texture`;

const SELECTORS = {
  panelTexture: '#panel-texture',
  texFilters: '#tex-filters',
  texPreset: '#tex-preset',
  texReloadPresets: '#tex-reload-presets',
  texPresetHint: '#tex-preset-hint',
  texSelectAll: '#tex-select-all',
  texSelectNone: '#tex-select-none',
  texExpandAll: '#tex-expand-all',
  texCollapseAll: '#tex-collapse-all',
  texApply: '#tex-apply',
  texDisable: '#tex-disable',
  texSummary: '#tex-summary',
  texIssues: '#tex-issues',
  texTree: '#tex-tree',
  texTreeHead: '#tex-tree-head',
  texGrid: '#tex-grid',
  texView: '#tex-view',
  texHelp: '#tex-help',
  texHelpToggle: '#tex-help-toggle',
};

/**
 * Ảnh nào có việc nên làm, lấy từ "Việc nên làm" (cùng bằng chứng): đóng gói 2 lần, chưa nén,
 * nặng trong build. { todo: Set<url>, duplicated: Set<url> }
 */
function textureFlags(panel) {
  const todo = new Set();
  const duplicated = new Set();
  for (const insight of panel.state.insights || []) {
    if (insight.group !== 'texture' || !insight.action || !Array.isArray(insight.action.urls)) {
      continue;
    }
    for (const url of insight.action.urls) {
      todo.add(url);
      if (insight.id.startsWith('texture-atlas-duplicate')) {
        duplicated.add(url);
      }
    }
  }
  return { todo, duplicated };
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  } catch (_error) {
    return {};
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (_error) {
    // Chỉ là tiện ích nhớ lựa chọn.
  }
}

// ---------------------------------------------------------------- preset

/** Ghép thêm " trước." hoặc " rồi bấm ↻." tuỳ chỗ hiện. */
const UNCONFIGURED_HINT = 'Preset này chưa cấu hình định dạng nén nào: thêm định dạng trong Project Settings → Texture Compress';
const PRESET_MISSING_TITLE = 'Preset đang gán đã bị xoá khỏi Project Settings → Texture Compress: áp preset khác hoặc tắt nén.';

/** Nhãn trong ô chọn preset: preset chưa có định dạng nén nào thì ghi rõ (áp vào cũng không nén gì). */
function presetOptionLabel(preset, withFormats = false) {
  if (preset.unconfigured) {
    return `${preset.name} (chưa cấu hình định dạng)`;
  }
  return withFormats && preset.formats.length ? `${preset.name} (${preset.formats.join(', ')})` : preset.name;
}

/** Preset chọn sẵn khi chưa có lựa chọn nào: preset đầu tiên đã có định dạng nén. */
function defaultPreset(presets) {
  return presets.find((preset) => !preset.unconfigured) || presets[0] || null;
}

// ---------------------------------------------------------------- cây thư mục

/** Gom rows theo đường dẫn thành cây { name, path, folders, files, count, bytes }. */
function buildTree(rows) {
  const root = { name: '', path: '', folders: new Map(), files: [], count: 0, bytes: 0 };
  for (const row of rows) {
    const parts = row.relativePath.split('/');
    let node = root;
    node.count += 1;
    node.bytes += row.bytes;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index];
      let child = node.folders.get(name);
      if (!child) {
        child = { name, path: node.path ? `${node.path}/${name}` : name, folders: new Map(), files: [], count: 0, bytes: 0 };
        node.folders.set(name, child);
      }
      node = child;
      node.count += 1;
      node.bytes += row.bytes;
    }
    node.files.push(row);
  }
  return root;
}

function collectFolderUrls(node, out = []) {
  for (const file of node.files) {
    out.push(file.url);
  }
  for (const folder of node.folders.values()) {
    collectFolderUrls(folder, out);
  }
  return out;
}

function findFolder(node, folderPath) {
  if (!folderPath) {
    return node;
  }
  let current = node;
  for (const part of folderPath.split('/')) {
    current = current && current.folders.get(part);
    if (!current) {
      return null;
    }
  }
  return current;
}

function folderCheckState(node, checked) {
  const urls = collectFolderUrls(node);
  const selected = urls.filter((url) => checked.has(url)).length;
  if (!selected) {
    return 'none';
  }
  return selected === urls.length ? 'all' : 'some';
}

/** Dung lượng + chênh lệch của asset nguồn này trong build (từ lần phân tích build gần nhất). */
function buildInfoFor(panel, url) {
  const index = panel.state.buildSizeBySource;
  return index ? index.get(url) || null : null;
}

/**
 * Cột Compressed: ưu tiên số ước tính vừa nén thử (có dấu ≈ và theo preset đang
 * chọn), nếu chưa nén thử thì lấy số thật Cocos đã tạo lúc build.
 */
function describeCompressed(row, estimate) {
  if (estimate) {
    if (estimate.error) {
      return { text: 'lỗi nén thử', title: estimate.error, className: 'compress-warn' };
    }
    const ratio = estimate.sourceBytes > 0 ? Math.round(100 * (1 - estimate.bytes / estimate.sourceBytes)) : 0;
    return {
      text: `≈${formatBytes(estimate.bytes)} ${ratio > 0 ? `−${ratio}%` : ''}`.trim(),
      title: `Nén thử với preset đang chọn: ${formatBytes(estimate.sourceBytes)} → ${formatBytes(estimate.bytes)}`,
      className: 'compress-estimate',
    };
  }

  const info = row.compressed;
  if (!info) {
    return { text: row.enabled ? 'chưa có số liệu' : '', title: 'Tick ảnh này để tool nén thử với preset đang chọn, hoặc Build một lần để Cocos sinh số liệu thật.', className: 'muted' };
  }
  const ratio = info.sourceBytes > 0 ? Math.round(100 * (1 - info.bytes / info.sourceBytes)) : 0;
  const flags = [];
  if (info.stale) {
    flags.push('ảnh nguồn đã sửa sau lần nén');
  }
  if (!info.matchesPreset) {
    flags.push(`số liệu thuộc tuỳ chọn nén ${info.optionsLabel}, khác preset đang gán`);
  }
  return {
    text: `${formatBytes(info.bytes)} ${ratio > 0 ? `−${ratio}%` : ''}${flags.length ? ' ⚠' : ''}`.trim(),
    title: `Sau khi nén: ${formatBytes(info.bytes)} (từ ${formatBytes(info.sourceBytes)}, tuỳ chọn nén ${info.optionsLabel})${flags.length ? `\n${flags.join('\n')}` : ''}`,
    className: flags.length ? 'compress-warn' : 'compress-ok',
  };
}

// ---------------------------------------------------------------- setup

/** Ảnh chiếm từ mức này trong build trở lên thì vào bộ lọc "Nặng". */
const HEAVY_IN_BUILD = 100 * 1024;
/**
 * Con số chính của tab Ảnh là dung lượng trong build web-mobile (byte thật, chưa zip). Model 3D ghi "sau zip",
 * Module engine ghi phần của module trong build: mỗi tab ghi rõ con số của mình là gì.
 */
const BUILD_SIZE_TITLE = 'Dung lượng ảnh này trong bản build web-mobile (lần phân tích gần nhất, chưa zip; playable-ads-builder còn nén WebP khi xuất HTML). Số màu là chênh lệch so với lần build trước.';
const SOURCE_SIZE_TITLE = 'Dung lượng file ảnh nguồn trong assets/';
/** Chờ người dùng tick xong rồi mới nén thử (ms). */
const ESTIMATE_DELAY = 700;

/** Bộ lọc nhanh của cây. `needsBuild`: chỉ có nghĩa khi đã phân tích bản build. */
const FILTERS = [
  { id: 'todo', label: 'Nên xử lý', title: 'Ảnh có việc nên làm (xem Tổng quan → Việc nên làm): đóng gói 2 lần, chưa nén, nặng trong build', needsBuild: true, test: (row, info, flags) => flags.todo.has(row.url) },
  { id: 'all', label: 'Tất cả', test: () => true },
  { id: 'off', label: 'Chưa nén', title: 'Ảnh chưa bật Texture Compress', test: (row) => !row.enabled },
  { id: 'missing', label: 'Preset đã xoá', title: PRESET_MISSING_TITLE, test: (row) => !!row.presetMissing },
  { id: 'heavy', label: 'Nặng ≥ 100 KB', title: 'Ảnh chiếm từ 100 KB trong bản build hiện tại', needsBuild: true, test: (row, info) => !!info && info.bytes >= HEAVY_IN_BUILD },
  { id: 'unused', label: 'Không vào build', title: 'Ảnh không có trong bản build hiện tại: nén hay không cũng không đổi dung lượng build', needsBuild: true, test: (row, info) => !info },
  { id: 'stale', label: 'Số liệu cũ', title: 'Số liệu nén thuộc tuỳ chọn nén khác preset đang gán, hoặc ảnh đã sửa sau lần nén. Build lại để cập nhật.', test: (row) => !!row.compressed && (row.compressed.stale || !row.compressed.matchesPreset) },
];

function setup(panel, helpers) {
  const $ = panel.$;
  const { escapeHtml, setStatus, onAction, formatDelta, deltaClass } = helpers;
  const applyTitle = $.texApply.title;
  const state = {
    rows: [],
    presets: [],
    tree: buildTree([]),
    filter: 'all',
    expanded: new Set(),
    checked: new Set(),
    /** url -> { bytes, sourceBytes } nén thử với preset `estimatePreset`. */
    estimates: new Map(),
    estimatePreset: '',
    estimating: false,
    selectedUrl: '',
    busy: false,
    scanned: false,
    /** grid | tree */
    view: loadPrefs().view === 'tree' ? 'tree' : 'grid',
  };
  panel.state.texture = state;

  const persist = () => savePrefs({ ...loadPrefs(), presetId: $.texPreset.value, view: state.view });
  const filterDef = () => FILTERS.find((filter) => filter.id === state.filter) || FILTERS.find((filter) => filter.id === 'all');
  const visibleRows = () => {
    const flags = textureFlags(panel);
    return state.rows.filter((row) => filterDef().test(row, buildInfoFor(panel, row.url), flags));
  };
  const checkedRows = () => state.rows.filter((row) => state.checked.has(row.url));
  const selectedPreset = () => state.presets.find((item) => item.id === $.texPreset.value) || null;
  /** Preset đang chọn chưa có định dạng nén: chặn Bật nén và nén thử (main cũng từ chối). */
  const presetUnconfigured = () => {
    const preset = selectedPreset();
    return !!(preset && preset.unconfigured);
  };

  const setBusy = (busy) => {
    state.busy = busy;
    $.texApply.disabled = busy || presetUnconfigured();
    $.texDisable.disabled = busy;
  };

  const showIssues = (issues) => {
    if (!issues || !issues.length) {
      $.texIssues.classList.add('hidden');
      $.texIssues.innerHTML = '';
      return;
    }
    $.texIssues.classList.remove('hidden');
    $.texIssues.innerHTML = issues
      .map((issue) => `<div class="issue ${escapeHtml(issue.level || 'info')}">${escapeHtml(issue.message)}</div>`)
      .join('');
  };

  /** Dòng gợi ý cạnh ô Preset + khoá nút Bật nén khi preset chưa cấu hình định dạng. */
  const updatePresetHint = () => {
    const preset = selectedPreset();
    const blocked = presetUnconfigured();
    $.texPresetHint.textContent = blocked
      ? `${UNCONFIGURED_HINT} rồi bấm ↻.`
      : (preset && preset.formats.length ? `Preset nén thành: ${preset.formats.join(', ')}` : '');
    $.texApply.disabled = state.busy || blocked;
    $.texApply.title = blocked ? `${UNCONFIGURED_HINT} trước.` : applyTitle;
  };

  const fillPresets = (presets) => {
    const keep = $.texPreset.value || loadPrefs().presetId;
    state.presets = presets || [];
    $.texPreset.innerHTML = state.presets.length
      ? state.presets.map((preset) => `<option value="${escapeHtml(preset.id)}">${escapeHtml(presetOptionLabel(preset))}</option>`).join('')
      : '<option value="">(chưa có preset)</option>';
    const fallback = defaultPreset(state.presets);
    $.texPreset.value = state.presets.some((preset) => preset.id === keep) ? keep : (fallback ? fallback.id : '');
    updatePresetHint();
  };

  const renderFilters = () => {
    const hasBuild = !!panel.state.buildSizeBySource;
    const flags = textureFlags(panel);
    const count = (filter) => state.rows.filter((row) => filter.test(row, buildInfoFor(panel, row.url), flags)).length;
    if (!hasBuild && filterDef().needsBuild) {
      state.filter = 'all';
    }
    $.texFilters.innerHTML = FILTERS
      .filter((filter) => hasBuild || !filter.needsBuild)
      .map((filter) => {
        const total = count(filter);
        if (filter.id !== 'all' && !total) {
          return '';
        }
        return `<button class="filter-chip ${filter.id === 'todo' ? 'chip-todo' : ''} ${state.filter === filter.id ? 'active' : ''}" data-filter="${filter.id}" title="${escapeHtml(filter.title || '')}">${escapeHtml(filter.label)} <span>${total}</span></button>`;
      })
      .join('');
    for (const chip of $.texFilters.querySelectorAll('.filter-chip')) {
      chip.addEventListener('click', () => {
        state.filter = chip.dataset.filter;
        refresh({ scroll: true });
      });
    }
  };

  /** Thanh hành động: chưa tick thì hướng dẫn, đã tick thì nói rõ sắp tác động tới bao nhiêu. */
  const renderSummary = () => {
    if (!state.scanned) {
      $.texSummary.textContent = 'Đang quét ảnh nguồn...';
      return;
    }
    const rows = checkedRows();
    if (!rows.length) {
      const enabled = state.rows.filter((row) => row.enabled).length;
      $.texSummary.innerHTML = `<b>${state.rows.length} ảnh</b> · ${enabled} đang bật nén. <span class="muted">Tick ảnh hoặc cả thư mục để bật / tắt nén.</span>`;
      return;
    }
    const sourceBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    const inBuild = rows.map((row) => buildInfoFor(panel, row.url)).filter(Boolean).reduce((sum, info) => sum + info.bytes, 0);
    const estimable = rows.filter((row) => row.kind !== 'auto-atlas');
    const estimated = estimable.filter((row) => {
      const value = state.estimates.get(row.url);
      return value && !value.error;
    });
    let estimatePart = '';
    if (state.estimating) {
      estimatePart = ' · <span class="muted">đang nén thử...</span>';
    } else if (estimated.length) {
      const before = estimated.reduce((sum, row) => sum + (state.estimates.get(row.url).sourceBytes || 0), 0);
      const after = estimated.reduce((sum, row) => sum + state.estimates.get(row.url).bytes, 0);
      const ratio = before > 0 ? Math.round(100 * (1 - after / before)) : 0;
      estimatePart = ` · sau nén ≈ <b>${escapeHtml(formatBytes(after))}</b> <span class="delta-down">(−${ratio}%)</span>`
        + (estimated.length < estimable.length ? ` <span class="muted">(${estimated.length}/${estimable.length} ảnh)</span>` : '');
    }
    $.texSummary.innerHTML = `<b>Đã chọn ${rows.length} ảnh</b> · nguồn ${escapeHtml(formatBytes(sourceBytes))}`
      + (inBuild ? ` · trong build ${escapeHtml(formatBytes(inBuild))}` : '')
      + estimatePart;
  };

  const renderTree = () => {
    if (!state.scanned) {
      $.texTree.classList.add('hidden');
      return;
    }
    $.texTree.classList.remove('hidden');
    if (!state.rows.length) {
      $.texTree.innerHTML = '<div class="detail-note tree-empty">Không tìm thấy ảnh nào hỗ trợ Texture Compress trong assets/.</div>';
      return;
    }
    if (!state.tree.count) {
      $.texTree.innerHTML = '<div class="detail-note tree-empty">Không có ảnh nào khớp bộ lọc này.</div>';
      return;
    }

    const lines = [];
    const walk = (node, depth) => {
      for (const folder of [...node.folders.values()].sort((left, right) => left.name.localeCompare(right.name))) {
        const expanded = state.expanded.has(folder.path);
        const checkState = folderCheckState(folder, state.checked);
        lines.push(`
          <div class="tree-row tree-folder" data-folder="${escapeHtml(folder.path)}">
            <span class="tree-label" style="padding-left:${depth * 14}px">
              <span class="tree-toggle">${expanded ? '▾' : '▸'}</span>
              <input type="checkbox" class="tree-check" data-folder="${escapeHtml(folder.path)}" ${checkState === 'all' ? 'checked' : ''} data-state="${checkState}" title="Tick cả thư mục">
              <span class="tree-name">${escapeHtml(folder.name)}</span>
            </span>
            <span class="tree-meta">${folder.count} ảnh · ${escapeHtml(formatBytes(folder.bytes))}</span>
          </div>
        `);
        if (expanded) {
          walk(folder, depth + 1);
        }
      }
      for (const file of node.files) {
        const name = file.relativePath.split('/').pop();
        const inBuild = buildInfoFor(panel, file.url);
        const compressed = describeCompressed(file, state.estimates.get(file.url));
        lines.push(`
          <div class="tree-row tree-file ${state.selectedUrl === file.url ? 'selected' : ''}" data-url="${escapeHtml(file.url)}">
            <span class="tree-label" style="padding-left:${depth * 14 + 18}px">
              <input type="checkbox" class="tree-check" data-url="${escapeHtml(file.url)}" ${state.checked.has(file.url) ? 'checked' : ''}>
              <span class="tree-name" title="${escapeHtml(file.relativePath)}">${escapeHtml(name)}</span>
            </span>
            <span class="tree-kind">${escapeHtml(file.kind)}</span>
            <span class="tree-preset ${file.enabled && !file.presetMissing ? 'chip-on' : 'chip-off'}" title="${file.presetMissing ? escapeHtml(PRESET_MISSING_TITLE) : ''}">${escapeHtml(file.enabled ? (file.presetName || '(không rõ preset)') : 'chưa nén')}</span>
            <span class="tree-compressed ${escapeHtml(compressed.className)}" title="${escapeHtml(compressed.title)}">${escapeHtml(compressed.text)}</span>
            <span class="tree-build ${inBuild && inBuild.deltaBytes ? deltaClass(inBuild.deltaBytes) : ''}" title="${escapeHtml(inBuild ? BUILD_SIZE_TITLE : 'Không có trong bản build hiện tại')}">${inBuild ? escapeHtml(`${formatBytes(inBuild.bytes)}${inBuild.deltaBytes ? ` ${formatDelta(inBuild.deltaBytes)}` : ''}`) : (panel.state.buildSizeBySource ? '—' : '')}</span>
            <span class="tree-meta" title="${escapeHtml(SOURCE_SIZE_TITLE)}">${escapeHtml(formatBytes(file.bytes))}</span>
          </div>
        `);
      }
    };
    walk(state.tree, 0);
    // Vẽ lại không tự cuộn (giữ chỗ người dùng đang xem); cuộn tới ảnh đang chọn là việc của scrollToSelected.
    $.texTree.innerHTML = lines.join('');

    for (const element of $.texTree.querySelectorAll('.tree-check')) {
      // Thư mục tick một phần -> ô vuông mờ.
      element.indeterminate = element.dataset.state === 'some';
      element.addEventListener('change', (event) => {
        event.stopPropagation();
        const isChecked = !!event.target.checked;
        if (element.dataset.folder !== undefined) {
          const folder = findFolder(state.tree, element.dataset.folder);
          for (const url of folder ? collectFolderUrls(folder) : []) {
            if (isChecked) {
              state.checked.add(url);
            } else {
              state.checked.delete(url);
            }
          }
        } else if (isChecked) {
          state.checked.add(element.dataset.url);
        } else {
          state.checked.delete(element.dataset.url);
        }
        renderTree();
        renderSummary();
        scheduleEstimate();
      });
    }

    for (const element of $.texTree.querySelectorAll('.tree-folder')) {
      element.addEventListener('click', (event) => {
        if (event.target.classList.contains('tree-check')) {
          return;
        }
        const folderPath = element.dataset.folder;
        if (state.expanded.has(folderPath)) {
          state.expanded.delete(folderPath);
        } else {
          state.expanded.add(folderPath);
        }
        renderTree();
      });
    }

    for (const element of $.texTree.querySelectorAll('.tree-file')) {
      element.addEventListener('click', (event) => {
        if (event.target.classList.contains('tree-check')) {
          return;
        }
        selectUrl(element.dataset.url);
        $.texTree.focus({ preventScroll: true });
      });
      element.addEventListener('dblclick', (event) => {
        if (event.target.classList.contains('tree-check')) {
          return;
        }
        selectUrl(element.dataset.url);
        void revealSelected();
      });
    }
  };

  // ---------------------------------------------------------------- lưới ảnh thu nhỏ

  /** Nhãn trạng thái của một ảnh trong lưới (một nhãn, ưu tiên việc cần làm). */
  const tileStatus = (row, info, flags) => {
    const estimate = state.estimates.get(row.url);
    const ratio = (after, before) => (before > 0 ? Math.round(100 * (1 - after / before)) : 0);
    if (flags.duplicated.has(row.url)) {
      return { text: 'đóng gói 2 lần', className: 'warn', title: 'Đã ghép vào auto-atlas nhưng ảnh gốc vẫn vào build và không được nén' };
    }
    if (row.presetMissing) {
      return { text: 'preset đã xoá', className: 'warn', title: PRESET_MISSING_TITLE };
    }
    if (!row.enabled && (info || !panel.state.buildSizeBySource)) {
      return { text: 'chưa nén', className: 'warn', title: 'Chưa bật Texture Compress' };
    }
    if (estimate && !estimate.error && estimate.sourceBytes) {
      return { text: `≈ −${ratio(estimate.bytes, estimate.sourceBytes)}% với preset`, className: 'info', title: `Nén thử: ${formatBytes(estimate.sourceBytes)} → ${formatBytes(estimate.bytes)}` };
    }
    if (row.compressed && (row.compressed.stale || !row.compressed.matchesPreset)) {
      return { text: 'số liệu cũ', className: 'warn', title: 'Số liệu nén thuộc lần build trước / tuỳ chọn nén khác: build lại để cập nhật' };
    }
    if (row.compressed) {
      return { text: `đã nén −${ratio(row.compressed.bytes, row.compressed.sourceBytes)}%`, className: 'ok', title: `${formatBytes(row.compressed.sourceBytes)} → ${formatBytes(row.compressed.bytes)} (${row.presetName || 'preset'})` };
    }
    if (!info && panel.state.buildSizeBySource) {
      return { text: 'không vào build', className: 'muted', title: 'Ảnh này không có trong bản build hiện tại' };
    }
    return row.enabled
      ? { text: row.presetName ? `nén: ${row.presetName}` : 'đã bật nén', className: 'ok', title: 'Đã bật Texture Compress, chưa có số liệu nén: build một lần để biết dung lượng thật' }
      : { text: 'chưa nén', className: 'warn', title: 'Chưa bật Texture Compress' };
  };

  const renderGrid = () => {
    if (!state.scanned) {
      $.texGrid.classList.add('hidden');
      return;
    }
    $.texGrid.classList.remove('hidden');
    const flags = textureFlags(panel);
    const rows = visibleRows().sort((left, right) => {
      const leftInfo = buildInfoFor(panel, left.url);
      const rightInfo = buildInfoFor(panel, right.url);
      return ((rightInfo ? rightInfo.bytes : 0) - (leftInfo ? leftInfo.bytes : 0)) || (right.bytes - left.bytes);
    });
    if (!rows.length) {
      $.texGrid.innerHTML = '<div class="detail-note tree-empty">Không có ảnh nào khớp bộ lọc này.</div>';
      return;
    }
    $.texGrid.innerHTML = rows.map((row) => {
      const info = buildInfoFor(panel, row.url);
      const status = tileStatus(row, info, flags);
      const canThumb = thumbs.canThumb(row.fullPath, row.bytes);
      const name = row.relativePath.split('/').pop();
      // Luôn ghi rõ là số nào: trong build (số chính, lưới sắp theo nó) hay nguồn (không vào build / chưa có bản build).
      const size = info
        ? { text: `${formatBytes(info.bytes)} trong build`, title: `${BUILD_SIZE_TITLE}\nNguồn: ${formatBytes(row.bytes)}.` }
        : {
          text: `nguồn ${formatBytes(row.bytes)}`,
          title: panel.state.buildSizeBySource ? `Không có trong bản build hiện tại. ${SOURCE_SIZE_TITLE}.` : `Chưa có bản build. ${SOURCE_SIZE_TITLE}.`,
        };
      // Đã nén thử với preset đang chọn (ảnh đã tick): ghi luôn số ước tính, nhãn bên dưới vẫn ưu tiên việc cần làm.
      const estimate = state.estimates.get(row.url);
      const estimateLine = estimate && !estimate.error && estimate.sourceBytes && !status.className.includes('info')
        ? `<div class="img-est" title="Nén thử với preset đang chọn">≈ ${escapeHtml(formatBytes(estimate.bytes))} sau nén</div>`
        : '';
      return `
        <div class="img-tile ${state.selectedUrl === row.url ? 'selected' : ''} ${state.checked.has(row.url) ? 'checked' : ''}" data-url="${escapeHtml(row.url)}" title="${escapeHtml(row.relativePath)}">
          <div class="img-thumb">
            <input type="checkbox" class="tile-check" data-url="${escapeHtml(row.url)}" ${state.checked.has(row.url) ? 'checked' : ''}>
            ${canThumb
              ? `<img alt="" data-thumb="${escapeHtml(thumbs.key(row.fullPath, row.bytes))}">`
              : `<span class="img-kind">${escapeHtml(row.kind === 'auto-atlas' ? 'auto-atlas' : row.extension.replace('.', '').toUpperCase())}</span>`}
          </div>
          <div class="img-meta">
            <div class="img-name">${escapeHtml(name)}</div>
            <div class="img-size" title="${escapeHtml(size.title)}">${escapeHtml(size.text)}</div>
            ${estimateLine}
            <span class="img-badge ${status.className}" title="${escapeHtml(status.title)}">${escapeHtml(status.text)}</span>
          </div>
        </div>
      `;
    }).join('');

    thumbs.attach($.texGrid);
    for (const check of $.texGrid.querySelectorAll('.tile-check')) {
      check.addEventListener('click', (event) => event.stopPropagation());
      check.addEventListener('change', (event) => {
        const url = event.target.dataset.url;
        if (event.target.checked) {
          state.checked.add(url);
        } else {
          state.checked.delete(url);
        }
        event.target.closest('.img-tile').classList.toggle('checked', event.target.checked);
        renderSummary();
        scheduleEstimate();
      });
    }
    for (const tile of $.texGrid.querySelectorAll('.img-tile')) {
      tile.addEventListener('click', () => {
        selectUrl(tile.dataset.url);
        $.texGrid.focus({ preventScroll: true });
      });
      tile.addEventListener('dblclick', () => {
        selectUrl(tile.dataset.url);
        void revealSelected();
      });
    }
  };

  /**
   * Cuộn tới ảnh đang chọn. Chỉ khi người dùng đổi lựa chọn / bộ lọc / kiểu xem (bấm, phím, Việc nên làm);
   * vẽ lại nền (bản build mới, nén thử xong, phân tích lại) giữ nguyên chỗ người dùng đang cuộn tới.
   */
  const scrollToSelected = () => {
    const active = (state.view === 'grid' ? $.texGrid : $.texTree).querySelector('.selected');
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
  };

  /** Chỉ đổi đánh dấu dòng / ô đang chọn, không vẽ lại cả danh sách. `scroll`: người dùng vừa chọn. */
  const markSelected = ({ scroll = false } = {}) => {
    for (const element of [...$.texTree.querySelectorAll('.tree-file'), ...$.texGrid.querySelectorAll('.img-tile')]) {
      element.classList.toggle('selected', element.dataset.url === state.selectedUrl);
    }
    if (scroll) {
      scrollToSelected();
    }
  };

  const selectUrl = (url) => {
    state.selectedUrl = url;
    state.autoSelected = false;
    markSelected({ scroll: true });
    panel.renderDetail();
  };

  /** Các ảnh đang hiển thị theo đúng thứ tự trên màn hình (cây hoặc lưới). */
  const visibleFileUrls = () => (state.view === 'grid'
    ? [...$.texGrid.querySelectorAll('.img-tile')]
    : [...$.texTree.querySelectorAll('.tree-file')]).map((element) => element.dataset.url);

  /** Số cột của lưới (để ↑ ↓ nhảy đúng một hàng). */
  const gridColumns = () => {
    const tiles = [...$.texGrid.querySelectorAll('.img-tile')];
    if (tiles.length < 2) {
      return 1;
    }
    const top = tiles[0].offsetTop;
    const columns = tiles.findIndex((tile) => tile.offsetTop !== top);
    return columns < 0 ? tiles.length : columns;
  };

  const moveSelection = (direction) => {
    const urls = visibleFileUrls();
    if (!urls.length) {
      return;
    }
    const current = urls.indexOf(state.selectedUrl);
    const next = current < 0
      ? (direction > 0 ? 0 : urls.length - 1)
      : Math.max(0, Math.min(urls.length - 1, current + direction));
    selectUrl(urls[next]);
  };

  const toggleSelectedCheck = () => {
    if (!state.selectedUrl) {
      return;
    }
    if (state.checked.has(state.selectedUrl)) {
      state.checked.delete(state.selectedUrl);
    } else {
      state.checked.add(state.selectedUrl);
    }
    if (state.view === 'grid') {
      // Lưới: chỉ đổi ô đang chọn, không vẽ lại cả lưới (giữ vị trí cuộn và ảnh thu nhỏ).
      const tile = [...$.texGrid.querySelectorAll('.img-tile')].find((element) => element.dataset.url === state.selectedUrl);
      if (tile) {
        const on = state.checked.has(state.selectedUrl);
        tile.classList.toggle('checked', on);
        tile.querySelector('.tile-check').checked = on;
      }
      renderSummary();
    } else {
      refresh();
    }
    scheduleEstimate();
  };

  const revealSelected = async () => {
    if (!state.selectedUrl) {
      return;
    }
    await helpers.revealAsset({ url: state.selectedUrl });
  };

  /** Vẽ lại danh sách theo kiểu xem đang chọn (lưới hoặc cây), ẩn phần của kiểu kia. */
  const renderView = () => {
    const grid = state.view === 'grid';
    for (const button of $.texView.querySelectorAll('button')) {
      button.classList.toggle('active', button.dataset.view === state.view);
    }
    $.texTreeHead.classList.toggle('hidden', grid || !state.scanned);
    $.texExpandAll.classList.toggle('hidden', grid);
    $.texCollapseAll.classList.toggle('hidden', grid);
    if (grid) {
      $.texTree.classList.add('hidden');
      renderGrid();
    } else {
      $.texGrid.classList.add('hidden');
      renderTree();
    }
  };

  /**
   * Dựng lại cây theo bộ lọc rồi vẽ lại danh sách + chip lọc + thanh hành động. `scroll`: do người dùng
   * (đổi bộ lọc, Việc nên làm) thì cuộn tới ảnh đang chọn; index.js gọi refresh() khi vẽ lại nền thì không.
   */
  const refresh = ({ scroll = false } = {}) => {
    renderFilters();
    state.tree = buildTree(visibleRows());
    // Đang lọc thì mở hết thư mục để thấy ngay kết quả.
    if (state.filter !== 'all') {
      const walk = (node) => {
        for (const folder of node.folders.values()) {
          state.expanded.add(folder.path);
          walk(folder);
        }
      };
      walk(state.tree);
    }
    renderView();
    renderSummary();
    // Chưa chọn ảnh nào: chọn sẵn ảnh đầu tiên để khung Chi tiết không trống. Ảnh do tool tự chọn thì
    // luôn đi theo đầu danh sách (thứ tự đổi khi số liệu build tới sau), người dùng đã chọn thì giữ.
    const urls = visibleFileUrls();
    const first = !state.selectedUrl || (state.autoSelected && urls[0] !== state.selectedUrl) ? urls[0] : '';
    if (first && first !== state.selectedUrl) {
      state.selectedUrl = first;
      state.autoSelected = true;
      markSelected();
      if (panel.state.step === 'optimize' && panel.state.optimizeKind === 'texture') {
        panel.renderDetail();
      }
    }
    if (scroll) {
      scrollToSelected();
    }
  };
  state.refresh = refresh;

  // `silent`: quét lại sau khi ghi meta, không ghi đè dòng status đang báo kết quả.
  const scan = async ({ keepIssues = false, silent = false } = {}) => {
    if (state.busy) {
      return;
    }
    setBusy(true);
    if (!keepIssues) {
      showIssues([]);
    }
    if (!silent) {
      setStatus('Đang quét ảnh nguồn...');
    }
    try {
      const result = await Editor.Message.request(PACKAGE_NAME, 'texture-scan-all');
      if (!result || !result.ok) {
        throw new Error((result && result.error) || 'Quét thất bại.');
      }
      state.rows = result.rows;
      state.scanned = true;
      fillPresets(result.presets);
      // Giữ lại lựa chọn cũ cho asset còn tồn tại; lần đầu thì mở sẵn thư mục gốc.
      const alive = new Set(state.rows.map((row) => row.url));
      for (const url of [...state.checked]) {
        if (!alive.has(url)) {
          state.checked.delete(url);
        }
      }
      if (!state.expanded.size) {
        for (const folder of buildTree(state.rows).folders.values()) {
          state.expanded.add(folder.path);
        }
      }
      if (state.selectedUrl && !alive.has(state.selectedUrl)) {
        state.selectedUrl = '';
      }
      const selectedBefore = state.selectedUrl;
      refresh();
      // Chỉ vẽ lại khung Chi tiết khi đang mở đúng tab này (đang ở tab Âm thanh thì sẽ reset đoạn cắt);
      // refresh() vừa tự chọn ảnh đầu tiên thì đã vẽ rồi.
      if (panel.state.step === 'optimize' && panel.state.optimizeKind === 'texture' && state.selectedUrl === selectedBefore) {
        panel.renderDetail();
      }
      if (panel.onSourcesScanned) {
        panel.onSourcesScanned();
      }
      if (!state.presets.length) {
        showIssues([{ level: 'info', message: 'Project chưa có preset nén nào. Tạo trong Project Settings → Texture Compress rồi bấm ↻ cạnh ô Preset.' }]);
      }
      if (!silent) {
        setStatus(`Quét ảnh nguồn xong: ${state.rows.length} file.`);
      }
    } catch (error) {
      showIssues([{ level: 'error', message: error.message || String(error) }]);
      setStatus(error.message || String(error));
    } finally {
      setBusy(false);
    }
  };
  state.scan = scan;

  /** Tick / đổi preset xong một nhịp thì tự nén thử phần chưa có số (không cần bấm nút). */
  let estimateTimer = null;
  const scheduleEstimate = () => {
    clearTimeout(estimateTimer);
    estimateTimer = setTimeout(() => { void estimate(); }, ESTIMATE_DELAY);
  };

  /**
   * Nén thử phần đã tick với preset đang chọn bằng đúng thư viện của Editor, để biết trước
   * dung lượng sau nén. Chỉ nén những ảnh chưa có số cho preset này.
   */
  const estimate = async () => {
    const presetId = $.texPreset.value;
    if (!presetId || presetUnconfigured()) {
      renderSummary();
      return;
    }
    if (state.estimating) {
      scheduleEstimate();
      return;
    }
    // Đổi preset thì số cũ không còn ý nghĩa.
    if (state.estimatePreset !== presetId) {
      state.estimates = new Map();
      state.estimatePreset = presetId;
    }
    const refs = checkedRows()
      .filter((row) => row.kind !== 'auto-atlas' && !state.estimates.has(row.url))
      .map((row) => row.url);
    if (!refs.length) {
      renderSummary();
      return;
    }

    state.estimating = true;
    renderSummary();
    try {
      const result = await Editor.Message.request(PACKAGE_NAME, 'texture-estimate', { refs, presetId });
      if (!result || !result.ok) {
        throw new Error((result && result.error) || 'Nén thử thất bại.');
      }
      if (state.estimatePreset === presetId) {
        for (const [url, value] of Object.entries(result.estimates || {})) {
          state.estimates.set(url, value);
        }
      }
      if (!result.exact) {
        showIssues([{ level: 'info', message: 'Không nạp được thư viện nén của Editor nên số ước tính chỉ xấp xỉ.' }]);
      }
    } catch (error) {
      showIssues([{ level: 'error', message: `Nén thử thất bại: ${error.message || String(error)}` }]);
    } finally {
      state.estimating = false;
      renderView();
      renderSummary();
    }
  };

  const apply = async (mode) => {
    if (state.busy) {
      return;
    }
    const rows = checkedRows();
    if (!rows.length) {
      showIssues([{ level: 'info', message: 'Hãy tick ít nhất một ảnh (hoặc một thư mục) trong cây.' }]);
      return;
    }
    const presetId = $.texPreset.value;
    if (mode === 'enable' && !presetId) {
      showIssues([{ level: 'error', message: 'Chưa có preset. Tạo trong Project Settings → Texture Compress rồi bấm ↻.' }]);
      return;
    }
    if (mode === 'enable' && presetUnconfigured()) {
      showIssues([{ level: 'error', message: `${UNCONFIGURED_HINT} rồi bấm ↻.` }]);
      return;
    }
    const refs = rows.map((row) => row.url);
    const preset = state.presets.find((item) => item.id === presetId);
    const changing = rows.filter((row) => (mode === 'disable' ? row.enabled : !(row.enabled && row.presetId === presetId))).length;
    if (!changing) {
      showIssues([{ level: 'info', message: mode === 'disable' ? 'Các ảnh đã tick đều chưa bật nén.' : `Các ảnh đã tick đều đang dùng preset "${preset ? preset.name : presetId}".` }]);
      return;
    }
    const message = mode === 'disable'
      ? `Tắt nén cho ${changing} ảnh?`
      : `Bật nén với preset "${preset ? preset.name : presetId}" cho ${changing} ảnh?\nẢnh đang dùng preset khác sẽ được đổi sang preset này.`;
    if (!window.confirm(message)) {
      return;
    }

    persist();
    setBusy(true);
    showIssues([]);
    setStatus(mode === 'disable' ? 'Đang tắt nén...' : 'Đang bật nén...');
    try {
      const result = await Editor.Message.request(PACKAGE_NAME, 'texture-apply-assets', { refs, mode, presetId });
      if (!result || !result.ok) {
        throw new Error((result && result.error) || 'Áp dụng thất bại.');
      }
      const issues = [{
        level: 'info',
        message: `${mode === 'disable' ? 'Đã tắt nén' : 'Đã bật nén'} ${result.updated} ảnh${result.failed.length ? `, ${result.failed.length} lỗi` : ''}.`
          + ' Texture Compress chỉ chạy lúc build: build lại là tool tự phân tích và hiện chênh lệch thật.',
      }];
      for (const failure of result.failed) {
        issues.push({ level: 'error', message: failure });
      }
      showIssues(issues);
      helpers.offerUndo(result.historyId, `${mode === 'disable' ? 'Đã tắt nén' : 'Đã bật nén'} ${result.updated} ảnh. Build lại để thấy hiệu quả.`);
      setBusy(false);
      await scan({ keepIssues: true, silent: true });
    } catch (error) {
      showIssues([{ level: 'error', message: error.message || String(error) }]);
      setStatus(error.message || String(error));
    } finally {
      setBusy(false);
    }
  };

  /** Từ "Việc nên làm": tick đúng các ảnh này, mở sẵn thư mục chứa chúng, chọn ảnh đầu tiên. */
  state.selectOnly = (urls) => {
    const wanted = new Set(urls);
    const rows = state.rows.filter((row) => wanted.has(row.url));
    state.filter = 'all';
    state.checked = new Set(rows.map((row) => row.url));
    for (const row of rows) {
      const parts = row.relativePath.split('/').slice(0, -1);
      for (let index = 1; index <= parts.length; index += 1) {
        state.expanded.add(parts.slice(0, index).join('/'));
      }
    }
    state.selectedUrl = rows[0] ? rows[0].url : state.selectedUrl;
    state.autoSelected = false;
    refresh({ scroll: true });
    panel.renderDetail();
    scheduleEstimate();
    setStatus(`Đã tick ${rows.length} ảnh. Thanh nén phía trên cho biết dung lượng ước tính sau nén.`);
  };

  const setAllChecked = (checked) => {
    if (checked) {
      for (const row of visibleRows()) {
        state.checked.add(row.url);
      }
    } else {
      state.checked = new Set();
    }
    refresh();
    scheduleEstimate();
  };

  const setAllExpanded = (expanded) => {
    state.expanded = new Set();
    if (expanded) {
      const walk = (node) => {
        for (const folder of node.folders.values()) {
          state.expanded.add(folder.path);
          walk(folder);
        }
      };
      walk(state.tree);
    }
    renderTree();
  };

  // --- wire ---
  renderSummary();

  // ↑↓ (và ← → ở lưới) duyệt ảnh, Space tick/bỏ tick, Enter highlight asset trong panel Assets.
  const onKey = (event) => {
    const steps = state.view === 'grid'
      ? { ArrowRight: 1, ArrowLeft: -1, ArrowDown: gridColumns(), ArrowUp: -gridColumns() }
      : { ArrowDown: 1, ArrowUp: -1 };
    if (steps[event.key]) {
      event.preventDefault();
      moveSelection(steps[event.key]);
      return;
    }
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      toggleSelectedCheck();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      void revealSelected();
    }
  };
  for (const list of [$.texTree, $.texGrid]) {
    list.tabIndex = 0;
    list.addEventListener('keydown', onKey);
  }
  for (const button of $.texView.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      if (state.view === button.dataset.view) {
        return;
      }
      state.view = button.dataset.view;
      persist();
      renderView();
      markSelected({ scroll: true });
    });
  }

  onAction($.texHelpToggle, () => {
    const open = $.texHelp.classList.contains('hidden');
    $.texHelp.classList.toggle('hidden', !open);
    $.texHelpToggle.classList.toggle('active', open);
  });
  onAction($.texApply, () => { void apply('enable'); });
  onAction($.texDisable, () => { void apply('disable'); });
  onAction($.texSelectAll, () => setAllChecked(true));
  onAction($.texSelectNone, () => setAllChecked(false));
  onAction($.texExpandAll, () => setAllExpanded(true));
  onAction($.texCollapseAll, () => setAllExpanded(false));
  onAction($.texReloadPresets, () => {
    void Editor.Message.request(PACKAGE_NAME, 'texture-list-presets')
      .then((result) => {
        fillPresets(result && result.presets);
        setStatus(`Đã đọc lại ${state.presets.length} preset.`);
      })
      .catch(() => {});
  });
  $.texPreset.addEventListener('change', () => {
    updatePresetHint();
    persist();
    // Số ước tính gắn với preset cũ: bỏ ngay để cột "Sau nén" không hiện số sai.
    state.estimates = new Map();
    state.estimatePreset = $.texPreset.value;
    renderView();
    scheduleEstimate();
  });
}

// ---------------------------------------------------------------- detail pane của tab này

function renderDetail(panel, helpers) {
  const { escapeHtml } = helpers;
  const state = panel.state.texture;
  if (!state || !state.scanned) {
    panel.$.detail.className = 'detail empty';
    panel.$.detail.textContent = 'Chưa quét ảnh nguồn. Bấm Phân tích.';
    return;
  }
  const row = state.rows.find((item) => item.url === state.selectedUrl);
  if (!row) {
    panel.$.detail.className = 'detail empty';
    panel.$.detail.textContent = 'Chọn một ảnh để xem trước và nén riêng ảnh đó.';
    return;
  }

  panel.$.detail.className = 'detail';
  panel.$.detail.innerHTML = `
    <div class="detail-body">
      ${preview.renderStage({ id: 'detail-source-preview', filePath: row.fullPath, title: 'Xem trước', escapeHtml })}
      <div class="built-file-compact">
        <div class="detail-title">Ảnh nguồn</div>
        <div class="built-file-path" title="${escapeHtml(row.url)}">${escapeHtml(row.relativePath)}</div>
        <div class="built-file-chips" id="detail-source-chips">
          <span>nguồn ${escapeHtml(formatBytes(row.bytes))}</span>
          <span>${escapeHtml(row.kind)}</span>
          ${renderCompressedChip(row, escapeHtml)}
          ${renderBuildChip(panel, row.url, helpers)}
        </div>
      </div>
      ${renderSourceBox({ source: row.url, category: 'texture' }, helpers)}
    </div>
  `;

  void preview.loadPreview(panel.$.detail, { id: 'detail-source-preview', filePath: row.fullPath, extension: row.extension, escapeHtml });
  void loadImageChips(panel, row, helpers);
  void loadSourceBox(panel, { source: row.url, category: 'texture' }, helpers, {
    onApplied: (assetState) => {
      const enabled = !!(assetState && assetState.enabled);
      // Giống kết quả quét: ảnh tắt nén không có preset và không có số "Sau nén" (cache cũ của Cocos).
      row.enabled = enabled;
      row.presetId = enabled ? assetState.presetId : '';
      row.presetName = enabled ? assetState.presetName : '';
      row.presetMissing = !!(assetState && assetState.presetMissing);
      if (!enabled) {
        row.compressed = null;
      }
      if (state.refresh) {
        state.refresh();
      }
    },
  });
}

/** Chip "sau nén X (−N%)" — số liệu nén thật của Cocos, không cần build lại. */
function renderCompressedChip(row, escapeHtml) {
  const info = row.compressed;
  if (!info) {
    return row.enabled
      ? '<span class="chip-off" title="Bật preset rồi Build (hoặc Compress) một lần để Cocos sinh số liệu.">chưa có số liệu nén</span>'
      : '';
  }
  const ratio = info.sourceBytes > 0 ? Math.round(100 * (1 - info.bytes / info.sourceBytes)) : 0;
  const warn = info.stale || !info.matchesPreset;
  const note = info.stale
    ? ' (ảnh đã sửa sau lần nén)'
    : (!info.matchesPreset ? ` (tuỳ chọn nén ${info.optionsLabel}, khác preset đang gán)` : '');
  return `<span class="${warn ? 'chip-off' : 'chip-on'}">sau nén ${escapeHtml(`${formatBytes(info.bytes)}${ratio > 0 ? ` −${ratio}%` : ''}${note}`)}</span>`;
}

/** Chip "trong build X (Δ)" — dữ liệu từ lần phân tích build gần nhất. */
function renderBuildChip(panel, url, helpers) {
  const { escapeHtml, formatDelta, deltaClass } = helpers;
  const info = buildInfoFor(panel, url);
  if (!info) {
    return panel.state.buildFileCount
      ? '<span>không thấy trong build</span>'
      : '<span>chưa có bản build</span>';
  }
  const delta = info.deltaBytes ? ` ${formatDelta(info.deltaBytes)}` : '';
  return `<span class="${deltaClass(info.deltaBytes)}">trong build ${escapeHtml(formatBytes(info.bytes) + delta)}</span>`;
}

async function loadImageChips(panel, row, helpers) {
  const { escapeHtml } = helpers;
  // Lấy khung chip trước khi chờ: khung Chi tiết vẽ lại giữa chừng thì bỏ, không gắn chip hai lần.
  const chips = panel.$.detail.querySelector('#detail-source-chips');
  const meta = await readImageMeta(row.fullPath, row.extension);
  if (!chips || !chips.isConnected || !meta) {
    return;
  }
  const labels = [];
  if (meta.width > 0 && meta.height > 0) {
    labels.push(`${meta.width} x ${meta.height}`);
  }
  labels.push(meta.hasAlpha ? 'có alpha' : 'không alpha');
  if (meta.formatLabel) {
    labels.push(meta.formatLabel);
  }
  chips.insertAdjacentHTML('beforeend', `<span>${escapeHtml(labels.join(' | '))}</span>`);
}

// ---------------------------------------------------------------- khung "Nén ảnh này" (dùng chung với bước Tìm chỗ nặng)

/** HTML placeholder; nội dung thật được nạp bất đồng bộ bởi loadSourceBox. */
function renderSourceBox(entry, helpers) {
  const { escapeHtml } = helpers;
  const sourceUrl = String(entry.source || '').split('@')[0];
  if (entry.category !== 'texture' || !sourceUrl) {
    return '';
  }
  return `
    <div id="detail-source-box" class="detail-block source-box" data-source-url="${escapeHtml(sourceUrl)}">
      <div class="detail-title">Nén ảnh này (Texture Compress)</div>
      <div class="detail-note">Đang đọc meta nguồn...</div>
    </div>
  `;
}

async function loadSourceBox(panel, entry, helpers, options = {}) {
  const sourceUrl = String(entry.source || '').split('@')[0];
  const box = panel.$.detail.querySelector('#detail-source-box');
  if (!box || box.dataset.sourceUrl !== sourceUrl) {
    return;
  }
  const result = await Editor.Message.request(PACKAGE_NAME, 'texture-asset-state', { url: sourceUrl })
    .catch((error) => ({ ok: false, error: error.message }));
  renderSourceState(panel, entry, result, helpers, '', options);
}

function renderSourceState(panel, entry, result, helpers, note = '', options = {}) {
  const { escapeHtml, setStatus } = helpers;
  const sourceUrl = String(entry.source || '').split('@')[0];
  const box = panel.$.detail.querySelector('#detail-source-box');
  if (!box || box.dataset.sourceUrl !== sourceUrl) {
    return;
  }

  if (!result || !result.ok) {
    box.innerHTML = `
      <div class="detail-title">Nén ảnh này (Texture Compress)</div>
      <div class="detail-note error">${escapeHtml((result && result.error) || 'Không đọc được meta nguồn.')}</div>
    `;
    return;
  }

  const state = result.state;
  if (!state.compressible) {
    box.innerHTML = `
      <div class="detail-title">Nén ảnh này (Texture Compress)</div>
      <div class="detail-note">Kiểu import "${escapeHtml(state.type || state.importer || '?')}" không hỗ trợ Texture Compress.</div>
    `;
    return;
  }

  const presets = state.presets || [];
  const fallback = defaultPreset(presets);
  const selected = state.presetId && presets.some((preset) => preset.id === state.presetId)
    ? state.presetId
    : (fallback ? fallback.id : '');
  // presetName đã là "(preset đã xoá)" khi preset của ảnh không còn trong Project Settings.
  const stateChip = state.enabled
    ? `<span class="${state.presetMissing ? 'chip-off' : 'chip-on'}" title="${state.presetMissing ? escapeHtml(PRESET_MISSING_TITLE) : ''}">đang nén: ${escapeHtml(state.presetName || '(không rõ preset)')}</span>`
    : '<span class="chip-off">chưa nén</span>';
  box.innerHTML = `
    <div class="detail-title">Nén ảnh này (Texture Compress)</div>
    <div class="built-file-chips">
      <span>kiểu ${escapeHtml(state.type)}</span>
      ${stateChip}
    </div>
    <div class="source-controls">
      <select id="detail-tex-preset" ${presets.length ? '' : 'disabled'}>
        ${presets.length
          ? presets.map((preset) => `<option value="${escapeHtml(preset.id)}" ${preset.id === selected ? 'selected' : ''}>${escapeHtml(presetOptionLabel(preset, true))}</option>`).join('')
          : '<option value="">(chưa có preset)</option>'}
      </select>
      <button id="detail-tex-apply" class="action-button">Áp preset</button>
      <button id="detail-tex-disable" class="action-button secondary" ${state.enabled ? '' : 'disabled'}>Tắt nén</button>
    </div>
    <div class="detail-note">${escapeHtml(note || 'Ghi vào .meta của ảnh nguồn. Build lại để thấy hiệu quả (tool tự phân tích lại).')}</div>
  `;

  // Preset chưa cấu hình định dạng thì không cho áp (meta sẽ ghi "đang nén" mà Cocos không nén gì).
  const presetSelect = box.querySelector('#detail-tex-preset');
  const applyButton = box.querySelector('#detail-tex-apply');
  const syncApply = () => {
    const preset = presets.find((item) => item.id === presetSelect.value);
    applyButton.disabled = !preset || preset.unconfigured;
    applyButton.title = preset && preset.unconfigured ? `${UNCONFIGURED_HINT} trước.` : '';
  };
  presetSelect.addEventListener('change', syncApply);
  syncApply();

  const run = async (mode) => {
    const presetId = String(presetSelect.value || '');
    for (const button of box.querySelectorAll('button')) {
      button.disabled = true;
    }
    setStatus(mode === 'disable' ? `Đang tắt nén ${sourceUrl}...` : `Đang áp preset cho ${sourceUrl}...`);
    const response = await Editor.Message.request(PACKAGE_NAME, 'texture-apply-assets', { refs: [sourceUrl], mode, presetId })
      .catch((error) => ({ ok: false, error: error.message }));
    // Chỉ một asset: lỗi của nó nằm trong `failed` (ok vẫn true), nên cũng tính là thất bại.
    const failure = response && response.ok && Array.isArray(response.failed) ? response.failed.join('\n') : '';
    if (!response || !response.ok || failure) {
      const error = failure || (response && response.error) || '';
      renderSourceState(panel, entry, { ok: true, state }, helpers, '', options);
      const current = panel.$.detail.querySelector('#detail-source-box');
      if (current) {
        current.insertAdjacentHTML('beforeend', `<div class="detail-note error">${escapeHtml(error || 'Thất bại.')}</div>`);
      }
      setStatus(error || 'Cập nhật meta thất bại.');
      return;
    }
    const doneNote = response.updated
      ? `Đã ghi meta${response.viaAssetDb ? ' qua asset-db' : ' trực tiếp'}. Build lại để thấy hiệu quả (tool tự phân tích lại).`
      : 'Không có gì thay đổi (đã ở trạng thái này).';
    const reread = await Editor.Message.request(PACKAGE_NAME, 'texture-asset-state', { url: sourceUrl })
      .catch(() => null);
    const nextState = reread && reread.ok ? reread.state : state;
    renderSourceState(panel, entry, { ok: true, state: nextState }, helpers, doneNote, options);
    if (typeof options.onApplied === 'function') {
      options.onApplied(nextState);
    }
    helpers.offerUndo(response.historyId, `${sourceUrl}: ${doneNote}`);
  };

  applyButton.addEventListener('click', () => { void run('enable'); });
  box.querySelector('#detail-tex-disable').addEventListener('click', () => { void run('disable'); });
}

module.exports = {
  SELECTORS,
  setup,
  renderDetail,
  renderSourceBox,
  loadSourceBox,
};
