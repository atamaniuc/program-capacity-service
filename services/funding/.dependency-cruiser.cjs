/** Service rules (ADR 027). The domain rule is here; the other layer rules arrive with the application and adapters. */
const NOT_TEST = '\\.test\\.ts$';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-imports-only-domain',
      comment:
        'The funding domain has no framework, library, platform or adapter imports (ADR 025).',
      severity: 'error',
      from: { path: '^src/funding/domain/', pathNot: NOT_TEST },
      to: { pathNot: '^src/funding/domain/' },
    },
    {
      name: 'application-imports-no-adapter',
      comment: 'Application services depend on ports, never on adapters.',
      severity: 'error',
      from: { path: '^src/funding/application/', pathNot: NOT_TEST },
      to: { path: '^src/funding/adapters/' },
    },
    {
      name: 'adapters-do-not-import-each-other',
      comment: 'in/http must not import out/postgres, nor the reverse.',
      severity: 'error',
      from: { path: '^src/funding/adapters/([^/]+/[^/]+)/', pathNot: NOT_TEST },
      to: { path: '^src/funding/adapters/', pathNot: '^src/funding/adapters/$1/' },
    },
    {
      name: 'no-cross-service-imports',
      comment:
        'A service imports only its own code, its dependencies and generated contract stubs.',
      severity: 'error',
      from: { pathNot: NOT_TEST },
      to: { path: '^\\.\\./', pathNot: 'node_modules' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
