// SPDX-License-Identifier: MIT
import type { WorkerHandle } from "./platform.ts";

export async function terminate_workers(workers: Iterable<WorkerHandle>): Promise<void> {
  const outcomes = await Promise.allSettled(
    Array.from(workers, (worker) => Promise.resolve().then(() => worker.terminate())),
  );
  // Report the first error only after every worker has finished its attempt.
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") throw outcome.reason;
  }
}

export function post_worker_init(
  workers: Set<WorkerHandle>,
  worker: WorkerHandle,
  message: unknown,
  transfer?: Transferable[],
): void {
  workers.add(worker);
  try {
    worker.post(message, transfer);
  } catch (error) {
    // A failed transfer never initialized this worker. In particular, clone's
    // retryable error path does not close the entire machine for us.
    // Keep ownership until termination succeeds; machine shutdown can retry
    // cleanup if the platform rejects termination.
    void Promise.resolve()
      .then(() => worker.terminate())
      .then(
        () => {
          workers.delete(worker);
        },
        () => {},
      );
    throw error;
  }
}
