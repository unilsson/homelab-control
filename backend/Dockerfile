FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# The upstream lanscan CLI is installed from a pinned Git commit, not from
# whichever code happens to be on GitHub's main branch at build time.
FROM node:22-bookworm-slim AS scanner
ARG LANSCAN_REF=2917173afe9ef7db62fb9d14b6a6e97a36e6bad2
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/lanscan \
    && /opt/lanscan/bin/pip install --no-cache-dir \
      "git+https://github.com/unilsson/lanscan.git@${LANSCAN_REF}"

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PATH="/opt/lanscan/bin:${PATH}"
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 arp-scan libcap2-bin ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && setcap cap_net_raw+ep /usr/bin/arp-scan \
    && mkdir -p /app/data /home/node/.config/lanscan \
    && ln -s /app/secrets/lanscan-config.toml /home/node/.config/lanscan/config.toml
COPY --from=scanner /opt/lanscan /opt/lanscan
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The upstream CLI invokes "sudo arp-scan"; this *unprivileged* wrapper
# executes only the fixed requested subnet with arp-scan's file capability.
COPY docker/sudo /usr/local/bin/sudo
RUN chmod 0755 /usr/local/bin/sudo \
    && chown -R node:node /app /home/node/.config
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
