const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { spawn, execSync } = require('child_process');
const os = require('os');
const { registerVoicyPublishHandler } = require('./main/voicy-publish')
const { registerStandfmPublishHandler } = require('./main/standfm-publish')
const { registerSpotifyPublishHandler } = require('./main/spotify-publish')

// 起動直後に main.js が実行されているかを切り分けるためのデバッグ（必要時のみ有効）
const bootLogPath = '/tmp/voice-uploader-boot.log'
const bootLog = (message) => {
  if (process.env.VUT_DEBUG_BOOT !== '1') return
  try {
    require('fs').writeFileSync(bootLogPath, `${new Date().toISOString()} ${message}\n`, { flag: 'a' })
  } catch (e) {
    // 何も出せない状況でも、ここで落ちないようにする
  }
}

if (process.env.VUT_DEBUG_BOOT === '1') {
  bootLog('boot main.js loaded')
}

// Puppeteer は asar 環境で初期化時に落ちることがあるため、必要になるまで遅延ロードする
let puppeteer = null

let mainWindow;
let globalBrowser = null;
let globalPage = null;

// NOTE:
// 以前は安定化のために GPU/JIT 無効化フラグを試していたが、副作用で不安定化する可能性があるため撤去する

bootLog(`argv: ${process.argv.join(' ')}`)
bootLog(`isPackaged: ${app.isPackaged}`)

// NOTE:
// パッケージ版では app.getPath(...) を app ready 前に呼ぶと落ちるケースがあるため、
// パス類は whenReady 後に初期化する
let dataDir = null
let audioDir = null
let textDir = null
let mdDir = null
let metadataPath = null
let chromeUserDataDir = null
let configPath = null

const initPaths = () => {
  if (dataDir) return

  dataDir = app.isPackaged ? app.getPath('userData') : __dirname
  audioDir = path.join(dataDir, '.m4a')
  textDir = path.join(dataDir, 'text')
  mdDir = path.join(dataDir, 'md')
  metadataPath = path.join(dataDir, 'metadata.json')
  chromeUserDataDir = path.join(dataDir, 'chrome-user-data')
  configPath = path.join(app.getPath('userData'), 'config.json')

  bootLog(`paths initialized: dataDir=${dataDir}`)
}

const getAppPaths = () => ({ audioDir, mdDir, metadataPath })

function getCandidateUserDataDirs() {
  const dirs = new Set()

  try {
    dirs.add(app.getPath('userData'))
  } catch (e) {
    // ignore
  }

  try {
    const appData = app.getPath('appData')
    if (appData) {
      dirs.add(path.join(appData, 'multi-voice-uploader'))
      dirs.add(path.join(appData, 'MultiVoiceUploader'))
      try {
        dirs.add(path.join(appData, app.getName()))
      } catch (e) {
        // ignore
      }
    }
  } catch (e) {
    // ignore
  }

  return Array.from(dirs).filter(Boolean)
}

async function saveBroadcastImageInternal(originalPath) {
  if (!originalPath || typeof originalPath !== 'string') {
    return { success: false, error: '画像ファイルが選択されていません' }
  }

  initPaths()
  const userDataPath = app.getPath('userData')
  const imagesDir = path.join(userDataPath, 'broadcast_images')

  await fs.ensureDir(imagesDir)
  await fs.emptyDir(imagesDir)

  const timestamp = Date.now()
  const extLower = path.extname(originalPath).toLowerCase()
  const stats = await fs.stat(originalPath).catch(() => null)
  const originalSize = stats ? stats.size : null

  if (extLower === '.png' || extLower === '.jpg' || extLower === '.jpeg') {
    const newFileName = `broadcast_image_${timestamp}${extLower}`
    const newPath = path.join(imagesDir, newFileName)
    await fs.copy(originalPath, newPath)
    const newStats = await fs.stat(newPath).catch(() => null)
    console.log(`Saved broadcast image to: ${newPath} (copied as-is, originalExt=${extLower}, originalSize=${originalSize}, savedSize=${newStats ? newStats.size : null})`)
    return { success: true, path: newPath }
  }

  const newFileName = `broadcast_image_${timestamp}.png`
  const newPath = path.join(imagesDir, newFileName)

  const img = nativeImage.createFromPath(originalPath)
  if (!img || img.isEmpty()) {
    return { success: false, error: '画像の読み込みに失敗しました（対応していない形式の可能性があります）' }
  }

  const size = img.getSize ? img.getSize() : null
  const pngBuffer = img.toPNG()
  await fs.writeFile(newPath, pngBuffer)
  const newStats = await fs.stat(newPath).catch(() => null)
  console.log(`Saved broadcast image to: ${newPath} (normalized to PNG, originalExt=${extLower}, originalSize=${originalSize}, savedSize=${newStats ? newStats.size : null}, imageSize=${size ? `${size.width}x${size.height}` : null})`)
  return { success: true, path: newPath }
}

async function findLatestBroadcastImageInUserDataDir(userDataDir) {
  const dir = path.join(userDataDir, 'broadcast_images')
  const exists = await fs.pathExists(dir).catch(() => false)
  if (!exists) return null

  const files = await fs.readdir(dir).catch(() => [])
  const candidates = files
    .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
    .map(f => path.join(dir, f))

  let newest = null
  let newestMtime = 0
  for (const filePath of candidates) {
    const st = await fs.stat(filePath).catch(() => null)
    if (!st) continue
    const mtime = st.mtimeMs || 0
    if (mtime > newestMtime) {
      newestMtime = mtime
      newest = filePath
    }
  }

  return newest
}

async function resolveStandfmDefaultImagePath(configValue) {
  initPaths()

  if (configValue && typeof configValue === 'string') {
    const normalized = path.normalize(configValue)
    if (await fs.pathExists(normalized)) return normalized
  }

  for (const dir of getCandidateUserDataDirs()) {
    const latest = await findLatestBroadcastImageInUserDataDir(dir)
    if (!latest) continue
    if (!(await fs.pathExists(latest))) continue

    const currentUserData = app.getPath('userData')
    if (path.normalize(dir) !== path.normalize(currentUserData)) {
      console.log(`Migrating broadcast image from legacy dir: ${latest}`)
      const saved = await saveBroadcastImageInternal(latest)
      if (saved.success) {
        const config = await fs.pathExists(configPath) ? await fs.readJson(configPath) : {}
        config.standfmDefaultImage = saved.path
        await fs.writeJson(configPath, config)
        return saved.path
      }
    } else {
      return latest
    }
  }

  return null
}

function createWindow() {
  bootLog('createWindow start')
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    icon: path.join(__dirname, 'icon.png')
  });

  bootLog('BrowserWindow created')
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  bootLog('mainWindow.loadFile called')

  // DevToolsは起動時に開かない
  // if (process.argv.includes('--dev')) {
  //   mainWindow.webContents.openDevTools();
  // }

  // macOSの場合はDockアイコンを設定
  if (process.platform === 'darwin') {
    bootLog('app.dock.setIcon start')
    app.dock.setIcon(path.join(__dirname, 'icon.png'));
    bootLog('app.dock.setIcon done')
  }
}

process.on('uncaughtException', (error) => {
  bootLog(`uncaughtException: ${error && error.stack ? error.stack : String(error)}`)
})

process.on('unhandledRejection', (reason) => {
  bootLog(`unhandledRejection: ${reason && reason.stack ? reason.stack : String(reason)}`)
})

app.whenReady().then(() => {
  bootLog('app.whenReady resolved')
  initPaths()

  // パッケージ版だけ落ちるケースの切り分け用：安全モードではウィンドウを作らず常駐する
  if (process.env.VUT_SAFE_MODE === '1') {
    bootLog('SAFE_MODE enabled: skip createWindow')
    setInterval(() => {}, 1000)
    return
  }

  createWindow()
});

app.on('window-all-closed', async () => {
  if (globalBrowser) {
    try {
      await globalBrowser.close();
      globalBrowser = null;
      globalPage = null;
    } catch (error) {
      console.error('Error closing browser on app quit:', error);
    }
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', async () => {
  if (globalBrowser) {
    try {
      await globalBrowser.close();
      globalBrowser = null;
      globalPage = null;
    } catch (error) {
      console.error('Error closing browser on app quit:', error);
    }
  }
});

// 音声ファイルフォルダが存在しない場合は作成
async function ensureDirectories() {
  initPaths()
  await fs.ensureDir(audioDir);
  await fs.ensureDir(textDir);
  await fs.ensureDir(mdDir);
  await fs.ensureDir(chromeUserDataDir);
}

// 音声拡張子（大文字含め判定用）
const AUDIO_EXT_LIST = ['.mp4', '.m4a', '.mp3', '.wav'];
const isAudioFile = (filename) => AUDIO_EXT_LIST.some(ext => filename.toLowerCase().endsWith(ext));

// 音声ファイル一覧を取得
ipcMain.handle('get-audio-files', async () => {
  try {
    await ensureDirectories();
    const files = await fs.readdir(audioDir);

    const audioFiles = files.filter(file => isAudioFile(file));

    // メタデータを読み込み
    const metadata = await fs.pathExists(metadataPath) ? await fs.readJson(metadataPath) : {};

    const result = [];
    for (const file of audioFiles) {
      const basename = path.parse(file).name;
      const textFile = path.join(textDir, basename + '.txt');
      const mdFile = path.join(mdDir, basename + '.md');
      const hasText = await fs.pathExists(textFile);
      const hasMd = await fs.pathExists(mdFile);

      // メタデータから投稿ステータスを取得
      const itemMetadata = metadata[basename] || {};

      result.push({
        filename: file,
        basename: basename,
        hasText: hasText,
        hasMd: hasMd,
        title: '',
        publishDate: '',
        standfmPublished: itemMetadata.standfmPublished || false,
        voicyPublished: itemMetadata.voicyPublished || false,
        voicyPublishedDate: itemMetadata.voicyPublishedDate || null,
        spotifyPublished: itemMetadata.spotifyPublished || false,
        spotifyPublishedDate: itemMetadata.spotifyPublishedDate || null
      });
    }

    return result;
  } catch (error) {
    console.error('Error getting audio files:', error);
    return [];
  }
});

// テキストファイルの存在チェック
ipcMain.handle('check-text-file', async (event, basename) => {
  try {
    const textFile = path.join(textDir, basename + '.txt');
    return await fs.pathExists(textFile);
  } catch (error) {
    console.error('Error checking text file:', error);
    return false;
  }
});

// テキストファイルを読み込む
ipcMain.handle('read-text-file', async (event, basename) => {
  try {
    const textFile = path.join(textDir, basename + '.txt');
    const exists = await fs.pathExists(textFile);

    if (exists) {
      const content = await fs.readFile(textFile, 'utf8');
      return { success: true, content };
    } else {
      return { success: false, message: 'テキストファイルが存在しません' };
    }
  } catch (error) {
    console.error('Error reading text file:', error);
    return { success: false, message: error.message };
  }
});

// 音声ファイルを削除（同一 basename の全拡張子の音声 + テキスト + メタデータ）
ipcMain.handle('delete-audio-file', async (event, { basename, filename }) => {
  try {
    initPaths();
    const textPath = path.join(textDir, basename + '.txt');
    const mdPath = path.join(mdDir, basename + '.md');

    // 同一 basename の音声ファイルを全拡張子で削除（大文字拡張子も対象）
    const dirFiles = await fs.readdir(audioDir);
    for (const f of dirFiles) {
      const p = path.parse(f);
      if (p.name === basename && isAudioFile(f)) await fs.remove(path.join(audioDir, f));
    }
    if (await fs.pathExists(textPath)) await fs.remove(textPath);
    if (await fs.pathExists(mdPath)) await fs.remove(mdPath);

    // メタデータの削除
    if (await fs.pathExists(metadataPath)) {
      const metadata = await fs.readJson(metadataPath);
      if (metadata[basename]) {
        delete metadata[basename];
        await fs.writeJson(metadataPath, metadata, { spaces: 2 });
      }
    }

    return { success: true };
  } catch (error) {
    console.error('Error deleting file:', error);
    return { success: false, message: error.message };
  }
});


// ページインスタンスを取得または作成
async function getPageInstance() {
  initPaths()
  // ブラウザが無効になっている場合はリセット
  if (globalBrowser && !globalBrowser.isConnected()) {
    globalBrowser = null;
    globalPage = null;
  }

  // ページが無効になっている場合はリセット
  if (globalPage && globalPage.isClosed()) {
    globalPage = null;
  }

  // ページがblankページの場合はリセット（Windowsで既存のChromeと競合した場合の対策）
  if (globalPage) {
    try {
      const currentUrl = globalPage.url();
      if (currentUrl === 'about:blank' || currentUrl === '' || !currentUrl) {
        console.log('Page is blank, creating new page');
        try {
          await globalPage.close();
        } catch (e) {
          // ページが既に閉じられている場合は無視
        }
        globalPage = null;
      }
    } catch (error) {
      // ページの状態を取得できない場合は新しいページを作成
      console.log('Cannot get page state, creating new page:', error.message);
      globalPage = null;
    }
  }

  // ブラウザが存在しない場合は作成
  if (!globalBrowser) {
    if (!puppeteer) puppeteer = require('puppeteer')

    // Chrome実行ファイルのパスを確認
    let executablePath = null;

    if (process.platform === 'darwin') {
      const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      if (await fs.pathExists(chromePath)) {
        executablePath = chromePath;
      }
    } else if (process.platform === 'win32') {
      const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      if (await fs.pathExists(chromePath)) {
        executablePath = chromePath;
      }
    } else {
      const chromePath = '/usr/bin/google-chrome';
      if (await fs.pathExists(chromePath)) {
        executablePath = chromePath;
      }
    }

    // ユーザーデータディレクトリのパスを設定
    // Windowsで既存のChromeと競合しないように、アプリ専用のディレクトリを使用
    await fs.ensureDir(chromeUserDataDir);

    const launchOptions = {
      headless: false,
      defaultViewport: null,
      devtools: false,
      userDataDir: chromeUserDataDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=VizDisplayCompositor',
        '--start-maximized',
        '--disable-infobars',
        '--disable-extensions-except=',
        '--disable-plugins-discovery',
        '--disable-default-apps'
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      ignoreHTTPSErrors: true
    };

    if (executablePath) {
      launchOptions.executablePath = executablePath;
      console.log(`Using Chrome at: ${executablePath}`);
    } else {
      console.log('Using Puppeteer bundled Chromium');
    }

    try {
      globalBrowser = await puppeteer.launch(launchOptions);
    } catch (error) {
      // Windowsで既存のChromeと競合した場合、userDataDirを変更して再試行
      if (process.platform === 'win32' && error.message && (
        error.message.includes('user data directory') ||
        error.message.includes('already in use') ||
        error.message.includes('locked')
      )) {
        console.log('Chrome user data directory conflict detected, using alternative directory');
        const altUserDataDir = path.join(chromeUserDataDir, 'instance-' + Date.now());
        await fs.ensureDir(altUserDataDir);
        launchOptions.userDataDir = altUserDataDir;
        globalBrowser = await puppeteer.launch(launchOptions);
      } else {
        throw error;
      }
    }
  }

  // ページが存在しない場合は作成
  if (!globalPage) {
    globalPage = await globalBrowser.newPage();
  }

  return globalPage;
}

// メタデータファイルのパスは上で定義済み

// Markdownをプレーンテキストメール形式に変換


// インライン記法の処理


// メタデータを読み込み
ipcMain.handle('load-metadata', async () => {
  try {
    initPaths()
    if (await fs.pathExists(metadataPath)) {
      const data = await fs.readJson(metadataPath);
      return data;
    }
    return {};
  } catch (error) {
    console.error('Error loading metadata:', error);
    return {};
  }
});

// メタデータを保存
ipcMain.handle('save-metadata', async (event, metadata) => {
  try {
    initPaths()
    await fs.writeJson(metadataPath, metadata, { spaces: 2 });
    return { success: true };
  } catch (error) {
    console.error('Error saving metadata:', error);
    return { success: false, message: error.message };
  }
});

// 投稿状態をリセット
ipcMain.handle('reset-publish-status', async (event, basename, platform) => {
  try {
    initPaths()
    const metadata = await fs.pathExists(metadataPath) ? await fs.readJson(metadataPath) : {};
    if (!metadata[basename]) {
      metadata[basename] = {};
    }

    if (platform === 'voicy') {
      metadata[basename].voicyPublished = false;
      delete metadata[basename].voicyPublishedDate;
    } else if (platform === 'standfm') {
      metadata[basename].standfmPublished = false;
      delete metadata[basename].standfmPublishedDate;
    } else if (platform === 'spotify') {
      metadata[basename].spotifyPublished = false
      delete metadata[basename].spotifyPublishedDate
    }

    await fs.writeJson(metadataPath, metadata, { spaces: 2 });
    return { success: true };
  } catch (error) {
    console.error('Error resetting publish status:', error);
    return { success: false, message: error.message };
  }
});

// ファイル選択ダイアログ
ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Audio Files', extensions: ['mp4', 'm4a', 'wav', 'mp3'] }
    ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// 画像ファイル選択ダイアログ（放送画像用）
ipcMain.handle('select-image-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Image Files', extensions: ['png', 'jpg', 'jpeg', 'webp'] }
    ]
  })

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0]
  }
  return null
})

// ファイルを.m4aフォルダにコピー
ipcMain.handle('copy-to-mp4', async (event, sourcePath) => {
  try {
    await ensureDirectories();
    const filename = path.basename(sourcePath);
    const destPath = path.join(audioDir, filename);
    await fs.copy(sourcePath, destPath);
    return { success: true, filename };
  } catch (error) {
    console.error('Error copying file:', error);
    return { success: false, message: error.message };
  }
});



// 外部URLを開く
ipcMain.handle('open-external-url', async (event, url) => {
  try {
    let page = await getPageInstance();

    // ページがblankの場合は新しいページを作成
    try {
      const currentUrl = page.url();
      if (currentUrl === 'about:blank' || currentUrl === '' || !currentUrl) {
        console.log('Page is blank, creating new page for URL:', url);
        try {
          await page.close();
        } catch (e) {
          // ページが既に閉じられている場合は無視
        }
        if (globalBrowser) {
          globalPage = await globalBrowser.newPage();
          page = globalPage;
        }
      }
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (gotoError) {
      // gotoに失敗した場合、新しいページを作成して再試行
      console.log('goto failed, creating new page and retrying:', gotoError.message);
      try {
        await page.close();
      } catch (e) {
        // ページが既に閉じられている場合は無視
      }
      if (globalBrowser) {
        globalPage = await globalBrowser.newPage();
        page = globalPage;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } else {
        throw gotoError;
      }
    }

    // bring browser to front? Puppeteer doesn't have a direct API for this,
    // but launching usually brings it up.
    return { success: true };
  } catch (error) {
    console.error('Error opening external URL with Puppeteer:', error);
    return { success: false, message: error.message };
  }
});

// Voicyに投稿
registerVoicyPublishHandler({
  ipcMain,
  fs,
  path,
  getPageInstance,
  getAppPaths
})



// 文字起こし実行
ipcMain.handle('transcribe-audio', async (event, basename) => {
  console.log('Transcribing audio for:', basename);

  try {
    initPaths();
    const nameWithoutExt = path.parse(basename).name;

    // 実際のファイルを探す（拡張子の大文字・小文字両方に対応）
    let audioFilePath = null;
    const directPath = path.join(audioDir, basename);
    if (await fs.pathExists(directPath)) {
      audioFilePath = directPath;
    } else {
      const dirFiles = await fs.readdir(audioDir);
      const found = dirFiles.find(f => path.parse(f).name === nameWithoutExt && isAudioFile(f));
      if (found) audioFilePath = path.join(audioDir, found);
    }

    if (!audioFilePath) {
      throw new Error(`Audio file not found for: ${basename} (checked: ${basename} and ${nameWithoutExt} with extensions ${AUDIO_EXT_LIST.join(', ')})`);
    }

    // 出力ディレクトリの確保
    await fs.ensureDir(textDir);

    // 出力ファイルのパス
    const outputFilePath = path.join(textDir, nameWithoutExt + '.txt');

    // 既に文字起こしされている場合はスキップ
    if (await fs.pathExists(outputFilePath)) {
      console.log(`Transcription already exists: ${outputFilePath}`);
      return {
        success: true,
        message: 'Transcription already exists',
        outputPath: outputFilePath
      };
    }

    // transcribe_audio_local.pyスクリプトを実行（ローカルWhisper使用）
    // ビルド後はapp.asar.unpackedまたは一時ディレクトリにコピーして使用
    let transcribeScript;

    if (app.isPackaged) {
      // ビルド後のアプリでは、app.asar内のファイルは直接実行できないため、
      // 一時ディレクトリにコピーしてから実行する
      const tempScriptDir = path.join(dataDir, 'temp-scripts');
      await fs.ensureDir(tempScriptDir);
      transcribeScript = path.join(tempScriptDir, 'transcribe_audio_local.py');

      // 既にコピー済みの場合はスキップ
      if (!(await fs.pathExists(transcribeScript))) {
        // app.asar内のファイルを読み込む
        // app.getAppPath()はapp.asar内のパスを返す
        const appPath = app.getAppPath();
        const asarScriptPath = path.join(appPath, 'transcribe_audio_local.py');

        // app.asar.unpackedのパスも試す
        const resourcesPath = process.resourcesPath;
        const unpackedScriptPath = path.join(resourcesPath, 'app.asar.unpacked', 'transcribe_audio_local.py');

        let sourceScriptPath = null;

        // まずapp.asar.unpackedを確認
        if (await fs.pathExists(unpackedScriptPath)) {
          sourceScriptPath = unpackedScriptPath;
          console.log(`Found script in app.asar.unpacked: ${unpackedScriptPath}`);
        } else if (await fs.pathExists(asarScriptPath)) {
          sourceScriptPath = asarScriptPath;
          console.log(`Found script in app.asar: ${asarScriptPath}`);
        } else {
          console.error(`Script not found in: ${asarScriptPath} or ${unpackedScriptPath}`);
          return {
            success: false,
            message: `文字起こしスクリプトが見つかりません。パスを確認してください。`
          };
        }

        // スクリプトを一時ディレクトリにコピー
        try {
          const scriptContent = await fs.readFile(sourceScriptPath, 'utf8');
          await fs.writeFile(transcribeScript, scriptContent, 'utf8');
          // 実行権限を付与
          await fs.chmod(transcribeScript, 0o755);
          console.log(`Copied script from ${sourceScriptPath} to ${transcribeScript}`);
        } catch (error) {
          console.error(`Failed to copy script: ${error.message}`);
          return {
            success: false,
            message: `スクリプトの読み込みに失敗しました: ${error.message}`
          };
        }
      } else {
        console.log(`Using existing script: ${transcribeScript}`);
      }
    } else {
      // 開発時は直接パスを使用
      transcribeScript = path.join(__dirname, 'transcribe_audio_local.py');
    }

    // スクリプトファイルの存在確認
    if (!(await fs.pathExists(transcribeScript))) {
      console.error(`Transcription script not found: ${transcribeScript}`);
      return {
        success: false,
        message: `文字起こしスクリプトが見つかりません: ${transcribeScript}`
      };
    }

    // Pythonの起動コマンドを選択
    // Windowsでは python より py (Python Launcher) のほうが確実なことが多い
    let pythonCmd = 'python3'
    let pythonCmdPrefixArgs = []

    if (process.platform === 'win32') {
      pythonCmd = 'py'
      pythonCmdPrefixArgs = ['-3']
    } else if (process.platform === 'darwin') {
      // Macの場合、一般的なPythonパスを試す
      const possiblePaths = [
        '/usr/bin/python3',
        '/usr/local/bin/python3',
        '/opt/homebrew/bin/python3',
        'python3'
      ]

      for (const possiblePath of possiblePaths) {
        try {
          if (possiblePath === 'python3') {
            pythonCmd = 'python3'
            break
          }
          if (await fs.pathExists(possiblePath)) {
            pythonCmd = possiblePath
            break
          }
        } catch (e) {
          // ignore
        }
      }
    }

    const pythonCmdDisplay = `${pythonCmd}${pythonCmdPrefixArgs.length > 0 ? ' ' + pythonCmdPrefixArgs.join(' ') : ''}`

    console.log(`Using Python: ${pythonCmdDisplay}`);
    console.log(`Transcription script: ${transcribeScript}`);
    console.log(`Audio file: ${audioFilePath}`);
    console.log(`Output dir: ${textDir}`);

    // Pythonのバージョンとパスを確認（デバッグ用）
    try {
      const { execFileSync } = require('child_process')
      const pythonVersion = execFileSync(pythonCmd, [...pythonCmdPrefixArgs, '--version'], { encoding: 'utf8', timeout: 5000 })
      console.log(`Python version: ${String(pythonVersion).trim()}`)

      // whisperがインストールされているか確認
      try {
        execFileSync(pythonCmd, [...pythonCmdPrefixArgs, '-c', 'import whisper'], { encoding: 'utf8', timeout: 5000 })
        console.log('whisper module is available')
      } catch (e) {
        console.warn('whisper module is NOT available in this Python environment')
      }
    } catch (e) {
      console.log(`Could not get Python version: ${e.message}`)
    }

    // PATH環境変数を構築（ffmpegやpyenvのshimを見つけられるように）
    const homeDir = os.homedir();
    const pyenvShims = path.join(homeDir, '.pyenv', 'shims');

    // システムのPATHを取得（Windowsではより確実に取得）
    let systemPath = process.env.PATH || '';

    // Windowsの場合、システムのPATH環境変数をより確実に取得
    if (process.platform === 'win32') {
      try {
        // PowerShellまたはcmdからPATHを取得（より確実）
        const cmdPath = execSync('powershell -Command "[Environment]::GetEnvironmentVariable(\'Path\', \'Machine\') + \';\' + [Environment]::GetEnvironmentVariable(\'Path\', \'User\')"', {
          encoding: 'utf8',
          timeout: 5000
        }).trim();
        if (cmdPath) {
          systemPath = cmdPath;
        }
      } catch (e) {
        // フォールバック: 既存のprocess.env.PATHを使用
        console.warn('Failed to get system PATH, using process.env.PATH:', e.message);
      }
    }

    // 必要なパスを優先的に追加（存在確認付き）
    const priorityPaths = [];

    // pyenvのshimを最初に追加
    if (await fs.pathExists(pyenvShims).catch(() => false)) {
      priorityPaths.push(pyenvShims);
    }

    if (process.platform === 'win32') {
      // Windowsの一般的なffmpegインストール場所をチェック
      const commonFfmpegPaths = [
        'C:\\ffmpeg\\bin',
        'C:\\Program Files\\ffmpeg\\bin',
        'C:\\Program Files (x86)\\ffmpeg\\bin',
        path.join(homeDir, 'AppData', 'Local', 'ffmpeg', 'bin'),
        'C:\\ProgramData\\chocolatey\\bin', // Chocolatey
        'C:\\tools\\ffmpeg\\bin',
        path.join(homeDir, 'ffmpeg', 'bin')
      ];

      for (const ffmpegPath of commonFfmpegPaths) {
        if (await fs.pathExists(ffmpegPath).catch(() => false)) {
          priorityPaths.push(ffmpegPath);
        }
      }

      // Windowsのシステムパスも追加
      priorityPaths.push(
        'C:\\Windows\\System32',
        'C:\\Windows',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'
      );
    } else {
      // Homebrewのパスを追加（Apple Silicon優先）
      if (await fs.pathExists('/opt/homebrew/bin').catch(() => false)) {
        priorityPaths.push('/opt/homebrew/bin')
      }
      if (await fs.pathExists('/usr/local/bin').catch(() => false)) {
        priorityPaths.push('/usr/local/bin')
      }

      // システムパスを追加
      priorityPaths.push('/usr/bin', '/bin')
    }

    // 既存のPATHから重複を除いて追加
    const existingPaths = systemPath.split(path.delimiter).filter(p => p && !priorityPaths.includes(p));

    // 最終的なPATHを構築
    const enhancedPath = [...priorityPaths, ...existingPaths].join(path.delimiter);

    console.log(`Enhanced PATH: ${enhancedPath}`);
    console.log(`System PATH: ${systemPath}`);

    return new Promise((resolve) => {
      // パスを絶対パスに変換して正規化（Windowsのパス問題を回避）
      const normalizedAudioPath = path.resolve(audioFilePath).replace(/\\/g, path.sep);
      const normalizedTextDir = path.resolve(textDir).replace(/\\/g, path.sep);
      const normalizedScript = path.resolve(transcribeScript).replace(/\\/g, path.sep);

      console.log(`Normalized audio path: ${normalizedAudioPath}`);
      console.log(`Normalized text dir: ${normalizedTextDir}`);
      console.log(`Normalized script: ${normalizedScript}`);

      const pythonProcess = spawn(pythonCmd, [...pythonCmdPrefixArgs, normalizedScript, normalizedAudioPath, '-o', normalizedTextDir], {
        cwd: app.isPackaged ? path.dirname(normalizedScript) : __dirname,
        env: {
          ...process.env,
          PATH: enhancedPath,
          PYTHONIOENCODING: 'utf-8'  // Pythonの出力をUTF-8に強制
        },
        encoding: 'utf8'  // Node.js側でもUTF-8として処理
      });

      let stdout = '';
      let stderr = '';

      pythonProcess.stdout.on('data', (data) => {
        // UTF-8として正しくデコード（文字化けを防ぐ）
        let decoded;
        if (Buffer.isBuffer(data)) {
          // まずUTF-8を試す
          try {
            decoded = data.toString('utf8');
          } catch (e) {
            // UTF-8でデコードできない場合は、CP932を試す（Windowsの場合）
            if (process.platform === 'win32') {
              try {
                decoded = data.toString('shift_jis');
              } catch (e2) {
                // どちらも失敗した場合は、UTF-8で無理やりデコード（文字化けする可能性あり）
                decoded = data.toString('utf8');
              }
            } else {
              decoded = data.toString('utf8');
            }
          }
        } else {
          decoded = String(data);
        }
        stdout += decoded;
        console.log('Python stdout:', decoded);
      });

      pythonProcess.stderr.on('data', (data) => {
        // UTF-8として正しくデコード（文字化けを防ぐ）
        let decoded;
        if (Buffer.isBuffer(data)) {
          // まずUTF-8を試す
          try {
            decoded = data.toString('utf8');
          } catch (e) {
            // UTF-8でデコードできない場合は、CP932を試す（Windowsの場合）
            if (process.platform === 'win32') {
              try {
                decoded = data.toString('shift_jis');
              } catch (e2) {
                // どちらも失敗した場合は、UTF-8で無理やりデコード（文字化けする可能性あり）
                decoded = data.toString('utf8');
              }
            } else {
              decoded = data.toString('utf8');
            }
          }
        } else {
          decoded = String(data);
        }
        stderr += decoded;
        console.error('Python stderr:', decoded);
      });

      pythonProcess.on('close', async (code) => {
        console.log(`Python process exited with code: ${code}`);

        if (code === 0) {
          // 成功時に出力ファイルの存在を確認
          if (await fs.pathExists(outputFilePath)) {
            resolve({
              success: true,
              message: 'Transcription completed successfully',
              outputPath: outputFilePath,
              stdout: stdout
            });
          } else {
            resolve({
              success: false,
              message: 'Transcription completed but output file not found',
              stderr: stderr,
              stdout: stdout
            });
          }
        } else {
          console.error(`Transcription failed with exit code ${code}`);
          console.error(`stderr: ${stderr}`);
          console.error(`stdout: ${stdout}`);

          // エラーメッセージを解析して、より分かりやすいメッセージを生成
          // stderrとstdoutの両方を確認
          const combinedError = (stderr + '\n' + stdout).toLowerCase();
          let errorMessage = `文字起こしに失敗しました`;

          if (stderr.includes('ModuleNotFoundError') && stderr.includes('whisper')) {
            // 使用しているPythonパスを特定して、その環境にインストールするように案内
            const pythonVersion = pythonCmdDisplay
            const pipCommand = process.platform === 'win32' ? 'py -m pip' : (pythonCmd.includes('python3') ? 'pip3' : 'pip')

            if (process.platform === 'win32') {
              errorMessage = `whisperモジュールが見つかりません。\n\nアプリが使用しているPython: ${pythonCmdDisplay}\n\n以下のコマンドで、このPython環境にインストールしてください：\n\n${pipCommand} install openai-whisper\n\nまたは\n\n${pythonVersion} -m pip install openai-whisper\n\n注意: 複数のPython環境がある場合、アプリが使用しているPython環境にインストールする必要があります。\n\nrequirements.txtがある場合は、以下のコマンドでもインストールできます：\n\n${pipCommand} install -r requirements.txt`;
            } else {
              errorMessage = `whisperモジュールが見つかりません。\n\nアプリが使用しているPython: ${pythonCmdDisplay}\n\n以下のコマンドで、このPython環境にインストールしてください：\n\n${pipCommand} install openai-whisper\n\nまたは\n\n${pythonVersion} -m pip install openai-whisper\n\n注意: 複数のPython環境がある場合、アプリが使用しているPython環境にインストールする必要があります。\n\nrequirements.txtがある場合は、以下のコマンドでもインストールできます：\n\n${pipCommand} install -r requirements.txt`;
            }
          } else if ((stderr.includes('No such file or directory') && stderr.includes('ffmpeg')) ||
                     (stderr.includes('WinError 2') && process.platform === 'win32') ||
                     (stderr.includes('WinError') && stderr.includes('2') && process.platform === 'win32')) {
            // WinError 2は「ファイルが見つかりません」エラーで、ffmpegが見つからない場合に発生
            // 文字化けしていても、WinError 2が含まれていればffmpegの問題の可能性が高い
            if (process.platform === 'win32') {
              errorMessage = `ffmpegが見つかりません。\n\nwhisperは音声ファイルを処理するためにffmpegが必要です。\n\n以下の手順でインストールしてください：\n\n1. https://ffmpeg.org/download.html からダウンロード\n2. または、chocolateyを使用している場合：\n\n   choco install ffmpeg\n\n3. インストール後、PATH環境変数にffmpegのパスを追加してください。\n4. インストール後、アプリを再起動して再度お試しください。`;
            } else if (process.platform === 'darwin') {
              errorMessage = `ffmpegが見つかりません。\n\nwhisperは音声ファイルを処理するためにffmpegが必要です。\n\n以下のコマンドでインストールしてください：\n\nbrew install ffmpeg\n\nまたは、Homebrewがインストールされていない場合は：\n\nhttps://ffmpeg.org/download.html からダウンロードしてください`;
            } else {
              errorMessage = `ffmpegが見つかりません。\n\nwhisperは音声ファイルを処理するためにffmpegが必要です。\n\n以下のコマンドでインストールしてください：\n\nsudo apt-get install ffmpeg\n\nまたは\n\nsudo yum install ffmpeg\n\nまたは、https://ffmpeg.org/download.html からダウンロードしてください`;
            }
          } else if (stderr.includes('ModuleNotFoundError')) {
            const moduleMatch = stderr.match(/No module named '([^']+)'/);
            if (moduleMatch) {
              const moduleName = moduleMatch[1];
              const pipCommand = process.platform === 'win32' ? 'pip' : 'pip3';
              errorMessage = `${moduleName}モジュールが見つかりません。\n\n以下のコマンドでインストールしてください：\n\n${pipCommand} install ${moduleName}\n\nまたは、requirements.txtがある場合は：\n\n${pipCommand} install -r requirements.txt`;
            }
          } else if (combinedError.includes('python') || stderr.includes('Python') || stderr.includes('python') || stdout.includes('Python') || stdout.includes('python')) {
            // Python関連のエラー
            if (combinedError.includes('command not found') || combinedError.includes('not found') || combinedError.includes('spawn') || combinedError.includes('enoent')) {
              if (process.platform === 'win32') {
                errorMessage = `Pythonが見つかりません。\n\n以下の手順でPythonをインストールしてください：\n\n1. https://www.python.org/downloads/ からPythonをダウンロード\n2. インストール時に「Add Python to PATH」にチェックを入れる\n3. インストール後、以下のコマンドで必要なモジュールをインストール：\n\n   pip install openai-whisper\n\n   または、requirements.txtがある場合は：\n\n   pip install -r requirements.txt`;
              } else {
                errorMessage = `Pythonが見つかりません。\n\n以下のコマンドでPythonをインストールしてください：\n\n${process.platform === 'darwin' ? 'brew install python3' : 'sudo apt-get install python3 python3-pip'}\n\nインストール後、以下のコマンドで必要なモジュールをインストール：\n\npip3 install openai-whisper\n\nまたは、requirements.txtがある場合は：\n\npip3 install -r requirements.txt`;
              }
            } else {
              // Python関連のエラーだが、詳細が不明な場合
              if (process.platform === 'win32') {
                errorMessage = `文字起こしに失敗しました（Python関連のエラー）\n\nエラー詳細: ${stderr || stdout}\n\nPythonが正しくインストールされ、PATHに登録されているか確認してください。\n\n必要なモジュールをインストールするには：\n\n   pip install openai-whisper\n\n   または\n\n   pip install -r requirements.txt`;
              } else {
                errorMessage = `文字起こしに失敗しました（Python関連のエラー）\n\nエラー詳細: ${stderr || stdout}\n\nPythonが正しくインストールされ、PATHに登録されているか確認してください。\n\n必要なモジュールをインストールするには：\n\n   pip3 install openai-whisper\n\n   または\n\n   pip3 install -r requirements.txt`;
              }
            }
          } else if (stderr) {
            errorMessage = `文字起こしに失敗しました: ${stderr}`;
          } else if (stdout && stdout.includes('エラー') || stdout.includes('error')) {
            errorMessage = `文字起こしに失敗しました: ${stdout}`;
          } else {
            errorMessage = `文字起こしに失敗しました（終了コード: ${code}）\n\nPythonと必要なモジュールがインストールされているか確認してください。\n\nエラー詳細:\n${stderr || stdout || '詳細情報なし'}`;
          }

          resolve({
            success: false,
            message: errorMessage,
            stderr: stderr,
            stdout: stdout,
            exitCode: code
          });
        }
      });

      pythonProcess.on('error', (error) => {
        console.error('Failed to start python process:', error);

        let errorMessage = `Pythonの実行に失敗しました。\n\n`;

        // Pythonが見つからない場合
        if (error.message.includes('spawn') && error.message.includes('ENOENT')) {
          if (process.platform === 'win32') {
            errorMessage += `Pythonがインストールされていないか、PATHに登録されていません。\n\n`;
            errorMessage += `以下の手順でPythonをインストールしてください：\n\n`;
            errorMessage += `1. https://www.python.org/downloads/ からPythonをダウンロード\n`;
            errorMessage += `2. インストール時に「Add Python to PATH」にチェックを入れる\n`;
            errorMessage += `3. インストール後、以下のコマンドで必要なモジュールをインストール：\n\n`;
            errorMessage += `   pip install openai-whisper\n\n`;
            errorMessage += `または、requirements.txtがある場合は：\n\n`;
            errorMessage += `   pip install -r requirements.txt\n`;
          } else if (process.platform === 'darwin') {
            errorMessage += `Pythonがインストールされていないか、PATHに登録されていません。\n\n`;
            errorMessage += `以下のコマンドでPythonをインストールしてください：\n\n`;
            errorMessage += `brew install python3\n\n`;
            errorMessage += `インストール後、以下のコマンドで必要なモジュールをインストール：\n\n`;
            errorMessage += `pip3 install openai-whisper\n\n`;
            errorMessage += `または、requirements.txtがある場合は：\n\n`;
            errorMessage += `pip3 install -r requirements.txt\n`;
          } else {
            errorMessage += `Pythonがインストールされていないか、PATHに登録されていません。\n\n`;
            errorMessage += `以下のコマンドでPythonをインストールしてください：\n\n`;
            errorMessage += `sudo apt-get install python3 python3-pip\n\n`;
            errorMessage += `インストール後、以下のコマンドで必要なモジュールをインストール：\n\n`;
            errorMessage += `pip3 install openai-whisper\n\n`;
            errorMessage += `または、requirements.txtがある場合は：\n\n`;
            errorMessage += `pip3 install -r requirements.txt\n`;
          }
        } else {
          errorMessage += `エラー詳細: ${error.message}\n\n`;
          errorMessage += `PythonのインストールとPATHの設定を確認してください。`;
        }

        resolve({
          success: false,
          message: errorMessage,
          error: error.message
        });
      });
    });

  } catch (error) {
    console.error('Error in transcribe-audio handler:', error);

    let errorMessage = `文字起こしに失敗しました。\n\n`;

    // エラーメッセージに「Python」が含まれている場合
    if (error.message.includes('Python') || error.message.includes('python')) {
      if (process.platform === 'win32') {
        errorMessage += `Pythonがインストールされていないか、PATHに登録されていません。\n\n`;
        errorMessage += `以下の手順でPythonをインストールしてください：\n\n`;
        errorMessage += `1. https://www.python.org/downloads/ からPythonをダウンロード\n`;
        errorMessage += `2. インストール時に「Add Python to PATH」にチェックを入れる\n`;
        errorMessage += `3. インストール後、以下のコマンドで必要なモジュールをインストール：\n\n`;
        errorMessage += `   pip install openai-whisper\n\n`;
        errorMessage += `または、requirements.txtがある場合は：\n\n`;
        errorMessage += `   pip install -r requirements.txt\n`;
      } else if (process.platform === 'darwin') {
        errorMessage += `Pythonがインストールされていないか、PATHに登録されていません。\n\n`;
        errorMessage += `以下のコマンドでPythonをインストールしてください：\n\n`;
        errorMessage += `brew install python3\n\n`;
        errorMessage += `インストール後、以下のコマンドで必要なモジュールをインストール：\n\n`;
        errorMessage += `pip3 install openai-whisper\n\n`;
        errorMessage += `または、requirements.txtがある場合は：\n\n`;
        errorMessage += `pip3 install -r requirements.txt\n`;
      } else {
        errorMessage += `Pythonがインストールされていないか、PATHに登録されていません。\n\n`;
        errorMessage += `以下のコマンドでPythonをインストールしてください：\n\n`;
        errorMessage += `sudo apt-get install python3 python3-pip\n\n`;
        errorMessage += `インストール後、以下のコマンドで必要なモジュールをインストール：\n\n`;
        errorMessage += `pip3 install openai-whisper\n\n`;
        errorMessage += `または、requirements.txtがある場合は：\n\n`;
        errorMessage += `pip3 install -r requirements.txt\n`;
      }
    } else {
      errorMessage += `エラー詳細: ${error.message}\n\n`;
      errorMessage += `Pythonと必要なモジュールがインストールされているか確認してください。`;
    }

    return {
      success: false,
      message: errorMessage,
      error: error.message
    };
  }
});

// ファイル存在確認
ipcMain.handle('check-file-exists', async (event, path) => {
  try {
    return await fs.pathExists(path);
  } catch (error) {
    console.error('Check file exists error:', error);
    return false;
  }
});

// 設定ファイル取扱
ipcMain.handle('get-config', async (event, key) => {
  try {
    initPaths()
    let config = null

    if (await fs.pathExists(configPath)) {
      config = await fs.readJson(configPath)
    } else {
      // dev/buildで userData が変わる場合があるため、legacy config も探す
      for (const dir of getCandidateUserDataDirs()) {
        const candidate = path.join(dir, 'config.json')
        if (path.normalize(candidate) === path.normalize(configPath)) continue
        if (await fs.pathExists(candidate)) {
          config = await fs.readJson(candidate)
          console.log(`Loaded legacy config from: ${candidate}`)
          break
        }
      }
    }

    if (!config) return null

    if (!key) return config

    if (key === 'standfmDefaultImage') {
      return await resolveStandfmDefaultImagePath(config[key])
    }

    return config[key]
  } catch (error) {
    console.error('Error reading config:', error);
    return null;
  }
});

ipcMain.handle('set-config', async (event, key, value) => {
  try {
    initPaths()
    const config = await fs.pathExists(configPath) ? await fs.readJson(configPath) : {};
    config[key] = value;
    await fs.writeJson(configPath, config);
    return true;
  } catch (error) {
    console.error('Error writing config:', error);
    return false;
  }
});

// Stand.fm放送画像の保存
ipcMain.handle('save-broadcast-image', async (event, originalPath) => {
  try {
    return await saveBroadcastImageInternal(originalPath)
  } catch (error) {
    console.error('Failed to save broadcast image:', error);
    return { success: false, error: error.message };
  }
});

function createResponseWaiter(page, predicate, options = {}) {
  const includeBody = options.includeBody === true
  let done = false
  let resolved = false
  let result = null

  const listener = async (res) => {
    if (done) return
    try {
      if (!predicate(res)) return
      done = true
      resolved = true
      const req = res.request()
      result = {
        url: res.url(),
        status: res.status(),
        ok: res.ok(),
        method: req && req.method ? req.method() : null,
        type: req && req.resourceType ? req.resourceType() : null,
        contentType: res.headers ? (res.headers()['content-type'] || null) : null
      }

      // 200でも黒画像になるケースがあるため、可能ならレスポンス本文も残す
      if (includeBody) {
        try {
          const text = await res.text()
          if (text) {
            result.body = text.length > 800 ? `${text.slice(0, 800)}...(truncated)` : text
          }
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      // ignore
    }
  }

  page.on('response', listener)

  const wait = async (timeoutMs, label = 'response waiter') => {
    const start = Date.now()
    while (!done && Date.now() - start < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    if (!done) {
      throw new Error(`${label}: timeout ${timeoutMs}ms`)
    }
    return result
  }

  const dispose = async () => {
    try {
      page.off('response', listener)
    } catch (e) {
      // ignore
    }
  }

  return {
    wait,
    dispose,
    isResolved: () => resolved,
    getResult: () => result
  }
}

async function waitForStandfmImagePreview(page, timeoutMs) {
  try {
    await page.waitForFunction(() => {
      const imgs = Array.from(document.querySelectorAll('img'))
      const blobImg = imgs.find(img => {
        const src = img.getAttribute('src') || ''
        return src.startsWith('blob:') && src.includes('stand.fm')
      })
      if (blobImg) return true

      // フォールバック: stand.fm ではプレビューが blob になることが多い
      const anyBlob = imgs.find(img => (img.getAttribute('src') || '').startsWith('blob:'))
      return Boolean(anyBlob)
    }, { timeout: timeoutMs })
    return true
  } catch (e) {
    return false
  }
}

async function getFileInputsSnapshot(page) {
  try {
    const inputs = await page.$$('input[type="file"]')
    const data = []
    for (const input of inputs) {
      const item = await page.evaluate(el => ({
        accept: el.accept || null,
        name: el.name || null,
        id: el.id || null,
        className: el.className || null,
        multiple: Boolean(el.multiple)
      }), input)
      data.push(item)
    }
    return data
  } catch (e) {
    return []
  }
}

async function findStandfmImageFileInput(page) {
  // まず accept に拡張子が含まれているパターンを狙う（.jpeg,.jpg,.png など）
  let input = await page.$('input[type="file"][accept*=".png"]')
  if (!input) input = await page.$('input[type="file"][accept*=".jpg"]')
  if (!input) input = await page.$('input[type="file"][accept*=".jpeg"]')

  // その次に accept に image を含むパターン
  if (!input) input = await page.$('input[type="file"][accept*="image"]')

  // 最後に「audioではない file input」を探す
  if (!input) {
    const inputs = await page.$$('input[type="file"]')
    for (const cand of inputs) {
      const accept = await page.evaluate(el => el.accept || '', cand)
      if (!accept || !accept.includes('audio')) {
        input = cand
        break
      }
    }
  }

  return input
}

async function waitForStandfmImageFileInput(page, timeoutMs) {
  // Stand.fm は hydration 後に input が差し替わることがあるので、少し待ってから再探索する
  const selector = 'input[type="file"][accept*=".png"], input[type="file"][accept*=".jpg"], input[type="file"][accept*=".jpeg"], input[type="file"][accept*="image"], input[type="file"]:not([accept*="audio"])'
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs })
  } catch (e) {
    // ignore
  }
  return await findStandfmImageFileInput(page)
}

// Stand.fmに投稿
registerStandfmPublishHandler({
  ipcMain,
  fs,
  path,
  getPageInstance,
  getAppPaths,
  resolveStandfmDefaultImagePath,
  createResponseWaiter,
  findStandfmImageFileInput,
  waitForStandfmImageFileInput,
  waitForStandfmImagePreview,
  getFileInputsSnapshot
})

registerSpotifyPublishHandler({
  ipcMain,
  fs,
  path,
  getPageInstance,
  getAppPaths
})

// アプリバージョン取得
ipcMain.handle('get-app-version', async () => {
  try {
    const packageJsonPath = path.join(__dirname, 'package.json')
    const packageJson = await fs.readJson(packageJsonPath)
    return packageJson.version || '1.0.0'
  } catch (error) {
    console.error('Failed to get app version:', error)
    return '1.0.0'
  }
})