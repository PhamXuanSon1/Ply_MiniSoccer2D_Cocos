'use strict';

/**
 * Bước "Tìm chỗ nặng", hai trang:
 *   - Build web-mobile: dung lượng từng file trong thư mục build.
 *   - HTML cuối: phần mỗi file chiếm trong file <Mạng>_<Tên>.html / .zip (đọc thẳng file đã xuất,
 *     chưa xuất thì mô phỏng playable-ads-builder) - lib/html-export.js, lib/html-sim.js.
 * Mỗi trang hai cách xem cùng một dữ liệu:
 *   - Danh sách (mặc định): gom theo thứ người mới hiểu được (asset nguồn, "Mã engine Cocos",
 *     "Skybox mặc định"...), mỗi dòng có icon (ảnh thật nếu là ảnh, còn lại biểu tượng theo loại),
 *     tên dễ hiểu + lý do / cách giảm.
 *   - Từng file build: đường dẫn kỹ thuật trong build, cho ai cần đào sâu.
 * Khung chi tiết: xem trước, nguồn, ai kéo nó vào build, file gộp, và khung tối ưu ngay asset
 * nguồn (ảnh / audio).
 */

const path = require('path');
const { formatBytes, normalizeDependencyUuid } = require('../../lib/build-scan');
const { isSameResolvedPath } = require('../../lib/fs-utils');
const textureTab = require('./texture-tab');
const audioTab = require('./audio-tab');
const preview = require('./preview');
const thumbs = require('./thumbs');
const { readExportBreakdown, mapToBuildRows } = require('../../lib/html-export');
const { findExtensionDir } = require('../../lib/compat');

const PACKAGE_NAME = 'playable-size-inspector';
const PREFS_KEY = `${PACKAGE_NAME}.explore`;
/** Lựa chọn "ước tính" trong ô chọn bản xuất của trang HTML. */
const SIMULATE = 'simulate';
/** Đường dẫn giả của phần khung playable (không đến từ bản build) trong trang HTML. */
const FRAME_PATH = '(khung playable)';

/**
 * Nhóm loại file build theo cách người mới hiểu được. Thứ tự cũng là thứ tự màu (class
 * group-<key> trong CSS), để một nhóm luôn cùng một màu ở mọi chỗ.
 */
const BUILD_GROUPS = [
  { key: 'data', label: 'Dữ liệu scene/prefab', categories: ['import-json', 'import-binary'], hint: 'JSON/binary mô tả scene, prefab, material, animation, shader' },
  { key: 'engine', label: 'Engine', categories: ['engine-js', 'wasm'], hint: 'Mã engine Cocos; giảm bằng Project Settings → Feature Cropping' },
  { key: 'texture', label: 'Ảnh', categories: ['texture'], hint: 'Ảnh đã build (sau Texture Compress nếu có bật)' },
  { key: 'model', label: 'Model 3D', categories: ['model-bin'], hint: 'Mesh, skeleton, animation của model' },
  { key: 'audio', label: 'Âm thanh', categories: ['audio'], hint: 'File audio đã build' },
  { key: 'font', label: 'Font', categories: ['font'], hint: 'Font TTF/OTF' },
  { key: 'script', label: 'Script game', categories: ['game-js'], hint: 'Mọi script .ts của game gộp lại' },
  { key: 'other', label: 'Khác', categories: [], hint: 'Cấu hình, HTML, CSS...' },
];

const AREA_LABELS = {
  'main bundle': 'bundle main',
  'internal bundle': 'bundle internal (engine)',
  'bootstrap src': 'file khởi động',
  engine: 'engine',
  root: 'gốc build',
};

/** Câu chốt đầu trang: "N thứ nặng nhất chiếm ...". */
const TOP_COUNT = 10;

/** Cột dung lượng: trang Build là byte trong thư mục build (chưa zip), trang HTML là phần trong file đã xuất. */
const BUILD_SIZE_TITLE = 'Dung lượng trong thư mục build web-mobile (chưa zip)';
const HTML_SIZE_TITLE = 'Phần chiếm trong file HTML / zip cuối gửi mạng';

const SELECTORS = {
  exploreSource: '#explore-source',
  exploreSizeBuild: '#explore-size-build',
  exploreSizeHtml: '#explore-size-html',
  exploreExport: '#explore-export',
  exploreSourceHint: '#explore-source-hint',
  exploreSearch: '#explore-search',
  exploreGroup: '#explore-group',
  exploreFilters: '#explore-filters',
  exploreList: '#explore-list',
};

/** Biểu tượng (SVG 24x24, nét theo màu chữ) cho từng loại mục. */
const ICON_SVG = {
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  atlas: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>',
  audio: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  model: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>',
  prefab: '<rect x="3" y="3" width="8" height="7" rx="1.5"/><rect x="13" y="14" width="8" height="7" rx="1.5"/><path d="M7 10v4a3 3 0 0 0 3 3h3"/>',
  scene: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 17l5-6 4 4 3-3 6 6"/>',
  material: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="9" ry="3.5"/>',
  anim: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z"/>',
  data: '<path d="M8 3H7a2 2 0 0 0-2 2v4l-2 3 2 3v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4l2 3-2 3v4a2 2 0 0 1-2 2h-1"/>',
  engine: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  script: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
  font: '<text x="12" y="17" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor" stroke="none">Aa</text>',
  config: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
};

const EXTENSION_ICON = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.bmp': 'image', '.psd': 'image', '.tga': 'image', '.hdr': 'image',
  '.pac': 'atlas', '.plist': 'atlas',
  '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio', '.m4a': 'audio', '.aac': 'audio', '.flac': 'audio',
  '.fbx': 'model', '.glb': 'model', '.gltf': 'model', '.obj': 'model',
  '.prefab': 'prefab', '.scene': 'scene', '.fire': 'scene',
  '.mtl': 'material', '.effect': 'material', '.pmtl': 'material',
  '.anim': 'anim', '.animgraph': 'anim', '.animask': 'anim',
  '.ts': 'script', '.js': 'script',
  '.ttf': 'font', '.otf': 'font', '.fnt': 'font',
  '.json': 'data',
};

const GROUP_ICON = { data: 'data', engine: 'engine', texture: 'image', model: 'model', audio: 'audio', font: 'font', script: 'script', other: 'file' };

/** Loại biểu tượng của một mục (danh sách) hoặc một file build. */
function iconKind(entry) {
  if (entry.kind === 'file') {
    const row = entry.row;
    const source = row.source ? String(row.source).split('@')[0] : '';
    return EXTENSION_ICON[path.extname(source).toLowerCase()] || (row.category === 'config' ? 'config' : GROUP_ICON[groupOf(row.category).key]);
  }
  if (entry.real) {
    return EXTENSION_ICON[path.extname(entry.url).toLowerCase()] || GROUP_ICON[entry.groupKey] || 'file';
  }
  if (entry.itemKey === 'builtin:skybox') {
    return 'image';
  }
  if (entry.itemKey === 'builtin:internal' || entry.itemKey.startsWith('builtin:shader:')) {
    return 'material';
  }
  if (entry.rows.some((row) => row.category === 'config')) {
    return 'config';
  }
  return GROUP_ICON[entry.groupKey] || 'file';
}

/** Ảnh dùng làm icon (chỉ cho mục là ảnh): file ảnh trong build, không có thì ảnh nguồn. */
function thumbFor(entry, kind) {
  if (kind !== 'image' && kind !== 'atlas') {
    return null;
  }
  const rows = entry.kind === 'file' ? [entry.row] : entry.rows;
  const image = rows.filter((row) => thumbs.canThumb(row.fullPath, row.size)).sort((left, right) => right.size - left.size)[0];
  if (image) {
    return { filePath: image.fullPath, bytes: image.size };
  }
  if (entry.real && /^db:\/\/assets\//.test(entry.url) && thumbs.canThumb(entry.url)) {
    return { filePath: path.join(Editor.Project.path, 'assets', shortAssetLabel(entry.url)), bytes: entry.size };
  }
  return null;
}

function iconHtml(entry, groupKey, escapeHtml) {
  const kind = iconKind(entry);
  const thumb = thumbFor(entry, kind);
  const glyph = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON_SVG[kind] || ICON_SVG.file}</svg>`;
  return thumb
    ? `<span class="x-icon has-thumb gi-${groupKey}">${glyph}<img alt="" data-thumb="${escapeHtml(thumbs.key(thumb.filePath, thumb.bytes))}"></span>`
    : `<span class="x-icon gi-${groupKey}">${glyph}</span>`;
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
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...prefs }));
  } catch (_error) {
    // Chỉ là tiện ích nhớ lựa chọn.
  }
}

function groupOf(category) {
  return BUILD_GROUPS.find((group) => group.categories.includes(category)) || BUILD_GROUPS[BUILD_GROUPS.length - 1];
}

/** Gom dung lượng theo nhóm (thanh phân bổ ở Tổng quan, lịch sử theo nhóm). */
function groupRows(assetRows) {
  const groups = BUILD_GROUPS.map((group) => ({ ...group, bytes: 0, files: 0, rows: [] }));
  for (const row of assetRows) {
    const group = groups.find((item) => item.key === groupOf(row.category).key);
    group.bytes += row.size;
    group.files += 1;
    group.rows.push(row);
  }
  return groups.filter((group) => group.files > 0).sort((left, right) => right.bytes - left.bytes);
}

function shortAssetLabel(url) {
  return String(url || '').replace(/^db:\/\/(assets\/)?/, '');
}

/** Asset nguồn để chọn trong panel Assets (luôn là asset gốc, không phải sub-asset). */
function revealTarget(row) {
  return row.source ? { url: String(row.source).split('@')[0], uuid: normalizeDependencyUuid(row.sourceUuid) } : null;
}

/** Nhãn nguồn của một file build: asset nguồn (kèm số asset gộp chung) hoặc giải thích. */
function sourceLabel(row) {
  if (!row.source) {
    return row.sourceNote || 'Không rõ nguồn';
  }
  const others = Math.max(0, (row.packedSourceCount || 0) - 1);
  return `${shortAssetLabel(String(row.source).split('@')[0])}${others ? ` (+${others} asset gộp chung)` : ''}`;
}

/**
 * Mục người mới hiểu được cho một file build: asset nguồn của dự án, hoặc tên gọi cho thứ của
 * engine ("Skybox mặc định", "Shader dựng sẵn builtin-standard", "Mã engine Cocos"...).
 * { key, label, sub, real (asset trong assets/), url }
 */
function friendlyItem(row) {
  if (row.source) {
    const url = String(row.source).split('@')[0];
    const relative = shortAssetLabel(url);
    return { key: `asset:${url}`, label: path.posix.basename(relative), sub: path.posix.dirname(relative), real: true, url };
  }
  const builtins = row.builtinSources || [];
  if (builtins.some((url) => url.includes('/default_skybox/'))) {
    return { key: 'builtin:skybox', label: 'Skybox mặc định của engine', sub: 'ảnh cubemap dựng sẵn' };
  }
  const effects = builtins.filter((url) => url.includes('/effects/')).map((url) => path.posix.basename(url).replace(/\.effect$/, ''));
  if (row.buildArea === 'internal bundle' && builtins.length > 3) {
    return { key: 'builtin:internal', label: `Shader & material dựng sẵn của engine (${builtins.length})`, sub: 'bundle internal' };
  }
  if (effects.length && effects.length <= 3) {
    return { key: `builtin:shader:${effects.join(',')}`, label: `Shader dựng sẵn ${effects.join(', ')}`, sub: 'của engine' };
  }
  if (builtins.length === 1) {
    return { key: `builtin:${builtins[0]}`, label: path.posix.basename(builtins[0]), sub: 'asset dựng sẵn của engine' };
  }
  if (builtins.length) {
    return { key: 'builtin:misc', label: `Asset dựng sẵn khác của engine`, sub: `${builtins.length} asset` };
  }
  // "Mã engine Cocos (không có asset nguồn)" -> tên + phần trong ngoặc làm dòng phụ.
  const note = row.sourceNote || 'Không rõ nguồn';
  const match = /^(.*?)\s*\((.*)\)$/.exec(note);
  return { key: `note:${note}`, label: match ? match[1] : note, sub: match ? match[2] : '' };
}

function matchesQuery(row, query) {
  if (!query) {
    return true;
  }
  const haystack = [
    row.relativePath,
    row.source,
    row.sourceNote,
    friendlyItem(row).label,
    ...(row.packedSources || []).map((source) => source.url),
    ...(row.builtinSources || []),
  ].join('\n').toLowerCase();
  return query.split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

/** Lý do / cách giảm cho từng mục, lấy từ "Việc nên làm" (cùng bằng chứng, không đoán thêm). */
function insightReasons(panel) {
  const reasons = new Map();
  const rowsByPath = new Map((panel.state.assetRows || []).map((row) => [row.relativePath, row]));
  for (const insight of panel.state.insights || []) {
    const keys = [];
    if (insight.id === 'skybox') {
      keys.push('builtin:skybox');
    } else if (insight.id.startsWith('builtin-shader:')) {
      const row = rowsByPath.get(insight.id.slice('builtin-shader:'.length));
      if (row) {
        keys.push(friendlyItem(row).key);
      }
    } else if (insight.id === 'modules') {
      // Tắt module giảm cả mã engine lẫn shader dựng sẵn trong bundle internal.
      keys.push('builtin:internal', 'note:Mã engine Cocos (không có asset nguồn)');
    }
    if (insight.action && insight.action.url && insight.action.type !== 'reveal') {
      keys.push(`asset:${insight.action.url}`);
    }
    for (const url of (insight.action && insight.action.urls) || []) {
      keys.push(`asset:${url}`);
    }
    for (const key of keys) {
      if (!reasons.has(key)) {
        reasons.set(key, insight.title);
      }
    }
  }
  return reasons;
}

// ---------------------------------------------------------------- setup

function setup(panel, helpers) {
  const $ = panel.$;
  const state = {
    /** build | html: trang Build web-mobile hay HTML cuối. */
    source: loadPrefs().source === 'html' ? 'html' : 'build',
    /** list | file */
    group: 'list',
    filter: 'all',
    query: '',
    /** "item:<khoá mục>" hoặc "file:<đường dẫn>". */
    selected: '',
    /**
     * Người dùng vừa đổi trang / cách xem / bộ lọc / từ khoá hoặc mở một file: lần vẽ danh sách kế tiếp (kể cả khi
     * trang HTML nạp xong sau đó) cuộn tới mục đang chọn. Vẽ lại nền (bản build, bản xuất mới) không cuộn.
     */
    scrollPending: false,
  };
  panel.state.explore = state;
  /**
   * Số liệu trang HTML: { key, status: idle|loading|ready|error, choice (bản xuất đang nạp: đường dẫn
   * hoặc SIMULATE), userChoice (người dùng tự chọn ở ô bản xuất / bấm một mạng ở Tổng quan; '' = tự
   * chọn), setId (bộ bản xuất mở từ Tổng quan), rows, total, frameBytes, estimated, label, note, error }.
   */
  panel.state.html = { key: '', status: 'idle', choice: '', userChoice: '', setId: '', rows: null, badFiles: new Map() };

  for (const button of $.exploreSource.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      if (state.source === button.dataset.source) {
        return;
      }
      state.source = button.dataset.source;
      savePrefs({ source: state.source });
      // Khoá mục giống nhau ở hai trang: giữ nguyên mục đang chọn.
      state.scrollPending = true;
      render(panel, helpers);
      panel.renderDetail();
    });
  }
  $.exploreExport.addEventListener('change', () => {
    panel.state.html.userChoice = $.exploreExport.value;
    state.scrollPending = true;
    render(panel, helpers);
  });

  let searchTimer = null;
  $.exploreSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = String($.exploreSearch.value || '').trim().toLowerCase();
      state.scrollPending = true;
      render(panel, helpers);
    }, 120);
  });

  for (const button of $.exploreGroup.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      // Đổi cách xem: render tự chọn lại mục nặng nhất nếu mục đang chọn không còn.
      state.group = button.dataset.group;
      state.scrollPending = true;
      render(panel, helpers);
    });
  }

  $.exploreList.tabIndex = 0;
  $.exploreList.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const keys = [...$.exploreList.querySelectorAll('[data-key]')].map((element) => element.dataset.key);
      if (!keys.length) {
        return;
      }
      const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
      const current = keys.indexOf(state.selected);
      const next = current < 0
        ? (forward ? 0 : keys.length - 1)
        : Math.max(0, Math.min(keys.length - 1, current + (forward ? 1 : -1)));
      select(panel, helpers, keys[next]);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      revealSelected(panel, helpers);
    }
  });
}

/**
 * Bản xuất đọc được (html / zip / thư mục), không cũ hơn bản build trước rồi html trước. Bộ bản xuất: bộ
 * người dùng mở từ Tổng quan (bấm một mạng), rồi bộ của bản build đang xem, rồi bộ đang chọn ở Tổng quan.
 */
function exportCandidates(panel) {
  const sets = panel.state.exportSets || [];
  const buildRoot = panel.state.buildRoot || '';
  const setId = panel.state.html.setId;
  const set = (setId && sets.find((item) => item.id === setId))
    || (buildRoot && sets.find((item) => item.config && isSameResolvedPath(item.config.buildDir, buildRoot)))
    || sets.find((item) => item.id === panel.state.exportSetId)
    || sets[0];
  if (!set) {
    return [];
  }
  return set.items
    .filter((item) => item.kind === 'html' || item.kind === 'zip' || item.kind === 'folder')
    .map((item) => ({ ...item, file: item.kind === 'folder' ? path.join(item.path, 'index.html') : item.path }))
    .sort((left, right) => (left.stale - right.stale) || (left.kind === 'html' ? -1 : 0) - (right.kind === 'html' ? -1 : 0));
}

/**
 * Mô phỏng chỉ làm được cho playable-ads-builder (làm lại đúng các bước của nó): dự án dùng playable-ads-adapter
 * hoặc chưa có công cụ xuất thì không đưa lựa chọn ước tính (con số sẽ không phải của file mạng nhận).
 */
function canSimulate(panel) {
  const exporter = panel.state.exporter;
  if (exporter) {
    // Cần chính extension (playable-engine, sharp của nó), không chỉ file cấu hình còn sót lại.
    return !!(exporter.builder && exporter.builder.dir);
  }
  return !!findExtensionDir(Editor.Project.path, 'playable-ads-builder');
}

/** File đã thử đọc mà tool không nhận ra định dạng (khoá theo đường dẫn + mtime): tự chọn bỏ qua chúng. */
function isBadFile(panel, item) {
  return panel.state.html.badFiles.get(item.file) === item.mtimeMs;
}

/**
 * Bản xuất trang HTML đang xem. Người dùng đã tự chọn và lựa chọn đó còn thì giữ; không thì mỗi lần vẽ
 * chọn lại: bản xuất html mới, rồi zip, rồi ước tính - để file builder vừa xuất xong tự thay số ước tính.
 * Không có bản xuất đọc được và không mô phỏng được: '' (trang HTML báo lý do).
 */
function htmlChoice(panel) {
  const candidates = exportCandidates(panel);
  const wanted = panel.state.html.userChoice;
  if ((wanted === SIMULATE && canSimulate(panel)) || (wanted && wanted !== SIMULATE && candidates.some((item) => item.file === wanted))) {
    return wanted;
  }
  const fresh = candidates.find((item) => !item.stale && !isBadFile(panel, item));
  if (fresh) {
    return fresh.file;
  }
  if (canSimulate(panel)) {
    return SIMULATE;
  }
  // Không mô phỏng được: bản xuất cũ hơn bản build vẫn hơn là không có gì (ghi chú "cũ hơn bản build").
  const any = candidates.find((item) => !isBadFile(panel, item));
  return any ? any.file : '';
}

/** Lý do trang HTML trống khi không có lựa chọn nào. */
function noHtmlReason(panel) {
  const note = panel.state.exporterNote || '';
  return `Chưa có bản xuất nào đọc được cho bản build này. ${note || 'Xuất playable (Build có tick mạng) rồi mở lại trang này.'}`;
}

/** Nạp số liệu trang HTML (đọc bản xuất hoặc mô phỏng) khi lựa chọn / bản build / bản xuất đổi. */
async function ensureHtml(panel, helpers) {
  const html = panel.state.html;
  const choice = htmlChoice(panel);
  const candidate = exportCandidates(panel).find((item) => item.file === choice);
  const key = `${choice}|${candidate ? candidate.mtimeMs : ''}|${panel.state.buildSignature}`;
  if (html.key === key || !(panel.state.assetRows || []).length) {
    return;
  }
  if (!choice) {
    Object.assign(html, { key, choice, status: 'error', rows: null, error: noHtmlReason(panel) });
    render(panel, helpers);
    return;
  }
  Object.assign(html, { key, choice, status: 'loading', rows: null, error: '' });
  render(panel, helpers);
  try {
    let breakdown;
    if (choice === SIMULATE) {
      breakdown = await Editor.Message.request(PACKAGE_NAME, 'html-simulate', { buildRoot: panel.state.buildRoot });
      if (!breakdown || !breakdown.ok) {
        throw new Error((breakdown && breakdown.error) || 'Không mô phỏng được.');
      }
    } else {
      breakdown = await readExportBreakdown(choice);
    }
    if (html.key !== key) {
      return;
    }
    if (breakdown.unsupported) {
      // Định dạng tool không đọc được: tự chọn thì bỏ file này, thử bản xuất khác / ước tính; người dùng tự chọn thì báo lý do.
      if (candidate) {
        html.badFiles.set(candidate.file, candidate.mtimeMs);
      }
      if (html.userChoice === choice) {
        Object.assign(html, { status: 'error', error: breakdown.reason || 'Không nhận ra định dạng file này.' });
        render(panel, helpers);
        return;
      }
      html.key = '';
      void ensureHtml(panel, helpers);
      return;
    }
    const mapped = mapToBuildRows(panel.state.assetRows, breakdown);
    // Số trong HTML thay cho số build; chênh lệch so với lần build trước không áp cho trang này.
    const rows = mapped.rows.map((row) => ({ ...row, deltaBytes: 0 }));
    rows.push({
      relativePath: FRAME_PATH,
      name: 'Khung playable',
      size: mapped.frameBytes,
      buildSize: 0,
      category: 'other',
      buildArea: 'root',
      extension: '',
      source: '',
      sourceNote: 'Khung playable (thư viện giải nén zip, launcher, SDK của mạng, index.html / style.css)',
      builtinSources: [],
      packedSources: [],
      includedBy: [],
    });
    const settings = breakdown.settings;
    // Bản xuất từ bản build khác (tên build cũ...): phần không khớp dồn vào "Khung playable", nói rõ để không hiểu nhầm.
    const mismatch = breakdown.files.length && mapped.rows.length < breakdown.files.length * 0.6
      ? ` · chỉ khớp ${mapped.rows.length}/${breakdown.files.length} file của bản build đang xem: bản xuất này có thể từ bản build khác`
      : '';
    const kindNote = breakdown.folder
      ? ` · thư mục: dung lượng là zip ước tính của cả thư mục${breakdown.tool === 'adapter' ? ' (playable-ads-adapter)' : ''}`
      : breakdown.tool === 'adapter' ? ' (playable-ads-adapter)' : '';
    Object.assign(html, {
      status: 'ready',
      rows,
      total: rows.reduce((sum, row) => sum + row.size, 0),
      frameBytes: mapped.frameBytes,
      estimated: !!breakdown.estimated,
      label: candidate ? `${candidate.channel} (${candidate.kind})` : 'Ước tính',
      fileBytes: breakdown.totalBytes,
      note: choice === SIMULATE
        ? `Ước tính: mô phỏng playable-ads-builder trên bản build${settings ? ` (ảnh ${settings.compression.type === 'none' ? 'không nén' : settings.compression.type === 'lossless' ? 'WebP lossless' : `WebP ${settings.compression.quality}`}, audio ${settings.audio.enabled ? `MP3 ${settings.audio.bitrate} kbps` : 'giữ nguyên'})` : ''}${(breakdown.warnings || []).length ? `. ${breakdown.warnings.join(' ')}` : ''}`
        : `${breakdown.estimated ? 'Ước tính từ' : 'Số thật đọc từ'} ${path.relative(Editor.Project.path, choice).replace(/\\/g, '/')}${kindNote}${candidate && candidate.stale ? ' (file này cũ hơn bản build: số liệu có thể lệch)' : ''}${mismatch}`,
    });
  } catch (error) {
    if (html.key === key) {
      Object.assign(html, { status: 'error', error: error.message || String(error) });
    }
  }
  render(panel, helpers);
  if (panel.state.step === 'explore') {
    panel.renderDetail();
  }
}

/** Dòng dữ liệu của trang đang xem: file build, hoặc (trang HTML) phần trong HTML của từng file. */
function sourceRows(panel) {
  const state = panel.state.explore;
  if (state && state.source === 'html') {
    return panel.state.html.status === 'ready' ? panel.state.html.rows : [];
  }
  return panel.state.assetRows || [];
}

/** Thanh chọn trang + bản xuất + ghi chú nguồn số liệu. */
function renderSource(panel, helpers) {
  const { escapeHtml } = helpers;
  const $ = panel.$;
  const state = panel.state.explore;
  const html = panel.state.html;
  for (const button of $.exploreSource.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.source === state.source);
  }
  $.exploreSizeBuild.textContent = panel.state.totalBuildBytes ? formatBytes(panel.state.totalBuildBytes) : '';
  $.exploreSizeHtml.textContent = html.status === 'ready' ? `${html.estimated ? '≈ ' : ''}${formatBytes(html.total)}` : '';
  const onHtml = state.source === 'html';
  $.exploreExport.classList.toggle('hidden', !onHtml);
  if (onHtml) {
    const candidates = exportCandidates(panel);
    const choice = htmlChoice(panel);
    $.exploreExport.innerHTML = candidates.map((item) => `<option value="${escapeHtml(item.file)}" ${item.file === choice ? 'selected' : ''}>${escapeHtml(`${item.channel} · ${item.kind === 'folder' ? 'thư mục' : item.kind} · ${item.zipEstimated ? '≈ ' : ''}${formatBytes(item.bytes)}${item.stale ? ' · cũ hơn bản build' : ''}${isBadFile(panel, item) ? ' · không đọc được' : ''}`)}</option>`).join('')
      + (canSimulate(panel) ? `<option value="${SIMULATE}" ${choice === SIMULATE ? 'selected' : ''}>Ước tính từ bản build (mô phỏng builder)</option>` : '');
    $.exploreExport.classList.toggle('hidden', !$.exploreExport.options.length);
  }
  $.exploreSourceHint.textContent = !onHtml
    ? (canSimulate(panel)
      ? 'Thư mục build web-mobile, trước khi playable-ads-builder nén ảnh WebP, encode lại audio và gói zip.'
      : 'Thư mục build web-mobile, trước khi công cụ xuất playable nén và gói lại thành file gửi mạng.')
    : html.status === 'ready' ? html.note
      : html.status === 'loading' ? (html.choice === SIMULATE ? 'Đang mô phỏng builder (nén ảnh WebP, encode audio, gói zip)...' : 'Đang đọc file đã xuất...')
        : html.status === 'error' ? `Không đọc được: ${html.error}` : '';
}

/** Các file đang hiện (theo trang, từ khoá và nhóm lọc). */
function visibleRows(panel) {
  const state = panel.state.explore;
  return sourceRows(panel)
    .filter((row) => matchesQuery(row, state.query))
    .filter((row) => state.filter === 'all' || groupOf(row.category).key === state.filter);
}

/** Gộp file build thành mục dễ hiểu, nặng nhất trước. */
function buildItems(panel) {
  const map = new Map();
  for (const row of visibleRows(panel)) {
    const friendly = friendlyItem(row);
    let item = map.get(friendly.key);
    if (!item) {
      item = { ...friendly, kind: 'item', key: `item:${friendly.key}`, itemKey: friendly.key, size: 0, rows: [], groupKey: groupOf(row.category).key, reveal: revealTarget(row) };
      map.set(friendly.key, item);
    }
    item.size += row.size;
    item.rows.push(row);
  }
  const items = [...map.values()].sort((left, right) => right.size - left.size);
  // Màu của mục = nhóm chiếm nhiều byte nhất trong nó.
  for (const item of items) {
    const groups = groupRows(item.rows);
    item.groupKey = groups[0] ? groups[0].key : 'other';
  }
  return items;
}

function currentEntries(panel) {
  if (panel.state.explore.group === 'file') {
    // Nặng nhất trước (trang HTML: theo dung lượng trong HTML, khác thứ tự của bản build).
    return visibleRows(panel)
      .map((row) => ({ kind: 'file', key: `file:${row.relativePath}`, size: row.size, row }))
      .sort((left, right) => right.size - left.size);
  }
  return buildItems(panel);
}

// ---------------------------------------------------------------- vẽ

function render(panel, helpers) {
  const { escapeHtml } = helpers;
  const $ = panel.$;
  const state = panel.state.explore;

  for (const button of $.exploreGroup.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.group === state.group);
  }
  renderSource(panel, helpers);

  if (state.source === 'html' && (panel.state.assetRows || []).length) {
    void ensureHtml(panel, helpers);
    const html = panel.state.html;
    if (html.status !== 'ready') {
      $.exploreFilters.innerHTML = '';
      $.exploreList.className = 'panel-body empty';
      $.exploreList.textContent = html.status === 'error'
        ? `Không đọc được số liệu HTML: ${html.error}`
        : (html.choice === SIMULATE ? 'Đang mô phỏng playable-ads-builder trên bản build...' : 'Đang đọc file HTML đã xuất...');
      return;
    }
  }

  if (!panel.state.assetRows || !panel.state.assetRows.length) {
    $.exploreFilters.innerHTML = '';
    $.exploreList.className = 'panel-body empty';
    $.exploreList.textContent = panel.state.buildMissing
      ? 'Chưa có bản build. Build platform web-mobile, tool tự phân tích ngay khi build xong.'
      : panel.state.buildPending
        ? 'Bản build chưa xong (đang build). Build xong là tool tự phân tích.'
        : 'Đang phân tích bản build...';
    return;
  }

  // Chip lọc theo nhóm (cũng là chú thích màu của icon / thanh dung lượng).
  const queryRows = sourceRows(panel).filter((row) => matchesQuery(row, state.query));
  const groups = groupRows(queryRows);
  $.exploreFilters.innerHTML = `
    <button class="filter-chip ${state.filter === 'all' ? 'active' : ''}" data-filter="all">Tất cả</button>
    ${groups.map((group) => `
      <button class="filter-chip ${state.filter === group.key ? 'active' : ''}" data-filter="${group.key}" title="${escapeHtml(`${group.hint} · ${group.files} file`)}">
        <i class="legend-dot group-${group.key}"></i>${escapeHtml(group.label)} <span>${escapeHtml(formatBytes(group.bytes))}</span>
      </button>
    `).join('')}
  `;
  for (const chip of $.exploreFilters.querySelectorAll('.filter-chip')) {
    chip.addEventListener('click', () => {
      state.filter = chip.dataset.filter;
      state.scrollPending = true;
      render(panel, helpers);
    });
  }

  const entries = currentEntries(panel);
  if (!entries.length) {
    state.scrollPending = false;
    $.exploreList.className = 'panel-body empty';
    $.exploreList.textContent = state.query ? `Không có gì khớp "${state.query}".` : 'Không có file nào trong nhóm này.';
    return;
  }

  // Chưa chọn gì (hoặc mục đang chọn đã bị lọc mất): chọn sẵn mục nặng nhất để khung Chi tiết không trống.
  if (!entries.some((entry) => entry.key === state.selected)) {
    state.selected = entries[0].key;
    if (panel.state.step === 'explore') {
      panel.renderDetail();
    }
  }

  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  const topCount = Math.min(TOP_COUNT, entries.length);
  const top = entries.slice(0, topCount).reduce((sum, entry) => sum + entry.size, 0);
  const summary = `
    <div class="x-summary">
      <b>${topCount} ${state.group === 'file' ? 'file' : 'thứ'} nặng nhất chiếm ${escapeHtml(formatBytes(top))}</b>
      <span>(${Math.round((top / Math.max(total, 1)) * 100)}% của ${escapeHtml(formatBytes(total))}${state.filter === 'all' && !state.query ? '' : ' đang lọc'})</span>
      <span class="muted">· ${state.source === 'html' ? 'dung lượng trong file HTML' : 'dung lượng trong thư mục build (chưa zip)'} · bấm một dòng để xem chi tiết, nháy đúp để chọn trong Assets</span>
    </div>
  `;

  const max = Math.max(...entries.map((entry) => entry.size), 1);
  const reasons = state.group === 'list' ? insightReasons(panel) : new Map();
  const onHtml = state.source === 'html';
  const rows = entries.map((entry, index) => (entry.kind === 'file'
    ? renderFileRow(panel, helpers, entry, index, max)
    : renderItemRow(helpers, entry, index, max, total, reasons, onHtml))).join('');
  $.exploreList.className = `panel-body xlist mode-${state.group}`;
  $.exploreList.innerHTML = summary + rows;
  wireRows(panel, helpers);
  thumbs.attach($.exploreList);
}

/** Dung lượng build của các dòng (trang HTML giữ ở buildSize). */
function buildBytesOf(rows) {
  return rows.reduce((sum, row) => sum + (row.buildSize !== undefined ? row.buildSize : row.size), 0);
}

function renderItemRow(helpers, item, index, max, total, reasons, onHtml = false) {
  const { escapeHtml } = helpers;
  const reason = reasons.get(item.itemKey);
  const built = onHtml ? buildBytesOf(item.rows) : 0;
  const sub = [item.sub, `${item.rows.length} file`].filter(Boolean).join(' · ');
  return `
    <div class="xitem" data-key="${escapeHtml(item.key)}" title="${item.real ? 'Nháy đúp để chọn asset trong panel Assets' : ''}">
      <span class="x-idx">${index + 1}</span>
      ${iconHtml(item, item.groupKey, escapeHtml)}
      <div class="x-main">
        <div class="x-name">${escapeHtml(item.label)}</div>
        <div class="x-sub ${reason ? 'reason' : ''}" title="${escapeHtml(reason || sub)}">${escapeHtml(reason || sub)}</div>
      </div>
      <div class="x-size"><div class="x-size-top" title="${onHtml ? HTML_SIZE_TITLE : BUILD_SIZE_TITLE}">${escapeHtml(formatBytes(item.size))}</div><div class="x-bar"><i class="group-${item.groupKey}" style="width:${Math.max(1, (item.size / max) * 100).toFixed(1)}%"></i></div>${onHtml && built ? `<div class="x-built" title="Dung lượng trong thư mục build web-mobile">build ${escapeHtml(formatBytes(built))}</div>` : ''}</div>
      <span class="x-pct">${Math.round((item.size / Math.max(total, 1)) * 100)}%</span>
    </div>
  `;
}

function renderFileRow(panel, helpers, entry, index, max) {
  const { escapeHtml, formatDelta, deltaClass } = helpers;
  const row = entry.row;
  const group = groupOf(row.category);
  const delta = panel.state.diff && row.deltaBytes ? `<span class="x-delta ${deltaClass(row.deltaBytes)}">${escapeHtml(formatDelta(row.deltaBytes))}</span>` : '';
  return `
    <div class="xrow" data-key="${escapeHtml(entry.key)}" title="${row.source ? 'Nháy đúp để chọn asset nguồn trong panel Assets' : ''}">
      <span class="x-idx">${index + 1}</span>
      ${iconHtml(entry, group.key, escapeHtml)}
      <div class="x-main">
        <div class="x-path" title="${escapeHtml(row.relativePath)}">${escapeHtml(row.relativePath)}</div>
        <div class="x-sub ${row.source ? 'src' : 'note'}" title="${escapeHtml(sourceLabel(row))}">${row.source ? '← ' : ''}${escapeHtml(sourceLabel(row))}</div>
      </div>
      <span class="x-type"><i class="legend-dot group-${group.key}"></i>${escapeHtml(group.label)}</span>
      <div class="x-size"><div class="x-size-top" title="${panel.state.explore.source === 'html' ? HTML_SIZE_TITLE : BUILD_SIZE_TITLE}">${escapeHtml(formatBytes(row.size))}${delta}</div><div class="x-bar"><i class="group-${group.key}" style="width:${Math.max(1, (row.size / max) * 100).toFixed(1)}%"></i></div>${row.buildSize ? `<div class="x-built" title="Dung lượng trong thư mục build web-mobile">build ${escapeHtml(formatBytes(row.buildSize))}</div>` : ''}</div>
    </div>
  `;
}

function wireRows(panel, helpers) {
  for (const element of panel.$.exploreList.querySelectorAll('[data-key]')) {
    element.addEventListener('click', () => {
      select(panel, helpers, element.dataset.key);
      panel.$.exploreList.focus({ preventScroll: true });
    });
    element.addEventListener('dblclick', () => {
      select(panel, helpers, element.dataset.key);
      revealSelected(panel, helpers);
    });
  }
  markSelected(panel);
  // Chỉ cuộn khi người dùng vừa đổi gì đó (scrollPending); vẽ lại nền giữ chỗ đang cuộn tới.
  const state = panel.state.explore;
  if (state.scrollPending) {
    state.scrollPending = false;
    scrollToSelected(panel);
  }
}

function scrollToSelected(panel) {
  const selectedElement = panel.$.exploreList.querySelector('[data-key].selected');
  if (selectedElement && typeof selectedElement.scrollIntoView === 'function') {
    selectedElement.scrollIntoView({ block: 'nearest' });
  }
}

function markSelected(panel) {
  for (const element of panel.$.exploreList.querySelectorAll('[data-key]')) {
    element.classList.toggle('selected', element.dataset.key === panel.state.explore.selected);
  }
}

function select(panel, helpers, key) {
  panel.state.explore.selected = key;
  markSelected(panel);
  scrollToSelected(panel);
  panel.renderDetail();
}

/** Mở bước "Tìm chỗ nặng" ở đúng một file build (từ danh sách file trong khung chi tiết). */
function focusFile(panel, helpers, relativePath) {
  const state = panel.state.explore;
  state.group = 'file';
  state.filter = 'all';
  state.query = '';
  panel.$.exploreSearch.value = '';
  state.selected = `file:${relativePath}`;
  state.scrollPending = true;
  render(panel, helpers);
}

/**
 * Mở trang HTML cuối của bước "Tìm chỗ nặng" ở đúng một file đã xuất (từ thẻ Bản xuất ở Tổng quan).
 * `setId`: bộ bản xuất chứa file đó, để mở đúng file kể cả khi là bộ của bản build khác (tên build cũ).
 */
function showHtml(panel, helpers, file, setId = '') {
  const state = panel.state.explore;
  state.source = 'html';
  savePrefs({ source: 'html' });
  if (file) {
    Object.assign(panel.state.html, { userChoice: file, setId: setId || '' });
  }
  state.scrollPending = true;
  render(panel, helpers);
}

/** Mở bước "Tìm chỗ nặng" lọc sẵn theo một nhóm (từ thanh phân bổ ở Tổng quan). */
function showGroup(panel, helpers, groupKey) {
  const state = panel.state.explore;
  state.filter = groupKey;
  // render tự chọn sẵn mục nặng nhất của nhóm.
  state.selected = '';
  state.scrollPending = true;
  render(panel, helpers);
}

/** Mục đang chọn; mặc định (chưa chọn gì) là mục nặng nhất. */
function selectedEntry(panel) {
  const state = panel.state.explore;
  if (!state || !state.selected) {
    return null;
  }
  return currentEntries(panel).find((entry) => entry.key === state.selected) || null;
}

function revealSelected(panel, helpers) {
  const entry = selectedEntry(panel);
  const target = entry && (entry.kind === 'file' ? revealTarget(entry.row) : entry.reveal);
  if (target && (entry.kind === 'file' || entry.real)) {
    void helpers.revealAsset(target);
  } else {
    helpers.setStatus('Mục này là của engine / sinh lúc build, không có asset trong assets/ để chọn.');
  }
}

// ---------------------------------------------------------------- khung chi tiết

function renderDetail(panel, helpers) {
  const entry = selectedEntry(panel);
  const detail = panel.$.detail;
  if (!entry) {
    detail.className = 'detail empty';
    detail.textContent = panel.state.assetRows && panel.state.assetRows.length
      ? 'Chọn một dòng bên trái để xem nó là gì, từ đâu ra và giảm thế nào.'
      : 'Chưa có dữ liệu build.';
    return;
  }
  if (entry.kind === 'file') {
    renderFileDetail(panel, helpers, entry.row);
  } else {
    renderItemDetail(panel, helpers, entry);
  }
  for (const button of detail.querySelectorAll('[data-reveal-url]')) {
    button.addEventListener('click', () => {
      void helpers.revealAsset({ url: button.dataset.revealUrl, uuid: button.dataset.revealUuid || '' });
    });
  }
  for (const button of detail.querySelectorAll('[data-insight-id]')) {
    button.addEventListener('click', () => {
      const insight = (panel.state.insights || []).find((entry) => entry.id === button.dataset.insightId);
      if (insight && insight.action) {
        void helpers.runInsightAction(insight.action);
      }
    });
  }
  for (const element of detail.querySelectorAll('[data-file]')) {
    element.addEventListener('click', () => {
      focusFile(panel, helpers, element.dataset.file);
      panel.renderDetail();
    });
  }
}

function fileListHtml(rows, escapeHtml, limit = 15) {
  const shown = rows.slice().sort((left, right) => right.size - left.size).slice(0, limit);
  return `
    <ul class="d-files">
      ${shown.map((row) => `
        <li data-file="${escapeHtml(row.relativePath)}" title="Xem file build này">
          <span class="d-file-name">${escapeHtml(row.relativePath.split('/').pop())}</span>
          <span class="d-file-size">${escapeHtml(formatBytes(row.size))}</span>
        </li>
      `).join('')}
    </ul>
    ${rows.length > limit ? `<div class="detail-note">... và ${rows.length - limit} file nhỏ hơn.</div>` : ''}
  `;
}

function revealButton(target, escapeHtml, label = 'Chọn trong Assets') {
  return target
    ? `<button class="mini-button" data-reveal-url="${escapeHtml(target.url)}" data-reveal-uuid="${escapeHtml(target.uuid || '')}">${escapeHtml(label)}</button>`
    : '';
}

/** Lý do / cách giảm (từ "Việc nên làm"), kèm nút đưa tới đúng chỗ sửa nếu có. */
function reasonBox(insight, escapeHtml) {
  const action = insight.action && insight.action.type !== 'reveal' ? insight.action : null;
  return `
    <div class="d-reason">
      <div class="todo-title">${escapeHtml(insight.title)}</div>
      <div class="todo-detail">${escapeHtml(insight.detail)}</div>
      ${action ? `<button class="mini-button d-reason-action" data-insight-id="${escapeHtml(insight.id)}">${escapeHtml(action.label)}</button>` : ''}
    </div>
  `;
}

function renderItemDetail(panel, helpers, item) {
  const { escapeHtml } = helpers;
  const onHtml = panel.state.explore.source === 'html';
  const total = (onHtml ? panel.state.html.total : panel.state.totalBuildBytes) || 1;
  const reason = insightReasons(panel).get(item.itemKey);
  const insight = reason ? (panel.state.insights || []).find((entry) => entry.title === reason) : null;
  const first = item.rows[0];
  const category = groupOf(first.category).key;
  const sourceUrl = item.real ? item.url : '';
  const hasPreview = item.real && item.rows.length && preview.getPreviewKind(path.extname(item.url));
  panel.$.detail.className = 'detail';
  panel.$.detail.innerHTML = `
    <div class="detail-body">
      ${hasPreview ? preview.renderStage({ id: 'detail-item-preview', filePath: path.join(Editor.Project.path, 'assets', shortAssetLabel(item.url)), title: 'Xem trước', escapeHtml }) : ''}
      ${sourceUrl ? textureTab.renderSourceBox({ source: sourceUrl, category }, helpers) : ''}
      ${sourceUrl ? audioTab.renderSourceBox({ source: sourceUrl, category }, helpers) : ''}
      <div class="d-head">
        <div class="d-title"><i class="legend-dot group-${item.groupKey}"></i>${escapeHtml(item.label)}</div>
        ${item.sub ? `<div class="muted small mono">${escapeHtml(item.sub)}</div>` : ''}
        <div class="d-chips">
          <span class="chip strong" title="${onHtml ? HTML_SIZE_TITLE : BUILD_SIZE_TITLE}">${escapeHtml(formatBytes(item.size))}${onHtml ? ' trong HTML' : ' trong build'}</span>
          <span class="chip">${Math.round((item.size / total) * 100)}% ${onHtml ? 'file HTML' : 'bản build'}</span>
          ${onHtml && buildBytesOf(item.rows) ? `<span class="chip" title="Dung lượng trong thư mục build web-mobile">build ${escapeHtml(formatBytes(buildBytesOf(item.rows)))}</span>` : ''}
          <span class="chip">${item.rows.length} file build</span>
        </div>
        ${item.real ? revealButton(item.reveal, escapeHtml) : ''}
      </div>
      ${insight ? reasonBox(insight, escapeHtml) : ''}
      <div class="d-section">
        <div class="detail-title">Được kéo vào build bởi</div>
        ${first.includedBy && first.includedBy.length
          ? `<div class="dependency-chains">${first.includedBy.map((chain) => `<span title="${escapeHtml(chain)}">${escapeHtml(chain)}</span>`).join('')}</div>`
          : '<div class="detail-note">Không thấy scene / prefab nào tham chiếu trực tiếp (file của engine, cấu hình, hoặc được nạp bằng code).</div>'}
      </div>
      <div class="d-section">
        <div class="detail-title">File trong build (${item.rows.length})</div>
        ${fileListHtml(item.rows, escapeHtml)}
      </div>
    </div>
  `;
  if (hasPreview) {
    void preview.loadPreview(panel.$.detail, { id: 'detail-item-preview', filePath: path.join(Editor.Project.path, 'assets', shortAssetLabel(item.url)), extension: path.extname(item.url), escapeHtml });
  }
  if (sourceUrl) {
    void textureTab.loadSourceBox(panel, { source: sourceUrl, category }, helpers);
    void audioTab.loadSourceBox(panel, { source: sourceUrl, category }, helpers);
  }
}

function renderFileDetail(panel, helpers, row) {
  const { escapeHtml, formatDelta, deltaClass } = helpers;
  const group = groupOf(row.category);
  const target = revealTarget(row);
  const meta = row.textureMeta;
  const metaLabel = meta
    ? [meta.width > 0 && meta.height > 0 ? `${meta.width}×${meta.height}` : '', typeof meta.hasAlpha === 'boolean' ? (meta.hasAlpha ? 'có alpha' : 'không alpha') : '', meta.formatLabel || '']
      .filter(Boolean).join(' · ')
    : '';
  const hasPreview = !!preview.getPreviewKind(row.extension);
  const packed = row.packedSources || [];

  panel.$.detail.className = 'detail';
  panel.$.detail.innerHTML = `
    <div class="detail-body">
      ${hasPreview ? preview.renderStage({ id: 'detail-asset-preview', filePath: row.fullPath, title: 'Xem trước', escapeHtml }) : ''}
      ${textureTab.renderSourceBox(row, helpers)}
      ${audioTab.renderSourceBox(row, helpers)}
      <div class="d-head">
        <div class="d-title mono" title="${escapeHtml(row.relativePath)}">${escapeHtml(row.name)}</div>
        <div class="d-chips">
          <span class="chip strong" title="${row.buildSize !== undefined ? HTML_SIZE_TITLE : BUILD_SIZE_TITLE}">${escapeHtml(formatBytes(row.size))}${row.buildSize !== undefined ? ' trong HTML' : ' trong build'}</span>
          ${row.buildSize ? `<span class="chip" title="Dung lượng trong thư mục build web-mobile">build ${escapeHtml(formatBytes(row.buildSize))}</span>` : ''}
          ${row.deltaBytes ? `<span class="chip ${deltaClass(row.deltaBytes)}" title="So với lần build trước">${escapeHtml(formatDelta(row.deltaBytes))}</span>` : ''}
          <span class="chip"><i class="legend-dot group-${group.key}"></i>${escapeHtml(group.label)}</span>
          ${row.buildArea === 'engine' ? '' : `<span class="chip">${escapeHtml(AREA_LABELS[row.buildArea] || row.buildArea)}</span>`}
          ${metaLabel ? `<span class="chip">${escapeHtml(metaLabel)}</span>` : ''}
        </div>
      </div>
      <div class="d-section">
        <div class="detail-title">Nguồn</div>
        ${row.source
          ? `<div class="d-source"><span class="mono">${escapeHtml(sourceLabel(row))}</span>${revealButton(target, escapeHtml)}</div>`
          : `<div class="detail-note">${escapeHtml(row.sourceNote || 'Không rõ nguồn')}</div>`}
      </div>
      <div class="d-section">
        <div class="detail-title">Được kéo vào build bởi</div>
        ${row.includedBy && row.includedBy.length
          ? `<div class="dependency-chains">${row.includedBy.map((chain) => `<span title="${escapeHtml(chain)}">${escapeHtml(chain)}</span>`).join('')}</div>`
          : '<div class="detail-note">Không thấy scene / prefab nào tham chiếu trực tiếp (file của engine, cấu hình, hoặc được nạp bằng code).</div>'}
      </div>
      ${packed.length > 1 ? `
        <div class="d-section">
          <div class="detail-title">Asset gộp trong file này (${packed.length})</div>
          <ul class="d-files plain">${packed.slice(0, 40).map((source) => `<li>${escapeHtml(shortAssetLabel(source.url))}</li>`).join('')}</ul>
          ${packed.length > 40 ? `<div class="detail-note">... và ${packed.length - 40} asset khác.</div>` : ''}
        </div>
      ` : ''}
      ${row.builtinSources && row.builtinSources.length > 1 ? `
        <div class="d-section">
          <div class="detail-title">Asset dựng sẵn của engine (${row.builtinSources.length})</div>
          <ul class="d-files plain">${row.builtinSources.slice(0, 60).map((url) => `<li>${escapeHtml(shortAssetLabel(url))}</li>`).join('')}</ul>
        </div>
      ` : ''}
      <div class="d-section">
        <div class="detail-title">Đường dẫn trong build</div>
        <div class="mono small">${escapeHtml(row.relativePath)}</div>
      </div>
    </div>
  `;

  if (hasPreview) {
    void preview.loadPreview(panel.$.detail, { id: 'detail-asset-preview', filePath: row.fullPath, extension: row.extension, escapeHtml });
  }
  void textureTab.loadSourceBox(panel, row, helpers);
  void audioTab.loadSourceBox(panel, row, helpers);
}

module.exports = {
  BUILD_GROUPS,
  SELECTORS,
  groupOf,
  groupRows,
  setup,
  render,
  renderDetail,
  focusFile,
  showGroup,
  showHtml,
  shortAssetLabel,
};
