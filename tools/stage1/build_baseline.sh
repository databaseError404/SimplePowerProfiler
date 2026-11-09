#!/usr/bin/env bash
#
# Baseline-сборка CH582F firmware I2C2USB (Этап 1 плана PLAN.md).
#
# Собирает ТЕКУЩИЕ исходники source/ch583/I2C2USB БЕЗ функциональных изменений,
# ровно теми флагами/скриптом линкера, которые генерирует MounRiver Studio 2
# (сгенерированные MRS makefile-файлы сохранены в tools/stage1/makefiles/).
#
# Сборка идёт out-of-tree в build/stage1/ — исходники и отслеживаемые
# obj/I2C2USB.bin/.hex не перезаписываются. В конце скрипт сравнивает хеши
# свежесобранных .bin/.hex с отслеживаемыми obj/I2C2USB.{bin,hex}.
#
# Использование (Git Bash / MSYS):
#   bash tools/stage1/build_baseline.sh                 # GCC 8.2.0 (prefix riscv-none-embed-)
#   GCC_FLAVOR=gcc12 bash tools/stage1/build_baseline.sh
#   BUILD_ROOT=/d/tmp/stage1 bash tools/stage1/build_baseline.sh
#
# Переменные окружения:
#   MR_ROOT        каталог MounRiver Studio 2 (по умолчанию C:\MounRiver\MounRiver_Studio2)
#   GCC_FLAVOR     gcc8 (по умолчанию) | gcc12 | gcc15
#   BUILD_ROOT     каталог сборки (по умолчанию <repo>/build/stage1)
#   NO_CLEAN=1     не удалять BUILD_ROOT перед сборкой
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJ_SRC="$REPO_ROOT/source/ch583/I2C2USB"
BUILD_ROOT="${BUILD_ROOT:-$REPO_ROOT/build/stage1}"
MR_ROOT="${MR_ROOT:-/c/MounRiver/MounRiver_Studio2}"
GCC_FLAVOR="${GCC_FLAVOR:-gcc8}"

case "$GCC_FLAVOR" in
  gcc8)  TC_DIR="$MR_ROOT/resources/app/resources/win32/components/WCH/Toolchain/RISC-V Embedded GCC";   GCC_PREFIX=riscv-none-embed- ;;
  gcc12) TC_DIR="$MR_ROOT/resources/app/resources/win32/components/WCH/Toolchain/RISC-V Embedded GCC12"; GCC_PREFIX=riscv-wch-elf- ;;
  gcc15) TC_DIR="$MR_ROOT/resources/app/resources/win32/components/WCH/Toolchain/RISC-V Embedded GCC15"; GCC_PREFIX=riscv32-wch-elf- ;;
  *) echo "GCC_FLAVOR: неизвестное значение '$GCC_FLAVOR' (gcc8|gcc12|gcc15)" >&2; exit 2 ;;
esac
MAKE_BIN="$MR_ROOT/resources/app/resources/win32/others/Build_Tools/Make/bin"

[ -d "$PROJ_SRC" ]      || { echo "Нет каталога проекта: $PROJ_SRC" >&2; exit 2; }
[ -x "$TC_DIR/bin/${GCC_PREFIX}gcc.exe" ] || { echo "Нет тулчейна: $TC_DIR/bin/${GCC_PREFIX}gcc.exe" >&2; exit 2; }
[ -x "$MAKE_BIN/make.exe" ]               || { echo "Нет make: $MAKE_BIN/make.exe" >&2; exit 2; }

WORK="$BUILD_ROOT/I2C2USB"
LOG="$BUILD_ROOT/build.log"

echo "== Baseline build: CH582F I2C2USB =="
echo "repo        : $REPO_ROOT"
echo "project src : $PROJ_SRC"
echo "build root  : $BUILD_ROOT"
echo "toolchain   : $("$TC_DIR/bin/${GCC_PREFIX}gcc.exe" --version | head -1)"
echo "make        : $("$MAKE_BIN/make.exe" --version | head -1)"
echo

if [ "${NO_CLEAN:-0}" != "1" ]; then
  rm -rf "$BUILD_ROOT"
fi
mkdir -p "$WORK/obj/src" "$WORK/obj/StdPeriphDriver" "$WORK/obj/Startup" "$WORK/obj/RVMSIS"

# Копия исходников (только то, что участвует в сборке; obj/.mrs не копируются)
for d in src Ld RVMSIS Startup StdPeriphDriver; do
  cp -r "$PROJ_SRC/$d" "$WORK/$d"
done
echo "Скопировано в $WORK: $(find "$WORK" -type f | wc -l) файлов"
echo

# MRS-пути: -I и -T задаются в Windows-виде (d:/...), как их генерирует MRS.
PROJ_WIN="$(cygpath -m "$WORK")"          # d:/2026/... (forward slashes)
PROJ_WIN_BACK="${PROJ_WIN//\//\\}"        # d:\2026\... (backslashes, как в obj/makefile)
PROJ_WIN_BACK_SED="${PROJ_WIN_BACK//\\/\\\\}" # то же, но с экранированием для sed

MK="$SCRIPT_DIR/makefiles"
gen() { # gen <template> <destination>
  sed -e "s|@PROJ_WIN@|$PROJ_WIN_BACK_SED|g" -e "s|@PROJ@|$PROJ_WIN|g" "$1" > "$2"
}
gen "$MK/obj-makefile.tmpl"              "$WORK/obj/makefile"
gen "$MK/obj-sources.mk.tmpl"            "$WORK/obj/sources.mk"
gen "$MK/obj-objects.mk.tmpl"            "$WORK/obj/objects.mk"
gen "$MK/src-subdir.mk.tmpl"             "$WORK/obj/src/subdir.mk"
gen "$MK/StdPeriphDriver-subdir.mk.tmpl" "$WORK/obj/StdPeriphDriver/subdir.mk"
gen "$MK/Startup-subdir.mk.tmpl"         "$WORK/obj/Startup/subdir.mk"
gen "$MK/RVMSIS-subdir.mk.tmpl"          "$WORK/obj/RVMSIS/subdir.mk"

# Подмена префикса тулчейна, если выбран не gcc8 (makefile-шаблон MRS 2.5.0 — под riscv-none-embed-).
if [ "$GCC_PREFIX" != "riscv-none-embed-" ]; then
  sed -i "s|riscv-none-embed-|$GCC_PREFIX|g" "$WORK/obj/makefile" \
      "$WORK/obj/src/subdir.mk" "$WORK/obj/StdPeriphDriver/subdir.mk" \
      "$WORK/obj/Startup/subdir.mk" "$WORK/obj/RVMSIS/subdir.mk"
fi

export PATH="$TC_DIR/bin:$MAKE_BIN:$PATH"
echo "== make =="
( cd "$WORK/obj" && make --no-print-directory all ) 2>&1 | tee "$LOG"
echo

ELF="$WORK/obj/I2C2USB.elf"
[ -f "$ELF" ] || { echo "Сборка не дала ELF: $ELF" >&2; exit 1; }

echo "== size (berkeley) =="
"$TC_DIR/bin/${GCC_PREFIX}size.exe" --format=berkeley "$ELF" | tee -a "$LOG"
echo
echo "== секции (objdump -h, RAM/FLASH) =="
"$TC_DIR/bin/${GCC_PREFIX}objdump.exe" -h "$ELF" | tee -a "$LOG"
echo
echo "== sha256 артефактов сборки =="
( cd "$WORK/obj" && sha256sum I2C2USB.elf I2C2USB.bin I2C2USB.hex ) | tee -a "$LOG"
echo
echo "== сверка с отслеживаемыми obj/I2C2USB.{bin,hex} =="
for f in I2C2USB.bin I2C2USB.hex; do
  if [ -f "$PROJ_SRC/obj/$f" ]; then
    a=$(sha256sum "$WORK/obj/$f" | cut -d' ' -f1)
    b=$(sha256sum "$PROJ_SRC/obj/$f" | cut -d' ' -f1)
    # objcopy пишет .hex с CRLF, а в репозитории файл хранится с LF — сравниваем и с нормализацией
    a_lf=$(tr -d '\r' < "$WORK/obj/$f" | sha256sum | cut -d' ' -f1)
    b_lf=$(tr -d '\r' < "$PROJ_SRC/obj/$f" | sha256sum | cut -d' ' -f1)
    if [ "$a" = "$b" ]; then
      echo "  $f: СОВПАДАЕТ побайтово ($a)"
    elif [ "$a_lf" = "$b_lf" ]; then
      echo "  $f: СОВПАДАЕТ с точностью до переводов строк (sha256 LF: $a_lf; CRLF: $a)"
    else
      echo "  $f: ОТЛИЧАЕТСЯ: собранный=$a, в репозитории=$b"
    fi
  else
    echo "  $f: в репозитории нет source/ch583/I2C2USB/obj/$f"
  fi
done | tee -a "$LOG"
echo
echo "Лог: $LOG"
