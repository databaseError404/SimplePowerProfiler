#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Этап 2: стендовые проверки устойчивости (без внешних сигналов и без перепрошивки).

Подкоманды:
  pktcnt     — границы/чётность pktcnt: какие значения принимаются, что возвращает прибор,
               где начинается опасная зона (ёмкость выходного блока i2c_blk = 120 Б).
               Безопасно: используется большой период чтения (time=4120, multiplier=3),
               чтобы блок не успел собраться до остановки измерения.
  loss       — инъекция потерь «паузой хоста»: перестаём читать порт на N секунд при 10k пар/с,
               смотрим счётчик overflow (to_cnt) и что видит хост.
  cmd-drop   — доля потерянных команд при высоком потоке (гонка app_cmd_len в DevEP1_OUT_Deal).
  reconnect  — закрытие/открытие порта на ходу (DTR -> CMD_I2C_PWR: сон/пробуждение датчика),
               проверка восстановления.

Использование:
  python tools/stage2/robustness_tests.py --port COM102 pktcnt
  python tools/stage2/robustness_tests.py --port COM102 loss --seconds 3
  python tools/stage2/robustness_tests.py --port COM102 cmd-drop
  python tools/stage2/robustness_tests.py --port COM102 reconnect
"""

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stage1"))
import measure_pairs as mp   # noqa: E402

# Ёмкость выходного блока в прошивке: i2c_blk.data = uint16_t[60] = 120 байт,
# в 24-битном режиме пишется count = pktcnt*3 + pktcnt/2 байт.
I2C_BLK_BYTES = 120
MAX_I2C_PKTCNT24 = 40


def block_bytes(pktcnt):
    return pktcnt * 3 + pktcnt // 2


def cmd_pktcnt(dev, args):
    print("== Границы pktcnt (24-битный режим) ==")
    print("ёмкость i2c_blk.data: %d Б; MAX_I2C_PKTCNT24 = %d" % (I2C_BLK_BYTES, MAX_I2C_PKTCNT24))
    print("payload(pktcnt) = pktcnt*3 + pktcnt/2; безопасно, пока payload <= %d → pktcnt <= %d"
          % (I2C_BLK_BYTES, max(p for p in range(1, 256) if block_bytes(p) <= I2C_BLK_BYTES)))
    print()
    print("%8s | %8s | %8s | %s" % ("запрошен", "применён", "payload", "результат"))
    print("-" * 78)

    # Большой период чтения: блок из ~40 чтений собирается >1 с, а тест занимает ~0.3 с,
    # поэтому опасные конфигурации проверяются БЕЗ сборки блока (нет выхода за буфер).
    slow_time, slow_mult = 4120, 3
    for want in args.values:
        dev.stop()
        dev.set_format(2)
        cfg = mp.build_cfg(slow_time, 1300, want, mp.MODE_PAIRS, multiplier=slow_mult)
        t0 = time.perf_counter()
        resp = dev.start(cfg)
        dt = (time.perf_counter() - t0) * 1000
        applied = None
        if resp[0] is not None and len(resp[1]) >= 1:
            applied = resp[1][0]
        rejected = resp[0] is not None and (resp[0] & mp.CMD_ERR_FLG)
        # немедленная остановка: блок ещё не собран
        dev.stop()
        payload = block_bytes(applied) if applied else None
        if resp[0] is None:
            verdict = "НЕТ ОТВЕТА (команда потеряна)"
        elif rejected:
            verdict = "ОТВЕРГНУТО прибором"
        elif payload and payload > I2C_BLK_BYTES:
            verdict = "ПРИНЯТО, но payload > %d Б → выход за i2c_blk (%d Б лишних)!" \
                      % (I2C_BLK_BYTES, payload - I2C_BLK_BYTES)
        else:
            verdict = "принято, в пределах буфера"
        print("%8s | %8s | %8s | %s   (ответ %.0f мс)" % (want, applied, payload, verdict, dt))
        time.sleep(0.2)

    print()
    print("Примечание: pktcnt >= %d проверены без сборки блока (период %d мкс × 8 = %.0f мс на чтение);"
          % (35, slow_time, slow_time * 8 / 1000.0))
    print("реальный выход за буфер в I2CDevTask на стенде НЕ вызывался.")
    return 0


def cmd_loss(dev, args):
    print("== Инъекция потерь: пауза хоста на %.1f с при 10k пар/с ==" % args.seconds)
    dev.stop()
    dev.set_format(2)
    resp = dev.start(mp.build_cfg(50, 1500, 20, mp.MODE_PAIRS))
    if resp[0] is None or (resp[0] & mp.CMD_ERR_FLG):
        print("не удалось запустить измерение на 50 мкс / 1500 кГц")
        return 1
    dev.drain(0.3)
    group = mp.GROUP_BYTES[mp.MODE_PAIRS]
    blocks_per_s = 1000.0          # 10000 пар/с ÷ 10 пар в блоке (pktcnt=20)

    def read_for(seconds):
        n = 0
        t_end = time.time() + seconds
        while time.time() < t_end:
            dev.poll()
            for cmd, payload in dev.parse():
                if cmd == mp.CMD_DEV_EADC and len(payload) % group == 0:
                    n += len(payload) // group
            time.sleep(0.001)
        return n

    sta0 = dev.status()
    t1 = time.perf_counter()
    before = read_for(2.0)
    dt1 = time.perf_counter() - t1
    sta1 = dev.status()
    if not (sta0 and sta1):
        print("счётчики CMD_DEV_STA недоступны")
        return 1
    print("фаза 1 (%.1f с, чтение идёт):  принято пар %d; блоков записано %d (%.0f/с), overflow %d"
          % (dt1, before, sta1[0] - sta0[0], (sta1[0] - sta0[0]) / dt1, sta1[1] - sta0[1]))

    t_pause = time.perf_counter()
    time.sleep(args.seconds)              # хост не читает порт — «пауза вкладки»
    dt_pause = time.perf_counter() - t_pause

    # STA после паузы: ответ проходит через тот же FIFO, поэтому сначала вычитывается
    # накопленный «хвост» — считаем его отдельно (это данные, которые не потеряны).
    backlog = 0
    t_drain = time.perf_counter()
    while True:
        for cmd, payload in dev.parse():
            if cmd == mp.CMD_DEV_EADC and len(payload) % group == 0:
                backlog += len(payload) // group
        if dev.buf:
            dev.poll()
        if time.perf_counter() - t_drain > 0.05 and not dev.buf:
            break
        dev.poll()
        time.sleep(0.001)
    sta2 = dev.status()
    dt_drain = time.perf_counter() - t_drain
    dev.stop()

    if not sta2:
        print("счётчики CMD_DEV_STA недоступны после паузы")
        return 1
    written = sta2[0] - sta1[0]
    dropped = sta2[1] - sta1[1]
    expected = blocks_per_s * dt_pause
    print("пауза %.2f с (порт открыт, не читаем): записано блоков %d (%.0f/с), overflow %d (%.0f/с),"
          % (dt_pause, written, written / dt_pause, dropped, dropped / dt_pause))
    print("    принято хостом сразу после паузы (хвост): %d пар = %.0f блоков за %.2f с"
          % (backlog, backlog / 10.0, dt_drain))
    print("    ожидалось блоков за паузу (таймер не останавливается): ~%.0f" % expected)
    print("    учтено счётчиками (записано+overflow): %d → НЕ учтено (перезапись кольца): ~%.0f блоков (%.0f пар)"
          % (written + dropped, max(0.0, expected - written - dropped),
             max(0.0, expected - written - dropped) * 10))
    print()
    print("Механизм: при полном FIFO каждый блок отбрасывается, а `app_drv_fifo_write` печатает")
    print("`FIFO full! %d < %d` в UART1 (строка есть в образе) — это блокирующий printf ~2 мс на событие.")
    print("Поэтому основной цикл обрабатывает лишь несколько сотен событий/с, кольцо i2c_buf (256 чтений)")
    print("перезаписывается, и эта потеря НИГДЕ не считается: в потоке 0x3A нет номеров блоков,")
    print("а to_cnt учитывает только неудачные записи в FIFO и сбрасывается при старте измерения.")
    return 0


def cmd_cmd_drop(dev, args):
    print("== Потери команд при высоком потоке (гонка app_cmd_len) ==")
    print("%-34s | %8s | %8s | %s" % ("условие", "отправлено", "ответов", "потеряно"))
    print("-" * 78)

    def probe(n, timeout=0.3):
        ok = 0
        for _ in range(n):
            c, _p = dev.cmd(bytes([2, mp.CMD_DEV_GRG, mp.INA_ADDR, mp.INA_RA_CONFIG]),
                            mp.CMD_DEV_GRG, timeout=timeout)
            if c is not None:
                ok += 1
        return ok

    dev.stop()
    time.sleep(0.3)
    dev.drain(0.3)
    n = args.count
    ok_idle = probe(n)
    print("%-34s | %8d | %8d | %d" % ("измерение остановлено", n, ok_idle, n - ok_idle))

    for time_us, clk in ((84, 1300), (50, 1500)):
        dev.set_format(2)
        dev.start(mp.build_cfg(time_us, clk, 20, mp.MODE_PAIRS))
        dev.drain(0.3)
        ok = probe(n)
        print("%-34s | %8d | %8d | %d"
              % ("поток %d пар/с (%d мкс, %d кГц)"
                 % (int(1e6 // (2 * time_us)), time_us, clk), n, ok, n - ok))
        dev.stop()
        time.sleep(0.2)
        dev.drain(0.3)

    # Залп: команды подряд без ожидания ответа — проверка гонки app_cmd_len
    def burst(count, time_us, clk):
        dev.set_format(2)
        dev.start(mp.build_cfg(time_us, clk, 20, mp.MODE_PAIRS))
        dev.drain(0.3)
        packet = bytes([2, mp.CMD_DEV_GRG, mp.INA_ADDR, mp.INA_RA_CONFIG])
        dev.ser.write(packet * count)
        got = 0
        t_end = time.time() + 2.0
        while time.time() < t_end:
            dev.poll()
            for cmd, _p in dev.parse():
                if cmd == mp.CMD_DEV_GRG:
                    got += 1
            time.sleep(0.001)
        dev.stop()
        time.sleep(0.2)
        dev.drain(0.3)
        return got

    for time_us, clk, label in ((84, 1300, "остановлено"), (50, 1500, "10k пар/с")):
        if label == "остановлено":
            dev.stop()
            time.sleep(0.2)
        got = burst(n, time_us, clk)
        print("%-34s | %8d | %8d | %d" % ("залп без ожидания (%s)" % label, n, got, n - got))

    print()
    print("Причина потерь: DevEP1_OUT_Deal() копирует пакет только если app_cmd_len == 0,")
    print("иначе принятый пакет отбрасывается без повтора и без уведомления хоста.")
    return 0


def cmd_reconnect(dev, args):
    print("== Закрытие/открытие порта на ходу (DTR -> CMD_I2C_PWR: сон/пробуждение) ==")
    dev.set_format(2)
    dev.start(mp.build_cfg(84, 1300, 20, mp.MODE_PAIRS))
    dev.drain(0.5)
    group = mp.GROUP_BYTES[mp.MODE_PAIRS]
    n = 0
    t_end = time.time() + 1.0
    while time.time() < t_end:
        dev.poll()
        for cmd, payload in dev.parse():
            if cmd == mp.CMD_DEV_EADC and len(payload) % group == 0:
                n += len(payload) // group
        time.sleep(0.001)
    print("до закрытия порта: принято пар за 1 с = %d" % n)

    port = dev.port
    dev.close()                       # DTR снимается → CMD_I2C_PWR(0) → I2CDevSleep
    print("порт закрыт (DTR off → питание INA228 выключено прошивкой)")
    time.sleep(1.0)
    dev = mp.Device(port)
    try:
        dev.open()                    # DTR on → CMD_I2C_PWR(1) → I2CDevWakeUp
    except Exception as e:            # noqa: BLE001
        print("!! не удалось открыть порт повторно: %s" % e)
        return 1
    info = dev.probe()
    print("после повторного открытия: probe =", info)
    dev.set_format(2)
    resp = dev.start(mp.build_cfg(84, 1300, 20, mp.MODE_PAIRS))
    dev.drain(0.3)
    n2 = 0
    t_end = time.time() + 1.0
    while time.time() < t_end:
        dev.poll()
        for cmd, payload in dev.parse():
            if cmd == mp.CMD_DEV_EADC and len(payload) % group == 0:
                n2 += len(payload) // group
        time.sleep(0.001)
    sta = dev.status()
    dev.stop()
    print("после повторного открытия: принято пар за 1 с = %d, CMD_DEV_STA = %s" % (n2, sta))
    print("вывод: %s" % ("восстановление ok" if (info and n2 > 0) else "!! восстановление НЕ подтверждено"))
    return 0


def main():
    ap = argparse.ArgumentParser(description="Стендовые проверки устойчивости (Этап 2)")
    ap.add_argument("--port", required=True)
    ap.add_argument("command", choices=["pktcnt", "loss", "cmd-drop", "reconnect"])
    ap.add_argument("--seconds", type=float, default=3.0, help="длина паузы хоста (loss)")
    ap.add_argument("--count", type=int, default=30, help="число команд в тесте cmd-drop")
    ap.add_argument("--values", default="20,19,34,35,40,60",
                    help="значения pktcnt для теста (через запятую)")
    args = ap.parse_args()
    args.values = [int(x) for x in args.values.split(",")]

    dev = mp.Device(args.port)
    dev.open()
    try:
        info = dev.probe()
        if not info or info.get("error"):
            print("прибор не отвечает", file=sys.stderr)
            return 2
        print("прибор: DevID=0x%04X Ver=0x%04X\n" % (info["dev_id"], info["ver"]))
        if args.command == "pktcnt":
            return cmd_pktcnt(dev, args)
        if args.command == "loss":
            return cmd_loss(dev, args)
        if args.command == "cmd-drop":
            return cmd_cmd_drop(dev, args)
        return cmd_reconnect(dev, args)
    finally:
        try:
            dev.stop()
        except Exception:             # noqa: BLE001
            pass
        dev.close()


if __name__ == "__main__":
    sys.exit(main())
