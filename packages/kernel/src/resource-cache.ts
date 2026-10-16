// SPDX-License-Identifier: MIT

// Share successful and in-flight loads, but do not poison later boot attempts
// with a transient fetch/compile failure. Callers still receive the original error.
export function cache_successful_load<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    if (!cached) {
      const pending = Promise.resolve().then(load);
      cached = pending;
      void pending.catch(() => {
        if (cached === pending) cached = undefined;
      });
    }
    return cached;
  };
}
