import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enCommon from '@/locales/en/common.json';
import teCommon from '@/locales/te/common.json';

export const SUPPORTED_LANGUAGES = ['en', 'te'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const STORAGE_KEY = 'gaslink-language';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES,
    defaultNS: 'common',
    ns: ['common'],
    resources: {
      en: { common: enCommon },
      te: { common: teCommon },
    },
    detection: {
      // 1. Explicit user choice in localStorage wins.
      // 2. Else, browser preference.
      // 3. Else, fallback to 'en'.
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: STORAGE_KEY,
      caches: ['localStorage'],
    },
    interpolation: {
      escapeValue: false, // React already escapes
    },
    returnNull: false,
  });

export default i18n;

/**
 * Imperatively switch language and persist to localStorage.
 */
export function setLanguage(lang: SupportedLanguage) {
  void i18n.changeLanguage(lang);
}
