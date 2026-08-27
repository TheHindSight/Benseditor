import * as vscode from 'vscode';
import { PROJECT_FOLDERS, buildProjectFiles } from './project/starter';

/** Write a fresh starter project into `root`. */
export async function scaffoldProject(root: vscode.Uri, name: string): Promise<void> {
  for (const folder of PROJECT_FOLDERS) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, folder));
  }

  for (const [relative, contents] of Object.entries(buildProjectFiles(name))) {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(root, ...relative.split('/')),
      Buffer.from(contents, 'utf8'),
    );
  }
}
