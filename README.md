# Matcho! (Beta) / UNO Royale — Telegram Mini App

A complete, server-authoritative multiplayer **UNO Royale / Matcho!** Telegram Mini App featuring the exact dark-plum Halloween visual aesthetic, 60fps physical card-lifting and drag-and-drop gameplay, bundled iPhone/iOS-style glossy SVG emoji reactions, genuine Telegram WebApp SDK header integration (`SettingsButton` & `BackButton`), and a **multi-database persistence architecture** (**Neon / PostgreSQL**, **MongoDB Atlas**, **SQLite3**, **JSON fallback**, and **Redis** caching/coordination).

---

## 1. Quick Start (Local Development — No Production Credentials Required)

You can run, play, and test the complete application locally before configuring a live Telegram bot or cloud database:

```bash
# 1. Copy the example environment file (defaults to NODE_ENV=development and SQLite persistence)
cp .env.example .env

# 2. Run JavaScript syntax verification across all 11 modules
npm run lint

# 3. Run the 24-point automated test suite (Engine, Security, WebSockets, SQLite, Postgres, MongoDB, Redis)
npm test

# 4. Start the local development server (http://localhost:3000)
npm run dev
```

- **Local Multiplayer Testing**: Open `http://localhost:3000/?uid=101&name=Alice` in one browser tab and `http://localhost:3000/?uid=102&name=Bob&startapp=room_<ROOM_ID>` in a second tab to test real-time WebSocket multiplayer synchronization.
- **Developer Inspection Toolbar**: Append `?dev=1` (`http://localhost:3000/?dev=1`) to reveal the dev-only view switcher (`Chat`, `Room`, `Table`, `Win`, `Lose`) and simulated browser header chrome. In production (`NODE_ENV=production`), `ALLOW_DEV_AUTH` is forbidden and developer controls are hidden.

---

## 2. Multi-Database Architecture & Automatic Provider Selection

`server/db.js` implements a deterministic database-selection strategy (`selectDatabaseProvider`) with one authoritative persistent database and an optional, independent **Redis** cache and coordination layer (`server/redis_cache.js`).

### Primary Database Priority (`DATABASE_PROVIDER=auto`)

When `DATABASE_PROVIDER` is `auto` (or unset), the server selects the primary persistent database in this exact priority order:

1. **Neon PostgreSQL / Standard PostgreSQL (`postgres`)** — Selected when `DATABASE_URL` is set (`postgres://...` or `postgresql://...`).
   - Uses `pg.Pool` with automatic TLS (`ssl: { rejectUnauthorized: false }`) for Neon (`*.neon.tech` or `sslmode=require`).
   - Verifies connectivity with `SELECT 1`, initializes tables and indexes from `server/schema.sql`, and wraps every state mutation inside `BEGIN` / `COMMIT` / `ROLLBACK` with `SELECT ... FOR UPDATE` row locking.
2. **MongoDB Atlas / MongoDB (`mongodb`)** — Selected when `MONGODB_URI` is set (`mongodb://...` or `mongodb+srv://...`) and `DATABASE_URL` is unset.
   - Uses the official `mongodb` Node.js driver (`MongoClient`) and database name `MONGODB_DATABASE` (default `uno_royale`).
   - Automatically creates unique and compound indexes on `players` (`{ id: 1 }`, `{ wins: -1 }`), `rooms` (`{ id: 1 }`, `{ status: 1, expires_at: 1 }`), and `matches` (`{ id: 1 }`, `{ room_id: 1, completed_at: -1 }`).
3. **SQLite3 (`sqlite`)** — Selected when `SQLITE_PATH` is set (default `./data/uno_royale.sqlite` in `.env.example`).
   - Uses `server/sqlite_bridge.py` (backed by Python's built-in C `sqlite3` library with `PRAGMA journal_mode=WAL;`, `PRAGMA foreign_keys=ON;`, and `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` ACID transactions) or native Node SQLite drivers (`better-sqlite3` / `node:sqlite`).
   - Ideal for local development and single-instance deployments. Note: a local `.sqlite` file is not shared across multiple horizontal server containers.
4. **Transactional JSON File Store (`json` / `file`)** — Selected only when `DATABASE_PROVIDER=json` or when no higher-priority database is configured and fallback is permitted (`DB_AUTO_FALLBACK=true`).
   - Serializes concurrent writes via an in-process mutex queue, rolls back in-memory snapshots on error, and writes atomically via `.tmp` rename with a `.bak` recovery journal.

### Production Fail-Closed Guarantee

- In production (`NODE_ENV=production`), `DB_AUTO_FALLBACK` defaults to `false`.
- If the configured primary database (`postgres`, `mongodb`, or `sqlite`) is unreachable at startup or fails at runtime, the server **never** silently switches to an empty JSON file.

### Independent Redis Cache & Coordination (`REDIS_URL`)

- Configured via `REDIS_URL=redis://...` or `rediss://...` in `server/redis_cache.js`.
- Speaks the Redis wire protocol (RESP2 over native Node `net`/`tls`) with zero external native dependencies required.
- Provides read-through/write-through room caching (`uno:room:<id>`), player profile caching (`uno:player:<id>`), and short-lived distributed coordination locks (`SET uno:lock:<key> 1 NX PX <ttl>`).
- **Outage Resilience**: Redis is never treated as the sole durable store for match history. If Redis disconnects or times out, `PersistentDatabase` logs a warning and continues reading and writing authoritative state directly in the primary database.

### Migrating Between Database Providers

Use `migrateDatabase(sourceDb, targetDb)` from `server/db.js` to migrate all `players`, active `rooms`, and `matches` between any two providers:

```js
const { PersistentDatabase, migrateDatabase } = require('./server/db');

async function runMigration() {
  const source = new PersistentDatabase({ databaseProvider: 'sqlite', sqlitePath: './data/uno_royale.sqlite' });
  const target = new PersistentDatabase({ databaseProvider: 'postgres', databaseUrl: process.env.DATABASE_URL });
  await source.init();
  await target.init();
  const stats = await migrateDatabase(source, target);
  console.log('Migrated:', stats);
  await source.close();
  await target.close();
}
runMigration();
```

---

## 3. Environment Variables Reference

| Variable | Required in Prod? | Default (Dev) | Description |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | Yes (`production`) | `development` | Runtime environment (`development` or `production`). |
| `PORT` | No | `3000` | HTTP & WebSocket listening port. |
| `BOT_TOKEN` | **Yes** | `""` | Telegram Bot token from `@BotFather` (`<bot_id>:<secret>`). |
| `BOT_USERNAME` | No | `matcho_bot` | Telegram Bot username (without `@`) for invite deep links. |
| `APP_SHORT_NAME` | No | `play` | Mini App short name registered in `@BotFather` (`/newapp`). |
| `TELEGRAM_WEBHOOK_SECRET` | **Yes** | `""` | 16–256 char secret verified against `X-Telegram-Bot-Api-Secret-Token` (alias: `WEBHOOK_SECRET`). |
| `SESSION_SECRET` | **Yes** | Dev fallback | 32+ char HMAC-SHA256 secret for signing session tokens. |
| `PUBLIC_APP_URL` | **Yes** | `http://localhost:3000` | Public HTTPS URL of the Mini App (alias: `WEBAPP_URL`). |
| `ALLOWED_ORIGINS` | **Yes** | `http://localhost:3000` | Comma-separated list of trusted WebSocket/CORS origins. |
| `ALLOW_DEV_AUTH` | Must be `false` | `true` | Allows local testing without signed Telegram `initData` in dev mode. |
| `DATABASE_PROVIDER` | No | `auto` | `auto`, `postgres` (`neon`), `mongodb`, `sqlite`, or `json`. |
| `DATABASE_URL` | If `postgres` | `""` | Neon / PostgreSQL connection URL (`postgresql://...`). |
| `MONGODB_URI` | If `mongodb` | `""` | MongoDB Atlas / MongoDB connection string (`mongodb+srv://...`). |
| `MONGODB_DATABASE` | No | `uno_royale` | Target database name when using MongoDB. |
| `SQLITE_PATH` | If `sqlite` | `./data/uno_royale.sqlite` | File path for the SQLite3 database. |
| `DB_FILE_PATH` | If `json` | `./data/uno_royale_db.json` | File path for the transactional JSON fallback store. |
| `DB_AUTO_FALLBACK` | No (`false` in prod) | `true` (dev) | Whether startup can fall back to JSON in local dev if primary DB fails. |
| `DB_CONNECTION_TIMEOUT_MS` | No | `5000` | Connection timeout in milliseconds for Postgres, MongoDB, SQLite, and Redis. |
| `REDIS_URL` | No | `""` | Optional Redis URL (`redis://` or `rediss://`) for caching & locks. |
| `WAITING_ROOM_TIMEOUT_MS` | No | `300000` (5 min) | Waiting-room expiration timeout in milliseconds before unstarted lobbies expire. |

---

## 4. Telegram Native Controls & `@BotFather` Configuration

The game preserves Telegram's genuine native header (`✕ Close` / `← Back` and `⌄  ⋮`) without rendering duplicate HTML buttons over the top bar:

1. **Controlled in Application Code (`js/game.js`)**:
   - `Telegram.WebApp.SettingsButton.show()` and `onClick(...)` wire the **Settings** item inside Telegram's native `⋮` menu directly to the in-game `SETTINGS` screen.
   - `Telegram.WebApp.BackButton.show()` switches Telegram's top-left native pill from `✕ Close` to `← Back` while `SETTINGS` is open.
   - `Telegram.WebApp.expand()`, `requestFullscreen()`, `setHeaderColor('#191124')`, and `setBackgroundColor('#191124')` blend the native header with the dark-plum game canvas.
2. **Controlled Externally in `@BotFather` (Configure Before Public Launch)**:
   - **Mini App Registration**: Run `/newapp` in `@BotFather`, select your bot, set the Web App URL to `https://<your-domain>/`, and set the short name to match `APP_SHORT_NAME` (`play`).
   - **Inline Mode (`via @matcho_bot`)**: Run `/setinline` in `@BotFather` and enable inline queries so players can share interactive room cards into any Telegram group.
   - **`Terms of Use` Menu Item**: In `@BotFather` → `/mybots` → **Bot Settings** → **Terms of Service**, set the URL to `https://<your-domain>/terms` (served automatically by `server/index.js`).
   - **Webhook Registration**: Once deployed over HTTPS, register your webhook with Telegram using your `TELEGRAM_WEBHOOK_SECRET`:
     ```bash
     curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
       -H "Content-Type: application/json" \
       -d '{"url":"https://<your-domain>/api/bot/webhook","secret_token":"<TELEGRAM_WEBHOOK_SECRET>"}'
     ```

---

## 5. Future Deployment Checklist

1. Provision a TLS/HTTPS reverse proxy (Nginx, Caddy, Cloudflare, Render, Railway, or Fly.io) with WebSocket upgrade pass-through (`Upgrade: websocket`, `Connection: Upgrade`) for `/ws`.
2. Install optional database drivers if using cloud PostgreSQL (`npm install pg`) or MongoDB Atlas (`npm install mongodb`). SQLite3 and Redis work out-of-the-box.
3. Configure production environment variables (`NODE_ENV=production`, `ALLOW_DEV_AUTH=false`, strong `SESSION_SECRET`, `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `PUBLIC_APP_URL`, `ALLOWED_ORIGINS`, and `DATABASE_URL` or `MONGODB_URI`).
4. Verify `/api/health` returns `{"ok":true,"status":"healthy","isProduction":true}`.


## Telegram `@BotFather` & Railway Configuration Guide

### 1. Required `@BotFather` Setup
1. **Register Mini App Short Name (`/newapp`)**:
   - Message `@BotFather` -> `/newapp` -> select your bot.
   - Enter title (`Matcho!`), description, icon (`640x360` PNG/JPG), and Web App URL (`https://<your-railway-domain>`).
   - Set the **short name** to match `APP_SHORT_NAME` in `.env` (default: `play`).
   - This enables canonical Telegram Mini App deep links:
     `https://t.me/<BOT_USERNAME>/<APP_SHORT_NAME>?startapp=<room_token>`
2. **Enable Inline Mode (`/setinline` & `/setinlinefeedback`)**:
   - Send `/setinline` to `@BotFather`, select your bot, and set placeholder text (e.g. `Play Matcho! (4P or 2P)`).
   - Send `/setinlinefeedback` -> select your bot -> set to **Enabled (100%)** so Telegram delivers `chosen_inline_result` updates (`inline_message_id`) for live message score/player updates.
3. **Register Bot Commands (`/setcommands`)**:
   - Send `/setcommands` to `@BotFather` and paste:
     ```text
     start - Launch Matcho! menu (Play with a Friend, Solo vs Utya, Rules)
     play - Create a 4-player Matcho! room
     friend - Create a 2-player friend duel room
     solo - Play on your own against Utya (AI Bot)
     rules - View Matcho! rules and quick guide
     ```

### 2. Required Railway / Production Environment Variables
- `NODE_ENV=production`
- `ALLOW_DEV_AUTH=false`
- `BOT_TOKEN=<bot_id>:<secret>` (from `@BotFather`)
- `BOT_USERNAME=<your_bot_username_without_at>`
- `APP_SHORT_NAME=play` (must match `/newapp` short name in `@BotFather`)
- `SESSION_SECRET=<at_least_32_random_hex_chars>`
- `TELEGRAM_WEBHOOK_SECRET=<16_to_256_random_chars>`
- `PUBLIC_APP_URL=https://<your-app>.up.railway.app`
- `ALLOWED_ORIGINS=https://<your-app>.up.railway.app`
- `DATABASE_PROVIDER=postgres` (or `mongodb` / `sqlite` / `auto`)
- `DATABASE_URL=postgresql://...` (Neon / Railway PostgreSQL connection string)
- **Scaling Note**: Active WebSocket room subscriptions (`roomSubscriptions`) are managed in-memory per Node.js process; deploy with **1 replica** unless a cross-node pub/sub bus is added.

### 3. Platform Note on `inline_message_id` & Single-Instance Memory State
- **Telegram Inline Message Association**: Telegram only sends `chosen_inline_result` (which contains `inline_message_id` immediately upon publishing an inline card) when **Inline Feedback** (`/setinlinefeedback` -> **Enabled / 100%**) is turned on in `@BotFather` and `allowed_updates` includes `"chosen_inline_result"`. As a supported fallback when inline feedback is not yet enabled, `bot/telegram_bot.js` also captures `cb.inline_message_id` on the first button callback (`join_<roomId>` or `spec_<roomId>`) and stores it on the room record.
- **Single-Instance Process Memory**: Active WebSocket room subscriptions (`roomSubscriptions`), per-room waiting expiration timers (`waitingExpiryTimers`), and AI bot turn timers (`botTurnTimers`) are stored in Node.js process memory. Deploy as a single instance (1 replica) unless a shared Redis Pub/Sub broadcast bus is added.

### 4. Inline Publication & Expiration Lifecycle (Platform Limitation & Recovery)
- **Two-Stage Inline Room Lifecycle (`is_published` & `markRoomPublished`)**:
  1. **Unpublished Inline Draft Stage (`inline_query`)**: Typing `@<bot_username>` creates (or reuses) an unpublished 1-player draft room (`is_published: false`, `published_at: null`) and responds to `answerInlineQuery` with `cache_time: 0` and `is_personal: true`. Repeated keystrokes from the same user within the reuse window refresh and reuse this single unpublished draft so unlimited abandoned rooms are never created.
  2. **Published Lobby Stage (`chosen_inline_result` / first `callback_query`)**: When the user selects the inline result and Telegram delivers `chosen_inline_result` with `inline_message_id`, `roomManager.markRoomPublished()` transitions the room to `is_published: true`, sets `published_at`, and anchors a full `WAITING_ROOM_TIMEOUT_MS` (default 5 minutes) countdown from the moment of publication.
- **Telegram Client Popup Timing Limitation & Immediate Server-Side Recovery**:
  - In Telegram's Bot API protocol, `answerInlineQuery` returns the initial `input_message_content` payload to the user's Telegram client. If a user leaves the inline query popup open in their Telegram client for longer than the 5-minute timeout and then taps the cached popup card, Telegram's client posts the initial message to the chat **before** sending `chosen_inline_result` (with `inline_message_id`) to the bot server.
  - Because Telegram does not provide a synchronous pre-publish hook to block a client from sending an already-rendered inline popup item, `TelegramBotController` implements the safest supported recovery:
    1. `answerInlineQuery` sets `cache_time: 0` and verifies the room is active and non-expired before returning results.
    2. When `chosen_inline_result` arrives for a room that already expired before publication (or when `chosen_inline_result` is delayed until after expiration), `markRoomPublished()` **never skips the expired room** — it binds `inline_message_id` to the expired room record and **immediately** invokes `editMessageText` to overwrite the published message with `⏳ Game Expired` and the `🔄 Play Again` (`switch_inline_query_current_chat`) button.
    3. If `/setinlinefeedback` is disabled in `@BotFather` (so `chosen_inline_result` is not delivered by Telegram), the very first button callback (`join_<roomId>` or `spec_<roomId>`) captures `cb.inline_message_id` via `markRoomPublished()`; if the room has expired, it immediately edits the message to `⏳ Game Expired` with `🔄 Play Again` and alerts the user.
