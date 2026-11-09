/**
 * Тесты парсера: T2 (нарезка по 1 байту), T3 (знаковость), выравнивание, кадры команд.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamParser, signed24, CMD } from '../parser.js';
import { packFrames, sliceChunks, makeRng, cfgFrame, statusFrame } from './synth.js';

/** Кадр ответа CMD_DEV_PVER (0x14): версия протокола и возможности. */
function pverFrame(ver = 2, flags = 0, maxPkt = 34, group = 7) {
  return new Uint8Array([4, 0x14, ver, flags, maxPkt, group]);
}

function collect(stream, { chunk = 0, groupBytes = 7 } = {}) {
  const pairs = [];
  const frames = [];
  const statuses = [];
  let misaligned = 0;
  const p = new StreamParser({
    groupBytes,
    onPair: (u, i, dio) => pairs.push([u, i, dio]),
    onFrame: (cmd, payload) => frames.push([cmd, payload.length]),
    onStatus: (c) => statuses.push(c),
    onMisalign: () => misaligned++,
  });
  for (const c of sliceChunks(stream, chunk)) p.push(c);
  return { pairs, frames, statuses, misaligned, parser: p };
}

function makePairs(n, seed = 1) {
  const rng = makeRng(seed);
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({
      u: Math.floor(rng() * 0x1000000),
      i: Math.floor(rng() * 0x1000000) - 0x800000,
      dio: Math.floor(rng() * 256),
    });
  }
  return out;
}

test('T2: нарезка по 1 байту даёт идентичный датасет', () => {
  const pairs = makePairs(2000, 7);
  const stream = packFrames(pairs, { pktcnt: 20 });
  const whole = collect(stream, { chunk: 0 });
  const one = collect(stream, { chunk: 1 });
  const rng = makeRng(99);
  const parts = [];
  let off = 0;
  while (off < stream.length) {
    const n = 1 + Math.floor(rng() * 97);
    parts.push(stream.subarray(off, Math.min(off + n, stream.length)));
    off += n;
  }
  const rnd = [];
  {
    const p = new StreamParser({ onPair: (u, i, dio) => rnd.push([u, i, dio]) });
    for (const c of parts) p.push(c);
  }
  assert.equal(whole.pairs.length, 2000);
  assert.deepEqual(one.pairs, whole.pairs);
  assert.deepEqual(rnd, whole.pairs);
});

test('T3: U без знака и I знаковое (предельные значения)', () => {
  const pairs = [
    { u: 0xFFFFFF, i: -0x800000, dio: 0xFF },
    { u: 0x800000, i: 0x7FFFFF, dio: 0x00 },
    { u: 0, i: 0, dio: 0x01 },
    { u: 1, i: -1, dio: 0x80 },
  ];
  const stream = packFrames(pairs, { pktcnt: 20 });
  const { pairs: got } = collect(stream);
  assert.deepEqual(got, pairs.map((p) => [p.u, p.i, p.dio]));
  assert.equal(signed24(0xFFFFFF), -1);
  assert.equal(signed24(0x800000), -0x800000);
  assert.equal(signed24(0x7FFFFF), 0x7FFFFF);
});

test('нечётный pktcnt: кадр помечается как невыровненный, пар из него нет', () => {
  const pairs = makePairs(200, 3);
  const stream = packFrames(pairs, { pktcnt: 19 });
  const { pairs: got, misaligned } = collect(stream);
  assert.ok(misaligned > 0, 'нарушение выравнивания должно быть замечено');
  assert.equal(got.length, 0, 'из невыровненного кадра пары не извлекаются');
});

test('кадры команд не мешают данным и распознаются', () => {
  const pairs = makePairs(100, 5);
  const stream = packFrames(pairs, {
    pktcnt: 20,
    cmdFrames: [[0, CMD.VER, 0x24, 0x10, 0x07, 0x00]],
  });
  const { pairs: got, frames } = collect(stream);
  assert.equal(got.length, 100);
  assert.deepEqual(got, pairs.map((p) => [p.u, p.i, p.dio]));
  assert.ok(frames.some(([cmd, len]) => cmd === CMD.VER && len === 4));
});

test('ответ CMD_DEV_STA разбирается в счётчики', () => {
  const { statuses } = collect(statusFrame(1000, 5, 7, 3));
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].blocksWritten, 1000);
  assert.equal(statuses[0].blocksDropped, 5);
  assert.equal(statuses[0].readsLostRing, 7);
  assert.equal(statuses[0].i2cErrors, 3);
});

test('кадр с флагом ошибки устройства не считается данными', () => {
  const stream = new Uint8Array([0, 0x81]);       // [size=0][cmd=0x01|ERR]
  let errors = 0;
  const p = new StreamParser({ onDeviceError: () => errors++ });
  p.push(stream);
  assert.equal(errors, 1);
  assert.equal(p.pairs, 0);
});

test('0x3B: номера блоков считаются, данные извлекаются', () => {
  const pairs = makePairs(60, 11);
  const stream = packFrames(pairs, { pktcnt: 20, seq: true });
  const seqs = [];
  const got = [];
  const p = new StreamParser({
    onPair: (u, i, dio) => got.push([u, i, dio]),
    onSeq: (s) => seqs.push(s),
  });
  p.push(stream);
  assert.equal(got.length, 60);
  assert.deepEqual(got, pairs.map((p) => [p.u, p.i, p.dio]));
  assert.deepEqual(seqs, [0, 1, 2, 3, 4, 5]);   // pktcnt=20 чтений = 10 пар на блок → 6 блоков
});

test('буфер парсера растёт при большом куске и ничего не теряет', () => {
  const pairs = makePairs(5000, 17);
  const stream = packFrames(pairs, { pktcnt: 70 });        // кадр 247 байт (максимум по байту размера)
  const got = [];
  const p = new StreamParser({ bufferBytes: 1024, onPair: (u, i, dio) => got.push([u, i, dio]) });
  p.push(stream);                                          // один большой кусок — буфер должен вырасти
  assert.equal(got.length, 5000);
  assert.deepEqual(got[4999], [pairs[4999].u, pairs[4999].i, pairs[4999].dio]);
  // и то же самое мелкими кусками
  const got2 = [];
  const p2 = new StreamParser({ bufferBytes: 64, onPair: (u, i, dio) => got2.push([u, i, dio]) });
  for (const c of sliceChunks(stream, 13)) p2.push(c);
  assert.deepEqual(got2, got);
});

test('CMD_DEV_PVER (0x14): версия протокола разбирается как обычный кадр', () => {
  const frames = [];
  const p = new StreamParser({ onFrame: (cmd, payload) => frames.push([cmd, Array.from(payload)]) });
  p.push(pverFrame(2, 0, 34, 7));
  assert.deepEqual(frames, [[0x14, [2, 0, 34, 7]]]);
  assert.equal(p.pairs, 0, 'кадр версии не считается данными');
});

test('расширенный CMD_DEV_STA (16 байт): читаются счётчики кольца и ошибок I2C', () => {
  const statuses = [];
  const p = new StreamParser({ onStatus: (c) => statuses.push(c) });
  p.push(statusFrame(1000, 5, 42, 3));
  assert.equal(statuses[0].blocksWritten, 1000);
  assert.equal(statuses[0].blocksDropped, 5);
  assert.equal(statuses[0].readsLostRing, 42);
  assert.equal(statuses[0].i2cErrors, 3);
});
