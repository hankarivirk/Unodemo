# PlayLo database — important truth

## Current status

This build does **not** yet use a persistent database. Live rooms and their game state are stored in the Node.js process memory (`ROOMS = new Map()` in `src/server.js`). That means:

- Room state is lost when the service restarts, redeploys, or crashes.
- If Railway runs more than one replica, each replica would have its own separate room map; multiplayer rooms would not be shared between them.
- `localStorage` in the browser only stores local convenience values (such as a guest id/name/last room); it is not a server database.
- Telegram stores Telegram accounts/messages, not PlayLo's game rooms.

## Where should production data go?

Use a **Railway PostgreSQL database** attached to the PlayLo Railway project. Railway provides a `DATABASE_URL` connection variable. PostgreSQL is the recommended persistent store for player profiles, room metadata, match history, and settings. For live rooms shared across multiple server replicas, add Redis (or a PostgreSQL-backed room store plus a Socket.IO adapter) before scaling replicas.

Simply adding `DATABASE_URL` as an environment variable does not connect the app to a database. This project must be migrated to use PostgreSQL repositories and persistence before claiming rooms survive restarts. That migration is intentionally marked as not yet implemented rather than pretending the current in-memory rooms are durable.

## Local development

No database is required to run the current prototype. Install dependencies and run `npm start`; room state stays in memory until the process exits.

## Railway variables

- `BOT_TOKEN`: token from BotFather (keep secret)
- `BOT_USERNAME`: bot username without `@`
- `PUBLIC_URL`: public HTTPS URL of the deployed Mini App
- `NODE_ENV=production`
- `DEV_ALLOW_GUESTS=false`
- `DATABASE_URL`: only after PostgreSQL integration is implemented; it is not currently consumed by the server
