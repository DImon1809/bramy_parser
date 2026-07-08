const axios    = require('axios');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const FormData = require('form-data');
const config   = require('./config');
const logger   = require('./logger');

// ─── Хранилище токенов ────────────────────────────────────────────────────────

// access_token у ОК живёт недолго (часы), refresh_token — 30 суток. Разовая
// ручная авторизация (см. ok-auth.js) даёт первую пару токенов; дальше парсер
// обновляет access_token сам через refresh_token перед каждой публикацией.
const TOKEN_FILE = path.join(__dirname, '../../data/ok-token.json');

function loadTokenState() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function persistTokenState(state) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  const json = JSON.stringify(state, null, 2);
  const tmp = TOKEN_FILE + '.tmp';
  fs.writeFileSync(tmp, json, 'utf8');
  try {
    fs.renameSync(tmp, TOKEN_FILE);
  } catch (_) {
    // OneDrive блокирует rename на Windows — пишем напрямую
    fs.writeFileSync(TOKEN_FILE, json, 'utf8');
    try { fs.unlinkSync(tmp); } catch (__) {}
  }
}

// Небольшой запас, чтобы не словить "токен истёк" из-за задержки самого запроса
const EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000;

async function refreshAccessToken(refreshToken) {
  const res = await axios.post('https://api.ok.ru/oauth/token.do', null, {
    params: {
      refresh_token: refreshToken,
      client_id:     config.ok.applicationId,
      client_secret: config.ok.applicationSecretKey,
      grant_type:    'refresh_token',
    },
    timeout: 15000,
  });

  if (res.data?.error) {
    throw new Error(`ОК: не удалось обновить токен — ${res.data.error_description || res.data.error}`);
  }

  const { access_token, refresh_token, expires_in } = res.data;
  return {
    accessToken:  access_token,
    // refresh_token обычно не меняется, но ОК может вернуть новый — используем его, если пришёл
    refreshToken: refresh_token || refreshToken,
    expiresAt:    new Date(Date.now() + (expires_in ?? 0) * 1000).toISOString(),
  };
}

async function getValidAccessToken() {
  const state = loadTokenState();
  if (!state?.refreshToken) {
    throw new Error('ОК: токен не найден — выполни разовую авторизацию через ok-auth.js');
  }

  const expiresAt = state.expiresAt ? new Date(state.expiresAt).getTime() : 0;
  if (state.accessToken && expiresAt - EXPIRY_SAFETY_MARGIN_MS > Date.now()) {
    return state.accessToken;
  }

  const refreshed = await refreshAccessToken(state.refreshToken);
  persistTokenState(refreshed);
  return refreshed.accessToken;
}

// ─── Подпись запросов ─────────────────────────────────────────────────────────

// Схема ОК (отличается от VK): session_secret_key = MD5(access_token + application_secret_key),
// затем sig = MD5(параметры_без_access_token_отсортированные_по_ключу + session_secret_key)
function signParams(params, accessToken, secretKey) {
  const sessionSecret = crypto.createHash('md5').update(accessToken + secretKey).digest('hex');
  const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('');
  return crypto.createHash('md5').update(sorted + sessionSecret).digest('hex');
}

async function callOkApi(method, params, accessToken) {
  const fullParams = { application_key: config.ok.applicationKey, format: 'json', method, ...params };
  const sig = signParams(fullParams, accessToken, config.ok.applicationSecretKey);
  const body = new URLSearchParams({ ...fullParams, sig, access_token: accessToken });

  const res = await axios.post('https://api.ok.ru/fb.do', body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });

  if (res.data?.error_code) {
    throw new Error(`ОК API ${res.data.error_code}: ${res.data.error_msg}`);
  }
  return res.data;
}

// ─── Загрузка фото ────────────────────────────────────────────────────────────

// NB: формат ответа photosV2.getUploadUrl/токена фото собран по документации
// ОК Photos API и ещё не проверялся живым запросом — если ОК вернёт другую
// форму ответа, здесь будет "ОК: сервис загрузки не вернул токен фото".
async function uploadPhotoOK(imageBuffer, accessToken) {
  const urlData = await callOkApi('photosV2.getUploadUrl', { gid: config.ok.groupId, count: 1 }, accessToken);
  const uploadUrl = urlData?.upload_url;
  if (!uploadUrl) throw new Error('ОК: не удалось получить upload_url для фото');

  const form = new FormData();
  form.append('pic1', imageBuffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });

  const uploadRes = await axios.post(uploadUrl, form, { headers: form.getHeaders(), timeout: 30000 });
  const photoEntry = Object.values(uploadRes.data?.photos || {})[0];
  const token = photoEntry?.token;
  if (!token) throw new Error('ОК: сервис загрузки не вернул токен фото');
  return token;
}

// ─── Публикация ───────────────────────────────────────────────────────────────

async function sendOK(post) {
  if (!config.ok.applicationKey || !config.ok.applicationSecretKey || !config.ok.groupId) {
    logger.warn('ОК не настроен, пропускаем');
    return null;
  }

  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const accessToken = await getValidAccessToken();

      // Attachment типа "link" не используем: ОК сам пытается забрать превью
      // с bramy.ru через свой "веб-граббер" и стабильно не может — сайт,
      // видимо, режет незнакомых ботов. URL включён обычным текстом в
      // formatOK(), чтобы не зависеть от этого механизма.
      const media = [{ type: 'text', text: post.text }];

      if (post.imageData) {
        try {
          const photoId = await uploadPhotoOK(post.imageData, accessToken);
          media.push({ type: 'photo', list: [{ id: photoId }] });
        } catch (e) {
          logger.warn(`ОК: не удалось загрузить фото — ${e.message}. Публикуем без картинки.`);
        }
      }

      // mediatopic.post возвращает голый id темы строкой (не объект {id}),
      // в отличие от большинства других методов ОК API
      const postId = await callOkApi('mediatopic.post', {
        type:       'GROUP_THEME',
        gid:        config.ok.groupId,
        attachment: JSON.stringify({ media }),
      }, accessToken);

      logger.info(`ОК: опубликовано, id=${postId}`);
      return postId ? String(postId) : null;
    } catch (e) {
      if (attempt < MAX_ATTEMPTS) {
        logger.warn(`ОК: попытка ${attempt}/${MAX_ATTEMPTS} не удалась (${e.message}). Повтор через 5с...`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw e;
    }
  }
}

module.exports = { sendOK };
