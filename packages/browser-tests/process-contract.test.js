// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { processStages, assertProcessOutput } from "./process-contract.js";

for (const corpus of Object.keys(processStages))
  test(`${corpus}: exact ordered stage admission`, () => {
    const lines = [...processStages[corpus], "::vm-test::pass"];
    const output = lines.join("\n");
    assert.doesNotThrow(() => assertProcessOutput(output, corpus));
    for (const bad of [
      lines.slice(1).join("\n"),
      [...lines].reverse().join("\n"),
      output + "\n::vm-test::pass",
      output + "\n::vm-test::fail",
      output + "\nrcu: detected stall",
    ])
      assert.throws(() => assertProcessOutput(bad, corpus));
    assert.throws(() => assertProcessOutput(output, "toString"));
  });

test("browser controller requires two boots, closed browser and no late page error", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "process-browser-host-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of ["process-browser-check.mjs", "process-contract.js"])
    copyFileSync(new URL(file, import.meta.url), join(dir, file));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(dir, "profile.json"), JSON.stringify({ addressBits: 64, corpus: "dash" }));
  writeFileSync(
    join(dir, "server.js"),
    'console.log("Listening on http://127.0.0.1:12345"); setInterval(()=>{},1000);',
  );
  const module = join(dir, "node_modules/playwright");
  mkdirSync(module, { recursive: true });
  writeFileSync(
    join(module, "package.json"),
    JSON.stringify({ type: "module", exports: "./index.js" }),
  );
  const output = [...processStages.dash, "::vm-test::pass"].join("\n");
  writeFileSync(
    join(module, "index.js"),
    `
    import {EventEmitter} from 'node:events';
    const page = new EventEmitter();
    page.goto = async()=>{}; page.waitForFunction = async()=>{};
    page.evaluate = async fn => String(fn).includes('crossOriginIsolated') ? true : ${JSON.stringify(output)};
    let connected = true;
    const browser = {version:()=> 'mock', newPage:async()=>page, isConnected:()=>connected,
      close:async()=>{ connected=false; if(process.env.PROCESS_BROWSER_LATE) page.emit('pageerror',Error('late failure')); }};
    export const chromium={launch:async()=>browser}; export const firefox=chromium;
  `,
  );
  for (const late of [false, true]) {
    const run = spawnSync(process.execPath, ["process-browser-check.mjs", "chromium"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 20000,
      env: { ...process.env, PROCESS_BROWSER_LATE: late ? "1" : "" },
    });
    assert.equal(run.error, undefined);
    if (late) {
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /late browser errors/);
      assert.doesNotMatch(run.stdout, /both iterations and browser shutdown pass/);
    } else {
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal((run.stdout.match(/and machine shutdown pass/g) ?? []).length, 2);
      assert.match(run.stdout, /both iterations and browser shutdown pass/);
    }
  }
  const app = readFileSync(new URL("process-app.js", import.meta.url), "utf8");
  assert.match(app, /runRuntimeSmoke/);
  assert.match(app, /crossOriginIsolated/);
});
