require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const cron   = require('node-cron');
const config = require('./config');
const logger = require('./logger');
const db     = require('./database');
const { getNewArticles, scrapeOneArticle } = require('./scraper');
const { formatTelegram, formatVK, formatOK, formatZenDraft } = require('./formatter');
const { sendTelegram, sendVK, sendOK }       = require('./publisher');
const { rewriteArticle } = require('./rewriter');
const { checkRefreshTokenWarning } = require('./ok');
const { checkLowBalanceWarning } = require('./aiBalance');
const bot    = require('./bot');

// Обычный полный прогон занимает 6-7 минут. Если завис браузер Playwright
// (см. инцидент 2026-07-08 — headless-браузер перестаёт отвечать на команды
// под нагрузкой на сервере 1 vCPU/1GB), promise из getNewArticles может не
// завершиться никогда, и bot.setRunning(false) не вызовется — тогда каждый
// следующий запуск по расписанию будет молча пропускаться навсегда.
// Playwright не даёт доступа к системному процессу браузера при обычном
// chromium.launch(), поэтому точечно прибить только его нельзя — вместо
// этого при превышении таймаута роняем весь процесс, чтобы pm2 (autorestart
// включён) поднял его заново и вместе с ним подчистил зависший Chromium.
const RUN_TIMEOUT_MS = 20 * 60 * 1000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Таймаут ${ms / 60000} мин`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function tgPostUrlFor(channelId, msgId) {
  const slug = channelId.startsWith('@') ? channelId.slice(1) : `c/${String(channelId).replace('-100', '')}`;
  return `https://t.me/${slug}/${msgId}`;
}

function tgPostUrl(msgId) {
  return tgPostUrlFor(config.tg.channelId, msgId);
}

function draftPostUrl(msgId) {
  return tgPostUrlFor(config.tg.draftChannelId, msgId);
}

function vkPostUrl(postId) {
  return `https://vk.com/wall-${config.vk.groupId}_${postId}`;
}

async function publish(article) {
  logger.info(`Публикуем: "${article.title}" [${article.section}]`);

  const tgPost = formatTelegram(article);
  const vkPost = formatVK(article);
  const okPost = formatOK(article);

  let tgMsgId  = null;
  let vkPostId = null;
  let okPostId = null;

  // ── Telegram ── sendTelegram сам делает до 6 попыток с паузой между ними
  try {
    const tg = await sendTelegram(tgPost);
    tgMsgId = tg?.msgId ?? null;
    const tgUrl = tgMsgId ? tgPostUrl(tgMsgId) : '';
    if (tgPost.type === 'photo' && !tg?.withPhoto) {
      logger.warn(`  ⚠️ TG: опубликовано без фото (id=${tgMsgId})`);
      // Уведомляем только об ошибке публикации фото
      await logger.errorNotify(`Telegram: опубликовано БЕЗ фото\n«${article.title}»\n${tgUrl}`);
    } else {
      logger.info(`  ✓ TG: id=${tgMsgId}${tg?.withPhoto ? ' 🖼' : ' 📝'}`);
    }
  } catch (e) {
    await logger.errorNotify(`Не удалось опубликовать в Telegram: «${article.title}»`, e);
  }

  // ── ВКонтакте ── sendVK сам делает до 6 попыток с паузой между ними
  try {
    vkPostId = await sendVK(vkPost);
    logger.info(`  ✓ VK: post_id=${vkPostId}${vkPost.imageData ? ' 🖼' : ' 📝'}`);
  } catch (e) {
    await logger.errorNotify(`Не удалось опубликовать в ВКонтакте: «${article.title}»`, e);
  }

  // ── Одноклассники ── sendOK сам делает до 6 попыток с паузой между ними
  try {
    okPostId = await sendOK(okPost);
    logger.info(`  ✓ ОК: id=${okPostId}${okPost.imageData ? ' 🖼' : ' 📝'}`);
  } catch (e) {
    await logger.errorNotify(`Не удалось опубликовать в Одноклассниках: «${article.title}»`, e);
  }

  db.markPosted(article.url, { tgMsgId, vkPostId, okPostId });

  // ── Дзен ── независимо от остальных каналов. Рерайт через ИИ и отправка в
  // черновой канал зависят от внешних сервисов (OpenAI, Telegram) — при сбое
  // сети или временной недоступности не роняем публикацию статьи целиком:
  // postedZen останется false, и retryZenDrafts() подхватит её на следующем
  // прогоне парсера (см. run()), без ручного вмешательства.
  try {
    await publishZenDraft(article);
  } catch (e) {
    logger.warn(`  ⚠️ Дзен: не удалось опубликовать черновик — отложено, попробуем на следующем прогоне (${e.message})`);
    await logger.errorNotify(`Не удалось опубликовать черновик для Дзена (отложено на повтор): «${article.title}»`, e);
  }
}

// Публикует ИИ-переписанную версию статьи в резервный Telegram-канал; сам
// Дзен подключён к этому каналу через кросспостинг (настраивается на стороне
// Дзена, вне парсера). Бросает исключение при сбое — решение, уведомлять ли
// сразу или тихо повторить позже, принимает вызывающий код.
async function publishZenDraft(article) {
  if (!config.tg.draftChannelId) return;

  const rewritten = await rewriteArticle(article);
  const draftPost = formatZenDraft(article, rewritten);
  const draft = await sendTelegram(draftPost, config.tg.draftChannelId);
  if (draft?.msgId) {
    const url = draftPostUrl(draft.msgId);
    logger.info(`  ✓ Дзен (черновик): ${url}`);
    db.markPosted(article.url, { zenUrl: url });
  }
}

// Повторная попытка для статей, где черновик для Дзена не опубликовался с
// первого раза (сбой сети/ИИ) — вызывается в конце каждого прогона. imageData
// не хранится в БД (это Buffer, не JSON), поэтому если у статьи была картинка,
// перескрапиваем страницу заново, как это уже делает "Тестовый запуск" в боте.
async function retryZenDrafts() {
  if (!config.tg.draftChannelId) return;

  const pending = db.getUnpostedZen();
  if (pending.length === 0) return;

  logger.info(`Дзен: повторная попытка для ${pending.length} черновиков`);
  for (const stored of pending) {
    const article = { ...stored };
    if (article.imageUrl && !article.imageData) {
      try {
        const scraped = await scrapeOneArticle(article.url);
        if (scraped) {
          article.text      = scraped.text      || article.text      || '';
          article.imageUrl  = scraped.imageUrl  || article.imageUrl  || null;
          article.imageData = scraped.imageData || null;
        }
      } catch (e) {
        logger.warn(`Дзен (повтор): не удалось перескрапить ${article.url}: ${e.message}`);
      }
    }

    try {
      await publishZenDraft(article);
    } catch (e) {
      logger.warn(`Дзен (повтор): снова не удалось для «${article.title}» — ${e.message}`);
    }
  }
}

async function run() {
  logger.info('══════════ Проверка новых статей ══════════');
  bot.setRunning(true);

  let articles;
  try {
    articles = await withTimeout(getNewArticles(db), RUN_TIMEOUT_MS);
  } catch (e) {
    logger.error(`Ошибка парсера: ${e.message}`);
    if (/^Таймаут /.test(e.message)) {
      await logger.errorNotify(`Парсер завис более ${RUN_TIMEOUT_MS / 60000} мин (браузер не отвечает) — перезапускаю процесс`);
      process.exit(1); // pm2 (autorestart) поднимет процесс и подчистит зависший Chromium
    }
    bot.setRunning(false);
    return;
  }

  if (articles.length === 0) {
    logger.info('Новых статей нет');
  } else {
    logger.info(`Найдено новых: ${articles.length}`);
    for (const article of articles) {
      db.save(article);
      await publish(article);
    }
  }

  await retryZenDrafts();

  // Ежедневная проверка (внутри самой функции — не чаще раза в сутки), не
  // истекает ли скоро refresh_token ОК, чтобы не словить внезапную остановку
  // публикации в ОК через месяц без предупреждения
  const okWarning = checkRefreshTokenWarning();
  if (okWarning) {
    await logger.errorNotify(
      `ОК: refresh_token истекает примерно через ${okWarning.daysRemaining} дн. ` +
      `Нажми «🔗 Перелогиниться в ОК» в этом боте, чтобы обновить его.`,
    );
  }

  // Аналогичная ежедневная проверка баланса счёта, который даёт доступ к ИИ
  // (proxyapi.ru) — без него рерайт для Дзена перестанет работать молча
  const balanceWarning = await checkLowBalanceWarning();
  if (balanceWarning) {
    await logger.errorNotify(
      `ИИ (proxyapi.ru): на счету осталось ${balanceWarning.balance.toFixed(1)} ₽ — ` +
      `рерайт статей для Дзена скоро перестанет работать. ` +
      `Пополнить: https://console.proxyapi.ru/`,
    );
  }

  bot.setLastRun();
  bot.setRunning(false);
  logger.info('══════════ Готово ══════════\n');
}

// ─── Запуск ───────────────────────────────────────────────────────────────────

const runOnce = process.argv.includes('--once');

if (runOnce) {
  logger.info('Режим: однократная проверка');
  run().catch(e => {
    logger.error(`Фатальная ошибка: ${e.message}`);
    process.exit(1);
  });
} else {
  const interval = config.scraper.checkIntervalMinutes;
  logger.info(`Режим: мониторинг каждые ${interval} мин`);

  bot.startPolling();
  run().catch(e => logger.error(`Ошибка при старте: ${e.message}`));
  cron.schedule(`*/${interval} * * * *`, () => {
    if (bot.getRunning()) {
      logger.warn('Предыдущий прогон ещё не завершился — пропускаем это расписание');
      return;
    }
    run().catch(e => logger.error(`Ошибка по расписанию: ${e.message}`));
  });
}
