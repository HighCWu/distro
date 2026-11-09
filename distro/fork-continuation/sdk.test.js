// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const template = readFileSync(new URL("./finalize.sh", import.meta.url), "utf8");
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

test("fork profile clears fork and vfork denials and preserves other unsupported semantics", () => {
  const base = readFileSync(new URL("../config.site", import.meta.url), "utf8");
  const delta = readFileSync(new URL("./config.site", import.meta.url), "utf8");
  const variables = [
    "ac_cv_func_fork",
    "ac_cv_func_fork_works",
    "ac_cv_func_vfork",
    "ac_cv_func_vfork_works",
    "ac_cv_func_mmap_fixed_mapped",
    "ac_cv_func_dlopen",
    "ac_cv_search_dlopen",
    "ac_cv_lib_dl_dlopen",
  ];
  const print = variables.map((key) => `printf '%s\\n' "\${${key}-unset}"`).join("\n");
  for (const shell of ["sh", "bash"]) {
    for (const profile of [false, true]) {
      const result = spawnSync(
        shell,
        ["-eu", "-c", base + "\n" + (profile ? delta : "") + "\n" + print],
        {
          encoding: "utf8",
          env: { ...process.env, ac_cv_func_fork: "host-yes", ac_cv_func_fork_works: "host-yes" },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.trim().split("\n"), [
        ...Array(4).fill(profile ? "unset" : "no"),
        ...Array(4).fill("no"),
      ]);
    }
  }
});

function fixture(t, fail = false) {
  const dir = mkdtempSync(join(tmpdir(), "fork sdk "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, "linked file.wasm");
  const output = join(dir, "final file.wasm");
  const log = join(dir, "arguments.json");
  const stub = join(dir, "wasm-opt.mjs");
  writeFileSync(input, "input");
  writeFileSync(output, "old-output");
  writeFileSync(
    stub,
    `
    import { writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
    writeFileSync(args[args.indexOf('-o') + 1], 'transformed');
    process.exit(${fail ? 17 : 0});
  `,
  );
  const script =
    "set -euo pipefail\n" +
    template.replaceAll("@wasmOpt@", `${quote(process.execPath)} ${quote(stub)}`);
  const run = (args = [input, output]) =>
    spawnSync("bash", ["-c", script, "finalize", ...args], {
      encoding: "utf8",
    });
  return { dir, input, output, log, run };
}

test("finalizer applies whole-link Asyncify with the explicit checkpoint import", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.output, "utf8"), "transformed");
  assert.equal(readFileSync(f.input, "utf8"), "input");
  const args = JSON.parse(readFileSync(f.log, "utf8"));
  assert.equal(args[0], f.input);
  assert.ok(args.includes("--asyncify"));
  assert.ok(
    args.includes(
      "--pass-arg=asyncify-imports@linux_fork_v1.checkpoint,linux.syscall,linux.syscall_v2,linux_user_poll_v1.checkpoint,linux_user_poll_v2.checkpoint",
    ),
  );
  assert.ok(args.includes("--pass-arg=asyncify-asserts"));
  assert.ok(!args.includes("--all-features"));
  assert.ok(!readdirSync(f.dir).some((name) => name.includes(".tmp.")));
});

test("failed transformation preserves input/output and removes its temporary file", (t) => {
  const f = fixture(t, true);
  assert.equal(f.run().status, 17);
  assert.equal(readFileSync(f.output, "utf8"), "old-output");
  assert.equal(readFileSync(f.input, "utf8"), "input");
  assert.ok(!readdirSync(f.dir).some((name) => name.includes(".tmp.")));
});

test("usage, missing input, identical paths and hard-link aliases fail closed", (t) => {
  const f = fixture(t);
  for (const args of [
    [],
    [f.input],
    [f.input, f.output, "extra"],
    [join(f.dir, "absent"), f.output],
    [f.input, f.input],
  ]) {
    assert.equal(f.run(args).status, 64);
  }
  const alias = join(f.dir, "alias.wasm");
  linkSync(f.input, alias);
  assert.equal(f.run([f.input, alias]).status, 64);
  assert.equal(readFileSync(f.input, "utf8"), "input");
});

test("the dual-width runtime corpus consumes the installed SDK tools", () => {
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.match(recipe, /wasm-linux-fork-cc .* -c .*runtime\.c/);
  assert.match(recipe, /wasm-linux-fork-cc -pthread runtime\.o raw-clone\.o -o raw\.wasm/);
  assert.match(recipe, /wasm-linux-fork-finalize raw\.wasm/);
  assert.ok(!recipe.includes("--asyncify"));
  const scope = readFileSync(new URL("../default.nix", import.meta.url), "utf8");
  assert.match(scope, /sdk-fork-continuation = self\.sdk-fork-continuation-wasm64/);
});

test("fork execution object is linked through the sysroot executable response file", () => {
  const recipe = readFileSync(new URL("./sdk.nix", import.meta.url), "utf8");
  assert.ok(recipe.includes("linkRoot = import ../sdk/link-sysroot.nix"));
  assert.match(recipe, /executableArgs\s*=\s*\[\s*"\$\{execution\}\/fork-execution\.o"\s*\]/);
  assert.ok(recipe.includes('executableResponse = "${linkRoot}/lib/wasm-linux-executable.rsp"'));
  const configStart = recipe.indexOf("  config = pkgs.writeText");
  const configEnd = recipe.indexOf("  cc = pkgs.writeShellApplication", configStart);
  assert.ok(configStart >= 0 && configEnd > configStart);
  const config = recipe.slice(configStart, configEnd);
  assert.match(config, /--target=\$\{platform\.targetTriple\}/);
  assert.match(config, /--sysroot=\$\{linkRoot\}/);
  assert.ok(config.includes("platform.compilerFlags"));
  assert.ok(
    config.includes('lib.optional cooperativePoll "-fsanitize-coverage=trace-pc,no-prune,edge"'),
  );
  assert.ok(!config.includes("${execution}"), "execution inputs belong to the link response");
  assert.ok(!config.includes("platform.linkerFlags"), "link defaults belong to the response");
  assert.ok(recipe.includes("-c ${./execution.c} -o $out/fork-execution.o"));
  assert.ok(
    recipe.includes(
      'grep -F -- ${lib.escapeShellArg "${execution}/fork-execution.o"} ${linkRoot}/lib/wasm-linux-executable.rsp',
    ),
  );
  assert.ok(recipe.includes("cp -r ${./.} $out/recipes/fork-continuation"));
  assert.ok(recipe.includes("cp ${config} $out/recipes/compiler.cfg"));
  assert.ok(recipe.includes("ln -s ${linkRoot} $out/actualsysroot"));
  assert.ok(recipe.includes("ln -s ${sdk.buildMaterials} $out/default-sdk-build-materials"));
  assert.ok(recipe.includes("ln -s ${sdk.sourceBundle} $out/default-sdk-selected-sources"));
});

test("automatic finalization is opt-in and records its pinned driver configuration", () => {
  const recipe = readFileSync(new URL("./sdk.nix", import.meta.url), "utf8");
  assert.match(recipe, /automaticFinalize \? false/);
  assert.match(recipe, /lib\.optionalString automaticFinalize "-auto"/);
  assert.match(recipe, /automaticFinalization = automaticFinalize/);
  assert.match(recipe, /requiresFinalization = !automaticFinalize/);

  const configStart = recipe.indexOf("  config = pkgs.writeText");
  const configEnd = recipe.indexOf("  cc = pkgs.writeShellApplication", configStart);
  assert.ok(configStart >= 0 && configEnd > configStart);
  const config = recipe.slice(configStart, configEnd);
  assert.match(config, /lib\.optional automaticFinalize "--wasm-fork-asyncify"/);
  assert.match(config, /lib\.optional automaticFinalize "-B\$\{pkgs\.binaryen\}\/bin"/);
  assert.ok(!config.includes("$--wasm-fork-asyncify"));

  assert.match(recipe, /name = "wasm-linux-fork-finalize"/);
  assert.match(recipe, /paths = \[\s*cc\s*finalize\s*metadata\s*\]/);
  assert.ok(recipe.includes("cp ${config} $out/recipes/compiler.cfg"));
  assert.ok(recipe.includes("ln -s ${pkgs.binaryen.src} $out/binaryen-source"));
});

test("libc polling fork profile requires application polling and selects ABI 2", () => {
  const recipe = readFileSync(new URL("./sdk.nix", import.meta.url), "utf8");
  assert.match(recipe, /cooperativePoll \? false/);
  assert.match(recipe, /libraryCoverage \? false/);
  assert.match(recipe, /assert !libraryCoverage \|\| cooperativePoll/);
  assert.match(recipe, /enableCooperativePoll = libraryCoverage/);
  assert.match(recipe, /-DWASM_FORK_POLL_LIBC=1/);
  assert.match(recipe, /-DWASM_POLL_THREAD_GLOBAL=1/);
  assert.match(recipe, /libraryPolling = libraryCoverage/);
  assert.match(
    recipe,
    /userPollAbi =\s*if libraryCoverage then\s*2\s*else if cooperativePoll then\s*1\s*else\s*null/,
  );
  assert.match(recipe, /optionalString libraryCoverage "-libc"/);
  assert.match(recipe, /forkMusl\.patches/);
  assert.match(recipe, /cp \$\{muslProfile\} \$out\/recipes\/fork-musl-profile\.json/);
});
