#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Этап 2: сравнение настоящих парсеров протокола 0x3A на одном и том же потоке.

Парсеры:
  * pp.js (`source/ch583/WEB_USB/pp.js`, класс PPdev.CmdDecode) — его используют
    wso_ina228.htm, wso_ina228+DIO.htm и wso_ina228_basic_legacy.htm;
  * `source/Python/ina228_viewer.py` (`Device._parse`) — legacy Python viewer.

Случаи:
  * реальный захваченный поток (целиком, чанками по 64 Б и по 1 Б);
  * синтетика: предельные значения (U без знака, I знаковое), все 256 масок DIO,
    нечётный pktcnt (размер payload не кратен 7), кадр команды внутри потока.

Использование:
  python tools/stage2/parser_compat.py --stream docs/stage2/stream-84us-pktcnt20.bin
  python tools/stage2/parser_compat.py --stream ... --work build/stage2
"""

import argparse
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
PY = sys.executable
NODE = "node"


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        raise RuntimeError("команда упала: %s\n%s\n%s" % (" ".join(cmd), r.stdout, r.stderr))
    return r.stdout.strip()


def parse_with_both(stream, work, chunk=0, max_bytes=0, quiet=True):
    """Возвращает (samples_ppjs, samples_viewer, seconds_ppjs) — списки строк 'u i dio'."""
    data_file = stream
    if max_bytes:
        data_file = os.path.join(work, "cut-%d.bin" % max_bytes)
        with open(stream, "rb") as f:
            blob = f.read(max_bytes)
        with open(data_file, "wb") as f:
            f.write(blob)

    out_pp = os.path.join(work, "pp.txt")
    out_vw = os.path.join(work, "vw.txt")
    t0 = time.perf_counter()
    run([NODE, os.path.join(HERE, "run_ppjs_parser.mjs"), "--in", data_file, "--out", out_pp,
         "--chunk", str(chunk)] + (["--quiet"] if quiet else []))
    dt_pp = time.perf_counter() - t0
    run([PY, os.path.join(HERE, "run_viewer_parser.py"), "--in", data_file, "--out", out_vw,
         "--chunk", str(chunk)] + (["--quiet"] if quiet else []))
    with open(out_pp, encoding="utf-8") as f:
        pp = f.read().splitlines()
    with open(out_vw, encoding="utf-8") as f:
        vw = f.read().splitlines()
    return pp, vw, dt_pp


def make_synthetic(work, name, args):
    path = os.path.join(work, name)
    run([PY, os.path.join(HERE, "fake_stream.py"), "--out", path] + args)
    return path


def first_diff(a, b):
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return i, x, y
    if len(a) != len(b):
        return min(len(a), len(b)), (a[len(b):] or [''])[0], (b[len(a):] or [''])[0]
    return None


def report(case, pp, vw, note="", dt_pp=None):
    same = pp == vw
    print("%-34s | pp.js: %6d | viewer: %6d | %s%s"
          % (case, len(pp), len(vw), "ИДЕНТИЧНО" if same else "РАЗЛИЧИЕ",
             ("  (%.2f с)" % dt_pp) if dt_pp is not None else ""))
    if not same:
        d = first_diff(pp, vw)
        if d:
            print("      первое расхождение: строка %d: pp.js=%r viewer=%r" % d)
    if note:
        print("      %s" % note)
    return same


def main():
    ap = argparse.ArgumentParser(description="Сравнение парсеров 0x3A")
    ap.add_argument("--stream", default=os.path.join(REPO, "docs", "stage2",
                                                     "stream-84us-pktcnt20.bin"))
    ap.add_argument("--work", default=os.path.join(REPO, "build", "stage2"))
    ap.add_argument("--frag-bytes", type=int, default=4000,
                    help="сколько байт потока брать для пошаговой нарезки (pp.js пересобирает буфер)")
    args = ap.parse_args()

    os.makedirs(args.work, exist_ok=True)
    ok = True

    print("== Сравнение парсеров (pp.js vs Python viewer) ==")
    print("поток: %s" % args.stream)
    print()
    print("%-34s | %-14s | %-14s |" % ("случай", "pp.js пар", "viewer пар"))
    print("-" * 96)

    # 1. реальный поток
    pp, vw, dt = parse_with_both(args.stream, args.work, chunk=0)
    ok &= report("реальный поток, одним куском", pp, vw, dt_pp=dt)

    pp, vw, dt = parse_with_both(args.stream, args.work, chunk=64)
    ok &= report("реальный поток, чанки по 64 Б", pp, vw, dt_pp=dt)

    pp, vw, dt = parse_with_both(args.stream, args.work, chunk=7)
    ok &= report("реальный поток, чанки по 7 Б", pp, vw, dt_pp=dt)

    pp, vw, dt = parse_with_both(args.stream, args.work, chunk=1, max_bytes=args.frag_bytes)
    ok &= report("реальный поток, по 1 Б (первые %d Б)" % args.frag_bytes, pp, vw,
                 note="нарезка по 1 байту — стресс для парсеров; pp.js пересобирает буфер на каждом куске",
                 dt_pp=dt)

    # 2. синтетика
    s_edge = make_synthetic(args.work, "fake-edge.bin",
                            ["--pairs", "600", "--pktcnt", "20", "--pattern", "edge"])
    pp, vw, _ = parse_with_both(s_edge, args.work)
    ok &= report("синтетика: предельные U/I", pp, vw,
                 note="проверяются U=0xFFFFFF/0x800000 (без знака) и I=-0x800000/0x7FFFFF (знаковое)")

    s_dio = make_synthetic(args.work, "fake-dio.bin",
                           ["--pairs", "256", "--pktcnt", "20", "--pattern", "dio"])
    pp, vw, _ = parse_with_both(s_dio, args.work)
    dio_pp = [int(x.split()[2]) for x in pp]
    dio_vw = [int(x.split()[2]) for x in vw]
    ok &= report("синтетика: все 256 масок DIO", pp, vw,
                 note="каждая пара несёт свою маску: уникальных масок pp.js=%d, viewer=%d (ожидалось 256)"
                      % (len(set(dio_pp)), len(set(dio_vw))))

    s_odd = make_synthetic(args.work, "fake-odd.bin",
                           ["--pairs", "190", "--pktcnt", "19", "--pattern", "normal"])
    pp, vw, _ = parse_with_both(s_odd, args.work)
    ok &= report("синтетика: нечётный pktcnt=19", pp, vw,
                 note="payload=66 Б не кратен 7: pp.js читает за границей кадра, viewer отбрасывает хвост")

    s_cmd = make_synthetic(args.work, "fake-cmd.bin",
                           ["--pairs", "100", "--pktcnt", "20", "--pattern", "normal",
                            "--interleave-cmd"])
    pp, vw, _ = parse_with_both(s_cmd, args.work)
    ok &= report("синтетика: кадр команды в потоке", pp, vw,
                 note="парсеры должны игнорировать не-0x3A кадры")

    print()
    print("ИТОГ:", "все случаи совпали" if ok else "ЕСТЬ РАСХОЖДЕНИЯ (см. выше)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
