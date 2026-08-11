# Flora Scan

WhatsApp plant assistant for agronomy questions, plant identification, disease scanning, and crop guidance.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (managed workflow port)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm run whatsapp:qr` — print the current pairing QR from the API server
- `pnpm run whatsapp:session:status` — check whether the WhatsApp auth session exists
- `pnpm run whatsapp:session:archive` — create a private session backup for migration
- `pnpm run whatsapp:session:restore` — restore a private session backup before starting the bot
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

- Groq is the primary AI provider and NVIDIA is used as the fallback provider.
- Baileys credentials persist under `.data/whatsapp-auth`, configurable with `WHATSAPP_AUTH_DIR`.
- PlantNet handles plant and disease identification; the AI providers format the resulting guidance.
- WhatsApp auth data is deliberately excluded from Git because it grants access to the linked account.

## Product

Flora Scan responds to WhatsApp text, images, and voice notes with multilingual plant-focused
answers. It supports plant profiles, disease scans, fertilizer and treatment recommendations,
yield estimates, conversation memory, and WhatsApp pairing/status routes.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

The WhatsApp session lives in `artifacts/api-server/.data/whatsapp-auth` and is ignored by Git.
Do not commit the auth folder or its backup archive to GitHub. To move the bot to another Replit,
create a private archive, copy it separately, restore it before starting the API server, and keep
the same `WHATSAPP_AUTH_DIR` path. Restarts of the same Replit reuse the session automatically.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
