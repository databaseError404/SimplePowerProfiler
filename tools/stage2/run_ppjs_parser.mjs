#!/usr/bin/env node
// Этап 2: прогон настоящего парсера из pp.js (его используют все три страницы INA228)
// по файлу сырого потока. Результат — текстовый файл «u i dio» по строке на пару.
//
// Использование:
//   node tools/stage2/run_ppjs_parser.mjs --in stream.bin --out samples.txt [--chunk 1] [--quiet]
//
// pp.js — браузерный файл без модулей: выполняем его в vm-контексте с заглушками DOM,
// берём класс PPdev и вызываем ровно тот CmdDecode, что вызывается в браузере.

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PP_JS = path.resolve(__dirname, '../../source/ch583/WEB_USB/pp.js');

function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const inFile = arg('in');
const outFile = arg('out');
const chunkSize = Number(arg('chunk', '0')) || 0;   // 0 = весь поток одним куском
const quiet = arg('quiet', false) === true;
if (!inFile || !outFile) {
  console.error('нужны --in и --out');
  process.exit(2);
}

const logged = [];
const ctx = {
  console: { log: (...a) => logged.push(a.join(' ')), error: (...a) => logged.push(a.join(' ')) },
  Uint8Array, TextEncoder, TextDecoder, setTimeout, clearTimeout,
  document: { getElementById: () => ({ innerHTML: '', addEventListener() {} }) },
  navigator: {},
  infoline: (s) => logged.push('info: ' + s),
  errline: (s) => logged.push('err: ' + s),
};
ctx.globalThis = ctx;
ctx.window = ctx;
vm.createContext(ctx);

const src = fs.readFileSync(PP_JS, 'utf8') +
  '\n;globalThis.PPdev = PPdev; globalThis.config_ina228 = config_ina228; globalThis.hex = hex;';
vm.runInContext(src, ctx, { filename: 'pp.js' });

const pp = vm.runInContext('new PPdev()', ctx);
pp.cfg = ctx.config_ina228;
pp.dev.open = true;
pp.blk = new Uint8Array();      // как в PPdev.Open(): до первого кадра буфер пуст, а не null
const samples = [];
pp.new_adc_cb = (u, i, dio) => samples.push([u, i, dio]);

const stream = fs.readFileSync(inFile);
const chunks = [];
if (chunkSize > 0) {
  for (let i = 0; i < stream.length; i += chunkSize) chunks.push(stream.subarray(i, i + chunkSize));
} else {
  chunks.push(stream);
}

for (const c of chunks) {
  await pp.CmdDecode(new Uint8Array(c));
}

const lines = samples.map((s) => s.map((v) => (v === undefined ? '' : v)).join(' '));
fs.writeFileSync(outFile, lines.join('\n') + (lines.length ? '\n' : ''));
if (!quiet) {
  console.log(`pp.js: пар=${samples.length}, кусков=${chunks.length}, лог-строк=${logged.length} → ${outFile}`);
}
