// SPDX-License-Identifier: MIT
// Node diagnostic runner only. No SDK, boot option or application API.
export function captureProfileOutput(enabled, expected, logger = console) {
  const lines = [];
  if (!enabled) return { lines, completion: undefined, restore() {} };
  const original = logger.error;
  let finish;
  const completion =
    expected > 0
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : undefined;
  const capture = (...args) => {
    if (args.length === 1 && typeof args[0] === "string" && args[0].startsWith("fork-profile: ")) {
      lines.push(args[0].trimEnd());
      if (lines.length >= expected) finish?.();
    } else original.apply(logger, args);
  };
  logger.error = capture;
  return {
    lines,
    completion,
    restore() {
      if (logger.error === capture) logger.error = original;
    },
  };
}
