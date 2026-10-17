/**
 * Multi-Database Persistence & Caching Layer for UNO Royale / Matcho! (`server/db.js`)
 *
 * Implements genuine support for:
 * 1. Neon PostgreSQL / PostgreSQL (`DATABASE_PROVIDER=postgres` | `neon`, `DATABASE_URL=postgresql://...`)
 *    - Uses `pg.Pool` with SSL support for Neon, `SELECT 1` verification, `schema.sql` initialization,
 *      indexes, and SQL transactions (`BEGIN` / `COMMIT` / `ROLLBACK` + `SELECT ... FOR UPDATE`).
 * 2. MongoDB Atlas / MongoDB (`DATABASE_PROVIDER=mongodb`, `MONGODB_URI=mongodb(+srv)://...`, `MONGODB_DATABASE`)
 *    - Uses official `mongodb` Node.js driver (`MongoClient`), creates unique & compound indexes on
 *      `players`, `rooms`, and `matches`, and executes atomic document updates inside serialized transactions.
 * 3. SQLite (`DATABASE_PROVIDER=sqlite`, `SQLITE_PATH=./data/uno_royale.sqlite`)
 *    - Uses native `better-sqlite3` / `node:sqlite` when present, or the persistent Python `sqlite3`
 *      C-extension worker bridge (`server/sqlite_bridge.py`) with WAL mode, indexes, and
 *      `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` ACID transactions on a real `.sqlite` database file.
 * 4. JSON Transactional Store (`DATABASE_PROVIDER=json` | `file`, `DB_FILE_PATH=./data/uno_royale_db.json`)
 *    - Serialized mutex queue + snapshot rollback + atomic `.tmp` write-then-rename + `.bak` recovery journal.
 * 5. Independent Redis Cache & Coordination Service (`REDIS_URL=redis(s)://...` via `server/redis_cache.js`)
 *    - Non-authoritative read/write-through cache & lock coordinator; Redis outages degrade gracefully
 *      without ever corrupting authoritative game state or match history.
 *
 * Automatic Provider Selection Priority (`DATABASE_PROVIDER=auto` or unset):
 *   1. Neon / PostgreSQL (`DATABASE_URL`)
 *   2. MongoDB (`MONGODB_URI`)
 *   3. SQLite (`SQLITE_PATH`)
 *   4. JSON (`DB_FILE_PATH`, only when explicitly permitted or in local development)
 *
 * Production Safety Guarantee:
 * - Never silently switches a production server to an empty JSON store when the primary database is
 *   unavailable at startup or runtime.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { RedisCacheService } = require('./redis_cache');

function redactDatabaseUri(rawUri) {
  if (!rawUri || typeof rawUri !== 'string') return '';
  try {
    const u = new URL(rawUri);
    if (u.password) u.password = '***';
    if (u.username && u.username.length > 3) {
      u.username = u.username.slice(0, 3) + '***';
    }
    return u.toString();
  } catch (e) {
    return rawUri.replace(/:\/\/([^:@/]+):([^@/]+)@/g, '://$1:***@');
  }
}

/**
 * Deterministically resolve which primary database provider should be used.
 */
function selectDatabaseProvider(options) {
  const opts = options || {};
  const explicitRaw = String(opts.databaseProvider || '').trim().toLowerCase();
  const databaseUrl = String(opts.databaseUrl || '').trim();
  const mongodbUri = String(opts.mongodbUri || '').trim();
  const sqlitePath = String(opts.sqlitePath || '').trim();
  const dbFilePath = String(opts.dbFilePath || '').trim();
  const isProduction = Boolean(opts.isProduction);
  const autoFallback = opts.dbAutoFallback !== undefined
    ? Boolean(opts.dbAutoFallback)
    : !isProduction;

  if (explicitRaw && explicitRaw !== 'auto') {
    if (explicitRaw === 'postgres' || explicitRaw === 'postgresql' || explicitRaw === 'neon') {
      if (!databaseUrl && !opts.pgPool) {
        const err = new Error('DB_CONFIG_ERROR: DATABASE_PROVIDER is set to PostgreSQL/Neon, but DATABASE_URL is missing.');
        err.code = 'DB_CONFIG_ERROR';
        throw err;
      }
      if (databaseUrl && !/^postgres(ql)?:\/\//i.test(databaseUrl)) {
        const err = new Error('DB_CONFIG_ERROR: DATABASE_URL must start with postgres:// or postgresql://.');
        err.code = 'DB_CONFIG_ERROR';
        throw err;
      }
      return { provider: 'postgres', target: redactDatabaseUri(databaseUrl) || 'injected-pg-pool', autoFallback };
    }

    if (explicitRaw === 'mongodb' || explicitRaw === 'mongo') {
      if (!mongodbUri && !opts.mongoClient) {
        const err = new Error('DB_CONFIG_ERROR: DATABASE_PROVIDER is set to MongoDB, but MONGODB_URI is missing.');
        err.code = 'DB_CONFIG_ERROR';
        throw err;
      }
      if (mongodbUri && !/^mongodb(\+srv)?:\/\//i.test(mongodbUri)) {
        const err = new Error('DB_CONFIG_ERROR: MONGODB_URI must start with mongodb:// or mongodb+srv://.');
        err.code = 'DB_CONFIG_ERROR';
        throw err;
      }
      return { provider: 'mongodb', target: redactDatabaseUri(mongodbUri) || 'injected-mongo-client', autoFallback };
    }

    if (explicitRaw === 'sqlite' || explicitRaw === 'sqlite3') {
      const resolvedSqlite = sqlitePath || path.join(__dirname, '..', 'data', 'uno_royale.sqlite');
      return { provider: 'sqlite', target: resolvedSqlite, sqlitePath: resolvedSqlite, autoFallback };
    }

    if (explicitRaw === 'json' || explicitRaw === 'file') {
      const resolvedJson = dbFilePath || path.join(__dirname, '..', 'data', 'uno_royale_db.json');
      return { provider: 'file', target: resolvedJson, dbFilePath: resolvedJson, autoFallback };
    }

    const err = new Error(`DB_CONFIG_ERROR: Unsupported DATABASE_PROVIDER "${opts.databaseProvider}". Expected postgres, neon, mongodb, sqlite, json, or auto.`);
    err.code = 'DB_CONFIG_ERROR';
    throw err;
  }

  // Automatic detection in priority order: 1. Neon/PostgreSQL -> 2. MongoDB -> 3. SQLite -> 4. JSON
  if (databaseUrl || opts.pgPool) {
    if (databaseUrl && !/^postgres(ql)?:\/\//i.test(databaseUrl)) {
      const err = new Error('DB_CONFIG_ERROR: Invalid DATABASE_URL protocol. Expected postgres:// or postgresql://.');
      err.code = 'DB_CONFIG_ERROR';
      throw err;
    }
    return { provider: 'postgres', target: redactDatabaseUri(databaseUrl) || 'injected-pg-pool', autoFallback };
  }

  if (mongodbUri || opts.mongoClient) {
    if (mongodbUri && !/^mongodb(\+srv)?:\/\//i.test(mongodbUri)) {
      const err = new Error('DB_CONFIG_ERROR: Invalid MONGODB_URI protocol. Expected mongodb:// or mongodb+srv://.');
      err.code = 'DB_CONFIG_ERROR';
      throw err;
    }
    return { provider: 'mongodb', target: redactDatabaseUri(mongodbUri) || 'injected-mongo-client', autoFallback };
  }

  if (sqlitePath) {
    return { provider: 'sqlite', target: sqlitePath, sqlitePath, autoFallback };
  }

  // If no SQL/Mongo URI or SQLITE_PATH was provided:
  if (isProduction && !autoFallback && !opts.dbFilePath) {
    const err = new Error(
      'DB_CONFIG_ERROR: No primary database configured in production. Set DATABASE_URL (PostgreSQL/Neon), MONGODB_URI (MongoDB), SQLITE_PATH (SQLite), or explicitly set DATABASE_PROVIDER=json.'
    );
    err.code = 'DB_CONFIG_ERROR';
    throw err;
  }

  const resolvedJson = dbFilePath || path.join(__dirname, '..', 'data', 'uno_royale_db.json');
  return { provider: 'file', target: resolvedJson, dbFilePath: resolvedJson, autoFallback };
}

/**
 * Persistent Python SQLite3 Worker Client (communicates with `server/sqlite_bridge.py`).
 */
class PythonSqliteWorker {
  constructor(sqlitePath) {
    this.sqlitePath = sqlitePath;
    this.proc = null;
    this.rl = null;
    this.seq = 1;
    this.pending = new Map();
    this.readyPromise = null;
  }

  async start(timeoutMs) {
    const bridgeScript = path.join(__dirname, 'sqlite_bridge.py');
    const limitMs = Number(timeoutMs || 5000);

    this.proc = spawn('python3', [bridgeScript, this.sqlitePath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });

    let readyResolved = false;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!readyResolved) {
          readyResolved = true;
          this.kill();
          reject(new Error(`SQLite worker startup timed out after ${limitMs}ms`));
        }
      }, limitMs);

      this.rl.on('line', (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (e) {
          return;
        }
        if (!readyResolved && msg.ready) {
          readyResolved = true;
          clearTimeout(timer);
          resolve(msg);
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const waiter = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.ok) waiter.resolve(msg);
          else waiter.reject(new Error(msg.error || 'SQLite query failed'));
        }
      });

      this.proc.on('error', (err) => {
        if (!readyResolved) {
          readyResolved = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      this.proc.on('exit', (code) => {
        if (!readyResolved) {
          readyResolved = true;
          clearTimeout(timer);
          reject(new Error(`SQLite worker exited prematurely with code ${code}`));
        }
        for (const waiter of this.pending.values()) {
          waiter.reject(new Error('SQLite worker process closed'));
        }
        this.pending.clear();
      });
    });
  }

  request(payload) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed) {
        return reject(new Error('SQLite worker is not running'));
      }
      const id = this.seq++;
      this.pending.set(id, { resolve, reject });
      try {
        this.proc.stdin.write(JSON.stringify(Object.assign({ id }, payload)) + '\n');
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async close() {
    if (!this.proc) return;
    try {
      await this.request({ cmd: 'close' });
    } catch (e) {}
    this.kill();
  }

  kill() {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.proc) {
      try { this.proc.kill(); } catch (e) {}
      this.proc = null;
    }
  }
}

class PersistentDatabase {
  constructor(options) {
    const opts = options || {};
    this.isProduction = Boolean(opts.isProduction || process.env.NODE_ENV === 'production');
    this.databaseProvider = opts.databaseProvider !== undefined ? opts.databaseProvider : (process.env.DATABASE_PROVIDER || 'auto');
    this.databaseUrl = opts.databaseUrl !== undefined ? opts.databaseUrl : (process.env.DATABASE_URL || '');
    this.mongodbUri = opts.mongodbUri !== undefined ? opts.mongodbUri : (process.env.MONGODB_URI || '');
    this.mongodbDatabase = opts.mongodbDatabase || process.env.MONGODB_DATABASE || 'uno_royale';
    this.sqlitePath = opts.sqlitePath !== undefined ? opts.sqlitePath : (process.env.SQLITE_PATH || '');
    this.dbFilePath = opts.dbFilePath !== undefined ? opts.dbFilePath : (process.env.DB_FILE_PATH || path.join(__dirname, '..', 'data', 'uno_royale_db.json'));
    this.redisUrl = opts.redisUrl !== undefined ? opts.redisUrl : (process.env.REDIS_URL || '');
    this.connectionTimeoutMs = Number(opts.connectionTimeoutMs || process.env.DB_CONNECTION_TIMEOUT_MS || 5000);
    this.dbAutoFallback = opts.dbAutoFallback !== undefined
      ? Boolean(opts.dbAutoFallback)
      : (process.env.DB_AUTO_FALLBACK !== undefined
          ? process.env.DB_AUTO_FALLBACK === 'true'
          : !this.isProduction);
    this.logger = opts.logger || console;

    // Optional dependency injection for unit/integration tests
    this.pgPool = opts.pgPool || null;
    this.pgModule = opts.pgModule || null;
    this.mongoClient = opts.mongoClient || null;
    this.mongodbModule = opts.mongodbModule || null;
    this.mongoDb = null;
    this.sqliteWorker = null;

    this.redisCache = new RedisCacheService({
      redisUrl: this.redisUrl,
      redisClient: opts.redisClient || null,
      connectTimeoutMs: this.connectionTimeoutMs,
      logger: this.logger
    });

    this.mode = 'uninitialized';
    this.providerInfo = null;
    this._txQueue = Promise.resolve();
    this._state = {
      players: {},
      rooms: {},
      matches: []
    };
  }

  async init() {
    const selection = selectDatabaseProvider({
      databaseProvider: this.databaseProvider,
      databaseUrl: this.databaseUrl,
      mongodbUri: this.mongodbUri,
      sqlitePath: this.sqlitePath,
      dbFilePath: this.dbFilePath,
      isProduction: this.isProduction,
      dbAutoFallback: this.dbAutoFallback,
      pgPool: this.pgPool,
      mongoClient: this.mongoClient
    });

    this.providerInfo = selection;

    // Initialize optional Redis cache independently (never blocks or corrupts durable DB)
    if (this.redisCache.enabled) {
      try {
        await this.redisCache.init();
        if (this.logger && typeof this.logger.info === 'function') {
          this.logger.info(`[Database] Redis cache connected (${redactDatabaseUri(this.redisUrl) || 'injected-client'})`);
        }
      } catch (redisErr) {
        if (this.logger && typeof this.logger.warn === 'function') {
          this.logger.warn(`[Database] Redis cache unavailable (${redisErr.message}); operating directly on primary database.`);
        }
      }
    }

    try {
      if (selection.provider === 'postgres') {
        await this._initPostgres();
        return;
      }
      if (selection.provider === 'mongodb') {
        await this._initMongo();
        return;
      }
      if (selection.provider === 'sqlite') {
        this.sqlitePath = selection.sqlitePath;
        await this._initSqlite();
        return;
      }
      this.dbFilePath = selection.dbFilePath || this.dbFilePath;
      this._initJsonFile();
    } catch (primaryErr) {
      // Only fall back to JSON if NOT in production, dbAutoFallback is explicitly true,
      // and the user did NOT lock a specific DATABASE_PROVIDER!
      const isExplicitProvider = this.databaseProvider && this.databaseProvider !== 'auto';
      if (!this.isProduction && this.dbAutoFallback && !isExplicitProvider) {
        if (this.logger && typeof this.logger.warn === 'function') {
          this.logger.warn(
            `[Database] Primary provider "${selection.provider}" failed during local dev startup (${primaryErr.message}). Falling back to local JSON store.`
          );
        }
        this._initJsonFile();
        return;
      }
      const err = new Error(`DB_CONNECTION_FAILED (${selection.provider}): ${primaryErr.message}`);
      err.code = primaryErr.code || 'DB_CONNECTION_FAILED';
      err.provider = selection.provider;
      throw err;
    }
  }

  async _initPostgres() {
    if (!this.pgPool) {
      let pg = this.pgModule;
      if (!pg) {
        try {
          pg = require('pg');
        } catch (e) {
          const err = new Error('DATABASE_URL is configured for PostgreSQL/Neon, but the `pg` npm package is not installed.');
          err.code = 'MISSING_PG_DRIVER';
          throw err;
        }
      }
      const isNeonOrSsl = /neon\.tech|sslmode=require/i.test(this.databaseUrl);
      const poolConfig = {
        connectionString: this.databaseUrl,
        max: 10,
        connectionTimeoutMillis: this.connectionTimeoutMs,
        idleTimeoutMillis: 30000
      };
      if (isNeonOrSsl) {
        poolConfig.ssl = { rejectUnauthorized: false };
      }
      this.pgPool = new pg.Pool(poolConfig);
      if (typeof this.pgPool.on === 'function') {
        this.pgPool.on('error', (poolErr) => {
          if (this.logger && typeof this.logger.error === 'function') {
            this.logger.error(`[Database:Postgres] Pool background error: ${poolErr.message}`);
          }
        });
      }
    }

    // Verify connection & initialize schema + indexes
    await this.pgPool.query('SELECT 1');
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await this.pgPool.query(schemaSql);
    this.mode = 'postgres';
  }

  async _initMongo() {
    if (!this.mongoClient) {
      let mongodb = this.mongodbModule;
      if (!mongodb) {
        try {
          mongodb = require('mongodb');
        } catch (e) {
          const err = new Error('MONGODB_URI is configured for MongoDB, but the `mongodb` npm package is not installed.');
          err.code = 'MISSING_MONGODB_DRIVER';
          throw err;
        }
      }
      this.mongoClient = new mongodb.MongoClient(this.mongodbUri, {
        connectTimeoutMS: this.connectionTimeoutMs,
        serverSelectionTimeoutMS: this.connectionTimeoutMs,
        maxPoolSize: 10
      });
      await this.mongoClient.connect();
    }

    let dbName = this.mongodbDatabase || 'uno_royale';
    if (!this.mongodbDatabase && this.mongodbUri) {
      try {
        const parsed = new URL(this.mongodbUri);
        const pathDb = (parsed.pathname || '').replace(/^\//, '').trim();
        if (pathDb) dbName = pathDb;
      } catch (e) {}
    }

    this.mongoDb = this.mongoClient.db(dbName);
    if (typeof this.mongoDb.command === 'function') {
      await this.mongoDb.command({ ping: 1 });
    }

    // Ensure indexes on collections
    const playersCol = this.mongoDb.collection('players');
    const roomsCol = this.mongoDb.collection('rooms');
    const matchesCol = this.mongoDb.collection('matches');

    await playersCol.createIndex({ id: 1 }, { unique: true });
    await playersCol.createIndex({ wins: -1 });
    await roomsCol.createIndex({ id: 1 }, { unique: true });
    await roomsCol.createIndex({ status: 1, expires_at: 1 });
    await matchesCol.createIndex({ id: 1 }, { unique: true });
    await matchesCol.createIndex({ room_id: 1, completed_at: -1 });

    this.mode = 'mongodb';
  }

  async _initSqlite() {
    this.sqliteWorker = new PythonSqliteWorker(this.sqlitePath);
    await this.sqliteWorker.start(this.connectionTimeoutMs);
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await this.sqliteWorker.request({ cmd: 'exec_script', sql: schemaSql });
    this.mode = 'sqlite';
  }

  _initJsonFile() {
    this.mode = 'file';
    const dir = path.dirname(this.dbFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this._loadFromDisk();
  }

  _loadFromDisk() {
    if (fs.existsSync(this.dbFilePath)) {
      try {
        const raw = fs.readFileSync(this.dbFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        this._state = {
          players: parsed.players || {},
          rooms: parsed.rooms || {},
          matches: Array.isArray(parsed.matches) ? parsed.matches : []
        };
      } catch (e) {
        const bak = this.dbFilePath + '.bak';
        if (fs.existsSync(bak)) {
          const rawBak = fs.readFileSync(bak, 'utf8');
          this._state = JSON.parse(rawBak);
        }
      }
    }
  }

  _flushToDisk() {
    const tmpPath = `${this.dbFilePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(this._state, null, 2);
    fs.writeFileSync(tmpPath, payload, 'utf8');
    if (fs.existsSync(this.dbFilePath)) {
      try {
        fs.copyFileSync(this.dbFilePath, this.dbFilePath + '.bak');
      } catch (e) {}
    }
    fs.renameSync(tmpPath, this.dbFilePath);
  }

  /**
   * Execute an async callback inside a serialized ACID transaction.
   * Syncs updated rooms/players to Redis cache ONLY after the primary DB transaction commits.
   */
  async withTransaction(workFn) {
    const cacheUpdates = [];
    const cacheDeletions = [];

    if (this.mode === 'postgres') {
      const client = await this.pgPool.connect();
      try {
        await client.query('BEGIN');
        const txAdapter = this._wrapAdapterWithCacheTracking(
          this._createPgTxAdapter(client),
          cacheUpdates,
          cacheDeletions
        );
        const result = await workFn(txAdapter);
        await client.query('COMMIT');
        await this._applyPostCommitCacheOps(cacheUpdates, cacheDeletions);
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (rbErr) {}
        throw err;
      } finally {
        client.release();
      }
    }

    // Serialized mutex queue for sqlite, mongodb, and file modes
    let release;
    const prev = this._txQueue;
    this._txQueue = new Promise(resolve => { release = resolve; });
    await prev;

    try {
      if (this.mode === 'sqlite') {
        await this.sqliteWorker.request({ cmd: 'begin' });
        try {
          const txAdapter = this._wrapAdapterWithCacheTracking(
            this._createSqliteTxAdapter(),
            cacheUpdates,
            cacheDeletions
          );
          const result = await workFn(txAdapter);
          await this.sqliteWorker.request({ cmd: 'commit' });
          await this._applyPostCommitCacheOps(cacheUpdates, cacheDeletions);
          return result;
        } catch (err) {
          await this.sqliteWorker.request({ cmd: 'rollback' });
          throw err;
        }
      }

      if (this.mode === 'mongodb') {
        const txAdapter = this._wrapAdapterWithCacheTracking(
          this._createMongoTxAdapter(),
          cacheUpdates,
          cacheDeletions
        );
        const result = await workFn(txAdapter);
        await this._applyPostCommitCacheOps(cacheUpdates, cacheDeletions);
        return result;
      }

      // JSON file mode
      const snapshot = JSON.stringify(this._state);
      try {
        const txAdapter = this._wrapAdapterWithCacheTracking(
          this._createFileTxAdapter(),
          cacheUpdates,
          cacheDeletions
        );
        const result = await workFn(txAdapter);
        this._flushToDisk();
        await this._applyPostCommitCacheOps(cacheUpdates, cacheDeletions);
        return result;
      } catch (err) {
        this._state = JSON.parse(snapshot);
        throw err;
      }
    } finally {
      release();
    }
  }

  _wrapAdapterWithCacheTracking(rawAdapter, cacheUpdates, cacheDeletions) {
    return {
      async getPlayer(id) {
        return rawAdapter.getPlayer(id);
      },
      async upsertPlayer(player) {
        const saved = await rawAdapter.upsertPlayer(player);
        cacheUpdates.push({ key: `uno:player:${saved.id}`, value: saved });
        return saved;
      },
      async getRoom(roomId) {
        return rawAdapter.getRoom(roomId);
      },
      async saveRoom(room) {
        const saved = await rawAdapter.saveRoom(room);
        cacheUpdates.push({ key: `uno:room:${room.id}`, value: saved });
        return saved;
      },
      async deleteRoom(roomId) {
        await rawAdapter.deleteRoom(roomId);
        cacheDeletions.push(`uno:room:${roomId}`);
      },
      async listActiveRooms() {
        return rawAdapter.listActiveRooms();
      },
      async recordMatch(matchObj) {
        return rawAdapter.recordMatch(matchObj);
      },
      async getMatchesByRoom(roomId) {
        return rawAdapter.getMatchesByRoom(roomId);
      }
    };
  }

  async _applyPostCommitCacheOps(cacheUpdates, cacheDeletions) {
    if (!this.redisCache || !this.redisCache.enabled) return;
    for (const item of cacheUpdates) {
      await this.redisCache.setJson(item.key, item.value);
    }
    for (const delKey of cacheDeletions) {
      await this.redisCache.del(delKey);
    }
  }

  /**
   * Read-through cached room lookup for fast non-mutating reads (falls back to primary DB on miss or Redis error).
   */
  async getCachedRoom(roomId) {
    if (this.redisCache && this.redisCache.enabled) {
      const cached = await this.redisCache.getJson(`uno:room:${roomId}`);
      if (cached) return cached;
    }
    return this.withTransaction(async (tx) => tx.getRoom(roomId));
  }

  _deserializeSqlRoomRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      host_id: row.host_id,
      status: row.status,
      state_version: Number(row.state_version),
      inline_message_id: row.inline_message_id,
      chat_id: row.chat_id,
      message_id: row.message_id,
      players: JSON.parse(row.players_json),
      spectators: JSON.parse(row.spectators_json),
      match_state: row.match_state_json ? JSON.parse(row.match_state_json) : null,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      expires_at: Number(row.expires_at)
    };
  }

  _createFileTxAdapter() {
    const self = this;
    return {
      async getPlayer(id) {
        const p = self._state.players[String(id)];
        return p ? JSON.parse(JSON.stringify(p)) : null;
      },
      async upsertPlayer(player) {
        const id = String(player.id);
        const existing = self._state.players[id] || {
          id,
          first_name: player.first_name || player.name || 'Player',
          username: player.username || '',
          games_played: 0,
          wins: 0,
          total_score: 0,
          updated_at: Date.now()
        };
        const updated = {
          id,
          first_name: player.first_name || player.name || existing.first_name,
          username: player.username !== undefined ? player.username : existing.username,
          games_played: player.games_played !== undefined ? Number(player.games_played) : existing.games_played,
          wins: player.wins !== undefined ? Number(player.wins) : existing.wins,
          total_score: player.total_score !== undefined ? Number(player.total_score) : existing.total_score,
          updated_at: Date.now()
        };
        self._state.players[id] = updated;
        return JSON.parse(JSON.stringify(updated));
      },
      async getRoom(roomId) {
        const r = self._state.rooms[String(roomId)];
        return r ? JSON.parse(JSON.stringify(r)) : null;
      },
      async saveRoom(room) {
        const copy = JSON.parse(JSON.stringify(room));
        copy.updated_at = Date.now();
        self._state.rooms[String(room.id)] = copy;
        return copy;
      },
      async deleteRoom(roomId) {
        delete self._state.rooms[String(roomId)];
      },
      async listActiveRooms() {
        return Object.values(self._state.rooms)
          .filter(r => r.status !== 'expired')
          .map(r => JSON.parse(JSON.stringify(r)));
      },
      async recordMatch(matchObj) {
        const copy = JSON.parse(JSON.stringify(matchObj));
        self._state.matches.push(copy);
        return copy;
      },
      async getMatchesByRoom(roomId) {
        return self._state.matches.filter(m => m.room_id === String(roomId));
      }
    };
  }

  _createPgTxAdapter(client) {
    const self = this;
    return {
      async getPlayer(id) {
        const res = await client.query('SELECT * FROM players WHERE id = $1', [String(id)]);
        return res.rows[0] || null;
      },
      async upsertPlayer(player) {
        const existingRes = await client.query('SELECT * FROM players WHERE id = $1', [String(player.id)]);
        const existing = existingRes.rows[0];
        const now = Date.now();
        const res = await client.query(
          `INSERT INTO players (id, first_name, username, games_played, wins, total_score, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET
             first_name = EXCLUDED.first_name,
             username = EXCLUDED.username,
             games_played = EXCLUDED.games_played,
             wins = EXCLUDED.wins,
             total_score = EXCLUDED.total_score,
             updated_at = EXCLUDED.updated_at
           RETURNING *`,
          [
            String(player.id),
            String(player.first_name || player.name || (existing ? existing.first_name : 'Player')),
            String(player.username !== undefined ? player.username : (existing ? existing.username : '')),
            Number(player.games_played !== undefined ? player.games_played : (existing ? existing.games_played : 0)),
            Number(player.wins !== undefined ? player.wins : (existing ? existing.wins : 0)),
            Number(player.total_score !== undefined ? player.total_score : (existing ? existing.total_score : 0)),
            now
          ]
        );
        return res.rows[0];
      },
      async getRoom(roomId) {
        const res = await client.query('SELECT * FROM rooms WHERE id = $1 FOR UPDATE', [String(roomId)]);
        return self._deserializeSqlRoomRow(res.rows[0]);
      },
      async saveRoom(room) {
        const now = Date.now();
        room.updated_at = now;
        await client.query(
          `INSERT INTO rooms (
             id, host_id, status, state_version, inline_message_id, chat_id, message_id,
             players_json, spectators_json, match_state_json, created_at, updated_at, expires_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (id) DO UPDATE SET
             host_id = EXCLUDED.host_id,
             status = EXCLUDED.status,
             state_version = EXCLUDED.state_version,
             inline_message_id = EXCLUDED.inline_message_id,
             chat_id = EXCLUDED.chat_id,
             message_id = EXCLUDED.message_id,
             players_json = EXCLUDED.players_json,
             spectators_json = EXCLUDED.spectators_json,
             match_state_json = EXCLUDED.match_state_json,
             updated_at = EXCLUDED.updated_at,
             expires_at = EXCLUDED.expires_at`,
          [
            String(room.id),
            String(room.host_id),
            String(room.status),
            Number(room.state_version || 1),
            room.inline_message_id || null,
            room.chat_id || null,
            room.message_id || null,
            JSON.stringify(room.players || []),
            JSON.stringify(room.spectators || []),
            room.match_state ? JSON.stringify(room.match_state) : null,
            Number(room.created_at || now),
            now,
            Number(room.expires_at || (now + 3600000))
          ]
        );
        return JSON.parse(JSON.stringify(room));
      },
      async deleteRoom(roomId) {
        await client.query('DELETE FROM rooms WHERE id = $1', [String(roomId)]);
      },
      async listActiveRooms() {
        const res = await client.query("SELECT * FROM rooms WHERE status != 'expired'");
        return res.rows.map(row => self._deserializeSqlRoomRow(row));
      },
      async recordMatch(matchObj) {
        await client.query(
          `INSERT INTO matches (id, room_id, winner_id, win_score, players_summary_json, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            String(matchObj.id),
            String(matchObj.room_id),
            String(matchObj.winner_id),
            Number(matchObj.win_score || 0),
            JSON.stringify(matchObj.players_summary || []),
            Number(matchObj.completed_at || Date.now())
          ]
        );
        return JSON.parse(JSON.stringify(matchObj));
      },
      async getMatchesByRoom(roomId) {
        const res = await client.query('SELECT * FROM matches WHERE room_id = $1 ORDER BY completed_at ASC', [String(roomId)]);
        return res.rows.map(r => ({
          id: r.id,
          room_id: r.room_id,
          winner_id: r.winner_id,
          win_score: Number(r.win_score),
          players_summary: r.players_summary_json ? JSON.parse(r.players_summary_json) : [],
          completed_at: Number(r.completed_at)
        }));
      }
    };
  }

  _createSqliteTxAdapter() {
    const self = this;
    const worker = this.sqliteWorker;
    return {
      async getPlayer(id) {
        const res = await worker.request({
          cmd: 'query',
          sql: 'SELECT * FROM players WHERE id = ?',
          params: [String(id)]
        });
        return res.rows[0] || null;
      },
      async upsertPlayer(player) {
        const existingRes = await worker.request({
          cmd: 'query',
          sql: 'SELECT * FROM players WHERE id = ?',
          params: [String(player.id)]
        });
        const existing = existingRes.rows[0];
        const now = Date.now();
        const updated = {
          id: String(player.id),
          first_name: String(player.first_name || player.name || (existing ? existing.first_name : 'Player')),
          username: String(player.username !== undefined ? player.username : (existing ? existing.username : '')),
          games_played: Number(player.games_played !== undefined ? player.games_played : (existing ? existing.games_played : 0)),
          wins: Number(player.wins !== undefined ? player.wins : (existing ? existing.wins : 0)),
          total_score: Number(player.total_score !== undefined ? player.total_score : (existing ? existing.total_score : 0)),
          updated_at: now
        };
        await worker.request({
          cmd: 'query',
          sql: `INSERT INTO players (id, first_name, username, games_played, wins, total_score, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  first_name = excluded.first_name,
                  username = excluded.username,
                  games_played = excluded.games_played,
                  wins = excluded.wins,
                  total_score = excluded.total_score,
                  updated_at = excluded.updated_at`,
          params: [
            updated.id,
            updated.first_name,
            updated.username,
            updated.games_played,
            updated.wins,
            updated.total_score,
            updated.updated_at
          ]
        });
        return updated;
      },
      async getRoom(roomId) {
        const res = await worker.request({
          cmd: 'query',
          sql: 'SELECT * FROM rooms WHERE id = ?',
          params: [String(roomId)]
        });
        return self._deserializeSqlRoomRow(res.rows[0]);
      },
      async saveRoom(room) {
        const now = Date.now();
        room.updated_at = now;
        await worker.request({
          cmd: 'query',
          sql: `INSERT INTO rooms (
                  id, host_id, status, state_version, inline_message_id, chat_id, message_id,
                  players_json, spectators_json, match_state_json, created_at, updated_at, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  host_id = excluded.host_id,
                  status = excluded.status,
                  state_version = excluded.state_version,
                  inline_message_id = excluded.inline_message_id,
                  chat_id = excluded.chat_id,
                  message_id = excluded.message_id,
                  players_json = excluded.players_json,
                  spectators_json = excluded.spectators_json,
                  match_state_json = excluded.match_state_json,
                  updated_at = excluded.updated_at,
                  expires_at = excluded.expires_at`,
          params: [
            String(room.id),
            String(room.host_id),
            String(room.status),
            Number(room.state_version || 1),
            room.inline_message_id || null,
            room.chat_id || null,
            room.message_id || null,
            JSON.stringify(room.players || []),
            JSON.stringify(room.spectators || []),
            room.match_state ? JSON.stringify(room.match_state) : null,
            Number(room.created_at || now),
            now,
            Number(room.expires_at || (now + 3600000))
          ]
        });
        return JSON.parse(JSON.stringify(room));
      },
      async deleteRoom(roomId) {
        await worker.request({
          cmd: 'query',
          sql: 'DELETE FROM rooms WHERE id = ?',
          params: [String(roomId)]
        });
      },
      async listActiveRooms() {
        const res = await worker.request({
          cmd: 'query',
          sql: "SELECT * FROM rooms WHERE status != 'expired'",
          params: []
        });
        return res.rows.map(row => self._deserializeSqlRoomRow(row));
      },
      async recordMatch(matchObj) {
        await worker.request({
          cmd: 'query',
          sql: `INSERT INTO matches (id, room_id, winner_id, win_score, players_summary_json, completed_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO NOTHING`,
          params: [
            String(matchObj.id),
            String(matchObj.room_id),
            String(matchObj.winner_id),
            Number(matchObj.win_score || 0),
            JSON.stringify(matchObj.players_summary || []),
            Number(matchObj.completed_at || Date.now())
          ]
        });
        return JSON.parse(JSON.stringify(matchObj));
      },
      async getMatchesByRoom(roomId) {
        const res = await worker.request({
          cmd: 'query',
          sql: 'SELECT * FROM matches WHERE room_id = ? ORDER BY completed_at ASC',
          params: [String(roomId)]
        });
        return res.rows.map(r => ({
          id: r.id,
          room_id: r.room_id,
          winner_id: r.winner_id,
          win_score: Number(r.win_score),
          players_summary: r.players_summary_json ? JSON.parse(r.players_summary_json) : [],
          completed_at: Number(r.completed_at)
        }));
      }
    };
  }

  _createMongoTxAdapter() {
    const db = this.mongoDb;
    const playersCol = db.collection('players');
    const roomsCol = db.collection('rooms');
    const matchesCol = db.collection('matches');

    const stripMongoId = (doc) => {
      if (!doc) return null;
      const copy = JSON.parse(JSON.stringify(doc));
      delete copy._id;
      return copy;
    };

    return {
      async getPlayer(id) {
        const doc = await playersCol.findOne({ id: String(id) });
        return stripMongoId(doc);
      },
      async upsertPlayer(player) {
        const id = String(player.id);
        const existing = await playersCol.findOne({ id });
        const now = Date.now();
        const updated = {
          id,
          first_name: String(player.first_name || player.name || (existing ? existing.first_name : 'Player')),
          username: String(player.username !== undefined ? player.username : (existing ? existing.username : '')),
          games_played: Number(player.games_played !== undefined ? player.games_played : (existing ? existing.games_played : 0)),
          wins: Number(player.wins !== undefined ? player.wins : (existing ? existing.wins : 0)),
          total_score: Number(player.total_score !== undefined ? player.total_score : (existing ? existing.total_score : 0)),
          updated_at: now
        };
        await playersCol.updateOne({ id }, { $set: updated }, { upsert: true });
        return updated;
      },
      async getRoom(roomId) {
        const doc = await roomsCol.findOne({ id: String(roomId) });
        return stripMongoId(doc);
      },
      async saveRoom(room) {
        const copy = JSON.parse(JSON.stringify(room));
        delete copy._id;
        copy.updated_at = Date.now();
        await roomsCol.updateOne({ id: String(room.id) }, { $set: copy }, { upsert: true });
        return copy;
      },
      async deleteRoom(roomId) {
        await roomsCol.deleteOne({ id: String(roomId) });
      },
      async listActiveRooms() {
        const docs = await roomsCol.find({ status: { $ne: 'expired' } }).toArray();
        return docs.map(stripMongoId);
      },
      async recordMatch(matchObj) {
        const copy = JSON.parse(JSON.stringify(matchObj));
        delete copy._id;
        await matchesCol.updateOne({ id: String(copy.id) }, { $setOnInsert: copy }, { upsert: true });
        return copy;
      },
      async getMatchesByRoom(roomId) {
        const docs = await matchesCol.find({ room_id: String(roomId) }).sort({ completed_at: 1 }).toArray();
        return docs.map(stripMongoId);
      }
    };
  }

  async close() {
    if (this.redisCache) {
      await this.redisCache.close();
    }
    if (this.pgPool) {
      await this.pgPool.end();
      this.pgPool = null;
    }
    if (this.mongoClient) {
      if (typeof this.mongoClient.close === 'function') {
        await this.mongoClient.close();
      }
      this.mongoClient = null;
      this.mongoDb = null;
    }
    if (this.sqliteWorker) {
      await this.sqliteWorker.close();
      this.sqliteWorker = null;
    }
  }
}

/**
 * Migrate all players, active rooms, and match history from `sourceDb` to `targetDb`.
 */
async function migrateDatabase(sourceDb, targetDb) {
  let playersMigrated = 0;
  let roomsMigrated = 0;
  let matchesMigrated = 0;

  await sourceDb.withTransaction(async (srcTx) => {
    const rooms = await srcTx.listActiveRooms();
    const seenPlayerIds = new Set();

    await targetDb.withTransaction(async (dstTx) => {
      for (const room of rooms) {
        await dstTx.saveRoom(room);
        roomsMigrated++;

        for (const p of (room.players || [])) {
          if (!seenPlayerIds.has(p.id)) {
            seenPlayerIds.add(p.id);
            const prof = await srcTx.getPlayer(p.id);
            if (prof) {
              await dstTx.upsertPlayer(prof);
              playersMigrated++;
            }
          }
        }

        const roomMatches = await srcTx.getMatchesByRoom(room.id);
        for (const m of roomMatches) {
          await dstTx.recordMatch(m);
          matchesMigrated++;
        }
      }
    });
  });

  return { playersMigrated, roomsMigrated, matchesMigrated };
}

module.exports = {
  PersistentDatabase,
  selectDatabaseProvider,
  redactDatabaseUri,
  migrateDatabase
};
