/** Layer rules of the hexagonal architecture (PRD section 7). Test files are exempt. */
const NOT_TEST = '\\.test\\.ts$';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-imports-only-domain',
      comment: 'The domain core has no framework, library, platform or adapter imports (NFR-13).',
      severity: 'error',
      from: { path: '^src/capacity/domain/', pathNot: NOT_TEST },
      to: { pathNot: '^src/capacity/domain/' },
    },
    {
      name: 'application-imports-no-adapter',
      comment: 'Application services depend on ports, never on adapters or platform wiring.',
      severity: 'error',
      from: { path: '^src/capacity/application/', pathNot: NOT_TEST },
      to: { path: '^src/(capacity/adapters|platform)/' },
    },
    {
      name: 'adapters-do-not-import-each-other',
      comment:
        'One adapter (for example in/http) must not import another (for example out/postgres).',
      severity: 'error',
      from: { path: '^src/capacity/adapters/([^/]+/[^/]+)/', pathNot: NOT_TEST },
      to: {
        path: '^src/capacity/adapters/',
        // ADR 024: a driving adapter (in/http, in/grpc) may import the shared boundary.
        pathNot: ['^src/capacity/adapters/$1/', '^src/capacity/adapters/in/boundary/'],
      },
    },
    {
      name: 'boundary-is-for-driving-adapters',
      comment:
        'Only the HTTP and gRPC adapters import adapters/in/boundary (ADR 024); outbound and event adapters do not.',
      severity: 'error',
      from: { path: '^src/capacity/adapters/(out|in/(kafka|jobs))/', pathNot: NOT_TEST },
      to: { path: '^src/capacity/adapters/in/boundary/' },
    },
    {
      name: 'boundary-imports-no-transport',
      comment: 'The boundary holds what both transports share and imports neither (ADR 024).',
      severity: 'error',
      from: { path: '^src/capacity/adapters/in/boundary/', pathNot: NOT_TEST },
      to: { path: '^(node_modules/(@nestjs|express|@grpc)|src/capacity/adapters/in/(http|grpc)/)' },
    },
    {
      name: 'slices-do-not-import-each-other',
      comment: 'Use-case slices share the domain core, never each other internals.',
      severity: 'error',
      from: { path: '^src/capacity/application/use-cases/([^/]+)/', pathNot: NOT_TEST },
      to: {
        path: '^src/capacity/application/use-cases/',
        pathNot: '^src/capacity/application/use-cases/$1/',
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
    },
  },
};
