'use strict';

/**
 * Bước Tối ưu → Model 3D: xem trước Mesh Simplify (ô Inspector → Model → Mesh Simplify của FBX / glTF)
 * TRƯỚC khi áp dụng. Đọc hình học nguồn của model rồi giảm tam giác bằng chính meshoptimizer kèm editor.
 *
 * Nguồn hình học:
 *   .fbx  -> glTF do editor tự chuyển (cache temp/asset-db/assets/fbx.FBX-glTF-conv/<uuid>/output/out.gltf);
 *            cache chỉ có với model vừa (re)import, thiếu / cũ thì tự chạy FBX-glTF-conv của editor vào cacheDir.
 *   .gltf -> đọc thẳng (buffer ngoài theo đường dẫn tương đối, hoặc data: URI base64).
 *   .glb  -> tách khối JSON + BIN.
 * Áp transform của cây node (translation / rotation / scale / matrix) để model nhiều node hiện đúng chỗ.
 *
 * Giảm tam giác: meshopt_simplify trên từng primitive, trên toạ độ mesh (localPositions, chưa áp transform node,
 * đúng dữ liệu importer giảm), map từ userData.meshSimplify trong .meta:
 *   targetIndexCount = floor(indexCount * targetRatio / 3) * 3
 *   targetError      = autoErrorRate ? 1 : clamp(errorRate, 0, 1)   (sai số tương đối theo kích thước mesh)
 *   options          = lockBoundary ? meshopt_SimplifyLockBorder (1) : 0
 * Đây là ước lượng: importer của editor (mã đã mã hoá) dùng cùng meshoptimizer nhưng có thể khác chi tiết
 * (gộp đỉnh, thuộc tính phụ...), nên số tam giác thật sau import có thể lệch một chút.
 *
 * Không dùng biến toàn cục Editor: panel truyền appPath / projectRoot / cacheDir (chạy được bằng node để test).
 */

const fs = require('fs/promises');
const { existsSync } = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { performance } = require('perf_hooks');

/** Thư mục cache FBX -> glTF của editor (tương đối từ gốc dự án). */
const COCOS_FBX_CACHE = ['temp', 'asset-db', 'assets', 'fbx.FBX-glTF-conv'];
/** Thời gian tối đa cho một lần chuyển FBX. */
const CONVERT_TIMEOUT_MS = 60000;
/** Lệch mtime cho phép khi so với sourceTimeStamp (hệ file làm tròn giây). */
const MTIME_TOLERANCE_MS = 1000;
const UNIT_CONVERSIONS = new Set(['geometry-level', 'hierarchy-level', 'disabled']);
/** Phần mở rộng glTF nén mesh mà tool chưa giải được. */
const UNSUPPORTED_EXTENSIONS = new Set(['KHR_draco_mesh_compression', 'EXT_meshopt_compression']);

const TYPE_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
/** componentType -> { bytes, đọc từ DataView, chia khi normalized }. */
const COMPONENTS = {
  5120: { bytes: 1, read: (view, at) => view.getInt8(at), normalize: (value) => Math.max(value / 127, -1) },
  5121: { bytes: 1, read: (view, at) => view.getUint8(at), normalize: (value) => value / 255 },
  5122: { bytes: 2, read: (view, at) => view.getInt16(at, true), normalize: (value) => Math.max(value / 32767, -1) },
  5123: { bytes: 2, read: (view, at) => view.getUint16(at, true), normalize: (value) => value / 65535 },
  5125: { bytes: 4, read: (view, at) => view.getUint32(at, true), normalize: (value) => value / 4294967295 },
  5126: { bytes: 4, read: (view, at) => view.getFloat32(at, true), normalize: (value) => value },
};
const GLB_MAGIC = 0x46546c67;
const GLB_CHUNK_JSON = 0x4e4f534a;
const GLB_CHUNK_BIN = 0x004e4942;

// ---------------------------------------------------------------- công cụ của editor

/** Đường dẫn FBX-glTF-conv kèm editor ('' nếu không có). appPath = Editor.App.path (…/resources/app.asar). */
function findConverter(appPath) {
  if (!appPath) {
    return '';
  }
  const binary = process.platform === 'win32' ? ['win32', 'FBX-glTF-conv.exe']
    : process.platform === 'darwin' ? ['darwin', 'FBX-glTF-conv'] : null;
  if (!binary) {
    return '';
  }
  // File chạy được phải nằm ngoài asar (app.asar.unpacked); thử cả appPath phòng bản editor không đóng asar.
  const roots = appPath.endsWith('.asar') ? [`${appPath}.unpacked`, appPath] : [appPath];
  for (const root of roots) {
    const candidate = path.join(root, 'node_modules', '@cocos', 'fbx-gltf-conv', 'bin', ...binary);
    if (existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }
  return '';
}

/** modulePath -> Promise<encoder đã init>; nhớ theo đường dẫn để wasm chỉ khởi tạo một lần. */
const meshoptCache = new Map();

/** meshoptimizer của editor (thư mục chứa meshopt_encoder.js). null nếu không nạp được. */
async function loadMeshopt(modulePath) {
  if (!modulePath) {
    return null;
  }
  const key = path.resolve(modulePath);
  if (!meshoptCache.has(key)) {
    meshoptCache.set(key, (async () => {
      let encoder = null;
      try {
        encoder = require(key);
      } catch (_error) {
        encoder = require(path.join(key, 'meshopt_encoder.js'));
      }
      await encoder.init();
      if (!encoder.optimizer || typeof encoder.optimizer.simplify !== 'function') {
        throw new Error('meshopt_encoder không có optimizer.simplify');
      }
      return encoder;
    })().catch(() => {
      // Không nhớ lần lỗi: lần sau thử lại (vd. đường dẫn sai được sửa).
      meshoptCache.delete(key);
      return null;
    }));
  }
  return meshoptCache.get(key);
}

// ---------------------------------------------------------------- đọc glTF / glb

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (_error) {
    return null;
  }
}

async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch (_error) {
    return null;
  }
}

/** Buffer của một `buffers[i]`: khối BIN của glb, data: URI, hoặc file cạnh model. */
async function loadBuffer(entry, index, dir, glbBin) {
  if (entry.uri === undefined) {
    if (!glbBin) {
      throw new Error(`Buffer ${index} không có uri và không có khối BIN`);
    }
    return glbBin;
  }
  if (entry.uri.startsWith('data:')) {
    const comma = entry.uri.indexOf(',');
    const header = entry.uri.slice(0, comma);
    const body = entry.uri.slice(comma + 1);
    return header.endsWith(';base64') ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'binary');
  }
  const file = path.resolve(dir, decodeURIComponent(entry.uri));
  try {
    return await fs.readFile(file);
  } catch (_error) {
    throw new Error(`Không đọc được buffer của model: ${file}`);
  }
}

/** Tách file .glb: { json, bin }. */
function parseGlb(data, file) {
  if (data.length < 20 || data.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error(`File .glb không hợp lệ: ${file}`);
  }
  const length = Math.min(data.readUInt32LE(8), data.length);
  let json = null;
  let bin = null;
  let offset = 12;
  while (offset + 8 <= length) {
    const chunkLength = data.readUInt32LE(offset);
    const chunkType = data.readUInt32LE(offset + 4);
    const chunk = data.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkType === GLB_CHUNK_JSON && !json) {
      json = JSON.parse(chunk.toString('utf8'));
    } else if (chunkType === GLB_CHUNK_BIN && !bin) {
      bin = chunk;
    }
    offset += 8 + chunkLength;
  }
  if (!json) {
    throw new Error(`File .glb không có khối JSON: ${file}`);
  }
  return { json, bin };
}

/** Đọc .gltf / .glb kèm mọi buffer: { json, buffers: Buffer[] }. */
async function readGltfFile(file) {
  let data;
  try {
    data = await fs.readFile(file);
  } catch (_error) {
    throw new Error(`Không đọc được file model: ${file}`);
  }
  let json;
  let glbBin = null;
  if (path.extname(file).toLowerCase() === '.glb') {
    ({ json, bin: glbBin } = parseGlb(data, file));
  } else {
    try {
      json = JSON.parse(data.toString('utf8').replace(/^﻿/, ''));
    } catch (_error) {
      throw new Error(`File glTF không đọc được (JSON lỗi): ${file}`);
    }
  }
  const blocked = (json.extensionsRequired || []).filter((name) => UNSUPPORTED_EXTENSIONS.has(name));
  if (blocked.length) {
    throw new Error(`Model dùng ${blocked.join(', ')} (mesh đã nén trong glTF), tool chưa đọc được`);
  }
  const dir = path.dirname(file);
  const buffers = await Promise.all((json.buffers || []).map((entry, index) => loadBuffer(entry, index, dir, glbBin)));
  return { json, buffers };
}

/** Đọc accessor ra mảng `OutArray` (Float32Array / Uint32Array), xếp khít, theo byteStride / normalized / sparse. */
function readAccessor(doc, index, OutArray) {
  const accessor = doc.json.accessors && doc.json.accessors[index];
  if (!accessor) {
    throw new Error(`Model thiếu accessor ${index}`);
  }
  const comps = TYPE_SIZE[accessor.type];
  const component = COMPONENTS[accessor.componentType];
  if (!comps || !component) {
    throw new Error(`Accessor ${index} có kiểu không hỗ trợ (${accessor.type} / ${accessor.componentType})`);
  }
  const count = accessor.count || 0;
  const normalize = accessor.normalized && OutArray === Float32Array;
  const out = new OutArray(count * comps);

  if (accessor.bufferView !== undefined) {
    const viewInfo = doc.json.bufferViews[accessor.bufferView];
    const buffer = doc.buffers[viewInfo.buffer];
    const elementBytes = comps * component.bytes;
    const stride = viewInfo.byteStride || elementBytes;
    const start = (viewInfo.byteOffset || 0) + (accessor.byteOffset || 0);
    const viewEnd = (viewInfo.byteOffset || 0) + viewInfo.byteLength;
    if (count && start + (count - 1) * stride + elementBytes > Math.min(viewEnd, buffer.length)) {
      throw new Error(`Accessor ${index} vượt ngoài buffer`);
    }
    const absolute = buffer.byteOffset + start;
    if (stride === elementBytes && accessor.componentType === 5126 && OutArray === Float32Array && absolute % 4 === 0) {
      out.set(new Float32Array(buffer.buffer, absolute, count * comps));
    } else if (stride === elementBytes && accessor.componentType === 5125 && OutArray === Uint32Array && absolute % 4 === 0) {
      out.set(new Uint32Array(buffer.buffer, absolute, count * comps));
    } else if (stride === elementBytes && accessor.componentType === 5123 && OutArray === Uint32Array && absolute % 2 === 0) {
      out.set(new Uint16Array(buffer.buffer, absolute, count * comps));
    } else {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      for (let item = 0; item < count; item += 1) {
        const at = start + item * stride;
        for (let c = 0; c < comps; c += 1) {
          const value = component.read(view, at + c * component.bytes);
          out[item * comps + c] = normalize ? component.normalize(value) : value;
        }
      }
    }
  }

  // Sparse: ghi đè một số phần tử (accessor không có bufferView thì nền là 0).
  const sparse = accessor.sparse;
  if (sparse && sparse.count) {
    const readTight = (ref, componentType, length) => {
      const viewInfo = doc.json.bufferViews[ref.bufferView];
      const buffer = doc.buffers[viewInfo.buffer];
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const info = COMPONENTS[componentType];
      const start = (viewInfo.byteOffset || 0) + (ref.byteOffset || 0);
      const values = new Array(length);
      for (let i = 0; i < length; i += 1) {
        values[i] = info.read(view, start + i * info.bytes);
      }
      return values;
    };
    const targets = readTight(sparse.indices, sparse.indices.componentType, sparse.count);
    const values = readTight(sparse.values, accessor.componentType, sparse.count * comps);
    targets.forEach((target, i) => {
      for (let c = 0; c < comps; c += 1) {
        const value = values[i * comps + c];
        out[target * comps + c] = normalize ? component.normalize(value) : value;
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------- ma trận (cột trước, như glTF)

function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiply(a, b) {
  const out = new Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[col * 4 + row] = a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

/** Ma trận local của node: `matrix` hoặc T * R * S. */
function localMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    return node.matrix.slice();
  }
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const xx = x * x * 2;
  const yy = y * y * 2;
  const zz = z * z * 2;
  const xy = x * y * 2;
  const xz = x * z * 2;
  const yz = y * z * 2;
  const wx = w * x * 2;
  const wy = w * y * 2;
  const wz = w * z * 2;
  return [
    (1 - yy - zz) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - xx - zz) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - xx - yy) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function isIdentity(matrix) {
  return matrix.every((value, i) => Math.abs(value - (i % 5 === 0 ? 1 : 0)) < 1e-9);
}

/** Ma trận pháp tuyến = (M^-1)^T của phần 3x3 = cofactor / det (chỉ cần dấu của det vì sẽ chuẩn hoá). */
function normalMatrix(m) {
  const a00 = m[0]; const a01 = m[4]; const a02 = m[8];
  const a10 = m[1]; const a11 = m[5]; const a12 = m[9];
  const a20 = m[2]; const a21 = m[6]; const a22 = m[10];
  const c = [
    a11 * a22 - a12 * a21, -(a10 * a22 - a12 * a20), a10 * a21 - a11 * a20,
    -(a01 * a22 - a02 * a21), a00 * a22 - a02 * a20, -(a00 * a21 - a01 * a20),
    a01 * a12 - a02 * a11, -(a00 * a12 - a02 * a10), a00 * a11 - a01 * a10,
  ];
  const det = a00 * c[0] + a01 * c[1] + a02 * c[2];
  const sign = det < 0 ? -1 : 1;
  return { rows: c.map((value) => value * sign), det };
}

function transformPositions(source, m) {
  const out = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 3) {
    const x = source[i];
    const y = source[i + 1];
    const z = source[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

function normalizeInPlace(normals) {
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (length > 1e-12) {
      normals[i] /= length;
      normals[i + 1] /= length;
      normals[i + 2] /= length;
    } else {
      normals[i] = 0;
      normals[i + 1] = 1;
      normals[i + 2] = 0;
    }
  }
  return normals;
}

function transformNormals(source, rows) {
  const out = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 3) {
    const x = source[i];
    const y = source[i + 1];
    const z = source[i + 2];
    out[i] = rows[0] * x + rows[1] * y + rows[2] * z;
    out[i + 1] = rows[3] * x + rows[4] * y + rows[5] * z;
    out[i + 2] = rows[6] * x + rows[7] * y + rows[8] * z;
  }
  return normalizeInPlace(out);
}

/** Pháp tuyến đỉnh theo diện tích mặt (model thiếu NORMAL). */
function computeNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const vertex of [a, b, c]) {
      normals[vertex] += nx;
      normals[vertex + 1] += ny;
      normals[vertex + 2] += nz;
    }
  }
  return normalizeInPlace(normals);
}

// ---------------------------------------------------------------- dựng hình học từ glTF

/** Danh sách { meshIndex, matrix } theo cây scene; mesh không node nào dùng thì đặt ở gốc toạ độ. */
function meshInstances(json) {
  const nodes = json.nodes || [];
  const instances = [];
  const used = new Set();
  let roots;
  const scene = json.scenes && json.scenes[json.scene !== undefined ? json.scene : 0];
  if (scene && Array.isArray(scene.nodes)) {
    roots = scene.nodes;
  } else {
    const children = new Set(nodes.flatMap((node) => node.children || []));
    roots = nodes.map((_node, index) => index).filter((index) => !children.has(index));
  }
  const visiting = new Set();
  const visit = (index, parent) => {
    const node = nodes[index];
    if (!node || visiting.has(index)) {
      return;
    }
    visiting.add(index);
    const world = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined && json.meshes && json.meshes[node.mesh]) {
      // Mesh có skin: glTF bỏ qua transform của node đó (xương quyết định); tư thế bind ~ không biến đổi.
      instances.push({ meshIndex: node.mesh, matrix: node.skin !== undefined ? identity() : world, node: node.name || '' });
      used.add(node.mesh);
    }
    (node.children || []).forEach((child) => visit(child, world));
    visiting.delete(index);
  };
  roots.forEach((index) => visit(index, identity()));
  (json.meshes || []).forEach((_mesh, meshIndex) => {
    if (!used.has(meshIndex)) {
      instances.push({ meshIndex, matrix: identity(), node: '' });
    }
  });
  return instances;
}

/** glTF đã đọc -> { primitives, bounds, triangles, meshTriangles, source, file }. */
function buildGeometry(doc, source, file) {
  const json = doc.json;
  const raw = new Map();
  const cached = (index, OutArray) => {
    const key = `${index}:${OutArray.name}`;
    if (!raw.has(key)) {
      raw.set(key, readAccessor(doc, index, OutArray));
    }
    return raw.get(key);
  };

  const primitives = [];
  const meshTriangles = new Map();
  for (const instance of meshInstances(json)) {
    const mesh = json.meshes[instance.meshIndex];
    const identityMatrix = isIdentity(instance.matrix);
    const normalInfo = identityMatrix ? null : normalMatrix(instance.matrix);
    let meshTris = 0;
    (mesh.primitives || []).forEach((primitive, primitiveIndex) => {
      const attributes = primitive.attributes || {};
      if ((primitive.mode !== undefined && primitive.mode !== 4) || attributes.POSITION === undefined) {
        return;
      }
      const basePositions = cached(attributes.POSITION, Float32Array);
      const accessor = json.accessors[attributes.POSITION];
      if (TYPE_SIZE[accessor.type] !== 3) {
        return;
      }
      const vertexCount = basePositions.length / 3;
      let indices;
      if (primitive.indices !== undefined) {
        indices = cached(primitive.indices, Uint32Array);
      } else {
        indices = new Uint32Array(vertexCount - (vertexCount % 3));
        for (let i = 0; i < indices.length; i += 1) {
          indices[i] = i;
        }
      }
      if (indices.length % 3) {
        indices = indices.slice(0, indices.length - (indices.length % 3));
      }
      // Index vượt số đỉnh (file hỏng): bỏ primitive, không đưa vào meshopt (wasm đọc / ghi lố heap) hay WebGL.
      let maxIndex = -1;
      for (let i = 0; i < indices.length; i += 1) {
        if (indices[i] > maxIndex) maxIndex = indices[i];
      }
      if (maxIndex >= vertexCount) {
        return;
      }
      // Transform lật (det < 0) thì đảo chiều tam giác để mặt trước vẫn ngược chiều kim đồng hồ.
      if (normalInfo && normalInfo.det < 0) {
        indices = indices.slice();
        for (let i = 0; i < indices.length; i += 3) {
          const swap = indices[i + 1];
          indices[i + 1] = indices[i + 2];
          indices[i + 2] = swap;
        }
      }
      const positions = identityMatrix ? basePositions : transformPositions(basePositions, instance.matrix);
      let normals = null;
      if (attributes.NORMAL !== undefined && TYPE_SIZE[json.accessors[attributes.NORMAL].type] === 3) {
        const baseNormals = cached(attributes.NORMAL, Float32Array);
        normals = identityMatrix ? baseNormals : transformNormals(baseNormals, normalInfo.rows);
      } else {
        normals = computeNormals(positions, indices);
      }
      const uvs = attributes.TEXCOORD_0 !== undefined ? cached(attributes.TEXCOORD_0, Float32Array) : null;
      primitives.push({
        positions,
        normals,
        uvs: uvs && uvs.length === vertexCount * 2 ? uvs : null,
        indices,
        /** Toạ độ trong không gian mesh (chưa áp transform node): importer giảm tam giác trên dữ liệu mesh này. */
        localPositions: basePositions,
        mesh: mesh.name || `mesh ${instance.meshIndex}`,
        meshIndex: instance.meshIndex,
        primitiveIndex,
        node: instance.node,
      });
      meshTris += indices.length / 3;
    });
    meshTriangles.set(instance.meshIndex, meshTris);
  }
  if (!primitives.length) {
    const error = new Error('Model không có mesh tam giác nào để xem trước');
    // Dữ liệu đọc được, chỉ là không có mesh (vd FBX chỉ chứa animation): chuyển FBX lại cũng vô ích.
    error.code = 'NO_MESH';
    throw error;
  }

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const primitive of primitives) {
    const { positions } = primitive;
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = positions[i + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
  }
  if (!Number.isFinite(min[0])) {
    min.fill(0);
    max.fill(0);
  }
  return {
    primitives,
    bounds: { min, max },
    triangles: primitives.reduce((sum, primitive) => sum + primitive.indices.length / 3, 0),
    /** Mỗi mesh tính một lần (mesh dùng ở nhiều node), khớp tổng triangleCount trong .meta. */
    meshTriangles: [...meshTriangles.values()].reduce((sum, value) => sum + value, 0),
    source,
    file,
  };
}

// ---------------------------------------------------------------- FBX -> glTF

/** out.gltf trong cache của editor nếu còn khớp file FBX hiện tại, '' nếu thiếu / cũ. */
async function cocosCacheFile(projectRoot, uuid, fbxStat) {
  const base = path.join(projectRoot, ...COCOS_FBX_CACHE, uuid);
  const outGltf = path.join(base, 'output', 'out.gltf');
  const outStat = await statOrNull(outGltf);
  if (!outStat) {
    return '';
  }
  const status = await readJson(path.join(base, 'status.json'));
  if (status && typeof status.sourceTimeStamp === 'number') {
    // sourceTimeStamp = mtime của FBX lúc editor import: lệch bất kỳ chiều nào là cache cũ
    // (chép đè FBX bằng Explorer giữ mtime cũ hơn, editor chưa kịp import lại).
    return Math.abs(fbxStat.mtimeMs - status.sourceTimeStamp) <= MTIME_TOLERANCE_MS ? outGltf : '';
  }
  return fbxStat.mtimeMs <= outStat.mtimeMs ? outGltf : '';
}

/** Lỗi đọc được từ log JSON của FBX-glTF-conv (vài dòng đầu). */
async function converterLogErrors(logFile) {
  const log = await readJson(logFile);
  if (!Array.isArray(log)) {
    return '';
  }
  return log
    .filter((entry) => entry && entry.message && Number(entry.level) >= 2)
    .map((entry) => String(entry.message))
    .slice(0, 3)
    .join(' | ');
}

function runConverter(converterPath, args, options) {
  return new Promise((resolve, reject) => {
    execFile(converterPath, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/** Lần chuyển đang chạy theo file đích (panel bấm liên tục không chạy trùng). */
const converting = new Map();

/** Chuyển FBX vào <cacheDir>/<uuid>/out.gltf; dùng lại bản cũ nếu cùng mtime nguồn và cùng tuỳ chọn. */
async function convertFbx({ assetPath, fbxStat, uuid, converterPath, cacheDir, unitConversion, force, timeoutMs }) {
  if (!converterPath || !existsSync(converterPath)) {
    throw new Error('Không tìm thấy bộ chuyển FBX-glTF-conv của Cocos (bản Creator này không kèm @cocos/fbx-gltf-conv?)');
  }
  if (!cacheDir) {
    throw new Error('Thiếu thư mục cache để chuyển FBX sang glTF');
  }
  const outDir = path.resolve(cacheDir, uuid || path.basename(assetPath, path.extname(assetPath)));
  const outGltf = path.join(outDir, 'out.gltf');
  const stampFile = path.join(outDir, 'stamp.json');
  const stamp = { source: assetPath, sourceMtime: fbxStat.mtimeMs, sourceSize: fbxStat.size, unitConversion };

  if (!force) {
    const previous = await readJson(stampFile);
    if (previous && previous.source === stamp.source && previous.sourceMtime === stamp.sourceMtime && previous.sourceSize === stamp.sourceSize
      && previous.unitConversion === stamp.unitConversion && await statOrNull(outGltf)) {
      return outGltf;
    }
  }
  if (converting.has(outGltf)) {
    return converting.get(outGltf);
  }
  const job = (async () => {
    await fs.mkdir(outDir, { recursive: true });
    // Xoá dấu cũ trước: chuyển hỏng giữa chừng thì lần sau không dùng nhầm file dở.
    await fs.rm(stampFile, { force: true });
    await fs.rm(outGltf, { force: true });
    const logFile = path.join(outDir, 'log.json');
    await fs.rm(logFile, { force: true });
    // Đường dẫn ra để tương đối theo cwd = outDir: FBX-glTF-conv đổi --out sang code page ANSI, thư mục dự án có
    // ký tự tiếng Việt thì lỗi "No mapping for the Unicode character..." (file vào đường dẫn Unicode thì không sao).
    // Phải có "./": thiếu thì converter tạo thư mục cha "" và lỗi create_directories.
    const args = [
      '--unit-conversion', unitConversion,
      '--no-texture-resolution',
      '--fbm-dir', './fbm',
      '--log-file', './log.json',
      '--out', './out.gltf',
      assetPath,
    ];
    try {
      await runConverter(converterPath, args, { cwd: outDir, timeout: timeoutMs || CONVERT_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
      const detail = error.killed ? `quá ${Math.round((timeoutMs || CONVERT_TIMEOUT_MS) / 1000)} giây`
        : (await converterLogErrors(logFile)) || String(error.stderr || error.message || error).trim().slice(0, 300);
      throw new Error(`Chuyển FBX sang glTF thất bại (${path.basename(assetPath)}): ${detail}`);
    }
    if (!await statOrNull(outGltf)) {
      const detail = await converterLogErrors(logFile);
      throw new Error(`Chuyển FBX xong nhưng không thấy out.gltf (${path.basename(assetPath)})${detail ? `: ${detail}` : ''}`);
    }
    await fs.writeFile(stampFile, JSON.stringify(stamp, null, 2));
    return outGltf;
  })();
  converting.set(outGltf, job);
  try {
    return await job;
  } finally {
    converting.delete(outGltf);
  }
}

/**
 * Hình học nguồn của model: { primitives: [{ positions, normals, uvs, indices, ... }], bounds, triangles, source }.
 * model = { uuid, assetPath (đường dẫn tuyệt đối .fbx / .gltf / .glb) }.
 */
async function loadSourceGeometry({ projectRoot, model, converterPath, cacheDir, timeoutMs }) {
  if (!model || !model.assetPath) {
    throw new Error('Thiếu đường dẫn file model');
  }
  const assetPath = path.resolve(model.assetPath);
  const fileStat = await statOrNull(assetPath);
  if (!fileStat || !fileStat.isFile()) {
    throw new Error(`Không tìm thấy file model: ${assetPath}`);
  }
  const ext = path.extname(assetPath).toLowerCase();
  if (ext === '.gltf' || ext === '.glb') {
    return buildGeometry(await readGltfFile(assetPath), ext.slice(1), assetPath);
  }
  if (ext !== '.fbx') {
    throw new Error(`Chưa hỗ trợ xem trước định dạng ${ext || '(không đuôi)'}`);
  }

  const meta = await readJson(`${assetPath}.meta`);
  const uuid = model.uuid || (meta && meta.uuid) || '';
  const fbxOptions = (meta && meta.userData && meta.userData.fbx) || {};
  const unitConversion = UNIT_CONVERSIONS.has(fbxOptions.unitConversion) ? fbxOptions.unitConversion : 'geometry-level';

  // 1. Cache của editor (đúng bản editor đã import).
  const cocosFile = projectRoot && uuid ? await cocosCacheFile(projectRoot, uuid, fileStat) : '';
  if (cocosFile) {
    try {
      return buildGeometry(await readGltfFile(cocosFile), 'cocos-cache', cocosFile);
    } catch (error) {
      if (error.code === 'NO_MESH') {
        throw error;
      }
      // Cache hỏng / thiếu out.bin: tự chuyển lại bên dưới.
    }
  }

  // 2. Tự chuyển bằng FBX-glTF-conv của editor (bản đã chuyển trước đó đọc lỗi thì chuyển lại một lần).
  const convertOptions = { assetPath, fbxStat: fileStat, uuid, converterPath, cacheDir, unitConversion, timeoutMs };
  const outGltf = await convertFbx(convertOptions);
  try {
    return buildGeometry(await readGltfFile(outGltf), 'converted', outGltf);
  } catch (error) {
    if (error.code === 'NO_MESH') {
      throw error;
    }
    const fresh = await convertFbx({ ...convertOptions, force: true });
    return buildGeometry(await readGltfFile(fresh), 'converted', fresh);
  }
}

// ---------------------------------------------------------------- giảm tam giác

/** userData.meshSimplify -> tham số meshopt_simplify: { ratio, targetError, flags }. */
function simplifyParams(options) {
  const value = options || {};
  // null / '' coi như chưa nhập (Number(null) = 0 sẽ thành ratio 0 = gần như xoá sạch model).
  const numberOr = (input, fallback) => (input === null || input === '' || !Number.isFinite(Number(input)) ? fallback : Number(input));
  const ratio = Math.max(0, Math.min(1, numberOr(value.targetRatio, 1)));
  const errorRate = numberOr(value.errorRate, 1);
  return {
    ratio,
    // autoErrorRate mặc định bật (như Inspector); tắt thì dùng errorRate do người dùng nhập.
    targetError: value.autoErrorRate === false ? Math.max(0, Math.min(1, errorRate)) : 1,
    flags: value.lockBoundary ? 1 : 0,
  };
}

/** Giảm tam giác từng primitive: { primitives (chỉ indices đổi), triangles, ms }. ratio >= 1 giữ nguyên. */
function simplifyGeometry(encoder, geometry, options) {
  const { ratio, targetError, flags } = simplifyParams(options);
  const started = performance.now();
  const primitives = geometry.primitives.map((primitive) => {
    if (ratio >= 1 || primitive.indices.length < 3) {
      return { ...primitive, indices: primitive.indices };
    }
    // meshopt_encoder chép nguyên byte của typed array vào heap wasm: indices phải là Uint32Array, toạ độ Float32Array
    // (Uint16Array sẽ bị đọc lố => index rác, lỗi "memory access out of bounds").
    const indices = primitive.indices instanceof Uint32Array ? primitive.indices : Uint32Array.from(primitive.indices);
    // Giảm trên toạ độ mesh như importer (transform node, nhất là scale không đều, làm đổi cạnh được gộp).
    const source = primitive.localPositions || primitive.positions;
    const positions = source instanceof Float32Array ? source : Float32Array.from(source);
    const target = Math.floor(indices.length * ratio / 3) * 3;
    const dest = new Uint32Array(indices.length);
    // meshopt_encoder nhận typed array (không phải ArrayBuffer như .d.ts ghi); positions phải là xyz xếp khít.
    const count = encoder.optimizer.simplify(dest, indices, indices.length, positions, positions.length / 3, 12, target, targetError, flags, 0);
    return { ...primitive, indices: dest.slice(0, count) };
  });
  return {
    primitives,
    triangles: primitives.reduce((sum, primitive) => sum + primitive.indices.length / 3, 0),
    ms: Math.round((performance.now() - started) * 10) / 10,
  };
}

module.exports = {
  findConverter,
  loadMeshopt,
  loadSourceGeometry,
  simplifyGeometry,
  simplifyParams,
  readGltfFile,
  buildGeometry,
};
