# WprGo (WebPageReplay) builder stage
# Pinned to a commit on the "cookiecrumbler" branch; bump this to invalidate the cache.
FROM golang:1.27@sha256:ec47ea3725fea0cc88f6de94919aef19f40f12fc1ec0e2d1b3426dbf15ecca04 AS wpr-builder

# https://github.com/brave-experiments/webpagereplay (cookiecrumbler branch)
ARG WPR_GO_COMMIT=e1c683f26a53fa7923e9987d0d35fcbe081b65c3

RUN git clone https://github.com/brave-experiments/webpagereplay.git /webpagereplay && \
    cd /webpagereplay && \
    git checkout ${WPR_GO_COMMIT} && \
    CGO_ENABLED=0 go build -o /wpr ./src/wpr.go

# Base application image
FROM ghcr.io/pnpm/pnpm:12.21.0@sha256:168feba88e6a1684c99a62cbf4fe361d4e683e2a6c920d3b0acde7e15a28b62d

ARG FULL_CACHEBUST=0

ARG CHANNEL=nightly # release, beta, nightly
ARG PACKAGE_NAME=brave-browser-${CHANNEL}
ARG PACKAGE_NAME=${PACKAGE_NAME%%-release} # strip -release from the package name
ENV BRAVE_BINARY=/usr/bin/${PACKAGE_NAME}

ARG DEBIAN_FRONTEND=noninteractive

# The pnpm base image already ships curl; only the Brave apt repo is added here.
RUN apt-get -qq update && \
    curl -fsSLo /usr/share/keyrings/${PACKAGE_NAME}-archive-keyring.gpg https://brave-browser-apt-${CHANNEL}.s3.brave.com/${PACKAGE_NAME}-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/${PACKAGE_NAME}-archive-keyring.gpg] https://brave-browser-apt-${CHANNEL}.s3.brave.com/ stable main" | tee /etc/apt/sources.list.d/brave-browser-${CHANNEL}.list && \
    apt-get -qq update && \
    apt-get -qy install ${PACKAGE_NAME} fonts-dejavu-core fonts-noto-color-emoji patch --no-install-recommends && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*

ARG GIT_COMMIT
ENV GIT_COMMIT=${GIT_COMMIT}

# The pnpm base image leaves /pnpm world-writable (chmod -R a+rwX in its
# install script), so everything it contains can be created as the unprivileged
# user directly. Creating the user first and installing Node afterwards avoids
# a `chown -R /pnpm`, which would otherwise re-emit the entire Node runtime
# (~365 MB) into a new layer just to change file ownership.
RUN useradd --create-home --uid 1000 --shell /bin/bash node && \
    chown node:node /app

USER node

# This image ships pnpm but not Node; install Node 24 onto PATH.
RUN pnpm runtime set node 24 -g -y
WORKDIR /app
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml /app
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
