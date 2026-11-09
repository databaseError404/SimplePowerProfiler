#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Анализ CSV от measure_pairs.py: проверка, что пары U/I не смешивают циклы.

Назначение: при ступенчатом изменении нагрузки (включение/выключение резистора,
переключение нагрузки) ступенька видна и в U, и в I. Если U и I в одной паре взяты из
одного цикла преобразования, фронты совпадут; если INA228 преобразует каналы
последовательно (VBUS, затем VSHUNT), фронт I будет сдвинут относительно фронта U
на время преобразования t_conv (или кратно ему).

Скрипт считает распределение задержек между фронтами U и I в индексах пар и
переводит его в микросекунды: пара = 2*t_conv, поэтому индекс пары = 2*t_conv мкс.

Использование:
  python tools/stage1/measure_pairs.py --port COM102 --time 84 --seconds 5 --csv pairs.csv
  python tools/stage1/analyze_skew.py pairs.csv --time 84 [--threshold-mv 1.0]
"""

import argparse
import csv
import sys


def main():
    ap = argparse.ArgumentParser(description="Оценка сдвига U/I внутри пары по фронтам ступеньки")
    ap.add_argument("csv", help="CSV от measure_pairs.py (pair,rawU,rawI,dio)")
    ap.add_argument("--time", type=int, required=True, help="время преобразования, мкс (как в измерении)")
    ap.add_argument("--shunt-ohm", type=float, default=1.0,
                    help="сопротивление шунта, Ом (по умолчанию 1 — плата стенда; в pp.js зашито 10)")
    ap.add_argument("--threshold-mv", type=float, default=1.0,
                    help="порог фронта U в mV (по умолчанию 1 mV)")
    ap.add_argument("--threshold-ma", type=float, default=None,
                    help="порог фронта I в mA (по умолчанию как для U в кодах)")
    args = ap.parse_args()

    k_bus_mv = 0.01220703125                        # mV на код (как в pp.js)
    k_shunt_ma = 0.00001953125 / args.shunt_ohm     # mA на код при данном шунте

    u_thr = args.threshold_mv / k_bus_mv                       # в кодах
    i_thr = (args.threshold_ma / k_shunt_ma) if args.threshold_ma else u_thr

    us, iss, dios = [], [], []
    with open(args.csv, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            us.append(int(row["rawU"]))
            iss.append(int(row["rawI"]))
            dios.append(int(row["dio"]))
    n = len(us)
    if n < 10:
        print("Слишком мало данных: %d строк" % n, file=sys.stderr)
        return 2

    def edges(arr, thr):
        """Индексы пар, где |изменение| превысило порог."""
        out = []
        for i in range(1, len(arr)):
            if abs(arr[i] - arr[i - 1]) >= thr:
                out.append(i)
        return out

    ue, ie = edges(us, u_thr), edges(iss, i_thr)
    print("пар: %d (%.1f с при %d мкс: 1 пара = %d мкс)"
          % (n, n * 2 * args.time / 1e6, args.time, 2 * args.time))
    print("U: min=%d max=%d размах=%.1f mV, фронтов(>=%.2f mV): %d"
          % (min(us), max(us), (max(us) - min(us)) * k_bus_mv, args.threshold_mv, len(ue)))
    print("I: min=%d max=%d размах=%.3f mA, фронтов: %d"
          % (min(iss), max(iss), (max(iss) - min(iss)) * k_shunt_ma, len(ie)))
    print("DIO: различных масок %d, смен %d"
          % (len(set(dios)), sum(1 for i in range(1, n) if dios[i] != dios[i - 1])))

    if not ue or not ie:
        print("\nФронтов недостаточно: нужна ступенька нагрузки (скрипт не может оценить сдвиг).")
        return 0

    # для каждого фронта U ищем ближайший фронт I и наоборот (слияние двух сортированных списков)
    def nearest(a, b):
        out = []
        j = 0
        for x in a:
            while j + 1 < len(b) and abs(b[j + 1] - x) <= abs(b[j] - x):
                j += 1
            out.append(b[j] - x)
        return out

    d_ui = nearest(ue, ie)
    d_iu = nearest(ie, ue)
    for name, d in (("I относительно U", d_ui), ("U относительно I", d_iu)):
        pos = [x for x in d if x > 0]
        neg = [x for x in d if x < 0]
        zero = [x for x in d if x == 0]
        print("%s: совпадение %d, I позже на %d (медиана %s пар), I раньше на %d (медиана %s пар)"
              % (name, len(zero), len(pos), sorted(pos)[len(pos) // 2] if pos else "-",
                 len(neg), sorted(neg)[len(neg) // 2] if neg else "-"))
    med = sorted(d_ui, key=abs)[len(d_ui) // 2] if d_ui else 0
    print("\nМедианный сдвиг: %d пар = %d мкс (t_conv = %d мкс)"
          % (med, med * 2 * args.time, args.time))
    print("Ожидание: 0 пар, если U и I берутся из одного цикла; ~%.1f пары (%d мкс), "
          "если каналы преобразуются последовательно."
          % (0.5, args.time))
    return 0


if __name__ == "__main__":
    sys.exit(main())
