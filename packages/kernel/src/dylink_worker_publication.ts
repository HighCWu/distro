// SPDX-License-Identifier: MIT

import {
  DylinkWorkerSnapshotError,
  apply_dylink_worker_publication,
  prepare_dylink_worker_publication,
  validate_dylink_worker_snapshot,
  type DylinkWorkerFunctionSlots,
  type DylinkWorkerGroup,
  type DylinkWorkerPublication,
  type DylinkWorkerSnapshot,
  type DylinkWorkerTableSlot,
} from "./dylink_process_worker.ts";

function invalid(message: string): never {
  throw new DylinkWorkerSnapshotError("EINVAL", message);
}

function noMemory(error: RangeError): never {
  throw new DylinkWorkerSnapshotError("ENOMEM", "cannot build dynamic Worker publication delta", {
    cause: error,
  });
}

function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    if (
      !(left instanceof Uint8Array) ||
      !(right instanceof Uint8Array) ||
      left.length !== right.length
    )
      return false;
    for (let index = 0; index < left.length; index++)
      if (left[index] !== right[index]) return false;
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++)
      if (!equalValue(left[index], right[index])) return false;
    return true;
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  const leftKeys = Reflect.ownKeys(left).sort((a, b) => String(a).localeCompare(String(b)));
  const rightKeys = Reflect.ownKeys(right).sort((a, b) => String(a).localeCompare(String(b)));
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index++) {
    const key = leftKeys[index];
    if (
      key !== rightKeys[index] ||
      !equalValue(
        (left as Record<PropertyKey, unknown>)[key!],
        (right as Record<PropertyKey, unknown>)[key!],
      )
    )
      return false;
  }
  return true;
}

function equalExcept(left: object, right: object, excluded: ReadonlySet<string>): boolean {
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord)
    .filter((key) => !excluded.has(key))
    .sort();
  const rightKeys = Object.keys(rightRecord)
    .filter((key) => !excluded.has(key))
    .sort();
  return (
    equalValue(leftKeys, rightKeys) &&
    leftKeys.every((key) => equalValue(leftRecord[key], rightRecord[key]))
  );
}

function appendOnly<T>(before: readonly T[], after: readonly T[], label: string): readonly T[] {
  if (after.length < before.length) invalid(`${label} was shortened`);
  for (let index = 0; index < before.length; index++) {
    if (!equalValue(before[index], after[index])) invalid(`${label}[${index}] was changed`);
  }
  return after.slice(before.length);
}

function appendedGroupFunctionSlots(
  before: DylinkWorkerGroup,
  after: DylinkWorkerGroup,
  groupId: number,
): [number, DylinkWorkerGroup["functionSlots"]] | undefined {
  if (!equalExcept(before, after, new Set(["functionSlots"])))
    invalid(`existing Worker group ${groupId} was changed`);
  if (before.functionSlots.length !== after.functionSlots.length)
    invalid(`existing Worker group ${groupId} changed its function-slot module list`);

  const appended: [string, DylinkWorkerFunctionSlots][] = [];
  for (let index = 0; index < before.functionSlots.length; index++) {
    const [beforeKey, beforeSlots] = before.functionSlots[index]!;
    const [afterKey, afterSlots] = after.functionSlots[index]!;
    if (beforeKey !== afterKey)
      invalid(`existing Worker group ${groupId} changed a function-slot module key`);
    const extra = appendOnly(
      beforeSlots,
      afterSlots,
      `Worker group ${groupId} function slots for ${beforeKey}`,
    );
    if (extra.length) appended.push([beforeKey, extra]);
  }
  return appended.length ? [groupId, appended] : undefined;
}

/**
 * Build the append-only Worker publication between two complete snapshots.
 * Existing files and graph records are compared structurally; Wasm bytes are
 * compared byte-for-byte, without JSON serialization.
 */
export function create_dylink_worker_publication_delta(
  base: DylinkWorkerSnapshot,
  next: DylinkWorkerSnapshot,
  processIdentity: string,
  baseGeneration: number,
): DylinkWorkerPublication {
  try {
    validate_dylink_worker_snapshot(base);
    validate_dylink_worker_snapshot(next);

    if (
      base.version !== next.version ||
      base.address !== next.address ||
      base.tableAddress !== next.tableAddress
    )
      invalid("next Worker snapshot has a different ABI");
    if (next.main.handle !== base.main.handle)
      invalid("next Worker snapshot changed the main handle");
    if (next.main.cursor < base.main.cursor)
      invalid("next Worker snapshot moved the table cursor backwards");
    if (next.main.tableLength < base.main.tableLength)
      invalid("next Worker snapshot shrank the function table");

    const functionSlots = appendOnly(
      base.main.functionSlots,
      next.main.functionSlots,
      "main function slots",
    );
    const addressNames = appendOnly(
      base.main.addressNames,
      next.main.addressNames,
      "main address names",
    );
    const files = appendOnly(base.files, next.files, "Worker files");
    if (next.groups.length < base.groups.length) invalid("Worker groups was shortened");
    const groups = next.groups.slice(base.groups.length);
    const objectGroups = appendOnly(base.objectGroups, next.objectGroups, "Worker object groups");
    const aliases = appendOnly(base.aliases, next.aliases, "Worker aliases");
    const globalOrder = appendOnly(base.globalOrder, next.globalOrder, "Worker global order");
    const owners = appendOnly(base.owners, next.owners, "Worker owners");
    const ownerNames = appendOnly(base.ownerNames, next.ownerNames, "Worker owner names");
    const symbols = appendOnly(base.symbols, next.symbols, "Worker symbols");
    if (next.nextOwner < base.nextOwner)
      invalid("next Worker snapshot moved the owner cursor backwards");

    const tableSlots: [number, DylinkWorkerTableSlot][] = [];
    for (let index = 0; index < next.main.tableSlots.length; index++) {
      const before = index < base.main.tableSlots.length ? base.main.tableSlots[index]! : null;
      const after = next.main.tableSlots[index]!;
      if (before !== null) {
        if (!equalValue(before, after)) invalid(`published Worker table slot ${index} was changed`);
        continue;
      }
      if (after === null) continue;
      if (BigInt(index) < base.main.cursor)
        invalid(`Worker table slot ${index} precedes the published table cursor`);
      tableSlots.push([index, after]);
    }

    const groupFunctionSlots: [number, DylinkWorkerGroup["functionSlots"]][] = [];
    for (let groupId = 0; groupId < base.groups.length; groupId++) {
      const appended = appendedGroupFunctionSlots(
        base.groups[groupId]!,
        next.groups[groupId]!,
        groupId,
      );
      if (appended) groupFunctionSlots.push(appended);
    }

    const draft = {
      main: {
        handle: next.main.handle,
        lastMap: next.main.lastMap,
        cursor: next.main.cursor,
        tableLength: next.main.tableLength,
        functionSlots,
        tableSlots,
        addressNames,
      },
      files,
      groups,
      groupFunctionSlots,
      objectGroups,
      aliases,
      globalOrder,
      owners,
      ownerNames,
      nextOwner: next.nextOwner,
      symbols,
    };
    const publication = prepare_dylink_worker_publication(
      base,
      processIdentity,
      baseGeneration,
      draft,
    );
    const applied = apply_dylink_worker_publication(
      base,
      processIdentity,
      baseGeneration,
      publication,
    );
    if (!equalValue(applied.snapshot, next))
      invalid("Worker publication delta does not reconstruct the requested snapshot");
    return publication;
  } catch (error) {
    if (error instanceof DylinkWorkerSnapshotError) throw error;
    if (error instanceof RangeError) noMemory(error);
    throw error;
  }
}
