/* global __ENV, __ITER, __VU */
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const API = __ENV.API_URL || 'http://host.docker.internal:3000';
const ISSUER = __ENV.OAUTH_TOKEN_ISSUER || 'http://host.docker.internal:8081/default';

const hotRead = new Trend('hot_read_duration');
const hotReserve = new Trend('hot_reserve_duration');
const hotRelease = new Trend('hot_release_duration');
const spreadRead = new Trend('spread_read_duration');
const spreadReserve = new Trend('spread_reserve_duration');
const spreadRelease = new Trend('spread_release_duration');

const PROGRAMS = [
  { tenant: 'bank-a', id: 'prg_grand_usd', amount: { value: '100.00', currency: 'USD' } },
  { tenant: 'bank-a', id: 'prg_aegean_eur', amount: { value: '100.00', currency: 'EUR' } },
  { tenant: 'bank-b', id: 'prg_gulf_aed', amount: { value: '100.00', currency: 'AED' } },
  { tenant: 'bank-b', id: 'prg_kuwait_kwd', amount: { value: '100.000', currency: 'KWD' } },
  { tenant: 'bank-c', id: 'prg_atlas_usd', amount: { value: '100.00', currency: 'USD' } },
  { tenant: 'bank-c', id: 'prg_nordic_eur', amount: { value: '100.00', currency: 'EUR' } },
];

export const options = {
  scenarios: {
    hot: {
      executor: 'constant-arrival-rate',
      exec: 'hotPhase',
      rate: 100,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 20,
      maxVUs: 50,
      gracefulStop: '5s',
    },
    spread: {
      executor: 'constant-arrival-rate',
      exec: 'spreadPhase',
      rate: 100,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 20,
      maxVUs: 50,
      startTime: '35s',
      gracefulStop: '5s',
    },
  },
};

function fetchToken(tenant) {
  const tokenResponse = http.post(
    ISSUER + '/token',
    'grant_type=client_credentials&client_id=' +
      tenant +
      '&client_secret=local-dev-secret&scope=capacity%3Aread%20capacity%3Awrite&audience=capacity-service',
    { headers: { 'content-type': 'application/x-www-form-urlencoded', Host: 'localhost:8081' } },
  );
  if (tokenResponse.status !== 200) {
    throw new Error('token endpoint answered ' + tokenResponse.status + ' for ' + tenant);
  }
  return tokenResponse.json().access_token;
}

export function setup() {
  return {
    tokens: {
      'bank-a': fetchToken('bank-a'),
      'bank-b': fetchToken('bank-b'),
      'bank-c': fetchToken('bank-c'),
    },
    runId: String(Date.now()),
  };
}

function headersFor(data, program) {
  return {
    authorization: 'Bearer ' + data.tokens[program.tenant],
    'content-type': 'application/json',
  };
}

function read(program, headers, name, trend) {
  const response = http.get(API + '/v1/programs/' + program.id + '/capacity', {
    headers: headers,
  });
  trend.add(response.timings.duration);
  check(response, { [name]: (r) => r.status === 200 });
}

function reserveRelease(
  program,
  headers,
  runId,
  reserveTrend,
  releaseTrend,
  reserveName,
  releaseName,
) {
  const invoiceId = 'INV-K6-' + runId + '-' + __VU + '-' + __ITER + '-' + program.id;
  const reserve = http.post(
    API + '/v1/programs/' + program.id + '/reservations',
    JSON.stringify({ invoiceId: invoiceId, amount: program.amount }),
    { headers: headers },
  );
  reserveTrend.add(reserve.timings.duration);
  check(reserve, { [reserveName]: (r) => r.status === 201 });

  if (reserve.status === 201) {
    const reservationId = reserve.json().reservationId;
    const release = http.post(
      API + '/v1/programs/' + program.id + '/reservations/' + reservationId + '/releases',
      JSON.stringify({
        releaseRef: 'K6-REL-' + runId + '-' + __VU + '-' + __ITER + '-' + program.id,
        reason: 'CANCELLED',
      }),
      { headers: headers },
    );
    releaseTrend.add(release.timings.duration);
    check(release, { [releaseName]: (r) => r.status === 200 });
  }
}

export function hotPhase(data) {
  const program = PROGRAMS[0];
  const headers = headersFor(data, program);
  if (__ITER % 10 < 8) {
    read(program, headers, 'hot read ok', hotRead);
    return;
  }
  reserveRelease(
    program,
    headers,
    data.runId,
    hotReserve,
    hotRelease,
    'hot reserve ok',
    'hot release ok',
  );
}

export function spreadPhase(data) {
  const program = PROGRAMS[__ITER % PROGRAMS.length];
  const headers = headersFor(data, program);
  if (__ITER % 10 < 8) {
    read(program, headers, 'spread read ok', spreadRead);
    return;
  }
  reserveRelease(
    program,
    headers,
    data.runId,
    spreadReserve,
    spreadRelease,
    'spread reserve ok',
    'spread release ok',
  );
}
