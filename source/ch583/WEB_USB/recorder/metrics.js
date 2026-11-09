/**
 * Метрики окна и всей записи (Этап 4).
 *
 * Требование плана: «для точных min/max обрабатывать неполные граничные LOD-бакеты».
 * Поэтому экстремумы считаются так:
 *   * края окна (частично попавшие бакеты) читаются по СЫРЫМ парам — точно;
 *   * середина берётся из LOD-бакетов, целиком попавших в окно (их min/max уже точны);
 *   * если окно меньше двух бакетов, всё считается по сырым парам.
 * Результат совпадает с brute-force при любой длине записи (проверено тестами).
 *
 * Средние значения в пирамиде не хранятся: `avgU/avgI` считаются по сырым парам окна
 * (O(длины окна)) и только когда их явно запросили — per-frame они не нужны.
 */

/** Точные метрики диапазона [from, to) по сырым парам. */
export function rawMetrics(source, from, to) {
  let minU = null, maxU = null, minI = null, maxI = null;
  let sumU = 0, sumI = 0, n = 0;
  let dioOr = 0, dioAnd = 0xFF, dioChanges = 0;
  let minUAt = -1, maxUAt = -1, minIAt = -1, maxIAt = -1;
  const start = Math.max(0, Math.floor(from));
  const end = Math.min(source.length, Math.ceil(to));
  // Смена маски считается на паре k, если mask(k) != mask(k-1). Для диапазона, начинающегося
  // не с нуля, «предыдущей» считается пара start-1 — та же семантика, что в LOD-пирамиде,
  // иначе суммы по бакетам не совпадали бы с brute-force на границах диапазонов.
  let prevDio = start > 0 && start < source.length ? source.dio(start - 1) : null;
  for (let k = start; k < end; k++) {
    const u = source.u(k), i = source.i(k), d = source.dio(k);
    if (minU === null || u < minU) { minU = u; minUAt = k; }
    if (maxU === null || u > maxU) { maxU = u; maxUAt = k; }
    if (minI === null || i < minI) { minI = i; minIAt = k; }
    if (maxI === null || i > maxI) { maxI = i; maxIAt = k; }
    sumU += u; sumI += i; n++;
    dioOr |= d;
    dioAnd &= d;
    if (prevDio !== null && prevDio !== d) dioChanges++;
    prevDio = d;
  }
  return {
    pairs: n, minU, maxU, minI, maxI,
    avgU: n ? sumU / n : null, avgI: n ? sumI / n : null,
    minUAt, maxUAt, minIAt, maxIAt,
    dioOr, dioAnd: n ? dioAnd : 0, dioChanges,
    exact: true,
  };
}

/**
 * Точные экстремумы и активность DIO для окна [from, to) — быстро, по пирамиде + сырые края.
 * @returns {{pairs:number,minU,maxU,minI,maxI,minUAt,maxUAt,minIAt,maxIAt,dioOr,dioAnd,dioChanges,exact:boolean,level:number}}
 */
export function windowExtrema(pyramid, source, from, to) {
  from = Math.max(0, Math.floor(from));
  to = Math.min(source.length, Math.ceil(to));
  if (to <= from) {
    return { pairs: 0, minU: null, maxU: null, minI: null, maxI: null, minUAt: -1, maxUAt: -1,
             minIAt: -1, maxIAt: -1, dioOr: 0, dioAnd: 0, dioChanges: 0, exact: true, level: -1 };
  }

  let level = -1;
  for (let k = pyramid.levels.length - 1; k >= 0; k--) {
    if (pyramid.bucketPairs(k) * 2 <= (to - from) && pyramid.levels[k].capacity > 0) { level = k; break; }
  }
  if (level < 0) {
    const m = rawMetrics(source, from, to);
    return { ...m, level: -1 };
  }

  const bp = pyramid.bucketPairs(level);
  const l = pyramid.levels[level];
  const firstFull = Math.ceil(from / bp);
  const lastFull = Math.floor(to / bp) - 1;
  if (lastFull < firstFull) {
    const m = rawMetrics(source, from, to);
    return { ...m, level: -1 };
  }

  const headEnd = Math.min(firstFull * bp, to);
  const tailStart = Math.max((lastFull + 1) * bp, from);
  const head = rawMetrics(source, from, headEnd);
  const tail = rawMetrics(source, tailStart, to);

  let minU = null, maxU = null, minI = null, maxI = null;
  let minUAt = -1, maxUAt = -1, minIAt = -1, maxIAt = -1;
  let dioOr = 0, dioAnd = 0xFF, dioChanges = 0, n = 0;

  const merge = (m) => {
    if (!m || m.pairs === 0) return;
    if (minU === null || m.minU < minU) { minU = m.minU; minUAt = m.minUAt; }
    if (maxU === null || m.maxU > maxU) { maxU = m.maxU; maxUAt = m.maxUAt; }
    if (minI === null || m.minI < minI) { minI = m.minI; minIAt = m.minIAt; }
    if (maxI === null || m.maxI > maxI) { maxI = m.maxI; maxIAt = m.maxIAt; }
    n += m.pairs;
    dioOr |= m.dioOr;
    dioAnd &= m.dioAnd;
    dioChanges += m.dioChanges;
  };
  merge(head);

  for (let b = firstFull; b <= lastFull && b < l.capacity; b++) {
    if (l.minU[b] === 0xFFFFFFFF) continue;
    if (minU === null || l.minU[b] < minU) { minU = l.minU[b]; minUAt = b * bp; }
    if (maxU === null || l.maxU[b] > maxU) { maxU = l.maxU[b]; maxUAt = b * bp; }
    if (minI === null || l.minI[b] < minI) { minI = l.minI[b]; minIAt = b * bp; }
    if (maxI === null || l.maxI[b] > maxI) { maxI = l.maxI[b]; maxIAt = b * bp; }
    dioOr |= l.dioOr[b];
    dioAnd &= l.dioAnd[b];
    dioChanges += l.dioChanges[b];
    n += Math.min(bp, to - b * bp);
  }
  merge(tail);

  return { pairs: n, minU, maxU, minI, maxI, minUAt, maxUAt, minIAt, maxIAt,
           dioOr, dioAnd: n ? dioAnd : 0, dioChanges, exact: true, level };
}

/**
 * Метрики окна для панели интерфейса: экстремумы (точно, быстро) + средние (по сырым парам,
 * только если `withAvg` и окно не слишком большое).
 */
export function windowMetrics(pyramid, source, from, to, opts = {}) {
  const ext = windowExtrema(pyramid, source, from, to);
  const out = { ...ext, avgU: null, avgI: null, avgExact: false };
  const maxPairsForAvg = opts.maxPairsForAvg ?? 2_000_000;
  if (opts.withAvg && ext.pairs > 0 && ext.pairs <= maxPairsForAvg) {
    const raw = rawMetrics(source, from, to);
    out.avgU = raw.avgU;
    out.avgI = raw.avgI;
    out.avgExact = true;
  }
  return out;
}

/** Метрики всей записи (по верхнему уровню пирамиды) + перевод в физические величины. */
export function recordMetrics(pyramid, calib) {
  const t = pyramid.totals;
  const kb = calib ? calib.k_bus_mv_per_code : 0.01220703125;
  const ki = calib ? calib.k_shunt_ma_per_code : 0.00001953125;
  return {
    ...t,
    minU_mV: t.minU === null ? null : t.minU * kb,
    maxU_mV: t.maxU === null ? null : t.maxU * kb,
    minI_mA: t.minI === null ? null : t.minI * ki,
    maxI_mA: t.maxI === null ? null : t.maxI * ki,
  };
}
