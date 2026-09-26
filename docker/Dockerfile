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

# Root at start: the entrypoint loads provider keys + regenerates opencode.jsonc as dev before exec'ing the real command (see docker-entrypoint.sh).
COPY --chmod=755 docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bash"]
