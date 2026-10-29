import { parseArgs } from 'node:util';

/** Prints a JWT from the mock OAuth2 server (client credentials) for a tenant and scopes. */
const { values } = parseArgs({
  options: {
    tenant: { type: 'string' },
    scopes: { type: 'string', default: 'capacity:read capacity:write' },
    issuer: {
      type: 'string',
      default:
        process.env['OAUTH_TOKEN_ISSUER'] ??
        `http://localhost:${process.env['HOST_PORT_OAUTH'] ?? '18081'}/default`,
    },
    audience: { type: 'string', default: process.env['OAUTH_AUDIENCE'] ?? 'capacity-service' },
  },
});

if (values.tenant === undefined || values.tenant === '') {
  console.error('token: --tenant is required, for example --tenant bank-a');
  process.exit(1);
}

const response = await fetch(`${values.issuer}/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: values.tenant,
    client_secret: 'local-dev-secret',
    scope: values.scopes ?? '',
    audience: values.audience ?? '',
  }),
});

if (!response.ok) {
  console.error(`token: ${response.status} from ${values.issuer}/token (is the stack up? make up)`);
  process.exit(1);
}

const body = (await response.json()) as { access_token?: string };
if (body.access_token === undefined) {
  console.error('token: response carried no access_token');
  process.exit(1);
}
console.log(body.access_token);
