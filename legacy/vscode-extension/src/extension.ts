import * as path from 'path';
import * as vscode from 'vscode';
import { ObjectEditorProvider } from './editors/objectEditor';
import { RoomEditorProvider } from './editors/roomEditor';
import { SpriteEditorProvider } from './editors/spriteEditor';
import {
  ObjectFile,
  RoomFile,
  SpriteFile,
  newObjectFile,
  newObjectScript,
  newRoomFile,
  newScriptFile,
  newSpriteFile,
  validateAssetName,
} from './project/assets';
import { AssetTreeProvider, TreeNode } from './project/assetTree';
import { AssetKind, PROJECT_FILE, Project } from './project/project';
import { GameRunner } from './run/runner';
import { scaffoldProject } from './scaffold';

let project: Project | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const runner = new GameRunner(context.extensionUri);
  context.subscriptions.push(runner);

  const tree = new AssetTreeProvider(() => project);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('benseditor.assets', tree),
  );

  const refresh = async () => {
    project = await Project.find();
    await vscode.commands.executeCommand('setContext', 'benseditor.projectOpen', !!project);
    runner.showStatus(!!project);
    tree.refresh();
  };
  await refresh();

  // Keep the tree and project config in sync with the filesystem.
  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/*.{bsprite,bobject,broom,py,json}',
  );
  const onFileEvent = async (uri: vscode.Uri) => {
    if (uri.path.endsWith(PROJECT_FILE)) {
      await refresh();
    } else {
      tree.refresh();
    }
  };
  watcher.onDidCreate(onFileEvent);
  watcher.onDidDelete(onFileEvent);
  watcher.onDidChange(onFileEvent);
  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refresh()),
  );

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      SpriteEditorProvider.viewType,
      new SpriteEditorProvider(context.extensionUri),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
    ),
    vscode.window.registerCustomEditorProvider(
      RoomEditorProvider.viewType,
      new RoomEditorProvider(context.extensionUri, () => project),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
    ),
    vscode.window.registerCustomEditorProvider(
      ObjectEditorProvider.viewType,
      new ObjectEditorProvider(context.extensionUri, () => project),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
    ),
  );

  const requireProject = async (): Promise<Project | undefined> => {
    if (!project) {
      const choice = await vscode.window.showErrorMessage(
        'No Benseditor project is open in this folder.',
        'Create Game Project',
      );
      if (choice === 'Create Game Project') {
        await vscode.commands.executeCommand('benseditor.newProject');
      }
      return undefined;
    }
    return project;
  };

  const register = (command: string, handler: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));

  register('benseditor.refreshAssets', () => refresh());

  register('benseditor.run', async () => {
    const current = await requireProject();
    if (current) {
      await runner.run(current);
    }
  });

  register('benseditor.stop', () => runner.stop());

  register('benseditor.installEngine', () => runner.installDependencies(project));

  register('benseditor.newProject', () => createProject(refresh));

  register('benseditor.newSprite', () => createAsset('sprite', refresh));
  register('benseditor.newObject', () => createAsset('object', refresh));
  register('benseditor.newRoom', () => createAsset('room', refresh));
  register('benseditor.newScript', () => createAsset('script', refresh));

  register('benseditor.openScript', async (node?: TreeNode) => {
    const current = await requireProject();
    if (!current || !node || node.type !== 'asset' || node.asset.kind !== 'object') {
      return;
    }
    await vscode.window.showTextDocument(current.objectScriptUri(node.asset.name));
  });

  register('benseditor.deleteAsset', (node?: TreeNode) => deleteAsset(node, refresh));
  register('benseditor.renameAsset', (node?: TreeNode) => renameAsset(node, refresh));
}

export function deactivate(): void {
  // GameRunner disposal stops any running game.
}

// ---- project creation ---------------------------------------------------

async function createProject(refresh: () => Promise<void>): Promise<void> {
  let root: vscode.Uri | undefined;

  const folders = vscode.workspace.workspaceFolders ?? [];
  const candidate = folders[0];
  if (candidate && !(await Project.open(candidate.uri))) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: `Use this folder`, description: candidate.uri.fsPath, pick: 'here' },
        { label: 'Choose another folder…', pick: 'other' },
      ],
      { title: 'Where should the game project be created?' },
    );
    if (!choice) {
      return;
    }
    root = choice.pick === 'here' ? candidate.uri : undefined;
  }

  if (!root) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Create Game Project Here',
    });
    if (!picked?.length) {
      return;
    }
    root = picked[0];
  }

  if (await Project.open(root)) {
    void vscode.window.showErrorMessage('That folder already contains a Benseditor project.');
    return;
  }

  const name = await vscode.window.showInputBox({
    title: 'Game name',
    value: path.basename(root.fsPath),
    validateInput: (value) => (value.trim() ? undefined : 'Name cannot be empty.'),
  });
  if (!name) {
    return;
  }

  await scaffoldProject(root, name.trim());

  const alreadyOpen = (vscode.workspace.workspaceFolders ?? []).some(
    (folder) => folder.uri.toString() === root!.toString(),
  );
  if (!alreadyOpen) {
    await vscode.commands.executeCommand('vscode.openFolder', root, { forceNewWindow: false });
    return;
  }

  await refresh();
  await vscode.commands.executeCommand(
    'vscode.open',
    vscode.Uri.joinPath(root, 'rooms', 'rm_main.broom'),
  );
  void vscode.window.showInformationMessage(
    `Created ${name.trim()}. Press F5 to play it.`,
  );
}

// ---- asset creation -----------------------------------------------------

const KIND_LABELS: Record<AssetKind, string> = {
  sprite: 'sprite',
  object: 'object',
  room: 'room',
  script: 'script',
};

const KIND_PREFIX: Record<AssetKind, string> = {
  sprite: 'spr_',
  object: 'obj_',
  room: 'rm_',
  script: '',
};

async function createAsset(kind: AssetKind, refresh: () => Promise<void>): Promise<void> {
  if (!project) {
    void vscode.window.showErrorMessage('No Benseditor project is open in this folder.');
    return;
  }
  const current = project;

  const name = await vscode.window.showInputBox({
    title: `New ${KIND_LABELS[kind]}`,
    value: KIND_PREFIX[kind],
    valueSelection: [KIND_PREFIX[kind].length, KIND_PREFIX[kind].length],
    validateInput: async (value) => {
      const invalid = validateAssetName(value.trim());
      if (invalid) {
        return invalid;
      }
      return (await current.exists(kind, value.trim()))
        ? `A ${KIND_LABELS[kind]} called ${value.trim()} already exists.`
        : undefined;
    },
  });
  if (!name) {
    return;
  }

  const trimmed = name.trim();
  await vscode.workspace.fs.createDirectory(current.folder(kind));
  const uri = current.assetUri(kind, trimmed);

  switch (kind) {
    case 'sprite':
      await current.writeJson(uri, newSpriteFile(trimmed));
      break;
    case 'object':
      await current.writeJson(uri, newObjectFile(trimmed));
      await vscode.workspace.fs.writeFile(
        current.objectScriptUri(trimmed),
        Buffer.from(newObjectScript(trimmed), 'utf8'),
      );
      break;
    case 'room':
      await current.writeJson(uri, newRoomFile(trimmed));
      break;
    case 'script':
      await vscode.workspace.fs.writeFile(uri, Buffer.from(newScriptFile(trimmed), 'utf8'));
      break;
  }

  await refresh();
  await vscode.commands.executeCommand('vscode.open', uri);
}

// ---- delete / rename ----------------------------------------------------

async function deleteAsset(node: TreeNode | undefined, refresh: () => Promise<void>): Promise<void> {
  if (!project || !node || node.type !== 'asset') {
    return;
  }
  const { kind, name, uri } = node.asset;

  const confirm = await vscode.window.showWarningMessage(
    `Delete ${KIND_LABELS[kind]} ${name}?`,
    { modal: true, detail: 'This moves the file(s) to the trash.' },
    'Delete',
  );
  if (confirm !== 'Delete') {
    return;
  }

  await vscode.workspace.fs.delete(uri, { useTrash: true });
  if (kind === 'object') {
    try {
      await vscode.workspace.fs.delete(project.objectScriptUri(name), { useTrash: true });
    } catch {
      // The script may not exist; deleting the definition is enough.
    }
  }
  await refresh();
}

async function renameAsset(node: TreeNode | undefined, refresh: () => Promise<void>): Promise<void> {
  if (!project || !node || node.type !== 'asset') {
    return;
  }
  const current = project;
  const { kind, name, uri } = node.asset;

  const next = await vscode.window.showInputBox({
    title: `Rename ${KIND_LABELS[kind]}`,
    value: name,
    validateInput: async (value) => {
      const trimmed = value.trim();
      if (trimmed === name) {
        return undefined;
      }
      const invalid = validateAssetName(trimmed);
      if (invalid) {
        return invalid;
      }
      return (await current.exists(kind, trimmed))
        ? `A ${KIND_LABELS[kind]} called ${trimmed} already exists.`
        : undefined;
    },
  });
  if (!next || next.trim() === name) {
    return;
  }
  const renamed = next.trim();

  await vscode.workspace.fs.rename(uri, current.assetUri(kind, renamed));

  if (kind !== 'script') {
    // Keep the `name` field in step with the filename.
    const target = current.assetUri(kind, renamed);
    const contents = await current.readJson<{ name: string }>(target);
    contents.name = renamed;
    await current.writeJson(target, contents);
  }

  if (kind === 'object') {
    const oldScript = current.objectScriptUri(name);
    const newScript = current.objectScriptUri(renamed);
    try {
      await vscode.workspace.fs.rename(oldScript, newScript);
      const raw = await vscode.workspace.fs.readFile(newScript);
      const source = Buffer.from(raw)
        .toString('utf8')
        .replace(new RegExp(`\\bclass\\s+${name}\\b`, 'g'), `class ${renamed}`);
      await vscode.workspace.fs.writeFile(newScript, Buffer.from(source, 'utf8'));
    } catch {
      // No script alongside the definition.
    }
  }

  await updateReferences(current, kind, name, renamed);
  await refresh();
  void vscode.window.showInformationMessage(
    `Renamed ${name} to ${renamed}. References in scripts were not changed — search for "${name}" to check.`,
  );
}

/** Repoint asset references stored in other project files. */
async function updateReferences(
  current: Project,
  kind: AssetKind,
  from: string,
  to: string,
): Promise<void> {
  if (kind === 'object') {
    for (const room of await current.list('room')) {
      const contents = await current.readJson<RoomFile>(room.uri);
      let changed = false;
      for (const instance of contents.instances ?? []) {
        if (instance.object === from) {
          instance.object = to;
          changed = true;
        }
      }
      if (changed) {
        await current.writeJson(room.uri, contents);
      }
    }
    for (const object of await current.list('object')) {
      const contents = await current.readJson<ObjectFile>(object.uri);
      if (contents.parent === from) {
        contents.parent = to;
        await current.writeJson(object.uri, contents);
      }
    }
  }

  if (kind === 'sprite') {
    for (const object of await current.list('object')) {
      const contents = await current.readJson<ObjectFile>(object.uri);
      if (contents.sprite === from) {
        contents.sprite = to;
        await current.writeJson(object.uri, contents);
      }
    }
  }

  if (kind === 'room') {
    const config = current.projectFile;
    if (config.startRoom === from) {
      config.startRoom = to;
      await current.writeJson(current.projectFileUri, config);
    }
  }
}

// Keeps the compiler honest about the asset shapes used above.
export type { ObjectFile, RoomFile, SpriteFile };
