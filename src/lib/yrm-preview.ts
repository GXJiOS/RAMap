export const MAX_YRM_BYTES = 8 * 1024 * 1024;
export const MAX_YRM_PREVIEW_PIXELS = 1024 * 1024;
export const MAP_EXTENSIONS = ['.yrm', '.mpr', '.map', '.yro'] as const;
export type MapExtension = typeof MAP_EXTENSIONS[number];
export type MapGame = 'ra2' | 'yr';
export const MAP_GAME_NAMES: Record<MapGame, string> = { ra2: '红警 2', yr: '尤里的复仇' };

export function mapExtension(filename: string): MapExtension | undefined {
  return MAP_EXTENSIONS.find((extension) => filename.toLowerCase().endsWith(extension));
}

export function mapOutputName(filename: string, kind: 'edited' | 'png'): string {
  const extension = mapExtension(filename);
  if (!extension) throw new Error('请选择 YRM、MPR、MAP 或 YRO 地图文件。');
  const stem = filename.slice(0, -extension.length).replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').replace(/^\.+|\.+$/g, '').trim() || 'map';
  return kind === 'png' ? `${stem}.png` : `${stem}-edited${filename.slice(-extension.length)}`;
}

export function suggestedMapGame(filename: string, map: Pick<YrmMap, 'theater'>): MapGame | undefined {
  const extension = mapExtension(filename);
  if (!extension) return;
  if (extension === '.mpr') return 'ra2';
  if (extension === '.yrm' || ['NEWURBAN', 'DESERT', 'LUNAR'].includes(map.theater.toUpperCase())) return 'yr';
  return undefined;
}

export type YrmPreview = { width: number; height: number; rgb: Uint8Array };
export type YrmMap = {
  name: string;
  theater: string;
  width: number;
  height: number;
  minPlayers?: number;
  maxPlayers?: number;
  multiplayer?: boolean;
  preview?: YrmPreview;
  previewError?: string;
  encoding: 'UTF-8' | 'GB18030' | 'Windows-1252';
};

const corrupt = () => new Error('内嵌预览数据损坏或格式不受支持，请在地图编辑器中重新生成预览。');

// LZO1X 指令格式：https://docs.kernel.org/staging/lzo.html
// 每个引用都在当前块内校验，输出缓冲区由已校验的块头限定。
export function decodeLzoBlock(input: Uint8Array, output: Uint8Array): void {
  let read = 0;
  let written = 0;
  let literalState = 0;
  const byte = () => {
    if (read >= input.length) throw corrupt();
    return input[read++];
  };
  const word = () => byte() | (byte() << 8);
  const length = (bits: number, value: number) => {
    const mask = (1 << bits) - 1;
    if (value & mask) return value & mask;
    let size = mask;
    for (;;) {
      const next = byte();
      size += next || 255;
      if (size > output.length) throw corrupt();
      if (next) return size;
    }
  };
  const literals = (count: number) => {
    if (read + count > input.length || written + count > output.length) throw corrupt();
    output.set(input.subarray(read, read + count), written);
    read += count;
    written += count;
  };
  const copy = (distance: number, count: number) => {
    if (distance < 1 || distance > written || written + count > output.length) throw corrupt();
    for (let n = 0; n < count; n += 1) {
      output[written] = output[written - distance];
      written += 1;
    }
  };

  if (input[0] > 17) {
    const count = byte() - 17;
    literals(count);
    literalState = Math.min(4, count);
  }
  for (;;) {
    const opcode = byte();
    let distance: number;
    let count: number;
    let trailing: number;
    if (opcode < 16) {
      if (literalState === 0) {
        literals(length(4, opcode) + 3);
        literalState = 4;
        continue;
      }
      distance = (byte() << 2) + (opcode >> 2) + (literalState === 4 ? 2049 : 1);
      count = literalState === 4 ? 3 : 2;
      trailing = opcode & 3;
    } else if (opcode < 32) {
      count = length(3, opcode) + 2;
      const operand = word();
      distance = ((opcode & 8) << 11) + (operand >> 2);
      if (distance === 0) {
        if (count !== 3 || operand !== 0 || read !== input.length || written !== output.length) throw corrupt();
        return;
      }
      distance += 16384;
      trailing = operand & 3;
    } else if (opcode < 64) {
      count = length(5, opcode) + 2;
      const operand = word();
      distance = (operand >> 2) + 1;
      trailing = operand & 3;
    } else {
      count = (opcode >> 5) + 1;
      distance = (byte() << 3) + ((opcode >> 2) & 7) + 1;
      trailing = opcode & 3;
    }
    copy(distance, count);
    literals(trailing);
    literalState = trailing;
  }
}

export function encodeYrmPreview(preview: YrmPreview): { size: string; pack: string } {
  const { width, height, rgb } = preview;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > 4096 || height > 4096 || width * height > MAX_YRM_PREVIEW_PIXELS || rgb.length !== width * height * 3) throw corrupt();
  const packed: number[] = [];
  for (let start = 0; start < rgb.length; start += 8192) {
    const chunk = rgb.subarray(start, start + 8192);
    const literal: number[] = [];
    if (chunk.length <= 238) literal.push(17 + chunk.length);
    else {
      literal.push(0);
      let length = chunk.length - 18;
      while (length > 255) { literal.push(0); length -= 255; }
      literal.push(length);
    }
    literal.push(...chunk, 17, 0, 0);
    packed.push(literal.length & 255, literal.length >> 8, chunk.length & 255, chunk.length >> 8, ...literal);
  }
  return { size: `0,0,${width},${height}`, pack: packYrmLines(new Uint8Array(packed)) };
}

export function packYrmLines(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return (btoa(binary).match(/.{1,70}/g) ?? []).map((value, i) => `${i + 1}=${value}`).join('\n');
}

type Section = Map<string, string>;

function readSections(bytes: Uint8Array): { sections: Map<string, Section>; encoding: YrmMap['encoding'] } {
  if (bytes.length > MAX_YRM_BYTES) throw new Error('单张地图大小上限为 8 MB。');
  if (!bytes.length) throw new Error('文件为空，请选择红警地图文件。');
  if (bytes[0] === 98 && bytes[1] === 111 && bytes[2] === 111 && bytes[3] === 107
    && bytes[8] === 109 && bytes[9] === 97 && bytes[10] === 114 && bytes[11] === 107) {
    throw new Error('这是 macOS 替身，请选择它指向的原始地图文件。');
  }
  let text: string;
  let encoding: YrmMap['encoding'] = 'UTF-8';
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch {
    try { text = new TextDecoder('gb18030', { fatal: true }).decode(bytes); encoding = 'GB18030'; }
    catch { text = new TextDecoder('windows-1252', { fatal: true }).decode(bytes); encoding = 'Windows-1252'; }
  }
  if (text.includes('\0')) throw new Error('文件包含二进制数据，请选择原始红警地图文件。');
  const sections = new Map<string, Section>();
  let current: Section | undefined;
  let currentName = '';
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const heading = /^\[([^\]]+)\]\s*(?:;.*)?$/.exec(line);
    if (heading) {
      currentName = heading[1].trim().toLowerCase();
      if (!['basic', 'map', 'preview', 'previewpack'].includes(currentName)) { current = undefined; continue; }
      current = sections.get(currentName) ?? new Map<string, string>();
      sections.set(currentName, current);
      continue;
    }
    if (!current) continue;
    const equals = line.indexOf('=');
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim().toLowerCase();
    if (currentName === 'previewpack' && current.has(key)) throw corrupt();
    current.set(key, line.slice(equals + 1).split(';', 1)[0].trim());
  }
  return { sections, encoding };
}

function rectangle(value: string | undefined): number[] | undefined {
  const parts = value?.split(',').map((part) => part.trim());
  if (parts?.length !== 4 || parts.some((part) => !/^\d{1,6}$/.test(part))) return;
  const numbers = parts.map(Number);
  if (numbers[2] < 1 || numbers[3] < 1) return;
  return numbers;
}

function extractPreview(sections: Map<string, Section>): YrmPreview {
  const pack = sections.get('previewpack');
  if (!pack?.size) throw new Error('地图未内嵌预览图，可在地图编辑器中生成预览后载入。');
  const size = rectangle(sections.get('preview')?.get('size'));
  if (!size) throw new Error('地图的预览尺寸缺失或无效。');
  const [, , width, height] = size;
  if (width > 4096 || height > 4096 || width * height > MAX_YRM_PREVIEW_PIXELS) {
    throw new Error('预览图超过 100 万像素或单边 4096 像素的上限。');
  }
  const keys = [...pack.keys()];
  if (keys.some((key) => !/^[1-9]\d{0,6}$/.test(key))) throw corrupt();
  keys.sort((a, b) => Number(a) - Number(b));
  if (keys.some((key, index) => Number(key) !== index + 1)) throw corrupt();
  const encoded = keys.map((key) => pack.get(key)!).join('');
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw corrupt();
  let packed: Uint8Array;
  try { packed = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)); }
  catch { throw corrupt(); }
  const rgb = new Uint8Array(width * height * 3);
  const header = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  let read = 0;
  let written = 0;
  while (read < packed.length) {
    if (read + 4 > packed.length) throw corrupt();
    const compressed = header.getUint16(read, true);
    const expanded = header.getUint16(read + 2, true);
    read += 4;
    if (!compressed && !expanded) {
      if (read !== packed.length) throw corrupt();
      break;
    }
    if (!compressed || !expanded || read + compressed > packed.length || written + expanded > rgb.length) throw corrupt();
    decodeLzoBlock(packed.subarray(read, read + compressed), rgb.subarray(written, written + expanded));
    read += compressed;
    written += expanded;
  }
  if (written !== rgb.length) throw corrupt();
  return { width, height, rgb };
}

export function readYrmPreview(bytes: Uint8Array): YrmMap {
  const { sections, encoding } = readSections(bytes);
  const map = sections.get('map');
  const size = rectangle(map?.get('size'));
  if (!size) throw new Error('文件缺少有效的地图尺寸，请选择红警 2 或尤里的复仇地图。');
  const basic = sections.get('basic');
  const playerCount = (key: string) => {
    const value = basic?.get(key);
    return value && /^[1-8]$/.test(value) ? Number(value) : undefined;
  };
  const multiplayer = basic?.get('multiplayeronly');
  const result: YrmMap = {
    encoding,
    name: basic?.get('name') ?? '', theater: map?.get('theater')?.toUpperCase() ?? '',
    width: size[2], height: size[3], minPlayers: playerCount('minplayer'), maxPlayers: playerCount('maxplayer'),
    multiplayer: multiplayer === '1' || multiplayer?.toLowerCase() === 'yes' ? true
      : multiplayer === '0' || multiplayer?.toLowerCase() === 'no' ? false : undefined,
  };
  try { result.preview = extractPreview(sections); }
  catch (cause) { result.previewError = cause instanceof Error ? cause.message : '预览读取失败'; }
  return result;
}
