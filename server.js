console.log("APP BOOTED");

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
  let openaiReady = false;
  let greetingSent = false;
  let aiSpeaking = false;

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
    console.log("OpenAI WebSocket open, sending session.update");

    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
      },
    }));

    setTimeout(() => {
      if (!openaiReady) {
        openaiReady = true;
        console.log("OpenAI ready");
      }
    }, 500);
  });

  openaiWs.on("message", (msg) => {
    const response = JSON.parse(msg);

    if (response.type === "session.created" || response.type === "session.updated") {
      openaiReady = true;
      console.log("Session ready");
    }

    if (response.type === "response.audio.delta" && streamSid && ws.readyState === WebSocket.OPEN) {
      aiSpeaking = true;
      ws.send(JSON.stringify({
        event: "media",
        streamSid: streamSid,
        media: { payload: response.delta },
      }));
    }

    if (response.type === "response.done") {
      aiSpeaking = false;
      console.log("Response done");
    }

    if (response.type === "conversation.item.input_audio_transcription.completed") {
      const text = response.transcript;
      if (text && text.length > 2) {
        console.log("USER:", text);
      }
    }
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI error:", err.message);
  });

  openaiWs.on("close", () => {
    console.log("OpenAI closed");
    openaiReady = false;
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(typeof msg === "string" ? msg : msg.toString());
    } catch (e) {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start && data.start.streamSid;
      console.log("Stream started, streamSid:", streamSid);
      
      if (openaiReady && !greetingSent) {
        greetingSent = true;
        console.log("Sending greeting");
        openaiWs.send(JSON.stringify({ type: "response.create" }));
      }
      return;
    }

    if (data.event === "media" && openaiReady && openaiWs.readyState === WebSocket.OPEN) {
      const payload = data.media && data.media.payload;
      if (payload) {
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: payload,
        }));
      }
    }
  });

  ws.on("close", () => {
    console.log("Twilio closed");
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  ws.on("error", (err) => {
    console.error("Twilio error:", err.message);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
