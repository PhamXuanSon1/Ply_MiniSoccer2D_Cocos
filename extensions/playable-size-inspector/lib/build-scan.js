'use strict';

/**
 * Quét thư mục build web-mobile: liệt kê mọi file đã build, phân loại, map từng file
 * build về asset nguồn trong db://assets, dựng chuỗi phụ thuộc scene/prefab và phân
 * tích các file import JSON. buildSourceSizeIndex gom lại theo asset nguồn (panel và
 * cli/selftest.js dùng chung).
 *
 * Module này chỉ dùng fs + library/.assets-data.json nên chạy được cả ngoài Editor
 * (node thuần) - dùng để kiểm chứng kết quả scan.
 */

const fs = require('fs/promises');
const path = require('path');
const { toRelative } = require('./fs-utils');
const { readImageMeta } = require('./image-meta');

const TEXTURE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.bmp'];

/** Giữ nguyên tập đuôi của bản gốc: chỉ ảnh build ra mới đọc metadata. */
async function readTextureMeta(filePath, extension) {
  return TEXTURE_EXTENSIONS.includes(extension) ? await readImageMeta(filePath, extension) : null;
}

async function scanBuild({ projectRoot, buildRoot }) {
  const assetEntries = await readAssetEntries(path.join(projectRoot, 'library', '.assets-data.json'));
  // Asset dựng sẵn của engine (db://internal: skybox mặc định, effect, material...) cũng
  // vào build khi scene/material dùng tới; thiếu file này thì chỉ mất phần gọi tên chúng.
  const builtinEntries = await readAssetEntries(path.join(projectRoot, 'library', '.internal-data.json'), { builtin: true })
    .catch(() => []);
  const allEntries = assetEntries.concat(builtinEntries);
  const dependencyIndex = await buildPrefabDependencyIndex({ projectRoot, buildRoot, assetEntries });
  const buildFiles = await collectBuildFiles(buildRoot);
  const packedAssetIndex = await buildPackedAssetIndex({ buildFiles, assetEntries: allEntries });
  const generatedTextureIndex = await readGeneratedTextureIndex(projectRoot);
  const assetRows = await buildAssetRows({
    buildFiles,
    assetEntries: allEntries,
    dependencyIndex,
    packedAssetIndex,
    generatedTextureIndex,
  });

  return {
    buildFiles,
    assetEntries,
    assetRows,
    totalBuildBytes: buildFiles.reduce((sum, file) => sum + file.size, 0),
  };
}

// ---------------------------------------------------------------- so với bản build trước

/**
 * So sánh kết quả quét hiện tại với bản build trước của cùng thư mục: snapshot = { files: { đường dẫn bỏ md5:
 * bytes }, totalBytes } (panel lưu ở temp/playable-size-inspector/build-baseline.json, index.js rotateBuildBaseline).
 * Trả về { previousAt, totalDelta, byPath: Map<relativePath, delta>, added, removed }.
 * File mới tính là tăng nguyên kích thước, file biến mất tính là giảm. So theo đường dẫn đã bỏ
 * hậu tố md5 (md5Cache đổi tên file mỗi khi nội dung đổi), khoá của byPath là đường dẫn hiện tại.
 */
function diffAgainstSnapshot(buildFiles, snapshot) {
  if (!snapshot) {
    return null;
  }

  const byPath = new Map();
  let added = 0;
  let removed = 0;
  const seen = new Set();

  for (const file of buildFiles) {
    const key = stableBuildPath(file.relativePath);
    seen.add(key);
    const previousSize = snapshot.files[key];
    if (previousSize === undefined) {
      byPath.set(file.relativePath, file.size);
      added += 1;
      continue;
    }
    const delta = file.size - previousSize;
    if (delta !== 0) {
      byPath.set(file.relativePath, delta);
    }
  }

  for (const [relativePath, size] of Object.entries(snapshot.files)) {
    if (!seen.has(relativePath)) {
      byPath.set(relativePath, -size);
      removed += 1;
    }
  }

  const totalNow = buildFiles.reduce((sum, file) => sum + file.size, 0);
  return {
    previousAt: snapshot.generatedAt || '',
    totalDelta: totalNow - Number(snapshot.totalBytes || 0),
    byPath,
    added,
    removed,
  };
}

/**
 * Dung lượng trong build theo asset nguồn (ảnh, auto-atlas, audio...): Map<url gốc (bỏ @sub), { bytes,
 * deltaBytes, files }>. Mỗi file build chỉ tính cho asset nguồn chính của nó (row.source); deltaBytes cộng
 * từ row.deltaBytes nếu panel đã gắn (chênh lệch so với lần build trước). Không cộng thêm cho mọi
 * prefab / model khác trong cùng pack: pack dùng chung sẽ bị tính trọn cho từng cái (tổng vượt cả bản
 * build), và chỉ url ảnh / audio được tra trong index này.
 */
function buildSourceSizeIndex(assetRows) {
  const index = new Map();
  for (const row of assetRows || []) {
    if (!row.source) {
      continue;
    }
    const url = String(row.source).split('@')[0];
    const entry = index.get(url) || { bytes: 0, deltaBytes: 0, files: 0 };
    entry.bytes += row.size;
    entry.deltaBytes += row.deltaBytes || 0;
    entry.files += 1;
    index.set(url, entry);
  }
  return index;
}

// ---------------------------------------------------------------- asset index

/**
 * Đọc index asset của Editor. Mặc định là `.assets-data.json` (db://assets);
 * `{ builtin: true }` cho `.internal-data.json` (db://internal, asset dựng sẵn của engine).
 */
async function readAssetEntries(indexPath, { builtin = false } = {}) {
  let raw;
  try {
    raw = await fs.readFile(indexPath, 'utf8');
  } catch (_error) {
    throw new Error(`Không đọc được ${indexPath}. Mở project trong Cocos Creator một lần để Editor tạo thư mục library/.`);
  }
  const data = JSON.parse(raw);
  const entries = [];
  const prefix = builtin ? 'db://internal/' : 'db://assets/';

  for (const [uuid, info] of Object.entries(data)) {
    const url = String(info && info.url || '');
    if (!url.startsWith(prefix)) {
      continue;
    }

    const rootAssetUrl = url.split('@')[0];
    const extension = path.extname(rootAssetUrl).toLowerCase();

    entries.push({
      uuid,
      compactUuid: compactUuidString(uuid),
      url,
      extension,
      category: categorizeSourceExtension(extension),
      builtin,
    });
  }

  return entries;
}

// ---------------------------------------------------------------- dependency chain

/**
 * File settings của bản build: `src/settings.json`, hoặc `src/settings.<md5>.json` khi bật MD5 Cache.
 * Trả về đường dẫn tuyệt đối hoặc '' nếu không có.
 */
async function findBuildSettings(buildRoot) {
  const exact = path.join(buildRoot, 'src', 'settings.json');
  try {
    await fs.access(exact);
    return exact;
  } catch (_error) {
    const names = await fs.readdir(path.join(buildRoot, 'src')).catch(() => []);
    const hashed = names.find((name) => /^settings\.[0-9a-f]{5}\.json$/i.test(name));
    return hashed ? path.join(buildRoot, 'src', hashed) : '';
  }
}

async function buildPrefabDependencyIndex({ projectRoot, buildRoot, assetEntries }) {
  const settingsPath = await findBuildSettings(buildRoot);
  let launchSceneUrl = '';
  try {
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    launchSceneUrl = String(settings && settings.launch && settings.launch.launchScene || '');
  } catch (_error) {
    return new Map();
  }

  const documentExtensions = new Set(['.scene', '.prefab', '.material', '.mtl', '.anim']);
  const documents = [];
  for (const entry of assetEntries) {
    if (!documentExtensions.has(entry.extension)) {
      continue;
    }
    const relativeAssetPath = entry.url.replace(/^db:\/\/assets\//, '');
    const fullPath = path.join(projectRoot, 'assets', relativeAssetPath.replace(/\//g, path.sep));
    try {
      const text = await fs.readFile(fullPath, 'utf8');
      const references = [];
      const pattern = /"__uuid__"\s*:\s*"([^"]+)"/g;
      let match = pattern.exec(text);
      while (match) {
        references.push(normalizeDependencyUuid(match[1]));
        match = pattern.exec(text);
      }
      documents.push({
        uuid: normalizeDependencyUuid(entry.uuid),
        url: entry.url,
        label: path.basename(relativeAssetPath),
        references: Array.from(new Set(references.filter(Boolean))),
      });
    } catch (_error) {
      // Bỏ qua document nguồn không đọc được lúc editor đang refresh.
    }
  }

  const documentByUuid = new Map(documents.map((document) => [document.uuid, document]));
  const launchDocument = documents.find((document) => document.url.toLowerCase() === launchSceneUrl.toLowerCase());
  if (!launchDocument) {
    return new Map();
  }

  const dependencyIndex = new Map();
  const queue = [{ document: launchDocument, chain: [launchDocument.label] }];
  const visitedDocuments = new Set();

  while (queue.length) {
    const current = queue.shift();
    if (!current || visitedDocuments.has(current.document.uuid)) {
      continue;
    }
    visitedDocuments.add(current.document.uuid);

    for (const referenceUuid of current.document.references) {
      let chains = dependencyIndex.get(referenceUuid);
      if (!chains) {
        chains = [];
        dependencyIndex.set(referenceUuid, chains);
      }
      const chainLabel = current.chain.join(' > ');
      if (!chains.includes(chainLabel) && chains.length < 3) {
        chains.push(chainLabel);
      }

      const referencedDocument = documentByUuid.get(referenceUuid);
      if (referencedDocument && !visitedDocuments.has(referencedDocument.uuid)) {
        queue.push({
          document: referencedDocument,
          chain: current.chain.concat(referencedDocument.label),
        });
      }
    }
  }

  return dependencyIndex;
}

function normalizeDependencyUuid(uuid) {
  return String(uuid || '').split('@')[0].toLowerCase();
}

// ---------------------------------------------------------------- packed import files

async function buildPackedAssetIndex({ buildFiles, assetEntries }) {
  const assetByUuid = new Map(assetEntries.map((entry) => [String(entry.uuid || '').toLowerCase(), entry]));
  const buildFileByPath = new Map(buildFiles.map((file) => [normalizeBuildPath(stableBuildPath(file.relativePath)), file]));
  const packedAssetIndex = new Map();
  const configFiles = buildFiles.filter((file) => /^config(?:\.[^.]+)?\.json$/i.test(file.name));

  for (const configFile of configFiles) {
    let config;
    try {
      config = JSON.parse(await fs.readFile(configFile.fullPath, 'utf8'));
    } catch (_error) {
      continue;
    }

    const uuids = Array.isArray(config.uuids) ? config.uuids : [];
    const packs = config.packs && typeof config.packs === 'object' ? config.packs : {};
    const bundleRoot = path.posix.dirname(normalizeBuildPath(configFile.relativePath));
    const importBase = String(config.importBase || 'import').replace(/^\/+|\/+$/g, '');

    for (const [packId, uuidIndexes] of Object.entries(packs)) {
      if (!Array.isArray(uuidIndexes)) {
        continue;
      }

      const packPrefix = packId.slice(0, 2);
      const basePath = `${bundleRoot}/${importBase}/${packPrefix}/${packId}`;
      const packedFile = buildFileByPath.get(`${basePath}.json`)
        || buildFileByPath.get(`${basePath}.cconb`);
      if (!packedFile) {
        continue;
      }

      // Bản release ghi chỉ số vào `uuids`; bản build Debug ghi thẳng chuỗi uuid đầy đủ.
      const matchedAssets = uuidIndexes
        .map((entry) => decompressCocosUuid(configUuid(uuids, entry)))
        .map((uuid) => assetByUuid.get(String(uuid || '').toLowerCase()))
        .filter(Boolean);
      const uniqueAssets = Array.from(new Map(
        matchedAssets.map((entry) => [String(entry.url || '').split('@')[0].toLowerCase(), entry]),
      ).values());
      const packedAssets = uniqueAssets.filter((entry) => !entry.builtin);
      const builtinEntries = uniqueAssets.filter((entry) => entry.builtin);
      const builtins = builtinEntries.map((entry) => entry.url.split('@')[0]);
      if (packedAssets.length || builtins.length) {
        packedAssetIndex.set(normalizeBuildPath(packedFile.relativePath), { assets: packedAssets, builtins, builtinEntries });
      }
    }
  }

  return packedAssetIndex;
}

/**
 * Ảnh auto-atlas ghép lúc build mang id ngắn (vd `16e3fa688.png`), không có trong index
 * asset. compress-info.json của Texture Compress ghi lại đường dẫn nguồn của nó, nằm trong
 * thư mục tạm của asset .pac (`temp/asset-db/assets/<xx>/<uuid .pac>/...`): id ngắn -> uuid .pac.
 * Chưa từng nén thì không có file này, ảnh đó vẫn báo "sinh ra lúc build".
 */
async function readGeneratedTextureIndex(projectRoot) {
  const index = new Map();
  let info;
  try {
    info = JSON.parse(await fs.readFile(path.join(projectRoot, 'temp', 'builder', 'CompressTexture', 'compress-info.json'), 'utf8'));
  } catch (_error) {
    return index;
  }
  for (const [id, entry] of Object.entries(info || {})) {
    const source = String(entry && entry.option && entry.option.src || '').replace(/\\/g, '/');
    const match = /\/temp\/asset-db\/assets\/[0-9a-f]{2}\/([0-9a-f-]{36})\//i.exec(source);
    if (match) {
      index.set(String(id).toLowerCase(), match[1].toLowerCase());
    }
  }
  return index;
}

/**
 * Một uuid trong config.json của bundle (packs, paths, scenes, redirect...): bản release ghi chỉ số vào mảng
 * `uuids` (3.8: số, 3.6: chuỗi số như "34"), bản build Debug ghi thẳng chuỗi uuid. Dùng hàm này ở mọi chỗ đọc
 * config.json theo chỉ số.
 */
function configUuid(uuids, entry) {
  if (typeof entry === 'number' || (typeof entry === 'string' && /^\d+$/.test(entry))) {
    return (uuids || [])[Number(entry)];
  }
  return entry;
}

/** Bản build có bật Debug không (config.json của bundle: debug true; settings.json: engine.debug). */
async function readBuildDebug(buildRoot) {
  const settingsPath = await findBuildSettings(buildRoot);
  try {
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    if (settings && settings.engine && typeof settings.engine.debug === 'boolean') {
      return settings.engine.debug;
    }
  } catch (_error) {
    // thử config.json của bundle main
  }
  try {
    const names = await fs.readdir(path.join(buildRoot, 'assets', 'main'));
    const configName = names.find((name) => /^config(?:\.[0-9a-f]+)?\.json$/i.test(name));
    const config = configName ? JSON.parse(await fs.readFile(path.join(buildRoot, 'assets', 'main', configName), 'utf8')) : null;
    return !!(config && config.debug === true);
  } catch (_error) {
    return false;
  }
}

/** Cocos nén uuid 36 ký tự thành 22 ký tự base64 trong config.json; giải ngược lại. */
function decompressCocosUuid(value) {
  const rawValue = String(value || '');
  const separatorIndex = rawValue.indexOf('@');
  const uuid = separatorIndex >= 0 ? rawValue.slice(0, separatorIndex) : rawValue;
  const suffix = separatorIndex >= 0 ? rawValue.slice(separatorIndex) : '';
  if (uuid.length !== 22) {
    return `${uuid}${suffix}`;
  }

  const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const hex = '0123456789abcdef';
  const chars = [uuid[0], uuid[1]];
  for (let index = 2; index < 22; index += 2) {
    const left = base64.indexOf(uuid[index]);
    const right = base64.indexOf(uuid[index + 1]);
    if (left < 0 || right < 0) {
      return `${uuid}${suffix}`;
    }
    chars.push(hex[left >> 2]);
    chars.push(hex[((left & 3) << 2) | (right >> 4)]);
    chars.push(hex[right & 15]);
  }

  const compact = chars.join('');
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}${suffix}`;
}

function normalizeBuildPath(value) {
  return String(value || '').replace(/\\/g, '/').toLowerCase();
}

/**
 * Bỏ hậu tố md5 (5 ký tự hex) mà Build Option "MD5 Cache" chèn vào tên file / thư mục:
 * `import/0a/0a0c0d177.1f2e3.json` -> `import/0a/0a0c0d177.json`,
 * `native/ce/<uuid>.1f2e3/Font.ttf` -> `native/ce/<uuid>/Font.ttf`.
 */
function stableBuildPath(relativePath) {
  return String(relativePath || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.replace(/\.[0-9a-f]{5}(?=(\.[^.]+)?$)/i, ''))
    .join('/');
}

// ---------------------------------------------------------------- build files

async function collectBuildFiles(root) {
  const files = [];

  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const stat = await fs.stat(fullPath);
      const relativePath = toRelative(root, fullPath);
      const extension = path.extname(entry.name).toLowerCase();

      files.push({
        fullPath,
        relativePath,
        name: entry.name,
        extension,
        size: stat.size,
        category: categorizeBuildFile(relativePath, extension),
      });
    }
  }

  await walk(root);
  return files.sort((left, right) => right.size - left.size);
}

async function buildAssetRows({ buildFiles, assetEntries, dependencyIndex, packedAssetIndex, generatedTextureIndex }) {
  const assetEntriesByUuid = new Map();
  for (const entry of assetEntries) {
    assetEntriesByUuid.set(entry.uuid.toLowerCase(), entry);
    if (!assetEntriesByUuid.has(entry.compactUuid)) {
      assetEntriesByUuid.set(entry.compactUuid, entry);
    }
  }
  const rows = await Promise.all(buildFiles.map(async (file) => {
    const generatedBy = generatedTextureIndex.get(path.basename(file.name, file.extension).split('.')[0].toLowerCase());
    const sourceMatch = findBestSourceMatch(file, assetEntriesByUuid)
      || (generatedBy ? assetEntriesByUuid.get(generatedBy) || null : null);
    const packed = packedAssetIndex.get(normalizeBuildPath(file.relativePath)) || { assets: [], builtins: [], builtinEntries: [] };
    const packedSources = packed.assets;
    // Khớp uuid với asset dựng sẵn (skybox mặc định...) thì ghi vào builtinSources, không coi là
    // asset nguồn: người dùng không sửa được nó trong assets/.
    const ownMatch = sourceMatch && !sourceMatch.builtin ? sourceMatch : null;
    const builtinRefs = (sourceMatch && sourceMatch.builtin ? [sourceMatch] : packed.builtinEntries)
      .map((entry) => ({ url: entry.url.split('@')[0], uuid: normalizeDependencyUuid(entry.uuid) }));
    const builtinSources = builtinRefs.map((entry) => entry.url);
    const prefabSources = packedSources.filter((entry) => entry.category === 'prefab');
    const modelSources = Array.from(new Map(packedSources
      .filter((entry) => entry.category === 'model-source')
      .map((entry) => {
        const rootUrl = String(entry.url || '').split('@')[0];
        return [rootUrl.toLowerCase(), {
          uuid: normalizeDependencyUuid(entry.uuid),
          url: rootUrl,
          extension: path.extname(rootUrl).toLowerCase(),
        }];
      })).values());
    const primarySource = prefabSources[0] || modelSources[0] || ownMatch || packedSources[0] || null;
    // Asset dựng sẵn cũng tra ngược được: material mặc định nằm trong prefab nào, skybox do scene nào bật.
    const dependencySources = packedSources.length
      ? packedSources
      : (primarySource ? [primarySource] : (sourceMatch ? [sourceMatch] : packed.builtinEntries));
    const includedBy = Array.from(new Set(dependencySources.flatMap((entry) => (
      dependencyIndex.get(normalizeDependencyUuid(entry.uuid)) || []
    )))).slice(0, 3);
    const textureMeta = await readTextureMeta(file.fullPath, file.extension);
    return {
      fullPath: file.fullPath,
      relativePath: file.relativePath,
      name: file.name,
      extension: file.extension,
      size: file.size,
      category: file.category,
      source: primarySource ? primarySource.url : '',
      sourceUuid: primarySource ? primarySource.uuid : '',
      sourceNote: primarySource ? '' : describeUnmatchedSource(file, builtinSources),
      packedSourceCount: packedSources.length,
      packedSources: packedSources.map((entry) => ({ uuid: entry.uuid, url: entry.url })),
      builtinSources,
      builtinRefs,
      prefabSources: prefabSources.map((entry) => ({ uuid: entry.uuid, url: entry.url })),
      modelSources,
      includedBy,
      textureMeta,
      buildArea: classifyBuildArea(file.relativePath),
    };
  }));

  return rows.sort((left, right) => right.size - left.size);
}

// ---------------------------------------------------------------- source matching

/**
 * File build mang tên theo uuid của asset (`<uuid>.png`, `<uuid>@<sub>.png`, có thể kèm
 * md5 `<uuid>.<hash>.png`), nên chỉ khớp theo uuid. Không khớp theo tên / đường dẫn:
 * asset tên ngắn như "1" từng "khớp" mọi file có chữ số 1 (cả engine JS).
 * Sub-asset thử từ uuid đầy đủ lùi dần về uuid gốc.
 */
function findBestSourceMatch(file, assetEntriesByUuid) {
  // Font giữ tên gốc trong thư mục mang uuid: native/ce/<uuid>/Font.ttf.
  const parentName = path.basename(path.dirname(file.fullPath)).toLowerCase();
  for (const name of [path.basename(file.name, file.extension).toLowerCase(), parentName]) {
    const parts = name.split('@');
    parts[0] = parts[0].split('.')[0];
    for (let count = parts.length; count >= 1; count -= 1) {
      const candidate = parts.slice(0, count).join('@');
      const entry = assetEntriesByUuid.get(candidate) || assetEntriesByUuid.get(compactUuidString(candidate));
      if (entry) {
        return entry;
      }
    }
  }
  return null;
}

/** File build không map được asset nào trong db://assets: nói rõ nó là gì thay vì để trống. */
function describeUnmatchedSource(file, builtinSources) {
  const area = classifyBuildArea(file.relativePath);
  if (builtinSources.length === 1) {
    return `Asset dựng sẵn của engine: ${builtinSources[0].replace(/^db:\/\/internal\//, '')}`;
  }
  if (builtinSources.length) {
    return `${builtinSources.length} asset dựng sẵn của engine (effect, material...)`;
  }
  if (area === 'engine') {
    return 'Mã engine Cocos (không có asset nguồn)';
  }
  if (area === 'bootstrap src' || area === 'root') {
    return file.category === 'config' ? 'Cấu hình build (sinh tự động)' : 'File khởi động (sinh tự động)';
  }
  if (area === 'internal bundle') {
    return 'Bundle internal của engine';
  }
  if (file.category === 'game-js') {
    return 'Script game (mọi file .ts gộp lại)';
  }
  if (file.category === 'config') {
    return 'Cấu hình bundle (sinh tự động)';
  }
  return 'Sinh ra lúc build (không có asset nguồn)';
}

// ---------------------------------------------------------------- categorize

/** Loại của một file build (texture, audio, import-json, engine-js, config...). */
function categorizeBuildFile(relativePath, extension) {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/native/')) {
    return categorizeNativeExtension(extension);
  }
  if (normalized.includes('/import/')) {
    return extension === '.cconb' ? 'import-binary' : 'import-json';
  }
  const stable = stableBuildPath(normalized);
  if (stable.endsWith('/config.json') || stable.endsWith('/settings.json')) {
    return 'config';
  }
  if (extension === '.js') {
    return normalized.includes('cocos-js/') ? 'engine-js' : 'game-js';
  }
  // json, html, css, wasm...
  return extension ? extension.slice(1) : 'other';
}

function categorizeNativeExtension(extension) {
  switch (extension) {
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.webp':
    case '.bmp':
      return 'texture';
    case '.mp3':
    case '.wav':
    case '.ogg':
      return 'audio';
    case '.ttf':
    case '.otf':
    case '.woff':
    case '.woff2':
      return 'font';
    case '.bin':
      return 'model-bin';
    case '.json':
      return 'json';
    default:
      return 'native-other';
  }
}

function categorizeSourceExtension(extension) {
  switch (extension) {
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.webp':
    case '.bmp':
      return 'texture';
    case '.mp3':
    case '.wav':
    case '.ogg':
      return 'audio';
    case '.ttf':
    case '.otf':
    case '.woff':
    case '.woff2':
      return 'font';
    case '.fbx':
    case '.glb':
    case '.gltf':
      return 'model-source';
    case '.prefab':
      return 'prefab';
    case '.scene':
      return 'scene';
    default:
      return extension ? extension.slice(1) : 'asset';
  }
}

function classifyBuildArea(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.startsWith('assets/main/')) {
    return 'main bundle';
  }
  if (normalized.startsWith('assets/internal/')) {
    return 'internal bundle';
  }
  const bundle = /^assets\/([^/]+)\//.exec(normalized);
  if (bundle) {
    return `bundle ${bundle[1]}`;
  }
  if (normalized.startsWith('src/')) {
    return 'bootstrap src';
  }
  if (normalized.startsWith('cocos-js/')) {
    return 'engine';
  }
  return 'root';
}

// ---------------------------------------------------------------- small helpers

function compactUuidString(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function formatBytes(value) {
  const size = Math.max(0, Number(value) || 0);
  if (size >= 1024 * 1024) {
    return `${round(size / (1024 * 1024))} MB`;
  }
  if (size >= 1024) {
    return `${round(size / 1024)} KB`;
  }
  return `${Math.round(size)} B`;
}

module.exports = {
  scanBuild,
  diffAgainstSnapshot,
  stableBuildPath,
  findBuildSettings,
  readAssetEntries,
  normalizeDependencyUuid,
  decompressCocosUuid,
  configUuid,
  readBuildDebug,
  buildSourceSizeIndex,
  round,
  formatBytes,
};
