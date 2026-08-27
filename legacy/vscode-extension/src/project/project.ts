import * as vscode from 'vscode';
import { ProjectFile } from './assets';

export const PROJECT_FILE = 'benseditor.json';

export type AssetKind = 'sprite' | 'object' | 'room' | 'script';

export interface Asset {
  kind: AssetKind;
  name: string;
  uri: vscode.Uri;
}

const FOLDERS: Record<AssetKind, string> = {
  sprite: 'sprites',
  object: 'objects',
  room: 'rooms',
  script: 'scripts',
};

const EXTENSIONS: Record<AssetKind, string> = {
  sprite: '.bsprite',
  object: '.bobject',
  room: '.broom',
  script: '.py',
};

/**
 * A Benseditor project rooted at a folder containing `benseditor.json`.
 *
 * Assets are plain files on disk; nothing is cached beyond the project config,
 * so external edits (git checkout, another editor) stay authoritative.
 */
export class Project {
  private constructor(
    readonly root: vscode.Uri,
    private config: ProjectFile,
  ) {}

  /** Locate the first workspace folder holding a project file. */
  static async find(): Promise<Project | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const project = await Project.open(folder.uri);
      if (project) {
        return project;
      }
    }
    return undefined;
  }

  static async open(root: vscode.Uri): Promise<Project | undefined> {
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, PROJECT_FILE));
      return new Project(root, JSON.parse(Buffer.from(raw).toString('utf8')) as ProjectFile);
    } catch {
      return undefined;
    }
  }

  get name(): string {
    return this.config.name;
  }

  get projectFile(): ProjectFile {
    return this.config;
  }

  get projectFileUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.root, PROJECT_FILE);
  }

  folder(kind: AssetKind): vscode.Uri {
    return vscode.Uri.joinPath(this.root, FOLDERS[kind]);
  }

  /** Path of the asset definition file for `name`. */
  assetUri(kind: AssetKind, name: string): vscode.Uri {
    return vscode.Uri.joinPath(this.folder(kind), name + EXTENSIONS[kind]);
  }

  /** Objects pair a `.bobject` definition with a sibling `.py` behaviour script. */
  objectScriptUri(name: string): vscode.Uri {
    return vscode.Uri.joinPath(this.folder('object'), name + '.py');
  }

  async list(kind: AssetKind): Promise<Asset[]> {
    const dir = this.folder(kind);
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return [];
    }

    const ext = EXTENSIONS[kind];
    return entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(ext))
      .map(([name]) => ({
        kind,
        name: name.slice(0, -ext.length),
        uri: vscode.Uri.joinPath(dir, name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listNames(kind: AssetKind): Promise<string[]> {
    return (await this.list(kind)).map((a) => a.name);
  }

  async exists(kind: AssetKind, name: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(this.assetUri(kind, name));
      return true;
    } catch {
      return false;
    }
  }

  async writeJson(uri: vscode.Uri, value: unknown): Promise<void> {
    const text = JSON.stringify(value, null, 2) + '\n';
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
  }

  async readJson<T>(uri: vscode.Uri): Promise<T> {
    const raw = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(Buffer.from(raw).toString('utf8')) as T;
  }

  async ensureFolders(): Promise<void> {
    for (const kind of Object.keys(FOLDERS) as AssetKind[]) {
      await vscode.workspace.fs.createDirectory(this.folder(kind));
    }
  }

  /** Which asset kind (if any) a file belongs to, based on its extension. */
  static kindOf(uri: vscode.Uri): AssetKind | undefined {
    for (const [kind, ext] of Object.entries(EXTENSIONS) as [AssetKind, string][]) {
      if (kind !== 'script' && uri.path.endsWith(ext)) {
        return kind;
      }
    }
    return undefined;
  }
}
