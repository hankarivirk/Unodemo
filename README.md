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
