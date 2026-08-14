-- AlterTable
ALTER TABLE "deal" ADD COLUMN     "waterfall_contract_id" TEXT;

-- AlterTable
ALTER TABLE "tranche" ADD COLUMN     "coupon_bps" INTEGER NOT NULL DEFAULT 0;
