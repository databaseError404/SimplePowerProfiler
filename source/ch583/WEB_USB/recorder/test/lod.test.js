/**
 * Тесты LOD-пирамиды и метрик (Этап 4).
 * Ключевое требование приёмки: экстремумы LOD равны brute-force, включая всплески
 * и неполные граничные бакеты; импульс DIO шириной в одну пару виден на всех уровнях.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LodPyramid, buildColumns, LOD_BASE } from '../lod.js';
import { dioLaneModel, computeScales } from '../render.js';
import { rawMetrics, windowExtrema, windowMetrics, recordMetrics } from '../metrics.js';
import { PairStore } from '../store.js';
import { makeRng } from './synth.js';

/** Хранилище с данными и «всплесками»: одиночные экстремумы в заданных парах. */
function makeSource(n, { seed = 3, spikes = {}, dioPulse = null } = {}) {
  const rng = makeRng(seed);
  const st = new PairStore({ chunkPairs: 1024 });
  for (let k = 0; k < n; k++) {
    let u = 270000 + Math.floor(rng() * 2000) - 1000;
    let i = Math.floor(rng() * 400) - 200;
    let dio = (k % 500 < 3) ? 0x01 : 0x00;
    if (spikes[k]) {
      if (spikes[k].u !== undefined) u = spikes[k].u;
      if (spikes[k].i !== undefined) i = spikes[k].i;
    }
    if (dioPulse && k === dioPulse.at) dio = dioPulse.mask;
    st.append(u & 0xFFFFFF, i, dio);
  }
  return st;
}

function bruteForce(source, from, to) {
  return rawMetrics(source, from, to);
}

test('LOD: экстремумы каждого бакета равны brute-force (со всплесками)', () => {
  const n = 5000;
  const spikes = {
    0: { u: 0xFFFFFF, i: -0x800000 },          // первый бакет
    63: { u: 0, i: 0x7FFFFF },                 // конец первого бакета
    64: { u: 0x800000, i: -1 },                // начало второго
    [n - 1]: { u: 0xFFFFFF, i: -0x800000 },    // последняя пара (неполный бакет)
    1234: { u: 0x123456, i: -123456 },
  };
  const src = makeSource(n, { spikes });
  const py = new LodPyramid();
  py.addFrom(src, 0, n);

  assert.equal(py.pairs, n);
  for (let level = 0; level < py.levels.length; level++) {
    const bp = py.bucketPairs(level);
    const buckets = Math.ceil(n / bp);
    for (let b = 0; b < buckets; b++) {
      const from = b * bp;
      const to = Math.min((b + 1) * bp, n);
      const want = bruteForce(src, from, to);
      const got = py.bucketOf(level, from);
      assert.ok(got, `уровень ${level}, бакет ${b} должен существовать`);
      assert.equal(got.minU, want.minU, `minU: уровень ${level}, бакет ${b}`);
      assert.equal(got.maxU, want.maxU, `maxU: уровень ${level}, бакет ${b}`);
      assert.equal(got.minI, want.minI, `minI: уровень ${level}, бакет ${b}`);
      assert.equal(got.maxI, want.maxI, `maxI: уровень ${level}, бакет ${b}`);
      assert.equal(got.dioOr, want.dioOr, `dioOr: уровень ${level}, бакет ${b}`);
      assert.equal(got.dioChanges, want.dioChanges, `смены DIO: уровень ${level}, бакет ${b}`);
    }
  }
});

test('LOD: смена DIO ровно на границе бакета считается одинаково с brute-force', () => {
  // Регресс: смена маски на ПЕРВОЙ паре бакета должна попадать в счётчик этого бакета
  // (семантика «mask(k) != mask(k-1)»), иначе суммы по уровням не сходятся с brute-force.
  const n = 4096;
  const src = makeSource(n, { seed: 21 });
  // маска меняется каждые 64 пары — ровно на границах бакетов уровня 0
  const st = new PairStore({ chunkPairs: 1024 });
  for (let k = 0; k < n; k++) {
    st.append(270000 + (k % 97), (k % 51) - 25, (k >> 6) & 1 ? 0x02 : 0x00);
  }
  void src;
  const py = new LodPyramid();
  py.addFrom(st, 0, n);
  for (let level = 0; level < py.levels.length; level++) {
    const bp = py.bucketPairs(level);
    for (let b = 0; b * bp < n; b++) {
      const from = b * bp, to = Math.min((b + 1) * bp, n);
      const want = rawMetrics(st, from, to);
      const got = py.bucketOf(level, from);
      assert.equal(got.dioChanges, want.dioChanges,
        `смены DIO: уровень ${level}, бакет ${b} [${from},${to})`);
      assert.equal(got.dioOr, want.dioOr, `dioOr: уровень ${level}, бакет ${b}`);
      assert.equal(got.minU, want.minU, `minU: уровень ${level}, бакет ${b}`);
      assert.equal(got.maxI, want.maxI, `maxI: уровень ${level}, бакет ${b}`);
    }
  }
});

test('LOD: метрики всей записи совпадают с brute-force', () => {
  const n = 3333;
  const src = makeSource(n, { spikes: { 0: { u: 0xFFFFFF }, 3332: { i: -0x800000 }, 1500: { u: 5 } } });
  const py = new LodPyramid();
  py.addFrom(src, 0, n);
  const want = bruteForce(src, 0, n);
  const got = py.totals;
  assert.equal(got.minU, want.minU);
  assert.equal(got.maxU, want.maxU);
  assert.equal(got.minI, want.minI);
  assert.equal(got.maxI, want.maxI);
  assert.equal(got.dioOr, want.dioOr);
  assert.equal(got.dioChanges, want.dioChanges);
  assert.equal(got.pairs, n);
});

test('LOD: инкрементальная сборка = полная пересборка (разные порции)', () => {
  const n = 20000;
  const src = makeSource(n, { seed: 11 });
  const inc = new LodPyramid();
  const rng = makeRng(7);
  let off = 0;
  while (off < n) {
    const step = 1 + Math.floor(rng() * 777);
    inc.addFrom(src, off, Math.min(off + step, n));
    off += step;
  }
  const full = new LodPyramid();
  full.addFrom(src, 0, n);

  assert.equal(inc.pairs, full.pairs);
  assert.equal(inc.levels.length, full.levels.length);
  for (let level = 0; level < full.levels.length; level++) {
    const a = inc.levels[level], b = full.levels[level];
    const buckets = Math.ceil(n / b.bucketPairs);
    for (let k = 0; k < buckets; k++) {
      assert.equal(a.minU[k], b.minU[k], `minU уровень ${level} бакет ${k}`);
      assert.equal(a.maxU[k], b.maxU[k], `maxU уровень ${level} бакет ${k}`);
      assert.equal(a.minI[k], b.minI[k], `minI уровень ${level} бакет ${k}`);
      assert.equal(a.maxI[k], b.maxI[k], `maxI уровень ${level} бакет ${k}`);
      assert.equal(a.dioOr[k], b.dioOr[k], `dioOr уровень ${level} бакет ${k}`);
      assert.equal(a.dioChanges[k], b.dioChanges[k], `смены уровень ${level} бакет ${k}`);
    }
  }
});

test('DIO: импульс шириной в одну пару виден на всех уровнях и точно на zoom', () => {
  const n = 10000;
  const pulseAt = 4321;
  const src = makeSource(n, { dioPulse: { at: pulseAt, mask: 0x08 } });
  const py = new LodPyramid();
  py.addFrom(src, 0, n);

  for (let level = 0; level < py.levels.length; level++) {
    const got = py.bucketOf(level, pulseAt);
    assert.ok(got, `уровень ${level}: бакет с импульсом должен существовать`);
    assert.equal(got.dioOr & 0x08, 0x08, `уровень ${level}: импульс должен быть виден в dioOr`);
    assert.ok(got.dioChanges >= 2, `уровень ${level}: должны быть видны две смены (вкл/выкл)`);
    // соседний бакет не должен «унаследовать» импульс, если он его не содержит
    const nb = py.bucketOf(level, pulseAt + py.bucketPairs(level) * 3);
    if (nb) assert.equal(nb.dioOr & 0x08, 0, `уровень ${level}: ложное срабатывание в соседнем бакете`);
  }

  // обзор (много пар на колонку) — активность видна
  const wide = buildColumns(py, src, { from: 0, to: n, columns: 200 });
  let seen = false;
  for (let c = 0; c < wide.columns; c++) if (wide.dioOr[c] & 0x08) seen = true;
  assert.ok(seen, 'импульс должен быть виден на обзоре (dioOr)');

  // zoom: одна пара на колонку — точный уровень
  const zoom = buildColumns(py, src, { from: pulseAt - 3, to: pulseAt + 4, columns: 7 });
  assert.ok(zoom.raw, 'при зуме до отдельных пар должен включаться режим точных значений');
  assert.equal(zoom.dioExact[pulseAt - (pulseAt - 3)], 0x08);
  assert.equal(zoom.dioChanges[pulseAt - (pulseAt - 3)], 1);
  assert.equal(zoom.dioExact[0], 0x00);
});

test('buildColumns: энвелопа по колонкам равна brute-force по тем же диапазонам', () => {
  const n = 100000;
  const src = makeSource(n, { seed: 5, spikes: { 12345: { u: 0xFFFFFF }, 99999: { i: -0x800000 } } });
  const py = new LodPyramid();
  py.addFrom(src, 0, n);
  const columns = 800;
  const from = 1000, to = 90000;
  const cols = buildColumns(py, src, { from, to, columns });
  const step = (to - from) / columns;
  for (let c = 0; c < columns; c++) {
    const a = Math.floor(from + c * step);
    const b = Math.max(a + 1, Math.min(n, Math.floor(from + (c + 1) * step)));
    const want = bruteForce(src, a, b);
    if (want.pairs === 0) continue;
    // колонка может включать лишние пары на границах бакетов — проверяем, что энвелопа
    // не уже точной и не шире, чем диапазон колонки ± бакет
    const bp = py.bucketPairs(cols.level);
    const wide = bruteForce(src, Math.max(0, a - bp), Math.min(n, b + bp));
    assert.ok(cols.minU[c] <= want.minU && cols.maxU[c] >= want.maxU,
      `колонка ${c}: энвелопа должна покрывать точные значения`);
    assert.ok(cols.minU[c] >= wide.minU && cols.maxU[c] <= wide.maxU,
      `колонка ${c}: энвелопа не должна выходить за диапазон ± бакет`);
  }
});

test('метрики окна: точные экстремумы при неполных граничных бакетах', () => {
  const n = 50000;
  const src = makeSource(n, { seed: 9, spikes: { 100: { u: 0xFFFFFF }, 20000: { i: -0x800000 }, 49999: { u: 3 } } });
  const py = new LodPyramid();
  py.addFrom(src, 0, n);

  const cases = [
    [0, n], [1, n - 1], [63, 65], [64, 128], [100, 101], [12345, 23456], [19999, 20001], [n - 1, n],
  ];
  for (const [from, to] of cases) {
    const want = bruteForce(src, from, to);
    const got = windowExtrema(py, src, from, to);
    assert.equal(got.pairs, want.pairs, `пар в окне [${from},${to})`);
    assert.equal(got.minU, want.minU, `minU [${from},${to})`);
    assert.equal(got.maxU, want.maxU, `maxU [${from},${to})`);
    assert.equal(got.minI, want.minI, `minI [${from},${to})`);
    assert.equal(got.maxI, want.maxI, `maxI [${from},${to})`);
    assert.equal(got.dioOr, want.dioOr, `dioOr [${from},${to})`);
    assert.equal(got.dioChanges, want.dioChanges, `смены DIO [${from},${to})`);
  }
});

test('метрики окна: средние считаются только по запросу и точны', () => {
  const n = 20000;
  const src = makeSource(n, { seed: 13 });
  const py = new LodPyramid();
  py.addFrom(src, 0, n);
  const noAvg = windowMetrics(py, src, 100, 19000);
  assert.equal(noAvg.avgU, null, 'по умолчанию средние не считаются');
  const withAvg = windowMetrics(py, src, 100, 19000, { withAvg: true });
  const want = bruteForce(src, 100, 19000);
  assert.ok(Math.abs(withAvg.avgU - want.avgU) < 1e-9);
  assert.ok(Math.abs(withAvg.avgI - want.avgI) < 1e-9);
  assert.equal(withAvg.avgExact, true);
});

test('метрики записи: перевод в физические величины по калибровке', () => {
  const src = makeSource(1000, { seed: 2 });
  const py = new LodPyramid();
  py.addFrom(src, 0, 1000);
  const m = recordMetrics(py, { k_bus_mv_per_code: 0.01220703125, k_shunt_ma_per_code: 0.00001953125 });
  assert.ok(Math.abs(m.minU_mV - m.minU * 0.01220703125) < 1e-9);
  assert.ok(Math.abs(m.maxI_mA - m.maxI * 0.00001953125) < 1e-12);
});

test('память пирамиды: на порядок меньше сырых данных', () => {
  const n = 1_000_000;
  const src = makeSource(n, { seed: 4 });
  const py = new LodPyramid();
  py.addFrom(src, 0, n);
  const raw = src.bytes;
  assert.ok(py.bytes < raw / 4, `пирамида (${py.bytes}) должна быть заметно меньше сырых данных (${raw})`);
  assert.ok(py.bytes < 3 * 1024 * 1024, `пирамида на 1 млн пар не должна превышать 3 МиБ (получено ${py.bytes})`);
});

test('DIO: ровная линия не «дробится», если меняются другие линии', () => {
  // Регресс на «зубцы»: линия D3 стоит в 1, а меняются другие линии (как walk1 на стенде).
  const n = 4096;
  const st = new PairStore({ chunkPairs: 1024 });
  for (let k = 0; k < n; k++) {
    // каждые 256 пар меняется одна из линий D0/D1/D2; D3 держится в 1 всё время
    const phase = (k / 256) | 0;
    let dio = 0x08;
    if (phase % 3 === 0) dio |= 0x01;
    if (phase % 3 === 1) dio |= 0x02;
    if (phase % 3 === 2) dio |= 0x04;
    st.append(270000, 0, dio);
  }
  const py = new LodPyramid();
  py.addFrom(st, 0, n);

  for (const columns of [16, 64, 200, 800]) {
    const cols = buildColumns(py, st, { from: 0, to: n, columns });
    const model = dioLaneModel(cols, 3);
    assert.equal(model.activity.length, 0,
      `колонок ${columns}: у линии D3 нет смен — меток активности быть не должно`);
    // уровень высокий на всём диапазоне
    assert.ok(model.levels.length >= 1);
    const allHigh = model.levels.every((s) => s.on === true);
    assert.ok(allHigh, `колонок ${columns}: все отрезки D3 должны быть высокими`);
    // и линия непрерывна по колонкам
    const covered = model.levels.reduce((a, s) => a + (s.x1 - s.x0 + 1), 0);
    assert.equal(covered, cols.filled, `колонок ${columns}: уровень покрывает все колонки`);
  }

  // а линия D0 действительно меняется — у неё метки активности есть
  const cols = buildColumns(py, st, { from: 0, to: n, columns: 200 });
  const m0 = dioLaneModel(cols, 0);
  assert.ok(m0.activity.length > 0, 'у меняющейся линии метки активности должны быть');
});

test('DIO: импульс в одну пару внутри колонки помечается активностью', () => {
  const n = 2048;
  const st = new PairStore({ chunkPairs: 1024 });
  for (let k = 0; k < n; k++) st.append(270000, 0, k === 1000 ? 0x10 : 0x00);
  const py = new LodPyramid();
  py.addFrom(st, 0, n);
  const cols = buildColumns(py, st, { from: 0, to: n, columns: 32 });
  const model = dioLaneModel(cols, 4);
  assert.equal(model.activity.length, 1, 'должна быть ровно одна метка активности');
  assert.equal(model.activity[0].ever, true);
  const empty = dioLaneModel(cols, 5);
  assert.equal(empty.activity.length, 0, 'на неиспользуемой линии активности нет');
});

test('шкалы отображения: одиночный выброс не схлопывает сигнал (квантили)', () => {
  const cols = {
    columns: 100,
    minU: new Int32Array(100), maxU: new Int32Array(100),
    minI: new Int32Array(100), maxI: new Int32Array(100),
  };
  for (let c = 0; c < 100; c++) {
    cols.minU[c] = 270000 + c;
    cols.maxU[c] = 270100 + c;
    cols.minI[c] = -100 + c;
    cols.maxI[c] = 100 + c;
  }
  cols.maxU[50] = 0xFFFFFF;          // выброс U (сбойное чтение)
  cols.minI[51] = -0x800000;         // выброс I
  const calib = { k_bus_mv_per_code: 0.01220703125, k_shunt_ma_per_code: 0.00001953125 };
  const sc = computeScales(cols, calib);
  assert.ok(sc.u.clipped, 'выброс U должен помечаться как обрезанный');
  assert.ok(sc.i.clipped, 'выброс I должен помечаться как обрезанный');
  const uSpan = sc.u.b - sc.u.a;
  assert.ok(uSpan < 100, `диапазон U должен определяться данными, а не выбросом (получено ${uSpan.toFixed(1)} мВ)`);
  assert.ok(sc.u.full[1] > 100000, 'полный диапазон U сохраняется для метрик');
  // без выбросов ничего не обрезается
  cols.maxU[50] = 270150; cols.minI[51] = -50;
  const sc2 = computeScales(cols, calib);
  assert.equal(sc2.u.clipped, false);
  assert.equal(sc2.i.clipped, false);
});

test('шкалы отображения: режим наложения даёт общую шкалу', () => {
  const cols = {
    columns: 10,
    minU: new Int32Array(10).fill(270000), maxU: new Int32Array(10).fill(271000),
    minI: new Int32Array(10).fill(-500), maxI: new Int32Array(10).fill(500),
  };
  const calib = { k_bus_mv_per_code: 0.01220703125, k_shunt_ma_per_code: 0.00001953125 };
  const sc = computeScales(cols, calib, { overlay: true });
  assert.ok(sc.overlay);
  assert.equal(sc.overlay.a, Math.min(sc.u.a, sc.i.a));
  assert.equal(sc.overlay.b, Math.max(sc.u.b, sc.i.b));
});

test('средние в колонках: близки к brute-force и плавнее размаха', () => {
  const n = 20000;
  const st = new PairStore({ chunkPairs: 4096 });
  // сигнал: медленная «лестница» + шум, чтобы размах был заметно шире среднего
  let lfsr = 7;
  for (let k = 0; k < n; k++) {
    lfsr = (lfsr * 1664525 + 1013904223) >>> 0;
    const noise = ((lfsr >>> 9) & 0x3F) - 32;
    const step = Math.floor(k / 2000);
    st.append(270000 + step * 50 + noise, step * 20 + ((lfsr >>> 17) & 0x1F) - 16, 0);
  }
  const py = new LodPyramid();
  py.addFrom(st, 0, n);
  const columns = 400;
  const cols = buildColumns(py, st, { from: 0, to: n, columns });
  const step = n / columns;
  let maxErr = 0;
  let wider = 0;
  for (let c = 0; c < columns; c++) {
    const a = Math.floor(c * step);
    const b = Math.max(a + 1, Math.min(n, Math.floor((c + 1) * step)));
    const want = rawMetrics(st, a, b);
    const got = cols.meanU[c];
    maxErr = Math.max(maxErr, Math.abs(got - want.avgU));
    if (cols.maxU[c] - cols.minU[c] >= 2) wider++;
  }
  // Среднее хранится целочисленным «бегущим» способом (без накопления суммы — экономия памяти),
  // поэтому допускается несколько кодов: 5 кодов ≈ 1 мВ при 3.3 В — для графика незаметно.
  assert.ok(maxErr < 5, `среднее в колонке отличается от brute-force не более чем на 5 кодов (получено ${maxErr.toFixed(2)})`);
  assert.ok(wider > columns * 0.5, 'размах должен быть заметен в большинстве колонок (фон под линией среднего)');
  // среднее всегда внутри размаха
  for (let c = 0; c < columns; c++) {
    if (cols.minU[c] === 0x7FFFFFFF) continue;
    assert.ok(cols.meanU[c] >= cols.minU[c] - 1 && cols.meanU[c] <= cols.maxU[c] + 1,
      `колонка ${c}: среднее ${cols.meanU[c]} вне размаха ${cols.minU[c]}..${cols.maxU[c]}`);
  }
});
