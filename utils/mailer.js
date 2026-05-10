const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Send an email via Resend
 *
 * @param {Object} options
 * @param {string}   options.to       - Recipient email address
 * @param {string}   options.subject  - Email subject
 * @param {string}   options.html     - HTML body
 * @param {string}  [options.text]    - Optional plain-text fallback
 */
const sendEmail = async ({ to, subject, html, text = "" }) => {
    try {
        const { data, error } = await resend.emails.send({
            from: `${process.env.MAIL_FROM_NAME || "HRMS Platform"} <${process.env.MAIL_FROM_ADDRESS}>`,
            to: [to],
            subject,
            html,
            text: text || stripHtml(html),
        });

        if (error) {
            console.error(`[Mailer] Resend error sending to ${to}:`, error);
            throw new Error(error.message);
        }

        console.log(`[Mailer] Email sent to ${to} — "${subject}" (id: ${data.id})`);
        return data;
    } catch (error) {
        console.error(`[Mailer] Failed to send email to ${to}:`, error.message);
        throw new Error(`Email delivery failed: ${error.message}`);
    }
};

// Basic HTML stripper for plain-text fallback
function stripHtml(html) {
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
}

module.exports = { sendEmail };