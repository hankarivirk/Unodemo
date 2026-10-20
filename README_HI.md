# PlayLo — Hinglish Setup

Ye ek independent PlayLo card game project hai. Isme Telegram Mini App UI, room-based Socket.IO multiplayer, CPU players, wild colors, card play/draw, reactions, rematch aur Telegram bot shamil hain. Original server code ZIP mein nahi tha, isliye is project mein naya rules engine/server banaya gaya hai; original game ke har private mode ki exact copy hone ka daawa nahi hai.

## Pehle local test karo

1. Node.js 20+ install karo.
2. Project folder mein `npm install` chalao.
3. `.env.example` ko `.env` naam se copy karo.
4. Local browser testing ke liye `DEV_ALLOW_GUESTS=true` rehne do.
5. `npm test` chalao, phir `npm start`.
6. Browser mein `http://localhost:3000` kholo. Do alag browser sessions se room create/join karke play test kar sakte ho.

## Telegram bot enable karne ke liye

- BotFather se apna bot banao aur `.env` mein `BOT_TOKEN` aur `BOT_USERNAME` set karo. Token kisi ko share mat karna.
- Server ko public HTTPS domain par deploy karo aur `PUBLIC_URL` set karo.
- Production mein `NODE_ENV=production` aur `DEV_ALLOW_GUESTS=false` rakho.
- BotFather mein Mini App/domain configure karo.
- `npm start` aur `npm run bot` alag terminal/process mein run karo.

Room invitation bot deep link se khulta hai, aur bot ek game button bhejta hai jisme room code hota hai. Telegram login tabhi kaam karega jab app Telegram ke andar web-app button se khula ho aur server `initData` validate kar paaye. Sirf local browser test hona live Telegram deployment ka proof nahi hai.

## Dhyan rahe

- Abhi lobby/game rooms memory mein hain; server restart par current matches clear honge.
- Original Matcho backend unavailable tha. Yeh fully independent replacement prototype hai, same-source clone nahi.
- `.env` aur bot token private rakho.
