const twilio = require("twilio");
const config = require("../config.json");

module.exports = async function handler(req, res) {
  const toPhone = req.query.to;
  if (!toPhone) {
    return res.status(400).json({ error: "Add ?to=+1XXXXXXXXXX to the URL" });
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone = config.notifications.sms;

  console.log("Test SMS attempt:", { from: fromPhone, to: toPhone, hasSid: !!accountSid, hasAuth: !!authToken });

  try {
    const client = twilio(accountSid, authToken);
    const message = await client.messages.create({
      body: `Test from ${config.business.name} voice agent. Booking link: ${config.bookingLink}`,
      from: fromPhone,
      to: toPhone,
    });
    return res.status(200).json({
      success: true,
      sid: message.sid,
      status: message.status,
      from: fromPhone,
      to: toPhone,
    });
  } catch (err) {
    console.error("Test SMS failed:", err.message, err.code, err.moreInfo);
    return res.status(500).json({
      success: false,
      error: err.message,
      code: err.code,
      moreInfo: err.moreInfo || null,
    });
  }
};
