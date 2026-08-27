import EMBEDDED_PLAYERS from 'virtual:player-bundle';
import { desktop } from './desktop';
import { forPlayer } from './explorer';
import { languageOf } from './languages';
import type { Project, ScriptLanguage } from './types';

/**
 * Export a project as one self-contained, playable HTML file.
 *
 * The player bundle already has its VM inlined -- the Luau one or the Python
 * one, by the project's language -- so the exported file has no dependencies
 * at all: it runs by double-clicking, from a USB stick, or dropped on any
 * static host.
 */

const PLAYER_URLS: Record<ScriptLanguage, string> = { luau: 'player.js', python: 'player.py.js' };

function escapeForScript(json: string): string {
  // `</script>` inside the data would close the tag early; U+2028/9 break the
  // parse in older engines.
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildHtml(source: Project, playerSource: string): string {
  const project = forPlayer(source);
  const title = project.config.window.title || project.config.name;
  const scale = Math.max(1, project.config.window.scale || 1);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/[<>&]/g, '')}</title>
<style>
  html, body {
    height: 100%;
    margin: 0;
    background: #0b0d12;
    display: grid;
    place-items: center;
    font-family: ui-sans-serif, system-ui, sans-serif;
    color: #dfe3ec;
    overflow: hidden;
  }
  #game {
    display: block;
    max-width: 100vw;
    max-height: 100vh;
    image-rendering: pixelated;
    background: #000;
    touch-action: none;
  }
  #game:focus { outline: none; }
  .player-error {
    max-width: 90vw;
    padding: 16px;
    background: #26141b;
    border: 1px solid #ff004d;
    border-radius: 8px;
    color: #ffc9d5;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 12px;
    white-space: pre-wrap;
  }
</style>
</head>
<body>
<script>window.__BENSEDITOR_PROJECT__ = ${escapeForScript(JSON.stringify(project))};</script>
<script type="module">${playerSource}</script>
<!-- Exported from Benseditor. Window ${project.config.window.width}x${project.config.window.height} at ${scale}x. -->
</body>
</html>
`;
}

async function loadPlayer(language: ScriptLanguage): Promise<string> {
  // The single-file build carries the players inside it, because a file://
  // page has no server to fetch from.
  const embedded = EMBEDDED_PLAYERS[language];
  if (embedded) return embedded;

  try {
    const response = await fetch(PLAYER_URLS[language]);
    if (response.ok) return response.text();
  } catch {
    // Fall through to the same message as a 404.
  }
  throw new Error(
    'The player bundle is missing. Run "npm run build:player" once, then export again.',
  );
}

/** Returns the path written to, when that is known. */
export async function exportGame(project: Project): Promise<string | undefined> {
  const html = buildHtml(project, await loadPlayer(languageOf(project.config)));
  const fileName = `${project.config.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'game'}.html`;

  if (desktop) {
    const target = await desktop.saveFileDialog({
      title: 'Export playable game',
      defaultName: fileName,
      filters: [{ name: 'Web page', extensions: ['html'] }],
    });
    if (!target) return undefined;
    await desktop.writeFile(target, html);
    return target;
  }

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
  return undefined;
}
