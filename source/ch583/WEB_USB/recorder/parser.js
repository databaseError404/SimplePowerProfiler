/**
 * Инкрементальный парсер протокола PowerProfiler `[size][cmd][payload]`.
 *
 * Этап 3 (PLAN.md): устойчив к произвольной нарезке USB-чанков — границы могут попадать
 * внутрь заголовка, внутрь поля и вообще между байтами. Данные 24-битного режима INA228
 * приходят группами по 7 байт: U24 (LE, без знака), I24 (LE, знаковое дополнение до 32),
 * DIO (маска 8 линий). Группировка проверяется по размеру payload — за границу кадра
 * парсер НЕ выходит (это отличие от pp.js, который при нечётном pktcnt читает мусор
 * из следующего кадра).
 *
 * Модуль не зависит от DOM и работает и в браузере, и в Node (ESM).
 */

export const CMD = {
  VER: 0x00,      // версия устройства
  PVER: 0x14,     // версия протокола и возможности (Этап 2)
  CFG: 0x01,      // конфигурация I2C и старт измерения (ответ = cfg_i2c)
  SCF: 0x02,      // сохранение конфигурации
  STA: 0x03,      // счётчики (блоки записано/потеряно, ...)
  GRG: 0x10,      // чтение регистра I2C
  SRG: 0x11,      // запись регистра I2C
  FRD: 0x18,      // формат чтения (16/24 бита, режимы)
  ECAD: 0x38,     // конфигурация INA228 и старт/стоп измерения
  EADC: 0x3A,     // поток данных 24 бита (U/I/DIO)
  SEQ: 0x3B,      // резерв: поток с номерами блоков (проект Этапа 2, раздел 4)
  I2C_PWR: 0x40,  // питание внешнего датчика
  ERR_FLAG: 0x80, // бит ошибки в коде команды
};

export const GROUP_BYTES_24BIT_DIO = 7;   // INA228, 24 бита, пары U/I + DIO
export const GROUP_BYTES_24BIT = 6;       // 24 бита без DIO (другие датчики)
export const GROUP_BYTES_16BIT = 4;       // 16 бит: U, I

/** Знаковое расширение 24-битного значения до 32 бит (JS-битовые операции 32-битные). */
export function signed24(v) {
  return (v << 8) >> 8;
}

export class StreamParser {
  /**
   * @param {object} opts
   * @param {number} [opts.groupBytes=7]  размер группы данных в кадре 0x3A
   * @param {(u:number,i:number,dio:number,index:number)=>void} [opts.onPair]
   * @param {(cmd:number,payload:Uint8Array,index:number)=>void} [opts.onFrame]
   * @param {(counters:object,payload:Uint8Array)=>void} [opts.onStatus]
   * @param {(size:number,cmd:number)=>void} [opts.onMisalign]
   * @param {(cmd:number)=>void} [opts.onDeviceError]
   * @param {(seq:number)=>void} [opts.onSeq]   номер блока из 0x3B (проект расширения)
   */
  constructor(opts = {}) {
    this.groupBytes = opts.groupBytes || GROUP_BYTES_24BIT_DIO;
    this.onPair = opts.onPair || null;
    this.onFrame = opts.onFrame || null;
    this.onStatus = opts.onStatus || null;
    this.onMisalign = opts.onMisalign || null;
    this.onDeviceError = opts.onDeviceError || null;
    this.onSeq = opts.onSeq || null;

    this.buf = new Uint8Array(opts.bufferBytes || 8192);
    this.head = 0;      // начало необработанных данных
    this.tail = 0;      // конец данных
    this.pairs = 0;     // всего пар
    this.frames = 0;    // всего кадров
    this.badFrames = 0; // кадров с нарушением формата
    this.deviceErrors = 0;
  }

  reset() {
    this.head = this.tail = 0;
    this.pairs = this.frames = this.badFrames = this.deviceErrors = 0;
  }

  /** Сколько байт ещё не разобрано (неполный кадр). */
  get pending() {
    return this.tail - this.head;
  }

  /**
   * Добавить принятые байты. Возвращает число добавленных байт.
   * @param {Uint8Array} bytes
   */
  push(bytes) {
    const n = bytes.length;
    if (n === 0) return 0;
    this._ensure(n);
    this.buf.set(bytes, this.tail);
    this.tail += n;
    this._parse();
    return n;
  }

  _ensure(n) {
    if (this.tail + n <= this.buf.length) return;
    const pending = this.tail - this.head;
    if (pending + n <= this.buf.length) {
      // сдвигаем остаток в начало — обычный случай, без роста
      this.buf.copyWithin(0, this.head, this.tail);
      this.head = 0;
      this.tail = pending;
      return;
    }
    let size = this.buf.length;
    while (size < pending + n) size *= 2;
    const nb = new Uint8Array(size);
    nb.set(this.buf.subarray(this.head, this.tail), 0);
    this.buf = nb;
    this.head = 0;
    this.tail = pending;
  }

  _parse() {
    const buf = this.buf;
    const group = this.groupBytes;
    while (this.tail - this.head >= 2) {
      const size = buf[this.head];
      const cmd = buf[this.head + 1];
      const total = size + 2;
      if (this.tail - this.head < total) break;         // кадр ещё не пришёл целиком
      const payloadStart = this.head + 2;
      this.frames++;

      if (cmd & CMD.ERR_FLAG) {
        this.deviceErrors++;
        if (this.onDeviceError) this.onDeviceError(cmd & 0x7F);
      } else if (cmd === CMD.EADC || cmd === CMD.SEQ) {
        // 0x3B = [u16 seq][те же группы, что у 0x3A] — резерв под расширение протокола
        const head = cmd === CMD.SEQ ? 2 : 0;
        if (head) {
          if (this.onSeq) this.onSeq(buf[payloadStart] | (buf[payloadStart + 1] << 8));
        }
        if ((size - head) % group !== 0 || size < head) {
          // нарушение выравнивания: нельзя «добирать» байты из следующего кадра
          this.badFrames++;
          if (this.onMisalign) this.onMisalign(size, cmd);
        } else {
          let off = payloadStart + head;
          const end = payloadStart + size;
          const onPair = this.onPair;
          if (onPair) {
            while (off < end) {
              const u = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
              const i = signed24(buf[off + 3] | (buf[off + 4] << 8) | (buf[off + 5] << 16));
              const dio = buf[off + 6];
              onPair(u, i, dio, this.pairs++);
              off += 7;
            }
          } else {
            this.pairs += (size - head) / group;
          }
        }
      } else if (cmd === CMD.STA && this.onStatus) {
        this.onStatus(decodeStatus(buf, payloadStart, size), buf.subarray(payloadStart, payloadStart + size));
      } else if (this.onFrame) {
        this.onFrame(cmd, buf.subarray(payloadStart, payloadStart + size), this.pairs);
      }
      this.head += total;
    }
    if (this.head === this.tail) {
      this.head = this.tail = 0;   // буфер пуст — сбрасываем без копирования
    }
  }
}

/** Разбор ответа CMD_DEV_STA: u32 блоков записано, u32 блоков потеряно, [u32 кольцо, u32 ошибки I2C]. */
export function decodeStatus(buf, off, size) {
  const dv = new DataView(buf.buffer, buf.byteOffset + off, size);
  const out = { blocksWritten: null, blocksDropped: null, readsLostRing: null, i2cErrors: null };
  if (size >= 4) out.blocksWritten = dv.getUint32(0, true);
  if (size >= 8) out.blocksDropped = dv.getUint32(4, true);
  if (size >= 12) out.readsLostRing = dv.getUint32(8, true);
  if (size >= 16) out.i2cErrors = dv.getUint32(12, true);
  return out;
}
