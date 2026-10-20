(() => {
  'use strict';

  const config = window.GAME_CONFIG || {};
  const telegram = window.Telegram?.WebApp || null;
  const $ = (id) => document.getElementById(id);
  const STORAGE_NAME = 'playlo-name';
  const STORAGE_GUEST = 'playlo-guest-id';
  const STORAGE_ROOM_PREFIX = 'playlo-room:';

  function makeGuestId() {
    try {
      if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    } catch { /* fall through */ }
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
  }

  let guestId = localStorage.getItem(STORAGE_GUEST);
  if (!guestId) {
    guestId = makeGuestId();
    localStorage.setItem(STORAGE_GUEST, guestId);
  }

  const initialTelegramName = telegram?.initDataUnsafe?.user
    ? [telegram.initDataUnsafe.user.first_name, telegram.initDataUnsafe.user.last_name].filter(Boolean).join(' ')
    : '';
  const savedName = localStorage.getItem(STORAGE_NAME) || initialTelegramName || 'Player';
  $('player-name').value = savedName;
  $('player-name').addEventListener('input', () => localStorage.setItem(STORAGE_NAME, $('player-name').value.trim().slice(0, 22)));

  if (telegram) {
    try { telegram.ready(); telegram.expand(); } catch { /* WebApp method availability varies */ }
  }

  const socket = window.io({
    path: '/socket.io',
    auth: {
      initData: telegram?.initData || '',
      guestId,
      guestName: savedName,
    },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });

  let state = null;
  let currentRoomCode = null;
  let toastTimer = null;
  let pendingResumeCode = null;
  let pendingInviteCode = new URLSearchParams(window.location.search).get('room') || '';
  if (!pendingInviteCode && telegram?.initDataUnsafe?.start_param) {
    const startParam = String(telegram.initDataUnsafe.start_param);
    const match = startParam.match(/^join_([A-Z0-9]{4,8})$/i);
    if (match) pendingInviteCode = match[1];
  }

  function toast(message) {
    const element = $('toast');
    element.textContent = String(message || 'Something went wrong.');
    element.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('visible'), 3000);
  }

  function setConnection(status, label) {
    const element = $('connection-status');
    element.classList.toggle('connected', status === 'connected');
    element.classList.toggle('error', status === 'error');
    element.querySelector('span').textContent = label;
  }

  function showHome() {
    $('screen-home').hidden = false;
    $('screen-room').hidden = true;
    state = null;
    currentRoomCode = null;
  }

  function showRoom() {
    $('screen-home').hidden = true;
    $('screen-room').hidden = false;
  }

  function saveResume(roomCode, token) {
    if (!roomCode || !token) return;
    localStorage.setItem(`${STORAGE_ROOM_PREFIX}${roomCode}`, token);
    localStorage.setItem('playlo-last-room', roomCode);
  }

  function clearResume(roomCode) {
    if (roomCode) localStorage.removeItem(`${STORAGE_ROOM_PREFIX}${roomCode}`);
    if (!roomCode || localStorage.getItem('playlo-last-room') === roomCode) {
      localStorage.removeItem('playlo-last-room');
    }
  }

  function emit(eventName, payload) {
    if (!socket.connected) {
      toast('Reconnecting… please try again in a moment.');
      return;
    }
    socket.emit(eventName, payload);
  }

  function getDisplayName() {
    return ($('player-name').value || savedName || 'Player').trim().slice(0, 22) || 'Player';
  }

  $('create-room').addEventListener('click', () => {
    localStorage.setItem(STORAGE_NAME, getDisplayName());
    emit('room:create', { name: getDisplayName() });
  });

  $('join-room').addEventListener('click', joinFromInput);
  $('join-code').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') joinFromInput();
  });
  $('join-code').addEventListener('input', () => {
    $('join-code').value = $('join-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  });

  function joinFromInput() {
    const code = $('join-code').value.trim().toUpperCase();
    if (code.length < 4) {
      toast('Enter the room code first.');
      $('join-code').focus();
      return;
    }
    localStorage.setItem(STORAGE_NAME, getDisplayName());
    emit('room:join', { code, name: getDisplayName() });
  }

  function attemptResumeOrInvite() {
    if (pendingInviteCode) {
      const code = pendingInviteCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      pendingInviteCode = '';
      $('join-code').value = code;
      emit('room:join', { code, name: getDisplayName() });
      return;
    }
    const lastRoom = localStorage.getItem('playlo-last-room');
    const token = lastRoom && localStorage.getItem(`${STORAGE_ROOM_PREFIX}${lastRoom}`);
    if (lastRoom && token) {
      pendingResumeCode = lastRoom;
      emit('room:resume', { code: lastRoom, resumeToken: token });
    }
  }

  socket.on('connect', () => {
    setConnection('connected', 'Online');
    $('create-room').disabled = false;
    $('join-room').disabled = false;
    // Resume a saved seat after reconnect; room invites are handled on the first connect.
    attemptResumeOrInvite();
  });
  socket.on('disconnect', () => {
    setConnection('error', 'Reconnecting…');
  });
  socket.on('connect_error', (error) => {
    setConnection('error', 'Connection issue');
    const message = error?.data?.message || error?.message || '';
    if (message.includes('TELEGRAM_AUTH_REQUIRED') || message.toLowerCase().includes('telegram')) {
      $('auth-hint').hidden = false;
      toast('Open the Mini App from your Telegram bot.');
    } else {
      toast('Could not connect to the game server. Check the server setup.');
    }
  });

  socket.on('room:joined', (payload) => {
    currentRoomCode = payload.roomCode;
    saveResume(payload.roomCode, payload.resumeToken);
    showRoom();
    if (payload.inviteLink) state = { ...(state || {}), inviteLink: payload.inviteLink, roomCode: payload.roomCode };
    toast(`Connected to room ${payload.roomCode}.`);
  });

  socket.on('room:state', (nextState) => {
    state = nextState;
    currentRoomCode = nextState.roomCode;
    showRoom();
    renderRoom(nextState);
  });

  socket.on('room:error', (payload) => {
    toast(payload?.message || 'The action could not be completed.');
    if (pendingResumeCode) {
      clearResume(pendingResumeCode);
      pendingResumeCode = null;
    }
  });

  socket.on('room:closed', (payload) => {
    const previousCode = currentRoomCode || state?.roomCode;
    clearResume(previousCode);
    showHome();
    toast(payload?.message || 'Room closed.');
  });

  socket.on('player:reaction', ({ playerId, emoji }) => {
    const who = state?.players?.find((player) => player.id === playerId)?.name || 'A player';
    toast(`${who} ${emoji}`);
  });

  $('copy-invite').addEventListener('click', async () => {
    const inviteLink = state?.inviteLink;
    if (!inviteLink) {
      toast('Invite link is not ready yet.');
      return;
    }
    try {
      await navigator.clipboard.writeText(inviteLink);
      toast('Invite link copied. Send it to your friend.');
    } catch {
      window.prompt('Copy this invite link:', inviteLink);
    }
  });

  $('start-game').addEventListener('click', () => emit('lobby:start'));
  $('add-bot').addEventListener('click', () => emit('lobby:add-bot'));
  $('draw-button').addEventListener('click', () => emit('card:draw'));
  $('draw-pile').addEventListener('click', () => {
    if (state?.game?.canDraw) emit('card:draw');
    else toast('You cannot draw right now.');
  });
  $('pass-button').addEventListener('click', () => emit('turn:pass'));
  $('rematch-button').addEventListener('click', () => emit('game:rematch'));
  $('back-home').addEventListener('click', () => {
    if (!currentRoomCode) return showHome();
    const shouldLeave = window.confirm('Leave this room? If a match is active, your seat may be taken over by a bot.');
    if (shouldLeave) emit('room:leave');
  });
  document.querySelectorAll('.color-choice').forEach((button) => {
    button.addEventListener('click', () => emit('wild:choose', { color: button.dataset.color }));
  });
  document.querySelectorAll('[data-emoji]').forEach((button) => {
    button.addEventListener('click', () => emit('player:react', { emoji: button.dataset.emoji }));
  });

  function addText(parent, tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    parent.appendChild(node);
    return node;
  }

  function createAvatar(player, isOffline = false) {
    const avatar = document.createElement('div');
    avatar.className = `avatar${player.isBot ? ' bot' : ''}${isOffline ? ' offline' : ''}`;
    const initials = String(player.name || 'P').trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase();
    avatar.textContent = player.isBot ? '✦' : (initials || 'P');
    return avatar;
  }

  function renderLobbyPlayers(nextState) {
    const host = $('lobby-players');
    host.replaceChildren();
    for (const player of nextState.players) {
      const tile = document.createElement('div');
      tile.className = 'player-tile';
      tile.appendChild(createAvatar(player, !player.connected));
      const copy = document.createElement('div');
      copy.className = 'player-copy';
      addText(copy, 'div', 'player-name', player.name);
      const role = document.createElement('div');
      role.className = `player-role${player.isHost ? ' role-host' : ''}`;
      role.textContent = player.isHost ? '♛ HOST' : (player.isBot ? '✦ CPU PLAYER' : (player.connected ? '● CONNECTED' : '○ RECONNECTING'));
      copy.appendChild(role);
      tile.appendChild(copy);
      if (player.reaction) addText(tile, 'span', 'player-bubble', player.reaction);
      host.appendChild(tile);
    }
    for (let i = nextState.players.length; i < nextState.maxPlayers; i += 1) {
      const empty = document.createElement('div');
      empty.className = 'player-tile empty';
      const avatar = document.createElement('div');
      avatar.className = 'avatar'; avatar.textContent = '+';
      empty.appendChild(avatar);
      const copy = document.createElement('div'); copy.className = 'player-copy';
      addText(copy, 'div', 'player-name', 'Open seat');
      addText(copy, 'div', 'player-role', 'INVITE A FRIEND');
      empty.appendChild(copy); host.appendChild(empty);
    }
  }

  function displayCardValue(card) {
    if (card.type === 'number') return String(card.value);
    return ({ skip: '⊘', reverse: '↻', draw2: '+2', wild: '✦', wild4: '+4' })[card.type] || '?';
  }

  function displayCardType(card) {
    if (card.type === 'number') return 'NUMBER';
    return ({ skip: 'SKIP', reverse: 'REVERSE', draw2: 'DRAW TWO', wild: 'WILD', wild4: 'WILD +4' })[card.type] || card.type.toUpperCase();
  }

  function createCard(card, { legal = false, interactive = false, activeColor = null } = {}) {
    const element = document.createElement(interactive ? 'button' : 'div');
    const renderedColor = card.color || activeColor || 'blue';
    const wild = card.type === 'wild' || card.type === 'wild4';
    element.className = `card ${wild ? 'wild' : renderedColor}${interactive ? ' hand-card' : ''}${legal ? ' legal' : ''}${interactive && !legal ? ' not-legal' : ''}`;
    if (interactive) {
      element.type = 'button';
      element.setAttribute('aria-label', `${card.color || 'wild'} ${displayCardType(card)} ${card.value ?? ''}`.trim());
      element.disabled = !legal;
      element.addEventListener('click', () => {
        if (legal) emit('card:play', { cardId: card.id });
        else toast('Choose a highlighted card.');
      });
    }
    addText(element, 'span', 'corner', wild ? '✦' : (card.type === 'number' ? String(card.value) : '•'));
    addText(element, 'strong', 'card-value', displayCardValue(card));
    addText(element, 'small', 'card-type', displayCardType(card));
    addText(element, 'span', 'corner bottom', wild ? '✦' : (card.type === 'number' ? String(card.value) : '•'));
    return element;
  }

  function renderOpponents(nextState) {
    const host = $('opponents');
    host.replaceChildren();
    for (const player of nextState.players.filter((item) => item.id !== nextState.you)) {
      const tile = document.createElement('div');
      const current = nextState.game?.currentPlayerId === player.id;
      tile.className = `opponent-chip${current ? ' current' : ''}`;
      tile.appendChild(createAvatar(player, !player.connected));
      const copy = document.createElement('div'); copy.className = 'player-copy';
      addText(copy, 'div', 'player-name', player.name);
      const small = document.createElement('small');
      small.textContent = `${player.handSize} card${player.handSize === 1 ? '' : 's'}${player.isBot ? ' · CPU' : ''}`;
      copy.appendChild(small); tile.appendChild(copy);
      const mini = document.createElement('div'); mini.className = 'mini-cards';
      const count = Math.min(3, player.handSize);
      for (let i = 0; i < count; i += 1) addText(mini, 'span', 'mini-card', '');
      tile.appendChild(mini);
      if (player.reaction) addText(tile, 'span', 'player-bubble', player.reaction);
      host.appendChild(tile);
    }
  }

  function renderMyHand(nextState) {
    const host = $('my-hand');
    host.replaceChildren();
    const legalIds = new Set(nextState.game?.legalCardIds || []);
    for (const card of nextState.hand || []) {
      host.appendChild(createCard(card, { legal: legalIds.has(card.id), interactive: true, activeColor: nextState.game?.activeColor }));
    }
    $('hand-count').textContent = `${(nextState.hand || []).length} card${(nextState.hand || []).length === 1 ? '' : 's'}`;
  }

  function renderDiscard(nextState) {
    const host = $('discard-pile');
    host.replaceChildren();
    if (nextState.game?.topCard) {
      host.appendChild(createCard(nextState.game.topCard, { activeColor: nextState.game.activeColor }));
    } else {
      addText(host, 'div', 'empty-pile', 'PLAY\nA CARD');
    }
    const color = nextState.game?.activeColor || 'blue';
    $('active-color-dot').className = `color-dot ${color}`;
    $('active-color-label').textContent = color.toUpperCase();
  }

  function renderRoom(nextState) {
    const roomCode = nextState.roomCode || '------';
    $('room-title').replaceChildren(document.createTextNode('Room '));
    addText($('room-title'), 'em', '', roomCode);
    const count = nextState.players.length;
    $('room-subtitle').textContent = nextState.status === 'waiting'
      ? `${count} player${count === 1 ? '' : 's'} at the table · share your invite link`
      : (nextState.status === 'finished' ? 'Round complete · request a rematch' : 'Live game · play your cards');
    $('player-count').textContent = `${count}/${nextState.maxPlayers}`;
    $('lobby-panel').hidden = nextState.status !== 'waiting';
    $('game-panel').hidden = nextState.status === 'waiting' || !nextState.game;
    $('add-bot').hidden = nextState.status !== 'waiting';
    $('start-game').hidden = nextState.status !== 'waiting';
    $('add-bot').disabled = nextState.hostId !== nextState.you || count >= nextState.maxPlayers;
    $('start-game').disabled = nextState.hostId !== nextState.you || count < 2;
    $('start-game').textContent = count < 2 && nextState.hostId === nextState.you ? 'Invite a player first' : '▶  Start game';
    $('lobby-hint').textContent = nextState.hostId !== nextState.you
      ? 'The host will start the game when everyone is ready.'
      : (count < 2 ? 'Invite a friend or add a bot to start a game.' : 'All set. Start the game when you are ready.');
    renderLobbyPlayers(nextState);
    if (!nextState.game || nextState.status === 'waiting') return;

    const game = nextState.game;
    const currentPlayer = nextState.players.find((player) => player.id === game.currentPlayerId);
    if (nextState.status === 'finished') {
      $('turn-label').textContent = 'Round complete';
    } else if (game.phase === 'wild') {
      $('turn-label').textContent = game.currentPlayerId === nextState.you ? 'Choose a color' : `${currentPlayer?.name || 'A player'} is choosing a color`;
    } else {
      $('turn-label').textContent = game.currentPlayerId === nextState.you ? 'Your turn — play or draw' : `${currentPlayer?.name || 'Player'} is playing`;
    }
    $('deck-count').textContent = `DECK · ${game.deckCount}`;
    $('direction-chip').textContent = `DIRECTION · ${game.direction === 1 ? '→' : '←'}`;
    renderOpponents(nextState);
    renderDiscard(nextState);
    renderMyHand(nextState);
    $('draw-button').disabled = !game.canDraw;
    $('draw-pile').disabled = !game.canDraw;
    $('pass-button').hidden = !game.canPass;
    $('wild-picker').hidden = !(game.phase === 'wild' && game.pendingColor && nextState.status === 'playing');
    $('draw-button').hidden = nextState.status === 'finished';
    $('pass-button').hidden = nextState.status === 'finished' || !game.canPass;
    $('hand-hint').textContent = game.phase === 'wild'
      ? (game.pendingColor ? 'Choose the color that continues play.' : 'The active player is choosing a color.')
      : (game.currentPlayerId === nextState.you ? (game.canPass ? 'You drew a playable card. Play it or end your turn.' : 'Play a highlighted card or draw one.') : 'Wait for your turn; you can still send a reaction.');
    $('finished-panel').hidden = nextState.status !== 'finished';
    if (nextState.status === 'finished') {
      const winner = nextState.players.find((player) => player.id === game.winnerId);
      $('winner-title').textContent = winner ? `${winner.name} wins!` : 'Round complete';
      $('winner-copy').textContent = winner?.id === nextState.you ? 'Great round — you cleared your hand first.' : `${winner?.name || 'A player'} cleared their hand first. Ready for another round?`;
      const humanPlayers = nextState.players.filter((player) => !player.isBot);
      const votes = humanPlayers.filter((player) => player.rematch).length;
      const alreadyVoted = nextState.players.find((player) => player.id === nextState.you)?.rematch;
      $('rematch-button').disabled = Boolean(alreadyVoted);
      $('rematch-button').textContent = alreadyVoted ? 'Waiting for friends…' : 'Play again  ↻';
      $('rematch-status').textContent = `${votes}/${humanPlayers.length} players requested a rematch.`;
    }
  }

  $('create-room').disabled = true;
  $('join-room').disabled = true;
  setConnection('error', 'Connecting…');

  // Keeps the viewport comfortable in Telegram clients while respecting each platform's safe areas.
  if (telegram?.onEvent) {
    try { telegram.onEvent('viewportChanged', () => telegram.expand?.()); } catch { /* optional on older clients */ }
  }
})();
