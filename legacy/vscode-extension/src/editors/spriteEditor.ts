import * as vscode from 'vscode';
import { SpriteFile } from '../project/assets';
import { htmlShell, replaceDocument } from './webviewUtil';

/**
 * Pixel art editor for `.bsprite` documents.
 *
 * The webview owns the drawing surface and posts back a complete sprite object
 * whenever a stroke, frame change or property edit is committed. Persisting via
 * the text document keeps save/dirty/undo behaviour native.
 */
export class SpriteEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'benseditor.sprite';

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): void {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    panel.webview.html = this.getHtml(panel.webview);

    // Text we most recently wrote ourselves; used to ignore the resulting
    // change event so the webview is not reset mid-edit.
    let ownWrite: string | undefined;

    const push = () => {
      if (document.getText() === ownWrite) {
        return;
      }
      let sprite: SpriteFile;
      try {
        sprite = JSON.parse(document.getText()) as SpriteFile;
      } catch {
        panel.webview.postMessage({ type: 'error', message: 'This .bsprite file is not valid JSON.' });
        return;
      }
      panel.webview.postMessage({ type: 'load', sprite });
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        push();
      }
    });

    const messageSub = panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          push();
          break;
        case 'update': {
          const text = JSON.stringify(msg.sprite, null, 2) + '\n';
          if (text === document.getText()) {
            return;
          }
          ownWrite = text;
          await replaceDocument(document, msg.sprite);
          break;
        }
        case 'undo':
          await vscode.commands.executeCommand('undo');
          break;
        case 'redo':
          await vscode.commands.executeCommand('redo');
          break;
        case 'save':
          await document.save();
          break;
      }
    });

    panel.onDidDispose(() => {
      changeSub.dispose();
      messageSub.dispose();
    });
  }

  private getHtml(webview: vscode.Webview): string {
    return htmlShell(webview, this.extensionUri, {
      title: 'Sprite Editor',
      styles: ['media/sprite/sprite.css'],
      scripts: ['media/sprite/sprite.js'],
      body: `
    <div id="app">
      <div id="toolbar">
        <div class="tool-group" id="tools"></div>
        <div class="tool-group" id="sizes"></div>
        <div class="tool-group vertical" id="colors">
          <div id="swatch-pair">
            <input type="color" id="primary" title="Primary colour (left mouse)">
            <input type="color" id="secondary" title="Secondary colour (right mouse)">
          </div>
          <button id="add-swatch" class="mini" title="Add primary colour to palette">+</button>
        </div>
        <div id="palette"></div>
      </div>

      <div id="stage">
        <div id="canvas-wrap">
          <canvas id="view"></canvas>
        </div>
        <div id="status">
          <span id="pos">0, 0</span>
          <span id="zoom-label">100%</span>
          <span class="grow"></span>
          <label><input type="checkbox" id="show-grid"> Grid</label>
          <label><input type="checkbox" id="show-onion"> Onion skin</label>
          <label><input type="checkbox" id="show-origin" checked> Origin</label>
        </div>
      </div>

      <div id="sidebar">
        <section>
          <h2>Sprite</h2>
          <div class="row"><label>Name</label><span id="sprite-name" class="value"></span></div>
          <div class="row"><label>Size</label><span id="sprite-size" class="value"></span></div>
          <button id="resize">Resize canvas…</button>
        </section>

        <section>
          <h2>Origin</h2>
          <div class="row">
            <label>X</label><input type="number" id="origin-x">
            <label>Y</label><input type="number" id="origin-y">
          </div>
          <div class="button-row">
            <button data-origin="topleft">Top left</button>
            <button data-origin="center">Centre</button>
            <button data-origin="bottom">Bottom</button>
          </div>
        </section>

        <section>
          <h2>Collision</h2>
          <div class="row">
            <label>Mode</label>
            <select id="collision-mode">
              <option value="rect">Rectangle</option>
              <option value="circle">Circle</option>
              <option value="precise">Precise</option>
            </select>
          </div>
          <div class="row">
            <label>L</label><input type="number" id="col-left">
            <label>T</label><input type="number" id="col-top">
          </div>
          <div class="row">
            <label>R</label><input type="number" id="col-right">
            <label>B</label><input type="number" id="col-bottom">
          </div>
          <button id="col-auto">Fit to pixels</button>
        </section>

        <section>
          <h2>Animation</h2>
          <div class="row"><label>FPS</label><input type="number" id="fps" min="1" max="60"></div>
          <div class="button-row">
            <button id="play">▶ Play</button>
          </div>
          <div id="preview-wrap"><canvas id="preview"></canvas></div>
        </section>
      </div>

      <div id="frames">
        <div id="frame-strip"></div>
        <div class="frame-actions">
          <button id="frame-add" title="Add empty frame">+</button>
          <button id="frame-dup" title="Duplicate current frame">⧉</button>
          <button id="frame-del" title="Delete current frame">🗑</button>
          <button id="frame-left" title="Move frame left">◀</button>
          <button id="frame-right" title="Move frame right">▶</button>
        </div>
      </div>
    </div>`,
    });
  }
}
