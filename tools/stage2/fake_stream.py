#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Этап 2: генератор синтетических потоков `[size][cmd][payload]` для тестов парсеров.

Собирает кадры 0x3A ровно так, как это делает прошивка (`i2c_dev.c`, I2CDevTask):
  * в 24-битном режиме на каждые 2 чтения — 7 байт (U24 LE, I24 signed LE, DIO);
  * DIO-байт добавляется к каждому второму чтению внутри блока (`n & 1`);
  * при нечётном `pktcnt` граница блока разрывает пару — этот случай тоже умеем
    (`--pktcnt 19`), при этом размер payload = pktcnt*3 + pktcnt/2, не кратный 7.

Использование:
  python tools/stage2/fake_stream.py --out /tmp/fake.bin --pairs 100 --pktcnt 20 --pattern edge
  python tools/stage2/fake_stream.py --out /tmp/fake.bin --pairs 64  --pktcnt 20 --pattern dio
"""

import argparse
import sys

CMD_DEV_EADC = 0x3A


def build_pairs(pattern: str, count: int):
    """Возвращает список пар (u, i, dio); u/i — 24-битные значения (i знаковое)."""
    out = []
    if pattern == "edge":
        # предельные значения: U без знака (0xFFFFFF), I знаковое (минимум и максимум)
        vals = [(0xFFFFFF, -0x800000), (0x800000, 0x7FFFFF), (0, 0), (1, -1),
                (0xFFFFFE, -0x7FFFFF), (0x800001, 0x7FFFFE)]
        for k in range(count):
            out.append(vals[k % len(vals)] + (k & 0xFF,))
    elif pattern == "dio":
        # все 256 масок DIO по одной паре — проверка коротких импульсов/битовой карты
        for k in range(count):
            out.append((100000 + k, -1000 + (k % 3), k & 0xFF))
    elif pattern == "normal":
        for k in range(count):
            out.append((270000 + (k % 100), -2000 + (k % 50), (k // 10) & 0x01))
    else:
        raise SystemExit("неизвестный pattern: %s" % pattern)
    return out


def pack_frames(pairs, pktcnt: int, dio_pairs: bool = True, interleave_cmd: bool = False):
    """Упаковка пар (u, i, dio) в кадры 0x3A по правилам прошивки (`i2c_dev.c`, I2CDevTask).

    `pktcnt` — число ЧТЕНИЙ РЕГИСТРОВ в блоке (как cfg_i2c.pktcnt, а не пар):
      * ISR читает один регистр за такт, регистры чередуются: чётный индекс = U, нечётный = I;
      * на каждое чтение — 3 байта; после каждого нечётного индекса ВНУТРИ блока — байт DIO;
      * размер payload = pktcnt*3 + pktcnt/2 (для нечётного pktcnt — не кратен 7).
    """
    # разворачиваем пары в поток чтений: u0, i0, u1, i1, ...
    reads = []
    for u, i, dio in pairs:
        reads.append((u, dio))
        reads.append((i, dio))

    frames = bytearray()
    idx = 0
    first = True
    while idx < len(reads):
        chunk = reads[idx:idx + pktcnt]
        payload = bytearray()
        for n, (value, dio) in enumerate(chunk):
            v = value & 0xFFFFFF
            payload += bytes((v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF))
            if dio_pairs and (n & 1):
                payload += bytes((dio & 0xFF,))
        frames += bytes((len(payload) & 0xFF, CMD_DEV_EADC)) + payload
        if interleave_cmd and first:
            # ответ на команду в потоке (проверка, что парсеры его игнорируют)
            frames += bytes((2, 0x03, 0x10, 0x00, 0x00, 0x00))
            first = False
        idx += pktcnt
    return bytes(frames)


def main():
    ap = argparse.ArgumentParser(description="Синтетический поток 0x3A")
    ap.add_argument("--out", required=True)
    ap.add_argument("--pairs", type=int, default=100, help="число пар (U,I) в потоке")
    ap.add_argument("--pktcnt", type=int, default=20, help="число чтений регистров в блоке (как в прошивке)")
    ap.add_argument("--pattern", choices=["edge", "dio", "normal"], default="normal")
    ap.add_argument("--no-dio", action="store_true", help="не добавлять DIO-байт (как в 16-битном режиме)")
    ap.add_argument("--interleave-cmd", action="store_true", help="вставить ответ команды в поток")
    args = ap.parse_args()

    pairs = build_pairs(args.pattern, args.pairs)
    data = pack_frames(pairs, args.pktcnt, dio_pairs=not args.no_dio,
                       interleave_cmd=args.interleave_cmd)
    with open(args.out, "wb") as f:
        f.write(data)
    print("пар: %d, pktcnt=%d (чтений в блоке), pattern=%s → %d байт в %s"
          % (len(pairs), args.pktcnt, args.pattern, len(data), args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
