const axios  = require('axios');
const config = require('./config');
const logger = require('./logger');
const db     = require('./database');
const { scrapeOneArticle } = require('./scraper');
const { formatTelegram, formatVK } = require('./formatter');
const { sendTelegram, sendVK }     = require('./publisher');

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
    inline_keyboard: [[
      { text: '🚀 Тестовый запуск', callback_data: 'test_run' },
      { text: '📊 Состояние',        callback_data: 'status'   },
    ]],
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

  try {
    await sendMsg(chatId, result.join('\n'), { reply_markup: mainKeyboard() });
  } catch (e) {
    logger.warn(`Тест: не удалось отправить итоговый отчёт (${latest.title}): ${e.stack || e.message}`);
  }
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
    if (cb.data === 'status')   await onStatus(chatId, cb.id);
    if (cb.data === 'test_run') await onTestRun(chatId, cb.id);
  }
}

// ─── Long polling ─────────────────────────────────────────────────────────────

async function startPolling() {
  if (!TOKEN || !ADMINS.size) {
    logger.warn('TG бот: не задан токен или TG_ADMIN_ID — polling не запущен');
    return;
  }
  logger.info('TG бот: запуск...');
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
