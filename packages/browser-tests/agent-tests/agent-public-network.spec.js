// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";
import { checkPublicAgent } from "./agent-public-check.js";

function frame(type, stream, payload) {
  const packet = Buffer.alloc(5 + payload.length);
  packet[0] = type;
  packet.writeUInt32LE(stream, 1);
  Buffer.from(payload).copy(packet, 5);
  return packet;
}

test("runs native wasm64 HTTP through public agent networking", async ({ page }) => {
  const connections = new Map();
  await page.routeWebSocket(/\/wisp-test$/, (socket) => {
    expect(connections.has(socket)).toBe(false);
    const connection = { replied: false, closed: false };
    connections.set(socket, connection);
    let stream;
    let request = Buffer.alloc(0);
    const body = "Linux on Wasm Wisp test\n";
    // Navigation may notify the same route again after its real disconnect.
    socket.onClose(() => {
      connection.closed = true;
    });
    socket.onMessage((packet) => {
      expect(Buffer.isBuffer(packet)).toBe(true);
      const id = packet.readUInt32LE(1);
      const payload = packet.subarray(5);
      if (packet[0] === 1) {
        expect(stream).toBeUndefined();
        expect(id).toBeGreaterThan(0);
        expect(payload[0]).toBe(1);
        expect(payload.readUInt16LE(1)).toBe(18081);
        expect(payload.subarray(3).toString()).toBe("wisp-test.example");
        stream = id;
      } else if (packet[0] === 2) {
        expect(id).toBe(stream);
        expect(request.length + payload.length).toBeLessThan(4096);
        request = Buffer.concat([request, payload]);
        if (request.includes("\r\n\r\n")) {
          expect(connection.replied).toBe(false);
          expect(request.toString()).toMatch(/^GET \/body HTTP\/1\.[01]\r\n/);
          const headers = `HTTP/1.0 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`;
          socket.send(frame(2, id, Buffer.from(headers)));
          socket.send(frame(2, id, Buffer.from(body)));
          socket.send(frame(4, id, [2]));
          connection.replied = true;
        } else {
          socket.send(frame(3, id, [1, 0, 0, 0]));
        }
      }
    });
    socket.send(frame(3, 0, [1, 0, 0, 0]));
  });
  for (let round = 1; round <= 2; round++) {
    await checkPublicAgent(page, true, true, true);
    await expect
      .poll(() => [...connections.values()].map(({ replied, closed }) => [replied, closed]))
      .toEqual(Array.from({ length: round }, () => [true, true]));
    console.log(`Wisp round ${round}: exact CONNECT target, HTTP bytes and WebSocket shutdown`);
  }
  await page.close();
  expect(connections.size).toBe(2);
  console.log("Wisp page: close awaited after two distinct completed HTTP connections");
});
