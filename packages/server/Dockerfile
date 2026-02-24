# ---- Build Stage ----
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY packages/server/package.json packages/server/pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

COPY packages/server/src ./src
COPY packages/server/tsconfig.json ./

RUN pnpm run build

# ---- Production Stage ----
FROM node:20-alpine AS production

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production

EXPOSE 3001 3002

CMD ["node", "dist/index.js"]
