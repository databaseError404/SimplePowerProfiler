/**
 * Генератор синтетических потоков `[size][cmd][payload]` для тестов рекордера.
 *
 * Упаковка повторяет прошивку (`i2c_dev.c`, I2CDevTask):
 *   * `pktcnt` — число ЧТЕНИЙ регистров в блоке (чётное в норме): каждое чтение 3 байта,
 *     после каждого нечётного индекса внутри блока — байт DIO;
 *   * чтения чередуются: чётный индекс = U, нечётный = I (в режиме пар);
 *   * размер payload = pktcnt*3 + pktcnt/2 (при нечётном pktcnt — не кратен 7).
 */

export const CMD_EADC = 0x3A;
export const CMD_SEQ = 0x3B;
export const CMD_STA = 0x03;
export const CMD_CFG = 0x01;

/** Разворачивает пары (u,i,dio) в поток чтений (u, i, u, i, ...). */
function toReads(pairs) {
  const reads = [];
  for (const p of pairs) {
    reads.push({ v: p.u, dio: p.dio });
    reads.push({ v: p.i, dio: p.dio });
  }
  return reads;
}

/**
 * @param {{u:number,i:number,dio:number}[]} pairs
 * @param {object} [opts]
 * @param {number} [opts.pktcnt=20]
 * @param {boolean} [opts.dio=true]
 * @param {number[]} [opts.dropBlocks=[]]  индексы блоков, которые «потерялись» (не пишутся)
 * @param {number[]} [opts.cmdFrames=[]]   вставить кадры команд перед указанными блоками: [blockIndex, cmd, ...payload]
 * @param {boolean} [opts.seq=false]       писать блоки как 0x3B с номером (проект расширения)
 * @returns {Uint8Array}
 */
export function packFrames(pairs, opts = {}) {
  const pktcnt = opts.pktcnt ?? 20;
  const dio = opts.dio !== false;
  const drop = new Set(opts.dropBlocks || []);
  const reads = toReads(pairs);
  const chunks = [];
  let total = 0;
  const push = (arr) => { chunks.push(arr); total += arr.length; };

  let idx = 0;
  let block = 0;
  let seq = 0;
  while (idx < reads.length) {
    const part = reads.slice(idx, idx + pktcnt);
    idx += pktcnt;
    for (const cmdf of (opts.cmdFrames || [])) {
      if (cmdf[0] === block) {
        const payload = cmdf.slice(2);
        push(new Uint8Array([payload.length, cmdf[1], ...payload]));
      }
    }
    if (drop.has(block)) { block++; seq++; continue; }
    const payload = [];
    part.forEach((r, n) => {
      const v = r.v & 0xFFFFFF;
      payload.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF);
      if (dio && (n & 1)) payload.push(r.dio & 0xFF);
    });
    if (opts.seq) {
      const head = [0, 0];
      new DataView(new Uint8Array(head).buffer);          // (без изменений: заполняем вручную ниже)
      const p = new Uint8Array(2 + payload.length);
      p[0] = seq & 0xFF; p[1] = (seq >> 8) & 0xFF;
      p.set(payload, 2);
      push(new Uint8Array([p.length, CMD_SEQ, ...p]));
    } else {
      push(new Uint8Array([payload.length, CMD_EADC, ...payload]));
    }
    block++;
    seq++;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** Детерминированные значения пары по её индексу (без создания объектов) — для больших тестов. */
export function valueAt(k) {
  const u = (270000 + ((k * 7919) % 4096)) & 0xFFFFFF;
  const i = ((k * 104729) % 8192) - 4096;
  const dio = (k * 31) & 0xFF;
  return { u, i, dio };
}

/**
 * Быстрая упаковка диапазона пар [start, start+count) в кадры 0x3A.
 * Заполняет один Uint8Array напрямую (без промежуточных массивов) — для тестов
 * на миллионы пар.
 */
export function packRange(start, count, { pktcnt = 20, dio = true } = {}) {
  const pairsPerBlock = Math.floor(pktcnt / 2);
  const payloadPerBlock = pktcnt * 3 + (dio ? Math.floor(pktcnt / 2) : 0);
  const blocks = Math.ceil(count / pairsPerBlock);
  const total = blocks * (2 + payloadPerBlock);
  const out = new Uint8Array(total);
  let off = 0;
  for (let b = 0; b < blocks; b++) {
    const first = b * pairsPerBlock;
    const n = Math.min(pairsPerBlock, count - first);
    const payloadLen = n * 6 + (dio ? n : 0);
    out[off] = payloadLen;
    out[off + 1] = CMD_EADC;
    let p = off + 2;
    for (let k = 0; k < n; k++) {
      const v = valueAt(start + first + k);
      out[p] = v.u & 0xFF; out[p + 1] = (v.u >> 8) & 0xFF; out[p + 2] = (v.u >> 16) & 0xFF;
      out[p + 3] = v.i & 0xFF; out[p + 4] = (v.i >> 8) & 0xFF; out[p + 5] = (v.i >> 16) & 0xFF;
      p += 6;
      if (dio) { out[p] = v.dio; p++; }
    }
    off += 2 + payloadLen;
  }
  return out;
}

/** Кадр ответа CMD_DEV_STA с счётчиками. */
export function statusFrame(blocksWritten, blocksDropped, readsLostRing = 0, i2cErrors = 0) {
  const p = new Uint8Array(16);
  const dv = new DataView(p.buffer);
  dv.setUint32(0, blocksWritten, true);
  dv.setUint32(4, blocksDropped, true);
  dv.setUint32(8, readsLostRing, true);
  dv.setUint32(12, i2cErrors, true);
  return new Uint8Array([p.length, CMD_STA, ...p]);
}

/** Кадр ответа CMD_DEV_CFG (эхо конфигурации). */
export function cfgFrame({ pktcnt = 20, multiplier = 0, timeUs = 84, clkKhz = 1300 } = {}) {
  const payload = new Uint8Array(38);
  payload[0] = pktcnt;
  payload[1] = multiplier;
  payload[2] = timeUs & 0xFF; payload[3] = timeUs >> 8;
  payload[4] = clkKhz & 0xFF; payload[5] = clkKhz >> 8;
  return new Uint8Array([payload.length, CMD_CFG, ...payload]);
}

/** Нарезка буфера на куски заданного размера (0 = целиком). */
export function sliceChunks(buf, size) {
  if (!size) return [buf];
  const out = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, Math.min(i + size, buf.length)));
  return out;
}

/** Детерминированный ГПСЧ (для воспроизводимых «случайных» нарезок). */
export function makeRng(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
