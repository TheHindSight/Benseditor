/**
 * Hand-written types for the generated `micropython.js` (see
 * tools/vendor-micropython.mjs). Only what the Python host uses.
 */
export interface MicroPythonOptions {
  pystack?: number;
  heapsize?: number;
  stdin?: () => number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  linebuffer?: boolean;
}

export interface MicroPythonInstance {
  runPython(code: string): unknown;
  runPythonAsync(code: string): Promise<unknown>;
  registerJsModule(name: string, module: Record<string, unknown>): void;
  pyimport(name: string): unknown;
  globals: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    delete(key: string): void;
  };
}

export function loadMicroPython(options?: MicroPythonOptions): Promise<MicroPythonInstance>;
