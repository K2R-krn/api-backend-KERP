-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "cash_ledger_id" UUID;

-- AlterTable
ALTER TABLE "company_profile" ADD COLUMN     "cgst_ledger_id" UUID,
ADD COLUMN     "igst_ledger_id" UUID,
ADD COLUMN     "round_off_ledger_id" UUID,
ADD COLUMN     "sales_ledger_id" UUID,
ADD COLUMN     "sgst_ledger_id" UUID;

-- CreateIndex
CREATE INDEX "branches_cash_ledger_id_idx" ON "branches"("cash_ledger_id");

-- CreateIndex
CREATE INDEX "company_profile_sales_ledger_id_idx" ON "company_profile"("sales_ledger_id");

-- CreateIndex
CREATE INDEX "company_profile_cgst_ledger_id_idx" ON "company_profile"("cgst_ledger_id");

-- CreateIndex
CREATE INDEX "company_profile_sgst_ledger_id_idx" ON "company_profile"("sgst_ledger_id");

-- CreateIndex
CREATE INDEX "company_profile_igst_ledger_id_idx" ON "company_profile"("igst_ledger_id");

-- CreateIndex
CREATE INDEX "company_profile_round_off_ledger_id_idx" ON "company_profile"("round_off_ledger_id");

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_cash_ledger_id_fkey" FOREIGN KEY ("cash_ledger_id") REFERENCES "ledgers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_profile" ADD CONSTRAINT "company_profile_sales_ledger_id_fkey" FOREIGN KEY ("sales_ledger_id") REFERENCES "ledgers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_profile" ADD CONSTRAINT "company_profile_cgst_ledger_id_fkey" FOREIGN KEY ("cgst_ledger_id") REFERENCES "ledgers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_profile" ADD CONSTRAINT "company_profile_sgst_ledger_id_fkey" FOREIGN KEY ("sgst_ledger_id") REFERENCES "ledgers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_profile" ADD CONSTRAINT "company_profile_igst_ledger_id_fkey" FOREIGN KEY ("igst_ledger_id") REFERENCES "ledgers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_profile" ADD CONSTRAINT "company_profile_round_off_ledger_id_fkey" FOREIGN KEY ("round_off_ledger_id") REFERENCES "ledgers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
