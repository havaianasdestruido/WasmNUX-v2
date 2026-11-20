import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBrowserSmp } from '../src/index.ts';
import type { HartData } from '../../core/src/smp/hart.ts';

const workerUrl = new URL('https://example.test/hart.js');
const options = {
  harts: 2,
  program: Uint8Array.of(1, 2, 3, 4),
  entry: 0x10004,
  stackTop: 0x20000,
  ramBase: 0x10000,
  ramBytes: 65536,
  budget: 0,
  timeoutMs: 100,
};

class TestWorker {
  static instances: TestWorker[] = [];

  onmessage?: (event: { data: unknown }) => void;
  onmessageerror?: () => void;
  onerror?: (event: { message: string; preventDefault(): void }) => void;
  postMessage = vi.fn<(data: HartData) => void>();
  terminate = vi.fn();

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    TestWorker.instances.push(this);
  }

  reply(data: unknown) {
    this.onmessage?.({ data });
  }
}

function result(hartId: number) {
  return { hartId, exitCode: 0, instret: 0, stop: 'budget', regs: Array<number>(32).fill(0) };
}

describe('browser SMP worker coordination', () => {
  beforeEach(() => {
    TestWorker.instances = [];
    vi.stubGlobal('Worker', TestWorker);
    vi.stubGlobal('crossOriginIsolated', true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function expectCleanedUp(count = options.harts) {
    expect(TestWorker.instances).toHaveLength(count);
    for (const worker of TestWorker.instances) expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  }

  it('rejects without isolation before starting workers', async () => {
    vi.stubGlobal('crossOriginIsolated', false);
    await expect(runBrowserSmp(options, workerUrl)).rejects.toThrow(/cross-origin isolation/);
    expectCleanedUp(0);
  });

  it.each([
    ['hart count', { harts: 0 }],
    ['hart count', { harts: 1.5 }],
    ['hart count', { harts: 17 }],
    ['budget', { budget: -1 }],
    ['budget', { budget: Number.MAX_SAFE_INTEGER + 1 }],
    ['timeoutMs', { timeoutMs: 0 }],
    ['timeoutMs', { timeoutMs: 0x80000000 }],
    ['RAM must be page aligned', { ramBytes: 0 }],
    ['RAM must be page aligned', { ramBytes: 65537 }],
    ['RAM must be page aligned', { ramBytes: (256 << 20) + 65536 }],
    ['RV32 RAM address', { ramBase: -1 }],
    ['RV32 RAM address', { ramBase: 0xffff0001 }],
    ['entry', { entry: options.entry + 2 }],
    ['entry', { entry: options.stackTop }],
    ['stackTop', { stackTop: options.ramBase - 1 }],
    ['stackTop', { stackTop: options.stackTop + 1 }],
    ['program exceeds RAM', { program: new Uint8Array(options.ramBytes + 1) }],
  ] as const)('rejects invalid %s before starting workers', async (message, overrides) => {
    await expect(runBrowserSmp({ ...options, ...overrides }, workerUrl)).rejects.toThrow(
      expect.objectContaining({ name: 'RangeError', message: expect.stringContaining(message) }),
    );
    expectCleanedUp(0);
  });

  it('returns hart results in ID order and uses one shared memory and channel', async () => {
    const run = runBrowserSmp(options, workerUrl);
    const [first, second] = TestWorker.instances as [TestWorker, TestWorker];
    const firstRequest = first.postMessage.mock.calls[0]![0];
    const secondRequest = second.postMessage.mock.calls[0]![0];

    second.reply(result(1));
    await Promise.resolve();
    expect(first.terminate).not.toHaveBeenCalled();
    first.reply(result(0));

    const { memory, harts } = await run;
    expect(harts).toEqual([result(0), result(1)]);
    expect(memory.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(memory.buffer.byteLength).toBe(options.ramBytes);
    expect(firstRequest).toMatchObject({ ...options, hartId: 0 });
    expect(secondRequest).toMatchObject({ ...options, hartId: 1 });
    expect(firstRequest.memory).toBe(memory);
    expect(secondRequest.memory).toBe(memory);
    expect(firstRequest.channel).toBeInstanceOf(SharedArrayBuffer);
    expect(secondRequest.channel).toBe(firstRequest.channel);
    for (const worker of TestWorker.instances) {
      expect(worker.url).toBe(workerUrl);
      expect(worker.options.type).toBe('module');
    }
    expectCleanedUp();
  });

  it.each([
    { message: 'hart identity mismatch', fail: (worker: TestWorker) => worker.reply(result(0)) },
    { message: 'loader failed', fail: (worker: TestWorker) => worker.reply({ error: 'loader failed' }) },
    { message: 'hart 1: invalid message', fail: (worker: TestWorker) => worker.onmessageerror?.() },
  ])('terminates every worker on $message', async ({ message, fail }) => {
    const run = runBrowserSmp(options, workerUrl);
    fail(TestWorker.instances[1]!);
    await expect(run).rejects.toThrow(message);
    expectCleanedUp();
  });

  it('handles worker startup errors and cleans up waiting harts', async () => {
    const run = runBrowserSmp(options, workerUrl);
    const preventDefault = vi.fn();
    TestWorker.instances[1]!.onerror?.({ message: 'module failed', preventDefault });
    await expect(run).rejects.toThrow('hart 1: module failed');
    expect(preventDefault).toHaveBeenCalledOnce();
    expectCleanedUp();
  });

  it('times out if a hart never replies, even after another hart finishes', async () => {
    const run = runBrowserSmp(options, workerUrl);
    const assertion = expect(run).rejects.toThrow(/timed out/);
    TestWorker.instances[0]!.reply(result(0));
    await vi.advanceTimersByTimeAsync(options.timeoutMs - 1);
    expect(TestWorker.instances[1]!.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expectCleanedUp();
  });
});
