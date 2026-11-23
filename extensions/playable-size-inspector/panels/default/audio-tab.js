'use strict';

/**
 * Bước Tối ưu → Âm thanh: chuyển / nén lại audio trong assets/ sang MP3 theo một kiểu nén
 * dựng sẵn (hoặc tùy chỉnh), thay thế file gốc và giữ uuid. Chọn một dòng để nghe thử, cắt bớt đầu / cuối (audio-player.js),
 * encode thử để nghe đúng kết quả rồi mới áp, trong detail pane bên phải.
 * Thông số nén chỉ có MỘT bản nháp (state.draft, như tab Model 3D): thẻ preset điền vào, hàng Tùy chỉnh và khung
 * "Nén file này" hiện / sửa chính nó (sửa tay là thẻ thành Tùy chỉnh); Nén hàng loạt, Nghe thử và áp từng file
 * cùng đọc từ đó. Riêng đoạn cắt là của từng file.
 * Mọi thao tác ghi đi qua main.js (message audio-*).
 */

const fs = require('fs/promises');
const path = require('path');
const { round, formatBytes } = require('../../lib/build-scan');
// Danh sách bitrate + bitrate mặc định (khớp playable-ads-builder) lấy từ lib/audio, không giữ bản sao.
const { BITRATE_OPTIONS_KBPS, DEFAULT_BITRATE_KBPS } = require('../../lib/audio');
const { checkSetup } = require('../../lib/setup-check');
const audioPlayer = require('./audio-player');

const PACKAGE_NAME = 'playable-size-inspector';
// v2: đổi mặc định của Mono / Ghi đè MP3 trùng tên sang bật, nên bỏ pref cũ.
const PREFS_KEY = `${PACKAGE_NAME}.audio.v2`;
/** Playable gần như luôn dùng mono: cùng bitrate thì mỗi kênh được nhiều dữ liệu hơn. */
const DEFAULT_MONO = true;
/** Build chỉ nhận MP3, nên file đổi đuôi phải đi tới nơi kể cả khi có MP3 trùng tên. */
const DEFAULT_OVERWRITE = true;
const SAMPLE_RATE_OPTIONS = [
  { value: 0, label: 'giữ nguyên' },
  { value: 44100, label: '44100 Hz' },
  { value: 32000, label: '32000 Hz' },
  { value: 22050, label: '22050 Hz' },
];
/**
 * Kiểu nén dựng sẵn: người mới chỉ chọn một thẻ thay vì 4 ô bitrate / tần số / mono / ghi đè.
 * Chọn thẻ là điền bản nháp; thẻ "Tùy chỉnh" mở các ô đó ra (ghi chú của nó là thông số đang dùng).
 */
const AUDIO_PRESETS = [
  { id: 'standard', label: 'Chuẩn playable', note: '64 kbps · mono', bitrateKbps: 64, mono: true, sampleRate: 0 },
  { id: 'small', label: 'Nhỏ nhất', note: '48 kbps · mono · 32 kHz', bitrateKbps: 48, mono: true, sampleRate: 32000 },
  { id: 'stereo', label: 'Giữ stereo', note: '96 kbps · stereo', bitrateKbps: 96, mono: false, sampleRate: 0 },
  { id: 'custom', label: 'Tùy chỉnh', note: 'bitrate, tần số, kênh' },
];

/** "48 kbps · mono · 32 kHz": cùng cách ghi với ghi chú của thẻ preset. */
function describeOptions(options) {
  const rate = options.sampleRate ? ` · ${options.sampleRate % 1000 ? (options.sampleRate / 1000).toFixed(2) : options.sampleRate / 1000} kHz` : '';
  return `${options.bitrateKbps} kbps · ${options.mono ? 'mono' : 'stereo'}${rate}`;
}

/** Thẻ dựng sẵn có đúng các thông số này (prefs cũ chưa lưu id thẻ); không có thì là "Tùy chỉnh". */
function matchPresetId(options) {
  const match = AUDIO_PRESETS.find((preset) => preset.id !== 'custom'
    && preset.bitrateKbps === options.bitrateKbps && preset.mono === options.mono && preset.sampleRate === options.sampleRate);
  return match ? match.id : 'custom';
}

/** Bản nháp thông số của tab (setup tạo ra); trước khi setup chạy thì là mặc định. */
function draftOptions(panel) {
  const draft = panel.state.audio && panel.state.audio.draft;
  return draft
    ? { bitrateKbps: draft.bitrateKbps, sampleRate: draft.sampleRate, mono: draft.mono }
    : { bitrateKbps: DEFAULT_BITRATE_KBPS, sampleRate: 0, mono: DEFAULT_MONO };
}

// ---------------------------------------------------------------- luật "đáng xử lý" (cùng lib/insights.js)

/** Nén lại giảm dưới mức này thì không đáng làm (khớp ngưỡng 2 KB của lib/insights.js). */
const MIN_SAVING_BYTES = 2 * 1024;

/** Ước lượng sau nén: thời lượng × bitrate (MP3 CBR, mono hay stereo như nhau), không lớn hơn file gốc. */
function estimateBytes(file, kbps) {
  return file.probe && file.probe.durationSeconds
    ? Math.min(file.bytes, Math.round(file.probe.durationSeconds * kbps * 1000 / 8))
    : file.bytes;
}

/** Nén lại ở `kbps` có nhỏ đi thật không: cùng luật với Việc nên làm (lib/insights.js). */
function worthReencode(file, kbps) {
  return file.bytes - estimateBytes(file, kbps) > MIN_SAVING_BYTES;
}

function isStereo(file) {
  return !!file.probe && file.probe.channels > 1;
}

/** Cao hơn mức đích quá 8 kbps (chừa sai số của bitrate đọc từ file), như lib/insights.js. */
function isHighBitrate(file, kbps) {
  return !!file.probe && file.probe.bitRateKbps > kbps + 8;
}

/**
 * Bộ lọc nhanh của danh sách. `ctx`: { flags (audioFlags), target (bitrate đích), builderKbps, hasBuild, buildInfo(file) }.
 * Stereo / bitrate cao chỉ tính khi nén lại thật sự nhỏ đi, để chip khớp với Việc nên làm.
 * `needsBuild`: chỉ có nghĩa khi đã phân tích bản build (như tab Ảnh); Trong build là mặc định như Model 3D.
 */
const AUDIO_FILTERS = [
  { id: 'build', label: 'Trong build', title: 'File có trong bản build hiện tại', needsBuild: true, test: (file, ctx) => !!ctx.buildInfo(file) },
  { id: 'todo', label: 'Nên xử lý', title: 'File có việc nên làm (xem Tổng quan → Việc nên làm): chưa MP3, stereo, bitrate cao, quá dài', test: (file, ctx) => ctx.flags.todo.has(file.url) },
  { id: 'all', label: 'Tất cả', test: () => true },
  { id: 'not-mp3', label: 'Chưa MP3', title: 'WAV / OGG / M4A...: build chỉ nhận MP3 gọn nhẹ', test: (file) => !file.isMp3 },
  { id: 'stereo', label: 'Stereo', title: 'File stereo mà nén về MP3 mono còn nhỏ đi. Cùng bitrate thì MP3 mono không nhỏ hơn stereo, nên các file đó không tính.', test: (file, ctx) => isStereo(file) && worthReencode(file, ctx.target) },
  { id: 'high', label: (ctx) => `> ${ctx.target} kbps`, title: (ctx) => `Bitrate cao hơn mức ${ctx.target} kbps${ctx.builderKbps ? ' builder dùng khi xuất' : ' playable thường dùng'}, nén lại còn nhỏ đi`, test: (file, ctx) => isHighBitrate(file, ctx.target) && worthReencode(file, ctx.target) },
  { id: 'long', label: 'Dài', title: 'Nhạc dài: giữ một vòng lặp ngắn là đủ (cắt ngay trong khung Chi tiết)', test: (file, ctx) => ctx.flags.long.has(file.url) },
  { id: 'unused', label: 'Không vào build', title: 'File không có trong bản build hiện tại: nén hay cắt cũng không đổi dung lượng build', needsBuild: true, test: (file, ctx) => !ctx.buildInfo(file) },
];

/** Kiểu MIME để thẻ <audio> nhận ra file khi nghe nhanh trên danh sách. */
const AUDIO_MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.webm': 'audio/webm' };

/** File nào "Việc nên làm" nhắc tới: { todo: Set<url>, long: Set<url> } (cùng bằng chứng với Tổng quan). */
function audioFlags(panel) {
  const todo = new Set();
  const long = new Set();
  for (const insight of panel.state.insights || []) {
    if (insight.group !== 'audio' || !insight.action) {
      continue;
    }
    for (const url of insight.action.urls || []) {
      todo.add(url);
    }
    if (insight.action.url) {
      todo.add(insight.action.url);
      long.add(insight.action.url);
    }
  }
  return { todo, long };
}

/** 12.4 s / 1:05 */
function formatDuration(seconds) {
  const value = Number(seconds) || 0;
  if (value < 60) {
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} s`;
  }
  const minutes = Math.floor(value / 60);
  return `${minutes}:${String(Math.round(value - minutes * 60)).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- nghe nhanh trên danh sách

/** Một thẻ <audio> dùng chung: đọc file thành Blob URL (không phụ thuộc đường dẫn file://). */
const quick = { audio: null, url: '', objectUrl: '', loading: false, token: 0, onChange: null };

function revokeQuickUrl() {
  if (quick.objectUrl) {
    URL.revokeObjectURL(quick.objectUrl);
    quick.objectUrl = '';
  }
}

/** Dừng nghe nhanh (panel bị ẩn, đổi bước, bấm lại nút ■). */
function stopQuickPlay() {
  quick.token += 1;
  if (quick.audio) {
    quick.audio.pause();
    quick.audio.removeAttribute('src');
  }
  revokeQuickUrl();
  const previous = quick.url;
  quick.url = '';
  quick.loading = false;
  if (previous && quick.onChange) {
    quick.onChange(previous);
  }
}

async function quickPlay(file, onChange, onError) {
  if (quick.url === file.url) {
    stopQuickPlay();
    return;
  }
  stopQuickPlay();
  // Không phát chồng lên trình nghe ở khung Chi tiết.
  audioPlayer.pauseAll();
  if (!quick.audio) {
    quick.audio = new Audio();
    quick.audio.addEventListener('timeupdate', () => {
      if (quick.url && quick.onChange) {
        quick.onChange(quick.url);
      }
    });
    quick.audio.addEventListener('ended', () => stopQuickPlay());
  }
  const token = quick.token;
  quick.onChange = onChange;
  quick.url = file.url;
  quick.loading = true;
  onChange(file.url);
  const playBuffer = async (data, mime) => {
    revokeQuickUrl();
    quick.objectUrl = URL.createObjectURL(new Blob([data], { type: mime }));
    quick.audio.src = quick.objectUrl;
    await quick.audio.play();
  };
  try {
    try {
      await playBuffer(await fs.readFile(file.fullPath), AUDIO_MIME[path.extname(file.fullPath).toLowerCase()] || '');
    } catch (error) {
      if (token !== quick.token) {
        return;
      }
      // wma... trình duyệt của panel không giải mã được: nhờ main.js chuyển tạm sang WAV.
      const response = await Editor.Message.request(PACKAGE_NAME, 'audio-preview-wav', { url: file.url });
      if (token !== quick.token) {
        return;
      }
      if (!response || !response.ok) {
        throw new Error((response && response.error) || error.message || 'không giải mã được');
      }
      await playBuffer(await fs.readFile(response.path), 'audio/wav');
    }
    if (token === quick.token) {
      quick.loading = false;
      onChange(file.url);
    }
  } catch (error) {
    if (token === quick.token) {
      stopQuickPlay();
      onError(error);
    }
  }
}

/** Ghi chú về extension đóng gói (nếu project có dùng); đọc số thật từ build task. */
function builderNote(builderAudio) {
  if (!builderAudio || !builderAudio.enabled || !builderAudio.bitrateKbps) {
    return '';
  }
  return `${builderAudio.packageName} sẽ encode lại audio ở ${builderAudio.bitrateKbps} kbps khi export,`
    + ' nên hạ bitrate nguồn thấp hơn mức đó không làm export nhỏ hơn mà chỉ giảm chất lượng.';
}

const SELECTORS = {
  panelAudio: '#panel-audio',
  audFilters: '#aud-filters',
  audPresets: '#aud-presets',
  audCustom: '#aud-custom',
  audSelectAll: '#aud-select-all',
  audSelectNone: '#aud-select-none',
  audBitrate: '#aud-bitrate',
  audMono: '#aud-mono',
  audSampleRate: '#aud-sample-rate',
  audOverwrite: '#aud-overwrite',
  audConvert: '#aud-convert',
  audSummary: '#aud-summary',
  audBuilderNote: '#aud-builder-note',
  audIssues: '#aud-issues',
  audList: '#aud-list',
  audHelp: '#aud-help',
  audHelpToggle: '#aud-help-toggle',
};

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  } catch (_error) {
    return {};
  }
}

/** Chỉ rơi về mặc định khi người dùng chưa từng chọn, để lựa chọn tắt của họ không bị ghi đè. */
function prefBool(value, fallback) {
  return value === undefined ? fallback : !!value;
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (_error) {
    // Chỉ là tiện ích nhớ lựa chọn.
  }
}

function bitrateOptionsHtml(selected, escapeHtml) {
  return BITRATE_OPTIONS_KBPS.map((value) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${escapeHtml(String(value))} kbps</option>`).join('');
}

function sampleRateOptionsHtml(selected, escapeHtml) {
  return SAMPLE_RATE_OPTIONS.map((option) => `<option value="${option.value}" ${option.value === selected ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
}

function describeProbe(probe) {
  if (!probe) {
    return '';
  }
  const channels = probe.channels === 1 ? 'mono' : probe.channels === 2 ? 'stereo' : `${probe.channels} ch`;
  return `${probe.bitRateKbps || '?'} kbps · ${channels} · ${probe.sampleRate || '?'} Hz · ${round(probe.durationSeconds || 0)} s · ${probe.codecName || ''}`;
}

async function readArrayBuffer(filePath) {
  const data = await fs.readFile(filePath);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

/** Đoạn cắt gửi cho main.js (giây); null khi không cắt. Không cắt cuối thì để main tự lấy hết file. */
function serverTrim(trim) {
  if (!trim || !trim.edited) {
    return null;
  }
  return { start: trim.cutStart ? trim.start : 0, end: trim.cutEnd ? trim.end : null, fadeIn: trim.fadeIn, fadeOut: trim.fadeOut };
}

function describeTrim(trim) {
  if (!trim || !trim.edited) {
    return '';
  }
  const fades = [
    trim.fadeIn > 0 ? `fade in ${Math.round(trim.fadeIn * 1000)} ms` : '',
    trim.fadeOut > 0 ? `fade out ${Math.round(trim.fadeOut * 1000)} ms` : '',
  ].filter(Boolean).join(', ');
  return `giữ ${trim.start.toFixed(3)} → ${trim.end.toFixed(3)} s (còn ${trim.length.toFixed(3)} / ${trim.duration.toFixed(3)} s)${fades ? `, ${fades}` : ''}`;
}

/** Khoá so sánh bản thử với thông số hiện tại: khác nhau là bản thử đã cũ. */
function trialKey(options, trim) {
  return JSON.stringify([options.bitrateKbps, options.sampleRate, !!options.mono, serverTrim(trim)]);
}

function formatPercent(after, before) {
  if (!before) {
    return '';
  }
  const value = Math.round((after / before - 1) * 100);
  return `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.abs(value)}%`;
}

// ---------------------------------------------------------------- setup

function setup(panel, helpers) {
  const $ = panel.$;
  const { escapeHtml, setStatus, onAction } = helpers;
  const prefs = loadPrefs();
  const savedDraft = {
    bitrateKbps: BITRATE_OPTIONS_KBPS.includes(prefs.bitrateKbps) ? prefs.bitrateKbps : DEFAULT_BITRATE_KBPS,
    sampleRate: SAMPLE_RATE_OPTIONS.some((option) => option.value === prefs.sampleRate) ? prefs.sampleRate : 0,
    mono: prefBool(prefs.mono, DEFAULT_MONO),
  };
  const savedPreset = AUDIO_PRESETS.find((preset) => preset.id === prefs.preset);
  const state = {
    files: [],
    /** id trong AUDIO_FILTERS; mặc định Trong build (chưa có bản build thì tạm là Tất cả, xem filterDef). */
    filter: 'build',
    selectedUrl: '',
    busy: false,
    scanned: false,
    builderAudio: null,
    player: null,
    trial: null,
    /** Bản nháp thông số nén duy nhất: { bitrateKbps, sampleRate, mono }. */
    draft: savedDraft,
    /** Thẻ đang chọn (id trong AUDIO_PRESETS); sửa tay một ô là 'custom'. Prefs cũ chưa lưu id thì suy từ thông số. */
    preset: savedPreset && (savedPreset.id === 'custom' || matchPresetId(savedDraft) === savedPreset.id)
      ? savedPreset.id
      : (prefs.customOpen ? 'custom' : matchPresetId(savedDraft)),
  };
  panel.state.audio = state;

  const collectOptions = () => ({ ...state.draft, overwriteExisting: !!$.audOverwrite.checked });
  const persist = () => savePrefs({ ...state.draft, preset: state.preset, overwriteExisting: !!$.audOverwrite.checked });

  /**
   * Bằng chứng chung cho bộ lọc + nhận xét: file "Việc nên làm" nhắc tới, bitrate đích (bitrate
   * builder encode lại khi xuất, không dùng builder thì mặc định của lib/audio) như lib/insights.js,
   * và dung lượng trong bản build đang xem (null: chưa phân tích build, hoặc file không vào build).
   */
  const ruleContext = () => {
    const builderKbps = state.builderAudio && state.builderAudio.enabled ? Number(state.builderAudio.bitrateKbps) || 0 : 0;
    const index = panel.state.buildSizeBySource || null;
    return {
      flags: audioFlags(panel),
      builderKbps,
      target: builderKbps || DEFAULT_BITRATE_KBPS,
      hasBuild: !!index,
      buildInfo: (file) => (index ? index.get(file.url) || null : null),
    };
  };

  /** Bộ lọc đang áp: chip cần bản build mà chưa phân tích build thì tạm là Tất cả (giữ lựa chọn, có build là dùng lại). */
  const filterDef = (ctx = ruleContext()) => {
    const chosen = AUDIO_FILTERS.find((filter) => filter.id === state.filter);
    return chosen && (ctx.hasBuild || !chosen.needsBuild) ? chosen : AUDIO_FILTERS.find((filter) => filter.id === 'all');
  };
  /**
   * File đang hiện theo bộ lọc, nặng nhất trước: có bản build thì theo dung lượng trong build (như lưới
   * tab Ảnh), file không vào build xếp sau cùng theo dung lượng nguồn.
   */
  const visibleFiles = () => {
    const ctx = ruleContext();
    const filter = filterDef(ctx);
    const inBuild = (file) => {
      const info = ctx.buildInfo(file);
      return info ? info.bytes : -1;
    };
    return state.files
      .filter((file) => filter.test(file, ctx))
      .sort((left, right) => (ctx.hasBuild ? inBuild(right) - inBuild(left) : 0) || right.bytes - left.bytes);
  };

  const renderPresets = () => {
    const active = state.preset;
    const { builderKbps } = ruleContext();
    // Extension đóng gói encode lại ở bitrate của nó: thấp hơn mức đó không làm bản xuất nhỏ hơn,
    // cao hơn cũng không làm bản xuất hay hơn (chỉ phình build web-mobile).
    const builderWarning = (kbps) => {
      if (builderKbps && kbps < builderKbps) {
        return `Bản xuất playable vẫn encode lại ở ${builderKbps} kbps: chỉ nhỏ hơn ở build web-mobile.`;
      }
      if (builderKbps && kbps > builderKbps) {
        return `Bản xuất playable vẫn encode lại ở ${builderKbps} kbps: bitrate cao hơn chỉ làm build web-mobile nặng hơn, bản xuất không hay hơn.`;
      }
      return '';
    };
    $.audPresets.innerHTML = AUDIO_PRESETS.map((preset) => {
      const custom = preset.id === 'custom';
      // Ghi chú của thẻ Tùy chỉnh là thông số đang dùng (cùng các ô ở hàng dưới và khung Nén file này).
      const note = custom && active === 'custom' ? describeOptions(state.draft) : preset.note;
      const title = custom
        ? [`Tự chọn ${preset.note} ở hàng dưới hoặc ở khung Nén file này (cùng một bộ thông số).`, active === 'custom' ? builderWarning(state.draft.bitrateKbps) : ''].filter(Boolean).join('\n')
        : [preset.note, builderWarning(preset.bitrateKbps)].filter(Boolean).join('\n');
      return `
        <button class="preset-card ${preset.id === active ? 'active' : ''}" data-preset="${preset.id}" title="${escapeHtml(title)}">
          <b>${escapeHtml(preset.label)}</b><small>${escapeHtml(note)}</small>
        </button>
      `;
    }).join('');
    for (const card of $.audPresets.querySelectorAll('.preset-card')) {
      card.addEventListener('click', () => applyPreset(card.dataset.preset));
    }
  };

  /** Hàng Tùy chỉnh ở thanh trên: hiện khi thẻ Tùy chỉnh đang chọn, các ô luôn mang giá trị của bản nháp. */
  const syncCustomRow = () => {
    $.audCustom.classList.toggle('hidden', state.preset !== 'custom');
    $.audBitrate.value = String(state.draft.bitrateKbps);
    $.audSampleRate.value = String(state.draft.sampleRate);
    $.audMono.checked = !!state.draft.mono;
  };

  /**
   * Ghi vào bản nháp rồi cập nhật mọi chỗ hiện nó (thẻ, hàng Tùy chỉnh, ước tính, khung Nén file này + bản thử).
   * `presetId`: thẻ vừa chọn; bỏ trống là sửa tay một ô nên thành "Tùy chỉnh" (như form của Model 3D).
   */
  const setDraft = (patch, presetId = 'custom') => {
    Object.assign(state.draft, patch);
    state.preset = presetId;
    persist();
    syncCustomRow();
    renderPresets();
    renderSummary();
    syncSourceBox(panel);
  };
  state.setDraft = setDraft;

  /** Bấm thẻ: thẻ dựng sẵn điền bản nháp, thẻ Tùy chỉnh giữ thông số đang có và mở các ô ra. */
  const applyPreset = (id) => {
    const preset = AUDIO_PRESETS.find((item) => item.id === id);
    if (!preset) {
      return;
    }
    if (preset.id === 'custom') {
      setDraft({}, 'custom');
      return;
    }
    setDraft({ bitrateKbps: preset.bitrateKbps, sampleRate: preset.sampleRate, mono: preset.mono }, preset.id);
    setStatus(`Đã chọn ${preset.label}: ${preset.note}. Nghe thử ở khung Chi tiết rồi bấm Nén (hoặc áp riêng file đó).`);
  };

  const renderFilters = () => {
    const ctx = ruleContext();
    const active = filterDef(ctx);
    // Nhãn / title của chip "> N kbps" theo bitrate đích.
    const text = (value) => (typeof value === 'function' ? value(ctx) : value || '');
    const count = (filter) => state.files.filter((file) => filter.test(file, ctx)).length;
    $.audFilters.innerHTML = AUDIO_FILTERS.filter((filter) => ctx.hasBuild || !filter.needsBuild).map((filter) => {
      const total = count(filter);
      // Tất cả và Trong build (mặc định) luôn hiện, để chip đang chọn không biến mất khi về 0.
      if (filter.id !== 'all' && filter.id !== 'build' && !total) {
        return '';
      }
      return `<button class="filter-chip ${filter.id === 'todo' ? 'chip-todo' : ''} ${active.id === filter.id ? 'active' : ''}" data-filter="${filter.id}" title="${escapeHtml(text(filter.title))}">${escapeHtml(text(filter.label))} <span>${total}</span></button>`;
    }).join('');
    for (const chip of $.audFilters.querySelectorAll('.filter-chip')) {
      chip.addEventListener('click', () => {
        state.filter = chip.dataset.filter;
        render();
        scrollToSelected();
      });
    }
  };

  /**
   * Nhận xét ngắn cho một file: chỉ những gì nên làm, không có gì thì "ổn". Stereo / bitrate cao mà
   * nén lại không nhỏ đi (cùng luật với Việc nên làm) chỉ là ghi chú mức info, không phải việc cần sửa.
   */
  const verdicts = (file, ctx) => {
    const { target, builderKbps } = ctx;
    const probe = file.probe;
    const worth = worthReencode(file, target);
    // Builder encode lại mọi audio ở bitrate của nó khi xuất (không downmix): nén nguồn chỉ làm nhỏ build web-mobile.
    const exportNote = builderKbps ? ` Bản xuất playable vẫn encode lại ở ${builderKbps} kbps nên chỉ build web-mobile nhỏ đi.` : '';
    const items = [];
    if (file.probeError) {
      items.push({ text: 'không đọc được', className: 'error', title: file.probeError });
    }
    if (!file.isMp3) {
      items.push({ text: `${path.extname(file.relativePath).slice(1).toUpperCase() || '?'} → MP3`, className: 'warn', title: 'Build chỉ nên dùng MP3: nén sẽ đổi sang MP3 (giữ uuid)' });
    }
    if (isStereo(file)) {
      items.push(worth
        ? { text: 'stereo', className: 'warn', title: `Playable gần như luôn dùng mono: nén về MP3 ${target} kbps mono còn ≈ ${formatBytes(estimateBytes(file, target))}.${exportNote}` }
        : { text: 'stereo', className: 'info', title: `Không cần xử lý: cùng bitrate thì MP3 mono không nhỏ hơn stereo, nén về ${target} kbps mono gần như không giảm dung lượng.` });
    }
    if (isHighBitrate(file, target)) {
      items.push(worth
        ? { text: `${probe.bitRateKbps} kbps`, className: 'warn', title: `Cao hơn mức ${target} kbps: nén lại còn ≈ ${formatBytes(estimateBytes(file, target))}.${exportNote}` }
        : { text: `${probe.bitRateKbps} kbps`, className: 'info', title: `Cao hơn mức ${target} kbps nhưng file ngắn: nén lại giảm chưa tới 2 KB, không cần xử lý.` });
    }
    if (ctx.flags.long.has(file.url)) {
      items.push({ text: 'dài', className: 'warn', title: 'Nhạc lặp lại được thì chỉ cần một vòng ngắn: chọn file này để cắt trong khung Chi tiết' });
    }
    if (file.targetExists) {
      items.push({
        text: 'trùng tên MP3',
        className: 'warn',
        title: $.audOverwrite.checked ? 'Đã có MP3 cùng tên: MP3 cũ sẽ bị ghi đè (reference tới nó sẽ hỏng)' : 'Đã có MP3 cùng tên: file này sẽ được bỏ qua',
      });
    }
    // Chỉ có ghi chú mức info (không có gì phải sửa) thì vẫn là "ổn".
    if (items.every((item) => item.className === 'info')) {
      items.unshift({ text: 'ổn', className: 'ok', title: probe ? describeProbe(probe) : '' });
    }
    return items;
  };

  /** Cập nhật nút ▶ / ■ và thanh tiến độ của một dòng mà không vẽ lại cả danh sách. */
  const updateQuickRow = (url) => {
    const row = [...$.audList.querySelectorAll('.aud-row')].find((element) => element.dataset.url === url);
    if (!row) {
      return;
    }
    const playing = quick.url === url;
    const button = row.querySelector('.aud-quick');
    row.classList.toggle('playing', playing);
    button.textContent = playing ? (quick.loading ? '…' : '■') : '▶';
    button.title = playing ? 'Dừng' : 'Nghe nhanh';
    const audio = quick.audio;
    const ratio = playing && audio && audio.duration > 0 ? Math.min(1, audio.currentTime / audio.duration) : 0;
    row.querySelector('.aud-progress i').style.width = `${(ratio * 100).toFixed(1)}%`;
  };

  /** Thanh hành động: chưa tick thì hướng dẫn, đã tick thì ước tính dung lượng sau nén. */
  const renderSummary = () => {
    if (!state.scanned) {
      $.audSummary.textContent = 'Đang quét audio nguồn...';
      $.audConvert.textContent = 'Nén';
      return;
    }
    const ctx = ruleContext();
    const selected = state.files.filter((file) => file.selected);
    $.audConvert.textContent = selected.length ? `Nén ${selected.length} file` : 'Nén';
    if (!selected.length) {
      const total = state.files.reduce((sum, file) => sum + file.bytes, 0);
      // Có bản build thì số chính là dung lượng trong build (như tab Ảnh), dung lượng nguồn đi kèm.
      const inBuild = ctx.hasBuild ? state.files.map((file) => ctx.buildInfo(file)).filter(Boolean) : [];
      const sizes = ctx.hasBuild
        ? `${inBuild.length} trong build: ${escapeHtml(formatBytes(inBuild.reduce((sum, info) => sum + info.bytes, 0)))} · nguồn ${escapeHtml(formatBytes(total))}`
        : escapeHtml(formatBytes(total));
      $.audSummary.innerHTML = `<b>${state.files.length} file</b> · ${sizes}. <span class="muted">Tick file để nén, chọn một file để nghe thử và cắt bớt.</span>`;
      return;
    }
    const options = collectOptions();
    const before = selected.reduce((sum, file) => sum + file.bytes, 0);
    const after = selected.reduce((sum, file) => sum + estimateBytes(file, options.bitrateKbps), 0);
    const ratio = before > 0 ? Math.round(100 * (1 - after / before)) : 0;
    const conflicts = selected.filter((file) => file.targetExists).length;
    const unused = ctx.hasBuild ? selected.filter((file) => !ctx.buildInfo(file)).length : 0;
    $.audSummary.innerHTML = `<b>Đã chọn ${selected.length} file</b> · nguồn ${escapeHtml(formatBytes(before))} → ≈ <b>${escapeHtml(formatBytes(after))}</b>`
      + (ratio > 0 ? ` <span class="delta-down">(−${ratio}%)</span>` : ' <span class="muted">(không nhỏ hơn: file sẽ giữ nguyên)</span>')
      + (conflicts ? ` · <span class="warn">${conflicts} file trùng tên MP3 có sẵn</span>` : '')
      + (unused ? ` · <span class="warn" title="Nén hay cắt các file này cũng không đổi dung lượng build">${unused} file không vào build</span>` : '');
  };

  const setBusy = (busy) => {
    state.busy = busy;
    $.audConvert.disabled = busy;
  };

  const showIssues = (issues) => {
    if (!issues || !issues.length) {
      $.audIssues.classList.add('hidden');
      $.audIssues.innerHTML = '';
      return;
    }
    $.audIssues.classList.remove('hidden');
    $.audIssues.innerHTML = issues
      .map((issue) => `<div class="issue ${escapeHtml(issue.level || 'info')}">${escapeHtml(issue.message)}</div>`)
      .join('');
  };

  /**
   * Thiếu ffmpeg: hiện đúng mục "ffmpeg" của Thiết lập còn thiếu (lib/setup-check.js) và dùng chung nút
   * của Tổng quan (helpers.runSetupAction), để hướng dẫn và cách cài chỉ có một bản: chưa có Node.js thì
   * nút là "Tải Node.js", có rồi mới là "Cài ffmpeg"; cài xong Tổng quan tự kiểm tra lại và quét lại audio.
   */
  const showMissingFfmpeg = async (toolchain) => {
    const find = (issues) => (issues || []).find((issue) => issue.id === 'ffmpeg');
    // Lúc mở panel, lần kiểm tra thiết lập chạy song song với lần quét này nên có thể chưa có kết quả.
    const issue = find(panel.state.setupIssues) || find(await checkSetup(Editor.Project.path).catch(() => []));
    if (!issue) {
      showIssues([{ level: 'error', message: toolchain.ffmpegError || 'Không tìm thấy ffmpeg.' }]);
      return;
    }
    const canRun = !!issue.action && typeof helpers.runSetupAction === 'function';
    $.audIssues.classList.remove('hidden');
    $.audIssues.innerHTML = `
      <div class="issue error">
        <b>${escapeHtml(issue.title)}.</b> ${escapeHtml(issue.detail)}
        ${canRun ? `<div class="issue-actions"><button class="action-button aud-setup-action">${escapeHtml(issue.action.label)}</button></div>` : ''}
      </div>
    `;
    const button = $.audIssues.querySelector('.aud-setup-action');
    if (button) {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await helpers.runSetupAction(issue.action);
        } finally {
          button.disabled = false;
        }
      });
    }
  };

  const render = () => {
    renderFilters();
    renderSummary();
    if (!state.files.length) {
      $.audList.classList.add('hidden');
      $.audList.innerHTML = '';
      return;
    }
    const ctx = ruleContext();
    const files = visibleFiles();
    const empty = filterDef(ctx).id === 'build'
      ? 'Bản build hiện tại không có file audio nào. Chọn "Tất cả" để xem mọi file.'
      : 'Không có file nào khớp bộ lọc này.';
    /**
     * Cột dung lượng: có bản build thì là dung lượng trong build (file không vào build ghi chữ), chưa có
     * thì là dung lượng nguồn; dung lượng nguồn luôn có trong tooltip.
     */
    const sizeCell = (file) => {
      const source = `nguồn ${formatBytes(file.bytes)}`;
      if (!ctx.hasBuild) {
        return { text: formatBytes(file.bytes), title: `Dung lượng ${source} (chưa phân tích bản build)`, className: '' };
      }
      const info = ctx.buildInfo(file);
      return info
        ? { text: formatBytes(info.bytes), title: `Trong build ${formatBytes(info.bytes)} · ${source}`, className: '' }
        : { text: 'không vào build', title: `Không có trong bản build hiện tại: nén hay cắt cũng không đổi dung lượng build · ${source}`, className: 'off' };
    };
    $.audList.classList.remove('hidden');
    // Tick hết / Bỏ tick nằm ở thanh công cụ (như Ảnh / Model 3D): cột ô tick ở đầu bảng để trống.
    $.audList.innerHTML = `
      <div class="aud-head">
        <span></span>
        <span></span>
        <span>${ctx.hasBuild ? 'File (nặng nhất trong build trước)' : 'File (nặng nhất trước)'}</span>
        <span class="num">Dài</span>
        <span class="num">${ctx.hasBuild ? 'Trong build' : 'Nguồn'}</span>
        <span>Nhận xét</span>
      </div>
      ${files.length ? '' : `<div class="detail-note tree-empty">${escapeHtml(empty)}</div>`}
      ${files.map((file) => {
        const probe = file.probe;
        const folder = file.relativePath.split('/').slice(0, -1).join('/');
        const size = sizeCell(file);
        const playing = quick.url === file.url;
        return `<div class="aud-row ${state.selectedUrl === file.url ? 'selected' : ''} ${file.selected ? 'checked' : ''} ${playing ? 'playing' : ''}" data-url="${escapeHtml(file.url)}" title="${escapeHtml(file.relativePath)}">
          <input class="aud-toggle" data-url="${escapeHtml(file.url)}" type="checkbox" ${file.selected ? 'checked' : ''}>
          <button class="aud-quick" data-url="${escapeHtml(file.url)}" title="${playing ? 'Dừng' : 'Nghe nhanh'}">${playing ? '■' : '▶'}</button>
          <div class="aud-main">
            <div class="aud-title"><span class="aud-name">${escapeHtml(file.relativePath.split('/').pop())}</span><span class="aud-folder">${escapeHtml(folder)}</span></div>
            <div class="aud-progress"><i></i></div>
            ${file.lastResult ? `<div class="aud-result">${escapeHtml(file.lastResult)}</div>` : ''}
          </div>
          <span class="aud-dur num">${probe ? escapeHtml(formatDuration(probe.durationSeconds)) : '-'}</span>
          <span class="aud-size num ${size.className}" title="${escapeHtml(size.title)}">${escapeHtml(size.text)}</span>
          <span class="aud-verdict">${verdicts(file, ctx).map((item) => `<span class="img-badge ${item.className}" title="${escapeHtml(item.title)}">${escapeHtml(item.text)}</span>`).join('')}</span>
        </div>`;
      }).join('')}
    `;

    for (const toggle of $.audList.querySelectorAll('.aud-toggle')) {
      toggle.addEventListener('click', (event) => event.stopPropagation());
      toggle.addEventListener('change', (event) => {
        const file = state.files.find((item) => item.url === event.target.dataset.url);
        if (file) {
          file.selected = !!event.target.checked;
        }
        event.target.closest('.aud-row').classList.toggle('checked', !!event.target.checked);
        renderSummary();
      });
    }
    for (const button of $.audList.querySelectorAll('.aud-quick')) {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const file = state.files.find((item) => item.url === button.dataset.url);
        if (file) {
          void quickPlay(file, updateQuickRow, (error) => setStatus(`Không phát được ${file.relativePath}: ${error.message || error}`));
        }
      });
      button.addEventListener('dblclick', (event) => event.stopPropagation());
    }
    for (const row of $.audList.querySelectorAll('.aud-row')) {
      row.addEventListener('click', () => {
        selectUrl(row.dataset.url);
        $.audList.focus({ preventScroll: true });
      });
      row.addEventListener('dblclick', () => {
        selectUrl(row.dataset.url);
        void revealSelected();
      });
    }
    if (quick.url) {
      updateQuickRow(quick.url);
    }
    // Chưa chọn file nào (hoặc file tool tự chọn đã bị lọc mất): chọn sẵn file đầu tiên để khung Chi tiết không trống.
    if (files.length && (!state.selectedUrl || (state.autoSelected && !files.some((file) => file.url === state.selectedUrl)))) {
      state.selectedUrl = files[0].url;
      state.autoSelected = true;
      $.audList.querySelector('.aud-row').classList.add('selected');
      if (panel.state.step === 'optimize' && panel.state.optimizeKind === 'audio') {
        panel.renderDetail();
      }
    }
  };
  state.refresh = render;

  /** Cuộn tới dòng đang chọn: chỉ gọi khi người dùng đổi lựa chọn / bộ lọc, không gọi khi vẽ lại nền. */
  const scrollToSelected = () => {
    const selectedRow = $.audList.querySelector('.aud-row.selected');
    if (selectedRow && typeof selectedRow.scrollIntoView === 'function') {
      selectedRow.scrollIntoView({ block: 'nearest' });
    }
  };

  const selectUrl = (url) => {
    state.selectedUrl = url;
    state.autoSelected = false;
    // Chỉ đổi dòng đang chọn: vẽ lại cả danh sách sẽ làm mất thanh tiến độ đang nghe.
    for (const row of $.audList.querySelectorAll('.aud-row')) {
      row.classList.toggle('selected', row.dataset.url === url);
    }
    scrollToSelected();
    panel.renderDetail();
  };

  const moveSelection = (direction) => {
    const files = visibleFiles();
    if (!files.length) {
      return;
    }
    const current = files.findIndex((file) => file.url === state.selectedUrl);
    const next = current < 0
      ? (direction > 0 ? 0 : files.length - 1)
      : Math.max(0, Math.min(files.length - 1, current + direction));
    selectUrl(files[next].url);
  };

  const toggleSelectedCheck = () => {
    const file = state.files.find((item) => item.url === state.selectedUrl);
    if (!file) {
      return;
    }
    file.selected = !file.selected;
    const row = $.audList.querySelector('.aud-row.selected');
    if (row) {
      row.classList.toggle('checked', file.selected);
      row.querySelector('.aud-toggle').checked = file.selected;
    }
    renderSummary();
  };

  const revealSelected = async () => {
    if (!state.selectedUrl) {
      return;
    }
    await helpers.revealAsset({ url: state.selectedUrl });
  };

  /** Từ "Việc nên làm": tick đúng các file này và chọn file đầu tiên để nghe thử. */
  state.selectOnly = (urls) => {
    const wanted = new Set(urls);
    state.filter = 'all';
    for (const file of state.files) {
      file.selected = wanted.has(file.url);
    }
    render();
    const first = visibleFiles().find((file) => file.selected);
    if (first) {
      selectUrl(first.url);
    }
    setStatus(`Đã tick ${wanted.size} file. Chọn kiểu nén ở thanh phía trên rồi bấm Nén.`);
  };

  /** Từ "Việc nên làm": mở thẳng trình nghe + cắt của một file. */
  state.focusFile = (url) => {
    if (state.files.some((file) => file.url === url)) {
      state.filter = 'all';
      render();
      selectUrl(url);
      setStatus('Kéo hai mốc vàng trên waveform để chọn đoạn giữ lại, bấm "Nghe thử kết quả" trước khi áp.');
    }
  };

  const setAll = (checked) => {
    for (const file of checked ? visibleFiles() : state.files) {
      file.selected = checked;
    }
    render();
  };

  // `silent`: quét lại sau khi convert, không ghi đè dòng status đang báo kết quả.
  const scan = async ({ keepIssues = false, silent = false } = {}) => {
    if (state.busy) {
      return;
    }
    setBusy(true);
    if (!keepIssues) {
      showIssues([]);
    }
    if (!silent) {
      setStatus('Đang quét audio nguồn...');
    }
    try {
      // buildRoot: để main đọc thiết lập audio của đúng build task đang xem (bỏ trống thì lấy task mới nhất).
      const result = await Editor.Message.request(PACKAGE_NAME, 'audio-scan', { buildRoot: panel.state.buildRoot || '' });
      if (!result || !result.ok) {
        throw new Error((result && result.error) || 'Quét thất bại.');
      }
      const previousFiles = new Map(state.files.map((file) => [file.url, file]));
      // Không tự tick khi quét (như Ảnh / Model 3D): chỉ giữ lựa chọn cũ của file còn tồn tại.
      state.files = result.files.map((file) => ({
        ...file,
        selected: previousFiles.has(file.url) && !!previousFiles.get(file.url).selected,
      }));
      state.scanned = true;
      state.builderAudio = result.builderAudio || null;
      const note = builderNote(state.builderAudio);
      $.audBuilderNote.textContent = note ? `ⓘ bản xuất encode lại ở ${state.builderAudio.bitrateKbps} kbps` : '';
      $.audBuilderNote.title = note;
      $.audBuilderNote.classList.toggle('hidden', !note);
      renderPresets();
      if (state.selectedUrl && !state.files.some((file) => file.url === state.selectedUrl)) {
        state.selectedUrl = '';
      }
      const selectedBefore = state.selectedUrl;
      render();
      // Chỉ vẽ lại khung Chi tiết khi đang mở đúng tab này; render() vừa tự chọn file đầu tiên thì đã vẽ rồi.
      if (panel.state.step === 'optimize' && panel.state.optimizeKind === 'audio' && state.selectedUrl === selectedBefore) {
        panel.renderDetail();
      }
      if (panel.onSourcesScanned) {
        panel.onSourcesScanned();
      }
      if (result.toolchain && !result.toolchain.ffmpeg) {
        void showMissingFfmpeg(result.toolchain);
      }
      if (!silent) {
        setStatus(`Quét audio nguồn xong: ${state.files.length} file.`);
      }
    } catch (error) {
      showIssues([{ level: 'error', message: error.message || String(error) }]);
      setStatus(error.message || String(error));
    } finally {
      setBusy(false);
    }
  };
  state.scan = scan;

  const convert = async () => {
    if (state.busy) {
      return;
    }
    const selected = state.files.filter((file) => file.selected);
    if (!selected.length) {
      showIssues([{ level: 'info', message: 'Hãy tick ít nhất một file.' }]);
      return;
    }
    const options = collectOptions();
    const conflicts = selected.filter((file) => file.targetExists).length;
    const reencode = selected.filter((file) => file.isMp3).length;
    const ctx = ruleContext();
    const unused = ctx.hasBuild ? selected.filter((file) => !ctx.buildInfo(file)).length : 0;
    const lines = [
      `${selected.length} file sẽ được encode sang MP3 ${options.bitrateKbps} kbps${options.mono ? ', mono' : ''}${options.sampleRate ? `, ${options.sampleRate} Hz` : ''} và THAY THẾ file gốc (giữ uuid).`,
    ];
    if (reencode) {
      lines.push(`${reencode} file MP3 sẽ nén lại tại chỗ (kết quả không nhỏ hơn thì giữ nguyên).`);
    }
    if (unused) {
      lines.push(`${unused} file không có trong bản build hiện tại: nén cũng không đổi dung lượng build.`);
    }
    if (conflicts) {
      lines.push(options.overwriteExisting
        ? `CẢNH BÁO: ${conflicts} file sẽ ghi đè lên MP3 trùng tên đang có. Asset MP3 cũ bị xoá và mọi reference trỏ tới nó sẽ hỏng.`
        : `${conflicts} file có MP3 trùng tên sẽ bị bỏ qua (chưa tick "Ghi đè MP3 trùng tên").`);
    }
    lines.push('Bản gốc được chép dự phòng vào temp/playable-size-inspector/audio-backup/. Tiếp tục?');
    if (!window.confirm(lines.join('\n'))) {
      return;
    }

    persist();
    setBusy(true);
    showIssues([]);
    setStatus(`Đang chuyển ${selected.length} file audio...`);
    try {
      const result = await Editor.Message.request(PACKAGE_NAME, 'audio-convert', {
        refs: selected.map((file) => file.url),
        ...options,
      });
      if (!result || !result.ok) {
        throw new Error((result && result.error) || 'Chuyển đổi thất bại.');
      }
      const byPath = new Map(result.results.map((item) => [item.relativePath, item]));
      // Sau khi đổi đuôi (wav -> mp3) file mới có đường dẫn = targetRelativePath.
      const byTarget = new Map(result.results.filter((item) => item.ok && item.targetRelativePath).map((item) => [item.targetRelativePath, item]));
      const describeResult = (item) => {
        if (!item.ok) {
          return `lỗi: ${item.error}`;
        }
        if (item.skipped) {
          return `bỏ qua: ${item.skipped}`;
        }
        return `xong: ${formatBytes(item.beforeBytes)} → ${formatBytes(item.afterBytes)}`;
      };

      let converted = 0;
      let skipped = 0;
      let savedBytes = 0;
      const issues = [];
      for (const file of selected) {
        const item = byPath.get(file.relativePath);
        if (!item) {
          continue;
        }
        if (!item.ok) {
          issues.push({ level: 'error', message: `${file.relativePath}: ${item.error}` });
        } else if (item.uuidChanged) {
          converted += 1;
          savedBytes += Math.max(0, item.beforeBytes - item.afterBytes);
          issues.push({ level: 'error', message: `${item.targetRelativePath}: uuid bị đổi (${item.uuidChanged.before} → ${item.uuidChanged.after || 'không thấy'}), scene / prefab đang dùng file này sẽ báo "asset missing". Hoàn tác lần nén này trong Lịch sử, hoặc tắt editor rồi trả uuid cũ vào .meta.` });
        } else if (item.skipped) {
          skipped += 1;
        } else {
          converted += 1;
          savedBytes += Math.max(0, item.beforeBytes - item.afterBytes);
        }
      }
      issues.unshift({
        level: 'info',
        message: `Hoàn tất: ${converted} đã chuyển, ${skipped} bỏ qua, ${issues.length} lỗi. Tiết kiệm ${formatBytes(savedBytes)}. Build lại để thấy hiệu quả (tool tự phân tích lại).`,
      });
      showIssues(issues);
      helpers.offerUndo(result.historyId, `Đã nén ${converted} file audio, tiết kiệm ${formatBytes(savedBytes)}.`);
      setBusy(false);
      await scan({ keepIssues: true, silent: true });
      for (const file of state.files) {
        const item = byPath.get(file.relativePath) || byTarget.get(file.relativePath);
        if (item) {
          file.lastResult = describeResult(item);
        }
      }
      render();
    } catch (error) {
      showIssues([{ level: 'error', message: error.message || String(error) }]);
      setStatus(error.message || String(error));
    } finally {
      setBusy(false);
    }
  };

  // --- wire ---
  $.audBitrate.innerHTML = bitrateOptionsHtml(state.draft.bitrateKbps, escapeHtml);
  $.audSampleRate.innerHTML = sampleRateOptionsHtml(state.draft.sampleRate, escapeHtml);
  $.audOverwrite.checked = prefBool(prefs.overwriteExisting, DEFAULT_OVERWRITE);
  syncCustomRow();
  renderPresets();
  renderSummary();

  // ↑↓ duyệt file, Space tick/bỏ tick, Enter highlight asset trong panel Assets.
  $.audList.tabIndex = 0;
  $.audList.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      toggleSelectedCheck();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      void revealSelected();
      return;
    }
    if (event.key === 'p' || event.key === 'P') {
      const file = state.files.find((item) => item.url === state.selectedUrl);
      if (file) {
        event.preventDefault();
        void quickPlay(file, updateQuickRow, (error) => setStatus(`Không phát được ${file.relativePath}: ${error.message || error}`));
      }
    }
  });

  onAction($.audHelpToggle, () => {
    const open = $.audHelp.classList.contains('hidden');
    $.audHelp.classList.toggle('hidden', !open);
    $.audHelpToggle.classList.toggle('active', open);
  });
  onAction($.audSelectAll, () => setAll(true));
  onAction($.audSelectNone, () => setAll(false));
  onAction($.audConvert, () => { void convert(); });
  // Hàng Tùy chỉnh sửa thẳng bản nháp (khung Nén file này đổi theo).
  $.audBitrate.addEventListener('change', () => setDraft({ bitrateKbps: Number($.audBitrate.value) || DEFAULT_BITRATE_KBPS }));
  $.audSampleRate.addEventListener('change', () => setDraft({ sampleRate: Number($.audSampleRate.value) || 0 }));
  $.audMono.addEventListener('change', () => setDraft({ mono: !!$.audMono.checked }));
  // Ô này đổi luôn ghi chú "sẽ bị ghi đè / sẽ bỏ qua" ở các dòng trùng tên.
  $.audOverwrite.addEventListener('change', () => { persist(); render(); });
}

// ---------------------------------------------------------------- detail pane của tab này

function renderDetail(panel, helpers) {
  const { escapeHtml } = helpers;
  const state = panel.state.audio;
  if (!state || !state.scanned) {
    panel.$.detail.className = 'detail empty';
    panel.$.detail.textContent = 'Chưa quét audio nguồn. Bấm Phân tích.';
    return;
  }
  const file = state.files.find((item) => item.url === state.selectedUrl);
  if (!file) {
    panel.$.detail.className = 'detail empty';
    panel.$.detail.textContent = 'Chọn một file để nghe thử, cắt bớt và nén riêng file đó.';
    return;
  }

  // Dung lượng trong bản build đang xem (như cột của danh sách); chưa phân tích build thì không ghi.
  const buildIndex = panel.state.buildSizeBySource;
  const buildInfo = buildIndex ? buildIndex.get(file.url) || null : null;
  const buildChip = !buildIndex
    ? ''
    : buildInfo
      ? `<span>${escapeHtml(formatBytes(buildInfo.bytes))} trong build</span>`
      : '<span class="chip-off" title="Nén hay cắt file này cũng không đổi dung lượng build">không vào build</span>';
  panel.$.detail.className = 'detail';
  panel.$.detail.innerHTML = `
    <div class="detail-body">
      ${audioPlayer.render({ id: 'detail-audio-player', escapeHtml })}
      <div class="built-file-compact">
        <div class="detail-title">Audio nguồn</div>
        <div class="built-file-path" title="${escapeHtml(file.url)}">${escapeHtml(file.relativePath)}</div>
        <div class="built-file-chips">
          ${buildChip}
          <span>${escapeHtml(`${buildIndex ? 'nguồn ' : ''}${formatBytes(file.bytes)}`)}</span>
          <span>${escapeHtml(describeProbe(file.probe) || file.probeError || '')}</span>
          ${file.isMp3 ? '' : '<span class="chip-off">chưa phải MP3</span>'}
        </div>
      </div>
      ${renderSourceBox({ source: file.url, category: 'audio' }, helpers)}
    </div>
  `;

  // Bản thử chỉ đúng cho file đang chọn.
  if (state.trial && state.trial.url !== file.url) {
    state.trial = null;
  }
  const player = audioPlayer.mount(panel.$.detail, {
    id: 'detail-audio-player',
    loadFile: () => readArrayBuffer(file.fullPath),
    // wma... trình duyệt của panel không giải mã được: nhờ main.js chuyển tạm sang WAV.
    loadFallback: async () => {
      const response = await Editor.Message.request(PACKAGE_NAME, 'audio-preview-wav', { url: file.url });
      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'không chuyển được sang WAV');
      }
      return readArrayBuffer(response.path);
    },
    onChange: () => refreshTrialState(panel),
  });
  state.player = player;
  void loadSourceBox(panel, { source: file.url, category: 'audio' }, helpers, {
    player,
    onApplied: async (response, doneNote) => {
      state.trial = null;
      // Đổi đuôi (wav -> mp3) làm url đổi theo; giữ đúng dòng đang chọn sau khi quét lại.
      const nextUrl = response && response.state && response.state.url;
      if (nextUrl) {
        state.selectedUrl = nextUrl;
      }
      if (state.scan) {
        await state.scan({ keepIssues: true, silent: true });
        const row = state.files.find((item) => item.url === state.selectedUrl);
        if (row && doneNote) {
          row.lastResult = doneNote;
          refreshList(panel);
        }
      }
    },
  });
}

/** Vẽ lại danh sách của tab (sau khi gắn ghi chú kết quả cho một dòng). */
function refreshList(panel) {
  if (panel.state.audio && typeof panel.state.audio.refresh === 'function') {
    panel.state.audio.refresh();
  }
}

// ---------------------------------------------------------------- khung "Nén file này" (dùng chung với bước Tìm chỗ nặng)

function renderSourceBox(entry, helpers) {
  const { escapeHtml } = helpers;
  const sourceUrl = String(entry.source || '').split('@')[0];
  if (entry.category !== 'audio' || !sourceUrl) {
    return '';
  }
  return `
    <div id="detail-audio-box" class="detail-block source-box" data-source-url="${escapeHtml(sourceUrl)}">
      <div class="detail-title">Nén file này</div>
      <div class="detail-note">Đang đọc file audio nguồn...</div>
    </div>
  `;
}

async function loadSourceBox(panel, entry, helpers, options = {}) {
  const sourceUrl = String(entry.source || '').split('@')[0];
  const box = panel.$.detail.querySelector('#detail-audio-box');
  if (!box || box.dataset.sourceUrl !== sourceUrl) {
    return;
  }
  const result = await Editor.Message.request(PACKAGE_NAME, 'audio-asset-state', { url: sourceUrl })
    .catch((error) => ({ ok: false, error: error.message }));
  renderSourceState(panel, entry, result, helpers, '', options);
}

function renderSourceState(panel, entry, result, helpers, note = '', options = {}) {
  const { escapeHtml, setStatus } = helpers;
  const sourceUrl = String(entry.source || '').split('@')[0];
  const box = panel.$.detail.querySelector('#detail-audio-box');
  if (!box || box.dataset.sourceUrl !== sourceUrl) {
    return;
  }
  if (!result || !result.ok) {
    box.innerHTML = `
      <div class="detail-title">Nén file này</div>
      <div class="detail-note error">${escapeHtml((result && result.error) || 'Không đọc được file audio nguồn.')}</div>
    `;
    return;
  }

  const state = result.state;
  const probe = state.probe;
  const isMp3 = String(state.url || sourceUrl).toLowerCase().endsWith('.mp3');
  // Các ô là bản nháp chung của tab (thẻ preset / hàng Tùy chỉnh), không có mặc định riêng của khung này.
  const draft = draftOptions(panel);
  // MP3 nguồn bitrate thấp hơn bản nháp: syncSourceBox nhắc là encode lại cao hơn chỉ phình file, không hay hơn.
  box.dataset.sourceKbps = String(isMp3 && probe ? Number(probe.bitRateKbps) || 0 : 0);
  // Trình nghe chỉ có ở bước Tối ưu → Âm thanh: ở đó mới cắt đoạn và encode thử trước khi áp.
  const player = options.player && !options.player.destroyed ? options.player : null;
  const defaultNote = player
    ? 'Nghe thử kết quả: encode vào temp/ để nghe và xem dung lượng, chưa đụng assets/. Áp: thay file gốc (giữ uuid), bản gốc được chép dự phòng vào temp/playable-size-inspector/audio-backup/.'
    : 'Thay thế file gốc trong assets/ (giữ uuid); bản gốc được chép dự phòng vào temp/playable-size-inspector/audio-backup/.';
  box.innerHTML = `
    <div class="detail-title">Nén file này <span class="aud-box-preset" title="Cùng một bộ thông số với thẻ nén ở thanh trên của Tối ưu → Âm thanh: sửa ô ở đây thì thẻ thành Tùy chỉnh">${escapeHtml(presetLabel(panel))}</span></div>
    <div class="built-file-chips">
      <span>${escapeHtml(formatBytes(probe ? probe.bytes : 0))}</span>
      <span>${escapeHtml(describeProbe(probe))}</span>
    </div>
    <div class="source-controls">
      <label class="field"><span>Bitrate</span>
        <select id="detail-aud-bitrate">${bitrateOptionsHtml(draft.bitrateKbps, escapeHtml)}</select>
      </label>
      <label class="field"><span>Tần số</span>
        <select id="detail-aud-sample-rate">${sampleRateOptionsHtml(draft.sampleRate, escapeHtml)}</select>
      </label>
      <label class="check"><input id="detail-aud-mono" type="checkbox" ${draft.mono ? 'checked' : ''}> Mono</label>
      ${player ? '' : `<button id="detail-aud-convert" class="action-button">${applyLabel(isMp3, null)}</button>`}
    </div>
    <div class="detail-note aud-box-warn hidden"></div>
    ${player ? `
      <div class="source-controls">
        <button id="detail-aud-trial" class="action-button trial" title="Encode thử với đúng thông số trên (kể cả đoạn cắt) vào temp/ để nghe và xem dung lượng. Chưa đụng tới assets/.">Nghe thử kết quả</button>
        <button id="detail-aud-convert" class="action-button">${applyLabel(isMp3, player.getTrim())}</button>
      </div>
      <div id="detail-aud-trial-line" class="aud-trial hidden"></div>
    ` : ''}
    <div class="detail-note">${escapeHtml(note || `${defaultNote} ${builderNote(panel.state.audio && panel.state.audio.builderAudio)}`.trim())}</div>
  `;

  // Sửa ô ở đây là sửa bản nháp chung (thẻ thành Tùy chỉnh); setDraft gọi lại syncSourceBox -> refreshTrialState.
  const editDraft = (patch) => {
    if (panel.state.audio && typeof panel.state.audio.setDraft === 'function') {
      panel.state.audio.setDraft(patch);
    }
  };
  box.querySelector('#detail-aud-bitrate').addEventListener('change', (event) => editDraft({ bitrateKbps: Number(event.target.value) || DEFAULT_BITRATE_KBPS }));
  box.querySelector('#detail-aud-sample-rate').addEventListener('change', (event) => editDraft({ sampleRate: Number(event.target.value) || 0 }));
  box.querySelector('#detail-aud-mono').addEventListener('change', (event) => editDraft({ mono: !!event.target.checked }));
  if (player) {
    wireTrial(panel, box, { sourceUrl, player, helpers });
    renderTrialLine(panel, box, helpers);
  }
  syncSourceBox(panel);

  box.querySelector('#detail-aud-convert').addEventListener('click', async () => {
    const options2 = draftOptions(panel);
    const trim = player ? player.getTrim() : null;
    if (player && !trim.ready) {
      showTrialMessage(box, 'Audio chưa tải xong, đợi một chút rồi bấm lại.', true);
      return;
    }
    const cut = serverTrim(trim);
    const audioState = panel.state.audio;
    const trial = audioState && audioState.trial && audioState.trial.url === sourceUrl && audioState.trial.key === trialKey(options2, trim)
      ? audioState.trial.response
      : null;
    const lines = [`${cut ? (isMp3 ? 'Cắt + nén lại' : 'Cắt + chuyển sang MP3') : (isMp3 ? 'Nén lại' : 'Chuyển sang MP3')} ${sourceUrl}`];
    if (cut) {
      lines.push(`Đoạn cắt: ${describeTrim(trim)}.`);
    }
    lines.push(`${options2.bitrateKbps} kbps${options2.mono ? ', mono' : ''}${options2.sampleRate ? `, ${options2.sampleRate} Hz` : ''}.`);
    if (trial) {
      lines.push(`Bản thử vừa nghe: ${formatBytes(trial.beforeBytes)} → ${formatBytes(trial.afterBytes)} (${formatPercent(trial.afterBytes, trial.beforeBytes)}); file áp vào sẽ giống hệt.`);
    }
    lines.push('File gốc sẽ bị thay thế (giữ uuid); bản gốc được chép dự phòng vào temp/playable-size-inspector/audio-backup/. Tiếp tục?');
    if (!window.confirm(lines.join('\n'))) {
      return;
    }
    if (player) {
      player.pause();
    }
    for (const button of box.querySelectorAll('#detail-aud-convert, #detail-aud-trial')) {
      button.disabled = true;
    }
    setStatus(`Đang encode ${sourceUrl}...`);
    const send = (overwriteExisting) => Editor.Message.request(PACKAGE_NAME, 'audio-convert-asset', { url: sourceUrl, ...options2, trim: cut, overwriteExisting })
      .catch((error) => ({ ok: false, error: error.message }));
    // Không ghi đè MP3 trùng tên (asset khác) khi chưa hỏi: lần đầu luôn gửi false, bị bỏ qua vì trùng tên thì mới hỏi.
    let response = await send(false);
    if (response && response.ok && response.result && response.result.skipped && /trùng tên/.test(response.result.skipped)) {
      const target = response.result.targetRelativePath || '';
      if (window.confirm(`CẢNH BÁO: đã có ${target} là một asset MP3 khác. Ghi đè thì asset MP3 cũ bị xoá và mọi scene / prefab trỏ tới nó sẽ báo "asset missing" (bản cũ được chép dự phòng). Vẫn ghi đè?`)) {
        setStatus(`Đang encode ${sourceUrl}...`);
        response = await send(true);
      }
    }
    if (!response || !response.ok) {
      renderSourceState(panel, entry, { ok: true, state }, helpers, '', options);
      const current = panel.$.detail.querySelector('#detail-audio-box');
      if (current) {
        current.insertAdjacentHTML('beforeend', `<div class="detail-note error">${escapeHtml((response && response.error) || 'Thất bại.')}</div>`);
      }
      setStatus((response && response.error) || 'Encode thất bại.');
      return;
    }
    const item = response.result;
    const uuidError = item.uuidChanged
      ? `uuid bị đổi (${item.uuidChanged.before} → ${item.uuidChanged.after || 'không thấy'}), scene / prefab đang dùng file này sẽ báo "asset missing". Hoàn tác lần này trong Lịch sử, hoặc tắt editor rồi trả uuid cũ vào .meta.`
      : '';
    const doneNote = item.skipped
      ? `Bỏ qua: ${item.skipped}.`
      : `Xong${item.trim ? `, cắt còn ${round(item.trim.length)} s` : ''}: ${formatBytes(item.beforeBytes)} → ${formatBytes(item.afterBytes)}. Bản gốc: ${item.backupPath}. Build lại để thấy hiệu quả (tool tự phân tích lại).`;
    if (item.changedExtension && response.state && response.state.url) {
      entry.source = response.state.url;
      box.dataset.sourceUrl = response.state.url;
    }
    renderSourceState(panel, entry, { ok: true, state: response.state && response.state.probe ? response.state : state }, helpers, doneNote, { ...options, player: null });
    if (typeof options.onApplied === 'function') {
      options.onApplied(response, doneNote);
    }
    if (uuidError) {
      const current = panel.$.detail.querySelector('#detail-audio-box');
      if (current) {
        current.insertAdjacentHTML('beforeend', `<div class="detail-note error">${escapeHtml(uuidError)}</div>`);
      }
      helpers.offerUndo(response.historyId, `${sourceUrl}: ${uuidError}`);
      return;
    }
    helpers.offerUndo(response.historyId, `${sourceUrl}: ${doneNote}`);
  });
}

function applyLabel(isMp3, trim) {
  if (trim && trim.edited) {
    return isMp3 ? 'Cắt + nén lại' : 'Cắt + chuyển MP3';
  }
  return isMp3 ? 'Nén lại' : 'Chuyển sang MP3';
}

/** Tên thẻ đang chọn ở thanh trên, ghi cạnh tiêu đề khung "Nén file này". */
function presetLabel(panel) {
  const id = (panel.state.audio && panel.state.audio.preset) || 'custom';
  const preset = AUDIO_PRESETS.find((item) => item.id === id) || AUDIO_PRESETS[AUDIO_PRESETS.length - 1];
  return preset.label;
}

/**
 * Khung "Nén file này" đang mở (bước Tối ưu hay Tìm chỗ nặng) theo bản nháp: giá trị các ô, tên thẻ,
 * lời nhắc MP3 nguồn bitrate thấp; rồi trạng thái bản thử (thông số khác lúc encode thử là bản thử cũ).
 * Cập nhật tại chỗ, không vẽ lại khung để trình nghe giữ nguyên đoạn cắt.
 */
function syncSourceBox(panel) {
  const box = panel.$.detail && panel.$.detail.querySelector('#detail-audio-box');
  const bitrate = box && box.querySelector('#detail-aud-bitrate');
  if (!bitrate) {
    return;
  }
  const draft = draftOptions(panel);
  bitrate.value = String(draft.bitrateKbps);
  box.querySelector('#detail-aud-sample-rate').value = String(draft.sampleRate);
  box.querySelector('#detail-aud-mono').checked = !!draft.mono;
  const tag = box.querySelector('.aud-box-preset');
  if (tag) {
    tag.textContent = presetLabel(panel);
  }
  const warn = box.querySelector('.aud-box-warn');
  const sourceKbps = Number(box.dataset.sourceKbps) || 0;
  if (warn) {
    const low = sourceKbps > 0 && sourceKbps + 8 < draft.bitrateKbps;
    warn.classList.toggle('hidden', !low);
    warn.textContent = low
      ? `MP3 nguồn chỉ ${sourceKbps} kbps, thấp hơn ${draft.bitrateKbps} kbps đang chọn: nén lại không hay hơn mà còn không nhỏ đi (không cắt thì file được giữ nguyên).`
      : '';
  }
  refreshTrialState(panel);
}

/** "Nghe thử kết quả": encode vào temp/ với đúng thông số + đoạn cắt, nạp vào trình nghe rồi phát luôn. */
function wireTrial(panel, box, { sourceUrl, player, helpers }) {
  const { setStatus } = helpers;
  const button = box.querySelector('#detail-aud-trial');
  button.addEventListener('click', async () => {
    const audioState = panel.state.audio;
    const trim = player.getTrim();
    if (!trim.ready) {
      showTrialMessage(box, 'Audio chưa tải xong, đợi một chút rồi bấm lại.', true);
      return;
    }
    const options = draftOptions(panel);
    button.disabled = true;
    button.textContent = 'Đang encode thử...';
    setStatus(`Đang encode thử ${sourceUrl}...`);
    const response = await Editor.Message.request(PACKAGE_NAME, 'audio-preview-encode', { url: sourceUrl, ...options, trim: serverTrim(trim) })
      .catch((error) => ({ ok: false, error: error.message }));
    if (!box.isConnected || player.destroyed) {
      return;
    }
    button.disabled = false;
    button.textContent = 'Nghe thử kết quả';
    if (!response || !response.ok) {
      showTrialMessage(box, `Encode thử thất bại: ${(response && response.error) || 'không rõ lỗi'}`, true);
      setStatus('Encode thử thất bại.');
      return;
    }
    const trial = { url: sourceUrl, key: trialKey(options, trim), response, buffer: null, label: `Bản thử ${formatBytes(response.afterBytes)}` };
    audioState.trial = trial;
    try {
      trial.buffer = await player.setResult(await readArrayBuffer(response.path), { label: trial.label });
    } catch (error) {
      showTrialMessage(box, `Không phát được bản thử: ${error.message || error}`, true);
      return;
    }
    if (!box.isConnected || player.destroyed) {
      return;
    }
    renderTrialLine(panel, box, helpers);
    if (player.result) {
      player.playResult();
    }
    setStatus(`Bản thử ${sourceUrl}: ${formatBytes(response.beforeBytes)} → ${formatBytes(response.afterBytes)} (${formatPercent(response.afterBytes, response.beforeBytes)}).`);
  });
}

/** Dòng kết quả của bản thử (dung lượng, thông tin, nút nghe lại). */
function renderTrialLine(panel, box, helpers) {
  const { escapeHtml } = helpers;
  const line = box.querySelector('#detail-aud-trial-line');
  const audioState = panel.state.audio;
  const trial = audioState && audioState.trial;
  if (!line || !trial || trial.url !== box.dataset.sourceUrl) {
    return;
  }
  const response = trial.response;
  line.classList.remove('hidden', 'error');
  line.innerHTML = `
    <div class="aud-trial-main">
      <span class="aud-trial-label">Bản thử</span>
      <span class="${response.afterBytes < response.beforeBytes ? 'delta-down' : 'delta-up'}">${escapeHtml(formatBytes(response.beforeBytes))} → ${escapeHtml(formatBytes(response.afterBytes))} (${escapeHtml(formatPercent(response.afterBytes, response.beforeBytes))})</span>
      <button class="chip-button aud-trial-play" title="Nghe bản thử từ đầu">▶ Nghe</button>
    </div>
    <div class="aud-trial-info">${escapeHtml(describeProbe(response.probe))}</div>
    <div class="aud-trial-note"></div>
  `;
  line.querySelector('.aud-trial-play').addEventListener('click', () => {
    const player = audioState.player;
    if (player && !player.destroyed && player.result) {
      player.playResult();
    }
  });
  refreshTrialState(panel);
}

function showTrialMessage(box, text, isError) {
  const line = box.querySelector('#detail-aud-trial-line');
  if (!line) {
    return;
  }
  line.classList.remove('hidden', 'stale');
  line.classList.toggle('error', !!isError);
  line.textContent = text;
}

/**
 * Nhãn nút áp theo đoạn cắt, và trạng thái bản thử: bitrate / Hz / mono / đoạn cắt đã khác lúc
 * encode thử thì bản thử bị bỏ khỏi trình nghe và dòng kết quả mờ đi kèm lời nhắc.
 */
function refreshTrialState(panel) {
  const box = panel.$.detail.querySelector('#detail-audio-box');
  const audioState = panel.state.audio;
  const player = audioState && audioState.player;
  if (!box || !player || player.destroyed || !player.el.isConnected || !box.querySelector('#detail-aud-trial')) {
    return;
  }
  const trim = player.getTrim();
  const isMp3 = String(box.dataset.sourceUrl || '').toLowerCase().endsWith('.mp3');
  box.querySelector('#detail-aud-convert').textContent = applyLabel(isMp3, trim);

  const line = box.querySelector('#detail-aud-trial-line');
  const trial = audioState.trial;
  const note = line && line.querySelector('.aud-trial-note');
  if (!note || !trial || trial.url !== box.dataset.sourceUrl) {
    return;
  }
  const stale = trial.key !== trialKey(draftOptions(panel), trim);
  const response = trial.response;
  line.classList.toggle('stale', stale);
  if (stale) {
    note.textContent = 'Đã đổi thông số: bấm "Nghe thử kết quả" lại để nghe đúng bản sẽ áp.';
    player.clearResult();
    return;
  }
  // Thông số khớp lại với bản thử (đổi rồi đổi về): gắn lại để nghe được tiếp.
  if (!player.result && trial.buffer) {
    player.attachResult(trial.buffer, { label: trial.label });
  }
  note.textContent = isMp3 && !trim.edited && response.afterBytes >= response.beforeBytes
    ? 'Không nhỏ hơn file gốc: Nén lại sẽ giữ nguyên file.'
    : '';
}

module.exports = {
  stopQuickPlay,
  SELECTORS,
  setup,
  renderDetail,
  renderSourceBox,
  loadSourceBox,
};
