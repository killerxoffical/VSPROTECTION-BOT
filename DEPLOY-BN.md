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

## I. Admin Panel (panel.html) — sobar group alada

`panel.html` e splash + Google/Email login + dashboard. Prottek user shudhu **nijer claimed group** dekhbe.

### I-1. Authentication ON koro (1 bar)
1. vsprotection1 → left menu **Authentication** → **Get started** (na thakle)
2. **Sign-in method** tab:
   - **Google** → Enable → Save
   - **Email/Password** → Enable → Save
3. **Settings** tab → **Authorized domains** → panel jekhane host korbe sei domain **Add domain** (jemon `tumar-site.netlify.app`; localhost emnitei allowed)

### I-2. Rules re-publish
`firestore.rules` (notun multi-tenant version) → Firestore > Rules > paste > **Publish**.
Na korle panel e shudhu login hobe, group asbe na!

### I-3. Panel host koro
`panel.html` jekono static hosting e dao ( Netlify Drop / GitHub Pages / Vercel — file ta drag-drop korlei hoy).
⚠️ `file://` diye khulle Google login fail korbe — hosting use koro.

### I-4. Super admin email
`panel.html` er upore `SUPER_ADMIN_EMAIL = 'admin@gmail.com'` — **nijer Gmail bosao**.
Super admin: sob group + sob user + welcome + broadcast + giveaway dekhbe.
Sadharon user: shudhu nijer claimed group + settings + triggers + warns.

### I-5. Group claim flow (user der bolo)
1. Panel login → dashboard e **Claim Code** (jemon `A7K2P9`) Copy
2. Nijer group e bot ke **Admin** banao (Delete + Ban + Pin)
3. Group e likho: `/claim A7K2P9` (command e tap korle `/claim@botname CODE` hoy — ekhon tao cholbe)
4. Bot "link done" bollei panel e **🔄 Refresh Groups** chapo → group asbe ✅
5. Panel theke Remove korle bot protection choltei thakbe, shudhu panel theke jabe

## J. Fix log (2026-10-11) — "bot kaj kore na / code e add hoy na" fix
1. **/claim kokhono cholto na:** `if (isAdmin) return;` chilo filter er age, ar /claim-/scammer chilo filter er pore → admin kokhono command porjonto pouchato na. Ekhon /claim + /scammer + tracker **admin-return er age** — fixed.
2. **/claim@botname fail:** Telegram tap korle `/claim@Vareonprotection_bot CODE` hoy, purono parse `BOTNAME+CODE` banato → "ভুল CODE". Ekhon regex parse — fixed.
3. **Bhule delete:** `ib` diye vibe/job, `mc/bc` diye comcast/welcome delete hoto. Ekhon word-boundary (`\b`) — fixed.
4. **Bot jibito kina bujha jeto na:** ekhon group e add/Admin হলেই greeting + Group ID, `/id` + `/start` e reply, Render log e `@username` + polling 409 warning.
5. **Anti-link default:** age default whitelist e `ppmod` chilo → ekhon khali = sob link block (nijer ta whitelist e likho).
6. **Panel:** UID copy + 🔄 Refresh + Bot API URL sobar jonno + Welcome/Trigger Test button + Timestamp sort fix + duplicate apiBase ID fix.
7. **Redeploy:** ei fix er por GitHub push → Render auto-redeploy → Logs e `[VS] Bot connected as @...` ashle group e `/id` likhe test koro.

## K. v3.0 Executive Console — full customization (2026-10-11)
- **Panel ekhon sidebar console** (screenshot style): Dashboard / My Groups / Members / Scammers / Welcome / Giveaway / Send Message / Broadcast / Help.
- **Dashboard:** stat cards (Groups, Members, Warns, Scammers) + Group Activity chart (members vs warns) + Claim Code / Claim Command alada card.
- **Group e tap → full admin panel:** filters, delete-timing (filter/warn sec), flood (on/limit/window/mute/msg), gali (limit/action/msg), custom warning texts (link/forward/video/inbox), per-group Welcome (global/custom/off + photo + delete-sec), Scammer alert (on/off + custom {name}/{id}, khali = Bangla+English default), trackers (name-change English auto + leave log), triggers + cooldown, members, warns (clear), Save All.
- **Members auto-collect:** bot group e je likhe/join kore tar ID `tg_members` e jome — Send box diye bot oi group e take mention-msg dite pare.
- **Notun bot API:** `POST /api/tg/send-message` {chatId, text, userId?}, `POST /api/tg/clear-warn` {chatId, userId}.
- **IMPORTANT:** `firestore.rules` e `tg_members` block notun — Rules **re-publish** na korle Members/Send kaj korbe na!
- Backward compatible: purono group e notun field na thakle default (age jemon cholto temon) cholbe.
