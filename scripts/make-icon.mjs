// 纯 Node（无依赖）生成 1024x1024 RGBA PNG 作为应用图标源：
// 蓝色渐变圆球 + 白色对勾。之后用 `npx tauri icon app-icon.png` 生成各平台图标。
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 1024;

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [
  lerp(c1[0], c2[0], t),
  lerp(c1[1], c2[1], t),
  lerp(c1[2], c2[2], t),
];
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const distSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

const TOP = [108, 155, 255]; // #6c9bff
const BOTTOM = [39, 73, 207]; // #2749cf
const cx = SIZE / 2;
const cy = SIZE / 2;
const R = 430;
const CHECK = [
  [330, 528],
  [455, 655],
  [712, 372],
];
const STROKE = 76;

const px = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    const d = Math.hypot(x - cx, y - cy);
    const circle = 1 - smoothstep(R - 1.5, R + 1.5, d);
    if (circle <= 0) continue; // 透明
    let col = mix(TOP, BOTTOM, y / SIZE);
    const dc = Math.min(
      distSeg(x, y, CHECK[0][0], CHECK[0][1], CHECK[1][0], CHECK[1][1]),
      distSeg(x, y, CHECK[1][0], CHECK[1][1], CHECK[2][0], CHECK[2][1]),
    );
    const check = 1 - smoothstep(STROKE / 2 - 1.5, STROKE / 2 + 1.5, dc);
    if (check > 0) col = mix(col, [255, 255, 255], check);
    px[i] = Math.round(col[0]);
    px[i + 1] = Math.round(col[1]);
    px[i + 2] = Math.round(col[2]);
    px[i + 3] = Math.round(circle * 255);
  }
}

// --- 组装 PNG ---
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, body) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const tb = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tb, body])), 0);
  return Buffer.concat([len, tb, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = new URL("../app-icon.png", import.meta.url);
writeFileSync(out, png);
console.log(`wrote ${out.pathname} (${png.length} bytes)`);
