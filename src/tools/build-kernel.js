'use strict';

var fs = require('fs');
var path = require('path');
var child = require('child_process');

var webRoot = path.join(__dirname, '..');
var projectRoot = path.join(webRoot, '..');
var clang = process.env.CAM_CLANG || 'D:\\Program Files (x86)\\msys64\\ucrt64\\bin\\clang.exe';
var cpp = path.join(projectRoot, 'native', 'ca_kernel.cpp');
var wasm = path.join(webRoot, 'js', 'ca_kernel.wasm');
var out = path.join(webRoot, 'js', 'kernel_wasm.js');

var args = [
  '--target=wasm32',
  '-O3',
  '-nostdlib',
  '-ffreestanding',
  '-fno-exceptions',
  '-fno-rtti',
  '-Wl,--no-entry',
  '-Wl,--export-all',
  '-Wl,--allow-undefined',
  '-Wl,--export-memory',
  '-Wl,--initial-memory=2097152',
  '-Wl,--max-memory=268435456',
  '-o', wasm,
  cpp,
];

var result = child.spawnSync(clang, args, { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);

var bytes = fs.readFileSync(wasm);
var b64 = bytes.toString('base64');
var js = [
  '// 由 src/tools/build-kernel.js 从 native/ca_kernel.cpp 生成，不要手改。',
  'var CA_KERNEL_B64 = ' + JSON.stringify(b64) + ';',
  "if (typeof module === 'object' && module.exports) module.exports = CA_KERNEL_B64;",
  '',
].join('\n');
fs.writeFileSync(out, js);
console.log('kernel wasm ' + bytes.length + ' bytes -> ' + out);
