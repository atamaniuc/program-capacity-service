/* global __ENV, __ITER, __VU */
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const API = __ENV.API_URL || 'http://host.docker.internal:3000';
const ISSUER = __ENV.OAUTH_TOKEN_ISSUER || 'http://host.docker.internal:8081/default';
const PROGRAM_ID = __ENV.PROGRAM_ID || 'prg_grand_usd';

const readDuration = new Trend('read_duration');
const reserveDuration = new Trend('reserve_duration');
const releaseDuration = new Trend('release_duration');

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
  return { token: tokenResponse.json().access_token, runId: String(Date.now()) };
}

export default function (data) {
  const headers = {
    authorization: 'Bearer ' + data.token,
    'content-type': 'application/json',
  };
  const roll = __ITER % 10;

  if (roll < 8) {
    const response = http.get(API + '/v1/programs/' + PROGRAM_ID + '/capacity', {
      headers: headers,
    });
    readDuration.add(response.timings.duration);
    check(response, { 'capacity read ok': (r) => r.status === 200 });
    return;
  }

  const invoiceId = 'INV-K6-' + data.runId + '-' + __VU + '-' + __ITER;
  const reserve = http.post(
    API + '/v1/programs/' + PROGRAM_ID + '/reservations',
    JSON.stringify({ invoiceId: invoiceId, amount: { value: '100.00', currency: 'USD' } }),
    { headers: headers },
  );
  reserveDuration.add(reserve.timings.duration);
  check(reserve, { 'reserve created': (r) => r.status === 201 });

  if (reserve.status === 201) {
    const reservationId = reserve.json().reservationId;
    const release = http.post(
      API + '/v1/programs/' + PROGRAM_ID + '/reservations/' + reservationId + '/releases',
      JSON.stringify({
        releaseRef: 'K6-REL-' + data.runId + '-' + __VU + '-' + __ITER,
        reason: 'CANCELLED',
      }),
      { headers: headers },
    );
    releaseDuration.add(release.timings.duration);
    check(release, { 'release ok': (r) => r.status === 200 });
  }
}
