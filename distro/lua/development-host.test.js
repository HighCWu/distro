// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const metadata = readFileSync(new URL("./lua.pc.in", import.meta.url), "utf8");
const stage =
  "Lua embedding: installed archive, C callbacks, integer64, errors and coroutine verified";

function hostDirectory(query, variable, option, prefix, file) {
  // Some distributions use includedir=/usr/include but Cflags names a versioned
  // subdirectory. Likewise a multiarch -L may be more specific than libdir.
  const flags = query(option).trim().split(/\s+/);
  const candidates = flags
    .filter((flag) => flag.startsWith(prefix))
    .map((flag) => flag.slice(prefix.length));
  candidates.push(query(`--variable=${variable}`).trim());
  const directory = candidates.find((path) => path && existsSync(join(path, file)));
  assert.ok(directory, `native Lua ${file} not found; configure LUA_HOST_INCLUDE/LUA_HOST_ARCHIVE`);
  return directory;
}

test("explicit development layout survives Nix multiple-output fixup policy", () => {
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.match(recipe, /moveToDev = false;/);
  assert.match(recipe, /outputDoc = "dev";/);
  for (const [source, destination] of [
    ["../sdk/lua-example.c", "embedding.c"],
    ["./development-README.md", "README.md"],
    ["../sdk/LICENSE.MIT", "LICENSE.MIT"],
  ]) {
    assert.ok(recipe.includes(`cp \${${source}} $dev/share/doc/lua/examples/${destination}`));
  }
  assert.ok(recipe.includes("cp relocated/share/doc/lua/examples/embedding.c lua-example.c"));
  assert.match(recipe, /-DLINUX_WASM_TEST_INIT/);
  assert.match(recipe, /application = vm-test\.installedTest/);
});

function workspace(run) {
  const root = mkdtempSync(join(tmpdir(), "linux-wasm-lua-dev-"));
  const original = join(root, "original");
  const relocated = join(root, "relocated");
  const empty = join(root, "empty");
  mkdirSync(join(original, "lib/pkgconfig"), { recursive: true });
  mkdirSync(join(original, "include"));
  mkdirSync(empty);
  writeFileSync(join(original, "lib/pkgconfig/lua.pc"), metadata.replaceAll("@version@", "5.4.8"));
  const query = (prefix, args) =>
    spawnSync("pkg-config", args, {
      encoding: "utf8",
      env: {
        ...process.env,
        PKG_CONFIG_LIBDIR: empty,
        PKG_CONFIG_PATH: join(prefix, "lib/pkgconfig"),
        PKG_CONFIG_SYSROOT_DIR: "/",
      },
    });
  try {
    run({ root, original, relocated, query });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("Lua static metadata follows a relocated dev output and forbids host fallback", () => {
  workspace(({ original, relocated, query }) => {
    for (const prefix of [original, relocated]) {
      if (prefix === relocated) renameSync(original, relocated);
      assert.equal(query(prefix, ["--modversion", "lua"]).stdout, "5.4.8\n");
      for (const [variable, path] of [
        ["libdir", "lib"],
        ["includedir", "include"],
      ]) {
        const value = query(prefix, [`--variable=${variable}`, "lua"]);
        assert.equal(value.status, 0, value.stderr);
        assert.equal(realpathSync(value.stdout.trim()), join(prefix, path));
      }
      const flags = query(prefix, ["--static", "--cflags", "--libs", "lua"]);
      assert.equal(flags.status, 0, flags.stderr);
      for (const flag of ["-llua", "-lm"]) assert.ok(flags.stdout.split(/\s+/).includes(flag));
      assert.ok(flags.stdout.includes(prefix));
      if (prefix === relocated) assert.ok(!flags.stdout.includes(original));
    }
    unlinkSync(join(relocated, "lib/pkgconfig/lua.pc"));
    assert.notEqual(query(relocated, ["--exists", "lua"]).status, 0);
  });
});

test("native Lua discovery honors versioned headers and multiarch flags rather than parent variables", () => {
  workspace(({ original, query }) => {
    const include = join(original, "include/lua5.4");
    const library = join(original, "lib/test-multiarch");
    mkdirSync(include);
    mkdirSync(library);
    writeFileSync(join(include, "lua.h"), "/* discovery fixture */\n");
    writeFileSync(join(library, "liblua5.4.a"), "discovery fixture\n");
    writeFileSync(
      join(original, "lib/pkgconfig/native-lua.pc"),
      `
Name: Native Lua discovery fixture
Description: Parent variables deliberately do not contain headers/archive
Version: 5.4
includedir=${original}/include
libdir=${original}/lib
Cflags: -I${include}
Libs: -L${library} -llua5.4
`,
    );
    const nativeQuery = (option) => {
      const result = query(original, [option, "native-lua"]);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    assert.equal(
      hostDirectory(nativeQuery, "includedir", "--cflags-only-I", "-I", "lua.h"),
      include,
    );
    assert.equal(
      hostDirectory(nativeQuery, "libdir", "--libs-only-L", "-L", "liblua5.4.a"),
      library,
    );
    unlinkSync(join(include, "lua.h"));
    assert.throws(
      () => hostDirectory(nativeQuery, "includedir", "--cflags-only-I", "-I", "lua.h"),
      /not found/,
    );
  });
});

test("C embedding consumer uses copied native headers and archive with GCC and Clang", () => {
  workspace(({ root, original, relocated, query }) => {
    const hostQuery = (option) => {
      const result = spawnSync("pkg-config", [option, "lua5.4"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PKG_CONFIG_ALLOW_SYSTEM_CFLAGS: "1",
          PKG_CONFIG_ALLOW_SYSTEM_LIBS: "1",
        },
      });
      assert.equal(
        result.status,
        0,
        "install liblua5.4-dev or configure LUA_HOST_INCLUDE/LUA_HOST_ARCHIVE",
      );
      return result.stdout.trim();
    };
    const include =
      process.env.LUA_HOST_INCLUDE ??
      hostDirectory(hostQuery, "includedir", "--cflags-only-I", "-I", "lua.h");
    const archive =
      process.env.LUA_HOST_ARCHIVE ??
      join(hostDirectory(hostQuery, "libdir", "--libs-only-L", "-L", "liblua5.4.a"), "liblua5.4.a");
    for (const header of ["lua.h", "luaconf.h", "lauxlib.h", "lualib.h"])
      cpSync(join(include, header), join(original, "include", header));
    cpSync(archive, join(original, "lib/liblua.a"));
    const examples = join(original, "share/doc/lua/examples");
    mkdirSync(examples, { recursive: true });
    cpSync(new URL("../sdk/lua-example.c", import.meta.url), join(examples, "embedding.c"));
    renameSync(original, relocated);
    const flags = query(relocated, ["--static", "--cflags", "--libs", "lua"]);
    assert.equal(flags.status, 0, flags.stderr);
    const source = join(relocated, "share/doc/lua/examples/embedding.c");
    for (const compiler of ["gcc", "clang"]) {
      const executable = join(root, `lua-consumer-${compiler}`);
      const built = spawnSync(
        compiler,
        [
          "-std=c11",
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          source,
          ...flags.stdout.trim().split(/\s+/),
          "-o",
          executable,
        ],
        { encoding: "utf8" },
      );
      assert.equal(built.status, 0, `${compiler}: ${built.stderr}`);
      const result = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
      assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
      assert.ok(result.stdout.includes(stage));
      assert.match(result.stdout, /^::vm-test::pass$/m);
      assert.doesNotMatch(result.stdout, /::vm-test::fail/);
    }
  });
});
