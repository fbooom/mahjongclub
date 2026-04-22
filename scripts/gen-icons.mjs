#!/usr/bin/env node
// Generates public/icon-192.png and public/icon-512.png from pure Node.js.
// Design: sakura-pink background, white rounded tile, concentric-circle dot.
import { writeFileSync } from 'fs';
import zlib from 'zlib';

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c;
}
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function makeChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, c]);
}

// SDF rounded-rect test (standard box SDF)
function inRoundedRect(px, py, x1, y1, x2, y2, r) {
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  const hw = (x2 - x1) / 2 - r, hh = (y2 - y1) / 2 - r;
  const qx = Math.abs(px - cx) - hw, qy = Math.abs(py - cy) - hh;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) <= r;
}
function inCircle(px, py, cx, cy, r) {
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function generateIcon(size) {
  const BG   = [201,  96, 122]; // #c9607a sakura pink
  const TILE = [255, 255, 255]; // white
  const DOT  = [201,  96, 122]; // pink dot center
  const RING = [155, 110, 168]; // #9b6ea8 secondary accent ring

  const pad  = Math.round(size * 0.16);
  const r    = Math.round(size * 0.12);
  const mid  = size / 2;

  // Bamboo-style concentric circles
  const outerR = Math.round(size * 0.145);
  const midR   = Math.round(size * 0.095);
  const innerR = Math.round(size * 0.055);

  const rowBytes = 1 + size * 3;
  const raw = Buffer.alloc(size * rowBytes, 0);

  for (let py = 0; py < size; py++) {
    raw[py * rowBytes] = 0; // filter byte: None
    for (let px = 0; px < size; px++) {
      let color = BG;
      if (inRoundedRect(px, py, pad, pad, size - pad, size - pad, r)) {
        color = TILE;
        if (inCircle(px, py, mid, mid, outerR)) {
          color = RING;
          if (inCircle(px, py, mid, mid, midR)) {
            color = TILE;
            if (inCircle(px, py, mid, mid, innerR)) {
              color = DOT;
            }
          }
        }
      }
      const off = py * rowBytes + 1 + px * 3;
      raw[off] = color[0]; raw[off + 1] = color[1]; raw[off + 2] = color[2];
    }
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync('public/icon-192.png', generateIcon(192));
writeFileSync('public/icon-512.png', generateIcon(512));
console.log('Icons written: public/icon-192.png, public/icon-512.png');
