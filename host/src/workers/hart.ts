import { runHart, type HartData } from '../../../core/src/smp/hart.ts';
self.onmessage = (event: MessageEvent<HartData>) => {
  try {
    self.postMessage(runHart(event.data));
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
