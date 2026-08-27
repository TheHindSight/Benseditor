/// <reference types="vite/client" />

declare module '*.luau?raw' {
  const source: string;
  export default source;
}

declare module '*.py?raw' {
  const source: string;
  export default source;
}

/**
 * File System Access API. Still not in TypeScript's DOM lib, but it is what
 * lets a project be real files in a real folder rather than a browser blob.
 */
interface DirectoryPickerOptions {
  mode?: 'read' | 'readwrite';
  id?: string;
  startIn?: string | FileSystemHandle;
}

interface Window {
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;
}
