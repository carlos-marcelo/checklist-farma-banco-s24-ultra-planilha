const fs = require('fs');
const path = require('path');

const dir1 = 'c:\\Users\\marce\\OneDrive\\Documentos\\checklist-farma-banco-s24-ultra - planilha';
const dir2 = 'C:\\Users\\marce\\Documents\\checklist-farma-banco-s24-ultra-planilha-oficial';

function getAllFiles(dir, base = '') {
  let results = [];
  try {
    for (const item of fs.readdirSync(dir)) {
      if (['node_modules', '.git', 'dist', '.vite', 'scratch'].includes(item)) continue;
      const full = path.join(dir, item);
      const rel = path.join(base, item);
      if (fs.statSync(full).isDirectory()) {
        results = results.concat(getAllFiles(full, rel));
      } else {
        results.push(rel);
      }
    }
  } catch(e) {}
  return results;
}

const files1 = getAllFiles(dir1);
const diffs = [];
for (const f of files1) {
  const p1 = path.join(dir1, f);
  const p2 = path.join(dir2, f);
  if (!fs.existsSync(p2)) {
    diffs.push({ file: f, status: 'missing_in_dir2' });
  } else {
    const c1 = fs.readFileSync(p1);
    const c2 = fs.readFileSync(p2);
    if (!c1.equals(c2)) {
      diffs.push({ file: f, status: 'different_content', size1: c1.length, size2: c2.length });
    }
  }
}
console.log('Total files checked:', files1.length);
console.log('Total differences:', diffs.length);
diffs.forEach(d => console.log(d.file, d.status, d.size1 || '', d.size2 || ''));
