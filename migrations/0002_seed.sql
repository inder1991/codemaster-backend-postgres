--
-- PostgreSQL database dump
--

\restrict 8kuSSfIDSHL2VCxZ93ewVgUaOhr3k3tcWQXaDTUq2nfgXbMdFPlmIo4X2UktYOO

-- Dumped from database version 16.14 (Debian 16.14-1.pgdg12+1)
-- Dumped by pg_dump version 18.3 (Homebrew)


--
-- Data for Name: audit_events_default; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.audit_events_default (audit_event_id, installation_id, actor_kind, actor_id, action, target_kind, target_id, before, after, created_at) FROM stdin;
\.


--
-- Data for Name: audit_events_p20260201; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.audit_events_p20260201 (audit_event_id, installation_id, actor_kind, actor_id, action, target_kind, target_id, before, after, created_at) FROM stdin;
\.


--
-- Data for Name: audit_events_p20260301; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.audit_events_p20260301 (audit_event_id, installation_id, actor_kind, actor_id, action, target_kind, target_id, before, after, created_at) FROM stdin;
\.


--
-- Data for Name: audit_events_p20260401; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.audit_events_p20260401 (audit_event_id, installation_id, actor_kind, actor_id, action, target_kind, target_id, before, after, created_at) FROM stdin;
\.


--
-- Data for Name: audit_events_p20260501; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.audit_events_p20260501 (audit_event_id, installation_id, actor_kind, actor_id, action, target_kind, target_id, before, after, created_at) FROM stdin;
\.


--
-- Data for Name: audit_events_p20260601; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.audit_events_p20260601 (audit_event_id, installation_id, actor_kind, actor_id, action, target_kind, target_id, before, after, created_at) FROM stdin;
\.


--
-- Data for Name: audit_events_p20260701; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.audit_events_p20260701 (audit_event_id, installation_id, actor_kind, actor_id, action, target_kind, target_id, before, after, created_at) FROM stdin;
\.


--
-- Data for Name: audit_events_p20260801; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.audit_events_p20260801 (audit_event_id, installation_id, actor_kind, actor_id, action, target_kind, target_id, before, after, created_at) FROM stdin;
\.


--
-- Data for Name: audit_events_p20260901; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.audit_events_p20260901 (audit_event_id, installation_id, actor_kind, actor_id, action, target_kind, target_id, before, after, created_at) FROM stdin;
\.


--
-- Data for Name: audit_events_p20261001; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.audit_events_p20261001 (audit_event_id, installation_id, actor_kind, actor_id, action, target_kind, target_id, before, after, created_at) FROM stdin;
\.


--
-- Data for Name: webhook_events_default; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.webhook_events_default (webhook_event_id, installation_id, delivery_id, event_type, received_at, signature_valid, raw_body, run_id) FROM stdin;
\.


--
-- Data for Name: webhook_events_p20260520; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.webhook_events_p20260520 (webhook_event_id, installation_id, delivery_id, event_type, received_at, signature_valid, raw_body, run_id) FROM stdin;
\.


--
-- Data for Name: webhook_events_p20260527; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.webhook_events_p20260527 (webhook_event_id, installation_id, delivery_id, event_type, received_at, signature_valid, raw_body, run_id) FROM stdin;
\.


--
-- Data for Name: webhook_events_p20260603; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.webhook_events_p20260603 (webhook_event_id, installation_id, delivery_id, event_type, received_at, signature_valid, raw_body, run_id) FROM stdin;
\.


--
-- Data for Name: webhook_events_p20260610; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.webhook_events_p20260610 (webhook_event_id, installation_id, delivery_id, event_type, received_at, signature_valid, raw_body, run_id) FROM stdin;
\.


--
-- Data for Name: webhook_events_p20260617; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.webhook_events_p20260617 (webhook_event_id, installation_id, delivery_id, event_type, received_at, signature_valid, raw_body, run_id) FROM stdin;
\.


--
-- Data for Name: workflow_events_default; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.workflow_events_default (event_id, provider, delivery_id, run_id, review_id, sequence_no, event_type, payload, received_at, installation_id) FROM stdin;
\.


--
-- Data for Name: workflow_events_p20260401; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.workflow_events_p20260401 (event_id, provider, delivery_id, run_id, review_id, sequence_no, event_type, payload, received_at, installation_id) FROM stdin;
\.


--
-- Data for Name: workflow_events_p20260501; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.workflow_events_p20260501 (event_id, provider, delivery_id, run_id, review_id, sequence_no, event_type, payload, received_at, installation_id) FROM stdin;
\.


--
-- Data for Name: workflow_events_p20260601; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.workflow_events_p20260601 (event_id, provider, delivery_id, run_id, review_id, sequence_no, event_type, payload, received_at, installation_id) FROM stdin;
\.


--
-- Data for Name: workflow_events_p20260701; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.workflow_events_p20260701 (event_id, provider, delivery_id, run_id, review_id, sequence_no, event_type, payload, received_at, installation_id) FROM stdin;
\.


--
-- Data for Name: workflow_events_p20260801; Type: TABLE DATA; Schema: audit; Owner: -
--

COPY audit.workflow_events_p20260801 (event_id, provider, delivery_id, run_id, review_id, sequence_no, event_type, payload, received_at, installation_id) FROM stdin;
\.


--
-- Data for Name: cache_app_jwt; Type: TABLE DATA; Schema: cache; Owner: -
--

COPY cache.cache_app_jwt (cache_app_jwt_id, app_id, jwt_ciphertext, expires_at, created_at) FROM stdin;
\.


--
-- Data for Name: cache_embeddings; Type: TABLE DATA; Schema: cache; Owner: -
--

COPY cache.cache_embeddings (cache_embedding_id, content_sha256, embedding_version, embedding, created_at, expires_at) FROM stdin;
\.


--
-- Data for Name: cache_idempotency; Type: TABLE DATA; Schema: cache; Owner: -
--

COPY cache.cache_idempotency (cache_key, value, expires_at, created_at) FROM stdin;
\.


--
-- Data for Name: cache_rate_limits; Type: TABLE DATA; Schema: cache; Owner: -
--

COPY cache.cache_rate_limits (cache_rate_limit_id, installation_id, resource, "limit", remaining, reset_at, recorded_at) FROM stdin;
\.


--
-- Data for Name: installations; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.installations (installation_id, github_installation_id, account_login, account_type, created_at, updated_at, suspended_at, onboarded_at) FROM stdin;
00000000-0000-0000-0000-000000000001	-1	__platform_sentinel__	Organization	2026-06-03 20:13:31.080799+00	2026-06-03 20:13:31.080799+00	\N	\N
\.


--
-- Data for Name: cache_tokens; Type: TABLE DATA; Schema: cache; Owner: -
--

COPY cache.cache_tokens (cache_token_id, installation_id, token_ciphertext, expires_at, created_at) FROM stdin;
\.


--
-- Data for Name: repository_repair_state; Type: TABLE DATA; Schema: cache; Owner: -
--

COPY cache.repository_repair_state (github_installation_id, last_attempt_at, blocked_reason, blocked_at) FROM stdin;
\.


--
-- Data for Name: ad_users; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.ad_users (ad_user_id, principal_name, display_name, last_synced_at) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.users (user_id, installation_id, email, display_name, ad_user_id, created_at, updated_at, suspended_at, username, password_hash, password_changed_at, failed_attempts, locked_until, last_login_at) FROM stdin;
\.


--
-- Data for Name: api_tokens; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.api_tokens (api_token_id, user_id, installation_id, token_hash, scopes, expires_at, revoked_at, created_at) FROM stdin;
\.


--
-- Data for Name: arbitration_rejections; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.arbitration_rejections (rejection_id, installation_id, run_id, review_id, target_finding_id, reason_rejected, intent_confidence, intent_reason, suppression_model, suppression_prompt_version, created_at) FROM stdin;
\.


--
-- Data for Name: bedrock_settings; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.bedrock_settings (scope, model_id, region, api_key_ciphertext, api_key_fingerprint, enabled, last_validated_at, last_validation_status, last_rotated_at, last_rotated_by_user_id) FROM stdin;
\.


--
-- Data for Name: embedding_generations; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.embedding_generations (generation_id, state, generation_label, generation_reason, provider_name, provider_version, model_name, embedding_dimension, created_from_generation, created_at, created_by_email, chunker_version, preprocessing_version, normalization_version, backfill_started_at, backfill_completed_at, total_chunks, chunks_backfilled, chunks_failed, validation_started_at, validation_completed_at, validation_report_json, validation_passed, activated_at, retired_at, retire_reason, gc_started_at, gc_completed_at, last_error) FROM stdin;
1	active	\N	\N	qwen	\N	qwen3-embed-0.6b	1024	\N	2026-06-03 20:13:32.043873+00	migration-seed	1	1	1	\N	\N	0	0	0	\N	\N	\N	\N	2026-06-03 20:13:32.043873+00	\N	\N	\N	\N	\N
\.


--
-- Data for Name: chunk_embeddings; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.chunk_embeddings (chunk_table, chunk_id, generation_id, embedding_model_name, embedding, content_sha256, created_at) FROM stdin;
\.


--
-- Data for Name: repositories; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.repositories (repository_id, installation_id, github_repo_id, full_name, default_branch, archived, enabled, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: code_owners; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.code_owners (code_owner_id, installation_id, repository_id, path_pattern, owner_logins, source_file_sha, synced_at) FROM stdin;
\.


--
-- Data for Name: config_revisions; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.config_revisions (config_revision_id, parent_kind, parent_id, revision_number, content, author_user_id, created_at) FROM stdin;
\.


--
-- Data for Name: confluence_chunks; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.confluence_chunks (chunk_id, space_key, page_id, page_title, version, chunk_index, chunk_text, redaction_applied, embedding, ingested_at, superseded_at, token_count, labels, quarantined, quarantine_reasons, page_status, last_modified_at, stale_at, default_approval, deleted_at, content_sha256) FROM stdin;
\.


--
-- Data for Name: confluence_page_approvals; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.confluence_page_approvals (approval_id, space_key, page_id, approver_email, approved_at_utc, approval_artifact_url, scope_justification, default_scope, revoked_at, revoked_by, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: cost_cap_overrides; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.cost_cap_overrides (installation_id, cap_cents, expires_at, updated_at, updated_by_user_id) FROM stdin;
\.


--
-- Data for Name: cost_cap_pending_changes; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.cost_cap_pending_changes (pending_change_id, target_kind, target_id, new_cap_cents, expires_at, requested_at, requested_by_user_id, approved_at, approved_by_user_id, applied_at, state) FROM stdin;
\.


--
-- Data for Name: cost_cap_settings; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.cost_cap_settings (scope, cap_cents, updated_at, updated_by_user_id) FROM stdin;
\.


--
-- Data for Name: diff_snapshots_default; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.diff_snapshots_default (diff_snapshot_id, installation_id, repository_id, base_sha, head_sha, diff_blob_id, byte_size, created_at) FROM stdin;
\.


--
-- Data for Name: diff_snapshots_p20260401; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.diff_snapshots_p20260401 (diff_snapshot_id, installation_id, repository_id, base_sha, head_sha, diff_blob_id, byte_size, created_at) FROM stdin;
\.


--
-- Data for Name: diff_snapshots_p20260501; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.diff_snapshots_p20260501 (diff_snapshot_id, installation_id, repository_id, base_sha, head_sha, diff_blob_id, byte_size, created_at) FROM stdin;
\.


--
-- Data for Name: diff_snapshots_p20260601; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.diff_snapshots_p20260601 (diff_snapshot_id, installation_id, repository_id, base_sha, head_sha, diff_blob_id, byte_size, created_at) FROM stdin;
\.


--
-- Data for Name: diff_snapshots_p20260701; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.diff_snapshots_p20260701 (diff_snapshot_id, installation_id, repository_id, base_sha, head_sha, diff_blob_id, byte_size, created_at) FROM stdin;
\.


--
-- Data for Name: diff_snapshots_p20260801; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.diff_snapshots_p20260801 (diff_snapshot_id, installation_id, repository_id, base_sha, head_sha, diff_blob_id, byte_size, created_at) FROM stdin;
\.


--
-- Data for Name: embedder_runtime_state; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.embedder_runtime_state (singleton, active_generation, active_model_name, pending_generation, pending_model_name, config_version, retrieval_mode, updated_at, updated_by_email) FROM stdin;
t	1	qwen3-embed-0.6b	\N	\N	1	fallback	2026-06-03 20:13:32.058247+00	migration-seed
\.


--
-- Data for Name: feedback_events_default; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.feedback_events_default (feedback_event_id, installation_id, review_finding_id, kind, raw_payload, created_at) FROM stdin;
\.


--
-- Data for Name: feedback_events_p20260401; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.feedback_events_p20260401 (feedback_event_id, installation_id, review_finding_id, kind, raw_payload, created_at) FROM stdin;
\.


--
-- Data for Name: feedback_events_p20260501; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.feedback_events_p20260501 (feedback_event_id, installation_id, review_finding_id, kind, raw_payload, created_at) FROM stdin;
\.


--
-- Data for Name: feedback_events_p20260601; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.feedback_events_p20260601 (feedback_event_id, installation_id, review_finding_id, kind, raw_payload, created_at) FROM stdin;
\.


--
-- Data for Name: feedback_events_p20260701; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.feedback_events_p20260701 (feedback_event_id, installation_id, review_finding_id, kind, raw_payload, created_at) FROM stdin;
\.


--
-- Data for Name: feedback_events_p20260801; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.feedback_events_p20260801 (feedback_event_id, installation_id, review_finding_id, kind, raw_payload, created_at) FROM stdin;
\.


--
-- Data for Name: fix_prompts; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.fix_prompts (review_id, installation_id, prompt, generation_mode, finding_count, truncated, generated_at) FROM stdin;
\.


--
-- Data for Name: flag_revisions; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.flag_revisions (id, flag_name, before, after, changed_by_ad_user_id, changed_at) FROM stdin;
\.


--
-- Data for Name: flags; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.flags (flag_name, description, enabled, rollout, variants, scope, scope_id, expires_at, created_by_ad_user_id, created_at, updated_at, value_json, last_changed_at, last_changed_by_user_id, pending_second_approver, pending_first_approver_user_id, pending_value_json, pending_set_at) FROM stdin;
bedrock_global_daily_cap_cents	Global daily Bedrock spend cap in cents. Worker pre-call check refuses calls when today's accumulated cost would exceed this. Default 500_000 cents = $5,000/day for v0.	t	{"value": 500000}	\N	global	\N	\N	\N	2026-06-03 20:13:31.080799+00	2026-06-03 20:13:31.080799+00	{"value": 500000}	2026-06-03 20:13:31.080799+00	\N	f	\N	\N	\N
bedrock_per_org_daily_cap_cents	Per-org daily Bedrock spend cap in cents. Default 100_000 = $1,000/day per org. Specific orgs can override at scope_type='installation' with their own row.	t	{"value": 100000}	\N	global	\N	\N	\N	2026-06-03 20:13:31.080799+00	2026-06-03 20:13:31.080799+00	{"value": 100000}	2026-06-03 20:13:31.080799+00	\N	f	\N	\N	\N
bedrock_global_kill_switch	Emergency global Bedrock kill switch. When True, every Bedrock call refuses with BedrockBudgetExceededError. Restoration requires platform_owner action. See docs/runbooks/cost-incident.md.	f	{}	\N	global	\N	\N	\N	2026-06-03 20:13:31.080799+00	2026-06-03 20:13:31.080799+00	false	2026-06-03 20:13:31.080799+00	\N	f	\N	\N	\N
\.


--
-- Data for Name: flags_archive_0090; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.flags_archive_0090 (flag_name, description, enabled, rollout, variants, scope, scope_id, expires_at, created_by_ad_user_id, created_at, updated_at, value_json, last_changed_at, last_changed_by_user_id, pending_second_approver, pending_first_approver_user_id, pending_value_json, pending_set_at) FROM stdin;
pull_requests_v1_enabled		f	{"enabled": false}	\N	global	\N	\N	\N	2026-06-03 20:13:31.080799+00	2026-06-03 20:13:31.080799+00		2026-06-03 20:13:31.080799+00	\N	f	\N	\N	\N
pr_files_v1		f	{"enabled": false}	\N	global	\N	\N	\N	2026-06-03 20:13:31.080799+00	2026-06-03 20:13:31.080799+00		2026-06-03 20:13:31.080799+00	\N	f	\N	\N	\N
pr_issue_links_v1		f	{"enabled": false}	\N	global	\N	\N	\N	2026-06-03 20:13:31.080799+00	2026-06-03 20:13:31.080799+00		2026-06-03 20:13:31.080799+00	\N	f	\N	\N	\N
review_findings_persisted_v1		f	{"enabled": false}	\N	global	\N	\N	\N	2026-06-03 20:13:31.080799+00	2026-06-03 20:13:31.080799+00		2026-06-03 20:13:31.080799+00	\N	f	\N	\N	\N
\.


--
-- Data for Name: gh_users; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.gh_users (gh_user_id, github_user_id, login, user_type, name, avatar_url, first_seen_at, last_seen_at) FROM stdin;
\.


--
-- Data for Name: github_issues_cache; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.github_issues_cache (github_issue_cache_id, installation_id, repository_id, github_issue_number, title, body, state, assignees_json, labels_json, cached_at, etag) FROM stdin;
\.


--
-- Data for Name: global_config; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.global_config (id, current_revision_id, updated_at) FROM stdin;
1	\N	2026-06-03 20:13:31.080799+00
\.


--
-- Data for Name: integrations; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.integrations (integration_id, kind, config_json, enabled, last_validated_at, last_validation_error, created_at, updated_at, trust_tier, default_governance_ack_at, visibility, strict_label_mode) FROM stdin;
\.


--
-- Data for Name: knowledge_chunks; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.knowledge_chunks (chunk_id, installation_id, repository_id, relative_path, chunk_index, content_sha256, heading_path, body, vector, doc_kind, doc_status, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: learning_proposals; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.learning_proposals (proposal_id, installation_id, repo_id, title, body, proposed_by_user_id, state, fired_count, accepted_count, feedback_count, created_at, state_changed_at) FROM stdin;
\.


--
-- Data for Name: learnings; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.learnings (learning_id, installation_id, repo_id, title, body_markdown, state, version, fired_count, accepted_count, feedback_count, origin_proposal_id, created_at, updated_at, last_fired_at) FROM stdin;
\.


--
-- Data for Name: learnings_revisions; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.learnings_revisions (revision_id, learning_id, installation_id, body_markdown, version, edited_by_user_id, edited_at) FROM stdin;
\.


--
-- Data for Name: llm_models; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.llm_models (provider, model_id, display_name, enabled, last_validation_status, last_validation_error, last_validated_at, created_at, updated_at, created_by_user_id) FROM stdin;
anthropic_direct	claude-sonnet-4-6	\N	t	untested	\N	\N	2026-06-03 20:13:32.058247+00	2026-06-03 20:13:32.058247+00	\N
anthropic_direct	claude-opus-4-7	\N	t	untested	\N	\N	2026-06-03 20:13:32.058247+00	2026-06-03 20:13:32.058247+00	\N
anthropic_direct	claude-haiku-4-5-20251001	\N	t	untested	\N	\N	2026-06-03 20:13:32.058247+00	2026-06-03 20:13:32.058247+00	\N
\.


--
-- Data for Name: llm_provider_settings; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.llm_provider_settings (installation_id, role, provider, model_id, region, api_key_ciphertext, api_key_fingerprint, enabled, last_validated_at, last_validation_status, last_rotated_at, last_rotated_by_user_id, scope) FROM stdin;
\.


--
-- Data for Name: llm_purpose_model; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.llm_purpose_model (purpose, model_id, updated_at, updated_by_user_id) FROM stdin;
review_finding	claude-sonnet-4-6	2026-06-03 20:13:32.058247+00	\N
walkthrough	claude-opus-4-7	2026-06-03 20:13:32.058247+00	\N
analysis_curator	claude-haiku-4-5-20251001	2026-06-03 20:13:32.058247+00	\N
\.


--
-- Data for Name: local_users; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.local_users (user_id, username, email_ciphertext, email_fingerprint, full_name, password_hash, role, state, last_password_change, last_login_at, failed_attempts, locked_until, created_at, created_by_user_id) FROM stdin;
\.


--
-- Data for Name: notification_rules; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.notification_rules (rule_id, name, trigger_event, filters, recipients, schedule_cron, state, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: org_configs; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.org_configs (org_config_id, installation_id, current_revision_id, updated_at) FROM stdin;
\.


--
-- Data for Name: pull_request_reviews; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.pull_request_reviews (review_id, provider, repo_id, pr_number, provider_pr_id, pr_node_id, branch, status, current_run_id, created_at) FROM stdin;
\.


--
-- Data for Name: review_runs; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.review_runs (run_id, review_id, trigger_type, triggered_by, attempt_number, lifecycle_state, parent_run_id, supersedes_run_id, superseded_by_run_id, is_ephemeral, branch_name, cancel_reason, created_at, started_at, completed_at, failed_at, cancelled_at, retired_at, retention_reason) FROM stdin;
\.


--
-- Data for Name: outbox; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.outbox (id, sink, payload, schema_version, attempts, state, last_error, last_attempted_at, dispatched_at, created_at, leased_until, trace_context, delivery_id, installation_id, run_id) FROM stdin;
\.


--
-- Data for Name: platform_config; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.platform_config (config_key, config_value, updated_at, updated_by) FROM stdin;
max_default_chunks_per_space	25	2026-06-03 20:13:31.998976+00	\N
max_default_corpus_tokens	50000	2026-06-03 20:13:31.998976+00	\N
staleness_threshold_days_default	180	2026-06-03 20:13:31.998976+00	\N
staleness_threshold_days_security_policy	90	2026-06-03 20:13:31.998976+00	\N
retrieval_trace_sampling_rate_ok	0.10	2026-06-03 20:13:31.998976+00	\N
retrieval_trace_sampling_rate_error	1.0	2026-06-03 20:13:31.998976+00	\N
per_label_cap	50	2026-06-03 20:13:31.998976+00	\N
per_tier_min	20	2026-06-03 20:13:31.998976+00	\N
global_cap	150	2026-06-03 20:13:31.998976+00	\N
confluence_retrieval_enabled_percent	0.0	2026-06-03 20:13:31.998976+00	\N
default_pool_token_reservation_pct	0.15	2026-06-03 20:13:32.043873+00	\N
\.


--
-- Data for Name: platform_credentials_meta; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.platform_credentials_meta (credential_key, last_rotated_at, last_rotated_by, last_validated_at, last_validation_error) FROM stdin;
\.


--
-- Data for Name: posted_reviews; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.posted_reviews (pr_id, github_review_id, marker, posted_at, updated_at, publication_outcome) FROM stdin;
\.


--
-- Data for Name: posted_reviews_archive; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.posted_reviews_archive (archive_id, pr_id, github_review_id, marker, posted_at, updated_at, archived_at, archived_reason) FROM stdin;
\.


--
-- Data for Name: pull_requests; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.pull_requests (pr_id, installation_id, repository_id, github_pull_request_id, pr_number, author_gh_user_id, state, title, body, base_ref, base_sha, head_ref, head_sha, draft, cross_fork, opened_at, closed_at, merged_at, merge_commit_sha, correlation_id, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: pr_files; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.pr_files (pr_file_id, installation_id, pr_id, repository_id, file_path, status, additions, deletions, previous_path, language, created_at) FROM stdin;
\.


--
-- Data for Name: pr_issue_links; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.pr_issue_links (pr_issue_link_id, installation_id, pr_id, github_issue_number, linkage_kind, source, created_at) FROM stdin;
\.


--
-- Data for Name: pr_review_mutex; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.pr_review_mutex (mutex_id, installation_id, repository_id, pr_number, holder_workflow_id, acquired_at, released_at, lease_expires_at) FROM stdin;
\.


--
-- Data for Name: pr_state_transitions; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.pr_state_transitions (pr_state_transition_id, pr_id, installation_id, from_state, to_state, event_action, head_sha, delivery_id, created_at) FROM stdin;
\.


--
-- Data for Name: repo_configs; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.repo_configs (repo_config_id, installation_id, repository_id, current_revision_id, updated_at) FROM stdin;
\.


--
-- Data for Name: repo_symbols; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.repo_symbols (symbol_id, repo_id, language, kind, qualified_name, is_public, relative_path, start_line, end_line, signature, docstring, content_sha256, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: retrieval_traces; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.retrieval_traces (trace_id, review_id, pr_id, captured_at, taxonomy_version, pipeline_version, trace) FROM stdin;
\.


--
-- Data for Name: review_findings; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.review_findings (review_finding_id, installation_id, pr_id, posted_review_pr_id, file_path, start_line, end_line, severity, category, title, body, suggestion, confidence, github_comment_id, citations, created_at, suppression_state, suppression_reason, suppression_confidence, suppression_model, suppression_prompt_version, suppressed_at, suppressed_by_finding_id, tier, source_tool, policy_metadata, scope, evidence_refs, delivery_eligibility, eligibility_reason, delivery_outcome, lifecycle_updated_at) FROM stdin;
\.


--
-- Data for Name: review_policy_bundles; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.review_policy_bundles (review_id, installation_id, applied_bundle, rule_count, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: review_tool_runs; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.review_tool_runs (review_tool_run_id, installation_id, run_id, review_id, tool_name, status, files_scanned, files_total, started_at, finished_at, duration_ms, findings_produced, error_class, error_message, k8s_job_name, k8s_namespace, created_at) FROM stdin;
\.


--
-- Data for Name: review_walkthroughs; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.review_walkthroughs (review_id, installation_id, walkthrough, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: role_grant_pending; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.role_grant_pending (pending_id, installation_id, subject_kind, subject_id, role, action, requested_at, requested_by_user_id, expires_at, approved_at, approved_by_user_id, applied_at, state, scope) FROM stdin;
\.


--
-- Data for Name: role_grants; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.role_grants (role_grant_id, installation_id, subject_kind, subject_id, role, granted_at, revoked_at, scope) FROM stdin;
\.


--
-- Data for Name: symbol_references; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.symbol_references (reference_id, target_symbol_id, consumer_repo_id, consumer_relative_path, consumer_line, kind, confidence, excerpt, created_at) FROM stdin;
\.


--
-- Data for Name: taxonomy_suggestions; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.taxonomy_suggestions (suggestion_id, label, proposed_canonical_label, rationale, suggester_email, submitted_by_user_id, submitted_at) FROM stdin;
\.


--
-- Data for Name: teams; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.teams (team_id, installation_id, name, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: team_memberships; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.team_memberships (team_id, user_id, installation_id, role, joined_at) FROM stdin;
\.


--
-- Data for Name: worker_heartbeats; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.worker_heartbeats (worker_id, pod_name, pod_namespace, pod_uid, node_name, process_uuid, started_at, last_seen_at) FROM stdin;
\.


--
-- Data for Name: workspace_leases; Type: TABLE DATA; Schema: core; Owner: -
--

COPY core.workspace_leases (workspace_id, run_id, review_id, installation_id, state, pod_name, pod_namespace, node_name, worker_id, created_at, heartbeat_at, orphan_check_after, release_requested_at, release_requested_by, released_at, cleanup_failed_at, last_cleanup_attempt_at, cleanup_attempts, last_cleanup_error) FROM stdin;
\.


--
-- Data for Name: cost_daily; Type: TABLE DATA; Schema: telemetry; Owner: -
--

COPY telemetry.cost_daily (today, scope, scope_id, daily_total_cents, cap_cents, updated_at) FROM stdin;
\.


--
-- Data for Name: llm_calls_daily; Type: TABLE DATA; Schema: telemetry; Owner: -
--

COPY telemetry.llm_calls_daily (day, installation_id, model, total_calls, total_prompt_tokens, total_completion_tokens, total_cost_usd_cents, author_gh_user_id) FROM stdin;
\.


--
-- Data for Name: llm_calls_default; Type: TABLE DATA; Schema: telemetry; Owner: -
--

COPY telemetry.llm_calls_default (llm_call_id, installation_id, request_id, model, prompt_tokens, completion_tokens, latency_ms, cost_usd_cents, payload_blob_id, status, created_at, author_gh_user_id, provider, role) FROM stdin;
\.


--
-- Data for Name: llm_calls_p20260506; Type: TABLE DATA; Schema: telemetry; Owner: -
--

COPY telemetry.llm_calls_p20260506 (llm_call_id, installation_id, request_id, model, prompt_tokens, completion_tokens, latency_ms, cost_usd_cents, payload_blob_id, status, created_at, author_gh_user_id, provider, role) FROM stdin;
\.


--
-- Data for Name: llm_calls_p20260513; Type: TABLE DATA; Schema: telemetry; Owner: -
--

COPY telemetry.llm_calls_p20260513 (llm_call_id, installation_id, request_id, model, prompt_tokens, completion_tokens, latency_ms, cost_usd_cents, payload_blob_id, status, created_at, author_gh_user_id, provider, role) FROM stdin;
\.


--
-- Data for Name: llm_calls_p20260520; Type: TABLE DATA; Schema: telemetry; Owner: -
--

COPY telemetry.llm_calls_p20260520 (llm_call_id, installation_id, request_id, model, prompt_tokens, completion_tokens, latency_ms, cost_usd_cents, payload_blob_id, status, created_at, author_gh_user_id, provider, role) FROM stdin;
\.


--
-- Data for Name: llm_calls_p20260527; Type: TABLE DATA; Schema: telemetry; Owner: -
--

COPY telemetry.llm_calls_p20260527 (llm_call_id, installation_id, request_id, model, prompt_tokens, completion_tokens, latency_ms, cost_usd_cents, payload_blob_id, status, created_at, author_gh_user_id, provider, role) FROM stdin;
\.


--
-- Data for Name: llm_calls_p20260603; Type: TABLE DATA; Schema: telemetry; Owner: -
--

COPY telemetry.llm_calls_p20260603 (llm_call_id, installation_id, request_id, model, prompt_tokens, completion_tokens, latency_ms, cost_usd_cents, payload_blob_id, status, created_at, author_gh_user_id, provider, role) FROM stdin;
\.


--
-- Data for Name: llm_calls_p20260610; Type: TABLE DATA; Schema: telemetry; Owner: -
--

COPY telemetry.llm_calls_p20260610 (llm_call_id, installation_id, request_id, model, prompt_tokens, completion_tokens, latency_ms, cost_usd_cents, payload_blob_id, status, created_at, author_gh_user_id, provider, role) FROM stdin;
\.


--
-- Data for Name: llm_calls_p20260617; Type: TABLE DATA; Schema: telemetry; Owner: -
--

COPY telemetry.llm_calls_p20260617 (llm_call_id, installation_id, request_id, model, prompt_tokens, completion_tokens, latency_ms, cost_usd_cents, payload_blob_id, status, created_at, author_gh_user_id, provider, role) FROM stdin;
\.


--
-- Data for Name: llm_calls_p20260624; Type: TABLE DATA; Schema: telemetry; Owner: -
--

COPY telemetry.llm_calls_p20260624 (llm_call_id, installation_id, request_id, model, prompt_tokens, completion_tokens, latency_ms, cost_usd_cents, payload_blob_id, status, created_at, author_gh_user_id, provider, role) FROM stdin;
\.


--
-- Data for Name: llm_calls_p20260701; Type: TABLE DATA; Schema: telemetry; Owner: -
--

COPY telemetry.llm_calls_p20260701 (llm_call_id, installation_id, request_id, model, prompt_tokens, completion_tokens, latency_ms, cost_usd_cents, payload_blob_id, status, created_at, author_gh_user_id, provider, role) FROM stdin;
\.


--
-- Data for Name: llm_payloads_default; Type: TABLE DATA; Schema: telemetry; Owner: -
--

COPY telemetry.llm_payloads_default (blob_id, installation_id, key, content_type, byte_size_uncompressed, body_zstd, created_at) FROM stdin;
\.


--
-- Data for Name: llm_payloads_p20260401; Type: TABLE DATA; Schema: telemetry; Owner: -
--

COPY telemetry.llm_payloads_p20260401 (blob_id, installation_id, key, content_type, byte_size_uncompressed, body_zstd, created_at) FROM stdin;
\.


--
-- Data for Name: llm_payloads_p20260501; Type: TABLE DATA; Schema: telemetry; Owner: -
--

COPY telemetry.llm_payloads_p20260501 (blob_id, installation_id, key, content_type, byte_size_uncompressed, body_zstd, created_at) FROM stdin;
\.


--
-- Data for Name: llm_payloads_p20260601; Type: TABLE DATA; Schema: telemetry; Owner: -
--

COPY telemetry.llm_payloads_p20260601 (blob_id, installation_id, key, content_type, byte_size_uncompressed, body_zstd, created_at) FROM stdin;
\.


--
-- Data for Name: llm_payloads_p20260701; Type: TABLE DATA; Schema: telemetry; Owner: -
--

COPY telemetry.llm_payloads_p20260701 (blob_id, installation_id, key, content_type, byte_size_uncompressed, body_zstd, created_at) FROM stdin;
\.


--
-- Data for Name: llm_payloads_p20260801; Type: TABLE DATA; Schema: telemetry; Owner: -
--

COPY telemetry.llm_payloads_p20260801 (blob_id, installation_id, key, content_type, byte_size_uncompressed, body_zstd, created_at) FROM stdin;
\.


--
-- Name: embedding_generations_id_seq; Type: SEQUENCE SET; Schema: core; Owner: -
--

SELECT pg_catalog.setval('core.embedding_generations_id_seq', 1, true);


--
-- Name: global_config_id_seq; Type: SEQUENCE SET; Schema: core; Owner: -
--

SELECT pg_catalog.setval('core.global_config_id_seq', 1, false);


--
-- Name: posted_reviews_archive_archive_id_seq; Type: SEQUENCE SET; Schema: core; Owner: -
--

SELECT pg_catalog.setval('core.posted_reviews_archive_archive_id_seq', 1, false);


--
-- PostgreSQL database dump complete
--

\unrestrict 8kuSSfIDSHL2VCxZ93ewVgUaOhr3k3tcWQXaDTUq2nfgXbMdFPlmIo4X2UktYOO

