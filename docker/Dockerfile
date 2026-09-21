# Local dev/test sandbox: a real opencode install plus Node/npm/Python,
# so this repo's deploy/ config and plugins/ can be exercised against a
# real `opencode run` without touching the host's own opencode config or
# trusting an all-permission agent with anything outside this container.
# Needs outbound network access to the npm registry.
#
# The repo itself is bind-mounted at build/run time, not copied in here
# - see docker-compose.yml. This image only provides the toolchain.
FROM node:22-bookworm

# git: opencode shells out to it. python3: SETUP.md's JSON-validation step.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      python3 \
      ca-certificates \
      vim \
      less \
    && rm -rf /var/lib/apt/lists/*

# Pinned via OPENCODE_VERSION in docker/.env, not @latest, for a
# reproducible build.
ARG OPENCODE_VERSION
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}"

# Non-root user, so an all-permission agent's blast radius stays inside
# this container. node:22-bookworm's built-in "node" user/group also
# sits at 1000:1000, so drop it first to avoid a UID/GID collision.
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

# Stays root at container start so the entrypoint can load provider keys
# and regenerate opencode.jsonc as the dev user before exec'ing the real
# command - see docker-entrypoint.sh.
COPY --chmod=755 docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bash"]
