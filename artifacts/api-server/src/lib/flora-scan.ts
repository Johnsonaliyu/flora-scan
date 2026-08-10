import {
  downloadContentFromMessage,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger";

const AUTH_DIR = path.resolve(process.env.WHATSAPP_AUTH_DIR ?? ".data/whatsapp-auth");
const GREETING = `🌿 Good day, Johnson!

I am Flora Scan, your smart plant assistant built by Aliu Johnson Temitope, a fellow of the 3MTT Airtel NextGen Program with fellow ID FE/23/24184818.

Whether you are a farmer in the field, a student, or just curious about the world of plants and soil — I am here to help you make better decisions about your crops and land.

Here is what I can do for you:

📸 Identify any plant — cassava, yam, maize, tomato, and many more
🌱 Common & scientific names — including local Nigerian names where available
🏷️ Plant family & confidence score — with other possible matches
📖 Detailed plant profile — habitat, uses, and growing tips for Nigerian conditions
🔬 Disease identification — send a photo of the affected plant
🌾 Agronomy & crop management — fertilisation, irrigation, pest control, crop rotation, yield tips
🍅 Horticulture — fruit, vegetable & ornamental crops, pruning, grafting, post-harvest handling
🪱 Soil science & management — soil types, pH, nutrients, composting, erosion control, land prep
❓ Ask any question — just type it and I will answer

Send me a photo of any plant, or type your question to get started!`;

type Provider = "groq" | "nvidia";

type PlantNetResult = {
  score?: number;
  species?: {
    scientificNameWithoutAuthor?: string;
    scientificNameAuthorship?: string;
    commonNames?: string[];
    family?: { scientificNameWithoutAuthor?: string };
    genus?: { scientificNameWithoutAuthor?: string };
  };
};

type PlantNetResponse = {
  bestMatch?: string;
  results?: PlantNetResult[];
};

type BotStatus = {
  state: "starting" | "qr" | "open" | "closed" | "error";
  phone: string | null;
  qr: string | null;
  lastError: string | null;
  startedAt: string;
};

const status: BotStatus = {
  state: "starting",
  phone: null,
  qr: null,
  lastError: null,
  startedAt: new Date().toISOString(),
};

let socket: WASocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let startPromise: Promise<void> | null = null;

function isGreeting(text: string): boolean {
  return /^(hi|hello|hey)[!.,\s]*$/i.test(text.trim());
}

function getText(message: WAMessage): string {
  const content = message.message;
  if (!content) return "";
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    ""
  ).trim();
}

function getImageMessage(message: WAMessage) {
  const content = message.message;
  if (!content) return null;
  if (content.imageMessage) return content.imageMessage;
  if (content.viewOnceMessage?.message?.imageMessage) {
    return content.viewOnceMessage.message.imageMessage;
  }
  if (content.viewOnceMessageV2?.message?.imageMessage) {
    return content.viewOnceMessageV2.message.imageMessage;
  }
  return null;
}

async function readImage(message: WAMessage): Promise<Buffer | null> {
  const image = getImageMessage(message);
  if (!image) return null;
  const stream = await downloadContentFromMessage(image, "image");
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function formatPlantNet(result: PlantNetResponse): string {
  const top = result.results?.slice(0, 3) ?? [];
  if (!top.length) return "PlantNet could not find a confident match.";
  return top
    .map((item, index) => {
      const species = item.species;
      const scientific = species?.scientificNameWithoutAuthor ?? "Unknown species";
      const common = species?.commonNames?.slice(0, 3).join(", ");
      const family = species?.family?.scientificNameWithoutAuthor;
      const score =
        typeof item.score === "number" ? `${Math.round(item.score * 100)}%` : "unknown";
      return `${index + 1}. ${common ? `${common} — ` : ""}${scientific}${family ? ` (family: ${family})` : ""} — confidence ${score}`;
    })
    .join("\n");
}

async function identifyPlant(image: Buffer, mimetype = "image/jpeg"): Promise<string> {
  const key = process.env.PLANTNET_API_KEY;
  if (!key) return "PlantNet is not configured yet.";
  const form = new FormData();
  const imageBytes = new Uint8Array(image.byteLength);
  imageBytes.set(image);
  form.append("images", new Blob([imageBytes], { type: mimetype }), "plant.jpg");
  form.append("organs", "auto");
  const response = await fetch(
    `https://my-api.plantnet.org/v2/identify/all?api-key=${encodeURIComponent(key)}`,
    { method: "POST", body: form },
  );
  if (!response.ok) {
    throw new Error(`PlantNet returned HTTP ${response.status}`);
  }
  return formatPlantNet((await response.json()) as PlantNetResponse);
}

function providerUrl(provider: Provider): string {
  return provider === "groq"
    ? "https://api.groq.com/openai/v1/chat/completions"
    : "https://integrate.api.nvidia.com/v1/chat/completions";
}

function providerKey(provider: Provider): string | undefined {
  return provider === "groq" ? process.env.GROQ_API_KEY : process.env.NVIDIA_API_KEY;
}

function providerModel(provider: Provider, vision: boolean): string {
  if (provider === "groq") {
    return vision
      ? process.env.GROQ_VISION_MODEL ?? "meta-llama/llama-4-scout-17b-16e-instruct"
      : process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
  }
  return vision
    ? process.env.NVIDIA_VISION_MODEL ?? "meta/llama-3.2-11b-vision-instruct"
    : process.env.NVIDIA_MODEL ?? "meta/llama-3.1-70b-instruct";
}

async function askProvider(
  provider: Provider,
  question: string,
  plantContext?: string,
  image?: Buffer,
): Promise<string> {
  const key = providerKey(provider);
  if (!key) throw new Error(`${provider} API key is not configured`);
  const system = `You are Flora Scan, a careful Nigerian plant and land assistant.
Answer questions about agronomy, crop science, forestry, soil science, soil management,
horticulture, plant health, and related plant-based fields. Give practical, safe,
evidence-informed advice for Nigerian conditions when relevant. Never claim a diagnosis
or species identification is certain from limited evidence. Ask one useful follow-up
question when important context is missing. Keep WhatsApp replies readable with short
headings and bullets. Do not use markdown tables.`;
  const userText = plantContext
    ? `${question || "Please analyse this plant photo."}\n\nPlantNet results:\n${plantContext}`
    : question;
  const userContent = image
    ? [
        { type: "text", text: userText },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${image.toString("base64")}` },
        },
      ]
    : userText;
  const response = await fetch(providerUrl(provider), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: providerModel(provider, Boolean(image)),
      temperature: 0.2,
      max_tokens: 900,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`${provider} returned HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const answer = data.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error(`${provider} returned an empty answer`);
  return answer;
}

async function answer(question: string, plantContext?: string, image?: Buffer): Promise<string> {
  const errors: string[] = [];
  for (const provider of ["groq", "nvidia"] as const) {
    try {
      return await askProvider(provider, question, plantContext, image);
    } catch (error) {
      errors.push(`${provider}: ${error instanceof Error ? error.message : "request failed"}`);
      logger.warn({ provider }, "AI provider failed; trying fallback");
    }
  }
  return `I’m unable to reach my plant knowledge services right now. Please try again shortly.\n\nReference: ${errors.join(" | ")}`;
}

async function sendText(jid: string, text: string): Promise<void> {
  if (!socket) return;
  await socket.sendMessage(jid, { text });
}

async function handleMessage(message: WAMessage): Promise<void> {
  const jid = message.key.remoteJid;
  if (!jid || message.key.fromMe || jid === "status@broadcast") return;
  const text = getText(message);
  if (isGreeting(text)) {
    await sendText(jid, GREETING);
    return;
  }
  const image = getImageMessage(message);
  if (image) {
    await sendText(jid, "🌿 I’m examining your plant photo. I’ll compare it with PlantNet and assess visible health clues—this may take a moment.");
    try {
      const bytes = await readImage(message);
      if (!bytes) throw new Error("image could not be downloaded");
      const plantContext = await identifyPlant(bytes, image.mimetype ?? "image/jpeg");
      await sendText(jid, await answer(text || "Identify this plant and check for visible diseases or stress.", plantContext, bytes));
    } catch (error) {
      logger.error({ err: error }, "Photo analysis failed");
      await sendText(jid, "I couldn’t analyse that photo. Please send a clear image of the leaves, stem, fruit, or affected area in good light and try again.");
    }
    return;
  }
  if (text) {
    await sendText(jid, await answer(text));
  }
}

async function startSocket(): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false,
  });
  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      status.state = "qr";
      status.qr = await QRCode.toDataURL(qr);
    }
    if (connection === "open") {
      status.state = "open";
      status.qr = null;
      status.lastError = null;
      status.phone = socket?.user?.id?.split(":")[0] ?? null;
      logger.info({ phone: status.phone }, "Flora Scan WhatsApp connection open");
    }
    if (connection === "close") {
      status.state = "closed";
      socket = null;
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) scheduleReconnect();
      else status.lastError = "WhatsApp session was logged out; pair again.";
    }
  });
  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const message of messages) {
      try {
        await handleMessage(message);
      } catch (error) {
        logger.error({ err: error }, "Unhandled Flora Scan message error");
      }
    }
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startBot();
  }, 3_000);
}

export async function startBot(): Promise<void> {
  if (startPromise) return startPromise;
  startPromise = startSocket()
    .catch((error) => {
      status.state = "error";
      status.lastError = error instanceof Error ? error.message : "WhatsApp startup failed";
      logger.error({ err: error }, "Flora Scan WhatsApp startup failed");
    })
    .finally(() => {
      startPromise = null;
    });
  return startPromise;
}

export function getBotStatus(): BotStatus {
  return { ...status };
}

export async function getQrDataUrl(): Promise<string | null> {
  return status.qr;
}

export async function clearSession(): Promise<void> {
  if (socket) {
    socket.end(undefined);
    socket = null;
  }
  status.state = "starting";
  status.phone = null;
  status.qr = null;
  status.lastError = null;
  await startBot();
}