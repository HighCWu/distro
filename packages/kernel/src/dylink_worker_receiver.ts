// SPDX-License-Identifier: MIT

import {
  DylinkWorkerSnapshotError,
  type DylinkWorkerPublication,
} from "./dylink_process_worker.ts";
import {
  DylinkWorkerChannel,
  DylinkWorkerChannelError,
  type DylinkWorkerChannelPhase,
  type DylinkWorkerChannelState,
  type DylinkWorkerParticipant,
} from "./dylink_worker_channel.ts";
import type {
  DylinkWorkerExtensionCandidate,
  DylinkWorkerExtensionReceipt,
  ProcessDylink,
} from "./dylink_process.ts";
import { decode_dylink_worker_publication } from "./dylink_worker_transport.ts";

const EAGAIN = 11;
const EBUSY = 16;
const EIO = 5;
const ENOMEM = 12;
const EOPNOTSUPP = 95;
const EALREADY = 114;
const ESTALE = 116;

export type DylinkWorkerReceiverStep =
  | { kind: "idle"; generation: number; canResume: true }
  | { kind: "building"; generation: number; canResume: true }
  | { kind: "waiting"; transaction: number | null; phase: DylinkWorkerChannelState }
  | { kind: "phase-acked"; transaction: number; phase: DylinkWorkerChannelPhase }
  | { kind: "failure-reported"; transaction: number; phase: "prepare" | "commit"; errno: number }
  | { kind: "retry"; errno: number }
  | { kind: "fatal"; transaction: number | null };

type LocalFailure = { error: unknown; errno: number; reported: boolean };

type LocalTransaction = {
  transaction: number;
  candidate?: DylinkWorkerExtensionCandidate;
  receipt?: DylinkWorkerExtensionReceipt;
  prepareFailure?: LocalFailure;
  commitFailure?: LocalFailure;
  prepared: boolean;
  prepareAcked: boolean;
  committed: boolean;
  commitAcked: boolean;
  finalized: boolean;
  finalizeAcked: boolean;
  aborted: boolean;
  abortAcked: boolean;
};

function newTransaction(transaction: number): LocalTransaction {
  return {
    transaction,
    prepared: false,
    prepareAcked: false,
    committed: false,
    commitAcked: false,
    finalized: false,
    finalizeAcked: false,
    aborted: false,
    abortAcked: false,
  };
}

function errorErrno(error: unknown): number {
  if (error instanceof DylinkWorkerSnapshotError) {
    switch (error.code) {
      case "ENOMEM":
        return ENOMEM;
      case "EOPNOTSUPP":
        return EOPNOTSUPP;
      case "EINVAL":
        return 22;
    }
  }
  if (error instanceof DylinkWorkerChannelError) return Math.abs(error.errno);
  if (error instanceof RangeError) return ENOMEM;
  return EIO;
}

function toPhase(state: DylinkWorkerChannelState): DylinkWorkerChannelPhase | null {
  return state === "prepare" || state === "commit" || state === "finalize" || state === "abort"
    ? state
    : null;
}

/**
 * Synchronously advances one non-writer Worker at its safe point. The caller
 * must skip the designated writer participant and must not resume Wasm until
 * its acknowledged Finalize/Abort transaction has ended. A following Writing
 * lease allows execution while the owner releases resources or runs constructors.
 */
export class DylinkWorkerReceiver {
  readonly #channel: DylinkWorkerChannel;
  readonly #participant: DylinkWorkerParticipant;
  readonly #process: ProcessDylink;
  readonly #fatalCallback: (error: unknown) => void;
  #local: LocalTransaction | null = null;
  #fatalReported = false;

  constructor(
    channel: DylinkWorkerChannel,
    participant: DylinkWorkerParticipant,
    process: ProcessDylink,
    fatal: (error: unknown) => void,
  ) {
    this.#channel = channel;
    this.#participant = participant;
    this.#process = process;
    this.#fatalCallback = fatal;
  }

  step(): DylinkWorkerReceiverStep {
    const observed = this.#channel.observe();
    if (!observed.ok) {
      if (observed.errno === -EBUSY || observed.errno === -EAGAIN)
        return { kind: "retry", errno: -observed.errno };
      return this.#fatal(
        null,
        new DylinkWorkerChannelError(-observed.errno, "cannot observe Worker publication channel"),
      );
    }

    const state = observed.value.state;
    const transaction = observed.value.transaction;
    if (state === "poison")
      return this.#fatal(
        transaction,
        new DylinkWorkerChannelError(EIO, "Worker publication channel is poisoned"),
      );

    if (state === "idle") {
      if (this.#local && !this.#terminalAcknowledged(this.#local))
        return this.#fatal(
          this.#local.transaction,
          new Error("channel became Idle before receiver completed its transaction"),
        );
      this.#local = null;
      return { kind: "idle", generation: observed.value.generation, canResume: true };
    }

    if (transaction === null)
      return this.#fatal(null, new Error("active Worker transaction has no identity"));
    if (this.#local && this.#local.transaction !== transaction) {
      if (!this.#terminalAcknowledged(this.#local))
        return this.#fatal(
          transaction,
          new Error("receiver skipped an incomplete Worker transaction"),
        );
      this.#local = null;
    }

    if (state === "writing") {
      if (this.#local?.transaction === transaction && !this.#terminalAcknowledged(this.#local))
        return { kind: "waiting", transaction, phase: state };
      // The writer is still constructing an unpublished graph. This phase has
      // frozen the cohort, but it has not exposed new functions to this Worker.
      return { kind: "building", generation: observed.value.generation, canResume: true };
    }

    const phase = toPhase(state);
    if (!phase) return this.#fatal(transaction, new Error("invalid Worker transaction phase"));
    this.#local ??= newTransaction(transaction);

    switch (phase) {
      case "prepare":
        return this.#stepPrepare(this.#local);
      case "commit":
        return this.#stepCommit(this.#local);
      case "finalize":
        return this.#stepFinalize(this.#local);
      case "abort":
        return this.#stepAbort(this.#local);
    }
  }

  #stepPrepare(local: LocalTransaction): DylinkWorkerReceiverStep {
    if (local.prepareFailure) return this.#reportFailure(local, "prepare", local.prepareFailure);
    if (!local.prepared) {
      const packet = this.#channel.readPacket(this.#participant, local.transaction);
      if (!packet.ok) {
        if (packet.errno === -EBUSY || packet.errno === -EAGAIN)
          return { kind: "retry", errno: -packet.errno };
        local.prepareFailure = {
          error: new DylinkWorkerChannelError(-packet.errno, "cannot read publication packet"),
          errno: -packet.errno,
          reported: false,
        };
        return this.#reportFailure(local, "prepare", local.prepareFailure);
      }

      try {
        const publication = decode_dylink_worker_publication(
          packet.value,
        ) as DylinkWorkerPublication;
        local.candidate = this.#process.prepareWorkerExtension(publication);
        local.prepared = true;
      } catch (error) {
        local.prepareFailure = { error, errno: errorErrno(error), reported: false };
        return this.#reportFailure(local, "prepare", local.prepareFailure);
      }
    }
    return this.#ack(local, "prepare", "prepareAcked");
  }

  #stepCommit(local: LocalTransaction): DylinkWorkerReceiverStep {
    if (local.commitFailure) return this.#reportFailure(local, "commit", local.commitFailure);
    if (!local.committed) {
      if (!local.candidate)
        return this.#fatal(
          local.transaction,
          new Error("Commit arrived without a prepared ProcessDylink candidate"),
        );
      try {
        local.receipt = this.#process.commitWorkerExtensionProvisional(local.candidate);
        local.candidate = undefined;
        local.committed = true;
      } catch (error) {
        // ProcessDylink restores its own state if provisional commit throws.
        local.candidate = undefined;
        local.commitFailure = { error, errno: errorErrno(error), reported: false };
        return this.#reportFailure(local, "commit", local.commitFailure);
      }
    }
    return this.#ack(local, "commit", "commitAcked");
  }

  #stepFinalize(local: LocalTransaction): DylinkWorkerReceiverStep {
    if (!local.finalized) {
      if (!local.receipt)
        return this.#fatal(
          local.transaction,
          new Error("Finalize arrived without a provisional ProcessDylink receipt"),
        );
      try {
        this.#process.finalizeWorkerExtension(local.receipt);
        local.receipt = undefined;
        local.finalized = true;
      } catch (error) {
        return this.#fatal(local.transaction, error);
      }
    }
    const acknowledged = this.#ack(local, "finalize", "finalizeAcked");
    if (acknowledged.kind !== "phase-acked") return acknowledged;
    return this.#waitForBarrierFinish(local, "finalize");
  }

  #stepAbort(local: LocalTransaction): DylinkWorkerReceiverStep {
    if (!local.aborted) {
      try {
        if (local.receipt) {
          this.#process.rollbackWorkerExtension(local.receipt);
          local.receipt = undefined;
        }
        local.candidate = undefined;
        local.aborted = true;
      } catch (error) {
        return this.#fatal(local.transaction, error);
      }
    }
    const acknowledged = this.#ack(local, "abort", "abortAcked");
    if (acknowledged.kind !== "phase-acked") return acknowledged;
    return this.#waitForBarrierFinish(local, "abort");
  }

  #waitForBarrierFinish(
    local: LocalTransaction,
    phase: "finalize" | "abort",
  ): DylinkWorkerReceiverStep {
    const observed = this.#channel.observe();
    if (!observed.ok) {
      if (observed.errno === -EBUSY || observed.errno === -EAGAIN)
        return { kind: "retry", errno: -observed.errno };
      return this.#fatal(
        local.transaction,
        new DylinkWorkerChannelError(-observed.errno, "cannot observe barrier completion"),
      );
    }
    if (observed.value.state === "poison")
      return this.#fatal(
        local.transaction,
        new DylinkWorkerChannelError(EIO, "Worker publication channel is poisoned"),
      );
    if (observed.value.state === "idle") {
      this.#local = null;
      return { kind: "idle", generation: observed.value.generation, canResume: true };
    }
    if (observed.value.transaction !== local.transaction) {
      if (!this.#terminalAcknowledged(local))
        return this.#fatal(
          local.transaction,
          new Error("channel advanced before receiver completed its barrier"),
        );
      this.#local = null;
      if (observed.value.state === "writing")
        return { kind: "building", generation: observed.value.generation, canResume: true };
      return {
        kind: "waiting",
        transaction: observed.value.transaction,
        phase: observed.value.state,
      };
    }
    if (observed.value.state !== phase)
      return this.#fatal(
        local.transaction,
        new Error(`channel left ${phase} before the writer finished the barrier`),
      );
    return { kind: "waiting", transaction: local.transaction, phase };
  }

  #reportFailure(
    local: LocalTransaction,
    phase: "prepare" | "commit",
    failure: LocalFailure,
  ): DylinkWorkerReceiverStep {
    if (failure.reported)
      return {
        kind: "failure-reported",
        transaction: local.transaction,
        phase,
        errno: failure.errno,
      };
    const result = this.#channel.reportFailure(this.#participant, local.transaction, failure.errno);
    if (result.ok) {
      failure.reported = true;
      return {
        kind: "failure-reported",
        transaction: local.transaction,
        phase,
        errno: failure.errno,
      };
    }
    if (result.errno === -EBUSY || result.errno === -EAGAIN)
      return { kind: "retry", errno: -result.errno };
    if (result.errno === -ESTALE) return { kind: "retry", errno: ESTALE };
    return this.#fatal(
      local.transaction,
      new DylinkWorkerChannelError(-result.errno, "cannot report Worker receiver failure", {
        cause: failure.error,
      }),
    );
  }

  #ack(
    local: LocalTransaction,
    phase: DylinkWorkerChannelPhase,
    field: "prepareAcked" | "commitAcked" | "finalizeAcked" | "abortAcked",
  ): DylinkWorkerReceiverStep {
    if (!local[field]) {
      const result = this.#channel.ack(this.#participant, local.transaction, phase);
      if (result.ok || result.errno === -EALREADY) {
        local[field] = true;
      } else if (result.errno === -EBUSY || result.errno === -EAGAIN) {
        return { kind: "retry", errno: -result.errno };
      } else if (result.errno === -ESTALE) {
        const observed = this.#channel.observe();
        if (!observed.ok) return { kind: "retry", errno: -observed.errno };
        if (
          observed.value.transaction === local.transaction &&
          observed.value.state === "abort" &&
          phase !== "abort"
        )
          return { kind: "waiting", transaction: local.transaction, phase: "abort" };
        if (observed.value.transaction !== local.transaction || observed.value.state === "idle") {
          local[field] = true;
        } else {
          return this.#fatal(
            local.transaction,
            new DylinkWorkerChannelError(ESTALE, `stale ${phase} acknowledgement`),
          );
        }
      } else {
        return this.#fatal(
          local.transaction,
          new DylinkWorkerChannelError(-result.errno, `cannot acknowledge ${phase}`),
        );
      }
    }
    return { kind: "phase-acked", transaction: local.transaction, phase };
  }

  #terminalAcknowledged(local: LocalTransaction): boolean {
    return local.finalizeAcked || local.abortAcked;
  }

  #fatal(transaction: number | null, error: unknown): DylinkWorkerReceiverStep {
    if (!this.#fatalReported) {
      this.#fatalReported = true;
      this.#fatalCallback(error);
    }
    return { kind: "fatal", transaction };
  }
}
