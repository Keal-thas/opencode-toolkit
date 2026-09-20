# Local dev/test sandbox for this repo: a real opencode install plus
# Node/npm/Python, so deploy/system-prompt.txt, deploy/opencode.json.example,
# and the plugins (plugins/system-prompt-tools/, plugins/hook-logger/,
# plugins/llm-review-gate/, each its own npm package published to the
# public npm registry) can be exercised against a real `opencode run`
# without touching the host machine's own opencode config or letting an
# all-permission agent loose on anything outside this container. Each
# plugin is referenced in the `plugin` config array by its bare package
# name - opencode installs it itself (a real `npm install` against
# whatever registry it's configured for) on first use and caches the
# result - see CLAUDE.md and docs/feature-points/02-system-prompt-tools-plugin.md.
# This build needs outbound network access to reach the registry.
#
# The project directory itself is NOT copied in here — see
# docker-compose.yml (this build's context is the repo root, one level
# up from this Dockerfile), which bind-mounts the repo at build/run time
# so host edits show up immediately without a rebuild. This image only
# provides the toolchain.
FROM node:22-bookworm

# git: opencode itself shells out to it (repo checks, the <env> block).
# python3: SETUP.md's JSON-validation step uses a `python -c` one-liner.
# build-essential: in case any future plugin dependency needs to build
#   a native addon.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      python3 \
      build-essential \
      ca-certificates \
      vim \
      less \
    && rm -rf /var/lib/apt/lists/*

# Pinned, not @latest, so a rebuild months from now reproduces the same
# environment instead of silently picking up a newer opencode. The
# actual version lives in one place: OPENCODE_VERSION in docker/.env
# (docker-compose.yml passes it through as this build arg) - bump it
# there, not here.
ARG OPENCODE_VERSION
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}"

# Non-root user: an all-permission agent's blast radius should stay
# inside this container's filesystem view, not run as root within it.
# node:22-bookworm already ships a "node" user/group at 1000:1000, which
# we don't use — drop it first so it doesn't collide with our default.
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

# Pre-warm the system-prompt-tools plugin's install into this image
# layer instead of paying for it on every fresh container (there's no
# opencode-config volume to persist it across runs - see
# docker-compose.yml). opencode resolves a `plugin` entry by installing
# it (a real `npm install`) into a dedicated directory under
# ~/.cache/opencode/packages/, keyed by the spec string used in config
# with an implicit "@latest" appended when no version is given (e.g.
# bare "@kealthas-dev/opencode-system-prompt-tools" caches under
# packages/@kealthas-dev/opencode-system-prompt-tools@latest/) - and skips that work
# entirely if the directory already exists (confirmed live: ~3.9s cold
# hitting the real npm registry vs. ~0.45s warm). Running `opencode
# debug config` once here, with this plugin listed, does the real
# install at image build time instead of on every container start.
# This is opencode 1.18.30's own undocumented cache-key behavior, not a
# documented contract - re-verify this still holds after bumping
# OPENCODE_VERSION. See docker-notes.md's "Plugin dependency
# pre-warming" section for the full verification writeup. Runs as
# ${USERNAME}, not root, so HOME resolves to /home/${USERNAME} and the
# cache lands where the entrypoint-generated config (see
# docker-entrypoint.sh) will actually look for it at runtime.
# hook-logger/llm-review-gate (steps 4/5's other, purely-opt-in
# plugins) are NOT pre-warmed here, same as before this reorg - they're
# not wired into this sandbox's default config below, only exercised
# directly by their own unit tests.
USER ${USERNAME}
RUN printf '{"$schema":"https://opencode.ai/config.json","plugin":["@kealthas-dev/opencode-system-prompt-tools"]}' > "/home/${USERNAME}/.config/opencode/opencode.jsonc" \
    && opencode debug config >/dev/null \
    && rm "/home/${USERNAME}/.config/opencode/opencode.jsonc"
USER root

# Stays root at container start so the entrypoint can load provider keys
# and (re)generate opencode.jsonc as the dev user before exec'ing the
# real command - see docker-entrypoint.sh.
COPY --chmod=755 docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bash"]
