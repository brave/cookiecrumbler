# Base application image
FROM ghcr.io/pnpm/pnpm:12.4.0@sha256:4fcb6db39468ecafef34f3e866730df106f7639ba4512e42885d80f868ccb257

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
RUN pnpm install --frozen-lockfile
RUN pnpm run rebrowser-patches
COPY --chown=node:node . /app

ARG SETUP_CACHEBUST=0

RUN pnpm run build
RUN pnpm run setup ${BRAVE_BINARY} && chmod -R o+rX /app/profile

EXPOSE 3000
COPY --chmod=755 <<EOT /docker-entrypoint.sh
#!/bin/sh
exec pnpm run serve ${BRAVE_BINARY} 3000
EOT
ENTRYPOINT ["/docker-entrypoint.sh"]
