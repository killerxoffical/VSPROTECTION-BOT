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
// Choto Bangla word (বাল/চোদা/চুদি/মাগী — ৪ অক্ষর পর্যন্ত): শুধু আলাদা থাকলে মিলবে,
// genitive suffix (র/কে/টা/টি/গুলো/দের) সহ চলবে — কিন্তু ইকবাল/বালক/বালতি/বালিশ-এ ধরবে না
const BN_SEP = "[\\s।,!?;:\"'()\\[\\]{}<>\\-–—/\\\\|@#$%^*+=~`]";
const BN_SUF = "(?:র(?:া)?|ের|য়ের|কে|টা|টি|গুলো(?:র|কে)?|দের)";
function bnWordHit(textLower, word) {
    const w = (word || "").toLowerCase().trim();
    if (!w) return false;
    try { return new RegExp("(?:^|" + BN_SEP + ")" + escRe(w) + "(?:$|" + BN_SEP + "|" + BN_SUF + ")").test(textLower); }
    catch (e) { return textLower.includes(w); }
}
function isInboxText(text) {
    const t = (text || "").toLowerCase();
    if (!t) return false;
    if (wordHit(t, "ib")) return true;
    for (const w of INBOX_WORDS) { if (wordHit(t, w)) return true; }
    return false;
}
// Link whitelist (glitch fix): age plain includes() ছিল — "google.com" whitelist
// থাকলে "notgoogle.com"-ও allow হয়ে যেত। Ekhon bare-domain entry hostname-এ
// মেলে (subdomain সহ), path-entry (t.me/mychannel) substring-এ মেলে।
function hostOf(u) {
    try {
        const h = new URL(/^https?:\/\//i.test(u) ? u : "https://" + u).hostname.toLowerCase();
        return h.replace(/^\.+|\.+$/g, "");
    } catch (e) { return ""; }
}
function findUrls(text) {
    const out = [];
    const re = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|t\.me\/[^\s<>"']+)/gi;
    let m;
    while ((m = re.exec(text || ""))) out.push(m[1]);
    return out;
}
function linkAllowed(text, whitelist) {
    const low = (text || "").toLowerCase();
    const wl = (Array.isArray(whitelist) ? whitelist : [])
        .map((w) => String(w || "").toLowerCase().trim().replace(/^https?:\/\//, "").replace(/^www\./, ""))
        .filter(Boolean);
    if (!wl.length) return false;
    for (const w of wl) {
        if (w.includes("/") && low.includes(w)) return true;
    }
    for (const u of findUrls(text)) {
        const h = hostOf(u);
        if (!h) continue;
        for (const w of wl) {
            if (w.includes("/")) continue;
            if (h === w || h.endsWith("." + w)) return true;
        }
    }
    return false;
}
// ---- Dyno-style Automod helpers (default OFF — panel → Automod) ----
function capsHit(text, minLen, percent) {
    const letters = String(text || "").replace(/[^A-Za-z]/g, "");
    if (letters.length < (minLen || 0)) return false;
    let caps = 0;
    for (const c of letters) { if (c >= "A" && c <= "Z") caps++; }
    return (caps * 100 / letters.length) >= (percent || 100);
}
function emojiCount(text) {
    try {
        const m = String(text || "").match(/\p{Extended_Pictographic}/gu);
        return m ? m.length : 0;
    } catch (e) {
        const m2 = String(text || "").match(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF]/gu);
        return m2 ? m2.length : 0;
    }
}
function newlineCount(text) {
    const m = String(text || "").match(/\n/g);
    return m ? m.length : 0;
}
// Duplicate-text spam: ekoi user ekoi lekha bar-by-bar pathale count bare.
// Short text (<4) + command (/) count hoy na.
const dupMap = new Map(); // "chatId:userId" -> { text, count }
function dupHit(chatId, userId, text, need) {
    const norm = String(text || "").toLowerCase().trim().replace(/\s+/g, " ").slice(0, 200);
    if (!norm || norm.length < 4 || norm.startsWith("/") || norm.startsWith("!")) return 0;
    const k = String(chatId) + ":" + String(userId);
    const prev = dupMap.get(k);
    const count = (prev && prev.text === norm) ? (prev.count + 1) : 1;
    dupMap.set(k, { text: norm, count });
    if (dupMap.size > 4000) dupMap.clear();
    return count >= Math.max(2, Number(need) || 3) ? count : 0;
}
// Spaced/dotted single-letter evasion join ("F.U.C.K"→fuck, "f u c k"→fuck).
// Shudhu single/short part thakle join হয় — "tumar bolo"/"kom chilo" untouched.
function joinSpacedSingles(text) {
    const parts = String(text || "").split(/(\s+)/);
    for (let i = 0; i < parts.length; i++) {
        const ch = parts[i];
        if (!ch || /^\s+$/.test(ch)) continue;
        const sub = ch.split(/[\W_]+/).filter(Boolean);
        if (sub.length > 1 && sub.every((p) => p.length <= 3)) {
            parts[i] = sub.join("");
        }
    }
    return parts.join("").replace(/\b([a-z0-9])((?:\s+[a-z0-9])+)\b/gi, (m) => m.replace(/\s+/g, ""));
}
// Trigger match: choto keyword (<=3, command নয়) → standalone word;
// baki → substring (ager moto). ("ok" keyword "book" e fire korto — glitch fix)
function trigHit(hayLower, kwLower) {
    if (!kwLower) return false;
    if (kwLower.length <= 3 && !kwLower.startsWith("/") && !kwLower.startsWith("!")) {
        if (/[^a-z0-9]/.test(kwLower)) {
            return String(hayLower).split(/[^a-z0-9\u0980-\u09FF]+/).includes(kwLower);
        }
        try { return new RegExp("\\b" + escRe(kwLower) + "\\b", "i").test(hayLower); } catch (e) { return false; }
    }
    return hayLower.includes(kwLower);
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
    "abaler",
    "balerbal", "malai", "dimaon",
    "dalal", "batpar", "dhandabaz", "fotka", "fotkabaz", "chotolok", "fokini", "fokinnni",
    "chiter", "chitingbaz", "dhokabaz", "bhondo",
    "luichcha", "luchcha", "bodmaish", "bodmash", "beyadob",
    "shoytan", "shaitan", "shoitan", "soytaner", "iblis", "lanot", "behaya", "beshorom",
    "chamcha", "telbaj", "nimokharam", "bejonma", "jaroj", "munafik",
    "gadha", "murkho", "ahammok", "ulluk", "chasha", "khet", "habla",
    "chagol", "ramchagol", "goru", "shiyal", "bador",
    "dakat", "dakait", "khuni", "gunda", "mastan",
    "juta", "jhata", "lathkhor", "potita",
    "hijra", "hizra", "malaun", "katua", "barovatari", "barobhatari",
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
const BOUNDARY_BAD_WORDS = ["mc", "bc", "ass", "sex", "cum", "tit", "hoe", "magi", "randi", "abal", "chor", "churi", "baal", "baler", "balsal", "balchal", "boka", "chakka", "shala", "shalar"];
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
// Separator-tolerant boundary ("m.c", "b c" ধরে — কিন্তু "kom chilo"/"cucumber"-এ ধরবে না)
function wordBoundarySep(textLower, word) {
    const w = (word || "").toLowerCase().trim();
    if (!w) return false;
    try {
        const pat = w.split("").map((c) => escRe(c)).join("[\\W_]*");
        return new RegExp("\\b" + pat + "\\b", "i").test(textLower);
    } catch (e) { return wordBoundary(textLower, word); }
}
// ---- Precision abuse matching (false-positive fix) ----
// Age symbol/space মুছে পুরো message এক string করে indexOf চলত — পাশাপাশি দুই
// নির্দোষ word জোড়া লেগে gali stem বানাত ("tumar bolo"→marbo, "Bob"→bob,
// "ashole"[আসলে]→asshole, "mishti"→sht) আর delete+warn হয়ে যেত।
// Ekhon message token (word) ভাগ করে প্রতি token-এ মেলানো হয়।
function abuseTokens(text) {
    const raws = String(text || "").toLowerCase().split(/[^a-z0-9\u0980-\u09FF]+/).filter(Boolean);
    const out = [];
    for (const r of raws) {
        const n = normAbuse(r);
        if (n) out.push({ raw: r, norm: n, idx: -1 });
    }
    return out;
}
// Common/double-meaning stem — শুধু standalone token (+suffix) হিসেবে ধরবে।
// (normAbuse form-এ compare হয়; "dalali"/"kom chilo" safe, "dalal"/"dalaler" ধরা পড়ে)
const AMBIGUOUS_RAW = [
    "dalal", "batpar", "dhandabaz", "fotka", "fotkabaz", "chotolok", "fokini", "fokinnni",
    "chiter", "chitingbaz", "dhokabaz", "bhondo", "chamcha", "telbaj", "nimokharam",
    "bejonma", "jaroj", "munafik", "luichcha", "luchcha", "bodmaish", "bodmash", "beyadob",
    "shoytan", "shaitan", "shoitan", "soytaner", "iblis", "lanot", "behaya", "beshorom",
    "gadha", "murkho", "ahammok", "ulluk", "chasha", "khet", "habla",
    "chagol", "ramchagol", "goru", "kukur", "shiyal", "bador",
    "juta", "jhata", "lathkhor", "potita", "hijra", "hizra", "malaun", "katua",
    "barovatari", "barobhatari", "bessha", "beshya",
    "shudkhor", "ghushkhor", "modkhor", "ganjakhor", "neshakhor", "babakhor",
    "dakat", "dakait", "khuni", "gunda", "mastan",
    "chorer", "marbo", "merefelbo", "khunkorbo",
    "abaler", "balerbal", "malai", "dimaon", "magir", "randir",
    "দালাল", "বাটপার", "ফটকা", "ফটকাবাজ", "ধান্দাবাজ", "ধোঁকাবাজ", "ভণ্ড",
    "ছোটলোক", "ফকিন্নি", "চিটার", "চিটিংবাজ", "চামচা", "তেলবাজ",
    "বেয়াদব", "লুইচ্চা", "বদমাশ", "ছাগল", "রামছাগল", "গরু", "শিয়াল", "বাদর",
    "ডাকাত", "খুনি", "গুন্ডা", "মাস্তান", "জুতা", "ঝাঁটা", "পতিতা", "হিজড়া",
    "বেশ্যা", "মালাউন", "শয়তান", "ইবলিস", "মারবো", "মেরেফেলবো", "খুনকরব",
    "সুদখোর", "ঘুষখোর", "মদখোর", "গাঁজাখোর", "নেশাখোর", "বাবাখোর"
];
let AMB_NORMS = null;
function ambNorms() {
    if (!AMB_NORMS) AMB_NORMS = new Set(AMBIGUOUS_RAW.map((w) => normAbuse(String(w))).filter(Boolean));
    return AMB_NORMS;
}
// Raw-form hint লাগে এমন stem (norm এক হলেও raw আলাদা: Bob≠boob, ashole≠asshole)
const RAW_HINTS = {
    bob: { hints: ["boob"], exactOk: false },
    bobs: { hints: ["boobs"], exactOk: false },
    sht: { hints: ["shit"], exactOk: true },
    ashole: { hints: ["ass"], exactOk: false }
};
function rawSepHas(leetHay, hints) {
    for (const h of (hints || [])) {
        try {
            const pat = String(h).split("").map((c) => escRe(c)).join("[\\W_]*");
            if (new RegExp(pat, "i").test(leetHay)) return true;
        } catch (e) {}
    }
    return false;
}
function ambSuffixOk(tail, isBn) {
    if (!tail) return true;
    if (isBn) return /^(?:র(?:া)?|ের|য়ের|কে|টা|টি|গুলো(?:র|কে)?|দের)$/.test(tail);
    // NOTE: bare e/te বাদ — "khete"(খেতে=to eat) এর মতো verb-এ লাগত
    return /^(?:r|ra|er|der|derke|ke|ta|ti|gulo|gulor|guloke|gula|gular)$/.test(tail);
}
// Threat word + পাশে না/নাই থাকলে skip ("marbo na" = মারবে না বলেছে, threat না)
const THREAT_NORMS = new Set(["marbo", "merefelbo", "khunkorbo"]);
const NEG_TOKS = new Set(["na", "nai", "nah", "ni", "naa", "ne", "ney"]);
// Full message theke KON word ta match korlo — admin DM/log e mention হয়
function findBadWord(text, conf) {
    const t = joinSpacedSingles((text || "").toLowerCase());
    if (!t) return "";
    let skip = null;
    try {
        const dl = conf && conf.disabledBadWords;
        if (Array.isArray(dl) && dl.length) skip = new Set(dl.map((x) => normAbuse(String(x || "").trim())).filter(Boolean));
    } catch (e) {}
    const isDisabled = (norm) => !!(skip && skip.has(norm));
    // 1) Boundary words — standalone (+leet + separator-tolerant: "m.c", "b c")
    for (const b of BOUNDARY_BAD_WORDS) {
        if (isDisabled(normAbuse(b))) continue;
        const lt = leetMap(t);
        if (wordBoundary(t, b) || wordBoundary(lt, b) || wordBoundarySep(t, b) || wordBoundarySep(lt, b)) return b;
    }
    const toks = abuseTokens(t);
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
    // token → whole-string position (strip monotonic বলে order-এ মেলে)
    let pos = 0;
    for (const tk of toks) {
        const at = nText.indexOf(tk.norm, pos);
        tk.idx = at;
        if (at !== -1) pos = at + tk.norm.length;
    }
    const tokCovered = (tk) => tk.idx !== undefined && tk.idx !== -1 && covered(tk.idx, tk.norm.length);
    const isBnShort = (w) => /[\u0980-\u09FF]/.test(w) && String(w).length <= 4;
    const matchOne = (word) => {
        const b = String(word || "").trim();
        if (!b || b.length < 2) return "";
        const nb = normAbuse(b);
        if (!nb || isDisabled(nb)) return "";
        const isBn = /[\u0980-\u09FF]/.test(b);
        // Choto Bangla word — ইকবাল/বালক/বালতি/বালিশ protection
        if (isBnShort(b)) { if (bnWordHit(t, b)) return b; return ""; }
        // Ambiguous/common stem — শুধু standalone token (+suffix)
        if (ambNorms().has(nb)) {
            for (let i = 0; i < toks.length; i++) {
                const tk = toks[i];
                if (tokCovered(tk)) continue;
                let hit = false;
                if (tk.norm === nb) hit = true;
                else if (tk.norm.length > nb.length && tk.norm.startsWith(nb) && ambSuffixOk(tk.norm.slice(nb.length), isBn)) hit = true;
                if (!hit) continue;
                if (THREAT_NORMS.has(nb)) {
                    const pv = toks[i - 1] ? toks[i - 1].norm : "";
                    const nx = toks[i + 1] ? toks[i + 1].norm : "";
                    if (NEG_TOKS.has(pv) || NEG_TOKS.has(nx)) continue;
                }
                return b;
            }
            return "";
        }
        // Raw-hint stem (Bob/boob, ashole/asshole, mishti/shit)
        const rh = RAW_HINTS[nb];
        if (rh) {
            for (const tk of toks) {
                if (tokCovered(tk)) continue;
                if (tk.norm === nb) {
                    if (rh.exactOk || rawSepHas(leetMap(tk.raw), rh.hints)) return b;
                    continue;
                }
                if (tk.norm.includes(nb) && rawSepHas(leetMap(tk.raw), rh.hints)) return b;
            }
            if (nb.length >= 6) {
                const ii = nText.indexOf(nb);
                if (ii !== -1 && !covered(ii, nb.length) && rawSepHas(leetMap(t), rh.hints)) return b;
            }
            return "";
        }
        // Choto stem (<=3) — শুধু exact token ("psycho" safe, "Bob" safe)
        if (nb.length <= 3) {
            for (const tk of toks) { if (!tokCovered(tk) && tk.norm === nb) return b; }
            return "";
        }
        // Strong stem — token-includes (inflection/compound ধরে, cross-word জোড়া ধরে না)
        for (const tk of toks) { if (!tokCovered(tk) && tk.norm.includes(nb)) return b; }
        // dotted/space-split bypass ("f.u.c.k") — শুধু strong stem, disabled-overlap বাদে
        if (nb.length >= 6) {
            const ii = nText.indexOf(nb);
            if (ii !== -1 && !covered(ii, nb.length)) return b;
        }
        return "";
    };
    const customs = (conf && conf.customBadWords) || [];
    for (const c of customs) { const r = matchOne(c); if (r) return r; }
    if (!conf || conf.useDefaultBadWords !== false) {
        for (const e of getNormBad()) {
            if (!e.norm) continue;
            const r = matchOne(e.raw);
            if (r) return r;
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

// ---------------- 3c. PANEL SEND HELPERS ----------------
// Bot resolver: panel botId diye instance age, na thakle oi chat er registered bot
// (tg_groups doc er botId), last e default bot. Custom-bot group e wrong bot diye
// pathano (403 "bot is not a member") + silent fail - dutoi ekhane off.
function pickOrNull(botId) {
    if (!botId || String(botId) === "default") return null;
    try {
        return botInstances.has(String(botId)) ? botInstances.get(String(botId)).bot : null;
    } catch (e) { return null; }
}
async function chatBotDoc(chatId) {
    try {
        const gd = await db.collection("tg_groups").doc(String(chatId)).get();
        if (gd && gd.exists) return gd.data() || {};
    } catch (e) {}
    return {};
}
async function resolveChatBot(chatId, reqBotId) {
    const doc = await chatBotDoc(chatId);
    return pickOrNull(reqBotId) || pickOrNull(doc.botId) || groupBot;
}
// Telegram error → admin-friendly hint (silent fail hoy na — bot nijei bole dey keno parlo na)
function tlErrHint(e) {
    const m = String((e && e.message) || e || "").toLowerCase();
    if (m.includes("bot is not a member") || m.includes("bot was kicked") || m.includes("not a participant"))
        return "Bot ei group/channel e member nei — oi group er guardian bot ke abar member banai, tarpor try koro.";
    if (m.includes("chat not found") || m.includes("peer id invalid"))
        return "Chat ID bhul / bot chenona — Group ID (-100...) abar check koro (e.g. /id likhe group e).";
    if (m.includes("bot was blocked") || m.includes("user is deactivated"))
        return "User bot block koreche / /start dey nai — age bot ke /start dilei DM jabe.";
    if (m.includes("not enough rights") || m.includes("need administrator"))
        return "Bot er Admin permission nei — bot ke Admin banao (Delete + Ban + Pin).";
    if (m.includes("can't parse"))
        return "Message er HTML parse hoye nai — '<' '>' '&'/half-tag khunje dekho, ba plain text e pathano.";
    if (m.includes("too many requests"))
        return "Telegram rate-limit — ektu por eti try koro (minute by minute vul naho).";
    if (m.includes("message is too long"))
        return "Message khub lomba — 3500 char er niche rakho.";
    if (m.includes("photo") && (m.includes("url") || m.includes("invalid") || m.includes("wrong")))
        return "Photo URL kaj korche na — direct https://... image link dilo (size/extension check).";
    return String((e && e.message) || e || "").slice(0, 180);
}
// smartSendAny: bot candidate chain (reqBot → chat doc bot → default);
// HTML parse fail hole SAME bot e plain-text retry; onno-no fail hole porer bot e try.
// Return: {bot, sent} all bolle success — na hole {error} with friendly hint.
async function smartSendAny(chatId, reqBotId, buildCall) {
    const cands = [];
    const rq = pickOrNull(reqBotId);
    if (rq) cands.push(rq);
    const docBot = pickOrNull((await chatBotDoc(chatId)).botId);
    if (docBot && !cands.includes(docBot)) cands.push(docBot);
    if (!cands.includes(groupBot)) cands.push(groupBot);
    let lastErr = null;
    for (const b of cands) {
        try { return { bot: b, sent: await buildCall(b, false) }; }
        catch (e1) {
            lastErr = e1;
            const m = String((e1 && e1.message) || e1 || "").toLowerCase();
            if (m.includes("can't parse")) {
                try { return { bot: b, sent: await buildCall(b, true) }; }
                catch (e2) { lastErr = e2; break; }
            }
        }
    }
    return { bot: cands[0], error: tlErrHint(lastErr) };
}

// ---------------- 4. BROADCAST API ----------------
// Prottek group tar NIJER registered bot diye pathano hoy (custom-bot group e
// shared bot member na hole silently skip hoto — ekhon sothik bot + error hint),
// HTML fail → plain-text retry, 429 hole wait, ar result honestly report hoy.
app.post("/api/tg/group-broadcast", async (req, res) => {
    const { text, photoUrl, chatId, botId } = req.body;
    if (!text) return res.status(400).json({ ok: false, error: "মেসেজ লিখুন" });

    try {
        let targets = [];
        if (chatId) {
            const cid = String(chatId).trim();
            targets.push(/^\d+$/.test(cid) ? "-" + cid : cid); // Chat ID vul prefix auto-fix ("100123..." → "-100123...")
        } else {
            const snap = await db.collection("tg_groups").get();
            snap.forEach((d) => targets.push(d.id));
        }
        if (!targets.length) return res.status(400).json({ ok: false, error: "Kono group/channel registered nei — bot ke group e add + Admin banao." });

        const stripHtml = (t) => String(t).replace(/<br\s*\/?>/gi, "\n").replace(/<[^<>\n]+>/g, " ").replace(/[ \t]{2,}/g, " ").trim();
        let successCount = 0, failCount = 0;
        const errs = [];

        for (const targetId of targets) {
            const out = await smartSendAny(targetId, botId, (bot, isPlain) => {
                const cap = isPlain ? stripHtml(text) : String(text).slice(0, 1000);
                if (photoUrl) {
                    const o = { caption: cap };
                    if (!isPlain) o.parse_mode = "HTML";
                    return bot.sendPhoto(targetId, photoUrl, o);
                }
                const o = { disable_web_page_preview: true };
                if (!isPlain) o.parse_mode = "HTML";
                return bot.sendMessage(targetId, cap, o);
            });
            if (out.error) {
                failCount++;
                if (errs.length < 5) errs.push(targetId + " → " + out.error);
                if (String(out.error).includes("rate-limit")) await new Promise((r) => setTimeout(r, 3000));
            } else {
                successCount++;
            }
            await new Promise((r) => setTimeout(r, 50)); // Telegram flood guard — rate safe
        }

        let msg;
        if (successCount === 0) {
            msg = `❌ Kono group/channel ei message jay nai (fail ` + failCount + `/` + targets.length + `)! Karon: ` + (errs[0] || "protection server offline/ghomie ache — Render service check koro");
        } else {
            msg = `✅ ` + successCount + ` টি গ্রুপে ব্রডকাস্ট পাঠানো হয়েছে!` + (failCount ? (` (` + failCount + ` টি fail — karon: ` + (errs[0] || "") + `)`) : "");
        }
        return res.json({ ok: successCount > 0, success: successCount, failed: failCount, total: targets.length, errors: errs, message: msg });
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
    const sender = await resolveChatBot(String(chatId), botId);
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
// Wrong/missing botId ao kaj kore: request bot → chat er registered bot → default;
// HTML fail hole plain-text retry; fail hole admin-friendly karon ferot jay (silent fail nei).
app.post("/api/tg/send-message", async (req, res) => {
    const { chatId, text, userId, replyTo, botId } = req.body;
    if (!chatId || !text) return res.status(400).json({ ok: false, error: "chatId + text দিন" });
    try {
        const cid = String(chatId).trim();
        const uid = userId ? String(userId).replace(/[^0-9-]/g, "") : "";
        const body = String(text).slice(0, 3500);
        const out = await smartSendAny(cid, botId, (bot, isPlain) => {
            let msg = body;
            if (!isPlain && uid) msg = `<a href="tg://user?id=` + uid + `">👤</a> ` + msg;
            else if (isPlain && uid) msg = `[👤 ` + uid + `] ` + msg;
            const opts = { disable_web_page_preview: true };
            if (!isPlain) opts.parse_mode = "HTML";
            if (replyTo) opts.reply_to_message_id = Number(replyTo);
            return bot.sendMessage(cid, msg, opts);
        });
        if (out.error) return res.status(500).json({ ok: false, error: out.error });
        return res.json({ ok: true, message: "পাঠানো হয়েছে!", messageId: (out.sent && out.sent.message_id) || null });
    } catch (e) {
        return res.status(500).json({ ok: false, error: tlErrHint(e) });
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

// Panel theke Group Chat Lock/Unlock (admin /off /on er same kaj — Firestore flag + native mute try)
app.post("/api/tg/chat-lock", async (req, res) => {
    const { chatId, locked, botId } = req.body;
    if (!chatId || typeof locked === "undefined") return res.status(400).json({ ok: false, error: "chatId + locked দিন" });
    const isLock = locked === true || locked === "true" || locked === 1 || locked === "1";
    const sender = await resolveChatBot(String(chatId), botId);
    try {
        await db.collection("tg_groups").doc(chatId.toString()).set({
            chatOff: isLock,
            chatOffAt: admin.firestore.FieldValue.serverTimestamp(),
            chatOffBy: "panel"
        }, { merge: true });
        groupConfigs.delete(chatId.toString());
        // Native Telegram mute try (permission na thakleo delete-enforcement e lock kaj korbe)
        try {
            if (isLock) {
                await sender.setChatPermissions(chatId.toString(), {
                    can_send_messages: false, can_send_media_messages: false,
                    can_send_polls: false, can_send_other_messages: false,
                    can_add_web_page_previews: false
                });
            } else {
                await sender.setChatPermissions(chatId.toString(), {
                    can_send_messages: true, can_send_media_messages: true,
                    can_send_polls: true, can_send_other_messages: true,
                    can_add_web_page_previews: true
                });
            }
        } catch (e) {}
        try {
            await sender.sendMessage(chatId.toString(),
                isLock ? `🔒 <b>Group chat OFF!</b>\n\nAdmin group chat বন্ধ করেছে — এখন শুধু admin রা message দিতে পারবে।\n<i>(খুলতে: admin /on লিখুন)</i>`
                    : `🔓 <b>Group chat ON!</b>\n\nAdmin group chat খুলে দিয়েছে — সবাই আবার message দিতে পারবে। 🎉`,
                { parse_mode: "HTML" }).catch(() => {});
        } catch (e) {}
        return res.json({ ok: true, message: isLock ? "🔒 Chat locked (OFF)!" : "🔓 Chat unlocked (ON)!" });
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
    const sender = await resolveChatBot(String(chatId), botId);
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
// HTML-escape (user-supplied title/name/desc e '<' hole Telegram parse fail hoto)
function escH(t) { return String(t || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }
function giveawayCaption(g, joined) {
    const wc = Math.max(1, Number(g.winnersCount || 1));
    const endMs = giveawayEndsMs(g);
    const timeLine = endMs
        ? `⏳ <b>Ends in:</b> ${fmtLeft(endMs - Date.now())} (live!)\n`
        : (Number(g.durationH) > 0 ? `⏳ <b>Ends in:</b> ${g.durationH} ঘণ্টা (auto-result!)\n` : `⏳ <b>Ends:</b> admin End চাপলে\n`);
    return `🎊 <b>${escH(g.title)}</b> 🎊\n` +
        `━━━━━━━━━━━━\n` +
        `🎁 <b>Prize:</b> ${escH((g.amount ? g.amount + " " : "") + g.itemName)}\n` +
        (g.desc ? `📝 ${escH(String(g.desc).slice(0, 300))}\n` : ``) +
        `🏆 <b>Winners:</b> ${wc} জন   👥 <b>Joined:</b> ${joined}\n` +
        timeLine +
        `━━━━━━━━━━━━\n` +
        `👇 <b>Join</b> বাটনে চাপ দিয়ে অংশ নাও!`;
}

app.post("/api/tg/create-giveaway", async (req, res) => {
    let { chatId, title, itemName, amount, winnersCount, desc, photoUrl, durationH, bumpH, botId } = req.body;
    if (!chatId || !title || !itemName) return res.status(400).json({ ok: false, error: "সবগুলো তথ্য পূরণ করুন" });
    chatId = String(chatId).trim();
    if (/^\d+$/.test(chatId)) chatId = "-" + chatId; // Chat ID prefix bhul holei thik hoy
    const sender = await resolveChatBot(chatId, botId);
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
    sender = sender || (await resolveChatBot(String(g.chatId), g.botId));
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
    sender = sender || (await resolveChatBot(String(g.chatId), g.botId));
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
                const sender = await resolveChatBot(String(g.chatId), g.botId);
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
        const sender = await resolveChatBot(String(g.chatId), botId || g.botId);
        try {
            await sender.pinChatMessage(g.chatId, g.messageId, { disable_notification: true });
        } catch (pe) {
            return res.status(500).json({ ok: false, error: tlErrHint(pe) });
        }
        await refreshGiveaway(giveawayId, sender);
        return res.json({ ok: true, message: "📌 Re-pinned + refreshed!" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// Shared finish logic — manual End + auto timer দুটোই ব্যবহার করে
// HTML send with plain-text fallback; kono throw nahi — giveaway jate always end hoy
async function sendHtmlBestEffort(sender, chatId, text) {
    try { await sender.sendMessage(chatId, text, { parse_mode: "HTML" }); }
    catch (e) { await sender.sendMessage(chatId, String(text).replace(/<[^>]+>/g, "")).catch(() => {}); }
}

async function finishGiveaway(giveawayId, sender) {
    const gDoc = await db.collection("giveaways").doc(giveawayId).get();
    if (!gDoc.exists) return { ok: false, error: "Giveaway not found" };
    const g = gDoc.data();
    if (g.status === "ended") return { ok: false, error: "ইতিমধ্যে সমাপ্ত হয়েছে" };

    const participants = g.participants || [];
    if (participants.length === 0) {
        await sendHtmlBestEffort(sender, g.chatId, `⚠️ <b>${escH(g.title)} সমাপ্ত:</b> কোনো অংশগ্রহণকারী পাওয়া যায়নি।`);
        await gDoc.ref.update({ status: "ended" });
        return { ok: true, message: "No participants" };
    }

    const shuffled = participants.sort(() => 0.5 - Math.random());
    const winners = shuffled.slice(0, Math.min(g.winnersCount, participants.length));

    let winnerText = `🎊 <b>GIVEAWAY RESULT</b> 🎊\n━━━━━━━━━━━━\n\n🎉 <b>${escH(g.title)}</b>\n🎁 <b>Prize:</b> ${escH((g.amount ? g.amount + " " : "") + g.itemName)}\n👥 <b>Joined:</b> ${participants.length} জন\n\n`;
    winners.forEach((w, idx) => {
        winnerText += `🥇 <b>Winner ${idx + 1}:</b> <a href="tg://user?id=${w.id}">${escH(w.name)}</a> (<code>${w.id}</code>)\n`;
    });
    winnerText += `\n━━━━━━━━━━━━\n🎉 অভিনন্দন! এডমিনের সাথে যোগাযোগ করে পুরস্কার নাও।`;

    await sendHtmlBestEffort(sender, g.chatId, winnerText);
    await sender.unpinChatMessage(g.chatId).catch(() => {});
    await gDoc.ref.update({ status: "ended", winners });

    return { ok: true, winners };
}

app.post("/api/tg/end-giveaway", async (req, res) => {
    const { giveawayId, botId } = req.body;
    try {
        let sender = pickBot(botId) || null;
        let gChat = "";
        if (!sender) {
            try {
                const gd = await db.collection("giveaways").doc(giveawayId).get();
                if (gd.exists) {
                    const gg = gd.data();
                    gChat = String(gg.chatId || "");
                    sender = pickBot(gg.botId);
                }
            } catch (e) {}
        }
        if (!sender && gChat) sender = await resolveChatBot(gChat, null);
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
    const sender = await resolveChatBot(String(chatId), botId);

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
// NOTE: multi-bot group e DEFAULT bot diye check korle fail kore (se bot group e
// nao thakte pare) — tai caller nijer bot instance pathabe. Real admin ke
// member vebe filter/delete korai chilo custom-bot group er boro glitch.
const groupAdminCache = new Map(); // chatId -> { admins: Set, time: number }

async function isGroupAdmin(chatId, fromUser, msg, botInst) {
    if (!fromUser) return false;

    // ১. অ্যানোনিমাস এডমিন বা চ্যানেলের নামে মেসেজ পাঠালে ১০০% এডমিন
    if (fromUser.username === "GroupAnonymousBot" || fromUser.id === 1087968824 || fromUser.id === 136817688) {
        return true;
    }
    if (msg && msg.sender_chat) {
        return true;
    }

    const userId = fromUser.id.toString();
    const api = botInst || groupBot;

    // ২. মেমোরি ক্যাশ চেক (প্রতি ৫ মিনিটে ১ বার রিফ্রেশ, রেট লিমিট প্রটেকশন)
    const cached = groupAdminCache.get(chatId);
    if (cached && (Date.now() - cached.time < 5 * 60 * 1000)) {
        if (cached.admins.has(userId)) return true;
    }

    try {
        const adminList = await api.getChatAdministrators(chatId);
        const adminSet = new Set(adminList.map(a => a.user.id.toString()));
        groupAdminCache.set(chatId, { admins: adminSet, time: Date.now() });
        return adminSet.has(userId);
    } catch (e) {
        if (cached && cached.admins.has(userId)) return true;
        try {
            const m = await api.getChatMember(chatId, fromUser.id);
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
const WIZ_TOGGLES = [["antiLink", "🔗 Anti-Link"], ["antiVideo", "🎥 Anti-Video"], ["antiForward", "📤 Anti-Forward"], ["antiInbox", "📥 Anti-Inbox"], ["antiBot", "🤖 Anti-Bot"], ["antiButton", "🔘 Anti-Button"], ["fakeTitleOn", "🎭 Fake-title"], ["fakeTitleDelete", "🗑️ Fake-title delete"], ["chatOff", "🔒 Chat-Lock (/off)"], ["floodOn", "🌊 Flood"]];
const WIZ_NUMBERS = [["filterDeleteSec", "Filter warn delete (sec)", 0, 300, 4], ["warnDeleteSec", "Gali warn delete (sec)", 0, 300, 5], ["trigCooldownSec", "Trigger gap (sec)", 0, 300, 15], ["welcomeDeleteSec", "Welcome delete (sec)", 0, 300, 10], ["floodLimit", "Flood limit", 2, 50, 6], ["warnLimit", "Warn limit", 2, 20, 5]];
const WIZ_TEXTS = [["warnMsg", "Warn message"], ["floodMsg", "Flood message"], ["welcomeMsg", "Welcome text ({name})"], ["adminGaliMsg", "Admin gali reply ({name})"], ["fakeTitleMsg", "Fake-title decline ({name}/{title}/{id})"], ["lockMsg", "Chat-lock warn"], ["scammerMsg", "Scammer alert"], ["msgs.forward", "Forward warn"], ["msgs.video", "Video warn"], ["msgs.inbox", "Inbox warn"], ["msgs.link", "Link warn"], ["msgs.button", "Button-ad warn"]];
function wizVal(g, key, def) {
    const v = g ? g[key] : undefined;
    if (typeof def === "boolean") return v === true || v === "true" || v === 1;
    if (typeof def === "number") { const n = Number(v); return isFinite(n) ? n : def; }
    return (v === undefined || v === null) ? "" : String(v);
}
function onOff(v) { return v ? "🟢 ON" : "🔴 OFF"; }
// Toggle default: chatOff + antiVideo default OFF, baki sob default ON
function wizDef(field) {
    if (field === "antiVideo" || field === "chatOff") return false;
    if (field === "fakeTitleDelete") return true;
    return true;
}
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
    const lockOn = (g.chatOff === true || g.chatOff === "true" || g.chatOff === 1);
    const t = `📋 <b>${(g.title || g.id || "").slice(0, 60)}</b>\n<code>${g.id}</code>\n\n🛡️ Link:${onOff(g.antiLink !== false)} Forward:${onOff(g.antiForward !== false)}\n🔒 Chat:${lockOn ? "🔴 OFF (locked)" : "🟢 ON"} 🎭 Fake-title:${onOff(g.fakeTitleOn !== false)}${g.fakeTitleDelete === true ? "+del" : ""}\n🤬 Warn:${Number(g.warnLimit) || 5}→${g.warnAction || "ban"} ⏱️ Gap:${g.trigCooldownSec !== undefined ? g.trigCooldownSec : 15}s\n⚡ Triggers:${(g.triggers || []).length} 👑 Admin-reply:${(g.adminTriggers || []).length} 🎉 Welcome:${g.welcomeMode || "global"}\n\nSetting বদলাতে tap করো:`;
    await bot.sendMessage(chatId, t, {
        parse_mode: "HTML", disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [
            [{ text: "🛡️ Filters", callback_data: `wp_f:${g.id}` }, { text: "⏱️ Timers", callback_data: `wp_n:${g.id}` }],
            [{ text: "💬 Replies", callback_data: `wp_r:${g.id}` }, { text: "🎉 Welcome", callback_data: `wp_w:${g.id}` }],
            [{ text: "⚡ Add reply", callback_data: `wp_trig:${g.id}` }, { text: "🗑 Triggers", callback_data: `wp_tl:${g.id}` }],
            [{ text: "👑 Add admin-reply", callback_data: `wp_atrig:${g.id}` }, { text: "🗑 Admin-replies", callback_data: `wp_atl:${g.id}` }],
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
            ...WIZ_TOGGLES.map(([f, label]) => ([{ text: `${label} ${onOff(wizVal(c.g, f, wizDef(f)))}`, callback_data: `wp_tgl:${gid}:${f}` }])),
            [{ text: "🔙 Menu", callback_data: `wp_g:${gid}` }]
        ]);
        return;
    }
    if (kind === "wp_tgl") {
        const field = parts[2];
        if (!WIZ_TOGGLES.some(([f]) => f === field)) { await ack("Unknown!"); return; }
        const c = await wizCheck(bot, q, gid);
        if (!c) return;
        const cur = wizVal(c.g, field, wizDef(field));
        try { await db.collection("tg_groups").doc(String(gid)).set({ [field]: !cur }, { merge: true }); } catch (e) {}
        groupConfigs.delete(String(gid));
        try {
            const gd = await db.collection("tg_groups").doc(String(gid)).get();
            const g2 = { id: gd.id, ...(gd.exists ? gd.data() : {}) };
            groupConfigs.set(g2.id, gd.exists ? gd.data() : {});
            await wizEdit(bot, q, `🛡️ <b>Filters</b> — tap = ON/OFF:`, [
                ...WIZ_TOGGLES.map(([f, label]) => ([{ text: `${label} ${onOff(wizVal(g2, f, wizDef(f)))}`, callback_data: `wp_tgl:${gid}:${f}` }])),
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
    if (kind === "wp_atrig") {
        const c = await wizCheck(bot, q, gid);
        if (!c) return;
        wizMap.set(q.from.id.toString(), { step: "kw", groupId: String(gid), action: "atrig", data: {}, at: Date.now() });
        await ack();
        await bot.sendMessage(q.message.chat.id, `👑 <b>নতুন admin-reply</b> (শুধু admin লিখলে reply যাবে)\n\n1️⃣ Keyword পাঠাও (admin যা লিখবে, যেমন <code>!price</code>):\n(বাতিল: /cancel)`, { parse_mode: "HTML" }).catch(() => {});
        return;
    }
    if (kind === "wp_atl") {
        const c = await wizCheck(bot, q, gid);
        if (!c) return;
        const arr = c.g.adminTriggers || [];
        await wizEdit(bot, q, `👑 <b>Admin-replies</b> (${arr.length}) — ❌ = delete:`, [
            ...arr.slice(0, 15).map((t, i) => ([{ text: `❌ ${(t.keyword || "?").slice(0, 30)}`, callback_data: `wp_adel:${gid}:${i}` }])),
            [{ text: "🔙 Menu", callback_data: `wp_g:${gid}` }]
        ]);
        return;
    }
    if (kind === "wp_adel") {
        const idx = Number(parts[2]);
        const c = await wizCheck(bot, q, gid);
        if (!c || !isFinite(idx)) return;
        const arr = (c.g.adminTriggers || []).slice();
        arr.splice(idx, 1);
        try { await db.collection("tg_groups").doc(String(gid)).update({ adminTriggers: arr }); } catch (e) {}
        groupConfigs.delete(String(gid));
        await ack("Deleted ✅");
        const c2 = await wizCheck(bot, q, gid);
        if (c2) {
            const a2 = c2.g.adminTriggers || [];
            await wizEdit(bot, q, `👑 <b>Admin-replies</b> (${a2.length}):`, [
                ...a2.slice(0, 15).map((t, i) => ([{ text: `❌ ${(t.keyword || "?").slice(0, 30)}`, callback_data: `wp_adel:${gid}:${i}` }])),
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
    if (w.action === "trig" || w.action === "atrig") {
        const isA = w.action === "atrig";
        const arrKey = isA ? "adminTriggers" : "triggers";
        if (w.step === "kw") {
            if (!clean || clean.length > 60) {
                await bot.sendMessage(uid, `❌ 1-60 অক্ষরের keyword দাও! (বাতিল: /cancel)`, { parse_mode: "HTML" }).catch(() => {});
                return;
            }
            w.data.kw = clean; w.step = "reply"; w.at = Date.now();
            wizMap.set(uid, w);
            await bot.sendMessage(uid, `2️⃣ Reply message পাঠাও (${isA ? "admin লিখলে সবাই" : "user"} কী দেখবে):\n(বাতিল: /cancel)`, { parse_mode: "HTML" }).catch(() => {});
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
            const arr = ((gd.data() || {})[arrKey] || []).slice();
            arr.push({ keyword: w.data.kw, reply: w.data.reply, deleteSec: n });
            try { await db.collection("tg_groups").doc(String(w.groupId)).update({ [arrKey]: arr }); } catch (e) {}
            groupConfigs.delete(String(w.groupId));
            wizMap.delete(uid);
            await bot.sendMessage(uid, `✅ <b>${isA ? "Admin-reply" : "Trigger"} saved!</b>\n🔑 <code>${w.data.kw}</code> → reply + ${n}s delete${isA ? " (শুধু admin লিখলে)" : ""}\n\n<code>/panel</code> — menu`, { parse_mode: "HTML" }).catch(() => {});
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
    trigCooldownSec: 15,
    chatOff: false, lockMsg: "",
    fakeTitleDelete: true
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
// Join/Leave/Live event → admin panel (tg_events) e save — panel Trackers tab e dekha jabe
async function logEvent(chatId, type, extra) {
    try {
        extra = extra || {};
        let owner = String(extra.ownerUid || "");
        if (!owner) {
            try {
                const gd = await db.collection("tg_groups").doc(String(chatId)).get();
                if (gd.exists) owner = String((gd.data() || {}).ownerUid || "");
            } catch (e) {}
        }
        await db.collection("tg_events").add({
            chatId: String(chatId),
            type: String(type || "info").slice(0, 30),
            userId: String(extra.userId || ""),
            name: String(extra.name || "").slice(0, 80),
            username: String(extra.username || "").slice(0, 40),
            text: String(extra.text || "").slice(0, 300),
            ownerUid: owner,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
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
                capsOn: false, capsMinLen: 15, capsPercent: 70,
                emojiOn: false, emojiLimit: 5,
                dupOn: false, dupCount: 3,
                newlineOn: false, newlineLimit: 5,
                maxLenOn: false, maxLen: 1000,
                chatOff: false,
                lockMsg: "",
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
// Edit kore gali/link dhokano (edited-message bypass) বন্ধ — message + edited
// message একই engine-এ চলে। Edit-এ flood count হয় না (notun message na)।
async function onGroupUpdate(msg, isEdit) {
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

        // 🔴 LIVE event (voice-chat/live-stream): group e post hobe na,
        // admin DM + admin panel (tg_events) — duijaygatei jabe (liveNotifyOn + notifyAdmins)।
        if (isGroup && (msg.video_chat_started || msg.video_chat_ended || msg.video_chat_scheduled || msg.video_chat_participants_invited)) {
            try {
                let evType = "live_start", evEmoji = "🔴", evTitle = "LIVE cholche!";
                if (msg.video_chat_ended) { evType = "live_end"; evEmoji = "⚫"; evTitle = "LIVE sesh!"; }
                else if (msg.video_chat_scheduled) { evType = "live_scheduled"; evEmoji = "📅"; evTitle = "LIVE scheduled!"; }
                else if (msg.video_chat_participants_invited) { evType = "live_invite"; evEmoji = "📨"; evTitle = "LIVE invite!"; }
                const starterId = (fromUser && !fromUser.is_bot) ? String(fromUser.id) : "";
                const starterName = (fromUser && !fromUser.is_bot)
                    ? cleanName(`${fromUser.first_name || ""} ${fromUser.last_name || ""}`.trim())
                    : "Someone";
                const starterUn = (fromUser && fromUser.username) ? ("@" + fromUser.username) : "None";
                const groupTitle = cleanName(msg.chat.title);
                // gali alert er moto sundor format — clickable name + username + IDs
                const userLine = starterId
                    ? `👤 <a href="tg://user?id=${starterId}">${starterName}</a> ${starterUn} (<code>${starterId}</code>)`
                    : `👤 ${starterName}`;
                // 1) admin panel log (Trackers tab e dekha jabe)
                try {
                    await logEvent(chatId, evType, {
                        userId: starterId, name: starterName, username: starterUn,
                        text: evTitle, ownerUid: (groupConf && groupConf.ownerUid) || ""
                    });
                } catch (e) {}
                // 2) bot DM → gali alert er moto (username soho sundor kore)
                if (cfgBool(groupConf, "liveNotifyOn", true)) {
                    await dmAdmins(chatId, groupConf,
                        `${evEmoji} <b>LIVE Alert</b>\n\n${userLine}\n📍 <b>${groupTitle}</b> (<code>${chatId}</code>)\n🎥 <b>Status:</b> ${evTitle}\n\nGroup call button e chap diye join koro.`);
                }
            } catch (e) {}
            return;
        }

        if (groupConf && groupConf.triggers && groupConf.triggers.length > 0 && text) {
            const cleanUserText = text.toLowerCase().trim();
            const trigCoolSec = cfgNum(groupConf, "trigCooldownSec", 15, 0, 300);
            for (const trig of groupConf.triggers) {
                const kw = (trig.keyword || "").toLowerCase().trim();
                if (kw && trigHit(cleanUserText, kw)) {
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
        // Edit-এ count বাড়ে না (notun message na)
        if (!isEdit) trackMember(chatId, fromUser.id.toString(), currentName, currentUsername, groupConf.ownerUid || "").catch(() => {});

        // Leave log (customize: leaveLogOn) → group msg + admin DM (bot) + admin panel (tg_events)
        if (msg.left_chat_member) {
            try {
                const lv = msg.left_chat_member;
                if (lv && !lv.is_bot) {
                    const lvName = cleanName(`${lv.first_name || ""} ${lv.last_name || ""}`.trim() || "A member");
                    const lvUn = lv.username ? ("@" + lv.username) : "None";
                    const lvId = String(lv.id || "");
                    if (cfgBool(groupConf, "leaveLogOn", true)) {
                        await groupBot.sendMessage(chatId, `👋 <b>${lvName}</b> left the group.`, { parse_mode: "HTML" }).catch(() => {});
                        // admin DM — bot ei pathabe
                        await dmAdmins(chatId, groupConf,
                            `👋 <b>Member left</b>\n\n👤 <a href="tg://user?id=${lvId}">${lvName}</a> ${lvUn} (<code>${lvId}</code>)\n📍 <b>${cleanName(msg.chat.title)}</b> (<code>${chatId}</code>)`);
                    }
                    // admin panel log (ON/OFF nirbisheshe — panel e history thakbe)
                    try {
                        await logEvent(chatId, "leave", {
                            userId: lvId, name: lvName, username: lvUn,
                            text: "left the group", ownerUid: (groupConf && groupConf.ownerUid) || ""
                        });
                    } catch (e) {}
                }
            } catch (e) {}
            return;
        }

        const isAdmin = await isGroupAdmin(chatId, fromUser, msg, groupBot);

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

        // Mod commands — group থেকেই ban/unban/kick/mute/unmute/warn/unwarn (panel খোলা লাগে না, admin only)
        // Target: reply / @mention / tap-mention / ID — sob chole. Ex: /warn @user, /mute @user 30, /warns
        if (isCommand(text, "/ban") || isCommand(text, "/unban") || isCommand(text, "/kick") ||
            isCommand(text, "/mute") || isCommand(text, "/unmute") ||
            isCommand(text, "/warn") || isCommand(text, "/warns") ||
            isCommand(text, "/unwarn") || isCommand(text, "/removewarn") ||
            isCommand(text, "/resetwarn") || isCommand(text, "/clearwarn")) {
            if (!isAdmin) {
                const w = await groupBot.sendMessage(chatId, `⚠️ এই কমান্ড কেবল গ্রুপ এডমিনদের জন্য!`, { parse_mode: "HTML", reply_to_message_id: msgId });
                autoDel(chatId, w.message_id, warnDeleteSec(groupConf));
                return;
            }
            // Target resolver: 1) reply 2) tap-mention entity 3) @username 4) numeric ID
            const getTarget = async () => {
                if (msg.reply_to_message && msg.reply_to_message.from) {
                    const tu = msg.reply_to_message.from;
                    return { id: tu.id.toString(), name: `${tu.first_name || ""} ${tu.last_name || ""}`.trim() || tu.id.toString() };
                }
                try {
                    const ents = msg.entities || msg.caption_entities || [];
                    for (const e of ents) {
                        if (e && e.type === "text_mention" && e.user && e.user.id) {
                            const tu = e.user;
                            return { id: String(tu.id), name: `${tu.first_name || ""} ${tu.last_name || ""}`.trim() || String(tu.id) };
                        }
                    }
                } catch (e) {}
                try {
                    const m = (text || "").match(/@([A-Za-z0-9_]{3,})/);
                    if (m) {
                        const un = m[1].toLowerCase();
                        const snap = await db.collection("tg_members").where("chatId", "==", chatId).limit(200).get().catch(() => null);
                        if (snap) {
                            let found = null;
                            snap.forEach((d) => {
                                if (found) return;
                                const v = d.data() || {};
                                const vu = String(v.username || "").toLowerCase().replace(/^@/, "");
                                if (vu === un && v.userId) found = { id: String(v.userId), name: v.name || ("@" + m[1]) };
                            });
                            if (found && /^\d{5,}$/.test(found.id)) return found;
                        }
                        return { id: "", name: "@" + m[1], notFound: true };
                    }
                } catch (e) {}
                const parts = (text || "").split(/\s+/);
                for (let i = 1; i < parts.length; i++) {
                    const dig = parts[i].replace(/[^0-9]/g, "");
                    if (dig.length >= 5) return { id: dig, name: dig };
                }
                return null;
            };
            const tgt = await getTarget();
            // @mention দিলে কিন্তু user kokhono message দেয়নি (ID resolve হয়নি)
            if (tgt && tgt.notFound) {
                await groupBot.sendMessage(chatId, `❌ <b>${cleanName(tgt.name)}</b> কে member list-এ পাওয়া যায়নি!\nতাকে গ্রুপে একবার message দিতে বলো — তারপর <b>reply</b> / <b>@mention</b> / <b>ID</b> দিয়ে আবার দাও।`, { parse_mode: "HTML", reply_to_message_id: msgId });
                return;
            }
            if (!tgt && !isCommand(text, "/warns")) {
                await groupBot.sendMessage(chatId, `💡 যার উপর চালাবে তাকে <b>reply</b> দাও, <b>@mention</b> করো বা <b>ID</b> লিখো।\nযেমন: <code>/warn @username</code>`, { parse_mode: "HTML", reply_to_message_id: msgId });
                return;
            }
            // Admin / bot nijeke shasti deoa jabe na (punitive commands)
            if (tgt && (isCommand(text, "/ban") || isCommand(text, "/kick") || isCommand(text, "/mute") || isCommand(text, "/warn"))) {
                let prot = "";
                try {
                    const me = await groupBot.getMe().catch(() => null);
                    if (me && String(tgt.id) === String(me.id)) prot = "bot";
                } catch (e) {}
                if (!prot && /^\d+$/.test(String(tgt.id || ""))) {
                    try {
                        const tm = await groupBot.getChatMember(chatId, tgt.id);
                        if (tm && (tm.status === "creator" || tm.status === "administrator")) prot = "admin";
                    } catch (e) {}
                }
                if (prot === "bot") {
                    await groupBot.sendMessage(chatId, `😅 আমাকে শাস্তি দেওয়া যাবে না!`, { parse_mode: "HTML", reply_to_message_id: msgId });
                    return;
                }
                if (prot === "admin") {
                    await groupBot.sendMessage(chatId, `⚠️ <a href="tg://user?id=${tgt.id}">${cleanName(tgt.name)}</a> group <b>admin</b> — admin দের শাস্তি দেওয়া যায় না!`, { parse_mode: "HTML", reply_to_message_id: msgId });
                    return;
                }
            }
            if (isCommand(text, "/ban")) {
                const ok = await groupBot.banChatMember(chatId, tgt.id).then(() => true).catch((e) => { hintNoRights(chatId, e); return false; });
                await groupBot.sendMessage(chatId, ok ? `🔨 <a href="tg://user?id=${tgt.id}">${cleanName(tgt.name)}</a>-কে <b>ব্যান</b> করা হলো!` : `❌ ব্যান করা যায়নি — bot কে <b>Admin</b> (Ban permission) বানানো আছে কিনা দেখো।`, { parse_mode: "HTML" }).catch(() => {});
            } else if (isCommand(text, "/unban")) {
                const ok = await groupBot.unbanChatMember(chatId, tgt.id, { only_if_banned: true }).then(() => true).catch((e) => { hintNoRights(chatId, e); return false; });
                await groupBot.sendMessage(chatId, ok ? `✅ <a href="tg://user?id=${tgt.id}">${cleanName(tgt.name)}</a>-কে <b>আনব্যান</b> করা হলো!` : `❌ আনব্যান করা যায়নি — bot permission দেখো।`, { parse_mode: "HTML" }).catch(() => {});
            } else if (isCommand(text, "/kick")) {
                const ok = await groupBot.banChatMember(chatId, tgt.id).then(() => true).catch((e) => { hintNoRights(chatId, e); return false; });
                if (ok) await groupBot.unbanChatMember(chatId, tgt.id).catch(() => {});
                await groupBot.sendMessage(chatId, ok ? `👢 <a href="tg://user?id=${tgt.id}">${cleanName(tgt.name)}</a>-কে <b>কিক</b> করা হলো!` : `❌ কিক করা যায়নি — bot কে <b>Admin</b> (Ban permission) বানানো আছে কিনা দেখো।`, { parse_mode: "HTML" }).catch(() => {});
            } else if (isCommand(text, "/mute")) {
                // Duration: plain minute (30) ba 30m / 2h / 1d — target ID token skip হয়
                let mins = 60;
                const mparts = (text || "").split(/\s+/);
                for (let i = 1; i < mparts.length; i++) {
                    const tok = mparts[i].trim();
                    if (!tok || tok.startsWith("@")) continue;
                    const dig = tok.replace(/[^0-9]/g, "");
                    if (!dig || (dig === String(tgt.id) && dig.length >= 5)) continue;
                    let n = parseInt(dig, 10);
                    if (!isFinite(n) || n <= 0) continue;
                    const low = tok.toLowerCase();
                    if (low.endsWith("d")) n = n * 1440;
                    else if (low.endsWith("h")) n = n * 60;
                    if (n >= 1 && n <= 10080) { mins = n; break; }
                }
                const ok = await groupBot.restrictChatMember(chatId, tgt.id, {
                    permissions: { can_send_messages: false },
                    until_date: Math.floor(Date.now() / 1000) + mins * 60
                }).then(() => true).catch((e) => { hintNoRights(chatId, e); return false; });
                const durTxt = mins % 1440 === 0 ? `${mins / 1440} দিন` : mins % 60 === 0 ? `${mins / 60} ঘণ্টা` : `${mins} মিনিট`;
                await groupBot.sendMessage(chatId, ok ? `🔇 <a href="tg://user?id=${tgt.id}">${cleanName(tgt.name)}</a>-কে <b>${durTxt} মিউট</b> করা হলো!` : `❌ মিউট করা যায়নি — bot কে <b>Admin</b> (Restrict permission) বানানো আছে কিনা দেখো।`, { parse_mode: "HTML" }).catch(() => {});
            } else if (isCommand(text, "/unmute")) {
                const ok = await groupBot.restrictChatMember(chatId, tgt.id, {
                    permissions: { can_send_messages: true, can_send_media_messages: true, can_send_other_messages: true, can_add_web_page_previews: true }
                }).then(() => true).catch((e) => { hintNoRights(chatId, e); return false; });
                await groupBot.sendMessage(chatId, ok ? `🔊 <a href="tg://user?id=${tgt.id}">${cleanName(tgt.name)}</a>-কে <b>আনমিউট</b> করা হলো!` : `❌ আনমিউট করা যায়নি — bot permission দেখো।`, { parse_mode: "HTML" }).catch(() => {});
            } else if (isCommand(text, "/warn")) {
                const wOwner = await getFreshOwner(chatId, groupConf);
                const n = (await getWarnCount(chatId, tgt.id)) + 1;
                await setWarnCount(chatId, tgt.id, n, wOwner);
                const limit = Math.max(2, Number(groupConf.warnLimit) || 5);
                // Reason: command + target token (@mention/ID) বাদে বাকি লেখা
                const rsn = (text || "").split(/\s+/).slice(1).filter((p) => {
                    if (!p || p.startsWith("@")) return false;
                    const d = p.replace(/[^0-9]/g, "");
                    if (d && d === String(tgt.id) && d.length >= 5) return false;
                    return true;
                }).join(" ").slice(0, 120);
                await groupBot.sendMessage(chatId, `⚠️ <a href="tg://user?id=${tgt.id}">${cleanName(tgt.name)}</a> ওয়ার্ন <b>(${n}/${limit})</b>${rsn ? ` — <i>${cleanName(rsn)}</i>` : ""}`, { parse_mode: "HTML", reply_to_message_id: msgId }).catch(() => {});
                if (n >= limit) {
                    const action = groupConf.warnAction || "ban";
                    if (action === "mute") {
                        await groupBot.restrictChatMember(chatId, tgt.id, { permissions: { can_send_messages: false }, until_date: Math.floor(Date.now() / 1000) + 3600 }).catch((e) => { hintNoRights(chatId, e); });
                        await groupBot.sendMessage(chatId, `🔇 <a href="tg://user?id=${tgt.id}">${cleanName(tgt.name)}</a>-কে <b>১ ঘণ্টার জন্য মিউট</b> করা হলো! (ওয়ার্ন: ${n}/${limit})`, { parse_mode: "HTML" }).catch(() => {});
                    } else if (action === "kick") {
                        await groupBot.banChatMember(chatId, tgt.id).catch((e) => { hintNoRights(chatId, e); });
                        await groupBot.unbanChatMember(chatId, tgt.id).catch(() => {});
                        await groupBot.sendMessage(chatId, `👢 <a href="tg://user?id=${tgt.id}">${cleanName(tgt.name)}</a>-কে <b>কিক</b> করা হলো! (ওয়ার্ন: ${n}/${limit})`, { parse_mode: "HTML" }).catch(() => {});
                    } else if (action !== "warn") {
                        await groupBot.banChatMember(chatId, tgt.id).catch((e) => { hintNoRights(chatId, e); });
                        await groupBot.sendMessage(chatId, `🚨 <a href="tg://user?id=${tgt.id}">${cleanName(tgt.name)}</a>-কে <b>ব্যান</b> করা হলো! (ওয়ার্ন: ${n}/${limit})`, { parse_mode: "HTML" }).catch(() => {});
                    }
                    await clearWarn(chatId, tgt.id);
                }
            } else if (isCommand(text, "/unwarn") || isCommand(text, "/removewarn")) {
                const cur = await getWarnCount(chatId, tgt.id);
                if (cur <= 0) {
                    await groupBot.sendMessage(chatId, `✅ <a href="tg://user?id=${tgt.id}">${cleanName(tgt.name)}</a>-এর কোনো ওয়ার্ন নেই (0)।`, { parse_mode: "HTML", reply_to_message_id: msgId }).catch(() => {});
                } else {
                    const left = cur - 1;
                    if (left <= 0) await clearWarn(chatId, tgt.id);
                    else await setWarnCount(chatId, tgt.id, left, await getFreshOwner(chatId, groupConf));
                    await groupBot.sendMessage(chatId, `↩️ <a href="tg://user?id=${tgt.id}">${cleanName(tgt.name)}</a>-এর ১টা ওয়ার্ন কমানো হলো — বাকি <b>${Math.max(0, left)}</b>`, { parse_mode: "HTML", reply_to_message_id: msgId }).catch(() => {});
                }
            } else if (isCommand(text, "/resetwarn") || isCommand(text, "/clearwarn")) {
                await clearWarn(chatId, tgt.id);
                await groupBot.sendMessage(chatId, `🗑️ <a href="tg://user?id=${tgt.id}">${cleanName(tgt.name)}</a>-এর সব ওয়ার্ন <b>clear</b> করা হলো!`, { parse_mode: "HTML", reply_to_message_id: msgId }).catch(() => {});
            } else if (isCommand(text, "/warns")) {
                const qid = tgt ? tgt.id : fromUser.id.toString();
                const qn = tgt ? tgt.name : currentName;
                const c = await getWarnCount(chatId, qid);
                await groupBot.sendMessage(chatId, `📋 <a href="tg://user?id=${qid}">${cleanName(qn)}</a>-এর ওয়ার্ন: <b>${c}</b>`, { parse_mode: "HTML", reply_to_message_id: msgId }).catch(() => {});
            }
            return;
        }

        // 🔒 Group Chat Lock — admin /off = chat OFF (sob member mute), /on = chat ON
        if (isCommand(text, "/off") || isCommand(text, "/lock") || isCommand(text, "/chatoff") ||
            isCommand(text, "/on") || isCommand(text, "/unlock") || isCommand(text, "/chaton")) {
            const wantLock = isCommand(text, "/off") || isCommand(text, "/lock") || isCommand(text, "/chatoff");
            if (!isAdmin) {
                const w = await groupBot.sendMessage(chatId, `⚠️ এই কমান্ড কেবল গ্রুপ এডমিনদের জন্য!`, { parse_mode: "HTML", reply_to_message_id: msgId }).catch(() => null);
                if (w) autoDel(chatId, w.message_id, warnDeleteSec(groupConf));
                return;
            }
            try {
                await db.collection("tg_groups").doc(chatId).set({
                    chatOff: wantLock,
                    chatOffAt: admin.firestore.FieldValue.serverTimestamp(),
                    chatOffBy: fromUser.id.toString()
                }, { merge: true });
            } catch (e) {}
            groupConf.chatOff = wantLock;
            groupConfigs.set(chatId, groupConf);
            // Native Telegram mute/unmute try (fail holeo delete-enforcement e lock cholbe)
            try {
                if (wantLock) {
                    await groupBot.setChatPermissions(chatId, {
                        can_send_messages: false, can_send_media_messages: false,
                        can_send_polls: false, can_send_other_messages: false,
                        can_add_web_page_previews: false
                    }).catch((e) => { hintNoRights(chatId, e); });
                } else {
                    await groupBot.setChatPermissions(chatId, {
                        can_send_messages: true, can_send_media_messages: true,
                        can_send_polls: true, can_send_other_messages: true,
                        can_add_web_page_previews: true
                    }).catch((e) => { hintNoRights(chatId, e); });
                }
            } catch (e) {}
            await groupBot.sendMessage(chatId,
                wantLock
                    ? `🔒 <b>Group chat OFF!</b>\n\nAdmin chat বন্ধ করেছে — এখন শুধু admin রা message দিতে পারবে।\n<i>(খুলতে: admin /on লিখুন)</i>`
                    : `🔓 <b>Group chat ON!</b>\n\nAdmin chat খুলে দিয়েছে — সবাই আবার message দিতে পারবে। 🎉`,
                { parse_mode: "HTML" }).catch(() => {});
            return;
        }

        // 👑 Admin-only auto-reply (panel → Triggers → Admin Replies):
        // shudhu admin likhle reply jabe. Match = puro keyword / keyword + space / keyword@bot
        if (isAdmin && text && groupConf && Array.isArray(groupConf.adminTriggers) && groupConf.adminTriggers.length > 0) {
            const cleanAdmin = text.toLowerCase().trim();
            for (const at of groupConf.adminTriggers) {
                const kw = ((at && at.keyword) || "").toLowerCase().trim();
                if (!kw) continue;
                if (cleanAdmin === kw || cleanAdmin.startsWith(kw + " ") || cleanAdmin.startsWith(kw + "@")) {
                    if (at.hideCmd) await delMsg(chatId, msgId);
                    const built = buildTriggerMarkup(at);
                    const sendOpts = {
                        reply_to_message_id: at.hideCmd ? undefined : msgId,
                        parse_mode: "HTML",
                        disable_web_page_preview: true
                    };
                    if (built.markup) sendOpts.reply_markup = built.markup;
                    groupBot.sendMessage(chatId, at.reply || "✅", sendOpts).then((sent) => {
                        try {
                            const tdel = cfgNum(at, "deleteSec", 0, 0, 300);
                            if (sent && sent.message_id && tdel > 0) autoDel(chatId, sent.message_id, tdel);
                        } catch (e) {}
                    }).catch(() => {
                        const retry = { disable_web_page_preview: true };
                        if (!at.hideCmd) retry.reply_to_message_id = msgId;
                        if (built.markup) retry.reply_markup = built.markup;
                        groupBot.sendMessage(chatId, at.reply || "✅", retry).catch(() => {});
                    });
                    break;
                }
            }
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

        // 🔒 Chat OFF থাকলে non-admin এর SOB message silent delete (text/photo/sticker/video sob)
        if (cfgBool(groupConf, "chatOff", false)) {
            await delMsg(chatId, msgId);
            // Optional warn (panel theke lockMsg dile) — nahole silent, spam hobe na
            const lm = (groupConf.lockMsg || "").toString().trim().slice(0, 300);
            if (lm) {
                const lk = chatId + ":lockwarn";
                const lastLw = trigCool.get(lk) || 0;
                if (Date.now() - lastLw > 15000) {
                    trigCool.set(lk, Date.now());
                    const w = await groupBot.sendMessage(chatId,
                        `🔒 <b>@${fromUser.username || fromUser.first_name}</b>, ${lm}`,
                        { parse_mode: "HTML" }).catch(() => null);
                    if (w) autoDel(chatId, w.message_id, filterDeleteSec(groupConf));
                }
            }
            return;
        }

        // ০. ফ্লাড কন্ট্রোল (customize: floodOn/Limit/Window/Mute + msg + delete-sec)
        // Anonymous admin (sender_chat) ke flood e dhorbe na; edit notun message na tai count hoy na
        if (!isEdit && cfgBool(groupConf, "floodOn", true) && !isAnonymousAdmin && !msg.sender_chat) {
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
            // kintu real admin na → decline + panel ON থাকলে message DELETE)
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

            // ২. ভিডিও ব্লক (file/document হিসেবে পাঠানো video-ও ধরে)
            const docMime = (msg.document && msg.document.mime_type) ? String(msg.document.mime_type) : "";
            if (groupConf.antiVideo && (msg.video || msg.video_note || docMime.startsWith("video/"))) {
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
                const allowed = linkAllowed(text, groupConf.linkWhitelist);
                if (!allowed) {
                    await delMsg(chatId, msgId);
                    const linkMsg = (groupConf.msgs && groupConf.msgs.link) || "অননুমোদিত লিংক দেওয়া নিষেধ!";
                    const m = await groupBot.sendMessage(chatId, `⚠️ <b>@${fromUser.username || fromUser.first_name}</b>, ${linkMsg}`, { parse_mode: "HTML" }).catch((e) => { hintNoRights(chatId, e); return null; });
                    if (m) autoDel(chatId, m.message_id, filterDeleteSec(groupConf));
                    return;
                }
            }

            // ৪.৫ Dyno-style Automod rules (default OFF — panel → Automod Rules)
            // text rules: caps / emoji-spam / newlines / max-length / duplicate
            if (text) {
                const amDel = filterDeleteSec(groupConf);
                const amUser = `@${fromUser.username || fromUser.first_name}`;
                const amWarn = async (msgText) => {
                    const wm = await groupBot.sendMessage(chatId, `⚠️ <b>${amUser}</b>, ${msgText}`, { parse_mode: "HTML" }).catch((e) => { hintNoRights(chatId, e); return null; });
                    if (wm) autoDel(chatId, wm.message_id, amDel);
                };
                // ALL CAPS
                if (cfgBool(groupConf, "capsOn", false) &&
                    capsHit(text, cfgNum(groupConf, "capsMinLen", 15, 4, 200), cfgNum(groupConf, "capsPercent", 70, 10, 100))) {
                    await delMsg(chatId, msgId);
                    await amWarn((groupConf.msgs && groupConf.msgs.caps) || "অতিরিক্ত বড় হাতের অক্ষর (ALL CAPS) ব্যবহার নিষেধ!");
                    return;
                }
                // EMOJI SPAM
                if (cfgBool(groupConf, "emojiOn", false) &&
                    emojiCount(text) > cfgNum(groupConf, "emojiLimit", 5, 2, 50)) {
                    await delMsg(chatId, msgId);
                    await amWarn((groupConf.msgs && groupConf.msgs.emoji) || "একসাথে এতগুলো emoji পাঠানো নিষেধ!");
                    return;
                }
                // CHAT-CLEARING NEWLINES
                if (cfgBool(groupConf, "newlineOn", false) &&
                    newlineCount(text) > cfgNum(groupConf, "newlineLimit", 5, 2, 30)) {
                    await delMsg(chatId, msgId);
                    await amWarn((groupConf.msgs && groupConf.msgs.newline) || "এতগুলো নতুন লাইন দিয়ে chat clear করা নিষেধ!");
                    return;
                }
                // CHARACTER COUNT (max length)
                if (cfgBool(groupConf, "maxLenOn", false) &&
                    text.length > cfgNum(groupConf, "maxLen", 1000, 200, 4000)) {
                    await delMsg(chatId, msgId);
                    await amWarn((groupConf.msgs && groupConf.msgs.maxlen) || "এত বড় message পাঠানো নিষেধ!");
                    return;
                }
                // DUPLICATE TEXT
                if (cfgBool(groupConf, "dupOn", false) &&
                    dupHit(chatId, userId, text, cfgNum(groupConf, "dupCount", 3, 2, 10))) {
                    await delMsg(chatId, msgId);
                    await amWarn((groupConf.msgs && groupConf.msgs.dup) || "একই message বারবার পাঠানো (duplicate spam) নিষেধ!");
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
}
groupBot.on("message", async (msg) => { await onGroupUpdate(msg, false); });
groupBot.on("edited_message", async (msg) => { await onGroupUpdate(msg, true); });

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
