// SPDX-License-Identifier: MIT

export type UserCopyStatus = Int32Array<SharedArrayBuffer>;

export const USER_COPY_COMPLETE = 1;
export const USER_COPY_TRY_AGAIN = -11;
export const USER_COPY_NO_MEMORY = -12;

/** Publish the first terminal result and wake the worker that requested the copy. */
export function settle_user_copy(status: UserCopyStatus | null, result: number): boolean {
  if (!status || result === 0) return false;
  if (Atomics.compareExchange(status, 0, 0, result) !== 0) return false;
  Atomics.notify(status, 0);
  return true;
}

/** A failed request must never initialize or publish a late child. */
export function user_copy_failed(status: UserCopyStatus | null): boolean {
  return status !== null && Atomics.load(status, 0) < 0;
}

/** Handle initialization failure, including a timeout that already won. */
export function reject_user_copy(status: UserCopyStatus | null): boolean {
  return settle_user_copy(status, USER_COPY_TRY_AGAIN) || user_copy_failed(status);
}

/** Wait for a child worker to finish its private-memory snapshot. */
export function wait_user_copy(status: UserCopyStatus, timeout_ms = 30_000): number {
  // A system clock adjustment must not extend or shorten a pending snapshot.
  const deadline = performance.now() + timeout_ms;

  for (;;) {
    const result = Atomics.load(status, 0);
    if (result !== 0) return result;

    const remaining = deadline - performance.now();
    if (remaining <= 0 || Atomics.wait(status, 0, 0, remaining) === "timed-out") {
      settle_user_copy(status, USER_COPY_TRY_AGAIN);
      return Atomics.load(status, 0);
    }
  }
}
