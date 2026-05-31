import type { ReactNode } from 'react';
import { ScrollView, TouchableOpacity, View, Text, Platform } from 'react-native';

import { useTheme, ACCENT } from '../../theme';

// STAGE-H: @react-navigation/bottom-tabs ships with expo-router but isn't a
// direct dependency of this package, so we type the tabBar props minimally
// here against the shape Expo Router actually passes (state + descriptors +
// navigation). This avoids pinning to a specific RN-navigation version and
// keeps tsc happy without a `@react-navigation/bottom-tabs` import.

interface TabBarRoute {
  key: string;
  name: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => unknown;

interface TabBarOptions {
  title?: string;
  // Accept any callable for tabBarLabel — we only consume the string form,
  // but the upstream @react-navigation typing has a richer signature
  // (focused/color/position/children) and a stricter type here would prevent
  // BottomTabDescriptor from being assignable into our minimal record.
  tabBarLabel?: string | AnyFn;
  tabBarIcon?: (props: { focused: boolean; color: string; size: number }) => ReactNode;
  tabBarAccessibilityLabel?: string;
  tabBarButtonTestID?: string;
  // Expo Router's `href: null` opts a screen out of the visible tab bar but
  // keeps it routable. The plain @react-navigation typing doesn't include it,
  // so we widen the options bag here.
  href?: string | null;
}

interface TabBarDescriptor {
  options: TabBarOptions;
}

interface TabBarNavigation {
  // The real React-Navigation `emit` returns `EventArg<…>` which has
  // `defaultPrevented?` among many other fields; declaring it as a generic
  // function avoids a brittle structural match against that internal type.
  emit: AnyFn;
  navigate: AnyFn;
}

export interface ScrollableTabBarProps {
  state: { index: number; routes: readonly TabBarRoute[] };
  descriptors: Record<string, TabBarDescriptor>;
  navigation: TabBarNavigation;
}

/**
 * STAGE-H: custom scrollable bottom tab bar for the admin layout.
 *
 * React Navigation's default tab bar packs N tabs into the available width and
 * starts truncating labels / merging icons around 6+ items. The admin layout
 * grew to 9 tabs (dashboard, orders, billing, inventory, reports, customers,
 * fleet, collections, more) which the default bar can't render legibly.
 *
 * This bar replaces the default with a horizontal <ScrollView> of equal-width
 * fixed-min tabs. Active tab gets the red accent (icon + label + top
 * underline); inactive uses muted/secondary text. Tabs whose options carry
 * `href: null` (the React Navigation convention for "hidden from the tab bar
 * but still routable") are skipped.
 *
 * On press/long-press we dispatch the standard React Navigation events so the
 * router's behaviour (focus, scroll-to-top, etc.) is unchanged.
 */
export function ScrollableTabBar({
  state,
  descriptors,
  navigation,
}: ScrollableTabBarProps) {
  const { dark, colors } = useTheme();
  const activeColor = ACCENT.red;
  const inactiveColor = dark ? '#94a3b8' : '#94a3b8';

  // Filter routes that opt out of the visible bar via `href: null`.
  const visibleRoutes = state.routes.filter((route) => {
    const opts = descriptors[route.key]?.options;
    return opts?.href !== null;
  });

  return (
    <View
      style={{
        backgroundColor: colors.bg,
        borderTopWidth: 1,
        borderTopColor: colors.cardBorder,
        // Match the existing tab-bar height (theme.ts:119) plus iOS home-bar
        // safe area. The 8/12 paddings keep tappable area comfortable.
        paddingTop: 6,
        paddingBottom: Platform.OS === 'ios' ? 8 : 6,
        height: 64,
      }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          alignItems: 'stretch',
          paddingHorizontal: 4,
        }}
      >
        {visibleRoutes.map((route) => {
          const { options } = descriptors[route.key];
          const focusedIndex = state.index;
          const focused = state.routes[focusedIndex]?.key === route.key;

          // Prefer the static string label; fall back to title; fall back to
          // route name. The function form of tabBarLabel (focused-aware
          // colored text) isn't worth replicating here because we colour the
          // label ourselves from the focused flag.
          const labelOpt = options.tabBarLabel;
          const label =
            typeof labelOpt === 'string'
              ? labelOpt
              : typeof options.title === 'string'
                ? options.title
                : route.name;

          const onPress = () => {
            // emit returns React-Navigation's EventArg which carries a
            // `defaultPrevented?: boolean`. We narrow with a guard rather
            // than pin the upstream type.
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            }) as { defaultPrevented?: boolean } | undefined;
            if (!focused && !event?.defaultPrevented) {
              navigation.navigate(route.name);
            }
          };

          const onLongPress = () => {
            navigation.emit({
              type: 'tabLongPress',
              target: route.key,
            });
          };

          // The icon descriptor returns a React node; pass through standard
          // focused/color/size so each screen's tabBarIcon function works
          // unchanged. Width-clamped so 9 evenly-spaced items still fit
          // comfortably on a 360dp screen and the scroll triggers gracefully.
          return (
            <TouchableOpacity
              key={route.key}
              accessibilityRole="button"
              accessibilityState={focused ? { selected: true } : {}}
              accessibilityLabel={options.tabBarAccessibilityLabel ?? label}
              testID={options.tabBarButtonTestID}
              onPress={onPress}
              onLongPress={onLongPress}
              activeOpacity={0.7}
              style={{
                minWidth: 76,
                paddingHorizontal: 10,
                alignItems: 'center',
                justifyContent: 'flex-start',
                gap: 2,
                // 2px top underline keeps height stable between focused/unfocused.
                borderTopWidth: 2,
                borderTopColor: focused ? activeColor : 'transparent',
                paddingTop: 4,
              }}
            >
              {options.tabBarIcon
                ? options.tabBarIcon({
                    focused,
                    color: focused ? activeColor : inactiveColor,
                    size: 22,
                  })
                : null}
              <Text
                style={{
                  fontSize: 10.5,
                  fontWeight: focused ? '700' : '600',
                  color: focused ? activeColor : colors.textSecondary,
                  textAlign: 'center',
                }}
                numberOfLines={1}
              >
                {label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}
