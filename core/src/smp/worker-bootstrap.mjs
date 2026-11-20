// Node 22.12 does not apply --import loaders to a TypeScript worker entry.
// Start from JavaScript and register the loader before importing the hart.
import { tsImport } from 'tsx/esm/api';

await tsImport('./worker.ts', import.meta.url);
