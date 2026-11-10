// SPDX-License-Identifier: MIT
#include <sqlite3.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#define LARGE_VALUE INT64_C(4294967297)

static int check_integer(sqlite3 *database, const char *sql, int bind_value,
                         sqlite3_int64 bound, sqlite3_int64 expected) {
  sqlite3_stmt *statement = NULL;
  int status = sqlite3_prepare_v2(database, sql, -1, &statement, NULL);
  if (status == SQLITE_OK && bind_value)
    status = sqlite3_bind_int64(statement, 1, bound);
  if (status == SQLITE_OK)
    status = sqlite3_step(statement);

  sqlite3_int64 actual = 0;
  if (status == SQLITE_ROW) {
    actual = sqlite3_column_int64(statement, 0);
    status = sqlite3_step(statement);
    if (status == SQLITE_DONE)
      status = SQLITE_OK;
  }

  int finalize_status = sqlite3_finalize(statement);
  if (status == SQLITE_OK && finalize_status != SQLITE_OK)
    status = finalize_status;
  if (status == SQLITE_OK && actual != expected)
    status = SQLITE_MISMATCH;
  return status;
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fputs("usage: sqlite3-extension-runtime-client EXTENSION\n", stderr);
    return EXIT_FAILURE;
  }

  sqlite3 *database = NULL;
  char *extension_error = NULL;
  int status = sqlite3_open(":memory:", &database);
  if (status != SQLITE_OK)
    goto failure;

  status = sqlite3_enable_load_extension(database, 1);
  if (status != SQLITE_OK)
    goto failure;

  status = sqlite3_load_extension(database, argv[1], NULL, &extension_error);
  if (status != SQLITE_OK || extension_error != NULL)
    goto failure;

  status = check_integer(database, "SELECT wasm_answer(2)", 0, 0, 42);
  if (status != SQLITE_OK)
    goto failure;
  status = check_integer(database, "SELECT wasm_state()", 0, 0, 1002);
  if (status != SQLITE_OK)
    goto failure;

  status = check_integer(database, "SELECT ?1", 1, LARGE_VALUE, LARGE_VALUE);
  if (status != SQLITE_OK)
    goto failure;

  status = sqlite3_close(database);
  if (status != SQLITE_OK)
    goto failure;
  database = NULL;

  puts("sqlite3-extension-runtime: linked client passed load, callback, and 64-bit checks");
  return EXIT_SUCCESS;

failure:
  fprintf(stderr, "sqlite3-extension-runtime: linked client failed (%d)", status);
  if (extension_error != NULL)
    fprintf(stderr, ": %s", extension_error);
  else if (database != NULL)
    fprintf(stderr, ": %s", sqlite3_errmsg(database));
  fputc('\n', stderr);
  if (extension_error != NULL)
    sqlite3_free(extension_error);
  if (database != NULL)
    sqlite3_close(database);
  return EXIT_FAILURE;
}
