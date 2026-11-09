// SPDX-License-Identifier: MIT
#define _GNU_SOURCE

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static size_t page_size;

static void
die (const char *message)
{
  fprintf (stderr, "mremap DONTUNMAP failure: %s (errno=%d)\n", message, errno);
  exit (EXIT_FAILURE);
}

static void
require (int condition, const char *message)
{
  if (!condition)
    die (message);
}

static unsigned char *
map_pages (size_t count, const char *message)
{
  void *mapping = mmap (NULL, count * page_size, PROT_READ | PROT_WRITE,
			MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (mapping == MAP_FAILED)
    die (message);
  return mapping;
}

static void
unmap_pages (void *mapping, size_t count, const char *message)
{
  if (munmap (mapping, count * page_size) != 0)
    die (message);
}

static void
fill_pages (unsigned char *mapping, size_t count, unsigned char first)
{
  for (size_t page = 0; page < count; page++)
    memset (mapping + page * page_size, (unsigned char) (first + page), page_size);
}

static int
page_is (const unsigned char *mapping, size_t page, unsigned char expected)
{
  const unsigned char *bytes = mapping + page * page_size;
  for (size_t i = 0; i < page_size; i++)
    if (bytes[i] != expected)
      return 0;
  return 1;
}

static void
require_page (const unsigned char *mapping, size_t page,
	      unsigned char expected, const char *message)
{
  if (!page_is (mapping, page, expected))
    die (message);
}

static void
require_zero (const unsigned char *mapping, size_t count, const char *message)
{
  for (size_t page = 0; page < count; page++)
    require_page (mapping, page, 0, message);
}

static void
require_sequence (const unsigned char *mapping, size_t count,
		  unsigned char first, const char *message)
{
  for (size_t page = 0; page < count; page++)
    require_page (mapping, page, (unsigned char) (first + page), message);
}

static void
stage (const char *marker)
{
  puts (marker);
  if (fflush (stdout) != 0)
    die ("flush stage marker");
}

static void
ordinary_relocation (void)
{
  const size_t count = 2;
  const size_t length = count * page_size;
  unsigned char *source = map_pages (count, "map ordinary source");
  fill_pages (source, count, 0x11);

  unsigned char *moved = mremap (source, length, length,
				 MREMAP_MAYMOVE | MREMAP_DONTUNMAP);
  require (moved != MAP_FAILED, "ordinary DONTUNMAP relocation");
  require (moved != source, "DONTUNMAP must leave a distinct destination");
  require_sequence (moved, count, 0x11, "relocated bytes were not retained");
  require_zero (source, count, "old address was not reset to zero pages");

  memset (source, 0xa1, page_size);
  memset (moved + page_size, 0xb2, page_size);
  require_page (source, 0, 0xa1, "old mapping is not writable after relocation");
  require_page (source, 1, 0, "old mapping did not remain independent");
  require_page (moved, 0, 0x11, "writing old mapping changed the destination");
  require_page (moved, 1, 0xb2, "destination is not independently writable");

  unmap_pages (moved, count, "unmap relocated destination");
  require_page (source, 0, 0xa1, "old mapping died with the destination");
  memset (source + page_size, 0xc3, page_size);
  require_page (source, 1, 0xc3, "old mapping is not accessible after destination unmap");
  unmap_pages (source, count, "unmap retained source");
  stage ("mremap DONTUNMAP: anonymous relocation retains source pass");
}

static void
fixed_topology (void)
{
  const int fixed_flags = MREMAP_MAYMOVE | MREMAP_FIXED | MREMAP_DONTUNMAP;
  const size_t arena_pages = 8;
  const size_t source_page = 1;
  const size_t source_pages = 2;
  const size_t destination_page = 5;
  unsigned char *arena = map_pages (arena_pages, "map fixed reservation");
  fill_pages (arena, arena_pages, 0x20);

  void *destination = arena + destination_page * page_size;
  void *result = mremap (arena + source_page * page_size,
			 source_pages * page_size, source_pages * page_size,
			 fixed_flags, destination);
  require (result == destination, "fixed DONTUNMAP within one reservation");
  require_page (arena, 0, 0x20, "same-reservation move changed prefix neighbor");
  require_page (arena, 1, 0, "same-reservation source page was not reset");
  require_page (arena, 2, 0, "same-reservation source tail was not reset");
  require_page (arena, 3, 0x23, "same-reservation move changed source neighbor");
  require_page (arena, 4, 0x24, "same-reservation move changed gap neighbor");
  require_page (arena, 5, 0x21, "same-reservation destination copy");
  require_page (arena, 6, 0x22, "same-reservation destination copy tail");
  require_page (arena, 7, 0x27, "same-reservation move changed destination neighbor");
  memset (arena + source_page * page_size, 0xa5, page_size);
  memset (arena + (destination_page + 1) * page_size, 0xb6, page_size);
  require_page (arena, source_page, 0xa5, "fixed move old source is not writable");
  require_page (arena, destination_page, 0x21, "fixed source write changed destination");
  require_page (arena, destination_page + 1, 0xb6, "fixed destination is not writable");
  require_page (arena, source_page + 1, 0, "fixed destination write changed old source");
  unmap_pages (arena, arena_pages, "unmap same-reservation arena");

  const size_t backing_pages = 5;
  const size_t interior_page = 1;
  const size_t destination_offset = 2;
  unsigned char *source_backing = map_pages (backing_pages, "map cross-backing source");
  unsigned char *destination_backing = map_pages (backing_pages, "map cross-backing destination");
  require (source_backing != destination_backing,
	   "separate mmap calls returned the same backing address");
  fill_pages (source_backing, backing_pages, 0x40);
  fill_pages (destination_backing, backing_pages, 0x80);
  destination = destination_backing + destination_offset * page_size;
  result = mremap (source_backing + interior_page * page_size,
		   2 * page_size, 2 * page_size, fixed_flags, destination);
  require (result == destination, "fixed DONTUNMAP across separate backings");
  require_page (source_backing, 0, 0x40, "cross-backing move changed source prefix");
  require_page (source_backing, 1, 0, "interior source did not become zero");
  require_page (source_backing, 2, 0, "interior source tail did not become zero");
  require_page (source_backing, 3, 0x43, "cross-backing move changed source suffix");
  require_page (source_backing, 4, 0x44, "cross-backing move changed source end");
  require_page (destination_backing, 0, 0x80, "fixed replacement changed destination prefix");
  require_page (destination_backing, 1, 0x81, "fixed replacement changed destination neighbor");
  require_page (destination_backing, 2, 0x41, "cross-backing destination copy");
  require_page (destination_backing, 3, 0x42, "cross-backing destination copy tail");
  require_page (destination_backing, 4, 0x84, "fixed replacement changed destination suffix");
  memset (source_backing + interior_page * page_size, 0xc7, page_size);
  memset (destination_backing + (destination_offset + 1) * page_size, 0xd8, page_size);
  require_page (source_backing, interior_page, 0xc7, "cross-backing source is not writable");
  require_page (destination_backing, destination_offset, 0x41,
		"cross-backing source write changed destination");
  require_page (destination_backing, destination_offset + 1, 0xd8,
		"cross-backing destination is not writable");
  require_page (source_backing, interior_page + 1, 0,
		"cross-backing destination write changed source");
  unmap_pages (source_backing, backing_pages, "unmap cross-backing source");
  unmap_pages (destination_backing, backing_pages, "unmap cross-backing destination");

  stage ("mremap DONTUNMAP: fixed moves preserve reservation topology pass");
}

static void
expect_einval_unchanged (void *old_address, size_t old_size, size_t new_size,
			 int flags, void *new_address, const char *message,
			 const unsigned char *mapping, size_t page_count,
			 unsigned char first_pattern)
{
  errno = 0;
  void *result;
  if (flags & MREMAP_FIXED)
    result = mremap (old_address, old_size, new_size, flags, new_address);
  else
    result = mremap (old_address, old_size, new_size, flags);
  int error = errno;
  require (result == MAP_FAILED && error == EINVAL, message);
  require_sequence (mapping, page_count, first_pattern,
		    "invalid DONTUNMAP request changed mapping bytes");
}

static void
rejection_and_recovery (void)
{
  const size_t page_count = 6;
  const size_t source_page = 2;
  const size_t source_pages = 2;
  unsigned char *mapping = map_pages (page_count, "map invalid-request fixture");
  fill_pages (mapping, page_count, 0x60);
  unsigned char *source = mapping + source_page * page_size;

  expect_einval_unchanged (source, source_pages * page_size,
			   (source_pages + 1) * page_size,
			   MREMAP_MAYMOVE | MREMAP_DONTUNMAP, NULL,
			   "unequal DONTUNMAP lengths must return EINVAL",
			   mapping, page_count, 0x60);
  expect_einval_unchanged (source, source_pages * page_size,
			   source_pages * page_size, MREMAP_DONTUNMAP, NULL,
			   "DONTUNMAP without MAYMOVE must return EINVAL",
			   mapping, page_count, 0x60);
  expect_einval_unchanged (source, source_pages * page_size,
			   source_pages * page_size,
			   MREMAP_MAYMOVE | MREMAP_FIXED | MREMAP_DONTUNMAP,
			   mapping + (source_page + 1) * page_size,
			   "overlapping fixed DONTUNMAP must return EINVAL",
			   mapping, page_count, 0x60);

  unsigned char *moved = mremap (source, source_pages * page_size,
				 source_pages * page_size,
				 MREMAP_MAYMOVE | MREMAP_DONTUNMAP);
  require (moved != MAP_FAILED && moved != source,
	  "valid DONTUNMAP recovery after rejected requests");
  require_sequence (moved, source_pages, 0x62, "recovery destination bytes");
  require_page (mapping, 0, 0x60, "recovery changed prefix neighbor");
  require_page (mapping, 1, 0x61, "recovery changed preceding neighbor");
  require_page (mapping, source_page, 0, "recovery did not reset old source");
  require_page (mapping, source_page + 1, 0, "recovery did not reset old source tail");
  require_page (mapping, 4, 0x64, "recovery changed following neighbor");
  require_page (mapping, 5, 0x65, "recovery changed suffix neighbor");
  memset (source, 0xe9, page_size);
  require_page (moved, 0, 0x62, "recovery source write changed destination");
  require_page (source, 0, 0xe9, "recovery source is not writable");
  unmap_pages (moved, source_pages, "unmap recovered destination");
  require_page (source, 0, 0xe9, "recovered source died with destination");
  unmap_pages (mapping, page_count, "unmap rejection fixture");
  stage ("mremap DONTUNMAP: invalid moves are atomic and recovery succeeds pass");
}

static void
cleanup_and_lifetime (void)
{
  unsigned char *first = map_pages (1, "map cleanup probe");
  require_page (first, 0, 0, "new anonymous mapping is not zero-filled");
  memset (first, 0xf1, page_size);
  unmap_pages (first, 1, "unmap cleanup probe");

  unsigned char *second = map_pages (1, "remap after cleanup");
  require_page (second, 0, 0, "mapping reused bytes left by cleanup");
  unmap_pages (second, 1, "unmap final probe");
  stage ("mremap DONTUNMAP: cleanup and mapping lifetime pass");
}

int
main (void)
{
  long page_size_result = sysconf (_SC_PAGESIZE);
  require (page_size_result > 0 && page_size_result <= 65536,
	   "sysconf returned an unsupported page size");
  page_size = (size_t) page_size_result;

  ordinary_relocation ();
  fixed_topology ();
  rejection_and_recovery ();
  cleanup_and_lifetime ();
  return 0;
}
