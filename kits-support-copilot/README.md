# KR Copilot

External Dashboard App for Chatwoot that generates human-reviewed support drafts for Kits Republic.

## Environment

Required for full functionality:

- `OPENAI_API_KEY`
- Shopify credentials, using one of these modes:
  - Direct Admin API token: `SHOPIFY_STORE_DOMAIN` + `SHOPIFY_ADMIN_ACCESS_TOKEN`
  - Dev Dashboard app credentials: `SHOPIFY_KITS_REPUBLIC_SHOP_NAME` + `SHOPIFY_KITS_REPUBLIC_CLIENT_ID` + `SHOPIFY_KITS_REPUBLIC_CLIENT_SECRET`
- `CHATWOOT_BASE_URL`
- `CHATWOOT_ACCOUNT_ID`
- `CHATWOOT_API_TOKEN`

Recommended:

- `COPILOT_API_TOKEN` shared token used by the embedded Dashboard App URL.
- `COPILOT_DATABASE_URL` for memories and prepared drafts. Use a private PostgreSQL instance in the same Railway region. It falls back to `KITS_REPUBLIC_DATABASE_URL` during migration.
- `COPILOT_DATABASE_SSL=false` for Railway private networking.
- `COPILOT_PROGRESSIVE_CONTEXT=true` to return core context first and load slower enrichments in the background.
- `OPENAI_MODEL` defaults to `gpt-5.6-luna`.
- `SHOPIFY_API_VERSION` defaults to `2026-04`.

Performance controls:

- `COPILOT_DATABASE_POOL_SIZE` and `KR_DATABASE_POOL_SIZE` default to `4`.
- `COPILOT_CONTEXT_CACHE_TTL_MS` defaults to `300000`.
- `COPILOT_CONTEXT_CACHE_MAX_ENTRIES` defaults to `200`.
- `PREPARED_DRAFT_WORKER_INTERVAL_MS` defaults to `60000`.
- `ATTACHMENT_DOWNLOAD_TIMEOUT_MS` defaults to `5000`.

## Local Run

```sh
npm test
npm start
```

Open `http://localhost:3000/?token=...`.

## Database Migration

To move existing memories from the Kits Republic database to the dedicated Copilot database:

```sh
KITS_REPUBLIC_DATABASE_URL=... COPILOT_DATABASE_URL=... npm run migrate:memories
```

The migration is idempotent and verifies both row count and content digest before it succeeds.

## Chatwoot Dashboard App URL

Register the deployed URL in Chatwoot as:

```txt
https://YOUR-COPILOT-SERVICE.up.railway.app/?token=YOUR_COPILOT_API_TOKEN
```

The service only creates private notes when the agent clicks that button. It never sends customer replies.

`Insert reply` places the current draft in Chatwoot's public reply composer for human review. It does not send the message to the customer.

## Chat Commands

Inside the KR Copilot chat:

- `/remember <text>` saves a global support memory.
- `/memories` lists the latest active memories.
- `/forget <id>` disables a saved memory.
- `/help` shows the available commands.

Memory commands do not call OpenAI, do not edit the draft, and do not insert anything into the Chatwoot composer.

## Deployed Service

- Railway service: `kits-support-copilot`
- Public URL: `https://kits-support-copilot-production.up.railway.app`
- Healthcheck: `https://kits-support-copilot-production.up.railway.app/health`

Chatwoot has a Dashboard App named `KR Copilot` pointing to the deployed service. The URL stored in Chatwoot includes the private `COPILOT_API_TOKEN`; do not paste that URL in tickets, docs, or logs.

The current deployment is wired to Chatwoot. OpenAI lookups only work after setting `OPENAI_API_KEY` in Railway. Shopify lookups work with either a direct Admin API access token or the Dev Dashboard client credentials flow.

When both Shopify auth modes are present, the service uses client credentials by default. Set `SHOPIFY_AUTH_MODE=admin_access_token` only if the direct token is known to be valid.

## Knowledge Base

The copilot loads current support policy exclusively from the published Kits Republic Playbooks endpoint when `KITS_INTERNAL_API_TOKEN` is configured. It selects shared Playbooks plus those matching the detected `case_type` or published tags.

- `published`: current published Playbooks are available and complete.
- `stale_published`: the Admin API is unavailable and the process uses its last successfully loaded published version.
- `facts_only`: no published version is available; drafts may use verified case facts but cannot state commercial policy.

The files under `knowledge/` are historical migration references only. They are never loaded as runtime fallback. Knowledge text is passed to OpenAI as internal context only and must not be quoted directly in customer drafts.
