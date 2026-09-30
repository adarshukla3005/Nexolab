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
