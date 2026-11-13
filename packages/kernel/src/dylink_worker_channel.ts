// SPDX-License-Identifier: MIT

const MAGIC = 0x444c5743; // DLWC
const VERSION = 3;
const HEADER_WORDS = 16;
const SLOT_WORDS = 5;

const H_MAGIC = 0;
const H_VERSION = 1;
const H_CAPACITY = 2;
const H_MAX_WORKERS = 3;
const H_STATE = 4;
const H_LOCK = 5;
const H_TRANSACTION = 6;
const H_NEXT_TRANSACTION = 7;
const H_GENERATION = 8;
const H_LENGTH = 9;
const H_COHORT_COUNT = 10;
const H_WRITER_SLOT = 11;
const H_WRITER_EPOCH = 12;
const H_FIRST_FAILURE_SLOT = 13;
const H_ADMISSIONS = 14;

const S_ACTIVE = 0;
const S_EPOCH = 1;
const S_TRANSACTION = 2;
const S_ACK = 3;
const S_ERROR = 4;

const INACTIVE = 0;
const ACTIVE = 1;
const RETIRED = 2;
const PENDING_ADMISSION = 3;
const INVALID_SLOT = 0xffff_ffff;

const IDLE = 0;
const WRITING = 1;
const PUBLISHING = 2;
const PREPARE = 3;
const COMMIT = 4;
const FINALIZE = 5;
const ABORT = 6;
const POISON = 7;

const ERRNO = {
  EAGAIN: 11,
  EBUSY: 16,
  E2BIG: 7,
  EINVAL: 22,
  EIO: 5,
  ENOMEM: 12,
  ENOSPC: 28,
  EOPNOTSUPP: 95,
  EOVERFLOW: 75,
  ESTALE: 116,
  EALREADY: 114,
} as const;

export type DylinkWorkerChannelPhase = "prepare" | "commit" | "finalize" | "abort";
export type DylinkWorkerChannelState = "idle" | "writing" | DylinkWorkerChannelPhase | "poison";

export interface DylinkWorkerParticipant {
  readonly slot: number;
  readonly epoch: number;
}

/** A reserved participant slot awaiting successful Worker replay acknowledgement. */
export interface DylinkWorkerAdmissionToken extends DylinkWorkerParticipant {}

/** A writer lease captured before it builds a publication packet. */
export interface DylinkWorkerReservation {
  readonly owner: DylinkWorkerParticipant;
  readonly transaction: number;
  readonly generation: number;
  /** Present only for the owner-only lease held across user cleanup/constructors. */
  readonly cleanup?: true;
}

/** The only channel data that should be structured-cloned to another Worker. */
export interface DylinkWorkerChannelBuffers {
  control: SharedArrayBuffer;
  payload: SharedArrayBuffer;
}

export type DylinkWorkerChannelResult<T> = { ok: true; value: T } | { ok: false; errno: number };

export interface DylinkWorkerChannelObservation {
  state: DylinkWorkerChannelState;
  transaction: number | null;
  generation: number;
  packetLength: number;
  cohortSize: number;
  failure: { participant: DylinkWorkerParticipant; errno: number } | null;
}

export interface DylinkWorkerChannelCompletion {
  generation: number;
  committed: boolean;
}

export class DylinkWorkerChannelError extends Error {
  readonly errno: number;

  constructor(errno: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DylinkWorkerChannelError";
    this.errno = errno;
  }
}

function success<T>(value: T): DylinkWorkerChannelResult<T> {
  return { ok: true, value };
}

function failure<T = never>(errno: number): DylinkWorkerChannelResult<T> {
  return { ok: false, errno: -errno };
}

function stateName(state: number): DylinkWorkerChannelState | null {
  switch (state) {
    case IDLE:
      return "idle";
    case WRITING:
    case PUBLISHING:
      return "writing";
    case PREPARE:
      return "prepare";
    case COMMIT:
      return "commit";
    case FINALIZE:
      return "finalize";
    case ABORT:
      return "abort";
    case POISON:
      return "poison";
    default:
      return null;
  }
}

function phaseState(phase: DylinkWorkerChannelPhase): number {
  switch (phase) {
    case "prepare":
      return PREPARE;
    case "commit":
      return COMMIT;
    case "finalize":
      return FINALIZE;
    case "abort":
      return ABORT;
    default:
      return 0;
  }
}

function channelError(errno: number, message: string, cause?: unknown): never {
  throw new DylinkWorkerChannelError(errno, message, { cause });
}

function validateDimensions(capacityBytes: number, maxWorkers: number): void {
  if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 0 || capacityBytes > 0xffff_ffff)
    channelError(ERRNO.EINVAL, "Worker channel capacity is out of range");
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 0xffff_ffff)
    channelError(ERRNO.EINVAL, "Worker channel participant capacity is out of range");
  const controlBytes = (HEADER_WORDS + maxWorkers * SLOT_WORDS) * Uint32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(controlBytes) || controlBytes > 0x7fff_ffff)
    channelError(ERRNO.EINVAL, "Worker channel control buffer is too large");
}

function copyPacket(
  packet: Uint8Array,
  capacity: number,
): { packet: Uint8Array<ArrayBuffer> } | { errno: number } {
  if (!(packet instanceof Uint8Array)) return { errno: ERRNO.EINVAL };
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
  const offsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
  const lengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
  if (!bufferGetter || !offsetGetter || !lengthGetter) return { errno: ERRNO.EINVAL };

  try {
    const buffer = bufferGetter.call(packet) as ArrayBufferLike;
    const offset = offsetGetter.call(packet) as number;
    const length = lengthGetter.call(packet) as number;
    if (buffer instanceof SharedArrayBuffer) return { errno: ERRNO.EINVAL };
    if (length > capacity) return { errno: ERRNO.E2BIG };
    const source = new Uint8Array(buffer, offset, length);
    const owned = new Uint8Array(length);
    Uint8Array.prototype.set.call(owned, source);
    return { packet: owned };
  } catch (error) {
    return { errno: error instanceof RangeError ? ERRNO.ENOMEM : ERRNO.EINVAL };
  }
}

/**
 * A synchronous, clone-safe control channel for one dynamic Worker publication.
 * Callers provide retry/deadline policy; this class never waits or yields.
 */
export class DylinkWorkerChannel {
  readonly #control: SharedArrayBuffer;
  readonly #words: Uint32Array<SharedArrayBuffer>;
  readonly #payload: Uint8Array<SharedArrayBuffer>;
  readonly #capacityBytes: number;
  readonly #maxWorkers: number;

  /** Create a new channel, or attach to buffers received through structured clone. */
  constructor(capacityBytes: number, maxWorkers: number, shared?: DylinkWorkerChannelBuffers) {
    validateDimensions(capacityBytes, maxWorkers);
    this.#capacityBytes = capacityBytes;
    this.#maxWorkers = maxWorkers;

    if (typeof SharedArrayBuffer === "undefined")
      channelError(ERRNO.EOPNOTSUPP, "SharedArrayBuffer is unavailable");

    if (shared) {
      if (
        !(shared.control instanceof SharedArrayBuffer) ||
        !(shared.payload instanceof SharedArrayBuffer)
      )
        channelError(ERRNO.EINVAL, "Worker channel buffers must be SharedArrayBuffers");
      const expectedControlBytes =
        (HEADER_WORDS + maxWorkers * SLOT_WORDS) * Uint32Array.BYTES_PER_ELEMENT;
      if (
        shared.control.byteLength !== expectedControlBytes ||
        shared.payload.byteLength !== capacityBytes
      )
        channelError(
          ERRNO.EINVAL,
          "Worker channel buffer lengths do not match the requested dimensions",
        );
      this.#control = shared.control;
      this.#words = new Uint32Array(shared.control);
      this.#payload = new Uint8Array(shared.payload);
      if (
        Atomics.load(this.#words, H_MAGIC) !== MAGIC ||
        Atomics.load(this.#words, H_VERSION) !== VERSION ||
        Atomics.load(this.#words, H_CAPACITY) !== capacityBytes ||
        Atomics.load(this.#words, H_MAX_WORKERS) !== maxWorkers ||
        stateName(Atomics.load(this.#words, H_STATE)) === null
      )
        channelError(ERRNO.EINVAL, "Worker channel control buffer is invalid");
      return;
    }

    try {
      this.#control = new SharedArrayBuffer(
        (HEADER_WORDS + maxWorkers * SLOT_WORDS) * Uint32Array.BYTES_PER_ELEMENT,
      );
      this.#words = new Uint32Array(this.#control);
      this.#payload = new Uint8Array(new SharedArrayBuffer(capacityBytes));
    } catch (error) {
      channelError(ERRNO.ENOMEM, "cannot allocate Worker channel buffers", error);
    }

    Atomics.store(this.#words, H_MAGIC, MAGIC);
    Atomics.store(this.#words, H_VERSION, VERSION);
    Atomics.store(this.#words, H_CAPACITY, capacityBytes);
    Atomics.store(this.#words, H_MAX_WORKERS, maxWorkers);
    Atomics.store(this.#words, H_STATE, IDLE);
    Atomics.store(this.#words, H_LOCK, 0);
    Atomics.store(this.#words, H_TRANSACTION, 0);
    Atomics.store(this.#words, H_NEXT_TRANSACTION, 1);
    Atomics.store(this.#words, H_GENERATION, 0);
    Atomics.store(this.#words, H_LENGTH, 0);
    Atomics.store(this.#words, H_COHORT_COUNT, 0);
    Atomics.store(this.#words, H_WRITER_SLOT, INVALID_SLOT);
    Atomics.store(this.#words, H_WRITER_EPOCH, 0);
    Atomics.store(this.#words, H_FIRST_FAILURE_SLOT, INVALID_SLOT);
    Atomics.store(this.#words, H_ADMISSIONS, 0);
  }

  static attach(shared: DylinkWorkerChannelBuffers): DylinkWorkerChannel {
    if (
      !(shared?.control instanceof SharedArrayBuffer) ||
      shared.control.byteLength < HEADER_WORDS * 4
    )
      channelError(ERRNO.EINVAL, "Worker channel control buffer is invalid");
    const words = new Uint32Array(shared.control);
    const capacity = Atomics.load(words, H_CAPACITY);
    const maxWorkers = Atomics.load(words, H_MAX_WORKERS);
    return new DylinkWorkerChannel(capacity, maxWorkers, shared);
  }

  /** Return only the SAB references needed to attach in another Worker. */
  get shared(): DylinkWorkerChannelBuffers {
    return { control: this.#control, payload: this.#payload.buffer as SharedArrayBuffer };
  }

  #slotWord(slot: number, field: number): number {
    return HEADER_WORDS + slot * SLOT_WORDS + field;
  }

  #lock(): boolean {
    return Atomics.compareExchange(this.#words, H_LOCK, 0, 1) === 0;
  }

  #unlock(): void {
    Atomics.store(this.#words, H_LOCK, 0);
  }

  #tokenStatus(token: DylinkWorkerParticipant): number {
    if (
      token === null ||
      typeof token !== "object" ||
      !Number.isInteger(token.slot) ||
      !Number.isInteger(token.epoch) ||
      token.slot < 0 ||
      token.slot >= this.#maxWorkers ||
      token.epoch < 1 ||
      token.epoch > 0xffff_ffff
    )
      return -ERRNO.EINVAL;
    const active = Atomics.load(this.#words, this.#slotWord(token.slot, S_ACTIVE));
    const epoch = Atomics.load(this.#words, this.#slotWord(token.slot, S_EPOCH));
    if (active !== ACTIVE || epoch !== token.epoch) return -ERRNO.ESTALE;
    return 0;
  }

  #writerStatus(token: DylinkWorkerParticipant, transaction: number): number {
    const tokenStatus = this.#tokenStatus(token);
    if (tokenStatus !== 0) return tokenStatus;
    if (
      transaction === 0 ||
      transaction > 0xffff_ffff ||
      Atomics.load(this.#words, H_TRANSACTION) !== transaction ||
      Atomics.load(this.#words, H_WRITER_SLOT) !== token.slot ||
      Atomics.load(this.#words, H_WRITER_EPOCH) !== token.epoch
    )
      return -ERRNO.ESTALE;
    return 0;
  }

  #reservationStatus(reservation: DylinkWorkerReservation): number {
    if (
      reservation === null ||
      typeof reservation !== "object" ||
      (reservation.cleanup !== undefined && reservation.cleanup !== true) ||
      !Number.isInteger(reservation.generation) ||
      reservation.generation < 0 ||
      reservation.generation > 0xffff_ffff
    )
      return -ERRNO.EINVAL;
    const writerStatus = this.#writerStatus(reservation.owner, reservation.transaction);
    if (writerStatus !== 0) return writerStatus;
    if (Atomics.load(this.#words, H_GENERATION) !== reservation.generation) return -ERRNO.ESTALE;
    return 0;
  }

  /** writerOnly is used solely by finishAndReserve for owner cleanup leases. */
  #reserveLocked(
    writer: DylinkWorkerParticipant,
    expectedState = IDLE,
    writerOnly = false,
  ): DylinkWorkerChannelResult<number> {
    const state = Atomics.load(this.#words, H_STATE);
    if (state === POISON) return failure(ERRNO.EOPNOTSUPP);
    if (stateName(state) === null) {
      Atomics.store(this.#words, H_STATE, POISON);
      return failure(ERRNO.EIO);
    }
    if (state !== expectedState) return failure(ERRNO.EBUSY);
    if (Atomics.load(this.#words, H_ADMISSIONS) !== 0) return failure(ERRNO.EBUSY);
    const tokenStatus = this.#tokenStatus(writer);
    if (tokenStatus !== 0) return failure(-tokenStatus);

    const transaction = Atomics.load(this.#words, H_NEXT_TRANSACTION);
    if (transaction === 0) {
      Atomics.store(this.#words, H_STATE, POISON);
      return failure(ERRNO.EOVERFLOW);
    }
    if (Atomics.compareExchange(this.#words, H_STATE, expectedState, WRITING) !== expectedState)
      return failure(ERRNO.EBUSY);

    Atomics.store(this.#words, H_TRANSACTION, transaction);
    Atomics.store(
      this.#words,
      H_NEXT_TRANSACTION,
      transaction === 0xffff_ffff ? 0 : transaction + 1,
    );
    Atomics.store(this.#words, H_WRITER_SLOT, writer.slot);
    Atomics.store(this.#words, H_WRITER_EPOCH, writer.epoch);
    Atomics.store(this.#words, H_LENGTH, 0);
    Atomics.store(this.#words, H_FIRST_FAILURE_SLOT, INVALID_SLOT);

    let cohortCount = 0;
    for (let slot = 0; slot < this.#maxWorkers; slot++) {
      const active = Atomics.load(this.#words, this.#slotWord(slot, S_ACTIVE)) === ACTIVE;
      if (writerOnly) {
        Atomics.store(this.#words, this.#slotWord(slot, S_TRANSACTION), 0);
        Atomics.store(this.#words, this.#slotWord(slot, S_ACK), 0);
        Atomics.store(this.#words, this.#slotWord(slot, S_ERROR), 0);
      }
      if (!active || (writerOnly && slot !== writer.slot)) continue;
      Atomics.store(this.#words, this.#slotWord(slot, S_TRANSACTION), transaction);
      Atomics.store(this.#words, this.#slotWord(slot, S_ACK), 0);
      Atomics.store(this.#words, this.#slotWord(slot, S_ERROR), 0);
      cohortCount++;
    }
    if (cohortCount === 0) {
      Atomics.store(this.#words, H_STATE, POISON);
      return failure(ERRNO.EIO);
    }
    Atomics.store(this.#words, H_COHORT_COUNT, cohortCount);
    return success(transaction);
  }

  #publishBytes(
    transaction: number,
    packet: Uint8Array<ArrayBuffer>,
  ): DylinkWorkerChannelResult<void> {
    try {
      this.#payload.set(packet);
    } catch {
      Atomics.store(this.#words, H_LENGTH, 0);
      Atomics.compareExchange(this.#words, H_STATE, PUBLISHING, WRITING);
      return failure(ERRNO.EIO);
    }
    Atomics.store(this.#words, H_LENGTH, packet.byteLength);
    if (Atomics.load(this.#words, H_TRANSACTION) !== transaction) {
      Atomics.store(this.#words, H_STATE, POISON);
      return failure(ERRNO.EIO);
    }
    if (Atomics.compareExchange(this.#words, H_STATE, PUBLISHING, PREPARE) !== PUBLISHING)
      return failure(ERRNO.EIO);
    return success(undefined);
  }

  #allAcknowledged(transaction: number, phase: number): boolean | null {
    let found = 0;
    for (let slot = 0; slot < this.#maxWorkers; slot++) {
      if (Atomics.load(this.#words, this.#slotWord(slot, S_TRANSACTION)) !== transaction) continue;
      found++;
      if (Atomics.load(this.#words, this.#slotWord(slot, S_ACTIVE)) !== ACTIVE) return null;
      if (phase !== ABORT && Atomics.load(this.#words, this.#slotWord(slot, S_ERROR)) !== 0)
        return false;
      if (Atomics.load(this.#words, this.#slotWord(slot, S_ACK)) !== phase) return false;
    }
    return found !== 0 && found === Atomics.load(this.#words, H_COHORT_COUNT);
  }

  #clearAcknowledgements(transaction: number): boolean {
    let found = 0;
    for (let slot = 0; slot < this.#maxWorkers; slot++) {
      if (Atomics.load(this.#words, this.#slotWord(slot, S_TRANSACTION)) !== transaction) continue;
      found++;
      Atomics.store(this.#words, this.#slotWord(slot, S_ACK), 0);
    }
    return found === Atomics.load(this.#words, H_COHORT_COUNT) && found !== 0;
  }

  register(): DylinkWorkerChannelResult<DylinkWorkerParticipant> {
    if (!this.#lock()) return failure(ERRNO.EBUSY);
    try {
      const state = Atomics.load(this.#words, H_STATE);
      if (state === POISON) return failure(ERRNO.EOPNOTSUPP);
      if (stateName(state) === null) {
        Atomics.store(this.#words, H_STATE, POISON);
        return failure(ERRNO.EIO);
      }
      if (state !== IDLE) return failure(ERRNO.EBUSY);
      if (Atomics.load(this.#words, H_ADMISSIONS) !== 0) return failure(ERRNO.EBUSY);

      for (let slot = 0; slot < this.#maxWorkers; slot++) {
        const active = Atomics.load(this.#words, this.#slotWord(slot, S_ACTIVE));
        if (active === RETIRED) continue;
        if (active !== INACTIVE) continue;
        let epoch = Atomics.load(this.#words, this.#slotWord(slot, S_EPOCH));
        if (epoch === 0) epoch = 1;
        Atomics.store(this.#words, this.#slotWord(slot, S_EPOCH), epoch);
        Atomics.store(this.#words, this.#slotWord(slot, S_TRANSACTION), 0);
        Atomics.store(this.#words, this.#slotWord(slot, S_ACK), 0);
        Atomics.store(this.#words, this.#slotWord(slot, S_ERROR), 0);
        Atomics.store(this.#words, this.#slotWord(slot, S_ACTIVE), ACTIVE);
        return success(Object.freeze({ slot, epoch }));
      }
      return failure(ERRNO.ENOSPC);
    } finally {
      this.#unlock();
    }
  }

  /** Reserve a non-live slot while a child Worker reconstructs the current graph. */
  beginAdmission(): DylinkWorkerChannelResult<DylinkWorkerAdmissionToken> {
    if (!this.#lock()) return failure(ERRNO.EBUSY);
    try {
      const state = Atomics.load(this.#words, H_STATE);
      if (state === POISON) return failure(ERRNO.EOPNOTSUPP);
      if (stateName(state) === null) {
        Atomics.store(this.#words, H_STATE, POISON);
        return failure(ERRNO.EIO);
      }
      if (state !== IDLE) return failure(ERRNO.EBUSY);

      const pending = Atomics.load(this.#words, H_ADMISSIONS);
      if (pending >= this.#maxWorkers) return failure(ERRNO.ENOSPC);
      for (let slot = 0; slot < this.#maxWorkers; slot++) {
        if (Atomics.load(this.#words, this.#slotWord(slot, S_ACTIVE)) !== INACTIVE) continue;
        let epoch = Atomics.load(this.#words, this.#slotWord(slot, S_EPOCH));
        if (epoch === 0) epoch = 1;
        Atomics.store(this.#words, this.#slotWord(slot, S_EPOCH), epoch);
        Atomics.store(this.#words, this.#slotWord(slot, S_TRANSACTION), 0);
        Atomics.store(this.#words, this.#slotWord(slot, S_ACK), 0);
        Atomics.store(this.#words, this.#slotWord(slot, S_ERROR), 0);
        Atomics.store(this.#words, this.#slotWord(slot, S_ACTIVE), PENDING_ADMISSION);
        Atomics.store(this.#words, H_ADMISSIONS, pending + 1);
        return success(Object.freeze({ slot, epoch }));
      }
      return failure(ERRNO.ENOSPC);
    } finally {
      this.#unlock();
    }
  }

  /** Make an admitted child a live transaction participant after replay succeeds. */
  completeAdmission(
    token: DylinkWorkerAdmissionToken,
  ): DylinkWorkerChannelResult<DylinkWorkerParticipant> {
    if (!this.#lock()) return failure(ERRNO.EBUSY);
    try {
      const tokenStatus = this.#admissionStatus(token);
      if (tokenStatus !== 0) return failure(-tokenStatus);

      const state = Atomics.load(this.#words, H_STATE);
      if (state === POISON) return failure(ERRNO.EOPNOTSUPP);
      if (stateName(state) === null) {
        Atomics.store(this.#words, H_STATE, POISON);
        return failure(ERRNO.EIO);
      }
      if (state !== IDLE) return failure(ERRNO.EBUSY);

      const pending = Atomics.load(this.#words, H_ADMISSIONS);
      if (pending === 0) {
        Atomics.store(this.#words, H_STATE, POISON);
        return failure(ERRNO.EIO);
      }
      Atomics.store(this.#words, this.#slotWord(token.slot, S_ACTIVE), ACTIVE);
      Atomics.store(this.#words, H_ADMISSIONS, pending - 1);
      return success(Object.freeze({ slot: token.slot, epoch: token.epoch }));
    } finally {
      this.#unlock();
    }
  }

  /** Cancel an uninitialized or exited child admission and retire its token epoch. */
  cancelAdmission(token: DylinkWorkerAdmissionToken): DylinkWorkerChannelResult<void> {
    if (!this.#lock()) return failure(ERRNO.EBUSY);
    try {
      const tokenStatus = this.#admissionStatus(token);
      if (tokenStatus !== 0) return failure(-tokenStatus);

      const pending = Atomics.load(this.#words, H_ADMISSIONS);
      if (pending === 0) {
        Atomics.store(this.#words, H_STATE, POISON);
        return failure(ERRNO.EIO);
      }
      const epoch = token.epoch;
      if (epoch === 0xffff_ffff) {
        Atomics.store(this.#words, this.#slotWord(token.slot, S_ACTIVE), RETIRED);
      } else {
        Atomics.store(this.#words, this.#slotWord(token.slot, S_EPOCH), epoch + 1);
        Atomics.store(this.#words, this.#slotWord(token.slot, S_ACTIVE), INACTIVE);
      }
      Atomics.store(this.#words, this.#slotWord(token.slot, S_TRANSACTION), 0);
      Atomics.store(this.#words, this.#slotWord(token.slot, S_ACK), 0);
      Atomics.store(this.#words, this.#slotWord(token.slot, S_ERROR), 0);
      Atomics.store(this.#words, H_ADMISSIONS, pending - 1);
      return success(undefined);
    } finally {
      this.#unlock();
    }
  }

  #admissionStatus(token: DylinkWorkerAdmissionToken): number {
    if (
      token === null ||
      typeof token !== "object" ||
      !Number.isInteger(token.slot) ||
      !Number.isInteger(token.epoch) ||
      token.slot < 0 ||
      token.slot >= this.#maxWorkers ||
      token.epoch < 1 ||
      token.epoch > 0xffff_ffff
    )
      return -ERRNO.EINVAL;
    if (
      Atomics.load(this.#words, this.#slotWord(token.slot, S_ACTIVE)) !== PENDING_ADMISSION ||
      Atomics.load(this.#words, this.#slotWord(token.slot, S_EPOCH)) !== token.epoch
    )
      return -ERRNO.ESTALE;
    return 0;
  }

  unregister(token: DylinkWorkerParticipant): DylinkWorkerChannelResult<void> {
    if (!this.#lock()) return failure(ERRNO.EBUSY);
    try {
      const state = Atomics.load(this.#words, H_STATE);
      if (state === POISON) return failure(ERRNO.EOPNOTSUPP);
      if (stateName(state) === null) {
        Atomics.store(this.#words, H_STATE, POISON);
        return failure(ERRNO.EIO);
      }
      if (state !== IDLE && state !== WRITING) return failure(ERRNO.EBUSY);
      const status = this.#tokenStatus(token);
      if (status !== 0) return failure(-status);
      if (state === WRITING) {
        const transaction = Atomics.load(this.#words, H_TRANSACTION);
        const writerSlot = Atomics.load(this.#words, H_WRITER_SLOT);
        const writerEpoch = Atomics.load(this.#words, H_WRITER_EPOCH);
        if (
          transaction === 0 ||
          writerSlot >= this.#maxWorkers ||
          writerEpoch === 0 ||
          this.#tokenStatus({ slot: writerSlot, epoch: writerEpoch }) !== 0
        ) {
          Atomics.store(this.#words, H_STATE, POISON);
          return failure(ERRNO.EIO);
        }
        if (
          (token.slot === writerSlot && token.epoch === writerEpoch) ||
          Atomics.load(this.#words, this.#slotWord(token.slot, S_TRANSACTION)) === transaction
        )
          return failure(ERRNO.EBUSY);
      }

      const epoch = token.epoch;
      if (epoch === 0xffff_ffff) {
        Atomics.store(this.#words, this.#slotWord(token.slot, S_ACTIVE), RETIRED);
      } else {
        Atomics.store(this.#words, this.#slotWord(token.slot, S_EPOCH), epoch + 1);
        Atomics.store(this.#words, this.#slotWord(token.slot, S_ACTIVE), INACTIVE);
      }
      return success(undefined);
    } finally {
      this.#unlock();
    }
  }

  /** Reserve the sole writer lease and freeze the current participant cohort. */
  reserve(writer: DylinkWorkerParticipant): DylinkWorkerChannelResult<DylinkWorkerReservation> {
    const owner = Object.freeze({ slot: writer.slot, epoch: writer.epoch });
    if (!this.#lock()) return failure(ERRNO.EBUSY);
    try {
      const reservation = this.#reserveLocked(owner);
      if (!reservation.ok) return reservation;
      return success(
        Object.freeze({
          owner,
          transaction: reservation.value,
          generation: Atomics.load(this.#words, H_GENERATION),
        }),
      );
    } finally {
      this.#unlock();
    }
  }

  /** Publish the complete frozen packet after the owner finishes constructing it. */
  publish(
    reservation: DylinkWorkerReservation,
    packet: Uint8Array,
  ): DylinkWorkerChannelResult<void> {
    if (reservation?.cleanup === true) return failure(ERRNO.EINVAL);
    const copiedPacket = copyPacket(packet, this.#capacityBytes);
    if ("errno" in copiedPacket) return failure(copiedPacket.errno);
    if (!this.#lock()) return failure(ERRNO.EBUSY);
    try {
      const status = this.#reservationStatus(reservation);
      if (status !== 0) return failure(-status);
      const state = Atomics.load(this.#words, H_STATE);
      if (state !== WRITING) return failure(state === PUBLISHING ? ERRNO.EBUSY : ERRNO.ESTALE);
      Atomics.store(this.#words, H_STATE, PUBLISHING);
    } finally {
      this.#unlock();
    }
    return this.#publishBytes(reservation.transaction, copiedPacket.packet);
  }

  /** Release an unpublished reservation after graph construction fails. */
  cancelReservation(reservation: DylinkWorkerReservation): DylinkWorkerChannelResult<void> {
    if (!this.#lock()) return failure(ERRNO.EBUSY);
    try {
      const status = this.#reservationStatus(reservation);
      if (status !== 0) return failure(-status);
      const state = Atomics.load(this.#words, H_STATE);
      if (state !== WRITING) return failure(state === PUBLISHING ? ERRNO.EBUSY : ERRNO.ESTALE);
      const transaction = reservation.transaction;
      let found = 0;
      for (let slot = 0; slot < this.#maxWorkers; slot++) {
        if (Atomics.load(this.#words, this.#slotWord(slot, S_TRANSACTION)) !== transaction)
          continue;
        found++;
        Atomics.store(this.#words, this.#slotWord(slot, S_TRANSACTION), 0);
        Atomics.store(this.#words, this.#slotWord(slot, S_ACK), 0);
        Atomics.store(this.#words, this.#slotWord(slot, S_ERROR), 0);
      }
      if (found === 0 || found !== Atomics.load(this.#words, H_COHORT_COUNT)) {
        Atomics.store(this.#words, H_STATE, POISON);
        return failure(ERRNO.EIO);
      }
      Atomics.store(this.#words, H_TRANSACTION, 0);
      Atomics.store(this.#words, H_LENGTH, 0);
      Atomics.store(this.#words, H_COHORT_COUNT, 0);
      Atomics.store(this.#words, H_WRITER_SLOT, INVALID_SLOT);
      Atomics.store(this.#words, H_WRITER_EPOCH, 0);
      Atomics.store(this.#words, H_FIRST_FAILURE_SLOT, INVALID_SLOT);
      Atomics.store(this.#words, H_STATE, IDLE);
      return success(undefined);
    } finally {
      this.#unlock();
    }
  }

  /** Backwards-compatible one-shot reservation and publication. */
  begin(writer: DylinkWorkerParticipant, packet: Uint8Array): DylinkWorkerChannelResult<number> {
    const copiedPacket = copyPacket(packet, this.#capacityBytes);
    if ("errno" in copiedPacket) return failure(copiedPacket.errno);
    if (!this.#lock()) return failure(ERRNO.EBUSY);
    let transaction = 0;
    try {
      const reservation = this.#reserveLocked(writer);
      if (!reservation.ok) return reservation;
      transaction = reservation.value;
      Atomics.store(this.#words, H_STATE, PUBLISHING);
    } finally {
      this.#unlock();
    }
    const published = this.#publishBytes(transaction, copiedPacket.packet);
    if (published.ok) return success(transaction);
    if (Atomics.load(this.#words, H_STATE) === WRITING) {
      const reservation = {
        owner: writer,
        transaction,
        generation: Atomics.load(this.#words, H_GENERATION),
      };
      this.cancelReservation(reservation);
    }
    return failure(-published.errno);
  }

  observe(): DylinkWorkerChannelResult<DylinkWorkerChannelObservation> {
    if (!this.#lock()) return failure(ERRNO.EBUSY);
    try {
      const stateCode = Atomics.load(this.#words, H_STATE);
      const state = stateName(stateCode);
      if (state === null) {
        Atomics.store(this.#words, H_STATE, POISON);
        return failure(ERRNO.EIO);
      }
      const active = stateCode !== IDLE && stateCode !== POISON;
      return success({
        state,
        transaction: stateCode !== IDLE ? Atomics.load(this.#words, H_TRANSACTION) : null,
        generation: Atomics.load(this.#words, H_GENERATION),
        packetLength:
          stateCode >= PREPARE && stateCode <= ABORT ? Atomics.load(this.#words, H_LENGTH) : 0,
        cohortSize: active ? Atomics.load(this.#words, H_COHORT_COUNT) : 0,
        failure: this.#firstFailure(
          stateCode === IDLE ? 0 : Atomics.load(this.#words, H_TRANSACTION),
        ),
      });
    } finally {
      this.#unlock();
    }
  }

  #firstFailure(transaction: number): DylinkWorkerChannelObservation["failure"] {
    if (transaction === 0) return null;
    const slot = Atomics.load(this.#words, H_FIRST_FAILURE_SLOT);
    if (
      slot === INVALID_SLOT ||
      slot >= this.#maxWorkers ||
      Atomics.load(this.#words, this.#slotWord(slot, S_TRANSACTION)) !== transaction
    )
      return null;
    const errno = Atomics.load(this.#words, this.#slotWord(slot, S_ERROR));
    if (errno === 0) return null;
    return {
      participant: { slot, epoch: Atomics.load(this.#words, this.#slotWord(slot, S_EPOCH)) },
      errno,
    };
  }

  /** Copy the current immutable packet for a cohort member. */
  readPacket(
    participant: DylinkWorkerParticipant,
    transaction: number,
  ): DylinkWorkerChannelResult<Uint8Array<ArrayBuffer>> {
    if (!this.#lock()) return failure(ERRNO.EBUSY);
    try {
      const tokenStatus = this.#tokenStatus(participant);
      if (tokenStatus !== 0) return failure(-tokenStatus);
      const state = Atomics.load(this.#words, H_STATE);
      if (state === POISON) return failure(ERRNO.EOPNOTSUPP);
      if (
        state < PREPARE ||
        state > ABORT ||
        Atomics.load(this.#words, H_TRANSACTION) !== transaction
      )
        return failure(ERRNO.ESTALE);
      if (
        Atomics.load(this.#words, this.#slotWord(participant.slot, S_TRANSACTION)) !== transaction
      )
        return failure(ERRNO.ESTALE);

      const length = Atomics.load(this.#words, H_LENGTH);
      if (length > this.#capacityBytes) {
        Atomics.store(this.#words, H_STATE, POISON);
        return failure(ERRNO.EIO);
      }
      try {
        const owned = new Uint8Array(length);
        Uint8Array.prototype.set.call(owned, this.#payload.subarray(0, length));
        return success(owned);
      } catch {
        return failure(ERRNO.ENOMEM);
      }
    } finally {
      this.#unlock();
    }
  }

  /** A contended control lock returns -EBUSY; callers retry at their checkpoint. */
  ack(
    participant: DylinkWorkerParticipant,
    transaction: number,
    phase: DylinkWorkerChannelPhase,
  ): DylinkWorkerChannelResult<void> {
    if (!this.#lock()) return failure(ERRNO.EBUSY);
    try {
      const tokenStatus = this.#tokenStatus(participant);
      if (tokenStatus !== 0) return failure(-tokenStatus);
      const phaseCode = phaseState(phase);
      if (phaseCode === 0) return failure(ERRNO.EINVAL);
      if (
        Atomics.load(this.#words, H_STATE) !== phaseCode ||
        Atomics.load(this.#words, H_TRANSACTION) !== transaction
      )
        return failure(ERRNO.ESTALE);
      const slot = participant.slot;
      if (Atomics.load(this.#words, this.#slotWord(slot, S_TRANSACTION)) !== transaction)
        return failure(ERRNO.ESTALE);
      if (
        (phaseCode === PREPARE || phaseCode === COMMIT) &&
        Atomics.load(this.#words, this.#slotWord(slot, S_ERROR)) !== 0
      )
        return failure(ERRNO.EALREADY);
      const ack = Atomics.load(this.#words, this.#slotWord(slot, S_ACK));
      if (ack === phaseCode) return failure(ERRNO.EALREADY);
      if (ack !== 0) {
        Atomics.store(this.#words, H_STATE, POISON);
        return failure(ERRNO.EIO);
      }
      Atomics.store(this.#words, this.#slotWord(slot, S_ACK), phaseCode);
      return success(undefined);
    } finally {
      this.#unlock();
    }
  }

  /** Record a participant's first recoverable Prepare/Commit failure. */
  reportFailure(
    participant: DylinkWorkerParticipant,
    transaction: number,
    errno: number,
  ): DylinkWorkerChannelResult<void> {
    if (!Number.isInteger(errno) || errno < 1 || errno > 4095) return failure(ERRNO.EINVAL);
    if (!this.#lock()) return failure(ERRNO.EBUSY);
    try {
      const tokenStatus = this.#tokenStatus(participant);
      if (tokenStatus !== 0) return failure(-tokenStatus);
      const state = Atomics.load(this.#words, H_STATE);
      if (state !== PREPARE && state !== COMMIT) return failure(ERRNO.ESTALE);
      if (
        Atomics.load(this.#words, H_TRANSACTION) !== transaction ||
        Atomics.load(this.#words, this.#slotWord(participant.slot, S_TRANSACTION)) !== transaction
      )
        return failure(ERRNO.ESTALE);
      const errorIndex = this.#slotWord(participant.slot, S_ERROR);
      if (Atomics.load(this.#words, errorIndex) === 0)
        Atomics.store(this.#words, errorIndex, errno);
      Atomics.compareExchange(this.#words, H_FIRST_FAILURE_SLOT, INVALID_SLOT, participant.slot);
      return success(undefined);
    } finally {
      this.#unlock();
    }
  }

  /** Advance Prepare→Commit or Commit→Finalize after every cohort ack. */
  advance(
    writer: DylinkWorkerParticipant,
    transaction: number,
  ): DylinkWorkerChannelResult<DylinkWorkerChannelPhase> {
    if (!this.#lock()) return failure(ERRNO.EBUSY);
    try {
      const writerStatus = this.#writerStatus(writer, transaction);
      if (writerStatus !== 0) return failure(-writerStatus);
      const state = Atomics.load(this.#words, H_STATE);
      const nextState = state === PREPARE ? COMMIT : state === COMMIT ? FINALIZE : 0;
      if (nextState === 0) return failure(ERRNO.EINVAL);
      const allAcked = this.#allAcknowledged(transaction, state);
      if (allAcked === null) {
        Atomics.store(this.#words, H_STATE, POISON);
        return failure(ERRNO.EIO);
      }
      if (!allAcked) return failure(ERRNO.EAGAIN);
      if (!this.#clearAcknowledgements(transaction)) {
        Atomics.store(this.#words, H_STATE, POISON);
        return failure(ERRNO.EIO);
      }
      Atomics.store(this.#words, H_STATE, nextState);
      return success(nextState === COMMIT ? "commit" : "finalize");
    } finally {
      this.#unlock();
    }
  }

  /** Enter rollback coordination only before Finalize. */
  requestAbort(
    writer: DylinkWorkerParticipant,
    transaction: number,
  ): DylinkWorkerChannelResult<void> {
    if (!this.#lock()) return failure(ERRNO.EBUSY);
    try {
      const writerStatus = this.#writerStatus(writer, transaction);
      if (writerStatus !== 0) return failure(-writerStatus);
      const state = Atomics.load(this.#words, H_STATE);
      if (state !== PREPARE && state !== COMMIT) return failure(ERRNO.EINVAL);
      if (!this.#clearAcknowledgements(transaction)) {
        Atomics.store(this.#words, H_STATE, POISON);
        return failure(ERRNO.EIO);
      }
      Atomics.store(this.#words, H_STATE, ABORT);
      return success(undefined);
    } finally {
      this.#unlock();
    }
  }

  /** Finish a fully acknowledged Finalize or Abort phase. */
  finish(
    writer: DylinkWorkerParticipant,
    transaction: number,
  ): DylinkWorkerChannelResult<DylinkWorkerChannelCompletion> {
    if (!this.#lock()) return failure(ERRNO.EBUSY);
    try {
      const completion = this.#completionLocked(writer, transaction);
      if (!completion.ok) return completion;
      if (completion.value.completion.committed)
        Atomics.store(this.#words, H_GENERATION, completion.value.completion.generation);
      this.#clearFinishedTransaction(transaction);
      return success(completion.value.completion);
    } finally {
      this.#unlock();
    }
  }

  /**
   * Atomically finish an acknowledged transaction and retain a writer lease.
   * beforeRelease runs under the control lock after all old acknowledgements
   * and before a new transaction becomes visible. It must be trusted, pure JS:
   * it must not run user code or re-enter this channel.
   */
  finishAndReserve(
    writer: DylinkWorkerParticipant,
    transaction: number,
    beforeRelease?: () => void,
  ): DylinkWorkerChannelResult<{
    completion: DylinkWorkerChannelCompletion;
    reservation: DylinkWorkerReservation;
  }> {
    const owner = Object.freeze({ slot: writer.slot, epoch: writer.epoch });
    if (!this.#lock()) return failure(ERRNO.EBUSY);
    try {
      const completionResult = this.#completionLocked(owner, transaction);
      if (!completionResult.ok) return completionResult;

      const oldState = completionResult.value.state;
      const reservationStatus = this.#reservationPreflightLocked(owner, transaction, oldState);
      if (reservationStatus !== 0) return failure(-reservationStatus);

      beforeRelease?.();

      if (completionResult.value.completion.committed)
        Atomics.store(this.#words, H_GENERATION, completionResult.value.completion.generation);

      const reserved = this.#reserveLocked(owner, oldState, true);
      if (!reserved.ok) {
        Atomics.store(this.#words, H_STATE, POISON);
        channelError(
          ERRNO.EIO,
          "Worker channel rollover failed after owner release",
          new Error(`reservation returned ${reserved.errno}`),
        );
      }

      return success({
        completion: completionResult.value.completion,
        reservation: Object.freeze({
          owner,
          transaction: reserved.value,
          generation: Atomics.load(this.#words, H_GENERATION),
          cleanup: true as const,
        }),
      });
    } finally {
      this.#unlock();
    }
  }

  #completionLocked(
    writer: DylinkWorkerParticipant,
    transaction: number,
  ): DylinkWorkerChannelResult<{
    state: number;
    completion: DylinkWorkerChannelCompletion;
  }> {
    const writerStatus = this.#writerStatus(writer, transaction);
    if (writerStatus !== 0) return failure(-writerStatus);
    const state = Atomics.load(this.#words, H_STATE);
    if (state !== FINALIZE && state !== ABORT) return failure(ERRNO.EINVAL);
    const allAcked = this.#allAcknowledged(transaction, state);
    if (allAcked === null) {
      Atomics.store(this.#words, H_STATE, POISON);
      return failure(ERRNO.EIO);
    }
    if (!allAcked) return failure(ERRNO.EAGAIN);

    const committed = state === FINALIZE;
    let generation = Atomics.load(this.#words, H_GENERATION);
    if (committed) {
      if (generation === 0xffff_ffff) {
        Atomics.store(this.#words, H_STATE, POISON);
        return failure(ERRNO.EOVERFLOW);
      }
      generation++;
    }
    return success({ state, completion: { generation, committed } });
  }

  #reservationPreflightLocked(
    writer: DylinkWorkerParticipant,
    completedTransaction: number,
    expectedState: number,
  ): number {
    if (Atomics.load(this.#words, H_STATE) !== expectedState) return -ERRNO.ESTALE;
    if (Atomics.load(this.#words, H_ADMISSIONS) !== 0) return -ERRNO.EBUSY;
    const tokenStatus = this.#tokenStatus(writer);
    if (tokenStatus !== 0) return tokenStatus;

    const nextTransaction = Atomics.load(this.#words, H_NEXT_TRANSACTION);
    if (nextTransaction === 0) {
      Atomics.store(this.#words, H_STATE, POISON);
      return -ERRNO.EOVERFLOW;
    }
    if (nextTransaction <= completedTransaction) {
      Atomics.store(this.#words, H_STATE, POISON);
      return -ERRNO.EIO;
    }

    let cohortCount = 0;
    let writerIsActive = false;
    for (let slot = 0; slot < this.#maxWorkers; slot++) {
      if (Atomics.load(this.#words, this.#slotWord(slot, S_ACTIVE)) !== ACTIVE) continue;
      cohortCount++;
      if (
        slot === writer.slot &&
        Atomics.load(this.#words, this.#slotWord(slot, S_EPOCH)) === writer.epoch
      )
        writerIsActive = true;
    }
    if (cohortCount === 0 || !writerIsActive) {
      Atomics.store(this.#words, H_STATE, POISON);
      return -ERRNO.EIO;
    }
    return 0;
  }

  #clearFinishedTransaction(transaction: number): void {
    for (let slot = 0; slot < this.#maxWorkers; slot++) {
      if (Atomics.load(this.#words, this.#slotWord(slot, S_TRANSACTION)) !== transaction) continue;
      Atomics.store(this.#words, this.#slotWord(slot, S_TRANSACTION), 0);
      Atomics.store(this.#words, this.#slotWord(slot, S_ACK), 0);
      Atomics.store(this.#words, this.#slotWord(slot, S_ERROR), 0);
    }
    Atomics.store(this.#words, H_TRANSACTION, 0);
    Atomics.store(this.#words, H_LENGTH, 0);
    Atomics.store(this.#words, H_COHORT_COUNT, 0);
    Atomics.store(this.#words, H_WRITER_SLOT, INVALID_SLOT);
    Atomics.store(this.#words, H_WRITER_EPOCH, 0);
    Atomics.store(this.#words, H_FIRST_FAILURE_SLOT, INVALID_SLOT);
    Atomics.store(this.#words, H_STATE, IDLE);
  }

  /** Permanently stop a transaction when the coordinator cannot restore consistency. */
  poison(writer: DylinkWorkerParticipant, transaction: number): DylinkWorkerChannelResult<void> {
    if (!this.#lock()) return failure(ERRNO.EBUSY);
    try {
      const writerStatus = this.#writerStatus(writer, transaction);
      if (writerStatus !== 0) return failure(-writerStatus);
      const state = Atomics.load(this.#words, H_STATE);
      if (state === IDLE) return failure(ERRNO.ESTALE);
      if (state === POISON) return failure(ERRNO.EALREADY);
      Atomics.store(this.#words, H_STATE, POISON);
      return success(undefined);
    } finally {
      this.#unlock();
    }
  }
}
