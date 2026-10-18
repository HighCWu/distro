// SPDX-License-Identifier: MIT

export function persistentRootIdentity(name) {
  // Compare the whole match: JavaScript's $ also accepts a final line terminator.
  if (typeof name !== "string" || /^[a-z0-9][a-z0-9-]{0,47}$/.exec(name)?.[0] !== name)
    throw new Error("Disk name must be 1–48 lowercase ASCII letters, digits or hyphens");
  const filename = `linux-wasm64-${name}.ext4`;
  return { filename, lockName: `linux-wasm64-disk:${filename}` };
}

// A listing is an observation, not a lease or a guarantee that a disk is usable.
// Include incomplete files so a user can explicitly remove failed creations.
export async function listRootDisks({ storage = globalThis.navigator?.storage } = {}) {
  if (!storage?.getDirectory) throw new Error("OPFS is required to list saved disks");
  const directory = await storage.getDirectory();
  const disks = [];
  for await (const handle of directory.values()) {
    const match = /^linux-wasm64-([a-z0-9][a-z0-9-]{0,47})\.ext4$/.exec(handle.name);
    if (
      !match ||
      persistentRootIdentity(match[1]).filename !== handle.name ||
      handle.kind !== "file"
    )
      continue;
    try {
      const size = (await handle.getFile()).size;
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid saved disk size");
      disks.push({ name: match[1], size });
    } catch (error) {
      // Another page may delete an entry between enumeration and metadata.
      if (error.name !== "NotFoundError") throw error;
    }
  }
  return disks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function deleteRootDisk(
  { name, confirmation },
  { storage = globalThis.navigator?.storage, locks = globalThis.navigator?.locks } = {},
) {
  const { filename, lockName } = persistentRootIdentity(name);
  if (confirmation !== name) throw new Error("Disk deletion confirmation does not match its name");
  if (!storage?.getDirectory || !locks?.request)
    throw new Error("OPFS and Web Locks are required to delete a saved disk");
  await locks.request(lockName, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error("This disk is already open in another page");
    const directory = await storage.getDirectory();
    // Check the exact entry is an existing file. Never create or recursively
    // remove an entry, and never delete other OPFS data or repair a disk.
    await directory.getFileHandle(filename);
    await directory.removeEntry(filename);
  });
}
