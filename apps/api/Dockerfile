# The Goalify API.
#
#   docker compose --profile app build api
#
# The build context is the repository root, not this directory: an npm workspaces install
# needs the root package.json and the root package-lock.json to be reproducible, and
# neither is reachable from apps/api.
#
# Two stages are meant to be built from this file. `runtime` is the default and runs the
# server. `migrate` carries the Prisma CLI and the migration SQL, and docker-compose
# builds it as a separate one-shot service — see the note above that service for why the
# server does not apply migrations itself.

# One base image for building and for running, and specifically an Alpine one for both.
# Prisma compiles a native query engine per platform, `native` picks it at generate time,
# and the copy made further down would be the wrong file if the two stages disagreed
# about libc. Pinned to a major so a rebuild cannot silently move Node versions.
FROM node:22-alpine AS deps
WORKDIR /app

# Manifests and the lockfile on their own first, so the install layer survives every
# source edit and only a dependency change pays for it again.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
# The schema comes with them because @prisma/client generates from it during postinstall,
# and without it here that step would quietly produce nothing.
COPY apps/api/prisma ./apps/api/prisma

# Scoped to this workspace, so the API image never carries the web application's
# dependencies — lucide-react alone is larger than everything the server needs.
RUN npm ci --workspace=apps/api --include-workspace-root

FROM deps AS build
WORKDIR /app
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json ./apps/api/
COPY apps/api/src ./apps/api/src
# `generate` explicitly rather than trusting the postinstall above: this is the step that
# decides which engine binary the image ends up with, and it should be readable in the log.
RUN npm run generate --workspace=apps/api \
  && npm run build --workspace=apps/api

# Schema migrations and the seed script. Its own stage because both need the Prisma CLI
# and tsx, and the server needs neither — shipping them into the runtime image would put
# `prisma migrate reset` inside the container that faces the internet.
FROM build AS migrate
WORKDIR /app/apps/api
# `migrate deploy`, never `migrate dev`: deploy applies the migrations that are committed
# and does nothing else, while dev is free to author a new one, or to drop the database
# and start again when it finds drift. Only one of those belongs near real data.
CMD ["npx", "prisma", "migrate", "deploy"]

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
# A second, production-only install rather than pruning the first: `--omit=dev` leaves out
# typescript, vitest and tsx, which are most of the tree by size and none of which the
# server calls.
RUN npm ci --omit=dev --workspace=apps/api --include-workspace-root \
  # The Prisma CLI, which that install keeps despite --omit=dev — and despite it being a
  # devDependency. @prisma/client declares `prisma` as an optional peer, so npm reaches it
  # from a production dependency and considers it production. Removing it by hand is what
  # actually keeps `prisma migrate reset` out of the container that faces the internet.
  # Everything after the CLI itself is reachable from nothing else once it is gone:
  # @prisma/engines and fetch-engine are the binaries it downloads and the downloader,
  # @prisma/config pulls in effect which pulls in fast-check, and typescript is the CLI's
  # other optional peer. `luxon` deliberately stays — cron-parser needs it, and pg-boss
  # needs cron-parser to know when the daily notifications are due.
  && rm -rf \
    node_modules/prisma \
    node_modules/@prisma/engines \
    node_modules/@prisma/fetch-engine \
    node_modules/@prisma/config \
    node_modules/effect \
    node_modules/fast-check \
    node_modules/typescript \
  # The download cache, which is a third of the layer and is never read again: this image
  # installs nothing at runtime.
  && npm cache clean --force

# The generated Prisma client, which that install cannot produce on its own — generating
# is the CLI's job and the CLI is a devDependency. Copying the output instead is exactly
# what allows the CLI to stay out.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/apps/api/dist ./apps/api/dist

# node:alpine ships this account. Root inside a container is one container escape away
# from root on the host, and the server writes nothing to its own filesystem.
USER node

WORKDIR /app/apps/api
ENV PORT=4000
EXPOSE 4000
# Exec form, so node is PID 1 and receives SIGTERM directly. server.ts handles it: jobs
# stop, connections drain, the pool closes. Wrapping this in a shell would swallow the
# signal and every redeploy would be a kill -9.
CMD ["node", "dist/server.js"]
