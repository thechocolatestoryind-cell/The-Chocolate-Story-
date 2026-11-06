// index.js — Firebase Cloud Function entry point (1st gen HTTPS function, region asia-south1 / Mumbai).
// URL after deploy: https://asia-south1-the-chocolate-story.cloudfunctions.net/api
"use strict";
const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const { makeApp } = require("./app");

admin.initializeApp();

// Browsers may call this API only from these storefront origins. Add more (e.g. a test domain) with the EXTRA_ORIGINS env var.
const ALLOWED_ORIGINS = ["https://thechocolatestory.in", "https://www.thechocolatestory.in", ...String(process.env.EXTRA_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean)];

exports.api = functions.region("asia-south1").runWith({ memory: "256MB", timeoutSeconds: 30, maxInstances: 5 }).https.onRequest(makeApp({
  db: admin.firestore(),
  verifyIdToken: (t) => admin.auth().verifyIdToken(t),
  serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
  allowedOrigins: ALLOWED_ORIGINS
}));
