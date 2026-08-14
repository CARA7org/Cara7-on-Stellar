-- Free-form note attached to a document
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "note" TEXT;

-- Recreate the GIN index when needed: the Prisma diff does not know the
-- generated search_vector column and had dropped this index by mistake.
CREATE INDEX IF NOT EXISTS "chunks_search_vector_idx" ON "chunks" USING GIN ("search_vector");
