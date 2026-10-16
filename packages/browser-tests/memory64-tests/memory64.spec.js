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
  expect(output).toContain("C++ runtime: containers, RAII, exception_ptr, thread and TLS verified");
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
