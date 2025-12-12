const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { spawn, execSync } = require('child_process');
const os = require('os');

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

// 音声ファイル一覧を取得
ipcMain.handle('get-audio-files', async () => {
  try {
    await ensureDirectories();
    const files = await fs.readdir(audioDir);

    const audioFiles = files.filter(file =>
      file.endsWith('.mp4') || file.endsWith('.m4a') ||
      file.endsWith('.wav') || file.endsWith('.mp3')
    );

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
        voicyPublishedDate: itemMetadata.voicyPublishedDate || null
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

// 音声ファイルを削除
ipcMain.handle('delete-audio-file', async (event, { basename, filename }) => {
  try {
    // ファイルパスの構築
    const audioPath = path.join(audioDir, filename);
    const textPath = path.join(textDir, basename + '.txt');
    const mdPath = path.join(mdDir, basename + '.md');

    // ファイルの削除 (存在する場合のみ)
    if (await fs.pathExists(audioPath)) await fs.remove(audioPath);
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

    globalBrowser = await puppeteer.launch(launchOptions);
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
    const page = await getPageInstance();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // bring browser to front? Puppeteer doesn't have a direct API for this,
    // but launching usually brings it up.
    return { success: true };
  } catch (error) {
    console.error('Error opening external URL with Puppeteer:', error);
    return { success: false, message: error.message };
  }
});

// Voicyに投稿
// Voicyに投稿
ipcMain.handle('publish-to-voicy', async (event, basename, broadcastTitle, chapterTitle, chapterUrl, hashtagsString, publishTime, publishDate, description) => {
  try {
    console.log(`Starting Voicy publish process for: ${basename}`);

    const finalChapterTitle = typeof chapterTitle === 'string' ? chapterTitle.trim() : ''
    const finalChapterUrl = chapterUrl; // 空の場合はスキップするためデフォルト値を設定しない
    const timeToPublish = publishTime || '06:00';
    const [publishHour, publishMinute] = timeToPublish.split(':');

    // 日付の処理
    let targetDateString = '';
    if (publishDate) {
      // YYYY-MM-DD -> YYYY/MM/DD
      targetDateString = publishDate.replace(/-/g, '/');
    } else {
      // ファイル名から日付を取得（フォールバック）
      const datePrefix = basename.substring(0, 8);
      if (datePrefix.length === 8 && /^\d{8}$/.test(datePrefix)) {
        const year = datePrefix.substring(0, 4);
        const month = datePrefix.substring(4, 6);
        const day = datePrefix.substring(6, 8);
        targetDateString = `${year}/${month}/${day}`;
      }
    }

    // ハッシュタグの処理 (カンマ区切りまたはスペース区切りに対応)
    let hashtags = [];
    if (hashtagsString && typeof hashtagsString === 'string') {
      // 全角スペースを半角に置換し、カンマもスペースに置換してから分割
      hashtags = hashtagsString.replace(/、/g, ' ').replace(/,/g, ' ').replace(/　/g, ' ').split(/\s+/).filter(tag => tag.trim() !== '');
    }

    // 放送タイトルを取得（引数で渡されたもの優先、なければMD、なければファイル名から）
    let title = broadcastTitle;

    if (!title) {
      // MDファイルからタイトルを取得
      const mdFile = path.join(mdDir, basename + '.md');
      if (await fs.pathExists(mdFile)) {
        try {
          const mdContent = await fs.readFile(mdFile, 'utf8');
          const h1Match = mdContent.match(/^# (.+)$/m);
          if (h1Match) {
            title = h1Match[1].trim();
          }
        } catch (error) {
          console.error(`Error reading MD file ${basename}:`, error);
        }
      }
    }

    // MDファイルからタイトルが取得できなかった場合は、ファイル名を使用
    if (!title) {
      // yyyyMMdd_ の形式を取り除く
      const nameMatch = basename.match(/^\d{8}_(.+)$/);
      if (nameMatch) {
        title = nameMatch[1];
      } else {
        title = basename;
      }
    }

    // 既存のページインスタンスを取得または新規作成
    const page = await getPageInstance();

    console.log('Navigating to Voicy CMS...');

    // Voicy CMSにアクセス（既存のページを再利用）
    await page.goto('https://va-cms.admin.voicy.jp/playlist/new', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    console.log('Successfully accessed Voicy CMS');

    // 放送タイトル入力欄を探してタイトルを入力
    if (title) {
      await page.waitForSelector('input[formcontrolname="playlistName"]', { timeout: 30000 });

      // 既存のタイトルをクリア
      await page.evaluate(() => {
        const titleInput = document.querySelector('input[formcontrolname="playlistName"]');
        if (titleInput) {
          titleInput.value = '';
          titleInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });

      // タイトルを入力
      await page.type('input[formcontrolname="playlistName"]', title);
      console.log(`Broadcast title set to: ${title}`);
    }

    // 放送内容の説明（概要）を入力
    if (description) {
      try {
        await page.waitForSelector('textarea[formcontrolname="description"]', { timeout: 10000 });

        // 既存の内容をクリア
        await page.evaluate(() => {
          const descInput = document.querySelector('textarea[formcontrolname="description"]');
          if (descInput) {
            descInput.value = '';
            descInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
        });

        // 説明を入力
        await page.type('textarea[formcontrolname="description"]', description);
        console.log('Broadcast description set');
      } catch (e) {
        console.warn('Could not set description:', e.message);
      }
    }

    // ハッシュタグを入力
    if (hashtags.length > 0) {
      const hashtagInput = await page.waitForSelector('.hashtag-input', { timeout: 30000 });

      for (const hashtag of hashtags) {
        await hashtagInput.click();
        await hashtagInput.type(hashtag);
        await page.keyboard.press('Enter');
        console.log(`Hashtag added: ${hashtag}`);

        // 次のハッシュタグ入力のために少し待機
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      console.log('All hashtags added successfully');
    }

    // チャプター名の入力欄を探す
    await page.waitForSelector('input[formcontrolname="title"]', { timeout: 30000 });

    // チャプタータイトルが空の場合は、デフォルト値（例: チャプター1）を維持するため入力を変更しない
    if (finalChapterTitle) {
      // 既存のチャプター内容をクリア
      await page.evaluate(() => {
        const chapterInput = document.querySelector('input[formcontrolname="title"]')
        if (chapterInput) {
          chapterInput.value = ''
          chapterInput.dispatchEvent(new Event('input', { bubbles: true }))
        }
      })

      // 新しいチャプター内容を入力
      await page.type('input[formcontrolname="title"]', finalChapterTitle)

      console.log(`Chapter content updated successfully: ${finalChapterTitle}`)
    } else {
      console.log('Chapter title is empty. Keeping existing chapter title value')
    }

    // URL追加ボタンをクリック（URLがある場合のみ）
    if (finalChapterUrl) {
      await page.waitForSelector('.chapter-actions', { timeout: 30000 });

      // より簡潔なアプローチで直接ボタンをクリック
      await page.evaluate(() => {
        const buttons = document.querySelectorAll('.chapter-actions button');
        for (const button of buttons) {
          const span = button.querySelector('span');
          if (span && span.textContent.trim() === 'URL追加') {
            button.click();
            return;
          }
        }
        throw new Error('URL add button not found');
      });

      console.log('URL add button clicked');

      // URLモーダルが表示されるまで待機
      await page.waitForSelector('input[name="addUrl"]', { timeout: 30000 });

      // URLを入力
      await page.type('input[name="addUrl"]', finalChapterUrl);
      console.log(`URL entered: ${finalChapterUrl}`);

      // 少し待ってから適用ボタンをクリック
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 適用ボタンをクリック
      const applyButton = await page.waitForSelector('.modal-footer .btn-primary', { timeout: 30000 });
      await applyButton.click();
      console.log('Apply button clicked - URL added successfully');

      // URLモーダルが閉じるまで少し待機
      await new Promise(resolve => setTimeout(resolve, 1000));
    } else {
      console.log('URL is empty, skipping URL addition.');
    }

    // 音声アップロードボタンをクリック
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('.chapter-actions button');
      for (const button of buttons) {
        const span = button.querySelector('span');
        if (span && span.textContent.trim() === '音声アップロード') {
          button.click();
          return;
        }
      }
      throw new Error('Audio upload button not found');
    });

    console.log('Audio upload button clicked');

    // アップロードモーダルが表示されるまで待機
    await page.waitForSelector('input[type="file"][accept="audio/*"]', { timeout: 30000 });

    // 対応するmp4ファイルのパスを構築
    let audioFilePath = path.join(audioDir, basename + '.mp4');

    // ファイルが存在するかチェック
    if (!(await fs.pathExists(audioFilePath))) {
      // .mp4が存在しない場合は.m4aを試す
      const m4aFilePath = path.join(audioDir, basename + '.m4a');
      if (await fs.pathExists(m4aFilePath)) {
        audioFilePath = m4aFilePath;
      } else {
        throw new Error(`Audio file not found: ${basename}.mp4 or ${basename}.m4a`);
      }
    }

    console.log(`Uploading audio file: ${audioFilePath}`);

    // ファイルをアップロード
    const fileInput = await page.$('input[type="file"][accept="audio/*"]');
    await fileInput.uploadFile(audioFilePath);

    console.log('Audio file uploaded successfully');

    // アップロードが完了するまで少し待機
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 「日時を指定して予約」ボタンをクリック
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const button of buttons) {
        if (button.textContent.includes('日時を指定して予約')) {
          button.click();
          return;
        }
      }
      throw new Error('Reserve button not found');
    });

    console.log('Reserve button clicked');

    // 予約設定モーダルが表示されるまで待機
    await page.waitForSelector('.app-date-input', { timeout: 30000 });

    if (!targetDateString) {
      throw new Error(`Invalid date format for publish date. Basename: ${basename}`);
    }

    // 日付入力欄に日付を設定
    const dateInput = await page.$('.app-date-input__setting-date__wrapper__input');
    await dateInput.click();
    await page.evaluate(() => {
      const input = document.querySelector('.app-date-input__setting-date__wrapper__input');
      if (input) {
        input.value = '';
      }
    });
    await dateInput.type(targetDateString);
    console.log(`Date set to: ${targetDateString}`);

    // 時間を設定
    const hourInput = await page.$('input[placeholder="HH"]');
    const minuteInput = await page.$('input[placeholder="MM"]');

    await hourInput.click();
    await page.evaluate(() => {
      const input = document.querySelector('input[placeholder="HH"]');
      if (input) {
        input.value = '';
      }
    });
    await hourInput.type(publishHour);

    await minuteInput.click();
    await page.evaluate(() => {
      const input = document.querySelector('input[placeholder="MM"]');
      if (input) {
        input.value = '';
      }
    });
    await minuteInput.type(publishMinute);

    console.log(`Time set to: ${publishHour}:${publishMinute}`);

    // 少し待ってから予約ボタンをクリック
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Alertダイアログの「OK」ボタンを自動で押すためのリスナーを設定
    page.on('dialog', async dialog => {
      console.log(`Dialog appeared: ${dialog.message()}`);
      if (dialog.type() === 'confirm') {
        await dialog.accept();
        console.log('Dialog accepted (OK clicked)');
      }
    });

    // 「指定の日時で予約」ボタンをクリック
    const reserveConfirmButton = await page.waitForSelector('#reserve-playlist-button', { timeout: 30000 });
    await reserveConfirmButton.click();

    console.log('Reservation confirmed successfully');

    // Alertが表示されて処理されるまで少し待機
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Voicy投稿完了をメタデータに保存
    const metadata = await fs.pathExists(metadataPath) ? await fs.readJson(metadataPath) : {};
    if (!metadata[basename]) {
      metadata[basename] = {};
    }
    metadata[basename].voicyPublished = true;
    metadata[basename].voicyPublishedDate = new Date().toISOString();

    await fs.writeJson(metadataPath, metadata, { spaces: 2 });
    console.log(`Voicy published status saved for: ${basename}`);

    return {
      success: true,
      message: 'Voicy投稿が完了し、ステータスを保存しました。',
      browser: true
    };

  } catch (error) {
    console.error('Error publishing to Voicy:', error);

    return {
      success: false,
      message: `Voicy投稿でエラーが発生しました: ${error.message}`
    };
  }
});



// 文字起こし実行
ipcMain.handle('transcribe-audio', async (event, basename) => {
  console.log('Transcribing audio for:', basename);

  try {
    // ファイル名から拡張子を除去
    const nameWithoutExt = path.parse(basename).name;

    // 対応可能な音声ファイル拡張子
    const audioExtensions = ['.m4a', '.mp4', '.wav', '.mp3'];

    // 実際のファイルを探す（拡張子付きのbasenameまたは拡張子なしbasename + 拡張子）
    let audioFilePath = null;

    // まず、basenameがそのままファイル名として存在するか確認
    const directPath = path.join(audioDir, basename);
    if (await fs.pathExists(directPath)) {
      audioFilePath = directPath;
    } else {
      // 拡張子なしbasename + 各拡張子で確認
      for (const ext of audioExtensions) {
        const testPath = path.join(audioDir, nameWithoutExt + ext);
        if (await fs.pathExists(testPath)) {
          audioFilePath = testPath;
          break;
        }
      }
    }

    // ファイルの存在確認
    if (!audioFilePath) {
      throw new Error(`Audio file not found for: ${basename} (checked: ${basename} and ${nameWithoutExt} with extensions ${audioExtensions.join(', ')})`);
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
ipcMain.handle('publish-to-standfm', async (event, basename, description, bgm, publishDate, publishTime, category, imagePath, broadcastTitle) => {
  try {
    console.log(`Starting Stand.fm publish process for: ${basename}`);
    const debugStandfmImage = process.env.VUT_DEBUG_STANDFM_IMAGE === '1'

    // タイトルの決定: 引数で渡されたものを優先、なければMDファイルから取得
    let title = broadcastTitle || '';

    if (!title) {
      // MDファイルからタイトルを取得し、basenameから日付を抽出
      const mdFile = path.join(mdDir, basename + '.md');
      if (await fs.pathExists(mdFile)) {
        try {
          const mdContent = await fs.readFile(mdFile, 'utf8');
          const h1Match = mdContent.match(/^# (.+)$/m);
          if (h1Match) {
            title = h1Match[1].trim();
          }
        } catch (error) {
          console.error(`Error reading MD file ${basename}:`, error);
        }
      }
    }

    // basenameから日付を抽出 (例: 20250808_website_speed → 2025-08-08)
    // UI指定があればそれを優先
    let targetDate = new Date();

    if (publishDate) {
      targetDate = new Date(publishDate);
      console.log(`Target publish date from UI: ${publishDate}`);
    } else {
      const dateMatch = basename.match(/^(\d{4})(\d{2})(\d{2})/);
      if (dateMatch) {
        const year = parseInt(dateMatch[1]);
        const month = parseInt(dateMatch[2]) - 1; // Dateオブジェクトは0ベース
        const day = parseInt(dateMatch[3]);
        targetDate = new Date(year, month, day);
        console.log(`Target publish date from filename: ${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
      } else {
        console.log('No date found in filename, using today');
      }
    }

    // 既存のページインスタンスを取得または新規作成
    const page = await getPageInstance();

    console.log('Navigating to Stand.fm upload page...');

    // Stand.fmの投稿ページにアクセス
    await page.goto('https://stand.fm/episodes/new', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    console.log('Successfully accessed Stand.fm upload page');

    // 放送画像のアップロード (imagePathがある場合のみ)
    let standfmImageUploadWaiter = null
    let standfmImageInput = null
    let standfmImageSelected = false

    // build/devで userData が変わり、renderer が古いパスを持っているケースもあるため
    // ここでも最終的に使うパスを解決する
    const resolvedImagePath = await resolveStandfmDefaultImagePath(imagePath)

    if (resolvedImagePath) {
      const normalizedPath = path.normalize(resolvedImagePath)
      const exists = await fs.pathExists(normalizedPath)
      console.log(`Stand.fm imagePath received: ${resolvedImagePath} -> ${normalizedPath} (exists=${exists})`)

      if (exists) {
        console.log(`[Stand.fm image] initial: ${normalizedPath} (exists=${exists})`)

        if (debugStandfmImage) {
          const fileInputs = await getFileInputsSnapshot(page)
          console.log('Detected file inputs on stand.fm page:', fileInputs)
        }

        // 画像アップロードのネットワークは即時ではなく「公開クリック時」に走ることがあるため、
        // 先に watcher を仕込んでおき、後段でも確認できるようにする
        standfmImageUploadWaiter = createResponseWaiter(page, (res) => {
          const url = res.url()
          if (!url) return false
          if (!url.includes('stand.fm')) return false
          if (!url.includes('/api/episodes/upload/image')) return false
          const req = res.request()
          if (!req) return false
          return req.method() === 'POST'
        }, { includeBody: debugStandfmImage })

        try {
          standfmImageInput = await findStandfmImageFileInput(page)
          if (!standfmImageInput) {
            // ビルド版で「input not found」になりやすいので、数秒待って再探索
            standfmImageInput = await waitForStandfmImageFileInput(page, 8000)
          }
          if (!standfmImageInput) {
            console.log('[Stand.fm image] input not found')
            if (!debugStandfmImage) {
              // 通常時でも最低限の診断ログ（input が無い/変わった時の切り分け用）
              const fileInputs = await getFileInputsSnapshot(page)
              console.log('Detected file inputs on stand.fm page:', fileInputs)
            }
          } else {
            await standfmImageInput.uploadFile(normalizedPath)
            const selected = await page.evaluate(el => Boolean(el.files && el.files.length > 0), standfmImageInput)
            console.log(`[Stand.fm image] initial: upload done. input.files.length>0: ${selected}`)
            standfmImageSelected = Boolean(selected)

            // 通常運用ではここで待たない（時間が無駄になりやすい）
            // 必要なら VUT_DEBUG_STANDFM_IMAGE=1 で確認用ログを増やす
            if (debugStandfmImage) {
              const previewOk = await waitForStandfmImagePreview(page, 6000)
              console.log(`[Stand.fm image] initial: preview detected=${previewOk}`)
            }
          }
        } catch (uploadError) {
          console.error('Error uploading image:', uploadError)
        }
      } else {
        console.log('No valid image path provided, skipping image upload')
      }
    } else {
      console.log('No image path provided, skipping image upload')
    }

    // 音源アップロードボタンを探してクリック
    await page.waitForSelector('input[type="file"][accept*="audio"]', { timeout: 30000 });
    console.log('Found audio upload input');

    // 対応するmp4ファイルのパスを構築
    let audioFilePath = path.join(audioDir, basename + '.mp4');

    // ファイルが存在するかチェック
    if (!(await fs.pathExists(audioFilePath))) {
      // .mp4が存在しない場合は.m4aを試す
      const m4aFilePath = path.join(audioDir, basename + '.m4a');
      if (await fs.pathExists(m4aFilePath)) {
        audioFilePath = m4aFilePath;
      } else {
        throw new Error(`Audio file not found: ${basename}.mp4 or ${basename}.m4a`);
      }
    }

    console.log(`Uploading audio file: ${audioFilePath}`);

    // ファイルをアップロード
    const fileInput = await page.$('input[type="file"][accept*="audio"]');
    await fileInput.uploadFile(audioFilePath);

    console.log('Audio file uploaded successfully');

    // 音源アップロード後に画像選択が外れるケースがあるので再確認し、外れていたら再セットする
    if (standfmImageInput) {
      try {
        const selectedAfterAudio = await page.evaluate(el => Boolean(el.files && el.files.length > 0), standfmImageInput)
        console.log(`[Stand.fm image] after audio upload: selected=${selectedAfterAudio}`)
        if (!selectedAfterAudio && imagePath && await fs.pathExists(imagePath)) {
          console.log('[Stand.fm image] after audio upload: re-uploading image because selection was cleared')
          await standfmImageInput.uploadFile(path.normalize(imagePath))
          const selectedAgain = await page.evaluate(el => Boolean(el.files && el.files.length > 0), standfmImageInput)
          console.log(`[Stand.fm image] after audio upload: selected=${selectedAgain}`)
        }
      } catch (e) {
        console.log(`[Stand.fm image] after audio upload: check failed: ${e.message}`)
      }
    }

    // アップロードが完了するまで少し待機
    await new Promise(resolve => setTimeout(resolve, 3000));



    // タイトルを入力
    if (title) {
      console.log('Setting title...');

      const titleInput = await page.$('input[placeholder*="タイトル"]');
      if (titleInput) {
        await titleInput.click();
        await titleInput.focus();

        // 既存の内容をクリア
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');

        await titleInput.type(title);
        console.log('Title set successfully');
      }
    }

    // 公開範囲を「全体に公開」に設定 - テキスト「公開範囲」で要素を特定
    console.log('Setting visibility to public...');
    try {
      // react-select-2のコントロール要素を直接操作
      const visibilityControl = await page.$('#react-select-2-input');

      if (visibilityControl) {
        // inputの親要素（control要素）をクリック
        const controlElement = await page.evaluateHandle(() => {
          const input = document.querySelector('#react-select-2-input');
          return input ? input.closest('div[class*="control"]') : null;
        });

        if (controlElement) {
          await controlElement.click();
          console.log('Visibility dropdown opened via control element');

          await new Promise(resolve => setTimeout(resolve, 1500));

          // react-select-2のオプションを探して選択
          const optionSelected = await page.evaluate(() => {
            const options = Array.from(document.querySelectorAll('[id*="react-select-2-option"]'));
            console.log(`Found ${options.length} visibility options`);

            if (options.length > 0) {
              // 全体に公開オプションを探す
              const publicOption = options.find(option =>
                option.textContent.includes('全体に公開') ||
                option.textContent.includes('全体')
              );

              if (publicOption) {
                console.log(`Selecting public option: ${publicOption.textContent}`);
                publicOption.click();
                return 'public';
              } else {
                // 見つからない場合は最初のオプションを選択
                console.log(`Selecting first option: ${options[0].textContent}`);
                options[0].click();
                return 'first';
              }
            }
            return null;
          });

          if (optionSelected) {
            console.log(`Visibility option selected: ${optionSelected}`);
          } else {
            console.log('No visibility options found');
          }
        } else {
          console.log('Control element not found');
        }
      } else {
        console.log('react-select-2-input not found');
      }
    } catch (visibilityError) {
      console.log('Could not set visibility:', visibilityError.message);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    // カテゴリの設定
    const targetCategory = category || 'ビジネス';
    console.log(`Setting category to: ${targetCategory}`);

    // Category setting via robust method below

    // カテゴリが未選択の場合、総当たり探索を実行
    // BGM設定の前に確実に行う
    const checkAndSelect = async (startIndex, endIndex, targetValue, identifyingKeywords, labelName) => {
      console.log(`Starting robust search for ${labelName} (Target: ${targetValue})`);
      for (let i = startIndex; i <= endIndex; i++) {
        const candidateId = `react-select-${i}-input`;
        try {
          // 要素の存在確認
          const exists = await page.$(`#${candidateId}`);
          if (!exists) continue;

          // ドロップダウンを開く
          const controlElement = await page.evaluateHandle((inputId) => {
            const input = document.querySelector(`#${inputId}`);
            return input ? input.closest('div[class*="control"]') : null;
          }, candidateId);

          if (!controlElement) continue;

          await controlElement.click();
          await new Promise(resolve => setTimeout(resolve, 1000));

          // オプションの内容を確認
          const result = await page.evaluate((inputId, target, keywords) => {
            const selectId = inputId.replace('-input', '');
            const allOptions = Array.from(document.querySelectorAll('div[class*="option"], div[role="option"]'));

            // 表示中のオプション（何らかの方法でこのドロップダウンに関連するもの）
            // 簡易的に、クリック後に表示されたもの=最後のものとするか、
            // メニューコンテナの位置関係で判定できるとベストだが、ここではテキスト内容で判定

            const visibleOptions = allOptions.filter(opt => opt.offsetParent !== null); // 表示されているもの
            const optionTexts = visibleOptions.map(opt => opt.textContent.trim());

            // キーワードが含まれているか確認 (= このドロップダウンが対象の種別か)
            const isTargetDropdown = keywords.some(keyword =>
              optionTexts.some(text => text.includes(keyword))
            );

            // または、ターゲットそのものが含まれているか
            const containsTarget = optionTexts.some(text => text === target || text.includes(target));

            if (isTargetDropdown || containsTarget) {
              // 選択実行
              const targetOption = visibleOptions.find(opt => {
                const t = opt.textContent.trim();
                return t === target || t.includes(target);
              });

              if (targetOption) {
                targetOption.click();
                return { success: true, found: true };
              } else {
                // ドロップダウンは合ってるが選択肢がない
                return { success: false, found: true };
              }
            }

            return { success: false, found: false };
          }, candidateId, targetValue, identifyingKeywords);

          if (result.success) {
            console.log(`${labelName} successfully selected from ${candidateId}`);
            return candidateId;
          } else if (result.found) {
            console.log(`${labelName} dropdown found at ${candidateId} but target option not found`);
            // ドロップダウンを閉じる
            await page.keyboard.press('Escape');
            // 見つかったが選択できないので、これ以上探しても無駄かもしれないが、念のため続行するか終了するか
            // ここではループ終了
            return null;
          } else {
            // 違うドロップダウンだった場合、閉じて次へ
            await page.keyboard.press('Escape');
            await new Promise(resolve => setTimeout(resolve, 500));
          }

        } catch (err) {
          console.log(`Error checking ${candidateId}:`, err.message);
        }
      }
      return null;
    };

    // カテゴリの再確認 (もし上記で決まっていなければ)
    // 範囲は広めに 5〜15
    // identifyingKeywords: 代表的なカテゴリ名 (2025/12/11 更新: 新カテゴリリスト準拠)
    await checkAndSelect(5, 15, targetCategory, ['ミュージック', 'エンタメ', 'スポーツ', 'カルチャー', 'クリエイティブ', 'ビジネス', 'ライフスタイル', '恋愛', '美容', 'トーク'], 'Category');

    await new Promise(resolve => setTimeout(resolve, 1000));

    // BGMの設定
    if (bgm && bgm !== '') {
      console.log(`Setting BGM to: ${bgm}`);
      // BGMは 'Original' や 'Classic' などがキーワード
      await checkAndSelect(5, 15, bgm, ['Original', 'Classic', 'R&B', 'Pop', 'Jazz', 'Lo-Fi'], 'BGM');
    } else {
      console.log('No BGM specified, skipping BGM settings');
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    // 公開日時を「日時を指定して公開」に設定して06:10に設定 - react-select-3を直接操作
    console.log('Setting publish date/time to scheduled at 06:10...');
    try {
      // react-select-3のコントロール要素を直接操作
      const publishTimeControl = await page.$('#react-select-3-input');

      if (publishTimeControl) {
        // inputの親要素（control要素）をクリック
        const controlElement = await page.evaluateHandle(() => {
          const input = document.querySelector('#react-select-3-input');
          return input ? input.closest('div[class*="control"]') : null;
        });

        if (controlElement) {
          await controlElement.click();
          console.log('Publish time dropdown opened via control element');

          await new Promise(resolve => setTimeout(resolve, 1500));

          // react-select-3のオプションから2番目の「日時を指定して公開」を選択
          const optionSelected = await page.evaluate(() => {
            const options = Array.from(document.querySelectorAll('[id*="react-select-3-option"]'));
            console.log(`Found ${options.length} publish time options`);

            if (options.length >= 2) {
              // 2番目のオプション「日時を指定して公開」を選択
              console.log(`Selecting second option (scheduled): ${options[1].textContent}`);
              options[1].click();
              return 'scheduled';
            } else if (options.length > 0) {
              // オプションが少ない場合は「日時を指定して公開」をテキストで探す
              const scheduleOption = options.find(option =>
                option.textContent.includes('日時を指定して公開') ||
                option.textContent.includes('指定して') ||
                option.textContent.includes('スケジュール')
              );

              if (scheduleOption) {
                console.log(`Selecting schedule option: ${scheduleOption.textContent}`);
                scheduleOption.click();
                return 'scheduled';
              }
            }
            return null;
          });

          if (optionSelected === 'scheduled') {
            console.log('Schedule publish option selected');

            await new Promise(resolve => setTimeout(resolve, 2000));

            // ターゲット日付を使用（basenameから抽出した日付）
            const currentYear = targetDate.getFullYear();
            const currentMonth = String(targetDate.getMonth() + 1).padStart(2, '0');
            const currentDay = String(targetDate.getDate()).padStart(2, '0');

            console.log(`Setting date to: ${currentYear}-${currentMonth}-${currentDay} 06:10`);

            // 年の設定 (react-select-4) - 現在年なら1番目、未来年なら2番目
            const currentActualYear = new Date().getFullYear();
            const targetYear = currentYear;
            let yearOptionIndex = 1; // デフォルトは1番目（現在年）

            if (targetYear > currentActualYear) {
              yearOptionIndex = 2; // 未来年の場合は2番目
              console.log(`Target year ${targetYear} is future year, selecting option 2`);
            } else {
              console.log(`Target year ${targetYear} is current year, selecting option 1`);
            }

            const yearControl = await page.$('#react-select-4-input');
            if (yearControl) {
              const yearControlElement = await page.evaluateHandle(() => {
                const input = document.querySelector('#react-select-4-input');
                return input ? input.closest('div[class*="control"]') : null;
              });

              if (yearControlElement) {
                await yearControlElement.click();
                await new Promise(resolve => setTimeout(resolve, 500));

                // 年を位置ベースで選択
                await page.evaluate((optionIndex) => {
                  const options = Array.from(document.querySelectorAll('[id*="react-select-4-option"]'));
                  console.log(`Selecting year option ${optionIndex} (${optionIndex}番目)`);
                  console.log(`Available year options: ${options.map(o => o.textContent).join(', ')}`);

                  if (options.length >= optionIndex && optionIndex > 0) {
                    options[optionIndex - 1].click(); // 0ベースなので-1
                    console.log(`Year set to option ${optionIndex}: ${options[optionIndex - 1].textContent}`);
                    return true;
                  } else {
                    console.log(`Year option ${optionIndex} not available`);
                    return false;
                  }
                }, yearOptionIndex);

                await new Promise(resolve => setTimeout(resolve, 500));
              }
            }

            // 月の設定 (react-select-5) - 上からN番目で選択
            const monthControl = await page.$('#react-select-5-input');
            if (monthControl) {
              const monthControlElement = await page.evaluateHandle(() => {
                const input = document.querySelector('#react-select-5-input');
                return input ? input.closest('div[class*="control"]') : null;
              });

              if (monthControlElement) {
                await monthControlElement.click();
                await new Promise(resolve => setTimeout(resolve, 500));

                // 現在の月番号で上からN番目を選択（8月なら8番目）
                const monthNumber = parseInt(currentMonth, 10);
                await page.evaluate((monthIndex) => {
                  const options = Array.from(document.querySelectorAll('[id*="react-select-5-option"]'));
                  console.log(`Selecting month option ${monthIndex} (${monthIndex}番目)`);
                  console.log(`Available month options: ${options.map(o => o.textContent).join(', ')}`);

                  if (options.length >= monthIndex && monthIndex > 0) {
                    options[monthIndex - 1].click(); // 0ベースなので-1
                    console.log(`Month set to option ${monthIndex}: ${options[monthIndex - 1].textContent}`);
                    return true;
                  } else {
                    console.log(`Month option ${monthIndex} not available`);
                    return false;
                  }
                }, monthNumber);

                await new Promise(resolve => setTimeout(resolve, 500));
              }
            }

            // 日の設定 (react-select-6) - 上からN番目で選択
            const dayControl = await page.$('#react-select-6-input');
            if (dayControl) {
              const dayControlElement = await page.evaluateHandle(() => {
                const input = document.querySelector('#react-select-6-input');
                return input ? input.closest('div[class*="control"]') : null;
              });

              if (dayControlElement) {
                await dayControlElement.click();
                await new Promise(resolve => setTimeout(resolve, 500));

                // 現在の日番号で上からN番目を選択（7日なら7番目）
                const dayNumber = parseInt(currentDay, 10);
                await page.evaluate((dayIndex) => {
                  const options = Array.from(document.querySelectorAll('[id*="react-select-6-option"]'));
                  console.log(`Selecting day option ${dayIndex} (${dayIndex}番目)`);
                  console.log(`Available day options: ${options.map(o => o.textContent).join(', ')}`);

                  if (options.length >= dayIndex && dayIndex > 0) {
                    options[dayIndex - 1].click(); // 0ベースなので-1
                    console.log(`Day set to option ${dayIndex}: ${options[dayIndex - 1].textContent}`);
                    return true;
                  } else {
                    console.log(`Day option ${dayIndex} not available`);
                    return false;
                  }
                }, dayNumber);

                await new Promise(resolve => setTimeout(resolve, 500));
              }
            }

            // 時刻入力フィールドを探して06:10に設定
            const timeInput = await page.$('input[type="time"]');
            if (timeInput) {
              // フィールドにフォーカスしてから値を設定
              await timeInput.focus();

              // 既存の値をクリアしてから入力
              await page.evaluate(() => {
                const timeField = document.querySelector('input[type="time"]');
                if (timeField) {
                  timeField.value = '';
                  timeField.focus();
                }
              });

              // 少し待ってから新しい値を入力
              await new Promise(resolve => setTimeout(resolve, 300));

              // 手動で時間と分を入力
              const timeString = publishTime ? publishTime.replace(':', '') : '0610';
              await timeInput.type(timeString);

              // Enterキーを押して確定
              await page.keyboard.press('Enter');

              // フォーカスを外してblurイベントをトリガー
              await page.evaluate(el => el.blur(), timeInput);

              // 最終確認で値を設定
              await page.evaluate((val) => {
                const timeField = document.querySelector('input[type="time"]');
                if (timeField) {
                  timeField.value = val;
                  const changeEvent = new Event('change', { bubbles: true });
                  timeField.dispatchEvent(changeEvent);
                  const blurEvent = new Event('blur', { bubbles: true });
                  timeField.dispatchEvent(blurEvent);
                  console.log(`Final time set to ${val}`);
                }
              }, publishTime || '06:10');

              // 時間設定完了
              console.log('Time setting process completed');
            } else {
              console.log('Time input field not found');
            }
          } else {
            console.log('Could not select scheduled option');
          }
        } else {
          console.log('Control element not found');
        }
      } else {
        console.log('react-select-3-input not found');
      }
    } catch (publishTimeError) {
      console.log('Could not set publish time:', publishTimeError.message);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    // 放送の説明を入力
    const finalDescription = description || '';
    console.log('Setting broadcast description...');

    try {
      // textareaを探す
      const descriptionTextarea = await page.$('textarea');
      if (descriptionTextarea) {
        // 既存の内容をクリア
        await descriptionTextarea.click();
        await descriptionTextarea.focus();
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');

        // 説明を入力
        await descriptionTextarea.type(finalDescription);
        console.log('Broadcast description set successfully');
      } else {
        console.log('Description textarea not found');
      }
    } catch (descError) {
      console.log('Error setting description:', descError.message);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    // 露骨な表現を上から1番目の「露骨な表現を含まない」に設定 - react-select-7を直接操作
    console.log('Setting explicit content to none (1st option)...');
    try {
      // react-select-7のコントロール要素を直接操作
      const explicitControl = await page.$('#react-select-7-input');

      if (explicitControl) {
        // inputの親要素（control要素）をクリック
        const controlElement = await page.evaluateHandle(() => {
          const input = document.querySelector('#react-select-7-input');
          return input ? input.closest('div[class*="control"]') : null;
        });

        if (controlElement) {
          await controlElement.click();
          console.log('Explicit content dropdown opened via control element');

          await new Promise(resolve => setTimeout(resolve, 1500));

          // react-select-7のオプションから1番目を選択
          const optionSelected = await page.evaluate(() => {
            const options = Array.from(document.querySelectorAll('[id*="react-select-7-option"]'));
            console.log(`Found ${options.length} explicit content options`);
            console.log(`Available explicit content options: ${options.map(o => o.textContent).join(', ')}`);

            if (options.length >= 1) {
              // 1番目のオプション「露骨な表現を含まない」を選択
              console.log(`Selecting 1st option (No explicit content): ${options[0].textContent}`);
              options[0].click();
              return 'no_explicit';
            } else {
              console.log('No explicit content options available');
              return null;
            }
          });

          if (optionSelected) {
            console.log('No explicit content option selected successfully');
          } else {
            console.log('Could not select no explicit content option');
          }
        } else {
          console.log('Control element not found');
        }
      } else {
        console.log('react-select-7-input not found');
      }
    } catch (explicitError) {
      console.log('Could not set explicit content:', explicitError.message);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    // 最後に念のためカテゴリを再設定（未設定の場合や外れてしまった場合用）
    /*
    console.log('Final check for Category setting...');
    await checkAndSelect(5, 15, targetCategory, ['ミュージック', 'エンタメ', 'スポーツ', 'カルチャー', 'クリエイティブ', 'ビジネス', 'ライフスタイル', '恋愛', '美容', 'トーク'], 'Category');
    await new Promise(resolve => setTimeout(resolve, 1000));
    */

    // 予約投稿ボタンをクリック
    console.log('Clicking scheduled publish button...');
    try {
      // より具体的なセレクターで「予約投稿する」ボタンを探す
      const publishButtonClicked = await page.evaluate(() => {
        // divでtabindex="0"を持ち、「予約投稿する」テキストを含む要素を探す
        const buttons = Array.from(document.querySelectorAll('div[tabindex="0"]'));
        console.log(`Found ${buttons.length} clickable div elements`);

        const publishButton = buttons.find(btn => {
          const text = btn.textContent || '';
          return text.includes('予約投稿する');
        });

        if (publishButton) {
          console.log(`Found publish button with text: ${publishButton.textContent}`);
          // ボタンの背景色をチェック（有効状態の確認）
          const styles = window.getComputedStyle(publishButton);
          console.log(`Button background color: ${styles.backgroundColor}`);

          publishButton.click();
          return true;
        } else {
          // フォールバック: すべての要素をチェック
          const allElements = Array.from(document.querySelectorAll('*'));
          const fallbackButton = allElements.find(el =>
            el.textContent && el.textContent.trim() === '予約投稿する'
          );

          if (fallbackButton) {
            console.log('Found publish button via fallback method');
            fallbackButton.click();
            return true;
          }
        }

        console.log('No publish button found');
        return false;
      });

      if (publishButtonClicked) {
        console.log('Scheduled publish button clicked successfully');

        // 画像アップロードが「公開クリック時」に走るケースがあるため、ここでも最終確認を入れる
        if (standfmImageUploadWaiter && standfmImageSelected && !standfmImageUploadWaiter.isResolved()) {
          // 通常時も短時間だけ待って、ビルド版での取りこぼしを防ぐ
          const timeoutMs = debugStandfmImage ? 15000 : 12000
          try {
            const networkResult = await standfmImageUploadWaiter.wait(timeoutMs, 'stand.fm image upload (after publish click)')
            if (debugStandfmImage) {
              console.log('[Stand.fm image] publish-click: upload network finished:', networkResult)
              if (networkResult && networkResult.body) {
                console.log('[Stand.fm image] publish-click: upload response body:', networkResult.body)
              }
            }
          } catch (e) {
            console.log('[Stand.fm image] publish-click: upload network not observed within timeout')
          }
        }

        // 投稿完了まで少し待機
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Stand.fm投稿完了をメタデータに保存
        const metadata = await fs.pathExists(metadataPath) ? await fs.readJson(metadataPath) : {};
        if (!metadata[basename]) {
          metadata[basename] = {};
        }
        metadata[basename].standfmPublished = true;
        metadata[basename].standfmPublishedDate = new Date().toISOString();

        await fs.writeJson(metadataPath, metadata, { spaces: 2 });
        console.log(`Stand.fm published status saved for: ${basename}`);

      } else {
        console.log('Scheduled publish button not found - trying additional methods');

        // 追加の試行: CSSセレクターで探す
        const alternativeClick = await page.evaluate(() => {
          // 背景色がピンクの要素を探す
          const pinkButtons = Array.from(document.querySelectorAll('div')).filter(div => {
            const styles = window.getComputedStyle(div);
            return styles.backgroundColor.includes('243, 54, 130') || // rgb(243, 54, 130)
              styles.backgroundColor.includes('#f33682');
          });

          console.log(`Found ${pinkButtons.length} pink buttons`);

          const publishBtn = pinkButtons.find(btn =>
            btn.textContent && btn.textContent.includes('予約投稿する')
          );

          if (publishBtn) {
            console.log('Found publish button by background color');
            publishBtn.click();
            return true;
          }

          return false;
        });

        if (alternativeClick) {
          console.log('Alternative publish button click successful');
          await new Promise(resolve => setTimeout(resolve, 1500));

          if (standfmImageUploadWaiter && standfmImageSelected && !standfmImageUploadWaiter.isResolved()) {
            const timeoutMs = debugStandfmImage ? 15000 : 12000
            try {
              const networkResult = await standfmImageUploadWaiter.wait(timeoutMs, 'stand.fm image upload (after alternative publish click)')
              if (debugStandfmImage) {
                console.log('[Stand.fm image] publish-click: upload network finished:', networkResult)
                if (networkResult && networkResult.body) {
                  console.log('[Stand.fm image] publish-click: upload response body:', networkResult.body)
                }
              }
            } catch (e) {
              console.log('[Stand.fm image] publish-click: upload network not observed within timeout')
            }
          }
        }
      }
    } catch (publishError) {
      console.log('Could not click publish button:', publishError.message);
    }

    if (standfmImageUploadWaiter) {
      await standfmImageUploadWaiter.dispose()
    }

    console.log('Stand.fm publish process completed');

    return {
      success: true,
      message: 'Stand.fm予約投稿が完了しました。',
      browser: true
    };

  } catch (error) {
    console.error('Error publishing to Stand.fm:', error);

    return {
      success: false,
      message: `Stand.fm投稿でエラーが発生しました: ${error.message}`
    };
  }
});