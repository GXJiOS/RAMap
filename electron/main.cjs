const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');
const { createFiles } = require('./files.cjs');

const installCheck = process.argv.includes('--install-check');
const checkData = installCheck ? mkdtempSync(path.join(app.getPath('temp'), 'ramap-install-check-')) : null;
app.setName('RAMap');
app.setPath('userData', checkData || path.join(app.getPath('appData'), 'RAMap'));
if (installCheck) app.setPath('sessionData', checkData);

let mainWindow = null;
let checkFinished = false;
const files = createFiles({ dialog, getWindow: () => mainWindow });
const checkTimeout = installCheck ? setTimeout(() => finishInstallCheck(new Error('启动超过 15 秒')), 15000) : null;

function finishInstallCheck(error) {
  if (checkFinished) return;
  checkFinished = true;
  clearTimeout(checkTimeout);
  if (error) console.error(`RAMap 启动自检失败：${error.message}`);
  else console.log('RAMAP_INSTALL_CHECK_OK');
  mainWindow?.destroy();
  try { rmSync(checkData, { recursive: true, force: true }); } catch { /* 临时缓存交由系统清理。 */ }
  app.exit(error ? 1 : 0);
}

function observeInstallCheck(window) {
  window.webContents.once('preload-error', (_event, _path, error) => finishInstallCheck(error));
  window.webContents.once('render-process-gone', (_event, details) => finishInstallCheck(new Error(`渲染进程退出：${details.reason}`)));
  window.webContents.once('did-finish-load', async () => {
    try {
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        function check() {
          const content = document.querySelector('#root .ramap-app');
          const bridge = window.mapDesktop;
          const methods = ['saveFile'];
          if (content?.textContent.trim() && document.styleSheets.length > 0
            && bridge?.platform === 'darwin' && methods.every((name) => typeof bridge[name] === 'function')) resolve(true);
          else if (Date.now() >= deadline) reject(new Error('页面或桌面桥接尚未就绪'));
          else setTimeout(check, 50);
        }
        check();
      })`);
      finishInstallCheck();
    } catch (error) {
      finishInstallCheck(error);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#fbfaf6',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  if (installCheck) observeInstallCheck(mainWindow);
  else mainWindow.once('ready-to-show', () => mainWindow?.show());

  const devServer = installCheck ? null : process.env.RAMAP_VITE_DEV_SERVER_URL;
  if (devServer) mainWindow.loadURL(devServer);
  else {
    const loading = mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    if (installCheck) loading.catch(finishInstallCheck);
  }
  mainWindow.on('closed', () => { mainWindow = null; });
}

function installApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'RAMap',
      submenu: [
        { role: 'about', label: '关于 RAMap' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 RAMap' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 RAMap' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    { label: '显示', submenu: [{ role: 'togglefullscreen', label: '切换全屏' }] },
    { role: 'windowMenu', label: '窗口' },
  ]));
}

function handle(name, operation) {
  ipcMain.handle(`ramap:${name}`, (event, ...args) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('桌面调用来源无效');
    return operation(...args);
  });
}
handle('save-file', files.saveFile);

if (!installCheck && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });

app.whenReady().then(() => {
  if (installCheck) { app.dock?.hide(); createWindow(); return; }
  installApplicationMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else { mainWindow?.show(); mainWindow?.focus(); } });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
