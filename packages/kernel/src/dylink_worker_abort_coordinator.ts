// SPDX-License-Identifier: MIT

import {
  DylinkWorkerChannelError,
  type DylinkWorkerChannel,
  type DylinkWorkerParticipant,
  type DylinkWorkerReservation,
} from "./dylink_worker_channel.ts";

const EAGAIN = 11;
const EBUSY = 16;
const EIO = 5;
const EALREADY = 114;
const ESTALE = 116;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export interface DylinkWorkerAbortOptions {
  channel: DylinkWorkerChannel;
  writer: DylinkWorkerParticipant;
  reservation: DylinkWorkerReservation;
  /** Called after changing the phase and after releasing the barrier. */
  notify(): void;
  /** Bounded wait that lets peers run, without running user code or servicing this writer. */
  pause(): void;
  /** A cleanup deadline shared with the writer's recoverability check. */
  deadline: number;
  /** Pure owner-state restoration run before the cleanup lease becomes visible. */
  beforeRelease?: () => void;
}

export function createDylinkWorkerAbortDeadline(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("Worker abort timeout must be a finite positive number");
  const deadline = now() + timeoutMs;
  if (!Number.isFinite(deadline)) throw new Error("Worker abort deadline is invalid");
  return deadline;
}

/**
 * Complete the shared-channel half of a pre-Finalize rollback and return a
 * writer-only cleanup lease. The caller must retain that lease while releasing
 * owner allocations, then cancel it to expose Idle to later publishers.
 *
 * Owner state restoration is pure JS and runs under the channel lock as part of
 * the terminal-to-Writing handoff. Releasing user allocations remains the
 * caller's responsibility after the lock is released.
 */
export function coordinateDylinkWorkerAbort({
  channel,
  writer,
  reservation,
  notify,
  pause,
  deadline,
  beforeRelease,
}: DylinkWorkerAbortOptions): DylinkWorkerReservation {
  if (!Number.isFinite(deadline)) throw new Error("Worker abort deadline is invalid");
  const transaction = reservation.transaction;
  const generation = reservation.generation;
  const expired = () => now() >= deadline;
  const wait = () => {
    if (expired()) throw new Error("Worker abort cleanup deadline expired");
    pause();
    if (expired()) throw new Error("Worker abort cleanup deadline expired");
  };
  const observe = () => {
    for (;;) {
      if (expired()) throw new Error("Worker abort cleanup deadline expired");
      const result = channel.observe();
      if (!result.ok) {
        if (result.errno === -EBUSY || result.errno === -EAGAIN) {
          wait();
          continue;
        }
        throw new DylinkWorkerChannelError(-result.errno, "cannot observe Worker abort");
      }
      const value = result.value;
      if (value.state === "poison")
        throw new DylinkWorkerChannelError(
          EIO,
          "Worker publication channel was poisoned during abort",
        );
      if (value.transaction !== transaction || value.generation !== generation)
        throw new DylinkWorkerChannelError(
          ESTALE,
          "Worker abort transaction or generation changed",
        );
      return value;
    }
  };

  // A reservation that has not published a packet already excludes competing
  // publishers. Restore owner state while keeping that lease, then let the
  // caller release allocations before cancelling it.
  for (;;) {
    const current = observe();
    if (current.state === "abort") break;
    if (current.state === "writing") {
      beforeRelease?.();
      return reservation;
    }
    if (current.state !== "prepare" && current.state !== "commit")
      throw new DylinkWorkerChannelError(
        ESTALE,
        `cannot abort Worker publication in ${current.state}`,
      );
    const requested = channel.requestAbort(writer, transaction);
    if (requested.ok) break;
    if (requested.errno === -EBUSY || requested.errno === -EAGAIN) {
      wait();
      continue;
    }
    throw new DylinkWorkerChannelError(-requested.errno, "cannot request Worker publication abort");
  }

  // Wake parked receivers only after the shared state is Abort. Never invoke
  // the optional runtime service callback here: it could reenter this writer.
  notify();

  let writerAcked = false;
  for (;;) {
    const current = observe();
    if (current.state !== "abort")
      throw new DylinkWorkerChannelError(
        ESTALE,
        `Worker publication left Abort for ${current.state}`,
      );

    if (!writerAcked) {
      const ack = channel.ack(writer, transaction, "abort");
      if (ack.ok || ack.errno === -EALREADY) {
        writerAcked = true;
      } else if (ack.errno === -EBUSY || ack.errno === -EAGAIN) {
        wait();
        continue;
      } else {
        throw new DylinkWorkerChannelError(-ack.errno, "cannot acknowledge Worker abort");
      }
    }

    const finished = channel.finishAndReserve(writer, transaction, beforeRelease);
    if (!finished.ok) {
      if (finished.errno === -EBUSY || finished.errno === -EAGAIN) {
        wait();
        continue;
      }
      throw new DylinkWorkerChannelError(-finished.errno, "cannot finish Worker abort barrier");
    }
    if (finished.value.completion.committed || finished.value.completion.generation !== generation)
      throw new DylinkWorkerChannelError(EIO, "Worker abort changed the published generation");
    return finished.value.reservation;
  }
}
