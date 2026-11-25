CREATE TYPE "BankAccountStatus" AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');
CREATE TYPE "BankOperationStatus" AS ENUM ('PENDING', 'POSTED', 'REJECTED');
CREATE TYPE "BankOperationType" AS ENUM (
    'TREASURY_FUNDING',
    'TREASURY_ADJUSTMENT',
    'WALLET_CREDIT',
    'WALLET_DEBIT'
);
CREATE TYPE "BankOperationDirection" AS ENUM ('INCREASE', 'DECREASE');

CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountIdentifier" TEXT NOT NULL,
    "status" "BankAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "frozenAt" TIMESTAMP(3),
    "frozenById" TEXT,
    "statusReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BankAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BankAccount_frozenById_fkey" FOREIGN KEY ("frozenById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "BankOperation" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "type" "BankOperationType" NOT NULL,
    "direction" "BankOperationDirection",
    "status" "BankOperationStatus" NOT NULL DEFAULT 'PENDING',
    "userId" TEXT,
    "amount" DECIMAL(30,10) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "sourceClassification" VARCHAR(64) NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "initiatedById" TEXT,
    "reviewedById" TEXT,
    "ledgerTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    CONSTRAINT "BankOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BankOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BankOperation_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BankOperation_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BankOperation_ledgerTransactionId_fkey" FOREIGN KEY ("ledgerTransactionId") REFERENCES "LedgerTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BankOperation_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "BankOperation_direction_valid" CHECK (
        ("type" = 'TREASURY_ADJUSTMENT' AND "direction" IS NOT NULL)
        OR ("type" <> 'TREASURY_ADJUSTMENT' AND "direction" IS NULL)
    ),
    CONSTRAINT "BankOperation_customer_valid" CHECK (
        "type" IN ('WALLET_CREDIT', 'WALLET_DEBIT')
        OR ("type" IN ('TREASURY_FUNDING', 'TREASURY_ADJUSTMENT') AND "userId" IS NULL)
    )
);

CREATE UNIQUE INDEX "BankAccount_userId_key" ON "BankAccount"("userId");
CREATE UNIQUE INDEX "BankAccount_accountIdentifier_key" ON "BankAccount"("accountIdentifier");
CREATE INDEX "BankAccount_status_createdAt_idx" ON "BankAccount"("status", "createdAt");
CREATE UNIQUE INDEX "BankOperation_reference_key" ON "BankOperation"("reference");
CREATE UNIQUE INDEX "BankOperation_idempotencyKey_key" ON "BankOperation"("idempotencyKey");
CREATE UNIQUE INDEX "BankOperation_ledgerTransactionId_key" ON "BankOperation"("ledgerTransactionId");
CREATE INDEX "BankOperation_status_createdAt_idx" ON "BankOperation"("status", "createdAt");
CREATE INDEX "BankOperation_type_createdAt_idx" ON "BankOperation"("type", "createdAt");
CREATE INDEX "BankOperation_userId_createdAt_idx" ON "BankOperation"("userId", "createdAt");

ALTER TABLE "BankAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BankOperation" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "BankAccount", "BankOperation" FROM PUBLIC, anon, authenticated;
