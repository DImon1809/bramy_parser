const axios  = require('axios');
const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');

// ─── XML-RPC (минимальный клиент под LJ.XMLRPC.*) ────────────────────────────
// Полноценная xmlrpc-библиотека не подключена — LJ использует всего два
// метода (getchallenge, postevent) с плоскими структурами в ответе, поэтому
// проще собрать/разобрать XML вручную, чем тянуть новую зависимость.

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function xmlUnescape(str) {
  return String(str)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function toXmlRpcValue(val) {
  if (typeof val === 'number' && Number.isInteger(val)) {
    return `<value><int>${val}</int></value>`;
  }
  if (val && typeof val === 'object') {
    const members = Object.entries(val)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `<member><name>${xmlEscape(k)}</name>${toXmlRpcValue(v)}</member>`)
      .join('');
    return `<value><struct>${members}</struct></value>`;
  }
  return `<value><string>${xmlEscape(val)}</string></value>`;
}

function buildRequest(method, params) {
  const paramsXml = params.map((p) => `<param>${toXmlRpcValue(p)}</param>`).join('');
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${paramsXml}</params></methodCall>`;
}

// Разбирает только то, что нужно нашим двум методам: плоский struct (без
// вложенных struct/array в интересующих нас полях) или <fault>.
function parseResponse(xml) {
  if (/<fault>/.test(xml)) {
    const code = xml.match(/<name>faultCode<\/name>\s*<value>\s*<int>(-?\d+)<\/int>/)?.[1] ?? '?';
    const msg  = xml.match(/<name>faultString<\/name>\s*<value>\s*<string>([\s\S]*?)<\/string>/)?.[1] ?? 'unknown fault';
    throw new Error(`LiveJournal XML-RPC ошибка ${code}: ${xmlUnescape(msg).trim()}`);
  }

  const result = {};
  const memberRe = /<member>\s*<name>([^<]+)<\/name>\s*<value>\s*(?:<(\w+)>([\s\S]*?)<\/\2>|([^<]*))\s*<\/value>\s*<\/member>/g;
  let m;
  while ((m = memberRe.exec(xml))) {
    const name  = m[1];
    const value = m[2] ? m[3] : m[4];
    result[name] = xmlUnescape((value || '').trim());
  }
  return result;
}

async function callLjApi(method, params) {
  const xml = buildRequest(method, params);
  const res = await axios.post(config.lj.server, xml, {
    headers: { 'Content-Type': 'text/xml' },
    timeout: 20000,
  });
  return parseResponse(res.data);
}

// ─── Аутентификация (challenge/response, без OAuth) ──────────────────────────
// LJ не выдаёт долгоживущих токенов — каждый вызов postevent подписывается
// заново одноразовым challenge, полученным непосредственно перед публикацией.

async function getChallenge() {
  const data = await callLjApi('LJ.XMLRPC.getchallenge', [{}]);
  if (!data.challenge) throw new Error('LiveJournal: getchallenge не вернул challenge');
  return data.challenge;
}

function buildAuthParams(challenge) {
  const passwordMd5 = crypto.createHash('md5').update(config.lj.password).digest('hex');
  const authResponse = crypto.createHash('md5').update(challenge + passwordMd5).digest('hex');
  return {
    username:       config.lj.username,
    auth_method:    'challenge',
    auth_challenge: challenge,
    auth_response:  authResponse,
  };
}

// ─── Публикация ───────────────────────────────────────────────────────────────

async function postEvent(post) {
  const challenge = await getChallenge();

  // year/mon/day/hour/min обязательны для postevent — сервер использует их
  // как время записи и без них не может создать пост (проверено по исходнику
  // ljprotocol.pl: без этих полей sprintf() в eventtime получает undef и
  // запись падает с общей ошибкой "Cannot create post").
  const now = new Date();

  const params = {
    ...buildAuthParams(challenge),
    ver:         1,
    subject:     post.subject,
    event:       post.event,
    year:        now.getFullYear(),
    mon:         now.getMonth() + 1,
    day:         now.getDate(),
    hour:        now.getHours(),
    min:         now.getMinutes(),
    lineendings: 'unix',
    security:    'public',
    props:       { opt_preformatted: 0 },
    // Публикация от сообщества (см. LJ_COMMUNITY) — если не задано, пост
    // уходит в личный журнал аккаунта из LJ_USERNAME
    ...(config.lj.community ? { usejournal: config.lj.community } : {}),
  };

  return callLjApi('LJ.XMLRPC.postevent', [params]);
}

async function sendLiveJournal(post) {
  if (!config.lj.username || !config.lj.password) {
    logger.warn('LiveJournal не настроен, пропускаем');
    return null;
  }

  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await postEvent(post);
      logger.info(`LiveJournal: опубликовано, itemid=${result.itemid}`);
      return result.url || null;
    } catch (e) {
      if (attempt < MAX_ATTEMPTS) {
        logger.warn(`LiveJournal: попытка ${attempt}/${MAX_ATTEMPTS} не удалась (${e.message}). Повтор через 5с...`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw e;
    }
  }
}

module.exports = { sendLiveJournal };
