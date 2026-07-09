const os     = require('os');
const axios  = require('axios');
const config = require('./config');
const logger = require('./logger');
const db     = require('./database');
const { scrapeOneArticle } = require('./scraper');
const { formatTelegram, formatVK, formatOK } = require('./formatter');
const { sendTelegram, sendVK, sendOK }       = require('./publisher');

const TOKEN   = config.tg.botToken;
const ADMINS  = new Set(config.tg.adminIds.map(String));
const BASE    = `https://api.telegram.org/bot${TOKEN}`;

// Состояние парсера — обновляется из main.js
let lastRunAt  = null;
let isRunning  = false;

function setLastRun()       { lastRunAt = new Date(); }
function setRunning(val)    { isRunning = val; }
function getRunning()       { return isRunning; }

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function api(method, body = {}) {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await axios.post(`${BASE}/${method}`, body, { timeout: 15000 });
      return res.data?.result;
    } catch (e) {
      if (attempt < MAX_ATTEMPTS) {
        logger.warn(`TG бот: ${method} попытка ${attempt}/${MAX_ATTEMPTS} не удалась (${e.code || e.message}). Повтор через 3с...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw e;
    }
  }
}

async function sendMsg(chatId, text, extra = {}) {
  return api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🚀 Тестовый запуск', callback_data: 'test_run' },
        { text: '📊 Состояние',        callback_data: 'status'   },
      ],
      [
        { text: '🔄 Перезапустить', callback_data: 'restart_confirm' },
      ],
    ],
  };
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

function cpuTimesTotal() {
  return os.cpus().reduce((acc, c) => {
    for (const k in c.times) acc[k] = (acc[k] || 0) + c.times[k];
    return acc;
  }, {});
}

// Загрузка CPU честным способом — как top/htop: две выборки суммарного
// времени по всем ядрам с паузой между ними, доля неidle-времени в разнице.
// Раньше здесь был os.loadavg() (очередь на CPU за 1/5/15 минут), пересчитанный
// в "%" делением на число ядер — на 1 ядре это давало вроде 313%, что не
// сравнить с показометрами вроде top (там было честных ~70%).
function getCpuPercent(sampleMs = 200) {
  return new Promise((resolve) => {
    const start = cpuTimesTotal();
    setTimeout(() => {
      const end = cpuTimesTotal();
      const idleDiff  = end.idle - start.idle;
      const totalDiff = Object.keys(end).reduce((sum, k) => sum + (end[k] - start[k]), 0);
      resolve(totalDiff <= 0 ? 0 : Math.round(100 * (1 - idleDiff / totalDiff)));
    }, sampleMs);
  });
}

// os.loadavg() на Windows всегда возвращает [0,0,0] (не поддерживается ОС) —
// на боевом Linux-сервере даёт честную загрузку по 1/5/15-минутным окнам.
// Показываем как отдельную справочную метрику (очередь, не "%"), чтобы не
// путать с cpuPercent выше.
function getSystemStats() {
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const usedMem  = totalMem - freeMem;
  const cpuCount = os.cpus().length || 1;
  const [load1, load5, load15] = os.loadavg();

  return {
    load1, load5, load15,
    cpuCount,
    memPercent: Math.round((usedMem / totalMem) * 100),
    usedMem, totalMem,
  };
}

// ─── Обработчики ─────────────────────────────────────────────────────────────

async function onStart(chatId) {
  const text = [
    '👋 Привет! Я бот-парсер <b>bramy.ru</b>\n',
    'Автоматически слежу за новыми материалами и публикую их:',
    '📰 <b>Новости</b> — все статьи',
    '🎁 <b>Акции</b> — все акции',
    '🛒 <b>Магазин</b> — информация о новых товарах\n',
    `⏱ Проверяю каждые ${config.scraper.checkIntervalMinutes} мин`,
    `📢 Публикую в канал Telegram и группу ВКонтакте`,
  ].join('\n');

  await sendMsg(chatId, text, { reply_markup: mainKeyboard() });
}

async function onStatus(chatId, cbId) {
  await api('answerCallbackQuery', { callback_query_id: cbId });

  const all       = db.all();
  const total     = all.length;
  const published = all.filter(a => a.postedTg || a.postedVk).length;
  const notPosted = all.filter(a => !a.postedTg && !a.postedVk).length;

  let lastRun = 'ещё не запускался';
  if (lastRunAt) {
    const mins = Math.round((Date.now() - lastRunAt.getTime()) / 60000);
    lastRun = mins === 0 ? 'только что' : `${mins} мин назад`;
  }

  const lines = [
    '📊 <b>Состояние парсера</b>\n',
    `🕐 Последняя проверка: ${lastRun}`,
    `📚 Статей в базе: ${total}`,
    `✅ Опубликовано: ${published}`,
  ];
  if (notPosted) lines.push(`❌ Не опубликовано: ${notPosted}`);
  lines.push('');
  lines.push(isRunning ? '⏳ Парсер сейчас работает...' : '🟢 Парсер активен');

  const stats     = getSystemStats();
  const cpuPercent = await getCpuPercent();
  lines.push('');
  lines.push(`🖥 CPU: ${cpuPercent}% (load avg ${stats.load1.toFixed(2)}/${stats.load5.toFixed(2)}/${stats.load15.toFixed(2)}, ядер: ${stats.cpuCount})`);
  lines.push(`💾 RAM: ${stats.memPercent}% (${formatBytes(stats.usedMem)} / ${formatBytes(stats.totalMem)})`);

  await sendMsg(chatId, lines.join('\n'), { reply_markup: mainKeyboard() });
}

async function onTestRun(chatId, cbId) {
  try {
    await api('answerCallbackQuery', { callback_query_id: cbId, text: 'Запускаю...' });
  } catch (e) {
    // Не критично для самого теста (например, callback уже устарел) — просто продолжаем
    logger.warn(`Тест: answerCallbackQuery не удался: ${e.stack || e.message}`);
  }

  const latest = db.getLatest();
  if (!latest) {
    await sendMsg(chatId, '⚠️ База данных пуста. Сначала запусти парсер.', { reply_markup: mainKeyboard() });
    return;
  }

  await sendMsg(chatId, `⏳ Публикую статью:\n«${latest.title}»\n\nПарсю страницу...`);

  // Re-scrape чтобы получить imageData
  let article = { ...latest };
  try {
    const scraped = await scrapeOneArticle(latest.url);
    if (scraped) {
      article.text      = scraped.text      || latest.text      || '';
      article.imageUrl  = scraped.imageUrl  || latest.imageUrl  || null;
      article.imageData = scraped.imageData || null;
    }
  } catch (e) {
    logger.warn(`Тест: не удалось спарсить ${latest.url}: ${e.message}`);
  }

  const result = [`🔍 <b>Тестовый запуск</b>\n«${latest.title}»\n`];

  // ── Telegram ──
  if (latest.postedTg) {
    const tgUrl = latest.tgMsgId
      ? `https://t.me/${config.tg.channelId.replace('@', '')}/${latest.tgMsgId}`
      : '';
    result.push(`ℹ️ Telegram: уже опубликовано${tgUrl ? ` — <a href="${tgUrl}">открыть</a>` : ''}`);
  } else {
    try {
      const tg = await sendTelegram(formatTelegram(article));
      const tgMsgId = tg?.msgId ?? null;
      db.markPosted(latest.url, { tgMsgId });
      const tgUrl = tgMsgId ? `https://t.me/${config.tg.channelId.replace('@', '')}/${tgMsgId}` : '';
      result.push(`✅ Telegram: опубликовано${tgUrl ? ` — <a href="${tgUrl}">открыть</a>` : ''}`);
    } catch (e) {
      result.push(`❌ Telegram: ошибка — ${e.message}`);
    }
  }

  // ── ВКонтакте ──
  if (latest.postedVk) {
    const vkUrl = latest.vkPostId
      ? `https://vk.com/wall-${config.vk.groupId}_${latest.vkPostId}`
      : '';
    result.push(`ℹ️ ВКонтакте: уже опубликовано${vkUrl ? ` — <a href="${vkUrl}">открыть</a>` : ''}`);
  } else {
    try {
      const vkPostId = await sendVK(formatVK(article));
      db.markPosted(latest.url, { vkPostId });
      const vkUrl = `https://vk.com/wall-${config.vk.groupId}_${vkPostId}`;
      result.push(`✅ ВКонтакте: опубликовано — <a href="${vkUrl}">открыть</a>`);
    } catch (e) {
      result.push(`❌ ВКонтакте: ошибка — ${e.message}`);
    }
  }

  // ── Одноклассники ──
  if (latest.postedOk) {
    const okUrl = latest.okPostId ? `https://ok.ru/group/${config.ok.groupId}/topic/${latest.okPostId}` : '';
    result.push(`ℹ️ ОК: уже опубликовано${okUrl ? ` — <a href="${okUrl}">открыть</a>` : ''}`);
  } else {
    try {
      const okPostId = await sendOK(formatOK(article));
      db.markPosted(latest.url, { okPostId });
      const okUrl = `https://ok.ru/group/${config.ok.groupId}/topic/${okPostId}`;
      result.push(`✅ ОК: опубликовано — <a href="${okUrl}">открыть</a>`);
    } catch (e) {
      result.push(`❌ ОК: ошибка — ${e.message}`);
    }
  }

  try {
    await sendMsg(chatId, result.join('\n'), { reply_markup: mainKeyboard() });
  } catch (e) {
    logger.warn(`Тест: не удалось отправить итоговый отчёт (${latest.title}): ${e.stack || e.message}`);
  }
}

// Перезапуск — через process.exit(0): процесс управляется через pm2
// (autorestart включён), который поднимет его заново. Прямого доступа
// к системному процессу браузера у Playwright нет (см. main.js), так что
// это тот же принцип, что и в watchdog'e зависшего прогона — уронить
// процесс целиком, а не пытаться прибить что-то точечно.
async function onRestartConfirm(chatId, cbId) {
  await api('answerCallbackQuery', { callback_query_id: cbId });

  const warning = isRunning
    ? '\n\n⚠️ Сейчас идёт прогон парсера — если он на середине публикации статьи, она может быть помечена как «виденная», но не опубликована.'
    : '';

  await sendMsg(chatId, `🔄 Перезапустить процесс парсера?${warning}`, {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Да, перезапустить', callback_data: 'restart_do' },
        { text: '❌ Отмена',            callback_data: 'restart_cancel' },
      ]],
    },
  });
}

async function onRestartDo(chatId, cbId) {
  await api('answerCallbackQuery', { callback_query_id: cbId, text: 'Перезапускаю...' });
  await sendMsg(chatId, '🔄 Перезапускаю процесс...');
  logger.info(`Перезапуск по команде из Telegram (chatId=${chatId})`);
  setTimeout(() => process.exit(0), 300);
}

async function onRestartCancel(chatId, cbId) {
  await api('answerCallbackQuery', { callback_query_id: cbId, text: 'Отменено' });
  await sendMsg(chatId, '❌ Перезапуск отменён', { reply_markup: mainKeyboard() });
}

// ─── Диспетчер обновлений ─────────────────────────────────────────────────────

async function handleUpdate(update) {
  const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
  if (!chatId) return;
  if (!ADMINS.has(String(chatId))) {
    if (update.message) {
      await sendMsg(chatId, '⛔ Доступ запрещён. Этот бот предназначен только для администратора.');
    } else if (update.callback_query) {
      await api('answerCallbackQuery', {
        callback_query_id: update.callback_query.id,
        text: '⛔ Доступ запрещён',
        show_alert: true,
      });
    }
    return;
  }

  if (update.message?.text === '/start') {
    await onStart(chatId);
    return;
  }

  const cb = update.callback_query;
  if (cb) {
    if (cb.data === 'status')          await onStatus(chatId, cb.id);
    if (cb.data === 'test_run')        await onTestRun(chatId, cb.id);
    if (cb.data === 'restart_confirm') await onRestartConfirm(chatId, cb.id);
    if (cb.data === 'restart_do')      await onRestartDo(chatId, cb.id);
    if (cb.data === 'restart_cancel')  await onRestartCancel(chatId, cb.id);
  }
}

// ─── Long polling ─────────────────────────────────────────────────────────────

async function startPolling() {
  if (!TOKEN || !ADMINS.size) {
    logger.warn('TG бот: не задан токен или TG_ADMIN_ID — polling не запущен');
    return;
  }
  logger.info('TG бот: запуск...');
  // Уведомляем при каждом старте процесса — покрывает и ручной перезапуск
  // из бота (onRestartDo), и автоматический после зависания (watchdog в
  // main.js), и обычный деплой. Прежний процесс, отправивший "Перезапускаю...",
  // к этому моменту уже мёртв (process.exit) и сам подтвердить не может —
  // подтверждает уже новый процесс, когда встаёт на polling.
  await logger.infoNotify('✅ Процесс запущен и снова на связи');
  let offset = 0;
  while (true) {
    try {
      const res = await axios.get(`${BASE}/getUpdates`, {
        params: { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
        timeout: 30000,
      });
      for (const upd of res.data?.result || []) {
        offset = upd.update_id + 1;
        handleUpdate(upd).catch(e => logger.warn(`Bot handleUpdate: ${e.stack || e.message}`));
      }
    } catch (e) {
      logger.warn(`TG polling: ${e.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

module.exports = { startPolling, setLastRun, setRunning, getRunning };
