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
