const TicketStatus = Object.freeze({
    OPEN: "open",
    IN_PROGRESS: "in_progress",
    RESOLVED: "resolved",
    CLOSED: "closed",
});

const TicketStatusLabel = Object.freeze({
    [TicketStatus.OPEN]: "Open",
    [TicketStatus.IN_PROGRESS]: "In Progress",
    [TicketStatus.RESOLVED]: "Resolved",
    [TicketStatus.CLOSED]: "Closed",
});

const TicketPriority = Object.freeze({
    LOW: "low",
    MEDIUM: "medium",
    HIGH: "high",
    CRITICAL: "critical",
});

const TicketPriorityLabel = Object.freeze({
    [TicketPriority.LOW]: "Low",
    [TicketPriority.MEDIUM]: "Medium",
    [TicketPriority.HIGH]: "High",
    [TicketPriority.CRITICAL]: "Critical",
});

module.exports = { TicketStatus, TicketStatusLabel, TicketPriority, TicketPriorityLabel };
