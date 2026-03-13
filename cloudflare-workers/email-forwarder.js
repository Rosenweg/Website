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
    const archiveEmail = env.ARCHIVE_EMAIL || "rosenweg4303@gmail.com";

    // Always forward a copy to the archive/Gmail
    try {
      await message.forward(archiveEmail);
    } catch (fwdErr) {
      console.log(`Archive forward failed: ${fwdErr.message}`);
    }

    try {
      // Read the raw email as a stream
      const rawEmail = await new Response(message.raw).arrayBuffer();

      // Forward to our API for verteiler distribution
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

      if (!response.ok) {
        const text = await response.text();
        console.log(`API error ${response.status}: ${text}`);
      } else {
        const result = await response.json();
        console.log(`Email processed: ${message.from} → ${message.to} | ${result.action} (${result.recipients || 0} recipients)`);
      }
    } catch (err) {
      console.log(`Worker error: ${err.message}`);
    }
  },
};
