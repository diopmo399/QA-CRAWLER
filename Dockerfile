# syntax=docker/dockerfile:1
# Official Playwright image: Chromium + its system libraries, matching the
# pinned `playwright` version in package.json (keep both in sync).
ARG PLAYWRIGHT_VERSION=1.56.1

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
# Optional AI reasoning advisor (ai.provider: copilot). Off by default at runtime; this only
# controls whether the GitHub Copilot SDK (~150 MB with its runtime) is shipped in the image.
# Without it, ai.mode ASSIST/HYBRID reports AI_UNAVAILABLE and falls back to deterministic.
ARG WITH_COPILOT_SDK=true
RUN if [ "$WITH_COPILOT_SDK" != "true" ]; then rm -rf node_modules/@github/copilot-sdk*; fi

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
LABEL org.opencontainers.image.title="qa-crawler" \
      org.opencontainers.image.description="Deterministic headless QA crawler (Playwright + Chromium)"
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    # Chromium and npm need a writable HOME; arbitrary UIDs (OpenShift) have none.
    HOME=/tmp \
    NO_COLOR=1

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scenarios ./scenarios
COPY domain-packs ./domain-packs

# Output directories writable by the group 0 as well, so the image also works
# with the random UID OpenShift assigns (always member of group 0).
RUN mkdir -p reports screenshots knowledge \
    && chown -R pwuser:0 /app/reports /app/screenshots /app/knowledge \
    && chmod -R g=u /app/reports /app/screenshots /app/knowledge

# Non-root user shipped with the Playwright image.
USER pwuser

ENTRYPOINT ["node", "dist/main.js"]
CMD ["--help"]
