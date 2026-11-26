// Checks that the version in app/package.json is the one the README and usage guide name in their download links.
// Run it before a release: node scripts/check-version.mjs
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const { version } = JSON.parse(read('app/package.json'));
const checks = [
  ['README.md', /\[Download OpenSix (\d+\.\d+\.\d+) for Windows x64\]/],
  ['docs/usage.md', /Download \[OpenSix (\d+\.\d+\.\d+)\]/],
];
let failed = false;
for (const [file, pattern] of checks) {
  const found = pattern.exec(read(file))?.[1];
  if (found !== version) {
    failed = true;
    console.error(`${file} names ${found ?? 'no version'} but app/package.json is ${version}.`);
  }
}
if (failed) process.exit(1);
console.log(`Version ${version} matches the README and usage guide.`);
