// Bundles each *.test.ts with esbuild (so TS parameter properties etc. work), then runs them with node:test.
import { build } from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const tests = walk('src').filter((f) => f.endsWith('.test.ts'));
rmSync('.test-dist', { recursive: true, force: true });
await build({ entryPoints: tests, outdir: '.test-dist', bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' }, packages: 'external', logLevel: 'error' });
const files = [...walk('.test-dist').filter((f) => f.endsWith('.mjs')), ...walk('scripts').filter((f) => f.endsWith('.test.mjs'))];
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
