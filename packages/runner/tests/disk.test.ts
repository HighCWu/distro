import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function required_environment(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}

const runner = required_environment("LINUX_RUNNER_TEST_RUNNER");
const root = required_environment("LINUX_RUNNER_TEST_ROOT_DISK");

async function run_disks(disks: string[], command: string) {
  const child = spawn(runner, ["--cpus", "1", "--disk", root, ...disks], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let sent = false;
  const consume = (chunk: Buffer) => {
    output += chunk.toString();
    if (!sent && output.includes("~ #")) {
      sent = true;
      child.stdin.end(`${command}\n/sbin/poweroff -f\n`);
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
  } finally {
    clearTimeout(timeout);
  }
  assert.deepEqual(result, { code: 0, signal: null }, output);
  return output;
}

const run_disk = (disk: string, command: string) => run_disks(["--disk", disk], command);

test("runner persists a virtio disk served by a filesystem worker", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "linux-runner-disk-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const disk = path.join(temporary, "disk.img");
  await writeFile(disk, new Uint8Array(1024 * 1024));
  const marker = "node-worker-virtio-round-trip";

  await run_disk(
    disk,
    `until [ -b /dev/vdb ]; do sleep 0.1; done; printf '%s\\n' '${marker}' | dd of=/dev/vdb bs=512 conv=fsync 2>/dev/null`,
  );
  assert.equal((await readFile(disk, "utf8")).split("\n", 1)[0], marker);

  const output = await run_disk(
    disk,
    "until [ -b /dev/vdb ]; do sleep 0.1; done; dd if=/dev/vdb bs=512 count=1 2>/dev/null | head -n 1",
  );
  assert.match(output, new RegExp(marker));
});

test("runner reads a remote virtio disk and powers off", async (t) => {
  const image = Buffer.alloc(1024 * 1024);
  const marker = "http-worker-virtio-range";
  const markerOffset = 128 * 512;
  image.write(marker + "\n", markerOffset);
  const etag = '"runner-range-test"';
  const requests: { offset: number; end: number; validator: string | undefined }[] = [];
  const server = createServer((request, response) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    const offset = Number(range?.[1]);
    const end = Number(range?.[2]);
    const validator = request.headers["if-range"];
    if (
      !range ||
      Array.isArray(validator) ||
      offset > end ||
      end >= image.length ||
      (requests.length && validator !== etag)
    ) {
      response.writeHead(400).end();
      return;
    }
    requests.push({ offset, end, validator });
    response.writeHead(206, {
      ETag: etag,
      "Content-Range": `bytes ${offset}-${end}/${image.length}`,
      "Content-Length": end - offset + 1,
    });
    response.end(image.subarray(offset, end + 1));
  });
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const output = await run_disk(
    `http://127.0.0.1:${address.port}/disk.img`,
    "until [ -b /dev/vdb ]; do sleep 0.1; done; dd if=/dev/vdb bs=512 skip=128 count=1 2>/dev/null | head -n 1",
  );
  assert.match(output, new RegExp(marker));
  assert.deepEqual(requests[0], { offset: 0, end: 511, validator: undefined });
  assert(requests.some(({ offset, end }) => offset <= markerOffset && end >= markerOffset));
});

test("runner attaches a host-writable image as a read-only disk in argument order", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "linux-runner-disk-ro-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const readOnly = path.join(temporary, "read-only.img");
  const writable = path.join(temporary, "writable.img");
  const original = Buffer.alloc(1024 * 1024, 0xa5);
  original.write("read-only-image\n");
  await writeFile(readOnly, original);
  await writeFile(writable, new Uint8Array(original.length));

  const output = await run_disks(
    [`--disk-ro=${readOnly}`, "--disk", writable],
    [
      "until [ -b /dev/vdb ] && [ -b /dev/vdc ]; do sleep 0.1; done",
      '[ "$(cat /sys/block/vdb/ro)" = 1 ] && [ "$(cat /sys/block/vdc/ro)" = 0 ]',
      '[ "$(dd if=/dev/vdb bs=15 count=1 2>/dev/null)" = read-only-image ]',
      "! (printf x | dd of=/dev/vdb bs=1 conv=notrunc 2>/dev/null)",
      "printf read-write-image | dd of=/dev/vdc bs=512 conv=fsync 2>/dev/null",
      "printf '%s%s\\n' disk-ro- contract-passed",
    ].join(" && "),
  );
  assert.match(output, /(?:^|\n)disk-ro-contract-passed\r?(?:\n|$)/);
  assert.deepEqual(await readFile(readOnly), original);
  assert.equal((await readFile(writable)).subarray(0, 16).toString(), "read-write-image");
  t.diagnostic(
    "Linux verified disk order, read-only status and write rejection; runner closed and backing bytes checked",
  );
});
