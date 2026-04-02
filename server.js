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

  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host ||
    "voice-project-production-3574.up.railway.app";

  const twiml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Connect>\n    <Stream url="wss://' +
    host +
    '/stream" />\n  </Connect>\n</Response>';

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
      "You are Kelly, a professional locksmith dispatcher. " +
      "Always greet with: Locksmith services, hi, this is Kelly, how can I help? " +
      "Be natural, calm, and human. Speak in short sentences. Listen more than you talk. " +
      "Never interrupt the customer. " +
      "If the customer speaks French, switch fully to French. " +
      knownStr +
      " " +
      missingStr +
      " Keep the conversation natural. Do not rush. Get the missing info one step at a time."
    );
  }

  function detect(text) {
    const t = text.toLowerCase();

    if (t.includes("locked out") || t.includes("locked outside") || t.includes("cant get in")) {
      systemState.service = "lockout";
    }
    if (t.includes("lock change") || t.includes("change lock") || t.includes("replace lock")) {
      systemState.service = "lock_change";
    }
    if (t.includes("key") && t.includes("stuck")) {
      systemState.service = "key_extraction";
    }

    if (t.includes("car") || t.includes("vehicle") || t.includes("truck")) {
      systemState.lockType = "car";
    }
    if (t.includes("home") || t.includes("house") || t.includes("apartment")) {
      systemState.lockType = "home";
    }
    if (t.includes("business") || t.includes("office")) {
      systemState.lockType = "business";
    }

    const addressMatch = text.match(/\b\d+\s+[a-zA-Z]{2,}/);
    if (addressMatch && text.length > 10) {
      systemState.address = text.trim();
    }

    if (t.includes("bonjour") || t.includes("porte") || t.includes("maison")) {
      systemState.language = "french";
    }

    if (/yes|correct|confirm/i.test(t) && systemState.address) {
      systemState.confirmed = true;
    }

    if (systemState.lockType && !systemState.service) {
      systemState.service = "lockout";
    }

    console.log("STATE:", JSON.stringify(systemState));
  }

  function isPriceQuestion(text) {
    const t = text.toLowerCase();
    return t.includes("price") || t.includes("cost") || t.includes("how much");
  }

  function updateSession() {
    if (!openaiReady || openaiWs.readyState !== WebSocket.OPEN) return;

    const msg = JSON.stringify({
      type: "session.update",
      session: {
        instructions: buildPrompt(),
      },
    });

    console.log("Updating session instructions");
    openaiWs.send(msg);
  }

  function tryGreeting() {
    if (!openaiReady || !streamSid || greetingSent) return;
    greetingSent = true;
    console.log("GREETING FIRED");
    openaiWs.send(JSON.stringify({ type: "response.create" }));
  }

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: "Bearer " + process.env.OPENAI_API_KEY,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let sessionTimeout = null;

  openaiWs.on("open", () => {
    console.log("OpenAI WebSocket open, sending session.update");

    const sessionPayload = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: buildPrompt(),
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: {
          model: "gpt-4o-mini-transcribe",
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
      },
    };

    console.log("Session payload keys:", Object.keys(sessionPayload.session));
    openaiWs.send(JSON.stringify(sessionPayload));

    sessionTimeout = setTimeout(() => {
      if (!openaiReady) {
        console.error("TIMEOUT: OpenAI session not ready after 5 seconds");
      }
    }, 5000);
  });

  openaiWs.on("message", (msg) => {
    let response;
    try {
      response = JSON.parse(msg);
    } catch (e) {
      console.error("Failed to parse OpenAI message:", e.message);
      return;
    }

    console.log("OpenAI event:", response.type);

    if (response.type === "session.created" || response.type === "session.updated") {
      openaiReady = true;
      if (sessionTimeout) clearTimeout(sessionTimeout);
      console.log("OpenAI session ready");
      tryGreeting();
    }

    if (response.type === "response.audio.delta") {
      if (!response.delta || !streamSid || ws.readyState !== WebSocket.OPEN) return;

      aiSpeaking = true;
      ws.send(
        JSON.stringify({
          event: "media",
          streamSid: streamSid,
          media: { payload: response.delta },
        })
      );
    }

    if (response.type === "response.audio.done") {
      aiSpeaking = false;
      console.log("AI audio done");
    }

    if (response.type === "response.done") {
      aiSpeaking = false;
      console.log("Response done");
    }

    if (response.type === "conversation.item.input_audio_transcription.completed") {
      const text = response.transcript;
      if (!text || text.length < 2) return;

      console.log("USER:", text);

      detect(text);
      updateSession();

      if (isPriceQuestion(text)) {
        priceStage++;
        console.log("Price question, stage:", priceStage);
        return;
      }
    }

    if (response.type === "input_audio_buffer.speech_started") {
      if (aiSpeaking) {
        console.log("User interrupted, cancelling response");
        openaiWs.send(JSON.stringify({ type: "response.cancel" }));
        aiSpeaking = false;
      }
    }

    if (response.type === "error") {
      console.error("OpenAI error:", response.error);
    }
  });

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(typeof msg === "string" ? msg : msg.toString());
    } catch (e) {
      console.error("Invalid JSON from Twilio:", e.message);
      return;
    }

    if (data.event === "start") {
      streamSid = data.start && data.start.streamSid;
      callSid = data.start && data.start.callSid;
      console.log("Stream started - streamSid:", streamSid);
      tryGreeting();
      return;
    }

    if (data.event === "stop") {
      console.log("Stream stopped");
      return;
    }

    if (data.event === "media") {
      const payload = data.media && data.media.payload;
      if (!payload) return;
      if (!openaiReady || openaiWs.readyState !== WebSocket.OPEN) return;

      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: payload,
        })
      );
    }
  });

  ws.on("close", () => {
    console.log("Twilio WS closed");
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  openaiWs.on("close", () => {
    console.log("OpenAI WS closed");
    openaiReady = false;
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WS error:", err.message);
  });

  ws.on("error", (err) => {
    console.error("Twilio WS error:", err.message);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
