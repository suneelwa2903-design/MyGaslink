/**
 * Metro config for @gaslink/mobile (2026-07-16).
 *
 * Purpose: force ALL React-family package imports to resolve to the
 * SINGLE copy under this package's node_modules, regardless of which
 * sub-dependency imports them. Without this, pnpm's isolated store
 * can serve DIFFERENT React copies to different libraries — e.g.
 * react-native-webview may resolve `react@19.2.4` (via a react-dom
 * peer chain that some transitive dev-dep pulls) while the RN Fabric
 * renderer is bound to `react@19.1.0`. The result is the classic
 * "Invalid hook call — you might have more than one copy of React"
 * cascade on any forwardRef+hooks library.
 *
 * The earlier version of this file had a resolveRequest override that
 * called require.resolve at bundle time. On this Windows + pnpm setup
 * it caused Metro to hang mid-response (TCP connect succeeded but no
 * HTTP body came back). The simpler extraNodeModules-only pattern
 * below is what Expo's own monorepo docs recommend and works reliably.
 */
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '..', '..');

const config = getDefaultConfig(projectRoot);

// Watch the whole monorepo so shared packages (packages/shared) hot-reload.
config.watchFolders = [monorepoRoot];

// Prefer this package's node_modules first, then the workspace root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// Force React-family packages to resolve to this package's copy only.
// Metro's default resolver checks extraNodeModules first for the given
// package name, so any transitive `require('react')` will land here.
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  react: path.resolve(projectRoot, 'node_modules', 'react'),
  'react-native': path.resolve(projectRoot, 'node_modules', 'react-native'),
};

module.exports = config;
