/**
 * Minimal ambient types for the WebAssembly namespace — lib:ES2022 has no
 * DOM, and this project intentionally avoids pulling the whole DOM lib into
 * the core (it also runs in Node workers). Scope: what core/jit actually use.
 */

declare namespace WebAssembly {
  type BufferSource = ArrayBuffer | ArrayBufferView;

  interface MemoryDescriptor {
    initial: number;
    maximum?: number;
    shared?: boolean;
  }

  class Memory {
    constructor(descriptor: MemoryDescriptor);
    readonly buffer: ArrayBufferLike;
    grow(delta: number): number;
  }

  interface ModuleDescriptor {
    /** reserved */
  }

  class Module {
    constructor(bytes: BufferSource);
    static exports(module: Module): Array<{ name: string; kind: string }>;
    static imports(module: Module): Array<{ module: string; name: string; kind: string }>;
  }

  type ImportValue = Function | Global | Memory | Table;
  interface Imports {
    [module: string]: { [name: string]: ImportValue };
  }

  type ExportValue = Function | Global | Memory | Table;
  interface Exports {
    [name: string]: ExportValue;
  }

  class Instance {
    constructor(module: Module, imports?: Imports);
    readonly exports: Exports;
  }

  class Global {
    constructor(descriptor: GlobalDescriptor, value?: ImportValue);
    value: ImportValue;
    valueOf(): ImportValue;
  }

  interface GlobalDescriptor {
    value: "i32" | "i64" | "f32" | "f64" | "externref" | "funcref";
    mutable?: boolean;
  }

  class Table {
    constructor(descriptor: TableDescriptor);
    readonly length: number;
    get(index: number): ExportValue | undefined;
    set(index: number, value: ExportValue): void;
    grow(delta: number): number;
  }

  interface TableDescriptor {
    element: "funcref" | "externref";
    initial: number;
    maximum?: number;
  }

  class CompileError extends Error {}
  class LinkError extends Error {}
  class RuntimeError extends Error {}

  function compile(bytes: BufferSource): Promise<Module>;
  function instantiate(
    bytesOrModule: BufferSource | Module,
    imports?: Imports,
  ): Promise<{ module: Module; instance: Instance }>;
  function validate(bytes: BufferSource): boolean;
}
