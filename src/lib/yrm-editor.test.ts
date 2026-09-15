import { describe, expect, it } from 'vitest';
import stock from '../data/yrm-stock-data.json';
import ra2Stock from '../data/ra2-stock-data.json';
import { decodeLcw, decodeMapPack, encodeOverlayPack, OVERLAY_LENGTH, YrmEditSession, type PlaceKind } from './yrm-editor';
import { encodeYrmPreview, mapOutputName, packYrmLines, readYrmPreview } from './yrm-preview';

const bytes = (text: string) => new TextEncoder().encode(text);
const location = (x: number, y: number) => y * 512 + x;
function lzoPack(data: Uint8Array): Uint8Array {
  const result: number[] = [];
  for (let start = 0; start < data.length; start += 8192) {
    const chunk = data.subarray(start, start + 8192); const packed: number[] = [];
    if (chunk.length <= 238) packed.push(17 + chunk.length);
    else { packed.push(0); let count = chunk.length - 18; while (count > 255) { packed.push(0); count -= 255; } packed.push(count); }
    packed.push(...chunk, 17, 0, 0);
    result.push(packed.length & 255, packed.length >> 8, chunk.length & 255, chunk.length >> 8, ...packed);
  }
  return new Uint8Array(result);
}
function fixture(options: { extra?: string; terrain?: [number, number, number, number?][]; overlay?: Uint8Array; frames?: Uint8Array } = {}): Uint8Array {
  const iso = new Uint8Array((options.terrain?.length ?? 0) * 11 + 4); const view = new DataView(iso.buffer);
  options.terrain?.forEach(([x, y, tile, sub = 0], index) => {
    const offset = index * 11; view.setInt16(offset, x, true); view.setInt16(offset + 2, y, true); view.setInt32(offset + 4, tile, true); iso[offset + 8] = sub;
  });
  const overlays = options.overlay ?? new Uint8Array(OVERLAY_LENGTH).fill(255);
  const frames = options.frames ?? new Uint8Array(OVERLAY_LENGTH);
  const text = '[Basic]\nName=测试地图\nNewINIFormat=4\nMultiplayerOnly=1\nMaxPlayer=2\n'
    + '[Map]\nSize=0,0,16,16\nLocalSize=2,2,12,12\nTheater=TEMPERATE\n'
    + `[IsoMapPack5]\n${packYrmLines(lzoPack(iso))}\n[OverlayPack]\n${packYrmLines(encodeOverlayPack(overlays))}\n[OverlayDataPack]\n${packYrmLines(encodeOverlayPack(frames))}\n`
    + '[Digest]\n1=original-digest\n\n; 原有任务保持原样\n[Triggers]\nABC=Neutral,<none>,触发器,0,1,1,1,0\n[CustomData]\nValue=literal $value <tag> & text\n'
    + (options.extra ?? '');
  return bytes(text.replaceAll('\n', '\r\n'));
}
const paint = (session: YrmEditSession, kind: 'ore' | 'gems' | 'erase', x = 15, y = 15, radius = 0) => {
  session.beginStroke(); const count = session.paint(x, y, kind, radius); session.endStroke(); return count;
};
function unchangedSections(source: Uint8Array): string[] {
  return new TextDecoder().decode(source).split(/(?=^\[)/m).filter((section) => !/^\[(?:OverlayPack|OverlayDataPack|Preview|PreviewPack)\]/i.test(section));
}

describe('resource overlay codec', () => {
  it('round-trips long runs, all literal byte values and runs crossing 8192-byte blocks', () => {
    const input = new Uint8Array(OVERLAY_LENGTH).fill(255);
    for (let i = 8090; i < 8600; i += 1) input[i] = i & 255;
    input.fill(11, 16000, 19000);
    expect(decodeMapPack(encodeOverlayPack(input), 'lcw', input.length, true)).toEqual(input);
  });
  it.each([
    [[131, 1, 2, 3, 0, 3, 128], [1, 2, 3, 1, 2, 3]],
    [[129, 9, 192, 0, 0, 128], [9, 9, 9, 9]],
    [[129, 9, 255, 5, 0, 0, 0, 128], [9, 9, 9, 9, 9, 9]],
    [[254, 4, 0, 7, 128], [7, 7, 7, 7]],
  ])('decodes LCW dictionary and fill commands %j', (input, expected) => {
    const output = new Uint8Array(expected.length); decodeLcw(new Uint8Array(input), output); expect([...output]).toEqual(expected);
  });
  it.each([[0, 1, 128], [255, 9, 0, 0, 0, 128], [254, 0, 0, 1, 128], [254, 5, 0, 1, 128], [131, 1], [131, 1, 2, 3, 128, 0], [128]])('rejects invalid LCW commands %j', (...input) => {
    expect(() => decodeLcw(new Uint8Array(input), new Uint8Array(3))).toThrow();
  });
  it('validates block headers and exact output lengths before allocating or decoding', () => {
    expect(() => decodeMapPack(new Uint8Array([1, 0, 0]), 'lcw', 10)).toThrow();
    expect(() => decodeMapPack(new Uint8Array([1, 0, 1, 32, 128]), 'lcw', 9000)).toThrow();
    expect(() => decodeMapPack(encodeOverlayPack(new Uint8Array(OVERLAY_LENGTH)), 'lcw', 3)).toThrow();
    expect(() => encodeOverlayPack(new Uint8Array(10))).toThrow();
  });
});

describe('YRM mineral editing', () => {
  it('fills implicit clear cells, maps real isometric coordinates and preserves untouched files exactly', () => {
    const input = fixture(); const session = new YrmEditSession(input);
    expect(session.cells.size).toBe(16 * 31);
    expect(session.cells.get(location(15, 15))).toMatchObject({ x: 15, y: 15, tile: 0, blocked: '' });
    expect(session.exportMap()).toEqual(input);
  });
  it('adds full ore to exactly one cell and round-trips exported resources and generated preview', () => {
    const input = fixture(); const before = input.slice(); const session = new YrmEditSession(input);
    expect(paint(session, 'ore')).toBe(1);
    expect(session.resourceAt(location(15, 15))).toBe('ore'); expect(session.frames[location(15, 15)]).toBe(11);
    expect(session.changedCount).toBe(1);
    const output = session.exportMap(); const loaded = new YrmEditSession(output);
    expect(loaded.overlay).toEqual(session.overlay); expect(loaded.frames).toEqual(session.frames);
    expect(unchangedSections(output)).toEqual(unchangedSections(input));
    expect(readYrmPreview(output).preview).toEqual(session.overview());
    expect(input).toEqual(before);
  });
  it('groups repeated drag positions into one undo operation and returns to the original bytes', () => {
    const input = fixture(); const session = new YrmEditSession(input);
    session.beginStroke(); session.paint(15, 15, 'ore', 1); session.paint(16, 15, 'gems', 1); session.paint(15, 15, 'gems', 1); session.endStroke();
    const changed = session.overlay.slice(); expect(session.changedCount).toBeGreaterThan(1);
    session.undo(); expect(session.changedCount).toBe(0); expect(session.dirty).toBe(false); expect(session.exportMap()).toEqual(input);
    session.redo(); expect(session.overlay).toEqual(changed); expect(session.dirty).toBe(true);
    session.undo(); paint(session, 'ore', 14, 14); expect(session.canRedo).toBe(false);
  });
  it('cancels an unfinished stroke and tracks unsaved changes relative to the last export', () => {
    const session = new YrmEditSession(fixture());
    session.beginStroke(); session.paint(15, 15, 'ore', 0); expect(session.dirty).toBe(true);
    expect(() => session.exportMap()).toThrow('结束'); session.cancelStroke(); expect(session.dirty).toBe(false);
    paint(session, 'ore'); session.markSaved(); expect(session.dirty).toBe(false);
    session.undo(); expect(session.dirty).toBe(true); session.redo(); expect(session.dirty).toBe(false);
  });
  it('erases only ore and gems, keeping walls, bridges and other overlays byte-identical', () => {
    const overlay = new Uint8Array(OVERLAY_LENGTH).fill(255); const frames = new Uint8Array(OVERLAY_LENGTH);
    overlay[location(15, 15)] = 102; frames[location(15, 15)] = 11;
    overlay[location(16, 15)] = 27; frames[location(16, 15)] = 11;
    overlay[location(14, 15)] = 0; frames[location(14, 15)] = 5;
    const s = new YrmEditSession(fixture({ overlay, frames }));
    expect(paint(s, 'erase', 15, 15, 1)).toBe(2);
    expect(s.overlay[location(14, 15)]).toBe(0); expect(s.frames[location(14, 15)]).toBe(5);
    expect(paint(s, 'gems', 14, 15)).toBe(0);
  });
  it('protects water, slopes, unknown tiles, playable borders, buildings, trees and starting locations', () => {
    const water = stock.theaters.TEMPERATE.tiles.findIndex((tile) => tile[0]?.[1] === 9);
    const slope = stock.theaters.TEMPERATE.tiles.findIndex((tile) => tile[0] && tile[0][2] > 0);
    expect(water).toBeGreaterThan(0); expect(slope).toBeGreaterThan(0);
    const s = new YrmEditSession(fixture({ terrain: [[15, 15, water], [16, 15, slope], [17, 15, 99999]],
      extra: '[Structures]\n0=Neutral,CAOILD,256,12,12,0,None,1,0,1,0,0,None,None,None,0,0\n[Terrain]\n18018=TREE01\n[Waypoints]\n0=20020\n' }));
    expect(s.readOnlyReasons).toEqual([]);
    for (const [x, y] of [[15, 15], [16, 15], [17, 15], [1, 16], [12, 12], [13, 13], [18, 18], [19, 18], [20, 20]]) expect(paint(s, 'ore', x, y)).toBe(0);
    expect(paint(s, 'ore', 14, 14)).toBe(1);
    expect(s.changedCount).toBe(1);
  });
  it.each([
    '[OverlayTypes]\n0=CUSTOM\n', '[Tiberiums]\n0=Custom\n', '[TIB01]\nImage=Different\n',
    '[TileSet0000]\nFileName=Other\n', '[Structures]\n0=Neutral,CUSTOM,256,15,15\n',
    '[CAOILD]\nFoundation=5x5\n', '[Structures]\n0=Neutral,CAOILD,256,15,15\n[CAOILD]\nImage=Other\n',
  ])('keeps maps with incompatible custom rules read-only: %s', (extra) => {
    const s = new YrmEditSession(fixture({ extra })); expect(s.readOnly).toBe(true);
    expect(paint(s, 'ore')).toBe(0); expect(() => s.exportMap()).toThrow('只读');
  });
  it('rejects duplicate sections, invalid coordinates and oversized dimensions', () => {
    expect(() => new YrmEditSession(fixture({ extra: '[Map]\nSize=0,0,16,16\n' }))).toThrow('重复');
    expect(() => new YrmEditSession(fixture({ terrain: [[-1, 15, 0]] }))).toThrow('坐标');
    const oversized = bytes(new TextDecoder().decode(fixture()).replace('Size=0,0,16,16', 'Size=0,0,400,400'));
    expect(() => new YrmEditSession(oversized)).toThrow('512');
  });
  it('preserves legacy-encoded names and comments while exporting ASCII resource sections', () => {
    const text = new TextDecoder().decode(fixture()).replace('测试地图', 'GBKNAME').replace(/[^\x00-\x7f]/g, '?'); const [first, second] = text.split('GBKNAME');
    const source = new Uint8Array([...bytes(first), 0xd6, 0xd0, 0xce, 0xc4, ...bytes(second)]);
    const s = new YrmEditSession(source); paint(s, 'gems');
    const output = s.exportMap(); expect(new YrmEditSession(output).info.name).toBe('中文');
    const marker = [...output].findIndex((value, i) => value === 0xd6 && output[i + 1] === 0xd0);
    expect([...output.slice(marker, marker + 4)]).toEqual([0xd6, 0xd0, 0xce, 0xc4]);
  });
  it('encodes previews across LZO blocks without changing RGB channel order', () => {
    const rgb = Uint8Array.from({ length: 400 * 50 * 3 }, (_, i) => (i * 31) & 255);
    const preview = { width: 400, height: 50, rgb }; const encoded = encodeYrmPreview(preview);
    const source = new TextDecoder().decode(fixture()) + `[Preview]\nSize=${encoded.size}\n[PreviewPack]\n${encoded.pack}\n`;
    expect(readYrmPreview(bytes(source)).preview).toEqual(preview);
  });
  it('keeps later edits dirty when an earlier export finishes', () => {
    const s = new YrmEditSession(fixture()); paint(s, 'ore');
    const snapshot = { overlay: s.overlay.slice(), frames: s.frames.slice() };
    paint(s, 'gems', 16, 15); s.markSaved(snapshot.overlay, snapshot.frames);
    expect(s.dirty).toBe(true); s.undo(); expect(s.dirty).toBe(false);
  });
  it('preserves BOM and a final section without a newline when adding a missing preview', () => {
    const source = new Uint8Array([239, 187, 191, ...fixture().slice(0, -2)]);
    const s = new YrmEditSession(source); paint(s, 'ore'); const result = s.exportMap();
    expect([...result.slice(0, 3)]).toEqual([239, 187, 191]);
    expect(unchangedSections(result)).toEqual(unchangedSections(source));
  });
});

describe('game-specific map editing', () => {
  it('applies different placement rules to the same urban tile in RA2 and YR', () => {
    expect(ra2Stock.theaters.URBAN.tiles[435][0]?.[0]).toBe(0);
    expect(stock.theaters.URBAN.tiles[435][0]?.[0]).toBe(1);
    const source = bytes(new TextDecoder().decode(fixture({ terrain: [[15, 15, 435]] })).replace('Theater=TEMPERATE', 'Theater=URBAN'));
    const ra2 = new YrmEditSession(source, 'ra2'); const yr = new YrmEditSession(source, 'yr');
    expect(ra2.game).toBe('ra2'); expect(yr.game).toBe('yr');
    expect(paint(ra2, 'ore')).toBe(0); expect(paint(yr, 'ore')).toBe(1);
    expect(ra2.exportMap()).toEqual(source);
  });
  it('uses the selected game’s building catalog and foundation', () => {
    const source = fixture({ extra: '[Structures]\n0=Neutral,NAWAST,256,12,12\n' });
    const ra2 = new YrmEditSession(source, 'ra2'); const yr = new YrmEditSession(source, 'yr');
    expect(ra2.readOnlyReasons).toEqual([]); expect(paint(ra2, 'ore', 14, 14)).toBe(0);
    expect(paint(ra2, 'ore', 15, 15)).toBe(1);
    expect(yr.readOnly).toBe(true); expect(yr.readOnlyReasons.join(' ')).toContain('NAWAST');
  });
  it('requires a valid game selection and protects a YR-only theater from RA2 rules', () => {
    const source = bytes(new TextDecoder().decode(fixture()).replace('Theater=TEMPERATE', 'Theater=DESERT'));
    expect(() => new YrmEditSession(source, 'ra2')).toThrow('该地形不在红警 2');
    expect(new YrmEditSession(source, 'yr').readOnly).toBe(false);
    expect(() => new YrmEditSession(source, 'unknown' as never)).toThrow('请选择');
  });
  it.each(['ra2', 'yr'] as const)('preserves non-resource data and history under %s rules', (game) => {
    const source = fixture(); const s = new YrmEditSession(source, game);
    paint(s, 'gems'); const output = s.exportMap(); const again = new YrmEditSession(output, game);
    expect(again.overlay).toEqual(s.overlay); expect(again.frames).toEqual(s.frames);
    expect(unchangedSections(output)).toEqual(unchangedSections(source));
    s.undo(); expect(s.exportMap()).toEqual(source); s.redo(); expect(s.exportMap()).toEqual(output);
    for (const extension of ['mpr', 'map', 'yrm', 'yro']) expect(mapOutputName(`original.${extension}`, 'edited')).toBe(`original-edited.${extension}`);
  });
  it('preserves Windows-1252 names and all untouched bytes after editing', () => {
    const template = new TextDecoder().decode(fixture()).replace('测试地图', 'NAME').replace(/[^\x00-\x7f]/g, '?');
    const [first, last] = template.split('NAME');
    const source = new Uint8Array([...bytes(first), 67, 97, 102, 233, ...bytes(last)]);
    const session = new YrmEditSession(source, 'ra2'); paint(session, 'ore');
    const output = session.exportMap(); expect(readYrmPreview(output).name).toBe('Café');
    const untouched = (data: Uint8Array) => Buffer.from(data).toString('latin1').split(/(?=^\[)/m).filter(s => !/^\[(OverlayPack|OverlayDataPack|Preview|PreviewPack)\]/i.test(s));
    expect(untouched(output)).toEqual(untouched(source));
  });
});

// 沿 axis 铺一条 3 格宽的低桥，两端各一格引桥，frame 记录轨道序号。
function lowBridge(axis: 'x' | 'y', deck: number, ramp: number, override: Record<number, number> = {}, from = 12, to = 20) {
  const overlay = new Uint8Array(OVERLAY_LENGTH).fill(255); const frames = new Uint8Array(OVERLAY_LENGTH);
  for (let lane = 0; lane < 3; lane += 1) for (let step = from; step <= to; step += 1) {
    const at = location(axis === 'x' ? step : 14 + lane, axis === 'x' ? 14 + lane : step);
    overlay[at] = override[step] ?? (step === from || step === to ? ramp : deck); frames[at] = lane;
  }
  return fixture({ overlay, frames });
}
const lane = (session: YrmEditSession, axis: 'x' | 'y', step: number, track = 1) =>
  session.overlay[location(axis === 'x' ? step : 14 + track, axis === 'x' ? 14 + track : step)];

describe('low bridge breaking', () => {
  it.each([
    ['x' as const, 76, 92, 100, 82, 81],
    ['y' as const, 84, 96, 101, 90, 91],
    ['x' as const, 207, 225, 231, 213, 212],
    ['y' as const, 216, 227, 232, 221, 222],
  ])('breaks a %s-axis bridge with deck %i and seals both ends', (axis, deck, ramp, dead, capLow, capHigh) => {
    const session = new YrmEditSession(lowBridge(axis, deck, ramp));
    session.beginStroke();
    expect(session.paint(axis === 'x' ? 16 : 15, axis === 'x' ? 15 : 16, 'bridge', 0)).toBe(3);
    session.endStroke();
    expect([13, 14, 15, 16, 17, 18, 19].map((step) => lane(session, axis, step)))
      .toEqual([deck, deck, capLow, dead, capHigh, deck, deck]);
    expect([0, 1, 2].map((track) => lane(session, axis, 16, track))).toEqual([dead, dead, dead]);
    expect([0, 1, 2].map((track) => session.frames[location(axis === 'x' ? 16 : 14 + track, axis === 'x' ? 14 + track : 16)])).toEqual([0, 1, 2]);
  });
  it('extends one break across a drag, fills a single remaining deck cell and restores the original bytes on undo', () => {
    const input = lowBridge('x', 76, 92); const session = new YrmEditSession(input);
    session.beginStroke(); session.paint(15, 15, 'bridge', 0); session.paint(17, 15, 'bridge', 0); session.endStroke();
    expect([14, 15, 16, 17, 18].map((step) => lane(session, 'x', step))).toEqual([82, 100, 100, 100, 81]);
    session.undo(); expect(session.changedCount).toBe(0); expect(session.exportMap()).toEqual(input);
  });
  it('keeps separate breaks apart and seals each one', () => {
    const session = new YrmEditSession(lowBridge('x', 76, 92));
    session.beginStroke(); session.paint(14, 15, 'bridge', 0); session.paint(18, 15, 'bridge', 0); session.endStroke();
    expect([13, 14, 15, 16, 17, 18, 19].map((step) => lane(session, 'x', step))).toEqual([82, 100, 81, 76, 82, 100, 81]);
  });
  it('reserves the deck cell next to each ramp as the break cap', () => {
    const session = new YrmEditSession(lowBridge('x', 76, 92));
    expect(session.reasonAt(session.cells.get(location(13, 15))!, 'bridge')).toBe('桥头这一格要留作断口');
    session.beginStroke();
    expect(session.paint(13, 15, 'bridge', 0)).toBe(0);
    for (let step = 13; step <= 16; step += 1) session.paint(step, 15, 'bridge', 0);
    session.endStroke();
    expect([13, 14, 15, 16, 17].map((step) => lane(session, 'x', step))).toEqual([82, 100, 100, 100, 81]);
  });
  it('re-caps a bridge whose existing break already reaches the ramp', () => {
    const session = new YrmEditSession(lowBridge('x', 76, 92, { 13: 100, 14: 100 }));
    session.beginStroke(); session.paint(16, 15, 'bridge', 0); session.endStroke();
    expect([13, 14, 15, 16, 17].map((step) => lane(session, 'x', step))).toEqual([82, 100, 100, 100, 81]);
  });
  it('refuses a lone deck strip that is not a full three-lane section', () => {
    const overlay = new Uint8Array(OVERLAY_LENGTH).fill(255); const frames = new Uint8Array(OVERLAY_LENGTH);
    for (let step = 13; step <= 17; step += 1) { overlay[location(step, 15)] = 76; frames[location(step, 15)] = 1; }
    const session = new YrmEditSession(fixture({ overlay, frames }));
    expect(session.reasonAt(session.cells.get(location(15, 15))!, 'bridge')).toBe('这里不是完整的 3 格宽桥面');
    session.beginStroke(); expect(session.paint(15, 15, 'bridge', 0)).toBe(0); session.endStroke();
    expect(session.changedCount).toBe(0);
  });
  it('refuses cells that are not low bridge deck and reports why', () => {
    const session = new YrmEditSession(lowBridge('x', 76, 92));
    const cell = (x: number, y: number) => session.cells.get(location(x, y))!;
    expect(session.reasonAt(cell(15, 20), 'bridge')).toBe('此处不是低桥桥面');
    expect(session.reasonAt(cell(12, 15), 'bridge')).toBe('此处不是低桥桥面');
    session.beginStroke(); expect(session.paint(15, 20, 'bridge', 0)).toBe(0); expect(session.paint(12, 15, 'bridge', 0)).toBe(0); session.endStroke();
    expect(session.changedCount).toBe(0);
  });
  it('reports an already broken span and leaves it unchanged', () => {
    const session = new YrmEditSession(lowBridge('x', 76, 92));
    session.beginStroke(); session.paint(16, 15, 'bridge', 0); session.endStroke();
    expect(session.reasonAt(session.cells.get(location(16, 15))!, 'bridge')).toBe('此处的桥面已经断开');
    const broken = session.overlay.slice();
    session.beginStroke(); expect(session.paint(16, 15, 'bridge', 0)).toBe(0); session.endStroke();
    expect(session.overlay).toEqual(broken); expect(session.canUndo).toBe(true);
  });
  it('round-trips a broken bridge through export and leaves other sections untouched', () => {
    const input = lowBridge('x', 76, 92); const session = new YrmEditSession(input);
    session.beginStroke(); session.paint(16, 15, 'bridge', 0); session.endStroke();
    const output = session.exportMap();
    const reopened = new YrmEditSession(output);
    expect(reopened.overlay).toEqual(session.overlay); expect(reopened.frames).toEqual(session.frames);
    expect(unchangedSections(output)).toEqual(unchangedSections(input));
  });
});

describe('placing and removing map objects', () => {
  const drop = (session: YrmEditSession, kind: PlaceKind, x = 15, y = 15) => {
    session.beginStroke(); const placed = session.place(x, y, kind); session.endStroke(); return placed;
  };
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  it.each([
    ['oil' as const, 'CAOILD', 2, 2],
    ['airport' as const, 'CAAIRP', 3, 3],
    ['hospital' as const, 'CATHOSP', 6, 4],
    ['bridgehut' as const, 'CABHUT', 1, 1],
    ['machineshop' as const, 'CAMACH', 3, 3],
    ['power' as const, 'CAPOWR', 2, 2],
    ['lab' as const, 'CASLAB', 3, 3],
    ['outpost' as const, 'CAOUTP', 4, 3],
  ])('places %s as a neutral structure row using the stock footprint', (kind, name, width, height) => {
    const session = new YrmEditSession(fixture());
    expect(session.footprint(kind)).toEqual([width, height]);
    expect(drop(session, kind)).toBe(true);
    expect(session.objectCount).toBe(1);
    expect(decode(session.exportMap())).toContain(`0=Neutral,${name},256,15,15,64,None,1,0,1,0,0,None,None,None,0,0`);
    expect(session.cells.get(location(15 + width - 1, 15 + height - 1))!.object).toBe('building');
    expect(session.cells.get(location(15 + width, 15 + height))?.object).toBeUndefined();
  });
  it('places an ore tree as a terrain row keyed by its coordinate and shades the ring around it', () => {
    const session = new YrmEditSession(fixture());
    expect(drop(session, 'oretree')).toBe(true);
    expect(decode(session.exportMap())).toContain('15015=TIBTRE01');
    expect(session.cells.get(location(15, 15))!.object).toBe('terrain');
    expect(session.cells.get(location(14, 14))!.object).toBe('terrain');
    expect(session.cells.get(location(13, 13))?.object).toBeUndefined();
  });
  it('keeps existing entries and takes the next free index', () => {
    const existing = '[Structures]\n5=Neutral,CAOILD,256,20,20,64,None,1,0,1,0,0,None,None,None,0,0\n';
    const session = new YrmEditSession(fixture({ extra: existing }));
    expect(drop(session, 'oil')).toBe(true);
    const text = decode(session.exportMap());
    expect(text).toContain('5=Neutral,CAOILD,256,20,20');
    expect(text).toContain('6=Neutral,CAOILD,256,15,15');
  });
  it('removes an object from any cell of its footprint and frees the ground again', () => {
    const session = new YrmEditSession(fixture());
    drop(session, 'airport');
    expect(session.objectAt(17, 17)?.name).toBe('CAAIRP');
    session.beginStroke(); expect(session.removeAt(17, 17)).toBe(true); session.endStroke();
    expect(session.objectCount).toBe(0);
    expect(session.cells.get(location(15, 15))!.object).toBeUndefined();
    expect(session.placeReason(15, 15, 'airport')).toBe('');
  });
  it('refuses overlapping placements and cells outside the playable area', () => {
    const session = new YrmEditSession(fixture());
    drop(session, 'oil');
    session.beginStroke();
    expect(session.place(15, 15, 'oil')).toBe(false);
    expect(session.place(16, 16, 'oil')).toBe(false);
    expect(session.place(1, 16, 'oil')).toBe(false);
    session.endStroke();
    expect(session.objectCount).toBe(1);
    expect(session.placeReason(15, 15, 'oil')).toBe('建筑占地');
  });
  it('undoes and redoes object edits and restores the original bytes', () => {
    const input = fixture(); const session = new YrmEditSession(input);
    drop(session, 'oil');
    expect(session.dirty).toBe(true);
    session.undo();
    expect(session.objectCount).toBe(0); expect(session.dirty).toBe(false); expect(session.exportMap()).toEqual(input);
    session.redo();
    expect(session.objectCount).toBe(1); expect(session.cells.get(location(15, 15))!.object).toBe('building');
  });
  it('round-trips placed objects through export and leaves unrelated sections untouched', () => {
    const input = fixture(); const session = new YrmEditSession(input);
    drop(session, 'oil'); drop(session, 'oretree', 20, 20);
    const output = session.exportMap();
    const reopened = new YrmEditSession(output);
    expect(reopened.objectAt(16, 16)?.name).toBe('CAOILD');
    expect(reopened.objectAt(20, 20)?.name).toBe('TIBTRE01');
    expect(reopened.objectCount).toBe(0);
    const kept = (data: Uint8Array) => decode(data).split(/(?=^\[)/m).filter((part) => !/^\[(?:OverlayPack|OverlayDataPack|Preview|PreviewPack|Structures|Terrain)\]/i.test(part));
    expect(kept(output)).toEqual(kept(input));
  });
  it('reports placement and removal reasons through the shared brush check', () => {
    const session = new YrmEditSession(fixture());
    const cell = session.cells.get(location(15, 15))!;
    expect(session.reasonAt(cell, 'remove')).toBe('此处没有可删除的建筑或地形对象');
    expect(session.reasonAt(cell, 'oil')).toBe('');
    drop(session, 'oil');
    expect(session.reasonAt(cell, 'remove')).toBe('');
    expect(session.reasonAt(cell, 'oil')).toBe('建筑占地');
  });
});
