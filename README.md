# Nexolab — OpenSpec

Collaborative feature-planning platform using the **OpenSpec** methodology. A fork of the AI-DLC stack (`../collab-dlc/`) that keeps every UI, auth, sharing, notification and GitHub-commit path identical — only the AI orchestration layer differs.

## Why a separate folder

`collab-dlc/` runs the full 9-stage AI-DLC methodology (~90 LLM calls per feature, 20–40 min end-to-end). `openspec/` runs a **4-stage OpenSpec flow** (~8 LLM calls per feature, 3–5 min end-to-end) driven by a single upfront questionnaire.

## Stages

1. **Proposal** — motivation, proposed change, success criteria, out-of-scope
2. **Spec** — behaviors, APIs, acceptance criteria (Given/When/Then), NFRs
3. **Design** — architecture placement, key decisions, module boundaries, trade-offs
4. **Technical** — file-level implementation tasks, tests to add, deployment notes, rollback plan

After the technical stage passes its validation gate, a combined **PLAN.md** artifact is generated automatically and pushed to the feature's branch when the user hits **Commit plan to branch**.

## Start it

```bash
git clone https://github.com/adarshukla3005/Nexolab.git
cd Nexolab
cp .env.example .env    # then fill in real values (see below)
docker compose up -d
```

Then open **http://localhost:3001**.

### Required env values (in `.env`)

| Var | What to set |
|-----|-------------|
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `GIT_TOKEN` | GitHub PAT with `contents:write` on your target repo |
| `LITELLM_API_KEY` | Anthropic key (`sk-ant-...`) or your OpenAI-compat proxy key |
| `LITELLM_BASE_URL` | `https://api.anthropic.com/v1/` for direct Anthropic |
| `LITELLM_MODEL` | `claude-sonnet-4-5-20250929` for direct Anthropic |
| `SMTP_URL` | Any nodemailer DSN, or leave the mailhog default for local dev |

## Ports (offset from `collab-dlc/` so both stacks can run side-by-side)

| Service   | `collab-dlc/` | `openspec/` |
|-----------|---------------|-------------|
| Postgres  | 5433          | **5434**    |
| Backend   | 4000          | **4001**    |
| Frontend  | 3000          | **3001**    |
| Mailhog SMTP | 1025       | **1026**    |
| Mailhog UI   | 8025       | **8026**    |

## Environment

The app talks to any OpenAI-compatible LLM endpoint. Public deployments should use direct Anthropic:

```
LITELLM_BASE_URL=https://api.anthropic.com/v1/
LITELLM_API_KEY=sk-ant-...
LITELLM_MODEL=claude-sonnet-4-5-20250929
```

Private deployments can point at any LiteLLM proxy instead. Stages are hardcoded in `backend/src/methodology/seeder.ts` — no upstream tarball, no methodology container.

## Where the differences live

| File | What changed vs `collab-dlc/` |
|------|-------------------------------|
| `docker-compose.yml` | Port shift; volumes prefixed; seeder service removed |
| `backend/src/methodology/seeder.ts` | Hardcodes 4 OpenSpec stages instead of fetching the AI-DLC tarball |
| `backend/src/orchestrator/workflow.ts` | 4 stage slugs |
| `backend/src/orchestrator/artifact-contracts.ts` | 4 `openspec-*` markdown contracts |
| `backend/src/orchestrator/stage-materializer.ts` | Injects intake-questionnaire answers; drops AI-DLC verbiage |
| `backend/src/orchestrator/runner.ts` | Parks proposal stage on intake questionnaire; builds PLAN.md after technical stage |
| `backend/src/orchestrator/reviewer.ts` | OpenSpec-shaped review criteria |
| `backend/src/orchestrator/combine-plan.ts` | New — merges 4 artifacts into `openspec-plan` artifact + `PLAN.md` for commit |
| `backend/src/orchestrator/intake-questions.ts` | New — the 6 upfront questions |
| `frontend/src/components/intent/PhaseDiagram.tsx` | 4 stages |

Every other file (auth, git, notify, yjs, durable, routes, all tools under `orchestrator/tools/`) is copied verbatim.
