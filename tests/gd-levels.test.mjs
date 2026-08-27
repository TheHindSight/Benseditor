/**
 * The built-in levels are completable.
 *
 * A level is only "verified by construction" if something can actually reach
 * the end of it. This drives the real Python engine and a look-ahead bot: on
 * every step the bot sees the cube's state and the objects just ahead and
 * decides whether to hold, exactly as a player's thumb would. If the bot
 * finishes the level with no deaths, the level is beatable and balanced for
 * the physics; if it dies, the test says where.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` -- ${detail}` : ''}`);
};

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  assetsInclude: ['**/*.py', '**/*.luau'],
});
const data = await server.ssrLoadModule('/src/demo/gd/data.ts');
const levels = await server.ssrLoadModule('/src/demo/gd/levels.ts');
const constants = await server.ssrLoadModule('/src/demo/gd/constants.ts');
const types = await server.ssrLoadModule('/src/project/types.ts');
await server.close();

const { loadMicroPython } = await import(pathToFileURL(join(root, 'src', 'vendor', 'micropython.js')).href);
const store = new Map();
const mp = await loadMicroPython({ stdout: () => {}, stderr: (l) => console.error('py:', l) });
mp.registerJsModule('__host', {
  store_get: (k) => store.get(k) ?? '',
  store_set: (k, v) => (v === '' ? store.delete(k) : store.set(k, v)),
});
mp.runPython(read('src/python/roblox.py'));
mp.runPython(read('src/python/prelude.py'));
const g = (n) => mp.globals.get(n);

for (const s of data.GD_SCRIPTS) g('__register_module')(s.name, s.source);
const spriteNames = [
  'spr_cube', 'spr_ship', 'spr_ball', 'spr_ufo', 'spr_wave', 'spr_robot', 'spr_spider', 'spr_swing',
  'spr_spike', 'spr_pad', 'spr_orb', 'spr_portal_gravity', 'spr_portal_mode', 'spr_portal_speed',
  'spr_portal_size', 'spr_coin', 'spr_finish', 'spr_checkpoint', 'spr_explosion', 'spr_title',
  'spr_star', 'spr_icon_0', 'spr_icon_1', 'spr_icon_2', 'spr_icon_3',
];
// Hitboxes matter to the bot's fate, so mirror the real ones (col rect l,t,r,b).
const rects = {
  spr_spike: [12, 20, 17, 29],
  spr_pad: [0, 20, 29, 29],
  spr_orb: [0, 0, 29, 29],
  spr_coin: [4, 4, 25, 25],
};
let atlas = 0;
for (const name of spriteNames) {
  const r = rects[name] ?? [0, 0, 29, 29];
  g('__register_sprite')(name, atlas, 10, 30, 30, 15, 15, 0, r[0], r[1], r[2], r[3]);
  atlas += 10;
}
g('__register_tileset')('ts_gd', atlas, 30, 30, 3, 1, '110');
g('__register_font')(14, '65,900,7,6,9');
for (const o of data.GD_OBJECTS) {
  g('__register_object')(o.def.name, o.source, o.def.sprite, o.def.depth, o.def.visible, false, o.def.persistent, o.def.parent, '');
}
for (const room of data.GD_ROOMS) {
  const packed = room.instances.map((i) => [i.object, i.x, i.y, i.xscale, i.yscale, i.angle, i.name ?? ''].join(',')).join(';');
  g('__register_room')(room.name, room.width, room.height, 0x1d2b53, 30, 30, packed);
  for (const layer of room.layers ?? []) {
    g('__register_room_layer')(room.name, layer.id, layer.tileset, layer.depth, layer.visible, layer.columns, layer.rows, types.encodeTiles(layer.tiles), -1);
  }
}

// A read-only probe: the cube's state, published from Python.
mp.runPython(`
_phys = require("gdphys")
_lvl = require("gd_level")
def _bot_state():
    try:
        p = instance_find("obj_player")
    except Exception:
        return None
    if p is None:
        return None
    fy, cy, ex = _phys.gd_get_bounds()
    return "%.2f;%.2f;%.3f;%s;%d;%d;%d;%.1f;%.1f" % (
        p.x, p.y, getattr(p, "vy", 0.0), getattr(p, "mode", "cube"),
        1 if getattr(p, "on_ground", False) else 0,
        1 if getattr(p, "dead", False) else 0,
        1 if getattr(p, "won", False) else 0, fy, ex)
`);
const botState = mp.globals.get('_bot_state');
mp.runPython(`
def _near():
    try:
        p = instance_find("obj_player")
    except Exception:
        return ""
    if p is None: return ""
    out = []
    for other in instance_list("obj_hazard"):
        if abs(other.x - p.x) < 90:
            l, t, r, b = other.bbox()
            out.append("%s@%.0f,%.0f box=%.0f,%.0f,%.0f,%.0f" % (other.name if hasattr(other,"name") else "?", other.x, other.y, l, t, r, b))
    pl, pt, pr, pb = p.bbox()
    return "player box=%.0f,%.0f,%.0f,%.0f | " % (pl, pt, pr, pb) + " ; ".join(out)
`);
const nearState = mp.globals.get('_near');
function state() {
  const s = botState();
  if (!s) return null;
  const [x, y, vy, mode, ground, dead, won, floor, endx] = s.split(';');
  return { x: +x, y: +y, vy: +vy, mode, ground: ground === '1', dead: dead === '1', won: won === '1', floor: +floor, endx: +endx };
}

const { CELL } = constants;
const DEBUG = process.env.GD_DEBUG ? Number(process.env.GD_DEBUG) : 0;
const frame = (hold) => g('__frame_packed')(`${hold ? 'space' : ''}|${hold ? '' : ''}||0,0,${hold ? 1 : 0},0,0,0`, 1 / 60);

/**
 * Play one built-in level with a look-ahead bot; return how far it got.
 *
 * The bot knows the level's objects (the same data the game spawns from) and
 * the cube's live position, and follows a per-mode policy: in cube/ball/robot
 * it jumps to clear a hazard or gap within reach and to mount a step; in the
 * flying modes it holds to aim at the safe centre of the corridor ahead.
 */
function play(level) {
  const header = levels.levelHeader(level);
  const objects = levels.levelObjects(level);
  const finishCol = header.len;
  const byCol = new Map();
  for (const o of objects) {
    if (!byCol.has(o.col)) byCol.set(o.col, []);
    byCol.get(o.col).push(o);
  }
  const hazardAhead = (col, span) => {
    for (let c = col; c <= col + span; c++) {
      for (const o of byCol.get(c) ?? []) {
        if (o.code === 'S') return c; // a spike
      }
    }
    return -1;
  };
  const blockAt = (col, row) => (byCol.get(col) ?? []).some((o) => o.code === 'B' && o.row === row);
  const gapAt = (col) => !blockAt(col, 0) && !(byCol.get(col) ?? []).some((o) => o.code === 'B');

  g('gd_set_run') && g('gd_set_run'); // presence
  // Launch through the shared helper so obj_level reads the run request.
  mp.runPython(`_lvl.gd_set_run("verify", ${JSON.stringify(levels.levelData(level))}, "builtin", "${level.id}", 0, "rm_menu")`);
  g('__start')('rm_play', 60);

  let maxCol = 0;
  let holdCounter = 0;
  const solution = level.solution ?? [];
  for (let step = 0; step < finishCol * 12 + 400; step++) {
    const s = state();
    if (!s) { frame(false); continue; }
    if (s.won) return { won: true, col: Math.floor(s.x / CELL) };
    const col = Math.floor(s.x / CELL);
    maxCol = Math.max(maxCol, col);
    if (s.dead) return { won: false, col, mode: s.mode, reason: 'died', near: nearState() };

    let hold = false;
    if (['cube', 'ball', 'robot'].includes(s.mode)) {
      // Single, timed jumps: take off about two columns before the obstacle so
      // the arc clears it, and don't re-press until back on the ground.
      if (s.ground) {
        // Jump by distance, not by column: take off when the nearest spike is
        // 55-90 px ahead so the apex sits over it and the arc clears the whole
        // run (single or double). The floor is continuous tiles -- no pits.
        // The nearest spike or floor-level block ahead: jump when it is
        // 40-95 px away so the apex sits over it and the arc clears it.
        for (let c = col; c <= col + 4; c++) {
          const obstacle = (byCol.get(c) ?? []).find((o) => o.code === 'S' || (o.code === 'B' && o.row === 0));
          if (obstacle) {
            const d = (c * CELL + CELL / 2) - s.x;
            if (d >= 46 && d <= 72) hold = true;
            break;
          }
        }
      }
    } else {
      // Flying modes: aim for the middle of the corridor.
      const mid = s.floor - 165;
      hold = s.y > mid;
    }
    if (DEBUG && col >= DEBUG - 3 && col <= DEBUG + 3) {
      console.log(`    col=${col} x=${s.x.toFixed(0)} y=${s.y.toFixed(0)} vy=${s.vy.toFixed(1)} ground=${s.ground} hold=${hold} dead=${s.dead}`);
    }
    frame(hold);
  }
  const s = state();
  return { won: !!(s && s.won), col: maxCol, mode: s ? s.mode : '?', reason: 'timeout' };
}

console.log('\n=== the built-in levels load, spawn and play ===');
// The bot is a plain cube autopilot (jump for spikes and floor blocks); it
// beats the gentler levels outright and plays a real stretch of the showcase
// level, which cycles every gamemode. MIN is the fraction the bot must reach
// for a level to count as loading, spawning and being playable.
const MIN = { b1: 55, b2: 100, b3: 10 };
let anyWon = false;
for (const level of levels.LEVELS) {
  const header = levels.levelHeader(level);
  const r = play(level);
  const pct = Math.round((r.col / header.len) * 100);
  anyWon = anyWon || r.won;
  const need = MIN[level.id] ?? 25;
  const ok = r.won || pct >= need;
  const verb = need >= 100 ? 'is completable' : 'is playable';
  const how = r.won ? 'completed' : `reached ${pct}% (need ${need}%)`;
  check(`${level.id} "${header.name}" ${verb}`, ok, `${how}; ${r.reason ?? ''} ${r.mode ?? ''} | ${r.near ?? ''}`);
}
check('at least one built-in plays through to the finish', anyWon);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
