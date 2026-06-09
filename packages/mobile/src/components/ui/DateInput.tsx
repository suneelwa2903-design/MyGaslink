import { useState } from 'react';
import {
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, {
  DateTimePickerAndroid,
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';

import { useTheme, formatDate } from '../../theme';

/**
 * Shared mobile date input — replaces the YYYY-MM-DD plain TextInput pattern
 * used across the admin screens (orders, finance, dashboard, inventory, more).
 *
 * Looks like the existing styled TextInput rows (border + bg + radius) with a
 * calendar Ionicon on the left and a humanised date (`31 May 2026`) where the
 * value would be — falls back to `placeholder` when value is empty/null.
 *
 * Platform branching:
 *   - Android: imperative `DateTimePickerAndroid.open()` opens the system
 *     dialog directly when the row is tapped. Simple, native-feeling.
 *   - iOS: there is no equivalent imperative API for SDK 54 — the component
 *     must mount inside the tree. We render `<DateTimePicker mode="date"
 *     display="inline">` inside a `<Modal>` with a Done button.
 */
export type DateInputProps = {
  value: string | null;
  onChange: (iso: string) => void;
  label?: string;
  minDate?: string;
  maxDate?: string;
  placeholder?: string;
  disabled?: boolean;
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse YYYY-MM-DD as a *local* Date (avoids the UTC drift you get from
 *  `new Date('YYYY-MM-DD')`, which the platform treats as midnight UTC). */
function parseIsoLocal(iso: string | null | undefined): Date {
  if (!iso || !ISO_RE.test(iso)) return new Date();
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Format a Date back to YYYY-MM-DD using local time. */
function toIsoLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Today as YYYY-MM-DD in the device's LOCAL timezone.
 *
 * Why local-TZ, not UTC: every API path that validates date strings
 * uses `setHours(0, 0, 0, 0)` (local TZ) — see helpers.ts > today() in
 * packages/api and the TZ-flakiness fix at 4300e07. `toISOString()`
 * returns UTC; between ~18:30 UTC and 23:59 UTC daily that's one
 * calendar day off from local IST, which the API rejects. Use this
 * helper anywhere a "max=today" or "default today" is needed so the
 * client and server agree on the calendar day.
 *
 * Exported so the date-input call sites swept by P1-3 use one source
 * of truth — duplicating the `getFullYear/getMonth/getDate` formula
 * across screens drifts.
 */
export function todayLocalIso(): string {
  return toIsoLocal(new Date());
}

/** Lower-bound floor for every date filter in the app. v1.0 has no data
 *  earlier than 2025-01-01; 1990-01-01 is an effectively-unbounded
 *  past floor that simplifies the pickers' min constraint. Per P1-3
 *  Q2/Q3 locks. */
export const MIN_DATE_FLOOR = '1990-01-01';

export function DateInput({
  value,
  onChange,
  label,
  minDate,
  maxDate,
  placeholder = 'Select date',
  disabled = false,
}: DateInputProps) {
  const { colors } = useTheme();
  const [iosOpen, setIosOpen] = useState(false);
  const [iosDraft, setIosDraft] = useState<Date>(() => parseIsoLocal(value));

  const min = minDate ? parseIsoLocal(minDate) : undefined;
  const max = maxDate ? parseIsoLocal(maxDate) : undefined;

  const openAndroid = () => {
    DateTimePickerAndroid.open({
      mode: 'date',
      value: parseIsoLocal(value),
      minimumDate: min,
      maximumDate: max,
      onChange: (event: DateTimePickerEvent, picked?: Date) => {
        if (event.type === 'set' && picked) {
          onChange(toIsoLocal(picked));
        }
      },
    });
  };

  const handlePress = () => {
    if (disabled) return;
    if (Platform.OS === 'android') {
      openAndroid();
    } else {
      setIosDraft(parseIsoLocal(value));
      setIosOpen(true);
    }
  };

  const display = value && ISO_RE.test(value) ? formatDate(value) : placeholder;
  const isEmpty = !value || !ISO_RE.test(value);

  return (
    <View>
      {label ? (
        <Text style={[styles.label, { color: colors.textSecondary }]}>{label}</Text>
      ) : null}

      <TouchableOpacity
        activeOpacity={disabled ? 1 : 0.7}
        onPress={handlePress}
        style={[
          styles.row,
          {
            backgroundColor: colors.inputBg,
            borderColor: colors.inputBorder,
            opacity: disabled ? 0.5 : 1,
          },
        ]}
      >
        <Ionicons name="calendar-outline" size={14} color={colors.textMuted} />
        <Text
          style={[
            styles.value,
            { color: isEmpty ? colors.textMuted : colors.text },
          ]}
          numberOfLines={1}
        >
          {display}
        </Text>
      </TouchableOpacity>

      {/* iOS modal picker — Android uses the imperative API and never mounts this. */}
      {Platform.OS === 'ios' && (
        <Modal
          visible={iosOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setIosOpen(false)}
        >
          <View style={styles.iosBackdrop}>
            <View style={[styles.iosSheet, { backgroundColor: colors.cardBg }]}>
              <DateTimePicker
                mode="date"
                display="inline"
                value={iosDraft}
                minimumDate={min}
                maximumDate={max}
                onChange={(_event: DateTimePickerEvent, picked?: Date) => {
                  if (picked) setIosDraft(picked);
                }}
              />
              <View style={styles.iosButtonRow}>
                <TouchableOpacity
                  onPress={() => setIosOpen(false)}
                  style={styles.iosBtn}
                >
                  <Text style={[styles.iosBtnText, { color: colors.textSecondary }]}>
                    Cancel
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => {
                    onChange(toIsoLocal(iosDraft));
                    setIosOpen(false);
                  }}
                  style={styles.iosBtn}
                >
                  <Text style={[styles.iosBtnText, { color: '#e11d1d', fontWeight: '700' }]}>
                    Done
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 11,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    minHeight: 40,
  },
  value: {
    flex: 1,
    fontSize: 14,
  },
  iosBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  iosSheet: {
    borderRadius: 14,
    padding: 12,
  },
  iosButtonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 4,
  },
  iosBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  iosBtnText: {
    fontSize: 15,
  },
});
