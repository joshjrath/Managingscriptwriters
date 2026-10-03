// Lint rules for what TypeScript can't catch on its own: React hook mistakes
// and promises nobody handles (an unhandled rejection crashes the server).
// Deliberately small. Run with `npm run lint`; `npm run verify` includes it.

import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist/', 'data/', 'node_modules/'] },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin, 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // mark deliberate fire-and-forget calls with `void`; navigate() only returns a promise in data routers, which this app doesn't use
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [{ from: 'package', name: 'NavigateFunction', package: 'react-router' }],
      }],
      // async onClick handlers are fine; async callbacks elsewhere (timers, process events, streams) are not
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    },
  },
);
