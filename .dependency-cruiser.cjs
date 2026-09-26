/**
 * Boundary rules for the Creator Suite monorepo (D-022, CLAUDE.md rule 11).
 *
 * Paths are used rather than package names on purpose: pnpm symlinks
 * `node_modules/@suite/ui` back to `packages/ui`, and dependency-cruiser
 * resolves symlinks, so a path rule catches both `@suite/ui` and a relative
 * `../../packages/ui/src/index.ts` import.
 */
const BACKEND = '^(services/[^/]+|packages/(server-core|media-pipeline))/';
const FRONTEND_ONLY = '^packages/ui/';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-frontend-to-backend',
      comment:
        'D-022: apps/* talk to services only over HTTP. Import packages/ui, *-contract, ' +
        'or *-client instead of service or backend-only code.',
      severity: 'error',
      from: { path: '^apps/[^/]+/' },
      to: { path: BACKEND },
    },
    {
      name: 'no-backend-to-frontend',
      comment: 'D-022: services/* and backend-only packages must never import packages/ui.',
      severity: 'error',
      from: { path: BACKEND },
      to: { path: FRONTEND_ONLY },
    },
    {
      name: 'no-backend-to-apps',
      comment: 'D-022: nothing outside apps/ may import an app.',
      severity: 'error',
      from: { pathNot: '^apps/' },
      to: { path: '^apps/[^/]+/' },
    },
    {
      name: 'no-cross-service-imports',
      comment:
        'D-022: services talk to each other only through a generated client, ' +
        'never by importing another service.',
      severity: 'error',
      from: { path: '^services/([^/]+)/' },
      to: { path: '^services/([^/]+)/', pathNot: '^services/$1/' },
    },
    {
      name: 'no-package-to-service',
      comment: 'D-022: shared packages must not depend on a concrete service.',
      severity: 'error',
      from: { path: '^packages/[^/]+/' },
      to: { path: '^services/[^/]+/' },
    },
    {
      name: 'no-circular',
      comment: 'Circular dependencies make build order and reasoning unreliable.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'A module that cannot be resolved is either a typo or a missing dependency.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-dev-dep-in-src',
      comment: 'Runtime source must not import a devDependency.',
      severity: 'error',
      from: { path: '^(services|packages|apps)/[^/]+/src/', pathNot: '\\.(test|spec)\\.ts$' },
      to: { dependencyTypes: ['npm-dev'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: [
        '^(docs|supabase|coverage|scripts)/',
        '/dist/',
        '/node_modules/',
        '\\.(test|spec)\\.ts$',
      ],
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      // 'source' first: each workspace package exports a `source` condition
      // pointing at src/, so the cruise sees a real source-level graph and does
      // not depend on dist/ having been built. Node, tsc, and Vite all ignore
      // the condition. Without it, `@suite/ui` would resolve to
      // packages/ui/dist/index.d.ts, which is excluded below, and a forbidden
      // import would pass unnoticed.
      conditionNames: ['source', 'import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
