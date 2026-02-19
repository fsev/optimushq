FROM claude-agent-base

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    unzip \
    xz-utils \
    zip \
    clang \
    cmake \
    ninja-build \
    pkg-config \
    libgtk-3-dev \
    && rm -rf /var/lib/apt/lists/*

ENV FLUTTER_HOME=/opt/flutter
ENV PATH="${FLUTTER_HOME}/bin:${PATH}"

RUN git clone --depth 1 --branch stable https://github.com/flutter/flutter.git ${FLUTTER_HOME} \
    && flutter precache \
    && flutter config --no-analytics \
    && chown -R node:node ${FLUTTER_HOME}

USER node

WORKDIR /workspace
