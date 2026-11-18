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
    feedNow: 'Сейчас',
    noEvents: 'Нет событий',
    nothingRunning: 'Нет активной работы',
    connectionLost: 'Нет соединения с сайдкаром',
    contextRing: 'Контекст',
    contextNone: 'Контекст ещё не измерен',
    themeDark: 'Тёмная',
    themeLight: 'Светлая',
    themeAuto: 'Авто',
    languageRu: 'Русский',
    languageEn: 'English',
    motionFull: 'Полная анимация',
    motionReduced: 'Минимум движения',
    errorLabel: 'Ошибка',
    unknownLabel: 'Неизвестно',
    promptLabel: 'Запрос',
    sessionLabel: 'Сессия',
    answerOk: 'Ответ готов',
    answerErr: 'Ответ с ошибкой',
    answerAborted: 'Ответ прерван',
    compactionLabel: 'Уплотнение контекста',
    jobLabel: 'Фоновая работа',
    modelSwitchLabel: 'Смена модели',
    promptChars: 'Запрос · {n} симв.',
    expandRow: 'Развернуть строку',
    collapseRow: 'Свернуть строку',
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
    feedNow: 'Now',
    noEvents: 'No events',
    nothingRunning: 'Nothing running',
    connectionLost: 'No connection to sidecar',
    contextRing: 'Context',
    contextNone: 'Context is not measured yet',
    themeDark: 'Dark',
    themeLight: 'Light',
    themeAuto: 'Auto',
    languageRu: 'Russian',
    languageEn: 'English',
    motionFull: 'Full motion',
    motionReduced: 'Reduced motion',
    errorLabel: 'Error',
    unknownLabel: 'Unknown',
    promptLabel: 'Prompt',
    sessionLabel: 'Session',
    answerOk: 'Answer done',
    answerErr: 'Answer failed',
    answerAborted: 'Answer aborted',
    compactionLabel: 'Context compaction',
    jobLabel: 'Background job',
    modelSwitchLabel: 'Model switch',
    promptChars: 'Prompt · {n} chars',
    expandRow: 'Expand row',
    collapseRow: 'Collapse row',
  },
}

export function t(lang: Language, key: string): string {
  return DICTIONARY[lang][key] ?? key
}

/** Подпись станции: `files` → `stationFiles` → «Файлы» / «Files». */
export function stationLabel(lang: Language, station: string): string {
  return t(lang, `station${station[0] ? station[0].toUpperCase() : ''}${station.slice(1)}`)
}
