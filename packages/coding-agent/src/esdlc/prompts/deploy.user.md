Write the deployment document for this project based on the facts below.
Do not invent infrastructure that the facts do not show; where something is unknown, add it to "Prerequisites to confirm".

Every factual claim must cite the file it came from, in the form `(evidence: <path>)`. Commands
must be copy-pasteable as written and must only use tooling the facts show. When a config file
exists (container image, compose stack, CI pipeline, helm chart), write the actual steps that go
with it instead of generic advice, and say which file drives each step.

Required sections:
1. Deployment overview (artifacts, runtime, topology as far as the facts show)
2. Prerequisites (toolchain, registry, credentials, network paths)
3. Build and packaging steps (exact commands)
4. Configuration (required settings and environment variables, with meaning)
5. Deployment steps (exact commands, expected output per step)
6. Verification after deployment
7. Rollback procedure
8. Operational notes (logs, metrics, retention, quotas)
9. Prerequisites to confirm

Repository facts:
---
{{facts}}
---
