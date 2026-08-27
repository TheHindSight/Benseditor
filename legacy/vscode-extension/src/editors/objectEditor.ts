import * as vscode from 'vscode';
import { ObjectFile } from '../project/assets';
import { Project } from '../project/project';
import { collectResources } from './resources';
import { htmlShell, replaceDocument } from './webviewUtil';

/** Event handlers an object script may define, in GameMaker's execution order. */
export const EVENTS: { name: string; signature: string; body: string; label: string }[] = [
  { name: 'create', signature: 'self', body: 'pass', label: 'Create' },
  { name: 'destroy', signature: 'self', body: 'pass', label: 'Destroy' },
  { name: 'room_start', signature: 'self', body: 'pass', label: 'Room Start' },
  { name: 'room_end', signature: 'self', body: 'pass', label: 'Room End' },
  { name: 'alarm', signature: 'self, index', body: 'pass', label: 'Alarm' },
  { name: 'step_begin', signature: 'self', body: 'pass', label: 'Begin Step' },
  { name: 'step', signature: 'self', body: 'pass', label: 'Step' },
  { name: 'step_end', signature: 'self', body: 'pass', label: 'End Step' },
  { name: 'collision', signature: 'self, other', body: 'pass', label: 'Collision' },
  { name: 'animation_end', signature: 'self', body: 'pass', label: 'Animation End' },
  { name: 'draw', signature: 'self', body: 'self.draw_self()', label: 'Draw' },
  { name: 'draw_gui', signature: 'self', body: 'pass', label: 'Draw GUI' },
];

/** Property sheet for `.bobject` documents, plus a live view of its script. */
export class ObjectEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'benseditor.object';

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

    const objectName = () => {
      try {
        return (JSON.parse(document.getText()) as ObjectFile).name;
      } catch {
        return undefined;
      }
    };

    const push = async () => {
      if (document.getText() === ownWrite) {
        return;
      }
      let object: ObjectFile;
      try {
        object = JSON.parse(document.getText()) as ObjectFile;
      } catch {
        panel.webview.postMessage({
          type: 'error',
          message: 'This .bobject file is not valid JSON.',
        });
        return;
      }
      panel.webview.postMessage({
        type: 'load',
        object,
        events: EVENTS,
        defined: await this.definedEvents(object.name),
      });
    };

    const pushResources = async () => {
      const project = this.getProject();
      if (project) {
        panel.webview.postMessage({ type: 'resources', ...(await collectResources(project)) });
      }
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument(async (e) => {
      const uri = e.document.uri.toString();
      if (uri === document.uri.toString()) {
        await push();
      } else if (e.document.uri.path.endsWith('.bsprite')) {
        await pushResources();
      } else if (e.document.uri.path.endsWith(`${objectName()}.py`)) {
        await push();
      }
    });

    const messageSub = panel.webview.onDidReceiveMessage(async (msg) => {
      const project = this.getProject();
      switch (msg.type) {
        case 'ready':
          await pushResources();
          await push();
          break;
        case 'update': {
          const text = JSON.stringify(msg.object, null, 2) + '\n';
          if (text === document.getText()) {
            return;
          }
          ownWrite = text;
          await replaceDocument(document, msg.object);
          break;
        }
        case 'openScript': {
          const name = objectName();
          if (project && name) {
            await vscode.window.showTextDocument(project.objectScriptUri(name), {
              viewColumn: vscode.ViewColumn.Beside,
            });
          }
          break;
        }
        case 'addEvent': {
          const name = objectName();
          if (project && name) {
            await this.addEvent(project, name, msg.event);
            await push();
          }
          break;
        }
        case 'openSprite': {
          if (project && msg.name) {
            await vscode.commands.executeCommand(
              'vscode.open',
              project.assetUri('sprite', msg.name),
            );
          }
          break;
        }
        case 'undo':
          await vscode.commands.executeCommand('undo');
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

  /** Which event methods the object's script currently defines. */
  private async definedEvents(objectName: string): Promise<string[]> {
    const project = this.getProject();
    if (!project) {
      return [];
    }
    try {
      const raw = await vscode.workspace.fs.readFile(project.objectScriptUri(objectName));
      const source = Buffer.from(raw).toString('utf8');
      return EVENTS.filter((event) =>
        new RegExp(`^\\s+def\\s+${event.name}\\s*\\(`, 'm').test(source),
      ).map((event) => event.name);
    } catch {
      return [];
    }
  }

  /** Append a stub for `eventName` to the object's script and reveal it. */
  private async addEvent(project: Project, objectName: string, eventName: string): Promise<void> {
    const event = EVENTS.find((e) => e.name === eventName);
    if (!event) {
      return;
    }

    const uri = project.objectScriptUri(objectName);
    const document = await vscode.workspace.openTextDocument(uri);
    if (new RegExp(`^\\s+def\\s+${event.name}\\s*\\(`, 'm').test(document.getText())) {
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });
      return;
    }

    const stub = `\n    def ${event.name}(${event.signature}):\n        ${event.body}\n`;
    const end = document.lineAt(document.lineCount - 1).range.end;
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, end, document.getText().endsWith('\n') ? stub.slice(1) : stub);
    await vscode.workspace.applyEdit(edit);
    await document.save();

    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
    });
    const line = document.lineCount - 2;
    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
  }

  private getHtml(webview: vscode.Webview): string {
    return htmlShell(webview, this.extensionUri, {
      title: 'Object Editor',
      styles: ['media/object/object.css'],
      scripts: ['media/object/object.js'],
      body: `
    <div id="app">
      <div id="left">
        <section>
          <h2>Object</h2>
          <div class="row"><label>Name</label><span id="obj-name" class="value"></span></div>
          <div class="row"><label>Sprite</label><select id="obj-sprite"></select></div>
          <div class="row"><label>Parent</label><select id="obj-parent"></select></div>
          <div class="row"><label>Depth</label><input type="number" id="obj-depth"></div>
          <div class="checks">
            <label><input type="checkbox" id="obj-visible"> Visible</label>
            <label><input type="checkbox" id="obj-solid"> Solid</label>
            <label><input type="checkbox" id="obj-persistent"> Persistent</label>
          </div>
        </section>

        <section>
          <h2>Preview</h2>
          <div id="preview-wrap"><canvas id="preview" width="96" height="96"></canvas></div>
          <button id="edit-sprite">Edit sprite</button>
        </section>
      </div>

      <div id="right">
        <section>
          <h2>Events</h2>
          <p class="hint">Click an event to jump to it, or add it to the script.</p>
          <div id="event-list"></div>
          <button id="open-script">Open script</button>
        </section>
      </div>
    </div>`,
    });
  }
}
