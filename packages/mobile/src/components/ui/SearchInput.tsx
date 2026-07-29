import { useEffect, useState } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../../theme';

/**
 * Shared mobile search input — debounced free-text filter.
 *
 * The debounced value is what parents pass into their query keys and query
 * params; the immediate value drives the visible input. 300 ms matches the
 * customer-picker debounce in `(admin)/orders.tsx` so it feels the same.
 *
 * Visual: matches DateInput / SelectField chip look — bordered pill row with
 * a magnifier icon on the left and a clear ✕ on the right when non-empty.
 * Not a modal — inline in a screen header.
 */
export type SearchInputProps = {
  /** Current visible text (uncontrolled from the parent's perspective — parent only reads `onDebouncedChange`). */
  value: string;
  onChangeText: (v: string) => void;
  /** Fires with the debounced value 300 ms after the user stops typing. */
  onDebouncedChange: (v: string) => void;
  placeholder?: string;
  debounceMs?: number;
};

export function SearchInput({
  value,
  onChangeText,
  onDebouncedChange,
  placeholder = 'Search…',
  debounceMs = 300,
}: SearchInputProps) {
  const { dark, colors } = useTheme();
  const [localDebounced, setLocalDebounced] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setLocalDebounced(value), debounceMs);
    return () => clearTimeout(t);
  }, [value, debounceMs]);

  useEffect(() => {
    onDebouncedChange(localDebounced);
    // onDebouncedChange is intentionally omitted — parents usually pass an
    // inline lambda that reallocates every render, which would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localDebounced]);

  return (
    <View
      style={[
        styles.wrap,
        {
          backgroundColor: dark ? colors.cardBg : '#ffffff',
          borderColor: colors.inputBorder,
        },
      ]}
    >
      <Ionicons name="search-outline" size={16} color={colors.textMuted} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        style={[styles.input, { color: colors.text }]}
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
      />
      {value.length > 0 && (
        <TouchableOpacity
          onPress={() => {
            onChangeText('');
          }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="close-circle" size={18} color={colors.textMuted} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 38,
  },
  input: {
    flex: 1,
    fontSize: 14,
    padding: 0,
    margin: 0,
  },
});
