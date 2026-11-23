'use strict';

/**
 * Bước Tối ưu → Module engine: module tuỳ chọn của Project Settings → Feature Cropping đang bật
 * hay tắt, có thấy dùng trong assets/ không (kèm bằng chứng), bật / tắt ngay tại đây. Ghi qua
 * main.js (engine-modules-apply, đúng như Feature Cropping ghi), hoàn tác được trong Lịch sử.
 * Mã engine chỉ đổi khi build lại: build xong tool tự phân tích và cho thấy giảm bao nhiêu.
 */

const { formatBytes } = require('../../lib/build-scan');
const { POST_PROCESS, moduleBuildShare, moduleCodeZip } = require('../../lib/engine-modules');

const PACKAGE_NAME = 'playable-size-inspector';

const SELECTORS = {
  panelEngine: '#panel-engine',
  engList: '#eng-list',
  engSummary: '#eng-summary',
  engSuggest: '#eng-suggest',
  engReset: '#eng-reset',
  engApply: '#eng-apply',
  engShowAll: '#eng-show-all',
  engOpenSettings: '#eng-open-settings',
  engIssues: '#eng-issues',
  engHelp: '#eng-help',
  engHelpToggle: '#eng-help-toggle',
};

/** Trạng thái hiển thị của một module (một nhãn). */
function moduleStatus(entry) {
  if (entry.enabled && !entry.used) {
    return { text: 'không thấy dùng', className: 'warn', title: 'Không có component, script hay file nào trong assets/ dùng tới: tắt được để giảm build' };
  }
  if (entry.enabled) {
    return { text: 'đang dùng', className: 'ok', title: entry.usedBy.slice(0, 6).join('\n') };
  }
  if (entry.inScenes) {
    return { text: 'đang tắt nhưng scene / prefab dùng', className: 'error', title: `Scene / prefab có component của module này mà module đang tắt: component đó sẽ lỗi khi chạy. Kiểm tra lại.\n${entry.usedBy.slice(0, 6).join('\n')}` };
  }
  if (entry.notShipped) {
    return { text: 'đang tắt · chỉ asset không vào build dùng', className: 'muted', title: `Scene / prefab / model có component của module này nhưng không vào bản build nào (asset thừa hoặc bản build cũ). Đưa asset đó vào build thì phải bật module.\n${entry.usedBy.slice(0, 6).join('\n')}` };
  }
  if (entry.used) {
    return { text: 'đang tắt · script có nhắc tới', className: 'muted', title: `Chỉ thấy chữ trong script (có thể là code mẫu không chạy tới). Nếu code đó có chạy thì cần bật module.\n${entry.usedBy.slice(0, 6).join('\n')}` };
  }
  return { text: 'đang tắt', className: 'muted', title: '' };
}

/**
 * File trong build thuộc riêng module này: { rows, bytes, estimated, note }. Cùng hàm với "Việc nên làm" và thẻ
 * Module engine ở Tổng quan (engine-modules.moduleBuildShare) nên ba nơi ra cùng một số.
 */
function buildFilesFor(panel, entry) {
  const share = moduleBuildShare(entry.key, panel.state.assetRows || []);
  // Post Process: pack internal chứa cả shader khác, chỉ tính phần của các effect post-process.
  const note = entry.key === POST_PROCESS && share.rows.length
    ? `${share.effects} effect post-process nằm chung pack internal (pack ${formatBytes(share.packBytes)}, phần của post-process ≈ ${formatBytes(share.bytes)}); tắt module thì các effect này không vào build nữa.`
    : '';
  return { rows: share.rows, bytes: share.bytes, estimated: share.estimated, note };
}

/**
 * Cột dung lượng của tab này là PHẦN của module trong bản build web-mobile (byte thật, chưa zip, cùng đơn vị với
 * tab Ảnh / Tổng quan): file engine riêng của module, hoặc phần ước tính (≈) khi nằm chung pack. Không có số thì để trống.
 */
/**
 * Module không có file riêng trong build (profiler, mask, primitive...): phần mã engine bỏ được khi tắt, byte sau zip
 * đo trên engine 3.8.8 (engine-modules.moduleCodeZip, cùng số với Việc nên làm). Chỉ hiện cho module đang bật.
 */
function codeZipCell(entry, escapeHtml) {
  const zip = entry.enabled ? moduleCodeZip(entry.key) : 0;
  return zip ? `${escapeHtml(`≈ ${formatBytes(zip)}`)}<small>mã engine</small>` : '';
}

function codeTitle(entry) {
  return entry.enabled && moduleCodeZip(entry.key)
    ? 'Phần mã engine của module này (nằm trong file engine chung, không tách file riêng), byte sau zip đo trên engine 3.8.8; bản Cocos khác lệch chút ít. Tắt module thì phần này không vào build.'
    : '';
}

function sizeTitle(files) {
  if (!files.bytes) {
    return '';
  }
  if (files.note) {
    return `Phần của module này trong bản build web-mobile (chưa zip). ${files.note}`;
  }
  const names = files.rows.map((row) => row.relativePath.split('/').pop());
  return `File engine riêng của module này trong bản build web-mobile (chưa zip): ${names.slice(0, 4).join(', ')}${names.length > 4 ? '...' : ''}. Tắt module thì các file này không vào build nữa.`;
}

function setup(panel, helpers) {
  const $ = panel.$;
  const { escapeHtml, setStatus, onAction } = helpers;
  const state = {
    scanned: false,
    ok: true,
    reason: '',
    entries: [],
    /** key -> trạng thái muốn đổi sang (true = bật); chưa áp dụng. */
    pending: new Map(),
    selectedKey: '',
    /** Mặc định hiện mọi module (cả module đang tắt). */
    showAll: true,
    busy: false,
  };
  panel.state.engine = state;

  const targetOf = (entry) => (state.pending.has(entry.key) ? state.pending.get(entry.key) : entry.enabled);

  /** Đáng tắt trước, rồi tới đang tắt mà scene / prefab dùng (cảnh báo), đang dùng, đang tắt. */
  const visibleEntries = () => {
    const rank = (entry) => (entry.enabled && !entry.used ? 0 : !entry.enabled && entry.inScenes ? 1 : entry.enabled ? 2 : 3);
    return state.entries
      .filter((entry) => state.showAll || entry.enabled || entry.used || state.pending.has(entry.key))
      .sort((left, right) => rank(left) - rank(right));
  };

  const showIssues = (issues) => {
    $.engIssues.classList.toggle('hidden', !issues.length);
    $.engIssues.innerHTML = issues.map((issue) => `<div class="issue ${escapeHtml(issue.level || 'info')}">${escapeHtml(issue.message)}</div>`).join('');
  };

  const renderSummary = () => {
    const changes = state.entries.filter((entry) => state.pending.has(entry.key) && state.pending.get(entry.key) !== entry.enabled);
    const unused = state.entries.filter((entry) => entry.enabled && !entry.used);
    $.engApply.disabled = state.busy || !changes.length;
    $.engReset.classList.toggle('hidden', !changes.length);
    $.engSuggest.classList.toggle('hidden', !unused.some((entry) => !state.pending.has(entry.key)));
    $.engApply.textContent = changes.length ? `Áp dụng ${changes.length} thay đổi` : 'Áp dụng';
    if (!state.scanned) {
      $.engSummary.textContent = 'Đang đọc cấu hình module...';
      return;
    }
    if (!state.ok) {
      $.engSummary.textContent = 'Chưa đọc được cấu hình module của dự án.';
      return;
    }
    if (changes.length) {
      const off = changes.filter((entry) => !state.pending.get(entry.key)).map((entry) => entry.label);
      const on = changes.filter((entry) => state.pending.get(entry.key)).map((entry) => entry.label);
      $.engSummary.innerHTML = [off.length ? `Sẽ tắt: <b>${escapeHtml(off.join(', '))}</b>` : '', on.length ? `Sẽ bật: <b>${escapeHtml(on.join(', '))}</b>` : '']
        .filter(Boolean).join(' · ');
      return;
    }
    const enabled = state.entries.filter((entry) => entry.enabled).length;
    $.engSummary.innerHTML = `<b>${enabled} module tuỳ chọn đang bật</b>`
      + (unused.length ? ` · <span class="warn">${unused.length} không thấy dùng</span>` : ' · <span class="muted">đều thấy dùng</span>');
  };

  const render = () => {
    renderSummary();
    if (!state.scanned) {
      $.engList.innerHTML = '';
      return;
    }
    if (!state.ok) {
      $.engList.innerHTML = '';
      return;
    }
    const entries = visibleEntries();
    if (!state.selectedKey || !entries.some((entry) => entry.key === state.selectedKey)) {
      state.selectedKey = entries[0] ? entries[0].key : '';
    }
    $.engList.innerHTML = entries.length ? entries.map((entry) => {
      const status = moduleStatus(entry);
      const target = targetOf(entry);
      const changed = target !== entry.enabled;
      const files = buildFilesFor(panel, entry);
      const bytes = files.bytes || 0;
      const sub = entry.used ? entry.usedBy[0] + (entry.usedBy.length > 1 ? ` (+${entry.usedBy.length - 1} chỗ khác)` : '') : entry.about;
      return `
        <div class="eng-row ${entry.key === state.selectedKey ? 'selected' : ''} ${changed ? 'changed' : ''}" data-key="${escapeHtml(entry.key)}">
          <label class="switch" title="${escapeHtml(entry.blocked || (target ? 'Đang bật: bấm để tắt' : 'Đang tắt: bấm để bật'))}">
            <input type="checkbox" class="eng-toggle" data-key="${escapeHtml(entry.key)}" ${target ? 'checked' : ''} ${entry.blocked ? 'disabled' : ''}><span></span>
          </label>
          <div class="eng-main">
            <div class="eng-name">${escapeHtml(entry.label)}${entry.ids.length ? `<span class="eng-ids">${escapeHtml(entry.ids.join(', '))}</span>` : ''}</div>
            <div class="eng-sub" title="${escapeHtml(sub)}">${escapeHtml(sub)}</div>
          </div>
          <span class="eng-size" title="${escapeHtml(sizeTitle(files) || codeTitle(entry))}">${bytes ? `${escapeHtml(`${files.estimated ? '≈ ' : ''}${formatBytes(bytes)}`)}<small>trong build</small>` : codeZipCell(entry, escapeHtml)}</span>
          <span class="eng-state">
            ${changed ? `<span class="img-badge info">sẽ ${target ? 'bật' : 'tắt'}</span>` : `<span class="img-badge ${status.className}" title="${escapeHtml(status.title)}">${escapeHtml(status.text)}</span>`}
          </span>
        </div>
      `;
    }).join('') : '<div class="detail-note tree-empty">Không có module tuỳ chọn nào đang bật. Tick "Hiện cả module đang tắt" để xem hết.</div>';

    for (const toggle of $.engList.querySelectorAll('.eng-toggle')) {
      toggle.addEventListener('click', (event) => event.stopPropagation());
      toggle.addEventListener('change', () => setTarget(toggle.dataset.key, toggle.checked));
    }
    for (const row of $.engList.querySelectorAll('.eng-row')) {
      row.addEventListener('click', () => {
        select(row.dataset.key);
        $.engList.focus({ preventScroll: true });
      });
    }
  };
  state.refresh = render;

  /** Cuộn tới module đang chọn: chỉ khi người dùng đổi lựa chọn (phím, Việc nên làm), không khi vẽ lại nền. */
  const scrollToSelected = () => {
    const row = $.engList.querySelector('.eng-row.selected');
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  };

  const select = (key) => {
    state.selectedKey = key;
    for (const row of $.engList.querySelectorAll('.eng-row')) {
      row.classList.toggle('selected', row.dataset.key === key);
    }
    panel.renderDetail();
  };

  const setTarget = (key, enable) => {
    const entry = state.entries.find((item) => item.key === key);
    if (!entry || entry.blocked) {
      return;
    }
    if (enable === entry.enabled) {
      state.pending.delete(key);
    } else {
      state.pending.set(key, enable);
    }
    state.selectedKey = key;
    render();
    panel.renderDetail();
  };

  const scan = async ({ silent = false } = {}) => {
    if (!silent) {
      setStatus('Đang đọc cấu hình module engine...');
    }
    const result = await Editor.Message.request(PACKAGE_NAME, 'engine-modules-scan').catch((error) => ({ ok: false, error: error.message }));
    state.scanned = true;
    if (!result || result.ok === false) {
      state.ok = false;
      state.entries = [];
      showIssues([{
        level: result && result.reason === 'no-config' ? 'info' : 'error',
        message: result && result.reason === 'no-config'
          ? 'Dự án chưa lưu cấu hình Feature Cropping (đang dùng mặc định của Cocos). Mở Feature Cropping, đổi một mục bất kỳ rồi đổi lại để Cocos tạo cấu hình, sau đó bấm Phân tích lại.'
          : `Không đọc được cấu hình module: ${(result && result.error) || 'không rõ lỗi'}`,
      }]);
    } else {
      state.ok = true;
      state.entries = result.entries || [];
      // Cocos 3.6 / 3.7: Feature Cropping định dạng cũ, tool chỉ đọc (mọi công tắc khoá, lý do ở tooltip).
      showIssues(result.legacy ? [{
        level: 'info',
        message: `Cocos ${(result.caps && result.caps.version) || 'bản này'} lưu Feature Cropping theo định dạng cũ: tool chỉ đọc (module nào bật, có thấy dùng không). Bật / tắt trong Project Settings → Feature Cropping rồi bấm Phân tích lại.`,
      }] : []);
      // Thay đổi chờ áp dụng mà nay đã trùng trạng thái thật thì bỏ.
      for (const [key, value] of [...state.pending]) {
        const entry = state.entries.find((item) => item.key === key);
        if (!entry || entry.enabled === value) {
          state.pending.delete(key);
        }
      }
    }
    render();
    if (panel.state.step === 'optimize' && panel.state.optimizeKind === 'engine') {
      panel.renderDetail();
    }
    if (panel.onSourcesScanned) {
      panel.onSourcesScanned();
    }
  };
  state.scan = scan;

  /** Từ "Việc nên làm": chọn sẵn tắt các module này (chưa ghi gì, người dùng bấm Áp dụng). */
  state.selectKeys = (keys) => {
    let selected = 0;
    for (const key of keys || []) {
      const entry = state.entries.find((item) => item.key === key);
      if (entry && entry.enabled && !entry.blocked) {
        state.pending.set(key, false);
        selected += 1;
      }
    }
    state.selectedKey = (keys || [])[0] || state.selectedKey;
    render();
    scrollToSelected();
    panel.renderDetail();
    // Module đã tắt hoặc bị chặn (blocked: module khác / Render Pipeline đang cần) thì không chọn: báo đúng số đã chọn.
    setStatus(selected
      ? `Đã chọn sẵn tắt ${selected} module không thấy dùng. Xem bằng chứng bên phải rồi bấm Áp dụng.`
      : 'Không có module nào chọn tắt được (đã tắt sẵn, hoặc module khác / Render Pipeline đang cần).');
  };

  const apply = async () => {
    const changes = state.entries.filter((entry) => state.pending.has(entry.key) && state.pending.get(entry.key) !== entry.enabled);
    if (!changes.length || state.busy) {
      return;
    }
    const lines = changes.map((entry) => `• ${state.pending.get(entry.key) ? 'Bật' : 'Tắt'} ${entry.label}`);
    const risky = changes.filter((entry) => !state.pending.get(entry.key) && entry.used);
    if (risky.length) {
      lines.push('', `CẢNH BÁO: ${risky.map((entry) => entry.label).join(', ')} đang được dùng (${risky[0].usedBy[0]}). Tắt thì phần đó sẽ lỗi khi chạy.`);
    }
    lines.push('', 'Ghi vào Project Settings → Feature Cropping (hoàn tác được trong Lịch sử). Nếu đang mở Project Settings thì đóng lại để nó không ghi đè. Build lại để thấy giảm bao nhiêu. Tiếp tục?');
    if (!window.confirm(lines.join('\n'))) {
      return;
    }
    state.busy = true;
    renderSummary();
    setStatus('Đang ghi cấu hình module engine...');
    const result = await Editor.Message.request(PACKAGE_NAME, 'engine-modules-apply', {
      changes: changes.map((entry) => ({ key: entry.key, enable: !!state.pending.get(entry.key) })),
    }).catch((error) => ({ ok: false, error: error.message }));
    state.busy = false;
    if (!result || !result.ok) {
      showIssues([{ level: 'error', message: (result && result.error) || 'Không ghi được cấu hình module.' }]);
      setStatus((result && result.error) || 'Không ghi được cấu hình module.');
      renderSummary();
      return;
    }
    state.pending.clear();
    helpers.offerUndo(result.historyId, `${result.labels.join(', ')}. Build lại để thấy giảm bao nhiêu.`);
    await scan({ silent: true });
  };

  // --- wire ---
  $.engShowAll.checked = state.showAll;
  $.engList.tabIndex = 0;
  $.engList.addEventListener('keydown', (event) => {
    const keys = [...$.engList.querySelectorAll('.eng-row')].map((row) => row.dataset.key);
    const index = keys.indexOf(state.selectedKey);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = keys[Math.max(0, Math.min(keys.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        select(next);
        scrollToSelected();
      }
      return;
    }
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      const entry = state.entries.find((item) => item.key === state.selectedKey);
      if (entry) {
        setTarget(entry.key, !targetOf(entry));
      }
    }
  });
  $.engShowAll.addEventListener('change', () => {
    state.showAll = !!$.engShowAll.checked;
    render();
  });
  onAction($.engSuggest, () => {
    state.selectKeys(state.entries.filter((entry) => entry.enabled && !entry.used).map((entry) => entry.key));
  });
  onAction($.engReset, () => {
    state.pending.clear();
    render();
    panel.renderDetail();
  });
  onAction($.engApply, () => { void apply(); });
  onAction($.engOpenSettings, () => {
    void Editor.Message.request('project', 'open-settings', 'engine', 'modules')
      .catch((error) => setStatus(`Không mở được Project Settings: ${error.message}`));
  });
  onAction($.engHelpToggle, () => {
    const open = $.engHelp.classList.contains('hidden');
    $.engHelp.classList.toggle('hidden', !open);
    $.engHelpToggle.classList.toggle('active', open);
  });
  render();
}

// ---------------------------------------------------------------- khung chi tiết

function renderDetail(panel, helpers) {
  const { escapeHtml } = helpers;
  const state = panel.state.engine;
  const detail = panel.$.detail;
  const entry = state && state.entries.find((item) => item.key === state.selectedKey);
  if (!entry) {
    detail.className = 'detail empty';
    detail.textContent = state && state.scanned ? 'Chọn một module để xem bằng chứng sử dụng.' : 'Đang đọc cấu hình module...';
    return;
  }
  const status = moduleStatus(entry);
  const target = state.pending.has(entry.key) ? state.pending.get(entry.key) : entry.enabled;
  const files = buildFilesFor(panel, entry);
  detail.className = 'detail';
  detail.innerHTML = `
    <div class="detail-body">
      <div class="d-head">
        <div class="d-title">${escapeHtml(entry.label)}</div>
        <div class="d-chips">
          <span class="chip ${entry.enabled ? 'strong' : ''}">${entry.enabled ? 'đang bật' : 'đang tắt'}</span>
          <span class="img-badge ${status.className}">${escapeHtml(status.text)}</span>
          ${target !== entry.enabled ? `<span class="img-badge info">sẽ ${target ? 'bật' : 'tắt'} khi bấm Áp dụng</span>` : ''}
        </div>
        ${entry.ids.length ? `<div class="muted small mono">${escapeHtml(entry.ids.join(', '))}</div>` : ''}
      </div>
      <div class="detail-note">${escapeHtml(entry.about)}</div>
      ${entry.blocked ? `<div class="detail-note error">${escapeHtml(entry.blocked)}</div>` : ''}
      <div class="d-section">
        <div class="detail-title">Bằng chứng sử dụng trong assets/ (${entry.usedBy.length})</div>
        ${entry.usedBy.length
          ? `<ul class="d-files plain">${entry.usedBy.slice(0, 40).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>${entry.usedBy.length > 40 ? `<div class="detail-note">... và ${entry.usedBy.length - 40} chỗ khác.</div>` : ''}`
          : '<div class="detail-note">Không thấy component trong scene / prefab, script hay file nào dùng tới module này.</div>'}
      </div>
      <div class="d-section">
        <div class="detail-title">Trong bản build</div>
        ${files.note ? `<div class="detail-note">${escapeHtml(files.note)}</div>` : ''}
        ${files.rows.length && !files.note
          ? `<ul class="d-files">${files.rows.sort((left, right) => right.size - left.size).map((row) => `<li title="${escapeHtml(row.relativePath)}"><span class="d-file-name">${escapeHtml(row.relativePath.split('/').pop())}</span><span class="d-file-size">${escapeHtml(formatBytes(row.size))}</span></li>`).join('')}</ul>`
          : ''}
        ${!files.rows.length ? `<div class="detail-note">${entry.enabled ? 'Mã của module nằm chung trong file engine (_virtual_cc...): build lại sau khi tắt để biết giảm bao nhiêu.' : 'Module đang tắt nên không có trong bản build.'}</div>` : ''}
      </div>
    </div>
  `;
}

module.exports = {
  SELECTORS,
  setup,
  renderDetail,
};
