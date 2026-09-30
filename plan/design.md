# Design — Deployment for Nexolab Platform

## Architecture Overview

The Nexolab platform is a containerized Node.js/TypeScript backend (Fastify + PostgreSQL + Yjs) with a static frontend, already Dockerized for local development. The production deployment extends this with AWS managed services: **ECS Fargate** hosts the backend and frontend containers, **Application Load Balancer** terminates SSL and routes traffic, **RDS PostgreSQL** replaces the local database, and **EFS** provides shared persistent storage for Git repositories (`/data/repos`), feature worktrees (`/data/worktrees`), and Yjs snapshots (`/data/snapshots`). The backend's existing LLM client (`src/llm/client.ts`) already uses OpenAI-compatible SDK pointing to a configurable base URL, so LiteLLM integration requires only environment variable configuration.

## Key Decisions

1. **ECS Fargate for compute** — The existing Dockerfiles (`backend/Dockerfile`, `frontend/Dockerfile`) are production-ready; Fargate avoids EC2 management overhead and scales naturally for 50-200 users.
2. **Application Load Balancer with ACM for SSL** — ALB handles HTTPS termination, health checks, and HTTP→HTTPS redirect; ACM provides managed certificates with auto-renewal, eliminating manual SSL maintenance.
3. **AWS EFS for shared storage** — Git operations (`src/git/worker.ts`) and Yjs snapshots (`src/yjs/server.ts`) require persistent, shared file storage across container restarts; EFS mounts at `/data/` provide this without code changes.
4. **AWS Secrets Manager for all credentials** — Secrets (DATABASE_URL, SESSION_SECRET, SMTP_URL, GIT_TOKEN, LITELLM_API_KEY) are injected as environment variables into ECS tasks at startup, keeping them out of code and container images.
5. **RDS PostgreSQL with automated backups** — The existing migration system (`src/migrate.ts` using node-pg-migrate) runs on container startup; RDS provides 7-day automated backups, point-in-time recovery, and Multi-AZ availability.
6. **LiteLLM via environment variables only** — The LLM client (`src/llm/client.ts`) already supports configurable `LITELLM_BASE_URL`, `LITELLM_API_KEY`, and `LITELLM_MODEL`; no code changes are needed for Bedrock integration.

## Module Boundaries

### Existing Modules (No Code Changes)

- **`backend/src/index.ts`** — Entry point already listens on `:4000`, runs migrations on startup, and resets orphaned stage runs; production deployment uses these as-is.
- **`backend/src/db.ts`** — PostgreSQL connection pool reads `DATABASE_URL`; works unchanged with RDS connection string.
- **`backend/src/migrate.ts`** — Runs existing 5 migrations from `backend/migrations/` directory; no modifications needed.
- **`backend/src/llm/client.ts`** — Already reads `LITELLM_BASE_URL`, `LITELLM_API_KEY`, and `LITELLM_MODEL` environment variables; supports OpenAI-compatible endpoints.
- **`backend/src/yjs/server.ts`** — Reads `SNAPSHOTS_DIR` (defaults to `/data/snapshots`); EFS mount provides persistence.
- **`backend/src/git/worker.ts`** — Reads `REPOS_BASE` (defaults to `/data/repos`) and `WORKTREES_BASE` (defaults to `/data/worktrees`); EFS mount provides persistence.
- **`backend/src/auth/mail.ts`** — Reads `SMTP_URL` for email delivery; production SMTP credentials replace local Mailpit.
- **`backend/Dockerfile`** — Already production-ready with multi-stage build, Git installation, and health checks; used as-is by ECS.
- **`frontend/Dockerfile`** — Serves static build; used as-is by ECS frontend service.

### New Infrastructure Modules (Outside Codebase)

- **Terraform/CloudFormation IaC** — Provisions VPC, subnets, security groups, ALB, ECS cluster, Fargate services, RDS instance, EFS file system, Secrets Manager secrets, and CloudWatch log groups.
- **ECS Task Definitions** — Define backend and frontend containers with environment variables from Secrets Manager, EFS volume mounts, resource limits (1 vCPU / 2 GB RAM for backend, 0.25 vCPU / 0.5 GB RAM for frontend), and health check configuration.
- **ALB Target Groups & Listeners** — HTTPS listener (port 443) forwards to backend `:4000` and frontend `:80` based on path rules; HTTP listener (port 80) redirects to HTTPS.
- **Security Groups** — ALB allows inbound 80/443 from `0.0.0.0/0`; backend allows inbound 4000 from ALB SG; frontend allows inbound 80 from ALB SG; RDS allows inbound 5432 from backend SG; EFS allows inbound NFS (2049) from backend SG.
- **IAM Roles** — ECS task execution role reads secrets from Secrets Manager; ECS task role allows CloudWatch log writes and EFS mounts.

## External Dependencies

### Infrastructure Dependencies

- **AWS ECS Fargate** — Container orchestration (no version, managed service)
- **AWS Application Load Balancer** — HTTPS termination and routing (Application Load Balancer v2)
- **AWS RDS PostgreSQL 16** — Managed database with automated backups (db.t4g.medium instance class)
- **AWS EFS** — NFS v4.1 shared file system for persistent storage (general-purpose performance mode)
- **AWS Secrets Manager** — Credential storage and injection
- **AWS Certificate Manager (ACM)** — SSL certificate provisioning and renewal
- **AWS CloudWatch Logs** — Application and container log aggregation

### Application Dependencies (Already in package.json)

- **`fastify` ^4.x** — Web framework
- **`pg` ^8.x** — PostgreSQL client library
- **`node-pg-migrate` ^7.x** — Database migration tool
- **`openai` ^4.x** — LLM client SDK (OpenAI-compatible, used with LiteLLM)
- **`yjs` ^13.x** — CRDT library for real-time collaboration
- **`ws` ^8.x** — WebSocket server for Yjs connections
- **`nodemailer` ^6.x** — SMTP client for email notifications

### External Services

- **LiteLLM Proxy** — Must be deployed separately or use AWS Bedrock runtime directly; backend expects an OpenAI-compatible endpoint at `LITELLM_BASE_URL` configured to proxy AWS Bedrock Claude models.
- **GitHub API** — Backend commits `PLAN.md` via Git push using `GIT_TOKEN` (fine-grained PAT with `contents: write` permission).
- **SMTP Server** — Production email relay (e.g., AWS SES SMTP, SendGrid) for magic-link authentication and notifications.

## Trade-offs & Risks

**EFS Performance for Git Operations**: EFS general-purpose mode provides baseline throughput that may introduce latency for large repository clones or frequent worktree operations compared to local SSD. Mitigation: Use EFS provisioned throughput or bursting credits; monitor CloudWatch EFS metrics for throttling. Alternative (rejected): EBS volumes require sticky task placement and don't support multi-container access needed for horizontal scaling.

**Single-region Deployment**: All infrastructure resides in one AWS region; regional outage causes full downtime. Mitigation: RDS automated backups and EFS replication enable recovery within hours. Alternative (rejected): Multi-region active-active architecture adds significant complexity and cost, exceeding requirements for 50-200 users.

**Stateful Container Restarts**: Backend containers reset in-flight stage runs to `pending` on startup and resume asynchronously; rapid restarts during deployments may cause duplicate LLM calls or lost progress. Mitigation: Existing idempotency in `orchestrator/runner.ts` prevents duplicate artifact creation; use ECS rolling deployments with health checks to avoid cascading restarts. Alternative (rejected): External job queue (SQS) adds infrastructure complexity without clear benefit for current scale.

**LiteLLM External Dependency**: Backend expects a pre-configured LiteLLM proxy endpoint; if this service is unavailable or misconfigured, all AI features fail. Mitigation: Deploy LiteLLM as a separate ECS Fargate service in the same VPC with health checks, or use AWS Bedrock runtime API directly (requires forking `llm/client.ts` for AWS SDK). Alternative (rejected): Embedding LiteLLM in the backend container couples deployment and increases container size.
