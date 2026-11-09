// SPDX-License-Identifier: MIT
#include <stddef.h>
#include <sqlite3ext.h>
SQLITE_EXTENSION_INIT1

static unsigned int wasm_call_count;
static int wasm_last_input;

static void wasm_answer(sqlite3_context *context, int argc, sqlite3_value **argv)
{
    if (argc != 1) {
        sqlite3_result_error(context, "wasm_answer expects one argument", -1);
        return;
    }

    wasm_last_input = sqlite3_value_int(argv[0]);
    wasm_call_count++;
    sqlite3_result_int64(context, (sqlite3_int64)wasm_last_input + 40);
}

static void wasm_state(sqlite3_context *context, int argc, sqlite3_value **argv)
{
    (void)argv;
    if (argc != 0) {
        sqlite3_result_error(context, "wasm_state expects no arguments", -1);
        return;
    }

    sqlite3_result_int64(context,
                         (sqlite3_int64)wasm_call_count * 1000 + wasm_last_input);
}

int sqlite3_extension_init(sqlite3 *database, char **error_message,
                           const sqlite3_api_routines *api)
{
    (void)error_message;
    SQLITE_EXTENSION_INIT2(api);

    int status = sqlite3_create_function(database, "wasm_answer", 1, SQLITE_UTF8,
                                         NULL, wasm_answer, NULL, NULL);
    if (status != SQLITE_OK)
        return status;

    return sqlite3_create_function(database, "wasm_state", 0, SQLITE_UTF8,
                                   NULL, wasm_state, NULL, NULL);
}
