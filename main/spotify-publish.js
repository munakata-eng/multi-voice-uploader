function extractSpotifyShowIdFromUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') return null
  const match = urlString.match(/\/pod\/show\/([^/]+)(?:\/|$)/)
  return match ? match[1] : null
}

async function waitForUrlToContain(page, substr, timeoutMs) {
  const start = Date.now()
  let attemptCount = 0
  console.log(`[Spotify] waitForUrlToContain開始: 検索文字列="${substr}", タイムアウト=${timeoutMs}ms`)

  while (Date.now() - start < timeoutMs) {
    attemptCount++
    const current = page.url()
    console.log(`[Spotify] waitForUrlToContain 試行${attemptCount}: 現在URL="${current}"`)

    if (current && current.includes(substr)) {
      console.log(`[Spotify] waitForUrlToContain 成功: URLに"${substr}"が見つかりました`)
      return current
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }

  const finalUrl = page.url()
  console.log(`[Spotify] waitForUrlToContain タイムアウト: 最終URL="${finalUrl}"`)
  return finalUrl
}

function registerSpotifyPublishHandler({ ipcMain, fs, path, getPageInstance, getAppPaths }) {
  ipcMain.handle('publish-to-spotify', async (event, basename, broadcastTitle, description, imagePath, publishDate, publishTime) => {
    try {
      console.log('[Spotify] 処理開始')
      const page = await getPageInstance()

      const { mdDir } = getAppPaths()

      // タイトルの決定: 引数で渡されたものを優先、なければMDファイルから取得
      let title = broadcastTitle || ''

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
            console.error(`[Spotify] MDファイル読み込みエラー ${basename}:`, error)
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

      console.log(`[Spotify] 使用するタイトル: ${title}`)

      // 1) loginページへ
      console.log('[Spotify] ステップ1: ログインページへ遷移中...')
      await page.goto('https://creators.spotify.com/pod/login', { waitUntil: 'domcontentloaded' })
      console.log('[Spotify] ログインページへ遷移完了。現在のURL:', page.url())

      // すでにログイン済みで /pod/show/... にいる可能性がある
      let currentUrl = page.url()
      console.log('[Spotify] 現在のURL:', currentUrl)

      // 2) 自動リダイレクトを待つ（ログイン済みの場合）
      console.log('[Spotify] ステップ2: 自動リダイレクトを待機中（5秒）...')
      await new Promise(resolve => setTimeout(resolve, 5000))
      currentUrl = page.url()
      console.log('[Spotify] 待機後のURL:', currentUrl)

      // 3) まだログインページにいる場合、ログインボタンを探す
      if (currentUrl.includes('/pod/login')) {
        console.log('[Spotify] ステップ3: まだログインページにいます。ログインボタンを探しています...')

        // ページの状態を確認
        const pageContent = await page.content()
        console.log('[Spotify] ページのHTML長:', pageContent.length)

        // 複数のセレクターを試す
        const selectors = [
          'a[href^="/api/shell/gateway"] button',
          'button[type="submit"]',
          'a[href*="gateway"] button'
        ]

        // XPathでテキストを含むボタンを探す
        const xpathSelectors = [
          '//button[contains(text(), "続ける")]',
          '//button[contains(text(), "Continue")]',
          '//a[contains(text(), "続ける")]//button',
          '//a[contains(text(), "Continue")]//button'
        ]

        let buttonFound = false

        // CSSセレクターを試す
        for (const selector of selectors) {
          try {
            console.log(`[Spotify] CSSセレクターを試行中: "${selector}"`)
            await page.waitForSelector(selector, { timeout: 5000 })
            console.log(`[Spotify] CSSセレクターが見つかりました: "${selector}"`)
            await page.click(selector)
            console.log('[Spotify] ログインボタンをクリックしました。遷移を待機中...')
            buttonFound = true
            break
          } catch (e) {
            console.log(`[Spotify] CSSセレクターが見つかりませんでした: "${selector}"`)
          }
        }

        // XPathセレクターを試す
        if (!buttonFound) {
          for (const xpath of xpathSelectors) {
            try {
              console.log(`[Spotify] XPathセレクターを試行中: "${xpath}"`)
              const elements = await page.$x(xpath)
              if (elements.length > 0) {
                console.log(`[Spotify] XPathセレクターが見つかりました: "${xpath}"`)
                await elements[0].click()
                console.log('[Spotify] ログインボタンをクリックしました。遷移を待機中...')
                buttonFound = true
                break
              }
            } catch (e) {
              console.log(`[Spotify] XPathセレクターが見つかりませんでした: "${xpath}"`)
            }
          }
        }

        if (buttonFound) {
          // クリック後、/pod/show/... に遷移するまで待つ
          currentUrl = await waitForUrlToContain(page, '/pod/show/', 60000)
          console.log('[Spotify] 遷移完了。現在のURL:', currentUrl)
        } else {
          // ログインボタンが見つからない場合、自動リダイレクトを待つ
          console.log('[Spotify] ログインボタンが見つかりませんでした。自動リダイレクトを待機中...')
        currentUrl = await waitForUrlToContain(page, '/pod/show/', 60000)
          console.log('[Spotify] 自動リダイレクト後のURL:', currentUrl)
        }
      } else {
        console.log('[Spotify] ステップ3: すでにログイン済みでリダイレクトされました')
      }

      // 4) 遷移先URLから showId を抽出
      console.log('[Spotify] ステップ4: showIdを抽出中...')
      const showId = extractSpotifyShowIdFromUrl(currentUrl)
      console.log('[Spotify] 抽出されたshowId:', showId)
      if (!showId) {
        console.error('[Spotify] showIdの抽出に失敗しました。現在URL:', currentUrl)
        return {
          success: false,
          message: `Spotifyのshowページに遷移できませんでした。現在URL: ${currentUrl}`
        }
      }

      // 5) /home に遷移（まだ /home にいない場合）
      const homeUrl = `https://creators.spotify.com/pod/show/${showId}/home`
      console.log('[Spotify] ステップ5: /homeへの遷移を確認中...')
      console.log('[Spotify] 現在のURL:', currentUrl)
      console.log('[Spotify] 目標URL:', homeUrl)

      if (!currentUrl.includes('/home')) {
        console.log('[Spotify] /homeにいないため、遷移します...')
        await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
        console.log('[Spotify] goto完了。現在のURL:', page.url())

        // /home への遷移完了を待つ
        console.log('[Spotify] /homeへの遷移完了を待機中...')
        const finalUrl = await waitForUrlToContain(page, '/home', 10000)
        console.log('[Spotify] 遷移完了。最終URL:', finalUrl)
      } else {
        console.log('[Spotify] すでに/homeにいます')
      }

      // 現在のURLを再確認
      currentUrl = page.url()
      console.log('[Spotify] /home遷移後の現在URL:', currentUrl)

      // 6) /episode/wizard に移動
      const wizardUrl = `https://creators.spotify.com/pod/show/${showId}/episode/wizard`
      console.log('[Spotify] ステップ6: /episode/wizardへ遷移中...')
      console.log('[Spotify] 目標URL:', wizardUrl)

      await page.goto(wizardUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
      console.log('[Spotify] goto完了。現在のURL:', page.url())

      // 遷移完了を待つ
      const wizardFinalUrl = await waitForUrlToContain(page, '/episode/wizard', 10000)
      console.log('[Spotify] /episode/wizardへの遷移完了。最終URL:', wizardFinalUrl)

      // 7) 音声ファイルのアップロード
      console.log('[Spotify] ステップ7: 音声ファイルのアップロードを開始...')

      const { audioDir } = getAppPaths()

      // 対応する音声ファイルのパスを構築
      let audioFilePath = path.join(audioDir, basename + '.mp4')

      // ファイルが存在するかチェック
      if (!(await fs.pathExists(audioFilePath))) {
        // .mp4が存在しない場合は.m4aを試す
        const m4aFilePath = path.join(audioDir, basename + '.m4a')
        if (await fs.pathExists(m4aFilePath)) {
          audioFilePath = m4aFilePath
          console.log('[Spotify] .mp4が見つからないため、.m4aを使用します')
        } else {
          // .mp3も試す
          const mp3FilePath = path.join(audioDir, basename + '.mp3')
          if (await fs.pathExists(mp3FilePath)) {
            audioFilePath = mp3FilePath
            console.log('[Spotify] .mp4/.m4aが見つからないため、.mp3を使用します')
          } else {
            throw new Error(`音声ファイルが見つかりません: ${basename}.mp4, ${basename}.m4a, ${basename}.mp3`)
          }
        }
      }

      console.log(`[Spotify] アップロードする音声ファイル: ${audioFilePath}`)

      // アップロードエリアを探す（汎用的なセレクターを使用）
      console.log('[Spotify] アップロードエリアを探しています...')

      // 複数のセレクターを試す
      const uploadSelectors = [
        'input[type="file"][accept*="mp3"]',
        'input[type="file"][accept*="m4a"]',
        'input[type="file"][accept*="audio"]',
        'input[type="file"][id*="upload"]',
        '#uploadAreaInput',
        'input[type="file"]'
      ]

      let fileInput = null
      for (const selector of uploadSelectors) {
        try {
          console.log(`[Spotify] セレクターを試行中: "${selector}"`)
          await page.waitForSelector(selector, { timeout: 5000 })
          fileInput = await page.$(selector)
          if (fileInput) {
            // accept属性を確認して、音声ファイル形式が含まれているかチェック
            const acceptAttr = await page.evaluate(el => el.getAttribute('accept'), fileInput)
            console.log(`[Spotify] セレクターが見つかりました: "${selector}", accept="${acceptAttr}"`)

            // accept属性に音声ファイル形式が含まれているか確認
            if (acceptAttr && (
              acceptAttr.includes('mp3') ||
              acceptAttr.includes('m4a') ||
              acceptAttr.includes('audio') ||
              acceptAttr.includes('wav') ||
              acceptAttr.includes('mp4')
            )) {
              console.log(`[Spotify] 音声ファイル用のinput要素を特定しました`)
              break
            } else if (!acceptAttr) {
              // accept属性がない場合は、汎用的なinput[type="file"]として使用
              console.log(`[Spotify] accept属性がないため、汎用的なinputとして使用します`)
              break
            }
          }
        } catch (e) {
          console.log(`[Spotify] セレクターが見つかりませんでした: "${selector}"`)
        }
      }

      if (!fileInput) {
        // フォールバック: data-testid="uploadAreaWrapper" の中を探す
        console.log('[Spotify] フォールバック: data-testid="uploadAreaWrapper" を探しています...')
        try {
          await page.waitForSelector('[data-testid="uploadAreaWrapper"]', { timeout: 5000 })
          fileInput = await page.$('[data-testid="uploadAreaWrapper"] input[type="file"]')
          if (fileInput) {
            console.log('[Spotify] data-testid="uploadAreaWrapper" 内のinput要素を見つけました')
          }
        } catch (e) {
          console.log('[Spotify] data-testid="uploadAreaWrapper" が見つかりませんでした')
        }
      }

      if (!fileInput) {
        throw new Error('音声ファイルアップロード用のinput要素が見つかりませんでした')
      }

      // ファイルをアップロード
      console.log(`[Spotify] 音声ファイルをアップロード中: ${audioFilePath}`)
      await fileInput.uploadFile(audioFilePath)
      console.log('[Spotify] 音声ファイルのアップロードが完了しました')

      // アップロードが完了するまで少し待機
      await new Promise(resolve => setTimeout(resolve, 3000))

      // 8) タイトルの設定
      console.log('[Spotify] ステップ8: タイトルの設定を開始...')
      if (title) {
        try {
          // 複数のセレクターを試す
          const titleSelectors = [
            '#title-input',
            'input[name="title"]',
            'input[id*="title"]',
            'input[placeholder*="タイトル"]',
            'input[placeholder*="エピソード"]'
          ]

          let titleInput = null
          for (const selector of titleSelectors) {
            try {
              console.log(`[Spotify] タイトル入力欄を探しています: "${selector}"`)
              await page.waitForSelector(selector, { timeout: 5000 })
              titleInput = await page.$(selector)
              if (titleInput) {
                console.log(`[Spotify] タイトル入力欄を見つけました: "${selector}"`)
                break
              }
            } catch (e) {
              console.log(`[Spotify] タイトル入力欄が見つかりませんでした: "${selector}"`)
            }
          }

          if (titleInput) {
            await titleInput.click()
            await titleInput.focus()

            // 既存の内容をクリア
            await page.keyboard.down('Control')
            await page.keyboard.press('KeyA')
            await page.keyboard.up('Control')

            // タイトルを入力
            await titleInput.type(title)
            console.log(`[Spotify] タイトルを設定しました: ${title}`)
          } else {
            console.log('[Spotify] タイトル入力欄が見つかりませんでした')
          }
        } catch (titleError) {
          console.error('[Spotify] タイトル設定でエラーが発生しました:', titleError.message)
        }
      } else {
        console.log('[Spotify] タイトルが指定されていないため、スキップします')
      }

      await new Promise(resolve => setTimeout(resolve, 1000))

      // 9) 説明文の設定（必須項目）
      console.log('[Spotify] ステップ9: 説明文の設定を開始...')
      // 説明文が指定されていない場合は、タイトルを使用
      const finalDescription = description || title || ''

      if (finalDescription) {
        try {
          // 複数のセレクターを試す（contenteditableのdivを優先）
          const descriptionSelectors = [
            '[name="description"][contenteditable="true"]',
            '[data-slate-editor="true"]',
            '[name="description"]',
            '[contenteditable="true"]',
            'div[role="textbox"]'
          ]

          let descriptionElement = null
          for (const selector of descriptionSelectors) {
            try {
              console.log(`[Spotify] 説明文入力欄を探しています: "${selector}"`)
              await page.waitForSelector(selector, { timeout: 5000 })
              descriptionElement = await page.$(selector)
              if (descriptionElement) {
                // name属性がdescriptionか確認
                const nameAttr = await page.evaluate(el => el.getAttribute('name'), descriptionElement)
                if (nameAttr === 'description' || selector.includes('slate-editor')) {
                  console.log(`[Spotify] 説明文入力欄を見つけました: "${selector}"`)
                  break
                }
              }
            } catch (e) {
              console.log(`[Spotify] 説明文入力欄が見つかりませんでした: "${selector}"`)
            }
          }

          if (descriptionElement) {
            // Slateエディタの場合、キーボード入力をシミュレートする方法を使用
            console.log(`[Spotify] 説明文を設定します: "${finalDescription}"`)

            // クリックしてフォーカスを当てる
            await descriptionElement.click()
            await descriptionElement.focus()
            await new Promise(resolve => setTimeout(resolve, 500))

            // 既存の内容を全選択して削除
            await page.keyboard.down('Control')
            await page.keyboard.press('KeyA')
            await page.keyboard.up('Control')
            await new Promise(resolve => setTimeout(resolve, 200))

            // 削除キーでクリア
            await page.keyboard.press('Delete')
            await new Promise(resolve => setTimeout(resolve, 200))

            // テキストを入力（1文字ずつ入力して確実にイベントを発火）
            console.log('[Spotify] テキストを入力中...')
            for (let i = 0; i < finalDescription.length; i++) {
              await page.keyboard.type(finalDescription[i])
              // 長いテキストの場合は少し待機
              if (i % 10 === 0) {
                await new Promise(resolve => setTimeout(resolve, 50))
              }
            }

            // 入力完了を待機
            await new Promise(resolve => setTimeout(resolve, 500))

            // フォーカスを外してバリデーションをトリガー
            await page.evaluate((el) => {
              el.blur()
              // フォームのバリデーションをトリガーするために、親要素のフォームにイベントを発火
              const form = el.closest('form')
              if (form) {
                const changeEvent = new Event('change', { bubbles: true, cancelable: true })
                form.dispatchEvent(changeEvent)
              }
            }, descriptionElement)

            await new Promise(resolve => setTimeout(resolve, 500))

            // 値が正しく設定されたか確認
            const actualValue = await page.evaluate((el) => {
              return el.textContent.trim() || el.innerText.trim()
            }, descriptionElement)

            console.log(`[Spotify] 説明文を設定しました。実際の値: "${actualValue}"`)

            // 値が設定されていない場合、再度試行
            if (!actualValue || actualValue.length === 0) {
              console.log('[Spotify] 説明文が設定されていないため、再試行します...')

              // 再度クリックしてフォーカス
              await descriptionElement.click()
              await descriptionElement.focus()
              await new Promise(resolve => setTimeout(resolve, 300))

              // 全選択して削除
              await page.keyboard.down('Control')
              await page.keyboard.press('KeyA')
              await page.keyboard.up('Control')
              await page.keyboard.press('Delete')
              await new Promise(resolve => setTimeout(resolve, 200))

              // テキストを入力
              await page.keyboard.type(finalDescription)
              await new Promise(resolve => setTimeout(resolve, 500))

              // 再度確認
              const retryValue = await page.evaluate((el) => {
                return el.textContent.trim() || el.innerText.trim()
              }, descriptionElement)

              console.log(`[Spotify] 再試行後の説明文: "${retryValue}"`)

              // まだ設定されていない場合、evaluateで直接設定を試す
              if (!retryValue || retryValue.length === 0) {
                console.log('[Spotify] 最終手段: evaluateで直接設定します...')
                await page.evaluate((el, text) => {
                  // Slateエディタの構造に合わせて設定
                  if (el.hasAttribute('data-slate-editor')) {
                    el.innerHTML = `<p>${text}</p>`
                  } else {
                    el.textContent = text
                    el.innerHTML = text
                  }

                  // 複数のイベントを発火
                  const events = ['beforeinput', 'input', 'change', 'blur']
                  events.forEach(eventType => {
                    const event = new Event(eventType, { bubbles: true, cancelable: true })
                    el.dispatchEvent(event)
                  })

                  // 親要素にもイベントを発火
                  const form = el.closest('form')
                  if (form) {
                    const formEvent = new Event('change', { bubbles: true, cancelable: true })
                    form.dispatchEvent(formEvent)
                  }
                }, descriptionElement, finalDescription)

                await new Promise(resolve => setTimeout(resolve, 500))
              }
            }
          } else {
            console.log('[Spotify] 説明文入力欄が見つかりませんでした')
          }
        } catch (descError) {
          console.error('[Spotify] 説明文設定でエラーが発生しました:', descError.message)
        }
      } else {
        console.log('[Spotify] 説明文が指定されておらず、タイトルもないため、スキップします')
      }

      await new Promise(resolve => setTimeout(resolve, 1000))

      // 10) 「次へ」ボタンを押す処理（関数として定義）
      const clickNextButton = async () => {
        console.log('[Spotify] 「次へ」ボタンを探しています...')
        try {
          // 複数のセレクターを試す
          const nextButtonSelectors = [
            'button[type="submit"][form="details-form"]',
            'button[form="details-form"][data-encore-id="buttonPrimary"]',
            'button[data-encore-id="buttonPrimary"]'
          ]

          let nextButtonClicked = false
          for (const selector of nextButtonSelectors) {
            try {
              console.log(`[Spotify] 「次へ」ボタンを探しています: "${selector}"`)
              await page.waitForSelector(selector, { timeout: 5000 })
              const nextButton = await page.$(selector)
              if (nextButton) {
                // ボタンのテキストを確認
                const buttonText = await page.evaluate(el => el.textContent.trim(), nextButton)
                console.log(`[Spotify] ボタンが見つかりました。テキスト: "${buttonText}"`)

                if (buttonText.includes('次へ')) {
                  await nextButton.click()
                  console.log('[Spotify] 「次へ」ボタンをクリックしました')
                  nextButtonClicked = true
                  break
                }
              }
            } catch (e) {
              console.log(`[Spotify] 「次へ」ボタンが見つかりませんでした: "${selector}"`)
            }
          }

          // フォールバック1: XPathで「次へ」ボタンを探す
          if (!nextButtonClicked) {
            console.log('[Spotify] フォールバック1: XPathで「次へ」ボタンを探しています...')
            try {
              const nextButtons = await page.$x('//button[contains(text(), "次へ")]')
              if (nextButtons.length > 0) {
                await nextButtons[0].click()
                console.log('[Spotify] 「次へ」ボタンをクリックしました（XPath）')
                nextButtonClicked = true
              }
            } catch (e) {
              console.log('[Spotify] XPathで「次へ」ボタンが見つかりませんでした')
            }
          }

          // フォールバック2: evaluateで「次へ」ボタンを探す
          if (!nextButtonClicked) {
            console.log('[Spotify] フォールバック2: evaluateで「次へ」ボタンを探しています...')
            const nextButton = await page.evaluateHandle(() => {
              const buttons = Array.from(document.querySelectorAll('button'))
              const nextBtn = buttons.find(btn => {
                const text = btn.textContent.trim()
                return text === '次へ' || text.includes('次へ')
              })
              return nextBtn
            })

            if (nextButton && nextButton.asElement) {
              const element = nextButton.asElement()
              if (element) {
                await element.click()
                console.log('[Spotify] 「次へ」ボタンをクリックしました（evaluate）')
                nextButtonClicked = true
              }
            }
          }

          if (nextButtonClicked) {
            // 「次へ」ボタンクリック後の遷移を待機
            await new Promise(resolve => setTimeout(resolve, 2000))
            console.log('[Spotify] 「次へ」ボタンのクリックが完了しました')
            return true
          } else {
            console.log('[Spotify] 「次へ」ボタンが見つかりませんでした')
            return false
          }
        } catch (nextButtonError) {
          console.log('[Spotify] 「次へ」ボタンのクリックでエラーが発生しました（スキップ）:', nextButtonError.message)
          return false
        }
      }

      // 11) 画像のアップロード（画像が選択されている場合）
      console.log('[Spotify] ステップ11: 画像のアップロードを確認中...')
      if (imagePath) {
        try {
          // 画像ファイルの存在確認
          const normalizedImagePath = path.normalize(imagePath)
          const imageExists = await fs.pathExists(normalizedImagePath)

          if (imageExists) {
            console.log(`[Spotify] 画像ファイルが見つかりました: ${normalizedImagePath}`)

            // 画像アップロード用のinput要素を探す
            const imageSelectors = [
              'input[type="file"][accept*="image"]',
              'input[type="file"][accept*="png"]',
              'input[type="file"][accept*="jpeg"]',
              'input[type="file"][accept*="jpg"]',
              'input[type="file"][accept*="gif"]',
              'input[type="file"][accept*="webp"]'
            ]

            let imageInput = null
            for (const selector of imageSelectors) {
              try {
                console.log(`[Spotify] 画像input要素を探しています: "${selector}"`)
                await page.waitForSelector(selector, { timeout: 5000 })
                imageInput = await page.$(selector)
                if (imageInput) {
                  // accept属性を確認して、画像ファイル形式が含まれているかチェック
                  const acceptAttr = await page.evaluate(el => el.getAttribute('accept'), imageInput)
                  console.log(`[Spotify] 画像input要素が見つかりました: "${selector}", accept="${acceptAttr}"`)

                  // accept属性に画像ファイル形式が含まれているか確認
                  if (acceptAttr && (
                    acceptAttr.includes('image') ||
                    acceptAttr.includes('png') ||
                    acceptAttr.includes('jpeg') ||
                    acceptAttr.includes('jpg') ||
                    acceptAttr.includes('gif') ||
                    acceptAttr.includes('webp')
                  )) {
                    console.log(`[Spotify] 画像用のinput要素を特定しました`)
                    break
                  } else if (!acceptAttr) {
                    // accept属性がない場合は、汎用的なinput[type="file"]として使用
                    console.log(`[Spotify] accept属性がないため、汎用的なinputとして使用します`)
                    break
                  }
                }
              } catch (e) {
                console.log(`[Spotify] 画像input要素が見つかりませんでした: "${selector}"`)
              }
            }

            // フォールバック: data-cy="imageUploaderDropzone" の親要素からinputを探す
            if (!imageInput) {
              console.log('[Spotify] フォールバック: data-cy="imageUploaderDropzone" を探しています...')
              try {
                await page.waitForSelector('[data-cy="imageUploaderDropzone"]', { timeout: 5000 })

                // 親要素からinputを探す（evaluateでセレクターを取得）
                const inputSelector = await page.evaluate(() => {
                  const dropzone = document.querySelector('[data-cy="imageUploaderDropzone"]')
                  if (dropzone) {
                    // 親要素を取得
                    const parent = dropzone.closest('div')
                    if (parent) {
                      // 親要素内のinput[type="file"]を探す
                      const input = parent.querySelector('input[type="file"]')
                      if (input) {
                        // 一意のセレクターを生成
                        const accept = input.getAttribute('accept')
                        if (accept) {
                          return `input[type="file"][accept="${accept}"]`
                        }
                        return 'input[type="file"]'
                      }
                    }
                  }
                  return null
                })

                if (inputSelector) {
                  imageInput = await page.$(inputSelector)
                  if (imageInput) {
                    console.log('[Spotify] data-cy="imageUploaderDropzone" 関連のinput要素を見つけました')
                  }
                }

                if (!imageInput) {
                  // 直接inputを探す
                  imageInput = await page.$('input[type="file"][accept*="image"]')
                }
              } catch (e) {
                console.log('[Spotify] data-cy="imageUploaderDropzone" が見つかりませんでした')
              }
            }

            // さらにフォールバック: すべてのinput[type="file"]を確認
            if (!imageInput) {
              console.log('[Spotify] 最終フォールバック: すべてのinput[type="file"]を確認中...')
              const allFileInputs = await page.$$('input[type="file"]')
              for (const input of allFileInputs) {
                const acceptAttr = await page.evaluate(el => el.getAttribute('accept'), input)
                if (acceptAttr && acceptAttr.includes('image')) {
                  imageInput = input
                  console.log('[Spotify] 画像用のinput要素を最終的に見つけました')
                  break
                }
              }
            }

            if (imageInput) {
              // 画像ファイルをアップロード
              console.log(`[Spotify] 画像ファイルをアップロード中: ${normalizedImagePath}`)
              await imageInput.uploadFile(normalizedImagePath)
              console.log('[Spotify] 画像ファイルのアップロードが完了しました')

              // 画像編集モーダルが表示されるまで待機
              console.log('[Spotify] 画像編集モーダルの表示を待機中...')
              try {
                // モーダルが表示されるまで待つ
                await page.waitForSelector('[data-encore-id="dialogConfirmation"]', { timeout: 10000 })
                console.log('[Spotify] 画像編集モーダルが表示されました')

                // 少し待ってから「保存」ボタンを探す
                await new Promise(resolve => setTimeout(resolve, 1000))

                // 「保存」ボタンを探してクリック
                const saveButtonSelectors = [
                  'button[data-encore-id="buttonPrimary"]',
                  'footer button[data-encore-id="buttonPrimary"]'
                ]

                let saveButtonClicked = false
                for (const selector of saveButtonSelectors) {
                  try {
                    console.log(`[Spotify] 保存ボタンを探しています: "${selector}"`)
                    const saveButton = await page.$(selector)
                    if (saveButton) {
                      // ボタンのテキストを確認
                      const buttonText = await page.evaluate(el => el.textContent.trim(), saveButton)
                      console.log(`[Spotify] ボタンが見つかりました。テキスト: "${buttonText}"`)

                      if (buttonText.includes('保存')) {
                        await saveButton.click()
                        console.log('[Spotify] 保存ボタンをクリックしました')
                        saveButtonClicked = true
                        break
                      }
                    }
                  } catch (e) {
                    console.log(`[Spotify] 保存ボタンが見つかりませんでした: "${selector}"`)
                  }
                }

                // フォールバック1: XPathで「保存」ボタンを探す
                if (!saveButtonClicked) {
                  console.log('[Spotify] フォールバック1: XPathで「保存」ボタンを探しています...')
                  try {
                    const saveButtons = await page.$x('//button[contains(text(), "保存")]')
                    if (saveButtons.length > 0) {
                      await saveButtons[0].click()
                      console.log('[Spotify] 保存ボタンをクリックしました（XPath）')
                      saveButtonClicked = true
                    }
                  } catch (e) {
                    console.log('[Spotify] XPathで保存ボタンが見つかりませんでした')
                  }
                }

                // フォールバック2: evaluateで「保存」ボタンを探す
                if (!saveButtonClicked) {
                  console.log('[Spotify] フォールバック2: evaluateで「保存」ボタンを探しています...')
                  const saveButton = await page.evaluateHandle(() => {
                    const buttons = Array.from(document.querySelectorAll('button'))
                    const saveBtn = buttons.find(btn => {
                      const text = btn.textContent.trim()
                      return text === '保存' || text.includes('保存')
                    })
                    return saveBtn
                  })

                  if (saveButton && saveButton.asElement) {
                    const element = saveButton.asElement()
                    if (element) {
                      await element.click()
                      console.log('[Spotify] 保存ボタンをクリックしました（evaluate）')
                      saveButtonClicked = true
                    }
                  }
                }

                if (saveButtonClicked) {
                  // モーダルが閉じるまで待機
                  console.log('[Spotify] 画像編集モーダルが閉じるのを待機中...')
                  try {
                    // モーダルが非表示になるまで待つ
                    await page.waitForFunction(
                      () => {
                        const modal = document.querySelector('[data-encore-id="dialogConfirmation"]')
                        const backdrop = document.querySelector('[data-encore-id="backdrop"]')
                        // モーダルとバックドロップの両方が非表示またはDOMから削除されているか確認
                        if (!modal && !backdrop) return true
                        if (modal) {
                          const style = window.getComputedStyle(modal)
                          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                            return true
                          }
                        }
                        if (backdrop) {
                          const style = window.getComputedStyle(backdrop)
                          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                            return true
                          }
                        }
                        return false
                      },
                      { timeout: 15000 }
                    )
                    console.log('[Spotify] 画像編集モーダルが閉じました')
                  } catch (waitError) {
                    console.log('[Spotify] モーダルが閉じるのを待機中にタイムアウトしました。続行します:', waitError.message)
                    // タイムアウトしても少し待機してから続行
                    await new Promise(resolve => setTimeout(resolve, 2000))
                  }

                  // 少し追加で待機（念のため）
                  await new Promise(resolve => setTimeout(resolve, 1000))
                  console.log('[Spotify] 画像編集モーダルの処理が完了しました')

                  // 「次へ」ボタンを押す
                  await clickNextButton()

                      // スケジュールセクションが表示されるまで待機
                      console.log('[Spotify] スケジュールセクションの表示を待機中...')
                      try {
                        // スケジュールセクションが表示されるまで待つ
                        await page.waitForSelector('#schedule-accordion', { timeout: 10000 })
                        console.log('[Spotify] スケジュールセクションが表示されました')

                        // 少し待ってから「スケジュール」ラジオボタンを選択
                        await new Promise(resolve => setTimeout(resolve, 1000))

                        // 「スケジュール」ラジオボタンを選択
                        console.log('[Spotify] 「スケジュール」ラジオボタンを選択中...')
                        const scheduleRadio = await page.$('#publish-date-schedule')
                        if (scheduleRadio) {
                          await scheduleRadio.click()
                          console.log('[Spotify] 「スケジュール」ラジオボタンを選択しました')

                          // 日時入力UIが表示されるまで待機
                          await new Promise(resolve => setTimeout(resolve, 1000))

          // 投稿日時と時間を設定（publishDateとpublishTimeが指定されている場合）
          if (publishDate && publishTime) {
            console.log(`[Spotify] 投稿日時を設定します: ${publishDate} ${publishTime}`)

            // 日付を設定（YYYY-MM-DD形式をそのまま使用）
            const dateParts = publishDate.split('-')
            if (dateParts.length === 3) {
              const year = parseInt(dateParts[0])
              const month = parseInt(dateParts[1])
              const day = parseInt(dateParts[2])
              console.log(`[Spotify] 日付を設定: ${publishDate} (年: ${year}, 月: ${month}, 日: ${day})`)

              // 日付ボタンを探して直接値を設定
              console.log('[Spotify] 日付ボタンを探しています...')
              const dateSet = await page.evaluate((targetDate, targetYear, targetMonth, targetDay) => {
                // YYYY-MM-DD形式をYYYY/MM/DD形式に変換
                const formattedDate = `${targetYear}/${String(targetMonth).padStart(2, '0')}/${String(targetDay).padStart(2, '0')}`

                // ラベルに「日付」が含まれるform-groupを探す
                const labels = Array.from(document.querySelectorAll('label'))
                for (const label of labels) {
                  const labelText = label.textContent || label.innerText || ''
                  if (labelText.includes('日付')) {
                    // ラベルの親要素からボタンを探す
                    const formGroup = label.closest('[data-encore-id="formGroup"]')
                    if (formGroup) {
                      const button = formGroup.querySelector('button[type="button"]')
                      if (button) {
                        const span = button.querySelector('span')
                        if (span) {
                          // spanのテキストを変更
                          span.textContent = formattedDate
                          span.innerText = formattedDate

                          // ボタンにdata属性を設定（もしあれば）
                          if (!button.dataset.value) {
                            button.dataset.value = targetDate
                          }

                          // 複数のイベントを発火
                          const events = ['click', 'change', 'input']
                          events.forEach(eventType => {
                            const event = new Event(eventType, { bubbles: true, cancelable: true })
                            button.dispatchEvent(event)
                          })

                          // React用の合成イベントも発火
                          const syntheticEvent = new Event('change', { bubbles: true, cancelable: true })
                          Object.defineProperty(syntheticEvent, 'target', { value: button, enumerable: true })
                          button.dispatchEvent(syntheticEvent)

                          // 親要素のフォームにもイベントを発火
                          const form = button.closest('form')
                          if (form) {
                            const formEvent = new Event('change', { bubbles: true, cancelable: true })
                            form.dispatchEvent(formEvent)
                          }

                          console.log(`日付ボタンのspanを更新しました: ${formattedDate}`)
                          return true
                        }
                      }
                    }
                  }
                }

                // フォールバック: input[type="date"]を探す
                const dateInput = document.querySelector('input[type="date"]')
                if (dateInput) {
                  dateInput.value = targetDate
                  const events = ['input', 'change', 'blur']
                  events.forEach(eventType => {
                    const event = new Event(eventType, { bubbles: true, cancelable: true })
                    dateInput.dispatchEvent(event)
                  })
                  console.log(`日付入力欄に値を設定しました: ${targetDate}`)
                  return true
                }

                // フォールバック: hidden inputを探す
                const hiddenInputs = Array.from(document.querySelectorAll('input[type="hidden"]'))
                for (const input of hiddenInputs) {
                  const name = input.name || input.id || ''
                  if (name.includes('date') || name.includes('Date')) {
                    input.value = targetDate
                    const changeEvent = new Event('change', { bubbles: true, cancelable: true })
                    input.dispatchEvent(changeEvent)
                    console.log(`hidden inputに値を設定しました: ${name} = ${targetDate}`)
                    return true
                  }
                }

                return false
              }, publishDate, year, month, day)

              if (dateSet) {
                console.log('[Spotify] 日付を直接設定しました')
                await new Promise(resolve => setTimeout(resolve, 500))
              } else {
                console.log('[Spotify] 日付ボタンが見つかりませんでした')
              }
            }

                            // 時間を設定（HH:MM形式から時と分を抽出）
                            const timeParts = publishTime.split(':')
                            if (timeParts.length === 2) {
                              const hour = timeParts[0].padStart(2, '0')
                              const minute = timeParts[1].padStart(2, '0')
                              console.log(`[Spotify] 時間を設定: ${hour}:${minute}`)

                              // 時間入力欄を探して設定
                              const hourInput = await page.$('input[data-testid="hour-picker"]')
                              const minuteInput = await page.$('input[data-testid="minute-picker"]')

                              if (hourInput && minuteInput) {
                                // 時間入力欄をクリックしてからキーボードで入力
                                await hourInput.click()
                                await hourInput.focus()
                                await new Promise(resolve => setTimeout(resolve, 200))

                                // 全選択してから入力
                                await page.keyboard.down('Control')
                                await page.keyboard.press('KeyA')
                                await page.keyboard.up('Control')
                                await new Promise(resolve => setTimeout(resolve, 100))

                                // 時間を入力
                                await page.keyboard.type(hour)
                                await new Promise(resolve => setTimeout(resolve, 300))

                                // 分入力欄をクリックしてからキーボードで入力
                                await minuteInput.click()
                                await minuteInput.focus()
                                await new Promise(resolve => setTimeout(resolve, 200))

                                // 全選択してから入力
                                await page.keyboard.down('Control')
                                await page.keyboard.press('KeyA')
                                await page.keyboard.up('Control')
                                await new Promise(resolve => setTimeout(resolve, 100))

                                // 分を入力
                                await page.keyboard.type(minute)
                                await new Promise(resolve => setTimeout(resolve, 300))

                                // フォーカスを外してバリデーションをトリガー
                                await page.evaluate((hourEl, minuteEl) => {
                                  hourEl.blur()
                                  minuteEl.blur()
                                  // イベントを発火
                                  const changeEvent = new Event('change', { bubbles: true, cancelable: true })
                                  hourEl.dispatchEvent(changeEvent)
                                  minuteEl.dispatchEvent(changeEvent)
                                }, hourInput, minuteInput)

                                console.log('[Spotify] 時間を設定しました')
                              } else {
                                console.log('[Spotify] 時間入力欄が見つかりませんでした')
                              }
                            }
                          } else {
                            console.log('[Spotify] 投稿日時が指定されていないため、スケジュール設定をスキップします')
                          }
                        } else {
                          console.log('[Spotify] 「スケジュール」ラジオボタンが見つかりませんでした')
                        }
                      } catch (scheduleError) {
                        console.log('[Spotify] スケジュールセクションの処理でエラーが発生しました（スキップ）:', scheduleError.message)
                      }
                    }
              } catch (modalError) {
                console.log('[Spotify] 画像編集モーダルが表示されませんでした（スキップ）:', modalError.message)
              }
            } else {
              console.log('[Spotify] 画像アップロード用のinput要素が見つかりませんでした。画像のアップロードをスキップします')
            }
          } else {
            console.log(`[Spotify] 画像ファイルが見つかりませんでした: ${normalizedImagePath}`)
          }
        } catch (imageError) {
          console.error('[Spotify] 画像アップロードでエラーが発生しました:', imageError.message)
          // 画像アップロードのエラーは致命的ではないため、処理を続行
        }
      } else {
        console.log('[Spotify] 画像が指定されていないため、画像のアップロードをスキップします')
      }

      // 12) 「次へ」ボタンを押す（画像がアップロードされていない場合、または画像アップロード後に実行）
      if (!imagePath || !imageInput) {
        console.log('[Spotify] ステップ12: 画像がアップロードされていないため、「次へ」ボタンを押します...')
        await clickNextButton()
      }

      // 13) スケジュールセクションの処理（「次へ」ボタンクリック後）
      console.log('[Spotify] ステップ13: スケジュールセクションの表示を待機中...')
      try {
        // スケジュールセクションが表示されるまで待つ
        await page.waitForSelector('#schedule-accordion', { timeout: 10000 })
        console.log('[Spotify] スケジュールセクションが表示されました')

        // 少し待ってから「スケジュール」ラジオボタンを選択
        await new Promise(resolve => setTimeout(resolve, 1000))

        // 「スケジュール」ラジオボタンを選択
        console.log('[Spotify] 「スケジュール」ラジオボタンを選択中...')
        const scheduleRadio = await page.$('#publish-date-schedule')
        if (scheduleRadio) {
          await scheduleRadio.click()
          console.log('[Spotify] 「スケジュール」ラジオボタンを選択しました')

          // 日時入力UIが表示されるまで待機
          await new Promise(resolve => setTimeout(resolve, 1000))

          // 投稿日時と時間を設定（publishDateとpublishTimeが指定されている場合）
          if (publishDate && publishTime) {
            console.log(`[Spotify] 投稿日時を設定します: ${publishDate} ${publishTime}`)

            // 日付を設定（YYYY-MM-DD形式をそのまま使用）
            const dateParts = publishDate.split('-')
            if (dateParts.length === 3) {
              const year = parseInt(dateParts[0])
              const month = parseInt(dateParts[1])
              const day = parseInt(dateParts[2])
              console.log(`[Spotify] 日付を設定: ${publishDate} (年: ${year}, 月: ${month}, 日: ${day})`)

              // 日付ボタンを探して直接値を設定
              console.log('[Spotify] 日付ボタンを探しています...')
              const dateSet = await page.evaluate((targetDate, targetYear, targetMonth, targetDay) => {
                // YYYY-MM-DD形式をYYYY/MM/DD形式に変換
                const formattedDate = `${targetYear}/${String(targetMonth).padStart(2, '0')}/${String(targetDay).padStart(2, '0')}`

                // ラベルに「日付」が含まれるform-groupを探す
                const labels = Array.from(document.querySelectorAll('label'))
                for (const label of labels) {
                  const labelText = label.textContent || label.innerText || ''
                  if (labelText.includes('日付')) {
                    // ラベルの親要素からボタンを探す
                    const formGroup = label.closest('[data-encore-id="formGroup"]')
                    if (formGroup) {
                      const button = formGroup.querySelector('button[type="button"]')
                      if (button) {
                        const span = button.querySelector('span')
                        if (span) {
                          // spanのテキストを変更
                          span.textContent = formattedDate
                          span.innerText = formattedDate

                          // ボタンにdata属性を設定（もしあれば）
                          if (!button.dataset.value) {
                            button.dataset.value = targetDate
                          }

                          // 複数のイベントを発火
                          const events = ['click', 'change', 'input']
                          events.forEach(eventType => {
                            const event = new Event(eventType, { bubbles: true, cancelable: true })
                            button.dispatchEvent(event)
                          })

                          // React用の合成イベントも発火
                          const syntheticEvent = new Event('change', { bubbles: true, cancelable: true })
                          Object.defineProperty(syntheticEvent, 'target', { value: button, enumerable: true })
                          button.dispatchEvent(syntheticEvent)

                          // 親要素のフォームにもイベントを発火
                          const form = button.closest('form')
                          if (form) {
                            const formEvent = new Event('change', { bubbles: true, cancelable: true })
                            form.dispatchEvent(formEvent)
                          }

                          console.log(`日付ボタンのspanを更新しました: ${formattedDate}`)
                          return true
                        }
                      }
                    }
                  }
                }

                // フォールバック: input[type="date"]を探す
                const dateInput = document.querySelector('input[type="date"]')
                if (dateInput) {
                  dateInput.value = targetDate
                  const events = ['input', 'change', 'blur']
                  events.forEach(eventType => {
                    const event = new Event(eventType, { bubbles: true, cancelable: true })
                    dateInput.dispatchEvent(event)
                  })
                  console.log(`日付入力欄に値を設定しました: ${targetDate}`)
                  return true
                }

                // フォールバック: hidden inputを探す
                const hiddenInputs = Array.from(document.querySelectorAll('input[type="hidden"]'))
                for (const input of hiddenInputs) {
                  const name = input.name || input.id || ''
                  if (name.includes('date') || name.includes('Date')) {
                    input.value = targetDate
                    const changeEvent = new Event('change', { bubbles: true, cancelable: true })
                    input.dispatchEvent(changeEvent)
                    console.log(`hidden inputに値を設定しました: ${name} = ${targetDate}`)
                    return true
                  }
                }

                return false
              }, publishDate, year, month, day)

              if (dateSet) {
                console.log('[Spotify] 日付を直接設定しました')
                await new Promise(resolve => setTimeout(resolve, 500))
              } else {
                console.log('[Spotify] 日付ボタンが見つかりませんでした')
              }
            }

            // 時間を設定（HH:MM形式から時と分を抽出）
            const timeParts = publishTime.split(':')
            if (timeParts.length === 2) {
              const hour = timeParts[0].padStart(2, '0')
              const minute = timeParts[1].padStart(2, '0')
              console.log(`[Spotify] 時間を設定: ${hour}:${minute}`)

              // 時間入力欄を探して設定
              const hourInput = await page.$('input[data-testid="hour-picker"]')
              const minuteInput = await page.$('input[data-testid="minute-picker"]')

              if (hourInput && minuteInput) {
                // 時間入力欄をクリックしてからキーボードで入力
                await hourInput.click()
                await hourInput.focus()
                await new Promise(resolve => setTimeout(resolve, 200))

                // 全選択してから入力
                await page.keyboard.down('Control')
                await page.keyboard.press('KeyA')
                await page.keyboard.up('Control')
                await new Promise(resolve => setTimeout(resolve, 100))

                // 時間を入力
                await page.keyboard.type(hour)
                await new Promise(resolve => setTimeout(resolve, 300))

                // 分入力欄をクリックしてからキーボードで入力
                await minuteInput.click()
                await minuteInput.focus()
                await new Promise(resolve => setTimeout(resolve, 200))

                // 全選択してから入力
                await page.keyboard.down('Control')
                await page.keyboard.press('KeyA')
                await page.keyboard.up('Control')
                await new Promise(resolve => setTimeout(resolve, 100))

                // 分を入力
                await page.keyboard.type(minute)
                await new Promise(resolve => setTimeout(resolve, 300))

                // フォーカスを外してバリデーションをトリガー
                await page.evaluate((hourEl, minuteEl) => {
                  hourEl.blur()
                  minuteEl.blur()
                  // イベントを発火
                  const changeEvent = new Event('change', { bubbles: true, cancelable: true })
                  hourEl.dispatchEvent(changeEvent)
                  minuteEl.dispatchEvent(changeEvent)
                }, hourInput, minuteInput)

                console.log('[Spotify] 時間を設定しました')
              } else {
                console.log('[Spotify] 時間入力欄が見つかりませんでした')
              }
            }
          } else {
            console.log('[Spotify] 投稿日時が指定されていないため、スケジュール設定をスキップします')
          }
        } else {
          console.log('[Spotify] 「スケジュール」ラジオボタンが見つかりませんでした')
        }
      } catch (scheduleError) {
        console.log('[Spotify] スケジュールセクションの処理でエラーが発生しました（スキップ）:', scheduleError.message)
      }

      console.log('[Spotify] 処理完了')
      return {
        success: true,
        message: 'Spotifyのエピソード作成ページへ移動し、音声ファイルをアップロードし、タイトルと説明文を設定しました',
        browser: true,
        wizardUrl
      }
    } catch (error) {
      console.error('[Spotify] エラー発生:', error)
      console.error('[Spotify] エラースタック:', error.stack)
      return {
        success: false,
        message: `Spotify遷移でエラーが発生しました: ${error.message}`
      }
    }
  })
}

module.exports = { registerSpotifyPublishHandler }

