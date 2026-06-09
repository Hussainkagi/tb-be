// utils/expoPushSender.js
const { Expo } = require("expo-server-sdk");
const expo = new Expo();

const expoPushSender = {
    async send(token, title, body, data = {}) {
        if (!Expo.isExpoPushToken(token)) {
            throw Object.assign(
                new Error(`Invalid Expo push token: ${token}`),
                { code: "messaging/invalid-registration-token" }
            );
        }

        const [ticket] = await expo.sendPushNotificationsAsync([{
            to: token,
            title,
            body,
            data,
            sound: "default",
            priority: "high",
        }]);

        if (ticket.status === "error") {
            throw Object.assign(
                new Error(ticket.message),
                { code: ticket.details?.error ?? "expo/unknown" }
            );
        }

        return ticket;
    },
};

module.exports = expoPushSender;