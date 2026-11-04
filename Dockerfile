# syntax=docker/dockerfile:1.7

# ---- dependencies: the full tree, cached on the lockfile alone ------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
ENV CI=true
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build: TypeScript to JavaScript -------------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ---- production dependencies only (no compiler, no test runner, no linter in the final image) -----------------------
FROM deps AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ---- runtime ----------------------------------------------------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node site ./site
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
