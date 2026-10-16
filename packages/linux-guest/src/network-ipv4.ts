// SPDX-License-Identifier: MIT

export interface ParsedIpPacket {
  source: number;
  destination: number;
  protocol: number;
  payload: Uint8Array;
}

export interface ParsedIpFragment extends ParsedIpPacket {
  identification: number;
  header_length: number;
  offset: number;
  more_fragments: boolean;
}

/** Parse an Ethernet II IPv4 frame; Ethernet padding is not part of the packet. */
export function parseIpv4Frame(frame: Uint8Array): ParsedIpFragment | undefined {
  const ethernet_length = 14;
  const minimum_header_length = 20;
  if (frame.byteLength < ethernet_length + minimum_header_length) return;
  const ethernet = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (ethernet.getUint16(12) !== 0x0800) return;
  const bytes = frame.subarray(ethernet_length);
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version_and_length = header.getUint8(0);
  const header_length = (version_and_length & 0x0f) * 4;
  if (
    version_and_length >>> 4 !== 4 ||
    header_length < minimum_header_length ||
    header_length > bytes.byteLength
  )
    return;
  const total_length = header.getUint16(2);
  if (total_length < header_length || total_length > bytes.byteLength) return;

  // The NIC does not negotiate checksum offload. Validate the complete IPv4
  // header, including options, before reassembly or transport dispatch.
  let sum = 0;
  for (let index = 0; index < header_length; index += 2) sum += header.getUint16(index);
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  if (sum !== 0xffff) return;

  const flags_and_offset = header.getUint16(6);
  const offset = (flags_and_offset & 0x1fff) * 8;
  const more_fragments = (flags_and_offset & 0x2000) !== 0;
  const payload = bytes.subarray(header_length, total_length);
  if ((offset !== 0 || more_fragments) && payload.byteLength === 0) return;
  if (more_fragments && payload.byteLength % 8 !== 0) return;
  if (offset + payload.byteLength > 0xffff - minimum_header_length) return;
  return {
    source: header.getUint32(12),
    destination: header.getUint32(16),
    protocol: header.getUint8(9),
    payload,
    identification: header.getUint16(4),
    header_length,
    offset,
    more_fragments,
  };
}
