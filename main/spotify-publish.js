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
  ipcMain.handle('publish-to-spotify', async (event, basename, broadcastTitle, description, imagePath) => {
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

      // 9) 説明文の設定
      console.log('[Spotify] ステップ9: 説明文の設定を開始...')
      const finalDescription = description || ''

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
            // contenteditableのdivの場合
            await descriptionElement.click()
            await descriptionElement.focus()

            // 既存の内容をクリア
            await page.evaluate((el) => {
              el.textContent = ''
              el.innerHTML = ''
              // Slateエディタの場合は、空の段落を設定
              if (el.hasAttribute('data-slate-editor')) {
                el.innerHTML = '<p><br></p>'
              }
            }, descriptionElement)

            // 少し待ってから入力
            await new Promise(resolve => setTimeout(resolve, 300))

            // 説明文を入力（typeで入力）
            await descriptionElement.type(finalDescription)
            console.log(`[Spotify] 説明文を設定しました`)
          } else {
            console.log('[Spotify] 説明文入力欄が見つかりませんでした')
          }
        } catch (descError) {
          console.error('[Spotify] 説明文設定でエラーが発生しました:', descError.message)
        }
      } else {
        console.log('[Spotify] 説明文が指定されていないため、スキップします')
      }

      await new Promise(resolve => setTimeout(resolve, 1000))

      // 10) 画像のアップロード（画像が選択されている場合）
      console.log('[Spotify] ステップ10: 画像のアップロードを確認中...')
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
                  // モーダルが閉じるまで少し待機
                  await new Promise(resolve => setTimeout(resolve, 2000))
                  console.log('[Spotify] 画像編集モーダルの処理が完了しました')
                } else {
                  console.log('[Spotify] 保存ボタンが見つかりませんでした')
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

