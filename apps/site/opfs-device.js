// SPDX-License-Identifier: MIT

// Takes ownership of a newly created disk Worker, not of the OPFS file.
// connect is the public kernel workerDevice API; keeping it explicit allows
// the site's helper to stay independent of a particular bundled kernel path.
export async function openDiskWorker(
  worker,
  configuration,
  connect,
  { signal, timeoutMs = 30000 } = {},
) {
  const startup = new AbortController();
  const aborted = () => startup.abort(signal.reason);
  let timer;
  try {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fffffff)
      throw new RangeError("disk worker startup timeout must be an integer in [1, 2147483647]");
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    const pending = connect(worker, { signal: startup.signal });
    // postMessage may throw before pending is awaited. Observe its later abort.
    void pending.catch(() => {});
    startup.signal.throwIfAborted();
    timer = setTimeout(
      () => startup.abort(new DOMException("disk worker readiness timed out", "TimeoutError")),
      timeoutMs,
    );
    worker.postMessage(configuration);
    const device = await pending;
    void device.closed.finally(() => worker.terminate()).catch(() => {});
    return device;
  } catch (error) {
    startup.abort(error);
    try {
      worker.terminate();
    } catch {}
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", aborted);
  }
}
