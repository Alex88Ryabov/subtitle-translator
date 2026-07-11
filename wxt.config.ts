import { defineConfig } from 'wxt';

/**
 * Две цели сборки:
 *  - `wxt build` / `wxt zip`            — полная (Udemy + CourseHunter), для себя;
 *  - `wxt build -b store` / `zip -b store` — вариант для Chrome Web Store БЕЗ
 *    CourseHunter: стор может отклонить расширение, в манифесте которого
 *    прописан пиратский сайт. Entrypoint coursehunter исключается через
 *    `exclude: ['store']` в самом файле.
 */
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: ({ browser }) => {
    const isStore = browser === 'store';
    return {
      name: 'Alex Apps Subtitle Translator',
      description: isStore
        ? 'Переводит английские субтитры курсов Udemy и Coursera на украинский и русский: двойные субтитры поверх видео'
        : 'Переводит английские субтитры курсов на украинский и русский (Udemy, Coursera, CourseHunter)',
      permissions: ['storage'],
      icons: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
      host_permissions: [
        'https://translate.googleapis.com/*',
        'https://*.udemy.com/*',
        // VTT-файлы субтитров Udemy: подписанные URL на CDN (fetch через background).
        'https://*.udemycdn.com/*',
        'https://udemy-captions.s3.amazonaws.com/*',
        // Coursera: VTT отдаёт same-origin subtitleAssetProxy; host_permission
        // нужен только для запасного fetch через background.
        'https://www.coursera.org/*',
        ...(isStore
          ? []
          : ['https://coursehunter.net/*', 'https://*.coursehunter.net/*']),
      ],
    };
  },
});
