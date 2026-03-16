const Anthropic = require("@anthropic-ai/sdk");
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

BOOKING LINK RULES — THIS IS CRITICAL:
- Your #1 goal is to get the customer to the booking link: ${bookingLink}
- Offer the booking link early and often. By your SECOND response at the latest, you should be including the link.
- You do NOT need to collect ANY information before offering the link. The booking link is a Calendly page — Calendly handles all the scheduling details.
- If the customer says what service they need (even vaguely like "heating" or "AC"), answer briefly and immediately offer the link. Say something like "Here's a link to book your appointment: ${bookingLink}"
- If a customer declines to share their name, address, phone number, or ANY personal info, that is 100% fine. Do NOT push. Just offer the booking link.
- NEVER hold the booking link hostage behind collecting information. The link should flow freely.
- If the conversation stalls, the customer seems confused, or gives unclear responses, offer the booking link.
- You may casually ask for their name or what service they need, but NEVER require it before sharing the link.
- NEVER ask for the customer's address. Calendly and the service team handle that.
- Ask a MAXIMUM of 2 questions total across the entire conversation. Do not interrogate the customer.`;
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
  const email = process.env.NOTIFICATION_EMAIL || config.notifications.email;
  if (!email) return;

  const timestamp = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
  const body = [
    `New Lead from ${config.business.name} Chat Agent`,
    `Time: ${timestamp}`,
    `Name: ${leadInfo.name || "Not provided"}`,
    `Phone: ${leadInfo.phone || "Not provided"}`,
    `Address: ${leadInfo.address || "Not provided"}`,
    `Service Needed: ${leadInfo.serviceNeeded || "Not provided"}`,
  ].join("\n");

  console.log("LEAD NOTIFICATION:\n" + body);
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
    const hasEnoughTurns = fullHistory.filter((m) => m.role === "user").length >= 3;

    if (hasEnoughTurns) {
      extractLeadInfo(fullHistory)
        .then((info) => {
          if (info && info.name && info.phone) {
            sendLeadNotification(info);
          }
        })
        .catch(() => {});
    }

    return res.status(200).json({
      text: textResponse,
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
