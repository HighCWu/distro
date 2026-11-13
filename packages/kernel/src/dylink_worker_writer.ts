// SPDX-License-Identifier: MIT

import type { DylinkWorkerSnapshot } from "./dylink_process_worker.ts";
import { DylinkWorkerChannelError } from "./dylink_worker_channel.ts";
import { DylinkWorkerPublicationAbort } from "./dylink_worker_abort.ts";
import type {
  DylinkWorkerChannel,
  DylinkWorkerChannelObservation,
  DylinkWorkerParticipant,
  DylinkWorkerReservation,
} from "./dylink_worker_channel.ts";
import type { ProcessDylink, DylinkWorkerPublicationState } from "./dylink_process.ts";
import { create_dylink_worker_publication_delta } from "./dylink_worker_publication.ts";
import { encode_dylink_worker_publication } from "./dylink_worker_transport.ts";
import {
  coordinateDylinkWorkerAbort,
  createDylinkWorkerAbortDeadline,
} from "./dylink_worker_abort_coordinator.ts";
import type { WasmAddress } from "./wasm.ts";

const EAGAIN = 11;
const EBUSY = 16;
const EIO = 5;
const EALREADY = 114;

type ActivePublication = {
  readonly baseline: DylinkWorkerPublicationState;
  readonly reservation: DylinkWorkerReservation;
  readonly deadline: number;
  cleanupLease: DylinkWorkerReservation | null;
  hookEntered: boolean;
  completed: boolean;
  aborted: boolean;
  fataling: boolean;
};

/** Structural view of the ProcessDylink token owned by the open transaction. */
type OwnerRollback = {
  restore(): void;
  release(): void;
  commit(): void;
};

function channelFailure(errno: number, operation: string): DylinkWorkerChannelError {
  return new DylinkWorkerChannelError(Math.abs(errno), `Worker publication ${operation} failed`);
}

function publicationRollbackMessage(cause: unknown): string {
  try {
    if (cause instanceof Error) {
      const message = cause.message;
      if (typeof message === "string") return `Worker publication was rolled back: ${message}`;
    }
  } catch {
    // Rollback has completed; diagnostic formatting must not replace its result.
  }
  return "Worker publication was rolled back";
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Coordinates the owner side of one append-only dynamic Worker publication.
 * All waiting is synchronous at the caller's safe point; `pause` must not run
 * user code and normally performs a one millisecond Atomics.wait.
 */
export class DylinkWorkerWriter {
  readonly #channel: DylinkWorkerChannel;
  readonly #participant: DylinkWorkerParticipant;
  readonly #process: ProcessDylink;
  readonly #fatal: (error: unknown) => never;
  readonly #pause: () => void;
  readonly #service?: () => void;
  readonly #notify?: () => void;
  readonly #timeoutMs: number;
  #active: ActivePublication | null = null;

  get active(): boolean {
    return this.#active !== null;
  }

  constructor(
    channel: DylinkWorkerChannel,
    participant: DylinkWorkerParticipant,
    process: ProcessDylink,
    fatal: (error: unknown) => never,
    pause: () => void,
    timeoutMs = 30_000,
    notify?: () => void,
    service?: () => void,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new RangeError("Worker publication timeout must be a finite positive number");
    this.#channel = channel;
    this.#participant = participant;
    this.#process = process;
    this.#fatal = fatal;
    this.#pause = pause;
    this.#service = service;
    this.#notify = notify;
    this.#timeoutMs = timeoutMs;
  }

  /** Open a new replayable DSO under a frozen Worker cohort. */
  open(path: WasmAddress, flags: number): WasmAddress {
    if (this.#active)
      return this.#recordFailure(new Error("nested Worker publication open is not supported"));
    const deadline = now() + this.#timeoutMs;
    if (!Number.isFinite(deadline))
      return this.#invalidBaselineResult("Worker publication deadline is invalid");

    let baseline: DylinkWorkerPublicationState | null = null;
    let reservation: DylinkWorkerReservation | null = null;
    for (;;) {
      // A different publisher may finish while this open waits. Re-read the
      // process snapshot before every reservation attempt so the lease can
      // never be built against an older generation than the channel.
      try {
        baseline = this.#process.getWorkerPublicationState();
      } catch (error) {
        return this.#invalidBaselineResult("Worker publication baseline is unavailable", error);
      }
      if (!baseline)
        return this.#invalidBaselineResult("Worker publication baseline is unavailable");
      if (now() >= deadline)
        return this.#recordFailure(
          new Error("Worker publication timed out waiting for channel availability"),
        );

      const before = this.#channel.observe();
      if (!before.ok) {
        if (!this.#isTransient(before.errno))
          return this.#recordFailure(channelFailure(before.errno, "channel observation"));
        if (!this.#yieldForAvailability(deadline))
          return this.#recordFailure(
            new Error("Worker publication timed out waiting for channel availability"),
          );
        continue;
      }
      if (before.value.state === "poison")
        return this.#recordFailure(channelFailure(-EIO, "channel poison check"));
      if (before.value.state !== "idle" || before.value.generation !== baseline.generation) {
        if (!this.#yieldForAvailability(deadline))
          return this.#recordFailure(
            new Error("Worker publication timed out waiting for a matching channel generation"),
          );
        continue;
      }

      const reserved = this.#channel.reserve(this.#participant);
      if (!reserved.ok) {
        if (!this.#isTransient(reserved.errno))
          return this.#recordFailure(channelFailure(reserved.errno, "channel reservation"));
        if (!this.#yieldForAvailability(deadline))
          return this.#recordFailure(
            new Error("Worker publication timed out waiting for channel availability"),
          );
        continue;
      }
      reservation = reserved.value;
      if (reservation.generation !== baseline.generation) {
        this.#cancelReservation(reservation);
        reservation = null;
        if (!this.#yieldForAvailability(deadline))
          return this.#recordFailure(
            new Error("Worker publication timed out waiting for a matching channel generation"),
          );
        continue;
      }
      if (now() >= deadline) {
        this.#cancelReservation(reservation);
        return this.#recordFailure(
          new Error("Worker publication timed out after reserving the channel"),
        );
      }

      const after = this.#channel.observe();
      if (!after.ok) {
        this.#cancelReservation(reservation);
        reservation = null;
        if (!this.#isTransient(after.errno))
          return this.#recordFailure(channelFailure(after.errno, "channel observation"));
        if (!this.#yieldForAvailability(deadline))
          return this.#recordFailure(
            new Error("Worker publication timed out waiting for channel availability"),
          );
        continue;
      }
      if (
        after.value.state !== "writing" ||
        after.value.transaction !== reservation.transaction ||
        after.value.generation !== baseline.generation
      ) {
        this.#cancelReservation(reservation);
        return this.#recordFailure(
          new DylinkWorkerChannelError(
            116,
            "Worker publication reservation changed before confirmation",
          ),
        );
      }
      break;
    }

    // The retry loop establishes these non-null values before it exits.
    if (!baseline || !reservation)
      return this.#invalidBaselineResult("Worker publication reservation could not be established");

    const active: ActivePublication = {
      baseline,
      reservation,
      deadline,
      cleanupLease: null,
      hookEntered: false,
      completed: false,
      aborted: false,
      fataling: false,
    };
    this.#active = active;

    try {
      const result = this.#process.openWithWorkerPublication(
        path,
        flags,
        baseline.processIdentity,
        baseline.generation,
      );

      if (active.aborted) {
        if (BigInt(result) !== 0n)
          return this.#fatalActive(
            active,
            new Error("ProcessDylink returned a handle after publication rollback"),
          );
        active.completed = true;
        return result;
      }

      if (!active.hookEntered) {
        // Missing files, non-replayable modules, and already-open identities
        // fail before a graph commit. The cohort is still only reserved.
        this.#cancelReservation(reservation);
        return result;
      }
      if (!active.completed)
        return this.#fatalActive(
          active,
          new Error("owner returned before Worker publication reached Idle"),
        );
      if (BigInt(result) === 0n)
        return this.#fatalActive(
          active,
          new Error("owner failed after publishing a dynamic Worker graph"),
        );
      return result;
    } catch (error) {
      if (!active.hookEntered) {
        this.#cancelReservation(reservation);
        throw error;
      }
      // A recoverable abort is consumed by ProcessDylink and returns a null
      // handle above. Any other exception escaping the hook is an invariant
      // failure; this path also covers unexpected post-hook exceptions.
      if (active.fataling) throw error;
      if (active.completed) return this.#fatalActive(active, error);
      return this.#fatalActive(active, error);
    } finally {
      try {
        const cleanupLease = active.cleanupLease;
        if (!active.fataling && cleanupLease) {
          if (!active.completed)
            this.#fatalActive(
              active,
              new Error("Worker cleanup lease escaped before open completed"),
            );
          this.#cancelReservation(
            cleanupLease,
            createDylinkWorkerAbortDeadline(this.#timeoutMs),
            (error) => this.#fatalActive(active, error),
          );
          active.cleanupLease = null;
          this.#notifyWorkers();
        }
      } catch (error) {
        if (active.fataling) throw error;
        this.#fatalActive(active, error);
      } finally {
        if (this.#active === active) this.#active = null;
      }
    }
  }

  /** Synchronous ProcessDylink hook; inactive hooks are intentionally inert. */
  beforeInitialize(snapshot: DylinkWorkerSnapshot, ownerRollback?: OwnerRollback): void {
    const active = this.#active;
    if (!active) return;
    if (active.hookEntered)
      return this.#fatalActive(active, new Error("nested Worker publication initialization hook"));
    active.hookEntered = true;

    try {
      this.#assertDeadline(active);
      const publication = create_dylink_worker_publication_delta(
        active.baseline.snapshot,
        snapshot,
        active.baseline.processIdentity,
        active.baseline.generation,
      );
      const packet = encode_dylink_worker_publication(publication);
      this.#publish(active, packet);
      this.#notifyWorkers();

      this.#ackWriter(active, "prepare");
      this.#advance(active, "prepare", "commit");
      this.#notifyWorkers();

      // The owner has already linked the module locally. Advance its published
      // baseline only after every receiver prepared the same graph and before
      // any receiver is allowed to finalize or constructors may run.
      this.#process.advanceWorkerPublicationBeforeInitialize(
        active.baseline.processIdentity,
        active.baseline.generation,
        snapshot,
      );

      this.#ackWriter(active, "commit");
      this.#advance(active, "commit", "finalize");
      this.#notifyWorkers();
      this.#ackWriter(active, "finalize");
      const handoff = this.#finishAndReserve(active, () => ownerRollback?.commit());
      active.cleanupLease = handoff.reservation;
      const completion = handoff.completion;
      if (!completion.committed || completion.generation !== active.baseline.generation + 1)
        throw new Error("Worker publication completed with an unexpected generation");
      active.completed = true;
      this.#notifyWorkers();
    } catch (error) {
      if (active.completed) return this.#fatalActive(active, error);
      const abortDeadline = ownerRollback
        ? createDylinkWorkerAbortDeadline(this.#timeoutMs)
        : undefined;
      if (ownerRollback && abortDeadline !== undefined && this.#canRecover(active, abortDeadline)) {
        try {
          const cleanupLease = coordinateDylinkWorkerAbort({
            channel: this.#channel,
            writer: this.#participant,
            reservation: active.reservation,
            notify: () => this.#notifyWorkers(),
            pause: this.#pause,
            deadline: abortDeadline,
            beforeRelease: () => ownerRollback.restore(),
          });
          active.cleanupLease = cleanupLease;
          // The cleanup lease keeps competing publishers out while user-owned
          // allocations are released. Receivers may run, but can only observe
          // the temporary Writing state until release is complete.
          this.#notifyWorkers();
          ownerRollback.release();
          this.#cancelReservation(cleanupLease, abortDeadline, (error) => {
            throw error;
          });
          active.cleanupLease = null;
          this.#notifyWorkers();
          active.aborted = true;
        } catch (rollbackError) {
          return this.#fatalActive(
            active,
            new AggregateError(
              [error, rollbackError],
              "Worker publication abort could not restore a consistent process",
            ),
          );
        }
        throw new DylinkWorkerPublicationAbort(publicationRollbackMessage(error), error);
      }
      return this.#fatalActive(active, error);
    }
  }

  #canRecover(active: ActivePublication, deadline: number): boolean {
    for (;;) {
      if (now() >= deadline) return false;
      let observed: ReturnType<DylinkWorkerChannel["observe"]>;
      try {
        observed = this.#channel.observe();
      } catch {
        return false;
      }
      if (!observed.ok) {
        if (observed.errno !== -EBUSY && observed.errno !== -EAGAIN) return false;
        if (now() >= deadline) return false;
        try {
          this.#pause();
        } catch {
          return false;
        }
        continue;
      }
      const state = observed.value;
      if (
        state.state === "poison" ||
        state.transaction !== active.reservation.transaction ||
        state.generation !== active.baseline.generation
      )
        return false;
      return (
        state.state === "writing" ||
        state.state === "prepare" ||
        state.state === "commit" ||
        state.state === "abort"
      );
    }
  }

  #invalidBaselineResult(message: string, cause?: unknown): WasmAddress {
    if (cause !== undefined) return this.#process.recordWorkerPublicationFailure(cause, message);
    return this.#recordFailure(new Error(message));
  }

  #recordFailure(error: unknown): WasmAddress {
    return this.#process.recordWorkerPublicationFailure(error);
  }

  #assertDeadline(active: ActivePublication): void {
    if (now() >= active.deadline) throw new Error("Worker publication deadline expired");
  }

  #isTransient(errno: number): boolean {
    return errno === -EBUSY || errno === -EAGAIN;
  }

  /** Give admission/publication peers a chance to make progress before retrying. */
  #yieldForAvailability(deadline: number): boolean {
    if (now() >= deadline) return false;
    this.#service?.();
    if (now() >= deadline) return false;
    this.#pause();
    return now() < deadline;
  }

  #notifyWorkers(): void {
    this.#notify?.();
  }

  #publish(active: ActivePublication, packet: Uint8Array): void {
    for (;;) {
      this.#assertDeadline(active);
      const result = this.#channel.publish(active.reservation, packet);
      if (result.ok) return;
      if (result.errno === -EBUSY || result.errno === -EAGAIN) {
        this.#pauseUntilRetry(active);
        continue;
      }
      throw channelFailure(result.errno, "packet publication");
    }
  }

  #pauseUntilRetry(active: ActivePublication): void {
    this.#assertDeadline(active);
    this.#pause();
    this.#assertDeadline(active);
  }

  #observe(active: ActivePublication): DylinkWorkerChannelObservation {
    for (;;) {
      this.#assertDeadline(active);
      const observed = this.#channel.observe();
      if (!observed.ok) {
        if (observed.errno === -EBUSY || observed.errno === -EAGAIN) {
          this.#pauseUntilRetry(active);
          continue;
        }
        throw channelFailure(observed.errno, "observation");
      }
      const value = observed.value;
      if (value.state === "poison") throw channelFailure(-EIO, "channel poison check");
      if (value.failure)
        throw new DylinkWorkerChannelError(
          value.failure.errno,
          `Worker ${value.failure.participant.slot} rejected publication during ${value.state}`,
        );
      if (
        value.transaction !== active.reservation.transaction ||
        value.generation !== active.baseline.generation
      )
        throw new DylinkWorkerChannelError(
          116,
          "Worker publication transaction or generation changed",
        );
      return value;
    }
  }

  #ackWriter(active: ActivePublication, phase: "prepare" | "commit" | "finalize"): void {
    for (;;) {
      const observed = this.#observe(active);
      if (observed.state !== phase)
        throw new DylinkWorkerChannelError(
          116,
          `Worker publication left ${phase} before writer acknowledgement`,
        );
      const result = this.#channel.ack(this.#participant, active.reservation.transaction, phase);
      if (result.ok || result.errno === -EALREADY) return;
      if (result.errno === -EBUSY || result.errno === -EAGAIN) {
        this.#pauseUntilRetry(active);
        continue;
      }
      throw channelFailure(result.errno, `${phase} acknowledgement`);
    }
  }

  #advance(
    active: ActivePublication,
    phase: "prepare" | "commit",
    nextPhase: "commit" | "finalize",
  ): void {
    for (;;) {
      const observed = this.#observe(active);
      if (observed.state === nextPhase) return;
      if (observed.state !== phase)
        throw new DylinkWorkerChannelError(116, `Worker publication left ${phase} unexpectedly`);
      const result = this.#channel.advance(this.#participant, active.reservation.transaction);
      if (result.ok) {
        if (result.value !== nextPhase)
          throw new DylinkWorkerChannelError(
            EIO,
            `Worker publication advanced to ${result.value} unexpectedly`,
          );
        return;
      }
      if (result.errno === -EBUSY || result.errno === -EAGAIN) {
        this.#pauseUntilRetry(active);
        continue;
      }
      throw channelFailure(result.errno, `${phase} barrier advance`);
    }
  }

  #finishAndReserve(
    active: ActivePublication,
    beforeRelease?: () => void,
  ): {
    completion: { generation: number; committed: boolean };
    reservation: DylinkWorkerReservation;
  } {
    for (;;) {
      const observed = this.#observe(active);
      if (observed.state !== "finalize")
        throw new DylinkWorkerChannelError(
          116,
          "Worker publication left Finalize before completion",
        );
      const result = this.#channel.finishAndReserve(
        this.#participant,
        active.reservation.transaction,
        beforeRelease,
      );
      if (!result.ok) {
        if (result.errno === -EBUSY || result.errno === -EAGAIN) {
          this.#pauseUntilRetry(active);
          continue;
        }
        throw channelFailure(result.errno, "final barrier handoff");
      }
      return result.value;
    }
  }

  #cancelReservation(
    reservation: DylinkWorkerReservation,
    deadline = now() + this.#timeoutMs,
    fail: (error: unknown) => never = this.#fatal,
  ): void {
    for (;;) {
      if (now() >= deadline) fail(new Error("timed out cancelling a Worker writer lease"));
      const observed = this.#channel.observe();
      if (observed.ok && observed.value.state === "idle" && observed.value.transaction === null) {
        if (observed.value.generation !== reservation.generation)
          fail(
            new DylinkWorkerChannelError(
              116,
              "Worker generation changed while cancelling a reservation",
            ),
          );
        return;
      }
      if (
        observed.ok &&
        (observed.value.state !== "writing" ||
          observed.value.transaction !== reservation.transaction)
      )
        fail(
          new DylinkWorkerChannelError(116, "unpublished Worker reservation changed unexpectedly"),
        );
      const cancelled = this.#channel.cancelReservation(reservation);
      if (cancelled.ok) return;
      if (cancelled.errno !== -EBUSY && cancelled.errno !== -EAGAIN)
        fail(channelFailure(cancelled.errno, "reservation cancellation"));
      if (now() >= deadline) fail(new Error("timed out cancelling a Worker writer lease"));
      this.#pause();
    }
  }

  #fatalActive(active: ActivePublication, error: unknown): never {
    if (active.fataling) return this.#fatal(error);
    active.fataling = true;
    const reservation = active.cleanupLease ?? active.reservation;
    for (let attempt = 0; attempt < 100; attempt++) {
      const observed = this.#channel.observe();
      if (
        observed.ok &&
        (observed.value.state === "idle" ||
          observed.value.transaction !== reservation.transaction ||
          observed.value.state === "poison")
      )
        break;
      const poisoned = this.#channel.poison(this.#participant, reservation.transaction);
      if (poisoned.ok || poisoned.errno === -EALREADY) break;
      if (poisoned.errno !== -EBUSY && poisoned.errno !== -EAGAIN) break;
      this.#pause();
    }
    return this.#fatal(error);
  }
}
