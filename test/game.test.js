import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLORS, createDeck, createGame, currentPlayer, cardIsPlayable, legalCards,
  playCard, chooseColor, drawCard, passTurn,
} from '../src/game.js';

function card(id, color, type = 'number', value = null) {
  return { id, color, type, value };
}

function fixture({ count = 3, hands, top = card('top', 'red', 'number', 5), drawPile = [] } = {}) {
  const players = Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Player ${index + 1}`,
    isBot: false,
    connected: true,
    hand: hands?.[index] || [card(`p${index + 1}-1`, COLORS[index % COLORS.length], 'number', index + 1), card(`p${index + 1}-2`, 'yellow', 'number', 8)],
  }));
  return {
    status: 'playing', phase: 'playing', players,
    drawPile: [...drawPile], discardPile: [top], activeColor: top.color,
    currentIndex: 0, direction: 1, hasDrawnCardId: null,
    pendingWildEffect: null, winnerId: null, turnNumber: 1,
    lastAction: { type: 'test' },
  };
}

test('standard deck has 108 unique cards and expected composition', () => {
  const deck = createDeck();
  assert.equal(deck.length, 108);
  assert.equal(new Set(deck.map((item) => item.id)).size, 108);
  for (const color of COLORS) {
    assert.equal(deck.filter((item) => item.color === color && item.type === 'number' && item.value === 0).length, 1);
    for (let value = 1; value <= 9; value += 1) {
      assert.equal(deck.filter((item) => item.color === color && item.type === 'number' && item.value === value).length, 2);
    }
    for (const type of ['skip', 'reverse', 'draw2']) {
      assert.equal(deck.filter((item) => item.color === color && item.type === type).length, 2);
    }
  }
  assert.equal(deck.filter((item) => item.type === 'wild').length, 4);
  assert.equal(deck.filter((item) => item.type === 'wild4').length, 4);
});

test('new game deals seven cards and conserves all cards', () => {
  const game = createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { random: () => 0.42 });
  assert.equal(game.players.length, 2);
  assert.equal(game.players[0].hand.length, 7);
  assert.equal(game.players[1].hand.length, 7);
  assert.equal(game.discardPile.length, 1);
  assert.equal(game.drawPile.length, 93);
  assert.equal(game.players.reduce((sum, p) => sum + p.hand.length, 0) + game.discardPile.length + game.drawPile.length, 108);
  assert.equal(game.discardPile[0].type, 'number');
});

test('rejects a mismatched card and rejects actions by the wrong player', () => {
  const game = fixture({ hands: [[card('a-red', 'red', 'number', 2), card('a-green', 'green', 'number', 4)], [card('b-blue', 'blue', 'number', 1)]] });
  assert.equal(cardIsPlayable(game, game.players[0].hand[1]), false);
  assert.deepEqual(legalCards(game, 'p1'), ['a-red']);
  assert.throws(() => playCard(game, 'p2', 'b-blue'), /not your turn/i);
  assert.throws(() => playCard(game, 'p1', 'a-green'), /cannot be played/i);
});

test('playing a valid number card updates the turn and discard pile', () => {
  const red = card('a-red', 'red', 'number', 2);
  const game = fixture({ hands: [[red, card('a-blue', 'blue', 'number', 3)], [card('b-blue', 'blue', 'number', 1)]] });
  const result = playCard(game, 'p1', 'a-red');
  assert.equal(result.awaitingColor, false);
  assert.equal(game.discardPile.at(-1).id, 'a-red');
  assert.equal(game.activeColor, 'red');
  assert.equal(currentPlayer(game).id, 'p2');
});

test('wild card requires a color choice and then advances', () => {
  const wild = card('a-wild', null, 'wild');
  const game = fixture({ hands: [[wild, card('a-red', 'red', 'number', 3)], [card('b-blue', 'blue', 'number', 1)]] });
  const result = playCard(game, 'p1', 'a-wild');
  assert.equal(result.awaitingColor, true);
  assert.equal(game.phase, 'wild');
  assert.throws(() => playCard(game, 'p1', 'a-red'), /color has been chosen/i);
  chooseColor(game, 'p1', 'blue');
  assert.equal(game.phase, 'playing');
  assert.equal(game.activeColor, 'blue');
  assert.equal(currentPlayer(game).id, 'p2');
});

test('wild card as the last card wins only after color selection', () => {
  const game = fixture({ hands: [[card('last-wild', null, 'wild')], [card('b-blue', 'blue', 'number', 1)]] });
  playCard(game, 'p1', 'last-wild');
  assert.equal(game.status, 'playing');
  chooseColor(game, 'p1', 'green');
  assert.equal(game.status, 'finished');
  assert.equal(game.winnerId, 'p1');
});

test('drawn playable card is the only card that may be played; passing advances', () => {
  const drawn = card('drawn-blue', 'blue', 'number', 7);
  const game = fixture({
    hands: [[card('old-red', 'red', 'number', 2), card('old-yellow', 'yellow', 'number', 3)], [card('b-blue', 'blue', 'number', 1)]],
    top: card('top-blue', 'blue', 'number', 4),
    drawPile: [drawn],
  });
  const result = drawCard(game, 'p1');
  assert.equal(result.canPlay, true);
  assert.deepEqual(legalCards(game, 'p1'), ['drawn-blue']);
  assert.throws(() => playCard(game, 'p1', 'old-red'), /drawn card/i);
  passTurn(game, 'p1');
  assert.equal(currentPlayer(game).id, 'p2');
  assert.equal(game.hasDrawnCardId, null);
});

test('reverse changes direction and skips in a two-player match', () => {
  const game = fixture({ count: 2, hands: [[card('a-reverse', 'red', 'reverse'), card('a-other', 'blue', 'number', 4)], [card('b-blue', 'blue', 'number', 2), card('b-other', 'yellow', 'number', 6)]] });
  playCard(game, 'p1', 'a-reverse');
  assert.equal(game.direction, -1);
  assert.equal(currentPlayer(game).id, 'p1');
});

test('draw two penalizes next player and skips their turn', () => {
  const game = fixture({
    hands: [[card('a-draw2', 'red', 'draw2'), card('a-other', 'blue', 'number', 4)], [card('b-1', 'blue', 'number', 2)], [card('c-1', 'yellow', 'number', 6)]],
    drawPile: [card('drawn-1', 'green', 'number', 3), card('drawn-2', 'yellow', 'number', 7), card('drawn-3', 'blue', 'number', 5)],
  });
  playCard(game, 'p1', 'a-draw2');
  assert.equal(game.players[1].hand.length, 3);
  assert.equal(currentPlayer(game).id, 'p3');
});

test('wild draw four cannot be played while holding the active color', () => {
  const wild4 = card('a-wild4', null, 'wild4');
  const game = fixture({ hands: [[wild4, card('a-red', 'red', 'number', 2)], [card('b-blue', 'blue', 'number', 1)]] });
  assert.equal(cardIsPlayable(game, wild4, game.players[0]), false);
  game.activeColor = 'blue';
  assert.equal(cardIsPlayable(game, wild4, game.players[0]), true);
});
