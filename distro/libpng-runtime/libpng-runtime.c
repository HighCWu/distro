// SPDX-License-Identifier: MIT
#include <png.h>

#include <stdio.h>
#include <string.h>

#define IMAGE_WIDTH 3
#define IMAGE_HEIGHT 2
#define IMAGE_STRIDE (IMAGE_WIDTH * 4)

static const png_byte ExpectedPixels[IMAGE_HEIGHT][IMAGE_STRIDE] = {
	{0x10, 0x20, 0x30, 0xff, 0x40, 0x50, 0x60, 0xff, 0x70, 0x80, 0x90, 0xff},
	{0xa0, 0xb0, 0xc0, 0xff, 0xd0, 0xe0, 0xf0, 0xff, 0x01, 0x02, 0x03, 0xff},
};

static int WritePng(const char *Path)
{
	FILE *File = fopen(Path, "wb");
	if (!File) {
		perror("fopen PNG output");
		return 1;
	}

	png_structp Png = png_create_write_struct(PNG_LIBPNG_VER_STRING, NULL, NULL, NULL);
	if (!Png) {
		fclose(File);
		fprintf(stderr, "png_create_write_struct failed\n");
		return 1;
	}
	png_infop Info = png_create_info_struct(Png);
	if (!Info) {
		png_destroy_write_struct(&Png, NULL);
		fclose(File);
		fprintf(stderr, "png_create_info_struct failed\n");
		return 1;
	}
	if (setjmp(png_jmpbuf(Png))) {
		png_destroy_write_struct(&Png, &Info);
		fclose(File);
		fprintf(stderr, "libpng write failed\n");
		return 1;
	}

	png_init_io(Png, File);
	png_set_IHDR(Png, Info, IMAGE_WIDTH, IMAGE_HEIGHT, 8, PNG_COLOR_TYPE_RGBA,
		     PNG_INTERLACE_NONE, PNG_COMPRESSION_TYPE_DEFAULT,
		     PNG_FILTER_TYPE_DEFAULT);
	png_write_info(Png, Info);
	for (png_uint_32 Row = 0; Row < IMAGE_HEIGHT; Row++)
		png_write_row(Png, (png_const_bytep)ExpectedPixels[Row]);
	png_write_end(Png, Info);

	png_destroy_write_struct(&Png, &Info);
	if (fclose(File) != 0) {
		perror("fclose PNG output");
		return 1;
	}
	return 0;
}

static int ReadPng(const char *Path)
{
	FILE *File = fopen(Path, "rb");
	if (!File) {
		perror("fopen PNG input");
		return 1;
	}

	png_structp Png = png_create_read_struct(PNG_LIBPNG_VER_STRING, NULL, NULL, NULL);
	if (!Png) {
		fclose(File);
		fprintf(stderr, "png_create_read_struct failed\n");
		return 1;
	}
	png_infop Info = png_create_info_struct(Png);
	if (!Info) {
		png_destroy_read_struct(&Png, NULL, NULL);
		fclose(File);
		fprintf(stderr, "png_create_info_struct failed\n");
		return 1;
	}
	png_byte Decoded[IMAGE_HEIGHT][IMAGE_STRIDE];
	png_bytep Rows[IMAGE_HEIGHT] = {Decoded[0], Decoded[1]};
	if (setjmp(png_jmpbuf(Png))) {
		png_destroy_read_struct(&Png, &Info, NULL);
		fclose(File);
		fprintf(stderr, "libpng read failed\n");
		return 1;
	}

	png_init_io(Png, File);
	png_read_info(Png, Info);
	png_uint_32 Width;
	png_uint_32 Height;
	int BitDepth;
	int ColorType;
	int InterlaceType;
	int CompressionType;
	int FilterType;
	if (!png_get_IHDR(Png, Info, &Width, &Height, &BitDepth, &ColorType,
			  &InterlaceType, &CompressionType, &FilterType) ||
	    Width != IMAGE_WIDTH || Height != IMAGE_HEIGHT || BitDepth != 8 ||
	    ColorType != PNG_COLOR_TYPE_RGBA || png_get_rowbytes(Png, Info) != IMAGE_STRIDE) {
		png_destroy_read_struct(&Png, &Info, NULL);
		fclose(File);
		fprintf(stderr, "decoded PNG dimensions, format, or row stride differ\n");
		return 1;
	}

	(void)png_set_interlace_handling(Png);
	png_read_update_info(Png, Info);
	if (png_get_rowbytes(Png, Info) != IMAGE_STRIDE) {
		png_destroy_read_struct(&Png, &Info, NULL);
		fclose(File);
		fprintf(stderr, "updated PNG row stride differs\n");
		return 1;
	}
	png_read_image(Png, Rows);
	png_read_end(Png, Info);

	png_destroy_read_struct(&Png, &Info, NULL);
	if (fclose(File) != 0) {
		perror("fclose PNG input");
		return 1;
	}
	if (memcmp(Decoded, ExpectedPixels, sizeof(ExpectedPixels)) != 0) {
		fprintf(stderr, "decoded PNG pixels differ from source\n");
		return 1;
	}
	return 0;
}

int main(void)
{
	const char *Path = "/tmp/libpng-runtime.png";
	if (WritePng(Path) != 0 || ReadPng(Path) != 0) return 1;
	if (remove(Path) != 0) {
		perror("remove PNG output");
		return 1;
	}
	printf("libpng-runtime: PNG encode/write and decode/read verified (3x2 RGBA, stride 12)\n");
	return 0;
}
