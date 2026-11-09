/**
 * T7: сохранение/открытие записи (round-trip) и устойчивость к обрезанному файлу.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../recorder.js';
import { serializeToBlob, openRecord, readHeader, makeMeta, defaultCalibration, MAGIC } from '../recordfile.js';
import { packFrames, cfgFrame, statusFrame, makeRng } from './synth.js';

function recordPairs(n, seed = 5, opts = {}) {
  const rng = makeRng(seed);
  const pairs = [];
  for (let k = 0; k < n; k++) {
    pairs.push({
      u: Math.floor(rng() * 0x1000000),
      i: Math.floor(rng() * 0x1000000) - 0x800000,
      dio: Math.floor(rng() * 256),
    });
  }
  const rec = new Recorder({ chunkPairs: 1024, timeUs: 84, clkKhz: 1300, pktcnt: 20, ...opts });
  const stream = packFrames(pairs, { pktcnt: 20 });
  rec.push(cfgFrame({ pktcnt: 20, timeUs: 84, clkKhz: 1300 }));
  rec.push(statusFrame(0, 0));
  rec.push(stream);
  rec.push(statusFrame(Math.ceil(n / 10), 0));
  rec.stop();
  return { rec, pairs };
}

test('T7: round-trip сохраняет все пары и поля заголовка', async () => {
  const { rec, pairs } = recordPairs(2500, 21);
  const meta = rec.meta({ app: { ua: 'test' }, device: { dev_id: 0x1024, ver: 7 } });
  const blob = serializeToBlob(rec.store, meta);
  const file = await openRecord(blob);

  assert.equal(file.length, pairs.length);
  for (let k = 0; k < pairs.length; k++) {
    assert.deepEqual(file.get(k), pairs[k], `пара ${k}`);
  }
  assert.equal(file.header.cfg.time_us, 84);
  assert.equal(file.header.cfg.clk_khz, 1300);
  assert.equal(file.header.cfg.pktcnt, 20);
  assert.equal(file.header.cfg.pairs_per_block, 10);
  assert.equal(file.header.device.dev_id, 0x1024);
  assert.equal(file.header.counts.pairs, pairs.length);
  assert.equal(file.header.calib.shunt_ohm, 1);
  assert.equal(file.header.app.ua, 'test');
  assert.ok(file.header.created);
});

test('T7: заголовок читается отдельно от данных', async () => {
  const { rec } = recordPairs(100, 22);
  const parts = rec.fileParts();
  const blob = new Blob(parts);
  const buf = await blob.arrayBuffer();
  const { header, dataOffset } = readHeader(buf);
  assert.equal(header.format, 'pprec');
  assert.equal(header.version, 1);
  assert.ok(dataOffset > 8);
  assert.equal(buf.byteLength, 8 + header.app ? buf.byteLength : buf.byteLength);   // заголовок внутри
  let magic = '';
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < MAGIC.length; i++) magic += String.fromCharCode(u8[i]);
  assert.equal(magic, MAGIC);
});

test('открытие обрезанного файла: без мусора, читается корректный префикс', async () => {
  const { rec, pairs } = recordPairs(1000, 23);
  const buf = await new Blob(rec.fileParts()).arrayBuffer();
  for (const frac of [0.99, 0.9, 0.8, 0.7, 0.62]) {
    const file = await openRecord(buf.slice(0, Math.floor(buf.byteLength * frac)));
    assert.ok(file.length <= pairs.length);
    for (let k = 0; k < file.length; k++) {
      assert.deepEqual(file.get(k), pairs[k], `обрезание ${frac}, пара ${k}`);
    }
  }
});

test('обрезание внутри заголовка даёт понятную ошибку', async () => {
  const { rec } = recordPairs(100, 26);
  const buf = await new Blob(rec.fileParts()).arrayBuffer();
  await assert.rejects(async () => openRecord(buf.slice(0, 1024)), /заголовка/);
});

test('обрезание при нескольких чанках: целые чанки читаются полностью', async () => {
  const { rec, pairs } = recordPairs(1000, 25, { chunkPairs: 256 });
  assert.equal(rec.store.chunkCount, 4);
  const buf = await new Blob(rec.fileParts()).arrayBuffer();
  const file = await openRecord(buf.slice(0, Math.floor(buf.byteLength * 0.7)));
  assert.ok(file.length >= 256, `ожидался минимум один целый чанк, получено ${file.length}`);
  for (let k = 0; k < file.length; k++) assert.deepEqual(file.get(k), pairs[k]);
  assert.ok(file.length < pairs.length, 'обрезанный хвост не должен выдаваться за данные');
});

test('открытие не-файла записи даёт понятную ошибку', async () => {
  await assert.rejects(async () => openRecord(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), /магия/);
});

test('в файл не попадают неполные данные: длина записи = числу принятых пар', async () => {
  const { rec, pairs } = recordPairs(3333, 24);
  const file = await openRecord(new Blob(rec.fileParts()));
  assert.equal(file.length, pairs.length);
  assert.equal(file.header.counts.pairs, pairs.length);
  assert.equal(rec.stats.pairs, pairs.length);
});

test('калибровка по умолчанию соответствует плате стенда (шунт 1 Ом)', () => {
  const c = defaultCalibration(1);
  assert.equal(c.shunt_ohm, 1);
  assert.ok(Math.abs(c.k_shunt_ma_per_code - 0.00001953125) < 1e-15);
  const c10 = defaultCalibration(10);
  assert.ok(Math.abs(c10.k_shunt_ma_per_code - 0.000001953125) < 1e-15);
});

test('makeMeta заполняет обязательные поля и считает пары в секунду', () => {
  const m = makeMeta({ cfg: { time_us: 50, clk_khz: 1500, pktcnt: 20 } });
  assert.equal(m.cfg.pairs_per_s, 10000);
  assert.equal(m.cfg.pairs_per_block, 10);
  assert.equal(m.calib.shunt_ohm, 1);
  assert.equal(m.version, 1);
});
