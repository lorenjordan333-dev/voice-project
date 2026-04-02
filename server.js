const express = require("express");
const WebSocket = require("ws");
require("dotenv").config();

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get("/voice", (req, res) => {
  res.send("OK");
});

// 🔊 TWILIO ENTRY
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

// 🔌 SERVER
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("📞 Twilio connected");

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
  let audioQueue = [];
  let openaiReady = false;
  let silenceTimer = null;
  let aiSpeaking = false;

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
Final price is confirmed on site.

TIME:
Only if the customer asks:
About 20 to 25 minutes.

ENDING:
Do not end the conversation unless the customer says goodbye.`,

        voice: "marin",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
      },
    }));

    audioQueue.forEach((chunk) => {
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: chunk,
      }));
    });
    audioQueue = [];

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

      if (aiSpeaking && data.media.payload && data.media.payload.length > 500) {
        openaiWs.send(JSON.stringify({
          type: "response.cancel"
        }));
        aiSpeaking = false;
      }

      if (!openaiReady) {
        audioQueue.push(data.media.payload);
        return;
      }

      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: data.media.payload,
      }));

      if (silenceTimer) clearTimeout(silenceTimer);

      silenceTimer = setTimeout(() => {
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.commit"
        }));

        openaiWs.send(JSON.stringify({
          type: "response.create"
        }));
      }, 1000);
    }
  });

  openaiWs.on("message", (msg) => {
    const response = JSON.parse(msg);

    if (response.type === "response.audio.delta") {
      aiSpeaking = true;

      ws.send(JSON.stringify({
        event: "media",
        streamSid: streamSid,
        media: {
          payload: response.delta,
        },
      }));
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio disconnected");
    openaiWs.close();
  });

  openaiWs.on("close", () => {
    console.log("❌ OpenAI disconnected");
    ws.close();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});
