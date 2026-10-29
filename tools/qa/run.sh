#!/usr/bin/env bash
# QA pass against the running compose stack (`make up && make seed` first): every endpoint,
# every treasury message type, and the database, Kafka and metric side effects of each.
# Test-case ids match docs/qa.md. Exit code is the number of failed checks (0 = all green).
set -uo pipefail
cd "$(dirname "$0")/../.."
API=http://localhost:3000
OPS=http://localhost:9464
RUN=$(date +%s)
P=prg_qa_$RUN
DC="docker compose -f deploy/compose.yaml"
OUT=$(mktemp -d)
pass=0; fail=0; n=0
sql() { $DC exec -T postgres psql -U capacity -d capacity -At -F'|' -c "$1"; }
check() { # id, description, condition-result (0 = pass), evidence
  if [ "$3" = 0 ]; then pass=$((pass+1)); printf 'PASS %-6s %s | %s\n' "$1" "$2" "$4"; else fail=$((fail+1)); printf 'FAIL %-6s %s | %s\n' "$1" "$2" "$4"; fi
}
# api METHOD PATH TOKEN [BODY] [extra curl args...] -> sets $S (status) and $B (body file)
api() {
  local m=$1 p=$2 t=$3 body=${4:-}; shift 4 2>/dev/null || shift $#
  local auth=(); [ -n "$t" ] && auth=(-H "authorization: Bearer $t")
  n=$((n+1)); B=$OUT/$n.json
  if [ -n "$body" ]; then
    S=$(curl -s -o "$B" -w '%{http_code}' -X "$m" "$API$p" "${auth[@]}" -H 'content-type: application/json' -d "$body" "$@")
  else
    S=$(curl -s -o "$B" -w '%{http_code}' -X "$m" "$API$p" "${auth[@]}" "$@")
  fi
}
j() { jq -r "$1" "$B"; }
is() { [ "$1" = "$2" ] && echo 0 || echo 1; }

TA=$(make -s token TENANT=bank-a)
TB=$(make -s token TENANT=bank-b)
TR=$(make -s token TENANT=bank-a SCOPES="capacity:read")
echo "run=$RUN program=$P token-length=${#TA}"

# ---------- setup: a fresh program through Kafka (treasury owns limits) ----------
npm run -s simulate -- limit-cut --tenant bank-a --program "$P" --new-limit 10000.00 --seq 1 >/dev/null
for i in $(seq 1 30); do [ "$(sql "select count(*) from program where id='$P'")" = 1 ] && break; sleep 0.5; done

# ---------- A. ops port ----------
c=$(curl -s -o /dev/null -w '%{http_code}' $OPS/health/live); check QA-01 "liveness 200" $(is "$c" 200) "$c"
c=$(curl -s -o /dev/null -w '%{http_code}' $OPS/health/ready); check QA-01 "readiness 200" $(is "$c" 200) "$(curl -s $OPS/health/ready | head -c 120)"
api GET "/v1/programs/$P/capacity" "$TA" # the counter has no series until the first request
m1=$(curl -s $OPS/metrics | grep -c '^http_requests_total')
m2=$(curl -s http://localhost:9465/metrics | grep -c -E '^(outbox_lag|outbox_oldest_unpublished_age_seconds|invariant_mismatch_programs|programs_over_limit)')
check QA-02 "RED metrics on api :9464, domain metrics on worker :9465" $([ "$m1" -ge 1 ] && [ "$m2" -ge 4 ] && echo 0 || echo 1) "api http_requests_total series=$m1, worker domain gauges=$m2"
c=$(curl -s -o /dev/null -w '%{http_code}' $OPS/docs); a=$(curl -s -o /dev/null -w '%{http_code}' $OPS/docs/swagger-ui-bundle.js)
check QA-03 "Swagger UI and its assets on ops port" $([ "$c$a" = 200200 ] && echo 0 || echo 1) "docs=$c bundle=$a"
c=$(curl -s -o /dev/null -w '%{http_code}' $API/docs); check QA-03 "no docs on business port" $(is "$c" 404) "$c"
h=$(curl -s -i -X OPTIONS "$API/v1/programs/$P/reservations" -H 'Origin: http://127.0.0.1:9464' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type,idempotency-key' | tr -d '\r')
check QA-04 "CORS preflight from docs origin" $(echo "$h" | grep -qi '^access-control-allow-origin: http://127.0.0.1:9464' && echo 0 || echo 1) "$(echo "$h" | head -1)"
h=$(curl -s -i -X OPTIONS "$API/v1/programs/$P/reservations" -H 'Origin: http://evil.example' -H 'Access-Control-Request-Method: POST' | tr -d '\r')
check QA-04 "no CORS for other origins" $(echo "$h" | grep -qi '^access-control-allow-origin' && echo 1 || echo 0) "no allow-origin header"

# ---------- B. authentication and authorisation ----------
api GET "/v1/programs/$P/capacity" ""; check QA-10 "no token -> 401" $(is "$S" 401) "$S $(j .type 2>/dev/null)"
api GET "/v1/programs/$P/capacity" "not-a-jwt"; check QA-11 "garbage token -> 401" $(is "$S" 401) "$S"
api POST "/v1/programs/$P/reservations" "$TR" '{"invoiceId":"INV-RO","amount":{"value":"1.00","currency":"USD"}}'
check QA-12 "read-only scope cannot reserve -> 403" $(is "$S" 403) "$S"
api GET "/v1/programs/$P/capacity" "$TR"; check QA-12 "read-only scope can read" $(is "$S" 200) "$S"
api GET "/v1/programs/$P/capacity" "$TB"; check QA-13 "other tenant -> 404" $(is "$S" 404) "$S $(j .type)"

# ---------- C. capacity read ----------
api GET "/v1/programs/$P/capacity" "$TA"
check QA-20 "fresh program capacity" $([ "$(j '.limit+"/"+.reserved+"/"+.available')" = "10000.00/0.00/10000.00" ] && echo 0 || echo 1) "$(jq -c . "$B" | head -c 200)"
etag=$(curl -s -D - -o /dev/null "$API/v1/programs/$P/capacity" -H "authorization: Bearer $TA" | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}')
c=$(curl -s -o /dev/null -w '%{http_code}' "$API/v1/programs/$P/capacity" -H "authorization: Bearer $TA" -H "if-none-match: $etag")
check QA-21 "ETag + If-None-Match -> 304" $(is "$c" 304) "etag=$etag status=$c"
api GET "/v1/programs/prg_does_not_exist/capacity" "$TA"; check QA-22 "unknown program -> 404" $(is "$S" 404) "$S $(j .type)"

# ---------- D. reserve ----------
K1=qa-$RUN-k1
api POST "/v1/programs/$P/reservations" "$TA" '{"invoiceId":"INV-QA-1","amount":{"value":"1000.00","currency":"USD"}}' -H "idempotency-key: $K1"
R1=$(j .reservationId); cp "$B" $OUT/r1.json
check QA-30 "reserve USD 1000.00 -> 201" $([ "$S" = 201 ] && [ "$(j .capacity.reserved)" = 1000.00 ] && echo 0 || echo 1) "$S reserved=$(j .capacity.reserved) id=$R1"
row=$(sql "select status, invoice_amount_minor, amount_minor, released_minor, origin from reservation where id='$R1'")
check QA-30 "DB reservation row" $(is "$row" "ACTIVE|100000|100000|0|API") "$row"
prow=$(sql "select reserved_minor, credit_limit_minor from program where id='$P'")
check QA-30 "DB program reserved_minor" $(is "$prow" "100000|1000000") "$prow"
lrow=$(sql "select kind, delta_reserved_minor, reserved_after, actor from ledger_entry where reservation_id='$R1'")
check QA-30 "DB ledger RESERVE entry" $(echo "$lrow" | grep -q '^RESERVE|100000|100000|' && echo 0 || echo 1) "$lrow"
irow=$(sql "select status_code from idempotency_key where tenant_id='bank-a' and key='$K1'")
check QA-30 "DB idempotency key stored" $(is "$irow" 201) "$irow"
sleep 2
orow=$(sql "select type, program_seq, published_at is not null from outbox_event where tenant_id='bank-a' and program_id='$P' and type='ReservationCreated'")
check QA-30 "outbox ReservationCreated published" $(echo "$orow" | grep -q 'ReservationCreated|.*|t' && echo 0 || echo 1) "$orow"

before=$(sql "select count(*) from reservation where program_id='$P'")
api POST "/v1/programs/$P/reservations" "$TA" '{"invoiceId":"INV-QA-1","amount":{"value":"1000.00","currency":"USD"}}' -H "idempotency-key: $K1"
after=$(sql "select count(*) from reservation where program_id='$P'")
check QA-31 "replay same key -> same 201, no new row" $([ "$S" = 201 ] && [ "$(j .reservationId)" = "$R1" ] && [ "$before" = "$after" ] && echo 0 || echo 1) "$S id=$(j .reservationId) rows $before->$after"
api POST "/v1/programs/$P/reservations" "$TA" '{"invoiceId":"INV-QA-1","amount":{"value":"999.00","currency":"USD"}}' -H "idempotency-key: $K1"
check QA-32 "same key, other body -> 422" $([ "$S" = 422 ] && [ "$(j .type)" = https://errors.capacity.example/idempotency-key-mismatch ] && echo 0 || echo 1) "$S $(j .type)"
api POST "/v1/programs/$P/reservations" "$TA" '{"invoiceId":"INV-QA-1","amount":{"value":"1000.00","currency":"USD"}}' -H "idempotency-key: qa-$RUN-k1b"
check QA-33 "same invoice+amount, new key -> 200 existing reservation (natural key)" $([ "$S" = 200 ] && [ "$(j .reservationId)" = "$R1" ] && echo 0 || echo 1) "$S id=$(j .reservationId)"
api POST "/v1/programs/$P/reservations" "$TA" '{"invoiceId":"INV-QA-1","amount":{"value":"999.00","currency":"USD"}}' -H "idempotency-key: qa-$RUN-k1c"
check QA-33 "same invoice, other amount -> 409" $([ "$S" = 409 ] && [ "$(j .type)" = https://errors.capacity.example/reservation-conflict ] && echo 0 || echo 1) "$S $(j .type)"

api POST "/v1/programs/$P/reservations" "$TA" '{"invoiceId":"INV-QA-EUR","amount":{"value":"100.01","currency":"EUR"}}' -H "idempotency-key: qa-$RUN-eur"
R2=$(j .reservationId)
check QA-34 "EUR 100.01 at 1.08 -> USD 108.02 (rounded up)" $([ "$S" = 201 ] && [ "$(j .reservedAmount.value)" = 108.02 ] && echo 0 || echo 1) "$S reserved=$(j .reservedAmount.value) rate=$(j .fx.rate)"
frow=$(sql "select invoice_currency, invoice_amount_minor, amount_minor, fx_rate from reservation where id='$R2'")
check QA-34 "DB keeps rate and both amounts" $(is "$frow" "EUR|10001|10802|1.0800000000") "$frow"

K3=qa-$RUN-big
api POST "/v1/programs/$P/reservations" "$TA" '{"invoiceId":"INV-QA-BIG","amount":{"value":"9000.00","currency":"USD"}}' -H "idempotency-key: $K3"
check QA-35 "over available -> 422 insufficient-capacity" $([ "$S" = 422 ] && [ "$(j .type)" = https://errors.capacity.example/insufficient-capacity ] && echo 0 || echo 1) "$S $(j .type)"
api POST "/v1/programs/$P/reservations" "$TA" '{"invoiceId":"INV-QA-BIG","amount":{"value":"9000.00","currency":"USD"}}' -H "idempotency-key: $K3"
s2=$(sql "select status_code from idempotency_key where tenant_id='bank-a' and key='$K3'")
check QA-35 "the 422 is stored and replayed" $([ "$S" = 422 ] && [ "$s2" = 422 ] && echo 0 || echo 1) "replay=$S stored=$s2"

for body in '{"invoiceId":"INV-V1","amount":{"value":"0.00","currency":"USD"}}' '{"invoiceId":"INV-V2","amount":{"value":"-5.00","currency":"USD"}}' '{"invoiceId":"INV-V3","amount":{"value":"1.001","currency":"USD"}}' '{"invoiceId":"INV-V4","amount":{"value":"1.00","currency":"XXX"}}' '{"amount":{"value":"1.00","currency":"USD"}}' '{"invoiceId":"INV-V6","amount":{"value":"1.00","currency":"USD"},"extra":1}' 'not json'; do
  api POST "/v1/programs/$P/reservations" "$TA" "$body" -H "idempotency-key: qa-$RUN-val"
  check QA-36 "invalid body -> 400: $(echo "$body" | head -c 60)" $(is "$S" 400) "$S $(j .type 2>/dev/null)"
done
kv=$(sql "select count(*) from idempotency_key where tenant_id='bank-a' and key='qa-$RUN-val'")
check QA-36 "validation errors never take the key" $(is "$kv" 0) "rows=$kv"
api POST "/v1/programs/$P/reservations" "$TA" '{"invoiceId":"INV-QA-GBP","amount":{"value":"10.00","currency":"GBP"}}'
check QA-37 "no GBP->USD rate -> 422 fx-rate-unavailable" $([ "$S" = 422 ] && [ "$(j .type)" = https://errors.capacity.example/fx-rate-unavailable ] && echo 0 || echo 1) "$S $(j .type)"
api POST "/v1/programs/$P/reservations" "$TA" "$(printf '{"invoiceId":"INV-BIG","amount":{"value":"%s","currency":"USD"}}' "$(printf '9%.0s' $(seq 1 40))")"
check QA-38 "oversized amount -> 400, not 500" $(is "$S" 400) "$S"

# ---------- E. release ----------
api POST "/v1/programs/$P/reservations/$R1/releases" "$TA" '{"releaseRef":"pay-1","amount":{"value":"400.00","currency":"USD"},"reason":"REPAID"}' -H "idempotency-key: qa-$RUN-rel1"
check QA-40 "partial release 400.00 -> 200" $([ "$S" = 200 ] && [ "$(j .reservationStatus)" = PARTIALLY_RELEASED ] && [ "$(j .remainingAmount.value)" = 600.00 ] && echo 0 || echo 1) "$S $(j .reservationStatus) remaining=$(j .remainingAmount.value)"
rr=$(sql "select release_ref, reason, amount_minor from reservation_release where reservation_id='$R1'")
check QA-40 "DB release row" $(is "$rr" "pay-1|REPAID|40000") "$rr"
lr=$(sql "select kind, delta_reserved_minor from ledger_entry where reservation_id='$R1' order by id desc limit 1")
check QA-40 "DB ledger RELEASE -40000" $(is "$lr" "RELEASE|-40000") "$lr"
api POST "/v1/programs/$P/reservations/$R1/releases" "$TA" '{"releaseRef":"pay-1","amount":{"value":"400.00","currency":"USD"},"reason":"REPAID"}'
n=$(sql "select count(*) from reservation_release where reservation_id='$R1'")
check QA-41 "same releaseRef, same amount -> no second effect" $([ "$S" = 200 ] && [ "$n" = 1 ] && echo 0 || echo 1) "$S releases=$n"
api POST "/v1/programs/$P/reservations/$R1/releases" "$TA" '{"releaseRef":"pay-1","amount":{"value":"1.00","currency":"USD"},"reason":"REPAID"}'
check QA-42 "same releaseRef, other amount -> 422" $([ "$S" = 422 ] && [ "$(j .type)" = https://errors.capacity.example/release-ref-mismatch ] && echo 0 || echo 1) "$S $(j .type)"
api POST "/v1/programs/$P/reservations/$R1/releases" "$TA" '{"releaseRef":"pay-x","amount":{"value":"700.00","currency":"USD"},"reason":"REPAID"}'
check QA-43 "release over remaining -> 422" $([ "$S" = 422 ] && [ "$(j .type)" = https://errors.capacity.example/release-exceeds-remaining ] && echo 0 || echo 1) "$S $(j .type)"
api POST "/v1/programs/$P/reservations/$R2/releases" "$TA" '{"releaseRef":"pay-cur","amount":{"value":"1.00","currency":"USD"},"reason":"REPAID"}'
check QA-44 "release in non-invoice currency -> 400" $(is "$S" 400) "$S $(j .detail)"
api POST "/v1/programs/$P/reservations/$R1/releases" "$TA" '{"releaseRef":"pay-2","reason":"REPAID"}'
check QA-45 "release the rest (no amount) -> RELEASED" $([ "$S" = 200 ] && [ "$(j .reservationStatus)" = RELEASED ] && [ "$(j .remainingAmount.value)" = 0.00 ] && echo 0 || echo 1) "$S $(j .reservationStatus)"
api POST "/v1/programs/$P/reservations/$R1/releases" "$TA" '{"releaseRef":"pay-3","reason":"REPAID"}'
check QA-46 "release a RELEASED reservation -> 422" $(is "$S" 422) "$S $(j .type)"
api POST "/v1/programs/$P/reservations/$R2/releases" "$TA" '{"releaseRef":"cancel","reason":"CANCELLED"}'
check QA-47 "cancel EUR reservation" $([ "$S" = 200 ] && [ "$(j .reservationStatus)" = RELEASED ] && echo 0 || echo 1) "$S $(j .reservationStatus)"
prow=$(sql "select reserved_minor from program where id='$P'")
check QA-48 "program back to 0 reserved" $(is "$prow" 0) "$prow"

# ---------- F. queries ----------
api GET "/v1/programs/$P/reservations/$R1" "$TA"
check QA-50 "get reservation with releases" $([ "$S" = 200 ] && [ "$(j '.releases|length')" = 2 ] && echo 0 || echo 1) "$S releases=$(j '.releases|length')"
api GET "/v1/programs/$P/reservations/00000000-0000-7000-8000-000000000000" "$TA"; check QA-51 "unknown reservation -> 404" $(is "$S" 404) "$S"
api GET "/v1/programs/$P/reservations/not-a-uuid" "$TA"; check QA-51 "malformed id -> 404" $(is "$S" 404) "$S"
api GET "/v1/programs/$P/reservations?limit=1" "$TA"; cur=$(j .nextCursor)
check QA-52 "list page 1 of 1 item with cursor" $([ "$S" = 200 ] && [ "$(j '.items|length')" = 1 ] && [ "$cur" != null ] && echo 0 || echo 1) "$S items=$(j '.items|length')"
api GET "/v1/programs/$P/reservations?limit=1&cursor=$cur" "$TA"
check QA-52 "list page 2 via cursor" $([ "$S" = 200 ] && [ "$(j '.items|length')" = 1 ] && echo 0 || echo 1) "$S items=$(j '.items|length') next=$(j .nextCursor)"
api GET "/v1/programs/$P/reservations?status=RELEASED" "$TA"
check QA-53 "filter by status" $([ "$S" = 200 ] && [ "$(j '[.items[].status]|unique|join(",")')" = RELEASED ] && echo 0 || echo 1) "$S $(j '[.items[].status]|unique|join(",")')"
api GET "/v1/programs/$P/reservations?limit=0" "$TA"; check QA-53 "limit=0 -> 400" $(is "$S" 400) "$S"
api GET "/v1/programs/$P/ledger" "$TA"
kinds=$(j '[.items[].kind]|join(",")')
check QA-54 "ledger oldest first" $([ "$S" = 200 ] && [ "${kinds%%,*}" = LIMIT_SET ] && echo 0 || echo 1) "$kinds"
dbk=$(sql "select string_agg(kind, ',' order by id) from ledger_entry where program_id='$P'")
check QA-54 "ledger matches DB" $(is "$kinds" "$dbk") "db=$dbk"
api GET "/v1/programs/$P/ledger" "$TB"; check QA-55 "other tenant ledger -> 404" $(is "$S" 404) "$S"

# ---------- G. treasury input over Kafka ----------
api POST "/v1/programs/$P/reservations" "$TA" '{"invoiceId":"INV-QA-K","amount":{"value":"800.00","currency":"USD"}}' -H "idempotency-key: qa-$RUN-k"
RK=$(j .reservationId)
v0=$(sql "select version from program where id='$P'")
npm run -s simulate -- limit-cut --tenant bank-a --program "$P" --new-limit 500.00 --seq 2 >/dev/null; sleep 3
api GET "/v1/programs/$P/capacity" "$TA"
check QA-60 "limit cut below reserved -> over limit" $([ "$(j .limit)" = 500.00 ] && [ "$(j .overLimitBy)" = 300.00 ] && [ "$(j .available)" = 0.00 ] && echo 0 || echo 1) "limit=$(j .limit) reserved=$(j .reserved) overLimitBy=$(j .overLimitBy)"
api POST "/v1/programs/$P/reservations" "$TA" '{"invoiceId":"INV-QA-OL","amount":{"value":"1.00","currency":"USD"}}'
check QA-60 "new reserve while over limit -> 422" $(is "$S" 422) "$S $(j .type)"
lk=$(sql "select kind, delta_limit_minor from ledger_entry where program_id='$P' and kind='LIMIT_SET' order by id desc limit 1")
check QA-60 "DB ledger LIMIT_SET" $(is "$lk" "LIMIT_SET|-950000") "$lk"
ib=$(sql "select count(*) from inbox_message where message_id like 'ProgramLimitSet:bank-a:$P:%'")
check QA-60 "DB inbox rows for limit messages" $(is "$ib" 2) "$ib"
npm run -s simulate -- duplicate-delivery --tenant bank-a --program "$P" --new-limit 2000.00 --seq 3 >/dev/null; sleep 3
v1=$(sql "select version, treasury_seq, credit_limit_minor from program where id='$P'")
check QA-61 "duplicate delivery -> one effect" $(echo "$v1" | grep -q '|3|200000$' && echo 0 || echo 1) "version|treasury_seq|limit = $v1 (before v=$v0)"
npm run -s simulate -- out-of-order --tenant bank-a --program "$P" --new-limit 3000.00 --seq 4 >/dev/null; sleep 3
v2=$(sql "select treasury_seq, credit_limit_minor from program where id='$P'")
check QA-62 "out of order -> late seq skipped" $(is "$v2" "5|300000") "treasury_seq|limit = $v2"
npm run -s simulate -- repayments --tenant bank-a --program "$P" --invoice INV-QA-K --amount 800.00 --seq 6 >/dev/null; sleep 3
api GET "/v1/programs/$P/reservations/$RK" "$TA"
check QA-63 "RepaymentReceived x2 releases the reservation" $([ "$(j .status)" = RELEASED ] && [ "$(j '.releases|length')" = 2 ] && echo 0 || echo 1) "$(j .status) releases=$(j '.releases|length')"
d0=$(curl -s http://localhost:9465/metrics | awk '/^dlq_messages_total/{s+=$2} END{print s+0}')
npm run -s simulate -- poison-message --tenant bank-a --program "$P" --new-limit 4000.00 --seq 8 >/dev/null; sleep 4
d1=$(curl -s http://localhost:9465/metrics | awk '/^dlq_messages_total/{s+=$2} END{print s+0}')
lim=$(sql "select credit_limit_minor from program where id='$P'")
check QA-64 "poison: good message behind it applied" $(is "$lim" 400000) "limit_minor=$lim"
check QA-64 "poison: worker dlq_messages_total +2" $([ $(( ${d1%.*} - ${d0%.*} )) -ge 2 ] && echo 0 || echo 1) "dlq_messages_total $d0 -> $d1"
dlq=$($DC exec -T kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic treasury.capacity.v1.dlq --from-beginning --timeout-ms 6000 --property print.headers=true 2>/dev/null | grep -c "bank-a:$P\|x-error" )
check QA-64 "poison: records in treasury.capacity.v1.dlq with x-error headers" $([ "$dlq" -ge 1 ] && echo 0 || echo 1) "matching lines=$dlq"


# ---------- J. more treasury input over Kafka ----------
pub() { npx tsx tools/qa/publish.ts "$1" >/dev/null; sleep 3; }
api GET "/v1/programs/$P/capacity" "$TA"; seq=$(j .treasurySeq)
pub '[{"kind":"fx","base":"EUR","quote":"USD","rate":"1.1000000000","ageHours":0}]'
api POST "/v1/programs/$P/reservations" "$TA" '{"invoiceId":"INV-QA-FX2","amount":{"value":"100.00","currency":"EUR"}}'
check QA-90 "FxRatePublished: new EUR/USD 1.10 used by the next reserve" $([ "$S" = 201 ] && [ "$(j .reservedAmount.value)" = 110.00 ] && [ "$(j .fx.rate)" = 1.1000000000 ] && echo 0 || echo 1) "$S reserved=$(j .reservedAmount.value) rate=$(j .fx.rate)"
RFX=$(j .reservationId)
pub '[{"kind":"fx","base":"EUR","quote":"USD","rate":"1.0800000000","ageHours":0}]'
fr=$(sql "select rate from fx_rate where base='EUR' and quote='USD' order by as_of desc limit 1")
check QA-90 "DB latest EUR/USD restored to 1.08" $(is "$fr" 1.0800000000) "$fr"
pub '[{"kind":"fx","base":"GBP","quote":"USD","rate":"1.2700000000","ageHours":30}]'
api POST "/v1/programs/$P/reservations" "$TA" '{"invoiceId":"INV-QA-GBP2","amount":{"value":"10.00","currency":"GBP"}}'
check QA-91 "FX rate older than 24 h -> 422 fx-rate-unavailable" $([ "$S" = 422 ] && [ "$(j .type)" = https://errors.capacity.example/fx-rate-unavailable ] && echo 0 || echo 1) "$S $(j .type)"
g=$(sql "select count(*) from fx_rate where base='GBP' and quote='USD'")
check QA-91 "DB stores the stale rate anyway" $([ "$g" -ge 1 ] && echo 0 || echo 1) "rows=$g"
d0=$(curl -s http://localhost:9465/metrics | awk '/^dlq_messages_total/{s+=$2} END{print s+0}')
pub '[{"kind":"raw","topic":"treasury.fx-rates.v1","key":"EURUSD","value":"{\"messageId\":\"bad-fx\",\"type\":\"FxRatePublished\"}"}]'
d1=$(curl -s http://localhost:9465/metrics | awk '/^dlq_messages_total/{s+=$2} END{print s+0}')
check QA-92 "malformed FX message -> treasury.fx-rates.v1.dlq" $([ $(( ${d1%.*} - ${d0%.*} )) -ge 1 ] && echo 0 || echo 1) "dlq_messages_total $d0 -> $d1; $(curl -s http://localhost:9465/metrics | grep '^dlq_messages_total{topic="treasury.fx-rates.v1"' | head -1)"

pub "[{\"kind\":\"limit\",\"tenant\":\"bank-a\",\"program\":\"$P\",\"seq\":$((seq+1)),\"limit\":\"4000.00\",\"currency\":\"USD\",\"status\":\"SUSPENDED\"}]"
api POST "/v1/programs/$P/reservations" "$TA" '{"invoiceId":"INV-QA-SUS","amount":{"value":"1.00","currency":"USD"}}'
check QA-93 "ProgramLimitSet SUSPENDED -> reserve 422 program-suspended" $([ "$S" = 422 ] && [ "$(j .type)" = https://errors.capacity.example/program-suspended ] && echo 0 || echo 1) "$S $(j .type) db=$(sql "select status from program where id='$P'")"
api POST "/v1/programs/$P/reservations/$RFX/releases" "$TA" '{"releaseRef":"sus-cancel","reason":"CANCELLED"}'
check QA-93 "release still works while SUSPENDED" $(is "$S" 200) "$S $(j .reservationStatus)"
pub "[{\"kind\":\"limit\",\"tenant\":\"bank-a\",\"program\":\"$P\",\"seq\":$((seq+2)),\"limit\":\"4000.00\",\"currency\":\"USD\",\"status\":\"ACTIVE\"}]"
api POST "/v1/programs/$P/reservations" "$TA" '{"invoiceId":"INV-QA-SUS","amount":{"value":"1.00","currency":"USD"}}'
check QA-93 "ACTIVE again -> reserve 201" $(is "$S" 201) "$S"

d0=$(curl -s http://localhost:9465/metrics | grep '^dlq_messages_total{topic="treasury.capacity.v1",reason="tenant-mismatch"}' | awk '{print $2+0}'); d0=${d0:-0}
pub "[{\"kind\":\"raw\",\"topic\":\"treasury.capacity.v1\",\"key\":\"bank-b:$P\",\"value\":\"{\\\"messageId\\\":\\\"mm-$RUN\\\",\\\"type\\\":\\\"ProgramLimitSet\\\",\\\"schemaVersion\\\":1,\\\"tenantId\\\":\\\"bank-a\\\",\\\"programId\\\":\\\"$P\\\",\\\"seq\\\":$((seq+50)),\\\"occurredAt\\\":\\\"2026-10-28T00:00:00Z\\\",\\\"payload\\\":{\\\"creditLimit\\\":{\\\"value\\\":\\\"1.00\\\",\\\"currency\\\":\\\"USD\\\"}}}\"}]"
d1=$(curl -s http://localhost:9465/metrics | grep '^dlq_messages_total{topic="treasury.capacity.v1",reason="tenant-mismatch"}' | awk '{print $2+0}')
lim=$(sql "select credit_limit_minor from program where id='$P' and tenant_id='bank-a'")
check QA-94 "Kafka key names another tenant -> DLQ tenant-mismatch, no effect" $([ "${d1:-0}" -gt "$d0" ] && [ "$lim" = 400000 ] && echo 0 || echo 1) "tenant-mismatch $d0 -> $d1, limit_minor=$lim"

d0=$(curl -s http://localhost:9465/metrics | awk '/^dlq_messages_total/{s+=$2} END{print s+0}')
pub "[{\"kind\":\"repay\",\"tenant\":\"bank-a\",\"program\":\"$P\",\"seq\":$((seq+3)),\"invoice\":\"INV-NOPE\",\"ref\":\"nope-1\",\"amount\":\"1.00\",\"currency\":\"USD\"}]"
d1=$(curl -s http://localhost:9465/metrics | awk '/^dlq_messages_total/{s+=$2} END{print s+0}')
reason=$(curl -s http://localhost:9465/metrics | grep '^dlq_messages_total{topic="treasury.capacity.v1"' | sort -t' ' -k2 | tr '\n' ' ' | head -c 300)
check QA-95 "RepaymentReceived for an unknown invoice -> DLQ" $([ $(( ${d1%.*} - ${d0%.*} )) -ge 1 ] && echo 0 || echo 1) "dlq $d0 -> $d1"

pub "[{\"kind\":\"limit\",\"tenant\":\"bank-b\",\"program\":\"$P\",\"seq\":1,\"limit\":\"777.00\",\"currency\":\"EUR\"}]"
two=$(sql "select tenant_id||':'||currency||':'||credit_limit_minor from program where id='$P' order by tenant_id" | tr '\n' ' ')
check QA-96 "same program id in bank-b is a separate program (AC-16)" $(echo "$two" | grep -q 'bank-a:USD:400000 bank-b:EUR:77700' && echo 0 || echo 1) "$two"
api GET "/v1/programs/$P/capacity" "$TB"
check QA-96 "bank-b reads its own program" $([ "$S" = 200 ] && [ "$(j .currency)" = EUR ] && [ "$(j .limit)" = 777.00 ] && echo 0 || echo 1) "$S $(j .currency) $(j .limit)"

# ---------- K. reconciliation snapshots ----------
Q=prg_qa_rec_$RUN
pub "[{\"kind\":\"limit\",\"tenant\":\"bank-a\",\"program\":\"$Q\",\"seq\":1,\"limit\":\"1000.00\",\"currency\":\"USD\"}]"
for inv in R1:100.00 R2:200.00 R3:50.00; do
  api POST "/v1/programs/$Q/reservations" "$TA" "{\"invoiceId\":\"INV-${inv%%:*}\",\"amount\":{\"value\":\"${inv##*:}\",\"currency\":\"USD\"}}"
done
ps2=$(sql "select platform_seq from reservation where program_id='$Q' and invoice_id='INV-R2'")
before=$(sql "select reserved_minor||'|'||version from program where id='$Q'")
# S1: limit change, R1 within tolerance, T1 only in snapshot, R2 missing although covered by the watermark, R3 newer than watermark.
pub "[{\"kind\":\"snapshot\",\"tenant\":\"bank-a\",\"program\":\"$Q\",\"seq\":2,\"limit\":\"1500.00\",\"currency\":\"USD\",\"watermark\":$ps2,\"rows\":[{\"invoice\":\"INV-R1\",\"invoice_value\":\"100.00\",\"invoice_currency\":\"USD\",\"reserved_value\":\"100.01\"},{\"invoice\":\"INV-T1\",\"invoice_value\":\"50.00\",\"invoice_currency\":\"USD\",\"reserved_value\":\"50.00\"}]}]"
api GET "/v1/programs/$Q/capacity" "$TA"
check QA-100 "snapshot: treasury limit wins" $(is "$(j .limit)" 1500.00) "limit=$(j .limit) reserved=$(j .reserved) (before reserved|version=$before)"
r1=$(sql "select amount_minor from reservation where program_id='$Q' and invoice_id='INV-R1'")
check QA-101 "snapshot: 1-cent difference within tolerance keeps ours" $(is "$r1" 10000) "INV-R1 amount_minor=$r1"
t1=$(sql "select origin||'|'||amount_minor||'|'||status from reservation where program_id='$Q' and invoice_id='INV-T1'")
check QA-102 "snapshot: reservation only treasury knows is adopted" $(is "$t1" "TREASURY|5000|ACTIVE") "INV-T1 $t1"
r2=$(sql "select status||'|'||amount_minor from reservation where program_id='$Q' and invoice_id='INV-R2'")
check QA-103 "snapshot: ours missing although covered by watermark -> HOLD (kept)" $(is "$r2" "ACTIVE|20000") "INV-R2 $r2"
r3=$(sql "select status||'|'||amount_minor from reservation where program_id='$Q' and invoice_id='INV-R3'")
check QA-104 "snapshot: ours newer than watermark is kept" $(is "$r3" "ACTIVE|5000") "INV-R3 $r3"
drift=$(sql "select payload::text from outbox_event where program_id='$Q' and type='ReconciliationDriftDetected' order by program_seq desc limit 1")
check QA-105 "snapshot: ReconciliationDriftDetected with driftCount" $(echo "$drift" | grep -q '"driftCount"' && echo 0 || echo 1) "$(echo "$drift" | head -c 260)"
la=$(sql "select string_agg(kind, ',' order by id) from ledger_entry where program_id='$Q'")
check QA-106 "snapshot: ledger has LIMIT_SET and RECON_ADJUST" $(echo "$la" | grep -q 'RECON_ADJUST' && echo "$la" | grep -c LIMIT_SET >/dev/null && echo 0 || echo 1) "$la"
inv=$(sql "select p.reserved_minor = coalesce((select sum(amount_minor-released_minor) from reservation r where r.tenant_id=p.tenant_id and r.program_id=p.id and r.status<>'RELEASED'),0) from program p where id='$Q'")
check QA-106 "snapshot: reserved still equals open reservations" $(is "$inv" t) "$inv"
# S2: treasury reports R1 at 90.00 (beyond tolerance); everything else matches.
psq=$(sql "select platform_seq from program where id='$Q'")
pub "[{\"kind\":\"snapshot\",\"tenant\":\"bank-a\",\"program\":\"$Q\",\"seq\":3,\"limit\":\"1500.00\",\"currency\":\"USD\",\"watermark\":$psq,\"rows\":[{\"invoice\":\"INV-R1\",\"invoice_value\":\"90.00\",\"invoice_currency\":\"USD\",\"reserved_value\":\"90.00\"},{\"invoice\":\"INV-R2\",\"invoice_value\":\"200.00\",\"invoice_currency\":\"USD\",\"reserved_value\":\"200.00\"},{\"invoice\":\"INV-R3\",\"invoice_value\":\"50.00\",\"invoice_currency\":\"USD\",\"reserved_value\":\"50.00\"},{\"invoice\":\"INV-T1\",\"invoice_value\":\"50.00\",\"invoice_currency\":\"USD\",\"reserved_value\":\"50.00\"}]}]"
r1=$(sql "select status||'|'||(amount_minor-released_minor)||'|'||(invoice_amount_minor-released_invoice_minor) from reservation where program_id='$Q' and invoice_id='INV-R1'")
check QA-107 "snapshot: real difference -> treasury amount wins" $(is "$r1" "PARTIALLY_RELEASED|9000|9000") "INV-R1 status|outstanding|invoice outstanding = $r1"
v=$(sql "select version||'|'||treasury_seq from program where id='$Q'")
pub "[{\"kind\":\"snapshot\",\"tenant\":\"bank-a\",\"program\":\"$Q\",\"seq\":1,\"limit\":\"1.00\",\"currency\":\"USD\",\"watermark\":0,\"rows\":[]}]"
v2=$(sql "select version||'|'||treasury_seq||'|'||credit_limit_minor from program where id='$Q'")
check QA-108 "snapshot with an old seq is skipped" $(is "$v2" "$v|150000") "before=$v after=$v2"
sk=$(sql "select count(*) from reconcile_snapshot_row where program_id='$Q'")
check QA-109 "staging table is empty after every snapshot" $(is "$sk" 0) "rows=$sk"

# ---------- H. outbound events on Kafka ----------
ev=$($DC exec -T kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic capacity.events.v1 --from-beginning --timeout-ms 8000 --property print.key=true 2>/dev/null | grep "bank-a:$P")
types=$(echo "$ev" | grep -o '"type":"[A-Za-z]*"' | sort | uniq -c | tr -s ' ' | tr '\n' ';')
check QA-70 "events on capacity.events.v1 keyed bank-a:$P" $(echo "$types" | grep -q ReservationCreated && echo "$types" | grep -q ReservationReleased && echo "$types" | grep -q ProgramCapacityChanged && echo 0 || echo 1) "$types"
seqs=$(sql "select string_agg(program_seq::text, ',' order by program_seq) from outbox_event where tenant_id='bank-a' and program_id='$P'")
gaps=$(sql "select count(*) from (select program_seq - lag(program_seq) over (order by program_seq) d from outbox_event where tenant_id='bank-a' and program_id='$P') x where d <> 1")
check QA-71 "outbox program_seq gap-free and all published" $([ "$gaps" = 0 ] && [ "$(sql "select count(*) from outbox_event where tenant_id='bank-a' and program_id='$P' and published_at is null")" = 0 ] && echo 0 || echo 1) "seq=$seqs"

# ---------- I. invariants ----------
inv=$(sql "select p.reserved_minor, coalesce((select sum(amount_minor-released_minor) from reservation r where r.tenant_id=p.tenant_id and r.program_id=p.id and r.status<>'RELEASED'),0), coalesce((select sum(delta_reserved_minor) from ledger_entry l where l.tenant_id=p.tenant_id and l.program_id=p.id),0) from program p where p.tenant_id='bank-a' and p.id='$P'")
IFS='|' read -r a b c <<<"$inv"
check QA-80 "I1/I5: reserved = open reservations = ledger sum" $([ "$a" = "$b" ] && [ "$b" = "$c" ] && echo 0 || echo 1) "$inv"
upd=$(sql "update ledger_entry set actor='x' where program_id='$P'" 2>&1 | head -1)
check QA-81 "ledger is append-only (UPDATE refused)" $(echo "$upd" | grep -q 'append-only' && echo 0 || echo 1) "$upd"
m=$(curl -s http://localhost:9465/metrics | awk '/^invariant_mismatch_programs/{print $2}')
check QA-82 "invariant job reports 0 mismatches" $(is "${m:-x}" 0) "invariant_mismatch_programs=$m"

echo "TOTAL pass=$pass fail=$fail program=$P"
exit $fail
