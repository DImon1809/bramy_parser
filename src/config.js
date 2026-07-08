require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

module.exports = {
  tg: {
    botToken: process.env.TG_BOT_TOKEN || '',
    channelId: process.env.TG_CHANNEL_ID || '',
    adminIds: (process.env.TG_ADMIN_ID || '').split(',').map(s => s.trim()).filter(Boolean),
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
