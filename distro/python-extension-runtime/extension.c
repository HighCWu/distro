// SPDX-License-Identifier: MIT
#include <limits.h>
#include <Python.h>

typedef struct {
    unsigned long answer_calls;
    unsigned long callback_calls;
} ExtensionState;

static ExtensionState *get_state(PyObject *module)
{
    return (ExtensionState *)PyModule_GetState(module);
}

static PyObject *extension_answer(PyObject *module, PyObject *argument)
{
    long value = PyLong_AsLong(argument);
    if (value == -1 && PyErr_Occurred())
        return NULL;
    if (value > LONG_MAX - 40) {
        PyErr_SetString(PyExc_OverflowError, "answer result does not fit in C long");
        return NULL;
    }

    ExtensionState *state = get_state(module);
    if (state == NULL)
        return NULL;

    PyObject *result = PyLong_FromLong(value + 40);
    if (result != NULL)
        state->answer_calls++;
    return result;
}

static PyObject *extension_callback(PyObject *module, PyObject *arguments)
{
    PyObject *callable;
    PyObject *argument;
    if (!PyArg_ParseTuple(arguments, "OO:callback", &callable, &argument))
        return NULL;

    ExtensionState *state = get_state(module);
    if (state == NULL)
        return NULL;

    PyObject *result = PyObject_CallFunctionObjArgs(callable, argument, NULL);
    if (result != NULL)
        state->callback_calls++;
    return result;
}

static PyObject *extension_state(PyObject *module, PyObject *Py_UNUSED(ignored))
{
    ExtensionState *state = get_state(module);
    if (state == NULL)
        return NULL;

    return Py_BuildValue("(kk)", state->answer_calls, state->callback_calls);
}

static PyMethodDef extension_methods[] = {
    {"answer", extension_answer, METH_O, "Return a C long increased by 40."},
    {"callback", extension_callback, METH_VARARGS,
     "Call a Python callable with one argument."},
    {"state", extension_state, METH_NOARGS, "Return module-local call counts."},
    {NULL, NULL, 0, NULL},
};

static struct PyModuleDef extension_module = {
    PyModuleDef_HEAD_INIT,
    "_wasmexample",
    NULL,
    sizeof(ExtensionState),
    extension_methods,
    NULL,
    NULL,
    NULL,
    NULL,
};

PyMODINIT_FUNC PyInit__wasmexample(void)
{
    return PyModule_Create(&extension_module);
}
