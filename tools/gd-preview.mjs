/**
 * Preview a Geometry Dash built-in level in the terminal.
 *
 *   node tools/gd-preview.mjs [levelId] [--width N]
 *
 * Prints the ASCII map with a column ruler, the per-column state strip
 * (mode / speed / gravity / size from state_at_column), the solution's hold
 * intervals, the reach numbers from the plan's addendum, and any mechanical
 * balance issues. With no id every built-in is listed. `--png` is not
 * implemented (the ASCII map is the reference view).
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function loadModule(path) {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    return await server.ssrLoadModule(path);
  } finally {
    await server.close();
  }
}

const levels = await loadModule('/src/demo/gd/levels.ts');
const constants = await loadModule('/src/demo/gd/constants.ts');

const args = process.argv.slice(2);
const widthArg = args.indexOf('--width');
const pageWidth = widthArg >= 0 ? Number(args[widthArg + 1]) : 120;
const wantId = args.find((a, i) => !a.startsWith('--') && !(widthArg >= 0 && i === widthArg + 1));

const MODE_CH = ['C', 'S', 'B', 'U', 'W', 'R', 'P', 'G'];
const SPEED_CH = ['-', '=', '+', '*', '!'];

function ruler(from, to) {
  let hundreds = '';
  let tens = '';
  let ones = '';
  for (let c = from; c < to; c++) {
    hundreds += c % 100 === 0 ? String(Math.floor(c / 100) % 10) : ' ';
    tens += c % 10 === 0 ? String(Math.floor(c / 10) % 10) : ' ';
    ones += String(c % 10);
  }
  return [hundreds, tens, ones];
}

function show(level) {
  const header = levels.levelHeader(level);
  const objects = levels.levelObjects(level);
  const len = header.len;
  const map = levels.objectsToMap(objects, len, levels.CHUNK_HEIGHT);
  const states = levels.levelStates(header, objects);
  const issues = levels.balanceIssues(header, objects);
  const data = levels.levelData(level);

  console.log(`\n=== ${level.id}  ${level.name}  difficulty ${level.difficulty}  len ${len}  objects ${objects.length}  data ${data.length} chars ===`);
  for (let from = 0; from < len; from += pageWidth) {
    const to = Math.min(len, from + pageWidth);
    console.log('');
    for (const line of ruler(from, to)) console.log(`      ${line}`);
    map.forEach((line, i) => {
      const row = levels.CHUNK_HEIGHT - 1 - i;
      console.log(`r${String(row).padStart(2)}   ${line.slice(from, to)}`);
    });
    console.log(`floor ${'='.repeat(to - from)}`);
    const modes = states.slice(from, to).map((s) => MODE_CH[s.mode]).join('');
    const speeds = states.slice(from, to).map((s) => SPEED_CH[s.speed]).join('');
    const gravity = states.slice(from, to).map((s) => (s.gravity ? 'v' : '^')).join('');
    const size = states.slice(from, to).map((s) => (s.mini ? 'm' : 'M')).join('');
    console.log(`mode  ${modes}`);
    console.log(`speed ${speeds}`);
    console.log(`grav  ${gravity}`);
    console.log(`size  ${size}`);
  }
  console.log(`\nsolution (hold [from, to] in columns): ${level.solution.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join('  ')}`);
  const summary = {};
  for (const o of objects) summary[o.code] = (summary[o.code] ?? 0) + 1;
  console.log(`objects by code: ${Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (issues.length) {
    console.log(`\nBALANCE ISSUES (${issues.length}):`);
    for (const issue of issues) console.log(`  - ${issue}`);
  } else console.log('\nbalance: no mechanical issues');
}

console.log('mode strip: C cube  S ship  B ball  U ufo  W wave  R robot  P spider  G swing');
console.log('speed strip: - 0.5x  = 1x  + 2x  * 3x  ! 4x    grav: ^ normal  v flipped    size: M normal  m mini');
console.log(`\ncells ${constants.CELL} px, rows ${constants.ROWS}, view ${constants.VIEW_W}x${constants.VIEW_H}`);
console.log('\nreach per speed (addendum): apex / flat jump length in blocks, D20 px, max spikes in a row, max pit');
for (const r of levels.reachTable()) {
  console.log(`  ${r.speed.padEnd(5)} dx ${r.dx.toFixed(3)}  apex ${r.apex.toFixed(2)}  jump ${r.jump.toFixed(2)}  D20 ${r.d20}  spikes ${r.spikes}  pit ${r.pit}`);
}

const chosen = wantId ? levels.LEVELS.filter((l) => l.id === wantId) : levels.LEVELS;
if (chosen.length === 0) {
  console.error(`no built-in level '${wantId}' (have ${levels.LEVELS.map((l) => l.id).join(', ')})`);
  process.exit(1);
}
for (const level of chosen) show(level);
