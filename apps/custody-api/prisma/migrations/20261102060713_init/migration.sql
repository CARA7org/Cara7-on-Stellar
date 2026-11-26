-- CreateTable
CREATE TABLE "investor" (
    "id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "investor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passkey" (
    "id" TEXT NOT NULL,
    "investor_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "passkey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "investor_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "display_name" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signing_request" (
    "id" TEXT NOT NULL,
    "investor_id" TEXT NOT NULL,
    "dfns_signature_id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "prepared_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "approval_id" TEXT,
    "reason" TEXT,
    "decision" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signing_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "investor_wallet_id_key" ON "investor"("wallet_id");

-- CreateIndex
CREATE UNIQUE INDEX "investor_address_key" ON "investor"("address");

-- CreateIndex
CREATE INDEX "passkey_investor_id_idx" ON "passkey"("investor_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_hash_key" ON "session"("token_hash");

-- CreateIndex
CREATE INDEX "session_investor_id_idx" ON "session"("investor_id");

-- CreateIndex
CREATE INDEX "challenge_expires_at_idx" ON "challenge"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "signing_request_dfns_signature_id_key" ON "signing_request"("dfns_signature_id");

-- CreateIndex
CREATE INDEX "signing_request_investor_id_status_idx" ON "signing_request"("investor_id", "status");

-- AddForeignKey
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_investor_id_fkey" FOREIGN KEY ("investor_id") REFERENCES "investor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_investor_id_fkey" FOREIGN KEY ("investor_id") REFERENCES "investor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signing_request" ADD CONSTRAINT "signing_request_investor_id_fkey" FOREIGN KEY ("investor_id") REFERENCES "investor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
