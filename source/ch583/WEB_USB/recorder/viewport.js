/**
 * Viewport (Этап 4): окно просмотра в парах + операции zoom/pan/follow.
 *
 * Чистая математика без DOM — проверяется в Node. Окно задаётся в индексах пар [from, to);
 * время получается делением на pairsPerSecond из заголовка записи/конфигурации.
 */

export class Viewport {
  /**
   * @param {object} [opts]
   * @param {number} [opts.pairs=0]            всего пар в источнике
   * @param {number} [opts.pairsPerSecond=1000]
   * @param {number} [opts.minSpan=8]          минимальная ширина окна в парах (иначе «зум в бесконечность»)
   */
  constructor(opts = {}) {
    this.pairs = opts.pairs || 0;
    this.pairsPerSecond = opts.pairsPerSecond || 1000;
    this.minSpan = opts.minSpan || 8;
    this.followLatest = false;
    this.from = 0;
    this.to = Math.max(this.minSpan, this.pairs || this.minSpan);
  }

  get span() {
    return this.to - this.from;
  }

  get duration() {
    return this.span / this.pairsPerSecond;
  }

  get startTime() {
    return this.from / this.pairsPerSecond;
  }

  get endTime() {
    return this.to / this.pairsPerSecond;
  }

  /** Обновить общее число пар (при записи растёт). */
  setPairs(n, { keepSpan = true } = {}) {
    const prev = this.pairs;
    this.pairs = Math.max(0, n);
    if (!keepSpan || prev === 0) {
      this.from = 0;
      this.to = Math.max(this.minSpan, this.pairs || this.minSpan);
    } else if (this.followLatest) {
      this.followTick();
    }
    this.clamp();
  }

  setRange(from, to) {
    this.from = from;
    this.to = to;
    this.clamp();
  }

  /** Показать всё. */
  fit() {
    this.from = 0;
    this.to = Math.max(this.minSpan, this.pairs || this.minSpan);
    this.followLatest = false;
  }

  /** Зум к точке (в пикселях): factor > 1 — приблизить. */
  zoomAt(pixelX, factor, width) {
    const span = this.span;
    const anchor = this.from + (pixelX / Math.max(1, width)) * span;
    let newSpan = span / factor;
    newSpan = Math.max(this.minSpan, Math.min(Math.max(this.pairs, this.minSpan), newSpan));
    const ratio = (anchor - this.from) / Math.max(1e-9, span);
    this.from = anchor - ratio * newSpan;
    this.to = this.from + newSpan;
    this.clamp();
  }

  /** Сдвиг окна на dx пикселей (тянем вправо — окно едет влево по данным). */
  panByPixels(dx, width) {
    const shift = -(dx / Math.max(1, width)) * this.span;
    this.from += shift;
    this.to += shift;
    this.clamp();
  }

  /** Сдвиг на долю ширины (для кнопок/клавиатуры). */
  panByFraction(fraction) {
    const shift = fraction * this.span;
    this.from += shift;
    this.to += shift;
    this.clamp();
  }

  setFollowLatest(on) {
    this.followLatest = !!on;
    if (this.followLatest) this.followTick();
  }

  /** При включённом follow: держим правый край на последних данных. */
  followTick() {
    if (!this.followLatest) return;
    const span = this.span;
    this.to = Math.max(this.minSpan, this.pairs);
    this.from = this.to - span;
    this.clamp();
  }

  clamp() {
    const total = Math.max(this.pairs, this.minSpan);
    if (this.to - this.from < this.minSpan) {
      this.to = this.from + this.minSpan;
    }
    if (this.to - this.from > total) {
      this.to = this.from + total;
    }
    if (this.from < 0) {
      this.to -= this.from;
      this.from = 0;
    }
    if (this.to > total) {
      this.from -= (this.to - total);
      this.to = total;
      if (this.from < 0) this.from = 0;
    }
    return this;
  }

  /** Индекс пары по координате X. */
  xToPair(x, width) {
    return this.from + (x / Math.max(1, width)) * this.span;
  }

  /** Координата X по индексу пары. */
  pairToX(index, width) {
    return ((index - this.from) / this.span) * width;
  }

  /** Сколько пар на пиксель. */
  pairsPerPixel(width) {
    return this.span / Math.max(1, width);
  }

  get state() {
    return {
      from: this.from, to: this.to, span: this.span,
      pairs: this.pairs, followLatest: this.followLatest,
      startTime: this.startTime, endTime: this.endTime,
    };
  }
}
