const fs = require('node:fs');
const path = require('node:path');
const { Blowfish } = require('./blowfish.cjs');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (text) => {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < text.length; i += 1) c = CRC_TABLE[(c ^ text.charCodeAt(i)) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
// TS/RA2 先把名字补齐到 4 字节的倍数：补长度余数，再重复末块首字符。
function mixId(name) {
  let text = name.toUpperCase();
  const length = text.length;
  if (length & 3) {
    text += String.fromCharCode(length & 3);
    let extra = 3 - (length & 3);
    while (extra--) text += text[length & ~3];
  }
  return crc32(text);
}

const PUBLIC_KEY = 'AihRvNoIbTn85FZRYNZRcT+i6KpU+maCsEqr3Q5q+LDB5tH7Tz2qQ38V';
const toBig = (bytes, littleEndian) => {
  let value = 0n;
  const ordered = littleEndian ? Buffer.from(bytes).reverse() : bytes;
  for (const byte of ordered) value = (value << 8n) | BigInt(byte);
  return value;
};
const modPow = (base, exponent, modulus) => {
  let result = 1n; base %= modulus;
  while (exponent > 0n) { if (exponent & 1n) result = result * base % modulus; base = base * base % modulus; exponent >>= 1n; }
  return result;
};
// Westwood 的 RSA：模数按大端解析，密文块按小端，指数 0x10001。
function blowfishKey(block) {
  const modulus = toBig(Buffer.from(PUBLIC_KEY, 'base64').subarray(2), false);
  const parts = [];
  for (let i = 0; i < 2; i += 1) {
    let plain = modPow(toBig(block.subarray(i * 40, (i + 1) * 40), true), 65537n, modulus);
    const bytes = Buffer.alloc(39);
    for (let j = 0; j < 39; j += 1) { bytes[j] = Number(plain & 255n); plain >>= 8n; }
    parts.push(bytes);
  }
  return Buffer.concat(parts).subarray(0, 56);
}

function openMix(buffer) {
  let at = 0; let flags = 0;
  if (buffer.length > 4 && buffer.readUInt16LE(0) === 0) { flags = buffer.readUInt16LE(2); at = 4; }
  let index; let count;
  if (flags & 2) {
    const cipher = new Blowfish(blowfishKey(buffer.subarray(at, at + 80)));
    at += 80;
    count = cipher.decrypt(buffer.subarray(at, at + 8)).readUInt16LE(0);
    const indexBytes = Math.ceil((6 + count * 12) / 8) * 8;
    index = cipher.decrypt(buffer.subarray(at, at + indexBytes)).subarray(6);
    at += indexBytes;
  } else {
    count = buffer.readUInt16LE(at);
    index = buffer.subarray(at + 6);
    at += 6 + count * 12;
  }
  if (!count || count > 60000 || index.length < count * 12) throw new Error('MIX 索引无效');
  const body = at;
  const files = [];
  for (let i = 0; i < count; i += 1) {
    files.push({ id: index.readUInt32LE(i * 12) >>> 0, offset: index.readUInt32LE(i * 12 + 4), size: index.readUInt32LE(i * 12 + 8) });
  }
  return { count, files, read: (file) => buffer.subarray(body + file.offset, body + file.offset + file.size) };
}

// 把根包与嵌套包铺成一张 id → 读取函数 的索引。
function indexArchives(directory, archives) {
  const index = new Map();
  const opened = [];
  for (const name of archives) {
    let root;
    try { root = openMix(fs.readFileSync(path.join(directory, name))); }
    catch { continue; }
    opened.push(name);
    for (const file of root.files) if (!index.has(file.id)) index.set(file.id, () => root.read(file));
    for (const file of root.files) {
      const bytes = root.read(file);
      if (bytes.length < 8 || bytes.readUInt16LE(0) !== 0) continue;
      let inner;
      try { inner = openMix(bytes); } catch { continue; }
      for (const entry of inner.files) if (!index.has(entry.id)) index.set(entry.id, () => inner.read(entry));
    }
  }
  return { index, opened };
}

const ARCHIVES = ['ra2md.mix', 'ra2.mix', 'expandmd01.mix', 'langmd.mix'];
// 资源目录记在 userData 里，下次启动直接接着用。
function createAssets(settingsPath) {
  let current = null;
  const remember = (directory) => {
    if (!settingsPath) return;
    try { fs.writeFileSync(settingsPath, JSON.stringify({ assetDirectory: directory }, null, 2)); }
    catch { /* 配置写不进去不影响本次使用。 */ }
  };
  const recall = () => {
    if (!settingsPath) return null;
    try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')).assetDirectory ?? null; }
    catch { return null; }
  };
  return {
    open(directory) {
      if (typeof directory !== 'string' || !directory) throw new Error('资源目录无效');
      const { index, opened } = indexArchives(directory, ARCHIVES);
      if (!index.size) throw new Error('该目录里没有可读取的 MIX 资源包');
      current = { directory, index };
      remember(directory);
      return { directory, archives: opened, files: index.size };
    },
    restore() {
      const directory = recall();
      if (!directory || current) return null;
      try { return this.open(directory); } catch { return null; }
    },
    status() { return current ? { directory: current.directory, files: current.index.size } : null; },
    read(name) {
      if (!current) throw new Error('尚未载入游戏资源目录');
      if (typeof name !== 'string' || name.length > 120 || !/^[\w. -]+$/.test(name)) throw new Error('资源名无效');
      const reader = current.index.get(mixId(name));
      return reader ? reader().toString('base64') : null;
    },
  };
}
module.exports = { createAssets, openMix, mixId, indexArchives };
