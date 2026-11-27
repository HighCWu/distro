import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scanner = fileURLToPath(new URL("./check-store-references.sh", import.meta.url));

test("check-store-references.sh accepts clean payloads and rejects store leaks or missing paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "apk-store-scan-"));
  try {
    const clean = join(dir, "clean");
    const badText = join(dir, "bad-text");
    const badBinary = join(dir, "bad-binary");
    const badLink = join(dir, "bad-link");
    mkdirSync(clean);
    mkdirSync(badText);
    mkdirSync(badBinary);
    mkdirSync(badLink);

    writeFileSync(join(clean, "guest.txt"), "usr/bin/sh\n");
    writeFileSync(
      join(badText, "leak.txt"),
      "#!/nix/store/00000000000000000000000000000000-bash/bin/sh\n",
    );
    writeFileSync(
      join(badBinary, "leak.bin"),
      Buffer.concat([
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00]),
        Buffer.from("/nix/store/11111111111111111111111111111111-musl/lib"),
        Buffer.from([0x00, 0xff]),
      ]),
    );
    symlinkSync(
      "/nix/store/22222222222222222222222222222222-coreutils/bin/ls",
      join(badLink, "ls"),
    );

    const ok = spawnSync("bash", [scanner, clean], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);

    for (const bad of [badText, badBinary, badLink, join(dir, "does-not-exist")]) {
      const res = spawnSync("bash", [scanner, bad], { encoding: "utf8" });
      assert.notEqual(res.status, 0, `expected failure for ${bad}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
