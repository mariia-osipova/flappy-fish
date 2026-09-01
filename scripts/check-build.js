import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
async function sources(directory) {
  const result = [];
  for (const entry of await readdir(new URL(directory + '/', new URL('../', import.meta.url)), { withFileTypes: true })) {
    const filename = directory + '/' + entry.name;
    if (entry.isDirectory()) result.push(...await sources(filename));
    else if (/\.(js|mjs)$/.test(filename)) result.push(filename);
  }
  return result;
}

const files = ['server.js', ...await sources('src/server'), ...await sources('src/shared'), ...await sources('src/web'), ...await sources('scripts')];
for (const file of files) execFileSync(process.execPath, ['--check', file], { cwd: root, stdio: 'pipe' });
for (const file of await sources('src/web')) {
  const text = await readFile(new URL('../' + file, import.meta.url), 'utf8');
  if (/script\.google(?:usercontent)?\.com|docs\.google\.com\/spreadsheets|sheets\.googleapis\.com|jsonp|FLAPPY_FISH_GOOGLE/i.test(text)) {
    throw new Error(`Forbidden direct Google/JSONP integration in ${file}`);
  }
}
execFileSync(process.execPath, ['scripts/generate-collision-data.mjs', '--check'], { cwd: root, stdio: 'inherit' });
console.info(`Validated ${files.length} JavaScript modules and static security checks. No client bundling or secrets injection.`);
