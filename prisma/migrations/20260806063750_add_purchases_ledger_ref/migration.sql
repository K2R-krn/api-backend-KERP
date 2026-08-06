-- AlterTable
ALTER TABLE "company_profile" ADD COLUMN     "purchases_ledger_id" UUID;

-- CreateIndex
CREATE INDEX "company_profile_purchases_ledger_id_idx" ON "company_profile"("purchases_ledger_id");

-- AddForeignKey
ALTER TABLE "company_profile" ADD CONSTRAINT "company_profile_purchases_ledger_id_fkey" FOREIGN KEY ("purchases_ledger_id") REFERENCES "ledgers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
