# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    # --ignore-scripts also skips the native Kafka binding; fetch only that one.
    && npm rebuild @confluentinc/kafka-javascript \
    && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
# Every role starts with `node`, so the package managers bundled in the base image are dead
# weight and their own dependencies are the image's only CVEs: remove them.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
# The AsyncAPI viewer behind /docs/asyncapi is a devDependency: the page needs only its prebuilt
# browser bundle and stylesheet, not the parser's dependency tree, so only those files ship.
ARG ASYNCAPI_UI=node_modules/@asyncapi/react-component
COPY --chown=node:node --from=deps /app/${ASYNCAPI_UI}/package.json /app/${ASYNCAPI_UI}/LICENSE ./${ASYNCAPI_UI}/
COPY --chown=node:node --from=deps /app/${ASYNCAPI_UI}/browser/standalone/index.js /app/${ASYNCAPI_UI}/browser/standalone/index.js.LICENSE.txt ./${ASYNCAPI_UI}/browser/standalone/
COPY --chown=node:node --from=deps /app/${ASYNCAPI_UI}/styles/default.min.css ./${ASYNCAPI_UI}/styles/
# The compiled tree takes the place of src/, so the package.json "imports" map (#src/*)
# resolves to the same layout in the image as it does in the repository.
COPY --chown=node:node --from=build /app/dist ./src
USER node
EXPOSE 3000 9464
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.OPS_PORT||9464)+'/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/main.js"]
