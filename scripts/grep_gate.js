const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Only scan our own editable stuff.
const SCAN_DIRS = ['src', 'public'];
const SCAN_FILES = ['README.md', 'package.json', 'tsconfig.json', 'webpack.config.js'];

function rxWord(s) {
  return new RegExp('\\b' + s + '\\b', 'i');
}
function join(parts) {
  return parts.join('');
}

// Build patterns without embedding the exact forbidden tokens as literals.
const P = {
  b: join(['bri', 'dge']),
  c: join(['clo', 'ud']),
  a: join(['api', 'Key']),
  u: join(['MEMU', '_', 'BASE', '_', 'URL']),
  m: join(['PLUGIN', '_', 'MODE']),
  h: join(['app', '.', 'memu', '.', 'so']),
};

const FORBIDDEN = [
  { re: rxWord(P.b), why: 'old mode removed' },
  { re: rxWord(P.c), why: 'old mode removed' },
  { re: new RegExp(P.a), why: 'old token removed' },
  { re: new RegExp(P.u), why: 'old setting removed' },
  { re: new RegExp(P.m), why: 'old setting removed' },
  { re: new RegExp(P.h, 'i'), why: 'old endpoint removed' },
];

function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

function scanFile(fp) {
  const rel = path.relative(ROOT, fp);
  const buf = fs.readFileSync(fp);
  const txt = buf.toString('utf8');
  const lines = txt.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const f of FORBIDDEN) {
      if (f.re.test(line)) {
        console.error(`debloat gate: ${rel}:${i + 1}: ${f.why}`);
        console.error(line.trim());
        process.exit(2);
      }
    }
  }
}

const files = [];
for (const d of SCAN_DIRS) files.push(...listFiles(path.join(ROOT, d)));
for (const f of SCAN_FILES) {
  const fp = path.join(ROOT, f);
  if (fs.existsSync(fp)) files.push(fp);
}

for (const fp of files) scanFile(fp);
console.log('debloat gate: OK');
