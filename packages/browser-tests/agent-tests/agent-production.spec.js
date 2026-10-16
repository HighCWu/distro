// SPDX-License-Identifier: MIT
import { test } from "@playwright/test";
import { checkNativeAgent } from "./agent-check.js";

test("runs native wasm64 production root pivot, files, processes and cleanup", async ({ page }) => {
  await checkNativeAgent(page, true);
});
