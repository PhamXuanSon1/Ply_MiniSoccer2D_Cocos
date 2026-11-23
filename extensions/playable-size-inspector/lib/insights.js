'use strict';

/**
 * "Việc nên làm" ở tab Tổng quan: suy ra từ kết quả quét (build + ảnh + audio nguồn + model 3D)
 * và vài file của project (scene/prefab, script, settings/v2/packages/engine.json). Gợi ý nào cũng
 * kèm bằng chứng cụ thể (file nào, node nào, bao nhiêu byte); không có bằng chứng thì không
 * gợi ý. Luật module engine và model 3D dùng chung với tab tương ứng (lib/engine-modules.js,
 * lib/model-compress.js) nên badge trên tab và gợi ý ở đây luôn khớp nhau. Các kiểm tra chung trên bản build
 * (logo splash, file trùng, font, tuỳ chọn build, cấu hình xuất của playable-ads-builder, PNG palette trên ảnh đục,
 * Spine JSON, tangent không dùng) nằm ở lib/build-checks.js, chạy được trên mọi dự án.
 *
 * Mỗi gợi ý có `saving`: dung lượng ước tính giảm được, cùng MỘT đơn vị cho mọi loại để xếp hạng: byte sau
 * zip (bản xuất gói mọi file vào zip, nên đây là con số gần với phần chiếm trong file HTML gửi mạng; ảnh /
 * audio vốn đã nén nên sau zip gần như bằng trong build). Ảnh: theo tỉ lệ nén thử / ảnh đã nén của dự án;
 * model: mesh sau zip khi bật Recommended; audio: phần thật sự tới được bản xuất (builder encode lại thì
 * tính theo bitrate của builder); module engine: phần file riêng của module trong build.
 * Chỉ dùng fs + zlib nên kiểm chứng được bằng node ngoài Editor.
 */

const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const {
  MODULE_RULES,
  activeConfig,
  includedModules,
  moduleUsage,
  moduleCodeZip,
  describeModules,
  moduleBuildShare,
} = require('./engine-modules');
const { HEAVY_TRIANGLES, modelBuildFiles, modelTodos, suggestRatio } = require('./model-compress');
const { formatBytes, findBuildSettings } = require('./build-scan');
const { listBuildFolders } = require('./build-folders');
const { isSameResolvedPath } = require('./fs-utils');
const { DEFAULT_BITRATE_KBPS } = require('./audio');
const { runBuildChecks } = require('./build-checks');
const { creatorVersion } = require('./compat');

const deflateRaw = promisify(zlib.deflateRaw);

const KB = 1024;
/** Ảnh chiếm từ mức này trong build trở lên thì đáng xem lại kích thước / preset. */
const LARGE_TEXTURE_BYTES = 100 * KB;
/** Audio dài và nặng hơn các mức này thì gợi ý cắt bớt vòng lặp. */
const LONG_AUDIO_SECONDS = 20;
const LONG_AUDIO_BYTES = 100 * KB;
/** Độ dài gợi ý khi cắt nhạc lặp (giây) - chỉ để ước tính dung lượng tiết kiệm. */
const SUGGESTED_LOOP_SECONDS = 15;
/** Shader dựng sẵn từ mức này trở lên mới đáng nêu tên. */
const LARGE_BUILTIN_BYTES = 150 * KB;
/** Ghi chú cho con số khi chưa có bản build (chỉ tính asset được dùng tới, xem reachableSourceUrls). */
const NO_BUILD_NOTE = ' (chưa có build: chỉ tính file scene / prefab / resources dùng tới)';

// Giả định để ước tính phần giảm được (ghi rõ trong `basis` của từng gợi ý).
/** Dung lượng còn lại sau Texture Compress khi dự án chưa có ảnh nào đã nén để đo (PNG chất lượng 80 thường còn khoảng một nửa). */
const DEFAULT_TEXTURE_RATIO = 0.5;
/** Ảnh lớn: giảm còn một nửa số điểm ảnh thì dung lượng còn khoảng một nửa. */
const LARGE_TEXTURE_SAVING = 0.5;
/** Recommended (Quantize + Encode) làm mesh nhỏ đi 3–5 lần sau zip: lấy mức thấp. */
const RECOMMENDED_ZIP_FACTOR = 3;

/**
 * Dung lượng sau zip của một file build (bản xuất gói mọi file vào zip). Chạy nền (không chặn panel),
 * nhớ theo đường dẫn + kích thước: MD5 Cache đổi tên file khi nội dung đổi.
 */
const zipCache = new Map();
function zippedSize(row) {
  const key = `${row.fullPath}|${row.size}`;
  if (!zipCache.has(key)) {
    if (zipCache.size > 4000) {
      zipCache.clear();
    }
    // File đã nén sẵn (wasm, mp3...) zip lại có thể dư vài byte: không bao giờ lớn hơn trong build.
    // Mức 9 như cột "sau zip" của tab Model 3D, để hai nơi ra cùng một số.
    zipCache.set(key, fs.readFile(row.fullPath)
      .then((data) => deflateRaw(data, { level: 9 }))
      .then((data) => Math.min(data.length, row.size))
      .catch(() => row.size));
  }
  return zipCache.get(key);
}

async function zippedSum(rows) {
  return sum(await Promise.all(rows.map(zippedSize)));
}

/** Nhãn bên phải mỗi việc, cùng một kiểu cho mọi gợi ý. */
function savingLabel(saving) {
  return `≈ tiết kiệm ${formatBytes(saving)}`;
}

// ---------------------------------------------------------------- đọc project

async function walk(root, out = []) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, out);
    } else if (entry.isFile()) {
      out.push(fullPath);
    }
  }
  return out;
}

function toAssetUrl(projectRoot, fullPath) {
  return `db://assets/${path.relative(path.join(projectRoot, 'assets'), fullPath).replace(/\\/g, '/')}`;
}

const MODEL_EXTENSIONS = new Set(['.fbx', '.glb', '.gltf']);

/**
 * Model 3D có skeleton / animation không (đọc .meta: sub-asset gltf-skeleton / gltf-animation). Prefab sinh từ
 * FBX nằm trong library/ nên scene đặt model đó không chứa cc.SkeletalAnimation: phải xét từ model.
 */
async function readModelEvidence(fullPath, projectRoot) {
  const meta = await readJson(`${fullPath}.meta`);
  if (!meta) {
    return null;
  }
  const importers = Object.values(meta.subMetas || {}).map((sub) => String(sub && sub.importer || ''));
  const finder = meta.userData && meta.userData.assetFinder;
  return {
    name: path.basename(fullPath),
    url: projectRoot ? toAssetUrl(projectRoot, fullPath) : '',
    skinned: importers.includes('gltf-skeleton') || !!(finder && Array.isArray(finder.skeletons) && finder.skeletons.length),
    animated: importers.includes('gltf-animation'),
  };
}

/**
 * Bằng chứng trong một bản build: tên class xuất hiện trong JSON import (cc.Mask, cc.SkeletalAnimation... kể cả
 * component của prefab sinh từ FBX) và src/settings.json. Nhớ theo thời điểm build (settings.json), null nếu
 * không phải bản build.
 */
const buildEvidenceCache = new Map();
async function readBuildEvidence(buildRoot) {
  const settingsPath = await findBuildSettings(buildRoot);
  const stat = settingsPath ? await fs.stat(settingsPath).catch(() => null) : null;
  if (!stat) {
    return null;
  }
  const key = `${buildRoot}|${stat.mtimeMs}`;
  if (!buildEvidenceCache.has(key)) {
    if (buildEvidenceCache.size > 32) {
      buildEvidenceCache.clear();
    }
    buildEvidenceCache.set(key, (async () => {
      const classes = new Set();
      for (const file of await walk(path.join(buildRoot, 'assets'))) {
        if (!/[\\/]import[\\/]/.test(file) || !/\.(json|cconb)$/i.test(file)) {
          continue;
        }
        const text = await fs.readFile(file, 'latin1').catch(() => '');
        for (const match of text.matchAll(/"((?:cc|sp|dragonBones)\.[A-Za-z_][\w.]*)"/g)) {
          classes.add(match[1]);
        }
      }
      return { name: path.basename(buildRoot), classes: [...classes], settings: await readJson(settingsPath) };
    })().catch(() => null));
  }
  return buildEvidenceCache.get(key);
}

/**
 * Scene/prefab (đã parse), nội dung script, danh sách file của assets/ - đọc một lần cho mọi luật:
 * { files, documents: [{ url, name, json, text }], scriptFiles: [{ name, text }], models: [{ name, url, skinned, animated }],
 *   builds: [{ name, classes, settings }], reachable: Set url | null } (engine-modules.moduleUsage đọc đúng dạng này).
 * `reachable`: chỉ khi chưa có bản build nào (xem reachableSourceUrls), có bản build thì null.
 * `builds`: mọi bản build web trong build/ (+ `buildRoots` truyền thêm): module có dấu hiệu ở bất kỳ bản build nào
 * cũng coi như đang dùng.
 */
async function readProjectEvidence(projectRoot, { buildRoots = [] } = {}) {
  const files = await walk(path.join(projectRoot, 'assets'));
  const documents = [];
  const scriptFiles = [];
  const models = [];
  for (const fullPath of files) {
    const extension = path.extname(fullPath).toLowerCase();
    if (extension === '.scene' || extension === '.prefab') {
      const text = await fs.readFile(fullPath, 'utf8').catch(() => '');
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_error) {
        continue;
      }
      documents.push({ url: toAssetUrl(projectRoot, fullPath), name: path.basename(fullPath), json, text });
    } else if (extension === '.ts' || extension === '.js') {
      const text = await fs.readFile(fullPath, 'utf8').catch(() => '');
      scriptFiles.push({ name: path.basename(fullPath), text });
    } else if (MODEL_EXTENSIONS.has(extension)) {
      const model = await readModelEvidence(fullPath, projectRoot);
      if (model) {
        models.push(model);
      }
    }
  }
  const roots = (await listBuildFolders(projectRoot).catch(() => [])).map((item) => item.fullPath);
  for (const root of buildRoots.filter(Boolean)) {
    if (!roots.some((item) => isSameResolvedPath(item, root))) {
      roots.push(root);
    }
  }
  const builds = (await Promise.all(roots.map(readBuildEvidence))).filter(Boolean);
  // Chưa có bản build nào: asset nào scene / resources / bundle thật sự dùng tới (engine-modules.moduleUsage không coi
  // prefab / model thừa trong assets/ là "đang dùng chắc chắn"). null khi chưa có library/.
  const reachable = builds.length ? null : await reachableSourceUrls(projectRoot, { files, documents }).catch(() => null);
  return { files, documents, scriptFiles, models, builds, reachable };
}

/** Asset dạng văn bản có thể tham chiếu asset khác bằng "__uuid__" (đọc khi lan từ scene ra). */
const REFERENCING_EXTENSIONS = new Set(['.scene', '.prefab', '.mtl', '.material', '.anim', '.animgraph', '.pmtl', '.json', '.labelatlas']);
const MODEL_META_EXTENSIONS = new Set(['.fbx', '.gltf', '.glb']);

/**
 * Asset có thể vào build khi chưa có bản build để đối chiếu: lan theo "__uuid__" từ mọi scene, mọi asset trong thư
 * mục resources/ và thư mục bundle (meta thư mục có userData.isBundle). Model thì lan thêm theo .meta (ảnh / material
 * của FBX). Trả về Set url gốc (db://assets/..., bỏ @sub), null nếu chưa có library/.assets-data.json.
 */
async function reachableSourceUrls(projectRoot, evidence) {
  const data = await readJson(path.join(projectRoot, 'library', '.assets-data.json'));
  if (!data) {
    return null;
  }
  const urlByUuid = new Map();
  for (const [uuid, info] of Object.entries(data)) {
    const url = String((info && info.url) || '');
    if (url.startsWith('db://assets/')) {
      urlByUuid.set(uuid.split('@')[0].toLowerCase(), url.split('@')[0]);
    }
  }
  const assetsDir = path.join(projectRoot, 'assets');
  const fileSet = new Set(evidence.files.map((file) => path.resolve(file)));
  const roots = new Set();
  for (const file of evidence.files) {
    const url = toAssetUrl(projectRoot, file);
    if (/\.scene$/i.test(file)) {
      roots.add(url);
    } else if (/(^|\/)resources\//.test(url.slice('db://assets/'.length)) && !/\.meta$/i.test(file)) {
      roots.add(url);
    }
  }
  // Thư mục bundle: meta của thư mục (file .meta mà phần trước nó không phải file) có userData.isBundle.
  for (const file of evidence.files.filter((item) => /\.meta$/i.test(item) && !fileSet.has(path.resolve(item.slice(0, -5))))) {
    const meta = await readJson(file);
    if (meta && meta.userData && meta.userData.isBundle) {
      const prefix = `${toAssetUrl(projectRoot, file.slice(0, -5))}/`;
      for (const other of evidence.files) {
        const url = toAssetUrl(projectRoot, other);
        if (url.startsWith(prefix) && !/\.meta$/i.test(other)) {
          roots.add(url);
        }
      }
    }
  }
  const textByUrl = new Map(evidence.documents.map((document) => [document.url, document.text]));
  const reached = new Set();
  const queue = [...roots];
  while (queue.length) {
    const url = queue.pop();
    if (reached.has(url)) {
      continue;
    }
    reached.add(url);
    const extension = path.extname(url).toLowerCase();
    let text = textByUrl.get(url);
    const fullPath = path.join(assetsDir, url.slice('db://assets/'.length));
    if (text === undefined && REFERENCING_EXTENSIONS.has(extension)) {
      text = await fs.readFile(fullPath, 'utf8').catch(() => '');
    }
    if (MODEL_META_EXTENSIONS.has(extension)) {
      text = `${text || ''}\n${await fs.readFile(`${fullPath}.meta`, 'utf8').catch(() => '')}`;
    }
    if (!text) {
      continue;
    }
    for (const match of text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) {
      const target = urlByUuid.get(match[0].toLowerCase());
      if (target && !reached.has(target)) {
        queue.push(target);
      }
    }
    // Model: ảnh gán theo db:// url trong imageMetas.
    for (const match of text.matchAll(/"(db:\/\/assets\/[^"@]+)/g)) {
      if (!reached.has(match[1])) {
        queue.push(match[1]);
      }
    }
  }
  return reached;
}

/** Đường dẫn node trong scene/prefab: "PlayScene/UI/Top/Cube". */
function nodePath(json, index) {
  const names = [];
  let node = json[index];
  let guard = 0;
  while (node && guard < 64) {
    names.unshift(node._name || '?');
    node = node._parent ? json[node._parent.__id__] : null;
    guard += 1;
  }
  return names.join('/');
}

/** Node có component tham chiếu tới một trong các uuid (vd material mặc định). */
function findNodesUsing(documents, uuids) {
  const found = [];
  for (const document of documents) {
    if (!uuids.some((uuid) => document.text.includes(uuid))) {
      continue;
    }
    document.json.forEach((object, index) => {
      if (!object || !object.node || typeof object.node.__id__ !== 'number') {
        return;
      }
      const text = JSON.stringify(object);
      if (uuids.some((uuid) => text.includes(uuid))) {
        found.push({ document: document.name, url: document.url, path: nodePath(document.json, object.node.__id__), component: object.__type__ });
      }
    });
  }
  return found;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

/** Cấu hình module engine của dự án (Project Settings → Feature Cropping), null nếu chưa có. */
async function readEngineModules(projectRoot) {
  const json = await readJson(path.join(projectRoot, 'settings', 'v2', 'packages', 'engine.json'));
  return (json && json.modules) || null;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function listNames(names, limit = 3) {
  const shown = names.slice(0, limit).join(', ');
  return names.length > limit ? `${shown} và ${names.length - limit} mục khác` : shown;
}

function baseName(url) {
  return String(url || '').split('/').pop();
}

// ---------------------------------------------------------------- các luật

/** Skybox mặc định của engine bị đóng gói (kể cả khi scene đã tắt Skybox). */
function skyboxInsight({ rows, launchDocument }) {
  const skyRows = rows.filter((row) => row.builtinSources.some((url) => url.includes('/default_skybox/')));
  if (!skyRows.length) {
    return null;
  }
  const bytes = sum(skyRows.map((row) => row.size));
  const images = skyRows.filter((row) => row.category === 'texture').length;
  const info = launchDocument ? launchDocument.json.find((object) => object && object.__type__ === 'cc.SkyboxInfo') : null;
  const sceneName = launchDocument ? launchDocument.name : 'scene khởi động';
  const disabled = info && info._enabled === false;
  // Ảnh cubemap: sau zip gần như không nhỏ đi, bỏ được hẳn khỏi build.
  return {
    id: 'skybox',
    group: 'engine',
    bytes,
    saving: bytes,
    impact: savingLabel(bytes),
    basis: `${formatBytes(bytes)} trong build, bỏ được hẳn`,
    title: disabled ? 'Skybox đã tắt nhưng ảnh skybox mặc định vẫn bị đóng gói' : 'Skybox mặc định của engine',
    detail: disabled
      ? `${sceneName} tắt Skybox nhưng ô Envmap vẫn trỏ tới skybox mặc định, nên ${images} ảnh cubemap vẫn vào build. Chọn node gốc của scene → mục Skybox → xoá ô Envmap (bật / tắt Use HDR để xoá cả ô còn lại) rồi build lại.`
      : `${sceneName} đang bật Skybox mặc định (${images} ảnh cubemap). Nếu camera không nhìn thấy bầu trời (game 2D, góc nhìn cố định) thì tắt Skybox và xoá ô Envmap rồi build lại.`,
    action: launchDocument ? { type: 'reveal', url: launchDocument.url, label: 'Chọn scene' } : null,
  };
}

/**
 * Asset nào dùng trực tiếp một uuid: Editor ghi `value.depends` cho từng asset (kể cả sub-asset
 * của FBX / GLB) trong library/.assets-data.json. Map uuid gốc -> [{ uuid, url }].
 */
async function readDependents(projectRoot) {
  const data = await readJson(path.join(projectRoot, 'library', '.assets-data.json'));
  const dependents = new Map();
  for (const [uuid, info] of Object.entries(data || {})) {
    const depends = info && info.value && Array.isArray(info.value.depends) ? info.value.depends : [];
    for (const dependency of depends) {
      const key = String(dependency).split('@')[0].toLowerCase();
      if (!dependents.has(key)) {
        dependents.set(key, []);
      }
      dependents.get(key).push({ uuid, url: String(info.url || '') });
    }
  }
  return dependents;
}

/**
 * Shader dựng sẵn nặng nằm ngoài bundle internal (vd builtin-standard, imported-specular-glossiness)
 * kèm thứ kéo nó vào: node dùng material mặc định, material của project, hoặc material đi kèm model.
 * Pack shader là JSON nên sau zip nhỏ đi nhiều: phần giảm được tính theo dung lượng sau zip.
 */
async function builtinShaderInsights({ rows, evidence }) {
  const insights = [];
  // Sub-asset có trong build (material của FBX nằm trong pack nào đó): chỉ nêu model thật sự vào build.
  const inBuild = new Set(rows.flatMap((row) => [row.source, ...row.packedSources.map((source) => source.url)]).filter(Boolean));
  for (const row of rows) {
    if (row.buildArea === 'internal bundle' || row.size < LARGE_BUILTIN_BYTES) {
      continue;
    }
    const effects = row.builtinRefs.filter((ref) => ref.url.includes('/effects/'));
    if (!effects.length) {
      continue;
    }
    const materials = row.builtinRefs.filter((ref) => ref.url.includes('/default_materials/'));
    const nodes = findNodesUsing(evidence.documents, materials.map((ref) => ref.uuid));
    const users = effects.flatMap((ref) => evidence.dependents.get(ref.uuid) || []);
    // Chỉ nêu material / model thật sự có trong build; project thường còn nhiều thứ dùng chung shader mà không vào build.
    const materialUsers = users.filter((user) => /\.mtl$/i.test(user.url));
    const modelUsers = users.filter((user) => /\.(fbx|glb|gltf)@/i.test(user.url));
    const materialsInBuild = materialUsers.filter((user) => inBuild.has(user.url));
    const modelsInBuild = modelUsers.filter((user) => inBuild.has(user.url));
    const nothingMatched = !nodes.length && !materialsInBuild.length && !modelsInBuild.length;
    const projectMaterials = [...new Set((nothingMatched ? materialUsers : materialsInBuild).map((user) => user.url))];
    const models = [...new Set((nothingMatched ? modelUsers : modelsInBuild).map((user) => user.url.split('@')[0]))];
    const effectNames = effects.map((ref) => baseName(ref.url).replace(/\.effect$/, ''));
    const isPbr = /standard|specular|metallic|pbr/i.test(effectNames.join(' '));

    const reasons = [];
    if (nodes.length) {
      reasons.push(`${nodes.length} node dùng material mặc định của engine: ${listNames(nodes.map((node) => node.path))}`);
    }
    if (projectMaterials.length) {
      reasons.push(`${projectMaterials.length} material của project dùng shader này: ${listNames(projectMaterials.map(baseName))}`);
    }
    if (models.length) {
      reasons.push(`material đi kèm ${models.length} model: ${listNames(models.map(baseName))}`);
    }
    let advice;
    if (!isPbr) {
      advice = 'Shader này chỉ bỏ được khi không còn thứ nào ở trên dùng nó (xoá node / đổi sang material khác), rồi build lại.';
    } else if (models.length && !nodes.length && !projectMaterials.length) {
      advice = 'Nếu không cần ánh sáng PBR, gán material của project (dùng builtin-unlit hoặc shader riêng) cho MeshRenderer thay cho material đi kèm model, rồi build lại.';
    } else {
      advice = 'Nếu không cần ánh sáng PBR, xoá MeshRenderer thừa hoặc đổi sang material dùng builtin-unlit (nhẹ hơn nhiều), rồi build lại.';
    }
    if (nothingMatched && (projectMaterials.length || models.length)) {
      advice = `Không xác định được chính xác thứ nào trong build dùng nó; các asset trên có dùng shader này. ${advice}`;
    }
    const firstUser = nodes[0] ? { url: nodes[0].url, label: `Chọn ${nodes[0].document}` }
      : projectMaterials[0] ? { url: projectMaterials[0], label: 'Chọn material' }
        : models[0] ? { url: models[0], label: 'Chọn model' } : null;
    const zipped = await zippedSize(row);
    insights.push({
      id: `builtin-shader:${row.relativePath}`,
      group: 'engine',
      bytes: row.size,
      saving: zipped,
      impact: savingLabel(zipped),
      basis: `${formatBytes(row.size)} trong build · ${formatBytes(zipped)} sau zip`,
      title: `Shader dựng sẵn ${effectNames.join(', ')} nặng ${formatBytes(row.size)}`,
      detail: `${reasons.length ? `Bị kéo vào vì ${reasons.join('; ')}.` : 'Có material trong build dùng shader này.'} ${advice}`,
      action: firstUser ? { type: 'reveal', url: firstUser.url, label: firstUser.label } : null,
    });
  }
  return insights;
}

/**
 * Module engine đang bật mà không thấy dấu hiệu sử dụng nào trong project: cùng kết luận với tab Module
 * engine (engine-modules.describeModules). Module mà module khác đang bật cần tới (`blocked`, chỉ biết khi
 * có `moduleConfig` từ Editor) thì không tắt được nên bỏ qua. Trả về [{ key, label, ids }].
 */
function unusedModules(modules, evidence, moduleConfig, version) {
  const described = describeModules(modules, evidence, moduleConfig, { version });
  if (described.ok) {
    // Định dạng cũ (Cocos 3.6 / 3.7): mục nào cũng `blocked` vì tool không ghi, nhưng vẫn là việc nên làm (tự tắt trong Feature Cropping).
    return described.entries
      .filter((entry) => entry.enabled && !entry.used && (!entry.blocked || entry.legacy))
      .map((entry) => ({ key: entry.key, label: entry.label, ids: entry.ids }));
  }
  // Dự án chưa lưu Feature Cropping: chỉ còn danh sách module định dạng cũ, tool không bật / tắt hộ được.
  const included = includedModules(modules);
  return MODULE_RULES
    .map((rule) => ({ rule, ids: included.filter((name) => rule.match(name)) }))
    .filter((item) => item.ids.length && !moduleUsage(item.rule, evidence).used)
    .map((item) => ({ key: item.rule.key, label: item.rule.label, ids: item.ids }));
}

/**
 * Phần giảm được = phần của các module đó trong bản build (moduleBuildShare: file wasm / chunk JS riêng, Post
 * Process thì phần của các effect trong pack internal - ước lượng thô, cùng cách tính với tab Module engine),
 * tính sau zip, cộng phần mã engine chung của module không có file riêng mà đã đo trước (moduleCodeZip: profiler,
 * mask, primitive... đo trên engine 3.8.8). Module không có số nào thì saving 0.
 */
async function moduleInsight({ modules, moduleConfig, evidence, rows, version }) {
  const unused = unusedModules(modules, evidence, moduleConfig, version);
  if (!unused.length) {
    return null;
  }
  const shares = unused.map((item) => moduleBuildShare(item.key, rows));
  const parts = shares.flatMap((share) => share.parts);
  const bytes = Math.round(sum(parts.map((part) => part.row.size * part.share)));
  const zipped = await Promise.all(parts.map((part) => zippedSize(part.row)));
  const fileSaving = Math.round(sum(parts.map((part, index) => zipped[index] * part.share)));
  // Mã engine chung: chỉ tính module không có file riêng trong build (có file riêng thì đã tính ở trên).
  const code = unused.filter((item, index) => !shares[index].parts.length).map((item) => ({ item, zip: moduleCodeZip(item.key) })).filter((entry) => entry.zip);
  const codeSaving = sum(code.map((entry) => entry.zip));
  const saving = fileSaving + codeSaving;
  // Post Process kéo theo cả loạt effect của pipeline vào bundle internal: nêu số đó làm bằng chứng.
  const effects = sum(shares.map((share) => share.effects));
  const basisParts = [];
  if (fileSaving) {
    basisParts.push(`${formatBytes(bytes)} file riêng trong build${shares.some((share) => share.estimated) ? ' (ước lượng)' : ''}`);
  }
  if (codeSaving) {
    basisParts.push(`≈ ${formatBytes(codeSaving)} mã engine của ${code.map((entry) => entry.item.label).join(', ')} (đo trên engine 3.8.8)`);
  }
  return {
    id: 'modules',
    group: 'engine',
    bytes,
    saving,
    impact: saving ? savingLabel(saving) : 'giảm mã engine',
    basis: saving
      ? `${basisParts.join(' + ')}${unused.length > code.length + shares.filter((share) => share.parts.length).length ? ', chưa tính phần trong mã engine chung của module còn lại' : ''}`
      : 'chưa đo được trước: build lại để thấy',
    title: `Module engine đang bật nhưng không thấy dùng: ${unused.map((item) => item.label).join(', ')}`,
    detail: `Không có component hay script nào trong assets/ dùng tới.${effects ? ` Riêng Post Process kéo theo ${effects} effect (bloom, TAA, FSR...) vào bundle internal.` : ''} ${activeConfig(modules) ? 'Tắt ngay trong tool (Tối ưu → Module engine, hoàn tác được) hoặc ở' : 'Tắt ở'} Project Settings → Feature Cropping (${unused.flatMap((item) => item.ids).join(', ')}), rồi build lại để thấy giảm bao nhiêu.`,
    action: activeConfig(modules)
      ? { type: 'modules', keys: unused.map((item) => item.key), label: 'Tắt trong tool' }
      : { type: 'open-settings', tab: 'engine', subTab: 'modules', label: 'Mở Feature Cropping' },
  };
}

/**
 * Tỉ lệ dung lượng sau / trước Texture Compress: nén thử của tab Ảnh (preset đang chọn) nếu ảnh đó đã có,
 * không thì đo từ các ảnh dự án đã nén (cache của Cocos), chưa có ảnh nào thì DEFAULT_TEXTURE_RATIO.
 * Trả về { ratioOf(row), estimated(row): có số nén thử không, project: { ratio, samples } }.
 */
function textureRatios(textures, estimates) {
  const samples = textures.filter((row) => row.enabled && row.compressed && !row.compressed.stale && row.compressed.sourceBytes > 0);
  const before = sum(samples.map((row) => row.compressed.sourceBytes));
  const project = { ratio: before > 0 ? Math.min(1, sum(samples.map((row) => row.compressed.bytes)) / before) : DEFAULT_TEXTURE_RATIO, samples: samples.length };
  const estimateOf = (url) => (!estimates ? null : estimates instanceof Map ? estimates.get(url) : estimates[url]);
  return {
    project,
    ratioOf: (row) => {
      const estimate = estimateOf(row.url);
      return estimate && !estimate.error && estimate.sourceBytes > 0 ? Math.min(1, estimate.bytes / estimate.sourceBytes) : project.ratio;
    },
    estimated: (row) => {
      const estimate = estimateOf(row.url);
      return !!(estimate && !estimate.error && estimate.sourceBytes > 0);
    },
  };
}

function textureInsights({ textures, buildSizeBySource, rows, textureEstimates, noBuildNote = '' }) {
  if (!textures || !textures.length) {
    return [];
  }
  const inBuild = (row) => {
    const info = buildSizeBySource ? buildSizeBySource.get(row.url) : null;
    return info ? info.bytes : 0;
  };
  const ratios = textureRatios(textures, textureEstimates);
  const insights = [];

  // Ảnh đã ghép vào auto-atlas (sprite frame nằm chung pack với .pac trong build và cùng thư mục)
  // mà ảnh gốc vẫn có trong build (Cocos không nén nó) -> cùng pixel bị đóng gói hai lần.
  const duplicated = new Set();
  if (buildSizeBySource) {
    const atlases = textures.filter((row) => row.kind === 'auto-atlas' && inBuild(row) > 0);
    for (const atlas of atlases) {
      const folder = atlas.url.slice(0, atlas.url.lastIndexOf('/') + 1);
      const packedWithAtlas = new Set(rows
        .filter((row) => row.packedSources.some((source) => source.url === atlas.url))
        .flatMap((row) => row.packedSources.map((source) => source.url.split('@')[0])));
      const images = textures
        .filter((row) => row.kind !== 'auto-atlas' && row.url.startsWith(folder) && packedWithAtlas.has(row.url) && inBuild(row) > 0)
        .sort((left, right) => inBuild(right) - inBuild(left));
      if (!images.length) {
        continue;
      }
      images.forEach((row) => duplicated.add(row.url));
      const bytes = sum(images.map(inBuild));
      insights.push({
        id: `texture-atlas-duplicate:${atlas.url}`,
        group: 'texture',
        bytes,
        // Bản gốc thừa bỏ được hẳn (bản trong auto-atlas đã nén vẫn còn).
        saving: bytes,
        impact: savingLabel(bytes),
        basis: `${formatBytes(bytes)} ảnh gốc thừa trong build`,
        title: `${images.length} ảnh bị đóng gói 2 lần: trong auto-atlas và ảnh gốc chưa nén`,
        detail: `${listNames(images.map((row) => `${baseName(row.url)} (${formatBytes(inBuild(row))})`))} đã được ghép vào ${atlas.url.replace(/^db:\/\/assets\//, '')}, nhưng ảnh gốc vẫn vào build và không được Texture Compress nén. Kéo các ảnh lớn ra khỏi thư mục có auto-atlas (làm trong panel Assets để giữ uuid) để chỉ còn một bản đã nén.`,
        action: { type: 'texture', urls: images.map((row) => row.url), label: 'Chọn các ảnh này' },
      });
    }
  }

  // Phần bật nén giảm được của từng ảnh (ảnh đóng gói 2 lần đã tính ở trên: bỏ bản gốc chứ không nén nó).
  const sizeOf = (row) => (buildSizeBySource ? inBuild(row) : row.bytes);
  const compressSaving = (row) => (row.enabled || duplicated.has(row.url) ? 0 : Math.round(sizeOf(row) * (1 - ratios.ratioOf(row))));
  const uncompressed = textures.filter((row) => !row.enabled && (!buildSizeBySource || inBuild(row) > 0));
  // Ảnh chỉ còn bản đóng gói 2 lần thì gợi ý auto-atlas ở trên đã lo, không thêm dòng "tiết kiệm 0 B".
  if (uncompressed.some((row) => !duplicated.has(row.url))) {
    const bytes = sum(uncompressed.map(sizeOf));
    const saving = sum(uncompressed.map(compressSaving));
    // Dòng giải thích ghi đúng phần tỉ lệ nén áp vào (ảnh đóng gói 2 lần không tính ở đây).
    const rated = uncompressed.filter((row) => !duplicated.has(row.url));
    const ratedBytes = sum(rated.map(sizeOf));
    const tried = rated.filter(ratios.estimated).length;
    // Tỉ lệ lấy từ đâu: nén thử ở tab Ảnh, ảnh dự án đã nén, hoặc giả định khi chưa có ảnh nào đã nén.
    const how = tried && tried === rated.length
      ? 'theo nén thử ở tab Ảnh'
      : ratios.project.samples
        ? `còn ≈ ${Math.round(ratios.project.ratio * 100)}% như ${ratios.project.samples} ảnh đã nén${tried ? `, ${tried} ảnh theo nén thử` : ''}`
        : `giả định còn ≈ ${Math.round(DEFAULT_TEXTURE_RATIO * 100)}%`;
    insights.push({
      id: 'texture-uncompressed',
      group: 'texture',
      bytes,
      saving,
      impact: savingLabel(saving),
      basis: rated.length
        ? `${formatBytes(ratedBytes)} ${buildSizeBySource ? 'trong build' : `ảnh nguồn${noBuildNote}`} · ${how}`
        : 'các ảnh này đóng gói 2 lần: bỏ bản gốc (gợi ý auto-atlas), không cần nén',
      title: `${uncompressed.length} ảnh chưa bật Texture Compress`,
      detail: `${listNames(uncompressed.map((row) => baseName(row.url)))}. Bật nén với preset của project; tool nén thử và báo trước dung lượng sau nén.`,
      action: { type: 'texture', urls: uncompressed.map((row) => row.url), label: 'Chọn các ảnh này' },
    });
  }

  if (buildSizeBySource) {
    const large = textures
      .filter((row) => inBuild(row) >= LARGE_TEXTURE_BYTES && !duplicated.has(row.url))
      .sort((left, right) => inBuild(right) - inBuild(left));
    if (large.length) {
      const bytes = sum(large.map(inBuild));
      // Tính trên phần còn lại sau khi bật nén (ảnh chưa nén đã tính ở gợi ý trên), không cộng hai lần.
      const saving = Math.round(sum(large.map((row) => (inBuild(row) - compressSaving(row)) * LARGE_TEXTURE_SAVING)));
      insights.push({
        id: 'texture-large',
        group: 'texture',
        bytes,
        saving,
        impact: savingLabel(saving),
        basis: `${formatBytes(bytes)} trong build · nếu giảm còn ½ số điểm ảnh`,
        title: `${large.length} ảnh chiếm hơn ${formatBytes(LARGE_TEXTURE_BYTES)} mỗi ảnh trong build`,
        detail: `${listNames(large.map((row) => `${baseName(row.url)} (${formatBytes(inBuild(row))})`))}. Thử preset nén mạnh hơn, hoặc giảm kích thước ảnh nếu nó hiển thị nhỏ hơn kích thước gốc.`,
        action: { type: 'texture', urls: large.map((row) => row.url), label: 'Chọn các ảnh này' },
      });
    }
  }
  return insights;
}

/**
 * Audio. Có bản build thì chỉ xét file có trong build. playable-ads-builder bật nén audio thì lúc xuất nó
 * encode lại MỌI audio ở bitrate của nó (không downmix, CBR), nên đổi sang MP3 / mono / hạ bitrate trong
 * assets/ chỉ làm nhỏ thư mục build web-mobile chứ file HTML gần như không đổi: vẫn nêu nhưng saving 0
 * (cuối danh sách). Cắt bớt độ dài (audio-long) mới là cách giảm thật; khi builder encode lại, phần audio
 * trong bản xuất là độ dài × bitrate của builder nên phần cắt được cũng tính theo đó.
 */
function audioInsights({ audio, builderAudio, buildSizeBySource, noBuildNote = '' }) {
  if (!audio || !audio.length) {
    return [];
  }
  const reencoded = !!(builderAudio && builderAudio.enabled && builderAudio.bitrateKbps);
  const targetKbps = reencoded ? builderAudio.bitrateKbps : DEFAULT_BITRATE_KBPS;
  const bytesAt = (seconds, kbps) => Math.round(seconds * kbps * 1000 / 8);
  const durationOf = (file) => (file.probe ? Number(file.probe.durationSeconds) || 0 : 0);
  const estimateBytes = (file) => (durationOf(file) ? bytesAt(durationOf(file), targetKbps) : file.bytes);
  const buildBytes = (file) => {
    const info = buildSizeBySource ? buildSizeBySource.get(file.url) : null;
    return info ? info.bytes : 0;
  };
  // Dung lượng đang chiếm: trong build (có bản build) hoặc file nguồn.
  const sizeOf = (file) => (buildSizeBySource ? buildBytes(file) : file.bytes);
  const files = buildSizeBySource ? audio.filter((file) => buildBytes(file) > 0) : audio;
  const insights = [];

  const candidates = files
    .map((file) => {
      const reasons = [];
      if (!file.isMp3) {
        reasons.push('chưa phải MP3');
      }
      if (file.probe && file.probe.channels > 1) {
        reasons.push('stereo');
      }
      if (file.probe && file.probe.bitRateKbps > targetKbps + 8) {
        reasons.push(`${file.probe.bitRateKbps} kbps`);
      }
      // Lọc theo file nguồn như tab Âm thanh (worthReencode) để hai nơi chọn cùng các file; phần giảm tính theo build.
      return { file, reasons, worth: file.bytes - estimateBytes(file), saving: Math.max(0, sizeOf(file) - estimateBytes(file)) };
    })
    .filter((item) => item.reasons.length && item.worth > 2 * KB)
    .sort((left, right) => right.saving - left.saving);
  const reencodable = new Set(candidates.map((item) => item.file.url));
  if (candidates.length) {
    const saving = sum(candidates.map((item) => item.saving));
    const names = listNames(candidates.map((item) => `${baseName(item.file.url)} (${item.reasons.join(', ')})`));
    insights.push({
      id: 'audio-encode',
      group: 'audio',
      bytes: sum(candidates.map((item) => sizeOf(item.file))),
      saving: reencoded ? 0 : saving,
      impact: reencoded ? 'bản xuất không đổi' : savingLabel(saving),
      basis: reencoded
        ? `chỉ giảm build web-mobile ≈ ${formatBytes(saving)}`
        : `${formatBytes(sum(candidates.map((item) => sizeOf(item.file))))} ${buildSizeBySource ? 'trong build' : `nguồn${noBuildNote}`} → MP3 ${targetKbps} kbps`,
      title: `${candidates.length} audio nén thêm được (MP3 ${targetKbps} kbps mono)`,
      detail: reencoded
        ? `${names}. Chỉ giảm thư mục build web-mobile: ${builderAudio.packageName || 'playable-ads-builder'} vẫn encode lại mọi audio ở ${targetKbps} kbps khi xuất nên file HTML gần như không đổi.`
        : names,
      action: { type: 'audio', urls: candidates.map((item) => item.file.url), label: 'Chọn các file này' },
    });
  }

  for (const file of files) {
    const duration = durationOf(file);
    // Phần file này chiếm trong bản xuất: builder encode lại thì theo bitrate của nó; không thì như hiện tại,
    // hoặc như sau khi nén lại nếu file đã nằm trong gợi ý trên (không cộng hai lần).
    const bytes = reencoded ? bytesAt(duration, targetKbps) : reencodable.has(file.url) ? estimateBytes(file) : sizeOf(file);
    if (duration < LONG_AUDIO_SECONDS || bytes < LONG_AUDIO_BYTES) {
      continue;
    }
    const saving = Math.round(bytes * (1 - SUGGESTED_LOOP_SECONDS / duration));
    insights.push({
      id: `audio-long:${file.url}`,
      group: 'audio',
      bytes: sizeOf(file),
      saving,
      impact: savingLabel(saving),
      basis: reencoded
        ? `bản xuất ≈ ${formatBytes(bytes)} (encode lại ${targetKbps} kbps) · cắt còn ${SUGGESTED_LOOP_SECONDS} giây`
        : `${formatBytes(bytes)} ${buildSizeBySource ? 'trong build' : `nguồn${noBuildNote}`} · cắt còn ${SUGGESTED_LOOP_SECONDS} giây`,
      title: `${baseName(file.url)} dài ${Math.round(duration)} giây (${formatBytes(sizeOf(file))})`,
      detail: `Nhạc lặp lại được thì chỉ cần giữ một vòng ngắn: cắt còn khoảng ${SUGGESTED_LOOP_SECONDS} giây giảm được chừng ${formatBytes(saving)}${reencoded ? ' trong bản xuất' : ''}. Nghe thử và cắt ngay trong tool.`,
      action: { type: 'audio-open', url: file.url, label: 'Mở trình cắt' },
    });
  }
  return insights;
}

/**
 * Model trong build chưa nén mesh / quá nhiều tam giác: cùng luật với tab Model 3D (model-compress.modelTodos).
 * Mesh số thực gần như không nén được khi zip nên tính theo dung lượng sau zip (con số tab Model 3D hiện):
 * Recommended nhỏ đi ≈ RECOMMENDED_ZIP_FACTOR lần; giảm tam giác theo Target Ratio gợi ý, tính trên phần còn
 * lại sau khi nén (model vừa chưa nén vừa nặng không bị cộng hai lần).
 */
async function modelInsights({ models, rows }) {
  if (!models || !models.length || !rows.length) {
    return [];
  }
  const inBuild = await Promise.all(models
    .map((model) => ({ model, files: modelBuildFiles(model, rows) }))
    .filter((item) => item.files.length)
    .map(async (item) => ({
      ...item,
      bytes: sum(item.files.map((row) => row.size)),
      zipped: await zippedSum(item.files),
      todos: modelTodos(item.model, true),
    })));
  const afterCompress = (item) => (item.todos.includes('uncompressed') ? item.zipped / RECOMMENDED_ZIP_FACTOR : item.zipped);
  const insights = [];
  const uncompressed = inBuild.filter((item) => item.todos.includes('uncompressed')).sort((left, right) => right.zipped - left.zipped);
  if (uncompressed.length) {
    const bytes = sum(uncompressed.map((item) => item.bytes));
    const zipped = sum(uncompressed.map((item) => item.zipped));
    const saving = Math.round(zipped * (1 - 1 / RECOMMENDED_ZIP_FACTOR));
    insights.push({
      id: 'model-uncompressed',
      group: 'model',
      bytes,
      saving,
      impact: savingLabel(saving),
      basis: `mesh ${formatBytes(zipped)} sau zip · Recommended nhỏ đi ≈ ${RECOMMENDED_ZIP_FACTOR} lần`,
      title: `${uncompressed.length} model chưa nén mesh`,
      detail: `${listNames(uncompressed.map((item) => `${baseName(item.model.url)} (${formatBytes(item.bytes)})`))}. Mesh đang lưu số thực 32-bit nên zip gần như không nén được. Bật Quantize + Encode (thẻ Recommended) thường nhỏ đi 3–5 lần sau zip; tool tự bật module meshopt cần cho Encode.`,
      action: { type: 'model', urls: uncompressed.map((item) => item.model.url), label: 'Chọn các model này' },
    });
  }
  const heavy = inBuild.filter((item) => item.todos.includes('heavy')).sort((left, right) => right.model.triangles - left.model.triangles);
  if (heavy.length) {
    const bytes = sum(heavy.map((item) => item.bytes));
    const keep = (item) => item.model.suggestRatio || suggestRatio(item.model.triangles);
    const saving = Math.round(sum(heavy.map((item) => afterCompress(item) * (1 - keep(item)))));
    insights.push({
      id: 'model-heavy',
      group: 'model',
      bytes,
      saving,
      impact: savingLabel(saving),
      basis: `mesh ${formatBytes(sum(heavy.map((item) => item.zipped)))} sau zip · nếu giảm theo Target Ratio gợi ý`,
      title: `${heavy.length} model nhiều tam giác (từ ${HEAVY_TRIANGLES.toLocaleString('vi-VN')})`,
      detail: `${listNames(heavy.map((item) => `${baseName(item.model.url)} (${item.model.triangles.toLocaleString('vi-VN')} tam giác)`))}. Vật nhỏ trên màn hình playable không cần nhiều chi tiết vậy: thử Mesh Simplify (Target Ratio theo gợi ý, xem trước) rồi Apply.`,
      action: { type: 'model', urls: heavy.map((item) => item.model.url), label: 'Chọn các model này' },
    });
  }
  return insights;
}

/**
 * Kiểm tra chung trên bản build (lib/build-checks.js): logo splash, file trùng, font (ký tự thật sự dùng / nhãn
 * đang tắt), tuỳ chọn build, cấu hình xuất của playable-ads-builder, PNG palette trên ảnh đục, Spine JSON,
 * tangent không dùng. `diagnostics` (mảng, tuỳ chọn) nhận lý do từng kiểm tra bỏ qua / lỗi.
 */
async function buildCheckInsights({ projectRoot, build, evidence, settingsPath, textures, audio, diagnostics }) {
  if (!build || !settingsPath) {
    if (diagnostics) {
      diagnostics.push({ id: 'build-checks', label: 'Kiểm tra chung', insights: 0, skipped: build ? 'bản build thiếu src/settings.json' : 'chưa có bản build', error: '' });
    }
    return [];
  }
  const settingsText = await fs.readFile(settingsPath, 'utf8').catch(() => '');
  let settings = null;
  try {
    settings = JSON.parse(settingsText);
  } catch (_error) {
    settings = null;
  }
  const result = await runBuildChecks({ projectRoot, build, evidence, settings, settingsText, settingsPath, textures, audio, zippedSize });
  if (diagnostics) {
    diagnostics.push(...result.diagnostics);
  }
  return result.insights;
}

// ---------------------------------------------------------------- API

/**
 * Danh sách gợi ý, giảm được nhiều nhất trước. Mỗi gợi ý:
 * { id, group, bytes, saving, impact, basis, title, detail, action: { type, label, ... } | null }
 * `saving`: byte ước tính giảm được (sau zip, xem đầu file), 0 = không giảm được bản xuất / chưa đo được
 * (xếp cuối). `bytes`: dung lượng liên quan trong build (hoặc nguồn khi chưa có build). `impact`: nhãn
 * "≈ tiết kiệm X" (hoặc lý do khi saving 0); `basis`: một dòng nói con số đó tính từ đâu.
 * action.type: reveal (url) | open-settings (tab, subTab) | modules (keys) | texture (urls) | audio (urls)
 *   | audio-open (url) | model (urls) | open-build.
 * `builderAudio`: { packageName, enabled, bitrateKbps } từ exports.readBuilderAudio (null nếu không dùng builder).
 * `moduleConfig` (tuỳ chọn): engine 'query-modules-config' của Editor; có thì bỏ qua module mà module khác
 * đang bật cần tới (giống tab Module engine), không có (CLI) thì không biết được điều đó.
 * `textureEstimates` (tuỳ chọn): Map url -> { bytes, sourceBytes, error } nén thử của tab Ảnh (preset đang chọn).
 * `diagnostics` (tuỳ chọn, mảng): nhận { id, label, insights, skipped, error } của từng kiểm tra chung
 * (lib/build-checks.js) - cli/selftest.js in ra để biết kiểm tra nào bỏ qua vì thiếu dữ liệu gì.
 */
async function buildInsights({ projectRoot, build, textures, audio, builderAudio, buildSizeBySource, models, moduleConfig = null, textureEstimates = null, diagnostics = null }) {
  const evidence = await readProjectEvidence(projectRoot, { buildRoots: build ? [build.buildRoot] : [] });
  evidence.dependents = build ? await readDependents(projectRoot) : new Map();
  const rows = build ? build.assetRows : [];
  const settingsPath = build ? await findBuildSettings(build.buildRoot) : '';
  const settings = settingsPath ? await readJson(settingsPath) : null;
  const launchUrl = String(settings && settings.launch && settings.launch.launchScene || '').toLowerCase();
  const launchDocument = evidence.documents.find((document) => document.url.toLowerCase() === launchUrl) || null;
  const modules = await readEngineModules(projectRoot);
  const version = creatorVersion(projectRoot);
  // Chưa có bản build: chỉ xét ảnh / audio mà scene, prefab, resources/ hay bundle thật sự dùng tới (assets/ thường còn
  // file thừa, bản WAV gốc...), không thì con số tiết kiệm không liên quan gì tới thứ vào build.
  const reachable = build ? null : (evidence.reachable || await reachableSourceUrls(projectRoot, evidence).catch(() => null));
  const reachedUrl = (item) => {
    const url = String(item.url || '').split('@')[0];
    if (reachable.has(url)) {
      return true;
    }
    // Auto-atlas (.pac) không được tham chiếu trực tiếp: tính là dùng khi có ảnh nào trong thư mục của nó được dùng.
    const folder = url.slice(0, url.lastIndexOf('/') + 1);
    return /\.pac$/i.test(url) && [...reachable].some((other) => other.startsWith(folder));
  };
  const reach = (list) => (reachable && list ? list.filter(reachedUrl) : list);

  const insights = [
    skyboxInsight({ rows, launchDocument }),
    ...await builtinShaderInsights({ rows, evidence }),
    build ? await moduleInsight({ modules, moduleConfig, evidence, rows, version }) : null,
    ...textureInsights({ textures: reach(textures), buildSizeBySource: build ? buildSizeBySource : null, rows, textureEstimates, noBuildNote: reachable ? NO_BUILD_NOTE : '' }),
    ...audioInsights({ audio: reach(audio), builderAudio, buildSizeBySource: build ? buildSizeBySource : null, noBuildNote: reachable ? NO_BUILD_NOTE : '' }),
    ...await modelInsights({ models, rows }),
    ...await buildCheckInsights({ projectRoot, build, evidence, settingsPath, textures, audio, diagnostics }),
  ].filter(Boolean);
  return insights.sort((left, right) => (right.saving - left.saving) || (right.bytes - left.bytes));
}

/**
 * File trong assets/ sửa sau lần build (mtime mới hơn `sinceMs`): số liệu build đã cũ.
 * Trả về { count, samples: [đường dẫn tương đối] }.
 */
async function findAssetsChangedAfter(projectRoot, sinceMs) {
  const root = path.join(projectRoot, 'assets');
  const changed = [];
  for (const fullPath of await walk(root)) {
    const stat = await fs.stat(fullPath).catch(() => null);
    if (stat && stat.mtimeMs > sinceMs + 1000) {
      changed.push({ path: path.relative(root, fullPath).replace(/\\/g, '/'), mtimeMs: stat.mtimeMs });
    }
  }
  changed.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return { count: changed.length, samples: changed.slice(0, 3).map((item) => item.path) };
}

module.exports = {
  buildInsights,
  findAssetsChangedAfter,
  readProjectEvidence,
};
