import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildAsyncApiDocument } from '#src/platform/contracts/asyncapi.js';
import { renderApiDocs, renderAsyncApiDocs } from '#src/platform/health/api-docs.js';

const document = buildAsyncApiDocument({ payloads: 'inline' });

describe('Swagger UI page', () => {
  it('NFR-14 sends credentials in the form only for the local OAuth client-credentials request', () => {
    const tokenUrl = 'http://localhost:8081/default/token';
    const html = renderApiDocs(document, { tokenUrl })['/docs']?.body ?? '';
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
    type Request = { url: string; method: string; headers: Record<string, string>; body: string };
    let intercept: ((request: Request) => Request) | undefined;
    runInNewContext(script, {
      URLSearchParams,
      atob,
      SwaggerUIBundle: (config: { requestInterceptor: typeof intercept }) => {
        intercept = config.requestInterceptor;
        return { initOAuth: () => undefined };
      },
    });
    expect(intercept).toBeTypeOf('function');

    const body = 'grant_type=client_credentials&scope=capacity%3Aread';
    const headers = {
      Authorization: `Basic ${btoa('example:fixture:+&')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    const request = { url: tokenUrl, method: 'post', body, headers };
    const actual = intercept?.({ ...request, headers: { ...headers } });
    expect(actual?.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(new URLSearchParams(actual?.body))).toEqual({
      grant_type: 'client_credentials',
      scope: 'capacity:read',
      client_id: 'example',
      client_secret: 'fixture:+&',
    });

    for (const otherRequest of [
      { ...request, url: `${tokenUrl}/other` },
      { ...request, method: 'get' },
      { ...request, body: 'grant_type=authorization_code' },
      { ...request, headers: { Authorization: 'Bearer fixture' } },
    ]) {
      expect(intercept?.(structuredClone(otherRequest))).toEqual(otherRequest);
    }
    expect(renderApiDocs(document)['/docs']?.body).not.toContain('requestInterceptor');
  });
});

describe('AsyncAPI page', () => {
  it('NFR-14 serves the viewer, its assets and the document from the service itself', () => {
    const served = renderAsyncApiDocs(document);
    expect(Object.keys(served).sort()).toEqual([
      '/docs/asyncapi',
      '/docs/asyncapi-ui.css',
      '/docs/asyncapi-ui.js',
      '/docs/asyncapi.json',
    ]);
    expect(served['/docs/asyncapi']?.body).toContain('AsyncApiStandalone.render');
    expect(served['/docs/asyncapi']?.body).not.toMatch(/https?:\/\//);
    expect(JSON.parse(served['/docs/asyncapi.json']?.body ?? '{}')).toEqual(document);
  });

  it('NFR-14 without the viewer still serves the document and says how to get the viewer', () => {
    const served = renderAsyncApiDocs(document, { viewer: () => null });
    expect(Object.keys(served).sort()).toEqual(['/docs/asyncapi', '/docs/asyncapi.json']);
    const html = served['/docs/asyncapi']?.body ?? '';
    expect(html).toContain('The AsyncAPI viewer is not installed');
    expect(html).toContain('href="/docs/asyncapi.json"');
    expect(html).not.toContain('asyncapi-ui.js');
  });
});
