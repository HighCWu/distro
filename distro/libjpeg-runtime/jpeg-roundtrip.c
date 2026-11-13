/* SPDX-License-Identifier: MIT */
#include <stdio.h>
#include <stdlib.h>
#include <jpeglib.h>

#define IMAGE_WIDTH 16
#define IMAGE_HEIGHT 8
/* JPEG is lossy; the fixed source image permits at most two levels of error. */
#define MAX_PIXEL_ERROR 2

static JSAMPLE Source[IMAGE_HEIGHT][IMAGE_WIDTH];
static JSAMPLE Decoded[IMAGE_HEIGHT][IMAGE_WIDTH];

int main(void) {
  struct jpeg_compress_struct compressor;
  struct jpeg_decompress_struct decompressor;
  struct jpeg_error_mgr compress_error;
  struct jpeg_error_mgr decompress_error;
  FILE *file;
  unsigned int max_error = 0;
  unsigned int y;

  for (y = 0; y < IMAGE_HEIGHT; ++y) {
    unsigned int x;
    for (x = 0; x < IMAGE_WIDTH; ++x) {
      Source[y][x] = (JSAMPLE)(96 + ((x * 3 + y * 5) % 32));
    }
  }

  file = fopen("/tmp/libjpeg-roundtrip.jpg", "wb");
  if (file == NULL) {
    return 1;
  }

  compressor.err = jpeg_std_error(&compress_error);
  jpeg_create_compress(&compressor);
  jpeg_stdio_dest(&compressor, file);
  compressor.image_width = IMAGE_WIDTH;
  compressor.image_height = IMAGE_HEIGHT;
  compressor.input_components = 1;
  compressor.in_color_space = JCS_GRAYSCALE;
  jpeg_set_defaults(&compressor);
  jpeg_set_quality(&compressor, 100, TRUE);
  jpeg_start_compress(&compressor, TRUE);

  while (compressor.next_scanline < compressor.image_height) {
    JSAMPROW row = Source[compressor.next_scanline];
    if (jpeg_write_scanlines(&compressor, &row, 1) != 1) {
      jpeg_destroy_compress(&compressor);
      fclose(file);
      return 2;
    }
  }

  jpeg_finish_compress(&compressor);
  jpeg_destroy_compress(&compressor);
  if (fclose(file) != 0) {
    return 3;
  }

  file = fopen("/tmp/libjpeg-roundtrip.jpg", "rb");
  if (file == NULL) {
    return 4;
  }

  decompressor.err = jpeg_std_error(&decompress_error);
  jpeg_create_decompress(&decompressor);
  jpeg_stdio_src(&decompressor, file);
  if (jpeg_read_header(&decompressor, TRUE) != JPEG_HEADER_OK ||
      decompressor.image_width != (JDIMENSION)IMAGE_WIDTH ||
      decompressor.image_height != (JDIMENSION)IMAGE_HEIGHT ||
      decompressor.num_components != 1) {
    jpeg_destroy_decompress(&decompressor);
    fclose(file);
    return 5;
  }

  if (!jpeg_start_decompress(&decompressor) ||
      decompressor.output_width != (JDIMENSION)IMAGE_WIDTH ||
      decompressor.output_height != (JDIMENSION)IMAGE_HEIGHT ||
      decompressor.output_components != 1) {
    jpeg_destroy_decompress(&decompressor);
    fclose(file);
    return 6;
  }

  while (decompressor.output_scanline < decompressor.output_height) {
    JSAMPROW row = Decoded[decompressor.output_scanline];
    if (jpeg_read_scanlines(&decompressor, &row, 1) != 1) {
      jpeg_destroy_decompress(&decompressor);
      fclose(file);
      return 7;
    }
  }

  if (!jpeg_finish_decompress(&decompressor)) {
    jpeg_destroy_decompress(&decompressor);
    fclose(file);
    return 8;
  }
  jpeg_destroy_decompress(&decompressor);
  if (fclose(file) != 0) {
    return 9;
  }

  for (y = 0; y < IMAGE_HEIGHT; ++y) {
    unsigned int x;
    for (x = 0; x < IMAGE_WIDTH; ++x) {
      int delta = (int)Decoded[y][x] - (int)Source[y][x];
      unsigned int error;
      if (delta < 0) {
        delta = -delta;
      }
      error = (unsigned int)delta;
      if (error > max_error) {
        max_error = error;
      }
    }
  }

  if (max_error > MAX_PIXEL_ERROR) {
    return 10;
  }
  if (remove("/tmp/libjpeg-roundtrip.jpg") != 0) {
    return 11;
  }

  puts("LIBJPEG_ROUNDTRIP_OK");
  return 0;
}
