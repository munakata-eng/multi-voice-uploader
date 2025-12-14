function extractSpotifyShowIdFromUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') return null
  const match = urlString.match(/\/pod\/show\/([^/]+)(?:\/|$)/)
  return match ? match[1] : null
}

async function waitForUrlToContain(page, substr, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const current = page.url()
    if (current && current.includes(substr)) return current
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return page.url()
}

function registerSpotifyPublishHandler({ ipcMain, getPageInstance }) {
  ipcMain.handle('publish-to-spotify', async (event, basename) => {
    try {
      const page = await getPageInstance()

      // 1) loginページへ
      await page.goto('https://creators.spotify.com/pod/login', { waitUntil: 'domcontentloaded' })

      // すでにログイン済みで /pod/show/... にいる可能性がある
      let currentUrl = page.url()

      // 2) 未ログインなら「Spotifyで続ける」をクリック
      if (currentUrl.includes('/pod/login')) {
        // a[href^="/api/shell/gateway"] 配下のボタン（ユーザー提示のDOMに合わせる）
        const continueSelector = 'a[href^="/api/shell/gateway"] button'
        await page.waitForSelector(continueSelector, { timeout: 30000 })

        await page.click(continueSelector)

        // クリック後、/pod/show/... に遷移するまで待つ（アカウントによって異なる）
        currentUrl = await waitForUrlToContain(page, '/pod/show/', 60000)
      }

      // 3) 遷移先URLから showId を抽出
      const showId = extractSpotifyShowIdFromUrl(currentUrl)
      if (!showId) {
        return {
          success: false,
          message: `Spotifyのshowページに遷移できませんでした。現在URL: ${currentUrl}`
        }
      }

      // 4) /home に遷移（まだ /home にいない場合）
      const homeUrl = `https://creators.spotify.com/pod/show/${showId}/home`
      if (!currentUrl.includes('/home')) {
        await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
        // /home への遷移完了を待つ
        await waitForUrlToContain(page, '/home', 10000)
      }

      // 5) /episode/wizard に移動
      const wizardUrl = `https://creators.spotify.com/pod/show/${showId}/episode/wizard`
      await page.goto(wizardUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })

      return {
        success: true,
        message: 'Spotifyのエピソード作成ページへ移動しました',
        browser: true,
        wizardUrl
      }
    } catch (error) {
      return {
        success: false,
        message: `Spotify遷移でエラーが発生しました: ${error.message}`
      }
    }
  })
}

module.exports = { registerSpotifyPublishHandler }

