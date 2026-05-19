const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ─── Load config ───────────────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync("./config.json", "utf-8"));

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

// ─── Call Groq AI ──────────────────────────────────────────────────────────
async function askGroq(senderNumber, userMessage) {
  if (!conversationHistory[senderNumber]) {
    conversationHistory[senderNumber] = [];
  }

  conversationHistory[senderNumber].push({ role: "user", content: userMessage });
  const recentHistory = conversationHistory[senderNumber].slice(-20);

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
`;

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: config.groqModel || "llama-3.3-70b-versatile",
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

  // Strip the internal tag before sending
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

// ─── Webhook ────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const from = req.body.From?.replace("whatsapp:", "");
  const message = req.body.Body?.trim();
  if (!from || !message) return;
  console.log(`📩 ${from}: ${message}`);
  if (ownerOnline) return console.log("👤 Owner online — skipping AI");
  try {
    const reply = await askGroq(from, message);
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
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Bot running: http://localhost:${PORT}`);
  console.log(`📊 Dashboard:  http://localhost:${PORT}/dashboard`);
  console.log(`⚡ Powered by Groq — ${config.groqModel || "llama-3.3-70b-versatile"}\n`);
});
