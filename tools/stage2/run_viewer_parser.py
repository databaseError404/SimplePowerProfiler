#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Этап 2: прогон настоящего парсера из `source/Python/ina228_viewer.py` (`Device._parse`)
по тому же файлу сырого потока. Результат — текстовый файл «u i dio» (как у run_ppjs_parser.mjs).

Использование:
  python tools/stage2/run_viewer_parser.py --in stream.bin --out samples.txt [--chunk 1]
"""

import argparse
import os
import queue
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(REPO, "source", "Python"))

import ina228_viewer as viewer   # noqa: E402  (нужен только импорт модуля, окно не создаётся)


def main():
    ap = argparse.ArgumentParser(description="Прогон парсера Python-viewer по потоку")
    ap.add_argument("--in", dest="infile", required=True)
    ap.add_argument("--out", dest="outfile", required=True)
    ap.add_argument("--chunk", type=int, default=0, help="0 = весь поток одним куском")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    # `Device._parse` использует только эти три атрибута — даём минимальный носитель,
    # чтобы вызвать настоящий метод без создания Tk-окна.
    ns = types.SimpleNamespace(rx=bytearray(), samples=queue.Queue(), responses=queue.Queue())

    with open(args.infile, "rb") as f:
        stream = f.read()

    chunks = ([stream] if args.chunk <= 0 else
              [stream[i:i + args.chunk] for i in range(0, len(stream), args.chunk)])

    for chunk in chunks:
        ns.rx.extend(chunk)
        viewer.Device._parse(ns)

    samples = []
    while not ns.samples.empty():
        samples.append(ns.samples.get_nowait())

    with open(args.outfile, "w", encoding="utf-8", newline="\n") as f:
        for u, i, dio in samples:
            f.write("%d %d %s\n" % (u, i, "" if dio is None else dio))

    if not args.quiet:
        print("viewer: пар=%d, кусков=%d → %s" % (len(samples), len(chunks), args.outfile))
    return 0


if __name__ == "__main__":
    sys.exit(main())
