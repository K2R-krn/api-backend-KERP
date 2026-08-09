-- AlterTable
ALTER TABLE "company_profile" ADD COLUMN     "bank_account_group_id" UUID,
ADD COLUMN     "cash_account_group_id" UUID;

-- CreateIndex
CREATE INDEX "company_profile_cash_account_group_id_idx" ON "company_profile"("cash_account_group_id");

-- CreateIndex
CREATE INDEX "company_profile_bank_account_group_id_idx" ON "company_profile"("bank_account_group_id");

-- AddForeignKey
ALTER TABLE "company_profile" ADD CONSTRAINT "company_profile_cash_account_group_id_fkey" FOREIGN KEY ("cash_account_group_id") REFERENCES "account_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_profile" ADD CONSTRAINT "company_profile_bank_account_group_id_fkey" FOREIGN KEY ("bank_account_group_id") REFERENCES "account_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
