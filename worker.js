javascript
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const admin = require("firebase-admin");
const TelegramBot = require("node-telegram-bot-api");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

// ---------------- FIREBASE ADMIN INITIALIZATION ----------------
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
    try {
        serviceAccount = require("./serviceAccountKey.json");
    } catch (err) {
        console.warn("[FIREBASE] serviceAccountKey.json not found, waiting for env var");
    }
}

if (!admin.apps.length && serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ---------------- GRAMJS INLINE BUTTON HELPER ----------------
let TgButton = null;
try { TgButton = require("telegram").Button || null; } catch (e) {}
if (!TgButton) { try { TgButton = require("telegram/tl/custom/button").Button; } catch (e) {} }

function buildPrimeButtons() {
    try {
        if (!TgButton || typeof TgButton.url !== "function") return null;
        return [
            [TgButton.url("🚀 Auto Quest (3s) @Ppmod_bot", "https://t.me/Ppmod_bot")],
            [TgButton.url("📢 Official Channel", "https://t.me/googleplaypointhack")],
            [TgButton.url("💬 Support", "https://t.me/Blackmoney54")],
        ];
    } catch (e) { return null; }
}

// ---------------- 1. EXPRESS HTTP SERVER & PING ROUTES ----------------
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.status(200).send("PP MOD Master Engine Active!"));
app.get("/ping", (req, res) => res.status(200).send("pong"));
app.get("/health", (req, res) => res.status(200).json({ status: "ok", uptime: process.uptime() }));

app.listen(PORT, "0.0.0.0", () => console.log(`[HTTP] Server active on port ${PORT}`));

// ---------------- APP GATEWAY: PENDING QUEUE & SWITCH APIS ----------------
app.get("/api/gateway/pending", async (req, res) => {
    try {
        const snap = await db.collection("deposits")
            .where("status", "==", "pending")
            .orderBy("createdAt", "desc")
            .limit(50)
            .get();
        const list = [];
        snap.forEach(d => list.push({ id: d.id, ...d.data() }));
        return res.json({ ok: true, list });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/gateway/approve", async (req, res) => {
    const { depId } = req.body;
    if (!depId) return res.status(400).json({ ok: false, error: "Missing depId" });
    try {
        const approved = await approveDepositById(depId, "App_Manual_Admin");
        return res.json({ ok: true, message: "Deposit Approved!", data: approved });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/gateway/reject", async (req, res) => {
    const { depId, reason } = req.body;
    if (!depId) return res.status(400).json({ ok: false, error: "Missing depId" });
    try {
        const rejected = await rejectDepositById(depId);
        if (reason) {
            await db.collection("deposits").doc(depId).update({ adminMsg: reason });
        }
        return res.json({ ok: true, message: "Deposit Rejected!", data: rejected });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/gateway/toggle-auto", async (req, res) => {
    const { autoDeposit } = req.body;
    try {
        const payload = { autoDeposit: !!autoDeposit };
        if (autoDeposit) payload.autoDepositTurnedOnAt = admin.firestore.FieldValue.serverTimestamp();
        await db.collection("config").doc("app").set(payload, { merge: true });
        return res.json({ ok: true, autoDeposit: !!autoDeposit });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- CREATE RESELLER ACCOUNT API ----------------
app.post("/api/admin/create-reseller", async (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password || password.length < 6) {
        return res.status(400).json({ ok: false, error: "সঠিক ইমেইল ও কমপক্ষে ৬ অক্ষরের পাসওয়ার্ড দিন" });
    }
    try {
        const userRecord = await admin.auth().createUser({
            email: email.trim().toLowerCase(),
            password: password.trim(),
            displayName: (name || "PP Reseller").trim()
        });

        await db.collection("users").doc(userRecord.uid).set({
            uid: userRecord.uid,
            name: (name || "PP Reseller").trim(),
            email: email.trim().toLowerCase(),
            isReseller: true,
            role: "reseller",
            balance: 0,
            playPoints: 0,
            pendingPoints: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return res.json({ ok: true, message: "রিসেলার একাউন্ট সফলভাবে তৈরি হয়েছে!", uid: userRecord.uid });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message || "রিসেলার তৈরি ব্যর্থ হয়েছে" });
    }
});

// ---------------- SMS GATEWAY PARSER & AUTO APPROVAL ----------------
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || "PPMOD_GATEWAY_SEC_2025";

function parseSmsBody(sender, body) {
    if (!body) return null;
    let text = body.replace(/\n/g, " ");
    let method = "bKash", trxId = null, amount = null;

    if (/nagad/i.test(sender) || /nagad/i.test(text)) method = "Nagad";
    else if (/rocket|16216/i.test(sender) || /rocket/i.test(text)) method = "Rocket";

    let trxMatch = text.match(/(?:TrxID|TxnID|Txn|ID)[:\s]*([A-Za-z0-9]{8,12})/i) 
                || text.match(/\b([A-Z0-9]{8,12})\b/);
    if (trxMatch) trxId = trxMatch[1].trim().toUpperCase();

    let amtMatch = text.match(/(?:Tk|Amount|received)[:\s]*([\d,]+(?:\.\d+)?)/i)
                || text.match(/([\d,]+(?:\.\d+)?)\s*Tk/i);
    if (amtMatch) amount = Math.round(parseFloat(amtMatch[1].replace(/,/g, "")));

    if (trxId && amount) {
        return { method, trxId: trxId.toUpperCase(), amount };
    }
    return null;
}

// ---------------- P2P MARKETPLACE BACKEND APIS ----------------
app.post("/api/p2p/payment-sent", async (req, res) => {
    const { dealId, sellerUid, sellerName } = req.body;
    if (!dealId) return res.status(400).json({ ok: false, error: "Missing dealId" });
    try {
        const dealRef = db.collection("p2p_deals").doc(dealId);
        const snap = await dealRef.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: "Deal not found" });
        const deal = snap.data();
        if (deal.status !== "processing") {
            return res.status(400).json({ ok: false, error: "Deal is not in processing state" });
        }

        await dealRef.update({
            status: "payment_sent",
            paymentSentAt: admin.firestore.FieldValue.serverTimestamp(),
            timerStopped: true
        });

        const buyerTgUsername = (deal.buyerTg || "").replace("@", "").trim();
        const alertMsg = `🔔 <b>P2P Payment Notification!</b>\n\n` +
            `🤝 <b>Deal:</b> ${deal.title || "P2P Task"}\n` +
            `👤 <b>Seller:</b> ${sellerName || "A Seller"}\n` +
            `🪙 <b>Coins:</b> ${deal.coins} PP Coins\n\n` +
            `✅ সেলার আপনার দেওয়া লিংকে পেমেন্ট সম্পন্ন করেছেন!\n` +
            `অনুগ্রহ করে অ্যাপে ঢুকে চেক করে কয়েন <b>Release</b> করুন।`;

        let sentViaPrime = false;
        if (buyerTgUsername && primeClients.size > 0) {
            for (const [phone, pRec] of primeClients) {
                try {
                    await pRec.client.sendMessage(buyerTgUsername, { message: alertMsg, parseMode: "html" });
                    sentViaPrime = true;
                    break;
                } catch (pe) {}
            }
        }

        if (!sentViaPrime && deal.buyerUid) {
            const bSnap = await db.collection("users").doc(deal.buyerUid).get();
            const tgChat = bSnap.exists ? bSnap.data().tgChatId : null;
            if (tgChat) {
                await notifyUserTelegram(tgChat, alertMsg);
            }
        }

        return res.json({ ok: true, message: "Payment marked complete & buyer notified" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- ADELL IMAGE CDN UPLOAD PROXY ----------------
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

// ---------------- AUTO CREATE TELEGRAM SECRET GROUP ----------------
app.post("/api/adell/create-tg-group", async (req, res) => {
    const { roomId } = req.body;
    if (!roomId) return res.status(400).json({ ok: false, error: "Missing roomId" });

    try {
        const roomRef = db.collection("adell_rooms").doc(roomId);
        const snap = await roomRef.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: "Room not found" });
        const r = snap.data();

        if (r.tgGroupLink) {
            return res.json({ ok: true, link: r.tgGroupLink });
        }

        let inviteLink = null;
        const groupTitle = `ADELL [${(r.title || "Trade").slice(0, 15)}]`;

        let primaryTgClient = null;
        if (primeClients && primeClients.size > 0) {
            primaryTgClient = primeClients.values().next().value.client;
        } else if (currentClient) {
            primaryTgClient = currentClient;
        }

        if (!primaryTgClient) {
            try { primaryTgClient = await getUsableTelegramClient(); } catch (e) {}
        }

        if (primaryTgClient) {
            try {
                const createRes = await primaryTgClient.invoke(
                    new Api.channels.CreateChannel({
                        title: groupTitle,
                        about: "ADELL Private Escrow Trade Room",
                        megagroup: true
                    })
                );
                
                const channel = createRes.chats && createRes.chats[0];
                if (channel) {
                    const exportRes = await primaryTgClient.invoke(
                        new Api.messages.ExportChatInvite({
                            peer: channel
                        })
                    );
                    inviteLink = exportRes.link;

                    try {
                        await primaryTgClient.sendMessage(channel, {
                            message: `🤝 <b>ADELL Private Trade Room</b>\n\n` +
                                     `📦 <b>Deal:</b> ${r.title || "Trade"}\n` +
                                     `🪙 <b>Escrow:</b> ${r.coins} Coins (হোল্ড করা আছে)\n\n` +
                                     `⚠️ <b>সতর্কবার্তা:</b> ডিল সংক্রান্ত আলোচনা ও প্রুফ এখানে শেয়ার করুন। কাজ সম্পন্ন হলে অ্যাপে ফিরে Slide Confirm করুন।`,
                            parseMode: "html"
                        });
                    } catch (mErr) {}
                }
            } catch (tgErr) {
                console.error("[ADELL TG GROUP CREATION ERR]:", tgErr);
            }
        }

        if (!inviteLink) {
            return res.status(500).json({ ok: false, error: "Telegram group creation failed" });
        }

        await roomRef.update({
            tgGroupLink: inviteLink,
            tgGroupCreatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json({ ok: true, link: inviteLink });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/tg/upload-cdn-photo", upload.single("photo"), async (req, res) => {
    try {
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ ok: false, error: "No photo provided" });
        }
        const logChannel = process.env.ORDER_LOG_CHANNEL || "@ppmododderlog";

        const sentMsg = await userNotifyBot.sendPhoto(logChannel, req.file.buffer, {
            caption: "🖼 <b>ADELL Trade Room Media</b>",
            parse_mode: "HTML"
        }, {
            filename: `adell_${Date.now()}.jpg`,
            contentType: req.file.mimetype || "image/jpeg"
        });

        if (!sentMsg || !sentMsg.photo || !sentMsg.photo.length) {
            throw new Error("Telegram did not return photo payload");
        }

        const largestPhoto = sentMsg.photo[sentMsg.photo.length - 1];
        const fileLink = await userNotifyBot.getFileLink(largestPhoto.file_id);

        return res.json({ ok: true, url: fileLink });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message || "Failed to host on Telegram" });
    }
});

// ---------------- ADELL 2-PARTY SLIDE CONFIRMATION API ----------------
app.post("/api/adell/confirm", async (req, res) => {
    const { roomId, uid } = req.body;
    if (!roomId || !uid) return res.status(400).json({ ok: false, error: "Missing data" });

    try {
        const roomRef = db.collection("adell_rooms").doc(roomId);

        await db.runTransaction(async (t) => {
            const rSnap = await t.get(roomRef);
            if (!rSnap.exists) throw new Error("Room not found");
            const r = rSnap.data();

            const isBuyer = uid === r.buyerUid;
            const isSeller = uid === r.sellerUid;
            if (!isBuyer && !isSeller) throw new Error("Unauthorized");

            const updates = {};
            if (isBuyer) updates.buyerConfirmed = true;
            if (isSeller) updates.sellerConfirmed = true;

            const willBothConfirm = (isBuyer && r.sellerConfirmed) || (isSeller && r.buyerConfirmed);

            if (willBothConfirm) {
                updates.status = "completed";
                updates.completedAt = admin.firestore.FieldValue.serverTimestamp();
                updates.expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);

                const sRef = db.collection("users").doc(r.sellerUid);
                const sSnap = await t.get(sRef);
                const curCoins = sSnap.exists ? Number(sSnap.data().balance || 0) : 0;
                const newCoins = Math.round((curCoins + Number(r.coins) + Number.EPSILON) * 100) / 100;

                t.update(sRef, {
                    balance: newCoins,
                    dealsCompleted: admin.firestore.FieldValue.increment(1)
                });

                const bRef = db.collection("users").doc(r.buyerUid);
                t.update(bRef, {
                    dealsCompleted: admin.firestore.FieldValue.increment(1)
                });
            }

            t.update(roomRef, updates);
        });

        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/p2p/release", async (req, res) => {
    const { dealId, buyerUid } = req.body;
    if (!dealId || !buyerUid) return res.status(400).json({ ok: false, error: "Missing data" });

    try {
        const dealRef = db.collection("p2p_deals").doc(dealId);
        let sellerPoints = 0;
        let sellerUid = null;

        await db.runTransaction(async (t) => {
            const dSnap = await t.get(dealRef);
            if (!dSnap.exists) throw new Error("Deal not found");
            const d = dSnap.data();

            if (d.buyerUid !== buyerUid) throw new Error("Unauthorized buyer");
            if (d.status === "completed") throw new Error("Deal already completed");
            if (!d.sellerUid) throw new Error("No seller attached");

            sellerUid = d.sellerUid;
            sellerPoints = Math.floor(Number(d.coins || 0) * 10);

            const sRef = db.collection("users").doc(sellerUid);
            const sSnap = await t.get(sRef);
            const curPoints = sSnap.exists ? Number(sSnap.data().playPoints || 0) : 0;

            t.update(sRef, { playPoints: curPoints + sellerPoints });
            t.update(dealRef, { status: "completed", completedAt: admin.firestore.FieldValue.serverTimestamp() });
        });

        if (sellerUid) {
            const sSnap = await db.collection("users").doc(sellerUid).get();
            const tgChat = sSnap.exists ? sSnap.data().tgChatId : null;
            if (tgChat) {
                await notifyUserTelegram(tgChat, `🎉 <b>Play Points Received!</b>\n\nবায়ার আপনার P2P ডিলটি রিলিজ করেছেন।\n🪙 <b>+${sellerPoints} Play Points</b> আপনার অ্যাকাউন্টে যুক্ত হয়েছে!`);
            }
        }

        return res.json({ ok: true, sellerPoints });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// Android App SMS Receiver Webhook
app.post("/api/gateway/sms", async (req, res) => {
    const secret = req.headers["x-gateway-secret"] || req.body.secret;
    if (secret !== GATEWAY_SECRET) {
        return res.status(401).json({ ok: false, error: "Unauthorized Gateway App" });
    }

    const { sender, message, timestamp } = req.body;
    if (!message) return res.status(400).json({ ok: false, error: "No message" });

    const parsed = parseSmsBody(sender || "", message);
    if (!parsed) {
        return res.json({ ok: true, matched: false, message: "Ignored (not payment SMS)" });
    }

    const cleanTrx = parsed.trxId.toUpperCase();

    try {
        await db.collection("gateway_sms").doc(cleanTrx).set({
            sender: sender || "Unknown",
            raw: message,
            method: parsed.method,
            trxId: cleanTrx,
            amount: parsed.amount,
            claimed: false,
            receivedAt: timestamp ? new Date(timestamp) : admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        const cfgSnap = await db.collection("config").doc("app").get();
        const cfg = cfgSnap.exists ? cfgSnap.data() : {};
        const isAutoOn = cfg.autoDeposit !== false;

        if (!isAutoOn) {
            return res.json({ ok: true, matched: true, autoApproved: false, note: "Auto-deposit is OFF by Admin" });
        }

        const autoDepStartTime = cfg.autoDepositTurnedOnAt ? cfg.autoDepositTurnedOnAt.toMillis() : 0;
        if (timestamp && autoDepStartTime && timestamp < autoDepStartTime) {
            return res.json({ ok: true, matched: true, autoApproved: false, note: "Ignored: SMS arrived before Auto Gateway was turned ON" });
        }

        const depQuery = await db.collection("deposits")
            .where("status", "==", "pending")
            .where("trxId", "==", cleanTrx)
            .limit(1)
            .get();

        if (!depQuery.empty) {
            const depDoc = depQuery.docs[0];
            const depData = depDoc.data();

            const now = Date.now();
            const depTime = depData.createdAt && depData.createdAt.toMillis ? depData.createdAt.toMillis() : now;
            const smsTime = timestamp || now;

            if (Math.abs(now - smsTime) > 5 * 60 * 1000 || Math.abs(now - depTime) > 5 * 60 * 1000) {
                await db.collection("deposits").doc(depDoc.id).update({
                    status: "rejected",
                    adminMsg: "❌ ৫ মিনিটের বেশি সময় পার হয়ে গেছে! সময়মতো সাবমিট করুন।"
                });
                return res.json({ ok: false, error: "EXPIRED: ৫ মিনিটের বেশি সময় পার হয়ে গেছে!" });
            }

            if (Number(depData.amount) === Number(parsed.amount)) {
                await approveDepositSafe(depDoc.id, depData, parsed.amount, cfg.coinRate || 7);
                return res.json({ ok: true, matched: true, autoApproved: true, depId: depDoc.id });
            } else {
                await db.collection("deposits").doc(depDoc.id).update({
                    status: "rejected",
                    adminMsg: `❌ টাকার পরিমাণ মিলেনি! আসল পেমেন্ট ছিল ${parsed.amount} BDT কিন্তু সাবমিট করেছেন ${depData.amount} BDT`
                });
            }
        }

        return res.json({ ok: true, matched: true, autoApproved: false, message: "Saved in database, awaiting user submission" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/gateway/verify-deposit", async (req, res) => {
    const { depId, trxId, amount } = req.body;
    if (!depId || !trxId) return res.status(400).json({ ok: false, error: "Missing data" });

    const cleanTrx = trxId.toUpperCase().trim();

    try {
        const cfgSnap = await db.collection("config").doc("app").get();
        const cfg = cfgSnap.exists ? cfgSnap.data() : {};
        if (cfg.autoDeposit === false) {
            return res.json({ ok: true, autoApproved: false, note: "Manual Mode" });
        }

        const smsDoc = await db.collection("gateway_sms").doc(cleanTrx).get();
        if (!smsDoc.exists) {
            await db.collection("deposits").doc(depId).update({
                status: "rejected",
                adminMsg: "❌ এই TrxID দিয়ে কোনো টাকা আসেনি বা SMS পাওয়া যায়নি!"
            });
            return res.json({ ok: false, error: "কোনো পেমেন্ট পাওয়া যায়নি! সঠিক TrxID দিন।" });
        }

        const smsData = smsDoc.data();
        const smsTime = smsData.receivedAt && smsData.receivedAt.toMillis ? smsData.receivedAt.toMillis() : Date.now();
        const now = Date.now();

        if (now - smsTime > 5 * 60 * 1000) {
            await db.collection("deposits").doc(depId).update({
                status: "rejected",
                adminMsg: "❌ টাকা পাঠানোর ৫ মিনিটের মধ্যে সাবমিট করেননি!"
            });
            return res.json({ ok: false, error: "টাকা পাঠানোর ৫ মিনিট পার হয়ে গেছে! পুনরায় চেষ্টা করুন।" });
        }

        if (Math.round(Number(smsData.amount)) !== Math.round(Number(amount))) {
            await db.collection("deposits").doc(depId).update({
                status: "rejected",
                adminMsg: `❌ টাকার পরিমাণ ভুল! আসল টাকা ছিল ${smsData.amount} BDT`
            });
            return res.json({ ok: false, error: `টাকার পরিমাণ মিলেনি! আসল পেমেন্ট ছিল ${smsData.amount} BDT` });
        }

        const depDoc = await db.collection("deposits").doc(depId).get();
        await approveDepositSafe(depId, depDoc.data(), smsData.amount, cfg.coinRate || 7);
        return res.json({ ok: true, message: "Approved successfully!" });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- DAILY BONUS ----------------
let bonusCfgCache = { at: 0, enabled: true };
async function getBonusCfg() {
    try {
        if (Date.now() - bonusCfgCache.at < 60000) return bonusCfgCache;
        const c = await db.collection("config").doc("app").get();
        const d = c.exists ? (c.data() || {}) : {};
        bonusCfgCache = { at: Date.now(), enabled: d.bonusEnabled !== false };
    } catch (e) {}
    return bonusCfgCache;
}

function rollBonus() {
    return Math.random() < 0.5 ? 0.1 : 0.2;
}

function dhakaDay(offsetDays) {
    try {
        const t = Date.now() + (offsetDays || 0) * 86400000;
        return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
    } catch (e) {
        return new Date(Date.now() + (offsetDays || 0) * 86400000).toISOString().slice(0, 10);
    }
}

app.post("/api/bonus/claim", async (req, res) => {
    try {
        const body = req.body || {};
        const uid = (body.uid || "").toString();
        if (!uid) return res.status(400).json({ ok: false, error: "Login required" });
        const cfg = await getBonusCfg();
        if (!cfg.enabled) return res.json({ ok: false, error: "Daily bonus ekhon bondho ache" });
        const today = dhakaDay(0), yest = dhakaDay(-1);
        const uref = db.collection("users").doc(uid);
        const out = await db.runTransaction(async (t) => {
            const s = await t.get(uref);
            if (!s.exists) throw new Error("nouser");
            const d = s.data() || {};
            if (d.lastBonusDay === today) throw new Error("claimed");
            const amt = rollBonus();
            const streak = (d.lastBonusDay === yest) ? (Number(d.lastBonusStreak) || 0) + 1 : 1;
            const curBal = Number(d.balance) || 0;
            const newBal = Math.round((curBal + amt + Number.EPSILON) * 100) / 100;
            t.update(uref, {
                balance: newBal,
                lastBonusDay: today,
                lastBonusStreak: streak
            });
            t.set(db.collection("redemptions").doc(), {
                uid: uid,
                name: (body.name || d.name || "User").toString().slice(0, 60),
                email: (body.email || d.email || "").toString().slice(0, 120),
                code: "DAILY", amount: amt,
                note: "Daily bonus +" + amt + " - day " + streak,
                status: "approved",
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                expiresAt: new Date(Date.now() + 10 * 86400000)
            });
            return { bonus: amt, streak: streak };
        });
        return res.json({ ok: true, bonus: out.bonus, streak: out.streak });
    } catch (e) {
        const m = (e && e.message) || "";
        if (m === "claimed") return res.json({ ok: false, error: "Ajker bonus neya hoyeche" });
        return res.json({ ok: false, error: "Bonus failed, abar try korun" });
    }
});

app.get("/api/bonus/status", async (req, res) => {
    try {
        const uid = ((req.query || {}).uid || "").toString();
        if (!uid) return res.status(400).json({ ok: false, error: "uid" });
        const cfg = await getBonusCfg();
        const s = await db.collection("users").doc(uid).get();
        const d = s.exists ? (s.data() || {}) : {};
        const isClaimed = d.lastBonusDay === dhakaDay(0);
        
        const nowServer = Date.now();
        const dhakaNextMidnight = new Date(new Date(nowServer).toLocaleString("en-US", { timeZone: "Asia/Dhaka" }));
        dhakaNextMidnight.setHours(24, 0, 0, 0);
        const msUntilNext = Math.max(0, dhakaNextMidnight.getTime() - new Date(new Date(nowServer).toLocaleString("en-US", { timeZone: "Asia/Dhaka" })).getTime());
        const serverNextClaimAt = nowServer + msUntilNext;

        return res.json({ 
            ok: true, 
            enabled: cfg.enabled, 
            claimed: isClaimed, 
            streak: Number(d.lastBonusStreak) || 0,
            serverNow: nowServer,
            nextClaimAt: isClaimed ? serverNextClaimAt : 0
        });
    } catch (e) { return res.json({ ok: false, error: "status failed" }); }
});

async function approveDepositById(depId, verifiedBy = "Admin_Telegram") {
    const depDoc = await db.collection("deposits").doc(depId).get();
    if (!depDoc.exists) throw new Error("Deposit document not found");
    const depData = depDoc.data();
    if (depData.status !== "pending") throw new Error("Deposit already processed (" + depData.status + ")");

    const cfgSnap = await db.collection("config").doc("app").get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : {};
    await approveDepositSafe(depId, depData, depData.amount, cfg.coinRate || 7);
    return depData;
}

async function rejectDepositById(depId) {
    const depDoc = await db.collection("deposits").doc(depId).get();
    if (!depDoc.exists) throw new Error("Deposit not found");
    await db.collection("deposits").doc(depId).update({
        status: "rejected",
        rejectedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return depDoc.data();
}

async function approveDepositSafe(depId, depData, verifiedAmount, coinRate) {
    const cleanTrx = depData.trxId.toUpperCase();
    await db.runTransaction(async (t) => {
        const usedRef = db.collection("used_trx").doc(cleanTrx);
        const usedSnap = await t.get(usedRef);
        if (usedSnap.exists) throw new Error("TRX_ALREADY_USED");

        const depRef = db.collection("deposits").doc(depId);
        const ds = await t.get(depRef);
        if (!ds.exists || ds.data().status !== "pending") throw new Error("DEP_INVALID");

        const rate = Number(coinRate || 7);
        const coinsToAdd = Number(depData.coins) || Math.floor(Number(verifiedAmount) / rate) || 3;

        const userRef = db.collection("users").doc(depData.uid);
        const userSnap = await t.get(userRef);

        if (!userSnap.exists) {
            t.set(userRef, {
                uid: depData.uid,
                name: depData.name || "User",
                email: depData.email || "",
                photo: "",
                balance: coinsToAdd,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } else {
            t.update(userRef, { balance: (Number(userSnap.data().balance) || 0) + coinsToAdd });
        }

        let durationSec = 2;
        if (depData.createdAt && depData.createdAt.toMillis) {
            durationSec = Math.max(1, Math.round((Date.now() - depData.createdAt.toMillis()) / 1000));
        }

        t.update(depRef, {
            status: "approved",
            autoApproved: true,
            submittedAt: depData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
            smsReceivedAt: depData.smsReceivedAt || admin.firestore.FieldValue.serverTimestamp(),
            approvedAt: admin.firestore.FieldValue.serverTimestamp(),
            processDurationSec: durationSec
        });

        t.set(usedRef, {
            trxId: cleanTrx,
            uid: depData.uid,
            amount: verifiedAmount,
            depId: depId,
            usedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const smsRef = db.collection("gateway_sms").doc(cleanTrx);
        t.set(smsRef, {
            claimed: true,
            claimedBy: depData.uid,
            claimedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    });

    try {
        const uSnap = await db.collection("users").doc(depData.uid).get();
        const tgChat = uSnap.exists ? uSnap.data().tgChatId : null;
        if (tgChat) {
            await notifyUserTelegram(tgChat,
                `✅ <b>ডিপোজিট সফলভাবে অ্যাপ্রুভ হয়েছে!</b>\n\n` +
                `💳 <b>মেথড:</b> ${depData.method}\n` +
                `💵 <b>টাকা:</b> ${verifiedAmount} BDT\n` +
                `🪙 <b>প্রাপ্ত কয়েন:</b> ${Number(depData.coins) || 3} Coins\n` +
                `🔖 <b>TrxID:</b> <code>${cleanTrx}</code>\n\n` +
                `আপনার ব্যালেন্স স্বয়ংক্রিয়ভাবে যোগ করা হয়েছে! 🚀`
            );
        }
    } catch (e) {}
}

// ---------------- REFERRAL SYSTEM API ----------------
const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function makeRefCode() {
    let c = "";
    for (let i = 0; i < 6; i++) c += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
    return c;
}

app.post("/api/ref/join", async (req, res) => {
    const code = (req.body.code || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    const uid = (req.body.uid || "").toString().trim().slice(0, 64);
    if (!code || !uid) return res.status(400).json({ ok: false });
    try {
        const rcSnap = await db.collection("refcodes").doc(code).get();
        if (!rcSnap.exists) return res.json({ ok: false, error: "invalid" });
        const ownerUid = (rcSnap.data().uid || "").toString();
        if (!ownerUid || ownerUid === uid) return res.json({ ok: false, error: "self" });
        const uRef = db.collection("users").doc(uid);
        const uSnap = await uRef.get();
        if (!uSnap.exists) return res.json({ ok: false, error: "nouser" });
        if ((uSnap.data().referredBy || "").toString()) return res.json({ ok: true, already: true });
        await uRef.update({ referredBy: ownerUid });
        await db.collection("users").doc(ownerUid).set({
            refCount: admin.firestore.FieldValue.increment(1)
        }, { merge: true });
        return res.json({ ok: true, owner: ownerUid });
    } catch (e) {
        return res.status(500).json({ ok: false });
    }
});

async function creditReferralBonus(buyerUid, orderId, gameName) {
    try {
        if (!buyerUid || !orderId) return;
        const oRef = db.collection("orders").doc(orderId);
        const oSnap = await oRef.get();
        const od = oSnap.exists ? oSnap.data() : {};
        if (od.refPaid === true) return;
        const buyerId = (od.uid || buyerUid || "").toString();
        if (!buyerId) return;
        const bSnap = await db.collection("users").doc(buyerId).get();
        const ownerUid = bSnap.exists ? (bSnap.data().referredBy || "").toString().trim() : "";
        await oRef.set({ refPaid: true }, { merge: true });
        if (!ownerUid || ownerUid === buyerId) return;
        await db.collection("users").doc(ownerUid).set({
            balance: admin.firestore.FieldValue.increment(1),
            refEarned: admin.firestore.FieldValue.increment(1)
        }, { merge: true });
        await db.collection("redemptions").add({
            uid: ownerUid, name: "", email: "", code: "REFERRAL", amount: 1,
            note: "Referral bonus: 1 task completed" + (gameName ? " (" + gameName + ")" : ""),
            status: "approved", createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: new Date(Date.now() + 10 * 86400000)
        });
        try {
            const oSnap2 = await db.collection("users").doc(ownerUid).get();
            const tg = oSnap2.exists ? (oSnap2.data().tgChatId || "").toString().trim() : "";
            if (tg) {
                await notifyUserTelegram(tg,
                    `🎁 <b>Referral Bonus!</b>\n\nআপনার রেফারে ১টি টাস্ক সম্পন্ন হয়েছে।\n🪙 <b>+1 PP Coin</b> যোগ হয়েছে!`
                );
            }
        } catch (e) {}
    } catch (e) {}
}

// ---------------- PENDING POINTS AUTO-MATURER ----------------
setInterval(async () => {
    try {
        const snap = await db.collection("pending_points").where("status", "==", "pending").limit(50).get();
        if (snap.empty) return;
        const now = Date.now();
        for (const d of snap.docs) {
            const v = d.data() || {};
            let ms = 0;
            try { ms = v.unlockAt && v.unlockAt.toMillis ? v.unlockAt.toMillis() : 0; } catch (e) {}
            if (!ms || ms > now) continue;
            const pts = Number(v.points) || 0;
            if (!pts) continue;
            try {
                await db.runTransaction(async (t) => {
                    const pref = db.collection("pending_points").doc(d.id);
                    const ps = await t.get(pref);
                    if (!ps.exists || (ps.data().status || "pending") !== "pending") return;
                    t.update(pref, { status: "live", movedAt: admin.firestore.FieldValue.serverTimestamp() });
                    if (v.uid && v.uid !== "guest") {
                        const uref = db.collection("users").doc(v.uid);
                        const us = await t.get(uref);
                        if (us.exists) {
                            t.update(uref, {
                                playPoints: (Number(us.data().playPoints) || 0) + pts,
                                pendingPoints: Math.max(0, (Number(us.data().pendingPoints) || 0) - pts)
                            });
                        }
                    }
                });
                try {
                    if (v.uid && v.uid !== "guest") {
                        const uSnap = await db.collection("users").doc(v.uid).get();
                        const tg = uSnap.exists ? (uSnap.data().tgChatId || "").toString().trim() : "";
                        if (tg) await notifyUserTelegram(tg, `🎉 <b>${pts} Points Live হয়েছে!</b>\n\nPending সময় শেষ — এখন withdraw করতে পারবেন।`);
                    }
                } catch (e) {}
            } catch (e) {}
        }
    } catch (e) {}
}, 5 * 60 * 1000);

// ---------------- P2P 23H EXPIRE & ESCROW AUTO-REFUND ----------------
setInterval(async () => {
    try {
        const now = Date.now();
        const openDeals = await db.collection("p2p_deals")
            .where("status", "==", "open")
            .limit(30)
            .get();

        for (const docSnap of openDeals.docs) {
            const d = docSnap.data();
            let expireAtMs = 0;
            if (d.expiresAt && d.expiresAt.toMillis) expireAtMs = d.expiresAt.toMillis();
            else if (d.createdAt && d.createdAt.toMillis) expireAtMs = d.createdAt.toMillis() + (23 * 3600 * 1000);

            if (expireAtMs && now >= expireAtMs) {
                const refundCoins = Number(d.escrowCoins || d.totalCoinsWithFee || d.coins || 0);
                await db.runTransaction(async (t) => {
                    const dRef = db.collection("p2p_deals").doc(docSnap.id);
                    const freshSnap = await t.get(dRef);
                    if (!freshSnap.exists || freshSnap.data().status !== "open") return;

                    t.update(dRef, {
                        status: "expired_refunded",
                        expiredAt: admin.firestore.FieldValue.serverTimestamp()
                    });

                    if (d.buyerUid && refundCoins > 0) {
                        const uRef = db.collection("users").doc(d.buyerUid);
                        const uSnap = await t.get(uRef);
                        if (uSnap.exists) {
                            const curBal = Number(uSnap.data().balance || 0);
                            t.update(uRef, { balance: curBal + refundCoins });
                        }
                    }
                });

                if (d.buyerUid) {
                    const uSnap = await db.collection("users").doc(d.buyerUid).get();
                    const tg = uSnap.exists ? (uSnap.data().tgChatId || "").toString().trim() : "";
                    if (tg) {
                        await notifyUserTelegram(tg, `⌛ <b>P2P Ad Expired & Refunded</b>\n\n২৩ ঘণ্টায় কোনো সেলার ডিল না নেওয়ায় <b>${refundCoins} PP Coins</b> আপনার ওয়ালেটে ফেরত দেওয়া হয়েছে।`);
                    }
                }
            }
        }

        const procDeals = await db.collection("p2p_deals")
            .where("status", "==", "processing")
            .limit(30)
            .get();

        for (const docSnap of procDeals.docs) {
            const d = docSnap.data();
            let linkExpMs = 0;
            if (d.linkExpiresAt && d.linkExpiresAt.toMillis) linkExpMs = d.linkExpiresAt.toMillis();
            else if (d.expiresAt && d.expiresAt.toMillis) linkExpMs = d.expiresAt.toMillis();

            if (linkExpMs && now >= linkExpMs && !d.timerStopped) {
                await db.collection("p2p_deals").doc(docSnap.id).update({
                    status: "locked_review",
                    timerStopped: true,
                    isLocked: true,
                    timedOutAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        }
    } catch (e) {
        console.warn("[P2P CRON WARN]:", e.message);
    }
}, 2 * 60 * 1000);

// ---------------- 10-DAY HISTORY RETENTION ----------------
const RET_D = 10 * 86400000;
function tsMs(v) {
    try {
        if (!v) return 0;
        if (typeof v.toMillis === "function") return v.toMillis();
        const n = new Date(v).getTime();
        return isNaN(n) ? 0 : n;
    } catch (e) { return 0; }
}

async function refundAndDelete(d, v, field, amount) {
    try {
        const uid = (v.uid || "").toString();
        const amt = Math.max(0, Math.floor(Number(amount) || 0));
        if (uid && uid !== "guest" && amt > 0) {
            const uref = db.collection("users").doc(uid);
            const us = await uref.get();
            if (us.exists) {
                const cur = Number(us.data()[field] || 0);
                await uref.update({ [field]: cur + amt });
            }
        }
        await d.ref.delete();
        return true;
    } catch (e) { return false; }
}

async function runRetentionOnce() {
    try {
        const cutoff = Date.now() - RET_D;
        let total = 0;
        const CAP = 25;
        const jobs = [
            ["deposits", "createdAt", "del"],
            ["orders", "createdAt", "refund:balance:amount"],
            ["redemptions", "createdAt", "del"],
            ["withdrawals", "createdAt", "refund:playPoints:points"],
            ["gateway_sms", "receivedAt", "del"],
            ["logs", "createdAt", "del"]
        ];
        for (const [col, tf, mode] of jobs) {
            try {
                const qs = await db.collection(col).where(tf, "<", new Date(cutoff)).limit(CAP).get();
                if (qs.empty) continue;
                for (const d of qs.docs) {
                    try {
                        const v = d.data() || {};
                        const ms = tsMs(v[tf]);
                        if (!ms || ms >= cutoff) continue;
                        const st = (v.status || "").toString();
                        if (st === "pending" || st === "paid") {
                            const fresh = await d.ref.get().catch(() => null);
                            if (!fresh || !fresh.exists) continue;
                            const fv = fresh.data() || {};
                            const fst = (fv.status || "").toString();
                            if (fst !== "pending" && fst !== "paid") continue;
                            if (mode.indexOf("refund:") === 0) {
                                const parts = mode.split(":");
                                if (await refundAndDelete(d, fv, parts[1], fv[parts[2]])) total++;
                            } else {
                                await d.ref.delete();
                                total++;
                            }
                        } else {
                            await d.ref.delete();
                            total++;
                        }
                    } catch (e) {}
                }
            } catch (e) {}
        }
        try {
            const qs = await db.collection("pending_points").where("status", "==", "live").limit(CAP).get();
            if (!qs.empty) {
                for (const d of qs.docs) {
                    try {
                        const v = d.data() || {};
                        const ms = tsMs(v.unlockAt) || tsMs(v.movedAt) || tsMs(v.createdAt);
                        if (ms && ms < cutoff) { await d.ref.delete(); total++; }
                    } catch (e) {}
                }
            }
        } catch (e) {}
        if (total) console.log("[RETENTION] 10d+ purono " + total + " doc deleted");
    } catch (e) {}
}
setInterval(runRetentionOnce, 6 * 60 * 60 * 1000);
setTimeout(runRetentionOnce, 2 * 60 * 1000);

// ---------------- TELEGRAM CONFIGURATIONS ----------------
const DEFAULT_API_ID = 39447470;
const DEFAULT_API_HASH = "eb7cac1c8ad9935d4b208dc0da076d8c";
const TARGET_BOT = process.env.TARGET_BOT || "PlayQuestHelperBot";

const USER_NOTIFY_BOT_TOKEN = process.env.USER_NOTIFY_BOT_TOKEN || "8906230491:AAEu4CX0T9Dz6YMLxeCNz6U-nbiQmiBiJ_s";
const ORDER_LOG_CHANNEL = process.env.ORDER_LOG_CHANNEL || "@ppmododderlog";

const userNotifyBot = new TelegramBot(USER_NOTIFY_BOT_TOKEN, { polling: true });
userNotifyBot.on("polling_error", () => {});

const PRIME_AUTO_REPLY_IMG = "https://pub-4c6b2dbf3a0c4862a8964b1546de6283.r2.dev/1791345238749_file_000000003d348211a5a894b5cf98d67c.png";
const PRIME_AUTO_REPLY_CAPTION = `👋 <b>হ্যালো!</b>\n\nএডমিন অনলাইনে আসলে আপনার মেসেজের রিপ্লাই দেওয়া হবে। আপনার কী প্রয়োজন তা নিচে লিখে রাখুন।\n\n⚡ <b>Auto Quest Complete মাত্র ৩ সেকেন্ডে:</b>\n👉 <a href="https://t.me/Ppmod_bot">@Ppmod_bot</a>\n\n📢 <b>অফিসিয়াল চ্যানেল:</b> <a href="https://t.me/googleplaypointhack">@googleplaypointhack</a>\n\nধন্যবাদ! ✨`;

let currentClient = null;
let currentPhone = null;
const primeClients = new Map();
let primeClient = null;
let primePhone = null;

const activeOrders = new Set();
const autoReplyCooldown = new Map();
const pendingAuthClients = new Map();

function formatBdPhone(raw) {
    let num = (raw || "").toString().replace(/[^0-9]/g, "");
    if (num.startsWith("880")) return "+" + num;
    if (num.startsWith("0")) return "+880" + num.substring(1);
    if (num.startsWith("1") && num.length === 10) return "+880" + num;
    return "+" + num;
}

// ---------------- USER BOT REFERRAL SYSTEM ----------------
const REQUIRED_CHANNELS = [
    { name: "📢 Main Channel", url: "https://t.me/googleplaypointhack", username: "@googleplaypointhack" },
    { name: "📋 All Order Log", url: "https://t.me/ppmododderlog", username: "@ppmododderlog" },
    { name: "💬 Community Group", url: "https://t.me/GPPHMCOMMUNITY", username: "@GPPHMCOMMUNITY" },
    { name: "🔒 Private Channel (Request)", url: "https://t.me/+s09ahNjWHZM4YWM9", invite: true }
];

function generateReferralCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let randomPart = "";
    for (let i = 0; i < 6; i++) {
        randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `PPM-REF-${randomPart}`;
}

async function checkUserMembership(userId) {
    for (const ch of REQUIRED_CHANNELS) {
        if (!ch.username) continue;
        try {
            const member = await userNotifyBot.getChatMember(ch.username, userId);
            const valid = ["creator", "administrator", "member", "restricted"].includes(member.status);
            if (!valid) return false;
        } catch (e) {}
    }
    return true;
}

function getJoinKeyboard(userId, refId = null) {
    const rows = REQUIRED_CHANNELS.map((ch, idx) => [
        { text: `${idx + 1}. ${ch.name}`, url: ch.url }
    ]);
    const verifyData = refId ? `verify_ref:${refId}` : "verify_ref:none";
    rows.push([{ text: "✅ Verify / চেক করুন", callback_data: verifyData }]);
    rows.push([{ text: "👥 আমার রেফারেল লিংক ও পরিসংখ্যান", callback_data: "my_ref_info" }]);
    return { inline_keyboard: rows };
}

function buildUserAdminCard(uid, uData) {
    const cleanBal = Math.round(((Number(uData.balance) || 0) + Number.EPSILON) * 100) / 100;
    const cleanPoints = Number(uData.playPoints) || 0;
    const isBanned = uData.banned === true;
    const joinDate = uData.createdAt && uData.createdAt.toDate ? uData.createdAt.toDate().toLocaleString("en-GB", { timeZone: "Asia/Dhaka" }) : "—";

    const curStars = Number(uData.loyaltyStars || 0);
    const text = 
        `👤 <b>USER PROFILE MANAGEMENT</b>\n\n` +
        `📛 <b>Name:</b> ${uData.name || "User"}\n` +
        `📧 <b>Email:</b> <code>${uData.email || "No Email"}</code>\n` +
        `🆔 <b>UID:</b> <code>${uid}</code>\n` +
        `🪙 <b>PP Coins:</b> <b>${cleanBal} Coins</b>\n` +
        `⭐ <b>Play Points:</b> <b>${cleanPoints} Pts</b>\n` +
        `🎖️ <b>Loyalty Stars:</b> <b>${curStars} / 10 Stars</b>\n` +
        `✈️ <b>Telegram:</b> ${uData.tgChatId || "Not Connected"}\n` +
        `📅 <b>Joined:</b> ${joinDate}\n` +
        `📌 <b>Status:</b> ${isBanned ? "🚫 <b>BANNED</b>" : "✅ <b>ACTIVE</b>"}`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: isBanned ? "✅ Unban User" : "🚫 Ban User", callback_data: `u_toggle_ban:${uid}` },
                { text: "🔄 Refresh", callback_data: `u_refresh:${uid}` }
            ],
            [
                { text: "➕ Add Coins", callback_data: `u_ask_add:${uid}` },
                { text: "➖ Deduct Coins", callback_data: `u_ask_sub:${uid}` }
            ],
            [
                { text: "⭐ +1 Star", callback_data: `u_mod_star:${uid}:1` },
                { text: "⭐ -1 Star", callback_data: `u_mod_star:${uid}:-1` }
            ]
        ]
    };

    return { text, reply_markup: keyboard };
}

userNotifyBot.on("message", async (msg) => {
    try {
        const text = (msg.text || "").trim();
        const replyTo = msg.reply_to_message;
        const chatId = msg.chat.id;

        if (replyTo && replyTo.text) {
            const repText = replyTo.text;
            const uidMatch = repText.match(/UID:\s*([A-Za-z0-9_-]+)/i);

            if (uidMatch) {
                const targetUid = uidMatch[1].trim();
                const numVal = parseFloat(text);

                if (!isNaN(numVal) && numVal > 0) {
                    const isAdd = repText.includes("কত কয়েন যোগ করতে চান");
                    const isSub = repText.includes("কত কয়েন কাটতে চান");

                    if (isAdd || isSub) {
                        const changeAmt = isAdd ? numVal : -numVal;
                        const uRef = db.collection("users").doc(targetUid);
                        let updatedBal = 0;

                        await db.runTransaction(async (t) => {
                            const uSnap = await t.get(uRef);
                            if (!uSnap.exists) throw new Error("User not found");
                            const cur = Number(uSnap.data().balance) || 0;
                            updatedBal = Math.max(0, Math.round((cur + changeAmt + Number.EPSILON) * 100) / 100);
                            t.update(uRef, { balance: updatedBal });
                        });

                        const uDoc = await uRef.get();
                        const card = buildUserAdminCard(targetUid, uDoc.data());

                        await userNotifyBot.sendMessage(chatId,
                            `✅ <b>সফল!</b> ব্যালেন্সে <b>${isAdd ? '+' : '-'}${numVal} Coins</b> আপডেট হয়েছে।\n🪙 বর্তমান মোট ব্যালেন্স: <b>${updatedBal} Coins</b>`,
                            { parse_mode: "HTML", reply_to_message_id: msg.message_id }
                        );

                        return userNotifyBot.sendMessage(chatId, card.text, {
                            parse_mode: "HTML",
                            reply_markup: card.reply_markup
                        });
                    }
                }
            }
        }

        if (text === "/logoff") {
            isAutoFakeLogEnabled = false;
            await db.collection("config").doc("app").set({ autoFakeLog: false }, { merge: true });
            return userNotifyBot.sendMessage(msg.chat.id, "🛑 <b>চ্যানেলে ফেক অর্ডার লগ পাঠানো বন্ধ (OFF) করা হয়েছে!</b>", { parse_mode: "HTML" });
        }
        if (text === "/logon") {
            isAutoFakeLogEnabled = true;
            await db.collection("config").doc("app").set({ autoFakeLog: true }, { merge: true });
            return userNotifyBot.sendMessage(msg.chat.id, "✅ <b>চ্যানেলে ফেক অর্ডার লগ পাঠানো চালু (ON) করা হয়েছে!</b>", { parse_mode: "HTML" });
        }

        const adminId = process.env.ADMIN_TG_ID || "7504616242";
        const isFromAdmin = msg.chat.id.toString() === adminId || (msg.from && msg.from.id.toString() === adminId);

        let searchUid = null;
        if (isFromAdmin && !text.startsWith("/") && text.length >= 20 && !text.includes(" ") && !text.includes("\n")) {
            searchUid = text;
        } else if (isFromAdmin && text.startsWith("/user ")) {
            searchUid = text.replace("/user ", "").trim();
        }

        if (searchUid) {
            const uDoc = await db.collection("users").doc(searchUid).get();
            if (uDoc.exists) {
                const card = buildUserAdminCard(searchUid, uDoc.data());
                return userNotifyBot.sendMessage(msg.chat.id, card.text, { parse_mode: "HTML", reply_markup: card.reply_markup });
            } else {
                return userNotifyBot.sendMessage(msg.chat.id, `❌ <code>${searchUid}</code> এই UID দিয়ে কোনো ইউজার পাওয়া যায়নি!`, { parse_mode: "HTML" });
            }
        }

        if (replyTo && (text === "✅" || text === "❌" || text === "/approve" || text === "/reject" || text.toLowerCase() === "approve")) {
            const replyText = replyTo.text || replyTo.caption || "";
            const depMatch = replyText.match(/🆔\s*<b>DepID:<\/b>\s*<code>([A-Za-z0-9_-]+)<\/code>/i)
                          || replyText.match(/DepID:\s*([A-Za-z0-9_-]+)/i)
                          || replyText.match(/🔖\s*<b>TrxID:<\/b>\s*<code>([A-Za-z0-9_-]+)<\/code>/i);

            if (!depMatch) return;
            const identifier = depMatch[1].trim();

            if (text === "✅" || text === "/approve" || text.toLowerCase() === "approve") {
                let targetId = identifier;
                if (!identifier.startsWith("DEP_") && identifier.length < 15) {
                    const snap = await db.collection("deposits").where("trxId", "==", identifier).where("status", "==", "pending").limit(1).get();
                    if (!snap.empty) targetId = snap.docs[0].id;
                }

                try {
                    const approvedData = await approveDepositById(targetId);
                    await userNotifyBot.sendMessage(msg.chat.id, 
                        `✅ <b>DEPOSIT APPROVED SUCCESSFULLY!</b>\n\n` +
                        `👤 <b>User:</b> ${approvedData.name || "User"} (${approvedData.email || ""})\n` +
                        `🪙 <b>Coins Added:</b> ${approvedData.coins || 3} Coins\n` +
                        `💵 <b>Amount:</b> ${approvedData.amount} BDT\n` +
                        `🔖 <b>TrxID:</b> <code>${approvedData.trxId}</code>\n\n` +
                        `<i>ইউজারের একাউন্টে সফলভাবে কয়েন যোগ হয়েছে এবং TrxID লক করা হয়েছে! 🚀</i>`,
                        { parse_mode: "HTML", reply_to_message_id: msg.message_id }
                    );
                } catch (err) {
                    await userNotifyBot.sendMessage(msg.chat.id, `⚠️ অ্যাপ্রুভ ব্যর্থ: ${err.message || 'Error'}`, { reply_to_message_id: msg.message_id });
                }
            } else if (text === "❌" || text === "/reject") {
                try {
                    await rejectDepositById(identifier);
                    await userNotifyBot.sendMessage(msg.chat.id, 
                        `❌ <b>ডিপোজিটটি বাতিল (Rejected) করা হয়েছে!</b>`,
                        { parse_mode: "HTML", reply_to_message_id: msg.message_id }
                    );
                } catch (err) {
                    await userNotifyBot.sendMessage(msg.chat.id, `⚠️ রিজেক্ট ব্যর্থ: ${err.message}`, { reply_to_message_id: msg.message_id });
                }
            }
        }
    } catch (e) {}
});

userNotifyBot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();
        const startParam = (match && match[1]) ? match[1].trim() : "";
        let inviterId = null;

        if (startParam.startsWith("ref_")) {
            inviterId = startParam.replace("ref_", "").trim();
            if (inviterId === userId) inviterId = null;
        }

        const userDoc = await db.collection("tg_bot_users").doc(userId).get();
        if (!userDoc.exists) {
            await db.collection("tg_bot_users").doc(userId).set({
                id: userId,
                name: `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim(),
                username: msg.from.username ? `@${msg.from.username}` : "",
                inviterId: inviterId || null,
                isVerified: false,
                referralCount: 0,
                rewardsEarned: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } else if (!userDoc.data().isVerified && inviterId && !userDoc.data().inviterId) {
            await db.collection("tg_bot_users").doc(userId).update({ inviterId });
        }

        const welcomeText = 
            `👋 <b>হ্যালো ${msg.from.first_name || "ইউজার"}!</b>\n\n` +
            `PP MOD অফিসিয়াল বটে আপনাকে স্বাগতম। 🚀\n\n` +
            `🎁 <b>স্পেশাল রেফারেল অফার:</b>\n` +
            `প্রতি <b>১০ জন সফল রেফারে</b> আপনি পাবেন একটি <b>৩ PP Coins</b>-এর ফ্রি রিডিম কোড!\n\n` +
            `⚠️ <b>বট অ্যাক্টিভ ও রেফার কাউন্ট হতে নিচের ৪টি লিংকেই জয়েন ও রিকোয়েস্ট পাঠান:</b>\n` +
            `১. <a href="https://t.me/googleplaypointhack">Main Channel</a>\n` +
            `২. <a href="https://t.me/ppmododderlog">All Order Log</a>\n` +
            `৩. <a href="https://t.me/GPPHMCOMMUNITY">Community Group</a>\n` +
            `৪. <a href="https://t.me/+s09ahNjWHZM4YWM9">Private Channel (Request Join)</a>\n\n` +
            `সবগুলোতে জয়েন করে নিচের <b>"Verify / চেক করুন"</b> বাটনে চাপ দিন।`;

        await userNotifyBot.sendMessage(chatId, welcomeText, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: getJoinKeyboard(userId, inviterId)
        });
    } catch (e) {}
});

userNotifyBot.on("callback_query", async (query) => {
    try {
        const chatId = query.message.chat.id;
        const userId = query.from.id.toString();
        const data = query.data || "";

        if (data.startsWith("u_toggle_ban:")) {
            const targetUid = data.replace("u_toggle_ban:", "").trim();
            const uRef = db.collection("users").doc(targetUid);
            const uSnap = await uRef.get();
            if (uSnap.exists) {
                const newBannedState = !(uSnap.data().banned === true);
                await uRef.update({ banned: newBannedState });
                await userNotifyBot.answerCallbackQuery(query.id, {
                    text: newBannedState ? "🚫 ইউজার ব্যান করা হয়েছে!" : "✅ ইউজার আনব্যান করা হয়েছে!",
                    show_alert: true
                });
                const updatedSnap = await uRef.get();
                const card = buildUserAdminCard(targetUid, updatedSnap.data());
                return userNotifyBot.editMessageText(card.text, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: "HTML",
                    reply_markup: card.reply_markup
                });
            }
            return userNotifyBot.answerCallbackQuery(query.id, { text: "User not found!" });
        }

        if (data.startsWith("u_ask_add:")) {
            const targetUid = data.replace("u_ask_add:", "").trim();
            await userNotifyBot.answerCallbackQuery(query.id);
            return userNotifyBot.sendMessage(chatId,
                `➕ <b>ব্যালেন্স যোগ করুন</b>\n🆔 <b>UID:</b> <code>${targetUid}</code>\n\nকত কয়েন যোগ করতে চান? সংখ্যাটি লিখে এই মেসেজে Reply দিন (যেমন: 10 বা 50):`,
                {
                    parse_mode: "HTML",
                    reply_markup: { force_reply: true, selective: true }
                }
            );
        }

        if (data.startsWith("u_ask_sub:")) {
            const targetUid = data.replace("u_ask_sub:", "").trim();
            await userNotifyBot.answerCallbackQuery(query.id);
            return userNotifyBot.sendMessage(chatId,
                `➖ <b>ব্যালেন্স কাটুন</b>\n🆔 <b>UID:</b> <code>${targetUid}</code>\n\nকত কয়েন কাটতে চান? সংখ্যাটি লিখে এই মেসেজে Reply দিন (যেমন: 5 বা 20):`,
                {
                    parse_mode: "HTML",
                    reply_markup: { force_reply: true, selective: true }
                }
            );
        }

        if (data.startsWith("u_mod_star:")) {
            const parts = data.split(":");
            const targetUid = parts[1];
            const change = Number(parts[2]) || 0;
            const uRef = db.collection("users").doc(targetUid);
            let newStars = 0;

            await db.runTransaction(async (t) => {
                const uSnap = await t.get(uRef);
                if (!uSnap.exists) throw new Error("User not found");
                const cur = Number(uSnap.data().loyaltyStars || 0);
                newStars = Math.max(0, Math.min(10, cur + change));
                t.update(uRef, { loyaltyStars: newStars });
            });

            await userNotifyBot.answerCallbackQuery(query.id, { text: `⭐ Stars: ${newStars}/10 applied!` });
            const updatedSnap = await uRef.get();
            const card = buildUserAdminCard(targetUid, updatedSnap.data());
            return userNotifyBot.editMessageText(card.text, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: "HTML",
                reply_markup: card.reply_markup
            });
        }

        if (data.startsWith("u_refresh:")) {
            const targetUid = data.replace("u_refresh:", "").trim();
            const uSnap = await db.collection("users").doc(targetUid).get();
            if (uSnap.exists) {
                await userNotifyBot.answerCallbackQuery(query.id, { text: "Refreshed! 🔄" });
                const card = buildUserAdminCard(targetUid, uSnap.data());
                return userNotifyBot.editMessageText(card.text, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: "HTML",
                    reply_markup: card.reply_markup
                });
            }
        }

        if (data.startsWith("verify_ref:")) {
            const isAllJoined = await checkUserMembership(userId);
            if (!isAllJoined) {
                return userNotifyBot.answerCallbackQuery(query.id, {
                    text: "❌ আপনি সবগুলো চ্যানেলে জয়েন করেননি! সবগুলোতে জয়েন করে আবার চাপুন।",
                    show_alert: true
                });
            }

            const userRef = db.collection("tg_bot_users").doc(userId);
            const userSnap = await userRef.get();
            const userData = userSnap.exists ? userSnap.data() : {};

            if (userData.isVerified) {
                return userNotifyBot.answerCallbackQuery(query.id, {
                    text: "✅ আপনি ইতিমধ্যে ভেরিফাইড!",
                    show_alert: true
                });
            }

            await userRef.set({
                isVerified: true,
                verifiedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            await userNotifyBot.answerCallbackQuery(query.id, {
                text: "🎉 সফলভাবে ভেরিফিকেশন সম্পন্ন হয়েছে!",
                show_alert: true
            });

            await userNotifyBot.sendMessage(chatId, 
                `✅ <b>ভেরিফিকেশন সফল হয়েছে!</b>\n\nএখন থেকে আপনি রেফার করে রিডিম কোড জিততে পারবেন এবং সমস্ত আপডেট সরাসরি পাবেন।`,
                {
                    parse_mode: "HTML",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "👥 আমার রেফারেল লিংক দেখুন", callback_data: "my_ref_info" }]
                        ]
                    }
                }
            );

            const inviterId = userData.inviterId;
            if (inviterId) {
                const inviterRef = db.collection("tg_bot_users").doc(inviterId);
                const inviterSnap = await inviterRef.get();

                if (inviterSnap.exists) {
                    const invData = inviterSnap.data();
                    const newCount = (Number(invData.referralCount) || 0) + 1;
                    const prevRewards = Number(invData.rewardsEarned) || 0;
                    const eligibleRewards = Math.floor(newCount / 10);

                    await inviterRef.update({ referralCount: newCount });

                    const remaining = 10 - (newCount % 10 === 0 ? 0 : newCount % 10);
                    await userNotifyBot.sendMessage(inviterId,
                        `🎉 <b>নতুন রেফার সম্পন্ন হয়েছে!</b>\n\n` +
                        `👤 <a href="tg://user?id=${userId}">${query.from.first_name || "User"}</a> আপনার লিংকে সফলভাবে ভেরিফাই হয়েছে।\n\n` +
                        `👥 মোট সফল রেফার: <b>${newCount}</b> জন\n` +
                        `🎯 পরবর্তী ৩ কয়েন রিডিম কোডের জন্য আর <b>${remaining === 0 ? 10 : remaining}</b> জন রেফার প্রয়োজন!`,
                        { parse_mode: "HTML" }
                    ).catch(() => {});

                    if (eligibleRewards > prevRewards) {
                        const newRewardCount = eligibleRewards - prevRewards;
                        for (let i = 0; i < newRewardCount; i++) {
                            const newCode = generateReferralCode();

                            await db.collection("codes").doc(newCode).set({
                                amount: 3,
                                maxUses: 1,
                                used: 0,
                                active: true,
                                note: "Referral Bonus: 10 Referrals Completed!",
                                createdAt: admin.firestore.FieldValue.serverTimestamp()
                            });

                            await userNotifyBot.sendMessage(inviterId,
                                `🎁 <b>অভিনন্দন! আপনার ১০টি সফল রেফার সম্পন্ন হয়েছে!</b>\n\n` +
                                `আপনার ৩ কয়েন রিডিম কোড:\n<code>${newCode}</code>\n\n` +
                                `👉 এখনই PP MOD অ্যাপ ওপেন করে <b>Profile > Redeem Code</b> বক্সে কোডটি দিয়ে ৩টি PP Coins ক্লেইম করে নিন! ✨`,
                                { parse_mode: "HTML" }
                            ).catch(() => {});
                        }
                        await inviterRef.update({ rewardsEarned: eligibleRewards });
                    }
                }
            }
            return;
        }

        if (data === "my_ref_info") {
            const userSnap = await db.collection("tg_bot_users").doc(userId).get();
            const uData = userSnap.exists ? userSnap.data() : {};
            const refCount = Number(uData.referralCount) || 0;
            const rewards = Number(uData.rewardsEarned) || 0;
            const needed = 10 - (refCount % 10 === 0 && refCount > 0 ? 0 : refCount % 10);
            const botInfo = await userNotifyBot.getMe();
            const refLink = `https://t.me/${botInfo.username}?start=ref_${userId}`;

            const infoMsg = 
                `👥 <b>আপনার রেফারেল ড্যাশবোর্ড</b>\n\n` +
                `🔗 <b>আপনার রেফারেল লিংক:</b>\n<code>${refLink}</code>\n\n` +
                `📊 <b>মোট সফল রেফার:</b> ${refCount} জন\n` +
                `🎁 <b>মোট প্রাপ্ত রিডিম কোড:</b> ${rewards} টি\n` +
                `🎯 <b>পরবর্তী কোডের জন্য বাকি:</b> ${needed === 0 ? 10 : needed} জন\n\n` +
                `<i>আপনার রেফারেল লিংক বন্ধুদের মাঝে শেয়ার করুন এবং প্রতি ১০ জন ভেরিফাইড রেফারে জিতে নিন ৩ কয়েন ফ্রি রিডিম কোড!</i>`;

            await userNotifyBot.answerCallbackQuery(query.id);
            await userNotifyBot.sendMessage(chatId, infoMsg, {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "📤 শেয়ার করুন", url: `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent("PP MOD-এ জয়েন করুন এবং জিতে নিন ফ্রি গুগল প্লে পয়েন্ট কয়েন!")}` }]
                    ]
                }
            });
            return;
        }
    } catch (e) {}
});

// ---------------- 6. MULTI-PRIME AUTO-RESPONDER ----------------
function attachPrimeHandler(client, label) {
    client.addEventHandler(async (event) => {
        try {
            const msg = event.message;
            if (!msg || msg.out || !event.isPrivate) return;
            const sender = await msg.getSender();
            if (!sender || sender.bot) return;

            const senderId = sender.id.toString();
            if (!(await primeCooldownClaim(senderId, label))) return;

            await new Promise((r) => setTimeout(r, 3500));
            const replyBtns = buildPrimeButtons();
            try {
                await client.sendMessage(sender.id, {
                    file: PRIME_AUTO_REPLY_IMG,
                    message: PRIME_AUTO_REPLY_CAPTION,
                    parseMode: "html",
                    ...(replyBtns ? { buttons: replyBtns } : {})
                });
            } catch (e2) {
                await client.sendMessage(sender.id, {
                    file: PRIME_AUTO_REPLY_IMG,
                    message: PRIME_AUTO_REPLY_CAPTION,
                    parseMode: "html"
                });
            }
        } catch (err) {}
    }, new NewMessage({ incoming: true }));
}

async function initPrimeAutoResponder() {
    try {
        const snap = await db.collection("tg_accounts").where("isPrime", "==", true).get();
        if (snap.empty) {
            for (const [ph, rec] of primeClients) {
                try { await rec.client.disconnect(); } catch (e) {}
            }
            primeClients.clear();
            primeClient = null;
            primePhone = null;
            return;
        }
        const wanted = new Map();
        snap.forEach(d => {
            const v = d.data() || {};
            const phone = v.phone || d.id;
            if (v.session) wanted.set(phone, { id: d.id, session: v.session, phone });
        });

        for (const [ph, rec] of primeClients) {
            if (!wanted.has(ph)) {
                try { await rec.client.disconnect(); } catch (e) {}
                primeClients.delete(ph);
            }
        }

        for (const [phone, info] of wanted) {
            if (primeClients.has(phone)) continue;
            try {
                const client = new TelegramClient(new StringSession(info.session), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 5 });
                await client.connect();
                attachPrimeHandler(client, phone);
                primeClients.set(phone, { client, connectedAt: Date.now(), docId: info.id });
            } catch (e) {}
        }

        const first = primeClients.keys().next();
        if (!first.done) {
            primePhone = first.value;
            primeClient = primeClients.get(primePhone).client;
        } else {
            primeClient = null;
            primePhone = null;
        }
    } catch (e) {}
}

async function primeCooldownClaim(senderId, primeLabel) {
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const key = primeLabel ? (primeLabel + ':' + senderId) : senderId;
    try {
        const ref = db.collection("tg_autoreply").doc(key);
        const snap = await ref.get();
        const last = snap.exists ? Number(snap.data().lastAt || 0) : 0;
        if (Date.now() - last < ONE_DAY_MS) return false;
        await ref.set({ lastAt: Date.now() }, { merge: true });
        return true;
    } catch (e) {
        const last = autoReplyCooldown.get(senderId) || 0;
        if (Date.now() - last < ONE_DAY_MS) return false;
        autoReplyCooldown.set(senderId, Date.now());
        return true;
    }
}

app.get("/api/tg/prime-status", async (req, res) => {
    try {
        const snap = await db.collection("tg_accounts").where("isPrime", "==", true).get();
        const wanted = [];
        snap.forEach(d => wanted.push(d.data().phone || d.id));
        const online = Array.from(primeClients.keys());
        return res.json({ ok: true, wanted, online, count: { wanted: wanted.length, online: online.length } });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 7. OFFICIAL SESSION GENERATOR ENGINE ----------------
app.post("/api/tg/send-otp", async (req, res) => {
    const rawInput = req.body.phone || "";
    const phone = formatBdPhone(rawInput);

    if (!phone || phone.length < 13) {
        return res.status(400).json({ ok: false, error: "সঠিক মোবাইল নম্বর দিন (যেমন: 017XXXXXXXX)" });
    }

    try {
        const client = new TelegramClient(new StringSession(""), DEFAULT_API_ID, DEFAULT_API_HASH, {
            connectionRetries: 5,
            useWSS: false,
            deviceModel: "Chrome Web 122",
            systemVersion: "Windows 11",
            appVersion: "1.0.0",
            langCode: "en",
            systemLangCode: "en"
        });

        await client.connect();

        const result = await client.sendCode({
            apiId: DEFAULT_API_ID,
            apiHash: DEFAULT_API_HASH
        }, phone);

        pendingAuthClients.set(phone, {
            client: client,
            phoneCodeHash: result.phoneCodeHash,
            createdAt: Date.now()
        });

        return res.json({ ok: true, message: "টেলিগ্রামে লগইন কোড পাঠানো হয়েছে!", phone });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.errorMessage || err.message || "Failed to send code" });
    }
});

async function computeSrpHash(client, password) {
    if (typeof client.checkPassword === "function") {
        return await client.checkPassword(password);
    }
    let computeFn = null;
    const candidates = [
        () => require("telegram/Password").computeCheckPassword,
        () => require("telegram/Password"),
        () => require("telegram/Password.js").computeCheckPassword,
        () => require("telegram/Password.js"),
        () => require("telegram").computeCheckPassword,
        () => require("telegram").Password?.computeCheckPassword,
        () => require("telegram/Utils")?.computeCheckPassword
    ];
    for (const cand of candidates) {
        try {
            const fn = cand();
            if (typeof fn === "function") { computeFn = fn; break; }
            if (fn && typeof fn.default === "function") { computeFn = fn.default; break; }
            if (fn && typeof fn.computeCheckPassword === "function") { computeFn = fn.computeCheckPassword; break; }
        } catch (e) {}
    }
    const srpResult = await client.invoke(new Api.account.GetPassword());
    if (computeFn) return await computeFn(srpResult, password);
    throw new Error("2FA Password module resolution failed");
}

app.post("/api/tg/verify-otp", async (req, res) => {
    const phone = formatBdPhone(req.body.phone || "");
    const code = (req.body.code || "").toString().trim();
    const password = (req.body.password || "").toString().trim();

    const item = pendingAuthClients.get(phone);
    if (!item) return res.status(400).json({ ok: false, error: "সেশনের মেয়াদ শেষ! আবার নম্বর দিন।" });

    try {
        try {
            await item.client.invoke(new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash: item.phoneCodeHash,
                phoneCode: code
            }));
        } catch (signInErr) {
            if (signInErr.errorMessage === "SESSION_PASSWORD_NEEDED" || (signInErr.message && (signInErr.message.includes("2FA") || signInErr.message.includes("PASSWORD")))) {
                if (!password) return res.status(400).json({ ok: false, error: "Two-Step পাসওয়ার্ড দিন" });

                if (typeof item.client.checkPassword === "function") {
                    await item.client.checkPassword(password);
                } else {
                    const passwordSrpHash = await computeSrpHash(item.client, password);
                    await item.client.invoke(new Api.auth.CheckPassword({ password: passwordSrpHash }));
                }
            } else {
                throw signInErr;
            }
        }

        const sessionString = item.client.session.save();
        const docId = phone.replace('+', '');
        await db.collection("tg_accounts").doc(docId).set({
            phone,
            session: sessionString,
            balance: 0,
            active: true,
            isPrime: false,
            addedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        pendingAuthClients.delete(phone);
        return res.json({ ok: true, message: "অ্যাকাউন্ট সফলভাবে কানেক্ট হয়েছে!", phone, session: sessionString });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.errorMessage || err.message || "ভেরিফিকেশন ব্যর্থ" });
    }
});

// ---------------- 8. REAL BALANCE AUDIT API ----------------
function parseBotBalance(text) {
    if (!text) return null;
    const match = text.match(/(?:balance|new balance|current balance)\s*[:\-]?\s*(\d+)/i) 
               || text.match(/(\d+)\s*(?:tokens|token|🪙)/i);
    return match ? Number(match[1]) : null;
}

app.post("/api/tg/check-balance", async (req, res) => {
    try {
        const snap = await db.collection("tg_accounts").get();
        if (snap.empty) return res.json({ ok: false, error: "কোনো অ্যাকাউন্ট নেই" });

        let totalBalance = 0;
        const results = [];

        for (const docSnap of snap.docs) {
            const acc = docSnap.data();
            const phone = acc.phone || docSnap.id;
            if (!acc.session) continue;

            try {
                const tempClient = new TelegramClient(new StringSession(acc.session), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 5 });
                await tempClient.connect();
                await tempClient.sendMessage(TARGET_BOT, { message: "🚀 Start Process" });
                await new Promise((r) => setTimeout(r, 2500));

                const msgs = await tempClient.getMessages(TARGET_BOT, { limit: 1 });
                let b = null;
                if (msgs && msgs.length > 0) b = parseBotBalance(msgs[0].message);

                if (b !== null) {
                    await db.collection("tg_accounts").doc(docSnap.id).update({
                        balance: b, lastCheckedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                    totalBalance += b;
                    results.push({ phone, balance: b });
                } else {
                    results.push({ phone, balance: acc.balance || 0 });
                }
                await tempClient.disconnect();
            } catch (err) {
                results.push({ phone, balance: acc.balance || 0 });
            }
        }

        await db.collection("config").doc("app").set({
            botTokensTotal: totalBalance, botTokensLastSync: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return res.json({ ok: true, total: totalBalance, accounts: results });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

async function clickInlineButton(message, textPattern) {
    if (!message || !message.replyMarkup || !message.replyMarkup.rows) return false;
    for (const row of message.replyMarkup.rows) {
        for (const button of row.buttons) {
            if (button.text && button.text.toLowerCase().includes(textPattern.toLowerCase())) {
                try {
                    await message.click({ text: button.text });
                    return true;
                } catch (e) {}
            }
        }
    }
    return false;
}

app.post("/api/tg/claim-daily-all", async (req, res) => {
    try {
        const snap = await db.collection("tg_accounts").where("active", "==", true).get();
        if (snap.empty) return res.json({ ok: false, error: "কোনো অ্যাকাউন্ট নেই" });

        const results = [];
        for (const docSnap of snap.docs) {
            const acc = docSnap.data();
            const phone = acc.phone || docSnap.id;
            if (!acc.session) continue;

            const temp = new TelegramClient(new StringSession(acc.session), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 5 });
            try {
                await temp.connect();
                await temp.sendMessage(TARGET_BOT, { message: "🎁 Rewards Hub" });
                await new Promise((r) => setTimeout(r, 2200));
                const msgs = await temp.getMessages(TARGET_BOT, { limit: 2 });
                const targetMsg = (msgs && msgs.length > 0) ? (msgs.find(m => !m.out) || msgs[0]) : null;

                if (targetMsg) {
                    let clicked = await clickInlineButton(targetMsg, "Claim Today");
                    if (!clicked) clicked = await clickInlineButton(targetMsg, "Claim");
                    if (!clicked) clicked = await clickInlineButton(targetMsg, "Daily");

                    const msgTxt = (targetMsg.message || "").toLowerCase();
                    if (clicked) {
                        results.push({ phone, ok: true, message: "Daily Reward Claimed! 🎁" });
                    } else if (msgTxt.includes("claimed") || msgTxt.includes("left")) {
                        results.push({ phone, ok: true, message: "Already Claimed Today (Streak Active)" });
                    } else {
                        results.push({ phone, ok: false, message: "Could not claim or button not active" });
                    }
                }
            } catch (e) {
                results.push({ phone, ok: false, message: e.message });
            } finally {
                try { await temp.disconnect(); } catch (e) {}
            }
            await new Promise((r) => setTimeout(r, 1500));
        }
        return res.json({ ok: true, results });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/tg/redeem-code-all", async (req, res) => {
    const code = (req.body.code || "").toString().trim();
    if (!code) return res.status(400).json({ ok: false, error: "প্রোমো কোডটি দিন" });

    try {
        const snap = await db.collection("tg_accounts").where("active", "==", true).get();
        if (snap.empty) return res.json({ ok: false, error: "কোনো অ্যাকাউন্ট নেই" });

        const results = [];
        for (const docSnap of snap.docs) {
            const acc = docSnap.data();
            const phone = acc.phone || docSnap.id;
            if (!acc.session) continue;

            const temp = new TelegramClient(new StringSession(acc.session), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 5 });
            try {
                await temp.connect();
                await temp.sendMessage(TARGET_BOT, { message: "🎁 Rewards Hub" });
                await new Promise((r) => setTimeout(r, 2000));
                const msgs = await temp.getMessages(TARGET_BOT, { limit: 1 });
                if (msgs && ms0 && msgs.length > 0) {
                    await clickInlineButton(msgs[0], "Redeem Promo");
                    await new Promise((r) => setTimeout(r, 2000));
                    await temp.sendMessage(TARGET_BOT, { message: code });
                    results.push({ phone, ok: true, message: "Promo Sent!" });
                }
            } catch (e) {
                results.push({ phone, ok: false, message: e.message });
            } finally {
                try { await temp.disconnect(); } catch (e) {}
            }
            await new Promise((r) => setTimeout(r, 2000));
        }
        return res.json({ ok: true, results });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ---------------- 10. USER NOTIFY HELPER ----------------
function maskGmail(email) {
    const e = (email || "").toString().trim();
    const at = e.lastIndexOf("@");
    if (at <= 1) return e ? "++++++" : "—";
    return "++++++" + e.slice(at - 3, at) + e.slice(at);
}

async function sendOrderLog(text) {
    if (!text) return;
    try {
        await fetch(`https://api.telegram.org/bot${USER_NOTIFY_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: ORDER_LOG_CHANNEL, text: text, parse_mode: "HTML" })
        });
    } catch (e) {}
}

let isAutoFakeLogEnabled = true;

(async () => {
    try {
        const cSnap = await db.collection("config").doc("app").get();
        if (cSnap.exists && cSnap.data().autoFakeLog !== undefined) {
            isAutoFakeLogEnabled = cSnap.data().autoFakeLog;
        }
    } catch (e) {}
})();

const POPULAR_GAMES_LOG = [
    "8ball pool (50)", "Angry birds 2 (50)", "Best Fiends (50)", "Dice dreams (50)",
    "Domino dreams (50)", "Farm heroes (50)", "Hey day (All)", "Lords mobile (50)",
    "Mobile legends (50)", "Summoners War (50)", "Fruit ninja (50)", "Zenless Zone Zero (50)",
    "War machines (50)", "Yalla Ludo (50)"
];
const EMAIL_SNIPPETS = ["has", "rak", "tan", "784", "902", "sh", "joy", "fah", "321", "nah", "kab", "551", "al", "sak", "619", "mim"];

function generateRealisticFakeLog() {
    const game = POPULAR_GAMES_LOG[Math.floor(Math.random() * POPULAR_GAMES_LOG.length)];
    const snip = EMAIL_SNIPPETS[Math.floor(Math.random() * EMAIL_SNIPPETS.length)];
    const maskedEmail = `++++++${snip}@gmail.com`;
    const elapsed = Math.floor(Math.random() * 6) + 6;
    const trxId = "WLT-" + Math.random().toString(36).substring(2, 9).toUpperCase();

    return `✅ <b>TASK COMPLETED</b>\n\n` +
           `🎮 <b>Game:</b> ${game}\n` +
           `📧 <b>Gmail:</b> <code>${maskedEmail}</code>\n` +
           `⏱️ <b>Time:</b> ~${elapsed}s\n` +
           `🪙 <b>Coins:</b> 3\n` +
           `💳 <b>Method:</b> PP Coins\n` +
           `🔖 <b>TrxID:</b> <code>${trxId}</code>\n` +
           `📌 <b>Status:</b> Completed`;
}

function scheduleNextFakeOrderLog() {
    const randomMinutes = Math.floor(Math.random() * (25 - 8 + 1)) + 8;
    const delayMs = randomMinutes * 60 * 1000;
    setTimeout(async () => {
        try {
            if (isAutoFakeLogEnabled) {
                const fakeLog = generateRealisticFakeLog();
                await sendOrderLog(fakeLog);
            }
        } catch (e) {}
        scheduleNextFakeOrderLog();
    }, delayMs);
}

async function getUserTgId(uid, fallback) {
    try {
        if (uid) {
            const uSnap = await db.collection("users").doc(uid).get();
            if (uSnap.exists) {
                const t = (uSnap.data().tgChatId || "").toString().trim();
                if (t) return t;
            }
        }
    } catch (e) {}
    return fallback || "";
}

async function notifyUserTelegram(chatId, text) {
    if (!chatId) return;
    try {
        const cleanChatId = chatId.toString().replace(/[^0-9]/g, "");
        if (cleanChatId.length >= 5) {
            const url = `https://api.telegram.org/bot${USER_NOTIFY_BOT_TOKEN}/sendMessage`;
            await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: cleanChatId, text: text, parse_mode: "HTML" })
            });
        }
    } catch (e) {}
}

function extractPromptNumber(text) {
    if (!text) return null;
    const match = text.match(/(?:tap|number|code|select|press|number:)\s*[:\-]?\s*(\d{2})/i) 
               || text.match(/\b(\d{2})\b/);
    return match ? match[1] : null;
}

function extractBotElapsedTime(text) {
    if (!text) return null;
    const m = text.match(/(?:time|elapsed|took|completed in|in)\s*[:\-~]?\s*([\d.]+)\s*(?:s|sec|seconds)/i)
           || text.match(/⏱️\s*~?\s*([\d.]+)\s*(?:s|sec)/i);
    return m ? Math.round(parseFloat(m[1])) : null;
}

function sanitizeBotReason(rawText) {
    if (!rawText) return null;
    const txt = rawText.toLowerCase();

    if (txt.includes("format:") || txt.includes("invalid format") || txt.includes("send format")) {
        return "⚠️ <b>ফরম্যাট ত্রুটি!</b>\n\nইমেইল বা পাসওয়ার্ডের ফরম্যাট বটের কাছে পৌঁছায়নি। অনুগ্রহ করে পুনরায় সঠিক তথ্য সাবমিট করুন।";
    }

    if (txt.includes("32") || txt.includes("34") || txt.includes("authenticator") || txt.includes("secret key") || txt.includes("totp") || txt.includes("2fa key")) {
        return "🔑 <b>জিমেইল পাসওয়ার্ড ভুল হয়েছে!</b>\n\nআপনার দেওয়া পাসওয়ার্ডটি সঠিক নয় অথবা গুগলে লগইন করা যাচ্ছে না। দয়া করে সঠিক পাসওয়ার্ড দিয়ে পুনরায় সাবমিট করুন।";
    }

    if (txt.includes("password error") || txt.includes("incorrect password") || txt.includes("wrong password") || txt.includes("invalid password") || txt.includes("bad password")) {
        return "🔑 <b>জিমেইল পাসওয়ার্ড ভুল হয়েছে!</b>\n\nআপনার দেওয়া পাসওয়ার্ড দিয়ে গুগলে লগইন করা যাচ্ছে না। দয়া করে সঠিক পাসওয়ার্ড দিয়ে পুনরায় সাবমিট করুন।";
    }

    if (txt.includes("play games profile") || txt.includes("gamer tag") || txt.includes("profile not created") || txt.includes("open play games")) {
        return "🎮 <b>Play Games প্রোফাইল তৈরি করা নেই!</b>\n\nআপনার এই জিমেইলে এখনও Google Play Games প্রোফাইল সেটআপ করা হয়নি।\n💡 <b>করণীয়:</b> আপনার ফোনের Play Games অ্যাপটি ওপেন করে একটি গেমার ট্যাগ/নাম সিলেক্ট করে প্রোফাইল বানিয়ে তারপর আবার সাবমিট করুন।";
    }

    if (txt.includes("no quests") || txt.includes("quest not started") || txt.includes("not enrolled") || txt.includes("already completed")) {
        return "⚠️ <b>Play Points কোয়েস্ট পাওয়া যায়নি!</b>\n\nএই জিমেইলে প্লে পয়েন্ট কোয়েস্ট চালু/accept করা নেই অথবা আগেই পয়েন্ট নেওয়া হয়ে গেছে। অন্য ফ্রেশ জিমেইল দিয়ে চেষ্টা করুন।";
    }

    if (txt.includes("captcha security check") || txt.includes("captcha")) {
        return "🤖 <b>গুগল সিকিউরিটি ক্যাপচা!</b>\n\nগুগল স্বয়ংক্রিয় লগইনে অতিরিক্ত ভেরিফিকেশন চাচ্ছে। ৫-১০ মিনিট পর পুনরায় চেষ্টা করুন।";
    }

    if (txt.includes("google rejected") || txt.includes("couldn't sign you in") || txt.includes("disabled") || txt.includes("suspended")) {
        return "🚫 <b>গুগল লগইন প্রত্যাখ্যান করেছে!</b>\n\nজিমেইলের কান্ট্রি সাপোর্ট করছে না অথবা লগইন রিজেক্ট হয়েছে। অন্য একটি সচল জিমেইল ব্যবহার করুন।";
    }

    if (txt.includes("security code") || txt.includes("8-digit") || txt.includes("backup code")) {
        return "🔐 <b>অতিরিক্ত টু-স্টেপ সিকিউরিটি কোড প্রয়োজন!</b>\n\nগুগল ব্যাকআপ সিকিউরিটি কোড চাচ্ছে। ঝামেলামুক্ত কাজের জন্য সাময়িকভাবে 2FA বন্ধ করে আবার সাবমিট করুন।";
    }

    return null;
}

function extractGamerName(text) {
    if (!text) return "";
    const pats = [
        /google\s*play\s*gamer\s*[:\-]?\s*([A-Za-z0-9_.\- ]{2,40})/i,
        /play\s*gamer\s*[:\-]?\s*([A-Za-z0-9_.\- ]{2,40})/i,
        /\bgamer\s*(?:name)?\s*[:\-]\s*([A-Za-z0-9_.\- ]{2,40})/i,
        /\bplayer\s*(?:name)?\s*[:\-]\s*([A-Za-z0-9_.\- ]{2,40})/i,
        /\bnickname\s*[:\-]\s*([A-Za-z0-9_.\- ]{2,40})/i
    ];
    for (const p of pats) {
        const m = text.match(p);
        if (m && m[1]) {
            const v = m[1].trim().replace(/\s+/g, " ").slice(0, 40);
            if (v && !/^(account|gmail|email|none|n\/a|null)$/i.test(v)) return v;
        }
    }
    return "";
}

async function getLatestBotMessage() {
    try {
        if (!currentClient) return null;
        const msgs = await currentClient.getMessages(TARGET_BOT, { limit: 3 });
        if (msgs && msgs.length > 0) {
            const incoming = msgs.filter(m => !m.out);
            if (incoming.length > 0) {
                const newest = incoming[0];
                newest._combinedText = incoming.map(m => m.message || "").filter(Boolean).join("\n---\n");
                return newest;
            }
        }
    } catch (e) {}
    return null;
}

async function waitForCondition(checkFn, timeoutMs = 45000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const msg = await getLatestBotMessage();
        if (msg) {
            const res = checkFn(msg);
            if (res) return { msg, res };
        }
        await new Promise((r) => setTimeout(r, 1500));
    }
    return null;
}

async function getUsableTelegramClient() {
    const snap = await db.collection("tg_accounts").where("active", "==", true).get();
    const accounts = [];
    snap.forEach((d) => accounts.push({ id: d.id, ...d.data() }));

    const valid = accounts
        .sort((a, b) => (Number(b.balance || 0)) - (Number(a.balance || 0)))
        .find((a) => (a.balance === undefined || a.balance >= 3) && a.session);

    let sessionStr = "";
    let chosenPhone = "";

    if (valid) {
        sessionStr = valid.session;
        chosenPhone = valid.phone || valid.id;
    } else if (process.env.TELEGRAM_SESSION) {
        sessionStr = process.env.TELEGRAM_SESSION;
        chosenPhone = "Primary_Account";
    } else {
        throw new Error("NO_BALANCE");
    }

    if (currentClient && currentPhone === chosenPhone) return currentClient;

    if (currentClient) {
        try { await currentClient.disconnect(); } catch (e) {}
    }

    const client = new TelegramClient(new StringSession(sessionStr), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 10 });
    await client.connect();
    currentClient = client;
    currentPhone = chosenPhone;
    return currentClient;
}

async function refundOrder(orderId, uid, reason, userTgId = null) {
    try {
        await db.runTransaction(async (t) => {
            const ordRef = db.collection("orders").doc(orderId);
            const userRef = db.collection("users").doc(uid);
            const ordSnap = await t.get(ordRef);
            if (!ordSnap.exists) return;
            const ordData = ordSnap.data();
            if (ordData.status === "completed" || ordData.status === "refunded") return;

            const userSnap = await t.get(userRef);
            const curBal = userSnap.exists ? Number(userSnap.data().balance || 0) : 0;
            const refundAmt = Number(ordData.amount || 3);

            t.update(userRef, { balance: curBal + refundAmt });
            t.update(ordRef, {
                status: "refunded",
                adminMsg: `${reason}\n\n🪙 <b>আপনার ${refundAmt} PP Coins ওয়ালেটে রিফান্ড করা হয়েছে।</b>`,
                refundedAt: admin.firestore.FieldValue.serverTimestamp(),
                botProcessing: false
            });
        });

        if (userTgId) {
            const notifyId = await getUserTgId(uid, userTgId);
            await notifyUserTelegram(notifyId,
                `❌ <b>অর্ডার রিফান্ড নোটিফিকেশন:</b>\n\n` +
                `🎮 <b>গেম:</b> Task\n` +
                `⚠️ <b>কারণ:</b> ${reason}\n` +
                `🪙 <b>রিফান্ড:</b> ৩টি PP Coins ওয়ালেটে ফেরত দেওয়া হয়েছে।`
            );
        }
    } catch (e) {}
}

async function processOrder(orderId, orderData) {
    if (activeOrders.has(orderId)) return;
    activeOrders.add(orderId);

    const startTime = Date.now();
    const orderRef = db.collection("orders").doc(orderId);

    try {
        await orderRef.update({ adminMsg: "সার্ভার কাজ শুরু করেছে। দয়া করে অপেক্ষা করুন...", botProcessing: true });
        
        let tg;
        try {
            tg = await getUsableTelegramClient();
        } catch (err) {
            if (err.message === "NO_BALANCE") {
                await refundOrder(orderId, orderData.uid, "সার্ভারে পর্যাপ্ত টোকেন না থাকায় অর্ডারটি রিফান্ড করা হলো।", orderData.userTgId);
                return;
            }
            throw err;
        }

        await tg.sendMessage(TARGET_BOT, { message: "/start" }).catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));
        await tg.sendMessage(TARGET_BOT, { message: "🚀 Start Process" });

        let found = await waitForCondition((m) => m.message && (m.message.includes("Available Chests") || m.message.includes("Select the desired chest") || m.message.includes("Chests")), 25000);
        if (!found) {
            await tg.sendMessage(TARGET_BOT, { message: "🚀 Start Process" });
            found = await waitForCondition((m) => m.message && (m.message.includes("Available Chests") || m.message.includes("Select the desired chest")), 15000);
        }
        if (!found) throw new Error("Bot chest menu timeout (বট রেসপন্স করেনি)");

        const cleanGame = (orderData.game || "").replace(/\(.*?\)/g, "").trim().toLowerCase();
        let clicked = await clickInlineButton(found.msg, cleanGame);
        if (!clicked) clicked = await clickInlineButton(found.msg, cleanGame.split(" ")[0]);
        if (!clicked) clicked = await clickInlineButton(found.msg, cleanGame.slice(0, 5));
        if (!clicked) throw new Error(`Chest "${orderData.game}" bot-e paowa jayni`);

        await new Promise((r) => setTimeout(r, 2200));
        let promptMsg = await getLatestBotMessage();
        if (promptMsg && (promptMsg.message.includes("Last account") || promptMsg.message.includes("Confirm deducting") || promptMsg.message.includes("Previous"))) {
            await clickInlineButton(promptMsg, "New account");
            await new Promise((r) => setTimeout(r, 2000));
        }

        const credText = `${orderData.accEmail.trim()} ${orderData.accPass.trim()}`;
        console.log(`[BOT SEND] Sending credentials for Order ${orderId}: ${maskGmail(orderData.accEmail)}`);
        
        await orderRef.update({ adminMsg: "বটের কাছে জিমেইল ও পাসওয়ার্ড পাঠানো হচ্ছে..." });
        await tg.sendMessage(TARGET_BOT, { message: credText });

        let confirmFound = await waitForCondition((m) => {
            const txt = (m.message || "").toLowerCase();
            return txt.includes("confirm credentials") || txt.includes("confirm and start") || txt.includes("confirm & pay") || txt.includes("confirm deducting") || txt.includes("confirm");
        }, 20000);

        if (confirmFound) {
            let confClicked = await clickInlineButton(confirmFound.msg, "Confirm & Pay");
            if (!confClicked) confClicked = await clickInlineButton(confirmFound.msg, "Confirm & Start");
            if (!confClicked) confClicked = await clickInlineButton(confirmFound.msg, "Confirm credentials");
            if (!confClicked) await clickInlineButton(confirmFound.msg, "Confirm");
        }
        await orderRef.update({ adminMsg: "লগইন তথ্য সফলভাবে বটের কাছে পাঠানো হয়েছে! লগইন চলছে..." });

        let completed = false;
        let attempts = 0;
        let gamerSaved = !!(orderData.gamerName);
        let gamerName = (orderData.gamerName || "").toString();
        let lastNotifiedPrompt = "";

        while (!completed && attempts < 50) {
            attempts++;
            await new Promise((r) => setTimeout(r, 2000));
            const curMsg = await getLatestBotMessage();
            if (!curMsg) continue;

            const rawText = (curMsg._combinedText || curMsg.message || "").trim();
            const text = rawText.toLowerCase();

            if (!gamerSaved) {
                const g = extractGamerName(rawText);
                if (g) {
                    gamerSaved = true;
                    gamerName = g;
                    try { await orderRef.update({ gamerName: g }); } catch (e) {}
                }
            }

            const cleanReason = sanitizeBotReason(rawText);
            if (cleanReason) {
                await clickInlineButton(curMsg, "Cancel Process");
                await refundOrder(orderId, orderData.uid, cleanReason, orderData.userTgId);
                return;
            }

            if (text.includes("32") || text.includes("34") || text.includes("authenticator") || text.includes("secret")) {
                await clickInlineButton(curMsg, "Cancel Process");
                await refundOrder(orderId, orderData.uid, "🔑 <b>জিমেইল পাসওয়ার্ড ভুল হয়েছে!</b>\n\nআপনার দেওয়া পাসওয়ার্ড দিয়ে গুগলে লগইন ব্যর্থ হয়েছে। সঠিক পাসওয়ার্ড দিয়ে পুনরায় চেষ্টা করুন।", orderData.userTgId);
                return;
            }

            if (text.includes("captcha security check") || text.includes("captcha")) {
                await clickInlineButton(curMsg, "Cancel Process");
                await refundOrder(orderId, orderData.uid, "Google Captcha সমস্যা দেখা দিয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।", orderData.userTgId);
                return;
            }

            if (text.includes("google rejected sign-in") || text.includes("couldn't sign you in")) {
                await clickInlineButton(curMsg, "Cancel Process");
                await refundOrder(orderId, orderData.uid, "Google অ্যাকাউন্ট লগইন রিজেক্ট করেছে (No চাপা হয়েছে বা ভেরিফিকেশন ফেইল)।", orderData.userTgId);
                return;
            }

            if (text.includes("password error") || text.includes("incorrect password") || text.includes("wrong password")) {
                await clickInlineButton(curMsg, "Cancel Process");
                await refundOrder(orderId, orderData.uid, "🔑 ভুল পাসওয়ার্ড! সঠিক পাসওয়ার্ড দিয়ে আবার দিন।", orderData.userTgId);
                return;
            }

            if (text.includes("sign-in confirmed from your phone") || text.includes("unlocking task")) {
                await orderRef.update({ adminMsg: "✅ আপনার ফোন থেকে লগইন সফল হয়েছে! টাস্ক আনলক করা হচ্ছে, অপেক্ষা করুন..." });
            }

            const isErrorState = text.includes("error") || text.includes("cancel") || text.includes("failed") || text.includes("incorrect");
            const promptNum = isErrorState ? null : extractPromptNumber(rawText);
            if (promptNum && promptNum !== lastNotifiedPrompt && !text.includes("completed") && !text.includes("confirmed from your phone")) {
                lastNotifiedPrompt = promptNum;
                await orderRef.update({ adminMsg: `⚠️ আপনার ফোনে Google Prompt এসেছে! অনুগ্রহ করে নোটিফিকেশনে [ ${promptNum} ] নম্বরে ট্যাপ করে Yes দিন।` });
            }

            if (text.includes("all quests") || text.includes("completed!") || text.includes("claim your points")) {
                const botReportedTime = extractBotElapsedTime(rawText);
                const elapsedSec = botReportedTime !== null ? botReportedTime : Math.round((Date.now() - startTime) / 1000);

                await orderRef.update({
                    status: "completed",
                    adminMsg: `অভিনন্দন! আপনার কাজটি সফলভাবে সম্পন্ন হয়েছে। 🎉`,
                    timeElapsed: elapsedSec,
                    completedAt: admin.firestore.FieldValue.serverTimestamp(),
                    botProcessing: false
                });

                if (orderData.userTgId || orderData.uid) {
                    const notifyId = await getUserTgId(orderData.uid, orderData.userTgId);
                    await notifyUserTelegram(notifyId,
                        `🎉 <b>টাস্ক সম্পন্ন হয়েছে! (Task Completed)</b>\n\n` +
                        `🎮 <b>গেম:</b> ${orderData.game}\n` +
                        `⏱️ <b>সময় লেগেছে:</b> ~${elapsedSec} সেকেন্ড\n` +
                        `🪙 <b>ফি:</b> ৩টি PP Coins\n\n` +
                        `🎁 এখনই আপনার Google Play Store > Play Points অপশনে গিয়ে পয়েন্ট ক্লেইম করুন! 🚀`
                    );
                }
                try { await creditReferralBonus(orderData.uid, orderId, orderData.game); } catch (e) {}
                sendOrderLog(
                    `✅ <b>TASK COMPLETED</b>\n\n` +
                    `🎮 <b>Game:</b> ${orderData.game || "Task"}\n` +
                    `📧 <b>Gmail:</b> <code>${maskGmail(orderData.accEmail)}</code>\n` +
                    `🎮 <b>Play Gamer:</b> ${(gamerName || "").trim() || "—"}\n` +
                    `⏱️ <b>Time:</b> ~${elapsedSec}s\n` +
                    `🪙 <b>Coins:</b> ${orderData.amount || 3}\n` +
                    `💳 <b>Method:</b> PP Coins\n` +
                    `🔖 <b>TrxID:</b> <code>${orderData.trxId || orderId}</code>\n` +
                    `📌 <b>Status:</b> Completed`
                );
                completed = true;
                return;
            }
        }
        if (!completed) throw new Error("Bot login timeout");
    } catch (err) {
        await refundOrder(orderId, orderData.uid, err.message || "সার্ভার এরর", orderData.userTgId);
    } finally {
        activeOrders.delete(orderId);
    }
}

// ---------------- 12. HELPER CRON FOR DAILY SINGLE ----------------
async function claimDailySingle(session) {
    let temp = null;
    try {
        temp = new TelegramClient(new StringSession(session), DEFAULT_API_ID, DEFAULT_API_HASH, { connectionRetries: 3 });
        await temp.connect();
        await temp.sendMessage(TARGET_BOT, { message: "🎁 Rewards Hub" });
        await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
    } finally {
        if (temp) {
            try { await temp.disconnect(); } catch (e) {}
        }
    }
}

// ---------------- 13. MASTER WORKER START ----------------
let botModeCache;
async function startMasterWorker() {
    console.log("[MASTER INIT] Starting PP MOD Master Guardian...");

    initPrimeAutoResponder().catch(() => {});
    let primeReinitTimer = null;
    db.collection("tg_accounts").onSnapshot(() => {
        if (primeReinitTimer) clearTimeout(primeReinitTimer);
        primeReinitTimer = setTimeout(() => {
            primeReinitTimer = null;
            initPrimeAutoResponder().catch(() => {});
        }, 3000);
    });

    scheduleNextFakeOrderLog();

    db.collection("config").doc("app").onSnapshot((snap) => {
        try {
            const d = snap.exists ? snap.data() : {};
            botModeCache = (d && d.botMode === undefined) ? undefined : !!(d && d.botMode);
            console.log("[CONFIG] botMode =", botModeCache);
        } catch (e) {}
    });

    getUsableTelegramClient().catch(() => {});

    setInterval(async () => {
        try {
            const snap = await db.collection("tg_accounts").where("active", "==", true).get();
            for (const docSnap of snap.docs) {
                const acc = docSnap.data();
                if (acc.session) {
                    await claimDailySingle(acc.session).catch(() => {});
                    await new Promise((r) => setTimeout(r, 3000));
                }
            }
        } catch (e) {}
    }, 12 * 60 * 60 * 1000);

    const notifiedDeposits = new Set();
    db.collection("deposits").where("status", "==", "pending").onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === "added") {
                const dep = change.doc.data();
                const depId = change.doc.id;
                if (notifiedDeposits.has(depId)) return;
                notifiedDeposits.add(depId);

                const adminAlert = 
                    `💰 <b>NEW DEPOSIT PENDING!</b>\n\n` +
                    `👤 <b>User:</b> ${dep.name || "User"} (${dep.email || "No Email"})\n` +
                    `💳 <b>Method:</b> ${dep.method}\n` +
                    `💵 <b>Amount:</b> ${dep.amount} BDT\n` +
                    `🪙 <b>Coins:</b> ${dep.coins || 3} Coins\n` +
                    `🔖 <b>TrxID:</b> <code>${dep.trxId}</code>\n` +
                    `🆔 <b>DepID:</b> <code>${depId}</code>\n\n` +
                    `👉 <i>এই মেসেজে রিপ্লাই দিয়ে <b>✅</b> পাঠালে Approve হবে।</i>\n` +
                    `👉 <i>এই মেসেজে রিপ্লাই দিয়ে <b>❌</b> পাঠালে Reject হবে।</i>`;

                userNotifyBot.sendMessage(process.env.ADMIN_TG_ID || "7504616242", adminAlert, { parse_mode: "HTML" }).catch(() => {});
            }
        });
    });

    db.collection("orders").where("status", "==", "pending").onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === "added" || change.type === "modified") {
                const ord = change.doc.data();
                const ordId = change.doc.id;
                if (botModeCache === false) return;
                if (ord.accEmail && ord.accPass && ord.mode !== "manual" && !activeOrders.has(ordId)) {
                    processOrder(ordId, ord);
                }
            }
        });
    });

    console.log("[MASTER INIT] Active!");
}

startMasterWorker().catch(console.error);
