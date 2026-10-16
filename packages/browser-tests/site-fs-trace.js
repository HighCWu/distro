// SPDX-License-Identifier: MIT
// Test-only diagnostics. Keep this function self-contained for addInitScript.
export function installSiteFsTrace(scope = globalThis) {
  const pending = new Map();
  const recent = [];
  const names = new WeakMap();
  let sequence = 0;
  let omitted = 0;
  const clock = () => scope.performance.now();
  const finish = (entry, error) => {
    if (!pending.delete(entry.id)) return;
    recent.push({ ...entry, elapsedMs: clock() - entry.startedMs, error });
    if (recent.length > 64) recent.shift();
  };
  for (const [constructor, methods] of [
    ["FileSystemDirectoryHandle", ["getDirectoryHandle", "getFileHandle", "removeEntry"]],
    ["FileSystemFileHandle", ["getFile", "createWritable"]],
    ["FileSystemWritableFileStream", ["write", "seek", "truncate", "close", "abort"]],
  ]) {
    const prototype = scope[constructor]?.prototype;
    if (!prototype) continue;
    for (const method of methods) {
      const original = prototype[method];
      if (typeof original !== "function") continue;
      prototype[method] = function (...args) {
        // Never retain write buffers, file contents, or exception messages.
        const entry = {
          id: ++sequence,
          operation: `${constructor}.${method}`,
          name: typeof this.name === "string" ? this.name : names.get(this),
          child: constructor === "FileSystemDirectoryHandle" ? args[0] : undefined,
          startedMs: clock(),
        };
        if (pending.size < 64) pending.set(entry.id, entry);
        else omitted++;
        try {
          const result = original.apply(this, args);
          // Observe settlement, but return the exact original result/promise.
          Promise.resolve(result).then(
            (value) => {
              if (method === "createWritable" && value && typeof value === "object") {
                names.set(value, entry.name);
              }
              finish(entry);
            },
            (error) => finish(entry, error?.name ?? "Error"),
          );
          return result;
        } catch (error) {
          finish(entry, error?.name ?? "Error");
          throw error;
        }
      };
    }
  }
  scope.__siteFsTrace = () => ({
    pending: [...pending.values()].map((entry) => ({
      ...entry,
      elapsedMs: clock() - entry.startedMs,
    })),
    recent: recent.map((entry) => ({ ...entry })),
    omitted,
  });
}
