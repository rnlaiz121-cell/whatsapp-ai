const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode");

// ─── Baileys imports ────────────────────────────────────────────────────────
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  downloadContentFromMessage,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ─── Load config ────────────────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
if (process.env.GROQ_API_KEY) config.groqApiKey = process.env.GROQ_API_KEY;

// ─── Orders storage ──────────────────────────────────────────────────────────
const ORDERS_FILE = "./orders.json";
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, "[]");

function loadOrders() {
  return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf-8"));
}

function saveOrder(order) {
  const orders = loadOrders();
  orders.push(order);
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

function generateOrderId() {
  return "ORD-" + Date.now().toString(36).toUpperCase();
}

// ─── Global state ────────────────────────────────────────────────────────────
let ownerOnline = false;
const conversationHistory = {};
let currentQR = null;         // latest QR string
let waSocket = null;          // active Baileys socket
let waConnected = false;      // true once linked

const handoffMessages = [
  "Hey! 👋 Rn Laiz is back online right now. DM him directly at +918798471776 and he'll sort you out! 🎮",
  "Wassup! Rn Laiz just came online 🔥 Hit him up at +918798471776 for your order!",
  "Good news! Rn Laiz is available now 💪 Just DM +918798471776 — he's got you!",
  "Yo! The boss is back 😎 Reach Rn Laiz at +918798471776 — he's online and ready!",
  "Rn Laiz is online bro! 🎮⚡ Drop him a message at +918798471776 and he'll handle it personally!",
];
const handoffSentAt = {};

// ─── Groq AI ─────────────────────────────────────────────────────────────────
async function askGroq(senderNumber, userMessage, imageBuffer = null, imageMime = null) {
  if (!conversationHistory[senderNumber]) conversationHistory[senderNumber] = [];

  const today = new Date().toISOString().split("T")[0];

  const productList = config.products
    .map((p) => {
      const available = p.available !== false;
      const tag = !available ? ` [PRE-ORDER — ships ${p.availableDate || "soon"}]` : "";
      return `- ${p.name}: ${p.price} | ${p.description}${tag}`;
    })
    .join("\n");

  const systemPrompt = `
You are an AI assistant for "Phonix Store" run by your owner Rn Laiz.
You handle TWO things: 1) Gaming top-ups, 2) MLBB account dealings (buying/selling/stocking).
Today: ${today}
Language: ${config.language} (auto-switch to Hindi/Bengali if customer uses it. also use casual gamer slang like "bro", "bruh", "frfr", "ngl", "💀", "🔥" etc — keep it real, this is WhatsApp not email)

════════════════════════════════
🎮 TOP-UP PRODUCTS:
${productList}

TOP-UP RULES:
- Collect: product name, game ID → confirm price → ask for payment
- Payment: ${config.paymentInstructions}
- After payment screenshot received: confirm and say delivery in 5 mins ⚡
- After confirming order append (hidden, customer won't see):
  [ORDER_CONFIRMED: product="X", gameId="Y", type="order|preorder", price="Z"]

════════════════════════════════
💼 MLBB ACCOUNT DEALINGS:

You handle two types of account deals:

──────────────────────────────
A) CUSTOMER WANTS TO SELL their account (called "stocking"):

Step 1 — Collect account details. Ask them to send:
  • Rank
  • Heroes owned + skins
  • Any Zodiac / Legend / Collector skins
  • Win rate
  • Server
  • Screenshots of the account

Step 2 — Check 3 key things (ask if not mentioned):
  1. Rebindable? (can all bindings — Moonton, Gmail, FB, TikTok, VK — be removed?) → If NO, REJECT the account. Say: "Sorry bro we can't stock non-rebindable accs 🙏"
  2. Local? (India server?) → If not local, price drops significantly — tell them
  3. Clean? (no third-party tools/hacks?) → If not clean, price drops or reject

Step 3 — If all 3 are good (rebindable ✅, local ✅, clean ✅):
  Say: "Acc looks good bro 🔥 Let me check with Rn Laiz for the rate, send me the screenshots if you haven't already"
  Then send this hidden tag: [STOCK_RATE_NEEDED: seller="SENDER_NUMBER"]
  Wait — Rn Laiz will tell you the rate via the dashboard/owner system, then relay it to the customer.

Step 4 — If customer agrees to the rate:
  Collect the account login details (email/password or however they transfer)
  Tell them: "Got it bro ✅ Rn Laiz will verify and send payment after confirming everything 🙏"
  Send hidden tag: [STOCK_DEAL: seller="SENDER_NUMBER", status="credentials_received"]

──────────────────────────────
B) CUSTOMER WANTS TO BUY an account:

Step 1 — Ask their requirements if not stated:
  • Which heroes/skins they want (e.g. "Gusion Collector + Chou Legend")
  • Budget (if not mentioned, ASK — don't proceed without it)

Step 2 — Check if payment is ready:
  Ask: "Is your payment ready bro? We only deal when funds are arranged 🙏"
  If NOT ready: "No worries bro! Arrange your budget first and come back — we'll find you the perfect acc 🎮"
  If READY: "Okay bro 🔥 Give me a few mins, let me check our stock with Rn Laiz and I'll show you options!"
  Send hidden tag: [BUY_REQUEST: buyer="SENDER_NUMBER", requirements="THEIR_REQUIREMENTS", budget="THEIR_BUDGET"]
  Then Rn Laiz takes over to show account options.

════════════════════════════════
🚨 SCAM AWARENESS (if customer mentions being scammed or asks about safety):
Warn them about: recovery scams, fake screenshots, edited skin counts, fake MMs, account pullback via Moonton recovery, "first owner" lies, phishing links.
Red flags to avoid: rushing the deal, refusing live proof, "family emergency send first", too-cheap accounts, no original email access.
Always say: "Deal safely bro — Rn Laiz is a trusted dealer with real rep in the community 🙏🔥"

════════════════════════════════
🤝 MIDDLEMAN (MM) INFO:
If asked about MM: "Rn Laiz can act as MM for big deals. He holds either the money or the account until both sides confirm. Trusted, no funny business 🔥"


════════════════════════════════
😏 FLIRTING / VIBE RULES:
You can be flirty but ONLY when the situation calls for it. Read the room.

WHEN you CAN flirt (situational, natural):
- Customer is being playful, funny or overly friendly first
- They send cute/flirty messages like 'heyy', 'hiii', compliments, heart emojis etc
- Casual chit-chat with no active deal going on
- They tease you or joke around

HOW to flirt (keep it classy, not creepy):
- Light, witty, confident — like a smooth gamer not a desperate guy 💀
- Examples: 'been waiting for your text ngl 😏', 'dangerous combo — good taste and good deals 🔥', 'aight you got me there 😭', 'okay okay you're actually funny fr'
- Use emojis naturally: 😏🔥💀😭🥲
- Match their energy — if they're subtle, you're subtle. If they're bold, you can be bolder.
- Keep it SHORT — one flirty line max, then get back to business

WHEN you MUST NOT flirt (hard rules):
- During any active deal (stocking, buying, payment, credentials sharing)
- If they seem underage
- If they seem uncomfortable or don't vibe back
- If they're being strictly professional/serious
- Never be explicit, weird or pushy — one strike and go back to professional mode for the whole convo

RECOVERY: If you misread the room and they seem off, immediately pivot back to normal assistant mode. Smooth, no awkwardness. 😎

════════════════════════════════
🧠 GENERAL RULES:
- Keep messages short — this is WhatsApp not an essay 💀
- Never make up rates or prices for accounts — always say you'll check with Rn Laiz
- If a situation is too complex or unclear, say: "Bro this one's a bit complex lemme bring Rn Laiz into this 🙏" then send [HANDOFF_NEEDED: reason="complex situation"]
- Never share Rn Laiz's personal number unless he's marked online
- You are smart, street-aware, and community-native — you know how MLBB dealings work

IMAGE RULES:
- Payment screenshot → confirm received, say processing ⚡
- Account screenshot → read rank, skins, heroes visible and use that info
- Skin/hero screenshot → identify what they want
- Always describe specifically what you see
`;

  let userContent;
  if (imageBuffer && imageMime) {
    const base64 = imageBuffer.toString("base64");
    userContent = [
      {
        type: "image_url",
        image_url: { url: `data:${imageMime};base64,${base64}` },
      },
      { type: "text", text: userMessage || "I sent you an image." },
    ];
  } else {
    userContent = userMessage;
  }

  conversationHistory[senderNumber].push({ role: "user", content: userContent });
  const recentHistory = conversationHistory[senderNumber].slice(-20);

  const model =
    imageBuffer
      ? "meta-llama/llama-4-scout-17b-16e-instruct"
      : config.groqModel || "llama-3.3-70b-versatile";

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model,
      messages: [{ role: "system", content: systemPrompt }, ...recentHistory],
      max_tokens: 500,
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${config.groqApiKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  const reply = response.data.choices[0].message.content;

  // Store text-only in history (avoid giant base64 blobs)
  conversationHistory[senderNumber][conversationHistory[senderNumber].length - 1] = {
    role: "user",
    content: userMessage || "[sent an image]",
  };
  conversationHistory[senderNumber].push({ role: "assistant", content: reply });

  // ── Auto-log top-up orders ──────────────────────────────────────────────
  const orderMatch = reply.match(
    /\[ORDER_CONFIRMED: product="([^"]+)", gameId="([^"]+)", type="([^"]+)", price="([^"]+)"\]/
  );
  if (orderMatch) {
    const orderId = generateOrderId();
    saveOrder({
      id: orderId,
      phone: senderNumber,
      product: orderMatch[1],
      gameId: orderMatch[2],
      type: orderMatch[3],
      price: orderMatch[4],
      status: orderMatch[3] === "preorder" ? "pre-ordered" : "pending",
      timestamp: new Date().toISOString(),
    });
    console.log(`📦 Top-up logged: ${orderId} | ${orderMatch[1]} | ${senderNumber}`);
  }

  // ── Log stock rate requests ─────────────────────────────────────────────
  if (reply.includes("[STOCK_RATE_NEEDED:")) {
    saveOrder({
      id: generateOrderId(),
      phone: senderNumber,
      product: "MLBB Account (Stocking)",
      gameId: "N/A",
      type: "stock-rate-needed",
      price: "TBD",
      status: "awaiting-rate",
      timestamp: new Date().toISOString(),
    });
    console.log(`📊 Stock rate needed for: ${senderNumber} — check dashboard!`);
  }

  // ── Log buy requests ────────────────────────────────────────────────────
  const buyMatch = reply.match(/\[BUY_REQUEST: buyer="([^"]+)", requirements="([^"]+)", budget="([^"]+)"\]/);
  if (buyMatch) {
    saveOrder({
      id: generateOrderId(),
      phone: senderNumber,
      product: `Buy Request: ${buyMatch[2]}`,
      gameId: "N/A",
      type: "account-buy",
      price: buyMatch[3],
      status: "pending-owner",
      timestamp: new Date().toISOString(),
    });
    console.log(`🛒 Buy request from ${senderNumber}: ${buyMatch[2]} | Budget: ${buyMatch[3]}`);
  }

  // ── Log handoff needed ──────────────────────────────────────────────────
  if (reply.includes("[HANDOFF_NEEDED:")) {
    console.log(`🤝 Handoff needed for ${senderNumber} — complex situation!`);
  }

  // Strip all hidden tags before sending to customer
  return reply
    .replace(/\[ORDER_CONFIRMED:[^\]]+\]/g, "")
    .replace(/\[STOCK_RATE_NEEDED:[^\]]+\]/g, "")
    .replace(/\[BUY_REQUEST:[^\]]+\]/g, "")
    .replace(/\[STOCK_DEAL:[^\]]+\]/g, "")
    .replace(/\[HANDOFF_NEEDED:[^\]]+\]/g, "")
    .trim();
}

// ─── Send WhatsApp via Baileys ────────────────────────────────────────────────
async function sendWhatsAppMessage(jid, text) {
  if (!waSocket || !waConnected) {
    console.error("❌ WhatsApp not connected yet");
    return;
  }
  await waSocket.sendMessage(jid, { text });
}

// ─── Baileys connection ───────────────────────────────────────────────────────
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,   // also prints in terminal for convenience
    getMessage: async () => undefined,
  });

  waSocket = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      waConnected = false;
      console.log("📱 New QR generated — visit /qr in your browser to scan");
    }

    if (connection === "close") {
      waConnected = false;
      currentQR = null;
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("⚠️  Connection closed. Reconnect:", shouldReconnect);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      } else {
        // Logged out — clear saved auth so fresh QR is shown
        fs.rmSync("./auth_info", { recursive: true, force: true });
        setTimeout(connectToWhatsApp, 1000);
      }
    }

    if (connection === "open") {
      waConnected = true;
      currentQR = null;
      console.log("✅ WhatsApp connected!");
    }
  });

  // ─── Incoming messages ──────────────────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      // Ignore messages from self or groups
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid.endsWith("@g.us")) continue;

      const jid = msg.key.remoteJid;                         // e.g. 919876543210@s.whatsapp.net
      const senderNumber = jid.replace("@s.whatsapp.net", "");
      const text = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || "";

      console.log(`📩 ${senderNumber}: ${text || "[media]"}`);

      // ── Owner online: send handoff ──────────────────────────────────────
      if (ownerOnline) {
        const now = Date.now();
        const lastSent = handoffSentAt[senderNumber] || 0;
        if (now - lastSent > 3 * 60 * 1000) {
          handoffSentAt[senderNumber] = now;
          const handoff = handoffMessages[Math.floor(Math.random() * handoffMessages.length)];
          await sendWhatsAppMessage(jid, handoff);
          console.log(`📤 Handoff → ${senderNumber}`);
        } else {
          console.log(`⏳ Cooldown active for ${senderNumber}`);
        }
        continue;
      }

      // ── Detect image ────────────────────────────────────────────────────
      let imageBuffer = null;
      let imageMime = null;

      const imageMsg =
        msg.message?.imageMessage ||
        msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;

      if (imageMsg) {
        try {
          console.log(`🖼️  Image received from ${senderNumber}`);
          const stream = await downloadContentFromMessage(imageMsg, "image");
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          imageBuffer = Buffer.concat(chunks);
          imageMime = imageMsg.mimetype || "image/jpeg";
        } catch (err) {
          console.error("❌ Image download failed:", err.message);
        }
      }

      // ── AI reply ────────────────────────────────────────────────────────
      try {
        const reply = await askGroq(senderNumber, text, imageBuffer, imageMime);
        console.log(`🤖 → ${senderNumber}: ${reply}`);
        await sendWhatsAppMessage(jid, reply);
      } catch (err) {
        console.error("❌ Groq error:", err.response?.data || err.message);
      }
    }
  });
}

// ─── QR code page ─────────────────────────────────────────────────────────────
app.get("/qr", async (req, res) => {
  if (waConnected) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#080b12;color:#00e5a0">
        <h1>✅ WhatsApp Connected!</h1>
        <p style="color:#aaa">Your bot is live. Customers can now DM your number directly.</p>
        <a href="/dashboard" style="color:#00e5a0">→ Go to Dashboard</a>
      </body></html>
    `);
  }

  if (!currentQR) {
    return res.send(`
      <html>
      <head><meta http-equiv="refresh" content="3"></head>
      <body style="font-family:sans-serif;text-align:center;padding:60px;background:#080b12;color:#aaa">
        <h2 style="color:#00e5a0">⏳ Generating QR Code...</h2>
        <p>Page will refresh automatically</p>
      </body></html>
    `);
  }

  try {
    const qrDataUrl = await qrcode.toDataURL(currentQR, { width: 300, margin: 2 });
    res.send(`
      <html>
      <head><meta http-equiv="refresh" content="30"></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;background:#080b12;color:#e8eaf2">
        <h2 style="color:#00e5a0">📱 Scan with WhatsApp</h2>
        <p style="color:#aaa;margin-bottom:20px">Open WhatsApp → Linked Devices → Link a Device</p>
        <img src="${qrDataUrl}" style="border-radius:16px;border:4px solid #1e2535"/>
        <p style="color:#5a6280;font-size:13px;margin-top:16px">QR refreshes every 30s</p>
      </body></html>
    `);
  } catch (e) {
    res.send("Error generating QR: " + e.message);
  }
});

// ─── WhatsApp status API ──────────────────────────────────────────────────────
app.get("/wa/status", (req, res) => {
  res.json({ connected: waConnected, hasQR: !!currentQR });
});

// ─── Owner routes ─────────────────────────────────────────────────────────────
app.post("/owner/online",  (req, res) => { ownerOnline = true;  res.json({ status: "online" }); });
app.post("/owner/offline", (req, res) => { ownerOnline = false; res.json({ status: "offline" }); });
app.get("/owner/status",   (req, res) => res.json({ ownerOnline }));

// ─── Orders API ───────────────────────────────────────────────────────────────
app.get("/orders", (req, res) => res.json(loadOrders().reverse()));

app.post("/orders/:id/status", (req, res) => {
  const orders = loadOrders();
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Not found" });
  order.status = req.body.status;
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
  res.json(order);
});

// ─── Dashboard ────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.redirect("/dashboard"));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Phonix Bot running: http://localhost:${PORT}`);
  console.log(`📊 Dashboard:          http://localhost:${PORT}/dashboard`);
  console.log(`📱 WhatsApp QR:        http://localhost:${PORT}/qr\n`);
});

// Connect to WhatsApp
connectToWhatsApp().catch(console.error);
