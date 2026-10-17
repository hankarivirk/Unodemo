/**
 * UNO Royale / Matcho! — Unified HTTP, REST API, WebSocket & Telegram Bot Server (`server/index.js`)
 *
 * Production & Development Features:
 * - Automatic `.env` loading via `server/env_loader.js`
 * - Multi-database support (`postgres` / Neon, `mongodb`, `sqlite`, `json` fallback) + independent `redis` cache
 * - Strict production startup validation (`validateServerConfig`): fails fast if `SESSION_SECRET` (<32 chars),
 *   `BOT_TOKEN` (missing/placeholder/invalid format), `TELEGRAM_WEBHOOK_SECRET` / `WEBHOOK_SECRET` (<16 chars),
 *   or `PUBLIC_APP_URL` / `WEBAPP_URL` / `ALLOWED_ORIGINS` is missing in production
 * - Authoritative `initData` & `launchToken` security in `authenticateRequestUser`:
 *   - Live signed `initData` takes priority for user identity, preventing stale `sessionToken` account-switch bugs
 *   - Room-scoped `launchToken` ALWAYS enforces room binding (`LAUNCH_TOKEN_ROOM_MISMATCH`) against direct `roomId`,
 *     URL path `:roomId`, and resolved `startParam` rooms, and can NEVER be bypassed by a cached `sessionToken`
 * - Constant-time verification of `X-Telegram-Bot-Api-Secret-Token` on `/api/bot/webhook`
 * - WebSocket upgrade `Origin` validation against configured trusted origins in production
 * - Per-IP HTTP rate limiting & WebSocket token-bucket rate limiting
 * - Built-in `/terms` Terms of Use page for Telegram Mini App `@BotFather` integration
 * - Clean graceful shutdown (`stop()`) closing WebSocket, HTTP, Redis, timers, and primary DB connections
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { loadDotEnv } = require('./env_loader');
const { PersistentDatabase, selectDatabaseProvider, redactDatabaseUri } = require('./db');
const { RoomManager, DEFAULT_WAITING_ROOM_TIMEOUT_MS } = require('./room_manager');
const { NativeWebSocketServer } = require('./ws_server');
const {
  isValidBotTokenFormat,
  isValidSessionSecret,
  isValidWebhookSecret,
  verifyWebhookSecretHeader,
  extractUnverifiedInitDataUser,
  validateTelegramInitData,
  parseStartParam,
  signSessionToken,
  verifySessionToken
} = require('./telegram_auth');
const { TelegramBotController } = require('../bot/telegram_bot');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

const DEV_FALLBACK_SESSION_SECRET = 'dev_local_session_secret_do_not_use_in_production_32chars';

function normalizeOrigin(originStr) {
  if (!originStr || typeof originStr !== 'string') return null;
  try {
    const u = new URL(originStr.trim());
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch (e) {
    return null;
  }
}

function buildTrustedOriginsSet(webAppUrl, allowedOriginsRaw) {
  const origins = new Set();
  if (webAppUrl) {
    const norm = normalizeOrigin(webAppUrl);
    if (norm) origins.add(norm);
  }
  if (Array.isArray(allowedOriginsRaw)) {
    for (const item of allowedOriginsRaw) {
      const norm = normalizeOrigin(item);
      if (norm) origins.add(norm);
    }
  } else if (typeof allowedOriginsRaw === 'string' && allowedOriginsRaw.trim()) {
    for (const part of allowedOriginsRaw.split(',')) {
      const norm = normalizeOrigin(part);
      if (norm) origins.add(norm);
    }
  }
  return origins;
}

/**
 * Validate server configuration and fail fast on missing production secrets or invalid DB settings.
 */
function validateServerConfig(opts) {
  if (opts.isProduction) {
    if (!isValidSessionSecret(opts.sessionSecret)) {
      const err = new Error(
        'CONFIG_ERROR: In production, SESSION_SECRET must be explicitly configured (at least 32 characters, non-placeholder). Never generating a random ephemeral secret.'
      );
      err.code = 'MISSING_PRODUCTION_SESSION_SECRET';
      throw err;
    }

    if (!isValidBotTokenFormat(opts.botToken)) {
      const err = new Error(
        'CONFIG_ERROR: In production, a valid Telegram BOT_TOKEN (format "<bot_id>:<secret>") must be explicitly configured.'
      );
      err.code = 'MISSING_PRODUCTION_BOT_TOKEN';
      throw err;
    }

    if (!isValidWebhookSecret(opts.webhookSecret)) {
      const err = new Error(
        'CONFIG_ERROR: In production, TELEGRAM_WEBHOOK_SECRET (or WEBHOOK_SECRET, 16-256 characters) must be explicitly configured to secure /api/bot/webhook.'
      );
      err.code = 'MISSING_PRODUCTION_WEBHOOK_SECRET';
      throw err;
    }

    if (opts.trustedOrigins.size === 0) {
      const err = new Error(
        'CONFIG_ERROR: In production, PUBLIC_APP_URL, WEBAPP_URL, or ALLOWED_ORIGINS must be configured with at least one valid origin for WebSocket Origin validation.'
      );
      err.code = 'MISSING_PRODUCTION_ALLOWED_ORIGINS';
      throw err;
    }

    if (opts.allowDevAuth) {
      const err = new Error(
        'CONFIG_ERROR: ALLOW_DEV_AUTH cannot be enabled when running in production mode.'
      );
      err.code = 'DEV_AUTH_FORBIDDEN_IN_PRODUCTION';
      throw err;
    }
  }

  // Validate database provider selection eagerly
  selectDatabaseProvider({
    databaseProvider: opts.databaseProvider,
    databaseUrl: opts.databaseUrl,
    mongodbUri: opts.mongodbUri,
    sqlitePath: opts.sqlitePath,
    dbFilePath: opts.dbFilePath,
    isProduction: opts.isProduction,
    dbAutoFallback: opts.dbAutoFallback,
    pgPool: opts.pgPool,
    mongoClient: opts.mongoClient
  });
}

function createUnoServer(options) {
  const rawOpts = options || {};
  if (!rawOpts.skipDotEnv) {
    loadDotEnv({ envPath: rawOpts.envPath || path.join(__dirname, '..', '.env') });
  }

  const nodeEnv = rawOpts.nodeEnv || process.env.NODE_ENV || 'development';
  const isProduction = rawOpts.isProduction !== undefined
    ? Boolean(rawOpts.isProduction)
    : (nodeEnv === 'production');

  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN
    ? (`https://${String(process.env.RAILWAY_PUBLIC_DOMAIN).replace(/^https?:\/\//, '')}`)
    : '';

  const webAppUrl = rawOpts.webAppUrl !== undefined
    ? rawOpts.webAppUrl
    : (rawOpts.publicAppUrl !== undefined
        ? rawOpts.publicAppUrl
        : (process.env.PUBLIC_APP_URL || process.env.WEBAPP_URL || railwayDomain || (isProduction ? '' : 'http://localhost:3000')));

  const allowedOriginsInput = rawOpts.allowedOrigins !== undefined
    ? rawOpts.allowedOrigins
    : (process.env.ALLOWED_ORIGINS || '');

  const trustedOrigins = buildTrustedOriginsSet(webAppUrl, allowedOriginsInput);

  const sessionSecret = rawOpts.sessionSecret !== undefined
    ? rawOpts.sessionSecret
    : (process.env.SESSION_SECRET || (isProduction ? '' : DEV_FALLBACK_SESSION_SECRET));

  const botToken = rawOpts.botToken !== undefined
    ? rawOpts.botToken
    : (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '');

  const botUsername = String(
    rawOpts.botUsername || process.env.BOT_USERNAME || process.env.TELEGRAM_BOT_USERNAME || 'matcho_bot'
  ).replace(/^@/, '').trim() || 'matcho_bot';

  const appShortName = String(
    rawOpts.appShortName || process.env.APP_SHORT_NAME || process.env.TELEGRAM_APP_SHORT_NAME || 'play'
  ).replace(/[^A-Za-z0-9_-]/g, '').trim() || 'play';

  const webhookSecret = rawOpts.webhookSecret !== undefined
    ? rawOpts.webhookSecret
    : (rawOpts.telegramWebhookSecret !== undefined
        ? rawOpts.telegramWebhookSecret
        : (process.env.TELEGRAM_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || ''));

  const allowDevAuth = rawOpts.allowDevAuth !== undefined
    ? Boolean(rawOpts.allowDevAuth)
    : (!isProduction && process.env.ALLOW_DEV_AUTH !== 'false');

  const databaseProvider = rawOpts.databaseProvider !== undefined
    ? rawOpts.databaseProvider
    : (process.env.DATABASE_PROVIDER || 'auto');

  const databaseUrl = rawOpts.databaseUrl !== undefined
    ? rawOpts.databaseUrl
    : (process.env.DATABASE_URL || '');

  const mongodbUri = rawOpts.mongodbUri !== undefined
    ? rawOpts.mongodbUri
    : (process.env.MONGODB_URI || '');

  const mongodbDatabase = rawOpts.mongodbDatabase !== undefined
    ? rawOpts.mongodbDatabase
    : (process.env.MONGODB_DATABASE || 'uno_royale');

  const sqlitePath = rawOpts.sqlitePath !== undefined
    ? rawOpts.sqlitePath
    : (process.env.SQLITE_PATH || '');

  const dbFilePath = rawOpts.dbFilePath !== undefined
    ? rawOpts.dbFilePath
    : (process.env.DB_FILE_PATH || (isProduction ? '' : path.join(__dirname, '..', 'data', 'uno_royale_db.json')));

  const redisUrl = rawOpts.redisUrl !== undefined
    ? rawOpts.redisUrl
    : (process.env.REDIS_URL || '');

  const dbConnectionTimeoutMs = Number(
    rawOpts.dbConnectionTimeoutMs !== undefined
      ? rawOpts.dbConnectionTimeoutMs
      : (process.env.DB_CONNECTION_TIMEOUT_MS || 5000)
  );

  const dbAutoFallback = rawOpts.dbAutoFallback !== undefined
    ? Boolean(rawOpts.dbAutoFallback)
    : (process.env.DB_AUTO_FALLBACK !== undefined
        ? process.env.DB_AUTO_FALLBACK === 'true'
        : !isProduction);

  const waitingRoomTimeoutMs = Number(
    rawOpts.waitingRoomTimeoutMs !== undefined
      ? rawOpts.waitingRoomTimeoutMs
      : (process.env.WAITING_ROOM_TIMEOUT_MS || DEFAULT_WAITING_ROOM_TIMEOUT_MS)
  );

  const opts = {
    nodeEnv,
    isProduction,
    port: Number(rawOpts.port !== undefined ? rawOpts.port : (process.env.PORT || 3000)),
    botToken,
    botUsername,
    appShortName,
    sessionSecret,
    webhookSecret,
    webAppUrl,
    trustedOrigins,
    enforceOriginCheck: rawOpts.enforceOriginCheck !== undefined ? Boolean(rawOpts.enforceOriginCheck) : isProduction,
    allowDevAuth,
    databaseProvider,
    databaseUrl,
    mongodbUri,
    mongodbDatabase,
    sqlitePath,
    dbFilePath,
    redisUrl,
    dbConnectionTimeoutMs,
    dbAutoFallback,
    waitingRoomTimeoutMs,
    pgPool: rawOpts.pgPool || null,
    pgModule: rawOpts.pgModule || null,
    mongoClient: rawOpts.mongoClient || null,
    mongodbModule: rawOpts.mongodbModule || null,
    redisClient: rawOpts.redisClient || null,
    staticRoot: rawOpts.staticRoot || path.join(__dirname, '..'),
    officialOpeningEffects: rawOpts.officialOpeningEffects !== undefined ? Boolean(rawOpts.officialOpeningEffects) : true,
    enableWild4Challenge: rawOpts.enableWild4Challenge !== undefined ? Boolean(rawOpts.enableWild4Challenge) : true,
    httpRateLimitPerMin: Number(rawOpts.httpRateLimitPerMin || 180),
    telegramApiCaller: rawOpts.telegramApiCaller,
    logger: rawOpts.logger || console
  };

  validateServerConfig(opts);

  const db = new PersistentDatabase({
    isProduction: opts.isProduction,
    databaseProvider: opts.databaseProvider,
    databaseUrl: opts.databaseUrl,
    mongodbUri: opts.mongodbUri,
    mongodbDatabase: opts.mongodbDatabase,
    sqlitePath: opts.sqlitePath,
    dbFilePath: opts.dbFilePath || path.join(__dirname, '..', 'data', 'uno_royale_db.json'),
    redisUrl: opts.redisUrl,
    connectionTimeoutMs: opts.dbConnectionTimeoutMs,
    dbAutoFallback: opts.dbAutoFallback,
    pgPool: opts.pgPool,
    pgModule: opts.pgModule,
    mongoClient: opts.mongoClient,
    mongodbModule: opts.mongodbModule,
    redisClient: opts.redisClient,
    logger: opts.logger
  });

  const roomSubscriptions = new Map();
  const httpRateBuckets = new Map();
  let botController = null;

  const roomManager = new RoomManager(db, {
    waitingRoomTimeoutMs: opts.waitingRoomTimeoutMs,
    officialOpeningEffects: opts.officialOpeningEffects,
    enableWild4Challenge: opts.enableWild4Challenge,
    sessionSecret: opts.sessionSecret,
    botUsername: opts.botUsername,
    appShortName: opts.appShortName,
    onRoomUpdated: (room) => {
      if (botController) {
        botController.syncRoomTelegramMessage(room).catch(() => {});
      }
    },
    onRoomExpired: (room) => {
      if (!room) return;
      const subs = roomSubscriptions.get(room.id);
      if (subs) {
        for (const sub of subs) {
          if (sub.ws && sub.ws.readyState === 1) {
            sub.ws.sendJSON({
              type: 'ERROR',
              code: 'ROOM_EXPIRED',
              error: 'This lobby expired before the game started.',
              roomId: room.id,
              room: roomManager.formatPublicRoomState(room, sub.user ? sub.user.id : null)
            });
          }
          if (sub.ws) sub.ws._roomId = null;
        }
        roomSubscriptions.delete(room.id);
      }
    }
  });

  botController = new TelegramBotController(roomManager, {
    botToken: opts.botToken,
    botUsername: opts.botUsername,
    appShortName: opts.appShortName,
    webAppUrl: opts.webAppUrl || `http://localhost:${opts.port}`,
    sessionSecret: opts.sessionSecret,
    apiCaller: opts.telegramApiCaller,
    logger: opts.logger
  });

  function checkHttpRateLimit(req) {
    const ip = String(req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '127.0.0.1');
    const now = Date.now();
    let bucket = httpRateBuckets.get(ip);
    if (!bucket || now - bucket.windowStart > 60000) {
      bucket = { windowStart: now, count: 0 };
      httpRateBuckets.set(ip, bucket);
    }
    bucket.count++;
    return bucket.count <= opts.httpRateLimitPerMin;
  }

  function broadcastRoom(room, eventObj) {
    if (!room) return;
    const subs = roomSubscriptions.get(room.id);
    if (!subs) return;
    for (const sub of subs) {
      if (sub.ws.readyState === 1) {
        const sanitized = roomManager.formatPublicRoomState(room, sub.user ? sub.user.id : null);
        sub.ws.sendJSON({
          type: 'ROOM_STATE',
          room: sanitized,
          event: eventObj || (sanitized.match ? sanitized.match.lastEvent : null)
        });
      }
    }
  }

  roomManager.onBroadcastRoom = broadcastRoom;

  function verifyWebSocketOrigin(req) {
    const rawOrigin = req.headers.origin;
    const normOrigin = normalizeOrigin(rawOrigin);

    if (opts.enforceOriginCheck) {
      if (!normOrigin) {
        return {
          allowed: false,
          statusCode: 403,
          code: 'MISSING_ORIGIN',
          error: 'WebSocket upgrade requires a valid Origin header in production.'
        };
      }
      if (!opts.trustedOrigins.has(normOrigin)) {
        return {
          allowed: false,
          statusCode: 403,
          code: 'INVALID_ORIGIN',
          error: `WebSocket Origin "${rawOrigin}" is not in the configured ALLOWED_ORIGINS list.`
        };
      }
      return { allowed: true };
    }

    if (!rawOrigin) return { allowed: true };
    if (!normOrigin) {
      return { allowed: false, statusCode: 403, code: 'MALFORMED_ORIGIN', error: 'Malformed Origin header.' };
    }
    if (
      normOrigin.startsWith('http://localhost:') ||
      normOrigin === 'http://localhost' ||
      normOrigin.startsWith('http://127.0.0.1:') ||
      normOrigin === 'http://127.0.0.1' ||
      opts.trustedOrigins.has(normOrigin)
    ) {
      return { allowed: true };
    }

    return {
      allowed: false,
      statusCode: 403,
      code: 'INVALID_ORIGIN',
      error: `Untrusted WebSocket Origin "${rawOrigin}".`
    };
  }

  /**
   * Enforce room-binding constraints whenever a room-scoped launchToken (or room-bound sessionToken)
   * or a room-specific `startParam` is supplied.
   */
  function validateTargetRoomAuthorization(boundRoomId, bodyObj, initDataStartParam, explicitTargetRoomId) {
    const bodyRoomId = (bodyObj && bodyObj.roomId !== undefined && bodyObj.roomId !== null)
      ? String(bodyObj.roomId).trim()
      : null;
    const bodyStartRaw = (bodyObj && bodyObj.startParam !== undefined && bodyObj.startParam !== null)
      ? String(bodyObj.startParam).trim()
      : '';
    const initStartRaw = initDataStartParam ? String(initDataStartParam).trim() : '';

    let parsedBodyStart = null;
    if (bodyStartRaw) {
      parsedBodyStart = parseStartParam(bodyStartRaw, opts.sessionSecret);
      if (!parsedBodyStart.valid) {
        return {
          ok: false,
          code: parsedBodyStart.code || 'INVALID_START_PARAM',
          error: parsedBodyStart.error || 'Invalid room startParam.'
        };
      }
    }

    let parsedInitStart = null;
    if (initStartRaw) {
      parsedInitStart = parseStartParam(initStartRaw, opts.sessionSecret);
      if (!parsedInitStart.valid) {
        return {
          ok: false,
          code: parsedInitStart.code || 'INVALID_START_PARAM',
          error: parsedInitStart.error || 'Invalid initData start_param.'
        };
      }
    }

    // Even without a launchToken, an invite link for Room A (`startParam`) must never be combined with a different `roomId` (Room B)
    const startParamRoomId = (parsedBodyStart && parsedBodyStart.roomId) || (parsedInitStart && parsedInitStart.roomId) || null;
    if (startParamRoomId) {
      if (explicitTargetRoomId && String(explicitTargetRoomId) !== String(startParamRoomId)) {
        return {
          ok: false,
          code: 'LAUNCH_TOKEN_ROOM_MISMATCH',
          error: 'Room invite parameter does not match the requested target room.'
        };
      }
      if (bodyRoomId && String(bodyRoomId) !== String(startParamRoomId)) {
        return {
          ok: false,
          code: 'LAUNCH_TOKEN_ROOM_MISMATCH',
          error: 'Room invite parameter does not match the requested roomId.'
        };
      }
    }
    if (parsedBodyStart && parsedInitStart && parsedBodyStart.roomId && parsedInitStart.roomId) {
      if (String(parsedBodyStart.roomId) !== String(parsedInitStart.roomId)) {
        return {
          ok: false,
          code: 'LAUNCH_TOKEN_ROOM_MISMATCH',
          error: 'Conflicting room identifiers in startParam and initData.'
        };
      }
    }

    // If a room-scoped launchToken (or room-bound sessionToken) is present, strictly enforce `boundRoomId`
    if (boundRoomId) {
      const expectedRoom = String(boundRoomId);

      if (explicitTargetRoomId !== undefined && explicitTargetRoomId !== null) {
        if (!explicitTargetRoomId || String(explicitTargetRoomId) !== expectedRoom) {
          return {
            ok: false,
            code: 'LAUNCH_TOKEN_ROOM_MISMATCH',
            error: 'Launch token is bound to a different room.'
          };
        }
      }

      if (bodyRoomId !== null) {
        if (!bodyRoomId || bodyRoomId !== expectedRoom) {
          return {
            ok: false,
            code: 'LAUNCH_TOKEN_ROOM_MISMATCH',
            error: 'Launch token is bound to a different room.'
          };
        }
      }

      if (parsedBodyStart) {
        if (parsedBodyStart.isPractice || !parsedBodyStart.roomId || String(parsedBodyStart.roomId) !== expectedRoom) {
          return {
            ok: false,
            code: 'LAUNCH_TOKEN_ROOM_MISMATCH',
            error: 'Launch token is bound to a different room than startParam.'
          };
        }
      }

      if (parsedInitStart) {
        if (parsedInitStart.isPractice || !parsedInitStart.roomId || String(parsedInitStart.roomId) !== expectedRoom) {
          return {
            ok: false,
            code: 'LAUNCH_TOKEN_ROOM_MISMATCH',
            error: 'Launch token is bound to a different room than initData start_param.'
          };
        }
      }
    }

    return {
      ok: true,
      resolvedRoomId: explicitTargetRoomId || bodyRoomId || startParamRoomId || boundRoomId || null,
      parsedStart: parsedBodyStart || parsedInitStart || null
    };
  }

  /**
   * Authenticate HTTP/WebSocket request user with strict launch-token room binding:
   * 1. If `launchToken` is provided, ALWAYS verify it first. A malformed or expired `launchToken`
   *    fails closed immediately (`UNAUTHORIZED`), and a valid `launchToken`'s `roomId` claim
   *    is enforced even when `sessionToken` or `initData` is also present in the request.
   * 2. Live signed `initData` (`body.initData` or `X-Telegram-Init-Data` header) takes priority
   *    for user identity when present, preventing stale `sessionToken` identity mismatches.
   * 3. When `initData` is absent, `launchToken` takes precedence over `sessionToken` so a cached
   *    `sessionToken` can never silently authorize a different room than the `launchToken` permits.
   * 4. Only in non-production development mode (`allowDevAuth: true`), allows `devUser` fallback.
   */
  function authenticateRequestUser(body, headers, explicitTargetRoomId) {
    const rawInitData = (body && body.initData) || (headers && headers['x-telegram-init-data']) || '';
    const authHeader = (headers && headers.authorization) || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const sessionTokenCandidate = bearerToken || (body && body.sessionToken) || '';
    const launchTokenCandidate = (body && body.launchToken) || (headers && headers['x-telegram-launch-token']) || '';

    // Step 1: Always verify launchToken whenever supplied so a cached sessionToken cannot mask or bypass it
    let verifiedLaunch = null;
    if (launchTokenCandidate && String(launchTokenCandidate).trim()) {
      verifiedLaunch = verifySessionToken(String(launchTokenCandidate).trim(), opts.sessionSecret);
      if (!verifiedLaunch || !verifiedLaunch.user || !verifiedLaunch.user.id || verifiedLaunch.kind !== 'launch') {
        return {
          ok: false,
          code: 'UNAUTHORIZED',
          error: 'Launch token is invalid, malformed, or expired.'
        };
      }
    }

    const launchBoundRoomId = (verifiedLaunch && verifiedLaunch.roomId) ? String(verifiedLaunch.roomId) : null;

    // Step 2: Validate live Telegram initData first whenever provided
    if (rawInitData && String(rawInitData).trim()) {
      const check = validateTelegramInitData(rawInitData, opts.botToken);
      if (check.valid) {
        if (verifiedLaunch && String(verifiedLaunch.user.id) !== String(check.user.id)) {
          return {
            ok: false,
            code: 'UNAUTHORIZED',
            error: 'Launch token user does not match Telegram initData user.'
          };
        }
        const roomCheck = validateTargetRoomAuthorization(
          launchBoundRoomId,
          body,
          check.start_param || null,
          explicitTargetRoomId
        );
        if (!roomCheck.ok) return roomCheck;

        return {
          ok: true,
          user: check.user,
          startParam: check.start_param || (verifiedLaunch && verifiedLaunch.startParam) || null,
          boundRoomId: launchBoundRoomId,
          authMethod: 'initData'
        };
      }
      // In local development mode (`allowDevAuth: true`) when BOT_TOKEN is not yet configured,
      // allow extracting the unverified user from initData instead of blocking.
      if (opts.allowDevAuth && !isValidBotTokenFormat(opts.botToken)) {
        const unverified = extractUnverifiedInitDataUser(rawInitData);
        if (unverified && unverified.user) {
          const roomCheck = validateTargetRoomAuthorization(
            launchBoundRoomId,
            body,
            unverified.start_param || null,
            explicitTargetRoomId
          );
          if (!roomCheck.ok) return roomCheck;

          return {
            ok: true,
            user: unverified.user,
            startParam: unverified.start_param || (body && body.startParam) || null,
            boundRoomId: launchBoundRoomId,
            isDev: true,
            authMethod: 'dev_initData'
          };
        }
      } else {
        // Explicit invalid/tampered/expired initData must fail closed and NEVER fall back to a stale sessionToken
        return { ok: false, code: 'INVALID_INIT_DATA', error: check.error };
      }
    }

    // Step 3: If a valid launchToken is present (with or without a cached sessionToken), launchToken takes precedence
    if (verifiedLaunch) {
      const roomCheck = validateTargetRoomAuthorization(
        launchBoundRoomId,
        body,
        verifiedLaunch.startParam || null,
        explicitTargetRoomId
      );
      if (!roomCheck.ok) return roomCheck;

      return {
        ok: true,
        user: verifiedLaunch.user,
        startParam: verifiedLaunch.startParam || null,
        boundRoomId: launchBoundRoomId,
        authMethod: 'launchToken'
      };
    }

    // Step 4: Verify sessionToken when neither initData nor launchToken is present
    if (sessionTokenCandidate && String(sessionTokenCandidate).trim()) {
      const verifiedSession = verifySessionToken(String(sessionTokenCandidate).trim(), opts.sessionSecret);
      if (verifiedSession && verifiedSession.user && verifiedSession.user.id) {
        const sessionBoundRoomId = verifiedSession.roomId || verifiedSession.boundRoomId || null;
        const roomCheck = validateTargetRoomAuthorization(
          sessionBoundRoomId,
          body,
          null,
          explicitTargetRoomId
        );
        if (!roomCheck.ok) return roomCheck;

        return {
          ok: true,
          user: verifiedSession.user,
          startParam: verifiedSession.startParam || null,
          boundRoomId: sessionBoundRoomId,
          authMethod: verifiedSession.kind === 'launch' ? 'launchToken' : 'sessionToken'
        };
      }
      if (!opts.allowDevAuth) {
        return {
          ok: false,
          code: 'UNAUTHORIZED',
          error: 'Session token has expired or is invalid. Please relaunch from Telegram.'
        };
      }
    }

    // Step 5: Development-only fallback (`allowDevAuth` is strictly forbidden in production)
    if (opts.allowDevAuth && body && body.devUser && body.devUser.id) {
      const roomCheck = validateTargetRoomAuthorization(null, body, null, explicitTargetRoomId);
      if (!roomCheck.ok) return roomCheck;

      return {
        ok: true,
        user: {
          id: String(body.devUser.id).slice(0, 48),
          first_name: String(body.devUser.first_name || body.devUser.name || 'Dev Player').slice(0, 48),
          username: String(body.devUser.username || '').slice(0, 48)
        },
        startParam: body.startParam || null,
        boundRoomId: null,
        isDev: true,
        authMethod: 'devUser'
      };
    }

    return {
      ok: false,
      code: 'UNAUTHORIZED',
      error: 'Valid Telegram WebApp initData is required.'
    };
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', chunk => {
        raw += chunk;
        if (raw.length > 64 * 1024) {
          reject(new Error('Request body too large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (!checkHttpRateLimit(req)) {
        return sendJson(res, 429, {
          ok: false,
          code: 'RATE_LIMITED',
          error: 'Too many HTTP requests. Please slow down.'
        });
      }

      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;

      if (req.method === 'GET' && pathname === '/api/health') {
        const dbHealthy = Boolean(db && db.mode && db.mode !== 'uninitialized');
        const statusCode = dbHealthy ? 200 : 503;
        return sendJson(res, statusCode, {
          ok: dbHealthy,
          status: dbHealthy ? 'healthy' : 'unhealthy',
          nodeEnv: opts.nodeEnv,
          isProduction: opts.isProduction,
          dbMode: db.mode,
          dbProvider: db.providerInfo ? db.providerInfo.provider : db.mode,
          redisEnabled: Boolean(db.redisCache && db.redisCache.enabled),
          redisHealthy: Boolean(db.redisCache && db.redisCache.healthy),
          allowDevAuth: opts.allowDevAuth,
          botUsername: botController.botUsername,
          appShortName: botController.appShortName
        });
      }

      if (req.method === 'GET' && pathname === '/terms') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<title>Matcho! — Terms of Use</title></head>' +
          '<body style="background:#191124;color:#f8fafc;font-family:sans-serif;padding:24px;line-height:1.6;">' +
          '<h1>Matcho! (Beta) — Terms of Use</h1>' +
          '<p>Matcho! is a free-to-play multiplayer card game for Telegram Mini Apps. No real-money gambling or wagering is offered.</p>' +
          '<p>Fair Play: All moves are validated by the authoritative game server. Automated scripts or abuse may result in room removal.</p>' +
          '</body></html>'
        );
      }

      if (req.method === 'POST' && pathname === '/api/auth') {
        const body = await readJsonBody(req);
        const auth = authenticateRequestUser(body, req.headers);
        if (!auth.ok) {
          const errStatus = auth.code === 'LAUNCH_TOKEN_ROOM_MISMATCH' ? 403 : 401;
          return sendJson(res, errStatus, { ok: false, code: auth.code, error: auth.error });
        }

        const rawStart = body.startParam || auth.startParam || '';
        const parsedStart = rawStart
          ? parseStartParam(rawStart, opts.sessionSecret)
          : { valid: false, mode: null, roomId: null };

        if (auth.boundRoomId && parsedStart.valid && parsedStart.roomId && String(parsedStart.roomId) !== String(auth.boundRoomId)) {
          return sendJson(res, 403, {
            ok: false,
            code: 'LAUNCH_TOKEN_ROOM_MISMATCH',
            error: 'Launch token is bound to a different room.'
          });
        }

        const sessionToken = signSessionToken({
          user: auth.user,
          startParam: rawStart || null,
          boundRoomId: auth.boundRoomId || null,
          exp: Date.now() + 24 * 3600 * 1000
        }, opts.sessionSecret);

        return sendJson(res, 200, {
          ok: true,
          user: auth.user,
          sessionToken,
          startParam: parsedStart,
          botUsername: botController.botUsername,
          appShortName: botController.appShortName
        });
      }

      if (req.method === 'POST' && pathname === '/api/rooms') {
        const body = await readJsonBody(req);
        const auth = authenticateRequestUser(body, req.headers);
        if (!auth.ok) {
          const errStatus = auth.code === 'LAUNCH_TOKEN_ROOM_MISMATCH' ? 403 : 401;
          return sendJson(res, errStatus, { ok: false, code: auth.code, error: auth.error });
        }
        if (auth.boundRoomId && (!body.roomId || String(body.roomId) !== String(auth.boundRoomId))) {
          return sendJson(res, 403, {
            ok: false,
            code: 'LAUNCH_TOKEN_ROOM_MISMATCH',
            error: 'Room-scoped launch token cannot create a different room.'
          });
        }

        const created = await roomManager.createRoom(auth.user, {
          roomId: body.roomId,
          maxPlayers: body.maxPlayers === 2 ? 2 : 4
        });
        return sendJson(res, 201, {
          ok: true,
          room: roomManager.formatPublicRoomState(created.room, auth.user.id)
        });
      }

      const roomMatch = /^\/api\/rooms\/(uno_[a-zA-Z0-9_-]{3,48})$/.exec(pathname);
      if (req.method === 'GET' && roomMatch) {
        const roomId = roomMatch[1];
        const roomRes = await roomManager.getRoom(roomId);
        if (!roomRes.ok) {
          const status = roomRes.code === 'ROOM_EXPIRED' ? 410 : 404;
          return sendJson(res, status, roomRes);
        }
        const auth = authenticateRequestUser({}, req.headers, roomId);
        const viewerId = auth.ok ? auth.user.id : null;
        return sendJson(res, 200, {
          ok: true,
          room: roomManager.formatPublicRoomState(roomRes.room, viewerId)
        });
      }

      const joinMatch = /^\/api\/rooms\/(uno_[a-zA-Z0-9_-]{3,48})\/join$/.exec(pathname);
      if (req.method === 'POST' && joinMatch) {
        const roomId = joinMatch[1];
        const body = await readJsonBody(req);
        const auth = authenticateRequestUser(body, req.headers, roomId);
        if (!auth.ok) {
          const errStatus = auth.code === 'LAUNCH_TOKEN_ROOM_MISMATCH' ? 403 : 401;
          return sendJson(res, errStatus, { ok: false, code: auth.code, error: auth.error });
        }

        if (auth.boundRoomId && String(auth.boundRoomId) !== String(roomId)) {
          return sendJson(res, 403, {
            ok: false,
            code: 'LAUNCH_TOKEN_ROOM_MISMATCH',
            error: 'Launch token is bound to a different room.'
          });
        }

        const joinRes = await roomManager.joinRoom(roomId, auth.user, body.mode || 'player');
        if (!joinRes.ok) {
          const status = joinRes.code === 'ROOM_NOT_FOUND' ? 404 : (joinRes.code === 'ROOM_EXPIRED' ? 410 : 409);
          return sendJson(res, status, joinRes);
        }

        broadcastRoom(joinRes.room, {
          type: 'PLAYER_JOINED',
          userId: auth.user.id,
          role: joinRes.role,
          seat: joinRes.seat
        });

        return sendJson(res, 200, {
          ok: true,
          role: joinRes.role,
          seat: joinRes.seat,
          room: roomManager.formatPublicRoomState(joinRes.room, auth.user.id)
        });
      }

      if (req.method === 'POST' && pathname === '/api/bot/webhook') {
        const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
        const verifyRes = verifyWebhookSecretHeader(headerSecret, opts.webhookSecret);
        if (!verifyRes.valid) {
          return sendJson(res, verifyRes.status, {
            ok: false,
            code: verifyRes.code,
            error: verifyRes.error
          });
        }

        const update = await readJsonBody(req);
        try {
          const result = await botController.handleUpdate(update);
          return sendJson(res, 200, { ok: true, result });
        } catch (botErr) {
          return sendJson(res, 502, {
            ok: false,
            code: botErr.code || 'TELEGRAM_BOT_ERROR',
            error: botErr.message
          });
        }
      }

      // Static Frontend Files
      let safePath = pathname === '/' ? '/index.html' : pathname;
      safePath = path.normalize(safePath).replace(/^(\.\.(\/|\\|$))+/, '');
      const fullPath = path.join(opts.staticRoot, safePath);

      if (!fullPath.startsWith(opts.staticRoot) ||
          safePath.startsWith('/server') ||
          safePath.startsWith('/bot') ||
          safePath.startsWith('/data') ||
          safePath.startsWith('/tests') ||
          safePath.startsWith('/.env') ||
          safePath.startsWith('/.git')) {
        res.writeHead(403);
        return res.end('Forbidden');
      }

      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        fs.createReadStream(fullPath).pipe(res);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || 'Internal server error' });
    }
  });

  const wss = new NativeWebSocketServer(httpServer, {
    verifyOrigin: verifyWebSocketOrigin
  });

  function unsubscribeSocket(ws) {
    if (!ws._roomId) return;
    const roomId = ws._roomId;
    const subs = roomSubscriptions.get(roomId);
    if (subs) {
      for (const s of subs) {
        if (s.ws === ws) subs.delete(s);
      }
      if (subs.size === 0) roomSubscriptions.delete(roomId);
    }
  }

  wss.on('connection', (ws) => {
    ws._user = null;
    ws._roomId = null;

    ws.on('message', async (rawText) => {
      let msg;
      try {
        msg = JSON.parse(rawText);
      } catch (e) {
        ws.sendJSON({ type: 'ERROR', code: 'BAD_JSON', error: 'Malformed WebSocket JSON.' });
        return;
      }

      if (!msg || typeof msg.type !== 'string') {
        ws.sendJSON({ type: 'ERROR', code: 'MISSING_TYPE', error: 'Message type is required.' });
        return;
      }

      const type = msg.type.toUpperCase();

      if (type === 'PING') {
        ws.sendJSON({ type: 'PONG', timestamp: Date.now() });
        return;
      }

      if (type === 'AUTH_JOIN' || type === 'CREATE_ROOM') {
        const auth = authenticateRequestUser(msg, {});
        if (!auth.ok) {
          ws.sendJSON({ type: 'ERROR', code: auth.code, error: auth.error });
          return;
        }
        ws._user = auth.user;

        if (type === 'CREATE_ROOM') {
          if (auth.boundRoomId && (!msg.roomId || String(msg.roomId) !== String(auth.boundRoomId))) {
            ws.sendJSON({
              type: 'ERROR',
              code: 'LAUNCH_TOKEN_ROOM_MISMATCH',
              error: 'Room-scoped launch token cannot create a different room.'
            });
            return;
          }

          if (msg.roomMode === 'solo_utya' || msg.practice === true) {
            const soloRes = await roomManager.createSoloPracticeRoom(ws._user);
            const room = soloRes.room;
            unsubscribeSocket(ws);
            ws._roomId = room.id;
            if (!roomSubscriptions.has(room.id)) roomSubscriptions.set(room.id, new Set());
            roomSubscriptions.get(room.id).add({ ws, user: ws._user });

            const sessionToken = signSessionToken({
              user: ws._user,
              exp: Date.now() + 24 * 3600 * 1000
            }, opts.sessionSecret);

            ws.sendJSON({
              type: 'ROOM_JOINED',
              sessionToken,
              role: 'player',
              seat: 0,
              room: roomManager.formatPublicRoomState(room, ws._user.id)
            });
            return;
          }

          const created = await roomManager.createRoom(ws._user, {
            roomId: msg.roomId,
            maxPlayers: msg.maxPlayers === 2 ? 2 : 4
          });
          const room = created.room;
          unsubscribeSocket(ws);
          ws._roomId = room.id;
          if (!roomSubscriptions.has(room.id)) roomSubscriptions.set(room.id, new Set());
          roomSubscriptions.get(room.id).add({ ws, user: ws._user });

          const sessionToken = signSessionToken({
            user: ws._user,
            boundRoomId: auth.boundRoomId || null,
            exp: Date.now() + 24 * 3600 * 1000
          }, opts.sessionSecret);

          ws.sendJSON({
            type: 'ROOM_JOINED',
            sessionToken,
            role: 'player',
            seat: 0,
            room: roomManager.formatPublicRoomState(room, ws._user.id)
          });
          return;
        }

        // AUTH_JOIN: Resolve target room from msg.roomId, msg.startParam, or auth.startParam,
        // and authoritatively verify it against auth.boundRoomId before joining!
        let targetRoomId = (msg.roomId !== undefined && msg.roomId !== null && String(msg.roomId).trim() !== '')
          ? String(msg.roomId).trim()
          : null;
        let requestedMode = msg.mode === 'spectator' ? 'spectator' : 'player';
        let isOpaqueInvite = false;

        // If msg.roomId was explicitly passed as an empty or malformed string, reject rather than falling back
        if (msg.roomId !== undefined && msg.roomId !== null && (!targetRoomId || !/^uno_[a-zA-Z0-9_-]{3,48}$/.test(targetRoomId))) {
          ws.sendJSON({
            type: 'ERROR',
            code: auth.boundRoomId ? 'LAUNCH_TOKEN_ROOM_MISMATCH' : 'INVALID_ROOM_ID',
            error: 'Invalid room ID.'
          });
          return;
        }

        const rawStartParam = (msg.startParam !== undefined && msg.startParam !== null && String(msg.startParam).trim() !== '')
          ? String(msg.startParam).trim()
          : (auth.startParam || '');

        if (rawStartParam) {
          const parsed = parseStartParam(rawStartParam, opts.sessionSecret);
          if (!parsed.valid) {
            ws.sendJSON({
              type: 'ERROR',
              code: parsed.code || 'INVALID_START_PARAM',
              error: parsed.error || 'Invalid room start_param.'
            });
            return;
          }
          if (parsed.isPractice) {
            if (auth.boundRoomId) {
              ws.sendJSON({
                type: 'ERROR',
                code: 'LAUNCH_TOKEN_ROOM_MISMATCH',
                error: 'Room-scoped launch token cannot launch practice mode.'
              });
              return;
            }
            const soloRes = await roomManager.createSoloPracticeRoom(ws._user);
            const room = soloRes.room;
            unsubscribeSocket(ws);
            ws._roomId = room.id;
            if (!roomSubscriptions.has(room.id)) roomSubscriptions.set(room.id, new Set());
            roomSubscriptions.get(room.id).add({ ws, user: ws._user });

            const sessionToken = signSessionToken({
              user: ws._user,
              exp: Date.now() + 24 * 3600 * 1000
            }, opts.sessionSecret);

            ws.sendJSON({
              type: 'ROOM_JOINED',
              sessionToken,
              role: 'player',
              seat: 0,
              room: roomManager.formatPublicRoomState(room, ws._user.id)
            });
            return;
          }

          if (targetRoomId && parsed.roomId && String(targetRoomId) !== String(parsed.roomId)) {
            ws.sendJSON({
              type: 'ERROR',
              code: 'LAUNCH_TOKEN_ROOM_MISMATCH',
              error: 'Target roomId does not match the room resolved from startParam.'
            });
            return;
          }

          if (!targetRoomId) {
            targetRoomId = parsed.roomId;
          }
          requestedMode = msg.mode === 'spectator' ? 'spectator' : parsed.mode;
          isOpaqueInvite = Boolean(parsed.isOpaqueInvite);
        }

        if (!targetRoomId || !/^uno_[a-zA-Z0-9_-]{3,48}$/.test(targetRoomId)) {
          ws.sendJSON({
            type: 'ERROR',
            code: auth.boundRoomId ? 'LAUNCH_TOKEN_ROOM_MISMATCH' : 'INVALID_ROOM_ID',
            error: 'Invalid or missing room ID.'
          });
          return;
        }

        // Authoritative final room-binding check before joining
        if (auth.boundRoomId && String(targetRoomId) !== String(auth.boundRoomId)) {
          ws.sendJSON({
            type: 'ERROR',
            code: 'LAUNCH_TOKEN_ROOM_MISMATCH',
            error: 'Launch token is bound to a different room.'
          });
          return;
        }

        const joinRes = await roomManager.joinRoom(targetRoomId, ws._user, requestedMode, {
          createIfMissing: isOpaqueInvite
        });
        if (!joinRes.ok) {
          const currentRoomRes = await roomManager.getRoom(targetRoomId);
          ws.sendJSON({
            type: 'ERROR',
            code: joinRes.code,
            error: joinRes.error,
            roomId: targetRoomId,
            canSpectate: joinRes.code === 'ROOM_FULL' || joinRes.code === 'MATCH_ALREADY_STARTED',
            room: currentRoomRes.ok ? roomManager.formatPublicRoomState(currentRoomRes.room, ws._user.id) : null
          });
          return;
        }

        unsubscribeSocket(ws);
        ws._roomId = joinRes.room.id;
        if (!roomSubscriptions.has(joinRes.room.id)) {
          roomSubscriptions.set(joinRes.room.id, new Set());
        }
        roomSubscriptions.get(joinRes.room.id).add({ ws, user: ws._user });

        const sessionToken = signSessionToken({
          user: ws._user,
          boundRoomId: auth.boundRoomId || null,
          exp: Date.now() + 24 * 3600 * 1000
        }, opts.sessionSecret);

        ws.sendJSON({
          type: 'ROOM_JOINED',
          sessionToken,
          role: joinRes.role,
          seat: joinRes.seat,
          reconnected: Boolean(joinRes.reconnected),
          room: roomManager.formatPublicRoomState(joinRes.room, ws._user.id)
        });

        broadcastRoom(joinRes.room, {
          type: joinRes.reconnected ? 'PLAYER_RECONNECTED' : 'PLAYER_JOINED',
          userId: ws._user.id,
          name: ws._user.first_name,
          role: joinRes.role,
          seat: joinRes.seat
        });
        return;
      }

      if (!ws._user || !ws._roomId) {
        ws.sendJSON({ type: 'ERROR', code: 'UNAUTHORIZED', error: 'Must authenticate and join a room first.' });
        return;
      }

      if (type === 'LEAVE_ROOM') {
        const prevRoomId = ws._roomId;
        unsubscribeSocket(ws);
        ws._roomId = null;
        const leaveRes = await roomManager.leaveRoom(prevRoomId, ws._user.id);
        if (leaveRes.ok && leaveRes.room && leaveRes.room.status !== 'expired') {
          broadcastRoom(leaveRes.room, {
            type: 'PLAYER_LEFT',
            userId: ws._user.id
          });
        }
        ws.sendJSON({ type: 'ROOM_LEFT', roomId: prevRoomId });
        return;
      }

      if (type === 'ADD_BOT') {
        const res = await roomManager.addBotToRoom(ws._roomId, ws._user.id);
        if (!res.ok) {
          ws.sendJSON({ type: 'ERROR', code: res.code, error: res.error });
          return;
        }
        broadcastRoom(res.room, { type: 'BOT_ADDED' });
        return;
      }

      if (type === 'START_GAME') {
        const res = await roomManager.startGame(ws._roomId, ws._user.id);
        if (!res.ok) {
          ws.sendJSON({ type: 'ERROR', code: res.code, error: res.error });
          return;
        }
        broadcastRoom(res.room, res.event);
        return;
      }

      if (type === 'REQUEST_REMATCH') {
        const res = await roomManager.requestRematch(ws._roomId, ws._user.id);
        if (!res.ok) {
          ws.sendJSON({ type: 'ERROR', code: res.code, error: res.error });
          return;
        }
        broadcastRoom(res.room, res.event);
        return;
      }

      if (type === 'FORCE_REMATCH') {
        const res = await roomManager.forceRematchByHost(ws._roomId, ws._user.id);
        if (!res.ok) {
          ws.sendJSON({ type: 'ERROR', code: res.code, error: res.error });
          return;
        }
        broadcastRoom(res.room, res.event);
        return;
      }

      const validMoves = [
        'PLAY_CARD', 'DRAW_CARD', 'PASS_TURN', 'CALL_UNO',
        'CATCH_UNO', 'ACCEPT_WILD4', 'CHALLENGE_WILD4', 'EMOJI'
      ];
      if (validMoves.includes(type)) {
        const res = await roomManager.handleGameAction(ws._roomId, ws._user.id, msg);
        if (!res.ok) {
          ws.sendJSON({ type: 'ERROR', code: res.code, error: res.error });
          return;
        }
        broadcastRoom(res.room, res.event);
        return;
      }

      ws.sendJSON({ type: 'ERROR', code: 'UNKNOWN_COMMAND', error: `Unsupported command: ${type}` });
    });

    ws.on('close', async () => {
      const roomId = ws._roomId;
      const user = ws._user;
      unsubscribeSocket(ws);
      if (roomId && user) {
        const subs = roomSubscriptions.get(roomId);
        const stillConnected = subs && Array.from(subs).some(s => s.user && s.user.id === user.id);
        if (!stillConnected) {
          const updatedRoom = await roomManager.handleDisconnect(roomId, user.id);
          if (updatedRoom) {
            broadcastRoom(updatedRoom, {
              type: 'PLAYER_DISCONNECTED',
              userId: user.id
            });
          }
        }
      }
    });
  });

  const cleanupTimer = setInterval(() => {
    roomManager.cleanupExpiredRooms().catch(() => {});
  }, 60000);
  if (cleanupTimer.unref) cleanupTimer.unref();

  let isStopped = false;

  return {
    config: opts,
    httpServer,
    wss,
    db,
    roomManager,
    botController,
    authenticateRequestUser,
    async start(customPort) {
      await db.init();
      const listenPort = customPort !== undefined ? customPort : opts.port;
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(listenPort, () => {
          const addr = httpServer.address();
          const boundPort = addr ? addr.port : listenPort;
          if (opts.logger && typeof opts.logger.info === 'function') {
            const target = db.providerInfo ? db.providerInfo.target : db.mode;
            opts.logger.info(
              `[Matcho Server] Ready on port ${boundPort} (env=${opts.nodeEnv}, db=${db.mode}, target=${redactDatabaseUri(target)})`
            );
          }
          resolve(boundPort);
        });
      });
    },
    async stop() {
      if (isStopped) return;
      isStopped = true;
      clearInterval(cleanupTimer);
      roomManager.clearAllTimers();
      wss.close();
      await new Promise(resolve => {
        if (!httpServer.listening) return resolve();
        httpServer.close(() => resolve());
      });
      await db.close();
    }
  };
}

if (require.main === module) {
  process.on('unhandledRejection', (reason) => {
    console.error('[UNO Royale Server] Unhandled promise rejection:', reason && reason.message ? reason.message : reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[UNO Royale Server] Uncaught exception:', err && err.message ? err.message : err);
  });

  try {
    const srv = createUnoServer();
    srv.start().then((port) => {
      console.log(`[UNO Royale Server] Listening on http://localhost:${port} (mode=${srv.config.nodeEnv}, db=${srv.db.mode})`);
      const shutdown = async (sig) => {
        console.log(`[UNO Royale Server] Received ${sig}, shutting down gracefully...`);
        await srv.stop();
        process.exit(0);
      };
      process.once('SIGINT', () => shutdown('SIGINT'));
      process.once('SIGTERM', () => shutdown('SIGTERM'));
    }).catch((err) => {
      console.error('[UNO Royale Server] Failed to start:', err.message);
      process.exit(1);
    });
  } catch (configErr) {
    console.error('[UNO Royale Server] Startup configuration error:', configErr.message);
    process.exit(1);
  }
}

module.exports = {
  createUnoServer,
  validateServerConfig,
  buildTrustedOriginsSet,
  normalizeOrigin
};
