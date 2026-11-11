# KairFlow confirmed bug fix

This repo snapshot contains the confirmed production fixes already present in the supplied repo plus the kill-switch send-job fix.

## Confirmed fix in this snapshot

When the send worker claims a job while `kill_switch=true`, the send handler returns `reason=kill_switch`. Previously the worker then called `intel_agent_complete_job`, incorrectly marking the job `succeeded` even though no email was sent.

The worker now calls `intel_agent_defer_job` for this specific reason. The SQL RPC returns the job to `queued`, clears the lease, schedules a short retry, and restores the consumed attempt count.

## Validation

`intelligence-worker`: 744 passed, 380 subtests passed.

## Important deployment note

Keep the production kill switch enabled until the worker and database migration are deployed and verified. The existing stale queued send jobs can then be normalized separately.
