import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Project } from '../project/project';

const RUNNING_CONTEXT = 'benseditor.running';

export interface PythonCommand {
  command: string;
  args: string[];
}

/**
 * Launches game processes and surfaces their output.
 *
 * The engine ships inside the extension, so only third-party wheels
 * (moderngl, pyglet, pillow, numpy) ever need installing.
 */
export class GameRunner {
  private process: ChildProcess | undefined;
  private readonly output: vscode.OutputChannel;
  private readonly status: vscode.StatusBarItem;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.output = vscode.window.createOutputChannel('Benseditor');
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.status.command = 'benseditor.run';
    this.setRunning(false);
  }

  dispose(): void {
    this.stop();
    this.output.dispose();
    this.status.dispose();
  }

  get enginePath(): string {
    return path.join(this.extensionUri.fsPath, 'engine');
  }

  /** Path to the interpreter inside a project's virtualenv, if one exists. */
  static venvPython(projectRoot: string): string | undefined {
    const candidate = path.join(
      projectRoot,
      '.venv',
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python',
    );
    return fs.existsSync(candidate) ? candidate : undefined;
  }

  /**
   * Pick an interpreter: the configured one, then the project's `.venv`,
   * then `py -3` / `python3`, then `python`.
   */
  resolvePython(projectRoot?: string): PythonCommand | undefined {
    const configured = vscode.workspace
      .getConfiguration('benseditor')
      .get<string>('pythonPath', '')
      .trim();
    if (configured) {
      return { command: configured, args: [] };
    }

    if (projectRoot) {
      const venv = GameRunner.venvPython(projectRoot);
      if (venv) {
        return { command: venv, args: [] };
      }
    }

    const candidates: PythonCommand[] =
      process.platform === 'win32'
        ? [
            { command: 'py', args: ['-3'] },
            { command: 'python', args: [] },
          ]
        : [
            { command: 'python3', args: [] },
            { command: 'python', args: [] },
          ];

    for (const candidate of candidates) {
      const probe = spawnSync(candidate.command, [...candidate.args, '--version'], {
        encoding: 'utf8',
        shell: false,
      });
      if (probe.status === 0) {
        return candidate;
      }
    }
    return undefined;
  }

  async run(project: Project): Promise<void> {
    if (this.process) {
      this.stop();
    }

    await vscode.workspace.saveAll(false);

    const python = this.resolvePython(project.root.fsPath);
    if (!python) {
      const choice = await vscode.window.showErrorMessage(
        'Benseditor could not find a Python interpreter. Set benseditor.pythonPath in settings.',
        'Open Settings',
      );
      if (choice === 'Open Settings') {
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'benseditor.pythonPath',
        );
      }
      return;
    }

    this.output.clear();
    this.output.show(true);
    this.output.appendLine(`> ${python.command} ${python.args.join(' ')} -m benseditor.run`);
    this.output.appendLine(`  project: ${project.root.fsPath}`);
    this.output.appendLine('');

    const env = { ...process.env };
    env.PYTHONPATH = env.PYTHONPATH
      ? `${this.enginePath}${path.delimiter}${env.PYTHONPATH}`
      : this.enginePath;
    env.PYTHONUNBUFFERED = '1';

    const child = spawn(
      python.command,
      [...python.args, '-m', 'benseditor.run', project.root.fsPath],
      { cwd: project.root.fsPath, env },
    );
    this.process = child;
    this.setRunning(true);

    child.stdout?.on('data', (chunk: Buffer) => this.output.append(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => this.output.append(chunk.toString()));

    child.on('error', (error) => {
      this.output.appendLine(`\nFailed to start the game: ${error.message}`);
      this.process = undefined;
      this.setRunning(false);
    });

    child.on('close', (code) => {
      this.output.appendLine(`\n[game exited with code ${code ?? 0}]`);
      this.process = undefined;
      this.setRunning(false);
      if (code === 2) {
        void this.offerInstall(project);
      }
    });
  }

  stop(): void {
    if (!this.process) {
      return;
    }
    const child = this.process;
    this.process = undefined;
    this.setRunning(false);
    if (process.platform === 'win32' && child.pid !== undefined) {
      // The Python process owns a window; kill the whole tree.
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    } else {
      child.kill();
    }
  }

  get isRunning(): boolean {
    return this.process !== undefined;
  }

  /**
   * Install the engine's runtime dependencies in a visible terminal.
   *
   * Prefers a project-local `.venv`, offering to create one. Many Python
   * installations are "externally managed" and refuse a global pip install,
   * so a virtualenv is both the safer and the more likely-to-work choice.
   */
  async installDependencies(project?: Project): Promise<void> {
    const root = project?.root.fsPath;
    const existingVenv = root ? GameRunner.venvPython(root) : undefined;

    let target: PythonCommand | undefined;
    let createVenvWith: PythonCommand | undefined;

    if (existingVenv) {
      target = { command: existingVenv, args: [] };
    } else if (root) {
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: 'Create a .venv in the project',
            description: 'Recommended — keeps the game’s dependencies isolated',
            pick: 'venv',
          },
          {
            label: 'Install into the current interpreter',
            description: 'May fail on externally managed Python installations',
            pick: 'global',
          },
        ],
        { title: 'Where should the engine dependencies be installed?' },
      );
      if (!choice) {
        return;
      }
      if (choice.pick === 'venv') {
        createVenvWith = this.resolvePython();
        if (!createVenvWith) {
          void vscode.window.showErrorMessage(
            'Benseditor could not find a Python interpreter. Set benseditor.pythonPath in settings.',
          );
          return;
        }
      } else {
        target = this.resolvePython();
      }
    } else {
      target = this.resolvePython();
    }

    if (!target && !createVenvWith) {
      void vscode.window.showErrorMessage(
        'Benseditor could not find a Python interpreter. Set benseditor.pythonPath in settings.',
      );
      return;
    }

    const terminal = vscode.window.createTerminal({
      name: 'Benseditor Engine Setup',
      cwd: root,
    });
    terminal.show();

    if (createVenvWith && root) {
      terminal.sendText(quote(createVenvWith) + ' -m venv .venv');
      const venvPython = path.join(
        '.venv',
        process.platform === 'win32' ? 'Scripts' : 'bin',
        process.platform === 'win32' ? 'python.exe' : 'python',
      );
      target = { command: venvPython, args: [] };
    }

    terminal.sendText(
      `${quote(target!)} -m pip install --upgrade moderngl pyglet pillow numpy`,
    );
  }

  private async offerInstall(project?: Project): Promise<void> {
    const choice = await vscode.window.showErrorMessage(
      'The Benseditor engine is missing its Python dependencies.',
      'Install Now',
    );
    if (choice === 'Install Now') {
      await this.installDependencies(project);
    }
  }

  private setRunning(running: boolean): void {
    void vscode.commands.executeCommand('setContext', RUNNING_CONTEXT, running);
    this.status.text = running ? '$(debug-stop) Benseditor' : '$(play) Run Game';
    this.status.tooltip = running ? 'Stop the running game' : 'Run this Benseditor project (F5)';
    this.status.command = running ? 'benseditor.stop' : 'benseditor.run';
  }

  showStatus(visible: boolean): void {
    if (visible) {
      this.status.show();
    } else {
      this.status.hide();
    }
  }
}

/** Render a command for a shell, quoting paths that contain spaces. */
function quote(command: PythonCommand): string {
  const executable = command.command.includes(' ') ? `"${command.command}"` : command.command;
  return [executable, ...command.args].join(' ');
}
