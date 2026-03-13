/**
 * Cloudflare Email Worker - Rosenweg Verteiler
 *
 * Fängt alle eingehenden Emails an @rosenweg4303.ch ab und leitet sie
 * als Raw-Email an die API weiter, die dann via SMTP2GO verteilt.
 *
 * Deployment:
 * 1. In Cloudflare Dashboard → Email → Email Routing → Email Workers
 * 2. Neuen Worker erstellen mit diesem Code
 * 3. Unter "Routing Rules" die gewünschten Adressen auf diesen Worker routen
 *
 * Oder via wrangler:
 * wrangler deploy --name email-forwarder email-forwarder.js
 */

export default {
  async email(message, env, ctx) {
    const apiUrl = env.API_URL || "https://www.rosenweg4303.ch/api/email/inbound";
    const secret = env.EMAIL_SECRET || "rosenweg-email-2026";
    const fallbackEmail = env.ARCHIVE_EMAIL || "rosenweg4303@gmail.com";

    console.log(`Worker invoked: ${message.from} → ${message.to} (size: ${message.rawSize})`);

    try {
      // Read the raw email (stream can only be consumed once)
      const rawEmail = await new Response(message.raw).arrayBuffer();
      console.log(`Raw email read: ${rawEmail.byteLength} bytes`);

      // Forward to our API for verteiler distribution (API also sends archive copy)
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "message/rfc822",
          "X-Email-Secret": secret,
          "X-Original-To": message.to,
          "X-Original-From": message.from,
        },
        body: rawEmail,
      });

      console.log(`API response: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        const text = await response.text();
        console.log(`API error body: ${text.substring(0, 500)}`);
        // API failed - forward to Gmail as fallback
        await message.forward(fallbackEmail);
        console.log(`Fallback: forwarded to ${fallbackEmail}`);
      } else {
        const result = await response.json();
        console.log(`Email processed: ${message.from} → ${message.to} | ${result.action} (${result.recipients || 0} recipients)`);
      }
    } catch (err) {
      console.log(`Worker error: ${err.name}: ${err.message}`);
      console.log(`Stack: ${err.stack}`);
      // Worker/network error - forward to Gmail as fallback
      try {
        await message.forward(fallbackEmail);
        console.log(`Fallback: forwarded to ${fallbackEmail}`);
      } catch (fwdErr) {
        console.log(`Forward also failed: ${fwdErr.message}`);
        // Last resort - reject with temporary error so sender retries
        message.setReject(`Temporary error, please retry`);
      }
    }
  },
};
