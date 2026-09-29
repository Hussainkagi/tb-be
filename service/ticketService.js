const TicketModel = require("../models/ticketModel");
const CompanyModel = require("../models/companyModel");
const UserCompanyModel = require("../models/userCompanyModel");
const { uploadToCloudinary } = require("../utils/cloudinaryHelper");
const { sendEmail } = require("../utils/mailer");
const {
  ticketCreatedEmail,
  ticketStatusUpdatedEmail,
} = require("../utils/emailTemplates");
const { Role } = require("../enums/roles");
const {
  TicketStatus,
  TicketStatusLabel,
  TicketPriority,
} = require("../enums/ticketEnums");

// Fixed per the product requirement — every new ticket notifies Ikration
// support directly, not something a company can redirect.
const SUPPORT_NOTIFY_EMAIL = "team@ikration.com";

const MAX_IMAGES = 3;

const PORTAL_URL = (
  process.env.FRONTEND_URL || "https://teambook.ikration.com"
).replace(/\/$/, "");

async function getCompanyAdminEmails(company_id) {
  const members = await UserCompanyModel.findAllByCompanyId(company_id);
  return members
    .filter((m) => Number(m.role) === Role.ADMIN && m.email)
    .map((m) => m.email);
}

const TicketService = {
  /**
   * @param {Buffer[]} imageBuffers up to MAX_IMAGES raw file buffers (multer memoryStorage)
   */
  async createTicket({
    company_id,
    raised_by,
    subject,
    description,
    priority,
    imageBuffers = [],
  }) {
    const cleanPriority = Object.values(TicketPriority).includes(priority)
      ? priority
      : TicketPriority.MEDIUM;

    const ticket = await TicketModel.create({
      company_id,
      raised_by,
      subject: subject.trim(),
      description: description.trim(),
      priority: cleanPriority,
    });

    // Images are uploaded AFTER the row exists so they can be filed under
    // the ticket's own id — a partial upload failure still leaves a valid
    // ticket behind rather than blocking creation on Cloudinary being up.
    if (imageBuffers.length > 0) {
      const uploads = await Promise.allSettled(
        imageBuffers.slice(0, MAX_IMAGES).map((buffer, i) =>
          uploadToCloudinary(buffer, {
            folder: `support-tickets/${company_id}/${ticket.id}`,
            publicId: `image-${i + 1}`,
            resourceType: "image",
          }),
        ),
      );
      const urls = uploads
        .filter((r) => r.status === "fulfilled")
        .map((r) => r.value.secureUrl);

      if (urls.length > 0) {
        await TicketModel.updateImages(ticket.id, urls);
        ticket.images = urls;
      }
    }

    const company = await CompanyModel.findById(company_id);
    try {
      await sendEmail({
        to: SUPPORT_NOTIFY_EMAIL,
        subject: `[${ticket.ticket_number}] New support ticket — ${company?.company_name ?? "Unknown company"}: ${ticket.subject}`,
        html: ticketCreatedEmail({
          company_name: company?.company_name ?? "Unknown company",
          ticket,
          portal_url: `${PORTAL_URL}/platform/tickets/${ticket.id}`,
        }),
      });
    } catch (error) {
      // A notification failure must not undo an already-created ticket.
      console.error(
        `[Tickets] Failed to notify ${SUPPORT_NOTIFY_EMAIL} of ticket ${ticket.id}:`,
        error.message,
      );
    }

    return ticket;
  },

  async getForCompany(ticket_id, company_id) {
    const ticket = await TicketModel.findById(ticket_id);
    if (!ticket || ticket.company_id !== company_id) return null;
    const messages = await TicketModel.listMessages(ticket_id);
    return { ticket, messages };
  },

  async getForPlatform(ticket_id) {
    const ticket = await TicketModel.findById(ticket_id);
    if (!ticket) return null;
    const messages = await TicketModel.listMessages(ticket_id);
    return { ticket, messages };
  },

  listForCompany(company_id, filters) {
    return TicketModel.listByCompany(company_id, filters);
  },

  listForPlatform(filters) {
    return TicketModel.listAll(filters);
  },

  async addCompanyReply(ticket_id, company_id, user_id, message) {
    const ticket = await TicketModel.findById(ticket_id);
    if (!ticket || ticket.company_id !== company_id) return null;

    return TicketModel.addMessage({
      ticket_id,
      message_type: "reply",
      sender_type: "company",
      sender_user_id: user_id,
      message: message.trim(),
    });
  },

  async addPlatformReply(ticket_id, user_id, message) {
    const ticket = await TicketModel.findById(ticket_id);
    if (!ticket) return null;

    return TicketModel.addMessage({
      ticket_id,
      message_type: "reply",
      sender_type: "platform",
      sender_user_id: user_id,
      message: message.trim(),
    });
  },

  /** Platform-only — changes status, logs it in the thread, emails the company's admins. */
  async updateStatus(ticket_id, new_status, actor_user_id) {
    if (!Object.values(TicketStatus).includes(new_status)) {
      throw new Error(`Invalid status: ${new_status}`);
    }

    const before = await TicketModel.findById(ticket_id);
    if (!before) return null;
    if (before.status === new_status) return before;

    const updated = await TicketModel.updateStatus(ticket_id, new_status);

    await TicketModel.addMessage({
      ticket_id,
      message_type: "status_change",
      sender_type: "platform",
      sender_user_id: actor_user_id,
      metadata: { from_status: before.status, to_status: new_status },
    });

    try {
      const admins = await getCompanyAdminEmails(before.company_id);
      if (admins.length > 0) {
        const company = await CompanyModel.findById(before.company_id);
        const html = ticketStatusUpdatedEmail({
          company_name: company?.company_name ?? "",
          ticket: updated,
          new_status_label: TicketStatusLabel[new_status],
          // op=9 is the Support tab — see the SettingsSection map
          // in frontend/components/settings/SettingsPage.tsx.
          portal_url: `${PORTAL_URL}/profile?tab=settings&op=9`,
        });
        for (const to of admins) {
          await sendEmail({
            to,
            subject: `[${updated.ticket_number}] Your ticket "${updated.subject}" is now ${TicketStatusLabel[new_status]}`,
            html,
          });
        }
      }
    } catch (error) {
      console.error(
        `[Tickets] Failed to notify admins of ticket ${ticket_id} status change:`,
        error.message,
      );
    }

    return updated;
  },
};

module.exports = TicketService;
