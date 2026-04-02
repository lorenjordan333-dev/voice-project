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
  let hasAudio = false;
  let silenceTimer = null;
  let lastAiEndTime = 0;

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
    else missing.push("service type (lockout, lock change, etc.)");

    if (systemState.lockType) known.push("lock type: " + systemState.lockType);
    else missing.push("lock type (car, home, business)");

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

    const completedStr =
      systemState.service && systemState.address && systemState.confirmed
        ? "All information collected. Confirm the address, then tell the customer a technician is on the way."
        : "Keep the conversation natural. Do not rush. Get the missing info one step at a time.";

    return (
      "You are Kelly, a professional locksmith dispatcher.\n\n" +
      "START:\n" +
      'Always greet with: "Locksmith services, hi, this is Kelly, how can I help?"\n\n' +
      "STYLE:\n" +
      "Be natural, calm, and human.\n" +
      "Speak in short sentences.\n" +
      "Listen more than you talk.\n" +
      "Never interrupt the customer.\n\n" +
      "LANGUAGE:\n" +
      "If the customer speaks French, switch fully to French and stay in French.\n" +
      "If the customer speaks English, stay in English.\n\n" +
      "CURRENT CALL STATE:\n" +
      knownStr +
      "\n" +
      missingStr +
      "\n" +
      completedStr +
      "\n\n" +
      "PRICE (only if asked):\n" +
      "Service call is 45 dollars.\n\n" +
      "TIME (only if asked):\n" +
      "About 20 to 25 minutes.\n\n" +
      "ENDING:\n" +
      "Do not end the conversation unless the customer says goodbye."
    );
  }

  function detect(text) {
    const t = text.toLowerCase();

    if (t.includes("locked out") || t.includes("locked outside") || t.includes("cant get in")) {
      systemState.service = "lockout";
    }
    if (t.includes("lock change") || t.includes("change lock") || t.includes("replace lock") || t.includes("rekey")) {
      systemState.service = "lock_change";
    }
    if (t.includes("key") && t.includes("stuck")) systemState.service = "key_extraction";
    if (t.includes("ignition")) systemState.service = "ignition";

    if (t.includes("car") || t.includes("vehicle") || t.includes("truck") || t.includes("auto")) {
      systemState.lockType = "car";
    }
    if (t.includes("home") || t.includes("house") || t.includes("apartment") || t.includes("condo")) {
      systemState.lockType = "home";
    }
    if (t.includes("office") || t.includes("business") || t.includes("store") || t.includes("shop")) {
      systemState.lockType = "business";
    }

    const addressMatch = text.match(/\b\d+\s+[a-zA-Z]{2,}/);
    if (addressMatch && text.length > 10 && !t.includes("phone") && !t.includes("number")) {
      systemState.address = text.trim();
    }

    if (t.includes("bonjour") || t.includes("aide") || t.includes("porte") || t.includes("maison") || t.includes("voiture")) {
      systemState.language = "french";
    }

    if (/yes|correct|that.?s right|confirm/i.test(t) && systemState.address) {
      systemState.confirmed = true;
    }

    if (systemState.lockType && !systemState.service) {
      systemState.service = "lockout";
    }

    console.log("STATE:", JSON.stringify(systemState));
  }

  function isPriceQuestion(text) {
    const t = text.toLowerCase();
    return t.includes("price") || t.includes("cost") || t.includes("how much") || t.includes("average");
  }

  function detectConfusion(text) {
    if (text === lastUserText) {
      repeatCount++;
    } else {
      repeatCount = 0;
    }
    lastUserText = text;
    if (repeatCount >= 1) return true;
    if (text.length < 3) return true;
    return false;
  }

  function updateSession() {
    if (!openaiReady || openaiWs.readyState !== WebSocket.OPEN) return;
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: buildPrompt(),
        },
      })
    );
    console.log("Session updated with new state");
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

  openaiWs.on("open", () => {
    console.log("OpenAI WebSocket open");

    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          instructions: buildPrompt(),
          voice: "verse",
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
      })
    );
  });

  openaiWs.on("message", (msg) => {
    let response;
    try {
      response = JSON.parse(msg);
    } catch (e) {
      return;
    }

    if (response.type === "session.created" || response.type === "session.updated") {
      openaiReady = true;
      console.log("OpenAI session ready");
      tryGreeting();
    }

    if (response.type === "response.audio.delta") {
      const payload = response.delta;
      if (!payload || !streamSid || ws.readyState !== WebSocket.OPEN) return;

      aiSpeaking = true;
      ws.send(
        JSON.stringify({
          event: "media",
          streamSid: streamSid,
          media: { payload: payload },
        })
      );
    }

    if (response.type === "response.audio.done") {
      aiSpeaking = false;
      lastAiEndTime = Date.now();
      console.log("AI audio done");
    }

    if (response.type === "response.done") {
      aiSpeaking = false;
      lastAiEndTime = Date.now();
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
        let reply = "";
        if (priceStage === 1) {
          reply = "There is a 45 dollar service call, and the technician will confirm the exact price on site.";
        } else {
          reply = "It is a 45 dollar service call, and the job usually starts from 45 depending on the situation.";
        }

        openaiWs.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: text }],
            },
          })
        );

        openaiWs.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: reply }],
            },
          })
        );

        openaiWs.send(JSON.stringify({ type: "response.create" }));
        return;
      }

      if (detectConfusion(text)) {
        openaiWs.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: text }],
            },
          })
        );
        openaiWs.send(JSON.stringify({ type: "response.create" }));
        return;
      }
    }

    if (response.type === "input_audio_buffer.speech_started") {
      if (aiSpeaking) {
        openaiWs.send(JSON.stringify({ type: "response.cancel" }));
        aiSpeaking = false;
        console.log("User interrupted, cancelled AI response");
      }
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
      if (silenceTimer) clearTimeout(silenceTimer);
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
    if (silenceTimer) clearTimeout(silenceTimer);
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
