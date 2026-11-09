// SPDX-License-Identifier: MIT
extern int ltdl_later(int value);

int sample_LTX_data = 5;

int sample_LTX_value(int value)
{
    sample_LTX_data += value;
    return ltdl_later(value);
}
