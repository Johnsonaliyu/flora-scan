import { execFile } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const authDir = path.resolve(process.env.WHATSAPP_AUTH_DIR ?? ".data/whatsapp-auth");
const archivePath = path.resolve(
  process.env.WHATSAPP_SESSION_ARCHIVE ?? ".data/whatsapp-session-backup.tar.gz",
);
const authName = path.basename(authDir);
const authParent = path.dirname(authDir);

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function sessionStatus() {
  if (!(await exists(authDir))) {
    console.log(`WhatsApp session directory does not exist yet: ${authDir}`);
    return;
  }
  const files = (await readdir(authDir)).filter((file) => file.endsWith(".json"));
  console.log(`WhatsApp session directory: ${authDir}`);
  console.log(`Credential files: ${files.length}`);
  console.log("This directory is intentionally excluded from Git.");
}

async function archiveSession() {
  if (!(await exists(authDir))) {
    throw new Error(`WhatsApp session directory does not exist: ${authDir}`);
  }
  await mkdir(path.dirname(archivePath), { recursive: true });
  await execFileAsync("tar", ["-czf", archivePath, "-C", authParent, authName]);
  console.log(`Created WhatsApp session backup: ${archivePath}`);
  console.log("Keep this file private. Never commit it to GitHub or share it publicly.");
}

async function restoreSession() {
  if (!(await exists(archivePath))) {
    throw new Error(`WhatsApp session archive does not exist: ${archivePath}`);
  }
  await mkdir(authParent, { recursive: true });
  await execFileAsync("tar", ["-xzf", archivePath, "-C", authParent]);
  console.log(`Restored WhatsApp session into: ${authDir}`);
  console.log("Restart the API server after restoring the session.");
}

const command = process.argv[2] ?? "status";
try {
  if (command === "status") await sessionStatus();
  else if (command === "archive") await archiveSession();
  else if (command === "restore") await restoreSession();
  else throw new Error(`Unknown command "${command}". Use status, archive, or restore.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}