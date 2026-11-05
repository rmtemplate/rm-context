---
name: devops-infrastructure
description: Infrastructure & DevOps playbook for RM Context — infrastructure assessment, deployment architecture, Docker, CI/CD, environments, network and reverse proxy, observability, backup/DR, security hardening, runbooks, rollback plans and incident reports, without ever exposing secrets.
user-invocable: false
---

# DevOps & Infrastructure Playbook

Follow the `team-workflows` contract.

## Secret handling (stricter than for other roles)
- Never open `.env`, `.env.<environment>`, key files, kubeconfigs, tfstate/tfvars or credential files. The scanner already excludes them.
- From env templates (`.env.example`) and compose/CI files, record **variable names and where they are set**, never values.
- Refer to secrets by **location and name** ("`DATABASE_URL` from GitHub Actions secret `PROD_DB_URL`"), never by content.
- If you encounter a committed secret, report its **file and line only**, recommend rotation, and never repeat the value.

## Assessment procedure
1. `rmc find service`, `rmc graph node "service:…"`. Generated inventory: `rmc doc new infrastructure-design` prefills services, containers, networks and pipelines with evidence.
2. Read the Dockerfiles, compose files, CI workflows, Kubernetes manifests, Terraform and proxy config the scanner found.
3. Assess:
   - build reproducibility (pinned base images, lockfiles)
   - image hygiene (multi-stage, non-root user)
   - health checks, resource limits and restart policy
   - network exposure (published ports, TLS termination)
   - CI gates (tests, lint, security scan)
   - deployment strategy and rollback
   - backups (existence, frequency, restore tested)
   - observability (logs, metrics, alerts)
   - single points of failure
   - cost drivers
4. Separate **existing (with evidence)** from **proposed**, and **unknown** (Open Question). A security control you cannot verify is `Unknown`, never `Pass`.

## Deliverables → template types
| Deliverable | Type |
|---|---|
| Infrastructure architecture | `infrastructure-design` (prefilled inventory and diagram) |
| Deployment diagram / Docker architecture / network topology | `deployment-architecture` |
| CI/CD pipeline specification | `cicd-spec` (prefilled from CI files) |
| Environment configuration matrix | `env-matrix` (prefilled variable names) |
| Runbook | `runbook` |
| Backup & disaster recovery | `backup-recovery` |
| Monitoring & alerting | `monitoring` |
| Security hardening checklist | `security-checklist` |
| Deployment checklist / rollback plan | `deployment-checklist` / `rollback-plan` |
| Incident report | `incident-report` |
| Server inventory | upsert `server` nodes (attrs: role, OS, size, provider; no IPs or credentials unless the user explicitly provides non-sensitive identifiers) |

## Recording in the graph
- `environment` nodes (`ENV-prod`, `ENV-staging`), `server` / `deployment` nodes.
- `service deployed_on server|environment`, `pipeline related_to deployment`, `service depends_on service`.
- Infrastructure risks become `risk` nodes for the PM's RAID log.
