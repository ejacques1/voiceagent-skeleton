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

  try {
    const client = twilio(accountSid, authToken);

    // Send the SMS
    const message = await client.messages.create({
      body: `Test from ${config.business.name} voice agent. Booking link: ${config.bookingLink}`,
      from: fromPhone,
      to: toPhone,
    });

    // Wait 2 seconds then check delivery status
    await new Promise((r) => setTimeout(r, 2000));
    const updated = await client.messages(message.sid).fetch();

    return res.status(200).json({
      success: true,
      sid: message.sid,
      initialStatus: message.status,
      deliveryStatus: updated.status,
      errorCode: updated.errorCode || null,
      errorMessage: updated.errorMessage || null,
      from: fromPhone,
      to: toPhone,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
      code: err.code,
      moreInfo: err.moreInfo || null,
    });
  }
};
