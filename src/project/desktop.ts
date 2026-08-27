import type { Project } from './types';

/**
 * The Electron bridge, when running as a desktop app.
 *
 * `undefined` in a plain browser, where the File System Access API is used
 * instead. Everything here is exposed by `electron/preload.cjs`.
 */
export interface DesktopBridge {
  version: string;
  openProjectDialog(): Promise<string | null>;
  chooseFolder(title?: string): Promise<string | null>;
  saveFileDialog(options: {
    title?: string;
    defaultName?: string;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<string | null>;
  readProject(root: string): Promise<Project>;
  writeProject(root: string, project: Project): Promise<boolean>;
  writeFile(target: string, contents: string): Promise<boolean>;
  showItemInFolder(target: string): Promise<void>;
}

declare global {
  interface Window {
    benseditorDesktop?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | undefined =
  typeof window !== 'undefined' ? window.benseditorDesktop : undefined;

export const isDesktop = desktop !== undefined;
