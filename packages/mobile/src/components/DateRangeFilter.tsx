import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, formatDate } from '../theme';

/**
 * WI-124: a collapsible From/To date-range filter shared by the customer
 * Orders, Invoices, and Payments lists. Collapsed by default (the list is the
 * primary content); the header shows the active range. Plain YYYY-MM-DD text
 * inputs — no native DateTimePicker module is installed (see payments.tsx).
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

  const inputStyle = {
    borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14,
    backgroundColor: colors.inputBg, color: colors.text,
  } as const;

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
            <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>From</Text>
            <TextInput
              value={from}
              onChangeText={setFrom}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={inputStyle}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>To</Text>
            <TextInput
              value={to}
              onChangeText={setTo}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={inputStyle}
            />
          </View>
        </View>
      )}
    </View>
  );
}

// Default range helper: last 30 days → today (YYYY-MM-DD).
export function last30Days(): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return { from: from.toISOString().split('T')[0], to: to.toISOString().split('T')[0] };
}
