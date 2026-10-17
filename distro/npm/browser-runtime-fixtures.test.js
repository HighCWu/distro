// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { checkReport } from "./browser-report-check.mjs";

const app = readFileSync(
  new URL("../../packages/browser-tests/memory64-app.js", import.meta.url),
  "utf8",
);
const spec = readFileSync(
  new URL("../../packages/browser-tests/memory64-tests/memory64.spec.js", import.meta.url),
  "utf8",
);
const recipe = readFileSync(new URL("./browser-tests.nix", import.meta.url), "utf8");
const titles = [
  ...recipe.match(/runtimeTests = \[([\s\S]*?)\n  \];/)[1].matchAll(/"([^"]+)"/g),
].map((match) => match[1]);
const fixtures = [
  {
    title: "runs curl verified TLS1.3 and certificate/hostname rejection over Linux TCP",
    entry: "bootCurlHttpsRuntimeSmoke",
    path: "/runtime-curl-https.cpio",
    stages: [
      "curl HTTPS: distribution CA bundle rejects local self-signed certificate",
      "curl HTTPS: default CA bundle trusted localhost TLS1.3 over Linux TCP verified",
      "curl HTTPS: unrelated default CA rejected",
      "curl HTTPS: trusted localhost TLS1.3 over Linux TCP verified",
      "curl HTTPS: untrusted certificate rejected",
      "curl HTTPS: wrong hostname rejected",
      "curl HTTPS: missing default CA bundle fails closed",
      "curl HTTPS: original distribution CA bundle restored",
      "curl: explicit-CA TLS1.3 transfer and certificate/hostname rejection verified",
    ],
  },
  {
    title: "runs OpenSSL CLI and verified TLS1.3 certificate and hostname checks through Linux",
    entry: "bootOpensslRuntimeSmoke",
    path: "/runtime-openssl.cpio",
    stages: [
      "TLS verification: trusted localhost TLSv1.3 binary roundtrip",
      "TLS verification: rejected localhost (18)",
      "TLS verification: rejected wrong.invalid (62)",
      "OpenSSL: verified TLS1.3, binary I/O, untrusted certificate and wrong hostname rejection",
      "OpenSSL: CLI defaults, entropy, digest, X.509 and verified TLS consumers complete",
    ],
  },
  {
    title: "runs Lua integer64, modules, coroutine cleanup, spawn and bytecode through Linux",
    entry: "bootLuaRuntimeSmoke",
    path: "/runtime-lua.cpio",
    stages: [
      "Lua: integer64, modules, I/O, coroutine cleanup, spawn and bytecode roundtrips verified",
    ],
  },
  {
    title: "runs installed Lua C callbacks, errors and coroutine through Linux",
    entry: "bootLuaDevelopmentRuntimeSmoke",
    path: "/runtime-lua-development.cpio",
    stages: [
      "Lua embedding: installed archive, C callbacks, integer64, errors and coroutine verified",
    ],
  },
  {
    title: "runs QuickJS language, file I/O, spawn, Worker, timers and bytecode through Linux",
    entry: "bootQuickjsRuntimeSmoke",
    path: "/runtime-quickjs.cpio",
    stages: ["QuickJS: language, file I/O, spawn, Worker, timers and bytecode generation verified"],
  },
  {
    title: "runs SDK C++ filesystem copies, links, time64 metadata and errors through Linux",
    entry: "bootFilesystemRuntimeSmoke",
    path: "/runtime-filesystem.cpio",
    stages: [
      "C++ filesystem: binary copy, links, time64 metadata, directory iteration and errors verified",
    ],
  },
  {
    title: "runs SDK named and unnamed semaphore deadline boundaries through Linux",
    entry: "bootSemaphoreDeadlineRuntimeSmoke",
    path: "/runtime-semaphore-deadline.cpio",
    stages: [
      "semaphore deadlines: named/unnamed past deadlines, invalid nanoseconds and token fast path verified",
    ],
  },
  {
    title: "runs SDK futex time64 waits, wake operations and waitv through Linux",
    entry: "bootFutexRuntimeSmoke",
    path: "/runtime-futex.cpio",
    stages: ["futex ABI: relative wait, wake operation and private/shared waitv timeouts verified"],
  },
  {
    title: "runs SDK robust mutex owner-death recovery through Linux",
    entry: "bootRobustMutexRuntimeSmoke",
    path: "/runtime-robust-mutex.cpio",
    stages: [
      "robust mutex: four contending threads serialize one owner-dead repair verified",
      "robust mutex: owner death, consistent recovery, unrecoverable state and cancellation verified",
    ],
  },
];

function loadCases(globals = {}) {
  const cases = new Map();
  const expect = (actual) => ({
    toContain: (value) => assert.ok(actual.includes(value), `missing ${value}`),
    not: { toContain: (value) => assert.ok(!actual.includes(value), `unexpected ${value}`) },
  });
  expect.poll = (callback) => ({ toBe: async (value) => assert.equal(await callback(), value) });
  runInNewContext(spec.replace('import { expect, test } from "@playwright/test";', ""), {
    expect,
    test: (title, callback) => {
      assert.ok(!cases.has(title), `duplicate case ${title}`);
      cases.set(title, callback);
    },
    console,
    ...globals,
  });
  return cases;
}

test("Nix report gate exactly matches all registered runtime cases", () => {
  assert.deepEqual([...loadCases().keys()].sort(), [...titles].sort());
  assert.equal(titles.length, 20);
  const report = {
    suites: [
      {
        specs: titles.map((title) => ({
          title,
          tests: [{ status: "expected", results: [{ status: "passed", retry: 0 }] }],
        })),
      },
    ],
    stats: { expected: titles.length, skipped: 0, unexpected: 0, flaky: 0 },
    errors: [],
  };
  checkReport(report, titles);
  for (const { title } of fixtures) {
    const missing = structuredClone(report);
    missing.suites[0].specs = missing.suites[0].specs.filter((entry) => entry.title !== title);
    assert.throws(() => checkReport(missing, titles));
  }
});

for (const fixture of fixtures) {
  test(`${fixture.entry} fetches its own initramfs through the shared runtime`, async () => {
    const requests = [];
    const context = {
      bootMachine: () => {},
      consoleDevice: () => {},
      entropyDevice: () => {},
      async fetch(path) {
        requests.push(path);
        return { ok: true, arrayBuffer: async () => Uint8Array.of(1, 2).buffer };
      },
      runRuntimeSmoke: (options) => options.loadInitramfs(),
    };
    runInNewContext(app.replace(/^import .*;\n/gm, ""), context);
    assert.deepEqual(Array.from(await context[fixture.entry]()), [1, 2]);
    assert.deepEqual(requests, [fixture.path]);
    context.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(context[fixture.entry](), /runtime initramfs load failed: 503/);
  });

  test(`${fixture.entry} requires its stage, pass and absence of failure`, async () => {
    const stage = fixture.stages.join("\n");
    for (const [output, accepted] of [
      [`${stage}\n::vm-test::pass\n`, true],
      ["::vm-test::pass\n", false],
      [`${stage}\n`, false],
      [`${stage}\n::vm-test::pass\n::vm-test::fail: broken\n`, false],
      ...fixture.stages.map((missing) => [
        `${fixture.stages.filter((value) => value !== missing).join("\n")}\n::vm-test::pass\n`,
        false,
      ]),
    ]) {
      let calls = 0;
      const cases = loadCases({
        [fixture.entry]: () => {
          calls++;
          return output;
        },
      });
      const page = { on() {}, goto: async () => {}, evaluate: async (callback) => callback() };
      const run = cases.get(fixture.title)({ page });
      if (accepted) await run;
      else await assert.rejects(run);
      assert.equal(calls, 1);
    }
  });
}
