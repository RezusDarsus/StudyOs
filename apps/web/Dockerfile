# The Goalify web application: a Vite build, served by nginx.
#
#   docker compose --profile app build web
#
# Same repository-root build context as the API image, for the same reason — the lockfile.
#
# nginx here is not only a static file server. It also reverse-proxies /api to the API
# container and /connection/websocket to Centrifugo, which puts the whole product behind
# one origin, exactly as the Vite dev proxy does in development. See nginx.conf for why
# that matters to the session cookie.

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
RUN npm ci --workspace=apps/web --include-workspace-root

COPY apps/web ./apps/web
# `tsc -b && vite build`. The typecheck is part of the build on purpose: an image should
# not be producible from code that does not compile.
RUN npm run build --workspace=apps/web

# Alpine nginx. Its master process binds the port as root and then drops every worker to
# the unprivileged `nginx` user, which is the model the official image is built around;
# nothing served here is writable by those workers.
FROM nginx:1.29-alpine AS runtime

# Replaces the packaged default rather than sitting beside it. Two server blocks both
# listening on 80 would make which one answers depend on filename ordering.
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
# Not in conf.d: everything there is included into `http` automatically, and these are
# location-level directives that would refuse to load at that level. This one is included
# by hand, from the blocks that want it.
COPY apps/web/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
