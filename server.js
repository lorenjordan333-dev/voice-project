const express = require("express");

// --- Production-Grade Voice Assistant Components ---

// StateManager: controls exact assistant state and enforces non-overlapping behavior
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

// ConversationManager: tracks slots: service, address, and if user confirmed
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

// ResponseController: validates timing, data, and confirmation before sending any AI response
class ResponseController {
  constructor(stateManager, conversationManager) {
    this.stateManager = stateManager;
    this.conversationManager = conversationManager;
    this.lastResponseText = "";
    this.lastSentTime = 0;
  }
  validate(response) {
    // Don't allow AI to speak if user hasn't finished talking
    if (!this.stateManager.is("THINKING")) return false;
    const now = Date.now();

    // Prevent duplicate or too-fast consecutive responses
    if (response && response === this.lastResponseText) return false;
    if (now - this.lastSentTime < 1200) return false;

    // Block response if required data missing or confirmation missing
    if (this.conversationManager.needsConfirmation()) {
      if (!response.includes(this.conversationManager.address)) return false;
    }
    if (!this.conversationManager.service && response.toLowerCase().includes("dispatch")) return false;

    // Don't allow dispatch before confirmation
    if (response.toLowerCase().includes("technician") && !this.conversationManager.confirmed) {
      return false;
    }
    return true;
  }
  markSent(responseText) {
    this.lastResponseText = responseText || "";
    this.lastSentTime = Date.now();
  }
}

// VoiceController (entry point for Twilio hooks, WebSocket connections, and core turn-taking logic)
class VoiceController {
  constructor() {
    this.stateManager = new StateManager();
    this.conversationManager = new ConversationManager();
    this.responseController = new ResponseController(this.stateManager, this.conversationManager);
    this.currentlySpeaking = false;
    this.speechTimeout = null;
  }

  // Called when user starts/stops speaking
  onUserAudioStart() {
    this.stateManager.setState("LISTENING");
    this.stopAISpeech();
  }
  onUserAudioEnd() {
    // Wait a natural pause (300–700ms) before AI begins response
    this.stateManager.setState("THINKING");
    if (this.speechTimeout) clearTimeout(this.speechTimeout);
    this.speechTimeout = setTimeout(() => {
      this.tryAISpeak();
    }, 300 + Math.floor(Math.random() * 401));
  }

  receiveUserText(text) {
    // Extract info/intent from user text (dummy slot filling; swap with NLU if needed)
    const serviceMatch = /(lock|unlock|lost key|door|garage)/i.exec(text);
    if (serviceMatch) this.conversationManager.update({ service: serviceMatch[0] });

    const addressMatch = /(\d{1,5}\s\w+(\s\w+){1,5})/i.exec(text);
    if (addressMatch) {
      this.conversationManager.update({ address: addressMatch[0] });
    }

    if (/yes|correct|that.?s right|confirm/i.test(text) && this.conversationManager.address) {
      this.conversationManager.update({ confirmed: true });
    }

    // User interruptions immediately stop AI
    this.onUserAudioStart();
  }

  // Core AI speech logic: only after user has finished, and all checks pass
  tryAISpeak() {
    if (this.stateManager.is("THINKING") && !this.currentlySpeaking) {
      let response = this.generateResponse();
      if (this.responseController.validate(response)) {
        this.stateManager.setState("SPEAKING");
        this.currentlySpeaking = true;
        this.speak(response);
      } else {
        // Remain in THINKING or revert to LISTENING if not ready to speak
        this.stateManager.setState("LISTENING");
        this.currentlySpeaking = false;
      }
    }
  }

  // Response generation: orchestrated to enforce strict flow
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

  // Simulate AI speech; this would be where TTS/Play is triggered in real use
  speak(response) {
    // Simulate smooth speech and allow interruption
    // In production, hook into Twilio <Play> or similar, ensuring you can .stop() if user talks
    // This is a placeholder: on real system, signal "start speaking", "end speaking"
    setTimeout(() => {
      this.currentlySpeaking = false;
      this.stateManager.setState("LISTENING");
    }, this.approximateSpeechDuration(response));
  }

  // Should be called if user interrupts the AI speech
  stopAISpeech() {
    // In production, this should cut off Twilio <Play> or media stream
    this.currentlySpeaking = false;
    this.stateManager.setState("LISTENING");
  }

  approximateSpeechDuration(text) {
    // Estimate speech time (ms) based on ~120wpm
    const words = (text.match(/\w+/g) || []).length;
    return Math.max(900, words * 500);
  }
}

module.exports = {
  StateManager,
  ConversationManager,
  ResponseController,
  VoiceController,
};
const WebSocket = require("ws");
require("dotenv").config();
const http = require("http");

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get("/voice", (req, res) => {
  res.send("OK");
});

app.post("/voice", (req, res) => {
  console.log("🔥 TWILIO HIT /voice");
  res.set("Content-Type", "text/xml");

  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://voice-project-production-8fea.up.railway.app" />
      </Connect>
    </Response>
  `);
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
    return t.includes("price") || t.includes("cost") || t.includes("how much");
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

  let streamSid = null;
  let aiSpeaking = false;
  let hasAudio = false;
  let silenceTimer = null;
  let lastAiEndTime = 0;
  let lastAiText = "";
  let pendingAssistantTimeout = null;
  let aiResponseInFlight = false;
  const voiceController = new VoiceController();

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

      // Strict technician guard before any dispatch wording is sent
      if (
        /technician/i.test(nextText) &&
        (!voiceController.conversationManager.address || !voiceController.conversationManager.confirmed)
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

      // Move to SPEAKING only when sending the response
      voiceController.stateManager.setState("SPEAKING");
      voiceController.currentlySpeaking = true;
      aiResponseInFlight = true;
      voiceController.responseController.markSent(nextText);

      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions: nextText
        }
      }));
    }, delayMs);
  }

  openaiWs.on("open", () => {
    console.log("🤖 OpenAI connected");

    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: `You are Kelly, a professional locksmith dispatcher.

START:
Always say:
"Locksmith services, hi, this is Kelly, how can I help?"

STYLE:
Be natural, calm, and human.
Speak in short sentences.
Listen more than you talk.

BEHAVIOR:
- Always wait for the customer to finish speaking.
- Do not interrupt.
- Do not rush.
- If the customer is silent, wait.

FLOW:
Understand what the customer needs.
Ask simple questions if something is unclear.

Do not assume.
Do not jump ahead.

Once you understand:
Ask for the address.
Wait for the full address.
Repeat it clearly and confirm.

After confirmation:
Say:
"I'm going to send a technician, he will be there shortly."

FLEXIBILITY:
If the customer changes their mind or corrects you, adapt naturally and continue.

PRICE LOGIC:
Stage 1:
Do NOT give any price.
Say the technician will give price on site.

Stage 2:
Say service call is 45 dollars.

Stage 3:
Say service call is 45 and job starts at 45.

Never invent numbers.
Never give ranges.

TIME:
Only if the customer asks:
About 20 to 25 minutes.

ENDING:
Do not end the conversation unless the customer says goodbye.`,

        modalities: ["text", "audio"],
        voice: "marin",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: {
          model: "gpt-4o-mini-transcribe"
        }
      },
    }));

    voiceController.stateManager.setState("THINKING");
    scheduleAssistantResponse("Locksmith services, hi, this is Kelly, how can I help?");
  });

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      streamSid = data.start.streamSid;
    }

    if (data.event === "media") {
      const payload = data.media.payload;

      if (!payload) return;

      if (payload.length > 200) {
        hasAudio = true;
      }

      if (openaiWs.readyState !== WebSocket.OPEN) return;

      if (aiSpeaking && payload.length > 500) {
        openaiWs.send(JSON.stringify({ type: "response.cancel" }));
        aiSpeaking = false;
        aiResponseInFlight = false;
        if (pendingAssistantTimeout) clearTimeout(pendingAssistantTimeout);
        voiceController.stopAISpeech();
      }

      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: payload,
      }));

      if (silenceTimer) clearTimeout(silenceTimer);

      silenceTimer = setTimeout(() => {
        if (!hasAudio) return;
        if (Date.now() - lastAiEndTime < 800) return;

        if (openaiWs.readyState !== WebSocket.OPEN) return;

        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.commit"
        }));

        voiceController.stateManager.setState("THINKING");
        scheduleAssistantResponse();

        hasAudio = false;
      }, 400); // ⚡ faster
    }
  });

  openaiWs.on("message", (msg) => {
    const response = JSON.parse(msg);

    if (response.type === "response.audio.delta") {
      aiSpeaking = true;

      ws.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: response.delta },
      }));
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

      if (text && text.length > 2) {
        console.log("🗣️ USER:", text);
        detect(text);
        voiceController.receiveUserText(text);
        voiceController.stateManager.setState("THINKING");

        // 🔥 BRAIN CONTROL FIRST
        openaiWs.send(JSON.stringify({ type: "response.cancel" }));
        aiResponseInFlight = false;
        if (pendingAssistantTimeout) clearTimeout(pendingAssistantTimeout);

        // PRICE CONTROL
        if (isPriceQuestion(text)) {
          priceStage++;

          let reply = "";

          if (priceStage === 1) {
            reply = "The technician will give you the exact price on site depending on the lock.";
          } else if (priceStage === 2) {
            reply = "There is a 45 dollar service call, and the technician will confirm the price on site depending on the lock.";
          } else {
            reply = "It is a 45 dollar service call, and the job usually starts from 45 depending on the situation.";
          }

          scheduleAssistantResponse(reply);

          return;
        }

        // CONFUSION RECOVERY
        if (detectConfusion(text)) {
          scheduleAssistantResponse("No worries, let me make that clear for you. What exactly do you need help with?");
          return;
        }

        // NORMAL FLOW
        scheduleAssistantResponse();
      }
    }
  });

  ws.on("close", () => {
    openaiWs.close();
  });

  openaiWs.on("close", () => {
    ws.close();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});