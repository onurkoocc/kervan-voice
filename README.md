# kervan-voice

> Part of **[Kervan](https://github.com/onurkoocc/kervan-system)**, a fictional cargo company built as a
> reference for backends where AI agents can safely act on a customer's behalf. Start there.

The Kervan customer agent. Text transcripts stand in for voice. It is one of the seven repositories of Kervan, the fictional cargo company used to test Mandate. All data is synthetic. The cross-repository contract is the Kervan `SPEC.md`. This component follows §1, §2, §3.2–3.3, §4, §6 and §8.

```text
evals ──POST /converse──▶ voice ──client_credentials + private_key_jwt (CIMD)──▶ auth
                           voice ──MCP tools, Bearer JWT─────────────────────────▶ mcp
```

## HTTP API

`docs/openapi.json` (the `AgentApi` interface) describes exactly these:

| Method and path | Answer |
|---|---|
| `GET /health` | `{"status":"ok"}` |
| `GET /client-metadata.json` | The client ID metadata document. Its own URL, `${PUBLIC_URL}/client-metadata.json`, is the OAuth client id |
| `POST /converse` | `{"conversation_id", "utterance"}` → `{"reply", "tool_calls": [{"name", "arguments", "is_error", "result"}], "state": "open"\|"done"}` |

Conversations are kept in memory by `conversation_id`. An `X-Trace-Id` request header is used as the log trace id, echoed in the response and sent on to auth and MCP; without one, an id is generated.

`state` is `open` while the agent waits for something from the customer, and `done` once the request was carried out or definitively refused.

## Configuration

Only environment variables. The defaults are the compose values.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `7000` | |
| `PUBLIC_URL` | `http://voice:7000` | The client id is `${PUBLIC_URL}/client-metadata.json` |
| `AUTH_ISSUER` | `http://auth:9000` | The token endpoint is read from `${AUTH_ISSUER}/.well-known/oauth-authorization-server` |
| `MCP_URL` | `http://mcp:3001/mcp` | |
| `MCP_RESOURCE` | `http://mcp:3001/mcp` | The `resource` (RFC 8707) requested from auth |
| `AGENT_MODE` | `scripted` | `scripted` (deterministic) or `llm` |
| `AGENT_MODEL` | `claude-sonnet-5-5` | `llm` mode only |
| `ANTHROPIC_API_KEY` | unset | `llm` mode only |
| `CLIENT_KEY_FILE` | unset | PEM file holding the client's EC P-256 private key. Unset: a key is generated at start and kept in memory |
| `LOG_FILE` | unset | Also append the JSON log lines here |

## How it works

- **Token** (`src/auth/token-client.ts`). The client signs an ES256 assertion with `iss = sub = client_id`, `aud = token endpoint`, a lifetime of 30 s and a unique `jti`. It requests `client_credentials` with all four scopes and `resource=MCP_RESOURCE`. The token is cached and refreshed 30 s before it expires, or at half its lifetime if that is shorter.
- **Tools** (`src/mcp/client.ts`). The official MCP SDK client is used over Streamable HTTP, with the token sent as a Bearer header on every request. If MCP answers 401, the client drops the token and the session and retries once.
- **Scripted agent** (`src/agent/scripted/`).
  - `extract.ts` finds tracking numbers (`KRV` + 8 digits), dates (`YYYY-MM-DD`, "tomorrow" in Europe/Istanbul), 4-digit codes and an intent: status, reschedule, damaged, lost, late or help.
  - `policy.ts` keeps each conversation's slots, asks for what is missing, calls the tool and composes the reply. All wording is in its `REPLIES` table.
  - Tool errors (`404 not_found`, `403 verification_failed`, `409 not_reschedulable`, `400 invalid_date`) get polite answers.
  - With tracking number, date and code, it calls `reschedule_delivery` directly and relays core's 409 or 403. It never reschedules without a code.
  - The replies use the phrases the kervan-voice-evals scenarios check for, such as "in transit", "rescheduled", "verification code", "cannot be rescheduled", "could not find" and the `TCK-` ticket id.
- **LLM agent** (`src/agent/llm.ts`). Uses the same tools through the Anthropic Messages API, with `prompts/system.md` as the system prompt. The tests never run it.
- **Prompt and policy** (`prompts/system.md`). This is both the LLM prompt and the readable statement of the policy; keep it in step with `policy.ts`.
- **Logs** (`src/log.ts`). JSON lines with `service: "voice"`. They record intents, tool names, statuses and tracking numbers. They never record utterances, personal data or tokens.

## Development

```sh
npm ci
npm run typecheck
npm run build
npm test
npm start            # after a build
```

The tests start a fake authorization server and a fake MCP server built with the SDK's `McpServer`. The fake auth server fetches the agent's metadata document and verifies the assertion against it. The tests run scripted dialogs end to end against both. They need no network.

`test/eval-scenarios/` mirrors `kervan-voice-evals/scenarios/`. The fake MCP server is seeded like the staging data those scenarios assume. `test/scenarios.test.ts` replays every scenario with the evals' deterministic checks. When a sibling `../kervan-voice-evals` checkout exists, the same test also fails if the mirror has drifted from it.

## Docker

```sh
docker build -t kervan-voice .
docker build --target test .        # runs the tests inside the build, without network
docker run -p 7000:7000 kervan-voice
```

Dependencies are installed by `npm ci --ignore-scripts` from the lock file only. Compiling and testing run in `RUN --network=none` steps (SPEC §11). The image runs as the non-root user `node`.
