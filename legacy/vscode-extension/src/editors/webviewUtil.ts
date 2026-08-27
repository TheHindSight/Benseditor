import * as vscode from 'vscode';

export function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

export interface ShellOptions {
  title: string;
  /** Paths relative to the extension root, e.g. `media/sprite/sprite.css`. */
  styles: string[];
  scripts: string[];
  body: string;
}

/**
 * Wrap webview markup in a document with a strict CSP. `data:` images are
 * allowed because sprite frames are inlined as base64 PNG.
 */
export function htmlShell(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  options: ShellOptions,
): string {
  const nonce = makeNonce();
  const asset = (p: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...p.split('/')));

  const styles = options.styles
    .map((p) => `<link rel="stylesheet" href="${asset(p)}">`)
    .join('\n    ');
  const scripts = options.scripts
    .map((p) => `<script nonce="${nonce}" src="${asset(p)}"></script>`)
    .join('\n    ');

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${asset('media/common.css')}">
    ${styles}
    <title>${options.title}</title>
  </head>
  <body>
    ${options.body}
    ${scripts}
  </body>
</html>`;
}

/**
 * Replace an entire JSON document's text with `value`.
 *
 * Custom editors persist through the text document, so each committed change
 * becomes one entry on VS Code's native undo stack.
 */
export function replaceDocument(document: vscode.TextDocument, value: unknown): Thenable<boolean> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(0, 0, document.lineCount, 0),
    JSON.stringify(value, null, 2) + '\n',
  );
  return vscode.workspace.applyEdit(edit);
}
