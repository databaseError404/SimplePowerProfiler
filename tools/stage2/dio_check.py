#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Этап 2: проверка DIO по стенду «бегущий бит» (D:\\2026\\PowerProfiler\\esp32_test_stand).

Что делает:
  * захватывает поток 0x3A от прибора и выделяет последовательность масок DIO (по одной на пару);
  * сжимает её в «серии» (маска, длина) и проверяет:
      - набор масок (walk1: 0x01…0x80; walk0: 0xFE…0x7F; count: 0…255);
      - порядок (возрастание/убывание), одиночность изменения бита, отсутствие «смешанных» масок;
      - длительность шага (сверка с ожидаемой, по умолчанию 250 мс);
      - для count — вес каждого бита: соседние маски должны отличаться на +1 (mod 256);
  * при желании сама подаёт команду в консоль стенда (COM143) и возвращает стенд в walk1.

Использование:
  python tools/stage2/dio_check.py --port COM102 --expect walk1 --seconds 4
  python tools/stage2/dio_check.py --port COM102 --console COM143 --send "count 20000" \
      --expect count --seconds 7 --restore
"""

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stage1"))
import measure_pairs as mp   # noqa: E402

WALK1 = [1 << i for i in range(8)]
WALK0 = [0xFF & ~(1 << i) for i in range(8)]


def popcount(v):
    return bin(v).count("1")


def send_console(port, command, baud=115200, wait=0.3):
    import serial
    with serial.Serial(port, baud, timeout=1.0, write_timeout=1.0) as s:
        time.sleep(0.2)
        s.reset_input_buffer()
        s.write((command + "\n").encode())
        time.sleep(wait)
        out = s.read(4096).decode("utf-8", "replace")
    print("консоль стенда ← %r" % command)
    if out.strip():
        print("консоль стенда → %s" % out.strip().replace("\r\n", " | ")[:300])
    return out


def capture(dev, seconds, time_us, clk):
    dev.stop()
    dev.set_format(2)
    resp = dev.start(mp.build_cfg(time_us, clk, 20, mp.MODE_PAIRS))
    if resp[0] is None or (resp[0] & mp.CMD_ERR_FLG):
        raise RuntimeError("не удалось запустить измерение")
    dev.drain(0.2)
    group = mp.GROUP_BYTES[mp.MODE_PAIRS]
    masks = []
    t_end = time.time() + seconds
    while time.time() < t_end:
        dev.poll()
        for cmd, payload in dev.parse():
            if cmd != mp.CMD_DEV_EADC or len(payload) % group:
                continue
            for off in range(0, len(payload), group):
                masks.append(payload[off + 6])
        time.sleep(0.001)
    sta = dev.status()
    dev.stop()
    return masks, sta


def runs_of(masks):
    runs = []
    for m in masks:
        if runs and runs[-1][0] == m:
            runs[-1][1] += 1
        else:
            runs.append([m, 1])
    return runs


def main():
    ap = argparse.ArgumentParser(description="Проверка DIO по стенду бегущего бита")
    ap.add_argument("--port", required=True, help="порт прибора (CH582F)")
    ap.add_argument("--console", help="порт консоли стенда (ESP32), например COM143")
    ap.add_argument("--send", help="команда стенду перед захватом (например 'count 20000')")
    ap.add_argument("--restore", action="store_true", help="после проверки вернуть стенд в walk1 250000")
    ap.add_argument("--expect", choices=["walk1", "walk0", "count", "pulse", "any"], default="walk1")
    ap.add_argument("--pulse-width", type=float, default=100.0, help="ширина импульса стенда, мкс")
    ap.add_argument("--pulse-period", type=float, default=10000.0, help="период импульсов стенда, мкс")
    ap.add_argument("--pulse-mask", type=lambda s: int(s, 0), default=0xFF, help="маска импульса")
    ap.add_argument("--seconds", type=float, default=4.0)
    ap.add_argument("--time", type=int, default=84, help="время преобразования INA228, мкс")
    ap.add_argument("--clk", type=int, default=1300)
    ap.add_argument("--step-ms", type=float, default=250.0, help="ожидаемый шаг стенда, мс")
    ap.add_argument("--max-runs", type=int, default=16)
    args = ap.parse_args()

    pair_us = 2.0 * args.time
    pairs_per_s = 1e6 / pair_us
    if args.send:
        if not args.console:
            print("для --send нужен --console", file=sys.stderr)
            return 2
        send_console(args.console, args.send)
        time.sleep(0.5)

    dev = mp.Device(args.port)
    dev.open()
    try:
        info = dev.probe()
        if not info or info.get("error"):
            print("прибор не отвечает", file=sys.stderr)
            return 2
        print("прибор: DevID=0x%04X Ver=0x%04X; пара = %.0f мкс (%.0f пар/с)"
              % (info["dev_id"], info["ver"], pair_us, pairs_per_s))
        masks, sta = capture(dev, args.seconds, args.time, args.clk)
    finally:
        try:
            dev.stop()
        except Exception:            # noqa: BLE001
            pass
        dev.close()

    if not masks:
        print("нет данных DIO", file=sys.stderr)
        return 1
    runs = runs_of(masks)
    uniq = sorted(set(masks))
    print("сэмплов (пар): %d, серий: %d, уникальных масок: %d" % (len(masks), len(runs), len(uniq)))
    print("маски: %s" % ", ".join("0x%02X×%d" % (m, masks.count(m)) for m in uniq[:20]))
    print()
    print("серии (маска × длина, мс при %.0f пар/с):" % pairs_per_s)
    for m, n in runs[:args.max_runs]:
        print("  0x%02X × %-6d %7.1f мс" % (m, n, n * pair_us / 1000.0))
    if len(runs) > args.max_runs:
        print("  … всего %d серий" % len(runs))

    print()
    problems = []
    expected_set = {"walk1": WALK1, "walk0": WALK0}.get(args.expect)
    if expected_set:
        if uniq != sorted(expected_set):
            problems.append("набор масок не совпал с ожидаемым %s: %s"
                            % (args.expect, [hex(m) for m in uniq]))
        # порядок и одиночность изменения
        want_weight = 1 if args.expect == "walk1" else 7
        for i in range(1, len(runs)):
            a, b = runs[i - 1][0], runs[i][0]
            if popcount(a ^ b) != 2:
                problems.append("переход %02X→%02X меняет %d бит (ожидалось 2)" % (a, b, popcount(a ^ b)))
            if popcount(a) != want_weight:
                problems.append("маска 0x%02X имеет вес %d (ожидалось %d)"
                                % (a, popcount(a), want_weight))
        # длительности серий внутри одного цикла
        durs = [n * pair_us / 1000.0 for _m, n in runs[1:-1]]
        if durs:
            print("длительность шага: мин %.1f мс, медиана %.1f мс, макс %.1f мс (ожидание %.0f мс)"
                  % (min(durs), sorted(durs)[len(durs) // 2], max(durs), args.step_ms))
            med = sorted(durs)[len(durs) // 2]
            if abs(med - args.step_ms) > max(5.0, 0.1 * args.step_ms):
                problems.append("медианный шаг %.1f мс отличается от ожидаемого %.0f мс"
                                % (med, args.step_ms))
        # порядок битов: для walk1 — позиция единственной единицы, для walk0 — позиция единственного нуля
        order = [m for m, _n in runs]

        def walk_idx(m, one):
            bits = m if one else (~m & 0xFF)
            return None if bits == 0 else bits.bit_length() - 1

        idxs = [walk_idx(m, args.expect == "walk1") for m in order]
        idxs = [i for i in idxs if i is not None]
        asc = all(((idxs[i] + 1) & 7) == idxs[i + 1] for i in range(len(idxs) - 1))
        desc = all(((idxs[i] - 1) & 7) == idxs[i + 1] for i in range(len(idxs) - 1))
        print("порядок битов: %s" % ("возрастающий DIO0→DIO7" if asc else
                                     "убывающий DIO7→DIO0" if desc else "не распознан"))
        if not (asc or desc):
            problems.append("последовательность битов не распознана как бегущая единица/ноль")
    elif args.expect == "count":
        if uniq != list(range(256)):
            problems.append("набор масок не равен 0…255 (получено %d уникальных)" % len(uniq))
        bad = 0
        for i in range(1, len(runs)):
            if (runs[i - 1][0] + 1) & 0xFF != runs[i][0]:
                bad += 1
        if bad:
            problems.append("счётчик: %d переходов не равны +1 (вес битов/порядок линий)" % bad)
        durs = [n * pair_us / 1000.0 for _m, n in runs[1:-1]]
        if durs:
            print("длительность шага: медиана %.1f мс (ожидание %.1f мс)"
                  % (sorted(durs)[len(durs) // 2], 20.0))
    elif args.expect == "pulse":
        # DIO сэмплируется один раз на пару → период дискретизации = 2*t_conv
        t_s = pair_us
        duration_ms = len(masks) * t_s / 1000.0
        expected = duration_ms * 1000.0 / args.pulse_period
        pulse_runs = [(m, n) for m, n in runs if m != 0]
        idle_runs = [(m, n) for m, n in runs if m == 0]
        widths_us = [n * t_s for _m, n in pulse_runs]
        seen_masks = sorted(set(m for m, _n in pulse_runs))
        theory = min(1.0, args.pulse_width / t_s)
        print("период дискретизации DIO = %.0f мкс (2×%d мкс); импульс %.0f мкс каждые %.0f мкс"
              % (t_s, args.time, args.pulse_width, args.pulse_period))
        print("импульсов ожидалось ~%.0f, поймано %d (%.1f%%); теоретически ~%.0f%% (ширина/период выборки)"
              % (expected, len(pulse_runs), 100.0 * len(pulse_runs) / expected if expected else 0,
                 100.0 * theory))
        if widths_us:
            print("наблюдаемая ширина пойманных импульсов: мин %.0f, медиана %.0f, макс %.0f мкс"
                  % (min(widths_us), sorted(widths_us)[len(widths_us) // 2], max(widths_us)))
        print("маски импульсов: %s (ожидание 0x%02X); пропусков подряд: %s"
              % ([hex(m) for m in seen_masks], args.pulse_mask,
                 "не считались" if not idle_runs else "%d" % len(idle_runs)))
        if seen_masks and seen_masks != [args.pulse_mask]:
            problems.append("маска импульса не совпала: %s вместо 0x%02X"
                            % ([hex(m) for m in seen_masks], args.pulse_mask))
        if args.pulse_width >= t_s and len(pulse_runs) < 0.9 * expected:
            problems.append("импульсы шириной ≥ периода выборки должны ловиться почти всегда, "
                            "а поймано %.0f%%" % (100.0 * len(pulse_runs) / expected))
        if args.pulse_width < t_s and len(pulse_runs) > 1.5 * expected * theory + 3:
            problems.append("поймано больше импульсов, чем позволяет период выборки")
    else:
        print("режим --expect any: только вывод серий, проверок нет")

    print()
    if problems:
        print("ПРОБЛЕМЫ (%d):" % len(problems))
        for p in problems[:12]:
            print("  - %s" % p)
    else:
        print("ПРОВЕРКА ПРОЙДЕНА: маски и порядок соответствуют ожиданию (%s)" % args.expect)
    if sta:
        print("CMD_DEV_STA: блоков %d, overflow %d" % sta)

    if args.restore and args.console:
        send_console(args.console, "walk1 250000")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
