# Production Deployment for Plan Collab

## Motivation
Nexolab OpenSpec currently runs as a local Docker Compose stack suited only for development. To serve real teams, it must be deployed on a hardened, internet-accessible infrastructure that delivers secure HTTPS access, persistent and backed-up data, real-time collaborative editing via Yjs, LLM-driven planning via a LiteLLM proxy, and production-grade notifications — all without introducing unnecessary operational complexity. The intake answers identify AWS (EKS + RDS), Nginx + Let's Encrypt, AWS Secrets Manager, and a full observability stack (CloudWatch, OpenTelemetry, Sentry) as the target environment.

## Proposed Change

### Infrastructure
- **Kubernetes on EKS** — deploy backend and frontend as separate `Deployment` workloads with `HorizontalPodAutoscaler` and liveness/readiness probes mirroring the existing Docker Compose `healthcheck` definitions.
- **Nginx Ingress + Cert-Manager (Let's Encrypt)** — terminate HTTPS at the cluster edge; proxy `/api`, `/ws` (Yjs), and static frontend paths appropriately.
- **Amazon RDS for PostgreSQL 16** — replace the dev `postgres` container; retain the existing `db-migrate` pattern (`backend/src/migrate.ts`) as a Kubernetes `Job` run pre-deploy.
- **Persistent Volumes (EBS)** — back the `/data/repos`, `/data/worktrees`, `/data/snapshots`, and `/data/user-credentials` volume mounts that the backend already declares in `docker-compose.yml`.
- **Automated daily RDS snapshots** — via AWS-native automated backup retention; no additional tooling required.

### Secret Management
- All sensitive values (`DATABASE_URL`, `SESSION_SECRET`, `SMTP_URL`, `GIT_TOKEN`, `LITELLM_API_KEY`, etc. from `.env.example`) stored in **AWS Secrets Manager**; injected into pods via the AWS Secrets Store CSI Driver as environment variables, matching the exact env-var names the application already reads.

### Application Services
- **Backend** — existing `backend/Dockerfile` promoted to production image; `NODE_ENV=production`, `REVIEWER_MODE=real`; LLM wired to the team's LiteLLM VPN base URL + API key via `LITELLM_BASE_URL` / `LITELLM_API_KEY`.
- **Frontend** — existing `frontend/Dockerfile` (Nginx static build) deployed as a separate pod behind the Ingress.
- **Yjs WebSocket** — `backend/src/yjs/server.ts` exposed through a dedicated Ingress path with WebSocket upgrade support.
- **GitHub integration** — fine-grained Personal Access Token stored in Secrets Manager; injected as `GIT_TOKEN`, consumed by `backend/src/git/askpass.sh` — no code changes required.
- **Production SMTP** — `SMTP_URL` set to the team's production mail provider DSN; `mailhog` service not deployed.

### Observability
- **Structured JSON logging** — `NODE_ENV=production` already switches the app to stdout JSON; logs shipped to **CloudWatch Logs** via the Fluent Bit DaemonSet.
- **Health-check alerting** — CloudWatch Alarms on EKS pod restarts + RDS `FreeStorageSpace` / `DatabaseConnections` metrics; SNS → email/Slack.
- **Distributed tracing** — OpenTelemetry Collector sidecar; traces exported to an OTLP-compatible backend (e.g., AWS X-Ray or Grafana Tempo).
- **Error tracking** — Sentry DSN injected as `SENTRY_DSN`; Sentry SDK added to backend and frontend builds.

### CI/CD
- GitHub Actions workflow: build & push Docker images to ECR → run `db-migrate` Job → rolling `kubectl rollout` update.

## Success Criteria
1. **HTTPS reachability** — the application is accessible at the production domain over TLS 1.2+; Let's Encrypt certificate auto-renews without manual intervention.
2. **Data persistence & backups** — all PostgreSQL data survives a pod or node restart; automated daily RDS snapshots are retained for ≥ 7 days and a restore has been verified.
3. **LLM integration functional** — an end-to-end planning run completes successfully through the LiteLLM VPN proxy with `REVIEWER_MODE=real`.
4. **GitHub commit flow works** — a finished planning stage triggers a `PLAN.md` commit to the target repo via the GitHub PAT with zero plaintext token exposure in logs or process arguments.
5. **Real-time collaboration** — two simultaneous browser sessions show live Yjs document sync with no WebSocket errors in production.
6. **Observability active** — structured logs appear in CloudWatch, at least one Sentry error event is captured end-to-end in staging, and an OpenTelemetry trace is visible for a planning-stage request.

## Out of Scope
- **Multi-region / disaster-recovery failover** — single-region EKS deployment only; cross-region replication is deferred.
- **Auto-scaling based on LLM queue depth** — HPA scales on CPU/memory only; custom-metrics autoscaling is not included in this release.
- **GitLab integration** — `backend/src/git/providers/gitlab.ts` exists but production secret management and testing for GitLab tokens are deferred.
- **Self-hosted LiteLLM deployment** — the LiteLLM proxy itself is assumed to exist and be reachable via VPN; provisioning or managing it is out of scope.
- **Blue/green or canary deployments** — initial rollout uses a simple rolling update strategy; advanced deployment patterns are deferred.
