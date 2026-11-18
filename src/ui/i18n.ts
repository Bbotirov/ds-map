/**
 * Интернализация: все строки в таблицах ru и en.
 * Новый язык = новая таблица, без правок в компонентах.
 *
 * Ключи `phrase*` — это фразы ленты: короткое «что это было» по-человечески.
 * Лента печатает фразу, а не сырой идентификатор из лога харнеса; метка
 * (`label`) остаётся только подробностью справа от фразы.
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
    contextUnits: 'ток',
    themeDark: 'Тёмная',
    themeLight: 'Светлая',
    themeAuto: 'Авто',
    languageRu: 'Русский',
    languageEn: 'English',
    motionFull: 'Полная анимация',
    motionReduced: 'Минимум движения',
    pauseOn: 'пауза',
    pauseOff: 'продолжить',
    countersLabel: 'счётчики',
    errorLabel: 'Ошибка',
    unknownLabel: 'Неизвестно',
    promptLabel: 'Запрос',
    sessionLabel: 'сессия',
    answerOk: 'ход завершён',
    answerErr: 'ход с ошибкой',
    answerAborted: 'ход прерван',
    jobLabel: 'фоновая работа',
    retryBadge: 'повтор {a}/{o}',
    // Фразы ленты: по одному короткому описанию на тип события.
    phraseTurnStart: 'ход начат',
    phrasePrompt: 'ты написал · {n} симв.',
    phraseStep: 'шаг модели',
    phraseThink: 'размышление',
    phraseRetry: 'повтор запроса',
    phraseContext: 'контекст',
    phraseModelSwitch: 'смена модели',
    phraseCompaction: 'сжатие контекста',
    phraseGuard: 'правило доступа',
    phraseGuardPermission: 'пресет разрешений',
    phraseGuardSandbox: 'режим песочницы',
    phraseGuardApproval: 'политика подтверждений',
    phraseAgentMsg: 'входящее от агента · {n}',
    // Фразы вызовов: что это было за действие, а не имя инструмента.
    phraseReadFile: 'чтение файла',
    phraseWriteFile: 'запись файла',
    phraseEditFile: 'правка файла',
    phraseListFiles: 'просмотр папки',
    phraseSearchText: 'поиск по файлам',
    phraseSearchFiles: 'поиск файлов',
    phraseRunCommand: 'запуск команды',
    phraseChangeDir: 'смена папки',
    phraseWeb: 'запрос в сеть',
    phraseBrowser: 'работа в браузере',
    phraseSkill: 'вызов скилла',
    phraseSubagent: 'запуск субагента',
    phraseAgentMessage: 'сообщение агенту',
    phraseAgentList: 'список агентов',
    phraseJobStatus: 'статус фоновых работ',
    phraseTodo: 'план работ',
    phraseGoal: 'цель',
    phraseAskUser: 'вопрос вам',
    phraseMemory: 'работа с памятью',
    phraseAtFiles: 'работа с файлами',
    phraseAtShell: 'работа в шелле',
    phraseAtWeb: 'запрос в сеть',
    phraseAtBrowser: 'работа в браузере',
    phraseAtAgents: 'работа агента',
    phraseAtSkills: 'вызов скилла',
    phraseAtHooks: 'правило доступа',
    phraseAtMemory: 'работа с памятью',
    phraseAtModel: 'работа модели',
    phraseAtYou: 'ваше действие',
    phraseAction: 'действие',
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
    contextUnits: 'tok',
    themeDark: 'Dark',
    themeLight: 'Light',
    themeAuto: 'Auto',
    languageRu: 'Russian',
    languageEn: 'English',
    motionFull: 'Full motion',
    motionReduced: 'Reduced motion',
    pauseOn: 'pause',
    pauseOff: 'resume',
    countersLabel: 'counters',
    errorLabel: 'Error',
    unknownLabel: 'Unknown',
    promptLabel: 'Prompt',
    sessionLabel: 'session',
    answerOk: 'turn done',
    answerErr: 'turn failed',
    answerAborted: 'turn aborted',
    jobLabel: 'background job',
    retryBadge: 'retry {a}/{o}',
    phraseTurnStart: 'turn started',
    phrasePrompt: 'you wrote · {n} chars',
    phraseStep: 'model step',
    phraseThink: 'thinking',
    phraseRetry: 'retrying request',
    phraseContext: 'context',
    phraseModelSwitch: 'model switch',
    phraseCompaction: 'context compaction',
    phraseGuard: 'access rule',
    phraseGuardPermission: 'permission preset',
    phraseGuardSandbox: 'sandbox mode',
    phraseGuardApproval: 'approval policy',
    phraseAgentMsg: 'message from agent · {n}',
    phraseReadFile: 'reading a file',
    phraseWriteFile: 'writing a file',
    phraseEditFile: 'editing a file',
    phraseListFiles: 'listing a folder',
    phraseSearchText: 'searching files',
    phraseSearchFiles: 'searching for files',
    phraseRunCommand: 'running a command',
    phraseChangeDir: 'changing folder',
    phraseWeb: 'network request',
    phraseBrowser: 'browser action',
    phraseSkill: 'invoking a skill',
    phraseSubagent: 'starting a subagent',
    phraseAgentMessage: 'message to an agent',
    phraseAgentList: 'listing agents',
    phraseJobStatus: 'background job status',
    phraseTodo: 'task plan',
    phraseGoal: 'goal',
    phraseAskUser: 'question to you',
    phraseMemory: 'memory update',
    phraseAtFiles: 'file operation',
    phraseAtShell: 'shell command',
    phraseAtWeb: 'network request',
    phraseAtBrowser: 'browser action',
    phraseAtAgents: 'agent call',
    phraseAtSkills: 'skill call',
    phraseAtHooks: 'access rule',
    phraseAtMemory: 'memory call',
    phraseAtModel: 'model call',
    phraseAtYou: 'your action',
    phraseAction: 'action',
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

/** Строка с подстановками вида `{n}`, `{a}`, `{o}`. */
export function format(lang: Language, key: string, vars: Record<string, string | number>): string {
  let out = t(lang, key)
  for (const [name, value] of Object.entries(vars)) out = out.replace(`{${name}}`, String(value))
  return out
}

/**
 * Имя инструмента → ключ фразы. Список закрытый, как в `core/classify.ts`:
 * он снят с реальных имён dsh, а не с угадывания подстрок. Неизвестное имя
 * уходит в запасную фразу по станции — сырой идентификатор в ленте не
 * оказывается никогда.
 */
const TOOL_PHRASES: ReadonlyMap<string, string> = new Map<string, string>([
  ['read', 'phraseReadFile'],
  ['write', 'phraseWriteFile'],
  ['edit', 'phraseEditFile'],
  ['multiedit', 'phraseEditFile'],
  ['notebookedit', 'phraseEditFile'],
  ['apply_patch', 'phraseEditFile'],
  ['patch', 'phraseEditFile'],
  ['glob', 'phraseSearchFiles'],
  ['grep', 'phraseSearchText'],
  ['ls', 'phraseListFiles'],
  ['dir', 'phraseListFiles'],
  ['find', 'phraseSearchFiles'],
  ['pwd', 'phraseChangeDir'],
  ['working_directory', 'phraseChangeDir'],
  ['pwsh', 'phraseRunCommand'],
  ['bash', 'phraseRunCommand'],
  ['zsh', 'phraseRunCommand'],
  ['shell', 'phraseRunCommand'],
  ['powershell', 'phraseRunCommand'],
  ['terminal', 'phraseRunCommand'],
  ['run_command', 'phraseRunCommand'],
  ['exec_command', 'phraseRunCommand'],
  ['execute_command', 'phraseRunCommand'],
  ['curl', 'phraseWeb'],
  ['wget', 'phraseWeb'],
  ['webfetch', 'phraseWeb'],
  ['websearch', 'phraseWeb'],
  ['skill', 'phraseSkill'],
  ['subagent', 'phraseSubagent'],
  ['subagent_fork', 'phraseSubagent'],
  ['send_message', 'phraseAgentMessage'],
  ['list_agents', 'phraseAgentList'],
  ['job_list', 'phraseJobStatus'],
  ['job_output', 'phraseJobStatus'],
  ['todo_write', 'phraseTodo'],
  ['create_goal', 'phraseGoal'],
  ['get_goal', 'phraseGoal'],
  ['update_goal', 'phraseGoal'],
  ['ask_user_question', 'phraseAskUser'],
])

/** Запасная фраза по станции: покрытие полное, поэтому без `undefined`. */
const STATION_PHRASES: Readonly<Record<string, string>> = {
  files: 'phraseAtFiles',
  shell: 'phraseAtShell',
  web: 'phraseAtWeb',
  browser: 'phraseAtBrowser',
  agents: 'phraseAtAgents',
  skills: 'phraseAtSkills',
  hooks: 'phraseAtHooks',
  memory: 'phraseAtMemory',
  model: 'phraseAtModel',
  you: 'phraseAtYou',
}

/** Фраза вызова по имени инструмента и станции события. */
export function phraseKey(name: string, station: string): string {
  const n = name.trim().toLowerCase()
  // `mcp__playwright__browser_navigate`: тулка важнее имени сервера.
  const tail = n.startsWith('mcp__') ? (n.split('__').filter(Boolean).pop() ?? n) : n
  if (tail.startsWith('browser_') || tail === 'navigate') return 'phraseBrowser'
  const hit = TOOL_PHRASES.get(tail) ?? TOOL_PHRASES.get(n)
  if (hit) return hit
  return STATION_PHRASES[station] ?? 'phraseAction'
}

/** Фраза смены правила доступа: вид правила известен из события. */
export function guardPhraseKey(kind: string): string {
  if (kind === 'permission') return 'phraseGuardPermission'
  if (kind === 'sandbox') return 'phraseGuardSandbox'
  if (kind === 'approval') return 'phraseGuardApproval'
  return 'phraseGuard'
}
