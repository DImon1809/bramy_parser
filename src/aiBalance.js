const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const config = require('./config');

const DAY_MS = 24 * 60 * 60 * 1000;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(config.openai.balanceStatePath, 'utf8'));
  } catch (_) {
    return {};
  }
}

function persistState(state) {
  fs.mkdirSync(path.dirname(config.openai.balanceStatePath), { recursive: true });
  fs.writeFileSync(config.openai.balanceStatePath, JSON.stringify(state, null, 2), 'utf8');
}

function isSameCalendarDay(a, b) {
  return a.toDateString() === b.toDateString();
}

// Метод баланса специфичен для ProxyAPI (через который здесь настроен доступ
// к OpenAI) — для голого api.openai.com такого эндпоинта нет. Доступ к нему
// у ключа отключён по умолчанию — включается в личном кабинете proxyapi.ru
// после создания ключа (см. https://proxyapi.ru/docs/proxyapi-balance).
async function getAiBalance() {
  if (!config.openai.apiKey) return null;
  if (!config.openai.baseURL.includes('proxyapi.ru')) return null;

  const res = await axios.get('https://api.proxyapi.ru/proxyapi/balance', {
    headers: { Authorization: `Bearer ${config.openai.apiKey}` },
    timeout: 15000,
  });
  return res.data; // { balance } или { balance, budget: { limit, used } } для ключей с лимитом
}

/** Возвращает { balance }, если баланс ниже порога и сегодня ещё не
 *  предупреждали, иначе null. Ошибки (например, доступ к методу не включён)
 *  не бросаются наружу — не должны ронять прогон парсера. */
async function checkLowBalanceWarning() {
  let data;
  try {
    data = await getAiBalance();
  } catch (_) {
    return null;
  }
  if (!data || typeof data.balance !== 'number') return null;
  if (data.balance > config.openai.lowBalanceThreshold) return null;

  const state = loadState();
  const now = new Date();
  if (state.lastWarnedAt && isSameCalendarDay(new Date(state.lastWarnedAt), now)) return null;

  persistState({ lastWarnedAt: now.toISOString() });
  return { balance: data.balance };
}

module.exports = { getAiBalance, checkLowBalanceWarning };
