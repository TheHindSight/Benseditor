/**
 * The fixed-step clock.
 *
 * Whatever the display's refresh rate, the game must step `fps` times a
 * second: a 120 Hz screen gets a step every other frame, a 30 Hz one two per
 * frame, and a long stall is capped rather than replayed.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` -- ${detail}` : ''}`);
};

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

const { FixedStepClock } = await loadModule('/src/engine/fixedStep.ts');
const STEP = 1 / 60;

console.log('\n=== the fixed-step clock ===');
{
  const clock = new FixedStepClock(STEP);
  check('the first tick steps at once', clock.advance(0) === 1);
  check('a 60 Hz frame is one step', clock.advance(STEP) === 1);
  const at120 = [];
  for (let i = 0; i < 8; i++) at120.push(clock.advance(STEP / 2));
  check('120 Hz alternates 0,1,0,1', at120.join('') === '01010101', at120.join(''));
  check('a 30 Hz frame is two steps', clock.advance(STEP * 2) === 2);
  check('a half-second stall is capped at three', clock.advance(0.5) === 3);
  check('and the backlog is dropped, not replayed', clock.advance(STEP) === 1);
}
{
  const clock = new FixedStepClock(STEP);
  clock.advance(0);
  let steps = 0;
  for (let i = 0; i < 600; i++) steps += clock.advance(1 / 120);
  check('600 frames at 120 Hz make exactly 300 steps (no drift)', steps === 300, String(steps));
}
{
  const clock = new FixedStepClock(STEP);
  clock.advance(0);
  let steps = 0;
  for (let i = 0; i < 144; i++) steps += clock.advance(1 / 144);
  check('one second at 144 Hz makes 60 steps', steps === 60, String(steps));
  check('negative time is ignored', clock.advance(-1) === 0);
  check('a huge delta is clamped like a backgrounded tab', clock.advance(10) === 3);
}
{
  const clock = new FixedStepClock(1 / 30, 2);
  clock.advance(0);
  check('the catch-up cap is configurable', clock.advance(1) === 2);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
