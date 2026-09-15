# Host contracts and local context

The parent keeps its conversation and selects a model for each fresh worker. SQLite remains authoritative for plans, reservations, identities, attempts and results.

## Codex contracts

Select `codex_contract` when creating a Codex plan:

| Contract | Prepared native arguments | Dependency release |
| --- | --- | --- |
| `legacy` (default, including older records) | `model`, `reasoning_effort`, `message`, `fork_context:false` | Parent-verified result and confirmed native closure |
| `collaboration` | `model`, `reasoning_effort`, `message`, generated `task_name`, `fork_turns:"none"` | Parent-verified result and native terminal execution evidence |

Use the arguments unchanged with the corresponding host tool. The collaboration contract can bind a canonical returned task name as the native identity. It records execution completion separately from shutdown: a completed execution can unlock its dependent step while `closed` remains false. Interrupt, idle, timeout and an unrecognized response never prove completion.

A verified collaboration report also needs `execution_complete:true`, `completion_status:"completed"`, `completion_evidence`, `observed_model` and `model_evidence`. The requested model is not evidence of the model that actually executed. When the host exposes no such evidence, report the verification gap instead of inventing it. Failed terminal execution can be recorded with `verified:false` and `completion_status:"errored"`.

Claude retains its native `Agent`/profile dispatch, start binding, stop observation and parent completion checks. A stop observation alone does not unlock dependencies.

## Markdown state

Each run has a bounded `current.md` outside the plugin cache, associated with its SQLite ledger. It contains goals, user decisions, constraints, verified facts, evidence, assumptions, open questions, next actions and references to separate details. It is a current-state reference, not a transcript or another lifecycle database.

Use `list SESSION_ID` and `show RUN_ID` to locate relevant work on resumption, then `memory-read RUN_ID`. The parent reads relevant state before planning or delegation and updates it after material decisions and verified results. Prepared worker prompts reference the current-state file without injecting all notes or detailed evidence. Workers read the relevant state and return proposed updates to the parent.

Updates use `memory-write RUN_ID SESSION_ID --input state.json`. The input contains `expected_revision` (null on first creation, otherwise the revision returned by the last read) and `state`. The state has these arrays of single-line strings:

```json
{
  "expected_revision": null,
  "state": {
    "goals": ["Verify the requested change"],
    "decisions": [],
    "constraints": [],
    "facts": [],
    "evidence": [],
    "assumptions": [],
    "questions": [],
    "next_actions": ["Read the relevant source"],
    "detail_references": []
  }
}
```

Only the recorded parent session can update a run's memory. Updates reject stale revisions, invalid records and changes during active execution. This is a workflow guardrail: workers share local filesystem permissions and must obey their assignment. Keep credentials, raw transcripts and personal task records out of source control. Custom data directories inside a checkout must also be ignored.

## Installation checks

Build and test both distributions with `npm test` and `npm run check:build`. Updating an installed script does not prove that a running host has reloaded or trusted its hook configuration. Check hook activation in a fresh host session; require an automatically reserved/bound read-only worker, observed model, native completion evidence and successful dependent dispatch before claiming a live host passes. Fixture replay verifies code paths, not host activation.
