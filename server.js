console.log("APP BOOTED");
console.log("NODE VERSION:", process.version);

const express = require("express");
const WebSocket = require("ws");
require("dotenv").config();
const http = require("http");

// --- Production-Grade Voice Assistant Components ---

class StateManager {
  constructor() {
    this.state = "LISTENING"; // LISTENING, THINKING, SPEAKING
    this.lastStateChange = Date.now();
  }

  setState(newState) {
    if (["LISTENING", "THINKING", "SPEAKING"].includes(newState)) {
      this.state = newState;
      this.lastStateChange = Date.now();
    }
  }

  is(state) {
    return this.state === state;
  }

  reset() {
    this.setState("LISTENING");
  }
}

class ConversationManager {
  constructor() {
    this.reset();
  }

  reset() {
    this.service = null;
    this.address = null;
    this.confirmed = false;
  }

  update({ service, address, confirmed }) {
    if (service !== undefined) this.service = service;
    if (address !== undefined) this.address = address;
    if (confirmed !== undefined) this.confirmed = confirmed;
  }

  isComplete() {
    return !!this.service && !!this.address && this.confirmed;
  }

  needsConfirmation() {
    return !!this.address && !this.confirmed;
  }
}

class ResponseController {
  constructor(stateManager, conversationManager) {
    this.stateManager = stateManager;
    this.conversationManager = conversationManager;
    this.lastResponseText = "";
    this.lastSentTime = 0;
  }

  validate(response) {
    if (!this.stateManager.is("THINKING")) return false;

    const now = Date.now();

    if (response && response === this.lastResponseText) return false;
    if (now - this.lastSentTime < 1200) return false;

    if (this.conversationManager.needsConfirmation()) {
      if (!response.includes(this.conversationManager.address)) return false;
    }

    if (
      !this.conversationManager.service &&
      response.toLowerCase().includes("dispatch")
    ) {
      return false;
    }

    if (
      response.toLowerCase().includes("technician") &&
      !this.conversationManager.confirmed
    ) {
      return false;
    }

    return true;
  }

  markSent(responseText) {
    this.lastResponseText = responseText || "";
    this.lastSentTime = Date.now();
  }
}

class VoiceController {
  constructor() {
    this.stateManager = new StateManager();
    this.conversationManager = new ConversationManager();
    this.responseController = new ResponseController(
      this.stateManager,
      this.conversationManager
    );
    this.currentlySpeaking = false;
    this.speechTimeout = null;
  }

  onUserAudioStart() {
    this.stateManager.setState("LISTENING");
    this.stopAISpeech();
  }

  onUserAudioEnd() {
    this.stateManager.setState("THINKING");

    if (this.speechTimeout) clearTimeout(this.speechTimeout);

    this.speechTimeout = setTimeout(() => {
      this.tryAISpeak();
    }, 300 + Math.floor(Math.random() * 401));
  }

  receiveUserText(text) {
    const serviceMatch = /(lock|unlock|lost key|door|garage)/i.exec(text);
    if (serviceMatch) {
      this.conversationManager.update({ service: serviceMatch[0] });
    }

    const addressMatch = /(\d{1,5}\s\w+(\s\w+){1,5})/i.exec(text);
    if (addressMatch) {
      this.conversationManager.update({ address: addressMatch[0] });
    }

    if (
      /yes|correct|that.?s right|confirm/i.test(text) &&
      this.conversationManager.address
    ) {
      this.conversationManager.update({ confirmed: true });
    }

    this.onUserAudioStart();
  }

  tryAISpeak() {
    if (this.stateManager.is("THINKING") && !this.currentlySpeaking) {
      const response = this.generateResponse();

      if (this.responseController.validate(response)) {
        this.stateManager.setState("SPEAKING");
        this.currentlySpeaking = true;
        this.speak(response);
      } else {
        this.stateManager.setState("LISTENING");
        this.currentlySpeaking = false;
      }
    }
  }

  generateResponse() {
    const c = this.conversationManager;

    if (!c.service) {
      return "Thank you for calling. What kind of lock or service do you need?";
    } else if (!c.address) {
      return `Sure, I can help with your ${c.service}. Can you tell me the address, please?`;
    } else if (!c.confirmed) {
      return `Just to confirm, is the address ${c.address}?`;
    } else {
      return `Thank you. A technician will be dispatched to ${c.address} for your ${c.service}. Is there anything else I can help you with?`;
    }
  }

  speak(response) {
    setTimeout(() => {
      this.currentlySpeaking = false;
      this.stateManager.setState("LISTENING");
    }, this.approximateSpeechDuration(response));
  }

  stopAISpeech() {
    this.currentlySpeaking = false;
    this.stateManager.setState("LISTENING");
  }

  approximateSpeechDuration(text) {
    const words = (text.match(/\w+/g) || []).length;
    return Math.max(900, words * 500);
  }
}

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get("/voice", (req, res) => {
  res.send("OK");
});

// IMPORTANT: stream the call, do NOT use <Say> here
app.post("/voice", (req, res) => {
  console.log("VOICE HIT");

  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host ||
    "voice-project-production-3574.up.railway.app";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/stream" />
  </Connect>
</Response>`;

  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/stream" });

wss.on("connection", (ws) => {
  console.log("📞 Twilio connected");

  let systemState = {
    service: null,
    lockType: null,
    address: null,
  };

  let priceStage = 0;
  let lastUserText = "";
  let repeatCount = 0;

  function isPriceQuestion(text) {
    const t = text.toLowerCase();
    return (
      t.includes("price") ||
      t.includes("cost") ||
      t.includes("how much") ||
      t.includes("average")
    );
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

  function detect(text) {
    const t = text.toLowerCase();

    if (t.includes("locked out")) systemState.service = "lockout";

    if (
      t.includes("lock change") ||
      t.includes("change lock") ||
      t.includes("replace lock")
    ) {
      systemState.service = "lock_change";
    }

    if (t.includes("car")) systemState.lockType = "car";
    if (t.includes("home") || t.includes("house")) systemState.lockType = "home";
    if (t.includes("business")) systemState.lockType = "business";

    if (t.match(/\d+/) && t.length > 8) {
      systemState.address = text;
    }

    console.log("🧠 STATE:", systemState);
  }

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let openaiReady = false;
  let greetingSent = false;
  let audioBuffer = [];
  let outboundAudioDeltas = [];
  let streamSid = null;
  let aiSpeaking = false;
  let hasAudio = false;
  let silenceTimer = null;
  let lastAiEndTime = 0;
  let lastAiText = "";
  let pendingAssistantTimeout = null;
  let aiResponseInFlight = false;

  const voiceController = new VoiceController();

  function sendImmediateAssistantResponse(nextText) {
    if (openaiWs.readyState !== WebSocket.OPEN) return;
    if (pendingAssistantTimeout) clearTimeout(pendingAssistantTimeout);

    voiceController.stateManager.setState("SPEAKING");
    voiceController.currentlySpeaking = true;
    aiResponseInFlight = true;
    voiceController.responseController.markSent(nextText);

    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions: nextText,
        },
      })
    );
  }

  function tryStartGreeting() {
    if (!openaiReady || !streamSid || greetingSent) return;

    greetingSent = true;
    console.log("🔥 GREETING FIRED");

    sendImmediateAssistantResponse(
      "Locksmith services, hi, this is Kelly, how can I help?"
    );
  }

  function scheduleAssistantResponse(forcedText) {
    if (pendingAssistantTimeout) clearTimeout(pendingAssistantTimeout);
    if (!voiceController.stateManager.is("THINKING")) return;
    if (voiceController.currentlySpeaking || aiResponseInFlight) return;

    const delayMs = 300 + Math.floor(Math.random() * 401);

    pendingAssistantTimeout = setTimeout(() => {
      if (!voiceController.stateManager.is("THINKING")) return;
      if (voiceController.currentlySpeaking || aiResponseInFlight) return;
      if (openaiWs.readyState !== WebSocket.OPEN) return;

      let nextText = forcedText || voiceController.generateResponse();

      if (
        /technician/i.test(nextText) &&
        (!voiceController.conversationManager.address ||
          !voiceController.conversationManager.confirmed)
      ) {
        nextText = voiceController.conversationManager.address
          ? `Just to confirm, is the address ${voiceController.conversationManager.address}?`
          : "Before I send a technician, can I have the full address please?";
      }

      if (!voiceController.responseController.validate(nextText)) {
        voiceController.stateManager.setState("LISTENING");
        voiceController.currentlySpeaking = false;
        return;
      }

      voiceController.stateManager.setState("SPEAKING");
      voiceController.currentlySpeaking = true;
      aiResponseInFlight = true;
      voiceController.responseController.markSent(nextText);

      openaiWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio"],
            instructions: nextText,
          },
        })
      );
    }, delayMs);
  }

  openaiWs.on("open", () => {
    console.log("🤖 OpenAI connected");

    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio"],
          instructions:
            "You are Kelly, a professional locksmith dispatcher. Be calm, short, natural, and wait for the caller to finish. Never interrupt. Ask one simple question at a time. Only send a technician after the address is confirmed. If the user asks about price, answer clearly and briefly without inventing prices.",
          voice: "verse",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: {
            model: "gpt-4o-mini-transcribe",
          },
        },
      })
    );
  });

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(typeof msg === "string" ? msg : msg.toString());
    } catch (e) {
      console.error("Twilio WS: invalid JSON message", e.message);
      return;
    }

    const event = data.event;

    if (event === "start") {
      console.log("Stream started");

      if (data.start && data.start.streamSid) {
        streamSid = data.start.streamSid;

        if (outboundAudioDeltas.length) {
          for (const payload of outboundAudioDeltas) {
            ws.send(
              JSON.stringify({
                event: "media",
                streamSid,
                media: { payload },
              })
            );
          }
          outboundAudioDeltas = [];
        }
      }

      tryStartGreeting();
      return;
    }

    if (event === "stop") {
      console.log("Stream stopped");

      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = null;
      return;
    }

    if (event === "media") {
      const payload = data.media && data.media.payload;
      if (!payload) return;

      if (!openaiReady) {
        audioBuffer.push(payload);
        return;
      }

      if (openaiWs.readyState !== WebSocket.OPEN) return;

      if (payload.length > 200) {
        hasAudio = true;
      }

      if (aiSpeaking && payload.length > 500) {
        openaiWs.send(JSON.stringify({ type: "response.cancel" }));
        aiSpeaking = false;
        aiResponseInFlight = false;

        if (pendingAssistantTimeout) clearTimeout(pendingAssistantTimeout);
        voiceController.stopAISpeech();
      }

      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: payload,
        })
      );

      if (silenceTimer) clearTimeout(silenceTimer);

      silenceTimer = setTimeout(() => {
        if (!hasAudio) return;
        if (Date.now() - lastAiEndTime < 800) return;
        if (!openaiReady || openaiWs.readyState !== WebSocket.OPEN) return;

        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.commit",
          })
        );

        voiceController.stateManager.setState("THINKING");
        hasAudio = false;
      }, 400);
    }
  });

  openaiWs.on("message", (msg) => {
    const response = JSON.parse(msg);

    if (response.type === "session.created") {
      openaiReady = true;
      console.log("✅ OpenAI session created");

      if (audioBuffer.length) {
        for (const payload of audioBuffer) {
          openaiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: payload,
            })
          );
        }
        audioBuffer = [];
      }

      tryStartGreeting();
    }

    if (response.type === "response.audio.delta") {
      aiSpeaking = true;

      const payload = response.delta;
      if (!payload) return;

      if (!streamSid) {
        outboundAudioDeltas.push(payload);
        return;
      }

      ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: {
            payload,
          },
        })
      );
    }

    if (response.type === "response.output_text.delta") {
      lastAiText += response.delta;
    }

    if (response.type === "response.completed") {
      lastAiText = "";
      aiSpeaking = false;
      lastAiEndTime = Date.now();
      aiResponseInFlight = false;
      voiceController.currentlySpeaking = false;
      voiceController.stateManager.setState("LISTENING");
    }

    if (response.type === "conversation.item.input_audio_transcription.completed") {
      const text = response.transcript;

      if (text && text.length > 1) {
        console.log("🗣️ USER:", text);

        detect(text);
        voiceController.receiveUserText(text);
        voiceController.stateManager.setState("THINKING");

        openaiWs.send(JSON.stringify({ type: "response.cancel" }));
        aiResponseInFlight = false;

        if (pendingAssistantTimeout) clearTimeout(pendingAssistantTimeout);

        if (isPriceQuestion(text)) {
          priceStage++;

          let reply = "";

          if (priceStage === 1) {
            reply =
              "The technician will give you the exact price on site depending on the lock.";
          } else if (priceStage === 2) {
            reply =
              "There is a 45 dollar service call, and the technician will confirm the exact price on site depending on the lock.";
          } else {
            reply =
              "It is a 45 dollar service call, and the job usually starts from 45 depending on the situation.";
          }

          scheduleAssistantResponse(reply);
          return;
        }

        if (detectConfusion(text)) {
          scheduleAssistantResponse(
            "No worries, let me make that clear for you. What exactly do you need help with?"
          );
          return;
        }

        scheduleAssistantResponse();
      }
    }
  });

  ws.on("close", () => {
    console.log("Twilio WS closed");
    if (pendingAssistantTimeout) clearTimeout(pendingAssistantTimeout);
    if (silenceTimer) clearTimeout(silenceTimer);

    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  openaiWs.on("close", () => {
    console.log("OpenAI WS closed");
    openaiReady = false;

    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
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
  console.log("🚀 Server running on port " + PORT);
});
