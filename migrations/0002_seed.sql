--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Debian 16.14-1.pgdg12+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg12+1)


--
-- Data for Name: audit_events_default; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: audit_events_p20260201; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: audit_events_p20260301; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: audit_events_p20260401; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: audit_events_p20260501; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: audit_events_p20260601; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: audit_events_p20260701; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: audit_events_p20260801; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: audit_events_p20260901; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: audit_events_p20261001; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: webhook_events_default; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: webhook_events_p20260520; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: webhook_events_p20260527; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: webhook_events_p20260603; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: webhook_events_p20260610; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: webhook_events_p20260617; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: workflow_events_default; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: workflow_events_p20260401; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: workflow_events_p20260501; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: workflow_events_p20260601; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: workflow_events_p20260701; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: workflow_events_p20260801; Type: TABLE DATA; Schema: audit; Owner: -
--



--
-- Data for Name: cache_app_jwt; Type: TABLE DATA; Schema: cache; Owner: -
--



--
-- Data for Name: cache_embeddings; Type: TABLE DATA; Schema: cache; Owner: -
--



--
-- Data for Name: cache_idempotency; Type: TABLE DATA; Schema: cache; Owner: -
--



--
-- Data for Name: cache_rate_limits; Type: TABLE DATA; Schema: cache; Owner: -
--



--
-- Data for Name: installations; Type: TABLE DATA; Schema: core; Owner: -
--

INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type, created_at, updated_at, suspended_at, onboarded_at) VALUES ('00000000-0000-0000-0000-000000000001', -1, '__platform_sentinel__', 'Organization', '2026-06-03 20:13:31.080799+00', '2026-06-03 20:13:31.080799+00', NULL, NULL);


--
-- Data for Name: cache_tokens; Type: TABLE DATA; Schema: cache; Owner: -
--



--
-- Data for Name: repository_repair_state; Type: TABLE DATA; Schema: cache; Owner: -
--



--
-- Data for Name: ad_users; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: users; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: api_tokens; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: arbitration_rejections; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: bedrock_settings; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: embedding_generations; Type: TABLE DATA; Schema: core; Owner: -
--

INSERT INTO core.embedding_generations (generation_id, state, generation_label, generation_reason, provider_name, provider_version, model_name, embedding_dimension, created_from_generation, created_at, created_by_email, chunker_version, preprocessing_version, normalization_version, backfill_started_at, backfill_completed_at, total_chunks, chunks_backfilled, chunks_failed, validation_started_at, validation_completed_at, validation_report_json, validation_passed, activated_at, retired_at, retire_reason, gc_started_at, gc_completed_at, last_error) VALUES (1, 'active', NULL, NULL, 'qwen', NULL, 'qwen3-embed-0.6b', 1024, NULL, '2026-06-03 20:13:32.043873+00', 'migration-seed', '1', '1', '1', NULL, NULL, 0, 0, 0, NULL, NULL, NULL, NULL, '2026-06-03 20:13:32.043873+00', NULL, NULL, NULL, NULL, NULL);


--
-- Data for Name: chunk_embeddings; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: repositories; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: code_owners; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: config_revisions; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: confluence_chunks; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: confluence_page_approvals; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: cost_cap_overrides; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: cost_cap_pending_changes; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: cost_cap_settings; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: diff_snapshots_default; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: diff_snapshots_p20260401; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: diff_snapshots_p20260501; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: diff_snapshots_p20260601; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: diff_snapshots_p20260701; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: diff_snapshots_p20260801; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: embedder_runtime_state; Type: TABLE DATA; Schema: core; Owner: -
--

INSERT INTO core.embedder_runtime_state (singleton, active_generation, active_model_name, pending_generation, pending_model_name, config_version, retrieval_mode, updated_at, updated_by_email) VALUES (true, 1, 'qwen3-embed-0.6b', NULL, NULL, 1, 'fallback', '2026-06-03 20:13:32.058247+00', 'migration-seed');


--
-- Data for Name: feedback_events_default; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: feedback_events_p20260401; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: feedback_events_p20260501; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: feedback_events_p20260601; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: feedback_events_p20260701; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: feedback_events_p20260801; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: fix_prompts; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: flag_revisions; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: flags; Type: TABLE DATA; Schema: core; Owner: -
--

INSERT INTO core.flags (flag_name, description, enabled, rollout, variants, scope, scope_id, expires_at, created_by_ad_user_id, created_at, updated_at, value_json, last_changed_at, last_changed_by_user_id, pending_second_approver, pending_first_approver_user_id, pending_value_json, pending_set_at) VALUES ('bedrock_global_daily_cap_cents', 'Global daily Bedrock spend cap in cents. Worker pre-call check refuses calls when today''s accumulated cost would exceed this. Default 500_000 cents = $5,000/day for v0.', true, '{"value": 500000}', NULL, 'global', NULL, NULL, NULL, '2026-06-03 20:13:31.080799+00', '2026-06-03 20:13:31.080799+00', '{"value": 500000}', '2026-06-03 20:13:31.080799+00', NULL, false, NULL, NULL, NULL);
INSERT INTO core.flags (flag_name, description, enabled, rollout, variants, scope, scope_id, expires_at, created_by_ad_user_id, created_at, updated_at, value_json, last_changed_at, last_changed_by_user_id, pending_second_approver, pending_first_approver_user_id, pending_value_json, pending_set_at) VALUES ('bedrock_per_org_daily_cap_cents', 'Per-org daily Bedrock spend cap in cents. Default 100_000 = $1,000/day per org. Specific orgs can override at scope_type=''installation'' with their own row.', true, '{"value": 100000}', NULL, 'global', NULL, NULL, NULL, '2026-06-03 20:13:31.080799+00', '2026-06-03 20:13:31.080799+00', '{"value": 100000}', '2026-06-03 20:13:31.080799+00', NULL, false, NULL, NULL, NULL);
INSERT INTO core.flags (flag_name, description, enabled, rollout, variants, scope, scope_id, expires_at, created_by_ad_user_id, created_at, updated_at, value_json, last_changed_at, last_changed_by_user_id, pending_second_approver, pending_first_approver_user_id, pending_value_json, pending_set_at) VALUES ('bedrock_global_kill_switch', 'Emergency global Bedrock kill switch. When True, every Bedrock call refuses with BedrockBudgetExceededError. Restoration requires platform_owner action. See docs/runbooks/cost-incident.md.', false, '{}', NULL, 'global', NULL, NULL, NULL, '2026-06-03 20:13:31.080799+00', '2026-06-03 20:13:31.080799+00', 'false', '2026-06-03 20:13:31.080799+00', NULL, false, NULL, NULL, NULL);


--
-- Data for Name: flags_archive_0090; Type: TABLE DATA; Schema: core; Owner: -
--

INSERT INTO core.flags_archive_0090 (flag_name, description, enabled, rollout, variants, scope, scope_id, expires_at, created_by_ad_user_id, created_at, updated_at, value_json, last_changed_at, last_changed_by_user_id, pending_second_approver, pending_first_approver_user_id, pending_value_json, pending_set_at) VALUES ('pull_requests_v1_enabled', '', false, '{"enabled": false}', NULL, 'global', NULL, NULL, NULL, '2026-06-03 20:13:31.080799+00', '2026-06-03 20:13:31.080799+00', '', '2026-06-03 20:13:31.080799+00', NULL, false, NULL, NULL, NULL);
INSERT INTO core.flags_archive_0090 (flag_name, description, enabled, rollout, variants, scope, scope_id, expires_at, created_by_ad_user_id, created_at, updated_at, value_json, last_changed_at, last_changed_by_user_id, pending_second_approver, pending_first_approver_user_id, pending_value_json, pending_set_at) VALUES ('pr_files_v1', '', false, '{"enabled": false}', NULL, 'global', NULL, NULL, NULL, '2026-06-03 20:13:31.080799+00', '2026-06-03 20:13:31.080799+00', '', '2026-06-03 20:13:31.080799+00', NULL, false, NULL, NULL, NULL);
INSERT INTO core.flags_archive_0090 (flag_name, description, enabled, rollout, variants, scope, scope_id, expires_at, created_by_ad_user_id, created_at, updated_at, value_json, last_changed_at, last_changed_by_user_id, pending_second_approver, pending_first_approver_user_id, pending_value_json, pending_set_at) VALUES ('pr_issue_links_v1', '', false, '{"enabled": false}', NULL, 'global', NULL, NULL, NULL, '2026-06-03 20:13:31.080799+00', '2026-06-03 20:13:31.080799+00', '', '2026-06-03 20:13:31.080799+00', NULL, false, NULL, NULL, NULL);
INSERT INTO core.flags_archive_0090 (flag_name, description, enabled, rollout, variants, scope, scope_id, expires_at, created_by_ad_user_id, created_at, updated_at, value_json, last_changed_at, last_changed_by_user_id, pending_second_approver, pending_first_approver_user_id, pending_value_json, pending_set_at) VALUES ('review_findings_persisted_v1', '', false, '{"enabled": false}', NULL, 'global', NULL, NULL, NULL, '2026-06-03 20:13:31.080799+00', '2026-06-03 20:13:31.080799+00', '', '2026-06-03 20:13:31.080799+00', NULL, false, NULL, NULL, NULL);


--
-- Data for Name: gh_users; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: github_issues_cache; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: global_config; Type: TABLE DATA; Schema: core; Owner: -
--

INSERT INTO core.global_config (id, current_revision_id, updated_at) VALUES (1, NULL, '2026-06-03 20:13:31.080799+00');


--
-- Data for Name: integrations; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: knowledge_chunks; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: learning_proposals; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: learnings; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: learnings_revisions; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: llm_models; Type: TABLE DATA; Schema: core; Owner: -
--

INSERT INTO core.llm_models (provider, model_id, display_name, enabled, last_validation_status, last_validation_error, last_validated_at, created_at, updated_at, created_by_user_id) VALUES ('anthropic_direct', 'claude-sonnet-4-6', NULL, true, 'untested', NULL, NULL, '2026-06-03 20:13:32.058247+00', '2026-06-03 20:13:32.058247+00', NULL);
INSERT INTO core.llm_models (provider, model_id, display_name, enabled, last_validation_status, last_validation_error, last_validated_at, created_at, updated_at, created_by_user_id) VALUES ('anthropic_direct', 'claude-opus-4-7', NULL, true, 'untested', NULL, NULL, '2026-06-03 20:13:32.058247+00', '2026-06-03 20:13:32.058247+00', NULL);
INSERT INTO core.llm_models (provider, model_id, display_name, enabled, last_validation_status, last_validation_error, last_validated_at, created_at, updated_at, created_by_user_id) VALUES ('anthropic_direct', 'claude-haiku-4-5-20251001', NULL, true, 'untested', NULL, NULL, '2026-06-03 20:13:32.058247+00', '2026-06-03 20:13:32.058247+00', NULL);


--
-- Data for Name: llm_provider_settings; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: llm_purpose_model; Type: TABLE DATA; Schema: core; Owner: -
--

INSERT INTO core.llm_purpose_model (purpose, model_id, updated_at, updated_by_user_id) VALUES ('review_finding', 'claude-sonnet-4-6', '2026-06-03 20:13:32.058247+00', NULL);
INSERT INTO core.llm_purpose_model (purpose, model_id, updated_at, updated_by_user_id) VALUES ('walkthrough', 'claude-opus-4-7', '2026-06-03 20:13:32.058247+00', NULL);
INSERT INTO core.llm_purpose_model (purpose, model_id, updated_at, updated_by_user_id) VALUES ('analysis_curator', 'claude-haiku-4-5-20251001', '2026-06-03 20:13:32.058247+00', NULL);


--
-- Data for Name: local_users; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: notification_rules; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: org_configs; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: pull_request_reviews; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: review_runs; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: outbox; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: platform_config; Type: TABLE DATA; Schema: core; Owner: -
--

INSERT INTO core.platform_config (config_key, config_value, updated_at, updated_by) VALUES ('max_default_chunks_per_space', '25', '2026-06-03 20:13:31.998976+00', NULL);
INSERT INTO core.platform_config (config_key, config_value, updated_at, updated_by) VALUES ('max_default_corpus_tokens', '50000', '2026-06-03 20:13:31.998976+00', NULL);
INSERT INTO core.platform_config (config_key, config_value, updated_at, updated_by) VALUES ('staleness_threshold_days_default', '180', '2026-06-03 20:13:31.998976+00', NULL);
INSERT INTO core.platform_config (config_key, config_value, updated_at, updated_by) VALUES ('staleness_threshold_days_security_policy', '90', '2026-06-03 20:13:31.998976+00', NULL);
INSERT INTO core.platform_config (config_key, config_value, updated_at, updated_by) VALUES ('retrieval_trace_sampling_rate_ok', '0.10', '2026-06-03 20:13:31.998976+00', NULL);
INSERT INTO core.platform_config (config_key, config_value, updated_at, updated_by) VALUES ('retrieval_trace_sampling_rate_error', '1.0', '2026-06-03 20:13:31.998976+00', NULL);
INSERT INTO core.platform_config (config_key, config_value, updated_at, updated_by) VALUES ('per_label_cap', '50', '2026-06-03 20:13:31.998976+00', NULL);
INSERT INTO core.platform_config (config_key, config_value, updated_at, updated_by) VALUES ('per_tier_min', '20', '2026-06-03 20:13:31.998976+00', NULL);
INSERT INTO core.platform_config (config_key, config_value, updated_at, updated_by) VALUES ('global_cap', '150', '2026-06-03 20:13:31.998976+00', NULL);
INSERT INTO core.platform_config (config_key, config_value, updated_at, updated_by) VALUES ('confluence_retrieval_enabled_percent', '0.0', '2026-06-03 20:13:31.998976+00', NULL);
INSERT INTO core.platform_config (config_key, config_value, updated_at, updated_by) VALUES ('default_pool_token_reservation_pct', '0.15', '2026-06-03 20:13:32.043873+00', NULL);


--
-- Data for Name: platform_credentials_meta; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: posted_reviews; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: posted_reviews_archive; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: pull_requests; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: pr_files; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: pr_issue_links; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: pr_review_mutex; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: pr_state_transitions; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: repo_configs; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: repo_symbols; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: retrieval_traces; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: review_findings; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: review_policy_bundles; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: review_tool_runs; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: review_walkthroughs; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: role_grant_pending; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: role_grants; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: symbol_references; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: taxonomy_suggestions; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: teams; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: team_memberships; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: worker_heartbeats; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: workspace_leases; Type: TABLE DATA; Schema: core; Owner: -
--



--
-- Data for Name: cost_daily; Type: TABLE DATA; Schema: telemetry; Owner: -
--



--
-- Data for Name: llm_calls_daily; Type: TABLE DATA; Schema: telemetry; Owner: -
--



--
-- Data for Name: llm_calls_default; Type: TABLE DATA; Schema: telemetry; Owner: -
--



--
-- Data for Name: llm_calls_p20260506; Type: TABLE DATA; Schema: telemetry; Owner: -
--



--
-- Data for Name: llm_calls_p20260513; Type: TABLE DATA; Schema: telemetry; Owner: -
--



--
-- Data for Name: llm_calls_p20260520; Type: TABLE DATA; Schema: telemetry; Owner: -
--



--
-- Data for Name: llm_calls_p20260527; Type: TABLE DATA; Schema: telemetry; Owner: -
--



--
-- Data for Name: llm_calls_p20260603; Type: TABLE DATA; Schema: telemetry; Owner: -
--



--
-- Data for Name: llm_calls_p20260610; Type: TABLE DATA; Schema: telemetry; Owner: -
--



--
-- Data for Name: llm_calls_p20260617; Type: TABLE DATA; Schema: telemetry; Owner: -
--



--
-- Data for Name: llm_calls_p20260624; Type: TABLE DATA; Schema: telemetry; Owner: -
--



--
-- Data for Name: llm_calls_p20260701; Type: TABLE DATA; Schema: telemetry; Owner: -
--



--
-- Data for Name: llm_payloads_default; Type: TABLE DATA; Schema: telemetry; Owner: -
--



--
-- Data for Name: llm_payloads_p20260401; Type: TABLE DATA; Schema: telemetry; Owner: -
--



--
-- Data for Name: llm_payloads_p20260501; Type: TABLE DATA; Schema: telemetry; Owner: -
--



--
-- Data for Name: llm_payloads_p20260601; Type: TABLE DATA; Schema: telemetry; Owner: -
--



--
-- Data for Name: llm_payloads_p20260701; Type: TABLE DATA; Schema: telemetry; Owner: -
--



--
-- Data for Name: llm_payloads_p20260801; Type: TABLE DATA; Schema: telemetry; Owner: -
--



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


