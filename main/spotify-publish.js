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

function registerSpotifyPublishHandler({ ipcMain, getPageInstance }) {
  ipcMain.handle('publish-to-spotify', async (event, basename) => {
    try {
      console.log('[Spotify] 処理開始')
      const page = await getPageInstance()

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

      console.log('[Spotify] 処理完了')
      return {
        success: true,
        message: 'Spotifyのエピソード作成ページへ移動しました',
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

