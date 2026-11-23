'use strict';

/**
 * Tìm binary/module ngoài (ffmpeg-static, về sau có thể thêm sharp) theo thứ tự:
 *   1. node_modules của chính extension này (sau khi `npm install` trong thư mục tool)
 *   2. node_modules của extension khác trong dự án đang mở (playable-ads-builder trước, rồi mọi
 *      <project>/extensions/* có ffmpeg-static), và của extension cài global (~/.CocosCreator/extensions/*)
 *   3. (chỉ ffmpeg) file `ffmpeg` trong PATH, kể cả chỗ cài phổ biến mà Cocos mở từ Finder / Dashboard không thấy
 *      (macOS: /opt/homebrew/bin, /usr/local/bin, volta, nvm)
 * Không tìm thấy thì ném lỗi có hướng dẫn cài. Dự án đang mở: setProjectRoot (cli) hoặc Editor.Project.path.
 * Tool không cần nằm trong <project>/extensions/: cài global hay chạy từ chỗ khác vẫn tìm đúng.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { globalExtensionsRoot } = require('./compat');

const EXTENSION_ROOT = path.resolve(__dirname, '..');
/** Chỉ dẫn khi máy chưa có Node.js (npm cần để tải ffmpeg-static). */
const NODE_HINT = 'Máy chưa cài Node.js nên chưa tải được ffmpeg. Cài Node.js bản LTS (https://nodejs.org), '
  + 'tắt hẳn Cocos Creator rồi mở lại (để Cocos nhận Node.js vừa cài), sau đó bấm Cài ffmpeg. '
  + 'Cách khác: chép kèm thư mục node_modules của tool từ máy đã cài (cùng hệ điều hành), hoặc cài FFmpeg vào PATH.';
/** Extension hay có sẵn ffmpeg-static trong node_modules: thử trước các extension khác. */
const PREFERRED_EXTENSIONS = ['playable-ads-builder'];

let explicitProjectRoot = '';

/** Dự án đang làm việc (cli/selftest.js gọi; trong Editor tự lấy Editor.Project.path). */
function setProjectRoot(projectRoot) {
  explicitProjectRoot = projectRoot ? path.resolve(projectRoot) : '';
  cachedFfmpeg = null;
}

function currentProjectRoot() {
  if (explicitProjectRoot) {
    return explicitProjectRoot;
  }
  try {
    // eslint-disable-next-line no-undef
    return typeof Editor !== 'undefined' && Editor.Project && Editor.Project.path ? Editor.Project.path : '';
  } catch (_error) {
    return '';
  }
}

/** node_modules của các extension trong `root` (playable-ads-builder trước), bỏ chính tool này. */
function extensionNodeModules(root) {
  if (!root) {
    return [];
  }
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (_error) {
    return [];
  }
  names.sort((left, right) => {
    const rank = (name) => (PREFERRED_EXTENSIONS.includes(name) ? PREFERRED_EXTENSIONS.indexOf(name) : PREFERRED_EXTENSIONS.length);
    return rank(left) - rank(right) || left.localeCompare(right);
  });
  return names
    .map((name) => path.join(root, name))
    .filter((dir) => path.resolve(dir) !== EXTENSION_ROOT)
    .map((dir) => path.join(dir, 'node_modules'));
}

function candidateNodeModules() {
  const projectRoot = currentProjectRoot();
  const roots = [
    path.join(EXTENSION_ROOT, 'node_modules'),
    ...extensionNodeModules(projectRoot ? path.join(projectRoot, 'extensions') : ''),
    // Tool nằm trong extensions/ của một dự án khác dự án đang phân tích (chạy cli từ chỗ khác).
    ...extensionNodeModules(path.resolve(EXTENSION_ROOT, '..')),
    ...extensionNodeModules(globalExtensionsRoot()),
  ];
  return [...new Set(roots.map((dir) => path.resolve(dir)))];
}

/** Thư mục của package `name` ở nơi đầu tiên tìm thấy, hoặc ''. */
function resolveModuleDir(name) {
  for (const root of candidateNodeModules()) {
    const dir = path.join(root, name);
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
  }
  return '';
}

/**
 * Thư mục chứa công cụ dòng lệnh (npm, node, ffmpeg): PATH, rồi các chỗ cài phổ biến. Cocos mở từ Finder / Dock
 * trên macOS chỉ có PATH=/usr/bin:/bin:/usr/sbin:/sbin nên không thấy Node.js / ffmpeg cài bằng Homebrew, nvm, volta.
 */
function searchDirectories() {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const home = (() => {
    try {
      return os.homedir();
    } catch (_error) {
      return '';
    }
  })();
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
      if (base) {
        dirs.push(path.join(base, 'nodejs'));
      }
    }
    if (process.env.APPDATA) {
      dirs.push(path.join(process.env.APPDATA, 'npm'));
    }
    if (process.env.NVM_SYMLINK) {
      dirs.push(process.env.NVM_SYMLINK);
    }
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin');
    if (home) {
      dirs.push(path.join(home, '.volta', 'bin'), path.join(home, '.local', 'bin'), path.join(home, '.nodenv', 'shims'), path.join(home, '.asdf', 'shims'));
      // nvm: bản mới nhất trước.
      const nvmRoot = path.join(process.env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node');
      try {
        const versions = fs.readdirSync(nvmRoot).sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
        dirs.push(...versions.map((version) => path.join(nvmRoot, version, 'bin')));
      } catch (_error) {
        // không dùng nvm
      }
    }
  }
  return [...new Set(dirs)];
}

function findInPath(executable) {
  for (const directory of searchDirectories()) {
    const candidate = path.join(directory, executable);
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch (_error) {
      // thử thư mục tiếp theo
    }
  }
  return '';
}

/** Đường dẫn npm (đi kèm Node.js), '' nếu máy chưa cài. */
function findNpm() {
  return findInPath(process.platform === 'win32' ? 'npm.cmd' : 'npm');
}

let cachedFfmpeg = null;

/** ffmpeg trong một thư mục ffmpeg-static: chỉ nhận đúng binary của hệ điều hành này (node_modules chép từ Windows chỉ có ffmpeg.exe). */
function ffmpegIn(moduleDir) {
  const exe = path.join(moduleDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  return fs.existsSync(exe) ? exe : '';
}

/** Đường dẫn ffmpeg. Ném lỗi kèm hướng dẫn nếu không có. */
function resolveFfmpegPath() {
  if (cachedFfmpeg && fs.existsSync(cachedFfmpeg)) {
    return cachedFfmpeg;
  }
  cachedFfmpeg = null;

  for (const root of candidateNodeModules()) {
    const exe = ffmpegIn(path.join(root, 'ffmpeg-static'));
    if (exe) {
      cachedFfmpeg = exe;
      return exe;
    }
  }

  const fromPath = findInPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fromPath) {
    cachedFfmpeg = fromPath;
    return fromPath;
  }

  const copied = fs.existsSync(path.join(EXTENSION_ROOT, 'node_modules', 'ffmpeg-static', 'package.json'));
  throw new Error(copied
    ? `node_modules/ffmpeg-static của tool không có ffmpeg cho ${process.platform} (chép từ máy khác hệ điều hành?). `
      + 'Xoá thư mục node_modules của tool rồi bấm Cài ffmpeg (hoặc chạy `npm install` trong thư mục tool), hoặc cài FFmpeg vào PATH.'
    : 'Không tìm thấy ffmpeg. Chạy `npm install` trong thư mục extension playable-size-inspector '
      + '(hoặc trong extensions/playable-ads-builder), hoặc cài FFmpeg vào PATH.');
}

/**
 * Cài dependency của chính extension (hiện chỉ có ffmpeg-static) bằng npm, để người
 * dùng không phải mở terminal. Trả về { ok, code, output }.
 */
function installDependencies({ timeoutMs = 10 * 60 * 1000 } = {}) {
  const isWindows = process.platform === 'win32';
  const npm = findNpm();
  // Không có npm thì cmd chỉ báo "'npm.cmd' is not recognized...": báo luôn cách cài Node.js.
  if (!npm) {
    return Promise.resolve({ ok: false, code: -1, needsNode: true, output: NODE_HINT });
  }
  // Windows cần shell để chạy npm.cmd; gộp luôn tham số vào chuỗi lệnh để Node không cảnh báo về việc truyền
  // args kèm shell (lệnh cố định, không có input người dùng). Đường dẫn npm có dấu cách (Program Files) nên đặt trong "".
  const command = isWindows ? `"${npm}" install --no-audit --no-fund` : npm;
  const args = isWindows ? [] : ['install', '--no-audit', '--no-fund'];
  // npm là script node: thư mục của nó phải có trong PATH (macOS mở Cocos từ Finder thì PATH không có) để
  // "#!/usr/bin/env node" tìm được node.
  const env = { ...process.env, PATH: [path.dirname(npm), process.env.PATH || ''].filter(Boolean).join(path.delimiter) };
  // ELECTRON_RUN_AS_NODE của Editor không được lọt vào npm (npm không phải Electron).
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: EXTENSION_ROOT,
        windowsHide: true,
        shell: isWindows,
        env,
      });
    } catch (error) {
      resolve({ ok: false, code: -1, output: `Không chạy được npm: ${error.message}` });
      return;
    }

    let output = '';
    const append = (chunk) => { output += chunk.toString(); };
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, code: -1, output: `${output}\nQuá thời gian chờ npm install.` });
    }, timeoutMs);

    if (child.stdout) child.stdout.on('data', append);
    if (child.stderr) child.stderr.on('data', append);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: -1,
        output: `${output}\nKhông chạy được npm (${error.message}). Cài Node.js hoặc chạy tay trong thư mục tool: npm install`,
      });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      cachedFfmpeg = null;
      resolve({ ok: code === 0, code, output: output.trim().split('\n').slice(-12).join('\n') });
    });
  });
}

/** Mô tả toolchain để hiển thị/ghi log: { ffmpeg, ffmpegError, npm }. */
function describeToolchain() {
  let ffmpeg = '';
  let ffmpegError = '';
  try {
    ffmpeg = resolveFfmpegPath();
  } catch (error) {
    ffmpegError = error.message;
  }
  return { ffmpeg, ffmpegError, npm: findNpm() };
}

module.exports = {
  EXTENSION_ROOT,
  NODE_HINT,
  setProjectRoot,
  findNpm,
  resolveModuleDir,
  resolveFfmpegPath,
  installDependencies,
  describeToolchain,
};
