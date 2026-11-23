'use strict';

/**
 * Module engine (Project Settings → Feature Cropping): module tuỳ chọn nào đang bật, có thấy
 * dùng trong assets/ không (bằng chứng cụ thể), và tính cấu hình mới khi bật / tắt.
 *
 * Cấu hình nằm ở settings/v2/packages/engine.json → modules.configs[globalConfigKey]
 * (thiếu globalConfigKey thì Cocos dùng 'defaultConfig', xem activeConfigKey):
 *   cache[key]._value      bật / tắt (nhóm có lựa chọn như physics, spine thì kèm _option)
 *   includeModules         danh sách module thật sự đưa vào build (builder đọc danh sách này)
 * Post Process còn một bản sao ở modules.graphics['custom-pipeline-post-process'].
 * Khối modules.cache / modules.includeModules ở ngoài là định dạng cũ: 3.8 không dùng nữa; Cocos 3.6 / 3.7 vẫn
 * dùng nó (describeModules đọc được khi biết bản Creator, nhưng tool không ghi).
 *
 * Không phụ thuộc `Editor`: main.js đọc / ghi qua Editor.Profile, phần tính toán ở đây.
 * Tab Module engine, "Việc nên làm" (lib/insights.js) và thẻ Module engine ở Tổng quan dùng chung
 * describeModules / moduleBuildShare nên các nơi luôn cùng kết luận module nào không thấy dùng, chiếm bao nhiêu.
 */

const { versionAtLeast } = require('./compat');

/**
 * Module tuỳ chọn mà tool nhận biết được. `key`: khoá trong cache (nhóm có lựa chọn thì là
 * khoá nhóm), `match`: id trong includeModules thuộc module này, bằng chứng sử dụng:
 * `types` (__type__ trong scene / prefab, và tên class trong JSON import của các bản build), `scripts`
 * (chữ trong script), `files` (đuôi file), `text` (chuỗi trong scene / prefab), `models` (model 3D có
 * skeleton / animation: prefab sinh từ FBX nằm trong library/ nên scene không chứa component của nó),
 * `settings(settings)` (src/settings.json của bản build). Chỉ liệt kê module có dấu hiệu sử dụng rõ ràng;
 * module khó xác định (graphics, gfx, pipeline...) bỏ qua. Thấy dấu hiệu ở BẤT KỲ đâu là coi như đang dùng
 * (thà bỏ sót còn hơn gợi ý tắt nhầm).
 * `codeZip`: module không có file riêng trong build thì đây là phần mã engine bỏ được, byte sau zip, đo bằng
 * cách build lại engine 3.8.8 với / không có module (ccbuild, cùng tuỳ chọn editor); bản khác lệch chút ít.
 */
const MODULE_RULES = [
  {
    key: 'custom-pipeline-post-process',
    match: (name) => name === 'custom-pipeline-post-process',
    label: 'Post Process',
    about: 'Hiệu ứng hậu kỳ của pipeline mới (Bloom, FXAA, TAA, FSR, Color Grading...). Bật là kéo theo cả loạt shader post-process vào bundle internal.',
    types: /^cc\.(PostProcess|Bloom|ColorGrading|FXAA|FSR|TAA|HBAO|BlitScreen|DOF|DepthOfField|Sharpen|ToneMapping)/,
    scripts: /\b(PostProcess|Bloom|ColorGrading|FXAA|FSR|TAA|HBAO)\b/,
    text: /"_usePostProcess"\s*:\s*true/,
    textLabel: 'Camera bật Use Post Process',
  },
  {
    key: 'marionette',
    match: (name) => name === 'marionette',
    label: 'Animation Graph (marionette)',
    about: 'Animation Controller + Animation Graph. Animation thường (cc.Animation, clip .anim) và animation của model không cần module này.',
    types: /^cc\.animation\.AnimationController$/,
    scripts: /\bAnimationController\b/,
    files: /\.(animgraph|animgraphvari|animask)$/i,
  },
  {
    key: 'physics-2d',
    match: (name) => /^physics-2d/.test(name),
    label: 'Physics 2D',
    about: 'Vật lý 2D (Box2D / builtin): RigidBody2D, Collider2D, Joint2D.',
    types: /^cc\.(RigidBody2D|\w+Collider2D|\w+Joint2D)$/,
    scripts: /\b(PhysicsSystem2D|RigidBody2D|Collider2D)\b/,
  },
  {
    key: 'physics',
    match: (name) => /^physics-(?!2d)/.test(name),
    label: 'Physics 3D',
    about: 'Vật lý 3D (cannon / ammo / physx / builtin): RigidBody, Collider, CharacterController. Bản ammo / physx kéo theo cả file wasm lớn.',
    types: /^cc\.(RigidBody|\w+Collider|CharacterController|\w+Constraint)$/,
    scripts: /\b(PhysicsSystem|RigidBody|Collider|CharacterController)\b/,
  },
  {
    key: 'spine',
    match: (name) => /^spine/.test(name),
    label: 'Spine',
    about: 'Hoạt ảnh Spine (sp.Skeleton). Kèm file wasm của runtime Spine.',
    types: /^sp\.Skeleton$/,
    scripts: /\bsp\.Skeleton\b/,
    files: /\.skel$/i,
  },
  {
    key: 'dragon-bones',
    match: (name) => name === 'dragon-bones',
    label: 'DragonBones',
    about: 'Hoạt ảnh DragonBones.',
    types: /^dragonBones\./,
    scripts: /\bdragonBones\b/,
  },
  {
    key: 'particle-2d',
    match: (name) => name === 'particle-2d',
    label: 'Particle 2D',
    about: 'Hạt 2D (cc.ParticleSystem2D).',
    types: /^cc\.ParticleSystem2D$/,
    scripts: /\bParticleSystem2D\b/,
  },
  {
    key: 'particle',
    match: (name) => name === 'particle',
    label: 'Particle 3D',
    about: 'Hạt 3D (cc.ParticleSystem).',
    types: /^cc\.ParticleSystem$/,
    scripts: /\bParticleSystem\b(?!2D)/,
  },
  {
    key: 'video',
    match: (name) => name === 'video',
    label: 'Video',
    about: 'Phát video (cc.VideoPlayer).',
    types: /^cc\.VideoPlayer$/,
    scripts: /\bVideoPlayer\b/,
  },
  {
    key: 'webview',
    match: (name) => name === 'webview',
    label: 'WebView',
    about: 'Nhúng trang web (cc.WebView).',
    types: /^cc\.WebView$/,
    scripts: /\bWebView\b/,
  },
  {
    key: 'tiled-map',
    match: (name) => name === 'tiled-map',
    label: 'Tiled Map',
    about: 'Bản đồ Tiled (cc.TiledMap).',
    types: /^cc\.TiledMap/,
    scripts: /\bTiledMap\b/,
  },
  {
    key: 'terrain',
    match: (name) => name === 'terrain',
    label: 'Terrain',
    about: 'Địa hình 3D (cc.Terrain).',
    types: /^cc\.Terrain$/,
    scripts: /\bTerrain\b/,
  },
  {
    key: 'rich-text',
    match: (name) => name === 'rich-text',
    label: 'Rich Text',
    about: 'Chữ định dạng (cc.RichText).',
    types: /^cc\.RichText$/,
    scripts: /\bRichText\b/,
  },
  {
    key: 'profiler',
    match: (name) => name === 'profiler',
    label: 'Profiler',
    about: 'Bảng thống kê FPS / draw call ở góc màn hình (Display Stats). Bản phát hành không cần; tắt thì bỏ luôn effect util/profiler trong bundle internal.',
    types: /^cc\.PerfCounter$/,
    scripts: /\b(profiler|showStats|hideStats|setDisplayStats|isDisplayStats|PerfCounter)\b/,
    settings: (settings) => (settings && settings.profiling && settings.profiling.showFPS === true ? 'settings.json bật profiling.showFPS' : ''),
    codeZip: 3600,
  },
  {
    key: 'intersection-2d',
    match: (name) => name === 'intersection-2d',
    label: 'Intersection 2D',
    about: 'Hàm kiểm tra giao nhau hình học 2D gọi từ script (Intersection2D). Physics 2D dùng bản riêng bên trong engine.',
    scripts: /\bIntersection2D\b/,
    codeZip: 800,
  },
  {
    key: 'primitive',
    match: (name) => name === 'primitive',
    label: 'Primitive',
    about: 'Tạo mesh hình khối bằng code (primitives.box(), sphere()...). Khối 3D tạo từ menu (Cube, Sphere...) dùng mesh dựng sẵn primitives.fbx, không cần module này.',
    types: /^cc\.Primitive$/,
    scripts: /\bprimitives\b|\bPrimitive\b/,
    codeZip: 3400,
  },
  {
    key: 'mask',
    match: (name) => name === 'mask',
    label: 'Mask',
    about: 'Component Mask của UI 2D (cắt hiển thị theo hình / ảnh, kể cả vùng nhìn của ScrollView / PageView).',
    types: /^cc\.Mask$/,
    // Chỉ tính Mask lấy từ 'cc' (chữ "Mask" đứng riêng hay gặp trong tên biến / class của game).
    scripts: /\bimport\s*(?:type\s*)?\{[^}]*\bMask\b[^}]*\}\s*from\s*['"]cc['"]|\bcc\.Mask\b/,
    codeZip: 1500,
  },
  {
    key: 'skeletal-animation',
    match: (name) => name === 'skeletal-animation',
    label: 'Skeletal Animation',
    about: 'Hoạt ảnh xương của model 3D (SkeletalAnimation, skinned mesh). cc.Animation với clip .anim thuộc module Animation, không cần module này.',
    types: /^cc\.(SkeletalAnimation|SkinnedMeshRenderer|SkinnedMeshBatchRenderer)$/,
    scripts: /\b(SkeletalAnimation|SkeletalAnimationState|SkinnedMeshRenderer|SkinnedMeshBatchRenderer)\b/,
    models: true,
    codeZip: 2500,
  },
];

const POST_PROCESS = 'custom-pipeline-post-process';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Khoá của cấu hình đang dùng trong modules.configs. Thiếu globalConfigKey thì Cocos dùng 'defaultConfig'
 * (builtin/engine/package.json của 3.8: profile.project.modules.default.globalConfigKey), không có thì cấu hình đầu.
 */
function activeConfigKey(modules) {
  if (!modules || !modules.configs || typeof modules.configs !== 'object') {
    return '';
  }
  if (modules.globalConfigKey && modules.configs[modules.globalConfigKey]) {
    return modules.globalConfigKey;
  }
  return modules.configs.defaultConfig ? 'defaultConfig' : (Object.keys(modules.configs)[0] || '');
}

/** Cấu hình đang dùng (configs[globalConfigKey]); null khi dự án chưa từng lưu Feature Cropping. */
function activeConfig(modules) {
  const key = activeConfigKey(modules);
  const config = key ? modules.configs[key] : null;
  return config && config.cache && Array.isArray(config.includeModules) ? config : null;
}

/**
 * Định dạng cũ của Feature Cropping (Cocos 3.6 / 3.7: modules.cache + modules.includeModules ở ngoài). Chỉ đọc:
 * tool không ghi định dạng này. null khi không có.
 */
function legacyConfig(modules) {
  return modules && modules.cache && typeof modules.cache === 'object' && Array.isArray(modules.includeModules)
    ? { cache: modules.cache, includeModules: modules.includeModules }
    : null;
}

/** Module đang đưa vào build (đọc được cả định dạng cũ). */
function includedModules(modules) {
  const config = activeConfig(modules);
  return (config && config.includeModules) || (modules && modules.includeModules) || [];
}

/**
 * Bằng chứng sử dụng của một module: { used, inScenes, notShipped, usedBy: [mô tả ngắn] }.
 * `used`: thấy dấu hiệu ở bất kỳ đâu (thà bỏ sót còn hơn gợi ý tắt nhầm module đang dùng).
 * `inScenes`: bằng chứng chắc là thứ vào build cần module: class có trong JSON import của một bản build, settings.json
 * của bản build; hoặc - khi dự án chưa có bản build nào - scene / prefab / model mà scene, resources/, bundle dùng tới.
 * `notShipped`: chỉ có scene / prefab / model trong assets/ mà không vào bản build nào (asset thừa, bản sao cũ...):
 * module đang tắt thì không phải lỗi, chỉ cần bật nếu sau này đưa asset đó vào build.
 * Chữ trong script hay đuôi file chỉ là dấu hiệu yếu (có thể là code mẫu không chạy tới).
 * `evidence` từ insights.readProjectEvidence (documents, scriptFiles, files, và nếu có: models, builds, reachable).
 */
function moduleUsage(rule, evidence) {
  const shipped = [];
  const assets = [];
  const weak = [];
  for (const document of evidence.documents || []) {
    const counts = new Map();
    for (const match of document.text.matchAll(/"__type__"\s*:\s*"([^"]+)"/g)) {
      if (rule.types && rule.types.test(match[1])) {
        counts.set(match[1], (counts.get(match[1]) || 0) + 1);
      }
    }
    for (const [type, count] of counts) {
      assets.push({ url: document.url, text: `${document.name}: ${type}${count > 1 ? ` ×${count}` : ''}` });
    }
    if (rule.text && rule.text.test(document.text)) {
      assets.push({ url: document.url, text: `${document.name}: ${rule.textLabel || 'có cấu hình dùng module này'}` });
    }
  }
  // Bản build: tên class trong JSON import (kể cả component của prefab sinh từ FBX), settings.json.
  for (const build of evidence.builds || []) {
    for (const name of build.classes || []) {
      if (rule.types && rule.types.test(name)) {
        shipped.push(`bản build ${build.name}: ${name}`);
      }
    }
    const reason = rule.settings ? rule.settings(build.settings) : '';
    if (reason) {
      shipped.push(`bản build ${build.name}: ${reason}`);
    }
  }
  if (rule.models) {
    for (const model of evidence.models || []) {
      if (model.skinned || model.animated) {
        assets.push({ url: model.url || '', text: `model ${model.name}: có ${[model.skinned ? 'skeleton' : '', model.animated ? 'animation' : ''].filter(Boolean).join(' + ')}` });
      }
    }
  }
  for (const script of evidence.scriptFiles || []) {
    const match = rule.scripts ? rule.scripts.exec(script.text) : null;
    if (match) {
      weak.push(`script ${script.name}: ${match[0]}`);
    }
  }
  if (rule.files) {
    for (const file of evidence.files || []) {
      if (rule.files.test(file)) {
        weak.push(`file ${file.split(/[\\/]/).pop()}`);
      }
    }
  }
  // Có bản build: component thật sự vào build thì class của nó có trong JSON import (cả khi module đang tắt), nên
  // scene / prefab / model mà không bản build nào chứa class đó là asset không vào build. Chưa có bản build: xét
  // asset có được scene / resources / bundle dùng tới không (không biết thì coi như có). Bản build không đọc được class
  // nào (vd bundle nén zip) thì không dùng để kết luận.
  const hasBuilds = (evidence.builds || []).some((build) => (build.classes || []).length > 0);
  const reachable = evidence.reachable instanceof Set ? evidence.reachable : null;
  const shippedAssets = hasBuilds ? [] : assets.filter((item) => !reachable || !item.url || reachable.has(item.url));
  const inScenes = shipped.length > 0 || shippedAssets.length > 0;
  const ordered = [...shipped, ...shippedAssets.map((item) => item.text), ...assets.filter((item) => !shippedAssets.includes(item)).map((item) => item.text), ...weak];
  return { used: ordered.length > 0, inScenes, notShipped: !inScenes && assets.length > 0, usedBy: ordered };
}

/** Phần mã engine (byte sau zip, ước lượng đo trên 3.8.8) bỏ được khi tắt module `key`; 0 nếu không biết. */
function moduleCodeZip(key) {
  const rule = MODULE_RULES.find((item) => item.key === key);
  return (rule && rule.codeZip) || 0;
}

/**
 * Danh sách module tuỳ chọn có trong cấu hình của dự án:
 * [{ key, label, about, enabled, ids, used, usedBy, blocked }]
 * `blocked`: lý do không đổi được (vd module khác đang bật cần nó).
 * `moduleConfig` (từ engine 'query-modules-config', có thể null): moduleDependedMap.
 * `options.version`: bản Creator (lib/compat.js creatorVersion). Bản dưới 3.8 lưu Feature Cropping theo định dạng
 * cũ: vẫn liệt kê để biết module nào không dùng (`legacy: true`), nhưng mọi mục `blocked` vì tool không ghi định
 * dạng đó (đổi trong Project Settings → Feature Cropping).
 */
function describeModules(modules, evidence, moduleConfig, options = {}) {
  let config = activeConfig(modules);
  let legacy = false;
  if (!config && options.version && !versionAtLeast(options.version, '3.8.0')) {
    config = legacyConfig(modules);
    legacy = !!config;
  }
  if (!config) {
    return { ok: false, reason: 'no-config', entries: [] };
  }
  const included = new Set(config.includeModules);
  const dependedMap = (moduleConfig && moduleConfig.moduleDependedMap) || {};
  const pipeline = config.cache['render-pipeline'] && config.cache['render-pipeline']._option;
  const entries = [];
  for (const rule of MODULE_RULES) {
    if (!config.cache[rule.key]) {
      continue;
    }
    const ids = config.includeModules.filter((name) => rule.match(name));
    const enabled = ids.length > 0;
    const usage = moduleUsage(rule, evidence);
    let blocked = '';
    if (legacy) {
      blocked = `Cocos ${options.version} lưu Feature Cropping theo định dạng cũ: tool chỉ đọc, đổi trong Project Settings → Feature Cropping`;
    } else if (enabled) {
      const dependents = ids.flatMap((id) => dependedMap[id] || []).filter((name) => included.has(name) && !rule.match(name));
      if (dependents.length) {
        blocked = `Module ${dependents.join(', ')} đang bật cần module này`;
      }
    } else if (rule.key === POST_PROCESS && pipeline && pipeline !== 'custom-pipeline') {
      blocked = 'Cần Render Pipeline = custom-pipeline (Project Settings → Feature Cropping)';
    }
    entries.push({ key: rule.key, label: rule.label, about: rule.about, enabled, ids, used: usage.used, inScenes: usage.inScenes, notShipped: usage.notShipped, usedBy: usage.usedBy, blocked, legacy });
  }
  return { ok: true, legacy, entries, pipeline: pipeline || '' };
}

/**
 * File engine riêng của một module trong bản build (wasm / chunk JS mang tên backend của nó), so với tên
 * file: biết được module đó chiếm bao nhiêu. Phần nằm trong mã engine chung (cc.js) thì không tách ra được.
 */
const MODULE_BUILD_FILES = {
  physics: /(ammo|bullet|physx|cannon)/i,
  'physics-2d': /box2d/i,
  spine: /spine/i,
  'dragon-bones': /dragon/i,
};

/**
 * Phần của module `key` trong bản build (`rows` = assetRows của build-scan), dùng chung cho tab Module engine
 * và "Việc nên làm": { parts: [{ row, share }], rows, bytes, estimated, effects, packBytes }.
 * `share`: phần của file đó thuộc module (1 với file riêng). Post Process không có file riêng: các effect
 * post-process (bloom, TAA, FSR...) nằm chung pack internal với shader khác nên chỉ ước lượng theo số asset
 * trong pack (`estimated`, `effects`, `packBytes`). `bytes` = Σ size × share. Không có file nào: bytes 0.
 */
function moduleBuildShare(key, rows) {
  const list = rows || [];
  if (key === POST_PROCESS) {
    const isPostProcess = (url) => url.includes('/post-process/');
    const parts = list
      .filter((row) => (row.builtinSources || []).some(isPostProcess))
      .map((row) => ({ row, count: row.builtinSources.filter(isPostProcess).length }))
      .map(({ row, count }) => ({ row, count, share: count / row.builtinSources.length }));
    return {
      parts: parts.map(({ row, share }) => ({ row, share })),
      rows: parts.map((part) => part.row),
      bytes: Math.round(parts.reduce((sum, part) => sum + part.row.size * part.share, 0)),
      estimated: true,
      effects: parts.reduce((sum, part) => sum + part.count, 0),
      packBytes: parts.reduce((sum, part) => sum + part.row.size, 0),
    };
  }
  const pattern = MODULE_BUILD_FILES[key];
  const matched = pattern
    ? list.filter((row) => (row.category === 'wasm' || row.category === 'engine-js') && pattern.test(row.relativePath.split('/').pop()))
    : [];
  return {
    parts: matched.map((row) => ({ row, share: 1 })),
    rows: matched,
    bytes: matched.reduce((sum, row) => sum + row.size, 0),
    estimated: false,
    effects: 0,
    packBytes: 0,
  };
}

/**
 * Cấu hình modules mới sau khi bật / tắt: changes = [{ key, enable }].
 * Trả về { ok, modules, labels } hoặc { ok: false, error }. Không đụng tới khối định dạng cũ.
 */
function planModuleChange(modules, changes, moduleConfig) {
  const next = clone(modules || {});
  const config = activeConfig(next);
  if (!config) {
    return { ok: false, error: 'Dự án chưa lưu cấu hình Feature Cropping: mở Project Settings → Feature Cropping, đổi một mục bất kỳ rồi đổi lại để Cocos tạo cấu hình, sau đó thử lại.' };
  }
  const dependMap = (moduleConfig && moduleConfig.moduleDependMap) || {};
  const wasSorted = config.includeModules.every((name, index, list) => index === 0 || list[index - 1] <= name);
  const included = config.includeModules.slice();
  const add = (name) => {
    if (included.includes(name)) {
      return;
    }
    included.push(name);
    // Module phụ thuộc (vd marionette cần animation) cũng phải bật.
    for (const dependency of dependMap[name] || []) {
      if (config.cache[dependency] && typeof config.cache[dependency]._value === 'boolean') {
        config.cache[dependency]._value = true;
      }
      add(dependency);
    }
  };
  const labels = [];
  for (const change of changes || []) {
    const rule = MODULE_RULES.find((item) => item.key === change.key);
    const entry = config.cache[change.key];
    if (!rule || !entry) {
      return { ok: false, error: `Không có module "${change.key}" trong cấu hình của dự án.` };
    }
    if (change.enable) {
      if (rule.key === POST_PROCESS) {
        const pipeline = config.cache['render-pipeline'] && config.cache['render-pipeline']._option;
        if (pipeline && pipeline !== 'custom-pipeline') {
          return { ok: false, error: 'Post Process cần Render Pipeline = custom-pipeline.' };
        }
      }
      entry._value = true;
      // Nhóm có lựa chọn (physics -> physics-cannon, spine -> spine-4.2): đưa lựa chọn đó vào build.
      add(typeof entry._option === 'string' ? entry._option : rule.key);
    } else {
      entry._value = false;
      for (let index = included.length - 1; index >= 0; index -= 1) {
        if (rule.match(included[index])) {
          included.splice(index, 1);
        }
      }
    }
    if (rule.key === POST_PROCESS && next.graphics && Object.prototype.hasOwnProperty.call(next.graphics, POST_PROCESS)) {
      next.graphics[POST_PROCESS] = !!change.enable;
    }
    labels.push(`${change.enable ? 'Bật' : 'Tắt'} ${rule.label}`);
  }
  config.includeModules = wasSorted ? included.sort() : included;
  return { ok: true, modules: next, labels };
}

module.exports = {
  MODULE_RULES,
  POST_PROCESS,
  activeConfigKey,
  activeConfig,
  legacyConfig,
  includedModules,
  moduleUsage,
  moduleCodeZip,
  describeModules,
  moduleBuildShare,
  planModuleChange,
};
