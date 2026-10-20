import 'dotenv/config';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { COLORS, createGame, currentPlayer, legalCards, playCard, drawCard, passTurn, chooseColor, startRematch } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const BOT_USERNAME = (process.env.BOT_USERNAME || '').replace(/^@/, '').trim();
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ALLOW_GUESTS = process.env.DEV_ALLOW_GUESTS === 'true' && process.env.NODE_ENV !== 'production';
const INIT_DATA_MAX_AGE = Math.max(60, Number(process.env.INIT_DATA_MAX_AGE_SECONDS || 86400));
const MAX_PLAYERS = 6;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const ROOMS = new Map();
const VALID_REACTIONS = new Set(['😎', '😂', '😭', '😡', '🔥', '👍', '💀', '❤️', '🥳']);
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: ROOMS.size, time: new Date().toISOString() }));
app.get('/config.js', (_req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-store').send(
    `window.GAME_CONFIG=${JSON.stringify({ botUsername: BOT_USERNAME, publicUrl: PUBLIC_URL, maxPlayers: MAX_PLAYERS })};`
  );
});
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/socket.io')) return next();
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  path: '/socket.io',
  serveClient: true,
  maxHttpBufferSize: 1e6,
  pingInterval: 25000,
  pingTimeout: 20000,
});

function safeText(value, max = 22) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

function validateTelegramInitData(initData) {
  if (!BOT_TOKEN || typeof initData !== 'string' || !initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const suppliedHash = params.get('hash');
    if (!suppliedHash || !/^[a-f0-9]{64}$/i.test(suppliedHash)) return null;
    // Telegram's bot-token HMAC check excludes only `hash`. The optional
    // Ed25519 `signature` remains part of the HMAC data-check string.
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    const a = Buffer.from(calculatedHash, 'hex');
    const b = Buffer.from(suppliedHash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    const authDate = Number(params.get('auth_date'));
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(authDate) || authDate > nowSeconds + 60 || nowSeconds - authDate > INIT_DATA_MAX_AGE) return null;
    const userRaw = params.get('user');
    if (!userRaw) return null;
    const user = JSON.parse(userRaw);
    if (!user?.id) return null;
    return {
      id: `tg_${String(user.id)}`,
      telegramId: String(user.id),
      name: safeText([user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'Player'),
      username: safeText(user.username || '', 32),
      photoUrl: typeof user.photo_url === 'string' && user.photo_url.startsWith('https://') ? user.photo_url : null,
    };
  } catch {
    return null;
  }
}

io.use((socket, next) => {
  const auth = socket.handshake.auth || {};
  const telegramUser = validateTelegramInitData(auth.initData);
  if (telegramUser) {
    socket.data.profile = { ...telegramUser, isGuest: false };
    return next();
  }
  if (!ALLOW_GUESTS) {
    const error = new Error('TELEGRAM_AUTH_REQUIRED');
    error.data = { message: 'Open this game from your Telegram bot, or enable DEV_ALLOW_GUESTS only for local testing.' };
    return next(error);
  }
  const clientGuestId = safeText(auth.guestId || '', 64).replace(/[^A-Za-z0-9_-]/g, '');
  socket.data.profile = {
    id: `guest_${clientGuestId || randomUUID()}`,
    name: safeText(auth.guestName || 'Guest'),
    telegramId: null,
    username: '',
    photoUrl: null,
    isGuest: true,
  };
  return next();
});

function newRoomCode() {
  for (let tries = 0; tries < 20; tries += 1) {
    let code = '';
    const bytes = randomBytes(6);
    for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    if (!ROOMS.has(code)) return code;
  }
  throw new Error('Could not generate a room code. Try again.');
}

function makeResumeToken() {
  return randomBytes(24).toString('base64url');
}

function getInviteLink(code) {
  if (BOT_USERNAME) return `https://t.me/${BOT_USERNAME}?start=join_${encodeURIComponent(code)}`;
  return `${PUBLIC_URL}/?room=${encodeURIComponent(code)}`;
}

function findRoom(socket) {
  const code = socket.data.roomCode;
  const room = code ? ROOMS.get(code) : null;
  return room || null;
}

function findPlayer(room, playerId) {
  return room.players.find((player) => player.id === playerId) || null;
}

function cardLabel(card) {
  if (!card) return null;
  return { id: card.id, color: card.color, type: card.type, value: card.value };
}

function buildView(room, player) {
  const game = room.game;
  const gamePlayer = game?.players.find((item) => item.id === player.id) || null;
  return {
    roomCode: room.code,
    status: game?.status || 'waiting',
    phase: game?.phase || 'waiting',
    mode: room.mode,
    maxPlayers: MAX_PLAYERS,
    hostId: room.hostId,
    you: player.id,
    inviteLink: getInviteLink(room.code),
    players: room.players.map((item) => ({
      id: item.id,
      name: item.name,
      username: item.username || '',
      photoUrl: item.photoUrl || null,
      isGuest: Boolean(item.isGuest),
      isBot: Boolean(item.isBot),
      connected: Boolean(item.isBot || item.connected),
      handSize: item.hand?.length ?? 0,
      isHost: item.id === room.hostId,
      rematch: room.rematchVotes.has(item.id),
      reaction: item.reaction || null,
    })),
    game: game ? {
      currentPlayerId: game.status === 'playing' ? currentPlayer(game)?.id : null,
      direction: game.direction,
      activeColor: game.activeColor,
      topCard: cardLabel(game.discardPile.at(-1)),
      deckCount: game.drawPile.length,
      discardCount: game.discardPile.length,
      turnNumber: game.turnNumber,
      winnerId: game.winnerId,
      lastAction: game.lastAction ? { ...game.lastAction, card: cardLabel(game.lastAction.card) } : null,
      pendingColor: game.phase === 'wild' && currentPlayer(game)?.id === player.id,
      canDraw: game.status === 'playing' && game.phase === 'playing' && currentPlayer(game)?.id === player.id && !game.hasDrawnCardId,
      canPass: game.status === 'playing' && game.phase === 'playing' && currentPlayer(game)?.id === player.id && Boolean(game.hasDrawnCardId),
      legalCardIds: game.status === 'playing' ? legalCards(game, player.id) : [],
    } : null,
    hand: gamePlayer?.hand.map(cardLabel) || [],
    botUsername: BOT_USERNAME || null,
  };
}

function syncRoom(room) {
  for (const player of room.players) {
    if (!player.socketId || player.isBot) continue;
    const target = io.sockets.sockets.get(player.socketId);
    if (target) target.emit('room:state', buildView(room, player));
  }
  scheduleBotTurn(room);
}

function sendError(socket, error) {
  socket.emit('room:error', { message: safeText(error?.message || 'Something went wrong.', 180) });
}

function attachPlayer(room, player, socket) {
  player.socketId = socket.id;
  player.connected = true;
  player.isBot = false;
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
  socket.emit('room:joined', { roomCode: room.code, playerId: player.id, resumeToken: player.resumeToken, inviteLink: getInviteLink(room.code) });
}

function detachCurrentSocket(socket) {
  const old = findRoom(socket);
  if (!old) return;
  const player = findPlayer(old, socket.data.playerId);
  if (player && player.socketId === socket.id) {
    player.socketId = null;
    player.connected = false;
    player.reaction = null;
    if (old.status === 'waiting') {
      old.players = old.players.filter((item) => item.id !== player.id);
    } else {
      // Preserve the resume token: an intentional move to another room should
      // not strand the old match. The seat becomes CPU-controlled until resume.
      player.isBot = true;
    }
  }
  socket.leave(old.code);
  socket.data.roomCode = null;
  socket.data.playerId = null;
  if (!old.players.some((p) => !p.isBot)) {
    cleanRoom(old);
  } else {
    if (old.hostId === player?.id) {
      const nextHost = old.players.find((p) => !p.isBot && p.connected) || old.players.find((p) => !p.isBot);
      if (nextHost) old.hostId = nextHost.id;
    }
    syncRoom(old);
  }
}

function createPlayer(socket, displayName) {
  const profile = socket.data.profile;
  const name = profile.isGuest ? safeText(displayName || profile.name || 'Guest') : safeText(profile.name || 'Player');
  return {
    id: profile.id,
    name: name || 'Player',
    username: profile.username || '',
    photoUrl: profile.photoUrl || null,
    isGuest: Boolean(profile.isGuest),
    isBot: false,
    connected: true,
    socketId: socket.id,
    resumeToken: makeResumeToken(),
    hand: [],
    reaction: null,
    wins: 0,
  };
}

function requireRoomPlayer(socket) {
  const room = findRoom(socket);
  if (!room) throw new Error('You are not in a room. Create or join one first.');
  const player = findPlayer(room, socket.data.playerId);
  if (!player || player.socketId !== socket.id) throw new Error('This session is no longer attached to the room. Rejoin it.');
  return { room, player };
}

function requireHost(room, player) {
  if (room.hostId !== player.id) throw new Error('Only the host can do that.');
}

function addBotToRoom(room) {
  if (room.status !== 'waiting') throw new Error('Bots can only be added before the game starts.');
  if (room.players.length >= MAX_PLAYERS) throw new Error('The room is full.');
  const number = room.players.filter((p) => p.isBot).length + 1;
  const bot = {
    id: `bot_${randomUUID()}`,
    name: ['Nova', 'Pixel', 'Comet', 'Milo', 'Echo'][number % 5],
    username: '', photoUrl: null, isGuest: false, isBot: true, connected: true,
    socketId: null, resumeToken: null, hand: [], reaction: null, wins: 0,
  };
  room.players.push(bot);
  return bot;
}

function startRoomGame(room) {
  if (room.players.length < 2) throw new Error('Invite at least one more player or add a bot.');
  if (room.players.length > MAX_PLAYERS) throw new Error('The room is full.');
  // A person who dropped out in the lobby should not freeze the game once it starts.
  for (const player of room.players) {
    if (!player.isBot && !player.connected) player.isBot = true;
  }
  room.game = createGame(room.players, {});
  room.players = room.game.players;
  room.status = 'playing';
  room.rematchVotes = new Set(room.players.filter((p) => p.isBot).map((p) => p.id));
  room.startedAt = Date.now();
}

function maybeCompleteRematch(room) {
  const humanPlayers = room.players.filter((p) => !p.isBot);
  if (humanPlayers.length && humanPlayers.every((p) => room.rematchVotes.has(p.id))) {
    room.game = startRematch(room.game);
    room.players = room.game.players;
    room.status = 'playing';
    room.rematchVotes = new Set(room.players.filter((p) => p.isBot).map((p) => p.id));
  }
}

function scheduleBotTurn(room) {
  if (room.botTimer || room.status !== 'playing' || !room.game || room.game.status !== 'playing' || room.game.phase === 'wild') return;
  const player = currentPlayer(room.game);
  if (!player?.isBot) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    try {
      if (ROOMS.get(room.code) !== room || room.status !== 'playing' || room.game?.status !== 'playing') return;
      const bot = currentPlayer(room.game);
      if (!bot?.isBot) return;
      const moves = legalCards(room.game, bot.id);
      if (moves.length) {
        const preferred = moves.map((id) => bot.hand.find((c) => c.id === id)).filter(Boolean);
        preferred.sort((a, b) => cardPriority(b) - cardPriority(a));
        const choice = preferred[0];
        const result = playCard(room.game, bot.id, choice.id);
        if (result.awaitingColor) chooseColor(room.game, bot.id, chooseBotColor(bot.hand, room.game.activeColor));
      } else if (!room.game.hasDrawnCardId) {
        const result = drawCard(room.game, bot.id);
        if (result.canPlay && result.card && Math.random() < 0.78) {
          const move = legalCards(room.game, bot.id).find((id) => id === result.card.id);
          if (move) {
            const played = playCard(room.game, bot.id, move);
            if (played.awaitingColor) chooseColor(room.game, bot.id, chooseBotColor(bot.hand, room.game.activeColor));
          } else passTurn(room.game, bot.id);
        } else if (room.game.currentIndex === room.game.players.findIndex((p) => p.id === bot.id) && room.game.hasDrawnCardId) {
          passTurn(room.game, bot.id);
        }
      } else {
        passTurn(room.game, bot.id);
      }
      if (room.game.status === 'finished') room.status = 'finished';
      syncRoom(room);
    } catch (error) {
      console.error('Bot turn error:', error.message);
    }
  }, 650 + Math.floor(Math.random() * 450));
  room.botTimer.unref?.();
}

function cardPriority(card) {
  return ({ wild4: 8, wild: 7, draw2: 6, skip: 5, reverse: 4, number: 1 })[card?.type] || 0;
}

function chooseBotColor(hand, fallback = 'blue') {
  const counts = Object.fromEntries(COLORS.map((color) => [color, 0]));
  for (const card of hand) if (card.color) counts[card.color] += 1;
  return [...COLORS].sort((a, b) => counts[b] - counts[a])[0] || fallback;
}

function ensureGame(room) {
  if (!room.game || room.game.status !== 'playing') throw new Error('The game is not in progress.');
  return room.game;
}

function cleanRoom(room) {
  if (room.botTimer) clearTimeout(room.botTimer);
  ROOMS.delete(room.code);
  for (const player of room.players) {
    const socket = player.socketId ? io.sockets.sockets.get(player.socketId) : null;
    if (socket) {
      socket.leave(room.code);
      socket.data.roomCode = null;
      socket.data.playerId = null;
      socket.emit('room:closed', { message: 'This room has ended.' });
    }
  }
}

io.on('connection', (socket) => {
  socket.on('room:create', (payload = {}) => {
    try {
      detachCurrentSocket(socket);
      const player = createPlayer(socket, payload.name);
      const code = newRoomCode();
      const room = {
        code, hostId: player.id, players: [player], game: null, status: 'waiting',
        mode: 'classic', rematchVotes: new Set(), createdAt: Date.now(), startedAt: null, botTimer: null,
      };
      ROOMS.set(code, room);
      attachPlayer(room, player, socket);
      syncRoom(room);
    } catch (error) { sendError(socket, error); }
  });

  socket.on('room:join', (payload = {}) => {
    try {
      const code = safeText(payload.code, 8).toUpperCase();
      const room = ROOMS.get(code);
      if (!room) throw new Error('Room not found. Check the code or ask for a fresh invite.');

      // Refreshing the room on the same connection must never remove that player.
      if (socket.data.roomCode === code && socket.data.playerId) {
        const current = findPlayer(room, socket.data.playerId);
        if (current) {
          socket.emit('room:joined', { roomCode: room.code, playerId: current.id, resumeToken: current.resumeToken, inviteLink: getInviteLink(room.code) });
          syncRoom(room);
          return;
        }
      }
      if (room.status !== 'waiting') throw new Error('This game has already started.');

      const profile = socket.data.profile;
      const existing = findPlayer(room, profile.id);
      if (!existing && room.players.length >= MAX_PLAYERS) throw new Error('This room is full.');
      if (existing && existing.connected && existing.socketId && existing.socketId !== socket.id && io.sockets.sockets.has(existing.socketId)) {
        throw new Error('This Telegram account is already in the room.');
      }

      // Detach from the previous room only after the target is validated and
      // after handling same-room re-entry. This avoids deleting an active room.
      detachCurrentSocket(socket);
      if (existing) {
        attachPlayer(room, existing, socket);
      } else {
        const player = createPlayer(socket, payload.name);
        room.players.push(player);
        attachPlayer(room, player, socket);
      }
      syncRoom(room);
    } catch (error) { sendError(socket, error); }
  });

  socket.on('room:resume', (payload = {}) => {
    try {
      const code = safeText(payload.code, 8).toUpperCase();
      const room = ROOMS.get(code);
      if (!room) throw new Error('That room no longer exists. Create or join another room.');
      const player = room.players.find((p) => p.resumeToken && p.resumeToken === payload.resumeToken);
      if (!player || player.id !== socket.data.profile?.id) throw new Error('Reconnect token not valid for this account. Join the room again.');
      if (socket.data.roomCode === code && socket.data.playerId === player.id && player.socketId === socket.id) {
        socket.emit('room:joined', { roomCode: room.code, playerId: player.id, resumeToken: player.resumeToken, inviteLink: getInviteLink(room.code) });
        syncRoom(room);
        return;
      }
      const oldSocket = player.socketId ? io.sockets.sockets.get(player.socketId) : null;
      if (oldSocket && oldSocket.id !== socket.id) oldSocket.emit('room:closed', { message: 'This room session was resumed on another connection.' });
      detachCurrentSocket(socket);
      attachPlayer(room, player, socket);
      syncRoom(room);
    } catch (error) { sendError(socket, error); }
  });

  socket.on('lobby:add-bot', () => {
    try {
      const { room, player } = requireRoomPlayer(socket);
      requireHost(room, player);
      addBotToRoom(room);
      syncRoom(room);
    } catch (error) { sendError(socket, error); }
  });

  socket.on('lobby:start', () => {
    try {
      const { room, player } = requireRoomPlayer(socket);
      requireHost(room, player);
      if (room.status !== 'waiting') throw new Error('This game has already started.');
      startRoomGame(room);
      syncRoom(room);
    } catch (error) { sendError(socket, error); }
  });

  socket.on('card:play', (payload = {}) => {
    try {
      const { room, player } = requireRoomPlayer(socket);
      const game = ensureGame(room);
      const result = playCard(game, player.id, safeText(payload.cardId, 64));
      if (result.awaitingColor) {
        // The player selecting a wild color is still the current player.
      } else if (game.status === 'finished') room.status = 'finished';
      syncRoom(room);
    } catch (error) { sendError(socket, error); }
  });

  socket.on('wild:choose', (payload = {}) => {
    try {
      const { room, player } = requireRoomPlayer(socket);
      const game = ensureGame(room);
      chooseColor(game, player.id, safeText(payload.color, 10));
      if (game.status === 'finished') room.status = 'finished';
      syncRoom(room);
    } catch (error) { sendError(socket, error); }
  });

  socket.on('card:draw', () => {
    try {
      const { room, player } = requireRoomPlayer(socket);
      const game = ensureGame(room);
      drawCard(game, player.id);
      syncRoom(room);
    } catch (error) { sendError(socket, error); }
  });

  socket.on('turn:pass', () => {
    try {
      const { room, player } = requireRoomPlayer(socket);
      const game = ensureGame(room);
      passTurn(game, player.id);
      syncRoom(room);
    } catch (error) { sendError(socket, error); }
  });

  socket.on('player:react', (payload = {}) => {
    try {
      const { room, player } = requireRoomPlayer(socket);
      if (!room.game || room.game.status !== 'playing') throw new Error('Reactions are available during a game.');
      const emoji = String(payload.emoji || '');
      if (!VALID_REACTIONS.has(emoji)) throw new Error('That reaction is not supported.');
      player.reaction = emoji;
      io.to(room.code).emit('player:reaction', { playerId: player.id, emoji });
      syncRoom(room);
      setTimeout(() => {
        if (player.reaction === emoji) {
          player.reaction = null;
          syncRoom(room);
        }
      }, 3000).unref?.();
    } catch (error) { sendError(socket, error); }
  });

  socket.on('game:rematch', () => {
    try {
      const { room, player } = requireRoomPlayer(socket);
      if (!room.game || room.game.status !== 'finished') throw new Error('Finish the current game before requesting a rematch.');
      room.rematchVotes.add(player.id);
      player.rematch = true;
      maybeCompleteRematch(room);
      syncRoom(room);
    } catch (error) { sendError(socket, error); }
  });

  socket.on('room:leave', () => {
    try {
      const { room, player } = requireRoomPlayer(socket);
      if (room.status === 'waiting') {
        room.players = room.players.filter((p) => p.id !== player.id);
        if (room.hostId === player.id) room.hostId = room.players.find((p) => !p.isBot)?.id || null;
        socket.leave(room.code);
        socket.data.roomCode = null;
        socket.data.playerId = null;
        socket.emit('room:closed', { message: 'You left the room.' });
        if (!room.players.some((p) => !p.isBot)) cleanRoom(room);
        else syncRoom(room);
      } else {
        // During play, leaving converts the seat to an AI-controlled seat so the game can finish.
        player.socketId = null;
        player.connected = false;
        player.isBot = true;
        player.name = `${player.name} (CPU)`;
        player.resumeToken = null;
        socket.leave(room.code);
        socket.data.roomCode = null;
        socket.data.playerId = null;
        socket.emit('room:closed', { message: 'You left the match.' });
        syncRoom(room);
      }
    } catch (error) { sendError(socket, error); }
  });

  socket.on('disconnect', () => {
    const room = findRoom(socket);
    if (!room) return;
    const player = findPlayer(room, socket.data.playerId);
    if (!player || player.socketId !== socket.id) return;
    player.socketId = null;
    player.connected = false;
    player.reaction = null;
    if (room.status !== 'waiting') player.isBot = true;
    if (room.hostId === player.id) {
      const nextHost = room.players.find((p) => !p.isBot && p.connected) || room.players.find((p) => !p.isBot);
      if (nextHost) room.hostId = nextHost.id;
    }
    if (!room.players.some((p) => !p.isBot)) cleanRoom(room);
    else syncRoom(room);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of ROOMS.values()) {
    if (now - room.createdAt > ROOM_TTL_MS || (!room.players.some((p) => !p.isBot))) cleanRoom(room);
  }
}, 10 * 60 * 1000).unref?.();

httpServer.listen(PORT, () => {
  console.log(`PlayLo listening on http://0.0.0.0:${PORT}`);
  console.log(`Guest browser mode: ${ALLOW_GUESTS ? 'enabled (development only)' : 'disabled'}`);
  if (!BOT_TOKEN) console.warn('BOT_TOKEN is not configured. Telegram authentication and bot commands will not work until you set it in .env.');
});
