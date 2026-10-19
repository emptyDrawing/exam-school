// docs/materials 아래의 .html 파일을 모두 찾아 docs/materials/index.json(자료 목록)을 만든다.
// - 폴더 이름 = 단원, <title> = 자료 제목 (없으면 파일 이름)
// - GitHub Actions 가 배포할 때마다 실행하므로 교사는 HTML 파일만 올리면 된다.
// 사용: node tools/build-materials.mjs [docs/materials]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(process.argv[2] || 'docs/materials');
const files = [];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.html?$/i.test(e.name)) files.push(p);
  }
}
if (fs.existsSync(root)) walk(root);

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// 마지막 커밋 시각 (git 이 없거나 커밋 전이면 파일 수정 시각)
function updatedAt(file) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], { encoding: 'utf8' }).trim();
    if (out) return out;
  } catch (e) { /* git 없음 */ }
  return fs.statSync(file).mtime.toISOString();
}

const items = files.map((file) => {
  const rel = path.relative(root, file).split(path.sep).join('/');
  const parts = rel.split('/');
  const html = fs.readFileSync(file, 'utf8');
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return {
    path: rel,
    title: (m && decode(m[1]).replace(/\s+/g, ' ').trim()) || parts.at(-1).replace(/\.html?$/i, ''),
    unit: parts.length > 1 ? parts.slice(0, -1).join(' / ') : '기타',
    size: fs.statSync(file).size,
    updated_at: updatedAt(file),
  };
});

const cmp = (a, b) => a.localeCompare(b, 'ko', { numeric: true });
items.sort((a, b) => cmp(a.unit, b.unit) || cmp(a.path, b.path));

fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ generated_at: new Date().toISOString(), items }, null, 2));
console.log(`자료 ${items.length}개 → ${path.join(root, 'index.json')}`);
