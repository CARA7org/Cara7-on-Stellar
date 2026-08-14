-- CreateTable
CREATE TABLE "deal" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tranche" (
    "id" SERIAL NOT NULL,
    "deal_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "seniority" TEXT NOT NULL,
    "floor_bps" INTEGER NOT NULL,
    "contract_id" TEXT NOT NULL,
    "base_asset_id" TEXT NOT NULL,
    "asset_symbol" TEXT NOT NULL,
    "asset_decimals" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tranche_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stellar_event" (
    "id" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "contract_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "topic" JSONB NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stellar_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_snapshot" (
    "id" SERIAL NOT NULL,
    "contract_id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ledger" INTEGER NOT NULL,
    "nav" DECIMAL(40,0) NOT NULL,
    "total_shares" DECIMAL(40,0) NOT NULL,
    "share_price" DOUBLE PRECISION NOT NULL,
    "alloc_base" DECIMAL(40,0) NOT NULL,
    "alloc_risky" DECIMAL(40,0) NOT NULL,

    CONSTRAINT "vault_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_position" (
    "vault" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "shares" DECIMAL(40,0) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_position_pkey" PRIMARY KEY ("vault","address")
);

-- CreateTable
CREATE TABLE "IngestState" (
    "contract_id" TEXT NOT NULL,
    "last_ledger" INTEGER NOT NULL,

    CONSTRAINT "IngestState_pkey" PRIMARY KEY ("contract_id")
);

-- CreateTable
CREATE TABLE "price_snapshot" (
    "symbol" TEXT NOT NULL,
    "bucket" INTEGER NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "price_usd" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "price_snapshot_pkey" PRIMARY KEY ("symbol","bucket")
);

-- CreateIndex
CREATE UNIQUE INDEX "deal_name_key" ON "deal"("name");

-- CreateIndex
CREATE UNIQUE INDEX "tranche_contract_id_key" ON "tranche"("contract_id");

-- CreateIndex
CREATE INDEX "tranche_deal_id_idx" ON "tranche"("deal_id");

-- CreateIndex
CREATE INDEX "stellar_event_contract_id_ledger_idx" ON "stellar_event"("contract_id", "ledger");

-- CreateIndex
CREATE INDEX "stellar_event_contract_id_type_ledger_idx" ON "stellar_event"("contract_id", "type", "ledger");

-- CreateIndex
CREATE INDEX "vault_snapshot_contract_id_ts_idx" ON "vault_snapshot"("contract_id", "ts");

-- CreateIndex
CREATE INDEX "price_snapshot_symbol_ts_idx" ON "price_snapshot"("symbol", "ts");

-- AddForeignKey
ALTER TABLE "tranche" ADD CONSTRAINT "tranche_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
