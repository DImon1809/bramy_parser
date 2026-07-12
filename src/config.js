require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

module.exports = {
  tg: {
    botToken: process.env.TG_BOT_TOKEN || '',
    channelId: process.env.TG_CHANNEL_ID || '',
    adminIds: (process.env.TG_ADMIN_ID || '').split(',').map(s => s.trim()).filter(Boolean),
    // Резервный канал для черновиков Дзена — сам Дзен подключается к нему
    // через кросспостинг из Telegram, парсер только шлёт туда переписанные статьи
    draftChannelId: process.env.TG_DRAFT_CHANNEL_ID || '',
  },
  vk: {
    token:     process.env.VK_TOKEN      || '',
    userToken: process.env.VK_USER_TOKEN || '',
    groupId:   process.env.VK_GROUP_ID   || '',
  },
  ok: {
    applicationId:        process.env.OK_APPLICATION_ID        || '',
    applicationKey:       process.env.OK_APPLICATION_KEY       || '',
    applicationSecretKey: process.env.OK_APPLICATION_SECRET_KEY || '',
    groupId:              process.env.OK_GROUP_ID              || '',
    redirectUri:          process.env.OK_REDIRECT_URI          || '',
    tokenPath:            require('path').join(__dirname, '../../data/ok-token.json'),
  },
  openai: {
    apiKey:              process.env.OPENAI_API_KEY  || '',
    baseURL:             process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model:               process.env.OPENAI_MODEL    || 'gpt-4o-mini',
    // Порог для предупреждения о низком балансе (см. src/aiBalance.js) —
    // работает только когда OPENAI_BASE_URL указывает на proxyapi.ru
    lowBalanceThreshold: parseFloat(process.env.OPENAI_LOW_BALANCE_THRESHOLD || '100'),
    balanceStatePath:    require('path').join(__dirname, '../../data/ai-balance-state.json'),
  },
  scraper: {
    baseUrl: 'https://www.bramy.ru',
    checkIntervalMinutes: parseInt(process.env.CHECK_INTERVAL_MINUTES || '60', 10),
  },
  db: {
    path: require('path').join(__dirname, '../../data/articles.db'),
  },
  log: {
    path: require('path').join(__dirname, '../../logs/parser.log'),
  },
};
