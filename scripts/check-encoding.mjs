#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = [
  'server',
  'src',
  'server.ts',
  'README.md',
  '.env.example',
  'index.html',
  'metadata.json',
  'docker-compose.yml',
  'Dockerfile',
  'tsconfig.json',
  'vite.config.ts',
];
const SUFFIXES = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.css', '.html']);
// "NÃO" (português) usa "Ã" seguido de ASCII; mojibake usa "Ã"/"Â"/"â" seguido
// de não-ASCII, "â€" ou o caractere de substituição U+FFFD.
const MARKER = /Ã[^\x00-\x7F]|Â[^\x00-\x7F]|â[^\x00-\x7F]|\uFFFD/;

function walk(target, out) {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (SUFFIXES.has(path.extname(target))) out.push(target);
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    walk(path.join(target, entry.name), out);
  }
}

const files = [];
for (const root of ROOTS) walk(root, files);

let failures = 0;
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (MARKER.test(line)) {
      failures += 1;
      console.error(`${file}:${index + 1}: mojibake detectado`);
    }
  });
}

if (failures > 0) {
  console.error(`\n${failures} linha(s) com mojibake. Corra scripts/fix_mojibake.py.`);
  process.exit(1);
}
console.log(`[encoding] ${files.length} ficheiro(s) verificados; sem mojibake.`);
