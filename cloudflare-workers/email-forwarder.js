/**
 * Cloudflare Email Worker - Rosenweg Verteiler
 *
 * Forwards all incoming emails to Gmail with a plus-tag identifying the
 * original recipient. The API polls Gmail via IMAP and processes them.
 *
 * Example: ausschuss@rosenweg4303.ch → rosenweg4303+ausschuss@gmail.com
 *
 * Deployment:
 * cd cloudflare-workers && npx wrangler deploy --config wrangler-email.toml
 */

export default {
  async email(message, env, ctx) {
    const archiveEmail = env.ARCHIVE_EMAIL || "rosenweg4303@gmail.com";

    // Extract local part from recipient (e.g., "ausschuss" from "ausschuss@rosenweg4303.ch")
    const localPart = message.to.split("@")[0];

    // Build plus-tagged Gmail address (e.g., rosenweg4303+ausschuss@gmail.com)
    const [gmailUser, gmailDomain] = archiveEmail.split("@");
    const plusAddress = `${gmailUser}+${localPart}@${gmailDomain}`;

    try {
      await message.forward(plusAddress);
      console.log(`Forwarded: ${message.from} → ${message.to} → ${plusAddress} (${message.rawSize} bytes)`);
    } catch (err) {
      console.log(`Forward failed: ${err.message}, trying plain archive`);
      try {
        await message.forward(archiveEmail);
        console.log(`Fallback forward to ${archiveEmail}`);
      } catch (err2) {
        console.log(`All forwards failed: ${err2.message}`);
        message.setReject("Temporary error, please retry");
      }
    }
  },
};
