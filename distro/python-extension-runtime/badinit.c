// SPDX-License-Identifier: MIT
#include <Python.h>

PyMODINIT_FUNC PyInit__wasmbadinit(void)
{
    PyErr_SetString(PyExc_ImportError,
                    "controlled extension initialization failure");
    return NULL;
}
