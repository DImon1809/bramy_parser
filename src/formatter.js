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

function vkHashtags(article) {
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

  const icon    = typeIcon(articleType);
  const descLimit = imageUrl ? 750 : 2000;
  const desc    = withParagraphs(text, descLimit);
  const date    = formatDate(publishedAt);
  const metaParts = [
    section ? `📂 ${section}` : '',
    date    ? `📅 ${date}`    : '',
  ].filter(Boolean);
  const meta = metaParts.join('  ·  ');

  const body = [
    `${icon} <b>${title}</b>`,
    meta ? `\n\n${meta}` : '',
    desc ? `\n\n${desc}` : '',
    `\n\n🔗 <a href="${url}">Читать на bramy.ru →</a>`,
  ].join('');

  if (imageUrl) {
    return {
      type:      'photo',
      imageUrl,
      imageData: imageData || null,
      caption:   truncate(body, MAX_TG_CAPTION),
      parseMode: 'HTML',
    };
  }

  return {
    type:      'text',
    text:      truncate(body, MAX_TG_TEXT),
    parseMode: 'HTML',
  };
}

// ─── ВКонтакте ────────────────────────────────────────────────────────────────

function formatVK(article) {
  const { title, text, url, section, imageUrl, imageData, articleType, publishedAt } = article;

  const icon = typeIcon(articleType);
  const desc = withParagraphs(text, 1500);
  const date = formatDate(publishedAt);
  const tags = vkHashtags(article);

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

module.exports = { formatTelegram, formatVK };
