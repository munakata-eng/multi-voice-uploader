function registerStandfmPublishHandler({
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
}) {
  ipcMain.handle('publish-to-standfm', async (event, basename, description, bgm, publishDate, publishTime, category, imagePath, broadcastTitle) => {
    try {
      console.log(`Starting Stand.fm publish process for: ${basename}`);
      const debugStandfmImage = process.env.VUT_DEBUG_STANDFM_IMAGE === '1'

      const { audioDir, mdDir, metadataPath } = getAppPaths()

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
}

module.exports = { registerStandfmPublishHandler }

