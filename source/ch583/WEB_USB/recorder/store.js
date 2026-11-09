/**
 * Хранилище записанных пар U/I/DIO: компактные TypedArray-чанки.
 *
 * Этап 3 (PLAN.md): приём не зависит от рендера; запись не должна незаметно перезаписывать
 * старые данные (никакого «короткого raw-ring» — только рост или явный отказ).
 *
 * Раскладка на пару — 8 байт:
 *   ud  : Uint32Array — U24 в младших 24 битах, DIO в старших 8 битах;
 *   iv  : Int32Array  — I24 со знаком.
 * Чанки фиксированного размера (по умолчанию 65536 пар = 512 КиБ) — рост без копирования
 * уже принятых данных и удобная основа для LOD-пирамиды Этапа 4.
 */

export const CHUNK_PAIRS_DEFAULT = 1 << 16;   // 65536 пар = 512 КиБ на чанк
export const BYTES_PER_PAIR = 8;

export class PairStore {
  /** @param {{chunkPairs?:number}} [opts] */
  constructor(opts = {}) {
    this.chunkPairs = opts.chunkPairs || CHUNK_PAIRS_DEFAULT;
    if ((this.chunkPairs & (this.chunkPairs - 1)) !== 0) {
      throw new Error('chunkPairs должно быть степенью двойки');
    }
    this.shift = Math.log2(this.chunkPairs);
    this.mask = this.chunkPairs - 1;
    /** @type {{ud:Uint32Array, iv:Int32Array}[]} */
    this.chunks = [];
    this.count = 0;
  }

  get length() {
    return this.count;
  }

  /** Выделено байт под данные (без заголовков объектов). */
  get bytes() {
    return this.count === 0 && this.chunks.length === 0
      ? 0
      : this.chunks.length * this.chunkPairs * BYTES_PER_PAIR;
  }

  get chunkCount() {
    return this.chunks.length;
  }

  _grow() {
    this.chunks.push({
      ud: new Uint32Array(this.chunkPairs),
      iv: new Int32Array(this.chunkPairs),
    });
  }

  /** Горячий путь: добавление одной пары. */
  append(u, i, dio) {
    const c = this.count >> this.shift;
    if (c >= this.chunks.length) this._grow();
    const off = this.count & this.mask;
    this.chunks[c].ud[off] = (u & 0xFFFFFF) | ((dio & 0xFF) << 24);
    this.chunks[c].iv[off] = i;
    this.count++;
  }

  /** Чтение пары по индексу. */
  u(index) {
    const c = index >> this.shift;
    return this.chunks[c].ud[index & this.mask] & 0xFFFFFF;
  }

  i(index) {
    const c = index >> this.shift;
    return this.chunks[c].iv[index & this.mask];
  }

  dio(index) {
    const c = index >> this.shift;
    return this.chunks[c].ud[index & this.mask] >>> 24;
  }

  /** Удобная форма для тестов и анализа. */
  get(index) {
    return { u: this.u(index), i: this.i(index), dio: this.dio(index) };
  }

  /** Перебор в порядке записи (без выделения объектов на каждую пару при useCallback). */
  forEach(fn) {
    for (let idx = 0; idx < this.count; idx++) fn(this.u(idx), this.i(idx), this.dio(idx), idx);
  }

  /** Части, из которых собирается файл записи (без копирования данных). */
  parts() {
    const out = [];
    for (let c = 0; c < this.chunks.length; c++) {
      const n = Math.min(this.chunkPairs, this.count - c * this.chunkPairs);
      out.push({ count: n, ud: this.chunks[c].ud, iv: this.chunks[c].iv });
    }
    return out;
  }

  /** Восстановление хранилища из частей файла (используется при открытии записи). */
  static fromParts(parts, chunkPairs = CHUNK_PAIRS_DEFAULT) {
    const st = new PairStore({ chunkPairs });
    for (const p of parts) {
      st.chunks.push({ ud: p.ud, iv: p.iv });
      st.count += p.count;
    }
    return st;
  }
}

/**
 * Счётчики потерь и оценка пропущенных пар.
 *
 * Поток 0x3A не содержит номеров блоков, поэтому точная детекция возможна только по счётчикам
 * прибора (CMD_DEV_STA) — либо, в будущем, по номерам блоков (0x3B, проект Этапа 2).
 *
 * Оценка «сколько пар пропущено» = (блоков записано + блоков потеряно) × пар_в_блоке − принято пар.
 * В эту величину входит конвейерный задел (FIFO прибора + буферы драйвера, ~4 КБ ≈ 570 пар
 * при pktcnt=20 — измерено на Этапе 1), поэтому значения меньше ~1000 пар потерей не являются.
 * Чтобы уменьшить задел, снимок счётчиков на остановке делается после дренажа порта.
 */
export class LossTracker {
  constructor(pairsPerBlock = 10) {
    this.pairsPerBlock = pairsPerBlock;
    this.snapshots = [];      // [{counters, pairs, blocks}]
    this.blocks = 0;          // принято кадров 0x3A
    this.pairs = 0;           // принято пар
    this.misaligned = 0;      // кадры с нарушением выравнивания
    this.deviceErrors = 0;
    this.seqGaps = 0;         // разрывы номеров блоков (если прошивка пришлёт 0x3B)
    this.lastSeq = null;
    this.seqLostBlocks = 0;
  }

  /** Снимок счётчиков прибора (вызывается на старте, по ходу и на остановке). */
  snapshot(counters) {
    if (!counters) return;
    this.snapshots.push({ counters: { ...counters }, pairs: this.pairs, blocks: this.blocks });
    if (this.snapshots.length > 64) this.snapshots.splice(1, this.snapshots.length - 32);
  }

  /** Учёт номера блока из 0x3B (резерв на будущее): разрыв = потеря. */
  noteSeq(seq) {
    if (this.lastSeq !== null) {
      const gap = (seq - this.lastSeq) & 0xFFFF;
      if (gap > 1) {
        this.seqGaps++;
        this.seqLostBlocks += gap - 1;
      }
    }
    this.lastSeq = seq;
  }

  get estimate() {
    const n = this.snapshots.length;
    if (n < 2) return null;
    const a = this.snapshots[0], b = this.snapshots[n - 1];
    const ca = a.counters, cb = b.counters;
    if (ca.blocksWritten == null || cb.blocksWritten == null ||
        ca.blocksDropped == null || cb.blocksDropped == null) return null;
    const written = cb.blocksWritten - ca.blocksWritten;
    const dropped = cb.blocksDropped - ca.blocksDropped;
    const pairsDelta = b.pairs - a.pairs;
    const producedPairs = (written + dropped) * this.pairsPerBlock;
    return {
      blocksWritten: written,
      blocksDropped: dropped,
      pairsReceived: pairsDelta,
      pairsProduced: producedPairs,
      missingPairsUpperBound: Math.max(0, producedPairs - pairsDelta),
      pipelineNote: 'включает конвейерный задел (FIFO + драйвер, ~4 КБ)',
    };
  }

  get summary() {
    return {
      pairs: this.pairs,
      blocks: this.blocks,
      misaligned: this.misaligned,
      deviceErrors: this.deviceErrors,
      seqGaps: this.seqGaps,
      seqLostBlocks: this.seqLostBlocks,
      countersStart: this.snapshots.length ? this.snapshots[0].counters : null,
      countersEnd: this.snapshots.length ? this.snapshots[this.snapshots.length - 1].counters : null,
      // счётчики прошивки с правками Этапа 2 (у старой прошивки их нет — null)
      readsLostRing: this.snapshots.length ? this.snapshots[this.snapshots.length - 1].counters.readsLostRing : null,
      i2cErrors: this.snapshots.length ? this.snapshots[this.snapshots.length - 1].counters.i2cErrors : null,
      estimate: this.estimate,
    };
  }
}
