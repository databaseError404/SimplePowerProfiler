/**
 * Воркер рекордера: разбор потока, хранение записей и отрисовка (Этапы 3–4).
 *
 * Почему рендер тоже здесь: данные (PairStore + LOD-пирамида) живут в воркере, поэтому рисовать
 * в OffscreenCanvas дешевле, чем копировать их в главный поток. Главный поток получает готовый
 * ImageBitmap и просто выводит его — интерфейс не зависит от объёма данных и не тормозит запись.
 *
 * Почему Web Serial читает главный поток: `navigator.serial` доступен только в окне,
 * а объект SerialPort не переносится между контекстами.
 *
 * Сообщения (см. app.js): init, start, bytes, file-handle, finish, save-blob, reset,
 * open-file, viewport, render, sample, poll.
 */

import { Recorder, StreamSink } from './recorder.js';
import { DEFAULT_HEADER_BYTES, openRecord, RecordFile } from './recordfile.js';
import { LodPyramid } from './lod.js';
import { Viewport } from './viewport.js';
import { ChartRenderer } from './render.js';
import { windowMetrics, recordMetrics } from './metrics.js';

let rec = null;
let sink = null;
let cfg = null;
let recording = false;
let lastStatsSent = 0;

// Просмотр: источник — либо живая запись (rec.store), либо открытый файл.
let source = null;            // {u,i,dio,length}
let pyramid = null;
let calib = { k_bus_mv_per_code: 0.01220703125, k_shunt_ma_per_code: 0.00001953125 };
let fileHeader = null;
let viewport = new Viewport({ pairs: 0, pairsPerSecond: 1000 });
let renderer = null;
let offscreen = null;
let viewState = { width: 800, height: 420, dpr: 1, overlay: false, showDio: true, withOverview: true,
                  showPoints: true, showRange: true, showGrid: true };
let lastMetrics = null;

/** Кадр 0x3A с одной парой (для демо-данных). */
function packDemoPairs(u, i, dio) {
  const uu = u & 0xFFFFFF, ii = i & 0xFFFFFF, d = dio & 0xFF;
  return new Uint8Array([7, 0x3A,
    uu & 0xFF, (uu >> 8) & 0xFF, (uu >> 16) & 0xFF,
    ii & 0xFF, (ii >> 8) & 0xFF, (ii >> 16) & 0xFF, d]);
}

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function statsNow() {
  if (!rec) return null;
  rec.tick();
  return rec.stats;
}

function sendStats(force = false) {
  const now = performance.now();
  if (!force && now - lastStatsSent < 200) return;
  lastStatsSent = now;
  post({ type: 'stats', stats: statsNow(), recording });
}

/** Переключить источник просмотра на живую запись. */
function useRecording() {
  if (!rec) return;
  source = rec.store;
  pyramid = rec.pyramid;
  fileHeader = null;
  viewport.pairsPerSecond = 1e6 / (2 * (rec.cfg.time_us || 84));
  viewport.setPairs(rec.store.length);
}

function ensureRenderer() {
  if (renderer && offscreen && offscreen.width === Math.round(viewState.width * viewState.dpr)) return;
  if (typeof OffscreenCanvas === 'undefined') return;
  offscreen = new OffscreenCanvas(Math.max(1, Math.round(viewState.width * viewState.dpr)),
                                 Math.max(1, Math.round(viewState.height * viewState.dpr)));
  renderer = new ChartRenderer(offscreen, { source, pyramid, calib, dpr: viewState.dpr });
  renderer.resize(viewState.width, viewState.height, viewState.dpr);
  renderer.overlay = viewState.overlay;
  renderer.showDio = viewState.showDio;
}

/** Кадр: собрать данные, нарисовать, отдать bitmap в главный поток. */
function renderFrame(extra = {}) {
  if (!source || !pyramid) {
    post({ type: 'frame-empty' });
    return;
  }
  ensureRenderer();
  if (!renderer) {
    post({ type: 'error', message: 'OffscreenCanvas недоступен в этом браузере' });
    return;
  }
  renderer.source = source;
  renderer.pyramid = pyramid;
  renderer.calib = calib;
  renderer.overlay = viewState.overlay;
  renderer.showDio = viewState.showDio;
  renderer.showPoints = viewState.showPoints !== false;
  renderer.showRange = viewState.showRange !== false;
  renderer.showGrid = viewState.showGrid !== false;
  const stats = renderer.draw(viewport, { columns: Math.max(2, Math.floor(viewState.width)),
                                          withOverview: viewState.withOverview });
  const bitmap = offscreen.transferToImageBitmap();
  post({ type: 'frame', bitmap, stats, viewport: viewport.state, ...extra }, [bitmap]);
}

/** Метрики окна и всей записи (по запросу — средние считаются по сырым парам). */
function sendMetrics(withAvg = false) {
  if (!source || !pyramid) return;
  const from = Math.max(0, Math.floor(viewport.from));
  const to = Math.min(source.length, Math.ceil(viewport.to));
  const win = windowMetrics(pyramid, source, from, to, { withAvg, maxPairsForAvg: 500000 });
  const all = recordMetrics(pyramid, calib);
  lastMetrics = { win, all, from, to };
  post({ type: 'metrics', win, all, from, to, pps: viewport.pairsPerSecond });
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    switch (m.type) {
      case 'init': {
        if (sink) { await sink.abort(); sink = null; }
        cfg = m.cfg;
        rec = new Recorder({
          pktcnt: cfg.pktcnt,
          timeUs: cfg.timeUs,
          clkKhz: cfg.clkKhz,
          groupBytes: cfg.groupBytes || 7,
          chunkPairs: cfg.chunkPairs || (1 << 16),
        });
        calib = m.calib || calib;
        useRecording();
        post({ type: 'ready', caps: { fileSystem: typeof FileSystemFileHandle !== 'undefined',
                                      offscreen: typeof OffscreenCanvas !== 'undefined' } });
        break;
      }

      case 'file-handle': {
        sink = new StreamSink(m.handle, m.headerBytes || DEFAULT_HEADER_BYTES);
        await sink.open(rec.meta({ app: { streaming: true } }));
        post({ type: 'log', text: 'потоковая запись в файл открыта' });
        break;
      }

      case 'start': {
        rec.device = m.device || {};
        rec.startedAt = performance.now();
        recording = true;
        useRecording();
        post({ type: 'started' });
        break;
      }

      case 'bytes': {
        if (!rec) break;
        rec.push(new Uint8Array(m.buffer));
        if (recording) {
          viewport.setPairs(rec.store.length);
          viewport.followTick();
        }
        sendStats();
        break;
      }

      case 'cmd-frame':
        post({ type: 'frame-cmd', cmd: m.cmd, payload: m.payload });
        break;

      case 'poll':
        sendStats(true);
        break;

      case 'finish': {
        recording = false;
        rec.stop();
        let bytesWritten = null;
        if (sink) {
          bytesWritten = await sink.finish(rec.store, rec.meta({
            app: { streaming: true },
            device: m.device || rec.device,
          }));
        }
        viewport.setPairs(rec.store.length);
        post({ type: 'finished', stats: rec.stats, bytesWritten });
        break;
      }

      case 'save-blob': {
        const parts = rec.fileParts(m.headerBytes || DEFAULT_HEADER_BYTES, { device: m.device || rec.device });
        const blob = new Blob(parts, { type: 'application/octet-stream' });
        post({ type: 'blob', blob, pairs: rec.store.length });
        break;
      }

      case 'reset': {
        if (sink) { await sink.abort(); sink = null; }
        rec = new Recorder({
          pktcnt: cfg.pktcnt, timeUs: cfg.timeUs, clkKhz: cfg.clkKhz,
          groupBytes: cfg.groupBytes || 7, chunkPairs: cfg.chunkPairs || (1 << 16),
        });
        useRecording();
        post({ type: 'reset-ok' });
        break;
      }

      case 'open-file': {
        // Главный поток передаёт содержимое файла как ArrayBuffer (без копирования).
        const file = await openRecord(m.buffer);
        source = file;
        calib = file.header.calib || calib;
        fileHeader = file.header;
        pyramid = new LodPyramid({ base: 64 });
        const total = file.length;
        const chunk = 250_000;
        for (let off = 0; off < total; off += chunk) {
          const to = Math.min(off + chunk, total);
          pyramid.addFrom(file, off, to);
          post({ type: 'progress', what: 'lod', done: to, total });
          await new Promise((r) => setTimeout(r, 0));
        }
        viewport = new Viewport({ pairs: total, pairsPerSecond: file.pairsPerSecond || 1000 });
        viewport.fit();
        renderer = null;             // источник сменился — пересоздать рендерер
        post({ type: 'file-opened', header: file.header, length: total, truncatedTail: file.truncatedTail });
        renderFrame({ after: 'open' });
        sendMetrics(false);
        break;
      }

      case 'viewport': {
        if (m.fit) viewport.fit();
        if (m.setRange) viewport.setRange(m.setRange[0], m.setRange[1]);
        if (m.zoomAt) viewport.zoomAt(m.zoomAt.x, m.zoomAt.factor, m.zoomAt.width);
        if (m.panByPixels) viewport.panByPixels(m.panByPixels.dx, m.panByPixels.width);
        if (m.panByFraction) viewport.panByFraction(m.panByFraction);
        if (m.followLatest !== undefined) viewport.setFollowLatest(m.followLatest);
        if (m.viewState) viewState = { ...viewState, ...m.viewState };
        if (m.render !== false) renderFrame();
        break;
      }

      case 'sample': {
        if (!source || !source.length) break;
        const idx = Math.max(0, Math.min(source.length - 1, Math.round(viewport.xToPair(m.x, m.width))));
        const sample = {
          pair: idx,
          u: source.u(idx), i: source.i(idx), dio: source.dio(idx),
          u_mV: source.u(idx) * calib.k_bus_mv_per_code,
          i_mA: source.i(idx) * calib.k_shunt_ma_per_code,
          timeSeconds: idx / (viewport.pairsPerSecond || 1),
        };
        post({ type: 'sample', sample });
        break;
      }

      case 'metrics':
        sendMetrics(!!m.withAvg);
        break;

      case 'demo': {
        post({ type: 'log', text: 'демо: получена команда' });
        // Синтетическая запись для проверки просмотра без прибора: шум U/I, «лестница»
        // нагрузки, импульс DIO шириной в одну пару и медленный бегущий бит на линиях DIO.
        if (sink) { await sink.abort(); sink = null; }
        const seconds = m.seconds || 5;
        const pps = 10000;
        const total = Math.round(seconds * pps);
        const demo = new Recorder({ pktcnt: 20, timeUs: 50, clkKhz: 1500,
                                    chunkPairs: cfg?.chunkPairs || (1 << 16) });
        let lfsr = 0x1234;
        for (let k = 0; k < total; k++) {
          lfsr = (lfsr * 1664525 + 1013904223) >>> 0;
          const noiseU = ((lfsr >>> 8) & 0x3F) - 32;                 // ±0.4 мВ шума
          const step = Math.floor(k / (pps * 0.4));                  // «лестница» нагрузки
          const u = 270300 + noiseU + ((step % 7) * 40);
          const i = ((step % 7) * 60 - 180) + (((lfsr >>> 16) & 0x1F) - 16);
          let dio = 0;
          if (k === Math.floor(total / 2)) dio = 0x80;               // импульс в одну пару
          if ((k % 5000) < 2000) dio |= 0x01;                        // медленный меандр D1
          if ((k % 8000) < 1000) dio |= 0x04;
          demo.push(packDemoPairs(u, i, dio));
        }
        demo.stop();
        post({ type: 'log', text: `демо: сгенерировано пар ${demo.store.length}, кадров ${demo.stats.blocks}, `
          + `пирамида ${demo.pyramid.pairs}` });
        source = demo.store;
        pyramid = demo.pyramid;
        calib = { k_bus_mv_per_code: 0.01220703125, k_shunt_ma_per_code: 0.00001953125 };
        fileHeader = demo.meta({ app: { demo: true } });
        viewport = new Viewport({ pairs: demo.store.length, pairsPerSecond: pps });
        viewport.fit();
        renderer = null;
        post({ type: 'file-opened', header: fileHeader, length: demo.store.length, truncatedTail: 0 });
        renderFrame({ after: 'demo' });
        sendMetrics(false);
        break;
      }

      default:
        post({ type: 'error', message: 'неизвестное сообщение: ' + m.type });
    }
  } catch (e) {
    post({ type: 'error', message: String(e && e.message ? e.message : e) });
  }
};
