// Pack the Recruitee desktop extension: dist/recruitee.mcpb (a zip Claude installs with a double-click).
// src/recruitee.js is shared with the page, so it is copied into the bundle here.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const ext = path.join(root, 'extension', 'recruitee');
fs.copyFileSync(path.join(root, 'src', 'recruitee.js'), path.join(ext, 'server', 'recruitee.js'));
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'recruitee.mcpb');
fs.rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', out, 'manifest.json', 'server'], { cwd: ext });
console.log(`dist/recruitee.mcpb ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
