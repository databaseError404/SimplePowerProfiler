/**
 * Формат файла записи PowerProfiler (Этап 3, проектируется здесь).
 *
 * Раскладка:
 *   смещение 0            : ASCII "PPREC1" (6 байт) — магия + версия формата
 *   смещение 6            : u16 headerBytes (LE) — размер области заголовка
 *   смещение 8            : UTF-8 JSON заголовка, добитый нулями до headerBytes
 *   смещение 8+headerBytes: чанки данных подряд:
 *                             u32 count (LE)
 *                             count * u32  — U24 (младшие 24 бита) + DIO (старшие 8)
 *                             count * i32  — I24 со знаком
 *
 * Заголовок (JSON) несёт всё, что нужно для воспроизведения шкал и контроля целостности:
 *   format/version, created, app, device (DevID/Ver/INA228), cfg (time/clk/pktcnt/режим/пары в секунду),
 *   calib (шунт, коэффициенты), counts (пары/блоки/потери/ошибки), events (UART и прочие события — Этап 5).
 *
 * Такой формат:
 *   * пишется потоково (область заголовка резервируется и дописывается при остановке);
 *   * читается без копирования — чанки становятся типизированными представлениями над буфером файла;
 *   * расширяется добавлением полей в JSON (версия в магии и в header.version).
 */

import { PairStore, CHUNK_PAIRS_DEFAULT, BYTES_PER_PAIR } from './store.js';

export const MAGIC = 'PPREC1';
export const FORMAT_VERSION = 1;
export const DEFAULT_HEADER_BYTES = 8192;
export const HEADER_PREFIX_BYTES = 8;          // магия (6) + u16 размера заголовка

/** Коэффициенты отображения (по умолчанию — плата стенда: шунт 1 Ом, ±163.84 мВ). */
export function defaultCalibration(shuntOhm = 1.0) {
  return {
    shunt_ohm: shuntOhm,
    vshunt_fsr_mv: 163.84,
    k_bus_mv_per_code: 0.01220703125,              // U[мВ] = raw * k
    k_shunt_ma_per_code: 0.00001953125 / shuntOhm, // I[мА] = raw * k (1 LSB 20 бит = 312.5 нВ)
    note: 'pp.js использует шунт 10 Ом — для платы стенда шкала мА там в 10 раз меньше',
  };
}

/** Сборка области заголовка фиксированного размера. */
export function buildHeader(meta, headerBytes = DEFAULT_HEADER_BYTES) {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const total = HEADER_PREFIX_BYTES + headerBytes;
  if (json.length > headerBytes) {
    throw new Error(`заголовок не влезает в ${headerBytes} байт (нужно ${json.length})`);
  }
  const out = new Uint8Array(total);
  for (let i = 0; i < MAGIC.length; i++) out[i] = MAGIC.charCodeAt(i);
  new DataView(out.buffer).setUint16(6, headerBytes, true);
  out.set(json, HEADER_PREFIX_BYTES);
  return out;
}

/** Части для сборки файла: заголовок + чанки (без копирования данных). */
export function serializeParts(store, meta, headerBytes = DEFAULT_HEADER_BYTES) {
  const parts = [buildHeader(meta, headerBytes)];
  for (const p of store.parts()) {
    const cnt = new Uint8Array(4);
    new DataView(cnt.buffer).setUint32(0, p.count, true);
    parts.push(cnt);
    parts.push(new Uint8Array(p.ud.buffer, p.ud.byteOffset, p.count * 4));
    parts.push(new Uint8Array(p.iv.buffer, p.iv.byteOffset, p.count * 4));
  }
  return parts;
}

/** Blob со всей записью (для скачивания из браузера или проверки в Node). */
export function serializeToBlob(store, meta, headerBytes = DEFAULT_HEADER_BYTES) {
  return new Blob(serializeParts(store, meta, headerBytes));
}

/** Прочитать заголовок из буфера (без разбора данных). */
export function readHeader(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (u8.length < HEADER_PREFIX_BYTES) throw new Error('файл короче заголовка');
  let magic = '';
  for (let i = 0; i < MAGIC.length; i++) magic += String.fromCharCode(u8[i]);
  if (magic !== MAGIC) throw new Error(`не файл записи PowerProfiler (магия ${JSON.stringify(magic)})`);
  const headerBytes = new DataView(u8.buffer, u8.byteOffset, u8.length).getUint16(6, true);
  const jsonStart = HEADER_PREFIX_BYTES;
  const jsonEnd = jsonStart + headerBytes;
  if (u8.length < jsonEnd) throw new Error('файл обрезан в области заголовка');
  let end = jsonStart;
  while (end < jsonEnd && u8[end] !== 0) end++;
  const json = new TextDecoder().decode(u8.subarray(jsonStart, end));
  return { header: JSON.parse(json), headerBytes, dataOffset: jsonEnd };
}

/**
 * Открытая запись: заголовок + доступ к парам по индексу без копирования данных.
 * Чанки берутся представлениями над буфером файла.
 */
export class RecordFile {
  constructor(buffer) {
    const { header, headerBytes, dataOffset } = readHeader(buffer);
    this.header = header;
    this.headerBytes = headerBytes;
    this.bytes = buffer.byteLength !== undefined ? buffer.byteLength : buffer.length;
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.length);

    /** @type {{count:number, ud:Uint32Array, iv:Int32Array, start:number}[]} */
    this.chunks = [];
    this.length = 0;
    let off = dataOffset;
    let truncatedTail = 0;
    while (off + 4 <= u8.length) {
      const count = dv.getUint32(off, true);
      const need = 4 + count * BYTES_PER_PAIR;
      if (off + need > u8.length) {
        // Файл обрезан (запись прервана): в формате сначала весь массив ud, затем весь iv,
        // поэтому читаем только те пары, у которых есть ОБА значения.
        const avail = u8.length - (off + 4);
        const udAvail = Math.min(count, Math.floor(avail / 4));
        const ivAvail = Math.min(count, Math.max(0, Math.floor((avail - count * 4) / 4)));
        truncatedTail = Math.max(0, Math.min(udAvail, ivAvail));
        if (truncatedTail > 0) {
          const base = u8.byteOffset + off + 4;
          const ud = new Uint32Array(u8.buffer, base, truncatedTail);
          const iv = new Int32Array(u8.buffer, base + count * 4, truncatedTail);
          this.chunks.push({ count: truncatedTail, ud, iv, start: this.length, partial: true });
          this.length += truncatedTail;
        }
        break;
      }
      const ud = new Uint32Array(u8.buffer, u8.byteOffset + off + 4, count);
      const iv = new Int32Array(u8.buffer, u8.byteOffset + off + 4 + count * 4, count);
      this.chunks.push({ count, ud, iv, start: this.length });
      this.length += count;
      off += need;
    }
    this.truncatedTail = truncatedTail;
  }

  u(index) {
    const c = this._chunkOf(index);
    return this.chunks[c].ud[index - this.chunks[c].start] & 0xFFFFFF;
  }

  i(index) {
    const c = this._chunkOf(index);
    return this.chunks[c].iv[index - this.chunks[c].start];
  }

  dio(index) {
    const c = this._chunkOf(index);
    return this.chunks[c].ud[index - this.chunks[c].start] >>> 24;
  }

  get(index) {
    return { u: this.u(index), i: this.i(index), dio: this.dio(index) };
  }

  /** Двоичный поиск чанка по индексу пары. */
  _chunkOf(index) {
    if (index < 0 || index >= this.length) throw new RangeError('индекс вне записи');
    let lo = 0, hi = this.chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.chunks[mid].start <= index) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** Преобразование в PairStore (если нужно дальше работать как с живой записью). */
  toStore() {
    return PairStore.fromParts(this.chunks.map((c) => ({ count: c.count, ud: c.ud, iv: c.iv })));
  }

  /** Сколько пар в секунду следует из заголовка (для шкалы времени). */
  get pairsPerSecond() {
    const cfg = this.header.cfg || {};
    return cfg.pairs_per_s || (cfg.time_us ? 1e6 / (2 * cfg.time_us) : null);
  }
}

/** Разбор буфера/Blob целиком. */
export async function openRecord(source) {
  const buffer = source instanceof ArrayBuffer
    ? source
    : (source.arrayBuffer ? await source.arrayBuffer() : new Uint8Array(source).buffer);
  return new RecordFile(buffer);
}

/** Заголовок для новой записи (используется и при сохранении в память, и при потоковой записи в файл). */
export function makeMeta({
  cfg = {}, calib = defaultCalibration(), device = {}, loss = {}, events = [], app = {}, created = null,
} = {}) {
  const timeUs = cfg.time_us || 84;
  return {
    format: 'pprec',
    version: FORMAT_VERSION,
    created: created || new Date().toISOString(),
    app: { name: 'PowerProfiler recorder', stage: 3, ...app },
    device,
    cfg: {
      time_us: timeUs,
      clk_khz: cfg.clk_khz || 1300,
      pktcnt: cfg.pktcnt || 20,
      mode: cfg.mode || 'pairs24+dio',
      group_bytes: 7,
      pairs_per_block: Math.floor((cfg.pktcnt || 20) / 2),
      pairs_per_s: cfg.pairs_per_s || 1e6 / (2 * timeUs),
      ...cfg,
    },
    calib,
    counts: { pairs: 0, blocks: 0, ...loss },
    events,
  };
}
