# VS Protection Bot — Deploy Guide (alous service)

`vs-protection-bot/` folder e shudhu protection bot — PP MOD er kichu nei.
Database: **vsprotection1** (Firestore). Service: alada Render web service.

## A. Telegram e bot banao (2 min)

1. Telegram e **@BotFather** khulun → `/newbot` → name din (jemon `VS Protection`) → username din (jemon `Vareonprotection_bot`)
2. BotFather je **token** dibe (`123456:ABC...`) — oita copy kore rakhun, kauke diben na

## B. vsprotection1 Firestore ready (3 min)

1. **console.firebase.google.com** → project **vsprotection1** → left e **Firestore Database** → **Create database** → location (asia-south1) → **Start in production mode**
2. Uporer **Rules** tab → `firestore.rules` file er puro text paste → **Publish**

## C. Service account key (2 min)

1. vsprotection1 → ⚙️ **Project settings** → **Service accounts** tab → **Generate new private key** → JSON download
2. JSON file ta Notepad e khulun → **puro text ek line** korun (Notepad++ na thakle jemon ache temoni rakhun, Render multiline value ney)

## D. Render e deploy (5 min)

1. **dashboard.render.com** → **New +** → **Web Service** → ei `vs-protection-bot` folder er code GitHub repo te push kore connect korun (PRIVATE repo valo)
   - Build Command: `npm install`
   - Start Command: `node worker.js`
2. **Environment** te 2 ta variable:
   - `GROUP_PROTECT_BOT_TOKEN` = BotFather er token
   - `FIREBASE_SERVICE_ACCOUNT` = C-step er JSON (purota)
3. **Deploy** → Logs e `[VS] Protection Bot active` ashle done ✅
4. ⚠️ **1 tai instance**: Settings > **Instances = 1** (Free plan e emnitei 1). 2 ta cholle Telegram update vag hoye jabe!

## E. Group/Channel e lagao

1. Nijer group e bot ke **add** korun → **Admin** banan (✅ Delete messages, ✅ Ban users, ✅ Pin messages — ei 3 ta permission lagbei)
2. Admin banano matroi bot group ke **auto-register** korbe (Firestore `tg_groups` e asbe) + protection ON:
   - anti-link, anti-forward, anti-video, anti-inbox, flood control, gali warn/ban, welcome, scammer check
3. Test: onno id diye link pathan → bot delete korbe + warn dibe ✅

## F. Onnoder group e dewa (tader channel/group chalano)

1. Tader shudhu bot er username din — tara nijeder group e add + Admin banabe
2. Tader group auto-register hoye jabe, default protection pabe
3. Per-group setting (kon filter on/off, warn limit, trigger reply, welcome text): Firestore `tg_groups/{groupId}` doc edit korle **live** apply hoy (server restart lage na):
   - `antiLink/antiVideo/antiForward/antiInbox`: true/false
   - `linkWhitelist`: ["nijer-channel", ...] (na dile default)
   - `allowChannels`: ["channel-username", ...] (forward allow)
   - `warnLimit`: 5, `warnAction`: "ban"/"mute"/"warn", `warnMsg`: "..."
   - `triggers`: [{keyword, reply, buttons:[{text,url}]}]
   - `msgs`: {forward, video, inbox, link} (custom warn text)
4. Global welcome: `tg_config/welcome` doc → `welcomeMsg` ({name} cholbe), `welcomeImg`, `joinLinks: [{text,url}]`, `welcomeOn: false` (bondho)

## G. Panel API (chaile pore)

- `POST /api/tg/group-broadcast` {text, photoUrl?, chatId?}
- `POST /api/tg/test-welcome` {chatId}
- `POST /api/tg/test-trigger` {chatId, keyword}
- `POST /api/tg/create-giveaway` {chatId, title, itemName, amount?, winnersCount?}
- `POST /api/tg/end-giveaway` {giveawayId}
- `POST /api/tg/moderate-user` {action: ban|unban|mute, chatId, userId}
- Group command (group er admin): `/scammer` / `/unscammer` (reply diye), `!text` (admin notice + pin)

## H. Mone rakha

- PP MOD er `worker.js`/database er sathe er **kono somporko nei** — alada deploy, alada bill, alada restart
- Token kokhono GitHub public repo / screenshot e diben na
- Free Render ghoome gele prothom message e 30-50s lagte pare (normal)
