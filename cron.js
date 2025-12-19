const db = require("./db");
const axios = require("axios");

async function runDailyJob() {
console.log("⏰ Running daily promise job...");

db.all("SELECT * FROM users", async (err, users) => {
if (err) return console.error(err);

const today = new Date().toDateString();

for (const user of users) {
const lastSent = user.last_summary_sent_at
? new Date(user.last_summary_sent_at).toDateString()
: null;

// ❌ Already sent today → skip
if (lastSent === today) {
console.log(`⏭️ Skipped (already sent): ${user.email}`);
continue;
}

try {
await axios.post(user.webhook_url, {
userEmail: user.email,
});

// ✅ Mark as sent
db.run(
"UPDATE users SET last_summary_sent_at = ? WHERE email = ?",
[Date.now(), user.email]
);

console.log(`✅ Triggered n8n for ${user.email}`);
} catch (e) {
console.error(`❌ Failed for ${user.email}`, e.message);
}
}
});
}

module.exports = runDailyJob;
