// Blowfish 的 P 数组与 S 盒是 π 小数部分的十六进制展开，用 Machin 公式现算，
// 省去在源码里堆 4168 个魔数；P[0] 必须等于 0x243F6A88，可自证。
function piHexDigits(count) {
  const precision = count + 16;
  const scale = 16n ** BigInt(precision);
  const arctanInverse = (x) => {
    const square = BigInt(x) * BigInt(x);
    let term = scale / BigInt(x);
    let total = term;
    let k = 1n;
    while (term) {
      term /= square;
      k += 2n;
      total += ((k - 1n) / 2n) % 2n === 0n ? term / k : -(term / k);
    }
    return total;
  };
  const pi = 4n * (4n * arctanInverse(5) - arctanInverse(239));
  return (pi - 3n * scale).toString(16).padStart(precision, '0').slice(0, count);
}

let seeds = null;
function constants() {
  if (seeds) return seeds;
  const digits = piHexDigits((18 + 4 * 256) * 8);
  const words = [];
  for (let i = 0; i < digits.length; i += 8) words.push(Number.parseInt(digits.slice(i, i + 8), 16) >>> 0);
  if (words[0] !== 0x243F6A88) throw new Error('Blowfish 常量生成失败');
  seeds = { p: words.slice(0, 18), s: [0, 1, 2, 3].map((n) => words.slice(18 + n * 256, 18 + (n + 1) * 256)) };
  return seeds;
}

class Blowfish {
  constructor(key) {
    const seed = constants();
    this.p = Uint32Array.from(seed.p);
    this.s = seed.s.map((box) => Uint32Array.from(box));
    for (let i = 0, k = 0; i < 18; i += 1) {
      let value = 0;
      for (let j = 0; j < 4; j += 1) { value = ((value << 8) | key[k % key.length]) >>> 0; k += 1; }
      this.p[i] = (this.p[i] ^ value) >>> 0;
    }
    let left = 0; let right = 0;
    for (let i = 0; i < 18; i += 2) { [left, right] = this.encryptPair(left, right); this.p[i] = left; this.p[i + 1] = right; }
    for (let box = 0; box < 4; box += 1) {
      for (let i = 0; i < 256; i += 2) { [left, right] = this.encryptPair(left, right); this.s[box][i] = left; this.s[box][i + 1] = right; }
    }
  }
  round(value) {
    const a = this.s[0][(value >>> 24) & 0xFF]; const b = this.s[1][(value >>> 16) & 0xFF];
    const c = this.s[2][(value >>> 8) & 0xFF]; const d = this.s[3][value & 0xFF];
    return ((((a + b) >>> 0) ^ c) + d) >>> 0;
  }
  encryptPair(left, right) {
    for (let i = 0; i < 16; i += 1) {
      left = (left ^ this.p[i]) >>> 0;
      right = (right ^ this.round(left)) >>> 0;
      [left, right] = [right, left];
    }
    [left, right] = [right, left];
    return [(left ^ this.p[17]) >>> 0, (right ^ this.p[16]) >>> 0];
  }
  decryptPair(left, right) {
    for (let i = 17; i > 1; i -= 1) {
      left = (left ^ this.p[i]) >>> 0;
      right = (right ^ this.round(left)) >>> 0;
      [left, right] = [right, left];
    }
    [left, right] = [right, left];
    return [(left ^ this.p[0]) >>> 0, (right ^ this.p[1]) >>> 0];
  }
  decrypt(data) {
    const out = Buffer.alloc(data.length - (data.length % 8));
    for (let at = 0; at + 8 <= data.length; at += 8) {
      const [left, right] = this.decryptPair(data.readUInt32BE(at), data.readUInt32BE(at + 4));
      out.writeUInt32BE(left, at); out.writeUInt32BE(right, at + 4);
    }
    return out;
  }
}
module.exports = { Blowfish };
