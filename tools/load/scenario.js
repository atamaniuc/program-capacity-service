/* global __ENV, __ITER, __VU */
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const API = __ENV.API_URL || 'http://host.docker.internal:' + (__ENV.HOST_PORT_API || '13000');
const ISSUER =
  __ENV.OAUTH_TOKEN_ISSUER ||
  'http://host.docker.internal:' + (__ENV.HOST_PORT_OAUTH || '18081') + '/default';

const hotRead = new Trend('hot_read_duration');
const hotReserve = new Trend('hot_reserve_duration');
const hotRelease = new Trend('hot_release_duration');
const spreadRead = new Trend('spread_read_duration');
const spreadReserve = new Trend('spread_reserve_duration');
const spreadRelease = new Trend('spread_release_duration');
const warmup = new Trend('warmup_duration');

const hotRequests = new Counter('hot_requests');
const spreadRequests = new Counter('spread_requests');

const PHASE_SECONDS = 30;

const PROGRAMS = [
  { tenant: 'bank-a', id: 'prg_grand_usd', amount: { value: '100.00', currency: 'USD' } },
  { tenant: 'bank-a', id: 'prg_aegean_eur', amount: { value: '100.00', currency: 'EUR' } },
  { tenant: 'bank-b', id: 'prg_gulf_aed', amount: { value: '100.00', currency: 'AED' } },
  { tenant: 'bank-b', id: 'prg_kuwait_kwd', amount: { value: '100.000', currency: 'KWD' } },
  { tenant: 'bank-c', id: 'prg_atlas_usd', amount: { value: '100.00', currency: 'USD' } },
  { tenant: 'bank-c', id: 'prg_nordic_eur', amount: { value: '100.00', currency: 'EUR' } },
];

// A 20 s warm-up (JIT, connection pools, k6 VUs) runs first and is not measured: without it the
// first measured phase pays the cold start, whichever it is. Then the spread phase (six programs)
// proves NFR-03 (read p95 < 20 ms, reserve and release p95 < 50 ms), then the hot phase (one
// program) shows the contention of NFR-04.
export const options = {
  scenarios: {
    warmup: {
      executor: 'constant-arrival-rate',
      exec: 'warmupPhase',
      rate: 50,
      timeUnit: '1s',
      duration: '20s',
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
      startTime: '25s',
      gracefulStop: '5s',
    },
    hot: {
      executor: 'constant-arrival-rate',
      exec: 'hotPhase',
      rate: 100,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 20,
      maxVUs: 50,
      startTime: '60s',
      gracefulStop: '5s',
    },
  },
  thresholds: {
    spread_read_duration: ['p(95)<20'],
    spread_reserve_duration: ['p(95)<50'],
    spread_release_duration: ['p(95)<50'],
    'http_req_duration{phase:spread,kind:read}': ['p(95)<20'],
    'http_req_duration{phase:spread,kind:reserve}': ['p(95)<50'],
    'http_req_duration{phase:spread,kind:release}': ['p(95)<50'],
    'http_req_failed{phase:spread}': ['rate<0.001'],
  },
};

function fetchToken(tenant) {
  const tokenResponse = http.post(
    ISSUER + '/token',
    'grant_type=client_credentials&client_id=' +
      tenant +
      '&client_secret=local-dev-secret&scope=capacity%3Aread%20capacity%3Awrite&audience=capacity-service',
    {
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Host: 'localhost:' + (__ENV.HOST_PORT_OAUTH || '18081'),
      },
    },
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

function tags(phase, kind) {
  return { phase: phase, kind: kind };
}

function read(program, headers, name, trend, phase) {
  const response = http.get(API + '/v1/programs/' + program.id + '/capacity', {
    headers: headers,
    tags: tags(phase, 'read'),
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
  phase,
) {
  const invoiceId = 'INV-K6-' + runId + '-' + phase + '-' + __VU + '-' + __ITER + '-' + program.id;
  const reserve = http.post(
    API + '/v1/programs/' + program.id + '/reservations',
    JSON.stringify({ invoiceId: invoiceId, amount: program.amount }),
    {
      headers: Object.assign({ 'idempotency-key': 'K6-RES-' + invoiceId }, headers),
      tags: tags(phase, 'reserve'),
    },
  );
  reserveTrend.add(reserve.timings.duration);
  check(reserve, { [reserveName]: (r) => r.status === 201 });

  if (reserve.status === 201) {
    const reservationId = reserve.json().reservationId;
    const releaseRef =
      'K6-REL-' + runId + '-' + phase + '-' + __VU + '-' + __ITER + '-' + program.id;
    const release = http.post(
      API + '/v1/programs/' + program.id + '/reservations/' + reservationId + '/releases',
      JSON.stringify({ releaseRef: releaseRef, reason: 'CANCELLED' }),
      {
        headers: Object.assign({ 'idempotency-key': releaseRef }, headers),
        tags: tags(phase, 'release'),
      },
    );
    releaseTrend.add(release.timings.duration);
    check(release, { [releaseName]: (r) => r.status === 200 });
  }
}

export function hotPhase(data) {
  const program = PROGRAMS[0];
  const headers = headersFor(data, program);
  hotRequests.add(1);
  if (__ITER % 10 < 8) {
    read(program, headers, 'hot read ok', hotRead, 'hot');
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
    'hot',
  );
}

export function warmupPhase(data) {
  const program = PROGRAMS[__ITER % PROGRAMS.length];
  const headers = headersFor(data, program);
  if (__ITER % 10 < 8) {
    read(program, headers, 'warmup read ok', warmup, 'warmup');
    return;
  }
  reserveRelease(
    program,
    headers,
    data.runId,
    warmup,
    warmup,
    'warmup reserve ok',
    'warmup release ok',
    'warmup',
  );
}

export function spreadPhase(data) {
  const program = PROGRAMS[__ITER % PROGRAMS.length];
  const headers = headersFor(data, program);
  spreadRequests.add(1);
  if (__ITER % 10 < 8) {
    read(program, headers, 'spread read ok', spreadRead, 'spread');
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
    'spread',
  );
}

// Per-phase achieved iteration rate (iterations started per second of the 30 s phase) and the
// p95 of each operation, printed after the run so a miss is visible next to the numbers.
export function handleSummary(data) {
  const lines = [
    '',
    'Per-phase results (NFR-03: read p95<20ms, reserve/release p95<50ms in spread)',
  ];
  for (const phase of ['spread', 'hot']) {
    const iterations = data.metrics[phase + '_requests'];
    const rate = iterations ? iterations.values.count / PHASE_SECONDS : 0;
    lines.push('  ' + phase + ': ' + rate.toFixed(1) + ' iterations/s achieved (target 100/s)');
    for (const op of ['read', 'reserve', 'release']) {
      const metric = data.metrics[phase + '_' + op + '_duration'];
      if (metric) {
        lines.push('    ' + op + ' p95=' + metric.values['p(95)'].toFixed(1) + ' ms');
      }
    }
  }
  for (const name of Object.keys(data.metrics)) {
    const thresholds = data.metrics[name].thresholds || {};
    for (const rule of Object.keys(thresholds)) {
      lines.push(
        '  threshold ' + name + ' ' + rule + ': ' + (thresholds[rule].ok ? 'ok' : 'FAILED'),
      );
    }
  }
  return { stdout: lines.join('\n') + '\n' };
}
