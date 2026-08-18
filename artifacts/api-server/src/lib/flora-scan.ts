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
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger";

type Language = "en" | "ha" | "ig" | "yo";
type Provider = "groq" | "nvidia";
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type PlantMatch = {
  score: string;
  scientificName: string;
  commonNames: string[];
  family: string | null;
  genus: string | null;
};

type DiseaseMatch = {
  score: string;
  name: string;
  description: string | null;
};

type PlantContext = {
  commonName: string | null;
  scientificName: string;
  family: string | null;
  genus?: string | null;
};

type UserMemory = {
  lastPlant: PlantContext | null;
  messages: ChatMessage[];
  pendingYield: { crop?: string } | null;
  updatedAt: number;
};

const AUTH_DIR = path.resolve(process.env.WHATSAPP_AUTH_DIR ?? ".data/whatsapp-auth");
const QR_IMAGE_PATH = path.resolve(process.env.WHATSAPP_QR_PATH ?? ".data/whatsapp-qr.png");
const QR_TERMINAL_PATH = path.resolve(
  process.env.WHATSAPP_QR_TERMINAL_PATH ?? ".data/whatsapp-qr.txt",
);
const PLANTNET_API_KEY = process.env.PLANTNET_API_KEY;
const PLANTNET_PROJECT = process.env.PLANTNET_PROJECT ?? "all";
const MAX_HISTORY = 10;
const MEMORY_TTL_MS = 30 * 60 * 1000;
const MAX_PROCESSED_MESSAGES = 500;

const memories = new Map<string, UserMemory>();
const processedMessages = new Set<string>();

const GREETING_REGEX: Record<Language, RegExp> = {
  en: /^(hi+|hello+|hey+|howdy|good\s*(morning|afternoon|evening|day|night)|what'?s up|sup|greetings|yo|hiya|helo|hy|hei|hai)\b/i,
  ha: /^(sannu|barka\s*da|ina\s*kwana|ina\s*wuni|ina\s*yini|yaya\s*lafiya)/i,
  ig: /^(nnọọ|ndewo|kedụ|ọ\s*dị\s*mma|how\s*di)/i,
  yo: /^(ẹ\s*k[aá][ar]|e\s*k[aá][ar]|bawo|ẹ\s*káàbọ̀|ẹ\s*káabo)/i,
};

const FERTILIZER_REGEX =
  /\b(fertilizer|fertiliser|fertilize|fertilise|manure|npk|urea|treatment|spray|spraying|pesticide|herbicide|fungicide|insecticide|what.*apply|how.*treat|remedy|chemical|organic.*treat|dosage|dose|application rate|apply.*farm|weed.*control|pest.*control|how to cure|cure.*plant|plant.*medicine)\b/i;
const YIELD_REGEX =
  /\b(yield|harvest estimate|how much.*get|how many bags|profit|income|revenue|produce|production estimate|estimate.*farm|farm.*estimate|how much can i|what.*earn|cost of farming|cost.*farm|input cost|farming profit|how profitable)\b/i;
const DISEASE_REGEX =
  /disease|condition|sick|infection|infected|pest|blight|rot|wilt|spot|mold|mould|fungus|fungi|affected/i;

const KNOWN_CROPS = [
  "sweet potato",
  "sugarcane",
  "watermelon",
  "groundnut",
  "sunflower",
  "cocoyam",
  "pineapple",
  "plantain",
  "sorghum",
  "cassava",
  "cowpea",
  "soybean",
  "spinach",
  "lettuce",
  "cabbage",
  "cucumber",
  "sesame",
  "moringa",
  "papaya",
  "banana",
  "tomato",
  "pepper",
  "potato",
  "millet",
  "cotton",
  "ginger",
  "garlic",
  "carrot",
  "onion",
  "melon",
  "mango",
  "guava",
  "wheat",
  "cocoa",
  "beans",
  "maize",
  "pawpaw",
  "orange",
  "okra",
  "rice",
  "yam",
  "corn",
].sort((a, b) => b.length - a.length);

const WA_FORMAT_RULE =
  "\nFORMATTING: This response is sent through WhatsApp. Use *single asterisks* for bold, never **double asterisks**. Do not use markdown headings or tables. Bullets with • or - are fine.";

const QUESTION_SYSTEM_PROMPT = `You are an expert botanical and agricultural assistant for a WhatsApp bot called Flora Scan.
Answer questions across plant identification, taxonomy, biology, agronomy, crop production,
forestry, horticulture, soil science, soil management, plant nutrition, fertilisation,
disease and pest management, irrigation, genetics, post-harvest handling, agroforestry,
intercropping, plant uses, gardening, and plant care.

Detect whether the user writes in English, Hausa, Igbo, or Yoruba and reply in the same language.
Answer plant, crop, soil, farming, and agriculture questions even when indirect. Tailor advice
to Nigerian and West African conditions where genuinely relevant. If a question is unrelated,
politely decline in the user's language and invite a plant or farming question.
Keep responses concise, practical, accurate, and under 200 words. Do not invent certainty.
${WA_FORMAT_RULE}`;

const PROFILE_SYSTEM_PROMPT = `You are a knowledgeable botanist writing a short WhatsApp plant profile.
Given a plant's scientific name, common name, family, and genus, cover:
- a one or two sentence overview
- native region or typical habitat
- notable medicinal, culinary, ornamental, or other uses when well established
- one basic care or growing tip, especially useful for Nigerian conditions
Keep it under 120 words. Omit facts you are not confident about. Do not use headings.
${WA_FORMAT_RULE}`;

const DISEASE_SYSTEM_PROMPT = `You are an expert plant pathologist and agricultural extension officer
writing for Nigerian farmers and gardeners through WhatsApp. Detect the user's language and use
that language. Given PlantNet disease results and plant information, write a concise, actionable
report under 350 words using these exact labels:
*🦠 Disease / Condition:*
*🔍 Possible Causes:*
*💊 Treatment Options:*
*🛡️ Preventive Measures:*
*🌾 Best Farming Practices:*
Use Nigerian-relevant products and practices only where appropriate. State that a photo-based
result is not a laboratory diagnosis. Do not use markdown headings or double asterisks.
${WA_FORMAT_RULE}`;

const FERTILIZER_SYSTEM_PROMPT = `You are an agricultural inputs advisor for Nigerian farmers using Flora Scan.
Given a crop or plant and the user's question, give practical advice in the user's language.
Use these exact labels:
*🌿 Recommended Fertilizers:*
*💊 Pest & Disease Treatment:*
*🌱 Organic / Low-cost Alternatives:*
*📅 Application Schedule:*
Mention NPK 15-15-15, NPK 20-10-10, urea, CAN, DAP, SSP, poultry manure, or compost only
when agronomically appropriate. Give safe label-following guidance instead of pretending one
rate fits every soil. Keep under 320 words.
${WA_FORMAT_RULE}`;

const YIELD_SYSTEM_PROMPT = `You are an agricultural economist and agronomy advisor for Nigerian farmers using Flora Scan.
Given a crop, farm size, and language, provide a practical estimate with uncertainty. Use these labels:
*🌾 Crop & Farm Size:*
*📊 Expected Yield:*
*💰 Estimated Input Costs (NGN):*
*💵 Revenue & Profit Estimate (NGN):*
*📈 Tips to Maximise Your Yield:*
Use ranges, explain the major assumptions, acknowledge price volatility, and do not present estimates
as guarantees. Keep under 420 words.
${WA_FORMAT_RULE}`;

const status: BotStatus = {
  state: "starting",
  phone: null,
  qr: null,
  lastError: null,
  startedAt: new Date().toISOString(),
};

type BotStatus = {
  state: "starting" | "qr" | "open" | "closed" | "error";
  phone: string | null;
  qr: string | null;
  lastError: string | null;
  startedAt: string;
};

let socket: WASocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectDelay = 5_000;
let startPromise: Promise<void> | null = null;

function detectLanguage(text: string): Language {
  const t = text.toLowerCase();
  if (/\b(sannu|yaya|ina kwana|barka|mai|gona|noma|tsire|bishiya|ciyayi|ruwa|kasa|menene|yaushe|wane|wanda|kuma|tare|yanzu|lafiya|taimako)\b/.test(t)) return "ha";
  if (/\b(nnọọ|kedụ|ndewo|igwe|chi|anyị|unu|ihe|ebe|oge|ọrụ|ugbo|osisi|mkpụrụ|akwụkwọ|ala|mmiri|maka|biko|daalu)\b/.test(t)) return "ig";
  if (/\b(ẹ káàbọ̀|ẹ káaro|e kaaro|e kaasan|e kaale|bawo|jẹ|fun|bi|ati|tabi|nitori|ilẹ|omi|eweko|igi|irugbin|oko|agbe|àjàrà|àgbàdo|isu|ẹfọ|ewe|eso|ododo|ẹ jọ|ese)\b/.test(t)) return "yo";
  return "en";
}

function isGreeting(text: string, language: Language): boolean {
  return GREETING_REGEX[language].test(text.trim()) || /^(hi|hello|hey)[!.,\s]*$/i.test(text.trim());
}

function firstName(pushName: string | null | undefined): string {
  return pushName?.trim().split(/\s+/)[0] || "Johnson";
}

function buildGreeting(name: string, language: Language): string {
  const shared =
    `📸 *Identify plants* — Send me a clear photo of any plant and I'll tell you what it may be.\n` +
    `🦠 *Disease detection* — I'll check plant photos for signs of disease or stress.\n` +
    `🌱 *Agronomy & crop Q&A* — Ask about rice, yam, maize, soil, fertilisers, and more.\n` +
    `🧪 *Fertilizer & treatment advice* — Ask about inputs and safer treatment options.\n` +
    `📊 *Crop yield estimator* — Tell me your crop and farm size for a range-based estimate.\n` +
    `💬 *Plant Q&A* — Ask about plants, gardening, forestry, or plant care.\n`;
  if (language === "ha") return `🌿 Sannu, *${name}!*\n\nNi ne *Flora Scan*, an gina ni don taimaka maka game da tsire-tsire da noma.\n\n*Abin da zan iya yi maka:*\n${shared}\n_Aika mini hoto na tsire ko tambaya ta noma don farawa!_ 🌻`;
  if (language === "ig") return `🌿 Ndewo, *${name}!*\n\nAhụ m bụ *Flora Scan*, emebere m iji nyere gị aka n'ihe gbasara osisi da ọrụ ugbo.\n\n*Ihe m nwere ike ime:*\n${shared}\n_Ziga foto osisi ma ọ bụ ajụjụ ugbo iji bido!_ 🌻`;
  if (language === "yo") return `🌿 Ẹ káàbọ̀, *${name}!*\n\nMo jẹ *Flora Scan*, a ṣẹda mi lati ràn ọ́ lọ́wọ́ pẹ̀lú ewéko àti iṣẹ́ àgbẹ̀.\n\n*Ohun tí mo lè ṣe:*\n${shared}\n_Fi fọto ewéko ránṣẹ́ tàbí béèrè ìbéèrè nípa àgbẹ̀ láti bẹ̀rẹ̀!_ 🌻`;
  return `🌿 Good day, *${name}!*\n\nI'm *Flora Scan*, built by *Aliu Johnson Temitope*, a fellow of the *3MTT Airtel NextGen Program* (Fellow ID: FE/23/24184818).\n\n*Here's what I can do for you:*\n${shared}\n_Just send a plant photo, voice note, or type your plant question to get started!_ 🌻`;
}

function sanitizeForWhatsApp(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "*$1*").replace(/^#{1,6}\s+/gm, "");
}

function getMemory(jid: string): UserMemory {
  const current = memories.get(jid);
  if (!current || Date.now() - current.updatedAt > MEMORY_TTL_MS) {
    const fresh: UserMemory = { lastPlant: null, messages: [], pendingYield: null, updatedAt: Date.now() };
    memories.set(jid, fresh);
    return fresh;
  }
  return current;
}

function updateMemory(jid: string, patch: Partial<UserMemory>): void {
  memories.set(jid, { ...getMemory(jid), ...patch, updatedAt: Date.now() });
}

function pushMessage(jid: string, role: "user" | "assistant", content: string): void {
  const memory = getMemory(jid);
  updateMemory(jid, { messages: [...memory.messages, { role, content }].slice(-MAX_HISTORY) });
}

function parseFarmSize(text: string): { size: number; unit: string } | null {
  const lower = text.toLowerCase();
  const half = lower.match(/\bhalf\s+(hectare|ha|acre|plot)\b/);
  if (half) return { size: 0.5, unit: half[1] === "ha" ? "hectare" : half[1] };
  const match = text.match(/(\d+(?:\.\d+)?)\s*(hectare|hectares|ha|acre|acres|plot|plots|sqm|square\s*met(?:re|er)s?|sqft|square\s*fe(?:et|et))/i);
  if (!match) return null;
  const size = Number.parseFloat(match[1]);
  if (!size || size <= 0) return null;
  const unit = match[2].toLowerCase().replace(/s$/, "").replace(/^ha$/, "hectare").replace(/square\s*met(?:re|er)/, "sqm").replace(/square\s*fe(?:et|et)/, "sqft");
  return { size, unit };
}

function parseCropName(text: string): string | null {
  const lower = text.toLowerCase();
  for (const crop of KNOWN_CROPS) {
    if (new RegExp(`\\b${crop.replace(/\s+/g, "\\s+")}\\b`).test(lower)) return crop;
  }
  return null;
}

function getText(message: WAMessage): string {
  const content = message.message;
  if (!content) return "";
  return (content.conversation ?? content.extendedTextMessage?.text ?? content.imageMessage?.caption ?? content.videoMessage?.caption ?? "").trim();
}

function getImageMessage(message: WAMessage) {
  const content = message.message;
  if (!content) return null;
  return content.imageMessage ?? content.viewOnceMessage?.message?.imageMessage ?? content.viewOnceMessageV2?.message?.imageMessage ?? null;
}

function getAudioMessage(message: WAMessage) {
  const content = message.message;
  if (!content) return null;
  return content.audioMessage ?? content.viewOnceMessage?.message?.audioMessage ?? content.viewOnceMessageV2?.message?.audioMessage ?? null;
}

async function downloadMedia(message: WAMessage, type: "image" | "audio"): Promise<Buffer | null> {
  if (type === "image" && !getImageMessage(message)) return null;
  if (type === "audio" && !getAudioMessage(message)) return null;
  const stream = await downloadContentFromMessage(
    (type === "image" ? getImageMessage(message) : getAudioMessage(message)) as never,
    type,
  );
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function identifyPlant(image: Buffer): Promise<PlantMatch[] | null> {
  if (!PLANTNET_API_KEY) throw new Error("PLANTNET_API_KEY is not configured");
  const bytes = new Uint8Array(image.byteLength);
  bytes.set(image);
  const form = new FormData();
  form.append("images", new Blob([bytes], { type: "image/jpeg" }), "plant.jpg");
  form.append("organs", "auto");
  const response = await fetch(`https://my-api.plantnet.org/v2/identify/${PLANTNET_PROJECT}?api-key=${encodeURIComponent(PLANTNET_API_KEY)}&include-related-images=false&no-reject=false`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`PlantNet identification returned HTTP ${response.status}`);
  const data = (await response.json()) as { results?: Array<{ score?: number; species?: { scientificNameWithoutAuthor?: string; commonNames?: string[]; family?: { scientificNameWithoutAuthor?: string }; genus?: { scientificNameWithoutAuthor?: string } } }> };
  if (!data.results?.length) return null;
  return data.results.slice(0, 3).map((result) => ({
    score: `${((result.score ?? 0) * 100).toFixed(1)}`,
    scientificName: result.species?.scientificNameWithoutAuthor ?? "Unknown species",
    commonNames: result.species?.commonNames ?? [],
    family: result.species?.family?.scientificNameWithoutAuthor ?? null,
    genus: result.species?.genus?.scientificNameWithoutAuthor ?? null,
  }));
}

async function identifyDisease(image: Buffer): Promise<DiseaseMatch[] | null> {
  if (!PLANTNET_API_KEY) throw new Error("PLANTNET_API_KEY is not configured");
  const bytes = new Uint8Array(image.byteLength);
  bytes.set(image);
  const form = new FormData();
  form.append("images", new Blob([bytes], { type: "image/jpeg" }), "plant.jpg");
  const response = await fetch(`https://my-api.plantnet.org/v2/diseases/identify?api-key=${encodeURIComponent(PLANTNET_API_KEY)}&include-related-images=false&no-reject=true&nb-results=5`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`PlantNet disease scan returned HTTP ${response.status}`);
  const data = (await response.json()) as { results?: Array<{ score?: number; name?: string; description?: string }> };
  if (!data.results?.length) return null;
  return data.results.map((result) => ({
    score: `${((result.score ?? 0) * 100).toFixed(1)}`,
    name: result.name ?? "Unknown condition",
    description: result.description ?? null,
  }));
}

function formatPlantHeader(top: PlantMatch): string {
  let reply = "🌿 *Plant identified!*\n\n";
  reply += `*Name:* ${top.commonNames[0] ?? "No common name found"}\n`;
  reply += `*Scientific name:* _${top.scientificName}_\n`;
  if (top.family) reply += `*Family:* ${top.family}\n`;
  reply += `*Confidence:* ${top.score}%\n`;
  if (top.commonNames.length > 1) reply += `*Also known as:* ${top.commonNames.slice(1, 4).join(", ")}\n`;
  return reply;
}

function formatAlternates(matches: PlantMatch[]): string {
  if (matches.length <= 1) return "";
  return `\n_Other possible matches:_\n${matches.slice(1).map((match) => `• ${match.commonNames[0] ?? match.scientificName} (${match.score}%)`).join("\n")}`;
}

function notFoundMessage(): string {
  return "I couldn't confidently identify this plant. 🌱\n\nTips for a better shot:\n• Get close to a single leaf or flower\n• Use good natural light\n• Avoid blurry or shadowed photos\n\nTry sending another photo!";
}

function formatDiseaseResult(diseases: DiseaseMatch[]): string | null {
  if (!diseases.length || Number.parseFloat(diseases[0].score) < 5) return null;
  const top = diseases[0];
  return `\n🦠 *Disease Check:*\n*Most likely:* ${top.description ?? top.name} _(${top.score}% confidence)_\n${diseases.length > 1 ? `\n_Other possible conditions:_\n${diseases.slice(1).map((disease) => `• ${disease.description ?? disease.name} (${disease.score}%)`).join("\n")}` : ""}`;
}

function providerUrl(provider: Provider): string {
  return provider === "groq" ? "https://api.groq.com/openai/v1/chat/completions" : "https://integrate.api.nvidia.com/v1/chat/completions";
}

function providerKey(provider: Provider): string | undefined {
  return provider === "groq" ? process.env.GROQ_API_KEY : process.env.NVIDIA_API_KEY;
}

function providerModel(provider: Provider): string {
  return provider === "groq" ? process.env.GROQ_MODEL ?? "openai/gpt-oss-120b" : process.env.NVIDIA_MODEL ?? "meta/llama-3.1-70b-instruct";
}

async function callAI(messages: ChatMessage[], maxTokens = 300): Promise<string | null> {
  for (const provider of ["groq", "nvidia"] as const) {
    const key = providerKey(provider);
    if (!key) continue;
    try {
      const response = await fetch(providerUrl(provider), {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: providerModel(provider), messages, temperature: 0.4, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(provider === "groq" ? 25_000 : 30_000),
      });
      if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}`);
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const result = data.choices?.[0]?.message?.content?.trim();
      if (result) return sanitizeForWhatsApp(result);
    } catch (error) {
      logger.warn({ provider, err: error }, "AI provider failed; trying fallback");
    }
  }
  return null;
}

async function generateDescription(plant: PlantContext): Promise<string | null> {
  return callAI([
    { role: "system", content: PROFILE_SYSTEM_PROMPT },
    { role: "user", content: `Plant details:\nScientific name: ${plant.scientificName}\nCommon name: ${plant.commonName ?? "unknown"}\nFamily: ${plant.family ?? "unknown"}\nGenus: ${plant.genus ?? "unknown"}\n\nWrite the description now.` },
  ]);
}

async function answerQuestion(question: string, history: ChatMessage[] = []): Promise<string | null> {
  return callAI([{ role: "system", content: QUESTION_SYSTEM_PROMPT }, ...history, { role: "user", content: question }], 400);
}

async function generateDiseaseReport(diseases: DiseaseMatch[], plant: PlantContext | null, question: string): Promise<string | null> {
  const top = diseases[0];
  const results = diseases.map((disease) => `${disease.description ?? disease.name} (${disease.score}%)`).join(", ");
  return callAI([
    { role: "system", content: DISEASE_SYSTEM_PROMPT },
    { role: "user", content: `User message: ${question || "Please assess this photo."}\nPlant: ${plant?.commonName ?? plant?.scientificName ?? "unknown"} (${plant?.scientificName ?? "unknown"})\nTop condition: ${top?.description ?? top?.name ?? "unknown"} (${top?.score ?? "unknown"}%)\nOther PlantNet results: ${results}\nWrite the full report now.` },
  ], 600);
}

async function generateFertilizerAdvice(cropOrPlant: string, question: string): Promise<string | null> {
  return callAI([{ role: "system", content: FERTILIZER_SYSTEM_PROMPT }, { role: "user", content: `Crop/plant: ${cropOrPlant}\nUser question: ${question}\nWrite the recommendations now.` }], 500);
}

async function estimateCropYield(crop: string, farmSize: { size: number; unit: string }, language: Language): Promise<string | null> {
  return callAI([{ role: "system", content: YIELD_SYSTEM_PROMPT }, { role: "user", content: `[User language: ${language}]\nCrop: ${crop}\nFarm size: ${farmSize.size} ${farmSize.unit}(s)\nProvide the yield, input cost, and profit estimate now.` }], 600);
}

async function transcribeAudio(audio: Buffer, mimetype: string): Promise<string | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  const bytes = new Uint8Array(audio.byteLength);
  bytes.set(audio);
  const form = new FormData();
  const extension = mimetype.includes("mp4") ? "m4a" : mimetype.includes("mp3") ? "mp3" : "ogg";
  form.append("file", new Blob([bytes], { type: mimetype || "audio/ogg" }), `audio.${extension}`);
  form.append("model", process.env.GROQ_TRANSCRIPTION_MODEL ?? "whisper-large-v3");
  form.append("response_format", "json");
  try {
    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Whisper returned HTTP ${response.status}`);
    const data = (await response.json()) as { text?: string };
    return data.text?.trim() ?? null;
  } catch (error) {
    logger.warn({ err: error }, "Voice transcription failed");
    return null;
  }
}

async function sendText(jid: string, text: string): Promise<void> {
  if (socket) await socket.sendMessage(jid, { text: sanitizeForWhatsApp(text) });
}

async function setTyping(jid: string, typing: boolean): Promise<void> {
  try {
    await socket?.sendPresenceUpdate(typing ? "composing" : "paused", jid);
  } catch (error) {
    logger.warn({ err: error, jid }, "Could not update WhatsApp typing indicator");
  }
}

async function withTyping<T>(jid: string, work: () => Promise<T>): Promise<T> {
  await setTyping(jid, true);
  try {
    return await work();
  } finally {
    await setTyping(jid, false);
  }
}

async function handleImage(message: WAMessage, jid: string, caption: string): Promise<void> {
  await sendText(jid, "🔍 Scanning your plant, one moment...");
  const image = await downloadMedia(message, "image");
  if (!image) throw new Error("image could not be downloaded");
  const diseaseQuery = DISEASE_REGEX.test(caption);
  if (diseaseQuery) {
    const [plantResult, diseaseResult] = await Promise.allSettled([identifyPlant(image), identifyDisease(image)]);
    const plants = plantResult.status === "fulfilled" ? plantResult.value : null;
    const diseases = diseaseResult.status === "fulfilled" ? diseaseResult.value : null;
    const plant = plants?.[0]
      ? { commonName: plants[0].commonNames[0] ?? null, scientificName: plants[0].scientificName, family: plants[0].family, genus: plants[0].genus }
      : null;
    if (plants?.[0]) await sendText(jid, `🌿 *Plant identified:* ${plants[0].commonNames[0] ?? plants[0].scientificName} (_${plants[0].scientificName}_)\n*Confidence:* ${plants[0].score}%\n\n🔬 Running disease analysis...`);
    if (!diseases || !diseases.length || Number.parseFloat(diseases[0].score) < 5) {
      await sendText(jid, "✅ No significant disease or condition was detected on this plant. It appears healthy! For best results, send a close-up photo of the affected leaf, stem, or fruit.");
      return;
    }
    const report = await generateDiseaseReport(diseases, plant, caption);
    await sendText(jid, report ?? formatDiseaseResult(diseases) ?? "⚠️ Disease scan completed but detailed analysis is unavailable right now.");
    if (plant) updateMemory(jid, { lastPlant: plant });
    return;
  }
  const matches = await identifyPlant(image);
  if (!matches) {
    await sendText(jid, notFoundMessage());
    return;
  }
  const top = matches[0];
  const plant: PlantContext = { commonName: top.commonNames[0] ?? null, scientificName: top.scientificName, family: top.family, genus: top.genus };
  const identification = formatPlantHeader(top) + formatAlternates(matches);
  await sendText(jid, identification);
  const description = await generateDescription(plant);
  const profile = description ? `📖 *About this plant:*\n\n${description}` : "I couldn't fetch the full plant profile right now, but the identification above is available.";
  await sendText(jid, profile);
  updateMemory(jid, { lastPlant: plant });
  pushMessage(jid, "assistant", `${identification}\n\n${profile}`);
}

async function handleVoice(message: WAMessage, jid: string): Promise<void> {
  await sendText(jid, "🎙️ Got your voice note, give me a moment...");
  const audio = await downloadMedia(message, "audio");
  if (!audio) throw new Error("audio could not be downloaded");
  const audioMessage = getAudioMessage(message);
  const transcript = await transcribeAudio(audio, audioMessage?.mimetype ?? "audio/ogg; codecs=opus");
  if (!transcript) {
    await sendText(jid, "Sorry, I couldn't make out that voice note. Please try again or type your question.");
    return;
  }
  const memory = getMemory(jid);
  const context = memory.lastPlant ? `[Context: the user previously identified a ${memory.lastPlant.commonName ?? memory.lastPlant.scientificName} (${memory.lastPlant.scientificName})]\n` : "";
  const reply = await answerQuestion(`${context}${transcript}`, memory.messages);
  const text = reply ?? "I'm only able to help with plant-related questions. Send me a plant photo or type your question.";
  await sendText(jid, text);
  pushMessage(jid, "user", transcript);
  pushMessage(jid, "assistant", text);
}

async function handleText(message: WAMessage, jid: string, text: string): Promise<void> {
  const language = detectLanguage(text);
  if (isGreeting(text, language)) {
    await sendText(jid, buildGreeting(firstName(message.pushName), language));
    return;
  }
  const memory = getMemory(jid);
  const farmSize = parseFarmSize(text);
  const crop = parseCropName(text) ?? memory.lastPlant?.commonName ?? null;
  const yieldIntent = YIELD_REGEX.test(text);
  if (memory.pendingYield) {
    const resolvedCrop = memory.pendingYield.crop ?? parseCropName(text);
    if (resolvedCrop && farmSize) {
      updateMemory(jid, { pendingYield: null });
      await sendText(jid, `📊 Estimating yield for *${resolvedCrop}* on *${farmSize.size} ${farmSize.unit}(s)*...`);
      const estimate = await estimateCropYield(resolvedCrop, farmSize, language);
      const reply = estimate ?? "Sorry, I couldn't generate the estimate right now. Please try again.";
      await sendText(jid, reply);
      pushMessage(jid, "user", text);
      pushMessage(jid, "assistant", reply);
      return;
    }
    if (resolvedCrop) {
      updateMemory(jid, { pendingYield: { crop: resolvedCrop } });
      await sendText(jid, `📏 Got it — *${resolvedCrop}*. Now please tell me your farm size (e.g. "2 hectares", "1 acre", "4 plots").`);
      return;
    }
    updateMemory(jid, { pendingYield: {} });
    await sendText(jid, `🌾 Please tell me both your crop and farm size (e.g. "Maize, 2 hectares" or "Tomato, 1 acre").`);
    return;
  }
  if (yieldIntent) {
    if (crop && farmSize) {
      await sendText(jid, `📊 Estimating yield for *${crop}* on *${farmSize.size} ${farmSize.unit}(s)*...`);
      const estimate = await estimateCropYield(crop, farmSize, language);
      const reply = estimate ?? "Sorry, I couldn't generate the estimate right now. Please try again.";
      await sendText(jid, reply);
      pushMessage(jid, "user", text);
      pushMessage(jid, "assistant", reply);
      return;
    }
    updateMemory(jid, { pendingYield: crop ? { crop } : {} });
    await sendText(jid, crop ? `📏 To estimate your *${crop}* yield, please tell me your farm size (e.g. "2 hectares", "1 acre", "4 plots").` : `🌾 To estimate your crop yield, please tell me your crop and farm size (e.g. "Maize, 2 hectares" or "Tomato, 1 acre").`);
    return;
  }
  if (FERTILIZER_REGEX.test(text) && crop) {
    await sendText(jid, `🧪 Looking up fertilizer and treatment recommendations for *${crop}*...`);
    const advice = await generateFertilizerAdvice(crop, text);
    const reply = advice ?? "Sorry, I couldn't fetch the recommendations right now. Please try again.";
    await sendText(jid, reply);
    pushMessage(jid, "user", text);
    pushMessage(jid, "assistant", reply);
    return;
  }
  const plantContext = memory.lastPlant ? `[Context: the user previously identified a ${memory.lastPlant.commonName ?? memory.lastPlant.scientificName} (${memory.lastPlant.scientificName})]` : "";
  const reply = await answerQuestion(`[User language: ${language}]\n${plantContext}\n${text}`, memory.messages);
  const answer = reply ?? (language === "ha" ? "Zan iya taimaka ne kawai game da tsire-tsire da noma. 🌿" : language === "ig" ? "Nwere ike isi m aka naanị n'ihe gbasara osisi da ọrụ ugbo. 🌿" : language === "yo" ? "Mo lè ràn ọ́ lọ́wọ́ nínú ìbéèrè nípa ewéko àti iṣẹ́ àgbẹ̀. 🌿" : "I'm only able to help with plant and agriculture-related questions. 🌿");
  await sendText(jid, answer);
  pushMessage(jid, "user", text);
  pushMessage(jid, "assistant", answer);
}

async function handleMessage(message: WAMessage): Promise<void> {
  const jid = message.key.remoteJid;
  const messageId = message.key.id;
  if (!jid || !messageId || message.key.fromMe || jid === "status@broadcast" || processedMessages.has(messageId)) return;
  processedMessages.add(messageId);
  if (processedMessages.size > MAX_PROCESSED_MESSAGES) processedMessages.delete(processedMessages.values().next().value as string);
  try {
    const image = getImageMessage(message);
    const audio = getAudioMessage(message);
    if (image) {
      await withTyping(jid, () => handleImage(message, jid, getText(message)));
      return;
    }
    if (audio?.ptt) {
      await withTyping(jid, () => handleVoice(message, jid));
      return;
    }
    const text = getText(message);
    if (text) await withTyping(jid, () => handleText(message, jid, text));
  } catch (error) {
    logger.error({ err: error, jid }, "Error handling Flora Scan message");
    await sendText(jid, "⚠️ Something went wrong while processing that message. Please try again with a clearer photo or question.");
  }
}

async function startSocket(): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  socket = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
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
      await mkdir(path.dirname(QR_IMAGE_PATH), { recursive: true });
      await QRCode.toFile(QR_IMAGE_PATH, qr, { type: "png", width: 512, margin: 2 });
      const terminalQr = await QRCode.toString(qr, { type: "terminal", small: true });
      await writeFile(QR_TERMINAL_PATH, terminalQr, "utf8");
      logger.info({ qrImagePath: QR_IMAGE_PATH, qrTerminalPath: QR_TERMINAL_PATH, qrTerminal: terminalQr }, "WhatsApp QR code is ready");
    }
    if (connection === "open") {
      status.state = "open";
      status.qr = null;
      status.lastError = null;
      status.phone = socket?.user?.id?.split(":")[0] ?? null;
      reconnectDelay = 5_000;
      await writeFile(QR_TERMINAL_PATH, "WhatsApp is paired; no QR code is currently required.\n", "utf8");
      logger.info({ phone: status.phone }, "Flora Scan WhatsApp connection open");
    }
    if (connection === "close") {
      status.state = "closed";
      socket = null;
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        if (!reconnectTimer) {
          const delay = reconnectDelay;
          reconnectDelay = Math.min(reconnectDelay * 1.5, 30_000);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void startBot();
          }, delay);
        }
      } else {
        status.lastError = "WhatsApp session was logged out; pair again.";
      }
    }
  });
  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const message of messages) await handleMessage(message);
  });
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
  memories.clear();
  processedMessages.clear();
  await startBot();
}
