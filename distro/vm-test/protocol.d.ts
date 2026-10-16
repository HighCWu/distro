// SPDX-License-Identifier: MIT
export const PASS: "::vm-test::pass";
export const FAIL: "::vm-test::fail";
export interface ConsoleOutput {
  write(text: string): unknown;
}
export function writeConsoleLines(
  output: ConsoleOutput,
  lines: readonly string[],
  consumeLine: (line: string) => void,
): void;
export class LineDecoder {
  write(chunk: Uint8Array): string[];
  close(): string[];
}
export function parseResult(
  line: string,
): { passed: true } | { passed: false; reason: string } | undefined;
