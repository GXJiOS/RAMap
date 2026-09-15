// 游戏美术资源：主进程负责解 MIX，这里只解 SHP、TMP 图块与调色板并缓存。
export type Palette = Uint8Array;
export type ShpFrame = { x: number; y: number; width: number; height: number; compression: number; offset: number };
export type Shp = { width: number; height: number; count: number; frames: ShpFrame[]; bytes: Uint8Array };
export type Tile = { pixels: Uint8Array; width: number; height: number };
export type TheaterTile = { file: string; set: string };

export const TILE_WIDTH = 60;
export const TILE_HEIGHT = 30;
const THEATERS: Record<string, { ini: string; extension: string }> = {
  TEMPERATE: { ini: 'temperatmd.ini', extension: 'tem' }, SNOW: { ini: 'snowmd.ini', extension: 'sno' },
  URBAN: { ini: 'urbanmd.ini', extension: 'urb' }, DESERT: { ini: 'desertmd.ini', extension: 'des' },
  LUNAR: { ini: 'lunarmd.ini', extension: 'lun' }, NEWURBAN: { ini: 'urbannmd.ini', extension: 'ubn' },
};
export const theaterSupported = (name: string) => Object.hasOwn(THEATERS, name);

export function readPalette(bytes: Uint8Array): Palette {
  const palette = new Uint8Array(768);
  for (let i = 0; i < 768 && i < bytes.length; i += 1) palette[i] = Math.min(255, bytes[i] << 2);
  return palette;
}

export function readShp(bytes: Uint8Array): Shp {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(6, true);
  const frames: ShpFrame[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = 8 + i * 24;
    if (at + 24 > bytes.length) break;
    frames.push({
      x: view.getInt16(at, true), y: view.getInt16(at + 2, true),
      width: view.getUint16(at + 4, true), height: view.getUint16(at + 6, true),
      compression: view.getUint32(at + 8, true), offset: view.getUint32(at + 20, true),
    });
  }
  return { width: view.getUint16(2, true), height: view.getUint16(4, true), count: frames.length, frames, bytes };
}

// 压缩位为 RLE-Zero：每行以长度开头，0 之后的字节表示跳过的透明像素数。
export function decodeShpFrame(shp: Shp, index: number): Uint8Array {
  const frame = shp.frames[index];
  const pixels = new Uint8Array(Math.max(0, frame?.width * frame?.height) || 0);
  if (!frame?.offset || !frame.width || !frame.height) return pixels;
  const bytes = shp.bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = frame.offset;
  if (!(frame.compression & 2)) {
    pixels.set(bytes.subarray(at, at + pixels.length));
    return pixels;
  }
  for (let y = 0; y < frame.height && at + 2 <= bytes.length; y += 1) {
    const lineEnd = at + view.getUint16(at, true);
    at += 2;
    let x = 0;
    while (at < lineEnd && at < bytes.length && x < frame.width) {
      const value = bytes[at++];
      if (value) pixels[y * frame.width + x++] = value;
      else x += bytes[at++];
    }
    at = lineEnd;
  }
  return pixels;
}

// 地形图块是 60×30 的菱形，逐行宽度 2,6,…,58,58,…,6,2，共 900 字节。
export function readTile(bytes: Uint8Array, block: number): Tile | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blocks = view.getInt32(0, true) * view.getInt32(4, true);
  if (block < 0 || block >= blocks) return null;
  const offset = view.getInt32(16 + block * 4, true);
  if (!offset || offset + 52 + 900 > bytes.length) return null;
  const pixels = new Uint8Array(TILE_WIDTH * TILE_HEIGHT);
  let at = offset + 52;
  for (let y = 0; y < TILE_HEIGHT; y += 1) {
    const half = y < TILE_HEIGHT / 2 ? y : TILE_HEIGHT - 1 - y;
    const width = 2 + 4 * half;
    const start = (TILE_WIDTH - width) >> 1;
    for (let x = 0; x < width; x += 1) pixels[y * TILE_WIDTH + start + x] = bytes[at++];
  }
  return { pixels, width: TILE_WIDTH, height: TILE_HEIGHT };
}

// theater 的 ini 用「键 = 值」写法，tile 全局编号按 TileSet 顺序累加。
export function readTheaterTiles(bytes: Uint8Array, extension: string): TheaterTile[] {
  const text = new TextDecoder('latin1').decode(bytes).replace(/\r/g, '');
  const sets: { index: number; file: string; name: string; count: number }[] = [];
  const section = /\[TileSet(\d{4})\]\n([\s\S]*?)(?=\n\[|$)/g;
  let match: RegExpExecArray | null;
  while ((match = section.exec(text))) {
    const body = match[2];
    const pick = (key: string) => body.match(new RegExp(`^${key}\\s*=\\s*([^\\n;]*)`, 'mi'))?.[1]?.trim() ?? '';
    sets.push({ index: Number(match[1]), file: pick('FileName'), name: pick('SetName'), count: Number(pick('TilesInSet') || 0) });
  }
  sets.sort((a, b) => a.index - b.index);
  const tiles: TheaterTile[] = [];
  for (const set of sets) {
    for (let i = 0; i < set.count; i += 1) tiles.push({ file: `${set.file}${String(i + 1).padStart(2, '0')}.${extension}`, set: set.name });
  }
  return tiles;
}

export class GameArt {
  private readonly raw = new Map<string, Uint8Array | null>();
  private readonly shps = new Map<string, Shp | null>();
  readonly extension: string;
  private readonly theaterFile: string;
  tiles: TheaterTile[] = [];
  isoPalette: Palette = new Uint8Array(768);
  unitPalette: Palette = new Uint8Array(768);

  constructor(theater: string) {
    const profile = THEATERS[theater] ?? THEATERS.TEMPERATE;
    this.extension = profile.extension;
    this.theaterFile = profile.ini;
  }
  private static decode(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  async load(names: readonly string[]): Promise<number> {
    const bridge = window.mapDesktop;
    if (!bridge) return 0;
    const pending = [...new Set(names)].filter((name) => !this.raw.has(name));
    const results = await Promise.all(pending.map(async (name) => [name, await bridge.readAsset(name)] as const));
    for (const [name, value] of results) { this.raw.set(name, value ? GameArt.decode(value) : null); this.shps.delete(name); }
    return results.filter(([, value]) => value).length;
  }
  async prepare(): Promise<boolean> {
    await this.load([this.theaterFile, `iso${this.extension}.pal`, `unit${this.extension}.pal`, 'isotem.pal', 'unittem.pal']);
    const theater = this.raw.get(this.theaterFile);
    if (!theater) return false;
    this.tiles = readTheaterTiles(theater, this.extension);
    this.isoPalette = readPalette(this.raw.get(`iso${this.extension}.pal`) ?? this.raw.get('isotem.pal') ?? new Uint8Array(768));
    this.unitPalette = readPalette(this.raw.get(`unit${this.extension}.pal`) ?? this.raw.get('unittem.pal') ?? new Uint8Array(768));
    return this.tiles.length > 0;
  }
  bytes(name: string): Uint8Array | null { return this.raw.get(name) ?? null; }
  shp(name: string): Shp | null {
    if (!this.raw.has(name)) return null;
    if (!this.shps.has(name)) {
      const bytes = this.raw.get(name);
      this.shps.set(name, bytes ? readShp(bytes) : null);
    }
    return this.shps.get(name) ?? null;
  }
  tileFile(tile: number): string | null { return this.tiles[tile]?.file ?? null; }
}
