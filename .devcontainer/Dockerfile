FROM node:20-bookworm

ARG TZ
ENV TZ="$TZ"

ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_CLI_VERSION=latest

# Install basic development tools, iptables/ipset, Electron runtime libraries,
# and native N-API build dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends \
  less \
  git \
  procps \
  sudo \
  fzf \
  zsh \
  man-db \
  unzip \
  gnupg2 \
  gh \
  iptables \
  ipset \
  iproute2 \
  dnsutils \
  aggregate \
  jq \
  nano \
  vim \
  # Native N-API build dependencies
  build-essential \
  curl \
  wget \
  file \
  patchelf \
  libssl-dev \
  libdbus-1-dev \
  libsecret-1-dev \
  # SQLite development headers (for rusqlite bundled build)
  pkg-config \
  # GUI runtime dependencies (for running the app in-container via WSLg)
  dbus-x11 \
  libdbus-1-3 \
  libgtk-3-0 \
  libnss3 \
  libxss1 \
  libxtst6 \
  libgbm1 \
  libnotify4 \
  libasound2 \
  libsecret-1-0 \
  at-spi2-core \
  xdg-utils \
  fonts-noto-cjk \
  # Locale support
  locales \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Generate locale
RUN sed -i '/ja_JP.UTF-8/s/^# //' /etc/locale.gen && \
  locale-gen
ENV LANG=ja_JP.UTF-8
ENV LC_ALL=ja_JP.UTF-8

# Ensure default node user has access to global package locations
RUN mkdir -p /usr/local/share/npm-global /usr/local/share/pnpm && \
  chown -R node:node /usr/local/share

ARG USERNAME=node

# Persist bash history.
RUN SNIPPET="export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  && mkdir /commandhistory \
  && touch /commandhistory/.bash_history \
  && chown -R $USERNAME /commandhistory

# Set `DEVCONTAINER` environment variable to help with orientation
ENV DEVCONTAINER=true

# Grant node user passwordless sudo
RUN echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node && \
  chmod 0440 /etc/sudoers.d/node

# Create workspace, config, and volume mount-point directories with correct ownership
# These dirs must exist before named volumes are mounted, otherwise Docker creates them as root
RUN mkdir -p /workspace /home/node/.claude /home/node/.codex \
  /home/node/.cargo/registry \
  /home/node/.cargo/git \
  && chown -R node:node /workspace /home/node/.claude /home/node/.codex /home/node/.cargo

WORKDIR /workspace

ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
  wget "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  sudo dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

# Set up non-root user
USER node

# Install Rust toolchain
ARG RUST_VERSION=stable
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain ${RUST_VERSION} \
  && echo 'source $HOME/.cargo/env' >> ~/.bashrc \
  && echo 'source $HOME/.cargo/env' >> ~/.zshrc
ENV PATH="/home/node/.cargo/bin:$PATH"

# Install global packages
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PATH:/usr/local/share/npm-global/bin:$PNPM_HOME

# Install pnpm, then project CLI tools globally through pnpm
RUN npm install -g pnpm@10.33.0 && \
  pnpm add -g @openai/codex@${CODEX_CLI_VERSION}

# Set the default shell to zsh rather than sh
ENV SHELL=/bin/zsh

# Set the default editor and visual
ENV EDITOR=nano
ENV VISUAL=nano

# Default powerline10k theme
ARG ZSH_IN_DOCKER_VERSION=1.2.0
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v${ZSH_IN_DOCKER_VERSION}/zsh-in-docker.sh)" -- \
  -p git \
  -p fzf \
  -a "source /usr/share/doc/fzf/examples/key-bindings.zsh" \
  -a "source /usr/share/doc/fzf/examples/completion.zsh" \
  -a "source $HOME/.cargo/env" \
  -a "export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  -x

# Install Claude. Keep package lifecycle scripts disabled, then run only Claude's
# known installer to fetch the platform-native binary.
RUN pnpm add -g --ignore-scripts @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && \
  node "$(pnpm root -g)/@anthropic-ai/claude-code/install.cjs" && \
  claude --version

# Copy and set up firewall script
COPY init-firewall.sh /usr/local/bin/
USER root
RUN chmod +x /usr/local/bin/init-firewall.sh && \
  echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-firewall && \
  chmod 0440 /etc/sudoers.d/node-firewall
USER node
