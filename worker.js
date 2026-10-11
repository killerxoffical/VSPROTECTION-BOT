require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const TelegramBot = require("node-telegram-bot-api");

// ================= VS PROTECTION BOT (standalone) =================
// Group/Channel guardian: anti-link, anti-forward, anti-video, anti-inbox,
// flood control, gali warn/ban, welcome, triggers, scammer registry, giveaway.
// Database: vsprotection1 (Firestore). Bot nijer group e add hole auto-register.
// ONNODER GROUP: bot ke group e add kore ADMIN banalei protection chalu.

// ---------------- 1. EXPRESS (health + panel API) ----------------
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.status(200).send("VS Protection Bot Active!"));
app.get("/ping", (req, res) => res.status(200).send("pong"));
app.get("/health", (req, res) => res.status(200).json({ status: "ok", uptime: process.uptime() }));

// ---------------- 2. FIREBASE ADMIN (vsprotection1) ----------------
// Render env: FIREBASE_SERVICE_ACCOUNT = service account JSON (one-line).
// Local test: serviceAccountKey.json ei folder e rakhun (vsprotection1 console theke).
function loadServiceAccount() {
    const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
    if (raw) {
        // 1) direct JSON
        try { return normalizeSA(JSON.parse(raw)); } catch (e) {}
        // 2) JSON with escaped newlines double-escaped
        try { return normalizeSA(JSON.parse(raw.replace(/\\n/g, "\n"))); } catch (e) {}
        // 3) base64-encoded JSON
        try {
            const decoded = Buffer.from(raw, "base64").toString("utf8");
            if (decoded.trim().startsWith("{")) return normalizeSA(JSON.parse(decoded));
        } catch (e) {}
        console.error("[FATAL] FIREBASE_SERVICE_ACCOUNT env parse hoyনি! JSON one-line paste korun (naki base64?).");
        process.exit(1);
    }
    try {
        return normalizeSA(require("./serviceAccountKey.json"));
    } catch (e2) {
        console.error("[FATAL] FIREBASE_SERVICE_ACCOUNT env ba serviceAccountKey.json lagbe!");
        process.exit(1);
    }
}
function normalizeSA(sa) {
    // Render multiline paste e private_key er \n literal thakle fix
    if (sa && typeof sa.private_key === "string" && sa.private_key.includes("\\n")) {
        sa.private_key = sa.private_key.replace(/\\n/g, "\n");
    }
    return sa;
}
let serviceAccount = loadServiceAccount();
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ---------------- 3. BOT ----------------
const GROUP_PROTECT_BOT_TOKEN = (process.env.GROUP_PROTECT_BOT_TOKEN || "").trim();
if (!GROUP_PROTECT_BOT_TOKEN) {
    console.error("[FATAL] GROUP_PROTECT_BOT_TOKEN env missing! BotFather theke token niye set korun.");
    process.exit(1);
}
// Telegram long-polling: shudhu 1 ta instance chalaben (2 ta cholle update vag hoye jabe)
const groupBot = new TelegramBot(GROUP_PROTECT_BOT_TOKEN, { polling: true });
groupBot.on("polling_error", (e) => {
    const m = (e && e.message) || String(e);
    // 409 conflict = 2 ta instance cholche
    if (m.includes("409") || m.includes("conflict")) {
        console.error("[POLLING 409] 2 ta instance cholche! Render e Instances=1 korun, purono deploy stop korun.");
    } else {
        console.error("[POLLING]", m.slice(0, 200));
    }
});
groupBot.getMe().then((me) => console.log("[VS] Bot connected as @" + me.username + " (" + me.id + ")"))
    .catch((e) => console.error("[FATAL] Token vul / net problem:", e.message));

const WELCOME_IMG = "https://pub-4c6b2dbf3a0c4862a8964b1546de6283.r2.dev/1791346466943_file_00000000702c82118797af8f3a1c57e0.png";

const groupConfigs = new Map(); // chatId -> tg_groups doc
const userWarnings = new Map(); // "chatId:userId" -> warningCount
const lastWelcomeMessages = new Map(); // chatId -> messageId
const trigCool = new Map(); // "chatId:userId:keyword" -> lastReplyAt (15s anti-spam)
const floodMap = new Map(); // "chatId:userId" -> [timestamps] (10s flood control)

// ইনবক্স ও প্রমোশন শব্দ
const INBOX_WORDS = ["inbox", "dm me", "pm me", "message me", "msg me", "আমায় মেসেজ করো", "ইনবক্সে আসো", "ইনবক্স", "ইনবক্সে", "নক দাও", "নক দিন", "পার্সোনালে আসো"];
// "ib" alada handle hoy (word-boundary), nahole vibe/job/libra teo match korto!
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
// choto english word (<=3 char) hole \b boundary lagbe, boro/bangla hole includes-ই যথেষ্ট
function wordHit(textLower, word) {
    const w = (word || "").toLowerCase().trim();
    if (!w) return false;
    if (/^[a-z0-9]+$/.test(w) && w.length <= 3) {
        try { return new RegExp("\\b" + escRe(w) + "\\b", "i").test(textLower); } catch (e) { return false; }
    }
    return textLower.includes(w);
}
function isInboxText(text) {
    const t = (text || "").toLowerCase();
    if (!t) return false;
    if (wordHit(t, "ib")) return true;
    for (const w of INBOX_WORDS) { if (wordHit(t, w)) return true; }
    return false;
}

// আসল গালি তালিকা (বাংলা ও বাংলিশ) — choto word (mc/bc) boundary diye milbe
const REAL_BAD_WORDS = [
    "madarchod", "madarshod", "bessha", "khanki", "magi", "chudi", "chuda",
    "chudo", "balsal", "baler", "suor", "kutta", "gandu", "harami", "bokachoda", "chodar",
    "chudte", "malai", "dimaon", "মাদারচোদ", "খানকি", "মাগী", "চোদা", "চুদি", "বাল",
    "শুয়োর", "কুত্তা", "হারামি", "বোকাচোদা", "চোদ", "বেশ্যা", "খানকিরপোল"
];
const SHORT_BAD_WORDS = ["mc", "bc"];
function containsBadWord(text) {
    const t = (text || "").toLowerCase();
    if (!t) return false;
    const cleanText = t.replace(/[^a-zA-Z0-9\u0980-\u09FF]/g, "");
    for (const bad of REAL_BAD_WORDS) {
        const b = bad.toLowerCase();
        if (t.includes(b) || (b && cleanText.includes(b))) {
            // "বাল" / "চোদ" er moto choto bangla ongsho onno shobde thakte pare —
            // 3+ char bangla holeo kompokkhe word-boundary / space check kori na, kintu
            // khub choto (<=2) hole skip. Ekhane sob 3+ tai includes ok.
            return true;
        }
    }
    for (const sb of SHORT_BAD_WORDS) { if (wordHit(t, sb)) return true; }
    return false;
}

// ---------------- 4. BROADCAST API ----------------
app.post("/api/tg/group-broadcast", async (req, res) => {
    const { text, photoUrl, chatId } = req.body;
    if (!text) return res.status(400).json({ ok: false, error: "মেসেজ লিখুন" });

    try {
        let targets = [];
        if (chatId) {
            targets = [chatId.toString()];
        } else {
            const snap = await db.collection("tg_groups").get();
            snap.forEach((d) => targets.push(d.id));
        }
        let successCount = 0;

        for (const targetId of targets) {
            try {
                if (photoUrl) {
                    await groupBot.sendPhoto(targetId, photoUrl, { caption: text, parse_mode: "HTML" });
                } else {
                    await groupBot.sendMessage(targetId, text, { parse_mode: "HTML" });
                }
                successCount++;
            } catch (err) {}
        }
        return res.json({ ok: true, message: `${successCount} টি গ্রুপে ব্রডকাস্ট পাঠানো হয়েছে!` });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 5. GLOBAL WELCOME (tg_config/welcome, cached 5 min) ----------------
let globalWelcome = null, globalWelcomeAt = 0;
async function getGlobalWelcome() {
    if (globalWelcome && Date.now() - globalWelcomeAt < 5 * 60 * 1000) return globalWelcome;
    try {
        const d = await db.collection("tg_config").doc("welcome").get();
        globalWelcome = d.exists ? d.data() : {};
    } catch (e) { globalWelcome = globalWelcome || {}; }
    globalWelcomeAt = Date.now();
    return globalWelcome;
}
function buildWelcome(gw, name) {
    gw = gw || {};
    const text = gw.welcomeMsg ? String(gw.welcomeMsg).replace(/\{name\}/g, name || "Member")
        : `👋 <b>স্বাগতম ${name || "Member"}!</b>\n\n` +
          `আমাদের গ্রুপে আপনাকে স্বাগতম।\n\n` +
          `⚠️ <i>গ্রুপের নিয়ম মেনে চলুন, স্ক্যামার থেকে সতর্ক থাকুন।</i>`;
    const img = gw.welcomeImg || WELCOME_IMG;
    const links = (Array.isArray(gw.joinLinks) && gw.joinLinks.length) ? gw.joinLinks : [];
    const buttons = links.filter((b) => b && b.url).slice(0, 8).map((b) => ([
        { text: String(b.text || "Join").slice(0, 60), url: String(b.url) }
    ]));
    return { text, img, buttons };
}

app.post("/api/tg/test-welcome", async (req, res) => {
    const { chatId } = req.body;
    if (!chatId) return res.status(400).json({ ok: false, error: "Group ID দিন" });
    try {
        const gw = await getGlobalWelcome();
        const w = buildWelcome(gw, "Test User");
        const opts = { caption: w.text, parse_mode: "HTML" };
        if (w.buttons.length) opts.reply_markup = { inline_keyboard: w.buttons };
        await groupBot.sendPhoto(chatId.toString(), w.img, opts);
        return res.json({ ok: true, message: "Welcome preview পাঠানো হয়েছে!" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// Trigger test: keyword reply + buttons গ্রুপে পাঠিয়ে চেক করা
app.post("/api/tg/test-trigger", async (req, res) => {
    const { chatId, keyword } = req.body;
    if (!chatId || !keyword) return res.status(400).json({ ok: false, error: "Group + keyword দিন" });
    try {
        const gDoc = await db.collection("tg_groups").doc(chatId.toString()).get();
        const conf = gDoc.exists ? gDoc.data() : {};
        const trig = (conf.triggers || []).find((t) => (t.keyword || "").toLowerCase().trim() === keyword.toString().toLowerCase().trim());
        if (!trig) return res.status(404).json({ ok: false, error: "Keyword পাওয়া যায়নি" });
        const built = buildTriggerMarkup(trig);
        const opts = { parse_mode: "HTML", disable_web_page_preview: true };
        if (built.markup) opts.reply_markup = built.markup;
        try {
            await groupBot.sendMessage(chatId.toString(), trig.reply || "Test", opts);
        } catch (e) {
            const retry = { disable_web_page_preview: true };
            if (built.markup) retry.reply_markup = built.markup;
            await groupBot.sendMessage(chatId.toString(), trig.reply || "Test", retry);
        }
        if (built.skipped.length > 0) {
            return res.json({ ok: true, message: "Test পাঠানো হয়েছে! (" + built.buttons.length + " button, " + built.skipped.length + " টি বাদ পড়েছে — লিংক চেক করুন)", skipped: built.skipped });
        }
        return res.json({ ok: true, message: "Test পাঠানো হয়েছে! (" + built.buttons.length + " button)" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 6. GIVEAWAY API ----------------
app.post("/api/tg/create-giveaway", async (req, res) => {
    const { chatId, title, itemName, amount, winnersCount } = req.body;
    if (!chatId || !title || !itemName) return res.status(400).json({ ok: false, error: "সবগুলো তথ্য পূরণ করুন" });

    try {
        let gOwner = "";
        try { const gd = await db.collection("tg_groups").doc(chatId.toString()).get(); gOwner = gd.exists ? (gd.data().ownerUid || "") : ""; } catch (e) {}
        const giveawayRef = await db.collection("giveaways").add({
            chatId: chatId.toString(),
            ownerUid: gOwner,
            title,
            itemName,
            amount: amount || "",
            winnersCount: Number(winnersCount || 1),
            participants: [],
            status: "active",
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const gMsg = await groupBot.sendMessage(chatId,
            `🎉 <b>${title}</b>\n\n` +
            `🎁 <b>পুরস্কার:</b> ${amount ? amount + " " : ""}${itemName}\n` +
            `🏆 <b>বিজয়ী নির্বাচন:</b> ${winnersCount} জন\n\n` +
            `👇 নিচের বাটনে চাপ দিয়ে এখনই অংশগ্রহণ করুন!`,
            {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: `🎉 Join Giveaway [0]`, callback_data: `giveaway_join:${giveawayRef.id}` }]
                    ]
                }
            }
        );
        await groupBot.pinChatMessage(chatId, gMsg.message_id).catch(() => {});

        await giveawayRef.update({ messageId: gMsg.message_id });
        return res.json({ ok: true, message: "গিভঅ্যাওয়ে পোস্ট করা হয়েছে!", giveawayId: giveawayRef.id });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/tg/end-giveaway", async (req, res) => {
    const { giveawayId } = req.body;
    try {
        const gDoc = await db.collection("giveaways").doc(giveawayId).get();
        if (!gDoc.exists) return res.status(404).json({ ok: false, error: "Giveaway not found" });

        const g = gDoc.data();
        if (g.status === "ended") return res.status(400).json({ ok: false, error: "ইতিমধ্যে সমাপ্ত হয়েছে" });

        const participants = g.participants || [];
        if (participants.length === 0) {
            await groupBot.sendMessage(g.chatId, `⚠️ <b>${g.title} সমাপ্ত:</b> কোনো অংশগ্রহণকারী পাওয়া যায়নি।`, { parse_mode: "HTML" });
            await gDoc.ref.update({ status: "ended" });
            return res.json({ ok: true, message: "No participants" });
        }

        const shuffled = participants.sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, Math.min(g.winnersCount, participants.length));

        let winnerText = `🏆 <b>গিভঅ্যাওয়ে ফলাফল ও বিজয়ীদের তালিকা!</b>\n\n🎉 <b>${g.title}</b>\n🎁 <b>পুরস্কার:</b> ${g.amount ? g.amount + " " : ""}${g.itemName}\n\n`;
        winners.forEach((w, idx) => {
            winnerText += `🥇 <b>Winner ${idx + 1}:</b> <a href="tg://user?id=${w.id}">${w.name}</a> (<code>${w.id}</code>)\n`;
        });
        winnerText += `\n🎉 অভিনন্দন সবাইকে! এডমিনের সাথে যোগাযোগ করে পুরস্কার সংগ্রহ করুন।`;

        await groupBot.sendMessage(g.chatId, winnerText, { parse_mode: "HTML" });
        await groupBot.unpinChatMessage(g.chatId).catch(() => {});
        await gDoc.ref.update({ status: "ended", winners });

        return res.json({ ok: true, winners });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 7. MODERATE API (ban/unban/mute) ----------------
app.post("/api/tg/moderate-user", async (req, res) => {
    const { action, chatId, userId } = req.body;
    if (!chatId || !userId || !action) return res.status(400).json({ ok: false, error: "Missing parameters" });

    try {
        if (action === "ban") {
            await groupBot.banChatMember(chatId, userId);
            return res.json({ ok: true, message: "User banned!" });
        } else if (action === "unban") {
            await groupBot.unbanChatMember(chatId, userId, { only_if_banned: true });
            return res.json({ ok: true, message: "User unbanned!" });
        } else if (action === "mute") {
            const until = Math.floor(Date.now() / 1000) + 3600;
            await groupBot.restrictChatMember(chatId, userId, {
                permissions: { can_send_messages: false },
                until_date: until
            });
            return res.json({ ok: true, message: "User muted for 1 hour!" });
        }
        return res.status(400).json({ ok: false, error: "Invalid action" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// Warn counter: Firestore-backed (survives restarts) + memory fast-path
async function getWarnCount(chatId, userId) {
    try {
        const w = await db.collection("tg_warns").doc(`${chatId}:${userId}`).get();
        if (w.exists) return Number(w.data().count || 0);
    } catch (e) {}
    return userWarnings.get(`${chatId}:${userId}`) || 0;
}
async function setWarnCount(chatId, userId, n, ownerUid) {
    userWarnings.set(`${chatId}:${userId}`, n);
    try {
        await db.collection("tg_warns").doc(`${chatId}:${userId}`).set({
            chatId, userId, count: n, ownerUid: ownerUid || "",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (e) {}
}
async function clearWarn(chatId, userId) {
    userWarnings.delete(`${chatId}:${userId}`);
    try { await db.collection("tg_warns").doc(`${chatId}:${userId}`).delete(); } catch (e) {}
}

// ---------------- 8. ADMIN CHECK ----------------
const groupAdminCache = new Map(); // chatId -> { admins: Set, time: number }

async function isGroupAdmin(chatId, fromUser, msg) {
    if (!fromUser) return false;

    // ১. অ্যানোনিমাস এডমিন বা চ্যানেলের নামে মেসেজ পাঠালে ১০০% এডমিন
    if (fromUser.username === "GroupAnonymousBot" || fromUser.id === 1087968824 || fromUser.id === 136817688) {
        return true;
    }
    if (msg && msg.sender_chat) {
        return true;
    }

    const userId = fromUser.id.toString();

    // ২. মেমোরি ক্যাশ চেক (প্রতি ৫ মিনিটে ১ বার রিফ্রেশ, রেট লিমিট প্রটেকশন)
    const cached = groupAdminCache.get(chatId);
    if (cached && (Date.now() - cached.time < 5 * 60 * 1000)) {
        if (cached.admins.has(userId)) return true;
    }

    try {
        const adminList = await groupBot.getChatAdministrators(chatId);
        const adminSet = new Set(adminList.map(a => a.user.id.toString()));
        groupAdminCache.set(chatId, { admins: adminSet, time: Date.now() });
        return adminSet.has(userId);
    } catch (e) {
        if (cached && cached.admins.has(userId)) return true;
        try {
            const m = await groupBot.getChatMember(chatId, fromUser.id);
            return m.status === "creator" || m.status === "administrator";
        } catch (err) {
            return false;
        }
    }
}

// Command helper: /claim, /claim@Bot, /scammer@Bot sob dhore
function isCommand(text, cmd) {
    const t = (text || "").trim();
    if (!t) return false;
    if (t === cmd) return true;
    if (t.startsWith(cmd + " ")) return true;
    if (t.startsWith(cmd + "@")) return true;
    return false;
}
function parseClaimCode(text) {
    const t = (text || "").trim();
    const m = t.match(/^\/claim(@[A-Za-z0-9_]+)?\s*([\s\S]*)$/i);
    if (!m) return "";
    return (m[2] || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
// group er fresh ownerUid (cache stale holeo warn/giveaway te sothik owner jabe)
async function getFreshOwner(chatId, cachedConf) {
    if (cachedConf && cachedConf.ownerUid) return cachedConf.ownerUid;
    try {
        const gd = await db.collection("tg_groups").doc(chatId.toString()).get();
        if (gd.exists) return gd.data().ownerUid || "";
    } catch (e) {}
    return "";
}

// গ্রুপে বট অ্যাড হলেই স্বয়ংক্রিয় রেজিস্টার (default protection ON)
groupBot.on("my_chat_member", async (msg) => {
    try {
        const chat = msg.chat;
        if (!chat) return;
        const ctype = chat.type || "";
        if (ctype !== "group" && ctype !== "supergroup" && ctype !== "channel") return;
        const newStatus = msg.new_chat_member ? msg.new_chat_member.status : "";
        groupAdminCache.delete(chat.id.toString());
        linkedCache.delete(chat.id.toString());

        if (newStatus === "administrator" || newStatus === "member") {
            await db.collection("tg_groups").doc(chat.id.toString()).set({
                id: chat.id.toString(),
                title: chat.title || "Channel/Group",
                chatType: ctype,
                username: chat.username ? `@${chat.username}` : "Private",
                antiLink: true,
                antiVideo: false,
                antiForward: true,
                antiInbox: true,
                lastActive: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            console.log("[VS] New group registered:", chat.title, chat.id.toString());
            // Group e visible proof — bot jibito + ki korte hobe
            if (ctype === "group" || ctype === "supergroup") {
                const isAdminNow = (newStatus === "administrator");
                try {
                    await groupBot.sendMessage(chat.id.toString(),
                        isAdminNow
                            ? `✅ <b>VS Protection চালু!</b>\n\n🆔 Group ID: <code>${chat.id}</code>\n\n🔑 Panel er <b>Claim Code</b> copy kore ekhane likhun:\n<code>/claim CODE</code>\n\n⚠️ Protection puropuri kaj korbe jokhon ami <b>Admin</b> (Delete + Ban + Pin permission soho).`
                            : `👋 আমাকে <b>Admin</b> বানান — তাহলেই protection চালু হবে!\n\n🆔 Group ID: <code>${chat.id}</code>\n(Admin bananor por group auto-register হবে)`,
                        { parse_mode: "HTML" }).catch(() => {});
                } catch (e) {}
            }
        } else if (newStatus === "left" || newStatus === "kicked") {
            console.log("[VS] Bot removed from:", chat.title, chat.id.toString());
        }
    } catch (e) {}
});
// Channel e add hole (channel_post universe) — register miss na hoy
groupBot.on("channel_post", async (msg) => {
    try {
        if (!msg.chat) return;
        const chatId = msg.chat.id.toString();
        await db.collection("tg_groups").doc(chatId).set({
            id: chatId,
            title: msg.chat.title || "Channel",
            chatType: "channel",
            username: msg.chat.username ? `@${msg.chat.username}` : "Private",
            lastActive: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (e) {}
});

// Linked-channel cache (own channel forwards must NOT be deleted)
const linkedCache = new Map();
async function getLinkedChatId(chatId) {
    if (linkedCache.has(chatId)) return linkedCache.get(chatId);
    try {
        const info = await groupBot.getChat(chatId);
        const lid = info && info.linked_chat_id ? String(info.linked_chat_id) : "";
        linkedCache.set(chatId, lid);
        return lid;
    } catch (e) { return ""; }
}

// Trigger multi-button builder (shared: live reply + test API)
function cleanTriggerUrl(raw) {
    if (!raw) return "";
    let u = raw.toString().trim();
    if (!u) return "";
    if (u.startsWith("@")) u = "https://t.me/" + u.slice(1);
    u = u.replace(/t\.me\/@/g, "t.me/");
    if (!/^https?:\/\//i.test(u)) {
        // single word (no dot/slash) = Telegram username -> t.me link
        if (!u.includes(".") && !u.includes("/") && !u.includes(":") && !u.includes(" ")) {
            u = "https://t.me/" + u.replace(/^@/, "");
        } else {
            u = "https://" + u;
        }
    }
    try {
        const parsed = new URL(u);
        if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.includes(".")) return parsed.href;
    } catch (e) {}
    return "";
}
function buildTriggerMarkup(trig) {
    const buttons = [];
    const skipped = [];
    const pushBtn = (txt, rawUrl) => {
        const validUrl = cleanTriggerUrl(rawUrl);
        const label = (txt || "").toString().trim().slice(0, 60);
        if (label && validUrl) {
            buttons.push([{ text: label, url: validUrl }]);
        } else if (label) {
            skipped.push({ label: label, url: (rawUrl || "").toString().slice(0, 120) });
        }
    };
    if (trig) {
        if (Array.isArray(trig.buttons) && trig.buttons.length > 0) {
            trig.buttons.forEach((b) => { if (b) pushBtn(b.text, b.url); });
        } else if (trig.btnText && trig.btnUrl) {
            pushBtn(trig.btnText, trig.btnUrl);
        }
    }
    return { buttons: buttons, skipped: skipped, markup: buttons.length > 0 ? { inline_keyboard: buttons } : null };
}

// ---------------- 9. MASTER MESSAGE FILTER ----------------
groupBot.on("message", async (msg) => {
    try {
        if (!msg.chat) return;
        const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
        const chatId = msg.chat.id.toString();
        const msgId = msg.message_id;
        const fromUser = msg.from;

        // অ্যানোনিমাস এডমিন সাপোর্ট
        const isAnonymousAdmin = fromUser && (fromUser.username === "GroupAnonymousBot" || fromUser.id === 1087968824);
        if (!fromUser || (fromUser.is_bot && !isAnonymousAdmin)) return;

        const userId = isAnonymousAdmin ? chatId : fromUser.id.toString();
        const currentName = isAnonymousAdmin ? (msg.chat.title || "Admin") : `${fromUser.first_name || ""} ${fromUser.last_name || ""}`.trim();
        const currentUsername = isAnonymousAdmin ? `@${msg.chat.username || "anonymous"}` : (fromUser.username ? `@${fromUser.username}` : "None");
        const text = (msg.text || msg.caption || "").trim();

        // ১. ইনস্ট্যান্ট কাস্টম অটো-রিপ্লাই (keyword match + 15s cooldown)
        let groupConf = groupConfigs.get(chatId);
        if (!groupConf) {
            const gDoc = await db.collection("tg_groups").doc(chatId).get();
            groupConf = gDoc.exists ? gDoc.data() : {};
            if (gDoc.exists) groupConfigs.set(chatId, groupConf);
        }

        if (groupConf && groupConf.triggers && groupConf.triggers.length > 0 && text) {
            const cleanUserText = text.toLowerCase().trim();
            for (const trig of groupConf.triggers) {
                const kw = (trig.keyword || "").toLowerCase().trim();
                if (kw && (cleanUserText.includes(kw) || cleanUserText === kw)) {
                    const ck = chatId + ":" + userId + ":" + kw;
                    if (Date.now() - (trigCool.get(ck) || 0) < 15000) continue;
                    trigCool.set(ck, Date.now());
                    if (trigCool.size > 4000) trigCool.clear();

                    const built = buildTriggerMarkup(trig);
                    if (built.skipped.length > 0) {
                        console.error("[TRIGGER BTN SKIP] chat=" + chatId + " keyword=\"" + trig.keyword + "\" bad=" + JSON.stringify(built.skipped));
                    }
                    const sendOpts = {
                        reply_to_message_id: msgId,
                        parse_mode: "HTML",
                        disable_web_page_preview: true
                    };
                    if (built.markup) sendOpts.reply_markup = built.markup;

                    groupBot.sendMessage(chatId, trig.reply, sendOpts).catch((err) => {
                        console.error("[TRIGGER SEND ERR] chat=" + chatId + " keyword=\"" + trig.keyword + "\":", err.message);
                        const retry = { reply_to_message_id: msgId, disable_web_page_preview: true };
                        if (built.markup) retry.reply_markup = built.markup;
                        groupBot.sendMessage(chatId, trig.reply, retry).catch(() => {
                            groupBot.sendMessage(chatId, trig.reply, { reply_to_message_id: msgId }).catch(() => {});
                        });
                    });
                    break;
                }
            }
        }

        // প্রাইভেটে /start,/help,/id — bot alive test
        if (!isGroup) {
            if (isCommand(text, "/start") || isCommand(text, "/help")) {
                await groupBot.sendMessage(chatId,
                    `👋 <b>VS Protection Bot</b>\n\n✅ Bot <b>চালু আছে!</b>\n\n<b>Group e lagaben:</b>\n1️⃣ আমাকে group e add করুন\n2️⃣ <b>Admin</b> বানান (Delete + Ban + Pin)\n3️⃣ Panel er Claim Code দিয়ে group e লিখুন:\n<code>/claim CODE</code>\n\n❓ Help: /id — nijer ID dekhun`,
                    { parse_mode: "HTML" }).catch(() => {});
                return;
            }
            if (isCommand(text, "/id")) {
                await groupBot.sendMessage(chatId, `🆔 Your ID: <code>${fromUser.id}</code>`, { parse_mode: "HTML" }).catch(() => {});
                return;
            }
            return;
        }

        // গ্রুপ ডাটাবেজে অটো-সিঙ্ক
        db.collection("tg_groups").doc(chatId).set({
            id: chatId,
            title: msg.chat.title || "Group",
            username: msg.chat.username ? `@${msg.chat.username}` : "Private",
            lastActive: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true }).catch(() => {});

        const isAdmin = await isGroupAdmin(chatId, fromUser, msg);

        // Diagnostic: /id — group + user ID (sobai, bot alive proof)
        if (isCommand(text, "/id")) {
            await groupBot.sendMessage(chatId,
                `🆔 Group ID: <code>${chatId}</code>\n👤 Your ID: <code>${fromUser.id}</code>\n${isAdmin ? "👑 আপনি <b>Admin</b>" : "👥 আপনি Member"}`,
                { parse_mode: "HTML", reply_to_message_id: msgId }).catch(() => {});
            return;
        }
        if (isCommand(text, "/start") || isCommand(text, "/help")) {
            await groupBot.sendMessage(chatId,
                `🛡️ <b>VS Protection চালু!</b>\n\n🆔 Group ID: <code>${chatId}</code>\n\n<b>Commands:</b>\n<code>/claim CODE</code> — panel link (admin)\n<code>/scammer</code> — reply diye scammer tag (admin)\n<code>!notice</code> — admin notice + pin\n\n⚠️ Delete/Ban kaj na korle: আমাকে <b>Admin</b> বানিয়েছেন কিনা দেখুন (Delete + Ban + Pin)।`,
                { parse_mode: "HTML", reply_to_message_id: msgId }).catch(() => {});
            return;
        }

        // এডমিন !announce: 👑 ব্যাজ সহ নোটিশ repost + পিন
        if (isAdmin && /^\s*!/.test(text)) {
            const annText = text.replace(/^\s*!\s*/, "").trim().slice(0, 900);
            if (annText) {
                const annBody = `👑 <b>ADMIN NOTICE</b>\n\n${annText}`;
                try {
                    const sent = await groupBot.sendMessage(chatId, annBody, { parse_mode: "HTML", disable_web_page_preview: true });
                    try { await groupBot.pinChatMessage(chatId, sent.message_id, { disable_notification: true }); } catch (e) {}
                } catch (e) {
                    try {
                        const sent2 = await groupBot.sendMessage(chatId, `👑 ADMIN NOTICE\n\n${annText}`, { disable_web_page_preview: true });
                        try { await groupBot.pinChatMessage(chatId, sent2.message_id, { disable_notification: true }); } catch (e2) {}
                    } catch (e3) {}
                }
            }
            return;
        }

        // /claim CODE — group ke panel account er sathe link (group admin only)
        // FIX: @bot mention soho parse + admin-check age (age eta isAdmin return er pore chilo = kokhono cholto na!)
        if (isCommand(text, "/claim")) {
            if (!isAdmin) {
                const w = await groupBot.sendMessage(chatId, `⚠️ এই কমান্ড কেবল গ্রুপ এডমিনদের জন্য!`, { parse_mode: "HTML", reply_to_message_id: msgId });
                setTimeout(() => groupBot.deleteMessage(chatId, w.message_id).catch(() => {}), 5000);
                return;
            }
            const code = parseClaimCode(text);
            if (!code) {
                await groupBot.sendMessage(chatId, `💡 <b>ব্যবহার:</b> <code>/claim CODE</code> — CODE পাবেন admin panel dashboard e।\n🆔 Group ID: <code>${chatId}</code>`, { parse_mode: "HTML", reply_to_message_id: msgId });
                return;
            }
            try {
                const uq = await db.collection("vs_users").where("claimCode", "==", code).limit(1).get();
                if (uq.empty) {
                    await groupBot.sendMessage(chatId, `❌ ভুল CODE! Panel dashboard থেকে সঠিক CODE নিন। (দিলেন: <code>${code}</code>)`, { parse_mode: "HTML", reply_to_message_id: msgId });
                    return;
                }
                const ownerUid = uq.docs[0].id;
                const gRef = db.collection("tg_groups").doc(chatId);
                const gSnap = await gRef.get();
                const cur = gSnap.exists ? (gSnap.data().ownerUid || "") : "";
                if (cur && cur !== ownerUid) {
                    await groupBot.sendMessage(chatId, `⚠️ এই গ্রুপ already claimed! Age panel থেকে Remove/Unclaim করুন।`, { parse_mode: "HTML", reply_to_message_id: msgId });
                    return;
                }
                await gRef.set({ ownerUid: ownerUid, claimedAt: admin.firestore.FieldValue.serverTimestamp(), claimedBy: fromUser.id.toString() }, { merge: true });
                groupConfigs.delete(chatId);
                groupAdminCache.delete(chatId);
                await groupBot.sendMessage(chatId, `✅ গ্রুপ link done! এখন panel থেকে manage করতে পারবেন।\n🆔 <code>${chatId}</code> → Panel e <b>My Groups</b> e Refresh দিন।`, { parse_mode: "HTML", reply_to_message_id: msgId });
            } catch (e) {
                await groupBot.sendMessage(chatId, `❌ Claim failed, pore abar try korun।`, { parse_mode: "HTML", reply_to_message_id: msgId }).catch(() => {});
            }
            return;
        }

        // /scammer এবং /unscammer (admin only, reply দিয়ে) — FIX: age unreachable chilo
        if (isCommand(text, "/scammer") || isCommand(text, "/unscammer")) {
            if (!isAdmin) {
                const warn = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, এই কমান্ড কেবল এডমিনদের জন্য!`, { parse_mode: "HTML", reply_to_message_id: msgId });
                setTimeout(() => groupBot.deleteMessage(chatId, warn.message_id).catch(() => {}), 5000);
                return;
            }

            let targetUser = msg.reply_to_message ? msg.reply_to_message.from : null;
            if (!targetUser) {
                await groupBot.sendMessage(chatId, `💡 <b>ব্যবহার:</b> যাকে স্ক্যামার বানাবেন তাকে রিপ্লাই দিয়ে <code>/scammer</code> লিখুন।`, { parse_mode: "HTML", reply_to_message_id: msgId });
                return;
            }

            const targetId = targetUser.id.toString();
            const targetName = `${targetUser.first_name || ""} ${targetUser.last_name || ""}`.trim() || targetId;

            if (isCommand(text, "/scammer")) {
                await db.collection("tg_scammers").doc(targetId).set({
                    userId: targetId, name: targetName, username: targetUser.username ? `@${targetUser.username}` : "None",
                    isScammer: true, taggedBy: fromUser.id.toString(), taggedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                await groupBot.sendMessage(chatId, `🚨 <a href="tg://user?id=${targetId}">${targetName}</a>-কে চিরতরে <b>স্ক্যামার রেজিস্ট্রি করা হলো</b>!`, { parse_mode: "HTML", reply_to_message_id: msgId });
            } else {
                await db.collection("tg_scammers").doc(targetId).delete();
                await groupBot.sendMessage(chatId, `✅ <a href="tg://user?id=${targetId}">${targetName}</a>-কে স্ক্যামার লিস্ট থেকে মুক্ত করা হলো।`, { parse_mode: "HTML", reply_to_message_id: msgId });
            }
            return;
        }

        // Name Change Tracker + Scammer Alert (admin + member sobar jonno)
        try {
            const userDocRef0 = db.collection("tg_user_history").doc(userId);
            const userSnap0 = await userDocRef0.get();
            if (userSnap0.exists) {
                const oldData = userSnap0.data() || {};
                const oldName = oldData.name || "";
                const oldUsername = oldData.username || "";
                if (oldName !== currentName || oldUsername !== currentUsername) {
                    const changeAlert =
                        `🔄 <b>User Profile Changed!</b>\n\n` +
                        `👤 <b>User:</b> <a href="tg://user?id=${userId}">${currentName}</a> (<code>${userId}</code>)\n` +
                        `📝 <b>Name:</b> <code>${oldName}</code> ➔ <code>${currentName}</code>\n` +
                        `🔖 <b>Username:</b> <code>${oldUsername}</code> ➔ <code>${currentUsername}</code>`;
                    await groupBot.sendMessage(chatId, changeAlert, { parse_mode: "HTML" }).catch(() => {});
                    await userDocRef0.set({
                        name: currentName,
                        username: currentUsername,
                        previousNames: admin.firestore.FieldValue.arrayUnion({ name: oldName, username: oldUsername, at: new Date() })
                    }, { merge: true });
                }
            } else {
                await userDocRef0.set({
                    userId: userId, name: currentName, username: currentUsername, createdAt: admin.firestore.FieldValue.serverTimestamp()
                }).catch(() => {});
            }
            const scamSnap0 = await db.collection("tg_scammers").doc(userId).get().catch(() => null);
            if (scamSnap0 && scamSnap0.exists && scamSnap0.data().isScammer) {
                const scammerWarning =
                    `🚨 <b>SCAMMER ALERT!</b>\n\n` +
                    `⚠️ <a href="tg://user?id=${userId}">${currentName}</a> (<code>${userId}</code>) <b>একজন প্রমাণিত প্রতারক / স্ক্যামার!</b>\n` +
                    `❌ এই ইউজারের সাথে কেউ কোনো প্রকার লেনদেন করবেন না!`;
                await groupBot.sendMessage(chatId, scammerWarning, { parse_mode: "HTML", reply_to_message_id: msgId }).catch(() => {});
            }
        } catch (e) {}

        // এডমিন মেসেজে কোনো ফিল্টার চলবে না (command/tracker sesh, ekhon return)
        if (isAdmin) return;

        // ০. ফ্লাড কন্ট্রোল (১০ সেকেন্ডে ৬+ = ডিলিট + ওয়ার্ন, ১০+ = ১০ মিনিট মিউট)
        // Anonymous admin (sender_chat) ke flood e dhorbe na
        if (!isAnonymousAdmin && !msg.sender_chat) {
            const fk = chatId + ":" + userId;
            const nowT = Date.now();
            let farr = floodMap.get(fk) || [];
            farr = farr.filter((t) => nowT - t < 10000);
            farr.push(nowT);
            floodMap.set(fk, farr);
            if (floodMap.size > 4000) floodMap.clear();
            if (farr.length > 6) {
                floodMap.set(fk, []);
                await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                if (farr.length > 10) {
                    try {
                        await groupBot.restrictChatMember(chatId, fromUser.id, {
                            permissions: { can_send_messages: false },
                            until_date: Math.floor(Date.now() / 1000) + 600
                        });
                    } catch (e) {}
                }
                const flMsg = `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, এত দ্রুত মেসেজ পাঠাবেন না! (Flood control)`;
                const fm = await groupBot.sendMessage(chatId, flMsg, { parse_mode: "HTML" }).catch(() => null);
                if (fm) setTimeout(() => groupBot.deleteMessage(chatId, fm.message_id).catch(() => {}), 4000);
                return;
            }
        }

        if (!isAdmin) {
            // ১. ফরোয়ার্ড ব্লক (linked/allowed চ্যানেল ছাড়া সব ডিলিট)
            const isForwarded = Boolean(
                msg.forward_from ||
                msg.forward_from_chat ||
                msg.forward_sender_name ||
                msg.forward_origin ||
                msg.forward_date
            );

            if (groupConf.antiForward !== false && isForwarded) {
                let ownChannel = false;
                try {
                    const fwdChat = (msg.forward_origin && msg.forward_origin.type === "channel" && msg.forward_origin.chat)
                        ? msg.forward_origin.chat
                        : (msg.forward_from_chat || null);
                    if (fwdChat) {
                        const fid = (fwdChat.id !== undefined && fwdChat.id !== null) ? String(fwdChat.id) : "";
                        const fun = ((fwdChat.username || "").toString().toLowerCase().replace(/^@/, ""));
                        if (fid) {
                            const linked = await getLinkedChatId(chatId);
                            if (linked && fid === String(linked)) ownChannel = true;
                        }
                        if (!ownChannel && fun) {
                            const list = Array.isArray(groupConf.allowChannels) ? groupConf.allowChannels : [];
                            const norm = list.map((x) => (x || "").toString().toLowerCase().replace(/^@/, "").trim()).filter(Boolean);
                            if (norm.includes(fun)) ownChannel = true;
                        }
                    }
                } catch (e) {}
                if (ownChannel) return;
                await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                const fwdMsg = (groupConf.msgs && groupConf.msgs.forward) || "অন্য কোনো চ্যানেল, গ্রুপ বা ইনবক্স থেকে শেয়ার বা ফরোয়ার্ড করা সম্পূর্ণ নিষেধ!";
                const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, ${fwdMsg}`, { parse_mode: "HTML" });
                setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 4000);
                return;
            }

            // ২. ভিডিও ব্লক
            if (groupConf.antiVideo && (msg.video || msg.video_note)) {
                await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                const vidMsg = (groupConf.msgs && groupConf.msgs.video) || "গ্রুপে ভিডিও পাঠানো নিষেধ!";
                const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, ${vidMsg}`, { parse_mode: "HTML" });
                setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 4000);
                return;
            }

            // ৩. ইনবক্স ফিল্টার (FIX: "ib" ekhon word-boundary — vibe/job e match korbe na)
            if (groupConf.antiInbox !== false && text && isInboxText(text)) {
                await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                const ibMsg = (groupConf.msgs && groupConf.msgs.inbox) || "গ্রুপে ইনবক্সে ডাকার চেষ্টা করবেন না! সব কথা গ্রুপেই বলুন।";
                const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, ${ibMsg}`, { parse_mode: "HTML" });
                setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 4000);
                return;
            }

            // ৪. অ্যান্টি-লিংক (whitelist e thakle allow, nahole sob block)
            if (groupConf.antiLink !== false && (text.includes("t.me/") || text.includes("http://") || text.includes("https://") || text.includes("www."))) {
                const wl = (Array.isArray(groupConf.linkWhitelist) && groupConf.linkWhitelist.length)
                    ? groupConf.linkWhitelist
                    : [];
                const allowed = wl.length > 0 && wl.some((w) => w && text.toLowerCase().includes(String(w).toLowerCase()));
                if (!allowed) {
                    await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                    const linkMsg = (groupConf.msgs && groupConf.msgs.link) || "অননুমোদিত লিংক দেওয়া নিষেধ!";
                    const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, ${linkMsg}`, { parse_mode: "HTML" });
                    setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 4000);
                    return;
                }
            }

            // ৫. গালি ফিল্টার + warn/ban (FIX: mc/bc ekhon word-boundary)
            const hasBadWord = containsBadWord(text);

            if (hasBadWord) {
                await groupBot.deleteMessage(chatId, msgId).catch(() => {});
                const limit = Math.max(2, Number(groupConf.warnLimit) || 5);
                const action = groupConf.warnAction || "ban";
                let wOwner = await getFreshOwner(chatId, groupConf);
                const curWarns = (await getWarnCount(chatId, userId)) + 1;
                await setWarnCount(chatId, userId, curWarns, wOwner);
                const atName = `@${fromUser.username || fromUser.first_name}`;

                if (curWarns >= limit) {
                    if (action === "mute") {
                        const until = Math.floor(Date.now() / 1000) + 3600;
                        await groupBot.restrictChatMember(chatId, userId, {
                            permissions: { can_send_messages: false }, until_date: until
                        }).catch(() => {});
                        await groupBot.sendMessage(chatId, `🔇 <b>${atName}</b>-কে <b>১ ঘণ্টার জন্য মিউট</b> করা হলো! (গালি: ${curWarns}/${limit})`, { parse_mode: "HTML" });
                    } else if (action === "warn") {
                        await groupBot.sendMessage(chatId, `🚨 <b>${atName}</b>, <b>শেষ ওয়ার্নিং (${curWarns}/${limit})!</b> ${groupConf.warnMsg || "এরপর কঠোর ব্যবস্থা নেওয়া হবে!"}`, { parse_mode: "HTML" });
                    } else {
                        await groupBot.banChatMember(chatId, userId).catch(() => {});
                        await groupBot.sendMessage(chatId, `🚨 <a href="tg://user?id=${userId}">${currentName}</a>-কে <b>গ্রুপ থেকে ব্যান</b> করা হলো! (গালি: ${curWarns}/${limit})`, { parse_mode: "HTML" });
                    }
                    await clearWarn(chatId, userId);
                } else {
                    const base = groupConf.warnMsg || "ভদ্র ভাষা ব্যবহার করুন!";
                    const m = await groupBot.sendMessage(chatId, `⚠️ <b>${atName}</b>, ${base} সতর্কতা <b>(${curWarns}/${limit})</b>।`, { parse_mode: "HTML" });
                    setTimeout(() => groupBot.deleteMessage(chatId, m.message_id).catch(() => {}), 5000);
                }
                return;
            }
        }

    } catch (e) {
        console.error("[GROUP MSG ERR]:", e.message);
    }
});

// ---------------- 10. WELCOME ----------------
groupBot.on("new_chat_members", async (msg) => {
    try {
        const chatId = msg.chat.id.toString();
        const newMembers = msg.new_chat_members || [];

        const oldMsgId = lastWelcomeMessages.get(chatId);
        if (oldMsgId) {
            await groupBot.deleteMessage(chatId, oldMsgId).catch(() => {});
        }

        let gConf = groupConfigs.get(chatId);
        if (!gConf) {
            try {
                const gDoc = await db.collection("tg_groups").doc(chatId).get();
                gConf = gDoc.exists ? gDoc.data() : {};
                groupConfigs.set(chatId, gConf);
            } catch (e) { gConf = {}; }
        }
        const gw = await getGlobalWelcome();
        if (gw.welcomeOn === false) return;

        for (const user of newMembers) {
            if (user.is_bot) continue;
            // bot nije join hole welcome na (my_chat_member greeting dey)
            try {
                const me = await groupBot.getMe().catch(() => null);
                if (me && user.id === me.id) continue;
            } catch (e) {}
            const name = user.first_name || "Member";
            const w = buildWelcome(gw, name);

            const photoOpts = { caption: w.text, parse_mode: "HTML" };
            if (w.buttons.length) photoOpts.reply_markup = { inline_keyboard: w.buttons };
            let sentWelcome = await groupBot.sendPhoto(chatId, w.img, photoOpts).catch(async () => {
                // photo URL dead hole text welcome
                const topts = { parse_mode: "HTML" };
                if (w.buttons.length) topts.reply_markup = { inline_keyboard: w.buttons };
                return groupBot.sendMessage(chatId, w.text, topts).catch(() => null);
            });

            if (sentWelcome) {
                lastWelcomeMessages.set(chatId, sentWelcome.message_id);
                setTimeout(() => groupBot.deleteMessage(chatId, sentWelcome.message_id).catch(() => {}), 10000);
            }
        }
    } catch (e) {}
});

// Giveaway Join বাটন হ্যান্ডলার
groupBot.on("callback_query", async (query) => {
    try {
        const data = query.data;
        const fromUser = query.from;
        const chatId = query.message.chat.id;

        if (data.startsWith("giveaway_join:")) {
            const giveawayId = data.split(":")[1];
            const gRef = db.collection("giveaways").doc(giveawayId);
            const gSnap = await gRef.get();

            if (!gSnap.exists || gSnap.data().status === "ended") {
                return groupBot.answerCallbackQuery(query.id, { text: "এই গিভঅ্যাওয়ে ইতিমধ্যে শেষ হয়ে গেছে!", show_alert: true });
            }

            const participants = gSnap.data().participants || [];
            const alreadyJoined = participants.some((p) => p.id === fromUser.id.toString());

            if (alreadyJoined) {
                return groupBot.answerCallbackQuery(query.id, { text: "আপনি ইতিমধ্যে অংশগ্রহণ করেছেন!", show_alert: true });
            }

            participants.push({
                id: fromUser.id.toString(),
                name: `${fromUser.first_name || ""} ${fromUser.last_name || ""}`.trim()
            });

            await gRef.update({ participants });
            await groupBot.answerCallbackQuery(query.id, { text: "🎉 সফলভাবে অংশগ্রহণ করেছেন! শুভকামনা।", show_alert: true });

            await groupBot.editMessageReplyMarkup({
                inline_keyboard: [
                    [{ text: `🎉 Join Giveaway [${participants.length}]`, callback_data: `giveaway_join:${giveawayId}` }]
                ]
            }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
            return;
        }

    } catch (e) {}
});

// ---------------- 11. REALTIME CONFIG SYNC ----------------
db.collection("tg_groups").onSnapshot((snap) => {
    snap.docChanges().forEach((change) => {
        if (change.type === "removed") {
            groupConfigs.delete(change.doc.id);
        } else {
            const dat = change.doc.data();
            groupConfigs.set(change.doc.id, dat);
        }
    });
}, (err) => console.error("[SNAPSHOT]", err.message));

// Debug: group registered kina check (browser e khulle dekha jay)
app.get("/api/tg/groups-count", async (req, res) => {
    try {
        const snap = await db.collection("tg_groups").limit(1).get();
        res.json({ ok: true, reachable: true, sampleSize: snap.size });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------------- 12. START ----------------
const PORT2 = PORT;
app.listen(PORT2, () => console.log(`[VS] Protection Bot active on port ${PORT2}`));
console.log("[VS] Group protection polling started. Bot ke group e ADMIN banalei kaj shuru.");
