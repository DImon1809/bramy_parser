require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const cron   = require('node-cron');
const config = require('./config');
const logger = require('./logger');
const db     = require('./database');
const { getNewArticles } = require('./scraper');
const { formatTelegram, formatVK } = require('./formatter');
const { sendTelegram, sendVK }     = require('./publisher');
const bot    = require('./bot');

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

  let tgMsgId  = null;
  let vkPostId = null;

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

  db.markPosted(article.url, { tgMsgId, vkPostId });
}

async function run() {
  logger.info('══════════ Проверка новых статей ══════════');
  bot.setRunning(true);

  let articles;
  try {
    articles = await getNewArticles(db);
  } catch (e) {
    logger.error(`Ошибка парсера: ${e.message}`);
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
    run().catch(e => logger.error(`Ошибка по расписанию: ${e.message}`));
  });
}
