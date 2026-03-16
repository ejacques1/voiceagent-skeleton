const Anthropic = require("@anthropic-ai/sdk");
const twilio = require("twilio");
const config = require("../config.json");

function buildSystemPrompt(callerPhone) {
  const { business, services, hours, faqs, serviceArea, bookingLink, branding } = config;

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
3. You already have the caller's phone number (${callerPhone}) from caller ID. Do NOT ask for their phone number.
4. Try to naturally learn the caller's name, what service they need, and their address IF they are willing to share. But do NOT pressure them or refuse to help if they decline to share info.
5. At ANY point when the caller wants to book or schedule, or once you have answered their questions, offer to text them a booking link. Say something like "I can send you a text right now with a link to book your appointment." You do NOT need to collect all their info first.
6. When you tell the caller you will send them a text with the booking link, include the exact phrase "SEND_BOOKING_SMS" at the very end of your response. This is a hidden trigger and will not be spoken aloud. Use this trigger generously — whenever you mention sending a text, include it.
7. Keep every response to 2-3 sentences MAX. This is a phone call.
8. NEVER use markdown, bullet points, numbered lists, asterisks, or any special formatting. Speak naturally.
9. If someone asks about a service or area you don't have info on, politely say you're not sure and offer to have someone call them back.
10. Do not make up information that isn't provided above.
11. When wrapping up the call, always mention that you're sending them a text with the booking link, and include SEND_BOOKING_SMS.`;
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

async function sendBookingSms(toPhone) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken || !toPhone) {
    console.log("SMS skipped — missing credentials or phone:", { accountSid: !!accountSid, authToken: !!authToken, toPhone });
    return false;
  }

  try {
    const client = twilio(accountSid, authToken);
    const fromPhone = config.notifications.sms;

    const message = await client.messages.create({
      body: `Thanks for calling ${config.business.name}! Here's your link to book an appointment: ${config.bookingLink}`,
      from: fromPhone,
      to: toPhone,
    });
    console.log(`Booking SMS sent to ${toPhone}, SID: ${message.sid}`);
    return true;
  } catch (err) {
    console.error("SMS send failed:", err.message);
    return false;
  }
}

async function sendLeadNotification(history, callerPhone) {
  try {
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: `Extract any customer information from this phone conversation. Return ONLY valid JSON with these fields (use null for missing): {"name": "", "address": "", "serviceNeeded": ""}`,
      messages: [
        {
          role: "user",
          content: history.map((m) => `${m.role}: ${m.content}`).join("\n"),
        },
      ],
    });
    const info = JSON.parse(response.content[0].text);
    const timestamp = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
    console.log(
      `PHONE LEAD:\nTime: ${timestamp}\nName: ${info.name || "N/A"}\nPhone: ${callerPhone}\nAddress: ${info.address || "N/A"}\nService: ${info.serviceNeeded || "N/A"}`
    );
  } catch (err) {
    console.error("Lead extraction error:", err.message);
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
    const smsSentAlready = req.query.sms === "1";

    // Get caller's phone number — from Twilio on first call, or from URL on subsequent turns
    const callerPhone = req.body.From || req.query.caller || "";

    console.log(`Turn ${turn}, caller: ${callerPhone}, speech: ${speechResult || "(none)"}, smsSent: ${smsSentAlready}`);

    // First call — no speech yet, greet the caller
    if (!speechResult) {
      const history = [{ role: "assistant", content: config.greeting }];
      const action = `/api/twilio?turn=1&caller=${encodeURIComponent(callerPhone)}&sms=0&history=${encodeURIComponent(encodeHistory(history))}`;
      return res.status(200).send(twimlResponse(config.greeting, action));
    }

    // Subsequent turns — process speech
    let history = historyParam ? decodeHistory(decodeURIComponent(historyParam)) : [];
    history.push({ role: "user", content: speechResult });

    const anthropic = new Anthropic();
    const claudeResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: buildSystemPrompt(callerPhone),
      messages: history,
    });

    let responseText = claudeResponse.content[0].text;

    // Check for SMS trigger and strip it from spoken text
    const triggerDetected = responseText.includes("SEND_BOOKING_SMS");
    if (triggerDetected) {
      responseText = responseText.replace(/SEND_BOOKING_SMS/g, "").trim();
      console.log("SMS trigger detected in response");
    }

    history.push({ role: "assistant", content: responseText });

    // Send booking SMS if triggered and not already sent
    let smsSent = smsSentAlready;
    if (triggerDetected && !smsSent && callerPhone) {
      console.log("Sending SMS to:", callerPhone);
      sendBookingSms(callerPhone).then((ok) => {
        if (ok) console.log("SMS delivered successfully");
      }).catch(() => {});
      smsSent = true;
    }

    // Check if conversation should end
    const lower = responseText.toLowerCase();
    const isGoodbye =
      lower.includes("goodbye") ||
      lower.includes("have a great") ||
      lower.includes("thanks for calling") ||
      lower.includes("take care");

    const maxTurns = 12;
    if (isGoodbye || turn >= maxTurns) {
      // ALWAYS send SMS when call ends if it hasn't been sent yet
      if (!smsSent && callerPhone) {
        console.log("End of call — sending booking SMS as fallback to:", callerPhone);
        sendBookingSms(callerPhone).catch(() => {});
      }
      sendLeadNotification(history, callerPhone).catch(() => {});
      return res.status(200).send(twimlResponse(responseText));
    }

    const smsFlag = smsSent ? "1" : "0";
    const nextAction = `/api/twilio?turn=${turn + 1}&caller=${encodeURIComponent(callerPhone)}&sms=${smsFlag}&history=${encodeURIComponent(encodeHistory(history))}`;
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
