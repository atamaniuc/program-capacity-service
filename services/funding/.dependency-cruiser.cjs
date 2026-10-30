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
