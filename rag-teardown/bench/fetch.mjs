// Clone braylo-si-rag at the pinned commit into vendor/ (gitignored) so the benchmark is reproducible.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
export const REPO = 'https://github.com/braylo777/braylo-si-rag';
export const COMMIT = 'a1403da627a494d5b91ee839cb80cb582c89c38e';
export const DIR = new URL('../../vendor/braylo-si-rag/', import.meta.url).pathname;
if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (!existsSync(DIR)) execFileSync('git', ['clone', '-q', REPO, DIR], { stdio: 'inherit' });
  execFileSync('git', ['-C', DIR, 'checkout', '-q', COMMIT], { stdio: 'inherit' });
  console.log(`braylo-si-rag @ ${execFileSync('git', ['-C', DIR, 'rev-parse', 'HEAD']).toString().trim()}`);
}
