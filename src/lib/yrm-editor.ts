import stockData from '../data/yrm-stock-data.json';
import ra2StockData from '../data/ra2-stock-data.json';
import { decodeLzoBlock, encodeYrmPreview, MAP_GAME_NAMES, MAX_YRM_BYTES, packYrmLines, readYrmPreview, type MapGame, type YrmMap, type YrmPreview } from './yrm-preview';

type TileRule = [allowed: number, land: number, ramp: number, color: number];
type ObjectRule = { image: string; foundation: number[] | null };
type StockRules = {
  theaters: Record<string, { tiles: (TileRule | null)[][] }>;
  buildings: Record<string, ObjectRule>; terrain: Record<string, ObjectRule>;
  overlays: string[]; resources: Record<'ore' | 'gems', number[]>; resourceRuleNames: string[];
};
const stockProfiles: Record<MapGame, StockRules> = { yr: stockData as unknown as StockRules, ra2: ra2StockData as unknown as StockRules };
export type PlaceKind = 'oil' | 'airport' | 'hospital' | 'oretree';
export type EditBrush = 'ore' | 'gems' | 'erase' | 'bridge' | PlaceKind | 'remove';
type ObjectSection = 'structures' | 'terrain';
type Placeable = { label: string; section: ObjectSection; name: string };
export const PLACEABLE: Record<PlaceKind, Placeable> = {
  oil: { label: '油井', section: 'structures', name: 'CAOILD' },
  airport: { label: '科技机场', section: 'structures', name: 'CAAIRP' },
  hospital: { label: '市民医院', section: 'structures', name: 'CAHOSP' },
  oretree: { label: '矿石树', section: 'terrain', name: 'TIBTRE01' },
};
// 中立建筑行的 17 个字段，除类型与坐标外在 2 万余个原版条目中取值一致。
const structureLine = (name: string, x: number, y: number) => `Neutral,${name},256,${x},${y},64,None,1,0,1,0,0,None,None,None,0,0`;
const SECTION_TITLE: Record<ObjectSection, string> = { structures: 'Structures', terrain: 'Terrain' };
// 低桥每组 9 个连号 overlay：前 4 个完好、中间 3 个受损、最后两个是断口端头（低位端 / 高位端）。
// 桥面固定 3 格宽，frame 0/1/2 是横向轨道序号；axis 指桥身延伸的坐标轴。
type BridgeGroup = { axis: 'x' | 'y'; deck: Set<number>; dead: number; capLow: number; capHigh: number };
const bridgeDeck = (start: number) => new Set(Array.from({ length: 9 }, (_, index) => start + index));
const BRIDGE_GROUPS: readonly BridgeGroup[] = [
  { axis: 'x', deck: bridgeDeck(74), dead: 100, capLow: 82, capHigh: 81 },
  { axis: 'y', deck: bridgeDeck(83), dead: 101, capLow: 90, capHigh: 91 },
  { axis: 'x', deck: bridgeDeck(205), dead: 231, capLow: 213, capHigh: 212 },
  { axis: 'y', deck: bridgeDeck(214), dead: 232, capLow: 221, capHigh: 222 },
];
const bridgeGroupOf = (overlay: number) => BRIDGE_GROUPS.find((group) => group.dead === overlay || group.deck.has(overlay));
export type MapCell = { x: number; y: number; tile: number; subTile: number; level: number; color: number; blocked: string; buildable: boolean; object?: 'building' | 'terrain' | 'unit' | 'start' };
type Section = { name: string; start: number; end: number; values: Map<string, string> };
type CellChange = { id: number; before: number; beforeFrame: number; after: number; afterFrame: number };
type ObjectChange = { section: ObjectSection; key: string; before?: string; after?: string };
type Change = CellChange | ObjectChange;
const isCellChange = (change: Change): change is CellChange => 'id' in change;
export const OVERLAY_LENGTH = 512 * 512;
const invalid = (section: string) => new Error(`${section} 数据损坏或格式不受支持。`);
const idOf = (x: number, y: number) => y * 512 + x;
const OUTSIDE = '可玩区域之外';
const asciiBytes = (value: string) => Uint8Array.from(value, (c) => c.charCodeAt(0));

function rawText(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return text;
}

function sectionsOf(text: string): Map<string, Section> {
  const matches = [...text.matchAll(/(?:^|[\r\n])(?:\xEF\xBB\xBF)?[ \t]*\[([^\]\r\n]+)\][ \t]*(?:;[^\r\n]*)?(?=\r|\n|$)/g)];
  const sections = new Map<string, Section>();
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    const prefix = /^[\r\n]/.test(m[0]) ? 1 : 0;
    const start = m.index! + prefix + (text.slice(m.index! + prefix).startsWith('\xEF\xBB\xBF') ? 3 : 0);
    const next = matches[i + 1];
    const end = next ? next.index! + (/^[\r\n]/.test(next[0]) ? 1 : 0) : text.length;
    const name = m[1].trim().toLowerCase();
    if (sections.has(name)) throw new Error(`地图包含重复的 [${m[1]}]，请先在地图编辑器中整理。`);
    const values = new Map<string, string>();
    for (const line of text.slice(m.index! + m[0].length, end).split(/\r\n|\n|\r/)) {
      const content = line.split(';', 1)[0].trim();
      const equals = content.indexOf('=');
      if (equals < 1) continue;
      const key = content.slice(0, equals).trim().toLowerCase();
      if (values.has(key) && ['isomappack5', 'overlaypack', 'overlaydatapack'].includes(name)) throw invalid(name);
      values.set(key, content.slice(equals + 1).trim());
    }
    sections.set(name, { name, start, end, values });
  }
  return sections;
}

function packedBytes(section: Section | undefined): Uint8Array {
  if (!section?.values.size) throw new Error('地图缺少完整的地形或资源数据。');
  const entries = [...section.values].sort((a, b) => Number(a[0]) - Number(b[0]));
  if (entries.some(([key], i) => key !== String(i + 1))) throw invalid(section.name);
  const base64 = entries.map((entry) => entry[1]).join('');
  if (base64.length % 4 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(base64)) throw invalid(section.name);
  try { return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)); }
  catch { throw invalid(section.name); }
}

export function decodeLcw(input: Uint8Array, output: Uint8Array): void {
  let read = 0; let written = 0;
  const byte = () => { if (read >= input.length) throw invalid('资源块'); return input[read++]; };
  const word = () => byte() | (byte() << 8);
  const room = (count: number) => { if (count < 1 || written + count > output.length) throw invalid('资源块'); };
  const copy = (from: number, count: number) => {
    room(count);
    if (from < 0 || from >= written) throw invalid('资源引用');
    for (let n = 0; n < count; n += 1) output[written++] = output[from++];
  };
  for (;;) {
    const opcode = byte();
    if (opcode === 128) {
      if (written !== output.length || read !== input.length) throw invalid('资源块长度');
      return;
    }
    if (opcode < 128) copy(written - (((opcode & 15) << 8) | byte()), (opcode >> 4) + 3);
    else if (opcode < 192) {
      const count = opcode & 63; room(count);
      if (read + count > input.length) throw invalid('资源块长度');
      output.set(input.subarray(read, read + count), written); written += count; read += count;
    } else if (opcode === 254) {
      const count = word(); const value = byte(); room(count);
      output.fill(value, written, written + count); written += count;
    } else {
      const count = opcode === 255 ? word() : (opcode & 63) + 3;
      copy(word(), count);
    }
  }
}

export function decodeMapPack(bytes: Uint8Array, format: 'lzo' | 'lcw', maximum: number, exact = false): Uint8Array {
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blocks: { offset: number; compressed: number; size: number }[] = [];
  let cursor = 0; let total = 0;
  while (cursor < bytes.length) {
    if (cursor + 4 > bytes.length) throw invalid('压缩块头');
    const compressed = header.getUint16(cursor, true); const size = header.getUint16(cursor + 2, true); cursor += 4;
    if (!compressed && !size && cursor === bytes.length) break;
    if (!compressed || !size || size > 8192 || cursor + compressed > bytes.length || total + size > maximum) throw invalid('压缩块长度');
    blocks.push({ offset: cursor, compressed, size }); total += size; cursor += compressed;
  }
  if (!total || (exact && total !== maximum)) throw invalid('解压数据长度');
  const output = new Uint8Array(total); let written = 0;
  for (const block of blocks) {
    const input = bytes.subarray(block.offset, block.offset + block.compressed);
    const target = output.subarray(written, written + block.size);
    if (format === 'lzo') decodeLzoBlock(input, target); else decodeLcw(input, target);
    written += block.size;
  }
  return output;
}

export function encodeOverlayPack(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== OVERLAY_LENGTH) throw invalid('资源数组长度');
  const packed: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    const data = bytes.subarray(offset, offset + 8192); const encoded: number[] = [];
    let position = 0;
    const run = (start: number) => { let end = start + 1; while (end < data.length && data[end] === data[start]) end += 1; return end - start; };
    while (position < data.length) {
      const count = run(position);
      if (count >= 4) { encoded.push(254, count & 255, count >> 8, data[position]); position += count; }
      else {
        const start = position; position += count;
        while (position < data.length && position - start < 63 && run(position) < 4) position += 1;
        const size = position - start; encoded.push(128 | size, ...data.subarray(start, position));
      }
    }
    encoded.push(128);
    packed.push(encoded.length & 255, encoded.length >> 8, data.length & 255, data.length >> 8, ...encoded);
  }
  return new Uint8Array(packed);
}

export class YrmEditSession {
  readonly game: MapGame;
  private readonly stock: StockRules;
  readonly source: Uint8Array;
  readonly info: YrmMap;
  readonly cells = new Map<number, MapCell>();
  readonly overlay: Uint8Array;
  readonly frames: Uint8Array;
  readonly readOnlyReasons: string[] = [];
  readonly starts: { id: string; x: number; y: number }[] = [];
  private readonly text: string;
  private readonly sections: Map<string, Section>;
  private readonly originalOverlay: Uint8Array;
  private readonly originalFrames: Uint8Array;
  private savedOverlay: Uint8Array;
  private savedFrames: Uint8Array;
  private changed = new Set<number>();
  private unsaved = new Set<number>();
  private history: Change[][] = [];
  private future: Change[][] = [];
  private stroke: { list: Change[]; cells: Map<number, CellChange> } | null = null;
  private readonly originalObjects = new Map<ObjectSection, Map<string, string>>();
  private savedObjects = new Map<ObjectSection, Map<string, string>>();
  private lastExportObjects: Map<ObjectSection, Map<string, string>> | null = null;
  private readonly baseBlocked = new Map<number, string>();
  private sealing = new Map<number, BridgeGroup>();

  constructor(bytes: Uint8Array, game: MapGame = 'yr') {
    if (game !== 'yr' && game !== 'ra2') throw new Error('请选择红警 2 或尤里的复仇规则。');
    this.game = game; this.stock = stockProfiles[game];
    this.info = readYrmPreview(bytes);
    this.source = bytes.slice(); this.text = rawText(bytes); this.sections = sectionsOf(this.text);
    const { width, height, theater } = this.info;
    if (width + height > 512 || width < 2 || height < 2) throw new Error('编辑支持宽高之和不超过 512 的原版地图。');
    const profile = this.stock.theaters[theater];
    if (!profile) throw new Error(`该地形不在${MAP_GAME_NAMES[game]}规则中，请检查游戏版本；预览仍可使用。`);
    if (this.sections.get('basic')?.values.get('newiniformat') !== '4') this.readOnlyReasons.push('仅支持 NewINIFormat=4 的原版地图');
    for (const [name, section] of this.sections) {
      if (['overlaytypes', 'tiberiums', 'buildingtypes', 'terraintypes'].includes(name) || /^tileset\d+$/.test(name)
        || this.stock.resourceRuleNames.some((rule) => rule.toLowerCase() === name)) this.readOnlyReasons.push(`地图含自定义规则 [${name}]`);
      if ([...section.values.keys()].some((key) => key === 'foundation' || key.startsWith('foundation.'))) this.readOnlyReasons.push(`地图含自定义占地 [${name}]`);
    }
    this.overlay = decodeMapPack(packedBytes(this.sections.get('overlaypack')), 'lcw', OVERLAY_LENGTH, true);
    this.frames = decodeMapPack(packedBytes(this.sections.get('overlaydatapack')), 'lcw', OVERLAY_LENGTH, true);
    this.originalOverlay = this.overlay.slice(); this.originalFrames = this.frames.slice();
    this.savedOverlay = this.overlay.slice(); this.savedFrames = this.frames.slice();
    for (let y = 1; y < width + height; y += 1) {
      for (let x = 1; x < width + height; x += 1) {
        if (x + y < width + 1 || Math.abs(x - y) > width - 1 || x + y > height * 2 + width) continue;
        this.cells.set(idOf(x, y), { x, y, tile: 0, subTile: 0, level: 0, color: 0x727981, blocked: '', buildable: false });
      }
    }
    const iso = decodeMapPack(packedBytes(this.sections.get('isomappack5')), 'lzo', this.cells.size * 11 + 4);
    if (iso.length % 11 !== 0 && iso.length % 11 !== 4) throw invalid('地形格子长度');
    if (iso.length % 11 === 4 && iso.slice(-4).some((byte) => byte !== 0)) throw invalid('地形结束标记');
    const view = new DataView(iso.buffer); const seen = new Set<number>();
    for (let p = 0; p + 11 <= iso.length; p += 11) {
      const x = view.getInt16(p, true); const y = view.getInt16(p + 2, true); const id = idOf(x, y);
      const cell = this.cells.get(id);
      if (!cell || cell.x !== x || cell.y !== y || seen.has(id)) throw invalid('地形坐标');
      seen.add(id);
      const tile = view.getInt32(p + 4, true);
      cell.tile = tile === 65535 || tile === -1 ? 0 : tile;
      cell.subTile = iso[p + 8]; cell.level = iso[p + 9];
    }
    const local = this.sections.get('map')?.values.get('localsize')?.split(',').map(Number);
    if (!local || local.length !== 4 || local.some((n) => !Number.isInteger(n) || n < 0)
      || !local[2] || !local[3] || local[0] + local[2] > width || local[1] + local[3] > height) this.readOnlyReasons.push('地图可玩区域无效');
    for (const cell of this.cells.values()) {
      const rule = profile.tiles[cell.tile]?.[cell.subTile];
      if (!rule) cell.blocked = '未知地形';
      else {
        cell.color = rule[3];
        if (rule[2]) cell.blocked = '坡面';
        else if (rule[1] === 9) cell.blocked = '水面';
        else if (!rule[0]) cell.blocked = '该地形不支持矿石';
      }
      if (cell.level > 14) cell.blocked = '未知地形高度';
      if (local?.length === 4) {
        const sx = (cell.x - cell.y + width - 1) / 2; const sy = (cell.x + cell.y - width - 1) / 2;
        if (sx < local[0] || sy < local[1] || sx >= local[0] + local[2] || sy >= local[1] + local[3]) cell.blocked = OUTSIDE;
      }
      cell.buildable = Boolean(rule) && !rule![2] && rule![1] !== 9 && cell.level <= 14 && cell.blocked !== OUTSIDE;
      this.baseBlocked.set(idOf(cell.x, cell.y), cell.blocked);
    }
    for (const section of ['structures', 'terrain'] as const)
      this.originalObjects.set(section, new Map(this.sections.get(section)?.values ?? []));
    this.savedObjects = new Map([...this.originalObjects].map(([key, values]) => [key, new Map(values)]));
    this.blockObjects(true);
  }

  private blockObjects(initial = false): void {
    this.starts.length = 0;
    const reject = (reason: string) => { if (initial) this.readOnlyReasons.push(reason); };
    const block = (x: number, y: number, object: MapCell['object'], reason: string) => {
      const cell = this.cells.get(idOf(x, y)); if (cell?.x === x && cell.y === y) { cell.object = object; cell.blocked = reason; }
    };
    for (const group of ['structures', 'units', 'infantry', 'aircraft']) {
      for (const value of this.sections.get(group)?.values.values() ?? []) {
        const parts = value.split(','); const x = Number(parts[3]); const y = Number(parts[4]); const name = parts[1]?.toUpperCase();
        if (!name || !Number.isInteger(x) || !Number.isInteger(y)) { reject(`${group} 包含无效坐标`); continue; }
        if (group !== 'structures') { block(x, y, 'unit', '单位占地'); continue; }
        const rule = this.stock.buildings[name]; const override = this.sections.get(name.toLowerCase())?.values.get('image')?.toUpperCase();
        if (!rule?.foundation || (override && override !== rule.image)) { reject(`无法识别建筑占地：${name}`); continue; }
        for (let dy = 0; dy < Math.max(1, rule.foundation[1]); dy += 1) for (let dx = 0; dx < Math.max(1, rule.foundation[0]); dx += 1) block(x + dx, y + dy, 'building', '建筑占地');
      }
    }
    for (const [location, type] of this.sections.get('terrain')?.values ?? []) {
      const coordinate = Number(location); const x = coordinate % 1000; const y = Math.floor(coordinate / 1000);
      const name = type.toUpperCase(); const rule = this.stock.terrain[name]; const override = this.sections.get(name.toLowerCase())?.values.get('image')?.toUpperCase();
      if (!Number.isInteger(coordinate) || !rule?.foundation || (override && override !== rule.image)) { reject(`无法识别地形对象：${name}`); continue; }
      // 树木的遮挡范围覆盖其占地和相邻格，画笔保留这片区域。
      for (let dy = -1; dy <= rule.foundation[1]; dy += 1) for (let dx = -1; dx <= rule.foundation[0]; dx += 1) block(x + dx, y + dy, 'terrain', '树木或地形对象附近');
    }
    for (const [name, value] of this.sections.get('waypoints')?.values ?? []) {
      if (!/^[0-7]$/.test(name) || !/^\d+$/.test(value)) continue;
      const coordinate = Number(value); const x = coordinate % 1000; const y = Math.floor(coordinate / 1000);
      this.starts.push({ id: String(Number(name) + 1), x, y });
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) block(x + dx, y + dy, 'start', '出生点预留区域');
    }
  }

  get readOnly() { return this.readOnlyReasons.length > 0; }
  get dirty() { return this.unsaved.size > 0 || this.objectDiff(this.savedObjects) > 0; }
  get changedCount() { return this.changed.size; }
  get canUndo() { return this.history.length > 0 && !this.stroke; }
  get canRedo() { return this.future.length > 0 && !this.stroke; }
  get activeStroke() { return this.stroke !== null; }
  resourceAt(id: number): 'ore' | 'gems' | undefined {
    if (this.stock.resources.ore.includes(this.overlay[id])) return 'ore';
    if (this.stock.resources.gems.includes(this.overlay[id])) return 'gems';
  }
  reasonAt(cell: MapCell, brush: EditBrush): string {
    if (this.readOnly) return '当前地图为只读';
    if (brush === 'remove') return this.removeReason(cell.x, cell.y);
    if (brush in PLACEABLE) return this.placeReason(cell.x, cell.y, brush as PlaceKind);
    const id = idOf(cell.x, cell.y); const resource = this.resourceAt(id);
    if (brush === 'erase') return resource ? '' : '此处没有可擦除的矿石或宝石';
    if (brush === 'bridge') {
      if (cell.blocked === OUTSIDE) return cell.blocked;
      const group = bridgeGroupOf(this.overlay[id]);
      if (!group) return '此处不是低桥桥面';
      if (this.frames[id] > 2) return '桥面轨道编号不是原版格式';
      if (!this.bridgeSection(cell.x, cell.y, group).length) return '这里不是完整的 3 格宽桥面';
      if (this.overlay[id] === group.dead) return '此处的桥面已经断开';
      return this.isBridgeEnd(cell.x, cell.y, group) ? '桥头这一格要留作断口' : '';
    }
    if (cell.blocked) return cell.blocked;
    if (this.overlay[id] !== 255 && !resource) return '已有其他覆盖物';
    return '';
  }
  footprint(kind: PlaceKind): [number, number] {
    const spec = PLACEABLE[kind];
    const rule = spec.section === 'structures' ? this.stock.buildings[spec.name] : this.stock.terrain[spec.name];
    return [Math.max(1, rule?.foundation?.[0] ?? 1), Math.max(1, rule?.foundation?.[1] ?? 1)];
  }
  placeReason(x: number, y: number, kind: PlaceKind): string {
    if (this.readOnly) return '当前地图为只读';
    const spec = PLACEABLE[kind];
    const rule = spec.section === 'structures' ? this.stock.buildings[spec.name] : this.stock.terrain[spec.name];
    if (!rule?.foundation) return `${MAP_GAME_NAMES[this.game]}规则中没有 ${spec.name}`;
    const [width, height] = this.footprint(kind);
    for (let dy = 0; dy < height; dy += 1) for (let dx = 0; dx < width; dx += 1) {
      const cell = this.cells.get(idOf(x + dx, y + dy));
      if (!cell || cell.x !== x + dx || cell.y !== y + dy) return '超出地图范围';
      if (cell.object) return cell.blocked;
      if (!cell.buildable) return cell.blocked || '此处地形不能放置';
    }
    return '';
  }
  // 建筑按左上角格记录坐标，地形对象的键就是坐标本身。
  place(x: number, y: number, kind: PlaceKind): boolean {
    if (!this.stroke) throw new Error('请先开始笔画。');
    if (!Number.isInteger(x) || !Number.isInteger(y) || !PLACEABLE[kind]) throw new Error('放置参数无效。');
    if (this.placeReason(x, y, kind)) return false;
    const spec = PLACEABLE[kind];
    const key = spec.section === 'terrain' ? String(y * 1000 + x) : this.nextStructureKey();
    this.recordObject(spec.section, key, spec.section === 'terrain' ? spec.name : structureLine(spec.name, x, y));
    this.markFootprint(x, y, kind);
    return true;
  }
  // 放置时只标记新对象占地，整体重算留到笔画收尾，拖动连放才不会逐格重扫全图。
  private markFootprint(x: number, y: number, kind: PlaceKind): void {
    const spec = PLACEABLE[kind]; const [width, height] = this.footprint(kind);
    const pad = spec.section === 'terrain' ? 1 : 0;
    for (let dy = -pad; dy < height + pad; dy += 1) for (let dx = -pad; dx < width + pad; dx += 1) {
      const cell = this.cells.get(idOf(x + dx, y + dy));
      if (cell?.x !== x + dx || cell.y !== y + dy) continue;
      cell.object = spec.section === 'terrain' ? 'terrain' : 'building';
      cell.blocked = spec.section === 'terrain' ? '树木或地形对象附近' : '建筑占地';
    }
  }
  objectAt(x: number, y: number): { section: ObjectSection; key: string; name: string } | undefined {
    for (const [key, value] of this.sections.get('structures')?.values ?? []) {
      const parts = value.split(','); const name = parts[1]?.toUpperCase();
      const left = Number(parts[3]); const top = Number(parts[4]); const rule = this.stock.buildings[name];
      if (!rule?.foundation || !Number.isInteger(left) || !Number.isInteger(top)) continue;
      if (x >= left && y >= top && x < left + Math.max(1, rule.foundation[0]) && y < top + Math.max(1, rule.foundation[1])) return { section: 'structures', key, name };
    }
    for (const [key, value] of this.sections.get('terrain')?.values ?? []) {
      const coordinate = Number(key);
      if (Number.isInteger(coordinate) && coordinate % 1000 === x && Math.floor(coordinate / 1000) === y) return { section: 'terrain', key, name: value.toUpperCase() };
    }
    return undefined;
  }
  removeReason(x: number, y: number): string {
    if (this.readOnly) return '当前地图为只读';
    return this.objectAt(x, y) ? '' : '此处没有可删除的建筑或地形对象';
  }
  removeAt(x: number, y: number): boolean {
    if (!this.stroke) throw new Error('请先开始笔画。');
    const target = this.objectAt(x, y);
    if (!target || this.readOnly) return false;
    this.recordObject(target.section, target.key, undefined);
    this.refreshObjects();
    return true;
  }
  get objectCount(): number { return this.objectDiff(this.originalObjects); }
  private snapshotObjects(): Map<ObjectSection, Map<string, string>> {
    return new Map((['structures', 'terrain'] as const).map((section) => [section, new Map(this.sections.get(section)?.values ?? [])]));
  }
  private sectionDiffers(section: ObjectSection): boolean {
    const now = this.sections.get(section)?.values ?? new Map<string, string>();
    const was = this.originalObjects.get(section) ?? new Map<string, string>();
    if (now.size !== was.size) return true;
    for (const [key, value] of now) if (was.get(key) !== value) return true;
    return false;
  }
  private objectDiff(against: Map<ObjectSection, Map<string, string>>): number {
    let total = 0;
    for (const section of ['structures', 'terrain'] as const) {
      const now = this.sections.get(section)?.values ?? new Map<string, string>();
      const was = against.get(section) ?? new Map<string, string>();
      for (const [key, value] of now) if (was.get(key) !== value) total += 1;
      for (const key of was.keys()) if (!now.has(key)) total += 1;
    }
    return total;
  }
  private nextStructureKey(): string {
    let highest = -1;
    for (const key of this.sectionValues('structures').keys()) { const index = Number(key); if (Number.isInteger(index) && index > highest) highest = index; }
    return String(highest + 1);
  }
  private sectionValues(name: ObjectSection): Map<string, string> {
    const existing = this.sections.get(name);
    if (existing) return existing.values;
    const created: Section = { name, start: -1, end: -1, values: new Map() };
    this.sections.set(name, created);
    return created.values;
  }
  private writeObject(section: ObjectSection, key: string, value?: string): void {
    const values = this.sectionValues(section);
    if (value === undefined) values.delete(key); else values.set(key, value);
  }
  private recordObject(section: ObjectSection, key: string, after?: string): void {
    if (!this.stroke) return;
    const before = this.sections.get(section)?.values.get(key);
    if (before === after) return;
    this.stroke.list.push({ section, key, before, after });
    this.writeObject(section, key, after);
  }
  private refreshObjects(): void {
    for (const cell of this.cells.values()) { cell.object = undefined; cell.blocked = this.baseBlocked.get(idOf(cell.x, cell.y)) ?? ''; }
    this.blockObjects();
  }
  beginStroke() { if (this.stroke) throw new Error('请先结束当前笔画。'); this.stroke = { list: [], cells: new Map() }; }
  paint(x: number, y: number, brush: EditBrush, radius: number): number {
    if (!this.stroke) throw new Error('请先开始笔画。');
    if (!Number.isInteger(x) || !Number.isInteger(y) || ![0, 1, 2].includes(radius)) throw new Error('画笔参数无效。');
    if (brush === 'bridge') return this.breakBridge(x, y);
    if (brush !== 'ore' && brush !== 'gems' && brush !== 'erase') throw new Error('画笔参数无效。');
    let count = 0;
    for (let dy = -radius; dy <= radius; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) {
      const id = idOf(x + dx, y + dy); const cell = this.cells.get(id);
      if (!cell || cell.x !== x + dx || cell.y !== y + dy || this.reasonAt(cell, brush)) continue;
      const after = brush === 'erase' ? 255 : this.stock.resources[brush][(cell.x * 7 + cell.y * 11) % (brush === 'ore' ? 12 : this.stock.resources.gems.length)];
      const afterFrame = brush === 'erase' ? 0 : 11;
      if (this.overlay[id] === after && this.frames[id] === afterFrame) continue;
      this.record(id, after, afterFrame); count += 1;
    }
    return count;
  }
  endStroke(): void {
    if (!this.stroke) return;
    for (const [id, group] of this.sealing) this.sealBridge(id % 512, Math.floor(id / 512), group);
    this.sealing.clear();
    const changes = this.stroke.list.filter((c) => isCellChange(c) ? c.before !== c.after || c.beforeFrame !== c.afterFrame : c.before !== c.after);
    this.stroke = null;
    if (changes.some((change) => !isCellChange(change))) this.refreshObjects();
    if (!changes.length) return;
    this.future = []; this.history.push(changes);
    while (this.history.length > 100 || (this.history.length > 1 && this.history.reduce((n, changes) => n + changes.length, 0) > 200000)) this.history.shift();
  }
  cancelStroke() {
    if (!this.stroke) return;
    this.sealing.clear();
    this.revert([...this.stroke.list].reverse(), 'before'); this.stroke = null;
  }
  undo() { if (this.stroke) return; const changes = this.history.pop(); if (!changes) return; this.revert([...changes].reverse(), 'before'); this.future.push(changes); }
  redo() { if (this.stroke) return; const changes = this.future.pop(); if (!changes) return; this.revert(changes, 'after'); this.history.push(changes); }
  private revert(changes: readonly Change[], side: 'before' | 'after'): void {
    let objects = false;
    for (const change of changes) {
      if (isCellChange(change)) this.assign(change.id, side === 'before' ? change.before : change.after, side === 'before' ? change.beforeFrame : change.afterFrame);
      else { this.writeObject(change.section, change.key, change[side]); objects = true; }
    }
    if (objects) this.refreshObjects();
  }
  markSaved(overlay = this.overlay, frames = this.frames) {
    if (overlay.length !== OVERLAY_LENGTH || frames.length !== OVERLAY_LENGTH) throw invalid('保存快照');
    this.savedObjects = this.lastExportObjects ?? this.snapshotObjects(); this.lastExportObjects = null;
    this.savedOverlay = overlay.slice(); this.savedFrames = frames.slice(); this.unsaved.clear();
    for (const id of this.cells.keys()) if (this.overlay[id] !== this.savedOverlay[id] || this.frames[id] !== this.savedFrames[id]) this.unsaved.add(id);
  }
  private record(id: number, after: number, afterFrame: number) {
    if (!this.stroke || (this.overlay[id] === after && this.frames[id] === afterFrame)) return;
    const existing = this.stroke.cells.get(id);
    if (existing) { existing.after = after; existing.afterFrame = afterFrame; }
    else {
      const change: CellChange = { id, before: this.overlay[id], beforeFrame: this.frames[id], after, afterFrame };
      this.stroke.cells.set(id, change); this.stroke.list.push(change);
    }
    this.assign(id, after, afterFrame);
  }
  private bridgeCellAt(x: number, y: number, group: BridgeGroup): number | undefined {
    if (x < 1 || y < 1 || x > 511 || y > 511) return undefined;
    const id = idOf(x, y); const cell = this.cells.get(id);
    if (!cell || cell.x !== x || cell.y !== y || bridgeGroupOf(this.overlay[id]) !== group) return undefined;
    return id;
  }
  private isBridgeEnd(x: number, y: number, group: BridgeGroup): boolean {
    const along = group.axis === 'x';
    const at = (step: number) => this.bridgeCellAt(along ? step : x, along ? y : step, group);
    const step = along ? x : y;
    return at(step - 1) === undefined || at(step + 1) === undefined;
  }
  // 桥面固定 3 格宽，frame 0/1/2 各占一条轨道；缺任意一条都不是完整桥面。
  private bridgeSection(x: number, y: number, group: BridgeGroup): number[] {
    const track = this.frames[idOf(x, y)];
    const section: number[] = [];
    for (let lane = 0; lane < 3; lane += 1) {
      const offset = lane - track;
      const id = this.bridgeCellAt(group.axis === 'x' ? x : x + offset, group.axis === 'x' ? y + offset : y, group);
      if (id === undefined || this.frames[id] !== lane) return [];
      section.push(id);
    }
    return section;
  }
  private breakBridge(x: number, y: number): number {
    const cell = this.cells.get(idOf(x, y));
    if (!cell || cell.x !== x || cell.y !== y || this.reasonAt(cell, 'bridge')) return 0;
    const group = bridgeGroupOf(this.overlay[idOf(x, y)])!;
    let count = 0;
    for (const id of this.bridgeSection(x, y, group)) {
      if (this.overlay[id] === group.dead) continue;
      this.record(id, group.dead, this.frames[id]); count += 1;
    }
    this.sealing.set(idOf(x, y), group);
    return count;
  }
  // 沿桥身扫描整条轨道：补上断裂段两端的断口，并填掉断裂段之间只剩一格的桥面。
  private sealBridge(x: number, y: number, group: BridgeGroup): void {
    const along = group.axis === 'x';
    const at = (step: number) => this.bridgeCellAt(along ? step : x, along ? y : step, group);
    const start = along ? x : y;
    let low = start; let high = start;
    while (at(low - 1) !== undefined) low -= 1;
    while (at(high + 1) !== undefined) high += 1;
    const dead = (step: number) => { const id = at(step); return id !== undefined && this.overlay[id] === group.dead; };
    for (let step = low + 1; step < high; step += 1) {
      const id = at(step)!;
      if (this.overlay[id] !== group.dead && dead(step - 1) && dead(step + 1)) this.record(id, group.dead, this.frames[id]);
    }
    for (let step = low; step <= high; step += 1) {
      const id = at(step)!;
      const behind = dead(step - 1); const ahead = dead(step + 1);
      if (this.overlay[id] === group.dead) {
        if (step === low && ahead) this.record(id, group.capLow, this.frames[id]);
        else if (step === high && behind) this.record(id, group.capHigh, this.frames[id]);
        continue;
      }
      if (ahead && !behind) this.record(id, group.capLow, this.frames[id]);
      else if (behind && !ahead) this.record(id, group.capHigh, this.frames[id]);
    }
  }
  private assign(id: number, overlay: number, frame: number) {
    this.overlay[id] = overlay; this.frames[id] = frame;
    if (overlay === this.originalOverlay[id] && frame === this.originalFrames[id]) this.changed.delete(id); else this.changed.add(id);
    if (overlay === this.savedOverlay[id] && frame === this.savedFrames[id]) this.unsaved.delete(id); else this.unsaved.add(id);
  }
  cellColor(cell: MapCell): number {
    const resource = this.resourceAt(idOf(cell.x, cell.y));
    if (resource) return resource === 'ore' ? 0xe8cb27 : 0xb650d7;
    const bridge = bridgeGroupOf(this.overlay[idOf(cell.x, cell.y)]);
    if (bridge) return this.overlay[idOf(cell.x, cell.y)] === bridge.dead ? 0x6b4130 : 0xb2854e;
    if (cell.object === 'building') return 0x747c89;
    if (cell.object === 'terrain') return 0x396840;
    if (cell.object === 'unit') return 0xb28667;
    if (cell.object === 'start') return 0x5294d9;
    if (this.overlay[idOf(cell.x, cell.y)] !== 255) return 0x565965;
    return cell.color;
  }
  overview(): YrmPreview {
    const width = this.info.width * 4; const height = this.info.height * 2 + 1;
    const rgb = new Uint8Array(width * height * 3);
    for (let py = 0; py < height; py += 1) for (let px = 0; px < width; px += 1) {
      const u = (px + 0.5) / 2; const v = py + 0.5;
      const x = Math.round((u + v) / 2); const y = Math.round((v - u) / 2 + this.info.width);
      const cell = this.cells.get(idOf(x, y)); const color = cell?.x === x && cell.y === y ? this.cellColor(cell) : 0x252d35;
      const p = (py * width + px) * 3; rgb[p] = color >> 16; rgb[p + 1] = (color >> 8) & 255; rgb[p + 2] = color & 255;
    }
    return { width, height, rgb };
  }
  exportMap(): Uint8Array {
    if (this.activeStroke) throw new Error('请先结束当前笔画。');
    if (this.readOnly) throw new Error('当前地图为只读，请使用对应 MOD 的地图编辑器。');
    if (!this.changed.size && !this.objectCount) return this.source.slice();
    const preview = encodeYrmPreview(this.overview());
    const replacements = new Map([
      ['overlaypack', `[OverlayPack]\n${packYrmLines(encodeOverlayPack(this.overlay))}\n\n`],
      ['overlaydatapack', `[OverlayDataPack]\n${packYrmLines(encodeOverlayPack(this.frames))}\n\n`],
      ['preview', `[Preview]\nSize=${preview.size}\n\n`], ['previewpack', `[PreviewPack]\n${preview.pack}\n\n`],
    ]);
    for (const section of ['structures', 'terrain'] as const) {
      if (!this.sectionDiffers(section)) continue;
      const lines = [...this.sectionValues(section)].map(([key, value]) => `${key}=${value}`).join('\n');
      replacements.set(section, `[${SECTION_TITLE[section]}]\n${lines}${lines ? '\n' : ''}\n`);
    }
    const newline = this.text.includes('\r\n') ? '\r\n' : '\n';
    const changes = [...this.sections.values()].filter((s) => replacements.has(s.name) && s.start >= 0).sort((a, b) => a.start - b.start);
    let text = ''; let position = 0;
    for (const section of changes) {
      text += this.text.slice(position, section.start) + replacements.get(section.name)!.replaceAll('\n', newline);
      position = section.end; replacements.delete(section.name);
    }
    text += this.text.slice(position);
    const added = [...replacements.values()].map((content) => content.replaceAll('\n', newline)).join('');
    const bom = text.startsWith('\xEF\xBB\xBF') ? 3 : 0;
    text = text.slice(0, bom) + added + text.slice(bom);
    const bytes = asciiBytes(text);
    if (bytes.length > MAX_YRM_BYTES) throw new Error('导出地图超过 8 MB，请减少地图数据后重试。');
    this.lastExportObjects = this.snapshotObjects();
    return bytes;
  }
}
