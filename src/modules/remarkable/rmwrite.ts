// Writer for reMarkable v6 (`.rm`) scene files — the inverse of rmlines.ts.
// Encodes pen/highlighter strokes (SceneLineItem 0x05) and text highlights
// (GlyphRange 0x03). Ported from rmscene's writer.
//
// CrdtIds: every scene item needs a unique id and a left/right neighbour to take
// its place in the layer's CRDT sequence. We mint fresh ids under a dedicated
// author number and chain new items after `left`.

import type { RmStroke, RmHighlight } from "./rmlines";

const HEADER_V6 = "reMarkable .lines file, version=6          "; // 43 bytes

const TAG_ID = 0xf;
const TAG_LEN4 = 0xc;
const TAG_B8 = 0x8;
const TAG_B4 = 0x4;
const TAG_B1 = 0x1;

// Fixed author UUID for plugin-created pages (the author map is local to a file).
const AUTHOR_UUID = [
  0x72, 0x6d, 0x73, 0x79, 0x6e, 0x63, 0x00, 0x10, 0x80, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x01,
];

export interface CrdtId {
  part1: number;
  part2: number;
}
export const END_MARKER: CrdtId = { part1: 0, part2: 0 };

/** Growable little-endian byte writer for the v6 tagged-block format. */
export class Writer {
  private buf: number[] = [];

  u8(v: number): void {
    this.buf.push(v & 0xff);
  }
  bytes(arr: ArrayLike<number>): void {
    for (let i = 0; i < arr.length; i++) this.buf.push(arr[i] & 0xff);
  }
  u16(v: number): void {
    this.u8(v);
    this.u8(v >>> 8);
  }
  u32(v: number): void {
    this.u8(v);
    this.u8(v >>> 8);
    this.u8(v >>> 16);
    this.u8(v >>> 24);
  }
  f32(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    this.bytes(b);
  }
  f64(v: number): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    this.bytes(b);
  }
  varuint(v: number): void {
    v = v >>> 0;
    for (;;) {
      const x = v & 0x7f;
      v >>>= 7;
      if (v) {
        this.u8(x | 0x80);
      } else {
        this.u8(x);
        break;
      }
    }
  }

  result(): Uint8Array {
    return Uint8Array.from(this.buf);
  }

  // --- tagged values ---
  tag(index: number, type: number): void {
    this.varuint((index << 4) | type);
  }
  id(index: number, v: CrdtId): void {
    this.tag(index, TAG_ID);
    this.u8(v.part1);
    this.varuint(v.part2);
  }
  int(index: number, v: number): void {
    this.tag(index, TAG_B4);
    this.u32(v);
  }
  float(index: number, v: number): void {
    this.tag(index, TAG_B4);
    this.f32(v);
  }
  double(index: number, v: number): void {
    this.tag(index, TAG_B8);
    this.f64(v);
  }
  /** RGBA packed as a little-endian uint32 (BGRA), matching the reader. */
  color(index: number, [r, g, b, a]: [number, number, number, number]): void {
    this.int(index, ((b | (g << 8) | (r << 16) | (a << 24)) >>> 0) as number);
  }
  bool(index: number, v: boolean): void {
    this.tag(index, TAG_B1);
    this.u8(v ? 1 : 0);
  }
  string(index: number, s: string): void {
    this.sub(index, (w) => {
      const b = utf8Encode(s);
      w.varuint(b.length);
      w.u8(1); // is_ascii flag
      w.bytes(b);
    });
  }
  /** Last-write-wins string: subblock of {timestamp id, string}. */
  lwwString(index: number, ts: CrdtId, value: string): void {
    this.sub(index, (w) => {
      w.id(1, ts);
      w.string(2, value);
    });
  }
  /** Last-write-wins bool: subblock of {timestamp id, bool}. */
  lwwBool(index: number, ts: CrdtId, value: boolean): void {
    this.sub(index, (w) => {
      w.id(1, ts);
      w.bool(2, value);
    });
  }

  /** Write a length-prefixed subblock. */
  sub(index: number, fn: (w: Writer) => void): void {
    const inner = new Writer();
    fn(inner);
    const ib = inner.result();
    this.tag(index, TAG_LEN4);
    this.u32(ib.length);
    this.bytes(ib);
  }

  /** Write a top-level block (length-prefixed, with header). */
  block(
    blockType: number,
    minVersion: number,
    currentVersion: number,
    fn: (w: Writer) => void,
  ): void {
    const inner = new Writer();
    fn(inner);
    const ib = inner.result();
    this.u32(ib.length);
    this.u8(0); // unknown
    this.u8(minVersion);
    this.u8(currentVersion);
    this.u8(blockType);
    this.bytes(ib);
  }
}

function utf8Encode(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000)
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
  }
  return out;
}

/** Mints sequential CrdtIds under one author number. */
export class IdGen {
  private counter: number;
  constructor(
    private author: number,
    start = 10,
  ) {
    this.counter = start;
  }
  next(): CrdtId {
    return { part1: this.author, part2: this.counter++ };
  }
}

interface ItemIds {
  parent: CrdtId;
  item: CrdtId;
  left: CrdtId;
  right: CrdtId;
}

/** Write a SceneLineItemBlock (0x05) for a stroke. */
export function writeLineItem(w: Writer, stroke: RmStroke, ids: ItemIds): void {
  w.block(0x05, 2, 2, (b) => {
    b.id(1, ids.parent);
    b.id(2, ids.item);
    b.id(3, ids.left);
    b.id(4, ids.right);
    b.int(5, 0); // deleted_length
    b.sub(6, (s) => {
      s.u8(3); // ITEM_TYPE: line
      s.int(1, stroke.tool);
      s.int(2, stroke.colorIndex);
      s.double(3, stroke.thickness || 2);
      s.float(4, 0); // starting_length
      const width = Math.max(1, Math.round(stroke.pointWidth || 16));
      s.sub(5, (pts) => {
        for (const p of stroke.points) {
          pts.f32(p.x);
          pts.f32(p.y);
          pts.u16(0); // speed
          pts.u16(width);
          pts.u8(0); // direction
          pts.u8(0); // pressure
        }
      });
      s.id(6, { part1: 0, part2: 1 }); // timestamp
      if (stroke.rgba) s.color(8, stroke.rgba);
    });
  });
}

/** Write a SceneGlyphItemBlock (0x03) for a text highlight. */
export function writeGlyphItem(w: Writer, hl: RmHighlight, ids: ItemIds): void {
  w.block(0x03, 0, 1, (b) => {
    b.id(1, ids.parent);
    b.id(2, ids.item);
    b.id(3, ids.left);
    b.id(4, ids.right);
    b.int(5, 0); // deleted_length
    b.sub(6, (s) => {
      s.u8(1); // ITEM_TYPE: glyph
      s.int(2, 0); // start
      s.int(3, hl.text.length); // length
      s.int(4, hl.colorIndex);
      s.string(5, hl.text);
      s.sub(6, (rs) => {
        rs.varuint(hl.rects.length);
        for (const r of hl.rects) {
          rs.f64(r.x);
          rs.f64(r.y);
          rs.f64(r.w);
          rs.f64(r.h);
        }
      });
      if (hl.rgba) s.color(10, hl.rgba);
    });
  });
}

/**
 * Encode a header plus item blocks for the given strokes/highlights. The items
 * are chained into a CRDT sequence under `layerNode`, after `afterId`.
 *
 * NOTE: this emits the item blocks only — enough to round-trip through the
 * parser. A complete, device-valid page additionally needs the structural
 * blocks (author ids, page info, scene tree); that is layered on top in
 * rmpage.ts.
 */
export function writeItems(
  strokes: RmStroke[],
  highlights: RmHighlight[],
  opts: { author?: number; layerNode?: CrdtId; afterId?: CrdtId } = {},
): Uint8Array {
  const author = opts.author ?? 1;
  const layerNode = opts.layerNode ?? { part1: 1, part2: 1 };
  const ids = new IdGen(author);
  const w = new Writer();
  w.bytes(utf8Encode(HEADER_V6));

  writeChain(
    w,
    strokes,
    highlights,
    layerNode,
    ids,
    opts.afterId ?? END_MARKER,
  );
  return w.result();
}

function writeChain(
  w: Writer,
  strokes: RmStroke[],
  highlights: RmHighlight[],
  layerNode: CrdtId,
  ids: IdGen,
  start: CrdtId,
): void {
  let left = start;
  for (const hl of highlights) {
    const item = ids.next();
    writeGlyphItem(w, hl, { parent: layerNode, item, left, right: END_MARKER });
    left = item;
  }
  for (const stroke of strokes) {
    const item = ids.next();
    writeLineItem(w, stroke, {
      parent: layerNode,
      item,
      left,
      right: END_MARKER,
    });
    left = item;
  }
}

/**
 * Return a copy of a real `.rm` page with all scene items removed — i.e. its
 * header plus structural blocks (author ids, page info, scene tree, layers).
 * Used as a device-valid template for a page that has no `.rm` yet: clone the
 * structure of an existing page, then append our items to it.
 */
export function splitStructure(bytes: Uint8Array): Uint8Array {
  const HEADER_LEN = 43;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let i = 0; i < HEADER_LEN; i++) out.push(bytes[i]);

  let pos = HEADER_LEN;
  while (pos + 8 <= bytes.length) {
    const blockLen = dv.getUint32(pos, true);
    const type = bytes[pos + 7];
    const blockEnd = pos + 8 + blockLen;
    if (blockEnd > bytes.length) break;
    // Skip item blocks (line 0x05, glyph 0x03, tombstone 0x08); keep structure.
    if (type !== 0x05 && type !== 0x03 && type !== 0x08) {
      for (let i = pos; i < blockEnd; i++) out.push(bytes[i]);
    }
    pos = blockEnd;
  }
  return Uint8Array.from(out);
}

export interface RmStructure {
  /** header + structural blocks (no scene items) */
  structure: Uint8Array;
  /** the layer node to parent new items to */
  layerId: CrdtId;
  /** a registered author id to mint new item ids under */
  author: number;
  /** first counter to use for new item ids */
  startCounter: number;
}

/**
 * Generate a blank, device-valid page from scratch: author ids, migration info,
 * page info, scene tree, a root group and one layer group. Used when a page has
 * no `.rm` and the document has no other page to clone. Ported from rmscene's
 * `simple_text_document` (minus the text).
 */
export function blankStructure(author = 1): RmStructure {
  const w = new Writer();
  w.bytes(utf8Encode(HEADER_V6));
  const cid = (a: number, b: number): CrdtId => ({ part1: a, part2: b });

  // AuthorIdsBlock (0x09): map author id -> uuid.
  w.block(0x09, 1, 1, (b) => {
    b.varuint(1);
    b.sub(0, (s) => {
      s.varuint(16);
      s.bytes(AUTHOR_UUID);
      s.u16(author);
    });
  });
  // MigrationInfoBlock (0x00).
  w.block(0x0, 1, 1, (b) => {
    b.id(1, cid(1, 1));
    b.bool(2, true); // is_device
    b.bool(3, false);
  });
  // PageInfoBlock (0x0A).
  w.block(0xa, 0, 1, (b) => {
    b.int(1, 1); // loads_count
    b.int(2, 0); // merges_count
    b.int(3, 0); // text_chars_count
    b.int(4, 0); // text_lines_count
    b.int(5, 0); // type_folio_use_count
  });
  // SceneTreeBlock (0x01): registers the layer subtree under the root.
  w.block(0x1, 1, 1, (b) => {
    b.id(1, cid(0, 11)); // tree_id
    b.id(2, cid(0, 0)); // node_id
    b.bool(3, true); // is_update
    b.sub(4, (s) => s.id(1, cid(0, 1))); // parent_id = root
  });
  // TreeNodeBlock (0x02): root group.
  w.block(0x2, 1, 2, (b) => {
    b.id(1, cid(0, 1));
    b.lwwString(2, cid(0, 0), "");
    b.lwwBool(3, cid(0, 0), true);
  });
  // TreeNodeBlock (0x02): the layer.
  w.block(0x2, 1, 2, (b) => {
    b.id(1, cid(0, 11));
    b.lwwString(2, cid(0, 12), "Layer 1");
    b.lwwBool(3, cid(0, 0), true);
  });
  // SceneGroupItemBlock (0x04): make the layer a child of the root.
  w.block(0x4, 1, 1, (b) => {
    b.id(1, cid(0, 1)); // parent = root
    b.id(2, cid(0, 13)); // item_id
    b.id(3, cid(0, 0)); // left
    b.id(4, cid(0, 0)); // right
    b.int(5, 0); // deleted_length
    b.sub(6, (s) => {
      s.u8(0x02); // ITEM_TYPE: group
      s.id(2, cid(0, 11)); // value = layer node id
    });
  });

  return {
    structure: w.result(),
    layerId: cid(0, 11),
    author,
    startCounter: 20,
  };
}

/**
 * Append new item blocks (no header) onto an existing real `.rm` page, reusing
 * its layer and chaining after its last item. Keeps the page's device-valid
 * structure intact while adding our annotations.
 */
export function encodeAppend(
  existing: Uint8Array,
  strokes: RmStroke[],
  highlights: RmHighlight[],
  meta: {
    layerId: CrdtId;
    lastItemId?: CrdtId;
    /** an author id already registered in the page (reuse, don't invent) */
    author: number;
    /** first counter to use — must be above every existing part2 */
    startCounter: number;
  },
): Uint8Array {
  const w = new Writer();
  const ids = new IdGen(meta.author, meta.startCounter);
  writeChain(
    w,
    strokes,
    highlights,
    meta.layerId,
    ids,
    meta.lastItemId ?? END_MARKER,
  );
  const items = w.result();
  const out = new Uint8Array(existing.length + items.length);
  out.set(existing, 0);
  out.set(items, existing.length);
  return out;
}
