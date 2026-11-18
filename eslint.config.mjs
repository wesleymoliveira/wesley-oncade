import tseslint from 'typescript-eslint';

// Two of the project's boundaries are enforced here, not only written down:
//  - lib/core is pure: no I/O, no infrastructure;
//  - route handlers never talk to Oncade: they write to the database and answer.
const infrastructure = [
  '**/infra/*',
  '**/flows/*',
  '**/oncade/*',
  '**/telemetry/*',
  '**/config.ts',
  'mongodb',
  'zod',
  '@aws-sdk/*',
  '@opentelemetry/*',
  'node:fs',
  'node:http',
  'node:child_process',
];

export default tseslint.config(
  { ignores: ['.next/**', 'node_modules/**', 'coverage/**', '.local/**', 'next-env.d.ts'] },
  ...tseslint.configs.recommended,
  {
    files: ['lib/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: infrastructure, message: 'lib/core is pure: no I/O and no infrastructure.' }] },
      ],
    },
  },
  {
    files: ['app/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/oncade/*'], message: 'Route handlers never call Oncade. Queue the work.' }] },
      ],
    },
  },
  {
    // Scripts and tests read loosely typed JSON from the API and the stand-in.
    files: ['scripts/**/*.ts', 'tests/**/*.ts', 'explore/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
