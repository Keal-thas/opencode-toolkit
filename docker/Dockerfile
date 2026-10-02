# Isolated dev/test sandbox running a real opencode install - safe to do anything inside.
FROM node:22-bookworm

ARG OPENCODE_VERSION
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}"

# uv/uvx - self-contained (Rust binary, no python dependency for the
# installer itself; uvx manages its own Python toolchain on demand).
# Needed to run the official upstream redis-mcp-server package the way a
# real deployment would (mcp-servers/redis/ uses it unmodified rather than
# vendoring - see mcp-servers/redis/README.md), so its integration test can
# spawn the real thing instead of staying manual-only.
RUN curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh

# @playwright/mcp + a real headless Chromium, installed the same way
# mcp-servers/playwright/README.md documents for a real deployment
# (global npm install), so the sandbox can spawn the real official
# package - not our own code, see that README - against a real browser.
# --with-deps also apt-get installs the Linux shared libs Chromium needs
# (libnss3, libatk1.0-0, libgbm1, etc.) that node:22-bookworm doesn't ship
# by default - has to happen here, as root, since the `dev` user created
# below can't apt-get install anything itself. PLAYWRIGHT_BROWSERS_PATH
# pins the download location to somewhere every container user can read -
# it would otherwise land under whichever user's home ran the install
# (root's, at this build stage), unreadable by `dev` at runtime.
# Two separate installs are both needed, confirmed live (not assumed) -
# `playwright install --with-deps chromium` alone downloads a Chromium
# revision pinned by whatever bare `playwright` package npx resolves,
# which is NOT the same revision @playwright/mcp's own bundled
# playwright-core dependency actually asks for at runtime (observed:
# "chrome-for-testing" is not installed; expected executable at
# .../chromium-1246/..." even though .../chromium-1243/... was what got
# downloaded) - so `@playwright/mcp install-browser` has to run too, to
# fetch the exact revision @playwright/mcp itself will look for. Doing
# this at build time, as root, is required, not just convenient - the
# `dev` user can't write into /opt/ms-playwright at runtime (its own
# EACCES confirmed the same way), by design (see the ENV comment above).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g @playwright/mcp \
    && npx --yes playwright install --with-deps chromium \
    && npx --yes @playwright/mcp install-browser chrome-for-testing \
    && chmod -R a+rX /opt/ms-playwright

# Non-root user. Gotcha: node:22-bookworm already has a `node` user at 1000:1000, so drop it first to avoid a UID/GID collision.
ARG USERNAME=dev
ARG UID=1000
ARG GID=1000
RUN (userdel -r node 2>/dev/null || true) \
    && (groupdel node 2>/dev/null || true) \
    && groupadd -g "${GID}" "${USERNAME}" \
    && useradd -m -u "${UID}" -g "${GID}" -s /bin/bash "${USERNAME}" \
    && mkdir -p /home/${USERNAME}/.config/opencode /home/${USERNAME}/.local/share/opencode \
    && chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}

WORKDIR /home/${USERNAME}/project

# Root at start: the entrypoint loads provider keys + regenerates opencode.jsonc as dev before exec'ing the real command (see entrypoint.sh).
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
