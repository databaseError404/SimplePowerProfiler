/**
 * LOD-пирамида (Этап 4): min/max-энвелопа U/I + активность DIO.
 *
 * Зачем: стоимость кадра должна зависеть от числа пикселей и выбранного уровня, а не от длины
 * записи. Пирамида строится инкрементально во время записи и в фоне при открытии файла.
 *
 * Уровень 0 — бакеты по `base` пар (по умолчанию 64), уровень k — бакеты по `base * 2^k`.
 * На каждый бакет хранится:
 *   minU/maxU — U24 без знака, minI/maxI — I24 со знаком;
 *   dioOr     — объединение масок DIO за бакет (какие линии были активны);
 *   dioAnd    — пересечение масок (какие линии держались высокими всё время);
 *   dioChanges — сколько раз маска менялась внутри бакета.
 * По dioChanges/dioOr прореживание показывает АКТИВНОСТЬ, а не усреднённый уровень:
 * импульс шириной в одну пару не исчезает ни на одном уровне.
 *
 * Стоимость добавления пары амортизированно ~2 обновления бакетов (уровень 0 всегда,
 * родитель — только когда бакет завершился).
 */

export const LOD_BASE = 64;
const BYTES_PER_BUCKET = 4 + 4 + 4 + 4 + 1 + 1 + 2 + 1 + 1 + 4 + 4;   // + mask, meanU, meanI

function makeLevel(bucketPairs, capacity) {
  return {
    bucketPairs,
    capacity,
    minU: new Uint32Array(capacity).fill(0xFFFFFFFF),
    maxU: new Uint32Array(capacity),
    minI: new Int32Array(capacity).fill(0x7FFFFFFF),
    maxI: new Int32Array(capacity).fill(-0x80000000),
    dioOr: new Uint8Array(capacity),
    dioAnd: new Uint8Array(capacity).fill(0xFF),
    dioChanges: new Uint16Array(capacity),
    // Какие ИМЕННО линии менялись внутри бакета (битовая маска). Нужно для отрисовки:
    // если в колонке менялась другая линия, ровный уровень этой линии не должен «дробиться».
    dioChangedMask: new Uint8Array(capacity),
    // Средние значения (для главной линии графика: envelope при шумном сигнале читается плохо).
    // Хранится целочисленное среднее, обновляется «бегущим» способом без накопления суммы.
    meanU: new Uint32Array(capacity),
    meanI: new Int32Array(capacity),
    seen: new Uint8Array(capacity),
  };
}

function growLevel(level, capacity) {
  const grow = (arr, Ctor, fill) => {
    const a = new Ctor(capacity);
    if (fill !== undefined) a.fill(fill);
    a.set(arr);
    return a;
  };
  level.minU = grow(level.minU, Uint32Array, 0xFFFFFFFF);
  level.maxU = grow(level.maxU, Uint32Array);
  level.minI = grow(level.minI, Int32Array, 0x7FFFFFFF);
  level.maxI = grow(level.maxI, Int32Array, -0x80000000);
  level.dioOr = grow(level.dioOr, Uint8Array);
  level.dioAnd = grow(level.dioAnd, Uint8Array, 0xFF);
  level.dioChanges = grow(level.dioChanges, Uint16Array);
  level.dioChangedMask = grow(level.dioChangedMask, Uint8Array);
  level.meanU = grow(level.meanU, Uint32Array);
  level.meanI = grow(level.meanI, Int32Array);
  level.seen = grow(level.seen, Uint8Array);
  level.capacity = capacity;
}

export class LodPyramid {
  /**
   * @param {object} [opts]
   * @param {number} [opts.base=64]            пар в бакете уровня 0
   * @param {number} [opts.initialPairs=65536] начальная ёмкость уровня 0
   * @param {number} [opts.maxLevels=16]
   */
  constructor(opts = {}) {
    this.base = opts.base || LOD_BASE;
    if ((this.base & (this.base - 1)) !== 0) throw new Error('base должен быть степенью двойки');
    this.maxLevels = opts.maxLevels || 12;
    this.levels = [makeLevel(this.base, Math.max(1, Math.ceil((opts.initialPairs || 65536) / this.base)))];
    this.count = 0;
    this._lastDio = null;
  }

  get pairs() {
    return this.count;
  }

  /** Сколько уровней содержат данные. */
  get depth() {
    return this.levels.length;
  }

  /** Приблизительный объём памяти пирамиды, байт. */
  get bytes() {
    let sum = 0;
    for (const l of this.levels) sum += l.capacity * BYTES_PER_BUCKET;
    return sum;
  }

  reset() {
    this.levels = [makeLevel(this.base, this.levels[0].capacity)];
    this.count = 0;
    this._lastDio = null;
  }

  _level(k) {
    while (this.levels.length <= k && this.levels.length < this.maxLevels) {
      const prev = this.levels[this.levels.length - 1];
      this.levels.push(makeLevel(prev.bucketPairs * 2, Math.max(1, Math.ceil(prev.capacity / 2))));
    }
    return this.levels[k];
  }

  _updateBucket(l, b, u, i, d, changedMask, n) {
    if (b >= l.capacity) growLevel(l, Math.max(b + 1, l.capacity * 2));
    if (u < l.minU[b]) l.minU[b] = u;
    if (u > l.maxU[b]) l.maxU[b] = u;
    if (i < l.minI[b]) l.minI[b] = i;
    if (i > l.maxI[b]) l.maxI[b] = i;
    // целочисленное «бегущее» среднее: mean += round((v - mean) / n)
    if (n <= 1) { l.meanU[b] = u; l.meanI[b] = i; }
    else {
      l.meanU[b] += Math.round((u - l.meanU[b]) / n);
      l.meanI[b] += Math.round((i - l.meanI[b]) / n);
    }
    l.dioOr[b] |= d;
    if (l.seen[b]) l.dioAnd[b] &= d; else { l.dioAnd[b] = d; l.seen[b] = 1; }
    if (changedMask) {
      if (l.dioChanges[b] < 0xFFFF) l.dioChanges[b] += 1;
      l.dioChangedMask[b] |= changedMask;
    }
  }

  /** Влить агрегат дочернего бакета в родительский (не используется при прямой агрегации). */
  _mergeBucket(parent, pb, child, cb) {
    if (pb >= parent.capacity) growLevel(parent, Math.max(pb + 1, parent.capacity * 2));
    if (child.minU[cb] < parent.minU[pb]) parent.minU[pb] = child.minU[cb];
    if (child.maxU[cb] > parent.maxU[pb]) parent.maxU[pb] = child.maxU[cb];
    if (child.minI[cb] < parent.minI[pb]) parent.minI[pb] = child.minI[cb];
    if (child.maxI[cb] > parent.maxI[pb]) parent.maxI[pb] = child.maxI[cb];
    parent.dioOr[pb] |= child.dioOr[cb];
    if (parent.seen[pb]) parent.dioAnd[pb] &= child.dioAnd[cb];
    else { parent.dioAnd[pb] = child.dioAnd[cb]; parent.seen[pb] = 1; }
    parent.dioChangedMask[pb] |= child.dioChangedMask[cb];
    // родитель только что создан (первый бакет): его среднее — среднее двух детей
    parent.meanU[pb] = Math.round((child.meanU[cb] + child.meanU[cb + 1 < child.capacity ? cb + 1 : cb]) / 2);
    parent.meanI[pb] = Math.round((child.meanI[cb] + child.meanI[cb + 1 < child.capacity ? cb + 1 : cb]) / 2);
    const ch = parent.dioChanges[pb] + child.dioChanges[cb];
    parent.dioChanges[pb] = ch > 0xFFFF ? 0xFFFF : ch;
  }

  /**
   * Добавить одну пару (горячий путь при записи).
   *
   * Пара обновляет бакет каждого существующего уровня, поэтому неполные бакеты (в конце записи
   * и на каждом уровне) сразу содержат корректный агрегат — запросам не нужна особая обработка.
   * Новый уровень создаётся только когда у верхнего уровня завершился первый бакет, и его
   * агрегат сразу собирается из двух готовых дочерних бакетов (без потери данных).
   *
   * Смена маски DIO считается на паре k, если mask(k) != mask(k-1); тогда счётчики уровней
   * суммируются без потери граничных смен (та же семантика в `rawMetrics`).
   */
  addPair(u, i, dio) {
    const uu = u & 0xFFFFFF;
    const ii = (i << 8) >> 8;
    const d = dio & 0xFF;
    // маска линий, изменившихся на этой паре (для отрисовки ровных уровней без «зубцов»)
    const changedMask = this._lastDio === null ? 0 : (this._lastDio ^ d);
    const idx = this.count;

    for (let level = 0; level < this.levels.length; level++) {
      const l = this.levels[level];
      const b = Math.floor(idx / l.bucketPairs);
      this._updateBucket(l, b, uu, ii, d, changedMask, idx - b * l.bucketPairs + 1);
    }

    // расширение пирамиды вверх: когда первый бакет верхнего уровня заполнился
    const top = this.levels[this.levels.length - 1];
    if (idx + 1 === top.bucketPairs * 2 && this.levels.length < this.maxLevels) {
      const parent = this._level(this.levels.length);
      this._mergeBucket(parent, 0, top, 0);
      this._mergeBucket(parent, 0, top, 1);
    }

    this.count = idx + 1;
    this._lastDio = d;
  }

  /** Добавить диапазон пар из источника (PairStore или RecordFile). */
  addFrom(source, from, to) {
    for (let k = from; k < to; k++) this.addPair(source.u(k), source.i(k), source.dio(k));
  }

  /**
   * Полная (пере)сборка из источника порциями — чтобы не блокировать поток.
   * @param {{u:Function,i:Function,dio:Function,length:number}} source
   * @param {{chunkPairs?:number, onProgress?:Function, yieldTo?:Function}} [opts]
   */
  async buildFrom(source, opts = {}) {
    const chunk = opts.chunkPairs || 250_000;
    this.reset();
    const total = source.length;
    for (let off = 0; off < total; off += chunk) {
      const to = Math.min(off + chunk, total);
      for (let k = off; k < to; k++) this.addPair(source.u(k), source.i(k), source.dio(k));
      if (opts.onProgress) opts.onProgress(to, total);
      if (opts.yieldTo) await opts.yieldTo();
    }
    return this;
  }

  /** Размер бакета уровня в парах. */
  bucketPairs(level) {
    return this.base * (1 << level);
  }

  /** Бакет уровня, содержащий пару (или null, если данных нет). */
  bucketOf(level, pairIndex) {
    const l = this.levels[level];
    if (!l || pairIndex >= this.count) return null;
    const b = Math.floor(pairIndex / l.bucketPairs);
    if (b >= l.capacity || l.minU[b] === 0xFFFFFFFF) return null;
    return {
      level, index: b, bucketPairs: l.bucketPairs,
      from: b * l.bucketPairs, to: Math.min((b + 1) * l.bucketPairs, this.count),
      minU: l.minU[b], maxU: l.maxU[b], minI: l.minI[b], maxI: l.maxI[b],
      meanU: l.meanU[b], meanI: l.meanI[b],
      dioOr: l.dioOr[b], dioAnd: l.dioAnd[b], dioChanges: l.dioChanges[b],
      dioChangedMask: l.dioChangedMask[b],
    };
  }

  /** Метрики всей записи: верхний заполненный уровень (он покрывает всё) + число смен DIO. */
  get totals() {
    let minU = 0xFFFFFFFF, maxU = 0, minI = 0x7FFFFFFF, maxI = -0x80000000;
    let dioOr = 0, dioChanges = 0;
    for (let level = this.levels.length - 1; level >= 0; level--) {
      const l = this.levels[level];
      const buckets = Math.ceil(this.count / l.bucketPairs);
      if (buckets === 0) continue;
      for (let b = 0; b < buckets && b < l.capacity; b++) {
        if (l.minU[b] === 0xFFFFFFFF) continue;
        if (l.minU[b] < minU) minU = l.minU[b];
        if (l.maxU[b] > maxU) maxU = l.maxU[b];
        if (l.minI[b] < minI) minI = l.minI[b];
        if (l.maxI[b] > maxI) maxI = l.maxI[b];
        dioOr |= l.dioOr[b];
        dioChanges += l.dioChanges[b];
      }
      break;    // верхнего заполненного уровня достаточно
    }
    return {
      pairs: this.count,
      minU: minU === 0xFFFFFFFF ? null : minU,
      maxU: maxU === 0xFFFFFFFF ? null : maxU,
      minI: minI === 0x7FFFFFFF ? null : minI,
      maxI: maxI === 0x7FFFFFFF ? null : maxI,
      dioOr, dioChanges,
    };
  }
}

/**
 * Подготовка данных для отрисовки: по одной записи на колонку пикселей.
 *
 * Если на колонку приходится не больше `base` пар (64), читаются СЫРЫЕ пары — это точный режим:
 * энвелопа и уровни DIO без прореживания. Иначе берётся уровень пирамиды с бакетом ≤ шага колонки,
 * и данные — min/max-энвелопа плюс активность DIO (объединение/пересечение масок и число смен).
 *
 * Стоимость O(число колонок × base) в точном режиме и O(число колонок) в режиме пирамиды —
 * то есть не зависит от длины записи.
 */
export function buildColumns(pyramid, source, { from, to, columns, forceLod = false } = {}) {
  const span = Math.max(1, to - from);
  const step = span / columns;
  const out = {
    raw: false, columns, step, from, to, level: -1, filled: 0,
    minU: new Int32Array(columns), maxU: new Int32Array(columns),
    minI: new Int32Array(columns), maxI: new Int32Array(columns),
    meanU: new Int32Array(columns), meanI: new Int32Array(columns),
    dioOr: new Uint8Array(columns), dioAnd: new Uint8Array(columns),
    dioChanges: new Uint8Array(columns),
    // Какие линии менялись в колонке (по битам). Именно это, а не dioChanges, определяет,
    // когда ровный уровень линии рисуется линией, а когда — меткой активности.
    dioChangedMask: new Uint8Array(columns),
    dioExact: null,
  };
  const colCount = new Uint32Array(columns);   // сколько пар попало в колонку (для средних)
  for (let c = 0; c < columns; c++) {
    out.minU[c] = 0x7FFFFFFF; out.maxU[c] = -0x7FFFFFFF;
    out.minI[c] = 0x7FFFFFFF; out.maxI[c] = -0x7FFFFFFF;
    out.dioAnd[c] = 0xFF;
  }

  // Точный режим: если на колонку приходится не больше `base` пар, дешевле (и точнее)
  // прочитать сырые пары — тогда и DIO показывается настоящим уровнем.
  // forceLod=true — для обзора: он мелкий, и читать ради него всю запись незачем.
  if (!forceLod && step <= pyramid.base) {
    out.raw = true;
    const exactDio = step <= 1;
    if (exactDio) out.dioExact = new Uint8Array(columns);
    let prev = from > 0 ? source.dio(from - 1) : null;
    const end = Math.min(to, source.length);
    for (let k = from; k < end; k++) {
      const u = source.u(k), i = source.i(k), d = source.dio(k);
      // Пара может занимать НЕСКОЛЬКО колонок (при сильном зуме) — заполняем их все,
      // иначе незаполненные колонки выглядели бы как уровень 0 («зубцы»).
      const c0 = Math.min(columns - 1, Math.max(0, Math.floor((k - from) / step)));
      const c1 = Math.min(columns - 1, Math.max(c0, Math.floor((k + 1 - from) / step - 1e-9)));
      for (let c = c0; c <= c1; c++) {
        if (u < out.minU[c]) out.minU[c] = u;
        if (u > out.maxU[c]) out.maxU[c] = u;
        if (i < out.minI[c]) out.minI[c] = i;
        if (i > out.maxI[c]) out.maxI[c] = i;
        // точный режим: бегущее среднее по фактическому числу пар в колонке
        const n = ++colCount[c];
        out.meanU[c] += Math.round((u - out.meanU[c]) / n);
        out.meanI[c] += Math.round((i - out.meanI[c]) / n);
        out.dioOr[c] |= d;
        out.dioAnd[c] &= d;
        if (exactDio) out.dioExact[c] = d;
        if (out.filled < c + 1) out.filled = c + 1;
      }
      // смена маски учитывается один раз — в первой колонке пары
      if (prev !== null && prev !== d) {
        if (out.dioChanges[c0] < 255) out.dioChanges[c0]++;
        out.dioChangedMask[c0] |= (prev ^ d);
      }
      prev = d;
    }
    return out;
  }

  // уровень: бакет не крупнее шага колонки, но не глубже доступных данных
  let level = 0;
  while (level + 1 < pyramid.levels.length && pyramid.bucketPairs(level + 1) <= step) level++;
  out.level = level;

  const bucketPairs = pyramid.bucketPairs(level);
  const l = pyramid.levels[level];
  const firstBucket = Math.floor(from / bucketPairs);
  const lastBucket = Math.min(Math.floor((to - 1) / bucketPairs), Math.ceil(pyramid.count / bucketPairs) - 1,
                              l.capacity - 1);

  for (let b = firstBucket; b <= lastBucket; b++) {
    if (b < 0 || l.minU[b] === 0xFFFFFFFF) continue;
    const bStart = b * bucketPairs;
    const cStart = Math.max(0, Math.floor((bStart - from) / step));
    const cEnd = Math.min(columns - 1, Math.floor((bStart + bucketPairs - 1 - from) / step));
    for (let c = cStart; c <= cEnd; c++) {
      if (l.minU[b] < out.minU[c]) out.minU[c] = l.minU[b];
      if (l.maxU[b] > out.maxU[c]) out.maxU[c] = l.maxU[b];
      if (l.minI[b] < out.minI[c]) out.minI[c] = l.minI[b];
      if (l.maxI[b] > out.maxI[c]) out.maxI[c] = l.maxI[b];
      // среднее по колонке: взвешенно по числу пар каждого бакета
      const w = Math.min(bucketPairs, to - b * bucketPairs);
      const nc = colCount[c] + w;
      out.meanU[c] = Math.round((out.meanU[c] * colCount[c] + l.meanU[b] * w) / nc);
      out.meanI[c] = Math.round((out.meanI[c] * colCount[c] + l.meanI[b] * w) / nc);
      colCount[c] = nc;
      out.dioOr[c] |= l.dioOr[b];
      out.dioAnd[c] &= l.dioAnd[b];
      out.dioChangedMask[c] |= l.dioChangedMask[b];
      const ch = l.dioChanges[b] + out.dioChanges[c];
      out.dioChanges[c] = ch > 255 ? 255 : ch;
      if (out.filled < c + 1) out.filled = c + 1;
    }
  }
  return out;
}
