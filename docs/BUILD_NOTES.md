# BUILD_NOTES.md — сборка CH582F firmware `I2C2USB`: тулчейн, пути, грабли

Файл для агентов и людей, которые будут собирать прошивку в этом окружении.
Написан по фактической сессии Этапа 1 (Windows 11): проверено, что сборка воспроизводит
отслеживаемые `source/ch583/I2C2USB/obj/I2C2USB.bin` побайтово.

Связанные файлы: [PLAN.md](../PLAN.md) (этапы), [docs/stage1-baseline.md](stage1-baseline.md) (результаты
Этапа 1: размеры, хеши, измерения), [docs/IMPORT_NOTES.md](IMPORT_NOTES.md) (что и откуда импортировано).

---

## 1. Быстрый старт

```bash
# Git Bash из корня репозитория
bash tools/stage1/build_baseline.sh
# результат: build/stage1/build.log
#            build/stage1/I2C2USB/obj/I2C2USB.{elf,bin,hex,map,lst}
```

Скрипт сам находит тулчейн и make по путям из раздела 2 (переопределяются переменными `MR_ROOT`,
`GCC_FLAVOR=gcc8|gcc12|gcc15`, `BUILD_ROOT`, `NO_CLEAN=1`). Сборка идёт **out-of-tree** в `build/stage1/`
(`/build/` в `.gitignore`), исходники и отслеживаемые `obj/I2C2USB.{bin,hex}` не перезаписываются.

---

## 2. Где лежит тулчейн (в PATH его нет)

`where riscv-none-embed-gcc` и `which make` ничего не находят — MounRiver Studio 2 держит инструменты
внутри своего каталога. Проверенные пути (Windows 11, этот ПК):

| Что | Путь | Версия |
|---|---|---|
| GCC (используется проектом) | `C:\MounRiver\MounRiver_Studio2\resources\app\resources\win32\components\WCH\Toolchain\RISC-V Embedded GCC\bin\riscv-none-embed-gcc.exe` | xPack GNU RISC-V Embedded GCC **8.2.0** (objcopy 2.32) |
| GCC 12 (альтернатива) | `…\Toolchain\RISC-V Embedded GCC12\bin\riscv-wch-elf-gcc.exe` | 12.2.0 |
| GCC 15 (альтернатива) | `…\Toolchain\RISC-V Embedded GCC15\bin\riscv32-wch-elf-gcc.exe` | 15.2.0 |
| make | `C:\MounRiver\MounRiver_Studio2\resources\app\resources\win32\others\Build_Tools\Make\bin\make.exe` | GNU Make 4.2.1 |
| Архивы тулчейнов (если каталог отсутствует) | `…\components\WCH\Toolchain\*.7z` (`RISC-V Embedded GCC.7z` и др.) | — |
| Установленная IDE | `C:\MounRiver\MounRiver_Studio2\MounRiver Studio 2.exe` (`resources/app/package.json`: version `1.80.2`) | — |

Как это было найдено (повторить, если пути изменятся):

```bash
ls /c/MounRiver                       # -> MounRiver_Studio2
cmd //c "dir /b /s C:\MounRiver\MounRiver_Studio2\*gcc*.exe"     # три тулчейна
find "/c/MounRiver" -iname "make.exe" # ...\others\Build_Tools\Make\bin\make.exe
```

Полезно: `…\Toolchain\sub_manifest.json` перечисляет компоненты (`GCC8` → `./RISC-V Embedded GCC` и т.д.) —
это надёжнее, чем угадывать каталоги.

---

## 3. Что и чем собирается

Проект — Eclipse CDT managed build (`source/ch583/I2C2USB/.project`, `.cproject`):

| Параметр | Значение |
|---|---|
| Конфигурация | одна, имя `obj` |
| Префикс команд | `riscv-none-embed-` (`option.command.prefix`) |
| Компиляция | `-march=rv32imac -mabi=ilp32 -mcmodel=medany -msmall-data-limit=8 -mno-save-restore -fmax-errors=20 -Os -fmessage-length=0 -fsigned-char -ffunction-sections -fdata-sections -fno-common -g -DDEBUG=1 -std=gnu99` |
| Include | `StdPeriphDriver/inc`, `RVMSIS` |
| Линковка | `-T Ld/Link.ld -nostartfiles -Xlinker --gc-sections --specs=nano.specs --specs=nosys.specs -lISP583 -lm` + `-Xlinker --print-memory-usage` |
| Post-build | `objcopy -O ihex` → `.hex`, `objcopy -O binary` → `.bin`, `objdump` → `.lst`, `size` |
| Сборка ассемблера | `Startup/startup_CH583.S` с `-x assembler-with-cpp` |

Единицы компиляции (ровно этот список, не все файлы в каталогах):

* `src/`: `Main.c`, `app_drv_fifo.c`, `app_usb.c`, `cmd_decode.c`, `crc16.c`, `i2c_dev.c`, `i2cbus.c`, `utils.c`;
* `StdPeriphDriver/`: `CH58x_adc.c`, `CH58x_clk.c`, `CH58x_flash.c`, `CH58x_gpio.c`, `CH58x_pwr.c`,
  `CH58x_sys.c`, `CH58x_timer0.c`, `CH58x_uart0.c`, `CH58x_uart1.c`;
* `RVMSIS/core_riscv.c`, `Startup/startup_CH583.S`.

Обязательные бинарные зависимости: `StdPeriphDriver/libISP583.a` (прекомпилированная, в репозитории),
`Ld/Link.ld`.

---

## 4. Главная грабля: makefile в репозитории нет

MRS генерирует makefile-файлы **в `obj/`** (`makefile`, `objects.mk`, `sources.mk`,
`src/subdir.mk`, `StdPeriphDriver/subdir.mk`, `Startup/subdir.mk`, `RVMSIS/subdir.mk`), а `.gitignore`
проекта игнорирует `/source/ch583/I2C2USB/obj/*` (кроме отслеживаемых `I2C2USB.bin/.hex`). Поэтому после
клонирования в `obj/` лежат только `.bin/.hex`, и запускать `make` не на чем.

Что сделано вместо этого: сгенерированные MRS-файлы взяты из соседнего проекта
(`D:\2026\PowerProfiler\SimplePowerProfiler\source\ch583\I2C2USB\obj\`, заголовок «MRS Version: 2.5.0»)
и сохранены как шаблоны `tools/stage1/makefiles/*.tmpl` с подстановками:

* `@PROJ@` — путь проекта в Windows-виде с прямыми слэшами (для `-I`),
* `@PROJ_WIN@` — тот же путь с обратными слэшами (как писала MRS для `-T`/`-L`).

Альтернативы, если шаблоны устареют: открыть проект в MounRiver Studio 2 (IDE перегенерирует `obj/*.mk`),
либо собрать вручную по флагам из `.cproject` (все нужные значения там есть — см. таблицу выше).

---

## 5. Грабли, проверенные на практике

1. **Тулчейн и make не в PATH** — брать по путям из раздела 2 или через `MR_ROOT`.
2. **Пути в makefile абсолютные** — сгенерированный makefile содержит пути того каталога, где проект
   собирали. Копировать его «как есть» между каталогами нельзя: нужно подставить свой путь
   (`build_baseline.sh` делает это на каждом запуске).
3. **Windows-вид путей для `-I`/`-T`/`-L`** — использовать `d:/...` (или `d:\...`), иначе MSYS-пути
   (`/d/...`) попадут в компилятор как есть.
4. **Подстановка обратных слэшей в `sed`** — в RHS `\2` трактуется как обратная ссылка; при подстановке
   путей с `\` их надо экранировать (`build_baseline.sh`: `PROJ_WIN_BACK_SED`).
5. **Не собирать в `obj/` проекта** — там лежат отслеживаемые `I2C2USB.bin/.hex`, сборка их перезапишет
   (появится diff в git). Сборка идёт в `build/stage1/`.
6. **`.hex` пишется с CRLF, в репозитории LF** — при сверке хешей нормализовать переводы строк,
   иначе `.hex` «не совпадёт», хотя содержимое идентично (`.bin` совпадает побайтово).
7. **`-DDEBUG=1` в сборке** — включает UART1 на PA8/PA9 (`DebugInit()`), блокирующий `printf`
   в `_write()` и мигание LED на PA8. Это влияет на карту пинов (см. `docs/stage1-baseline.md`, раздел 2).
8. **GCC12/15 не проверены на этой прошивке** — скрипт умеет подменить префикс (`GCC_FLAVOR=gcc12|gcc15`),
   но результат не сверялся с `.bin` из репозитория. Для сверки использовать `gcc8`.
9. **Среда Git Bash иногда не может запустить процесс** — периодические
   `fatal error - add_item ("\??\C:\Program Files\Git", "/", ...) failed` при вызове Windows-бинарей
   (`python`, `powershell`). Помогает повторный запуск команды или обёртка `cmd //c "..."`.
10. **Кодировка вывода Python** — для русских сообщений в консоли задавать
    `PYTHONIOENCODING=utf-8` (иначе `UnicodeEncodeError`/кракозябры в cp866/cp1251).

---

## 6. Проверка результата сборки

```bash
# размеры и регионы (печатает сам линкер, есть в build/stage1/build.log)
grep -A3 "Memory region" build/stage1/build.log

# хеши и сверка с отслеживаемыми файлами (делает build_baseline.sh в конце)
sha256sum build/stage1/I2C2USB/obj/I2C2USB.{elf,bin,hex}
```

В логе нет строк вызова компилятора: в MRS-рецептах они начинаются с `@` (echo подавлен).
Если нужны точные команды — смотреть `tools/stage1/makefiles/*-subdir.mk.tmpl` или прогнать
`make -n all` в `build/stage1/I2C2USB/obj/` (dry-run).

Эталон Этапа 1 (GCC 8.2.0, конфигурация `obj`): Flash 15 368 Б (3.35 %), RAM 10 064 Б (30.71 %);
`I2C2USB.bin` = `808f11ed628c780083f1459de175eded4907280e37984ba114e3ce43cd9a728a`
(совпадает с `source/ch583/I2C2USB/obj/I2C2USB.bin`). Если хеш `.bin` отличается — сравнить флаги
и версию тулчейна, затем посмотреть `I2C2USB.map`/`I2C2USB.lst` в `build/stage1/I2C2USB/obj/`.

---

## 7. Прошивка прибора (CH582F)

```bash
bash tools/stage1/flash_baseline.sh --check   # проверить WCH-Link и диапазон образа
bash tools/stage1/flash_baseline.sh --yes     # прошить build/stage1/I2C2USB/obj/I2C2USB.hex
# без --yes скрипт ничего не прошивает; лог — build/stage1/flash.log
```

Инструменты и пути:

| Что | Путь |
|---|---|
| OpenOCD 0.11.0 | `C:\MounRiver\MounRiver_Studio2\resources\app\resources\win32\components\WCH\OpenOCD\OpenOCD\bin\openocd.exe` |
| Конфиг | тот же каталог, `wch-riscv.cfg` (`adapter driver wlinke`, `transport select sdi`, speed 6000) |
| Драйверы Link | `…\win32\others\LinkDrv\WCHLink` (+ `WCHLinkSER`, `ISP`) |
| Альтернативы | кнопка Download в MounRiver Studio 2 (GUI) или `…\Others\WCHISPTool\default\WCHISPTool_CH57x-59x.exe` (USB-ISP, требует зажать BOOT при подключении USB) |

Подключение WCH-LinkE к плате: **TIO = PB14, TCK = PB15, 3V3, GND**. В текущей прошивке PB14/PB15
не заняты (DIO — это PA4/PA5/PA10…PA15), конфликтов нет. WCH-Link виден в системе как
`VID_1A86&PID_801x` — по этому признаку скрипт проверяет наличие программатора.

Что полезно помнить:

* образ baseline занимает `0x000000…0x003C08` (15 368 Б); `.bin` = `808f11ed…` — тот же файл, что
  отслеживается в `source/ch583/I2C2USB/obj/I2C2USB.bin`;
* полное стирание чипа при прошивке может снести конфигурацию I2C, сохранённую в эмулированном EEPROM —
  это безопасно: прошивка возьмёт значения по умолчанию, а рабочую конфигурацию всё равно задаёт
  страница/скрипт при каждом подключении;
* номер COM-порта после прошивки не меняется (серийный номер CDC берётся из MAC чипа);
* аппаратная сверка хеша записанного образа не делалась (WCH-Link был не подключён при проверке).
  Если Link есть, можно сравнить: `openocd -f wch-riscv.cfg -c "dump_image read.bin 0x0 0x3C08" -c "exit"`
  и `sha256sum read.bin` (должен совпасть с `.bin` сборки);
* прошивать прибор без разрешения пользователя нельзя — фиксировать в отчёте, что именно было прошито.

---

## 8. Прочее окружение (для измерений, не для сборки)

* Python 3.13 + pyserial 3.5 доступны (`python -c "import serial"`), поэтому скрипты измерений
  (`tools/stage1/measure_pairs.py`) запускаются без установки зависимостей.
* Node.js 24 доступен (пригодится для `node --test` на Этапе 3), но модуль `serialport` не установлен.
* Прибор (CH582F+INA228) определяется как `USB-SERIAL CH9340` (`VID_1A86/PID_8040`,
  `BusReportedDeviceDesc = CH58x`); в сессии Этапа 1 — `COM102`. Номер порта может меняться.
* Прошивка прибора **не должна меняться** без разрешения пользователя: измерения Этапа 1 выполнены
  штатными командами (0x00/0x01/0x03/0x10/0x18) без перепрошивки.
