// Auto-fill functionality for Voicy
function autoFillVoicy() {
  console.log('Starting Voicy auto-fill process...');

  // Configuration
  const CHAPTER_TITLE = '創理公式サイトはこちら';
  const URL = 'https://vibe-coding.munakata-engineer.com/';
  const HASHTAGS = ['AIプログラミング', 'VibeCoding', 'むなかた総理', 'プログラミング'];

  // Step 1: Fill chapter title
  function fillChapterTitle() {
    return new Promise((resolve) => {
      console.log('Step 1: Filling chapter title...');

      const selectors = [
        'input[placeholder="チャプター名を入力"]',
        'input[formcontrolname="title"]',
        'input[name="chapterName"]',
        '.chapter-detail input[type="text"]'
      ];

      let chapterInput = null;
      for (const selector of selectors) {
        chapterInput = document.querySelector(selector);
        if (chapterInput) break;
      }

      if (chapterInput && chapterInput.value !== CHAPTER_TITLE) {
        chapterInput.focus();
        chapterInput.select();
        chapterInput.value = CHAPTER_TITLE;

        const events = ['input', 'change', 'keyup', 'keydown'];
        events.forEach(eventType => {
          const event = new Event(eventType, { bubbles: true });
          chapterInput.dispatchEvent(event);
        });

        const inputEvent = new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          data: CHAPTER_TITLE
        });
        chapterInput.dispatchEvent(inputEvent);

        setTimeout(() => {
          chapterInput.blur();
          console.log('✅ Chapter title filled');
          resolve();
        }, 200);
      } else {
        console.log('⚠️ Chapter input not found or already filled');
        resolve();
      }
    });
  }

  // Step 2: Click URL button and fill URL
  function fillUrl() {
    return new Promise((resolve) => {
      console.log('Step 2: Adding URL...');

      // First click the URL button
      const urlButton = document.querySelector('button .fas.fa-link');
      const urlButtonParent = urlButton ? urlButton.closest('button') : null;

      if (urlButtonParent && urlButtonParent.textContent.includes('URL追加')) {
        urlButtonParent.click();
        console.log('URL button clicked');

        // Wait for dialog to appear and fill it
        const observer = new MutationObserver((mutations, obs) => {
          const urlDialog = document.querySelector('.article-item-modal');
          const urlInput = document.querySelector('input[name="addUrl"]');
          const applyButton = document.querySelector('.article-item-modal .btn-primary');

          if (urlDialog && urlInput && applyButton) {
            urlInput.focus();
            urlInput.value = URL;

            const events = ['input', 'change', 'keyup', 'keydown'];
            events.forEach(eventType => {
              const event = new Event(eventType, { bubbles: true });
              urlInput.dispatchEvent(event);
            });

            const inputEvent = new InputEvent('input', {
              bubbles: true,
              cancelable: true,
              data: URL
            });
            urlInput.dispatchEvent(inputEvent);

            setTimeout(() => {
              if (!applyButton.disabled) {
                applyButton.click();
                console.log('✅ URL added');
                obs.disconnect();
                resolve();
              }
            }, 300);
          }
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true
        });

        // Timeout fallback
        setTimeout(() => {
          observer.disconnect();
          resolve();
        }, 5000);
      } else {
        console.log('⚠️ URL button not found');
        resolve();
      }
    });
  }

  // Step 3: Fill hashtags
  function fillHashtags() {
    return new Promise((resolve) => {
      console.log('Step 3: Filling hashtags...');

      let hashtagIndex = 0;

      const fillNextHashtag = () => {
        if (hashtagIndex >= HASHTAGS.length) {
          console.log('✅ All hashtags filled');
          resolve();
          return;
        }

        const hashtagInput = document.querySelector('input[placeholder="ハッシュタグを入力"]');

        if (hashtagInput) {
          const hashtagText = HASHTAGS[hashtagIndex];

          hashtagInput.focus();
          hashtagInput.value = '';
          hashtagInput.dispatchEvent(new Event('input', { bubbles: true }));

          setTimeout(() => {
            hashtagInput.value = hashtagText;

            const events = ['input', 'change', 'keyup', 'keydown'];
            events.forEach(eventType => {
              const event = new Event(eventType, { bubbles: true });
              hashtagInput.dispatchEvent(event);
            });

            const inputEvent = new InputEvent('input', {
              bubbles: true,
              cancelable: true,
              data: hashtagText
            });
            hashtagInput.dispatchEvent(inputEvent);

            setTimeout(() => {
              const enterEvent = new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                bubbles: true,
                cancelable: true
              });
              hashtagInput.dispatchEvent(enterEvent);

              console.log(`Hashtag ${hashtagIndex + 1}/4 filled: ${hashtagText}`);
              hashtagIndex++;

              setTimeout(() => {
                fillNextHashtag();
              }, 800);
            }, 200);
          }, 100);
        } else {
          console.log(`⚠️ Hashtag input not found for index ${hashtagIndex}`);
          hashtagIndex++;
          if (hashtagIndex < HASHTAGS.length) {
            setTimeout(fillNextHashtag, 1000);
          } else {
            resolve();
          }
        }
      };

      fillNextHashtag();
    });
  }

  // Execute all steps in sequence
  async function executeSteps() {
    try {
      await fillChapterTitle();
      await new Promise(resolve => setTimeout(resolve, 500)); // Brief pause

      await fillUrl();
      await new Promise(resolve => setTimeout(resolve, 1000)); // Longer pause for URL dialog

      await fillHashtags();

      console.log('🎉 Voicy auto-fill completed!');
    } catch (error) {
      console.error('❌ Error during auto-fill:', error);
    }
  }

  executeSteps();
}

// Create the Voicy button
function createVoicyButton() {
  // Check if button already exists
  if (document.getElementById('voicy-auto-fill-btn')) {
    return;
  }

  const button = document.createElement('button');
  button.id = 'voicy-auto-fill-btn';
  button.innerHTML = '🎤 Voicy Auto Fill';
  button.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 10000;
    background: #4CAF50;
    color: white;
    border: none;
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: bold;
    cursor: pointer;
    box-shadow: 0 4px 8px rgba(0,0,0,0.2);
    transition: all 0.3s ease;
  `;

  button.onmouseover = () => {
    button.style.background = '#45a049';
    button.style.transform = 'translateY(-2px)';
  };

  button.onmouseout = () => {
    button.style.background = '#4CAF50';
    button.style.transform = 'translateY(0)';
  };

  button.onclick = () => {
    button.disabled = true;
    button.innerHTML = '⏳ Processing...';
    button.style.background = '#666';

    autoFillVoicy();

    setTimeout(() => {
      button.disabled = false;
      button.innerHTML = '🎤 Voicy Auto Fill';
      button.style.background = '#4CAF50';
    }, 10000);
  };

  document.body.appendChild(button);
  console.log('Voicy Auto Fill button created');
}

// Auto-start functionality
function autoStartVoicyFill() {
  console.log('Auto-starting Voicy fill for playlist/new page...');

  // Wait a bit for page to fully load
  setTimeout(() => {
    autoFillVoicy();
  }, 2000);
}

// Initialize when page loads
if (window.location.hostname === 'va-cms.admin.voicy.jp') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      // Check if we're on the new playlist page
      if (window.location.pathname.includes('/playlist/new')) {
        autoStartVoicyFill();
      }
      createVoicyButton();
    });
  } else {
    // Check if we're on the new playlist page
    if (window.location.pathname.includes('/playlist/new')) {
      autoStartVoicyFill();
    }
    createVoicyButton();
  }
}