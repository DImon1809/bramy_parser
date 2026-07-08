// Разовая авторизация ОК: получить ссылку, открыть её под аккаунтом-админом
// группы, а полученный code передать сюда вторым запуском.
//
//   node ok-auth.js            — печатает ссылку для входа
//   node ok-auth.js <code>     — обменивает code на access/refresh_token
//
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const config = require('./src/config');

const TOKEN_FILE = path.join(__dirname, '../data/ok-token.json');

async function main() {
  const code = process.argv[2];

  if (!code) {
    const authUrl =
      `https://connect.ok.ru/oauth/authorize?client_id=${config.ok.applicationId}` +
      `&scope=GROUP_CONTENT;PHOTO_CONTENT;LONG_ACCESS_TOKEN&response_type=code` +
      `&redirect_uri=${encodeURIComponent(config.ok.redirectUri)}&layout=w`;

    console.log('1) Открой эту ссылку в браузере под аккаунтом, который админ группы:\n');
    console.log(authUrl);
    console.log('\n2) После подтверждения браузер перейдёт на');
    console.log(`   ${config.ok.redirectUri}?code=...`);
    console.log('   (страница не обязана существовать — code просто появится в адресной строке)');
    console.log('\n3) Скопируй значение code (оно живёт 2 минуты!) и запусти:\n');
    console.log('   node ok-auth.js <code>\n');
    return;
  }

  const res = await axios.post('https://api.ok.ru/oauth/token.do', null, {
    params: {
      code,
      client_id:     config.ok.applicationId,
      client_secret: config.ok.applicationSecretKey,
      redirect_uri:  config.ok.redirectUri,
      grant_type:    'authorization_code',
    },
  });

  if (res.data?.error) {
    console.error('Ошибка обмена code на токен:', res.data);
    process.exit(1);
  }

  const { access_token, refresh_token, expires_in } = res.data;
  const state = {
    accessToken:  access_token,
    refreshToken: refresh_token,
    expiresAt:    new Date(Date.now() + (expires_in ?? 0) * 1000).toISOString(),
  };

  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(state, null, 2), 'utf8');

  console.log('Готово! Токены сохранены в', TOKEN_FILE);
  console.log('refresh_token действует 30 суток — дальше парсер обновляет access_token сам.');
}

main().catch((e) => {
  console.error(e.response?.data || e.message);
  process.exit(1);
});
