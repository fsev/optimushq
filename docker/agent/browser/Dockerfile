FROM claude-agent-base

USER root

RUN npx playwright install --with-deps chromium

USER node

WORKDIR /workspace
