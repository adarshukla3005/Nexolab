# Deployment for Nexolab platform — OpenSpec Plan


---

# Proposal

# Deployment for Nexolab Platform

## Motivation

The Nexolab OpenSpec platform currently runs in a local development environment using Docker Compose. To serve 50-200 concurrent users in production, it requires a secure, scalable AWS deployment with HTTPS access, managed database services, LiteLLM integration via AWS Bedrock Claude models, persistent storage for Git repositories and collaboration data, email notifications via production SMTP, and proper secret management. The current architecture is well-suited for containerization but needs production-grade infrastructure, monitoring, and backup strategies to ensure reliability and data integrity.

## Proposed Change

Deploy Nexolab to AWS using managed services: **AWS ECS Fargate** for containerized frontend (nginx) and backend (Node.js) services, **AWS RDS PostgreSQL** for the database with automated backups, **Application Load Balancer** with ACM-managed SSL certificates for HTTPS termination, **AWS EFS** for persistent storage of Git repositories/worktrees/snapshots, **AWS Secrets Manager** for credentials (database passwords, GitHub tokens, SMTP credentials, session secrets), and **CloudWatch** for logging and health monitoring. The LLM integration will use LiteLLM configured to call AWS Bedrock Claude models. The deployment will support Yjs WebSocket connections for real-time collaboration and GitHub integration for committing PLAN.md files. Infrastructure will be kept simple and maintainable without overengineering.

## Success Criteria

1. **HTTPS Production Access**: Users can access the platform via HTTPS with a valid ACM certificate, with HTTP automatically redirecting to HTTPS.
2. **Database Persistence & Backups**: RDS PostgreSQL runs with daily automated backups retained for 7 days, with successful migration of the existing schema (5 migrations).
3. **Persistent Git Storage**: All Git repositories, worktrees, and snapshots persist across container restarts using EFS, maintaining data integrity.
4. **LLM Integration**: Backend successfully invokes AWS Bedrock Claude models via LiteLLM for all 4 OpenSpec stages (proposal, spec, design, technical).
5. **Secure Secret Management**: All sensitive credentials are stored in AWS Secrets Manager and injected into ECS tasks at runtime, with no secrets in environment variables or code.
6. **Operational Monitoring**: CloudWatch logs capture application and container logs with health check endpoints returning successful responses, enabling basic operational visibility.

## Out of Scope

1. **Auto-scaling and advanced load balancing** — initial deployment will use fixed task counts appropriate for 50-200 users; horizontal scaling can be added later if needed.
2. **Custom domain and DNS management** — deployment will use the default ALB DNS name; custom domain setup is deferred to post-deployment configuration.
3. **Multi-region deployment or disaster recovery** — deployment will be single-region; cross-region replication and failover strategies are deferred.
4. **Advanced monitoring dashboards and alerting** — beyond basic CloudWatch logs and health checks, custom metrics, alarms, and dashboards are out of scope.
5. **CI/CD pipeline automation** — initial deployment will be manual or use basic scripts; full GitHub Actions or CodePipeline automation is deferred to a future iteration.

---

# Spec

# Spec — Deployment for Nexolab Platform

## Behaviors

- Users access the Nexolab platform via HTTPS with a valid SSL certificate, and HTTP requests automatically redirect to HTTPS.
- The backend service connects to AWS RDS PostgreSQL and successfully runs all 5 existing database migrations on first deployment.
- All Git repositories, worktrees, and snapshots persist across backend container restarts using EFS shared storage.
- The backend invokes AWS Bedrock Claude models via LiteLLM for all orchestrator stages (proposal, spec, design, technical).
- WebSocket connections for Yjs real-time collaboration remain stable and persist document state to EFS snapshots.
- The backend commits `PLAN.md` files to GitHub repositories using GitHub tokens stored in AWS Secrets Manager.
- Magic-link authentication emails are sent via production SMTP configured through AWS Secrets Manager.
- Application logs from frontend and backend containers stream to CloudWatch Logs for operational visibility.
- Health check endpoints (`/health`) return successful responses and are used by the load balancer for traffic routing.
- Database backups run automatically daily and retain snapshots for 7 days.
- Backend containers can be restarted or redeployed without data loss, resuming any pending stage runs automatically.

## APIs / Data Changes

### Infrastructure Endpoints

**Application Load Balancer**
- **HTTPS Listener (port 443)**: Terminates SSL using ACM certificate, forwards to backend target group on port 4000 and frontend target group on port 80.
- **HTTP Listener (port 80)**: Redirects all traffic to HTTPS (301).
- **Health Check Target**: `GET /health` on backend (port 4000), expects 200 response.

**Backend Service (ECS Fargate)**
- **Port**: 4000 (internal)
- **Health Endpoint**: `GET /health` → `{ "ok": true }`
- **Environment Variables** (from AWS Secrets Manager):
  - `DATABASE_URL`: PostgreSQL connection string (RDS endpoint, username, password, database name)
  - `SESSION_SECRET`: 32-byte hex secret for session signing
  - `SMTP_URL`: Production SMTP DSN (e.g., `smtp://user:pass@smtp.example.com:587`)
  - `PUBLIC_BASE_URL`: HTTPS base URL of the deployed application
  - `GIT_TOKEN`: GitHub personal access token (fine-grained with `contents: read+write`)
  - `LITELLM_BASE_URL`: LiteLLM endpoint URL configured for AWS Bedrock
  - `LITELLM_API_KEY`: API key or AWS credentials for LiteLLM/Bedrock access
  - `LITELLM_MODEL`: Model identifier (e.g., `anthropic.claude-3-sonnet-20240229-v1:0`)
  - `REVIEWER_MODE`: `stub` or `real`
  - `NODE_ENV`: `production`
- **Mounted Volumes** (EFS):
  - `/data/repos`: Bare Git clones
  - `/data/worktrees`: Feature worktrees
  - `/data/snapshots`: Yjs document snapshots
  - `/data/user-credentials`: User-scoped Git credentials (optional future use)

**Frontend Service (ECS Fargate)**
- **Port**: 80 (internal, serves static files via a lightweight HTTP server built into the container)
- **Health Check**: HTTP GET on port 80, path `/` expects 200-399 response.
- **Note**: The frontend container runs the built application (e.g., Vite build output) using a minimal static file server; no nginx or external web server is required.

### Database (AWS RDS PostgreSQL)

**Connection Parameters**
- **Engine**: PostgreSQL 16
- **Instance Class**: db.t4g.medium or equivalent (suitable for 50-200 users)
- **Storage**: 20 GB gp3, auto-scaling enabled
- **Multi-AZ**: Optional (not required for initial deployment but recommended)
- **Backup Retention**: 7 days
- **Backup Window**: Automated daily backups
- **Security Group**: Allow inbound PostgreSQL (port 5432) from backend ECS security group only

**Schema**: No schema changes. Existing 5 migrations will be applied:
1. `001_initial_schema.js` — users, sessions, repos, features, blocks, artifacts, stage_runs, etc.
2. `002_password_auth.js` — password authentication fields
3. `003_feature_approvals.js` — approval workflows
4. `004_chat_messages.js` — chat/discussion messages
5. `005_artifact_versions.js` — artifact versioning

### Persistent Storage (AWS EFS)

**Mount Targets**
- Created in each availability zone used by ECS tasks
- **Access Point** (optional): Dedicated root directory for application data
- **Security Group**: Allow inbound NFS (port 2049) from backend ECS security group

**Directory Structure** (as per docker-compose volumes):
- `/repos`: Bare Git repositories
- `/worktrees`: Feature-specific Git worktrees
- `/snapshots`: Yjs document snapshots (`.ydoc` files)
- `/user-credentials`: User-scoped credentials (currently unused but reserved)

### Secret Management (AWS Secrets Manager)

**Secret Structure** (single secret JSON or multiple secrets):
- `DATABASE_URL`
- `SESSION_SECRET`
- `SMTP_URL`
- `PUBLIC_BASE_URL`
- `GIT_TOKEN`
- `LITELLM_BASE_URL`
- `LITELLM_API_KEY`
- `LITELLM_MODEL`

Each secret value is injected into ECS task environment variables at runtime.

## Acceptance Criteria

### AC1: HTTPS Access and SSL Termination

**Given** the platform is deployed to AWS ECS with an Application Load Balancer and ACM certificate  
**When** a user navigates to the HTTP URL (e.g., `http://<alb-dns-name>`)  
**Then** the request is redirected to HTTPS with a 301 status code  
**And** the HTTPS endpoint serves the frontend with a valid SSL certificate  
**And** the browser shows a secure connection (no certificate warnings)

### AC2: Database Persistence and Migrations

**Given** the backend ECS service is configured with `DATABASE_URL` pointing to RDS PostgreSQL  
**When** the backend container starts for the first time  
**Then** all 5 migrations execute successfully in order  
**And** tables `users`, `sessions`, `repos`, `features`, `blocks`, `artifacts`, `stage_runs`, `gates`, `chat_messages`, `artifact_versions`, and related indexes are created  
**And** subsequent backend restarts do not re-run migrations (idempotent migration logic)  
**And** data written to the database persists across backend container restarts

### AC3: Persistent Git Storage

**Given** the backend ECS service mounts EFS at `/data/repos`, `/data/worktrees`, and `/data/snapshots`  
**When** a user creates a feature linked to a GitHub repository  
**Then** the bare clone is saved to `/data/repos/<repo-hash>/`  
**And** the feature worktree is created in `/data/worktrees/<feature-id>/`  
**And** when the backend container is stopped and restarted  
**Then** the Git repositories and worktrees are still present and accessible  
**And** no re-cloning occurs (the existing bare clone is reused)

### AC4: LLM Integration via AWS Bedrock

**Given** the backend is configured with `LITELLM_BASE_URL` and `LITELLM_API_KEY` for AWS Bedrock  
**When** a user triggers the "proposal" stage for a new feature  
**Then** the backend sends a request to AWS Bedrock Claude model via LiteLLM  
**And** the response is received and parsed correctly  
**And** the proposal artifact is created and saved to the database  
**And** the same flow succeeds for "spec", "design", and "technical" stages

### AC5: Secure Secret Management

**Given** all secrets are stored in AWS Secrets Manager  
**When** the ECS task is launched  
**Then** environment variables (`DATABASE_URL`, `SESSION_SECRET`, `SMTP_URL`, `GIT_TOKEN`, `LITELLM_API_KEY`) are populated from Secrets Manager  
**And** no secrets appear in ECS task definitions, CloudWatch logs, or application code  
**And** the backend successfully connects to RDS using the injected `DATABASE_URL`  
**And** magic-link emails are sent using the injected `SMTP_URL`  
**And** GitHub commits succeed using the injected `GIT_TOKEN`

### AC6: Real-Time Collaboration (Yjs WebSockets)

**Given** the backend supports WebSocket connections at `/yjs/:featureId`  
**When** two users open the same feature workspace in their browsers  
**Then** both users' WebSocket connections are established to the backend ECS service  
**And** edits made by one user appear in real-time for the other user  
**And** Yjs snapshots are persisted to EFS `/data/snapshots/<feature-id>.ydoc`  
**And** when the backend container restarts, the document state is restored from the snapshot

### AC7: Health Checks and Operational Monitoring

**Given** the backend exposes a health endpoint at `GET /health`  
**When** the ALB performs a health check  
**Then** the endpoint returns `{ "ok": true }` with a 200 status code  
**And** the ALB marks the backend target as healthy  
**And** when the backend is unhealthy or crashes, the ALB stops routing traffic to that task  
**And** all backend and frontend container logs are streamed to CloudWatch Logs  
**And** operators can view logs via the AWS Console or CLI

### AC8: Automated Database Backups

**Given** RDS is configured with automated backups and 7-day retention  
**When** 24 hours elapse after initial deployment  
**Then** a database snapshot is created automatically by AWS  
**And** the snapshot is retained for 7 days  
**And** older snapshots are automatically deleted after 7 days  
**And** the database can be restored from any snapshot within the retention window

### AC9: Stateless Backend Restart and Stage Resumption

**Given** the backend ECS service is running with several features in "running" stage status  
**When** the backend container is forcibly stopped (e.g., deployment, crash, manual stop)  
**And** a new backend container starts  
**Then** the backend resets all "running" stage_runs to "pending" status  
**And** automatically resumes execution of all pending stage runs  
**And** no stage executions are lost or duplicated

## Non-Functional Requirements

### Performance
- The application must support **50-200 concurrent users** without degradation in response times (target: API response < 1s for non-LLM requests, < 45s for LLM orchestrator calls).
- WebSocket connections for Yjs collaboration must handle at least 10 concurrent editors per feature with sub-500ms latency for updates.
- Database queries must complete within 200ms for typical read operations (feature lists, artifact retrieval).

### Security
- All secrets (database credentials, API keys, GitHub tokens, SMTP passwords) must be stored in **AWS Secrets Manager** and injected at runtime; no secrets in environment variables, task definitions, or source code.
- Network traffic must use **HTTPS only** for external access; HTTP requests must redirect to HTTPS.
- RDS database must be accessible **only from the backend ECS security group** (no public internet access).
- EFS must be accessible **only from the backend ECS security group** (no public internet access).
- GitHub tokens must use **fine-grained permissions** (`contents: read+write` on specific repositories only).
- Session tokens must use cryptographically secure secrets (`SESSION_SECRET` with at least 32 bytes of entropy).

### Reliability
- **Automated daily backups** for RDS with 7-day retention enable point-in-time recovery.
- **Health checks** on backend services ensure the load balancer routes traffic only to healthy tasks.
- **Persistent storage via EFS** ensures Git repositories, worktrees, and Yjs snapshots survive container rest

---

# Design

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

---

# Technical

# Technical Tasks — Deployment for Nexolab platform

## Implementation Tasks

1. Create `infrastructure/vpc.tf` defining AWS VPC with public subnets in 2+ availability zones, internet gateway, route tables, and security groups for ALB (443/80 ingress) and ECS tasks (4000 ingress from ALB only).

2. Create `infrastructure/rds.tf` defining AWS RDS PostgreSQL 15+ instance in private subnets with `db.t3.micro` or `db.t4g.micro`, automated backups enabled (7-day retention), encryption at rest, and security group allowing 5432 ingress from ECS security group only.

3. Create `infrastructure/efs.tf` defining AWS EFS file system with mount targets in each private subnet, encryption at rest enabled, and security group allowing NFS (2049) ingress from ECS security group for persistent volumes (`/data/repos`, `/data/worktrees`, `/data/snapshots`, `/data/user-credentials`).

4. Create `infrastructure/secrets.tf` defining AWS Secrets Manager secrets for `SESSION_SECRET`, `GIT_TOKEN`, `LITELLM_API_KEY`, and `DATABASE_URL` with placeholder values (actual values set manually post-apply).

5. Create `infrastructure/alb.tf` defining Application Load Balancer in public subnets with HTTPS listener (port 443) using ACM certificate, HTTP listener (port 80) redirecting to HTTPS, target groups for backend (4000) and frontend (80) with health check paths `/health` and `/` respectively.

6. Create `infrastructure/acm.tf` defining AWS Certificate Manager certificate for the production domain with DNS validation records (requires manual DNS CNAME creation in Route 53 or external DNS provider).

7. Create `infrastructure/ecr.tf` defining two ECR repositories (`nexolab-backend` and `nexolab-frontend`) with image scanning enabled and lifecycle policy to retain last 10 images.

8. Create `infrastructure/ecs-cluster.tf` defining ECS Fargate cluster with CloudWatch Container Insights enabled.

9. Create `infrastructure/ecs-backend.tf` defining ECS task definition for backend (512 CPU, 1024 MiB memory, logs to CloudWatch `/ecs/nexolab-backend`) with environment variables from Secrets Manager, EFS volume mounts, and ECS service with 2 desired tasks, ALB target group attachment, and deployment circuit breaker.

10. Create `infrastructure/ecs-frontend.tf` defining ECS task definition for frontend (256 CPU, 512 MiB memory, logs to CloudWatch `/ecs/nexolab-frontend`) with ECS service with 2 desired tasks and ALB target group attachment.

11. Create `infrastructure/cloudwatch.tf` defining CloudWatch log groups for backend and frontend with 14-day retention, and CloudWatch alarms for RDS CPU > 80%, ECS service unhealthy task count > 0, and ALB 5xx error rate > 5%.

12. Create `infrastructure/iam.tf` defining IAM roles and policies for ECS task execution (ECR pull, Secrets Manager read, CloudWatch Logs write) and ECS task (Secrets Manager read, EFS mount).

13. Create `infrastructure/outputs.tf` exposing ALB DNS name, RDS endpoint, EFS file system ID, and ECR repository URIs as Terraform outputs.

14. Create `infrastructure/variables.tf` defining input variables for `aws_region`, `environment`, `domain_name`, `db_instance_class`, `backend_cpu`, `backend_memory`, `frontend_cpu`, `frontend_memory` with sensible defaults.

15. Create `infrastructure/terraform.tfvars.example` with example values for all variables and comments explaining each.

16. Create `.github/workflows/deploy.yml` defining GitHub Actions workflow triggered on push to `main` branch that builds backend and frontend Docker images, pushes to ECR, updates ECS services with new task definitions, and waits for stable deployment.

17. Update `backend/Dockerfile` to add `HEALTHCHECK` instruction running `curl -sf http://localhost:4000/health || exit 1` every 30s.

18. Update `frontend/nginx.conf` (create if missing) to proxy `/api/*` and `/yjs/*` requests to backend ALB target group via environment variable `BACKEND_URL` substituted at container start, and serve frontend static files for all other paths.

19. Create `scripts/build-and-push.sh` shell script that builds backend and frontend images, tags with Git commit SHA and `latest`, and pushes to ECR (used by CI/CD and manual deploys).

20. Create `scripts/deploy-ecs.sh` shell script that registers new ECS task definitions with the latest ECR image tags and updates ECS services, waiting for deployment to stabilize.

21. Create `scripts/set-secrets.sh` shell script (run once manually) that prompts for `SESSION_SECRET`, `GIT_TOKEN`, `LITELLM_API_KEY`, and `SMTP_URL`, then writes them to AWS Secrets Manager using AWS CLI.

22. Create `scripts/db-tunnel.sh` shell script that establishes SSM Session Manager port-forward tunnel to RDS instance for emergency database access (requires `aws-cli` and `session-manager-plugin`).

23. Update `backend/src/index.ts` to log `process.env.NODE_ENV`, `process.env.PUBLIC_BASE_URL`, and database connection status on startup for production troubleshooting.

24. Update `backend/src/llm/client.ts` to validate `LITELLM_BASE_URL` points to AWS Bedrock-compatible endpoint (LiteLLM proxy forwarding to Bedrock Claude) and log model name on first call.

25. Create `docs/DEPLOYMENT.md` documenting step-by-step production deployment: prerequisites (AWS account, Terraform, Docker, AWS CLI), infrastructure provisioning, secrets setup, DNS configuration, ECR push, ECS deployment, smoke tests, and monitoring dashboard URLs.

26. Create `docs/RUNBOOK.md` documenting common production operations: viewing logs (CloudWatch Logs Insights queries), scaling ECS services, rolling back deployments, forcing new ECS deployment, database backups/restores, and SSH/tunnel access patterns.

27. Update `.env.example` to include production-oriented comments for `DATABASE_URL` (RDS endpoint format), `SMTP_URL` (AWS SES SMTP endpoint format), `PUBLIC_BASE_URL` (HTTPS ALB URL), and `LITELLM_BASE_URL` (LiteLLM proxy on Bedrock).

28. Create `infrastructure/ses.tf` (optional, if using AWS SES for email) defining SES SMTP credentials, verified domain, and IAM user with `ses:SendRawEmail` permission.

## Tests to Add

1. **Integration test:** `backend/test/health.test.ts` — verify `GET /health` returns `{ ok: true }` with 200 status (acceptance: health check endpoint responds correctly).

2. **Integration test:** `backend/test/db-connection.test.ts` — verify `pool.query('SELECT 1')` succeeds and migrations table exists (acceptance: database connectivity is validated on startup).

3. **Integration test:** `backend/test/secrets.test.ts` — mock Secrets Manager SDK calls and verify backend reads `SESSION_SECRET` and `LITELLM_API_KEY` from environment without failing (acceptance: secrets are loaded from Secrets Manager).

4. **E2E test:** `e2e/https-redirect.test.ts` — HTTP request to ALB port 80 returns 301 redirect to HTTPS (acceptance: HTTP redirects to HTTPS).

5. **E2E test:** `e2e/ssl-cert.test.ts` — HTTPS request to ALB verifies valid SSL certificate with correct CN (acceptance: SSL certificate is valid and trusted).

6. **E2E test:** `e2e/websocket.test.ts` — WebSocket connection to `wss://<domain>/yjs/<featureId>` with auth cookie succeeds and receives sync message (acceptance: WebSocket connections work over HTTPS/WSS).

7. **E2E test:** `e2e/git-commit.test.ts` — create feature, approve stages, verify `PLAN.md` committed to GitHub repo (acceptance: Git integration commits to remote repository).

8. **Load test:** `load/concurrent-users.js` (k6 script) — simulate 100 concurrent users editing features via Yjs WebSocket for 5 minutes, assert p95 latency < 500ms and error rate < 1% (acceptance: platform handles 50-200 concurrent users).

9. **Infrastructure test:** `infrastructure/test/terraform-validate.sh` — run `terraform init`, `terraform validate`, and `terraform plan` in CI to catch configuration errors (acceptance: Terraform configuration is valid).

10. **Smoke test:** `scripts/smoke-test.sh` — after deployment, curl `/health`, create test user via API, create test feature, verify response codes 200 (acceptance: production deployment serves traffic correctly).

## Deployment Notes

- **Environment Variables (set in ECS task definition from Secrets Manager):**
  - `DATABASE_URL`: RDS PostgreSQL connection string (format: `postgresql://USER:PASS@RDS_ENDPOINT:5432/nexolab`)
  - `SESSION_SECRET`: 32-byte hex string (generate with `openssl rand -hex 32`)
  - `SMTP_URL`: AWS SES SMTP endpoint or external SMTP provider (format: `smtps://USERNAME:PASSWORD@email-smtp.us-east-1.amazonaws.com:465`)
  - `PUBLIC_BASE_URL`: HTTPS URL of ALB (format: `https://nexolab.example.com`)
  - `GIT_TOKEN`: GitHub PAT with `contents: write` on target repository
  - `LITELLM_BASE_URL`: LiteLLM proxy endpoint forwarding to AWS Bedrock (format: `https://litellm-proxy.example.com`)
  - `LITELLM_API_KEY`: API key for LiteLLM proxy
  - `LITELLM_MODEL`: Bedrock Claude model ID (e.g., `anthropic.claude-3-5-sonnet-20241022-v2:0`)
  - `REVIEWER_MODE`: `real` for production
  - `NODE_ENV`: `production`
  - `SNAPSHOTS_DIR`: `/data/snapshots` (EFS mount)

- **Persistent Storage:** EFS volumes mounted at `/data` in backend container persist Git repositories, worktrees, Yjs snapshots, and user credentials across container restarts.

- **Database Migrations:** Backend container runs `runMigrations()` on startup (existing code in `backend/src/migrate.ts`). First deployment must wait for RDS instance to be available and migrations to complete (2-3 minutes).

- **DNS Configuration:** After Terraform provisions ACM certificate, manually add CNAME validation records to DNS. After ALB is created, add `A` or `CNAME` record pointing production domain to ALB DNS name.

- **Initial Secrets Setup:** Run `scripts/set-secrets.sh` once before first ECS deployment to populate Secrets Manager. Update secrets by re-running script or using AWS Console/CLI.

- **ECR Image Push:** CI/CD or manual deployment must build images and push to ECR before updating ECS services. Images tagged with Git SHA for traceability.

- **ECS Deployment Strategy:** Rolling deployment with circuit breaker — if new tasks fail health checks, ECS automatically rolls back to previous task definition.

- **CloudWatch Alarms:** Configure SNS topic and email subscription for alarm notifications (not included in Terraform — requires manual setup or extend `infrastructure/cloudwatch.tf`).

- **Backup Validation:** RDS automated backups run daily during maintenance window (default: 3-5 AM UTC). Test restore to new RDS instance quarterly.

- **Logging:** All backend and frontend logs stream to CloudWatch Logs. Use CloudWatch Logs Insights for querying and debugging.

## Rollback Plan

If the production deployment fails health checks, exhibits high error rates, or causes data corruption:

1. **Immediate Rollback (ECS):** Identify the previous stable ECS task definition revision number from ECS Console → Services → Revisions. Run `aws ecs update-service --cluster nexolab-prod --service nexolab-backend --task-definition nexolab-backend:<PREVIOUS_REVISION>` and repeat for frontend service. Wait 5 minutes for deployment to stabilize and verify health checks pass.

2. **Immediate Rollback (ALB):** If issue is limited to backend or frontend, deregister unhealthy targets from ALB target group via Console or CLI, forcing traffic to remaining healthy tasks.

3. **Database Rollback:** If database migration caused corruption, identify the RDS automated snapshot taken before migration (RDS Console → Snapshots → Automated). Restore snapshot to a new RDS instance, update `DATABASE_URL` in Secrets Manager, force new ECS deployment. Downtime: 10-15 minutes for restore + propagation.

4. **Infrastructure Rollback:** If Terraform changes caused instability, run `terraform apply` with previous Git commit checked out. Alternatively, revert merged PR and re-run CI/CD pipeline. ECS tasks will redeploy with previous configuration within 5 minutes.

5. **Post-Rollback Verification:** After rollback, run smoke test (`scripts/smoke-test.sh`) and verify CloudWatch metrics (ECS healthy task count, ALB 2xx rate, RDS connections) return to baseline. Review CloudWatch Logs for errors during failed deployment window to identify root cause.

6. **Communication:** If user-facing downtime exceeded 5 minutes, post incident summary in team chat with timeline, root cause, and mitigation steps. Schedule post-mortem within 48 hours to prevent recurrence.
