// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

async function main() {
  const { read_wasm_dynamic_signatures, read_wasm_dylink } = await import(
    pathToFileURL(process.argv[2]).href
  );
  const [forwarderPath, providerPath, consumerPath] = process.argv.slice(3);
  assert.ok(forwarderPath && providerPath && consumerPath, "three linked DSO paths");

  const forwarderBytes = new Uint8Array(readFileSync(forwarderPath));
  const providerBytes = new Uint8Array(readFileSync(providerPath));
  const consumerBytes = new Uint8Array(readFileSync(consumerPath));
  const providerSignatures = read_wasm_dynamic_signatures(providerBytes);
  const forwarderSignatures = read_wasm_dynamic_signatures(forwarderBytes);
  const consumerSignatures = read_wasm_dynamic_signatures(consumerBytes);
  const target = "reexport_target";

  assert.equal(
    providerSignatures.reexports.has(target),
    false,
    "provider defines the function instead of re-exporting it",
  );
  const providerSignature = providerSignatures.exports.get(target);
  assert.ok(providerSignature, "provider exports reexport_target as a function");
  assert.equal(
    forwarderSignatures.exports.get(target),
    providerSignature,
    "forwarder re-export has the provider's exact function signature",
  );
  assert.deepEqual(
    forwarderSignatures.reexports.get(target),
    {
      module: "env",
      name: target,
    },
    "forwarder export aliases its env import at the same function index",
  );

  const forwarderModule = new WebAssembly.Module(forwarderBytes);
  const actualExport = WebAssembly.Module.exports(forwarderModule).find(
    (entry) => entry.name === target,
  );
  assert.equal(actualExport?.kind, "function", "Wasm export section contains the function");
  assert.equal(
    consumerSignatures.reexports.has(target),
    false,
    "consumer does not re-export imports implicitly",
  );

  const providerModule = new WebAssembly.Module(providerBytes);
  const providerExport = WebAssembly.Module.exports(providerModule).find(
    (entry) => entry.name === target,
  );
  assert.equal(providerExport?.kind, "function", "provider exports a real function");

  const forwarderDylink = read_wasm_dylink(forwarderModule);
  const consumerModule = new WebAssembly.Module(consumerBytes);
  const consumerDylink = read_wasm_dylink(consumerModule);
  assert.ok(
    forwarderDylink?.needed.includes("libreexport-provider.so"),
    "forwarder retains provider as a real NEEDED library",
  );
  assert.ok(
    consumerDylink?.needed.includes("libreexport-forwarder.so"),
    "consumer retains forwarder as a real NEEDED library",
  );
  assert.ok(
    consumerSignatures.imports.some(
      (entry) =>
        entry.kind === "function" && entry.name === target && entry.signature === providerSignature,
    ),
    "consumer imports reexport_target with the provider ABI",
  );
  for (const name of ["reexport_consumer_direct", "reexport_consumer_pointer"])
    assert.equal(
      WebAssembly.Module.exports(consumerModule).find((entry) => entry.name === name)?.kind,
      "function",
      `${name} is a real consumer function export`,
    );

  console.log(
    "dynamic loader build: import-function re-export indexes, signatures and NEEDED edges pass",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
