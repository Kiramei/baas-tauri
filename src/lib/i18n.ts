import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enTranslations from '@/assets/locales/en.json';
import zhTranslations from '@/assets/locales/zh.json';
import jaTranslations from '@/assets/locales/ja.json';
import koTranslations from '@/assets/locales/ko.json';
import ruTranslations from '@/assets/locales/ru.json';
import frTranslations from '@/assets/locales/fr.json';
import deTranslations from '@/assets/locales/de.json';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: enTranslations },
      zh: { translation: zhTranslations },
      ja: { translation: jaTranslations },
      ko: { translation: koTranslations },
      ru: { translation: ruTranslations },
      fr: { translation: frTranslations },
      de: { translation: deTranslations },
    },
    lng: 'en', // Default locale presented on first launch.
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
  }).then(
    () => {
      console.log("[app]", "i18n loaded.");
    }
);

