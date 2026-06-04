"""compute_policy_rules — Sprint 25 / A-5-followup-2
(+ A-7-config-wireup + T-2 FF gate).

Temporal activity that wraps the A-1 → A-2 → A-3 chain:

  1. ``discover_guideline_files(workspace, custom_patterns)`` walks
     the cloned workspace and returns ``DiscoveredGuidelineFilesV1``.
  2. ``extract_rules(guideline_file)`` parses each file into typed
     ``ExtractedRuleV1`` rows.
  3. ``resolve_guidance(changed_path, extracted_rules)`` filters +
     dedups the flattened ruleset per changed-file path.

The activity returns one ``ResolvedGuidanceBundleV1`` per
``changed_path`` so the workflow can thread it into each chunk's
``ReviewContextV1.applicable_policy`` (sub-commit 3 of this arc).

Sprint 25 / A-7-config-wireup (Task 13 update) — the
``knowledge.enabled`` opt-out and ``knowledge.file_patterns`` now
arrive via ``ComputePolicyRulesInputV1``. The workflow body resolves
them ONCE from the single ``.codemaster.yaml`` read performed by
``load_repo_config_activity`` and passes them in. This activity no
longer reads ``.codemaster.yaml`` itself — eliminating the duplicate
read and the associated drift hazard.

Sprint 25 / T-2 — bound-method holder pattern.

2026-05-24 drop-rollout-flags commit 3 — the
``policy_engine_enabled`` FF gate was removed. The activity
always computes policy bundles when dispatched. The
``workflow.patched("policy-engine-wiring")`` marker remains as
the deploy-time replay-safety gate — it MUST stay because it
controls workflow-deterministic-replay semantics (a different
concern from operator-facing rollout control).

Failures inside A-2/A-3 are programming bugs (pure functions over
validated data) and propagate. Failures inside A-1 (filesystem)
also propagate — the workflow's ``stage_outcome`` helper decides
whether to fail-open the review.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from temporalio import activity

from codemaster.activities.discover_repo_docs import discover_guideline_files
from codemaster.policy.rule_extractor import extract_rules
from codemaster.policy.scope_resolver import resolve_guidance
from contracts.extracted_rules.v1 import ExtractedRuleV1
from contracts.policy_compute.v1 import (
    ComputedPolicyRulesV1,
    ComputePolicyRulesInputV1,
)
from contracts.resolved_guidance.v1 import ResolvedGuidanceBundleV1


class ComputePolicyRulesActivity:
    """Bound-method holder for ``compute_policy_rules_activity``.

    2026-05-24 drop-rollout-flags commit 3 — the
    ``policy_engine_enabled`` FF gate was removed. The activity
    always computes policy bundles when dispatched. Workflow-body
    replay safety preserved via the existing
    ``workflow.patched("policy-engine-wiring")`` marker — that's a
    workflow-deterministic-replay gate, not a DB-flag rollout gate.
    """

    @activity.defn(name="compute_policy_rules_activity")
    async def compute_policy_rules(
        self,
        payload_dict: dict[str, Any],
    ) -> ComputedPolicyRulesV1:
        """Compute per-changed-path policy bundles for a review.

        The workflow calls this once per review (not per chunk) and
        looks up ``result.bundles[chunk.path]`` when building each
        ``ReviewContextV1``. O(N_files + N_rules + N_paths) — cheap
        on realistic repo sizes; the A-1 cap
        (``MAX_GUIDELINE_FILES_PER_REPO``) bounds the worst case.
        """
        inp = ComputePolicyRulesInputV1.model_validate(payload_dict)
        workspace = Path(inp.workspace_path)

        # Task 13 consolidation — ``knowledge.enabled`` +
        # ``knowledge.file_patterns`` now arrive via the input. The body
        # resolves them ONCE from the single ``.codemaster.yaml`` read in
        # ``load_repo_config_activity`` (``repo_config_box[0]``) and passes
        # them through ``ComputePolicyRulesInputV1``. This activity no longer
        # reads ``.codemaster.yaml`` itself, removing the duplicate read /
        # drift hazard.
        #
        #   knowledge_enabled=False → customer opted out via
        #     ``.codemaster.yaml::knowledge.enabled=false``. Short-circuit to
        #     empty bundles WITHOUT walking the workspace.
        #   custom_patterns → already includes the merge of A-1 callers'
        #     patterns with ``knowledge.file_patterns`` (done by the body);
        #     dedup defensively in case the body passes duplicates.
        if not inp.knowledge_enabled:
            return ComputedPolicyRulesV1(bundles={}, truncated=False)
        custom_patterns = tuple(sorted(set(inp.custom_patterns)))

        discovered = discover_guideline_files(
            workspace=workspace,
            custom_patterns=custom_patterns,
        )

        all_rules: list[ExtractedRuleV1] = []
        for gf in discovered.files:
            all_rules.extend(extract_rules(gf))
        rules_tuple = tuple(all_rules)

        bundles: dict[str, ResolvedGuidanceBundleV1] = {
            cp: resolve_guidance(changed_path=cp, extracted_rules=rules_tuple)
            for cp in inp.changed_paths
        }

        return ComputedPolicyRulesV1(
            bundles=bundles,
            truncated=discovered.files_cap_hit,
        )


__all__ = ["ComputePolicyRulesActivity"]
