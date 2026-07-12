const fs   = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '../../data/articles.json');

// Структура: { articles: { [url]: { ...fields } } }
let data = { articles: {} };

function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (_) {
    data = { articles: {} };
  }
}

function persist() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const json = JSON.stringify(data, null, 2);
  const tmp  = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, json, 'utf8');
  try {
    fs.renameSync(tmp, DB_FILE);
  } catch (_) {
    // OneDrive блокирует rename на Windows — пишем напрямую
    fs.writeFileSync(DB_FILE, json, 'utf8');
    try { fs.unlinkSync(tmp); } catch (__) {}
  }
}

load();

module.exports = {
  /** Сохраняет статью как новую (будет опубликована). */
  save(article) {
    if (data.articles[article.url]) return false;
    data.articles[article.url] = {
      url:         article.url,
      title:       article.title,
      section:     article.section     || '',
      articleType: article.articleType || 'news',
      publishedAt: article.publishedAt || '',
      text:        article.text        || '',
      imageUrl:    article.imageUrl    || null,
      scrapedAt:   new Date().toISOString(),
      postedTg:    false,
      postedVk:    false,
      postedOk:    false,
      postedZen:   false,
      tgMsgId:     null,
      vkPostId:    null,
      okPostId:    null,
      zenUrl:      null,
    };
    persist();
    return true;
  },

  /** Сохраняет статью как уже виденную (не публиковать). Используется при первом запуске. */
  saveAsSeen(article) {
    if (data.articles[article.url]) return false;
    data.articles[article.url] = {
      url:         article.url,
      title:       article.title,
      section:     article.section     || '',
      articleType: article.articleType || 'news',
      publishedAt: article.publishedAt || '',
      text:        '',
      imageUrl:    null,
      scrapedAt:   new Date().toISOString(),
      postedTg:    true,
      postedVk:    true,
      postedOk:    true,
      postedZen:   true,
      tgMsgId:     null,
      vkPostId:    null,
      okPostId:    null,
      zenUrl:      null,
    };
    persist();
    return true;
  },

  /** Статья не спарсилась второй прогон подряд — не публикуем и больше не пытаемся. */
  markScrapeFailed(article) {
    if (data.articles[article.url]) return false;
    data.articles[article.url] = {
      url:          article.url,
      title:        article.title,
      section:      article.section     || '',
      articleType:  article.articleType || 'news',
      publishedAt:  article.publishedAt || '',
      text:         '',
      imageUrl:     null,
      scrapedAt:    new Date().toISOString(),
      postedTg:     true,
      postedVk:     true,
      postedOk:     true,
      postedZen:    true,
      tgMsgId:      null,
      vkPostId:     null,
      okPostId:     null,
      zenUrl:       null,
      scrapeFailed: true,
    };
    persist();
    return true;
  },

  exists(url) {
    return !!data.articles[url];
  },

  markPosted(url, { tgMsgId = null, vkPostId = null, okPostId = null, zenUrl = null } = {}) {
    const art = data.articles[url];
    if (!art) return;
    if (tgMsgId  != null) { art.postedTg  = true; art.tgMsgId  = tgMsgId;  }
    if (vkPostId != null) { art.postedVk  = true; art.vkPostId = vkPostId; }
    if (okPostId != null) { art.postedOk  = true; art.okPostId = okPostId; }
    if (zenUrl   != null) { art.postedZen = true; art.zenUrl   = zenUrl;   }
    persist();
  },

  /** Возвращает статьи, не опубликованные хотя бы на одну платформу */
  getUnposted() {
    return Object.values(data.articles).filter(a => !a.postedTg || !a.postedVk || !a.postedOk || !a.postedZen);
  },

  /** Статьи, для которых ещё не готов черновик для Дзена — например, рерайт через ИИ
   *  сорвался из-за сбоя сети. Используется, чтобы отложить попытку на следующий
   *  прогон парсера, а не ронять публикацию сразу. */
  getUnpostedZen() {
    return Object.values(data.articles).filter(a => !a.postedZen && !a.scrapeFailed);
  },

  /** Возвращает самую свежую статью по дате публикации на сайте */
  getLatest() {
    const arts = Object.values(data.articles);
    if (arts.length === 0) return null;
    return arts.sort((a, b) => {
      const pa = a.publishedAt || '0000-00-00';
      const pb = b.publishedAt || '0000-00-00';
      if (pb !== pa) return pb > pa ? 1 : -1;
      return new Date(b.scrapedAt) - new Date(a.scrapedAt);
    })[0];
  },

  /** Возвращает все статьи */
  all() {
    return Object.values(data.articles);
  },
};
