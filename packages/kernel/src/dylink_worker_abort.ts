// SPDX-License-Identifier: MIT

/** Internal signal that a Worker publication was aborted after its barrier
 * returned to Idle. ProcessDylink may then report an ordinary dlopen failure. */
export class DylinkWorkerPublicationAbort extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DylinkWorkerPublicationAbort";
  }
}
