import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/hub', { recursive: true });
mkdirSync('dist/extension', { recursive: true });

// Hub: Node ESM, dependencies (ws) resolved from node_modules at runtime.
await build({
  entryPoints: ['src/hub/main.ts'], outfile: 'dist/hub/main.mjs', bundle: true, platform: 'node', format: 'esm',
  target: 'node22', packages: 'external', sourcemap: true,
});
cpSync('src/hub/gui', 'dist/hub/gui', { recursive: true });
cpSync('sidecar', 'dist/hub/sidecar', { recursive: true });

// Extension: browser bundles, one file per entry point.
await build({
  entryPoints: { background: 'src/extension/background.ts', 'content-chatgpt': 'src/extension/content-chatgpt.ts' },
  outdir: 'dist/extension', bundle: true, format: 'iife', target: 'chrome120', sourcemap: false,
});
cpSync('src/extension/manifest.json', 'dist/extension/manifest.json');
writeFileSync('dist/.built', new Date().toISOString()); // lets the launcher tell when a rebuild is really needed
console.log('built: dist/hub (node dist/hub/main.mjs) and dist/extension (load unpacked)');
