import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Course Subtitle Translator',
    description: 'Переводит английские субтитры курсов на украинский и русский (Udemy, CourseHunter)',
    permissions: ['storage'],
    host_permissions: [
      'https://translate.googleapis.com/*',
      'https://coursehunter.net/*',
      'https://*.coursehunter.net/*',
    ],
  },
});
