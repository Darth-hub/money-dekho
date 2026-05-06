// ============================================================
// WhatsApp Expense Tracker Bot — Meta Cloud API + Claude AI
// ============================================================
// Stack: Node.js + Express + Supabase + Claude API
// Deploy to: Render.com (free tier)
// ============================================================

import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// ── ENV VARIABLES (set these in Render dashboard) ──────────
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN;       // any random string you choose
const WHATSAPP_TOKEN   = process.env.WHATSAPP_TOKEN;     // Meta permanent token
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID;    // from Meta dashboard
const CLAUDE_API_KEY   = process.env.CLAUDE_API_KEY;     // from console.anthropic.com
const SUPABASE_URL     = process.env.SUPABASE_URL;       // from supabase.com
const SUPABASE_KEY     = process.env.SUPABASE_KEY;       // anon/public key

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CATEGORIES = ["food","transport","shopping","bills","health","entertainment","other"];
const CAT_EMOJI  = {food:"🍽️",transport:"🚗",shopping:"🛍️",bills:"💡",health:"💊",entertainment:"🎬",other:"📦"};

// ── WEBHOOK VERIFICATION (Meta requires this) ───────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── RECEIVE MESSAGES ────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // always ack immediately

  const entry   = req.body?.entry?.[0];
  const changes = entry?.changes?.[0];
  const msg     = changes?.value?.messages?.[0];
  if (!msg || msg.type !== "text") return;

  const from = msg.from;       // user's WhatsApp number
  const text = msg.text.body.trim();

  try {
    const reply = await handleMessage(from, text);
    await sendWhatsApp(from, reply);
  } catch (err) {
    console.error(err);
    await sendWhatsApp(from, "Sorry, something went wrong. Please try again.");
  }
});

// ── CORE MESSAGE HANDLER ────────────────────────────────────
async function handleMessage(userId, text) {
  const lower = text.toLowerCase();

  // ── COMMANDS ──
  if (lower === "summary" || lower === "report") return await getSummary(userId);
  if (lower === "today")                          return await getToday(userId);
  if (lower === "help")                           return getHelp();
  if (lower.startsWith("budget "))               return await setBudget(userId, text);
  if (lower.startsWith("delete last"))            return await deleteLast(userId);

  // ── CAN I AFFORD? ──
  if (lower.includes("afford") || lower.includes("can i buy") || lower.includes("should i buy")) {
    return await affordCheck(userId, text);
  }

  // ── SMS BANK ALERT ──
  const isSms = lower.includes("debited") || lower.includes("credited") ||
                lower.includes("rs.") || lower.includes("upi") ||
                (lower.includes("a/c") && /\d{3,}/.test(lower));
  if (isSms) return await parseSmsAndLog(userId, text);

  // ── NATURAL LANGUAGE EXPENSE ──
  return await parseAndLogExpense(userId, text);
}

// ── PARSE & LOG EXPENSE ─────────────────────────────────────
async function parseAndLogExpense(userId, text) {
  const parsed = await callClaude(
    `Parse this expense entry: "${text}"
Return ONLY valid JSON (no markdown):
{"amount":number,"description":"string","category":"food|transport|shopping|bills|health|entertainment|other","isExpense":true/false}
If it's not an expense, set isExpense: false.`
  );

  let obj;
  try { obj = JSON.parse(parsed.replace(/```json|```/g,"").trim()); }
  catch { return "I couldn't understand that. Try: *coffee 150* or *auto to office 80*"; }

  if (!obj.isExpense || obj.amount <= 0) {
    return await chatReply(userId, text);
  }

  const { error } = await supabase.from("expenses").insert({
    user_id: userId,
    amount: obj.amount,
    description: obj.description,
    category: obj.category || "other",
    date: new Date().toISOString().split("T")[0],
  });
  if (error) return "Failed to save. Try again.";

  const spent = await getMonthlySpent(userId, obj.category);
  const budget = await getBudget(userId, obj.category);
  let reply = `${CAT_EMOJI[obj.category]} Logged *₹${obj.amount}* for _${obj.description}_\nCategory: ${obj.category}`;

  if (budget && spent > budget) {
    reply += `\n\n⚠️ *Budget alert!* You've spent ₹${spent} of your ₹${budget} ${obj.category} budget.`;
  } else if (budget && spent > budget * 0.8) {
    reply += `\n\n🟡 ${Math.round(spent/budget*100)}% of ${obj.category} budget used.`;
  }

  return reply;
}

// ── PARSE SMS ALERT ─────────────────────────────────────────
async function parseSmsAndLog(userId, sms) {
  const parsed = await callClaude(
    `Extract expense from this bank SMS: "${sms}"
Return ONLY valid JSON (no markdown):
{"amount":number,"description":"string","category":"food|transport|shopping|bills|health|entertainment|other"}`
  );

  let obj;
  try { obj = JSON.parse(parsed.replace(/```json|```/g,"").trim()); }
  catch { return "Couldn't parse that SMS. Try forwarding the exact bank message."; }

  if (!obj.amount || obj.amount <= 0) return "No valid amount found in SMS.";

  await supabase.from("expenses").insert({
    user_id: userId,
    amount: obj.amount,
    description: obj.description,
    category: obj.category || "other",
    date: new Date().toISOString().split("T")[0],
  });

  return `${CAT_EMOJI[obj.category]} SMS logged!\n*₹${obj.amount}* — _${obj.description}_\nCategory: ${obj.category}`;
}

// ── SUMMARY ─────────────────────────────────────────────────
async function getSummary(userId) {
  const month = new Date().toISOString().slice(0,7);
  const { data } = await supabase.from("expenses")
    .select("category, amount")
    .eq("user_id", userId)
    .gte("date", month+"-01");

  if (!data?.length) return "No expenses logged this month yet!";

  const totals = {};
  CATEGORIES.forEach(c => totals[c] = 0);
  data.forEach(e => totals[e.category] = (totals[e.category]||0) + e.amount);
  const grand = Object.values(totals).reduce((a,b)=>a+b,0);

  let msg = `📊 *This month's summary*\n\n`;
  CATEGORIES.forEach(c => {
    if (totals[c] > 0) msg += `${CAT_EMOJI[c]} ${c}: *₹${totals[c].toLocaleString("en-IN")}*\n`;
  });
  msg += `\n💰 *Total: ₹${grand.toLocaleString("en-IN")}*`;
  return msg;
}

// ── TODAY ────────────────────────────────────────────────────
async function getToday(userId) {
  const today = new Date().toISOString().split("T")[0];
  const { data } = await supabase.from("expenses")
    .select("*").eq("user_id", userId).eq("date", today)
    .order("created_at", {ascending:false});

  if (!data?.length) return "No expenses logged today yet!";

  const total = data.reduce((s,e)=>s+e.amount,0);
  let msg = `📅 *Today's expenses*\n\n`;
  data.forEach(e => msg += `${CAT_EMOJI[e.category]} ₹${e.amount} — ${e.description}\n`);
  msg += `\n💰 *Total: ₹${total.toLocaleString("en-IN")}*`;
  return msg;
}

// ── AFFORD CHECK ─────────────────────────────────────────────
async function affordCheck(userId, text) {
  const spent = await getAllMonthlySpent(userId);
  const budgets = await getAllBudgets(userId);
  const { data: bills } = await supabase.from("bills").select("*").eq("user_id", userId);

  const context = `Monthly spent: ${JSON.stringify(spent)}. Budgets: ${JSON.stringify(budgets)}. Upcoming bills: ${JSON.stringify(bills||[])}.`;
  const reply = await callClaude(
    `${context}\nUser asks: "${text}"\nGive a clear YES or NO on whether they can afford it, with brief reasoning. Under 60 words. Plain text, use *bold* for key numbers.`
  );
  return reply;
}

// ── SET BUDGET ───────────────────────────────────────────────
async function setBudget(userId, text) {
  // e.g. "budget food 5000"
  const parts = text.toLowerCase().split(" ");
  const cat    = parts[1];
  const amount = parseInt(parts[2]);
  if (!CATEGORIES.includes(cat) || isNaN(amount)) {
    return `Invalid format. Try: *budget food 5000*\nCategories: ${CATEGORIES.join(", ")}`;
  }
  await supabase.from("budgets").upsert({user_id:userId, category:cat, amount}, {onConflict:"user_id,category"});
  return `✅ Budget set: *${cat}* → ₹${amount.toLocaleString("en-IN")}/month`;
}

// ── DELETE LAST ──────────────────────────────────────────────
async function deleteLast(userId) {
  const { data } = await supabase.from("expenses")
    .select("id, description, amount").eq("user_id", userId)
    .order("created_at", {ascending:false}).limit(1);
  if (!data?.length) return "No expenses to delete.";
  await supabase.from("expenses").delete().eq("id", data[0].id);
  return `🗑️ Deleted: ₹${data[0].amount} — ${data[0].description}`;
}

// ── GENERAL CHAT ─────────────────────────────────────────────
async function chatReply(userId, text) {
  const spent = await getAllMonthlySpent(userId);
  return await callClaude(
    `User's monthly spending: ${JSON.stringify(spent)}.\nUser says: "${text}"\nRespond as a friendly expense tracking assistant. Under 60 words. Plain text.`
  );
}

// ── HELP ─────────────────────────────────────────────────────
function getHelp() {
  return `💰 *Expense Tracker Bot*\n\n` +
    `*Log expenses:*\n` +
    `• coffee 150\n• auto to office 80\n• paid 1200 for groceries\n\n` +
    `*SMS alerts:*\nForward your bank SMS directly\n\n` +
    `*Commands:*\n` +
    `• *today* — today's expenses\n` +
    `• *summary* — monthly report\n` +
    `• *budget food 5000* — set budget\n` +
    `• *delete last* — undo last entry\n` +
    `• *Can I afford ₹5000 jacket?*`;
}

// ── HELPERS ──────────────────────────────────────────────────
async function getMonthlySpent(userId, category) {
  const month = new Date().toISOString().slice(0,7);
  const { data } = await supabase.from("expenses")
    .select("amount").eq("user_id", userId).eq("category", category).gte("date", month+"-01");
  return data?.reduce((s,e)=>s+e.amount,0) || 0;
}

async function getAllMonthlySpent(userId) {
  const month = new Date().toISOString().slice(0,7);
  const { data } = await supabase.from("expenses")
    .select("category, amount").eq("user_id", userId).gte("date", month+"-01");
  const totals = {};
  CATEGORIES.forEach(c=>totals[c]=0);
  data?.forEach(e=>totals[e.category]=(totals[e.category]||0)+e.amount);
  return totals;
}

async function getBudget(userId, category) {
  const { data } = await supabase.from("budgets")
    .select("amount").eq("user_id", userId).eq("category", category).single();
  return data?.amount || null;
}

async function getAllBudgets(userId) {
  const { data } = await supabase.from("budgets").select("category, amount").eq("user_id", userId);
  const b = {};
  data?.forEach(r=>b[r.category]=r.amount);
  return b;
}

async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  return data.content?.[0]?.text || "";
}

async function sendWhatsApp(to, message) {
  await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message },
    }),
  });
}

app.listen(3000, () => console.log("Bot running on port 3000"));
