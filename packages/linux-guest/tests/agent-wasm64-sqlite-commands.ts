// SPDX-License-Identifier: MIT
export const sqliteWrite =
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
export const sqliteRead =
  "PRAGMA integrity_check; SELECT count(*) FROM t; SELECT n||':'||hex(b) FROM t;";
export const sqliteExpected = "ok\n1\n9007199254740993:00FF2A0080\n";
