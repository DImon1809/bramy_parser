const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const config = require('./config');
const logger = require('./logger');

const API_BASE = 'https://api.pinterest.com/v5';
const SCOPES   = 'boards:read,pins:read,pins:write';

// ─── Хранилище токенов ────────────────────────────────────────────────────────

// В отличие от ОК, Pinterest сам сообщает срок жизни refresh_token в ответе
// (refresh_token_expires_in) — не приходится оценивать его по документации.
const TOKEN_FILE = config.pinterest.tokenPath;

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

function basicAuthHeader() {
  const raw = `${config.pinterest.clientId}:${config.pinterest.clientSecret}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

async function requestToken(bodyParams) {
  const res = await axios.post(`${API_BASE}/oauth/token`, new URLSearchParams(bodyParams).toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization:  basicAuthHeader(),
    },
    timeout: 15000,
  });
  return res.data;
}

// refresh_token обычно не меняется при обновлении access_token — используем
// новый, если Pinterest всё же его вернул, иначе оставляем прежний. То же
// самое для refreshTokenExpiresAt: если ответ его не содержит, не затираем
// уже известное значение из предыдущего состояния.
function buildTokenState(data, prevState = {}) {
  const now = Date.now();
  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token || prevState.refreshToken || null,
    expiresAt:    new Date(now + (data.expires_in ?? 0) * 1000).toISOString(),
    refreshTokenExpiresAt: data.refresh_token_expires_in
      ? new Date(now + data.refresh_token_expires_in * 1000).toISOString()
      : (prevState.refreshTokenExpiresAt || null),
  };
}

// ─── Первичная авторизация (OAuth code flow) ─────────────────────────────────
// Общий код для разового скрипта pinterest-auth.js и для аналогичного
// сценария прямо в Telegram-боте (см. onPinterestLoginStart/onPinterestCodeText
// в bot.js) — вместо того чтобы дублировать логику в обоих местах.

function buildAuthorizeUrl() {
  const params = new URLSearchParams({
    client_id:     config.pinterest.clientId,
    redirect_uri:  config.pinterest.redirectUri,
    response_type: 'code',
    scope:         SCOPES,
  });
  return `https://www.pinterest.com/oauth/?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  let data;
  try {
    data = await requestToken({
      grant_type:   'authorization_code',
      code,
      redirect_uri: config.pinterest.redirectUri,
    });
  } catch (e) {
    throw new Error(`Pinterest: не удалось обменять code — ${e.response?.data?.message || e.message}`);
  }
  return buildTokenState(data);
}

async function refreshAccessToken(refreshToken, prevState = {}) {
  let data;
  try {
    data = await requestToken({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      scope:         SCOPES,
    });
  } catch (e) {
    throw new Error(`Pinterest: не удалось обновить токен — ${e.response?.data?.message || e.message}`);
  }
  return buildTokenState(data, prevState);
}

async function getValidAccessToken() {
  const state = loadTokenState();
  if (!state?.refreshToken) {
    throw new Error('Pinterest: токен не найден — выполни разовую авторизацию через pinterest-auth.js');
  }

  const expiresAt = state.expiresAt ? new Date(state.expiresAt).getTime() : 0;
  if (state.accessToken && expiresAt - EXPIRY_SAFETY_MARGIN_MS > Date.now()) {
    return state.accessToken;
  }

  const refreshed = await refreshAccessToken(state.refreshToken, state);
  persistTokenState({ ...refreshed, lastWarnedAt: state.lastWarnedAt || null });
  return refreshed.accessToken;
}

// ─── Предупреждение об истечении refresh_token ───────────────────────────────

const WARNING_THRESHOLD_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

function isSameCalendarDay(a, b) {
  return a.toDateString() === b.toDateString();
}

/** Возвращает { daysRemaining, expiresAt } без побочных эффектов на счётчик
 *  предупреждений — для запроса "сколько осталось" по кнопке в боте.
 *  null, если токена нет или Pinterest не присылал refresh_token_expires_in. */
function getRefreshTokenStatus() {
  const state = loadTokenState();
  if (!state?.refreshToken || !state.refreshTokenExpiresAt) return null;

  const daysRemaining = Math.ceil((new Date(state.refreshTokenExpiresAt).getTime() - Date.now()) / DAY_MS);
  return { daysRemaining, expiresAt: state.refreshTokenExpiresAt };
}

/** Возвращает { daysRemaining }, если админа пора предупредить о скором
 *  истечении refresh_token Pinterest (не чаще раза в сутки), иначе null. */
function checkRefreshTokenWarning() {
  const status = getRefreshTokenStatus();
  if (!status || status.daysRemaining > WARNING_THRESHOLD_DAYS) return null;

  const state = loadTokenState();
  const now = new Date();
  if (state.lastWarnedAt && isSameCalendarDay(new Date(state.lastWarnedAt), now)) return null;

  persistTokenState({ ...state, lastWarnedAt: now.toISOString() });
  return { daysRemaining: status.daysRemaining };
}

// ─── Проверка доступа и публикация ────────────────────────────────────────────

// Проверяет, что access_token рабочий и есть доступ к настроенной доске —
// тем же методом API (GET /boards/{id}), что нужен и для настоящей публикации.
// Бросает исключение с понятным текстом, если токен нерабочий или доски нет.
async function verifyPinterestAccess(accessToken) {
  if (!config.pinterest.boardId) {
    throw new Error('PINTEREST_BOARD_ID не задан — нечего проверять');
  }
  try {
    await axios.get(`${API_BASE}/boards/${config.pinterest.boardId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000,
    });
  } catch (e) {
    throw new Error(`Pinterest: доступ к доске не подтверждён — ${e.response?.data?.message || e.message}`);
  }
}

// Картинка передаётся либо готовыми байтами (imageData из Playwright-скрапа,
// в base64), либо прямой ссылкой — так же, как формируется post в formatter.js.
async function createPin(post, accessToken) {
  const mediaSource = post.imageData
    ? { source_type: 'image_base64', content_type: 'image/jpeg', data: post.imageData.toString('base64') }
    : { source_type: 'image_url', url: post.imageUrl };

  const res = await axios.post(`${API_BASE}/pins`, {
    board_id:     config.pinterest.boardId,
    title:        post.title,
    description:  post.description,
    link:         post.link,
    media_source: mediaSource,
  }, {
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });

  return res.data?.id ? String(res.data.id) : null;
}

// post === null означает "у статьи нет картинки" (см. formatPinterest) —
// Pinterest принципиально не публикует пины без изображения, так что это не
// ошибка, а штатный пропуск платформы для конкретной статьи.
async function sendPinterest(post) {
  if (!config.pinterest.clientId || !config.pinterest.clientSecret || !config.pinterest.boardId) {
    logger.warn('Pinterest не настроен, пропускаем');
    return null;
  }
  if (!post) return null;

  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const accessToken = await getValidAccessToken();
      const pinId = await createPin(post, accessToken);
      logger.info(`Pinterest: опубликовано, id=${pinId}`);
      return pinId;
    } catch (e) {
      const detail = e.response?.data?.message || e.message;
      if (attempt < MAX_ATTEMPTS) {
        logger.warn(`Pinterest: попытка ${attempt}/${MAX_ATTEMPTS} не удалась (${detail}). Повтор через 5с...`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw new Error(detail);
    }
  }
}

module.exports = {
  sendPinterest,
  checkRefreshTokenWarning,
  getRefreshTokenStatus,
  verifyPinterestAccess,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
};
