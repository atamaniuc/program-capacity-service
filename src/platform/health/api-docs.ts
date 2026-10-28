import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { OpsDocument } from './ops-server.js';

interface OpenApiLike {
  readonly info: { readonly title: string; readonly version: string };
  readonly paths?: object | undefined;
  readonly components?: { readonly securitySchemes?: object } | undefined;
  readonly security?: readonly object[] | undefined;
}

export interface ApiDocsOptions {
  /**
   * Token endpoint of a local OAuth2 server. When set, the docs offer an OAuth2 client-credentials
   * login next to the pasted bearer token, so "Try it out" works without leaving the page.
   */
  readonly tokenUrl?: string | undefined;
}

/**
 * Swagger UI ships with the service (the pinned `swagger-ui-dist` dependency), so `/docs` works
 * without network access. Only the path is resolved: importing the package would load its browser
 * bundle into Node.
 */
const SWAGGER_UI_DIR = dirname(
  createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'),
);
const swaggerAsset = (file: string, contentType: string): OpsDocument => ({
  contentType,
  body: readFileSync(join(SWAGGER_UI_DIR, file), 'utf8'),
});

const SCOPES = {
  'capacity:read': 'Read capacity, reservations and the ledger',
  'capacity:write': 'Reserve and release',
};

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Adds the local OAuth2 login to the served copy only; `contracts/openapi.yaml` stays unchanged. */
function withLocalLogin(document: OpenApiLike, tokenUrl: string): OpenApiLike {
  return {
    ...document,
    components: {
      ...document.components,
      securitySchemes: {
        ...document.components?.securitySchemes,
        localOAuth: { type: 'oauth2', flows: { clientCredentials: { tokenUrl, scopes: SCOPES } } },
      },
    },
    security: [...(document.security ?? []), { localOAuth: Object.keys(SCOPES) }],
  };
}

/**
 * `/docs` (Swagger UI with "Try it out" against the API) and `/docs/openapi.json`, served on the
 * ops port only. Requests go from the browser to the `servers` URL, so the API must allow this
 * page's origin (`CORS_ORIGINS`).
 */
export function renderApiDocs(
  document: OpenApiLike,
  options: ApiDocsOptions = {},
): Record<string, OpsDocument> {
  const served =
    options.tokenUrl === undefined ? document : withLocalLogin(document, options.tokenUrl);
  const login =
    options.tokenUrl === undefined
      ? ''
      : // The local mock server accepts any secret; the client id becomes the tenant.
        `ui.initOAuth({ clientId: 'bank-a', clientSecret: 'local-dev-secret', scopes: ${JSON.stringify(Object.keys(SCOPES))} });`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(document.info.title)} — API docs</title>
<link rel="stylesheet" href="/docs/swagger-ui.css">
<style>body{margin:0}.hint{font:14px system-ui,sans-serif;margin:0;padding:12px 20px;background:#eef2f8;border-bottom:1px solid #cfd7e4}</style>
</head><body>
<p class="hint"><b>Try it:</b> click <b>Authorize</b>${options.tokenUrl === undefined ? ' and paste a token from <code>make token TENANT=bank-a</code>' : ', choose <b>localOAuth</b> (client id = tenant: bank-a, bank-b or bank-c) or paste a token from <code>make token</code>'}, then open an endpoint and press <b>Try it out</b>. Seeded programs: <code>prg_grand_usd</code>, <code>prg_aegean_eur</code> (bank-a).</p>
<div id="swagger"></div>
<script src="/docs/swagger-ui-bundle.js"></script>
<script>
const ui = SwaggerUIBundle({
  url: '/docs/openapi.json',
  dom_id: '#swagger',
  deepLinking: true,
  persistAuthorization: true,
  tryItOutEnabled: true,
  displayRequestDuration: true,
  defaultModelsExpandDepth: 0,
});
${login}
</script>
</body></html>`;
  return {
    '/docs': { contentType: 'text/html; charset=utf-8', body: html },
    '/docs/openapi.json': { contentType: 'application/json', body: JSON.stringify(served) },
    '/docs/swagger-ui.css': swaggerAsset('swagger-ui.css', 'text/css; charset=utf-8'),
    '/docs/swagger-ui-bundle.js': swaggerAsset(
      'swagger-ui-bundle.js',
      'text/javascript; charset=utf-8',
    ),
  };
}
