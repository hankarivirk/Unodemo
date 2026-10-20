import { randomUUID } from 'node:crypto';

export const COLORS = Object.freeze(['red', 'blue', 'green', 'yellow']);
export const CARD_TYPES = Object.freeze(['number', 'skip', 'reverse', 'draw2', 'wild', 'wild4']);

export function createDeck() {
  const deck = [];
  for (const color of COLORS) {
    deck.push(makeCard(color, 'number', 0));
    for (let value = 1; value <= 9; value += 1) {
      deck.push(makeCard(color, 'number', value));
      deck.push(makeCard(color, 'number', value));
    }
    for (const type of ['skip', 'reverse', 'draw2']) {
      deck.push(makeCard(color, type));
      deck.push(makeCard(color, type));
    }
  }
  for (let i = 0; i < 4; i += 1) {
    deck.push(makeCard(null, 'wild'));
    deck.push(makeCard(null, 'wild4'));
  }
  return deck;
}

function makeCard(color, type, value = null) {
  return { id: randomUUID(), color, type, value };
}

export function shuffle(items, random = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function createGame(players, { random = Math.random } = {}) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 6) {
    throw new Error('A game needs between 2 and 6 players.');
  }
  const deck = shuffle(createDeck(), random);
  const gamePlayers = players.map((player) => ({
    ...player,
    hand: [],
    connected: player.isBot ? true : Boolean(player.connected ?? player.socketId),
    rematch: false,
  }));

  for (let round = 0; round < 7; round += 1) {
    for (const player of gamePlayers) {
      const card = deck.pop();
      if (!card) throw new Error('Deck exhausted during deal.');
      player.hand.push(card);
    }
  }

  // Start from a numbered card so there is no unresolved opening wild/action effect.
  let firstCardIndex = deck.findIndex((card) => card.type === 'number');
  if (firstCardIndex < 0) firstCardIndex = deck.length - 1;
  const firstCard = deck.splice(firstCardIndex, 1)[0];

  return {
    status: 'playing',
    phase: 'playing',
    players: gamePlayers,
    drawPile: deck,
    discardPile: [firstCard],
    activeColor: firstCard.color,
    currentIndex: 0,
    direction: 1,
    hasDrawnCardId: null,
    pendingWildEffect: null,
    winnerId: null,
    turnNumber: 1,
    lastAction: { type: 'start' },
  };
}

export function currentPlayer(game) {
  return game.players[game.currentIndex] ?? null;
}

export function topCard(game) {
  return game.discardPile.at(-1) ?? null;
}

export function cardIsPlayable(game, card, player = currentPlayer(game)) {
  if (!card || !player || game.status !== 'playing' || game.phase !== 'playing') return false;
  const top = topCard(game);
  if (!top) return true;
  if (card.type === 'wild') return true;
  if (card.type === 'wild4') {
    // Standard-style challenge rule: Wild Draw Four cannot be played while holding
    // another card matching the active color.
    return !player.hand.some((other) => other.id !== card.id && other.color === game.activeColor);
  }
  return card.color === game.activeColor || (card.type === top.type && card.value === top.value);
}

export function legalCards(game, playerId = currentPlayer(game)?.id) {
  const player = game.players.find((item) => item.id === playerId);
  if (!player || player.id !== currentPlayer(game)?.id || game.phase !== 'playing' || game.status !== 'playing') return [];
  if (game.hasDrawnCardId) {
    const drawn = player.hand.find((card) => card.id === game.hasDrawnCardId);
    return drawn && cardIsPlayable(game, drawn, player) ? [drawn.id] : [];
  }
  return player.hand.filter((card) => cardIsPlayable(game, card, player)).map((card) => card.id);
}

export function playCard(game, playerId, cardId) {
  assertCurrentTurn(game, playerId, 'playing');
  const player = currentPlayer(game);
  const cardIndex = player.hand.findIndex((card) => card.id === cardId);
  if (cardIndex < 0) throw new Error('That card is not in your hand.');
  const card = player.hand[cardIndex];
  if (game.hasDrawnCardId && card.id !== game.hasDrawnCardId) throw new Error('After drawing, you may only play the drawn card.');
  if (!cardIsPlayable(game, card, player)) throw new Error('That card cannot be played now.');

  player.hand.splice(cardIndex, 1);
  game.discardPile.push(card);
  if (card.color) game.activeColor = card.color;
  game.hasDrawnCardId = null;
  game.lastAction = { type: 'play', playerId, card: { ...card } };

  if (card.type === 'wild' || card.type === 'wild4') {
    game.phase = 'wild';
    game.pendingWildEffect = card.type === 'wild4' ? 4 : 0;
    return { card, awaitingColor: true, gameOverPending: player.hand.length === 0 };
  }

  if (player.hand.length === 0) {
    finishGame(game, player.id);
    return { card, awaitingColor: false, gameOver: true };
  }

  if (card.type === 'reverse') {
    game.direction *= -1;
    advance(game, game.players.length === 2 ? 2 : 1);
  } else if (card.type === 'skip') {
    advance(game, 2);
  } else if (card.type === 'draw2') {
    const victim = nextPlayer(game, 1);
    drawCards(game, victim, 2);
    advance(game, 2);
  } else {
    advance(game, 1);
  }
  game.turnNumber += 1;
  return { card, awaitingColor: false, gameOver: game.status === 'finished' };
}

export function chooseColor(game, playerId, color) {
  assertCurrentTurn(game, playerId, 'wild');
  if (!COLORS.includes(color)) throw new Error('Choose a valid color.');
  const player = currentPlayer(game);
  const effect = game.pendingWildEffect ?? 0;
  game.activeColor = color;
  game.phase = 'playing';
  game.pendingWildEffect = null;
  game.lastAction = { type: 'color', playerId, color };

  if (player.hand.length === 0) {
    finishGame(game, player.id);
    return { color, gameOver: true };
  }

  if (effect === 4) {
    const victim = nextPlayer(game, 1);
    drawCards(game, victim, 4);
    advance(game, 2);
  } else {
    advance(game, 1);
  }
  game.turnNumber += 1;
  return { color, gameOver: game.status === 'finished' };
}

export function drawCard(game, playerId) {
  assertCurrentTurn(game, playerId, 'playing');
  if (game.hasDrawnCardId) throw new Error('You already drew a card this turn.');
  const player = currentPlayer(game);
  const card = drawOne(game);
  if (!card) {
    advance(game, 1);
    game.turnNumber += 1;
    game.lastAction = { type: 'draw-empty', playerId };
    return { card: null, canPlay: false };
  }
  player.hand.push(card);
  game.lastAction = { type: 'draw', playerId, cardId: card.id };

  if (cardIsPlayable(game, card, player)) {
    game.hasDrawnCardId = card.id;
    return { card, canPlay: true };
  }
  advance(game, 1);
  game.turnNumber += 1;
  return { card, canPlay: false };
}

export function passTurn(game, playerId) {
  assertCurrentTurn(game, playerId, 'playing');
  if (!game.hasDrawnCardId) throw new Error('Draw a card before passing.');
  const player = currentPlayer(game);
  game.hasDrawnCardId = null;
  game.lastAction = { type: 'pass', playerId };
  advance(game, 1);
  game.turnNumber += 1;
  return { playerId: player.id };
}

export function startRematch(previousGame, { random = Math.random } = {}) {
  const next = createGame(previousGame.players.map(({ hand, rematch, ...player }) => player), { random });
  next.turnNumber = 1;
  return next;
}

export function drawCards(game, player, amount) {
  for (let i = 0; i < amount; i += 1) {
    const card = drawOne(game);
    if (!card) break;
    player.hand.push(card);
  }
}

function drawOne(game) {
  if (game.drawPile.length === 0 && game.discardPile.length > 1) {
    const top = game.discardPile.pop();
    game.drawPile = shuffle(game.discardPile);
    game.discardPile = [top];
  }
  return game.drawPile.pop() ?? null;
}

function nextPlayer(game, steps = 1) {
  const index = (game.currentIndex + game.direction * steps) % game.players.length;
  return game.players[(index + game.players.length) % game.players.length];
}

function advance(game, steps = 1) {
  game.currentIndex = (game.currentIndex + game.direction * steps) % game.players.length;
  if (game.currentIndex < 0) game.currentIndex += game.players.length;
  game.hasDrawnCardId = null;
}

function assertCurrentTurn(game, playerId, requiredPhase) {
  if (game.status !== 'playing') throw new Error('This game is not in progress.');
  if (game.phase !== requiredPhase) throw new Error(requiredPhase === 'wild' ? 'Choose a color first.' : 'Wait until a color has been chosen.');
  const current = currentPlayer(game);
  if (!current || current.id !== playerId) throw new Error('It is not your turn.');
}

function finishGame(game, winnerId) {
  game.status = 'finished';
  game.phase = 'finished';
  game.winnerId = winnerId;
  game.hasDrawnCardId = null;
  game.pendingWildEffect = null;
  game.lastAction = { ...game.lastAction, type: 'win', winnerId };
}
