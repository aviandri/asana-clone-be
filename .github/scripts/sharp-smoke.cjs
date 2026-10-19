// Thumbnails one PNG with the image's own sharp (SPEC §13: 240 px WebP "small" thumbnail).
// Run inside the backend image with the working directory at the app root (/app):
//   docker run --rm -v "$PWD/.github/scripts:/smoke:ro" --entrypoint node <image> /smoke/sharp-smoke.cjs
// The PNG is encoded here with plain zlib, so a broken sharp can't both write and read it.
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const sharp = createRequire(`${process.cwd()}/package.json`)('sharp');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

// 640x480 RGB: a horizontal gradient, so the thumbnail isn't a single flat colour.
const width = 640;
const height = 480;
const rows = [];
for (let y = 0; y < height; y++) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([(x * 255) / width, 37, 127], 1 + x * 3);
  rows.push(row);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolour
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
  chunk('IEND', Buffer.alloc(0)),
]);

(async () => {
  const meta = await sharp(png).metadata();
  const thumb = await sharp(png).rotate().resize(240, 240, { fit: 'inside' }).webp().toBuffer();
  const out = await sharp(thumb).metadata();
  console.log(`sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}`);
  console.log(`input ${meta.format} ${meta.width}x${meta.height} -> thumbnail ${out.format} ${out.width}x${out.height}, ${thumb.length} bytes`);
  if (meta.format !== 'png' || meta.width !== width || meta.height !== height) throw new Error('PNG metadata wrong');
  if (out.format !== 'webp' || out.width !== 240 || out.height !== 180) throw new Error('thumbnail wrong');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
