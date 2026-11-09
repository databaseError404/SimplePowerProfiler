#!/usr/bin/env bash
#
# Прошивка CH582F собранным baseline (Этап 1 плана PLAN.md).
#
# Требуется: подключённый программатор WCH-LinkE к отладочному интерфейсу платы
# (SDI: TIO = PB14, TCK = PB15, + 3V3 и GND) — в текущей прошивке эти пины не заняты.
#
# Использование (Git Bash):
#   bash tools/stage1/flash_baseline.sh --yes              # прошить build/stage1/.../I2C2USB.hex
#   bash tools/stage1/flash_baseline.sh --yes --file path.hex
#   bash tools/stage1/flash_baseline.sh --check            # только проверить наличие Link и образа
#
# Без флага --yes скрипт ничего не прошивает (печатает план и выходит).
#
# Переменные: MR_ROOT (каталог MounRiver Studio 2), BUILD_ROOT, OPENOCD_BIN.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MR_ROOT="${MR_ROOT:-/c/MounRiver/MounRiver_Studio2}"
OCD_DIR="${OPENOCD_BIN:-$MR_ROOT/resources/app/resources/win32/components/WCH/OpenOCD/OpenOCD/bin}"
OCD="$OCD_DIR/openocd.exe"
CFG="wch-riscv.cfg"
BUILD_ROOT="${BUILD_ROOT:-$REPO_ROOT/build/stage1}"
HEX_DEFAULT="$BUILD_ROOT/I2C2USB/obj/I2C2USB.hex"
LOG_DIR="$BUILD_ROOT"
LOG="$LOG_DIR/flash.log"

DO_IT=0
CHECK_ONLY=0
HEX="$HEX_DEFAULT"
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) DO_IT=1 ;;
    --check) CHECK_ONLY=1 ;;
    --file) shift; HEX="${1:?--file требует путь}" ;;
    *) echo "Неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
  shift
done

echo "== Прошивка baseline CH582F =="
echo "образ      : $HEX"
echo "openocd    : $OCD"
echo "конфиг     : $OCD_DIR/$CFG"
echo

[ -x "$OCD" ] || { echo "Нет OpenOCD: $OCD (проверьте MR_ROOT/OPENOCD_BIN)" >&2; exit 2; }
[ -f "$OCD_DIR/$CFG" ] || { echo "Нет конфига $CFG в $OCD_DIR" >&2; exit 2; }
[ -f "$HEX" ] || { echo "Нет образа: $HEX (сначала bash tools/stage1/build_baseline.sh)" >&2; exit 2; }

# WCH-Link определяется как USB-устройство с VID 1A86 и PID 8010/8011/8012 (Link/LinkE).
LINK_FOUND=$(powershell -NoProfile -Command \
  "(Get-CimInstance Win32_PnPEntity | Where-Object { \$_.DeviceID -match 'VID_1A86&PID_801[0-9]' } | Measure-Object).Count" \
  2>/dev/null | tr -d '\r\n ')
if [ "${LINK_FOUND:-0}" = "0" ]; then
  echo "!! WCH-Link (VID_1A86&PID_801x) не найден в системе."
  echo "   Подключите WCH-LinkE к SDI платы (TIO=PB14, TCK=PB15, 3V3, GND) и повторите."
  [ "$CHECK_ONLY" = "1" ] && exit 1
  [ "$DO_IT" = "0" ] && { echo "(план без --yes — прошивка не выполняется)"; exit 1; }
  exit 1
else
  echo "WCH-Link найден (устройств: $LINK_FOUND)"
fi

echo "hex-диапазон:"; python - "$HEX" <<'PY'
import sys
lo = hi = None
for line in open(sys.argv[1]):
    line = line.strip()
    if line.startswith(':') and line[7:9] == '00':
        n = int(line[1:3], 16); a = int(line[3:7], 16)
        lo = a if lo is None else min(lo, a)
        hi = a + n if hi is None else max(hi, a + n)
print("  0x%06X … 0x%06X (%d байт)" % (lo, hi, hi - lo))
PY

if [ "$CHECK_ONLY" = "1" ]; then
  echo "проверка пройдена (--check: прошивка не выполняется)"; exit 0
fi
if [ "$DO_IT" = "0" ]; then
  echo "Прошивка НЕ выполнена: нужен явный флаг --yes."; exit 1
fi

mkdir -p "$LOG_DIR"
echo
echo "== openocd: program / verify / reset =="
( cd "$OCD_DIR" && ./openocd.exe -f "$CFG" \
    -c "program \"$(cygpath -m "$HEX")\" verify reset exit" ) 2>&1 | tee "$LOG"

echo
echo "== после прошивки =="
sleep 2
python "$REPO_ROOT/tools/stage1/measure_pairs.py" --list 2>/dev/null | grep -i "CH9340\|CH58" || true
echo "Лог: $LOG"
echo "Дальше: python tools/stage1/measure_pairs.py --port COMx --probe"
