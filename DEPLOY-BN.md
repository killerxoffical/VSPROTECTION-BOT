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

## L. v4.0 Developer Portal — My Applications + multi-bot (2026-10-11)
- **Login er por Dashboard = My Applications** (image er moto cards): Shared Bot + nijer connected bots + sobar pase **+ card**.
- **+ tap → popup:** login email (auto) + bot display name + BotFather token → **Verify & Connect** (`POST /api/tg/verify-bot` check kore, `vs_bots` e save). Worker live pickup kore polling start kore.
- **Bot e tap → oi bot er groups.** Group e tap → **fullscreen premium panel**: bam pashe feature rail (Filters/Flood/Gali/Messages/Welcome/Scammer/Trackers/Triggers/Members/Warns/Send/Manage), majhkhane selected feature — sob customize ager motoi.
- **Nijer bot = claim lage na:** bot ke group e add + Admin banalei group auto-link hoye oi bot er niche asbe. Shared bot e ager claim system thakbei.
- **API te botId:** test/welcome/trigger/send/moderate/broadcast ekhon sothik bot diye pathay.
- **IMPORTANT (2 ta):**
  1. `firestore.rules` e **`vs_bots`** block notun — re-publish must!
  2. User bot er token server e polling chalabe — Render **1 instance** rakho; token revoke hole panel theke bot delete + reconnect.
- ⚠️ Token Firestore e owner-only readable — repo/hosting e token post koro na.

## M. v4.1 Light console + 1-step Server setup (2026-10-11)
- **Full light mode:** sidebar, dashboard, bot cards, group cards, fullscreen panel, popup — sob white/light.
- **Server URL jhamela sesh:**
  1. **Render dashboard** → service → URL copy (jemon `https://vs-bot.onrender.com`)
  2. Panel **Dashboard → 🔌 Step 1 box** e paste → **✅ Test & Save** → Online = done. URL phone/browser e **auto-save**, ar dite hobe na.
  3. (Optional, sobar jonno permanent) `panel.html` er upore `DEFAULT_API_BASE = 'https://...'` bosiye host korle karo kichu dite hobe na.
  4. Panel + server same domain e host hole **auto-detect** hoye jay.
- Offline thakle banner + top chip nijei bole dibe ki korte hobe. Help Center eo "Server URL kothay dibe" guide ache.

## N. Bot add hoy kintu kichu kore na? (2026-10-11)
Bot age chupchap fail korto — ekhon nijei group e bole dey. Tao na bujhle niche 5 ta check koro:

1. **Bot ke ADMIN banao + 3 permission:** group → bot er naam e tap → Promote to admin → ✅ Delete messages, ✅ Ban users, ✅ Pin messages. Permission na thakle bot ekhon group Ei likhe janiye dey ("VS Protection kaj korte parche na!").
2. **Nijer admin ID diye test koro NA:** admin der bot ichcha kore ignore kore (filter admin der dhore na). Test koro **normal member** ID diye — link/gali pathao.
3. **Group e `/id` likho:** reply asle = bot LIVE. Reply na asle bot cholchei na → Render Logs dekho:
   - `[FATAL] ... TOKEN` = token env vul; `[FATAL] FIREBASE...` = service JSON vul;
   - `[POLLING 409]` = 2 jayga theke cholche (Render + local/old deploy) — 1 ta rakho;
   - Free Render sleep = prothom reply te 30-50s lag normal.
4. **Panel button kaj na korle:** Dashboard → **🔍 Diagnostics → Run check**. Server Offline = Step 1 URL; Database "RULES publish koro" = Firestore Rules e firestore.rules paste + Publish; Groups 0 = claim/auto-link + Refresh.
5. **Vul bot test korcho na to?** Panel e + diye connect kora nijer bot add korle sudhu OI bot kaj korbe — shared bot (@Vareonprotection_bot) add korle claim CODE lage.

## O. Manual gali list + per-section Save + anti-bot/ads (2026-10-11)
- **Trigger Gap:** cooldown mane — ekoi user ekoi keyword e koto sec por por reply pabe (0 = sobsomoy). Triggers tab e label + alada Save.
- **Proti section e alada Save:** Filters / Flood / Gali / Scammer / Welcome / Triggers / Messages / Trackers — jar ta bodlabe sudhu seita Save (Save All o ache).
- **Anti-gali manual:** Gali tab e nijer word list (comma/newline) + "Default list" toggle. Toggle OFF = sudhu tomar list, auto kichu na.
- **Ad-bot block:** Filters e **Anti-Bot** (auto-join bot der message delete) + **Anti-Button** (URL-button soho ad delete + custom warn text) — ON thakle kono ad/bot-promo jabe na.

## P. Full gali list 138 + bypass-proof (2026-10-11)
- **Manual-only gali (default auto OFF):** notun group e built-in list OFF + custom খালি — Gali tab e nijer list paste + Save। Toggle ON korle built-in (185) o cholbe.

## Q. Auto 150+ Bangla/Banglish + 3-mode + group commands + premium giveaway (2026-10-11)
- **Auto list 250+ Bangla/Banglish:** haramkhor, bejonma, jaroj, beyadob, dhokabaz, bhondo, gunda, mastan, dakat, betichod, shala, abal, chor, marbo + 100 Bangla script — bypass-proof, false-positive safe (class/magic/chorus/beta-version e dhorbe na)।
- **3 mode:** ① duToi OFF = filter bondho ② Built-in ON = auto ③ Custom = manual ④ duToi eksathe — Gali tab theke।
- **Group commands (panel khola lage na):** reply diye `/ban /kick /mute /warn`, reply/ID diye `/unscammer /unban /unmute /warns` — sudhu admin।
- **Premium giveaway:** photo + description + auto-end timer (hours) + live Join count + pin + premium result — restart hole manual End।
- **Bypass trick auto-ধরা:** f.u.c.k, phuck, fuuuck, b!tch, b0k4ch0d4, মাদার*চোদ — symbol/leet/repeat normalize kore match.
- Manual mode chaile Gali tab er custom field e nijer list paste koro + Default OFF.

## R. Admin gali fun-reply + live/gali DM + group giveaway (2026-10-11)
- **Admin gali → মজার reply, NO delete/ban/warn:** Gali tab e নিজের reply text (`{name}` চলে), default funny text built-in।
- **🔴 Live → admin DM:** keu live/voice-chat শুরু করলে group e কিছু post হয় না — notify admin দের bot DM দেয় (কে live করছে + group)।
- **🚨 Gali → admin DM:** ke gali dilo full detail (নাম/ID/group/লেখা/warn/action) admin DM এ।
- **Admin ID:** command chalano admin auto-jome (Trackers tab e দেখা/edit করা যায়)। DM পেতে admin কে bot e **/start** দিতে হবে।
- **🎉 Giveaway সবার জন্য:** top nav + group panel-এ Giveaway tab (photo/desc/auto-timer সহ) — super-only না।

## S. Giveaway always-visible + earning ways (2026-10-11)
- **Miss হবে না:** post auto-pin + প্রতি ঘণ্টায় live count/countdown refresh + silent re-pin (notification ছাড়া pin-bar এর উপরে)। Panel থেকে যেকোনো সময় **📌 Re-pin**। Join বাটনে live count।
- **Earning:** ① Telegram Ads revenue (শুধু 1000+ subs public channel, Fragment/TON payout — group e দেয় না) ② নিজের sponsor deal (welcome/result এ sponsor line — চাইলে setting বানিয়ে দেব) ③ paid private group/invite। Bot অন্যের group e ad দিতে পারে না + spam করলে Telegram ban করে।

## T. Giveaway bump — post sobsomoy niche + earning FAQ (2026-10-11)
- **Bump hours:** purono post delete + fresh post + pin (duplicate হয় না) — channel/group e jotoi message choluk giveaway nichei thake। Default 6h, 0 = off। Hourly loop + restart catch-up + manual 📌 Re-pin।
- **Earning FAQ:** group e Telegram ad revenue nei (শুধু 1000+ subs channel)। Sponsor line/auto-DM blast চাইলে বলো — setting বানিয়ে দেব। Bot spam-ad দিলে Telegram ban — tai anti-ads default ON রাখো।

## U. Fake staff-title decline (2026-10-11)
- Name/username e owner-admin-moderator-founder-ceo-support-official-staff-manager (default) + custom titles — kintu real admin na → offender message **THAKE** (delete হয় না) + warn নিচে reply thread-এ disclaimer হিসেবে আসে।
- Decline text customizable `{name} {title} {id}` সহ (username/URL বসানো যায়) + notice delete-sec (0 = notice thakbe)। Real admin/channel exempt।
- Fake-title decline ও **admin DM + gali log**-এ যায় (ke ki bollo)। Delete চাইলে শুধু "Offender message o delete" toggle ON করো।

## V. In-bot setup wizard — /panel menu bot-er vitor (2026-10-11)
- **Link (kon bot-er admin bojhar jonno):** Panel → 🔗 Telegram Link → New Code → bot ke DM e `/link CODE` (one-time) → `/panel`। Panel e status + Unlink।
- **`/panel` (DM):** groups list → group tap → full menu: 🛡️ Filters toggle, ⏱️ Timers (number), 💬 Replies (text), 🎉 Welcome (mode/text/sec), ⚡ Add reply wizard (keyword → reply → delete-sec, 0 = thakbe), 🗑 Triggers delete, 📊 Info। Trigger reply te deleteSec auto-delete।
- Commands: `/link /unlink /cancel /panel` (DM only)। Button press owner-check সহ।

## W. Gali delete fix + admin DM + panel gali log (2026-10-11)
- **Root cause:** default list OFF + custom খালি ছিল, তাই কিছুই ধরতো না। Ekhon built-in auto list **default ON** (notun group + toggle) — gali দিলেই **delete + warn** হবে।
- **Admin DM:** gali + full detail (নাম/ID/group/লেখা/warn) bot DM করে। শর্ত: Trackers tab e admin ID + admin bot e **/start** দেওয়া।
- **Panel gali log:** Warns tab e "Recent Gali Log" — ke ki bollo bot thekei dekho (Firestore rules re-publish লাগবে: `tg_gali_log`)।
- Test normal member ID দিয়ে করো (admin der bot dhore na)।

## X. Still kaj na korle checklist + mention warn + DM test (2026-10-11)
- **① Render redeploy MUST:** local file bodlalei hobe na — GitHub push → Render deploy success dekho, tarpor test।
- **② Purono group fix:** Gali tab → **⚡ Built-in ON for ALL groups** (1 tap) বা per-group toggle ON + Save।
- **③ Member ID diye test** (admin exempt) + **bot Admin** (Delete/Ban) — permission na thakle bot group Ei janabe।
- **Warn ekhon clickable mention** (নামে tap = profile) + delete age, reply pore।
- **DM verify:** Trackers → ID bosao → **📨 Test DM** (per-ID ✅/❌ + কারণ)। ID add hole bot auto **✅ Connected** DM পাঠায়। Fail = oi ID bot e **/start** দেয়নি।

## X. Built-in gali list — dekho + per-word manage (2026-10-11)
- Gali tab e **full live list** (server theke): search + count + word tap = OFF (লাল কাটা) / ON (সাদা) + Reset all ON।
- OFF করা word bot ধরবে না, বাকি সব ধরবে। **Save Gali Settings** চাপলে apply। Custom words আলাদা box e আগের মতো।

## Y. Admin DM + log e matched word (2026-10-11)
- Gali DM + panel log e এখন **🎯 Matched: "word"** — full message er KON word-এ ধরলো mention সহ।
- OFF করা word-এর family-ও ছাড় পায় (e.g. "খানকি" OFF → "খানকির পোলা"-তেও ধরবে না; আলাদা "chod" ঠিকই ধরবে)।

## Z. Choto-word precision fix — Iqbal/বালতি safe (2026-10-11)
- ছোট word এখন শুধু **আলাদা** থাকলে ধরে: ইকবাল/Iqbal, বালক, বালতি, বালিশ, নাবালক, Bokaro, chhakka (ছক্কা), pathshala, chorus, globaler — এগুলোতে আর ভুল warning নেই।
- আসল গালি আগের মতোই ধরে: "তুই বাল", "মাগির পোলা", "চোদাকে ধর", f.u.c.k, b0k4।
- Note: জুতা/গরু/ক্ষেত-এর মতো double-meaning word list-এ আছে — দরকার না হলে panel থেকে OFF করে দিও।

## AA. Token-based gali precision + threat-negation (2026-10-14)
- Cross-word জোড়া আর ধরে না: "tumar bolo"→marbo, "kom chilo"→mc, "nacho dam"→chod, "Bob"→boob, "ashole"(আসলে)→asshole, "mishti/dushtu"→sht — সব safe।
- Common word শুধু standalone(+suffix): dalal/dalaler ধরে, dalali ধরে না; "marbo na" skip।
- Bypass আগের মতোই ধরে: F.U.C.K, b!tch, b0k4ch0d4, phuck, m.c — test: 63 case green।
- Trigger keyword "ok"/"buy" এখন "book"/"buyer"-এ fire করে না। Redeploy লাগবে (GitHub push → Render)।

## AB. Dyno-style Automod Rules — light version (2026-10-14)
- Group panel e **Automod Rules** tab: rule cards (status dot + EDIT + toggle + search) — Bad Words, Links, **All Caps, Emoji Spam, Duplicate Text, Newlines, Character Count**, Flood, Forward, Video, Inbox, Button, Fake-title, Scammer।
- Notun 5 rule **default OFF** (purono group e hothat delete hobe na) — card ON + limit + Save।
- **+ Create Rule** modal (Dyno modal er moto): Bad Words / Trigger Keyword / 5 automod type — baniye dilei apply।
- Custom warn text per-rule (Automod card / Custom Messages tab)। Rules Firestore `tg_groups` doc e save — notun field publish লাগে না।

## AC. Panel theke bot-message na jawa — shob send path fix (2026-10-22)
- **Asol karon:** custom bot connect kora group e panel **default bot** diye pathachilo — oi bot group e member na, tai Telegram 403 dicchilo + server silently fail korachilo. Panel e absulut kono error dekhaito na.
- **Fix 1 — per-chat bot resolve:** send-message, group-broadcast, test-welcome, test-trigger, chat-lock, moderate-user, giveaway create/bump/refresh/end — sob ekhon chain use kore: **panel request bot → tg_groups doc er botId → default bot**. Custom-bot group e oi group er NIJER bot diye jabe.
- **Fix 2 — honest report:** broadcast age `0 টি গ্রুপে পাঠানো হয়েছে` dekhiye success ashen hoto — ekhon success/failed/total + per-group error report hoy, Benglish hint soho (bot member na / Chat ID bhul / permission nei).
- **Fix 3 — HTML parse fail = auto plain-text retry**, message ar jay na. Caption/winner text e `<>&` sanitize (escH) — End-result message parse hoy na emon bhul hobe na.
- **Fix 4 — Giveaway Chat ID fix:** numeric ID dile auto `-100...` prefix (age `chat not found` ashto). Photo fail hole text-message fallback.
- **Fix 5 — Giveaway end jamela na:** result DM/post na gele o giveaway **end + winners Firestore e save hoy** (stuck `active` na thakbe). Unpin fail holeo continue.
- **Fix 6 — Panel API robust:** 30s timeout + non-JSON server response + network error e clear toast. Flood (429) hole 3s wait + 50ms per-group guard.
- **Korte hobe:** GitHub push → Render deploy success → panel **Ctrl+F5** hard refresh. Dashboard e **Server URL** web-hook ekhono lagbe (shob bot-send API er jonno). Custom-bot group e bot ke **Admin** (Ban + Delete + Pin) banao.

## AD. Auto-Reply (Trigger) — user/ADMIN duijon kar reply + multi button (2026-10-22)
- **Reply option panel e ekhon clear:** Group Dashboard -> **Triggers & Keywords** -> **+ Add Reply (Auto-Reply)** form (list-er **upore**, age niche chilo tai dekha jayto na). Keyword + Reply Text + **Reply Dibbe Kake?** (Everyone / Admin only) + **Reply delete sec**.
- **User ba admin — duijon kar reply dey:** Normal trigger `isAdmin` check-er **age** chole, tai member ba admin jeta keyword likhlei bot reply dey. `Admin only` select korle shudhu admin lekhlei reply (adminTriggers) — `if (isAdmin) return` er age chole tai admin-o trigger pai.
- **Multi button (max 5):** Reply text-er **niche** button gulo dekhabe (Telegram inline keyboard) — **Label + Link** prottekta row e, `+ Add Button` diye jorano, ✕ diye delete. Panel e **live preview** dekhay (text bubble + button gulo niche, exactly group-er moto).
- **Button optional:** Kono button na dile shudhu text reply jabe (kono error nai). `@username` o link hisebe cholbe (auto `t.me/`), `javascript:`/`data:` link reject hoy.
- **Edit + Test:** Protita reply row e **Edit** (form e load kore change kora) + **Test** (group e pathiye dekhano) button. Test e button gulo-o dekhabe.
- **Bot er `/panel` wizard eo button add kora jay (age chilo na):** `⚡ Add reply` / `👑 Add admin-reply` -> keyword -> reply -> **3️⃣ Button dite chao?** -> `Label | https://link` pathao (bar bar), `0` likhe skip -> delete sec. Maximum 5 button.
- **Create Rule modal** (Trigger Keyword type) eo optional button field add hoyeche.
- Bad link / HTML parse error e error hint + plain-text fallback — message chup chup pathay na.
- **Korte hobe:** GitHub push -> Render redeploy -> panel **Ctrl+F5** hard refresh.

## AE. Admin notification fix (gali/name-change/welcome) + USER PROFILE (bio) (2026-10-22)
- **Notification kaj korchilo na — 3 ta karon:** (1) `dmAdmins` module-level chilo → **default shared bot** diye DM pathachilo, custom-bot group e oi bot admin er DM e chilo na. Ekhon **prati call e oi group er nijer bot** (`groupBot`) pass hoy. (2) Panel e admin ID na thakle list khali → keu DM pey na. Ekhon **Telegram theke group er asol admin der list auto-detect** hoy (creator + administrator), panel list er sathe merge hoy. (3) DM fail hole chup chup chup hoto — ekhon `/start` na kora admin ke detect hoy (`bot_e_start_dewa_nei`).
- **Je gulo admin DM dey (6 ta):** Welcome (new member), **Gali alert**, **Name change** (notun add hoyeche), Leave, Live event, Fake-title decline.
- **👉 DM na jay → admin ke bot er DM e `/start` dite hobe.** Telegram bot DM pathate pare na seta na janle DM kaj kore na. Panel → Trackers → hint o update hoyeche.
- **`/bio` (alias `/profile`, `/userinfo`) — USER PROFILE:** group e likho `bio` (ba `/bio`), tar sathe reply/@mention/ID dile **user er shob data** dekhay:
    • Name, Username, User ID
    • **Koto warn** ache (ei group e)
    • **Name change history** — kobe kobe name badlache, **age ki name chilo** (sonoto age theke, timestamp soho)
    • Scammer list e ache ki na
    • Koto message pathayche, last seen, first seen
    • **Gali log** — ki ki bollo, kon word dhralo
- Profile **admin only** (group e kichu data leak na hoy). Reply kore, @mention kore, ba ID likhe — shobchinte kaj kore. Target na thakle nijer profile dekhay.
- **Panel eo Profile button:** Members list + Warns list e **Profile** button → full profile modal (name, warn, name history, gali log, scammer).
- **API:** `POST /api/tg/user-bio` (chatId + userId) → full profile HTML + JSON data.
- **Korte hobe:** GitHub push -> Render redeploy -> panel **Ctrl+F5** hard refresh.

## AF. Bio profile — branding + mention + copy + admin note (2026-10-22)
- **Footer shundor kora:** profile er niche ekhon `⚡ Powered by Vareon Studio` — age `Admin only — data ei group er member der jonno` chilo, ekhon **"Admin only" ei text nai**. Profile body-r kono jaygay o "admin only" lekha nai.
- **Mention clickable:** Name ar Username ekhon **clickable mention** (`tg://user?id=...`) — tap korle direct oi user er profile. Username na thakle `-` dekhay (kono khali link nai).
- **👑 Admin badge:** target user jodi group er admin/creator hoy, profile e `👑 Admin` dekhay — regular member e dekhay na.
- **📋 Copy option (2 vabe):**
    • **Bot e:** profile message-er niche **📋 Copy profile** button — click korle plain text (mention-free, HTML chara) `<pre>` block e dey, jeta directly copy kora jay.
    • **Panel e:** profile modal e **📋 Copy Profile** button — clipboard e copy hoy (fallback: textarea select+execCommand).
- **Admin note (view + edit):** profile modal e **Admin note** box — admin nijei note likhe save korte pare (per group + per user, `tg_user_notes` collection e jay). Note profile e dekhay, sudhu admin dekhay. **API:** `POST /api/tg/user-note`.
- **Default/Automod message text — panel e dekhay + edit kora jay:** age panel e 5 ta message chilo (forward/video/inbox/link/button), ekhon **Automod er 5 ta message o add hoyeche** — All Caps, Emoji Spam, Duplicate Text, Chat Clearing (Newlines), Character Count. Shob message **Custom Auto-Replies** tab e dekhay o edit kora jay.
- **⚠️ Firestore rules update lagbe:** notun `tg_user_notes` collection add hoyeche — **Firebase Console > vsprotection1 > Firestore > Rules** e `firestore.rules` er notun version **Publish** koro (na korle note save/load hobe na).
- **Korte hobe:** GitHub push -> Render redeploy -> panel **Ctrl+F5** -> Firestore rules **Publish**.

## AG. COMMANDS section — full command list + custom reply (2026-10-22)
- **Panel e notun section: `⚡ Commands & Replies`** (left menu, oi group er sob command ek jaygay). Protita command card e dekhay:
    • **Command name** (mono) + alias (`/removewarn`, `/lock` etc.)
    • **Ki kaj kore** — plain Bangla description
    • **Ki reply dey** (default text, exactly jeta bot pathay)
    • **Je text boshano jay** — `{mention}` `{name}` `{id}` `{count}` `{limit}` `{reason}` `{duration}` `{groupId}` `{userId}` `{text}` `{code}` chips (click = copy)
    • Scope chip (Group / Bot DM) + Admin only / Sob member + Target লাগে
    • **📋 Copy** button (command text clipboard e copy)
- **Custom reply:** protita command er niche textarea — admin nijei text likhe **Save** kore. Ekhon oi command **oi text-i reply dibe** (default chara). **Clear** button diye custom text remove kora jay.
- **Mention thakle:** custom text e jodi user mention (`tg://user?id=` / `@username`) ba `{mention}` placeholder thake, bot sei target user ke tag kore reply dey. Matlab: `/off` er custom text e `Ei group ekhon off — admin @user ke bolben` likhe rakhle `/off` dile oi message-i jabe.
- **12 ta command wired** (custom text apply hoy): `/warn` `/warns` `/unwarn` `/resetwarn` `/ban` `/unban` `/kick` `/mute` `/unmute` `/scammer` `/unscammer` `/off`+`/on`.
- **22 ta command** registry te documented (group + DM sob) — jeta ekhono custom-text support nai (jemon `/bio`, `/panel`) segulo o dekha jay kaj kore.
- **Search box** diye command filter kora jay. Custom text per-group store hoy (`tg_groups.cmdTexts`).
- **API:** `GET /api/tg/commands?chatId=` (list + current custom) · `POST /api/tg/cmd-text` (chatId + cmd + text save).
- **Korte hobe:** GitHub push -> Render redeploy -> panel **Ctrl+F5**.

## AH. Custom Command — nije Bangla phrase likhe bot ke kaaj korano (2026-10-22)
- **Ei feature ta tumi chai: `/warn` command na likhe nijei Bangla phrase likhe bot ke kaaj korano.**
    • **Phrase** likho (jemon `warn dewa uchit`, `ei lok amar bhalo lagche na`)
    • **Action** choose koro — Reply only / Warn / Ban / Kick / Mute / 1ta warn kom / Sob warn clear
    • **Reply** likho (jonom `ore warn daw`) — bot oi text-i bolbe
- **Kivabe kaj kore:** Admin group e ei phrase likhe **user ke reply/@mention/ID** diye likhe (jemon `ei bot tumi ki mone koro oke warn dewa uchit` + user mention) → phrase match hoy → bot **sei user ke warn kore** → tarpor apnar likha reply pathay.
- **Action shudhu admin use korte parbe** — member phrase likhle action chole na (bot notice dey). Reply-only command shudhu sob member er jonno kaj kore.
- **Target:** reply / tap-mention / @username / numeric ID — chintei chole. Target chara phrase likhle bot bole dey "user ke reply koren ba @mention koren ba ID likhun".
- **Reply e placeholder:** `{mention}` `{name}` `{id}` `{count}` `{limit}` `{duration}` `{groupId}` `{userId}` `{text}` — jemon `ore warn daw, {mention} ({count}/{limit})`.
- **Kothay banabo:** Panel → **⚡ Commands & Replies** → upore **➕ Notun Custom Command banano** card. Niche **Apnar banano custom command (list)** — phir Edit/Delete. (Triggers tab eo notun **Action** dropdown add hoyeche.)
- **Built-in command er reply edit:** same Commands section e protita built-in command card er **Default reply** edit kora jay → oi command er reply change hoy (age addTrigger/msg change hoyilo).
- **Korte hobe:** GitHub push -> Render redeploy -> panel **Ctrl+F5**.
