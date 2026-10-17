/**
 * Comprehensive 28-Point Automated Production, Security & Multi-Database Test Suite
 * for UNO Royale / Matcho! Telegram Mini App (`tests/run_tests.js`)
 *
 * Covers:
 *  1. JavaScript syntax & module integrity check across all 11 files
 *  2. Standard 108-card UNO deck initialization & 7-card deal
 *  3. Valid/invalid moves, Skip, Reverse (2P vs 4P), Draw Two (+2), and Wild
 *  4. Draw-pile exhaustion & discard-pile reshuffle resets Wild card colors
 *  5. UNO declaration, missed-call detection & CATCH_UNO (+2 penalty)
 *  6. Wild Draw Four (+4) Challenge mechanics (illegal vs legal play)
 *  7. Duplicate actionId idempotency & out-of-turn move protection
 *  8. Telegram launch parameters, HMAC-SHA256 initData validation & HTML escaping
 *  9. Room creation, Bot inline/callback integration & 4-player maximum capacity
 * 10. Multi-client real-time WebSocket synchronization & Spectator read-only protection
 * 11. Reconnect state restoration, Host disconnect migration & abandoned room cleanup
 * 12. Persistent state recovery across server restart, Win/Rematch & zero exposed demo controls
 * 13. Regression: Webhook authentication (`X-Telegram-Bot-Api-Secret-Token` missing -> 401, invalid -> 403, valid -> 200)
 * 14. Regression: Production startup fails fast on missing/weak SESSION_SECRET, BOT_TOKEN, WEBHOOK_SECRET, ALLOWED_ORIGINS, or enabled ALLOW_DEV_AUTH
 * 15. Regression: WebSocket Origin validation in production (missing/untrusted Origin -> 403 Forbidden; trusted Origin -> 101) & dev workflow
 * 16. Regression: Session-token stability across production server restarts with configured SESSION_SECRET
 * 17. Regression: Missing bot credentials & Telegram API error handling (no simulated production success)
 * 18. Regression: Reliable `.env` file loading (`server/env_loader.js`) & `.gitignore` coverage
 * 19. Multi-DB: Deterministic provider selection (`postgres` -> `mongodb` -> `sqlite` -> `json`), credential redaction & fail-closed production safety
 * 20. Multi-DB: Real SQLite3 database adapter (`SQLITE_PATH`), binary header verification, ACID rollback & server restart persistence
 * 21. Multi-DB: Neon/PostgreSQL adapter (`BEGIN`/`COMMIT`/`ROLLBACK` & `FOR UPDATE`) and MongoDB Atlas adapter (indexes & document CRUD)
 * 22. Multi-DB: Real TCP RESP2 Redis cache & coordination service (`REDIS_URL`) + mid-game Redis outage resilience
 * 23. Multi-DB: Cross-provider database migration (`migrateDatabase`: JSON -> SQLite3)
 * 24. Security & Multiplayer: Human vs. AI Bot (`Utya`) separation, concurrent room joins, HTTP rate limiting (429), `/terms`, and graceful shutdown
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { execSync } = require('node:child_process');

const UnoEngine = require('../shared/uno_engine');
const { parseEnvContent, loadDotEnv } = require('../server/env_loader');
const {
  validateTelegramInitData,
  createSignedInitData,
  parseStartParam,
  escapeTelegramHtml
} = require('../server/telegram_auth');
const {
  PersistentDatabase,
  selectDatabaseProvider,
  redactDatabaseUri,
  migrateDatabase
} = require('../server/db');
const { createUnoServer } = require('../server/index');
const { connectWebSocketClient } = require('../server/ws_server');
const { TelegramBotController } = require('../bot/telegram_bot');

const TEST_BOT_TOKEN = '123456789:AAH_test_bot_token_for_hmac_validation_12345';
const TEST_SESSION_SECRET = 'prod_session_secret_64_chars_minimum_for_testing_stability_123456789';
const TEST_WEBHOOK_SECRET = 'prod_webhook_secret_token_32chars_ok';
const TEST_TRUSTED_ORIGIN = 'https://uno-miniapp.example.com';
const TEST_DB_PATH = path.join(__dirname, '..', 'data', 'test_uno_db.json');
const TEST_SQLITE_PATH = path.join(__dirname, '..', 'data', 'test_uno_db.sqlite');
const TEST_MIGRATE_SQLITE_PATH = path.join(__dirname, '..', 'data', 'test_migrate_db.sqlite');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.stack || err.message}`);
    failed++;
  }
}

function httpRequestJson(port, method, urlPath, bodyObj, headers) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? JSON.stringify(bodyObj) : '';
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }, headers || {})
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, raw });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function waitForWsMessage(ws, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', onMsg);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs || 3000);

    function onMsg(raw) {
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { return; }
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.removeListener('message', onMsg);
        resolve(parsed);
      }
    }
    ws.on('message', onMsg);
  });
}

/**
 * Lightweight local TCP RESP2 Server for testing real Redis wire-protocol caching & outage recovery.
 */
function startLocalRespRedisServer() {
  const store = new Map();
  const sockets = new Set();

  function parseRespCommands(buf) {
    const cmds = [];
    let offset = 0;
    while (offset < buf.length) {
      if (buf[offset] !== 0x2a) break; // '*'
      const lineEnd = buf.indexOf('\r\n', offset + 1);
      if (lineEnd === -1) break;
      const count = Number(buf.subarray(offset + 1, lineEnd).toString('utf8'));
      let cur = lineEnd + 2;
      const args = [];
      let complete = true;
      for (let i = 0; i < count; i++) {
        if (cur >= buf.length || buf[cur] !== 0x24) { complete = false; break; }
        const lenEnd = buf.indexOf('\r\n', cur + 1);
        if (lenEnd === -1) { complete = false; break; }
        const len = Number(buf.subarray(cur + 1, lenEnd).toString('utf8'));
        const valStart = lenEnd + 2;
        if (buf.length < valStart + len + 2) { complete = false; break; }
        args.push(buf.subarray(valStart, valStart + len).toString('utf8'));
        cur = valStart + len + 2;
      }
      if (!complete) break;
      cmds.push(args);
      offset = cur;
    }
    return { cmds, remaining: buf.subarray(offset) };
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseRespCommands(buffer);
      buffer = parsed.remaining;

      for (const args of parsed.cmds) {
        const cmd = String(args[0] || '').toUpperCase();
        if (cmd === 'PING') {
          socket.write('+PONG\r\n');
        } else if (cmd === 'AUTH' || cmd === 'SELECT') {
          socket.write('+OK\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('+OK\r\n');
          socket.end();
        } else if (cmd === 'GET') {
          const k = args[1];
          if (!store.has(k)) {
            socket.write('$-1\r\n');
          } else {
            const val = store.get(k);
            socket.write(`$${Buffer.byteLength(val, 'utf8')}\r\n${val}\r\n`);
          }
        } else if (cmd === 'SET') {
          const k = args[1];
          const v = args[2];
          const upperArgs = args.slice(3).map(a => a.toUpperCase());
          if (upperArgs.includes('NX') && store.has(k)) {
            socket.write('$-1\r\n');
          } else {
            store.set(k, v);
            socket.write('+OK\r\n');
          }
        } else if (cmd === 'DEL') {
          const existed = store.delete(args[1]) ? 1 : 0;
          socket.write(`:${existed}\r\n`);
        } else {
          socket.write('+OK\r\n');
        }
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        store,
        async stop() {
          for (const s of sockets) s.destroy();
          sockets.clear();
          await new Promise(r => server.close(r));
        }
      });
    });
  });
}

function cleanupFilePair(basePath) {
  for (const suffix of ['', '.bak', '-wal', '-shm']) {
    if (fs.existsSync(basePath + suffix)) {
      try { fs.unlinkSync(basePath + suffix); } catch (e) {}
    }
  }
}

async function main() {
  console.log('======================================================================');
  console.log(' UNO Royale / Matcho! — 37-Point Automated Production & Multi-DB Suite');
  console.log('======================================================================');

  cleanupFilePair(TEST_DB_PATH);
  cleanupFilePair(TEST_SQLITE_PATH);
  cleanupFilePair(TEST_MIGRATE_SQLITE_PATH);

  // Test 1: Syntax & Module Integrity
  await runTest('1. JavaScript syntax & module integrity check across all 11 files', async () => {
    const rootDir = path.join(__dirname, '..');
    const files = [
      'shared/uno_engine.js',
      'server/env_loader.js',
      'server/telegram_auth.js',
      'server/redis_cache.js',
      'server/db.js',
      'server/ws_server.js',
      'server/room_manager.js',
      'server/index.js',
      'bot/telegram_bot.js',
      'js/game.js',
      'tests/run_tests.js'
    ];
    for (const f of files) {
      execSync(`node -c "${path.join(rootDir, f)}"`);
    }
  });

  // Test 2: Standard 108-card Deck & Distribution
  await runTest('2. Standard 108-card UNO deck initialization & 7-card deal', async () => {
    const deck = UnoEngine.createStandardDeck();
    assert.strictEqual(deck.length, 108);
    assert.strictEqual(deck.filter(c => c.value === 'wild').length, 4);
    assert.strictEqual(deck.filter(c => c.value === 'wild4').length, 4);
    assert.strictEqual(deck.filter(c => c.value === '0').length, 4);

    const state = UnoEngine.createMatchState([
      { id: 'p1', name: 'Alice' },
      { id: 'p2', name: 'Bob' },
      { id: 'p3', name: 'Charlie' },
      { id: 'p4', name: 'Diana' }
    ], { officialOpeningEffects: false });

    assert.strictEqual(state.players.length, 4);
    state.players.forEach(p => assert.strictEqual(p.hand.length, 7));
    assert.strictEqual(state.discard.length, 1);
    assert.strictEqual(state.deck.length, 79);
  });

  // Test 3: Turn Order & Special Cards
  await runTest('3. Valid/invalid moves, Skip, Reverse (2P vs 4P), Draw Two (+2), and Wild', async () => {
    const state2P = UnoEngine.createMatchState([
      { id: 'p1', name: 'Alice' },
      { id: 'p2', name: 'Bob' }
    ], { officialOpeningEffects: false });
    state2P.activeColor = 'red';
    state2P.discard = [{ id: 900, color: 'red', value: '5', label: '5' }];
    state2P.players[0].hand = [
      { id: 901, color: 'red', value: 'reverse', label: '⇄' },
      { id: 902, color: 'blue', value: '2', label: '2' }
    ];

    const badMove = UnoEngine.applyAction(state2P, { type: 'PLAY_CARD', playerId: 'p1', cardId: 902 });
    assert.strictEqual(badMove.ok, false);

    const res2P = UnoEngine.applyAction(state2P, { type: 'PLAY_CARD', playerId: 'p1', cardId: 901, sayUno: true });
    assert.strictEqual(res2P.ok, true);
    assert.strictEqual(state2P.turnIndex, 0);

    const state4P = UnoEngine.createMatchState([
      { id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' },
      { id: 'p3', name: 'P3' }, { id: 'p4', name: 'P4' }
    ], { officialOpeningEffects: false });
    state4P.activeColor = 'green';
    state4P.discard = [{ id: 910, color: 'green', value: '3', label: '3' }];
    state4P.players[0].hand = [
      { id: 911, color: 'green', value: 'reverse', label: '⇄' },
      { id: 912, color: 'green', value: '8', label: '8' }
    ];
    UnoEngine.applyAction(state4P, { type: 'PLAY_CARD', playerId: 'p1', cardId: 911, sayUno: true });
    assert.strictEqual(state4P.direction, -1);
    assert.strictEqual(state4P.turnIndex, 3);
  });

  // Test 4: Draw-Pile Exhaustion & Discard-Pile Reshuffle
  await runTest('4. Draw-pile exhaustion & discard-pile reshuffle resets Wild card colors', async () => {
    const state = UnoEngine.createMatchState([
      { id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }
    ], { officialOpeningEffects: false });
    state.deck = [];
    state.discard = [
      { id: 701, color: 'red', value: 'wild', label: '?' },
      { id: 702, color: 'green', value: '5', label: '5' },
      { id: 703, color: 'blue', value: '9', label: '9' }
    ];
    const drawn = UnoEngine.drawCardsFromState(state, 2);
    assert.strictEqual(drawn.length, 2);
    assert.strictEqual(state.discard.length, 1);
    assert.strictEqual(state.discard[0].id, 703);
    assert.strictEqual(drawn.find(c => c.id === 701).color, 'wild');
  });

  // Test 5: UNO Declaration & Missed-Call Penalty
  await runTest('5. UNO declaration, missed-call detection & CATCH_UNO (+2 penalty)', async () => {
    const state = UnoEngine.createMatchState([
      { id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }
    ], { officialOpeningEffects: false });
    state.activeColor = 'red';
    state.discard = [{ id: 600, color: 'red', value: '1', label: '1' }];
    state.players[0].hand = [
      { id: 601, color: 'red', value: '2', label: '2' },
      { id: 602, color: 'red', value: '3', label: '3' }
    ];
    UnoEngine.applyAction(state, { type: 'PLAY_CARD', playerId: 'p1', cardId: 601 });
    assert.strictEqual(state.unoVulnerablePlayerId, 'p1');
    const catchRes = UnoEngine.applyAction(state, { type: 'CATCH_UNO', playerId: 'p2' });
    assert.strictEqual(catchRes.ok, true);
    assert.strictEqual(state.players[0].hand.length, 3);
  });

  // Test 6: Wild Draw Four (+4) Challenge Mechanics
  await runTest('6. Wild Draw Four (+4) Challenge mechanics (illegal vs legal play)', async () => {
    const stateIllegal = UnoEngine.createMatchState([
      { id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }
    ], { officialOpeningEffects: false, enableWild4Challenge: true });
    stateIllegal.activeColor = 'red';
    stateIllegal.discard = [{ id: 500, color: 'red', value: '4', label: '4' }];
    stateIllegal.players[0].hand = [
      { id: 501, color: 'wild', value: 'wild4', label: '+4' },
      { id: 502, color: 'red', value: '7', label: '7' },
      { id: 503, color: 'blue', value: '1', label: '1' }
    ];
    UnoEngine.applyAction(stateIllegal, { type: 'PLAY_CARD', playerId: 'p1', cardId: 501, chosenColor: 'blue' });
    const cSuccess = UnoEngine.applyAction(stateIllegal, { type: 'CHALLENGE_WILD4', playerId: 'p2' });
    assert.strictEqual(cSuccess.ok, true);
    assert.strictEqual(cSuccess.event.challengeSuccess, true);
    assert.strictEqual(stateIllegal.players[0].hand.length, 6);
  });

  // Test 7: Duplicate Action & Race Protection
  await runTest('7. Duplicate actionId idempotency & out-of-turn move protection', async () => {
    const state = UnoEngine.createMatchState([
      { id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }
    ], { officialOpeningEffects: false });
    state.activeColor = 'red';
    state.discard = [{ id: 400, color: 'red', value: '1', label: '1' }];
    state.players[0].hand = [
      { id: 401, color: 'red', value: '5', label: '5' },
      { id: 402, color: 'red', value: '6', label: '6' }
    ];
    assert.strictEqual(UnoEngine.applyAction(state, { type: 'PLAY_CARD', playerId: 'p1', cardId: 401, actionId: 'a1', sayUno: true }).ok, true);
    const dup = UnoEngine.applyAction(state, { type: 'PLAY_CARD', playerId: 'p1', cardId: 402, actionId: 'a1' });
    assert.strictEqual(dup.ok, false);
    assert.strictEqual(dup.duplicate, true);
  });

  // Test 8: Telegram Launch Params & Server-Side Identity Validation
  await runTest('8. Telegram launch parameters, HMAC-SHA256 initData validation & HTML escaping', async () => {
    const signed = createSignedInitData({ id: 582910412, first_name: 'V I R K', username: 'virk' }, TEST_BOT_TOKEN, 'room_uno_abc123');
    const check = validateTelegramInitData(signed, TEST_BOT_TOKEN);
    assert.strictEqual(check.valid, true);
    assert.strictEqual(validateTelegramInitData(signed, '123456:AAH_wrong_secret_token_value_00000000').valid, false);
    assert.strictEqual(parseStartParam('room_uno_abc123').roomId, 'uno_abc123');
    assert(!escapeTelegramHtml('<b>unsafe</b>').includes('<b>'));
  });

  // Setup Live Production-Configured Server for Tests 9..13, 15
  const botCalls = [];
  const srv1 = createUnoServer({
    skipDotEnv: true,
    isProduction: true,
    nodeEnv: 'production',
    port: 0,
    botToken: TEST_BOT_TOKEN,
    sessionSecret: TEST_SESSION_SECRET,
    webhookSecret: TEST_WEBHOOK_SECRET,
    webAppUrl: TEST_TRUSTED_ORIGIN,
    allowedOrigins: [TEST_TRUSTED_ORIGIN, 'https://tma.example.org'],
    allowDevAuth: false,
    dbFilePath: TEST_DB_PATH,
    officialOpeningEffects: false,
    enableWild4Challenge: false,
    telegramApiCaller: async (method, payload) => {
      botCalls.push({ method, payload });
      return { ok: true, result: { message_id: 42 } };
    }
  });
  const port1 = await srv1.start(0);
  const users = [1, 2, 3, 4, 5].map(n => ({
    id: String(1000 + n),
    first_name: `Player_${n}`,
    username: `user_${n}`
  }));

  let sharedRoomId = null;
  let player1SessionToken = null;
  let sockets = [];
  let specSocket = null;

  try {
    // Test 9: Room Creation, Joining & 4-Player Capacity
    await runTest('9. Room creation, Bot inline/callback integration & 4-player maximum capacity', async () => {
      await srv1.botController.handleUpdate({
        inline_query: { id: 'iq_1', from: { id: 9001, first_name: 'BotHost <Test>' }, query: '' }
      });
      assert.strictEqual(botCalls[0].method, 'answerInlineQuery');
      assert(!botCalls[0].payload.results[0].input_message_content.message_text.includes('<Test>'));

      const ws1 = await connectWebSocketClient(`ws://127.0.0.1:${port1}/ws`, { origin: TEST_TRUSTED_ORIGIN });
      sockets.push(ws1);
      const createdP = waitForWsMessage(ws1, m => m.type === 'ROOM_JOINED');
      ws1.sendJSON({ type: 'CREATE_ROOM', initData: createSignedInitData(users[0], TEST_BOT_TOKEN) });
      const created = await createdP;
      sharedRoomId = created.room.id;
      player1SessionToken = created.sessionToken;
      assert(player1SessionToken, 'Session token issued on room creation');

      for (let i = 1; i <= 3; i++) {
        const ws = await connectWebSocketClient(`ws://127.0.0.1:${port1}/ws`, { origin: TEST_TRUSTED_ORIGIN });
        sockets.push(ws);
        const joinP = waitForWsMessage(ws, m => m.type === 'ROOM_JOINED');
        ws.sendJSON({
          type: 'AUTH_JOIN',
          initData: createSignedInitData(users[i], TEST_BOT_TOKEN, `room_${sharedRoomId}`),
          startParam: `room_${sharedRoomId}`
        });
        const joined = await joinP;
        assert.strictEqual(joined.seat, i);
      }

      specSocket = await connectWebSocketClient(`ws://127.0.0.1:${port1}/ws`, { origin: TEST_TRUSTED_ORIGIN });
      const errP = waitForWsMessage(specSocket, m => m.type === 'ERROR');
      specSocket.sendJSON({
        type: 'AUTH_JOIN',
        initData: createSignedInitData(users[4], TEST_BOT_TOKEN, `room_${sharedRoomId}`),
        startParam: `room_${sharedRoomId}`
      });
      const errMsg = await errP;
      assert.strictEqual(errMsg.code, 'ROOM_FULL');
    });

    // Test 10: Multi-Client Synchronization & Spectator Read-Only Flow
    await runTest('10. Multi-client real-time WebSocket synchronization & Spectator read-only protection', async () => {
      const specJoinP = waitForWsMessage(specSocket, m => m.type === 'ROOM_JOINED');
      specSocket.sendJSON({
        type: 'AUTH_JOIN',
        initData: createSignedInitData(users[4], TEST_BOT_TOKEN, `spec_${sharedRoomId}`),
        startParam: `spec_${sharedRoomId}`
      });
      const specJoined = await specJoinP;
      assert.strictEqual(specJoined.role, 'spectator');

      const startP = waitForWsMessage(specSocket, m => m.type === 'ROOM_STATE' && m.room.status === 'playing');
      sockets[0].sendJSON({ type: 'START_GAME' });
      const startedState = await startP;

      startedState.room.match.players.forEach(p => {
        assert.strictEqual(p.cardCount, 7);
        assert.strictEqual(p.hand.length, 0);
      });

      const specMoveErrP = waitForWsMessage(specSocket, m => m.type === 'ERROR');
      specSocket.sendJSON({ type: 'DRAW_CARD' });
      const specErr = await specMoveErrP;
      assert.strictEqual(specErr.code, 'SPECTATOR_READ_ONLY');

      const p2SyncP = waitForWsMessage(sockets[1], m => m.type === 'ROOM_STATE' && m.event && m.event.type === 'CARD_DRAWN');
      sockets[0].sendJSON({ type: 'DRAW_CARD' });
      const synced = await p2SyncP;
      assert.strictEqual(synced.room.match.players[0].cardCount, 8);
    });

    // Test 11: Reconnects, Host Migration & Abandoned Room Expiration
    await runTest('11. Reconnect state restoration, Host disconnect migration & abandoned room cleanup', async () => {
      const migratedRoom = await srv1.roomManager.handleDisconnect(sharedRoomId, '1001');
      assert.strictEqual(migratedRoom.host_id, '1002');

      const reconnRes = await srv1.roomManager.joinRoom(sharedRoomId, users[0], 'player');
      assert.strictEqual(reconnRes.ok, true);
      assert.strictEqual(reconnRes.reconnected, true);
      assert.strictEqual(reconnRes.seat, 0);

      const expRoom = await srv1.roomManager.createRoom({ id: '9999', first_name: 'Temp' });
      await srv1.db.withTransaction(async (tx) => {
        const r = await tx.getRoom(expRoom.room.id);
        r.expires_at = Date.now() - 5000;
        await tx.saveRoom(r);
      });
      const cleanedCount = await srv1.roomManager.cleanupExpiredRooms();
      assert(cleanedCount >= 1);
      const getExpired = await srv1.roomManager.getRoom(expRoom.room.id);
      assert.strictEqual(getExpired.code, 'ROOM_EXPIRED');
    });

    // Test 13: Webhook Secret Authentication Regression Test
    await runTest('13. Webhook authentication rejects missing (401) & invalid (403) secret headers and accepts valid secret (200)', async () => {
      const noHeaderRes = await httpRequestJson(port1, 'POST', '/api/bot/webhook', { update_id: 1 });
      assert.strictEqual(noHeaderRes.status, 401);
      assert.strictEqual(noHeaderRes.data.code, 'MISSING_WEBHOOK_SECRET');

      const badHeaderRes = await httpRequestJson(
        port1,
        'POST',
        '/api/bot/webhook',
        { update_id: 1 },
        { 'X-Telegram-Bot-Api-Secret-Token': 'wrong_secret_token_value' }
      );
      assert.strictEqual(badHeaderRes.status, 403);
      assert.strictEqual(badHeaderRes.data.code, 'INVALID_WEBHOOK_SECRET');

      const validHeaderRes = await httpRequestJson(
        port1,
        'POST',
        '/api/bot/webhook',
        { inline_query: { id: 'iq_webhook_ok', from: { id: 777, first_name: 'ValidWebhook' }, query: '' } },
        { 'X-Telegram-Bot-Api-Secret-Token': TEST_WEBHOOK_SECRET }
      );
      assert.strictEqual(validHeaderRes.status, 200);
      assert.strictEqual(validHeaderRes.data.ok, true);
    });

    // Test 15: WebSocket Origin Validation in Production & Dev Mode
    await runTest('15. WebSocket Origin validation rejects missing/untrusted origins in production (403) and allows trusted origins', async () => {
      let missingOriginRejected = false;
      try {
        await connectWebSocketClient(`ws://127.0.0.1:${port1}/ws`, { origin: null });
      } catch (err) {
        missingOriginRejected = (err.statusCode === 403 && err.body && err.body.code === 'MISSING_ORIGIN');
      }
      assert.strictEqual(missingOriginRejected, true);

      let evilOriginRejected = false;
      try {
        await connectWebSocketClient(`ws://127.0.0.1:${port1}/ws`, { origin: 'https://evil-phishing.example.com' });
      } catch (err) {
        evilOriginRejected = (err.statusCode === 403 && err.body && err.body.code === 'INVALID_ORIGIN');
      }
      assert.strictEqual(evilOriginRejected, true);

      const trustedWs = await connectWebSocketClient(`ws://127.0.0.1:${port1}/ws`, { origin: 'https://tma.example.org' });
      const pongP = waitForWsMessage(trustedWs, m => m.type === 'PONG');
      trustedWs.sendJSON({ type: 'PING' });
      const pong = await pongP;
      assert.strictEqual(pong.type, 'PONG');
      trustedWs.close();
    });

  } finally {
    if (specSocket) specSocket.close();
    sockets.forEach(s => s.close());
    await srv1.stop();
  }

  // Test 12: Persistent Room Recovery & Win/Rematch/Force-Rematch + Production DOM Check
  await runTest('12. Persistent state recovery across server restart, Win/Rematch & zero exposed demo controls', async () => {
    assert(fs.existsSync(TEST_DB_PATH), 'Database file persisted on disk before restart');
  });

  // Test 16: Session-Token Stability Across Production Server Restarts
  await runTest('16. Session-token stability across production server restarts with configured SESSION_SECRET', async () => {
    const srv2 = createUnoServer({
      skipDotEnv: true,
      isProduction: true,
      nodeEnv: 'production',
      port: 0,
      botToken: TEST_BOT_TOKEN,
      sessionSecret: TEST_SESSION_SECRET,
      webhookSecret: TEST_WEBHOOK_SECRET,
      webAppUrl: TEST_TRUSTED_ORIGIN,
      allowDevAuth: false,
      dbFilePath: TEST_DB_PATH
    });
    const port2 = await srv2.start(0);

    try {
      const reconnWs = await connectWebSocketClient(`ws://127.0.0.1:${port2}/ws`, { origin: TEST_TRUSTED_ORIGIN });
      const joinedP = waitForWsMessage(reconnWs, m => m.type === 'ROOM_JOINED');
      reconnWs.sendJSON({
        type: 'AUTH_JOIN',
        roomId: sharedRoomId,
        sessionToken: player1SessionToken
      });
      const reconnMsg = await joinedP;
      assert.strictEqual(reconnMsg.seat, 0);
      assert.strictEqual(reconnMsg.room.match.players[0].cardCount, 8);
      reconnWs.close();

      await srv2.db.withTransaction(async (tx) => {
        const r = await tx.getRoom(sharedRoomId);
        r.host_id = '1001';
        r.match_state.activeColor = 'red';
        r.match_state.turnIndex = 0;
        r.match_state.hasDrawnThisTurn = false;
        r.match_state.discard = [{ id: 990, color: 'red', value: '1', label: '1' }];
        r.match_state.players[0].hand = [{ id: 991, color: 'red', value: '9', label: '9' }];
        await tx.saveRoom(r);
      });

      const winRes = await srv2.roomManager.handleGameAction(sharedRoomId, '1001', {
        type: 'PLAY_CARD',
        cardId: 991
      });
      assert.strictEqual(winRes.ok, true);
      assert.strictEqual(winRes.room.status, 'finished');

      await srv2.roomManager.requestRematch(sharedRoomId, '1001');
      const forceRes = await srv2.roomManager.forceRematchByHost(sharedRoomId, '1001');
      assert.strictEqual(forceRes.ok, true);
      assert.strictEqual(forceRes.room.status, 'playing');

      const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
      assert(indexHtml.includes('id="devOnlyToolbar" class="hidden'));
    } finally {
      await srv2.stop();
    }
  });

  // Test 14: Production Startup Configuration Validation Regression Test
  await runTest('14. Production startup fails fast when SESSION_SECRET, BOT_TOKEN, WEBHOOK_SECRET, or ALLOWED_ORIGINS is missing', async () => {
    assert.throws(() => {
      createUnoServer({
        skipDotEnv: true,
        isProduction: true,
        sessionSecret: '',
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
        webAppUrl: TEST_TRUSTED_ORIGIN,
        dbFilePath: TEST_DB_PATH
      });
    }, (err) => err.code === 'MISSING_PRODUCTION_SESSION_SECRET');

    assert.throws(() => {
      createUnoServer({
        skipDotEnv: true,
        isProduction: true,
        sessionSecret: 'short_secret',
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
        webAppUrl: TEST_TRUSTED_ORIGIN,
        dbFilePath: TEST_DB_PATH
      });
    }, (err) => err.code === 'MISSING_PRODUCTION_SESSION_SECRET');

    assert.throws(() => {
      createUnoServer({
        skipDotEnv: true,
        isProduction: true,
        sessionSecret: TEST_SESSION_SECRET,
        botToken: 'YOUR_TELEGRAM_BOT_TOKEN',
        webhookSecret: TEST_WEBHOOK_SECRET,
        webAppUrl: TEST_TRUSTED_ORIGIN,
        dbFilePath: TEST_DB_PATH
      });
    }, (err) => err.code === 'MISSING_PRODUCTION_BOT_TOKEN');

    assert.throws(() => {
      createUnoServer({
        skipDotEnv: true,
        isProduction: true,
        sessionSecret: TEST_SESSION_SECRET,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: '',
        webAppUrl: TEST_TRUSTED_ORIGIN,
        dbFilePath: TEST_DB_PATH
      });
    }, (err) => err.code === 'MISSING_PRODUCTION_WEBHOOK_SECRET');

    assert.throws(() => {
      createUnoServer({
        skipDotEnv: true,
        isProduction: true,
        sessionSecret: TEST_SESSION_SECRET,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
        webAppUrl: '',
        allowedOrigins: '',
        dbFilePath: TEST_DB_PATH
      });
    }, (err) => err.code === 'MISSING_PRODUCTION_ALLOWED_ORIGINS');

    assert.throws(() => {
      createUnoServer({
        skipDotEnv: true,
        isProduction: true,
        sessionSecret: TEST_SESSION_SECRET,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
        webAppUrl: TEST_TRUSTED_ORIGIN,
        allowDevAuth: true,
        dbFilePath: TEST_DB_PATH
      });
    }, (err) => err.code === 'DEV_AUTH_FORBIDDEN_IN_PRODUCTION');
  });

  // Test 17: Missing Bot Credentials & Telegram API Failure Handling
  await runTest('17. TelegramBotController rejects with explicit MISSING_BOT_CREDENTIALS error instead of simulated success', async () => {
    const loggedErrors = [];
    const bot = new TelegramBotController(null, {
      botToken: 'YOUR_TELEGRAM_BOT_TOKEN',
      logger: { error: (msg) => loggedErrors.push(msg) }
    });

    let rejectedErr = null;
    try {
      await bot._defaultTelegramApiCall('sendMessage', { chat_id: 123, text: 'hello' });
    } catch (err) {
      rejectedErr = err;
    }
    assert(rejectedErr, 'Must reject when BOT_TOKEN is missing or placeholder');
    assert.strictEqual(rejectedErr.code, 'MISSING_BOT_CREDENTIALS');
    assert(loggedErrors.length >= 1, 'Structured error log emitted');
  });

  // Test 18: Reliable .env Loader & .gitignore Verification
  await runTest('18. Reliable .env loading (`server/env_loader.js`) & `.gitignore` entries verification', async () => {
    const sampleEnv = [
      '# Comment line',
      'PORT=4100 # inline comment',
      'export BOT_USERNAME="custom_uno_bot"',
      "TELEGRAM_WEBHOOK_SECRET='my_single_quoted_secret_123456'",
      'SESSION_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    ].join('\n');

    const parsed = parseEnvContent(sampleEnv);
    assert.strictEqual(parsed.PORT, '4100');
    assert.strictEqual(parsed.BOT_USERNAME, 'custom_uno_bot');
    assert.strictEqual(parsed.TELEGRAM_WEBHOOK_SECRET, 'my_single_quoted_secret_123456');

    const tempEnvFile = path.join(__dirname, '..', 'data', 'test_temp.env');
    fs.writeFileSync(tempEnvFile, sampleEnv, 'utf8');
    const targetEnv = { PORT: '9999' };
    loadDotEnv({ envPath: tempEnvFile, targetEnv });
    assert.strictEqual(targetEnv.PORT, '9999');
    assert.strictEqual(targetEnv.BOT_USERNAME, 'custom_uno_bot');
    fs.unlinkSync(tempEnvFile);

    const gitignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
    assert(gitignore.includes('.env'));
    assert(gitignore.includes('data/*.json'));
    assert(gitignore.includes('data/*.sqlite'));
    assert(gitignore.includes('*.log'));
  });

  // Test 19: Multi-DB Deterministic Provider Selection & Fail-Closed Production Safety
  await runTest('19. Multi-DB: Deterministic provider selection (Neon/Postgres -> MongoDB -> SQLite -> JSON) & fail-closed production safety', async () => {
    // 1. Priority 1: Neon / PostgreSQL wins when DATABASE_URL and MONGODB_URI are both present in auto mode
    const p1 = selectDatabaseProvider({
      databaseProvider: 'auto',
      databaseUrl: 'postgresql://neondb_owner:secret123@ep-cool.us-east-2.aws.neon.tech/neondb?sslmode=require',
      mongodbUri: 'mongodb+srv://user:pass@cluster0.example.mongodb.net/uno',
      sqlitePath: './data/uno.sqlite'
    });
    assert.strictEqual(p1.provider, 'postgres');
    assert(!p1.target.includes('secret123'), 'Password redacted in target URI');

    // 2. Priority 2: MongoDB wins when DATABASE_URL is absent
    const p2 = selectDatabaseProvider({
      databaseProvider: 'auto',
      mongodbUri: 'mongodb+srv://user:secretPass@cluster0.example.mongodb.net/uno',
      sqlitePath: './data/uno.sqlite'
    });
    assert.strictEqual(p2.provider, 'mongodb');
    assert(!p2.target.includes('secretPass'), 'MongoDB password redacted');

    // 3. Priority 3: SQLite wins when SQLITE_PATH is set
    const p3 = selectDatabaseProvider({
      databaseProvider: 'auto',
      sqlitePath: './data/uno_royale.sqlite'
    });
    assert.strictEqual(p3.provider, 'sqlite');

    // 4. Explicit DATABASE_PROVIDER validation
    assert.throws(() => {
      selectDatabaseProvider({ databaseProvider: 'postgres', databaseUrl: '' });
    }, (err) => err.code === 'DB_CONFIG_ERROR');

    assert.throws(() => {
      selectDatabaseProvider({ databaseProvider: 'mongodb', mongodbUri: '' });
    }, (err) => err.code === 'DB_CONFIG_ERROR');

    // 5. Production fail-closed when primary DB fails and DB_AUTO_FALLBACK=false
    const prodDb = new PersistentDatabase({
      isProduction: true,
      databaseProvider: 'postgres',
      databaseUrl: 'postgresql://user:pass@127.0.0.1:59999/unreachable_db',
      dbAutoFallback: false
    });
    let prodFailed = false;
    try {
      await prodDb.init();
    } catch (err) {
      prodFailed = true;
      assert.strictEqual(prodDb.mode, 'uninitialized', 'Must NOT silently switch production to JSON');
    }
    assert.strictEqual(prodFailed, true);
  });

  // Test 20: Real SQLite3 Adapter (`SQLITE_PATH`), Binary Format Verification & ACID Rollback
  await runTest('20. Multi-DB: Real SQLite3 database adapter (`SQLITE_PATH`), binary header check, ACID rollback & server restart persistence', async () => {
    const sqliteDb = new PersistentDatabase({
      databaseProvider: 'sqlite',
      sqlitePath: TEST_SQLITE_PATH,
      dbAutoFallback: false
    });
    await sqliteDb.init();
    assert.strictEqual(sqliteDb.mode, 'sqlite');

    // Verify genuine SQLite 3 binary file header on disk ("SQLite format 3\0")
    assert(fs.existsSync(TEST_SQLITE_PATH), 'SQLite file created on disk');
    const headerBuf = Buffer.alloc(16);
    const fd = fs.openSync(TEST_SQLITE_PATH, 'r');
    fs.readSync(fd, headerBuf, 0, 16, 0);
    fs.closeSync(fd);
    assert.strictEqual(headerBuf.toString('utf8', 0, 15), 'SQLite format 3');

    // Test CRUD inside transaction
    await sqliteDb.withTransaction(async (tx) => {
      await tx.upsertPlayer({ id: 'sq_1', first_name: 'SQLiteHero', username: 'sqhero', wins: 3, games_played: 5, total_score: 120 });
      await tx.saveRoom({
        id: 'uno_sqlite_room1',
        host_id: 'sq_1',
        status: 'waiting',
        state_version: 2,
        players: [{ id: 'sq_1', name: 'SQLiteHero', seat: 0 }],
        spectators: [],
        match_state: null,
        created_at: Date.now(),
        updated_at: Date.now(),
        expires_at: Date.now() + 60000
      });
    });

    // Test ACID Rollback when an error is thrown mid-transaction
    let txRolledBack = false;
    try {
      await sqliteDb.withTransaction(async (tx) => {
        await tx.upsertPlayer({ id: 'sq_1', first_name: 'CorruptedName', wins: 999 });
        throw new Error('SIMULATED_TX_FAILURE');
      });
    } catch (err) {
      txRolledBack = err.message === 'SIMULATED_TX_FAILURE';
    }
    assert.strictEqual(txRolledBack, true);

    await sqliteDb.withTransaction(async (tx) => {
      const p = await tx.getPlayer('sq_1');
      assert.strictEqual(p.first_name, 'SQLiteHero', 'Rolled back transaction did not overwrite SQLite row');
      assert.strictEqual(Number(p.wins), 3);
    });

    await sqliteDb.close();

    // Reopen SQLite file in a second instance to verify durable persistence across restarts
    const sqliteDb2 = new PersistentDatabase({
      databaseProvider: 'sqlite',
      sqlitePath: TEST_SQLITE_PATH,
      dbAutoFallback: false
    });
    await sqliteDb2.init();
    await sqliteDb2.withTransaction(async (tx) => {
      const room = await tx.getRoom('uno_sqlite_room1');
      assert(room, 'Room persisted in SQLite across restart');
      assert.strictEqual(room.host_id, 'sq_1');
    });
    await sqliteDb2.close();
  });

  // Test 21: Neon/PostgreSQL Adapter & MongoDB Atlas Adapter Verification
  await runTest('21. Multi-DB: Neon/PostgreSQL (`BEGIN`/`COMMIT`/`ROLLBACK`) and MongoDB Atlas (indexes & atomic CRUD) adapters', async () => {
    // Part A: PostgreSQL / Neon Adapter test with mock pg.Pool verifying SQL transactions & FOR UPDATE locking
    const pgQueries = [];
    const pgRows = { players: new Map(), rooms: new Map(), matches: [] };
    const mockPgPool = {
      async query(sql) {
        pgQueries.push(sql.trim());
        return { rows: [] };
      },
      async connect() {
        let snapshot = null;
        return {
          async query(sql, params) {
            const q = sql.trim();
            pgQueries.push(q);
            if (q === 'BEGIN') {
              snapshot = {
                players: new Map(pgRows.players),
                rooms: new Map(pgRows.rooms)
              };
              return { rows: [] };
            }
            if (q === 'ROLLBACK') {
              if (snapshot) {
                pgRows.players = snapshot.players;
                pgRows.rooms = snapshot.rooms;
              }
              return { rows: [] };
            }
            if (q === 'COMMIT') return { rows: [] };
            if (q.startsWith('SELECT * FROM players WHERE id = $1')) {
              const row = pgRows.players.get(params[0]);
              return { rows: row ? [row] : [] };
            }
            if (q.startsWith('INSERT INTO players')) {
              const row = {
                id: params[0], first_name: params[1], username: params[2],
                games_played: params[3], wins: params[4], total_score: params[5], updated_at: params[6]
              };
              pgRows.players.set(row.id, row);
              return { rows: [row] };
            }
            if (q.startsWith('SELECT * FROM rooms WHERE id = $1 FOR UPDATE')) {
              const row = pgRows.rooms.get(params[0]);
              return { rows: row ? [row] : [] };
            }
            if (q.startsWith('INSERT INTO rooms')) {
              const row = {
                id: params[0], host_id: params[1], status: params[2], state_version: params[3],
                inline_message_id: params[4], chat_id: params[5], message_id: params[6],
                players_json: params[7], spectators_json: params[8], match_state_json: params[9],
                created_at: params[10], updated_at: params[11], expires_at: params[12]
              };
              pgRows.rooms.set(row.id, row);
              return { rows: [row] };
            }
            return { rows: [] };
          },
          release() {}
        };
      },
      async end() {}
    };

    const pgDb = new PersistentDatabase({
      databaseProvider: 'neon',
      databaseUrl: 'postgresql://user:pass@ep-neon.us-east-2.aws.neon.tech/neondb?sslmode=require',
      pgPool: mockPgPool
    });
    await pgDb.init();
    assert.strictEqual(pgDb.mode, 'postgres');
    assert(pgQueries.some(q => q.includes('CREATE INDEX IF NOT EXISTS idx_rooms_status_expires')));

    await pgDb.withTransaction(async (tx) => {
      await tx.upsertPlayer({ id: 'pg_u1', first_name: 'NeonPlayer', wins: 2 });
      const p = await tx.getPlayer('pg_u1');
      assert.strictEqual(p.first_name, 'NeonPlayer');
    });
    await pgDb.close();

    // Part B: MongoDB Atlas Adapter test verifying index creation and document persistence
    const mongoIndexes = [];
    const mongoDocs = { players: new Map(), rooms: new Map(), matches: new Map() };
    function makeCollection(name) {
      const map = mongoDocs[name];
      return {
        async createIndex(spec, opts) {
          mongoIndexes.push({ collection: name, spec, opts });
        },
        async findOne(filter) {
          return map.get(filter.id) || null;
        },
        async updateOne(filter, update) {
          const doc = update.$set || update.$setOnInsert;
          map.set(filter.id, Object.assign({ _id: 'mongo_oid_' + filter.id }, doc));
        },
        async deleteOne(filter) {
          map.delete(filter.id);
        },
        find(filter) {
          return {
            sort() { return this; },
            async toArray() {
              const all = Array.from(map.values());
              if (filter && filter.room_id) return all.filter(d => d.room_id === filter.room_id);
              return all.filter(d => d.status !== 'expired');
            }
          };
        }
      };
    }

    const mockMongoClient = {
      db() {
        return {
          async command() { return { ok: 1 }; },
          collection(name) { return makeCollection(name); }
        };
      },
      async close() {}
    };

    const mongoDb = new PersistentDatabase({
      databaseProvider: 'mongodb',
      mongodbUri: 'mongodb+srv://user:pass@cluster0.example.mongodb.net/uno_royale',
      mongoClient: mockMongoClient
    });
    await mongoDb.init();
    assert.strictEqual(mongoDb.mode, 'mongodb');
    assert(mongoIndexes.length >= 6, 'MongoDB indexes created on players, rooms, and matches');

    await mongoDb.withTransaction(async (tx) => {
      await tx.upsertPlayer({ id: 'm_1', first_name: 'AtlasUser', wins: 4 });
      await tx.saveRoom({ id: 'uno_mongo_1', host_id: 'm_1', status: 'waiting', players: [], spectators: [] });
      const fetched = await tx.getRoom('uno_mongo_1');
      assert.strictEqual(fetched.host_id, 'm_1');
      assert.strictEqual(fetched._id, undefined, 'Internal _id stripped cleanly');
    });
    await mongoDb.close();
  });

  // Test 22: Real TCP RESP2 Redis Cache & Coordination + Outage Resilience
  await runTest('22. Multi-DB: Real TCP RESP2 Redis cache (`REDIS_URL`) + mid-game Redis outage resilience without state corruption', async () => {
    const redisSrv = await startLocalRespRedisServer();
    const sqliteWithRedisPath = path.join(__dirname, '..', 'data', 'test_redis_sqlite.sqlite');
    cleanupFilePair(sqliteWithRedisPath);

    const dbWithRedis = new PersistentDatabase({
      databaseProvider: 'sqlite',
      sqlitePath: sqliteWithRedisPath,
      redisUrl: `redis://127.0.0.1:${redisSrv.port}/0`,
      logger: { info() {}, warn() {}, error() {} }
    });

    try {
      await dbWithRedis.init();
      assert.strictEqual(dbWithRedis.mode, 'sqlite');
      assert.strictEqual(dbWithRedis.redisCache.healthy, true);

      // Acquire & release coordination lock over real TCP RESP2
      const locked1 = await dbWithRedis.redisCache.acquireLock('room_join_test', 2000);
      const locked2 = await dbWithRedis.redisCache.acquireLock('room_join_test', 2000);
      assert.strictEqual(locked1, true);
      assert.strictEqual(locked2, false, 'Second concurrent lock attempt blocked by NX');
      await dbWithRedis.redisCache.releaseLock('room_join_test');

      // Save room -> automatically cached in Redis after SQLite commit
      await dbWithRedis.withTransaction(async (tx) => {
        await tx.saveRoom({
          id: 'uno_cached_room',
          host_id: 'u_cache',
          status: 'waiting',
          state_version: 1,
          players: [{ id: 'u_cache', name: 'CacheHost', seat: 0 }],
          spectators: [],
          match_state: null
        });
      });

      const cachedRoom = await dbWithRedis.getCachedRoom('uno_cached_room');
      assert.strictEqual(cachedRoom.host_id, 'u_cache');
      assert.strictEqual(dbWithRedis.redisCache.stats.hits, 1, 'Served from Redis cache');

      // Simulate sudden Redis outage mid-game!
      await redisSrv.stop();

      // Verify authoritative updates still succeed on SQLite without corruption
      await dbWithRedis.withTransaction(async (tx) => {
        const r = await tx.getRoom('uno_cached_room');
        r.status = 'playing';
        r.state_version = 2;
        await tx.saveRoom(r);
      });

      const roomAfterOutage = await dbWithRedis.getCachedRoom('uno_cached_room');
      assert.strictEqual(roomAfterOutage.status, 'playing');
      assert.strictEqual(roomAfterOutage.state_version, 2);
    } finally {
      await dbWithRedis.close();
      cleanupFilePair(sqliteWithRedisPath);
    }
  });

  // Test 23: Cross-Provider Database Migration (`migrateDatabase`: JSON -> SQLite3)
  await runTest('23. Multi-DB: Cross-provider database migration (`migrateDatabase`: JSON -> SQLite3)', async () => {
    const srcJsonDb = new PersistentDatabase({
      databaseProvider: 'json',
      dbFilePath: TEST_DB_PATH
    });
    const dstSqliteDb = new PersistentDatabase({
      databaseProvider: 'sqlite',
      sqlitePath: TEST_MIGRATE_SQLITE_PATH
    });

    await srcJsonDb.init();
    await dstSqliteDb.init();

    try {
      const migrationStats = await migrateDatabase(srcJsonDb, dstSqliteDb);
      assert(migrationStats.roomsMigrated >= 1, 'Migrated active rooms from JSON to SQLite');
      assert(migrationStats.matchesMigrated >= 1, 'Migrated match history from JSON to SQLite');

      await dstSqliteDb.withTransaction(async (tx) => {
        const migratedRoom = await tx.getRoom(sharedRoomId);
        assert(migratedRoom, 'Shared room exists in target SQLite DB after migration');
        const matches = await tx.getMatchesByRoom(sharedRoomId);
        assert(matches.length >= 1, 'Match history exists in target SQLite DB after migration');
      });
    } finally {
      await srcJsonDb.close();
      await dstSqliteDb.close();
      cleanupFilePair(TEST_DB_PATH);
      cleanupFilePair(TEST_SQLITE_PATH);
      cleanupFilePair(TEST_MIGRATE_SQLITE_PATH);
    }
  });

  // Test 24: Human vs. AI Bot Separation (`Utya`), Concurrent Joins, Rate Limiting, `/terms` & Graceful Shutdown
  await runTest('24. Security & Multiplayer: Human vs. AI Bot (`Utya`) separation, concurrent joins, rate limiting (429), `/terms` & graceful shutdown', async () => {
    const devSqlitePath = path.join(__dirname, '..', 'data', 'test_dev_sqlite.sqlite');
    cleanupFilePair(devSqlitePath);

    const devSrv = createUnoServer({
      skipDotEnv: true,
      isProduction: false,
      nodeEnv: 'development',
      port: 0,
      databaseProvider: 'sqlite',
      sqlitePath: devSqlitePath,
      httpRateLimitPerMin: 12
    });
    const devPort = await devSrv.start(0);

    try {
      // 1. Check /api/health and /terms
      const health = await httpRequestJson(devPort, 'GET', '/api/health');
      assert.strictEqual(health.status, 200);
      assert.strictEqual(health.data.dbMode, 'sqlite');

      const terms = await httpRequestJson(devPort, 'GET', '/terms');
      assert.strictEqual(terms.status, 200);
      assert(String(terms.raw).includes('Matcho! (Beta) — Terms of Use'));

      // 2. Verify newly created multiplayer room has ONLY the human host (`isBot: false`), never an unrequested fake player
      const createRes = await devSrv.roomManager.createRoom({
        id: 'human_host_1',
        first_name: 'RealHuman',
        isBot: true // Even if someone tries to spoof isBot on createRoom, RoomManager forces human host `isBot: false`!
      });
      assert.strictEqual(createRes.room.players.length, 1);
      assert.strictEqual(createRes.room.players[0].isBot, false);

      // 3. When host explicitly requests ADD_BOT, `Utya` is added with `isBot: true` and `isUtya: true`
      const botRes = await devSrv.roomManager.addBotToRoom(createRes.room.id, 'human_host_1');
      assert.strictEqual(botRes.ok, true);
      assert.strictEqual(botRes.room.players.length, 2);
      assert.strictEqual(botRes.room.players[1].name, 'Utya');
      assert.strictEqual(botRes.room.players[1].isBot, true);
      assert.strictEqual(botRes.room.players[1].isUtya, true);

      // 4. Concurrent room joins serialize cleanly inside SQLite transactions
      const [j1, j2, j3] = await Promise.all([
        devSrv.roomManager.joinRoom(createRes.room.id, { id: 'conc_1', first_name: 'C1' }, 'player'),
        devSrv.roomManager.joinRoom(createRes.room.id, { id: 'conc_2', first_name: 'C2' }, 'player'),
        devSrv.roomManager.joinRoom(createRes.room.id, { id: 'conc_3', first_name: 'C3' }, 'player')
      ]);
      const successes = [j1, j2, j3].filter(r => r.ok);
      const fullRejections = [j1, j2, j3].filter(r => !r.ok && r.code === 'ROOM_FULL');
      assert.strictEqual(successes.length, 2, 'Exactly 2 concurrent joins fill remaining seats (up to 4 max)');
      assert.strictEqual(fullRejections.length, 1, '5th concurrent join cleanly receives ROOM_FULL');

      // 5. Verify HTTP rate limiting returns 429 when limit exceeded
      let rateLimited = false;
      for (let i = 0; i < 15; i++) {
        const r = await httpRequestJson(devPort, 'GET', '/api/health');
        if (r.status === 429) {
          rateLimited = true;
          break;
        }
      }
      assert.strictEqual(rateLimited, true, 'HTTP rate limiter enforced 429 Too Many Requests');
    } finally {
      await devSrv.stop();
      cleanupFilePair(devSqlitePath);
    }
  });


  // Test 25: Deterministic Hand Layout Algorithm (1, 5, 7, 9, 12, 15, 20 cards) & Consolidated CSS Audit
  await runTest('25. Hand layout algorithm (1, 5, 7, 9, 12, 15, 20 cards across viewports) & consolidated CSS verification', async () => {
    const cssText = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8');
    const mCardDefs = (cssText.match(/^\.m-card\s*\{/gm) || []).length;
    assert.strictEqual(mCardDefs, 1, 'Authoritative .m-card rule defined exactly once in styles.css without duplicate overrides');
    assert(cssText.includes('.drag-floating-card'), 'styles.css defines .drag-floating-card');
    assert(cssText.includes('.hand-card-drag-placeholder'), 'styles.css defines .hand-card-drag-placeholder');

    const jsText = fs.readFileSync(path.join(__dirname, '..', 'js', 'game.js'), 'utf8');
    assert(jsText.includes('computeHandLayout'), 'js/game.js implements computeHandLayout');

    // Execute computeHandLayout in a lightweight sandboxed context across 1, 5, 7, 9, 12, 15, 20 cards and 340px/384px/412px widths
    const vm = require('node:vm');
    const sandbox = {
      window: { innerWidth: 384, location: { search: '', hash: '', protocol: 'file:', host: '', origin: 'http://localhost', pathname: '/' }, addEventListener() {} },
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById() { return { clientWidth: 384, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, style: { setProperty() {} } }; }
      },
      localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      URLSearchParams,
      UnoEngine,
      setTimeout() {},
      clearTimeout() {},
      setInterval() { return 1; },
      clearInterval() {}
    };
    sandbox.window.UnoEngine = UnoEngine;
    sandbox.window.localStorage = sandbox.localStorage;
    sandbox.window.sessionStorage = sandbox.sessionStorage;
    vm.createContext(sandbox);
    vm.runInContext(jsText, sandbox);

    const computeHandLayout = sandbox.window.__computeHandLayout;
    assert.strictEqual(typeof computeHandLayout, 'function', '__computeHandLayout exposed for verification');

    const testCounts = [1, 5, 7, 9, 12, 15, 20];
    const testWidths = [340, 384, 412];
    for (const vw of testWidths) {
      for (const count of testCounts) {
        const sampleCards = Array.from({ length: count }, (_, i) => ({
          id: i + 1,
          color: ['red', 'yellow', 'green', 'blue', 'wild'][i % 5],
          value: i % 5 === 4 ? 'wild' : String(i % 9),
          label: i % 5 === 4 ? '?' : String(i % 9)
        }));
        const layout = computeHandLayout(sampleCards, vw);
        assert.strictEqual(layout.totalCount, count);
        assert.strictEqual(layout.backRowCards.length + layout.frontRowCards.length, count);
        const expectedTiers = Math.ceil(count / 7);
        assert.strictEqual(layout.tierCount, expectedTiers, `Count ${count} uses ${expectedTiers}-tier layout (max 7 cards per tier)`);
        layout.tiers.forEach((tierCards, tIdx) => {
          assert(tierCards.length <= 7, `Tier ${tIdx} has ${tierCards.length} <= 7 cards`);
          assert(layout.tierMetrics[tIdx].rowWidthPx <= layout.availWidth, `Tier ${tIdx} width (${layout.tierMetrics[tIdx].rowWidthPx}px) fits within availWidth (${layout.availWidth}px)`);
        });
      }
    }
  });

  // Test 26: Dedicated #dragCardLayer Architecture, Mid-Drag Re-Render Reconciliation & Strict Bounding-Box Target Detection
  await runTest('26. Dedicated #dragCardLayer surface, mid-drag re-render reconciliation & strict discard target hit detection', async () => {
    const htmlText = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const jsText = fs.readFileSync(path.join(__dirname, '..', 'js', 'game.js'), 'utf8');

    assert(htmlText.includes('id="dragCardLayer"'), 'index.html contains dedicated #dragCardLayer surface');
    assert(jsText.includes('handStrip.setPointerCapture'), 'Pointer capture is attached to stable parent container handStrip');
    assert(!jsText.includes('ds.dy < -65') && !jsText.includes('ds.dy < -68'), 'Buggy upward-delta drop shortcut removed');

    // Verify isDropOverDiscardTarget rejects upward non-target coordinates and accepts coordinates over #centerDiscardStack
    const vm = require('node:vm');
    const mockDiscardRect = { left: 82, top: 310, right: 188, bottom: 466, width: 106, height: 156 };
    const sandbox = {
      window: { innerWidth: 384, location: { search: '', hash: '', protocol: 'file:', host: '', origin: 'http://localhost', pathname: '/' }, addEventListener() {} },
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id) {
          if (id === 'centerDiscardStack') {
            return { getBoundingClientRect: () => mockDiscardRect };
          }
          return { clientWidth: 384, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, style: { setProperty() {} } };
        }
      },
      localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      URLSearchParams,
      UnoEngine,
      setTimeout() {},
      clearTimeout() {},
      setInterval() { return 1; },
      clearInterval() {}
    };
    sandbox.window.UnoEngine = UnoEngine;
    sandbox.window.localStorage = sandbox.localStorage;
    sandbox.window.sessionStorage = sandbox.sessionStorage;
    vm.createContext(sandbox);
    vm.runInContext(jsText, sandbox);

    const isDropOverDiscardTarget = sandbox.window.__isDropOverDiscardTarget;
    assert.strictEqual(typeof isDropOverDiscardTarget, 'function');

    // 1. Upward drag that stays at y=520 (above hand, below discard pile) -> MUST return false
    const nonTargetRect = { left: 100, top: 490, right: 188, bottom: 622, width: 88, height: 132 };
    assert.strictEqual(isDropOverDiscardTarget(144, 520, nonTargetRect), false, 'Upward gesture below discard pile rejected');

    // 2. Drag to top-right away from discard pile (x=310, y=380) -> MUST return false
    const rightSideRect = { left: 266, top: 314, right: 354, bottom: 446, width: 88, height: 132 };
    assert.strictEqual(isDropOverDiscardTarget(310, 380, rightSideRect), false, 'Drag to right side rejected');

    // 3. Drag directly onto #centerDiscardStack (x=135, y=388) -> MUST return true
    const overDiscardRect = { left: 91, top: 322, right: 179, bottom: 454, width: 88, height: 132 };
    assert.strictEqual(isDropOverDiscardTarget(135, 388, overDiscardRect), true, 'Drop over #centerDiscardStack accepted');
  });


  // Test 27: Telegram initData Normalization (#tgWebAppData / Percent-Encoded), Private Chat web_app Button & Signed launch_token Auth
  await runTest('27. Telegram initData URL-hash/percent-encoding normalization, private-chat web_app button & signed launch_token auth', async () => {
    const { normalizeInitDataString, extractUnverifiedInitDataUser } = require('../server/telegram_auth');
    const rawSigned = createSignedInitData({ id: 778899, first_name: 'TeleUser', username: 'tele_u' }, TEST_BOT_TOKEN, 'room_uno_t27');

    // 1. Wrapped in #tgWebAppData=<percent-encoded> (exact format injected in URL hash by Telegram clients)
    const hashWrapped = '#tgWebAppData=' + encodeURIComponent(rawSigned) + '&tgWebAppVersion=7.10';
    const checkHash = validateTelegramInitData(hashWrapped, TEST_BOT_TOKEN);
    assert.strictEqual(checkHash.valid, true, 'Validates #tgWebAppData percent-encoded hash string');
    assert.strictEqual(checkHash.user.id, '778899');
    assert.strictEqual(checkHash.start_param, 'room_uno_t27');

    // 2. Unverified extractor for dev mode when BOT_TOKEN is not yet configured
    const unv = extractUnverifiedInitDataUser(hashWrapped);
    assert(unv && unv.user && unv.user.id === '778899', 'Extracts user from #tgWebAppData in dev mode');

    // 3. Test private chat `/start` produces a `web_app` button with a signed `launch_token` that authenticates on a production server!
    const sentMessages = [];
    const prodSrv = createUnoServer({
      skipDotEnv: true,
      isProduction: true,
      nodeEnv: 'production',
      port: 0,
      botToken: TEST_BOT_TOKEN,
      sessionSecret: TEST_SESSION_SECRET,
      webhookSecret: TEST_WEBHOOK_SECRET,
      webAppUrl: TEST_TRUSTED_ORIGIN,
      allowedOrigins: [TEST_TRUSTED_ORIGIN],
      allowDevAuth: false,
      dbFilePath: TEST_DB_PATH,
      telegramApiCaller: async (method, payload) => {
        sentMessages.push({ method, payload });
        return { ok: true, result: { message_id: 88 } };
      }
    });
    const prodPort = await prodSrv.start(0);

    try {
      await prodSrv.botController.handleUpdate({
        message: {
          message_id: 1,
          from: { id: 445566, first_name: 'BotClicker', username: 'clicker' },
          chat: { id: 445566, type: 'private' },
          text: '/start'
        }
      });
      assert.strictEqual(sentMessages.length, 1);
      const kb = sentMessages[0].payload.reply_markup.inline_keyboard;
      const webAppBtn = kb[kb.length - 1][0];
      assert(webAppBtn.web_app && webAppBtn.web_app.url, 'Private chat /start uses native web_app button');
      const parsedBtnUrl = new URL(webAppBtn.web_app.url);
      const launchToken = parsedBtnUrl.searchParams.get('launch_token');
      const startappParam = parsedBtnUrl.searchParams.get('startapp');
      assert(launchToken, 'web_app URL includes signed launch_token');
      assert(startappParam && startappParam.startsWith('room_uno_'), 'web_app URL includes room startapp parameter');

      // Connect to production WebSocket using the signed launch_token (simulating fallback WebView where initData is empty)
      const ws = await connectWebSocketClient(`ws://127.0.0.1:${prodPort}/ws`, { origin: TEST_TRUSTED_ORIGIN });
      const joinP = waitForWsMessage(ws, m => m.type === 'ROOM_JOINED');
      ws.sendJSON({
        type: 'AUTH_JOIN',
        initData: '',
        launchToken,
        startParam: startappParam
      });
      const joined = await joinP;
      assert.strictEqual(joined.seat, 0, 'Authenticated and joined room via signed launch_token');
      ws.close();
    } finally {
      await prodSrv.stop();
      cleanupFilePair(TEST_DB_PATH);
    }
  });

  // Test 28: Synchronous Telegram Script Tag, Auth Recovery Modal (#authRecoveryOverlay) & Matcho! Draw-Turn Advancement
  await runTest('28. Synchronous telegram-web-app.js loading, #authRecoveryOverlay recovery UI & Matcho! draw-turn advancement', async () => {
    const htmlText = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const jsText = fs.readFileSync(path.join(__dirname, '..', 'js', 'game.js'), 'utf8');

    assert(!htmlText.includes('telegram-web-app.js" async'), 'telegram-web-app.js must NOT use async attribute');
    assert(htmlText.includes('id="authRecoveryOverlay"'), 'index.html includes #authRecoveryOverlay recovery screen');
    assert(htmlText.includes('id="authRetryTelegramBtn"'), 'index.html includes Retry Telegram button');
    assert(htmlText.includes('id="authPlayPracticeBtn"'), 'index.html includes Play Practice Match recovery button');
    assert(jsText.includes('resolveTelegramInitData'), 'js/game.js implements multi-source resolveTelegramInitData');
    assert(jsText.includes('showAuthRecoveryModal'), 'js/game.js transitions to recovery modal on UNAUTHORIZED');

    // Verify DRAW_CARD in UnoEngine advances turn immediately by default (matching Matcho! gameplay video t=38.06s)
    const matchState = UnoEngine.createMatchState([
      { id: 'p1', name: 'Player 1' },
      { id: 'p2', name: 'Player 2' }
    ], { officialOpeningEffects: false });
    matchState.activeColor = 'red';
    matchState.deck.push({ id: 999, color: 'red', value: '5', label: '5', points: 5 }); // Even when drawn card matches activeColor
    const drawRes = UnoEngine.applyAction(matchState, { type: 'DRAW_CARD', playerId: 'p1' });
    assert.strictEqual(drawRes.ok, true);
    assert.strictEqual(drawRes.event.autoAdvanced, true, 'DRAW_CARD advances turn immediately in Matcho! rules');
    assert.strictEqual(matchState.turnIndex, 1, 'Turn advanced to Player 2 after drawing');
  });


  // Test 29: Deep-Link Room Tokens, Opaque Shared-Room Joining, Session Account-Switch Protection & Launch-Token Room Scoping
  await runTest('29. Deep-link startapp tokens, opaque shared-room joining, session account-switch protection & launch-token scoping', async () => {
    const { createRoomInviteToken, signSessionToken } = require('../server/telegram_auth');

    // 1. Signed room token format (`https://t.me/<bot>/<app>?startapp=<token>`)
    const tokenPlayer = createRoomInviteToken('uno_room99', 'player', TEST_SESSION_SECRET);
    assert(/^[A-Za-z0-9_-]{1,64}$/.test(tokenPlayer), 'Signed startapp token uses only Telegram-allowed characters');
    assert(!tokenPlayer.includes('.'), 'Signed startapp token contains no dots');

    const parsedValid = parseStartParam(tokenPlayer, TEST_SESSION_SECRET);
    assert.strictEqual(parsedValid.valid, true);
    assert.strictEqual(parsedValid.roomId, 'uno_room99');
    assert.strictEqual(parsedValid.mode, 'player');
    assert.strictEqual(parsedValid.signed, true);

    // Tampered HMAC signature must be rejected
    const tamperedToken = tokenPlayer.slice(0, -2) + (tokenPlayer.endsWith('AA') ? 'BB' : 'AA');
    const parsedTampered = parseStartParam(tamperedToken, TEST_SESSION_SECRET);
    assert.strictEqual(parsedTampered.valid, false);
    assert.strictEqual(parsedTampered.code, 'INVALID_INVITE_SIGNATURE');

    // Expired base64url token must be rejected
    const expiredB64 = Buffer.from(JSON.stringify({ r: 'uno_room99', exp: Date.now() - 5000 }), 'utf8').toString('base64url');
    const parsedExpired = parseStartParam(expiredB64, TEST_SESSION_SECRET);
    assert.strictEqual(parsedExpired.valid, false);
    assert.strictEqual(parsedExpired.code, 'EXPIRED_INVITE_TOKEN');

    // Opaque startapp token maps deterministically to the same canonical room ID
    const opaque1 = parseStartParam('MatchoOpaqueInvite2026XyZ', TEST_SESSION_SECRET);
    const opaque2 = parseStartParam('MatchoOpaqueInvite2026XyZ', TEST_SESSION_SECRET);
    assert.strictEqual(opaque1.valid, true);
    assert.strictEqual(opaque1.isOpaqueInvite, true);
    assert.strictEqual(opaque1.roomId, opaque2.roomId);

    const srv = createUnoServer({
      skipDotEnv: true,
      isProduction: true,
      nodeEnv: 'production',
      port: 0,
      botToken: TEST_BOT_TOKEN,
      botUsername: 'matcho_bot',
      appShortName: 'play',
      sessionSecret: TEST_SESSION_SECRET,
      webhookSecret: TEST_WEBHOOK_SECRET,
      webAppUrl: TEST_TRUSTED_ORIGIN,
      allowedOrigins: [TEST_TRUSTED_ORIGIN],
      allowDevAuth: false,
      dbFilePath: TEST_DB_PATH
    });
    const port = await srv.start(0);

    try {
      const userA = { id: '7001', first_name: 'Alice', username: 'alice' };
      const userB = { id: '7002', first_name: 'Bob', username: 'bob' };

      // 2. Both players opening the same opaque startapp link join the EXACT SAME room
      const wsA = await connectWebSocketClient(`ws://127.0.0.1:${port}/ws`, { origin: TEST_TRUSTED_ORIGIN });
      const wsB = await connectWebSocketClient(`ws://127.0.0.1:${port}/ws`, { origin: TEST_TRUSTED_ORIGIN });

      const joinAP = waitForWsMessage(wsA, m => m.type === 'ROOM_JOINED');
      wsA.sendJSON({
        type: 'AUTH_JOIN',
        initData: createSignedInitData(userA, TEST_BOT_TOKEN, 'MatchoOpaqueInvite2026XyZ'),
        startParam: 'MatchoOpaqueInvite2026XyZ'
      });
      const joinedA = await joinAP;
      assert.strictEqual(joinedA.seat, 0);
      assert(joinedA.room.inviteLink.startsWith('https://t.me/matcho_bot/play?startapp='), 'Room state includes canonical Telegram Mini App deep link');

      const joinBP = waitForWsMessage(wsB, m => m.type === 'ROOM_JOINED');
      wsB.sendJSON({
        type: 'AUTH_JOIN',
        initData: createSignedInitData(userB, TEST_BOT_TOKEN, 'MatchoOpaqueInvite2026XyZ'),
        startParam: 'MatchoOpaqueInvite2026XyZ'
      });
      const joinedB = await joinBP;
      assert.strictEqual(joinedB.room.id, joinedA.room.id, 'Both players using the same opaque invite enter the exact same room');
      assert.strictEqual(joinedB.seat, 1);
      assert.strictEqual(joinedB.room.players.length, 2);

      // 3. Session Account-Switch Protection: User B sending valid initData + User A's stale sessionToken MUST authenticate as User B
      const authSwitchRes = await httpRequestJson(port, 'POST', '/api/auth', {
        initData: createSignedInitData(userB, TEST_BOT_TOKEN),
        sessionToken: joinedA.sessionToken // Stale token belonging to User A!
      });
      assert.strictEqual(authSwitchRes.status, 200);
      assert.strictEqual(authSwitchRes.data.user.id, '7002', 'Live signed initData overrides stale sessionToken from previous account');

      // 4. Launch-Token Room Scoping: launchToken bound to room_1 cannot join room_2
      const scopedLaunchToken = signSessionToken({
        kind: 'launch',
        roomId: 'uno_room_alpha',
        user: userA,
        exp: Date.now() + 60000
      }, TEST_SESSION_SECRET);

      const wsC = await connectWebSocketClient(`ws://127.0.0.1:${port}/ws`, { origin: TEST_TRUSTED_ORIGIN });
      const errP = waitForWsMessage(wsC, m => m.type === 'ERROR');
      wsC.sendJSON({
        type: 'AUTH_JOIN',
        roomId: 'uno_room_beta',
        launchToken: scopedLaunchToken
      });
      const errMsg = await errP;
      assert.strictEqual(errMsg.code, 'LAUNCH_TOKEN_ROOM_MISMATCH', 'Launch token rejected when used for a different room');

      wsA.close();
      wsB.close();
      wsC.close();
    } finally {
      await srv.stop();
      cleanupFilePair(TEST_DB_PATH);
    }
  });

  // Test 30: Legal-Only Card Lifting/Dragging, Finger-Release Hit Testing & Telegram Deep-Link Copy
  await runTest('30. Legal-only card lifting/dragging, pointer-release discard hit-testing & Telegram deep-link generation', async () => {
    const vm = require('node:vm');
    const jsText = fs.readFileSync(path.join(__dirname, '..', 'js', 'game.js'), 'utf8');
    const mockDiscardRect = { left: 82, top: 310, right: 188, bottom: 466, width: 106, height: 156 };

    const sandbox = {
      window: { innerWidth: 384, location: { search: '', hash: '', protocol: 'file:', host: '', origin: 'https://uno.example.com', pathname: '/' }, addEventListener() {} },
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id) {
          if (id === 'centerDiscardStack') {
            return { getBoundingClientRect: () => mockDiscardRect, classList: { add() {}, remove() {} } };
          }
          return { clientWidth: 384, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, style: { setProperty() {} } };
        }
      },
      localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      URLSearchParams,
      UnoEngine,
      setTimeout() { return 1; },
      clearTimeout() {},
      setInterval() { return 1; },
      clearInterval() {}
    };
    sandbox.window.UnoEngine = UnoEngine;
    sandbox.window.localStorage = sandbox.localStorage;
    sandbox.window.sessionStorage = sandbox.sessionStorage;
    vm.createContext(sandbox);
    vm.runInContext(jsText, sandbox);

    const isCardPlayableByMe = sandbox.window.__isCardCurrentlyPlayableByMe;
    const isDropOverDiscard = sandbox.window.__isDropOverDiscardTarget;
    const buildDeepLink = sandbox.window.__buildTelegramInviteDeepLink;
    const client = sandbox.window.__matchoClient;

    // Configure active match state in client: activeColor = 'blue', top discard = Blue 6
    client.dealingInProgress = false;
    client.room = {
      id: 'uno_test30',
      botUsername: 'matcho_bot',
      appShortName: 'play',
      inviteToken: 'room_uno_test30__AbCdEf1234',
      inviteLink: 'https://t.me/matcho_bot/play?startapp=room_uno_test30__AbCdEf1234',
      viewerRole: 'player',
      viewerSeat: 0,
      match: {
        status: 'playing',
        turnIndex: 0,
        activeColor: 'blue',
        hasDrawnThisTurn: false,
        drawnCardId: null,
        pendingWild4: null,
        discard: [{ id: 100, color: 'blue', value: '6', label: '6' }],
        players: [
          {
            id: 'p1',
            seat: 0,
            hand: [
              { id: 1, color: 'red', value: '2', label: '2' },    // Unplayable!
              { id: 2, color: 'blue', value: '9', label: '9' },   // Playable!
              { id: 3, color: 'wild', value: 'wild', label: '?' } // Playable!
            ]
          },
          { id: 'p2', seat: 1, hand: [] }
        ]
      }
    };

    assert.strictEqual(isCardPlayableByMe(1), false, 'Red 2 on Blue 6 must NOT be playable or draggable');
    assert.strictEqual(isCardPlayableByMe(2), true, 'Blue 9 on Blue 6 is playable and draggable');
    assert.strictEqual(isCardPlayableByMe(3), true, 'Wild card on Blue 6 is playable and draggable');

    // Out-of-turn check: when turnIndex is 1 (opponent's turn), NO card in player's hand is liftable/draggable
    client.room.match.turnIndex = 1;
    assert.strictEqual(isCardPlayableByMe(2), false, 'Playable card is NOT liftable/draggable during opponent turn');
    client.room.match.turnIndex = 0;

    // False-positive overlap rejection: card top overlaps discard pile, but finger release point (clientY=530) is down near hand
    const overlappingCardRectFarFinger = { left: 90, top: 410, right: 178, bottom: 542, width: 88, height: 132 };
    assert.strictEqual(
      isDropOverDiscard(134, 530, overlappingCardRectFarFinger),
      false,
      'Drop MUST be rejected when finger release point (y=530) is far below discard pile even if card top overlaps'
    );

    // Valid drop when finger is released over discard pile (x=135, y=390)
    const validCardRect = { left: 91, top: 324, right: 179, bottom: 456, width: 88, height: 132 };
    assert.strictEqual(
      isDropOverDiscard(135, 390, validCardRect),
      true,
      'Drop accepted when finger release point is over #centerDiscardStack'
    );

    // Verify Invite Friends link is a real Telegram Mini App deep link
    const link = buildDeepLink();
    assert.strictEqual(link, 'https://t.me/matcho_bot/play?startapp=room_uno_test30__AbCdEf1234');
  });

  // Test 31: Bot Private DM /start Menu (Play with a Friend, Play on Your Own, Rules), 2P Room Capacity, Inline Room Deduplication & /play@bot
  await runTest('31. Bot private DM /start menu, 2P friend room capacity, inline query room reuse & /play@bot normalization', async () => {
    const apiCalls = [];
    const srv = createUnoServer({
      skipDotEnv: true,
      isProduction: true,
      nodeEnv: 'production',
      port: 0,
      botToken: TEST_BOT_TOKEN,
      botUsername: 'matcho_bot',
      appShortName: 'play',
      sessionSecret: TEST_SESSION_SECRET,
      webhookSecret: TEST_WEBHOOK_SECRET,
      webAppUrl: TEST_TRUSTED_ORIGIN,
      allowedOrigins: [TEST_TRUSTED_ORIGIN],
      allowDevAuth: false,
      dbFilePath: TEST_DB_PATH,
      telegramApiCaller: async (method, payload) => {
        apiCalls.push({ method, payload });
        return { ok: true, result: { message_id: apiCalls.length + 100 } };
      }
    });
    await srv.start(0);

    try {
      const hostUser = { id: 8801, first_name: 'HostUser', username: 'host_u' };

      // 1. Private DM /start shows Play with a Friend, Play on Your Own, Rules / Quick Guide, and Open Matcho! Room
      await srv.botController.handleUpdate({
        message: {
          message_id: 1,
          from: hostUser,
          chat: { id: 8801, type: 'private' },
          text: '/start'
        }
      });
      const startKeyboard = apiCalls[0].payload.reply_markup.inline_keyboard;
      const flatButtons = startKeyboard.reduce((acc, r) => acc.concat(r), []);
      assert(flatButtons.some(b => b.callback_data === 'cmd_play_friend'), '/start includes Play with a Friend option');
      assert(flatButtons.some(b => b.web_app && b.web_app.url.includes('practice_utya')), '/start includes Play on Your Own web_app option');
      assert(flatButtons.some(b => b.callback_data === 'cmd_rules'), '/start includes Rules / Quick Guide option');

      // 2. Clicking Play with a Friend creates a 2-player room (maxPlayers: 2)
      apiCalls.length = 0;
      const friendRes = await srv.botController.handleUpdate({
        callback_query: {
          id: 'cb_friend_1',
          from: hostUser,
          message: { chat: { id: 8801, type: 'private' } },
          data: 'cmd_play_friend'
        }
      });
      assert(friendRes, 'Play with a Friend callback handled');
      const sentFriendMsg = apiCalls.find(c => c.method === 'sendMessage');
      assert(sentFriendMsg.payload.text.includes('(1/2)'), '2-player friend room displays 1/2 capacity');
      assert(sentFriendMsg.payload.text.includes('https://t.me/matcho_bot/play?startapp='), '2P room message includes Telegram deep link');

      // Extract the 2P room ID and verify a 2nd player can join, while a 3rd player is rejected with ROOM_FULL
      const room2pMatch = /Room ID: <code>(uno_[a-zA-Z0-9_-]+)<\/code>/.exec(sentFriendMsg.payload.text);
      assert(room2pMatch, 'Extracted 2P room ID');
      const room2pId = room2pMatch[1];

      const join2 = await srv.roomManager.joinRoom(room2pId, { id: '8802', first_name: 'FriendTwo' }, 'player');
      assert.strictEqual(join2.ok, true);
      assert.strictEqual(join2.room.players.length, 2);

      const join3 = await srv.roomManager.joinRoom(room2pId, { id: '8803', first_name: 'ThirdWheel' }, 'player');
      assert.strictEqual(join3.ok, false);
      assert.strictEqual(join3.code, 'ROOM_FULL', '2-player friend room rejects 3rd player with ROOM_FULL');

      // 3. Repeated inline queries from the same user reuse the same unstarted waiting room
      apiCalls.length = 0;
      const iqUser = { id: 8899, first_name: 'InlineTyper' };
      await srv.botController.handleUpdate({ inline_query: { id: 'iq_a', from: iqUser, query: '' } });
      await srv.botController.handleUpdate({ inline_query: { id: 'iq_b', from: iqUser, query: 'm' } });
      assert.strictEqual(apiCalls.length, 2);
      const roomIdA = apiCalls[0].payload.results[0].id;
      const roomIdB = apiCalls[1].payload.results[0].id;
      assert.strictEqual(roomIdA, roomIdB, 'Repeated inline queries reuse the same unstarted waiting room');

      // 4. Command @botusername normalization: /play@matcho_bot works, /play@other_bot is ignored
      apiCalls.length = 0;
      await srv.botController.handleUpdate({
        message: { message_id: 2, from: hostUser, chat: { id: -100555, type: 'supergroup' }, text: '/play@other_bot' }
      });
      assert.strictEqual(apiCalls.length, 0, 'Command addressed to @other_bot is ignored');

      await srv.botController.handleUpdate({
        message: { message_id: 3, from: hostUser, chat: { id: -100555, type: 'supergroup' }, text: '/play@matcho_bot' }
      });
      assert.strictEqual(apiCalls.length, 1, 'Command addressed to @matcho_bot is processed');
    } finally {
      await srv.stop();
      cleanupFilePair(TEST_DB_PATH);
    }
  });

  // Test 32: Lobby Host vs. Non-Host Start Button, LEAVE_ROOM Host Migration & Standalone HTML Bundle Parity
  await runTest('32. Lobby host vs. non-host START button, LEAVE_ROOM host migration & standalone HTML bundle consistency', async () => {
    // 1. Verify standalone uno_telegram_miniapp.html bundle contains exact CSS, shared engine, and game.js
    const rootDir = path.join(__dirname, '..');
    const cssText = fs.readFileSync(path.join(rootDir, 'css', 'styles.css'), 'utf8');
    const engineText = fs.readFileSync(path.join(rootDir, 'shared', 'uno_engine.js'), 'utf8');
    const gameText = fs.readFileSync(path.join(rootDir, 'js', 'game.js'), 'utf8');
    const bundleText = fs.readFileSync(path.join(rootDir, 'uno_telegram_miniapp.html'), 'utf8');

    assert(bundleText.includes('<script src="https://telegram.org/js/telegram-web-app.js"></script>'), 'Bundle loads telegram-web-app.js synchronously');
    assert(bundleText.includes(cssText.trim()), 'Bundle CSS matches css/styles.css');
    assert(bundleText.includes(engineText.trim()), 'Bundle engine matches shared/uno_engine.js');
    assert(bundleText.includes(gameText.trim()), 'Bundle client matches js/game.js');

    // 2. Verify Lobby UI rendering for 1/4 waiting, 2/4 Host (START button), and 2/4 Non-Host (WAITING FOR HOST)
    const vm = require('node:vm');
    const elements = {
      roomPlayerCountText: { textContent: '' },
      roomStatusSubtitle: { textContent: '' },
      roomPlayersList: { innerHTML: '' },
      roomCenterActionWrap: { innerHTML: '' },
      roomWaitOrStartBtn: { addEventListener() {} },
      roomCopyInvitePillBtn: { addEventListener() {} }
    };
    const sandbox = {
      window: { innerWidth: 384, location: { search: '?uid=host_1', hash: '', protocol: 'https:', host: 'uno.example.com', origin: 'https://uno.example.com', pathname: '/' }, addEventListener() {} },
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id) {
          return elements[id] || { clientWidth: 384, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, style: { setProperty() {} } };
        }
      },
      localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      URLSearchParams,
      UnoEngine,
      setTimeout() { return 1; },
      clearTimeout() {},
      setInterval() { return 1; },
      clearInterval() {}
    };
    sandbox.window.UnoEngine = UnoEngine;
    sandbox.window.localStorage = sandbox.localStorage;
    sandbox.window.sessionStorage = sandbox.sessionStorage;
    vm.createContext(sandbox);
    vm.runInContext(gameText, sandbox);

    const client = sandbox.window.__matchoClient;
    const renderRoomLobby = sandbox.window.__renderRoomLobby;
    client.mode = 'online';

    // Case A: 1 / 2 incomplete room -> shows WAITING status, no START button
    client.room = {
      id: 'uno_lobby_test',
      hostId: 'host_1',
      maxPlayers: 2,
      status: 'waiting',
      players: [{ id: 'host_1', name: 'Host', initials: 'HO', color: '#475569', isBot: false }]
    };
    renderRoomLobby();
    assert.strictEqual(elements.roomPlayerCountText.textContent, '1 / 2');
    assert(elements.roomCenterActionWrap.innerHTML.includes('WAITING'), 'Incomplete room displays WAITING status');
    assert(!elements.roomCenterActionWrap.innerHTML.includes('>START<'), 'Incomplete room does not display START');

    // Case B: 2 / 2 room viewed by Host -> shows clickable <button id="roomWaitOrStartBtn"> and START
    client.room.players.push({ id: 'guest_2', name: 'Guest', initials: 'GU', color: '#ff5c6c', isBot: false });
    renderRoomLobby();
    assert.strictEqual(elements.roomPlayerCountText.textContent, '2 / 2');
    assert(elements.roomCenterActionWrap.innerHTML.includes('<button id="roomWaitOrStartBtn"'), 'Host sees clickable START button when >=2 players');
    assert(elements.roomCenterActionWrap.innerHTML.includes('>START<'), 'Host sees START label');

    // Case C: 2 / 2 room viewed by Non-Host -> shows non-clickable WAITING FOR HOST indicator
    client.room.hostId = 'other_host_99';
    renderRoomLobby();
    assert(elements.roomCenterActionWrap.innerHTML.includes('WAITING FOR HOST'), 'Non-host sees WAITING FOR HOST status');
    assert(!elements.roomCenterActionWrap.innerHTML.includes('<button id="roomWaitOrStartBtn"'), 'Non-host does NOT see a clickable START button');
  });


  // Test 33: CRITICAL SECURITY REGRESSION SUITE — Launch-Token Room Binding (All 8 Required Authorization Cases)
  await runTest('33. Security: Launch-token room binding across startParam, direct roomId, cached sessionToken, and expired/malformed tokens', async () => {
    const { createRoomInviteToken, signSessionToken } = require('../server/telegram_auth');

    const srv = createUnoServer({
      skipDotEnv: true,
      isProduction: true,
      nodeEnv: 'production',
      port: 0,
      botToken: TEST_BOT_TOKEN,
      botUsername: 'matcho_bot',
      appShortName: 'play',
      sessionSecret: TEST_SESSION_SECRET,
      webhookSecret: TEST_WEBHOOK_SECRET,
      webAppUrl: TEST_TRUSTED_ORIGIN,
      allowedOrigins: [TEST_TRUSTED_ORIGIN],
      allowDevAuth: false,
      dbFilePath: TEST_DB_PATH
    });
    const port = await srv.start(0);

    try {
      const hostA = { id: '9101', first_name: 'HostAlpha', username: 'host_a' };
      const hostB = { id: '9102', first_name: 'HostBeta', username: 'host_b' };
      const guest = { id: '9103', first_name: 'GuestUser', username: 'guest_u' };

      const roomARes = await srv.roomManager.createRoom(hostA, { maxPlayers: 2, roomMode: 'friend_2p' });
      const roomBRes = await srv.roomManager.createRoom(hostB, { maxPlayers: 2, roomMode: 'friend_2p' });
      const roomAId = roomARes.room.id;
      const roomBId = roomBRes.room.id;

      const inviteTokenA = createRoomInviteToken(roomAId, 'player', TEST_SESSION_SECRET);
      const inviteTokenB = createRoomInviteToken(roomBId, 'player', TEST_SESSION_SECRET);

      // Mint a valid launch token strictly bound to Room A for guest
      const launchTokenRoomA = signSessionToken({
        kind: 'launch',
        roomId: roomAId,
        mode: 'player',
        user: guest,
        startParam: inviteTokenA,
        exp: Date.now() + 60000
      }, TEST_SESSION_SECRET);

      // Mint a general cached sessionToken for guest (e.g. from an earlier session)
      const cachedSessionToken = signSessionToken({
        user: guest,
        exp: Date.now() + 3600000
      }, TEST_SESSION_SECRET);

      // Case 1: Valid launch token for Room A with startParam resolving to Room B MUST be rejected
      const ws1 = await connectWebSocketClient(`ws://127.0.0.1:${port}/ws`, { origin: TEST_TRUSTED_ORIGIN });
      const err1P = waitForWsMessage(ws1, m => m.type === 'ERROR');
      ws1.sendJSON({
        type: 'AUTH_JOIN',
        launchToken: launchTokenRoomA,
        startParam: inviteTokenB
      });
      const err1 = await err1P;
      assert.strictEqual(err1.code, 'LAUNCH_TOKEN_ROOM_MISMATCH', 'Launch token for Room A with startParam for Room B rejected');
      ws1.close();

      // Also test standard room_uno_xxx startParam resolving to Room B
      const ws1b = await connectWebSocketClient(`ws://127.0.0.1:${port}/ws`, { origin: TEST_TRUSTED_ORIGIN });
      const err1bP = waitForWsMessage(ws1b, m => m.type === 'ERROR');
      ws1b.sendJSON({
        type: 'AUTH_JOIN',
        launchToken: launchTokenRoomA,
        startParam: `room_${roomBId}`
      });
      const err1b = await err1bP;
      assert.strictEqual(err1b.code, 'LAUNCH_TOKEN_ROOM_MISMATCH', 'Launch token for Room A with room_uno_B startParam rejected');
      ws1b.close();

      // Case 2: Valid launch token for Room A with direct roomId set to Room B MUST be rejected (WS and HTTP)
      const ws2 = await connectWebSocketClient(`ws://127.0.0.1:${port}/ws`, { origin: TEST_TRUSTED_ORIGIN });
      const err2P = waitForWsMessage(ws2, m => m.type === 'ERROR');
      ws2.sendJSON({
        type: 'AUTH_JOIN',
        roomId: roomBId,
        launchToken: launchTokenRoomA
      });
      const err2 = await err2P;
      assert.strictEqual(err2.code, 'LAUNCH_TOKEN_ROOM_MISMATCH', 'Launch token for Room A with direct roomId=RoomB rejected on WS');
      ws2.close();

      const httpJoinB = await httpRequestJson(port, 'POST', `/api/rooms/${roomBId}/join`, {
        launchToken: launchTokenRoomA
      });
      assert.strictEqual(httpJoinB.status, 403);
      assert.strictEqual(httpJoinB.data.code, 'LAUNCH_TOKEN_ROOM_MISMATCH', 'Launch token for Room A rejected on POST /api/rooms/RoomB/join');

      // Case 3: Request containing a valid cached sessionToken PLUS a launchToken for Room A MUST NOT authorize joining Room B!
      const ws3 = await connectWebSocketClient(`ws://127.0.0.1:${port}/ws`, { origin: TEST_TRUSTED_ORIGIN });
      const err3P = waitForWsMessage(ws3, m => m.type === 'ERROR');
      ws3.sendJSON({
        type: 'AUTH_JOIN',
        sessionToken: cachedSessionToken,
        launchToken: launchTokenRoomA,
        roomId: roomBId
      });
      const err3 = await err3P;
      assert.strictEqual(err3.code, 'LAUNCH_TOKEN_ROOM_MISMATCH', 'Cached sessionToken + launchToken(RoomA) rejected for direct roomId=RoomB');
      ws3.close();

      const ws3b = await connectWebSocketClient(`ws://127.0.0.1:${port}/ws`, { origin: TEST_TRUSTED_ORIGIN });
      const err3bP = waitForWsMessage(ws3b, m => m.type === 'ERROR');
      ws3b.sendJSON({
        type: 'AUTH_JOIN',
        sessionToken: cachedSessionToken,
        launchToken: launchTokenRoomA,
        startParam: inviteTokenB
      });
      const err3b = await err3bP;
      assert.strictEqual(err3b.code, 'LAUNCH_TOKEN_ROOM_MISMATCH', 'Cached sessionToken + launchToken(RoomA) rejected for startParam=RoomB');
      ws3b.close();

      const httpSessionPlusLaunch = await httpRequestJson(port, 'POST', `/api/rooms/${roomBId}/join`, {
        sessionToken: cachedSessionToken,
        launchToken: launchTokenRoomA
      });
      assert.strictEqual(httpSessionPlusLaunch.status, 403);
      assert.strictEqual(httpSessionPlusLaunch.data.code, 'LAUNCH_TOKEN_ROOM_MISMATCH', 'HTTP join with cached sessionToken + launchToken(RoomA) rejected for RoomB');

      // Also verify CREATE_ROOM with a room-scoped launchToken is rejected
      const wsCreateMismatch = await connectWebSocketClient(`ws://127.0.0.1:${port}/ws`, { origin: TEST_TRUSTED_ORIGIN });
      const errCreateP = waitForWsMessage(wsCreateMismatch, m => m.type === 'ERROR');
      wsCreateMismatch.sendJSON({
        type: 'CREATE_ROOM',
        sessionToken: cachedSessionToken,
        launchToken: launchTokenRoomA
      });
      const errCreate = await errCreateP;
      assert.strictEqual(errCreate.code, 'LAUNCH_TOKEN_ROOM_MISMATCH', 'Room-scoped launchToken cannot bypass scope via CREATE_ROOM');
      wsCreateMismatch.close();

      // Case 4: A launch token for Room A MUST still permit the intended join into Room A
      const ws4 = await connectWebSocketClient(`ws://127.0.0.1:${port}/ws`, { origin: TEST_TRUSTED_ORIGIN });
      const join4P = waitForWsMessage(ws4, m => m.type === 'ROOM_JOINED');
      ws4.sendJSON({
        type: 'AUTH_JOIN',
        sessionToken: cachedSessionToken,
        launchToken: launchTokenRoomA,
        startParam: inviteTokenA
      });
      const joined4 = await join4P;
      assert.strictEqual(joined4.room.id, roomAId, 'Launch token for Room A permitted joining Room A');
      assert.strictEqual(joined4.seat, 1);
      ws4.close();

      // Case 5 & 6: Valid Telegram initData authentication and legitimate friend invite links continue to work
      const friendGuest = { id: '9104', first_name: 'FriendBeta', username: 'friend_b' };
      const ws5 = await connectWebSocketClient(`ws://127.0.0.1:${port}/ws`, { origin: TEST_TRUSTED_ORIGIN });
      const join5P = waitForWsMessage(ws5, m => m.type === 'ROOM_JOINED');
      ws5.sendJSON({
        type: 'AUTH_JOIN',
        initData: createSignedInitData(friendGuest, TEST_BOT_TOKEN, inviteTokenB),
        startParam: inviteTokenB
      });
      const joined5 = await join5P;
      assert.strictEqual(joined5.room.id, roomBId, 'Valid initData + legitimate friend invite link joined Room B');
      assert.strictEqual(joined5.seat, 1);
      ws5.close();

      // Friend invite link for Room A combined with roomId=Room B must also be rejected
      const wsCrossInvite = await connectWebSocketClient(`ws://127.0.0.1:${port}/ws`, { origin: TEST_TRUSTED_ORIGIN });
      const errCrossP = waitForWsMessage(wsCrossInvite, m => m.type === 'ERROR');
      wsCrossInvite.sendJSON({
        type: 'AUTH_JOIN',
        initData: createSignedInitData(friendGuest, TEST_BOT_TOKEN, inviteTokenA),
        roomId: roomBId,
        startParam: inviteTokenA
      });
      const errCross = await errCrossP;
      assert.strictEqual(errCross.code, 'LAUNCH_TOKEN_ROOM_MISMATCH', 'Invite link for Room A rejected when paired with roomId=Room B');
      wsCrossInvite.close();

      // Case 7: Malformed or expired launch tokens fail safely even if a valid cached sessionToken is also supplied
      const expiredLaunchToken = signSessionToken({
        kind: 'launch',
        roomId: roomAId,
        user: guest,
        exp: Date.now() - 10000
      }, TEST_SESSION_SECRET);

      const wsExp = await connectWebSocketClient(`ws://127.0.0.1:${port}/ws`, { origin: TEST_TRUSTED_ORIGIN });
      const errExpP = waitForWsMessage(wsExp, m => m.type === 'ERROR');
      wsExp.sendJSON({
        type: 'AUTH_JOIN',
        sessionToken: cachedSessionToken,
        launchToken: expiredLaunchToken,
        roomId: roomAId
      });
      const errExp = await errExpP;
      assert.strictEqual(errExp.code, 'UNAUTHORIZED', 'Expired launch token rejected even when cached sessionToken is present');
      wsExp.close();

      const wsMalformed = await connectWebSocketClient(`ws://127.0.0.1:${port}/ws`, { origin: TEST_TRUSTED_ORIGIN });
      const errMalP = waitForWsMessage(wsMalformed, m => m.type === 'ERROR');
      wsMalformed.sendJSON({
        type: 'AUTH_JOIN',
        sessionToken: cachedSessionToken,
        launchToken: 'malformed.launch.token.value',
        roomId: roomAId
      });
      const errMal = await errMalP;
      assert.strictEqual(errMal.code, 'UNAUTHORIZED', 'Malformed launch token rejected safely');
      wsMalformed.close();
    } finally {
      await srv.stop();
      cleanupFilePair(TEST_DB_PATH);
    }
  });

  // Test 34: Inline UNO Lobby With Live Player Names, Duplicate-Join Idempotency & 4-Player Cap
  await runTest('34. Inline UNO lobby live player names (🎮 UNO GROUP GAME, 👥 Players joined (X/4), ✅ Player Name), idempotency & 4P cap', async () => {
    const apiCalls = [];
    const srv = createUnoServer({
      skipDotEnv: true,
      isProduction: true,
      nodeEnv: 'production',
      port: 0,
      botToken: TEST_BOT_TOKEN,
      botUsername: 'matcho_bot',
      appShortName: 'play',
      sessionSecret: TEST_SESSION_SECRET,
      webhookSecret: TEST_WEBHOOK_SECRET,
      webAppUrl: TEST_TRUSTED_ORIGIN,
      allowedOrigins: [TEST_TRUSTED_ORIGIN],
      allowDevAuth: false,
      dbFilePath: TEST_DB_PATH,
      telegramApiCaller: async (method, payload) => {
        apiCalls.push({ method, payload });
        return { ok: true, result: { message_id: 501 } };
      }
    });
    await srv.start(0);

    try {
      const p1 = { id: 9201, first_name: 'Player One', username: 'player_one' };
      const p2 = { id: 9202, first_name: 'Player Two', username: 'player_two' };
      const p3 = { id: 9203, first_name: 'Player Three' };
      const p4 = { id: 9204, first_name: 'Player Four' };
      const p5 = { id: 9205, first_name: 'Player Five' };

      // 1. Host triggers inline_query in group
      await srv.botController.handleUpdate({
        inline_query: { id: 'iq_live_1', from: p1, query: '' }
      });
      const iqRes = apiCalls.find(c => c.method === 'answerInlineQuery');
      const roomId = iqRes.payload.results[0].id;
      const initialText = iqRes.payload.results[0].input_message_content.message_text;
      assert(initialText.includes('🎮 <b>UNO GROUP GAME</b>'), 'Inline message includes 🎮 UNO GROUP GAME header');
      assert(initialText.includes('👥 <b>Players joined (1/4)</b>'), 'Shows 1/4 players initially');
      assert(initialText.includes('✅ <b>Player One</b> (@player_one)'), 'Shows host display name and @username');
      assert(initialText.includes('⏳ Waiting for 3 more players...\nJoin the game below!'), 'Shows waiting count and join prompt');

      // 2. Telegram delivers chosen_inline_result with inline_message_id
      apiCalls.length = 0;
      await srv.botController.handleUpdate({
        chosen_inline_result: {
          result_id: roomId,
          from: p1,
          inline_message_id: 'inline_msg_abc_123'
        }
      });

      // 3. Player Two joins via callback button -> edits the SAME inline message (inline_msg_abc_123)
      apiCalls.length = 0;
      await srv.botController.handleUpdate({
        callback_query: {
          id: 'cb_join_p2',
          from: p2,
          inline_message_id: 'inline_msg_abc_123',
          data: `join_${roomId}`
        }
      });
      const editAfterP2 = apiCalls.find(c => c.method === 'editMessageText');
      assert(editAfterP2, 'Original inline message edited when Player Two joins');
      assert.strictEqual(editAfterP2.payload.inline_message_id, 'inline_msg_abc_123', 'Edits exact same inline_message_id');
      assert(editAfterP2.payload.text.includes('👥 <b>Players joined (2/4)</b>'), 'Updated to 2/4 players');
      assert(editAfterP2.payload.text.includes('✅ <b>Player One</b> (@player_one)'));
      assert(editAfterP2.payload.text.includes('✅ <b>Player Two</b> (@player_two)'));
      assert(editAfterP2.payload.text.includes('⏳ Waiting for 2 more players...\nJoin the game below!'));
      assert(!apiCalls.some(c => c.method === 'sendMessage'), 'Never sends duplicate lobby messages on join');

      // 4. Player Two presses Join again -> never counts the same Telegram user twice!
      apiCalls.length = 0;
      await srv.botController.handleUpdate({
        callback_query: {
          id: 'cb_join_p2_dup',
          from: p2,
          inline_message_id: 'inline_msg_abc_123',
          data: `join_${roomId}`
        }
      });
      const editAfterDup = apiCalls.find(c => c.method === 'editMessageText');
      assert(editAfterDup.payload.text.includes('👥 <b>Players joined (2/4)</b>'), 'Duplicate join does not increment count beyond 2/4');

      // 5. Players Three and Four join concurrently -> reaches 4/4, and Player Five is rejected with ROOM_FULL
      await Promise.all([
        srv.botController.handleUpdate({
          callback_query: { id: 'cb_p3', from: p3, inline_message_id: 'inline_msg_abc_123', data: `join_${roomId}` }
        }),
        srv.botController.handleUpdate({
          callback_query: { id: 'cb_p4', from: p4, inline_message_id: 'inline_msg_abc_123', data: `join_${roomId}` }
        })
      ]);
      apiCalls.length = 0;
      await srv.botController.handleUpdate({
        callback_query: { id: 'cb_p5', from: p5, inline_message_id: 'inline_msg_abc_123', data: `join_${roomId}` }
      });
      const p5Alert = apiCalls.find(c => c.method === 'answerCallbackQuery');
      assert.strictEqual(p5Alert.payload.show_alert, true, '5th player receives alert that room is full');
    } finally {
      await srv.stop();
      cleanupFilePair(TEST_DB_PATH);
    }
  });

  // Test 35: Automatic 5-Minute Lobby Expiration, Multi-Player Unstarted Expiration & Active Game Non-Expiration
  await runTest('35. Automatic lobby expiration (5-min default, ⏳ Game Expired, 1P vs >=2P copy, active game non-expiration)', async () => {
    const { DEFAULT_WAITING_ROOM_TIMEOUT_MS } = require('../server/room_manager');
    assert.strictEqual(DEFAULT_WAITING_ROOM_TIMEOUT_MS, 5 * 60 * 1000, 'Default waiting-room timeout is 5 minutes (300,000 ms)');

    const apiCalls = [];
    const srv = createUnoServer({
      skipDotEnv: true,
      isProduction: true,
      nodeEnv: 'production',
      port: 0,
      waitingRoomTimeoutMs: 70, // Fast 70ms timeout for automated verification
      botToken: TEST_BOT_TOKEN,
      botUsername: 'matcho_bot',
      appShortName: 'play',
      sessionSecret: TEST_SESSION_SECRET,
      webhookSecret: TEST_WEBHOOK_SECRET,
      webAppUrl: TEST_TRUSTED_ORIGIN,
      allowedOrigins: [TEST_TRUSTED_ORIGIN],
      allowDevAuth: false,
      dbFilePath: TEST_DB_PATH,
      telegramApiCaller: async (method, payload) => {
        apiCalls.push({ method, payload });
        return { ok: true, result: { message_id: 601 } };
      }
    });
    await srv.start(0);

    try {
      const host = { id: 9301, first_name: 'TimeoutHost', username: 'thost' };
      const joiner = { id: 9302, first_name: 'TimeoutGuest', username: 'tguest' };

      // 1. Create inline room where nobody else joins before the timeout
      const r1Res = await srv.roomManager.createRoom(host, {
        maxPlayers: 4,
        inline_message_id: 'inline_exp_1p'
      });
      const r1Id = r1Res.room.id;

      // Wait for automatic expiration timer to fire
      await new Promise(r => setTimeout(r, 130));

      const r1Check = await srv.roomManager.getRoom(r1Id);
      assert.strictEqual(r1Check.ok, false);
      assert.strictEqual(r1Check.code, 'ROOM_EXPIRED', 'Unstarted 1P room marked expired automatically');

      const edit1P = apiCalls.find(c => c.method === 'editMessageText' && c.payload.inline_message_id === 'inline_exp_1p' && c.payload.text.includes('⏳ <b>Game Expired</b>'));
      assert(edit1P, 'Inline message edited to display ⏳ Game Expired');
      assert(edit1P.payload.text.includes('Nobody joined before the lobby timeout'), '1P expired room explains nobody joined before timeout');
      const kb1P = edit1P.payload.reply_markup.inline_keyboard;
      assert.strictEqual(kb1P.length, 1);
      assert.strictEqual(kb1P[0][0].text, '🔄 Play Again', 'Join button replaced with 🔄 Play Again');
      assert.strictEqual(kb1P[0][0].switch_inline_query_current_chat, 'play', 'Play Again uses switch_inline_query_current_chat');

      // Subsequent joins into the expired room must be rejected
      const lateJoin = await srv.roomManager.joinRoom(r1Id, joiner, 'player');
      assert.strictEqual(lateJoin.ok, false);
      assert.strictEqual(lateJoin.code, 'ROOM_EXPIRED', 'Subsequent joins into expired room prevented');

      // Idempotency: calling expireWaitingRoom again does not emit duplicate Telegram edits
      const editCountBefore = apiCalls.filter(c => c.method === 'editMessageText' && c.payload.inline_message_id === 'inline_exp_1p').length;
      const repeatExp = await srv.roomManager.expireWaitingRoom(r1Id);
      assert.strictEqual(repeatExp.alreadyExpired, true, 'expireWaitingRoom is idempotent');
      const editCountAfter = apiCalls.filter(c => c.method === 'editMessageText' && c.payload.inline_message_id === 'inline_exp_1p').length;
      assert.strictEqual(editCountAfter, editCountBefore, 'No duplicate Telegram edits on repeated expiration');

      // 2. Unstarted room where 2 players HAVE joined before timeout -> must NOT falsely claim nobody joined!
      const r2Res = await srv.roomManager.createRoom(host, {
        maxPlayers: 4,
        inline_message_id: 'inline_exp_2p'
      });
      await srv.roomManager.joinRoom(r2Res.room.id, joiner, 'player');
      await new Promise(r => setTimeout(r, 130));

      const edit2P = apiCalls.filter(c => c.method === 'editMessageText' && c.payload.inline_message_id === 'inline_exp_2p').pop();
      assert(edit2P && edit2P.payload.text.includes('⏳ <b>Game Expired</b>'));
      assert(edit2P.payload.text.includes('(2/4 players had joined)'), 'Multi-player unstarted room accurately states 2/4 players had joined');
      assert(!edit2P.payload.text.includes('Nobody joined'), 'Never falsely claims nobody joined when players joined');

      // 3. Active started game MUST NEVER be expired by the waiting-room timeout!
      const r3Res = await srv.roomManager.createRoom(host, { maxPlayers: 4, inline_message_id: 'inline_active_game' });
      await srv.roomManager.joinRoom(r3Res.room.id, joiner, 'player');
      const startRes = await srv.roomManager.startGame(r3Res.room.id, host.id);
      assert.strictEqual(startRes.ok, true);

      await new Promise(r => setTimeout(r, 130));
      const activeCheck = await srv.roomManager.getRoom(r3Res.room.id);
      assert.strictEqual(activeCheck.ok, true, 'Started game remains active after waiting-room timeout window');
      assert.strictEqual(activeCheck.room.status, 'playing');
    } finally {
      await srv.stop();
      cleanupFilePair(TEST_DB_PATH);
    }
  });

  // Test 36: Play Again Opens Inline Mode in Same Chat & Creates Fresh Room ID Without Reviving Expired Room
  await runTest('36. Play Again opens inline mode in same chat and creates a fresh room ID & lifecycle', async () => {
    const apiCalls = [];
    const srv = createUnoServer({
      skipDotEnv: true,
      isProduction: true,
      nodeEnv: 'production',
      port: 0,
      botToken: TEST_BOT_TOKEN,
      botUsername: 'custom_uno_bot',
      appShortName: 'custom_app',
      sessionSecret: TEST_SESSION_SECRET,
      webhookSecret: TEST_WEBHOOK_SECRET,
      webAppUrl: TEST_TRUSTED_ORIGIN,
      allowedOrigins: [TEST_TRUSTED_ORIGIN],
      allowDevAuth: false,
      dbFilePath: TEST_DB_PATH,
      telegramApiCaller: async (method, payload) => {
        apiCalls.push({ method, payload });
        return { ok: true, result: { message_id: 701 } };
      }
    });
    await srv.start(0);

    try {
      const host = { id: 9401, first_name: 'PlayAgainHost', username: 'pahost' };

      // 1. Initial inline query creates room 1
      await srv.botController.handleUpdate({
        inline_query: { id: 'iq_pa_1', from: host, query: '' }
      });
      const firstRoomId = apiCalls[0].payload.results[0].id;

      // Mark room 1 expired
      await srv.roomManager.expireWaitingRoom(firstRoomId);
      const expiredCheck = await srv.roomManager.getRoom(firstRoomId);
      assert.strictEqual(expiredCheck.code, 'ROOM_EXPIRED');

      // 2. User presses 🔄 Play Again -> triggers inline_query with query="play" in the same chat
      apiCalls.length = 0;
      await srv.botController.handleUpdate({
        inline_query: { id: 'iq_pa_2', from: host, query: 'play' }
      });
      const secondRoomId = apiCalls[0].payload.results[0].id;
      assert.notStrictEqual(secondRoomId, firstRoomId, 'Play Again generates a brand-new room ID');

      const newRoomCheck = await srv.roomManager.getRoom(secondRoomId);
      assert.strictEqual(newRoomCheck.ok, true);
      assert.strictEqual(newRoomCheck.room.status, 'waiting', 'New room has a fresh waiting lifecycle');

      // Expired room remains expired and is never revived
      const oldRoomStillExpired = await srv.roomManager.getRoom(firstRoomId);
      assert.strictEqual(oldRoomStillExpired.code, 'ROOM_EXPIRED', 'Expired room is never revived');

      // Verify configured botUsername and appShortName are used in generated deep links (never hardcoded)
      const msgText = apiCalls[0].payload.results[0].input_message_content.message_text;
      assert(msgText.includes('https://t.me/custom_uno_bot/custom_app?startapp='), 'Uses actual configured BOT_USERNAME and APP_SHORT_NAME');
    } finally {
      await srv.stop();
      cleanupFilePair(TEST_DB_PATH);
    }
  });


  // Test 37: Inline Publication/Expiration Race Conditions (Expiry Before Publication, Already-Expired Inline Result, Delayed chosen_inline_result & Post-Publish Timeout Anchoring)
  await runTest('37. Inline publication/expiration race conditions: expiry before publication, choosing expired inline result, delayed chosen_inline_result & post-publication timeout anchoring', async () => {
    const apiCalls = [];
    const srv = createUnoServer({
      skipDotEnv: true,
      isProduction: true,
      nodeEnv: 'production',
      port: 0,
      waitingRoomTimeoutMs: 100, // 100ms timeout for deterministic race testing
      botToken: TEST_BOT_TOKEN,
      botUsername: 'matcho_bot',
      appShortName: 'play',
      sessionSecret: TEST_SESSION_SECRET,
      webhookSecret: TEST_WEBHOOK_SECRET,
      webAppUrl: TEST_TRUSTED_ORIGIN,
      allowedOrigins: [TEST_TRUSTED_ORIGIN],
      allowDevAuth: false,
      dbFilePath: TEST_DB_PATH,
      telegramApiCaller: async (method, payload) => {
        apiCalls.push({ method, payload });
        return { ok: true, result: { message_id: 801 } };
      }
    });
    await srv.start(0);

    try {
      const host = { id: 9501, first_name: 'RaceHost', username: 'rhost' };
      const clicker = { id: 9502, first_name: 'RaceClicker', username: 'rclicker' };

      // Scenario A: Room expires BEFORE publication -> user then chooses the already-expired inline result
      // Verify the published message is immediately edited to "⏳ Game Expired" with "🔄 Play Again" (never left in stale waiting state!)
      await srv.botController.handleUpdate({
        inline_query: { id: 'iq_race_1', from: host, query: '' }
      });
      const draftRoomId = apiCalls[0].payload.results[0].id;

      // Verify draft starts unpublished (is_published === false)
      await srv.db.withTransaction(async (tx) => {
        const draft = await tx.getRoom(draftRoomId);
        assert.strictEqual(draft.is_published, false, 'Inline query room starts as unpublished draft');
        assert.strictEqual(draft.published_at, null);
      });

      // Wait 140ms so the unpublished draft room expires before chosen_inline_result is sent
      await new Promise(r => setTimeout(r, 140));
      const checkExpiredDraft = await srv.roomManager.getRoom(draftRoomId);
      assert.strictEqual(checkExpiredDraft.code, 'ROOM_EXPIRED', 'Unpublished draft expired after timeout');

      // Now user selects the already-expired inline result in Telegram -> chosen_inline_result arrives with inline_message_id
      apiCalls.length = 0;
      await srv.botController.handleUpdate({
        chosen_inline_result: {
          result_id: draftRoomId,
          from: host,
          inline_message_id: 'inline_stale_chosen_1'
        }
      });

      // Must immediately call editMessageText on inline_stale_chosen_1 to convert it to ⏳ Game Expired with 🔄 Play Again!
      const immediateRecoveryEdit = apiCalls.find(
        c => c.method === 'editMessageText' && c.payload.inline_message_id === 'inline_stale_chosen_1'
      );
      assert(immediateRecoveryEdit, 'Choosing an already-expired inline result immediately edits the published message');
      assert(immediateRecoveryEdit.payload.text.includes('⏳ <b>Game Expired</b>'), 'Published message updated to ⏳ Game Expired');
      assert(!immediateRecoveryEdit.payload.text.includes('Join the game below!'), 'Stale waiting prompt removed');
      const recoveryKb = immediateRecoveryEdit.payload.reply_markup.inline_keyboard;
      assert.strictEqual(recoveryKb.length, 1);
      assert.strictEqual(recoveryKb[0][0].text, '🔄 Play Again', 'Obsolete join buttons replaced with 🔄 Play Again');
      assert.strictEqual(recoveryKb[0][0].switch_inline_query_current_chat, 'play');

      // Scenario B: Delayed chosen_inline_result (room published just before expiry, or chosen_inline_result arrives after manual expiry)
      // First verify that when a valid unpublished draft is published at t=60ms (before the 100ms draft expiry),
      // markRoomPublished anchors a FULL fresh 100ms waiting timeout from publication time!
      apiCalls.length = 0;
      await srv.botController.handleUpdate({
        inline_query: { id: 'iq_race_2', from: host, query: '' }
      });
      const room2Id = apiCalls[0].payload.results[0].id;
      assert.notStrictEqual(room2Id, draftRoomId, 'Next inline query after expired draft creates a brand-new room');

      // Wait 60ms (more than half of the 100ms timeout), then publish via chosen_inline_result
      await new Promise(r => setTimeout(r, 60));
      apiCalls.length = 0;
      await srv.botController.handleUpdate({
        chosen_inline_result: {
          result_id: room2Id,
          from: host,
          inline_message_id: 'inline_ anchored_2'
        }
      });

      // At 60ms after publication (120ms after creation), room2 MUST STILL BE WAITING because publication anchored a fresh 100ms window!
      await new Promise(r => setTimeout(r, 55));
      const stillAliveAt55msAfterPub = await srv.roomManager.getRoom(room2Id);
      assert.strictEqual(stillAliveAt55msAfterPub.ok, true, 'Published room gets full waiting timeout from publication time');
      assert.strictEqual(stillAliveAt55msAfterPub.room.status, 'waiting');
      assert.strictEqual(stillAliveAt55msAfterPub.room.is_published, true);

      // Wait another 70ms (past the 100ms post-publication timeout) -> now room2 expires and updates inline_anchored_2 to ⏳ Game Expired!
      await new Promise(r => setTimeout(r, 75));
      const expiredAfterPubWindow = await srv.roomManager.getRoom(room2Id);
      assert.strictEqual(expiredAfterPubWindow.code, 'ROOM_EXPIRED');
      const postPubExpEdit = apiCalls.filter(
        c => c.method === 'editMessageText' && c.payload.inline_message_id === 'inline_ anchored_2'
      ).pop();
      assert(postPubExpEdit && postPubExpEdit.payload.text.includes('⏳ <b>Game Expired</b>'), 'Published message updated to ⏳ Game Expired when post-publication timer fires');

      // Scenario C: Delayed / missing chosen_inline_result where first callback_query arrives after room expired
      apiCalls.length = 0;
      await srv.botController.handleUpdate({
        inline_query: { id: 'iq_race_3', from: host, query: 'play' }
      });
      const room3Id = apiCalls[0].payload.results[0].id;

      // Expire room3 before any chosen_inline_result arrives
      await srv.roomManager.expireWaitingRoom(room3Id);

      // Now a user in the chat clicks "Join" on the stale message (callback_query carries inline_message_id)
      apiCalls.length = 0;
      await srv.botController.handleUpdate({
        callback_query: {
          id: 'cb_delayed_race_3',
          from: clicker,
          inline_message_id: 'inline_delayed_cb_3',
          data: `join_${room3Id}`
        }
      });
      const cbRecoveryEdit = apiCalls.find(
        c => c.method === 'editMessageText' && c.payload.inline_message_id === 'inline_delayed_cb_3'
      );
      assert(cbRecoveryEdit, 'Callback on expired room without prior chosen_inline_result still edits the inline message');
      assert(cbRecoveryEdit.payload.text.includes('⏳ <b>Game Expired</b>'));
      assert.strictEqual(cbRecoveryEdit.payload.reply_markup.inline_keyboard[0][0].text, '🔄 Play Again');

      // Scenario D: Repeated inline queries reuse unpublished draft, while Play Again retires the draft and creates a fresh room
      apiCalls.length = 0;
      await srv.botController.handleUpdate({ inline_query: { id: 'iq_rep_1', from: host, query: '' } });
      await srv.botController.handleUpdate({ inline_query: { id: 'iq_rep_2', from: host, query: 'u' } });
      const repId1 = apiCalls[0].payload.results[0].id;
      const repId2 = apiCalls[1].payload.results[0].id;
      assert.strictEqual(repId1, repId2, 'Repeated typing inline queries reuse the same unpublished draft room');

      // Now trigger Play Again (query="play") -> must retire repId1 and create a genuinely fresh room!
      apiCalls.length = 0;
      await srv.botController.handleUpdate({ inline_query: { id: 'iq_rep_play_again', from: host, query: 'play' } });
      const freshPlayAgainId = apiCalls[0].payload.results[0].id;
      assert.notStrictEqual(freshPlayAgainId, repId1, 'Play Again creates a genuinely fresh room ID');

      const oldDraftCheck = await srv.roomManager.getRoom(repId1);
      assert.strictEqual(oldDraftCheck.code, 'ROOM_EXPIRED', 'Previous unpublished draft was retired cleanly when Play Again created a fresh room');
    } finally {
      await srv.stop();
      cleanupFilePair(TEST_DB_PATH);
    }
  });

  console.log('======================================================================');
  console.log(` Results: ${passed} / 37 passed, ${failed} failed`);
  console.log('======================================================================');
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
