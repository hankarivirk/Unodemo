/**
 * Multiplayer Room & Match Lifecycle Manager
 *
 * Responsibilities:
 * - Create rooms with unique IDs (`uno_<random>`) and seat Host in Seat 0
 * - Enforce 4-player maximum capacity and manage Spectator list
 * - Validate room ownership, player membership, and spectator read-only restrictions
 * - Strictly separate real authenticated human players (`isBot: false`) from optional AI bots (`isBot: true`)
 * - Execute all state changes inside ACID database transactions (`db.withTransaction`)
 * - Handle player disconnects, reconnects, and automatic host migration if host abandons waiting room
 * - Manage synchronized rematch votes and Host Force Rematch
 * - Expire and clean up abandoned rooms
 */
'use strict';

const crypto = require('node:crypto');
const UnoEngine = require('../shared/uno_engine');

const SEAT_COLORS = ['#475569', '#ff5c6c', '#8b5cf6', '#10b981'];
const DEFAULT_ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

class RoomManager {
  constructor(db, options) {
    this.db = db;
    this.options = Object.assign({
      roomTtlMs: DEFAULT_ROOM_TTL_MS,
      onRoomUpdated: null,
      officialOpeningEffects: true,
      enableWild4Challenge: true
    }, options || {});
    this.botTurnTimers = new Map();
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

  async createRoom(hostUser, meta) {
    const metadata = meta || {};
    const roomId = metadata.roomId && /^uno_[a-zA-Z0-9_-]{3,48}$/.test(metadata.roomId)
      ? metadata.roomId
      : this.generateRoomId();

    return this.db.withTransaction(async (tx) => {
      const existing = await tx.getRoom(roomId);
      if (existing && existing.status !== 'expired') {
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

      const now = Date.now();
      const room = {
        id: roomId,
        host_id: normalizedHost.id,
        status: 'waiting',
        state_version: 1,
        inline_message_id: metadata.inline_message_id || null,
        chat_id: metadata.chat_id || null,
        message_id: metadata.message_id || null,
        players: [normalizedHost],
        spectators: [],
        match_state: null,
        created_at: now,
        updated_at: now,
        expires_at: now + this.options.roomTtlMs
      };

      await tx.saveRoom(room);
      this._notifyBotUpdate(room);
      return { ok: true, room };
    });
  }

  async getRoom(roomId) {
    return this.db.withTransaction(async (tx) => {
      const room = await tx.getRoom(roomId);
      if (!room) return { ok: false, code: 'ROOM_NOT_FOUND', error: 'Room not found.' };
      if (room.status === 'expired' || Date.now() > room.expires_at) {
        room.status = 'expired';
        await tx.saveRoom(room);
        return { ok: false, code: 'ROOM_EXPIRED', error: 'This room has expired.' };
      }
      return { ok: true, room };
    });
  }

  async joinRoom(roomId, user, requestedMode) {
    const mode = requestedMode === 'spectator' ? 'spectator' : 'player';

    return this.db.withTransaction(async (tx) => {
      const room = await tx.getRoom(roomId);
      if (!room) {
        return { ok: false, code: 'ROOM_NOT_FOUND', error: 'Room does not exist.' };
      }
      if (room.status === 'expired' || Date.now() > room.expires_at) {
        room.status = 'expired';
        await tx.saveRoom(room);
        return { ok: false, code: 'ROOM_EXPIRED', error: 'Room has expired.' };
      }

      const dbProfile = await tx.upsertPlayer({
        id: user.id,
        first_name: user.first_name || user.name,
        username: user.username || ''
      });

      const userId = String(user.id);
      const existingPlayerIdx = room.players.findIndex(p => p.id === userId);

      // If user is already seated as a player, mark connected and return (unless switching to spectator in waiting room)
      if (existingPlayerIdx !== -1 && mode === 'player') {
        room.players[existingPlayerIdx].connected = true;
        room.players[existingPlayerIdx].name = String(user.first_name || user.name || room.players[existingPlayerIdx].name).slice(0, 48);
        if (room.match_state && room.match_state.players[existingPlayerIdx]) {
          room.match_state.players[existingPlayerIdx].connected = true;
        }
        room.state_version++;
        room.expires_at = Date.now() + this.options.roomTtlMs;
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

      if (room.players.length >= 4) {
        return {
          ok: false,
          code: 'ROOM_FULL',
          error: 'All 4 player seats are full. You can watch as a spectator.'
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
      room.expires_at = Date.now() + this.options.roomTtlMs;

      await tx.saveRoom(room);
      this._notifyBotUpdate(room);
      return { ok: true, role: 'player', seat: seatIdx, room };
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
      if (String(room.host_id) !== String(actorId)) {
        return { ok: false, code: 'NOT_HOST', error: 'Only the room host can add AI bots.' };
      }
      if (room.status !== 'waiting') {
        return { ok: false, code: 'INVALID_STATE', error: 'Can only add bots while waiting in lobby.' };
      }
      if (room.players.length >= 4) {
        return { ok: false, code: 'ROOM_FULL', error: 'Room already has 4 players.' };
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
    const res = await this.db.withTransaction(async (tx) => {
      const room = await tx.getRoom(roomId);
      if (!room) return { ok: false, code: 'ROOM_NOT_FOUND', error: 'Room not found.' };
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
      room.players.forEach(p => { p.rematchReady = false; });

      await tx.saveRoom(room);
      this._notifyBotUpdate(room);
      return { ok: true, room, event: matchState.lastEvent };
    });

    if (res.ok) {
      this._scheduleBotTurnIfNeeded(res.room);
    }
    return res;
  }

  async handleGameAction(roomId, actorId, actionPayload) {
    const res = await this.db.withTransaction(async (tx) => {
      const room = await tx.getRoom(roomId);
      if (!room) return { ok: false, code: 'ROOM_NOT_FOUND', error: 'Room not found.' };

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
    return this.db.withTransaction(async (tx) => {
      const rooms = await tx.listActiveRooms();
      const now = Date.now();
      let expiredCount = 0;
      for (const room of rooms) {
        if (now > room.expires_at) {
          room.status = 'expired';
          await tx.saveRoom(room);
          this._clearBotTimer(room.id);
          expiredCount++;
        }
      }
      return expiredCount;
    });
  }

  _clearBotTimer(roomId) {
    const existing = this.botTurnTimers.get(roomId);
    if (existing) {
      clearTimeout(existing);
      this.botTurnTimers.delete(roomId);
    }
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

  formatPublicRoomState(room, viewerId) {
    const vId = viewerId ? String(viewerId) : null;
    const myPlayer = vId ? room.players.find(p => p.id === vId) : null;
    const mySpectator = vId ? room.spectators.find(s => s.id === vId) : null;

    return {
      id: room.id,
      hostId: room.host_id,
      status: room.status,
      stateVersion: room.state_version,
      viewerRole: myPlayer ? 'player' : (mySpectator ? 'spectator' : 'guest'),
      viewerSeat: myPlayer ? myPlayer.seat : null,
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

module.exports = { RoomManager };
