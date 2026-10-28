import type { OpsDocument } from './ops-server.js';

interface OpenApiLike {
  readonly info: { readonly title: string; readonly version: string };
  readonly paths?: object | undefined;
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** `/docs` (a plain endpoint index) and `/docs/openapi.json`, served on the ops port only. */
export function renderApiDocs(document: OpenApiLike): Record<string, OpsDocument> {
  const paths = Object.entries(document.paths ?? {}) as [
    string,
    Record<string, { summary?: string }>,
  ][];
  const rows = paths.flatMap(([path, operations]) =>
    Object.entries(operations).map(
      ([method, operation]) =>
        `<tr><td><code>${escapeHtml(method.toUpperCase())}</code></td><td><code>${escapeHtml(path)}</code></td><td>${escapeHtml(operation.summary ?? '')}</td></tr>`,
    ),
  );
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(document.info.title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:60rem}td{padding:.25rem .75rem}</style></head>
<body><h1>${escapeHtml(document.info.title)} ${escapeHtml(document.info.version)}</h1>
<p>Contract: <a href="/docs/openapi.json">openapi.json</a>. Idempotency keys are kept at least 24 hours.</p>
<table>${rows.join('')}</table></body></html>`;
  return {
    '/docs': { contentType: 'text/html; charset=utf-8', body: html },
    '/docs/openapi.json': { contentType: 'application/json', body: JSON.stringify(document) },
  };
}
