FROM node:20-alpine

WORKDIR /app

# Enable Corepack so pnpm is available
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Install build tools needed for native modules
RUN apk add --no-cache python3 make g++

# Copy everything needed for pnpm to resolve the workspace
COPY package.json pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY artifacts ./artifacts
COPY lib ./lib
COPY scripts ./scripts

# Install dependencies (no lockfile committed yet, so this resolves fresh)
RUN pnpm install --frozen-lockfile=false

# Build only the api-server workspace (mockup-sandbox isn't needed at runtime)
RUN pnpm --filter @workspace/api-server run build

EXPOSE 3000

CMD ["pnpm", "--filter", "@workspace/api-server", "run", "start"]
