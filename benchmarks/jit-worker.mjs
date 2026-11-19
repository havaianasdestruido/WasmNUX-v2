import {measureJit} from '../core/jit/rv64.mjs';
import {serveWorker} from '../host/worker-rpc.mjs';
serveWorker(n => measureJit(n));
