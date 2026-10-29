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
const require = createRequire(import.meta.url);
const SWAGGER_UI_DIR = dirname(require.resolve('swagger-ui-dist/package.json'));
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

const HINT_STYLE =
  'body{margin:0}.hint{font:14px/1.6 system-ui,sans-serif;margin:0;padding:12px 20px;background:#eef2f8;border-bottom:1px solid #cfd7e4}';

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
<style>${HINT_STYLE}</style>
</head><body>
<p class="hint"><b>REST API</b> · <a href="/docs/asyncapi">Kafka topics and events (AsyncAPI)</a><br><b>Try it:</b> click <b>Authorize</b>${options.tokenUrl === undefined ? ' and paste a token from <code>make token TENANT=bank-a</code>' : ', choose <b>localOAuth</b> (client id = tenant: bank-a, bank-b or bank-c) or paste a token from <code>make token</code>'}, then open an endpoint and press <b>Try it out</b>. Seeded programs: <code>prg_grand_usd</code>, <code>prg_aegean_eur</code> (bank-a).</p>
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

/** The viewer sets no font and its typography plugin wraps inline code in literal backticks. */
const VIEWER_STYLE =
  'html{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}#asyncapi code::before,#asyncapi code::after{content:none}';

interface AsyncApiLike {
  readonly info: { readonly title: string; readonly version: string };
}

/**
 * The AsyncAPI viewer is a devDependency: the image copies only its prebuilt browser bundle and
 * stylesheet (see the Dockerfile), so the parser's dependency tree never reaches production.
 * Without them the page still serves the document and says how to get the viewer.
 */
export interface AsyncApiViewer {
  readonly script: string;
  readonly style: string;
}

function asyncApiViewer(): AsyncApiViewer | null {
  try {
    const dir = dirname(require.resolve('@asyncapi/react-component/package.json'));
    return {
      script: readFileSync(join(dir, 'browser/standalone/index.js'), 'utf8'),
      style: readFileSync(join(dir, 'styles/default.min.css'), 'utf8'),
    };
  } catch {
    return null;
  }
}

/**
 * `/docs/asyncapi` (every Kafka topic, message, header and example) and `/docs/asyncapi.json`,
 * served on the ops port next to the Swagger UI. The document is the committed
 * `contracts/asyncapi.yaml` with its payload schemas inlined, so the browser fetches one file.
 */
export function renderAsyncApiDocs(
  document: AsyncApiLike,
  options: { readonly viewer?: () => AsyncApiViewer | null } = {},
): Record<string, OpsDocument> {
  const viewer = (options.viewer ?? asyncApiViewer)();
  const title = escapeHtml(document.info.title);
  const body =
    viewer === null
      ? '<p class="hint">The AsyncAPI viewer is not installed (<code>npm install</code> adds it). The contract is <a href="/docs/asyncapi.json">/docs/asyncapi.json</a>.</p>'
      : `<div id="asyncapi"></div>
<script src="/docs/asyncapi-ui.js"></script>
<script>
fetch('/docs/asyncapi.json')
  .then((response) => response.json())
  .then((schema) => AsyncApiStandalone.render({
    schema,
    config: { show: { sidebar: true, errors: true }, sidebar: { showOperations: 'byDefault' } },
  }, document.getElementById('asyncapi')));
</script>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — events</title>
${viewer === null ? '' : '<link rel="stylesheet" href="/docs/asyncapi-ui.css">'}
<style>${HINT_STYLE}${VIEWER_STYLE}</style>
</head><body>
<p class="hint"><a href="/docs">REST API (Swagger UI)</a> · <b>Kafka topics and events</b> · raw document: <a href="/docs/asyncapi.json">asyncapi.json</a><br>Watch the live events: <code>make events</code>. Payload schemas: <code>contracts/json-schema/</code>.</p>
${body}
</body></html>`;
  return {
    '/docs/asyncapi': { contentType: 'text/html; charset=utf-8', body: html },
    '/docs/asyncapi.json': { contentType: 'application/json', body: JSON.stringify(document) },
    ...(viewer === null
      ? {}
      : {
          '/docs/asyncapi-ui.js': {
            contentType: 'text/javascript; charset=utf-8',
            body: viewer.script,
          },
          '/docs/asyncapi-ui.css': { contentType: 'text/css; charset=utf-8', body: viewer.style },
        }),
  };
}
