const axios = require('axios');
const FormData = require('form-data');
const config = require('./config');
const logger = require('./logger');
const { sendOK } = require('./ok');
const { sendLiveJournal } = require('./livejournal');

const VK_V = '5.199';

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegramOnce(post, channelId) {
  const base = `https://api.telegram.org/bot${config.tg.botToken}`;
  const UPLOAD_TIMEOUT = 30000;
  let res;
  let withPhoto = false;

  if (post.type === 'photo') {
    // Получаем байты картинки: либо уже скачаны через Playwright, либо скачиваем сами
    let photoBuffer = post.imageData || null;
    if (!photoBuffer) {
      try {
        const imgRes = await axios.get(post.imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
        photoBuffer = Buffer.from(imgRes.data);
      } catch (_) {}
    }

    if (photoBuffer) {
      const form = new FormData();
      form.append('chat_id',    channelId);
      form.append('caption',    post.caption);
      form.append('parse_mode', post.parseMode);
      form.append('photo', photoBuffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });
      res = await axios.post(`${base}/sendPhoto`, form, { headers: form.getHeaders(), timeout: UPLOAD_TIMEOUT });
      withPhoto = true;
    } else {
      // Картинку получить не удалось — отправляем текстом
      res = await axios.post(`${base}/sendMessage`, {
        chat_id:                  channelId,
        text:                     post.caption,
        parse_mode:               post.parseMode,
        disable_web_page_preview: false,
      }, { timeout: UPLOAD_TIMEOUT });
    }
  } else {
    res = await axios.post(`${base}/sendMessage`, {
      chat_id:                  channelId,
      text:                     post.text,
      parse_mode:               post.parseMode,
      disable_web_page_preview: false,
    }, { timeout: UPLOAD_TIMEOUT });
  }

  const msgId = res.data?.result?.message_id;
  return { msgId: msgId ?? null, withPhoto };
}

// channelId по умолчанию — основной канал; передайте другой (например,
// config.tg.draftChannelId), чтобы отправить в другой чат/канал тем же ботом.
async function sendTelegram(post, channelId = config.tg.channelId) {
  if (!config.tg.botToken || !channelId) {
    logger.warn('Telegram не настроен, пропускаем');
    return null;
  }

  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await sendTelegramOnce(post, channelId);
    } catch (e) {
      const status = e.response?.status;
      const detail = e.response?.data?.description
        || (status ? `HTTP ${status}` : null)
        || e.code
        || e.message
        || String(e);

      if (attempt < MAX_ATTEMPTS) {
        logger.warn(`Telegram: попытка ${attempt}/${MAX_ATTEMPTS} не удалась (${detail}). Повтор через 5с...`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      logger.error(`Telegram: полная ошибка — ${e.stack || e}`);
      throw new Error(`Telegram: ${detail}`);
    }
  }
}

// ─── ВКонтакте ────────────────────────────────────────────────────────────────

async function sendVK(post) {
  if (!config.vk.token || !config.vk.groupId) {
    logger.warn('VK не настроен, пропускаем');
    return null;
  }

  const body = new URLSearchParams({
    owner_id:     `-${config.vk.groupId}`,
    message:      post.text,
    from_group:   '1',
    access_token: config.vk.token,
    v:            VK_V,
  });

  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await axios.post(`https://api.vk.com/method/wall.post`, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      });

      if (res.data?.error) {
        throw new Error(`VK API: ${res.data.error.error_msg}`);
      }

      const postId = res.data?.response?.post_id;
      logger.info(`VK: опубликовано, post_id=${postId}`);
      return String(postId);
    } catch (e) {
      if (attempt < MAX_ATTEMPTS) {
        logger.warn(`VK: попытка ${attempt}/${MAX_ATTEMPTS} не удалась (${e.message}). Повтор через 5с...`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      throw e;
    }
  }
}

module.exports = { sendTelegram, sendVK, sendOK, sendLiveJournal };
