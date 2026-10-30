# syntax=docker/dockerfile:1
# funding-service image (lane 0006 T14, ADR 026). Build context is the repository root:
#   docker build -f services/funding/Dockerfile -t funding-service:ms-local .
# `api` runs `node src/main.js`; the worker overrides the command with `node src/worker.js`.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY services/funding/package.json ./services/funding/
COPY services/payments-mock/package.json ./services/payments-mock/
RUN npm ci --ignore-scripts

FROM deps AS build
COPY tsconfig.json ./
COPY packages/contracts ./packages/contracts
# @finverity/contracts ships TypeScript stubs in the repository (ADR 028); the image needs JS.
# Compile them into a real package that replaces the workspace link, in this stage and the runtime.
RUN npx tsc -p packages/contracts/tsconfig.build.json \
    && rm -rf node_modules/@finverity/contracts \
    && mkdir -p node_modules/@finverity \
    && cp -R packages/contracts/dist node_modules/@finverity/contracts \
    && printf '%s' '{"name":"@finverity/contracts","version":"0.1.0","type":"module","exports":{"./capacity/v1":{"types":"./finverity/capacity/v1/capacity_service.d.ts","default":"./finverity/capacity/v1/capacity_service.js"}}}' > node_modules/@finverity/contracts/package.json
COPY services/funding ./services/funding
RUN npm run build --workspace services/funding

FROM node:24-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY services/funding/package.json ./services/funding/
COPY services/payments-mock/package.json ./services/payments-mock/
# Only this service's dependencies; every workspace link is dropped (the compiled contracts
# package is copied in the runtime stage).
RUN npm ci --omit=dev --ignore-scripts --workspace services/funding --include-workspace-root=false \
    && rm -rf node_modules/@finverity \
    && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
# Every role starts with `node`: the bundled package managers are dead weight and the image's
# only CVEs (as in the capacity image).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
# The service's package.json carries the "imports" map (#src/*) the compiled tree resolves.
COPY --chown=node:node services/funding/package.json ./package.json
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/node_modules/@finverity/contracts ./node_modules/@finverity/contracts
# The compiled tree takes the place of src/, so "#src/*" resolves as it does in the repository.
COPY --chown=node:node --from=build /app/services/funding/dist ./src
USER node
EXPOSE 3100 9464
CMD ["node", "src/main.js"]
