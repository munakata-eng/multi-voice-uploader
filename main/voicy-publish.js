function registerVoicyPublishHandler({ ipcMain, fs, path, getPageInstance, getAppPaths }) {
  ipcMain.handle('publish-to-voicy', async (event, basename, broadcastTitle, chapterTitle, chapterUrl, hashtagsString, publishTime, publishDate, description) => {
    try {
      console.log(`Starting Voicy publish process for: ${basename}`)

      const { audioDir, mdDir, metadataPath } = getAppPaths()

      const finalChapterTitle = typeof chapterTitle === 'string' ? chapterTitle.trim() : ''
      const finalChapterUrl = chapterUrl // 空の場合はスキップするためデフォルト値を設定しない
      const timeToPublish = publishTime || '06:00'
      const [publishHour, publishMinute] = timeToPublish.split(':')

      // 日付の処理
      let targetDateString = ''
      if (publishDate) {
        // YYYY-MM-DD -> YYYY/MM/DD
        targetDateString = publishDate.replace(/-/g, '/')
      } else {
        // ファイル名から日付を取得（フォールバック）
        const datePrefix = basename.substring(0, 8)
        if (datePrefix.length === 8 && /^\d{8}$/.test(datePrefix)) {
          const year = datePrefix.substring(0, 4)
          const month = datePrefix.substring(4, 6)
          const day = datePrefix.substring(6, 8)
          targetDateString = `${year}/${month}/${day}`
        }
      }

      // ハッシュタグの処理 (カンマ区切りまたはスペース区切りに対応)
      let hashtags = []
      if (hashtagsString && typeof hashtagsString === 'string') {
        // 全角スペースを半角に置換し、カンマもスペースに置換してから分割
        hashtags = hashtagsString.replace(/、/g, ' ').replace(/,/g, ' ').replace(/　/g, ' ').split(/\s+/).filter(tag => tag.trim() !== '')
      }

      // 放送タイトルを取得（引数で渡されたもの優先、なければMD、なければファイル名から）
      let title = broadcastTitle

      if (!title) {
        // MDファイルからタイトルを取得
        const mdFile = path.join(mdDir, basename + '.md')
        if (await fs.pathExists(mdFile)) {
          try {
            const mdContent = await fs.readFile(mdFile, 'utf8')
            const h1Match = mdContent.match(/^# (.+)$/m)
            if (h1Match) {
              title = h1Match[1].trim()
            }
          } catch (error) {
            console.error(`Error reading MD file ${basename}:`, error)
          }
        }
      }

      // MDファイルからタイトルが取得できなかった場合は、ファイル名を使用
      if (!title) {
        // yyyyMMdd_ の形式を取り除く
        const nameMatch = basename.match(/^\d{8}_(.+)$/)
        if (nameMatch) {
          title = nameMatch[1]
        } else {
          title = basename
        }
      }

      // 既存のページインスタンスを取得または新規作成
      const page = await getPageInstance()

      console.log('Navigating to Voicy CMS...')

      // Voicy CMSにアクセス（既存のページを再利用）
      await page.goto('https://va-cms.admin.voicy.jp/playlist/new', {
        waitUntil: 'networkidle2',
        timeout: 60000
      })

      console.log('Successfully accessed Voicy CMS')

      // 放送タイトル入力欄を探してタイトルを入力
      if (title) {
        await page.waitForSelector('input[formcontrolname="playlistName"]', { timeout: 30000 })

        // 既存のタイトルをクリア
        await page.evaluate(() => {
          const titleInput = document.querySelector('input[formcontrolname="playlistName"]')
          if (titleInput) {
            titleInput.value = ''
            titleInput.dispatchEvent(new Event('input', { bubbles: true }))
          }
        })

        // タイトルを入力
        await page.type('input[formcontrolname="playlistName"]', title)
        console.log(`Broadcast title set to: ${title}`)
      }

      // 放送内容の説明（概要）を入力
      if (description) {
        try {
          await page.waitForSelector('textarea[formcontrolname="description"]', { timeout: 10000 })

          // 既存の内容をクリア
          await page.evaluate(() => {
            const descInput = document.querySelector('textarea[formcontrolname="description"]')
            if (descInput) {
              descInput.value = ''
              descInput.dispatchEvent(new Event('input', { bubbles: true }))
            }
          })

          // 説明を入力
          await page.type('textarea[formcontrolname="description"]', description)
          console.log('Broadcast description set')
        } catch (e) {
          console.warn('Could not set description:', e.message)
        }
      }

      // ハッシュタグを入力
      if (hashtags.length > 0) {
        const hashtagInput = await page.waitForSelector('.hashtag-input', { timeout: 30000 })

        for (const hashtag of hashtags) {
          await hashtagInput.click()
          await hashtagInput.type(hashtag)
          await page.keyboard.press('Enter')
          console.log(`Hashtag added: ${hashtag}`)

          // 次のハッシュタグ入力のために少し待機
          await new Promise(resolve => setTimeout(resolve, 500))
        }
        console.log('All hashtags added successfully')
      }

      // チャプター名の入力欄を探す
      await page.waitForSelector('input[formcontrolname="title"]', { timeout: 30000 })

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
        await page.waitForSelector('.chapter-actions', { timeout: 30000 })

        // より簡潔なアプローチで直接ボタンをクリック
        await page.evaluate(() => {
          const buttons = document.querySelectorAll('.chapter-actions button')
          for (const button of buttons) {
            const span = button.querySelector('span')
            if (span && span.textContent.trim() === 'URL追加') {
              button.click()
              return
            }
          }
          throw new Error('URL add button not found')
        })

        console.log('URL add button clicked')

        // URLモーダルが表示されるまで待機
        await page.waitForSelector('input[name="addUrl"]', { timeout: 30000 })

        // URLを入力
        await page.type('input[name="addUrl"]', finalChapterUrl)
        console.log(`URL entered: ${finalChapterUrl}`)

        // 少し待ってから適用ボタンをクリック
        await new Promise(resolve => setTimeout(resolve, 1000))

        // 適用ボタンをクリック
        const applyButton = await page.waitForSelector('.modal-footer .btn-primary', { timeout: 30000 })
        await applyButton.click()
        console.log('Apply button clicked - URL added successfully')

        // URLモーダルが閉じるまで少し待機
        await new Promise(resolve => setTimeout(resolve, 1000))
      } else {
        console.log('URL is empty, skipping URL addition.')
      }

      // 音声アップロードボタンをクリック
      await page.evaluate(() => {
        const buttons = document.querySelectorAll('.chapter-actions button')
        for (const button of buttons) {
          const span = button.querySelector('span')
          if (span && span.textContent.trim() === '音声アップロード') {
            button.click()
            return
          }
        }
        throw new Error('Audio upload button not found')
      })

      console.log('Audio upload button clicked')

      // アップロードモーダルが表示されるまで待機
      await page.waitForSelector('input[type="file"][accept="audio/*"]', { timeout: 30000 })

      // 対応する音声ファイルを拡張子の優先順で検索（大文字拡張子にも対応）
      const audioExts = ['.mp4', '.m4a', '.mp3', '.wav']
      let audioFilePath = null
      for (const ext of audioExts) {
        const candidates = [path.join(audioDir, basename + ext), path.join(audioDir, basename + ext.toUpperCase())]
        for (const candidate of candidates) {
          if (await fs.pathExists(candidate)) {
            audioFilePath = candidate
            break
          }
        }
        if (audioFilePath) break
      }
      if (!audioFilePath) {
        throw new Error(`Audio file not found: ${basename} (tried: ${audioExts.join(', ')})`)
      }

      console.log(`Uploading audio file: ${audioFilePath}`)

      // ファイルをアップロード
      const fileInput = await page.$('input[type="file"][accept="audio/*"]')
      await fileInput.uploadFile(audioFilePath)

      console.log('Audio file uploaded successfully')

      // アップロードが完了するまで少し待機
      await new Promise(resolve => setTimeout(resolve, 3000))

      // 「日時を指定して予約」ボタンをクリック
      await page.evaluate(() => {
        const buttons = document.querySelectorAll('button')
        for (const button of buttons) {
          if (button.textContent.includes('日時を指定して予約')) {
            button.click()
            return
          }
        }
        throw new Error('Reserve button not found')
      })

      console.log('Reserve button clicked')

      // 予約設定モーダルが表示されるまで待機
      await page.waitForSelector('.app-date-input', { timeout: 30000 })

      if (!targetDateString) {
        throw new Error(`Invalid date format for publish date. Basename: ${basename}`)
      }

      // 日付入力欄に日付を設定
      const dateInput = await page.$('.app-date-input__setting-date__wrapper__input')
      await dateInput.click()
      await page.evaluate(() => {
        const input = document.querySelector('.app-date-input__setting-date__wrapper__input')
        if (input) {
          input.value = ''
        }
      })
      await dateInput.type(targetDateString)
      console.log(`Date set to: ${targetDateString}`)

      // 時間を設定
      const hourInput = await page.$('input[placeholder="HH"]')
      const minuteInput = await page.$('input[placeholder="MM"]')

      await hourInput.click()
      await page.evaluate(() => {
        const input = document.querySelector('input[placeholder="HH"]')
        if (input) {
          input.value = ''
        }
      })
      await hourInput.type(publishHour)

      await minuteInput.click()
      await page.evaluate(() => {
        const input = document.querySelector('input[placeholder="MM"]')
        if (input) {
          input.value = ''
        }
      })
      await minuteInput.type(publishMinute)

      console.log(`Time set to: ${publishHour}:${publishMinute}`)

      // 少し待ってから予約ボタンをクリック
      await new Promise(resolve => setTimeout(resolve, 1000))

      // Alertダイアログの「OK」ボタンを自動で押すためのリスナーを設定
      page.on('dialog', async dialog => {
        console.log(`Dialog appeared: ${dialog.message()}`)
        if (dialog.type() === 'confirm') {
          await dialog.accept()
          console.log('Dialog accepted (OK clicked)')
        }
      })

      // 「指定の日時で予約」ボタンをクリック
      const reserveConfirmButton = await page.waitForSelector('#reserve-playlist-button', { timeout: 30000 })
      await reserveConfirmButton.click()

      console.log('Reservation confirmed successfully')

      // Alertが表示されて処理されるまで少し待機
      await new Promise(resolve => setTimeout(resolve, 2000))

      // Voicy投稿完了をメタデータに保存
      const metadata = await fs.pathExists(metadataPath) ? await fs.readJson(metadataPath) : {}
      if (!metadata[basename]) {
        metadata[basename] = {}
      }
      metadata[basename].voicyPublished = true
      metadata[basename].voicyPublishedDate = new Date().toISOString()

      await fs.writeJson(metadataPath, metadata, { spaces: 2 })
      console.log(`Voicy published status saved for: ${basename}`)

      return {
        success: true,
        message: 'Voicy投稿が完了し、ステータスを保存しました。',
        browser: true
      }
    } catch (error) {
      console.error('Error publishing to Voicy:', error)

      return {
        success: false,
        message: `Voicy投稿でエラーが発生しました: ${error.message}`
      }
    }
  })
}

module.exports = { registerVoicyPublishHandler }

