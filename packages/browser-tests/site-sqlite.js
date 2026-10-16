// SPDX-License-Identifier: MIT

const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

// Shared by the real terminal scenario and the native command-contract tests.
// SQLite's normal Unix VFS owns transactions and file synchronization. The
// explicit sync before reload also covers filesystem metadata/writeback.
export function sqlitePersistenceCommands(path) {
  const database = quote(path);
  const write =
    [
      "PRAGMA journal_mode=DELETE",
      "PRAGMA synchronous=FULL",
      "CREATE TABLE t(n INTEGER NOT NULL, b BLOB NOT NULL)",
      "BEGIN IMMEDIATE",
      "INSERT INTO t VALUES(9007199254740993,X'00ff2a0080')",
      "COMMIT",
      "BEGIN",
      "UPDATE t SET n=99",
      "ROLLBACK",
    ].join("; ") + ";";
  const read = "PRAGMA integrity_check; SELECT count(*) FROM t; SELECT n||':'||hex(b) FROM t;";
  const expected = "ok\\n1\\n9007199254740993:00FF2A0080";
  return {
    write: `sqlite3 -batch -bail ${database} ${quote(write)} && sync && printf 'sqlite-persistence-%s\\n' synced`,
    read: `result=$(sqlite3 -batch -bail -readonly ${database} ${quote(read)}) && test "$result" = "$(printf ${quote(expected)})" && printf 'sqlite-persistence-%s\\n' restored`,
  };
}
