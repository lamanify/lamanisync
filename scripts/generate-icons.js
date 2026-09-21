#!/usr/bin/env node
/**
 * scripts/generate-icons.js
 * Generates standard Chrome extension icons (16x16, 32x32, 48x48, 128x128)
 * using Node.js stdlib (zlib) with zero external dependencies.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Standard CRC32 calculation
function crc32(buf) {
  let table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([typeBuf, data]);
  const crc = crc32(typeAndData);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([lenBuf, typeAndData, crcBuf]);
}

/**
 * Render LamaniSync icon buffer at given dimension.
 */
function renderIcon(size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA color type
  ihdr[10] = 0; // Deflate
  ihdr[11] = 0; // Filter
  ihdr[12] = 0; // Interlace
  const ihdrChunk = makeChunk('IHDR', ihdr);

  const scanlines = Buffer.alloc(size * (1 + size * 4));

  for (let y = 0; y < size; y++) {
    const rowOffset = y * (1 + size * 4);
    scanlines[rowOffset] = 0; // Filter 0 (None)

    for (let x = 0; x < size; x++) {
      const px = rowOffset + 1 + x * 4;

      // Normalized coordinates [0, 1]
      const nx = (x + 0.5) / size;
      const ny = (y + 0.5) / size;
      const cx = 0.5;
      const cy = 0.5;

      // Check rounded square boundary
      const cornerR = 0.22;
      const qx = Math.max(Math.abs(nx - cx) - (0.5 - cornerR), 0);
      const qy = Math.max(Math.abs(ny - cy) - (0.5 - cornerR), 0);
      const distFromCorner = Math.sqrt(qx * qx + qy * qy);

      if (distFromCorner > cornerR) {
        // Fully transparent outside squircle
        scanlines[px] = 0;
        scanlines[px + 1] = 0;
        scanlines[px + 2] = 0;
        scanlines[px + 3] = 0;
        continue;
      }

      // Base background: gradient from navy #0f172a to deep teal #0e7490
      const gradT = ny;
      let r = Math.round(15 * (1 - gradT) + 14 * gradT);
      let g = Math.round(23 * (1 - gradT) + 116 * gradT);
      let b = Math.round(42 * (1 - gradT) + 144 * gradT);
      let a = 255;

      // Inner features
      const dx = nx - cx;
      const dy = ny - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI; // -180 to +180

      // Sync circular ring: radius between 0.24 and 0.36
      const inRing = dist >= 0.24 && dist <= 0.36;
      // Two gaps in the ring for sync look
      const inGap =
        (angle >= 70 && angle <= 100) || (angle >= -110 && angle <= -80);

      if (inRing && !inGap) {
        // Cyan accent #38bdf8
        r = 56;
        g = 189;
        b = 248;
      }

      // Medical cross at center
      const inCrossH = Math.abs(dx) <= 0.14 && Math.abs(dy) <= 0.045;
      const inCrossV = Math.abs(dx) <= 0.045 && Math.abs(dy) <= 0.14;

      if (inCrossH || inCrossV) {
        // Pure crisp white #ffffff
        r = 255;
        g = 255;
        b = 255;
      }

      // Subtle border edge anti-alias
      if (distFromCorner > cornerR - 0.03) {
        const edgeAlpha = Math.max(
          0,
          Math.min(1, (cornerR - distFromCorner) / 0.03)
        );
        a = Math.round(255 * edgeAlpha);
      }

      scanlines[px] = r;
      scanlines[px + 1] = g;
      scanlines[px + 2] = b;
      scanlines[px + 3] = a;
    }
  }

  const idatChunk = makeChunk('IDAT', zlib.deflateSync(scanlines, { level: 9 }));
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

/**
 * Generate all icon files.
 */
export function generateIcons(outDir) {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const sizes = [16, 32, 48, 128];
  const generated = [];

  for (const size of sizes) {
    const pngBuf = renderIcon(size);
    const filename = `icon-${size}.png`;
    const filePath = path.join(outDir, filename);
    fs.writeFileSync(filePath, pngBuf);
    generated.push({ size, filePath, bytes: pngBuf.length });
  }

  return generated;
}

// Direct execution
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const publicIconsDir = path.join(rootDir, 'public', 'icons');
  const results = generateIcons(publicIconsDir);
  console.log(`Generated ${results.length} icons in ${publicIconsDir}:`);
  for (const item of results) {
    console.log(`  - icon-${item.size}.png (${item.bytes} bytes)`);
  }
}
