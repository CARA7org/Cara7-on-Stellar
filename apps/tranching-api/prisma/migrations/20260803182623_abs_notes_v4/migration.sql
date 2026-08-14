/*
  Warnings:

  - You are about to drop the column `last_stream_at` on the `deal` table. All the data in the column will be lost.
  - You are about to drop the column `waterfall_contract_id` on the `deal` table. All the data in the column will be lost.
  - You are about to drop the column `floor_bps` on the `tranche` table. All the data in the column will be lost.
  - The primary key for the `user_position` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `shares` on the `user_position` table. All the data in the column will be lost.
  - You are about to drop the column `vault` on the `user_position` table. All the data in the column will be lost.
  - You are about to drop the `vault_snapshot` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `original_face` to the `tranche` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tranche` to the `user_position` table without a default value. This is not possible if the table is not empty.
  - Added the required column `units` to the `user_position` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "deal" DROP COLUMN "last_stream_at",
DROP COLUMN "waterfall_contract_id",
ADD COLUMN     "closed_at" TIMESTAMP(3),
ADD COLUMN     "deal_contract_id" TEXT,
ADD COLUMN     "paying_agent_contract_id" TEXT;

-- AlterTable
ALTER TABLE "tranche" DROP COLUMN "floor_bps",
ADD COLUMN     "original_face" DECIMAL(40,0) NOT NULL;

-- AlterTable
ALTER TABLE "user_position" DROP CONSTRAINT "user_position_pkey",
DROP COLUMN "shares",
DROP COLUMN "vault",
ADD COLUMN     "interest_received" DECIMAL(40,0) NOT NULL DEFAULT 0,
ADD COLUMN     "principal_received" DECIMAL(40,0) NOT NULL DEFAULT 0,
ADD COLUMN     "subscribed" DECIMAL(40,0) NOT NULL DEFAULT 0,
ADD COLUMN     "tranche" TEXT NOT NULL,
ADD COLUMN     "units" DECIMAL(40,0) NOT NULL,
ADD CONSTRAINT "user_position_pkey" PRIMARY KEY ("tranche", "address");

-- DropTable
DROP TABLE "vault_snapshot";

-- CreateTable
CREATE TABLE "tranche_snapshot" (
    "id" SERIAL NOT NULL,
    "contract_id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ledger" INTEGER NOT NULL,
    "outstanding" DECIMAL(40,0) NOT NULL,
    "note_factor" INTEGER NOT NULL,
    "coupon_rate_units" INTEGER NOT NULL,
    "paid_interest_cum" DECIMAL(40,0) NOT NULL,
    "paid_principal_cum" DECIMAL(40,0) NOT NULL,

    CONSTRAINT "tranche_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tranche_snapshot_contract_id_ts_idx" ON "tranche_snapshot"("contract_id", "ts");
