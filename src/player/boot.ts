import { GameRuntime } from '../engine/runtime';
import type { ScriptHostFactory } from '../engine/scriptHost';
import type { Project } from '../project/types';
import { validate } from '../project/validate';

/**
 * The standalone player, shared by both language builds.
 *
 * Built as one self-contained module and inlined into an exported HTML file,
 * so a published game is a single file that runs by double-clicking it -- no
 * server, no install, no editor. There is one build per language
 * (`player.js` for Luau, `player.py.js` for Python), each importing only its
 * own engine, so an exported game never carries the VM it does not use.
 *
 * The exported HTML defines `window.__BENSEDITOR_PROJECT__` before this runs.
 */

declare global {
  interface Window {
    __BENSEDITOR_PROJECT__?: Project;
  }
}

function fail(message: string): void {
  const box = document.createElement('pre');
  box.className = 'player-error';
  box.textContent = message;
  document.body.append(box);
}

export async function bootPlayer(hostFactory: ScriptHostFactory): Promise<void> {
  const raw = window.__BENSEDITOR_PROJECT__;
  if (!raw) {
    fail('This file is missing its game data.');
    return;
  }
  // Exports written by older editors get the same defaults the editor applies.
  let project: Project;
  try {
    project = validate(raw);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  document.title = project.config.window.title || project.config.name;

  const canvas = document.createElement('canvas');
  canvas.id = 'game';
  canvas.tabIndex = 0;
  document.body.append(canvas);

  try {
    const runtime = await GameRuntime.create(canvas, project, fail, hostFactory);
    runtime.start();
    canvas.focus();
    // Clicking anywhere gives the canvas focus back, so keys keep working.
    document.addEventListener('pointerdown', () => canvas.focus());
  } catch (error) {
    fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}
