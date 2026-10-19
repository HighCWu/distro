// SPDX-License-Identifier: MIT
// Private build-time fault seam. No boot option, environment variable or UAPI.
export const copy_fault_test = false;
export type CopyFault = "initialize" | "allocate" | "timeout";

export function create_copy_fault_plan(): () => CopyFault | null {
  const plan: CopyFault[] = copy_fault_test ? ["initialize", "allocate", "timeout"] : [];
  return () => plan.shift() ?? null;
}

export function inject_copy_fault(fault: CopyFault | undefined, stage: CopyFault): void {
  if (copy_fault_test && fault === stage) throw new Error(`injected copy ${stage} failure`);
}

// Only test builds allocate extra words: [terminal result, checkpoint/ack, tag].
export function copy_status_words(): number {
  return copy_fault_test ? 3 : 1;
}

// A real timeout check must exercise the new kernel's scheduling point,
// rather than accidentally accepting the old-kernel synchronous fallback.
export function require_copy_wait_progress(
  status: Int32Array<SharedArrayBuffer>,
  count: number,
): void {
  if (copy_fault_test && Atomics.load(status, 2) === 1 && count <= 0)
    throw new Error("copy timeout test: kernel scheduler did not run during copy wait");
}

export function mark_copy_timeout(
  status: Int32Array<SharedArrayBuffer>,
  fault: CopyFault | null,
): void {
  if (copy_fault_test && fault === "timeout") Atomics.store(status, 2, 1);
}

export function pause_copy_publication(
  fault: CopyFault | undefined,
  status: Int32Array<SharedArrayBuffer>,
): void {
  if (!copy_fault_test || fault !== "timeout") return;
  Atomics.store(status, 1, 1);
  Atomics.notify(status, 1);
  const deadline = performance.now() + 35_000;
  while (Atomics.load(status, 0) === 0) {
    const left = deadline - performance.now();
    if (left <= 0) throw new Error("copy timeout test: parent did not release publication gate");
    Atomics.wait(status, 0, 0, left);
  }
  if (Atomics.load(status, 0) !== -11) throw new Error("copy timeout test: expected parent EAGAIN");
}

// Called only after the real one-shot publication CAS has refused this child.
export function acknowledge_copy_timeout(
  fault: CopyFault | undefined,
  status: Int32Array<SharedArrayBuffer>,
): void {
  if (!copy_fault_test || fault !== "timeout") return;
  if (Atomics.load(status, 0) !== -11 || Atomics.load(status, 1) !== 1)
    throw new Error("copy timeout test: missing publication checkpoint");
  Atomics.store(status, 1, 2);
  Atomics.notify(status, 1);
}

export function join_copy_timeout(status: Int32Array<SharedArrayBuffer>): void {
  if (!copy_fault_test || Atomics.load(status, 2) !== 1) return;
  const deadline = performance.now() + 5_000;
  while (Atomics.load(status, 1) !== 2) {
    const state = Atomics.load(status, 1);
    if (state === 2) break;
    const left = deadline - performance.now();
    if (left <= 0) throw new Error("copy timeout test: late worker did not acknowledge rejection");
    Atomics.wait(status, 1, state, left);
  }
  if (Atomics.load(status, 0) !== -11) throw new Error("copy timeout test: result changed");
}
