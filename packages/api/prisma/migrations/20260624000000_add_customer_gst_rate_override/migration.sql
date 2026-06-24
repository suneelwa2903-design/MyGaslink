-- Customer-level GST rate override (5% / 18%). Nullable Float; NULL = use
-- platform default 18%. Application enforces ALLOWED_GST_RATES = [5, 18]
-- at the Zod boundary and again as a runtime guard in invoiceService.
--
-- Invariant preserved by the writer: InvoiceItem.gstRate is snapshotted at
-- invoice-creation time, so changing this field on a Customer later does
-- NOT retroactively alter historic invoices' rates — PDF / IRN / EWB /
-- reports / Tally all read the per-line snapshot.
ALTER TABLE "customers" ADD COLUMN "gst_rate_override" DOUBLE PRECISION;
