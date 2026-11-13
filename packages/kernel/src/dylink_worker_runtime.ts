// SPDX-License-Identifier: MIT

import { ProcessDylink, type DylinkWorkerOwnerRollback } from "./dylink_process.ts";
import { DylinkWorkerPublicationAbort } from "./dylink_worker_abort.ts";
import {
  DylinkWorkerChannel,
  type DylinkWorkerChannelBuffers,
  type DylinkWorkerParticipant,
} from "./dylink_worker_channel.ts";
import { DylinkWorkerReceiver } from "./dylink_worker_receiver.ts";
import { DylinkWorkerWriter } from "./dylink_worker_writer.ts";
import type { DylinkWorkerSnapshot } from "./dylink_process_worker.ts";
import type { WasmAddress, WorkerCheckpointV2Status } from "./wasm.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export interface DylinkWorkerRuntimeOptions {
  shared: DylinkWorkerChannelBuffers;
  participant: DylinkWorkerParticipant;
  process: ProcessDylink;
  fatal(error: unknown): never;
  /** Wake parked Workers after a publication phase changes. */
  notify(): void;
  /** Bounded wait that does not reenter user code or the runtime service. */
  pause(): void;
  timeoutMs?: number;
}

/** @internal Coordinates one ProcessDylink participant's receiver and writer roles. */
export class DylinkWorkerRuntime {
  readonly #channel: DylinkWorkerChannel;
  readonly #participant: DylinkWorkerParticipant;
  readonly #process: ProcessDylink;
  readonly #fatalCallback: (error: unknown) => never;
  readonly #notify: () => void;
  readonly #pause: () => void;
  readonly #timeoutMs: number;
  readonly #receiver: DylinkWorkerReceiver;
  readonly #writer: DylinkWorkerWriter;
  #failed = false;
  #kernelCheckpointTransaction: number | null = null;
  #kernelCheckpointDeadline: number | null = null;

  constructor({
    shared,
    participant,
    process,
    fatal,
    notify,
    pause,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: DylinkWorkerRuntimeOptions) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new RangeError("Worker runtime timeout must be a finite positive number");

    this.#channel = DylinkWorkerChannel.attach(shared);
    this.#participant = participant;
    this.#process = process;
    this.#fatalCallback = fatal;
    this.#notify = notify;
    this.#pause = pause;
    this.#timeoutMs = timeoutMs;

    this.#receiver = new DylinkWorkerReceiver(
      this.#channel,
      this.#participant,
      this.#process,
      (error) => this.#fatal(error),
    );

    const serviceReceiver = () => {
      this.#assertHealthy();
      // Once this participant owns a producer transaction, it must not also
      // act as a receiver for that transaction. Other parked Workers service it.
      if (!this.#writer.active) this.checkpoint();
    };
    this.#writer = new DylinkWorkerWriter(
      this.#channel,
      this.#participant,
      this.#process,
      (error) => this.#fatal(error),
      this.#pause,
      this.#timeoutMs,
      this.#notify,
      serviceReceiver,
    );
  }

  /** Whether this participant is in an active producer transaction. */
  get writerActive(): boolean {
    return this.#writer.active;
  }

  /**
   * Process receiver phases at a stopped user checkpoint until this Worker
   * may safely resume. The callback runs trusted bookkeeping only.
   */
  checkpoint(): void {
    this.#assertHealthy();
    if (this.#writer.active) {
      this.#clearKernelCheckpoint();
      return;
    }

    const deadline = now() + this.#timeoutMs;
    try {
      this.#process.runAtWorkerCheckpoint(() => {
        for (;;) {
          if (this.#writer.active) return;
          const step = this.#receiver.step();
          if (step.kind === "idle" || step.kind === "building") {
            this.#clearKernelCheckpoint();
            return;
          }
          if (step.kind === "fatal")
            return this.#fatal(
              new Error(`Worker receiver failed in transaction ${step.transaction ?? "unknown"}`),
            );
          if (now() >= deadline)
            return this.#fatal(new Error("Worker receiver checkpoint deadline expired"));
          this.#pause();
        }
      });
    } catch (error) {
      if (this.#failed) throw error;
      this.#fatal(error);
    }
  }

  /**
   * Service one kernel checkpoint without waiting. Retained receiver state
   * remains parked until the writer finishes the publication barrier.
   */
  kernelCheckpointStep(): WorkerCheckpointV2Status {
    this.#assertHealthy();
    // The active owner cannot receive its own publication. Its transaction is
    // still a source for the kernel, but it must continue its existing work.
    if (this.#writer.active) {
      this.#clearKernelCheckpoint();
      return 1;
    }

    const stepStarted = now();
    let step: ReturnType<DylinkWorkerReceiver["step"]>;
    try {
      step = this.#process.runAtWorkerCheckpoint(() => this.#receiver.step());
    } catch (error) {
      if (this.#failed) throw error;
      this.#fatal(error);
    }

    if (step.kind === "fatal")
      return this.#fatal(
        new Error(`Worker receiver failed in transaction ${step.transaction ?? "unknown"}`),
      );
    if (step.kind === "idle") {
      this.#clearKernelCheckpoint();
      return 1;
    }
    if (step.kind === "building") {
      this.#clearKernelCheckpoint();
      return 1;
    }
    if (this.#receiver.hasPendingUserReturnBarrier) {
      this.#trackKernelCheckpointTransaction(this.#receiver.pendingTransaction, stepStarted);
      this.#checkKernelCheckpointDeadline();
      return 2;
    }
    this.#clearKernelCheckpoint();
    return 1;
  }

  /**
   * Report source availability while a JS guard forbids receiver work. This
   * observes only channel metadata and never acknowledges a phase.
   */
  kernelCheckpointDeferredStatus(): WorkerCheckpointV2Status {
    this.#assertHealthy();
    const observed = this.#channel.observe();
    if (!observed.ok) {
      if (this.#receiver.hasPendingUserReturnBarrier) {
        this.#trackKernelCheckpointTransaction(this.#receiver.pendingTransaction);
        this.#checkKernelCheckpointDeadline();
        return 2;
      }
      this.#clearKernelCheckpoint();
      // Defer channel errors until an unguarded receiver step can handle them.
      return 1;
    }
    if (observed.value.state === "idle") {
      this.#clearKernelCheckpoint();
      return 1;
    }
    if (
      this.#receiver.hasPendingUserReturnBarrier &&
      this.#receiver.pendingTransaction === observed.value.transaction
    ) {
      this.#trackKernelCheckpointTransaction(this.#receiver.pendingTransaction);
      this.#checkKernelCheckpointDeadline();
      return 2;
    }
    // A new writer can start only after all participants finished the old
    // barrier, so an idle or different transaction makes the old state terminal.
    this.#clearKernelCheckpoint();
    return 1;
  }

  /** Explicit producer entry for runtime integration; ordinary open routing remains unchanged. */
  open(path: WasmAddress, flags: number): WasmAddress {
    this.#assertHealthy();
    try {
      return this.#writer.open(path, flags);
    } catch (error) {
      if (this.#failed) throw error;
      this.#fatal(error);
    }
  }

  /** ProcessDylink beforeInitialize hook for the active owner publication. */
  beforeInitialize(
    snapshot: DylinkWorkerSnapshot,
    ownerRollback?: DylinkWorkerOwnerRollback,
  ): void {
    this.#assertHealthy();
    try {
      this.#writer.beforeInitialize(snapshot, ownerRollback);
    } catch (error) {
      if (error instanceof DylinkWorkerPublicationAbort) throw error;
      if (this.#failed) throw error;
      this.#fatal(error);
    }
  }

  #assertHealthy(): void {
    if (this.#failed) throw new Error("dynamic Worker runtime is already failed");
  }

  #clearKernelCheckpoint(): void {
    this.#kernelCheckpointTransaction = null;
    this.#kernelCheckpointDeadline = null;
  }

  #trackKernelCheckpointTransaction(transaction: number | null, startedAt = now()): void {
    if (transaction === null) return;
    if (this.#kernelCheckpointTransaction === transaction) return;
    this.#kernelCheckpointTransaction = transaction;
    this.#kernelCheckpointDeadline = startedAt + this.#timeoutMs;
  }

  #checkKernelCheckpointDeadline(): void {
    if (this.#kernelCheckpointDeadline !== null && now() >= this.#kernelCheckpointDeadline)
      this.#fatal(new Error("Worker receiver checkpoint deadline expired"));
  }

  #fatal(error: unknown): never {
    if (this.#failed) throw error;
    this.#failed = true;
    return this.#fatalCallback(error);
  }
}
