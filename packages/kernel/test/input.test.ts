// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";
import {
  inputDevice,
  VIRTIO_ID_INPUT,
  VirtioInputConfigSelect,
  type VirtioInputEvent,
} from "../src/virtio/input.ts";

const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_REL = 0x02;
const EV_ABS = 0x03;
const EV_LED = 0x11;
const SYN_REPORT = 0;
const KEY_A = 30;
const REL_X = 0x00;
const ABS_X = 0x00;
const LED_CAPSL = 0x01;

test("virtio input reports device id, name, serial, devids, evBits, propBits, and absInfo", async () => {
  const device = inputDevice({
    name: "Wasm Test Keyboard",
    serial: "kb-001",
    devids: { bustype: 0x06, vendor: 0x1234, product: 0x5678, version: 0x0002 },
    propBits: [0, 2],
    evBits: {
      [EV_KEY]: [KEY_A],
      [EV_REL]: [REL_X],
    },
    absInfo: {
      [ABS_X]: { min: 0, max: 1920, fuzz: 1, flat: 2, res: 10 },
    },
  });

  try {
    assert.equal(VIRTIO_ID_INPUT, 18);

    const nameCfg = device.queryConfig(VirtioInputConfigSelect.ID_NAME);
    assert.equal(nameCfg[2], "Wasm Test Keyboard".length);
    assert.equal(
      new TextDecoder().decode(nameCfg.subarray(8, 8 + nameCfg[2]!)),
      "Wasm Test Keyboard",
    );

    const serialCfg = device.queryConfig(VirtioInputConfigSelect.ID_SERIAL);
    assert.equal(new TextDecoder().decode(serialCfg.subarray(8, 8 + serialCfg[2]!)), "kb-001");

    const devidsCfg = device.queryConfig(VirtioInputConfigSelect.ID_DEVIDS);
    const devidsView = new DataView(devidsCfg.buffer);
    assert.equal(devidsCfg[2], 8);
    assert.equal(devidsView.getUint16(8, true), 0x06);
    assert.equal(devidsView.getUint16(10, true), 0x1234);
    assert.equal(devidsView.getUint16(12, true), 0x5678);
    assert.equal(devidsView.getUint16(14, true), 0x0002);

    const propCfg = device.queryConfig(VirtioInputConfigSelect.PROP_BITS);
    assert.equal(propCfg[2], 1);
    assert.equal(propCfg[8], 0b00000101);

    const keyCfg = device.queryConfig(VirtioInputConfigSelect.EV_BITS, EV_KEY);
    assert.equal(keyCfg[2], 4);
    assert.equal(keyCfg[8 + (KEY_A >> 3)], 1 << (KEY_A & 7));

    const emptyCfg = device.queryConfig(VirtioInputConfigSelect.EV_BITS, EV_REL + 99);
    assert.equal(emptyCfg[2], 0);

    const absCfg = device.queryConfig(VirtioInputConfigSelect.ABS_INFO, ABS_X);
    const absView = new DataView(absCfg.buffer);
    assert.equal(absCfg[2], 20);
    assert.equal(absView.getUint32(8, true), 0);
    assert.equal(absView.getUint32(12, true), 1920);
    assert.equal(absView.getUint32(16, true), 1);
    assert.equal(absView.getUint32(20, true), 2);
    assert.equal(absView.getUint32(24, true), 10);
  } finally {
    await close_virtio_device(device);
  }
});

test("virtio input delivers queued events on eventq and receives statusq updates", async () => {
  const statusEvents: VirtioInputEvent[] = [];
  const device = inputDevice({
    evBits: { [EV_KEY]: [KEY_A] },
    onStatus(event) {
      statusEvents.push(event);
    },
  });

  const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
  const irqs: number[] = [];
  const errors: unknown[] = [];
  const imports = virtio_imports({
    memory,
    devices: [device],
    trigger_irq(irq) {
      irqs.push(irq);
    },
    on_error(error) {
      errors.push(error);
    },
  });

  const view = new DataView(memory.buffer);
  // Queue 0 (eventq): 2 writable 8-byte descriptors at 256 and 272.
  view.setBigUint64(0, 256n, true);
  view.setUint32(8, 8, true);
  view.setUint16(14, 128 | 2, true);

  view.setBigUint64(16, 272n, true);
  view.setUint32(24, 8, true);
  view.setUint16(30, 128 | 2, true);

  // Queue 1 (statusq): 1 readable 8-byte descriptor at 512.
  view.setBigUint64(1024, 512n, true);
  view.setUint32(1032, 8, true);
  view.setUint16(1038, 128, true);
  view.setUint16(512, EV_LED, true);
  view.setUint16(514, LED_CAPSL, true);
  view.setInt32(516, 1, true);

  try {
    // Queue an event before the guest posts eventq buffers; it should flush on notify.
    device.sendEvent({ type: EV_KEY, code: KEY_A, value: 1 });

    imports.enable_vring(0, 0, 2, 0, 1);
    imports.enable_vring(0, 1, 1, 1024, 2);
    imports.notify(0, 0);

    // Send SYN_REPORT after eventq buffer is already waiting.
    device.sendEvents([{ type: EV_SYN, code: SYN_REPORT, value: 0 }]);

    assert.equal(view.getUint16(256, true), EV_KEY);
    assert.equal(view.getUint16(258, true), KEY_A);
    assert.equal(view.getInt32(260, true), 1);

    assert.equal(view.getUint16(272, true), EV_SYN);
    assert.equal(view.getUint16(274, true), SYN_REPORT);
    assert.equal(view.getInt32(276, true), 0);

    imports.notify(0, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(statusEvents, [{ type: EV_LED, code: LED_CAPSL, value: 1 }]);
    assert.deepEqual(errors, []);
    assert.ok(irqs.includes(1));
    assert.ok(irqs.includes(2));
  } finally {
    await close_virtio_device(device);
  }
});

test("virtio input updates guest config buffer synchronously on set_config", async () => {
  const device = inputDevice({
    name: "Dynamic Input",
    evBits: { [EV_KEY]: [KEY_A] },
    absInfo: { [ABS_X]: { min: 10, max: 800, fuzz: 0, flat: 0, res: 4 } },
  });

  const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
  const imports = virtio_imports({
    memory,
    devices: [device],
    trigger_irq() {},
    on_error(error) {
      throw error;
    },
  });

  const configAddr = 2048;
  const bytes = new Uint8Array(memory.buffer, configAddr, 256);
  const view = new DataView(memory.buffer, configAddr, 256);

  try {
    imports.setup(0, 3, configAddr, 256);
    assert.equal(bytes[0], VirtioInputConfigSelect.ID_NAME);
    assert.equal(bytes[2], "Dynamic Input".length);

    // Simulate virtinput_cfg_select(EV_BITS, EV_KEY)
    bytes[0] = VirtioInputConfigSelect.EV_BITS;
    imports.set_config!(0, 0, 1);
    bytes[1] = EV_KEY;
    imports.set_config!(0, 1, 1);
    assert.equal(bytes[2], 4);
    assert.equal(bytes[8 + (KEY_A >> 3)], 1 << (KEY_A & 7));

    // Simulate virtinput_cfg_select(ABS_INFO, ABS_X)
    bytes[0] = VirtioInputConfigSelect.ABS_INFO;
    imports.set_config!(0, 0, 1);
    bytes[1] = ABS_X;
    imports.set_config!(0, 1, 1);
    assert.equal(bytes[2], 20);
    assert.equal(view.getUint32(8, true), 10);
    assert.equal(view.getUint32(12, true), 800);
    assert.equal(view.getUint32(24, true), 4);
  } finally {
    await close_virtio_device(device);
  }
});
