const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("./tokens.db");

db.serialize(() => {
db.run(`
CREATE TABLE IF NOT EXISTS users (
email TEXT PRIMARY KEY,
access_token TEXT,
refresh_token TEXT,
scope TEXT,
token_type TEXT,
expiry_date INTEGER,
last_summary_sent_at INTEGER
)
`);
});

module.exports = db;