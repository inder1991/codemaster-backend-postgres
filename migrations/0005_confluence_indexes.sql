-- 0005_confluence_indexes — F13 (P1-K + P2-9): indexes for the Confluence corpus.
--
-- P2-9: reconcileDeletions filters `space_key = $1 AND deleted_at IS NULL AND NOT (page_id = ANY(...))`,
-- but the only btree on confluence_chunks led with (page_id, version) — so every per-space reconcile pass
-- SEQ-SCANNED the entire platform-wide corpus. A partial (space_key) index on the live rows fixes it.
--
-- P1-K: an HNSW index on confluence_chunks.embedding over the LIVE rows (the retrieval filter:
-- superseded_at IS NULL AND deleted_at IS NULL AND quarantined=false). NOTE: the production `fallback`
-- retrieval mode orders by `COALESCE(ce.embedding, cc.embedding) <=> qvec`, and a COALESCE expression is
-- NOT index-sargable — so this index serves the direct/legacy cc.embedding query path, not the COALESCE.
-- The production-scale target is `generation_only` retrieval, which orders by core.chunk_embeddings.embedding
-- (already covered by chunk_embeddings_hnsw_idx from the baseline); `fallback` should be treated as a
-- bootstrap/transition mode, not steady-state at scale. FOLLOW-UP-confluence-fallback-coalesce-or-cutover.
--
-- Plain (non-CONCURRENT) CREATE INDEX: like the 0001 baseline, these run at deploy time on a
-- fresh/migrating DB (no live concurrent writers), and node-pg-migrate wraps each migration in a txn.

CREATE INDEX IF NOT EXISTS confluence_chunks_space_key_live
  ON core.confluence_chunks (space_key)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS confluence_chunks_embedding_hnsw_live
  ON core.confluence_chunks USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64')
  WHERE superseded_at IS NULL AND deleted_at IS NULL AND quarantined = false;
