# PlayLo — Telegram multiplayer card game

PlayLo is an independently implemented color-and-number multiplayer card game for Telegram Mini Apps and browsers. It includes a Node.js/Socket.IO server, Telegram bot, room invite links, CPU players, reactions, rematch flow, and automated game-rule tests.

> **Status honesty:** game rules and simulated rounds have been tested, but this has not yet been live-tested end-to-end on Telegram/Railway. Original Matcho backend source was not included in the research archive, so PlayLo is a separate implementation, not a recovered copy of the original server.

## Requirements

- Node.js 20+
- A Telegram bot token from BotFather for Telegram authentication and bot commands
- A public HTTPS URL for production Telegram Mini App use

## Local run

```bash
cp .env.example .env
npm install
npm run check
npm test
npm start
```

Open `http://localhost:3000` for local browser testing. For local browser-only testing, `DEV_ALLOW_GUESTS=true` is allowed only when `NODE_ENV` is not `production`. Do not enable guest mode in production.

Run the Telegram bot in a second process after configuring `.env`:

```bash
npm run bot
```

## Railway deployment

Deploy this folder as a Node.js service. Start command: `npm start`. Set `BOT_TOKEN`, `BOT_USERNAME`, `PUBLIC_URL`, `NODE_ENV=production`, and `DEV_ALLOW_GUESTS=false` in Railway Variables. Run the bot as a separate Railway service from the same repository with start command `npm run bot`, or use a process manager that keeps web and bot processes separate. Set `PUBLIC_URL` to the web service's HTTPS domain.

See [README_HI.md](README_HI.md), [README_TERMUX.md](README_TERMUX.md), and [DATABASE.md](DATABASE.md).

## Database status

**There is currently no persistent database connection.** Room/game state is stored in process memory and is lost on restart. See `DATABASE.md` before production deployment. Adding Railway PostgreSQL as a variable alone does not persist rooms; database integration remains a required next step for durable production rooms.

## Included assets

Collected card atlases, UI graphics, fonts and audio files are in `public/assets/`. They are retained as available asset references; the UI is not yet guaranteed to reproduce the original site's exact layout or use every atlas automatically. Review the original site's terms/rights before redistributing third-party assets publicly.
