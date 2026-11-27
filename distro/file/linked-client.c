// SPDX-License-Identifier: MIT
#include <magic.h>
#include <stdio.h>
#include <string.h>

int main(void) {
  magic_t cookie = magic_open(MAGIC_MIME_TYPE);
  if (!cookie)
    return 1;
  int status = 2;
  if (magic_load(cookie, "/usr/share/misc/magic.mgc") != 0)
    goto done;
  static const char sample[] = "hello, this is plain ascii text\n";
  const char *mime = magic_buffer(cookie, sample, sizeof(sample) - 1);
  if (!mime || strcmp(mime, "text/plain") != 0)
    goto done;
  status = 0;
done:
  magic_close(cookie);
  if (status == 0)
    puts("libmagic: static pkg-config consumer passed");
  return status;
}
