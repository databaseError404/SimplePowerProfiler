/**
 * Тесты хранилища и оценки потерь.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PairStore, LossTracker, BYTES_PER_PAIR } from '../store.js';

test('хранилище: запись/чтение через границы чанков', () => {
  const st = new PairStore({ chunkPairs: 8 });
  const n = 40;
  for (let k = 0; k < n; k++) st.append(0x100000 + k, -(k + 1) * 3, k & 0xFF);
  assert.equal(st.length, n);
  assert.equal(st.chunkCount, Math.ceil(n / 8));
  assert.equal(st.bytes, st.chunkCount * 8 * BYTES_PER_PAIR);
  for (let k = 0; k < n; k++) {
    assert.equal(st.u(k), 0x100000 + k);
    assert.equal(st.i(k), -(k + 1) * 3);
    assert.equal(st.dio(k), k & 0xFF);
  }
  // границы чанков: 7/8, 15/16, 31/32
  for (const k of [7, 8, 15, 16, 31, 32]) {
    assert.deepEqual(st.get(k), { u: 0x100000 + k, i: -(k + 1) * 3, dio: k & 0xFF });
  }
});

test('хранилище: части и восстановление (как при открытии файла)', () => {
  const st = new PairStore({ chunkPairs: 4 });
  for (let k = 0; k < 10; k++) st.append(k, -(k + 1), k);
  const parts = st.parts();
  assert.deepEqual(parts.map((p) => p.count), [4, 4, 2]);
  const st2 = PairStore.fromParts(parts, 4);
  assert.equal(st2.length, 10);
  for (let k = 0; k < 10; k++) assert.deepEqual(st2.get(k), { u: k, i: -(k + 1), dio: k });
});

test('хранилище: значения вне диапазона обрезаются, а не портят соседние поля', () => {
  const st = new PairStore({ chunkPairs: 4 });
  st.append(0x1FFFFFF, -0x800000, 0x1FF);   // больше 24/8 бит
  assert.equal(st.u(0), 0xFFFFFF);
  assert.equal(st.i(0), -0x800000);
  assert.equal(st.dio(0), 0xFF);
});

test('оценка потерь: счётчики прибора дают верхнюю оценку пропуска', () => {
  const lt = new LossTracker(10);          // 10 пар в блоке (pktcnt=20)
  lt.pairs = 1000;
  lt.snapshot({ blocksWritten: 100, blocksDropped: 0 });
  // пришло ещё 2000 пар, прибор записал 300 блоков и потерял 50
  lt.pairs = 3000;
  lt.snapshot({ blocksWritten: 400, blocksDropped: 50 });
  const est = lt.estimate;
  assert.equal(est.blocksWritten, 300);
  assert.equal(est.blocksDropped, 50);
  assert.equal(est.pairsReceived, 2000);
  assert.equal(est.pairsProduced, 3500);
  assert.equal(est.missingPairsUpperBound, 1500);
});

test('оценка потерь: без счётчиков оценка не выдаётся', () => {
  const lt = new LossTracker(10);
  lt.snapshot(null);
  assert.equal(lt.estimate, null);
});

test('разрывы номеров блоков (0x3B) считаются как потеря', () => {
  const lt = new LossTracker(10);
  lt.noteSeq(5);
  lt.noteSeq(6);
  lt.noteSeq(9);          // пропущены 7 и 8
  lt.noteSeq(10);
  assert.equal(lt.seqGaps, 1);
  assert.equal(lt.seqLostBlocks, 2);
  assert.equal(lt.summary.seqLostBlocks, 2);
});

test('оценка потерь: счётчики не сбрасываются при переполнении списка снимков', () => {
  const lt = new LossTracker(10);
  lt.pairs = 0;
  lt.snapshot({ blocksWritten: 0, blocksDropped: 0 });
  for (let k = 1; k <= 100; k++) {
    lt.pairs = k * 100;
    lt.snapshot({ blocksWritten: k * 10, blocksDropped: 0 });
  }
  assert.ok(lt.snapshots.length <= 64);
  assert.equal(lt.snapshots[0].counters.blocksWritten, 0);
  assert.equal(lt.summary.countersEnd.blocksWritten, 1000);
});
