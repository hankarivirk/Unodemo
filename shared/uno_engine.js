/**
 * Server-Authoritative UNO Royale / Matcho! Game Engine
 * Universal CommonJS / Browser UMD module (runs on Node.js server & browser offline practice mode).
 *
 * Implements Official 108-Card UNO Rules:
 * - 4 suits (red, yellow, green, blue): one 0, two each of 1-9, two skip, two reverse, two draw2
 * - 8 wilds: four wild (?), four wild4 (+4)
 * - 2-player Reverse = Skip rule; 3-4 player Reverse flips direction
 * - Draw pile exhaustion & discard pile reshuffling (preserving top card & resetting wild suits)
 * - Opening card behavior (Wild+4 reshuffled; Skip/Reverse/Draw2 applied per ruleset or clean number start)
 * - UNO declaration ('CALL_UNO'), vulnerability window at 1 card, and 'CATCH_UNO' (+2 penalty)
 * - Wild Draw Four (+4) legality tracking & Challenge ('CHALLENGE_WILD4' vs 'ACCEPT_WILD4')
 * - Idempotent actionId deduplication & turn ownership validation
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.UnoEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SUITS = ['red', 'yellow', 'green', 'blue'];
  const VALID_VALUES = [
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    'skip', 'reverse', 'draw2', 'wild', 'wild4'
  ];

  const CARD_POINTS = {
    '0': 0, '1': 1, '2': 2, '3': 3, '4': 4,
    '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    'skip': 20, 'reverse': 20, 'draw2': 20,
    'wild': 50, 'wild4': 50
  };

  function createStandardDeck(rng) {
    const deck = [];
    let uid = 1;
    for (const color of SUITS) {
      deck.push({ id: uid++, color, value: '0', label: '0', points: 0 });
      for (let n = 1; n <= 9; n++) {
        const v = String(n);
        deck.push({ id: uid++, color, value: v, label: v, points: n });
        deck.push({ id: uid++, color, value: v, label: v, points: n });
      }
      for (let i = 0; i < 2; i++) {
        deck.push({ id: uid++, color, value: 'skip', label: '⊘', points: 20 });
        deck.push({ id: uid++, color, value: 'reverse', label: '⇄', points: 20 });
        deck.push({ id: uid++, color, value: 'draw2', label: '+2', points: 20 });
      }
    }
    for (let i = 0; i < 4; i++) {
      deck.push({ id: uid++, color: 'wild', value: 'wild', label: '?', points: 50 });
      deck.push({ id: uid++, color: 'wild', value: 'wild4', label: '+4', points: 50 });
    }
    return shuffleDeck(deck, rng);
  }

  function shuffleDeck(cards, rng) {
    const arr = cards.map(c => ({
      id: c.id,
      color: (c.value === 'wild' || c.value === 'wild4') ? 'wild' : c.color,
      value: c.value,
      label: c.label,
      points: c.points !== undefined ? c.points : (CARD_POINTS[c.value] || 0)
    }));
    const randomFn = rng || Math.random;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(randomFn() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  function drawCardsFromState(state, count, rng) {
    const drawn = [];
    for (let i = 0; i < count; i++) {
      if (state.deck.length === 0) {
        if (state.discard.length <= 1) {
          // No more cards available in either draw or discard pile
          break;
        }
        const topCard = state.discard[state.discard.length - 1];
        const underCards = state.discard.slice(0, state.discard.length - 1);
        state.deck = shuffleDeck(underCards, rng);
        state.discard = [topCard];
        state.reshuffleCount = (state.reshuffleCount || 0) + 1;
      }
      const card = state.deck.pop();
      if (card) drawn.push(card);
    }
    return drawn;
  }

  function isCardPlayable(card, topCard, activeColor, pendingWild4) {
    if (!card || !topCard) return false;
    if (pendingWild4) return false; // Must accept or challenge pending Wild +4 first
    if (card.color === 'wild' || card.value === 'wild' || card.value === 'wild4') return true;
    if (card.color === activeColor) return true;
    if (card.value === topCard.value) return true;
    return false;
  }

  function nextSeatIndex(turnIndex, direction, playerCount, steps) {
    const s = steps === undefined ? 1 : steps;
    return ((turnIndex + direction * s) % playerCount + playerCount * 10) % playerCount;
  }

  /**
   * Initialize a new authoritative match state for 2..4 players.
   * @param {Array<{id: string, name: string, username?: string, initials?: string, color?: string, isHost?: boolean, isBot?: boolean}>} playersInput
   * @param {Object} options
   */
  function createMatchState(playersInput, options) {
    const opts = Object.assign({
      cardsPerPlayer: 7,
      officialOpeningEffects: true,
      enableWild4Challenge: true,
      turnTimeoutMs: 25000,
      rng: Math.random
    }, options || {});

    if (!Array.isArray(playersInput) || playersInput.length < 2 || playersInput.length > 4) {
      throw new Error('UNO match requires between 2 and 4 players.');
    }

    const state = {
      status: 'playing', // 'playing' | 'finished'
      stateVersion: 1,
      deck: createStandardDeck(opts.rng),
      discard: [],
      players: playersInput.map((p, idx) => ({
        id: String(p.id),
        seat: idx,
        name: String(p.name || ('Player ' + (idx + 1))),
        username: String(p.username || ''),
        initials: String(p.initials || String(p.name || 'P').slice(0, 2).toUpperCase()),
        color: p.color || ['#475569', '#ff5c6c', '#8b5cf6', '#10b981'][idx % 4],
        isHost: Boolean(p.isHost || idx === 0),
        isBot: Boolean(p.isBot),
        connected: p.connected !== false,
        hand: [],
        saidUno: false,
        rematchReady: false,
        wins: Number(p.wins || 0)
      })),
      turnIndex: 0,
      direction: 1,
      activeColor: 'red',
      hasDrawnThisTurn: false,
      drawnCardId: null,
      unoVulnerablePlayerId: null,
      pendingWild4: null, // { offenderId, victimId, previousColor, chosenColor, wasLegal, cardId }
      winnerId: null,
      winScore: 0,
      reshuffleCount: 0,
      processedActionIds: [],
      lastEvent: null,
      turnStartedAt: Date.now(),
      options: {
        officialOpeningEffects: Boolean(opts.officialOpeningEffects),
        enableWild4Challenge: Boolean(opts.enableWild4Challenge),
        turnTimeoutMs: Number(opts.turnTimeoutMs)
      }
    };

    // Deal 7 cards to each player
    for (let c = 0; c < opts.cardsPerPlayer; c++) {
      for (let p = 0; p < state.players.length; p++) {
        const drawn = drawCardsFromState(state, 1, opts.rng);
        if (drawn.length) state.players[p].hand.push(drawn[0]);
      }
    }

    // Draw opening card: per official rules, Wild Draw 4 cannot be the opening card (return to deck & shuffle)
    let openingCard = state.deck.pop();
    let safety = 0;
    while (
      openingCard &&
      (openingCard.value === 'wild4' || (!opts.officialOpeningEffects && openingCard.color === 'wild')) &&
      safety < 50
    ) {
      state.deck.unshift(openingCard);
      state.deck = shuffleDeck(state.deck, opts.rng);
      openingCard = state.deck.pop();
      safety++;
    }

    openingCard.rot = 3;
    state.discard.push(openingCard);

    if (openingCard.color === 'wild') {
      state.activeColor = SUITS[0];
    } else {
      state.activeColor = openingCard.color;
    }

    // Apply official opening card effect if enabled
    if (opts.officialOpeningEffects) {
      if (openingCard.value === 'skip') {
        state.turnIndex = nextSeatIndex(0, state.direction, state.players.length, 1);
      } else if (openingCard.value === 'reverse') {
        if (state.players.length === 2) {
          state.turnIndex = nextSeatIndex(0, state.direction, state.players.length, 1);
        } else {
          state.direction = -1;
          state.turnIndex = nextSeatIndex(0, state.direction, state.players.length, 1);
        }
      } else if (openingCard.value === 'draw2') {
        const drawn = drawCardsFromState(state, 2, opts.rng);
        state.players[0].hand.push(...drawn);
        state.turnIndex = nextSeatIndex(0, state.direction, state.players.length, 1);
      }
    }

    state.lastEvent = {
      type: 'MATCH_STARTED',
      openingCard,
      activeColor: state.activeColor,
      turnPlayerId: state.players[state.turnIndex].id,
      timestamp: Date.now()
    };

    return state;
  }

  function recordActionId(state, actionId) {
    if (!actionId) return false;
    if (state.processedActionIds.includes(actionId)) return true;
    state.processedActionIds.push(actionId);
    if (state.processedActionIds.length > 64) {
      state.processedActionIds.shift();
    }
    return false;
  }

  function calculateWinnerScore(state, winnerId) {
    let total = 0;
    for (const p of state.players) {
      if (p.id !== winnerId) {
        for (const c of p.hand) {
          total += (c.points !== undefined ? c.points : (CARD_POINTS[c.value] || 0));
        }
      }
    }
    return total;
  }

  /**
   * Process a validated player action against the authoritative match state.
   * Returns { ok: boolean, error?: string, event?: Object, state: Object }
   */
  function applyAction(state, action, rng) {
    if (!state || state.status !== 'playing') {
      return { ok: false, error: 'Match is not currently active.', state };
    }
    if (!action || typeof action !== 'object') {
      return { ok: false, error: 'Invalid action payload.', state };
    }

    const playerId = String(action.playerId || '');
    const playerIndex = state.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) {
      return { ok: false, error: 'Player is not seated in this match.', state };
    }
    const player = state.players[playerIndex];

    // Idempotency / duplicate tap guard
    if (action.actionId && recordActionId(state, String(action.actionId))) {
      return { ok: false, error: 'Duplicate action ignored.', duplicate: true, state };
    }

    const type = String(action.type || '').toUpperCase();

    // 1. Emoji Reaction (allowed by any seated player at any time)
    if (type === 'EMOJI') {
      const emoji = String(action.emoji || '😎').slice(0, 8);
      state.stateVersion++;
      const ev = {
        type: 'EMOJI',
        playerId: player.id,
        seat: player.seat,
        emoji,
        timestamp: Date.now()
      };
      state.lastEvent = ev;
      return { ok: true, event: ev, state };
    }

    // 2. UNO Declaration ('CALL_UNO')
    if (type === 'CALL_UNO') {
      if (player.hand.length > 2 || player.hand.length === 0) {
        return { ok: false, error: 'UNO can only be declared with 1 or 2 cards in hand.', state };
      }
      player.saidUno = true;
      if (state.unoVulnerablePlayerId === player.id) {
        state.unoVulnerablePlayerId = null;
      }
      state.stateVersion++;
      const ev = {
        type: 'UNO_CALLED',
        playerId: player.id,
        seat: player.seat,
        timestamp: Date.now()
      };
      state.lastEvent = ev;
      return { ok: true, event: ev, state };
    }

    // 3. Catch Missed UNO ('CATCH_UNO')
    if (type === 'CATCH_UNO') {
      const vulnId = state.unoVulnerablePlayerId;
      if (!vulnId) {
        return { ok: false, error: 'No player is currently vulnerable to an UNO penalty.', state };
      }
      if (vulnId === player.id) {
        return { ok: false, error: 'Cannot catch yourself.', state };
      }
      const offender = state.players.find(p => p.id === vulnId);
      if (!offender || offender.hand.length !== 1 || offender.saidUno) {
        state.unoVulnerablePlayerId = null;
        return { ok: false, error: 'Player is no longer vulnerable to an UNO penalty.', state };
      }
      const penaltyCards = drawCardsFromState(state, 2, rng);
      offender.hand.push(...penaltyCards);
      offender.saidUno = false;
      state.unoVulnerablePlayerId = null;
      state.stateVersion++;
      const ev = {
        type: 'UNO_CAUGHT',
        catcherId: player.id,
        offenderId: offender.id,
        offenderSeat: offender.seat,
        penaltyCount: penaltyCards.length,
        timestamp: Date.now()
      };
      state.lastEvent = ev;
      return { ok: true, event: ev, state };
    }

    // 4. Handle Pending Wild Draw Four (+4) Decision (ACCEPT_WILD4 vs CHALLENGE_WILD4)
    if (state.pendingWild4) {
      if (player.id !== state.pendingWild4.victimId) {
        return { ok: false, error: 'Waiting for target player to accept or challenge Wild +4.', state };
      }
      const pw = state.pendingWild4;
      const offender = state.players.find(p => p.id === pw.offenderId);

      if (type === 'ACCEPT_WILD4') {
        const drawn = drawCardsFromState(state, 4, rng);
        player.hand.push(...drawn);
        player.saidUno = false;
        state.pendingWild4 = null;
        state.turnIndex = nextSeatIndex(player.seat, state.direction, state.players.length, 1);
        state.hasDrawnThisTurn = false;
        state.drawnCardId = null;
        state.turnStartedAt = Date.now();
        state.stateVersion++;
        const ev = {
          type: 'WILD4_ACCEPTED',
          victimId: player.id,
          victimSeat: player.seat,
          drawnCount: drawn.length,
          turnPlayerId: state.players[state.turnIndex].id,
          timestamp: Date.now()
        };
        state.lastEvent = ev;
        return { ok: true, event: ev, state };
      }

      if (type === 'CHALLENGE_WILD4') {
        state.pendingWild4 = null;
        if (!pw.wasLegal && offender) {
          // Challenge succeeded! Offender illegally played +4 while holding previous color -> offender draws 4, victim keeps turn!
          const drawn = drawCardsFromState(state, 4, rng);
          offender.hand.push(...drawn);
          offender.saidUno = false;
          state.turnIndex = player.seat;
          state.hasDrawnThisTurn = false;
          state.drawnCardId = null;
          state.turnStartedAt = Date.now();
          state.stateVersion++;
          const ev = {
            type: 'WILD4_CHALLENGE_RESULT',
            challengerId: player.id,
            offenderId: offender.id,
            offenderSeat: offender.seat,
            challengeSuccess: true,
            penaltyPlayerId: offender.id,
            penaltySeat: offender.seat,
            penaltyCount: drawn.length,
            turnPlayerId: state.players[state.turnIndex].id,
            timestamp: Date.now()
          };
          state.lastEvent = ev;
          return { ok: true, event: ev, state };
        } else {
          // Challenge failed! Wild +4 was legal -> challenger draws 6 cards and loses turn!
          const drawn = drawCardsFromState(state, 6, rng);
          player.hand.push(...drawn);
          player.saidUno = false;
          state.turnIndex = nextSeatIndex(player.seat, state.direction, state.players.length, 1);
          state.hasDrawnThisTurn = false;
          state.drawnCardId = null;
          state.turnStartedAt = Date.now();
          state.stateVersion++;
          const ev = {
            type: 'WILD4_CHALLENGE_RESULT',
            challengerId: player.id,
            offenderId: offender ? offender.id : null,
            challengeSuccess: false,
            penaltyPlayerId: player.id,
            penaltySeat: player.seat,
            penaltyCount: drawn.length,
            turnPlayerId: state.players[state.turnIndex].id,
            timestamp: Date.now()
          };
          state.lastEvent = ev;
          return { ok: true, event: ev, state };
        }
      }

      return { ok: false, error: 'Must send ACCEPT_WILD4 or CHALLENGE_WILD4.', state };
    }

    // All remaining actions require it to be this player's turn
    if (state.turnIndex !== playerIndex) {
      return { ok: false, error: 'It is not your turn.', state };
    }

    // 5. Pass Turn (Only valid after drawing a card this turn)
    if (type === 'PASS_TURN') {
      if (!state.hasDrawnThisTurn) {
        return { ok: false, error: 'You must draw a card before passing your turn.', state };
      }
      state.unoVulnerablePlayerId = null;
      state.hasDrawnThisTurn = false;
      state.drawnCardId = null;
      state.turnIndex = nextSeatIndex(state.turnIndex, state.direction, state.players.length, 1);
      state.turnStartedAt = Date.now();
      state.stateVersion++;
      const ev = {
        type: 'TURN_PASSED',
        playerId: player.id,
        seat: player.seat,
        turnPlayerId: state.players[state.turnIndex].id,
        timestamp: Date.now()
      };
      state.lastEvent = ev;
      return { ok: true, event: ev, state };
    }

    // 6. Draw Card from Deck ('DRAW_CARD')
    if (type === 'DRAW_CARD') {
      if (state.hasDrawnThisTurn) {
        // If holdTurnOnPlayableDraw was active and player taps Draw Deck again, pass turn cleanly
        state.unoVulnerablePlayerId = null;
        state.hasDrawnThisTurn = false;
        state.drawnCardId = null;
        state.turnIndex = nextSeatIndex(state.turnIndex, state.direction, state.players.length, 1);
        state.turnStartedAt = Date.now();
        state.stateVersion++;
        const ev = {
          type: 'TURN_PASSED',
          playerId: player.id,
          seat: player.seat,
          turnPlayerId: state.players[state.turnIndex].id,
          timestamp: Date.now()
        };
        state.lastEvent = ev;
        return { ok: true, event: ev, state };
      }
      state.unoVulnerablePlayerId = null;
      const drawn = drawCardsFromState(state, 1, rng);
      if (drawn.length === 0) {
        state.hasDrawnThisTurn = false;
        state.drawnCardId = null;
        state.turnIndex = nextSeatIndex(state.turnIndex, state.direction, state.players.length, 1);
        state.turnStartedAt = Date.now();
        state.stateVersion++;
        const ev = {
          type: 'DECK_EMPTY_PASS',
          playerId: player.id,
          seat: player.seat,
          turnPlayerId: state.players[state.turnIndex].id,
          timestamp: Date.now()
        };
        state.lastEvent = ev;
        return { ok: true, event: ev, state };
      }

      const drawnCard = drawn[0];
      player.hand.push(drawnCard);
      player.saidUno = false;

      const topCard = state.discard[state.discard.length - 1];
      const canPlayDrawn = isCardPlayable(drawnCard, topCard, state.activeColor, null);
      const holdTurn = Boolean(state.options && state.options.holdTurnOnPlayableDraw);

      if (canPlayDrawn && holdTurn) {
        state.hasDrawnThisTurn = true;
        state.drawnCardId = drawnCard.id;
        state.stateVersion++;
        const ev = {
          type: 'CARD_DRAWN',
          playerId: player.id,
          seat: player.seat,
          drawnCardId: drawnCard.id,
          drawnCount: 1,
          canPlayDrawn: true,
          autoAdvanced: false,
          turnPlayerId: player.id,
          timestamp: Date.now()
        };
        state.lastEvent = ev;
        return { ok: true, event: ev, state };
      } else {
        // In Matcho! rules (Video t=38.06s -> t=39.41s), drawing a card adds 1 card to hand and advances the turn
        state.hasDrawnThisTurn = false;
        state.drawnCardId = null;
        state.turnIndex = nextSeatIndex(state.turnIndex, state.direction, state.players.length, 1);
        state.turnStartedAt = Date.now();
        state.stateVersion++;
        const ev = {
          type: 'CARD_DRAWN',
          playerId: player.id,
          seat: player.seat,
          drawnCardId: drawnCard.id,
          drawnCount: 1,
          canPlayDrawn,
          autoAdvanced: true,
          turnPlayerId: state.players[state.turnIndex].id,
          timestamp: Date.now()
        };
        state.lastEvent = ev;
        return { ok: true, event: ev, state };
      }
    }

    // 7. Play a Card from Hand ('PLAY_CARD')
    if (type === 'PLAY_CARD') {
      const cardId = Number(action.cardId);
      const cardIdx = player.hand.findIndex(c => c.id === cardId);
      if (cardIdx === -1) {
        return { ok: false, error: 'Card is not in your hand.', state };
      }

      if (state.hasDrawnThisTurn && state.drawnCardId !== null && cardId !== state.drawnCardId) {
        return { ok: false, error: 'After drawing, you may only play the drawn card or pass.', state };
      }

      const card = player.hand[cardIdx];
      const topCard = state.discard[state.discard.length - 1];
      if (!isCardPlayable(card, topCard, state.activeColor, state.pendingWild4)) {
        return { ok: false, error: 'Card does not match the active color, number, or symbol.', state };
      }

      let chosenColor = card.color;
      if (card.color === 'wild' || card.value === 'wild' || card.value === 'wild4') {
        const reqColor = String(action.chosenColor || '').toLowerCase();
        if (!SUITS.includes(reqColor)) {
          return { ok: false, error: 'Wild card requires a valid chosenColor (red, yellow, green, blue).', state };
        }
        chosenColor = reqColor;
      }

      const previousColor = state.activeColor;
      // Check Wild +4 legality BEFORE removing the card from hand:
      // Legal iff player holds NO cards matching previousColor (excluding wilds)
      const heldPreviousColor = player.hand.some(
        (c, idx) => idx !== cardIdx && c.color === previousColor
      );

      // Remove card from hand & push to discard
      player.hand.splice(cardIdx, 1);
      const playedCard = Object.assign({}, card, {
        rot: Math.floor(((card.id * 7) % 13) - 6)
      });
      state.discard.push(playedCard);
      state.activeColor = chosenColor;
      state.hasDrawnThisTurn = false;
      state.drawnCardId = null;

      // Inline UNO flag support (`sayUno: true` on play)
      if (action.sayUno && player.hand.length === 1) {
        player.saidUno = true;
      }

      // CheckUNO vulnerability if player dropped to 1 card without saying UNO
      if (player.hand.length === 1 && !player.saidUno) {
        state.unoVulnerablePlayerId = player.id;
      } else {
        if (player.hand.length !== 1) player.saidUno = false;
        state.unoVulnerablePlayerId = null;
      }

      // Check if player just won the game (0 cards remaining)!
      if (player.hand.length === 0) {
        // If final card is Draw 2 or Wild +4, official rules still award the penalty cards to the next player before scoring!
        let finalPenaltyCount = 0;
        let finalVictimSeat = null;
        if (card.value === 'draw2' || card.value === 'wild4') {
          const penCount = card.value === 'wild4' ? 4 : 2;
          const victimIdx = nextSeatIndex(state.turnIndex, state.direction, state.players.length, 1);
          const victim = state.players[victimIdx];
          const penCards = drawCardsFromState(state, penCount, rng);
          victim.hand.push(...penCards);
          finalPenaltyCount = penCards.length;
          finalVictimSeat = victim.seat;
        }

        state.status = 'finished';
        state.winnerId = player.id;
        player.wins = (player.wins || 0) + 1;
        state.winScore = calculateWinnerScore(state, player.id);
        state.stateVersion++;

        const ev = {
          type: 'CARD_PLAYED_AND_WON',
          playerId: player.id,
          seat: player.seat,
          card: playedCard,
          activeColor: state.activeColor,
          winnerId: player.id,
          winScore: state.winScore,
          finalPenaltyCount,
          finalVictimSeat,
          timestamp: Date.now()
        };
        state.lastEvent = ev;
        return { ok: true, event: ev, state };
      }

      // Apply Action Card Effects
      let advanceSteps = 1;
      let penaltyVictimId = null;
      let penaltyVictimSeat = null;
      let penaltyDrawnCount = 0;

      if (card.value === 'reverse') {
        if (state.players.length === 2) {
          advanceSteps = 2; // In 2-player UNO, Reverse acts as Skip
        } else {
          state.direction *= -1;
          advanceSteps = 1;
        }
      } else if (card.value === 'skip') {
        advanceSteps = 2;
      } else if (card.value === 'draw2') {
        const victimIdx = nextSeatIndex(state.turnIndex, state.direction, state.players.length, 1);
        const victim = state.players[victimIdx];
        const drawn = drawCardsFromState(state, 2, rng);
        victim.hand.push(...drawn);
        victim.saidUno = false;
        penaltyVictimId = victim.id;
        penaltyVictimSeat = victim.seat;
        penaltyDrawnCount = drawn.length;
        advanceSteps = 2;
      } else if (card.value === 'wild4') {
        const victimIdx = nextSeatIndex(state.turnIndex, state.direction, state.players.length, 1);
        const victim = state.players[victimIdx];

        if (state.options.enableWild4Challenge && !victim.isBot) {
          // Place victim in pendingWild4 decision state so they can Accept or Challenge!
          state.pendingWild4 = {
            offenderId: player.id,
            offenderSeat: player.seat,
            victimId: victim.id,
            victimSeat: victim.seat,
            previousColor,
            chosenColor,
            wasLegal: !heldPreviousColor,
            cardId: card.id
          };
          state.turnIndex = victimIdx;
          state.turnStartedAt = Date.now();
          state.stateVersion++;
          const ev = {
            type: 'CARD_PLAYED',
            playerId: player.id,
            seat: player.seat,
            card: playedCard,
            activeColor: state.activeColor,
            direction: state.direction,
            pendingWild4: {
              offenderId: player.id,
              victimId: victim.id,
              victimSeat: victim.seat,
              chosenColor
            },
            turnPlayerId: victim.id,
            timestamp: Date.now()
          };
          state.lastEvent = ev;
          return { ok: true, event: ev, state };
        } else {
          // Immediate +4 draw (when target is bot or challenge disabled)
          const drawn = drawCardsFromState(state, 4, rng);
          victim.hand.push(...drawn);
          victim.saidUno = false;
          penaltyVictimId = victim.id;
          penaltyVictimSeat = victim.seat;
          penaltyDrawnCount = drawn.length;
          advanceSteps = 2;
        }
      }

      state.turnIndex = nextSeatIndex(state.turnIndex, state.direction, state.players.length, advanceSteps);
      state.turnStartedAt = Date.now();
      state.stateVersion++;

      const ev = {
        type: 'CARD_PLAYED',
        playerId: player.id,
        seat: player.seat,
        card: playedCard,
        activeColor: state.activeColor,
        direction: state.direction,
        penaltyVictimId,
        penaltyVictimSeat,
        penaltyDrawnCount,
        unoVulnerablePlayerId: state.unoVulnerablePlayerId,
        turnPlayerId: state.players[state.turnIndex].id,
        timestamp: Date.now()
      };
      state.lastEvent = ev;
      return { ok: true, event: ev, state };
    }

    return { ok: false, error: `Unknown action type: ${type}`, state };
  }

  /**
   * Choose an intelligent legal action for a Bot / disconnected player timeout.
   */
  function computeBotAction(state, botPlayerId) {
    if (!state || state.status !== 'playing') return null;
    const bot = state.players.find(p => p.id === String(botPlayerId));
    if (!bot) return null;

    if (state.pendingWild4 && state.pendingWild4.victimId === bot.id) {
      return { type: 'ACCEPT_WILD4', playerId: bot.id };
    }

    // If an opponent is UNO-vulnerable, catch them!
    if (state.unoVulnerablePlayerId && state.unoVulnerablePlayerId !== bot.id) {
      return { type: 'CATCH_UNO', playerId: bot.id };
    }

    if (state.players[state.turnIndex].id !== bot.id) return null;

    const topCard = state.discard[state.discard.length - 1];
    const playable = bot.hand.filter(c => isCardPlayable(c, topCard, state.activeColor, state.pendingWild4));

    if (playable.length > 0) {
      // Prefer non-wild cards first, highest point value first
      playable.sort((a, b) => {
        if (a.color === 'wild' && b.color !== 'wild') return 1;
        if (a.color !== 'wild' && b.color === 'wild') return -1;
        return (b.points || 0) - (a.points || 0);
      });
      const chosen = playable[0];
      let chosenColor = chosen.color;
      if (chosen.color === 'wild') {
        const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
        for (const c of bot.hand) {
          if (counts[c.color] !== undefined) counts[c.color]++;
        }
        chosenColor = 'red';
        for (const s of SUITS) {
          if (counts[s] > counts[chosenColor]) chosenColor = s;
        }
      }
      return {
        type: 'PLAY_CARD',
        playerId: bot.id,
        cardId: chosen.id,
        chosenColor,
        sayUno: bot.hand.length === 2
      };
    }

    if (state.hasDrawnThisTurn) {
      return { type: 'PASS_TURN', playerId: bot.id };
    }

    return { type: 'DRAW_CARD', playerId: bot.id };
  }

  /**
   * Create a sanitized client view of the match state for a specific viewer (player or spectator).
   * Never leaks other players' private hand cards or the draw deck order while match is playing!
   */
  function sanitizeStateForViewer(state, viewerId) {
    if (!state) return null;
    const isFinished = state.status === 'finished';
    const vId = viewerId ? String(viewerId) : null;

    return {
      status: state.status,
      stateVersion: state.stateVersion,
      deckCount: state.deck.length,
      discard: state.discard.slice(-4),
      turnIndex: state.turnIndex,
      turnPlayerId: state.players[state.turnIndex] ? state.players[state.turnIndex].id : null,
      direction: state.direction,
      activeColor: state.activeColor,
      hasDrawnThisTurn: state.hasDrawnThisTurn,
      drawnCardId: (vId && state.players[state.turnIndex] && state.players[state.turnIndex].id === vId)
        ? state.drawnCardId
        : null,
      unoVulnerablePlayerId: state.unoVulnerablePlayerId,
      pendingWild4: state.pendingWild4 ? {
        offenderId: state.pendingWild4.offenderId,
        offenderSeat: state.pendingWild4.offenderSeat,
        victimId: state.pendingWild4.victimId,
        victimSeat: state.pendingWild4.victimSeat,
        chosenColor: state.pendingWild4.chosenColor
      } : null,
      winnerId: state.winnerId,
      winScore: state.winScore,
      lastEvent: state.lastEvent,
      turnStartedAt: state.turnStartedAt,
      players: state.players.map(p => {
        const isSelf = (vId && p.id === vId);
        return {
          id: p.id,
          seat: p.seat,
          name: p.name,
          username: p.username,
          initials: p.initials,
          color: p.color,
          isHost: p.isHost,
          isBot: p.isBot,
          connected: p.connected,
          cardCount: p.hand.length,
          saidUno: p.saidUno,
          rematchReady: p.rematchReady,
          wins: p.wins,
          // Only reveal actual card faces to the card owner OR to everyone once the game finishes (for the face-up reveal animation!)
          hand: (isSelf || isFinished) ? p.hand : []
        };
      })
    };
  }

  return {
    SUITS,
    VALID_VALUES,
    CARD_POINTS,
    createStandardDeck,
    shuffleDeck,
    drawCardsFromState,
    isCardPlayable,
    nextSeatIndex,
    createMatchState,
    applyAction,
    computeBotAction,
    sanitizeStateForViewer
  };
});
