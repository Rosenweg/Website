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

    // Read raw email FIRST before any forwarding (stream can only be consumed once)
    let rawEmail;
    try {
      rawEmail = await new Response(message.raw).arrayBuffer();
    } catch (err) {
      console.log(`Failed to read raw email: ${err.message}`);
      await message.forward(archiveEmail);
      return;
    }

    // Forward copy to Gmail archive using raw bytes
    try {
      await message.forward(archiveEmail);
    } catch (fwdErr) {
      console.log(`Archive forward failed: ${fwdErr.message}`);
    }

    // Forward to API for verteiler distribution
    try {
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
