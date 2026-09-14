const test = require('node:test');
const assert = require('node:assert/strict');
const { safeName, decodeFile } = require('./files.cjs');

const NUL = String.fromCharCode(0);
const BACKSLASH = String.fromCharCode(92);

test('safeName accepts plain map names and rejects paths, control characters and long names', () => {
  assert.equal(safeName('遭遇战-edited.yrm'), '遭遇战-edited.yrm');
  assert.equal(safeName('nested/map.map', true), 'nested/map.map');
  const bad = ['', '/tmp/map.yrm', '../map.yrm', 'a/b.yrm', 'map' + NUL + '.yrm', 'map' + BACKSLASH + 'x.yrm', 'x'.repeat(501), undefined, 42];
  for (const name of bad) assert.throws(() => safeName(name), /文件名无效/, '应拒绝 ' + String(name));
});

test('decodeFile only accepts well-formed base64 within the size limit', () => {
  assert.deepEqual(decodeFile({ name: 'a.map', base64: 'AAEC' }), Buffer.from([0, 1, 2]));
  for (const base64 of ['AAE', 'AA=A', '!!!!']) {
    assert.throws(() => decodeFile({ name: 'a.map', base64 }), /文件内容无效/);
  }
});
