const logger = require('./logger');
const { rewriteForVK } = require('./rewriter');

const MAX_TG_CAPTION = 1024;
const MAX_TG_TEXT    = 4096;
const MAX_VK_TEXT    = 15000;

const RU_MONTHS = [
  'января','февраля','марта','апреля','мая','июня',
  'июля','августа','сентября','октября','ноября','декабря',
];

function truncate(str, max) {
  if (!str || str.length <= max) return str || '';
  return str.slice(0, max - 3) + '...';
}

function shortDescription(text = '', maxChars = 500) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.8 ? cut.slice(0, lastSpace) : cut) + '...';
}

// Разбивает плоский текст на читаемые абзацы по ~3 предложения
// Обрезает текст под лимит, не разрывая мысль многоточием посередине фразы:
// ищет конец последнего предложения, влезающего в лимит, и режет по нему.
// Если предложений в пределах лимита нет вовсе (редкий случай) — режет по
// последнему пробелу, тоже без "...".
function cutToCompleteSentence(text, maxChars) {
  if (!text || text.length <= maxChars) return text || '';
  const cut = text.slice(0, maxChars);
  const lastEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (lastEnd > maxChars * 0.3) return cut.slice(0, lastEnd + 1).trim();
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

function withParagraphs(text = '', maxChars = 500) {
  const trimmed = shortDescription(text, maxChars);
  // Разбиваем по концу предложения + заглавная буква (рус/лат)
  const sentences = trimmed.split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z])/);
  if (sentences.length <= 3) return trimmed;
  const paras = [];
  for (let i = 0; i < sentences.length; i += 3) {
    paras.push(sentences.slice(i, i + 3).join(' '));
  }
  return paras.join('\n\n');
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr.length === 10 ? dateStr + 'T00:00:00' : dateStr);
  if (isNaN(d.getTime())) return '';
  return `${d.getDate()} ${RU_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function typeIcon(articleType) {
  return articleType === 'promo' ? '🎁' : '📰';
}

function socialHashtags(article) {
  const tags = new Set(['#bramy']);
  const s = ((article.section || '') + ' ' + (article.title || '')).toLowerCase();
  if (/рольставн|роллет/.test(s))  tags.add('#рольставни');
  if (/ворот/.test(s))              tags.add('#ворота');
  if (/шлагбаум/.test(s))          tags.add('#шлагбаумы');
  if (/автоматик/.test(s))          tags.add('#автоматика');
  if (/секционн/.test(s))           tags.add('#секционные_ворота');
  if (/откатн/.test(s))             tags.add('#откатные_ворота');
  if (/распашн/.test(s))            tags.add('#распашные_ворота');
  if (article.articleType === 'promo') tags.add('#акции');
  return [...tags].join(' ');
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

function formatTelegram(article) {
  const { title, text, url, section, imageUrl, imageData, articleType, publishedAt } = article;

  const icon = typeIcon(articleType);
  const date = formatDate(publishedAt);
  const metaParts = [
    section ? `📂 ${section}` : '',
    date    ? `📅 ${date}`    : '',
  ].filter(Boolean);
  const meta = metaParts.join('  ·  ');

  const header = [`${icon} <b>${title}</b>`, meta ? `\n\n${meta}` : ''].join('');
  const link   = `\n\n🔗 <a href="${url}">Читать на bramy.ru →</a>`;

  // Обрезаем только текст описания, подгоняя его под фактическую длину —
  // заголовок и ссылку никогда не режем, иначе можно разрезать HTML-тег
  // пополам и Telegram откажется парсить подпись (было именно так).
  const maxLen = imageUrl ? MAX_TG_CAPTION : MAX_TG_TEXT;
  let desc = withParagraphs(text, imageUrl ? 750 : 2000);
  let body = [header, desc ? `\n\n${desc}` : '', link].join('');

  if (body.length > maxLen) {
    const overflow = body.length - maxLen + 3; // +3 под "..."
    desc = desc.slice(0, Math.max(0, desc.length - overflow));
    desc = desc ? desc + '...' : desc;
    body = [header, desc ? `\n\n${desc}` : '', link].join('');
  }

  if (imageUrl) {
    return {
      type:      'photo',
      imageUrl,
      imageData: imageData || null,
      caption:   body,
      parseMode: 'HTML',
    };
  }

  return {
    type:      'text',
    text:      body,
    parseMode: 'HTML',
  };
}

// ─── ВКонтакте ────────────────────────────────────────────────────────────────

// Текстовый пост без фото. Заголовок и описание переписывает ИИ (см.
// rewriteForVK в rewriter.js) строго на основе присланного текста — без
// придуманных цен/характеристик/сроков/гарантий, таково требование заказчика.
// Если рерайт недоступен (нет ключа/сбой OpenAI), используем исходный текст
// с сайта как есть — это тоже фактически точно, просто без ИИ-обработки.
async function formatVK(article) {
  const { title, text, url, articleType } = article;

  const icon = typeIcon(articleType);
  const tags = socialHashtags(article);

  let headline = title;
  let desc;
  try {
    const rewritten = await rewriteForVK(article);
    headline = rewritten.title;
    desc     = rewritten.text;
  } catch (e) {
    logger.warn(`VK: рерайт через ИИ не удался — публикуем исходный текст (${e.message})`);
    desc = withParagraphs(text, 1500);
  }

  const lines = [
    `${icon} ${headline}`,
    '',
    ...(desc ? [desc, ''] : []),
    `🌐 ${url}`,
    '',
    tags,
  ];

  return {
    text: truncate(lines.join('\n'), MAX_VK_TEXT),
    url:  url || null,
  };
}

// ─── Одноклассники ────────────────────────────────────────────────────────────

function formatOK(article) {
  const { title, text, url, section, imageUrl, imageData, articleType, publishedAt } = article;

  const icon = typeIcon(articleType);
  const desc = withParagraphs(text, 1500);
  const date = formatDate(publishedAt);
  const tags = socialHashtags(article);

  const lines = [
    `${icon} ${title}`,
    '',
    ...(section ? [`📂 ${section}`] : []),
    ...(date    ? [`📅 ${date}`]    : []),
    '',
    ...(desc    ? [desc, '']        : []),
    `🌐 ${url}`,
    '',
    tags,
  ];

  return {
    text:      truncate(lines.join('\n'), MAX_VK_TEXT),
    imageUrl:  imageUrl  || null,
    imageData: imageData || null,
  };
}

// ─── Pinterest ────────────────────────────────────────────────────────────────

const MAX_PINTEREST_TITLE = 100;
const MAX_PINTEREST_DESC  = 500;

// Pinterest принципиально не публикует пины без картинки. Если у статьи её
// нет — возвращаем null, и sendPinterest() в publisher.js штатно пропускает
// платформу для этой статьи (заказчик решил не подставлять логотип вместо
// настоящей фотографии статьи).
function formatPinterest(article) {
  const { title, text, url, imageUrl, imageData, articleType } = article;
  if (!imageUrl && !imageData) return null;

  const icon = typeIcon(articleType);
  const tags = socialHashtags(article);

  return {
    title:       truncate(`${icon} ${title}`, MAX_PINTEREST_TITLE),
    description: truncate(`${shortDescription(text, 400)}\n\n${tags}`, MAX_PINTEREST_DESC),
    link:        url,
    imageUrl:    imageUrl  || null,
    imageData:   imageData || null,
  };
}

// ─── Черновик для Дзена (резервный Telegram-канал) ────────────────────────────

// Сознательно без эмодзи-иконки и строки "📂 раздел · 📅 дата" — эти элементы
// выдают пост телеграм-канала, а тут нужна самостоятельная статья в духе
// Дзена: заголовок, текст и в конце — простая ссылка на первоисточник (без
// эмодзи и призыва в духе "подробнее по ссылке").
//
// Если статья не помещается в лимит подписи — обрезаем не многоточием
// посередине фразы, а по концу последнего целого предложения
// (см. cutToCompleteSentence), чтобы мысль всегда была закончена.
function formatZenDraft(article, rewritten) {
  const { url, imageUrl, imageData } = article;
  const { title, text } = rewritten;

  const maxLen     = imageUrl ? MAX_TG_CAPTION : MAX_TG_TEXT;
  const titleBlock = `<b>${title}</b>\n\n`;
  // Ссылка спрятана за названием домена, а не голым URL — так строка читается
  // как обычная атрибуция источника, а не как техническая ссылка.
  const sourceLine = url ? `\n\nИсточник: <a href="${url}">bramy.ru</a>` : '';
  const budget     = Math.max(0, maxLen - titleBlock.length - sourceLine.length);

  const clean  = (text || '').replace(/\s+/g, ' ').trim();
  const fitted = clean.length > budget ? cutToCompleteSentence(clean, budget) : clean;
  const desc   = withParagraphs(fitted, fitted.length || 1);

  const body = `${titleBlock}${desc}${sourceLine}`;

  if (imageUrl) {
    return {
      type:      'photo',
      imageUrl,
      imageData: imageData || null,
      caption:   body,
      parseMode: 'HTML',
    };
  }

  return {
    type:      'text',
    text:      body,
    parseMode: 'HTML',
  };
}

module.exports = { formatTelegram, formatVK, formatOK, formatPinterest, formatZenDraft };
