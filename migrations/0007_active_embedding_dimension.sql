-- 0007_active_embedding_dimension — record the deployed embedding dimension on the runtime-state
-- singleton (default 1024). The runtime EMBEDDING_DIM is driven by env (CODEMASTER_EMBEDDING_DIMENSION);
-- this column is the explicit DB record of the active corpus width. The pgvector column WIDTHS are sized
-- for a non-default dimension by the pre-ingest one-shot `scripts/set_embedding_dimension.ts` (greenfield
-- only — resizes EMPTY columns before any content is ingested).

ALTER TABLE core.embedder_runtime_state
  ADD COLUMN active_embedding_dimension integer NOT NULL DEFAULT 1024;
