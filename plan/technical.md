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
