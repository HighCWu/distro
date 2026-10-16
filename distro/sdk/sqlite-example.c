/* SPDX-License-Identifier: MIT */
#include <errno.h>
#include <sqlite3.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __wasm__
#include <sched.h>
#endif

#define REQUIRE(test) do { if (!(test)) { \
    fprintf(stderr, "SQLite check failed at line %d: %s (%s)\n", \
            __LINE__, #test, db ? sqlite3_errmsg(db) : "no database"); \
    goto done; \
} } while (0)

static int sql(sqlite3 *db, const char *text)
{
    char *error = NULL;
    int rc = sqlite3_exec(db, text, NULL, NULL, &error);
    if (rc != SQLITE_OK)
        fprintf(stderr, "SQL failed: %s: %s\n", text, error ? error : "unknown");
    sqlite3_free(error);
    return rc == SQLITE_OK;
}

static int finish(sqlite3_stmt **stmt)
{
    int rc = sqlite3_finalize(*stmt);
    *stmt = NULL;
    return rc == SQLITE_OK;
}

int main(void)
{
    sqlite3 *db = NULL;
    sqlite3_stmt *stmt = NULL;
    const sqlite3_int64 value = INT64_C(9007199254740993);
    const unsigned char blob[] = {0, 255, 42, 0, 128};
    char directory[] = "/tmp/sdk-sqlite-XXXXXX";
    char path[128] = "";
    int created = 0, result = EXIT_FAILURE;

    REQUIRE(strcmp(sqlite3_libversion(), SQLITE_VERSION) == 0);
    REQUIRE(sqlite3_threadsafe() != 0);
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
    REQUIRE(sql(db, "CREATE TABLE t(n INTEGER, b BLOB); BEGIN"));
    REQUIRE(sqlite3_prepare_v2(db, "INSERT INTO t VALUES(?,?)", -1, &stmt, NULL) == SQLITE_OK);
    REQUIRE(sqlite3_bind_int64(stmt, 1, value) == SQLITE_OK);
    REQUIRE(sqlite3_bind_blob(stmt, 2, blob, sizeof(blob), SQLITE_TRANSIENT) == SQLITE_OK);
    REQUIRE(sqlite3_step(stmt) == SQLITE_DONE);
    REQUIRE(finish(&stmt));
    REQUIRE(sql(db, "COMMIT; BEGIN; DELETE FROM t; ROLLBACK"));
    REQUIRE(sqlite3_prepare_v2(db, "SELECT n,b FROM t", -1, &stmt, NULL) == SQLITE_OK);
    REQUIRE(sqlite3_step(stmt) == SQLITE_ROW);
    REQUIRE(sqlite3_column_int64(stmt, 0) == value);
    REQUIRE(sqlite3_column_bytes(stmt, 1) == (int)sizeof(blob));
    REQUIRE(sqlite3_column_blob(stmt, 1) != NULL);
    REQUIRE(memcmp(sqlite3_column_blob(stmt, 1), blob, sizeof(blob)) == 0);
    REQUIRE(sqlite3_step(stmt) == SQLITE_DONE);
    REQUIRE(finish(&stmt));
    REQUIRE(sqlite3_close(db) == SQLITE_OK);
    db = NULL;
    puts("SDK SQLite: in-memory bindings and rollback verified");

    REQUIRE(mkdir("/tmp", 01777) == 0 || errno == EEXIST);
    REQUIRE(mkdtemp(directory) != NULL);
    created = 1;
    REQUIRE(snprintf(path, sizeof(path), "%s/data.sqlite", directory) < (int)sizeof(path));
    REQUIRE(sqlite3_open(path, &db) == SQLITE_OK);
    REQUIRE(sql(db, "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;"
                    "CREATE TABLE t(n INTEGER); BEGIN; INSERT INTO t VALUES(42); COMMIT;"
                    "BEGIN; UPDATE t SET n=99; ROLLBACK"));
    REQUIRE(sqlite3_close(db) == SQLITE_OK);
    db = NULL;
    REQUIRE(sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, NULL) == SQLITE_OK);
    REQUIRE(sqlite3_prepare_v2(db, "SELECT n FROM t", -1, &stmt, NULL) == SQLITE_OK);
    REQUIRE(sqlite3_step(stmt) == SQLITE_ROW);
    REQUIRE(sqlite3_column_int(stmt, 0) == 42);
    REQUIRE(sqlite3_step(stmt) == SQLITE_DONE);
    REQUIRE(finish(&stmt));
    REQUIRE(sqlite3_prepare_v2(db, "PRAGMA integrity_check", -1, &stmt, NULL) == SQLITE_OK);
    REQUIRE(sqlite3_step(stmt) == SQLITE_ROW);
    REQUIRE(sqlite3_column_text(stmt, 0) != NULL);
    REQUIRE(strcmp((const char *)sqlite3_column_text(stmt, 0), "ok") == 0);
    REQUIRE(sqlite3_step(stmt) == SQLITE_DONE);
    REQUIRE(finish(&stmt));
    REQUIRE(sqlite3_close(db) == SQLITE_OK);
    db = NULL;
    REQUIRE(unlink(path) == 0);
    path[0] = '\0';
    REQUIRE(rmdir(directory) == 0);
    created = 0;
    puts("SDK SQLite: file commit, rollback, reopen and integrity verified");
    result = EXIT_SUCCESS;
done:
    if (stmt) sqlite3_finalize(stmt);
    if (db) sqlite3_close(db);
    if (path[0]) unlink(path);
    if (created) rmdir(directory);
    puts(result == EXIT_SUCCESS ? "::vm-test::pass" : "::vm-test::fail");
    fflush(NULL);
#ifdef __wasm__
    if (result == EXIT_SUCCESS)
        for (;;) sched_yield();
#endif
    return result;
}
