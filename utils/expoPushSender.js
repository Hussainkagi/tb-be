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
            // The app's own sound (my-app/assets/sounds/notifications.mp3).
            // iOS plays it by file name; Android plays whatever the channel
            // was created with, so the push names that channel too. Both are
            // defined in my-app/utils/notification.ts.
            sound: "notifications.mp3",
            channelId: "teambook-alerts",
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