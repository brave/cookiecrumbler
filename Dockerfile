# WprGo (WebPageReplay) builder stage
# Pinned to a commit on the "cookiecrumbler" branch; bump this to invalidate the cache.
FROM golang:1.27@sha256:2920bb124f1a2e12a1d39f0cab756ae0068441ee1da7655dec7f5e374944095b AS wpr-builder

# https://github.com/brave-experiments/webpagereplay (cookiecrumbler branch)
ARG WPR_GO_COMMIT=e1c683f26a53fa7923e9987d0d35fcbe081b65c3

RUN git clone https://github.com/brave-experiments/webpagereplay.git /webpagereplay && \
    cd /webpagereplay && \
    git checkout ${WPR_GO_COMMIT} && \
    CGO_ENABLED=0 go build -o /wpr ./src/wpr.go

# Base application image
FROM ghcr.io/pnpm/pnpm:12.15.0@sha256:d6148daf3ad2af8fa4ecd1aa06db73da32b2e37f63088987eea2fb375ee7f320

ARG FULL_CACHEBUST=0

ARG CHANNEL=nightly # release, beta, nightly
ARG PACKAGE_NAME=brave-browser-${CHANNEL}
ARG PACKAGE_NAME=${PACKAGE_NAME%%-release} # strip -release from the package name
ENV BRAVE_BINARY=/usr/bin/${PACKAGE_NAME}

ARG DEBIAN_FRONTEND=noninteractive
ENV DEBIAN_FRONTEND=$DEBIAN_FRONTEND
ENV AWS_LWA_PORT=3000

RUN apt-get -qq update && \
    apt-get -qy install curl && \
    curl -fsSLo /usr/share/keyrings/${PACKAGE_NAME}-archive-keyring.gpg https://brave-browser-apt-${CHANNEL}.s3.brave.com/${PACKAGE_NAME}-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/${PACKAGE_NAME}-archive-keyring.gpg] https://brave-browser-apt-${CHANNEL}.s3.brave.com/ stable main" | tee /etc/apt/sources.list.d/brave-browser-${CHANNEL}.list && \
    apt-get -qq update && \
    apt-get -qy install ${PACKAGE_NAME} fonts-dejavu-core fonts-noto-color-emoji patch --no-install-recommends && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*

ARG GIT_COMMIT
ENV GIT_COMMIT=${GIT_COMMIT}

# This image ships pnpm but not Node; install Node 24 onto PATH.
RUN pnpm runtime set node 24 -g -y

RUN useradd --create-home --uid 1000 --shell /bin/bash node && \
    chown -R node:node /app /pnpm

USER node
WORKDIR /app
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml /app
COPY --chown=node:node packages/netlog2wpr/package.json /app/packages/netlog2wpr/
RUN pnpm install --frozen-lockfile
RUN pnpm run rebrowser-patches
COPY --chown=node:node . /app

ARG SETUP_CACHEBUST=0

RUN pnpm run build
RUN pnpm run setup ${BRAVE_BINARY} && chmod -R o+rX /app/profile

# WprGo binary and assets (certs, deterministic.js) are installed outside /app;
# the code prefers locally-built binaries and webpagereplay checkouts at the app
# root when present.
COPY --from=wpr-builder /wpr /usr/local/bin/wpr
COPY --from=wpr-builder \
    /webpagereplay/deterministic.js \
    /webpagereplay/wpr_cert.pem \
    /webpagereplay/wpr_key.pem \
    /webpagereplay/ecdsa_cert.pem \
    /webpagereplay/ecdsa_key.pem \
    /usr/local/share/webpagereplay/

EXPOSE 3000
COPY --chmod=755 <<EOT /docker-entrypoint.sh
#!/bin/sh
exec pnpm run serve ${BRAVE_BINARY} 3000
EOT
ENTRYPOINT ["/docker-entrypoint.sh"]
