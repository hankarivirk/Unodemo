/**
 * Official Telegram WebApp initData Validation, Webhook Secret Verification,
 * Config Validators, Start Parameter Parser & Safe Escaping (`server/telegram_auth.js`)
 *
 * Enhancements:
 * - `normalizeInitDataString(raw)`: safely unwraps `#tgWebAppData=...` or `?tgWebAppData=...`
 *   wrappers and decodes percent-encoded initData payloads so URL-hash or query-string
 *   fallbacks validate identically to `window.Telegram.WebApp.initData`.
 * - Clock-skew tolerance (`clockSkewSeconds: 300`) so minor mobile device clock drift does
 *   not cause false `auth_date` rejections.
 * - `extractUnverifiedInitDataUser(raw)`: extracts the Telegram user object from `initData`
 *   for local development (`ALLOW_DEV_AUTH=true`) when `BOT_TOKEN` is not yet configured.
 */
'use strict';

const crypto = require('node:crypto');

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
 * wrapped inside `#tgWebAppData=...` / `?tgWebAppData=...`, or percent-encoded.
 */
function normalizeInitDataString(initDataRaw) {
  if (!initDataRaw || typeof initDataRaw !== 'string') return '';
  let str = initDataRaw.trim().replace(/^[#?]+/, '');
  if (!str) return '';

  // If the full URL hash/search containing `tgWebAppData=` was passed, extract `tgWebAppData`
  if (str.startsWith('tgWebAppData=') || str.includes('&tgWebAppData=')) {
    try {
      const outerParams = new URLSearchParams(str);
      const inner = outerParams.get('tgWebAppData');
      if (inner) str = inner.trim();
    } catch (e) {}
  }

  // If percent-encoded (`query_id%3D...%26user%3D...` without literal `&`), decode once
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
 * Parse and validate Telegram WebApp start_param (e.g. "room_uno_12345" or "spec_uno_12345").
 */
function parseStartParam(rawParam) {
  if (!rawParam || typeof rawParam !== 'string') {
    return { valid: false, mode: null, roomId: null };
  }
  const trimmed = rawParam.trim();
  const match = /^(?:(room|spec)_)?(uno_[a-zA-Z0-9_-]{3,48})$/.exec(trimmed);
  if (!match) {
    return { valid: false, mode: null, roomId: null, error: 'Invalid start parameter format.' };
  }
  return {
    valid: true,
    mode: match[1] === 'spec' ? 'spectator' : 'player',
    roomId: match[2]
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
  const [data, sig] = token.split('.');
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
  parseStartParam,
  signSessionToken,
  verifySessionToken,
  escapeTelegramHtml
};
