#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Этап 1 плана PLAN.md: измерение реальных частот пар U/I и корректности пар.

Скрипт НЕ перепрошивает прибор и НЕ меняет формат 0x3A. Он только:
  * опрашивает версию (CMD_DEV_VER 0x00) и идентификаторы INA228 (CMD_DEV_GRG 0x10);
  * запускает/останавливает штатное измерение теми же командами, что и веб-страница
    (CMD_DEV_FRD 0x18 -> CMD_DEV_CFG 0x01);
  * читает поток CMD_DEV_EADC 0x3A и считает пары/с, байты/с, min/max U/I, счётчики.

Протокол (source/ch583/I2C2USB/src/cmd_cfg.h, cmd_decode.c, i2c_dev.c):
  кадр: [size][cmd][size байт данных]
  0x3A в 24-битном режиме пар: 7 байт на пару = U(3, LE) I(3, LE signed) DIO(1)
  0x3A в 24-битном режиме одного канала: 3 байта на отсчёт
  CMD_DEV_STA 0x03 -> rd_cnt (число отправленных БЛОКОВ), to_cnt (число потерянных блоков)

Использование:
  python tools/stage1/measure_pairs.py --list
  python tools/stage1/measure_pairs.py --port COM102 --probe
  python tools/stage1/measure_pairs.py --port COM102 --sweep --seconds 5
  python tools/stage1/measure_pairs.py --port COM102 --time 84 --seconds 10 --csv pairs.csv
  python tools/stage1/measure_pairs.py --port COM102 --dupe-check --time 84

Единицы: значения печатаются и «как есть» (raw 24-бит), и в физических величинах:
U в мВ (kBus = 0.01220703125 мВ/код, как в pp.js), I в мА — из шунта (по умолчанию 1 Ом —
плата этого стенда; в pp.js зашито 10 Ом, поэтому шкала мА там занижена в 10 раз).
Абсолютная точность здесь не проверяется (калибровка платы не подтверждена).
"""

import argparse
import sys
import time

try:
    import serial
    from serial.tools import list_ports
except ImportError:  # pragma: no cover
    print("Нужен pyserial: python -m pip install pyserial", file=sys.stderr)
    raise SystemExit(2)

# ---------------------------------------------------------------- протокол
CMD_DEV_VER = 0x00
CMD_DEV_CFG = 0x01
CMD_DEV_STA = 0x03
CMD_DEV_GRG = 0x10
CMD_DEV_FRD = 0x18
CMD_DEV_EADC = 0x3A
CMD_I2C_PWR = 0x40
CMD_ERR_FLG = 0x80

INA_ADDR = 0x80
INA_RA_CONFIG = 0x00
INA_RA_ADC_CONFIG = 0x01
INA_RA_VSHUNT = 0x04
INA_RA_VBUS = 0x05
INA_RA_DIAG_ALRT = 0x0B
INA_RA_MAN_ID = 0x3E
INA_RA_DEV_ID = 0x3F

# Индексы времени преобразования INA228 -> мкс (ina228.h, tab_time_us в cmd_decode.c)
CONV_TIME_US = [50, 84, 150, 280, 540, 1052, 2074, 4120]
# Аппаратный предел: одно преобразование на канал; пара U/I = bus + shunt.
# Регистры VBUS/VSHUNT обновляются раз в 2*t_conv (проверено на стенде, см. docs/stage1-baseline.md),
# а прошивка читает один регистр за такт таймера => одна группа (2 чтения) за 2*t_conv.
def ideal_rate(time_us, mode):
    return 1_000_000.0 / (2.0 * time_us)

# Смещения/коэффициенты отображения как в pp.js (mV, mA при шунте 10 Ом)
K_BUS_MV = 0.01220703125
# 1 LSB 20-битного VSHUNT = 312.5 нВ; в 24-битном регистре код = LSB/16 →
# I[mA] = raw * 1.953125e-5 / R[Ом]. В pp.js зашито R = 10 Ом (kShunt = 1.9613524e-6),
# но на плате этого стенда шунт **1 Ом** → у страницы шкала мА занижена в 10 раз.
K_SHUNT_MA_PER_OHM = 0.00001953125   # I[mA] = raw * K / R
SHUNT_DEFAULT_OHM = 1.0              # фактический шунт платы (подтверждено пользователем)
VSHUNT_FSR_MV = 163.84               # CONFIG bit4 = 0 (диапазон ±163.84 мВ)

MODE_PAIRS = "pairs"      # 24 бита, VBUS+VSHUNT, + байт DIO  (i2c_rd_24bit = 2)
MODE_VBUS = "vbus"        # 24 бита, только VBUS             (i2c_rd_24bit = 1)
MODE_VSHUNT = "vshunt"    # 24 бита, только VSHUNT           (i2c_rd_24bit = 1)
MODE_DUPE = "dupe"        # 24 бита, VBUS дважды в rd[]      (i2c_rd_24bit = 2)

ADC_CONFIG_MODE = {       # биты 15..12 ADC_CONFIG
    MODE_PAIRS: 0xB,      # Continuous bus voltage, shunt voltage
    MODE_VBUS: 0x9,       # Continuous bus voltage only
    MODE_VSHUNT: 0xA,     # Continuous shunt voltage only
    MODE_DUPE: 0xB,
}
FRD_FORMAT = {MODE_PAIRS: 2, MODE_DUPE: 2, MODE_VBUS: 1, MODE_VSHUNT: 1}
# ВАЖНО: в 24-битном режиме прошивка ВСЕГДА кладёт по 7 байт на 2 чтения (U,I,DIO),
# даже если rd[0] и rd[1] — один и тот же регистр (см. i2c_dev.c, I2CDevTask:
# count = raw*3 + raw/2 при любом ненулевом i2c_rd_24bit).
GROUP_BYTES = {MODE_PAIRS: 7, MODE_DUPE: 7, MODE_VBUS: 7, MODE_VSHUNT: 7}


def build_cfg(time_us, clk_khz, pktcnt, mode, multiplier=0, adc_ct=None):
    """Пакет CMD_DEV_CFG: [38][0x01] + 38 байт dev_i2c_cfg_t (без crc).

    time_us — период чтения регистров прошивкой (cfg_i2c.time), мкс;
    adc_ct  — индекс времени преобразования INA228 (0..7), если нужно отвязать его
              от периода чтения (диагностика темпа обновления ADC).
    """
    idx = CONV_TIME_US.index(time_us) if time_us in CONV_TIME_US else 0
    ct = idx if adc_ct is None else adc_ct
    adc_cfg = (ADC_CONFIG_MODE[mode] << 12) | (ct << 3) | (ct << 6) | (ct << 9)
    rd0 = INA_RA_VBUS if mode in (MODE_PAIRS, MODE_DUPE) else (
        INA_RA_VBUS if mode == MODE_VBUS else INA_RA_VSHUNT)
    rd1 = INA_RA_VSHUNT if mode == MODE_PAIRS else (
        INA_RA_VBUS if mode == MODE_DUPE else (INA_RA_VBUS if mode == MODE_VBUS else INA_RA_VSHUNT))
    init = [
        (INA_ADDR, INA_RA_CONFIG, 0xC000),      # system reset
        (INA_ADDR, INA_RA_DIAG_ALRT, 0x4000),   # ALERT on conversion ready (как в прошивке)
        (INA_ADDR, INA_RA_CONFIG, 0x0000),      # shunt FSR +-163.84 mV
        (INA_ADDR, INA_RA_ADC_CONFIG, adc_cfg),
    ]
    rd = [(INA_ADDR, rd0), (INA_ADDR, rd1), (0, 0), (0, 0)]
    slp = [(INA_ADDR, INA_RA_ADC_CONFIG, 0x0000), (0, 0, 0)]
    payload = bytes([pktcnt & 0xFF, multiplier & 0xFF,
                     time_us & 0xFF, (time_us >> 8) & 0xFF,
                     clk_khz & 0xFF, (clk_khz >> 8) & 0xFF])
    for dev, reg, data in init:
        payload += bytes([dev, reg, data & 0xFF, (data >> 8) & 0xFF])
    for dev, reg in rd:
        payload += bytes([dev, reg])
    for dev, reg, data in slp:
        payload += bytes([dev, reg, data & 0xFF, (data >> 8) & 0xFF])
    assert len(payload) == 38, len(payload)
    return bytes([38, CMD_DEV_CFG]) + payload


def signed24(v):
    return v - 0x1000000 if v >= 0x800000 else v


class Device:
    def __init__(self, port, baud=115200, verbose=False):
        self.port = port
        self.baud = baud
        self.verbose = verbose
        self.ser = None
        self.buf = bytearray()
        self.pkts = []          # [(cmd, payload), ...] непринятые кадры
        self.raw_bytes = 0
        self.frames = 0

    # -------------------------------------------------- низкий уровень
    def open(self):
        self.ser = serial.Serial(self.port, self.baud, timeout=0.05, write_timeout=1.0)
        # Открытие порта у этого firmware -> SET_CONTROL_LINE_STATE -> CMD_I2C_PWR(DTR)
        # (питание INA228 + инициализация I2C, измерение НЕ стартует: pktcnt остаётся 0)
        time.sleep(0.2)
        self.ser.reset_input_buffer()

    def close(self):
        if self.ser:
            self.ser.close()
            self.ser = None

    def write(self, data):
        if self.verbose:
            print("  ->", data.hex(" "), file=sys.stderr)
        self.ser.write(data)

    def poll(self):
        chunk = self.ser.read(4096)
        if chunk:
            self.raw_bytes += len(chunk)
            self.buf += chunk
        return chunk

    def parse(self):
        """Разбирает накопленный буфер на кадры [size][cmd][data]."""
        out = []
        while len(self.buf) >= 2:
            size = self.buf[0]
            if len(self.buf) < size + 2:
                break
            cmd = self.buf[1]
            payload = bytes(self.buf[2:size + 2])
            del self.buf[:size + 2]
            self.frames += 1
            out.append((cmd, payload))
        return out

    def drain(self, seconds=0.5):
        t_end = time.time() + seconds
        got = []
        while time.time() < t_end:
            self.poll()
            got += self.parse()
            time.sleep(0.002)
        return got

    def wait_cmd(self, cmd, timeout=2.0):
        """Ждёт ответ на команду. Буфер НЕ очищается: поток 0x3A непрерывен,
        и сброс накопленного буфера сдвинул бы выравнивание кадров."""
        t_end = time.time() + timeout
        while time.time() < t_end:
            for c, p in self.parse():
                if c == cmd or (c & 0x7F) == cmd:
                    return c, p
            self.poll()
            time.sleep(0.002)
        return None, None

    def cmd(self, data, expect, timeout=2.0):
        self.write(data)
        return self.wait_cmd(expect, timeout)

    # -------------------------------------------------- команды
    def probe(self):
        c, p = self.cmd(bytes([0, CMD_DEV_VER]), CMD_DEV_VER)
        if c is None:
            return None
        if c & CMD_ERR_FLG:
            return {"error": True}
        dev_id = p[0] | (p[1] << 8)
        ver = p[2] | (p[3] << 8)
        info = {"dev_id": dev_id, "ver": ver}
        for name, reg in (("man_id", INA_RA_MAN_ID), ("dev_id_ina", INA_RA_DEV_ID)):
            c2, p2 = self.cmd(bytes([2, CMD_DEV_GRG, INA_ADDR, reg]), CMD_DEV_GRG)
            info[name] = None if c2 is None or (c2 & CMD_ERR_FLG) else (p2[2] | (p2[3] << 8))
        return info

    def set_format(self, fmt):
        return self.cmd(bytes([1, CMD_DEV_FRD, fmt]), CMD_DEV_FRD)

    def start(self, cfg_pkt):
        return self.cmd(cfg_pkt, CMD_DEV_CFG)

    def stop(self):
        self.write(bytes([1, CMD_DEV_CFG, 0]))   # pktcnt = 0
        self.drain(0.3)

    def status(self, attempts=5):
        """CMD_DEV_STA с повторами: при потоке 0x3A команда может быть отброшена,
        если пришла, пока app_cmd_len != 0 (Main.c/DevEP1_OUT_Deal, приём без очереди)."""
        for _ in range(attempts):
            c, p = self.cmd(bytes([0, CMD_DEV_STA]), CMD_DEV_STA, timeout=1.0)
            if c is not None and not (c & CMD_ERR_FLG) and len(p) >= 8:
                return (int.from_bytes(p[0:4], "little"), int.from_bytes(p[4:8], "little"))
        return None


def measure(dev, args, mode, time_us, clk_khz, pktcnt, seconds, csv_path=None,
            drain_seconds=1.0, adc_ct=None):
    """Запускает измерение, собирает статистику за `seconds` секунд."""
    fmt_ok = dev.set_format(FRD_FORMAT[mode])
    if fmt_ok[0] is None:
        print("  !! нет ответа на CMD_DEV_FRD")
        return None
    resp = dev.start(build_cfg(time_us, clk_khz, pktcnt, mode, adc_ct=adc_ct))
    if resp[0] is None:
        resp = dev.start(build_cfg(time_us, clk_khz, pktcnt, mode, adc_ct=adc_ct))   # повтор: команда могла быть отброшена
    if resp[0] is None:
        print("  !! нет ответа на CMD_DEV_CFG")
        return None
    if resp[0] & CMD_ERR_FLG:
        print("  !! прибор отверг конфигурацию (CMD_ERR_FLG): time=%d us, clk=%d kHz, pktcnt=%d"
              % (time_us, clk_khz, pktcnt))
        return None
    cfg_echo = resp[1]
    echo_pktcnt, echo_time = cfg_echo[0], cfg_echo[2] | (cfg_echo[3] << 8)
    echo_clk = cfg_echo[4] | (cfg_echo[5] << 8)
    if (echo_pktcnt, echo_time, echo_clk) != (pktcnt, time_us, clk_khz):
        print("  !! прибор применил другие параметры: pktcnt=%d time=%d clk=%d"
              % (echo_pktcnt, echo_time, echo_clk))

    dev.drain(0.2)                     # хвост ответа/старые данные
    sta0 = dev.status()

    group = GROUP_BYTES[mode]
    stats = {
        "t0": time.time(), "pairs": 0, "drain_pairs": 0, "data_bytes": 0, "packets": 0,
        "pkt_sizes": {}, "u_min": None, "u_max": None, "i_min": None, "i_max": None,
        "dio_changes": 0, "dio_masks": set(), "misaligned": 0,
        "u_sum": 0.0, "i_sum": 0.0, "dupe_pairs": 0, "dupe_total": 0, "in_drain": False,
    }
    csv_f = open(csv_path, "w", encoding="utf-8") if csv_path else None
    if csv_f:
        csv_f.write("pair,rawU,rawI,dio\n")
    prev_dio = None
    prev_raw = [None, None]
    t_end = time.time() + seconds
    t_drain = t_end + drain_seconds
    try:
        while time.time() < t_drain:
            if not stats["in_drain"] and time.time() >= t_end:
                stats["in_drain"] = True
                stats["dt_window"] = time.time() - stats["t0"]
            dev.poll()
            for cmd, payload in dev.parse():
                if cmd != CMD_DEV_EADC:
                    continue
                if len(payload) % group:
                    stats["misaligned"] += 1
                    continue
                stats["packets"] += 1
                stats["pkt_sizes"][len(payload)] = stats["pkt_sizes"].get(len(payload), 0) + 1
                stats["data_bytes"] += len(payload)
                for off in range(0, len(payload), group):
                    if group == 7:
                        ru = payload[off] | (payload[off + 1] << 8) | (payload[off + 2] << 16)
                        ri = signed24(payload[off + 3] | (payload[off + 4] << 8) | (payload[off + 5] << 16))
                        dio = payload[off + 6]
                        stats["dio_masks"].add(dio)
                        if prev_dio is not None and dio != prev_dio:
                            stats["dio_changes"] += 1
                        prev_dio = dio
                    else:
                        ru = payload[off] | (payload[off + 1] << 8) | (payload[off + 2] << 16)
                        ri = None
                    if stats["in_drain"]:
                        stats["drain_pairs"] += 1
                    else:
                        stats["pairs"] += 1
                    n = stats["pairs"] + stats["drain_pairs"]
                    if csv_f:
                        csv_f.write("%d,%d,%s,%s\n" % (n, ru, "" if ri is None else ri,
                                                       "" if group != 7 else prev_dio))
                    if mode == MODE_DUPE:
                        # VBUS читается дважды за период: если период чтения совпал с
                        # периодом обновления ADC, значения в паре должны дублироваться
                        stats["dupe_total"] += 1
                        if prev_raw[1] is not None and ru == prev_raw[1]:
                            stats["dupe_pairs"] += 1
                        prev_raw[1] = ru
                    if ru is not None:
                        stats["u_sum"] += ru
                        stats["u_min"] = ru if stats["u_min"] is None else min(stats["u_min"], ru)
                        stats["u_max"] = ru if stats["u_max"] is None else max(stats["u_max"], ru)
                    if ri is not None:
                        stats["i_sum"] += ri
                        stats["i_min"] = ri if stats["i_min"] is None else min(stats["i_min"], ri)
                        stats["i_max"] = ri if stats["i_max"] is None else max(stats["i_max"], ri)
            time.sleep(0.001)
    finally:
        if csv_f:
            csv_f.close()
    sta1 = dev.status()
    dev.stop()

    dt = stats.get("dt_window", time.time() - stats["t0"])
    pairs = stats["pairs"]
    res = {
        "mode": mode, "time_us": time_us, "clk_khz": clk_khz, "pktcnt": pktcnt,
        "adc_ct": adc_ct,
        "seconds": dt,
        "pairs": pairs,
        "drain_pairs": stats["drain_pairs"],
        "pairs_per_s": pairs / dt if dt else 0.0,
        "bytes_per_s": stats["data_bytes"] / (dt + drain_seconds) if dt else 0.0,
        "ideal_pairs_per_s": ideal_rate(time_us, mode),
        "pairs_per_block": (sorted(stats["pkt_sizes"])[0] // group) if stats["pkt_sizes"] else 0,
        "pkt_sizes": dict(sorted(stats["pkt_sizes"].items())),
        "u_min": stats["u_min"], "u_max": stats["u_max"],
        "i_min": stats["i_min"], "i_max": stats["i_max"],
        "u_mean": stats["u_sum"] / pairs if pairs else None,
        "i_mean": stats["i_sum"] / pairs if pairs else None,
        "dio_changes": stats["dio_changes"], "dio_masks": sorted(stats["dio_masks"]),
        "misaligned": stats["misaligned"],
        "sta_rd": None if not (sta0 and sta1) else sta1[0] - sta0[0],
        "sta_to": None if not (sta0 and sta1) else sta1[1] - sta0[1],
        "dupe_pairs": stats["dupe_pairs"], "dupe_total": stats["dupe_total"],
    }
    if res["sta_rd"] is not None:
        res["fw_pairs"] = res["sta_rd"] * (pktcnt // 2)
        res["fw_missing"] = res["fw_pairs"] - (pairs + res["drain_pairs"])
    return res


def fmt_masks(masks, limit=6):
    s = ",".join("0x%02X" % m for m in masks[:limit])
    return s + ("…(%d)" % len(masks) if len(masks) > limit else "")


def print_row(r, shunt_ohm=SHUNT_DEFAULT_OHM):
    if r is None:
        return
    u = "%d..%d" % (r["u_min"], r["u_max"]) if r["u_min"] is not None else "-"
    i = "%d..%d" % (r["i_min"], r["i_max"]) if r["i_min"] is not None else "-"
    print("time=%5d us clk=%4d kHz pktcnt=%2d | пар/с: %8.1f (идеал %8.1f, %.1f%%) | кБ/с: %6.1f | "
          "пар/блок: %2d | Uraw: %s | Iraw: %s | DIO: смен %d, маски %s"
          % (r["time_us"], r["clk_khz"], r["pktcnt"], r["pairs_per_s"], r["ideal_pairs_per_s"],
             100.0 * r["pairs_per_s"] / r["ideal_pairs_per_s"] if r["ideal_pairs_per_s"] else 0,
             r["bytes_per_s"] / 1000.0, r["pairs_per_block"], u, i,
             r["dio_changes"], fmt_masks(r["dio_masks"])))
    k_i = K_SHUNT_MA_PER_OHM / shunt_ohm
    if r["u_min"] is not None:
        print("    U: %.1f…%.1f мВ (размах %.1f мВ)"
              % (r["u_min"] * K_BUS_MV, r["u_max"] * K_BUS_MV,
                 (r["u_max"] - r["u_min"]) * K_BUS_MV))
    if r["i_min"] is not None:
        print("    I: %+.4f…%+.4f мА (размах %.4f мА) при шунте %g Ом; полная шкала ±%.2f мА"
              % (r["i_min"] * k_i, r["i_max"] * k_i, (r["i_max"] - r["i_min"]) * k_i,
                 shunt_ohm, VSHUNT_FSR_MV / shunt_ohm))
    extra = []
    if r["sta_rd"] is not None:
        extra.append("блоков от прибора: %d (пар по счётчику: %d, принято: %d в окне + %d в добивке, недобор %d)"
                     % (r["sta_rd"], r.get("fw_pairs", -1), r["pairs"], r["drain_pairs"],
                        r.get("fw_missing", 0)))
        extra.append("overflow-блоков: %d" % r["sta_to"])
    if r["misaligned"]:
        extra.append("!! кадров с размером не кратным %d: %d" % (GROUP_BYTES[r["mode"]], r["misaligned"]))
    if r["mode"] == MODE_DUPE:
        extra.append("дублей в паре: %d из %d" % (r["dupe_pairs"], r["dupe_total"]))
    if r["pkt_sizes"]:
        extra.append("размеры кадров: %s" % r["pkt_sizes"])
    if extra:
        print("    " + "; ".join(extra))


def main():
    ap = argparse.ArgumentParser(description="Измерение частот пар U/I (CH582F+INA228, Web Serial-протокол)")
    ap.add_argument("--list", action="store_true", help="показать COM-порты")
    ap.add_argument("--port", help="COM-порт прибора (например COM102)")
    ap.add_argument("--probe", action="store_true", help="только опрос версии/идентификаторов (без запуска измерения)")
    ap.add_argument("--seconds", type=float, default=5.0, help="длительность окна на одну настройку")
    ap.add_argument("--time", type=int, help="время преобразования, мкс (по умолчанию весь диапазон)")
    ap.add_argument("--sweep", action="store_true", help="пройти весь диапазон conversion time")
    ap.add_argument("--clk", type=int, default=1300, help="частота I2C, кГц (по умолчанию 1300 — как в pp.js)")
    ap.add_argument("--shunt-ohm", type=float, default=SHUNT_DEFAULT_OHM,
                    help="сопротивление шунта, Ом (по умолчанию %g — плата стенда; в pp.js зашито 10)"
                         % SHUNT_DEFAULT_OHM)
    ap.add_argument("--pktcnt", type=int, default=20, help="число чтений в блоке (по умолчанию 20 = 10 пар)")
    ap.add_argument("--adc-ct", type=int, choices=range(8),
                    help="индекс времени преобразования INA228 (0..7), если его надо отвязать от периода чтения")
    ap.add_argument("--mode", choices=[MODE_PAIRS, MODE_VBUS, MODE_VSHUNT, MODE_DUPE], default=MODE_PAIRS)
    ap.add_argument("--csv", help="сохранить пары в CSV (только для одиночной настройки)")
    ap.add_argument("--dupe-check", action="store_true",
                    help="диагностика: читать VBUS дважды за период (проверка темпа обновления ADC)")
    ap.add_argument("--drain", type=float, default=1.0,
                    help="сколько секунд после окна продолжать читать (сброс «в полёте»), по умолчанию 1 с")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    if args.list:
        for p in list_ports.comports():
            print("%-8s %s" % (p.device, p.description))
        return 0
    if not args.port:
        print("Укажите --port COMx (или --list)", file=sys.stderr)
        return 2

    if args.dupe_check:
        args.mode = MODE_DUPE
    mode = args.mode

    dev = Device(args.port, verbose=args.verbose)
    try:
        dev.open()
    except Exception as e:                       # noqa: BLE001
        print("Не удалось открыть %s: %s" % (args.port, e), file=sys.stderr)
        return 2

    try:
        info = dev.probe()
        if info is None:
            print("Прибор не ответил на CMD_DEV_VER — это не прошивка PowerProfiler "
                  "(или порт занят другой программой).", file=sys.stderr)
            return 3
        if info.get("error"):
            print("CMD_DEV_VER вернул флаг ошибки.", file=sys.stderr)
            return 3
        print("Прибор: DevID=0x%04X Ver=0x%04X  INA228 MID=%s DID=%s"
              % (info["dev_id"], info["ver"],
                 "0x%04X" % info["man_id"] if info["man_id"] else "-",
                 "0x%04X" % info["dev_id_ina"] if info["dev_id_ina"] else "-"))
        if args.probe:
            return 0

        times = [args.time] if args.time else (CONV_TIME_US if args.sweep else [84])
        print("Режим: %s, clk=%d kHz, pktcnt=%d, окно %.1f с на настройку\n"
              % (mode, args.clk, args.pktcnt, args.seconds))
        for t in times:
            r = measure(dev, args, mode, t, args.clk, args.pktcnt, args.seconds,
                        csv_path=args.csv if len(times) == 1 else None,
                        drain_seconds=args.drain, adc_ct=args.adc_ct)
            print_row(r, shunt_ohm=args.shunt_ohm)
        return 0
    finally:
        try:
            dev.stop()
        except Exception:                        # noqa: BLE001
            pass
        dev.close()


if __name__ == "__main__":
    sys.exit(main())
