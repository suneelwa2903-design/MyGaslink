/**
 * GST Filing Export — Reports-page card.
 *
 * Downloads a multi-sheet .xlsx (GST_Summary + Invoices + InvoiceLines +
 * Customers + Payments + CylinderBalances) for a chosen month. The month
 * picker defaults to the previous calendar month (GSTR-1 filing is done
 * for the completed month, not the running one). Uses the same blob-download
 * pattern as TallyExportPanel.
 */
import { useState } from 'react';
import toast from 'react-hot-toast';
import { HiOutlineArrowDownTray, HiOutlineDocumentChartBar } from 'react-icons/hi2';
import { api, getErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui';

/** Previous calendar month as 'YYYY-MM' in local TZ. */
function previousMonthISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-11 — subtracting 1 with wrap
  const target = new Date(y, m - 1, 1);
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`;
}

export default function GstFilingExportPanel() {
  const [month, setMonth] = useState<string>(previousMonthISO());
  const [downloading, setDownloading] = useState(false);

  async function handleDownload() {
    setDownloading(true);
    try {
      const res = await api.get('/reports/gst-filing-export', {
        params: { month },
        responseType: 'blob',
      });
      const href = window.URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = href;
      a.download = `gst-filing-${month}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(href);
      toast.success('GST filing export downloaded');
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="card p-5 space-y-3">
      <div className="flex items-center gap-2">
        <HiOutlineDocumentChartBar className="h-5 w-5 text-brand-500" />
        <h3 className="font-semibold text-surface-900 dark:text-white">GST Filing Export</h3>
      </div>
      <p className="text-sm text-surface-500 dark:text-surface-400">
        Multi-sheet Excel for GSTR-1 preparation: HSN summary, invoice register,
        line-items, customers, payments, and cylinder balances. Excludes cancelled
        invoices and opening-balance entries.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label text-xs">Month</label>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="input h-9"
          />
        </div>
        <div className="flex-1" />
        <Button onClick={handleDownload} loading={downloading} disabled={!month}>
          <HiOutlineArrowDownTray className="h-4 w-4" />
          Download .xlsx
        </Button>
      </div>
    </div>
  );
}
