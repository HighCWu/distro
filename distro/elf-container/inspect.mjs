#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OS_SEGMENT_TYPE = 0x60005741;
const MAX_FILE_SIZE = 0xffffffffn;
const ELF_IDENT_SIZE = 16;
const WASM_HEADER_SIZE = 8;
const CARRIER_HEADER_SIZE = 32;
const CARRIER_MAGIC = Buffer.from([
  0x4c, 0x49, 0x4e, 0x55, 0x58, 0x2e, 0x57, 0x41, 0x53, 0x4d, 0, 0,
]);
const WASM_MAGIC_AND_VERSION = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);

function fail(message) {
  throw new Error(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function u16(buffer, offset) {
  check(offset + 2 <= buffer.length, "truncated ELF header");
  return buffer.readUInt16LE(offset);
}

function u32(buffer, offset) {
  check(offset + 4 <= buffer.length, "truncated ELF header");
  return buffer.readUInt32LE(offset);
}

function u64(buffer, offset) {
  check(offset + 8 <= buffer.length, "truncated ELF header");
  return buffer.readBigUInt64LE(offset);
}

export function parseElfContainer(bytes, expectedBits) {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  check(expectedBits === 32 || expectedBits === 64, "expected address width must be 32 or 64");
  check(
    BigInt(buffer.length) <= MAX_FILE_SIZE,
    "ELF file exceeds the supported u32 file-size limit",
  );
  check(buffer.length >= ELF_IDENT_SIZE, "truncated ELF identification");
  check(buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), "invalid ELF magic");

  const elfClass = expectedBits === 32 ? 1 : 2;
  check(buffer[4] === elfClass, "ELF class does not match expected address width");
  check(buffer[5] === 1, "ELF data encoding must be little-endian");
  check(buffer[6] === 1, "ELF identification version must be current");
  check(buffer[7] === 3, "ELF OSABI must be Linux");
  check(buffer[8] === 0, "ELF ABI version must be zero");
  for (let i = 9; i < ELF_IDENT_SIZE; i++)
    check(buffer[i] === 0, "ELF identification padding must be zero");

  const is64 = expectedBits === 64;
  const elfHeaderSize = is64 ? 64 : 52;
  const phdrOffset = is64 ? 64 : 52;
  const phdrEntrySize = is64 ? 56 : 32;
  const segmentOffset = is64 ? 120 : 84;
  const moduleOffset = is64 ? 152 : 116;

  check(buffer.length >= moduleOffset, "truncated ELF header or carrier prefix");
  check(u16(buffer, 16) === 2, "ELF type must be ET_EXEC");
  check(u16(buffer, 18) === 0, "ELF machine must be EM_NONE");
  check(u32(buffer, 20) === 1, "ELF version must be current");

  if (is64) {
    check(u64(buffer, 24) === 0n, "ELF entry point must be zero");
    check(u64(buffer, 32) === BigInt(phdrOffset), "ELF program header offset is not canonical");
    check(u64(buffer, 40) === 0n, "ELF section header offset must be zero");
    check(u32(buffer, 48) === 0, "ELF flags must be zero");
  } else {
    check(u32(buffer, 24) === 0, "ELF entry point must be zero");
    check(u32(buffer, 28) === phdrOffset, "ELF program header offset is not canonical");
    check(u32(buffer, 32) === 0, "ELF section header offset must be zero");
    check(u32(buffer, 36) === 0, "ELF flags must be zero");
  }

  check(u16(buffer, is64 ? 52 : 40) === elfHeaderSize, "ELF header size is not canonical");
  check(
    u16(buffer, is64 ? 54 : 42) === phdrEntrySize,
    "ELF program header entry size is not canonical",
  );
  check(u16(buffer, is64 ? 56 : 44) === 1, "ELF must contain exactly one program header");
  check(u16(buffer, is64 ? 58 : 46) === 0, "ELF section header entry size must be zero");
  check(u16(buffer, is64 ? 60 : 48) === 0, "ELF section header count must be zero");
  check(u16(buffer, is64 ? 62 : 50) === 0, "ELF section name table index must be zero");

  check(u32(buffer, phdrOffset) === OS_SEGMENT_TYPE, "unexpected ELF program header type");
  const flags = is64 ? u32(buffer, phdrOffset + 4) : u32(buffer, phdrOffset + 24);
  check(flags === 4, "carrier program header flags must be PF_R");

  let pOffset;
  let pFileSize;
  let pVaddr;
  let pPaddr;
  let pMemSize;
  let pAlign;
  if (is64) {
    pOffset = u64(buffer, phdrOffset + 8);
    pVaddr = u64(buffer, phdrOffset + 16);
    pPaddr = u64(buffer, phdrOffset + 24);
    pFileSize = u64(buffer, phdrOffset + 32);
    pMemSize = u64(buffer, phdrOffset + 40);
    pAlign = u64(buffer, phdrOffset + 48);
    check(pOffset === BigInt(segmentOffset), "carrier segment offset is not canonical");
  } else {
    pOffset = BigInt(u32(buffer, phdrOffset + 4));
    pVaddr = BigInt(u32(buffer, phdrOffset + 8));
    pPaddr = BigInt(u32(buffer, phdrOffset + 12));
    pFileSize = BigInt(u32(buffer, phdrOffset + 16));
    pMemSize = BigInt(u32(buffer, phdrOffset + 20));
    pAlign = BigInt(u32(buffer, phdrOffset + 28));
    check(pOffset === BigInt(segmentOffset), "carrier segment offset is not canonical");
  }
  check(pVaddr === 0n && pPaddr === 0n, "carrier segment addresses must be zero");
  check(pMemSize === 0n, "carrier segment memory size must be zero");
  check(pAlign === 4n, "carrier segment alignment must be four");

  const carrierOffset = Number(pOffset);
  check(
    buffer.subarray(carrierOffset, carrierOffset + CARRIER_MAGIC.length).equals(CARRIER_MAGIC),
    "invalid carrier magic",
  );
  check(u32(buffer, carrierOffset + 12) === 1, "unsupported carrier version");
  check(
    u32(buffer, carrierOffset + 16) === expectedBits,
    "carrier address width does not match expected width",
  );
  check(u32(buffer, carrierOffset + 20) === 0, "carrier reserved field must be zero");

  const moduleSizeBig = u64(buffer, carrierOffset + 24);
  check(moduleSizeBig >= BigInt(WASM_HEADER_SIZE), "embedded Wasm module is too short");
  check(
    moduleSizeBig <= MAX_FILE_SIZE,
    "embedded Wasm module exceeds the supported u32 size limit",
  );
  const expectedSegmentSize = BigInt(CARRIER_HEADER_SIZE) + moduleSizeBig;
  check(pFileSize === expectedSegmentSize, "ELF segment length does not match the carrier header");
  check(
    BigInt(segmentOffset) + pFileSize === BigInt(buffer.length),
    "ELF file has truncated payload or trailing bytes",
  );
  check(
    BigInt(moduleOffset) + moduleSizeBig <= MAX_FILE_SIZE,
    "ELF file exceeds the supported u32 file-size limit",
  );

  const moduleSize = Number(moduleSizeBig);
  const payload = buffer.subarray(moduleOffset, moduleOffset + moduleSize);
  check(
    payload.subarray(0, WASM_HEADER_SIZE).equals(WASM_MAGIC_AND_VERSION),
    "embedded payload is not a version 1 Wasm module",
  );
  return { moduleOffset, moduleSize, addressBits: expectedBits };
}

function sameFile(sourcePath, outputPath, sourceStat) {
  const outputAbsolute = resolve(outputPath);
  const outputParent = realpathSync(dirname(outputAbsolute));
  const outputCanonical = resolve(outputParent, basename(outputAbsolute));
  if (realpathSync(sourcePath) === outputCanonical) return true;
  if (!existsSync(outputPath)) return false;
  const outputStat = statSync(outputPath, { bigint: true });
  return sourceStat.dev === outputStat.dev && sourceStat.ino === outputStat.ino;
}

function writeAtomically(outputPath, contents) {
  const outputAbsolute = resolve(outputPath);
  const directory = realpathSync(dirname(outputAbsolute));
  const target = resolve(directory, basename(outputAbsolute));
  let temporaryPath;
  let descriptor;
  for (let attempt = 0; attempt < 20; attempt++) {
    temporaryPath = resolve(
      directory,
      `.${basename(target)}.elf-container-${process.pid}-${attempt}`,
    );
    try {
      descriptor = openSync(temporaryPath, "wx", 0o666);
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
  }
  check(descriptor !== undefined, "could not create temporary output file");
  try {
    writeFileSync(descriptor, contents);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, target);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
}

function main(argv) {
  check(argv.length === 5, "usage: node inspect.mjs INPUT EXPECTED_BITS OUTPUT_RAW_WASM");
  const [, , inputPath, bitsArgument, outputPath] = argv;
  check(bitsArgument === "32" || bitsArgument === "64", "expected address width must be 32 or 64");
  const expectedBits = Number(bitsArgument);
  const inputStat = statSync(inputPath, { bigint: true });
  check(inputStat.size <= MAX_FILE_SIZE, "ELF file exceeds the supported u32 file-size limit");
  check(
    !sameFile(inputPath, outputPath, inputStat),
    "input and output paths refer to the same file",
  );
  const source = readFileSync(inputPath);
  const result = parseElfContainer(source, expectedBits);
  const payload = source.subarray(result.moduleOffset, result.moduleOffset + result.moduleSize);
  writeAtomically(outputPath, payload);
  process.stdout.write(
    `${JSON.stringify({
      format: "linux-wasm-elf-container",
      version: 1,
      addressBits: expectedBits,
      moduleSize: result.moduleSize,
      moduleOffset: result.moduleOffset,
      fileSize: source.length,
    })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`elf-container inspect: ${message}\n`);
    process.exitCode = 1;
  }
}
