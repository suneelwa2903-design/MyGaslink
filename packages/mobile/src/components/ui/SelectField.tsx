import { useState } from 'react';
import {
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../../theme';

/**
 * Shared mobile chip-shaped select dropdown — replaces the horizontal pill-row
 * filter pattern that was used across the admin screens (billing status, IRN
 * status, finance invoice tabs).
 *
 * Looks like the existing DateInput chip (border + bg + radius) with a
 * `{label}: {selectedOptionLabel}` body and a chevron-down Ionicon on the
 * right. Tapping it opens a bottom-sheet modal that lists the options as
 * radio rows; tapping a row selects + closes. A Cancel button at the bottom
 * closes without changing.
 */
export type SelectOption = {
  value: string;
  label: string;
};

export type SelectFieldProps = {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  accent?: string;
  disabled?: boolean;
};

export function SelectField({
  label,
  value,
  options,
  onChange,
  accent,
  disabled = false,
}: SelectFieldProps) {
  const { dark, colors } = useTheme();
  const [open, setOpen] = useState(false);

  const selected = options.find((o) => o.value === value);
  const selectedLabel = selected?.label ?? '';
  // STAGE-A A2: 0.85 backdrop convention so the sheet fully obscures the
  // tab bar (see finance.tsx getColors() comment).
  const overlay = 'rgba(0,0,0,0.85)';
  const sheetBg = dark ? colors.cardBg : colors.bg;
  const accentColor = accent ?? '#e11d1d';

  const handleSelect = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <>
      <TouchableOpacity
        activeOpacity={disabled ? 1 : 0.7}
        onPress={() => {
          if (disabled) return;
          setOpen(true);
        }}
        style={[
          styles.row,
          {
            backgroundColor: colors.inputBg,
            borderColor: colors.inputBorder,
            opacity: disabled ? 0.5 : 1,
          },
        ]}
      >
        <Text
          style={[styles.value, { color: colors.text }]}
          numberOfLines={1}
        >
          <Text style={{ color: colors.textSecondary, fontWeight: '500' }}>
            {label}:{' '}
          </Text>
          {selectedLabel}
        </Text>
        <Ionicons
          name="chevron-down-outline"
          size={14}
          color={colors.textMuted}
        />
      </TouchableOpacity>

      <Modal
        visible={open}
        animationType="slide"
        transparent
        onRequestClose={() => setOpen(false)}
      >
        <View style={[styles.backdrop, { backgroundColor: overlay }]}>
          <View
            style={[
              styles.sheet,
              {
                backgroundColor: sheetBg,
                paddingBottom: Platform.OS === 'ios' ? 36 : 24,
              },
            ]}
          >
            <View
              style={[styles.handle, { backgroundColor: colors.divider }]}
            />
            <View style={styles.header}>
              <Text style={[styles.title, { color: colors.text }]}>
                {label}
              </Text>
              <TouchableOpacity
                onPress={() => setOpen(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: 360 }}>
              {options.map((opt) => {
                const active = opt.value === value;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    onPress={() => handleSelect(opt.value)}
                    style={[
                      styles.option,
                      { borderBottomColor: colors.divider },
                    ]}
                  >
                    <Ionicons
                      name={
                        active ? 'radio-button-on' : 'radio-button-off'
                      }
                      size={20}
                      color={active ? accentColor : colors.textMuted}
                    />
                    <Text
                      style={[
                        styles.optionLabel,
                        {
                          color: active ? colors.text : colors.text,
                          fontWeight: active ? '700' : '500',
                        },
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <TouchableOpacity
              onPress={() => setOpen(false)}
              style={[
                styles.cancelBtn,
                { backgroundColor: dark ? '#334155' : '#f1f5f9' },
              ]}
            >
              <Text
                style={[styles.cancelLabel, { color: colors.text }]}
              >
                Cancel
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 40,
  },
  value: {
    flex: 1,
    fontSize: 14,
  },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    marginBottom: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  title: {
    fontSize: 16,
    fontWeight: '800',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  optionLabel: {
    flex: 1,
    fontSize: 15,
  },
  cancelBtn: {
    marginTop: 14,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  cancelLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
});
