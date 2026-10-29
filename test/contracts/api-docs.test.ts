import { describe, expect, it } from 'vitest';
import { buildAsyncApiDocument } from '#src/platform/contracts/asyncapi.js';
import { renderAsyncApiDocs } from '#src/platform/health/api-docs.js';

const document = buildAsyncApiDocument({ payloads: 'inline' });

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
