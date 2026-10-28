/* global __ENV, __ITER, __VU */
import http from 'k6/http';
import { check } from 'k6';

const API = __ENV.API_URL || 'http://host.docker.internal:3000';
const ISSUER = __ENV.OAUTH_TOKEN_ISSUER || 'http://host.docker.internal:8081/default';
const PROGRAM_ID = __ENV.PROGRAM_ID || 'prg_grand_usd';

export const options = {
  scenarios: {
    mixed: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 20,
      maxVUs: 50,
    },
  },
};

export function setup() {
  const tokenResponse = http.post(
    ISSUER + '/token',
    'grant_type=client_credentials&client_id=bank-a&client_secret=local-dev-secret&scope=capacity%3Aread%20capacity%3Awrite&audience=capacity-service',
    { headers: { 'content-type': 'application/x-www-form-urlencoded', Host: 'localhost:8081' } },
  );
  if (tokenResponse.status !== 200) {
    throw new Error('token endpoint answered ' + tokenResponse.status);
  }
  return { token: tokenResponse.json().access_token };
}

export default function (data) {
  const headers = {
    authorization: 'Bearer ' + data.token,
    'content-type': 'application/json',
  };
  if (__ITER % 5 === 4) {
    const invoiceId = 'INV-K6-' + __VU + '-' + __ITER;
    const response = http.post(
      API + '/v1/programs/' + PROGRAM_ID + '/reservations',
      JSON.stringify({ invoiceId: invoiceId, amount: { value: '100.00', currency: 'USD' } }),
      { headers: headers },
    );
    check(response, { 'reserve created': (r) => r.status === 201 });
  } else {
    const response = http.get(API + '/v1/programs/' + PROGRAM_ID + '/capacity', {
      headers: headers,
    });
    check(response, { 'capacity read ok': (r) => r.status === 200 });
  }
}
