'use strict';

/**
 * Khung xem model 3D của tab Model 3D: so model trước / sau Mesh Simplify ngay trong khung chi tiết.
 *
 *   - Một canvas WebGL chia đôi (viewport + scissor, giữa là một vạch mảnh): trái là model gốc,
 *     phải là bản đã giảm tam giác; right = null thì một khung chiếm hết bề ngang. Hai bên dùng chung
 *     một camera (xoay / zoom cùng lúc) và chung khung hình tính từ bounds của bản gốc, nên so kích
 *     thước được 1:1.
 *   - Wireframe vẽ cạnh tam giác (mỗi cạnh một lần) đè lên mặt: chỗ thấy rõ số tam giác giảm ra sao.
 *   - Kéo chuột trái để xoay, chuột phải / giữa (hoặc Shift + kéo) để dời, lăn để zoom, bấm đúp để về
 *     góc nhìn mặc định.
 *   - Chỉ vẽ khi có gì đổi (camera, model, texture, cờ, kích thước), không chạy vòng lặp liên tục.
 *   - Canvas không có chữ: bên gọi tự đặt nhãn HTML (tên + số tam giác) theo getOverlayInfo() hoặc
 *     options.onRender(info).
 *
 * Không dùng thư viện ngoài, chỉ cần DOM + WebGL (WebGL2; hoặc WebGL1 kèm OES_element_index_uint,
 * thiếu nữa thì chia mesh thành các khúc dưới 65535 đỉnh). require('fs') chỉ dùng khi có (trong Editor)
 * để đọc texture từ ổ đĩa, nên file chạy được cả ngoài Editor để kiểm thử.
 */

/** Góc nhìn dọc của camera (rad). */
const FOV_Y = 35 * Math.PI / 180;
/** Chừa lề quanh model khi vừa khung (bán kính lấy theo đường chéo bounds nên vốn đã dư). */
const FIT_MARGIN = 1.02;
/** Góc nhìn mặc định: hơi chếch từ trên xuống, phía trước lệch phải (glTF: +Y lên, model nhìn về +Z). */
const DEFAULT_YAW = 0.55;
const DEFAULT_PITCH = 0.38;
/** Không cho lật qua đỉnh / đáy (rad, gần 83 độ). */
const PITCH_LIMIT = 1.45;
/** Zoom là hệ số nhân khoảng cách camera: nhỏ = gần. */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 6;
/** rad cho mỗi px kéo. */
const ROTATE_SPEED = 0.0085;
const WHEEL_SPEED = 0.0015;
/** Ánh sáng gắn theo camera (hệ toạ độ view, +Z hướng về người nhìn): chếch trên-trái. */
const LIGHT_DIR = new Float32Array(normalize3([-0.35, 0.55, 1]));
const AMBIENT = 0.3;
/** Phần điểm ảnh của model mà cạnh wireframe được phép phủ đậm (xem wireAlphaFor). */
const WIRE_COVERAGE = 0.4;
/** Cạnh mờ nhất vẫn phải thấy được. */
const MIN_WIRE_ALPHA = 0.14;
/** Cạnh texture lớn nhất đưa lên GPU (giữ RAM GPU của Editor). */
const MAX_TEXTURE_SIZE = 2048;
/**
 * Số đỉnh tối đa của một khúc dùng index 16 bit. WebGL2 luôn bật primitive restart nên index 65535
 * (0xFFFF) bị hiểu là "ngắt dải": chỉ dùng tới 65534.
 */
const UINT16_VERTEX_LIMIT = 65535;

const DEFAULT_COLORS = {
  /** Gần nền --bg của panel, tối hơn một chút. */
  background: [0.075, 0.094, 0.122, 1],
  /** Vạch chia hai khung. */
  divider: [0.22, 0.25, 0.3, 1],
  /** Màu "đất sét" khi không có texture. */
  clay: [0.74, 0.72, 0.68],
  /** Cạnh wireframe (có alpha). */
  wire: [0.03, 0.06, 0.1, 0.62],
};

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
};

/** canvas -> { loseContext, fired, onFired, requested } lúc dispose, để viewer sau trên cùng canvas khôi phục context. */
const RELEASED_CONTEXTS = new WeakMap();

const VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec2 aUv;
uniform mat4 uViewProj;
uniform mat3 uNormalMatrix;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
  vNormal = uNormalMatrix * aNormal;
  vUv = aUv;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec3 vNormal;
varying vec2 vUv;
uniform sampler2D uTexture;
uniform float uUseTexture;
uniform float uWire;
uniform float uAmbient;
uniform vec3 uClay;
uniform vec3 uLightDir;
uniform vec4 uWireColor;
void main() {
  if (uWire > 0.5) {
    gl_FragColor = uWireColor;
    return;
  }
  float len = length(vNormal);
  vec3 normal = len > 0.00001 ? vNormal / len : vec3(0.0, 0.0, 1.0);
  // Mặt sau (mesh hở, nhìn từ trong) lật pháp tuyến để vẫn được chiếu sáng.
  if (!gl_FrontFacing) {
    normal = -normal;
  }
  float diffuse = max(dot(normal, uLightDir), 0.0);
  vec3 base = mix(uClay, texture2D(uTexture, vUv).rgb, uUseTexture);
  gl_FragColor = vec4(base * (uAmbient + (1.0 - uAmbient) * diffuse), 1.0);
}
`;

// ---------------------------------------------------------------- toán vec3 / mat4 (cột trước, như WebGL)

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function length3(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize3(v) {
  const len = length3(v) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

/** Ma trận view nhìn từ eye về target; kèm trục right / up của camera (để dời khung). */
function lookAt(eye, target, up) {
  const z = normalize3([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = normalize3(cross3(up, z));
  const y = cross3(z, x);
  const out = new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1,
  ]);
  return { matrix: out, right: x, up: y };
}

function multiply4(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += a[k * 4 + row] * b[column * 4 + k];
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** Phần xoay 3x3 của ma trận view (view là phép biến đổi cứng nên dùng thẳng cho pháp tuyến). */
function rotationOf(matrix) {
  return new Float32Array([matrix[0], matrix[1], matrix[2], matrix[4], matrix[5], matrix[6], matrix[8], matrix[9], matrix[10]]);
}

// ---------------------------------------------------------------- hình học

function toFloat32(values) {
  return values instanceof Float32Array ? values : Float32Array.from(values);
}

function isValidBounds(bounds) {
  const ok = (values) => values && values.length >= 3 && [0, 1, 2].every((axis) => Number.isFinite(Number(values[axis])));
  return !!(bounds && ok(bounds.min) && ok(bounds.max));
}

/** Bounds từ toạ độ đỉnh của các primitive (khi bên gọi không đưa sẵn). null nếu không có đỉnh nào. */
function computeBounds(primitives) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const primitive of primitives || []) {
    const positions = primitive && primitive.positions;
    if (!positions) {
      continue;
    }
    for (let i = 0; i + 2 < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = positions[i + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
  }
  return Number.isFinite(min[0]) && Number.isFinite(max[0]) ? { min, max } : null;
}

/** Khung hình từ bounds: tâm + bán kính mặt cầu bao. */
function computeFraming(bounds) {
  if (!isValidBounds(bounds)) {
    return { center: [0, 0, 0], radius: 1 };
  }
  const min = [0, 1, 2].map((axis) => Number(bounds.min[axis]));
  const max = [0, 1, 2].map((axis) => Number(bounds.max[axis]));
  const center = [0, 1, 2].map((axis) => (min[axis] + max[axis]) / 2);
  const radius = length3([max[0] - min[0], max[1] - min[1], max[2] - min[2]]) / 2;
  return { center, radius: radius > 1e-9 ? radius : 1 };
}

/** Hai khung hình gần như trùng (lệch dưới 1% bán kính): đổi model thì giữ nguyên góc nhìn. */
function sameFraming(left, right) {
  const scale = Math.max(left.radius, right.radius);
  const offset = length3([left.center[0] - right.center[0], left.center[1] - right.center[1], left.center[2] - right.center[2]]);
  return Math.abs(left.radius - right.radius) <= scale * 0.01 && offset <= scale * 0.01;
}

/** Pháp tuyến mượt (cộng pháp tuyến mặt theo diện tích) khi model không có sẵn. */
function computeNormals(positions, indices, vertexCount) {
  const normals = new Float32Array(vertexCount * 3);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const ia = indices[i];
    const ib = indices[i + 1];
    const ic = indices[i + 2];
    if (ia >= vertexCount || ib >= vertexCount || ic >= vertexCount) {
      continue;
    }
    const a = ia * 3;
    const b = ib * 3;
    const c = ic * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const v of [a, b, c]) {
      normals[v] += nx;
      normals[v + 1] += ny;
      normals[v + 2] += nz;
    }
  }
  for (let v = 0; v < normals.length; v += 3) {
    const len = Math.hypot(normals[v], normals[v + 1], normals[v + 2]);
    if (len > 0) {
      normals[v] /= len;
      normals[v + 1] /= len;
      normals[v + 2] /= len;
    }
  }
  return normals;
}

/** Primitive bên gọi đưa -> dạng chuẩn { positions, normals, uvs, indices, vertexCount, triangles }; null nếu rỗng. */
function normalizePrimitive(raw) {
  if (!raw || !raw.positions || raw.positions.length < 9) {
    return null;
  }
  const positions = toFloat32(raw.positions);
  const vertexCount = Math.floor(positions.length / 3);
  // Có indices mà rỗng (meshopt giảm hết tam giác ở tỉ lệ nhỏ) là 0 tam giác, không phải mesh không index:
  // coi như không index thì lại vẽ đỉnh nối nhau thành tam giác rác.
  let indices = raw.indices && typeof raw.indices.length === 'number' ? raw.indices : null;
  if (!indices) {
    indices = new Uint32Array(vertexCount - (vertexCount % 3));
    for (let i = 0; i < indices.length; i += 1) {
      indices[i] = i;
    }
  }
  const triangles = Math.floor(indices.length / 3);
  if (!triangles) {
    return null;
  }
  const normals = raw.normals && raw.normals.length >= vertexCount * 3 ? toFloat32(raw.normals) : computeNormals(positions, indices, vertexCount);
  const uvs = raw.uvs && raw.uvs.length >= vertexCount * 2 ? toFloat32(raw.uvs) : null;
  return { positions, normals, uvs, indices, vertexCount, triangles };
}

/** Index sang kiểu nhỏ nhất vẽ được: Uint16 khi đủ chỗ, không thì Uint32 (bỏ phần lẻ không đủ tam giác). */
function compactIndices(indices, vertexCount) {
  const count = Math.floor(indices.length / 3) * 3;
  if (vertexCount <= UINT16_VERTEX_LIMIT) {
    return indices instanceof Uint16Array && indices.length === count ? indices : Uint16Array.from(indices.subarray ? indices.subarray(0, count) : indices.slice(0, count));
  }
  if (indices instanceof Uint32Array) {
    return indices.length === count ? indices : indices.subarray(0, count);
  }
  return Uint32Array.from(indices.slice(0, count));
}

/**
 * Chia primitive thành các khúc vẽ được: [{ positions, normals, uvs, indices, vertexCount }].
 * maxVertices = Infinity (có index 32 bit) thì giữ một khúc, không chép dữ liệu đỉnh. Khi thiếu index
 * 32 bit mà primitive quá 65534 đỉnh thì gom tam giác lần lượt vào từng khúc, đánh số đỉnh lại.
 */
function splitPrimitive(primitive, maxVertices) {
  const { positions, normals, uvs, indices, vertexCount } = primitive;
  if (vertexCount <= maxVertices) {
    return [{ positions, normals, uvs, indices: compactIndices(indices, vertexCount), vertexCount }];
  }
  const chunks = [];
  const local = new Int32Array(vertexCount).fill(-1);
  let used = [];
  let chunkIndices = [];
  const flush = () => {
    if (!chunkIndices.length) {
      return;
    }
    const count = used.length;
    const chunkPositions = new Float32Array(count * 3);
    const chunkNormals = normals ? new Float32Array(count * 3) : null;
    const chunkUvs = uvs ? new Float32Array(count * 2) : null;
    for (let i = 0; i < count; i += 1) {
      const vertex = used[i];
      for (let axis = 0; axis < 3; axis += 1) {
        chunkPositions[i * 3 + axis] = positions[vertex * 3 + axis];
        if (chunkNormals) {
          chunkNormals[i * 3 + axis] = normals[vertex * 3 + axis];
        }
      }
      if (chunkUvs) {
        chunkUvs[i * 2] = uvs[vertex * 2];
        chunkUvs[i * 2 + 1] = uvs[vertex * 2 + 1];
      }
      local[vertex] = -1;
    }
    chunks.push({ positions: chunkPositions, normals: chunkNormals, uvs: chunkUvs, indices: Uint16Array.from(chunkIndices), vertexCount: count });
    used = [];
    chunkIndices = [];
  };
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const corners = [indices[i], indices[i + 1], indices[i + 2]];
    if (corners.some((vertex) => vertex >= vertexCount)) {
      continue;
    }
    const fresh = corners.filter((vertex) => local[vertex] < 0).length;
    if (used.length + fresh > maxVertices) {
      flush();
    }
    for (const vertex of corners) {
      if (local[vertex] < 0) {
        local[vertex] = used.length;
        used.push(vertex);
      }
      chunkIndices.push(local[vertex]);
    }
  }
  flush();
  return chunks;
}

/**
 * Cạnh của các tam giác cho gl.LINES: [a0, b0, a1, b1, ...], mỗi cạnh một lần (hai tam giác kề nhau chỉ
 * vẽ cạnh chung một lần). Đỉnh bị tách ở đường nối UV thì vẫn ra hai cạnh, vẽ chồng đúng một chỗ nên
 * nhìn không khác.
 */
function buildEdges(indices, vertexCount) {
  const seen = new Set();
  const out = vertexCount > UINT16_VERTEX_LIMIT ? new Uint32Array(indices.length * 2) : new Uint16Array(indices.length * 2);
  let count = 0;
  const add = (a, b) => {
    if (a === b) {
      return;
    }
    const key = a < b ? a * vertexCount + b : b * vertexCount + a;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out[count] = a;
    out[count + 1] = b;
    count += 2;
  };
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    add(a, b);
    add(b, c);
    add(c, a);
  }
  return out.slice(0, count);
}

/** Chia bề ngang (px thiết bị) cho 1 hoặc 2 khung, giữa là vạch `divider` px. */
function layoutViews(width, count, divider) {
  if (count < 2) {
    return [{ x: 0, width }];
  }
  const leftWidth = Math.max(0, Math.floor((width - divider) / 2));
  return [{ x: 0, width: leftWidth }, { x: leftWidth + divider, width: Math.max(0, width - leftWidth - divider) }];
}

// ---------------------------------------------------------------- texture

function nodeRequire(name) {
  try {
    return typeof require === 'function' ? require(name) : null;
  } catch (_error) {
    return null;
  }
}

/** Đường dẫn ổ đĩa -> URL file:///D:/... (mã hoá khoảng trắng, #, ?...). */
function toFileUrl(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/');
  const prefix = /^[A-Za-z]:\//.test(normalized) ? 'file:///' : normalized.startsWith('//') ? 'file:' : 'file://';
  return prefix + encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function imageTypeOf(filePath) {
  const match = /\.[^./\\]+$/.exec(String(filePath));
  return (match && IMAGE_TYPES[match[0].toLowerCase()]) || 'application/octet-stream';
}

/**
 * Ảnh nguồn -> URL nạp được vào <img> mà không "bẩn" canvas: { url, revoke }.
 * Trong Editor (có fs) đọc file rồi tạo blob: blob cùng origin với panel nên WebGL nạp được, không
 * vướng giới hạn origin của file://. Ngoài Editor thì đường dẫn Windows thành file:///D:/..., còn URL
 * (data:, blob:, http:, đường dẫn tương đối) giữ nguyên.
 */
async function resolveImageUrl(input) {
  const text = String(input);
  if (/^(data|blob|https?):/i.test(text)) {
    return { url: text, revoke: false };
  }
  const fs = nodeRequire('fs');
  if (!fs || !fs.promises || typeof Blob !== 'function') {
    const absolute = /^[A-Za-z]:[\\/]/.test(text) || /^\\\\/.test(text);
    return { url: absolute ? toFileUrl(text) : text, revoke: false };
  }
  let filePath = text;
  if (/^file:/i.test(text)) {
    const url = nodeRequire('url');
    filePath = url && url.fileURLToPath ? url.fileURLToPath(text) : decodeURI(text.replace(/^file:\/\/\/?/i, ''));
  }
  const bytes = await fs.promises.readFile(filePath);
  const blob = new Blob([bytes], { type: imageTypeOf(filePath) });
  return { url: URL.createObjectURL(blob), revoke: true };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Không đọc được ảnh: ${url.length > 120 ? `${url.slice(0, 120)}...` : url}`));
    image.src = url;
  });
}

function ceilPowerOfTwo(value) {
  return 2 ** Math.ceil(Math.log2(Math.max(1, value)));
}

function isPowerOfTwo(value) {
  return value > 0 && (value & (value - 1)) === 0;
}

/**
 * Ảnh -> nguồn đưa vào texImage2D: thu nhỏ khi quá lớn; WebGL1 cần cạnh luỹ thừa 2 để lặp UV và có
 * mipmap nên vẽ lại sang canvas cỡ luỹ thừa 2.
 */
function textureSourceFor(image, webgl2, maxSize) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const limit = Math.min(MAX_TEXTURE_SIZE, maxSize || MAX_TEXTURE_SIZE);
  const scale = Math.min(1, limit / Math.max(width, height));
  let targetWidth = Math.max(1, Math.round(width * scale));
  let targetHeight = Math.max(1, Math.round(height * scale));
  if (!webgl2 && (!isPowerOfTwo(targetWidth) || !isPowerOfTwo(targetHeight))) {
    targetWidth = Math.min(limit, ceilPowerOfTwo(targetWidth));
    targetHeight = Math.min(limit, ceilPowerOfTwo(targetHeight));
  }
  if (targetWidth === width && targetHeight === height) {
    return image;
  }
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  canvas.getContext('2d').drawImage(image, 0, 0, targetWidth, targetHeight);
  return canvas;
}

// ---------------------------------------------------------------- viewer

function colorOption(value, fallback) {
  return Array.isArray(value) && value.length >= fallback.length && value.every(Number.isFinite) ? value.slice(0, fallback.length) : fallback;
}

function defaultCamera() {
  return { yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH, zoom: 1, pan: [0, 0, 0] };
}

/**
 * Tạo trình xem trên `canvas`. options:
 *   onError(message)          WebGL không dùng được (canvas để trống).
 *   onRender(info, { layoutChanged })  sau mỗi lần vẽ; info như getOverlayInfo().
 *   onTextureError(message)   texture không nạp được (đã quay về màu đất sét).
 *   autoResize                true: tự theo dõi cỡ canvas (canvas phải có cỡ CSS cố định).
 *   releaseContext            false: dispose không giải phóng WebGL context (mặc định có giải phóng).
 *   webgl1                    true: ép dùng WebGL1 (để kiểm thử).
 *   background, divider, clay, wire   màu [r, g, b(, a)] 0..1.
 */
function createMeshViewer(canvas, options = {}) {
  const colors = {
    background: colorOption(options.background, DEFAULT_COLORS.background),
    divider: colorOption(options.divider, DEFAULT_COLORS.divider),
    clay: new Float32Array(colorOption(options.clay, DEFAULT_COLORS.clay)),
    wire: new Float32Array(colorOption(options.wire, DEFAULT_COLORS.wire)),
  };
  const view = {
    gl: null,
    webgl2: false,
    /** Số đỉnh tối đa một khúc: Infinity khi có index 32 bit. */
    maxVertices: Infinity,
    maxTextureSize: MAX_TEXTURE_SIZE,
    program: null,
    uniforms: null,
    whiteTexture: null,
    lost: false,
    disposed: false,
    frame: 0,
    width: 0,
    height: 0,
    dpr: 1,
    /** Model bên gọi đưa [left, right] (giữ để nạp lại khi mất context). */
    models: [null, null],
    /** Bản đã lên GPU tương ứng: { source, label, triangles, chunks }. */
    meshes: [null, null],
    framing: { center: [0, 0, 0], radius: 1 },
    camera: defaultCamera(),
    wireframe: false,
    texture: { input: null, image: null, handle: null, token: 0 },
    drag: null,
    /** Camera của lần vẽ gần nhất (để dời khung theo đúng trục đang nhìn). */
    lastMatrices: null,
    lastOverlayKey: '',
    resizeObserver: null,
    /** Context viewer trước trên canvas này đã giải phóng, đang chờ khôi phục (xem RELEASED_CONTEXTS). */
    pendingRelease: null,
  };

  const reportError = (message) => {
    if (typeof options.onError === 'function') {
      try {
        options.onError(message);
      } catch (_error) {
        // Lỗi của bên gọi không được làm hỏng viewer.
      }
    }
  };

  const dividerPx = () => Math.max(1, Math.round(view.dpr));

  // --- GPU ---

  const compileShader = (gl, type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(log || 'shader lỗi');
    }
    return shader;
  };

  /** Shader, texture trắng 1x1, kiểm tra index 32 bit. Gọi lúc tạo và sau khi khôi phục context. */
  const createResources = () => {
    const gl = view.gl;
    view.maxVertices = view.webgl2 || gl.getExtension('OES_element_index_uint') ? Infinity : UINT16_VERTEX_LIMIT;
    view.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || MAX_TEXTURE_SIZE;
    try {
      const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
      const program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.bindAttribLocation(program, 0, 'aPosition');
      gl.bindAttribLocation(program, 1, 'aNormal');
      gl.bindAttribLocation(program, 2, 'aUv');
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
        throw new Error(gl.getProgramInfoLog(program) || 'link lỗi');
      }
      view.program = program;
    } catch (error) {
      reportError(`Không dựng được shader xem model: ${error.message}`);
      return false;
    }
    const uniform = (name) => gl.getUniformLocation(view.program, name);
    view.uniforms = {
      viewProj: uniform('uViewProj'),
      normalMatrix: uniform('uNormalMatrix'),
      texture: uniform('uTexture'),
      useTexture: uniform('uUseTexture'),
      wire: uniform('uWire'),
      ambient: uniform('uAmbient'),
      clay: uniform('uClay'),
      lightDir: uniform('uLightDir'),
      wireColor: uniform('uWireColor'),
    };
    view.whiteTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, view.whiteTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return true;
  };

  const createBuffer = (target, data) => {
    const gl = view.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(target, buffer);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return buffer;
  };

  /** Đưa một model lên GPU. Cạnh wireframe dựng sau, lần đầu bật wireframe. */
  const uploadModel = (model) => {
    const gl = view.gl;
    const chunks = [];
    let triangles = 0;
    for (const raw of model.primitives || []) {
      const primitive = normalizePrimitive(raw);
      if (!primitive) {
        continue;
      }
      triangles += primitive.triangles;
      for (const part of splitPrimitive(primitive, view.maxVertices)) {
        chunks.push({
          position: createBuffer(gl.ARRAY_BUFFER, part.positions),
          normal: createBuffer(gl.ARRAY_BUFFER, part.normals),
          uv: part.uvs ? createBuffer(gl.ARRAY_BUFFER, part.uvs) : null,
          index: createBuffer(gl.ELEMENT_ARRAY_BUFFER, part.indices),
          indexType: part.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
          indexCount: part.indices.length,
          vertexCount: part.vertexCount,
          cpuIndices: part.indices,
          edges: null,
          edgeType: 0,
          edgeCount: 0,
        });
      }
    }
    return {
      source: model,
      label: model.label == null ? '' : String(model.label),
      triangles: Number.isFinite(model.triangles) ? model.triangles : triangles,
      chunks,
    };
  };

  const ensureEdges = (chunk) => {
    if (chunk.edges || !chunk.cpuIndices) {
      return;
    }
    const gl = view.gl;
    const edges = buildEdges(chunk.cpuIndices, chunk.vertexCount);
    chunk.edges = createBuffer(gl.ELEMENT_ARRAY_BUFFER, edges);
    chunk.edgeType = edges instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    chunk.edgeCount = edges.length;
    chunk.cpuIndices = null;
  };

  const freeMesh = (mesh) => {
    const gl = view.gl;
    if (!mesh || !gl || view.lost) {
      return;
    }
    for (const chunk of mesh.chunks) {
      for (const buffer of [chunk.position, chunk.normal, chunk.uv, chunk.index, chunk.edges]) {
        if (buffer) {
          gl.deleteBuffer(buffer);
        }
      }
    }
  };

  const uploadTexture = (image) => {
    const gl = view.gl;
    if (!gl || view.lost) {
      return;
    }
    const source = textureSourceFor(image, view.webgl2, view.maxTextureSize);
    const created = !view.texture.handle;
    const handle = view.texture.handle || gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, handle);
    // glTF đặt gốc UV ở góc trên-trái ảnh, trùng cách WebGL đọc ảnh khi không lật.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch (error) {
      if (created) {
        gl.deleteTexture(handle);
      }
      throw error;
    }
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    view.texture.handle = handle;
  };

  const dropTexture = () => {
    if (view.texture.handle && view.gl && !view.lost) {
      view.gl.deleteTexture(view.texture.handle);
    }
    view.texture.handle = null;
    view.texture.image = null;
  };

  // --- vẽ ---

  /** Camera dùng chung cho hai khung (tính theo tỉ lệ khung trái, hai khung lệch nhau tối đa 1 px). */
  const cameraMatrices = (aspect) => {
    const { center, radius } = view.framing;
    const camera = view.camera;
    // Khung hẹp (chia đôi) thì vừa theo bề ngang thay vì bề dọc.
    const fitFov = Math.min(FOV_Y, 2 * Math.atan(Math.tan(FOV_Y / 2) * aspect));
    const distance = (radius / Math.sin(fitFov / 2)) * FIT_MARGIN * camera.zoom;
    const target = [center[0] + camera.pan[0], center[1] + camera.pan[1], center[2] + camera.pan[2]];
    const cosPitch = Math.cos(camera.pitch);
    const eye = [
      target[0] + distance * cosPitch * Math.sin(camera.yaw),
      target[1] + distance * Math.sin(camera.pitch),
      target[2] + distance * cosPitch * Math.cos(camera.yaw),
    ];
    const panLength = length3(camera.pan);
    const near = Math.max(radius * 0.002, (distance - panLength - radius) * 0.9);
    const far = (distance + panLength + radius) * 1.1;
    const look = lookAt(eye, target, [0, 1, 0]);
    return {
      viewProj: multiply4(perspective(FOV_Y, aspect, near, far), look.matrix),
      normal: rotationOf(look.matrix),
      right: look.right,
      up: look.up,
      distance,
    };
  };

  const bindAttribute = (location, buffer, size) => {
    const gl = view.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
  };

  /**
   * Độ đậm của cạnh wireframe theo mật độ cạnh trên màn hình: model 60k tam giác trong khung nhỏ mà vẽ
   * cạnh đậm thì thành một khối đen, không thấy hình. Ước lượng phần điểm ảnh bị cạnh phủ (cạnh dày
   * 1 px thiết bị, nửa số tam giác quay ra trước) rồi hạ alpha cho phần phủ đó còn khoảng 40%. Zoom gần
   * thì model chiếm nhiều điểm ảnh hơn nên cạnh đậm lại.
   */
  const wireAlphaFor = (mesh, matrices, viewHeight) => {
    const projectedRadius = (view.framing.radius / (matrices.distance * Math.tan(FOV_Y / 2))) * (viewHeight / 2);
    const area = Math.max(1, Math.PI * projectedRadius * projectedRadius * 0.5);
    const coverage = 1.5 * Math.sqrt(Math.max(1, mesh.triangles) / area);
    return clamp(WIRE_COVERAGE / coverage, MIN_WIRE_ALPHA, colors.wire[3]);
  };

  const drawMesh = (mesh, matrices) => {
    const gl = view.gl;
    const u = view.uniforms;
    gl.useProgram(view.program);
    gl.uniformMatrix4fv(u.viewProj, false, matrices.viewProj);
    gl.uniformMatrix3fv(u.normalMatrix, false, matrices.normal);
    gl.uniform3fv(u.lightDir, LIGHT_DIR);
    gl.uniform3fv(u.clay, colors.clay);
    gl.uniform4f(u.wireColor, colors.wire[0], colors.wire[1], colors.wire[2], wireAlphaFor(mesh, matrices, view.height));
    gl.uniform1f(u.ambient, AMBIENT);
    gl.uniform1f(u.wire, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, view.texture.handle || view.whiteTexture);
    gl.uniform1i(u.texture, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    // Không cull: mesh hở vẫn thấy mặt trong (shader lật pháp tuyến cho mặt sau).
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    if (view.wireframe) {
      // Đẩy mặt lùi một chút để cạnh vẽ sau nằm trên, không bị z-fighting.
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
    }
    for (const chunk of mesh.chunks) {
      bindAttribute(0, chunk.position, 3);
      bindAttribute(1, chunk.normal, 3);
      if (chunk.uv) {
        bindAttribute(2, chunk.uv, 2);
      } else {
        gl.disableVertexAttribArray(2);
        gl.vertexAttrib2f(2, 0, 0);
      }
      gl.uniform1f(u.useTexture, chunk.uv && view.texture.handle ? 1 : 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, chunk.index);
      gl.drawElements(gl.TRIANGLES, chunk.indexCount, chunk.indexType, 0);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    if (!view.wireframe) {
      return;
    }
    gl.uniform1f(u.wire, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    // Pass cạnh chỉ cần vị trí; tắt hai attribute kia để WebGL không soát cỡ buffer của khúc khác.
    gl.disableVertexAttribArray(1);
    gl.vertexAttrib3f(1, 0, 0, 1);
    gl.disableVertexAttribArray(2);
    gl.vertexAttrib2f(2, 0, 0);
    for (const chunk of mesh.chunks) {
      ensureEdges(chunk);
      if (!chunk.edgeCount) {
        continue;
      }
      bindAttribute(0, chunk.position, 3);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, chunk.edges);
      gl.drawElements(gl.LINES, chunk.edgeCount, chunk.edgeType, 0);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.uniform1f(u.wire, 0);
  };

  const visibleMeshes = () => view.meshes.filter(Boolean);

  /** Vị trí nhãn của từng khung (px CSS, tính từ mép trái canvas). */
  const getOverlayInfo = () => {
    const meshes = visibleMeshes();
    const dpr = view.dpr || 1;
    const width = view.width || Math.round((canvas.clientWidth || 0) * dpr);
    const layout = layoutViews(width, meshes.length, dividerPx());
    return meshes.map((mesh, index) => ({
      label: mesh.label,
      triangles: mesh.triangles,
      x: layout[index].x / dpr,
      width: layout[index].width / dpr,
    }));
  };

  const notifyRender = () => {
    if (typeof options.onRender !== 'function') {
      return;
    }
    const info = getOverlayInfo();
    const key = JSON.stringify(info);
    const layoutChanged = key !== view.lastOverlayKey;
    view.lastOverlayKey = key;
    try {
      options.onRender(info, { layoutChanged });
    } catch (_error) {
      // Lỗi của bên gọi không được làm hỏng viewer.
    }
  };

  const render = () => {
    view.frame = 0;
    const gl = view.gl;
    if (!gl || !view.program || view.lost || view.disposed || !view.width || !view.height) {
      return;
    }
    const meshes = visibleMeshes();
    const layout = layoutViews(view.width, meshes.length, dividerPx());
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, view.width, view.height);
    const clearColor = meshes.length > 1 ? colors.divider : colors.background;
    gl.clearColor(clearColor[0], clearColor[1], clearColor[2], 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (meshes.length && layout[0].width > 0) {
      const matrices = cameraMatrices(layout[0].width / view.height);
      view.lastMatrices = matrices;
      gl.enable(gl.SCISSOR_TEST);
      meshes.forEach((mesh, index) => {
        const rect = layout[index];
        if (rect.width <= 0) {
          return;
        }
        gl.scissor(rect.x, 0, rect.width, view.height);
        gl.viewport(rect.x, 0, rect.width, view.height);
        gl.clearColor(colors.background[0], colors.background[1], colors.background[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        drawMesh(mesh, matrices);
      });
      gl.disable(gl.SCISSOR_TEST);
    }
    notifyRender();
  };

  /** Hẹn vẽ ở khung hình kế tiếp (gộp nhiều thay đổi thành một lần vẽ). */
  const requestRender = () => {
    if (view.frame || view.disposed) {
      return;
    }
    view.frame = window.requestAnimationFrame(render);
  };

  // --- API ---

  const resize = () => {
    if (view.disposed) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(0, Math.round((canvas.clientWidth || 0) * dpr));
    const height = Math.max(0, Math.round((canvas.clientHeight || 0) * dpr));
    view.dpr = dpr;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    view.width = width;
    view.height = height;
    requestRender();
  };

  const resetView = () => {
    view.camera = defaultCamera();
    requestRender();
  };

  /**
   * left / right: null hoặc { label, primitives, bounds, triangles }. Model trùng object với lần trước
   * thì không đưa lại lên GPU (kéo thanh tỉ lệ chỉ thay bên phải). settings.keepCamera: true giữ góc
   * nhìn, false về mặc định; bỏ trống thì chỉ về mặc định khi khung hình đổi (chọn model khác).
   */
  const setModels = (left, right, settings = {}) => {
    if (view.disposed) {
      return;
    }
    const next = [left || null, right || null];
    const previous = view.meshes;
    const hadModels = previous.some(Boolean);
    if (view.gl && view.program && !view.lost) {
      const reuse = (model) => previous.find((mesh) => mesh && mesh.source === model) || null;
      const meshes = next.map((model) => (model ? reuse(model) || uploadModel(model) : null));
      for (const mesh of previous) {
        if (mesh && !meshes.includes(mesh)) {
          freeMesh(mesh);
        }
      }
      view.meshes = meshes;
    }
    view.models = next;
    const bounds = [next[0], next[1]].map((model) => model && model.bounds).find(isValidBounds)
      || computeBounds(next[0] ? next[0].primitives : next[1] ? next[1].primitives : []);
    const framing = computeFraming(bounds);
    const keep = settings.keepCamera === true || (settings.keepCamera !== false && hadModels && sameFraming(framing, view.framing));
    view.framing = framing;
    if (!keep) {
      view.camera = defaultCamera();
    }
    requestRender();
  };

  /**
   * Texture dùng chung cho cả hai khung (map theo UV). urlOrNull: đường dẫn ổ đĩa, file:// hoặc URL
   * png / jpg. Trả Promise<boolean>: true khi đã nạp xong; lỗi hoặc null thì về màu đất sét.
   */
  const setTexture = async (urlOrNull) => {
    if (view.disposed) {
      return false;
    }
    const input = urlOrNull || null;
    if (input && input === view.texture.input && view.texture.handle) {
      return true;
    }
    view.texture.token += 1;
    const token = view.texture.token;
    view.texture.input = input;
    // Bỏ ngay texture cũ: nó thuộc model trước, để lại sẽ bọc sai lên model mới.
    dropTexture();
    requestRender();
    if (!input) {
      return false;
    }
    let source = null;
    try {
      source = await resolveImageUrl(input);
      const image = await loadImage(source.url);
      if (token !== view.texture.token || view.disposed) {
        return false;
      }
      view.texture.image = image;
      uploadTexture(image);
      requestRender();
      return true;
    } catch (error) {
      if (token === view.texture.token && !view.disposed) {
        dropTexture();
        requestRender();
        if (typeof options.onTextureError === 'function') {
          try {
            options.onTextureError(`Không nạp được texture: ${error.message}`);
          } catch (_error) {
            // Lỗi của bên gọi không được làm hỏng viewer.
          }
        }
      }
      return false;
    } finally {
      if (source && source.revoke) {
        URL.revokeObjectURL(source.url);
      }
    }
  };

  const setWireframe = (enabled) => {
    if (view.wireframe === !!enabled) {
      return;
    }
    view.wireframe = !!enabled;
    requestRender();
  };

  // --- chuột ---

  /** Dời khung theo trục right / up của camera, sao cho model đi theo con trỏ. */
  const panBy = (dx, dy) => {
    const matrices = view.lastMatrices;
    const cssHeight = view.height / (view.dpr || 1);
    if (!matrices || !cssHeight) {
      return;
    }
    const perPixel = (2 * matrices.distance * Math.tan(FOV_Y / 2)) / cssHeight;
    const pan = view.camera.pan;
    for (let axis = 0; axis < 3; axis += 1) {
      pan[axis] += (-matrices.right[axis] * dx + matrices.up[axis] * dy) * perPixel;
    }
    // Không cho dời quá xa khỏi model.
    const limit = view.framing.radius * 4;
    const len = length3(pan);
    if (len > limit) {
      for (let axis = 0; axis < 3; axis += 1) {
        pan[axis] *= limit / len;
      }
    }
  };

  const onPointerDown = (event) => {
    const pan = event.button === 1 || event.button === 2 || (event.button === 0 && event.shiftKey);
    if ((event.button !== 0 && !pan) || !visibleMeshes().length) {
      return;
    }
    event.preventDefault();
    view.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, pan };
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch (_error) {
      // Một số con trỏ (đã nhả) không capture được: vẫn kéo được khi chuột còn trên canvas.
    }
    canvas.style.cursor = pan ? 'move' : 'grabbing';
  };

  const onPointerMove = (event) => {
    const drag = view.drag;
    if (!drag || event.pointerId !== drag.id) {
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!dx && !dy) {
      return;
    }
    if (drag.pan) {
      panBy(dx, dy);
    } else {
      view.camera.yaw -= dx * ROTATE_SPEED;
      view.camera.pitch = clamp(view.camera.pitch + dy * ROTATE_SPEED, -PITCH_LIMIT, PITCH_LIMIT);
    }
    requestRender();
  };

  const onPointerUp = (event) => {
    if (!view.drag || event.pointerId !== view.drag.id) {
      return;
    }
    view.drag = null;
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch (_error) {
      // Đã nhả sẵn.
    }
    canvas.style.cursor = 'grab';
  };

  const onWheel = (event) => {
    if (!visibleMeshes().length) {
      return;
    }
    event.preventDefault();
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
    view.camera.zoom = clamp(view.camera.zoom * Math.exp(delta * WHEEL_SPEED), MIN_ZOOM, MAX_ZOOM);
    requestRender();
  };

  const onDoubleClick = (event) => {
    event.preventDefault();
    resetView();
  };

  const onContextMenu = (event) => event.preventDefault();

  const onContextLost = (event) => {
    event.preventDefault();
    view.lost = true;
    if (view.frame) {
      window.cancelAnimationFrame(view.frame);
      view.frame = 0;
    }
    // Tài nguyên GPU cũ mất theo context: chỉ bỏ tham chiếu.
    view.meshes = [null, null];
    view.texture.handle = null;
    view.program = null;
    view.whiteTexture = null;
  };

  const onContextRestored = () => {
    if (view.disposed) {
      return;
    }
    view.lost = false;
    view.pendingRelease = null;
    if (!createResources()) {
      return;
    }
    view.meshes = view.models.map((model) => (model ? uploadModel(model) : null));
    if (view.texture.image) {
      try {
        uploadTexture(view.texture.image);
      } catch (_error) {
        view.texture.handle = null;
      }
    }
    requestRender();
  };

  const listeners = [
    ['pointerdown', onPointerDown],
    ['pointermove', onPointerMove],
    ['pointerup', onPointerUp],
    ['pointercancel', onPointerUp],
    ['wheel', onWheel, { passive: false }],
    ['dblclick', onDoubleClick],
    ['contextmenu', onContextMenu],
    ['webglcontextlost', onContextLost],
    ['webglcontextrestored', onContextRestored],
  ];

  /**
   * Giải phóng buffer / texture / shader, gỡ sự kiện, huỷ khung hình đang hẹn. Mặc định giải phóng luôn
   * WebGL context của canvas: Chromium chỉ cho khoảng 16 context, để dồn lại thì nó sẽ cắt context cũ
   * nhất (có thể là Scene view của Editor). Tạo viewer mới trên cùng canvas vẫn được (tự khôi phục).
   */
  const dispose = () => {
    if (view.disposed) {
      return;
    }
    view.disposed = true;
    if (view.frame) {
      window.cancelAnimationFrame(view.frame);
      view.frame = 0;
    }
    for (const [type, handler, settings] of listeners) {
      canvas.removeEventListener(type, handler, settings);
    }
    if (view.resizeObserver) {
      view.resizeObserver.disconnect();
      view.resizeObserver = null;
    }
    const gl = view.gl;
    if (gl && !view.lost) {
      for (const mesh of view.meshes) {
        freeMesh(mesh);
      }
      dropTexture();
      if (view.whiteTexture) {
        gl.deleteTexture(view.whiteTexture);
      }
      if (view.program) {
        gl.deleteProgram(view.program);
      }
      if (options.releaseContext !== false) {
        const loseContext = gl.getExtension('WEBGL_lose_context');
        if (loseContext) {
          // restoreContext() chỉ được phép sau khi sự kiện lost (tới sau, bất đồng bộ) đã bị chặn mặc định.
          const released = { loseContext, fired: false, onFired: null, requested: false };
          canvas.addEventListener('webglcontextlost', (event) => {
            event.preventDefault();
            released.fired = true;
            // Trình duyệt ghi nhận "cho phép khôi phục" khi xử lý sự kiện xong: đợi qua task này.
            setTimeout(() => released.onFired && released.onFired(), 0);
          }, { once: true });
          RELEASED_CONTEXTS.set(canvas, released);
          loseContext.loseContext();
        }
      }
    } else if (view.lost && view.pendingRelease) {
      // Bị huỷ khi context chưa khôi phục xong: trả lại cho viewer sau trên cùng canvas, không thì nó kẹt ở
      // trạng thái mất (báo lỗi, không bao giờ vẽ).
      view.pendingRelease.onFired = null;
      RELEASED_CONTEXTS.set(canvas, view.pendingRelease);
      view.pendingRelease = null;
    }
    view.meshes = [null, null];
    view.models = [null, null];
    view.texture = { input: null, image: null, handle: null, token: view.texture.token + 1 };
    view.drag = null;
    view.gl = null;
  };

  const api = {
    setModels,
    setTexture,
    setWireframe,
    resize,
    dispose,
    getOverlayInfo,
    resetView,
    /** Vẽ lại ở khung hình kế tiếp. */
    render: requestRender,
    /** true khi đang chạy WebGL2. */
    get webgl2() {
      return view.webgl2;
    },
  };

  // --- khởi tạo ---

  if (!canvas || typeof canvas.getContext !== 'function') {
    reportError('Không có canvas để vẽ model.');
    view.disposed = true;
    return api;
  }
  const attributes = { antialias: true, alpha: false, depth: true, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false };
  let gl = null;
  try {
    gl = options.webgl1 ? null : canvas.getContext('webgl2', attributes);
    view.webgl2 = !!gl;
    if (!gl) {
      gl = canvas.getContext('webgl', attributes) || canvas.getContext('experimental-webgl', attributes);
    }
  } catch (_error) {
    gl = null;
  }
  if (!gl) {
    reportError('Không tạo được WebGL (card đồ hoạ hoặc driver đang bị chặn): không xem trước được model.');
    view.disposed = true;
    return api;
  }
  view.gl = gl;
  for (const [type, handler, settings] of listeners) {
    canvas.addEventListener(type, handler, settings);
  }
  canvas.style.cursor = 'grab';
  canvas.style.touchAction = 'none';
  if (gl.isContextLost()) {
    // Canvas này từng được viewer trước giải phóng context: xin lại, dựng tài nguyên khi có sự kiện restored.
    const released = RELEASED_CONTEXTS.get(canvas);
    view.lost = true;
    if (released) {
      RELEASED_CONTEXTS.delete(canvas);
      view.pendingRelease = released;
      const restore = () => {
        // Viewer trước đã xin khôi phục mà bị huỷ trước sự kiện restored: chỉ cần chờ sự kiện, không xin lại.
        if (!view.disposed && !released.requested) {
          released.requested = true;
          released.loseContext.restoreContext();
        }
      };
      if (released.fired) {
        restore();
      } else {
        released.onFired = restore;
      }
    } else {
      reportError('WebGL context của canvas đang bị mất: không xem trước được model.');
    }
  } else if (!createResources()) {
    return api;
  }
  if (options.autoResize && typeof ResizeObserver === 'function') {
    view.resizeObserver = new ResizeObserver(() => resize());
    view.resizeObserver.observe(canvas);
  }
  resize();
  return api;
}

module.exports = {
  createMeshViewer,
  // Phần tính thuần, xuất ra để kiểm thử.
  buildEdges,
  splitPrimitive,
  computeFraming,
  computeBounds,
  layoutViews,
  toFileUrl,
};
