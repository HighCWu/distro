// SPDX-License-Identifier: MIT
// Private diagnostic build only: no boot option, user import or Linux UAPI.
export const fork_profile_test = false;

// The Linux early boot stream is closed before user programs run. Forward
// private diagnostic records to the host logger instead; the Node test runner
// captures this one prefix without changing Machine or Linux interfaces.
export function emit_fork_profile_record(line: string): void {
  if (fork_profile_test) console.error(line.trimEnd());
}

export interface ForkProfileRequest {
  id: string;
}
type Measure = "allocate_ns" | "copy_ns" | "kernel_instance_ns" | "user_instance_ns";
export type ForkProfileEvent =
  | { kind: "worker-construct" | "worker-online" | "worker-main-turn"; ns: number }
  | { kind: "worker-module-ready"; ns: number; module_ns: number }
  | { kind: "worker-init-posted"; ns: number; queued_ns: number; post_ns: number }
  | { kind: "worker-start-message"; ns: number }
  | {
      kind: "parent-ready";
      ns: number;
      wait_ns: number;
      cooperate_ns: number;
      cooperate_count: number;
      ready_after_cooperate_count: number;
    }
  | {
      kind: "child-ready";
      ns: number;
      allocate_ns: number;
      copy_ns: number;
      kernel_instance_ns: number;
      user_instance_ns: number;
    }
  | { kind: "child-prepare-rewind"; ns: number }
  | { kind: "child-rewind-checkpoint"; ns: number };

/** All intervals use one isolate's monotonic clock; no clock-origin subtraction. */
export class ForkProfile {
  private readonly started: number;
  private rewind: number | null = null;
  private completed = false;
  private wait_ns = 0;
  private cooperate_ns = 0;
  private cooperate_count = 0;
  private ready_after_cooperate_count = 0;
  readonly request: ForkProfileRequest;
  private readonly emit: (line: string) => void;
  private readonly now: () => number;
  private readonly measurements = {
    allocate_ns: 0,
    copy_ns: 0,
    kernel_instance_ns: 0,
    user_instance_ns: 0,
  };
  constructor(
    request: ForkProfileRequest,
    emit: (line: string) => void,
    now: () => number = () => performance.now(),
  ) {
    this.request = request;
    this.emit = emit;
    this.now = now;
    this.started = now();
  }
  private elapsed(start: number): number {
    return Math.round((this.now() - start) * 1_000_000);
  }
  private report(event: ForkProfileEvent): void {
    // Diagnostics must not turn a successful syscall into a failure. Missing
    // diagnostics fail the separate profiling corpus, not the production ABI.
    try {
      this.emit(
        `fork-profile: ${JSON.stringify({ schemaVersion: 3, request: this.request.id, ...event })}\n`,
      );
    } catch {}
  }
  measure<T>(name: Measure, callback: () => T): T {
    const start = this.now();
    try {
      return callback();
    } finally {
      this.measurements[name] += this.elapsed(start);
    }
  }
  parentReady(): void {
    this.report({
      kind: "parent-ready",
      ns: this.elapsed(this.started),
      wait_ns: this.wait_ns,
      cooperate_ns: this.cooperate_ns,
      cooperate_count: this.cooperate_count,
      ready_after_cooperate_count: this.ready_after_cooperate_count,
    });
  }
  wait<T>(callback: () => T): T {
    const start = this.now();
    try {
      return callback();
    } finally {
      this.wait_ns += this.elapsed(start);
    }
  }
  cooperate(callback: () => void, ready: () => boolean): void {
    const start = this.now();
    this.cooperate_count++;
    try {
      callback();
    } finally {
      this.cooperate_ns += this.elapsed(start);
    }
    // This is an observation after returning, not a timestamp of publication:
    // it cannot establish how long the parent slept after the child was ready.
    if (ready()) this.ready_after_cooperate_count++;
  }
  workerStarted(): void {
    this.report({ kind: "worker-start-message", ns: this.elapsed(this.started) });
  }
  workerConstructed(): void {
    this.report({ kind: "worker-construct", ns: this.elapsed(this.started) });
  }
  workerOnline(): void {
    this.report({ kind: "worker-online", ns: this.elapsed(this.started) });
  }
  mainTurn(): void {
    this.report({ kind: "worker-main-turn", ns: this.elapsed(this.started) });
  }
  moduleReady(module_ns: number): void {
    this.report({ kind: "worker-module-ready", ns: this.elapsed(this.started), module_ns });
  }
  initPosted(queued_ns: number, post_ns: number): void {
    this.report({ kind: "worker-init-posted", ns: this.elapsed(this.started), queued_ns, post_ns });
  }
  childReady(): void {
    this.report({ kind: "child-ready", ns: this.elapsed(this.started), ...this.measurements });
  }
  prepareChild(callback: () => void): void {
    this.rewind = this.now();
    callback();
    this.report({ kind: "child-prepare-rewind", ns: this.elapsed(this.rewind) });
  }
  childRewound(): void {
    if (this.rewind === null || this.completed) return;
    this.completed = true;
    this.report({ kind: "child-rewind-checkpoint", ns: this.elapsed(this.rewind) });
  }
}

export function create_fork_profile(
  request: ForkProfileRequest | undefined,
  emit: (line: string) => void,
  enabled = fork_profile_test,
  now?: () => number,
): ForkProfile | undefined {
  if (!enabled || !request) return undefined;
  return new ForkProfile(request, emit, now);
}

export function new_fork_profile_request(
  enabled = fork_profile_test,
): ForkProfileRequest | undefined {
  return enabled ? { id: crypto.randomUUID() } : undefined;
}
