import { createMutation, recentQuery } from './operations.mjs';

const $ = (selector) => document.querySelector(selector);
const states = {
  RECEIVED: ['Принята', 'active'],
  RESERVING: ['Резервирование', 'active'],
  DISBURSING: ['Выплата', 'active'],
  COMPENSATING: ['Компенсация', 'active'],
  COMPLETED: ['Выплачено', 'good'],
  REJECTED: ['Отклонена', 'attention'],
  FAILED: ['Не выплачено', 'attention'],
  NEEDS_ATTENTION: ['Нужна проверка', 'attention'],
};
const stepStatuses = {
  done: 'Готово',
  current: 'Выполняется',
  fault: 'Ошибка',
  skipped: 'Пропущено',
  pending: 'Ожидает',
};
const reasons = {
  'risk-declined': 'Отклонена по риск-политике',
  'insufficient-capacity': 'Недостаточно доступного лимита',
  'payment-declined': 'Платёжная система отклонила выплату',
  'disbursement-unknown': 'Результат выплаты требует проверки',
};
const metrics = ['fundingDb', 'invoiceHttp', 'buyerHttp', 'paymentHttp'];

let token = '';
let selectedId = '';
let requests = [];
let polling = null;
let busy = false;

function setBusy(value) {
  busy = value;
  $('#run').disabled = busy || !token;
  $('#refresh').disabled = busy || !token;
  $('#save-auth').disabled = busy;
}

function notice(message, { error = false, selector = '#notice' } = {}) {
  const node = $(selector);
  node.hidden = !message;
  node.textContent = message;
  node.classList.toggle('error', error);
}

async function graphql(query, variables, bearer = token) {
  const response = await fetch('/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(12_000),
    body: JSON.stringify({ query, variables }),
  });
  const result = await response.json();
  if (!response.ok || !result.data) {
    throw new Error(
      result.errors?.[0]?.message ?? result.detail ?? `Funding API вернул HTTP ${response.status}`,
    );
  }
  return result;
}

function pill(element, state) {
  const [label, kind] = states[state] ?? [state, 'active'];
  element.textContent = label;
  element.dataset.kind = kind;
  element.hidden = false;
}

function requestRow(request) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'request-row';
  button.dataset.id = request.id;
  button.setAttribute('aria-pressed', String(request.id === selectedId));
  const invoice = document.createElement('b');
  invoice.textContent = request.invoiceId;
  const status = document.createElement('span');
  status.className = 'pill';
  pill(status, request.state);
  const meta = document.createElement('small');
  meta.textContent = `${request.amount.value} ${request.amount.currency} · ${request.programId}`;
  button.append(invoice, status, meta);
  li.append(button);
  return li;
}

function renderSteps(request) {
  const steps = {};
  if (request) {
    const { state, reason, reservationId } = request;
    const paymentDeclined = reason === 'payment-declined';
    steps.received = 'done';
    steps.reserve =
      reservationId || state === 'COMPLETED'
        ? 'done'
        : state === 'RESERVING'
          ? 'current'
          : reason === 'risk-declined'
            ? 'skipped'
            : states[state]?.[1] === 'attention'
              ? 'fault'
              : 'pending';
    steps.payment =
      state === 'COMPLETED'
        ? 'done'
        : state === 'DISBURSING'
          ? 'current'
          : paymentDeclined || reason === 'disbursement-unknown'
            ? 'fault'
            : states[state]?.[1] === 'attention' || state === 'COMPENSATING'
              ? 'skipped'
              : 'pending';
    steps.release =
      state === 'COMPENSATING'
        ? 'current'
        : state === 'FAILED' && reservationId
          ? 'done'
          : reason?.startsWith('release-failed:')
            ? 'fault'
            : states[state]?.[1] !== 'active'
              ? 'skipped'
              : 'pending';
  }
  for (const node of document.querySelectorAll('#timeline li')) {
    const step = steps[node.dataset.step];
    node.dataset.status = step ?? '';
    node.querySelector('.step-status').textContent = stepStatuses[step] ?? '';
  }
}

function renderDetails() {
  const request = requests.find((item) => item.id === selectedId);
  $('#request-id').textContent = request?.invoiceId ?? 'Выберите заявку из журнала';
  $('#request-state').hidden = !request;
  $('#enrichment').hidden = !request;
  renderSteps(request);
  if (!request) return;
  pill($('#request-state'), request.state);
  $('#invoice-detail').textContent = request.invoice?.description ?? '—';
  $('#buyer-detail').textContent = request.buyer
    ? `${request.buyer.name} · ${request.buyer.region}`
    : '—';
  $('#payment-detail').textContent =
    reasons[request.reason] ?? request.reason ?? request.payment?.status ?? '—';
}

function renderRecent({ data, extensions }) {
  requests = data.recentFundingRequests;
  if (!requests.some((request) => request.id === selectedId)) {
    selectedId = requests[0]?.id ?? '';
  }
  const focus = document.activeElement?.dataset.id;
  $('#requests').replaceChildren(...requests.map(requestRow));
  if (focus) {
    const replacement = Array.from($('#requests').querySelectorAll('button')).find(
      (button) => button.dataset.id === focus,
    );
    replacement?.focus({ preventScroll: true });
  }
  $('#requests-count').textContent = `Последние заявки · ${requests.length}`;
  $('#requests-empty').hidden = requests.length > 0;
  $('#requests-empty').textContent = 'Запустите сценарий, чтобы добавить первую заявку.';
  for (const metric of metrics) {
    $(`#${metric}`).textContent = extensions?.batches?.[metric] ?? '—';
  }
  $('#batch-summary').textContent = `Последнее чтение журнала · ${requests.length} заявок`;
  renderDetails();
}

async function readRecent(bearer = token) {
  const result = await graphql(recentQuery, undefined, bearer);
  renderRecent(result);
  return result.errors?.map((error) => error.message).join(' · ');
}

function connect(bearer) {
  token = bearer;
  $('#connect').dataset.connected = 'true';
  $('#connection-label').textContent = 'Funding API подключён';
}

function stopPolling() {
  if (polling) clearTimeout(polling);
  polling = null;
}

function poll(id, deadline = Date.now() + 120_000) {
  stopPolling();
  polling = setTimeout(async function readStatus() {
    if (busy) {
      poll(id, deadline);
      return;
    }
    setBusy(true);
    try {
      const warnings = await readRecent();
      if (warnings) notice(warnings, { error: true });
      const state = requests.find((request) => request.id === id)?.state;
      if (states[state]?.[1] !== 'active') {
        if (selectedId === id && !warnings) notice('');
        stopPolling();
        return;
      }
      if (Date.now() < deadline) {
        poll(id, deadline);
      } else {
        notice('Заявка ещё в обработке. Нажмите «Обновить», чтобы проверить её статус.');
        stopPolling();
      }
    } catch (error) {
      notice(error.message, { error: true });
      stopPolling();
    } finally {
      setBusy(false);
    }
  }, 900);
}

$('#requests').addEventListener('click', (event) => {
  const row = event.target.closest('.request-row');
  if (!row) return;
  selectedId = row.dataset.id;
  for (const button of $('#requests').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button === row));
  }
  renderDetails();
});

$('#refresh').addEventListener('click', async () => {
  setBusy(true);
  try {
    const warnings = await readRecent();
    notice(warnings ?? '', { error: Boolean(warnings) });
  } catch (error) {
    notice(error.message, { error: true });
  } finally {
    setBusy(false);
  }
});

$('#run-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !token) return;
  const programId = $('#program').value.trim();
  if (!programId) {
    notice('Введите идентификатор программы.', { error: true });
    return;
  }
  setBusy(true);
  notice('Отправляем заявку…');
  const key = crypto.randomUUID();
  const scenario = $('#scenario').value;
  const prefix = scenario === 'decline' ? 'FAULT-DECLINE' : 'LAB-OK';
  try {
    const { data } = await graphql(createMutation, {
      key,
      input: {
        programId,
        invoiceId: `${prefix}-${key.slice(0, 8)}`,
        amount: { value: '1000.00', currency: 'USD' },
      },
    });
    selectedId = data.createFundingRequest.id;
    poll(selectedId);
    const warnings = await readRecent();
    if (warnings) notice(warnings, { error: true });
    else notice('Заявка принята. Маршрут обновляется автоматически.');
  } catch (error) {
    notice(error.message, { error: true });
  } finally {
    setBusy(false);
  }
});

const dialog = $('#auth-dialog');
$('#connect').addEventListener('click', () => dialog.showModal());
$('#cancel-auth').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => {
  $('#auth-form').reset();
  notice('', { selector: '#auth-error' });
});
$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const bearer = $('#token')
    .value.trim()
    .replace(/^Bearer\s+/i, '');
  if (!bearer || /\s/.test(bearer)) {
    notice('Вставьте JWT без пробелов.', { selector: '#auth-error', error: true });
    return;
  }
  setBusy(true);
  try {
    const warnings = await readRecent(bearer);
    stopPolling();
    connect(bearer);
    notice(warnings ?? '', { error: Boolean(warnings) });
    dialog.close();
  } catch (error) {
    notice(error.message, { selector: '#auth-error', error: true });
  } finally {
    setBusy(false);
  }
});

setBusy(true);
try {
  const response = await fetch('/demo/token', {
    method: 'POST',
    signal: AbortSignal.timeout(6000),
  });
  if (response.ok) {
    const { access_token: bearer } = await response.json();
    const warnings = await readRecent(bearer);
    connect(bearer);
    if (warnings) notice(warnings, { error: true });
  }
} catch (error) {
  notice(`Автоматическое подключение не удалось. ${error.message}`, { error: true });
} finally {
  setBusy(false);
}
