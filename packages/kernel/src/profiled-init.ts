// SPDX-License-Identifier: MIT
// Diagnostic-only ownership of an init whose transfer has not happened yet.
export function profiled_init_queue(
  send: (message: unknown, transfer?: Transferable[]) => void,
  posted: (queued_ns: number, post_ns: number) => void,
  failed: (error: Error) => void,
  now: () => number = () => performance.now(),
) {
  let ready = false,
    stopped = false;
  let pending: { message: unknown; transfer?: Transferable[]; since: number } | undefined;
  const close = (transfer?: Transferable[]) => {
    for (const value of transfer ?? []) {
      try {
        (value as { close?: () => void }).close?.();
      } catch {}
    }
  };
  const deliver = (entry: NonNullable<typeof pending>) => {
    const start = now();
    try {
      send(entry.message, entry.transfer);
    } catch (error) {
      stopped = true;
      close(entry.transfer);
      throw error;
    }
    posted(Math.round((start - entry.since) * 1e6), Math.round((now() - start) * 1e6));
  };
  return {
    post(message: unknown, transfer?: Transferable[]) {
      if (stopped) throw Error("profiled Worker already stopped");
      if (pending) throw Error("profiled Worker already has a pending init");
      const entry = { message, transfer, since: now() };
      if (ready) deliver(entry);
      else pending = entry;
    },
    ready() {
      if (stopped) return;
      if (ready) {
        stopped = true;
        failed(Error("duplicate profiled module-ready message"));
        return;
      }
      ready = true;
      const entry = pending;
      pending = undefined;
      if (entry)
        try {
          deliver(entry);
        } catch (error) {
          stopped = true;
          failed(error instanceof Error ? error : Error(String(error)));
        }
    },
    stop() {
      stopped = true;
      close(pending?.transfer);
      pending = undefined;
    },
  };
}
