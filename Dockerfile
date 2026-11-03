FROM node:24.16.0@sha256:40ad9f3064e67d6860b4bc3fe1880b2953934fd6320ada990e45fe0efa6badd7 AS web
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
ARG VITE_CARTO_KEY
RUN npm run build

FROM golang:1.27.3@sha256:2920bb124f1a2e12a1d39f0cab756ae0068441ee1da7655dec7f5e374944095b AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/dist ./web/dist
RUN CGO_ENABLED=0 go build -trimpath -o /server .

FROM alpine:3.23@sha256:ff7f0c727dd796aa36787bfcd9a64bf35a6ce72a73451b3359fde849b6703d63
RUN apk add --no-cache ca-certificates && \
    addgroup -S app && adduser -S -G app app && \
    mkdir -p /app/pb_data && chown app:app /app/pb_data
COPY --from=build /server /app/server
USER app
WORKDIR /app
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8090/api/health || exit 1
CMD ["/app/server", "serve", "--http=0.0.0.0:8090", "--dir=/app/pb_data", "--encryptionEnv=PB_ENCRYPTION_KEY"]
