const Anthropic = require("@anthropic-ai/sdk");
const twilio = require("twilio");
const config = require("../config.json");

function buildSystemPrompt() {
  const { business, services, hours, faqs, serviceArea, collectFromCaller, bookingLink, branding } = config;

  const serviceList = services
    .map((s) => `${s.name}: ${s.description} (${s.priceRange})`)
    .join("\n");

  const hoursList = Object.entries(hours)
    .map(([day, time]) => `${day}: ${time}`)
    .join("\n");

  const faqList = faqs
    .map((f) => `Q: ${f.question}\nA: ${f.answer}`)
    .join("\n\n");

  const areas = serviceArea.join(", ");
  const fieldsToCollect = collectFromCaller.join(", ");

  return `You are ${branding.agentName}, a friendly and professional chat assistant for ${business.name}.

Business Info:
- Phone: ${business.phone}
- Website: ${business.website}
- Address: ${business.address}

Services:
${serviceList}

Hours:
${hoursList}

Service Area: ${areas}

FAQs:
${faqList}

Your job:
1. Answer customer questions about the business using ONLY the info above.
2. Be conversational, warm, and efficient. This is a text chat.
3. Keep responses concise — 2-3 sentences is ideal.
4. Do NOT use markdown formatting, bullet points, or numbered lists. Write in plain conversational sentences. The only exception is including the booking URL.
5. If someone asks about a service or area you don't have info on, politely say you're not sure and offer to have someone call them back.
6. Do not make up information that isn't provided above.

CONVERSATION FLOW — walk the customer through these questions one at a time:

STEP 1: Ask what problem they're having or what service they need.
  Example: "I'd be happy to help! Can you tell me a little about what's going on with your system?"

STEP 2: Ask for their name.
  Example: "Thanks for sharing that. And what's your name?"

STEP 3: Ask for their address or general location (so we know if they're in our service area).
  Example: "Great, and what's your address or what area are you located in?"

STEP 4: Ask for their phone number (so the team can reach them).
  Example: "And what's the best phone number to reach you at?"

STEP 5: Once you've collected their info (or if they've shown resistance at any point), offer the booking link.
  Example: "Perfect, I've got all your info. Here's a link to book your appointment: ${bookingLink}"

IMPORTANT RULES:
- Ask these questions ONE at a time across multiple responses. Do not ask more than one question per response.
- Be conversational and natural. Weave the questions into a friendly chat, don't make it feel like a form.
- If a customer answers a question, move to the next one. If they volunteer info early (like giving their name unprompted), skip that question.
- You do NOT need all the info to offer the link. If you've asked 2-3 questions and have some info, that's enough to offer the link.

RESISTANCE RULE — THIS IS CRITICAL:
- If at ANY point the customer shows resistance — refuses to answer a question, says "no", "I don't want to say", gives a vague deflection, seems annoyed, or gives gibberish — STOP asking questions immediately and offer the booking link right away.
- Do NOT push back, do NOT ask the same question again, do NOT try a different way to get the info. Just say something like "No problem at all! Here's a link to book your appointment whenever you're ready: ${bookingLink}"
- Also offer the link immediately if the customer explicitly asks to book or schedule.

- When you offer the link, always include the exact URL: ${bookingLink}
- Do NOT use markdown formatting. Write in plain conversational sentences.`;
}

async function extractLeadInfo(history) {
  const anthropic = new Anthropic();
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    system: `Extract any customer information from this conversation. Return ONLY valid JSON with these fields (use null for missing): {"name": "", "phone": "", "address": "", "serviceNeeded": ""}`,
    messages: [
      {
        role: "user",
        content: history.map((m) => `${m.role}: ${m.content}`).join("\n"),
      },
    ],
  });
  try {
    return JSON.parse(response.content[0].text);
  } catch {
    return null;
  }
}

async function sendLeadNotification(leadInfo) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const ownerPhone = config.notifications.ownerPhone;
  const fromPhone = config.notifications.sms;

  const timestamp = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
  const body = [
    `New Lead from ${config.business.name} Web Chat`,
    `Time: ${timestamp}`,
    `Name: ${leadInfo.name || "Not provided"}`,
    `Phone: ${leadInfo.phone || "Not provided"}`,
    `Address: ${leadInfo.address || "Not provided"}`,
    `Service Needed: ${leadInfo.serviceNeeded || "Not provided"}`,
  ].join("\n");

  console.log("LEAD NOTIFICATION:\n" + body);

  // Send SMS to business owner
  if (!accountSid || !authToken || !ownerPhone || ownerPhone === "+1XXXXXXXXXX") {
    console.log("LEAD SMS SKIPPED — missing Twilio credentials or ownerPhone not configured");
    return;
  }

  try {
    const client = twilio(accountSid, authToken);
    await client.messages.create({
      body: body,
      from: fromPhone,
      to: ownerPhone,
    });
    console.log(`LEAD SMS SENT to owner: ${ownerPhone}`);
  } catch (err) {
    console.error(`LEAD SMS FAILED: to=${ownerPhone}, error=${err.message}, code=${err.code}`);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { message, history = [] } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const anthropic = new Anthropic();

    const messages = history.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    if (!messages.length || messages[messages.length - 1].content !== message) {
      messages.push({ role: "user", content: message });
    }

    const claudeResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: buildSystemPrompt(),
      messages,
    });

    const textResponse = claudeResponse.content[0].text;

    // Check if we have enough info to send a lead notification
    const fullHistory = [...messages, { role: "assistant", content: textResponse }];
    const hasEnoughTurns = fullHistory.filter((m) => m.role === "user").length >= 2;

    if (hasEnoughTurns) {
      try {
        const info = await extractLeadInfo(fullHistory);
        if (info && (info.name || info.phone || info.serviceNeeded)) {
          await sendLeadNotification(info);
        }
      } catch (err) {
        console.error("Lead extraction/notification error:", err.message);
      }
    }

    return res.status(200).json({
      text: textResponse,
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
