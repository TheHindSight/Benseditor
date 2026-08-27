import * as vscode from 'vscode';
import { RoomFile } from '../project/assets';
import { Project } from '../project/project';
import { collectResources } from './resources';
import { htmlShell, replaceDocument } from './webviewUtil';

/** Visual room layout editor for `.broom` documents. */
export class RoomEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'benseditor.room';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getProject: () => Project | undefined,
  ) {}

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

    let ownWrite: string | undefined;

    const push = () => {
      if (document.getText() === ownWrite) {
        return;
      }
      try {
        panel.webview.postMessage({ type: 'load', room: JSON.parse(document.getText()) as RoomFile });
      } catch {
        panel.webview.postMessage({ type: 'error', message: 'This .broom file is not valid JSON.' });
      }
    };

    const pushResources = async () => {
      const project = this.getProject();
      if (project) {
        panel.webview.postMessage({ type: 'resources', ...(await collectResources(project)) });
      }
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        push();
      } else if (/\.(bobject|bsprite)$/.test(e.document.uri.path)) {
        void pushResources();
      }
    });

    // Assets created or deleted outside an open editor.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{bobject,bsprite}');
    watcher.onDidCreate(() => void pushResources());
    watcher.onDidDelete(() => void pushResources());

    const messageSub = panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          await pushResources();
          push();
          break;
        case 'update': {
          const text = JSON.stringify(msg.room, null, 2) + '\n';
          if (text === document.getText()) {
            return;
          }
          ownWrite = text;
          await replaceDocument(document, msg.room);
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
        case 'openObject': {
          const project = this.getProject();
          if (project) {
            await vscode.commands.executeCommand(
              'vscode.open',
              project.assetUri('object', msg.name),
            );
          }
          break;
        }
      }
    });

    panel.onDidDispose(() => {
      changeSub.dispose();
      messageSub.dispose();
      watcher.dispose();
    });
  }

  private getHtml(webview: vscode.Webview): string {
    return htmlShell(webview, this.extensionUri, {
      title: 'Room Editor',
      styles: ['media/room/room.css'],
      scripts: ['media/room/room.js'],
      body: `
    <div id="app">
      <div id="objects">
        <h2>Objects</h2>
        <div id="object-list"></div>
      </div>

      <div id="stage">
        <div id="canvas-wrap"><canvas id="view"></canvas></div>
        <div id="status">
          <span id="pos">0, 0</span>
          <span id="zoom-label">100%</span>
          <span class="grow"></span>
          <label><input type="checkbox" id="snap" checked> Snap to grid</label>
          <label><input type="checkbox" id="show-grid" checked> Grid</label>
          <span id="hint">Click to place · drag to move · right-click to delete</span>
        </div>
      </div>

      <div id="sidebar">
        <section>
          <h2>Room</h2>
          <div class="row"><label>Name</label><span id="room-name" class="value"></span></div>
          <div class="row"><label>W</label><input type="number" id="room-w"><label>H</label><input type="number" id="room-h"></div>
          <div class="row"><label>Grid</label><input type="number" id="grid-w"><label>×</label><input type="number" id="grid-h"></div>
          <div class="row"><label>BG</label><input type="color" id="room-bg" style="height:22px"></div>
        </section>

        <section id="instance-panel" hidden>
          <h2>Instance</h2>
          <div class="row"><label>Object</label><span id="inst-object" class="value"></span></div>
          <div class="row"><label>X</label><input type="number" id="inst-x"><label>Y</label><input type="number" id="inst-y"></div>
          <div class="row"><label>Scale</label><input type="number" id="inst-xs" step="0.1"><label>×</label><input type="number" id="inst-ys" step="0.1"></div>
          <div class="row"><label>Angle</label><input type="number" id="inst-angle"></div>
          <div class="button-row">
            <button id="inst-delete">Delete</button>
            <button id="inst-edit">Edit object</button>
          </div>
        </section>

        <section>
          <h2>Instances</h2>
          <div id="instance-count" class="value">0 placed</div>
          <button id="clear-room">Remove all</button>
        </section>
      </div>
    </div>`,
    });
  }
}
