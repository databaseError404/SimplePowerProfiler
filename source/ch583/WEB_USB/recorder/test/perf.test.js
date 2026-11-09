/**
 * T1: синтетические 5 мин × 10k пар/с без потерь + измерение памяти и её роста.
 * Также — инъекция пропуска блока (детекция по счётчикам) и проверка, что запись
 * не «перезаписывает» старые данные (только рост).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../recorder.js';
import { PairStore, BYTES_PER_PAIR } from '../store.js';
import { packRange, valueAt, statusFrame } from './synth.js';
import { openRecord } from '../recordfile.js';

const PKTCNT = 20;
const PAIRS_PER_BLOCK = PKTCNT / 2;

function mem() {
  const m = process.memoryUsage();
  return { heap: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers, rss: m.rss };
}

function fmtMB(bytes) {
  return (bytes / 1048576).toFixed(1) + ' МиБ';
}

test('T1: 5 мин × 10k пар/с (3 млн пар) — без потерь, память и время измерены', () => {
  const totalPairs = 3_000_000;         // 5 мин × 10 000 пар/с
  const blockPairs = 250_000;           // порции по 250 тыс. пар (≈1.75 МБ данных)
  const rec = new Recorder({ pktcnt: PKTCNT, timeUs: 50, clkKhz: 1500 });
  const m0 = mem();
  const t0 = performance.now();

  let produced = 0;
  while (produced < totalPairs) {
    const n = Math.min(blockPairs, totalPairs - produced);
    rec.push(packRange(produced, n, { pktcnt: PKTCNT }));
    produced += n;
  }
  const dt = (performance.now() - t0) / 1000;
  rec.stop();
  const m1 = mem();

  const st = rec.stats;
  assert.equal(st.pairs, totalPairs, 'все пары должны быть приняты');
  assert.equal(st.misaligned, 0);
  assert.equal(st.deviceErrors, 0);
  assert.equal(st.chunks, Math.ceil(totalPairs / (1 << 16)));
  assert.equal(st.bytesStored, st.chunks * (1 << 16) * BYTES_PER_PAIR);

  // выборочная сверка значений (в т.ч. границы чанков)
  const probes = [0, 1, 65535, 65536, 65537, 1_500_000, totalPairs - 1];
  for (let k = 0; k < 500; k++) probes.push(Math.floor((k * 7919) % totalPairs));
  for (const idx of probes) {
    const want = valueAt(idx);
    assert.deepEqual(rec.store.get(idx), want, `пара ${idx}`);
  }

  const dHeap = m1.heap - m0.heap;
  const dExt = m1.external - m0.external;
  console.log(`    T1: ${totalPairs} пар за ${dt.toFixed(2)} с `
    + `(${Math.round(totalPairs / dt / 1000)} тыс. пар/с, `
    + `${fmtMB(st.bytesStored / dt)}/с хранилища); `
    + `память: буферы +${fmtMB(dExt)}, heap +${fmtMB(dHeap)}, `
    + `байт на пару ${BYTES_PER_PAIR}`);
  assert.ok(dt < 30, `обработка 3 млн пар не должна занимать больше 30 с (заняло ${dt.toFixed(1)} с)`);
  const chunks = Math.ceil(totalPairs / (1 << 16));
  assert.equal(st.bytesStored, chunks * (1 << 16) * BYTES_PER_PAIR,
    'хранилище округляется до целых чанков (65536 пар = 512 КиБ)');
});

test('рост памяти линейный: 8 байт на пару, старые данные не перезаписываются', () => {
  const rec = new Recorder({ pktcnt: PKTCNT });
  const marks = [];
  for (let step = 1; step <= 4; step++) {
    rec.push(packRange((step - 1) * 100_000, 100_000, { pktcnt: PKTCNT }));
    marks.push({ pairs: rec.stats.pairs, bytes: rec.stats.bytesStored, chunks: rec.stats.chunks });
  }
  assert.deepEqual(marks.map((m) => m.pairs), [100_000, 200_000, 300_000, 400_000]);
  // рост ровно на выделенные чанки (65536 пар = 512 КиБ), без «забывания» старых данных
  assert.deepEqual(marks.map((m) => m.chunks), [2, 4, 5, 7]);
  assert.equal(marks[3].bytes, 7 * (1 << 16) * BYTES_PER_PAIR);
  // первая пара на месте (её никто не перезаписал)
  assert.deepEqual(rec.store.get(0), valueAt(0));
  assert.deepEqual(rec.store.get(399_999), valueAt(399_999));
});

test('инъекция пропуска блока: счётчики прибора дают оценку потерь', () => {
  const rec = new Recorder({ pktcnt: PKTCNT });
  rec.push(statusFrame(0, 0));
  // 100 блоков «произведено» прибором, 5 потеряно: присылаем 95 блоков данных
  const goodBlocks = 95;
  const pairs = goodBlocks * PAIRS_PER_BLOCK;
  rec.push(packRange(0, pairs, { pktcnt: PKTCNT }));
  rec.push(statusFrame(100, 5));
  rec.stop();
  const est = rec.stats.estimate;
  assert.equal(rec.stats.pairs, pairs);
  assert.equal(est.blocksWritten, 100);
  assert.equal(est.blocksDropped, 5);
  assert.equal(est.pairsProduced, (100 + 5) * PAIRS_PER_BLOCK);
  assert.equal(est.missingPairsUpperBound, (100 + 5) * PAIRS_PER_BLOCK - pairs);
  assert.ok(est.missingPairsUpperBound >= 5 * PAIRS_PER_BLOCK, 'потеря 5 блоков должна быть видна');
});

test('запись не кольцевая: 5 млн пар остаются целиком (проверка первой и последней)', () => {
  const rec = new Recorder({ pktcnt: PKTCNT });
  const n = 5_000_000;
  for (let off = 0; off < n; off += 500_000) {
    rec.push(packRange(off, Math.min(500_000, n - off), { pktcnt: PKTCNT }));
  }
  assert.equal(rec.stats.pairs, n);
  assert.deepEqual(rec.store.get(0), valueAt(0));
  assert.deepEqual(rec.store.get(n - 1), valueAt(n - 1));
  assert.equal(rec.store.bytes, Math.ceil(n / (1 << 16)) * (1 << 16) * BYTES_PER_PAIR);
});

test('открытие большой записи: доступ по индексу и метрики', async () => {
  const rec = new Recorder({ pktcnt: PKTCNT, timeUs: 84, clkKhz: 1300 });
  const n = 1_000_000;
  for (let off = 0; off < n; off += 250_000) {
    rec.push(packRange(off, Math.min(250_000, n - off), { pktcnt: PKTCNT }));
  }
  rec.stop();
  const file = await openRecord(new Blob(rec.fileParts()));
  assert.equal(file.length, n);
  assert.equal(file.pairsPerSecond, 1e6 / (2 * 84));
  for (const idx of [0, 65_535, 65_536, 500_000, n - 1]) {
    assert.deepEqual(file.get(idx), valueAt(idx));
  }
  // восстановление в живое хранилище (для Этапа 4: LOD строится из тех же чанков)
  const store = file.toStore();
  assert.equal(store.length, n);
  assert.deepEqual(store.get(n - 1), valueAt(n - 1));
});

test('PairStore: чанки не перевыделяются при повторном чтении (стабильность)', () => {
  const st = new PairStore({ chunkPairs: 1024 });
  for (let k = 0; k < 5000; k++) st.append(k & 0xFFFFFF, -k, k & 0xFF);
  const parts1 = st.parts();
  const parts2 = st.parts();
  assert.equal(parts1.length, parts2.length);
  for (let i = 0; i < parts1.length; i++) {
    assert.equal(parts1[i].ud, parts2[i].ud, 'части должны ссылаться на те же буферы');
    assert.equal(parts1[i].count, parts2[i].count);
  }
});
