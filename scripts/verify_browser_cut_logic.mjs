#!/usr/bin/env node
import { deflateSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import vm from 'node:vm';

const PADDING = 24;
const OUTLINE_PX = 3;
const TRANSPARENT = [255, 0, 255, 255];
const WHITE = [255, 255, 255, 255];

function usage() {
  console.log('usage: node scripts/verify_browser_cut_logic.mjs <input.gif> [output-dir]');
  console.log('writes contact sheets for raw-delta and composed browser cut frames');
}

function loadGifReader(source) {
  const sandbox = { exports: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'vendor/omggif.js' });
  if (!sandbox.exports.GifReader) throw new Error('Could not load GifReader from vendor/omggif.js');
  return sandbox.exports.GifReader;
}

function clearFrameRect(pixels, width, frameInfo) {
  const left = frameInfo.x;
  const top = frameInfo.y;
  const right = left + frameInfo.width;
  const bottom = top + frameInfo.height;
  for (let y = top; y < bottom; y += 1) {
    pixels.fill(0, (y * width + left) * 4, (y * width + right) * 4);
  }
}

function decodeGif(buffer, GifReader, mode) {
  const reader = new GifReader(new Uint8Array(buffer));
  const width = reader.width;
  const height = reader.height;
  const frames = [];

  if (mode === 'raw-delta') {
    for (let index = 0; index < reader.numFrames(); index += 1) {
      const pixels = new Uint8ClampedArray(width * height * 4);
      const info = reader.frameInfo(index);
      reader.decodeAndBlitFrameRGBA(index, pixels);
      frames.push({ pixels, delay: Math.max(20, (info.delay || 10) * 10) });
    }
  } else {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < reader.numFrames(); index += 1) {
      const info = reader.frameInfo(index);
      const restorePixels = info.disposal === 3 ? new Uint8ClampedArray(pixels) : null;
      reader.decodeAndBlitFrameRGBA(index, pixels);
      frames.push({ pixels: new Uint8ClampedArray(pixels), delay: Math.max(20, (info.delay || 10) * 10) });
      if (info.disposal === 2) {
        clearFrameRect(pixels, width, info);
      } else if (restorePixels) {
        pixels.set(restorePixels);
      }
    }
  }

  return { width, height, frames };
}

function generatedMask(width, height) {
  const mask = new Uint8ClampedArray(width * height);
  const cx = width * 0.52;
  const cy = height * 0.53;
  const rx = width * 0.35;
  const ry = height * 0.43;
  const shoulderTop = height * 0.66;
  const shoulderBottom = height * 0.91;
  const shoulderLeft = width * 0.08;
  const shoulderRight = width * 0.91;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const head = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
      const shoulders = y >= shoulderTop && y <= shoulderBottom && x >= shoulderLeft && x <= shoulderRight;
      if (head || shoulders) mask[y * width + x] = 255;
    }
  }
  return mask;
}

function dilateMask(mask, width, height, radius) {
  const output = new Uint8ClampedArray(mask.length);
  const radiusSquared = radius * radius;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (let dy = -radius; dy <= radius && !value; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (dx * dx + dy * dy > radiusSquared) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (mask[ny * width + nx]) {
            value = 255;
            break;
          }
        }
      }
      output[y * width + x] = value;
    }
  }
  return output;
}

function frameImage(frame, mask, outline, width, height) {
  const outWidth = width + PADDING * 2;
  const outHeight = height + PADDING * 2;
  const data = new Uint8ClampedArray(outWidth * outHeight * 4);

  for (let index = 0; index < data.length; index += 4) {
    data.set(TRANSPARENT, index);
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = y * width + x;
      const source = sourceIndex * 4;
      const target = ((y + PADDING) * outWidth + x + PADDING) * 4;
      data.set(outline[sourceIndex] ? WHITE : TRANSPARENT, target);
      if (mask[sourceIndex] && frame.pixels[source + 3] > 16) {
        data[target] = frame.pixels[source];
        data[target + 1] = frame.pixels[source + 1];
        data[target + 2] = frame.pixels[source + 2];
        data[target + 3] = frame.pixels[source + 3];
      }
    }
  }

  return { width: outWidth, height: outHeight, data };
}

function frameStats(image) {
  let magenta = 0;
  let white = 0;
  let color = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    const r = image.data[index];
    const g = image.data[index + 1];
    const b = image.data[index + 2];
    const a = image.data[index + 3];
    if (a === 0 || (r === 255 && g === 0 && b === 255)) magenta += 1;
    else if (r > 245 && g > 245 && b > 245) white += 1;
    else color += 1;
  }
  return { magenta, white, color };
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBuffer.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return output;
}

function pngBuffer(width, height, data) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, row + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function contactSheet(images) {
  const columns = Math.min(4, images.length);
  const thumb = 180;
  const gap = 20;
  const rows = Math.ceil(images.length / columns);
  const width = columns * (thumb + gap) - gap;
  const height = rows * (thumb + gap) - gap;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) data.set([255, 255, 255, 255], index);

  images.forEach((image, frameIndex) => {
    const scale = Math.min(thumb / image.width, thumb / image.height);
    const destWidth = Math.max(1, Math.round(image.width * scale));
    const destHeight = Math.max(1, Math.round(image.height * scale));
    const ox = (frameIndex % columns) * (thumb + gap);
    const oy = Math.floor(frameIndex / columns) * (thumb + gap);

    for (let y = 0; y < destHeight; y += 1) {
      for (let x = 0; x < destWidth; x += 1) {
        const sx = Math.min(image.width - 1, Math.floor(x / scale));
        const sy = Math.min(image.height - 1, Math.floor(y / scale));
        const source = (sy * image.width + sx) * 4;
        const target = ((oy + y) * width + ox + x) * 4;
        data[target] = image.data[source];
        data[target + 1] = image.data[source + 1];
        data[target + 2] = image.data[source + 2];
        data[target + 3] = 255;
      }
    }
  });

  return { width, height, data };
}

async function main() {
  const input = process.argv[2];
  if (!input || input === '--help' || input === '-h') {
    usage();
    return;
  }
  const outputDir = process.argv[3] || '/private/tmp';
  const source = await readFile(new URL('../vendor/omggif.js', import.meta.url), 'utf8');
  const GifReader = loadGifReader(source);
  const buffer = await readFile(input);
  const name = basename(input, '.gif');

  const reports = [];
  for (const mode of ['raw-delta', 'composed']) {
    const decoded = decodeGif(buffer, GifReader, mode);
    const mask = generatedMask(decoded.width, decoded.height);
    const outline = dilateMask(mask, decoded.width, decoded.height, OUTLINE_PX);
    const cutFrames = decoded.frames.map((frame) => frameImage(frame, mask, outline, decoded.width, decoded.height));
    const sheet = contactSheet(cutFrames);
    const output = join(outputDir, `${name}-${mode}-browser-cut-sheet.png`);
    await writeFile(output, pngBuffer(sheet.width, sheet.height, sheet.data));
    reports.push({
      mode,
      frames: decoded.frames.length,
      size: `${decoded.width}x${decoded.height}`,
      firstFiveStats: cutFrames.slice(0, 5).map(frameStats),
      output,
    });
  }

  console.log(JSON.stringify(reports, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
