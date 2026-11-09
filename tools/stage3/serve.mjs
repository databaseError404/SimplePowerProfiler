// Мини-сервер статики для локальной проверки страниц рекордера (Этап 3).
// Нужен только для отладки: Web Serial требует https:// или localhost,
// поэтому file:// не подходит, а этот сервер отдаёт каталог по http://localhost.
//
//   node tools/stage3/serve.mjs [каталог] [порт]
//
// По умолчанию: source/ch583/WEB_USB, порт 8765.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(HERE, '..', '..', 'source', 'ch583', 'WEB_USB'));
const port = Number(process.argv[3] || 8765);
// Куда складывать отчёты браузерного harness (selftest*.htm): 4-й аргумент или <каталог>/stage3-selftest-result.txt
const RESULT_FILE = path.resolve(process.argv[4] || path.join(root, 'stage3-selftest-result.txt'));

const MIME = {
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.bin': 'application/octet-stream', '.pprec': 'application/octet-stream',
};

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/__result')) {
    // Приём отчёта от браузерного harness: результат читается из файла,
    // не полагаясь на тайминги --dump-dom и виртуальное время headless.
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
      fs.appendFileSync(RESULT_FILE, body + String.fromCharCode(10));
      res.writeHead(204).end();
    });
    return;
  }
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(root, url === '/' ? '/recorder/recorder.htm' : url);
  if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('нет файла: ' + url); return; }
    if (st.isDirectory()) file = path.join(file, 'recorder.htm');
    fs.readFile(file, (e2, data) => {
      if (e2) { res.writeHead(500).end(String(e2)); return; }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      }).end(data);
    });
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`статический сервер: http://localhost:${port}/  (каталог ${root})`);
  console.log(`отчёты harness: POST /__result → ${RESULT_FILE}`);
});
