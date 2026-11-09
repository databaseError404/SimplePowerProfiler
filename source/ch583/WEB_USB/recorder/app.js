/**
 * Страница-рекордер с просмотром (Этапы 3–4): Web Serial → Worker (парсер, хранилище, LOD, рендер).
 *
 * Никакого backend: статическая страница, данные не покидают браузер (CSP `connect-src 'none'`).
 *
 * Роли:
 *   главный поток — порт (Web Serial доступен только в окне), команды протокола, интерфейс,
 *                   ввод (zoom/pan/курсор) и вывод готового ImageBitmap;
 *   воркер        — парсер, PairStore, LOD-пирамида, метрики и отрисовка в OffscreenCanvas.
 * Так стоимость кадра зависит от числа пикселей, а не от длины записи, и запись не зависит
 * от просмотра.
 */

import { CMD } from './parser.js';
import { defaultCalibration } from './recordfile.js';

const $ = (id) => document.getElementById(id);

const state = {
  port: null,
  reader: null,
  writer: null,
  reading: false,
  recording: false,
  streaming: false,
  fileHandle: null,
  stats: null,
  cfg: { timeUs: 84, clkKhz: 1300, pktcnt: 20, shuntOhm: 1, groupBytes: 7 },
  device: {},
  statusTimer: null,
  viewState: { width: 800, height: 420, dpr: window.devicePixelRatio || 1, overlay: false, showDio: true,
               showPoints: true, showRange: true, showGrid: true },
  dragging: null,
  followLatest: true,
  lastFrame: null,
  frameTimes: [],
  source: 'live',
};

const SPEEDS = [
  { index: 0, us: 50, label: '50 мкс (20 000 преобр/с → 10 000 пар/с)' },
  { index: 1, us: 84, label: '84 мкс (11 905 → 5 952 пары/с)' },
  { index: 2, us: 150, label: '150 мкс' },
  { index: 3, us: 280, label: '280 мкс' },
  { index: 4, us: 540, label: '540 мкс' },
  { index: 5, us: 1052, label: '1052 мкс' },
  { index: 6, us: 2074, label: '2074 мкс' },
  { index: 7, us: 4120, label: '4120 мкс' },
];

function log(text, cls = '') {
  const el = $('log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = new Date().toLocaleTimeString() + '  ' + text;
  el.appendChild(line);
  while (el.childElementCount > 300) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}
const logErr = (t) => log(t, 'err');

const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d));

// ---------------------------------------------------------------- воркер
const worker = new Worker('./worker.js', { type: 'module' });
worker.onerror = (e) => logErr(`воркер не загрузился: ${e.message || e.type || 'ошибка'} `
  + `(${e.filename || '?'}:${e.lineno || '?'})`);
worker.onmessageerror = (e) => logErr('сообщение воркера не разобрано: ' + e);
// Стартовая инициализация воркера: нужна и для просмотра открытого файла/демо-данных
// (при старте записи конфигурация пересоздаётся заново — см. startRecording).
worker.postMessage({ type: 'init', cfg: state.cfg, calib: defaultCalibration(state.cfg.shuntOhm) });
const canvas = $('chart');
const ctx2d = canvas.getContext('2d');

worker.onmessage = (ev) => {
  const m = ev.data;
  switch (m.type) {
    case 'ready':
      log('воркер готов (потоковая запись: ' + (m.caps.fileSystem ? 'да' : 'нет')
        + ', OffscreenCanvas: ' + (m.caps.offscreen ? 'да' : 'нет') + ')');
      // ?demo=1 — показать синтетическую запись (только после готовности воркера)
      if (new URLSearchParams(location.search).has('demo') && !state.demoRequested) {
        state.demoRequested = true;
        worker.postMessage({ type: 'demo', seconds: 5 });
        log('демо-данные: 5 с при 10 000 пар/с');
      }
      break;
    case 'stats':
      state.stats = m.stats;
      renderStats();
      break;
    case 'frame':
      drawFrame(m);
      break;
    case 'frame-empty':
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      break;
    case 'metrics':
      renderMetrics(m);
      break;
    case 'sample':
      renderSample(m.sample);
      break;
    case 'frame-cmd':
      onDeviceFrame(m.cmd, m.payload);
      break;
    case 'progress':
      $('progress').textContent = `построение LOD: ${Math.round((m.done / m.total) * 100)} %`;
      break;
    case 'file-opened':
      $('progress').textContent = '';
      log(`запись открыта: ${m.length.toLocaleString('ru-RU')} пар`
        + (m.truncatedTail ? ` (файл обрезан, хвост ${m.truncatedTail})` : ''));
      state.source = 'file';
      $('stSource').textContent = 'открытый файл';
      break;
    case 'started':
      state.recording = true;
      state.source = 'live';
      $('butStart').disabled = true;
      $('butStop').disabled = false;
      $('stSource').textContent = 'живая запись';
      log('запись начата');
      break;
    case 'finished':
      log('запись остановлена: ' + m.stats.pairs + ' пар'
        + (m.bytesWritten != null ? ', в файл записано ' + m.bytesWritten + ' Б' : ''));
      renderStats();
      break;
    case 'blob': {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(m.blob);
      a.download = suggestName(m.pairs);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      log('файл сохранён: ' + a.download + ' (' + m.pairs + ' пар)');
      break;
    }
    case 'reset-ok':
      state.source = 'live';
      $('stSource').textContent = 'живая запись';
      break;
    case 'log':
      log(m.text);
      break;
    case 'error':
      logErr('воркер: ' + m.message);
      break;
    default:
      break;
  }
};

function suggestName(pairs) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const base = `pp-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return pairs ? `${base}-${pairs}p.pprec` : `${base}.pprec`;
}

/** Вывод готового кадра из воркера. */
function drawFrame(m) {
  ctx2d.setTransform(1, 0, 0, 1, 0, 0);
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  ctx2d.drawImage(m.bitmap, 0, 0, canvas.width, canvas.height);
  m.bitmap.close?.();
  state.lastFrame = m.stats;
  const view = m.stats.pairsPerColumn;
  $('stView').textContent = m.stats.dots
    ? `точки отсчётов (1 пара = ${(1 / view).toFixed(1)} px)`
    : (m.stats.exact ? `точный (1 пара/колонка)` : `прорежено: ${view.toFixed(1)} пар/колонка`);
  const now = performance.now();
  state.frameTimes.push(now);
  while (state.frameTimes.length && now - state.frameTimes[0] > 1000) state.frameTimes.shift();
  $('stFrame').textContent = `${m.stats.totalMs.toFixed(2)} мс (${state.frameTimes.length} кадр/с)`;
  $('stWindow').textContent = formatWindow(m.viewport);
}

function formatWindow(vp) {
  if (!vp) return '—';
  return `${vp.startTime.toFixed(3)}…${vp.endTime.toFixed(3)} с `
    + `(${(vp.span / 1000).toFixed(1)} тыс. пар)`;
}

// ---------------------------------------------------------------- протокол
function buildCfgPacket(cfg) {
  const idx = SPEEDS.findIndex((s) => s.us === cfg.timeUs);
  const ct = idx < 0 ? 1 : idx;
  const adc = (0xB << 12) | (ct << 3) | (ct << 6) | (ct << 9);
  const init = [
    [0x80, 0x00, 0xC000], [0x80, 0x0B, 0x4000], [0x80, 0x00, 0x0000], [0x80, 0x01, adc],
  ];
  const rd = [[0x80, 0x05], [0x80, 0x04], [0, 0], [0, 0]];
  const slp = [[0x80, 0x01, 0x0000], [0, 0, 0]];
  const p = new Uint8Array(40);
  p[0] = 38; p[1] = CMD.CFG;
  p[2] = cfg.pktcnt; p[3] = 0;
  p[4] = cfg.timeUs & 0xFF; p[5] = cfg.timeUs >> 8;
  p[6] = cfg.clkKhz & 0xFF; p[7] = cfg.clkKhz >> 8;
  let off = 8;
  for (const [a, r, d] of init) { p[off++] = a; p[off++] = r; p[off++] = d & 0xFF; p[off++] = d >> 8; }
  for (const [a, r] of rd) { p[off++] = a; p[off++] = r; }
  for (const [a, r, d] of slp) { p[off++] = a; p[off++] = r; p[off++] = d & 0xFF; p[off++] = d >> 8; }
  return p;
}

const pending = new Map();

function onDeviceFrame(cmd, payload) {
  const p = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (cmd === CMD.VER && p.length >= 4) {
    state.device.dev_id = p[0] | (p[1] << 8);
    state.device.ver = p[2] | (p[3] << 8);
    $('devInfo').textContent = `DevID 0x${state.device.dev_id.toString(16)} Ver 0x${state.device.ver.toString(16)}`;
  }
  const w = pending.get(cmd & 0x7F);
  if (w) {
    clearTimeout(w.timer);
    pending.delete(cmd & 0x7F);
    w.resolve({ cmd, payload: p });
  }
}

const writeRaw = (bytes) => state.writer.write(bytes);

function sendCmd(bytes, expect, timeoutMs = 1500, retries = 2) {
  return new Promise((resolve) => {
    const key = expect & 0x7F;
    let attempt = 0;
    const tryOnce = () => {
      attempt++;
      const timer = setTimeout(() => {
        pending.delete(key);
        if (attempt <= retries) {
          logErr(`нет ответа на команду 0x${key.toString(16)} — повтор ${attempt}`);
          tryOnce();
        } else resolve(null);
      }, timeoutMs);
      pending.set(key, { resolve, timer });
      writeRaw(bytes).catch((e) => logErr('запись в порт: ' + e));
    };
    tryOnce();
  });
}

// ---------------------------------------------------------------- порт
async function connect() {
  if (!('serial' in navigator)) {
    logErr('Web Serial недоступен: нужен Chrome/Edge и https:// или localhost');
    return;
  }
  try {
    state.port = await navigator.serial.requestPort();
    await state.port.open({ baudRate: 115200 });
    state.writer = state.port.writable.getWriter();
    state.reader = state.port.readable.getReader();
    $('butConnect').value = 'Отключить';
    $('butStart').disabled = false;
    log('порт открыт (DTR включён → прибор подаёт питание на INA228)');
    state.reading = true;
    readLoop();
    await sendCmd(new Uint8Array([0, CMD.VER]), CMD.VER);
    await sendCmd(new Uint8Array([2, CMD.GRG, 0x80, 0xFE]), CMD.GRG);
    await sendCmd(new Uint8Array([2, CMD.GRG, 0x80, 0xFF]), CMD.GRG);
    // версия протокола (есть только в прошивке с правками Этапа 2): без повторов,
    // чтобы старую прошивку не засыпать сообщениями о таймауте
    const pver = await sendCmd(new Uint8Array([0, CMD.PVER]), CMD.PVER, 800, 0);
    if (pver) {
      const [ver, flags, maxPkt] = pver.payload;
      state.proto = ver;
      log(`протокол: версия ${ver}, признаки 0x${flags.toString(16)}, безопасный pktcnt ≤ ${maxPkt}`);
    } else {
      state.proto = 1;
      log('прошивка без CMD_DEV_PVER (версия протокола 1): счётчики потерь кольца недоступны');
    }
  } catch (e) {
    logErr('не удалось открыть порт: ' + e);
  }
}

async function disconnect() {
  try {
    await stopRecording(true);
    state.reading = false;
    if (state.reader) { await state.reader.cancel(); state.reader.releaseLock(); state.reader = null; }
    if (state.writer) { state.writer.releaseLock(); state.writer = null; }
    await state.port.close();
    state.port = null;
    $('butConnect').value = 'Подключить';
    $('butStart').disabled = true;
    log('порт закрыт');
  } catch (e) {
    logErr('ошибка закрытия: ' + e);
  }
}

async function readLoop() {
  const reader = state.reader;
  try {
    while (state.reading) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;
      const buf = (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength)
        ? value.buffer : value.slice().buffer;
      worker.postMessage({ type: 'bytes', buffer: buf }, [buf]);
    }
  } catch (e) {
    if (state.reading) logErr('чтение порта прервано: ' + e);
  }
}

// ---------------------------------------------------------------- запись
async function startRecording() {
  if (!state.port) { logErr('сначала подключите прибор'); return; }
  const pktcnt = Number($('pktcnt').value);
  if (pktcnt % 2 !== 0 || pktcnt < 2 || pktcnt > 34) {
    logErr('pktcnt должен быть чётным и не больше 34 (иначе прошивка выходит за буфер — Этап 2)');
    return;
  }
  state.cfg = {
    timeUs: Number($('speed').value),
    clkKhz: Number($('clk').value),
    pktcnt,
    shuntOhm: Number($('shunt').value),
    groupBytes: 7,
  };
  state.streaming = $('toFile').checked && typeof window.showSaveFilePicker === 'function';
  worker.postMessage({ type: 'init', cfg: state.cfg, calib: defaultCalibration(state.cfg.shuntOhm) });
  await new Promise((r) => setTimeout(r, 50));

  if (state.streaming) {
    try {
      state.fileHandle = await window.showSaveFilePicker({
        suggestedName: suggestName(null),
        types: [{ description: 'Запись PowerProfiler', accept: { 'application/octet-stream': ['.pprec'] } }],
      });
      worker.postMessage({ type: 'file-handle', handle: state.fileHandle });
      await new Promise((r) => setTimeout(r, 100));
    } catch (e) {
      logErr('файл не выбран — запись пойдёт в память: ' + e);
      state.streaming = false;
    }
  }

  worker.postMessage({ type: 'start', device: state.device });
  await sendCmd(new Uint8Array([1, CMD.FRD, 2]), CMD.FRD);
  const resp = await sendCmd(buildCfgPacket(state.cfg), CMD.CFG);
  if (!resp) { logErr('прибор не подтвердил конфигурацию'); return; }
  if (resp.cmd & CMD.ERR_FLAG) {
    logErr('прибор отверг конфигурацию (для 50 мкс нужен clk ≥ 1400 кГц)');
    return;
  }
  const p = resp.payload;
  log(`конфигурация принята: pktcnt=${p[0]} time=${p[2] | (p[3] << 8)} мкс clk=${p[4] | (p[5] << 8)} кГц`);
  log(`ожидаемая частота пар: ${(1e6 / (2 * state.cfg.timeUs)).toFixed(1)} пар/с, шунт ${state.cfg.shuntOhm} Ом`);

  state.statusTimer = setInterval(() => {
    if (state.recording) sendCmd(new Uint8Array([0, CMD.STA]), CMD.STA, 1000, 1);
  }, 2000);
  $('butSave').disabled = false;
  state.followLatest = $('follow').checked;
  worker.postMessage({ type: 'viewport', followLatest: state.followLatest, render: true });
}

async function stopRecording(silent = false) {
  if (!state.recording) return;
  clearInterval(state.statusTimer);
  state.statusTimer = null;
  await new Promise((r) => setTimeout(r, 700));
  await sendCmd(new Uint8Array([0, CMD.STA]), CMD.STA, 1000, 2);
  await new Promise((r) => setTimeout(r, 200));
  worker.postMessage({ type: 'finish', device: state.device });
  await sendCmd(new Uint8Array([1, CMD.CFG, 0]), CMD.CFG, 1000, 1);
  state.recording = false;
  $('butStart').disabled = false;
  $('butStop').disabled = true;
  if (!silent) log('измерение остановлено (pktcnt=0)');
}

// ---------------------------------------------------------------- панели
function renderStats() {
  const s = state.stats;
  if (!s) return;
  $('stPairs').textContent = s.pairs.toLocaleString('ru-RU');
  $('stRate').textContent = Math.round(s.pairsPerSecond).toLocaleString('ru-RU');
  $('stTime').textContent = s.elapsedSeconds.toFixed(1) + ' с';
  $('stMem').textContent = `${(s.bytesStored / 1048576).toFixed(2)} МиБ (+LOD ${(s.pyramidBytes / 1024).toFixed(0)} КиБ)`;
  $('stBad').textContent = `${s.misaligned} / ${s.deviceErrors}`;
  const est = s.estimate;
  const counters = s.countersEnd || {};
  const extra = (counters.readsLostRing != null)
    ? `; кольцо: ${counters.readsLostRing}, I2C: ${counters.i2cErrors}`
    : '';
  $('stLoss').textContent = est
    ? `${est.missingPairsUpperBound} (блоков: ${est.blocksWritten}, потеряно ${est.blocksDropped}${extra})`
    : 'нет данных счётчиков';
  if (s.lastDio !== null && s.lastDio !== undefined) {
    $('stDio').textContent = '0x' + s.lastDio.toString(16).padStart(2, '0').toUpperCase()
      + '  ' + s.lastDio.toString(2).padStart(8, '0');
  }
}

function renderMetrics(m) {
  const w = m.win;
  const kb = 0.01220703125, ki = 0.00001953125;   // для отображения в мВ/мА; точные — из калибровки файла
  $('mwPairs').textContent = w.pairs.toLocaleString('ru-RU');
  $('mwU').textContent = w.minU === null ? '—'
    : `${fmt(w.minU * kb, 1)} … ${fmt(w.maxU * kb, 1)} мВ`;
  $('mwI').textContent = w.minI === null ? '—'
    : `${fmt(w.minI * ki, 4)} … ${fmt(w.maxI * ki, 4)} мА`;
  $('mwAvg').textContent = w.avgU === null ? '—'
    : `${fmt(w.avgU * kb, 1)} мВ / ${fmt(w.avgI * ki, 4)} мА`;
  $('mwDio').textContent = `маска активности 0x${(w.dioOr || 0).toString(16).padStart(2, '0').toUpperCase()}, `
    + `смен ${w.dioChanges}`;
  const a = m.all;
  $('maU').textContent = a.minU === null ? '—' : `${fmt(a.minU_mV, 1)} … ${fmt(a.maxU_mV, 1)} мВ`;
  $('maI').textContent = a.minI === null ? '—' : `${fmt(a.minI_mA, 4)} … ${fmt(a.maxI_mA, 4)} мА`;
  $('maDio').textContent = `0x${(a.dioOr || 0).toString(16).padStart(2, '0').toUpperCase()}, смен ${a.dioChanges}`;
}

function renderSample(s) {
  if (!s) return;
  $('curInfo').textContent = `пара ${s.pair.toLocaleString('ru-RU')} · ${s.timeSeconds.toFixed(4)} с · `
    + `U ${fmt(s.u_mV, 2)} мВ · I ${fmt(s.i_mA, 4)} мА · DIO 0x${s.dio.toString(16).padStart(2, '0').toUpperCase()}`;
}

// ---------------------------------------------------------------- ввод
function canvasSize() {
  const rect = canvas.getBoundingClientRect();
  return { width: Math.max(200, Math.round(rect.width)), height: Math.max(160, Math.round(rect.height)) };
}

function pushViewState(extra = {}) {
  const { width, height } = canvasSize();
  state.viewState = { ...state.viewState, width, height, dpr: window.devicePixelRatio || 1, ...extra };
  worker.postMessage({ type: 'viewport', viewState: state.viewState, ...extra, render: true });
}

function initChart() {
  const { width, height } = canvasSize();
  canvas.width = Math.round(width * (window.devicePixelRatio || 1));
  canvas.height = Math.round(height * (window.devicePixelRatio || 1));
  pushViewState();
  worker.postMessage({ type: 'metrics' });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const factor = e.deltaY < 0 ? 1.3 : 1 / 1.3;
    worker.postMessage({ type: 'viewport', zoomAt: { x, factor, width: rect.width } });
    if (state.followLatest && factor < 1) {
      state.followLatest = false;
      $('follow').checked = false;
    }
    worker.postMessage({ type: 'metrics' });
  }, { passive: false });

  canvas.addEventListener('pointerdown', (e) => {
    state.dragging = { x: e.clientX, moved: 0 };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    if (state.dragging) {
      const dx = e.clientX - state.dragging.x;
      state.dragging.x = e.clientX;
      state.dragging.moved += Math.abs(dx);
      if (state.dragging.moved > 3) {
        worker.postMessage({ type: 'viewport', panByPixels: { dx, width: rect.width } });
        if (state.followLatest) { state.followLatest = false; $('follow').checked = false; }
      }
    }
    worker.postMessage({ type: 'sample', x: e.clientX - rect.left, width: rect.width });
  });
  canvas.addEventListener('pointerup', (e) => {
    const moved = state.dragging ? state.dragging.moved : 0;
    state.dragging = null;
    if (moved <= 3) worker.postMessage({ type: 'metrics' });
  });
  canvas.addEventListener('dblclick', () => {
    worker.postMessage({ type: 'viewport', fit: true });
    worker.postMessage({ type: 'metrics' });
  });
  canvas.addEventListener('pointerleave', () => { $('curInfo').textContent = 'курсор вне графика'; });

  window.addEventListener('resize', () => pushViewState());
}

// ---------------------------------------------------------------- файл
async function openFile(file) {
  try {
    $('progress').textContent = 'чтение файла…';
    const buf = await file.arrayBuffer();
    worker.postMessage({ type: 'open-file', buffer: buf }, [buf]);
    worker.postMessage({ type: 'metrics' });
  } catch (e) {
    $('progress').textContent = '';
    logErr('не удалось открыть запись: ' + e.message);
  }
}

// ---------------------------------------------------------------- UI
function init() {
  const speed = $('speed');
  for (const s of SPEEDS) {
    const o = document.createElement('option');
    o.value = String(s.us);
    o.textContent = s.label;
    speed.appendChild(o);
  }
  speed.value = '84';

  $('butConnect').addEventListener('click', () => (state.port ? disconnect() : connect()));
  $('butStart').addEventListener('click', startRecording);
  $('butStop').addEventListener('click', () => stopRecording(false));
  $('butSave').addEventListener('click', () => worker.postMessage({ type: 'save-blob', device: state.device }));
  $('butDemo').addEventListener('click', () => {
    state.demoRequested = true;
    worker.postMessage({ type: 'demo', seconds: 5 });
    log('демо-данные: 5 с при 10 000 пар/с (шум, «лестница» нагрузки, импульс DIO в одну пару)');
  });
  $('butClear').addEventListener('click', () => {
    worker.postMessage({ type: 'reset' });
    state.stats = null;
    renderStats();
    log('буфер записи очищен');
  });
  $('fileOpen').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) openFile(e.target.files[0]);
  });
  $('butFit').addEventListener('click', () => {
    worker.postMessage({ type: 'viewport', fit: true });
    worker.postMessage({ type: 'metrics' });
  });
  $('butZoomIn').addEventListener('click', () => {
    const { width } = canvasSize();
    worker.postMessage({ type: 'viewport', zoomAt: { x: width / 2, factor: 2, width } });
    worker.postMessage({ type: 'metrics' });
  });
  $('butZoomOut').addEventListener('click', () => {
    const { width } = canvasSize();
    worker.postMessage({ type: 'viewport', zoomAt: { x: width / 2, factor: 0.5, width } });
    worker.postMessage({ type: 'metrics' });
  });
  $('follow').addEventListener('change', () => {
    state.followLatest = $('follow').checked;
    worker.postMessage({ type: 'viewport', followLatest: state.followLatest });
  });
  $('overlay').addEventListener('change', () => pushViewState({ overlay: $('overlay').checked }));
  $('showDio').addEventListener('change', () => pushViewState({ showDio: $('showDio').checked }));
  $('points').addEventListener('change', () => pushViewState({ showPoints: $('points').checked }));
  $('range').addEventListener('change', () => pushViewState({ showRange: $('range').checked }));
  $('grid').addEventListener('change', () => pushViewState({ showGrid: $('grid').checked }));
  $('withAvg').addEventListener('change', () => worker.postMessage({ type: 'metrics', withAvg: $('withAvg').checked }));

  const cal = defaultCalibration(1);
  $('calInfo').textContent = `U[мВ] = код × ${cal.k_bus_mv_per_code}; `
    + `I[мА] = код × ${cal.k_shunt_ma_per_code} (шунт 1 Ом)`;

  initChart();
  setInterval(() => worker.postMessage({ type: 'poll' }), 250);
  log('готово. Подключите прибор и нажмите «Начать запись», либо откройте сохранённый файл.');
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
    logErr('Web Serial требует https:// или localhost — иначе порт не откроется');
  }
}

init();
