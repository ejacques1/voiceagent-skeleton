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

CONVERSATION FLOW:
- On your FIRST response: Answer their question or greet them warmly. Ask what service they need or what's going on. Do NOT include the booking link on this turn. Just have a normal, helpful conversation start.
- On your SECOND response: Answer their follow-up briefly. Then offer the booking link naturally. Say something like "I'd love to get you scheduled — here's a link to book your appointment: ${bookingLink}"
- On your THIRD response (if the conversation continues): You MUST include the booking link if you haven't already. No exceptions.
- A short answer like "heating" or "AC" or "hi" is normal — it does NOT mean the person is reluctant. Continue the conversation naturally.

WHEN TO OFFER THE LINK EARLY (on your second response instead of continuing to chat):
- The customer explicitly asks to book, schedule, or get an appointment
- The customer declines to answer a question or says they don't want to share info (e.g., "no", "I don't want to say", "none of your business")
- The customer gives complete gibberish or clearly nonsensical responses
- The conversation has gone 3+ turns without the link being shared

RULES FOR THE BOOKING LINK:
- You do NOT need to collect ANY information before offering the link. Calendly handles scheduling details.
- NEVER ask for the customer's address. Calendly and the service team handle that.
- NEVER ask for the customer's phone number.
- If a customer declines to share their name or any info, that is 100% fine. Do NOT push. Offer the booking link instead.
- NEVER hold the booking link hostage behind collecting information.
- Ask a MAXIMUM of 2 questions total across the entire conversation. Do not interrogate the customer.
- When you offer the link, include the exact URL in your text: ${bookingLink}`;
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
