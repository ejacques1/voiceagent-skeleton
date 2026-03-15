const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf-8")
);

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

  return `You are ${branding.agentName}, a friendly and professional voice assistant for ${business.name}.

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
2. Be conversational, warm, and efficient.
3. After answering their question, guide the conversation toward collecting their info so we can schedule service.
4. You need to collect: ${fieldsToCollect}
5. Once you have all their info, offer to book an appointment and mention this link: ${bookingLink}
6. Keep every response to 2-3 sentences MAX. These responses are spoken aloud.
7. NEVER use markdown, bullet points, numbered lists, asterisks, or any special formatting. Speak naturally as if on a phone call.
8. If someone asks about a service or area you don't have info on, politely say you're not sure and offer to have someone call them back.
9. Do not make up information that isn't provided above.`;
}

async function extractLeadInfo(history) {
  const anthropic = new Anthropic();
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    system: `Extract any customer information from this conversation. Return ONLY valid JSON with these fields (use null for missing): {"name": "", "phone": "", "address": "", "serviceNeeded": "", "preferredDate": ""}`,
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
    `New Lead from ${config.business.name} Voice Agent`,
    `Time: ${timestamp}`,
    `Name: ${leadInfo.name || "Not provided"}`,
    `Phone: ${leadInfo.phone || "Not provided"}`,
    `Address: ${leadInfo.address || "Not provided"}`,
    `Service Needed: ${leadInfo.serviceNeeded || "Not provided"}`,
    `Preferred Date: ${leadInfo.preferredDate || "Not provided"}`,
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
    const openai = new OpenAI();

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

    const ttsResponse = await openai.audio.speech.create({
      model: "tts-1",
      input: textResponse,
      voice: config.voice.web,
    });

    const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
    const audioBase64 = audioBuffer.toString("base64");

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
      audio: audioBase64,
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
