ALTER TABLE "Order" ADD COLUMN "settlementCurrency" VARCHAR(8);
ALTER TABLE "Execution" ADD COLUMN "settlementCurrency" VARCHAR(8);
ALTER TABLE "Position" ADD COLUMN "settlementCurrency" VARCHAR(8);
