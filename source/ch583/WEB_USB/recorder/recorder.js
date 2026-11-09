/**
 * Ядро записи (Этап 3): парсер → компактное хранилище → счётчики/события.
 *
 * Не зависит от DOM и Worker: используется и в браузере (через worker.js), и в тестах Node.
 * Горячий путь (`push`) не выделяет объекты на каждую пару.
 */

import { StreamParser, CMD, GROUP_BYTES_24BIT_DIO, signed24 } from './parser.js';
import { PairStore, LossTracker, CHUNK_PAIRS_DEFAULT, BYTES_PER_PAIR } from './store.js';
import { LodPyramid } from './lod.js';
import { makeMeta, serializeParts, buildHeader, HEADER_PREFIX_BYTES, DEFAULT_HEADER_BYTES } from './recordfile.js';

export const MAX_EVENTS = 4096;   // ограничение на список событий (UART — Этап 5)

export class Recorder {
  /**
   * @param {object} [opts]
   * @param {number} [opts.groupBytes=7]
   * @param {number} [opts.chunkPairs]
   * @param {number} [opts.pktcnt=20]
   * @param {number} [opts.timeUs=84]
   * @param {number} [opts.clkKhz=1300]
   * @param {number} [opts.shuntOhm=1]
   */
  constructor(opts = {}) {
    this.groupBytes = opts.groupBytes || GROUP_BYTES_24BIT_DIO;
    this.pktcnt = opts.pktcnt || 20;
    this.store = new PairStore({ chunkPairs: opts.chunkPairs || CHUNK_PAIRS_DEFAULT });
    // LOD-пирамида строится инкрементально вместе с записью (Этап 4): рендер берёт из неё
    // min/max-энвелопу и активность DIO, поэтому стоимость кадра не зависит от длины записи.
    this.pyramid = new LodPyramid({ base: opts.lodBase || 64 });
    this.loss = new LossTracker(Math.floor(this.pktcnt / 2));
    this.events = [];
    this.eventOverflow = 0;
    this.startedAt = null;
    this.stoppedAt = null;
    this.cfg = {
      time_us: opts.timeUs || 84,
      clk_khz: opts.clkKhz || 1300,
      pktcnt: this.pktcnt,
      mode: 'pairs24+dio',
      group_bytes: this.groupBytes,
    };
    this.device = {};
    this.cfgEcho = null;
    this.frdFormat = null;
    this.lastDio = null;

    // окно скорости: счётчики пар по интервалам 100 мс
    this._rateWindow = new Array(20).fill(0);
    this._rateIndex = 0;
    this._ratePairs = 0;
    this._rateTick = 0;

    this.parser = new StreamParser({
      groupBytes: this.groupBytes,
      onPair: (u, i, dio) => this._onPair(u, i, dio),
      onFrame: (cmd, payload) => this._onFrame(cmd, payload),
      onStatus: (counters) => this.loss.snapshot(counters),
      onSeq: (seq) => this.loss.noteSeq(seq),
      onMisalign: (size, cmd) => { this.loss.misaligned++; this.addEvent('misalign', { size, cmd }); },
      onDeviceError: (cmd) => { this.loss.deviceErrors++; this.addEvent('device_error', { cmd }); },
    });
  }

  _onPair(u, i, dio) {
    this.store.append(u, i, dio);
    this.pyramid.addPair(u, i, dio);
    this.loss.pairs++;
    this._ratePairs++;
    this.lastDio = dio;
  }

  _onFrame(cmd, payload) {
    if (cmd === CMD.CFG) {
      // ответ на CMD_DEV_CFG: [pktcnt, multiplier, time(u16), clk(u16), ...]
      if (payload.length >= 6) {
        this.cfgEcho = {
          pktcnt: payload[0],
          multiplier: payload[1],
          time_us: payload[2] | (payload[3] << 8),
          clk_khz: payload[4] | (payload[5] << 8),
        };
      }
    } else if (cmd === CMD.FRD && payload.length >= 1) {
      this.frdFormat = payload[0];
    } else if (cmd === CMD.VER && payload.length >= 4) {
      this.device.dev_id = payload[0] | (payload[1] << 8);
      this.device.ver = payload[2] | (payload[3] << 8);
    } else if (cmd === CMD.GRG && payload.length >= 4) {
      this.addEvent('i2c_reg', { addr: payload[0], reg: payload[1], data: payload[2] | (payload[3] << 8) });
    }
  }

  /** Добавить байты, принятые от порта. */
  push(bytes) {
    if (this.startedAt === null) this.startedAt = performance.now();
    const n = this.parser.push(bytes);
    this.loss.blocks = this.parser.frames;
    return n;
  }

  addEvent(type, data) {
    if (this.events.length >= MAX_EVENTS) {
      this.eventOverflow++;
      // вытесняем только «массовые» типы, важные (потери) оставляем
      const idx = this.events.findIndex((e) => e.type === 'i2c_reg' || e.type === 'uart');
      if (idx >= 0) this.events.splice(idx, 1);
      else return;
    }
    this.events.push({ t: this.startedAt === null ? 0 : performance.now() - this.startedAt, type, ...data });
  }

  /** Снимок счётчиков прибора (CMD_DEV_STA). */
  status(counters) {
    this.loss.snapshot(counters);
  }

  /** Периодический вызов из UI/воркера: обновляет окно скорости. */
  tick(nowMs = performance.now()) {
    if (this._rateTick === 0) { this._rateTick = nowMs; return; }
    const dt = nowMs - this._rateTick;
    if (dt < 100) return;
    const steps = Math.min(this._rateWindow.length, Math.floor(dt / 100));
    for (let k = 0; k < steps; k++) {
      this._rateIndex = (this._rateIndex + 1) % this._rateWindow.length;
      this._rateWindow[this._rateIndex] = 0;
    }
    this._rateWindow[this._rateIndex] = this._ratePairs;
    this._ratePairs = 0;
    this._rateTick = nowMs;
  }

  get ratePairsPerSecond() {
    const total = this._rateWindow.reduce((a, b) => a + b, 0);
    const filled = this._rateWindow.filter((v) => v > 0).length || this._rateWindow.length;
    return total / (filled * 0.1);
  }

  get elapsedSeconds() {
    if (this.startedAt === null) return 0;
    const end = this.stoppedAt === null ? performance.now() : this.stoppedAt;
    return (end - this.startedAt) / 1000;
  }

  stop() {
    this.stoppedAt = performance.now();
    this.parser.reset();     // неполный хвост кадра не считаем данными
  }

  get stats() {
    return {
      pairs: this.store.length,
      blocks: this.loss.blocks,
      bytesStored: this.store.bytes,
      chunks: this.store.chunkCount,
      pyramidBytes: this.pyramid.bytes,
      pyramidPairs: this.pyramid.pairs,
      pairsPerSecond: this.ratePairsPerSecond,
      elapsedSeconds: this.elapsedSeconds,
      rateBytesPerSecond: this.ratePairsPerSecond * BYTES_PER_PAIR,
      misaligned: this.loss.misaligned,
      deviceErrors: this.loss.deviceErrors,
      seqGaps: this.loss.seqGaps,
      events: this.events.length,
      eventOverflow: this.eventOverflow,
      lastDio: this.lastDio,
      estimate: this.loss.estimate,
    };
  }

  /** Заголовок для файла записи. */
  meta(extra = {}) {
    const loss = this.loss.summary;
    return makeMeta({
      cfg: { ...this.cfg, pairs_per_block: Math.floor(this.pktcnt / 2) },
      device: { ...this.device, ...(extra.device || {}) },
      loss,
      events: this.events.slice(0, 512),     // в заголовок — первые события, остальное в отчёте
      app: { ...(extra.app || {}) },
      ...extra,
    });
  }

  /** Части файла для сохранения (заголовок + данные). */
  fileParts(headerBytes = DEFAULT_HEADER_BYTES, extra = {}) {
    return serializeParts(this.store, this.meta(extra), headerBytes);
  }
}

/**
 * Потоковая запись в файл (File System Access API): заголовок резервируется и дописывается
 * при остановке, чанки пишутся по мере заполнения. Память не растёт вместе с длительностью записи
 * (в памяти остаются только незаписанные чанки и счётчики).
 */
export class StreamSink {
  /**
   * @param {FileSystemFileHandle} handle
   * @param {number} [headerBytes]
   */
  constructor(handle, headerBytes = DEFAULT_HEADER_BYTES) {
    this.handle = handle;
    this.headerBytes = headerBytes;
    this.writable = null;
    this.writtenChunks = 0;
    this.bytesWritten = 0;
  }

  async open(meta) {
    this.writable = await this.handle.createWritable();
    const header = buildHeader(meta, this.headerBytes);
    await this.writable.write(header);
    this.bytesWritten = header.length;
    this.writtenChunks = 0;
  }

  /** Записать все полностью заполненные чанки, которых ещё нет в файле. */
  async flush(store) {
    if (!this.writable) return 0;
    const parts = store.parts();
    let written = 0;
    for (let i = this.writtenChunks; i < parts.length; i++) {
      const p = parts[i];
      const full = p.count === store.chunkPairs || i === parts.length - 1 && store.count > 0;
      if (!full) break;                       // последний неполный чанк пишем на остановке
      const cnt = new Uint8Array(4);
      new DataView(cnt.buffer).setUint32(0, p.count, true);
      await this.writable.write(cnt);
      await this.writable.write(new Uint8Array(p.ud.buffer, p.ud.byteOffset, p.count * 4));
      await this.writable.write(new Uint8Array(p.iv.buffer, p.iv.byteOffset, p.count * 4));
      this.bytesWritten += 4 + p.count * 8;
      this.writtenChunks = i + 1;
      written++;
    }
    return written;
  }

  /** Дописать хвост и обновить заголовок итоговыми счётчиками. */
  async finish(store, meta) {
    if (!this.writable) return this.bytesWritten;
    const parts = store.parts();
    for (let i = this.writtenChunks; i < parts.length; i++) {
      const p = parts[i];
      const cnt = new Uint8Array(4);
      new DataView(cnt.buffer).setUint32(0, p.count, true);
      await this.writable.write(cnt);
      await this.writable.write(new Uint8Array(p.ud.buffer, p.ud.byteOffset, p.count * 4));
      await this.writable.write(new Uint8Array(p.iv.buffer, p.iv.byteOffset, p.count * 4));
      this.bytesWritten += 4 + p.count * 8;
      this.writtenChunks = i + 1;
    }
    const header = buildHeader(meta, this.headerBytes);
    await this.writable.write({ type: 'write', position: 0, data: header });
    await this.writable.close();
    this.writable = null;
    return this.bytesWritten;
  }

  async abort() {
    if (this.writable) {
      try { await this.writable.close(); } catch (e) { /* ignore */ }
      this.writable = null;
    }
  }
}

export { HEADER_PREFIX_BYTES, DEFAULT_HEADER_BYTES, BYTES_PER_PAIR };
