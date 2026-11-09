# SimplePowerProfiler
Simple PowerProfiler on INA219, INA226, INA228, INA229, INA231, INA3221

## Доработки CH582F + INA228

- [Поэтапный план: 8 DIO, UART RX и чистый веб-интерфейс](PLAN.md).
- [Что собрано из соседней папки и какие варианты сохранены](docs/IMPORT_NOTES.md).
- [Сборка прошивки CH582F: где лежит тулчейн и make, как собирать и прошивать, грабли](docs/BUILD_NOTES.md).
- [Этап 1: сборка, карта пинов, реальные частоты пар U/I](docs/stage1-baseline.md).
- [Этап 2: DIO, совместимость протокола, потери, USB robustness](docs/stage2-report.md).
- [Этап 3: рекордер — захват, хранение, формат записи](docs/stage3-report.md).
- [Этап 4: просмотр — LOD, метрики, графики, DIO](docs/stage4-report.md).
- **Рекордер и просмотр:** [`source/ch583/WEB_USB/recorder/recorder.htm`](source/ch583/WEB_USB/recorder/recorder.htm) — статическая страница (Web Serial, Worker, OffscreenCanvas, файл `.pprec`); локальный запуск: `node tools/stage3/serve.mjs`.

Текущее состояние — checkpoint старых наработок, не проверенный новый релиз.
Этапы 1–4 плана выполнены почти полностью: сборка воспроизводима, baseline прошит, карта пинов и частоты
пар измерены (DIO проверены стендом бегущего бита), протокол и потери исследованы, готовы рекордер с форматом
записи и просмотр с LOD-пирамидой и метриками. Открыто: прогон рекордера с прибором в браузере, известная
нагрузка, UART RX (Этап 5), правки прошивки по Этапу 2.
Следующие доработки выполняются по одному этапу плана; Python viewer сохранён только как историческая наработка.

## For INA226, INA231, INA3221

![SCH](https://raw.githubusercontent.com/pvvx/SimplePowerProfiler/main/docs/SPP-INA3221.png)

![SCH](https://raw.githubusercontent.com/pvvx/SimplePowerProfiler/main/docs/STM32INA219.gif)

![SCH](https://raw.githubusercontent.com/pvvx/SimplePowerProfiler/main/docs/STM32INA226.gif)

![SCH](https://raw.githubusercontent.com/pvvx/SimplePowerProfiler/main/docs/JDY-10-INA219.gif)

![SCH](https://raw.githubusercontent.com/pvvx/SimplePowerProfiler/main/docs/JDY-10-INA226.gif)

![SCH](https://raw.githubusercontent.com/pvvx/SimplePowerProfiler/main/docs/PowerProfiler.gif)

---

## BL702 supports INA228/INA229 (20 bits) up to 20 ksps ((This is the maximum for INA228).

![SCH](https://raw.githubusercontent.com/pvvx/SimplePowerProfiler/main/docs/xt_zb1_devkit.jpg)

---

## CH582F/CH592F supports INA226, INA231, INA3221 and INA228 (20 bits) up to 20 ksps (This is the maximum for INA228).

![SCH](https://raw.githubusercontent.com/pvvx/SimplePowerProfiler/main/docs/CH582.gif) ![SCH](https://raw.githubusercontent.com/pvvx/SimplePowerProfiler/main/docs/CH592.gif)

* CH582F/CH592F WEB-USB:

![SCH](https://raw.githubusercontent.com/pvvx/SimplePowerProfiler/main/docs/ch582F_ina228_web_usb.jpg)

1206 10uF 35V X7R Capacitor Leakage Test at 4V:

<img width="722" height="1186" alt="image" src="https://github.com/user-attachments/assets/b0a59365-5575-4679-8c35-78cedd5e0164" />

### USB (CH5x2F)

[wso_ina226.htm](https://pvvx.github.io/SPP/usb_web/wso_ina226.htm)

[wso_ina228.htm](https://pvvx.github.io/SPP/usb_web/wso_ina228.htm)

[wso_ina3221.htm](https://pvvx.github.io/SPP/usb_web/wso_ina3221.htm)

### BLE (CH582F)

[test_pp228.html](https://pvvx.github.io/SPP/ble_web/test_pp228.html)

---

## ...

[Source code](https://github.com/pvvx/SimplePowerProfiler/tree/main/source)

[Source code for TLSR8266](https://github.com/pvvx/UBIA)

[Готовые прошивки и программа](https://github.com/pvvx/SimplePowerProfiler/tree/main/bin)

[Форум](https://esp8266.ru/forum/threads/power-profiler.4643)

[Telegram: New devices & develops](https://t.me/pvvx_new_ble_zigbee_devices)
