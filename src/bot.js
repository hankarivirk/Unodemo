import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOT_USERNAME = (process.env.BOT_USERNAME || '').replace(/^@/, '').trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN. Copy .env.example to .env and add the token from BotFather.');
  process.exit(1);
}
if (!PUBLIC_URL || !/^https:\/\//i.test(PUBLIC_URL)) {
  console.error('PUBLIC_URL must be your deployed HTTPS Mini App URL before starting the Telegram bot.');
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

function miniAppUrl(roomCode = '') {
  const url = new URL('/', PUBLIC_URL);
  if (roomCode) url.searchParams.set('room', roomCode);
  return url.toString();
}

function launchKeyboard(roomCode = '') {
  return new InlineKeyboard().webApp('🎮 Open PlayLo', miniAppUrl(roomCode));
}

bot.command('start', async (ctx) => {
  const raw = String(ctx.match || '').trim();
  const invite = raw.match(/^join_([A-Z0-9]{4,8})$/i);
  const roomCode = invite ? invite[1].toUpperCase() : '';
  const message = roomCode
    ? `You've been invited to PlayLo room ${roomCode}. Open the game below, then join the room.`
    : 'Welcome to PlayLo! Create a room, invite friends, or add CPU players to start a match.';
  await ctx.reply(message, { reply_markup: launchKeyboard(roomCode) });
});

bot.command(['play', 'game'], async (ctx) => {
  await ctx.reply('Ready to play? Open PlayLo below.', { reply_markup: launchKeyboard() });
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    'PlayLo commands:\n/start — open the game or accept a room invite\n/play — open the game\n/help — show this message\n\nCreate a room, copy its invite link, and share it with friends. The room host can add CPU players and start the match.',
    { reply_markup: launchKeyboard() },
  );
});

bot.catch((error) => {
  console.error('Telegram bot update failed:', error.message || error);
});

const commands = [
  { command: 'start', description: 'Open game or join an invite' },
  { command: 'play', description: 'Open PlayLo' },
  { command: 'help', description: 'How to play and invite friends' },
];

try {
  await bot.api.setMyCommands(commands);
  await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Play', web_app: { url: miniAppUrl() } } });
} catch (error) {
  console.warn('Could not configure all bot shortcuts automatically:', error.message || error);
}

console.log(`Starting @${BOT_USERNAME || 'your-bot'} polling bot...`);
await bot.start({ onStart: (info) => console.log(`Bot @${info.username} is online.`) });
