export function workerTask(url, request, timeout = 60_000) {
  const worker = new Worker(url, {type:'module'});
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(reject, new Error(`worker timed out: ${url}`)), timeout);
    function done(callback, value) { clearTimeout(timer); worker.terminate(); callback(value); }
    worker.onerror = e => done(reject, new Error(e.message));
    worker.onmessageerror = () => done(reject, new Error('worker message could not be decoded'));
    worker.onmessage = ({data}) => data.error ? done(reject, new Error(data.error)) : done(resolve, data.value);
    try { worker.postMessage(request); } catch (error) { done(reject, error); }
  });
}
export function serveWorker(run) {
  self.onmessage = async ({data}) => {
    try { self.postMessage({value:await run(data)}); }
    catch (e) { self.postMessage({error:String(e.stack || e)}); }
  };
}
