const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        }),
    });
}

const fcmSender = {
    async send(token, title, body, data = {}) {
        const message = {
            token,
            notification: { title, body },
            data,
            android: { priority: "high" },
            apns: { payload: { aps: { sound: "default" } } },
        };
        return admin.messaging().send(message);
    },

    async sendBatch(tokens, title, body, data = {}) {
        if (!tokens.length) return { successCount: 0, failureCount: 0, responses: [] };

        const message = {
            notification: { title, body },
            data,
            android: { priority: "high" },
            apns: { payload: { aps: { sound: "default" } } },
        };

        const messages = tokens.map((token) => ({ ...message, token }));
        return admin.messaging().sendEach(messages); // sendEach = recommended over sendAll
    },
};

module.exports = fcmSender;