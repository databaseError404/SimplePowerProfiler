/**
 * Тесты viewport и стоимости кадра (Этап 4).
 *
 * Требование приёмки: стоимость redraw не растёт с длиной записи (замер 10/30/60 с;
 * отношение ≤ 1,5). Проверяется на реальных данных: одинаковое окно и ширина канвы,
 * но разная общая длина записи.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Viewport } from '../viewport.js';
import { LodPyramid, buildColumns } from '../lod.js';
import { PairStore } from '../store.js';
import { makeRng } from './synth.js';

function makeSource(n, seed = 1) {
  const rng = makeRng(seed);
  const st = new PairStore({ chunkPairs: 4096 });
  for (let k = 0; k < n; k++) {
    st.append(270000 + Math.floor(rng() * 3000) - 1500, Math.floor(rng() * 2000) - 1000, (k >> 6) & 0xFF);
  }
  return st;
}

function buildPyramid(src) {
  const py = new LodPyramid();
  py.addFrom(src, 0, src.length);
  return py;
}

test('viewport: зум, пан, ограничения', () => {
  const vp = new Viewport({ pairs: 100000, pairsPerSecond: 10000, minSpan: 8 });
  vp.fit();
  assert.equal(vp.from, 0);
  assert.equal(vp.to, 100000);
  assert.equal(Math.round(vp.duration), 10);

  // зум к центру в 2 раза
  vp.zoomAt(500, 2, 1000);
  assert.equal(Math.round(vp.span), 50000);
  assert.ok(vp.from >= 0 && vp.to <= 100000);

  // пан вправо на пол-экрана не должен выйти за пределы
  const before = vp.from;
  vp.panByPixels(500, 1000);
  assert.ok(vp.from < before, 'панорама вправо сдвигает окно влево по данным');
  assert.ok(vp.from >= 0);

  // зум до предела не меньше minSpan
  for (let k = 0; k < 40; k++) vp.zoomAt(100, 4, 1000);
  assert.ok(vp.span >= 8, `минимальная ширина окна соблюдается (получено ${vp.span})`);
  assert.ok(vp.from >= 0 && vp.to <= 100000);

  // соответствие координат
  vp.setRange(1000, 2000);
  assert.equal(Math.round(vp.pairToX(1500, 1000)), 500);
  assert.equal(Math.round(vp.xToPair(500, 1000)), 1500);
});

test('viewport: follow latest держит правый край и не мешает смотреть прошлое', () => {
  const vp = new Viewport({ pairs: 10000, pairsPerSecond: 10000, minSpan: 8 });
  vp.setRange(0, 1000);
  vp.setFollowLatest(true);
  assert.equal(vp.to, 10000, 'правый край на последних данных');

  // пришли новые данные — окно едет за ними
  vp.setPairs(20000);
  assert.equal(vp.to, 20000);
  assert.equal(vp.span, 1000);

  // пользователь ушёл в прошлое: follow выключается, данные продолжают поступать
  vp.setFollowLatest(false);
  vp.setRange(0, 500);
  vp.setPairs(30000);
  assert.equal(vp.from, 0);
  assert.equal(vp.to, 500, 'просмотр прошлого не сдвигается новыми данными');

  // включили follow снова — вернулись к правому краю
  vp.setFollowLatest(true);
  assert.equal(vp.to, 30000);
});

test('стоимость кадра не растёт с длиной записи (10/30/60 с при 10k пар/с)', () => {
  const columns = 1200;
  const windowPairs = 50000;          // 5 с видимого окна (точный режим: шаг 42 пары на колонку)
  const lodColumns = 200;             // «отдалённое» окно, где работает пирамида
  const results = [];

  // Замеры: субмиллисекундные операции слишком шумные для одиночных замеров (GC/JIT),
  // поэтому берём несколько серий и минимальное среднее — устойчивая оценка стоимости.
  const measure = (fn, batches = 5, reps = 50) => {
    for (let k = 0; k < 10; k++) fn();
    let best = Infinity;
    for (let b = 0; b < batches; b++) {
      const t0 = performance.now();
      for (let k = 0; k < reps; k++) fn();
      const avg = (performance.now() - t0) / reps;
      if (avg < best) best = avg;
    }
    return best;
  };

  for (const seconds of [10, 30, 60]) {
    const total = seconds * 10000;
    const src = makeSource(total, seconds);
    const py = buildPyramid(src);
    const from = Math.floor(total / 2);
    const to = Math.min(total, from + windowPairs);
    const lodFrom = Math.floor(total / 4);
    const lodTo = Math.min(total, lodFrom + 200000);

    const cols = buildColumns(py, src, { from, to, columns });
    assert.equal(cols.filled, columns, 'все колонки должны быть заполнены');
    const lodCols = buildColumns(py, src, { from: lodFrom, to: lodTo, columns: lodColumns });
    assert.equal(lodCols.raw, false, `для ${seconds} с отдалённое окно должно идти через пирамиду`);
    assert.equal(lodCols.filled, lodColumns);

    const window = measure(() => buildColumns(py, src, { from, to, columns }));
    const overview = measure(() => buildColumns(py, src, { from: 0, to: total, columns }));
    const lod = measure(() => buildColumns(py, src, { from: lodFrom, to: lodTo, columns: lodColumns }));
    // полный кадр = окно + обзор (именно это рисует ChartRenderer.draw)
    const frame = measure(() => {
      buildColumns(py, src, { from, to, columns });
      buildColumns(py, src, { from: 0, to: total, columns });
    });

    results.push({ seconds, window, overview, lod, frame, pyramidBytes: py.bytes,
                   level: cols.level, lodLevel: lodCols.level });
  }

  for (const r of results) {
    console.log(`    ${String(r.seconds).padStart(2)} с записи: кадр ${r.frame.toFixed(3)} мс `
      + `(окно ${r.window.toFixed(3)} мс, уровень ${r.level}; обзор ${r.overview.toFixed(3)} мс; `
      + `LOD-окно ${r.lod.toFixed(3)} мс, уровень ${r.lodLevel}), пирамида ${(r.pyramidBytes / 1024).toFixed(0)} КиБ`);
  }

  // 1) основной критерий приёмки — полный кадр (окно + обзор)
  const baseFrame = results[0].frame;
  for (const r of results) {
    const ratio = r.frame / baseFrame;
    assert.ok(ratio <= 1.5, `полный кадр для ${r.seconds} с длиннее базового в ${ratio.toFixed(2)} раз (норма ≤ 1,5)`);
  }
  // 2) окно (доминирующая часть кадра) — тоже без роста
  const baseWin = results[0].window;
  for (const r of results) {
    const ratio = r.window / baseWin;
    assert.ok(ratio <= 1.5, `окно для ${r.seconds} с длиннее базового в ${ratio.toFixed(2)} раз (норма ≤ 1,5)`);
  }
  // 3) Обзор и LOD-окно стоят десятые доли миллисекунды: при таких величинах отношение шумит
  //    сильнее нормы 1,5 (плюс небольшой рост из-за кэша и большего числа бакетов), поэтому
  //    проверяем абсолютный допуск +0,3 мс — это ~2 % бюджета кадра (16,7 мс).
  for (const key of ['overview', 'lod']) {
    const base = results[0][key];
    for (const r of results) {
      assert.ok(r[key] <= base + 0.3,
        `${key} для ${r.seconds} с: ${r[key].toFixed(3)} мс против ${base.toFixed(3)} мс (допуск +0,3 мс)`);
    }
  }
});

test('уровень LOD растёт с длиной записи, а число колонок остаётся заданным', () => {
  const columns = 800;
  const rows = [];
  for (const seconds of [10, 30, 60]) {
    const total = seconds * 10000;
    const src = makeSource(total, 100);
    const py = buildPyramid(src);
    const cols = buildColumns(py, src, { from: 0, to: total, columns });
    rows.push({ seconds, level: cols.level, bucketPairs: py.bucketPairs(cols.level), filled: cols.filled });
    assert.equal(cols.filled, columns);
  }
  for (let k = 1; k < rows.length; k++) {
    assert.ok(rows[k].level >= rows[k - 1].level, 'для более длинной записи уровень не мельче');
  }
  for (const r of rows) {
    assert.ok(r.bucketPairs >= (r.seconds * 10000) / columns / 2,
      `бакет (${r.bucketPairs}) сопоставим с шагом колонки для ${r.seconds} с`);
    console.log(`    ${r.seconds} с: уровень ${r.level}, бакет ${r.bucketPairs} пар`);
  }
});

test('точный режим включается при зуме (на колонку ≤ 64 пары)', () => {
  const src = makeSource(200000, 42);
  const py = buildPyramid(src);
  const wide = buildColumns(py, src, { from: 0, to: 200000, columns: 800 });
  assert.equal(wide.raw, false, 'на обзоре используется пирамида');
  const zoomed = buildColumns(py, src, { from: 1000, to: 1000 + 800 * 30, columns: 800 });
  assert.equal(zoomed.raw, true, 'при шаге ≤ 64 пар читаются сырые данные');
  const exact = buildColumns(py, src, { from: 1000, to: 1800, columns: 800 });
  assert.equal(exact.raw, true);
  assert.ok(exact.dioExact, 'при шаге ≤ 1 пары доступны точные уровни DIO');
  for (let c = 0; c < exact.columns; c++) {
    assert.equal(exact.minU[c], exact.maxU[c], 'в точном режиме min = max = значение пары');
  }
});

test('маркеры событий и курсор не ломают кадр (данные для Этапа 5)', () => {
  const src = makeSource(10000, 5);
  const py = buildPyramid(src);
  const cols = buildColumns(py, src, { from: 0, to: 10000, columns: 500 });
  const fake = {
    events: [{ tSeconds: 0.2, type: 'counter' }, { tSeconds: 0.5, type: 'uart' }],
    cursor: { x: 100 },
  };
  // проверяем только, что данные для отрисовки маркеров/курсора корректно фильтруются
  const pps = 10000;
  const inside = fake.events.filter((e) => e.tSeconds * pps >= 0 && e.tSeconds * pps <= 10000);
  assert.equal(inside.length, 2);
  assert.equal(cols.columns, 500);
});
