const { ipcRenderer } = require('electron');

let audioFiles = [];
let metadata = {};
let currentEditingFile = null;
let selectedYearMonth = null; // 選択された年月を記録
let platformSettings = {
    standfm: true,
    voicy: true,
    spotify: true
};

// DOM要素
const fileList = document.getElementById('fileList');
const addFileBtn = document.getElementById('addFileBtn');
const refreshBtn = document.getElementById('refreshBtn');
const openStandfmBtn = document.getElementById('openStandfmBtn');
const openVoicyBtn = document.getElementById('openVoicyBtn');
const openSpotifyBtn = document.getElementById('openSpotifyBtn');
const settingsBtn = document.getElementById('settingsBtn');
const filterNoText = document.getElementById('filterNoText');
const filterUnpublished = document.getElementById('filterUnpublished');
const yearMonthTabs = document.getElementById('yearMonthTabs');
const showAllBtn = document.getElementById('showAllBtn');
const editModal = document.getElementById('editModal');
const editForm = document.getElementById('editForm');
const closeModal = document.querySelector('.close');
const cancelEdit = document.getElementById('cancelEdit');
const saveEdit = document.getElementById('saveEdit');

// 初期化
document.addEventListener('DOMContentLoaded', async () => {
    await loadMetadata();
    await loadPlatformSettings();
    await loadAudioFiles();
    setupEventListeners();
    await loadAppVersion();
    updatePlatformVisibility();
});

// アプリバージョンを読み込んで表示
async function loadAppVersion() {
    try {
        const version = await ipcRenderer.invoke('get-app-version');
        const versionElement = document.getElementById('appVersion');
        if (versionElement) {
            versionElement.textContent = `v${version}`;
        }
    } catch (error) {
        console.error('Failed to load app version:', error);
    }
}

// イベントリスナーの設定
function setupEventListeners() {
    if (addFileBtn) {
        addFileBtn.addEventListener('click', addAudioFile);
    } else {
        console.error('addFileBtn要素が見つかりません');
    }

    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadAudioFiles);
    } else {
        console.error('refreshBtn要素が見つかりません');
    }

    if (openStandfmBtn) {
        openStandfmBtn.addEventListener('click', () => openExternalUrl('https://stand.fm/episodes/scheduled'));
    } else {
        console.error('openStandfmBtn要素が見つかりません');
    }

    if (openVoicyBtn) {
        openVoicyBtn.addEventListener('click', () => openExternalUrl('https://va-cms.admin.voicy.jp/'));
    } else {
        console.error('openVoicyBtn要素が見つかりません');
    }

    if (openSpotifyBtn) {
        openSpotifyBtn.addEventListener('click', () => openExternalUrl('https://creators.spotify.com/pod/login'))
    } else {
        console.error('openSpotifyBtn要素が見つかりません')
    }

    if (settingsBtn) {
        settingsBtn.addEventListener('click', openPlatformSettingsModal);
    } else {
        console.error('settingsBtn要素が見つかりません');
    }

    if (filterNoText) {
        filterNoText.addEventListener('change', applyFilters);
    } else {
        console.error('filterNoText要素が見つかりません');
    }

    if (filterUnpublished) {
        filterUnpublished.addEventListener('change', applyFilters);
    } else {
        console.error('filterUnpublished要素が見つかりません');
    }

    if (showAllBtn) {
        showAllBtn.addEventListener('click', () => {
            selectedYearMonth = null;
            updateYearMonthTabs();
            renderFileList();
        });
    } else {
        console.error('showAllBtn要素が見つかりません');
    }

    // モーダル関連
    if (closeModal) {
        closeModal.addEventListener('click', closeEditModal);
    } else {
        console.error('closeModal要素が見つかりません');
    }

    if (cancelEdit) {
        cancelEdit.addEventListener('click', closeEditModal);
    } else {
        console.error('cancelEdit要素が見つかりません');
    }

    if (saveEdit) {
        saveEdit.addEventListener('click', saveFileMetadata);
    } else {
        console.error('saveEdit要素が見つかりません');
    }

    // モーダル外クリックで閉じる
    if (editModal) {
        editModal.addEventListener('click', (event) => {
            if (event.target === editModal) {
                closeEditModal();
            }
        });
    } else {
        console.error('editModal要素が見つかりません');
    }

    // Windowsで日本語入力を確実にするため、タイトル入力フィールドのフォーカス時にIMEを有効化
    const editTitleInput = document.getElementById('editTitle');
    if (editTitleInput) {
        editTitleInput.addEventListener('focus', () => {
            // Windowsの場合、IMEを有効にする
            if (navigator.platform.indexOf('Win') !== -1) {
                editTitleInput.setAttribute('ime-mode', 'active');
                editTitleInput.style.imeMode = 'active';
            }
        });
    }
}

// メタデータを読み込み
async function loadMetadata() {
    try {
        metadata = await ipcRenderer.invoke('load-metadata');
    } catch (error) {
        console.error('メタデータの読み込みエラー:', error);
        metadata = {};
    }
}

// プラットフォーム設定を読み込み
async function loadPlatformSettings() {
    try {
        const standfmEnabled = await ipcRenderer.invoke('get-config', 'platformEnabled.standfm');
        const voicyEnabled = await ipcRenderer.invoke('get-config', 'platformEnabled.voicy');
        const spotifyEnabled = await ipcRenderer.invoke('get-config', 'platformEnabled.spotify');

        platformSettings.standfm = standfmEnabled !== null && standfmEnabled !== undefined ? standfmEnabled : true;
        platformSettings.voicy = voicyEnabled !== null && voicyEnabled !== undefined ? voicyEnabled : true;
        platformSettings.spotify = spotifyEnabled !== null && spotifyEnabled !== undefined ? spotifyEnabled : true;
    } catch (error) {
        console.error('プラットフォーム設定の読み込みエラー:', error);
        // デフォルト値を使用
        platformSettings = { standfm: true, voicy: true, spotify: true };
    }
}

// プラットフォーム設定を保存
async function savePlatformSettings() {
    try {
        await ipcRenderer.invoke('set-config', 'platformEnabled.standfm', platformSettings.standfm);
        await ipcRenderer.invoke('set-config', 'platformEnabled.voicy', platformSettings.voicy);
        await ipcRenderer.invoke('set-config', 'platformEnabled.spotify', platformSettings.spotify);
        return true;
    } catch (error) {
        console.error('プラットフォーム設定の保存エラー:', error);
        return false;
    }
}

// プラットフォームの表示/非表示を更新
function updatePlatformVisibility() {
    // ヘッダのボタン
    if (openStandfmBtn) {
        openStandfmBtn.style.display = platformSettings.standfm ? 'flex' : 'none';
    }
    if (openVoicyBtn) {
        openVoicyBtn.style.display = platformSettings.voicy ? 'flex' : 'none';
    }
    if (openSpotifyBtn) {
        openSpotifyBtn.style.display = platformSettings.spotify ? 'flex' : 'none';
    }

    // ファイルリストを再描画（各音声ファイルのボタンも更新）
    renderFileList();
}

// 音声ファイル一覧を読み込み
async function loadAudioFiles() {
    try {
        fileList.innerHTML = '<div class="loading">📂 音声ファイルを読み込み中...</div>';

        audioFiles = await ipcRenderer.invoke('get-audio-files');

        // メタデータとマージ（投稿ステータスはget-audio-filesから取得した値を使用）
        audioFiles = audioFiles.map(file => {
            const localMeta = metadata[file.basename] || {};
            return {
                ...file,
                // 投稿ステータスはget-audio-filesから取得した最新の値を使用
                standfmPublished: file.standfmPublished,
                voicyPublished: file.voicyPublished,
                spotifyPublished: file.spotifyPublished,
                // その他のメタデータ（title, publishDateなど）はローカルのmetadataから取得
                title: localMeta.title || file.title || '',
                publishDate: localMeta.publishDate || file.publishDate || ''
            };
        });

        // 投稿日時・タイトルが未設定のファイルに自動設定
        let hasUpdates = false;
        audioFiles.forEach(file => {
            let updated = false;
            // 投稿日時自動設定
            if (!file.publishDate) {
                const defaultDate = getDefaultPublishDate(file.basename);
                if (defaultDate) {
                    file.publishDate = defaultDate;
                    updated = true;
                }
            }
            // タイトル自動設定
            if (!file.title) {
                file.title = getDefaultTitle(file.basename);
                updated = true;
            }

            if (updated) {
                metadata[file.basename] = {
                    ...metadata[file.basename],
                    publishDate: file.publishDate,
                    title: file.title
                };
                hasUpdates = true;
            }
        });

        // 自動設定があった場合はメタデータを保存
        if (hasUpdates) {
            await ipcRenderer.invoke('save-metadata', metadata);
        }

        generateYearMonthTabs();
        renderFileList();
    } catch (error) {
        console.error('音声ファイルの読み込みエラー:', error);
        fileList.innerHTML = '<div class="empty-state"><h3>エラー</h3><p>音声ファイルの読み込みに失敗しました</p></div>';
    }
}

// 年月タブを生成
function generateYearMonthTabs() {
    const yearMonthMap = new Map();

    audioFiles.forEach(file => {
        if (file.publishDate) {
            const date = new Date(file.publishDate);
            const yearMonth = `${date.getFullYear()}/${(date.getMonth() + 1).toString().padStart(2, '0')}`;
            const count = yearMonthMap.get(yearMonth) || 0;
            yearMonthMap.set(yearMonth, count + 1);
        }
    });

    // 日付順でソート（新しい順）
    const sortedYearMonths = Array.from(yearMonthMap.entries())
        .sort((a, b) => b[0].localeCompare(a[0]));

    // "すべて表示" タブを最初に追加
    const allTabHtml = `
            <button
                class="inline-flex items-center justify-center whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:pointer-events-none disabled:opacity-50 ${selectedYearMonth === null
            ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/20'
            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
        }"
                onclick="selectYearMonth(null)"
            >
                すべて <span class="ml-1.5 opacity-80 text-xs">(${audioFiles.length})</span>
            </button>
    `;

    const tabsHtml = sortedYearMonths.map(([yearMonth, count]) => {
        const isActive = selectedYearMonth === yearMonth;
        return `
            <button
                class="inline-flex items-center justify-center whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:pointer-events-none disabled:opacity-50 ${isActive
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/20'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }"
                onclick="selectYearMonth('${yearMonth}')"
            >
                ${yearMonth} <span class="ml-1.5 opacity-80 text-xs">(${count})</span>
            </button>
        `;
    }).join('');

    yearMonthTabs.innerHTML = allTabHtml + tabsHtml;
}

// 年月タブを選択
function selectYearMonth(yearMonth) {
    selectedYearMonth = yearMonth;
    updateYearMonthTabs();
    renderFileList();
}

// 年月タブの表示を更新
function updateYearMonthTabs() {
    generateYearMonthTabs();
}

// ファイル一覧を描画
function renderFileList() {
    if (audioFiles.length === 0) {
        fileList.innerHTML = `
            <div class="text-center py-24 px-4">
                <div class="inline-flex justify-center items-center w-20 h-20 rounded-full bg-slate-800 mb-6 group hover:bg-slate-700 transition-colors">
                    <i data-lucide="music" class="w-10 h-10 text-slate-500 group-hover:text-slate-400 transition-colors"></i>
                </div>
                <h3 class="text-xl font-bold text-slate-200 mb-2">音声ファイルが見つかりません</h3>
                <p class="text-slate-400 mb-8 max-w-sm mx-auto">.m4aフォルダに音声ファイルを追加して、管理を始めましょう。</p>
                <button onclick="addAudioFile()" class="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white px-6 py-3 rounded-xl text-sm font-bold shadow-lg shadow-blue-500/30 hover:shadow-blue-500/40 transition-all transform hover:-translate-y-0.5 flex items-center gap-2 mx-auto">
                    <i data-lucide="folder-plus" class="w-5 h-5"></i>
                    音声ファイルを追加
                </button>
            </div>
        `;
        lucide.createIcons();
        return;
    }

    let filteredFiles = [...audioFiles];

    // 年月フィルターを適用
    if (selectedYearMonth) {
        filteredFiles = filteredFiles.filter(file => {
            if (!file.publishDate) return false;
            const date = new Date(file.publishDate);
            const fileYearMonth = `${date.getFullYear()}/${(date.getMonth() + 1).toString().padStart(2, '0')}`;
            return fileYearMonth === selectedYearMonth;
        });
    }

    // その他のフィルターを適用
    if (filterNoText.checked) {
        filteredFiles = filteredFiles.filter(file => !file.hasText);
    }

    if (filterUnpublished.checked) {
        filteredFiles = filteredFiles.filter(file =>
            !file.standfmPublished || !file.voicyPublished || !file.spotifyPublished
        );
    }

    if (filteredFiles.length === 0) {
        fileList.innerHTML = `
            <div class="text-center py-24 px-4">
                <div class="inline-flex justify-center items-center w-20 h-20 rounded-full bg-slate-800 mb-6">
                    <i data-lucide="search" class="w-10 h-10 text-slate-500"></i>
                </div>
                <h3 class="text-xl font-bold text-slate-200 mb-2">条件に一致するファイルがありません</h3>
                <p class="text-slate-400 max-w-sm mx-auto">フィルター条件を変更して、もう一度お試しください。</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }

    // 日付の降順でソート（新しい順）
    // 日付の降順でソート（新しい順）
    filteredFiles.sort((a, b) => {
        // publishDate (YYYY-MM-DD) を使用してソート
        const dateA = a.publishDate || '';
        const dateB = b.publishDate || '';

        if (dateA !== dateB) {
            return dateB.localeCompare(dateA); // 降順
        }

        // 日付が同じ場合はファイル名で降順
        return b.basename.localeCompare(a.basename);
    });

    fileList.innerHTML = `<div class="space-y-2">${filteredFiles.map(file => createFileItem(file)).join('')}</div>`;
    lucide.createIcons();
}

// ファイルアイテムのHTML作成
function createFileItem(file) {
    // タイトルは手動設定タイトル > 未設定
    const title = file.title || '未設定';

    // 投稿日を「YYYY/MM/DD(曜日)」形式で表示
    let publishDate = '未設定';
    if (file.publishDate) {
        const date = new Date(file.publishDate);
        const year = date.getFullYear();
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const day = date.getDate().toString().padStart(2, '0');
        const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
        const weekday = weekdays[date.getDay()];
        publishDate = `${year}/${month}/${day}(${weekday})`;
    }

    // ステータスボタンを作成
    const transcriptButton = file.hasText ?
        `<div class="flex items-center gap-1.5 p-1 bg-slate-950 rounded-lg border border-slate-800">
            <button class="px-2.5 py-1.5 bg-emerald-500/10 text-emerald-500 rounded-md text-xs font-bold flex items-center gap-1.5 shadow-sm cursor-default">
                <i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i>
                文字起こし完了
            </button>
            <div class="h-4 w-px bg-slate-700"></div>
            <button class="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-blue-400 rounded-md transition-all shadow-sm hover:shadow" onclick="copyTranscriptionPrompt('${file.basename}')" title="プロンプトをコピー">
                <i data-lucide="copy" class="w-3.5 h-3.5"></i>
            </button>
            <button class="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-indigo-400 rounded-md transition-all shadow-sm hover:shadow" onclick="downloadTranscription('${file.basename}')" title="テキストファイルをダウンロード">
                <i data-lucide="download" class="w-3.5 h-3.5"></i>
            </button>
        </div>` :
        `<div class="flex items-center gap-2">
            <button class="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-xs font-bold transition-all shadow-md shadow-amber-500/10 hover:shadow-amber-500/20 flex items-center gap-1.5 group transform hover:-translate-y-0.5 active:translate-y-0" onclick="transcribeAudio('${file.filename}')" title="文字起こし実行">
                <i data-lucide="mic" class="w-3.5 h-3.5 group-hover:animate-pulse"></i>
                文字起こし実行
            </button>
            <button class="p-2 bg-slate-900 border border-slate-700 text-slate-400 hover:text-amber-400 hover:border-amber-500/40 hover:bg-amber-500/10 rounded-lg transition-all shadow-sm hover:shadow-md" onclick="onClickOpenTranscribeHelpModal()" title="文字起こしのセットアップ方法">
                <i data-lucide="circle-help" class="w-4 h-4"></i>
            </button>
        </div>`;



    const standfmButton = platformSettings.standfm ? (file.standfmPublished ?
        `<button class="w-[130px] flex justify-center px-2.5 py-1.5 bg-emerald-500/10 hover:bg-red-500/10 text-emerald-500 hover:text-red-400 rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-sm border border-emerald-500/20 hover:border-red-500/20 transition-all cursor-pointer group" onclick="resetPublishStatus('${file.basename}', 'standfm')" title="stand.fm投稿済みをリセット">
            <i data-lucide="check-circle-2" class="w-3.5 h-3.5 group-hover:hidden"></i>
            <i data-lucide="x-circle" class="w-3.5 h-3.5 hidden group-hover:block"></i>
            stand.fm済
        </button>` :
        `<button class="w-[130px] flex justify-center px-3 py-1.5 bg-slate-900 border border-slate-700 text-slate-400 hover:text-green-400 hover:border-green-500/30 hover:bg-green-500/10 rounded-lg text-xs font-bold transition-all shadow-sm hover:shadow-md flex items-center gap-1.5 group" onclick="publishToStandfm('${file.basename}', '${file.publishDate || ''}')" title="stand.fmに投稿">
            <i data-lucide="radio" class="w-3.5 h-3.5 text-slate-500 group-hover:text-green-500 transition-colors"></i>
            stand.fm投稿
        </button>`) : '';

    const voicyButton = platformSettings.voicy ? (file.voicyPublished ?
        `<button class="w-[130px] flex justify-center px-2.5 py-1.5 bg-emerald-500/10 hover:bg-red-500/10 text-emerald-500 hover:text-red-400 rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-sm border border-emerald-500/20 hover:border-red-500/20 transition-all cursor-pointer group" onclick="resetPublishStatus('${file.basename}', 'voicy')" title="Voicy投稿済みをリセット">
            <i data-lucide="check-circle-2" class="w-3.5 h-3.5 group-hover:hidden"></i>
            <i data-lucide="x-circle" class="w-3.5 h-3.5 hidden group-hover:block"></i>
            Voicy済
        </button>` :
        `<button class="w-[130px] flex justify-center px-3 py-1.5 bg-slate-900 border border-slate-700 text-slate-400 hover:text-purple-400 hover:border-purple-500/30 hover:bg-purple-500/10 rounded-lg text-xs font-bold transition-all shadow-sm hover:shadow-md flex items-center gap-1.5 group" onclick="publishToVoicy('${file.basename}', '${file.publishDate || ''}')" title="Voicyに投稿">
            <i data-lucide="mic" class="w-3.5 h-3.5 text-slate-500 group-hover:text-purple-500 transition-colors"></i>
            Voicy投稿
        </button>`) : '';

    const spotifyButton = platformSettings.spotify ? (file.spotifyPublished ?
        `<button class="w-[130px] flex justify-center px-2.5 py-1.5 bg-emerald-500/10 hover:bg-red-500/10 text-emerald-500 hover:text-red-400 rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-sm border border-emerald-500/20 hover:border-red-500/20 transition-all cursor-pointer group" onclick="resetPublishStatus('${file.basename}', 'spotify')" title="Spotify投稿済みをリセット">
            <i data-lucide="check-circle-2" class="w-3.5 h-3.5 group-hover:hidden"></i>
            <i data-lucide="x-circle" class="w-3.5 h-3.5 hidden group-hover:block"></i>
            Spotify済
        </button>` :
        `<button class="w-[130px] flex justify-center px-3 py-1.5 bg-slate-900 border border-slate-700 text-slate-400 hover:text-emerald-400 hover:border-emerald-500/30 hover:bg-emerald-500/10 rounded-lg text-xs font-bold transition-all shadow-sm hover:shadow-md flex items-center gap-1.5 group" onclick="publishToSpotify('${file.basename}', '${file.publishDate || ''}')" title="Spotifyに投稿">
            <i data-lucide="music" class="w-3.5 h-3.5 text-slate-500 group-hover:text-emerald-500 transition-colors"></i>
            Spotify投稿
        </button>`) : ''



    return `
        <div class="group bg-slate-900 rounded-2xl border border-slate-800 p-5 hover:shadow-xl hover:shadow-black/40 hover:border-slate-700 transition-all duration-300 relative overflow-hidden">
            <!-- 背景装飾 -->
            <div class="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-slate-800 to-transparent rounded-bl-full -mr-8 -mt-8 pointer-events-none opacity-20"></div>

            <!-- 1行目: タイトルと編集ボタン -->
            <div class="flex items-center justify-between mb-1 relative z-10">
                <div class="flex-1 min-w-0 pr-4">
                    <div class="flex items-center gap-2 mb-1.5">
                         <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400">
                            <i data-lucide="calendar" class="w-3 h-3 mr-1"></i>
                            ${publishDate}
                         </span>
                         <span class="text-[10px] text-slate-500 font-mono truncate max-w-[150px]" title="${file.filename}">${file.filename}</span>
                    </div>
                    <h3 class="text-lg font-bold text-slate-100 truncate tracking-tight group-hover:text-blue-400 transition-colors cursor-pointer" onclick="editFile('${file.basename}')" title="クリックして編集">${title}</h3>
                </div>

                <div class="flex items-center gap-2 shrink-0">
                    <button class="p-2 hover:bg-slate-800 rounded-lg text-slate-500 hover:text-slate-300 transition-colors" onclick="editFile('${file.basename}')" title="詳細編集">
                        <i data-lucide="settings-2" class="w-4 h-4"></i>
                    </button>
                    <button class="p-2 hover:bg-red-500/10 rounded-lg text-slate-500 hover:text-red-400 transition-colors" onclick="deleteAudioFile('${file.basename}', '${file.filename}')" title="ファイルを削除">
                        <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                </div>
            </div>

            <!-- 2行目: ステータスボタン -->
            <div class="flex flex-wrap gap-3 items-center justify-between relative z-10">
                <div class="flex items-center gap-3">
                    ${transcriptButton}
                </div>
                <div class="flex items-center gap-3">
                    ${standfmButton}
                    ${voicyButton}
                    ${spotifyButton}
                </div>
            </div>
        </div>
    `;
}

// 投稿ステータスを取得
function getPublishStatus(file) {
    const statuses = [];
    if (file.staeflPublished) statuses.push('スタエフ');
    if (file.voicyPublished) statuses.push('Voicy');

    if (statuses.length === 0) return '未投稿';
    if (statuses.length === 2) return '投稿完了';
    return `${statuses.join(', ')}投稿済み`;
}

// フィルターを適用
function applyFilters() {
    renderFileList();
}

// 音声ファイルを追加
async function addAudioFile() {
    try {
        const filePath = await ipcRenderer.invoke('select-file');
        if (filePath) {
            const result = await ipcRenderer.invoke('copy-to-mp4', filePath);
            if (result.success) {
                await loadAudioFiles();
            } else {
                alert(`ファイルのコピーに失敗しました: ${result.message}`);
            }
        }
    } catch (error) {
        console.error('ファイル追加エラー:', error);
        alert('ファイルの追加に失敗しました');
    }
}

// 音声ファイルを削除
async function deleteAudioFile(basename, filename) {
    if (!confirm(`「${filename}」を削除してもよろしいですか？\n関連する文字起こしテキストなども削除されます。`)) {
        return;
    }

    try {
        const result = await ipcRenderer.invoke('delete-audio-file', { basename, filename });
        if (result.success) {
            showToast('ファイルを削除しました');
            await loadAudioFiles();
        } else {
            alert(`削除に失敗しました: ${result.message}`);
        }
    } catch (error) {
        console.error('削除エラー:', error);
        alert('削除処理中にエラーが発生しました');
    }
}

// 文字起こし実行
async function transcribeAudio(filename) {
    try {
        const button = event.target;
        const originalHTML = button.innerHTML;
        button.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i>処理中...';
        button.disabled = true;
        lucide.createIcons();

        const result = await ipcRenderer.invoke('transcribe-audio', filename);

        if (result.success) {
            alert('文字起こしが完了しました！');
            await loadAudioFiles();
        } else {
            // エラーメッセージを改行を含めて表示
            const errorMsg = result.message || '文字起こしに失敗しました';
            alert(errorMsg);
            button.innerHTML = originalHTML;
            button.disabled = false;
            lucide.createIcons();
        }
    } catch (error) {
        console.error('文字起こしエラー:', error);
        alert('文字起こしの実行に失敗しました');
        button.innerHTML = originalHTML;
        button.disabled = false;
        lucide.createIcons();
    }
}

// Toast通知を表示
function showToast(message, type = 'success') {
    // 既存のトーストがあれば削除
    const existingToast = document.getElementById('toast-notification');
    if (existingToast) {
        existingToast.remove();
    }

    const toast = document.createElement('div');
    toast.id = 'toast-notification';
    toast.className = `fixed bottom-4 right-4 z-50 px-4 py-3 rounded-xl shadow-lg flex items-center gap-3 transform transition-all duration-300 translate-y-10 opacity-0 ${type === 'success' ? 'bg-slate-800 text-white' : 'bg-red-500 text-white'
        }`;

    let icon = type === 'success' ? 'check-circle-2' : 'alert-circle';

    toast.innerHTML = `
        <i data-lucide="${icon}" class="w-5 h-5 ${type === 'success' ? 'text-green-400' : 'text-white'}"></i>
        <span class="font-medium text-sm">${message}</span>
    `;

    document.body.appendChild(toast);
    lucide.createIcons();

    // アニメーションで表示
    requestAnimationFrame(() => {
        toast.classList.remove('translate-y-10', 'opacity-0');
    });

    // 3秒後に消える
    setTimeout(() => {
        toast.classList.add('translate-y-10', 'opacity-0');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// プロンプトをクリップボードにコピー
async function copyTranscriptionPrompt(basename) {
    try {
        const button = event.target.closest('button'); // ensure button is selected even if icon clicked
        const originalHTML = button.innerHTML;
        button.innerHTML = '<i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i>';
        button.disabled = true;
        lucide.createIcons();

        const result = await ipcRenderer.invoke('read-text-file', basename);

        if (result.success) {
            // クリップボードにコピー
            await navigator.clipboard.writeText(result.content);

            // Toast表示
            showToast('文字起こしテキストをコピーしました');

            // ボタンの表示を一時的に変更してフィードバック
            button.innerHTML = '<i data-lucide="check" class="w-3 h-3"></i>';
            button.classList.remove('hover:bg-slate-800');
            button.classList.add('bg-emerald-500/20', 'text-emerald-400');
            lucide.createIcons();

            // 2秒後に元に戻す
            setTimeout(() => {
                button.innerHTML = originalHTML;
                button.classList.remove('bg-emerald-500/20', 'text-emerald-400');
                // デフォルトのスタイル復帰
                button.classList.add('hover:bg-slate-800');
                button.disabled = false;
                lucide.createIcons();
            }, 2000);
        } else {
            showToast(`読み込みに失敗しました: ${result.message}`, 'error');
            button.innerHTML = originalHTML;
            button.disabled = false;
            lucide.createIcons();
        }
    } catch (error) {
        console.error('プロンプトコピーエラー:', error);

        // フォールバック: テキスト選択による手動コピー
        try {
            const result = await ipcRenderer.invoke('read-text-file', basename);
            if (result.success) {
                const prompt = result.content + '\n\n===\nこの内容の音声配信のタイトル案を20個考えてください';
                const textArea = document.createElement('textarea');
                textArea.value = prompt;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
                showToast('プロンプトをコピーしました');
            }
        } catch (fallbackError) {
            console.error('フォールバックコピーエラー:', fallbackError);
            showToast('コピーに失敗しました', 'error');
        }

        // ボタンを元に戻す
        if (event && event.target) {
            const button = event.target.closest('button');
            if (button) {
                button.innerHTML = '<i data-lucide="copy" class="w-3 h-3"></i>';
                button.disabled = false;
                lucide.createIcons();
            }
        }
    }
}

// テキストファイルをダウンロード
async function downloadTranscription(basename) {
    try {
        const result = await ipcRenderer.invoke('read-text-file', basename);

        if (result.success) {
            const blob = new Blob([result.content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${basename}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            showToast('ファイルをダウンロードしました');
        } else {
            showToast(`読み込みに失敗しました: ${result.message}`, 'error');
        }
    } catch (error) {
        console.error('ダウンロードエラー:', error);
        showToast('ダウンロードに失敗しました', 'error');
    }
}

// ファイル名から投稿日のデフォルト値を取得
function getDefaultPublishDate(basename) {
    // ファイル名から日付を抽出（例: 20250718_what_program_to_create）
    const dateMatch = basename.match(/^(\d{8})_/);
    if (dateMatch) {
        const dateStr = dateMatch[1]; // 20250718
        const year = dateStr.substring(0, 4);
        const month = dateStr.substring(4, 6);
        const day = dateStr.substring(6, 8);

        // 日付のみを設定
        return `${year}-${month}-${day}`;
    }

    // 日付指定がない場合は、明日をデフォルト設定にする
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const year = tomorrow.getFullYear();
    const month = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const day = String(tomorrow.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// ファイル名からタイトルのデフォルト値を取得
function getDefaultTitle(basename) {
    // "yyyyMMdd_" のプレフィックスがあれば削除して返す
    // 例: "20251212_My_Podcast" -> "My_Podcast"
    return basename.replace(/^\d{8}_/, '');
}

// ファイル編集
// ファイル編集
function editFile(basename) {
    currentEditingFile = basename;
    const file = audioFiles.find(f => f.basename === basename);

    if (file) {
        document.getElementById('editTitle').value = file.title || '';
        document.getElementById('editDate').value = file.publishDate || '';

        // プラットフォーム設定に基づいてチェックボックスを表示/非表示
        const standfmLabel = document.getElementById('editStandfm')?.closest('label');
        const voicyLabel = document.getElementById('editVoicy')?.closest('label');
        const spotifyLabel = document.getElementById('editSpotify')?.closest('label');

        if (standfmLabel) {
            standfmLabel.style.display = platformSettings.standfm ? 'flex' : 'none';
            if (platformSettings.standfm) {
                document.getElementById('editStandfm').checked = file.standfmPublished || false;
            }
        }
        if (voicyLabel) {
            voicyLabel.style.display = platformSettings.voicy ? 'flex' : 'none';
            if (platformSettings.voicy) {
                document.getElementById('editVoicy').checked = file.voicyPublished || false;
            }
        }
        if (spotifyLabel) {
            spotifyLabel.style.display = platformSettings.spotify ? 'flex' : 'none';
            if (platformSettings.spotify) {
                document.getElementById('editSpotify').checked = file.spotifyPublished || false;
            }
        }

        editModal.classList.remove('opacity-0', 'pointer-events-none');
        
        // Windowsで日本語入力を確実にするため、少し遅延してフォーカスを設定
        setTimeout(() => {
            const titleInput = document.getElementById('editTitle');
            if (titleInput) {
                titleInput.focus();
                // IMEを有効にする（Windows用）
                if (navigator.platform.indexOf('Win') !== -1) {
                    titleInput.setAttribute('ime-mode', 'active');
                }
            }
        }, 100);
    }
}

// モーダルを閉じる
function closeEditModal() {
    editModal.classList.add('opacity-0', 'pointer-events-none');
    currentEditingFile = null;
}

// ファイルメタデータを保存
async function saveFileMetadata() {
    if (!currentEditingFile) return;

    try {
        const formData = new FormData(editForm);
        const fileMetadata = {
            title: formData.get('title'),
            publishDate: formData.get('publishDate'),
            standfmPublished: platformSettings.standfm && formData.has('standfmPublished'),
            voicyPublished: platformSettings.voicy && formData.has('voicyPublished'),
            spotifyPublished: platformSettings.spotify && formData.has('spotifyPublished')
        };

        // 最新のメタデータをファイルから読み直してからマージ（他の操作による変更を保持するため）
        await loadMetadata();

        // 既存のメタデータを保持しつつ、新しい値をマージ
        metadata[currentEditingFile] = {
            ...metadata[currentEditingFile],
            ...fileMetadata
        };

        const result = await ipcRenderer.invoke('save-metadata', metadata);

        if (result.success) {
            closeEditModal();
            await loadAudioFiles();
        } else {
            alert(`保存に失敗しました: ${result.message}`);
        }
    } catch (error) {
        console.error('メタデータ保存エラー:', error);
        alert('メタデータの保存に失敗しました');
    }
}



// Voicyに投稿
// Voicy投稿モーダル関連の変数
let currentVoicyTargetFile = null;

// Voicy投稿ボタンクリック時の処理（モーダルを開く）
// Voicy投稿ボタンクリック時の処理（モーダルを開く）
function publishToVoicy(basename, initialDate) {
    console.log('Voicy投稿関数が呼び出されました:', basename, 'InitialDate:', initialDate)
    currentVoicyTargetFile = basename;

    // UIを更新
    const modal = document.getElementById('voicyPublishModal');
    if (modal) {
        // --- デフォルト値の読み込み ---

        // 放送タイトル
        const savedBroadcastTitle = localStorage.getItem('voicy_default_broadcast_title');
        if (savedBroadcastTitle) {
            document.getElementById('voicyBroadcastTitle').value = savedBroadcastTitle;
        } else {
            // ファイルのメタデータまたはファイル名から取得
            const file = audioFiles.find(f => f.basename === basename);
            if (file && file.title) {
                document.getElementById('voicyBroadcastTitle').value = file.title;
            } else {
                // yyyyMMdd_を取り除くロジック
                const nameMatch = basename.match(/^\d{8}_(.+)$/);
                if (nameMatch) {
                    document.getElementById('voicyBroadcastTitle').value = nameMatch[1];
                } else {
                    document.getElementById('voicyBroadcastTitle').value = basename;
                }
            }
        }

        // チャプタータイトル
        const savedTitle = localStorage.getItem('voicy_default_title');
        if (savedTitle) {
            document.getElementById('voicyChapterTitle').value = savedTitle;
        } else {
            document.getElementById('voicyChapterTitle').value = '';
        }

        // 放送の説明
        const savedDescription = localStorage.getItem('voicy_default_description');
        if (savedDescription) {
            document.getElementById('voicyDescription').value = savedDescription;
        } else {
            document.getElementById('voicyDescription').value = '';
        }

        // URL
        const savedUrl = localStorage.getItem('voicy_default_url');
        if (savedUrl !== null) {
            document.getElementById('voicyChapterUrl').value = savedUrl;
        } else {
            document.getElementById('voicyChapterUrl').value = '';
        }

        // 予約投稿時間
        const savedTime = localStorage.getItem('voicy_default_time');
        if (savedTime) {
            document.getElementById('voicyPublishTime').value = savedTime;
        } else {
            document.getElementById('voicyPublishTime').value = '06:10';
        }

        // 予約投稿日
        // 優先順位:
        // 1. 引数で渡された日時 (initialDate) - カードに表示されている日時
        // 2. ファイル名から解析された日時
        // 3. 明日
        const dateInput = document.getElementById('voicyPublishDate');
        if (dateInput) {
            let dateStr = '';

            if (initialDate && !isNaN(new Date(initialDate).getTime())) {
                // initialDateが有効な場合
                const d = new Date(initialDate);
                const year = d.getFullYear();
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                dateStr = `${year}-${month}-${day}`;
            } else {
                // フォールバック: ファイル名または明日
                let targetDate = new Date();
                targetDate.setDate(targetDate.getDate() + 1);

                try {
                    const dateMatch = basename.match(/^(\d{4})(\d{2})(\d{2})/);
                    if (dateMatch) {
                        const year = parseInt(dateMatch[1]);
                        const month = parseInt(dateMatch[2]) - 1;
                        const day = parseInt(dateMatch[3]);
                        const fileDate = new Date(year, month, day);
                        if (!isNaN(fileDate.getTime())) {
                            targetDate = fileDate;
                        }
                    }
                } catch (e) {
                    console.error('日付解析エラー:', e);
                }

                const year = targetDate.getFullYear();
                const month = String(targetDate.getMonth() + 1).padStart(2, '0');
                const day = String(targetDate.getDate()).padStart(2, '0');
                dateStr = `${year}-${month}-${day}`;
            }
            dateInput.value = dateStr;
        }

        // ハッシュタグ
        const savedHashtags = localStorage.getItem('voicy_default_hashtags');
        if (savedHashtags) {
            document.getElementById('voicyHashtags').value = savedHashtags;
        } else {
            document.getElementById('voicyHashtags').value = '';
        }

        // --- イベントリスナーの設定 ---

        // モーダルを表示
        modal.classList.remove('opacity-0', 'pointer-events-none');

        // 投稿ボタン
        const confirmBtn = document.getElementById('confirmVoicyPublishBtn');
        const newConfirmBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
        newConfirmBtn.addEventListener('click', () => executeVoicyPublish());

        // チャプタータイトルへの貼り付け: 改行あり → 1行目をタイトル、2行目をURLに反映
        const chapterTitleInput = document.getElementById('voicyChapterTitle');
        chapterTitleInput.addEventListener('paste', (e) => {
            const text = e.clipboardData.getData('text');
            const lines = text.split(/\r?\n/);
            if (lines.length >= 2 && lines[1].trim() !== '') {
                e.preventDefault();
                chapterTitleInput.value = lines[0].trim();
                document.getElementById('voicyChapterUrl').value = lines[1].trim();
            }
        });

        // チャプタータイトルのデフォルト保存ボタン
        const saveTitleBtn = document.getElementById('saveVoicyTitleDefaultBtn');
        const newSaveTitleBtn = saveTitleBtn.cloneNode(true);
        saveTitleBtn.parentNode.replaceChild(newSaveTitleBtn, saveTitleBtn);

        newSaveTitleBtn.addEventListener('click', () => {
            const title = document.getElementById('voicyChapterTitle').value;
            localStorage.setItem('voicy_default_title', title);
            showToast('チャプタータイトルをデフォルトとして保存しました');
        });

        // 放送の説明のデフォルト保存ボタン
        const saveDescriptionBtn = document.getElementById('saveVoicyDescriptionDefaultBtn');
        const newSaveDescriptionBtn = saveDescriptionBtn.cloneNode(true);
        saveDescriptionBtn.parentNode.replaceChild(newSaveDescriptionBtn, saveDescriptionBtn);

        newSaveDescriptionBtn.addEventListener('click', () => {
            const description = document.getElementById('voicyDescription').value;
            localStorage.setItem('voicy_default_description', description);
            showToast('放送の説明をデフォルトとして保存しました');
        });

        // URLのデフォルト保存ボタン
        const saveUrlBtn = document.getElementById('saveVoicyUrlDefaultBtn');
        const newSaveUrlBtn = saveUrlBtn.cloneNode(true);
        saveUrlBtn.parentNode.replaceChild(newSaveUrlBtn, saveUrlBtn);

        newSaveUrlBtn.addEventListener('click', () => {
            const url = document.getElementById('voicyChapterUrl').value;
            localStorage.setItem('voicy_default_url', url);
            showToast('URLをデフォルトとして保存しました');
        });

        // 投稿時間のデフォルト保存ボタン
        const saveTimeBtn = document.getElementById('saveVoicyTimeDefaultBtn');
        const newSaveTimeBtn = saveTimeBtn.cloneNode(true);
        saveTimeBtn.parentNode.replaceChild(newSaveTimeBtn, saveTimeBtn);

        newSaveTimeBtn.addEventListener('click', () => {
            const time = document.getElementById('voicyPublishTime').value;
            localStorage.setItem('voicy_default_time', time);
            showToast('投稿時間をデフォルトとして保存しました');
        });

        // ハッシュタグのデフォルト保存ボタン
        const saveHashtagBtn = document.getElementById('saveVoicyDefaultBtn');
        const newSaveHashtagBtn = saveHashtagBtn.cloneNode(true);
        saveHashtagBtn.parentNode.replaceChild(newSaveHashtagBtn, saveHashtagBtn);

        newSaveHashtagBtn.addEventListener('click', () => {
            const hashtags = document.getElementById('voicyHashtags').value;
            localStorage.setItem('voicy_default_hashtags', hashtags);
            showToast('ハッシュタグをデフォルトとして保存しました');
        });

    } else {
        console.error('Voicy投稿モーダルが見つかりません');
    }
}

// Spotify投稿モーダル関連の変数
let currentSpotifyTargetFile = null

// Spotifyに投稿（グローバル関数として定義）
window.publishToSpotify = async function publishToSpotify(basename, initialDate) {
    console.log('Spotify投稿関数が呼び出されました:', basename, 'InitialDate:', initialDate)
    currentSpotifyTargetFile = basename

    // UIを更新
    const modal = document.getElementById('spotifyPublishModal')
    try {
        if (modal) {
            let dateStr = ''

            // 優先順位:
            // 1. 引数で渡された日時 (initialDate) - カードに表示されている日時
            // 2. ファイル名から解析された日時
            // 3. 明日

            if (initialDate && !isNaN(new Date(initialDate).getTime())) {
                // initialDateが有効な場合
                const d = new Date(initialDate)
                const year = d.getFullYear()
                const month = String(d.getMonth() + 1).padStart(2, '0')
                const day = String(d.getDate()).padStart(2, '0')
                dateStr = `${year}-${month}-${day}`
            } else {
                // フォールバック: ファイル名または明日
                let targetDate = new Date()
                targetDate.setDate(targetDate.getDate() + 1)

                try {
                    const dateMatch = basename.match(/^(\d{4})(\d{2})(\d{2})/)
                    if (dateMatch) {
                        const year = parseInt(dateMatch[1])
                        const month = parseInt(dateMatch[2]) - 1
                        const day = parseInt(dateMatch[3])
                        const fileDate = new Date(year, month, day)
                        if (!isNaN(fileDate.getTime())) {
                            targetDate = fileDate
                        }
                    }
                } catch (e) {
                    console.error('日付解析エラー:', e)
                }

                const year = targetDate.getFullYear()
                const month = String(targetDate.getMonth() + 1).padStart(2, '0')
                const day = String(targetDate.getDate()).padStart(2, '0')
                dateStr = `${year}-${month}-${day}`
            }

            const dateInput = document.getElementById('spotifyPublishDate')
            if (dateInput) {
                dateInput.value = dateStr
            }

            // タイトルの設定
            const titleInput = document.getElementById('spotifyBroadcastTitle')
            if (titleInput) {
                // メタデータからタイトルを取得
                const currentMetadata = metadata[basename] || {}
                titleInput.value = currentMetadata.title || ''
            }

            // 時間のデフォルト値を読み込み
            const savedTime = await ipcRenderer.invoke('get-config', 'spotifyDefaultTime')
            const timeInput = document.getElementById('spotifyPublishTime')
            if (timeInput) {
                timeInput.value = savedTime || '06:00'
            }

            // 時間保存ボタンのイベントリスナー
            const saveTimeBtn = document.getElementById('saveSpotifyTimeDefaultBtn')
            if (saveTimeBtn) {
                const newSaveTimeBtn = saveTimeBtn.cloneNode(true)
                saveTimeBtn.parentNode.replaceChild(newSaveTimeBtn, saveTimeBtn)

                newSaveTimeBtn.addEventListener('click', () => {
                    const currentTime = document.getElementById('spotifyPublishTime').value
                    ipcRenderer.invoke('set-config', 'spotifyDefaultTime', currentTime)

                    // ボタンの見た目を更新
                    const originalHtml = newSaveTimeBtn.innerHTML
                    newSaveTimeBtn.innerHTML = '<i data-lucide="check" class="w-3 h-3"></i>保存しました'
                    lucide.createIcons()

                    setTimeout(() => {
                        newSaveTimeBtn.innerHTML = originalHtml
                        lucide.createIcons()
                    }, 2000)
                })
            }

            // 説明文のデフォルト値を読み込み
            const savedDescription = await ipcRenderer.invoke('get-config', 'spotifyDefaultDescription')
            const descriptionInput = document.getElementById('spotifyDescription')
            if (descriptionInput) {
                const defaultDesc = ''
                descriptionInput.value = savedDescription !== null && savedDescription !== undefined ? savedDescription : defaultDesc
            }

            // 説明文保存ボタンのイベントリスナー
            const saveDescBtn = document.getElementById('saveSpotifyDescriptionDefaultBtn')
            if (saveDescBtn) {
                const newSaveDescBtn = saveDescBtn.cloneNode(true)
                saveDescBtn.parentNode.replaceChild(newSaveDescBtn, saveDescBtn)

                newSaveDescBtn.addEventListener('click', () => {
                    const currentDesc = document.getElementById('spotifyDescription').value
                    ipcRenderer.invoke('set-config', 'spotifyDefaultDescription', currentDesc)

                    // ボタンの見た目を更新
                    const originalHtml = newSaveDescBtn.innerHTML
                    newSaveDescBtn.innerHTML = '<i data-lucide="check" class="w-3 h-3"></i>保存しました'
                    lucide.createIcons()

                    setTimeout(() => {
                        newSaveDescBtn.innerHTML = originalHtml
                        lucide.createIcons()
                    }, 2000)
                })
            }

            // 放送画像設定の初期化
            const savedImage = await ipcRenderer.invoke('get-config', 'spotifyDefaultImage')
            const imageStatus = document.getElementById('spotifyImageStatus')
            const imagePreview = document.getElementById('spotifyImagePreview')
            const imageInfo = document.getElementById('spotifyImageInfo')
            const imageName = document.getElementById('spotifyImageName')
            const clearImageBtn = document.getElementById('clearSpotifyImageBtn')
            const imageInput = document.getElementById('spotifyImageInput')
            const selectImageBtn = document.getElementById('selectSpotifyImageBtn')

            const updateImageUI = (path) => {
                console.log('Updating Image UI with path:', path)
                if (path) {
                    // ファイルが存在するか確認（非同期だがUI更新は先に行う）
                    ipcRenderer.invoke('check-file-exists', path).then(exists => {
                        if (!exists) {
                            console.warn('Saved image file not found:', path)
                        } else {
                            console.log('Saved image file confirmed to exist')
                        }
                    })

                    if (imageStatus) imageStatus.classList.add('hidden')

                    if (imagePreview) {
                        // file:// プロトコルを明示的に付与
                        const srcPath = path.startsWith('file://') ? path : `file://${path}`
                        imagePreview.src = srcPath
                        imagePreview.classList.remove('hidden')
                    }

                    if (imageInfo) {
                        imageInfo.classList.remove('hidden')
                        imageInfo.classList.add('flex')
                    }

                    if (imageName) {
                        const filename = path.split(/[/\\]/).pop()
                        imageName.textContent = filename || path
                        imageName.classList.remove('hidden')
                    }

                    if (clearImageBtn) clearImageBtn.classList.remove('hidden')
                } else {
                    if (imageStatus) {
                        imageStatus.classList.remove('hidden')
                        imageStatus.textContent = '未設定'
                    }

                    if (imagePreview) {
                        imagePreview.classList.add('hidden')
                        imagePreview.src = ''
                    }

                    if (imageInfo) {
                        imageInfo.classList.add('hidden')
                        imageInfo.classList.remove('flex')
                    }

                    if (imageName) {
                        imageName.classList.add('hidden')
                        imageName.textContent = ''
                    }

                    if (clearImageBtn) clearImageBtn.classList.add('hidden')
                }
            }

            // 保存された画像パスを設定
            updateImageUI(savedImage || null)

            // 画像選択ボタンと画像入力の処理
            if (selectImageBtn && imageInput) {
                // Inputを再生成（リスナー除去のため）
                const newImageInput = imageInput.cloneNode(true)
                imageInput.parentNode.replaceChild(newImageInput, imageInput)

                // Buttonを再生成（リスナー除去のため）
                const newSelectImageBtn = selectImageBtn.cloneNode(true)
                selectImageBtn.parentNode.replaceChild(newSelectImageBtn, selectImageBtn)

                // ボタンが新しいInputをクリックするように設定
                newSelectImageBtn.addEventListener('click', async () => {
                    console.log('Select image button clicked')
                    try {
                        const selectedPath = await ipcRenderer.invoke('select-image-file')
                        console.log('Image selected via dialog:', selectedPath)

                        if (!selectedPath) return

                        const result = await ipcRenderer.invoke('save-broadcast-image', selectedPath)

                        if (result.success) {
                            console.log('Image saved internally:', result.path)
                            ipcRenderer.invoke('set-config', 'spotifyDefaultImage', result.path)
                            updateImageUI(result.path)
                        } else {
                            console.error('Failed to save image internally:', result.error)
                            alert('画像の保存に失敗しました: ' + result.error)
                        }
                    } catch (err) {
                        console.error('Error selecting/saving image:', err)
                        alert('画像の保存中にエラーが発生しました')
                    }
                })

                // 新しいInputにchangeイベントを設定
                newImageInput.addEventListener('change', async (e) => {
                    console.log('Image input changed', e.target.files)
                    if (e.target.files && e.target.files.length > 0) {
                        const file = e.target.files[0]
                        const originalPath = file.path || file.webkitRelativePath || null

                        console.log('Image selected:', originalPath)

                        try {
                            // メインプロセス経由でアプリ内部領域に保存
                            const result = await ipcRenderer.invoke('save-broadcast-image', originalPath)

                            if (result.success) {
                                console.log('Image saved internally:', result.path)
                                ipcRenderer.invoke('set-config', 'spotifyDefaultImage', result.path)
                                updateImageUI(result.path)
                            } else {
                                console.error('Failed to save image internally:', result.error)
                                alert('画像の保存に失敗しました: ' + result.error)
                            }
                        } catch (err) {
                            console.error('IPC error during image save:', err)
                            alert('画像の保存中にエラーが発生しました')
                        }
                    }
                })
            }

            // 画像クリアボタンの処理
            if (clearImageBtn) {
                const newClearImageBtn = clearImageBtn.cloneNode(true)
                clearImageBtn.parentNode.replaceChild(newClearImageBtn, clearImageBtn)
                newClearImageBtn.addEventListener('click', () => {
                    ipcRenderer.invoke('set-config', 'spotifyDefaultImage', null)
                    updateImageUI(null)
                    // 画像入力もリセット（再取得してリセット）
                    const currentInput = document.getElementById('spotifyImageInput')
                    if (currentInput) currentInput.value = ''
                })
            }

            // 投稿ボタンのイベントリスナー
            const confirmBtn = document.getElementById('confirmSpotifyPublishBtn')
            if (confirmBtn) {
                const newConfirmBtn = confirmBtn.cloneNode(true)
                confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn)

                newConfirmBtn.addEventListener('click', () => {
                    executeSpotifyPublish()
                })
            }

            // モーダルを表示
            modal.classList.remove('opacity-0', 'pointer-events-none')
            modal.setAttribute('aria-hidden', 'false')
            lucide.createIcons()
        } else {
            console.error('Spotify投稿モーダルが見つかりません')
        }
    } catch (error) {
        console.error('Spotify投稿モーダル表示中にエラーが発生しました:', error)
        alert('エラーが発生しました: ' + error.message)
    }
}

// Voicy投稿処理の実行
async function executeVoicyPublish() {
    if (!currentVoicyTargetFile) return;

    try {
        const broadcastTitle = document.getElementById('voicyBroadcastTitle').value;
        const chapterTitle = document.getElementById('voicyChapterTitle').value;
        const description = document.getElementById('voicyDescription').value;
        const url = document.getElementById('voicyChapterUrl').value;
        const hashtags = document.getElementById('voicyHashtags').value;
        const publishTime = document.getElementById('voicyPublishTime').value;
        const publishDate = document.getElementById('voicyPublishDate') ? document.getElementById('voicyPublishDate').value : '';

        // 未来チェック
        if (publishDate && publishTime) {
            const scheduledDateTime = new Date(`${publishDate}T${publishTime}`);
            const now = new Date();
            if (scheduledDateTime <= now) {
                alert('予約投稿日時は現在時刻より未来である必要があります。');
                return;
            }
        } else {
            alert('予約投稿日時が正しく設定されていません。');
            return;
        }

        const button = document.getElementById('confirmVoicyPublishBtn');
        const originalHTML = button.innerHTML;
        button.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i>処理中...';
        button.disabled = true;
        lucide.createIcons();

        const result = await ipcRenderer.invoke('publish-to-voicy', currentVoicyTargetFile, broadcastTitle, chapterTitle, url, hashtags, publishTime, publishDate, description);

        if (result.success) {
            console.log(result.message);
            closeVoicyPublishModal();
            await loadAudioFiles(); // ステータス更新のため再読み込み
            showToast('Voicyへの投稿が完了しました！');
        } else {
            showToast(`Voicy投稿エラー: ${result.message}`, 'error');
        }

        button.innerHTML = originalHTML;
        button.disabled = false;
        lucide.createIcons();

    } catch (error) {
        console.error('Voicy投稿エラー:', error);
        showToast('Voicy投稿の実行に失敗しました', 'error');

        const button = document.getElementById('confirmVoicyPublishBtn');
        if (button) {
            button.innerHTML = '<i data-lucide="send" class="w-4 h-4"></i>投稿する';
            button.disabled = false;
            lucide.createIcons();
        }
    }
}

// Voicy投稿モーダルを閉じる（グローバルスコープで利用可能にする）
window.closeVoicyPublishModal = function () {
    const modal = document.getElementById('voicyPublishModal');
    if (modal) {
        modal.classList.add('opacity-0', 'pointer-events-none');
        currentVoicyTargetFile = null;
    }
}

// 文字起こしセットアップヘルプモーダル
window.onClickOpenTranscribeHelpModal = function () {
    const modal = document.getElementById('transcribeHelpModal')
    if (!modal) return

    modal.classList.remove('opacity-0', 'pointer-events-none')
    modal.setAttribute('aria-hidden', 'false')
}

window.onClickCloseTranscribeHelpModal = function () {
    const modal = document.getElementById('transcribeHelpModal')
    if (!modal) return

    modal.classList.add('opacity-0', 'pointer-events-none')
    modal.setAttribute('aria-hidden', 'true')
}

window.onClickCopyCodeBlock = async function (buttonElement) {
    try {
        const container = buttonElement && buttonElement.parentElement ? buttonElement.parentElement : null
        const pre = container ? container.querySelector('pre') : null
        const text = pre ? pre.textContent.trim() : ''

        if (!text) {
            showToast('コピーするコマンドが見つかりません', 'error')
            return
        }

        try {
            await navigator.clipboard.writeText(text)
            showToast('コマンドをコピーしました')
            return
        } catch (e) {
            const textArea = document.createElement('textarea')
            textArea.value = text
            document.body.appendChild(textArea)
            textArea.select()
            document.execCommand('copy')
            document.body.removeChild(textArea)
            showToast('コマンドをコピーしました')
        }
    } catch (error) {
        console.error('コマンドコピーエラー:', error)
        showToast('コピーに失敗しました', 'error')
    }
}

document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return

    const modal = document.getElementById('transcribeHelpModal')
    if (!modal) return
    if (modal.classList.contains('pointer-events-none')) return

    window.onClickCloseTranscribeHelpModal()
})

// Stand.fm投稿モーダル関連の変数
let currentStandfmTargetFile = null;

// Stand.fmに投稿（グローバル関数として定義）
window.publishToStandfm = async function publishToStandfm(basename, initialDate) {
    console.log('Stand.fm投稿関数が呼び出されました:', basename, 'InitialDate:', initialDate);
    currentStandfmTargetFile = basename;

    // UIを更新
    const modal = document.getElementById('standfmPublishModal');
    try {
        if (modal) {
            let dateStr = '';

            // 優先順位:
            // 1. 引数で渡された日時 (initialDate) - カードに表示されている日時
            // 2. ファイル名から解析された日時
            // 3. 明日

            if (initialDate && !isNaN(new Date(initialDate).getTime())) {
                // initialDateが有効な場合
                const d = new Date(initialDate);
                const year = d.getFullYear();
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                dateStr = `${year}-${month}-${day}`;
            } else {
                // フォールバック: ファイル名または明日
                let targetDate = new Date();
                targetDate.setDate(targetDate.getDate() + 1);

                try {
                    const dateMatch = basename.match(/^(\d{4})(\d{2})(\d{2})/);
                    if (dateMatch) {
                        const year = parseInt(dateMatch[1]);
                        const month = parseInt(dateMatch[2]) - 1;
                        const day = parseInt(dateMatch[3]);
                        const fileDate = new Date(year, month, day);
                        if (!isNaN(fileDate.getTime())) {
                            targetDate = fileDate;
                        }
                    }
                } catch (e) {
                    console.error('日付解析エラー:', e);
                }

                const year = targetDate.getFullYear();
                const month = String(targetDate.getMonth() + 1).padStart(2, '0');
                const day = String(targetDate.getDate()).padStart(2, '0');
                dateStr = `${year}-${month}-${day}`;
            }

            const dateInput = document.getElementById('standfmPublishDate');
            if (dateInput) {
                dateInput.value = dateStr;
            }

            // タイトルの設定
            const titleInput = document.getElementById('standfmBroadcastTitle');
            if (titleInput) {
                // メタデータからタイトルを取得
                const currentMetadata = metadata[basename] || {};
                titleInput.value = currentMetadata.title || '';
            }

            // 時間のデフォルト値を読み込み
            const savedTime = await ipcRenderer.invoke('get-config', 'standfmDefaultTime');
            const timeInput = document.getElementById('standfmPublishTime');
            if (timeInput) {
                timeInput.value = savedTime || '06:10';
            }

            // 時間保存ボタンのイベントリスナー
            const saveTimeBtn = document.getElementById('saveStandfmTimeDefaultBtn');
            if (saveTimeBtn) {
                const newSaveTimeBtn = saveTimeBtn.cloneNode(true);
                saveTimeBtn.parentNode.replaceChild(newSaveTimeBtn, saveTimeBtn);

                newSaveTimeBtn.addEventListener('click', () => {
                    const currentTime = document.getElementById('standfmPublishTime').value;
                    ipcRenderer.invoke('set-config', 'standfmDefaultTime', currentTime);

                    // ボタンの見た目を更新
                    const originalHtml = newSaveTimeBtn.innerHTML;
                    newSaveTimeBtn.innerHTML = '<i data-lucide="check" class="w-3 h-3"></i>保存しました';
                    lucide.createIcons();

                    setTimeout(() => {
                        newSaveTimeBtn.innerHTML = originalHtml;
                        lucide.createIcons();
                    }, 2000);
                });
            }

            // 説明文のデフォルト値を読み込み
            const savedDescription = await ipcRenderer.invoke('get-config', 'standfmDefaultDescription');
            const descriptionInput = document.getElementById('standfmDescription');
            if (descriptionInput) {
                const defaultDesc = '';
                descriptionInput.value = savedDescription !== null && savedDescription !== undefined ? savedDescription : defaultDesc;
            }

            // 説明文保存ボタンのイベントリスナー
            const saveDescBtn = document.getElementById('saveStandfmDescriptionDefaultBtn');
            if (saveDescBtn) {
                const newSaveDescBtn = saveDescBtn.cloneNode(true);
                saveDescBtn.parentNode.replaceChild(newSaveDescBtn, saveDescBtn);

                newSaveDescBtn.addEventListener('click', () => {
                    const currentDesc = document.getElementById('standfmDescription').value;
                    ipcRenderer.invoke('set-config', 'standfmDefaultDescription', currentDesc);

                    // ボタンの見た目を更新
                    const originalHtml = newSaveDescBtn.innerHTML;
                    newSaveDescBtn.innerHTML = '<i data-lucide="check" class="w-3 h-3"></i>保存しました';
                    lucide.createIcons();

                    setTimeout(() => {
                        newSaveDescBtn.innerHTML = originalHtml;
                        lucide.createIcons();
                    }, 2000);
                });
            }

            // カテゴリのデフォルト値を読み込み
            const savedCategory = await ipcRenderer.invoke('get-config', 'standfmDefaultCategory');
            const categorySelect = document.getElementById('standfmCategory');
            if (categorySelect) {
                categorySelect.value = savedCategory || 'ビジネス';
            }

            // カテゴリ保存ボタンのイベントリスナーを設定
            const saveCategoryBtn = document.getElementById('saveStandfmCategoryDefaultBtn');
            if (saveCategoryBtn) {
                const newSaveCategoryBtn = saveCategoryBtn.cloneNode(true);
                saveCategoryBtn.parentNode.replaceChild(newSaveCategoryBtn, saveCategoryBtn);

                newSaveCategoryBtn.addEventListener('click', () => {
                    const currentCategory = document.getElementById('standfmCategory').value;
                    ipcRenderer.invoke('set-config', 'standfmDefaultCategory', currentCategory);

                    // ボタンの見た目を更新してフィードバック
                    const originalHtml = newSaveCategoryBtn.innerHTML;
                    newSaveCategoryBtn.innerHTML = '<i data-lucide="check" class="w-3 h-3"></i>保存しました';
                    lucide.createIcons();

                    setTimeout(() => {
                        newSaveCategoryBtn.innerHTML = originalHtml;
                        lucide.createIcons();
                    }, 2000);
                });
            }

            // 放送画像設定の初期化
            const savedImage = await ipcRenderer.invoke('get-config', 'standfmDefaultImage');
            const imageStatus = document.getElementById('standfmImageStatus');
            const imagePreview = document.getElementById('standfmImagePreview');
            const imageInfo = document.getElementById('standfmImageInfo');
            const imageName = document.getElementById('standfmImageName');
            const clearImageBtn = document.getElementById('clearStandfmImageBtn');

            const updateImageUI = (path) => {
                console.log('Updating Image UI with path:', path);
                if (path) {
                    // ファイルが存在するか確認（非同期だがUI更新は先に行う）
                    ipcRenderer.invoke('check-file-exists', path).then(exists => {
                        if (!exists) {
                            console.warn('Saved image file not found:', path);
                            // ファイルがない場合はリセットする？
                            // localStorage.removeItem('standfmDefaultImage');
                            // updateImageUI(null);  // 無限ループ注意
                            // 表示を「見つかりません」にするなどの対応も可
                        } else {
                            console.log('Saved image file confirmed to exist');
                        }
                    });

                    if (imageStatus) imageStatus.classList.add('hidden');

                    if (imagePreview) {
                        // file:// プロトコルを明示的に付与
                        const srcPath = path.startsWith('file://') ? path : `file://${path}`;
                        imagePreview.src = srcPath;
                        imagePreview.classList.remove('hidden');
                    }

                    if (imageInfo) {
                        imageInfo.classList.remove('hidden');
                        imageInfo.classList.add('flex');
                    }

                    if (imageName) {
                        const filename = path.split(/[/\\]/).pop();
                        imageName.textContent = filename || path;
                        imageName.classList.remove('hidden');
                    }

                    if (clearImageBtn) clearImageBtn.classList.remove('hidden');
                } else {
                    if (imageStatus) {
                        imageStatus.classList.remove('hidden');
                        imageStatus.textContent = '未設定';
                    }

                    if (imagePreview) {
                        imagePreview.classList.add('hidden');
                        imagePreview.src = '';
                    }

                    if (imageInfo) {
                        imageInfo.classList.add('hidden');
                        imageInfo.classList.remove('flex');
                    }

                    if (clearImageBtn) clearImageBtn.classList.add('hidden');
                }
            };

            // 初期表示更新
            updateImageUI(savedImage);

            const selectImageBtn = document.getElementById('selectStandfmImageBtn');
            const imageInput = document.getElementById('standfmImageInput');

            if (selectImageBtn && imageInput) {
                // Inputを再生成（リスナー除去のため）
                const newImageInput = imageInput.cloneNode(true);
                imageInput.parentNode.replaceChild(newImageInput, imageInput);

                // Buttonを再生成（リスナー除去のため）
                const newSelectImageBtn = selectImageBtn.cloneNode(true);
                selectImageBtn.parentNode.replaceChild(newSelectImageBtn, selectImageBtn);

                // ボタンが新しいInputをクリックするように設定
                newSelectImageBtn.addEventListener('click', async () => {
                    console.log('Select image button clicked');
                    try {
                        const selectedPath = await ipcRenderer.invoke('select-image-file')
                        console.log('Image selected via dialog:', selectedPath)

                        if (!selectedPath) return

                        const result = await ipcRenderer.invoke('save-broadcast-image', selectedPath)

                        if (result.success) {
                            console.log('Image saved internally:', result.path)
                            ipcRenderer.invoke('set-config', 'standfmDefaultImage', result.path)
                            updateImageUI(result.path)
                        } else {
                            console.error('Failed to save image internally:', result.error)
                            alert('画像の保存に失敗しました: ' + result.error)
                        }
                    } catch (err) {
                        console.error('Error selecting/saving image:', err)
                        alert('画像の保存中にエラーが発生しました')
                    }
                })

                // 新しいInputにchangeイベントを設定
                newImageInput.addEventListener('change', async (e) => {
                    console.log('Image input changed', e.target.files);
                    if (e.target.files && e.target.files.length > 0) {
                        const file = e.target.files[0];
                        const originalPath = file.path || file.webkitRelativePath || null

                        console.log('Image selected:', originalPath);

                        try {
                            // メインプロセス経由でアプリ内部領域に保存
                            // ボタンを一時的に無効化またはローディング表示にするとより良いが、ここでは簡易実装
                            const result = await ipcRenderer.invoke('save-broadcast-image', originalPath);

                            if (result.success) {
                                console.log('Image saved internally:', result.path);
                                ipcRenderer.invoke('set-config', 'standfmDefaultImage', result.path);
                                updateImageUI(result.path);
                            } else {
                                console.error('Failed to save image internally:', result.error);
                                alert('画像の保存に失敗しました: ' + result.error);
                            }
                        } catch (err) {
                            console.error('IPC error during image save:', err);
                            alert('画像の保存中にエラーが発生しました');
                        }
                    }
                });

                // 変数を更新（後の参照のため）
                // 注意: constで宣言されているため、ここでの更新はローカルスコープ変数として扱うか、
                // クリアボタンのロジックでDOMから再取得する必要がある。
                // 以下のクリアボタンのロジックではIDから取得しなおすか、このnewImageInputを使うように修正が必要。
            }

            // 画像クリアボタンの処理
            if (clearImageBtn) {
                const newClearImageBtn = clearImageBtn.cloneNode(true);
                clearImageBtn.parentNode.replaceChild(newClearImageBtn, clearImageBtn);
                newClearImageBtn.addEventListener('click', () => {
                    ipcRenderer.invoke('set-config', 'standfmDefaultImage', null);
                    updateImageUI(null);
                    // 画像入力もリセット（再取得してリセット）
                    const currentInput = document.getElementById('standfmImageInput');
                    if (currentInput) currentInput.value = '';
                });
            }
            const savedBgm = await ipcRenderer.invoke('get-config', 'standfmDefaultBgm');
            const bgmSelect = document.getElementById('standfmBgm');
            if (bgmSelect) {
                bgmSelect.value = savedBgm || ''; // 保存されていない場合は「なし」
            }

            // BGM保存ボタンのイベントリスナーを設定
            const saveBgmBtn = document.getElementById('saveStandfmBgmDefaultBtn');
            if (saveBgmBtn) {
                const newSaveBgmBtn = saveBgmBtn.cloneNode(true);
                saveBgmBtn.parentNode.replaceChild(newSaveBgmBtn, saveBgmBtn);

                newSaveBgmBtn.addEventListener('click', () => {
                    const currentBgm = document.getElementById('standfmBgm').value;
                    ipcRenderer.invoke('set-config', 'standfmDefaultBgm', currentBgm); // Saving

                    // ボタンの見た目を更新してフィードバック
                    const originalHtml = newSaveBgmBtn.innerHTML;
                    newSaveBgmBtn.innerHTML = '<i data-lucide="check" class="w-3 h-3"></i>保存しました';
                    lucide.createIcons();

                    setTimeout(() => {
                        newSaveBgmBtn.innerHTML = originalHtml;
                        lucide.createIcons();
                    }, 2000);
                });
            }

            // モーダルを表示
            console.log('Showing Stand.fm modal via classList manipulation');
            modal.classList.remove('opacity-0', 'pointer-events-none');

            // アニメーション用のクラス操作 (必要であれば)
            const modalContent = modal.querySelector('div.relative');
            if (modalContent) {
                modalContent.classList.remove('scale-95');
                modalContent.classList.add('scale-100');
            }

            // 投稿ボタンのイベントリスナーを設定
            const confirmBtn = document.getElementById('confirmStandfmPublishBtn');
            const newConfirmBtn = confirmBtn.cloneNode(true);
            confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

            newConfirmBtn.addEventListener('click', () => executeStandfmPublish());

            lucide.createIcons();
        } else {
            console.error('Stand.fm投稿モーダルが見つかりません');
        }
    } catch (error) {
        console.error('Stand.fm投稿モーダル表示中にエラーが発生しました:', error);
        alert('エラーが発生しました: ' + error.message);
    }
}

// Stand.fm投稿処理の実行
// Stand.fm投稿処理の実行
async function executeStandfmPublish() {
    if (!currentStandfmTargetFile) return;

    try {
        const description = document.getElementById('standfmDescription').value;
        const bgm = document.getElementById('standfmBgm') ? document.getElementById('standfmBgm').value : '';
        const category = document.getElementById('standfmCategory') ? document.getElementById('standfmCategory').value : 'ビジネス';
        const imagePath = await ipcRenderer.invoke('get-config', 'standfmDefaultImage') || '';
        const publishDate = document.getElementById('standfmPublishDate') ? document.getElementById('standfmPublishDate').value : '';
        const publishTime = document.getElementById('standfmPublishTime') ? document.getElementById('standfmPublishTime').value : '';
        const broadcastTitle = document.getElementById('standfmBroadcastTitle') ? document.getElementById('standfmBroadcastTitle').value : '';

        const button = document.getElementById('confirmStandfmPublishBtn');
        const originalHTML = button.innerHTML;

        console.log('ボタンを無効化します');

        // ボタンを無効化してローディング状態にする
        button.disabled = true;
        button.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i>投稿中...';
        lucide.createIcons();

        console.log(`IPCでStand.fm投稿を開始します。Title: ${broadcastTitle}, Category: ${category}, BGM: ${bgm}, Image: ${imagePath}, Date: ${publishDate}, Time: ${publishTime}`);

        const result = await ipcRenderer.invoke('publish-to-standfm',
            currentStandfmTargetFile,
            description,
            bgm,
            publishDate,
            publishTime,
            category,
            imagePath,
            broadcastTitle
        );
        console.log('Stand.fm投稿結果:', result);

        if (result.success) {
            console.log(result.message);
            closeStandfmPublishModal();
            // Stand.fm投稿済みステータスを更新
            await loadAudioFiles();
            alert('Stand.fmへの投稿が完了しました！');
        } else {
            alert(`Stand.fm投稿エラー: ${result.message}`);
        }

        button.innerHTML = originalHTML;
        button.disabled = false;
        lucide.createIcons();

    } catch (error) {
        console.error('Stand.fm投稿エラー:', error);
        alert('Stand.fm投稿の実行に失敗しました: ' + error.message);

        const button = document.getElementById('confirmStandfmPublishBtn');
        if (button) {
            button.innerHTML = '<i data-lucide="send" class="w-4 h-4"></i>投稿する';
            button.disabled = false;
            lucide.createIcons();
        }
    }
}

// Stand.fm投稿モーダルを閉じる
window.closeStandfmPublishModal = function () {
    const modal = document.getElementById('standfmPublishModal');
    if (modal) {
        modal.classList.add('opacity-0', 'pointer-events-none');
        currentStandfmTargetFile = null;
    }
}

// Spotify投稿処理の実行
async function executeSpotifyPublish() {
    if (!currentSpotifyTargetFile) return

    try {
        const description = document.getElementById('spotifyDescription').value
        const imagePath = await ipcRenderer.invoke('get-config', 'spotifyDefaultImage') || ''
        const publishDate = document.getElementById('spotifyPublishDate') ? document.getElementById('spotifyPublishDate').value : ''
        const publishTime = document.getElementById('spotifyPublishTime') ? document.getElementById('spotifyPublishTime').value : ''
        const broadcastTitle = document.getElementById('spotifyBroadcastTitle') ? document.getElementById('spotifyBroadcastTitle').value : ''

        const button = document.getElementById('confirmSpotifyPublishBtn')
        const originalHTML = button.innerHTML

        console.log('ボタンを無効化します')

        // ボタンを無効化してローディング状態にする
        button.disabled = true
        button.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i>投稿中...'
        lucide.createIcons()

        console.log(`IPCでSpotify投稿を開始します。Title: ${broadcastTitle}, Image: ${imagePath}, Date: ${publishDate}, Time: ${publishTime}`)

        const result = await ipcRenderer.invoke('publish-to-spotify',
            currentSpotifyTargetFile,
            broadcastTitle,
            description,
            imagePath,
            publishDate,
            publishTime
        )
        console.log('Spotify投稿結果:', result)

        if (result.success) {
            console.log(result.message)
            closeSpotifyPublishModal()
            // Spotify投稿済みステータスを更新
            await loadAudioFiles()
            showToast('Spotifyへの投稿が完了しました！')
        } else {
            showToast(`Spotify投稿エラー: ${result.message}`, 'error')
        }

        button.innerHTML = originalHTML
        button.disabled = false
        lucide.createIcons()

    } catch (error) {
        console.error('Spotify投稿エラー:', error)
        showToast('Spotify投稿の実行に失敗しました: ' + error.message, 'error')

        const button = document.getElementById('confirmSpotifyPublishBtn')
        if (button) {
            button.innerHTML = '<i data-lucide="send" class="w-4 h-4"></i>投稿する'
            button.disabled = false
            lucide.createIcons()
        }
    }
}

// Spotify投稿モーダルを閉じる
window.closeSpotifyPublishModal = function () {
    const modal = document.getElementById('spotifyPublishModal')
    if (modal) {
        modal.classList.add('opacity-0', 'pointer-events-none')
        currentSpotifyTargetFile = null
    }
}



// 外部URLを開く
async function openExternalUrl(url) {
    try {
        const result = await ipcRenderer.invoke('open-external-url', url);
        if (!result.success) {
            console.error('URLを開く際にエラーが発生しました:', result.message);
        }
    } catch (error) {
        console.error('外部URLを開くエラー:', error);
    }
}

// 投稿状態をリセット
async function resetPublishStatus(basename, platform) {
    const platformNames = {
        'voicy': 'Voicy',
        'standfm': 'stand.fm',
        'spotify': 'Spotify'
    };
    const platformName = platformNames[platform] || platform;

    if (!confirm(`${platformName}の投稿済み状態を未投稿に戻しますか？`)) {
        return;
    }

    try {
        const result = await ipcRenderer.invoke('reset-publish-status', basename, platform);

        if (result.success) {
            // メタデータを再読み込みしてからファイルリストを更新
            await loadMetadata();
            await loadAudioFiles();
        } else {
            alert(`投稿状態のリセットに失敗しました: ${result.message}`);
        }
    } catch (error) {
        console.error('投稿状態リセットエラー:', error);
        alert('投稿状態のリセットに失敗しました');
    }
}

// プラットフォーム設定モーダルを開く
window.openPlatformSettingsModal = function() {
    const modal = document.getElementById('platformSettingsModal');
    if (!modal) return;

    // 現在の設定を反映
    document.getElementById('platformStandfmEnabled').checked = platformSettings.standfm;
    document.getElementById('platformVoicyEnabled').checked = platformSettings.voicy;
    document.getElementById('platformSpotifyEnabled').checked = platformSettings.spotify;

    // イベントリスナーを設定
    const standfmCheckbox = document.getElementById('platformStandfmEnabled');
    const voicyCheckbox = document.getElementById('platformVoicyEnabled');
    const spotifyCheckbox = document.getElementById('platformSpotifyEnabled');

    // 既存のリスナーを削除してから新しいリスナーを追加
    const newStandfmCheckbox = standfmCheckbox.cloneNode(true);
    standfmCheckbox.parentNode.replaceChild(newStandfmCheckbox, standfmCheckbox);
    newStandfmCheckbox.checked = platformSettings.standfm;
    newStandfmCheckbox.addEventListener('change', async (e) => {
        platformSettings.standfm = e.target.checked;
        await savePlatformSettings();
        updatePlatformVisibility();
    });

    const newVoicyCheckbox = voicyCheckbox.cloneNode(true);
    voicyCheckbox.parentNode.replaceChild(newVoicyCheckbox, voicyCheckbox);
    newVoicyCheckbox.checked = platformSettings.voicy;
    newVoicyCheckbox.addEventListener('change', async (e) => {
        platformSettings.voicy = e.target.checked;
        await savePlatformSettings();
        updatePlatformVisibility();
    });

    const newSpotifyCheckbox = spotifyCheckbox.cloneNode(true);
    spotifyCheckbox.parentNode.replaceChild(newSpotifyCheckbox, spotifyCheckbox);
    newSpotifyCheckbox.checked = platformSettings.spotify;
    newSpotifyCheckbox.addEventListener('change', async (e) => {
        platformSettings.spotify = e.target.checked;
        await savePlatformSettings();
        updatePlatformVisibility();
    });

    modal.classList.remove('opacity-0', 'pointer-events-none');
    lucide.createIcons();
}

// プラットフォーム設定モーダルを閉じる
window.closePlatformSettingsModal = function() {
    const modal = document.getElementById('platformSettingsModal');
    if (modal) {
        modal.classList.add('opacity-0', 'pointer-events-none');
    }
}

// グローバルスコープに公開
// グローバルスコープに公開
window.resetPublishStatus = resetPublishStatus;
window.editFile = editFile;
window.transcribeAudio = transcribeAudio;
window.copyTranscriptionPrompt = copyTranscriptionPrompt;
window.downloadTranscription = downloadTranscription;
window.publishToVoicy = publishToVoicy;
window.publishToSpotify = publishToSpotify;
window.closeSpotifyPublishModal = closeSpotifyPublishModal
