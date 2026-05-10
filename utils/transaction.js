
const bsCustAccInfoModel = require('../models/bsCustAccInfoModel');

// Asynchronously get or create a unique transaction number
async function getOrCreateTransactionNo(transaction_no) {
    if (transaction_no) {
        return parseInt(transaction_no); // ensure it's always an integer
    }
    let unique = false;
    let newTransactionNo;
    while (!unique) {
        newTransactionNo = Math.floor(100000 + Math.random() * 900000); // 6-digit int
        const existing = await bsCustAccInfoModel.findByTransactionNumber(newTransactionNo);
        if (!existing || existing.length === 0) {
            unique = true;
        }
    }
    return newTransactionNo;
}

module.exports = { getOrCreateTransactionNo };