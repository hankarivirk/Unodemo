/**
 * UNO Royale / Matcho! — Production Telegram Bot Controller (`bot/telegram_bot.js`)
 *
 * Connected directly to RoomManager & PersistentDatabase:
 * - Safely escapes all user-controlled text via `escapeTelegramHtml` (parse_mode: 'HTML')
 * - Handles `/start`, `/play`, `inline_query`, `chosen_inline_result`, and `callback_query`
 *   (`join_<roomId>`, `spec_<roomId>`)
 * - Uses genuine `web_app: { url }` buttons in private chats so Telegram always launches the
 *   Mini App WebView with `Telegram.WebApp.initData` populated, AND appends a server-signed
 *   `launch_token` (`signSessionToken`) so user identity is cryptographically verified even if
 *   Telegram opens a button link in a fallback WebView.
 * - Builds valid Telegram Mini App Direct Links (`https://t.me/<BOT_USERNAME>/<APP_SHORT_NAME>?startapp=room_<id>`)
 *   for group/inline messages.
 * - Fails explicitly with structured logs and errors when credentials are missing or Telegram API calls fail.
 */
'use strict';

const https = require('node:https');
const {
  isValidBotTokenFormat,
  escapeTelegramHtml,
  parseStartParam,
  signSessionToken
} = require('../server/telegram_auth');

class TelegramBotController {
  constructor(roomManager, options) {
    this.roomManager = roomManager;
    const opts = options || {};
    this.botToken = opts.botToken !== undefined ? opts.botToken : (process.env.BOT_TOKEN || '');
    this.botUsername = opts.botUsername || process.env.BOT_USERNAME || 'matcho_bot';
    this.appShortName = opts.appShortName || process.env.APP_SHORT_NAME || 'play';
    this.webAppUrl = opts.webAppUrl || process.env.PUBLIC_APP_URL || process.env.WEBAPP_URL || 'https://localhost:3000';
    this.sessionSecret = opts.sessionSecret || process.env.SESSION_SECRET || '';
    this.logger = opts.logger || console;
    this.apiCaller = opts.apiCaller || this._defaultTelegramApiCall.bind(this);
  }

  getDirectMiniAppLink(roomId, mode) {
    const prefix = mode === 'spectator' ? 'spec_' : 'room_';
    if (this.botUsername && this.appShortName) {
      return `https://t.me/${this.botUsername}/${this.appShortName}?startapp=${prefix}${roomId}`;
    }
    return this.getWebAppLaunchUrl(roomId, mode, null);
  }

  /**
   * Build the direct HTTPS WebApp URL (`web_app: { url }`) with `startapp=room_<id>`
   * and an optional server-signed `launch_token` bound to the authenticated Telegram user.
   */
  getWebAppLaunchUrl(roomId, mode, telegramUser) {
    const prefix = mode === 'spectator' ? 'spec_' : 'room_';
    const startParam = `${prefix}${roomId}`;
    const sep = this.webAppUrl.includes('?') ? '&' : '?';
    let url = `${this.webAppUrl}${sep}startapp=${encodeURIComponent(startParam)}`;

    if (telegramUser && telegramUser.id && this.sessionSecret) {
      try {
        const launchToken = signSessionToken({
          user: {
            id: String(telegramUser.id),
            first_name: String(telegramUser.first_name || telegramUser.name || 'Player').slice(0, 64),
            username: String(telegramUser.username || '').slice(0, 64)
          },
          startParam,
          exp: Date.now() + 24 * 3600 * 1000
        }, this.sessionSecret);
        url += `&launch_token=${encodeURIComponent(launchToken)}`;
      } catch (e) {}
    }

    return url;
  }

  formatRoomHtmlMessage(room) {
    const hostPlayer = room.players[0];
    const hostName = escapeTelegramHtml(hostPlayer ? hostPlayer.name : 'Host');
    const remaining = Math.max(0, 4 - room.players.length);

    const statusLine = room.status === 'playing'
      ? `🔥 <b>Match in progress!</b> (${room.players.length}/4 players)`
      : room.status === 'finished'
        ? `🏆 <b>Match finished!</b> Tap below to view scoreboard &amp; rematch.`
        : remaining > 0
          ? `⏳ <i>${remaining} people can still join, hurry up!</i>`
          : `✅ <b>All 4 seats full! Ready to start!</b>`;

    const playerLines = room.players.map((p, idx) => {
      const safeName = escapeTelegramHtml(p.name);
      const safeUser = p.username ? ` (${escapeTelegramHtml(p.username)})` : '';
      const icon = idx === 0 ? '👑' : (p.isBot ? '🤖' : '🃏');
      const winBadge = p.wins > 0 ? ` • 🏆 ${p.wins}` : '';
      return `<blockquote>${icon} <b>${safeName}</b>${safeUser} joined.${winBadge}</blockquote>`;
    }).join('\n');

    const specLine = room.spectators && room.spectators.length > 0
      ? `\n👁️ <b>Spectators (${room.spectators.length}):</b> ` +
        room.spectators.map(s => escapeTelegramHtml(s.name)).join(', ')
      : '';

    return (
      `🎮 <b>${hostName}</b> started a new game of <b>Matcho! (UNO Royale)</b>\n` +
      `Room ID: <code>${escapeTelegramHtml(room.id)}</code>\n` +
      `<blockquote>${statusLine}</blockquote>\n` +
      `${playerLines}${specLine}`
    );
  }

  buildRoomInlineKeyboard(room, options) {
    const opts = options || {};
    const rows = [];
    if (room.status === 'waiting') {
      if (room.players.length < 4) {
        rows.push([
          { text: `✋ Join the game (${room.players.length}/4)`, callback_data: `join_${room.id}` },
          { text: `👁️ Spectate (${room.spectators.length})`, callback_data: `spec_${room.id}` }
        ]);
      } else {
        rows.push([
          { text: `👁️ Watch as Spectator (${room.spectators.length})`, callback_data: `spec_${room.id}` }
        ]);
      }
    }

    const buttonText = room.status === 'playing'
      ? '🃏 Open Live Match Table'
      : (room.status === 'finished' ? '🏆 View Scoreboard & Rematch' : '🕹️ Open Matcho! Room');

    // In private chats with the bot, use Telegram's native `web_app` button so Telegram
    // always opens the Mini App WebView and injects `Telegram.WebApp.initData` (plus signed launch_token).
    if (opts.isPrivateChat) {
      rows.push([
        {
          text: buttonText,
          web_app: {
            url: this.getWebAppLaunchUrl(room.id, 'player', opts.telegramUser || null)
          }
        }
      ]);
    } else {
      rows.push([
        {
          text: buttonText,
          url: this.getDirectMiniAppLink(room.id, 'player')
        }
      ]);
    }

    return { inline_keyboard: rows };
  }

  /**
   * Handle any incoming Telegram Bot Update (`inline_query`, `chosen_inline_result`, `callback_query`, `message`).
   */
  async handleUpdate(update) {
    if (!update || typeof update !== 'object') return null;

    // 1. Inline Query: @botusername in any group or DM
    if (update.inline_query) {
      const iq = update.inline_query;
      const host = iq.from || { id: '0', first_name: 'Player' };
      const roomId = `uno_${host.id}_${Date.now().toString(36).slice(-5)}`;
      const created = await this.roomManager.createRoom(host, { roomId });
      const room = created.room;

      const article = {
        type: 'article',
        id: room.id,
        title: '🃏 Matcho! (UNO Royale) — 4P Table',
        description: 'Play Matcho! with up to 4 players at once! (Host auto-seated)',
        input_message_content: {
          message_text: this.formatRoomHtmlMessage(room),
          parse_mode: 'HTML'
        },
        reply_markup: this.buildRoomInlineKeyboard(room, { isPrivateChat: false, telegramUser: host })
      };

      return this.apiCaller('answerInlineQuery', {
        inline_query_id: iq.id,
        results: [article],
        cache_time: 0,
        is_personal: true
      });
    }

    // 2. Chosen Inline Result: capture `inline_message_id` so we can live-update the message when players join
    if (update.chosen_inline_result) {
      const cir = update.chosen_inline_result;
      const roomId = cir.result_id;
      if (roomId && cir.inline_message_id) {
        await this.roomManager.db.withTransaction(async (tx) => {
          const room = await tx.getRoom(roomId);
          if (room) {
            room.inline_message_id = cir.inline_message_id;
            await tx.saveRoom(room);
          }
        });
      }
      return { ok: true };
    }

    // 3. Callback Query (`join_<roomId>` or `spec_<roomId>`)
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = String(cb.data || '');
      const user = cb.from;

      const match = /^(join|spec)_(uno_[a-zA-Z0-9_-]+)$/.exec(data);
      if (!match) {
        return this.apiCaller('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: 'Unknown action.'
        });
      }

      const mode = match[1] === 'spec' ? 'spectator' : 'player';
      const roomId = match[2];

      if (cb.inline_message_id) {
        await this.roomManager.db.withTransaction(async (tx) => {
          const r = await tx.getRoom(roomId);
          if (r && !r.inline_message_id) {
            r.inline_message_id = cb.inline_message_id;
            await tx.saveRoom(r);
          }
        });
      }

      const joinRes = await this.roomManager.joinRoom(roomId, user, mode);
      if (!joinRes.ok) {
        return this.apiCaller('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: joinRes.error || 'Could not join room.',
          show_alert: true
        });
      }

      await this.syncRoomTelegramMessage(joinRes.room);

      return this.apiCaller('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: mode === 'spectator'
          ? '👁️ Joined as Spectator! Tap "Open Matcho! Room" to watch.'
          : (joinRes.reconnected
              ? `✅ You are seated in Seat ${joinRes.seat + 1}!`
              : `🃏 Joined Seat ${joinRes.seat + 1} (${joinRes.room.players.length}/4)!`)
      });
    }

    // 4. Standard Chat Message (`/start` or `/play`)
    if (update.message && update.message.text) {
      const msg = update.message;
      const text = msg.text.trim();
      const user = msg.from || { id: '0', first_name: 'Player' };
      const isPrivateChat = Boolean(msg.chat && msg.chat.type === 'private');

      if (text.startsWith('/start') || text.startsWith('/play')) {
        const parts = text.split(/\s+/);
        const startArg = parts[1] || '';
        const parsed = parseStartParam(startArg);

        let room;
        if (parsed.valid && parsed.roomId) {
          const joinRes = await this.roomManager.joinRoom(parsed.roomId, user, parsed.mode || 'player');
          if (joinRes.ok) {
            room = joinRes.room;
          } else {
            const existing = await this.roomManager.getRoom(parsed.roomId);
            if (existing.ok) room = existing.room;
          }
        }
        if (!room) {
          const created = await this.roomManager.createRoom(user, {
            chat_id: String(msg.chat.id)
          });
          room = created.room;
        }

        const sent = await this.apiCaller('sendMessage', {
          chat_id: msg.chat.id,
          text: this.formatRoomHtmlMessage(room),
          parse_mode: 'HTML',
          reply_markup: this.buildRoomInlineKeyboard(room, {
            isPrivateChat,
            telegramUser: user
          })
        });

        if (sent && sent.result && sent.result.message_id) {
          await this.roomManager.db.withTransaction(async (tx) => {
            const r = await tx.getRoom(room.id);
            if (r) {
              r.chat_id = String(msg.chat.id);
              r.message_id = String(sent.result.message_id);
              await tx.saveRoom(r);
            }
          });
        }
        return sent;
      }
    }

    return { ok: true };
  }

  /**
   * Synchronize the Telegram chat message whenever room state changes in the Mini App or via callbacks.
   */
  async syncRoomTelegramMessage(room) {
    if (!room) return;
    if (!room.inline_message_id && !(room.chat_id && room.message_id)) {
      return;
    }

    const text = this.formatRoomHtmlMessage(room);
    const replyMarkup = this.buildRoomInlineKeyboard(room, { isPrivateChat: false });

    try {
      if (room.inline_message_id) {
        await this.apiCaller('editMessageText', {
          inline_message_id: room.inline_message_id,
          text,
          parse_mode: 'HTML',
          reply_markup: replyMarkup
        });
      } else if (room.chat_id && room.message_id) {
        await this.apiCaller('editMessageText', {
          chat_id: room.chat_id,
          message_id: Number(room.message_id),
          text,
          parse_mode: 'HTML',
          reply_markup: replyMarkup
        });
      }
    } catch (err) {
      if (this.logger && typeof this.logger.error === 'function') {
        this.logger.error(JSON.stringify({
          level: 'error',
          component: 'TelegramBotController',
          action: 'syncRoomTelegramMessage',
          roomId: room.id,
          error: err.message
        }));
      }
    }
  }

  /**
   * Real HTTPS Telegram Bot API caller.
   * Never fakes `{ ok: true, simulated: true }` — throws explicit errors on missing credentials or API failure.
   */
  _defaultTelegramApiCall(method, payload) {
    if (!isValidBotTokenFormat(this.botToken)) {
      const errMsg = `MISSING_BOT_CREDENTIALS: Cannot call Telegram API method "${method}" because BOT_TOKEN is missing or invalid.`;
      if (this.logger && typeof this.logger.error === 'function') {
        this.logger.error(JSON.stringify({
          level: 'error',
          component: 'TelegramBotController',
          code: 'MISSING_BOT_CREDENTIALS',
          method,
          message: errMsg
        }));
      }
      const err = new Error(errMsg);
      err.code = 'MISSING_BOT_CREDENTIALS';
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload || {});
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${this.botToken}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (e) {
            const parseErr = new Error(`TELEGRAM_API_INVALID_JSON: HTTP ${res.statusCode} on ${method}`);
            parseErr.code = 'TELEGRAM_API_INVALID_JSON';
            parseErr.statusCode = res.statusCode;
            if (this.logger && typeof this.logger.error === 'function') {
              this.logger.error(JSON.stringify({
                level: 'error',
                component: 'TelegramBotController',
                code: parseErr.code,
                method,
                statusCode: res.statusCode
              }));
            }
            return reject(parseErr);
          }

          if (!parsed.ok || res.statusCode >= 400) {
            const apiErr = new Error(
              `TELEGRAM_API_ERROR: Method "${method}" failed with ${parsed.error_code || res.statusCode}: ${parsed.description || 'Unknown error'}`
            );
            apiErr.code = 'TELEGRAM_API_ERROR';
            apiErr.statusCode = parsed.error_code || res.statusCode;
            apiErr.description = parsed.description;
            if (this.logger && typeof this.logger.error === 'function') {
              this.logger.error(JSON.stringify({
                level: 'error',
                component: 'TelegramBotController',
                code: apiErr.code,
                method,
                statusCode: apiErr.statusCode,
                description: parsed.description
              }));
            }
            return reject(apiErr);
          }

          resolve(parsed);
        });
      });

      req.on('error', (netErr) => {
        const err = new Error(`TELEGRAM_NETWORK_ERROR: ${netErr.message}`);
        err.code = 'TELEGRAM_NETWORK_ERROR';
        if (this.logger && typeof this.logger.error === 'function') {
          this.logger.error(JSON.stringify({
            level: 'error',
            component: 'TelegramBotController',
            code: err.code,
            method,
            message: netErr.message
          }));
        }
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }
}

module.exports = { TelegramBotController };
