import { expect, test } from "@playwright/test";

test("rejects invalid CPU counts before configuring devices or fetching the kernel", async ({
  page,
}) => {
  let kernelRequests = 0;
  await page.route("**/vmlinux.wasm", async (route) => {
    kernelRequests++;
    await route.abort();
  });
  await page.goto("/");
  const outcomes = await page.evaluate(async () => {
    const { bootMachine } = await import("@lowland/kernel");
    let configured = false;
    const failures = [];
    for (const cpus of [0, -1, 1.5, NaN, Infinity, 0x100000000]) {
      try {
        await bootMachine({
          cpus,
          plugins: [
            {
              configure() {
                configured = true;
              },
            },
          ],
        });
        failures.push("unexpected success");
      } catch (error) {
        failures.push(error.name);
      }
    }
    return { configured, failures };
  });
  expect(outcomes.configured).toBe(false);
  expect(outcomes.failures).toEqual(Array(6).fill("RangeError"));
  expect(kernelRequests).toBe(0);
});

test("runs musl allocation, mmap, threads, TLS and signals", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  await expect.poll(() => page.evaluate(() => typeof globalThis.bootRuntimeSmoke)).toBe("function");
  const output = await page.evaluate(() => globalThis.bootRuntimeSmoke());

  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});

test("runs C++ containers, exceptions, cross-thread exception_ptr cleanup and TLS", async ({
  page,
}) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootCxxRuntimeSmoke))
    .toBe("function");
  const output = await page.evaluate(() => globalThis.bootCxxRuntimeSmoke());

  expect(output).toContain("C++ runtime: typed catch and RAII cleanup passed");
  expect(output).toContain("C++ runtime: retained cross-thread exception cleanup passed");
  expect(output).toContain("C++ runtime: inherited exception and RTTI adjustment passed");
  expect(output).toContain("C++ runtime: thread_local exit cleanup passed");
  expect(output).toContain("C++ runtime: condition variable handoff passed");
  expect(output).toContain("C++ runtime: containers, RAII, exception_ptr, thread and TLS verified");
  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});

test("runs SDK SQLite transactions and file reopen through Linux", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootSqliteRuntimeSmoke))
    .toBe("function");
  const output = await page.evaluate(() => globalThis.bootSqliteRuntimeSmoke());
  expect(output).toContain("SDK SQLite: in-memory bindings and rollback verified");
  expect(output).toContain("SDK SQLite: file commit, rollback, reopen and integrity verified");
  expect(output).toContain("SDK SQLite: cross-process writer exclusion and lock release verified");
  expect(output).toContain("SDK SQLite: hot rollback journal recovery after process exit verified");
  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});

test("runs SDK Unix and TCP socket readiness and half-close through Linux", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootSocketRuntimeSmoke))
    .toBe("function");
  const output = await page.evaluate(() => globalThis.bootSocketRuntimeSmoke());
  expect(output).toContain(
    "SDK sockets: Unix stream nonblocking, poll/epoll and half-close verified",
  );
  expect(output).toContain(
    "SDK sockets: TCP loopback nonblocking, poll/epoll and half-close verified",
  );
  expect(output).toContain(
    "SDK sockets: UDP scatter/gather, peek, truncation and empty records verified",
  );
  expect(output).toContain("SDK sockets: epoll edge-trigger and one-shot rearm verified");
  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});

test("runs SDK time64 relative and absolute timers and ready-fd waits through Linux", async ({
  page,
}) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootTimeRuntimeSmoke))
    .toBe("function");
  const output = await page.evaluate(() => globalThis.bootTimeRuntimeSmoke());
  expect(output).toContain(
    "time ABI: relative/absolute timers, expiration and ready-fd waits verified",
  );
  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});

test("runs SDK pthread time64 waits, cancellation and broadcast through Linux", async ({
  page,
}) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootThreadTimeRuntimeSmoke))
    .toBe("function");
  const output = await page.evaluate(() => globalThis.bootThreadTimeRuntimeSmoke());
  expect(output).toContain(
    "thread time ABI: wakeups, cancellation, broadcast, timeouts and mutex ownership verified",
  );
  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});

test("runs SDK ppoll, pselect and sigsuspend signal-mask handoff through Linux", async ({
  page,
}) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootSignalWaitRuntimeSmoke))
    .toBe("function");
  const output = await page.evaluate(() => globalThis.bootSignalWaitRuntimeSmoke());
  expect(output).toContain(
    "signal waits: ppoll/pselect/sigsuspend mask handoff, EINTR, timeout and readiness verified",
  );
  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});

test("runs SDK partial pipe I/O and interrupted child reaping through Linux", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootSignalIoRuntimeSmoke))
    .toBe("function");
  const output = await page.evaluate(() => globalThis.bootSignalIoRuntimeSmoke());
  expect(output).toContain(
    "signal I/O: partial progress, explicit suffix retry, EINTR/restart and single child reaping verified",
  );
  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});

test("runs SDK futex signal restart and timed interruption through Linux", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootSignalFutexRuntimeSmoke))
    .toBe("function");
  const output = await page.evaluate(() => globalThis.bootSignalFutexRuntimeSmoke());
  expect(output).toContain(
    "signal futex: untimed restart, timed EINTR, explicit wake and queue cleanup verified",
  );
  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});

test("runs SDK futex time64 waits, wake operations and waitv through Linux", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootFutexRuntimeSmoke))
    .toBe("function");
  const output = await page.evaluate(() => globalThis.bootFutexRuntimeSmoke());
  expect(output).toContain(
    "futex ABI: relative wait, wake operation and private/shared waitv timeouts verified",
  );
  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});

test("runs SDK robust mutex owner-death recovery through Linux", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootRobustMutexRuntimeSmoke))
    .toBe("function");
  const output = await page.evaluate(() => globalThis.bootRobustMutexRuntimeSmoke());
  expect(output).toContain(
    "robust mutex: four contending threads serialize one owner-dead repair verified",
  );
  expect(output).toContain(
    "robust mutex: owner death, consistent recovery, unrecoverable state and cancellation verified",
  );
  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});

test("runs SDK named and unnamed semaphore deadline boundaries through Linux", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootSemaphoreDeadlineRuntimeSmoke))
    .toBe("function");
  const output = await page.evaluate(() => globalThis.bootSemaphoreDeadlineRuntimeSmoke());
  expect(output).toContain(
    "semaphore deadlines: named/unnamed past deadlines, invalid nanoseconds and token fast path verified",
  );
  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});

test("runs SDK C++ filesystem copies, links, time64 metadata and errors through Linux", async ({
  page,
}) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootFilesystemRuntimeSmoke))
    .toBe("function");
  const output = await page.evaluate(() => globalThis.bootFilesystemRuntimeSmoke());
  expect(output).toContain(
    "C++ filesystem: binary copy, links, time64 metadata, directory iteration and errors verified",
  );
  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});

test("runs QuickJS language, file I/O, spawn, Worker, timers and bytecode through Linux", async ({
  page,
}) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootQuickjsRuntimeSmoke))
    .toBe("function");
  const output = await page.evaluate(() => globalThis.bootQuickjsRuntimeSmoke());
  expect(output).toContain(
    "QuickJS: language, file I/O, spawn, Worker, timers and bytecode generation verified",
  );
  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});

test("runs Lua integer64, modules, coroutine cleanup, spawn and bytecode through Linux", async ({
  page,
}) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootLuaRuntimeSmoke))
    .toBe("function");
  const output = await page.evaluate(() => globalThis.bootLuaRuntimeSmoke());
  expect(output).toContain(
    "Lua: integer64, modules, I/O, coroutine cleanup, spawn and bytecode roundtrips verified",
  );
  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});

test("runs installed Lua C callbacks, errors and coroutine through Linux", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootLuaDevelopmentRuntimeSmoke))
    .toBe("function");
  const output = await page.evaluate(() => globalThis.bootLuaDevelopmentRuntimeSmoke());
  expect(output).toContain(
    "Lua embedding: installed archive, C callbacks, integer64, errors and coroutine verified",
  );
  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});

test("runs OpenSSL CLI and verified TLS1.3 certificate and hostname checks through Linux", async ({
  page,
}) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.bootOpensslRuntimeSmoke))
    .toBe("function");
  const output = await page.evaluate(() => globalThis.bootOpensslRuntimeSmoke());
  expect(output).toContain("TLS verification: trusted localhost TLSv1.3 binary roundtrip");
  expect(output).toContain("TLS verification: rejected localhost (18)");
  expect(output).toContain("TLS verification: rejected wrong.invalid (62)");
  expect(output).toContain(
    "OpenSSL: verified TLS1.3, binary I/O, untrusted certificate and wrong hostname rejection",
  );
  expect(output).toContain(
    "OpenSSL: CLI defaults, entropy, digest, X.509 and verified TLS consumers complete",
  );
  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});

test("retries a failed kernel download in the same page with a generic MIME type", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/vmlinux.wasm", async (route) => {
    requests++;
    if (requests === 1) {
      await route.fulfill({ status: 503, contentType: "text/plain", body: "temporary failure" });
      return;
    }
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-type": "application/octet-stream" },
    });
  });
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => typeof globalThis.bootRuntimeSmoke)).toBe("function");
  const failure = await page.evaluate(async () => {
    try {
      await globalThis.bootRuntimeSmoke();
      return "unexpected success";
    } catch (error) {
      return String(error);
    }
  });
  expect(failure).toContain("HTTP 503");
  expect(requests).toBe(1);
  // Do not reload: this must use the same imported kernel module and its cache.
  const output = await page.evaluate(() => globalThis.bootRuntimeSmoke());
  expect(requests).toBe(2);
  expect(output).toContain("::vm-test::pass");
  expect(output).not.toContain("::vm-test::fail");
});
