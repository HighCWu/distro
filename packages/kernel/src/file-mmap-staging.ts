// SPDX-License-Identifier: MIT

type State = "reading" | "ready" | "committing" | "committed" | "aborted";

/** Transport-independent staging ownership, not a file syscall or allocator.
 * complete_read is an acknowledgement that the producer has STOPPED writing,
 * not merely a notification that the consumer stopped waiting. Cancellation
 * retains the buffer until that acknowledgement and any copy lease end.
 * One record belongs to one request/producer; never resolve records by tid alone.
 * release must be synchronous and infallible. This is a single-agent ownership
 * primitive, not a cross-Worker lock or a thread-wakeup implementation. */
export class FileMmapStaging<T> {
  #owned: { buffer: T } | null;
  #release: (buffer: T) => void;
  #state: State = "reading";
  #producer_done = false;
  #lease_open = false;
  #error: number | null = null;

  constructor(buffer: T, release: (buffer: T) => void) {
    this.#owned = { buffer };
    this.#release = release;
  }

  get state(): State {
    return this.#state;
  }
  get error(): number | null {
    return this.#error;
  }

  #check_errno(errno: number): void {
    if (!Number.isInteger(errno) || errno <= 0 || errno > 4095)
      throw new RangeError("invalid staging errno");
  }

  #reclaim(): void {
    if (
      !this.#producer_done ||
      this.#lease_open ||
      (this.#state !== "committed" && this.#state !== "aborted")
    )
      return;
    const owned = this.#owned;
    this.#owned = null; // A reentrant/duplicate notification cannot free twice.
    if (owned) this.#release(owned.buffer);
  }

  complete_read(errno = 0): boolean {
    if (errno !== 0) this.#check_errno(errno);
    if (this.#producer_done) return false;
    this.#producer_done = true;
    if (this.#state === "reading") {
      this.#state = errno === 0 ? "ready" : "aborted";
      if (errno !== 0) this.#error = errno;
    }
    this.#reclaim();
    return true;
  }

  abort(errno = 4): boolean {
    this.#check_errno(errno);
    if (this.#state === "committed" || this.#state === "aborted") return false;
    this.#state = "aborted";
    this.#error = errno;
    this.#reclaim();
    return true;
  }

  /** Copy into an unpublished candidate while holding this lease. finish(true)
   * authorizes ownership transfer only if cancellation has not won. The caller
   * must perform final validation/finish/publication in the same synchronous
   * allocator critical section, or discard the candidate on false. This class
   * does not implement that allocator lock or publication. Always finish in a
   * finally block; errors/short reads must not become a successful commit. */
  begin_commit(): { buffer: T; finish: (success: boolean) => boolean } | null {
    if (this.#state !== "ready" || !this.#owned) return null;
    this.#state = "committing";
    this.#lease_open = true;
    const buffer = this.#owned.buffer;
    let finished = false;
    return {
      buffer,
      finish: (success) => {
        if (finished) return false;
        finished = true;
        this.#lease_open = false;
        const accepted = success && this.#state === "committing";
        if (this.#state === "committing") {
          this.#state = accepted ? "committed" : "aborted";
          if (!accepted) this.#error = 5; // EIO: caller's copy/validation failed.
        }
        this.#reclaim();
        return accepted;
      },
    };
  }
}
