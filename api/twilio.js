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

CONVERSATION FLOW — walk the caller through these steps one at a time:

TURN 1 (first reply after greeting):
- Acknowledge what the caller said.
- Mention their phone number naturally: "I can see you're calling from ${callerPhone}, so I've got your number."
- Ask what problem they're having or what service they need.
- Do NOT offer the booking link yet.

TURN 2:
- Respond to what they said about their problem. Give helpful info if you have it.
- Ask for their name.
- Do NOT offer the booking link yet.

TURN 3:
- Ask for their address or what area they're in, so you can confirm they're in the service area.

TURN 4:
- You already have their phone number from caller ID (${callerPhone}), so you do NOT need to ask for it.
- Now wrap up. Say something like "I've got all your info. I'm going to send a text to ${callerPhone} with a link to book your appointment."
- Include SEND_BOOKING_SMS at the very end of this response.

IMPORTANT RULES:
- Ask ONE question per turn. Keep each response to 2-3 sentences. This is a phone call — be natural and conversational.
- NEVER use markdown, bullet points, numbered lists, or any formatting. Speak naturally.
- If a caller volunteers info early (like giving their name unprompted), skip that question and move to the next one.
- You do NOT need all the info to offer the link. If you've asked 2-3 questions and have some info, that's enough.
- Do not make up information that isn't provided in the business details above.

RESISTANCE RULE — THIS IS CRITICAL:
- If at ANY point the caller shows resistance — refuses to answer, says "no", "I don't want to say", seems annoyed, gives gibberish, goes silent, or you can't hear them — STOP asking questions immediately.
- Say something like "No problem at all, let me send you a text with a link to book an appointment whenever you're ready." Then include SEND_BOOKING_SMS.
- Do NOT push back. Do NOT ask the question again. Do NOT try another way to get the info. Just offer the link and wrap up.
- Also offer the link immediately if the caller explicitly asks to book or schedule.
- NEVER tell a caller to "call back." NEVER end the call without offering the booking link.
- When wrapping up for ANY reason, mention you're sending a text with the booking link and include SEND_BOOKING_SMS.
- SEND_BOOKING_SMS goes at the very end of your response. It is a hidden trigger — it will not be spoken aloud.

BUSINESS INFO:
- Phone: ${business.phone}
- Website: ${business.website}
- Address: ${business.address}

Services:
${serviceList}

Hours:
${hoursList}

Service Area: ${areas}

FAQs:
${faqList}`;
}

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twimlResponse(sayText, gatherAction, callerPhone) {
  const voice = config.voice.phone;
  if (gatherAction) {
    const safeAction = gatherAction.replace(/&/g, "&amp;");
    // Build a fallback redirect that sends the SMS before hanging up
    const fallbackAction = `/api/twilio?sendlink=1&amp;caller=${encodeURIComponent(callerPhone || "")}`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" timeout="5" speechTimeout="auto" action="${safeAction}">
    <Say voice="${voice}">${escapeXml(sayText)}</Say>
  </Gather>
  <Say voice="${voice}">I didn&apos;t quite catch that, but no worries. I&apos;m going to send you a text right now with a link to book an appointment. You can use that to schedule at your convenience. Thanks for calling ${escapeXml(config.business.name)}!</Say>
  <Redirect method="POST">${fallbackAction}</Redirect>
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
    console.log("SMS SKIPPED — missing credentials or phone:", { accountSid: !!accountSid, authToken: !!authToken, toPhone });
    return false;
  }

  const fromPhone = config.notifications.sms;

  // Prevent sending to/from the same number
  if (toPhone === fromPhone) {
    console.log("SMS SKIPPED — caller phone is same as Twilio number:", toPhone);
    return false;
  }

  try {
    const client = twilio(accountSid, authToken);

    console.log(`SMS ATTEMPTING: from=${fromPhone} to=${toPhone}`);
    const message = await client.messages.create({
      body: `Thanks for calling ${config.business.name}! Here's your link to book an appointment: ${config.bookingLink}`,
      from: fromPhone,
      to: toPhone,
    });
    console.log(`SMS SUCCESS: SID=${message.sid}, status=${message.status}, to=${toPhone}`);
    return true;
  } catch (err) {
    console.error(`SMS FAILED: to=${toPhone}, error=${err.message}, code=${err.code}`);
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
    const body = [
      `New Lead from ${config.business.name} Phone Call`,
      `Time: ${timestamp}`,
      `Name: ${info.name || "Not provided"}`,
      `Phone: ${callerPhone || "Not provided"}`,
      `Address: ${info.address || "Not provided"}`,
      `Service Needed: ${info.serviceNeeded || "Not provided"}`,
    ].join("\n");

    console.log("PHONE LEAD NOTIFICATION:\n" + body);

    // Send SMS to business owner
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const ownerPhone = config.notifications.ownerPhone;
    const fromPhone = config.notifications.sms;

    if (!accountSid || !authToken || !ownerPhone || ownerPhone === "+1XXXXXXXXXX") {
      console.log("LEAD SMS SKIPPED — missing Twilio credentials or ownerPhone not configured");
      return;
    }

    const client = twilio(accountSid, authToken);
    await client.messages.create({
      body: body,
      from: fromPhone,
      to: ownerPhone,
    });
    console.log(`LEAD SMS SENT to owner: ${ownerPhone}`);
  } catch (err) {
    console.error("Lead extraction/notification error:", err.message);
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

    // Handle Gather timeout fallback — send SMS and hang up
    if (req.query.sendlink === "1") {
      console.log("Gather timeout fallback — sending SMS to:", callerPhone);
      if (callerPhone) {
        await sendBookingSms(callerPhone);
      }
      const voice = config.voice.phone;
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`);
    }

    // First call — no speech yet, greet the caller
    if (!speechResult) {
      const history = [{ role: "assistant", content: config.greeting }];
      const action = `/api/twilio?turn=1&caller=${encodeURIComponent(callerPhone)}&sms=0&history=${encodeURIComponent(encodeHistory(history))}`;
      return res.status(200).send(twimlResponse(config.greeting, action, callerPhone));
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

    // Send booking SMS if triggered and not already sent — MUST await before response
    let smsSent = smsSentAlready;
    if (triggerDetected && !smsSent && callerPhone) {
      console.log("Sending SMS to:", callerPhone);
      await sendBookingSms(callerPhone);
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
      // ALWAYS send SMS when call ends if it hasn't been sent yet — await it
      if (!smsSent && callerPhone) {
        console.log("End of call — sending booking SMS as fallback to:", callerPhone);
        await sendBookingSms(callerPhone);
      }
      // Await lead notification SMS before responding (Vercel kills after res.send)
      await sendLeadNotification(history, callerPhone);
      return res.status(200).send(twimlResponse(responseText, null, callerPhone));
    }

    const smsFlag = smsSent ? "1" : "0";
    const nextAction = `/api/twilio?turn=${turn + 1}&caller=${encodeURIComponent(callerPhone)}&sms=${smsFlag}&history=${encodeURIComponent(encodeHistory(history))}`;
    return res.status(200).send(twimlResponse(responseText, nextAction, callerPhone));
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
