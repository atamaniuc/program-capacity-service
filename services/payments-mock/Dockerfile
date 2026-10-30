# syntax=docker/dockerfile:1
# payments-mock image (lane 0006 T14, ADR 025/026): the simulated payment rail, no runtime
# dependencies. Build context is the repository root:
#   docker build -f services/payments-mock/Dockerfile -t payments-mock:ms-local .
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY services/funding/package.json ./services/funding/
COPY services/payments-mock/package.json ./services/payments-mock/
RUN npm ci --ignore-scripts

FROM deps AS build
COPY tsconfig.json ./
COPY services/payments-mock ./services/payments-mock
RUN npm run build --workspace services/payments-mock

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --chown=node:node services/payments-mock/package.json ./package.json
COPY --chown=node:node --from=build /app/services/payments-mock/dist ./src
USER node
EXPOSE 3200 9466
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PAYMENTS_OPS_PORT||9466)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/main.js"]
