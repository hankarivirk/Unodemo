# Deep Audit: `Matcho_Research_Latest.zip`

Audit date: 2026-10-20  
Scope: static inspection of the uploaded ZIP only; no access to the original server or bot backend.

## Executive summary

The uploaded archive is valid and useful as a reverse-engineering/research reference. It contains a compiled frontend bundle, a game/rendering chunk, a broad set of visual/audio assets, and search/audit reports. It is **not** a complete editable project or a deployable copy of the original game: no server implementation, bot handler, package manifest/lockfile, source maps, or environment configuration were found.

A feature-equivalent game can be implemented now with an independently written game engine and backend. Exact behaviour parity with the original cannot be guaranteed until unknown server-side rules/invite handling can be observed from authorized sources or gameplay tests.

## Archive integrity and deduplication

- ZIP compressed size: about 7.4 MiB.
- Uncompressed file data: 10,017,534 bytes (~9.55 MiB).
- File entries: 399 files (plus directory entries); ZIP integrity test passed.
- Distinct content hashes among files: 193.
- Duplicate copies account for about 5.08 MB of the uncompressed data.
- The root `main.js` and `full-site-audit/downloaded/assets/index-DdAg6HvH.js` are byte-identical (659,415 bytes).
- `MatchoRoute-Ce7YXFNb.js` is byte-identical across `chunks/`, `site-scan/chunks/`, and `full-site-audit/downloaded/assets/`.
- Several audio and visual collections are duplicated under different paths.

Recommended cleanup: make one canonical copy of each asset/bundle, keep the audit reports, and record a SHA-256 manifest.

## What is present

### Compiled client

- Main JS bundle: 659,415 bytes; it is minified/compiled code, not original source files.
- Matcho game-route chunk: 149,104 bytes.
- Additional rendering/library chunks, CSS, entry HTML, web manifest, two fonts, and site icon/banner files.
- Main app uses a React-based UI around a PixiJS-rendered table/card surface and includes animation/audio logic.

### Visual assets

The expanded visual package contains 36 image/atlas/metadata files, plus 7 extra branding/font/banner files. Core examples:

- Normal card spritesheets at 1302×1216 and 2582×2412.
- Colorblind card spritesheets at the same two resolutions.
- Two card-back/deck sheets at 262×176 and 518×348.
- Atlas JSON: 63 card frames for the regular sheet; 64 frames for colorblind sheets (including an additional card-back frame); 2 deck frames (`default`, `halloween`).
- UI backgrounds, card shadows, direction arrows, player/turn/skip highlights, winner glow, reaction sheet, fonts and banner.

The atlas frame names such as `red_7.png` and `card_overlay.png` are **frames inside packed spritesheets**, not necessarily separate PNG files. The asset JSON and its image can be stored in sibling folders; the image reference is not missing merely because it is not in the JSON's directory.

### Audio

- All 86 hashed MP3/OGG filenames referenced in the game route were found in `audio-downloads/`.
- Many audio files appear again in `site-scan/downloads/assets/audio/`, causing duplication.
- The scanner reports failures for guessed unhashed aliases like `audio/card_play_0.wav`; the embedded asset manifest uses aliases while actual source files are hashed MP3/OGG variants. Those failures should not be treated as 135 confirmed missing files.

## Client protocol clues observed

### Socket.IO connection

The game-route chunk initializes Socket.IO using path `/socket.io` and query keys `initData` and `platform` taken from `window.Telegram.WebApp` when available. The client code doesn't specify a server URL in that call; the bundled Socket.IO resolver defaults to the current origin. This describes frontend URL resolution only; it does not prove server infrastructure/configuration.

The UI initialization calls a game class with `new cn(canvasApp, "/api", settings)`, but the constructor body examined doesn't use the middle `/api` argument. Therefore, `/api` is **not confirmed** as an API endpoint.

### Client-to-server events found (10)

`statusUpdate`, `getGameState`, `drawCard`, `requestHand`, `playCard`, `wildColor`, `requestRematch`, `requestStart`, `addBot`, `reactionUpdate`.

Observed payload patterns: `playCard` sends a card ID; `wildColor` sends a color; `reactionUpdate` sends an emoji; `getGameState` is also invoked with a boolean flag for game/rematch refresh; several other events are emitted without an explicit payload in the client code.

### Server-to-client game events found (16)

`connect`, `error`, `gameState`, `cardPlayed`, `cardDrawn`, `drawCardResponse`, `colorPicked`, `turnStart`, `reloadState`, `startRematch`, `startGame`, `rematchVote`, `handResponse`, `playerJoined`, `playerStatus`, `playerReaction`, `disconnect`.

The client code uses phases named `waiting`, `playing`, `wild`, and `finished`. Its state handling references player indexes/hand sizes, current player, host, mode, deck size, full deck/card IDs, hand, pile, direction, allowed cards, draw stack, winner, and rematch votes. These are inferred fields from frontend handlers, not a complete validated server schema.

The client also contains mode labels/enums `Standard`, `Super`, `Classic`, and `StandardCpu`. The precise rule differences between modes are not established by the archive.

### Telegram client integration

- Reads `WebApp.initData`, platform, safe-area insets, visibility/activation events, and uses vertical-swipe toggles.
- Uses Telegram CloudStorage settings for sound, colorblind mode, and a low-resource/potato setting.
- The invite/new-game buttons call `switchInlineQuery("", ["users", "groups"])`.
- The UI links to `t.me/MatchoGame` for its follow action.

## What is missing / not confirmed

No matches/files were found for source maps (`*.map`), `package.json`, lockfiles, TypeScript/TSX source project, server source, bot handlers, Docker setup, or `.env` files.

The following original behaviours are **not recoverable from the client bundle alone**:

1. Exact room creation/join payload and generated invitation/deep-link format.
2. Server-side verification, room membership checks, and persistence.
3. Complete rules for each mode, especially stacking/penalty-card rules, edge cases, and victory resolution.
4. Bot AI decisions and when bots can join.
5. Rate limits, reconnect/session policy, authoritative validation, and backend deployment topology.

The archive's `manifest.json` enumerates only the primary HTML entry and a subset of the startup resources; it should not be treated as a complete manifest of every dynamically loaded sprite/audio file. Other folders in the archive contain additional runtime assets.

## Build recommendation

Do not spend more time repeatedly downloading the same hashed assets. The next useful step is an independent implementation with:

1. Authoritative server-side rules and legal-move validation.
2. Rooms/codes/invite links, lobby/host controls, bot players, reconnect, reactions and rematch.
3. Telegram Mini App initialization with **server-side validation of raw `initData`**; never trust `initDataUnsafe` as authentication.
4. Responsive mobile UI and an original or properly licensed visual style. Use the archived bundle as a behavioural reference rather than copying compiled source or protected artwork verbatim.
5. Automated game-rule tests, multiplayer smoke tests and a deployable ZIP with `.env.example` and setup instructions.

## Reference documentation

- Telegram Mini Apps and `initData` validation: https://core.telegram.org/bots/webapps
- Telegram deep links: https://core.telegram.org/api/links
- Socket.IO rooms: https://socket.io/docs/v4/rooms/

## Bottom line

**Enough to begin building a playable feature-equivalent game now. Not enough to claim an exact original-server clone.** The biggest missing research item is backend/invite semantics, not the frontend assets.
