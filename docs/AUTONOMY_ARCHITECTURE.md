# DAVImth Autonomous Intelligence
## Core Cognitive Architecture

**Status:** Phase 1 architecture baseline. This document is a design specification, not a claim that every capability described below is already implemented.

## 1. Product principles

- **Goal-directed:** translate user outcomes into explicit, testable work.
- **Approval-first:** planning and approval are distinct from execution.
- **Least privilege:** every action receives only the permissions it needs.
- **User isolation:** goals, memory, artifacts, credentials, and runs are scoped to their owner or workspace.
- **Observable and reversible:** users can inspect plans, progress, outputs, and audit history; pause or cancel work where safe.
- **Bounded autonomy:** enforce time, cost, tool, data, and retry limits.
- **Honest status:** never describe planned, approved, queued, or failed work as completed.

## 2. System architecture

1. **Experience layer:** chat, goal workspace, plan review, approvals, progress timeline, artifacts, notifications, and controls.
2. **Identity and policy layer:** authentication, owner/workspace resolution, roles, permission grants, policy evaluation, and consent.
3. **Cognitive orchestration layer:** intent understanding, clarification, planning, dependency analysis, tool selection, evaluation, and replanning.
4. **Capability gateway:** allowlisted tools for research, files, code generation, testing, integrations, and publishing; every call is policy-checked.
5. **Execution layer:** durable queue, bounded workers, leases, retries, cancellation, schedules, and run state.
6. **Memory and knowledge layer:** project facts, preferences, decisions, artifacts, provenance, retention, and user controls.
7. **Operations layer:** audit events, metrics, traces, usage accounting, alerts, abuse controls, and incident handling.

## 3. Goal-to-work pipeline

1. Capture the desired outcome and optional context, deadline, budget, permitted tools, data scope, and prohibited actions.
2. Identify ambiguity and ask focused clarification questions when missing information could materially change the plan.
3. Classify risk and identify actions that require fresh confirmation.
4. Decompose the goal into ordered tasks. Each task includes a stable ID, description, inputs, expected outputs, success criteria, dependencies, risk level, allowed capabilities, and resource limits.
5. Validate the dependency graph and reject cycles, missing inputs, impossible dependencies, or out-of-scope actions.
6. Present the plan with assumptions, expected cost/time where estimable, and clear approval controls.
7. Create versioned, scoped approval grants only after explicit authorization.
8. Execute only through server-side policy checks and the capability gateway.
9. Evaluate outputs against success criteria; retry within limits, request review, or propose a new plan version.
10. Store durable project memory only under the applicable user consent and retention policy.

## 4. Task lifecycle

Expected lifecycle: `draft → awaiting_approval → approved → queued → running → succeeded`.

Additional terminal or intervention states: `rejected`, `blocked`, `failed`, `cancelled`, and `needs_review`.

Approval must bind to the exact task version, permission scope, and relevant inputs. If the task changes materially, its previous approval is invalid and a new review is required. Use idempotency keys for side-effecting operations, bounded retries, dependency checks, and safe cancellation. Replanning creates a new plan version rather than silently rewriting an approved task.

**Current Phase 1 status model:** tasks are planned and persisted per user and can be marked awaiting approval, approved, or rejected. There is no task execution endpoint in Phase 1. Approving a task does not run it.

## 5. Permission and approval model

A grant should specify:
- user and workspace;
- goal, plan version, and task;
- capability and permitted operation;
- allowed resource and data scope;
- maximum spend, usage, duration, and call count;
- expiry, revocation, and applicable policy version.

Require fresh, explicit confirmation immediately before high-impact actions such as purchases, payments, public publishing, sending messages, changing security settings, accessing especially private data, or deleting user data. A broad request such as “finish this project” does not grant these permissions. Never infer consent from silence or a prior unrelated approval.

## 6. Core data entities

Recommended entities: `Goal`, `PlanVersion`, `Task`, `TaskDependency`, `ApprovalGrant`, `ExecutionRun`, `Artifact`, `AuditEvent`, `Schedule`, `MemoryItem`, and `UsageLedger`.

Every record must have server-enforced ownership/workspace scope. Never trust a browser-supplied user ID, task owner, permission decision, or approval state. Validate ownership and authorization on every read and write.

## 7. Secure execution flow

1. Authenticate the caller and validate request schemas.
2. Resolve the owner and load the exact task and plan version.
3. Evaluate policy and verify an unexpired, matching approval grant.
4. Reserve budget and enforce concurrency and rate limits.
5. Enqueue a durable, idempotent run.
6. Worker acquires a lease and rechecks owner, policy, grant, task version, and cancellation state.
7. Invoke tools only through an allowlisted gateway with timeouts, output limits, secret isolation, and data-scope checks.
8. Persist progress and artifacts with owner scope.
9. Evaluate results against success criteria.
10. Finalize state, usage, and audit records; notify the user when appropriate.

Use bounded retries and a dead-letter or human-review path. Do not expose arbitrary shell access, unrestricted code execution, unrestricted URL fetching, or raw secrets to model prompts. Sandboxed code execution, if introduced, must have strict CPU, memory, network, filesystem, and time limits.

## 8. Scheduling and cloud execution

Schedules create bounded runs; they do not bypass task approval, permission expiry, or policy checks. Store an explicit timezone and recurrence rule. Prevent overlapping duplicate runs unless the user explicitly permits them. Support pause, resume, edit, delete, missed-run policy, and visible run history. Workers must operate independently of the user's browser while respecting all grants and limits.

## 9. Memory and project knowledge

Separate temporary conversation context from durable project memory. Each durable item should record owner, source, timestamp, confidence, project scope, and retention policy. Users must be able to inspect, correct, export, and delete memory. Do not store passwords, API keys, authentication tokens, or unnecessary sensitive information. Retrieve only relevant memory and enforce the same owner boundary during retrieval.

## 10. Multi-agent coordination

A central orchestrator owns the plan, budget, policy, and final task state. Specialist agents receive narrow, time-limited scopes and only the context needed for their assignment. Subagents cannot approve their own high-impact actions, expand their own permissions, increase the budget, or change the user's goal without review. Validate all subagent outputs before they become trusted artifacts or trigger another action.

## 11. Reliability and observability

Use correlation IDs across goals, tasks, runs, and tool calls. Record actor, owner, plan/task version, permission grant, tool, timestamps, result, and usage in an append-only audit trail. Expose understandable progress and failure reasons. Use bounded exponential backoff, idempotency, concurrency limits, and manual-review escalation. Do not silently swallow failures or claim success without verifying the result.

## 12. Delivery phases

- **Phase 1 — Planning foundation (current):** goal intake, AI-generated task plans, per-user persistence, review, and approve/reject. No execution.
- **Phase 2 — Safe execution foundation:** versioned plans, dependencies, scoped grants, audit events, durable queue, bounded worker, run timeline, pause/cancel, and safe internal tasks.
- **Phase 3 — Creation and research tools:** permission-scoped web research, file operations, code generation, sandboxed tests, and artifact review.
- **Phase 4 — Autonomous operations:** schedules, recurring cloud runs, budget controls, progress alerts, and recovery workflows.
- **Phase 5 — Long-term intelligence:** user-controlled project memory, knowledge retrieval, specialist agents, and coordinated multi-agent workflows.
- **Phase 6 — Global beta readiness:** adversarial permission tests, tenant-isolation tests, reliability and cost evaluation, monitoring, incident response, and staged rollout.

Each phase must pass security, functional, failure-path, and cost tests before the next phase is enabled.

## 13. Acceptance criteria

- Every task has an owner, version, explicit success criteria, and truthful state.
- Dependency cycles and invalid transitions are rejected server-side.
- Approval is scoped to the exact task version and permitted capability.
- High-impact actions require fresh confirmation.
- Workers recheck authorization and cancellation immediately before acting.
- Time, spend, tool calls, concurrency, and retries are bounded.
- Every side effect and state transition is auditable and idempotent where applicable.
- Cross-user and cross-workspace data access is denied.
- Users can see progress, artifacts, errors, and available stop controls.
- Phase 1 behavior remains compatible: approval alone never triggers execution.
