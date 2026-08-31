# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including devDependencies for build tools)
RUN npm ci

# Copy source files
COPY server.ts ./
COPY src/ ./src/
COPY public/ ./public/
COPY index.html ./
COPY vite.config.ts ./
# Build frontend (Vite) and server (esbuild)
RUN npm run build

# Runtime stage
FROM node:22-alpine

WORKDIR /app

# Production by construction, not by deployment.
#
# The server only serves dist/ when NODE_ENV=production; otherwise it expects a
# Vite dev middleware and every frontend request 404s while /api/health happily
# keeps answering 200 — an outage no health check can see. NODE_ENV used to
# arrive ONLY through cloudbuild.yaml's --set-env-vars, and that flag REPLACES
# the whole environment on every deploy, so one dropped name would have taken
# the entire website down. It is not hypothetical: revision 00168-wln, from the
# 2026-08-31 env-wipe, was missing NODE_ENV.
#
# Baking it into the image means the container cannot be demoted out of
# production mode by anything that happens to the deploy environment. The
# deploy still sets it, and the env manifest still requires it.
ENV NODE_ENV=production

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy built server and frontend from builder
COPY --from=builder /app/dist/ ./dist/

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || '3000') + '/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Expose port
EXPOSE 3000

# Run the server directly
CMD ["node", "dist/server.cjs"]
