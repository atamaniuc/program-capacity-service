/** Service rules (ADR 027). The hexagonal layer rules for src/payments/ arrive with its code. */
const NOT_TEST = '\\.test\\.ts$';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
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
