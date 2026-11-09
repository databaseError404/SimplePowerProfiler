#!/usr/bin/env bash
#
# Браузерный harness рекордера (Этап 3): прогон selftest-страниц в headless Chrome
# и сбор отчёта через POST /__result статического сервера.
#
# Зачем так: headless-режим с --virtual-time-budget «перематывает» таймеры и не даёт
# дождаться асинхронных ответов Worker/fetch, а --dump-dom снимает DOM слишком рано.
# Поэтому страницы сами отправляют результаты на сервер, а скрипт их читает.
#
# Использование (Git Bash):
#   bash tools/stage3/browser_selftest.sh            # обе страницы
#   bash tools/stage3/browser_selftest.sh selftest.htm
#
# Переменные: PORT (по умолчанию 8766), CHROME (путь к chrome.exe), WAIT (секунд на страницу).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PORT="${PORT:-8766}"
WAIT="${WAIT:-18}"
CHROME="${CHROME:-/c/Program Files/Google/Chrome/Application/chrome.exe}"
RESULT="$REPO_ROOT/build/stage3-selftest-result.txt"
# Сервер отдаёт корень репозитория (нужно и для фикстуры /docs/stage2/...), поэтому путь к страницам — полный.
PAGE_PREFIX="/source/ch583/WEB_USB/recorder"
PAGES=("$@")
if [ ${#PAGES[@]} -eq 0 ]; then PAGES=(selftest.htm selftest-worker.htm selftest-view.htm); fi

[ -x "$CHROME" ] || { echo "нет Chrome: $CHROME" >&2; exit 2; }

mkdir -p "$REPO_ROOT/build"
rm -f "$RESULT"

echo "== сервер =="
node "$SCRIPT_DIR/serve.mjs" "$REPO_ROOT" "$PORT" "$RESULT" > "$REPO_ROOT/build/stage3-serve.log" 2>&1 &
SERVER_PID=$!
sleep 2
if ! curl -s -o /dev/null "http://localhost:$PORT$PAGE_PREFIX/recorder.htm"; then
  echo "сервер не поднялся (см. build/stage3-serve.log)" >&2; kill $SERVER_PID 2>/dev/null; exit 1
fi
echo "сервер: http://localhost:$PORT/ (pid $SERVER_PID)"

for page in "${PAGES[@]}"; do
  PROFILE="$REPO_ROOT/build/chrome-prof-$page"
  rm -rf "$PROFILE"; mkdir -p "$PROFILE"
  echo "== $page =="
  timeout -s KILL "$WAIT" "$CHROME" --headless=new --disable-gpu --no-first-run \
      --no-default-browser-check --user-data-dir="$(cygpath -m "$PROFILE")" \
      "http://localhost:$PORT$PAGE_PREFIX/$page" > /dev/null 2>&1
  rm -rf "$PROFILE" 2>/dev/null
  sleep 1
done

kill $SERVER_PID 2>/dev/null
sleep 1

echo
if [ -f "$RESULT" ]; then
  echo "== отчёт браузерного harness =="
  cat "$RESULT"
  if grep -q "^FAIL" "$RESULT"; then
    echo "ИТОГ: есть провалы"; exit 1
  fi
  echo "ИТОГ: провалов нет"
else
  echo "отчёт не получен (страницы не отправили результаты)"; exit 1
fi
