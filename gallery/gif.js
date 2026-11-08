// A small animated-GIF encoder for the gallery: no dependencies, runs in the browser and in node.
//   const bytes = encodeGif({ width, height, frames: [RGBA Uint8ClampedArray, ...], fps, loop: true });
// All frames share one global palette of at most 255 colors (index 255 is unused, the file is opaque): exact
// when the frames use that few colors, median cut otherwise. Semi-transparent pixels must already be composited
// onto a background by the caller.

function buildPalette(frames, maxColors) {
  const counts = new Map();
  for (const f of frames) {
    for (let i = 0; i < f.length; i += 4) {
      const key = (f[i] << 16) | (f[i + 1] << 8) | f[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const colors = [...counts.keys()];
  if (colors.length <= maxColors) return colors;
  // median cut over the distinct colors, weighted by how many pixels use them
  let boxes = [colors];
  while (boxes.length < maxColors) {
    let bi = -1, best = 0;
    boxes.forEach((b, i) => {
      if (b.length > 1 && b.length > best) { best = b.length; bi = i; }
    });
    if (bi < 0) break;
    const box = boxes[bi];
    const range = [0, 8, 16].map((s) => {
      let lo = 255, hi = 0;
      for (const c of box) { const v = (c >> s) & 255; if (v < lo) lo = v; if (v > hi) hi = v; }
      return hi - lo;
    });
    const shift = [0, 8, 16][range.indexOf(Math.max(...range))];
    box.sort((a, b) => ((a >> shift) & 255) - ((b >> shift) & 255));
    let total = 0;
    for (const c of box) total += counts.get(c);
    let acc = 0, cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += counts.get(box[i]);
      cut = i + 1;
      if (acc >= total / 2) break;
    }
    boxes.splice(bi, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map((box) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const c of box) {
      const w = counts.get(c);
      r += ((c >> 16) & 255) * w; g += ((c >> 8) & 255) * w; b += (c & 255) * w; n += w;
    }
    return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
  });
}

function indexFrame(rgba, palette) {
  const lookup = new Map(), out = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    let idx = lookup.get(key);
    if (idx === undefined) {
      let bestD = Infinity;
      idx = 0;
      for (let j = 0; j < palette.length; j++) {
        const c = palette[j], dr = rgba[i] - ((c >> 16) & 255), dg = rgba[i + 1] - ((c >> 8) & 255), db = rgba[i + 2] - (c & 255);
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; idx = j; if (!d) break; }
      }
      lookup.set(key, idx);
    }
    out[p] = idx;
  }
  return out;
}

function lzw(indices, minCode) {
  const clear = 1 << minCode, end = clear + 1, out = [];
  let size = minCode + 1, next = end + 1, dict = new Map(), bits = 0, nbits = 0;
  const emit = (code) => {
    bits |= code << nbits;
    nbits += size;
    while (nbits >= 8) { out.push(bits & 255); bits >>= 8; nbits -= 8; }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = (prefix << 8) | k, hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << size) && size < 12) size++;
    } else {
      emit(clear);
      dict = new Map(); size = minCode + 1; next = end + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(end);
  if (nbits > 0) out.push(bits & 255);
  return out;
}

export function encodeGif({ width, height, frames, fps = 30, loop = true }) {
  const palette = buildPalette(frames, 255);
  let depth = 1;
  while ((1 << depth) < Math.max(2, palette.length)) depth++;
  const bytes = [];
  const u16 = (v) => bytes.push(v & 255, (v >> 8) & 255);
  bytes.push(...[..."GIF89a"].map((c) => c.charCodeAt(0)));
  u16(width); u16(height);
  bytes.push(0x80 | ((depth - 1) << 4) | (depth - 1), 0, 0);
  for (let i = 0; i < 1 << depth; i++) {
    const c = palette[i] ?? 0;
    bytes.push((c >> 16) & 255, (c >> 8) & 255, c & 255);
  }
  if (loop) bytes.push(0x21, 0xff, 11, ...[..."NETSCAPE2.0"].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);
  const delay = Math.max(2, Math.round(100 / fps)); // GIF counts in hundredths of a second
  for (const f of frames) {
    bytes.push(0x21, 0xf9, 4, 0, delay & 255, delay >> 8, 0, 0);
    bytes.push(0x2c); u16(0); u16(0); u16(width); u16(height); bytes.push(0);
    const minCode = Math.max(2, depth);
    bytes.push(minCode);
    const data = lzw(indexFrame(f, palette), minCode);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      bytes.push(chunk.length, ...chunk);
    }
    bytes.push(0);
  }
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}
