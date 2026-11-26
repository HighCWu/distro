// SPDX-License-Identifier: MIT
#include <jq.h>
#include <stdio.h>
#include <string.h>

int main(void) {
  jq_state *state = jq_init();
  if (!state)
    return 1;
  int status = 2;
  if (!jq_compile(state, ".[] | select(test(\"^[a-z]+[0-9]{2}$\")) | ascii_upcase"))
    goto done;

  jq_start(state, jv_parse("[\"a12\",\"nomatch\",\"b3\",\"zz04\"]"), 0);
  const char *expected[] = {"A12", "ZZ04"};
  for (size_t i = 0; i < sizeof(expected) / sizeof(expected[0]); ++i) {
    jv item = jq_next(state);
    const int matches =
        jv_get_kind(item) == JV_KIND_STRING && strcmp(jv_string_value(item), expected[i]) == 0;
    jv_free(item);
    if (!matches) {
      status = 3;
      goto done;
    }
  }

  jv end = jq_next(state);
  const int complete = !jv_is_valid(end) && !jv_invalid_has_msg(jv_copy(end));
  jv_free(end);
  status = complete ? 0 : 4;
done:
  jq_teardown(&state);
  if (status == 0)
    puts("libjq: static pkg-config regex consumer passed");
  return status;
}
