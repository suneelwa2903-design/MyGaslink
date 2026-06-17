/**
 * Tally Export — Reports-page card.
 *
 * Two states:
 *  1. Not configured (no TallySettings row OR backend says isConfigured=false)
 *     → yellow banner with a link to /app/settings?tab=tally. We hide the
 *     download button entirely; users must finish setup first so the export
 *     uses their actual ledger / voucher-type / cylinder-mapping names rather
 *     than the schema defaults.
 *  2. Configured → button to download the Tally XML for the date range the
 *     user picked at the top of ReportsPage. Re-uses the same blob-download
 *     pattern as the CSV button on the same page.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  HiOutlineExclamationTriangle,
  HiOutlineArrowDownTray,
  HiOutlineCheckCircle,
  HiOutlineCalculator,
} from 'react-icons/hi2';
import { api, apiGet, getErrorMessage } from '@/lib/api';
import { Button, Loader } from '@/components/ui';

interface TallySettingsSummary {
  isConfigured: boolean;
  updatedAt: string | null;
}

interface Props {
  /** Inherited from ReportsPage's outer date filter. */
  dateFrom: string;
  dateTo: string;
}

export default function TallyExportPanel({ dateFrom, dateTo }: Props) {
  const [downloading, setDownloading] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['tally-settings-summary'],
    // Slight contract abuse: we only need the top-level isConfigured /
    // updatedAt fields, but the GET endpoint returns the full settings +
    // cylinderTypes envelope. Cheap enough — fetched once on Reports-page
    // mount and held in cache, so no reason to introduce a second
    // narrower endpoint just for this panel.
    queryFn: () => apiGet<TallySettingsSummary>('/tally-settings'),
  });

  async function handleDownload() {
    setDownloading(true);
    try {
      const res = await api.get('/reports/tally-export', {
        params: { dateFrom, dateTo },
        responseType: 'blob',
      });
      const href = window.URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = href;
      a.download = `tally-export-${dateFrom}_${dateTo}.xml`;
      a.click();
      window.URL.revokeObjectURL(href);
      toast.success('Tally export downloaded');
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setDownloading(false);
    }
  }

  if (isLoading) {
    return (
      <div className="card p-4 flex justify-center">
        <Loader size="sm" />
      </div>
    );
  }

  const isConfigured = data?.isConfigured ?? false;

  return (
    <div className="card p-5 space-y-3">
      <div className="flex items-center gap-2">
        <HiOutlineCalculator className="h-5 w-5 text-brand-500" />
        <h3 className="font-semibold text-surface-900 dark:text-white">Tally Export</h3>
        {isConfigured && (
          <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
            <HiOutlineCheckCircle className="h-4 w-4" />
            Configured
          </span>
        )}
      </div>

      {!isConfigured ? (
        <div className="flex items-start gap-3 rounded-lg border-l-4 border-l-amber-500 bg-amber-50/40 dark:bg-amber-900/10 p-3">
          <HiOutlineExclamationTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <div className="text-sm text-surface-800 dark:text-surface-200">
            Tally settings not configured.{' '}
            <Link
              to="/app/settings?tab=tally"
              className="text-brand-600 dark:text-brand-400 font-medium hover:underline"
            >
              Set up now →
            </Link>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm text-surface-500 dark:text-surface-400">
            Download a Tally XML payload covering sales, receipts, credit notes,
            and debit notes for the date range above. Import in Tally via
            Gateway of Tally → Import Data.
          </p>
          <div className="flex justify-end">
            <Button onClick={handleDownload} loading={downloading}>
              <HiOutlineArrowDownTray className="h-4 w-4" />
              Download Tally XML
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
