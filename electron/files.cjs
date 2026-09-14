const fs = require('node:fs/promises');
const path = require('node:path');
const MAX_FILE = 64 * 1024 * 1024;

function safeName(name, nested = false) {
  if (typeof name !== 'string' || !name || name.length > 500 || /[\\\x00-\x1f]/.test(name)
    || path.isAbsolute(name) || name.split('/').some((part) => !part || part === '.' || part === '..')
    || (!nested && name.includes('/'))) throw new Error('文件名无效');
  return name;
}
function decodeFile(file) {
  safeName(file?.name, true);
  if (typeof file.base64 !== 'string' || file.base64.length > Math.ceil(MAX_FILE / 3) * 4
    || file.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) throw new Error('文件内容无效或超过 64 MB');
  return Buffer.from(file.base64, 'base64');
}
function createFiles({ dialog, getWindow }) {
  return {
    async saveFile(file) {
      safeName(file?.name);
      const bytes = decodeFile(file);
      const result = await dialog.showSaveDialog(getWindow(), { defaultPath: file.name });
      if (result.canceled || !result.filePath) return null;
      await fs.writeFile(result.filePath, bytes);
      return result.filePath;
    },
  };
}
module.exports = { createFiles, safeName, decodeFile };
