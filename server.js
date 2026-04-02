const express = require("express");
const WebSocket = require("ws");
require("dotenv").config();

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get("/voice", (req, res) => {
  res.send("OK");
});

app.post("/voice", (req, res) => {
  res.set("Content-Type", "text/xml");

  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host}/stream" />
      </Connect>
    </Response>
  `);
});

const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("📞 Twilio connected");

  let systemState = {
    service: null,
    lockType: null,
    address: null,
  };

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
  let openaiReady = false;
  let silenceTimer = null;
  let aiSpeaking = false;
  let hasAudio = false;
  let lastAiEndTime = 0;

  openaiWs.on("open", () => {
    console.log("🤖 OpenAI connected");

    openaiReady = true;

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

PRICE:
Only if the customer asks:
Service call is 45 dollars.

TIME:
Only if the customer asks:
About 20 to 25 minutes.

ENDING:
Do not end the conversation unless the customer says goodbye.`,

        voice: "marin",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",

        input_audio_transcription: {
          model: "gpt-4o-mini-transcribe"
        }
      },
    }));

    openaiWs.send(JSON.stringify({
      type: "response.create",
    }));
  });

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      streamSid = data.start.streamSid;
    }

    if (data.event === "media") {

      const payload = data.media.payload;

      if (payload && payload.length > 200) {
        hasAudio = true;
      }

      if (aiSpeaking && payload && payload.length > 500) {
        openaiWs.send(JSON.stringify({
          type: "response.cancel"
        }));
        aiSpeaking = false;
      }

      if (!openaiReady) return;

      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: payload,
      }));

      if (silenceTimer) clearTimeout(silenceTimer);

      silenceTimer = setTimeout(() => {

        if (!hasAudio) return;

        // 🔥 prevent loop after AI just spoke
        if (Date.now() - lastAiEndTime < 1500) return;

        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.commit"
        }));

        openaiWs.send(JSON.stringify({
          type: "response.create"
        }));

        hasAudio = false;

      }, 1000);
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

    if (response.type === "response.completed") {
      aiSpeaking = false;
      lastAiEndTime = Date.now(); // 🔥 key fix
    }

    if (response.type === "conversation.item.input_audio_transcription.completed") {
      const text = response.transcript;

      if (text && text.length > 2) {
        console.log("🗣️ USER:", text);
        detect(text);
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
