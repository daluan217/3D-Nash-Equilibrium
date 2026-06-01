# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source files
COPY server.ts ./
COPY .env.example ./.env.example

# Build the server (only esbuild, skip vite frontend build)
RUN npx esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs

# Runtime stage
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy built server from builder
COPY --from=builder /app/dist/server.cjs ./dist/
COPY --from=builder /app/.env.example ./.env.example

# Create a directory for the database
RUN mkdir -p /app/data

# Set environment variable for the database path
ENV ELECTRON_USER_DATA_PATH=/app/data

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || '3000') + '/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Expose port
EXPOSE 3000

# Run the server directly
CMD ["node", "dist/server.cjs"]
