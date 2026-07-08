require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const cron   = require('node-cron');
const config = require('./config');
const logger = require('./logger');
const db     = require('./database');
const { getNewArticles } = require('./scraper');
const { formatTelegram, formatVK, formatOK } = require('./formatter');
const { sendTelegram, sendVK, sendOK }       = require('./publisher');
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

function tgPostUrl(msgId) {
  const ch = config.tg.channelId;
  const slug = ch.startsWith('@') ? ch.slice(1) : `c/${String(ch).replace('-100', '')}`;
  return `https://t.me/${slug}/${msgId}`;
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
