require("dotenv").config();
const express = require("express");
const { google } = require("googleapis");
const cron = require("node-cron");
const db = require("./db");
const runDailyJob = require("./cron");

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------------------
// Middleware
// -------------------------------
app.use(express.json());

// ======================================================
// STEP 0: HEALTH CHECK (important for Render / prod)
// ======================================================
app.get("/", (req, res) => {
  res.send("Promise Tracker backend is running ✅");
});

// ======================================================
// STEP 1: GOOGLE LOGIN (FRESH CLIENT — VERY IMPORTANT)
// ======================================================
app.get("/auth/google", (req, res) => {
  const loginClient = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  const authUrl = loginClient.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // 🔴 MUST for refresh_token
    scope: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  });

  res.redirect(authUrl);
});

// ======================================================
// STEP 2: GOOGLE CALLBACK (NO LOOP, SAFE FLOW)
// ======================================================
app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).send("Missing auth code");
    }

    // 🔐 Fresh client again (DO NOT reuse)
    const callbackClient = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    const { tokens } = await callbackClient.getToken(code);
    callbackClient.setCredentials(tokens);

    // 🔑 Get user email (identity)
    const oauth2 = google.oauth2({
      version: "v2",
      auth: callbackClient,
    });

    const { data } = await oauth2.userinfo.v2.me.get();
    const email = data.email;

    if (!email) {
      throw new Error("Email not received from Google");
    }

    // 💾 Save tokens to DB
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

    // 🔴 THIS REDIRECT STOPS THE OAUTH LOOP
    return res.redirect("/success");
  } catch (err) {
    console.error("❌ OAuth Error:", err.message);
    return res.status(500).send("OAuth failed");
  }
});

// ======================================================
// STEP 3: SUCCESS PAGE (HUMAN FEEDBACK ONLY)
// ======================================================
app.get("/success", (req, res) => {
  res.send(
    "✅ Gmail connected successfully. You will now receive daily reminders."
  );
});

// ======================================================
// STEP 4: SEND EMAIL (USED BY n8n)
// ======================================================
app.post("/send-email", (req, res) => {
  const { to, subject, body } = req.body;

  if (!to || !subject || !body) {
    return res.status(400).json({ error: "Missing fields" });
  }

  // 🔁 Load correct user token
  db.get("SELECT * FROM users WHERE email = ?", [to], async (err, user) => {
    if (err || !user) {
      return res.status(400).json({ error: "User not connected" });
    }

    try {
      // 🔐 User-specific OAuth client
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

// ======================================================
// SERVER START
// ======================================================
app.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
});

// ======================================================
// CRON — DAILY 9 AM IST
// ======================================================
cron.schedule(
  "0 9 * * *", // 9 AM IST
  () => {
    console.log("⏰ Running daily promise job...");
    runDailyJob();
  },
  {
    timezone: "Asia/Kolkata",
  }
);

console.log("🕘 Daily cron scheduled at 9 AM IST");
