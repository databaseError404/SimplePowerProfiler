#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Этап 2: захват сырого байтового потока от прибора в файл — образец для сравнения парсеров.

Пишет в файл ровно те байты, что приходят по USB (кадры `[size][cmd][payload]`, включая ответы
на команды и кадры 0x3A), плюс sidecar-JSON с параметрами запуска — чтобы тест совместимости
парсеров был воспроизводим без железа.

Использование:
  python tools/stage2/capture_stream.py --port COM102 --seconds 2 --time 84 --clk 1300 --pktcnt 20 \
      --out docs/stage2/stream-84us-pktcnt20.bin
"""

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stage1"))
import measure_pairs as mp   # noqa: E402  (переиспользуем протокол/парсер из Этапа 1)


def main():
    ap = argparse.ArgumentParser(description="Захват сырого потока 0x3A в файл")
    ap.add_argument("--port", required=True)
    ap.add_argument("--out", required=True, help="файл для сырых байт")
    ap.add_argument("--seconds", type=float, default=2.0)
    ap.add_argument("--time", type=int, default=84, help="время преобразования, мкс")
    ap.add_argument("--clk", type=int, default=1300)
    ap.add_argument("--pktcnt", type=int, default=20)
    ap.add_argument("--mode", choices=[mp.MODE_PAIRS, mp.MODE_VBUS, mp.MODE_VSHUNT, mp.MODE_DUPE],
                    default=mp.MODE_PAIRS)
    ap.add_argument("--shunt-ohm", type=float, default=1.0)
    args = ap.parse_args()

    dev = mp.Device(args.port)
    dev.open()
    try:
        info = dev.probe()
        if not info or info.get("error"):
            print("Прибор не ответил на CMD_DEV_VER", file=sys.stderr)
            return 2
        dev.set_format(mp.FRD_FORMAT[args.mode])
        resp = dev.start(mp.build_cfg(args.time, args.clk, args.pktcnt, args.mode))
        if resp[0] is None or (resp[0] & mp.CMD_ERR_FLG):
            print("Конфигурация отвергнута прибором", file=sys.stderr)
            return 3
        dev.drain(0.2)

        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        t_end = time.time() + args.seconds
        total = 0
        with open(args.out, "wb") as f:
            while time.time() < t_end:
                chunk = dev.poll()
                if chunk:
                    f.write(chunk)
                    total += len(chunk)
                dev.parse()          # поддерживаем разбор, чтобы не терять выравнивание
                time.sleep(0.001)
        sta = dev.status()
    finally:
        try:
            dev.stop()
        except Exception:            # noqa: BLE001
            pass
        dev.close()

    meta = {
        "port": args.port,
        "seconds": args.seconds,
        "time_us": args.time,
        "clk_khz": args.clk,
        "pktcnt": args.pktcnt,
        "mode": args.mode,
        "shunt_ohm": args.shunt_ohm,
        "group_bytes": mp.GROUP_BYTES[args.mode],
        "bytes": total,
        "dev_id": info["dev_id"], "ver": info["ver"],
        "ina_mid": info.get("man_id"), "ina_did": info.get("dev_id_ina"),
        "sta_rd_cnt": None if not sta else sta[0],
        "sta_to_cnt": None if not sta else sta[1],
    }
    with open(args.out + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print("записано %d байт в %s (кадров данных: ~%d)"
          % (total, args.out, total // (2 + args.pktcnt * 3 + args.pktcnt // 2)))
    print("метаданные: %s.json" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
