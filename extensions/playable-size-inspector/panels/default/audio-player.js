'use strict';

/**
 * Khung "Nghe thử & cắt" của bước Tối ưu → Âm thanh.
 *
 *   - Waveform vẽ từ dữ liệu giải mã bằng Web Audio, kèm thanh tiến trình bên dưới: bấm / kéo ở
 *     cả hai chỗ để tua.
 *   - Hai mốc cắt đầu / cuối: kéo trên waveform, gõ số, hoặc đặt tại vị trí đang phát ([ ] / I O);
 *     fade vào / ra tính bằng ms.
 *   - Hai nguồn nghe: "Gốc" là file trong assets/ (bật "Chỉ đoạn giữ" thì phát đúng đoạn giữ lại
 *     kèm fade, như file sau khi cắt - afade của ffmpeg cũng tuyến tính); "Kết quả" là bản encode
 *     thử do main.js tạo trong temp/, tức đúng file sẽ thay vào assets/ (nghe được cả chất lượng
 *     bitrate / mono / Hz).
 *
 * Chỉ dùng DOM + Web Audio (cộng hai hằng số cắt của lib/audio.js, module node thuần); việc đọc file
 * do bên gọi truyền vào (loadFile) nên chạy được cả ngoài Editor để kiểm thử.
 */

// Đoạn giữ lại ngắn nhất / lệch nhỏ hơn mức này ở hai đầu thì coi như không cắt (giây): dùng đúng
// hằng số main.js áp khi cắt thật, không giữ bản sao.
const { MIN_TRIM_SECONDS, TRIM_EPSILON } = require('../../lib/audio');

/** Bấm trong khoảng này (px) quanh mốc cắt thì kéo mốc thay vì tua. */
const HANDLE_HIT = 7;
/** Quá mức này thì không giải mã để nghe thử (giữ RAM của Editor). */
const MAX_DECODE_BYTES = 64 * 1024 * 1024;

const COLORS = {
  wave: 'rgba(143, 163, 191, 0.38)',
  waveKept: '#5bd1a1',
  kept: 'rgba(91, 209, 161, 0.09)',
  cut: 'rgba(4, 7, 12, 0.5)',
  axis: 'rgba(214, 221, 232, 0.10)',
  handle: '#eeb25c',
  fade: 'rgba(238, 178, 92, 0.85)',
  playhead: '#f1f6ff',
};

let sharedContext = null;
/** Trình đang hiển thị: chỉ một cái tồn tại (và phát) tại một thời điểm. */
let current = null;

function audioContext() {
  if (!sharedContext || sharedContext.state === 'closed') {
    const Context = window.AudioContext || window.webkitAudioContext;
    sharedContext = new Context();
  }
  return sharedContext;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/** 75.5 -> "1:15.500" */
function formatTime(seconds) {
  const milliseconds = Math.round(Math.max(0, Number(seconds) || 0) * 1000);
  const minutes = Math.floor(milliseconds / 60000);
  return `${minutes}:${((milliseconds - minutes * 60000) / 1000).toFixed(3).padStart(6, '0')}`;
}

async function decode(arrayBuffer) {
  if (!arrayBuffer || !arrayBuffer.byteLength) {
    throw new Error('file rỗng');
  }
  if (arrayBuffer.byteLength > MAX_DECODE_BYTES) {
    throw new Error(`file quá lớn để nghe thử (${Math.round(arrayBuffer.byteLength / (1024 * 1024))} MB)`);
  }
  return await audioContext().decodeAudioData(arrayBuffer);
}

/** Khung HTML; mount() gắn trình nghe vào sau khi khung đã nằm trong DOM. */
function render({ id, escapeHtml }) {
  return `
    <div id="${escapeHtml(id)}" class="detail-block aud-player" tabindex="0">
      <div class="aud-player-head">
        <span class="detail-title">Nghe thử &amp; cắt</span>
        <span class="aud-source-switch">
          <button class="aud-src active" data-src="source" title="Nghe file gốc trong assets/">Gốc</button>
          <button class="aud-src" data-src="result" disabled title="Nghe bản encode thử: bấm &quot;Nghe thử kết quả&quot; ở khung Nén file này">Kết quả</button>
        </span>
      </div>
      <div class="aud-wave-wrap">
        <canvas class="aud-wave"></canvas>
        <div class="aud-wave-message">Đang tải audio...</div>
      </div>
      <div class="aud-seek" title="Bấm / kéo để tua">
        <div class="aud-seek-kept"></div>
        <div class="aud-seek-fill"></div>
        <div class="aud-seek-thumb"></div>
      </div>
      <div class="aud-transport">
        <button class="aud-btn aud-play" title="Phát / tạm dừng (Space)" disabled>▶</button>
        <button class="aud-btn aud-rewind" title="Về đầu (Home)" disabled>⏮</button>
        <span class="aud-time">0:00.000 / 0:00.000</span>
        <span class="aud-gap"></span>
        <label class="check" title="Chỉ phát đoạn giữ lại, kèm fade: nghe đúng như file sau khi cắt"><input type="checkbox" class="aud-only-kept" checked> Chỉ đoạn giữ</label>
        <label class="check" title="Phát lặp lại"><input type="checkbox" class="aud-loop"> Lặp</label>
      </div>
      <div class="aud-trim">
        <label class="field" title="Giây bắt đầu đoạn giữ lại"><span>Đầu</span><input type="number" class="aud-num aud-start" min="0" step="0.01" disabled></label>
        <button class="icon-button aud-set-start" title="Đặt đầu tại vị trí đang phát (phím [ hoặc I)" disabled>[</button>
        <label class="field" title="Giây kết thúc đoạn giữ lại"><span>Cuối</span><input type="number" class="aud-num aud-end" min="0" step="0.01" disabled></label>
        <button class="icon-button aud-set-end" title="Đặt cuối tại vị trí đang phát (phím ] hoặc O)" disabled>]</button>
        <label class="field" title="Âm lượng tăng dần từ 0 ở đầu đoạn (ms)"><span>Fade in</span><input type="number" class="aud-num aud-fade-in" min="0" step="10" value="0" disabled></label>
        <label class="field" title="Âm lượng giảm dần về 0 ở cuối đoạn (ms). Nên có khi cắt ngang lúc âm còn kêu, để khỏi nghe tiếng bụp"><span>Fade out</span><input type="number" class="aud-num aud-fade-out" min="0" step="10" value="0" disabled></label>
        <button class="chip-button aud-reset" title="Bỏ cắt, giữ nguyên cả file" disabled>Bỏ cắt</button>
      </div>
      <div class="aud-trim-summary detail-note"></div>
    </div>
  `;
}

class Player {
  /**
   * options: { loadFile: () => Promise<ArrayBuffer>, loadFallback?: () => Promise<ArrayBuffer>,
   *            onChange?: (trim) => void }
   */
  constructor(element, options) {
    this.el = element;
    this.options = options || {};
    this.onChange = typeof this.options.onChange === 'function' ? this.options.onChange : () => {};
    this.canvas = element.querySelector('.aud-wave');
    /** AudioBuffer của file gốc. */
    this.source = null;
    /** { buffer, info } của bản encode thử. */
    this.result = null;
    this.mode = 'source';
    this.duration = 0;
    /** Vị trí phát, giây trên trục thời gian của file gốc (cả khi nghe bản thử). */
    this.position = 0;
    this.trim = { start: 0, end: 0, fadeIn: 0, fadeOut: 0 };
    this.playing = null;
    this.peaks = null;
    this.drag = null;
    this.raf = 0;
    this.watchdog = 0;
    this.dpr = 1;
    this.destroyed = false;
    this.wire();
    this.ready = this.load();
  }

  $(selector) {
    return this.el.querySelector(selector);
  }

  keptOnly() {
    return this.$('.aud-only-kept').checked;
  }

  // ---------------------------------------------------------------- nạp

  async load() {
    let buffer = null;
    let failure = null;
    try {
      buffer = await decode(await this.options.loadFile());
    } catch (error) {
      failure = error;
    }
    if (!buffer && !this.destroyed && typeof this.options.loadFallback === 'function') {
      this.message('Định dạng này cần chuyển tạm sang WAV để nghe...');
      try {
        buffer = await decode(await this.options.loadFallback());
        failure = null;
      } catch (error) {
        failure = error;
      }
    }
    if (this.destroyed) {
      return;
    }
    if (!buffer) {
      this.message(`Không nghe thử được: ${(failure && failure.message) || 'không giải mã được audio'}`);
      return;
    }
    this.source = buffer;
    this.duration = buffer.duration;
    this.trim = { start: 0, end: buffer.duration, fadeIn: 0, fadeOut: 0 };
    this.position = 0;
    this.message('');
    for (const control of this.el.querySelectorAll('.aud-transport button, .aud-trim button, .aud-trim input')) {
      control.disabled = false;
    }
    this.syncInputs();
    this.resize();
    this.emit();
  }

  message(text) {
    const box = this.$('.aud-wave-message');
    box.textContent = text;
    box.classList.toggle('hidden', !text);
  }

  // ---------------------------------------------------------------- sự kiện

  wire() {
    this.$('.aud-play').addEventListener('click', () => this.toggle());
    this.$('.aud-rewind').addEventListener('click', () => this.seek(this.keptOnly() ? this.trim.start : 0));
    for (const button of this.el.querySelectorAll('.aud-src')) {
      button.addEventListener('click', () => this.setMode(button.dataset.src));
    }

    const seekBar = this.$('.aud-seek');
    this.canvas.addEventListener('pointerdown', (event) => this.pointerDown(event, true));
    seekBar.addEventListener('pointerdown', (event) => this.pointerDown(event, false));
    for (const target of [this.canvas, seekBar]) {
      target.addEventListener('pointermove', (event) => this.pointerMove(event, target));
      target.addEventListener('pointerup', (event) => this.pointerUp(event, target));
      target.addEventListener('pointercancel', (event) => this.pointerUp(event, target));
    }

    const onNumber = (selector, apply) => {
      this.$(selector).addEventListener('change', (event) => apply(Number(event.target.value)));
    };
    onNumber('.aud-start', (value) => this.setTrim({ start: value }));
    onNumber('.aud-end', (value) => this.setTrim({ end: value }));
    onNumber('.aud-fade-in', (value) => this.setTrim({ fadeIn: value / 1000 }));
    onNumber('.aud-fade-out', (value) => this.setTrim({ fadeOut: value / 1000 }));
    this.$('.aud-set-start').addEventListener('click', () => this.setTrim({ start: this.currentPosition() }));
    this.$('.aud-set-end').addEventListener('click', () => this.setTrim({ end: this.currentPosition() }));
    this.$('.aud-reset').addEventListener('click', () => this.setTrim({ start: 0, end: this.duration, fadeIn: 0, fadeOut: 0 }));
    this.$('.aud-only-kept').addEventListener('change', () => {
      if (this.playing) {
        this.play();
      }
    });

    this.el.addEventListener('keydown', (event) => this.keyDown(event));
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.$('.aud-wave-wrap'));
    }
  }

  /**
   * Space phát / dừng, [ hoặc I đặt đầu, ] hoặc O đặt cuối, ← → tua 0.1 s (Shift: 1 s), Home / End
   * về đầu / cuối. Bộ gõ Telex (Unikey...) có thể biến [ ] thành ơ ư nên nhận cả hai, và cả mã phím.
   */
  keyDown(event) {
    const tag = String(event.target && event.target.tagName || '').toUpperCase();
    if (!this.source || tag === 'INPUT' || tag === 'BUTTON' || tag === 'SELECT' || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const step = event.shiftKey ? 1 : 0.1;
    const key = String(event.key || '').toLowerCase();
    if (event.code === 'BracketLeft' || key === '[' || key === 'i' || key === 'ơ') {
      this.setTrim({ start: this.currentPosition() });
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.code === 'BracketRight' || key === ']' || key === 'o' || key === 'ư') {
      this.setTrim({ end: this.currentPosition() });
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    switch (event.key) {
      case ' ':
      case 'Spacebar':
        this.toggle();
        break;
      case 'Home':
        this.seek(this.keptOnly() ? this.trim.start : 0);
        break;
      case 'End':
        this.seek(this.keptOnly() ? this.trim.end : this.duration);
        break;
      case 'ArrowLeft':
        this.seek(this.currentPosition() - step);
        break;
      case 'ArrowRight':
        this.seek(this.currentPosition() + step);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  /** Trên waveform: gần mốc thì kéo mốc, chỗ khác thì tua. Trên thanh tiến trình: luôn tua. */
  pointerDown(event, onWave) {
    if (!this.source || event.button !== 0) {
      return;
    }
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const x = event.clientX - rect.left;
    let kind = 'seek';
    if (onWave) {
      const startX = (this.trim.start / this.duration) * rect.width;
      const endX = (this.trim.end / this.duration) * rect.width;
      const toStart = Math.abs(x - startX);
      const toEnd = Math.abs(x - endX);
      if (Math.min(toStart, toEnd) <= HANDLE_HIT) {
        kind = toEnd <= toStart ? 'end' : 'start';
      }
    }
    // Tua bằng cách kéo: tạm dừng trong lúc kéo, thả ra thì phát tiếp từ chỗ mới.
    this.drag = { kind, rect, resume: kind === 'seek' && !!this.playing };
    if (this.drag.resume) {
      this.pause();
    }
    try {
      target.setPointerCapture(event.pointerId);
    } catch (_error) {
      // Con trỏ không còn hoạt động: vẫn kéo được trong phạm vi phần tử.
    }
    this.dragTo(x);
    this.el.focus({ preventScroll: true });
    event.preventDefault();
  }

  pointerMove(event, target) {
    if (this.drag) {
      this.dragTo(event.clientX - this.drag.rect.left);
      return;
    }
    if (target === this.canvas && this.source) {
      const rect = target.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const startX = (this.trim.start / this.duration) * rect.width;
      const endX = (this.trim.end / this.duration) * rect.width;
      this.canvas.style.cursor = Math.min(Math.abs(x - startX), Math.abs(x - endX)) <= HANDLE_HIT ? 'ew-resize' : 'pointer';
    }
  }

  pointerUp(event, target) {
    const drag = this.drag;
    if (!drag) {
      return;
    }
    this.drag = null;
    try {
      target.releasePointerCapture(event.pointerId);
    } catch (_error) {
      // Đã nhả rồi.
    }
    if (drag.resume) {
      this.play();
    } else if (drag.kind !== 'seek') {
      this.emit();
      if (this.playing) {
        this.play();   // phát lại với mốc mới
      }
    }
  }

  dragTo(x) {
    const time = clamp(x / this.drag.rect.width, 0, 1) * this.duration;
    if (this.drag.kind === 'start') {
      this.setTrim({ start: time }, { live: true });
    } else if (this.drag.kind === 'end') {
      this.setTrim({ end: time }, { live: true });
    } else {
      this.position = time;
      this.draw();
    }
  }

  // ---------------------------------------------------------------- đoạn cắt

  /**
   * Đổi mốc / fade (giây). Mốc luôn cách nhau ít nhất MIN_TRIM_SECONDS; fade vào + fade ra không dài
   * quá đoạn giữ lại (bớt ở cái vừa sửa). `live`: đang kéo, chưa báo ra ngoài và chưa phát lại.
   */
  setTrim(changes, { live = false } = {}) {
    if (!this.source) {
      return;
    }
    const next = { ...this.trim };
    const has = (key) => changes[key] !== undefined && Number.isFinite(changes[key]);
    if (has('start')) {
      next.start = clamp(changes.start, 0, Math.max(0, next.end - MIN_TRIM_SECONDS));
    }
    if (has('end')) {
      next.end = clamp(changes.end, Math.min(this.duration, next.start + MIN_TRIM_SECONDS), this.duration);
    }
    if (has('fadeIn')) {
      next.fadeIn = Math.max(0, changes.fadeIn);
    }
    if (has('fadeOut')) {
      next.fadeOut = Math.max(0, changes.fadeOut);
    }
    const length = next.end - next.start;
    if (next.fadeIn + next.fadeOut > length) {
      if (has('fadeIn')) {
        next.fadeIn = Math.max(0, length - next.fadeOut);
      } else if (has('fadeOut')) {
        next.fadeOut = Math.max(0, length - next.fadeIn);
      }
      if (next.fadeIn + next.fadeOut > length) {
        const scale = length / (next.fadeIn + next.fadeOut);
        next.fadeIn *= scale;
        next.fadeOut *= scale;
      }
    }
    this.trim = next;
    this.syncInputs();
    this.draw();
    if (!live) {
      this.emit();
      if (this.playing) {
        this.play();
      }
    }
  }

  /** Đoạn cắt hiện tại (giây). `edited` = có cắt hoặc fade. */
  getTrim() {
    const { start, end, fadeIn, fadeOut } = this.trim;
    const ready = !!this.source;
    return {
      ready,
      start: round4(start),
      end: round4(end),
      fadeIn: round4(fadeIn),
      fadeOut: round4(fadeOut),
      length: round4(end - start),
      duration: this.duration,
      cutStart: ready && start > TRIM_EPSILON,
      cutEnd: ready && end < this.duration - TRIM_EPSILON,
      edited: ready && (start > TRIM_EPSILON || end < this.duration - TRIM_EPSILON || fadeIn > 0 || fadeOut > 0),
    };
  }

  emit() {
    try {
      this.onChange(this.getTrim());
    } catch (error) {
      console.error('[playable-size-inspector] audio player onChange:', error);
    }
  }

  syncInputs() {
    const { start, end, fadeIn, fadeOut } = this.trim;
    this.$('.aud-start').value = start.toFixed(3);
    this.$('.aud-end').value = end.toFixed(3);
    this.$('.aud-start').max = this.$('.aud-end').max = this.duration.toFixed(3);
    this.$('.aud-fade-in').value = String(Math.round(fadeIn * 1000));
    this.$('.aud-fade-out').value = String(Math.round(fadeOut * 1000));

    const trim = this.getTrim();
    const fades = `${trim.fadeIn > 0 ? ` · fade in ${Math.round(trim.fadeIn * 1000)} ms` : ''}${trim.fadeOut > 0 ? ` · fade out ${Math.round(trim.fadeOut * 1000)} ms` : ''}`;
    const removed = this.duration > 0 ? Math.round((1 - trim.length / this.duration) * 100) : 0;
    this.$('.aud-trim-summary').textContent = trim.edited
      ? `Giữ ${trim.start.toFixed(3)} → ${trim.end.toFixed(3)} s · còn ${trim.length.toFixed(3)} / ${this.duration.toFixed(3)} s (bớt ${removed}%)${fades}`
      : `Chưa cắt: giữ cả ${this.duration.toFixed(3)} s. Kéo hai mốc vàng trên waveform, gõ số, hoặc nhấn [ ] (hoặc I / O) khi đang nghe.`;
  }

  // ---------------------------------------------------------------- phát

  setMode(mode) {
    const next = mode === 'result' && this.result ? 'result' : 'source';
    const wasPlaying = !!this.playing;
    if (wasPlaying) {
      this.pause();
    }
    this.mode = next;
    for (const button of this.el.querySelectorAll('.aud-src')) {
      button.classList.toggle('active', button.dataset.src === next);
    }
    if (next === 'result' && (this.position < this.trim.start || this.position >= this.trim.end)) {
      this.position = this.trim.start;
    }
    this.draw();
    if (wasPlaying) {
      this.play();
    }
  }

  /**
   * Bản encode thử (ArrayBuffer của file mp3 trong temp/): giải mã, bật nguồn "Kết quả" và chuyển
   * sang nó. Trả về AudioBuffer để bên gọi giữ lại (attachResult khi thông số khớp lại).
   */
  async setResult(arrayBuffer, info = {}) {
    const buffer = await decode(arrayBuffer);
    if (this.destroyed) {
      return buffer;
    }
    this.attachResult(buffer, info);
    this.setMode('result');
    return buffer;
  }

  /** Gắn một bản thử đã giải mã vào nguồn "Kết quả" (không đổi nguồn đang nghe). */
  attachResult(buffer, info = {}) {
    this.result = { buffer, info };
    const button = this.$('.aud-src[data-src="result"]');
    button.disabled = false;
    if (info.label) {
      button.title = info.label;
    }
  }

  /** Bỏ bản thử (thông số đã đổi nên nó không còn đúng). */
  clearResult() {
    if (!this.result) {
      return;
    }
    this.result = null;
    this.$('.aud-src[data-src="result"]').disabled = true;
    if (this.mode === 'result') {
      this.setMode('source');
    }
  }

  playResult() {
    if (!this.result) {
      return;
    }
    this.setMode('result');
    this.position = this.trim.start;
    this.play();
  }

  toggle() {
    if (this.playing) {
      this.pause();
    } else {
      this.play();
    }
  }

  play() {
    if (!this.source || this.destroyed) {
      return;
    }
    const context = audioContext();
    if (context.state === 'suspended') {
      void context.resume();
    }
    this.stopNode();

    const { start, end } = this.trim;
    let buffer;
    let offset;
    let from;
    let to;
    if (this.mode === 'result' && this.result) {
      // Bản thử chỉ chứa đoạn giữ lại: thời điểm t của nó ứng với start + t trên file gốc.
      buffer = this.result.buffer;
      let relative = this.position - start;
      if (relative < 0 || relative >= buffer.duration - 0.01) {
        relative = 0;
      }
      offset = relative;
      from = start + relative;
      to = start + buffer.duration;
    } else {
      buffer = this.source;
      const low = this.keptOnly() ? start : 0;
      const high = this.keptOnly() ? end : this.duration;
      let position = this.position;
      if (position < low || position >= high - 0.01) {
        position = low;
      }
      offset = position;
      from = position;
      to = high;
    }

    const node = context.createBufferSource();
    node.buffer = buffer;
    const gain = context.createGain();
    node.connect(gain);
    gain.connect(context.destination);
    const startAt = context.currentTime + 0.03;
    if (this.mode === 'source' && this.keptOnly()) {
      this.scheduleFades(gain.gain, startAt, from);
    }
    node.start(startAt, offset, Math.max(0.001, to - from));
    node.onended = () => {
      if (this.playing && this.playing.node === node) {
        this.finished();
      }
    };
    this.playing = { node, gain, startAt, from, to };
    this.position = from;
    this.updateButtons();
    this.draw();
    this.animate();
    // requestAnimationFrame đứng khi panel không được vẽ (bị che, đổi tab dock): canh bằng timer để
    // khung bị thay trong lúc đó vẫn tắt tiếng.
    if (!this.watchdog) {
      this.watchdog = setInterval(() => {
        if (!this.el.isConnected) {
          this.destroy();
        } else if (!this.playing) {
          clearInterval(this.watchdog);
          this.watchdog = 0;
        }
      }, 400);
    }
  }

  /** Fade của đoạn giữ lại, giống afade (tuyến tính) mà ffmpeg sẽ áp. `from`: giây trên file gốc phát lúc `startAt`. */
  scheduleFades(param, startAt, from) {
    const { start, end, fadeIn, fadeOut } = this.trim;
    const at = (time) => startAt + (time - from);
    const gainAt = (time) => {
      let value = 1;
      if (fadeIn > 0 && time < start + fadeIn) {
        value = Math.min(value, (time - start) / fadeIn);
      }
      if (fadeOut > 0 && time > end - fadeOut) {
        value = Math.min(value, (end - time) / fadeOut);
      }
      return clamp(value, 0, 1);
    };
    param.cancelScheduledValues(0);
    param.setValueAtTime(gainAt(from), startAt);
    if (fadeIn > 0 && from < start + fadeIn) {
      param.linearRampToValueAtTime(gainAt(start + fadeIn), at(start + fadeIn));
    }
    if (fadeOut > 0) {
      const fadeStart = Math.max(from, end - fadeOut);
      param.setValueAtTime(gainAt(fadeStart), at(fadeStart));
      param.linearRampToValueAtTime(0, at(end));
    }
  }

  finished() {
    const done = this.playing;
    this.stopNode();
    if (this.$('.aud-loop').checked && !this.destroyed) {
      this.position = this.mode === 'source' && !this.keptOnly() ? 0 : this.trim.start;
      this.play();
      return;
    }
    if (done) {
      this.position = Math.min(done.to, this.duration);
    }
    this.updateButtons();
    this.draw();
  }

  stopNode() {
    const playing = this.playing;
    this.playing = null;
    if (!playing) {
      return;
    }
    playing.node.onended = null;
    try {
      playing.node.stop();
    } catch (_error) {
      // Đã dừng.
    }
    playing.node.disconnect();
    playing.gain.disconnect();
  }

  pause() {
    if (!this.playing) {
      return;
    }
    this.position = this.currentPosition();
    this.stopNode();
    this.updateButtons();
    this.draw();
  }

  currentPosition() {
    if (!this.playing) {
      return this.position;
    }
    const elapsed = Math.max(0, audioContext().currentTime - this.playing.startAt);
    return Math.min(this.playing.to, this.playing.from + elapsed);
  }

  seek(time) {
    if (!this.source) {
      return;
    }
    this.position = clamp(time, 0, this.duration);
    if (this.playing) {
      this.play();
    } else {
      this.draw();
    }
  }

  /** Vòng vẽ trong lúc phát; tự huỷ khi khung đã bị thay (đổi file, đổi tab). */
  animate() {
    if (this.raf) {
      return;
    }
    const step = () => {
      this.raf = 0;
      if (this.destroyed) {
        return;
      }
      if (!this.el.isConnected) {
        this.destroy();
        return;
      }
      if (!this.playing) {
        return;
      }
      this.position = this.currentPosition();
      this.draw();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  updateButtons() {
    const button = this.$('.aud-play');
    button.textContent = this.playing ? '⏸' : '▶';
    button.classList.toggle('active', !!this.playing);
  }

  // ---------------------------------------------------------------- vẽ

  resize() {
    const wrap = this.$('.aud-wave-wrap');
    if (!wrap || !wrap.clientWidth || !wrap.clientHeight) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(wrap.clientWidth * dpr);
    const height = Math.round(wrap.clientHeight * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height || this.dpr !== dpr || !this.peaks) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.dpr = dpr;
      this.computePeaks();
    }
    this.draw();
  }

  /** Đỉnh min / max mỗi cột pixel (gộp các kênh), dựng sẵn thành Path2D để vẽ lại nhanh. */
  computePeaks() {
    this.peaks = null;
    if (!this.source) {
      return;
    }
    const columns = this.canvas.width;
    const channels = [];
    for (let channel = 0; channel < this.source.numberOfChannels; channel += 1) {
      channels.push(this.source.getChannelData(channel));
    }
    const length = this.source.length;
    const perColumn = length / columns;
    const stride = Math.max(1, Math.floor(perColumn / 256));
    const lows = new Float32Array(columns);
    const highs = new Float32Array(columns);
    let loudest = 0;
    for (let x = 0; x < columns; x += 1) {
      const from = Math.floor(x * perColumn);
      const to = Math.min(length, Math.max(from + 1, Math.floor((x + 1) * perColumn)));
      let low = 0;
      let high = 0;
      for (const data of channels) {
        for (let index = from; index < to; index += stride) {
          const value = data[index];
          if (value < low) {
            low = value;
          } else if (value > high) {
            high = value;
          }
        }
      }
      lows[x] = low;
      highs[x] = high;
      loudest = Math.max(loudest, high, -low);
    }
    // Phóng file nhỏ tiếng cho dễ nhìn (tối đa x4); chỉ là hình vẽ, không đổi âm thanh.
    const boost = loudest > 0 ? Math.min(4, 0.95 / loudest) : 1;
    const middle = this.canvas.height / 2;
    const amplitude = middle - 2 * this.dpr;
    const path = new Path2D();
    for (let x = 0; x < columns; x += 1) {
      const top = middle - highs[x] * boost * amplitude;
      const bottom = middle - lows[x] * boost * amplitude;
      path.rect(x, top, 1, Math.max(this.dpr, bottom - top));
    }
    this.peaks = path;
  }

  draw() {
    this.updateTime();
    this.updateSeekBar();
    const canvas = this.canvas;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.source || !this.peaks) {
      return;
    }
    const width = canvas.width;
    const height = canvas.height;
    const dpr = this.dpr;
    const xOf = (time) => clamp(time / this.duration, 0, 1) * width;
    const startX = xOf(this.trim.start);
    const endX = xOf(this.trim.end);

    context.fillStyle = COLORS.kept;
    context.fillRect(startX, 0, endX - startX, height);
    context.fillStyle = COLORS.axis;
    context.fillRect(0, Math.floor(height / 2), width, Math.max(1, Math.round(dpr / 2)));
    context.fillStyle = COLORS.wave;
    context.fill(this.peaks);
    context.save();
    context.beginPath();
    context.rect(startX, 0, endX - startX, height);
    context.clip();
    context.fillStyle = COLORS.waveKept;
    context.fill(this.peaks);
    context.restore();
    context.fillStyle = COLORS.cut;
    context.fillRect(0, 0, startX, height);
    context.fillRect(endX, 0, width - endX, height);

    // Đường fade: âm lượng 0 ở đáy, 1 ở đỉnh.
    context.strokeStyle = COLORS.fade;
    context.lineWidth = 1.5 * dpr;
    if (this.trim.fadeIn > 0) {
      context.beginPath();
      context.moveTo(startX, height - dpr);
      context.lineTo(xOf(this.trim.start + this.trim.fadeIn), dpr);
      context.stroke();
    }
    if (this.trim.fadeOut > 0) {
      context.beginPath();
      context.moveTo(xOf(this.trim.end - this.trim.fadeOut), dpr);
      context.lineTo(endX, height - dpr);
      context.stroke();
    }

    // Hai mốc cắt dạng [ ]: vạch dọc kèm tai ở hai đầu quay vào trong đoạn giữ lại.
    context.fillStyle = COLORS.handle;
    const bar = Math.max(2, Math.round(2 * dpr));
    const tab = Math.round(7 * dpr);
    const tabHeight = Math.round(3 * dpr);
    context.fillRect(Math.round(startX), 0, bar, height);
    context.fillRect(Math.round(startX), 0, tab, tabHeight);
    context.fillRect(Math.round(startX), height - tabHeight, tab, tabHeight);
    context.fillRect(Math.round(endX) - bar, 0, bar, height);
    context.fillRect(Math.round(endX) - tab, 0, tab, tabHeight);
    context.fillRect(Math.round(endX) - tab, height - tabHeight, tab, tabHeight);

    context.fillStyle = COLORS.playhead;
    context.fillRect(Math.round(xOf(this.position) - dpr / 2), 0, Math.max(1, Math.round(dpr)), height);
  }

  updateTime() {
    const onResult = this.mode === 'result' && this.result;
    const total = onResult ? this.result.buffer.duration : this.duration;
    const position = onResult ? clamp(this.position - this.trim.start, 0, total) : this.position;
    this.$('.aud-time').textContent = `${formatTime(position)} / ${formatTime(total)}${onResult ? ' · bản thử' : ''}`;
  }

  updateSeekBar() {
    const percent = (time) => (this.duration > 0 ? clamp(time / this.duration, 0, 1) : 0) * 100;
    const kept = this.$('.aud-seek-kept');
    kept.style.left = `${percent(this.trim.start)}%`;
    kept.style.width = `${Math.max(0, percent(this.trim.end) - percent(this.trim.start))}%`;
    this.$('.aud-seek-fill').style.width = `${percent(this.position)}%`;
    this.$('.aud-seek-thumb').style.left = `${percent(this.position)}%`;
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.stopNode();
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = 0;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (current === this) {
      current = null;
    }
  }
}

/** Gắn trình nghe vào khung `id` (đã render bằng render()); huỷ trình cũ nếu có. */
function mount(root, options) {
  if (current) {
    current.destroy();
  }
  const element = root.querySelector(`#${options.id}`);
  if (!element) {
    return null;
  }
  current = new Player(element, options);
  return current;
}

/** Dừng và huỷ trình đang có (khung chi tiết đổi sang tab khác, đóng panel). */
function stopAll() {
  if (current) {
    current.destroy();
  }
}

/** Tạm dừng nhưng giữ trình nghe (panel bị ẩn rồi hiện lại vẫn dùng tiếp). */
function pauseAll() {
  if (current) {
    current.pause();
  }
}

module.exports = {
  render,
  mount,
  stopAll,
  pauseAll,
};
