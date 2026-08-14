-- CreateTable
CREATE TABLE "documents" (
    "id" SERIAL NOT NULL,
    "filename" TEXT NOT NULL,
    "stored_path" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "pages" INTEGER,
    "chars" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunks" (
    "id" SERIAL NOT NULL,
    "document_id" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('french', "content")) STORED,

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_filename_key" ON "documents"("filename");

-- CreateIndex
CREATE INDEX "chunks_document_id_idx" ON "chunks"("document_id");

-- GIN index for the full-text search
CREATE INDEX "chunks_search_vector_idx" ON "chunks" USING GIN ("search_vector");

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
