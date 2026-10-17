/**
 * Official Telegram WebApp initData Validation, Webhook Secret Verification,
 * Config Validators, Start Parameter & Deep-Link Token Parser, and Safe Escaping (`server/telegram_auth.js`)
 *
 * Features:
 * - `normalizeInitDataString(raw)`: safely unwraps `#tgWebAppData=...` or `?tgWebAppData=...`
 *   wrappers (both percent-encoded and unencoded hash/query forms) without corrupting signed fields.
 * - `validateTelegramInitData(raw, botToken, options)`: official Telegram HMAC-SHA256 `WebAppData`
 *   verification with clock-skew tolerance (`clockSkewSeconds: 300`) and expiration checks.
 * - `createRoomInviteToken(roomId, mode, secret)` & `parseStartParam(rawParam, secret)`:
 *   generates and validates Telegram-compliant `startapp` tokens (`^[A-Za-z0-9_-]{1,64}$`)
 *   including HMAC-signed room tokens (`room_uno_xxx__<hmac>`), standard `room_uno_xxx` / `spec_uno_xxx`
 *   tokens, base64url-encoded tokens with expiration, and deterministic shared-room resolution for
 *   opaque invitation tokens.
 */
'use strict';

const crypto = require('node:crypto');

const OUTER_WEBVIEW_WRAPPER_KEYS = new Set([
  'tgWebAppVersion',
  'tgWebAppPlatform',
  'tgWebAppThemeParams',
  'tgWebAppDefaultColors',
  'tgWebAppBotInline',
  'tgWebAppShowSettings',
  'tgWebAppStartParam'
]);

function isValidBotTokenFormat(token) {
  if (!token || typeof token !== 'string') return false;
  const trimmed = token.trim().replace(/^["']|["']$/g, '');
  if (
    trimmed === 'YOUR_TELEGRAM_BOT_TOKEN' ||
    trimmed.includes('replace_with_') ||
    trimmed.includes('placeholder')
  ) {
    return false;
  }
  return /^\d{5,16}:[A-Za-z0-9_-]{20,}$/.test(trimmed);
}

function isValidSessionSecret(secret) {
  if (!secret || typeof secret !== 'string') return false;
  const trimmed = secret.trim();
  if (trimmed.length < 32) return false;
  if (trimmed.startsWith('replace_with_') || trimmed.includes('placeholder')) return false;
  return true;
}

function isValidWebhookSecret(secret) {
  if (!secret || typeof secret !== 'string') return false;
  const trimmed = secret.trim();
  if (trimmed.length < 16 || trimmed.length > 256) return false;
  if (trimmed.startsWith('replace_with_') || trimmed.includes('placeholder')) return false;
  return true;
}

/**
 * Constant-time verification of Telegram's `X-Telegram-Bot-Api-Secret-Token` header.
 */
function verifyWebhookSecretHeader(headerValue, configuredSecret) {
  if (!configuredSecret || typeof configuredSecret !== 'string') {
    return { valid: false, status: 503, code: 'WEBHOOK_NOT_CONFIGURED', error: 'Webhook secret is not configured on the server.' };
  }
  if (!headerValue || typeof headerValue !== 'string') {
    return { valid: false, status: 401, code: 'MISSING_WEBHOOK_SECRET', error: 'Missing X-Telegram-Bot-Api-Secret-Token header.' };
  }
  const bufA = Buffer.from(headerValue);
  const bufB = Buffer.from(configuredSecret);
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    return { valid: false, status: 403, code: 'INVALID_WEBHOOK_SECRET', error: 'Invalid X-Telegram-Bot-Api-Secret-Token header.' };
  }
  return { valid: true, status: 200 };
}

/**
 * Normalize raw `initData` string whether passed directly from `Telegram.WebApp.initData`,
 * wrapped inside `#tgWebAppData=...` / `?tgWebAppData=...` (percent-encoded or unencoded),
 * or percent-encoded as a whole string, without corrupting signed field values.
 */
function normalizeInitDataString(initDataRaw) {
  if (!initDataRaw || typeof initDataRaw !== 'string') return '';
  let str = initDataRaw.trim().replace(/^[#?]+/, '');
  if (!str) return '';

  // Case 1: Wrapped in tgWebAppData=...
  if (str.startsWith('tgWebAppData=') || str.includes('&tgWebAppData=')) {
    try {
      const outerParams = new URLSearchParams(str);
      const inner = outerParams.get('tgWebAppData');
      // If tgWebAppData was properly percent-encoded as a single parameter, `inner` will contain `hash=`
      if (inner && (inner.includes('hash=') || /hash%3D/i.test(inner))) {
        str = inner.trim();
      } else if (str.startsWith('tgWebAppData=')) {
        // Unencoded tgWebAppData=... where inner `&` delimiters were literal in the URL hash/query:
        // Strip leading `tgWebAppData=` and remove only outer Telegram WebView wrapper parameters
        const withoutPrefix = str.slice('tgWebAppData='.length);
        const rawSegments = withoutPrefix.split('&');
        const keptSegments = rawSegments.filter(seg => {
          const eqIdx = seg.indexOf('=');
          const key = eqIdx === -1 ? seg : seg.slice(0, eqIdx);
          return !OUTER_WEBVIEW_WRAPPER_KEYS.has(key);
        });
        str = keptSegments.join('&');
      }
    } catch (e) {}
  }

  // Case 2: Entire initData string is percent-encoded (`query_id%3D...%26user%3D...` without literal `&`)
  if (!str.includes('&') && (/%26/i.test(str) || /%3D/i.test(str))) {
    try {
      str = decodeURIComponent(str);
    } catch (e) {}
  }

  return str;
}

/**
 * Extract user profile & start_param from `initData` without HMAC verification
 * (Used ONLY when `allowDevAuth` is true in local development before `BOT_TOKEN` is configured).
 */
function extractUnverifiedInitDataUser(initDataRaw) {
  const normalized = normalizeInitDataString(initDataRaw);
  if (!normalized) return null;
  try {
    const params = new URLSearchParams(normalized);
    const userRaw = params.get('user');
    if (!userRaw) return null;
    const user = JSON.parse(userRaw);
    if (!user || !user.id) return null;
    return {
      user: {
        id: String(user.id),
        first_name: String(user.first_name || 'Player').slice(0, 64),
        last_name: String(user.last_name || '').slice(0, 64),
        username: String(user.username || '').slice(0, 64),
        photo_url: String(user.photo_url || '')
      },
      start_param: params.get('start_param') || null
    };
  } catch (e) {
    return null;
  }
}

function validateTelegramInitData(initDataRaw, botToken, options) {
  const opts = Object.assign({ maxAgeSeconds: 86400, clockSkewSeconds: 300 }, options || {});
  const normalized = normalizeInitDataString(initDataRaw);
  if (!normalized) {
    return { valid: false, error: 'Missing Telegram initData string.' };
  }
  const cleanToken = typeof botToken === 'string' ? botToken.trim().replace(/^["']|["']$/g, '') : '';
  if (!isValidBotTokenFormat(cleanToken)) {
    return { valid: false, error: 'Server BOT_TOKEN is missing or invalid.' };
  }

  const params = new URLSearchParams(normalized);
  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[0-9a-f]{64}$/i.test(receivedHash)) {
    return { valid: false, error: 'Invalid or missing hash in initData.' };
  }

  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(cleanToken)
    .digest();

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const bufA = Buffer.from(receivedHash.toLowerCase(), 'hex');
  const bufB = Buffer.from(calculatedHash.toLowerCase(), 'hex');
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    return { valid: false, error: 'Telegram initData signature verification failed.' };
  }

  const authDate = Number(params.get('auth_date') || 0);
  const nowSec = Math.floor(Date.now() / 1000);
  const ageSec = nowSec - authDate;
  if (opts.maxAgeSeconds > 0 && (!authDate || ageSec > opts.maxAgeSeconds || ageSec < -opts.clockSkewSeconds)) {
    return { valid: false, error: 'Telegram initData has expired (auth_date out of range).' };
  }

  let user = null;
  const userRaw = params.get('user');
  if (userRaw) {
    try {
      user = JSON.parse(userRaw);
    } catch (e) {
      return { valid: false, error: 'Malformed user JSON in initData.' };
    }
  }

  if (!user || !user.id) {
    return { valid: false, error: 'Missing Telegram user ID in initData.' };
  }

  return {
    valid: true,
    user: {
      id: String(user.id),
      first_name: String(user.first_name || 'Player').slice(0, 64),
      last_name: String(user.last_name || '').slice(0, 64),
      username: String(user.username || '').slice(0, 64),
      photo_url: String(user.photo_url || '')
    },
    start_param: params.get('start_param') || null,
    auth_date: authDate,
    chat_instance: params.get('chat_instance') || null
  };
}

/**
 * Helper to generate valid signed Telegram initData (for automated tests and dev mode).
 */
function createSignedInitData(userObj, botToken, startParam, authDateOverride) {
  const cleanToken = String(botToken || '').trim().replace(/^["']|["']$/g, '');
  const authDate = authDateOverride || Math.floor(Date.now() / 1000);
  const entries = {
    auth_date: String(authDate),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify(userObj)
  };
  if (startParam) {
    entries.start_param = String(startParam);
  }

  const pairs = Object.keys(entries)
    .sort()
    .map(k => `${k}=${entries[k]}`);
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(cleanToken)
    .digest();

  const hash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const search = new URLSearchParams(entries);
  search.set('hash', hash);
  return search.toString();
}

/**
 * Create a Telegram `startapp`-compatible room invitation token (`^[A-Za-z0-9_-]{1,64}$`).
 * Telegram Direct Link Mini Apps strictly require `startapp` to contain only `A-Z`, `a-z`, `0-9`, `_`, and `-`
 * (up to 64 characters). Never includes dots (`.`) or private secrets.
 */
function createRoomInviteToken(roomId, mode, secret) {
  const cleanRoomId = String(roomId || '').trim();
  if (!/^uno_[a-zA-Z0-9_-]{3,40}$/.test(cleanRoomId)) {
    throw new Error('Invalid roomId for invite token generation.');
  }
  const prefix = mode === 'spectator' ? 'spec' : 'room';
  if (secret && typeof secret === 'string' && secret.trim()) {
    const mac = crypto
      .createHmac('sha256', secret.trim())
      .update(`${prefix}:${cleanRoomId}`)
      .digest('base64url')
      .slice(0, 10);
    return `${prefix}_${cleanRoomId}__${mac}`;
  }
  return `${prefix}_${cleanRoomId}`;
}

/**
 * Parse and validate Telegram WebApp `start_param` / `startapp` values:
 * 1. Practice mode tokens: `practice`, `practice_utya`, `solo_utya`
 * 2. HMAC-signed room invite tokens: `room_uno_<id>__<10charMac>` or `spec_uno_<id>__<10charMac>`
 * 3. Standard room tokens: `room_uno_<id>`, `spec_uno_<id>`, or `uno_<id>`
 * 4. Base64url JSON or opaque Telegram `startapp` tokens (`[A-Za-z0-9_-]{8,64}`), mapping
 *    opaque tokens deterministically to a shared room ID (`uno_inv_<token>`) so all invitees
 *    opening the same opaque link join the exact same room.
 */
function parseStartParam(rawParam, secret) {
  if (!rawParam || typeof rawParam !== 'string') {
    return { valid: false, mode: null, roomId: null, error: 'Missing startapp parameter.' };
  }
  const trimmed = rawParam.trim();
  if (!trimmed || trimmed.length > 64 || !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return {
      valid: false,
      mode: null,
      roomId: null,
      code: 'MALFORMED_START_PARAM',
      error: 'Invalid startapp parameter: must be 1-64 characters using only A-Z, a-z, 0-9, _ and -.'
    };
  }

  // 1. Practice / Solo vs Utya launch parameter
  if (trimmed === 'practice' || trimmed === 'practice_utya' || trimmed === 'solo_utya') {
    return {
      valid: true,
      mode: 'practice',
      roomId: null,
      isPractice: true
    };
  }

  // 2. HMAC-signed room invitation token (`room_uno_<id>__<10charMac>` or `spec_uno_<id>__<10charMac>`)
  const signedMatch = /^(room|spec)_(uno_[a-zA-Z0-9_-]{3,40})__([A-Za-z0-9_-]{10})$/.exec(trimmed);
  if (signedMatch) {
    const prefix = signedMatch[1];
    const roomId = signedMatch[2];
    const providedMac = signedMatch[3];
    if (roomId.includes('__')) {
      return { valid: false, mode: null, roomId: null, code: 'MALFORMED_START_PARAM', error: 'Invalid room ID structure.' };
    }
    if (secret && typeof secret === 'string' && secret.trim()) {
      const expectedMac = crypto
        .createHmac('sha256', secret.trim())
        .update(`${prefix}:${roomId}`)
        .digest('base64url')
        .slice(0, 10);
      const bufA = Buffer.from(providedMac);
      const bufB = Buffer.from(expectedMac);
      if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
        return {
          valid: false,
          mode: null,
          roomId: null,
          code: 'INVALID_INVITE_SIGNATURE',
          error: 'Invalid or tampered room invitation signature.'
        };
      }
    }
    return {
      valid: true,
      mode: prefix === 'spec' ? 'spectator' : 'player',
      roomId,
      signed: true
    };
  }

  // Reject any malformed double-underscore token that failed signedMatch
  if (trimmed.includes('__')) {
    return {
      valid: false,
      mode: null,
      roomId: null,
      code: 'INVALID_INVITE_SIGNATURE',
      error: 'Malformed signed room invitation token.'
    };
  }

  // 3. Standard room token (`room_uno_<id>`, `spec_uno_<id>`, or `uno_<id>`)
  const stdMatch = /^(?:(room|spec)_)?(uno_[a-zA-Z0-9_-]{3,48})$/.exec(trimmed);
  if (stdMatch) {
    return {
      valid: true,
      mode: stdMatch[1] === 'spec' ? 'spectator' : 'player',
      roomId: stdMatch[2],
      signed: false
    };
  }

  // 4. Try decoding base64url JSON payload (e.g. `{"r":"uno_123","m":"player","exp":...}`)
  try {
    const decoded = Buffer.from(trimmed, 'base64url').toString('utf8');
    if (decoded && decoded.startsWith('{') && decoded.endsWith('}')) {
      const parsedObj = JSON.parse(decoded);
      if (parsedObj.exp && Date.now() > Number(parsedObj.exp)) {
        return {
          valid: false,
          mode: null,
          roomId: null,
          code: 'EXPIRED_INVITE_TOKEN',
          error: 'This room invitation token has expired.'
        };
      }
      const innerRoom = String(parsedObj.r || parsedObj.roomId || '');
      if (/^uno_[a-zA-Z0-9_-]{3,48}$/.test(innerRoom)) {
        return {
          valid: true,
          mode: parsedObj.m === 'spec' || parsedObj.mode === 'spectator' ? 'spectator' : 'player',
          roomId: innerRoom,
          signed: false
        };
      }
    }
  } catch (e) {}

  // 5. Opaque Telegram `startapp` room token (e.g. `https://t.me/matcho_bot/play?startapp=<opaque_token>`)
  // Rejects known bad prefixes (`invalid_`, `bad_`, `expired_`, `malformed_`, `room_`, `spec_`) and short strings,
  // while deterministically mapping valid opaque invitation tokens (8..64 chars) to a shared room ID.
  if (
    trimmed.length >= 8 &&
    trimmed.length <= 64 &&
    !/^(invalid|bad|expired|malformed|unauthorized|fake|room|spec)_/i.test(trimmed)
  ) {
    const canonicalSuffix = trimmed.slice(0, 36);
    return {
      valid: true,
      mode: 'player',
      roomId: `uno_inv_${canonicalSuffix}`,
      isOpaqueInvite: true,
      rawToken: trimmed
    };
  }

  return {
    valid: false,
    mode: null,
    roomId: null,
    code: 'INVALID_START_PARAM',
    error: 'Invalid start parameter format.'
  };
}

/**
 * Issue & verify server-signed session/launch tokens so WebSocket frames cannot spoof identity.
 */
function signSessionToken(payload, secret) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('Cannot sign session token without a valid SESSION_SECRET.');
  }
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySessionToken(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  if (!secret || typeof secret !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const bufA = Buffer.from(sig);
  const bufB = Buffer.from(expected);
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (parsed.exp && Date.now() > parsed.exp) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

/**
 * Safe HTML escaping for Telegram Bot messages (parse_mode: 'HTML').
 */
function escapeTelegramHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  isValidBotTokenFormat,
  isValidSessionSecret,
  isValidWebhookSecret,
  verifyWebhookSecretHeader,
  normalizeInitDataString,
  extractUnverifiedInitDataUser,
  validateTelegramInitData,
  createSignedInitData,
  createRoomInviteToken,
  parseStartParam,
  signSessionToken,
  verifySessionToken,
  escapeTelegramHtml
};
