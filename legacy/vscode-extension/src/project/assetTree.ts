import * as vscode from 'vscode';
import { Asset, AssetKind, Project } from './project';

interface GroupNode {
  type: 'group';
  kind: AssetKind;
  label: string;
}

interface AssetNode {
  type: 'asset';
  asset: Asset;
}

export type TreeNode = GroupNode | AssetNode;

const GROUPS: GroupNode[] = [
  { type: 'group', kind: 'sprite', label: 'Sprites' },
  { type: 'group', kind: 'object', label: 'Objects' },
  { type: 'group', kind: 'room', label: 'Rooms' },
  { type: 'group', kind: 'script', label: 'Scripts' },
];

const ICONS: Record<AssetKind, string> = {
  sprite: 'symbol-color',
  object: 'symbol-class',
  room: 'layout',
  script: 'file-code',
};

/** The Assets side bar: one collapsible group per asset kind. */
export class AssetTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly getProject: () => Project | undefined) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.type === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = `group:${node.kind}s`;
      item.iconPath = new vscode.ThemeIcon('folder');
      return item;
    }

    const item = new vscode.TreeItem(node.asset.name, vscode.TreeItemCollapsibleState.None);
    item.contextValue = `asset:${node.asset.kind}`;
    item.resourceUri = node.asset.uri;
    item.iconPath = new vscode.ThemeIcon(ICONS[node.asset.kind]);
    item.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [node.asset.uri],
    };

    const project = this.getProject();
    if (node.asset.kind === 'room' && project?.projectFile.startRoom === node.asset.name) {
      item.description = 'start room';
    }
    return item;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    const project = this.getProject();
    if (!project) {
      return [];
    }
    if (!node) {
      return GROUPS;
    }
    if (node.type === 'group') {
      return (await project.list(node.kind)).map((asset) => ({ type: 'asset', asset }));
    }
    return [];
  }
}
