-- Migration tranche_class_index.
-- A deal can now have 1 to 8 note classes. The on-chain class index
-- (0..n-1, senior first) becomes a column. The seniority stays a display label.
-- Prisma generated "ADD COLUMN class_index INTEGER NOT NULL", which fails on a
-- table with rows. This script does the same change in safe steps.
-- No step deletes a row.

-- Step 1: add the two columns as nullable. The existing rows stay valid.
ALTER TABLE "tranche" ADD COLUMN "class_index" INTEGER,
ADD COLUMN "rate_kind" TEXT;

-- Step 2: backfill class_index from the seniority label. The rows before this
-- migration come from 3-class deals: SENIOR is class 0, MEZZANINE is class 1,
-- JUNIOR is class 2.
UPDATE "tranche"
SET "class_index" = CASE "seniority"
    WHEN 'SENIOR' THEN 0
    WHEN 'MEZZANINE' THEN 1
    WHEN 'JUNIOR' THEN 2
END;

-- Step 3: backfill rate_kind. Class A (SENIOR) pays a floating rate over
-- EURIBOR 1M. The other classes pay a fixed rate.
UPDATE "tranche"
SET "rate_kind" = CASE WHEN "seniority" = 'SENIOR' THEN 'FLOATING' ELSE 'FIXED' END;

-- Step 4: on a FLOATING row, coupon_bps is now the spread over EURIBOR 1M.
-- The seed stored the all-in rate 2.81 % (281 bps). On chain, class A pays
-- EURIBOR 1M + 0.60 %, so its spread is 60 bps.
UPDATE "tranche"
SET "coupon_bps" = 60
WHERE "rate_kind" = 'FLOATING' AND "coupon_bps" = 281;

-- Step 5: give rate_kind its default value, then make the two columns NOT NULL.
-- This step fails if a row has a seniority outside the three labels.
ALTER TABLE "tranche" ALTER COLUMN "rate_kind" SET DEFAULT 'FIXED',
ALTER COLUMN "rate_kind" SET NOT NULL,
ALTER COLUMN "class_index" SET NOT NULL;

-- Step 6: allow one class index per deal (the index name that Prisma expects).
-- This step fails if one deal has two tranches with the same seniority.
CREATE UNIQUE INDEX "tranche_deal_id_class_index_key" ON "tranche"("deal_id", "class_index");
