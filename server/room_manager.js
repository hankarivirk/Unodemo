/**
 * Multiplayer Room & Match Lifecycle Manager (`server/room_manager.js`)
 *
 * Responsibilities:
 * - Create rooms with unique IDs (`uno_<random>`) and seat Host in Seat 0
 * - Support both 2-player ("Play with a Friend") and 4-player ("Group / Inline") room capacities (`max_players`)
 * - Track explicit room publication state (`is_published`, `published_at`, `inline_message_id`, `chat_id`, `message_id`)
 *   via `markRoomPublished()` so inline draft expiration and post-publication waiting-room timeouts behave consistently
 * - Configurable waiting-room timeout (default 5 minutes = 300,000 ms) that automatically marks unstarted
 *   lobbies as `expired`, edits the associated Telegram inline/group message to `⏳ Game Expired` with a
 *   `🔄 Play Again` button, and clears obsolete timers/subscriptions without ever terminating active games
 * - Recover safely when an already-expired inline result is chosen or when `chosen_inline_result` is delayed:
 *   always associates `inline_message_id` with the room and immediately updates the published Telegram message
 *   to `⏳ Game Expired` with `🔄 Play Again` so it never remains stuck in a stale waiting state
 * - Reuse unstarted 1-player unpublished inline waiting rooms per host (`findOrCreateInlineRoomForHost`)
 *   while retiring stale drafts and generating a genuinely fresh room on `Play Again`
 * - Validate room ownership, player membership, and spectator read-only restrictions
 * - Strictly separate real authenticated human players (`isBot: false`) from optional AI bots (`isBot: true`)
 * - Execute all state changes inside ACID database transactions (`db.withTransaction`)
 * - Handle player leaving (`leaveRoom`), disconnects, reconnects, and automatic host migration
 * - Manage synchronized rematch votes and Host Force Rematch
 * - Embed canonical Telegram Mini App deep links (`https://t.me/<bot>/<app>?startapp=<token>`) in public room state
 */
'use strict';

const crypto = require('node:crypto');
const UnoEngine = require('../shared/uno_engine');
const { createRoomInviteToken } = require('./telegram_auth');

const SEAT_COLORS = ['#475569', '#ff5c6c', '#8b5cf6', '#10b981'];
const DEFAULT_ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours for active/started matches
const DEFAULT_WAITING_ROOM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes default waiting-room timeout
const INLINE_REUSE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes reuse window for unpublished inline drafts

class RoomManager {
  constructor(db, options) {
    this.db = db;
    const rawOpts = options || {};
    const envWaitingTimeout = Number(process.env.WAITING_ROOM_TIMEOUT_MS || 0);
    const defaultWaitingMs = envWaitingTimeout > 0
      ? envWaitingTimeout
      : DEFAULT_WAITING_ROOM_TIMEOUT_MS;

    this.options = Object.assign({
      roomTtlMs: DEFAULT_ROOM_TTL_MS,
      waitingRoomTimeoutMs: rawOpts.waitingRoomTimeoutMs !== undefined
        ? Number(rawOpts.waitingRoomTimeoutMs)
        : defaultWaitingMs,
      onRoomUpdated: null,
      onRoomExpired: null,
      officialOpeningEffects: true,
      enableWild4Challenge: true,
      sessionSecret: '',
      botUsername: process.env.BOT_USERNAME || process.env.TELEGRAM_BOT_USERNAME || 'matcho_bot',
      appShortName: process.env.APP_SHORT_NAME || process.env.TELEGRAM_APP_SHORT_NAME || 'play'
    }, rawOpts);

    this.botTurnTimers = new Map();
    this.waitingExpiryTimers = new Map();
  }

  generateRoomId() {
    return 'uno_' + crypto.randomBytes(5).toString('hex');
  }

  _normalizeUser(user, idx, forceHuman) {
    const id = String(user.id);
    const name = String(user.first_name || user.name || 'Player').trim().slice(0, 48) || 'Player';
    const username = user.username
      ? (String(user.username).startsWith('@') ? String(user.username) : '@' + String(user.username))
      : '';
    const initials = String(user.initials || name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2) || 'PL').toUpperCase();
    const isBot = forceHuman ? false : Boolean(user.isBot);
    const isUtya = isBot && Boolean(user.isUtya || name === 'Utya');
    return {
      id,
      name,
      username,
      initials,
      color: user.color || (isUtya ? '#38bdf8' : SEAT_COLORS[(idx || 0) % SEAT_COLORS.length]),
      isBot,
      isUtya,
      connected: user.connected !== false,
      wins: Number(user.wins || 0),
      rematchReady: Boolean(user.rematchReady)
    };
  }

  _getWaitingTimeoutMs() {
    const ms = Number(this.options.waitingRoomTimeoutMs);
    return ms > 0 ? ms : DEFAULT_WAITING_ROOM_TIMEOUT_MS;
  }

  _isRoomPastExpiry(room, nowMs) {
    if (!room) return true;
    if (room.status === 'expired') return true;
    const now = nowMs !== undefined ? nowMs : Date.now();
    if (room.status === 'waiting' && room.waiting_expires_at && now > room.waiting_expires_at) {
      return true;
    }
    if (room.expires_at && now > room.expires_at) {
      return true;
    }
    return false;
  }

  async createRoom(hostUser, meta) {
    const metadata = meta || {};
    const roomId = metadata.roomId && /^uno_[a-zA-Z0-9_-]{3,48}$/.test(metadata.roomId)
      ? metadata.roomId
      : this.generateRoomId();
    const maxPlayers = metadata.maxPlayers === 2 ? 2 : 4;
    const waitingTimeoutMs = this._getWaitingTimeoutMs();
    const isInlineDraft = Boolean(metadata.isInlineDraft && !metadata.inline_message_id && !metadata.chat_id);

    const res = await this.db.withTransaction(async (tx) => {
      const existing = await tx.getRoom(roomId);
      const now = Date.now();
      if (existing && !this._isRoomPastExpiry(existing, now)) {
        return { ok: true, room: existing, alreadyExisted: true };
      }

      const dbHost = await tx.upsertPlayer({
        id: hostUser.id,
        first_name: hostUser.first_name || hostUser.name,
        username: hostUser.username || ''
      });

      const normalizedHost = this._normalizeUser(
        Object.assign({}, hostUser, { wins: dbHost.wins || 0 }),
        0,
        true // Host is always a real human user
      );
      normalizedHost.isHost = true;
      normalizedHost.seat = 0;

      const waitingExpiresAt = now + waitingTimeoutMs;
      const isPublished = !isInlineDraft;
      const room = {
        id: roomId,
        host_id: normalizedHost.id,
        status: 'waiting',
        max_players: maxPlayers,
        room_mode: metadata.roomMode || (maxPlayers === 2 ? 'friend_2p' : 'multiplayer_4p'),
        state_version: 1,
        is_published: isPublished,
        published_at: isPublished ? now : null,
        inline_message_id: metadata.inline_message_id || null,
        chat_id: metadata.chat_id || null,
        message_id: metadata.message_id || null,
        players: [normalizedHost],
        spectators: [],
        match_state: null,
        created_at: now,
        updated_at: now,
        waiting_expires_at: waitingExpiresAt,
        expires_at: waitingExpiresAt
      };

      await tx.saveRoom(room);
      this._notifyBotUpdate(room);
      return { ok: true, room };
    });

    if (res.ok && res.room && res.room.status === 'waiting') {
      this._scheduleWaitingExpiryTimer(res.room);
    }
    return res;
  }

  /**
   * Find an existing unstarted 1-player unpublished inline waiting room for this host created within the
   * reuse window so typing `@botusername` in Telegram does not create unlimited abandoned rooms on every
   * keystroke.
   * - Never reuses expired rooms or rooms that were already published (`is_published`, `inline_message_id`, or `chat_id`).
   * - When `meta.forceNew` is true (e.g. `🔄 Play Again`), retires any existing unpublished draft for this host
   *   so it does not linger as an abandoned room, and creates a genuinely fresh room ID and lifecycle.
   */
  async findOrCreateInlineRoomForHost(hostUser, meta) {
    const metadata = Object.assign({ isInlineDraft: true }, meta || {});
    const hostId = String(hostUser.id);
    const maxPlayers = metadata.maxPlayers === 2 ? 2 : 4;
    const waitingTimeoutMs = this._getWaitingTimeoutMs();
    const reuseWindow = Math.min(INLINE_REUSE_WINDOW_MS, waitingTimeoutMs);

    const txOutcome = await this.db.withTransaction(async (tx) => {
      const activeRooms = await tx.listActiveRooms();
      const now = Date.now();
      const clearedTimers = [];
      let reusable = null;

      for (const r of activeRooms) {
        if (String(r.host_id) !== hostId) continue;
        const isUnpublishedDraft = (
          !r.is_published &&
          !r.inline_message_id &&
          !r.chat_id &&
          Array.isArray(r.players) &&
          r.players.length === 1 &&
          r.players[0].id === hostId
        );
        if (!isUnpublishedDraft) continue;

        // If the draft is already past expiry, or if forceNew is requested for this mode, retire the draft cleanly
        if (this._isRoomPastExpiry(r, now) || (metadata.forceNew && (r.max_players || 4) === maxPlayers)) {
          if (r.status !== 'expired') {
            r.status = 'expired';
            r.expired_at = now;
            r.updated_at = now;
            r.state_version++;
            await tx.saveRoom(r);
          }
          clearedTimers.push(r.id);
          continue;
        }

        if (
          !metadata.forceNew &&
          !reusable &&
          r.status === 'waiting' &&
          (r.max_players || 4) === maxPlayers &&
          (now - (r.created_at || 0)) <= reuseWindow
        ) {
          reusable = r;
        }
      }

      if (reusable) {
        reusable.updated_at = now;
        reusable.waiting_expires_at = now + waitingTimeoutMs;
        reusable.expires_at = now + waitingTimeoutMs;
        await tx.saveRoom(reusable);
      }

      return { reusable, clearedTimers };
    });

    for (const oldId of txOutcome.clearedTimers) {
      this._clearWaitingExpiryTimer(oldId);
      this._clearBotTimer(oldId);
    }

    if (txOutcome.reusable) {
      this._scheduleWaitingExpiryTimer(txOutcome.reusable);
      return { ok: true, room: txOutcome.reusable, reused: true };
    }
    return this.createRoom(hostUser, metadata);
  }

  /**
   * Associate a room with its published Telegram inline message (`inline_message_id`) or chat message (`chat_id` + `message_id`),
   * and handle the publication/expiration lifecycle atomically:
   * - If the room is still in `'waiting'` and not expired: marks `is_published = true`, sets `published_at = now`,
   *   starts/refreshes the full 5-minute waiting-room timeout from publication time, and syncs the Telegram message.
   * - If the room ALREADY expired before publication (or before a delayed `chosen_inline_result` arrived):
   *   still records `inline_message_id` on the expired room and immediately triggers `onRoomUpdated` so the bot
   *   edits the published message to `⏳ Game Expired` with `🔄 Play Again` (never leaving a stale waiting card in chat).
   */
  async markRoomPublished(roomId, pubMeta) {
    const meta = pubMeta || {};
    const waitingTimeoutMs = this._getWaitingTimeoutMs();

    const txRes = await this.db.withTransaction(async (tx) => {
      let room = await tx.getRoom(roomId);
      const now = Date.now();

      if (!room) {
        if (!meta.inline_message_id && !(meta.chat_id && meta.message_id)) {
          return { ok: false, code: 'ROOM_NOT_FOUND', error: 'Room not found.' };
        }
        // Synthesize an expired room record if an unknown/pruned inline result was chosen so we can still replace its stale buttons
        const fallbackHost = meta.from
          ? this._normalizeUser(meta.from, 0, true)
          : { id: '0', name: 'Host', username: '', initials: 'HO', color: SEAT_COLORS[0], isHost: true, isBot: false, seat: 0, wins: 0 };
        room = {
          id: roomId,
          host_id: fallbackHost.id,
          status: 'expired',
          max_players: meta.maxPlayers === 2 ? 2 : 4,
          room_mode: meta.maxPlayers === 2 ? 'friend_2p' : 'multiplayer_4p',
          state_version: 1,
          is_published: true,
          published_at: now,
          inline_message_id: meta.inline_message_id ? String(meta.inline_message_id) : null,
          chat_id: meta.chat_id ? String(meta.chat_id) : null,
          message_id: meta.message_id ? String(meta.message_id) : null,
          players: [fallbackHost],
          spectators: [],
          match_state: null,
          created_at: now,
          updated_at: now,
          expired_at: now,
          waiting_expires_at: now,
          expires_at: now
        };
        await tx.saveRoom(room);
        return { ok: true, room, expiredBeforePublication: true, newlyExpired: false };
      }

      if (meta.inline_message_id) {
        room.inline_message_id = String(meta.inline_message_id);
      }
      if (meta.chat_id) {
        room.chat_id = String(meta.chat_id);
      }
      if (meta.message_id) {
        room.message_id = String(meta.message_id);
      }

      const wasPublished = Boolean(room.is_published);
      room.is_published = true;
      if (!room.published_at) {
        room.published_at = now;
      }
      room.updated_at = now;

      // Check if the room already expired before this publication event arrived
      if (this._isRoomPastExpiry(room, now)) {
        const newlyExpired = room.status !== 'expired';
        room.status = 'expired';
        room.expired_at = room.expired_at || now;
        room.state_version++;
        await tx.saveRoom(room);
        return {
          ok: true,
          room,
          expiredBeforePublication: true,
          newlyExpired
        };
      }

      // If the room is an active waiting room being published for the first time, anchor the full 5-minute waiting timeout from publication
      if (room.status === 'waiting' && !wasPublished) {
        const waitingExpiresAt = now + waitingTimeoutMs;
        room.waiting_expires_at = waitingExpiresAt;
        room.expires_at = waitingExpiresAt;
      }

      room.state_version++;
      await tx.saveRoom(room);
      return {
        ok: true,
        room,
        expiredBeforePublication: false,
        newlyExpired: false
      };
    });

    if (!txRes.ok) return txRes;

    if (txRes.expiredBeforePublication) {
      this._clearWaitingExpiryTimer(roomId);
      this._clearBotTimer(roomId);
      if (!meta.skipNotify) this._notifyBotUpdate(txRes.room);
      if (txRes.newlyExpired) {
        this._notifyRoomExpired(txRes.room);
      }
    } else if (txRes.room && txRes.room.status === 'waiting') {
      this._scheduleWaitingExpiryTimer(txRes.room);
      if (!meta.skipNotify) this._notifyBotUpdate(txRes.room);
    } else if (txRes.room) {
      if (!meta.skipNotify) this._notifyBotUpdate(txRes.room);
    }

    return txRes;
  }

  /**
   * Create a solo practice match room against Utya (server-backed when authenticated).
   */
  async createSoloPracticeRoom(hostUser) {
    const created = await this.createRoom(hostUser, {
      maxPlayers: 2,
      roomMode: 'solo_utya'
    });
    const room = created.room;
    if (room.players.length < 2) {
      await this.addBotToRoom(room.id, hostUser.id);
    }
    const started = await this.startGame(room.id, hostUser.id);
    return started.ok ? started : created;
  }

  /**
   * Idempotently expire a waiting room if and only if it is still in `'waiting'` status.
   * Never expires a room that has already started (`'playing'`) or finished (`'finished'`).
   */
  async expireWaitingRoom(roomId) {
    this._clearWaitingExpiryTimer(roomId);

    const txRes = await this.db.withTransaction(async (tx) => {
      const room = await tx.getRoom(roomId);
      if (!room) {
        return { ok: false, code: 'ROOM_NOT_FOUND', error: 'Room not found.' };
      }
      if (room.status === 'playing' || room.status === 'finished') {
        return { ok: false, code: 'ALREADY_STARTED', room };
      }
      if (room.status === 'expired') {
        return { ok: true, alreadyExpired: true, room };
      }

      room.status = 'expired';
      room.expired_at = Date.now();
      room.updated_at = room.expired_at;
      room.state_version++;
      await tx.saveRoom(room);
      return { ok: true, expired: true, room };
    });

    if (txRes.ok && txRes.expired && txRes.room) {
      this._clearBotTimer(roomId);
      this._notifyBotUpdate(txRes.room);
      this._notifyRoomExpired(txRes.room);
    }
    return txRes;
  }

  async getRoom(roomId) {
    let newlyExpiredRoom = null;
    const res = await this.db.withTransaction(async (tx) => {
      const room = await tx.getRoom(roomId);
      if (!room) return { ok: false, code: 'ROOM_NOT_FOUND', error: 'Room not found.' };
      const now = Date.now();
      if (this._isRoomPastExpiry(room, now)) {
        const wasWaiting = room.status === 'waiting';
        if (room.status !== 'expired') {
          room.status = 'expired';
          room.expired_at = now;
          room.updated_at = now;
          room.state_version++;
          await tx.saveRoom(room);
          if (wasWaiting) {
            newlyExpiredRoom = room;
          }
        }
        return { ok: false, code: 'ROOM_EXPIRED', error: 'This room has expired.', room };
      }
      return { ok: true, room };
    });

    if (newlyExpiredRoom) {
      this._clearWaitingExpiryTimer(roomId);
      this._clearBotTimer(roomId);
      this._notifyBotUpdate(newlyExpiredRoom);
      this._notifyRoomExpired(newlyExpiredRoom);
    }
    return res;
  }

  async joinRoom(roomId, user, requestedMode, options) {
    const mode = requestedMode === 'spectator' ? 'spectator' : 'player';
    const opts = options || {};
    const waitingTimeoutMs = this._getWaitingTimeoutMs();
    let newlyExpiredRoom = null;

    const res = await this.db.withTransaction(async (tx) => {
      let room = await tx.getRoom(roomId);
      if (!room && opts.createIfMissing) {
        const dbHost = await tx.upsertPlayer({
          id: user.id,
          first_name: user.first_name || user.name,
          username: user.username || ''
        });
        const normalizedHost = this._normalizeUser(
          Object.assign({}, user, { wins: dbHost.wins || 0 }),
          0,
          true
        );
        normalizedHost.isHost = true;
        normalizedHost.seat = 0;
        const now = Date.now();
        const waitingExpiresAt = now + waitingTimeoutMs;
        room = {
          id: roomId,
          host_id: normalizedHost.id,
          status: 'waiting',
          max_players: opts.maxPlayers === 2 ? 2 : 4,
          room_mode: opts.maxPlayers === 2 ? 'friend_2p' : 'multiplayer_4p',
          state_version: 1,
          is_published: true,
          published_at: now,
          inline_message_id: null,
          chat_id: null,
          message_id: null,
          players: [normalizedHost],
          spectators: [],
          match_state: null,
          created_at: now,
          updated_at: now,
          waiting_expires_at: waitingExpiresAt,
          expires_at: waitingExpiresAt
        };
        await tx.saveRoom(room);
        this._notifyBotUpdate(room);
        return { ok: true, role: 'player', seat: 0, room, created: true };
      }

      if (!room) {
        return { ok: false, code: 'ROOM_NOT_FOUND', error: 'Room does not exist.' };
      }

      const now = Date.now();
      if (this._isRoomPastExpiry(room, now)) {
        const wasWaiting = room.status === 'waiting';
        if (room.status !== 'expired') {
          room.status = 'expired';
          room.expired_at = now;
          room.updated_at = now;
          room.state_version++;
          await tx.saveRoom(room);
          if (wasWaiting) {
            newlyExpiredRoom = room;
          }
        }
        return { ok: false, code: 'ROOM_EXPIRED', error: 'Room has expired.', room };
      }

      const maxPlayers = room.max_players || 4;

      const dbProfile = await tx.upsertPlayer({
        id: user.id,
        first_name: user.first_name || user.name,
        username: user.username || ''
      });

      const userId = String(user.id);
      const existingPlayerIdx = room.players.findIndex(p => p.id === userId);

      // If user is already seated as a player, mark connected and never count the same user twice!
      if (existingPlayerIdx !== -1 && mode === 'player') {
        room.players[existingPlayerIdx].connected = true;
        room.players[existingPlayerIdx].name = String(user.first_name || user.name || room.players[existingPlayerIdx].name).slice(0, 48);
        if (user.username) {
          room.players[existingPlayerIdx].username = String(user.username).startsWith('@')
            ? String(user.username)
            : '@' + String(user.username);
        }
        if (room.match_state && room.match_state.players[existingPlayerIdx]) {
          room.match_state.players[existingPlayerIdx].connected = true;
        }
        const currentHost = room.players.find(p => p.id === room.host_id);
        if (!currentHost || !currentHost.connected || currentHost.isBot) {
          room.host_id = userId;
          room.players.forEach(p => { p.isHost = (p.id === userId); });
          if (room.match_state) {
            room.match_state.players.forEach(p => { p.isHost = (p.id === userId); });
          }
        }
        room.state_version++;
        room.updated_at = now;
        if (room.status !== 'waiting') {
          room.expires_at = now + this.options.roomTtlMs;
        }
        await tx.saveRoom(room);
        this._notifyBotUpdate(room);
        return { ok: true, role: 'player', seat: existingPlayerIdx, room, reconnected: true };
      }

      if (mode === 'spectator') {
        if (room.status === 'waiting' && existingPlayerIdx > 0) {
          room.players.splice(existingPlayerIdx, 1);
          room.players.forEach((p, idx) => {
            p.seat = idx;
            if (!p.isUtya) p.color = SEAT_COLORS[idx % SEAT_COLORS.length];
          });
        } else if (existingPlayerIdx !== -1 && room.status === 'playing') {
          return { ok: false, code: 'ALREADY_SEATED', error: 'You are an active player in this match.' };
        }

        if (!room.spectators.some(s => s.id === userId)) {
          room.spectators.push(this._normalizeUser(user, room.spectators.length, true));
        }
        room.state_version++;
        room.updated_at = now;
        await tx.saveRoom(room);
        this._notifyBotUpdate(room);
        return { ok: true, role: 'spectator', seat: null, room };
      }

      // Mode === 'player'
      if (room.status !== 'waiting') {
        return {
          ok: false,
          code: 'MATCH_ALREADY_STARTED',
          error: 'Match is already in progress. You can join as a spectator.'
        };
      }

      if (room.players.length >= maxPlayers) {
        return {
          ok: false,
          code: 'ROOM_FULL',
          error: `All ${maxPlayers} player seats are full. You can watch as a spectator.`
        };
      }

      room.spectators = room.spectators.filter(s => s.id !== userId);

      const seatIdx = room.players.length;
      const newPlayer = this._normalizeUser(
        Object.assign({}, user, { wins: dbProfile.wins || 0 }),
        seatIdx,
        true // Joined human player is never a bot
      );
      newPlayer.seat = seatIdx;
      newPlayer.isHost = false;
      room.players.push(newPlayer);
      room.state_version++;
      room.updated_at = now;

      await tx.saveRoom(room);
      this._notifyBotUpdate(room);
      return { ok: true, role: 'player', seat: seatIdx, room };
    });

    if (newlyExpiredRoom) {
      this._clearWaitingExpiryTimer(roomId);
      this._clearBotTimer(roomId);
      this._notifyBotUpdate(newlyExpiredRoom);
      this._notifyRoomExpired(newlyExpiredRoom);
    } else if (res.ok && res.created && res.room && res.room.status === 'waiting') {
      this._scheduleWaitingExpiryTimer(res.room);
    }
    return res;
  }

  /**
   * Allow a player to explicitly leave a waiting room, freeing their seat and migrating host if needed.
   */
  async leaveRoom(roomId, userId) {
    return this.db.withTransaction(async (tx) => {
      const room = await tx.getRoom(roomId);
      if (!room) return { ok: false, code: 'ROOM_NOT_FOUND', error: 'Room not found.' };
      const uId = String(userId);

      room.spectators = (room.spectators || []).filter(s => s.id !== uId);

      if (room.status === 'waiting') {
        const pIdx = room.players.findIndex(p => p.id === uId);
        if (pIdx !== -1) {
          room.players.splice(pIdx, 1);
          room.players.forEach((p, idx) => {
            p.seat = idx;
            if (!p.isUtya) p.color = SEAT_COLORS[idx % SEAT_COLORS.length];
          });
          const remainingHumans = room.players.filter(p => !p.isBot);
          if (remainingHumans.length === 0) {
            room.status = 'expired';
            room.expired_at = Date.now();
            this._clearWaitingExpiryTimer(roomId);
          } else if (room.host_id === uId) {
            const nextHost = remainingHumans.find(p => p.connected) || remainingHumans[0];
            room.host_id = nextHost.id;
            room.players.forEach(p => { p.isHost = (p.id === nextHost.id); });
          }
          room.state_version++;
          await tx.saveRoom(room);
          this._notifyBotUpdate(room);
        }
        return { ok: true, room };
      }

      // If match is in progress, treat as disconnect so seat/cards remain intact for reconnection
      const pIdx = room.players.findIndex(p => p.id === uId);
      if (pIdx !== -1) {
        room.players[pIdx].connected = false;
        if (room.match_state && room.match_state.players[pIdx]) {
          room.match_state.players[pIdx].connected = false;
        }
        room.state_version++;
        await tx.saveRoom(room);
      }
      return { ok: true, room };
    });
  }

  /**
   * Allow Host to explicitly add AI Bot(s) to unfilled seats in a waiting room.
   * Bots are always flagged with `isBot: true` so they are never misrepresented as real Telegram players.
   */
  async addBotToRoom(roomId, actorId) {
    const botNames = [
      { id: 'bot_utya', first_name: 'Utya', username: 'utya_bot', initials: 'UT', color: '#38bdf8', isUtya: true },
      { id: 'bot_pearl', first_name: 'P E A Г L !!', username: 'pearl_bot', initials: 'PL', color: '#ff5c6c' },
      { id: 'bot_aira', first_name: 'A I R A', username: 'aira_bot', initials: 'AI', color: '#8b5cf6' }
    ];

    return this.db.withTransaction(async (tx) => {
      const room = await tx.getRoom(roomId);
      if (!room) return { ok: false, code: 'ROOM_NOT_FOUND', error: 'Room not found.' };
      if (this._isRoomPastExpiry(room)) {
        room.status = 'expired';
        await tx.saveRoom(room);
        this._clearWaitingExpiryTimer(roomId);
        return { ok: false, code: 'ROOM_EXPIRED', error: 'This lobby has expired.' };
      }
      if (String(room.host_id) !== String(actorId)) {
        return { ok: false, code: 'NOT_HOST', error: 'Only the room host can add AI bots.' };
      }
      if (room.status !== 'waiting') {
        return { ok: false, code: 'INVALID_STATE', error: 'Can only add bots while waiting in lobby.' };
      }
      const maxPlayers = room.max_players || 4;
      if (room.players.length >= maxPlayers) {
        return { ok: false, code: 'ROOM_FULL', error: `Room already has ${maxPlayers} players.` };
      }

      const candidate = botNames.find(b => !room.players.some(p => p.id === b.id)) || {
        id: 'bot_' + Date.now(),
        first_name: 'Matcho Bot',
        username: 'matcho_ai',
        initials: 'MB'
      };

      const seatIdx = room.players.length;
      const botPlayer = this._normalizeUser(Object.assign({}, candidate, { isBot: true }), seatIdx, false);
      botPlayer.seat = seatIdx;
      botPlayer.isHost = false;
      room.players.push(botPlayer);
      room.state_version++;

      await tx.saveRoom(room);
      this._notifyBotUpdate(room);
      return { ok: true, room };
    });
  }

  async startGame(roomId, actorId, optionsOverride) {
    let newlyExpiredRoom = null;
    const res = await this.db.withTransaction(async (tx) => {
      const room = await tx.getRoom(roomId);
      if (!room) return { ok: false, code: 'ROOM_NOT_FOUND', error: 'Room not found.' };
      const now = Date.now();
      if (this._isRoomPastExpiry(room, now)) {
        const wasWaiting = room.status === 'waiting';
        if (room.status !== 'expired') {
          room.status = 'expired';
          room.expired_at = now;
          room.updated_at = now;
          room.state_version++;
          await tx.saveRoom(room);
          if (wasWaiting) newlyExpiredRoom = room;
        }
        return { ok: false, code: 'ROOM_EXPIRED', error: 'This lobby has expired.' };
      }
      if (room.status === 'playing') {
        return { ok: false, code: 'ALREADY_PLAYING', error: 'Match is already in progress.' };
      }
      if (String(room.host_id) !== String(actorId)) {
        return { ok: false, code: 'NOT_HOST', error: 'Only the room host can start the match.' };
      }
      if (room.players.length < 2) {
        return { ok: false, code: 'NOT_ENOUGH_PLAYERS', error: 'At least 2 players are required to start.' };
      }

      const matchState = UnoEngine.createMatchState(room.players, Object.assign({
        officialOpeningEffects: this.options.officialOpeningEffects,
        enableWild4Challenge: this.options.enableWild4Challenge
      }, optionsOverride || {}));

      room.status = 'playing';
      room.match_state = matchState;
      room.state_version++;
      room.updated_at = now;
      room.waiting_expires_at = null;
      room.expires_at = now + this.options.roomTtlMs;
      room.players.forEach(p => { p.rematchReady = false; });

      await tx.saveRoom(room);
      this._notifyBotUpdate(room);
      return { ok: true, room, event: matchState.lastEvent };
    });

    this._clearWaitingExpiryTimer(roomId);
    if (newlyExpiredRoom) {
      this._notifyBotUpdate(newlyExpiredRoom);
      this._notifyRoomExpired(newlyExpiredRoom);
    } else if (res.ok) {
      this._scheduleBotTurnIfNeeded(res.room);
    }
    return res;
  }

  async handleGameAction(roomId, actorId, actionPayload) {
    const res = await this.db.withTransaction(async (tx) => {
      const room = await tx.getRoom(roomId);
      if (!room) return { ok: false, code: 'ROOM_NOT_FOUND', error: 'Room not found.' };
      if (room.status === 'expired') {
        return { ok: false, code: 'ROOM_EXPIRED', error: 'Room has expired.' };
      }

      const uId = String(actorId);
      const isSpectator = room.spectators.some(s => s.id === uId);
      const isPlayer = room.players.some(p => p.id === uId);

      if (isSpectator && !isPlayer) {
        return { ok: false, code: 'SPECTATOR_READ_ONLY', error: 'Spectators cannot make game moves.' };
      }
      if (!isPlayer) {
        return { ok: false, code: 'NOT_IN_ROOM', error: 'You are not a seated player in this room.' };
      }
      if (room.status !== 'playing' || !room.match_state) {
        return { ok: false, code: 'MATCH_NOT_ACTIVE', error: 'Match is not currently active.' };
      }

      const engineRes = UnoEngine.applyAction(
        room.match_state,
        Object.assign({}, actionPayload, { playerId: uId })
      );

      if (!engineRes.ok) {
        return {
          ok: false,
          code: engineRes.duplicate ? 'DUPLICATE_ACTION' : 'INVALID_MOVE',
          error: engineRes.error
        };
      }

      room.state_version++;
      room.updated_at = Date.now();
      room.expires_at = Date.now() + this.options.roomTtlMs;

      if (room.match_state.status === 'finished') {
        room.status = 'finished';
        const winnerId = room.match_state.winnerId;
        const winScore = room.match_state.winScore || 0;

        for (const mp of room.match_state.players) {
          const rp = room.players.find(p => p.id === mp.id);
          if (rp) {
            rp.wins = mp.wins;
            rp.rematchReady = false;
          }
          if (!mp.isBot) {
            const existingP = await tx.getPlayer(mp.id);
            const gamesPlayed = (existingP ? existingP.games_played : 0) + 1;
            const wins = (existingP ? existingP.wins : 0) + (mp.id === winnerId ? 1 : 0);
            const totalScore = (existingP ? existingP.total_score : 0) + (mp.id === winnerId ? winScore : 0);
            await tx.upsertPlayer({
              id: mp.id,
              first_name: mp.name,
              username: mp.username,
              games_played: gamesPlayed,
              wins,
              total_score: totalScore
            });
          }
        }

        await tx.recordMatch({
          id: 'match_' + crypto.randomBytes(6).toString('hex'),
          room_id: room.id,
          winner_id: winnerId,
          win_score: winScore,
          players_summary: room.match_state.players.map(p => ({
            id: p.id,
            name: p.name,
            isBot: Boolean(p.isBot),
            remainingCards: p.hand.length,
            wins: p.wins
          })),
          completed_at: Date.now()
        });
      }

      await tx.saveRoom(room);
      this._notifyBotUpdate(room);
      return { ok: true, room, event: engineRes.event };
    });

    if (res.ok) {
      this._scheduleBotTurnIfNeeded(res.room);
    }
    return res;
  }

  async requestRematch(roomId, actorId) {
    const res = await this.db.withTransaction(async (tx) => {
      const room = await tx.getRoom(roomId);
      if (!room) return { ok: false, code: 'ROOM_NOT_FOUND', error: 'Room not found.' };
      if (room.status === 'expired') {
        return { ok: false, code: 'ROOM_EXPIRED', error: 'Room has expired.' };
      }
      if (room.status !== 'finished') {
        return { ok: false, code: 'MATCH_NOT_FINISHED', error: 'Rematch is only available after a match ends.' };
      }

      const uId = String(actorId);
      const rp = room.players.find(p => p.id === uId);
      if (!rp) {
        return { ok: false, code: 'NOT_PLAYER', error: 'Only seated players can request a rematch.' };
      }

      rp.rematchReady = !rp.rematchReady;
      for (const p of room.players) {
        if (p.isBot) p.rematchReady = true;
      }

      if (room.match_state && Array.isArray(room.match_state.players)) {
        for (const mp of room.match_state.players) {
          const matchRp = room.players.find(p => p.id === mp.id);
          if (matchRp) mp.rematchReady = matchRp.rematchReady;
        }
      }

      const allReady = room.players.length >= 2 && room.players.every(p => p.rematchReady);
      let restarted = false;

      if (allReady) {
        const newMatch = UnoEngine.createMatchState(room.players, {
          officialOpeningEffects: this.options.officialOpeningEffects,
          enableWild4Challenge: this.options.enableWild4Challenge
        });
        room.status = 'playing';
        room.match_state = newMatch;
        room.players.forEach(p => { p.rematchReady = false; });
        room.expires_at = Date.now() + this.options.roomTtlMs;
        restarted = true;
      }

      room.state_version++;
      await tx.saveRoom(room);
      this._notifyBotUpdate(room);
      return {
        ok: true,
        room,
        restarted,
        event: restarted ? room.match_state.lastEvent : {
          type: 'REMATCH_VOTE_UPDATED',
          playerId: uId,
          rematchReady: rp.rematchReady,
          readyCount: room.players.filter(p => p.rematchReady).length,
          totalPlayers: room.players.length
        }
      };
    });

    if (res.ok && res.restarted) {
      this._scheduleBotTurnIfNeeded(res.room);
    }
    return res;
  }

  async forceRematchByHost(roomId, actorId) {
    const res = await this.db.withTransaction(async (tx) => {
      const room = await tx.getRoom(roomId);
      if (!room) return { ok: false, code: 'ROOM_NOT_FOUND', error: 'Room not found.' };
      if (room.status === 'expired') {
        return { ok: false, code: 'ROOM_EXPIRED', error: 'Room has expired.' };
      }
      if (String(room.host_id) !== String(actorId)) {
        return { ok: false, code: 'NOT_HOST', error: 'Only the room host can force start a rematch.' };
      }
      if (room.players.length < 2) {
        return { ok: false, code: 'NOT_ENOUGH_PLAYERS', error: 'At least 2 players are required.' };
      }

      const newMatch = UnoEngine.createMatchState(room.players, {
        officialOpeningEffects: this.options.officialOpeningEffects,
        enableWild4Challenge: this.options.enableWild4Challenge
      });
      room.status = 'playing';
      room.match_state = newMatch;
      room.players.forEach(p => { p.rematchReady = false; });
      room.state_version++;
      room.expires_at = Date.now() + this.options.roomTtlMs;

      await tx.saveRoom(room);
      this._notifyBotUpdate(room);
      return { ok: true, room, restarted: true, event: newMatch.lastEvent };
    });

    if (res.ok) {
      this._scheduleBotTurnIfNeeded(res.room);
    }
    return res;
  }

  async handleDisconnect(roomId, userId) {
    return this.db.withTransaction(async (tx) => {
      const room = await tx.getRoom(roomId);
      if (!room) return null;
      const uId = String(userId);
      const pIdx = room.players.findIndex(p => p.id === uId);
      if (pIdx !== -1) {
        room.players[pIdx].connected = false;
        if (room.match_state && room.match_state.players[pIdx]) {
          room.match_state.players[pIdx].connected = false;
        }
        if (room.host_id === uId) {
          const nextHost = room.players.find(p => p.id !== uId && p.connected && !p.isBot);
          if (nextHost) {
            room.players.forEach(p => { p.isHost = (p.id === nextHost.id); });
            if (room.match_state) {
              room.match_state.players.forEach(p => { p.isHost = (p.id === nextHost.id); });
            }
            room.host_id = nextHost.id;
          }
        }
        room.state_version++;
        await tx.saveRoom(room);
        return room;
      }
      return room;
    });
  }

  async cleanupExpiredRooms() {
    const expiredWaitingRooms = [];
    const expiredCount = await this.db.withTransaction(async (tx) => {
      const rooms = await tx.listActiveRooms();
      const now = Date.now();
      let count = 0;
      for (const room of rooms) {
        if (this._isRoomPastExpiry(room, now)) {
          const wasWaiting = room.status === 'waiting';
          room.status = 'expired';
          room.expired_at = now;
          room.updated_at = now;
          room.state_version++;
          await tx.saveRoom(room);
          this._clearBotTimer(room.id);
          this._clearWaitingExpiryTimer(room.id);
          if (wasWaiting) {
            expiredWaitingRooms.push(room);
          }
          count++;
        }
      }
      return count;
    });

    for (const room of expiredWaitingRooms) {
      this._notifyBotUpdate(room);
      this._notifyRoomExpired(room);
    }
    return expiredCount;
  }

  _clearWaitingExpiryTimer(roomId) {
    const existing = this.waitingExpiryTimers.get(roomId);
    if (existing) {
      clearTimeout(existing);
      this.waitingExpiryTimers.delete(roomId);
    }
  }

  _scheduleWaitingExpiryTimer(room) {
    if (!room || room.status !== 'waiting') return;
    this._clearWaitingExpiryTimer(room.id);
    const targetTime = room.waiting_expires_at || room.expires_at || (Date.now() + this._getWaitingTimeoutMs());
    const delayMs = Math.max(15, targetTime - Date.now());
    const timer = setTimeout(() => {
      this.waitingExpiryTimers.delete(room.id);
      this.expireWaitingRoom(room.id).catch(() => {});
    }, delayMs);
    if (timer.unref) timer.unref();
    this.waitingExpiryTimers.set(room.id, timer);
  }

  _clearBotTimer(roomId) {
    const existing = this.botTurnTimers.get(roomId);
    if (existing) {
      clearTimeout(existing);
      this.botTurnTimers.delete(roomId);
    }
  }

  clearAllTimers() {
    for (const t of this.botTurnTimers.values()) clearTimeout(t);
    this.botTurnTimers.clear();
    for (const t of this.waitingExpiryTimers.values()) clearTimeout(t);
    this.waitingExpiryTimers.clear();
  }

  _scheduleBotTurnIfNeeded(room) {
    if (!room || room.status !== 'playing' || !room.match_state) return;
    this._clearBotTimer(room.id);

    const ms = room.match_state;
    const activePlayer = ms.players[ms.turnIndex];
    if (!activePlayer || !activePlayer.isBot) return;

    const timer = setTimeout(async () => {
      try {
        const currentRes = await this.getRoom(room.id);
        if (!currentRes.ok || currentRes.room.status !== 'playing') return;
        const currState = currentRes.room.match_state;
        const botP = currState.players[currState.turnIndex];
        if (!botP || !botP.isBot) return;

        const botAction = UnoEngine.computeBotAction(currState, botP.id);
        if (botAction) {
          const moveRes = await this.handleGameAction(room.id, botP.id, botAction);
          if (moveRes.ok && this.onBroadcastRoom) {
            this.onBroadcastRoom(moveRes.room, moveRes.event);
          }
        }
      } catch (e) {}
    }, 650);

    if (timer.unref) timer.unref();
    this.botTurnTimers.set(room.id, timer);
  }

  _notifyBotUpdate(room) {
    if (typeof this.options.onRoomUpdated === 'function') {
      try {
        this.options.onRoomUpdated(room);
      } catch (e) {}
    }
  }

  _notifyRoomExpired(room) {
    if (typeof this.options.onRoomExpired === 'function') {
      try {
        this.options.onRoomExpired(room);
      } catch (e) {}
    }
  }

  formatPublicRoomState(room, viewerId) {
    const vId = viewerId ? String(viewerId) : null;
    const myPlayer = vId ? room.players.find(p => p.id === vId) : null;
    const mySpectator = vId ? room.spectators.find(s => s.id === vId) : null;
    const maxPlayers = room.max_players || 4;
    const botUsername = String(this.options.botUsername || 'matcho_bot').replace(/^@/, '');
    const appShortName = String(this.options.appShortName || 'play').replace(/^\/+/, '');

    let inviteToken = `room_${room.id}`;
    let spectateToken = `spec_${room.id}`;
    try {
      inviteToken = createRoomInviteToken(room.id, 'player', this.options.sessionSecret);
      spectateToken = createRoomInviteToken(room.id, 'spectator', this.options.sessionSecret);
    } catch (e) {}

    const inviteLink = `https://t.me/${botUsername}/${appShortName}?startapp=${inviteToken}`;
    const spectateLink = `https://t.me/${botUsername}/${appShortName}?startapp=${spectateToken}`;

    return {
      id: room.id,
      hostId: room.host_id,
      status: room.status,
      maxPlayers,
      roomMode: room.room_mode || (maxPlayers === 2 ? 'friend_2p' : 'multiplayer_4p'),
      stateVersion: room.state_version,
      isPublished: Boolean(room.is_published || room.inline_message_id || room.chat_id),
      publishedAt: room.published_at || null,
      viewerRole: myPlayer ? 'player' : (mySpectator ? 'spectator' : 'guest'),
      viewerSeat: myPlayer ? myPlayer.seat : null,
      botUsername,
      appShortName,
      inviteToken,
      spectateToken,
      inviteLink,
      spectateLink,
      waitingExpiresAt: room.waiting_expires_at || null,
      players: room.players.map((p, idx) => ({
        id: p.id,
        seat: idx,
        name: p.name,
        username: p.username,
        initials: p.initials,
        color: p.color,
        isHost: p.id === room.host_id,
        isBot: Boolean(p.isBot),
        isUtya: Boolean(p.isUtya || (p.isBot && p.name === 'Utya')),
        connected: Boolean(p.connected),
        wins: Number(p.wins || 0),
        rematchReady: Boolean(p.rematchReady)
      })),
      spectators: room.spectators.map(s => ({
        id: s.id,
        name: s.name,
        username: s.username,
        initials: s.initials
      })),
      match: room.match_state
        ? UnoEngine.sanitizeStateForViewer(room.match_state, vId)
        : null
    };
  }
}

module.exports = {
  RoomManager,
  DEFAULT_ROOM_TTL_MS,
  DEFAULT_WAITING_ROOM_TIMEOUT_MS
};
