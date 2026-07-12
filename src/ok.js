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
const TOKEN_FILE = config.ok.tokenPath;

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

// ─── Первичная авторизация (OAuth code flow) ─────────────────────────────────
// Общий код для разового скрипта ok-auth.js и для аналогичного сценария
// прямо в Telegram-боте (см. onOkLoginStart/onOkCodeText в bot.js) — вместо
// того чтобы дублировать логику в обоих местах.

function buildAuthorizeUrl() {
  return `https://connect.ok.ru/oauth/authorize?client_id=${config.ok.applicationId}` +
    `&scope=GROUP_CONTENT;PHOTO_CONTENT;LONG_ACCESS_TOKEN&response_type=code` +
    `&redirect_uri=${encodeURIComponent(config.ok.redirectUri)}&layout=w`;
}

async function exchangeCodeForTokens(code) {
  const res = await axios.post('https://api.ok.ru/oauth/token.do', null, {
    params: {
      code,
      client_id:     config.ok.applicationId,
      client_secret: config.ok.applicationSecretKey,
      redirect_uri:  config.ok.redirectUri,
      grant_type:    'authorization_code',
    },
    timeout: 15000,
  });

  if (res.data?.error) {
    throw new Error(`ОК: не удалось обменять code — ${res.data.error_description || res.data.error}`);
  }

  const { access_token, refresh_token, expires_in } = res.data;
  return {
    accessToken:  access_token,
    refreshToken: refresh_token,
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
  // ОК обычно не меняет refresh_token при обновлении access_token, но если всё
  // же вернул новый — это и есть момент настоящей "перевыдачи", от которого
  // нужно заново отсчитывать 30-дневный срок жизни (см. checkRefreshTokenWarning)
  const rotated = refreshed.refreshToken !== state.refreshToken;
  persistTokenState({
    ...refreshed,
    refreshTokenIssuedAt: rotated ? new Date().toISOString() : (state.refreshTokenIssuedAt || new Date().toISOString()),
    lastWarnedAt: rotated ? null : (state.lastWarnedAt || null),
  });
  return refreshed.accessToken;
}

// ─── Предупреждение об истечении refresh_token ───────────────────────────────

// ОК не отдаёт срок жизни refresh_token явно через API (только expires_in
// для access_token) — документация заявляет ~30 суток. Приближаем момент
// выдачи как дату последнего изменения файла токена при первой миграции
// (для уже существующих токенов без этого поля) и обновляем точно при
// настоящей ротации в getValidAccessToken().
const REFRESH_TOKEN_LIFETIME_DAYS = 30;
const WARNING_THRESHOLD_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

function isSameCalendarDay(a, b) {
  return a.toDateString() === b.toDateString();
}

/** Возвращает { daysRemaining, expiresAt } без побочных эффектов на счётчик
 *  предупреждений — для запроса "сколько осталось" по кнопке в боте.
 *  null, если токена вообще нет. */
function getRefreshTokenStatus() {
  const state = loadTokenState();
  if (!state?.refreshToken) return null;

  let issuedAt = state.refreshTokenIssuedAt;
  if (!issuedAt) {
    try {
      issuedAt = fs.statSync(TOKEN_FILE).mtime.toISOString();
    } catch (_) {
      issuedAt = new Date().toISOString();
    }
    persistTokenState({ ...state, refreshTokenIssuedAt: issuedAt });
  }

  const expiresAtMs = new Date(issuedAt).getTime() + REFRESH_TOKEN_LIFETIME_DAYS * DAY_MS;
  const daysRemaining = Math.ceil((expiresAtMs - Date.now()) / DAY_MS);
  return { daysRemaining, expiresAt: new Date(expiresAtMs).toISOString() };
}

/** Возвращает { daysRemaining }, если админа пора предупредить о скором
 *  истечении refresh_token ОК (не чаще раза в сутки), иначе null. */
function checkRefreshTokenWarning() {
  const status = getRefreshTokenStatus();
  if (!status || status.daysRemaining > WARNING_THRESHOLD_DAYS) return null;

  const state = loadTokenState();
  const now = new Date();
  if (state.lastWarnedAt && isSameCalendarDay(new Date(state.lastWarnedAt), now)) return null;

  persistTokenState({ ...state, lastWarnedAt: now.toISOString() });
  return { daysRemaining: status.daysRemaining };
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

// Проверяет, что access_token рабочий и у приложения реально есть доступ к
// публикации в настроенную группу — тем же методом API, что и настоящая
// загрузка фото в uploadPhotoOK() ниже (photosV2.getUploadUrl), но без
// собственно загрузки файла. Бросает исключение с понятным текстом (в т.ч.
// код ошибки ОК из callOkApi), если токен нерабочий или доступа нет.
async function verifyOkAccess(accessToken) {
  if (!config.ok.groupId) {
    throw new Error('OK_GROUP_ID не задан — нечего проверять');
  }
  const urlData = await callOkApi('photosV2.getUploadUrl', { gid: config.ok.groupId, count: 1 }, accessToken);
  if (!urlData?.upload_url) {
    throw new Error('ОК не вернул upload_url — вероятно, нет доступа к группе');
  }
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

module.exports = {
  sendOK,
  checkRefreshTokenWarning,
  getRefreshTokenStatus,
  verifyOkAccess,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
};
