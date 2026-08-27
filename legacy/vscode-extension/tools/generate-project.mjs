/**
 * Generate a starter project outside VS Code.
 *
 *   node tools/generate-project.mjs <target-folder> [game name]
 *
 * Used to smoke-test the engine against exactly the project the extension's
 * "Create Game Project" command produces.
 */
import * as esbuild from 'esbuild';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';

const target = process.argv[2];
if (!target) {
  console.error('usage: node tools/generate-project.mjs <target-folder> [game name]');
  process.exit(1);
}
const name = process.argv[3] ?? path.basename(path.resolve(target));

const bundle = path.join(path.resolve('node_modules', '.cache'), 'benseditor-starter.mjs');
await fs.mkdir(path.dirname(bundle), { recursive: true });
await esbuild.build({
  entryPoints: ['src/project/starter.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: bundle,
  logLevel: 'warning',
});

const { PROJECT_FOLDERS, buildProjectFiles } = await import(pathToFileURL(bundle).href);

const root = path.resolve(target);
for (const folder of PROJECT_FOLDERS) {
  await fs.mkdir(path.join(root, folder), { recursive: true });
}
for (const [relative, contents] of Object.entries(buildProjectFiles(name))) {
  const file = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, 'utf8');
}

console.log(`Created "${name}" in ${root}`);
