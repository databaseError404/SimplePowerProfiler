/**
 * Отрисовка (Этап 4): min/max-энвелопа U и I, дорожки DIO, обзор, оси, курсор, маркеры событий.
 *
 * Стоимость кадра зависит от числа пикселей (колонок) и выбранного уровня LOD, а не от длины
 * записи: данные готовит `buildColumns` (lod.js), здесь — только рисование.
 *
 * Раскладка по вертикали (доли высоты):
 *   раздельные панели (по умолчанию): U 0.00…0.30, I 0.32…0.62 — графики не накладываются;
 *   режим наложения (`overlay`): одна панель 0.00…0.62 с общей шкалой;
 *   дорожки DIO 0.62…0.86; обзор всей записи 0.88…1.00.
 *
 * Дорожки DIO: ровный уровень рисуется линией (даже если в колонке менялись ДРУГИЕ линии),
 * а метка активности ставится только там, где менялась именно эта линия (`dioChangedMask`).
 * Поэтому линия, стоящая в 1, выглядит линией, а не «зубцами».
 */

import { buildColumns } from './lod.js';

const COL_BG = '#101215';
const COL_GRID = '#23272e';
const COL_TEXT = '#8b95a1';
const COL_U = '#4fa3ff';
const COL_I = '#ffb04f';
const COL_DIO_ON = '#5fd38d';
const COL_DIO_ACT = '#2f6b4a';
const COL_DIO_MIX = '#7ee0ff';
const COL_SEL = '#4fa3ff';
const COL_CLIP = '#ff6f6f';

// Одна панель для U и I (как просил пользователь), внутри — две полосы, чтобы графики
// не накладывались друг на друга; в режиме наложения полосы сливаются в одну.
const PANEL_TOP = 0.00;
const PANEL_BOTTOM = 0.66;
const U_BAND = { top: 0.00, bottom: 0.305 };
const I_BAND = { top: 0.345, bottom: 0.66 };
const DIO_TOP = 0.68;
const DIO_BOTTOM = 0.88;
const OVERVIEW_TOP = 0.905;
const OVERVIEW_BOTTOM = 1.0;

/**
 * Квантили через quickselect: O(n) в среднем и без потери точности на выбросах
 * (гистограмма с равномерными бинами «размывала» диапазон, если в данных есть одиночный выброс).
 * Возвращает [lo, qLo, qHi, hi].
 */
function quantilesFast(arr, qLo, qHi) {
  const n = arr.length;
  if (!n) return [null, null, null, null];
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi === lo) return [lo, lo, hi, hi];
  const a = Float64Array.from(arr);
  const kth = (k) => {
    let left = 0, right = n - 1;
    while (left < right) {
      const pivot = a[(left + right) >> 1];
      let i = left, j = right;
      while (i <= j) {
        while (a[i] < pivot) i++;
        while (a[j] > pivot) j--;
        if (i <= j) {
          const t = a[i]; a[i] = a[j]; a[j] = t;
          i++; j--;
        }
      }
      if (k <= j) right = j;
      else if (k >= i) left = i;
      else break;
    }
    return a[Math.min(n - 1, Math.max(0, k))];
  };
  const kLo = Math.max(0, Math.min(n - 1, Math.round(qLo * (n - 1))));
  const kHi = Math.max(0, Math.min(n - 1, Math.round(qHi * (n - 1))));
  return [lo, kth(kLo), kth(kHi), hi];
}

/**
 * Шкалы отображения для колонок кадра.
 *
 * Используются квантили (по умолчанию 0,5 % и 99,5 %), а не абсолютные min/max: одиночный
 * выброс (например, сбойное чтение) иначе «схлопывает» полезный сигнал в одну линию.
 * Полные min/max остаются в метриках, а обрезанные значения помечаются `clipped`.
 */
export function computeScales(cols, calib, { overlay = false, clip = 0.005 } = {}) {
  const uVals = [];
  const iVals = [];
  for (let c = 0; c < cols.columns; c++) {
    if (cols.minU[c] === 0x7FFFFFFF) continue;
    uVals.push(cols.minU[c] * calib.k_bus_mv_per_code, cols.maxU[c] * calib.k_bus_mv_per_code);
    iVals.push(cols.minI[c] * calib.k_shunt_ma_per_code, cols.maxI[c] * calib.k_shunt_ma_per_code);
  }
  const pad = (lo, hi) => {
    if (lo === null || hi === null) return [0, 1];
    const d = Math.max(1e-9, hi - lo);
    return [lo - d * 0.06, hi + d * 0.06];
  };
  const [uLo, uq0, uq1, uHi] = quantilesFast(uVals, clip, 1 - clip);
  const [iLo, iq0, iq1, iHi] = quantilesFast(iVals, clip, 1 - clip);
  const uFull = uVals.length ? [uLo, uHi] : [0, 1];
  const iFull = iVals.length ? [iLo, iHi] : [0, 1];
  const [ua, ub] = pad(uq0, uq1);
  const [ia, ib] = pad(iq0, iq1);
  const res = {
    u: { a: ua, b: ub, full: uFull, clipped: uFull[0] < ua - 1e-9 || uFull[1] > ub + 1e-9 },
    i: { a: ia, b: ib, full: iFull, clipped: iFull[0] < ia - 1e-9 || iFull[1] > ib + 1e-9 },
    overlay: null,
  };
  if (overlay) {
    const lo = Math.min(ua, ia);
    const hi = Math.max(ub, ib);
    res.overlay = { a: lo, b: hi, clipped: res.u.clipped || res.i.clipped };
  }
  return res;
}

/**
 * Модель дорожки DIO для отрисовки (чистая функция — тестируется без canvas).
 *
 * Возвращает:
 *   levels   — отрезки ровного уровня [{x0, x1, on}] (линия на верху/внизу дорожки);
 *   activity — метки активности [{x, ever, always, changed}] там, где менялась ИМЕННО эта линия.
 *
 * В точном режиме (на колонку ≤ 1 пары) рисуется настоящий уровень по `dioExact` — меток
 * активности нет, иначе тонкая метка рядом с широкой ступенькой выглядела бы как «зубцы».
 */
export function dioLaneModel(cols, bit) {
  const mask = 1 << bit;
  const levels = [];
  const activity = [];

  if (cols.raw && cols.step <= 1 && cols.dioExact) {
    let run = null;
    for (let c = 0; c < cols.columns; c++) {
      const on = (cols.dioExact[c] & mask) !== 0;
      if (run && run.on === on) run.x1 = c;
      else { run = { x0: c, x1: c, on }; levels.push(run); }
    }
    return { levels, activity };
  }

  let run = null;
  for (let c = 0; c < cols.columns; c++) {
    const ever = (cols.dioOr[c] & mask) !== 0;
    const always = (cols.dioAnd[c] & mask) !== 0;
    const changed = (cols.dioChangedMask[c] & mask) !== 0;
    if (!changed) {
      // уровень не менялся в колонке → ровная линия (даже если менялись другие линии)
      if (run && run.on === ever) run.x1 = c;
      else { run = { x0: c, x1: c, on: ever }; levels.push(run); }
    } else {
      run = null;
      activity.push({ x: c, ever, always, changed: true });
    }
  }
  return { levels, activity };
}

export class ChartRenderer {
  /**
   * @param {HTMLCanvasElement|OffscreenCanvas} canvas
   * @param {object} opts
   * @param {{u:Function,i:Function,dio:Function,length:number}} opts.source
   * @param {import('./lod.js').LodPyramid} opts.pyramid
   * @param {object} opts.calib
   */
  constructor(canvas, { source, pyramid, calib, dpr = 1 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.source = source;
    this.pyramid = pyramid;
    this.calib = calib || { k_bus_mv_per_code: 0.01220703125, k_shunt_ma_per_code: 0.00001953125 };
    this.dpr = dpr;
    this.overlay = false;
    this.showDio = true;
    this.showPoints = true;   // точки реальных отсчётов
    this.showRange = true;    // размах min…max фоном
    this.showGrid = true;     // сетка значений (точечная, чтобы не путалась со следом)
    this.events = [];
    this.lastFrame = null;
    this.cursor = null;
    this.width = 800;
    this.height = 420;
  }

  resize(cssWidth, cssHeight, dpr = this.dpr) {
    this.dpr = dpr;
    this.width = cssWidth;
    this.height = cssHeight;
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.style) {
      this.canvas.style.width = cssWidth + 'px';
      this.canvas.style.height = cssHeight + 'px';
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Границы областей в CSS-пикселях: одна панель, внутри — полосы U и I. */
  get layout() {
    const h = this.height;
    const panel = { top: h * PANEL_TOP, bottom: h * PANEL_BOTTOM };
    return {
      panel,
      u: this.overlay ? panel : { top: h * U_BAND.top, bottom: h * U_BAND.bottom },
      i: this.overlay ? null : { top: h * I_BAND.top, bottom: h * I_BAND.bottom },
      dividerY: h * ((U_BAND.bottom + I_BAND.top) / 2),
      plot: panel,
      dio: { top: h * DIO_TOP, bottom: h * DIO_BOTTOM },
      overview: { top: h * OVERVIEW_TOP, bottom: h * OVERVIEW_BOTTOM },
    };
  }

  draw(viewport, opts = {}) {
    const t0 = performance.now();
    const columns = Math.max(2, Math.floor(opts.columns || this.width || 800));
    const from = Math.max(0, Math.floor(viewport.from));
    const to = Math.min(this.source.length, Math.ceil(viewport.to));
    const cols = from < to ? buildColumns(this.pyramid, this.source, { from, to, columns }) : null;
    const t1 = performance.now();
    this._paint(viewport, cols, { ...opts, columns });
    const t2 = performance.now();
    this.lastFrame = {
      columns, level: cols ? cols.level : -1, raw: cols ? cols.raw : false,
      from, to, buildMs: t1 - t0, drawMs: t2 - t1, totalMs: t2 - t0,
      pairs: cols ? cols.filled : 0,
      // сколько пар приходится на колонку: 1 = «каждая точка — реальный отсчёт»
      pairsPerColumn: cols ? cols.step : 0,
      exact: !!cols && cols.step <= 1,
      dots: !!(cols && this.showPoints && cols.step <= 0.34),
    };
    return this.lastFrame;
  }

  _paint(viewport, cols, opts) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const L = this.layout;

    ctx.fillStyle = COL_BG;
    ctx.fillRect(0, 0, w, h);
    // одна панель: рамка и разделитель полос U/I (в режиме наложения разделителя нет)
    ctx.strokeStyle = COL_GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0.5, L.panel.top + 0.5);
    ctx.lineTo(w - 0.5, L.panel.top + 0.5);
    ctx.moveTo(0.5, L.panel.bottom - 0.5);
    ctx.lineTo(w - 0.5, L.panel.bottom - 0.5);
    if (L.i) {
      ctx.moveTo(0.5, Math.round(L.dividerY) + 0.5);
      ctx.lineTo(w - 0.5, Math.round(L.dividerY) + 0.5);
    }
    ctx.stroke();
    if (L.i) { this._grid(L.u.top, L.u.bottom); this._grid(L.i.top, L.i.bottom); }
    else this._grid(L.panel.top, L.panel.bottom);

    if (!cols || cols.filled === 0) {
      ctx.fillStyle = COL_TEXT;
      ctx.font = '12px "Segoe UI", sans-serif';
      ctx.fillText(this.source.length === 0 ? 'нет данных — начните запись или откройте файл'
                                            : 'в окне нет данных', 10, L.u.top + 20);
      return;
    }

    const prof = this.profile = {};
    let t = performance.now();
    const scales = computeScales(cols, this.calib, { overlay: this.overlay });
    prof.scales = performance.now() - t;
    t = performance.now();
    if (this.overlay) {
      this._envelope(cols, L.u, scales.overlay, scales, 'both');
    } else {
      this._envelope(cols, L.u, scales.u, scales, 'u');
      if (L.i) this._envelope(cols, L.i, scales.i, scales, 'i');
    }
    prof.envelope = performance.now() - t;
    t = performance.now();
    if (L.i) this._timeAxis(viewport, L.dividerY);
    prof.axis = performance.now() - t;
    t = performance.now();
    if (this.showDio) this._dioLanes(cols, L.dio);
    prof.dio = performance.now() - t;
    t = performance.now();
    if (opts.withOverview !== false) this._overview(viewport, L.overview);
    prof.overview = performance.now() - t;
    this._events(viewport, L.plot);
    this._cursorMark(L);
  }

  _grid(top, bottom) {
    const ctx = this.ctx;
    ctx.strokeStyle = COL_GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k <= 2; k++) {
      const y = Math.round(top + ((bottom - top) * k) / 2) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
    }
    ctx.stroke();
  }

  /** Отрисовка панели: 'u', 'i' или 'both' (режим наложения). */
  _envelope(cols, area, scale, scales, what) {
    const ctx = this.ctx;
    const y = (v) => area.bottom - ((v - scale.a) / Math.max(1e-12, scale.b - scale.a)) * (area.bottom - area.top);
    const clip = (yy) => Math.max(area.top, Math.min(area.bottom, yy));
    // Сетка значений с подписями: без них положение графика не с чем соотнести.
    const ticks = 4;
    const unit = what === 'i' ? 'мА' : 'мВ';
    const digits = what === 'i' ? 4 : 1;
    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'right';
    for (let i = 0; i <= ticks; i++) {
      const v = scale.a + ((scale.b - scale.a) * i) / ticks;
      const yy = Math.round(y(v)) + 0.5;
      if (yy < area.top || yy > area.bottom) continue;
      if (this.showGrid) {
        // точечная сетка: сплошные линии путались со следом (принимались за «полки»)
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        for (let x = 2; x < this.width; x += 6) ctx.fillRect(x, yy, 2, 1);
      }
      const label = v.toFixed(digits) + ' ' + unit;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(16,18,21,0.75)';
      ctx.fillRect(this.width - tw - 8, yy - 11, tw + 6, 12);
      ctx.fillStyle = 'rgba(160,170,180,0.95)';
      ctx.fillText(label, this.width - 4, yy - 2);
    }
    ctx.textAlign = 'left';

    // Главная линия — среднее (читается как обычный график), размах — фоном.
    const drawSeries = (color, minArr, maxArr, meanArr, k) => {
      const n = cols.columns;
      // 1) размах (min…max) — очень светлой полосой: видно шум, но не мешает линии среднего
      ctx.beginPath();
      let started = false;
      for (let c = 0; c < n; c++) {
        if (minArr[c] === 0x7FFFFFFF) continue;
        const yy = clip(y(minArr[c] * k));
        if (!started) { ctx.moveTo(c + 0.5, yy); started = true; } else ctx.lineTo(c + 0.5, yy);
      }
      for (let c = n - 1; c >= 0; c--) {
        if (maxArr[c] === 0x7FFFFFFF) continue;
        ctx.lineTo(c + 0.5, clip(y(maxArr[c] * k)));
      }
      if (started && this.showRange) {
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.14;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      // 2) линия среднего — основной след (соединяет отсчёты)
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      started = false;
      for (let c = 0; c < n; c++) {
        if (meanArr[c] === 0x7FFFFFFF || (meanArr[c] === 0 && minArr[c] === 0x7FFFFFFF)) continue;
        const yy = clip(y(meanArr[c] * k));
        if (!started) { ctx.moveTo(c + 0.5, yy); started = true; } else ctx.lineTo(c + 0.5, yy);
      }
      ctx.stroke();
      // 3) точки реальных отсчётов — только когда между отсчётами есть место по горизонтали:
      //    step = пар на колонку, значит расстояние между отсчётами = 1/step пикселей.
      //    При step > 1 в колонке уже агрегат (не отдельный отсчёт) — точки не рисуем.
      if (this.showPoints && cols.step <= 0.34) {
        const r = (1 / cols.step) >= 10 ? 2 : 1;   // полуразмер маркера
        ctx.fillStyle = color;
        for (let c = 0; c < n; c++) {
          if (meanArr[c] === 0x7FFFFFFF || (meanArr[c] === 0 && minArr[c] === 0x7FFFFFFF)) continue;
          const yy = Math.round(clip(y(meanArr[c] * k)));
          const xx = Math.round(c + 0.5);
          ctx.fillRect(xx - r, yy - r, r * 2 + 1, r * 2 + 1);
        }
      }
    };
    if (what === 'u' || what === 'both') {
      drawSeries(COL_U, cols.minU, cols.maxU, cols.meanU, this.calib.k_bus_mv_per_code);
    }
    if (what === 'i' || what === 'both') {
      drawSeries(COL_I, cols.minI, cols.maxI, cols.meanI, this.calib.k_shunt_ma_per_code);
    }

    // подписи полос (с тёмной подложкой, чтобы читались поверх графика)
    ctx.font = '11px Consolas, monospace';
    const labels = [];
    if (what === 'u' || what === 'both') {
      labels.push({ text: `U ${scale.a.toFixed(1)}…${scale.b.toFixed(1)} мВ`, color: COL_U });
    }
    if (what === 'i' || what === 'both') {
      labels.push({ text: `I ${scale.a.toFixed(4)}…${scale.b.toFixed(4)} мА`, color: COL_I });
    }
    if (scale.clipped) {
      const full = what === 'i' ? scales.i.full : scales.u.full;
      labels.push({ text: `обрезано (полный ${full[0].toFixed(1)}…${full[1].toFixed(1)})`, color: COL_CLIP });
    }
    if (what === 'both') labels.push({ text: 'наложение U и I на общей шкале', color: COL_TEXT });
    let ly = area.top + 13;
    for (const lb of labels) {
      const tw = ctx.measureText(lb.text).width;
      ctx.fillStyle = 'rgba(16,18,21,0.78)';
      ctx.fillRect(4, ly - 10, tw + 8, 13);
      ctx.fillStyle = lb.color;
      ctx.fillText(lb.text, 8, ly);
      ly += 14;
    }
  }

  /** Дорожки DIO: ровные уровни линиями, метки активности — только для своей линии. */
  /** Ось времени: подписи в разделителе полос + лёгкие вертикальные линии по панели. */
  _timeAxis(viewport, y) {
    const ctx = this.ctx;
    const w = this.width;
    const span = viewport.duration;
    if (!(span > 0)) return;
    const targets = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 300];
    let step = targets[targets.length - 1];
    for (const t of targets) {
      if (span / t <= 8) { step = t; break; }
    }
    const t0 = Math.ceil(viewport.startTime / step) * step;
    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    for (let t = t0; t <= viewport.endTime + 1e-9; t += step) {
      const x = Math.round(viewport.pairToX(t * viewport.pairsPerSecond, w)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, this.layout.panel.top);
      ctx.lineTo(x, this.layout.panel.bottom);
      ctx.stroke();
      const label = step < 1 ? t.toFixed(3) + ' с' : t.toFixed(step < 10 ? 1 : 0) + ' с';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(16,18,21,0.8)';
      ctx.fillRect(x - tw / 2 - 3, y - 9, tw + 6, 12);
      ctx.fillStyle = 'rgba(160,170,180,0.95)';
      ctx.fillText(label, x, y + 1);
    }
    ctx.textAlign = 'left';
  }

  _dioLanes(cols, area) {
    const ctx = this.ctx;
    const lanes = 8;
    const laneH = (area.bottom - area.top) / lanes;
    ctx.font = '9px Consolas, monospace';
    for (let bit = 0; bit < lanes; bit++) {
      const yTop = area.top + bit * laneH;
      const yHigh = yTop + laneH * 0.18;
      const yLow = yTop + laneH * 0.82;
      ctx.strokeStyle = COL_GRID;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(yTop) + 0.5);
      ctx.lineTo(this.width, Math.round(yTop) + 0.5);
      ctx.stroke();
      ctx.fillStyle = COL_TEXT;
      ctx.fillText('D' + bit, 3, yTop + laneH - 2);

      const model = dioLaneModel(cols, bit);
      // ровные уровни — линиями (как в логическом анализаторе)
      ctx.strokeStyle = COL_DIO_ON;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let prev = null;
      for (const seg of model.levels) {
        const yy = seg.on ? yHigh : yLow;
        if (prev !== null && prev.on !== seg.on) {
          ctx.lineTo(seg.x0 + 0.5, prev.y);        // вертикальный фронт
        }
        ctx.moveTo(seg.x0 + 0.5, yy);
        ctx.lineTo(seg.x1 + 1.5, yy);
        prev = { on: seg.on, y: yy };
      }
      ctx.stroke();
      // метки активности: тонкая вертикальная чёрточка в середине дорожки
      // (во всю высоту дорожки они сливались в сплошные блоки и не читались)
      const actTop = yTop + laneH * 0.34;
      const actH = Math.max(2, laneH * 0.32);
      for (const act of model.activity) {
        ctx.fillStyle = act.always ? COL_DIO_ON : (act.ever ? COL_DIO_MIX : COL_DIO_ACT);
        ctx.fillRect(act.x, actTop, 1, actH);
      }
    }
  }

  _overview(viewport, area) {
    const ctx = this.ctx;
    const w = this.width;
    const total = this.source.length;
    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(0, area.top, w, area.bottom - area.top);
    if (total > 0) {
      // Обзор: всегда через LOD (иначе на короткой записи он читал бы все сырые пары каждый кадр).
      const ovCols = Math.max(2, Math.floor(w / 2));   // обзор — полоска, лишняя детализация не нужна
      const cols = buildColumns(this.pyramid, this.source,
        { from: 0, to: total, columns: ovCols, forceLod: true });
      let uMin = Infinity, uMax = -Infinity;
      for (let c = 0; c < cols.columns; c++) {
        if (cols.minU[c] === 0x7FFFFFFF) continue;
        if (cols.minU[c] < uMin) uMin = cols.minU[c];
        if (cols.maxU[c] > uMax) uMax = cols.maxU[c];
      }
      if (isFinite(uMin)) {
        const h = area.bottom - area.top;
        const y = (v) => area.bottom - ((v - uMin) / Math.max(1e-9, uMax - uMin)) * h;
        ctx.strokeStyle = COL_U;
        ctx.beginPath();
        const px = w / cols.columns;
        for (let c = 0; c < cols.columns; c++) {
          if (cols.minU[c] === 0x7FFFFFFF) continue;
          ctx.moveTo(c * px + 0.5, y(cols.minU[c]));
          ctx.lineTo(c * px + 0.5, y(cols.maxU[c]));
        }
        ctx.stroke();
      }
      const x0 = viewport.pairToX(viewport.from, w);
      const x1 = viewport.pairToX(viewport.to, w);
      ctx.strokeStyle = COL_SEL;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.max(0, x0) + 0.5, area.top + 0.5,
                     Math.max(2, Math.min(w, x1) - Math.max(0, x0) - 1), area.bottom - area.top - 1);
    }
    ctx.fillStyle = COL_TEXT;
    ctx.font = '10px Consolas, monospace';
    ctx.fillText('обзор всей записи', 4, area.bottom - 2);
  }

  _events(viewport, area) {
    if (!this.events || this.events.length === 0) return;
    const ctx = this.ctx;
    const pps = viewport.pairsPerSecond;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    for (const ev of this.events) {
      const pair = (ev.tSeconds != null ? ev.tSeconds : (ev.t || 0) / 1000) * pps;
      if (pair < viewport.from || pair > viewport.to) continue;
      const x = Math.round(viewport.pairToX(pair, this.width)) + 0.5;
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
    }
    ctx.stroke();
  }

  _cursorMark(L) {
    if (!this.cursor) return;
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(Math.round(this.cursor.x) + 0.5, L.plot.top);
    ctx.lineTo(Math.round(this.cursor.x) + 0.5, L.plot.bottom);
    ctx.stroke();
  }

  sampleAt(pairIndex) {
    if (this.source.length === 0) return null;
    const idx = Math.max(0, Math.min(this.source.length - 1, Math.round(pairIndex)));
    return {
      pair: idx,
      u: this.source.u(idx), i: this.source.i(idx), dio: this.source.dio(idx),
      u_mV: this.source.u(idx) * this.calib.k_bus_mv_per_code,
      i_mA: this.source.i(idx) * this.calib.k_shunt_ma_per_code,
    };
  }
}

export const COLORS = { COL_BG, COL_GRID, COL_TEXT, COL_U, COL_I, COL_DIO_ON, COL_DIO_ACT, COL_DIO_MIX, COL_SEL };
