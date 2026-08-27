/**
 * Electron main process.
 *
 * The app itself is the same static build that runs in a browser; Electron adds
 * a real window, native file dialogs, and direct disk access, so projects are
 * ordinary folders rather than something behind the File System Access API.
 */
const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

// `--dev` attaches to the Vite dev server; without it the built `dist/` is
// loaded, so `electron .` works straight after a build with no server running.
const useDevServer = process.argv.includes('--dev');
const DEV_URL = process.env.BENSEDITOR_DEV_URL ?? 'http://localhost:5173';

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#14161c',
    autoHideMenuBar: true,
    title: 'Benseditor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The game canvas wants a real GPU; leave the defaults alone otherwise.
      backgroundThrottling: false,
    },
  });

  if (useDevServer) {
    mainWindow.loadURL(DEV_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // External links open in the real browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    ]),
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- file system, exposed through the preload bridge ----------------------

const ASSET_FOLDERS = ['sprites', 'tilesets', 'objects', 'rooms', 'scripts'];

// Mirrors src/project/languages.ts: scripts are `.luau` or `.py` by the
// project's language, and an object with no script file gets the fallback.
const SCRIPT_EXTENSIONS = { luau: 'luau', python: 'py' };
const OBJECT_FALLBACK = { luau: 'local obj = {}\n\nreturn obj\n', python: '' };
const languageOf = (config) => (config && config.language === 'python' ? 'python' : 'luau');

ipcMain.handle('dialog:openProject', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a Benseditor project',
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:chooseFolder', async (_event, title) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: title ?? 'Choose a folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:saveFile', async (_event, { title, defaultName, filters }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: title ?? 'Save',
    defaultPath: defaultName,
    filters: filters ?? [],
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('fs:readProject', async (_event, root) => {
  const readText = (...parts) => fs.readFile(path.join(root, ...parts), 'utf8');

  const listing = async (folder, extension) => {
    try {
      const names = await fs.readdir(path.join(root, folder));
      return names.filter((name) => name.endsWith(extension)).sort();
    } catch {
      return [];
    }
  };

  const config = JSON.parse(await readText('benseditor.json'));
  const language = languageOf(config);
  const extensions = [SCRIPT_EXTENSIONS[language], ...Object.values(SCRIPT_EXTENSIONS)];
  const readScript = async (folder, name) => {
    for (const extension of extensions) {
      try {
        return await readText(folder, `${name}.${extension}`);
      } catch {
        // Try the next extension.
      }
    }
    return undefined;
  };

  const sprites = [];
  for (const file of await listing('sprites', '.bsprite')) {
    sprites.push(JSON.parse(await readText('sprites', file)));
  }

  const tilesets = [];
  for (const file of await listing('tilesets', '.btileset')) {
    tilesets.push(JSON.parse(await readText('tilesets', file)));
  }

  const objects = [];
  for (const file of await listing('objects', '.bobject')) {
    const def = JSON.parse(await readText('objects', file));
    // A definition without a script still loads.
    const source = await readScript('objects', file.replace(/\.bobject$/, ''));
    objects.push({ def, source: source ?? OBJECT_FALLBACK[language] });
  }

  const rooms = [];
  for (const file of await listing('rooms', '.broom')) {
    rooms.push(JSON.parse(await readText('rooms', file)));
  }

  const scripts = [];
  const scriptExtension = `.${SCRIPT_EXTENSIONS[language]}`;
  for (const file of await listing('scripts', scriptExtension)) {
    scripts.push({ name: file.slice(0, -scriptExtension.length), source: await readText('scripts', file) });
  }

  return { config, sprites, tilesets, objects, rooms, scripts };
});

ipcMain.handle('fs:writeProject', async (_event, root, project) => {
  const json = (value) => JSON.stringify(value, null, 2) + '\n';
  const write = (contents, ...parts) =>
    fs.writeFile(path.join(root, ...parts), contents, 'utf8');

  for (const folder of ASSET_FOLDERS) {
    await fs.mkdir(path.join(root, folder), { recursive: true });
  }

  await write(json(project.config), 'benseditor.json');
  const extension = SCRIPT_EXTENSIONS[languageOf(project.config)];
  for (const sprite of project.sprites) {
    await write(json(sprite), 'sprites', `${sprite.name}.bsprite`);
  }
  for (const tileset of project.tilesets ?? []) {
    await write(json(tileset), 'tilesets', `${tileset.name}.btileset`);
  }
  for (const { def, source } of project.objects) {
    await write(json(def), 'objects', `${def.name}.bobject`);
    await write(source, 'objects', `${def.name}.${extension}`);
  }
  for (const room of project.rooms) {
    await write(json(room), 'rooms', `${room.name}.broom`);
  }
  for (const script of project.scripts ?? []) {
    await write(script.source, 'scripts', `${script.name}.${extension}`);
  }

  return true;
});

ipcMain.handle('fs:writeFile', async (_event, target, contents) => {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, 'utf8');
  return true;
});

ipcMain.handle('shell:showItem', async (_event, target) => {
  shell.showItemInFolder(target);
});
