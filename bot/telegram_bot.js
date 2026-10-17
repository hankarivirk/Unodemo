/**
 * UNO Royale / Matcho! — Production Telegram Bot Controller (`bot/telegram_bot.js`)
 *
 * Connected directly to RoomManager & PersistentDatabase:
 * - Safely escapes all user-controlled text via `escapeTelegramHtml` (parse_mode: 'HTML')
 * - Normalizes bot commands including `@botusername` suffixes (`/start@bot`, `/play@bot`, `/friend@bot`, `/solo@bot`, `/rules@bot`)
 * - Private DM `/start` provides clear interactive options:
 *   1. "🤝 Play with a Friend" (creates a 2-player room with shareable `https://t.me/<bot>/<app>?startapp=<token>` invite)
 *   2. "🤖 Play on Your Own" (launches playable practice match against Utya inside the Telegram Mini App WebView)
 *   3. "📖 How to Play / Rules" (displays concise UNO rules and quick-start buttons)
 * - Group & Inline mode (`@botusername`):
 *   - Reuses the host's unstarted 1-player unpublished waiting room (`findOrCreateInlineRoomForHost`) so typing
 *     `@botusername` never creates unlimited abandoned rooms, while retiring stale drafts and generating a fresh
 *     room whenever `Play Again` (`play` / `again` / `new`) is selected
 *   - Guarantees `answerInlineQuery` never returns an expired room (`cache_time: 0`, `is_personal: true`)
 *   - On `chosen_inline_result` (and `callback_query` fallback), calls `roomManager.markRoomPublished()`:
 *     - If the room is still active (`waiting`), marks it published, anchors the full 5-minute waiting-room timeout
 *       from publication time, and syncs the Telegram inline message (`inline_message_id`)
 *     - If the room ALREADY expired before publication (e.g. the user kept the inline popup open past the timeout
 *       or `chosen_inline_result` was delayed), associates `inline_message_id` with the expired room and immediately
 *       calls `editMessageText` to replace the published message with `⏳ Game Expired` and `🔄 Play Again` so it
 *       never remains indefinitely in a stale waiting state
 */
'use strict';

const https = require('node:https');
const crypto = require('node:crypto');
const {
  isValidBotTokenFormat,
  escapeTelegramHtml,
  createRoomInviteToken,
  parseStartParam,
  signSessionToken
} = require('../server/telegram_auth');

const LAUNCH_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

class TelegramBotController {
  constructor(roomManager, options) {
    this.roomManager = roomManager;
    const opts = options || {};
    this.botToken = opts.botToken !== undefined
      ? opts.botToken
      : (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '');
    this.botUsername = String(
      opts.botUsername || process.env.BOT_USERNAME || process.env.TELEGRAM_BOT_USERNAME || 'matcho_bot'
    ).replace(/^@/, '').trim() || 'matcho_bot';
    this.appShortName = String(
      opts.appShortName || process.env.APP_SHORT_NAME || process.env.TELEGRAM_APP_SHORT_NAME || 'play'
    ).replace(/[^A-Za-z0-9_-]/g, '').trim() || 'play';
    this.webAppUrl = opts.webAppUrl || process.env.PUBLIC_APP_URL || process.env.WEBAPP_URL || 'https://localhost:3000';
    this.sessionSecret = opts.sessionSecret || process.env.SESSION_SECRET || '';
    this.logger = opts.logger || console;
    this.apiCaller = opts.apiCaller || this._defaultTelegramApiCall.bind(this);
  }

  /**
   * Generate a canonical Telegram Mini App deep link:
   * `https://t.me/<bot_username>/<app_short_name>?startapp=<room_token>`
   */
  getDirectMiniAppLink(roomId, mode) {
    let token;
    try {
      token = createRoomInviteToken(roomId, mode === 'spectator' ? 'spectator' : 'player', this.sessionSecret);
    } catch (e) {
      const prefix = mode === 'spectator' ? 'spec_' : 'room_';
      token = `${prefix}${roomId}`;
    }
    if (this.botUsername && this.appShortName) {
      return `https://t.me/${this.botUsername}/${this.appShortName}?startapp=${token}`;
    }
    return this.getWebAppLaunchUrl(roomId, mode, null);
  }

  /**
   * Build a Telegram native share URL (`https://t.me/share/url?url=...&text=...`) wrapping the Mini App deep link.
   */
  getTelegramShareUrl(roomId, maxPlayers) {
    const deepLink = this.getDirectMiniAppLink(roomId, 'player');
    const label = maxPlayers === 2
      ? '🃏 Join my 1v1 Matcho! (UNO Royale) room!'
      : '🃏 Join my Matcho! (UNO Royale) game table!';
    return `https://t.me/share/url?url=${encodeURIComponent(deepLink)}&text=${encodeURIComponent(label)}`;
  }

  /**
   * Build the direct HTTPS WebApp URL (`web_app: { url }`) with `startapp=<room_token>`
   * and an optional short-lived, room-scoped `launch_token` bound to the authenticated Telegram user.
   */
  getWebAppLaunchUrl(roomId, mode, telegramUser, extraQuery) {
    let startParam = mode === 'practice' ? 'practice_utya' : '';
    if (!startParam && roomId) {
      try {
        startParam = createRoomInviteToken(roomId, mode === 'spectator' ? 'spectator' : 'player', this.sessionSecret);
      } catch (e) {
        const prefix = mode === 'spectator' ? 'spec_' : 'room_';
        startParam = `${prefix}${roomId}`;
      }
    }

    const sep = this.webAppUrl.includes('?') ? '&' : '?';
    let url = `${this.webAppUrl}${sep}startapp=${encodeURIComponent(startParam)}`;

    if (extraQuery && typeof extraQuery === 'object') {
      for (const [k, v] of Object.entries(extraQuery)) {
        if (v !== undefined && v !== null) {
          url += `&${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`;
        }
      }
    }

    if (telegramUser && telegramUser.id && this.sessionSecret) {
      try {
        const launchToken = signSessionToken({
          kind: 'launch',
          jti: crypto.randomBytes(8).toString('hex'),
          roomId: roomId || null,
          mode: mode || 'player',
          user: {
            id: String(telegramUser.id),
            first_name: String(telegramUser.first_name || telegramUser.name || 'Player').slice(0, 64),
            username: String(telegramUser.username || '').slice(0, 64)
          },
          startParam,
          exp: Date.now() + LAUNCH_TOKEN_TTL_MS
        }, this.sessionSecret);
        url += `&launch_token=${encodeURIComponent(launchToken)}`;
      } catch (e) {}
    }

    return url;
  }

  getPracticeWebAppUrl(telegramUser) {
    return this.getWebAppLaunchUrl(null, 'practice', telegramUser, { practice: '1' });
  }

  formatRulesHtmlMessage() {
    return (
      `📖 <b>Matcho! (UNO Royale) — How to Play &amp; Rules</b>\n\n` +
      `1️⃣ <b>Match Cards:</b> On your turn, drag a playable card from your hand onto the center discard pile (or tap to lift and tap again) if it matches the active <b>color</b>, <b>number</b>, or <b>symbol</b>.\n` +
      `2️⃣ <b>Action &amp; Wild Cards:</b>\n` +
      `• <b>⊘ Skip:</b> Skips the next player's turn.\n` +
      `• <b>⇄ Reverse:</b> Reverses direction (acts as Skip in 2-player games).\n` +
      `• <b>+2 Draw Two:</b> Next player draws 2 cards and loses their turn.\n` +
      `• <b>? Wild:</b> Choose the next active suit color.\n` +
      `• <b>+4 Wild Draw Four:</b> Choose the next suit color and make the next player draw 4 cards (can be challenged if played illegally).\n` +
      `3️⃣ <b>Draw Deck:</b> If you have no playable card, tap the center Draw Deck to draw 1 card.\n` +
      `4️⃣ <b>UNO! &amp; Victory:</b> Call <b>UNO!</b> when down to 1–2 cards before an opponent catches you (+2 penalty). First player to reach 0 cards wins!`
    );
  }

  formatRoomHtmlMessage(room) {
    const players = Array.isArray(room.players) ? room.players : [];
    const hostPlayer = players[0];
    const hostName = escapeTelegramHtml(hostPlayer ? hostPlayer.name : 'Host');
    const maxPlayers = room.max_players || 4;
    const remaining = Math.max(0, maxPlayers - players.length);
    const inviteLink = this.getDirectMiniAppLink(room.id, 'player');

    const playerLines = players.map((p) => {
      const safeName = escapeTelegramHtml(p.name);
      const safeUser = p.username ? ` (${escapeTelegramHtml(p.username)})` : '';
      const botTag = p.isBot ? ' 🤖' : '';
      const winBadge = p.wins > 0 ? ` • 🏆 ${p.wins}` : '';
      return `✅ <b>${safeName}</b>${safeUser}${botTag}${winBadge}`;
    }).join('\n');

    if (room.status === 'expired') {
      const expiryReason = players.length <= 1
        ? 'Nobody joined before the lobby timeout, so the lobby expired before the game started.'
        : `The lobby expired before the game was started (${players.length}/${maxPlayers} players had joined).`;

      return (
        `⏳ <b>Game Expired</b>\n` +
        `🎮 <b>UNO GROUP GAME</b>\n` +
        `Room ID: <code>${escapeTelegramHtml(room.id)}</code> (${players.length}/${maxPlayers})\n\n` +
        `👥 <b>Players joined (${players.length}/${maxPlayers})</b>\n` +
        `${playerLines || '—'}\n\n` +
        `<i>${escapeTelegramHtml(expiryReason)}</i>\n` +
        `Press <b>🔄 Play Again</b> below to start a new lobby in this chat.`
      );
    }

    const statusLine = room.status === 'playing'
      ? `🔥 <b>Match in progress!</b> (${players.length}/${maxPlayers} players)`
      : room.status === 'finished'
        ? `🏆 <b>Match finished!</b> Tap below to view scoreboard &amp; rematch.`
        : remaining > 0
          ? `⏳ Waiting for ${remaining} more ${remaining === 1 ? 'player' : 'players'}...\nJoin the game below!`
          : `✅ <b>All ${maxPlayers} seats full! Ready to start!</b>`;

    const specLine = room.spectators && room.spectators.length > 0
      ? `\n👁️ <b>Spectators (${room.spectators.length}):</b> ` +
        room.spectators.map(s => escapeTelegramHtml(s.name)).join(', ')
      : '';

    return (
      `🎮 <b>UNO GROUP GAME</b>\n` +
      `Hosted by <b>${hostName}</b> • <b>Matcho! (UNO Royale)</b>\n` +
      `Room ID: <code>${escapeTelegramHtml(room.id)}</code> (${players.length}/${maxPlayers})\n` +
      `Invite Link: ${escapeTelegramHtml(inviteLink)}\n\n` +
      `👥 <b>Players joined (${players.length}/${maxPlayers})</b>\n` +
      `${playerLines}\n\n` +
      `${statusLine}${specLine}`
    );
  }

  buildRoomInlineKeyboard(room, options) {
    const opts = options || {};
    const maxPlayers = room.max_players || 4;
    const rows = [];

    // Expired room: replace join/open actions with "🔄 Play Again" opening inline mode in the current chat
    if (room.status === 'expired') {
      const inlineQueryPrefill = maxPlayers === 2 ? '2p' : 'play';
      rows.push([
        {
          text: '🔄 Play Again',
          switch_inline_query_current_chat: inlineQueryPrefill
        }
      ]);
      return { inline_keyboard: rows };
    }

    if (room.status === 'waiting') {
      if (room.players.length < maxPlayers) {
        rows.push([
          { text: `✋ Join the game (${room.players.length}/${maxPlayers})`, callback_data: `join_${room.id}` },
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

    if (opts.isPrivateChat) {
      if (opts.includePrivateMenuOptions) {
        rows.push([
          { text: '🤝 Play with a Friend', callback_data: 'cmd_play_friend' },
          {
            text: '🤖 Play on Your Own',
            web_app: {
              url: this.getPracticeWebAppUrl(opts.telegramUser || null)
            }
          }
        ]);
        rows.push([
          { text: '📖 How to Play / Rules', callback_data: 'cmd_rules' },
          {
            text: '📤 Share Invite Link',
            url: this.getTelegramShareUrl(room.id, maxPlayers)
          }
        ]);
      } else {
        rows.push([
          {
            text: '📤 Share Invite Link',
            url: this.getTelegramShareUrl(room.id, maxPlayers)
          }
        ]);
      }
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
   * Parse a Telegram slash command (e.g. `/play@matcho_bot room_uno_123`), validating `@botusername` if present.
   */
  _parseBotCommand(text) {
    const match = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
    if (!match) return null;
    const command = match[1].toLowerCase();
    const targetBot = match[2] ? match[2].toLowerCase() : null;
    const args = (match[3] || '').trim();
    if (targetBot && this.botUsername && targetBot !== this.botUsername.toLowerCase()) {
      return null; // Addressed to a different bot in a group chat
    }
    return { command, args };
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
      const queryText = String(iq.query || '').trim().toLowerCase();
      const requestedMax = (
        queryText === '2p' ||
        queryText === 'friend' ||
        queryText === 'duel' ||
        queryText.includes('2p')
      ) ? 2 : 4;
      const forceNew = (
        queryText.includes('new') ||
        queryText.includes('again') ||
        queryText === 'play' ||
        queryText === '2p'
      );

      // Reuse an existing unstarted 1-player unpublished waiting room for this host so typing @botusername
      // does not create unlimited abandoned rooms in the database, while creating a fresh room on Play Again / new.
      let created = typeof this.roomManager.findOrCreateInlineRoomForHost === 'function'
        ? await this.roomManager.findOrCreateInlineRoomForHost(host, { maxPlayers: requestedMax, forceNew, isInlineDraft: true })
        : await this.roomManager.createRoom(host, { maxPlayers: requestedMax, isInlineDraft: true });
      let room = created.room;

      // Defensive guard: never return an expired room in answerInlineQuery
      if (!room || room.status !== 'waiting' || (typeof this.roomManager._isRoomPastExpiry === 'function' && this.roomManager._isRoomPastExpiry(room))) {
        created = await this.roomManager.createRoom(host, { maxPlayers: requestedMax, isInlineDraft: true });
        room = created.room;
      }

      const articleResult = {
        type: 'article',
        id: room.id,
        title: requestedMax === 2 ? '🤝 Matcho! — 2P Friend Duel' : '🎮 UNO GROUP GAME — 4P Table',
        description: requestedMax === 2
          ? 'Create a 1v1 UNO duel lobby in this chat (Host auto-seated)'
          : 'Create a 4-player UNO group lobby in this chat (Host auto-seated)',
        input_message_content: {
          message_text: this.formatRoomHtmlMessage(room),
          parse_mode: 'HTML'
        },
        reply_markup: this.buildRoomInlineKeyboard(room, { isPrivateChat: false, telegramUser: host })
      };

      return this.apiCaller('answerInlineQuery', {
        inline_query_id: iq.id,
        results: [articleResult],
        cache_time: 0,
        is_personal: true
      });
    }

    // 2. Chosen Inline Result: capture `inline_message_id` and transition room to published (or recover if already expired!)
    if (update.chosen_inline_result) {
      const cir = update.chosen_inline_result;
      const roomId = cir.result_id;
      if (roomId && cir.inline_message_id) {
        if (typeof this.roomManager.markRoomPublished === 'function') {
          const pubRes = await this.roomManager.markRoomPublished(roomId, {
            inline_message_id: cir.inline_message_id,
            from: cir.from,
            skipNotify: true
          });
          if (pubRes && pubRes.ok && pubRes.room) {
            await this.syncRoomTelegramMessage(pubRes.room);
          }
        } else {
          let updatedRoom = null;
          await this.roomManager.db.withTransaction(async (tx) => {
            const room = await tx.getRoom(roomId);
            if (room) {
              room.inline_message_id = cir.inline_message_id;
              room.is_published = true;
              room.published_at = room.published_at || Date.now();
              await tx.saveRoom(room);
              updatedRoom = room;
            }
          });
          if (updatedRoom) {
            await this.syncRoomTelegramMessage(updatedRoom);
          }
        }
      }
      return { ok: true };
    }

    // 3. Callback Query (`join_<roomId>`, `spec_<roomId>`, `cmd_play_friend`, `cmd_play_solo`, `cmd_rules`)
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = String(cb.data || '');
      const user = cb.from || { id: '0', first_name: 'Player' };
      const chatId = cb.message && cb.message.chat ? cb.message.chat.id : null;
      const isPrivateChat = Boolean(cb.message && cb.message.chat && cb.message.chat.type === 'private');

      if (data === 'cmd_rules') {
        await this.apiCaller('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: '📖 Opening Matcho! Rules & Quick Guide'
        });
        if (chatId !== null) {
          return this.apiCaller('sendMessage', {
            chat_id: chatId,
            text: this.formatRulesHtmlMessage(),
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '🤝 Play with a Friend', callback_data: 'cmd_play_friend' },
                  {
                    text: '🤖 Play on Your Own',
                    web_app: { url: this.getPracticeWebAppUrl(user) }
                  }
                ]
              ]
            }
          });
        }
        return { ok: true };
      }

      if (data === 'cmd_play_friend') {
        const created = await this.roomManager.createRoom(user, {
          maxPlayers: 2,
          roomMode: 'friend_2p',
          chat_id: chatId !== null ? String(chatId) : null
        });
        const room = created.room;
        await this.apiCaller('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: '🤝 2-Player room created! Share the invite with your friend.'
        });
        if (chatId !== null) {
          const sent = await this.apiCaller('sendMessage', {
            chat_id: chatId,
            text: this.formatRoomHtmlMessage(room),
            parse_mode: 'HTML',
            reply_markup: this.buildRoomInlineKeyboard(room, {
              isPrivateChat,
              telegramUser: user,
              includePrivateMenuOptions: false
            })
          });
          if (sent && sent.result && sent.result.message_id) {
            await this.roomManager.db.withTransaction(async (tx) => {
              const r = await tx.getRoom(room.id);
              if (r) {
                r.chat_id = String(chatId);
                r.message_id = String(sent.result.message_id);
                r.is_published = true;
                r.published_at = r.published_at || Date.now();
                await tx.saveRoom(r);
              }
            });
          }
          return sent;
        }
        return { ok: true, room };
      }

      if (data === 'cmd_play_solo') {
        await this.apiCaller('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: '🤖 Tap "Launch Practice vs Utya" below to play!'
        });
        if (chatId !== null) {
          return this.apiCaller('sendMessage', {
            chat_id: chatId,
            text: (
              `🤖 <b>Solo Practice Mode (vs AI Bot Utya)</b>\n` +
              `Tap below to launch a single-player practice game against the AI bot <b>Utya</b> inside the Matcho! Mini App.\n` +
              `<i>(When connected to the server via Telegram, moves are validated server-side against Utya; if opened offline, local browser practice mode is used.)</i>`
            ),
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🎮 Launch Practice vs Utya',
                    web_app: { url: this.getPracticeWebAppUrl(user) }
                  }
                ]
              ]
            }
          });
        }
        return { ok: true };
      }

      const match = /^(join|spec)_(uno_[a-zA-Z0-9_-]+)$/.exec(data);
      if (!match) {
        return this.apiCaller('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: 'Unknown action.'
        });
      }

      const mode = match[1] === 'spec' ? 'spectator' : 'player';
      const roomId = match[2];

      // Associate `inline_message_id` or `chat_id` + `message_id` from the callback query (even if the room already expired!)
      if (cb.inline_message_id || (cb.message && cb.message.chat && cb.message.message_id)) {
        const pubMeta = {
          inline_message_id: cb.inline_message_id || null,
          chat_id: (cb.message && cb.message.chat) ? String(cb.message.chat.id) : null,
          message_id: (cb.message && cb.message.message_id) ? String(cb.message.message_id) : null,
          from: cb.from,
          skipNotify: true
        };
        if (typeof this.roomManager.markRoomPublished === 'function') {
          const pubRes = await this.roomManager.markRoomPublished(roomId, pubMeta);
          if (pubRes && pubRes.expiredBeforePublication && pubRes.room) {
            await this.syncRoomTelegramMessage(pubRes.room);
            return this.apiCaller('answerCallbackQuery', {
              callback_query_id: cb.id,
              text: '⏳ This lobby has expired. Tap "🔄 Play Again" to start a new game.',
              show_alert: true
            });
          }
        } else {
          await this.roomManager.db.withTransaction(async (tx) => {
            const r = await tx.getRoom(roomId);
            if (r) {
              if (cb.inline_message_id && !r.inline_message_id) {
                r.inline_message_id = cb.inline_message_id;
              } else if (cb.message && cb.message.chat && cb.message.message_id && !r.message_id) {
                r.chat_id = String(cb.message.chat.id);
                r.message_id = String(cb.message.message_id);
              }
              r.is_published = true;
              r.published_at = r.published_at || Date.now();
              await tx.saveRoom(r);
            }
          });
        }
      }

      const joinRes = await this.roomManager.joinRoom(roomId, user, mode);
      if (!joinRes.ok) {
        if (joinRes.code === 'ROOM_EXPIRED') {
          const expRoom = joinRes.room || await this.roomManager.db.withTransaction(tx => tx.getRoom(roomId));
          if (expRoom) await this.syncRoomTelegramMessage(expRoom);
        }
        return this.apiCaller('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: joinRes.error || 'Could not join room.',
          show_alert: true
        });
      }

      await this.syncRoomTelegramMessage(joinRes.room);
      const maxP = joinRes.room.max_players || 4;

      return this.apiCaller('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: mode === 'spectator'
          ? '👁️ Joined as Spectator! Tap "Open Matcho! Room" to watch.'
          : (joinRes.reconnected
              ? `✅ You are already seated in Seat ${joinRes.seat + 1} (${joinRes.room.players.length}/${maxP})!`
              : `🃏 Joined Seat ${joinRes.seat + 1} (${joinRes.room.players.length}/${maxP})!`)
      });
    }

    // 4. Standard Chat Message (`/start`, `/play`, `/friend`, `/solo`, `/rules`, `/help`)
    if (update.message && update.message.text) {
      const msg = update.message;
      const parsedCmd = this._parseBotCommand(msg.text);
      if (!parsedCmd) return { ok: true };

      const { command, args } = parsedCmd;
      const user = msg.from || { id: '0', first_name: 'Player' };
      const isPrivateChat = Boolean(msg.chat && msg.chat.type === 'private');

      if (command === 'rules' || command === 'help') {
        return this.apiCaller('sendMessage', {
          chat_id: msg.chat.id,
          text: this.formatRulesHtmlMessage(),
          parse_mode: 'HTML',
          reply_markup: isPrivateChat ? {
            inline_keyboard: [
              [
                { text: '🤝 Play with a Friend', callback_data: 'cmd_play_friend' },
                { text: '🤖 Play on Your Own', web_app: { url: this.getPracticeWebAppUrl(user) } }
              ]
            ]
          } : undefined
        });
      }

      if (command === 'solo' || (command === 'start' && (args === 'practice' || args === 'practice_utya' || args === 'solo'))) {
        return this.apiCaller('sendMessage', {
          chat_id: msg.chat.id,
          text: (
            `🤖 <b>Solo Practice Mode (vs AI Bot Utya)</b>\n` +
            `Tap below to launch a single-player practice game against the AI bot <b>Utya</b>!\n` +
            `<i>(Uses server-backed AI practice when launched inside Telegram, or local browser practice mode when offline.)</i>`
          ),
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                isPrivateChat
                  ? { text: '🎮 Play on Your Own (vs Utya)', web_app: { url: this.getPracticeWebAppUrl(user) } }
                  : { text: '🎮 Play on Your Own (vs Utya)', url: `https://t.me/${this.botUsername}/${this.appShortName}?startapp=practice_utya` }
              ]
            ]
          }
        });
      }

      if (command === 'start' || command === 'play' || command === 'friend') {
        const parsed = args ? parseStartParam(args, this.sessionSecret) : { valid: false };
        const maxPlayers = command === 'friend' ? 2 : 4;

        let room;
        if (parsed.valid && parsed.roomId) {
          const joinRes = await this.roomManager.joinRoom(parsed.roomId, user, parsed.mode || 'player', {
            createIfMissing: Boolean(parsed.isOpaqueInvite)
          });
          if (joinRes.ok) {
            room = joinRes.room;
          } else {
            const existing = await this.roomManager.getRoom(parsed.roomId);
            if (existing.ok) room = existing.room;
          }
        }
        if (!room) {
          const created = await this.roomManager.createRoom(user, {
            chat_id: String(msg.chat.id),
            maxPlayers
          });
          room = created.room;
        }

        const sent = await this.apiCaller('sendMessage', {
          chat_id: msg.chat.id,
          text: this.formatRoomHtmlMessage(room),
          parse_mode: 'HTML',
          reply_markup: this.buildRoomInlineKeyboard(room, {
            isPrivateChat,
            telegramUser: user,
            includePrivateMenuOptions: isPrivateChat && command === 'start' && !args
          })
        });

        if (sent && sent.result && sent.result.message_id) {
          await this.roomManager.db.withTransaction(async (tx) => {
            const r = await tx.getRoom(room.id);
            if (r) {
              r.chat_id = String(msg.chat.id);
              r.message_id = String(sent.result.message_id);
              r.is_published = true;
              r.published_at = r.published_at || Date.now();
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
   * Programmatically register bot commands (`/setcommands`) and optional webhook with Telegram Bot API.
   */
  async syncBotCommandsAndWebhook(webhookUrl, webhookSecret) {
    const commands = [
      { command: 'start', description: 'Launch Matcho! menu (Play with a Friend, Solo vs Utya, Rules)' },
      { command: 'play', description: 'Create a 4-player Matcho! room' },
      { command: 'friend', description: 'Create a 2-player friend duel room' },
      { command: 'solo', description: 'Play on your own against Utya (AI Bot)' },
      { command: 'rules', description: 'View Matcho! rules and quick guide' }
    ];
    await this.apiCaller('setMyCommands', { commands });
    if (webhookUrl) {
      await this.apiCaller('setWebhook', {
        url: webhookUrl,
        secret_token: webhookSecret || undefined,
        allowed_updates: ['message', 'inline_query', 'chosen_inline_result', 'callback_query']
      });
    }
    return { ok: true };
  }

  /**
   * Synchronize the Telegram chat message whenever room state changes in the Mini App, on join, or on expiration.
   * Handles benign Telegram edit failures (such as "message is not modified") gracefully without throwing.
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
      // Ignore benign Telegram "message is not modified" responses while logging genuine errors
      if (err && err.description && /message is not modified/i.test(String(err.description))) {
        return;
      }
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
