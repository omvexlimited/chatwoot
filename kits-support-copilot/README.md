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
- `COPILOT_DATABASE_URL` for persistent global memory commands. Falls back to `DATABASE_URL`.
- `OPENAI_MODEL` defaults to `gpt-5.5`.
- `SHOPIFY_API_VERSION` defaults to `2026-04`.

## Local Run

```sh
npm test
npm start
```

Open `http://localhost:3000/?token=...`.

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

The copilot loads current support context from the published Kits Republic Playbooks endpoint when `KITS_INTERNAL_API_TOKEN` is configured. If the admin API is unavailable, it falls back to the local markdown files:

- `knowledge/kits-republic-support-guide.md`: base guardrails and support rules.
- `knowledge/kits-republic-support-playbook-v2.md`: versioned Kits Republic customer support playbook.

Knowledge text is passed to OpenAI as internal context only. It is not exposed by the UI and should not be quoted directly in customer drafts.
