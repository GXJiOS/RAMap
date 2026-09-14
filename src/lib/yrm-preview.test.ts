import { describe, expect, it } from 'vitest';
import { MAP_EXTENSIONS, mapExtension, mapOutputName, MAX_YRM_BYTES, readYrmPreview, suggestedMapGame } from './yrm-preview';

const encode = (text: string) => new TextEncoder().encode(text);
const end = [17, 0, 0];
function literals(bytes: number[]): number[] {
  if (bytes.length <= 238) return [17 + bytes.length, ...bytes];
  const extra: number[] = [];
  let remaining = bytes.length - 18;
  while (remaining > 255) { extra.push(0); remaining -= 255; }
  return [0, ...extra, remaining, ...bytes];
}
function block(data: number[], size: number): number[] {
  return [data.length & 255, data.length >> 8, size & 255, size >> 8, ...data];
}
function mapText(packed: number[], width: number, height = 1): string {
  const base64 = Buffer.from(packed).toString('base64');
  const chunks = base64.match(/.{1,70}/g) ?? [];
  return `[Basic]\nName=海岸测试\nMinPlayer=2\nMaxPlayer=4\nMultiplayerOnly=1\n[Map]\nSize=0,0,80,90\nTheater=SNOW\n[Preview]\nSize=0,0,${width},${height}\n[PreviewPack]\n`
    + chunks.map((value, i) => `${i + 1}=${value}`).reverse().join('\n');
}
const pixels = [255, 0, 0, 0, 255, 0, 0, 0, 255, 21, 42, 63];
const valid = () => mapText(block([...literals(pixels), ...end], pixels.length), 2, 2);

describe('Red Alert map formats', () => {
  it.each(MAP_EXTENSIONS)('accepts %s case-insensitively and retains the source extension on export', (extension) => {
    const filename = `Sea.Map Test${extension.toUpperCase()}`;
    expect(mapExtension(filename)).toBe(extension);
    expect(mapOutputName(filename, 'edited')).toBe(`Sea.Map Test-edited${extension.toUpperCase()}`);
    expect(mapOutputName(filename, 'png')).toBe('Sea.Map Test.png');
  });
  it.each(['map.txt', 'map.mpr.exe', 'map', 'map.map.zip'])('rejects unrelated filename %s', (name) => {
    expect(mapExtension(name)).toBeUndefined(); expect(() => mapOutputName(name, 'edited')).toThrow('YRM、MPR、MAP 或 YRO');
  });
  it('sanitizes output names while retaining supported suffixes', () => {
    expect(mapOutputName('../bad:name.MPR', 'edited')).toBe('_bad_name-edited.MPR');
    expect(mapOutputName('.map', 'edited')).toBe('map-edited.map');
  });
  it('uses filename defaults only for MPR/YRM and leaves ambiguous MAP/YRO versions unresolved', () => {
    expect(suggestedMapGame('map.MPR', { theater: 'SNOW' })).toBe('ra2');
    expect(suggestedMapGame('map.yrm', { theater: 'SNOW' })).toBe('yr');
    for (const name of ['map.map', 'map.yro']) {
      expect(suggestedMapGame(name, { theater: 'SNOW' })).toBeUndefined();
      expect(suggestedMapGame(name, { theater: 'TEMPERATE' })).toBeUndefined();
      expect(suggestedMapGame(name, { theater: 'DESERT' })).toBe('yr');
    }
    expect(suggestedMapGame('image.png', { theater: 'DESERT' })).toBeUndefined();
  });
  it('reads a legacy Western name and preview without altering source bytes', () => {
    const [first, last] = valid().replace('海岸测试', 'NAME').split('NAME');
    const source = new Uint8Array([...encode(first), 74, 111, 101, 146, 115, 32, 67, 97, 102, 233, ...encode(last)]);
    const before = source.slice(); const result = readYrmPreview(source);
    expect(result.name).toBe('Joe’s Café'); expect(result.encoding).toBe('Windows-1252');
    expect(result.preview?.rgb).toEqual(new Uint8Array(pixels)); expect(source).toEqual(before);
  });
});

describe('YRM preview decoding', () => {
  it('preserves RGB channels, image dimensions, map metadata and source bytes', () => {
    const bytes = encode(valid());
    const before = bytes.slice();
    const result = readYrmPreview(bytes);
    expect(result).toMatchObject({ name: '海岸测试', theater: 'SNOW', width: 80, height: 90, minPlayers: 2, maxPlayers: 4, multiplayer: true });
    expect(result.preview).toEqual({ width: 2, height: 2, rgb: new Uint8Array(pixels) });
    expect(result.previewError).toBeUndefined();
    expect(bytes).toEqual(before);
  });

  it('decodes independent blocks in numeric INI key order and permits a zero footer', () => {
    const values = Array.from({ length: 600 }, (_, n) => n % 256);
    const packed = [
      ...block([...literals(values.slice(0, 300)), ...end], 300),
      ...block([...literals(values.slice(300)), ...end], 300), 0, 0, 0, 0,
    ];
    expect([...readYrmPreview(encode(mapText(packed, 200))).preview!.rgb]).toEqual(values);
  });

  it.each([
    ['short dictionary match after one literal', [18, 65, 0, 0, ...end], [65, 65, 65]],
    ['three-byte dictionary match', [20, 1, 2, 3, 72, 0, ...end], [1, 2, 3, 1, 2, 3]],
    ['overlapping extended match', [19, 65, 66, 32, 1, 0, 0, ...end], [65, ...Array(35).fill(66)]],
    ['literal following a match', [18, 65, 1, 0, 66, 0, 0, ...end], [65, 65, 65, 66, 66, 66]],
  ])('handles %s', (_name, compressed, expected) => {
    const result = readYrmPreview(encode(mapText(block(compressed, expected.length), expected.length / 3)));
    expect(result.previewError).toBeUndefined();
    expect([...result.preview!.rgb]).toEqual(expected);
  });

  it('handles the 2049-byte dictionary match after a long literal run', () => {
    const start = Array.from({ length: 2049 }, (_, n) => n % 251);
    const packed = block([...literals(start), 0, 0, ...end], 2052);
    expect([...readYrmPreview(encode(mapText(packed, 684))).preview!.rgb]).toEqual([...start, ...start.slice(0, 3)]);
  });

  it('handles far dictionary references within a block', () => {
    const start = Array.from({ length: 16386 }, (_, n) => n % 251);
    const packed = block([...literals(start), 17, 4, 0, ...end], 16389);
    expect([...readYrmPreview(encode(mapText(packed, 1821, 3))).preview!.rgb]).toEqual([...start, ...start.slice(1, 4)]);
  });

  it('reads BOM, CRLF, lowercase keys, comments and GBK names', () => {
    const source = '\ufeff' + valid().replaceAll('\n', '\r\n').replace('Size=', 'size=').replace('[Map]', '[map] ; 地图');
    expect(readYrmPreview(encode(source)).preview?.rgb).toEqual(new Uint8Array(pixels));
    const [first, last] = valid().replace('海岸测试', 'GBK_NAME').split('GBK_NAME');
    const gbk = new Uint8Array([...encode(first), 0xd6, 0xd0, 0xce, 0xc4, ...encode(last)]);
    expect(readYrmPreview(gbk).name).toBe('中文');
  });
});

describe('YRM invalid input and preview boundaries', () => {
  it('distinguishes macOS aliases, empty files and unrelated data', () => {
    expect(() => readYrmPreview(encode('book\0\0\0\0mark'))).toThrow('macOS 替身');
    expect(() => readYrmPreview(new Uint8Array())).toThrow('文件为空');
    expect(() => readYrmPreview(encode('not a map'))).toThrow('地图尺寸');
    expect(() => readYrmPreview(encode('MZ\0binary'))).toThrow('二进制');
    expect(() => readYrmPreview(new Uint8Array(MAX_YRM_BYTES + 1))).toThrow('8 MB');
  });

  it('retains map metadata when the preview is missing or damaged', () => {
    const missing = readYrmPreview(encode(valid().split('[Preview]')[0]));
    expect(missing).toMatchObject({ name: '海岸测试', maxPlayers: 4 });
    expect(missing.preview).toBeUndefined();
    expect(missing.previewError).toContain('未内嵌');
    const broken = readYrmPreview(encode(mapText([4, 128, 2, 114, 1], 106, 61)));
    expect(broken.name).toBe('海岸测试');
    expect(broken.previewError).toContain('损坏');
  });

  it.each([
    [0, 1], [-1, 1], [1.5, 1], [4097, 1], [1025, 1024], [999999, 999999],
  ])('rejects invalid or oversized preview dimensions %s × %s', (width, height) => {
    const result = readYrmPreview(encode(mapText([], width, height).replace('[PreviewPack]\n', '[PreviewPack]\n1=AAAA')));
    expect(result.preview).toBeUndefined();
    expect(result.previewError).toMatch(/尺寸|上限/);
  });

  it.each([
    [1, 0, 3],
    [0, 0, 3, 0],
    [50, 0, 3, 0, 18, 0],
    block([18, 1, ...end], 3),
    block([20, 1, 2, 3, ...end], 2),
    block([18, 1, 0, 255, ...end], 3),
    block([20, 1, 2, 3], 3),
    block([20, 1, 2, 3, ...end, 0], 3),
    [...block([20, 1, 2, 3, ...end], 3), 0, 0, 0, 0, 1],
    block([0, 0, 0, 0, 1], 3),
    block([20, 1, 2, 3, 17, 1, 0], 3),
    [...block([18, 1, ...end], 1), ...block([18, 2, 0, 0, ...end], 3)],
  ])('reports malformed compressed streams without returning partial pixels: %j', (...packed) => {
    const result = readYrmPreview(encode(mapText(packed, 1)));
    expect(result.preview).toBeUndefined();
    expect(result.previewError).toContain('损坏');
  });

  it.each(['1=!!!=', '1=AAA', '2=AAAA', '01=AAAA', '__proto__=AAAA', '1=AAAA\n1=AAAA'])('rejects malformed preview keys or base64: %s', (pack) => {
    const source = valid().split('[PreviewPack]')[0] + '[PreviewPack]\n' + pack;
    let message: string | undefined;
    try { message = readYrmPreview(encode(source)).previewError; }
    catch (error) { message = String(error); }
    expect(message).toContain('损坏');
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('requires dictionary references to stay inside each compressed block', () => {
    const packed = [...block([20, 1, 2, 3, ...end], 3), ...block([64, 0, ...end], 3)];
    expect(readYrmPreview(encode(mapText(packed, 2))).previewError).toContain('损坏');
  });
});
