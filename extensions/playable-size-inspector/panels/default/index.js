'use strict';

/**
 * Khung panel: 3 bước Tổng quan → Tìm chỗ nặng → Tối ưu, phân tích tự động (khi mở panel và
 * khi có bản build mới đã build xong), "Việc nên làm", banner bản build cũ, Lịch sử + hoàn tác,
 * và khung Chi tiết dùng chung. Nội dung từng bước nằm ở explore-tab.js / texture-tab.js /
 * audio-tab.js / engine-tab.js / model-tab.js.
 * "So với lần build trước" (ô cạnh tổng dung lượng, chênh lệch từng file, legend theo nhóm) đọc
 * cùng một mốc: bản build trước của cùng thư mục (build-baseline.json), chỉ đổi khi build lại.
 */

const path = require('path');
const {
  scanBuild,
  diffAgainstSnapshot,
  buildSourceSizeIndex,
  stableBuildPath,
  formatBytes,
  findBuildSettings,
} = require('../../lib/build-scan');
const { isDirectory, isSameResolvedPath } = require('../../lib/fs-utils');
const { buildInsights, findAssetsChangedAfter } = require('../../lib/insights');
const { isBuildFolder, listBuildFolders, pickDefaultBuild } = require('../../lib/build-folders');
const { findExportSets, updateExportHistory, detectExporter } = require('../../lib/exports');
const { checkSetup, describeExporterNote } = require('../../lib/setup-check');
const { readCaps } = require('../../lib/compat');
const { moduleBuildShare } = require('../../lib/engine-modules');
const { HEAVY_TRIANGLES } = require('../../lib/model-compress');
const exploreTab = require('./explore-tab');
const textureTab = require('./texture-tab');
const audioTab = require('./audio-tab');
const engineTab = require('./engine-tab');
const modelTab = require('./model-tab');
const audioPlayer = require('./audio-player');

const PACKAGE_NAME = 'playable-size-inspector';
const template = require('fs').readFileSync(path.join(__dirname, 'index.html'), 'utf8');
/** Phiên bản tool (package.json), hiện ở thanh trạng thái để biết bản nào đang chạy khi chép sang dự án khác. */
const TOOL_VERSION = (() => {
  try {
    return String(JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version || '');
  } catch (_error) {
    return '';
  }
})();
const style = require('fs').readFileSync(path.join(__dirname, 'index.css'), 'utf8');
const DEFAULT_BUILD_ROOT = 'build/web-mobile';
/** Chu kỳ dò bản build mới (ms). Build ghi file trong vài giây nên phải thấy "đứng yên" 2 nhịp liền mới quét. */
const BUILD_WATCH_INTERVAL = 2500;
/** Số nhịp chữ ký bản build phải đứng yên (kèm đã có settings.json) mới coi là build xong. */
const BUILD_STABLE_TICKS = 2;
/** Thư mục build đứng yên chừng này nhịp (~60 giây) mà vẫn chưa có settings.json: build bị huỷ / lỗi giữa chừng. */
const BUILD_STALLED_TICKS = 24;
const PREFS_KEY = `${PACKAGE_NAME}.panel`;

/**
 * Các tab Tối ưu và khung của chúng. Không còn dòng hướng dẫn chung cạnh các tab: thanh thao tác của từng tab
 * đã nói cách làm (đổi theo lựa chọn), banner "bản build cũ" nhắc build lại, nút "?" có hướng dẫn đầy đủ.
 */
const OPTIMIZE_TABS = { texture: 'panelTexture', audio: 'panelAudio', model: 'panelModel', engine: 'panelEngine' };

/** Loại mục Lịch sử: màu chấm, tab quét lại sau khi hoàn tác, và câu giải thích trong hộp xác nhận. */
const HISTORY_KINDS = {
  texture: { group: 'texture', tab: 'texture', what: 'Thiết lập Texture Compress cũ sẽ được ghi lại vào .meta.' },
  audio: { group: 'audio', tab: 'audio', what: 'File gốc (kèm .meta) sẽ được chép lại từ bản dự phòng.' },
  model: { group: 'model', tab: 'model', what: 'Thiết lập Mesh Compress / Mesh Simplify cũ sẽ được ghi lại vào .meta của model (editor import lại).' },
  'engine-modules': { group: 'engine', tab: 'engine', what: 'Cấu hình module engine (Feature Cropping) sẽ trở về như trước lần này.' },
};

module.exports = Editor.Panel.define({
  template,
  style,
  listeners: {
    // Panel bị ẩn (đổi tab dock...): tạm dừng audio đang nghe thử.
    hide() {
      audioPlayer.pauseAll();
      audioTab.stopQuickPlay();
    },
  },
  $: {
    ...exploreTab.SELECTORS,
    ...textureTab.SELECTORS,
    ...audioTab.SELECTORS,
    ...engineTab.SELECTORS,
    ...modelTab.SELECTORS,
    scanButton: '#scan-button',
    buildRootInput: '#build-root-input',
    buildPick: '#build-pick',
    banner: '#banner',
    content: '#content',
    stepOverview: '#step-overview',
    stepExplore: '#step-explore',
    stepOptimize: '#step-optimize',
    panelOverview: '#panel-overview',
    panelExplore: '#panel-explore',
    panelOptimize: '#panel-optimize',
    optimizeKind: '#optimize-kind',
    optCountTexture: '#opt-count-texture',
    optCountAudio: '#opt-count-audio',
    optCountEngine: '#opt-count-engine',
    optCountModel: '#opt-count-model',
    overview: '#overview',
    detail: '#detail',
    status: '#status',
    statusUndo: '#status-undo',
    summary: '#summary',
    toolVersion: '#tool-version',
    historyButton: '#history-button',
    historyCount: '#history-count',
    historyPop: '#history-pop',
  },

  ready() {
    const prefs = loadPrefs();
    this.state = {
      scanning: false,
      analyzing: false,
      buildMissing: false,
      /** Thư mục build có nhưng chưa build xong (chưa có settings.json) và chưa có số liệu cũ để giữ. */
      buildPending: false,
      buildError: '',
      /** Dấu vân tay bản build đã phân tích; khác đi, đã có settings.json và đứng yên là có bản build mới. */
      buildSignature: '',
      pendingSignature: '',
      /** Số nhịp liền pendingSignature không đổi. */
      stableTicks: 0,
      /** Đã báo "Đang build..." cho lần build đang chạy. */
      buildingShown: false,
      /** Đã báo bản build dừng giữa chừng (đứng yên lâu mà chưa có settings.json). */
      stalledShown: false,
      step: 'overview',
      optimizeKind: ['audio', 'engine', 'model'].includes(prefs.optimizeKind) ? prefs.optimizeKind : 'texture',
      assetRows: [],
      buildFileCount: 0,
      totalBuildBytes: 0,
      buildRoot: '',
      diff: null,
      /** Bản build trước của cùng thư mục (mốc so sánh): { builtAt, totalBytes, groups } hoặc null. */
      previousBuild: null,
      buildSizeBySource: null,
      /** null: đang tính; [] : không có việc gì. */
      insights: null,
      /** Thay đổi tool đã ghi vào assets/ (lib/history.js), cũ nhất trước. */
      history: [],
      /** Các lần build đã phân tích (tổng dung lượng theo thời gian) cho đường xu hướng. */
      scanHistory: [],
      /** Bản xuất theo mạng (lib/exports.js); null: đang tìm. */
      exportSets: null,
      /** Lần xuất trước của từng bộ: Map setId -> { at, items: { kênh: bytes } }. */
      exportPrevious: new Map(),
      exportSignature: '',
      /** Bộ bản xuất đang xem (khi có nhiều thư mục xuất). */
      exportSetId: (prefs.exportSets || {})[Editor.Project.path] || '',
      /** Bản dự phòng audio (lib/history.js) và số lần giữ lại khi dọn. */
      backups: [],
      keepBackups: 5,
      /**
       * Thiết lập còn thiếu (lib/setup-check.js), kiểm tra khi mở panel rồi ~10 giây một lần; luôn là kết
       * quả mới nhất. Mỗi mục: { id, title, detail, action, level, message } (level / message cho khung
       * issue của các tab: message = title).
       */
      setupIssues: [],
      setupSignature: '',
    };
    /** Tab Tối ưu có số liệu mới mà chưa vẽ lại (đang ẩn): vẽ khi được mở. */
    this.dirtyTabs = new Set();
    this.insightSignature = '';
    /** Helper dùng chung cho các module bước / tab. */
    this.helpers = {
      escapeHtml,
      onAction,
      formatDelta,
      deltaClass,
      setStatus: (message) => setStatus.call(this, message),
      revealAsset: (payload) => revealAssetInEditor.call(this, payload),
      /** Sau mỗi lần ghi vào assets/: báo kết quả kèm nút Hoàn tác ở thanh trạng thái. */
      offerUndo: (historyId, message) => offerUndo.call(this, historyId, message),
      /** Nút của "Việc nên làm" (dùng lại ở khung Chi tiết của bước Tìm chỗ nặng). */
      runInsightAction: (action) => runInsightAction.call(this, action),
      /**
       * Nút của "Thiết lập còn thiếu" (issue.action: install-ffmpeg, open-url, open-settings, open-build,
       * enable-meshopt), dùng lại được ở các tab. Trả về Promise<boolean>: true khi đã làm xong.
       */
      runSetupAction: (action) => runSetupAction.call(this, action),
    };

    onAction(this.$.scanButton, () => {
      void analyzeAll.call(this);
    });
    // Thư mục build nhớ riêng cho từng dự án (mỗi dự án có thể đặt tên build khác nhau). Chưa chọn lần nào thì
    // tool tự chọn bản build của build task web mới nhất (lib/build-folders.js pickDefaultBuild).
    const savedRoot = (prefs.buildRoots || {})[Editor.Project.path];
    if (savedRoot) {
      this.$.buildRootInput.value = savedRoot;
    }
    this.state.autoBuildRoot = !savedRoot;
    const caps = readCaps(Editor.Project.path);
    this.state.caps = caps;
    if (this.$.toolVersion) {
      this.$.toolVersion.textContent = TOOL_VERSION ? `v${TOOL_VERSION}` : '';
      this.$.toolVersion.title = `Playable Size Inspector ${TOOL_VERSION} · Cocos Creator ${caps.version || '?'}${caps.meshCompress ? '' : ' (bản này chưa có Mesh Compress / meshopt: tool chỉ phân tích phần đó)'}`;
    }
    // Đổi thư mục build thì chỉ cần phân tích lại phần build.
    this.$.buildRootInput.addEventListener('confirm', () => {
      saveBuildRoot.call(this);
      void scanPlayable.call(this);
    });
    this.$.buildPick.addEventListener('change', () => {
      if (!this.$.buildPick.value) {
        return;
      }
      this.$.buildRootInput.value = this.$.buildPick.value;
      saveBuildRoot.call(this);
      void scanPlayable.call(this);
    });
    for (const button of [this.$.stepOverview, this.$.stepExplore, this.$.stepOptimize]) {
      button.addEventListener('click', () => switchStep.call(this, button.dataset.step));
    }
    for (const button of this.$.optimizeKind.querySelectorAll('button')) {
      button.addEventListener('click', () => setOptimizeKind.call(this, button.dataset.kind));
    }
    this.$.historyButton.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleHistory.call(this);
    });
    this.$.historyPop.addEventListener('click', (event) => event.stopPropagation());
    // Bấm ra ngoài / Esc thì đóng danh sách lịch sử.
    this.$.content.addEventListener('click', () => toggleHistory.call(this, false));
    this.$.historyPop.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        toggleHistory.call(this, false);
      }
    });
    this.$.statusUndo.addEventListener('click', () => {
      if (this.$.statusUndo.dataset.id) {
        void undoHistory.call(this, this.$.statusUndo.dataset.id);
      }
    });

    // Các module gọi lại khi lựa chọn của chúng đổi / khi quét lại xong.
    this.renderDetail = () => renderDetail.call(this);
    this.onSourcesScanned = () => {
      renderOptimizeCounts.call(this);
      scheduleInsights.call(this);
    };

    exploreTab.setup(this, this.helpers);
    textureTab.setup(this, this.helpers);
    audioTab.setup(this, this.helpers);
    engineTab.setup(this, this.helpers);
    modelTab.setup(this, this.helpers);

    renderSteps.call(this);
    this.state.scanHistory = readScanHistory();
    renderOverview.call(this);
    void loadHistory.call(this);
    // Người mới không phải tìm nút nào: mở panel là có số liệu, build xong là tự cập nhật.
    void analyzeAll.call(this);
    let tick = 0;
    this.buildWatch = setInterval(() => {
      void checkBuildChanged.call(this);
      // Dò file assets/ sửa sau lần build (banner "build cũ") thưa hơn: ~10 giây một lần.
      tick += 1;
      if (tick % 4 === 0 && !this.state.scanning) {
        void checkStaleBuild.call(this);
        void refreshBuildList.call(this);
        void refreshExports.call(this);
        void refreshSetup.call(this);
      }
    }, BUILD_WATCH_INTERVAL);
  },

  close() {
    clearInterval(this.buildWatch);
    clearTimeout(this.insightTimer);
    audioPlayer.stopAll();
    audioTab.stopQuickPlay();
    if (this.state.model && this.state.model.dispose) this.state.model.dispose();
  },
});

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  } catch (_error) {
    return {};
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...prefs }));
  } catch (_error) {
    // Chỉ là tiện ích nhớ lựa chọn.
  }
}

// ---------------------------------------------------------------- 3 bước

function switchStep(step) {
  this.state.step = step;
  renderSteps.call(this);
}

function setOptimizeKind(kind) {
  this.state.optimizeKind = ['audio', 'engine', 'model'].includes(kind) ? kind : 'texture';
  savePrefs({ optimizeKind: this.state.optimizeKind });
  renderSteps.call(this);
}

function renderSteps() {
  const step = this.state.step;
  for (const [name, button, panel] of [
    ['overview', this.$.stepOverview, this.$.panelOverview],
    ['explore', this.$.stepExplore, this.$.panelExplore],
    ['optimize', this.$.stepOptimize, this.$.panelOptimize],
  ]) {
    button.classList.toggle('active', step === name);
    panel.classList.toggle('active', step === name);
  }
  // Tổng quan dùng hết bề ngang; hai bước còn lại có khung Chi tiết bên phải.
  this.$.content.classList.toggle('no-detail', step === 'overview');

  const kind = this.state.optimizeKind;
  for (const button of this.$.optimizeKind.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.kind === kind);
  }
  this.$.panelTexture.classList.toggle('active', kind === 'texture');
  this.$.panelAudio.classList.toggle('active', kind === 'audio');
  this.$.panelEngine.classList.toggle('active', kind === 'engine');
  this.$.panelModel.classList.toggle('active', kind === 'model');
  // Tab vừa hiện mà có số liệu mới trong lúc ẩn: vẽ lại bây giờ.
  refreshVisibleTab.call(this);

  if (step === 'explore') {
    exploreTab.render(this, this.helpers);
    // Lần đầu vào bước này: chọn sẵn mục nặng nhất để khung Chi tiết không trống.
    const explore = this.state.explore;
    if (!explore.selected) {
      const first = this.$.exploreList.querySelector('[data-key]');
      if (first) {
        explore.selected = first.dataset.key;
        first.classList.add('selected');
      }
    }
  }
  renderDetail.call(this);
}

/**
 * Tab Tối ưu cần vẽ lại theo số liệu mới (bản build, Việc nên làm, thiết lập): chỉ vẽ tab đang mở, tab
 * khác đánh dấu và vẽ khi được mở (renderSteps). `kinds` mặc định là cả bốn tab.
 */
function refreshTabs(kinds = Object.keys(OPTIMIZE_TABS)) {
  for (const kind of kinds) {
    this.dirtyTabs.add(kind);
  }
  refreshVisibleTab.call(this);
}

function refreshVisibleTab() {
  const kind = this.state.optimizeKind;
  if (this.state.step !== 'optimize' || !this.dirtyTabs.has(kind)) {
    return;
  }
  this.dirtyTabs.delete(kind);
  const tab = this.state[kind];
  // Tab chưa quét xong thì tự vẽ khi quét xong.
  if (tab && tab.scanned && typeof tab.refresh === 'function') {
    keepScroll(this.$[OPTIMIZE_TABS[kind]], () => tab.refresh());
  }
}

/**
 * Vẽ lại vì số liệu nền đổi, không phải vì người dùng chọn: giữ nguyên vị trí cuộn. refresh() của các tab
 * cuộn tới mục đang chọn (scrollIntoView), người dùng đang xem chỗ khác thì không bị kéo về.
 */
function keepScroll(root, render) {
  const saved = [];
  if (root) {
    for (const element of root.querySelectorAll('.panel-body')) {
      saved.push([element, element.scrollTop, element.scrollLeft]);
    }
    // scrollIntoView cuộn cả khung cha (kể cả khung overflow: hidden).
    for (let element = root; element; element = element.parentElement) {
      saved.push([element, element.scrollTop, element.scrollLeft]);
    }
  }
  try {
    render();
  } finally {
    for (const [element, top, left] of saved) {
      if (element.scrollTop !== top) {
        element.scrollTop = top;
      }
      if (element.scrollLeft !== left) {
        element.scrollLeft = left;
      }
    }
  }
}

function renderOptimizeCounts() {
  const texture = this.state.texture;
  const audio = this.state.audio;
  // Có bản build thì đếm file trong build (khớp bộ lọc "Trong build" của các tab), chưa có thì đếm cả assets/.
  const index = this.state.buildSizeBySource;
  const count = (list) => String(index ? list.filter((item) => index.has(item.url)).length : list.length);
  this.$.optCountTexture.textContent = texture && texture.scanned ? count(texture.rows) : '';
  this.$.optCountAudio.textContent = audio && audio.scanned ? count(audio.files) : '';
  // Module engine: số module đang bật mà không thấy dùng và tắt được (module khác đang cần thì không tính).
  const unused = unusedModules(this.state.engine).length;
  this.$.optCountEngine.textContent = unused ? String(unused) : '';
  this.$.optCountEngine.classList.toggle('warn', unused > 0);
  // Model 3D: số model trong build nên xử lý (chưa nén / quá nhiều tam giác).
  const model = this.state.model;
  const todo = model && model.scanned && model.ok ? model.todoModels().length : 0;
  this.$.optCountModel.textContent = todo ? String(todo) : '';
  this.$.optCountModel.classList.toggle('warn', todo > 0);
}

/** Module đang bật, không thấy dùng và tắt được (cùng luật với Việc nên làm và thẻ ở Tổng quan). */
function unusedModules(engine) {
  // Định dạng cũ của Feature Cropping (Cocos 3.6 / 3.7): mục nào cũng khoá (tool không ghi) nhưng vẫn là việc nên làm.
  return engine && engine.scanned && engine.ok !== false
    ? (engine.entries || []).filter((entry) => entry.enabled && !entry.used && (!entry.blocked || entry.legacy))
    : [];
}

// ---------------------------------------------------------------- phân tích tất cả

/**
 * Build + ảnh nguồn + audio nguồn chạy song song; mỗi phần lỗi riêng không chặn phần khác. "Việc nên làm"
 * tính một lần khi tất cả xong (scheduleInsights chờ trong lúc analyzing) thay vì sau từng phần.
 */
async function analyzeAll() {
  if (this.state.analyzing) {
    return;
  }
  this.state.analyzing = true;
  this.$.scanButton.setAttribute('disabled', '');
  setStatus.call(this, 'Đang phân tích bản build, ảnh, âm thanh, model 3D và module engine...');
  try {
    await Promise.all([
      scanPlayable.call(this, { silent: true }),
      this.state.texture.scan({ silent: true }),
      this.state.audio.scan({ silent: true }),
      this.state.engine.scan({ silent: true }),
      this.state.model.scan({ silent: true }),
      refreshExports.call(this),
      refreshSetup.call(this),
    ]);
    const parts = [
      this.state.buildMissing
        ? 'chưa có bản build'
        : this.state.buildPending
          ? 'bản build chưa xong'
          : `${resolveBuildRoot(this).input} ${formatBytes(this.state.totalBuildBytes)} (${this.state.buildFileCount} file)`,
      `${this.state.texture.rows.length} ảnh`,
      `${this.state.audio.files.length} audio`,
      `${(this.state.model.models || []).length} model`,
    ];
    setStatus.call(this, `Đã phân tích: ${parts.join(' · ')}.`);
  } finally {
    this.state.analyzing = false;
    this.$.scanButton.removeAttribute('disabled');
    scheduleInsights.call(this);
  }
}

/** Có bản build mới ở thư mục khác (vd build cho mạng khác): cập nhật danh sách và nhắc chọn. */
async function refreshBuildList() {
  const builds = await listBuildFolders(Editor.Project.path);
  const current = resolveBuildRoot(this).input.replace(/\\/g, '/');
  const known = this.state.knownBuilds || '';
  const signature = builds.map((build) => `${build.relative}:${build.builtAt}`).join('|');
  if (signature === known) {
    return;
  }
  this.state.knownBuilds = signature;
  renderBuildPick.call(this, builds);
  const newest = builds[0];
  if (known && newest && newest.relative !== current && !known.includes(`${newest.relative}:${newest.builtAt}`)) {
    setStatus.call(this, `Có bản build mới ở ${newest.relative}. Chọn nó trong danh sách cạnh ô Thư mục build để phân tích.`);
  }
}

/** Danh sách chọn bản build cạnh ô thư mục: chỉ hiện khi có từ 2 bản build trở lên. */
function renderBuildPick(builds) {
  const current = String(this.$.buildRootInput.value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const pick = this.$.buildPick;
  pick.classList.toggle('hidden', builds.length < 2);
  pick.innerHTML = `
    ${builds.some((build) => build.relative === current) ? '' : '<option value="">(chọn bản build)</option>'}
    ${builds.map((build) => `<option value="${escapeHtml(build.relative)}">${escapeHtml(build.relative.replace(/^build\//, ''))} · ${escapeHtml(formatTimestamp(new Date(build.builtAt).toISOString()))}</option>`).join('')}
  `;
  pick.value = builds.some((build) => build.relative === current) ? current : '';
}

function saveBuildRoot() {
  this.state.autoBuildRoot = false;
  const prefs = loadPrefs();
  const roots = prefs.buildRoots || {};
  roots[Editor.Project.path] = String(this.$.buildRootInput.value || '').trim();
  savePrefs({ buildRoots: roots });
}

function resolveBuildRoot(panel) {
  const input = String(panel.$.buildRootInput.value || DEFAULT_BUILD_ROOT).trim() || DEFAULT_BUILD_ROOT;
  return { input, fullPath: path.resolve(Editor.Project.path, input) };
}

/**
 * Vân tay rẻ của bản build: vài file Cocos luôn ghi lại mỗi lần build. Kèm `exists` (có thư mục),
 * `complete` (đã có settings.json: Cocos xoá trống thư mục lúc bắt đầu build và ghi file này gần cuối)
 * và `builtAt` (mtime của settings.json, 0 khi chưa có).
 */
async function readBuildSignature(buildRoot) {
  const fsPromises = require('fs/promises');
  const parts = [];
  // Thư mục src/ và assets/main/ cũng đổi mtime khi build ghi lại file bên trong (kể cả khi bật MD5 Cache).
  for (const relative of ['index.html', 'src', 'assets/main', 'cocos-js']) {
    const stat = await fsPromises.stat(path.join(buildRoot, relative)).catch(() => null);
    parts.push(stat ? `${relative}:${stat.mtimeMs}:${stat.size}` : `${relative}:-`);
  }
  const settingsPath = await findBuildSettings(buildRoot);
  const settingsStat = settingsPath ? await fsPromises.stat(settingsPath).catch(() => null) : null;
  parts.push(settingsStat ? `settings:${settingsStat.mtimeMs}:${settingsStat.size}` : 'settings:-');
  return {
    signature: parts.join('|'),
    exists: await isDirectory(buildRoot),
    complete: !!settingsStat,
    builtAt: settingsStat ? settingsStat.mtimeMs : 0,
  };
}

/**
 * Gọi định kỳ. Bản build đổi thì chỉ phân tích lại khi đã build xong: có settings.json VÀ chữ ký đứng
 * yên BUILD_STABLE_TICKS nhịp liền. Đang build (thư mục bị xoá rồi ghi lại dần) thì chỉ báo "Đang build...",
 * không quét, không ghi xu hướng / mốc so sánh. Thư mục bị xoá hẳn thì quét để hiện "Chưa có bản build".
 */
async function checkBuildChanged() {
  if (this.state.scanning || this.state.analyzing || !this.state.buildSignature) {
    return;
  }
  const { input, fullPath } = resolveBuildRoot(this);
  const build = await readBuildSignature(fullPath);
  if (build.signature === this.state.buildSignature) {
    this.state.pendingSignature = '';
    this.state.stableTicks = 0;
    return;
  }
  const building = build.exists && !build.complete;
  if (building && !this.state.buildingShown) {
    this.state.buildingShown = true;
    this.$.summary.textContent = 'Đang build...';
    setStatus.call(this, `Đang build ở ${input}... build xong là tool tự phân tích.`);
  }
  if (build.signature !== this.state.pendingSignature) {
    this.state.pendingSignature = build.signature;
    this.state.stableTicks = 0;
    this.state.stalledShown = false;
    return;
  }
  this.state.stableTicks += 1;
  if (building && this.state.stableTicks >= BUILD_STALLED_TICKS && !this.state.stalledShown) {
    // Đứng yên cả phút mà vẫn chưa có settings.json: build bị huỷ / lỗi giữa chừng. Số liệu cũ không còn khớp
    // thư mục này nữa: hiện thẻ "chưa xong" thay cho "Đang build..." mãi. Build xong là tự quét như thường.
    this.state.stalledShown = true;
    showBuildPending.call(this, fullPath, { stalled: true });
    setStatus.call(this, `Bản build ở ${input} dừng giữa chừng (chưa có src/settings.json). Build lại là tool tự phân tích.`);
    return;
  }
  if (building || this.state.stableTicks < BUILD_STABLE_TICKS) {
    return;
  }
  await scanPlayable.call(this, { auto: true });
}

// ---------------------------------------------------------------- phân tích bản build

/**
 * Phân tích thư mục build. `silent`: nằm trong analyzeAll (status do nơi gọi báo);
 * `auto`: do phát hiện bản build mới (checkBuildChanged, chỉ gọi khi đã build xong).
 */
async function scanPlayable({ silent = false, auto = false } = {}) {
  if (this.state.scanning) {
    return;
  }

  this.state.scanning = true;
  this.$.summary.textContent = 'Đang phân tích bản build...';
  if (!silent) {
    setStatus.call(this, auto ? 'Phát hiện bản build mới, đang phân tích...' : 'Đang phân tích bản build...');
  }

  try {
    const projectRoot = Editor.Project.path;
    // Thư mục đang chọn chưa có bản build (dự án mới chép tool sang, đặt tên build khác...):
    // tự dùng bản build mới nhất trong build/. Có nhiều bản build thì hiện danh sách để chọn.
    // Chỉ khi mở panel / bấm phân tích: lúc tự quét, thư mục đang chọn có thể chỉ đang được build lại,
    // đổi đi là bỏ lỡ đúng bản vừa build xong.
    const builds = await listBuildFolders(Editor.Project.path);
    let { input: buildRootInput, fullPath: buildRoot } = resolveBuildRoot(this);
    let switchedFrom = '';
    if (!auto && this.state.autoBuildRoot && builds.length) {
      // Người dùng chưa chọn thư mục nào: phân tích đúng bản build task web mới nhất ghi ra (không mặc định build/web-mobile cũ).
      const pick = await pickDefaultBuild(projectRoot, builds).catch(() => null);
      if (pick && pick.reason !== 'default' && !isSameResolvedPath(pick.fullPath, buildRoot)) {
        buildRootInput = pick.relative;
        buildRoot = pick.fullPath;
        this.$.buildRootInput.value = buildRootInput;
      }
    }
    if (!auto && !await isBuildFolder(buildRoot) && builds.length) {
      switchedFrom = buildRootInput;
      buildRootInput = builds[0].relative;
      buildRoot = builds[0].fullPath;
      this.$.buildRootInput.value = buildRootInput;
    }
    renderBuildPick.call(this, builds);
    const build = await readBuildSignature(buildRoot);
    Object.assign(this.state, { buildSignature: build.signature, pendingSignature: '', stableTicks: 0, buildingShown: false, stalledShown: false });

    if (!build.exists) {
      showBuildMissing.call(this);
      if (!silent) {
        setStatus.call(this, `Chưa có bản build ở ${buildRootInput}.`);
      }
      return;
    }
    if (switchedFrom) {
      // Báo một lần dù đang nằm trong analyzeAll: người dùng cần biết tool đang đọc thư mục nào.
      setStatus.call(this, `Không có bản build ở ${switchedFrom}, đang dùng ${buildRootInput} (mới nhất trong build/).`);
    }
    if (!build.complete) {
      // Đang build (Cocos xoá trống thư mục rồi ghi lại) hoặc build dở: số liệu lúc này sai, không ghi vào
      // xu hướng / mốc so sánh. Build xong (có settings.json) là checkBuildChanged tự quét.
      showBuildPending.call(this, buildRoot);
      if (!silent) {
        setStatus.call(this, `Bản build ở ${buildRootInput} chưa xong (chưa có src/settings.json). Build xong là tool tự phân tích.`);
      }
      return;
    }

    const result = await scanBuild({ projectRoot, buildRoot });
    // Bắt đầu build lại đúng lúc đang quét: bỏ kết quả lẫn lộn, chờ bản mới build xong.
    if ((await readBuildSignature(buildRoot)).signature !== build.signature) {
      showBuildPending.call(this, buildRoot);
      if (!silent) {
        setStatus.call(this, `Đang build ở ${buildRootInput}... build xong là tool tự phân tích.`);
      }
      return;
    }
    if (this.state.buildRoot && !isSameResolvedPath(this.state.buildRoot, buildRoot)) {
      // Đổi thư mục build: bộ bản xuất mở từ Tổng quan không còn là của bản build đang xem.
      Object.assign(this.state.html, { setId: '', userChoice: '' });
    }
    this.state.buildMissing = false;
    this.state.buildPending = false;
    this.state.buildError = '';
    this.state.buildRoot = buildRoot;

    const groupBytes = Object.fromEntries(exploreTab.groupRows(result.assetRows).map((group) => [group.key, group.bytes]));
    // So với bản build TRƯỚC của thư mục này (không phải lần phân tích trước): ô chênh lệch, từng file và
    // legend theo nhóm cùng một mốc, phân tích lại / mở lại panel không làm mất.
    const previous = await rotateBuildBaseline(buildRoot, build.builtAt, result.buildFiles, groupBytes).catch((error) => {
      console.warn(`[${PACKAGE_NAME}] Không lưu được mốc so sánh:`, error);
      return null;
    });
    const diff = diffAgainstSnapshot(result.buildFiles, previous);
    if (diff) {
      diff.previousAt = new Date(previous.builtAt).toISOString();
    }

    this.state.assetRows = result.assetRows;
    this.state.buildFileCount = result.buildFiles.length;
    this.state.totalBuildBytes = result.totalBuildBytes;
    this.state.diff = diff;
    this.state.previousBuild = previous ? { builtAt: previous.builtAt, totalBytes: previous.totalBytes, groups: previous.groups || null } : null;
    for (const row of this.state.assetRows) {
      row.deltaBytes = diff ? (diff.byPath.get(row.relativePath) || 0) : 0;
    }
    // Bước Tối ưu dùng bảng này để hiện "trong build chiếm bao nhiêu".
    this.state.buildSizeBySource = buildSourceSizeIndex(this.state.assetRows);
    this.state.scanHistory = await appendScanHistory(buildRoot, build.builtAt, result.totalBuildBytes, result.buildFiles.length, groupBytes)
      .catch(() => this.state.scanHistory);
    // Lựa chọn cũ có thể không còn tồn tại trong bản build mới.
    this.state.explore.selected = '';

    this.$.summary.textContent = `Build ${formatBytes(result.totalBuildBytes)} · ${result.buildFiles.length} file`;
    renderOverview.call(this);
    if (this.state.step === 'explore') {
      renderSteps.call(this);
    }
    // Mọi tab Tối ưu đọc số liệu build (trong build chiếm bao nhiêu): vẽ lại khi có Việc nên làm mới
    // (refreshInsights vẽ tab đang mở, tab khác vẽ khi được mở) thay vì vẽ ngay rồi vẽ lại lần nữa.
    this.dirtyTabs = new Set(Object.keys(OPTIMIZE_TABS));
    scheduleInsights.call(this);

    if (!silent) {
      const delta = diff && diff.totalDelta ? ` (${formatDelta(diff.totalDelta)} so với lần build trước)` : '';
      setStatus.call(this, `${auto ? 'Bản build mới' : 'Bản build'}: ${formatBytes(result.totalBuildBytes)}, ${result.buildFiles.length} file${delta}.`);
    }
  } catch (error) {
    console.error(`[${PACKAGE_NAME}] Phân tích build thất bại:`, error);
    const message = error.message || String(error);
    clearBuildState.call(this);
    this.state.buildError = message;
    this.$.summary.textContent = 'Phân tích build thất bại';
    renderOverview.call(this);
    renderSteps.call(this);
    setStatus.call(this, message);
  } finally {
    this.state.scanning = false;
  }
}

function clearBuildState() {
  this.state.assetRows = [];
  this.state.buildFileCount = 0;
  this.state.totalBuildBytes = 0;
  this.state.diff = null;
  this.state.previousBuild = null;
  this.state.buildSizeBySource = null;
  this.state.buildPending = false;
  this.state.explore.selected = '';
}

/** Chưa build: không phải lỗi, chỉ dẫn người dùng đi build. Tool tự phân tích khi build xong. */
function showBuildMissing() {
  clearBuildState.call(this);
  this.state.buildMissing = true;
  this.state.buildError = '';
  this.$.summary.textContent = 'Chưa có bản build';
  this.dirtyTabs = new Set(Object.keys(OPTIMIZE_TABS));
  renderOverview.call(this);
  renderSteps.call(this);
  scheduleInsights.call(this);
}

/**
 * Bản build chưa xong (đang build / build dở). Còn số liệu của chính thư mục này thì giữ nguyên tới
 * khi build xong; không thì hiện thẻ "chưa xong" thay cho số liệu. `stalled`: thư mục đứng yên lâu mà
 * vẫn chưa xong (build bị huỷ / lỗi): bỏ số liệu cũ, hiện thẻ "chưa xong".
 */
function showBuildPending(buildRoot, { stalled = false } = {}) {
  this.$.summary.textContent = stalled ? 'Bản build chưa xong' : 'Đang build...';
  if (!stalled && this.state.buildFileCount && this.state.buildRoot && isSameResolvedPath(this.state.buildRoot, buildRoot)) {
    return;
  }
  clearBuildState.call(this);
  this.state.buildMissing = false;
  this.state.buildPending = true;
  this.state.buildError = '';
  this.dirtyTabs = new Set(Object.keys(OPTIMIZE_TABS));
  renderOverview.call(this);
  renderSteps.call(this);
  scheduleInsights.call(this);
}

/** Nhãn chênh lệch so với lần build trước (ô cạnh tổng dung lượng ở Tổng quan). */
function describeDiff(diff) {
  if (!diff) {
    return { text: 'Chưa có lần build trước để so', title: 'Build lại là tool tự so chênh lệch với bản build này.', className: '' };
  }
  if (!diff.totalDelta && !diff.byPath.size) {
    return { text: 'Không đổi so với lần build trước', title: `So với bản build ${formatTimestamp(diff.previousAt)}`, className: '' };
  }
  return {
    text: `${formatDelta(diff.totalDelta) || '±0'} so với lần build trước`,
    title: `${diff.byPath.size} file đổi (${diff.added} mới, ${diff.removed} mất) · so với bản build ${formatTimestamp(diff.previousAt)}`,
    className: deltaClass(diff.totalDelta),
  };
}

function formatTimestamp(value) {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) {
    return 'lần trước';
  }
  const pad = (number) => String(number).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())} ${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
}

/** "−12.3 KB" / "+4 KB" / '' khi không đổi. */
function formatDelta(deltaBytes) {
  const delta = Number(deltaBytes) || 0;
  if (!delta) {
    return '';
  }
  return `${delta < 0 ? '−' : '+'}${formatBytes(Math.abs(delta))}`;
}

function deltaClass(deltaBytes) {
  const delta = Number(deltaBytes) || 0;
  if (delta < 0) {
    return 'delta-down';
  }
  return delta > 0 ? 'delta-up' : '';
}

// ---------------------------------------------------------------- Tổng quan

function renderOverview() {
  this.$.overview.className = 'panel-body';
  this.$.overview.innerHTML = `
    <div class="ov">
      ${renderSetupCard.call(this)}
      ${renderBuildCard.call(this)}
      ${renderExportsCard.call(this)}
      <div class="ov-sources">${renderSourceCards.call(this)}</div>
      ${renderTodoCard.call(this)}
    </div>
  `;

  for (const element of this.$.overview.querySelectorAll('.setup-action')) {
    element.addEventListener('click', () => {
      const issue = this.state.setupIssues[Number(element.dataset.index)];
      if (issue && issue.action) {
        void runSetupAction.call(this, issue.action);
      }
    });
  }

  const exportPick = this.$.overview.querySelector('.exp-pick');
  if (exportPick) {
    exportPick.addEventListener('change', () => {
      this.state.exportSetId = exportPick.value;
      // Trang HTML cuối đi theo bộ vừa chọn (tự chọn file html mới nhất của bộ đó).
      Object.assign(this.state.html, { setId: exportPick.value, userChoice: '' });
      const prefs = loadPrefs();
      savePrefs({ exportSets: { ...(prefs.exportSets || {}), [Editor.Project.path]: exportPick.value } });
      renderOverview.call(this);
    });
  }
  for (const element of this.$.overview.querySelectorAll('[data-open-path]')) {
    element.addEventListener('click', () => {
      void Editor.Message.request(PACKAGE_NAME, 'open-path', { path: element.dataset.openPath })
        .then((result) => {
          if (!result || !result.ok) {
            setStatus.call(this, `Không mở được thư mục: ${(result && result.error) || 'không rõ lỗi'}`);
          }
        });
    });
  }

  for (const element of this.$.overview.querySelectorAll('[data-html-file]')) {
    element.addEventListener('click', () => {
      switchStep.call(this, 'explore');
      // Kèm bộ bản xuất đang xem: trang HTML cuối mở đúng file đó kể cả khi là bộ của bản build khác.
      exploreTab.showHtml(this, this.helpers, element.dataset.htmlFile, element.dataset.htmlSet);
      renderDetail.call(this);
    });
  }
  for (const element of this.$.overview.querySelectorAll('[data-group]')) {
    element.addEventListener('click', () => {
      switchStep.call(this, 'explore');
      exploreTab.showGroup(this, this.helpers, element.dataset.group);
      renderDetail.call(this);
    });
  }
  for (const element of this.$.overview.querySelectorAll('[data-goto]')) {
    element.addEventListener('click', () => {
      setOptimizeKind.call(this, element.dataset.goto);
      switchStep.call(this, 'optimize');
    });
  }
  for (const element of this.$.overview.querySelectorAll('.todo-action')) {
    element.addEventListener('click', () => {
      const insight = (this.state.insights || [])[Number(element.dataset.index)];
      if (insight && insight.action) {
        void runInsightAction.call(this, insight.action);
      }
    });
  }
  for (const element of this.$.overview.querySelectorAll('.ov-open-build')) {
    element.addEventListener('click', () => { void openBuildPanel.call(this); });
  }
}

function renderBuildCard() {
  if (this.state.buildMissing || this.state.buildError || !this.state.buildFileCount) {
    let body = 'Đang phân tích bản build...';
    if (this.state.buildMissing) {
      body = `Chưa có bản build ở <code>${escapeHtml(resolveBuildRoot(this).input)}</code>. Build platform <b>web-mobile</b>, tool tự phân tích ngay khi build xong.`;
    } else if (this.state.buildPending) {
      body = `Bản build ở <code>${escapeHtml(resolveBuildRoot(this).input)}</code> chưa xong (đang build, hoặc build dở: chưa có <code>src/settings.json</code>). Build xong là tool tự phân tích.`;
    } else if (this.state.buildError) {
      body = `Không phân tích được bản build: ${escapeHtml(this.state.buildError)}`;
    }
    return `
      <section class="ov-card ov-build">
        <div class="ov-kicker">Bản build web-mobile</div>
        <div class="ov-empty">${body}</div>
        ${this.state.buildMissing ? '<button class="ov-button ov-open-build">Mở Build</button>' : ''}
      </section>
    `;
  }

  const total = this.state.totalBuildBytes;
  const groups = exploreTab.groupRows(this.state.assetRows);
  const diff = describeDiff(this.state.diff);
  // Chênh lệch từng nhóm so với cùng mốc với ô chênh lệch: bản build trước của thư mục này.
  const previousBuild = this.state.previousBuild;
  const percent = (bytes) => (total > 0 ? (bytes / total) * 100 : 0);
  return `
    <section class="ov-card ov-build">
      <div class="ov-build-head">
        <div>
          <div class="ov-kicker">Bản build web-mobile</div>
          <div class="ov-total">${escapeHtml(formatBytes(total))}<span class="ov-files">${this.state.buildFileCount} file</span></div>
        </div>
        <div class="ov-build-side">
          ${renderTrend.call(this)}
          <div class="ov-delta ${escapeHtml(diff.className)}" title="${escapeHtml(diff.title)}">${escapeHtml(diff.text)}</div>
        </div>
      </div>
      <div class="stack-bar">
        ${groups.map((group) => `
          <span class="stack-seg group-${group.key}" data-group="${group.key}" style="width:${percent(group.bytes).toFixed(2)}%"
            title="${escapeHtml(`${group.label}: ${formatBytes(group.bytes)} (${Math.round(percent(group.bytes))}%) · ${group.files} file\n${group.hint}\nBấm để xem danh sách file`)}"></span>
        `).join('')}
      </div>
      <div class="stack-legend">
        ${groups.map((group) => {
          const delta = previousBuild && previousBuild.groups ? group.bytes - (previousBuild.groups[group.key] || 0) : 0;
          return `
            <button class="legend-item" data-group="${group.key}" title="${escapeHtml(`${group.hint}. Bấm để xem danh sách file.`)}">
              <span class="legend-dot group-${group.key}"></span>
              <span class="legend-label">${escapeHtml(group.label)}</span>
              <span class="legend-value">${escapeHtml(formatBytes(group.bytes))}</span>
              <span class="legend-pct">${Math.round(percent(group.bytes))}%</span>
              ${Math.abs(delta) >= 1024 ? `<span class="legend-delta ${deltaClass(delta)}" title="${escapeHtml(`So với lần build ${formatTimestamp(new Date(previousBuild.builtAt).toISOString())}`)}">${escapeHtml(formatDelta(delta))}</span>` : ''}
            </button>
          `;
        }).join('')}
      </div>
      <div class="ov-note">Đây là thư mục build web-mobile, chưa đóng gói. Bản xuất cho từng mạng nén ảnh sang WebP, encode lại audio rồi zip tất cả, nên tỉ lệ giữa các nhóm khác đi: mã engine và dữ liệu JSON co lại nhiều nhất, model và âm thanh gần như giữ nguyên. Phần thật sự chiếm trong file gửi mạng xem ở Tìm chỗ nặng → HTML cuối; Việc nên làm bên dưới tính phần giảm được theo dung lượng sau zip.</div>
    </section>
  `;
}

// ---------------------------------------------------------------- thiết lập còn thiếu

/**
 * Tự kiểm tra thiết lập (ffmpeg, preset nén, tên build, mạng đã tick, meshopt). panel.state.setupIssues
 * luôn là kết quả mới nhất (các tab đọc được); chỉ vẽ lại khi nội dung đổi.
 */
async function refreshSetup() {
  let issues;
  try {
    issues = await checkSetup(Editor.Project.path);
  } catch (error) {
    console.warn(`[${PACKAGE_NAME}] Không kiểm tra được thiết lập:`, error);
    issues = [];
  }
  // level / message: cùng dạng với khung issue của các tab (.issue.error / .issue.info).
  this.state.setupIssues = issues.map((issue) => ({
    ...issue,
    level: issue.level || (issue.id === 'meshopt' ? 'error' : 'info'),
    message: issue.message || issue.title,
  }));
  const signature = JSON.stringify(issues.map((issue) => [issue.id, issue.title, issue.detail, issue.action && issue.action.type]));
  if (signature === this.state.setupSignature) {
    return;
  }
  this.state.setupSignature = signature;
  renderOverview.call(this);
  // Tab nào hiện cảnh báo thiết lập (ffmpeg, meshopt...) thì vẽ lại theo kết quả mới (tab đang ẩn: khi được mở).
  refreshTabs.call(this);
}

/** Chỉ hiện khi còn thiếu gì đó; đủ hết thì không chiếm chỗ. */
function renderSetupCard() {
  const issues = this.state.setupIssues;
  if (!issues.length) {
    return '';
  }
  return `
    <section class="ov-card ov-setup">
      <div class="ov-todo-head">
        <span class="ov-title">Thiết lập còn thiếu</span>
        <span class="ov-sub">${issues.length} việc · tool tự kiểm tra định kỳ, làm xong là mục đó tự biến mất</span>
      </div>
      ${issues.map((issue, index) => `
        <div class="setup-item">
          <span class="setup-icon">!</span>
          <div class="todo-main">
            <div class="todo-title">${escapeHtml(issue.title)}</div>
            <div class="todo-detail">${escapeHtml(issue.detail)}</div>
          </div>
          ${issue.action ? `<button class="ov-button setup-action" data-index="${index}">${escapeHtml(issue.action.label)}</button>` : ''}
        </div>
      `).join('')}
    </section>
  `;
}

/**
 * Chạy nút của một mục "Thiết lập còn thiếu" (cũng là helpers.runSetupAction cho các tab).
 * Trả về true khi đã làm xong, false khi huỷ / lỗi (lỗi đã báo ở thanh trạng thái).
 */
async function runSetupAction(action) {
  if (!action) {
    return false;
  }
  if (action.type === 'open-build') {
    await openBuildPanel.call(this);
    return true;
  }
  if (action.type === 'open-settings') {
    return await Editor.Message.request('project', 'open-settings', action.tab, action.subTab)
      .then(() => true)
      .catch((error) => {
        setStatus.call(this, `Không mở được Project Settings: ${error.message}`);
        return false;
      });
  }
  if (action.type === 'open-url') {
    const result = await Editor.Message.request(PACKAGE_NAME, 'open-url', { url: action.url }).catch((error) => ({ ok: false, error: error.message }));
    setStatus.call(this, result && result.ok
      ? 'Đã mở trang tải Node.js. Cài bản LTS, tắt hẳn Cocos rồi mở lại, sau đó bấm Cài ffmpeg.'
      : `Không mở được trình duyệt: ${(result && result.error) || ''} - tự vào https://nodejs.org`);
    return !!(result && result.ok);
  }
  if (action.type === 'enable-meshopt') {
    const result = await Editor.Message.request(PACKAGE_NAME, 'model-set-meshopt', { enabled: true }).catch((error) => ({ ok: false, error: error.message }));
    if (!result || !result.ok) {
      setStatus.call(this, (result && result.error) || 'Không bật được meshopt.');
      return false;
    }
    // changed=false: meshopt đã bật sẵn, không có mục lịch sử để hoàn tác.
    this.helpers.offerUndo(result.historyId, result.changed === false
      ? 'meshopt đã bật sẵn.'
      : 'Đã bật meshopt. Build lại là các model Encode chạy được.');
    await refreshSetup.call(this);
    await this.state.model.scan({ silent: true });
    return true;
  }
  if (action.type === 'install-ffmpeg') {
    if (!window.confirm('Chạy "npm install" trong thư mục extension để tải ffmpeg-static (khoảng 80 MB từ npm). Tiếp tục?')) {
      return false;
    }
    setStatus.call(this, 'Đang cài ffmpeg (npm install)...');
    const result = await Editor.Message.request(PACKAGE_NAME, 'audio-install-tools').catch((error) => ({ ok: false, output: error.message }));
    setStatus.call(this, result && result.ok ? 'Đã cài xong ffmpeg.' : `Cài ffmpeg thất bại: ${(result && result.output) || 'không rõ lỗi'}`);
    await refreshSetup.call(this);
    if (result && result.ok) {
      await this.state.audio.scan({ silent: true });
    }
    return !!(result && result.ok);
  }
  return false;
}

// ---------------------------------------------------------------- bản xuất theo mạng

/** Tìm lại bản xuất; chỉ vẽ lại khi có thay đổi (gọi định kỳ vì builder xuất ngay sau khi build xong). */
async function refreshExports() {
  let sets;
  try {
    sets = await findExportSets(Editor.Project.path);
  } catch (error) {
    console.warn(`[${PACKAGE_NAME}] Không tìm được bản xuất:`, error);
    sets = [];
  }
  // playable-ads-builder / playable-ads-adapter / không có: thẻ bản xuất và trang HTML cuối nói rõ tool đọc được gì.
  const exporter = await detectExporter(Editor.Project.path).catch(() => null);
  this.state.exporter = exporter;
  this.state.exporterNote = describeExporterNote(exporter);
  const signature = `${this.state.exporterNote}|${sets.map((set) => `${set.id}:${set.at}:${set.items.map((item) => `${item.channel}=${item.bytes}`).join(',')}:${set.missing.join(',')}`).join('|')}`;
  if (signature === this.state.exportSignature && this.state.exportSets) {
    return;
  }
  this.state.exportSignature = signature;
  this.state.exportSets = sets;
  this.state.exportPrevious = await updateExportHistory(Editor.Project.path, sets).catch(() => new Map());
  renderOverview.call(this);
  // Trang HTML cuối đọc từ bản xuất: có file mới thì vẽ lại (tự nạp số liệu mới).
  if (this.state.step === 'explore' && this.state.explore.source === 'html') {
    exploreTab.render(this, this.helpers);
  }
}

const KIND_LABELS = { html: 'html', zip: 'zip', folder: 'thư mục' };

function renderExportsCard() {
  const sets = this.state.exportSets;
  if (!sets) {
    return '';
  }
  const exporterNote = this.state.exporterNote ? `<div class="ov-note">${escapeHtml(this.state.exporterNote)}</div>` : '';
  if (!sets.length) {
    const adapter = this.state.exporter && this.state.exporter.adapter && !this.state.exporter.builder;
    return `
      <section class="ov-card ov-exports">
        <div class="ov-kicker">Bản xuất theo mạng</div>
        <div class="ov-empty">${adapter
          ? 'Chưa thấy bản xuất nào của playable-ads-adapter. Chạy adapter (menu của adapter hoặc Build có bật adapter): file <code>&lt;Tên&gt;_&lt;Mạng&gt;.html</code>, <code>single-file-3x.html</code> và thư mục <code>&lt;Tên&gt;_&lt;Mạng&gt;/</code> trong build/ sẽ hiện ở đây.'
          : 'Chưa thấy bản xuất nào. Khi Build có tick các mạng (playable-ads-builder), mỗi mạng ra một file <code>&lt;Mạng&gt;_&lt;Tên build&gt;.html / .zip</code> và dung lượng từng mạng sẽ hiện ở đây.'}</div>
        ${exporterNote}
      </section>
    `;
  }
  const set = sets.find((item) => item.id === this.state.exportSetId) || sets[0];
  const previous = this.state.exportPrevious.get(set.id);
  const sizes = set.items.map((item) => item.bytes);
  const max = Math.max(...sizes, 1);
  const range = sizes.length
    ? (Math.min(...sizes) === Math.max(...sizes) ? formatBytes(sizes[0]) : `${formatBytes(Math.min(...sizes))} – ${formatBytes(Math.max(...sizes))}`)
    : '';
  const config = set.config;
  const where = path.relative(Editor.Project.path, set.dir).replace(/\\/g, '/') || '.';

  const rows = set.items.map((item) => {
    const before = previous && previous.items ? previous.items[item.channel] : undefined;
    const delta = before === undefined ? 0 : item.bytes - before;
    const flags = [];
    if (item.stale) {
      flags.push('<span class="exp-flag warn" title="File này cũ hơn bản build hiện tại: lần build mới nhất không xuất lại mạng này">cũ hơn bản build</span>');
    }
    if (config && !item.selected) {
      flags.push('<span class="exp-flag" title="Mạng này không được tick ở lần build hiện tại; file còn lại từ lần xuất trước">không tick lần này</span>');
    }
    const htmlFile = item.kind === 'folder' ? path.join(item.path, 'index.html') : item.path;
    return `
      <div class="exp-row clickable ${config && !item.selected ? 'dim' : ''}" data-html-file="${escapeHtml(htmlFile)}" data-html-set="${escapeHtml(set.id)}" title="${escapeHtml(`${item.name}\nBấm để xem từng phần chiếm bao nhiêu trong file này`)}">
        <span class="exp-channel">${escapeHtml(item.channel)}</span>
        <span class="exp-kind">${escapeHtml(KIND_LABELS[item.kind] || item.kind)}</span>
        <span class="exp-bar"><i style="width:${Math.max(2, (item.bytes / max) * 100).toFixed(1)}%"></i></span>
        <span class="exp-size" title="${escapeHtml(item.zipEstimated ? `Thư mục: zip ước tính (file thô ${formatBytes(item.rawBytes || 0)})` : '')}">${item.zipEstimated ? '≈ ' : ''}${escapeHtml(formatBytes(item.bytes))}</span>
        <span class="exp-delta ${deltaClass(delta)}" title="${before === undefined ? '' : 'So với lần xuất trước'}">${escapeHtml(formatDelta(delta))}</span>
        <span class="exp-flags">${flags.join('')}</span>
      </div>
    `;
  }).join('');
  const missingRows = set.missing.map((channel) => `
    <div class="exp-row missing">
      <span class="exp-channel">${escapeHtml(channel)}</span>
      <span class="exp-kind"></span>
      <span class="exp-missing">Đã tick nhưng chưa có file</span>
    </div>
  `).join('');

  return `
    <section class="ov-card ov-exports">
      <div class="ov-build-head">
        <div>
          <div class="ov-kicker">Bản xuất theo mạng${range ? ` · ${escapeHtml(range)}` : ''}</div>
          <div class="exp-title">
            <b>${escapeHtml(set.label)}</b>
            <span class="muted">${config ? `tên build "${escapeHtml(config.name)}" · tick ${config.channels.length} mạng · ` : ''}${set.at ? escapeHtml(formatTimestamp(new Date(set.at).toISOString())) : 'chưa xuất'}</span>
          </div>
        </div>
        <div class="exp-side">
          ${sets.length > 1 ? `<select class="exp-pick" title="Các thư mục bản xuất (mới nhất trước)">${sets.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === set.id ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}</select>` : ''}
          <button class="ov-button" data-open-path="${escapeHtml(set.dir)}" title="${escapeHtml(where)}">Mở thư mục</button>
        </div>
      </div>
      ${set.items.length ? `<div class="exp-list">${rows}${missingRows}</div>` : `
        <div class="ov-empty">Đã tick ${config ? config.channels.length : 0} mạng cho build "${escapeHtml(config ? config.name : set.label)}" nhưng chưa thấy file nào trong <code>${escapeHtml(where)}</code>. File được tạo khi Build xong.</div>
      `}
      <div class="ov-note">Đây là file thật gửi cho từng mạng: đã nén ảnh / âm thanh và gộp lại nên nhỏ hơn thư mục build ở trên. <b>html</b>: một file duy nhất; <b>zip</b>: gói nén theo yêu cầu của mạng; <b>thư mục</b>: mạng nhận zip của cả thư mục (số là zip ước tính). <b>Bấm một mạng</b> để xem từng phần chiếm bao nhiêu trong file đó (Tìm chỗ nặng → HTML cuối).</div>
      ${exporterNote}
    </section>
  `;
}

/**
 * Bốn thẻ nhỏ, mỗi thẻ một tab Tối ưu (bấm là mở tab đó). Có bản build thì số TRONG BUILD đứng trước
 * (màu ok / warn theo số trong build, cùng bằng chứng với Việc nên làm); asset không vào build chỉ ghi phụ.
 * Model 3D / Module engine dùng đúng số của chip đếm ở các tab (renderOptimizeCounts).
 */
function renderSourceCards() {
  const { texture, audio, model, engine } = this.state;
  const buildIndex = this.state.buildFileCount ? this.state.buildSizeBySource : null;
  const buildBytes = (url) => {
    const info = buildIndex ? buildIndex.get(url) : null;
    return info ? info.bytes : 0;
  };
  const total = (values) => values.reduce((sum, value) => sum + value, 0);
  const mark = (good, text, title = '') => `<span class="${good ? 'ok' : 'warn'}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(text)}</span>`;

  let textureCard = '<div class="ov-line">Đang quét ảnh nguồn...</div>';
  if (texture && texture.scanned) {
    const rows = buildIndex ? texture.rows.filter((row) => buildBytes(row.url) > 0) : texture.rows;
    const enabled = rows.filter((row) => row.enabled).length;
    const outside = texture.rows.length - rows.length;
    // Nhóm "Ảnh" ở thanh trên gồm cả ảnh dựng sẵn của engine (skybox...): nói rõ để hai số khớp nhau.
    const builtinBytes = total(this.state.assetRows
      .filter((row) => row.category === 'texture' && !row.source && row.builtinSources.length)
      .map((row) => row.size));
    textureCard = `
      <div class="ov-big">${rows.length} ảnh${buildIndex ? ' trong build' : ''}</div>
      <div class="ov-line">${mark(enabled === rows.length, `${enabled}/${rows.length} đã bật nén`)}${buildIndex ? ` · ${escapeHtml(formatBytes(total(rows.map((row) => buildBytes(row.url)))))}` : ''}</div>
      ${outside && buildIndex ? `<div class="ov-line" title="Ảnh không dùng tới, hoặc đã ghép vào auto-atlas (nằm trong ảnh của atlas)">${outside} ảnh khác không có file riêng trong build</div>` : ''}
      ${builtinBytes ? `<div class="ov-line">+ ${escapeHtml(formatBytes(builtinBytes))} ảnh dựng sẵn của engine (skybox...)</div>` : ''}
    `;
  }

  let audioCard = '<div class="ov-line">Đang quét audio nguồn...</div>';
  if (audio && audio.scanned) {
    const files = buildIndex ? audio.files.filter((file) => buildBytes(file.url) > 0) : audio.files;
    const mp3 = files.filter((file) => file.isMp3).length;
    const mono = files.filter((file) => file.probe && file.probe.channels === 1).length;
    const outside = audio.files.length - files.length;
    // Builder encode lại mọi audio lúc xuất: MP3 hay chưa không đổi bản xuất, không tô cảnh báo.
    const builder = audio.builderAudio && audio.builderAudio.enabled && audio.builderAudio.bitrateKbps ? audio.builderAudio : null;
    const mp3Text = `${mp3}/${files.length} là MP3`;
    audioCard = `
      <div class="ov-big">${files.length} file${buildIndex ? ' trong build' : ''}</div>
      <div class="ov-line">${builder ? escapeHtml(mp3Text) : mark(mp3 === files.length, mp3Text)} · ${mono} mono${buildIndex ? ` · ${escapeHtml(formatBytes(total(files.map((file) => buildBytes(file.url)))))}` : ''}</div>
      ${builder ? `<div class="ov-line">Bản xuất encode lại ở ${builder.bitrateKbps} kbps</div>` : ''}
      ${outside && buildIndex ? `<div class="ov-line">${outside} file khác không vào build</div>` : ''}
    `;
  }

  let modelCard = '<div class="ov-line">Đang quét model 3D...</div>';
  if (model && model.scanned && !model.ok) {
    modelCard = '<div class="ov-line">Không đọc được model (xem tab Model 3D)</div>';
  } else if (model && model.scanned) {
    const models = model.models || [];
    const infoOf = (item) => (typeof model.infoOf === 'function' ? model.infoOf(item) : { inBuild: false, zipped: 0 });
    const inBuild = buildIndex ? models.filter((item) => infoOf(item).inBuild) : models;
    const todo = typeof model.todoModels === 'function' ? model.todoModels().length : 0;
    const quantized = models.filter((item) => item.compress && item.compress.quantize).length;
    modelCard = buildIndex
      ? `
        <div class="ov-big">${inBuild.length} model trong build</div>
        <div class="ov-line">${mark(!todo, todo ? `${todo} nên xử lý` : 'đã xử lý hết', `Chưa nén mesh, hoặc từ ${HEAVY_TRIANGLES.toLocaleString('vi-VN')} tam giác mà Mesh Simplify chưa giảm`)} · mesh ${escapeHtml(formatBytes(total(inBuild.map((item) => infoOf(item).zipped))))} sau zip</div>
        ${models.length > inBuild.length ? `<div class="ov-line">${models.length - inBuild.length} model khác không vào build</div>` : ''}
      `
      : `
        <div class="ov-big">${models.length} model</div>
        <div class="ov-line">${quantized}/${models.length} đã nén mesh</div>
      `;
  }

  let engineCard = '<div class="ov-line">Đang đọc cấu hình module...</div>';
  if (engine && engine.scanned && engine.ok === false) {
    engineCard = '<div class="ov-line">Chưa đọc được cấu hình Feature Cropping</div>';
  } else if (engine && engine.scanned) {
    const enabled = (engine.entries || []).filter((entry) => entry.enabled);
    const unused = unusedModules(engine);
    const bytes = buildIndex ? total(unused.map((entry) => moduleBuildShare(entry.key, this.state.assetRows).bytes)) : 0;
    engineCard = `
      <div class="ov-big">${enabled.length} module tuỳ chọn bật</div>
      <div class="ov-line">${mark(!unused.length, unused.length ? `${unused.length} không thấy dùng` : 'đều đang dùng')}${bytes ? ` · ≈ ${escapeHtml(formatBytes(bytes))} file riêng trong build` : ''}</div>
      ${unused.length ? `<div class="ov-line">${escapeHtml(unused.map((entry) => entry.label).join(', '))}</div>` : ''}
    `;
  }

  const card = (kind, group, title, body, link) => `
    <section class="ov-card ov-source" data-goto="${kind}" title="Sang bước Tối ưu → ${escapeHtml(title)}">
      <div class="ov-kicker"><span class="legend-dot group-${group}"></span>${escapeHtml(title)}</div>
      ${body}
      <div class="ov-link">${escapeHtml(link)} →</div>
    </section>
  `;
  return [
    card('texture', 'texture', 'Ảnh', textureCard, 'Tối ưu ảnh'),
    card('audio', 'audio', 'Âm thanh', audioCard, 'Tối ưu âm thanh'),
    card('model', 'model', 'Model 3D', modelCard, 'Tối ưu model'),
    card('engine', 'engine', 'Module engine', engineCard, 'Tắt module không dùng'),
  ].join('');
}

function renderTodoCard() {
  const insights = this.state.insights;
  let body;
  if (!insights) {
    body = '<div class="todo-empty">Đang tìm chỗ có thể giảm dung lượng...</div>';
  } else if (!insights.length) {
    body = '<div class="todo-empty">Không thấy việc gì cần làm thêm. Muốn giảm tiếp thì xem file nặng nhất ở bước Tìm chỗ nặng.</div>';
  } else {
    body = insights.map((insight, index) => `
      <div class="todo">
        <span class="todo-num group-${escapeHtml(insight.group)}">${index + 1}</span>
        <div class="todo-main">
          <div class="todo-title">${escapeHtml(insight.title)}</div>
          <div class="todo-detail">${escapeHtml(insight.detail)}</div>
        </div>
        <div class="todo-side">
          <div class="todo-impact ${insight.saving ? '' : 'none'}">${escapeHtml(insight.impact)}</div>
          ${insight.basis ? `<div class="todo-basis">${escapeHtml(insight.basis)}</div>` : ''}
          ${insight.action ? `<button class="ov-button todo-action" data-index="${index}">${escapeHtml(insight.action.label)}</button>` : ''}
        </div>
      </div>
    `).join('');
  }
  return `
    <section class="ov-card ov-todo">
      <div class="ov-todo-head">
        <span class="ov-title">Việc nên làm</span>
        <span class="ov-sub" title="Ước tính theo dung lượng sau zip (bản xuất zip mọi file), gần với phần chiếm trong file gửi mạng. Dòng nhỏ dưới mỗi con số ghi nó tính từ đâu.">${insights && insights.length ? `${insights.length} việc · xếp theo dung lượng ước tính giảm được` : ''}</span>
      </div>
      ${body}
    </section>
  `;
}

// ---------------------------------------------------------------- việc nên làm + build cũ

/**
 * Tính lại "Việc nên làm" sau mỗi lần quét (gộp các lần gọi sát nhau thành một). Đang Phân tích lại thì
 * chờ: analyzeAll gọi lại một lần khi mọi phần đã quét xong.
 */
function scheduleInsights() {
  clearTimeout(this.insightTimer);
  if (this.state.analyzing) {
    return;
  }
  this.insightTimer = setTimeout(() => { void refreshInsights.call(this); }, 200);
}

/** Cấu hình module của engine (module nào cần module nào); nạp một lần, lỗi thì lần sau thử lại. */
async function loadModuleConfig() {
  if (!this.moduleConfig) {
    this.moduleConfig = await Editor.Message.request('engine', 'query-modules-config').catch(() => null);
  }
  return this.moduleConfig;
}

async function refreshInsights() {
  const texture = this.state.texture;
  const audio = this.state.audio;
  // Lần tính trước còn đang zip file thì lần sau (số liệu mới hơn) có thể xong trước: chỉ lần mới nhất được ghi.
  const generation = (this.insightGeneration || 0) + 1;
  this.insightGeneration = generation;
  let insights;
  try {
    insights = await buildInsights({
      projectRoot: Editor.Project.path,
      build: this.state.buildMissing || !this.state.buildFileCount
        ? null
        : { assetRows: this.state.assetRows, buildRoot: this.state.buildRoot },
      textures: texture && texture.scanned ? texture.rows : null,
      // Ảnh đã nén thử ở tab Ảnh (preset đang chọn): phần giảm được tính theo số đó thay vì tỉ lệ chung.
      textureEstimates: texture && texture.estimates instanceof Map ? texture.estimates : null,
      audio: audio && audio.scanned ? audio.files : null,
      builderAudio: audio ? audio.builderAudio : null,
      buildSizeBySource: this.state.buildSizeBySource,
      models: this.state.model && this.state.model.scanned ? this.state.model.models : null,
      // Bỏ qua module đang bị module khác cần, giống tab Module engine.
      moduleConfig: await loadModuleConfig.call(this),
    });
  } catch (error) {
    console.warn(`[${PACKAGE_NAME}] Không tính được gợi ý:`, error);
    insights = [];
  }
  if (generation !== this.insightGeneration) {
    return;
  }
  this.state.insights = insights;
  renderOverview.call(this);
  // Chip đếm trên các tab cũng đọc số liệu build (model trong build nên xử lý...).
  renderOptimizeCounts.call(this);
  // Các tab tô "nên xử lý" theo Việc nên làm: chỉ cần vẽ lại khi danh sách đổi (hoặc tab đã có số liệu
  // build mới chưa vẽ); vẽ tab đang mở, tab khác vẽ khi được mở.
  const signature = JSON.stringify(this.state.insights.map((insight) => [insight.id, insight.saving, insight.title, insight.action]));
  if (signature !== this.insightSignature) {
    this.insightSignature = signature;
    refreshTabs.call(this);
  } else {
    refreshVisibleTab.call(this);
  }
  void checkStaleBuild.call(this);
}

async function runInsightAction(action) {
  switch (action.type) {
    case 'reveal':
      await revealAssetInEditor.call(this, { url: action.url });
      return;
    case 'open-settings':
      await Editor.Message.request('project', 'open-settings', action.tab, action.subTab)
        .catch((error) => setStatus.call(this, `Không mở được Project Settings: ${error.message}`));
      return;
    case 'texture':
      setOptimizeKind.call(this, 'texture');
      switchStep.call(this, 'optimize');
      this.state.texture.selectOnly(action.urls);
      return;
    case 'audio':
      setOptimizeKind.call(this, 'audio');
      switchStep.call(this, 'optimize');
      this.state.audio.selectOnly(action.urls);
      return;
    case 'audio-open':
      setOptimizeKind.call(this, 'audio');
      switchStep.call(this, 'optimize');
      this.state.audio.focusFile(action.url);
      return;
    case 'modules':
      setOptimizeKind.call(this, 'engine');
      switchStep.call(this, 'optimize');
      this.state.engine.selectKeys(action.keys);
      return;
    case 'model':
      setOptimizeKind.call(this, 'model');
      switchStep.call(this, 'optimize');
      this.state.model.selectOnly(action.urls);
      return;
    case 'open-build':
      await openBuildPanel.call(this);
      return;
    default:
  }
}

/**
 * Mở cửa sổ Build, chạy được cả Cocos đời mới lẫn đời cũ:
 *   - 3.8.x mới: cửa sổ Build mở bằng message `open` của package builder (tài liệu Cocos:
 *     `await Editor.Message.request('builder', 'open')`); panel tên `builder` không còn, gọi Panel.open sẽ
 *     chỉ cảnh báo "Panel(builder) is not defined" chứ không ném lỗi.
 *   - Bản cũ: panel `builder` (hoặc `builder.old`).
 * Đọc danh sách message / panel của package builder để chọn đúng cách; không đọc được thì thử lần lượt.
 */
async function openBuildPanel() {
  let info = null;
  try {
    const builder = Editor.Package && typeof Editor.Package.getPackages === 'function'
      ? Editor.Package.getPackages({ name: 'builder' })[0]
      : null;
    info = builder && builder.info ? builder.info : null;
  } catch (_error) {
    info = null;
  }
  const messages = (info && info.contributions && info.contributions.messages) || null;
  const panels = (info && info.panels) || null;

  if (!messages || messages.open) {
    try {
      await Editor.Message.request('builder', 'open');
      return;
    } catch (_error) {
      // Bản cũ không có message open: mở panel bên dưới.
    }
  }
  const panelName = !panels || panels.default ? 'builder' : panels.old ? 'builder.old' : '';
  if (!panelName) {
    setStatus.call(this, 'Không mở được cửa sổ Build: bản Cocos này không có message builder/open hay panel builder. Mở bằng menu Project → Build.');
    return;
  }
  try {
    Editor.Panel.open(panelName);
  } catch (error) {
    setStatus.call(this, `Không mở được cửa sổ Build: ${error.message}. Mở bằng menu Project → Build.`);
  }
}

/**
 * Banner "bản build cũ": có file trong assets/ sửa sau lần build gần nhất (kể cả .meta do tool
 * này ghi) thì số liệu build chưa phản ánh thay đổi đó.
 */
async function checkStaleBuild() {
  const banner = this.$.banner;
  if (this.state.buildMissing || this.state.buildPending || !this.state.buildRoot) {
    banner.classList.add('hidden');
    return;
  }
  const fsPromises = require('fs/promises');
  // settings.json do Cocos ghi mỗi lần build; index.html có thể bị công cụ khác chạm vào.
  const settingsPath = await findBuildSettings(this.state.buildRoot);
  const stat = await fsPromises.stat(settingsPath || path.join(this.state.buildRoot, 'index.html')).catch(() => null);
  if (!stat) {
    banner.classList.add('hidden');
    return;
  }
  const changed = await findAssetsChangedAfter(Editor.Project.path, stat.mtimeMs);
  if (!changed.count) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  banner.innerHTML = `
    <span class="banner-icon">!</span>
    <span class="banner-text">
      ${changed.count} file trong assets/ đã sửa sau lần build gần nhất (${escapeHtml(formatTimestamp(new Date(stat.mtimeMs).toISOString()))}):
      <span class="banner-files">${escapeHtml(changed.samples.join(', '))}${changed.count > changed.samples.length ? '...' : ''}</span>.
      Số liệu build chưa gồm các thay đổi này; build lại là tool tự cập nhật.
    </span>
    <button class="ov-button banner-action">Mở Build</button>
  `;
  banner.querySelector('.banner-action').addEventListener('click', () => { void openBuildPanel.call(this); });
}

// ---------------------------------------------------------------- lịch sử + hoàn tác

async function loadHistory() {
  const result = await Editor.Message.request(PACKAGE_NAME, 'history-list').catch(() => null);
  this.state.history = result && result.ok ? result.entries : [];
  this.state.backups = result && result.ok && Array.isArray(result.backups) ? result.backups : [];
  this.state.keepBackups = result && result.ok && result.keep !== undefined ? result.keep : 5;
  const pending = this.state.history.filter((entry) => !entry.undone && !entry.backupMissing).length;
  this.$.historyCount.textContent = String(pending);
  this.$.historyCount.classList.toggle('hidden', !pending);
  if (!this.$.historyPop.classList.contains('hidden')) {
    renderHistoryPop.call(this);
  }
}

function toggleHistory(open) {
  const show = open === undefined ? this.$.historyPop.classList.contains('hidden') : open;
  this.$.historyPop.classList.toggle('hidden', !show);
  this.$.historyButton.classList.toggle('active', show);
  if (show) {
    renderHistoryPop.call(this);
    void loadHistory.call(this);
  }
}

function renderHistoryPop() {
  const entries = this.state.history.slice().reverse();
  this.$.historyPop.innerHTML = `
    <div class="history-head">
      <b>Lịch sử thay đổi</b>
      <span class="muted">Tool ghi gì vào assets/ hoặc Feature Cropping thì ghi lại ở đây; hoàn tác được từng lần.</span>
    </div>
    ${entries.length ? `
      <ul class="history-list">
        ${entries.map((entry) => `
          <li class="history-item ${entry.undone ? 'undone' : ''}">
            <span class="legend-dot group-${(HISTORY_KINDS[entry.kind] || { group: 'other' }).group}"></span>
            <div class="history-main">
              <div class="history-title">${escapeHtml(entry.title)}</div>
              <div class="history-detail">${escapeHtml(formatTimestamp(entry.at))} · ${escapeHtml(entry.detail || '')}</div>
            </div>
            ${entry.undone
              ? `<span class="history-state" title="${escapeHtml(formatTimestamp(entry.undoneAt))}">Đã hoàn tác</span>`
              : entry.backupMissing
                ? '<span class="history-state" title="Bản dự phòng của lần này đã được dọn / bị xoá nên không khôi phục được nữa">Hết bản dự phòng</span>'
                : `<button class="mini-button" data-undo="${escapeHtml(entry.id)}">Hoàn tác</button>`}
          </li>
        `).join('')}
      </ul>
    ` : '<div class="history-empty">Chưa có thay đổi nào. Mỗi lần tool đổi ảnh, âm thanh, model 3D hay module engine sẽ hiện ở đây kèm nút Hoàn tác.</div>'}
    ${renderBackupFooter.call(this)}
  `;
  for (const button of this.$.historyPop.querySelectorAll('[data-undo]')) {
    button.addEventListener('click', () => { void undoHistory.call(this, button.dataset.undo); });
  }
  const clean = this.$.historyPop.querySelector('.backup-clean');
  if (clean) {
    clean.addEventListener('click', () => { void cleanBackups.call(this); });
  }
}

/** Dòng cuối của Lịch sử: bản dự phòng audio chiếm bao nhiêu + nút dọn. */
function renderBackupFooter() {
  const backups = this.state.backups;
  if (!backups.length) {
    return '';
  }
  const bytes = backups.reduce((sum, backup) => sum + backup.bytes, 0);
  const keep = this.state.keepBackups;
  const label = backups.length > keep ? `Dọn bản cũ (giữ ${keep} lần gần nhất)` : 'Dọn hết bản dự phòng';
  return `
    <div class="history-foot">
      <span class="muted">Bản dự phòng audio (để hoàn tác): <b>${backups.length} lần</b> · ${escapeHtml(formatBytes(bytes))} trong <code>temp/</code></span>
      <button class="mini-button backup-clean">${escapeHtml(label)}</button>
    </div>
  `;
}

async function cleanBackups() {
  const backups = this.state.backups;
  const keep = backups.length > this.state.keepBackups ? this.state.keepBackups : 0;
  const removing = backups.slice(keep);
  if (!removing.length) {
    return;
  }
  const bytes = removing.reduce((sum, backup) => sum + backup.bytes, 0);
  const blocked = removing.reduce((sum, backup) => sum + backup.usedBy.length, 0);
  const message = `Xoá ${removing.length} bản dự phòng audio ${keep ? 'cũ nhất' : ''} (${formatBytes(bytes)})?`
    + (blocked ? `\n${blocked} lần nén / cắt audio trong Lịch sử sẽ không hoàn tác được nữa.` : '\nKhông lần nào trong Lịch sử đang cần các bản này.');
  if (!window.confirm(message)) {
    return;
  }
  const result = await Editor.Message.request(PACKAGE_NAME, 'history-clean-backups', { keep })
    .catch((error) => ({ ok: false, error: error.message }));
  setStatus.call(this, result && result.ok
    ? `Đã xoá ${result.removed} bản dự phòng audio (${formatBytes(result.bytes)}).`
    : `Không dọn được: ${(result && result.error) || 'không rõ lỗi'}`);
  await loadHistory.call(this);
}

/** Báo kết quả ghi assets/ kèm nút Hoàn tác (khi có mục lịch sử). */
function offerUndo(historyId, message) {
  setStatus.call(this, message);
  if (historyId) {
    this.$.statusUndo.dataset.id = historyId;
    this.$.statusUndo.classList.remove('hidden');
  }
  void loadHistory.call(this);
}

async function undoHistory(id) {
  const entry = this.state.history.find((item) => item.id === id);
  if (!entry || entry.undone) {
    return;
  }
  // Loại lạ (main.js tự từ chối) thì không đoán câu giải thích.
  const what = HISTORY_KINDS[entry.kind] ? `\n\n${HISTORY_KINDS[entry.kind].what}` : '';
  if (!window.confirm(`Hoàn tác: ${entry.title}?${entry.detail ? `\n${entry.detail}` : ''}${what}`)) {
    return;
  }
  setStatus.call(this, `Đang hoàn tác: ${entry.title}...`);
  let result = await Editor.Message.request(PACKAGE_NAME, 'history-undo', { id }).catch((error) => ({ ok: false, error: error.message }));
  if (result && result.needsForce) {
    const conflicts = result.conflicts || [];
    // Hoàn tác "Bật meshopt" khi còn model bật Encode: cảnh báo build lỗi, không phải "asset bị sửa tiếp".
    const message = result.warning
      ? [result.warning, ...conflicts.filter((line) => line !== result.warning)].join('\n') + '\n\nVẫn hoàn tác?'
      : `Một số asset đã bị sửa tiếp sau lần này:\n${conflicts.slice(0, 6).join('\n')}\n\nVẫn khôi phục về như trước? Các sửa đổi sau đó sẽ mất.`;
    if (!window.confirm(message)) {
      setStatus.call(this, 'Đã huỷ hoàn tác.');
      return;
    }
    result = await Editor.Message.request(PACKAGE_NAME, 'history-undo', { id, force: true }).catch((error) => ({ ok: false, error: error.message }));
  }
  if (!result || !result.ok) {
    if (result && result.partial) {
      // Một phần đã được ghi lại: mục chưa tính là đã hoàn tác (bấm lại để thử tiếp), nhưng tab phải quét lại.
      setStatus.call(this, `${result.error} · đã khôi phục ${result.restored} mục, bấm Hoàn tác lần nữa để thử lại.`);
      await loadHistory.call(this);
      rescanAfterUndo.call(this, entry);
      return;
    }
    setStatus.call(this, `Không hoàn tác được: ${(result && result.error) || 'không rõ lỗi'}`);
    return;
  }
  const errors = result.errors && result.errors.length ? ` (${result.errors.length} lỗi: ${result.errors[0]})` : '';
  const skipped = result.skipped && result.skipped.length ? ` · bỏ qua ${result.skipped.length} mục không còn asset` : '';
  setStatus.call(this, `Đã hoàn tác: ${entry.title}${errors}${skipped}. Build lại để số liệu build cập nhật.`);
  await loadHistory.call(this);
  rescanAfterUndo.call(this, entry);
}

/** Quét lại tab của mục vừa hoàn tác. Asset-db cần một nhịp để nhận file / meta vừa ghi rồi mới quét lại cho đúng. */
function rescanAfterUndo(entry) {
  setTimeout(() => {
    const kind = HISTORY_KINDS[entry.kind];
    const tab = kind ? this.state[kind.tab] : null;
    if (tab) {
      void tab.scan({ silent: true });
    }
    // Bật / tắt meshopt (engine-modules) cũng đổi cảnh báo của tab Model 3D và "Thiết lập còn thiếu".
    if (entry.kind === 'engine-modules') {
      void this.state.model.scan({ silent: true });
      void refreshSetup.call(this);
    }
  }, 800);
}

// ---------------------------------------------------------------- xu hướng dung lượng qua các lần build

function scanHistoryPath() {
  return path.join(Editor.Project.path, 'temp', PACKAGE_NAME, 'scan-history.json');
}

function readScanHistoryFile() {
  try {
    const json = JSON.parse(require('fs').readFileSync(scanHistoryPath(), 'utf8'));
    return Array.isArray(json.builds) ? json.builds : [];
  } catch (_error) {
    return [];
  }
}

/** Các lần build đã ghi, bỏ các điểm build dở (pruneScanHistory). */
function readScanHistory() {
  return pruneScanHistory(readScanHistoryFile());
}

/** Khoảng thời gian một điểm build dở có thể đứng trước bản build đủ của nó. */
const PARTIAL_BUILD_WINDOW_MS = 2 * 60 * 1000;

/**
 * Bỏ các điểm bản tool cũ lỡ ghi lúc build đang chạy (0 file, hoặc vài KB ngay trước một bản build đủ
 * của cùng thư mục): chúng kéo đáy đường xu hướng về 0 và làm sai "so với lần build trước".
 */
function pruneScanHistory(builds) {
  const kept = new Set();
  const newestKept = new Map();
  for (const item of builds.slice().sort((left, right) => right.builtAt - left.builtAt)) {
    const root = path.resolve(item.buildRoot || '').toLowerCase();
    const newer = newestKept.get(root);
    const partial = !item.files || !item.totalBytes
      || (newer && newer.builtAt - item.builtAt < PARTIAL_BUILD_WINDOW_MS && item.totalBytes < newer.totalBytes * 0.2);
    if (!partial) {
      kept.add(item);
      newestKept.set(root, item);
    }
  }
  return builds.filter((item) => kept.has(item));
}

/**
 * Mỗi bản build (theo thời điểm build = mtime settings.json; chỉ gọi khi đã build xong) ghi một điểm
 * kèm dung lượng từng nhóm; phân tích lại cùng bản build thì không ghi thêm. Giữ 30 lần gần nhất cho
 * MỖI thư mục build (mỗi mạng một thư mục). Điểm build dở còn sót trong file được dọn luôn khi ghi.
 */
async function appendScanHistory(buildRoot, builtAt, totalBytes, files, groups) {
  const raw = readScanHistoryFile();
  const all = pruneScanHistory(raw);
  if (!builtAt) {
    return all;
  }
  let next = all;
  let changed = all.length !== raw.length;
  const sameRoot = (item) => isSameResolvedPath(item.buildRoot || '', buildRoot);
  const builds = all.filter(sameRoot);
  const last = builds[builds.length - 1];
  if (last && Math.abs(last.builtAt - builtAt) < 1000) {
    // Cùng bản build: chỉ bổ sung số theo nhóm nếu lần ghi trước (bản tool cũ) chưa có.
    if (!last.groups && groups) {
      last.groups = groups;
      changed = true;
    }
  } else {
    next = all.filter((item) => !sameRoot(item)).concat([...builds, { buildRoot, builtAt, totalBytes, files, groups }].slice(-30));
    changed = true;
  }
  if (changed) {
    const fsPromises = require('fs/promises');
    await fsPromises.mkdir(path.dirname(scanHistoryPath()), { recursive: true });
    await fsPromises.writeFile(scanHistoryPath(), JSON.stringify({ builds: next }), 'utf8');
  }
  return next;
}

// ---------------------------------------------------------------- mốc so sánh: bản build trước

function baselinePath() {
  return path.join(Editor.Project.path, 'temp', PACKAGE_NAME, 'build-baseline.json');
}

/**
 * Ghi nhớ bản build vừa phân tích và trả về bản build TRƯỚC của cùng thư mục (hoặc null). File lưu
 * { [thư mục build]: { previous, current } }; chỉ xoay khi thời điểm build (mtime settings.json) đổi, giống
 * updateExportHistory (lib/exports.js): mở lại panel / Phân tích lại cùng bản build vẫn so với lần build
 * trước chứ không với chính nó. Mỗi bản: { builtAt, totalBytes, files: { đường dẫn bỏ md5: bytes },
 * groups: { nhóm: bytes } }, đúng dạng diffAgainstSnapshot đọc.
 */
async function rotateBuildBaseline(buildRoot, builtAt, buildFiles, groups) {
  const fsPromises = require('fs/promises');
  let store = {};
  try {
    store = JSON.parse(await fsPromises.readFile(baselinePath(), 'utf8')) || {};
  } catch (_error) {
    store = {};
  }
  const key = path.resolve(buildRoot).toLowerCase();
  const files = {};
  for (const file of buildFiles) {
    files[stableBuildPath(file.relativePath)] = file.size;
  }
  const current = { builtAt, totalBytes: buildFiles.reduce((sum, file) => sum + file.size, 0), files, groups };
  const stored = store[key] || {};
  const sameBuild = !!stored.current && Math.abs(stored.current.builtAt - builtAt) < 1000;
  const previous = (sameBuild ? stored.previous : stored.current) || null;
  // Cùng bản build và số liệu y như lần trước thì khỏi ghi lại.
  if (!sameBuild || JSON.stringify(stored.current.files) !== JSON.stringify(files) || JSON.stringify(stored.current.groups) !== JSON.stringify(groups)) {
    store[key] = previous ? { previous, current } : { current };
    await fsPromises.mkdir(path.dirname(baselinePath()), { recursive: true });
    await fsPromises.writeFile(baselinePath(), JSON.stringify(store), 'utf8');
  }
  return previous;
}

/** Các lần build của thư mục build đang xem, cũ trước. */
function buildsOfCurrentRoot() {
  return this.state.scanHistory
    .filter((item) => isSameResolvedPath(item.buildRoot || '', this.state.buildRoot || ''))
    .sort((left, right) => left.builtAt - right.builtAt);
}

/** Nhóm thay đổi nhiều nhất giữa hai lần build, vd "Ảnh −120 KB, Âm thanh +12 KB". */
function describeGroupChanges(before, after) {
  if (!before || !before.groups || !after || !after.groups) {
    return '';
  }
  return exploreTab.BUILD_GROUPS
    .map((group) => ({ group, delta: (after.groups[group.key] || 0) - (before.groups[group.key] || 0) }))
    .filter((item) => Math.abs(item.delta) >= 1024)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, 3)
    .map((item) => `${item.group.label} ${formatDelta(item.delta)}`)
    .join(', ');
}

/** Đường xu hướng nhỏ cạnh tổng dung lượng: mỗi điểm là một lần build. */
function renderTrend() {
  const builds = buildsOfCurrentRoot.call(this);
  if (builds.length < 2) {
    return '';
  }
  const width = 180;
  const height = 38;
  const values = builds.map((item) => item.totalBytes);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);
  const x = (index) => 4 + (index / (builds.length - 1)) * (width - 8);
  const y = (value) => 4 + (1 - (value - min) / span) * (height - 8);
  const points = builds.map((item, index) => `${x(index).toFixed(1)},${y(item.totalBytes).toFixed(1)}`).join(' ');
  const first = values[0];
  const last = values[values.length - 1];
  return `
    <div class="trend" title="Dung lượng qua ${builds.length} lần build gần nhất">
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <polyline points="${points}" fill="none" stroke="#4e8cf4" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>
        ${builds.map((item, index) => `
          <circle cx="${x(index).toFixed(1)}" cy="${y(item.totalBytes).toFixed(1)}" r="${index === builds.length - 1 ? 3.5 : 2.5}" fill="${index === builds.length - 1 ? '#f1f6ff' : '#4e8cf4'}">
            <title>${escapeHtml(`${formatTimestamp(new Date(item.builtAt).toISOString())}: ${formatBytes(item.totalBytes)} · ${item.files} file${index ? `\n${describeGroupChanges(builds[index - 1], item) || 'các nhóm gần như không đổi'}` : ''}`)}</title>
          </circle>
        `).join('')}
      </svg>
      <div class="trend-label">${builds.length} lần build · <span class="${deltaClass(last - first)}">${escapeHtml(formatDelta(last - first) || '±0')}</span> từ lần đầu</div>
    </div>
  `;
}

// ---------------------------------------------------------------- khung Chi tiết

function renderDetail() {
  const onAudio = this.state.step === 'optimize' && this.state.optimizeKind === 'audio';
  // Khung chi tiết sắp bị thay: tắt trình nghe thử của tab âm thanh (nó tự gắn lại khi quay về).
  if (!onAudio) {
    audioPlayer.stopAll();
    audioTab.stopQuickPlay();
  }
  if (this.state.step === 'overview') {
    return;
  }
  if (this.state.step === 'explore') {
    exploreTab.renderDetail(this, this.helpers);
    return;
  }
  if (onAudio) {
    audioTab.renderDetail(this, this.helpers);
    return;
  }
  if (this.state.optimizeKind === 'model') {
    modelTab.renderDetail(this, this.helpers);
    return;
  }
  if (this.state.optimizeKind === 'engine') {
    engineTab.renderDetail(this, this.helpers);
    return;
  }
  textureTab.renderDetail(this, this.helpers);
}

async function revealAssetInEditor(payload) {
  if (!payload || (!payload.url && !payload.uuid)) {
    setStatus.call(this, 'Dòng này không có asset nguồn trong assets/ để chọn.');
    return;
  }

  try {
    const result = await Editor.Message.request(PACKAGE_NAME, 'reveal-asset', payload);
    if (result && result.ok) {
      setStatus.call(this, `Đã chọn ${payload.url || payload.uuid} trong panel Assets.`);
      return;
    }
  } catch (error) {
    console.warn(`[${PACKAGE_NAME}] reveal-asset thất bại:`, error);
  }

  setStatus.call(this, 'Không chọn được asset trong Editor.');
}

function setStatus(message) {
  this.$.status.textContent = message;
  this.$.statusUndo.classList.add('hidden');
  delete this.$.statusUndo.dataset.id;
}

/**
 * Gắn handler "bấm nút" đúng loại sự kiện: <ui-button> của Cocos chỉ phát 'confirm',
 * còn <button> thường chỉ phát 'click'. Chọn theo tag để đổi HTML không làm chết nút.
 */
function onAction(element, handler) {
  if (!element) {
    return;
  }
  const tag = String(element.tagName || element.nodeName || '').toUpperCase();
  element.addEventListener(tag.startsWith('UI-') ? 'confirm' : 'click', handler);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
