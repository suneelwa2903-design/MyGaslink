import { useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, formatDate } from '../theme';
import { DateInput, MIN_DATE_FLOOR, todayLocalIso } from './ui';

/**
 * WI-124: a collapsible From/To date-range filter shared by the customer
 * Orders, Invoices, and Payments lists. Collapsed by default (the list is the
 * primary content); the header shows the active range.
 *
 * P1-3 sweep (2026-06-09): replaced the plain YYYY-MM-DD TextInputs with the
 * canonical `DateInput` component so the customer gets the native iOS modal
 * picker / Android OS dialog instead of typing date strings by hand. The
 * audit doc at docs/DATE-PICKER-AUDIT.md (commit c37fef6) catalogues every
 * call site swept in this commit. minDate = MIN_DATE_FLOOR (1990-01-01) per
 * Q2; maxDate = today per Q2 (no filtering into the future). The "To"
 * picker chains its `minDate` to `from` so the From > To inversion is
 * impossible at the UI layer.
 */
export function DateRangeFilter({
  from, to, setFrom, setTo,
}: {
  from: string;
  to: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
}) {
  const { colors, accent } = useTheme();
  const [open, setOpen] = useState(false);
  const today = todayLocalIso();

  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
      <TouchableOpacity
        onPress={() => setOpen((v) => !v)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Ionicons name="filter-outline" size={16} color={accent.blue} />
        <Text style={{ fontSize: 13, fontWeight: '600', color: accent.blue }}>Filter</Text>
        <Text style={{ fontSize: 12, color: colors.textSecondary }}>
          {formatDate(from)} → {formatDate(to)}
        </Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textSecondary} />
      </TouchableOpacity>

      {open && (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
          <View style={{ flex: 1 }}>
            <DateInput
              label="From"
              value={from}
              onChange={setFrom}
              minDate={MIN_DATE_FLOOR}
              maxDate={to || today}
            />
          </View>
          <View style={{ flex: 1 }}>
            <DateInput
              label="To"
              value={to}
              onChange={setTo}
              minDate={from || MIN_DATE_FLOOR}
              maxDate={today}
            />
          </View>
        </View>
      )}
    </View>
  );
}

// Default range helper: last 30 days → today (YYYY-MM-DD).
//
// P1-3 sweep: both bounds now computed in LOCAL TZ via `todayLocalIso` so the
// default range agrees with the API's local-TZ date validation (see the TZ
// flakiness fix at packages/api/src/__tests__/helpers.ts > today() and
// commit 4300e07). The previous `toISOString().split('T')[0]` returned the
// UTC calendar date; between ~18:30 UTC and 23:59 UTC daily that was one
// calendar day off from IST, and the API rejected the "today/tomorrow"
// boundary cases.
export function last30Days(): { from: string; to: string } {
  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 30);
  const ymd = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  return { from: ymd(fromDate), to: ymd(toDate) };
}
