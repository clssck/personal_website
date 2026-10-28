# ---- build the static site with Bun ----
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ---- serve the static output with nginx ----
FROM nginx:alpine AS runtime
# Pick up Alpine security fixes the base image has not been rebuilt with yet.
RUN apk upgrade --no-cache
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
