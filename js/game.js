// Matcho! (Beta) — Reference-Matched Visual & Gameplay Client
// Preserves Telegram Native Header/Menu (`SettingsButton`, `BackButton`),
// 2-Tier Hand Layout (7 back + front row), Physical Card Lift & Drag-and-Drop,
// 2-Stage Win/Lose Transition, Bundled iOS Emoji Artwork & Real Multiplayer
(function() {
  'use strict';

  const UnoEngine = window.UnoEngine;

  const urlParams = new URLSearchParams(window.location.search || '');
  const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  const IS_DEV_MODE = urlParams.get('dev') === '1';

  let _tgConfigured = false;
  function getTelegramWebApp() {
    const webapp = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
    if (webapp && !_tgConfigured) {
      _tgConfigured = true;
      try {
        webapp.ready();
        webapp.expand();
        if (typeof webapp.requestFullscreen === 'function') {
          try { webapp.requestFullscreen(); } catch (e) {}
        }
        if (webapp.setHeaderColor) webapp.setHeaderColor('#1b1128');
        if (webapp.setBackgroundColor) webapp.setBackgroundColor('#1b1128');
        if (webapp.SettingsButton) {
          try {
            webapp.SettingsButton.show();
            webapp.SettingsButton.onClick(openSettingsModal);
          } catch (e) {}
        }
        if (webapp.BackButton) {
          try {
            webapp.BackButton.onClick(() => {
              const modal = document.getElementById('settingsModalOverlay');
              if (modal && !modal.classList.contains('hidden')) {
                closeSettingsModal();
              }
            });
          } catch (e) {}
        }
      } catch (e) {}
    }
    return webapp;
  }

  let prefs = {
    soundOn: true,
    colorblindMode: false,
    lowQualityMode: false
  };

  function loadPrefs() {
    try {
      const raw = window.localStorage.getItem('matcho_prefs_v4');
      if (raw) Object.assign(prefs, JSON.parse(raw));
    } catch (e) {}
  }

  function savePrefs() {
    try {
      window.localStorage.setItem('matcho_prefs_v4', JSON.stringify(prefs));
    } catch (e) {}
  }

  function openSettingsModal() {
    const modal = document.getElementById('settingsModalOverlay');
    if (modal) modal.classList.remove('hidden');
    const tg = getTelegramWebApp();
    if (tg && tg.BackButton) {
      try { tg.BackButton.show(); } catch (e) {}
    }
  }

  function closeSettingsModal() {
    const modal = document.getElementById('settingsModalOverlay');
    if (modal) modal.classList.add('hidden');
    const tg = getTelegramWebApp();
    if (tg && tg.BackButton) {
      try { tg.BackButton.hide(); } catch (e) {}
    }
  }

  getTelegramWebApp();

  function haptic(kind) {
    const tg = getTelegramWebApp();
    if (!tg || !tg.HapticFeedback) return;
    try {
      if (kind === 'light' || kind === 'medium' || kind === 'heavy') {
        tg.HapticFeedback.impactOccurred(kind);
      } else {
        tg.HapticFeedback.notificationOccurred(kind);
      }
    } catch (e) {}
  }

  // --- Synthesized Web Audio ---
  let audioCtx = null;

  function getAudio() {
    if (!prefs.soundOn) return null;
    try {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) audioCtx = new AC();
      }
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    } catch (e) {
      return null;
    }
  }

  function tone(freq, type, dur, delay, vol) {
    const ctx = getAudio();
    if (!ctx) return;
    try {
      const t0 = ctx.currentTime + (delay || 0);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(vol || 0.12, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur);
    } catch (e) {}
  }

  function sfx(name) {
    if (!prefs.soundOn) return;
    if (name === 'lift') {
      tone(600, 'sine', 0.04, 0, 0.07);
    } else if (name === 'card') {
      tone(520, 'triangle', 0.08, 0, 0.14);
      tone(760, 'sine', 0.07, 0.03, 0.11);
    } else if (name === 'deal') {
      tone(420, 'sine', 0.05, 0, 0.09);
    } else if (name === 'draw') {
      tone(350, 'sine', 0.08, 0, 0.12);
      tone(480, 'triangle', 0.06, 0.04, 0.09);
    } else if (name === 'action') {
      tone(540, 'triangle', 0.11, 0, 0.15);
      tone(740, 'triangle', 0.15, 0.07, 0.15);
    } else if (name === 'wild') {
      [440, 554, 659, 880].forEach((f, i) => tone(f, 'triangle', 0.14, i * 0.05, 0.15));
    } else if (name === 'emoji') {
      tone(620, 'sine', 0.09, 0, 0.12);
      tone(820, 'sine', 0.12, 0.06, 0.12);
    } else if (name === 'win') {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 'triangle', 0.25, i * 0.09, 0.18));
    } else if (name === 'lose') {
      [392, 349.23, 311.13, 261.63].forEach((f, i) => tone(f, 'sawtooth', 0.22, i * 0.11, 0.14));
    } else if (name === 'error') {
      tone(210, 'sawtooth', 0.12, 0, 0.1);
    }
  }

  function showToast(text, toneType) {
    const box = document.getElementById('toastBannerContainer');
    if (!box) return;
    const el = document.createElement('div');
    let cls = 'bg-[#241a35]/95 border-purple-400/40 text-white';
    if (toneType === 'error') cls = 'bg-rose-950/95 border-rose-400/60 text-rose-100';
    if (toneType === 'success') cls = 'bg-emerald-950/95 border-emerald-400/60 text-emerald-100';
    el.className = `px-3.5 py-1.5 rounded-full border text-[11px] font-bold shadow-xl transition-all duration-200 ${cls}`;
    el.textContent = text;
    box.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }, 1700);
  }

  // --- Bundled Glossy iPhone / iOS-Style Emoji SVG Artwork ---
  const APPLE_EMOJIS = [
    { id: 'sob', label: 'Crying' },
    { id: 'cool', label: 'Sunglasses' },
    { id: 'star', label: 'Star Eyes' },
    { id: 'rofl', label: 'ROFL' },
    { id: 'imp', label: 'Devil' },
    { id: 'rage', label: 'Angry' },
    { id: 'plead', label: 'Pleading' },
    { id: 'scream', label: 'Scream' },
    { id: 'weary', label: 'Weary' },
    { id: 'flushed', label: 'Flushed' },
    { id: 'dizzy', label: 'Dizzy' },
    { id: 'sleep', label: 'Sleeping' },
    { id: 'wave', label: 'Wave' },
    { id: 'party', label: 'Party' },
    { id: 'heart', label: 'Red Heart' },
    { id: 'salute', label: 'Salute' }
  ];

  function renderAppleEmojiSvg(emojiId, sizeClass) {
    const cls = sizeClass || 'w-9 h-9';
    if (emojiId === 'heart' || emojiId === '❤️') {
      return `
        <svg class="${cls} drop-shadow" viewBox="0 0 64 64">
          <defs>
            <radialGradient id="iosHeart" cx="35%" cy="28%" r="70%">
              <stop offset="0%" stop-color="#ff7b89"/>
              <stop offset="45%" stop-color="#ff2d55"/>
              <stop offset="100%" stop-color="#b80d2d"/>
            </radialGradient>
          </defs>
          <path d="M32 56C32 56 8 40 8 22C8 13 15 7 23 7C28 7 32 10 32 14C32 10 36 7 41 7C49 7 56 13 56 22C56 40 32 56 32 56Z" fill="url(#iosHeart)"/>
          <ellipse cx="21" cy="16" rx="6" ry="3.5" transform="rotate(-25 21 16)" fill="rgba(255,255,255,0.45)"/>
        </svg>
      `;
    }
    if (emojiId === 'party' || emojiId === '🎉') {
      return `
        <svg class="${cls} drop-shadow" viewBox="0 0 64 64">
          <polygon points="10,54 26,20 44,38" fill="#f59e0b" stroke="#b45309" stroke-width="1.5"/>
          <circle cx="42" cy="16" r="4" fill="#ff2d55"/>
          <circle cx="52" cy="28" r="3.5" fill="#38bdf8"/>
          <circle cx="28" cy="12" r="3.5" fill="#52e216"/>
          <path d="M34 24 Q46 14 54 18" fill="none" stroke="#a855f7" stroke-width="3.5" stroke-linecap="round"/>
          <path d="M38 30 Q48 28 56 36" fill="none" stroke="#ff3b30" stroke-width="3.5" stroke-linecap="round"/>
        </svg>
      `;
    }
    if (emojiId === 'wave' || emojiId === '👋') {
      return `
        <svg class="${cls} drop-shadow" viewBox="0 0 64 64">
          <path d="M22 34V16a3.5 3.5 0 0 1 7 0v14h2V12a3.5 3.5 0 0 1 7 0v18h2V15a3.5 3.5 0 0 1 7 0v19h2v-9a3.5 3.5 0 0 1 7 0v15c0 10-8 16-18 16s-18-7-18-17v-5a3.5 3.5 0 0 1 2 0z" fill="#ffca28"/>
          <path d="M12 22a10 10 0 0 1 6-8" fill="none" stroke="#38bdf8" stroke-width="3" stroke-linecap="round"/>
          <path d="M52 20a10 10 0 0 1 4 9" fill="none" stroke="#38bdf8" stroke-width="3" stroke-linecap="round"/>
        </svg>
      `;
    }

    const isImp = emojiId === 'imp' || emojiId === '😈';
    const isRage = emojiId === 'rage' || emojiId === '😡';
    const gradId = 'iosGrad_' + emojiId.replace(/[^a-z0-9]/gi, '');
    const cTop = isImp ? '#c084fc' : (isRage ? '#ff7b7b' : '#fff176');
    const cMid = isImp ? '#9333ea' : (isRage ? '#ff3b30' : '#ffcc00');
    const cBot = isImp ? '#581c87' : (isRage ? '#991b1b' : '#e67e00');

    let features = '';
    if (emojiId === 'sob' || emojiId === '😭') {
      features = `
        <ellipse cx="22" cy="26" rx="3.5" ry="4" fill="#3e2723"/>
        <ellipse cx="42" cy="26" rx="3.5" ry="4" fill="#3e2723"/>
        <path d="M19 30v18c0 3 6 3 6 0V30z" fill="#29b6f6"/>
        <path d="M39 30v18c0 3 6 3 6 0V30z" fill="#29b6f6"/>
        <ellipse cx="32" cy="41" rx="8" ry="6" fill="#3e2723"/>
        <path d="M26 37h12v2.5H26z" fill="#ffffff"/>
      `;
    } else if (emojiId === 'cool' || emojiId === '😎') {
      features = `
        <path d="M8 24h48l-3 2h-3l-2 9c-1 3-5 4-9 4s-6-2-7-5h-2c-1 3-3 5-7 5s-8-1-9-4l-2-9h-3z" fill="#111827"/>
        <path d="M15 26h11l-2 6H14z" fill="rgba(255,255,255,0.28)"/>
        <path d="M24 43c4 3.5 12 3.5 16 0" fill="none" stroke="#3e2723" stroke-width="3.5" stroke-linecap="round"/>
      `;
    } else if (emojiId === 'star' || emojiId === '🤩') {
      features = `
        <polygon points="21,15 23,21 29,21 24,25 26,31 21,27 16,31 18,25 13,21 19,21" fill="#ff2d55"/>
        <polygon points="43,15 45,21 51,21 46,25 48,31 43,27 38,31 40,25 35,21 41,21" fill="#ff2d55"/>
        <path d="M20 38c0 8 24 8 24 0z" fill="#3e2723"/>
        <path d="M22 38h20v3H22z" fill="#ffffff"/>
      `;
    } else if (emojiId === 'rofl' || emojiId === '🤣') {
      features = `
        <path d="M16 23l8 4-8 3" fill="none" stroke="#3e2723" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M48 23l-8 4 8 3" fill="none" stroke="#3e2723" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
        <ellipse cx="12" cy="33" rx="4.5" ry="3" transform="rotate(-30 12 33)" fill="#29b6f6"/>
        <ellipse cx="52" cy="33" rx="4.5" ry="3" transform="rotate(30 52 33)" fill="#29b6f6"/>
        <path d="M18 36c0 11 28 11 28 0z" fill="#3e2723"/>
        <path d="M26 42c3 3 9 3 12 0" fill="#ff5252"/>
      `;
    } else if (isImp) {
      features = `
        <path d="M12 14L6 4l12 5z" fill="#7e22ce"/>
        <path d="M52 14L58 4 46 9z" fill="#7e22ce"/>
        <circle cx="22" cy="28" r="3.5" fill="#2e1065"/>
        <circle cx="42" cy="28" r="3.5" fill="#2e1065"/>
        <path d="M22 41c5 4 15 4 20 0" fill="none" stroke="#2e1065" stroke-width="3.5" stroke-linecap="round"/>
      `;
    } else if (isRage) {
      features = `
        <path d="M16 21l10 5" stroke="#450a0a" stroke-width="3.8" stroke-linecap="round"/>
        <path d="M48 21l-10 5" stroke="#450a0a" stroke-width="3.8" stroke-linecap="round"/>
        <circle cx="22" cy="28" r="3.5" fill="#450a0a"/>
        <circle cx="42" cy="28" r="3.5" fill="#450a0a"/>
        <path d="M22 44c5-4 15-4 20 0" fill="none" stroke="#450a0a" stroke-width="3.8" stroke-linecap="round"/>
      `;
    } else {
      features = `
        <circle cx="22" cy="27" r="3.8" fill="#3e2723"/>
        <circle cx="42" cy="27" r="3.8" fill="#3e2723"/>
        <path d="M23 41c4 3.5 14 3.5 18 0" fill="none" stroke="#3e2723" stroke-width="3.2" stroke-linecap="round"/>
      `;
    }

    return `
      <svg class="${cls} drop-shadow" viewBox="0 0 64 64">
        <defs>
          <radialGradient id="${gradId}" cx="35%" cy="28%" r="70%">
            <stop offset="0%" stop-color="${cTop}"/>
            <stop offset="55%" stop-color="${cMid}"/>
            <stop offset="100%" stop-color="${cBot}"/>
          </radialGradient>
        </defs>
        <circle cx="32" cy="32" r="28" fill="url(#${gradId})"/>
        <ellipse cx="24" cy="14" rx="11" ry="5" transform="rotate(-14 24 14)" fill="rgba(255,255,255,0.38)"/>
        ${features}
      </svg>
    `;
  }

  // --- Cute Utya Yellow Duck Holding Cards Avatar SVG (Exact Screenshot 10-23-48 Match!) ---
  function renderUtyaDuckAvatarSvg() {
    return `
      <svg class="w-full h-full rounded-full" viewBox="0 0 64 64">
        <circle cx="32" cy="32" r="32" fill="#38bdf8"/>
        <circle cx="32" cy="34" r="21" fill="#fde047"/>
        <circle cx="24" cy="28" r="3.2" fill="#111827"/>
        <circle cx="23" cy="27" r="1" fill="#ffffff"/>
        <circle cx="40" cy="28" r="3.2" fill="#111827"/>
        <circle cx="39" cy="27" r="1" fill="#ffffff"/>
        <ellipse cx="32" cy="34" rx="8" ry="4.5" fill="#f97316"/>
        <rect x="19" y="42" width="11" height="16" rx="2" transform="rotate(-15 24 50)" fill="#1e293b" stroke="#facc15" stroke-width="1.5"/>
        <rect x="27" y="41" width="11" height="16" rx="2" fill="#1e293b" stroke="#38bdf8" stroke-width="1.5"/>
        <rect x="35" y="42" width="11" height="16" rx="2" transform="rotate(15 40 50)" fill="#1e293b" stroke="#f43f5e" stroke-width="1.5"/>
      </svg>
    `;
  }

  function renderUserPhotoAvatarSvg() {
    return `
      <svg class="w-full h-full rounded-full" viewBox="0 0 64 64">
        <defs>
          <linearGradient id="bwGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#94a3b8"/>
            <stop offset="50%" stop-color="#475569"/>
            <stop offset="100%" stop-color="#1e293b"/>
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r="32" fill="url(#bwGrad)"/>
        <circle cx="23" cy="24" r="7" fill="#cbd5e1"/>
        <path d="M11 48c0-7 5-12 12-12s12 5 12 12" fill="#94a3b8"/>
        <circle cx="42" cy="26" r="6" fill="#e2e8f0"/>
        <path d="M31 48c0-6 5-11 11-11s11 5 11 11" fill="#cbd5e1"/>
      </svg>
    `;
  }

  /**
   * Resolve signed Telegram `initData` across all supported Telegram Mini App launch surfaces:
   * 1. `window.Telegram.WebApp.initData`
   * 2. URL hash `#tgWebAppData=...` (populated natively by Telegram clients even if external SDK script is delayed)
   * 3. URL query `?tgWebAppData=...` or `?initData=...`
   * 4. `sessionStorage.getItem('matcho_tg_init_data')` (persisted across in-app page reloads)
   */
  function resolveTelegramInitData() {
    const tg = getTelegramWebApp();
    let raw = (tg && typeof tg.initData === 'string' && tg.initData.trim()) ? tg.initData.trim() : '';

    if (!raw) {
      const fromHash = hashParams.get('tgWebAppData') || '';
      const fromQuery = urlParams.get('tgWebAppData') || urlParams.get('initData') || '';
      raw = (fromHash || fromQuery).trim();
    }

    if (raw) {
      try {
        window.sessionStorage.setItem('matcho_tg_init_data', raw);
      } catch (e) {}
      return raw;
    }

    try {
      const cached = window.sessionStorage.getItem('matcho_tg_init_data');
      if (cached && cached.trim()) return cached.trim();
    } catch (e) {}

    return '';
  }

  function resolveLaunchToken() {
    const fromUrl = (urlParams.get('launch_token') || hashParams.get('launch_token') || '').trim();
    if (fromUrl) {
      try { window.sessionStorage.setItem('matcho_launch_token', fromUrl); } catch (e) {}
      return fromUrl;
    }
    try {
      return (window.sessionStorage.getItem('matcho_launch_token') || '').trim();
    } catch (e) {
      return '';
    }
  }

  function loadSavedSessionToken() {
    try {
      return (
        window.sessionStorage.getItem('matcho_session_token_v4') ||
        window.localStorage.getItem('matcho_session_token_v4') ||
        ''
      ).trim();
    } catch (e) {
      return '';
    }
  }

  function saveSessionToken(token) {
    if (!token) return;
    client.sessionToken = token;
    try {
      window.sessionStorage.setItem('matcho_session_token_v4', token);
      window.localStorage.setItem('matcho_session_token_v4', token);
    } catch (e) {}
  }

  function clearSessionToken() {
    client.sessionToken = null;
    try {
      window.sessionStorage.removeItem('matcho_session_token_v4');
      window.localStorage.removeItem('matcho_session_token_v4');
    } catch (e) {}
  }

  function parseInitDataParams() {
    const raw = resolveTelegramInitData();
    if (!raw) return null;
    try {
      let decoded = raw;
      if (!decoded.includes('&') && /%26|%3D/i.test(decoded)) {
        decoded = decodeURIComponent(decoded);
      }
      return new URLSearchParams(decoded);
    } catch (e) {
      return null;
    }
  }

  function resolveLocalUser() {
    const tg = getTelegramWebApp();
    if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id) {
      const u = tg.initDataUnsafe.user;
      return {
        id: String(u.id),
        first_name: String(u.first_name || 'You'),
        username: String(u.username || '')
      };
    }
    const idParams = parseInitDataParams();
    if (idParams && idParams.get('user')) {
      try {
        const u = JSON.parse(idParams.get('user'));
        if (u && u.id) {
          return {
            id: String(u.id),
            first_name: String(u.first_name || 'You'),
            username: String(u.username || '')
          };
        }
      } catch (e) {}
    }
    const qUid = urlParams.get('uid');
    if (qUid) {
      return {
        id: String(qUid),
        first_name: String(urlParams.get('name') || 'You'),
        username: String(urlParams.get('username') || '')
      };
    }
    try {
      const saved = window.localStorage.getItem('matcho_user_v4');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    const generated = {
      id: 'tg_' + Math.floor(100000000 + Math.random() * 899999999),
      first_name: 'You',
      username: 'virk_host'
    };
    try {
      window.localStorage.setItem('matcho_user_v4', JSON.stringify(generated));
    } catch (e) {}
    return generated;
  }

  function resolveStartParam() {
    const tg = getTelegramWebApp();
    if (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) {
      return String(tg.initDataUnsafe.start_param);
    }
    const idParams = parseInitDataParams();
    if (idParams && idParams.get('start_param')) {
      return String(idParams.get('start_param'));
    }
    return (
      urlParams.get('tgWebAppStartParam') ||
      urlParams.get('startapp') ||
      urlParams.get('room') ||
      hashParams.get('tgWebAppStartParam') ||
      hashParams.get('startapp') ||
      ''
    );
  }

  let myUser = resolveLocalUser();
  let initialStartParam = resolveStartParam();

  let client = window.__matchoClient = {
    mode: 'connecting',
    ws: null,
    sessionToken: loadSavedSessionToken() || null,
    _retriedFreshInitData: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    screen: 'intro',
    roomId: null,
    room: null,
    offlineRoom: null,
    dealingInProgress: false,
    endOverlayVisible: false,
    selectedCardId: null,
    newlyDrawnCardBackId: null,
    flipRevealCardId: null,
    pendingActionInFlight: false,
    pendingWildCardId: null,
    pendingWildRect: null,
    actionSeq: 1,
    activeEmojis: {},
    dealTimers: [],
    botTimer: null,
    dragState: null
  };

  // --- SVG Center Art & Corner Tab Art (Exact Reference Match!) ---
  function getSuitColorblindSymbol(color) {
    if (!prefs.colorblindMode) return '';
    if (color === 'red') return '▲';
    if (color === 'yellow') return '●';
    if (color === 'green') return '■';
    if (color === 'blue') return '◆';
    return '';
  }

  // Circular chasing arrows for Reverse (matches Red ⇄ & Blue ⇄ in Screenshot 10-23-48 and 10-28-01!)
  function renderReverseArrowsSvg(sizeClass) {
    return `
      <svg class="${sizeClass}" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M 13 21 A 12 12 0 0 1 34 15" />
        <polyline points="28 9 35 15 27 20" />
        <path d="M 35 27 A 12 12 0 0 1 14 33" />
        <polyline points="20 39 13 33 21 28" />
      </svg>
    `;
  }

  function renderSkipCircleSvg(sizeClass) {
    return `
      <svg class="${sizeClass}" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="5.5">
        <circle cx="24" cy="24" r="13" />
        <line x1="15" y1="33" x2="33" y2="15" />
      </svg>
    `;
  }

  function getCardCenterArt(card) {
    if (card.value === 'reverse') {
      return `
        <svg class="w-11 h-11 text-white" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 22V14H32" />
          <path d="M27 8L34 14L27 20" />
          <path d="M34 26V34H16" />
          <path d="M21 40L14 34L21 28" />
        </svg>
      `;
    }
    if (card.value === 'skip') {
      return `
        <svg class="w-11 h-11 text-white" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="5.5">
          <circle cx="24" cy="24" r="14" />
          <line x1="14" y1="34" x2="34" y2="14" />
        </svg>
      `;
    }
    if (card.value === 'draw2') {
      // Exact Draw +2 Center Artwork from Video Frame t=7.4s (two overlapping white rounded mini-cards)
      return `
        <svg class="w-12 h-12" viewBox="0 0 56 56">
          <rect x="11" y="18" width="21" height="29" rx="4.5" fill="#ffffff" />
          <rect x="23" y="9" width="21" height="29" rx="4.5" fill="#ffffff" stroke="rgba(0,0,0,0.22)" stroke-width="2.5" />
        </svg>
      `;
    }
    if (card.value === 'wild') {
      // Exact 4-color diamond in center of Wild (?) card: Red top, Yellow right, Blue bottom, Green left
      return `
        <svg class="w-12 h-12" viewBox="0 0 56 56">
          <g transform="translate(28, 28) rotate(45) translate(-17, -17)">
            <rect x="0" y="0" width="15.5" height="15.5" rx="3.2" fill="#f43f3f" />
            <rect x="18.5" y="0" width="15.5" height="15.5" rx="3.2" fill="#f7be16" />
            <rect x="0" y="18.5" width="15.5" height="15.5" rx="3.2" fill="#54dc18" />
            <rect x="18.5" y="18.5" width="15.5" height="15.5" rx="3.2" fill="#1877f2" />
          </g>
        </svg>
      `;
    }
    if (card.value === 'wild4') {
      // Exact Wild +4 Center Artwork from High-Res Frame t=17.74s & t=24.13s:
      // Back-top: Yellow, Back-right: Blue, Bottom-right: Green, Front-left (topmost): Red
      return `
        <svg class="w-12 h-12" viewBox="0 0 58 58">
          <rect x="18" y="8" width="18" height="25" rx="4" fill="#f7be16" stroke="#22262e" stroke-width="3" />
          <rect x="30" y="14" width="18" height="25" rx="4" fill="#1877f2" stroke="#22262e" stroke-width="3" />
          <rect x="22" y="22" width="18" height="25" rx="4" fill="#54dc18" stroke="#22262e" stroke-width="3" />
          <rect x="10" y="18" width="18" height="25" rx="4" fill="#f43f3f" stroke="#22262e" stroke-width="3" />
        </svg>
      `;
    }
    return `<span>${card.label}</span>`;
  }

  function getCornerTabHtml(card) {
    const cb = getSuitColorblindSymbol(card.color);
    if (card.value === 'reverse') {
      return renderReverseArrowsSvg('w-4 h-4 text-white') + cb;
    }
    if (card.value === 'skip') {
      return renderSkipCircleSvg('w-4 h-4 text-white') + cb;
    }
    if (card.value === 'draw2') return '+2' + cb;
    if (card.value === 'wild') return '?';
    if (card.value === 'wild4') return '+4';
    return card.label + cb;
  }

  function renderMatchoCard(card, extraClass, chosenSuitOverride) {
    let suitClass = 'm-suit-' + card.color;
    if (card.value === 'wild') {
      suitClass = chosenSuitOverride ? ('m-suit-' + chosenSuitOverride) : 'm-suit-wild';
    } else if (card.value === 'wild4') {
      suitClass = chosenSuitOverride ? ('m-suit-' + chosenSuitOverride) : 'm-suit-wild4';
    }
    const innerDark = (card.color === 'wild') ? 'style="background:#22262e;"' : '';
    const rot = card.rot || 0;
    const rotStyle = rot ? `style="--end-rot:${rot}deg; transform:rotate(${rot}deg);"` : '';

    return `
      <div class="m-card ${suitClass} ${extraClass || ''}" data-card-id="${card.id}" ${rotStyle}>
        <div class="m-card-inner" ${innerDark}>
          <span class="m-card-tl-tab">${getCornerTabHtml(card)}</span>
          <div class="m-card-center">${getCardCenterArt(card)}</div>
        </div>
      </div>
    `;
  }

  // Exact Two-Overlapping-Cards Count Badge (`8 🎴` in Screenshot 10-23-48; `1 🟥` single red card in Screenshot 10-24-50!)
  function renderCardCountBadge(count) {
    let colorHex = '#00d8d6'; // cyan-teal for >= 5
    if (count === 4 || count === 3) colorHex = '#facc15';
    else if (count === 2) colorHex = '#fb923c';
    else if (count <= 1) colorHex = '#c92622';

    const secondPage = count > 1
      ? `<span class="absolute left-1.5 top-0.5 w-2.5 h-3.5 rounded-[2px] opacity-65 transform rotate-12" style="background:${colorHex}"></span>`
      : '';

    return `
      <span class="inline-flex items-center gap-1.5 font-extrabold text-xs" style="color:${colorHex}">
        <span class="count-roll-anim">${count}</span>
        <span class="relative inline-block w-3.5 h-4">
          <span class="absolute left-0 top-0 w-2.5 h-3.5 rounded-[2px]" style="background:${colorHex}"></span>
          ${secondPage}
        </span>
      </span>
    `;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Sort hand cards by suit color (red -> yellow -> green -> blue -> wild) and value, matching Screenshot 10-23-48 & 10-23-53!
  const SUIT_SORT_ORDER = { red: 1, yellow: 2, green: 3, blue: 4, wild: 5 };
  const VALUE_SORT_ORDER = {
    reverse: 1, skip: 2, draw2: 3,
    '0': 4, '1': 5, '2': 6, '3': 7, '4': 8, '5': 9, '6': 10, '7': 11, '8': 12, '9': 13,
    wild: 14, wild4: 15
  };

  function sortHandCardsForDisplay(handCards) {
    return (handCards || []).slice().sort((a, b) => {
      const sa = SUIT_SORT_ORDER[a.color] || 9;
      const sb = SUIT_SORT_ORDER[b.color] || 9;
      if (sa !== sb) return sa - sb;
      const va = VALUE_SORT_ORDER[a.value] || 99;
      const vb = VALUE_SORT_ORDER[b.value] || 99;
      if (va !== vb) return va - vb;
      return a.id - b.id;
    });
  }

  /**
   * Deterministic Viewport-Aware Hand Layout Algorithm (`computeHandLayout`).
   * - Uses 1 centered row for 1..7 cards.
   * - Transitions into a balanced 2-tier layout for 8+ cards (`backCount = Math.max(7, Math.ceil(N / 2))`,
   *   `frontCount = N - backCount`), matching 7+1 (8 cards) and 7+2 (9 cards) in references while preventing
   *   front-row overcrowding at 12, 15, or 20+ cards.
   * - Dynamically calculates horizontal overlap (`stepPx` and `marginLeftPx`) from `viewportWidth` so no row
   *   ever overflows the left or right screen edges or wraps into an unintended 3rd row.
   */
  const computeHandLayout = window.__computeHandLayout = function(rawCards, viewportWidth) {
    const sortedCards = sortHandCardsForDisplay(rawCards || []);
    const totalCount = sortedCards.length;
    const frameEl = document.getElementById('appViewportFrame');
    const vw = Number(viewportWidth || (frameEl && frameEl.clientWidth) || window.innerWidth || 384);
    const safePadding = 10;
    const availWidth = Math.max(250, vw - safePadding * 2);

    const cardWidth = vw < 355 ? 78 : 88;
    const cardHeight = vw < 355 ? 118 : 132;

    // Exact Reference Chunking (Frames t=52.94s & t=57.00s): Each tier holds at most 7 cards!
    const maxPerTier = 7;
    const tiers = [];
    for (let i = 0; i < totalCount; i += maxPerTier) {
      tiers.push(sortedCards.slice(i, i + maxPerTier));
    }

    function computeTierMetrics(count) {
      if (count <= 0) return { count: 0, stepPx: 0, marginLeftPx: 0, rowWidthPx: 0 };
      if (count === 1) return { count: 1, stepPx: 0, marginLeftPx: 0, rowWidthPx: cardWidth };
      const naturalStep = Math.min(43, Math.floor((availWidth - cardWidth) / 6));
      const maxFitStep = Math.floor((availWidth - cardWidth) / (count - 1));
      const stepPx = Math.max(16, Math.min(naturalStep, maxFitStep));
      const marginLeftPx = stepPx - cardWidth;
      const rowWidthPx = cardWidth + (count - 1) * stepPx;
      return { count, stepPx, marginLeftPx, rowWidthPx };
    }

    const tierMetrics = tiers.map(t => computeTierMetrics(t.length));
    const backRowCards = tiers.length > 0 ? tiers[0] : [];
    const frontRowCards = tiers.length > 1 ? tiers.slice(1).reduce((acc, r) => acc.concat(r), []) : [];
    const backMetrics = tierMetrics[0] || computeTierMetrics(0);
    const frontMetrics = tierMetrics[tierMetrics.length - 1] || computeTierMetrics(0);
    const rowOverlapTopPx = tiers.length >= 3 ? -Math.round(cardHeight * 0.76) : (tiers.length > 1 ? -Math.round(cardHeight * 0.73) : 0);

    return {
      totalCount,
      viewportWidth: vw,
      availWidth,
      cardWidth,
      cardHeight,
      tierCount: tiers.length,
      tiers,
      tierMetrics,
      backRowCards,
      frontRowCards,
      backMetrics,
      frontMetrics,
      frontRowMarginTopPx: rowOverlapTopPx
    };
  };

  /**
   * Strict Bounding-Box Target Detection for Discard Pile Drops (`isDropOverDiscardTarget`).
   * Uses the real bounding rectangle of `#centerDiscardStack` with a 34px target tolerance halo.
   * Never treats an arbitrary upward gesture (`dy < -65`) outside the discard pile as a valid drop.
   */
  const isDropOverDiscardTarget = window.__isDropOverDiscardTarget = function(clientX, clientY, draggedRect) {
    const discardEl = document.getElementById('centerDiscardStack');
    if (!discardEl) return false;
    const dRect = discardEl.getBoundingClientRect();
    if (!dRect || dRect.width <= 0 || dRect.height <= 0) return false;

    const tolX = 14;
    const tolY = 14;
    const minX = dRect.left - tolX;
    const maxX = dRect.right + tolX;
    const minY = dRect.top - tolY;
    const maxY = dRect.bottom + tolY;

    if (typeof clientX === 'number' && typeof clientY === 'number') {
      if (clientX >= minX && clientX <= maxX && clientY >= minY && clientY <= maxY) {
        return true;
      }
    }

    if (draggedRect && draggedRect.width > 0 && draggedRect.height > 0) {
      const cx = draggedRect.left + draggedRect.width / 2;
      const cy = draggedRect.top + draggedRect.height / 2;
      if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) {
        return true;
      }
      const overlapW = Math.max(0, Math.min(draggedRect.right, dRect.right) - Math.max(draggedRect.left, dRect.left));
      const overlapH = Math.max(0, Math.min(draggedRect.bottom, dRect.bottom) - Math.max(draggedRect.top, dRect.top));
      const overlapArea = overlapW * overlapH;
      if (overlapArea >= dRect.width * dRect.height * 0.25) {
        return true;
      }
    }

    return false;
  };

  // --- Coordinate Flight Helpers ---
  function getElementCenterRect(el) {
    const frame = document.getElementById('appViewportFrame');
    if (!el || !frame) return { left: 160, top: 280, width: 84, height: 126 };
    const r = el.getBoundingClientRect();
    const fr = frame.getBoundingClientRect();
    return {
      left: r.left - fr.left,
      top: r.top - fr.top,
      width: r.width || 84,
      height: r.height || 126
    };
  }

  function getRelativePositionForSeat(seatIdx, totalPlayers) {
    const room = client.room;
    const mySeat = (room && typeof room.viewerSeat === 'number') ? room.viewerSeat : 0;
    const rel = ((seatIdx - mySeat) % totalPlayers + totalPlayers) % totalPlayers;
    if (rel === 0) return 'bottom';
    if (totalPlayers === 2) return 'top';
    if (totalPlayers === 3) return rel === 1 ? 'left' : 'right';
    if (rel === 1) return 'left';
    if (rel === 2) return 'top';
    return 'right';
  }

  function getZoneElementForPosition(pos) {
    if (pos === 'bottom') return document.getElementById('bottomHandStrip') || document.getElementById('bottomPlayerStatus');
    if (pos === 'top') return document.getElementById('topOpponentZone');
    if (pos === 'left') return document.getElementById('leftOpponentZone');
    if (pos === 'right') return document.getElementById('rightOpponentZone');
    return document.getElementById('centerDiscardStack');
  }

  function spawnDiscardImpactRing() {
    if (prefs.lowQualityMode) return;
    const slot = document.getElementById('centerDiscardStack');
    if (!slot) return;
    const ring = document.createElement('div');
    ring.className = 'discard-impact-ring';
    slot.appendChild(ring);
    setTimeout(() => {
      if (ring.parentNode) ring.parentNode.removeChild(ring);
    }, 420);
  }

  function flyCardElement(startRect, endRect, cardHTML, durationMs, onComplete) {
    const layer = document.getElementById('flyingCardLayer');
    if (!layer) {
      if (onComplete) onComplete();
      return;
    }

    const dur = prefs.lowQualityMode ? Math.min(durationMs, 140) : durationMs;
    const wrapper = document.createElement('div');
    wrapper.style.position = 'absolute';
    wrapper.style.left = startRect.left + 'px';
    wrapper.style.top = startRect.top + 'px';
    wrapper.style.width = '88px';
    wrapper.style.height = '132px';
    wrapper.style.zIndex = '90';
    wrapper.style.pointerEvents = 'none';
    wrapper.style.transition = `transform ${dur}ms cubic-bezier(0.22, 1, 0.36, 1), opacity ${dur}ms ease`;
    wrapper.innerHTML = cardHTML;

    layer.appendChild(wrapper);

    const dx = (endRect.left + endRect.width / 2) - (startRect.left + 44);
    const dy = (endRect.top + endRect.height / 2) - (startRect.top + 66);
    const rot = (Math.random() * 14 - 7).toFixed(1);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        wrapper.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(${rot}deg) scale(1.03)`;
      });
    });

    setTimeout(() => {
      if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
      if (onComplete) onComplete();
    }, dur);
  }

  function flyCardBackHtml() {
    return `<div class="m-card-back" style="width:84px;height:124px;box-shadow:0 12px 24px rgba(0,0,0,0.65);"><div class="m-card-back-inner"></div></div>`;
  }

  function showView(viewName) {
    client.screen = viewName;
    ['intro', 'tgchat', 'room', 'game'].forEach(v => {
      const el = document.getElementById('view-' + v);
      if (el) {
        if (v === viewName) el.classList.remove('hidden');
        else el.classList.add('hidden');
      }
    });
  }

  // --- Real-Time WebSocket Connection & Startup Intro ---
  function showAuthRecoveryModal(reasonText) {
    // Ensure we exit the blank intro spinner so the user always sees a clear recovery UI
    if (client.screen === 'intro') {
      if (!client.offlineRoom) {
        client.offlineRoom = {
          id: 'uno_matcho',
          hostId: myUser.id,
          status: 'waiting',
          stateVersion: 1,
          viewerRole: 'player',
          viewerSeat: 0,
          players: [
            { id: myUser.id, seat: 0, name: myUser.first_name || 'You', username: '@' + (myUser.username || 'you'), initials: 'YOU', color: '#475569', isHost: true, isBot: false, connected: true, wins: 0, rematchReady: false },
            { id: 'bot_utya', seat: 1, name: 'Utya', username: '@utya_bot', initials: 'UT', color: '#38bdf8', isHost: false, isBot: true, isUtya: true, connected: true, wins: 1, rematchReady: false }
          ],
          spectators: [],
          rawMatchState: null,
          match: null
        };
        client.room = client.offlineRoom;
      }
      showView('room');
      renderRoomLobby();
    }

    const msgEl = document.getElementById('authRecoveryMessage');
    if (msgEl) {
      msgEl.textContent = reasonText
        ? `${reasonText} Open Matcho! from the Telegram bot button for live online multiplayer, or play an instant Practice Match against Utya.`
        : 'Open Matcho! from the Telegram bot button for live online multiplayer, or play an instant Practice Match against Utya.';
    }

    // Fetch bot username from /api/health if available to populate the Open in Telegram link
    if (window.fetch && window.location.host && /^https?:/i.test(window.location.protocol)) {
      window.fetch('/api/health').then(r => r.json()).then(info => {
        if (info && info.botUsername) {
          const linkEl = document.getElementById('authOpenTelegramBotLink');
          if (linkEl) {
            const startSuffix = initialStartParam ? `?startapp=${encodeURIComponent(initialStartParam)}` : '?start=play';
            linkEl.href = info.appShortName && initialStartParam
              ? `https://t.me/${info.botUsername}/${info.appShortName}${startSuffix}`
              : `https://t.me/${info.botUsername}${startSuffix}`;
          }
        }
      }).catch(() => {});
    }

    const overlay = document.getElementById('authRecoveryOverlay');
    if (overlay) overlay.classList.remove('hidden');
  }

  function hideAuthRecoveryModal() {
    const overlay = document.getElementById('authRecoveryOverlay');
    if (overlay) overlay.classList.add('hidden');
  }

  function startAppWithIntro() {
    showView('intro');
    if (urlParams.get('practice') === '1' || urlParams.get('offline') === '1') {
      setTimeout(() => startOfflinePracticeMode(false), 380);
      return;
    }

    // Poll briefly for Telegram.WebApp SDK initialization before opening the WebSocket
    let waitedMs = 0;
    const pollStep = 60;
    const maxWait = 480;
    const pollTimer = setInterval(() => {
      waitedMs += pollStep;
      getTelegramWebApp();
      const hasInit = Boolean(resolveTelegramInitData());
      if (hasInit || waitedMs >= maxWait) {
        clearInterval(pollTimer);
        myUser = resolveLocalUser();
        initialStartParam = resolveStartParam();
        connectToMultiplayerServer(null, 'player');
      }
    }, pollStep);
  }

  function buildCurrentAuthPayload() {
    myUser = resolveLocalUser();
    initialStartParam = resolveStartParam();
    return {
      initData: resolveTelegramInitData(),
      sessionToken: client.sessionToken || loadSavedSessionToken() || '',
      launchToken: resolveLaunchToken(),
      devUser: myUser
    };
  }

  function connectToMultiplayerServer(requestedRoomId, requestedMode) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    if (!host || window.location.protocol === 'file:' || window.location.protocol === 'blob:' || window.location.protocol === 'data:') {
      startOfflinePracticeMode(false);
      return;
    }

    const wsUrl = `${proto}//${host}/ws`;
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      startOfflinePracticeMode(false);
      return;
    }

    client.ws = ws;
    let opened = false;

    const connectTimeout = setTimeout(() => {
      if (!opened) {
        try { ws.close(); } catch (e) {}
        startOfflinePracticeMode(false);
      }
    }, 1800);

    ws.onopen = () => {
      opened = true;
      clearTimeout(connectTimeout);
      client.mode = 'online';
      client.reconnectAttempts = 0;
      document.getElementById('reconnectOverlay').classList.add('hidden');

      const authPayload = buildCurrentAuthPayload();
      const targetStart = requestedRoomId ? null : initialStartParam;

      if (requestedRoomId || targetStart) {
        ws.send(JSON.stringify(Object.assign({}, authPayload, {
          type: 'AUTH_JOIN',
          roomId: requestedRoomId || null,
          startParam: targetStart,
          mode: requestedMode || 'player'
        })));
      } else {
        ws.send(JSON.stringify(Object.assign({}, authPayload, {
          type: 'CREATE_ROOM'
        })));
      }
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleServerMessage(msg);
    };

    ws.onclose = () => {
      clearTimeout(connectTimeout);
      if (client.mode === 'online') {
        document.getElementById('reconnectOverlay').classList.remove('hidden');
        scheduleReconnect();
      }
    };

    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    if (client.reconnectTimer) clearTimeout(client.reconnectTimer);
    client.reconnectAttempts++;
    const delay = Math.min(5000, 800 * client.reconnectAttempts);
    client.reconnectTimer = setTimeout(() => {
      if (client.mode === 'online') {
        connectToMultiplayerServer(client.roomId, client.room ? client.room.viewerRole : 'player');
      }
    }, delay);
  }

  function sendServerCommand(payload) {
    const turnTypes = ['PLAY_CARD', 'DRAW_CARD', 'PASS_TURN', 'ACCEPT_WILD4', 'CHALLENGE_WILD4'];
    if (payload && turnTypes.includes(payload.type)) {
      if (client.pendingActionInFlight) return false;
      client.pendingActionInFlight = true;
      setTimeout(() => { client.pendingActionInFlight = false; }, 900);
    }
    if (client.mode === 'online' && client.ws && client.ws.readyState === 1) {
      client.ws.send(JSON.stringify(Object.assign({
        actionId: 'act_' + myUser.id + '_' + (client.actionSeq++) + '_' + Date.now()
      }, payload)));
      return true;
    }
    if (client.mode === 'offline') {
      handleOfflineCommand(payload);
      return true;
    }
    showToast('Reconnecting...', 'error');
    return false;
  }

  function handleServerMessage(msg) {
    client.pendingActionInFlight = false;
    if (!msg || !msg.type) return;

    if (msg.type === 'ERROR') {
      if (msg.code === 'UNAUTHORIZED' || msg.code === 'INVALID_INIT_DATA') {
        clearSessionToken();
        const freshInitData = resolveTelegramInitData();
        if (freshInitData && !client._retriedFreshInitData && client.ws && client.ws.readyState === 1) {
          client._retriedFreshInitData = true;
          const retryPayload = buildCurrentAuthPayload();
          if (client.roomId || initialStartParam) {
            client.ws.send(JSON.stringify(Object.assign({}, retryPayload, {
              type: 'AUTH_JOIN',
              roomId: client.roomId || null,
              startParam: client.roomId ? null : initialStartParam,
              mode: 'player'
            })));
          } else {
            client.ws.send(JSON.stringify(Object.assign({}, retryPayload, {
              type: 'CREATE_ROOM'
            })));
          }
          return;
        }
        showAuthRecoveryModal(msg.error || 'Telegram WebApp authentication is required.');
        return;
      }

      showToast(msg.error || 'Move not allowed.', 'error');
      if (msg.canSpectate && msg.roomId && client.ws && client.ws.readyState === 1) {
        client.ws.send(JSON.stringify(Object.assign({}, buildCurrentAuthPayload(), {
          type: 'AUTH_JOIN',
          roomId: msg.roomId,
          mode: 'spectator'
        })));
      }
      return;
    }

    if (msg.type === 'ROOM_JOINED') {
      hideAuthRecoveryModal();
      if (msg.sessionToken) saveSessionToken(msg.sessionToken);
      client.roomId = msg.room.id;
      client.room = msg.room;

      if (msg.room.status === 'waiting') {
        showView('room');
        renderRoomLobby();
      } else {
        showView('game');
        renderMatchoTable();
        if (msg.room.status === 'finished') showEndOverlay();
      }
      return;
    }

    if (msg.type === 'ROOM_STATE') {
      const prevRoom = client.room;
      client.room = msg.room;
      client.roomId = msg.room.id;
      const ev = msg.event;

      if (msg.room.status === 'waiting') {
        showView('room');
        renderRoomLobby();
        renderTgChatInvitePreview();
        return;
      }

      if (ev && ev.type === 'MATCH_STARTED' && (!prevRoom || prevRoom.status !== 'playing')) {
        runDealingAnimationAndRender();
        return;
      }

      if (ev) {
        animateConfirmedServerEvent(ev, () => {
          renderMatchoTable();
          if (client.room.status === 'finished') showEndOverlay();
        });
      } else {
        renderMatchoTable();
        if (client.room.status === 'finished') showEndOverlay();
      }
    }
  }

  function animateConfirmedServerEvent(ev, onDone) {
    if (!ev || !client.room || !client.room.match) {
      if (onDone) onDone();
      return;
    }
    const totalP = client.room.players.length;

    if (ev.type === 'EMOJI') {
      client.activeEmojis[ev.playerId] = ev.emoji;
      sfx('emoji');
      renderMatchoTable();
      setTimeout(() => {
        delete client.activeEmojis[ev.playerId];
        renderMatchoTable();
      }, 2100);
      if (onDone) onDone();
      return;
    }

    if (ev.type === 'UNO_CALLED') {
      sfx('wild');
      if (onDone) onDone();
      return;
    }

    if (ev.type === 'UNO_CAUGHT') {
      sfx('lose');
      const deckEl = document.getElementById('centerDrawDeck');
      const pos = getRelativePositionForSeat(ev.offenderSeat || 0, totalP);
      const targetEl = getZoneElementForPosition(pos);
      flyCardElement(getElementCenterRect(deckEl), getElementCenterRect(targetEl), flyCardBackHtml(), 260, () => {
        if (onDone) onDone();
      });
      return;
    }

    if (ev.type === 'CARD_DRAWN' || ev.type === 'WILD4_ACCEPTED' || ev.type === 'WILD4_CHALLENGE_RESULT') {
      const seat = ev.seat !== undefined ? ev.seat : (ev.victimSeat !== undefined ? ev.victimSeat : ev.penaltySeat);
      const count = ev.drawnCount || ev.penaltyCount || 1;
      const pos = getRelativePositionForSeat(seat || 0, totalP);
      const deckEl = document.getElementById('centerDrawDeck');
      const targetEl = getZoneElementForPosition(pos);
      const sRect = getElementCenterRect(deckEl);
      const eRect = getElementCenterRect(targetEl);

      let doneCount = 0;
      const animCards = Math.min(count, 4);
      for (let i = 0; i < animCards; i++) {
        setTimeout(() => {
          sfx('draw');
          flyCardElement(sRect, eRect, flyCardBackHtml(), 250, () => {
            doneCount++;
            if (doneCount === animCards) {
              const mySeatIdx = (client.room && typeof client.room.viewerSeat === 'number') ? client.room.viewerSeat : 0;
              const meP = client.room && client.room.match && client.room.match.players && client.room.match.players[mySeatIdx];
              if (seat === mySeatIdx && meP && meP.hand && meP.hand.length > 0) {
                const newestCard = meP.hand[meP.hand.length - 1];
                client.newlyDrawnCardBackId = newestCard.id;
                renderMatchoTable(false);
                setTimeout(() => {
                  client.newlyDrawnCardBackId = null;
                  client.flipRevealCardId = newestCard.id;
                  if (onDone) onDone();
                  setTimeout(() => { client.flipRevealCardId = null; }, 320);
                }, 200);
                return;
              }
              if (onDone) onDone();
            }
          });
        }, i * 100);
      }
      return;
    }

    if (ev.type === 'CARD_PLAYED' || ev.type === 'CARD_PLAYED_AND_WON') {
      const pos = getRelativePositionForSeat(ev.seat || 0, totalP);
      const startEl = getZoneElementForPosition(pos);
      const startRect = client._lastPlayedCardRect || getElementCenterRect(startEl);
      client._lastPlayedCardRect = null;

      const discardEl = document.getElementById('centerDiscardStack');
      const endRect = getElementCenterRect(discardEl);
      const card = ev.card;
      const suitOverride = (card && card.color === 'wild') ? ev.activeColor : '';

      sfx(card && (card.value === 'wild' || card.value === 'wild4') ? 'wild' : (card && ['skip', 'reverse', 'draw2'].includes(card.value) ? 'action' : 'card'));

      flyCardElement(startRect, endRect, renderMatchoCard(card, 'm-card-table', suitOverride), 270, () => {
        spawnDiscardImpactRing();
        if (ev.penaltyDrawnCount && ev.penaltyVictimSeat !== null && ev.penaltyVictimSeat !== undefined) {
          const vPos = getRelativePositionForSeat(ev.penaltyVictimSeat, totalP);
          const deckEl = document.getElementById('centerDrawDeck');
          const vEl = getZoneElementForPosition(vPos);
          const sR = getElementCenterRect(deckEl);
          const eR = getElementCenterRect(vEl);
          const n = Math.min(ev.penaltyDrawnCount, 4);
          let cDone = 0;
          for (let k = 0; k < n; k++) {
            setTimeout(() => {
              sfx('draw');
              flyCardElement(sR, eR, flyCardBackHtml(), 240, () => {
                cDone++;
                if (cDone === n && onDone) onDone();
              });
            }, k * 100);
          }
        } else {
          if (onDone) onDone();
        }
      });
      return;
    }

    if (onDone) onDone();
  }

  // --- Offline Practice Fallback (Uses Shared `UnoEngine` Module) ---
  function startOfflinePracticeMode(autoStartMatch) {
    client.mode = 'offline';
    document.getElementById('reconnectOverlay').classList.add('hidden');

    const defaultPlayers = [
      { id: myUser.id, seat: 0, name: 'You', username: '@' + (myUser.username || 'you'), initials: 'YOU', color: '#475569', isHost: true, isBot: false, connected: true, wins: 0, rematchReady: false },
      { id: 'bot_utya', seat: 1, name: 'Utya', username: '@utya_bot', initials: 'UT', color: '#38bdf8', isHost: false, isBot: true, isUtya: true, connected: true, wins: 1, rematchReady: false }
    ];

    client.offlineRoom = {
      id: 'uno_matcho',
      hostId: myUser.id,
      status: 'waiting',
      stateVersion: 1,
      viewerRole: 'player',
      viewerSeat: 0,
      players: defaultPlayers,
      spectators: [],
      rawMatchState: null,
      match: null
    };
    client.room = client.offlineRoom;
    client.roomId = client.offlineRoom.id;

    if (autoStartMatch) {
      handleOfflineCommand({ type: 'START_GAME' });
    } else {
      showView('room');
      renderRoomLobby();
    }
  }

  function syncOfflineSanitizedView() {
    if (!client.offlineRoom) return;
    const viewerId = client.offlineRoom.viewerRole === 'spectator' ? 'spectator_viewer' : myUser.id;
    client.offlineRoom.match = client.offlineRoom.rawMatchState
      ? UnoEngine.sanitizeStateForViewer(client.offlineRoom.rawMatchState, viewerId)
      : null;
    client.room = client.offlineRoom;
  }

  function handleOfflineCommand(cmd) {
    client.pendingActionInFlight = false;
    if (!client.offlineRoom) return;
    const r = client.offlineRoom;
    const type = String(cmd.type || '').toUpperCase();

    if (type === 'ADD_BOT') {
      const botPool = [
        { id: 'bot_utya', name: 'Utya', username: '@utya_bot', initials: 'UT', color: '#38bdf8', isUtya: true },
        { id: 'bot_pearl', name: 'P E A Г L !!', username: '@pearl_bot', initials: 'PL', color: '#ff5c6c' },
        { id: 'bot_aira', name: 'A I R A', username: '@aira_bot', initials: 'AI', color: '#8b5cf6' }
      ];
      if (r.players.length < 4) {
        const idx = r.players.length;
        const t = botPool[idx - 1] || botPool[0];
        r.players.push({
          id: t.id + '_' + idx,
          seat: idx,
          name: t.name,
          username: t.username,
          initials: t.initials,
          color: t.color,
          isHost: false,
          isBot: true,
          isUtya: Boolean(t.isUtya),
          connected: true,
          wins: 0,
          rematchReady: false
        });
      } else {
        r.players = r.players.slice(0, 1);
      }
      renderRoomLobby();
      return;
    }

    if (type === 'START_GAME' || type === 'FORCE_REMATCH') {
      if (client.botTimer) clearTimeout(client.botTimer);
      if (r.players.length < 2) {
        handleOfflineCommand({ type: 'ADD_BOT' });
      }
      r.rawMatchState = UnoEngine.createMatchState(r.players, {
        officialOpeningEffects: false,
        enableWild4Challenge: true
      });
      r.status = 'playing';
      client.endOverlayVisible = false;
      r.players.forEach(p => { p.rematchReady = false; });
      syncOfflineSanitizedView();
      runDealingAnimationAndRender();
      return;
    }

    if (type === 'REQUEST_REMATCH') {
      const me = r.players[0];
      me.rematchReady = !me.rematchReady;
      r.players.forEach((p, i) => { if (i > 0) p.rematchReady = true; });
      if (r.rawMatchState) {
        r.rawMatchState.players.forEach((mp, i) => { mp.rematchReady = r.players[i].rematchReady; });
      }
      syncOfflineSanitizedView();
      renderEndStandings();
      if (r.players.every(p => p.rematchReady)) {
        setTimeout(() => handleOfflineCommand({ type: 'START_GAME' }), 600);
      }
      return;
    }

    if (!r.rawMatchState || r.status !== 'playing') return;
    if (r.viewerRole === 'spectator' && type !== 'EMOJI') return;

    const res = UnoEngine.applyAction(r.rawMatchState, Object.assign({}, cmd, { playerId: myUser.id }));
    if (!res.ok) {
      sfx('error');
      showToast(res.error || 'Card does not match', 'error');
      return;
    }

    client.selectedCardId = null;

    if (r.rawMatchState.status === 'finished') {
      r.status = 'finished';
      r.rawMatchState.players.forEach((mp, idx) => {
        if (r.players[idx]) r.players[idx].wins = mp.wins;
      });
    }

    syncOfflineSanitizedView();
    animateConfirmedServerEvent(res.event, () => {
      renderMatchoTable();
      if (r.status === 'finished') {
        showEndOverlay();
      } else {
        scheduleOfflineBotTurnIfNeeded();
      }
    });
  }

  function scheduleOfflineBotTurnIfNeeded() {
    if (client.mode !== 'offline' || !client.offlineRoom || client.offlineRoom.status !== 'playing') return;
    if (client.botTimer) clearTimeout(client.botTimer);

    const ms = client.offlineRoom.rawMatchState;
    const activeP = ms.players[ms.turnIndex];
    if (!activeP || (!activeP.isBot && client.offlineRoom.viewerRole !== 'spectator')) return;

    client.botTimer = setTimeout(() => {
      if (!client.offlineRoom || client.offlineRoom.status !== 'playing') return;
      const botAction = UnoEngine.computeBotAction(ms, activeP.id);
      if (!botAction) return;
      const res = UnoEngine.applyAction(ms, botAction);
      if (res.ok) {
        if (ms.status === 'finished') {
          client.offlineRoom.status = 'finished';
          ms.players.forEach((mp, idx) => {
            if (client.offlineRoom.players[idx]) client.offlineRoom.players[idx].wins = mp.wins;
          });
        }
        syncOfflineSanitizedView();
        animateConfirmedServerEvent(res.event, () => {
          renderMatchoTable();
          if (client.offlineRoom.status === 'finished') {
            showEndOverlay();
          } else {
            scheduleOfflineBotTurnIfNeeded();
          }
        });
      }
    }, 880);
  }

  // --- Opening Card Dealing Sequence ---
  function runDealingAnimationAndRender() {
    client.dealTimers.forEach(t => clearTimeout(t));
    client.dealTimers = [];
    client.selectedCardId = null;
    client.endOverlayVisible = false;
    document.getElementById('matchoEndOverlay').classList.add('hidden');
    client.dealingInProgress = true;
    showView('game');
    renderMatchoTable(true);

    const totalPlayers = client.room ? client.room.players.length : 2;
    const rounds = 5;
    let step = 0;

    for (let r = 0; r < rounds; r++) {
      for (let sIdx = 0; sIdx < totalPlayers; sIdx++) {
        const delay = step * 52;
        step++;
        const t = setTimeout(() => {
          const deckEl = document.getElementById('centerDrawDeck');
          const pos = getRelativePositionForSeat(sIdx, totalPlayers);
          const targetEl = getZoneElementForPosition(pos);
          sfx('deal');
          flyCardElement(getElementCenterRect(deckEl), getElementCenterRect(targetEl), flyCardBackHtml(), 190);
        }, delay);
        client.dealTimers.push(t);
      }
    }

    const doneTimer = setTimeout(() => {
      client.dealingInProgress = false;
      sfx('card');
      spawnDiscardImpactRing();
      renderMatchoTable(false);
      if (client.mode === 'offline') {
        scheduleOfflineBotTurnIfNeeded();
      }
    }, step * 52 + 210);
    client.dealTimers.push(doneTimer);
  }

  // --- Render ROOM Lobby ---
  function renderRoomLobby() {
    const room = client.room;
    if (!room) return;

    const countEl = document.getElementById('roomPlayerCountText');
    if (countEl) countEl.textContent = `${room.players.length} / 4`;

    const listEl = document.getElementById('roomPlayersList');
    if (listEl) {
      listEl.innerHTML = room.players.map((p, idx) => {
        const isUtya = Boolean(p.isBot && (p.name === 'Utya' || p.isUtya));
        const avatarInner = isUtya
          ? renderUtyaDuckAvatarSvg()
          : (idx === 0 ? renderUserPhotoAvatarSvg() : `<div class="w-full h-full rounded-full flex items-center justify-center font-black text-xs text-white" style="background:${escapeHtml(p.color)}">${escapeHtml(p.initials)}</div>`);

        return `
          <div class="flex items-center justify-between py-1.5 px-1">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-8 h-8 rounded-full shadow flex-shrink-0 overflow-hidden">
                ${avatarInner}
              </div>
              <div class="flex items-center gap-1.5 min-w-0">
                ${p.isBot ? '<span class="text-xs text-white/90">🤖</span>' : ''}
                <span class="text-xs font-bold text-white truncate max-w-[140px]">${escapeHtml(p.name)}</span>
                ${!p.isBot ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>' : ''}
              </div>
            </div>
          </div>
        `;
      }).join('');
    }

    const isHost = String(room.hostId) === String(myUser.id) || client.mode === 'offline';
    const actionWrap = document.getElementById('roomCenterActionWrap');
    if (actionWrap) {
      if (room.players.length < 2) {
        actionWrap.innerHTML = `
          <button id="roomWaitOrStartBtn" type="button" class="w-20 h-10 rounded-full bg-[#5b3a39] hover:bg-[#6e4645] flex items-center justify-center shadow-lg transition-all">
            <svg class="w-4 h-4 text-white/90 spin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>
            </svg>
          </button>
          <span class="text-[10px] font-extrabold tracking-widest uppercase text-slate-300 mt-1.5">WAITING</span>
        `;
        const wBtn = document.getElementById('roomWaitOrStartBtn');
        if (wBtn) {
          wBtn.addEventListener('click', () => {
            sendServerCommand({ type: 'ADD_BOT' });
          });
        }
      } else {
        actionWrap.innerHTML = `
          <button id="roomWaitOrStartBtn" type="button" class="w-20 h-10 rounded-full bg-[#7c4dff] hover:bg-[#6e3ff3] flex items-center justify-center shadow-[0_0_24px_rgba(124,77,255,0.65)] transition-transform active:scale-95">
            <svg class="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </button>
          <span class="text-[10px] font-extrabold tracking-widest uppercase text-slate-300 mt-1.5">START</span>
        `;
        const startBtn = document.getElementById('roomWaitOrStartBtn');
        if (startBtn) {
          startBtn.addEventListener('click', () => {
            if (isHost) sendServerCommand({ type: 'START_GAME' });
          });
        }
      }
    }
  }

  function renderTgChatInvitePreview() {
    const room = client.room;
    if (!room) return;
    const lines = document.getElementById('tgChatJoinedLines');
    if (lines) {
      const rem = Math.max(0, 4 - room.players.length);
      lines.innerHTML = `
        <div class="border-l-2 border-purple-300/70 pl-2.5 py-0.5 text-xs text-purple-100 bg-purple-950/40 rounded-r-lg">
          ${rem > 0 ? `⏳ ${rem} people can still join, hurry up!` : `✅ All 4 seats full!`}
        </div>
      ` + room.players.map(p => `
        <div class="border-l-2 border-purple-300/70 pl-2.5 py-0.5 text-xs text-white bg-purple-950/40 rounded-r-lg flex items-center justify-between pr-2">
          <span class="truncate">🃏 <strong>${escapeHtml(p.name)}</strong> joined.</span>
        </div>
      `).join('');
    }
  }

  // --- Render Avatar with Turn Ring & Emoji Burst ---
  function renderAvatarWithTurnRing(player, isTurn, sizePx, emojiId, isBottomSelf) {
    const svgSize = sizePx + 8;
    const r = (sizePx + 3) / 2;
    const ringSvg = isTurn ? `
      <svg class="absolute -inset-1 w-[${svgSize}px] h-[${svgSize}px] -rotate-90 pointer-events-none" viewBox="0 0 ${svgSize} ${svgSize}">
        <circle cx="${svgSize/2}" cy="${svgSize/2}" r="${r}" fill="none" stroke="rgba(168,85,247,0.3)" stroke-width="3" />
        <circle class="turn-timer-circle" cx="${svgSize/2}" cy="${svgSize/2}" r="${r}" fill="none" stroke="#a855f7" stroke-width="3" stroke-linecap="round" />
      </svg>
    ` : '';

    const emojiHtml = emojiId
      ? `<div class="absolute -inset-1 rounded-full bg-amber-400/35 backdrop-blur-sm flex items-center justify-center emoji-avatar-burst z-30">${renderAppleEmojiSvg(emojiId, 'w-8 h-8')}</div>`
      : '';

    const isUtya = Boolean(player.isBot && (player.name === 'Utya' || player.isUtya));
    let avatarContent;
    if (isUtya) {
      avatarContent = renderUtyaDuckAvatarSvg();
    } else if (isBottomSelf) {
      avatarContent = renderUserPhotoAvatarSvg();
    } else {
      avatarContent = `<div class="w-full h-full rounded-full flex items-center justify-center font-black text-xs text-white" style="background:${escapeHtml(player.color)}">${escapeHtml(player.initials)}</div>`;
    }

    const borderRingClass = isBottomSelf
      ? 'ring-2 ring-[#9b51e0]'
      : (isUtya ? 'ring-2 ring-[#38bdf8]' : 'ring-2 ring-white/25');

    return `
      <div class="relative flex items-center justify-center flex-shrink-0" style="width:${sizePx}px;height:${sizePx}px;">
        ${ringSvg}
        <div class="w-full h-full rounded-full shadow-lg relative z-10 overflow-hidden ${borderRingClass}">
          ${avatarContent}
          ${emojiHtml}
        </div>
      </div>
    `;
  }

  // Glowing Gold Crown Circle (Exact Screenshot 10-24-50 Match!)
  function renderGlowingWinnerCrownCircle(sizePx) {
    const s = sizePx || 52;
    return `
      <div class="rounded-full flex items-center justify-center flex-shrink-0" style="width:${s}px;height:${s}px;background:#d9a520;box-shadow:0 0 28px 10px rgba(217,165,32,0.45);">
        <svg class="w-6 h-6" viewBox="0 0 24 24" fill="#3a1d12">
          <path d="M4 17l-1.5-8.5 5 3.5L12 5l4.5 7 5-3.5L20 17H4zm0 2h16v1.5H4V19z"/>
        </svg>
      </div>
    `;
  }

  // --- Render Live Matcho! Table ---
  const renderMatchoTable = window.__renderMatchoTable = function(hideCardsDuringDeal) {
    const room = client.room;
    if (!room || !room.match) return;
    const match = room.match;
    const isFinished = match.status === 'finished';
    const totalP = match.players.length;
    const mySeat = typeof room.viewerSeat === 'number' ? room.viewerSeat : 0;
    const isSpectator = room.viewerRole === 'spectator';
    const isMyTurn = (!isSpectator && !isFinished && !client.dealingInProgress && match.turnIndex === mySeat);

    const frameEl = document.getElementById('appViewportFrame');
    if (frameEl) {
      if (isMyTurn) frameEl.classList.add('my-turn-vignette');
      else frameEl.classList.remove('my-turn-vignette');
    }

    const specBanner = document.getElementById('gameSpectatorBanner');
    if (specBanner) {
      if (isSpectator) specBanner.classList.remove('hidden');
      else specBanner.classList.add('hidden');
    }

    const buckets = { top: null, left: null, right: null, bottom: null };
    match.players.forEach(p => {
      const pos = getRelativePositionForSeat(p.seat, totalP);
      buckets[pos] = p;
    });

    // 1. Top Opponent Zone
    const topZone = document.getElementById('topOpponentZone');
    if (topZone) {
      const topP = buckets.top;
      if (topP) {
        const isTopWinner = (isFinished && String(match.winnerId) === String(topP.id));
        if (isTopWinner) {
          // Exact Screenshot 10-24-50 Match: When top opponent wins, top zone shows the glowing gold crown circle (or hides once overlay is up)
          if (client.endOverlayVisible) {
            topZone.innerHTML = `<div class="h-16"></div>`;
          } else {
            topZone.innerHTML = `
              <div class="pt-14 flex items-center justify-center">
                ${renderGlowingWinnerCrownCircle(52)}
              </div>
            `;
          }
        } else {
          const isTopTurn = (!isFinished && match.turnIndex === topP.seat);
          let cardsHtml = '';
          if (isFinished && topP.hand && topP.hand.length > 0) {
            cardsHtml = `
              <div class="flex items-center justify-center mt-4 mb-1 scale-75">
                ${topP.hand.slice(0, 6).map((c, i) => `<div class="-ml-4 first:ml-0 opp-revealed-card" style="animation-delay:${i*65}ms">${renderMatchoCard(c, '', '')}</div>`).join('')}
              </div>
            `;
          } else {
            const n = hideCardsDuringDeal ? 0 : Math.min(topP.cardCount, 8);
            let peeks = '';
            for (let i = 0; i < n; i++) peeks += `<div class="opp-peek-card"><div class="m-card-back-inner"></div></div>`;
            cardsHtml = `<div class="opp-top-fan-row min-h-[84px]">${peeks}</div>`;
          }

          const botIconSvg = topP.isBot ? `
            <svg class="w-4 h-4 text-white inline-block mr-1" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2a1.5 1.5 0 0 1 1.5 1.5V6h3.5A4 4 0 0 1 21 10v6a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4v-6a4 4 0 0 1 4-4h3.5V3.5A1.5 1.5 0 0 1 12 2zM8.5 11.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm7 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>
            </svg>
          ` : `<span class="w-2 h-2 rounded-full bg-emerald-400"></span>`;

          topZone.innerHTML = `
            ${cardsHtml}
            <div class="relative -mt-7 z-20 flex flex-col items-center">
              ${renderAvatarWithTurnRing(topP, isTopTurn, 48, client.activeEmojis[topP.id], false)}
              <div class="flex items-center mt-1.5">
                ${botIconSvg}
                <span class="text-sm font-bold text-white truncate max-w-[125px]">${escapeHtml(topP.name)}</span>
              </div>
              <div class="mt-0.5">${renderCardCountBadge(hideCardsDuringDeal ? 0 : topP.cardCount)}</div>
            </div>
          `;
        }
      } else {
        topZone.innerHTML = '';
      }
    }

    // 2. Side Opponents (for 3P/4P matches)
    ['left', 'right'].forEach(side => {
      const zone = document.getElementById(side + 'OpponentZone');
      if (!zone) return;
      const p = buckets[side];
      if (!p) {
        zone.innerHTML = '';
        return;
      }
      const isTurn = (!isFinished && match.turnIndex === p.seat);
      zone.innerHTML = `
        <div class="flex flex-col items-center bg-black/25 backdrop-blur-sm px-2 py-2 rounded-2xl border ${isTurn ? 'border-purple-400 shadow-[0_0_16px_rgba(168,85,247,0.5)]' : 'border-white/10'}">
          ${renderAvatarWithTurnRing(p, isTurn, 36, client.activeEmojis[p.id], false)}
          <span class="text-[10px] font-bold text-white mt-1 max-w-[64px] truncate">${escapeHtml(p.name)}</span>
          <div>${renderCardCountBadge(hideCardsDuringDeal ? 0 : p.cardCount)}</div>
        </div>
      `;
    });

    // 3. Center Direction Arrows (Hide on finished board just like Screenshot 10-24-50!)
    const topArrow = document.getElementById('topDirectionArrow');
    const botArrow = document.getElementById('bottomDirectionArrow');
    if (topArrow && botArrow) {
      const flip = match.direction === 1 ? 'scaleX(1)' : 'scaleX(-1)';
      topArrow.style.transform = flip;
      botArrow.style.transform = flip;
      topArrow.style.opacity = isFinished ? '0' : '1';
      botArrow.style.opacity = isFinished ? '0' : '1';
    }

    // 4. Center Discard Pile
    const discardStack = document.getElementById('centerDiscardStack');
    const topCard = match.discard && match.discard.length ? match.discard[match.discard.length - 1] : null;
    if (discardStack) {
      if (hideCardsDuringDeal || !match.discard) {
        discardStack.innerHTML = '';
      } else {
        const recent = match.discard.slice(-3);
        discardStack.innerHTML = recent.map((c, idx) => {
          const isTop = (idx === recent.length - 1);
          const posClass = isTop ? 'relative z-20' : 'absolute inset-0 z-10 opacity-95';
          const suitOverride = (isTop && c.color === 'wild') ? match.activeColor : '';
          // Keep top card upright during normal play or slightly fanned on finished pile
          const cardCopy = Object.assign({}, c, {
            rot: isTop ? (isFinished ? -3 : 0) : (idx === 0 ? -6 : 4)
          });
          return renderMatchoCard(cardCopy, 'm-card-table ' + posClass, suitOverride);
        }).join('');
      }
    }

    // 5. Contextual Action Pills
    const bottomP = buckets.bottom || match.players[0];
    const unoBtn = document.getElementById('callUnoActionBtn');
    const catchBtn = document.getElementById('catchUnoActionBtn');
    const passBtn = document.getElementById('passTurnActionBtn');

    if (unoBtn) {
      if (!isSpectator && !isFinished && bottomP && bottomP.cardCount <= 2 && bottomP.cardCount >= 1 && !bottomP.saidUno) {
        unoBtn.classList.remove('hidden');
      } else {
        unoBtn.classList.add('hidden');
      }
    }

    if (catchBtn) {
      if (!isSpectator && !isFinished && match.unoVulnerablePlayerId && match.unoVulnerablePlayerId !== myUser.id) {
        catchBtn.classList.remove('hidden');
      } else {
        catchBtn.classList.add('hidden');
      }
    }

    if (passBtn) {
      if (isMyTurn && match.hasDrawnThisTurn) {
        passBtn.classList.remove('hidden');
      } else {
        passBtn.classList.add('hidden');
      }
    }

    const wild4Modal = document.getElementById('wild4ChallengeModal');
    if (wild4Modal) {
      if (!isSpectator && !isFinished && match.pendingWild4 && match.pendingWild4.victimId === myUser.id) {
        wild4Modal.classList.remove('hidden');
      } else {
        wild4Modal.classList.add('hidden');
      }
    }

    // 6. Deterministic Multi-Tier Bottom Hand Layout (1 Row for <=7 Cards, Balanced 2-Tier for 8+ Cards)
    const handStrip = document.getElementById('bottomHandStrip');
    if (handStrip && bottomP) {
      if (hideCardsDuringDeal) {
        handStrip.innerHTML = '';
      } else if (isSpectator && (!bottomP.hand || bottomP.hand.length === 0)) {
        let backs = '';
        for (let i = 0; i < Math.min(bottomP.cardCount, 7); i++) {
          backs += `<div class="opp-peek-card"><div class="m-card-back-inner"></div></div>`;
        }
        handStrip.innerHTML = `<div class="hand-tier-row">${backs}</div>`;
      } else {
        const layout = computeHandLayout(bottomP.hand || []);
        handStrip.style.setProperty('--hand-card-w', layout.cardWidth + 'px');
        handStrip.style.setProperty('--hand-card-h', layout.cardHeight + 'px');
        handStrip.style.marginTop = layout.tierCount > 2 ? `-${(layout.tierCount - 2) * 32}px` : '0px';

        const activeDragCardId = (client.dragState && client.dragState.moved) ? client.dragState.cardId : null;

        const renderRowCard = (card, idx, marginLeftPx, baseZ) => {
          const zIdx = baseZ + idx;
          const mLeft = idx === 0 ? 0 : marginLeftPx;
          const isDraggingThis = (activeDragCardId === card.id);
          const placeholderClass = isDraggingThis ? ' hand-card-drag-placeholder' : '';

          if (client.newlyDrawnCardBackId === card.id) {
            return `<div class="hand-card-wrap card-selected-lifted${placeholderClass}" data-wrap-card-id="${card.id}" style="margin-left:${mLeft}px;z-index:${zIdx};"><div class="m-card-back hand-drawn-back"><div class="m-card-back-inner"></div></div></div>`;
          }
          let canPlay = isMyTurn && UnoEngine.isCardPlayable(card, topCard, match.activeColor, match.pendingWild4);
          if (canPlay && match.hasDrawnThisTurn && match.drawnCardId && card.id !== match.drawnCardId) {
            canPlay = false;
          }
          const isSelected = (client.selectedCardId === card.id);
          const flipClass = (client.flipRevealCardId === card.id) ? ' hand-card-flip-in' : '';
          const stateClass = (canPlay ? 'card-active-playable' : 'card-dimmed') + (isSelected ? ' card-selected-lifted' : '') + flipClass + placeholderClass;
          return `<div class="hand-card-wrap ${stateClass}" data-wrap-card-id="${card.id}" style="margin-left:${mLeft}px;z-index:${zIdx};">${renderMatchoCard(card, '', '')}</div>`;
        };

        const rowsHtml = layout.tiers.map((tierCards, tIdx) => {
          const metrics = layout.tierMetrics[tIdx];
          const baseZ = 10 + tIdx * 10;
          const mTopStyle = tIdx > 0 ? `style="margin-top:${layout.frontRowMarginTopPx}px;"` : '';
          const tierClass = tIdx === 0 ? 'back-tier-row' : 'front-tier-row';
          return `<div class="hand-tier-row ${tierClass}" data-tier="${tIdx}" ${mTopStyle}>${tierCards.map((c, i) => renderRowCard(c, i, metrics.marginLeftPx, baseZ)).join('')}</div>`;
        }).join('');
        handStrip.innerHTML = rowsHtml;

        // If a card is currently being dragged in #dragCardLayer, reconcile its slot reference after re-render
        // or cancel the drag if the card is no longer in the player's hand or the match ended!
        if (client.dragState) {
          const stillInHand = (bottomP.hand || []).some(c => c.id === client.dragState.cardId);
          if (!stillInHand || isFinished) {
            cancelActiveDragImmediately();
          } else {
            client.dragState.wrapEl = handStrip.querySelector(`.hand-card-wrap[data-wrap-card-id="${client.dragState.cardId}"]`);
          }
        }
      }
    }

    // 7. Purple Glow Pad Under Draw Deck (Active on normal play; hidden on finished screen like Screenshot 10-24-50!)
    const drawTrayEl = document.getElementById('drawDeckTray');
    if (drawTrayEl) {
      if (isMyTurn && !isFinished) {
        drawTrayEl.classList.add('deck-glow');
      } else {
        drawTrayEl.classList.remove('deck-glow');
      }
    }

    // 8. Bottom Player Status Bar (Hidden when YOU LOST / YOU WON overlay is visible, matching Screenshot 10-25-01!)
    const statusEl = document.getElementById('bottomPlayerStatus');
    if (statusEl && bottomP) {
      statusEl.style.opacity = (isFinished && client.endOverlayVisible) ? '0' : '1';
      if (isFinished && String(match.winnerId) === String(bottomP.id)) {
        statusEl.innerHTML = `
          ${renderGlowingWinnerCrownCircle(38)}
          <span class="text-sm font-bold text-white">${escapeHtml(bottomP.name)}</span>
          <span class="text-sm">👑</span>
        `;
      } else {
        statusEl.innerHTML = `
          ${renderAvatarWithTurnRing(bottomP, isMyTurn, 38, client.activeEmojis[bottomP.id], true)}
          <span class="text-sm font-semibold text-white truncate max-w-[110px]">${escapeHtml(bottomP.name)}</span>
          ${renderCardCountBadge(hideCardsDuringDeal ? 0 : bottomP.cardCount)}
        `;
      }
    }
  };

  function clearDragLayerDom() {
    const dragLayer = document.getElementById('dragCardLayer');
    if (dragLayer) dragLayer.innerHTML = '';
    const discardEl = document.getElementById('centerDiscardStack');
    if (discardEl) discardEl.classList.remove('discard-drop-active');
    const handStrip = document.getElementById('bottomHandStrip');
    if (handStrip) {
      handStrip.querySelectorAll('.hand-card-drag-placeholder').forEach(el => {
        el.classList.remove('hand-card-drag-placeholder');
      });
    }
  }

  function cancelActiveDragImmediately() {
    if (client.dragReturnTimer) {
      clearTimeout(client.dragReturnTimer);
      client.dragReturnTimer = null;
    }
    client.dragState = null;
    clearDragLayerDom();
  }

  // --- Clipping-Safe Floating Card-Lifting & 60FPS Pointer Drag-and-Drop Engine ---
  function setupHandDragAndLiftInteractions() {
    const handStrip = document.getElementById('bottomHandStrip');
    const frameEl = document.getElementById('appViewportFrame');
    const dragLayer = document.getElementById('dragCardLayer');
    if (!handStrip || !frameEl || !dragLayer) return;

    function getMyPlayerHand() {
      if (!client.room || !client.room.match) return [];
      const mySeat = typeof client.room.viewerSeat === 'number' ? client.room.viewerSeat : 0;
      const me = client.room.match.players && client.room.match.players[mySeat];
      return (me && me.hand) ? me.hand : [];
    }

    function attemptPlayCardFromHand(cardId, sourceRectOrEl) {
      if (!client.room || !client.room.match) return false;
      const match = client.room.match;
      const mySeat = typeof client.room.viewerSeat === 'number' ? client.room.viewerSeat : 0;
      if (client.room.viewerRole === 'spectator' || match.turnIndex !== mySeat) {
        sfx('error');
        showToast('Wait for your turn', 'error');
        return false;
      }

      const hand = getMyPlayerHand();
      const card = hand.find(c => c.id === cardId);
      if (!card) return false;

      const topCard = match.discard[match.discard.length - 1];
      let playable = UnoEngine.isCardPlayable(card, topCard, match.activeColor, match.pendingWild4);
      if (playable && match.hasDrawnThisTurn && match.drawnCardId && card.id !== match.drawnCardId) {
        playable = false;
      }

      if (!playable) {
        sfx('error');
        showToast('Card does not match color or number', 'error');
        return false;
      }

      const startRect = (sourceRectOrEl && typeof sourceRectOrEl.left === 'number')
        ? sourceRectOrEl
        : getElementCenterRect(sourceRectOrEl);

      if (card.color === 'wild') {
        client.pendingWildCardId = card.id;
        client.pendingWildRect = startRect;
        openWildDiamondPicker();
        return true;
      }

      client._lastPlayedCardRect = startRect;
      return sendServerCommand({
        type: 'PLAY_CARD',
        cardId: card.id,
        chosenColor: card.color,
        sayUno: true
      });
    }

    handStrip.addEventListener('pointerdown', (e) => {
      if (client.dealingInProgress) return;
      const wrapEl = e.target.closest('.hand-card-wrap');
      if (!wrapEl) return;
      const cardId = Number(wrapEl.getAttribute('data-wrap-card-id'));
      if (!cardId) return;

      const hand = getMyPlayerHand();
      const cardObj = hand.find(c => c.id === cardId);
      if (!cardObj) return;

      e.preventDefault();

      // Clear any previous returning proxy immediately so rapid gestures never leave stale proxies
      if (client.dragReturnTimer) {
        clearTimeout(client.dragReturnTimer);
        client.dragReturnTimer = null;
      }
      clearDragLayerDom();

      // Capture pointer on the permanent parent container `handStrip` so DOM updates inside `handStrip` never lose capture!
      try { handStrip.setPointerCapture(e.pointerId); } catch (err) {}

      const wasAlreadySelected = (client.selectedCardId === cardId);
      client.selectedCardId = cardId;

      handStrip.querySelectorAll('.hand-card-wrap').forEach(w => {
        if (Number(w.getAttribute('data-wrap-card-id')) === cardId) {
          w.classList.add('card-selected-lifted');
        } else {
          w.classList.remove('card-selected-lifted');
        }
      });

      sfx('lift');
      haptic('light');

      const frameRect = frameEl.getBoundingClientRect();
      const cardEl = wrapEl.querySelector('.m-card') || wrapEl;
      const cardRect = cardEl.getBoundingClientRect();
      const cardWidth = cardRect.width || 88;
      const cardHeight = cardRect.height || 132;

      // Clamp pointer offset inside the card bounds so the card stays naturally anchored under the finger
      const pointerOffsetX = Math.max(12, Math.min(cardWidth - 12, e.clientX - cardRect.left));
      const pointerOffsetY = Math.max(12, Math.min(cardHeight - 12, e.clientY - cardRect.top));

      client.dragState = {
        pointerId: e.pointerId,
        cardId,
        card: Object.assign({}, cardObj),
        wrapEl,
        wasAlreadySelected,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        dx: 0,
        dy: 0,
        pointerOffsetX,
        pointerOffsetY,
        originLeft: cardRect.left - frameRect.left,
        originTop: cardRect.top - frameRect.top,
        cardWidth,
        cardHeight,
        moved: false,
        proxyEl: null
      };
    });

    function onPointerMove(e) {
      const ds = client.dragState;
      if (!ds || e.pointerId !== ds.pointerId) return;

      e.preventDefault();
      const dx = e.clientX - ds.startX;
      const dy = e.clientY - ds.startY;
      ds.dx = dx;
      ds.dy = dy;
      ds.lastX = e.clientX;
      ds.lastY = e.clientY;

      if (!ds.moved && Math.hypot(dx, dy) > 6) {
        ds.moved = true;
        // Create floating drag card inside #dragCardLayer (z-index: 120, outside all overflow-hidden & tier stacking contexts)
        dragLayer.innerHTML = '';
        const proxy = document.createElement('div');
        proxy.className = 'drag-floating-card';
        proxy.setAttribute('data-drag-card-id', String(ds.cardId));
        proxy.style.width = ds.cardWidth + 'px';
        proxy.style.height = ds.cardHeight + 'px';
        proxy.innerHTML = renderMatchoCard(ds.card, '', '');
        dragLayer.appendChild(proxy);
        ds.proxyEl = proxy;

        // Hide original card slot in hand while keeping its exact layout width/margin as a placeholder
        const currentSlot = handStrip.querySelector(`.hand-card-wrap[data-wrap-card-id="${ds.cardId}"]`);
        if (currentSlot) {
          currentSlot.classList.add('hand-card-drag-placeholder');
          ds.wrapEl = currentSlot;
        }
      }

      if (ds.moved && ds.proxyEl) {
        const frameRect = frameEl.getBoundingClientRect();
        const x = (e.clientX - frameRect.left) - ds.pointerOffsetX;
        const y = (e.clientY - frameRect.top) - ds.pointerOffsetY;
        const tilt = Math.max(-15, Math.min(15, dx * 0.07)).toFixed(1);
        ds.proxyEl.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) rotate(${tilt}deg) scale(1.16)`;

        const discardEl = document.getElementById('centerDiscardStack');
        if (discardEl) {
          const pRect = ds.proxyEl.getBoundingClientRect();
          if (isDropOverDiscardTarget(e.clientX, e.clientY, pRect)) {
            discardEl.classList.add('discard-drop-active');
          } else {
            discardEl.classList.remove('discard-drop-active');
          }
        }
      }
    }

    function finishPointerGesture(e, cancelled) {
      const ds = client.dragState;
      if (!ds || e.pointerId !== ds.pointerId) return;
      client.dragState = null;

      try {
        if (handStrip.hasPointerCapture && handStrip.hasPointerCapture(e.pointerId)) {
          handStrip.releasePointerCapture(e.pointerId);
        }
      } catch (err) {}

      const discardEl = document.getElementById('centerDiscardStack');
      if (discardEl) discardEl.classList.remove('discard-drop-active');

      if (ds.moved && ds.proxyEl) {
        const proxy = ds.proxyEl;
        const pRect = proxy.getBoundingClientRect();
        const frameRect = frameEl.getBoundingClientRect();
        const releaseRectInFrame = {
          left: pRect.left - frameRect.left,
          top: pRect.top - frameRect.top,
          width: pRect.width || ds.cardWidth,
          height: pRect.height || ds.cardHeight
        };

        const droppedOnDiscard = !cancelled && isDropOverDiscardTarget(e.clientX, e.clientY, pRect);
        if (droppedOnDiscard) {
          const played = attemptPlayCardFromHand(ds.cardId, releaseRectInFrame);
          if (played) {
            // Remove floating drag proxy immediately; confirmed server event (or Wild picker) takes over!
            if (proxy.parentNode) proxy.parentNode.removeChild(proxy);
            const slotEl = handStrip.querySelector(`.hand-card-wrap[data-wrap-card-id="${ds.cardId}"]`);
            if (slotEl) slotEl.classList.remove('hand-card-drag-placeholder');
            return;
          }
        }

        // Invalid drop, out-of-target release, upward non-target gesture, or cancelled gesture:
        // Smoothly animate the floating proxy back to its exact hand slot!
        const slotEl = handStrip.querySelector(`.hand-card-wrap[data-wrap-card-id="${ds.cardId}"]`);
        let targetX = ds.originLeft;
        let targetY = ds.originTop;
        if (slotEl) {
          const sRect = slotEl.getBoundingClientRect();
          targetX = sRect.left - frameRect.left;
          targetY = (sRect.top - frameRect.top) - (client.selectedCardId === ds.cardId ? 34 : 0);
        }

        proxy.style.transition = 'transform 0.22s cubic-bezier(0.22, 1, 0.36, 1)';
        proxy.style.transform = `translate3d(${targetX.toFixed(1)}px, ${targetY.toFixed(1)}px, 0) rotate(0deg) scale(1)`;

        client.dragReturnTimer = setTimeout(() => {
          client.dragReturnTimer = null;
          if (proxy.parentNode) proxy.parentNode.removeChild(proxy);
          const currentSlot = handStrip.querySelector(`.hand-card-wrap[data-wrap-card-id="${ds.cardId}"]`);
          if (currentSlot) currentSlot.classList.remove('hand-card-drag-placeholder');
        }, 225);
        return;
      }

      // Tap gesture (did not drag > 6px):
      clearDragLayerDom();
      if (!cancelled && ds.wasAlreadySelected) {
        const slotEl = handStrip.querySelector(`.hand-card-wrap[data-wrap-card-id="${ds.cardId}"]`) || ds.wrapEl;
        attemptPlayCardFromHand(ds.cardId, slotEl);
      }
    }

    handStrip.addEventListener('pointermove', onPointerMove);
    handStrip.addEventListener('pointerup', (e) => finishPointerGesture(e, false));
    handStrip.addEventListener('pointercancel', (e) => finishPointerGesture(e, true));

    // Recalculate hand layout smoothly whenever the mobile viewport resizes
    window.addEventListener('resize', () => {
      if (client.screen === 'game' && client.room && client.room.match && !client.dealingInProgress) {
        renderMatchoTable(false);
      }
    });
  }

  // --- Wild 4-Color Diamond Picker ---
  function openWildDiamondPicker() {
    const modal = document.getElementById('wildDiamondModal');
    const quadGrid = document.getElementById('wildDiamondGrid');
    if (!modal || !quadGrid) return;

    quadGrid.classList.remove('diamond-closing');
    quadGrid.innerHTML = `
      <button type="button" data-suit="red" class="wild-quad-btn rounded-2xl bg-[#f43f3f] hover:brightness-110 transition-all duration-200"></button>
      <button type="button" data-suit="yellow" class="wild-quad-btn rounded-2xl bg-[#f7be16] hover:brightness-110 transition-all duration-200"></button>
      <button type="button" data-suit="green" class="wild-quad-btn rounded-2xl bg-[#54dc18] hover:brightness-110 transition-all duration-200"></button>
      <button type="button" data-suit="blue" class="wild-quad-btn rounded-2xl bg-[#1877f2] hover:brightness-110 transition-all duration-200"></button>
    `;
    modal.classList.remove('hidden');

    const colorMap = { red: '#f43f3f', yellow: '#f7be16', green: '#54dc18', blue: '#1877f2' };
    quadGrid.querySelectorAll('.wild-quad-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const chosen = btn.getAttribute('data-suit');
        quadGrid.querySelectorAll('.wild-quad-btn').forEach(b => {
          b.style.backgroundColor = colorMap[chosen];
        });
        sfx('wild');
        setTimeout(() => {
          quadGrid.classList.add('diamond-closing');
          setTimeout(() => {
            modal.classList.add('hidden');
            const cid = client.pendingWildCardId;
            client._lastPlayedCardRect = client.pendingWildRect;
            client.pendingWildCardId = null;
            client.pendingWildRect = null;
            if (cid !== null) {
              sendServerCommand({
                type: 'PLAY_CARD',
                cardId: cid,
                chosenColor: chosen,
                sayUno: true
              });
            }
          }, 230);
        }, 160);
      });
    });
  }

  // --- Zig-Zag Streamers & Diamond Confetti (Exact Screenshot 10-24-50 Match!) ---
  function spawnTableConfetti() {
    if (prefs.lowQualityMode) return;
    const box = document.getElementById('tableConfettiLayer');
    if (!box) return;
    let html = '';
    const spots = [
      { left: 10, top: 32, rot: -15, type: 'square' },
      { left: 32, top: 56, rot: 5, type: 'square' },
      { left: 14, top: 64, rot: 8, type: 'zigzag' },
      { left: 90, top: 48, rot: -8, type: 'zigzag' },
      { left: 74, top: 26, rot: 22, type: 'square' },
      { left: 22, top: 18, rot: -25, type: 'square' },
      { left: 82, top: 68, rot: 14, type: 'square' }
    ];
    spots.forEach((s, idx) => {
      const delay = (idx * 0.12).toFixed(2);
      if (s.type === 'zigzag') {
        html += `
          <svg class="matcho-confetti" style="left:${s.left}%;top:${s.top}%;width:14px;height:36px;animation-delay:${delay}s;" viewBox="0 0 16 40">
            <polyline points="4,2 12,8 4,14 12,20 4,26 12,32 6,38" fill="none" stroke="#e88338" stroke-width="3.5" stroke-linejoin="miter"/>
          </svg>
        `;
      } else {
        html += `
          <div class="matcho-confetti" style="left:${s.left}%;top:${s.top}%;width:10px;height:10px;background:#e88338;transform:rotate(${s.rot}deg);animation-delay:${delay}s;"></div>
        `;
      }
    });
    box.innerHTML = html;
    setTimeout(() => { box.innerHTML = ''; }, 3600);
  }

  const showEndOverlay = window.__showEndOverlay = function() {
    const room = client.room;
    if (!room || !room.match) return;
    const didIWin = String(room.match.winnerId) === String(myUser.id);
    if (didIWin) {
      sfx('win');
      haptic('success');
    } else {
      sfx('lose');
      haptic('error');
    }

    // Stage 1 (Screenshot 10-24-50): Show Crown in winner's seat & falling zig-zag streamers over the live table!
    client.endOverlayVisible = false;
    renderMatchoTable();
    spawnTableConfetti();

    // Stage 2 (Screenshot 10-24-59 & 10-25-01): Fade in YOU LOST / YOU WON overlay over the table after 950ms!
    setTimeout(() => {
      client.endOverlayVisible = true;
      renderMatchoTable();
      const overlay = document.getElementById('matchoEndOverlay');
      if (overlay) {
        overlay.classList.remove('hidden');
        overlay.classList.add('end-overlay-enter');
      }
      renderEndStandings();
    }, 950);
  }

  function renderEndStandings() {
    const room = client.room;
    if (!room || !room.match) return;
    const winnerId = room.match.winnerId;
    const didIWin = String(winnerId) === String(myUser.id);

    const crownEl = document.getElementById('endCrownIcon');
    const titleEl = document.getElementById('endTitleText');
    if (crownEl) {
      if (didIWin) crownEl.classList.remove('hidden');
      else crownEl.classList.add('hidden');
    }
    if (titleEl) {
      titleEl.textContent = didIWin ? 'YOU WON' : 'YOU LOST';
    }

    const sortedPlayers = room.players.slice().sort((a, b) => {
      if (String(a.id) === String(winnerId)) return -1;
      if (String(b.id) === String(winnerId)) return 1;
      return b.wins - a.wins;
    });

    const rowsEl = document.getElementById('endStandingsRows');
    if (rowsEl) {
      rowsEl.innerHTML = sortedPlayers.map(p => {
        const isWinRow = String(p.id) === String(winnerId);
        const rematchBadge = p.rematchReady
          ? `<span class="w-5 h-5 rounded-full bg-[#f97316] text-slate-950 flex items-center justify-center text-[11px] font-black shadow spin-icon" title="Clicked Rematch">🔄</span>`
          : '';
        const botSvg = p.isBot ? `
          <svg class="w-4 h-4 text-white inline-block mr-1.5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2a1.5 1.5 0 0 1 1.5 1.5V6h3.5A4 4 0 0 1 21 10v6a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4v-6a4 4 0 0 1 4-4h3.5V3.5A1.5 1.5 0 0 1 12 2zM8.5 11.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm7 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>
          </svg>
        ` : '';

        if (isWinRow) {
          return `
            <div class="flex items-center justify-between px-4 py-3 rounded-full" style="background:linear-gradient(90deg, rgba(133, 96, 22, 0.72) 0%, rgba(92, 66, 18, 0.62) 100%);">
              <div class="flex items-center gap-3.5 min-w-0">
                ${renderGlowingWinnerCrownCircle(42)}
                <div class="min-w-0 text-left">
                  <div class="flex items-center">
                    ${botSvg}
                    <span class="text-sm font-bold text-white truncate max-w-[130px]">${escapeHtml(p.name)}</span>
                  </div>
                  <div class="text-[11px] font-black tracking-wider uppercase text-[#eab308] mt-0.5">WINNER</div>
                </div>
              </div>
              <div class="flex items-center gap-2.5 pr-2">
                ${rematchBadge}
                <span class="text-sm font-black text-white">${p.wins}</span>
              </div>
            </div>
          `;
        } else {
          const isSelf = String(p.id) === String(myUser.id);
          const avatarHtml = isSelf
            ? `<div class="w-10 h-10 rounded-full overflow-hidden flex-shrink-0">${renderUserPhotoAvatarSvg()}</div>`
            : `<div class="w-10 h-10 rounded-full flex items-center justify-center text-white text-xs font-black flex-shrink-0" style="background:${escapeHtml(p.color)}">${escapeHtml(p.initials)}</div>`;

          return `
            <div class="flex items-center justify-between px-4 py-3 rounded-full" style="background:rgba(38, 27, 54, 0.72);">
              <div class="flex items-center gap-3.5 min-w-0">
                ${avatarHtml}
                <div class="min-w-0 text-left">
                  <div class="flex items-center">
                    ${botSvg}
                    <span class="text-sm font-semibold text-white truncate max-w-[130px]">${escapeHtml(p.name)}</span>
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-2.5 pr-2">
                ${rematchBadge}
                <span class="text-sm font-medium text-slate-300">${p.wins}</span>
              </div>
            </div>
          `;
        }
      }).join('');
    }

    const myPlayer = room.players.find(p => String(p.id) === String(myUser.id));
    const btnWrap = document.getElementById('endRematchBtnWrap');
    if (btnWrap) {
      const remClicked = myPlayer && myPlayer.rematchReady;
      btnWrap.innerHTML = `
        <div class="flex flex-col items-center">
          <button id="endInviteFriendsBtn" type="button" class="w-24 h-11 rounded-full bg-[#8b5cf6] hover:bg-[#7c3aed] flex items-center justify-center shadow-lg transition-transform active:scale-95">
            <svg class="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
            </svg>
          </button>
          <span class="text-[10px] font-extrabold tracking-wider uppercase text-slate-300 mt-2 text-center leading-tight">INVITE<br/>FRIENDS</span>
        </div>

        <div class="flex flex-col items-center">
          <button id="endClickRematchBtn" type="button" class="w-24 h-11 rounded-full ${remClicked ? 'bg-[#5b3a39]' : 'bg-[#e88338] hover:bg-[#d67228]'} flex items-center justify-center shadow-lg transition-transform active:scale-95">
            <svg class="w-5 h-5 text-white ${remClicked ? 'spin-icon' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>
            </svg>
          </button>
          <span class="text-[10px] font-extrabold tracking-wider uppercase text-slate-300 mt-2">${remClicked ? 'WAITING...' : 'REMATCH'}</span>
        </div>
      `;

      const invBtn = document.getElementById('endInviteFriendsBtn');
      if (invBtn) {
        invBtn.addEventListener('click', () => {
          shareOrCopyRoomLink();
          document.getElementById('matchoEndOverlay').classList.add('hidden');
          showView('room');
          renderRoomLobby();
        });
      }

      const rmBtn = document.getElementById('endClickRematchBtn');
      if (rmBtn) {
        rmBtn.addEventListener('click', () => {
          sendServerCommand({ type: 'REQUEST_REMATCH' });
        });
      }
    }

    const isHost = String(room.hostId) === String(myUser.id);
    const readyCount = room.players.filter(p => p.rematchReady).length;
    const forceWrap = document.getElementById('hostForceRematchWrap');
    const forceBtn = document.getElementById('hostForceStartRematchBtn');
    if (forceWrap && forceBtn) {
      if (isHost && readyCount < room.players.length && readyCount > 0) {
        forceWrap.classList.remove('hidden');
        forceBtn.textContent = `⚡ Force Start Rematch (${readyCount}/${room.players.length} Ready)`;
      } else {
        forceWrap.classList.add('hidden');
      }
    }
  }

  function shareOrCopyRoomLink() {
    const roomId = client.roomId || 'uno_room';
    const shareUrl = `${window.location.origin}${window.location.pathname}?startapp=room_${roomId}`;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(shareUrl).catch(() => {});
      } else {
        const ta = document.createElement('textarea');
        ta.value = shareUrl;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
    } catch (e) {}
    showToast('Room invite link copied!', 'success');
  }

  function syncSettingsSwitchesUI() {
    const setSwitch = (id, isOn) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.className = 'settings-switch ' + (isOn ? 'switch-on' : 'switch-off');
    };
    setSwitch('soundToggleTopBtn', prefs.soundOn);
    setSwitch('toggleColorblindBtn', prefs.colorblindMode);
    setSwitch('toggleLowQualityBtn', prefs.lowQualityMode);

    const frame = document.getElementById('appViewportFrame');
    if (frame) {
      if (prefs.lowQualityMode) frame.classList.add('low-quality-mode');
      else frame.classList.remove('low-quality-mode');
    }
  }

  // Expose helper on window for automated visual inspection & testing
  window.__matchoDebug = {
    openSettings: openSettingsModal,
    closeSettings: closeSettingsModal,
    showView,
    getClient: () => client,
    renderTable: renderMatchoTable,
    renderRoom: renderRoomLobby,
    showEndOverlay
  };

  function init() {
    loadPrefs();
    syncSettingsSwitchesUI();
    setupHandDragAndLiftInteractions();

    const emojiGrid = document.getElementById('appleEmojiGrid');
    if (emojiGrid) {
      emojiGrid.innerHTML = APPLE_EMOJIS.map(em => `
        <button type="button" data-emoji-id="${em.id}" class="emoji-pick-item hover:scale-125 active:scale-95 transition-transform p-1" aria-label="${em.label}">
          ${renderAppleEmojiSvg(em.id, 'w-10 h-10')}
        </button>
      `).join('');

      emojiGrid.querySelectorAll('.emoji-pick-item').forEach(btn => {
        btn.addEventListener('click', () => {
          const eid = btn.getAttribute('data-emoji-id');
          document.getElementById('emojiPopupCard').classList.add('hidden');
          sendServerCommand({ type: 'EMOJI', emoji: eid });
        });
      });
    }

    if (IS_DEV_MODE) {
      const devBar = document.getElementById('devOnlyToolbar');
      if (devBar) devBar.classList.remove('hidden');

      (document.getElementById('devChatViewBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
        renderTgChatInvitePreview();
        showView('tgchat');
      });
      (document.getElementById('devRoomViewBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
        showView('room');
        renderRoomLobby();
      });
      (document.getElementById('devTableViewBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
        sendServerCommand({ type: 'START_GAME' });
      });
      (document.getElementById('devSettingsBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
        openSettingsModal();
      });
      (document.getElementById('devWinBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
        if (client.mode !== 'offline') startOfflinePracticeMode(true);
        client.offlineRoom.status = 'finished';
        client.offlineRoom.rawMatchState.status = 'finished';
        client.offlineRoom.rawMatchState.winnerId = myUser.id;
        client.offlineRoom.rawMatchState.players[0].hand = [];
        syncOfflineSanitizedView();
        showEndOverlay();
      });
      (document.getElementById('devLoseBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
        if (client.mode !== 'offline') startOfflinePracticeMode(true);
        client.offlineRoom.status = 'finished';
        client.offlineRoom.rawMatchState.status = 'finished';
        client.offlineRoom.rawMatchState.winnerId = client.offlineRoom.players[1].id;
        client.offlineRoom.rawMatchState.players[1].hand = [];
        syncOfflineSanitizedView();
        showEndOverlay();
      });
    }

    (document.getElementById('closeSettingsModalBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      closeSettingsModal();
    });

    (document.getElementById('soundToggleTopBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      prefs.soundOn = !prefs.soundOn;
      savePrefs();
      syncSettingsSwitchesUI();
      if (prefs.soundOn) sfx('lift');
    });
    (document.getElementById('toggleColorblindBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      prefs.colorblindMode = !prefs.colorblindMode;
      savePrefs();
      syncSettingsSwitchesUI();
      sfx('lift');
      if (client.room && client.room.match) renderMatchoTable();
    });
    (document.getElementById('toggleLowQualityBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      prefs.lowQualityMode = !prefs.lowQualityMode;
      savePrefs();
      syncSettingsSwitchesUI();
      sfx('lift');
    });

    (document.getElementById('tgChatBackToRoomBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      showView('room');
      renderRoomLobby();
    });
    (document.getElementById('tgChatJoinGameBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      showView('room');
      renderRoomLobby();
    });
    (document.getElementById('tgChatSpectateBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      if (client.room) client.room.viewerRole = 'spectator';
      showView('game');
      renderMatchoTable();
    });
    (document.getElementById('expandMiniAppSheetBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      showView('room');
      renderRoomLobby();
    });
    (document.getElementById('tgInlineResultPopup') || {addEventListener:function(){}}).addEventListener('click', () => {
      sendServerCommand({ type: 'ADD_BOT' });
      renderTgChatInvitePreview();
    });
    (document.getElementById('copyRoomInviteBtn') || {addEventListener:function(){}}).addEventListener('click', shareOrCopyRoomLink);

    (document.getElementById('roomShareInviteBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      shareOrCopyRoomLink();
    });
    (document.getElementById('roomAddAiBotBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      sendServerCommand({ type: 'ADD_BOT' });
    });

    (document.getElementById('centerDrawDeck') || {addEventListener:function(){}}).addEventListener('click', () => {
      sendServerCommand({ type: 'DRAW_CARD' });
    });

    (document.getElementById('callUnoActionBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      sendServerCommand({ type: 'CALL_UNO' });
    });
    (document.getElementById('catchUnoActionBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      sendServerCommand({ type: 'CATCH_UNO' });
    });
    (document.getElementById('passTurnActionBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      sendServerCommand({ type: 'PASS_TURN' });
    });

    (document.getElementById('acceptWild4Btn') || {addEventListener:function(){}}).addEventListener('click', () => {
      document.getElementById('wild4ChallengeModal').classList.add('hidden');
      sendServerCommand({ type: 'ACCEPT_WILD4' });
    });
    (document.getElementById('challengeWild4Btn') || {addEventListener:function(){}}).addEventListener('click', () => {
      document.getElementById('wild4ChallengeModal').classList.add('hidden');
      sendServerCommand({ type: 'CHALLENGE_WILD4' });
    });

    (document.getElementById('openEmojiPopupBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      document.getElementById('emojiPopupCard').classList.toggle('hidden');
    });
    (document.getElementById('closeEmojiPopupBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      document.getElementById('emojiPopupCard').classList.add('hidden');
    });

    (document.getElementById('hostForceStartRematchBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      sendServerCommand({ type: 'FORCE_REMATCH' });
    });

    (document.getElementById('retryConnectNowBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      connectToMultiplayerServer(client.roomId, client.room ? client.room.viewerRole : 'player');
    });
    (document.getElementById('switchOfflinePracticeBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      startOfflinePracticeMode(true);
    });

    (document.getElementById('authRetryTelegramBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      hideAuthRecoveryModal();
      client._retriedFreshInitData = false;
      connectToMultiplayerServer(client.roomId, 'player');
    });

    (document.getElementById('authPlayPracticeBtn') || {addEventListener:function(){}}).addEventListener('click', () => {
      hideAuthRecoveryModal();
      if (client.ws) {
        try { client.ws.close(); } catch (e) {}
      }
      startOfflinePracticeMode(false);
    });

    startAppWithIntro();
  }

  init();
})();
