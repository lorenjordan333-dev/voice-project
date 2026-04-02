console.log("APP BOOTED");
console.log("NODE VERSION:", process.version);

const express = require("express");
const WebSocket = require("ws");
require("dotenv").config();
const http = require("http");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/voice", (req, res) => {
  res.send("OK");
});

app.post("/voice", (req, res) => {
  console.log("VOICE HIT");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "voice-project-production-3574.up.railway.app";
  const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://' + host + '/stream" /></Connect></Response>';
  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/stream" });

wss.on("connection", (ws) => {
  console.log("Twilio connected");

  let streamSid = null;
  let callSid = null;
  let openaiReady = false;
  let greetingSent = false;
  let aiSpeaking = false;

  let systemState = {
    service: null,
    lockType: null,
    address: null,
    language: "english",
    confirmed: false,
  };

  let priceStage = 0;
  let lastUserText = "";
  let repeatCount = 0;

  function buildPrompt() {
    const known = [];
    const missing = [];

    if (systemState.service) known.push("service: " + systemState.service);
    else missing.push("service type");

    if (systemState.lockType) known.push("lock type: " + systemState.lockType);
    else missing.push("lock type");

    if (systemState.address) known.push("address: " + systemState.address);
    else missing.push("address");

    const knownStr =
      known.length > 0
        ? "You already know: " + known.join(", ") + "."
        : "You do not know anything yet.";

    const missingStr =
      missing.length > 0
        ? "Still need to get: " + missing.join(", ") + "."
        : "You have everything you need.";

    return (
      "You are Kelly, a professional locksmith dispatcher
