# Orin Router — standalone image.
#
# The sources use NodeNext-style ".js" import specifiers, so the standalone
# server needs a real compile to dist/ rather than Node's type stripping.
# Vercel ignores this and deploys the TypeScript directly.
FROM node:22-alpine

# NODE_ENV is deliberately not set here: npm omits devDependencies whenever it
# is "production", and the build needs typescript. It is set after the build.
ENV PORT=8080 \
    HOST=0.0.0.0

# tini reaps zombies and forwards signals so the container stops cleanly.
RUN apk add --no-cache tini

WORKDIR /app

# Dependencies first so the layer caches. The platform workspace is a submodule
# and must be present for the file: links in package.json to resolve.
COPY package.json package-lock.json ./
COPY vendor/orin-platform ./vendor/orin-platform
RUN npm ci --ignore-scripts \
 && npm --prefix vendor/orin-platform ci --ignore-scripts \
 && npm --prefix vendor/orin-platform run build

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY api ./api
COPY server ./server

# Build with dev dependencies, then drop them so the runtime image stays small.
RUN npm run build:standalone && npm prune --omit=dev

ENV NODE_ENV=production

# Run unprivileged. The node image already ships a `node` user (uid 1000).
RUN chown -R node:node /app
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server/index.js"]
