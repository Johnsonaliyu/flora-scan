import { Router, type IRouter } from "express";
import { clearSession, getBotStatus, getQrDataUrl, startBot } from "../lib/flora-scan";

const router: IRouter = Router();

router.get("/whatsapp/status", (_req, res) => {
  res.json(getBotStatus());
});

router.get("/whatsapp/qr", async (_req, res) => {
  const qr = await getQrDataUrl();
  if (!qr) {
    res.status(404).json({ message: "A QR code is not available. Check status and try again." });
    return;
  }
  res.json({ qr });
});

router.get("/whatsapp/qr.png", async (_req, res) => {
  const qr = await getQrDataUrl();
  if (!qr) {
    res.status(404).send("A QR code is not available. Check the WhatsApp status and try again.");
    return;
  }
  const [, base64] = qr.split(",");
  res.type("png").send(Buffer.from(base64, "base64"));
});

router.get("/whatsapp/pair", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pair Flora Scan</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0d1f17; color: #f1f7ef; font: 16px system-ui, sans-serif; }
      main { max-width: 460px; padding: 32px; text-align: center; }
      img { width: min(360px, 85vw); height: min(360px, 85vw); background: white; padding: 14px; border-radius: 18px; }
      h1 { margin-bottom: 8px; }
      p { color: #b9d0bd; line-height: 1.5; }
      code { color: #d7efb8; }
    </style>
  </head>
  <body>
    <main>
      <h1>Pair Flora Scan</h1>
      <p>On your phone, open WhatsApp → Linked devices → Link a device, then scan this code.</p>
      <img id="qr" src="/api/whatsapp/qr.png" alt="WhatsApp pairing QR code" />
      <p id="message">This code refreshes automatically. Once paired, Flora Scan will respond to messages sent to that WhatsApp account.</p>
      <script>
        const image = document.getElementById("qr");
        const message = document.getElementById("message");
        setInterval(async () => {
          try {
            const response = await fetch("/api/whatsapp/status", { cache: "no-store" });
            const status = await response.json();
            if (status.state === "open") {
              message.textContent = "Flora Scan is paired and ready to receive WhatsApp messages.";
              return;
            }
            if (status.state === "qr") image.src = "/api/whatsapp/qr.png?t=" + Date.now();
          } catch {}
        }, 5000);
      </script>
    </main>
  </body>
</html>`);
});

router.post("/whatsapp/start", async (_req, res) => {
  await startBot();
  res.status(202).json(getBotStatus());
});

router.post("/whatsapp/reset", async (_req, res) => {
  await clearSession();
  res.status(202).json(getBotStatus());
});

export default router;