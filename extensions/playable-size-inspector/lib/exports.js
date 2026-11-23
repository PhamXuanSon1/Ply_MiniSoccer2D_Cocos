'use strict';

/**
 * Bản xuất playable gửi cho từng mạng quảng cáo - file thật mà mạng nhận, khác thư mục build
 * web-mobile (đã nén ảnh / audio, gộp một file). Nhận ra các kiểu đặt tên:
 *   - playable-ads-builder: <thư mục>/<Kênh>_<tên>.html | .zip (mặc định <project>/build/playable/<tên game>/)
 *   - playable-ads-adapter: <thư mục build>/<tên>_<Kênh>.html (không có tên build thì <Kênh>.html),
 *     single-file-3x.html / single-file-2x.html, và thư mục <tên>_<Kênh>/ cho mạng nhận zip (TikTok, Facebook,
 *     Mintegral...) - kích thước của thư mục là zip ước tính, không phải tổng file thô.
 * Tìm ở: thư mục con của project, thư mục con của build/ và build/playable/, và outputPath cấu hình trong build task.
 * Không phụ thuộc Editor.
 * Cũng là nơi duy nhất đọc cấu hình playable-ads-builder (readPlayableTasks) cho setup-check, HTML cuối
 * và mức bitrate audio builder encode lại (readBuilderAudio). profiles/ (build task, theo máy) không vào git:
 * máy vừa clone dự án vẫn có settings/v2/packages/playable-ads-builder.json (builder lưu theo dự án) nên đọc thêm file đó.
 */

const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { walkFiles, readJsonFile, isSameResolvedPath } = require('./fs-utils');
const { findBuildSettings } = require('./build-scan');
const { findExtensionDir, readExtensionPackage } = require('./compat');

const deflateRaw = promisify(zlib.deflateRaw);

/**
 * Kênh của playable-ads-builder (enum CHANNEL) + "Video" (bản Unity chơi ngay, tick riêng); adapter dùng cùng tên
 * (Tiktok viết khác hoa / thường: so không phân biệt). Xếp dài trước để "UnityPlayworks" không bị nhận là "Unity".
 */
const CHANNELS = [
  'UnityPlayworks', 'OceanEngine', 'IronSource', 'Chartboost', 'Mintegral', 'AppLovin', 'Kuaishou',
  'MyTarget', 'PureHTML', 'Snapchat', 'Facebook', 'Liftoff', 'Tencent', 'Google', 'InMobi', 'TikTok',
  'Pangle', 'Vungle', 'Moloco', 'MRAID', 'Unity', 'Video', 'BIGO', 'Kwai',
].sort((left, right) => right.length - left.length);

/** Thư mục của Cocos / công cụ, chắc chắn không phải nơi chứa bản xuất. */
const SKIP_DIRS = new Set([
  'assets', 'library', 'temp', 'local', 'settings', 'profiles', 'extensions', 'node_modules',
  'packages', 'native', 'build-templates', 'preview-template', '.git', '.vscode', '.idea', '.claude',
]);

/** File xuất cũ hơn bản build quá mức này thì coi là chưa được xuất lại sau lần build mới nhất. */
const STALE_TOLERANCE_MS = 2 * 60 * 1000;

const CHANNEL_GROUP = CHANNELS.join('|');
/** playable-ads-builder: <Kênh>_<tên>.html / .zip. */
const FILE_PATTERN = new RegExp(`^(${CHANNEL_GROUP})_.+\\.(html|zip)$`, 'i');
/** playable-ads-adapter: <tên>_<Kênh>.html / .zip. */
const ADAPTER_FILE_PATTERN = new RegExp(`^(.+)_(${CHANNEL_GROUP})\\.(html|zip)$`, 'i');
/** playable-ads-adapter khi build không có tên: <Kênh>.html / .zip. */
const ADAPTER_PLAIN_PATTERN = new RegExp(`^(${CHANNEL_GROUP})\\.(html|zip)$`, 'i');
/** playable-ads-adapter: bản một file chung (không theo mạng). */
const ADAPTER_SINGLE_PATTERN = /^single-file-[23]x\.html$/i;
/** Kênh hiện cho single-file-*.html. */
const SINGLE_FILE_CHANNEL = 'Single file';
/** Thư mục xuất <tên>_<Kênh>/ (playable-ads-adapter, mạng nhận zip). */
const FOLDER_PATTERN = new RegExp(`^(.+)_(${CHANNEL_GROUP})$`, 'i');

function canonicalChannel(name) {
  return CHANNELS.find((channel) => channel.toLowerCase() === String(name).toLowerCase()) || name;
}

async function listDirectories(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
}

// ---------------------------------------------------------------- công cụ xuất của dự án

/**
 * Dự án xuất playable bằng gì: { builder: { dir, version } | null, adapter: { dir, version } | null }.
 * builder: có extension playable-ads-builder (trong dự án hoặc cài global) hoặc cấu hình của nó; adapter: có
 * extension playable-ads-adapter hoặc profile của nó.
 */
async function detectExporter(projectRoot) {
  const describe = (name, configFiles) => {
    const dir = findExtensionDir(projectRoot, name);
    const pkg = dir ? readExtensionPackage(dir) : null;
    return { dir, version: pkg && pkg.version ? String(pkg.version) : '', configFiles };
  };
  const exists = async (relative) => !!(await fs.stat(path.join(projectRoot, relative)).catch(() => null));
  const builderFiles = [];
  for (const relative of ['settings/v2/packages/playable-ads-builder.json', 'profiles/v2/packages/playable-ads-builder.json']) {
    if (await exists(relative)) builderFiles.push(relative);
  }
  const adapterFiles = [];
  for (const relative of ['profiles/v2/packages/playable-ads-adapter.json', 'settings/v2/packages/playable-ads-adapter.json', '.adapterrc']) {
    if (await exists(relative)) adapterFiles.push(relative);
  }
  const builder = describe('playable-ads-builder', builderFiles);
  const adapter = describe('playable-ads-adapter', adapterFiles);
  return {
    builder: builder.dir || builderFiles.length ? builder : null,
    adapter: adapter.dir || adapterFiles.length ? adapter : null,
  };
}

// ---------------------------------------------------------------- cấu hình playable-ads-builder

/** Khoá builder lưu theo dự án (panel.ts PROFILE_KEYS) + các ô channel_<Kênh>. */
const BUILDER_PROFILE_KEYS = ['appleUrl', 'googleUrl', 'compressionType', 'compressionQuality', 'audioCompressionEnabled', 'audioBitrate'];
/** Mặc định của playable-ads-builder (source/builder.ts, hooks.ts). */
const BUILDER_DEFAULTS = { compressionType: 'lossy', compressionQuality: 80, audioCompressionEnabled: true, audioBitrate: 64 };

/**
 * Cấu hình playable-ads-builder lưu theo dự án (settings/v2/packages/playable-ads-builder.json, có trong git):
 * chỉ các khoá builder tự áp lại vào build task khi mở panel Build (applySavedConfig). null nếu không có file.
 */
async function readBuilderSettings(projectRoot) {
  const saved = await readJsonFile(path.join(projectRoot, 'settings', 'v2', 'packages', 'playable-ads-builder.json'));
  if (!saved || typeof saved !== 'object') {
    return null;
  }
  const picked = {};
  for (const [key, value] of Object.entries(saved)) {
    if (value !== undefined && (BUILDER_PROFILE_KEYS.includes(key) || key.startsWith('channel_'))) {
      picked[key] = value;
    }
  }
  return picked;
}

/**
 * Mọi build task web (mới nhất trước), kể cả task chưa đặt Name, kèm cấu hình playable-ads-builder của
 * task đó. Chỗ DUY NHẤT đọc cấu hình builder (setup-check, bản xuất, nén audio đều đi qua đây).
 * `pkg` lấy theo đúng một thứ tự: taskOptionsMap[taskId] (profile của builder) →
 * options.packages['playable-ads-builder'] (lưu trong build task) → options[platform] (mặc định theo
 * platform); rồi phủ cấu hình lưu theo dự án (settings/v2/packages/playable-ads-builder.json) lên trên như
 * builder làm khi mở panel Build. Không có gì thì null. Trả về [{ taskId, name, options, pkg }].
 * Build task nằm trong profiles/ (không vào git): máy vừa clone dự án thì danh sách rỗng.
 */
async function readPlayableTasks(projectRoot) {
  const builderProfile = await readJsonFile(path.join(projectRoot, 'profiles', 'v2', 'packages', 'builder.json'));
  const playableProfile = await readJsonFile(path.join(projectRoot, 'profiles', 'v2', 'packages', 'playable-ads-builder.json'));
  const saved = await readBuilderSettings(projectRoot);
  const playable = (playableProfile && playableProfile.builder) || {};
  const tasks = builderProfile && builderProfile.BuildTaskManager && builderProfile.BuildTaskManager.taskMap;
  return Object.entries(tasks || {})
    .filter(([, task]) => task && task.options && /^web-/.test(String(task.options.platform || '')))
    .map(([taskId, task]) => {
      const options = task.options;
      let pkg = (playable.taskOptionsMap || {})[taskId]
        || (options.packages && options.packages['playable-ads-builder'])
        || (playable.options || {})[options.platform]
        || null;
      if (saved && Object.keys(saved).length) {
        pkg = { ...(pkg || {}), ...saved };
      }
      return { taskId, name: String(options.name || '').trim(), options, pkg };
    })
    .sort((left, right) => Number(right.taskId) - Number(left.taskId));
}

/** Thư mục build của một build task (buildPath + outputName, như Cocos). */
function taskBuildDir(projectRoot, options) {
  const buildPath = String((options && options.buildPath) || 'project://build').replace(/^project:\/\//, `${projectRoot}/`);
  return path.resolve(projectRoot, buildPath, String((options && (options.outputName || options.platform)) || 'web-mobile'));
}

function compressionOf(pkg) {
  return {
    type: ['none', 'lossy', 'lossless'].includes(pkg && pkg.compressionType) ? pkg.compressionType : BUILDER_DEFAULTS.compressionType,
    quality: pkg && typeof pkg.compressionQuality === 'number' ? pkg.compressionQuality : BUILDER_DEFAULTS.compressionQuality,
  };
}

function audioOf(pkg) {
  return {
    enabled: !pkg || pkg.audioCompressionEnabled !== false,
    bitrate: pkg && typeof pkg.audioBitrate === 'number' ? pkg.audioBitrate : BUILDER_DEFAULTS.audioBitrate,
  };
}

/**
 * Cấu hình xuất của từng build task web đã đặt Name (mới nhất trước), đọc đúng như playable-ads-builder:
 * tên = ô "Name" của build task; mạng = các ô channel_<Kênh> đã tick (+ channel_Video);
 * thư mục = outputPath nếu có, không thì <thư mục build>/../playable/<Tên> (mặc định build/playable/<Tên>).
 * Trả về [{ taskId, name, buildDir, outputDir, channels, compression, audio }].
 */
async function readExportConfigs(projectRoot) {
  const configs = [];
  for (const { taskId, name, options, pkg } of await readPlayableTasks(projectRoot)) {
    // Builder bỏ qua bước xuất khi task chưa đặt Name.
    if (!name || !pkg) {
      continue;
    }
    const buildDir = taskBuildDir(projectRoot, options);
    const channels = CHANNELS.filter((channel) => pkg[`channel_${channel}`] === true);
    const outputPath = String(pkg.outputPath || '').trim();
    configs.push({
      taskId,
      name,
      buildDir,
      // Cùng công thức với playable-ads-builder (sanitizeFolderName).
      outputDir: outputPath ? path.resolve(projectRoot, outputPath) : path.join(buildDir, '..', 'playable', name.replace(/[<>:"/\\|?*]/g, '_')),
      channels,
      // Nén ảnh / audio lúc xuất (mặc định giống playable-ads-builder: source/builder.ts, hooks.ts).
      compression: compressionOf(pkg),
      audio: audioOf(pkg),
    });
  }
  return configs;
}

/** Cấu hình của build task ra đúng thư mục `buildRoot`; không khớp (hoặc không truyền) thì task mới nhất, không có thì null. */
function findExportConfig(configs, buildRoot) {
  return (buildRoot && configs.find((config) => isSameResolvedPath(config.buildDir, buildRoot))) || configs[0] || null;
}

/**
 * Cấu hình nén lúc xuất của builder khi không có build task nào trên máy này (vừa clone, profiles/ không vào git):
 * cấu hình lưu theo dự án nếu có, không thì mặc định của builder. { compression, audio, source: 'settings' | 'defaults' }
 * hoặc null khi dự án không dùng playable-ads-builder.
 */
async function readBuilderFallback(projectRoot) {
  const saved = await readBuilderSettings(projectRoot);
  const exporter = saved ? null : await detectExporter(projectRoot);
  if (!saved && !(exporter && exporter.builder)) {
    return null;
  }
  return { compression: compressionOf(saved), audio: audioOf(saved), source: saved ? 'settings' : 'defaults' };
}

/**
 * Builder có encode lại audio lúc xuất không, ở bitrate nào (cấu hình của build task ứng với `buildRoot`):
 * { packageName, enabled, bitrateKbps } - đúng dạng tab Âm thanh và "Việc nên làm" dùng.
 * null khi dự án không xuất qua playable-ads-builder.
 */
async function readBuilderAudio(projectRoot, buildRoot) {
  const config = findExportConfig(await readExportConfigs(projectRoot), buildRoot);
  if (config) {
    return { packageName: 'playable-ads-builder', enabled: config.audio.enabled, bitrateKbps: config.audio.bitrate };
  }
  // Task chưa đặt Name thì không xuất HTML, nhưng cấu hình audio của nó vẫn là thứ builder sẽ dùng khi đặt Name.
  const task = (await readPlayableTasks(projectRoot)).find((item) => item.pkg);
  if (task) {
    const audio = audioOf(task.pkg);
    return { packageName: 'playable-ads-builder', enabled: audio.enabled, bitrateKbps: audio.bitrate };
  }
  // Máy chưa có build task (profiles/ không vào git): builder vẫn sẽ encode lại theo cấu hình lưu trong dự án.
  const fallback = await readBuilderFallback(projectRoot);
  return fallback
    ? { packageName: 'playable-ads-builder', enabled: fallback.audio.enabled, bitrateKbps: fallback.audio.bitrate, assumed: fallback.source }
    : null;
}

// ---------------------------------------------------------------- tìm bản xuất

/** File bản xuất nằm ngay trong thư mục: builder, adapter (theo mạng, không tên, single-file). */
async function fileExportsIn(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    let item = null;
    let match = FILE_PATTERN.exec(entry.name);
    if (match) {
      item = { channel: canonicalChannel(match[1]), kind: match[2].toLowerCase(), tool: 'builder', group: '' };
    } else if ((match = ADAPTER_FILE_PATTERN.exec(entry.name))) {
      item = { channel: canonicalChannel(match[2]), kind: match[3].toLowerCase(), tool: 'adapter', group: match[1] };
    } else if ((match = ADAPTER_PLAIN_PATTERN.exec(entry.name))) {
      item = { channel: canonicalChannel(match[1]), kind: match[2].toLowerCase(), tool: 'adapter', group: '' };
    } else if (ADAPTER_SINGLE_PATTERN.test(entry.name)) {
      item = { channel: SINGLE_FILE_CHANNEL, kind: 'html', tool: 'adapter', group: '', single: true };
    }
    if (!item) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (stat) {
      items.push({ ...item, name: entry.name, path: fullPath, bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return items;
}

/** Zip ước tính của thư mục xuất, nhớ theo (thư mục, mtime index.html, tổng byte, số file): panel gọi ~10 giây một lần. */
const folderZipCache = new Map();

async function folderZipBytes(dir, files, indexMtime) {
  const rawBytes = files.reduce((sum, file) => sum + file.size, 0);
  const key = `${path.resolve(dir)}|${indexMtime}|${rawBytes}|${files.length}`;
  if (!folderZipCache.has(key)) {
    if (folderZipCache.size > 64) {
      folderZipCache.clear();
    }
    folderZipCache.set(key, (async () => {
      let total = 22;
      for (const file of files) {
        const data = await fs.readFile(file.fullPath).catch(() => null);
        const compressed = data ? Math.min(data.length, (await deflateRaw(data)).length) : file.size;
        const name = path.relative(dir, file.fullPath).replace(/\\/g, '/');
        total += compressed + 30 + 46 + 2 * Buffer.byteLength(name, 'utf8');
      }
      return total;
    })().catch(() => rawBytes));
  }
  return { zipBytes: await folderZipCache.get(key), rawBytes };
}

/** Thư mục là bản xuất của playable-ads-adapter: js/index*.js chứa dữ liệu, hoặc config.json của adapter cạnh index.html. */
async function isAdapterFolder(fullPath) {
  const config = await readJsonFile(path.join(fullPath, 'config.json'));
  if (config && typeof config === 'object' && ('playable_orientation' in config || 'playable_languages' in config)) {
    return true;
  }
  const js = await fs.readdir(path.join(fullPath, 'js')).catch(() => []);
  return js.some((name) => /^index\d+\.js$/i.test(name));
}

/** Thư mục kiểu build/<tên>_<Kênh>/index.html, gom theo <tên>. Kích thước = zip ước tính của thư mục. */
async function folderExportsIn(dir) {
  const groups = new Map();
  for (const fullPath of await listDirectories(dir)) {
    const match = FOLDER_PATTERN.exec(path.basename(fullPath));
    if (!match) {
      continue;
    }
    const index = await fs.stat(path.join(fullPath, 'index.html')).catch(() => null);
    if (!index) {
      continue;
    }
    const files = await walkFiles(fullPath).catch(() => []);
    const { zipBytes, rawBytes } = await folderZipBytes(fullPath, files, index.mtimeMs);
    const item = {
      channel: canonicalChannel(match[2]),
      name: path.basename(fullPath),
      path: fullPath,
      kind: 'folder',
      tool: await isAdapterFolder(fullPath) ? 'adapter' : '',
      group: match[1],
      bytes: zipBytes,
      rawBytes,
      zipEstimated: true,
      mtimeMs: index.mtimeMs,
    };
    if (!groups.has(match[1])) {
      groups.set(match[1], []);
    }
    groups.get(match[1]).push(item);
  }
  return groups;
}

/**
 * Các bộ bản xuất, mới nhất trước:
 * [{ id, dir, label, at, tool, items: [{ channel, name, path, kind: html|zip|folder, tool, bytes, mtimeMs, selected,
 *    rawBytes?, zipEstimated? }], config: { name, channels, buildDir } | null, missing: [kênh đã tick mà chưa có file] }]
 * (items nặng nhất trước). `id` là đường dẫn tương đối project, ổn định giữa các lần quét.
 * Bộ ứng với cấu hình build hiện tại có `config`; kênh đã tick mà chưa có file nằm ở `missing`.
 * Bản xuất của adapter gom theo <tên> (file <tên>_<Kênh>.html và thư mục <tên>_<Kênh>/ cùng một bộ; single-file
 * vào bộ adapter mới nhất cùng thư mục).
 */
async function findExportSets(projectRoot) {
  const configs = await readExportConfigs(projectRoot);
  const sets = new Map();
  const add = (dir, label, items, keepEmpty = false) => {
    if (!items.length && !keepEmpty) {
      return;
    }
    const id = `${path.relative(projectRoot, dir).replace(/\\/g, '/') || '.'}#${label}`;
    let set = sets.get(id);
    if (!set) {
      set = { id, dir, label, at: 0, items: [], config: null, missing: [] };
      sets.set(id, set);
    }
    const known = new Set(set.items.map((item) => path.resolve(item.path)));
    for (const item of items) {
      if (!known.has(path.resolve(item.path))) {
        set.items.push(item);
        known.add(path.resolve(item.path));
      }
    }
    set.items.sort((left, right) => right.bytes - left.bytes);
    set.at = set.items.length ? Math.max(...set.items.map((item) => item.mtimeMs)) : 0;
    const tools = new Set(set.items.map((item) => item.tool).filter(Boolean));
    set.tool = tools.size === 1 ? [...tools][0] : '';
  };
  const addFiles = (dir, items) => {
    const builder = items.filter((item) => item.tool !== 'adapter');
    add(dir, path.basename(dir), builder);
    const adapter = items.filter((item) => item.tool === 'adapter');
    const singles = adapter.filter((item) => item.single);
    const byGroup = new Map();
    for (const item of adapter.filter((entry) => !entry.single)) {
      const label = item.group || path.basename(dir);
      if (!byGroup.has(label)) byGroup.set(label, []);
      byGroup.get(label).push(item);
    }
    for (const [label, groupItems] of byGroup) {
      add(dir, label, groupItems);
    }
    if (singles.length) {
      // single-file đi cùng lần xuất adapter gần nó nhất trong thư mục này (thường cùng một lần build).
      const prefix = `${path.relative(projectRoot, dir).replace(/\\/g, '/') || '.'}#`;
      const candidates = [...sets.values()].filter((set) => set.id.startsWith(prefix) && set.items.some((item) => item.tool === 'adapter'));
      const at = Math.max(...singles.map((item) => item.mtimeMs));
      const near = candidates.sort((left, right) => Math.abs(left.at - at) - Math.abs(right.at - at))[0];
      add(dir, near && Math.abs(near.at - at) < 10 * 60 * 1000 ? near.label : 'single-file', singles);
    }
  };

  // Thư mục xuất của build task (tên đặt trong panel Build) trước: luôn có mặt, kể cả khi chưa có file.
  for (const config of configs) {
    add(config.outputDir, path.basename(config.outputDir), (await fileExportsIn(config.outputDir)).filter((item) => item.tool === 'builder'), true);
  }
  const fileDirs = new Set([
    ...(await listDirectories(projectRoot)).filter((dir) => !SKIP_DIRS.has(path.basename(dir)) && path.basename(dir) !== 'build'),
    ...await listDirectories(path.join(projectRoot, 'build')),
    ...await listDirectories(path.join(projectRoot, 'build', 'playable')),
    path.join(projectRoot, 'build'),
  ]);
  // Thư mục adapter xuất ra trước (để file <tên>_<Kênh>.html cùng lần xuất gom chung một bộ).
  for (const root of [projectRoot, path.join(projectRoot, 'build')]) {
    for (const [label, items] of await folderExportsIn(root)) {
      add(root, label, items);
    }
  }
  for (const dir of fileDirs) {
    addFiles(dir, await fileExportsIn(dir));
  }

  // Gắn cấu hình build: kênh nào đã tick, kênh nào thiếu file, file nào của kênh không tick lần này.
  for (const config of configs) {
    const set = [...sets.values()].find((item) => !item.config && isSameResolvedPath(item.dir, config.outputDir) && item.label === path.basename(config.outputDir));
    if (!set) {
      continue;
    }
    set.config = { name: config.name, channels: config.channels, buildDir: config.buildDir, taskId: config.taskId };
    const present = new Set(set.items.map((item) => item.channel));
    set.missing = config.channels.filter((channel) => !present.has(channel));
    // Builder xuất ngay sau khi build xong: file cũ hơn bản build nhiều là lần build mới không xuất lại kênh đó.
    const settingsPath = await findBuildSettings(config.buildDir);
    const built = settingsPath ? await fs.stat(settingsPath).catch(() => null) : null;
    set.builtAt = built ? built.mtimeMs : 0;
    for (const item of set.items) {
      item.selected = config.channels.includes(item.channel);
      item.stale = !!set.builtAt && item.mtimeMs < set.builtAt - STALE_TOLERANCE_MS;
    }
  }
  // Bộ rỗng (chưa xuất lần nào) chỉ giữ khi có cấu hình đi kèm.
  const result = [...sets.values()]
    .filter((set) => set.items.length || set.config)
    .sort((left, right) => right.at - left.at);
  // Hai bộ cùng tên ở hai thư mục (vd build/ và build_noBGM/): ghi kèm thư mục để chọn đúng.
  const labelCount = new Map();
  for (const set of result) {
    labelCount.set(set.label, (labelCount.get(set.label) || 0) + 1);
  }
  for (const set of result) {
    const where = path.relative(projectRoot, set.dir).replace(/\\/g, '/');
    if (labelCount.get(set.label) > 1 && where && where !== set.label) {
      set.label = `${where}/${set.label}`;
    }
  }
  return result;
}

// ---------------------------------------------------------------- so với lần xuất trước

function exportHistoryPath(projectRoot) {
  return path.join(projectRoot, 'temp', 'playable-size-inspector', 'export-history.json');
}

/**
 * Ghi nhớ dung lượng từng kênh của mỗi bộ bản xuất; khi bộ đó được xuất lại (thời điểm khác)
 * thì lần cũ thành "lần trước". Trả về Map setId -> { at, items: { kênh: bytes } } của lần trước.
 * Chỉ panel gọi (ghi vào temp/ của dự án); cli/selftest.js không gọi.
 */
async function updateExportHistory(projectRoot, sets) {
  const file = exportHistoryPath(projectRoot);
  const history = (await readJsonFile(file)) || {};
  const previous = new Map();
  let changed = false;
  for (const set of sets) {
    const current = { at: set.at, items: Object.fromEntries(set.items.map((item) => [item.channel, item.bytes])) };
    const stored = history[set.id];
    if (!stored || !stored.current) {
      history[set.id] = { current };
      changed = true;
    } else if (Math.abs(stored.current.at - set.at) > 1000) {
      history[set.id] = { previous: stored.current, current };
      changed = true;
    }
    if (history[set.id].previous) {
      previous.set(set.id, history[set.id].previous);
    }
  }
  if (changed) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(history), 'utf8');
  }
  return previous;
}

module.exports = {
  CHANNELS,
  FOLDER_PATTERN,
  SINGLE_FILE_CHANNEL,
  detectExporter,
  readBuilderSettings,
  readBuilderFallback,
  readPlayableTasks,
  taskBuildDir,
  readExportConfigs,
  findExportConfig,
  readBuilderAudio,
  findExportSets,
  isAdapterFolder,
  updateExportHistory,
};
