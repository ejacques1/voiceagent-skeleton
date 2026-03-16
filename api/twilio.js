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

  return `You are ${branding.agentName}, a friendly and professional phone agent for ${business.name}.

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
2. Be conversational, warm, and efficient. You are speaking on the phone.
3. After answering their question, guide the conversation toward collecting their info so we can schedule service.
4. You need to collect: ${fieldsToCollect}
5. Once you have their info, offer to send them a text message with a link to book their appointment. Say something like "I'll send you a text right now with a link to book your appointment." Do NOT read a URL out loud — the customer is on a phone and cannot click links.
6. When you are ready to send the booking link via text, include the exact phrase "SEND_BOOKING_SMS" at the very end of your response. This is a hidden trigger and will not be spoken aloud.
7. Keep every response to 2-3 sentences MAX. This is a phone call.
8. NEVER use markdown, bullet points, numbered lists, asterisks, or any special formatting. Speak naturally.
9. If someone asks about a service or area you don't have info on, politely say you're not sure and offer to have someone call them back.
10. Do not make up information that isn't provided above.`;
}

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twimlResponse(sayText, gatherAction) {
  const voice = config.voice.phone;
  if (gatherAction) {
    const safeAction = gatherAction.replace(/&/g, "&amp;");
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" timeout="5" speechTimeout="auto" action="${safeAction}">
    <Say voice="${voice}">${escapeXml(sayText)}</Say>
  </Gather>
  <Say voice="${voice}">I didn&apos;t catch that. Feel free to call back anytime. Goodbye!</Say>
</Response>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}">${escapeXml(sayText)}</Say>
  <Hangup/>
</Response>`;
}

function encodeHistory(history) {
  return Buffer.from(JSON.stringify(history)).toString("base64");
}

function decodeHistory(encoded) {
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
  } catch {
    return [];
  }
}

async function extractPhoneFromHistory(history) {
  try {
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 100,
      system: `Extract the customer's phone number from this conversation. Return ONLY the phone number in E.164 format (e.g., +15551234567). If no phone number was provided, return "none".`,
      messages: [
        {
          role: "user",
          content: history.map((m) => `${m.role}: ${m.content}`).join("\n"),
        },
      ],
    });
    const phone = response.content[0].text.trim();
    return phone !== "none" ? phone : null;
  } catch {
    return null;
  }
}

async function sendBookingSms(toPhone) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken || !toPhone) return;

  const client = twilio(accountSid, authToken);

  // Use the Twilio number that received the call (from config or env)
  const fromPhone = config.notifications.sms;

  await client.messages.create({
    body: `Thanks for calling ${config.business.name}! Here's your link to book an appointment: ${config.bookingLink}`,
    from: fromPhone,
    to: toPhone,
  });
  console.log(`Booking SMS sent to ${toPhone}`);
}

async function sendLeadNotification(history) {
  try {
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: `Extract any customer information from this phone conversation. Return ONLY valid JSON with these fields (use null for missing): {"name": "", "phone": "", "address": "", "serviceNeeded": ""}`,
      messages: [
        {
          role: "user",
          content: history.map((m) => `${m.role}: ${m.content}`).join("\n"),
        },
      ],
    });
    const info = JSON.parse(response.content[0].text);
    if (info && info.name) {
      const timestamp = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
      console.log(
        `PHONE LEAD:\nTime: ${timestamp}\nName: ${info.name}\nPhone: ${info.phone || "N/A"}\nAddress: ${info.address || "N/A"}\nService: ${info.serviceNeeded || "N/A"}`
      );
    }
  } catch (err) {
    console.error("Lead extraction error:", err);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Content-Type", "text/xml");
    return res.status(405).send(twimlResponse("Method not allowed."));
  }

  res.setHeader("Content-Type", "text/xml");

  try {
    const speechResult = req.body.SpeechResult;
    const historyParam = req.query.history;
    const turn = parseInt(req.query.turn || "0", 10);

    // First call — no speech yet, greet the caller
    if (!speechResult) {
      const history = [{ role: "assistant", content: config.greeting }];
      const action = `/api/twilio?turn=1&history=${encodeURIComponent(encodeHistory(history))}`;
      return res.status(200).send(twimlResponse(config.greeting, action));
    }

    // Subsequent turns — process speech
    let history = historyParam ? decodeHistory(decodeURIComponent(historyParam)) : [];
    history.push({ role: "user", content: speechResult });

    const anthropic = new Anthropic();
    const claudeResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: buildSystemPrompt(),
      messages: history,
    });

    let responseText = claudeResponse.content[0].text;

    // Check for SMS trigger and strip it from spoken text
    const shouldSendSms = responseText.includes("SEND_BOOKING_SMS");
    if (shouldSendSms) {
      responseText = responseText.replace("SEND_BOOKING_SMS", "").trim();
    }

    history.push({ role: "assistant", content: responseText });

    // Send booking SMS if triggered
    if (shouldSendSms) {
      extractPhoneFromHistory(history)
        .then((phone) => {
          if (phone) sendBookingSms(phone);
        })
        .catch(() => {});
    }

    // Check if conversation should end (collected all info or goodbye)
    const lower = responseText.toLowerCase();
    const isGoodbye =
      lower.includes("goodbye") ||
      lower.includes("have a great") ||
      lower.includes("thanks for calling");

    const maxTurns = 12;
    if (isGoodbye || turn >= maxTurns) {
      sendLeadNotification(history).catch(() => {});
      return res.status(200).send(twimlResponse(responseText));
    }

    const nextAction = `/api/twilio?turn=${turn + 1}&history=${encodeURIComponent(encodeHistory(history))}`;
    return res.status(200).send(twimlResponse(responseText, nextAction));
  } catch (error) {
    console.error("Twilio handler error:", error);
    return res
      .status(200)
      .send(
        twimlResponse(
          "I'm sorry, I'm having technical difficulties. Please call back or visit our website. Goodbye."
        )
      );
  }
};
