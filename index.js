require("dotenv").config();
const express = require("express");
const { google } = require("googleapis");
const cron = require("node-cron");
const db = require("./db");
const runDailyJob = require("./cron");

const app = express();
const PORT = 3000;

app.use(express.json());

// ===============================
// STEP 1: GOOGLE LOGIN
// ===============================
app.get("/auth/google", (req, res) => {
  const loginClient = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  const url = loginClient.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/userinfo.email"
    ],
  });

  res.redirect(url);
});

// ===============================
// STEP 2: GOOGLE CALLBACK
// ===============================
app.get("/auth/google", async (req, res) => {
  try {
    const { code } = req.query;

    const callbackClient = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    const { tokens } = await callbackClient.getToken(code);
    callbackClient.setCredentials(tokens);

    // ✅ Get user email safely
    const oauth2 = google.oauth2({
      version: "v2",
      auth: callbackClient,
    });

    const { data } = await oauth2.userinfo.v2.me.get();
    const email = data.email;

    // 💾 Save tokens in DB
    db.run(
      `
      INSERT OR REPLACE INTO users
      (email, access_token, refresh_token, expiry_date)
      VALUES (?, ?, ?, ?)
      `,
      [
        email,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expiry_date,
      ]
    );

    console.log("✅ Tokens saved for:", email);
    res.send("Gmail connected successfully. You can close this tab.");
  } catch (err) {
    console.error("❌ OAuth Error:", err.message);
    res.status(500).send("OAuth failed");
  }
});

// ===============================
// STEP 3: SEND EMAIL (used by n8n)
// ===============================
app.post("/send-email", (req, res) => {
  const { to, subject, body } = req.body;

  if (!to || !subject || !body) {
    return res.status(400).json({ error: "Missing fields" });
  }

  db.get("SELECT * FROM users WHERE email = ?", [to], async (err, user) => {
    if (err || !user) {
      return res.status(400).json({ error: "User not connected" });
    }

    try {
      const userClient = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );

      userClient.setCredentials({
        access_token: user.access_token,
        refresh_token: user.refresh_token,
        expiry_date: user.expiry_date,
      });

      const gmail = google.gmail({
        version: "v1",
        auth: userClient,
      });

      const rawMessage = Buffer.from(
        `To: ${to}\r\n` +
        `Subject: ${subject}\r\n` +
        `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
        body
      )
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: rawMessage },
      });

      res.json({ success: true });
    } catch (e) {
      console.error("❌ SEND EMAIL ERROR:", e.message);
      res.status(500).json({ error: "Email failed" });
    }
  });
});

// ===============================
// SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
});

// ===============================
// CRON (enable later)
// ===============================
 cron.schedule(
   "* * * * *",
   () => runDailyJob(),
   { timezone: "Asia/Kolkata" }
 );

console.log("Backend started");
