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

// ---------------- 2b. MULTI-BOT REGISTRY ----------------
// Default shared bot + user-connected bots (vs_bots collection, popup diye connect).
// botInstances: botId -> { bot, username }. APIs optional botId diye instance pick kore.
const botInstances = new Map();
function pickBot(botId) {
    try {
        if (botId && botInstances.has(String(botId))) return botInstances.get(String(botId)).bot;
    } catch (e) {}
    try { return groupBot; } catch (e) { return null; }
}

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
// Boundary list er sob word (je kono length) — sudhu alada word হিসেবে মিলবে
function wordBoundary(textLower, word) {
    const w = (word || "").toLowerCase().trim();
    if (!w) return false;
    try { return new RegExp("\\b" + escRe(w) + "\\b", "i").test(textLower); } catch (e) { return textLower.includes(w); }
}
function isInboxText(text) {
    const t = (text || "").toLowerCase();
    if (!t) return false;
    if (wordHit(t, "ib")) return true;
    for (const w of INBOX_WORDS) { if (wordHit(t, w)) return true; }
    return false;
}

// FULL gali list (Bangla + English + Banglish) — built-in default.
// Bypass-proof: matching এর সময় symbol/space মুছে + leet (4=a,0=o...) + repeat
// letter (fuuuck→fuk) normalize করে মেলানো হয়, তাই f.u.c.k / phuck / b!tch ও ধরা পড়ে।
const REAL_BAD_WORDS = [
    // --- English ---
    "fuck", "fucking", "fucker", "fucked", "motherfucker", "fck", "fuk",
    "shit", "shits", "shitty", "sht", "bullshit", "horseshit", "dipshit",
    "bitch", "bitches", "btch", "bch", "dick", "dicks", "dickhead", "dck",
    "pussy", "pssy", "asshole", "bastard", "whore", "slut", "sluts",
    "cunt", "wanker", "tosser", "dumbass", "jackass", "smartass",
    "blowjob", "handjob", "porn", "porno", "horny", "nude", "nudes",
    "boob", "boobs", "tits", "sexy", "sexting", "suck", "prick", "douche",
    "retard", "faggot", "nigga", "nigger", "cumshot", "cumming",
    // --- Banglish (beshi) ---
    "madarchod", "madarshod", "maderchod", "madarchud", "madarchoda", "motherchod",
    "behanchod", "behnchod", "bhenchod", "bhenchud", "bonchod",
    "sisterchod", "betichod", "betichoda", "fatherchod",
    "bokachoda", "bokachuda", "bokachod", "bokachud", "bokachodar",
    "khanki", "khangi", "khankipara", "khankibaz", "magir", "magirpola", "magibaz", "magipara",
    "chudi", "chuda", "chudo", "chude", "chudte", "chudbe", "chudlam", "chudar",
    "chudirbhai", "chudirbeta", "chodachudi", "chudachudi",
    "chodar", "chodna", "chod", "choda", "chodon",
    "randir", "randikhana", "randibaz", "randipara", "bessha", "beshya",
    "kutta", "kuttar", "kuttarbachcha", "kuttaibachcha", "kukur",
    "suor", "suyor", "shuor", "shuar", "shuorerbachcha", "shukor",
    "harami", "haramir", "haramjada", "haramjadi", "haramjad", "haramkhor",
    "gandu", "gandur", "gandmara", "gandmarani", "marani",
    "shala", "shalar", "abaler",
    "baler", "balchal", "balsal", "baal", "balerbal", "malai", "dimaon",
    "dalal", "batpar", "dhandabaz", "fotka", "fotkabaz", "chotolok", "fokini", "fokinnni",
    "chiter", "chitingbaz", "dhokabaz", "bhondo",
    "luichcha", "luchcha", "bodmaish", "bodmash", "beyadob",
    "shoytan", "shaitan", "shoitan", "soytaner", "iblis", "lanot", "behaya", "beshorom",
    "chamcha", "telbaj", "nimokharam", "bejonma", "jaroj", "munafik",
    "gadha", "boka", "murkho", "ahammok", "ulluk", "chasha", "khet", "habla",
    "chagol", "ramchagol", "goru", "shiyal", "bador",
    "dakat", "dakait", "khuni", "gunda", "mastan",
    "juta", "jhata", "lathkhor", "potita",
    "hijra", "hizra", "chakka", "malaun", "katua", "barovatari", "barobhatari",
    "shudkhor", "ghushkhor", "modkhor", "ganjakhor", "neshakhor", "babakhor",
    "chorer", "marbo", "merefelbo", "khunkorbo",
    // --- Bangla (beshi) ---
    "মাদারচোদ", "বোকাচোদা", "বোকাচুদা", "খানকি", "খানকিরপোলা", "খানকিরছেলে", "খানকিপাড়া",
    "মাগী", "মাগিরপোলা", "চোদা", "চুদি", "চোদনা", "চোদন", "চোদাচুদি",
    "রান্ডি", "রান্ডিখানা", "রান্ডিপাড়া", "বাল", "বালের", "বালছাল",
    "বেশ্যা", "শুয়োর", "শুয়োরেরবাচ্চা", "শুকর",
    "কুত্তা", "কুত্তারবাচ্চা", "কুকুর", "হারামি", "হারামজাদা", "হারামজাদি", "হারামখোর",
    "দালাল", "বাটপার", "ফটকা", "ফটকাবাজ", "ধান্দাবাজ", "ধোঁকাবাজ", "ভণ্ড",
    "ছোটলোক", "ফকিন্নি", "চুদিরভাই", "চুদিরবেটা", "মাগিপাড়া",
    "বেহায়া", "বেশরম", "বেয়াদব", "গান্ডু", "মারানি",
    "লুইচ্চা", "বদমাশ", "চিটার", "চিটিংবাজ", "চামচা", "তেলবাজ",
    "শালা", "আবাল", "নিমকহারাম", "বেজন্মা", "জারজ", "মুনাফিক",
    "গাধা", "বোকা", "মূর্খ", "আহাম্মক", "উল্লুক", "চাষা", "ক্ষেত", "হাবলা",
    "ছাগল", "রামছাগল", "গরু", "শিয়াল", "বাদর",
    "ডাকাত", "খুনি", "গুন্ডা", "মাস্তান", "বেটিচোদ",
    "জুতা", "ঝাঁটা", "লাথখোর", "পতিতা", "হিজড়া", "চাক্কা",
    "মালাউন", "কাটুয়া", "বারোভাতারি", "চোর", "চুরি",
    "সুদখোর", "ঘুষখোর", "মদখোর", "গাঁজাখোর", "নেশাখোর", "বাবাখোর",
    "মারবো", "মেরেফেলবো", "খুনকরব", "শয়তান", "ইবলিস"
];
// Choto/dangerous word — শুধু আলাদা word হিসেবে মিলবে
// (class/unisex/magic/shoe/title/cucumber/branding এ ধরবে না)
const BOUNDARY_BAD_WORDS = ["mc", "bc", "ass", "sex", "cum", "tit", "hoe", "magi", "randi", "abal", "chor", "churi"];
// Fake staff-title list (name/username e owner-admin-moderator — kintu real admin na)
// Default + custom দুটোই চলবে (panel থেকে)।
const DEFAULT_FAKE_TITLES = ["owner", "admin", "administrator", "moderator", "mod", "founder", "ceo", "support", "official", "staff", "manager"];
// name/username te title match? choto (<=4) strict boundary, boro includes.
// matched word return kore (decline text e {title} বসে), nahole "".
function fakeTitleHit(name, username, conf) {
    const files = [
        String(name || "").toLowerCase(),
        String(username || "").toLowerCase().replace(/^@/, "")
    ].filter(Boolean);
    if (!files.length) return "";
    const all = [];
    if (conf && Array.isArray(conf.customTitles)) {
        conf.customTitles.forEach((x) => { const w = String(x || "").trim().toLowerCase(); if (w.length >= 2) all.push(w); });
    }
    if (!conf || conf.useDefaultTitles !== false) all.push(...DEFAULT_FAKE_TITLES);
    for (const w of all) {
        const short = /^[a-z0-9]+$/.test(w) && w.length <= 4;
        for (const f of files) {
            if (short) { try { if (new RegExp("\\b" + escRe(w) + "\\b", "i").test(f)) return w; } catch (e) {} }
            else if (f.includes(w)) return w;
        }
    }
    return "";
}
// Abuse normalizer: symbol strip + ph→f + leet + repeat-collapse
function normAbuse(s) {
    let x = String(s || "").toLowerCase().replace(/[^a-z0-9\u0980-\u09FF]/g, "");
    x = x.replace(/ph/g, "f");
    x = x.replace(/[0134578@$]/g, (c) => ({ "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s" }[c]));
    return x.replace(/(.)\1+/g, "$1");
}
// Leet-map (symbol/space রেখে) — boundary word এর 4ss/a55/s3x trick ও ধরে
function leetMap(s) {
    return String(s || "").toLowerCase().replace(/[0134578@$]/g, (c) => ({ "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s" }[c]));
}
let normBadCache = null; // [{raw, norm}] — matched word দেখানোর জন্য raw রাখা হয়
function getNormBad() {
    if (!normBadCache) normBadCache = REAL_BAD_WORDS.map((w) => ({ raw: String(w), norm: normAbuse(w) }));
    return normBadCache;
}
// Full message theke KON word ta match korlo — admin DM/log e mention হয়
function findBadWord(text, conf) {
    const t = (text || "").toLowerCase();
    if (!t) return "";
    let skip = null;
    try {
        const dl = conf && conf.disabledBadWords;
        if (Array.isArray(dl) && dl.length) skip = new Set(dl.map((x) => normAbuse(String(x || "").trim())).filter(Boolean));
    } catch (e) {}
    for (const b of BOUNDARY_BAD_WORDS) {
        if (skip && skip.has(normAbuse(b))) continue;
        if (wordBoundary(t, b) || wordBoundary(leetMap(t), b)) return b;
    }
    const nText = normAbuse(t);
    if (!nText) return "";
    // Disabled word যে span cover করে, সেখানে কোনো match নয় (overlap হলেই বাদ)
    // (e.g. "খানকি" OFF → "খানকির পোলা"-তেও ধরবে না; কিন্তু আলাদা "tui chod" ঠিকই ধরবে)
    const spans = [];
    if (skip) skip.forEach((s) => {
        if (!s) return;
        let i = -1;
        while ((i = nText.indexOf(s, i + 1)) !== -1) spans.push([i, i + s.length]);
    });
    const covered = (idx, len) => spans.some(([a, b]) => idx < b && idx + len > a);
    const findIn = (list) => {
        for (const bad of (list || [])) {
            const b = String(bad || "").trim();
            if (!b || b.length < 2) continue;
            const nb = normAbuse(b);
            const ii = nText.indexOf(nb);
            if (ii !== -1 && !covered(ii, nb.length)) return b;
        }
        return "";
    };
    const cm = findIn(conf && conf.customBadWords);
    if (cm) return cm;
    if (!conf || conf.useDefaultBadWords !== false) {
        for (const e of getNormBad()) {
            if (!e.norm) continue;
            if (skip && skip.has(e.norm)) continue;
            const ii = nText.indexOf(e.norm);
            if (ii !== -1 && !covered(ii, e.norm.length)) return e.raw;
        }
    }
    return "";
}
function containsBadWord(text, conf) { return !!findBadWord(text, conf); }
// conf.customBadWords (panel থেকে MANUAL list) সবসময় চেক হয়।
// Built-in auto list default ON — panel থেকে toggle OFF করলেই শুধু বন্ধ
// (সম্পূর্ণ manual চাইলে custom list + toggle OFF)।
// NOTE: আসল logic উপরের findBadWord — containsBadWord শুধু wrapper।
// Inline URL-button আছে? (bot/ad রা message এর নিচে button-link দেয়)
function hasUrlButton(msg) {
    try {
        const kb = msg && msg.reply_markup && msg.reply_markup.inline_keyboard;
        if (!Array.isArray(kb)) return false;
        return kb.some((row) => Array.isArray(row) && row.some((b) => b && b.url));
    } catch (e) { return false; }
}

// Built-in gali list — panel theke admin dekhbe + manage korbe (single source: server)
app.post("/api/tg/badwords", async (req, res) => {
    try {
        return res.json({ ok: true, count: REAL_BAD_WORDS.length + BOUNDARY_BAD_WORDS.length, defaults: REAL_BAD_WORDS, boundary: BOUNDARY_BAD_WORDS });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 4. BROADCAST API ----------------
app.post("/api/tg/group-broadcast", async (req, res) => {
    const { text, photoUrl, chatId, botId } = req.body;
    if (!text) return res.status(400).json({ ok: false, error: "মেসেজ লিখুন" });
    const sender = pickBot(botId) || groupBot;

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
                    await sender.sendPhoto(targetId, photoUrl, { caption: text, parse_mode: "HTML" });
                } else {
                    await sender.sendMessage(targetId, text, { parse_mode: "HTML" });
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
// Per-group welcome resolver: mode=off -> null | custom(+msg) -> group text | global -> global text
async function resolveWelcome(chatId, gConf, name) {
    const mode = (gConf && gConf.welcomeMode) || "global";
    if (mode === "off") return null;
    if (mode === "custom" && gConf && gConf.welcomeMsg && String(gConf.welcomeMsg).trim()) {
        const gw = await getGlobalWelcome();
        const text = String(gConf.welcomeMsg).replace(/\{name\}/g, name || "Member");
        const img = gConf.welcomeImg || gw.welcomeImg || WELCOME_IMG;
        const links = (Array.isArray(gw.joinLinks) && gw.joinLinks.length) ? gw.joinLinks : [];
        const buttons = links.filter((b) => b && b.url).slice(0, 8).map((b) => ([
            { text: String(b.text || "Join").slice(0, 60), url: String(b.url) }
        ]));
        return { text, img, buttons, deleteSec: cfgNum(gConf, "welcomeDeleteSec", 10, 0, 300) };
    }
    const gw = await getGlobalWelcome();
    if (gw.welcomeOn === false) return null;
    const w = buildWelcome(gw, name);
    return { ...w, deleteSec: cfgNum(gConf, "welcomeDeleteSec", 10, 0, 300) };
}

app.post("/api/tg/test-welcome", async (req, res) => {
    const { chatId, botId } = req.body;
    if (!chatId) return res.status(400).json({ ok: false, error: "Group ID দিন" });
    const sender = pickBot(botId) || groupBot;
    try {
        let gConf = {};
        try {
            const gd = await db.collection("tg_groups").doc(chatId.toString()).get();
            if (gd.exists) gConf = gd.data() || {};
        } catch (e) {}
        const w = await resolveWelcome(chatId.toString(), gConf, "Test User");
        if (!w) return res.status(400).json({ ok: false, error: "Welcome OFF আছে (group/global)" });
        const opts = { caption: w.text, parse_mode: "HTML" };
        if (w.buttons.length) opts.reply_markup = { inline_keyboard: w.buttons };
        try {
            await sender.sendPhoto(chatId.toString(), w.img, opts);
        } catch (e) {
            const topts = { parse_mode: "HTML" };
            if (w.buttons.length) topts.reply_markup = { inline_keyboard: w.buttons };
            await sender.sendMessage(chatId.toString(), w.text, topts);
        }
        return res.json({ ok: true, message: "Welcome preview পাঠানো হয়েছে!" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// Popup bot-connector: token thik kina verify (store kore na — panel Firestore e save kore)
app.post("/api/tg/verify-bot", async (req, res) => {
    const token = ((req.body || {}).token || "").trim();
    if (!token || !token.includes(":")) return res.status(400).json({ ok: false, error: "সঠিক token দিন (BotFather থেকে)" });
    try {
        const tmp = new TelegramBot(token, { polling: false });
        const me = await tmp.getMe();
        return res.json({ ok: true, id: String(me.id), username: me.username ? ("@" + me.username) : "", name: me.first_name || "Bot" });
    } catch (e) {
        return res.status(400).json({ ok: false, error: "Token ভুল / bot পাওয়া যায়নি। BotFather token check করো।" });
    }
});

// Admin -> bot diye group/user ke message (panel Send box)
app.post("/api/tg/send-message", async (req, res) => {
    const { chatId, text, userId, replyTo, botId } = req.body;
    if (!chatId || !text) return res.status(400).json({ ok: false, error: "chatId + text দিন" });
    const sender = pickBot(botId) || groupBot;
    try {
        const opts = { parse_mode: "HTML", disable_web_page_preview: true };
        if (replyTo) opts.reply_to_message_id = Number(replyTo);
        let body = String(text).slice(0, 3500);
        if (userId) body = `<a href="tg://user?id=${userId}">👤</a> ` + body;
        const sent = await sender.sendMessage(chatId.toString(), body, opts).catch(async () => {
            const retry = {};
            if (replyTo) retry.reply_to_message_id = Number(replyTo);
            return sender.sendMessage(chatId.toString(), String(text).slice(0, 3500), retry);
        });
        return res.json({ ok: true, message: "পাঠানো হয়েছে!", messageId: sent ? sent.message_id : null });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// Panel theke warn clear (rules client-delete dey na, tai bot API diye)
app.post("/api/tg/clear-warn", async (req, res) => {
    const { chatId, userId } = req.body;
    if (!chatId || !userId) return res.status(400).json({ ok: false, error: "chatId + userId দিন" });
    try {
        await clearWarn(chatId.toString(), userId.toString());
        return res.json({ ok: true, message: "Warn clear!" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// Admin ID test DM — oi ID te bot পৌঁছায় কিনা check (connect verify)
app.post("/api/tg/test-dm", async (req, res) => {
    const { userId, chatId, botId, hello } = req.body;
    if (!userId) return res.status(400).json({ ok: false, error: "userId দিন" });
    let sender = pickBot(botId) || null;
    if (!sender && chatId) {
        try {
            const gd = await db.collection("tg_groups").doc(String(chatId)).get();
            if (gd.exists) sender = pickBot(gd.data().botId);
        } catch (e) {}
    }
    sender = sender || groupBot;
    const txt = hello
        ? `✅ <b>Connected!</b>\n\nEi bot ekhon tomake${chatId ? ` (<code>${chatId}</code>)` : ""} group er <b>live + gali alert</b> DM korbe. 🛡️`
        : `✅ <b>Test OK!</b> Bot tomar ID te পৌঁছাতে পারে — live + gali alert DM আসবে। 🛡️`;
    try {
        await sender.sendMessage(String(userId), txt, { parse_mode: "HTML", disable_web_page_preview: true });
        return res.json({ ok: true, message: "DM পৌঁছেছে ✅" });
    } catch (e) {
        const m = String((e && e.message) || "").toLowerCase();
        const needStart = m.includes("can't initiate") || m.includes("bot was blocked") || m.includes("user not found") || m.includes("chat not found") || m.includes("forbidden");
        return res.json({ ok: false, error: needStart ? "ওই ID bot e /start দেয়নি বা block করেছে — age /start দিতে বলো" : String((e && e.message) || e).slice(0, 160) });
    }
});

// Trigger test: keyword reply + buttons গ্রুপে পাঠিয়ে চেক করা
app.post("/api/tg/test-trigger", async (req, res) => {
    const { chatId, keyword, botId } = req.body;
    if (!chatId || !keyword) return res.status(400).json({ ok: false, error: "Group + keyword দিন" });
    const sender = pickBot(botId) || groupBot;
    try {
        const gDoc = await db.collection("tg_groups").doc(chatId.toString()).get();
        const conf = gDoc.exists ? gDoc.data() : {};
        const trig = (conf.triggers || []).find((t) => (t.keyword || "").toLowerCase().trim() === keyword.toString().toLowerCase().trim());
        if (!trig) return res.status(404).json({ ok: false, error: "Keyword পাওয়া যায়নি" });
        const built = buildTriggerMarkup(trig);
        const opts = { parse_mode: "HTML", disable_web_page_preview: true };
        if (built.markup) opts.reply_markup = built.markup;
        try {
            await sender.sendMessage(chatId.toString(), trig.reply || "Test", opts);
        } catch (e) {
            const retry = { disable_web_page_preview: true };
            if (built.markup) retry.reply_markup = built.markup;
            await sender.sendMessage(chatId.toString(), trig.reply || "Test", retry);
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
// Giveaway post builder (create + hourly refresh duijonei same design)
function giveawayJoinBtn(giveawayId, n) {
    return { inline_keyboard: [[{ text: `🎉 Join (${n})`, callback_data: `giveaway_join:${giveawayId}` }]] };
}
function giveawayEndsMs(g) {
    try {
        if (g.endsAt && g.endsAt.toMillis) return g.endsAt.toMillis();
        if (typeof g.endsAt === "number") return g.endsAt;
    } catch (e) {}
    return 0;
}
function fmtLeft(ms) {
    if (ms <= 0) return "শেষ মুহূর্তে!";
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m} মিনিট`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h} ঘণ্টা${m % 60 ? ` ${m % 60} মিনিট` : ""}`;
    return `${Math.floor(h / 24)} দিন ${h % 24} ঘণ্টা`;
}
function giveawayCaption(g, joined) {
    const wc = Math.max(1, Number(g.winnersCount || 1));
    const endMs = giveawayEndsMs(g);
    const timeLine = endMs
        ? `⏳ <b>Ends in:</b> ${fmtLeft(endMs - Date.now())} (live!)\n`
        : (Number(g.durationH) > 0 ? `⏳ <b>Ends in:</b> ${g.durationH} ঘণ্টা (auto-result!)\n` : `⏳ <b>Ends:</b> admin End চাপলে\n`);
    return `🎊 <b>${g.title}</b> 🎊\n` +
        `━━━━━━━━━━━━\n` +
        `🎁 <b>Prize:</b> ${g.amount ? g.amount + " " : ""}${g.itemName}\n` +
        (g.desc ? `📝 ${g.desc}\n` : ``) +
        `🏆 <b>Winners:</b> ${wc} জন   👥 <b>Joined:</b> ${joined}\n` +
        timeLine +
        `━━━━━━━━━━━━\n` +
        `👇 <b>Join</b> বাটনে চাপ দিয়ে অংশ নাও!`;
}

app.post("/api/tg/create-giveaway", async (req, res) => {
    const { chatId, title, itemName, amount, winnersCount, desc, photoUrl, durationH, bumpH, botId } = req.body;
    if (!chatId || !title || !itemName) return res.status(400).json({ ok: false, error: "সবগুলো তথ্য পূরণ করুন" });
    const sender = pickBot(botId) || groupBot;
    const durH = Math.max(0, Number(durationH) || 0);
    const wc = Math.max(1, Number(winnersCount || 1));
    const bmpH = Math.max(0, Math.min(168, Number(bumpH) || 0));

    try {
        let gOwner = "";
        try { const gd = await db.collection("tg_groups").doc(chatId.toString()).get(); gOwner = gd.exists ? (gd.data().ownerUid || "") : ""; } catch (e) {}
        const giveawayRef = await db.collection("giveaways").add({
            chatId: chatId.toString(),
            ownerUid: gOwner,
            botId: (botId || "default").toString(),
            title, itemName,
            amount: amount || "",
            desc: (desc || "").toString().slice(0, 500),
            photoUrl: (photoUrl || "").toString().slice(0, 500),
            durationH: durH,
            endsAt: durH > 0 ? admin.firestore.Timestamp.fromMillis(Date.now() + Math.min(durH, 168) * 3600 * 1000) : null,
            bumpH: bmpH,
            lastBumpAt: admin.firestore.Timestamp.fromMillis(Date.now()),
            winnersCount: wc,
            participants: [],
            status: "active",
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const g = { title, itemName, amount: amount || "", desc: (desc || "").toString().slice(0, 500), winnersCount: wc, durationH: durH, endsAt: durH > 0 ? Date.now() + Math.min(durH, 168) * 3600 * 1000 : 0 };
        const caption = giveawayCaption(g, 0);
        let gMsg;
        if (photoUrl) {
            gMsg = await sender.sendPhoto(chatId, photoUrl, { caption, parse_mode: "HTML", reply_markup: giveawayJoinBtn(giveawayRef.id, 0) }).catch(async () => {
                return sender.sendMessage(chatId, caption, { parse_mode: "HTML", reply_markup: giveawayJoinBtn(giveawayRef.id, 0) });
            });
        } else {
            gMsg = await sender.sendMessage(chatId, caption, { parse_mode: "HTML", reply_markup: giveawayJoinBtn(giveawayRef.id, 0) });
        }
        await sender.pinChatMessage(chatId, gMsg.message_id).catch(() => {});

        await giveawayRef.update({ messageId: gMsg.message_id });

        // Auto-end timer (server restart hole hourly loop + manual End backup)
        if (durH > 0) {
            setTimeout(() => { finishGiveaway(giveawayRef.id, sender).catch(() => {}); }, Math.min(durH, 168) * 3600 * 1000);
        }
        return res.json({ ok: true, message: "🎉 Premium giveaway পোস্ট + pin হয়েছে!" + (durH > 0 ? ` (${durH}h পর auto-result)` : ""), giveawayId: giveawayRef.id });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// Bump: purono post delete + fresh post niche (duplicate ছাড়া, pin সহ)
// Channel/group e jotoi message choluk — giveaway sobar chokher samne thake।
async function bumpGiveaway(giveawayId, sender) {
    const gDoc = await db.collection("giveaways").doc(giveawayId).get();
    if (!gDoc.exists) return false;
    const g = gDoc.data();
    if (g.status !== "active") return false;
    sender = sender || pickBot(g.botId) || groupBot;
    const joined = (g.participants || []).length;
    const cap = giveawayCaption(g, joined);
    const markup = giveawayJoinBtn(giveawayId, joined);
    let fresh;
    try {
        if (g.photoUrl) {
            fresh = await sender.sendPhoto(g.chatId, g.photoUrl, { caption: cap, parse_mode: "HTML", reply_markup: markup }).catch(async () => {
                return sender.sendMessage(g.chatId, cap, { parse_mode: "HTML", reply_markup: markup });
            });
        } else {
            fresh = await sender.sendMessage(g.chatId, cap, { parse_mode: "HTML", reply_markup: markup });
        }
    } catch (e) { return false; } // pathate na parle purono post touch korbo na
    if (!fresh || !fresh.message_id) return false;
    try { await sender.pinChatMessage(g.chatId, fresh.message_id, { disable_notification: true }); } catch (e) {}
    if (g.messageId && g.messageId !== fresh.message_id) {
        try { await sender.deleteMessage(g.chatId, g.messageId); } catch (e) {}
    }
    await gDoc.ref.update({ messageId: fresh.message_id, lastBumpAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    return true;
}
// Hourly refresh: joined count + live countdown update + silent re-pin
// (message jotoi choluk, pin-bar + fresh count e keu miss korbe na)
async function refreshGiveaway(giveawayId, sender) {
    const gDoc = await db.collection("giveaways").doc(giveawayId).get();
    if (!gDoc.exists) return false;
    const g = gDoc.data();
    if (g.status !== "active" || !g.messageId) return false;
    sender = sender || pickBot(g.botId) || groupBot;
    const joined = (g.participants || []).length;
    try {
        const markup = giveawayJoinBtn(giveawayId, joined);
        if (g.photoUrl) {
            await sender.editMessageCaption(giveawayCaption(g, joined), { chat_id: g.chatId, message_id: g.messageId, parse_mode: "HTML", reply_markup: markup });
        } else {
            await sender.editMessageText(giveawayCaption(g, joined), { chat_id: g.chatId, message_id: g.messageId, parse_mode: "HTML", reply_markup: markup, disable_web_page_preview: true });
        }
    } catch (e) {
        const m = String((e && e.message) || e).toLowerCase();
        if (m.includes("message to edit not found") || m.includes("message can't be edited") || m.includes("message to delete not found")) {
            await gDoc.ref.update({ status: "ended", note: "post deleted" }).catch(() => {});
        }
        return false;
    }
    try { await sender.pinChatMessage(g.chatId, g.messageId, { disable_notification: true }); } catch (e) {}
    return true;
}
async function refreshActiveGiveaways() {
    try {
        const snap = await db.collection("giveaways").where("status", "==", "active").limit(50).get();
        for (const d of snap.docs) {
            try {
                const g = d.data();
                const sender = pickBot(g.botId) || groupBot;
                const endMs = giveawayEndsMs(g);
                if (endMs && Date.now() > endMs) { await finishGiveaway(d.id, sender).catch(() => {}); continue; }
                // Bump due? (purono post niche fresh kore ano)
                try {
                    const bH = Math.max(0, Number(g.bumpH) || 0);
                    const lb = g.lastBumpAt && g.lastBumpAt.toMillis ? g.lastBumpAt.toMillis() : 0;
                    if (bH > 0 && Date.now() - lb > Math.min(bH, 168) * 3600 * 1000) {
                        await bumpGiveaway(d.id, sender).catch(() => {});
                        continue;
                    }
                } catch (e) {}
                await refreshGiveaway(d.id, sender);
            } catch (e) {}
            await new Promise((r) => setTimeout(r, 1500));
        }
    } catch (e) { console.error("[GW-REFRESH]", e.message); }
}
// Manual re-pin (panel theke jekono somoy)
app.post("/api/tg/repin-giveaway", async (req, res) => {
    const { giveawayId, botId } = req.body;
    try {
        const gDoc = await db.collection("giveaways").doc(giveawayId).get();
        if (!gDoc.exists) return res.status(404).json({ ok: false, error: "Giveaway not found" });
        const g = gDoc.data();
        if (g.status !== "active") return res.status(400).json({ ok: false, error: "Giveaway active nei" });
        const sender = pickBot(botId) || pickBot(g.botId) || groupBot;
        await sender.pinChatMessage(g.chatId, g.messageId, { disable_notification: true });
        await refreshGiveaway(giveawayId, sender);
        return res.json({ ok: true, message: "📌 Re-pinned + refreshed!" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// Shared finish logic — manual End + auto timer দুটোই ব্যবহার করে
async function finishGiveaway(giveawayId, sender) {
    const gDoc = await db.collection("giveaways").doc(giveawayId).get();
    if (!gDoc.exists) return { ok: false, error: "Giveaway not found" };
    const g = gDoc.data();
    if (g.status === "ended") return { ok: false, error: "ইতিমধ্যে সমাপ্ত হয়েছে" };

    const participants = g.participants || [];
    if (participants.length === 0) {
        await sender.sendMessage(g.chatId, `⚠️ <b>${g.title} সমাপ্ত:</b> কোনো অংশগ্রহণকারী পাওয়া যায়নি।`, { parse_mode: "HTML" });
        await gDoc.ref.update({ status: "ended" });
        return { ok: true, message: "No participants" };
    }

    const shuffled = participants.sort(() => 0.5 - Math.random());
    const winners = shuffled.slice(0, Math.min(g.winnersCount, participants.length));

    let winnerText = `🎊 <b>GIVEAWAY RESULT</b> 🎊\n━━━━━━━━━━━━\n\n🎉 <b>${g.title}</b>\n🎁 <b>Prize:</b> ${g.amount ? g.amount + " " : ""}${g.itemName}\n👥 <b>Joined:</b> ${participants.length} জন\n\n`;
    winners.forEach((w, idx) => {
        winnerText += `🥇 <b>Winner ${idx + 1}:</b> <a href="tg://user?id=${w.id}">${w.name}</a> (<code>${w.id}</code>)\n`;
    });
    winnerText += `\n━━━━━━━━━━━━\n🎉 অভিনন্দন! এডমিনের সাথে যোগাযোগ করে পুরস্কার নাও।`;

    await sender.sendMessage(g.chatId, winnerText, { parse_mode: "HTML" });
    await sender.unpinChatMessage(g.chatId).catch(() => {});
    await gDoc.ref.update({ status: "ended", winners });

    return { ok: true, winners };
}

app.post("/api/tg/end-giveaway", async (req, res) => {
    const { giveawayId, botId } = req.body;
    try {
        let sender = pickBot(botId) || null;
        if (!sender) {
            try {
                const gd = await db.collection("giveaways").doc(giveawayId).get();
                if (gd.exists) sender = pickBot(gd.data().botId);
            } catch (e) {}
        }
        sender = sender || groupBot;
        const out = await finishGiveaway(giveawayId, sender);
        if (!out.ok && out.error === "Giveaway not found") return res.status(404).json(out);
        if (!out.ok) return res.status(400).json(out);
        return res.json(out.winners ? { ok: true, winners: out.winners } : { ok: true, message: out.message });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 7. MODERATE API (ban/unban/mute) ----------------
app.post("/api/tg/moderate-user", async (req, res) => {
    const { action, chatId, userId, botId } = req.body;
    if (!chatId || !userId || !action) return res.status(400).json({ ok: false, error: "Missing parameters" });
    const sender = pickBot(botId) || groupBot;

    try {
        if (action === "ban") {
            await sender.banChatMember(chatId, userId);
            return res.json({ ok: true, message: "User banned!" });
        } else if (action === "unban") {
            await sender.unbanChatMember(chatId, userId, { only_if_banned: true });
            return res.json({ ok: true, message: "User unbanned!" });
        } else if (action === "mute") {
            const until = Math.floor(Date.now() / 1000) + 3600;
            await sender.restrictChatMember(chatId, userId, {
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

// ---------------- 8a2. PANEL-LINK + IN-BOT WIZARD (DM setup) ----------------
// Panel theke chat-ID connect → bot DM e /panel menu → reply/time sob ekhanei set.
const wizMap = new Map(); // tgUserId -> { step, groupId, action, data, at }
const linkCache = new Map(); // tgUserId -> { uid, at }
function wizGet(uid) {
    const w = wizMap.get(String(uid));
    if (!w) return null;
    if (Date.now() - w.at > 5 * 60 * 1000) { wizMap.delete(String(uid)); return null; }
    return w;
}
async function linkedUid(tgId) {
    const k = String(tgId);
    const c = linkCache.get(k);
    if (c && Date.now() - c.at < 10 * 60 * 1000) return c.uid;
    try {
        const q = await db.collection("vs_users").where("telegramId", "==", k).limit(1).get();
        if (!q.empty) {
            const uid = q.docs[0].id;
            linkCache.set(k, { uid, at: Date.now() });
            return uid;
        }
    } catch (e) {}
    return "";
}
async function ownedGroups(uid) {
    try {
        const s = await db.collection("tg_groups").where("ownerUid", "==", uid).limit(30).get();
        const arr = [];
        s.forEach((d) => arr.push({ id: d.id, ...(d.data() || {}) }));
        return arr;
    } catch (e) { return []; }
}
// In-bot panel field meta (toggle / number / text)
const WIZ_TOGGLES = [["antiLink", "🔗 Anti-Link"], ["antiVideo", "🎥 Anti-Video"], ["antiForward", "📤 Anti-Forward"], ["antiInbox", "📥 Anti-Inbox"], ["antiBot", "🤖 Anti-Bot"], ["antiButton", "🔘 Anti-Button"], ["fakeTitleOn", "🎭 Fake-title"], ["floodOn", "🌊 Flood"]];
const WIZ_NUMBERS = [["filterDeleteSec", "Filter warn delete (sec)", 0, 300, 4], ["warnDeleteSec", "Gali warn delete (sec)", 0, 300, 5], ["trigCooldownSec", "Trigger gap (sec)", 0, 300, 15], ["welcomeDeleteSec", "Welcome delete (sec)", 0, 300, 10], ["floodLimit", "Flood limit", 2, 50, 6], ["warnLimit", "Warn limit", 2, 20, 5]];
const WIZ_TEXTS = [["warnMsg", "Warn message"], ["floodMsg", "Flood message"], ["welcomeMsg", "Welcome text ({name})"], ["adminGaliMsg", "Admin gali reply ({name})"], ["fakeTitleMsg", "Fake-title decline ({name}/{title}/{id})"], ["scammerMsg", "Scammer alert"], ["msgs.forward", "Forward warn"], ["msgs.video", "Video warn"], ["msgs.inbox", "Inbox warn"], ["msgs.link", "Link warn"], ["msgs.button", "Button-ad warn"]];
function wizVal(g, key, def) {
    const v = g ? g[key] : undefined;
    if (typeof def === "boolean") return v === true || v === "true" || v === 1;
    if (typeof def === "number") { const n = Number(v); return isFinite(n) ? n : def; }
    return (v === undefined || v === null) ? "" : String(v);
}
function onOff(v) { return v ? "🟢 ON" : "🔴 OFF"; }
function wizNumMeta(field) { return WIZ_NUMBERS.find((x) => x[0] === field); }
function wizTextMeta(field) { return WIZ_TEXTS.find((x) => x[0] === field); }
// Callback নিরাপত্তা: linked owner + nijer group কিনা
async function wizCheck(bot, q, groupId) {
    const uid = await linkedUid(q.from.id.toString());
    if (!uid) {
        await bot.answerCallbackQuery(q.id, { text: "আগে DM e /link দিয়ে connect করো!", show_alert: true }).catch(() => {});
        return null;
    }
    let gd = null;
    try { gd = await db.collection("tg_groups").doc(String(groupId)).get(); } catch (e) {}
    if (!gd || !gd.exists || ((gd.data() || {}).ownerUid || "") !== uid) {
        await bot.answerCallbackQuery(q.id, { text: "Group পাওয়া যায়নি!", show_alert: true }).catch(() => {});
        return null;
    }
    const g = { id: gd.id, ...(gd.data() || {}) };
    groupConfigs.set(g.id, gd.data() || {});
    return { uid, g };
}
async function wizEdit(bot, q, text, buttons) {
    try {
        await bot.editMessageText(text, {
            chat_id: q.message.chat.id, message_id: q.message.message_id,
            parse_mode: "HTML", disable_web_page_preview: true,
            reply_markup: { inline_keyboard: buttons }
        });
    } catch (e) {
        await bot.sendMessage(q.message.chat.id, text, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: buttons } }).catch(() => {});
    }
    try { await bot.answerCallbackQuery(q.id); } catch (e) {}
}
async function sendGroupMenu(bot, chatId, g) {
    const t = `📋 <b>${(g.title || g.id || "").slice(0, 60)}</b>\n<code>${g.id}</code>\n\n🛡️ Link:${onOff(g.antiLink !== false)} Forward:${onOff(g.antiForward !== false)}\n🤬 Warn:${Number(g.warnLimit) || 5}→${g.warnAction || "ban"} ⏱️ Gap:${g.trigCooldownSec !== undefined ? g.trigCooldownSec : 15}s\n⚡ Triggers:${(g.triggers || []).length} 🎉 Welcome:${g.welcomeMode || "global"}\n\nSetting বদলাতে tap করো:`;
    await bot.sendMessage(chatId, t, {
        parse_mode: "HTML", disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [
            [{ text: "🛡️ Filters", callback_data: `wp_f:${g.id}` }, { text: "⏱️ Timers", callback_data: `wp_n:${g.id}` }],
            [{ text: "💬 Replies", callback_data: `wp_r:${g.id}` }, { text: "🎉 Welcome", callback_data: `wp_w:${g.id}` }],
            [{ text: "⚡ Add reply", callback_data: `wp_trig:${g.id}` }, { text: "🗑 Triggers", callback_data: `wp_tl:${g.id}` }],
            [{ text: "📊 Info", callback_data: `wp_i:${g.id}` }, { text: "🔙 Groups", callback_data: `wp_back` }]
        ]}
    }).catch(() => {});
}
async function wizCallback(bot, q) {
    const data = q.data || "";
    const parts = data.split(":");
    const kind = parts[0];
    const ack = async (t) => { try { await bot.answerCallbackQuery(q.id, t ? { text: t } : {}); } catch (e) {} };
    if (kind === "wp_back") {
        const uid = await linkedUid(q.from.id.toString());
        if (!uid) { await ack("আগে /link!"); return; }
        const gs = await ownedGroups(uid);
        await wizEdit(bot, q, `🏠 <b>তোমার Groups</b>:`, gs.slice(0, 20).map((g) => ([{ text: `📋 ${(g.title || g.id).slice(0, 40)}`, callback_data: `wp_g:${g.id}` }])));
        return;
    }
    const gid = parts[1];
    if (kind === "wp_g") {
        const c = await wizCheck(bot, q, gid);
        if (!c) return;
        await sendGroupMenu(bot, q.message.chat.id, c.g);
        await ack();
        return;
    }
    if (kind === "wp_f") {
        const c = await wizCheck(bot, q, gid);
        if (!c) return;
        await wizEdit(bot, q, `🛡️ <b>Filters</b> — tap = ON/OFF:`, [
            ...WIZ_TOGGLES.map(([f, label]) => ([{ text: `${label} ${onOff(wizVal(c.g, f, f !== "antiVideo"))}`, callback_data: `wp_tgl:${gid}:${f}` }])),
            [{ text: "🔙 Menu", callback_data: `wp_g:${gid}` }]
        ]);
        return;
    }
    if (kind === "wp_tgl") {
        const field = parts[2];
        if (!WIZ_TOGGLES.some(([f]) => f === field)) { await ack("Unknown!"); return; }
        const c = await wizCheck(bot, q, gid);
        if (!c) return;
        const cur = wizVal(c.g, field, field !== "antiVideo");
        try { await db.collection("tg_groups").doc(String(gid)).set({ [field]: !cur }, { merge: true }); } catch (e) {}
        groupConfigs.delete(String(gid));
        try {
            const gd = await db.collection("tg_groups").doc(String(gid)).get();
            const g2 = { id: gd.id, ...(gd.exists ? gd.data() : {}) };
            groupConfigs.set(g2.id, gd.exists ? gd.data() : {});
            await wizEdit(bot, q, `🛡️ <b>Filters</b> — tap = ON/OFF:`, [
                ...WIZ_TOGGLES.map(([f, label]) => ([{ text: `${label} ${onOff(wizVal(g2, f, f !== "antiVideo"))}`, callback_data: `wp_tgl:${gid}:${f}` }])),
                [{ text: "🔙 Menu", callback_data: `wp_g:${gid}` }]
            ]);
        } catch (e) { await ack("Saved ✅"); }
        return;
    }
    if (kind === "wp_n") {
        const c = await wizCheck(bot, q, gid);
        if (!c) return;
        await wizEdit(bot, q, `⏱️ <b>Timers</b> (sec) — tap করে নতুন মান পাঠাও:`, [
            ...WIZ_NUMBERS.map(([f, label]) => ([{ text: `${label}: ${wizVal(c.g, f, 0)}`, callback_data: `wp_ask:${gid}:${f}` }])),
            [{ text: "🔙 Menu", callback_data: `wp_g:${gid}` }]
        ]);
        return;
    }
    if (kind === "wp_r") {
        const c = await wizCheck(bot, q, gid);
        if (!c) return;
        const ms = c.g.msgs || {};
        const prev = (k) => { const v = k.startsWith("msgs.") ? (ms[k.slice(5)] || "") : (c.g[k] || ""); return String(v).slice(0, 24) || "—"; };
        await wizEdit(bot, q, `💬 <b>Replies</b> — tap করে নতুন লেখা পাঠাও:`, [
            ...WIZ_TEXTS.map(([f, label]) => ([{ text: `${label}: ${prev(f)}`, callback_data: `wp_ask:${gid}:${f}` }])),
            [{ text: "🔙 Menu", callback_data: `wp_g:${gid}` }]
        ]);
        return;
    }
    if (kind === "wp_w") {
        const c = await wizCheck(bot, q, gid);
        if (!c) return;
        await wizEdit(bot, q, `🎉 <b>Welcome</b> — mode: <b>${c.g.welcomeMode || "global"}</b>:`, [
            [{ text: "🔁 Mode বদলাও", callback_data: `wp_wc:${gid}` }],
            [{ text: "✏️ Text set করো", callback_data: `wp_ask:${gid}:welcomeMsg` }],
            [{ text: "⏱️ Delete sec", callback_data: `wp_ask:${gid}:welcomeDeleteSec` }],
            [{ text: "🔙 Menu", callback_data: `wp_g:${gid}` }]
        ]);
        return;
    }
    if (kind === "wp_wc") {
        const c = await wizCheck(bot, q, gid);
        if (!c) return;
        const order = ["global", "custom", "off"];
        const nx = order[(order.indexOf(c.g.welcomeMode || "global") + 1) % order.length];
        try { await db.collection("tg_groups").doc(String(gid)).set({ welcomeMode: nx }, { merge: true }); } catch (e) {}
        groupConfigs.delete(String(gid));
        await ack(`Mode: ${nx}`);
        const c2 = await wizCheck(bot, q, gid);
        if (c2) {
            await wizEdit(bot, q, `🎉 <b>Welcome</b> — mode: <b>${c2.g.welcomeMode || "global"}</b>:`, [
                [{ text: "🔁 Mode বদলাও", callback_data: `wp_wc:${gid}` }],
                [{ text: "✏️ Text set করো", callback_data: `wp_ask:${gid}:welcomeMsg` }],
                [{ text: "⏱️ Delete sec", callback_data: `wp_ask:${gid}:welcomeDeleteSec` }],
                [{ text: "🔙 Menu", callback_data: `wp_g:${gid}` }]
            ]);
        }
        return;
    }
    if (kind === "wp_ask") {
        const field = parts.slice(2).join(":");
        if (!wizNumMeta(field) && !wizTextMeta(field)) { await ack("Unknown!"); return; }
        const c = await wizCheck(bot, q, gid);
        if (!c) return;
        const meta = wizNumMeta(field);
        const label = meta ? `${meta[1]} (${meta[2]}–${meta[3]})` : (wizTextMeta(field) || [])[1] || field;
        wizMap.set(q.from.id.toString(), { step: "value", groupId: String(gid), action: "set", field, at: Date.now() });
        await ack();
        await bot.sendMessage(q.message.chat.id, `✍️ <b>${label}</b> পাঠাও:\n(বাতিল: /cancel)`, { parse_mode: "HTML" }).catch(() => {});
        return;
    }
    if (kind === "wp_trig") {
        const c = await wizCheck(bot, q, gid);
        if (!c) return;
        wizMap.set(q.from.id.toString(), { step: "kw", groupId: String(gid), action: "trig", data: {}, at: Date.now() });
        await ack();
        await bot.sendMessage(q.message.chat.id, `⚡ <b>নতুন auto-reply</b>\n\n1️⃣ Keyword পাঠাও (user যা লিখবে):\n(বাতিল: /cancel)`, { parse_mode: "HTML" }).catch(() => {});
        return;
    }
    if (kind === "wp_tl") {
        const c = await wizCheck(bot, q, gid);
        if (!c) return;
        const arr = c.g.triggers || [];
        await wizEdit(bot, q, `🗑 <b>Triggers</b> (${arr.length}) — ❌ = delete:`, [
            ...arr.slice(0, 15).map((t, i) => ([{ text: `❌ ${(t.keyword || "?").slice(0, 30)}`, callback_data: `wp_del:${gid}:${i}` }])),
            [{ text: "🔙 Menu", callback_data: `wp_g:${gid}` }]
        ]);
        return;
    }
    if (kind === "wp_del") {
        const idx = Number(parts[2]);
        const c = await wizCheck(bot, q, gid);
        if (!c || !isFinite(idx)) return;
        const arr = (c.g.triggers || []).slice();
        arr.splice(idx, 1);
        try { await db.collection("tg_groups").doc(String(gid)).update({ triggers: arr }); } catch (e) {}
        groupConfigs.delete(String(gid));
        await ack("Deleted ✅");
        const c2 = await wizCheck(bot, q, gid);
        if (c2) {
            const a2 = c2.g.triggers || [];
            await wizEdit(bot, q, `🗑 <b>Triggers</b> (${a2.length}):`, [
                ...a2.slice(0, 15).map((t, i) => ([{ text: `❌ ${(t.keyword || "?").slice(0, 30)}`, callback_data: `wp_del:${gid}:${i}` }])),
                [{ text: "🔙 Menu", callback_data: `wp_g:${gid}` }]
            ]);
        }
        return;
    }
    if (kind === "wp_i") {
        const c = await wizCheck(bot, q, gid);
        if (!c) return;
        let wn = 0, mn = 0;
        try { const s = await db.collection("tg_warns").where("chatId", "==", String(gid)).limit(100).get(); wn = s.size; } catch (e) {}
        try { const s = await db.collection("tg_members").where("chatId", "==", String(gid)).limit(200).get(); mn = s.size; } catch (e) {}
        await wizEdit(bot, q, `📊 <b>${(c.g.title || "").slice(0, 50)}</b>\n<code>${gid}</code>\n\n👥 Members: <b>${mn}</b>\n⚠️ Warns: <b>${wn}</b>\n⚡Triggers: <b>${(c.g.triggers || []).length}</b>\n🤖 Bot: <b>${c.g.botUsername || "shared"}</b>`, [
            [{ text: "🔙 Menu", callback_data: `wp_g:${gid}` }]
        ]);
        return;
    }
    await ack();
}
async function wizTextStep(bot, fromUser, w, text) {
    const uid = fromUser.id.toString();
    const clean = (text || "").trim();
    if (w.action === "set") {
        const numMeta = wizNumMeta(w.field);
        const txtMeta = wizTextMeta(w.field);
        if (!numMeta && !txtMeta) { wizMap.delete(uid); return; }
        const gd = await db.collection("tg_groups").doc(String(w.groupId)).get().catch(() => null);
        if (!gd || !gd.exists || ((gd.data() || {}).ownerUid || "") !== (await linkedUid(uid))) {
            wizMap.delete(uid);
            await bot.sendMessage(uid, `❌ Group পাওয়া যায়নি!`, { parse_mode: "HTML" }).catch(() => {});
            return;
        }
        const payload = {};
        if (numMeta) {
            const n = Math.floor(Number(clean.replace(/[^0-9]/g, "")));
            if (!isFinite(n)) {
                await bot.sendMessage(uid, `❌ সংখ্যা দাও! (বাতিল: /cancel)`, { parse_mode: "HTML" }).catch(() => {});
                return;
            }
            payload[w.field] = Math.min(numMeta[3], Math.max(numMeta[2], n));
        } else {
            if (!clean) {
                await bot.sendMessage(uid, `❌ খালি লেখা! (বাতিল: /cancel)`, { parse_mode: "HTML" }).catch(() => {});
                return;
            }
            if (w.field.startsWith("msgs.")) {
                const cur = (gd.data() || {}).msgs || {};
                cur[w.field.slice(5)] = clean.slice(0, 500);
                payload.msgs = cur;
            } else {
                payload[w.field] = clean.slice(0, 1000);
                if (w.field === "welcomeMsg") payload.welcomeMode = "custom";
            }
        }
        try { await db.collection("tg_groups").doc(String(w.groupId)).set(payload, { merge: true }); } catch (e) {}
        groupConfigs.delete(String(w.groupId));
        wizMap.delete(uid);
        await bot.sendMessage(uid, `✅ <b>Saved!</b> Bot ekhuni notun setting e cholbe।\n\n<code>/panel</code> — menu`, { parse_mode: "HTML" }).catch(() => {});
        return;
    }
    if (w.action === "trig") {
        if (w.step === "kw") {
            if (!clean || clean.length > 60) {
                await bot.sendMessage(uid, `❌ 1-60 অক্ষরের keyword দাও! (বাতিল: /cancel)`, { parse_mode: "HTML" }).catch(() => {});
                return;
            }
            w.data.kw = clean; w.step = "reply"; w.at = Date.now();
            wizMap.set(uid, w);
            await bot.sendMessage(uid, `2️⃣ Reply message পাঠাও (user কী দেখবে):\n(বাতিল: /cancel)`, { parse_mode: "HTML" }).catch(() => {});
            return;
        }
        if (w.step === "reply") {
            if (!clean) {
                await bot.sendMessage(uid, `❌ খালি reply! (বাতিল: /cancel)`, { parse_mode: "HTML" }).catch(() => {});
                return;
            }
            w.data.reply = clean.slice(0, 1000); w.step = "del"; w.at = Date.now();
            wizMap.set(uid, w);
            await bot.sendMessage(uid, `3️⃣ Reply কত sec পর delete হবে? সংখ্যা পাঠাও — <b>0 = thakbe</b>:\n(বাতিল: /cancel)`, { parse_mode: "HTML" }).catch(() => {});
            return;
        }
        if (w.step === "del") {
            const n = Math.floor(Number(clean.replace(/[^0-9]/g, "")));
            if (!isFinite(n) || n < 0 || n > 300) {
                await bot.sendMessage(uid, `❌ 0-300 সংখ্যা দাও! (বাতিল: /cancel)`, { parse_mode: "HTML" }).catch(() => {});
                return;
            }
            const gd = await db.collection("tg_groups").doc(String(w.groupId)).get().catch(() => null);
            if (!gd || !gd.exists || ((gd.data() || {}).ownerUid || "") !== (await linkedUid(uid))) {
                wizMap.delete(uid);
                await bot.sendMessage(uid, `❌ Group পাওয়া যায়নি!`, { parse_mode: "HTML" }).catch(() => {});
                return;
            }
            const arr = ((gd.data() || {}).triggers || []).slice();
            arr.push({ keyword: w.data.kw, reply: w.data.reply, deleteSec: n });
            try { await db.collection("tg_groups").doc(String(w.groupId)).update({ triggers: arr }); } catch (e) {}
            groupConfigs.delete(String(w.groupId));
            wizMap.delete(uid);
            await bot.sendMessage(uid, `✅ <b>Trigger saved!</b>\n🔑 <code>${w.data.kw}</code> → reply + ${n}s delete\n\n<code>/panel</code> — menu`, { parse_mode: "HTML" }).catch(() => {});
            return;
        }
    }
    wizMap.delete(uid);
}

// ---------------- 8b. PER-GROUP CONFIG DEFAULTS (panel theke sob customize) ----------------
// Purono group e notun field na thakleo default diye cholbe — backward compatible.
const CFG_DEFAULTS = {
    filterDeleteSec: 4,   // link/forward/video/inbox/flood warn koto sec por auto-delete
    warnDeleteSec: 5,     // gali warn koto sec por auto-delete
    floodOn: true, floodLimit: 6, floodWindowSec: 10, floodMuteCount: 10, floodMuteMin: 10,
    floodMsg: "এত দ্রুত মেসেজ পাঠাবেন না! (Flood control)",
    scammerAlertOn: true, scammerMsg: "",
    nameTrackOn: true, leaveLogOn: true, liveNotifyOn: true, galiDmOn: true,
    notifyAdmins: [], adminGaliMsg: "",
    welcomeMode: "global", welcomeMsg: "", welcomeImg: "", welcomeDeleteSec: 10,
    trigCooldownSec: 15
};
function cfgNum(conf, key, def, min, max) {
    const v = Number(conf ? conf[key] : undefined);
    if (!isFinite(v)) return def;
    return Math.min(max, Math.max(min, Math.floor(v)));
}
function cfgBool(conf, key, def) {
    if (!conf || typeof conf[key] === "undefined" || conf[key] === null) return def;
    return conf[key] === true || conf[key] === "true" || conf[key] === 1;
}
function cfgStr(conf, key, def) {
    const v = conf && conf[key] !== undefined && conf[key] !== null ? String(conf[key]) : "";
    return v !== "" ? v : def;
}
function filterDeleteSec(conf) { return cfgNum(conf, "filterDeleteSec", CFG_DEFAULTS.filterDeleteSec, 0, 300); }
function warnDeleteSec(conf) { return cfgNum(conf, "warnDeleteSec", CFG_DEFAULTS.warnDeleteSec, 0, 300); }
function autoDel(chatId, messageId, sec) {
    if (!sec || sec <= 0 || !messageId) return;
    setTimeout(() => groupBot.deleteMessage(chatId, messageId).catch(() => {}), sec * 1000);
}
// Default scammer alert (Bangla + English) — panel theke scammerMsg dile oita cholbe
function buildScammerAlert(conf, name, userId) {
    const custom = conf && conf.scammerMsg ? String(conf.scammerMsg).trim() : "";
    const safeName = name || userId;
    if (custom) {
        return custom.split("{name}").join(safeName).split("{id}").join(String(userId));
    }
    return `🚨 <b>SCAMMER ALERT!</b>\n\n` +
        `⚠️ <a href="tg://user?id=${userId}">${safeName}</a> (<code>${userId}</code>) <b>একজন প্রমাণিত প্রতারক / স্ক্যামার!</b>\n` +
        `❌ এই ইউজারের সাথে কেউ কোনো প্রকার লেনদেন করবেন না!\n\n` +
        `<i>⚠️ This user is a proven scammer. Do NOT deal with them!</i>`;
}
// Name-change alert — always English (auto, fixed format)
function buildNameChangeAlert(name, userId, oldName, oldUsername, newUsername) {
    return `🔄 <b>Profile Updated</b>\n\n` +
        `👤 <b>User:</b> <a href="tg://user?id=${userId}">${name}</a> (<code>${userId}</code>)\n` +
        `📝 <b>Old name:</b> <code>${oldName || "-"}</code> ➔ <b>New:</b> <code>${name}</code>\n` +
        `🔖 <b>Old username:</b> <code>${oldUsername || "-"}</code> ➔ <b>New:</b> <code>${newUsername}</code>`;
}
// Member directory: join kora sob user er chat id collect (admin pore bot diye message dite parbe)
async function trackMember(chatId, userId, name, username, ownerUid) {
    if (!userId || String(userId) === String(chatId)) return;
    try {
        await db.collection("tg_members").doc(`${chatId}_${userId}`).set({
            chatId: String(chatId), userId: String(userId),
            name: name || "", username: username || "",
            ownerUid: ownerUid || "",
            msgCount: admin.firestore.FieldValue.increment(1),
            lastSeen: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (e) {}
}

// Trigger multi-button builder — GLOBAL (live reply + test API duijoneri lage)
function cleanTriggerUrl(raw) {
    if (!raw) return "";
    let u = raw.toString().trim();
    if (!u) return "";
    if (u.startsWith("@")) u = "https://t.me/" + u.slice(1);
    u = u.replace(/t\.me\/@/g, "t.me/");
    if (!/^https?:\/\//i.test(u)) {
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

// ---------------- 8c. MULTI-BOT FACTORY ----------------
// Prottek bot (default shared + popup diye user-connected) eki protection engine pay.
// BOTMETA = { id, username, ownerUid }. User bot hole tar group auto owner-link hoy (claim lage na).
function createProtector(groupBot, BOTMETA) {
const BOT_ID = (BOTMETA && BOTMETA.id) || "default";
const BOT_UN = (BOTMETA && BOTMETA.username) || "";
const BOT_OWNER = (BOTMETA && BOTMETA.ownerUid) || "";

// Rights-error detector + visible admin hint (silent fail আর না —
// bot Admin/permission ছাড়া add হলে group এই বলে দেবে, 6 ঘণ্টায় ১ বার)।
const rightsHintAt = new Map();
function isRightsError(e) {
    const m = String((e && e.message) || e || "").toLowerCase();
    if (m.includes("message to delete not found") || m.includes("message can't be deleted")) return false;
    return /not enough rights|need administrator|not an administrator|bot is not|have to be administrator|was kicked|was blocked|forbidden/.test(m);
}
async function hintNoRights(chatId, e) {
    if (!isRightsError(e)) return;
    try {
        const now = Date.now();
        if (now - (rightsHintAt.get(String(chatId)) || 0) < 6 * 60 * 60 * 1000) return;
        rightsHintAt.set(String(chatId), now);
        if (rightsHintAt.size > 500) rightsHintAt.clear();
        console.error("[RIGHTS] bot needs admin in", chatId, "-", String((e && e.message) || e).slice(0, 120));
        await groupBot.sendMessage(chatId,
            `⚠️ <b>VS Protection কাজ করতে পারছে না!</b>\n\nআমাকে group এ <b>Admin</b> বানাও আর এই permission গুলো দাও:\n✅ Delete messages\n✅ Ban users\n✅ Pin messages\n\nতারপর আবার test করো (normal member ID দিয়ে — admin দের bot ধরে না)।`,
            { parse_mode: "HTML" }).catch(() => {});
    } catch (e2) {}
}
async function delMsg(chatId, msgId) {
    try { await groupBot.deleteMessage(chatId, msgId); }
    catch (e) { hintNoRights(chatId, e); }
}
// Factory-local autoDel — closure bot দিয়ে delete (global টা default bot ব্যবহার করে)
function autoDel(chatId, messageId, sec) {
    if (!sec || sec <= 0 || !messageId) return;
    setTimeout(() => groupBot.deleteMessage(chatId, messageId).catch(() => {}), sec * 1000);
}
// Admin DM list (live/gali alert যাবে) + throttle map
const notifySeen = new Map();
async function getNotifyAdmins(chatId, conf) {
    let lst = Array.isArray(conf && conf.notifyAdmins) ? conf.notifyAdmins.map((x) => String(x)) : [];
    if (!lst.length) {
        try {
            const gd = await db.collection("tg_groups").doc(String(chatId)).get();
            if (gd.exists) lst = ((gd.data() || {}).notifyAdmins || []).map((x) => String(x));
        } catch (e) {}
    }
    return [...new Set(lst)].filter((x) => /^\d{5,}$/.test(x)).slice(0, 5);
}
async function dmAdmins(chatId, conf, html) {
    try {
        const lst = await getNotifyAdmins(chatId, conf);
        for (const aid of lst) {
            try { await groupBot.sendMessage(aid, html, { parse_mode: "HTML", disable_web_page_preview: true }); }
            catch (e) {
                try { await groupBot.sendMessage(aid, html.replace(/<[^>]*>/g, ""), { disable_web_page_preview: true }); } catch (e2) {}
            }
        }
    } catch (e) {}
}
function cleanName(s) { return String(s || "").replace(/[<>&]/g, "").slice(0, 60) || "Member"; }

// গ্রুপে বট অ্যাড হলেই স্বয়ংক্রিয় রেজিস্টার (default protection ON)
groupBot.on("my_chat_member", async (msg) => {
    try {
        const chat = msg.chat;
        if (!chat) return;
        const ctype = chat.type || "";
        if (ctype !== "group" && ctype !== "supergroup" && ctype !== "channel") return;
        const newStatus = msg.new_chat_member ? msg.new_chat_member.status : "";
        groupAdminCache.delete(chat.id.toString());
        try { linkedCache.delete(chat.id.toString()); } catch (e) {}

        if (newStatus === "administrator" || newStatus === "member") {
            const reg = {
                id: chat.id.toString(),
                title: chat.title || "Channel/Group",
                chatType: ctype,
                username: chat.username ? `@${chat.username}` : "Private",
                botId: BOT_ID,
                botUsername: BOT_UN,
                antiLink: true,
                antiVideo: false,
                antiForward: true,
                antiInbox: true,
                antiBot: true,
                antiButton: true,
                fakeTitleOn: true,
                useDefaultTitles: true,
                customTitles: [],
                fakeTitleMsg: "",
                fakeTitleDeleteSec: 0,
                fakeTitleDelete: true,
                useDefaultBadWords: true,
                customBadWords: [],
                filterDeleteSec: 4,
                warnDeleteSec: 5,
                floodOn: true, floodLimit: 6, floodWindowSec: 10, floodMuteCount: 10, floodMuteMin: 10,
                scammerAlertOn: true, nameTrackOn: true, leaveLogOn: true,
                liveNotifyOn: true, galiDmOn: true, notifyAdmins: [], adminGaliMsg: "",
                welcomeMode: "global", welcomeDeleteSec: 10, trigCooldownSec: 15,
                lastActive: admin.firestore.FieldValue.serverTimestamp()
            };
            // user-bot auto-link: shudhu owner khali thakle (onno karor claimed group chhiniye nebe na)
            if (BOT_OWNER) {
                try {
                    const ex = await db.collection("tg_groups").doc(chat.id.toString()).get();
                    if (!ex.exists || !(ex.data() || {}).ownerUid) {
                        reg.ownerUid = BOT_OWNER;
                        reg.claimedAt = admin.firestore.FieldValue.serverTimestamp();
                        reg.autoLinked = true;
                    }
                } catch (e) {}
            }
            await db.collection("tg_groups").doc(chat.id.toString()).set(reg, { merge: true });
            console.log("[VS] New group registered:", chat.title, chat.id.toString(), "via", BOT_ID);
            // Group e visible proof — bot jibito + ki korte hobe
            if (ctype === "group" || ctype === "supergroup") {
                const isAdminNow = (newStatus === "administrator");
                try {
                    await groupBot.sendMessage(chat.id.toString(),
                        isAdminNow
                            ? (BOT_OWNER
                                ? `✅ <b>VS Protection চালু!</b>\n\n🆔 Group ID: <code>${chat.id}</code>\n\n🎉 এই bot তোমার panel এর সাথে <b>auto-connected!</b> Dashboard → My Bots → এই bot এ tap করলেই group পাবে।`
                                : `✅ <b>VS Protection চালু!</b>\n\n🆔 Group ID: <code>${chat.id}</code>\n\n🔑 Panel er <b>Claim Code</b> copy kore ekhane likhun:\n<code>/claim CODE</code>\n\n⚠️ Protection puropuri kaj korbe jokhon ami <b>Admin</b> (Delete + Ban + Pin permission soho).`)
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
        const reg = {
            id: chatId,
            title: msg.chat.title || "Channel",
            chatType: "channel",
            username: msg.chat.username ? `@${msg.chat.username}` : "Private",
            botId: BOT_ID,
            botUsername: BOT_UN,
            lastActive: admin.firestore.FieldValue.serverTimestamp()
        };
        await db.collection("tg_groups").doc(chatId).set(reg, { merge: true });
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
        if (!fromUser) return;
        const isBotSender = fromUser.is_bot && !isAnonymousAdmin;

        const userId = isAnonymousAdmin ? chatId : fromUser.id.toString();
        const currentName = isAnonymousAdmin ? (msg.chat.title || "Admin") : `${fromUser.first_name || ""} ${fromUser.last_name || ""}`.trim();
        const currentUsername = isAnonymousAdmin ? `@${msg.chat.username || "anonymous"}` : (fromUser.username ? `@${fromUser.username}` : "None");
        const text = (msg.text || msg.caption || "").trim();

        // ১. ইনস্ট্যান্ট কাস্টম অটো-রিপ্লাই (keyword match + cooldown)
        // NOTE: cooldown = একই user একই keyword এ কত sec পর পর reply পাবে (0 = সবসময়)।
        let groupConf = groupConfigs.get(chatId);
        if (!groupConf) {
            const gDoc = await db.collection("tg_groups").doc(chatId).get();
            groupConf = gDoc.exists ? gDoc.data() : {};
            if (gDoc.exists) groupConfigs.set(chatId, groupConf);
        }

        // Bot sender (auto-join ad-bot সহ): antiBot ON থাকলে delete, sonst skip.
        // Bot দের trigger/tracker/command কিছুই চলে না (loop protection)।
        // sender_chat (linked-channel post) কে ছোঁয়া হবে না।
        if (isBotSender && !msg.sender_chat) {
            if (groupConf.antiBot !== false) await delMsg(chatId, msgId);
            return;
        }

        // 🔴 LIVE event (voice-chat/live-stream শুরু): group e কিছু post হবে না,
        // শুধু admin দের DM যাবে (liveNotifyOn + notifyAdmins)।
        if (isGroup && (msg.video_chat_started || msg.video_chat_scheduled)) {
            try {
                if (cfgBool(groupConf, "liveNotifyOn", true)) {
                    const starter = (fromUser && !fromUser.is_bot)
                        ? cleanName(`${fromUser.first_name || ""} ${fromUser.last_name || ""}`.trim()) +
                          (fromUser.username ? ` (@${fromUser.username})` : ` (<code>${fromUser.id}</code>)`)
                        : "Someone";
                    await dmAdmins(chatId, groupConf,
                        `🔴 <b>LIVE cholche!</b>\n\n👤 ${starter}\n📍 <b>${cleanName(msg.chat.title)}</b> (<code>${chatId}</code>)\n\nGroup call button e chap diye join koro.`);
                }
            } catch (e) {}
            return;
        }

        if (groupConf && groupConf.triggers && groupConf.triggers.length > 0 && text) {
            const cleanUserText = text.toLowerCase().trim();
            const trigCoolSec = cfgNum(groupConf, "trigCooldownSec", 15, 0, 300);
            for (const trig of groupConf.triggers) {
                const kw = (trig.keyword || "").toLowerCase().trim();
                if (kw && (cleanUserText.includes(kw) || cleanUserText === kw)) {
                    const ck = chatId + ":" + userId + ":" + kw;
                    if (trigCoolSec > 0 && Date.now() - (trigCool.get(ck) || 0) < trigCoolSec * 1000) continue;
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

                    groupBot.sendMessage(chatId, trig.reply, sendOpts).then((sent) => {
                        try {
                            const tdel = cfgNum(trig, "deleteSec", 0, 0, 300);
                            if (sent && sent.message_id && tdel > 0) autoDel(chatId, sent.message_id, tdel);
                        } catch (e) {}
                    }).catch((err) => {
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

        // প্রাইভেটে /start,/help,/id,/link,/panel — bot DM setup
        if (!isGroup) {
            if (isCommand(text, "/start") || isCommand(text, "/help")) {
                await groupBot.sendMessage(chatId,
                    `👋 <b>VS Protection Bot</b>\n\n✅ Bot <b>চালু আছে!</b>\n\n<b>Group e lagaben:</b>\n1️⃣ আমাকে group e add করুন\n2️⃣ <b>Admin</b> বানান (Delete + Ban + Pin)\n3️⃣ Panel er Claim Code দিয়ে group e লিখুন:\n<code>/claim CODE</code>\n\n<b>Panel ছাড়াই setup:</b>\n1️⃣ Panel → 🔗 Telegram Link থেকে CODE নিন\n2️⃣ এখানে পাঠান: <code>/link CODE</code>\n3️⃣ তারপর <code>/panel</code> — full menu bot-এর ভেতরেই!\n\n❓ /id — nijer ID dekhun`,
                    { parse_mode: "HTML" }).catch(() => {});
                return;
            }
            if (isCommand(text, "/id")) {
                await groupBot.sendMessage(chatId, `🆔 Your ID: <code>${fromUser.id}</code>`, { parse_mode: "HTML" }).catch(() => {});
                return;
            }
            if (isCommand(text, "/link")) {
                const code = (text.replace(/^\/link(@[A-Za-z0-9_]+)?/i, "").trim().toUpperCase().replace(/[^A-Z0-9]/g, ""));
                if (!code) {
                    await groupBot.sendMessage(chatId, `💡 <b>ব্যবহার:</b> <code>/link CODE</code>\nCODE পাবে Panel → 🔗 Telegram Link card e।`, { parse_mode: "HTML" }).catch(() => {});
                    return;
                }
                try {
                    const q = await db.collection("vs_users").where("tgLinkCode", "==", code).limit(1).get();
                    if (q.empty) {
                        await groupBot.sendMessage(chatId, `❌ ভুল CODE! Panel থেকে নতুন CODE নিয়ে আবার দাও।`, { parse_mode: "HTML" }).catch(() => {});
                        return;
                    }
                    await q.docs[0].ref.update({ telegramId: fromUser.id.toString(), tgLinkCode: "" });
                    linkCache.delete(fromUser.id.toString());
                    await groupBot.sendMessage(chatId, `✅ <b>Connected!</b> এখন <code>/panel</code> লিখো — তোমার groups + full setting menu আসবে।`, { parse_mode: "HTML" }).catch(() => {});
                } catch (e) {
                    await groupBot.sendMessage(chatId, `❌ Link failed, pore abar try koro।`, { parse_mode: "HTML" }).catch(() => {});
                }
                return;
            }
            if (isCommand(text, "/unlink")) {
                try {
                    const q = await db.collection("vs_users").where("telegramId", "==", fromUser.id.toString()).limit(1).get();
                    if (!q.empty) await q.docs[0].ref.update({ telegramId: "" });
                    linkCache.delete(fromUser.id.toString());
                } catch (e) {}
                await groupBot.sendMessage(chatId, `✅ Unlinked!`, { parse_mode: "HTML" }).catch(() => {});
                return;
            }
            if (isCommand(text, "/cancel")) {
                wizMap.delete(fromUser.id.toString());
                await groupBot.sendMessage(chatId, `🚫 Cancelled! <code>/panel</code> দিয়ে আবার শুরু করো।`, { parse_mode: "HTML" }).catch(() => {});
                return;
            }
            if (isCommand(text, "/panel")) {
                const uid = await linkedUid(fromUser.id.toString());
                if (!uid) {
                    await groupBot.sendMessage(chatId, `🔗 <b>আগে connect করো!</b>\n\n1️⃣ Panel → 🔗 Telegram Link → CODE copy\n2️⃣ এখানে পাঠাও: <code>/link CODE</code>\n3️⃣ তারপর <code>/panel</code>`, { parse_mode: "HTML" }).catch(() => {});
                    return;
                }
                const gs = await ownedGroups(uid);
                if (!gs.length) {
                    await groupBot.sendMessage(chatId, `📭 এখনো group link নেই!\n\nBot কে group e add + <b>Admin</b> বানাও (নিজের bot হলে auto-link, shared bot হলে <code>/claim CODE</code>) — তারপর <code>/panel</code>।`, { parse_mode: "HTML" }).catch(() => {});
                    return;
                }
                await groupBot.sendMessage(chatId, `🏠 <b>তোমার Groups</b> — setting করতে tap করো:`, {
                    parse_mode: "HTML",
                    reply_markup: { inline_keyboard: gs.slice(0, 20).map((g) => ([{ text: `📋 ${(g.title || g.id).slice(0, 40)}`, callback_data: `wp_g:${g.id}` }])) }
                }).catch(() => {});
                return;
            }
            // Wizard text step (trigger add / number / text value)
            const w0 = wizGet(fromUser.id.toString());
            if (w0) {
                await wizTextStep(groupBot, fromUser, w0, text);
                return;
            }
            return;
        }

        // গ্রুপ ডাটাবেজে অটো-সিঙ্ক (ownerUid touch kori na — nahole onner claimed group chhiniye nebe)
        const syncDoc = {
            id: chatId,
            title: msg.chat.title || "Group",
            username: msg.chat.username ? `@${msg.chat.username}` : "Private",
            botId: BOT_ID,
            botUsername: BOT_UN,
            lastActive: admin.firestore.FieldValue.serverTimestamp()
        };
        db.collection("tg_groups").doc(chatId).set(syncDoc, { merge: true }).catch(() => {});

        // Member directory: sob sender er chat id collect (panel Send box er jonno)
        trackMember(chatId, fromUser.id.toString(), currentName, currentUsername, groupConf.ownerUid || "").catch(() => {});

        // Leave log (customize: leaveLogOn)
        if (msg.left_chat_member) {
            try {
                const lv = msg.left_chat_member;
                if (!lv.is_bot && cfgBool(groupConf, "leaveLogOn", true)) {
                    const lvName = `${lv.first_name || ""} ${lv.last_name || ""}`.trim() || "A member";
                    await groupBot.sendMessage(chatId, `👋 <b>${lvName}</b> left the group.`, { parse_mode: "HTML" }).catch(() => {});
                }
            } catch (e) {}
            return;
        }

        const isAdmin = await isGroupAdmin(chatId, fromUser, msg);

        // Admin ID auto-collect (live/gali DM যাবে) — 24h te 1 bar write + hello DM
        if (isAdmin && fromUser && !isAnonymousAdmin && !fromUser.is_bot) {
            try {
                const nk = chatId + ":" + fromUser.id;
                if (Date.now() - (notifySeen.get(nk) || 0) > 24 * 3600 * 1000) {
                    notifySeen.set(nk, Date.now());
                    if (notifySeen.size > 2000) notifySeen.clear();
                    await db.collection("tg_groups").doc(chatId).set(
                        { notifyAdmins: admin.firestore.FieldValue.arrayUnion(fromUser.id.toString()) },
                        { merge: true }).catch(() => {});
                    // ID add হলেই hello DM (fail = /start দেয়নি, silent)
                    try {
                        await groupBot.sendMessage(fromUser.id.toString(),
                            `✅ <b>Connected!</b>\n\nEi bot ekhon tomake <b>${cleanName(msg.chat.title)}</b> (<code>${chatId}</code>) group er <b>live + gali alert</b> DM korbe. 🛡️`,
                            { parse_mode: "HTML", disable_web_page_preview: true }).catch(() => {});
                    } catch (e) {}
                }
            } catch (e) {}
        }

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
                autoDel(chatId, w.message_id, warnDeleteSec(groupConf));
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
                // purono members/warns e ownerUid backfill (panel e dekha jabe)
                (async () => {
                    try {
                        const ms = await db.collection("tg_members").where("chatId", "==", chatId).limit(400).get();
                        const batch = db.batch();
                        ms.forEach((d) => batch.set(d.ref, { ownerUid: ownerUid }, { merge: true }));
                        await batch.commit().catch(() => {});
                    } catch (e) {}
                    try {
                        const ws = await db.collection("tg_warns").where("chatId", "==", chatId).limit(200).get();
                        const b2 = db.batch();
                        ws.forEach((d) => b2.set(d.ref, { ownerUid: ownerUid }, { merge: true }));
                        await b2.commit().catch(() => {});
                    } catch (e) {}
                })();
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
                autoDel(chatId, warn.message_id, warnDeleteSec(groupConf));
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

        // Mod commands — group থেকেই ban/unban/kick/mute/warn (panel খোলা লাগে না, admin only)
        // reply দিয়ে: /ban /kick | reply বা ID দিয়ে: /unban /mute /unmute /warn /warns
        if (isCommand(text, "/ban") || isCommand(text, "/unban") || isCommand(text, "/kick") ||
            isCommand(text, "/mute") || isCommand(text, "/unmute") ||
            isCommand(text, "/warn") || isCommand(text, "/warns")) {
            if (!isAdmin) {
                const w = await groupBot.sendMessage(chatId, `⚠️ এই কমান্ড কেবল গ্রুপ এডমিনদের জন্য!`, { parse_mode: "HTML", reply_to_message_id: msgId });
                autoDel(chatId, w.message_id, warnDeleteSec(groupConf));
                return;
            }
            const getTarget = () => {
                if (msg.reply_to_message && msg.reply_to_message.from) {
                    const tu = msg.reply_to_message.from;
                    return { id: tu.id.toString(), name: `${tu.first_name || ""} ${tu.last_name || ""}`.trim() || tu.id.toString() };
                }
                const parts = (text || "").split(/\s+/);
                for (let i = 1; i < parts.length; i++) {
                    const dig = parts[i].replace(/[^0-9]/g, "");
                    if (dig.length >= 5) return { id: dig, name: dig };
                }
                return null;
            };
            const tgt = getTarget();
            if (!tgt && (isCommand(text, "/ban") || isCommand(text, "/kick") || isCommand(text, "/mute") || isCommand(text, "/warn") || (isCommand(text, "/warns") && msg.reply_to_message))) {
                await groupBot.sendMessage(chatId, `💡 যাকে শাস্তি দেবে তাকে <b>reply</b> দিয়ে কমান্ড দাও।`, { parse_mode: "HTML", reply_to_message_id: msgId });
                return;
            }
            if (isCommand(text, "/ban")) {
                await groupBot.banChatMember(chatId, tgt.id).catch((e) => { hintNoRights(chatId, e); });
                await groupBot.sendMessage(chatId, `🔨 <a href="tg://user?id=${tgt.id}">${tgt.name}</a>-কে <b>ব্যান</b> করা হলো!`, { parse_mode: "HTML" }).catch(() => {});
            } else if (isCommand(text, "/unban")) {
                if (!tgt) { await groupBot.sendMessage(chatId, `💡 <code>/unban USER_ID</code> — ID দাও।`, { parse_mode: "HTML", reply_to_message_id: msgId }); return; }
                await groupBot.unbanChatMember(chatId, tgt.id, { only_if_banned: true }).catch((e) => { hintNoRights(chatId, e); });
                await groupBot.sendMessage(chatId, `✅ <a href="tg://user?id=${tgt.id}">${tgt.name}</a>-কে <b>আনব্যান</b> করা হলো!`, { parse_mode: "HTML" }).catch(() => {});
            } else if (isCommand(text, "/kick")) {
                await groupBot.banChatMember(chatId, tgt.id).catch((e) => { hintNoRights(chatId, e); });
                await groupBot.unbanChatMember(chatId, tgt.id).catch(() => {});
                await groupBot.sendMessage(chatId, `👢 <a href="tg://user?id=${tgt.id}">${tgt.name}</a>-কে <b>কিক</b> করা হলো!`, { parse_mode: "HTML" }).catch(() => {});
            } else if (isCommand(text, "/mute")) {
                const parts = (text || "").split(/\s+/);
                let mins = 60;
                for (let i = 1; i < parts.length; i++) { const n = parseInt(parts[i].replace(/[^0-9]/g, ""), 10); if (isFinite(n) && n > 0 && n <= 10080) { mins = n; break; } }
                await groupBot.restrictChatMember(chatId, tgt.id, {
                    permissions: { can_send_messages: false },
                    until_date: Math.floor(Date.now() / 1000) + mins * 60
                }).catch((e) => { hintNoRights(chatId, e); });
                await groupBot.sendMessage(chatId, `🔇 <a href="tg://user?id=${tgt.id}">${tgt.name}</a>-কে <b>${mins} মিনিট মিউট</b> করা হলো!`, { parse_mode: "HTML" }).catch(() => {});
            } else if (isCommand(text, "/unmute")) {
                if (!tgt) { await groupBot.sendMessage(chatId, `💡 <code>/unmute USER_ID</code> — ID দাও।`, { parse_mode: "HTML", reply_to_message_id: msgId }); return; }
                await groupBot.restrictChatMember(chatId, tgt.id, {
                    permissions: { can_send_messages: true, can_send_media_messages: true, can_send_other_messages: true, can_add_web_page_previews: true }
                }).catch((e) => { hintNoRights(chatId, e); });
                await groupBot.sendMessage(chatId, `🔊 <a href="tg://user?id=${tgt.id}">${tgt.name}</a>-কে <b>আনমিউট</b> করা হলো!`, { parse_mode: "HTML" }).catch(() => {});
            } else if (isCommand(text, "/warn")) {
                const wOwner = await getFreshOwner(chatId, groupConf);
                const n = (await getWarnCount(chatId, tgt.id)) + 1;
                await setWarnCount(chatId, tgt.id, n, wOwner);
                const limit = Math.max(2, Number(groupConf.warnLimit) || 5);
                await groupBot.sendMessage(chatId, `⚠️ <a href="tg://user?id=${tgt.id}">${tgt.name}</a> ওয়ার্ন <b>(${n}/${limit})</b>`, { parse_mode: "HTML", reply_to_message_id: msgId }).catch(() => {});
                if (n >= limit) {
                    const action = groupConf.warnAction || "ban";
                    if (action === "mute") {
                        await groupBot.restrictChatMember(chatId, tgt.id, { permissions: { can_send_messages: false }, until_date: Math.floor(Date.now() / 1000) + 3600 }).catch((e) => { hintNoRights(chatId, e); });
                    } else if (action !== "warn") {
                        await groupBot.banChatMember(chatId, tgt.id).catch((e) => { hintNoRights(chatId, e); });
                    }
                    await clearWarn(chatId, tgt.id);
                }
            } else if (isCommand(text, "/warns")) {
                const qid = tgt ? tgt.id : fromUser.id.toString();
                const qn = tgt ? tgt.name : currentName;
                const c = await getWarnCount(chatId, qid);
                await groupBot.sendMessage(chatId, `📋 <a href="tg://user?id=${qid}">${qn}</a>-এর ওয়ার্ন: <b>${c}</b>`, { parse_mode: "HTML", reply_to_message_id: msgId }).catch(() => {});
            }
            return;
        }

        // Name Change Tracker (English auto) + Scammer Alert (admin + member sobar jonno)
        try {
            if (cfgBool(groupConf, "nameTrackOn", true)) {
                const userDocRef0 = db.collection("tg_user_history").doc(userId);
                const userSnap0 = await userDocRef0.get();
                if (userSnap0.exists) {
                    const oldData = userSnap0.data() || {};
                    const oldName = oldData.name || "";
                    const oldUsername = oldData.username || "";
                    if (oldName !== currentName || oldUsername !== currentUsername) {
                        await groupBot.sendMessage(chatId, buildNameChangeAlert(currentName, userId, oldName, oldUsername, currentUsername), { parse_mode: "HTML" }).catch(() => {});
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
            }
            if (cfgBool(groupConf, "scammerAlertOn", true)) {
                const scamSnap0 = await db.collection("tg_scammers").doc(userId).get().catch(() => null);
                if (scamSnap0 && scamSnap0.exists && scamSnap0.data().isScammer) {
                    await groupBot.sendMessage(chatId, buildScammerAlert(groupConf, currentName, userId), { parse_mode: "HTML", reply_to_message_id: msgId }).catch(() => {});
                }
            }
        } catch (e) {}

        // Admin gali → NO delete/ban/warn, শুধু মজার reply (mojar jonno)
        if (isAdmin && text && containsBadWord(text, groupConf)) {
            const tpl = (groupConf.adminGaliMsg || "").trim() ||
                `😂 <b>{name}</b>! Admin hoye gali diccho? Moja kore nilam — delete korlam na, ebar maaf! 😎`;
            await groupBot.sendMessage(chatId, tpl.split("{name}").join(cleanName(currentName)),
                { parse_mode: "HTML", reply_to_message_id: msgId }).catch(async () => {
                await groupBot.sendMessage(chatId, tpl.split("{name}").join(cleanName(currentName)),
                    { reply_to_message_id: msgId }).catch(() => {});
            });
        }

        // এডমিন মেসেজে কোনো ফিল্টার চলবে না (command/tracker sesh, ekhon return)
        if (isAdmin) return;

        // ০. ফ্লাড কন্ট্রোল (customize: floodOn/Limit/Window/Mute + msg + delete-sec)
        // Anonymous admin (sender_chat) ke flood e dhorbe na
        if (cfgBool(groupConf, "floodOn", true) && !isAnonymousAdmin && !msg.sender_chat) {
            const fWin = cfgNum(groupConf, "floodWindowSec", 10, 3, 120) * 1000;
            const fLim = cfgNum(groupConf, "floodLimit", 6, 2, 50);
            const fMuteAt = cfgNum(groupConf, "floodMuteCount", 10, 3, 100);
            const fMuteMin = cfgNum(groupConf, "floodMuteMin", 10, 1, 1440);
            const fk = chatId + ":" + userId;
            const nowT = Date.now();
            let farr = floodMap.get(fk) || [];
            farr = farr.filter((t) => nowT - t < fWin);
            farr.push(nowT);
            floodMap.set(fk, farr);
            if (floodMap.size > 4000) floodMap.clear();
            if (farr.length > fLim) {
                floodMap.set(fk, []);
                await delMsg(chatId, msgId);
                if (farr.length > fMuteAt) {
                    try {
                        await groupBot.restrictChatMember(chatId, fromUser.id, {
                            permissions: { can_send_messages: false },
                            until_date: Math.floor(Date.now() / 1000) + fMuteMin * 60
                        });
                    } catch (e) { hintNoRights(chatId, e); }
                }
                const flMsg = `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, ${cfgStr(groupConf, "floodMsg", CFG_DEFAULTS.floodMsg)}`;
                const fm = await groupBot.sendMessage(chatId, flMsg, { parse_mode: "HTML" }).catch(() => null);
                if (fm) autoDel(chatId, fm.message_id, filterDeleteSec(groupConf));
                return;
            }
        }

        if (!isAdmin) {
            // ০.৫ বাটন-লিংক/বিজ্ঞাপন ব্লক (message এর নিচে URL button — ad-bot দের হাতিয়ার)
            if (groupConf.antiButton !== false && hasUrlButton(msg)) {
                await delMsg(chatId, msgId);
                const btnMsg = (groupConf.msgs && (groupConf.msgs.button || groupConf.msgs.link)) || "বাটন-লিংক / বিজ্ঞাপন দেওয়া নিষেধ!";
                const bm = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, ${btnMsg}`, { parse_mode: "HTML" }).catch((e) => { hintNoRights(chatId, e); return null; });
                if (bm) autoDel(chatId, bm.message_id, filterDeleteSec(groupConf));
                return;
            }
            // ০.৭ Fake staff-title block (name/username e owner-admin-moderator,
            // kintu real admin na → reply warn; offender message by default THAKBE)
            if (cfgBool(groupConf, "fakeTitleOn", true)) {
                const hit = fakeTitleHit(currentName, currentUsername, groupConf);
                if (hit) {
                    // age delete korle reply thread ভাঙে — tai age reply, delete (chaile) pore
                    const tpl = (groupConf.fakeTitleMsg || "").trim() ||
                        `🚫 <b>{name}</b> — "<b>{title}</b>" নামে ভান করে লাভ নেই! তুমি এই group এর admin/staff নও। আসল পরিচয়ে কথা বলো।`;
                    const body = tpl.split("{title}").join(cleanName(hit)).split("{id}").join(String(userId)).split("{name}").join(cleanName(currentName));
                    const dm = await groupBot.sendMessage(chatId, body, { parse_mode: "HTML", reply_to_message_id: msgId }).catch(async () => {
                        return groupBot.sendMessage(chatId, body.replace(/<[^>]*>/g, ""), { reply_to_message_id: msgId }).catch(() => null);
                    });
                    if (cfgBool(groupConf, "fakeTitleDelete", true)) await delMsg(chatId, msgId);
                    const ds = cfgNum(groupConf, "fakeTitleDeleteSec", 0, 0, 300);
                    if (dm) autoDel(chatId, dm.message_id, ds);
                    // Fake-title DM + log — admin jante pare ke ki bollo, delete holo kina
                    const fdel = cfgBool(groupConf, "fakeTitleDelete", true);
                    try {
                        if (cfgBool(groupConf, "galiDmOn", true)) {
                            const short = String(text || "").slice(0, 300);
                            await dmAdmins(chatId, groupConf,
                                `🚫 <b>Fake-title decline</b>\n\n👤 <a href="tg://user?id=${userId}">${cleanName(currentName)}</a> ${currentUsername} (<code>${userId}</code>)\n📍 <b>${cleanName(msg.chat.title)}</b>\n💬 <i>${cleanName(short)}</i>\n⚠️ Fake title: <b>${cleanName(hit)}</b> → ${fdel ? "deleted ✅" : "kept"}`);
                        }
                    } catch (e) {}
                    try {
                        let fOwner = groupConf.ownerUid || "";
                        if (!fOwner) { try { const gd = await db.collection("tg_groups").doc(chatId).get(); fOwner = gd.exists ? (gd.data().ownerUid || "") : ""; } catch (e) {} }
                        await db.collection("tg_gali_log").add({
                            chatId, userId,
                            name: String(currentName || "").slice(0, 80),
                            username: String(currentUsername || "").slice(0, 40),
                            text: String(text || "").slice(0, 300),
                            warns: 0, action: "fake-title:" + String(hit || "").slice(0, 30),
                            ownerUid: fOwner,
                            createdAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                    } catch (e) {}
                    return;
                }
            }
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
                await delMsg(chatId, msgId);
                const fwdMsg = (groupConf.msgs && groupConf.msgs.forward) || "অন্য কোনো চ্যানেল, গ্রুপ বা ইনবক্স থেকে শেয়ার বা ফরোয়ার্ড করা সম্পূর্ণ নিষেধ!";
                const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, ${fwdMsg}`, { parse_mode: "HTML" }).catch((e) => { hintNoRights(chatId, e); return null; });
                if (m) autoDel(chatId, m.message_id, filterDeleteSec(groupConf));
                return;
            }

            // ২. ভিডিও ব্লক
            if (groupConf.antiVideo && (msg.video || msg.video_note)) {
                await delMsg(chatId, msgId);
                const vidMsg = (groupConf.msgs && groupConf.msgs.video) || "গ্রুপে ভিডিও পাঠানো নিষেধ!";
                const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, ${vidMsg}`, { parse_mode: "HTML" }).catch((e) => { hintNoRights(chatId, e); return null; });
                if (m) autoDel(chatId, m.message_id, filterDeleteSec(groupConf));
                return;
            }

            // ৩. ইনবক্স ফিল্টার (FIX: "ib" ekhon word-boundary — vibe/job e match korbe na)
            if (groupConf.antiInbox !== false && text && isInboxText(text)) {
                await delMsg(chatId, msgId);
                const ibMsg = (groupConf.msgs && groupConf.msgs.inbox) || "গ্রুপে ইনবক্সে ডাকার চেষ্টা করবেন না! সব কথা গ্রুপেই বলুন।";
                const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, ${ibMsg}`, { parse_mode: "HTML" }).catch((e) => { hintNoRights(chatId, e); return null; });
                if (m) autoDel(chatId, m.message_id, filterDeleteSec(groupConf));
                return;
            }

            // ৪. অ্যান্টি-লিংক (whitelist e thakle allow, nahole sob block)
            if (groupConf.antiLink !== false && (text.includes("t.me/") || text.includes("http://") || text.includes("https://") || text.includes("www."))) {
                const wl = (Array.isArray(groupConf.linkWhitelist) && groupConf.linkWhitelist.length)
                    ? groupConf.linkWhitelist
                    : [];
                const allowed = wl.length > 0 && wl.some((w) => w && text.toLowerCase().includes(String(w).toLowerCase()));
                if (!allowed) {
                    await delMsg(chatId, msgId);
                    const linkMsg = (groupConf.msgs && groupConf.msgs.link) || "অননুমোদিত লিংক দেওয়া নিষেধ!";
                    const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, ${linkMsg}`, { parse_mode: "HTML" }).catch((e) => { hintNoRights(chatId, e); return null; });
                    if (m) autoDel(chatId, m.message_id, filterDeleteSec(groupConf));
                    return;
                }
            }

            // ৫. গালি ফিল্টার + warn/ban (custom list + default list)
            const matchedWord = findBadWord(text, groupConf);
            const hasBadWord = !!matchedWord;

            if (hasBadWord) {
                await delMsg(chatId, msgId);
                const limit = Math.max(2, Number(groupConf.warnLimit) || 5);
                const action = groupConf.warnAction || "ban";
                let wOwner = await getFreshOwner(chatId, groupConf);
                const curWarns = (await getWarnCount(chatId, userId)) + 1;
                await setWarnCount(chatId, userId, curWarns, wOwner);
                // Gali log — panel + admin DM theke pore dekha jabe (ke ki bollo + matched word)
                try {
                    await db.collection("tg_gali_log").add({
                        chatId, userId,
                        name: String(currentName || "").slice(0, 80),
                        username: String(currentUsername || "").slice(0, 40),
                        text: String(text || "").slice(0, 300),
                        matched: String(matchedWord || "").slice(0, 60),
                        warns: curWarns, action,
                        ownerUid: wOwner || "",
                        createdAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                } catch (e) {}
                const atName = `@${fromUser.username || fromUser.first_name}`;
                const mention = `<a href="tg://user?id=${userId}">${cleanName(currentName)}</a>`;

                if (curWarns >= limit) {
                    if (action === "mute") {
                        const until = Math.floor(Date.now() / 1000) + 3600;
                        await groupBot.restrictChatMember(chatId, userId, {
                            permissions: { can_send_messages: false }, until_date: until
                        }).catch((e) => { hintNoRights(chatId, e); });
                        await groupBot.sendMessage(chatId, `🔇 ${mention}-কে <b>১ ঘণ্টার জন্য মিউট</b> করা হলো! (গালি: ${curWarns}/${limit})`, { parse_mode: "HTML" });
                    } else if (action === "warn") {
                        await groupBot.sendMessage(chatId, `🚨 ${mention}, <b>শেষ ওয়ার্নিং (${curWarns}/${limit})!</b> ${groupConf.warnMsg || "এরপর কঠোর ব্যবস্থা নেওয়া হবে!"}`, { parse_mode: "HTML" });
                    } else {
                        await groupBot.banChatMember(chatId, userId).catch((e) => { hintNoRights(chatId, e); });
                        await groupBot.sendMessage(chatId, `🚨 ${mention}-কে <b>গ্রুপ থেকে ব্যান</b> করা হলো! (গালি: ${curWarns}/${limit})`, { parse_mode: "HTML" });
                    }
                    await clearWarn(chatId, userId);
                } else {
                    const base = groupConf.warnMsg || "ভদ্র ভাষা ব্যবহার করুন!";
                    const m = await groupBot.sendMessage(chatId, `⚠️ ${mention}, ${base} সতর্কতা <b>(${curWarns}/${limit})</b>।`, { parse_mode: "HTML" });
                    autoDel(chatId, m.message_id, warnDeleteSec(groupConf));
                }
                // Gali DM → admin দের full detail (ke ki bollo + KON word ধরলো)
                try {
                    if (cfgBool(groupConf, "galiDmOn", true)) {
                        const short = text.slice(0, 300);
                        const acted = curWarns >= limit ? (action === "mute" ? "1h mute" : action === "warn" ? "last warn" : "ban") : `warn ${curWarns}/${limit}`;
                        await dmAdmins(chatId, groupConf,
                            `🚨 <b>Gali Alert</b>\n\n👤 <a href="tg://user?id=${userId}">${cleanName(currentName)}</a> ${currentUsername} (<code>${userId}</code>)\n📍 <b>${cleanName(msg.chat.title)}</b>\n💬 <i>${cleanName(short)}</i>\n🎯 <b>Matched:</b> <code>${cleanName(matchedWord) || "-"}</code>\n⚠️ Action: <b>${acted}</b>`);
                    }
                } catch (e) {}
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

        for (const user of newMembers) {
            if (user.is_bot) continue;
            // bot nije join hole welcome na (my_chat_member greeting dey)
            try {
                const me = await groupBot.getMe().catch(() => null);
                if (me && user.id === me.id) continue;
            } catch (e) {}
            // join kora user er id collect (Send box er jonno)
            trackMember(chatId, String(user.id), user.first_name || "Member",
                user.username ? `@${user.username}` : "None", (gConf && gConf.ownerUid) || "").catch(() => {});
            const name = user.first_name || "Member";
            const w = await resolveWelcome(chatId, gConf, name);
            if (!w) continue;

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
                autoDel(chatId, sentWelcome.message_id, w.deleteSec);
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

        if (data === "wp_back" || data.startsWith("wp_")) {
            await wizCallback(groupBot, query);
            return;
        }
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
                    [{ text: `🎉 Join (${participants.length})`, callback_data: `giveaway_join:${giveawayId}` }]
                ]
            }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
            return;
        }

    } catch (e) {}
});

} // ================= end createProtector =================

// ---------------- 10b. BOT MANAGER (user-connected bots via popup) ----------------
function botPollErr(tag) {
    return (e) => {
        const m = (e && e.message) || String(e);
        if (m.includes("409") || m.includes("conflict")) {
            console.error(`[POLLING 409:${tag}] token onno kothao cholche (2 instance / BotFather revoke?)`);
        } else if (m.includes("401") || m.includes("Unauthorized")) {
            console.error(`[POLLING 401:${tag}] token invalid/revoked — panel theke reconnect koro.`);
        } else {
            console.error(`[POLLING:${tag}]`, m.slice(0, 160));
        }
    };
}
function startUserBot(docId, data) {
    stopUserBot(docId);
    if (!data || data.active === false || !data.botToken) return;
    try {
        const b = new TelegramBot(String(data.botToken).trim(), { polling: true });
        b.on("polling_error", botPollErr(String(data.botUsername || docId).slice(0, 24)));
        b.getMe().then((me) => {
            const un = me.username ? ("@" + me.username) : "";
            botInstances.set(String(docId), { bot: b, username: un });
            // username fresh rakhি
            db.collection("vs_bots").doc(String(docId)).set({ botUsername: un, botName: me.first_name || data.botName || "Bot" }, { merge: true }).catch(() => {});
            console.log("[VS] User bot connected:", un, "owner", (data.ownerUid || "").slice(0, 8));
        }).catch((e) => console.error("[VS] User bot token bad:", String(docId).slice(0, 8), e.message));
        createProtector(b, { id: String(docId), username: data.botUsername || "", ownerUid: data.ownerUid || "" });
        botInstances.set(String(docId), { bot: b, username: data.botUsername || "" });
    } catch (e) { console.error("[VS] startUserBot fail:", e.message); }
}
function stopUserBot(docId) {
    const x = botInstances.get(String(docId));
    if (x) {
        try { x.bot.stopPolling({ cancel: true }); } catch (e) { try { x.bot.stopPolling(); } catch (e2) {} }
        botInstances.delete(String(docId));
        console.log("[VS] User bot stopped:", String(docId).slice(0, 8));
    }
}
// Default shared bot e engine attach
createProtector(groupBot, { id: "default", username: "", ownerUid: "" });
// Popup-connected bots: add/update/remove live
const botSig = new Map(); // botId -> token|active signature (shudhu change hole restart, nahole loop)
db.collection("vs_bots").onSnapshot((snap) => {
    snap.docChanges().forEach((change) => {
        const id = change.doc.id;
        if (change.type === "removed") { stopUserBot(id); botSig.delete(id); return; }
        const d = change.doc.data() || {};
        const sig = String(d.botToken || "") + "|" + String(d.active !== false);
        if (botSig.get(id) === sig && botInstances.has(id)) return; // username-only update — restart na
        botSig.set(id, sig);
        if (d.active === false || !d.botToken) { stopUserBot(id); return; }
        startUserBot(id, d);
    });
}, (err) => console.error("[BOTS-SNAPSHOT]", err.message));

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
// Giveaway hourly refresh (count + countdown + silent re-pin) + restart catch-up
setTimeout(() => { refreshActiveGiveaways().catch(() => {}); }, 2 * 60 * 1000);
setInterval(() => { refreshActiveGiveaways().catch(() => {}); }, 60 * 60 * 1000);
