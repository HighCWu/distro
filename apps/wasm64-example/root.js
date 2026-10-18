// SPDX-License-Identifier: MIT

// Disk ownership lasts through device.closed, including startup failure and
// abnormal Linux shutdown. Reopening never downloads or resizes the template.
export async function openRoot(
  { mode, name },
  {
    loadImage,
    blockDevice,
    closeDevice,
    workerDevice,
    Worker = globalThis.Worker,
    storage = globalThis.navigator?.storage,
    locks = globalThis.navigator?.locks,
    openWorker,
  },
) {
  if (mode === "temporary") {
    const root = await loadImage("/root.ext4");
    return {
      device: blockDevice({
        capacity: root.byteLength,
        read(offset, target) {
          const data = root.subarray(offset, offset + target.byteLength);
          target.set(data);
          return data.byteLength;
        },
        write(offset, data) {
          root.set(data, offset);
          return data.byteLength;
        },
        flush() {},
      }),
      async close() {},
    };
  }
  if (mode !== "create" && mode !== "open") throw new Error("Select a root storage mode");
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(name))
    throw new Error("Disk name must be 1–48 lowercase ASCII letters, digits or hyphens");
  if (!storage?.getDirectory || !locks?.request)
    throw new Error("OPFS and Web Locks are required; no temporary fallback was used");
  const filename = `linux-wasm64-${name}.ext4`;
  let release;
  let accept;
  let reject;
  const acquired = new Promise((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const lease = locks.request(
    `linux-wasm64-disk:${filename}`,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) throw new Error("This disk is already open in another page");
      accept();
      await held;
    },
  );
  void lease.catch(reject);
  await acquired;
  let device;
  let closing;
  const close = () =>
    (closing ??= (async () => {
      try {
        if (device) {
          await closeDevice(device);
          await device.closed;
        }
      } finally {
        release();
        await lease;
      }
    })());
  try {
    const directory = await storage.getDirectory();
    if (mode === "create") {
      try {
        await directory.getFileHandle(filename);
        throw new Error("Disk already exists; choose Open existing or a new name");
      } catch (error) {
        if (error.name !== "NotFoundError") throw error;
      }
      const image = await loadImage("/root.ext4", { stream: true });
      let writable;
      try {
        const handle = await directory.getFileHandle(filename, { create: true });
        writable = await handle.createWritable();
        // pipeTo provides backpressure and closes only after the entire download.
        // Own abort explicitly so failures before pipeTo also release the stream.
        await image.pipeTo(writable, { preventAbort: true });
      } catch (error) {
        if (writable) await writable.abort(error).catch(() => {});
        if (!image.locked) await image.cancel(error).catch(() => {});
        throw error;
      }
    }
    const handle = await directory.getFileHandle(filename);
    const size = (await handle.getFile()).size;
    if (!Number.isSafeInteger(size) || size <= 0 || size % 512 !== 0)
      throw new Error("Existing disk size is not a positive multiple of 512 bytes");
    device = await openWorker(
      new Worker("/opfs-disk-worker.js", { type: "module" }),
      { handle },
      workerDevice,
    );
    return { device, close };
  } catch (error) {
    try {
      await close();
    } catch {}
    throw error;
  }
}
