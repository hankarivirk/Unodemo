# Android Termux — Quick Setup

This folder contains the source project. The ZIP does not contain `node_modules`; Termux installs dependencies from `package.json` when internet access to the npm registry is available.

## Local browser play (development mode)

```sh
pkg update
pkg install nodejs-lts unzip
unzip PlayLo_Telegram_MiniApp_Bot.zip
cd PlayLoTelegramGame
cp .env.example .env
npm install
npm run check
npm test
npm start
```

Open `http://127.0.0.1:3000` in a browser on the same device. To test a multiplayer room locally, use two separate browser profiles/sessions and join with the room code. Guests are enabled only for local development by default.

## Telegram play

Localhost is not a public Mini App URL. For real Telegram users and friends, deploy this Node project to a host that provides a public HTTPS URL. Set your own BotFather `BOT_TOKEN`, `BOT_USERNAME`, `PUBLIC_URL`, `NODE_ENV=production`, and `DEV_ALLOW_GUESTS=false` in the host's environment. Configure the Mini App URL/domain in BotFather. Start the web server and `npm run bot` as two processes/services. Never share or upload `.env`.

If `npm install` reports a DNS/network error, that is an npm registry connectivity issue; retry from a network where `registry.npmjs.org` resolves. Don't put a real token in screenshots or chat messages.
