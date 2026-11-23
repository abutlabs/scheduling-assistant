// Inline src/*.css and src/*.js into one page: dist/index.html.
// The page is published as a claude.ai artifact, which takes a single HTML file.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'src');
const out = path.join(__dirname, '..', 'dist');
let html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
html = html.replace(/\/\*INLINE:([\w.-]+)\*\//g, (_, file) => {
  const text = fs.readFileSync(path.join(src, file), 'utf8');
  // A literal "</script" inside inlined JS would end the tag early.
  return file.endsWith('.js') ? text.replace(/<\/script/gi, '<\\/script') : text;
});
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log(`dist/index.html ${(html.length / 1024).toFixed(1)} KB`);
