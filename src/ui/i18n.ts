/**
 * Интернализация: все строки в таблицах ru и en.
 * Новый язык = новая таблица, без правок в компонентах.
 */

export type Language = 'ru' | 'en'

export const DICTIONARY: Record<Language, Record<string, string>> = {
  ru: {
    mapLabel: 'Карта работы агента',
    stationFiles: 'Файлы',
    stationShell: 'Шелл',
    stationWeb: 'Сеть',
    stationAgents: 'Агенты',
    stationSkills: 'Скиллы',
    stationHooks: 'Хуки',
    stationMemory: 'Память',
    stationBrowser: 'Браузер',
    stationModel: 'Модель',
    stationYou: 'Вы',
    feedTitle: 'Лента событий',
    noEvents: 'Нет событий',
    connectionLost: 'Нет соединения с сайдкаром',
    contextRing: 'Контекст',
    themeDark: 'Тёмная',
    themeLight: 'Светлая',
    themeAuto: 'Авто',
    languageRu: 'Русский',
    languageEn: 'English',
    motionFull: 'Полная анимация',
    motionReduced: 'Минимум движения',
    errorLabel: 'Ошибка',
    unknownLabel: 'Неизвестно',
  },
  en: {
    mapLabel: 'Agent activity map',
    stationFiles: 'Files',
    stationShell: 'Shell',
    stationWeb: 'Web',
    stationAgents: 'Agents',
    stationSkills: 'Skills',
    stationHooks: 'Hooks',
    stationMemory: 'Memory',
    stationBrowser: 'Browser',
    stationModel: 'Model',
    stationYou: 'You',
    feedTitle: 'Event feed',
    noEvents: 'No events',
    connectionLost: 'No connection to sidecar',
    contextRing: 'Context',
    themeDark: 'Dark',
    themeLight: 'Light',
    themeAuto: 'Auto',
    languageRu: 'Russian',
    languageEn: 'English',
    motionFull: 'Full motion',
    motionReduced: 'Reduced motion',
    errorLabel: 'Error',
    unknownLabel: 'Unknown',
  },
}

export function t(lang: Language, key: string): string {
  return DICTIONARY[lang][key] ?? key
}
