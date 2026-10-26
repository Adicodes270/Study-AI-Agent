FROM node:22-bookworm-slim

# Python + notebooklm-py (used by the NotebookLM generation code)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir notebooklm-py
ENV NOTEBOOKLM_PYTHON=/opt/venv/bin/python
ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

CMD ["npm", "start"]
