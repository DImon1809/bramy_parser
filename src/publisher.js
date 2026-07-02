const axios = require('axios');
const FormData = require('form-data');
const config = require('./config');
const logger = require('./logger');

const VK_V = '5.199';

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(post) {
  if (!config.tg.botToken || !config.tg.channelId) {
    logger.warn('Telegram не настроен, пропускаем');
    return null;
  }

  const base = `https://api.telegram.org/bot${config.tg.botToken}`;

  try {
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
        form.append('chat_id',    config.tg.channelId);
        form.append('caption',    post.caption);
        form.append('parse_mode', post.parseMode);
        form.append('photo', photoBuffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });
        res = await axios.post(`${base}/sendPhoto`, form, { headers: form.getHeaders() });
        withPhoto = true;
      } else {
        // Картинку получить не удалось — отправляем текстом
        res = await axios.post(`${base}/sendMessage`, {
          chat_id:                  config.tg.channelId,
          text:                     post.caption,
          parse_mode:               post.parseMode,
          disable_web_page_preview: false,
        });
      }
    } else {
      res = await axios.post(`${base}/sendMessage`, {
        chat_id:                  config.tg.channelId,
        text:                     post.text,
        parse_mode:               post.parseMode,
        disable_web_page_preview: false,
      });
    }

    const msgId = res.data?.result?.message_id;
    return { msgId: msgId ?? null, withPhoto };
  } catch (e) {
    const detail = e.response?.data?.description || e.message;
    throw new Error(`Telegram: ${detail}`);
  }
}

// ─── ВКонтакте ────────────────────────────────────────────────────────────────

async function uploadPhotoVK(imageBuffer) {
  const userToken = config.vk.userToken;
  if (!userToken) throw new Error('VK_USER_TOKEN не задан');

  // 1. Получаем адрес для загрузки (через пользовательский токен)
  const serverRes = await axios.get(`https://api.vk.com/method/photos.getWallUploadServer`, {
    params: {
      group_id:     config.vk.groupId,
      access_token: userToken,
      v:            VK_V,
    },
  });

  if (serverRes.data?.error) {
    const e = serverRes.data.error;
    throw new Error(`VK API ${e.error_code}: ${e.error_msg}`);
  }

  const uploadUrl = serverRes.data?.response?.upload_url;
  if (!uploadUrl) throw new Error('VK: не удалось получить upload_url');

  // 2. Загружаем буфер
  const form = new FormData();
  form.append('photo', imageBuffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });

  const uploadRes = await axios.post(uploadUrl, form, { headers: form.getHeaders() });
  const { server, photo, hash } = uploadRes.data;

  // 3. Сохраняем фото (через пользовательский токен)
  const saveRes = await axios.get(`https://api.vk.com/method/photos.saveWallPhoto`, {
    params: {
      group_id:     config.vk.groupId,
      server, photo, hash,
      access_token: userToken,
      v:            VK_V,
    },
  });

  const saved = saveRes.data?.response?.[0];
  if (!saved) throw new Error('VK: не удалось сохранить фото');

  return `photo${saved.owner_id}_${saved.id}`;
}

async function sendVK(post) {
  if (!config.vk.token || !config.vk.groupId) {
    logger.warn('VK не настроен, пропускаем');
    return null;
  }

  let attachments;

  if (post.imageData && config.vk.userToken) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        attachments = await uploadPhotoVK(post.imageData);
        break;
      } catch (e) {
        if (attempt < 2) {
          logger.warn(`VK: фото не загрузилось (попытка ${attempt}): ${e.message}. Повтор через 5с...`);
          await new Promise(r => setTimeout(r, 5000));
        } else {
          logger.warn(`VK: не удалось загрузить фото — ${e.message}. Публикуем без картинки.`);
        }
      }
    }
  }

  const body = new URLSearchParams({
    owner_id:     `-${config.vk.groupId}`,
    message:      post.text,
    from_group:   '1',
    access_token: config.vk.token,
    v:            VK_V,
  });
  if (attachments) body.set('attachments', attachments);

  const res = await axios.post(`https://api.vk.com/method/wall.post`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (res.data?.error) {
    throw new Error(`VK API: ${res.data.error.error_msg}`);
  }

  const postId = res.data?.response?.post_id;
  logger.info(`VK: опубликовано, post_id=${postId}`);
  return String(postId);
}

module.exports = { sendTelegram, sendVK };
