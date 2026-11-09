# Рекордер и просмотр (Этап 3–4) — отдельная утилита

Это **новая утилита отображения/записи**, лежит отдельной папкой и не изменяет legacy-страницы
рядом (`wso_ina228.htm`, `wso_ina228+DIO.htm`, `wso_ina228_basic_legacy.htm`, `pp.js`, `serial.js`).
Legacy-варианты сохранены как контрольные и работают как раньше.

## Состав

| Файл | Назначение |
|---|---|
| `recorder.htm` | страница: подключение (Web Serial), запись, просмотр, метрики, сохранение/открытие `.pprec` |
| `demo-view.htm` | просмотр синтетической записи без прибора (проверка вида графиков) |
| `app.js` | интерфейс, команды протокола, ввод (zoom/pan/курсор), вывод кадров из воркера |
| `worker.js` | парсер, хранилище, LOD, метрики и отрисовка (OffscreenCanvas) в отдельном потоке |
| `parser.js` | инкрементальный разбор `[size][cmd]`, кадры `0x3A` (U24/I24/DIO), `STA`, `PVER` |
| `store.js` | `PairStore` (8 Б/пара, чанки по 65 536 пар), `LossTracker` (счётчики потерь) |
| `lod.js` | LOD-пирамида: min/max + средние + активность DIO; `buildColumns` для отрисовки |
| `metrics.js` | точные метрики окна (границы — по сырым парам) и всей записи |
| `viewport.js` | окно просмотра, zoom/pan/fit, `follow latest` |
| `render.js` | отрисовка: точки отсчётов + линия среднего, размах, дорожки DIO, обзор, оси |
| `recordfile.js` | формат `.pprec` (заголовок с cfg/калибровкой/счётчиками + чанки), чтение/запись |
| `test/` | тесты `node --test` (53 шт.) |
| `selftest*.htm` | браузерный harness (26 проверок) |

## Запуск

```bash
node tools/stage3/serve.mjs          # http://localhost:8765/recorder/recorder.htm
bash tools/stage3/browser_selftest.sh   # прогон harness в headless Chrome
cd source/ch583/WEB_USB/recorder && node --test test/*.test.js
```

Подробности, замеры и ограничения: `docs/stage3-report.md`, `docs/stage4-report.md`.
