const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ─── Load config (env vars override config.json) ───────────────────────────
const config = JSON.parse(fs.readFileSync("./config.json", "utf-8"));

// Env vars take priority over config.json (for Render/Railway deployment)
if (process.env.GROQ_API_KEY)           config.groqApiKey           = process.env.GROQ_API_KEY;
if (process.env.TWILIO_ACCOUNT_SID)     config.twilioAccountSid     = process.env.TWILIO_ACCOUNT_SID;
if (process.env.TWILIO_AUTH_TOKEN)      config.twilioAuthToken      = process.env.TWILIO_AUTH_TOKEN;
if (process.env.TWILIO_WHATSAPP_NUMBER) config.twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER;

// ─── Orders storage (free JSON file) ──────────────────────────────────────
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

// ─── Owner status ──────────────────────────────────────────────────────────
let ownerOnline = false;
const conversationHistory = {};

// ─── Download image from Twilio and convert to base64 ─────────────────────
async function getImageBase64(mediaUrl) {
  const response = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    auth: { username: config.twilioAccountSid, password: config.twilioAuthToken },
  });
  const base64 = Buffer.from(response.data).toString("base64");
  const mimeType = response.headers["content-type"] || "image/jpeg";
  return { base64, mimeType };
}

// ─── Call Groq AI (supports text + images) ─────────────────────────────────
async function askGroq(senderNumber, userMessage, imageUrl = null) {
  if (!conversationHistory[senderNumber]) {
    conversationHistory[senderNumber] = [];
  }

  const today = new Date().toISOString().split("T")[0];

  const productList = config.products
    .map((p) => {
      const available = p.available !== false;
      const tag = !available ? ` [PRE-ORDER — ships ${p.availableDate || "soon"}]` : "";
      return `- ${p.name}: ${p.price} | ${p.description}${tag}`;
    })
    .join("\n");

  const systemPrompt = `
You are an AI assistant for "${config.businessName}", a WhatsApp gaming top-up store.
Today: ${today}

PRODUCTS:
${productList}

PRE-ORDER POLICY: ${config.preOrderPolicy}
PAYMENT: ${config.paymentInstructions}

RULES:
- Be friendly and short. This is WhatsApp. No long paragraphs.
- Use casual gamer language 🎮
- For ORDERS, collect: product, game ID, then confirm price & payment
- For PRE-ORDERS, collect: product, game ID, name — explain availability date — ask pay now or later
- After confirming any order, append this hidden tag on its own line (customer won't see it):
  [ORDER_CONFIRMED: product="X", gameId="Y", type="order|preorder", price="Z"]
- Don't make up products. If unsure, say "Let me check with the owner!"
- Language: ${config.language}

IMAGE RULES (when customer sends an image):
- If it looks like a PAYMENT SCREENSHOT: confirm you received it, tell them top-up will be delivered within 5 mins ⚡, mark order as paid
- If it looks like a GAME SCREENSHOT or PROFILE: read their game ID, username, or rank from it if visible and use that info
- If it looks like a PRODUCT REQUEST image (e.g. screenshot of a game item): identify what they want and help them order it
- If it's something else: describe what you see and ask how you can help
- Always be specific about what you actually see in the image
`;

  // Build user message content — text + optional image
  let userContent;
  if (imageUrl) {
    try {
      const { base64, mimeType } = await getImageBase64(imageUrl);
      userContent = [
        {
          type: "image_url",
          image_url: { url: `data:${mimeType};base64,${base64}` },
        },
        {
          type: "text",
          text: userMessage || "I sent you an image.",
        },
      ];
    } catch (err) {
      console.error("❌ Image fetch failed:", err.message);
      userContent = userMessage + " [customer sent an image but it could not be loaded]";
    }
  } else {
    userContent = userMessage;
  }

  conversationHistory[senderNumber].push({ role: "user", content: userContent });
  const recentHistory = conversationHistory[senderNumber].slice(-20);

  // Use vision model when image is present
  const model = imageUrl
    ? "meta-llama/llama-4-scout-17b-16e-instruct"
    : (config.groqModel || "llama-3.3-70b-versatile");

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

  // Store text-only version in history (base64 images are too large to keep)
  conversationHistory[senderNumber][conversationHistory[senderNumber].length - 1] = {
    role: "user",
    content: userMessage || "[sent an image]",
  };
  conversationHistory[senderNumber].push({ role: "assistant", content: reply });

  // Auto-log confirmed orders
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
    console.log(`📦 Logged ${orderMatch[3]}: ${orderId} | ${orderMatch[1]} | ${senderNumber}`);
  }

  return reply.replace(/\[ORDER_CONFIRMED:[^\]]+\]/g, "").trim();
}

// ─── Send WhatsApp via Twilio ───────────────────────────────────────────────
async function sendWhatsAppMessage(to, message) {
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Messages.json`,
    new URLSearchParams({
      From: `whatsapp:${config.twilioWhatsAppNumber}`,
      To: `whatsapp:${to}`,
      Body: message,
    }).toString(),
    {
      auth: { username: config.twilioAccountSid, password: config.twilioAuthToken },
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );
}

// ─── Handoff messages when owner is online ─────────────────────────────────
const handoffMessages = [
  "Hey! 👋 Rn Laiz is back online right now. DM him directly at +918798471776 and he'll sort you out! 🎮",
  "Wassup! Rn Laiz just came online 🔥 Hit him up at +918798471776 for your order!",
  "Good news! Rn Laiz is available now 💪 Just DM +918798471776 — he's got you!",
  "Yo! The boss is back 😎 Reach Rn Laiz at +918798471776 — he's online and ready!",
  "Rn Laiz is online bro! 🎮⚡ Drop him a message at +918798471776 and he'll handle it personally!",
];
const handoffSentAt = {};

// ─── Webhook ────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Empty TwiML response — stops Twilio sending "OK" auto-replies
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");

  const from = req.body.From?.replace("whatsapp:", "");
  const message = req.body.Body?.trim();
  if (!from || !message) return;
  console.log(`📩 ${from}: ${message}`);

  if (ownerOnline) {
    // Send handoff — max once every 3 mins per user so they can't spam trigger it
    const now = Date.now();
    const lastSent = handoffSentAt[from] || 0;
    if (now - lastSent > 3 * 60 * 1000) {
      handoffSentAt[from] = now;
      const msg = handoffMessages[Math.floor(Math.random() * handoffMessages.length)];
      await sendWhatsAppMessage(from, msg);
      console.log(`📤 Handoff → ${from}`);
    } else {
      console.log(`⏳ Cooldown active for ${from}`);
    }
    return;
  }

  try {
    // Check if customer sent an image
    const numMedia = parseInt(req.body.NumMedia || "0");
    const imageUrl = numMedia > 0 ? req.body.MediaUrl0 : null;
    if (imageUrl) console.log(`🖼️ Image received from ${from}: ${imageUrl}`);

    const reply = await askGroq(from, message || "", imageUrl);
    console.log(`🤖 → ${from}: ${reply}`);
    await sendWhatsAppMessage(from, reply);
  } catch (err) {
    console.error("❌", err.response?.data || err.message);
  }
});

// ─── Owner routes ───────────────────────────────────────────────────────────
app.post("/owner/online",  (req, res) => { ownerOnline = true;  res.json({ status: "online" }); });
app.post("/owner/offline", (req, res) => { ownerOnline = false; res.json({ status: "offline" }); });
app.get("/owner/status",   (req, res) => { res.json({ ownerOnline }); });

// ─── Orders API ─────────────────────────────────────────────────────────────
app.get("/orders", (req, res) => {
  res.json(loadOrders().reverse());
});

app.post("/orders/:id/status", (req, res) => {
  const orders = loadOrders();
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Not found" });
  order.status = req.body.status;
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
  res.json(order);
});

// ─── Dashboard ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.redirect("/dashboard"));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Bot running: http://localhost:${PORT}`);
  console.log(`📊 Dashboard:  http://localhost:${PORT}/dashboard`);
  console.log(`⚡ Powered by Groq — ${config.groqModel || "llama-3.3-70b-versatile"}\n`);
});
