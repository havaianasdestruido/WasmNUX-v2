import { parentPort, workerData } from 'node:worker_threads';
import { runHart } from './hart.ts';
parentPort!.postMessage(runHart(workerData));
